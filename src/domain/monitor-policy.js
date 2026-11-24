// AIR-349. The pure part of the Cloudflare-native monitor: what the observed facts of the four streams (EPG, Discovery,
// Ratings, prediction queue) mean as a health state, and which of the resulting issues may reach the owner. No I/O, no clock
// and no randomness of its own: callers pass the time, and the Madrid schedule helper for the daily EPG expectation.
// The monitor only diagnoses and reports. Recovery belongs to the domain executors (ADR 0089).

export const STATES = Object.freeze(['healthy', 'waiting', 'delayed', 'degraded', 'needs_owner']);
export const STATE_RANK = Object.freeze({healthy: 0, waiting: 1, delayed: 2, degraded: 3, needs_owner: 4});
const MIN = 60000, HOUR = 3600000;

export const EPG_SCHEDULE = Object.freeze({hour: 17, minute: 0});
export const THRESHOLDS = Object.freeze({
  epgDelayedAfterMs: 2 * HOUR,        // after the Madrid due time with no new publication: delayed, no alert
  epgDegradedAfterMs: 5 * HOUR,       // then degraded: an actionable alert
  discoveryWaitingMs: 90 * MIN,       // past the allowed next progress: still waiting by design
  discoveryDegradedMs: 3 * HOUR,      // backlog without allowed progress for this long: degraded
  // Predictions have no threshold here: the one no-progress limit (60 minutes) lives in enrichment.js beside the Footer's use of it, and the monitor
  // passes its verdict in `facts.stall` (AIR-556), so the two surfaces cannot disagree.
  switchStuckMs: 2 * HOUR,            // a mode switch that stays open
  producerNoProgressMs: 2 * HOUR,     // AIR-572: the canonical Producer has no DURABLE progress for this long after publication or its last progress
  producerClockFreshMs: 90 * MIN,     // AIR-593: a reader trusts the Monitor's stored Producer clock for this long (hourly tick + slack); must stay below producerNoProgressMs
});
export const ALERT_POLICY = Object.freeze({
  confirmSnapshots: 2,                // degraded issues alert after this many consecutive snapshots; needs_owner at once
  // AIR-556: the prediction no-progress verdict is computed from stored run times, not from a transient read, so one snapshot confirms it. With
  // the 60-minute limit and the hourly Cron tick the alert follows the last confirmed progress by 60 to about 120 minutes (+ cron/Telegram latency).
  // AIR-572: both Producer verdicts come from stored durable facts (run counters, chain state), so one snapshot confirms them.
  confirmSnapshotsByKey: Object.freeze({predictions_no_progress: 1, canonical_producer_no_progress: 1, canonical_producer_failed: 1}),
  cooldownMs: Object.freeze({degraded: 6 * HOUR, needs_owner: 2 * HOUR}),
  maxPerIssuePerDay: 8,
});
const RESOURCE_CODES = ['exceeded_memory', 'exceeded_cpu', 'worker_1102'];

const issue = (key, severity, stream, message, extra = {}) => ({key, severity, stream, message, ...extra});
const worst = issues => issues.reduce((state, item) => STATE_RANK[item.severity] > STATE_RANK[state] ? item.severity : state, 'healthy');
const time = value => { const ms = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(ms) ? ms : null; };
const hours = ms => Math.max(0, Math.round(ms / HOUR * 10) / 10);
const unreadable = (stream, key) => ({stream, state: 'degraded', issues: [issue(stream + '_unreadable', 'degraded', stream, 'The ' + key + ' status could not be read')], facts: {readable: false}});

