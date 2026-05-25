import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const allStoryImages = orderedStoryImages(payload);
if (!allStoryImages.length) throw new Error('No image URLs found in payload');

const skipCount = nonNegativeInteger(argv.skip || 0, '--skip');
const publishCount = argv.count === undefined
  ? allStoryImages.length - skipCount
  : positiveInteger(argv.count, '--count');
if (skipCount >= allStoryImages.length) {
  throw new Error(`--skip must leave at least one Story image to publish; got ${skipCount} for ${allStoryImages.length} images`);
}
if (skipCount + publishCount > allStoryImages.length) {
  throw new Error(`Selected Story range exceeds available images; skip=${skipCount}, count=${publishCount}, images=${allStoryImages.length}`);
}
const storyImages = allStoryImages.slice(skipCount, skipCount + publishCount);
if (!storyImages.length) throw new Error('No remaining Story images selected for publishing');

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

const result = {
  topic: payload.topic,
  publishedAt: new Date().toISOString(),
  graphVersion,
  skippedExistingStoryCount: skipCount,
  stories,
};

const outputPath = resolve(argv.out || join(dirname(payloadPath), 'instagram-stories-result.json'));
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`Published Instagram stories: ${stories.length}`);
console.log(`Result: ${relative(outputPath)}`);

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

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}

function nonNegativeInteger(value, optionName) {
  if (typeof value === 'boolean') {
    throw new Error(`${optionName} requires an integer value`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer; got ${value}`);
  }
  return parsed;
}

function positiveInteger(value, optionName) {
  if (typeof value === 'boolean') {
    throw new Error(`${optionName} requires an integer value`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer; got ${value}`);
  }
  return parsed;
}
