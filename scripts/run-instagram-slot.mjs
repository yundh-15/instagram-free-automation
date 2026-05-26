import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentSlot,
  inSlotObservationWindow,
  kstSlotToUtc,
  latestSafeRecoveryStartUtc,
  parseSlot,
  recoveryCompletionLeadMs,
  slotObservationEndUtc,
  slotPublishCutoffUtc,
} from './instagram-slot-window.mjs';
import {
  DEFAULT_DUPLICATE_TOPIC_WINDOW_MS,
  findNewlyObservedItems,
  findPriorTopicConflicts,
  publicConflict,
} from './instagram-publish-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const settleMinutes = Number(argv['settle-minutes'] || process.env.FALLBACK_SETTLE_MINUTES || 25);
const fallbackPublish = Boolean(argv['fallback-publish']);
const allowLatePublish = Boolean(argv['allow-late-publish']);
const formatGapMs = Number(argv['format-gap-ms'] || process.env.FALLBACK_FORMAT_GAP_MS || process.env.PUBLISH_FORMAT_GAP_MS || 300000);
const requiredStoryCount = Number(argv['required-story-count'] || process.env.REQUIRED_STORY_COUNT || 5);
const postCheckDelayMs = Number(argv['post-check-delay-ms'] || 15000);
const duplicateWindowMs = Number(process.env.INSTAGRAM_DUPLICATE_TOPIC_WINDOW_MS || DEFAULT_DUPLICATE_TOPIC_WINDOW_MS);
const recoveryCompletionReserveMs = Number(process.env.RECOVERY_COMPLETION_RESERVE_MS || 900000);
assertNonNegativeNumber(settleMinutes, 'settle minutes');
assertNonNegativeNumber(formatGapMs, 'format gap milliseconds');
assertNonNegativeNumber(postCheckDelayMs, 'post-check delay milliseconds');
assertNonNegativeNumber(duplicateWindowMs, 'duplicate topic window milliseconds');
assertNonNegativeNumber(recoveryCompletionReserveMs, 'recovery completion reserve milliseconds');
if (!Number.isInteger(requiredStoryCount) || requiredStoryCount < 1 || requiredStoryCount > 5) {
  throw new Error(`REQUIRED_STORY_COUNT must be an integer from 1 through 5; got ${requiredStoryCount}`);
}
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
const slot = parseSlot(argv.slot) || currentSlot(new Date());
const slotStartUtc = kstSlotToUtc(slot);
const publishCutoffUtc = slotPublishCutoffUtc(slot);
const observationEndUtc = slotObservationEndUtc(slot);
const settleAtUtc = new Date(slotStartUtc.getTime() + settleMinutes * 60 * 1000);
const now = new Date();

const initial = await inspectSlot();
const summary = {
  slotKst: slot.key,
  checkedAt: now.toISOString(),
  settleAt: settleAtUtc.toISOString(),
  publishCutoffAt: publishCutoffUtc.toISOString(),
  observationEndAt: observationEndUtc.toISOString(),
  recoveryCompletionReserveMs,
  status: initial.status,
  reels: initial.reels.map(publicItem),
  feeds: initial.feeds.map(publicItem),
  stories: initial.stories.map(publicItem),
  requiredStoryCount,
  action: 'none',
};