// ---- EPG: a fresh published generation after each Madrid 17:00, judged by the stored result, not by the Task trigger.
export function evaluateEpg(facts, now, {dailyDue}) {
  if (!facts || facts.error) return unreadable('epg', 'EPG');
  const issues = [];
  if (facts.authority === 'held' || facts.authority === 'unreadable') issues.push(issue('epg_authority', 'needs_owner', 'epg', 'The published EPG authority is ' + facts.authority));
  const today = dailyDue(now, EPG_SCHEDULE);
  const latest = today.due ? today : dailyDue(today.dueAt - 24 * HOUR, EPG_SCHEDULE); // 24 h back stays on the previous Madrid date across DST
  const publishedAt = time(facts.publishedAt);
  const publishedSince = publishedAt !== null && publishedAt >= latest.dueAt - HOUR;
  const late = now - latest.dueAt;
  let state = 'healthy';
  if (!publishedSince) {
    if (late < THRESHOLDS.epgDelayedAfterMs) state = 'waiting';
    else if (late < THRESHOLDS.epgDegradedAfterMs) state = 'delayed';
    else {
      state = 'degraded';
      issues.push(issue(facts.runError ? 'epg_failed' : 'epg_stale', 'degraded', 'epg', 'No EPG generation published since ' + hours(late) + ' hours after the Madrid due time' + (facts.runError ? '; the last run recorded an error' : '')));
    }
    if (state === 'delayed') issues.push(issue('epg_delayed', 'delayed', 'epg', 'EPG is ' + hours(late) + ' hours past its due time'));
  }
  if (facts.resourceLimit) issues.push(issue('epg_resource_limit', 'degraded', 'epg', 'The EPG run recorded a Worker resource limit'));
  return {stream: 'epg', state: STATE_RANK[worst(issues)] > STATE_RANK[state] ? worst(issues) : state, issues, facts: {publishedAt: publishedAt === null ? null : new Date(publishedAt).toISOString(), dueAt: new Date(latest.dueAt).toISOString(), publishedSinceDue: publishedSince}};
}

// ---- Discovery: a backlog needs progress that is allowed by its own backoff; waiting by design is not an incident.
export function evaluateDiscovery(facts, now) {
  if (!facts || facts.error) return unreadable('discovery', 'Discovery');
  const issues = [];
  if (facts.readout?.quarantined) issues.push(issue('discovery_quarantined', 'needs_owner', 'discovery', 'The Discovery executor retry budget is exhausted and the run is quarantined'));
  const record = facts.continuation || null;
  const backlog = !!record && (record.remainingChunks > 0 || record.stage === 'running' || record.reason === 'chunk_budget');
  let state = 'healthy';
  if (backlog) {
    const allowedAt = Math.max(time(record.nextCatchUpAt) ?? 0, time(record.retryAt) ?? 0);
    const lastProgress = Math.max(time(facts.lastChunkFinishedAt) ?? 0, time(record.at) ?? 0);
    const overdue = allowedAt ? now - allowedAt : 0;
    const idle = lastProgress ? now - lastProgress : null;
    if (allowedAt && allowedAt > now) state = 'waiting';
    else if (overdue < THRESHOLDS.discoveryWaitingMs && (idle === null || idle < THRESHOLDS.discoveryDegradedMs)) state = overdue > 0 ? 'waiting' : 'healthy';
    else if (overdue < THRESHOLDS.discoveryDegradedMs && (idle === null || idle < THRESHOLDS.discoveryDegradedMs)) state = 'delayed';
    else {
      state = 'degraded';
      issues.push(issue('discovery_stalled', 'degraded', 'discovery', 'Discovery backlog (' + (record.remainingChunks ?? '?') + ' chunks) has had no allowed progress for ' + hours(Math.max(overdue, idle ?? 0)) + ' hours'));
    }
    if (facts.health === 'orphaned' && state !== 'degraded' && idle !== null && idle >= THRESHOLDS.discoveryWaitingMs) state = 'delayed';
    if (facts.readout?.stalled && state !== 'degraded') { state = 'degraded'; issues.push(issue('discovery_executor_stalled', 'degraded', 'discovery', 'The Discovery Workflow instance is stalled')); }
    if (facts.publishedRunId && record.programmeRunId && facts.publishedRunId !== record.programmeRunId && state === 'degraded') issues.push(issue('discovery_generation_mismatch', 'degraded', 'discovery', 'The continuation belongs to another generation than the published one'));
  }
  if (facts.resourceLimit) issues.push(issue('discovery_resource_limit', 'degraded', 'discovery', 'Discovery recorded a Worker resource limit'));
  const all = worst(issues);
  return {stream: 'discovery', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {executor: facts.executor ?? null, backlog, remainingChunks: record?.remainingChunks ?? null}};
}

