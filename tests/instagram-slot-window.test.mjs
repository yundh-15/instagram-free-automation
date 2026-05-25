import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  currentSlot,
  inSlotObservationWindow,
  parseSlot,
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

test('scheduled workflow does not opt into publishing after the cutoff', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'instagram-carousel.yml'), 'utf8');

  assert.match(workflow, /cron: '0 0,4,10 \* \* \*'/);
  assert.match(workflow, /npm run run:instagram-slot -- --fallback-publish --settle-minutes 0/);
  assert.doesNotMatch(workflow, /--allow-late-publish/);
});
