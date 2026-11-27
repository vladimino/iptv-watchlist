// AIR-349. The pure part of the Cloudflare-native monitor: what the observed facts of the four streams (EPG, Discovery,
// Ratings, prediction queue) mean as a health state, and which of the resulting issues may reach the owner. No I/O, no clock
// and no randomness of its own: callers pass the time, and the Madrid schedule helper for the daily EPG expectation.
// The monitor only diagnoses and reports. Recovery belongs to the domain executors (ADR 0089).

// AIR-592 (ADR 0206): four states. `needs_owner` is retired as a state and a severity: the site has one recipient of every alert, so a separate
// owner tier with its own cooldown added nothing. A proven hard failure (quarantine, a fail-closed or terminal stop, a held authority) is a
// `degraded` issue marked `critical: true`: it alerts at its first snapshot and keeps the diagnosis, but shares the one reminder interval.
export const STATES = Object.freeze(['healthy', 'waiting', 'delayed', 'degraded']);
export const STATE_RANK = Object.freeze({healthy: 0, waiting: 1, delayed: 2, degraded: 3});
// The retired value as it may still sit in `monitor/state.json` written before ADR 0206 (alert entries, stream snapshots, outbox messages).
// Readers map it here: `needs_owner` reads as `degraded` with `critical: true`, so a rollout keeps every issue key, its history and its last send time.
export const LEGACY_SEVERITY = 'needs_owner';
export const normalizeSeverity = value => value === LEGACY_SEVERITY ? 'degraded' : value;
export const isCritical = item => !!item && (item.critical === true || item.severity === LEGACY_SEVERITY);
export function normalizeMessage(message) {
  if (!message || message.severity !== LEGACY_SEVERITY) return message;
  return {...message, severity: 'degraded', critical: true};
}
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
  enrichmentRunAbandonedMs: 10 * MIN, // ADR 0219: a run whose record and lease are both older than TWICE the five-minute drainer lease TTL is abandoned (derived from the lease, not an alert gate of its own)
  enrichmentTransportMs: 24 * HOUR,   // ADR 0211 decision 5: an upstream source with no successful answer for 24 h while work is due
  enrichmentRepairMs: 24 * HOUR,      // a part that stays in `deferred_repair` for the cap interval of its own recheck schedule
  producerClockFreshMs: 90 * MIN,     // AIR-593: a reader trusts the Monitor's stored Producer clock for this long (hourly tick + slack); must stay below producerNoProgressMs
});
export const ALERT_POLICY = Object.freeze({
  confirmSnapshots: 2,                // an ordinary degraded issue alerts after this many consecutive snapshots; a critical one at once
  // AIR-556: the prediction no-progress verdict is computed from stored run times, not from a transient read, so one snapshot confirms it. With
  // the 60-minute limit and the hourly Cron tick the alert follows the last confirmed progress by 60 to about 120 minutes (+ cron/Telegram latency).
  // AIR-572: both Producer verdicts come from stored durable facts (run counters, chain state), so one snapshot confirms them.
  confirmSnapshotsByKey: Object.freeze({predictions_no_progress: 1, canonical_producer_no_progress: 1, canonical_producer_failed: 1}),
  reminderMs: 6 * HOUR,               // ADR 0206: one REMINDER interval per issue, critical or not
  maxPerIssuePerDay: 8,
});
const RESOURCE_CODES = ['exceeded_memory', 'exceeded_cpu', 'worker_1102'];

const issue = (key, severity, stream, message, extra = {}) => ({key, severity, stream, message, ...extra});
const critical = (key, stream, message, extra = {}) => issue(key, 'degraded', stream, message, {critical: true, ...extra});
// AIR-592 (ADR 0206, decision 9): typed `metrics` of an issue, taken only from the facts this evaluation already read, so the human-facing text
// never parses the English `message`. Small values: counts, durations in ms, ISO times and short codes; absent values are left out.
const iso = ms => ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
const metrics = fields => ({metrics: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== ''))});
const worst = issues => issues.reduce((state, item) => STATE_RANK[item.severity] > STATE_RANK[state] ? item.severity : state, 'healthy');
const time = value => { const ms = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(ms) ? ms : null; };
const hours = ms => Math.max(0, Math.round(ms / HOUR * 10) / 10);
const unreadable = (stream, key) => ({stream, state: 'degraded', issues: [issue(stream + '_unreadable', 'degraded', stream, 'The ' + key + ' status could not be read')], facts: {readable: false}});

// ---- EPG: a fresh published generation after each Madrid 17:00, judged by the stored result, not by the Task trigger.
export function evaluateEpg(facts, now, {dailyDue}) {
  if (!facts || facts.error) return unreadable('epg', 'EPG');
  const issues = [];
  if (facts.authority === 'held' || facts.authority === 'unreadable') issues.push(critical('epg_authority', 'epg', 'The published EPG authority is ' + facts.authority, metrics({authority: facts.authority})));
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
      issues.push(issue(facts.runError ? 'epg_failed' : 'epg_stale', 'degraded', 'epg', 'No EPG generation published since ' + hours(late) + ' hours after the Madrid due time' + (facts.runError ? '; the last run recorded an error' : ''), metrics({lateMs: late, dueAt: iso(latest.dueAt), publishedAt: iso(publishedAt), runError: facts.runError ? true : null})));
    }
    if (state === 'delayed') issues.push(issue('epg_delayed', 'delayed', 'epg', 'EPG is ' + hours(late) + ' hours past its due time'));
  }
  if (facts.resourceLimit) issues.push(issue('epg_resource_limit', 'degraded', 'epg', 'The EPG run recorded a Worker resource limit'));
  return {stream: 'epg', state: STATE_RANK[worst(issues)] > STATE_RANK[state] ? worst(issues) : state, issues, facts: {publishedAt: publishedAt === null ? null : new Date(publishedAt).toISOString(), dueAt: new Date(latest.dueAt).toISOString(), publishedSinceDue: publishedSince}};
}

