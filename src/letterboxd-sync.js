// AIR-570 / ADR 0186. The dormant control plane of the Letterboxd Sync Workflow: one Workflow instance per Madrid slot
// (04:30, 10:30, 16:30, 22:30), driving three phases in order (Diary and Ratings, a complete Watchlist scan, removal reconciliation).
// This module owns ONLY the control plane: the owner's mode switch with its epoch fence, the slot claim and close by compare-and-swap,
// the slot-owned Event outbox (exactly two Events per slot: ratings and watchlist), delivery, retry bounds, the health read model.
// The phases themselves are PORTS (`ports.ratings`, `ports.watchlist`, `ports.reconcile`); a missing port fails closed, so the
// Watchlist repository of AIR-569 and the ratings adapter plug in without a second authority or a second writer.
// INERT: the mode table is empty by default, which reads as `external`, so `ensure` creates nothing. No cron or binding names this
// module (AIR-571). Everything here is D1 (env.DB) plus one create-only R2 put per Event; it reads no EPG, Discovery or resolver state.
import {applyFailure, cooldownMs} from './domain/orchestration-policy.js';
import {latestDueSlot, nextSlot, previousSlot, slotInstanceId, slotEventKey, parseSlotKey} from './domain/letterboxd-slots.js';

export const MODES = ['external', 'switching', 'cloudflare'];
export const ALIVE = ['running', 'waiting', 'queued', 'paused'];
export const ENDED = ['complete', 'errored', 'terminated', 'absent'];
// AIR-571 E: the independent cron of the Letterboxd Sync `ensure`, at minute 30 UTC (a Madrid `:30` in CET and CEST). The Worker dispatches it in `scheduled`; the cron itself is NOT in wrangler.jsonc until the owner's
// activation GO (the three existing triggers are unchanged), so this constant and the dispatch are dormant until then.
export const CRON = '30 * * * *';
export const LIMITS = {stepCap: 200, sleepFloorMs: 1000, deadlineMarginMs: 5 * 60000, startupGraceMs: 15 * 60000, eventBatch: 4, eventAttempts: 12, missedBack: 4, watchlistStaleMs: 24 * 3600000, mirrorStaleMs: 2 * 3600000, mirrorStaleAttempts: 3, controlAttempts: 4};
export const RATINGS_OUTCOMES = ['finished', 'rate_limited', 'blocked', 'error', 'interrupted', 'skipped_missed', 'noop'];
export const WATCHLIST_OUTCOMES = ['committed', 'no_change', 'incomplete', 'unavailable', 'rate_limited', 'error', 'interrupted', 'skipped_missed', 'disabled'];
const TERMINAL = ['finished', 'error', 'interrupted', 'skipped_missed'];
const iso = ms => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();
const dbOf = env => (env && env.DB && typeof env.DB.prepare === 'function') ? env.DB : null;

// ---- storage -------------------------------------------------------------------------------------------------------
async function first(env, sql, ...binds) {
  const db = dbOf(env);
  if (!db) throw Object.assign(new Error('d1 unavailable'), {code: 'd1_unavailable'});
  try { return await db.prepare(sql).bind(...binds).first(); } catch (error) { throw classifyStorage(error); }
}
async function batch(env, statements) {
  const db = dbOf(env);
  if (!db) throw Object.assign(new Error('d1 unavailable'), {code: 'd1_unavailable'});
  try { return await db.batch(statements); } catch (error) { throw classifyStorage(error); }
}
// A schema that is not applied is the inert default, not a fault: callers treat `schema_absent` as "no row".
function classifyStorage(error) {
  const text = String(error?.message || '');
  if (/no such table/i.test(text)) return Object.assign(new Error('schema absent'), {code: 'schema_absent'});
  if (/letterboxd_sync_fence|CHECK constraint failed: ok = 1/i.test(text)) return Object.assign(new Error('epoch fence'), {code: 'epoch_mismatch'});
  if (/letterboxd_slot_closed|letterboxd_slot_event_frozen/i.test(text)) return Object.assign(new Error('closed slot'), {code: 'slot_closed'});
  if (/UNIQUE constraint|PRIMARY KEY/i.test(text)) return Object.assign(new Error('write contention'), {code: 'write_contention'});
  return Object.assign(new Error('d1 unavailable'), {code: 'd1_unavailable'});
}
export function classifyThrown(error) {
  const code = String(error?.code || '');
  if (['epoch_mismatch', 'schema_absent', 'slot_closed', 'write_contention', 'd1_unavailable'].includes(code)) return code === 'write_contention' ? 'd1_unavailable' : code;
  return 'step_failed';
}
// The guard statement: ok = 0 (CHECK ok = 1) aborts the whole batch when the mode row no longer admits this epoch.
export const FENCE_GUARD_SQL = "INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id = 1 AND mode = 'cloudflare' AND epoch = ?) THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok";
// The env of every authoritative write of a Letterboxd step: the Ratings documents (facts, removal queue, Diary identity) assert the epoch in their own batch through `ratingsFence.guard`, and the canonical
// Film/Person writers assert it in theirs through the `letterboxd` producer fence. A stale instance whose mode moved mid-step therefore commits nothing, not merely a receipt that is refused later.
// AIR-571 D2. Drain mode: the mode row stays `cloudflare` at the same epoch and carries the marker `drain = 'scan_stopped'` (the existing free-text column, no schema change). While it is set NO new Watchlist scan starts and no
// promotion commits (the guard below rides in the promotion batch, so a scan that began before the marker cannot publish after it), while the causal effects of the current snapshot and the Diary/Ratings phase continue.
export const SCAN_STOPPED = 'scan_stopped';
// AIR-571 E: the CANARY HOLD, in the same free-text column (no schema): `canary:<slotKey>` lets `ensure` claim ONLY that Madrid slot and nothing after it, until the owner's explicit `open_schedule` command (the second gate
// before the full four-slot schedule). `canary:none` is the CLOSED hold: it matches no slot, so nothing is claimed until the owner pins a canary (every return to `cloudflare` through the owner route ends in a hold, never in the full schedule). The two markers compose: `scan_stopped+canary:<slotKey>` is draining under a canary hold. Grammar: null | 'verified' (full schedule) | 'scan_stopped' | 'canary:<slot>' | 'scan_stopped+canary:<slot>'.
export const CANARY_PREFIX = 'canary:';
const SLOT_KEY_TEXT = '(?:\\d{4}-\\d{2}-\\d{2}T\\d{4}|none)';
export const isDraining = drain => typeof drain === 'string' && (drain === SCAN_STOPPED || drain.startsWith(SCAN_STOPPED + '+'));
export const canaryOf = drain => { const match = new RegExp('(?:^|\\+)canary:(' + SLOT_KEY_TEXT + ')$').exec(String(drain ?? '')); return match ? match[1] : null; };
const holdPart = (draining, canary) => [draining ? SCAN_STOPPED : null, canary ? CANARY_PREFIX + canary : null].filter(Boolean).join('+') || null;
export const SCAN_GUARD_SQL = "INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id = 1 AND mode = 'cloudflare' AND epoch = ? AND (drain IS NULL OR (drain <> 'scan_stopped' AND drain NOT LIKE 'scan_stopped+%'))) THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok";
export async function scanOpen(env) {
  const mode = await readMode(env);
  return {open: !mode.malformed && mode.mode === 'cloudflare' && !isDraining(mode.drain), drain: mode.drain ?? null};
}
export const fencedEnv = (env, epoch) => ({...env, ratingsFence: {guard: [FENCE_GUARD_SQL, [epoch]], hard: true}, producerFence: {kind: 'letterboxd', epoch}});
const fenceGuard = (env, epoch) => dbOf(env).prepare(FENCE_GUARD_SQL).bind(epoch);

