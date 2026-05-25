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

const imageUrls = payload.imageUrls || [];
if (imageUrls.length < 2 || imageUrls.length > 10) {
  throw new Error(`Instagram carousel requires 2-10 image URLs; got ${imageUrls.length}`);
}

const caption = [payload.feedCaption || payload.caption, ...limitedHashtags(payload)].filter(Boolean).join('\n\n');
const childIds = [];

await guardAgainstDuplicateFeed();
for (let index = 0; index < imageUrls.length; index += 1) {
  const child = await postGraph(`/${igUserId}/media`, {
    image_url: imageUrls[index],
    is_carousel_item: 'true',
    alt_text: `${payload.topic || 'Instagram carousel'} - slide ${index + 1}`,
  });
  childIds.push(child.id);
  await waitForContainer(child.id);
}

const parent = await postGraph(`/${igUserId}/media`, {
  media_type: 'CAROUSEL',
  children: childIds.join(','),
  caption,
});
await waitForContainer(parent.id);

await guardAgainstDuplicateFeed();
const published = await postGraph(`/${igUserId}/media_publish`, {
  creation_id: parent.id,
});

const result = {
  topic: payload.topic,
  publishedAt: new Date().toISOString(),
  graphVersion,
  childContainerIds: childIds,
  carouselContainerId: parent.id,
  mediaId: published.id,
};

const outputPath = resolve(argv.out || join(dirname(payloadPath), 'instagram-publish-result.json'));
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`Published Instagram carousel: ${published.id}`);
console.log(`Result: ${relative(outputPath)}`);

async function guardAgainstDuplicateFeed() {
  if (argv['skip-duplicate-guard'] || process.env.SKIP_INSTAGRAM_DUPLICATE_GUARD === 'true') return;
  const media = await getGraph(`/${igUserId}/media`, {
    fields: 'id,caption,media_product_type,media_type,timestamp,permalink',
    limit: '50',
  });
  const conflicts = findFormatDuplicateConflicts(media.data, {
    topic: payload.topic,
    format: 'FEED',
    windowMs: duplicateWindowMs,
  });
  if (conflicts.length) {
    throw new Error(`Duplicate Instagram Feed post blocked for topic "${payload.topic || 'unknown'}": ${JSON.stringify(conflicts.slice(0, 5).map(publicConflict))}`);
  }
}

async function postGraph(path, params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') form.set(key, String(value));
  }
  form.set('access_token', accessToken);

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Graph API POST ${path} failed: ${JSON.stringify(data)}`);
  }
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
  if (!response.ok) {
    throw new Error(`Graph API GET ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForContainer(containerId) {
  const maxAttempts = Number(process.env.IG_CONTAINER_POLL_ATTEMPTS || 20);
  const delayMs = Number(process.env.IG_CONTAINER_POLL_DELAY_MS || 5000);

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
  return (currentPayload.hashtags || []).slice(0, 4);
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}

function assertNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number; got ${value}`);
  }
}
