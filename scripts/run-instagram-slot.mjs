import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const scheduledHours = [9, 13, 17];
const settleMinutes = Number(argv['settle-minutes'] || process.env.FALLBACK_SETTLE_MINUTES || 25);
const fallbackPublish = Boolean(argv['fallback-publish']);
const allowLatePublish = Boolean(argv['allow-late-publish']);
const formatGapMs = Number(argv['format-gap-ms'] || process.env.FALLBACK_FORMAT_GAP_MS || process.env.PUBLISH_FORMAT_GAP_MS || 300000);
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
const slot = parseSlot(argv.slot) || currentSlot(new Date());
const slotStartUtc = kstSlotToUtc(slot);
const slotEndUtc = new Date(slotStartUtc.getTime() + 2 * 60 * 60 * 1000);
const settleAtUtc = new Date(slotStartUtc.getTime() + settleMinutes * 60 * 1000);
const now = new Date();

const initial = await inspectSlot();
const summary = {
  slotKst: slot.key,
  checkedAt: now.toISOString(),
  settleAt: settleAtUtc.toISOString(),
  slotEndAt: slotEndUtc.toISOString(),
  status: initial.status,
  reels: initial.reels.map(publicItem),
  feeds: initial.feeds.map(publicItem),
  action: 'none',
};

if (initial.status === 'ok') {
  summary.message = 'Slot already has at least one Reel and one Feed post.';
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

if (now > slotEndUtc && !allowLatePublish) {
  summary.status = 'missed';
  summary.message = 'Slot window has already ended, so fallback publishing was skipped to avoid late off-slot posts.';
  await writeRunSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const missingReel = initial.reels.length === 0;
const missingFeed = initial.feeds.length === 0;
summary.action = `publishing ${[missingReel ? 'reel' : '', missingFeed ? 'feed' : ''].filter(Boolean).join(' and ')}`;

const payloadPath = await buildPublishPayload(preferredFallbackTopic(initial));
summary.payloadPath = relative(payloadPath);

if (missingReel) {
  runNodeScript('scripts/publish-instagram-reel.mjs', ['--payload', payloadPath]);
}

if (missingReel && missingFeed && formatGapMs > 0) {
  console.log(`Waiting ${formatGapMs}ms before feed publish.`);
  await sleep(formatGapMs);
}

if (missingFeed) {
  runNodeScript('scripts/publish-instagram-carousel.mjs', ['--payload', payloadPath]);
}

await sleep(Number(argv['post-check-delay-ms'] || 15000));
const final = await inspectSlot();
summary.status = final.status;
summary.reels = final.reels.map(publicItem);
summary.feeds = final.feeds.map(publicItem);
summary.completedAt = new Date().toISOString();
summary.message = final.status === 'ok'
  ? 'Fallback publish completed and slot verified.'
  : 'Fallback publish ran, but slot still did not verify.';

await writeRunSummary(summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(final.status === 'ok' ? 0 : 1);

async function buildPublishPayload(topic) {
  const generateArgs = topic ? ['--topic', topic] : [];
  const generatedLine = runNodeScript('scripts/generate-carousel.mjs', generateArgs).stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('Generated carousel: '));
  if (!generatedLine) throw new Error('Could not find generated output directory in generate-carousel output.');

  const generatedDir = resolve(ROOT, generatedLine.replace('Generated carousel: ', '').trim());
  const postPath = join(generatedDir, 'post.json');
  if (!existsSync(postPath)) throw new Error(`Generated post.json was not found: ${postPath}`);

  runNodeScript('scripts/legal-review.mjs', ['--post', postPath]);
  runNodeScript('scripts/upload-cloudinary.mjs', ['--post', postPath]);

  const payloadPath = join(dirname(postPath), 'public-image-urls.json');
  if (!existsSync(payloadPath)) throw new Error(`Upload payload was not found: ${payloadPath}`);

  runNodeScript('scripts/legal-review.mjs', ['--payload', payloadPath]);
  return payloadPath;
}

function preferredFallbackTopic(slotInspection) {
  const existing = [...slotInspection.reels, ...slotInspection.feeds]
    .map((item) => String(item.caption || '').split('\n')[0].trim())
    .find(Boolean);
  return existing || '';
}

async function inspectSlot() {
  const media = await getGraph(`/${igUserId}/media`, {
    fields: 'id,caption,media_product_type,media_type,timestamp,permalink',
    limit: '50',
  });
  const slotItems = (media.data || []).filter((item) => {
    if (!item.timestamp) return false;
    const t = new Date(item.timestamp);
    return t >= slotStartUtc && t <= slotEndUtc;
  });
  const reels = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'REELS');
  const feeds = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'FEED');
  return {
    status: reels.length && feeds.length ? 'ok' : 'missing',
    reels,
    feeds,
  };
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

function currentSlot(value) {
  const parts = kstParts(value);
  let slotHour = scheduledHours.findLast((candidate) => parts.hour >= candidate);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  if (!slotHour) {
    const previous = new Date(value.getTime() - 24 * 60 * 60 * 1000);
    const previousParts = kstParts(previous);
    year = previousParts.year;
    month = previousParts.month;
    day = previousParts.day;
    slotHour = 17;
  }
  return {
    year,
    month,
    day,
    hour: slotHour,
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(slotHour).padStart(2, '0')}`,
  };
}

function parseSlot(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  if (!match) throw new Error('Pass --slot as YYYY-MM-DDTHH in KST, for example 2026-05-24T17');
  const [, year, month, day, hour] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    key: `${year}-${month}-${day}T${hour}`,
  };
}

function kstSlotToUtc(slotValue) {
  return new Date(Date.UTC(slotValue.year, slotValue.month - 1, slotValue.day, slotValue.hour - 9, 0, 0));
}

function kstParts(value) {
  const kst = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
    hour: kst.getUTCHours(),
  };
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
