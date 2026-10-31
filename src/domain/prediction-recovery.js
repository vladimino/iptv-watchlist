// Prediction recovery assessment for one stored film: what is wrong with its prediction, what the system will do next
// on its own, and why no targeted action is offered. Pure: the caller passes the film diagnostic of
// src/prediction-diagnostics.js, the read status of the sources, catalogue membership, the queue's last activity and the
// runner lease and latest run it read; nothing here reads storage, keeps a clock or writes.
//
// The prediction queue is a derived projection: every queue refresh rebuilds membership from the programme, the catalog,
// the view index and the taste profile, and keeps a retry record only for a film that is still outstanding. A recorded
// retry time is the backoff policy. So no per-film write can make a film eligible sooner without bypassing that policy,
// and a per-film membership write is overwritten by the next refresh. `targetedAction.available` is therefore always
// false and `writer.exists` is false; the reason says which ordinary mechanism handles the film instead.

export const PREDICTION_RECOVERY_VERSION = 1;
export const PREDICTION_RECOVERY_STATUSES = ['no_action', 'wait', 'investigate', 'blocked', 'unknown'];
export const PREDICTION_RECOVERY_CAUSES = [
  'prediction_current', 'queued_ready', 'ready_no_runs', 'waiting_behind_hot', 'retry_backoff', 'repeated_failures',
  'in_flight', 'run_active', 'queue_refresh_pending', 'index_ahead_of_queue', 'index_inconsistent', 'not_in_catalog',
  'profile_missing', 'snapshot_partial', 'film_unreadable', 'queue_unavailable', 'queue_state_unknown',
];
export const PREDICTION_RECOVERY_NEXT = ['none', 'scheduled_run', 'check_scheduled_tasks', 'retry_at', 'hot_drain', 'run_progress', 'queue_refresh', 'owner_investigation', 'reread'];
export const PREDICTION_RECOVERY_ACTION_REASONS = ['not_needed', 'ordinary_schedule', 'backoff_respected', 'queue_derived', 'caller_contract', 'other_subsystem', 'evidence_incomplete'];
export const PREDICTION_RECOVERY_PREREQUISITES = ['taste_profile', 'prediction_queue', 'catalog_membership', 'film_state'];
export const PREDICTION_RECOVERY_REPEATED_ATTEMPTS = 5;
export const PREDICTION_RECOVERY_QUEUE_IDLE_MS = 24 * 3600000;
export const PREDICTION_RECOVERY_WRITER = Object.freeze({exists: false, decision: 'no_go'});

const RECOVERY_STATUS_OF = {
  prediction_current: 'no_action',
  queued_ready: 'wait', waiting_behind_hot: 'wait', retry_backoff: 'wait', in_flight: 'wait', run_active: 'wait', queue_refresh_pending: 'wait', index_ahead_of_queue: 'wait',
  ready_no_runs: 'investigate', repeated_failures: 'investigate', index_inconsistent: 'investigate', not_in_catalog: 'investigate',
  profile_missing: 'blocked', snapshot_partial: 'blocked',
  film_unreadable: 'unknown', queue_unavailable: 'unknown', queue_state_unknown: 'unknown',
};
const RECOVERY_ACTION_REASON_OF = {
  prediction_current: 'not_needed',
  queued_ready: 'ordinary_schedule', waiting_behind_hot: 'ordinary_schedule', in_flight: 'ordinary_schedule', run_active: 'ordinary_schedule', index_ahead_of_queue: 'ordinary_schedule', ready_no_runs: 'ordinary_schedule',
  retry_backoff: 'backoff_respected',
  queue_refresh_pending: 'queue_derived',
  repeated_failures: 'caller_contract',
  index_inconsistent: 'other_subsystem', not_in_catalog: 'other_subsystem',
  profile_missing: 'evidence_incomplete', snapshot_partial: 'evidence_incomplete', film_unreadable: 'evidence_incomplete', queue_unavailable: 'evidence_incomplete', queue_state_unknown: 'evidence_incomplete',
};
// A snapshot reason computed over every outstanding film says nothing about this one; the film's own index agreement does.
const RECOVERY_GLOBAL_REASONS = ['index_ahead_of_queue'];

function recoveryObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recoveryMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recoveryIso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