// ---- Discovery: a backlog needs progress that is allowed by its own backoff; waiting by design is not an incident.
// AIR-598: whether work is owed, and every time the rule below uses, come only from `facts.queue`, the shared classification (src/discovery.js
// `discoveryQueueState`) the footer, the Events report and the operational status use too: `allowedAt` (the effective gate: a `chunk_budget` the Workflow renews
// at once is allowed from its checkpoint, whatever gate time it still carries), `checkpointAt` and `lastChunkAt` of the published generation only, never a raw
// record of another generation.
// - A proven empty queue is healthy; the EPG-priority pause waits by design.
// - Owed work (a backlog, a running or failed continuation, an owner-gated stop) follows the time rule as before: `discovery_stalled`.
// - An unconfirmed state (`unknown`: neither work nor its absence proven, or owed work whose admission is not confirmed) has no trustworthy record time, so it is
//   measured by its own clock, `unknownSince`, the first tick that observed it (stored in monitor/state.json by the runtime, reset once the state is known): an
//   expected handoff (authority loading, a generation or gate rollover) waits, anything else is `delayed`, and after the same 3 hours it is `discovery_unconfirmed`.
// - An open Discovery incident (`previous.open`: `discovery_stalled` or `discovery_unconfirmed`) is never recovered by an unreadable or unconfirmed tick: it stays
//   open under its own key with its last measured metrics and a typed `held` reason, and a change of diagnosis while open keeps the open key (a diagnostic
//   transition, not a recovery plus a new alert). It recovers only on a valid disposition, named in `facts.recovery`: `queue_empty`, `epg_priority`, or
//   `within_policy` (owed work whose allowed progress is inside the time rule again).
// Facts without a classification are unconfirmed: this policy never re-derives a backlog from the raw continuation reason.
const DISCOVERY_OWED = new Set(['backlog', 'running', 'failed', 'blocked']);
const DISCOVERY_INCIDENTS = ['discovery_stalled', 'discovery_unconfirmed'];
const DISCOVERY_HANDOFF = new Set(['authority_loading', 'generation_mismatch', 'generation_handoff', 'gate_generation_moved']);
const DISCOVERY_HELD_WHY = {records_unreadable: 'the Discovery records could not be read', queue_unconfirmed: 'the queue state is not confirmed', progress_unconfirmed: 'no chunk has moved the queue since the incident was established'};
const discoveryOpen = previous => {
  const open = previous?.open && typeof previous.open === 'object' && DISCOVERY_INCIDENTS.includes(previous.open.key) && time(previous.open.firstSeenAt) !== null ? previous.open : null;
  return open;
};
const discoveryHold = (open, held, queue) => {
  const measured = open.metrics && typeof open.metrics === 'object' ? Object.fromEntries(Object.entries(open.metrics).filter(([name]) => !['held', 'queueState', 'queueReason'].includes(name))) : {};
  const measuredAt = time(open.metricsAt);
  return issue(open.key, 'degraded', 'discovery', 'The Discovery incident open since ' + iso(time(open.firstSeenAt)) + ' cannot be confirmed or cleared now (' + DISCOVERY_HELD_WHY[held] + (queue?.reason ? ': ' + queue.reason : '') + '); it stays open until the queue is proven empty, paused by design or its allowed progress is within the rule again',
    {metrics: {...measured, held, queueState: queue?.state ?? null, queueReason: queue?.reason ?? null}, ...(measuredAt !== null && Object.keys(measured).length ? {metricsAt: iso(measuredAt)} : {})});
};
export function evaluateDiscovery(facts, now, previous = null) {
  const open = discoveryOpen(previous);
  if (!facts || facts.error) {
    const out = unreadable('discovery', 'Discovery');
    if (open) out.issues.push(discoveryHold(open, 'records_unreadable', null));
    out.facts = {readable: false, unknownSince: time(previous?.unknownSince) === null ? null : iso(time(previous.unknownSince)), recovery: null};
    return out;
  }
  const issues = [];
  if (facts.readout?.quarantined) issues.push(critical('discovery_quarantined', 'discovery', 'The Discovery executor retry budget is exhausted and the run is quarantined', metrics({executor: facts.executor ?? null})));
  const record = facts.continuation || null;
  const queue = facts.queue && typeof facts.queue === 'object' ? facts.queue : {state: 'unknown', reason: 'not_classified'};
  const quiet = queue.state === 'empty' || queue.state === 'paused';
  const lastChunk = time(queue.lastChunkAt), checkpoint = time(queue.checkpointAt);
  // Owed work is judged by its time rule only when some usable time of this generation exists; without any (no allowed time, no checkpoint, no finished chunk)
  // it is as unconfirmed as an unknown state: absent timing is never taken as progress within the rule.
  const timed = time(queue.allowedAt) !== null || lastChunk !== null || checkpoint !== null;
  const backlog = !quiet && DISCOVERY_OWED.has(queue.state) && timed;
  const unconfirmed = !quiet && !backlog;
  const queueMetrics = {queueState: queue.state ?? null, queueReason: queue.reason ?? null, ...(DISCOVERY_OWED.has(queue.state) && !timed ? {timing: 'unknown'} : {})};
  let state = queue.state === 'paused' ? 'waiting' : 'healthy', stall = null, unknownSince = null, progressAt = null, trackedBacklog = false, usefulNewer = false;
  if (backlog) {
    const allowedAt = time(queue.allowedAt) ?? 0;
    // AIR-687: a record that tracks useful work (`usefulProgressSince`) is judged by the last chunk with real queue movement, or by the start of tracking when there was none yet. A fresh error, collision or
    // backoff checkpoint, and a future gate, are not progress and neither refresh this clock nor end an open incident. A legacy record without the fields keeps the checkpoint and chunk clocks.
    const usefulSince = time(queue.usefulProgressSince), usefulAt = time(queue.usefulProgressAt);
    const tracked = usefulSince !== null;
    const lastProgress = tracked ? (usefulAt ?? usefulSince) : Math.max(lastChunk ?? 0, checkpoint ?? 0);
    progressAt = tracked && lastProgress ? lastProgress : null;
    // The detection clock (above) and the recovery proof differ, as for the Predictions stream: starting to track is a baseline for detecting a NEW incident, never evidence that an open one ended. An open incident on tracked work
    // recovers only on useful work newer than its baseline (`metrics.lastProgressAt` of its last stalled observation, else the time it was established).
    trackedBacklog = tracked;
    const baseline = open ? (time(open.metrics?.lastProgressAt) ?? time(open.firstSeenAt)) : null;
    usefulNewer = usefulAt !== null && baseline !== null && usefulAt > baseline;
    // A zero-work loop (a recorded error, or a counted `discovery_fence` collision retry) is not a legitimate wait: its own gate cannot hide it. A deferred wait of another kind (cooldown, budget backoff) keeps the gate order.
    const loop = queue.state === 'failed' || Number(queue.fenceCollisions) > 0;
    const overdue = allowedAt && allowedAt <= now ? now - allowedAt : 0;
    const idle = lastProgress ? now - lastProgress : null;
    if (tracked && loop && idle !== null && idle >= THRESHOLDS.discoveryDegradedMs) stall = {key: 'discovery_stalled', stalledMs: Math.max(overdue, idle), allowedAt: allowedAt ? iso(allowedAt) : null};
    else if (allowedAt && allowedAt > now) state = 'waiting';
    else if (overdue < THRESHOLDS.discoveryWaitingMs && (idle === null || idle < THRESHOLDS.discoveryDegradedMs)) state = overdue > 0 ? 'waiting' : 'healthy';
    else if (overdue < THRESHOLDS.discoveryDegradedMs && (idle === null || idle < THRESHOLDS.discoveryDegradedMs)) state = 'delayed';
    else stall = {key: 'discovery_stalled', stalledMs: Math.max(overdue, idle ?? 0), allowedAt: allowedAt ? iso(allowedAt) : null};
    if (!stall && facts.health === 'orphaned' && idle !== null && idle >= THRESHOLDS.discoveryWaitingMs) state = 'delayed';
  } else if (unconfirmed) {
    unknownSince = time(previous?.unknownSince) ?? now;
    const span = Math.max(0, now - unknownSince);
    if (span >= THRESHOLDS.discoveryDegradedMs) stall = {key: 'discovery_unconfirmed', stalledMs: span, allowedAt: null};
    else state = span < THRESHOLDS.discoveryWaitingMs && DISCOVERY_HANDOFF.has(queue.reason) ? 'waiting' : 'delayed';
  }
  if (stall) {
    state = 'degraded';
    // While an incident is open its key stays: a change of diagnosis is shown in the metrics, never as a recovery followed by a new alert.
    const key = open ? open.key : stall.key, transition = open && open.key !== stall.key ? stall.key : null;
    const shared = {stalledMs: stall.stalledMs, allowedAt: stall.allowedAt, lastChunkAt: iso(lastChunk), ...(progressAt ? {lastProgressAt: iso(progressAt)} : {}), executor: facts.executor ?? null, ...queueMetrics, ...(transition ? {transition} : {})};
    if (stall.key === 'discovery_stalled') issues.push(issue(key, 'degraded', 'discovery', 'Discovery backlog (' + (queue.remainingChunks ?? record?.remainingChunks ?? '?') + ' chunks) has had no allowed progress for ' + hours(stall.stalledMs) + ' hours', metrics({remainingChunks: queue.remainingChunks ?? null, ...shared})));
    else issues.push(issue(key, 'degraded', 'discovery', 'The Discovery queue state (' + (queue.reason ?? 'unknown') + ') has stayed unconfirmed for ' + hours(stall.stalledMs) + ' hours', metrics(shared)));
  } else if (open && unconfirmed) {
    state = 'degraded';
    issues.push(discoveryHold(open, 'queue_unconfirmed', queue));
  } else if (open && backlog && trackedBacklog && !usefulNewer) {
    state = 'degraded';
    issues.push(discoveryHold(open, 'progress_unconfirmed', queue));
  }
  if (!quiet && facts.readout?.stalled && state !== 'degraded') { state = 'degraded'; issues.push(issue('discovery_executor_stalled', 'degraded', 'discovery', 'The Discovery Workflow instance is stalled', metrics({remainingChunks: queue.remainingChunks ?? null, lastChunkAt: iso(lastChunk), executor: facts.executor ?? null}))); }
  if (state === 'degraded' && facts.publishedRunId && record?.programmeRunId && facts.publishedRunId !== record.programmeRunId) issues.push(issue('discovery_generation_mismatch', 'degraded', 'discovery', 'The continuation belongs to another generation than the published one'));
  if (facts.resourceLimit) issues.push(issue('discovery_resource_limit', 'degraded', 'discovery', 'Discovery recorded a Worker resource limit'));
  const stillOpen = open && issues.some(item => item.key === open.key);
  // Only a confirmed disposition ends an open incident: a proven empty queue, the pause, or owed work measured with real times inside the rule.
  const recovery = open && !stillOpen ? (queue.state === 'empty' ? 'queue_empty' : queue.state === 'paused' ? 'epg_priority' : backlog ? 'within_policy' : null) : null;
  const all = worst(issues);
  return {stream: 'discovery', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {executor: facts.executor ?? null, backlog, remainingChunks: queue.remainingChunks ?? null, queueState: queue.state ?? null, queueReason: queue.reason ?? null, unknownSince: unknownSince === null ? null : iso(unknownSince), recovery}};
}

