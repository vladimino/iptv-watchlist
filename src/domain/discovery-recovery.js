// Targeted recovery of one discovery observation: what happened to it, whether a retry of that one observation would
// change anything, what the pipeline will do next and when, and whether the owner should review its identity instead.
// Pure and deterministic: no I/O and no clock of its own (`now` is an input). It mirrors the resolver's own rules
// (`candidateActivity`, `candidateEvidence`, `resolutionActionability` in src/discovery.js, `continuationDecision` and the
// orphan rules of `advanceDiscovery`); tests/discovery-recovery.mjs runs both on the same inputs, so a change to one that
// is not made to the other fails the build.
//
// Execution is never available. No writer can retry one observation safely: the candidate lives only inside the whole
// discovery ledger, the decisions are one shared object that every chunk rewrites whole under the resolver lease, and the
// only resolver entry point runs a chunk over the global pending order. See
// docs/evidence/discovery-targeted-recovery-no-go-2026-10-31.md.

export const DISCOVERY_RECOVERY_VERSION = 1;
export const DISCOVERY_RECOVERY_VERDICTS = ['resolved', 'excluded_nonfilm', 'not_current', 'queued', 'identity_conflict', 'backoff', 'no_more_evidence', 'stale_generation', 'not_found', 'unknown'];
export const DISCOVERY_SERIES_STATES = ['continuing', 'waiting', 'live_writer', 'recovering', 'interrupted', 'stopped', 'unknown'];
export const DISCOVERY_RETRY_HELPS = ['no', 'only_sooner', 'unlikely', 'series_level', 'unknown'];
export const DISCOVERY_NEXT_ACTORS = ['none', 'scheduled_step', 'epg_commit', 'new_epg_evidence', 'owner_investigation', 'reread'];
export const DISCOVERY_RECOVERY_EXECUTE_REASON = 'no_targeted_writer';

const RECOVERY_HOT_BEFORE_MS = 72 * 3600000;
const RECOVERY_HOT_AFTER_MS = 24 * 3600000;
const RECOVERY_INTERRUPTION_LIMIT = 2;
const RECOVERY_TERMINAL_REASONS = ['repeated_uncertain_match', 'awaiting_confirmation'];
const RECOVERY_STOP_REASONS = ['programme_changed', 'missing_secret', 'idle', 'interrupted'];

function recoveryObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recoveryIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function recoveryText(value) {
  return typeof value === 'string' && value ? value : null;
}

function recoveryAbsent(value) {
  return value === undefined || value === null;
}

// The resolver writes `{id, expiresAt}` and releases a lease by setting `expiresAt` to 0; any other shape is not a
// lease the resolver would have written, so whether a writer holds it cannot be told.
function leaseWellFormed(lease) {
  return recoveryObject(lease) && Boolean(recoveryText(lease.id)) && typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt) && lease.expiresAt >= 0;
}

// The fields of a supplied ledger candidate that the resolver's rules read, in the shapes the EPG commit writes them.
// Returns the malformed field paths; the rules below assume an empty list.
function observationShapeFaults(candidate) {
  const faults = [];
  const showOk = show => recoveryObject(show) && typeof show.start === 'number' && Number.isFinite(show.start)
    && (recoveryAbsent(show.channelId) || typeof show.channelId === 'string' || typeof show.channelId === 'number');
  if (!recoveryAbsent(candidate.shows) && !(Array.isArray(candidate.shows) && candidate.shows.every(showOk))) faults.push('observation.shows');
  if (!recoveryAbsent(candidate.durations) && !Array.isArray(candidate.durations)) faults.push('observation.durations');
  if (!recoveryAbsent(candidate.seenInLatestSnapshot) && typeof candidate.seenInLatestSnapshot !== 'boolean') faults.push('observation.seenInLatestSnapshot');
  for (const field of ['lastSeenAt', 'lastAiring']) {
    if (!recoveryAbsent(candidate[field]) && !(typeof candidate[field] === 'number' && Number.isFinite(candidate[field]))) faults.push('observation.' + field);
  }
  if (!recoveryAbsent(candidate.normalizedTitle) && typeof candidate.normalizedTitle !== 'string') faults.push('observation.normalizedTitle');
  if (!recoveryAbsent(candidate.year) && typeof candidate.year !== 'number' && typeof candidate.year !== 'string') faults.push('observation.year');
  if (!recoveryAbsent(candidate.nonfilmReason) && typeof candidate.nonfilmReason !== 'string') faults.push('observation.nonfilmReason');
  return faults;
}