function recoveryFacts(diagnostic) {
  const fingerprint = recoveryObject(diagnostic?.fingerprint) ? diagnostic.fingerprint : {};
  const prediction = recoveryObject(diagnostic?.prediction) ? diagnostic.prediction : {};
  const retry = recoveryObject(diagnostic?.retry) ? diagnostic.retry : {};
  const validation = recoveryObject(retry.validation) ? retry.validation : null;
  return {
    fingerprint: {presence: fingerprint.presence ?? 'unknown', current: fingerprint.current ?? null, usable: fingerprint.usable ?? null, reason: fingerprint.reason ?? null, migration: fingerprint.migration ?? null},
    prediction: {
      presence: prediction.presence ?? 'unknown', current: prediction.current ?? null, profileMatch: prediction.profileMatch ?? null, cause: prediction.cause ?? 'unknown',
      reason: prediction.reason ?? null, requiredWork: prediction.requiredWork ?? null,
      profileCompatible: prediction.cause === 'current' || prediction.cause === 'compatible' ? true : prediction.cause === 'profile_changed' ? false : null,
    },
    queue: {lane: diagnostic?.lane ?? 'unknown', eligibleNow: diagnostic?.eligibleNow ?? null, cause: diagnostic?.cause ?? 'unknown'},
    retry: {
      classification: retry.classification ?? 'not_recorded', scope: retry.scope ?? null, attempts: Number.isInteger(retry.attempts) ? retry.attempts : null,
      failedAt: retry.failedAt ?? null, retryAt: retry.retryAt ?? null,
      validationStage: validation ? validation.stage ?? null : null, validationIssues: validation && Array.isArray(validation.issues) ? validation.issues.length : 0,
    },
    index: diagnostic?.index ?? 'unknown',
  };
}

// The live run as far as this film is concerned. A lease is live while its expiry is ahead of `now`; the film is in flight
// when the live lease's run selected it and has no result for it yet.
function recoveryRunner(runner, filmId, now) {
  const leaseStatus = runner?.lease === 'recorded' || runner?.lease === 'not_recorded' ? runner.lease : 'unavailable';
  const runStatus = runner?.run === 'recorded' || runner?.run === 'not_recorded' ? runner.run : 'unavailable';
  const expiresAt = recoveryMs(runner?.leaseExpiresAt);
  const live = leaseStatus === 'recorded' ? expiresAt !== null && expiresAt > now : leaseStatus === 'not_recorded' ? false : null;
  const runId = typeof runner?.leaseRunId === 'string' && runner.leaseRunId ? runner.leaseRunId : null;
  let filmSelected = null;
  if (live === false) filmSelected = false;
  else if (live === true && runStatus === 'recorded') {
    const sameRun = runId !== null && runner?.runId === runId;
    const selected = Array.isArray(runner?.selectedIds) && runner.selectedIds.map(String).includes(filmId);
    const done = Array.isArray(runner?.resultIds) && runner.resultIds.map(String).includes(filmId);
    filmSelected = sameRun && selected && !done;
  }
  return {live, runId: live ? runId : null, leaseExpiresAt: live ? recoveryIso(expiresAt) : null, filmSelected, leaseStatus, runStatus};
}

function recoveryCause(input, facts, runner, now) {
  const sources = recoveryObject(input.sources) ? input.sources : {};
  if (sources.film === 'unavailable' || (facts.fingerprint.presence === 'unknown' && facts.prediction.presence === 'unknown')) return 'film_unreadable';
  if (sources.queue === 'unavailable' || sources.queue === 'not_recorded' || facts.queue.lane === 'unknown') return 'queue_unavailable';
  if (sources.profile !== 'recorded') return 'profile_missing';
  const reasons = (Array.isArray(input.snapshotReasons) ? input.snapshotReasons : []).filter(reason => !RECOVERY_GLOBAL_REASONS.includes(reason));
  if (reasons.length) return 'snapshot_partial';
  if (runner.filmSelected === true) return 'in_flight';
  const queued = facts.queue.lane === 'hot' || facts.queue.lane === 'cold' || facts.queue.lane === 'pending';
  if (facts.prediction.current === true) {
    if (facts.index === 'inconsistent') return 'index_inconsistent';
    return queued ? 'index_ahead_of_queue' : 'prediction_current';
  }
  if (facts.index === 'inconsistent') return 'index_inconsistent';
  if (input.catalogMember === false) return 'not_in_catalog';
  if (!queued) return 'queue_refresh_pending';
  const repeated = facts.retry.attempts !== null && facts.retry.attempts >= PREDICTION_RECOVERY_REPEATED_ATTEMPTS;
  if (facts.queue.cause === 'retry_backoff') return repeated ? 'repeated_failures' : 'retry_backoff';
  if (facts.queue.cause === 'ready') {
    if (repeated) return 'repeated_failures';
    if (runner.live === true) return 'run_active';
    const activity = recoveryMs(input.queueActivityAt);
    if (activity !== null && now - activity > PREDICTION_RECOVERY_QUEUE_IDLE_MS) return 'ready_no_runs';
    return 'queued_ready';
  }
  if (facts.queue.cause === 'waiting_behind_hot') return 'waiting_behind_hot';
  return 'queue_state_unknown';
}