const emptyMode = () => ({mode: 'external', target: null, from: null, epoch: 0, drain: null, quarantine: null, changedAt: null, revision: 0, writeId: null, stored: false});
export async function readMode(env) {
  let row;
  try { row = await first(env, 'SELECT mode, target, from_mode, epoch, drain, quarantine_reason, quarantined_at, changed_at, revision, write_id FROM letterboxd_sync_mode WHERE id = 1'); }
  catch (error) { if (error.code === 'schema_absent') return {...emptyMode(), schemaAbsent: true}; throw error; }
  if (!row) return emptyMode();
  if (!MODES.includes(row.mode) || !Number.isInteger(row.epoch)) return {...emptyMode(), malformed: true};
  return {mode: row.mode, target: row.target, from: row.from_mode, epoch: row.epoch, drain: row.drain, quarantine: row.quarantine_reason ? {reason: row.quarantine_reason, at: row.quarantined_at} : null, changedAt: row.changed_at, revision: row.revision, writeId: row.write_id, stored: true};
}
// `guards`: [sql, params] statements asserted in the SAME batch before the write (each an upsert of the CHECK (ok = 1) fence row). The batch ends with a fence on `changes()`: a compare-and-swap that
// matched no row trips the CHECK and rolls the whole batch back. Outcomes: 'applied' (the batch itself proved the row changed), 'rejected' (a proven rejection, nothing written: a lost compare-and-swap, a tripped
// guard or a key collision; `guarded` tells the two apart), or 'uncertain' (the reply was lost or the storage failed: the write may or may not have committed, never retried blindly).
const CHANGED_FENCE_SQL = 'INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok';
async function writeMode(env, expected, next, {guards = []} = {}) {
  const writeId = uuid();
  const db = dbOf(env);
  const quarantine = next.quarantine || {};
  const binds = [next.mode, next.target ?? null, next.from ?? null, next.epoch, next.drain ?? null, quarantine.reason ?? null, quarantine.at ?? null, next.changedAt, writeId];
  const statement = expected.stored
    ? db.prepare('UPDATE letterboxd_sync_mode SET mode = ?, target = ?, from_mode = ?, epoch = ?, drain = ?, quarantine_reason = ?, quarantined_at = ?, changed_at = ?, revision = revision + 1, write_id = ? WHERE id = 1 AND revision = ?').bind(...binds, expected.revision)
    : db.prepare('INSERT INTO letterboxd_sync_mode (id, mode, target, from_mode, epoch, drain, quarantine_reason, quarantined_at, changed_at, revision, write_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').bind(...binds);
  const guardStatements = guards.map(([sql, params]) => db.prepare(sql).bind(...params));
  try { await batch(env, [...guardStatements, statement, db.prepare(CHANGED_FENCE_SQL).bind()]); } catch (error) {
    if (error.code === 'epoch_mismatch') return {outcome: 'rejected', guarded: guardStatements.length > 0};
    if (error.code === 'write_contention') return {outcome: 'rejected', guarded: false};
    return {outcome: 'uncertain'};
  }
  return {outcome: 'applied', writeId};
}
const UNCERTAIN = action => ({action, refused: 'write_uncertain', retry: false});

const slotFrom = row => row ? {
  key: row.slot_key, dueAt: row.due_at, series: row.series, instanceId: row.instance_id, epoch: row.epoch, status: row.status, phase: row.phase, runId: row.run_id,
  budget: {consecutive: row.budget_consecutive, total: row.budget_total, fingerprint: null, lastFailureAt: null}, cooldownUntil: row.cooldown_until, failureCode: row.failure_code, quarantine: row.quarantine_reason,
  ratings: {outcome: row.ratings_outcome, at: row.ratings_at}, watchlist: {outcome: row.watchlist_outcome, at: row.watchlist_at, summary: row.watchlist_summary ? JSON.parse(row.watchlist_summary) : null},
  reconciliation: row.reconciliation_outcome, startedAt: row.started_at, closedAt: row.closed_at, updatedAt: row.updated_at, revision: row.revision, writeId: row.write_id
} : null;
const SLOT_COLUMNS = 'slot_key, due_at, series, instance_id, epoch, status, phase, run_id, budget_consecutive, budget_total, cooldown_until, failure_code, quarantine_reason, ratings_outcome, ratings_at, watchlist_outcome, watchlist_at, watchlist_summary, reconciliation_outcome, started_at, closed_at, updated_at, revision, write_id';
export async function readSlot(env, key) {
  try { return slotFrom(await first(env, 'SELECT ' + SLOT_COLUMNS + ' FROM letterboxd_slot WHERE slot_key = ?', key)); }
  catch (error) { if (error.code === 'schema_absent') return null; throw error; }
}
async function recentSlots(env, limit = 8) {
  try {
    const result = await dbOf(env).prepare('SELECT ' + SLOT_COLUMNS + ' FROM letterboxd_slot ORDER BY slot_key DESC LIMIT ?').bind(limit).all();
    return (result.results || []).map(slotFrom);
  } catch (error) { if (/no such table/i.test(String(error?.message || ''))) return []; throw classifyStorage(error); }
}

