import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const input = argv.audio || argv.file || argv.url || process.env.REEL_AUDIO_PATH || process.env.REEL_AUDIO_URL || '';
if (!input) {
  throw new Error('Pass --audio/--file/--url, or set REEL_AUDIO_PATH/REEL_AUDIO_URL.');
}

const license = argv.license || argv['reel-audio-license'] || process.env.REEL_AUDIO_LICENSE || '';
if (!license) {
  throw new Error('REEL_AUDIO_LICENSE or --license is required before uploading Reel music.');
}

const title = argv.title || argv['reel-audio-title'] || process.env.REEL_AUDIO_TITLE || '';
const creator = argv.creator || argv['reel-audio-creator'] || process.env.REEL_AUDIO_CREATOR || '';
const sourceUrl = argv.sourceUrl || argv['source-url'] || process.env.REEL_AUDIO_SOURCE_URL || (/^https?:\/\//i.test(input) ? input : '');
if (!title && !sourceUrl) {
  throw new Error('REEL_AUDIO_TITLE/--title or REEL_AUDIO_SOURCE_URL/--source-url is required for traceability.');
}

const cloudName = requireEnv('CLOUDINARY_CLOUD_NAME');
const apiKey = requireEnv('CLOUDINARY_API_KEY');
const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
const folder = argv.folder || 'instagram-reel-audio';
const publicId = argv.publicId || argv['public-id'] || safePublicId(title || basenameWithoutExt(input));
const tags = ['instagram-reel', 'background-music', 'licensed-audio']
  .concat((argv.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean))
  .join(',');
const timestamp = Math.floor(Date.now() / 1000);
const signature = signCloudinaryParams({ folder, public_id: publicId, tags, timestamp }, apiSecret);

const form = new FormData();
form.set('folder', folder);
form.set('public_id', publicId);
form.set('tags', tags);
form.set('api_key', apiKey);
form.set('timestamp', String(timestamp));
form.set('signature', signature);

if (/^https?:\/\//i.test(input)) {
  form.set('file', input);
} else {
  const filePath = resolve(ROOT, input);
  if (!existsSync(filePath)) throw new Error(`Reel audio file does not exist: ${filePath}`);
  const data = await readFile(filePath);
  form.set('file', new Blob([data], { type: contentTypeFor(filePath) }), basename(filePath));
}

const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, {
  method: 'POST',
  body: form,
});
const result = await response.json();
if (!response.ok) {
  throw new Error(`Cloudinary audio upload failed: ${JSON.stringify(result)}`);
}

const output = {
  publicId: result.public_id,
  secureUrl: result.secure_url,
  resourceType: result.resource_type,
  uploadedAt: new Date().toISOString(),
  attribution: {
    source: 'user_provided_audio',
    title: title || null,
    creator: creator || null,
    sourceUrl: sourceUrl || null,
    license,
    creditLine: argv.credit || process.env.REEL_AUDIO_CREDIT || buildAudioCreditLine({ title, creator }),
  },
};

const outputPath = resolve(argv.out || join(ROOT, 'output', 'reel-audio-upload-result.json'));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(`Uploaded Reel audio: ${result.public_id}`);
console.log(`Set n8n variable REEL_AUDIO_CLOUDINARY_PUBLIC_ID=${result.public_id}`);
console.log(`Result: ${relative(outputPath)}`);

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

function requireEnv(key) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
  return process.env[key];
}

function signCloudinaryParams(params, secret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(`${payload}${secret}`).digest('hex');
}

function safePublicId(value) {
  return String(value || `reel-audio-${Date.now()}`)
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase() || `reel-audio-${Date.now()}`;
}

function basenameWithoutExt(value) {
  const name = basename(String(value || '').split('?')[0]);
  return extname(name) ? name.slice(0, -extname(name).length) : name;
}

function buildAudioCreditLine({ title, creator }) {
  if (!title && !creator) return null;
  return `음악: ${[title, creator].filter(Boolean).join(' - ')}`;
}

function contentTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}
