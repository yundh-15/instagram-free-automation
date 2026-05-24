import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const token = requireEnv('META_ACCESS_TOKEN');
const appToken = process.env.META_APP_ID && process.env.META_APP_SECRET
  ? `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
  : token;

const url = new URL('https://graph.facebook.com/debug_token');
url.searchParams.set('input_token', token);
url.searchParams.set('access_token', appToken);

const response = await fetch(url);
const payload = await response.json().catch(() => ({}));
const data = payload.data || {};

console.log(`status=${response.status}`);
console.log(`is_valid=${data.is_valid}`);
console.log(`type=${data.type || 'unknown'}`);
console.log(`app_id=${data.app_id || 'unknown'}`);
console.log(`application=${data.application || 'unknown'}`);
console.log(`expires_at=${formatTimestamp(data.expires_at)}`);
console.log(`data_access_expires_at=${formatTimestamp(data.data_access_expires_at)}`);
console.log(`scopes=${Array.isArray(data.scopes) ? data.scopes.join(',') : 'unknown'}`);
if (payload.error) console.log(`error=${payload.error.message}`);

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function requireEnv(key) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  return process.env[key];
}

function formatTimestamp(value) {
  return value ? new Date(value * 1000).toISOString() : 'none';
}
