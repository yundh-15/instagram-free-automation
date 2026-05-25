import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSlot as getCurrentSlot } from './instagram-slot-window.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const payloadPath = resolve(argv.payload || argv.urls || '');
if (!payloadPath || !existsSync(payloadPath)) {
  throw new Error('Pass --payload output/.../public-image-urls.json');
}

const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
const formatGapMs = Number(argv['format-gap-ms'] || process.env.PUBLISH_FORMAT_GAP_MS || 300000);
if (!Number.isFinite(formatGapMs) || formatGapMs < 0) {
  throw new Error(`format gap milliseconds must be a non-negative number; got ${formatGapMs}`);
}

const imageUrls = payload.imageUrls || [];
const storyImages = orderedStoryImages(payload);
if (imageUrls.length < 2 || imageUrls.length > 10) {
  throw new Error(`Instagram carousel requires 2-10 image URLs; got ${imageUrls.length}`);
}
if (storyImages.length !== imageUrls.length) {
  throw new Error(`Story image count must match carousel image count; got ${storyImages.length} vs ${imageUrls.length}`);
}
if (!payload.reelVideoUrl) {
  throw new Error('Payload does not contain reelVideoUrl. Re-run upload:cloudinary.');
}

await waitForPublicUrl(payload.reelVideoUrl);

const caption = buildCaption(payload);
const reelCaption = buildReelCaption(payload);

const reelContainer = await postGraph(`/${igUserId}/media`, {
  media_type: 'REELS',
  video_url: payload.reelVideoUrl,
  caption: reelCaption,
  share_to_feed: 'true',
});
await waitForContainer(reelContainer.id, 60, 10000);
await guardAgainstRecentDuplicate(payload);

const stories = [];
for (const image of storyImages) {
  const story = await postGraph(`/${igUserId}/media`, {
    media_type: 'STORIES',
    image_url: image.url,
  });
  await waitForContainer(story.id);
  const published = await postGraph(`/${igUserId}/media_publish`, {
    creation_id: story.id,
  });
  stories.push({
    slide: image.slide,
    sourceImage: image.local || null,
    storyContainerId: story.id,
    mediaId: published.id,
  });
}

await waitBetweenFormats('stories and reel');

const reelPublished = await postGraph(`/${igUserId}/media_publish`, {
  creation_id: reelContainer.id,
});

await waitBetweenFormats('reel and carousel');

const childIds = [];
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

const carouselPublished = await postGraph(`/${igUserId}/media_publish`, {
  creation_id: parent.id,
});

const result = {
  topic: payload.topic,
  publishedAt: new Date().toISOString(),
  graphVersion,
  order: {
    storySlides: stories.map((story) => story.slide),
    reelSourceImages: (payload.uploads || []).map((upload, index) => upload.slide || index + 1),
    carouselSlides: imageUrls.map((_, index) => index + 1),
  },
  stories,
  reel: {
    reelContainerId: reelContainer.id,
    mediaId: reelPublished.id,
    videoUrl: payload.reelVideoUrl,
  },
  carousel: {
    childContainerIds: childIds,
    carouselContainerId: parent.id,
    mediaId: carouselPublished.id,
  },
};

const outputPath = resolve(argv.out || join(dirname(payloadPath), 'instagram-bundle-result.json'));
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`Published Instagram bundle: carousel=${carouselPublished.id} reel=${reelPublished.id} stories=${stories.length}`);
console.log(`Result: ${relative(outputPath)}`);

function buildCaption(currentPayload) {
  return [
    currentPayload.feedCaption || currentPayload.caption,
    ...limitedHashtags(currentPayload),
  ].filter(Boolean).join('\n\n');
}

function buildReelCaption(currentPayload) {
  if (currentPayload.reelCaption) {
    return [
      currentPayload.reelCaption,
      ...limitedHashtags(currentPayload),
    ].filter(Boolean).join('\n\n');
  }
  return [
    currentPayload.caption,
    '천천히 넘겨보며 오늘 몸이 쉬어갈 시간을 떠올려보세요.',
    ...limitedHashtags(currentPayload),
  ].filter(Boolean).join('\n\n');
}

function limitedHashtags(currentPayload) {
  return (currentPayload.hashtags || []).slice(0, 4);
}

function orderedStoryImages(currentPayload) {
  if (Array.isArray(currentPayload.storyImages) && currentPayload.storyImages.length) {
    return currentPayload.storyImages
      .map((image, index) => ({
        slide: Number(image.slide || index + 1),
        url: image.url,
        local: image.local || null,
      }))
      .filter((image) => image.url)
      .sort((a, b) => a.slide - b.slide);
  }

  const urls = currentPayload.storyImageUrls || currentPayload.imageUrls || [];
  return urls.map((url, index) => ({
    slide: index + 1,
    url,
    local: currentPayload.uploads?.[index]?.local || null,
  }));
}

async function guardAgainstRecentDuplicate(currentPayload) {
  if (argv['skip-duplicate-guard'] || process.env.SKIP_INSTAGRAM_DUPLICATE_GUARD === 'true') return;

  const fields = 'id,caption,media_product_type,media_type,timestamp,permalink';
  const [media, storiesResult] = await Promise.all([
    getGraph(`/${igUserId}/media`, { fields, limit: '50' }),
    getGraph(`/${igUserId}/stories`, { fields: 'id,media_product_type,media_type,timestamp,permalink', limit: '50' })
      .catch(() => ({ data: [] })),
  ]);
  const topic = String(currentPayload.topic || '').trim();
  const currentSlotKey = getCurrentSlot(new Date()).key;
  const recentWindowMs = Number(process.env.INSTAGRAM_DUPLICATE_TOPIC_WINDOW_MS || 7 * 86400000);
  const now = Date.now();

  const conflicts = [];
  for (const item of [...(media.data || []), ...(storiesResult.data || [])]) {
    if (!item.timestamp) continue;
    const itemTime = new Date(item.timestamp);
    const caption = String(item.caption || '');
    const sameSlot = getCurrentSlot(itemTime).key === currentSlotKey;
    const sameTopic = topic && caption.includes(topic) && now - itemTime.getTime() <= recentWindowMs;
    if (sameSlot || sameTopic) {
      conflicts.push({
        id: item.id,
        type: item.media_product_type || item.media_type || 'UNKNOWN',
        timestamp: item.timestamp,
        reason: sameSlot ? 'same scheduled slot' : 'same topic in recent media',
        permalink: item.permalink || null,
      });
    }
  }

  if (conflicts.length) {
    throw new Error(`Duplicate Instagram publish blocked for topic "${topic || 'unknown'}": ${JSON.stringify(conflicts.slice(0, 5))}`);
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

async function waitBetweenFormats(label) {
  if (!formatGapMs || formatGapMs <= 0) return;
  console.log(`Waiting ${Math.round(formatGapMs / 1000)}s between ${label}...`);
  await sleep(formatGapMs);
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

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}