// ---- Ratings: the orchestration read model already derives health from the run record and the Madrid 17:00 schedule.
export function evaluateRatings(model, now) {
  if (!model || model.error) return unreadable('ratings', 'Ratings');
  const issues = [];
  const health = model.health;
  let state = 'healthy';
  if (health === 'waiting' || health === 'cooldown') state = 'waiting';
  else if (health === 'stalled') { state = 'degraded'; issues.push(issue('ratings_stalled', 'degraded', 'ratings', 'No completed Ratings day and no durable progress since two hours after the due time')); }
  else if (health === 'quarantined') { state = 'needs_owner'; issues.push(issue('ratings_quarantined', 'needs_owner', 'ratings', 'The Ratings run is quarantined' + (model.quarantine?.reason ? ' (' + model.quarantine.reason + ')' : ''))); }
  else if (health === 'failed_permanent') { state = 'needs_owner'; issues.push(issue('ratings_failed_permanent', 'needs_owner', 'ratings', 'The Ratings run failed with a permanent error')); }
  else if (health === 'unknown') { state = 'degraded'; issues.push(issue('ratings_unreadable', 'degraded', 'ratings', 'The Ratings read model could not be read')); }
  if (model.mode === 'switching') {
    const since = time(model.updatedAt || model.switchedAt);
    if (since !== null && now - since > THRESHOLDS.switchStuckMs) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('ratings_switch_open', 'degraded', 'ratings', 'The Ratings mode switch has stayed open')); }
    else if (STATE_RANK[state] < STATE_RANK.waiting) state = 'waiting';
  }
  if (RESOURCE_CODES.includes(model.failure?.code) && (model.failure?.consecutive ?? 0) >= 2) issues.push(issue('ratings_resource_limit', 'degraded', 'ratings', 'Ratings recorded repeated Worker resource limits'));
  const all = worst(issues);
  return {stream: 'ratings', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {mode: model.mode ?? null, health: health ?? null}};
}

// ---- Letterboxd Sync (ADR 0186): the slot read model derives health; the stream exists only while the executor is `switching` or `cloudflare` (facts are supplied by the monitor then), so a dormant
// executor adds nothing. A slot or Watchlist problem is actionable; a pending Event backlog is actionable only when it has grown past one day of slots.
export function evaluateLetterboxd(model, now) {
  if (!model || model.error) return unreadable('letterboxd', 'Letterboxd Sync');
  const issues = [];
  const health = model.health;
  let state = 'healthy';
  if (health === 'waiting' || health === 'switching') state = 'waiting';
  else if (health === 'late') { state = 'degraded'; issues.push(issue('letterboxd_slot_late', 'degraded', 'letterboxd', 'A Letterboxd slot is due and no run was started')); }
  else if (health === 'stalled') { state = 'degraded'; issues.push(issue('letterboxd_slot_stalled', 'degraded', 'letterboxd', 'A Letterboxd slot stayed open after its window ended')); }
  else if (health === 'missed') { state = 'degraded'; issues.push(issue('letterboxd_slot_missed', 'degraded', 'letterboxd', 'A Letterboxd slot was missed and recorded without a run')); }
  else if (health === 'failed') { state = 'degraded'; issues.push(issue('letterboxd_slots_failed', 'degraded', 'letterboxd', 'The last Letterboxd slot failed for both sources')); }
  else if (health === 'quarantined') { state = 'needs_owner'; issues.push(issue('letterboxd_quarantined', 'needs_owner', 'letterboxd', 'Letterboxd Sync is quarantined' + (model.quarantine?.reason ? ' (' + model.quarantine.reason + ')' : ''))); }
  else if (health === 'unreadable') { state = 'degraded'; issues.push(issue('letterboxd_unreadable', 'degraded', 'letterboxd', 'The Letterboxd Sync read model could not be read')); }
  if (model.sources?.watchlist?.stale) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_watchlist_stale', 'degraded', 'letterboxd', model.sources.watchlist.warning === 'watchlist_never_succeeded' ? 'No complete Watchlist scan has succeeded since the executor started' : 'No complete Watchlist scan has succeeded for 24 hours')); }
  // Each source has its own signal: one update can fail while the other succeeds (the approved contract), and neither outcome hides or rewrites the other's confirmed success. A rate limit is "not now" and never alerts.
  const sourceIssue = (key, label, outcome) => {
    if (['error', 'blocked', 'interrupted', 'unavailable', 'incomplete', 'disabled'].includes(outcome)) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue(key + '_failed', 'degraded', 'letterboxd', 'The last Letterboxd slot did not update ' + label + ' (' + outcome + ')')); }
    else if (outcome === 'rate_limited') { if (STATE_RANK[state] < STATE_RANK.delayed) state = 'delayed'; issues.push(issue(key + '_rate_limited', 'delayed', 'letterboxd', label + ' was rate limited in the last Letterboxd slot')); }
  };
  if (health !== 'failed') { sourceIssue('letterboxd_ratings', 'Ratings', model.sources?.ratings?.lastOutcome); sourceIssue('letterboxd_watchlist', 'the Watchlist', model.sources?.watchlist?.lastOutcome); }
  if (Number.isInteger(model.eventsPending) && model.eventsPending >= 8) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_events_backlog', 'degraded', 'letterboxd', 'Letterboxd slot Events are waiting for delivery')); }
  const all = worst(issues);
  return {stream: 'letterboxd', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {mode: model.mode ?? null, health: health ?? null, slot: model.slot?.key ?? null, eventsPending: model.eventsPending ?? null}};
}

