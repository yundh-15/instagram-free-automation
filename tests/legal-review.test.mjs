import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_SCRIPT = join(ROOT, 'scripts', 'legal-review.mjs');

test('legal review accepts traced safe visual copy', async () => {
  const result = await review(validPayload());

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.pass, true);
});

test('legal review blocks prohibited wording rendered in a card', async () => {
  const payload = validPayload();
  payload.cards[1].body = ['통증 완치 보장'];

  const result = await review(payload);

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.output.pass, false);
  assert.ok(result.output.issues.some((issue) => issue.type === 'medical_or_ad_claim'));
});

test('legal review blocks uploaded media payload without card text traceability', async () => {
  const payload = validPayload();
  delete payload.images;
  delete payload.cards;
  payload.imageUrls = ['https://example.test/01.jpg', 'https://example.test/02.jpg'];

  const result = await review(payload);

  assert.notEqual(result.exitCode, 0);
  assert.ok(result.output.issues.some((issue) => issue.type === 'visual_copy_traceability'));
});

test('legal review blocks a payload without publishable images', async () => {
  const payload = validPayload();
  delete payload.images;
  delete payload.cards;
  delete payload.photos;

  const result = await review(payload);

  assert.notEqual(result.exitCode, 0);
  assert.ok(result.output.issues.some((issue) => issue.type === 'visual_asset_count'));
});

function validPayload() {
  return {
    topic: '편안한 관리 체크리스트',
    images: ['01.png', '02.png'],
    cards: [
      { title: '예약 전 확인', subtitle: '내 상태를 살펴보세요', body: [] },
      { title: '관리 기록', subtitle: '무리하지 않는 기준', body: ['다음 날 반응 기록하기'] },
    ],
    photos: [
      { source: 'generated_css_background' },
      { source: 'generated_css_background' },
    ],
    feedCaption: '관리 전에 확인할 내용을 정리했습니다.',
    reelCaption: '짧은 영상으로 관리 기준을 확인해보세요.',
    hashtags: ['#웰니스'],
  };
}

async function review(payload) {
  const directory = await mkdtemp(join(tmpdir(), 'instagram-legal-review-'));
  const payloadPath = join(directory, 'payload.json');
  const outputPath = join(directory, 'review.json');

  try {
    await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const exitCode = await runNode([REVIEW_SCRIPT, '--payload', payloadPath, '--out', outputPath]);
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    return { exitCode, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runNode(args) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore' });
    child.once('close', (code) => resolveExit(code));
  });
}