if (initial.status === 'ok') {
  summary.message = `Slot already has at least one Reel, one Feed post, and ${requiredStoryCount} Stories.`;
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (now < settleAtUtc) {
  summary.status = 'pending';
  summary.message = `Slot has not had ${settleMinutes} minutes to finish yet.`;
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(2);
}

if (!fallbackPublish) {
  summary.status = 'missing';
  summary.message = 'Slot is missing at least one required format. Re-run with --fallback-publish to publish locally.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

if (now >= observationEndUtc) {
  summary.status = 'missed';
  summary.message = 'A newer scheduled slot has started, so publishing this older slot was skipped.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

if (now > publishCutoffUtc && !allowLatePublish) {
  summary.status = 'missed';
  summary.message = 'The publishing cutoff has passed, so fallback publishing was skipped to avoid late off-slot posts.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

summary.requestedFormats = missingFormats(initial);
const completionLeadMs = recoveryCompletionLeadMs(initial, {
  formatGapMs,
  requiredStoryCount,
  postCheckDelayMs,
  recoveryCompletionReserveMs,
});
const latestSafeStartUtc = latestSafeRecoveryStartUtc(slot, completionLeadMs);
summary.completionLeadMs = completionLeadMs;
summary.latestSafeRecoveryStartAt = latestSafeStartUtc.toISOString();
if (now > publishCutoffUtc && allowLatePublish && now > latestSafeStartUtc) {
  summary.status = 'missed';
  summary.message = 'The delayed recovery cannot finish safely before the next scheduled slot, so publishing was skipped.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}
if (now > publishCutoffUtc) summary.latePublishOverride = true;

const recoveryTopic = preferredFallbackTopic(initial);
const avoidedTopics = recoveryTopic ? [] : await findRecentPublishedTopics();
summary.avoidedTopics = avoidedTopics;

const payloadPath = await buildPublishPayload(recoveryTopic, {
  includeReel: initial.reels.length === 0,
  avoidedTopics,
});
summary.payloadPath = relative(payloadPath);
const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
const topicConflicts = await findDuplicateTopicConflicts(payload.topic);
if (topicConflicts.length) {
  summary.status = 'blocked_duplicate_topic';
  summary.action = 'blocked duplicate topic';
  summary.message = `A prior post within the duplicate-topic window already uses topic "${payload.topic}".`;
  summary.conflicts = topicConflicts.slice(0, 5).map(publicConflict);
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const publishedFormats = [];
let beforePublish = await inspectSlot();
const concurrentItems = findNewlyObservedItems(initial, beforePublish);
if (concurrentItems.length) {
  summary.status = beforePublish.status === 'ok' ? 'ok' : 'blocked_concurrent_publish';
  summary.action = 'none';
  summary.reels = beforePublish.reels.map(publicItem);
  summary.feeds = beforePublish.feeds.map(publicItem);
  summary.stories = beforePublish.stories.map(publicItem);
  summary.concurrentItems = concurrentItems.map(publicItem);
  summary.message = beforePublish.status === 'ok'
    ? 'Another publisher completed this slot while fallback content was prepared; no publication was made.'
    : 'New media appeared in this slot while fallback content was prepared; publication was blocked for a later recovery check.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(beforePublish.status === 'ok' ? 0 : 1);
}

let publishedReel = false;
if (beforePublish.reels.length === 0) {
  runNodeScript('scripts/publish-instagram-reel.mjs', ['--payload', payloadPath]);
  publishedFormats.push('reel');
  publishedReel = true;
}

beforePublish = await inspectSlot();
if (publishedReel && beforePublish.feeds.length === 0 && formatGapMs > 0) {
  console.log(`Waiting ${formatGapMs}ms before feed publish.`);
  await sleep(formatGapMs);
}

beforePublish = await inspectSlot();
let publishedFeed = false;
if (beforePublish.feeds.length === 0) {
  runNodeScript('scripts/publish-instagram-carousel.mjs', ['--payload', payloadPath]);
  publishedFormats.push('feed');
  publishedFeed = true;
}

beforePublish = await inspectSlot();
if ((publishedReel || publishedFeed) && beforePublish.stories.length < requiredStoryCount && formatGapMs > 0) {
  console.log(`Waiting ${formatGapMs}ms before Story publish.`);
  await sleep(formatGapMs);
}

beforePublish = await inspectSlot();
const missingStoryCount = Math.max(0, requiredStoryCount - beforePublish.stories.length);
summary.missingStoryCount = missingStoryCount;
if (missingStoryCount > 0) {
  runNodeScript('scripts/publish-instagram-stories.mjs', [
    '--payload', payloadPath,
    '--slot', slot.key,
    '--skip', String(beforePublish.stories.length),
    '--count', String(missingStoryCount),
  ]);
  publishedFormats.push(`stories(${missingStoryCount})`);
}
summary.action = publishedFormats.length ? `published ${publishedFormats.join(' and ')}` : 'no publish needed after payload preparation';

await sleep(postCheckDelayMs);
const final = await inspectSlot();
summary.status = final.status;
summary.reels = final.reels.map(publicItem);
summary.feeds = final.feeds.map(publicItem);
summary.stories = final.stories.map(publicItem);
summary.completedAt = new Date().toISOString();
summary.message = final.status === 'ok'
  ? 'Fallback publish completed and slot verified.'
  : 'Fallback publish ran, but slot still did not verify.';

await writeRunSummary(summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(final.status === 'ok' ? 0 : 1);

async function buildPublishPayload(topic, { includeReel, avoidedTopics }) {
  const generateArgs = topic
    ? ['--topic', topic]
    : ['--content-key', slot.key, '--avoid-topics-json', JSON.stringify(avoidedTopics || [])];
  const generatedLine = runNodeScript('scripts/generate-carousel.mjs', generateArgs).stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('Generated carousel: '));
  if (!generatedLine) throw new Error('Could not find generated output directory in generate-carousel output.');

  const generatedDir = resolve(ROOT, generatedLine.replace('Generated carousel: ', '').trim());
  const postPath = join(generatedDir, 'post.json');
  if (!existsSync(postPath)) throw new Error(`Generated post.json was not found: ${postPath}`);

  runNodeScript('scripts/legal-review.mjs', ['--post', postPath]);
  const uploadArgs = ['--post', postPath];
  if (!includeReel) uploadArgs.push('--skip-reel');
  runNodeScript('scripts/upload-cloudinary.mjs', uploadArgs);

  const payloadPath = join(dirname(postPath), 'public-image-urls.json');
  if (!existsSync(payloadPath)) throw new Error(`Upload payload was not found: ${payloadPath}`);

  runNodeScript('scripts/legal-review.mjs', ['--payload', payloadPath]);
  return payloadPath;
}

function preferredFallbackTopic(slotInspection) {
  const existing = [...slotInspection.reels, ...slotInspection.feeds]
    .map((item) => {
      const lines = String(item.caption || '').split(/\r?\n/).map((line) => line.trim());
      const explicitTopic = lines.find((line) => line.startsWith('주제:'));
      return explicitTopic ? explicitTopic.replace(/^주제:\s*/, '').trim() : lines[0] || '';
    })
    .find(Boolean);
  return existing || '';
}

async function inspectSlot() {
  const fields = 'id,caption,media_product_type,media_type,timestamp,permalink';
  const [media, storiesResult] = await Promise.all([
    getGraph(`/${igUserId}/media`, { fields, limit: '50' }),
    getGraph(`/${igUserId}/stories`, { fields, limit: '50' }),
  ]);
  const slotItems = (media.data || []).filter((item) => {
    if (!item.timestamp) return false;
    return inSlotObservationWindow(item.timestamp, slot);
  });
  const slotStories = (storiesResult.data || []).filter((item) => {
    if (!item.timestamp) return false;
    return inSlotObservationWindow(item.timestamp, slot);
  });
  const reels = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'REELS');
  const feeds = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'FEED');
  const stories = slotStories.filter((item) => (item.media_product_type || item.media_type) === 'STORY');
  return {
    status: reels.length && feeds.length && stories.length >= requiredStoryCount ? 'ok' : 'missing',
    reels,
    feeds,
    stories,
  };
}

async function findDuplicateTopicConflicts(topic) {
  if (argv['skip-duplicate-guard'] || process.env.SKIP_INSTAGRAM_DUPLICATE_GUARD === 'true') return [];
  const fields = 'id,caption,media_product_type,media_type,timestamp,permalink';
  const media = await getGraph(`/${igUserId}/media`, { fields, limit: '50' });
  return findPriorTopicConflicts(media.data, {
    topic,
    slot,
    windowMs: duplicateWindowMs,
  });
}

async function findRecentPublishedTopics() {
  const fields = 'caption,timestamp';
  const media = await getGraph(`/${igUserId}/media`, { fields, limit: '50' });
  return [...new Set((media.data || [])
    .filter((item) => {
      const age = Date.now() - new Date(item.timestamp).getTime();
      return item.timestamp && age >= 0 && age <= duplicateWindowMs;
    })
    .map((item) => {
      const lines = String(item.caption || '').split(/\r?\n/).map((line) => line.trim());
      const explicitTopic = lines.find((line) => line.startsWith('주제:'));
      return explicitTopic ? explicitTopic.replace(/^주제:\s*/, '').trim() : lines[0] || '';
    })
    .filter(Boolean))];
}

async function getGraph(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Graph API GET ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

function runNodeScript(script, args = []) {
  console.log(`Running: node ${[script, ...args].map(shellToken).join(' ')}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): node ${[script, ...args].join(' ')}`);
  }
  return result;
}

async function writeRunSummary(value) {
  const dir = resolve(ROOT, 'output', 'scheduled-fallback');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${slot.key.replace(':', '-')}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function publicItem(item) {
  return {
    id: item.id,
    type: item.media_product_type || item.media_type || 'UNKNOWN',
    timestamp: item.timestamp,
    captionFirstLine: String(item.caption || '').split('\n')[0],
    permalink: item.permalink || null,
  };
}

function missingFormats(inspection) {
  return [
    inspection.stories.length < requiredStoryCount ? 'stories' : '',
    inspection.reels.length === 0 ? 'reel' : '',
    inspection.feeds.length === 0 ? 'feed' : '',
  ].filter(Boolean);
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(key) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  return process.env[key];
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function shellToken(value) {
  return String(value).includes(' ') ? JSON.stringify(value) : String(value);
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function assertNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number; got ${value}`);
  }
}
