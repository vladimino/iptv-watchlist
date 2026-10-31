// The pure prediction recovery assessment of one film: every cause of the decision matrix, the order in which they are
// decided, the next expected step, the missing prerequisites and evidence, and the invariant that no targeted action
// and no writer exist. Deterministic, no I/O, never throws.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as R from '../src/domain/prediction-recovery.js';
import {DATA_HEALTH_THRESHOLDS} from '../src/domain/data-health.js';

const source = fs.readFileSync('src/domain/prediction-recovery.js', 'utf8');
assert.doesNotMatch(source, /^\s*import\s/m, 'the module imports nothing');
assert.doesNotMatch(source, /\bfetch\(|BUCKET|loadJSON|saveJSON|\.put\(|\.list\(|Date\.now|Math\.random|crypto/, 'no I/O, clock or randomness');
assert.equal(R.PREDICTION_RECOVERY_REPEATED_ATTEMPTS, DATA_HEALTH_THRESHOLDS.repeatedFailureAttempts, 'the same escalation as the data health model');
assert.equal(R.PREDICTION_RECOVERY_QUEUE_IDLE_MS, DATA_HEALTH_THRESHOLDS.queueStalledMs, 'the same idle queue threshold as the data health model');

const NOW = Date.parse('2026-10-31T09:00:00.000Z'), H = 3600000;
const iso = ms => new Date(NOW + ms).toISOString();
const diagnostic = (over = {}) => ({
  atomic: false, filmId: 'f1', lane: 'hot', eligibleNow: true, cause: 'ready',
  snapshot: {consistent: true, partial: false, reasons: []},
  fingerprint: {presence: 'recorded', current: true, usable: true, reason: 'current', migration: 'none'},
  prediction: {presence: 'recorded', current: false, stale: true, profileMatch: false, cause: 'profile_changed', reason: 'profile_changed', requiredWork: 'prediction_only'},
  index: 'agreed',
  retry: {classification: 'not_recorded', scope: null, attempts: null, failedAt: null, retryAt: null, lastRunId: null, validation: null},
  ...over,
});
const input = (over = {}) => ({
  filmId: 'f1', now: NOW, snapshotReasons: [], sources: {film: 'recorded', queue: 'recorded', profile: 'recorded'}, catalogMember: true,
  queueActivityAt: iso(-H), nominalNextRunAt: iso(20 * 60000),
  runner: {lease: 'recorded', leaseRunId: 'run-1', leaseExpiresAt: NOW - 1000, run: 'recorded', runId: 'run-1', selectedIds: ['f1'], resultIds: []},
  ...over,
  diagnostic: diagnostic(over.diagnostic),
});
const retry = (attempts, at) => ({classification: 'validation_error', scope: 'item', attempts, failedAt: iso(-2 * H), retryAt: at, lastRunId: 'run-0', validation: {stage: 'fingerprint_schema', reportedBy: 'worker', issues: [{path: 'fingerprint.moodLabels', code: 'required'}]}});
const assess = over => R.assessPredictionRecovery(input(over));
const seen = new Set();
function check(result, status, cause, next, reason) {
  assert.equal(result.status, status, cause + ' status');
  assert.equal(result.cause, cause);
  assert.equal(result.nextExpected.kind, next, cause + ' next');
  assert.equal(result.targetedAction.reason, reason, cause + ' reason');
  invariant(result);
  seen.add(cause);
  return result;
}
function invariant(result) {
  assert.equal(result.version, R.PREDICTION_RECOVERY_VERSION);
  assert.ok(R.PREDICTION_RECOVERY_STATUSES.includes(result.status), result.status);
  assert.ok(R.PREDICTION_RECOVERY_CAUSES.includes(result.cause), result.cause);
  assert.ok(R.PREDICTION_RECOVERY_NEXT.includes(result.nextExpected.kind), result.nextExpected.kind);
  assert.ok(R.PREDICTION_RECOVERY_ACTION_REASONS.includes(result.targetedAction.reason), result.targetedAction.reason);
  assert.deepEqual(result.targetedAction, {available: false, capability: null, reason: result.targetedAction.reason}, 'no targeted action is ever offered');
  assert.deepEqual(result.writer, {exists: false, decision: 'no_go'}, 'no writer exists');
  for (const code of result.missingPrerequisites) assert.ok(R.PREDICTION_RECOVERY_PREREQUISITES.includes(code), code);
  assert.ok(['complete', 'partial', 'missing'].includes(result.evidence.completeness));
  for (const code of result.evidence.missing) assert.ok(R.PREDICTION_RECOVERY_EVIDENCE.includes(code), code);
}

// 1. Current prediction, not queued: nothing to do.
check(assess({diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue', prediction: {presence: 'recorded', current: true, profileMatch: true, cause: 'current', reason: 'current', requiredWork: null}}}), 'no_action', 'prediction_current', 'none', 'not_needed');
// Kept by the selective rule under another profile version: still current, and the fact says compatible.
const compatible = check(assess({diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue', prediction: {presence: 'recorded', current: true, profileMatch: false, cause: 'compatible', reason: 'profile_compatible', requiredWork: null}}}), 'no_action', 'prediction_current', 'none', 'not_needed');
assert.equal(compatible.facts.prediction.profileCompatible, true);
assert.equal(compatible.work, null);

// 2. Queued and ready, a recent queue check: the next scheduled run takes it.
const ready = check(assess(), 'wait', 'queued_ready', 'scheduled_run', 'ordinary_schedule');
assert.equal(ready.nextExpected.at, iso(20 * 60000));
assert.equal(ready.work, 'prediction_only');
assert.equal(ready.facts.prediction.profileCompatible, false);
assert.equal(ready.evidence.completeness, 'complete');
assert.deepEqual(ready.missingPrerequisites, []);

// 3. Ready, but the queue has not been checked for more than a day: the cause is the schedule, not the film.
check(assess({queueActivityAt: iso(-25 * H)}), 'investigate', 'ready_no_runs', 'check_scheduled_tasks', 'ordinary_schedule');
check(assess({queueActivityAt: iso(-23 * H)}), 'wait', 'queued_ready', 'scheduled_run', 'ordinary_schedule');
// Unknown last activity is not proof of an idle schedule; it is missing evidence.
const noActivity = check(assess({queueActivityAt: null}), 'wait', 'queued_ready', 'scheduled_run', 'ordinary_schedule');
assert.equal(noActivity.evidence.completeness, 'partial');
assert.deepEqual(noActivity.evidence.missing, ['queue_activity']);

// 4. Cold film behind hot work.
check(assess({diagnostic: {lane: 'cold', eligibleNow: false, cause: 'waiting_behind_hot'}}), 'wait', 'waiting_behind_hot', 'hot_drain', 'ordinary_schedule');

// 5. A future retry is a valid backoff, never bypassed.
const backoff = check(assess({diagnostic: {eligibleNow: false, cause: 'retry_backoff', retry: retry(2, iso(3 * H))}}), 'wait', 'retry_backoff', 'retry_at', 'backoff_respected');
assert.equal(backoff.nextExpected.at, iso(3 * H));
assert.equal(backoff.facts.retry.validationStage, 'fingerprint_schema');
assert.equal(backoff.facts.retry.validationIssues, 1);

// 6. Repeated failures: in backoff or already due, the fix is the caller's output, not the queue.
const repeated = check(assess({diagnostic: {eligibleNow: false, cause: 'retry_backoff', retry: retry(5, iso(6 * H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'caller_contract');
assert.equal(repeated.nextExpected.at, iso(6 * H));
check(assess({diagnostic: {retry: retry(7, iso(-H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'caller_contract');
check(assess({diagnostic: {retry: retry(4, iso(-H))}}), 'wait', 'queued_ready', 'scheduled_run', 'ordinary_schedule');

// The remedy of repeated failures follows the validated failure kind: the caller's output, the infrastructure, or unknown.
const failing = (classification, at) => ({...retry(6, at), classification, validation: null});
for (const kind of ['validation_error', 'parse_error', 'format_error_storm']) {
  check(assess({diagnostic: {retry: failing(kind, iso(-H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'caller_contract');
}
for (const kind of ['storage_error', 'quota', 'time_budget', 'model_unavailable', 'api_error', 'lease_lost', 'lease_expired', 'external_termination']) {
  check(assess({diagnostic: {retry: failing(kind, iso(-H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'system_failure');
  check(assess({diagnostic: {eligibleNow: false, cause: 'retry_backoff', retry: failing(kind, iso(2 * H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'system_failure');
}
for (const kind of ['model_error', 'not_recorded', 'unknown', 'profile_changed', 'something_new']) {
  check(assess({diagnostic: {retry: failing(kind, iso(-H))}}), 'investigate', 'repeated_failures', 'owner_investigation', 'failure_unclassified');
}

// A recorded lease without a readable expiry, or a live lease of unknown owner, is unknown evidence, never "no run".
for (const expiry of [null, undefined, 'not a time', '', {}]) {
  const malformed = assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: expiry, run: 'recorded', runId: 'run-9', selectedIds: ['f1'], resultIds: []}});
  assert.equal(malformed.runner.live, null, String(expiry));
  assert.equal(malformed.runner.filmSelected, null);
  assert.equal(malformed.cause, 'queued_ready', 'an unknown lease is neither in flight nor run active');
  assert.deepEqual(malformed.evidence.missing, ['runner_lease']);
  assert.equal(malformed.evidence.completeness, 'partial');
}
const ownerless = assess({runner: {lease: 'recorded', leaseRunId: null, leaseExpiresAt: NOW + 600000, run: 'recorded', runId: 'run-9', selectedIds: ['f1'], resultIds: []}});
assert.equal(ownerless.runner.live, true);
assert.equal(ownerless.runner.filmSelected, null, 'unknown ownership does not decide whether the film is in flight');
assert.equal(ownerless.cause, 'run_active');
assert.deepEqual(ownerless.evidence.missing, ['runner_lease']);
for (const run of [{runId: null, selectedIds: ['f1'], resultIds: []}, {runId: 'run-9', selectedIds: null, resultIds: []}, {runId: 'run-9', selectedIds: ['f1'], resultIds: null}]) {
  const torn = assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: NOW + 600000, run: 'recorded', ...run}});
  assert.equal(torn.runner.filmSelected, null, JSON.stringify(run));
  assert.equal(torn.cause, 'run_active');
  assert.deepEqual(torn.evidence.missing, ['latest_run']);
}
// A malformed run whose answer is already decided (not selected) stays decided.
assert.equal(assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: NOW + 600000, run: 'recorded', runId: 'run-9', selectedIds: ['f0'], resultIds: null}}).runner.filmSelected, false);
const noRun = assess({runner: {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: NOW + 600000, run: 'not_recorded'}});
assert.equal(noRun.runner.filmSelected, false);
assert.deepEqual(noRun.evidence.missing, []);

// 7. A live run: the film in flight, or the run still to take it.
const live = {lease: 'recorded', leaseRunId: 'run-9', leaseExpiresAt: NOW + 10 * 60000, run: 'recorded', runId: 'run-9', selectedIds: ['f0', 'f1'], resultIds: ['f0']};
const flight = check(assess({runner: live}), 'wait', 'in_flight', 'run_progress', 'ordinary_schedule');
assert.deepEqual(flight.runner, {live: true, runId: 'run-9', leaseExpiresAt: iso(10 * 60000), filmSelected: true});
check(assess({runner: {...live, resultIds: ['f0', 'f1']}}), 'wait', 'run_active', 'run_progress', 'ordinary_schedule');
check(assess({runner: {...live, selectedIds: ['f0']}}), 'wait', 'run_active', 'run_progress', 'ordinary_schedule');
// A live lease of another run than the latest one does not put this film in flight.
check(assess({runner: {...live, runId: 'run-8'}}), 'wait', 'run_active', 'run_progress', 'ordinary_schedule');
// In flight is decided before backoff: a run that selected the film owns it.
check(assess({runner: live, diagnostic: {eligibleNow: false, cause: 'retry_backoff', retry: retry(1, iso(H))}}), 'wait', 'in_flight', 'run_progress', 'ordinary_schedule');
// An expired lease is no run.
const expired = assess({runner: {...live, leaseExpiresAt: NOW}});
assert.equal(expired.cause, 'queued_ready');
assert.equal(expired.runner.live, false);
assert.equal(expired.runner.runId, null);

// 8. Not current and not queued: the queue is rebuilt from the rules on the next refresh.
check(assess({diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue'}}), 'wait', 'queue_refresh_pending', 'queue_refresh', 'queue_derived');

// 9. Current but still queued: the next refresh drops it.
check(assess({diagnostic: {prediction: {presence: 'recorded', current: true, profileMatch: true, cause: 'current', reason: 'current', requiredWork: null}}}), 'wait', 'index_ahead_of_queue', 'queue_refresh', 'ordinary_schedule');

// 10. Index and film files disagree, whether the file says current or not: the index is the question.
check(assess({diagnostic: {index: 'inconsistent', lane: 'none', eligibleNow: false, cause: 'not_in_queue'}}), 'investigate', 'index_inconsistent', 'owner_investigation', 'other_subsystem');
check(assess({diagnostic: {index: 'inconsistent', prediction: {presence: 'recorded', current: true, profileMatch: true, cause: 'current', reason: 'current', requiredWork: null}}}), 'investigate', 'index_inconsistent', 'owner_investigation', 'other_subsystem');

// 11. Neither in the programme nor in the catalog: a missing identity prerequisite, not a prediction problem.
const outside = check(assess({catalogMember: false, diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue', fingerprint: {presence: 'not_recorded', current: false, usable: false, reason: 'fingerprint_missing', migration: 'full'}, prediction: {presence: 'not_recorded', current: false, profileMatch: null, cause: 'not_recorded'}}}), 'investigate', 'not_in_catalog', 'owner_investigation', 'other_subsystem');
assert.deepEqual(outside.missingPrerequisites, ['catalog_membership']);
// Unknown membership is not absence.
const unknownCatalog = assess({catalogMember: null, diagnostic: {lane: 'none', eligibleNow: false, cause: 'not_in_queue'}});
assert.equal(unknownCatalog.cause, 'queue_refresh_pending');
assert.ok(unknownCatalog.evidence.missing.includes('catalog'));

// 12. Blocked: no profile, or sources that disagree. The global index_ahead_of_queue reason does not block one film.
const noProfile = check(assess({sources: {film: 'recorded', queue: 'recorded', profile: 'not_recorded'}, diagnostic: {prediction: {presence: 'recorded', current: false, profileMatch: null, cause: 'profile_not_recorded'}}}), 'blocked', 'profile_missing', 'reread', 'evidence_incomplete');
assert.deepEqual(noProfile.missingPrerequisites, ['taste_profile']);
check(assess({sources: {film: 'recorded', queue: 'recorded', profile: 'unavailable'}}), 'blocked', 'profile_missing', 'reread', 'evidence_incomplete');
for (const reason of ['profile_version_differs', 'profile_hash_differs', 'queue_programme_differs', 'fingerprint_schema_differs', 'catalog_not_recorded']) {
  check(assess({snapshotReasons: [reason]}), 'blocked', 'snapshot_partial', 'reread', 'evidence_incomplete');
}
assert.equal(assess({snapshotReasons: ['index_ahead_of_queue']}).cause, 'queued_ready');

// 13. Unknown: film or queue unreadable, an unexpected queue state. Never a guess.
check(assess({sources: {film: 'unavailable', queue: 'recorded', profile: 'recorded'}}), 'unknown', 'film_unreadable', 'reread', 'evidence_incomplete');
check(assess({diagnostic: {fingerprint: {presence: 'unknown'}, prediction: {presence: 'unknown', cause: 'unknown'}}}), 'unknown', 'film_unreadable', 'reread', 'evidence_incomplete');
const noQueue = check(assess({sources: {film: 'recorded', queue: 'not_recorded', profile: 'recorded'}, diagnostic: {lane: 'unknown', eligibleNow: null, cause: 'unknown'}}), 'unknown', 'queue_unavailable', 'reread', 'evidence_incomplete');
assert.deepEqual(noQueue.missingPrerequisites, ['prediction_queue']);
assert.equal(noQueue.evidence.completeness, 'missing');
check(assess({sources: {film: 'recorded', queue: 'unavailable', profile: 'recorded'}}), 'unknown', 'queue_unavailable', 'reread', 'evidence_incomplete');
check(assess({diagnostic: {lane: 'pending', eligibleNow: false, cause: 'not_ready'}}), 'unknown', 'queue_state_unknown', 'reread', 'evidence_incomplete');

// 14. Unreadable lease or run: evidence is partial, the verdict does not claim a run state.
const blindRunner = assess({runner: {lease: 'unavailable', run: 'unavailable'}});
assert.equal(blindRunner.cause, 'queued_ready');
assert.equal(blindRunner.runner.live, null);
assert.equal(blindRunner.runner.filmSelected, null);
assert.deepEqual(blindRunner.evidence.missing, ['runner_lease', 'latest_run']);
assert.equal(blindRunner.evidence.completeness, 'partial');
const noLease = assess({runner: {lease: 'not_recorded', run: 'not_recorded'}});
assert.equal(noLease.runner.live, false);
assert.equal(noLease.evidence.completeness, 'complete');

// Every cause of the vocabulary is reached by the matrix.
assert.deepEqual([...seen].sort(), [...R.PREDICTION_RECOVERY_CAUSES].sort(), 'the matrix covers every cause');

// Malformed input never throws and is unknown.
for (const bad of [undefined, null, 42, {}, {filmId: 'f1'}, {filmId: 'f1', now: NOW}, {filmId: 7, now: NOW, diagnostic: {}}, {filmId: 'f1', now: 'not a time', diagnostic: {}}]) {
  const result = R.assessPredictionRecovery(bad);
  assert.equal(result.status, 'unknown');
  assert.equal(result.cause, 'film_unreadable');
  invariant(result);
}

// Deterministic and does not mutate its input.
const frozen = input({runner: live});
const deepFreeze = value => {if (value && typeof value === 'object') {Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item);} return value;};
deepFreeze(frozen);
assert.deepEqual(R.assessPredictionRecovery(frozen), R.assessPredictionRecovery(frozen));
assert.notEqual(R.assessPredictionRecovery(frozen).writer, R.PREDICTION_RECOVERY_WRITER, 'the writer statement is a copy');

console.log('Prediction recovery: every cause, decision order, next step, prerequisites, evidence, no action and no writer passed');
