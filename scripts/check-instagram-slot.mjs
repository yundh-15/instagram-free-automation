import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentSlot,
  inSlotObservationWindow,
  kstSlotToUtc,
  parseSlot,
  slotObservationEndUtc,
} from './instagram-slot-window.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const igUserId = requireEnv('IG_USER_ID');
const accessToken = requireEnv('META_ACCESS_TOKEN');
const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const baseUrl = `https://graph.facebook.com/${graphVersion}`;
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
const observationEndUtc = slotObservationEndUtc(slot);
const settleAtUtc = new Date(slotStartUtc.getTime() + settleMinutes * 60 * 1000);
const now = new Date();

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
const summary = {
  slotKst: slot.key,
  checkedAt: now.toISOString(),
  settleAt: settleAtUtc.toISOString(),
  observationEndAt: observationEndUtc.toISOString(),
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
