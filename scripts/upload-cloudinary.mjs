import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const postPath = resolve(argv.post || newestPostJson());
const post = JSON.parse(await readFile(postPath, 'utf8'));
const postDir = dirname(postPath);
const VIDEO_REGISTRY_PATH = resolve(argv.videoRegistry || join(ROOT, 'data', 'used-videos.json'));

const cloudName = requireEnv('CLOUDINARY_CLOUD_NAME');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const folder = argv.folder || `instagram-carousel/${runStamp}-${safeFolderName(post.topic || 'post')}`;
const reelTag = argv.tag || `ig-carousel-${Date.now()}`;
const secondsPerSlide = Number(argv.secondsPerSlide || 4);
const reelSource = argv['reel-source'] || process.env.REEL_SOURCE || 'pexels';
const skipReel = Boolean(argv['skip-reel']);
const reelAudio = skipReel ? null : getReelAudioConfig();

if (!skipReel && !['pexels', 'pexels-required', 'slideshow'].includes(reelSource)) {
  throw new Error(`Unsupported REEL_SOURCE: ${reelSource}. Use pexels, pexels-required, or slideshow.`);
}
if (!skipReel && reelSource === 'pexels-required' && !process.env.PEXELS_API_KEY) {
  throw new Error('REEL_SOURCE=pexels-required requires PEXELS_API_KEY.');
}

