import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DUPLICATE_TOPIC_WINDOW_MS,
  findFormatDuplicateConflicts,
  publicConflict,
} from './instagram-publish-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const payloadPath = resolve(argv.payload || argv.urls || '');
if (!payloadPath || !existsSync(payloadPath)) {
  throw new Error('Pass --payload output/.../public-image-urls.json');
}

const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
if (!String(payload.topic || '').trim()) throw new Error('Payload must include a topic before Instagram publishing.');
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
const duplicateWindowMs = Number(process.env.INSTAGRAM_DUPLICATE_TOPIC_WINDOW_MS || DEFAULT_DUPLICATE_TOPIC_WINDOW_MS);
assertNonNegativeNumber(duplicateWindowMs, 'duplicate topic window milliseconds');

const videoUrl = payload.reelVideoUrl;
if (!videoUrl) throw new Error('Payload does not contain reelVideoUrl. Re-run upload:cloudinary.');

await waitForPublicUrl(videoUrl);

const caption = [
  payload.reelCaption || payload.caption || payload.topic,
  ...(payload.reelCaption ? [] : ['천천히 넘겨보며 오늘 몸이 쉬어갈 시간을 떠올려보세요.']),
  hashtagLine(payload),
].filter(Boolean).join('\n\n');

await guardAgainstDuplicateReel();
const container = await postGraph(`/${igUserId}/media`, {
  media_type: 'REELS',
  video_url: videoUrl,
  caption,
  share_to_feed: 'true',
});
await waitForContainer(container.id, 60, 10000);

await guardAgainstDuplicateReel();
const published = await postGraph(`/${igUserId}/media_publish`, {
  creation_id: container.id,
});

const result = {
  topic: payload.topic,
  publishedAt: new Date().toISOString(),
  graphVersion,
  reelContainerId: container.id,
  mediaId: published.id,
  videoUrl,
};

const outputPath = resolve(argv.out || join(dirname(payloadPath), 'instagram-reel-result.json'));
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`Published Instagram reel: ${published.id}`);
console.log(`Result: ${relative(outputPath)}`);

async function guardAgainstDuplicateReel() {
  if (argv['skip-duplicate-guard'] || process.env.SKIP_INSTAGRAM_DUPLICATE_GUARD === 'true') return;
  const media = await getGraph(`/${igUserId}/media`, {
    fields: 'id,caption,media_product_type,media_type,timestamp,permalink',
    limit: '50',
  });
  const conflicts = findFormatDuplicateConflicts(media.data, {
    topic: payload.topic,
    format: 'REELS',
    windowMs: duplicateWindowMs,
  });
  if (conflicts.length) {
    throw new Error(`Duplicate Instagram Reel blocked for topic "${payload.topic || 'unknown'}": ${JSON.stringify(conflicts.slice(0, 5).map(publicConflict))}`);
  }
}

async function waitForPublicUrl(url) {
  const attempts = Number(process.env.REEL_VIDEO_URL_POLL_ATTEMPTS || 24);
  const delayMs = Number(process.env.REEL_VIDEO_URL_POLL_DELAY_MS || 5000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (response?.ok) return;
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for Reel video URL: ${url}`);
}

async function postGraph(path, params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') form.set(key, String(value));
  }
  form.set('access_token', accessToken);

  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
  const data = await response.json();
  if (!response.ok) throw new Error(`Graph API POST ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function getGraph(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(`Graph API GET ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function waitForContainer(containerId, maxAttempts = 20, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await getGraph(`/${containerId}`, { fields: 'status_code' });
    if (!status.status_code || status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Container ${containerId} status: ${status.status_code}`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for container ${containerId}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function loadEnv(file) {
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
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

function limitedHashtags(currentPayload) {
  return (currentPayload.hashtags || []).slice(0, 5);
}

function hashtagLine(currentPayload) {
  return limitedHashtags(currentPayload).join(' ');
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}

function assertNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number; got ${value}`);
  }
}
