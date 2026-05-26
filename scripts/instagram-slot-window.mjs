export const SCHEDULED_HOURS = Object.freeze([9, 13, 19]);
export const DEFAULT_PUBLISH_WINDOW_MS = 2 * 60 * 60 * 1000;

export function currentSlot(value = new Date()) {
  const parts = kstParts(value);
  let slotHour = SCHEDULED_HOURS.findLast((candidate) => parts.hour >= candidate);
  let { year, month, day } = parts;
  if (!slotHour) {
    const previousParts = kstParts(new Date(new Date(value).getTime() - 24 * 60 * 60 * 1000));
    ({ year, month, day } = previousParts);
    slotHour = SCHEDULED_HOURS.at(-1);
  }
  return slotValue(year, month, day, slotHour);
}

export function parseSlot(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  if (!match) throw new Error('Pass --slot as YYYY-MM-DDTHH in KST, for example 2026-05-24T19');
  const [, year, month, day, hour] = match;
  const parts = [Number(year), Number(month), Number(day), Number(hour)];
  const normalized = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    normalized.getUTCFullYear() !== parts[0]
    || normalized.getUTCMonth() + 1 !== parts[1]
    || normalized.getUTCDate() !== parts[2]
    || !SCHEDULED_HOURS.includes(parts[3])
  ) {
    throw new Error('Slot must be a valid KST date at a scheduled hour: 09, 13, or 19');
  }
  return slotValue(...parts);
}

export function kstSlotToUtc(slot) {
  return new Date(Date.UTC(slot.year, slot.month - 1, slot.day, slot.hour - 9, 0, 0));
}

export function slotPublishCutoffUtc(slot, windowMs = DEFAULT_PUBLISH_WINDOW_MS) {
  return new Date(kstSlotToUtc(slot).getTime() + windowMs);
}

export function slotObservationEndUtc(slot) {
  const hourIndex = SCHEDULED_HOURS.indexOf(slot.hour);
  if (hourIndex === -1) throw new Error(`Unsupported slot hour: ${slot.hour}`);
  const nextHour = SCHEDULED_HOURS[hourIndex + 1];
  const deltaHours = nextHour === undefined
    ? 24 - slot.hour + SCHEDULED_HOURS[0]
    : nextHour - slot.hour;
  return new Date(kstSlotToUtc(slot).getTime() + deltaHours * 60 * 60 * 1000);
}

export function recoveryCompletionLeadMs(
  inspection,
  { formatGapMs, requiredStoryCount, postCheckDelayMs, recoveryCompletionReserveMs },
) {
  const willPublishReel = inspection.reels.length === 0;
  const willPublishFeed = inspection.feeds.length === 0;
  const willPublishStories = inspection.stories.length < requiredStoryCount;
  let gaps = 0;
  if (willPublishReel && willPublishFeed) gaps += formatGapMs;
  if ((willPublishReel || willPublishFeed) && willPublishStories) gaps += formatGapMs;
  return gaps + postCheckDelayMs + recoveryCompletionReserveMs;
}

export function latestSafeRecoveryStartUtc(slot, completionLeadMs) {
  return new Date(slotObservationEndUtc(slot).getTime() - completionLeadMs);
}

export function inSlotObservationWindow(timestamp, slot) {
  const time = new Date(timestamp);
  return time >= kstSlotToUtc(slot) && time < slotObservationEndUtc(slot);
}

function kstParts(value) {
  const kst = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
    hour: kst.getUTCHours(),
  };
}

function slotValue(year, month, day, hour) {
  return {
    year,
    month,
    day,
    hour,
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}`,
  };
}
