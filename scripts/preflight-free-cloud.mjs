import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const missing = [];
requireAny('stock photo/video source', ['PEXELS_API_KEY']);
requireAny('Cloudinary upload auth', ['CLOUDINARY_UPLOAD_PRESET', ['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']]);
requireOne('CLOUDINARY_CLOUD_NAME');
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

function requireAny(label, options) {
  const ok = options.some((option) => {
    if (Array.isArray(option)) return option.every((key) => Boolean(process.env[key]));
    return Boolean(process.env[option]);
  });
  if (!ok) missing.push(label);
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