// ---- Prediction queue (AIR-556): an empty or fully deferred queue is healthy or waiting; eligible work with no confirmed progress is not.
// `facts.stall` is the verdict of the one shared assessment in enrichment.js (`predictionStallAssessment`): running | ok | idle | waiting | unknown | no_progress.
// Confirmed progress is a productive batch or a drained run, never a heartbeat, `already_running`, a noop wake-up or a queue recount. The monitor does
// not know why a Task did not reach the Worker, so no message names api_error, an expired authorization or a number of missed Tasks.
// AIR-596 (ADR 0210): `previous.noProgressOpenSince` is the first-seen time of an open `predictions_no_progress` incident. While it is open, a tick that cannot
// read or decide the verdict (unreadable or absent queue, unknown split, a run with no progress evidence) keeps the incident open instead of recovering it; it
// recovers only on confirmed progress or a proven absence of eligible work, and `facts.recovery` names which.
const predictionHold = (openSince, why, last) => issue('predictions_no_progress', 'degraded', 'predictions', 'The prediction no-progress incident open since ' + new Date(openSince).toISOString() + ' cannot be confirmed or cleared now (' + why + '); it stays open until confirmed progress or no eligible work is proven' + (last === null ? '' : ' (last confirmed progress ' + new Date(last).toISOString() + ')'));
export function evaluatePredictions(facts, previous, now) {
  const openSince = time(previous?.noProgressOpenSince);
  if (!facts || facts.error) {
    const out = unreadable('predictions', 'prediction queue');
    if (openSince !== null) out.issues.push(predictionHold(openSince, 'the prediction queue could not be read', time(previous?.progressAt)));
    return out;
  }
  if (!facts.present) {
    if (openSince !== null) return {stream: 'predictions', state: 'degraded', issues: [predictionHold(openSince, 'the prediction queue is absent', time(previous?.progressAt))], facts: {present: false, held: true}};
    return {stream: 'predictions', state: 'waiting', issues: [], facts: {present: false}};
  }
  const issues = [];
  const pending = Number.isInteger(facts.pendingCount) ? facts.pendingCount : 0;
  const eligible = Number.isInteger(facts.eligibleNow) ? facts.eligibleNow : null;
  const stall = facts.stall && typeof facts.stall === 'object' ? facts.stall : {state: 'unknown', reason: 'queue_unreadable', idleMs: null};
  const why = facts.blockedReason === 'quota' ? ' (the last batch reported a quota limit)' : '';
  const last = time(facts.lastProgressAt);
  let state = 'healthy', recovery = null;
  if (pending > 0 || eligible > 0) {
    if (stall.state === 'no_progress') {
      state = 'degraded';
      const orphans = Number.isInteger(stall.orphanStarts) && stall.orphanStarts > 0 ? stall.orphanStarts : null;
      issues.push(issue('predictions_no_progress', 'degraded', 'predictions', eligible + ' predictions are eligible and there is no confirmed progress for ' + hours(stall.idleMs ?? 0) + ' hours' + (stall.reason === 'repeated_orphan_starts' ? ', with ' + (orphans ?? 'repeated') + ' ownerless starts since (turned-away or abandoned without a film)' : orphans !== null ? ', ' + orphans + ' ownerless starts in the last 2 hours' : '') + (stall.activeRun ? '; a run holds the lease now, which is not progress' : '') + (last === null ? ' (no earlier progress is known)' : ' (last confirmed progress ' + new Date(last).toISOString() + ')') + why));
    } else if (stall.state === 'waiting') { state = 'waiting'; recovery = 'retry_wait'; }
    else if (stall.state === 'idle') recovery = 'no_eligible_work';
    else if (stall.state === 'ok' || (stall.state === 'running' && stall.sinceKnown === true)) recovery = 'progress';
    else if (openSince !== null) { state = 'degraded'; issues.push(predictionHold(openSince, stall.state === 'running' ? 'a run is working but no progress is confirmed yet' : 'the eligible work or the progress time cannot be read', last)); }
    else if (stall.state !== 'running') state = 'delayed'; // unreadable queue split or no progress evidence yet: visible, never healthy, never an alert by itself
  } else if (eligible === null && openSince !== null) { state = 'degraded'; issues.push(predictionHold(openSince, 'the eligible work cannot be read', last)); }
  else recovery = 'no_eligible_work';
  const all = worst(issues);
  return {stream: 'predictions', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {pendingCount: pending, eligibleNow: eligible, stall: stall.state, stallReason: stall.reason ?? null, idleMs: stall.idleMs ?? null, lastProgressAt: facts.lastProgressAt ?? null,
    orphanStarts: Number.isInteger(stall.orphanStarts) ? stall.orphanStarts : null, recovery: issues.length ? null : recovery}};
}
// AIR-596: the text of the one recovery of `predictions_no_progress`, from the stream facts of the tick that recovered it. Confirmed progress and an absence of
// eligible work are different recoveries and are never worded alike.
export function predictionRecoveryMessage(facts) {
  const last = time(facts?.lastProgressAt);
  if (facts?.recovery === 'progress') return 'Recovered: prediction progress is confirmed again' + (last === null ? '' : ' (last confirmed progress ' + new Date(last).toISOString() + ')');
  if (facts?.recovery === 'no_eligible_work') return 'Recovered: no prediction is eligible now (the queue is drained or holds only retry-exhausted work); this is not confirmed progress';
  if (facts?.recovery === 'retry_wait') return 'Recovered: every remaining prediction waits for its retry time; this is not confirmed progress';
  return 'Recovered';
}