const uploads = [];
const images = post.images || [];
if (!Array.isArray(images) || images.length < 2 || images.length > 10) {
  throw new Error(`Instagram publishing requires 2-10 generated images; got ${Array.isArray(images) ? images.length : 0}`);
}
for (let index = 0; index < images.length; index += 1) {
  const image = images[index];
  const imagePath = resolve(ROOT, image);
  const data = await readFile(imagePath);
  const publicId = `slide-${String(index + 1).padStart(2, '0')}`;
  const form = new FormData();
  form.set('folder', folder);
  form.set('public_id', publicId);
  form.set('tags', reelTag);
  form.set('file', `data:image/png;base64,${data.toString('base64')}`);
  addCloudinaryAuth(form, { folder, public_id: publicId, tags: reelTag });

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Cloudinary upload failed for ${image}: ${JSON.stringify(result)}`);
  }
  uploads.push({
    slide: index + 1,
    local: image,
    url: result.secure_url,
    publicId: result.public_id,
  });
}

const { reelVideo, reelVideoMeta } = skipReel
  ? {
    reelVideo: null,
    reelVideoMeta: {
      source: null,
      deliveryUrl: null,
      attribution: null,
      audioAttribution: null,
    },
  }
  : await createReelVideo({
    cloudName,
    folder,
    reelTag,
    secondsPerSlide,
    post,
  });
const orderedUploads = [...uploads].sort((a, b) => a.slide - b.slide);
const feedImages = orderedUploads.map((upload) => ({
  slide: upload.slide,
  local: upload.local,
  url: cloudinaryTransform(upload.url, 'f_jpg,q_auto,w_1080,h_1350,c_fill'),
  sourceUrl: upload.url,
  publicId: upload.publicId,
}));
const storyImages = orderedUploads.map((upload) => ({
  slide: upload.slide,
  local: upload.local,
  url: cloudinaryTransform(upload.url, `f_jpg,q_auto,w_1080,h_1920,c_pad,b_rgb:${post.reel?.background || 'F7F2EA'}`),
  sourceUrl: upload.url,
  publicId: upload.publicId,
}));

const output = {
  topic: post.topic,
  category: post.category || null,
  images: post.images || [],
  cards: post.cards || [],
  photos: post.photos || [],
  caption: withMediaCredit(post.feedCaption || post.caption, post, reelVideoMeta),
  feedCaption: withMediaCredit(post.feedCaption || post.caption, post, reelVideoMeta),
  reelCaption: withMediaCredit(post.reelCaption || buildDefaultReelCaption(post), post, reelVideoMeta),
  hashtags: (post.hashtags || []).slice(0, 5),
  imageUrls: feedImages.map((image) => image.url),
  storyImageUrls: storyImages.map((image) => image.url),
  feedImages,
  storyImages,
  storyOrder: storyImages.map((image) => image.slide),
  reelTag,
  secondsPerSlide,
  reelStyle: post.reel || null,
  aiVideoPrompt: post.reel?.aiVideoPrompt || null,
  reelVideoSource: reelVideoMeta.source || null,
  reelVideoUrl: reelVideoMeta.deliveryUrl || reelVideo?.secure_url || reelVideo?.url || null,
  reelVideoPublicId: reelVideo?.public_id || null,
  reelVideoAttribution: reelVideoMeta.attribution,
  reelAudioAttribution: reelVideoMeta.audioAttribution || null,
  uploads,
};

const outputPath = resolve(argv.out || join(postDir, 'public-image-urls.json'));
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(`Uploaded ${uploads.length} images`);
console.log(`Public URL payload: ${relative(outputPath)}`);

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

async function createReelVideo({ cloudName: currentCloudName, folder: currentFolder, reelTag: currentReelTag, secondsPerSlide: currentSecondsPerSlide, post: currentPost }) {
  if (reelSource !== 'slideshow' && process.env.PEXELS_API_KEY) {
    try {
      const stockVideo = await findPexelsReelVideo(currentPost);
      const uploaded = reelAudio
        ? await uploadPexelsVideoWithAudio({
          cloudName: currentCloudName,
          folder: currentFolder,
          tag: currentReelTag,
          video: stockVideo,
          publicId: `reel-${stockVideo.id}-music`,
        })
        : await uploadRemoteVideoToCloudinary({
          cloudName: currentCloudName,
          folder: currentFolder,
          tag: currentReelTag,
          video: stockVideo,
          publicId: `reel-${stockVideo.id}`,
        });
      await recordUsedVideo(toVideoRegistryEntry(stockVideo, currentPost));
      return {
        reelVideo: uploaded,
        reelVideoMeta: {
          source: 'pexels_video',
          deliveryUrl: cloudinaryVideoTransform(uploaded.secure_url || uploaded.url, 'f_mp4,q_auto,w_1080,h_1920,c_fill'),
          attribution: stockVideo.attribution,
          audioAttribution: reelAudio?.attribution || null,
        },
      };
    } catch (error) {
      if (argv['require-stock-video'] || reelSource === 'pexels-required') throw error;
      console.warn(`Pexels Reel video unavailable, falling back to slideshow: ${error.message}`);
    }
  }

  const slideshow = await createCloudinaryMultiVideo({
    cloudName: currentCloudName,
    tag: currentReelTag,
    secondsPerSlide: currentSecondsPerSlide,
    background: currentPost.reel?.background || 'F7F2EA',
  });
  return {
    reelVideo: slideshow,
    reelVideoMeta: {
      source: 'cloudinary_slideshow',
      deliveryUrl: slideshow.secure_url || slideshow.url,
      attribution: null,
    },
  };
}

function addCloudinaryAuth(form, signableParams) {
  if (process.env.CLOUDINARY_UPLOAD_PRESET) {
    form.set('upload_preset', process.env.CLOUDINARY_UPLOAD_PRESET);
    return;
  }

  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { ...signableParams, timestamp };
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signature = createHash('sha1').update(`${payload}${apiSecret}`).digest('hex');

  form.set('api_key', apiKey);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);
}

async function createCloudinaryMultiVideo({ cloudName, tag, secondsPerSlide, background }) {
  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
  const timestamp = Math.floor(Date.now() / 1000);
  const format = 'mp4';
  const transformation = `w_1080,h_1920,c_pad,b_rgb:${background},dl_${secondsPerSlide * 1000}`;
  const signature = signCloudinaryParams({ format, tag, timestamp, transformation }, apiSecret);

  const form = new FormData();
  form.set('tag', tag);
  form.set('format', format);
  form.set('transformation', transformation);
  form.set('api_key', apiKey);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/multi`, {
    method: 'POST',
    body: form,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Cloudinary multi video failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function findPexelsReelVideo(currentPost) {
  const baseQuery = argv.videoQuery || currentPost.reel?.stockVideoQuery || 'spa massage relaxing wellness portrait';
  const queries = preferredVideoQueries(baseQuery);
  const perPage = String(Number(argv.videoPerPage || 40));
  const usedKeys = await readUsedVideoKeys();
  const pages = queries.map((query, index) => ({
    query,
    page: ((Math.floor(Date.now() / 86400000) + index) % 5) + 1,
    boost: (queries.length - index) * 2,
  }));
  const results = await Promise.allSettled(pages.map(async ({ query, page, boost }) => {
    const url = new URL('https://api.pexels.com/v1/videos/search');
    url.searchParams.set('query', query);
    url.searchParams.set('orientation', 'portrait');
    url.searchParams.set('size', 'medium');
    url.searchParams.set('per_page', perPage);
    url.searchParams.set('locale', 'en-US');
    url.searchParams.set('page', String(page));

    const response = await fetch(url, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Pexels video search failed: ${JSON.stringify(data)}`);
    }
    return (data.videos || []).map((video) => normalizePexelsVideo(video, query, boost));
  }));

  const candidates = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .filter((video) => video.file?.link && !usedKeys.has(videoKey(video.source, video.id)))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    throw new Error(`No unused Pexels portrait videos found for query: ${baseQuery}`);
  }
  return candidates[0];
}

function preferredVideoQueries(query) {
  const base = String(query || '').trim();
  return [
    `Korean East Asian person ${base}`,
    `Asian wellness spa person ${base}`,
    base,
  ].map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function normalizePexelsVideo(video, query, boost = 0) {
  const file = selectPexelsVideoFile(video.video_files || []);
  return {
    source: 'Pexels',
    id: String(video.id),
    query,
    width: video.width,
    height: video.height,
    duration: video.duration,
    url: video.url,
    file,
    user: video.user?.name || null,
    userUrl: video.user?.url || null,
    attribution: {
      source: 'Pexels',
      id: String(video.id),
      videoUrl: video.url,
      creator: video.user?.name || null,
      creatorUrl: video.user?.url || null,
      license: 'Pexels License: free personal and commercial use; attribution not required. Do not imply model, brand, or creator endorsement.',
      query,
    },
    score: scorePexelsVideo(video, file) + boost,
  };
}

function selectPexelsVideoFile(files) {
  return files
    .filter((file) => file.link && String(file.file_type || '').includes('mp4'))
    .map((file) => ({
      id: file.id,
      quality: file.quality,
      fileType: file.file_type,
      width: file.width,
      height: file.height,
      fps: file.fps,
      link: file.link,
    }))
    .sort((a, b) => scorePexelsVideoFile(b) - scorePexelsVideoFile(a))[0];
}

function scorePexelsVideo(video, file) {
  let score = scorePexelsVideoFile(file);
  if ((video.height || 0) > (video.width || 0)) score += 5;
  if ((video.duration || 0) >= 6 && (video.duration || 0) <= 24) score += 4;
  if ((video.duration || 0) > 40) score -= 3;
  return score;
}

function scorePexelsVideoFile(file = {}) {
  let score = 0;
  const ratio = file.height && file.width ? file.height / file.width : 0;
  if (ratio >= 1.4) score += 8;
  if (ratio >= 1.65 && ratio <= 1.95) score += 6;
  if ((file.height || 0) >= 1280) score += 4;
  if ((file.width || 0) >= 720) score += 2;
  if ((file.height || 0) > 2200) score -= 2;
  if (file.quality === 'hd') score += 1;
  return score;
}

async function uploadRemoteVideoToCloudinary({ cloudName, folder: currentFolder, tag, video, publicId }) {
  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
  const timestamp = Math.floor(Date.now() / 1000);
  const tags = [tag, 'pexels-video', 'instagram-reel'].filter(Boolean).join(',');
  const params = { folder: currentFolder, public_id: publicId, tags, timestamp };
  const signature = signCloudinaryParams(params, apiSecret);

  const form = new FormData();
  form.set('file', video.file.link);
  form.set('folder', currentFolder);
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
    throw new Error(`Cloudinary remote video upload failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function uploadPexelsVideoWithAudio({ cloudName, folder: currentFolder, tag, video, publicId }) {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary');
  const workDir = resolve(argv.workDir || join(postDir, 'reel-audio-work'));
  await mkdir(workDir, { recursive: true });

  const videoPath = join(workDir, `pexels-${video.id}.mp4`);
  const audioPath = await prepareMediaInput(reelAudio.input, workDir, 'reel-audio');
  const outputPath = join(workDir, `${publicId}.mp4`);
  await downloadToFile(video.file.link, videoPath);
  muxVideoWithAudio({ videoPath, audioPath, outputPath, volume: reelAudio.volume });

  return uploadLocalVideoToCloudinary({
    cloudName,
    folder: currentFolder,
    tag,
    filePath: outputPath,
    publicId,
    extraTags: ['background-music'],
  });
}

async function uploadLocalVideoToCloudinary({ cloudName, folder: currentFolder, tag, filePath, publicId, extraTags = [] }) {
  const apiKey = requireEnv('CLOUDINARY_API_KEY');
  const apiSecret = requireEnv('CLOUDINARY_API_SECRET');
  const timestamp = Math.floor(Date.now() / 1000);
  const tags = [tag, 'pexels-video', 'instagram-reel', ...extraTags].filter(Boolean).join(',');
  const params = { folder: currentFolder, public_id: publicId, tags, timestamp };
  const signature = signCloudinaryParams(params, apiSecret);

  const file = await readFile(filePath);
  const form = new FormData();
  form.set('file', new Blob([file], { type: 'video/mp4' }), 'reel.mp4');
  form.set('folder', currentFolder);
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
    throw new Error(`Cloudinary local video upload failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function prepareMediaInput(source, workDir, basename) {
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const extension = mediaExtension(url.pathname) || 'mp3';
    const outputPath = join(workDir, `${basename}.${extension}`);
    await downloadToFile(source, outputPath);
    return outputPath;
  }

  const localPath = resolve(ROOT, source);
  if (!existsSync(localPath)) throw new Error(`Reel audio file does not exist: ${localPath}`);
  return localPath;
}

async function downloadToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download media ${url}: ${response.status}`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

function muxVideoWithAudio({ videoPath, audioPath, outputPath, volume }) {
  spawnFile(ffmpegPath, [
    '-y',
    '-i',
    videoPath,
    '-stream_loop',
    '-1',
    '-i',
    audioPath,
    '-filter_complex',
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v];[1:a]volume=${volume}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    '-movflags',
    '+faststart',
    outputPath,
  ]);
}

function cloudinaryTransform(url, transformation) {
  return url.replace('/upload/', `/upload/${transformation}/`);
}

function cloudinaryVideoTransform(url, transformation) {
  return url.replace('/upload/', `/upload/${transformation}/`);
}

function signCloudinaryParams(params, apiSecret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(`${payload}${apiSecret}`).digest('hex');
}

function newestPostJson() {
  throw new Error('Pass --post output/.../post.json');
}

function withMediaCredit(caption, currentPost, videoMeta) {
  const mediaSources = new Set((currentPost.photos || [])
    .map((photo) => photo?.source)
    .filter((source) => source && source !== 'generated_css_background'));
  if (videoMeta?.source === 'pexels_video') mediaSources.add('Pexels');
  const creditLines = [];
  if (mediaSources.size) {
    const line = `사진/영상: ${[...mediaSources].sort().join(', ')}`;
    if (!String(caption || '').includes(line)) creditLines.push(line);
  }
  if (videoMeta.audioAttribution?.creditLine && !String(caption || '').includes(videoMeta.audioAttribution.creditLine)) {
    creditLines.push(videoMeta.audioAttribution.creditLine);
  }
  return [caption, ...creditLines].filter(Boolean).join('\n\n');
}

function buildDefaultReelCaption(currentPost) {
  return [
    currentPost.topic || currentPost.caption || '',
    '',
    '오늘 몸 상태를 짧은 영상으로 천천히 살펴보세요. 자세한 체크 포인트는 피드 카드에 따로 정리해뒀어요.',
  ].filter(Boolean).join('\n');
}

function getReelAudioConfig() {
  const input = argv['reel-audio'] || argv.audio || process.env.REEL_AUDIO_PATH || process.env.REEL_AUDIO_URL || '';
  if (!input) return null;

  const license = argv['reel-audio-license'] || process.env.REEL_AUDIO_LICENSE || '';
  if (!license) {
    throw new Error('REEL_AUDIO_LICENSE or --reel-audio-license is required when adding Reel audio.');
  }

  const title = argv['reel-audio-title'] || process.env.REEL_AUDIO_TITLE || null;
  const creator = argv['reel-audio-creator'] || process.env.REEL_AUDIO_CREATOR || null;
  const sourceUrl = argv['reel-audio-source-url'] || process.env.REEL_AUDIO_SOURCE_URL || (/^https?:\/\//i.test(input) ? input : null);
  if (!title && !sourceUrl) {
    throw new Error('REEL_AUDIO_TITLE or REEL_AUDIO_SOURCE_URL is required when adding Reel audio.');
  }
  const creditLine = argv['reel-audio-credit'] || process.env.REEL_AUDIO_CREDIT || buildAudioCreditLine({ title, creator });
  return {
    input,
    volume: clampAudioVolume(argv['reel-audio-volume'] || process.env.REEL_AUDIO_VOLUME || 0.18),
    attribution: {
      source: 'user_provided_audio',
      title,
      creator,
      sourceUrl,
      license,
      creditLine,
    },
  };
}

function buildAudioCreditLine({ title, creator }) {
  if (!title && !creator) return null;
  return `음악: ${[title, creator].filter(Boolean).join(' - ')}`;
}

function clampAudioVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.18;
  return Math.min(Math.max(number, 0.01), 1);
}

function mediaExtension(value) {
  const match = String(value || '').match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() || null;
}

function spawnFile(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function safeFolderName(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

async function readUsedVideoKeys() {
  const registry = await readVideoRegistry();
  return new Set((registry.used || []).map((entry) => videoKey(entry.source, entry.id)));
}

async function readVideoRegistry() {
  if (!existsSync(VIDEO_REGISTRY_PATH)) {
    return { version: 1, updatedAt: null, used: [] };
  }
  const raw = await readFile(VIDEO_REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: parsed.version || 1,
    updatedAt: parsed.updatedAt || null,
    used: Array.isArray(parsed.used) ? parsed.used : [],
  };
}

async function recordUsedVideo(entry) {
  if (!entry?.id) return;
  const registry = await readVideoRegistry();
  const known = new Set((registry.used || []).map((item) => videoKey(item.source, item.id)));
  const key = videoKey(entry.source, entry.id);
  if (!known.has(key)) registry.used.push(entry);
  registry.updatedAt = new Date().toISOString();
  registry.used.sort((a, b) => String(a.usedAt).localeCompare(String(b.usedAt)));
  await writeFile(VIDEO_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function toVideoRegistryEntry(video, currentPost) {
  return {
    source: video.source,
    id: video.id,
    usedAt: new Date().toISOString(),
    category: currentPost.category || null,
    topic: currentPost.topic || null,
    query: video.query,
    creator: video.user,
    creatorUrl: video.userUrl,
    videoUrl: video.url,
    license: video.attribution.license,
  };
}

function videoKey(source, id) {
  return `${source || 'unknown'}:${String(id || '')}`;
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}
