import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'output');
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const GRID_THUMBNAIL_SIZE = 1080;
const GRID_SAFE_TOP = Math.round((CARD_HEIGHT - GRID_THUMBNAIL_SIZE) / 2);
const GRID_SAFE_BOTTOM = GRID_SAFE_TOP + GRID_THUMBNAIL_SIZE;
const FONT_CSS = fontFaceCss();
const CATEGORIES = ['massage', 'skincare', 'posture'];
const TOPICS = {
  massage: [
    '목과 어깨가 뻐근할 때 받기 좋은 마사지 루틴',
    '오래 앉아 있는 사람을 위한 등 관리 포인트',
    '숙면을 돕는 저녁 마사지 체크리스트',
  ],
  skincare: [
    '피부관리 받기 전 확인하면 좋은 5가지',
    '건조한 피부를 위한 관리 순서',
    '민감 피부가 관리실에서 물어봐야 할 질문',
  ],
  posture: [
    '라운드숄더가 고민일 때 체형관리 체크포인트',
    '골반 균형을 볼 때 놓치기 쉬운 신호',
    '목이 앞으로 나오는 자세를 줄이는 관리 습관',
  ],
};

loadEnv(join(ROOT, '.env'));

const argv = parseArgs(process.argv.slice(2));
const PHOTO_REGISTRY_PATH = resolve(argv.photoRegistry || join(ROOT, 'data', 'used-photos.json'));
const TOPIC_REGISTRY_PATH = resolve(argv.topicRegistry || join(ROOT, 'data', 'used-topics.json'));
const { category, topic } = await selectContent(argv);
const slug = slugify(`${new Date().toISOString().slice(0, 10)}-${topic}`);
const outDir = resolve(argv.out || join(OUT_ROOT, slug));

const strategy = getStrategy(category);
const cards = buildCards(topic, strategy);

await mkdir(outDir, { recursive: true });
await mkdir(join(outDir, 'html'), { recursive: true });
await mkdir(join(outDir, 'assets'), { recursive: true });

const photoPacks = await getPhotoPacks(strategy.searchQuery, outDir, cards.length);
const htmlFiles = [];
const pngFiles = [];

for (let index = 0; index < cards.length; index += 1) {
  const card = cards[index];
  const htmlPath = join(outDir, 'html', `${String(index + 1).padStart(2, '0')}.html`);
  const pngPath = join(outDir, `${String(index + 1).padStart(2, '0')}.png`);
  const html = renderHtml({
    card,
    index,
    total: cards.length,
    strategy,
    photoPack: photoPacks[index],
    topic,
  });

  await writeFile(htmlPath, html, 'utf8');
  htmlFiles.push(relative(htmlPath));

  renderPng(htmlPath, pngPath);
  pngFiles.push(relative(pngPath));
}

const feedCaption = buildFeedCaption(topic, strategy, photoPacks);
const reelCaption = buildReelCaption(topic, strategy);
const manifest = {
  topic,
  category,
  generatedAt: new Date().toISOString(),
  outputDir: relative(outDir),
  images: pngFiles,
  html: htmlFiles,
  caption: feedCaption,
  feedCaption,
  reelCaption,
  hashtags: buildHashtags(strategy),
  photos: photoPacks.map((photoPack) => photoPack.attribution),
  feedImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    aspectRatio: '4:5',
    profileGridCrop: {
      width: GRID_THUMBNAIL_SIZE,
      height: GRID_THUMBNAIL_SIZE,
      safeTop: GRID_SAFE_TOP,
      safeBottom: GRID_SAFE_BOTTOM,
      note: 'Keep meaningful text inside the centered 1080x1080 crop so profile grid thumbnails do not cut it off.',
    },
  },
  photoRegistryEntries: photoPacks
    .map((photoPack) => toRegistryEntry(photoPack.attribution, { topic, category }))
    .filter(Boolean),
  reel: {
    kind: 'stock_video_preferred',
    dimensions: '1080x1920',
    secondsPerSlide: 4,
    background: 'F7F2EA',
    mood: 'calm, slow, warm, restorative',
    stockVideoQuery: strategy.videoSearchQuery,
    aiVideoPrompt: buildHealingVideoPrompt(topic, strategy),
  },
  publishing: {
    status: 'ready_for_review',
    note: 'Instagram Graph API carousel publishing needs public image URLs. Use the n8n template to upload these PNGs to a public CDN first.',
  },
};

