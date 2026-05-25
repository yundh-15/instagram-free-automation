import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionContainsTopic,
  findFormatDuplicateConflicts,
  findNewlyObservedItems,
  findPriorTopicConflicts,
} from '../scripts/instagram-publish-guard.mjs';
import { parseSlot } from '../scripts/instagram-slot-window.mjs';

const topic = '라운드숄더가 고민일 때 체형관리 체크포인트';
const currentFeed = {
  id: 'current-feed',
  caption: `체형관리 안내\n주제: ${topic}`,
  media_product_type: 'FEED',
  timestamp: '2026-05-26T10:15:00Z',
};
const priorFeed = {
  id: 'prior-feed',
  caption: `체형관리 안내\n주제: ${topic}`,
  media_product_type: 'FEED',
  timestamp: '2026-05-25T12:18:35Z',
};
const priorReel = {
  id: 'prior-reel',
  caption: `영상 안내\n주제: ${topic}`,
  media_product_type: 'REELS',
  timestamp: '2026-05-25T12:12:42Z',
};

test('topic conflict blocks prior slots but permits completion within the active slot', () => {
  const conflicts = findPriorTopicConflicts([currentFeed, priorFeed], {
    topic,
    slot: parseSlot('2026-05-26T19'),
    now: Date.parse('2026-05-26T12:30:00Z'),
  });

  assert.deepEqual(conflicts.map((item) => item.id), ['prior-feed']);
});

test('format guard blocks only a repeated public format for the same topic', () => {
  const feedConflicts = findFormatDuplicateConflicts([priorFeed, priorReel], {
    topic,
    format: 'FEED',
    now: Date.parse('2026-05-26T12:30:00Z'),
  });

  assert.deepEqual(feedConflicts.map((item) => item.id), ['prior-feed']);
});

test('topic matching normalizes Unicode captions', () => {
  assert.equal(captionContainsTopic(topic.normalize('NFD'), topic), true);
});

test('concurrent publication detection reports items not present at the first slot inspection', () => {
  const additions = findNewlyObservedItems(
    { reels: [], feeds: [priorFeed], stories: [] },
    { reels: [priorReel], feeds: [priorFeed], stories: [] },
  );

  assert.deepEqual(additions.map((item) => item.id), ['prior-reel']);
});
