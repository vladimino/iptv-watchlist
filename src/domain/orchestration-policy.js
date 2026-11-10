// AIR-347 / ADR 0089. The shared, pure part of the Cloudflare executors' reliability contract: the Europe/Madrid day key and
// the logical schedule, the failure classes and their codes, the persisted retry budget with its cooldowns and caps, and the
// derived health. No I/O, no clock and no randomness of its own: callers pass the time and, for jitter, a random source.
// Shared code never holds state (ADR 0089 decision 1.2). The field-level contract is docs/reference/orchestration-reliability.md.

export const MADRID_ZONE = 'Europe/Madrid';
export const RATINGS_SCHEDULE = Object.freeze({hour: 17, minute: 0});
// AIR-348 / ADR 0100: the daily EPG publication is due at 17:00 Europe/Madrid, the monitor's EPG due time.
export const EPG_SCHEDULE = Object.freeze({hour: 17, minute: 0});
export const COOLDOWNS_MS = Object.freeze([60000, 300000, 900000, 3600000]);
export const BUDGET_CAPS = Object.freeze({consecutive: 5, total: 12});
export const JITTER = Object.freeze({low: 0.8, high: 1.2});
export const RATINGS_STALL_MS = 2 * 3600000;
// AIR-420: the daily EPG publication is expected within this long after its due time (the run of 9 November 2026 took 15 minutes
// from the cron tick, most of it the wait for the source; a healthy seal is a few steps).
export const EPG_LATE_MS = 15 * 60000;

export const TRANSIENT_CODES = Object.freeze(['network_error', 'timeout', 'rate_limited', 'upstream_blocked', 'upstream_5xx', 'exceeded_memory', 'exceeded_cpu', 'worker_1102', 'wakeup_lost', 'instance_terminated', 'instance_errored', 'create_uncertain', 'owner_unknown', 'd1_unavailable', 'step_failed']);
export const PERMANENT_CODES = Object.freeze(['credentials_missing', 'credentials_rejected', 'contract_unsupported', 'config_invalid']);
export const UNSAFE_CODES = Object.freeze(['evidence_unreadable', 'evidence_contradictory', 'checkpoint_malformed', 'lease_malformed', 'stale_generation_write', 'owner_conflict', 'epoch_mismatch', 'authority_held', 'authority_loading']);

// The class of a failure code. A code that is not in the contract is refused, never guessed.
export function failureClass(code) {
  if (TRANSIENT_CODES.includes(code)) return 'transient';
  if (PERMANENT_CODES.includes(code)) return 'permanent';
  if (UNSAFE_CODES.includes(code)) return 'unsafe';
  throw new Error('unknown failure code');
}

const zoneFormat = new Intl.DateTimeFormat('en-GB', {timeZone: MADRID_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});

function madridFields(ms) {
  const fields = {};
  for (const part of zoneFormat.formatToParts(new Date(ms))) if (part.type !== 'literal') fields[part.type] = Number(part.value);
  return fields;
}

// The Europe/Madrid local date, YYYY-MM-DD, of an instant. Conversion uses the IANA zone, never a fixed offset.
export function madridDayKey(ms) {
  const f = madridFields(ms);
  return String(f.year).padStart(4, '0') + '-' + String(f.month).padStart(2, '0') + '-' + String(f.day).padStart(2, '0');
}

export function madridMinutes(ms) {
  const f = madridFields(ms);
  return f.hour * 60 + f.minute;
}

// The instant at which the Madrid wall clock reads `hour:minute` on `dayKey`. A wall time that does not exist (spring
// forward) or exists twice (fall back) never occurs at 17:00; the search still settles on the first instant of that reading.
export function madridInstant(dayKey, hour, minute) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = madridFields(guess);
    const shown = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    const delta = wanted - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

// A daily domain is due when the Madrid local time is at or after its scheduled time and that Madrid date has no
// successful run (decision 6.1). `dueAt` is the instant of this date's logical schedule.
export function dailyDue(ms, schedule = RATINGS_SCHEDULE) {
  const dayKey = madridDayKey(ms);
  const dueAt = madridInstant(dayKey, schedule.hour, schedule.minute);
  return {dayKey, dueAt, due: ms >= dueAt};
}

