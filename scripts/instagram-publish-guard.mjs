import { inSlotObservationWindow } from './instagram-slot-window.mjs';

export const DEFAULT_DUPLICATE_TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function captionContainsTopic(caption, topic) {
  const normalizedTopic = normalizeText(topic);
  return Boolean(normalizedTopic) && normalizeText(caption).includes(normalizedTopic);
}

export function findPriorTopicConflicts(items, {
  topic,
  slot,
  now = Date.now(),
  windowMs = DEFAULT_DUPLICATE_TOPIC_WINDOW_MS,
} = {}) {
  return (items || []).filter((item) => {
    if (!item.timestamp || !captionContainsTopic(item.caption, topic)) return false;
    if (slot && inSlotObservationWindow(item.timestamp, slot)) return false;
    return isRecent(item.timestamp, now, windowMs);
  });
}

export function findFormatDuplicateConflicts(items, {
  topic,
  format,
  now = Date.now(),
  windowMs = DEFAULT_DUPLICATE_TOPIC_WINDOW_MS,
} = {}) {
  return (items || []).filter((item) => (
    mediaFormat(item) === format
    && item.timestamp
    && captionContainsTopic(item.caption, topic)
    && isRecent(item.timestamp, now, windowMs)
  ));
}

export function findNewlyObservedItems(initialInspection, currentInspection) {
  const initialIds = new Set([
    ...(initialInspection.reels || []),
    ...(initialInspection.feeds || []),
    ...(initialInspection.stories || []),
  ].map((item) => item.id));
  return [
    ...(currentInspection.reels || []),
    ...(currentInspection.feeds || []),
    ...(currentInspection.stories || []),
  ].filter((item) => !initialIds.has(item.id));
}

export function mediaFormat(item) {
  return item?.media_product_type || item?.media_type || 'UNKNOWN';
}

export function publicConflict(item) {
  return {
    id: item.id,
    type: mediaFormat(item),
    timestamp: item.timestamp,
    captionFirstLine: String(item.caption || '').split(/\r?\n/)[0],
    permalink: item.permalink || null,
  };
}

function isRecent(timestamp, now, windowMs) {
  const age = Number(now) - new Date(timestamp).getTime();
  return age >= 0 && age <= windowMs;
}

function normalizeText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