// ---- slot event payloads (frozen at close) ---------------------------------------------------------------------------
const RATINGS_STATUS = {finished: 'success', noop: 'noop', rate_limited: 'warning', blocked: 'error', error: 'error', interrupted: 'error', skipped_missed: 'warning'};
const WATCHLIST_STATUS = {committed: 'success', no_change: 'noop', incomplete: 'warning', unavailable: 'error', rate_limited: 'warning', error: 'error', interrupted: 'error', skipped_missed: 'warning', disabled: 'warning'};
const bounded = (value, depth = 0) => {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 200);
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 25).map(item => bounded(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k.slice(0, 60), bounded(v, depth + 1)]));
  return null;
};
// A film of the `watchlist` Event keeps the identity contract of the existing Events Log (`id`, `title`, `year`, optional trusted `tmdb`, and for a removed film its stored confirmed rating); anything else is dropped.
const FILM_CAP = 100;
const eventFilmOf = film => {
  if (!film || typeof film !== 'object') return null;
  const id = String(film.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const out = {id, title: String(film.title ?? '').slice(0, 200), year: Number.isInteger(film.year) ? film.year : null};
  if (film.tmdb != null) out.tmdb = String(film.tmdb).slice(0, 20);
  if (Number.isFinite(film.rating)) out.rating = film.rating;
  if (typeof film.ratingObservedAt === 'string') out.ratingObservedAt = film.ratingObservedAt.slice(0, 40);
  if (Array.isArray(film.explainedBy)) out.explainedBy = film.explainedBy.filter(item => item === 'watched' || item === 'rated');
  return out;
};
const filmsOf = list => (Array.isArray(list) ? list : []).map(eventFilmOf).filter(Boolean).slice(0, FILM_CAP);
// The `ratings` Event keeps its AIR-361 contract: the groups the pipeline built (state, cause, coverage, diary, removal, details) are frozen as they are, only bounded in size (the details go first).
const RATINGS_CONTRACT = ['runId', 'trigger', 'state', 'cause', 'interruptedPhase', 'coverage', 'diary', 'removal', 'details'];
const PAYLOAD_CHARS = 18000;
function fitPayload(payload) {
  if (JSON.stringify(payload).length <= PAYLOAD_CHARS) return payload;
  const slim = {...payload, details: null, detailsDropped: true};
  if (JSON.stringify(slim).length <= PAYLOAD_CHARS) return slim;
  return {...slim, diary: null, removal: null, contractDropped: true};
}
export function slotEventPayloads(slot, {ratings, watchlist, closedAt}) {
  const at = closedAt;
  const ratingsAt = ratings?.at || at, watchlistAt = watchlist?.at || at;
  const rOutcome = ratings?.outcome || 'error', wOutcome = watchlist?.outcome || 'error';
  const contract = {};
  if (ratings?.event && typeof ratings.event === 'object') for (const key of RATINGS_CONTRACT) if (ratings.event[key] !== undefined) contract[key] = ratings.event[key];
  // AIR-694: an interrupted Ratings phase that never produced the pipeline's contract (lease lost, run no longer recognised) is frozen with an honest «unknown» contract: state, cause and the known phase,
  // and NO diary/removal groups, so no zero counter stands in for an unknown one. A contract the pipeline did build is never overwritten.
  const interruption = ratings?.interruption || (rOutcome === 'interrupted' ? {reason: ratings?.reason, phase: ratings?.phase} : null);
  if (interruption && contract.state === undefined) Object.assign(contract, {state: 'unknown', cause: 'interrupted', diary: null, removal: null, ...(['diary', 'removal'].includes(interruption.phase) ? {interruptedPhase: interruption.phase} : {})});
  const added = filmsOf(watchlist?.added), removed = filmsOf(watchlist?.removed);
  const addedCount = watchlist?.addedCount ?? (watchlist?.added?.length ?? 0), removedCount = watchlist?.removedCount ?? (watchlist?.removed?.length ?? 0);
  return {
    ratings: {at: ratingsAt, payload: fitPayload({type: 'ratings', slot: slot.key, status: RATINGS_STATUS[rOutcome] || 'error', outcome: rOutcome, at: ratingsAt, ...contract, runId: contract.runId ?? slot.runId ?? null, counts: bounded(ratings?.counts ?? null), reason: (ratings?.reason || interruption?.reason) ? String(ratings?.reason || interruption.reason).slice(0, 60) : null})},
    watchlist: {at: watchlistAt, payload: fitPayload({type: 'watchlist', slot: slot.key, status: WATCHLIST_STATUS[wOutcome] || 'error', outcome: wOutcome, at: watchlistAt, snapshotVersion: watchlist?.snapshotVersion ?? null, lastSuccessAt: watchlist?.lastSuccessAt ?? null, total: watchlist?.total ?? null, baseline: watchlist?.baseline === true, added, removed, addedCount, removedCount, reason: watchlist?.reason ? String(watchlist.reason).slice(0, 60) : null})}
  };
}

// AIR-599 / ADR 0207 decision 4b: the slot record keeps the admission step's per-class counts (checked, transport-retained, not now, gone, definite, at the cap, `cap_refused`,
// `backlog_full`, rows pending longer than the report age). The Event payload is unchanged.
const admissionSummary = admission => admission && typeof admission === 'object' ? {resolved: admission.resolved ?? null, pending: admission.pending ?? null, terminal: admission.terminal ?? null, error: admission.error ? String(admission.error).slice(0, 60) : null, counts: admission.counts && typeof admission.counts === 'object' ? admission.counts : null} : null;
// Close a slot: ONE batch (epoch fence, slot compare-and-swap to a terminal status, the two outbox rows). A closed slot has both Events
// pending until delivered; no other write can close it again (the trigger and the CAS refuse). `skipped` slots use this path from `ensure`.
async function closeSlot(env, slot, {status, ratings, watchlist, reconciliation = null, failureCode = null, epoch, guarded = true, now}) {
  if (!TERMINAL.includes(status)) throw new Error('not terminal');
  const closedAt = iso(now);
  const payloads = slotEventPayloads(slot, {ratings, watchlist, closedAt});
  const writeId = uuid();
  const db = dbOf(env);
  const statements = [];
  if (guarded) statements.push(fenceGuard(env, epoch));
  statements.push(db.prepare("UPDATE letterboxd_slot SET status = ?, phase = 'done', ratings_outcome = ?, ratings_at = ?, watchlist_outcome = ?, watchlist_at = ?, watchlist_summary = ?, reconciliation_outcome = ?, failure_code = ?, closed_at = ?, updated_at = ?, revision = revision + 1, write_id = ? WHERE slot_key = ? AND revision = ? AND closed_at IS NULL")
    .bind(status, ratings?.outcome || 'error', payloads.ratings.at, watchlist?.outcome || 'error', payloads.watchlist.at, JSON.stringify(bounded({snapshotVersion: watchlist?.snapshotVersion ?? null, lastSuccessAt: watchlist?.lastSuccessAt ?? null, addedCount: payloads.watchlist.payload.addedCount, removedCount: payloads.watchlist.payload.removedCount, total: watchlist?.total ?? null, admission: admissionSummary(watchlist?.admission)})), reconciliation, failureCode, closedAt, closedAt, writeId, slot.key, slot.revision));
  for (const type of ['ratings', 'watchlist']) {
    statements.push(db.prepare("INSERT INTO letterboxd_slot_event (slot_key, type, event_key, at, payload_json, status, attempts, next_retry_at, delivered_at) SELECT ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL WHERE EXISTS (SELECT 1 FROM letterboxd_slot WHERE slot_key = ? AND write_id = ?)")
      .bind(slot.key, type, slotEventKey(slot.key, type), payloads[type].at, JSON.stringify(payloads[type].payload), slot.key, writeId));
  }
  await batch(env, statements);
  const after = await readSlot(env, slot.key);
  return {closed: after?.writeId === writeId, slot: after};
}

// ---- Events: create-only R2 puts by the slot-derived key ---------------------------------------------------------------
export const eventObjectKey = (at, id) => 'events/items/' + String(9999999999999 - Date.parse(at)).padStart(13, '0') + '-' + id + '.json';
async function putEvent(env, row) {
  if (!env?.BUCKET || typeof env.BUCKET.put !== 'function') return 'unavailable';
  const payload = JSON.parse(row.payload_json);
  const event = {id: row.event_key, ...payload};
  const saved = await env.BUCKET.put(eventObjectKey(row.at, row.event_key), JSON.stringify(event), {httpMetadata: {contentType: 'application/json'}, onlyIf: {etagDoesNotMatch: '*'}});
  return saved === null ? 'exists' : 'written';
}
// Delivers up to `eventBatch` pending rows, oldest slot first. A failed put leaves the row pending with a backoff; it never blocks a scan or a run.
export async function deliverEvents(env, {now = Date.now(), limit = LIMITS.eventBatch} = {}) {
  let rows;
  try {
    rows = (await dbOf(env).prepare("SELECT slot_key, type, event_key, at, payload_json, attempts, next_retry_at FROM letterboxd_slot_event WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY slot_key ASC, type ASC LIMIT ?").bind(iso(now), limit).all()).results || [];
  } catch (error) { if (/no such table/i.test(String(error?.message || ''))) return {delivered: 0, failed: 0, pending: 0}; throw classifyStorage(error); }
  let delivered = 0, failed = 0;
  for (const row of rows) {
    let result;
    try { result = await putEvent(env, row); } catch { result = 'failed'; }
    if (result === 'written' || result === 'exists') {
      await batch(env, [dbOf(env).prepare("UPDATE letterboxd_slot_event SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, next_retry_at = NULL WHERE slot_key = ? AND type = ? AND status = 'pending'").bind(iso(now), row.slot_key, row.type)]);
      delivered++;
    } else {
      failed++;
      const attempts = row.attempts + 1;
      await batch(env, [dbOf(env).prepare("UPDATE letterboxd_slot_event SET attempts = ?, next_retry_at = ? WHERE slot_key = ? AND type = ? AND status = 'pending'").bind(attempts, iso(now + cooldownMs(Math.min(attempts, 4))), row.slot_key, row.type)]);
    }
  }
  return {delivered, failed, pending: rows.length - delivered};
}

// The reference of a slot's own `watchlist` Event for the removal hand-over: its object key, run and time. The key is DETERMINISTIC (the slot's Event key and the frozen time of the Watchlist phase, which the
// slot row records before reconciliation starts), so the removal queue can point at the Event before it is delivered: an Event not yet stored is the queue's tolerated `event_missing` waiting state, and the
// slot close freezes exactly this key and time. null only while the phase time is unknown. Read only.
export async function slotEventRef(env, slotKey, sourceRunId = null) {
  let row;
  try { row = await first(env, "SELECT s.watchlist_at AS phase_at, e.at AS event_at FROM letterboxd_slot s LEFT JOIN letterboxd_slot_event e ON e.slot_key = s.slot_key AND e.type = 'watchlist' WHERE s.slot_key = ?", slotKey); } catch { return null; }
  const at = row?.event_at || row?.phase_at;
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  return {eventKey: eventObjectKey(at, slotEventKey(slotKey, 'watchlist')), sourceRunId, at};
}

// ---- the owner's mode switch (same three-step pattern as ADR 0090 decision 4) ---------------------------------------------
async function instanceStatus(binding, id) {
  if (!binding || typeof binding.get !== 'function') return 'unknown';
  try {
    const instance = await binding.get(id);
    const status = typeof instance?.status === 'function' ? await instance.status() : instance?.status;
    const name = typeof status === 'string' ? status : status?.status;
    return typeof name === 'string' ? name : 'unknown';
  } catch (error) { return /not found|does not exist|unknown instance/i.test(String(error?.message || '')) ? 'absent' : 'unknown'; }
}
// Drain: no slot of this executor is running on a live instance.
async function drainState(env) {
  let slots;
  try { slots = await recentSlots(env, 4); } catch { return 'unreadable'; }
  for (const slot of slots) {
    if (slot.closedAt || !slot.instanceId) continue;
    const status = await instanceStatus(env.LETTERBOXD_WORKFLOW, slot.instanceId);
    if (status === 'unknown') return 'unreadable';
    if (!ENDED.includes(status)) return 'instance_live';
  }
  return 'verified';
}
// What must hold BEFORE the Letterboxd writer is admitted (O5, T30). Default: not provable here, so the activation is refused.
// `ports.handover(env)` returns {ratingsClosed, ratingsDrained, legacyFenced, watchlistRepository, ratingsPhase}; each must be true.
export async function handoverState(env, ports) {
  if (ports?.handover) {
    try { return await ports.handover(env); } catch { return {error: true}; }
  }
  return {ratingsClosed: false, ratingsDrained: false, legacyFenced: false, watchlistRepository: false, ratingsPhase: false};
}
// What must hold before a RUNNING writer is closed (reverse handover, O5): the durable causal effects of the current snapshot (facts, retention, removal queue) are all done, because once the epoch is
// closed the Letterboxd writer is fenced and nothing could drain them. `ports.effects(env)` returns {drained: boolean, pending?: number, version?: number, drainedVersion?: number}. Mirror delivery, Events and
// pending identity admission are NOT part of this gate. Default: not provable, so the close is refused.
export async function effectsState(env, ports) {
  if (ports?.effects) {
    try { return await ports.effects(env); } catch { return {error: true}; }
  }
  return {drained: false, unproven: true};
}
const HANDOVER_NAMES = ['ratingsClosed', 'ratingsDrained', 'legacyFenced', 'watchlistRepository', 'ratingsPhase'];
// The pins of an owner command: the epoch and the revision of the mode row the owner read (revision 0 = no row yet). A command that names a pin is refused when the row moved. Direct callers may omit them; the owner route requires both.
function pinMismatch(mode, {expectEpoch, expectRevision}) {
  if (expectEpoch !== undefined && mode.epoch !== expectEpoch) return 'epoch';
  if (expectRevision !== undefined && (mode.revision ?? 0) !== expectRevision) return 'revision';
  return null;
}
const modeView = mode => ({mode: mode.mode, target: mode.target, epoch: mode.epoch, revision: mode.revision ?? 0});
// Is a previous canary SETTLED, so that a replacement may be pinned without ever opening the full schedule? `none` (the closed hold) is settled; a slot that was never claimed is settled only after its window ended
// (the latest due slot can then no longer be it, so no tick can claim it); a closed slot is settled; a claimed, unclosed slot is in progress inside its window, and after the window its instance must have ended.
async function canarySettled(env, held, now) {
  if (held === 'none') return {settled: true};
  const windowEnd = nextSlot(held).dueAt;
  const slot = await readSlot(env, held);
  if (!slot) return now >= windowEnd ? {settled: true} : {settled: false, why: 'canary_pending'};
  if (slot.closedAt) return {settled: true};
  if (now < windowEnd) return {settled: false, why: 'canary_in_progress'};
  const status = slot.instanceId ? await instanceStatus(env.LETTERBOXD_WORKFLOW, slot.instanceId) : 'absent';
  return ENDED.includes(status) ? {settled: true} : {settled: false, why: 'canary_instance_live'};
}
// An EARLIER retarget of a hold that cannot have been claimed yet (AIR-571, 22 Nov 2026): the owner may move the canary to a strictly earlier slot while the held slot is still BEFORE its own due instant and has no
// slot row (so no claim, no instance). Such a hold is never `settled` (its window has not even started), and it can only be claimed from its due instant on, so replacing it in ONE pinned write cannot race a tick into
// the old slot and never opens the full schedule. Every other case keeps the settled rule: a later target, a held slot that is due, claimed or unreadable, and the closed hold `none` are not handled here.
async function earlierRetarget(env, held, slot, now) {
  if (!parseSlotKey(held) || String(slot) >= String(held)) return false;
  if (now >= nextSlot(previousSlot(held).key).dueAt) return false; // the due instant of `held` itself
  try { return !(await readSlot(env, held)); } catch { return false; }
}
// The proof that admits the Letterboxd writer (a forward completion, or an abort back to `cloudflare`): all five parts, read as ONE unit by the port, and its pins for the commit batch. {guards} or {refused}.
async function proveAdmission(env, ports, mode) {
  const handover = await handoverState(env, ports);
  const missing = HANDOVER_NAMES.filter(name => handover[name] !== true);
  if (handover.error || missing.length) return {refused: {refused: 'handover_not_proven', missing: handover.error ? ['unreadable'] : missing}};
  // The proof is read OUTSIDE the commit; it is protected AT the commit: the facts it rests on (the Ratings mode and its drain records, the Watchlist marker) are pinned in the same batch as the mode write.
  // A port that cannot pin its facts leaves the proof unprotected, and an unprotected proof does not admit a writer.
  let guards;
  try { guards = ports?.handoverGuards ? await ports.handoverGuards(env, handover) : null; } catch { guards = null; }
  if (!Array.isArray(guards) || !guards.length) return {refused: {refused: 'handover_unprotected'}};
  return {guards};
}
export async function switchMode(env, {action, target, slot, expectEpoch, expectRevision} = {}, ports = {}, now = Date.now()) {
  for (let attempt = 0; attempt < LIMITS.controlAttempts; attempt++) {
    const mode = await readMode(env);
    if (mode.malformed) return {action, refused: 'evidence_unreadable'};
    const pin = pinMismatch(mode, {expectEpoch, expectRevision});
    // A stale pin is never retried: the owner reads the row again and decides.
    if (pin) return {action, refused: 'pin_mismatch', pin, ...modeView(mode)};
    if (action === 'close_admission') {
      if (mode.mode === 'switching') return {action, refused: 'switch_open', mode: mode.mode, target: mode.target, epoch: mode.epoch};
      if (mode.mode === target) return {action, refused: 'already_in_mode', mode: mode.mode, epoch: mode.epoch};
      if (!['external', 'cloudflare'].includes(target)) return {action, refused: 'invalid_target'};
      let guards = [];
      if (mode.mode === 'cloudflare' && target === 'external') {
        // Reverse handover: scanning must already be stopped (`drain`), so the effects proof below cannot be overtaken by a promotion, and no running writer is closed over undrained causal effects (never a silent discard).
        if (!isDraining(mode.drain)) return {action, refused: 'drain_not_started', mode: mode.mode, epoch: mode.epoch};
        const effects = await effectsState(env, ports);
        if (effects.error) return {action, refused: 'effects_unreadable'};
        if (effects.unproven) return {action, refused: 'effects_unproven'};
        if (effects.drained !== true) return {action, refused: 'effects_pending', pending: effects.pending ?? null, version: effects.version ?? null, drainedVersion: effects.drainedVersion ?? null};
        // The read above is not the proof: a promotion may commit between it and the write. The proof is asserted AT the commit, in the batch that closes the epoch (a port that cannot pin it leaves the close refused).
        if (!Array.isArray(effects.guard) || typeof effects.guard[0] !== 'string') return {action, refused: 'effects_unprotected'};
        guards = [effects.guard];
      }
      // A canary hold survives a switching episode (so an abort back to `cloudflare` cannot silently open the full schedule): it is carried in the drain column of the switching row.
      const next = {mode: 'switching', from: mode.mode, target, epoch: mode.epoch + 1, drain: holdPart(false, canaryOf(mode.drain)), changedAt: iso(now), quarantine: mode.quarantine};
      const result = await writeMode(env, mode, next, {guards});
      if (result.outcome === 'applied') return {action, closed: true, mode: 'switching', target, epoch: next.epoch};
      if (result.outcome === 'uncertain') return UNCERTAIN(action);
      // Rejected with nothing written: a tripped guard (the effects are no longer drained) or a lost compare-and-swap (the row moved). With pins this is never a blind retry.
      if (result.guarded && guards.length) { const again = await readMode(env); if (again.revision === mode.revision && again.epoch === mode.epoch) return {action, refused: 'effects_changed'}; }
      if (expectEpoch !== undefined || expectRevision !== undefined) return {action, refused: 'pin_mismatch', pin: 'revision'};
      continue;
    }
    if (action === 'complete') {
      if (mode.mode !== 'switching') return {action, refused: 'not_switching', mode: mode.mode, epoch: mode.epoch};
      // Read-only: the drain observation is reported, never written, so a refusal changes nothing.
      const drain = await drainState(env);
      if (drain !== 'verified') return {action, refused: 'drain_not_verified', drain, mode: 'switching', target: mode.target, epoch: mode.epoch};
      let guards = [];
      if (mode.target === 'cloudflare') {
        const proof = await proveAdmission(env, ports, mode);
        if (proof.refused) return {action, ...proof.refused, mode: 'switching', target: mode.target, epoch: mode.epoch};
        guards = proof.guards;
      }
      // Entering `cloudflare` through the owner route is FAIL-CLOSED: the canary slot is chosen BEFORE admission and written in the same row write as the completion, so no tick can claim a slot between the two commands (even with the
      // cron already deployed). `ports.requireCanary` is set by the owner route (`handle`); a direct internal caller without it keeps the plain completion.
      let admitted = 'verified';
      if (mode.target === 'cloudflare') {
        if (slot !== undefined || ports?.requireCanary === true) {
          if (slot === undefined) return {action, refused: 'canary_required', mode: 'switching', target: mode.target, epoch: mode.epoch};
          if (!parseSlotKey(slot)) return {action, refused: 'invalid_slot'};
          if (String(slot) < latestDueSlot(now).key) return {action, refused: 'slot_in_past', slot};
          admitted = CANARY_PREFIX + slot;
        }
      }
      const next = {mode: mode.target, from: mode.from, target: null, epoch: mode.epoch, drain: admitted, changedAt: iso(now), quarantine: mode.quarantine};
      const result = await writeMode(env, mode, next, {guards});
      if (result.outcome === 'applied') return {action, completed: true, mode: next.mode, epoch: next.epoch, drain: admitted, ...(admitted !== 'verified' ? {canary: admitted.slice(CANARY_PREFIX.length)} : {})};
      if (result.outcome === 'uncertain') return UNCERTAIN(action);
      if (result.guarded && guards.length) { const again = await readMode(env); if (again.revision === mode.revision && again.epoch === mode.epoch) return {action, refused: 'handover_changed', mode: 'switching', target: mode.target, epoch: mode.epoch}; }
      if (expectEpoch !== undefined || expectRevision !== undefined) return {action, refused: 'pin_mismatch', pin: 'revision'};
      continue;
    }
    if (action === 'drain' || action === 'resume') {
      // Drain mode on the running writer: only `cloudflare` (a writer exists), same epoch, one row write. `resume` is the recovery (scans open again).
      if (mode.mode !== 'cloudflare') return {action, refused: 'not_running', mode: mode.mode, epoch: mode.epoch};
      const draining = isDraining(mode.drain);
      if (action === 'drain' && draining) return {action, refused: 'already_draining', mode: mode.mode, epoch: mode.epoch};
      if (action === 'resume' && !draining) return {action, refused: 'not_draining', mode: mode.mode, epoch: mode.epoch};
      const next = {...mode, drain: holdPart(action === 'drain', canaryOf(mode.drain)), changedAt: iso(now)};
      const result = await writeMode(env, mode, next);
      if (result.outcome === 'applied') return {action, [action === 'drain' ? 'draining' : 'resumed']: true, mode: mode.mode, epoch: mode.epoch};
      if (result.outcome === 'uncertain') return UNCERTAIN(action);
      if (expectEpoch !== undefined || expectRevision !== undefined) return {action, refused: 'pin_mismatch', pin: 'revision'};
      continue;
    }
    if (action === 'canary' || action === 'open_schedule') {
      // The two gates around the first natural slot. `canary` (slot, confirm, pins) lets `ensure` claim ONLY that Madrid slot; `open_schedule` (confirm, pins) removes the hold, the explicit owner decision before the full
      // four-slot schedule. Same epoch, one row write; draining is preserved. Set the canary BEFORE the cron is deployed so no tick can claim a slot first.
      if (mode.mode !== 'cloudflare') return {action, refused: 'not_running', mode: mode.mode, epoch: mode.epoch};
      const held = canaryOf(mode.drain);
      if (action === 'canary') {
        if (!parseSlotKey(slot)) return {action, refused: 'invalid_slot'};
        if (String(slot) < latestDueSlot(now).key) return {action, refused: 'slot_in_past', slot};
        if (held) {
          // RETARGET: replacing a hold is allowed only when the previous canary is settled (never claimed and expired, closed, or the closed hold `none`); an in-progress canary is preserved. The hold is replaced in ONE
          // pinned row write, so the full schedule is never open in between.
          if (held === slot) return {action, refused: 'same_slot', canary: held};
          if (!(await earlierRetarget(env, held, slot, now))) {
            const settled = await canarySettled(env, held, now);
            if (!settled.settled) return {action, refused: 'canary_active', why: settled.why, canary: held};
          }
        }
        if (await readSlot(env, slot)) return {action, refused: 'slot_used', slot};
      } else if (!held) return {action, refused: 'no_canary', mode: mode.mode, epoch: mode.epoch};
      else if (held === 'none') return {action, refused: 'canary_not_set', mode: mode.mode, epoch: mode.epoch};
      const next = {...mode, drain: holdPart(isDraining(mode.drain), action === 'canary' ? slot : null), changedAt: iso(now)};
      const result = await writeMode(env, mode, next);
      if (result.outcome === 'applied') return {action, [action === 'canary' ? 'canary' : 'scheduleOpen']: action === 'canary' ? slot : true, mode: mode.mode, epoch: mode.epoch};
      if (result.outcome === 'uncertain') return UNCERTAIN(action);
      if (expectEpoch !== undefined || expectRevision !== undefined) return {action, refused: 'pin_mismatch', pin: 'revision'};
      continue;
    }
    if (action === 'abort') {
      // Recovery from an open switch back to the mode it started from. The epoch was already raised by the close, so a writer of the old epoch stays fenced; no writer is admitted by an abort, and the
      // legacy entry reopens only when the mode is `external` again. The row is the only thing it writes.
      if (mode.mode !== 'switching') return {action, refused: 'not_switching', mode: mode.mode, epoch: mode.epoch};
      if (!['external', 'cloudflare'].includes(mode.from)) return {action, refused: 'evidence_unreadable'};
      // An abort toward `cloudflare` re-admits the Letterboxd writer, so it needs the same proof, pinned at the commit, as a forward completion: a partial Watchlist rollback in between (the marker no longer an open `d1`)
      // or any other changed fact refuses it. An abort toward `external` admits no writer: the legacy entry stays fenced by the Watchlist state (see legacyAdmission) until the Watchlist is back on `epg`/`open`.
      let guards = [];
      if (mode.from === 'cloudflare') {
        const proof = await proveAdmission(env, ports, mode);
        if (proof.refused) return {action, ...proof.refused, mode: 'switching', target: mode.target, epoch: mode.epoch};
        guards = proof.guards;
      }
      const next = {mode: mode.from, from: mode.from, target: null, epoch: mode.epoch, drain: mode.from === 'cloudflare' ? (holdPart(false, canaryOf(mode.drain)) ?? (ports?.requireCanary === true ? CANARY_PREFIX + 'none' : null)) : null, changedAt: iso(now), quarantine: mode.quarantine};
      const result = await writeMode(env, mode, next, {guards});
      if (result.outcome === 'applied') return {action, aborted: true, mode: next.mode, epoch: next.epoch};
      if (result.outcome === 'uncertain') return UNCERTAIN(action);
      if (result.guarded && guards.length) { const again = await readMode(env); if (again.revision === mode.revision && again.epoch === mode.epoch) return {action, refused: 'handover_changed', mode: 'switching', target: mode.target, epoch: mode.epoch}; }
      if (expectEpoch !== undefined || expectRevision !== undefined) return {action, refused: 'pin_mismatch', pin: 'revision'};
      continue;
    }
    return {action, refused: 'unknown_action'};
  }
  return {action, refused: 'write_contention'};
}
// The owner's read-only view before any command: the row and its pins, the drain of the executor's instances, the handover proof, the causal effects and the writers it leaves. Writes nothing.
export async function modeStatus(env, ports = {}) {
  let mode;
  try { mode = await readMode(env); } catch (error) { return {readable: false, reason: classifyThrown(error), sideEffects: 'none'}; }
  if (mode.malformed) return {readable: false, reason: 'evidence_unreadable', sideEffects: 'none'};
  const drain = await drainState(env);
  const handover = await handoverState(env, ports);
  const effects = await effectsState(env, ports);
  const fence = await writerFence(env);
  const admitted = mode.mode === 'cloudflare' ? 1 : 0;
  return {
    readable: true,
    mode: {...modeView(mode), from: mode.from, drain: mode.drain, quarantine: mode.quarantine},
    drain,
    handover: handover.error ? {error: true} : Object.fromEntries(HANDOVER_NAMES.map(name => [name, handover[name] === true])),
    scanning: mode.mode === 'cloudflare' ? (isDraining(mode.drain) ? 'stopped' : 'open') : null,
    canary: mode.mode === 'cloudflare' ? canaryOf(mode.drain) : null,
    effects: effects.error ? {error: true} : effects.unproven ? {unproven: true} : {drained: effects.drained === true, pending: effects.pending ?? null, version: effects.version ?? null, drainedVersion: effects.drainedVersion ?? null},
    legacyFenced: fence.fenced,
    // The Letterboxd side of "exactly one writer": the Ratings side is read from the Ratings mode (handover.ratingsClosed).
    letterboxdWriters: admitted,
    sideEffects: 'none'
  };
}
// AIR-571 D. ONE read that both decides whether the legacy Ratings entry is fenced and returns the exact revision it saw, so the admission and its pin can never come from two different reads: one statement reads the mode row AND the
// Watchlist marker. {fenced, reason, revision, watchlistGuard}: `revision` is the pin (0 = no row yet), returned only for an admitted (`external`) state; null = the Letterboxd schema is absent (inert: nothing to pin).
// Once the Letterboxd mode has ever been switched (epoch > 0), an `external` mode still fences the legacy entry while the Watchlist is not back on the inert `epg`/`open` authority (a reverse handover is complete, the Watchlist
// rollback is not): `watchlist_rollback_pending`. Before the first switch (epoch 0, the dormant default) the Watchlist marker is not consulted, so today's behavior is unchanged. `watchlistGuard` tells the commit guard to assert
// the same Watchlist state in the batch.
export async function legacyAdmission(env) {
  const inert = {fenced: false, reason: null, revision: null, watchlistGuard: false};
  if (!dbOf(env)) return inert;
  let row;
  try {
    row = await first(env, 'SELECT m.mode AS mode, m.epoch AS epoch, m.revision AS revision, w.mode AS w_mode, w.writes AS w_writes FROM (SELECT 1 AS one) LEFT JOIN letterboxd_sync_mode m ON m.id = 1 LEFT JOIN watchlist_authority w ON w.id = 1');
  } catch (error) {
    if (error.code !== 'schema_absent') return {fenced: true, reason: 'evidence_unreadable', revision: null, watchlistGuard: false};
    // One of the two schemas is not applied (an inert state, tests): the mode row alone decides.
    let mode;
    try { mode = await readMode(env); } catch (inner) { return inner.code === 'schema_absent' ? inert : {fenced: true, reason: 'evidence_unreadable', revision: null, watchlistGuard: false}; }
    if (mode.malformed) return {fenced: true, reason: 'evidence_unreadable', revision: null, watchlistGuard: false};
    if (mode.schemaAbsent) return inert;
    // The mode table exists, so the missing table is the Watchlist authority. Before the first switch (epoch 0) that is the inert pre-cutover state; once an epoch was ever recorded it is a partial schema after a switch and
    // the legacy entry fails closed (never the test-only inert fallback).
    if (mode.stored && mode.epoch > 0) return {fenced: true, reason: 'watchlist_schema_absent', revision: null, watchlistGuard: false};
    row = {mode: mode.stored ? mode.mode : null, epoch: mode.epoch, revision: mode.revision, w_mode: undefined, w_writes: undefined};
  }
  const stored = row.mode !== null && row.mode !== undefined;
  if (stored && (!MODES.includes(row.mode) || !Number.isInteger(row.epoch))) return {fenced: true, reason: 'evidence_unreadable', revision: null, watchlistGuard: false};
  if (stored && row.mode === 'switching') return {fenced: true, reason: 'letterboxd_switch_in_progress', revision: null, watchlistGuard: false};
  if (stored && row.mode === 'cloudflare') return {fenced: true, reason: 'letterboxd_sync_active', revision: null, watchlistGuard: false};
  const epoch = stored ? row.epoch : 0;
  const watchlistKnown = row.w_mode !== undefined;
  if (epoch > 0 && watchlistKnown && !(row.w_mode === 'epg' && row.w_writes === 'open')) return {fenced: true, reason: 'watchlist_rollback_pending', revision: null, watchlistGuard: false};
  return {fenced: false, reason: null, revision: stored ? (row.revision ?? 0) : 0, watchlistGuard: watchlistKnown};
}
export async function clearQuarantine(env, now = Date.now()) {
  const mode = await readMode(env);
  if (mode.malformed) return {action: 'clear_quarantine', refused: 'evidence_unreadable'};
  if (mode.mode === 'switching') return {action: 'clear_quarantine', refused: 'switch_in_progress'};
  if (!mode.quarantine) return {action: 'clear_quarantine', cleared: false};
  const result = await writeMode(env, mode, {...mode, quarantine: null, changedAt: iso(now)});
  if (result.outcome === 'uncertain') return UNCERTAIN('clear_quarantine');
  return result.outcome === 'applied' ? {action: 'clear_quarantine', cleared: true} : {action: 'clear_quarantine', refused: 'write_contention'};
}
// The legacy ratings entry points ask this: is the Letterboxd Sync the (future) Diary writer? `cloudflare` and `switching` fence them.
export async function writerFence(env) {
  const admission = await legacyAdmission(env);
  return {fenced: admission.fenced, reason: admission.reason};
}

// ---- admission, claim, ensure ------------------------------------------------------------------------------------------
async function admit(env, {slotKey, series, epoch}) {
  let mode;
  try { mode = await readMode(env); } catch (error) { return {ok: false, reason: classifyThrown(error), transient: error.code === 'd1_unavailable'}; }
  if (mode.malformed) return {ok: false, reason: 'evidence_unreadable', unsafe: true};
  if (mode.mode === 'switching') return {ok: false, reason: 'switch_in_progress'};
  if (mode.mode !== 'cloudflare') return {ok: false, reason: 'not_cloudflare'};
  if (mode.epoch !== epoch) return {ok: false, reason: 'epoch_mismatch'};
  if (mode.quarantine) return {ok: false, reason: 'quarantined'};
  const slot = await readSlot(env, slotKey);
  if (!slot || slot.series !== series) return {ok: false, reason: 'not_owner'};
  return {ok: true, mode, slot};
}
async function claimSlot(env, slot, mode, now) {
  const key = slot.key, writeId = uuid();
  await batch(env, [fenceGuard(env, mode.epoch), dbOf(env).prepare("INSERT INTO letterboxd_slot (slot_key, due_at, series, instance_id, epoch, status, phase, budget_consecutive, budget_total, updated_at, revision, write_id) VALUES (?, ?, 0, ?, ?, 'claimed', 'starting', 0, 0, ?, 1, ?) ON CONFLICT (slot_key) DO NOTHING")
    .bind(key, iso(slot.dueAt), slotInstanceId(key, 0), mode.epoch, iso(now), writeId)]);
  const after = await readSlot(env, key);
  return {claimed: after?.writeId === writeId, slot: after};
}
async function updateSlot(env, slot, epoch, fields) {
  const writeId = uuid(), db = dbOf(env), names = Object.keys(fields);
  const set = names.map(name => name + ' = ?').join(', ');
  await batch(env, [fenceGuard(env, epoch), db.prepare('UPDATE letterboxd_slot SET ' + set + ', revision = revision + 1, write_id = ? WHERE slot_key = ? AND revision = ? AND closed_at IS NULL').bind(...names.map(n => fields[n]), writeId, slot.key, slot.revision)]);
  const after = await readSlot(env, slot.key);
  return after?.writeId === writeId ? after : null;
}
const createError = error => /already exists|already_exists|duplicate/i.test(String(error?.name || '') + ' ' + String(error?.message || '')) ? 'exists' : 'uncertain';

// The hourly-at-:30 entry. At most a few reads and one create. Inert unless the mode is `cloudflare`. Duplicate firings are safe: the slot row
// is claimed by primary key before the create, and a second create attaches to the same deterministic instance id.
export async function ensure(env, {now = Date.now(), random = Math.random, ports = null} = {}) {
  let mode;
  try { mode = await readMode(env); } catch { return {started: false, reason: 'mode_unreadable'}; }
  if (mode.malformed) return {started: false, reason: 'evidence_unreadable'};
  if (mode.mode === 'switching') return {started: false, reason: 'switch_in_progress'};
  if (mode.mode !== 'cloudflare') return {started: false, reason: 'external'};
  if (mode.quarantine) return {started: false, reason: 'quarantined', scope: 'domain'};
  if (typeof env?.LETTERBOXD_WORKFLOW?.create !== 'function') return {started: false, reason: 'workflow_unavailable'};
  // Delivery and repair first, so a backlog never depends on a new slot being claimable.
  let delivery = await deliverEvents(env, {now}).catch(() => ({delivered: 0, failed: 0, pending: 0}));
  // AIR-571 M1: the independent reconcile of the root watchlist mirror, BEFORE any early return on a finished or running slot. Bounded (one target, one pass), never throws, never gates a scan, the causal effects,
  // the Events or a new slot: its outcome is only reported.
  if (typeof ports?.mirror?.reconcile === 'function') delivery = {...delivery, mirror: await ports.mirror.reconcile(env, {epoch: mode.epoch, now}).catch(() => ({outcome: 'unreadable', reason: 'exception'}))};
  const current = latestDueSlot(now);
  // AIR-571 E: the canary hold. Only the named slot may be claimed; every other slot is neither started nor recorded as missed, until the owner's `open_schedule`.
  const hold = canaryOf(mode.drain);
  if (hold && current.key !== hold) return {started: false, reason: 'canary_hold', canary: hold, slot: current.key, delivery, missed: 0};
  // Under the hold the slots before the canary were never meant to run: they are not recorded as missed (no skipped Events); after `open_schedule` the missed floor is that command's time.
  const missed = hold ? 0 : await recordMissed(env, mode, current, now).catch(() => 0);
  let existing = await readSlot(env, current.key);
  if (existing) {
    if (existing.closedAt) return {started: false, reason: 'complete', slot: current.key, delivery, missed};
    if (existing.epoch !== mode.epoch) return {started: false, reason: 'epoch_mismatch', slot: current.key, delivery, missed};
    const status = await instanceStatus(env.LETTERBOXD_WORKFLOW, existing.instanceId);
    if (ALIVE.includes(status)) return {started: false, reason: 'in_progress', instanceId: existing.instanceId, delivery, missed};
    if (status === 'unknown') return {started: false, reason: 'status_unknown', instanceId: existing.instanceId, delivery, missed};
    // The instance ended with the slot unclosed. A fresh create of the same instance id is a retry only while the slot window and the budget allow it.
    if (status === 'complete' && existing.phase === 'done') return {started: false, reason: 'complete', slot: current.key, delivery, missed};
    return recoverUnclosed(env, mode, existing, current, status, now, random, delivery, missed);
  }
  const claim = await claimSlot(env, current, mode, now).catch(error => ({error}));
  if (claim.error) return {started: false, reason: classifyThrown(claim.error), delivery, missed};
  if (!claim.claimed) return {started: false, reason: 'write_conflict', delivery, missed};
  return createInstance(env, mode, claim.slot, 0, delivery, missed);
}
async function createInstance(env, mode, slot, series, delivery, missed) {
  const id = slotInstanceId(slot.key, series);
  try {
    await env.LETTERBOXD_WORKFLOW.create({id, params: {slotKey: slot.key, series, epoch: mode.epoch}});
    return {started: true, attached: false, instanceId: id, slot: slot.key, series, delivery, missed};
  } catch (error) {
    if (createError(error) === 'exists') return {started: true, attached: true, instanceId: id, slot: slot.key, series, delivery, missed};
    const status = await instanceStatus(env.LETTERBOXD_WORKFLOW, id);
    if (ALIVE.includes(status) || status === 'complete') return {started: true, attached: true, instanceId: id, slot: slot.key, series, delivery, missed};
    return {started: false, reason: 'create_uncertain', instanceId: id, delivery, missed};
  }
}
async function recoverUnclosed(env, mode, slot, current, status, now, random, delivery, missed) {
  const code = status === 'errored' ? 'instance_errored' : status === 'absent' ? 'create_uncertain' : 'instance_terminated';
  const applied = applyFailure(slot.budget, {code}, {now, random});
  const windowLeft = current.windowEndsAt - now - LIMITS.deadlineMarginMs;
  if (applied.quarantine || windowLeft <= 0) {
    // No retry crosses the next slot's due instant: the slot closes as interrupted with an honest outcome for both sources.
    const reason = applied.quarantine ? 'budget_exhausted' : 'window_elapsed';
    const closed = await closeSlot(env, slot, {status: 'interrupted', ratings: slot.ratings.outcome ? {outcome: slot.ratings.outcome, at: slot.ratings.at} : {outcome: 'interrupted', reason}, watchlist: slot.watchlist.outcome ? {outcome: slot.watchlist.outcome, at: slot.watchlist.at, ...(slot.watchlist.summary || {})} : {outcome: 'interrupted', reason}, reconciliation: slot.reconciliation || 'skipped', failureCode: code, epoch: mode.epoch, now});
    return {started: false, reason: 'closed_interrupted', closed: closed.closed, delivery, missed};
  }
  const cooling = Date.parse(slot.cooldownUntil || '');
  if (Number.isFinite(cooling) && cooling > now) return {started: false, reason: 'cooldown', until: slot.cooldownUntil, delivery, missed};
  const series = slot.series + 1;
  const next = await updateSlot(env, slot, mode.epoch, {series, instance_id: slotInstanceId(slot.key, series), status: 'claimed', budget_consecutive: applied.budget.consecutive, budget_total: applied.budget.total, cooldown_until: applied.cooldownUntil, failure_code: code, updated_at: iso(now)}).catch(() => null);
  if (!next) return {started: false, reason: 'write_conflict', delivery, missed};
  return createInstance(env, mode, next, series, delivery, missed);
}
// A slot that no tick ever claimed: `ensure` records it once as skipped_missed (and its two Events) with NO Workflow instance. Only slots whose window has
// fully elapsed, that began after the mode last changed, and at most `missedBack` of them. It is never run late.
async function recordMissed(env, mode, current, now) {
  if (!mode.changedAt) return 0;
  const since = Date.parse(mode.changedAt);
  let recorded = 0, probe = previousSlot(current.key);
  for (let i = 0; i < LIMITS.missedBack; i++, probe = previousSlot(probe.key)) {
    if (!(probe.dueAt >= since)) break;
    if (await readSlot(env, probe.key)) continue;
    const claim = await claimSlot(env, probe, mode, now);
    if (!claim.claimed || !claim.slot) continue;
    const closed = await closeSlot(env, claim.slot, {status: 'skipped_missed', ratings: {outcome: 'skipped_missed', at: iso(now)}, watchlist: {outcome: 'skipped_missed', at: iso(now)}, reconciliation: 'skipped', epoch: mode.epoch, now});
    if (closed.closed) recorded++;
  }
  return recorded;
}

// ---- the Workflow instance -------------------------------------------------------------------------------------------------
// ports.ratings.run(ctx) / ports.watchlist.run(ctx) / ports.reconcile.run(ctx) each perform ONE bounded action and return
//   {done:true, outcome, at, ...details}  or  {done:false, wakeAt?}.  A port that throws yields an `error` outcome for that source only.
const isPort = port => port && typeof port.run === 'function';
async function runPhase(env, port, ctx, name, allowed, step, nameOf) {
  if (!isPort(port)) return {outcome: name === 'reconcile' ? 'skipped' : name === 'watchlist' ? 'disabled' : 'error', at: iso(ctx.now()), reason: 'port_absent'};
  for (let i = 0; i < LIMITS.stepCap; i++) {
    if (ctx.now() >= ctx.deadline) return {outcome: 'interrupted', at: iso(ctx.now()), reason: 'window_elapsed'};
    const result = await step.do(nameOf(name), () => port.run(ctx).catch(error => ({done: true, outcome: 'error', reason: classifyThrown(error)})));
    if (result?.done !== false) {
      const outcome = allowed.includes(result?.outcome) ? result.outcome : 'error';
      return {...result, outcome, at: result?.at || iso(ctx.now())};
    }
    const wake = Number.isFinite(result.wakeAt) ? result.wakeAt : ctx.now() + LIMITS.sleepFloorMs;
    if (wake >= ctx.deadline) return {outcome: 'interrupted', at: iso(ctx.now()), reason: 'window_elapsed'};
    await step.sleepUntil(nameOf(name + '-sleep'), new Date(Math.max(wake, ctx.now() + LIMITS.sleepFloorMs)));
  }
  return {outcome: 'interrupted', at: iso(ctx.now()), reason: 'step_cap'};
}
export async function run(env, payload, step, hooks = {}) {
  const key = typeof payload?.slotKey === 'string' ? payload.slotKey : null, series = Number.isInteger(payload?.series) ? payload.series : 0, epoch = Number.isInteger(payload?.epoch) ? payload.epoch : -1;
  if (!key || !parseSlotKey(key)) return {stopped: true, reason: 'invalid_payload'};
  const now = hooks.now || (() => Date.now()), ports = hooks.ports || {};
  const nextDue = nextSlot(key).dueAt;
  let counter = 0;
  const nameOf = prefix => prefix + '-' + (counter++);
  const entry = await step.do(nameOf('admit'), async () => {
    const adm = await admit(env, {slotKey: key, series, epoch});
    if (!adm.ok) return {ok: false, reason: adm.reason};
    if (adm.slot.closedAt) return {ok: false, reason: 'complete'};
    const moved = await updateSlot(env, adm.slot, epoch, {status: 'running', phase: 'ratings', started_at: adm.slot.startedAt || iso(now()), updated_at: iso(now())}).catch(() => null);
    return moved ? {ok: true, runId: moved.runId || ('lbrun-' + key + '-' + series)} : {ok: false, reason: 'write_conflict'};
  });
  if (!entry.ok) return {stopped: true, reason: entry.reason, slotKey: key};
  const ctx = {slotKey: key, series, epoch, runId: entry.runId, now, clock: hooks.clock || now, deadline: nextDue - LIMITS.deadlineMarginMs, env};
  const advance = fields => step.do(nameOf('mark'), async () => {
    const adm = await admit(env, {slotKey: key, series, epoch});
    if (!adm.ok || adm.slot.closedAt) return {ok: false, reason: adm.reason || 'complete'};
    return {ok: !!await updateSlot(env, adm.slot, epoch, {...fields, run_id: entry.runId, updated_at: iso(now())}).catch(() => null)};
  });
  // Phase 1. A failure here never blocks phase 2 (T7).
  const ratings = await runPhase(env, ports.ratings, ctx, 'ratings', RATINGS_OUTCOMES, step, nameOf);
  await advance({phase: 'watchlist', ratings_outcome: ratings.outcome, ratings_at: ratings.at});
  // Phase 2. Attempted once per run; a Diary failure or rate limit does not cancel it, and its failure does not undo phase 1 (T8).
  const watchlist = await runPhase(env, ports.watchlist, ctx, 'watchlist', WATCHLIST_OUTCOMES, step, nameOf);
  await advance({phase: 'reconciliation', watchlist_outcome: watchlist.outcome, watchlist_at: watchlist.at});
  // Between the scan and the reconciliation: the causal effects of the snapshot this run just promoted are applied NOW, so the films it removed are in the Ratings queue before phase 3 looks them up (the accepted
  // sequence). Best effort and bounded: an effect that cannot be applied stays pending and is retried by the next run; it never fails the slot.
  if (isPort(ports.watchlist) && typeof ports.watchlist.afterRecorded === 'function' && watchlist.outcome === 'committed') {
    await step.do(nameOf('effects'), () => ports.watchlist.afterRecorded(ctx).catch(() => ({drained: false}))).catch(() => null);
  }
  // Phase 3. Operational only: it never changes an Event outcome and never creates a third Event.
  const reconcile = await runPhase(env, ports.reconcile, ctx, 'reconcile', ['done', 'deferred', 'error', 'skipped'], step, nameOf);
  // The AIR-361 contract is complete only when the run ended, which phase 3 does; either phase may hand it over.
  // An interruption the reconciliation phase met (its own run record, or a lost lease in the removal phase) travels beside the Ratings outcome; it never changes a finished Diary outcome and never adds a third Event.
  const ratingsFinal = {...ratings, event: ratings.event || reconcile.event || null, ...(reconcile.interrupted && ratings.outcome !== 'interrupted' ? {interruption: reconcile.interrupted} : {})};
  const closed = await step.do(nameOf('close'), async () => {
    const adm = await admit(env, {slotKey: key, series, epoch});
    if (!adm.ok) return {closed: false, reason: adm.reason};
    if (adm.slot.closedAt) return {closed: true, again: true};
    const status = [ratings.outcome, watchlist.outcome].includes('interrupted') ? 'interrupted' : (ratings.outcome === 'error' && ['error', 'unavailable'].includes(watchlist.outcome)) ? 'error' : 'finished';
    const result = await closeSlot(env, adm.slot, {status, ratings: ratingsFinal, watchlist, reconciliation: ['done', 'deferred', 'error', 'skipped'].includes(reconcile.outcome) ? reconcile.outcome : 'deferred', epoch, now: now()}).catch(error => ({closed: false, reason: classifyThrown(error)}));
    return {closed: result.closed === true, status, reason: result.reason};
  });
  // Delivery follows the close but never gates it: a pending Event is delivered by this call, by a later run or by `ensure`.
  await step.do(nameOf('deliver'), () => deliverEvents(env, {now: now()}).catch(() => ({delivered: 0, failed: 0, pending: 0})));
  return {stopped: !closed.closed, reason: closed.closed ? 'complete' : closed.reason, slotKey: key, status: closed.status};
}

// ---- the read model (reads only; never creates or repairs) --------------------------------------------------------------------
export async function readModel(env, {now = Date.now(), watchlistLastSuccessAt = null, ratingsLastSuccessAt = null} = {}) {
  let mode;
  try { mode = await readMode(env); } catch (error) { return {mode: null, health: 'unreadable', failure: {code: classifyThrown(error)}, sideEffects: 'none'}; }
  if (mode.malformed) return {mode: null, health: 'quarantined', failure: {code: 'evidence_unreadable'}, sideEffects: 'none'};
  const current = latestDueSlot(now);
  const slots = await recentSlots(env, 8).catch(() => []);
  const byKey = new Map(slots.map(slot => [slot.key, slot]));
  const slot = byKey.get(current.key) || null;
  const lastClosed = slots.find(item => item.closedAt) || null;
  const lastSuccess = type => (slots.filter(item => item.closedAt && (type === 'ratings' ? ['finished', 'noop'].includes(item.ratings.outcome) : ['committed', 'no_change'].includes(item.watchlist.outcome))).map(item => type === 'ratings' ? item.ratings.at : item.watchlist.at).sort().pop()) || null;
  // No success at all is stale once the executor has been active for the freshness bound (never-success must not hide).
  const activeFor = mode.mode === 'cloudflare' && mode.changedAt ? now - Date.parse(mode.changedAt) : 0;
  const stale = ts => ts ? now - Date.parse(ts) > LIMITS.watchlistStaleMs : activeFor > LIMITS.watchlistStaleMs;
  const lwl = watchlistLastSuccessAt || lastSuccess('watchlist'), lrt = ratingsLastSuccessAt || lastSuccess('ratings');
  const missedRecent = slots.filter(item => item.status === 'skipped_missed').length;
  // An earlier slot still unclosed after ITS window ended is invisible behind the newer slot: look at every recent slot, not only the current one.
  const overdue = slots.filter(item => !item.closedAt && item.key !== current.key && nextSlot(item.key).dueAt <= now).map(item => item.key);
  let health = 'external';
  if (mode.mode === 'cloudflare') {
    if (mode.quarantine) health = 'quarantined';
    else if (overdue.length || (slot && !slot.closedAt && now > current.windowEndsAt)) health = 'stalled';
    else if (!slot && now - current.dueAt > LIMITS.startupGraceMs) health = 'late';
    else if (lastClosed && lastClosed.status === 'error') health = 'failed';
    else if (missedRecent) health = 'missed';
    else health = slot?.closedAt ? 'healthy' : 'waiting';
  } else if (mode.mode === 'switching') health = 'switching';
  // AIR-571 M1: the root mirror's own health (`mirror_stale` is independent of the slot health). Read only; a failed read is reported as unreadable.
  const mirror = await first(env, 'SELECT snapshot_id, last_success_at, mirror_delivered_snapshot_id, mirror_attempts, mirror_next_retry_at FROM watchlist_current WHERE id = 1').then(row => {
    if (!row || !row.snapshot_id || !row.last_success_at) return {state: 'none', stale: false};
    const target = row.snapshot_id + '|' + row.last_success_at;
    const owed = row.mirror_delivered_snapshot_id !== target;
    const stale = owed && (now - Date.parse(row.last_success_at) > LIMITS.mirrorStaleMs || row.mirror_attempts >= LIMITS.mirrorStaleAttempts);
    return {state: owed ? (stale ? 'stale' : 'owed') : 'delivered', stale, attempts: row.mirror_attempts, nextRetryAt: row.mirror_next_retry_at ?? null, warning: stale ? 'mirror_stale' : null};
  }).catch(error => (error?.code === 'schema_absent' ? null : {state: 'unreadable', stale: false}));
  const pendingEvents = await first(env, "SELECT COUNT(*) AS n FROM letterboxd_slot_event WHERE status = 'pending'").then(row => row?.n ?? 0).catch(() => null);
  return {
    mode: mode.mode, epoch: mode.epoch, ...(mode.mode === 'switching' ? {target: mode.target, drain: mode.drain} : {}),
    slot: {key: current.key, dueAt: iso(current.dueAt), windowEndsAt: iso(current.windowEndsAt), status: slot?.status ?? null, phase: slot?.phase ?? null, instanceId: slot?.instanceId ?? null, closedAt: slot?.closedAt ?? null},
    nextSlot: {key: nextSlot(current.key).key, dueAt: iso(nextSlot(current.key).dueAt)},
    sources: {
      ratings: {lastSuccessAt: lrt, lastOutcome: lastClosed?.ratings.outcome ?? null},
      watchlist: {lastSuccessAt: lwl, lastOutcome: lastClosed?.watchlist.outcome ?? null, stale: !!stale(lwl), warning: stale(lwl) ? (lwl ? 'watchlist_stale' : 'watchlist_never_succeeded') : null}
    },
    reconciliation: {lastOutcome: lastClosed?.reconciliation ?? null},
    mirror,
    recent: slots.map(item => ({key: item.key, status: item.status, ratings: item.ratings.outcome, watchlist: item.watchlist.outcome, reconciliation: item.reconciliation, closedAt: item.closedAt})),
    eventsPending: pendingEvents, missedRecent, overdueSlots: overdue, quarantine: mode.quarantine, health, sideEffects: 'none'
  };
}

// The owner route takes a command with an explicit confirmation (the action name) and the pins of the row it read. The pins are mandatory here.
const pinCheck = v => Number.isInteger(v) && v >= 0 && v <= 2147483647;
export const ACTIONS = {
  close_admission: {target: v => v === 'cloudflare' || v === 'external', confirm: v => v === 'close_admission', expectEpoch: pinCheck, expectRevision: pinCheck},
  complete: {confirm: v => v === 'complete', slot: v => typeof v === 'string' && !!parseSlotKey(v), expectEpoch: pinCheck, expectRevision: pinCheck},
  abort: {confirm: v => v === 'abort', expectEpoch: pinCheck, expectRevision: pinCheck},
  drain: {confirm: v => v === 'drain', expectEpoch: pinCheck, expectRevision: pinCheck},
  resume: {confirm: v => v === 'resume', expectEpoch: pinCheck, expectRevision: pinCheck},
  canary: {confirm: v => v === 'canary', slot: v => typeof v === 'string' && !!parseSlotKey(v), expectEpoch: pinCheck, expectRevision: pinCheck},
  open_schedule: {confirm: v => v === 'open_schedule', expectEpoch: pinCheck, expectRevision: pinCheck},
  clear_quarantine: {confirm: v => v === 'clear_quarantine'}
};
const REQUIRED = {close_admission: ['target', 'confirm', 'expectEpoch', 'expectRevision'], complete: ['confirm', 'expectEpoch', 'expectRevision'], abort: ['confirm', 'expectEpoch', 'expectRevision'], drain: ['confirm', 'expectEpoch', 'expectRevision'], resume: ['confirm', 'expectEpoch', 'expectRevision'], canary: ['confirm', 'slot', 'expectEpoch', 'expectRevision'], open_schedule: ['confirm', 'expectEpoch', 'expectRevision'], clear_quarantine: ['confirm']};
export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid request';
  const fields = ACTIONS[body.action];
  if (!fields) return 'Unknown action';
  for (const key of Object.keys(body)) if (key !== 'action' && !Object.hasOwn(fields, key)) return 'Unknown field';
  for (const key of REQUIRED[body.action]) if (body[key] === undefined) return 'Missing ' + key;
  for (const [key, check] of Object.entries(fields)) if (body[key] !== undefined && !check(body[key])) return 'Invalid ' + key;
  return null;
}
export async function handle(env, body, ports = {}) {
  const error = validate(body);
  if (error) return {status: 400, body: {error}};
  try {
    if (body.action === 'clear_quarantine') return {status: 200, body: await clearQuarantine(env)};
    // The owner route is fail-closed: every return to `cloudflare` ends in a canary hold, never in the full schedule.
    return {status: 200, body: await switchMode(env, body, {...ports, requireCanary: true})};
  } catch (thrown) { return {status: 200, body: {action: body.action, refused: classifyThrown(thrown)}}; }
}
