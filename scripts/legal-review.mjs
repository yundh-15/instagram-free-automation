import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = parseArgs(process.argv.slice(2));
const postPath = resolve(argv.post || argv.payload || '');

if (!postPath || !existsSync(postPath)) {
  throw new Error('Pass --post output/.../post.json or --payload output/.../public-image-urls.json');
}

const payload = JSON.parse(await readFile(postPath, 'utf8'));
const text = [
  payload.topic,
  payload.caption,
  payload.feedCaption,
  payload.reelCaption,
  ...(payload.hashtags || []),
  ...(payload.cards || []).flatMap((card) => [card.title, card.subtitle, ...(card.body || [])]),
].filter(Boolean).join('\n');

const review = reviewContent({ payload, text });
const outputPath = resolve(argv.out || join(dirname(postPath), 'legal-review.json'));
await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');

console.log(`Legal review: ${review.pass ? 'pass' : 'fail'} (${review.riskLevel})`);
console.log(`Result: ${relative(outputPath)}`);

if (!review.pass && !argv['allow-fail']) {
  throw new Error(`Legal review failed: ${review.issues.map((issue) => issue.message).join('; ')}`);
}

function reviewContent({ payload: currentPayload, text: currentText }) {
  const issues = [];
  const warnings = [];

  if (
    currentPayload.feedCaption
    && currentPayload.reelCaption
    && normalizeText(currentPayload.feedCaption) === normalizeText(currentPayload.reelCaption)
  ) {
    issues.push({
      type: 'duplicate_format_captions',
      message: '피드와 릴스 본문이 같아 자동 게시를 차단합니다.',
    });
  }

  const hardClaims = [
    '완치', '치료 보장', '효과 보장', '100%', '부작용 없음', '통증 즉시 해소',
    '키가 커', '피부 나이 역행', '셀룰라이트 감소', '면역력 강화', '해독', '디톡스',
  ];
  const medicalTerms = ['진단', '처방', '치료', '염증', '질병', '만성통증', '환자'];
  const absoluteTerms = ['최고', '유일', '반드시', '즉시', '영구', '무조건'];
  const positioningTerms = ['체험단', '모집'];

  for (const term of hardClaims) {
    if (currentText.includes(term)) {
      issues.push({
        type: 'medical_or_ad_claim',
        term,
        message: `의료/효능 보장 또는 과장으로 해석될 수 있는 표현: ${term}`,
      });
    }
  }

  for (const term of medicalTerms) {
    if (currentText.includes(term)) {
      warnings.push({
        type: 'medical_expression',
        term,
        message: `의료행위 또는 치료효과 광고로 오인될 수 있어 완화 표현 검토 필요: ${term}`,
      });
    }
  }

  for (const term of absoluteTerms) {
    if (currentText.includes(term)) {
      warnings.push({
        type: 'advertising_expression',
        term,
        message: `객관적 근거 없이는 부당 표시광고 리스크가 있는 절대 표현: ${term}`,
      });
    }
  }

  for (const term of positioningTerms) {
    if (currentText.includes(term)) {
      issues.push({
        type: 'account_positioning',
        term,
        message: `이 계정은 체험단을 모집하는 계정이 아니므로 공개 콘텐츠에 들어가면 안 되는 표현: ${term}`,
      });
    }
  }

  const photos = currentPayload.photos || [];
  if (currentPayload.images?.length && photos.length !== currentPayload.images.length) {
    issues.push({
      type: 'copyright_traceability',
      message: `게시 이미지 수(${currentPayload.images.length})와 권리 검토 대상 수(${photos.length})가 일치하지 않습니다.`,
    });
  }

  for (const photo of photos) {
    if (photo.source === 'local_background') {
      issues.push({
        type: 'copyright',
        message: `로컬 이미지 ${photo.file || ''}는 권리 확인 메타데이터가 없어 자동 게시를 차단합니다.`,
      });
      continue;
    }

    if (photo.source === 'Pexels' || photo.source === 'Pixabay') {
      if (!photo.id || !photo.photoUrl || !photo.license) {
        issues.push({
          type: 'stock_license',
          message: `${photo.source} 이미지의 id, photoUrl, license 메타데이터가 부족해 자동 게시를 차단합니다.`,
        });
        continue;
      }
      warnings.push({
        type: 'stock_license',
        message: `${photo.source} 이미지 ${photo.id}는 라이선스 메타데이터를 보관했습니다. 인물/브랜드가 제품 보증처럼 보이지 않는지 확인 대상입니다.`,
      });
      continue;
    }

    if (photo.source === 'Unsplash') {
      if (!photo.id || !photo.photoUrl || !photo.license || !photo.photographer) {
        issues.push({
          type: 'stock_license',
          message: 'Unsplash 이미지의 id, photoUrl, photographer, license 메타데이터가 부족해 자동 게시를 차단합니다.',
        });
        continue;
      }
      const combinedCaption = [currentPayload.caption, currentPayload.feedCaption, currentPayload.reelCaption]
        .filter(Boolean)
        .join('\n');
      if (!combinedCaption.includes('Unsplash')) {
        issues.push({
          type: 'stock_attribution',
          message: `Unsplash 이미지 ${photo.id}는 API 가이드라인상 출처 표기가 필요하므로 캡션에 Unsplash 크레딧이 없으면 차단합니다.`,
        });
        continue;
      }
      warnings.push({
        type: 'stock_license',
        message: `Unsplash 이미지 ${photo.id}는 캡션 크레딧과 라이선스 메타데이터를 확인했습니다.`,
      });
      continue;
    }

    if (photo.source === 'generated_css_background') {
      continue;
    }

    issues.push({
      type: 'copyright_unknown_source',
      message: `이미지 출처가 확인되지 않아 자동 게시를 차단합니다: ${photo.source || 'unknown'}`,
    });
  }

  if (currentPayload.reelVideoUrl && !currentPayload.uploads?.length) {
    issues.push({
      type: 'asset_traceability',
      message: '릴스 영상 원본 이미지 순서와 이용권리 추적 정보가 부족해 자동 게시를 차단합니다.',
    });
  }

  if (currentPayload.reelVideoSource === 'pexels_video') {
    const video = currentPayload.reelVideoAttribution;
    if (!video?.id || !video?.videoUrl || !video?.license) {
      issues.push({
        type: 'stock_video_license',
        message: 'Pexels 릴스 영상의 id, videoUrl, license 메타데이터가 부족해 자동 게시를 차단합니다.',
      });
    } else {
      warnings.push({
        type: 'stock_video_license',
        message: `Pexels 릴스 영상 ${video.id}는 라이선스 메타데이터를 보관했습니다. 인물/브랜드가 서비스 보증처럼 보이지 않는지 확인 대상입니다.`,
      });
    }
  }

  if (currentPayload.reelVideoSource === 'ai_generated_video') {
    const video = currentPayload.reelVideoAttribution || currentPayload.generatedVideo;
    if (!video?.provider || !video?.prompt || (!video?.license && !video?.termsUrl)) {
      issues.push({
        type: 'generated_video_rights',
        message: 'AI 생성 릴스 영상의 provider, prompt, license 또는 termsUrl 메타데이터가 부족해 자동 게시를 차단합니다.',
      });
    } else {
      warnings.push({
        type: 'generated_video_rights',
        message: `AI 생성 릴스 영상의 생성 출처와 이용 조건을 보관했습니다: ${video.provider}`,
      });
    }
  }

  const knownReelSources = new Set(['pexels_video', 'cloudinary_slideshow', 'ai_generated_video']);
  if (currentPayload.reelVideoSource && !knownReelSources.has(currentPayload.reelVideoSource)) {
    issues.push({
      type: 'unknown_reel_video_source',
      message: `릴스 영상 출처가 확인되지 않아 자동 게시를 차단합니다: ${currentPayload.reelVideoSource}`,
    });
  }

  if (currentPayload.reelAudioAttribution) {
    const audio = currentPayload.reelAudioAttribution;
    if (!audio.license || (!audio.title && !audio.sourceUrl)) {
      issues.push({
        type: 'audio_license',
        message: '릴스 배경음악의 title 또는 sourceUrl, license 메타데이터가 부족해 자동 게시를 차단합니다.',
      });
    } else {
      warnings.push({
        type: 'audio_license',
        message: `릴스 배경음악 라이선스 메타데이터를 보관했습니다: ${audio.title || audio.sourceUrl}`,
      });
    }
  }

  return {
    pass: issues.length === 0,
    riskLevel: issues.length ? 'high' : warnings.length ? 'medium' : 'low',
    reviewedAt: new Date().toISOString(),
    topic: currentPayload.topic,
    checks: {
      medicalAdvertising: '치료/완치/보장/진단/처방 등 의료광고 오인 표현 점검',
      fairAdvertising: '즉시/최고/유일/100% 등 객관적 근거 없는 절대 표현 점검',
      accountPositioning: '체험단 모집 계정처럼 보이는 공개 표현 차단',
      copyright: '출처 미상/권리 미확인 이미지 차단, 스톡/생성 영상 라이선스 메타데이터 보관, 릴스 원본 추적 점검',
    },
    issues,
    warnings,
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function relative(path) {
  return path.replace(`${ROOT}/`, '');
}