function decisionShapeFaults(decision) {
  return ['status', 'evidenceKey', 'retryAt', 'terminalReason']
    .filter(field => !recoveryAbsent(decision[field]) && typeof decision[field] !== 'string')
    .map(field => 'decision.' + field);
}

// `candidateActivity` of the resolver: only a `current` observation is looked up.
export function observationActivity(candidate, nowMs) {
  const from = nowMs - RECOVERY_HOT_BEFORE_MS, to = nowMs + RECOVERY_HOT_AFTER_MS;
  const shows = Array.isArray(candidate.shows) ? candidate.shows : null;
  const inWindow = !!shows?.some(show => Number(show.start) >= from && Number(show.start) < to);
  if (candidate.seenInLatestSnapshot === true) return inWindow ? 'current' : 'historical';
  if (candidate.seenInLatestSnapshot == null && inWindow) return 'current';
  const last = Number(candidate.lastSeenAt ?? candidate.lastAiring);
  return Number.isFinite(last) && last < from ? 'expired' : 'historical';
}

// `candidateEvidence` of the resolver: a decision made on other evidence does not hold the observation back.
export function observationEvidenceKey(candidate) {
  const shows = [...(candidate.shows || [])].map(show => `${show.channelId || ''}:${show.start}`).sort();
  const durations = [...(candidate.durations || [])].filter(Number.isFinite).sort((a, b) => a - b);
  return [candidate.normalizedTitle || '', candidate.year || '', durations.join(','), shows.join(',')].join('|');
}

// `screenedNonfilmReason` of the resolver, given the screening result the caller computed from the title.
function screenedOut(candidate, decision) {
  if (decision?.status === 'verified' || candidate.confirmedTmdbId) return null;
  return recoveryText(candidate.nonfilmReason);
}

// `resolutionActionability` of the resolver: whether the next chunk may look this observation up.
export function observationActionable(candidate, decision, nowMs) {
  if (observationActivity(candidate, nowMs) !== 'current' || screenedOut(candidate, decision)) return false;
  if (decision?.status === 'excluded_nonfilm') return true;
  if (!decision || decision.status !== 'verified') {
    if (!decision) return true;
    const same = !decision.evidenceKey || decision.evidenceKey === observationEvidenceKey(candidate);
    if (decision.terminalReason && same) return false;
    if (decision.retryAt && Date.parse(decision.retryAt) > nowMs && same) return false;
    return true;
  }
  return false;
}

function seriesResult(state, reason, atMs) {
  return {state, reason, at: recoveryIso(atMs)};
}