// ---- Catalog posters (AIR-543, ADR 0179): the weekly poster sweep, judged by the one projection of its R2 checkpoint (CatalogPosterWeekly.project).
// The projection already carries the existing vocabulary in `monitor`; only a degraded or needs_owner state raises an issue. A normal no-poster
// verdict, an empty due set, a first-run grace and a legitimate retry wait are never issues. An unreadable fact is a fault, never a pass.
export function evaluateCatalogPosters(facts) {
  if (!facts || facts.error || !STATES.includes(facts.monitor)) return unreadable('catalog_posters', 'catalog poster');
  const issues = [];
  if (facts.monitor === 'degraded' || facts.monitor === 'needs_owner') {
    issues.push(issue('catalog_posters_' + facts.state, facts.monitor, 'catalog_posters', 'Catalog poster retry is ' + facts.state + (facts.detail ? ' (' + facts.detail + ')' : '')));
  }
  return {stream: 'catalog_posters', state: facts.monitor, issues, facts: {state: facts.state, detail: facts.detail ?? null, freshnessAt: facts.freshnessAt ?? null, nextExpectedAt: facts.nextExpectedAt ?? null}};
}

// ---- Canonical Producer (AIR-572): the EPG -> canonical Film/Person Producer, judged by DURABLE progress only. `facts.sinceAt` is the reference time of the
// last evidence of life (the later of the last stored progress and the start of the current no-progress streak), computed by the Monitor from the run's own
// counters. A publication, a takeover, a lease renewal or a heartbeat never moves it. `current` means exactly one thing: the run of the published generation is
// `passed` and its applied generation equals the published one. The stream is never `healthy` merely because the EPG publication succeeded.
const IDENTITY_STOP = /^producer_identity_/;
// AIR-572 / AIR-593. The durable progress clock, shared by the Monitor (the WRITER: it persists the clock in `monitor/state.json`) and the Footer (a READER:
// it never writes it). PROVEN progress only: units finished in the SAME run row and the SAME pass (n_applied + n_noop + n_kept grew) or its cursor moved.
// A new pass number, a new pass state, a new run row or a new generation changes nothing by itself, and a counter that falls (a replay) is never progress.
// The first sighting of a pass is evidence only if it already finished units or holds a cursor, and then only at its own stored update time.
// The writer dates a movement it observes at `now`, which is sound because it stores the new baseline with it (`observedAt` records that tick). A reader
// does not store the baseline, so `now` would renew the window on every read of the same unchanged row: in `readOnly` a movement is dated by the run row's
// own `updated_at` (never later than `now`), the first-tick grace does not exist (no stored clock: the streak starts at the publication), and nothing is
// ever dated by the read itself.
export function canonicalProducerClock(previous, run, publishedAt, now, {readOnly = false} = {}) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const stamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : null;
  const live = stamp(prior.liveSince) ?? (readOnly ? null : now);
  const done = run ? Number(run.n_applied || 0) + Number(run.n_noop || 0) + Number(run.n_kept || 0) : null;
  const cursor = run ? (run.cursor_id ?? null) : null;
  const samePass = !!run && prior.runKey === run.run_key && prior.passNo === run.pass_no;
  const moved = samePass && (done > Number(prior.done || 0) || (cursor !== null && cursor !== (prior.cursor ?? null)));
  const seeded = !!run && !samePass && (done > 0 || cursor !== null) ? stamp(run.updated_at) : null;
  const rowAt = run ? stamp(run.updated_at) : null;
  const movedAt = readOnly ? (rowAt !== null ? Math.min(rowAt, now) : null) : now;
  const progress = moved ? (movedAt ?? stamp(prior.progressAt)) : (seeded !== null ? Math.min(seeded, now) : stamp(prior.progressAt));
  const published = stamp(publishedAt) ?? (readOnly ? null : now);
  const streak = moved ? null : (stamp(prior.noProgressSince) ?? (Math.max(published ?? 0, live ?? 0) || null));
  const since = moved ? progress : (Math.max(progress ?? 0, streak ?? 0) || null);
  const at = value => value === null || value === undefined ? null : new Date(value).toISOString();
  return {liveSince: at(live), runKey: run ? run.run_key : (prior.runKey ?? null), passNo: run ? run.pass_no : (prior.passNo ?? null), done: run ? done : (prior.done ?? null), cursor: run ? cursor : (prior.cursor ?? null),
    progressAt: at(progress), noProgressSince: at(streak), sinceAt: at(since), ...(readOnly ? {} : {observedAt: at(now)})};
}
// A count from D1: a non-negative integer (or a string of digits). null, '', a negative, a fraction or NaN is unknown (null), never 0.
const knownCount = value => typeof value === 'number' ? (Number.isInteger(value) && value >= 0 ? value : null) : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
// How far a READER may trust the stored Monitor clock: `fresh` when the Monitor wrote it within `producerClockFreshMs`, `stale` when older (or written before
// AIR-593 without `observedAt`), `missing` when there is none and `unreadable` when the state document could not be read.
function clockStateOf(previous, previousReadable, now) {
  if (!previousReadable) return 'unreadable';
  if (!previous || typeof previous !== 'object') return 'missing';
  const observed = Date.parse(previous.observedAt || '');
  return Number.isFinite(observed) && observed <= now + 5 * MIN && now - observed <= THRESHOLDS.producerClockFreshMs ? 'fresh' : 'stale';
}
// The facts of the `canonical_producer` stream from ONE bounded read (`readProducerMonitorFacts`) and the previous clock. `held` is the static delivery hold
// (nothing is read). The run counters are cumulative over the passes of one run row, while `unit_count` is the current pass only, so `processed` is known
// only on the first pass, only when every counter and the total are known, and never above the total; otherwise it is null (unknown), never a guessed number.
// No identifier of the run, cursor or programme run is part of the facts the Footer shows. `readOnly` (the Footer) uses the reader clock above and adds
// `clockState`.
export function canonicalProducerFacts({held = false, read = null, previous = null, now, readOnly = false, previousReadable = true}) {
  if (held) return {held: true, readable: true, clock: null};
  const extra = readOnly ? {clockState: clockStateOf(previous, previousReadable, now)} : {};
  if (!read || !read.ready) return {held: false, readable: true, label: null, clock: canonicalProducerClock(previous, null, null, now, {readOnly}), ...extra};
  const clock = canonicalProducerClock(previous, read.run, read.publishedAt, now, {readOnly});
  const {run, chain} = read;
  const total = run ? knownCount(run.unit_count) : null;
  const parts = run ? [run.n_applied, run.n_noop, run.n_kept].map(knownCount) : [];
  const done = run && parts.every(value => value !== null) ? parts.reduce((sum, value) => sum + value, 0) : null;
  const processed = run && knownCount(run.pass_no) === 1 && done !== null && total !== null && done <= total ? done : null;
  return {held: false, readable: true, label: read.label, generation: Number.isInteger(read.generation) ? read.generation : null, publishedAt: read.publishedAt, sinceAt: clock.sinceAt, progressAt: clock.progressAt, clock, ...extra,
    chain: chain ? {ownerState: chain.owner_state, stoppedBy: chain.stopped_by || null, recoveryClass: chain.recovery_class || null, nextAttemptAt: chain.next_attempt_at || null} : null,
    run: run ? {passState: run.pass_state, sourceGeneration: run.source_generation, appliedGeneration: run.applied_generation || null, stoppedBy: run.stopped_by || null,
      passNo: knownCount(run.pass_no), unitCount: total, processed, failed: knownCount(run.n_failed), completedAt: run.completed_at || null} : null};
}
// AIR-593. The READER's verdict: the Monitor's own `evaluateCanonicalProducer`, with one restriction. Every verdict that D1 alone decides (current, failed,
// blocked, held, nothing published, waiting inside the window after the publication, stalled) stands whatever the clock. `lagging` alone says "published
// long ago, but still moving", and only a fresh Monitor baseline can prove the moving part: a reader that dates progress by the row's `updated_at` cannot tell
// finished units from another update of the row. Without a fresh clock it is `unconfirmed` (shown as unknown, never green), not `lagging`.
export function evaluateCanonicalProducerReader(facts, now) {
  const verdict = evaluateCanonicalProducer(facts, now);
  if (verdict.facts?.status === 'lagging' && facts?.clockState !== 'fresh') {
    return {...verdict, state: 'delayed', facts: {...verdict.facts, status: 'unconfirmed', clockState: facts?.clockState ?? null}};
  }
  return verdict;
}
export function evaluateCanonicalProducer(facts, now) {
  if (!facts || facts.error || facts.readable === false) return unreadable('canonical_producer', 'canonical Producer');
  const out = (state, status, issues, extra = {}) => ({stream: 'canonical_producer', state, issues,
    facts: {status, held: !!facts.held, generation: facts.label ?? null, chain: facts.chain?.ownerState ?? null, run: facts.run?.passState ?? null, progressAt: facts.progressAt ?? null, ...extra}});
  if (facts.held) {
    // A deliberate delivery hold: honest and visible, never healthy and never a success. It is not an alert (the owner chose it).
    return out('delayed', 'held_by_delivery', [issue('canonical_producer_held_by_delivery', 'delayed', 'canonical_producer', 'The canonical Producer is held by delivery: no Producer progress is expected until the hold is lifted')]);
  }
  if (!facts.label) return out('waiting', 'waiting', []);
  const run = facts.run, chain = facts.chain;
  if (run && run.passState === 'passed' && run.sourceGeneration === facts.label && run.appliedGeneration === facts.label) return out('healthy', 'current', []);
  const stoppedBy = chain?.ownerState === 'stopped' ? (chain.stoppedBy || 'unclassified') : run?.passState === 'stopped' ? (run.stoppedBy || 'unclassified') : null;
  if (stoppedBy) {
    const hard = IDENTITY_STOP.test(stoppedBy) || ['terminal', 'fail_closed', 'exhausted'].includes(chain?.recoveryClass || 'fail_closed');
    const severity = hard ? 'needs_owner' : 'degraded';
    return out(severity, hard ? 'blocked' : 'failed', [issue('canonical_producer_failed', severity, 'canonical_producer', 'The canonical Producer stopped (' + String(stoppedBy).replace(/[^a-z_0-9]/g, '').slice(0, 60) + ')' + (hard ? '; it needs the owner' : '; automatic recovery is pending'))], {stoppedBy});
  }
  const since = time(facts.sinceAt), age = since === null ? null : Math.max(0, now - since);
  if (age === null || age > THRESHOLDS.producerNoProgressMs) {
    return out('degraded', 'stalled', [issue('canonical_producer_no_progress', 'degraded', 'canonical_producer', 'The canonical Producer has shown no durable progress for ' + (age === null ? 'an unknown time' : hours(age) + ' h') + ' (chain ' + (chain?.ownerState || 'absent') + ', run ' + (run?.passState || 'absent') + ')')], {noProgressHours: age === null ? null : hours(age)});
  }
  const published = time(facts.publishedAt);
  return out('waiting', published !== null && now - published > THRESHOLDS.producerNoProgressMs ? 'lagging' : 'waiting', []);
}

