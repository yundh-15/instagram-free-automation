import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
const scheduledHours = [9, 13, 17];
const settleMinutes = Number(argv['settle-minutes'] || 25);
const requiredStoryCount = Number(argv['required-story-count'] || process.env.REQUIRED_STORY_COUNT || 5);
if (!Number.isFinite(settleMinutes) || settleMinutes < 0) {
  throw new Error(`settle minutes must be a non-negative number; got ${settleMinutes}`);
}
if (!Number.isInteger(requiredStoryCount) || requiredStoryCount < 1 || requiredStoryCount > 5) {
  throw new Error(`REQUIRED_STORY_COUNT must be an integer from 1 through 5; got ${requiredStoryCount}`);
}
const slot = parseSlot(argv.slot) || currentSlot(new Date());
const slotStartUtc = kstSlotToUtc(slot);
const slotEndUtc = new Date(slotStartUtc.getTime() + 2 * 60 * 60 * 1000);
const settleAtUtc = new Date(slotStartUtc.getTime() + settleMinutes * 60 * 1000);
const now = new Date();

const fields = 'id,caption,media_product_type,media_type,timestamp,permalink';
const [media, storiesResult] = await Promise.all([
  getGraph(`/${igUserId}/media`, { fields, limit: '50' }),
  getGraph(`/${igUserId}/stories`, { fields, limit: '50' }),
]);

const slotItems = (media.data || []).filter((item) => {
  if (!item.timestamp) return false;
  const t = new Date(item.timestamp);
  return t >= slotStartUtc && t <= slotEndUtc;
});
const slotStories = (storiesResult.data || []).filter((item) => {
  if (!item.timestamp) return false;
  const t = new Date(item.timestamp);
  return t >= slotStartUtc && t <= slotEndUtc;
});

const reels = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'REELS');
const feeds = slotItems.filter((item) => (item.media_product_type || item.media_type) === 'FEED');
const stories = slotStories.filter((item) => (item.media_product_type || item.media_type) === 'STORY');
const summary = {
  slotKst: slot.key,
  checkedAt: now.toISOString(),
  settleAt: settleAtUtc.toISOString(),
  status: 'unknown',
  reels: reels.map(publicItem),
  feeds: feeds.map(publicItem),
  stories: stories.map(publicItem),
  requiredStoryCount,
};

if (reels.length && feeds.length && stories.length >= requiredStoryCount) {
  summary.status = 'ok';
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (now < settleAtUtc) {
  summary.status = 'pending';
  summary.message = `Slot has not had ${settleMinutes} minutes to finish yet.`;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(2);
}

summary.status = 'missing';
summary.message = `Expected at least one Reel, one Feed post, and ${requiredStoryCount} Stories for ${slot.key} KST.`;
console.log(JSON.stringify(summary, null, 2));
process.exit(1);

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
  if (!match) throw new Error('Pass --slot as YYYY-MM-DDTHH in KST, for example 2026-05-23T13');
  const [, year, month, day, hour] = match;
  const parts = [Number(year), Number(month), Number(day), Number(hour)];
  const normalized = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    normalized.getUTCFullYear() !== parts[0]
    || normalized.getUTCMonth() + 1 !== parts[1]
    || normalized.getUTCDate() !== parts[2]
    || !scheduledHours.includes(parts[3])
  ) {
    throw new Error('Slot must be a valid KST date at a scheduled hour: 09, 13, or 17');
  }
  return {
    year: parts[0],
    month: parts[1],
    day: parts[2],
    hour: parts[3],
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
