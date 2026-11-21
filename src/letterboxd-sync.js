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
export const LIMITS = {stepCap: 200, sleepFloorMs: 1000, deadlineMarginMs: 5 * 60000, startupGraceMs: 15 * 60000, eventBatch: 4, eventAttempts: 12, missedBack: 4, watchlistStaleMs: 24 * 3600000, controlAttempts: 4};
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
export const fencedEnv = (env, epoch) => ({...env, ratingsFence: {guard: [FENCE_GUARD_SQL, [epoch]], hard: true}, producerFence: {kind: 'letterboxd', epoch}});
const fenceGuard = (env, epoch) => dbOf(env).prepare(FENCE_GUARD_SQL).bind(epoch);

const emptyMode = () => ({mode: 'external', target: null, from: null, epoch: 0, drain: null, quarantine: null, changedAt: null, revision: 0, writeId: null, stored: false});
export async function readMode(env) {
  let row;
  try { row = await first(env, 'SELECT mode, target, from_mode, epoch, drain, quarantine_reason, quarantined_at, changed_at, revision, write_id FROM letterboxd_sync_mode WHERE id = 1'); }
  catch (error) { if (error.code === 'schema_absent') return emptyMode(); throw error; }
  if (!row) return emptyMode();
  if (!MODES.includes(row.mode) || !Number.isInteger(row.epoch)) return {...emptyMode(), malformed: true};
  return {mode: row.mode, target: row.target, from: row.from_mode, epoch: row.epoch, drain: row.drain, quarantine: row.quarantine_reason ? {reason: row.quarantine_reason, at: row.quarantined_at} : null, changedAt: row.changed_at, revision: row.revision, writeId: row.write_id, stored: true};
}
async function writeMode(env, expected, next) {
  const writeId = uuid();
  const db = dbOf(env);
  const quarantine = next.quarantine || {};
  const binds = [next.mode, next.target ?? null, next.from ?? null, next.epoch, next.drain ?? null, quarantine.reason ?? null, quarantine.at ?? null, next.changedAt, writeId];
  const statement = expected.stored
    ? db.prepare('UPDATE letterboxd_sync_mode SET mode = ?, target = ?, from_mode = ?, epoch = ?, drain = ?, quarantine_reason = ?, quarantined_at = ?, changed_at = ?, revision = revision + 1, write_id = ? WHERE id = 1 AND revision = ?').bind(...binds, expected.revision)
    : db.prepare('INSERT INTO letterboxd_sync_mode (id, mode, target, from_mode, epoch, drain, quarantine_reason, quarantined_at, changed_at, revision, write_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').bind(...binds);
  try { await batch(env, [statement]); } catch (error) { if (error.code !== 'write_contention') throw error; return false; }
  const after = await readMode(env);
  return after.writeId === writeId;
}

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
const RATINGS_CONTRACT = ['runId', 'trigger', 'state', 'cause', 'coverage', 'diary', 'removal', 'details'];
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
  const added = filmsOf(watchlist?.added), removed = filmsOf(watchlist?.removed);
  const addedCount = watchlist?.addedCount ?? (watchlist?.added?.length ?? 0), removedCount = watchlist?.removedCount ?? (watchlist?.removed?.length ?? 0);
  return {
    ratings: {at: ratingsAt, payload: fitPayload({type: 'ratings', slot: slot.key, status: RATINGS_STATUS[rOutcome] || 'error', outcome: rOutcome, at: ratingsAt, ...contract, runId: contract.runId ?? slot.runId ?? null, counts: bounded(ratings?.counts ?? null), reason: ratings?.reason ? String(ratings.reason).slice(0, 60) : null})},
    watchlist: {at: watchlistAt, payload: fitPayload({type: 'watchlist', slot: slot.key, status: WATCHLIST_STATUS[wOutcome] || 'error', outcome: wOutcome, at: watchlistAt, snapshotVersion: watchlist?.snapshotVersion ?? null, lastSuccessAt: watchlist?.lastSuccessAt ?? null, total: watchlist?.total ?? null, baseline: watchlist?.baseline === true, added, removed, addedCount, removedCount, reason: watchlist?.reason ? String(watchlist.reason).slice(0, 60) : null})}
  };
}

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
    .bind(status, ratings?.outcome || 'error', payloads.ratings.at, watchlist?.outcome || 'error', payloads.watchlist.at, JSON.stringify(bounded({snapshotVersion: watchlist?.snapshotVersion ?? null, lastSuccessAt: watchlist?.lastSuccessAt ?? null, addedCount: payloads.watchlist.payload.addedCount, removedCount: payloads.watchlist.payload.removedCount, total: watchlist?.total ?? null})), reconciliation, failureCode, closedAt, closedAt, writeId, slot.key, slot.revision));
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
export async function switchMode(env, {action, target} = {}, ports = {}, now = Date.now()) {
  for (let attempt = 0; attempt < LIMITS.controlAttempts; attempt++) {
    const mode = await readMode(env);
    if (mode.malformed) return {action, refused: 'evidence_unreadable'};
    if (action === 'close_admission') {
      if (mode.mode === 'switching') return {action, refused: 'switch_open', mode: mode.mode, target: mode.target, epoch: mode.epoch};
      if (mode.mode === target) return {action, refused: 'already_in_mode', mode: mode.mode, epoch: mode.epoch};
      if (!['external', 'cloudflare'].includes(target)) return {action, refused: 'invalid_target'};
      const next = {mode: 'switching', from: mode.mode, target, epoch: mode.epoch + 1, drain: null, changedAt: iso(now), quarantine: mode.quarantine};
      if (await writeMode(env, mode, next)) return {action, closed: true, mode: 'switching', target, epoch: next.epoch};
      continue;
    }
    if (action === 'complete') {
      if (mode.mode !== 'switching') return {action, refused: 'not_switching', mode: mode.mode, epoch: mode.epoch};
      const drain = await drainState(env);
      if (drain !== 'verified') {
        if (mode.drain !== drain) await writeMode(env, mode, {...mode, drain, changedAt: mode.changedAt});
        return {action, refused: 'drain_not_verified', drain, mode: 'switching', target: mode.target, epoch: mode.epoch};
      }
      if (mode.target === 'cloudflare') {
        const handover = await handoverState(env, ports);
        const missing = ['ratingsClosed', 'ratingsDrained', 'legacyFenced', 'watchlistRepository', 'ratingsPhase'].filter(name => handover[name] !== true);
        if (handover.error || missing.length) return {action, refused: 'handover_not_proven', missing: handover.error ? ['unreadable'] : missing, mode: 'switching', target: mode.target, epoch: mode.epoch};
      }
      const next = {mode: mode.target, from: mode.from, target: null, epoch: mode.epoch, drain: 'verified', changedAt: iso(now), quarantine: mode.quarantine};
      if (await writeMode(env, mode, next)) return {action, completed: true, mode: next.mode, epoch: next.epoch, drain: 'verified'};
      continue;
    }
    return {action, refused: 'unknown_action'};
  }
  return {action, refused: 'write_contention'};
}
export async function clearQuarantine(env, now = Date.now()) {
  const mode = await readMode(env);
  if (mode.malformed) return {action: 'clear_quarantine', refused: 'evidence_unreadable'};
  if (mode.mode === 'switching') return {action: 'clear_quarantine', refused: 'switch_in_progress'};
  if (!mode.quarantine) return {action: 'clear_quarantine', cleared: false};
  const ok = await writeMode(env, mode, {...mode, quarantine: null, changedAt: iso(now)});
  return ok ? {action: 'clear_quarantine', cleared: true} : {action: 'clear_quarantine', refused: 'write_contention'};
}
// The legacy ratings entry points ask this: is the Letterboxd Sync the (future) Diary writer? `cloudflare` and `switching` fence them.
export async function writerFence(env) {
  if (!dbOf(env)) return {fenced: false, reason: null};
  let mode;
  try { mode = await readMode(env); } catch (error) { return error.code === 'schema_absent' ? {fenced: false, reason: null} : {fenced: true, reason: 'evidence_unreadable'}; }
  if (mode.malformed) return {fenced: true, reason: 'evidence_unreadable'};
  if (mode.mode === 'switching') return {fenced: true, reason: 'letterboxd_switch_in_progress'};
  if (mode.mode === 'cloudflare') return {fenced: true, reason: 'letterboxd_sync_active'};
  return {fenced: false, reason: null};
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
export async function ensure(env, {now = Date.now(), random = Math.random} = {}) {
  let mode;
  try { mode = await readMode(env); } catch { return {started: false, reason: 'mode_unreadable'}; }
  if (mode.malformed) return {started: false, reason: 'evidence_unreadable'};
  if (mode.mode === 'switching') return {started: false, reason: 'switch_in_progress'};
  if (mode.mode !== 'cloudflare') return {started: false, reason: 'external'};
  if (mode.quarantine) return {started: false, reason: 'quarantined', scope: 'domain'};
  if (typeof env?.LETTERBOXD_WORKFLOW?.create !== 'function') return {started: false, reason: 'workflow_unavailable'};
  // Delivery and repair first, so a backlog never depends on a new slot being claimable.
  const delivery = await deliverEvents(env, {now}).catch(() => ({delivered: 0, failed: 0, pending: 0}));
  const current = latestDueSlot(now);
  const missed = await recordMissed(env, mode, current, now).catch(() => 0);
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
  const ratingsFinal = {...ratings, event: ratings.event || reconcile.event || null};
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
    recent: slots.map(item => ({key: item.key, status: item.status, ratings: item.ratings.outcome, watchlist: item.watchlist.outcome, reconciliation: item.reconciliation, closedAt: item.closedAt})),
    eventsPending: pendingEvents, missedRecent, overdueSlots: overdue, quarantine: mode.quarantine, health, sideEffects: 'none'
  };
}

export const ACTIONS = {close_admission: {target: v => v === 'cloudflare' || v === 'external'}, complete: {}, clear_quarantine: {}};
export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid request';
  const fields = ACTIONS[body.action];
  if (!fields) return 'Unknown action';
  for (const key of Object.keys(body)) if (key !== 'action' && !Object.hasOwn(fields, key)) return 'Unknown field';
  if (body.action === 'close_admission' && body.target === undefined) return 'Missing target';
  for (const [key, check] of Object.entries(fields)) if (body[key] !== undefined && !check(body[key])) return 'Invalid ' + key;
  return null;
}
export async function handle(env, body, ports = {}) {
  const error = validate(body);
  if (error) return {status: 400, body: {error}};
  try {
    if (body.action === 'clear_quarantine') return {status: 200, body: await clearQuarantine(env)};
    return {status: 200, body: await switchMode(env, body, ports)};
  } catch (thrown) { return {status: 200, body: {action: body.action, refused: classifyThrown(thrown)}}; }
}