// ---- Ratings: the orchestration read model already derives health from the run record and the Madrid 17:00 schedule.
export function evaluateRatings(model, now) {
  if (!model || model.error) return unreadable('ratings', 'Ratings');
  const issues = [];
  const health = model.health;
  let state = 'healthy';
  if (health === 'waiting' || health === 'cooldown') state = 'waiting';
  else if (health === 'stalled') { state = 'degraded'; issues.push(issue('ratings_stalled', 'degraded', 'ratings', 'No completed Ratings day and no durable progress since two hours after the due time', metrics({detail: 'no_day_two_hours_after_due'}))); }
  else if (health === 'quarantined') { state = 'degraded'; issues.push(critical('ratings_quarantined', 'ratings', 'The Ratings run is quarantined' + (model.quarantine?.reason ? ' (' + model.quarantine.reason + ')' : ''), metrics({reason: model.quarantine?.reason ?? null}))); }
  else if (health === 'failed_permanent') { state = 'degraded'; issues.push(critical('ratings_failed_permanent', 'ratings', 'The Ratings run failed with a permanent error')); }
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
  else if (health === 'late') { state = 'degraded'; issues.push(issue('letterboxd_slot_late', 'degraded', 'letterboxd', 'A Letterboxd slot is due and no run was started', metrics({slot: model.slot?.key ?? null}))); }
  else if (health === 'stalled') { state = 'degraded'; issues.push(issue('letterboxd_slot_stalled', 'degraded', 'letterboxd', 'A Letterboxd slot stayed open after its window ended', metrics({slot: model.slot?.key ?? null}))); }
  else if (health === 'missed') { state = 'degraded'; issues.push(issue('letterboxd_slot_missed', 'degraded', 'letterboxd', 'A Letterboxd slot was missed and recorded without a run', metrics({slot: model.slot?.key ?? null}))); }
  else if (health === 'failed') { state = 'degraded'; issues.push(issue('letterboxd_slots_failed', 'degraded', 'letterboxd', 'The last Letterboxd slot failed for both sources', metrics({slot: model.slot?.key ?? null}))); }
  else if (health === 'quarantined') { state = 'degraded'; issues.push(critical('letterboxd_quarantined', 'letterboxd', 'Letterboxd Sync is quarantined' + (model.quarantine?.reason ? ' (' + model.quarantine.reason + ')' : ''), metrics({reason: model.quarantine?.reason ?? null}))); }
  else if (health === 'unreadable') { state = 'degraded'; issues.push(issue('letterboxd_unreadable', 'degraded', 'letterboxd', 'The Letterboxd Sync read model could not be read')); }
  if (model.sources?.watchlist?.stale) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_watchlist_stale', 'degraded', 'letterboxd', model.sources.watchlist.warning === 'watchlist_never_succeeded' ? 'No complete Watchlist scan has succeeded since the executor started' : 'No complete Watchlist scan has succeeded for 24 hours', metrics({detail: model.sources.watchlist.warning === 'watchlist_never_succeeded' ? 'watchlist_never_succeeded' : 'watchlist_stale_24h'}))); }
  // Each source has its own signal: one update can fail while the other succeeds (the approved contract), and neither outcome hides or rewrites the other's confirmed success. A rate limit is "not now" and never alerts.
  const sourceIssue = (key, label, outcome) => {
    if (['error', 'blocked', 'interrupted', 'unavailable', 'incomplete', 'disabled'].includes(outcome)) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue(key + '_failed', 'degraded', 'letterboxd', 'The last Letterboxd slot did not update ' + label + ' (' + outcome + ')', metrics({outcome, slot: model.slot?.key ?? null}))); }
    else if (outcome === 'rate_limited') { if (STATE_RANK[state] < STATE_RANK.delayed) state = 'delayed'; issues.push(issue(key + '_rate_limited', 'delayed', 'letterboxd', label + ' was rate limited in the last Letterboxd slot')); }
  };
  if (health !== 'failed') { sourceIssue('letterboxd_ratings', 'Ratings', model.sources?.ratings?.lastOutcome); sourceIssue('letterboxd_watchlist', 'the Watchlist', model.sources?.watchlist?.lastOutcome); }
  // AIR-599 / ADR 0207 decision 4b: the shared Letterboxd check (Diary and Watchlist callers). Three conditions: no answered check for 24 h while ids are due, a ledger row pending longer than 14 days,
  // and ids waiting while the check document has no free place (`cap_refused`, AIR-691: a non-empty backlog alone is the ordinary queue) or a full backlog (`backlog_full`). An unreadable fact is reported, never read as "nothing due".
  const check = model.identityCheck;
  if (check && (check.error || check.ledgerUnreadable)) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_identity_check_unreadable', 'degraded', 'letterboxd', check.ledgerUnreadable ? 'The Watchlist admission ledger could not be read, so the Letterboxd identity check state is unknown' : 'The Letterboxd identity check state could not be read')); }
  else if (check) {
    // "Owed work with no answered check for 24 hours": the clock starts at the later of the last answered check and the oldest owed item's queue time, so work that has NEVER been answered (only transport failures
    // since it entered) still alerts, and work that just arrived does not. Unknown ages are not guessed here: they are reported below.
    const since = Math.max(Date.parse(check.lastCheckAt || '') || 0, Date.parse(check.oldestWorkAt || '') || 0);
    if (check.work > 0 && since > 0 && now - since > 24 * 3600000) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_identity_check_stale', 'degraded', 'letterboxd', 'No Letterboxd identity check got an answer for 24 hours while ids are waiting', metrics({work: check.work, lastCheckAt: check.lastCheckAt, oldestWorkAt: check.oldestWorkAt}))); }
    const late = (check.overdue || 0) + (check.overdueUnknown || 0);
    if (late > 0) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_admission_overdue', 'degraded', 'letterboxd', 'Watchlist admission rows have been pending for more than 14 days' + (check.overdueUnknown ? ' (' + check.overdueUnknown + ' of unknown age: their first-seen snapshot was pruned)' : ''), metrics({overdue: check.overdue, overdueUnknown: check.overdueUnknown}))); }
    // AIR-691: a backlog is the ordinary queue and says nothing by itself. `backlog_full` is the backlog at its bound; `cap_refused` is waiting ids while the check document has no free place (`capFull`, from the fact reader).
    if (check.backlog > 0 && (check.backlogFull || check.capFull)) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue(check.backlogFull ? 'letterboxd_identity_backlog_full' : 'letterboxd_identity_cap_refused', 'degraded', 'letterboxd', check.backlogFull ? 'The Letterboxd identity check backlog is full' : 'The Letterboxd identity check document is full; ids wait in the backlog', metrics({backlog: check.backlog, capHeld: check.capHeld ?? null, capacity: check.capacity ?? null}))); }
  }
  if (Number.isInteger(model.eventsPending) && model.eventsPending >= 8) { if (STATE_RANK[state] < STATE_RANK.degraded) state = 'degraded'; issues.push(issue('letterboxd_events_backlog', 'degraded', 'letterboxd', 'Letterboxd slot Events are waiting for delivery', metrics({eventsPending: model.eventsPending}))); }
  const all = worst(issues);
  return {stream: 'letterboxd', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {mode: model.mode ?? null, health: health ?? null, slot: model.slot?.key ?? null, eventsPending: model.eventsPending ?? null}};
}

