import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const env = loadEnv(ENV_PATH);

const appId = requireValue(env, 'META_APP_ID');
const appSecret = requireValue(env, 'META_APP_SECRET');
const shortLivedToken = requireValue(env, 'META_ACCESS_TOKEN');
const graphVersion = env.META_GRAPH_VERSION || 'v25.0';

const url = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
url.searchParams.set('grant_type', 'fb_exchange_token');
url.searchParams.set('client_id', appId);
url.searchParams.set('client_secret', appSecret);
url.searchParams.set('fb_exchange_token', shortLivedToken);

const response = await fetch(url);
const payload = await response.json().catch(() => ({}));
if (!response.ok || !payload.access_token) {
  throw new Error(`Token exchange failed: ${JSON.stringify(payload)}`);
}

env.META_ACCESS_TOKEN = payload.access_token;
writeEnv(ENV_PATH, env);

console.log('META_ACCESS_TOKEN=exchanged');
console.log(`expires_in=${payload.expires_in || 'unknown'}`);

function loadEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

function writeEnv(file, values) {
  writeFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
}

function requireValue(values, key) {
  if (!values[key]) throw new Error(`Missing required .env value: ${key}`);
  return values[key];
}
