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
  predictionsDelayedMs: 3 * HOUR,     // hourly Task at :20 plus grace
  predictionsDegradedMs: 6 * HOUR,
  switchStuckMs: 2 * HOUR,            // a mode switch that stays open
});
export const ALERT_POLICY = Object.freeze({
  confirmSnapshots: 2,                // degraded issues alert after this many consecutive snapshots; needs_owner at once
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
  if (facts.executor === 'invalid') issues.push(issue('discovery_executor_invalid', 'needs_owner', 'discovery', 'DISCOVERY_EXECUTOR holds an invalid value'));
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

// ---- Ratings: the orchestration read model already derives health from the run record and the Madrid 17:30 schedule.
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

// ---- Prediction queue: an empty queue is healthy; pending work with no real model progress for long is not, and growth makes it worse.
// `lastProgressAt` is the last time the model really produced predictions (a productive run or a moved processed counter), never the time
// a scheduled wake-up found nothing to do. Work that is all deferred by its own retry time is waiting by design.
export function evaluatePredictions(facts, previous, now) {
  if (!facts || facts.error) return unreadable('predictions', 'prediction queue');
  if (!facts.present) return {stream: 'predictions', state: 'waiting', issues: [], facts: {present: false}};
  const issues = [];
  const pending = Number.isInteger(facts.pendingCount) ? facts.pendingCount : 0;
  let state = 'healthy';
  if (pending > 0) {
    const activity = time(facts.lastProgressAt);
    const idle = activity !== null ? now - activity : null;
    const growing = Number.isInteger(previous?.pendingCount) && pending > previous.pendingCount;
    const deferredUntil = facts.eligibleNow === 0 ? time(facts.nextRetryAt) : null;
    const why = facts.blockedReason === 'quota' ? ' (the model reported a quota limit)' : '';
    if (deferredUntil !== null && deferredUntil > now) state = 'waiting';
    else if (idle === null || idle >= THRESHOLDS.predictionsDegradedMs) {
      state = 'degraded';
      issues.push(issue('predictions_stale', 'degraded', 'predictions', pending + ' predictions pending and no model progress for ' + (idle === null ? 'an unknown time' : hours(idle) + ' hours') + why));
    } else if (idle >= THRESHOLDS.predictionsDelayedMs) {
      state = 'delayed';
      if (growing) { state = 'degraded'; issues.push(issue('predictions_backlog_growing', 'degraded', 'predictions', 'The prediction backlog grows while the model makes no progress' + why)); }
    }
  }
  const all = worst(issues);
  return {stream: 'predictions', state: STATE_RANK[all] > STATE_RANK[state] ? all : state, issues, facts: {pendingCount: pending}};
}

// All four streams plus the overall state. A stream that is `delayed` or `waiting` is recorded but never alerts.
export function evaluateAll(facts, previous, now, helpers) {
  const streams = [
    evaluateEpg(facts.epg, now, helpers),
    evaluateDiscovery(facts.discovery, now),
    evaluateRatings(facts.ratings, now),
    evaluatePredictions(facts.predictions, previous?.predictions ?? null, now),
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
    const confirmed = item.severity === 'needs_owner' || entry.seen >= ALERT_POLICY.confirmSnapshots;
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