// Whether the discovery series will run another chunk, in the order `advanceDiscovery` decides it: a live lease, a
// checkpoint of another generation, an orphaned `running` record, then `continuationDecision` on the stored record.
// `series = {record, health, lease}`: the raw continuation record (null when absent), the continuation health the
// pipeline status reports for it, and the raw resolver lease (null when absent). An unsupplied part is unknown.
export function discoverySeriesState(series, publishedRunId, nowMs) {
  if (!recoveryObject(series)) return seriesResult('unknown', 'series_not_supplied', null);
  const {record, health, lease} = series;
  if (lease === undefined) return seriesResult('unknown', 'lease_not_supplied', null);
  if (lease !== null && !leaseWellFormed(lease)) return seriesResult('unknown', 'lease_malformed', null);
  if (record === undefined) return seriesResult('unknown', 'record_not_supplied', null);
  if (record !== null && !recoveryObject(record)) return seriesResult('unknown', 'record_malformed', null);
  if (lease && lease.expiresAt > nowMs) return seriesResult('live_writer', 'lease_live', lease.expiresAt);
  if (!record) return seriesResult('continuing', 'no_record', null);
  if (publishedRunId && record.programmeRunId && record.programmeRunId !== publishedRunId) return seriesResult('recovering', 'generation_handoff', null);
  if (record.stage === 'running') {
    if (!recoveryObject(health) || health.status !== 'orphaned') return seriesResult('unknown', 'health_inconsistent', null);
    if (health.chunkCompleted === true) return seriesResult('recovering', 'orphan_settle', null);
    const interruptions = Number.isInteger(health.interruptions) && health.interruptions > 0 ? health.interruptions : 0;
    if (interruptions + 1 >= RECOVERY_INTERRUPTION_LIMIT) return seriesResult('interrupted', 'interrupted', null);
    return seriesResult('recovering', 'orphan_resume', null);
  }
  if (record.stage === 'complete') return seriesResult('stopped', 'complete', null);
  if (RECOVERY_STOP_REASONS.includes(record.reason)) return seriesResult(record.reason === 'interrupted' ? 'interrupted' : 'stopped', record.reason, null);
  if (record.reason === 'chunk_budget' || record.reason === 'backoff' || record.stage === 'error' || record.retryAt) {
    const due = Date.parse(record.retryAt || record.nextCatchUpAt || 0);
    if (due > nowMs) return seriesResult('waiting', record.reason || (record.stage === 'error' ? 'error' : 'backoff'), due);
    return seriesResult('continuing', 'gate_passed', null);
  }
  if (record.stage === 'scheduled') return seriesResult('continuing', 'scheduled', null);
  if (record.stage === 'paused' && Number.isInteger(record.remainingChunks) && record.remainingChunks > 0) return seriesResult('continuing', 'budget_left', null);
  return seriesResult('stopped', 'budget_exhausted', null);
}

// A series stopped for a missing TMDB secret stops again on every new generation until the owner restores the
// configuration; no EPG commit or series action clears it.
function seriesNeedsOwner(series) {
  return series.state === 'stopped' && series.reason === 'missing_secret';
}

function nextFromSeries(series) {
  if (series.state === 'continuing' || series.state === 'recovering') return {actor: 'scheduled_step', at: null};
  if (series.state === 'waiting' || series.state === 'live_writer') return {actor: 'scheduled_step', at: series.at};
  if (seriesNeedsOwner(series)) return {actor: 'owner_investigation', at: null};
  if (series.state === 'interrupted' || series.state === 'stopped') return {actor: 'epg_commit', at: null};
  return {actor: 'none', at: null};
}

// Only an ordinary queue (the series runs its next step whenever it is next called) could be overtaken by a targeted
// retry. A protected wait (TMDB 429 backoff, the chunk budget, an error delay) and a live writer's lease are fences a
// retry must respect, so there it would help nothing.
function retryFromSeries(series) {
  if (series.state === 'continuing' || series.state === 'recovering') return {helps: 'only_sooner', reason: 'already_queued'};
  if (series.state === 'waiting') return {helps: 'no', reason: 'series_waiting'};
  if (series.state === 'live_writer') return {helps: 'no', reason: 'writer_active'};
  if (seriesNeedsOwner(series)) return {helps: 'no', reason: 'configuration_required'};
  if (series.state === 'interrupted' || series.state === 'stopped') return {helps: 'series_level', reason: 'series_stopped'};
  return {helps: 'unknown', reason: 'series_unknown'};
}

function decisionView(decision) {
  if (!decision) return null;
  return {
    status: recoveryText(decision.status),
    attempts: Number.isInteger(decision.attempts) ? decision.attempts : null,
    retryAt: recoveryText(decision.retryAt),
    terminalReason: recoveryText(decision.terminalReason),
    lastAttemptAt: recoveryText(decision.lastAttemptAt),
  };
}