// ---- Prediction queue (AIR-556): an empty or fully deferred queue is healthy or waiting; eligible work with no confirmed progress is not.
// `facts.stall` is the verdict of the one shared assessment in enrichment.js (`predictionStallAssessment`): running | ok | idle | waiting | unknown | no_progress.
// Confirmed progress is a productive batch or a drained run, never a heartbeat, `already_running`, a noop wake-up or a queue recount. The monitor does
// not know why a Task did not reach the Worker, so no message names api_error, an expired authorization or a number of missed Tasks.
// AIR-596 (ADR 0210): `previous.noProgressOpenSince` is the first-seen time of an open `predictions_no_progress` incident, `previous.openMetrics` and
// `previous.openMetricsAt` its last measured metrics and when they were measured, `previous.progressAt` the progress time the previous tick knew. While the
// incident is open, a tick that cannot read or decide the verdict keeps it open with the last measured metrics under their original time and a typed `held`
// reason; it recovers only on a progress time newer than the one its last proven stalled observation measured, or on proven zero eligible work, and `facts.recovery` names which. Without an
// open incident an undecidable tick is `delayed` (visible, never healthy, never an alert by itself; ADR 0182 decision 4).
const HELD_WHY = {queue_unreadable: 'the prediction queue could not be read', queue_absent: 'the prediction queue is absent', split_unknown: 'the eligible work cannot be read',
  progress_unknown: 'no progress time is known', progress_unconfirmed: 'no new confirmed progress since the previous check'};
