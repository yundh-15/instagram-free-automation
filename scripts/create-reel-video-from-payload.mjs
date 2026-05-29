import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import {
  getConfiguredReelAudio,
  prepareReelAudioInput,
} from './reel-audio-presets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const payloadPath = resolve(argv.payload || '');
if (!payloadPath || !existsSync(payloadPath)) {
  throw new Error('Pass --payload output/.../public-image-urls.json');
}

const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
const sourceUrls = payload.storyImageUrls || payload.imageUrls || [];
if (sourceUrls.length < 2) {
  throw new Error(`Reel video requires at least 2 image URLs; got ${sourceUrls.length}`);
}

const workDir = resolve(argv.workDir || join(dirname(payloadPath), 'reel-video-work'));
const outputVideo = resolve(argv.video || join(workDir, 'reel.mp4'));
const outputPayload = resolve(argv.out || payloadPath);
const reelAudio = getConfiguredReelAudio(argv);
await mkdir(workDir, { recursive: true });

const imagePaths = [];
for (let index = 0; index < sourceUrls.length; index += 1) {
  const imagePath = join(workDir, `slide-${String(index + 1).padStart(2, '0')}.jpg`);
  const response = await fetch(sourceUrls[index]);
  if (!response.ok) {
    throw new Error(`Failed to download slide ${index + 1}: ${response.status}`);
  }
  await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
  imagePaths.push(imagePath);
}

const secondsPerSlide = Number(payload.secondsPerSlide || argv.secondsPerSlide || 4);
const concatPath = join(workDir, 'concat.txt');
const concatLines = [];
for (const imagePath of imagePaths) {
  concatLines.push(`file '${escapeConcatPath(imagePath)}'`);
  concatLines.push(`duration ${secondsPerSlide}`);
}
concatLines.push(`file '${escapeConcatPath(imagePaths.at(-1))}'`);
await writeFile(concatPath, `${concatLines.join('\n')}\n`, 'utf8');

if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary');
if (reelAudio) {
  const audioPath = await prepareReelAudioInput(reelAudio, {
    workDir,
    basename: 'reel-audio',
    root: ROOT,
    durationSec: Math.max(30, sourceUrls.length * secondsPerSlide + 5),
  });
  spawnFile(ffmpegPath, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath,
    '-stream_loop',
    '-1',
    '-i',
    audioPath,
    '-filter_complex',
    `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=F7F2EA,format=yuv420p[v];[1:a]volume=${reelAudio.volume}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    '-movflags',
    '+faststart',
    '-r',
    '30',
    outputVideo,
  ]);
} else {
  spawnFile(ffmpegPath, [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath,
    '-vf',
    'fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=F7F2EA,format=yuv420p',
    '-movflags',
    '+faststart',
    '-r',
    '30',
    outputVideo,
  ]);
}

const uploaded = await uploadVideo(outputVideo, payload);
const nextPayload = {
  ...payload,
  reelVideoUrl: uploaded.secure_url || uploaded.url,
  reelVideoPublicId: uploaded.public_id,
  reelAudioAttribution: reelAudio?.attribution || payload.reelAudioAttribution || null,
};

await writeFile(outputPayload, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');

console.log(`Created reel video: ${relative(outputVideo)}`);
console.log(`Updated payload: ${relative(outputPayload)}`);

async function uploadVideo(videoPath, currentPayload) {
  const cloudName = requireEnv('CLOUDINARY_CLOUD_NAME');
  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = argv.folder || 'instagram-reels';
  const publicId = argv.publicId || `n8n-${currentPayload.sourceExecutionId || Date.now()}-reel`;
  const tags = [currentPayload.reelTag, 'n8n-instagram-reel'].filter(Boolean).join(',');
  const signature = signCloudinaryParams({ folder, public_id: publicId, tags, timestamp }, apiSecret);

  const file = await readFile(videoPath);
  const form = new FormData();
  form.set('file', new Blob([file], { type: 'video/mp4' }), 'reel.mp4');
  form.set('folder', folder);
  form.set('public_id', publicId);
  form.set('tags', tags);
  form.set('api_key', apiKey);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, {
    method: 'POST',
    body: form,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Cloudinary video upload failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function signCloudinaryParams(params, apiSecret) {
  const payloadToSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(`${payloadToSign}${apiSecret}`).digest('hex');
}

function spawnFile(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function escapeConcatPath(value) {
  return String(value).replace(/'/g, "'\\''");
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