function review(suggested, reason) {
  return {suggested, reason, target: suggested ? 'identity_review' : null, available: false, unavailableReason: suggested ? 'identity_review_not_built' : null};
}

function assessment(fields) {
  return {
    schemaVersion: DISCOVERY_RECOVERY_VERSION,
    target: fields.target,
    verdict: fields.verdict,
    reason: fields.reason,
    observation: fields.observation ?? null,
    decision: fields.decision ?? null,
    series: fields.series,
    retry: fields.retry,
    next: fields.next,
    review: fields.review ?? review(false, null),
    execute: {available: false, capability: null, reason: DISCOVERY_RECOVERY_EXECUTE_REASON},
    evidence: fields.evidence,
  };
}

function unknown(target, reason, series, missing) {
  return assessment({
    target, verdict: 'unknown', reason, series,
    retry: {helps: 'unknown', reason: 'evidence_missing'}, next: {actor: 'reread', at: null},
    evidence: {completeness: 'missing', missing, anomalies: []},
  });
}

// One observation, judged on bounded inputs the caller already read:
// {now, target: {key}, published: {programmeRunId}, observation, decision, series}
// `observation` is the candidate of the published generation's ledger for `target.key` (null when the ledger has no
// such key, undefined when not supplied): `key`, `programmeRunId`, `normalizedTitle`, `year`, `durations`, `shows`,
// `seenInLatestSnapshot`, `lastSeenAt`, `lastAiring`, `confirmedTmdbId`, and `nonfilmReason` (the screening result of
// its title, null when it passes). `decision` is the resolution ledger entry for the key (null when none). `series` is
// described at `discoverySeriesState`. Errors: `invalid_input`, `invalid_clock`, `invalid_target`.
export function assessObservationRecovery(input) {
  if (!recoveryObject(input)) return {error: 'invalid_input'};
  const nowMs = typeof input.now === 'string' ? Date.parse(input.now) : NaN;
  if (!Number.isFinite(nowMs)) return {error: 'invalid_clock'};
  const key = recoveryObject(input.target) ? recoveryText(input.target.key) : null;
  if (!key) return {error: 'invalid_target'};
  const target = {key};
  const publishedRunId = recoveryObject(input.published) ? recoveryText(input.published.programmeRunId) : null;
  const series = discoverySeriesState(input.series, publishedRunId, nowMs);
  const {observation, decision} = input;

  if (!publishedRunId) return unknown(target, 'published_not_supplied', series, ['published']);
  if (observation === undefined) return unknown(target, 'observation_not_supplied', series, ['observation']);
  if (observation === null) {
    return assessment({
      target, verdict: 'not_found', reason: 'target_absent', series,
      retry: {helps: 'unknown', reason: 'target_absent'}, next: {actor: 'none', at: null},
      evidence: {completeness: 'complete', missing: [], anomalies: []},
    });
  }
  if (!recoveryObject(observation)) return unknown(target, 'observation_malformed', series, ['observation']);
  if (observation.key !== key) return unknown(target, 'observation_key_differs', series, ['observation']);
  const observationFaults = observationShapeFaults(observation);
  if (observationFaults.length) return unknown(target, 'observation_malformed', series, observationFaults);
  if (decision === undefined) return unknown(target, 'decision_not_supplied', series, ['decision']);
  if (decision !== null && !recoveryObject(decision)) return unknown(target, 'decision_malformed', series, ['decision']);
  const decisionFaults = decision ? decisionShapeFaults(decision) : [];
  if (decisionFaults.length) return unknown(target, 'decision_malformed', series, decisionFaults);
  const observationRunId = recoveryText(observation.programmeRunId);
  if (!observationRunId) return unknown(target, 'observation_generation_missing', series, ['observation.programmeRunId']);
  if (observationRunId !== publishedRunId) {
    return assessment({
      target, verdict: 'stale_generation', reason: 'projection_generation_differs', series,
      retry: {helps: 'unknown', reason: 'generation_changed'}, next: {actor: 'reread', at: null},
      evidence: {completeness: 'partial', missing: [], anomalies: ['projection_generation_differs']},
    });
  }

  const activity = observationActivity(observation, nowMs);
  const evidenceKey = observationEvidenceKey(observation);
  const actionable = observationActionable(observation, decision, nowMs);
  const sameEvidence = !decision || !decision.evidenceKey || decision.evidenceKey === evidenceKey;
  const retryAtMs = decision?.retryAt ? Date.parse(decision.retryAt) : NaN;
  const anomalies = decision?.retryAt && !Number.isFinite(retryAtMs) ? ['retry_at_unparseable'] : [];
  const observed = {activity, actionable, evidence: !decision ? 'no_decision' : sameEvidence ? 'same' : 'changed'};
  const base = {target, observation: observed, decision: decisionView(decision), series};
  const complete = {completeness: anomalies.length ? 'partial' : 'complete', missing: [], anomalies};
  const seriesDependent = () => series.state === 'unknown'
    ? {completeness: 'partial', missing: ['series'], anomalies}
    : complete;

  if (decision?.status === 'verified') {
    return assessment({...base, verdict: 'resolved', reason: 'verified', retry: {helps: 'no', reason: 'already_resolved'}, next: {actor: 'none', at: null}, evidence: complete});
  }
  if (observation.confirmedTmdbId && (!decision || decision.status === 'excluded_nonfilm')) {
    return assessment({...base, verdict: 'queued', reason: 'known_alias', retry: retryFromSeries(series), next: nextFromSeries(series), evidence: seriesDependent()});
  }
  const nonfilm = screenedOut(observation, decision);
  if (nonfilm) {
    return assessment({...base, verdict: 'excluded_nonfilm', reason: nonfilm, retry: {helps: 'no', reason: 'not_a_film'}, next: {actor: 'none', at: null}, evidence: complete});
  }
  if (activity !== 'current') {
    return assessment({...base, verdict: 'not_current', reason: activity, retry: {helps: 'no', reason: 'not_in_current_epg'}, next: {actor: 'new_epg_evidence', at: null}, evidence: complete});
  }
  const ambiguous = decision?.status === 'ambiguous';
  if (decision?.terminalReason && sameEvidence) {
    const reason = RECOVERY_TERMINAL_REASONS.includes(decision.terminalReason) ? decision.terminalReason : 'terminal';
    return assessment({...base, verdict: 'no_more_evidence', reason, retry: {helps: 'unlikely', reason: 'unchanged_evidence'}, next: {actor: 'new_epg_evidence', at: null}, review: review(true, ambiguous ? 'identity_ambiguous' : reason), evidence: complete});
  }
  if (Number.isFinite(retryAtMs) && retryAtMs > nowMs && sameEvidence) {
    if (ambiguous) {
      return assessment({...base, verdict: 'identity_conflict', reason: 'identity_ambiguous', retry: {helps: 'unlikely', reason: 'ambiguity_needs_review'}, next: {actor: 'scheduled_step', at: recoveryIso(retryAtMs)}, review: review(true, 'identity_ambiguous'), evidence: complete});
    }
    return assessment({...base, verdict: 'backoff', reason: recoveryText(decision.status) || 'retry_waiting', retry: {helps: 'no', reason: 'backoff_is_policy'}, next: {actor: 'scheduled_step', at: recoveryIso(retryAtMs)}, evidence: complete});
  }
  if (ambiguous && sameEvidence) {
    return assessment({...base, verdict: 'identity_conflict', reason: 'identity_ambiguous', retry: {helps: 'unlikely', reason: 'ambiguity_needs_review'}, next: nextFromSeries(series), review: review(true, 'identity_ambiguous'), evidence: seriesDependent()});
  }
  const reason = !decision ? 'no_decision' : decision.status === 'excluded_nonfilm' ? 'nonfilm_recheck' : sameEvidence ? 'retry_due' : 'evidence_changed';
  return assessment({...base, verdict: 'queued', reason, retry: retryFromSeries(series), next: nextFromSeries(series), evidence: seriesDependent()});
}