const predictionHold = (openSince, held, previous) => {
  const measured = previous?.openMetrics && typeof previous.openMetrics === 'object' ? Object.fromEntries(Object.entries(previous.openMetrics).filter(([name]) => name !== 'held')) : {};
  const measuredAt = time(previous?.openMetricsAt), last = time(previous?.progressAt);
  return issue('predictions_no_progress', 'degraded', 'predictions', 'The prediction no-progress incident open since ' + new Date(openSince).toISOString() + ' cannot be confirmed or cleared now (' + HELD_WHY[held] + '); it stays open until confirmed progress or no eligible work is proven' + (last === null ? '' : ' (last confirmed progress ' + new Date(last).toISOString() + ')'),
    {metrics: {...measured, held}, ...(measuredAt !== null && Object.keys(measured).length ? {metricsAt: iso(measuredAt)} : {})});
};
export function evaluatePredictions(facts, previous, now) {
  const openSince = time(previous?.noProgressOpenSince);
  if (!facts || facts.error) {
    const out = unreadable('predictions', 'prediction queue');
    if (openSince !== null) out.issues.push(predictionHold(openSince, 'queue_unreadable', previous));
    return out;
  }
  if (!facts.present) {
    if (openSince !== null) return {stream: 'predictions', state: 'degraded', issues: [predictionHold(openSince, 'queue_absent', previous)], facts: {present: false, held: 'queue_absent'}};
    return {stream: 'predictions', state: 'waiting', issues: [], facts: {present: false}};
  }
  const issues = [];
  const pending = Number.isInteger(facts.pendingCount) && facts.pendingCount >= 0 ? facts.pendingCount : null;
  // An empty pending list is proven zero work even without readable lanes (the same rule as `predictionEligibleNow`).
  const eligible = Number.isInteger(facts.eligibleNow) && facts.eligibleNow >= 0 ? facts.eligibleNow : pending === 0 ? 0 : null;
  const stall = facts.stall && typeof facts.stall === 'object' ? facts.stall : {state: 'unknown', reason: 'queue_unreadable', idleMs: null};
  const why = facts.blockedReason === 'quota' ? ' (the last batch reported a quota limit)' : '';
  const last = time(facts.lastProgressAt), prior = time(previous?.progressAt);
  let state = 'healthy', recovery = null, held = null;
  if (eligible === null) held = 'split_unknown';
  else if (eligible === 0) { if (stall.state === 'waiting') { state = 'waiting'; recovery = 'retry_wait'; } else recovery = 'no_eligible_work'; }
  else if (stall.state === 'no_progress') {
    state = 'degraded';
    const orphans = Number.isInteger(stall.orphanStarts) && stall.orphanStarts > 0 ? stall.orphanStarts : null;
    issues.push(issue('predictions_no_progress', 'degraded', 'predictions', eligible + ' predictions are eligible and there is no confirmed progress for ' + hours(stall.idleMs ?? 0) + ' hours' + (stall.reason === 'repeated_orphan_starts' ? ', with ' + (orphans ?? 'repeated') + ' ownerless starts since (turned-away or abandoned without a film, last 2 hours)' : orphans !== null ? ', ' + orphans + ' ownerless starts in the last 2 hours' : '') + (stall.activeRun ? '; a run holds the lease now, which is not progress' : '') + (last === null ? ' (no earlier progress is known)' : ' (last confirmed progress ' + new Date(last).toISOString() + ')') + why,
      metrics({eligible, pending, idleMs: Number.isFinite(stall.idleMs) ? stall.idleMs : null, orphanStarts: orphans, lastProgressAt: iso(last), activeRun: stall.activeRun === true ? true : null, quota: facts.blockedReason === 'quota' ? true : null})));
  } else if (stall.state === 'ok' || (stall.state === 'running' && stall.sinceKnown === true)) {
    // A recovery needs progress newer than the incident's own baseline: the last progress time its last proven stalled observation measured
    // (`openMetrics.lastProgressAt`, kept unchanged through held ticks), never the memo clock, which an undecidable tick may already have moved past a
    // genuine commit. An entry without typed metrics (written before ADR 0206) falls back to the previous tick's clock: it can only hold longer.
    // Only a real measurement counts: an entry that holds nothing but a `held` reason (a legacy entry first seen held) keeps the conservative fallback
    // through any number of held ticks; a measured stall with an unknown progress time has a null baseline.
    const measured = previous?.openMetrics && typeof previous.openMetrics === 'object' && Object.keys(previous.openMetrics).some(name => name !== 'held') ? previous.openMetrics : null;
    const baseline = measured ? time(measured.lastProgressAt) : prior;
    if (openSince === null || (last !== null && (baseline === null || last > baseline))) recovery = 'progress'; else held = 'progress_unconfirmed';
  } else if (stall.state === 'running') { if (openSince !== null) held = 'progress_unconfirmed'; }
  else held = stall.reason === 'queue_unreadable' ? 'split_unknown' : 'progress_unknown';
  if (held !== null) {
    if (openSince !== null) { state = 'degraded'; issues.push(predictionHold(openSince, held, previous)); }
    else state = 'delayed'; // unreadable queue split or no progress evidence yet: visible, never healthy, never an alert by itself
  }
  const all = worst(issues);
  return {stream: 'predictions', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {pendingCount: pending, eligibleNow: eligible, stall: stall.state, stallReason: stall.reason ?? null, idleMs: stall.idleMs ?? null, lastProgressAt: facts.lastProgressAt ?? null,
    orphanStarts: Number.isInteger(stall.orphanStarts) ? stall.orphanStarts : null, held, recovery: issues.length || held !== null ? null : recovery}};
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

// AIR-598: the text and the reason of a Discovery recovery, from the stream facts of the tick that recovered it. A queue proven empty by the shared
// classification and the EPG-priority pause are different recoveries, and neither is worded as progress.
export function discoveryRecovery(facts) {
  if (facts?.recovery === 'queue_empty') return {reason: 'queue_empty', message: 'Recovered: the Discovery queue is proven empty (' + (facts.queueReason || 'proof') + '); this is not new progress'};
  if (facts?.recovery === 'epg_priority') return {reason: 'epg_priority', message: 'Recovered: Discovery is paused for the EPG update; this is not new progress'};
  if (facts?.recovery === 'within_policy') return {reason: 'within_policy', message: 'Recovered: the allowed progress of the Discovery work is within the rule again'};
  return {reason: null, message: 'Recovered'};
}

// ---- Catalog posters (AIR-543, ADR 0179): the weekly poster sweep, judged by the one projection of its R2 checkpoint (CatalogPosterWeekly.project).
// The projection already carries the existing vocabulary in `monitor` (and `critical` for a failed run); only a degraded state raises an issue. A normal
// no-poster verdict, an empty due set, a first-run grace and a legitimate retry wait are never issues. An unreadable fact is a fault, never a pass.
export function evaluateCatalogPosters(facts) {
  const monitor = normalizeSeverity(facts?.monitor);
  if (!facts || facts.error || !STATES.includes(monitor)) return unreadable('catalog_posters', 'catalog poster');
  const issues = [];
  if (monitor === 'degraded') {
    issues.push(issue('catalog_posters_' + facts.state, 'degraded', 'catalog_posters', 'Catalog poster retry is ' + facts.state + (facts.detail ? ' (' + facts.detail + ')' : ''), {...(isCritical({critical: facts.critical, severity: facts.monitor}) ? {critical: true} : {}), ...metrics({detail: facts.detail ?? null, freshnessAt: facts.freshnessAt ?? null, nextExpectedAt: facts.nextExpectedAt ?? null})}));
  }
  return {stream: 'catalog_posters', state: monitor, issues, facts: {state: facts.state, detail: facts.detail ?? null, freshnessAt: facts.freshnessAt ?? null, nextExpectedAt: facts.nextExpectedAt ?? null}};
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
export function canonicalProducerClock(previous, run, publishedAt, now, {readOnly = false, current = false, boundary = false, label = null} = {}) {
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
  // AIR-692: a generation PROVEN current (passed, source = applied = published, zero eligible units included) closes its streak. The idle time that follows
  // is normal, not missing progress, so the next publication starts its window at its OWN publication instead of inheriting the previous day's streak.
  // A generation that rolls over while unfinished never reaches this branch, so its streak is kept.
  // `boundary` (the earlier observed generation was proven passed) discards the stored streak and starts the window at THIS publication.
  const streak = moved || current || (boundary && !label) ? null : ((boundary ? null : stamp(prior.noProgressSince)) ?? (Math.max(published ?? 0, live ?? 0) || null));
  const since = moved ? progress : (Math.max(progress ?? 0, streak ?? 0) || null);
  const at = value => value === null || value === undefined ? null : new Date(value).toISOString();
  // AIR-692 (review): `lastLabel` remembers the last OBSERVED publication (also before any run row exists) and `closed` says that this label was proven
  // current. A tick that reads nothing (not ready) keeps both, so the closed boundary survives a transient unready observation.
  const lastLabel = label || (prior.lastLabel ?? null), closed = label ? current : prior.closed === true;
  return {lastLabel, closed, liveSince: at(live), runKey: run ? run.run_key : (prior.runKey ?? null), passNo: run ? run.pass_no : (prior.passNo ?? null), done: run ? done : (prior.done ?? null), cursor: run ? cursor : (prior.cursor ?? null),
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
  if (!read || !read.ready) return {held: false, readable: true, label: null, clock: canonicalProducerClock(previous, null, null, now, {readOnly, boundary: previous?.closed === true}), ...extra};
  const {run, chain} = read;
  const proves = (row, label) => !!row && !!label && row.pass_state === 'passed' && row.source_generation === label && row.applied_generation === label;
  const current = proves(run, read.label);
  // AIR-692 (review): a previous generation that was observed unfinished and has since been superseded closes the boundary only on its OWN exact
  // passed/source/applied claim (ADR 0141: a passed run is immutable). An absent, unreadable or unmatched answer clears nothing.
  const boundary = !current && ((previous?.closed === true && !!previous.lastLabel && read.label !== previous.lastLabel) || (!!read.prior && !read.prior.error && previous?.closed !== true && read.prior.label === previous?.lastLabel && proves(read.prior.run, read.prior.label)));
  const clock = canonicalProducerClock(previous, run, read.publishedAt, now, {readOnly, current, boundary, label: read.label});
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
// AIR-692 (review): an OPEN `canonical_producer_no_progress` incident (its alert entry, passed by Monitor.run like the AIR-596/598 incidents) is carried through
// an observation that cannot prove anything: nothing ready, an unreadable read, or a stop verdict WITHOUT newer durable progress. The diagnostic verdict stays
// honest (unreadable / waiting / failed), the alert entry, its accounting and outbox stay, and no recovery or fresh alert follows. Affirmative evidence still
// recovers it: an exact pass (`current`), or proven progress newer than the one the incident recorded.
const openProducerIssue = (open, now) => {
  if (!open || open.key !== 'canonical_producer_no_progress') return null;
  const since = time(open.metrics?.sinceAt) ?? time(open.firstSeenAt);
  return issue('canonical_producer_no_progress', 'degraded', 'canonical_producer', 'The canonical Producer no-progress incident stays open: ' + (since === null ? 'no' : 'no durable progress since ' + iso(since) + ' and no') + ' proof of progress or completion has been observed',
    {...(open.critical === true ? {critical: true} : {}), ...(open.metrics ? {metrics: open.metrics, ...(typeof open.metricsAt === 'string' ? {metricsAt: open.metricsAt} : {})} : {})});
};
const progressedSince = (open, progressAt) => {
  const progress = time(progressAt);
  const base = time(open?.metrics?.progressAt) ?? (open?.metrics ? -Infinity : (time(open?.firstSeenAt) ?? -Infinity));
  return progress !== null && progress > base;
};
export function evaluateCanonicalProducer(facts, now, open = null) {
  const carried = openProducerIssue(open, now);
  if (!facts || facts.error || facts.readable === false) {
    const base = unreadable('canonical_producer', 'canonical Producer');
    return carried ? {...base, issues: [...base.issues, carried]} : base;
  }
  const out = (state, status, issues, extra = {}) => ({stream: 'canonical_producer', state, issues,
    facts: {status, held: !!facts.held, generation: facts.label ?? null, chain: facts.chain?.ownerState ?? null, run: facts.run?.passState ?? null, progressAt: facts.progressAt ?? null, ...extra,
      // ADR 0208 decision 7: shown, never judged. The verdict above does not read it.
      ...(facts.outcomeDelivery && typeof facts.outcomeDelivery === 'object' ? {outcomeDelivery: facts.outcomeDelivery} : {})}});
  if (facts.held) {
    // A deliberate delivery hold: honest and visible, never healthy and never a success. It is not an alert (the owner chose it).
    return out('delayed', 'held_by_delivery', [issue('canonical_producer_held_by_delivery', 'delayed', 'canonical_producer', 'The canonical Producer is held by delivery: no Producer progress is expected until the hold is lifted')]);
  }
  if (!facts.label) return carried ? out('degraded', 'waiting', [carried]) : out('waiting', 'waiting', []);
  const run = facts.run, chain = facts.chain;
  if (run && run.passState === 'passed' && run.sourceGeneration === facts.label && run.appliedGeneration === facts.label) return out('healthy', 'current', []);
  const stoppedBy = chain?.ownerState === 'stopped' ? (chain.stoppedBy || 'unclassified') : run?.passState === 'stopped' ? (run.stoppedBy || 'unclassified') : null;
  if (stoppedBy) {
    // A hard stop (an identity code, or a terminal, fail_closed or exhausted class) is critical: it alerts at once and an earlier recoverable stop of the
    // same issue escalates. A recoverable stop is an ordinary degraded issue. Both keep `status` (blocked / failed) and the stop reason as diagnosis.
    const hard = IDENTITY_STOP.test(stoppedBy) || ['terminal', 'fail_closed', 'exhausted'].includes(chain?.recoveryClass || 'fail_closed');
    const keep = carried && !progressedSince(open, facts.progressAt) ? [carried] : [];
    return out('degraded', hard ? 'blocked' : 'failed', [...keep, issue('canonical_producer_failed', 'degraded', 'canonical_producer', 'The canonical Producer stopped (' + String(stoppedBy).replace(/[^a-z_0-9]/g, '').slice(0, 60) + ')' + (hard ? '; automatic recovery will not resume it' : '; automatic recovery is pending'), {...(hard ? {critical: true} : {}), ...metrics({stoppedBy: String(stoppedBy).replace(/[^a-z_0-9]/g, '').slice(0, 60), hard, generation: facts.label ?? null})})], {stoppedBy});
  }
  const since = time(facts.sinceAt), age = since === null ? null : Math.max(0, now - since);
  if (age === null || age > THRESHOLDS.producerNoProgressMs) {
    return out('degraded', 'stalled', [issue('canonical_producer_no_progress', 'degraded', 'canonical_producer', 'The canonical Producer has shown no durable progress for ' + (age === null ? 'an unknown time' : hours(age) + ' h') + ' (chain ' + (chain?.ownerState || 'absent') + ', run ' + (run?.passState || 'absent') + ')', metrics({idleMs: age, sinceAt: iso(since), progressAt: iso(time(facts.progressAt)), chain: chain?.ownerState || 'absent', run: run?.passState || 'absent', generation: facts.label ?? null}))], {noProgressHours: age === null ? null : hours(age)});
  }
  const published = time(facts.publishedAt);
  return out('waiting', published !== null && now - published > THRESHOLDS.producerNoProgressMs ? 'lagging' : 'waiting', []);
}

// ---- Catalog Enrichment Producer (AIR-605; ADR 0211 decision 5 as amended by ADR 0219). Judged from D1 facts only (`CatalogEnrichmentStore.readMonitorFacts`): the Monitor keeps no enrichment clock. A dormant or absent
// producer (no schema, no control row, `inactive`) is NEUTRAL and never alerts; a pause is the owner's choice and is `delayed`, not an alert. A run that is PARKED or has HANDED OVER is healthy; only a run whose record and drainer
// lease are both stale is abandoned. Source-specific counts are kept in the facts and the messages.
export function evaluateCatalogEnrichment(facts, now) {
  if (!facts || facts.error || facts.readable === false) return unreadable('catalog_enrichment', 'Catalog Enrichment');
  const out = (state, status, issues, extra = {}) => ({stream: 'catalog_enrichment', state, issues, facts: {status, ...extra}});
  if (!facts.configured) return out('waiting', 'not_configured', [], {reason: facts.reason ?? null});
  if (facts.control?.state === 'inactive') return out('waiting', 'not_active', []);
  if (facts.control?.state === 'paused') return out('delayed', 'paused_by_owner', []);
  const issues = [];
  const typed = {due: facts.due?.films ?? 0, oldestDueSince: facts.due?.oldestDueSince ?? null, progressAt: facts.progressAt ?? null};
  // 1. An abandoned run: its record is stale and no live drainer lease backs it. `running` and `parked` past its wake time are judged the same way.
  const leaseLive = time(facts.leaseUntil) !== null && time(facts.leaseUntil) > now;
  const recordAt = time(facts.run?.at);
  const wake = time(facts.run?.wakeAt);
  const stale = recordAt === null || now - recordAt > THRESHOLDS.enrichmentRunAbandonedMs;
  const overdueWake = facts.run?.phase === 'parked' && wake !== null && now - wake > THRESHOLDS.enrichmentRunAbandonedMs;
  const startedAt = time(facts.lastTick?.startedAt);
  const tickOpen = facts.lastTick?.state === 'started' && startedAt !== null && now - startedAt > THRESHOLDS.enrichmentRunAbandonedMs;
  if (!leaseLive && ((facts.run?.phase === 'running' && stale) || overdueWake || tickOpen)) {
    issues.push(issue('catalog_enrichment_run_abandoned', 'degraded', 'catalog_enrichment', 'The Catalog Enrichment run ' + (facts.run?.instance || '') + ' was abandoned: no drainer lease and no movement for ' + (recordAt === null ? 'an unknown time' : hours(now - recordAt) + ' h'), {metrics: {phase: facts.run?.phase ?? null}}));
  }
  // 2. Due work that is not progressing: runnable Films (their retry has passed, scope enabled, not blocked) while no run committed a unit for the one existing producer no-progress window.
  const oldest = time(facts.due?.oldestDueSince), progress = time(facts.progressAt);
  if (typed.due > 0 && oldest !== null && now - oldest > THRESHOLDS.producerNoProgressMs && (progress === null || now - progress > THRESHOLDS.producerNoProgressMs)) {
    issues.push(issue('catalog_enrichment_no_progress', 'degraded', 'catalog_enrichment', typed.due + ' Film(s) have due Catalog Enrichment work and no unit was committed for ' + hours(progress === null ? now - oldest : now - progress) + ' h', {metrics: {due: typed.due}}));
  }
  // 3. An upstream source with a transport streak for 24 h while work is due: one issue per source, so the counts are source-specific.
  for (const [source, streak] of Object.entries(facts.transport || {})) {
    const since = time(streak?.since);
    if (typed.due > 0 && since !== null && now - since > THRESHOLDS.enrichmentTransportMs) {
      issues.push(issue('catalog_enrichment_transport_' + String(source).replace(/[^a-z_]/g, '').slice(0, 20), 'degraded', 'catalog_enrichment', 'Catalog Enrichment has had no successful ' + source + ' answer for ' + hours(now - since) + ' h with work due (' + (streak.films ?? 0) + ' Film(s) waiting)', {metrics: {source, films: streak.films ?? 0}}));
    }
  }
  // 4. Actionable diagnostics: a verified identity disagreement or an owner-required part waits for the owner; repairable work stuck at its cap interval is reported once with its counts.
  const owner = (facts.attention || []).reduce((sum, row) => sum + (row.count || 0), 0);
  if (owner > 0) {
    const bySource = (facts.attention || []).map(row => row.status + '/' + row.source + ': ' + row.count).join(', ');
    issues.push(issue('catalog_enrichment_attention', 'degraded', 'catalog_enrichment', owner + ' Catalog Enrichment item(s) need the owner (' + bySource + ')', {metrics: {owner}}));
  }
  const stuck = (facts.repair || []).filter(row => time(row.oldestAt) !== null && now - time(row.oldestAt) > THRESHOLDS.enrichmentRepairMs);
  if (stuck.length) {
    issues.push(issue('catalog_enrichment_repair_deferred', 'degraded', 'catalog_enrichment', 'Catalog Enrichment has repairable work deferred for over ' + hours(THRESHOLDS.enrichmentRepairMs) + ' h (' + stuck.map(row => row.source + ': ' + row.count).join(', ') + ')', {metrics: {deferred: stuck.reduce((sum, row) => sum + row.count, 0)}}));
  }
  return out(issues.length ? 'degraded' : (typed.due > 0 ? 'waiting' : 'healthy'), issues.length ? 'attention' : (facts.run?.phase === 'parked' ? 'parked' : 'current'), issues, {...typed, run: facts.run?.phase ?? null, owner, repair: facts.repair || [], transport: facts.transport || {}});
}

// All four streams (plus catalog posters, Letterboxd Sync and the canonical Producer when their facts are supplied) and the overall state. A stream that is `delayed` or `waiting` is recorded but never alerts.
export function evaluateAll(facts, previous, now, helpers) {
  const streams = [
    evaluateEpg(facts.epg, now, helpers),
    evaluateDiscovery(facts.discovery, now, previous?.discovery ?? null),
    evaluateRatings(facts.ratings, now),
    evaluatePredictions(facts.predictions, previous?.predictions ?? null, now),
    ...(facts.catalogPosters === undefined ? [] : [evaluateCatalogPosters(facts.catalogPosters)]),
    ...(facts.letterboxd === undefined ? [] : [evaluateLetterboxd(facts.letterboxd, now)]),
    ...(facts.canonicalProducer === undefined ? [] : [evaluateCanonicalProducer(facts.canonicalProducer, now, previous?.canonicalProducer?.open ?? null)]),
    ...(facts.catalogEnrichment === undefined ? [] : [evaluateCatalogEnrichment(facts.catalogEnrichment, now)]),
  ];
  const issues = streams.flatMap(stream => stream.issues);
  const overall = streams.reduce((state, stream) => STATE_RANK[stream.state] > STATE_RANK[state] ? stream.state : state, 'healthy');
  return {overall, streams, issues};
}

// ---- Alert planning: single issue key, confirmation, one reminder interval, escalation, bounded sends, recovery once.
// `state` is {issues: {key: {severity, critical, firstSeenAt, seen, lastSentAt, sendCount, sendDay, sendsToday}}}. Returns the messages to send
// and the next state; nothing is sent here. ADR 0206: every actionable issue is `degraded`; `critical` (a proven hard failure) confirms at the first
// snapshot, an ordinary one after `confirmSnapshots` (or its per-key count). Both remind every `reminderMs`. An issue that turns from ordinary to
// critical escalates once inside the interval; critical to ordinary sends nothing. An entry stored before ADR 0206 with `severity: needs_owner`
// reads as critical: its history, counters and key are kept, it does not escalate or recover, and its next reminder is `lastSentAt + reminderMs`.
export function planAlerts(issues, state, now) {
  const previous = state?.issues || {};
  const next = {}, sends = [];
  const day = new Date(now).toISOString().slice(0, 10);
  const actionable = issues.filter(item => normalizeSeverity(item.severity) === 'degraded');
  for (const item of actionable) {
    const old = previous[item.key] || null;
    const hard = isCritical(item);
    const entry = {severity: 'degraded', critical: hard, firstSeenAt: old?.firstSeenAt || new Date(now).toISOString(), seen: (old?.seen || 0) + 1, lastSentAt: old?.lastSentAt || null, sendCount: old?.sendCount || 0, sendDay: day, sendsToday: old?.sendDay === day ? old.sendsToday || 0 : 0,
      // ADR 0206 decision 9: what the recovery message needs later (the issue's stream and its last typed metrics); a reader of the previous code ignores both.
      // `metricsAt` dates them: the last observation the open issue was seen with, which is all a recovery can say about the domain (the issue's absence
      // alone does not prove when or how the domain recovered).
      stream: item.stream, ...(item.metrics ? {metrics: item.metrics, metricsAt: (typeof item.metricsAt === 'string' && time(item.metricsAt) !== null ? item.metricsAt : null) || new Date(now).toISOString()} : {})};
    const escalated = !!old && hard && !isCritical(old);
    const confirmed = hard || entry.seen >= (ALERT_POLICY.confirmSnapshotsByKey[item.key] ?? ALERT_POLICY.confirmSnapshots);
    const lastSent = time(entry.lastSentAt);
    const cooled = lastSent === null || now - lastSent >= ALERT_POLICY.reminderMs;
    if (confirmed && (cooled || escalated) && entry.sendsToday < ALERT_POLICY.maxPerIssuePerDay) {
      sends.push({kind: entry.sendCount ? (escalated ? 'escalation' : 'reminder') : 'alert', key: item.key, severity: 'degraded', critical: hard, stream: item.stream, message: item.message, firstSeenAt: entry.firstSeenAt, ...(item.metrics ? {metrics: item.metrics, ...(typeof item.metricsAt === 'string' ? {metricsAt: item.metricsAt} : {})} : {})});
      entry.lastSentAt = new Date(now).toISOString();entry.sendCount++;entry.sendsToday++;
    }
    next[item.key] = entry;
  }
  for (const [key, old] of Object.entries(previous)) {
    if (next[key]) continue;
    // The recovery is frozen at its detection (`endedAt`): a late delivery never lengthens the incident it reports. The stream comes from the entry (an
    // entry stored before ADR 0206 has none, so the key prefix stays the fallback), and the last metrics, dated by `metricsAt`, are what the issue last showed.
    if (old.sendCount > 0) sends.push({kind: 'recovery', key, severity: 'healthy', stream: typeof old.stream === 'string' && old.stream ? old.stream : key.split('_')[0], message: 'Recovered', firstSeenAt: old.firstSeenAt, endedAt: new Date(now).toISOString(), ...(isCritical(old) ? {wasCritical: true} : {}), ...(old.metrics ? {metrics: old.metrics, ...(old.metricsAt ? {metricsAt: old.metricsAt} : {})} : {})});
  }
  return {sends, state: {issues: next}};
}