await writeFile(join(outDir, 'post.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(join(outDir, 'caption.txt'), `${feedCaption}\n\n${manifest.hashtags.join(' ')}\n`, 'utf8');
if (!argv['no-record-used']) {
  await recordUsedPhotos(manifest.photoRegistryEntries);
  await recordUsedTopic({ category, topic });
}

console.log(`Generated carousel: ${relative(outDir)}`);
for (const image of pngFiles) console.log(`- ${image}`);
console.log(`Caption: ${relative(join(outDir, 'caption.txt'))}`);

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
  const raw = requireText(file);
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

function requireText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function selectContent(options) {
  const requestedCategory = normalizeCategory(options.category);
  const registry = await readTopicRegistry();
  if (options.topic) {
    return {
      category: requestedCategory || inferCategory(options.topic) || pickNextCategory(registry),
      topic: String(options.topic).trim(),
    };
  }

  const categoryName = requestedCategory || pickNextCategory(registry);
  return {
    category: categoryName,
    topic: pickNextTopic(categoryName, registry),
  };
}

function normalizeCategory(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return CATEGORIES.includes(normalized) ? normalized : null;
}

function inferCategory(value) {
  const text = String(value || '');
  if (text.includes('피부') || text.includes('스킨')) return 'skincare';
  if (text.includes('체형') || text.includes('자세') || text.includes('골반') || text.includes('라운드숄더')) return 'posture';
  if (text.includes('마사지') || text.includes('어깨') || text.includes('등')) return 'massage';
  return null;
}

function pickNextCategory(registry) {
  const used = Array.isArray(registry.used) ? registry.used : [];
  const lastEntry = used.at(-1);
  const lastUsedAt = (categoryName) => {
    const entry = [...used].reverse().find((item) => item.category === categoryName);
    return entry?.usedAt || '';
  };
  const hourOffset = Math.floor(Date.now() / 3600000) % CATEGORIES.length;
  return CATEGORIES
    .map((categoryName, index) => ({
      categoryName,
      order: (index + CATEGORIES.length - hourOffset) % CATEGORIES.length,
      last: lastUsedAt(categoryName),
      isLastCategory: lastEntry?.category === categoryName,
    }))
    .sort((a, b) => Number(a.isLastCategory) - Number(b.isLastCategory) || a.last.localeCompare(b.last) || a.order - b.order)[0]
    .categoryName;
}

function pickNextTopic(categoryName, registry) {
  const list = TOPICS[categoryName] || TOPICS.massage;
  const used = Array.isArray(registry.used) ? registry.used.filter((item) => item.category === categoryName) : [];
  const usedTopics = new Set(used.map((item) => item.topic));
  const fresh = list.filter((candidate) => !usedTopics.has(candidate));
  if (fresh.length) return fresh[Math.floor(Date.now() / 3600000) % fresh.length];

  const lastUsedAt = (topicName) => {
    const entry = [...used].reverse().find((item) => item.topic === topicName);
    return entry?.usedAt || '';
  };
  return [...list].sort((a, b) => lastUsedAt(a).localeCompare(lastUsedAt(b)))[0];
}

function getStrategy(categoryName) {
  const strategies = {
    massage: {
      label: '마사지',
      searchQuery: 'calm spa massage therapy warm light peaceful wellness',
      videoSearchQuery: 'spa massage shoulders back therapy warm light relaxing wellness',
      theme: {
        ink: '#17211D',
        deep: '#24362E',
        accent: '#C36B4F',
        accent2: '#2F7E79',
        paper: '#F7F2EA',
      },
      hooks: ['내 몸 신호 체크', '예약 전 찾아볼 것', '받고 나서 기록할 것'],
      seoSentence: '마사지샵, 어깨마사지, 목어깨관리, 스파 키워드로 찾아보면서',
      tags: ['#마사지', '#마사지추천', '#마사지샵', '#어깨마사지', '#목어깨관리', '#스파', '#힐링', '#힐링관리'],
    },
    skincare: {
      label: '피부관리',
      searchQuery: 'calm facial skincare spa treatment soft natural light',
      videoSearchQuery: 'facial skincare spa treatment relaxing beauty clinic soft light',
      theme: {
        ink: '#1E2428',
        deep: '#293A42',
        accent: '#BB6F7A',
        accent2: '#57806F',
        paper: '#F6EEF0',
      },
      hooks: ['내 피부 신호 체크', '예약 전 찾아볼 것', '받고 나서 기록할 것'],
      seoSentence: '피부관리샵, 스킨케어, 에스테틱, 수분관리 정보를 볼 때',
      tags: ['#피부관리', '#피부관리샵', '#스킨케어', '#에스테틱', '#수분관리', '#민감피부', '#피부고민', '#뷰티관리'],
    },
    posture: {
      label: '체형교정',
      searchQuery: 'calm stretching posture wellness studio soft light',
      videoSearchQuery: 'stretching posture wellness studio calm body care soft light',
      theme: {
        ink: '#151F2A',
        deep: '#233345',
        accent: '#CF7445',
        accent2: '#3C7A89',
        paper: '#F3F0E8',
      },
      hooks: ['내 자세 신호 체크', '예약 전 찾아볼 것', '받고 나서 기록할 것'],
      seoSentence: '체형교정, 체형관리, 자세교정, 라운드숄더 관리를 알아볼 때',
      tags: ['#체형교정', '#체형관리', '#자세교정', '#라운드숄더', '#골반균형', '#바디밸런스', '#스트레칭', '#웰니스'],
    },
  };
  return strategies[categoryName] || strategies.massage;
}

function buildCards(currentTopic, strategy) {
  const subject = currentTopic.replace(/\s+/g, ' ').trim();
  return [
    {
      kind: 'cover',
      kicker: strategy.label,
      title: subject,
      subtitle: '요즘 관심 가는 관리 포인트 정리',
    },
    {
      kind: 'list',
      kicker: '01',
      title: strategy.hooks[0],
      body: [
        '요즘 자주 뻐근한 부위 적어두기',
        '강한 자극보다 다음 날 컨디션 보기',
        '내가 편한 압과 불편한 자극 구분하기',
      ],
    },
    {
      kind: 'list',
      kicker: '02',
      title: strategy.hooks[1],
      body: [
        '후기에서 위생, 상담, 압 조절 확인하기',
        '내가 원하는 분위기와 관리 목적 정리하기',
        '사진보다 실제 방문 후기를 먼저 보기',
      ],
    },
    {
      kind: 'list',
      kicker: '03',
      title: strategy.hooks[2],
      body: [
        '받은 날 느낌보다 다음 날 몸 상태 기록하기',
        '잘 맞았던 포인트는 다음 예약 전에 다시 보기',
        '피부와 몸이 편했던 관리 환경 메모하기',
      ],
    },
    {
      kind: 'closing',
      kicker: 'SAVE',
      title: '다음 관리 전에 다시 보기',
      subtitle: `${strategy.label} 관심러 저장용 체크리스트`,
      body: ['다음 예약 전에 다시 확인하기', '내 몸에 맞았던 기준은 따로 기록하기'],
    },
  ];
}

async function getPhotoPacks(query, directory, count) {
  const fallback = {
    imageUrl: '',
    cssClass: 'fallback-bg',
    attribution: {
      source: 'generated_css_background',
      license: 'No external photo used. Add PEXELS_API_KEY to use free stock photos.',
    },
  };

  const localBackgrounds = argv['allow-local-backgrounds']
    ? await findLocalBackgrounds(category)
    : [];
  if (localBackgrounds.length >= count) {
    return localBackgrounds.slice(0, count).map((sourcePath) => ({
      imageUrl: pathToFileURL(sourcePath).href,
      cssClass: 'photo-bg',
      attribution: {
        source: 'local_background',
        file: relative(sourcePath),
        license: 'User-provided or locally generated image. Confirm rights before posting.',
      },
    }));
  }

  try {
    const usedKeys = await readUsedPhotoKeys();
    const candidates = await getStockPhotoCandidates(query, Math.max(20, count * 8));
    const uniquePhotos = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = photoKey(candidate.source, candidate.id);
      if (!candidate.id || !candidate.imageUrl || usedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      uniquePhotos.push(candidate);
      if (uniquePhotos.length === count) break;
    }

    const packs = [];
    for (let index = 0; index < uniquePhotos.length; index += 1) {
      const photo = uniquePhotos[index];
      const imageUrl = photo.imageUrl;

      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error(`Photo download returned ${imageResponse.status}`);
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      const ext = imageUrl.includes('.png') ? 'png' : 'jpg';
      const localPath = join(directory, 'assets', `background-${String(index + 1).padStart(2, '0')}.${ext}`);
      await writeFile(localPath, buffer);

      packs.push({
        imageUrl: pathToFileURL(localPath).href,
        cssClass: 'photo-bg',
        attribution: photo,
      });
    }

    while (packs.length < count) {
      packs.push({
        ...fallback,
        attribution: {
          ...fallback.attribution,
          reason: 'Not enough unused licensed stock photos were available.',
        },
      });
    }
    return packs.slice(0, count);
  } catch (error) {
    return Array.from({ length: count }, () => ({
      ...fallback,
      attribution: {
        ...fallback.attribution,
        error: error.message,
      },
    }));
  }
}

async function getStockPhotoCandidates(query, perPage) {
  const queries = preferredStockQueries(query);
  const dayOffset = Math.floor(Date.now() / 86400000);
  const searches = [];
  for (let index = 0; index < queries.length; index += 1) {
    const currentQuery = queries[index];
    const preferenceBoost = (queries.length - index) * 2;
    const page = ((dayOffset + index) % 5) + 1;
    if (process.env.PEXELS_API_KEY) searches.push(searchPexels(currentQuery, perPage, preferenceBoost, page));
    if (process.env.PIXABAY_API_KEY) searches.push(searchPixabay(currentQuery, perPage, preferenceBoost, page));
    if (process.env.UNSPLASH_ACCESS_KEY) searches.push(searchUnsplash(currentQuery, perPage, preferenceBoost, page));
  }
  if (!searches.length) return [];

  const results = await Promise.allSettled(searches);
  return results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function preferredStockQueries(query) {
  const base = String(query || '').trim();
  return [
    `Korean East Asian person ${base}`,
    `Asian wellness spa person ${base}`,
    base,
  ].map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function searchPexels(query, perPage, preferenceBoost = 0, page = 1) {
  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('per_page', String(Math.min(80, perPage)));
  url.searchParams.set('page', String(page));

  const response = await fetch(url, {
    headers: { Authorization: process.env.PEXELS_API_KEY },
  });
  if (!response.ok) throw new Error(`Pexels returned ${response.status}`);

  const data = await response.json();
  return (data.photos || []).map((photo) => {
    const imageUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
    return {
      source: 'Pexels',
      id: String(photo.id),
      imageUrl,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      photoUrl: photo.url,
      license: 'Pexels License: free personal and commercial use; attribution not required. Review current Pexels terms before posting.',
      score: stockScore(photo.width, photo.height) + preferenceBoost,
      query,
    };
  });
}

async function searchPixabay(query, perPage, preferenceBoost = 0, page = 1) {
  const url = new URL('https://pixabay.com/api/');
  url.searchParams.set('key', process.env.PIXABAY_API_KEY);
  url.searchParams.set('q', query);
  url.searchParams.set('image_type', 'photo');
  url.searchParams.set('orientation', 'vertical');
  url.searchParams.set('safesearch', 'true');
  url.searchParams.set('per_page', String(Math.min(200, Math.max(3, perPage))));
  url.searchParams.set('page', String(page));

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Pixabay returned ${response.status}`);

  const data = await response.json();
  return (data.hits || []).map((photo) => ({
    source: 'Pixabay',
    id: String(photo.id),
    imageUrl: photo.largeImageURL || photo.webformatURL,
    photographer: photo.user,
    photographerUrl: `https://pixabay.com/users/${photo.user}-${photo.user_id}/`,
    photoUrl: photo.pageURL,
    license: 'Pixabay Content License: royalty-free use under Pixabay terms. Review current Pixabay terms before posting.',
    score: stockScore(photo.imageWidth, photo.imageHeight) + preferenceBoost,
    query,
  }));
}

async function searchUnsplash(query, perPage, preferenceBoost = 0, page = 1) {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('content_filter', 'high');
  url.searchParams.set('per_page', String(Math.min(30, perPage)));
  url.searchParams.set('page', String(page));

  const response = await fetch(url, {
    headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
  });
  if (!response.ok) throw new Error(`Unsplash returned ${response.status}`);

  const data = await response.json();
  return (data.results || []).map((photo) => ({
    source: 'Unsplash',
    id: String(photo.id),
    imageUrl: photo.urls?.regular || photo.urls?.full,
    photographer: photo.user?.name,
    photographerUrl: photo.user?.links?.html,
    photoUrl: photo.links?.html,
    license: 'Unsplash License: free commercial use; API guidelines require attribution to Unsplash and the photographer.',
    requiresAttribution: true,
    score: stockScore(photo.width, photo.height) + preferenceBoost + (photo.likes || 0) / 1000,
    query,
  }));
}

function stockScore(width, height) {
  let score = 0;
  const ratio = height && width ? height / width : 1;
  if (ratio >= 1.0 && ratio <= 1.8) score += 3;
  if ((width || 0) >= 2500) score += 2;
  if ((height || 0) >= 2500) score += 1;
  return score;
}

async function readUsedPhotoKeys() {
  const registry = await readPhotoRegistry();
  return new Set((registry.used || []).map((entry) => photoKey(entry.source, entry.id)));
}

async function readPhotoRegistry() {
  if (!existsSync(PHOTO_REGISTRY_PATH)) {
    return { version: 1, updatedAt: null, used: [] };
  }
  const raw = await readFile(PHOTO_REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: parsed.version || 1,
    updatedAt: parsed.updatedAt || null,
    used: Array.isArray(parsed.used) ? parsed.used : [],
  };
}

async function recordUsedPhotos(entries) {
  const stockEntries = entries.filter((entry) => entry && entry.id && entry.source !== 'generated_css_background');
  if (!stockEntries.length) return;

  const registry = await readPhotoRegistry();
  const known = new Set((registry.used || []).map((entry) => photoKey(entry.source, entry.id)));
  for (const entry of stockEntries) {
    const key = photoKey(entry.source, entry.id);
    if (known.has(key)) continue;
    registry.used.push(entry);
    known.add(key);
  }
  registry.updatedAt = new Date().toISOString();
  registry.used.sort((a, b) => String(a.usedAt).localeCompare(String(b.usedAt)));

  await mkdir(dirname(PHOTO_REGISTRY_PATH), { recursive: true });
  await writeFile(PHOTO_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

async function readTopicRegistry() {
  if (!existsSync(TOPIC_REGISTRY_PATH)) {
    return { version: 1, updatedAt: null, used: [] };
  }
  const raw = await readFile(TOPIC_REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: parsed.version || 1,
    updatedAt: parsed.updatedAt || null,
    used: Array.isArray(parsed.used) ? parsed.used : [],
  };
}

async function recordUsedTopic(entry) {
  const registry = await readTopicRegistry();
  registry.used.push({
    category: entry.category,
    topic: entry.topic,
    usedAt: new Date().toISOString(),
  });
  registry.updatedAt = new Date().toISOString();
  registry.used.sort((a, b) => String(a.usedAt).localeCompare(String(b.usedAt)));

  await mkdir(dirname(TOPIC_REGISTRY_PATH), { recursive: true });
  await writeFile(TOPIC_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function toRegistryEntry(attribution, context) {
  if (!attribution || attribution.source === 'generated_css_background') return null;
  return {
    source: attribution.source,
    id: String(attribution.id || attribution.file || attribution.photoUrl || ''),
    usedAt: new Date().toISOString(),
    category: context.category,
    topic: context.topic,
    photographer: attribution.photographer || null,
    photographerUrl: attribution.photographerUrl || null,
    photoUrl: attribution.photoUrl || null,
    license: attribution.license || null,
    query: attribution.query || null,
  };
}

function photoKey(source, id) {
  return `${source || 'unknown'}:${String(id || '')}`;
}

async function findLocalBackgrounds(categoryName) {
  const folder = join(ROOT, 'assets', 'backgrounds', categoryName);
  if (!existsSync(folder)) return [];
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(folder);
  const candidates = files
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort();
  return candidates.map((file) => join(folder, file));
}

function renderHtml({ card, index, total, strategy, photoPack, topic: currentTopic }) {
  const theme = strategy.theme;
  const body = Array.isArray(card.body) ? card.body : [];
  const coverFontSize = coverTitleFontSize(currentTopic);
  const backgroundStyle = photoPack.imageUrl
    ? `background-image: linear-gradient(120deg, rgba(12,18,16,.76), rgba(12,18,16,.32)), url("${photoPack.imageUrl}");`
    : '';

  const listMarkup = body.map((item, idx) => `
    <li>
      <span>${String(idx + 1).padStart(2, '0')}</span>
      <p>${escapeHtml(item)}</p>
    </li>`).join('');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${CARD_WIDTH}, initial-scale=1">
  <title>${escapeHtml(currentTopic)} ${index + 1}</title>
  <style>
    ${FONT_CSS}
    * { box-sizing: border-box; }
    html, body {
      width: ${CARD_WIDTH}px;
      height: ${CARD_HEIGHT}px;
      margin: 0;
      overflow: hidden;
      font-family: "Pretendard", "Noto Sans CJK KR", "Noto Sans KR", Arial, sans-serif;
      color: ${theme.ink};
      background: ${theme.paper};
      letter-spacing: 0;
    }
    .card {
      position: relative;
      width: ${CARD_WIDTH}px;
      height: ${CARD_HEIGHT}px;
      overflow: hidden;
      background:
        radial-gradient(circle at 18% 16%, rgba(255,255,255,.42), transparent 22%),
        linear-gradient(135deg, ${theme.paper}, #FFFFFF 42%, rgba(255,255,255,.78));
    }
    .photo {
      position: absolute;
      inset: 0;
      ${backgroundStyle}
      background-size: cover;
      background-position: center;
      opacity: ${card.kind === 'cover' ? '1' : '.18'};
    }
    .fallback-bg::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(135deg, ${theme.deep}, ${theme.accent2} 48%, ${theme.accent}),
        repeating-linear-gradient(45deg, rgba(255,255,255,.16) 0 2px, transparent 2px 22px);
    }
    .fallback-bg::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 76% 24%, rgba(255,255,255,.34), transparent 0 90px, transparent),
        radial-gradient(circle at 25% 78%, rgba(255,255,255,.22), transparent 0 130px, transparent);
    }
    .cover .fallback-bg { opacity: 1; }
    .content {
      position: relative;
      z-index: 2;
      height: 100%;
      padding: 168px 82px 168px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .cover .content {
      padding: 190px 140px 190px;
    }
    .topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 28px;
      font-size: 28px;
      font-weight: 800;
      color: ${card.kind === 'cover' ? '#FFFFFF' : theme.deep};
    }
    .pill {
      min-height: 56px;
      padding: 12px 22px;
      border-radius: 999px;
      background: ${card.kind === 'cover' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.72)'};
      border: 2px solid ${card.kind === 'cover' ? 'rgba(255,255,255,.36)' : 'rgba(23,33,29,.12)'};
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
    }
    .count {
      font-size: 24px;
      font-weight: 700;
      opacity: .86;
    }
    .main {
      display: flex;
      flex-direction: column;
      gap: 28px;
    }
    .cover .main {
      align-items: center;
      text-align: center;
      gap: 24px;
    }
    h1, h2 {
      margin: 0;
      word-break: keep-all;
      overflow-wrap: anywhere;
      line-height: 1.08;
      letter-spacing: 0;
    }
    h1 {
      max-width: 760px;
      color: #FFFFFF;
      font-size: ${coverFontSize}px;
      font-weight: 900;
      line-height: 1.16;
      text-align: center;
      margin: 0 auto;
      text-shadow: 0 8px 28px rgba(0,0,0,.34);
    }
    h2 {
      max-width: 850px;
      color: ${theme.deep};
      font-size: 66px;
      font-weight: 900;
    }
    .subtitle {
      margin: 0;
      max-width: 820px;
      color: ${card.kind === 'cover' ? 'rgba(255,255,255,.92)' : theme.deep};
      font-size: 34px;
      font-weight: 700;
      line-height: 1.32;
      word-break: keep-all;
      overflow-wrap: anywhere;
    }
    .cover .subtitle {
      max-width: 680px;
      font-size: 30px;
      margin: 0 auto;
      text-align: center;
    }
    .list {
      margin: 16px 0 0;
      padding: 0;
      display: grid;
      gap: 22px;
      list-style: none;
    }
    .list li {
      min-height: 132px;
      display: grid;
      grid-template-columns: 96px 1fr;
      align-items: center;
      gap: 24px;
      padding: 24px 28px;
      background: rgba(255,255,255,.78);
      border: 2px solid rgba(23,33,29,.10);
      border-radius: 8px;
      box-shadow: 0 20px 44px rgba(30,36,40,.08);
    }
    .list span {
      width: 72px;
      height: 72px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: ${theme.accent};
      color: #FFFFFF;
      font-size: 25px;
      font-weight: 900;
    }
    .list p {
      margin: 0;
      color: ${theme.ink};
      font-size: 33px;
      line-height: 1.34;
      font-weight: 700;
      word-break: keep-all;
      overflow-wrap: anywhere;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 24px;
      color: ${card.kind === 'cover' ? 'rgba(255,255,255,.88)' : theme.deep};
      font-size: 25px;
      font-weight: 700;
      line-height: 1.28;
    }
    .rule {
      width: 220px;
      height: 8px;
      background: ${card.kind === 'cover' ? '#FFFFFF' : theme.accent};
      border-radius: 999px;
      opacity: .92;
    }
    .closing .content {
      background: linear-gradient(135deg, rgba(255,255,255,.88), rgba(255,255,255,.68));
    }
    .closing h2 {
      font-size: 78px;
    }
  </style>
</head>
<body>
  <main class="card ${escapeAttr(card.kind)}">
    <div class="photo ${escapeAttr(photoPack.cssClass)}"></div>
    <section class="content">
      <div class="topline">
        <div class="pill">${escapeHtml(card.kicker)}</div>
        <div class="count">${index + 1}/${total}</div>
      </div>
      <div class="main">
        ${card.kind === 'cover'
          ? `<h1>${escapeHtml(card.title)}</h1><p class="subtitle">${escapeHtml(card.subtitle)}</p>`
          : `<h2>${escapeHtml(card.title)}</h2>${card.subtitle ? `<p class="subtitle">${escapeHtml(card.subtitle)}</p>` : ''}${listMarkup ? `<ul class="list">${listMarkup}</ul>` : ''}`}
      </div>
      <div class="footer">
        <div>
          ${escapeHtml(strategy.label)} 콘텐츠<br>
          관심 관리 기록
        </div>
        <div class="rule"></div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderPng(htmlPath, pngPath) {
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--hide-scrollbars',
    `--screenshot=${pngPath}`,
    `--window-size=${CARD_WIDTH},${CARD_HEIGHT}`,
    pathToFileURL(htmlPath).href,
  ];
  const result = spawnSync(chrome, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: process.env.CHROME_HOME || '/tmp/chrome-home',
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp/chrome-config',
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/tmp/chrome-cache',
    },
  });
  if (result.error) {
    throw new Error(`Failed to start ${chrome}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Chrome render failed for ${basename(htmlPath)}:\n${result.stderr || result.stdout}`);
  }
}

function buildFeedCaption(currentTopic, strategy, photoPacks = []) {
  const credits = photoPacks
    .map((photoPack) => photoPack.attribution)
    .filter((attribution) => attribution?.requiresAttribution)
    .map((attribution) => `${attribution.photographer || 'creator'} on ${attribution.source}`)
    .filter(Boolean);
  return [
    `${currentTopic}`,
    '',
    `요즘 ${strategy.label}에 관심이 생겨서 예약 전 기준을 정리해봤어요. ${strategy.seoSentence} 후기만 보기보다 내 상태와 원하는 분위기를 먼저 적어두면 선택이 더 편해요.`,
    ...(credits.length ? ['', `사진: ${[...new Set(credits)].join(', ')}`] : []),
    '',
    '저장해두고 다음 관리 전에 체크해보세요.',
  ].join('\n');
}

function buildReelCaption(currentTopic, strategy) {
  return [
    `${currentTopic}`,
    '',
    `${strategy.label} 루틴을 영상으로 짧게 정리했어요. 오늘 몸 상태를 가볍게 살피고, 무리한 변화보다 편안한 기준을 찾는 데 초점을 둬보세요.`,
    '',
    '릴스는 분위기와 흐름을 보는 용도라서 자세한 체크 포인트는 피드 카드에 따로 정리해뒀어요.',
  ].join('\n');
}

function buildHealingVideoPrompt(currentTopic, strategy) {
  const careScene = strategy.label === '마사지'
    ? 'Show a professional spa massage scene focused on shoulders, neck, upper back, hands, towels, and the calm room. The client may be towel-draped or wearing spa attire; private areas must stay fully covered, with no nudity, no nipples, no genitals, no exposed buttocks, and no sensual framing.'
    : `Show ${strategy.label} as a relaxing self-care moment, with gentle camera motion, slow fades, and no hard cuts.`;

  return [
    `Create a calm vertical 9:16 healing wellness video for the Korean topic "${currentTopic}".`,
    `Mood: warm spa lighting, slow breathing rhythm, soft natural textures, quiet hands-on care, no medical claims.`,
    careScene,
    `Use gentle camera motion, slow fades, and no hard cuts.`,
    `Avoid before/after claims, body transformation promises, surgical imagery, clinical scenes, or exaggerated efficacy.`,
    `The video should feel peaceful and trustworthy for Instagram Reels.`,
  ].join(' ');
}

function coverTitleFontSize(value) {
  const length = [...String(value || '').replace(/\s+/g, '')].length;
  if (length >= 30) return 44;
  if (length >= 24) return 48;
  if (length >= 18) return 54;
  return 60;
}

function fontFaceCss() {
  const fontDir = join(ROOT, 'node_modules', 'pretendard', 'dist', 'public', 'static');
  const faces = [
    ['Pretendard-Regular.otf', 400],
    ['Pretendard-Medium.otf', 500],
    ['Pretendard-SemiBold.otf', 600],
    ['Pretendard-Bold.otf', 700],
    ['Pretendard-ExtraBold.otf', 800],
    ['Pretendard-Black.otf', 900],
  ];

  return faces
    .map(([file, weight]) => {
      const fontPath = join(fontDir, file);
      if (!existsSync(fontPath)) return '';
      return `@font-face {
        font-family: "Pretendard";
        src: url("${pathToFileURL(fontPath).href}") format("opentype");
        font-weight: ${weight};
        font-style: normal;
        font-display: block;
      }`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildHashtags(strategy) {
  const common = ['#셀프관리', '#관리루틴', '#웰니스', '#뷰티정보', '#일상관리', '#힐링루틴'];
  return [...new Set([...strategy.tags, ...common])].slice(0, 4);
}

function slugify(input) {
  return input
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/[^a-zA-Z0-9_-]/g, '');
}

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}