// The next instant a daily domain becomes due after `ms`.
export function nextDailyDue(ms, schedule = RATINGS_SCHEDULE) {
  const today = dailyDue(ms, schedule);
  if (ms < today.dueAt) return today.dueAt;
  return madridInstant(madridDayKey(today.dueAt + 24 * 3600000), schedule.hour, schedule.minute);
}

export function emptyBudget() {
  return {consecutive: 0, total: 0, fingerprint: null, lastFailureAt: null};
}

// The fingerprint shows whether the same fault repeats at the same point: class, code, phase and checkpoint.
export function failureFingerprint(failure, phase, checkpoint) {
  return [failureClass(failure.code), failure.code, phase ?? null, checkpoint ?? null].join('|');
}

// Cooldown after the n-th consecutive transient failure, with jitter from an injected random source. An upstream
// Retry-After or a domain pause wins when it is later.
export function cooldownMs(consecutive, random = () => 0.5) {
  const base = COOLDOWNS_MS[Math.min(Math.max(consecutive, 1), COOLDOWNS_MS.length) - 1];
  return Math.round(base * (JITTER.low + (JITTER.high - JITTER.low) * random()));
}

// The effect of one failure on the persisted budget (decision 3). Transient failures count and set a cooldown; the cap
// quarantines the run key. Permanent failures are not counted. Unsafe failures quarantine the domain at once.
// Returns {budget, cooldownUntil, quarantine}: the quarantine, when set, is {scope, reason}.
export function applyFailure(budget, failure, {now, phase = null, checkpoint = null, retryAfterAt = null, random = () => 0.5} = {}) {
  const klass = failureClass(failure.code);
  const at = new Date(now).toISOString();
  if (klass === 'unsafe') return {budget: {...budget, fingerprint: failureFingerprint(failure, phase, checkpoint), lastFailureAt: at}, cooldownUntil: null, quarantine: {scope: 'domain', reason: failure.code}};
  if (klass === 'permanent') return {budget: {...budget, fingerprint: failureFingerprint(failure, phase, checkpoint), lastFailureAt: at}, cooldownUntil: null, quarantine: null};
  const next = {consecutive: budget.consecutive + 1, total: budget.total + 1, fingerprint: failureFingerprint(failure, phase, checkpoint), lastFailureAt: at};
  if (next.consecutive >= BUDGET_CAPS.consecutive || next.total >= BUDGET_CAPS.total) return {budget: next, cooldownUntil: null, quarantine: {scope: 'run', reason: 'budget_exhausted'}};
  const own = now + cooldownMs(next.consecutive, random);
  const later = Number.isFinite(retryAfterAt) ? Math.max(own, retryAfterAt) : own;
  return {budget: next, cooldownUntil: new Date(later).toISOString(), quarantine: null};
}

// Only durable progress resets `consecutive`; `total` resets with a new run key.
export function applyProgress(budget) {
  return {...budget, consecutive: 0};
}

// The derived health (decision 7.2). `waiting` and `cooldown` do not alert; `stalled`, `quarantined` and
// `failed_permanent` do. Inputs are facts the caller has read: no clock of its own.
// AIR-420. `lateMs` is the domain's publication target after its due time. A domain that passes it reads `late` once that
// long has passed with the work not done and no cooldown or planned wake that explains it, whether or not its checkpoints
// still advance: an hour of slow but moving work is not healthy. A domain that does not pass it never reads `late`.
export function deriveHealth({now, dueAt, done, quarantine, permanent, cooldownUntil, nextWakeAt, lastDurableProgressAt, stallMs = RATINGS_STALL_MS, lateMs = null}) {
  if (quarantine) return 'quarantined';
  if (permanent) return 'failed_permanent';
  if (done || !(Number.isFinite(dueAt) && now >= dueAt)) return done ? 'healthy' : 'idle';
  if (Date.parse(cooldownUntil || '') > now) return 'cooldown';
  if (Date.parse(nextWakeAt || '') > now) return 'waiting';
  const progress = Date.parse(lastDurableProgressAt || '');
  const since = Number.isFinite(progress) && progress >= dueAt ? progress : dueAt;
  if (now - since > stallMs) return 'stalled';
  return Number.isFinite(lateMs) && lateMs > 0 && now - dueAt > lateMs ? 'late' : 'healthy';
}
