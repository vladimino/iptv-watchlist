// AIR-570 / ADR 0186 decision 3. The pure schedule of the Letterboxd Sync Workflow: four Europe/Madrid wall-clock slots a day
// (04:30, 10:30, 16:30, 22:30), their keys, due instants, the Workflow instance id and the two slot Event keys.
// No I/O, no clock of its own and no randomness: callers pass the time. None of the four wall times is inside the 02:00-03:00
// DST gap or fold, so a day always has exactly four slots (the spacing is 5 or 7 real hours across a changeover).
import {madridDayKey, madridInstant} from './orchestration-policy.js';

export const LETTERBOXD_SLOT_TIMES = Object.freeze([
  Object.freeze({hour: 4, minute: 30}),
  Object.freeze({hour: 10, minute: 30}),
  Object.freeze({hour: 16, minute: 30}),
  Object.freeze({hour: 22, minute: 30})
]);
export const SLOT_EVENT_TYPES = Object.freeze(['ratings', 'watchlist']);
const DAY_MS = 24 * 3600000;
const pad = n => String(n).padStart(2, '0');

// `2026-11-21T1030`-style stamp of a slot: the Madrid date and the wall time. It is the slot's identity.
export function slotKey(dayKey, index) {
  const time = LETTERBOXD_SLOT_TIMES[index];
  if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error('invalid slot');
  return dayKey + 'T' + pad(time.hour) + pad(time.minute);
}

export function parseSlotKey(key) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})$/.exec(String(key));
  if (!match) return null;
  const index = LETTERBOXD_SLOT_TIMES.findIndex(t => t.hour === Number(match[2]) && t.minute === Number(match[3]));
  return index < 0 ? null : {dayKey: match[1], index};
}

export function slotDueAt(key) {
  const parsed = parseSlotKey(key);
  if (!parsed) throw new Error('invalid slot');
  const time = LETTERBOXD_SLOT_TIMES[parsed.index];
  return madridInstant(parsed.dayKey, time.hour, time.minute);
}

// The four slots of a Madrid date, in due order.
export function slotsOfDay(dayKey) {
  return LETTERBOXD_SLOT_TIMES.map((_, index) => {
    const key = slotKey(dayKey, index);
    return {key, index, dueAt: slotDueAt(key)};
  });
}

// The slot that follows `key`, across midnight. Its due instant bounds the slot window of `key`.
export function nextSlot(key) {
  const parsed = parseSlotKey(key);
  if (!parsed) throw new Error('invalid slot');
  if (parsed.index + 1 < LETTERBOXD_SLOT_TIMES.length) return slotsOfDay(parsed.dayKey)[parsed.index + 1];
  const nextDay = madridDayKey(slotDueAt(key) + DAY_MS);
  return slotsOfDay(nextDay)[0];
}

// The latest slot whose due instant is at or before `ms`, with the end of its eligibility window (the next slot's due instant).
// A slot is eligible from its due instant until the next one is due.
export function latestDueSlot(ms) {
  const today = madridDayKey(ms);
  const candidates = slotsOfDay(today).filter(s => s.dueAt <= ms);
  let slot = candidates[candidates.length - 1];
  if (!slot) {
    const yesterday = madridDayKey(slotDueAt(slotKey(today, 0)) - 12 * 3600000);
    const list = slotsOfDay(yesterday);
    slot = list[list.length - 1];
  }
  return {...slot, windowEndsAt: nextSlot(slot.key).dueAt};
}

// The slot immediately before `key`.
export function previousSlot(key) {
  const parsed = parseSlotKey(key);
  if (!parsed) throw new Error('invalid slot');
  if (parsed.index > 0) return slotsOfDay(parsed.dayKey)[parsed.index - 1];
  const prevDay = madridDayKey(slotDueAt(key) - 12 * 3600000);
  const list = slotsOfDay(prevDay);
  return list[list.length - 1];
}

const compact = key => key.replace(/-/g, '');
// Deterministic Workflow instance id: one per slot and series (a successor after a stopped instance bumps the series).
export function slotInstanceId(key, series = 0) {
  if (!parseSlotKey(key) || !Number.isInteger(series) || series < 0) throw new Error('invalid slot');
  const parsed = parseSlotKey(key);
  const time = LETTERBOXD_SLOT_TIMES[parsed.index];
  return 'lbsync_' + parsed.dayKey.replace(/-/g, '') + '_' + pad(time.hour) + pad(time.minute) + '_' + series;
}

// The two idempotent Event keys of a slot. Derived from the slot, never from the instance.
export function slotEventKey(key, type) {
  if (!parseSlotKey(key) || !SLOT_EVENT_TYPES.includes(type)) throw new Error('invalid slot event');
  return 'lbsync-' + compact(key) + '-' + type;
}
