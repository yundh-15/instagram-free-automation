import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  currentSlot,
  inSlotObservationWindow,
  latestSafeRecoveryStartUtc,
  parseSlot,
  recoveryCompletionLeadMs,
  slotObservationEndUtc,
  slotPublishCutoffUtc,
} from '../scripts/instagram-slot-window.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('late publication is observed as part of the same slot until the next slot begins', () => {
  const slot = parseSlot('2026-05-25T19');

  assert.equal(slotPublishCutoffUtc(slot).toISOString(), '2026-05-25T12:00:00.000Z');
  assert.equal(slotObservationEndUtc(slot).toISOString(), '2026-05-26T00:00:00.000Z');
  assert.equal(inSlotObservationWindow('2026-05-25T12:12:42+0000', slot), true);
  assert.equal(inSlotObservationWindow('2026-05-26T00:00:00+0000', slot), false);
});

test('current slot switches at the next Korean scheduled hour', () => {
  assert.equal(currentSlot(new Date('2026-05-25T12:57:32Z')).key, '2026-05-25T19');
  assert.equal(currentSlot(new Date('2026-05-26T00:00:00Z')).key, '2026-05-26T09');
});

test('late recovery reserves remaining format gaps and processing time before the next slot', () => {
  const options = {
    formatGapMs: 300000,
    requiredStoryCount: 5,
    postCheckDelayMs: 15000,
    recoveryCompletionReserveMs: 900000,
  };
  const fullLeadMs = recoveryCompletionLeadMs({ reels: [], feeds: [], stories: [] }, options);
  const storyOnlyLeadMs = recoveryCompletionLeadMs({ reels: [{}], feeds: [{}], stories: [] }, options);

  assert.equal(fullLeadMs, 1515000);
  assert.equal(storyOnlyLeadMs, 915000);
  assert.equal(
    latestSafeRecoveryStartUtc(parseSlot('2026-05-26T13'), fullLeadMs).toISOString(),
    '2026-05-26T09:34:45.000Z',
  );
});

test('scheduled workflow retries off the hour and permits bounded late recovery', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'instagram-carousel.yml'), 'utf8');
  const runner = await readFile(join(ROOT, 'scripts', 'run-instagram-slot.mjs'), 'utf8');

  assert.match(workflow, /cron: '7,27,47 0,4,10 \* \* \*'/);
  assert.match(workflow, /cron: '7,27 1,5,11 \* \* \*'/);
  assert.doesNotMatch(workflow, /cron: '0 [^']* \* \* \*'/);
  assert.match(workflow, /recover_current_slot/);
  assert.match(workflow, /github\.event\.inputs\.recover_current_slot == 'true'/);
  assert.match(workflow, /npm run run:instagram-slot -- --fallback-publish --allow-late-publish --settle-minutes 0/);
  assert.match(runner, /RECOVERY_COMPLETION_RESERVE_MS/);
  assert.match(runner, /latestSafeRecoveryStartAt/);
  assert.ok(runner.indexOf("'scripts/publish-instagram-reel.mjs'") < runner.indexOf("'scripts/publish-instagram-carousel.mjs'"));
  assert.ok(runner.indexOf("'scripts/publish-instagram-carousel.mjs'") < runner.indexOf("'scripts/publish-instagram-stories.mjs'"));
});