function recoveryNext(cause, facts, input) {
  if (cause === 'prediction_current') return {kind: 'none', at: null};
  if (cause === 'queued_ready') return {kind: 'scheduled_run', at: recoveryIso(recoveryMs(input.nominalNextRunAt))};
  if (cause === 'ready_no_runs') return {kind: 'check_scheduled_tasks', at: null};
  if (cause === 'retry_backoff') return {kind: 'retry_at', at: facts.retry.retryAt};
  if (cause === 'repeated_failures') return {kind: 'owner_investigation', at: facts.retry.retryAt};
  if (cause === 'waiting_behind_hot') return {kind: 'hot_drain', at: null};
  if (cause === 'in_flight' || cause === 'run_active') return {kind: 'run_progress', at: null};
  if (cause === 'queue_refresh_pending' || cause === 'index_ahead_of_queue') return {kind: 'queue_refresh', at: null};
  if (cause === 'index_inconsistent' || cause === 'not_in_catalog') return {kind: 'owner_investigation', at: null};
  return {kind: 'reread', at: null};
}

function recoveryPrerequisites(cause, input) {
  const sources = recoveryObject(input.sources) ? input.sources : {};
  const missing = [];
  if (sources.profile === 'not_recorded') missing.push('taste_profile');
  if (sources.queue === 'not_recorded') missing.push('prediction_queue');
  if (cause === 'not_in_catalog') missing.push('catalog_membership');
  if (cause === 'film_unreadable') missing.push('film_state');
  return missing;
}

function recoveryEvidence(cause, runner, input) {
  const missing = [];
  if (runner.leaseStatus === 'unavailable') missing.push('runner_lease');
  if (runner.runStatus === 'unavailable') missing.push('latest_run');
  if (recoveryMs(input.queueActivityAt) === null) missing.push('queue_activity');
  if (input.catalogMember !== true && input.catalogMember !== false) missing.push('catalog');
  const status = RECOVERY_STATUS_OF[cause];
  return {completeness: status === 'unknown' ? 'missing' : status === 'blocked' || missing.length ? 'partial' : 'complete', missing};
}

// One film's assessment. `input` = {filmId, now, diagnostic, snapshotReasons, sources: {film, queue, profile},
// catalogMember, queueActivityAt, nominalNextRunAt, runner: {lease, leaseRunId, leaseExpiresAt, run, runId, selectedIds,
// resultIds}}. A malformed input is an assessment with status `unknown`, never an exception.
export function assessPredictionRecovery(input) {
  const filmId = typeof input?.filmId === 'string' ? input.filmId : null;
  const now = recoveryMs(input?.now);
  const facts = recoveryFacts(input?.diagnostic);
  const safe = recoveryObject(input) ? input : {};
  if (filmId === null || now === null || !recoveryObject(input?.diagnostic)) {
    const runner = recoveryRunner(null, '', 0);
    return {
      version: PREDICTION_RECOVERY_VERSION, filmId, status: 'unknown', cause: 'film_unreadable', work: null, nextExpected: {kind: 'reread', at: null},
      targetedAction: {available: false, capability: null, reason: 'evidence_incomplete'}, writer: {...PREDICTION_RECOVERY_WRITER},
      missingPrerequisites: ['film_state'], evidence: {completeness: 'missing', missing: ['film_state']}, facts,
      runner: {live: runner.live, runId: null, leaseExpiresAt: null, filmSelected: null},
    };
  }
  const runner = recoveryRunner(safe.runner, filmId, now);
  const cause = recoveryCause(safe, facts, runner, now);
  return {
    version: PREDICTION_RECOVERY_VERSION,
    filmId,
    status: RECOVERY_STATUS_OF[cause],
    cause,
    work: facts.prediction.current === true ? null : facts.prediction.requiredWork,
    nextExpected: recoveryNext(cause, facts, safe),
    targetedAction: {available: false, capability: null, reason: RECOVERY_ACTION_REASON_OF[cause]},
    writer: {...PREDICTION_RECOVERY_WRITER},
    missingPrerequisites: recoveryPrerequisites(cause, safe),
    evidence: recoveryEvidence(cause, runner, safe),
    facts,
    runner: {live: runner.live, runId: runner.runId, leaseExpiresAt: runner.leaseExpiresAt, filmSelected: runner.filmSelected},
  };
}