// All four streams (plus catalog posters when its facts are supplied) and the overall state. A stream that is `delayed` or `waiting` is recorded but never alerts.
export function evaluateAll(facts, previous, now, helpers) {
  const streams = [
    evaluateEpg(facts.epg, now, helpers),
    evaluateDiscovery(facts.discovery, now),
    evaluateRatings(facts.ratings, now),
    evaluatePredictions(facts.predictions, previous?.predictions ?? null, now),
    ...(facts.catalogPosters === undefined ? [] : [evaluateCatalogPosters(facts.catalogPosters)]),
    ...(facts.letterboxd === undefined ? [] : [evaluateLetterboxd(facts.letterboxd, now)]),
    ...(facts.canonicalProducer === undefined ? [] : [evaluateCanonicalProducer(facts.canonicalProducer, now)]),
  ];
  const issues = streams.flatMap(stream => stream.issues);
  const overall = streams.reduce((state, stream) => STATE_RANK[stream.state] > STATE_RANK[state] ? stream.state : state, 'healthy');
  return {overall, streams, issues};
}

// ---- Alert planning: single issue key, confirmation, cooldown, escalation, bounded sends, recovery once.
// `state` is {issues: {key: {severity, firstSeenAt, seen, lastSentAt, sendCount, sendDay, sendsToday}}}. Returns the messages to send
// and the next state; nothing is sent here.
export function planAlerts(issues, state, now) {
  const previous = state?.issues || {};
  const next = {}, sends = [];
  const day = new Date(now).toISOString().slice(0, 10);
  const actionable = issues.filter(item => item.severity === 'degraded' || item.severity === 'needs_owner');
  for (const item of actionable) {
    const old = previous[item.key] || null;
    const entry = {severity: item.severity, firstSeenAt: old?.firstSeenAt || new Date(now).toISOString(), seen: (old?.seen || 0) + 1, lastSentAt: old?.lastSentAt || null, sendCount: old?.sendCount || 0, sendDay: old?.sendDay === day ? day : day, sendsToday: old?.sendDay === day ? old.sendsToday || 0 : 0};
    const escalated = !!old && old.severity !== item.severity && STATE_RANK[item.severity] > STATE_RANK[old.severity];
    const confirmed = item.severity === 'needs_owner' || entry.seen >= (ALERT_POLICY.confirmSnapshotsByKey[item.key] ?? ALERT_POLICY.confirmSnapshots);
    const lastSent = time(entry.lastSentAt);
    const cooled = lastSent === null || now - lastSent >= ALERT_POLICY.cooldownMs[item.severity];
    if (confirmed && (cooled || escalated) && entry.sendsToday < ALERT_POLICY.maxPerIssuePerDay) {
      sends.push({kind: entry.sendCount ? (escalated ? 'escalation' : 'reminder') : 'alert', key: item.key, severity: item.severity, stream: item.stream, message: item.message, firstSeenAt: entry.firstSeenAt});
      entry.lastSentAt = new Date(now).toISOString();entry.sendCount++;entry.sendsToday++;
    }
    next[item.key] = entry;
  }
  for (const [key, old] of Object.entries(previous)) {
    if (next[key]) continue;
    if (old.sendCount > 0) sends.push({kind: 'recovery', key, severity: 'healthy', stream: key.split('_')[0], message: 'Recovered', firstSeenAt: old.firstSeenAt});
  }
  return {sends, state: {issues: next}};
}
