import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const missing = [];
const reelSource = process.env.REEL_SOURCE || 'pexels';
if (!['pexels', 'pexels-required', 'slideshow'].includes(reelSource)) {
  missing.push('REEL_SOURCE must be pexels, pexels-required, or slideshow');
}
if (reelSource === 'pexels-required' && !process.env.PEXELS_API_KEY) {
  missing.push('PEXELS_API_KEY (required by REEL_SOURCE=pexels-required)');
}
checkStoryCount();
checkGapMilliseconds('PUBLISH_FORMAT_GAP_MS');
checkGapMilliseconds('FALLBACK_FORMAT_GAP_MS');
checkGapMilliseconds('INSTAGRAM_DUPLICATE_TOPIC_WINDOW_MS');
checkGapMilliseconds('RECOVERY_COMPLETION_RESERVE_MS');
requireOne('CLOUDINARY_CLOUD_NAME');
requireOne('CLOUDINARY_API_KEY');
requireOne('CLOUDINARY_API_SECRET');
requireOne('IG_USER_ID');
requireOne('META_ACCESS_TOKEN');

if (missing.length) {
  throw new Error(`Free cloud preflight failed. Missing: ${missing.join(', ')}`);
}

const graphVersion = process.env.META_GRAPH_VERSION || 'v25.0';
const debug = await debugToken();
if (debug && debug.is_valid === false) {
  throw new Error('Free cloud preflight failed. META_ACCESS_TOKEN is not valid.');
}

console.log('Free cloud preflight passed');
console.log(`graphVersion=${graphVersion}`);
if (debug) {
  console.log(`tokenType=${debug.type || 'unknown'}`);
  console.log(`dataAccessExpiresAt=${debug.data_access_expires_at ? new Date(debug.data_access_expires_at * 1000).toISOString() : 'unknown'}`);
}
if (!process.env.PEXELS_API_KEY && reelSource !== 'slideshow') {
  console.log('stockVideoWarning=PEXELS_API_KEY is not set; Reel generation will use the slideshow fallback.');
}

async function debugToken() {
  const appToken = process.env.META_APP_ID && process.env.META_APP_SECRET
    ? `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
    : process.env.META_ACCESS_TOKEN;
  const url = new URL('https://graph.facebook.com/debug_token');
  url.searchParams.set('input_token', process.env.META_ACCESS_TOKEN);
  url.searchParams.set('access_token', appToken);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(`tokenDebugWarning=${payload.error?.message || response.status}`);
    return null;
  }
  return payload.data || null;
}

function requireOne(key) {
  if (!process.env[key]) missing.push(key);
}

function checkStoryCount() {
  if (!process.env.REQUIRED_STORY_COUNT) return;
  const value = Number(process.env.REQUIRED_STORY_COUNT);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    missing.push('REQUIRED_STORY_COUNT must be an integer from 1 through 5');
  }
}

function checkGapMilliseconds(key) {
  if (!process.env[key]) return;
  const value = Number(process.env[key]);
  if (!Number.isFinite(value) || value < 0) {
    missing.push(`${key} must be a non-negative number`);
  }
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
