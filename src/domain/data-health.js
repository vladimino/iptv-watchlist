// Data health: pure, deterministic rules that turn bounded stored projections into a sorted, deduplicated list of
// health issues. No I/O, no clock of its own: the caller passes the projections it already loaded (plain objects)
// and the instant `now` it observed them. Completeness, freshness and progress are kept apart; a retry inside its
// backoff is waiting, not stuck; missing evidence is unknown, never healthy; and there is no aggregate score.

export const DATA_HEALTH_SCHEMA_VERSION = 1;

export const DATA_HEALTH_SEVERITIES = ['critical', 'warning', 'info'];
export const DATA_HEALTH_CATEGORIES = ['conflict', 'stuck', 'stale', 'missing_asset', 'external_refresh', 'incomplete'];
export const DATA_HEALTH_SUBSYSTEMS = ['programme', 'identity', 'metadata', 'localization', 'fingerprint', 'prediction', 'prediction_queue', 'discovery', 'poster', 'letterboxd_archive'];
export const DATA_HEALTH_SUBJECT_KINDS = ['generation', 'film', 'observation', 'queue', 'continuation', 'catalog', 'archive', 'subsystem'];
export const DATA_HEALTH_ACTIONS = ['wait', 'investigate', 'bounded_action'];
export const DATA_HEALTH_ACTION_CODES = ['reread_snapshot', 'check_scheduled_tasks', 'manual_review', 'discovery_retry', 'metadata_refresh', 'prediction_retry', 'poster_hydration', 'archive_import', 'supply_evidence'];
export const DATA_HEALTH_EVIDENCE = ['complete', 'partial', 'missing'];
export const DATA_HEALTH_FRESHNESS = ['fresh', 'stale', 'unknown'];
export const DATA_HEALTH_PROGRESS = ['progressing', 'waiting', 'due', 'overdue', 'stalled', 'terminal', 'unknown', 'not_applicable'];
export const DATA_HEALTH_REASONS = [
  'evidence_not_supplied', 'evidence_object_missing', 'generation_not_published', 'generation_stale', 'pin_generation_changed',
  'projection_generation_differs', 'identity_conflict', 'identity_ambiguous', 'localization_conflict', 'queue_disagreement',
  'retry_waiting', 'retry_due', 'retry_overdue', 'backoff_beyond_policy', 'no_progress', 'terminal_without_resolution',
  'progress_unknown', 'work_pending', 'work_queued', 'repeated_failures', 'metadata_stale', 'metadata_partial', 'metadata_missing',
  'eligible_work_without_runs', 'all_deferred_by_retry', 'continuation_running_stale', 'continuation_not_advanced',
  'poster_missing', 'posters_missing', 'baseline_missing', 'baseline_age_unknown', 'baseline_stale', 'clock_skew',
];
export const DATA_HEALTH_ELIGIBILITY_REASONS = [
  'eligible', 'no_action_defined', 'in_backoff', 'awaiting_progress', 'evidence_incomplete', 'generation_changed',
  'manual_review_required', 'identity_unverified', 'terminal', 'owner_input_required', 'already_queued',
];
export const DATA_HEALTH_ANOMALIES = ['clock_skew', 'projection_generation_differs', 'duplicate_subject'];
export const DATA_HEALTH_COVERAGE = ['complete', 'partial'];
export const DATA_HEALTH_SUBSYSTEM_STATUSES = ['clear', 'clear_in_scope', 'attention', 'unknown'];
export const DATA_HEALTH_UNOBSERVED_REASONS = ['subject_not_observed', 'dimension_not_observed', 'source_not_observed', 'generation_changed'];
// The Film record fields each film subsystem reads. A field is observed when the record carries it in a usable
// shape; `undefined` (and a malformed value) is not observed, so a later incomplete projection of the same Film
// cannot resolve an issue about a field it does not carry.
export const DATA_HEALTH_FILM_FIELDS = Object.freeze({
  identity: ['identity', 'externalIds'],
  metadata: ['metadata'],
  localization: ['localizationConflicts'],
  fingerprint: ['fingerprint'],
  prediction: ['prediction'],
  poster: ['poster'],
});

const HOUR = 3600000;
const DAY = 86400000;

// Every threshold is a positive integer of milliseconds, except the two counts at the end.
export const DATA_HEALTH_THRESHOLDS = Object.freeze({
  programmeStaleMs: 36 * HOUR,          // the daily programme update missed one cycle and half of the next
  metadataFreshMs: 30 * DAY,            // the metadata freshness window of the Film lifecycle
  stalledMs: 14 * DAY,                  // no recorded progress for this long is stalled
  retryGraceMs: 2 * HOUR,               // a retry due for longer than this was not picked up by the hourly work
  predictionMaxBackoffMs: 6 * HOUR,     // the prediction retry policy caps the backoff at six hours
  discoveryMaxBackoffMs: 7 * DAY,       // the discovery retry policy caps the backoff at seven days
  metadataMaxBackoffMs: 7 * DAY,        // no stored policy; the discovery cap is the widest one in use
  queueStalledMs: 24 * HOUR,            // eligible prediction work with no run or check for a day
  continuationRunningStaleMs: 30 * 60000, // a running continuation older than twice its lease without a checkpoint
  archiveStaleMs: 60 * DAY,             // a Letterboxd baseline older than this asks for a fresh export
  skewToleranceMs: 5 * 60000,           // timestamps this far in the future are treated as now
  repeatedFailureAttempts: 5,           // this many recorded attempts escalate a waiting retry
  sampleSize: 5,                        // ids kept on an aggregate issue
});

const SEVERITY_RANK = Object.fromEntries(DATA_HEALTH_SEVERITIES.map((value, index) => [value, index]));
const CATEGORY_RANK = Object.fromEntries(DATA_HEALTH_CATEGORIES.map((value, index) => [value, index]));
const SUBSYSTEM_RANK = Object.fromEntries(DATA_HEALTH_SUBSYSTEMS.map((value, index) => [value, index]));
const SUBJECT_RANK = Object.fromEntries(DATA_HEALTH_SUBJECT_KINDS.map((value, index) => [value, index]));
const EVIDENCE_RANK = Object.fromEntries(DATA_HEALTH_EVIDENCE.map((value, index) => [value, index]));

const SNAPSHOT_SOURCES = {
  programme: 'published',
  identity: 'films',
  metadata: 'films',
  localization: 'films',
  fingerprint: 'films',
  prediction: 'films',
  poster: 'films',
  prediction_queue: 'predictionQueue',
  discovery: 'discovery',
  letterboxd_archive: 'letterboxd',
};

const SNAPSHOT_SOURCE_NAMES = ['published', 'films', 'observations', 'predictionQueue', 'discovery', 'posters', 'letterboxd'];
const LIST_SOURCES = ['films', 'observations'];

function failure(error) {
  return {error};
}

// The caller declares whether a list is the whole population or a bounded page. Undeclared is `partial`: a page
// cannot prove that a subject outside it is healthy or gone.
function coverageOf(snapshot) {
  const declared = snapshot.coverage;
  if (declared !== undefined && declared !== null && !isObject(declared)) return null;
  const coverage = {};
  for (const source of LIST_SOURCES) {
    const value = declared?.[source];
    if (value !== undefined && !DATA_HEALTH_COVERAGE.includes(value)) return null;
    coverage[source] = value ?? 'partial';
  }
  for (const key of Object.keys(declared || {})) if (!LIST_SOURCES.includes(key)) return null;
  return coverage;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A list field in a usable shape, otherwise nothing: a malformed value never proves or disproves a conflict.
function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function parseClock(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function thresholdsOf(options) {
  const supplied = options?.thresholds;
  if (supplied === undefined || supplied === null) return DATA_HEALTH_THRESHOLDS;
  if (!isObject(supplied)) return null;
  const merged = {...DATA_HEALTH_THRESHOLDS};
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(DATA_HEALTH_THRESHOLDS, key) || !Number.isInteger(value) || value <= 0) return null;
    merged[key] = value;
  }
  return Object.freeze(merged);
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en');
}

// A stable issue id: the subsystem, the category and the subject. Severity, timestamps and counts never enter it,
// so the same problem keeps its id between evaluations and can be diffed.
export function healthIssueId(subsystem, category, subject) {
  return `${subsystem}/${category}/${subject?.kind ?? 'unknown'}:${subject?.id ?? ''}`;
}

export function compareHealthIssues(left, right) {
  return (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
    || (CATEGORY_RANK[left.category] ?? 9) - (CATEGORY_RANK[right.category] ?? 9)
    || (SUBSYSTEM_RANK[left.subsystem] ?? 99) - (SUBSYSTEM_RANK[right.subsystem] ?? 99)
    || (SUBJECT_RANK[left.subject?.kind] ?? 9) - (SUBJECT_RANK[right.subject?.kind] ?? 9)
    || compareText(left.subject?.id, right.subject?.id)
    || compareText(left.id, right.id);
}

// Time facts relative to `now`. A timestamp further in the future than the tolerance is clock skew: it proves
// neither freshness nor progress, so ages derived from it are unknown.
function createClock(nowMs, thresholds) {
  const anomalies = new Set();
  function at(value) {
    const ms = parseClock(value);
    if (ms === null) return {ms: null, ageMs: null, skew: false};
    if (ms > nowMs + thresholds.skewToleranceMs) {
      anomalies.add('clock_skew');
      return {ms, ageMs: null, skew: true};
    }
    return {ms, ageMs: Math.max(0, nowMs - ms), skew: false};
  }
  function future(value) {
    const ms = parseClock(value);
    return {ms, ageMs: ms === null ? null : Math.max(0, nowMs - ms), skew: false};
  }
  function latest(...values) {
    let best = {ms: null, ageMs: null, skew: false};
    for (const value of values) {
      const current = at(value);
      if (current.ms === null) continue;
      if (current.skew) return current;
      if (best.ms === null || current.ms > best.ms) best = current;
    }
    return best;
  }
  return {nowMs, at, future, latest, anomalies};
}

function freshnessOf(moment, thresholdMs) {
  if (moment.ms === null || moment.skew) return {status: 'unknown', ageMs: null, thresholdMs};
  return {status: moment.ageMs > thresholdMs ? 'stale' : 'fresh', ageMs: moment.ageMs, thresholdMs};
}

// Progress of one retried or pending unit of work. `retryAt` in the future inside the policy cap is a valid
// backoff (waiting). A retry due for longer than the grace period was not picked up (overdue). No retry and no
// progress for longer than the stalled threshold is stalled. A terminal decision is terminal. Unknown stays unknown.
export function progressOf(facts, clock, thresholds, maxBackoffMs) {
  const retry = clock.future(facts?.retryAt);
  const last = clock.latest(facts?.lastProgressAt, facts?.lastAttemptAt, facts?.updatedAt, facts?.failedAt);
  const base = {
    retryAt: iso(retry.ms),
    lastProgressAt: iso(last.ms),
    sinceProgressMs: last.skew ? null : last.ageMs,
    attempts: Number.isInteger(facts?.attempts) && facts.attempts >= 0 ? facts.attempts : null,
    thresholdMs: null,
    skew: last.skew,
  };
  if (facts?.terminal === true) return {...base, status: 'terminal', reason: 'terminal_without_resolution'};
  if (retry.ms !== null) {
    if (retry.ms > clock.nowMs) {
      if (retry.ms - clock.nowMs > maxBackoffMs + thresholds.skewToleranceMs) return {...base, status: 'overdue', reason: 'backoff_beyond_policy', thresholdMs: maxBackoffMs};
      return {...base, status: 'waiting', reason: 'retry_waiting', thresholdMs: maxBackoffMs};
    }
    const overdueMs = clock.nowMs - retry.ms;
    if (overdueMs > thresholds.retryGraceMs) return {...base, status: 'overdue', reason: 'retry_overdue', thresholdMs: thresholds.retryGraceMs, overdueMs};
    return {...base, status: 'due', reason: 'retry_due', thresholdMs: thresholds.retryGraceMs, overdueMs};
  }
  if (last.ms === null || last.skew) return {...base, status: 'unknown', reason: 'progress_unknown'};
  if (last.ageMs > thresholds.stalledMs) return {...base, status: 'stalled', reason: 'no_progress', thresholdMs: thresholds.stalledMs};
  return {...base, status: 'progressing', reason: 'work_pending', thresholdMs: thresholds.stalledMs};
}

function sample(ids, thresholds) {
  return [...new Set(ids.map(id => String(id)))].sort(compareText).slice(0, thresholds.sampleSize);
}

function evidenceOf(completeness, source, extra) {
  return {completeness, source, missing: extra?.missing ?? [], anomalies: extra?.anomalies ?? []};
}

// One issue. Every field is explicit so a consumer never has to guess a default. An action is eligible only on
// complete evidence: a missing observation time or a skewed timestamp downgrades it to `investigate` with
// `eligible: null`; the code still names the action that would apply.
function issue(fields) {
  const subject = {kind: fields.subject.kind, id: String(fields.subject.id)};
  const action = fields.action.eligible === true && fields.evidence.completeness !== 'complete'
    ? {suggested: 'investigate', code: fields.action.code, eligible: null, reason: 'evidence_incomplete'}
    : fields.action;
  return {
    schemaVersion: DATA_HEALTH_SCHEMA_VERSION,
    id: healthIssueId(fields.subsystem, fields.category, subject),
    subsystem: fields.subsystem,
    subject,
    category: fields.category,
    severity: fields.severity,
    reason: fields.reason,
    evidence: fields.evidence,
    observedAt: fields.observedAt ?? null,
    lastProgressAt: fields.lastProgressAt ?? null,
    freshness: fields.freshness ?? {status: 'unknown', ageMs: null, thresholdMs: null},
    progress: fields.progress ?? {status: 'not_applicable', reason: null, retryAt: null, sinceProgressMs: null, attempts: null, thresholdMs: null},
    threshold: fields.threshold ?? null,
    provenance: fields.provenance,
    affected: fields.affected ?? {count: 1, sample: [subject.id]},
    action,
  };
}

function action(suggested, code, eligible, reason) {
  return {suggested, code, eligible, reason};
}

function projectionGenerationDiffers(projectionRunId, published) {
  return typeof projectionRunId === 'string' && projectionRunId && published?.programmeRunId && projectionRunId !== published.programmeRunId;
}

// The published generation pointer: phase, age and the caller's pin.
function programmeIssues(snapshot, context) {
  const {clock, thresholds, published} = context;
  const issues = [];
  if (published === null) return issues;
  const observedAt = clock.at(published.raw.observedAt);
  const pointerEvidence = evidenceOf(observedAt.ms === null ? 'partial' : 'complete', 'published', {missing: observedAt.ms === null ? ['observedAt'] : []});
  if (published.phase !== 'published' || !published.programmeRunId) {
    issues.push(issue({
      subsystem: 'programme', category: 'incomplete', severity: 'critical', reason: 'generation_not_published',
      subject: {kind: 'generation', id: published.programmeRunId || 'none'}, evidence: pointerEvidence, observedAt: iso(observedAt.ms),
      provenance: {source: 'published', programmeRunId: published.programmeRunId, phase: published.phase, rule: 'programme.phase'},
      action: action('investigate', 'reread_snapshot', false, 'evidence_incomplete'),
    }));
  } else {
    const publishedAt = clock.at(published.raw.publishedAt);
    const freshness = freshnessOf(publishedAt, thresholds.programmeStaleMs);
    if (freshness.status !== 'fresh') {
      issues.push(issue({
        subsystem: 'programme', category: freshness.status === 'stale' ? 'stale' : 'incomplete', severity: freshness.status === 'stale' ? 'warning' : 'info', reason: freshness.status === 'stale' ? 'generation_stale' : 'progress_unknown',
        subject: {kind: 'generation', id: published.programmeRunId},
        evidence: evidenceOf(publishedAt.ms === null || publishedAt.skew ? 'partial' : pointerEvidence.completeness, 'published', {missing: [...pointerEvidence.missing, ...(publishedAt.ms === null ? ['publishedAt'] : [])], anomalies: publishedAt.skew ? ['clock_skew'] : []}),
        observedAt: iso(observedAt.ms), lastProgressAt: iso(publishedAt.ms), freshness,
        threshold: {code: 'programmeStaleMs', value: thresholds.programmeStaleMs, unit: 'ms'},
        provenance: {source: 'published', programmeRunId: published.programmeRunId, rule: 'programme.age'},
        action: action('investigate', 'check_scheduled_tasks', false, 'no_action_defined'),
      }));
    }
  }
  const pin = snapshot.pin;
  if (isObject(pin) && typeof pin.programmeRunId === 'string' && pin.programmeRunId && published.programmeRunId && pin.programmeRunId !== published.programmeRunId) {
    issues.push(issue({
      subsystem: 'programme', category: 'stale', severity: 'warning', reason: 'pin_generation_changed',
      subject: {kind: 'generation', id: pin.programmeRunId}, evidence: pointerEvidence, observedAt: iso(observedAt.ms),
      provenance: {source: 'pin', programmeRunId: published.programmeRunId, pinnedProgrammeRunId: pin.programmeRunId, rule: 'programme.pin'},
      action: action('wait', 'reread_snapshot', false, 'generation_changed'),
    }));
  }
  return issues;
}

function stateFacts(state) {
  return {
    retryAt: state?.retryAt ?? null,
    updatedAt: state?.updatedAt ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    attempts: state?.attempts,
    terminal: Boolean(state?.terminalReason) || state?.status === 'rejected',
  };
}

function progressCategory(progress) {
  if (progress.status === 'overdue' || progress.status === 'stalled') return 'stuck';
  return 'incomplete';
}

function progressSeverity(progress, thresholds) {
  if (progress.status === 'overdue' || progress.status === 'stalled') return 'warning';
  if (progress.status === 'terminal' || progress.status === 'unknown') return 'warning';
  if (progress.attempts !== null && progress.attempts >= thresholds.repeatedFailureAttempts) return 'warning';
  return 'info';
}

function progressAction(progress, code, blocked) {
  if (blocked) return action('wait', 'reread_snapshot', false, blocked);
  if (progress.skew) return action('investigate', 'supply_evidence', null, 'evidence_incomplete');
  if (progress.status === 'waiting') return action('wait', code, false, 'in_backoff');
  if (progress.status === 'progressing') return action('wait', code, false, 'awaiting_progress');
  if (progress.status === 'terminal') return action('investigate', 'manual_review', false, 'terminal');
  if (progress.status === 'unknown') return action('investigate', 'supply_evidence', null, 'evidence_incomplete');
  if (progress.status === 'due' || progress.status === 'overdue') return action('bounded_action', code, true, 'eligible');
  if (progress.status === 'stalled') return action('investigate', code, true, 'eligible');
  return action('wait', code, false, 'in_backoff');
}

function reasonOf(progress, thresholds) {
  if (progress.status === 'waiting' && progress.attempts !== null && progress.attempts >= thresholds.repeatedFailureAttempts) return 'repeated_failures';
  return progress.reason;
}

function filmEvidence(record, moment, source, extra) {
  const missing = [...(extra?.missing ?? [])];
  if (moment.ms === null) missing.push('observedAt');
  const anomalies = [...(extra?.anomalies ?? [])];
  if (moment.skew) anomalies.push('clock_skew');
  return evidenceOf(missing.length || anomalies.length ? 'partial' : 'complete', source, {missing, anomalies});
}

// The lifecycle dimensions of one Film record, in the shape of the admin read contract. A `current`, `fresh`,
// `resolved` or `reviewed` dimension yields nothing.
function filmIssues(record, context) {
  const {clock, thresholds, published, queue} = context;
  const issues = [];
  const id = record.id;
  const observed = clock.at(record.observedAt);
  const generationChanged = projectionGenerationDiffers(record.programmeRunId, published);
  const blockedByGeneration = generationChanged ? 'generation_changed' : null;
  const base = extra => filmEvidence(record, observed, 'films', {missing: extra?.missing ?? [], anomalies: [...(generationChanged ? ['projection_generation_differs'] : []), ...(extra?.anomalies ?? [])]});
  const skewed = progress => progress.skew ? ['clock_skew'] : [];
  const provenance = (rule, extra) => ({source: 'films', programmeRunId: record.programmeRunId ?? null, rule, ...extra});

  const identity = record.identity;
  const externalIds = listOf(record.externalIds), localizationConflicts = listOf(record.localizationConflicts);
  const conflicting = externalIds.some(item => item?.conflicting === true) || listOf(identity?.provenance?.conflictingTmdbIds).length > 1;
  if (conflicting || identity?.status === 'ambiguous') {
    issues.push(issue({
      subsystem: 'identity', category: 'conflict', severity: 'warning', reason: conflicting ? 'identity_conflict' : 'identity_ambiguous',
      subject: {kind: 'film', id}, evidence: base(), observedAt: iso(observed.ms), lastProgressAt: iso(clock.at(identity?.updatedAt).ms),
      provenance: provenance('identity.conflict', {status: identity?.status ?? null}),
      action: action('investigate', 'manual_review', false, 'manual_review_required'),
    }));
  } else if (identity && (identity.status === 'unresolved' || identity.status === 'rejected' || identity.status === 'resolving') && identity.nextAction !== 'keep_letterboxd_id') {
    const progress = progressOf(stateFacts(identity), clock, thresholds, thresholds.discoveryMaxBackoffMs);
    issues.push(issue({
      subsystem: 'identity', category: progressCategory(progress), severity: progressSeverity(progress, thresholds), reason: reasonOf(progress, thresholds),
      subject: {kind: 'film', id}, evidence: base({missing: progress.status === 'unknown' && !progress.skew ? ['identity.updatedAt'] : [], anomalies: skewed(progress)}), observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt,
      progress, threshold: progress.thresholdMs === null ? null : {code: thresholdCode(progress, 'discoveryMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
      provenance: provenance('identity.progress', {status: identity.status, nextAction: identity.nextAction ?? null, failureReason: identity.failureReason ?? null}),
      action: progressAction(progress, 'discovery_retry', blockedByGeneration),
    }));
  }

  const metadata = record.metadata;
  if (metadata?.status === 'failed') {
    const progress = progressOf(stateFacts(metadata), clock, thresholds, thresholds.metadataMaxBackoffMs);
    issues.push(issue({
      subsystem: 'metadata', category: progressCategory(progress), severity: progressSeverity(progress, thresholds), reason: reasonOf(progress, thresholds),
      subject: {kind: 'film', id}, evidence: base({anomalies: skewed(progress)}), observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt, progress,
      threshold: progress.thresholdMs === null ? null : {code: thresholdCode(progress, 'metadataMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
      provenance: provenance('metadata.progress', {status: 'failed', failureReason: metadata.failureReason ?? null}),
      action: progressAction(progress, 'metadata_refresh', blockedByGeneration),
    }));
  } else if (metadata?.status === 'missing' || metadata?.status === 'partial' || metadata?.status === 'stale') {
    const updated = clock.at(metadata.updatedAt);
    const freshness = metadata.status === 'missing' ? {status: 'unknown', ageMs: null, thresholdMs: thresholds.metadataFreshMs}
      : metadata.status === 'stale' ? {status: 'stale', ageMs: updated.ageMs, thresholdMs: thresholds.metadataFreshMs}
      : freshnessOf(updated, thresholds.metadataFreshMs);
    issues.push(issue({
      subsystem: 'metadata', category: metadata.status === 'stale' ? 'stale' : 'incomplete', severity: metadata.status === 'missing' ? 'warning' : 'info',
      reason: metadata.status === 'stale' ? 'metadata_stale' : metadata.status === 'partial' ? 'metadata_partial' : 'metadata_missing',
      subject: {kind: 'film', id}, evidence: base(), observedAt: iso(observed.ms), lastProgressAt: iso(updated.ms), freshness,
      threshold: {code: 'metadataFreshMs', value: thresholds.metadataFreshMs, unit: 'ms'},
      provenance: provenance('metadata.status', {status: metadata.status, nextAction: metadata.nextAction ?? null}),
      action: blockedByGeneration ? action('wait', 'reread_snapshot', false, 'generation_changed') : action('bounded_action', 'metadata_refresh', true, 'eligible'),
    }));
  }

  if (localizationConflicts.length > 0) {
    issues.push(issue({
      subsystem: 'localization', category: 'conflict', severity: 'info', reason: 'localization_conflict',
      subject: {kind: 'film', id}, evidence: base(), observedAt: iso(observed.ms), lastProgressAt: iso(clock.at(record.localization?.updatedAt).ms),
      provenance: provenance('localization.conflicts', {conflicts: localizationConflicts.length}),
      affected: {count: localizationConflicts.length, sample: [id]},
      action: action('investigate', 'manual_review', false, 'manual_review_required'),
    }));
  }

  for (const dimension of ['fingerprint', 'prediction']) {
    const state = record[dimension];
    if (!state || state.status === 'current') continue;
    const queued = queue ? queue.outstanding.has(id) : null;
    const retry = queue?.retries?.[id];
    if (state.status === 'failed' || retry) {
      const facts = retry ? {retryAt: retry.retryAt ?? null, failedAt: retry.failedAt ?? null, updatedAt: state.updatedAt ?? null, attempts: retry.attempts ?? state.attempts} : stateFacts(state);
      const progress = progressOf(facts, clock, thresholds, thresholds.predictionMaxBackoffMs);
      issues.push(issue({
        subsystem: dimension, category: progressCategory(progress), severity: progressSeverity(progress, thresholds), reason: reasonOf(progress, thresholds),
        subject: {kind: 'film', id}, evidence: base({missing: queue ? [] : ['predictionQueue'], anomalies: skewed(progress)}), observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt, progress,
        threshold: progress.thresholdMs === null ? null : {code: thresholdCode(progress, 'predictionMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
        provenance: provenance(dimension + '.progress', {status: state.status, failureReason: state.failureReason ?? retry?.kind ?? null, retryScope: retry?.scope ?? null, lastRunId: retry?.lastRunId ?? null}),
        action: progressAction(progress, 'prediction_retry', blockedByGeneration),
      }));
      continue;
    }
    if (queued === false && !generationChanged) {
      const changed = clock.at(state.updatedAt);
      const refreshed = clock.latest(queue.raw.lastCheckAt, queue.raw.lastBatch?.finishedAt);
      const confirmed = changed.ms !== null && refreshed.ms !== null && !changed.skew && !refreshed.skew && refreshed.ms > changed.ms;
      issues.push(issue({
        subsystem: dimension, category: 'conflict', severity: confirmed ? 'warning' : 'info', reason: 'queue_disagreement',
        subject: {kind: 'film', id}, evidence: base({missing: confirmed ? [] : ['predictionQueue.lastCheckAt']}), observedAt: iso(observed.ms), lastProgressAt: iso(changed.ms),
        provenance: provenance(dimension + '.queue', {status: state.status, queueProgrammeRunId: queue.programmeRunId, queueRefreshedAt: iso(refreshed.ms)}),
        action: action('investigate', 'manual_review', false, 'manual_review_required'),
      }));
      continue;
    }
    const progress = progressOf({updatedAt: state.updatedAt ?? null, attempts: state.attempts}, clock, thresholds, thresholds.predictionMaxBackoffMs);
    const waiting = queued === true;
    issues.push(issue({
      subsystem: dimension, category: progress.status === 'stalled' ? 'stuck' : 'incomplete',
      severity: progress.status === 'stalled' ? 'warning' : 'info',
      reason: progress.status === 'stalled' ? 'no_progress' : waiting ? 'work_queued' : 'work_pending',
      subject: {kind: 'film', id}, evidence: base({missing: queue ? [] : ['predictionQueue'], anomalies: skewed(progress)}), observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt, progress,
      threshold: {code: 'stalledMs', value: thresholds.stalledMs, unit: 'ms'},
      provenance: provenance(dimension + '.status', {status: state.status, nextAction: state.nextAction ?? null, queued}),
      action: blockedByGeneration ? action('wait', 'reread_snapshot', false, 'generation_changed')
        : waiting ? action(progress.status === 'stalled' ? 'investigate' : 'wait', 'prediction_retry', false, 'already_queued')
        : queue ? action('investigate', 'prediction_retry', true, 'eligible')
        : action('investigate', 'supply_evidence', null, 'evidence_incomplete'),
    }));
  }

  if (record.poster === null) {
    const trusted = externalIds.some(item => item?.scheme === 'tmdb' && item.trusted === true && item.conflicting !== true);
    issues.push(issue({
      subsystem: 'poster', category: 'missing_asset', severity: 'info', reason: 'poster_missing',
      subject: {kind: 'film', id}, evidence: base(), observedAt: iso(observed.ms),
      provenance: provenance('poster.missing', {identity: identity?.status ?? null, trustedTmdb: trusted}),
      action: blockedByGeneration ? action('wait', 'reread_snapshot', false, 'generation_changed') : trusted ? action('bounded_action', 'poster_hydration', true, 'eligible') : action('investigate', 'manual_review', false, 'identity_unverified'),
    }));
  }
  return issues;
}

function thresholdCode(progress, backoffCode) {
  if (progress.reason === 'backoff_beyond_policy' || progress.status === 'waiting') return backoffCode;
  if (progress.status === 'overdue' || progress.status === 'due') return 'retryGraceMs';
  return 'stalledMs';
}

// Unresolved discovery observations: not Films. Verified and excluded entries yield nothing.
function observationIssues(entry, context) {
  const {clock, thresholds, published} = context;
  if (!isObject(entry) || typeof entry.key !== 'string' || !entry.key) return [];
  if (entry.status === 'verified' || entry.status === 'excluded_nonfilm') return [];
  const observed = clock.at(entry.observedAt);
  const generationChanged = projectionGenerationDiffers(entry.programmeRunId, published);
  const evidence = filmEvidence(entry, observed, 'observations', {anomalies: generationChanged ? ['projection_generation_differs'] : []});
  const withSkew = progress => progress.skew ? {...evidence, completeness: 'partial', anomalies: [...evidence.anomalies, 'clock_skew']} : evidence;
  const provenance = {source: 'observations', programmeRunId: entry.programmeRunId ?? null, status: entry.status ?? null, rule: 'observation.progress'};
  if (entry.status === 'ambiguous') {
    return [issue({
      subsystem: 'identity', category: 'conflict', severity: 'warning', reason: 'identity_ambiguous',
      subject: {kind: 'observation', id: entry.key}, evidence, observedAt: iso(observed.ms), lastProgressAt: iso(clock.latest(entry.lastAttemptAt, entry.checkedAt).ms),
      provenance: {...provenance, rule: 'observation.conflict'},
      action: action('investigate', 'manual_review', false, 'manual_review_required'),
    })];
  }
  const progress = progressOf({retryAt: entry.retryAt ?? null, lastAttemptAt: entry.lastAttemptAt ?? null, updatedAt: entry.checkedAt ?? null, attempts: entry.attempts, terminal: Boolean(entry.terminalReason)}, clock, thresholds, thresholds.discoveryMaxBackoffMs);
  return [issue({
    subsystem: 'identity', category: progressCategory(progress), severity: progressSeverity(progress, thresholds), reason: reasonOf(progress, thresholds),
    subject: {kind: 'observation', id: entry.key}, evidence: withSkew(progress), observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt, progress,
    threshold: progress.thresholdMs === null ? null : {code: thresholdCode(progress, 'discoveryMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
    provenance: {...provenance, terminalReason: entry.terminalReason ?? null},
    action: progressAction(progress, 'discovery_retry', generationChanged ? 'generation_changed' : null),
  })];
}

function queueView(raw) {
  if (!isObject(raw)) return null;
  const hot = Array.isArray(raw.hotPending) ? raw.hotPending : [];
  const cold = Array.isArray(raw.coldPending) ? raw.coldPending : [];
  const pending = Array.isArray(raw.pending) ? raw.pending : [];
  return {
    raw,
    programmeRunId: typeof raw.programmeRunId === 'string' ? raw.programmeRunId : null,
    outstanding: new Set([...hot, ...cold, ...pending].map(id => String(id))),
    retries: isObject(raw.retries) ? raw.retries : {},
  };
}

// The prediction queue as a whole: eligible work that nobody takes is stuck; work deferred by retries is waiting.
function queueIssues(context) {
  const {clock, thresholds, published, queue} = context;
  const issues = [];
  if (!queue) return issues;
  const observed = clock.at(queue.raw.observedAt);
  const generationChanged = projectionGenerationDiffers(queue.programmeRunId, published);
  const subject = {kind: 'queue', id: 'prediction'};
  const evidence = filmEvidence(queue.raw, observed, 'predictionQueue', {anomalies: generationChanged ? ['projection_generation_differs'] : []});
  if (generationChanged) {
    issues.push(issue({
      subsystem: 'prediction_queue', category: 'stale', severity: 'warning', reason: 'projection_generation_differs',
      subject, evidence, observedAt: iso(observed.ms), lastProgressAt: iso(clock.latest(queue.raw.lastCheckAt, queue.raw.lastBatch?.finishedAt).ms),
      provenance: {source: 'predictionQueue', programmeRunId: queue.programmeRunId, publishedProgrammeRunId: published.programmeRunId, rule: 'queue.generation'},
      affected: {count: queue.outstanding.size, sample: sample([...queue.outstanding], thresholds)},
      action: action('wait', 'reread_snapshot', false, 'generation_changed'),
    }));
  }
  const outstanding = [...queue.outstanding];
  if (!outstanding.length) return issues;
  const retryOf = id => clock.future(queue.retries[id]?.retryAt);
  const deferred = outstanding.filter(id => {const retry = retryOf(id); return retry.ms !== null && retry.ms > clock.nowMs;});
  const eligible = outstanding.filter(id => !deferred.includes(id));
  const last = clock.latest(queue.raw.lastCheckAt, queue.raw.lastBatch?.finishedAt, queue.raw.lastBatch?.startedAt);
  const progress = progressOf({lastProgressAt: last.ms === null ? null : iso(last.ms)}, clock, {...thresholds, stalledMs: thresholds.queueStalledMs}, thresholds.predictionMaxBackoffMs);
  if (eligible.length) {
    const stuck = progress.status === 'stalled';
    const unknown = progress.status === 'unknown';
    issues.push(issue({
      subsystem: 'prediction_queue', category: stuck ? 'stuck' : 'incomplete', severity: stuck || unknown ? 'warning' : 'info',
      reason: stuck ? 'eligible_work_without_runs' : unknown ? 'progress_unknown' : 'work_pending',
      subject, evidence: unknown ? evidenceOf('partial', 'predictionQueue', {missing: [...evidence.missing, 'lastCheckAt'], anomalies: evidence.anomalies}) : evidence,
      observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt, progress: {...progress, thresholdMs: thresholds.queueStalledMs},
      threshold: {code: 'queueStalledMs', value: thresholds.queueStalledMs, unit: 'ms'},
      provenance: {source: 'predictionQueue', programmeRunId: queue.programmeRunId, rule: 'queue.eligible', eligible: eligible.length, deferred: deferred.length, lastStage: queue.raw.lastBatch?.stage ?? null, lastReason: queue.raw.lastBatch?.reason ?? null},
      affected: {count: eligible.length, sample: sample(eligible, thresholds)},
      action: generationChanged ? action('wait', 'reread_snapshot', false, 'generation_changed') : stuck ? action('investigate', 'check_scheduled_tasks', false, 'no_action_defined') : unknown ? action('investigate', 'supply_evidence', null, 'evidence_incomplete') : action('wait', 'check_scheduled_tasks', false, 'already_queued'),
    }));
  } else {
    const nextRetry = deferred.map(id => retryOf(id).ms).sort((left, right) => left - right)[0];
    const beyond = nextRetry - clock.nowMs > thresholds.predictionMaxBackoffMs + thresholds.skewToleranceMs;
    issues.push(issue({
      subsystem: 'prediction_queue', category: beyond ? 'stuck' : 'incomplete', severity: beyond ? 'warning' : 'info', reason: beyond ? 'backoff_beyond_policy' : 'all_deferred_by_retry',
      subject, evidence, observedAt: iso(observed.ms), lastProgressAt: progress.lastProgressAt,
      progress: {...progress, status: beyond ? 'overdue' : 'waiting', reason: beyond ? 'backoff_beyond_policy' : 'retry_waiting', retryAt: iso(nextRetry), thresholdMs: thresholds.predictionMaxBackoffMs},
      threshold: {code: 'predictionMaxBackoffMs', value: thresholds.predictionMaxBackoffMs, unit: 'ms'},
      provenance: {source: 'predictionQueue', programmeRunId: queue.programmeRunId, rule: 'queue.deferred', eligible: 0, deferred: deferred.length},
      affected: {count: deferred.length, sample: sample(deferred, thresholds)},
      action: beyond ? action('investigate', 'manual_review', false, 'manual_review_required') : action('wait', 'prediction_retry', false, 'in_backoff'),
    }));
  }
  return issues;
}

// The discovery continuation record: a paused record whose gate has passed, an error without a retry, or a
// running record older than its lease are not advancing.
function discoveryIssues(context) {
  const {clock, thresholds, published, discovery} = context;
  if (!isObject(discovery)) return [];
  const observed = clock.at(discovery.observedAt);
  const generationChanged = projectionGenerationDiffers(discovery.programmeRunId, published);
  const subject = {kind: 'continuation', id: 'discovery'};
  const evidence = filmEvidence(discovery, observed, 'discovery', {anomalies: generationChanged ? ['projection_generation_differs'] : []});
  const at = clock.at(discovery.at);
  const provenance = rule => ({source: 'discovery', programmeRunId: discovery.programmeRunId ?? null, stage: discovery.stage ?? null, reason: discovery.reason ?? null, rule});
  if (generationChanged) {
    return [issue({
      subsystem: 'discovery', category: 'stale', severity: 'info', reason: 'projection_generation_differs',
      subject, evidence, observedAt: iso(observed.ms), lastProgressAt: iso(at.ms), provenance: provenance('discovery.generation'),
      action: action('wait', 'reread_snapshot', false, 'generation_changed'),
    })];
  }
  if (discovery.stage === 'running') {
    const freshness = freshnessOf(at, thresholds.continuationRunningStaleMs);
    if (freshness.status === 'fresh') return [];
    return [issue({
      subsystem: 'discovery', category: freshness.status === 'stale' ? 'stuck' : 'incomplete', severity: 'warning', reason: freshness.status === 'stale' ? 'continuation_running_stale' : 'progress_unknown',
      subject, evidence, observedAt: iso(observed.ms), lastProgressAt: iso(at.ms), freshness,
      progress: {status: freshness.status === 'stale' ? 'stalled' : 'unknown', reason: freshness.status === 'stale' ? 'continuation_running_stale' : 'progress_unknown', retryAt: null, sinceProgressMs: freshness.ageMs, attempts: null, thresholdMs: thresholds.continuationRunningStaleMs},
      threshold: {code: 'continuationRunningStaleMs', value: thresholds.continuationRunningStaleMs, unit: 'ms'},
      provenance: provenance('discovery.running'),
      action: action('investigate', 'manual_review', false, 'manual_review_required'),
    })];
  }
  const remaining = Number.isInteger(discovery.remainingChunks) ? discovery.remainingChunks : null;
  if (discovery.stage !== 'paused' && discovery.stage !== 'error') return [];
  if (discovery.stage === 'paused' && remaining === 0 && !discovery.retryAt) return [];
  const gate = discovery.retryAt ?? discovery.nextCatchUpAt ?? null;
  const progress = progressOf({retryAt: gate, updatedAt: discovery.at ?? null}, clock, thresholds, thresholds.discoveryMaxBackoffMs);
  const affected = {count: remaining ?? 1, sample: ['discovery']};
  if (progress.status === 'waiting' || progress.status === 'due' || progress.status === 'progressing') {
    return [issue({
      subsystem: 'discovery', category: 'incomplete', severity: 'info', reason: progress.reason,
      subject, evidence, observedAt: iso(observed.ms), lastProgressAt: iso(at.ms), progress,
      threshold: {code: thresholdCode(progress, 'discoveryMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
      provenance: provenance('discovery.gate'), affected,
      action: progress.status === 'due' ? action('wait', 'check_scheduled_tasks', false, 'already_queued') : action('wait', 'discovery_retry', false, progress.status === 'waiting' ? 'in_backoff' : 'awaiting_progress'),
    })];
  }
  const unknown = progress.status === 'unknown';
  return [issue({
    subsystem: 'discovery', category: unknown ? 'incomplete' : 'stuck', severity: 'warning',
    reason: unknown ? 'progress_unknown' : progress.reason === 'backoff_beyond_policy' ? 'backoff_beyond_policy' : 'continuation_not_advanced',
    subject, evidence: unknown ? evidenceOf('partial', 'discovery', {missing: [...evidence.missing, 'at'], anomalies: evidence.anomalies}) : evidence,
    observedAt: iso(observed.ms), lastProgressAt: iso(at.ms), progress,
    threshold: progress.thresholdMs === null ? null : {code: thresholdCode(progress, 'discoveryMaxBackoffMs'), value: progress.thresholdMs, unit: 'ms'},
    provenance: provenance('discovery.progress'), affected,
    action: unknown ? action('investigate', 'supply_evidence', null, 'evidence_incomplete') : action('investigate', 'check_scheduled_tasks', false, 'no_action_defined'),
  })];
}

// The catalog poster summary: an aggregate over the published catalog, not a per-film read.
function posterSummaryIssues(context) {
  const {clock, thresholds, published, snapshot} = context;
  const posters = snapshot.posters;
  if (!isObject(posters)) return [];
  const observed = clock.at(posters.observedAt);
  const generationChanged = projectionGenerationDiffers(posters.programmeRunId, published);
  const missing = Number.isInteger(posters.missingPoster) ? posters.missingPoster : null;
  const verified = Number.isInteger(posters.verifiedMissing) ? posters.verifiedMissing : null;
  if (missing === null) {
    return [issue({
      subsystem: 'poster', category: 'incomplete', severity: 'info', reason: 'progress_unknown',
      subject: {kind: 'catalog', id: 'published'}, evidence: evidenceOf('partial', 'posters', {missing: ['missingPoster'], anomalies: generationChanged ? ['projection_generation_differs'] : []}),
      observedAt: iso(observed.ms), provenance: {source: 'posters', programmeRunId: posters.programmeRunId ?? null, rule: 'posters.summary'},
      affected: {count: 0, sample: []}, action: action('investigate', 'supply_evidence', null, 'evidence_incomplete'),
    })];
  }
  if (missing === 0) return [];
  return [issue({
    subsystem: 'poster', category: 'missing_asset', severity: 'info', reason: 'posters_missing',
    subject: {kind: 'catalog', id: 'published'}, evidence: filmEvidence(posters, observed, 'posters', {anomalies: generationChanged ? ['projection_generation_differs'] : []}),
    observedAt: iso(observed.ms), provenance: {source: 'posters', programmeRunId: posters.programmeRunId ?? null, rule: 'posters.summary', verifiedMissing: verified, unverifiedMissing: Number.isInteger(posters.unverifiedMissing) ? posters.unverifiedMissing : null},
    affected: {count: missing, sample: sample(Array.isArray(posters.sample) ? posters.sample : [], thresholds)},
    action: generationChanged ? action('wait', 'reread_snapshot', false, 'generation_changed')
      : verified === null ? action('investigate', 'supply_evidence', null, 'evidence_incomplete')
      : verified > 0 ? action('bounded_action', 'poster_hydration', true, 'eligible')
      : action('investigate', 'manual_review', false, 'identity_unverified'),
  })];
}

// The Letterboxd baseline: the owner supplies the export, so the action is never eligible for the system alone.
function archiveIssues(context) {
  const {clock, thresholds, snapshot} = context;
  const letterboxd = snapshot.letterboxd;
  if (!isObject(letterboxd)) return [];
  const observed = clock.at(letterboxd.observedAt);
  const subject = {kind: 'archive', id: 'letterboxd'};
  const provenance = {source: 'letterboxd', sha256: typeof letterboxd.baseline?.sha256 === 'string' ? letterboxd.baseline.sha256 : null, rule: 'archive.baseline'};
  if (letterboxd.baseline === null || letterboxd.baseline === undefined) {
    return [issue({
      subsystem: 'letterboxd_archive', category: 'external_refresh', severity: 'warning', reason: 'baseline_missing',
      subject, evidence: evidenceOf(letterboxd.baseline === null ? 'complete' : 'partial', 'letterboxd', {missing: letterboxd.baseline === null ? [] : ['baseline']}),
      observedAt: iso(observed.ms), provenance, action: action('bounded_action', 'archive_import', false, 'owner_input_required'),
    })];
  }
  const confirmed = clock.at(letterboxd.baseline.confirmedAt);
  const freshness = freshnessOf(confirmed, thresholds.archiveStaleMs);
  if (freshness.status === 'fresh') return [];
  return [issue({
    subsystem: 'letterboxd_archive', category: 'external_refresh', severity: freshness.status === 'stale' ? 'warning' : 'info', reason: freshness.status === 'stale' ? 'baseline_stale' : 'baseline_age_unknown',
    subject, evidence: filmEvidence(letterboxd, observed, 'letterboxd', {missing: confirmed.ms === null ? ['baseline.confirmedAt'] : [], anomalies: confirmed.skew ? ['clock_skew'] : []}),
    observedAt: iso(observed.ms), lastProgressAt: iso(confirmed.ms), freshness,
    threshold: {code: 'archiveStaleMs', value: thresholds.archiveStaleMs, unit: 'ms'},
    provenance, action: action('bounded_action', 'archive_import', false, 'owner_input_required'),
  })];
}

// A subsystem whose projection the snapshot does not carry is unknown. `undefined` means the caller did not supply
// it; `null` means the caller read it and the stored object was absent.
function coverageIssues(context) {
  const {snapshot, clock} = context;
  const issues = [];
  for (const subsystem of DATA_HEALTH_SUBSYSTEMS) {
    const source = SNAPSHOT_SOURCES[subsystem];
    const value = snapshot[source];
    if (value !== undefined && value !== null) continue;
    const absent = value === null;
    issues.push(issue({
      subsystem, category: 'incomplete', severity: absent ? (source === 'published' ? 'critical' : 'warning') : 'info',
      reason: absent ? 'evidence_object_missing' : 'evidence_not_supplied',
      subject: {kind: 'subsystem', id: subsystem}, evidence: evidenceOf('missing', source, {missing: [source]}),
      observedAt: iso(clock.nowMs), freshness: {status: 'unknown', ageMs: null, thresholdMs: null},
      progress: {status: 'unknown', reason: 'progress_unknown', retryAt: null, sinceProgressMs: null, attempts: null, thresholdMs: null},
      provenance: {source, rule: 'coverage'}, affected: {count: 0, sample: []},
      action: action('investigate', absent ? 'reread_snapshot' : 'supply_evidence', null, 'evidence_incomplete'),
    }));
  }
  return issues;
}

// Two issues with one id describe one problem. The more severe wins; on equal severity the weaker evidence and
// the earlier input win, so a repeated record never doubles a count.
function dedupe(issues) {
  const byId = new Map();
  for (const current of issues) {
    const kept = byId.get(current.id);
    if (!kept) {
      byId.set(current.id, current);
      continue;
    }
    const keptRank = SEVERITY_RANK[kept.severity], currentRank = SEVERITY_RANK[current.severity];
    let winner = kept;
    if (currentRank < keptRank) winner = current;
    else if (currentRank === keptRank && EVIDENCE_RANK[current.evidence.completeness] > EVIDENCE_RANK[kept.evidence.completeness]) winner = current;
    byId.set(current.id, {...winner, evidence: {...winner.evidence, anomalies: [...new Set([...winner.evidence.anomalies, 'duplicate_subject'])]}});
  }
  return [...byId.values()];
}

function publishedView(raw) {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return null;
  return {raw, programmeRunId: typeof raw.programmeRunId === 'string' && raw.programmeRunId ? raw.programmeRunId : null, phase: typeof raw.phase === 'string' ? raw.phase : null};
}

// The evaluation. `snapshot.now` is the caller's clock (ISO string or milliseconds) and is required.
export function evaluateDataHealth(snapshot, options) {
  if (!isObject(snapshot)) return failure('invalid_snapshot');
  const nowMs = parseClock(snapshot.now);
  if (nowMs === null) return failure('invalid_clock');
  const thresholds = thresholdsOf(options);
  if (!thresholds) return failure('invalid_thresholds');
  if (snapshot.films !== undefined && snapshot.films !== null && !Array.isArray(snapshot.films)) return failure('invalid_films');
  if (snapshot.observations !== undefined && snapshot.observations !== null && !Array.isArray(snapshot.observations)) return failure('invalid_observations');
  const coverage = coverageOf(snapshot);
  if (!coverage) return failure('invalid_coverage');

  const clock = createClock(nowMs, thresholds);
  const published = publishedView(snapshot.published);
  const context = {snapshot, clock, thresholds, published: published ?? null, queue: queueView(snapshot.predictionQueue), discovery: snapshot.discovery};

  const collected = [];
  const filmIds = new Set(), observationKeys = new Set(), filmFields = {};
  collected.push(...coverageIssues(context));
  if (published) collected.push(...programmeIssues(snapshot, context));
  for (const record of snapshot.films || []) {
    if (!isObject(record) || typeof record.id !== 'string' || !record.id) continue;
    filmIds.add(record.id);
    filmFields[record.id] = observedFilmFields(record, filmFields[record.id]);
    collected.push(...filmIssues(record, context));
  }
  for (const entry of snapshot.observations || []) {
    if (!isObject(entry) || typeof entry.key !== 'string' || !entry.key) continue;
    observationKeys.add(entry.key);
    collected.push(...observationIssues(entry, context));
  }
  collected.push(...queueIssues(context));
  collected.push(...discoveryIssues(context));
  collected.push(...posterSummaryIssues(context));
  collected.push(...archiveIssues(context));

  const issues = dedupe(collected).sort(compareHealthIssues);
  const counts = {
    bySeverity: Object.fromEntries(DATA_HEALTH_SEVERITIES.map(value => [value, 0])),
    byCategory: Object.fromEntries(DATA_HEALTH_CATEGORIES.map(value => [value, 0])),
  };
  const sources = {};
  for (const source of SNAPSHOT_SOURCE_NAMES) {
    const value = snapshot[source];
    sources[source] = value === undefined ? 'not_supplied' : value === null ? 'object_missing' : 'observed';
  }
  const scope = {
    programmeRunId: published?.programmeRunId ?? null,
    coverage,
    sources,
    subjects: {films: [...filmIds].sort(compareText), observations: [...observationKeys].sort(compareText)},
    fields: {films: Object.fromEntries([...filmIds].sort(compareText).map(id => [id, filmFields[id]]))},
  };
  const subsystems = {};
  for (const subsystem of DATA_HEALTH_SUBSYSTEMS) {
    const evidence = sources[SNAPSHOT_SOURCES[subsystem]];
    subsystems[subsystem] = {evidence, status: evidence !== 'observed' ? 'unknown' : subsystemComplete(subsystem, scope) ? 'clear' : 'clear_in_scope', issues: 0, worst: null};
  }
  for (const item of issues) {
    counts.bySeverity[item.severity]++;
    counts.byCategory[item.category]++;
    const entry = subsystems[item.subsystem];
    entry.issues++;
    if (entry.worst === null || SEVERITY_RANK[item.severity] < SEVERITY_RANK[entry.worst]) entry.worst = item.severity;
    if (entry.evidence === 'observed') entry.status = 'attention';
  }
  return {
    schemaVersion: DATA_HEALTH_SCHEMA_VERSION,
    now: iso(nowMs),
    clock: {skewToleranceMs: thresholds.skewToleranceMs, anomalies: [...clock.anomalies].sort()},
    published: published ? {programmeRunId: published.programmeRunId, phase: published.phase, publishedAt: iso(clock.at(published.raw.publishedAt).ms)} : {programmeRunId: null, phase: null, publishedAt: null},
    scope,
    subsystems,
    counts,
    thresholds,
    issues,
  };
}

const FILM_FIELD_SHAPES = {
  identity: isObject, metadata: isObject, fingerprint: isObject, prediction: isObject,
  externalIds: Array.isArray, localizationConflicts: Array.isArray,
  poster: value => value === null || typeof value === 'string',
};

function observedFilmFields(record, previous) {
  const fields = new Set(previous || []);
  for (const [field, shape] of Object.entries(FILM_FIELD_SHAPES)) if (shape(record[field])) fields.add(field);
  return [...fields].sort(compareText);
}

// `clear` claims the whole subsystem: every list the subsystem reads must be declared complete. A bounded page
// of films can only be `clear_in_scope`.
function subsystemComplete(subsystem, scope) {
  if (SNAPSHOT_SOURCES[subsystem] === 'films') {
    if (scope.coverage.films !== 'complete') return false;
    if (subsystem === 'identity') return scope.sources.observations === 'observed' && scope.coverage.observations === 'complete';
    if (subsystem === 'poster') return scope.sources.posters === 'observed';
    return true;
  }
  return true;
}

// Two evaluations compared by issue id: what appeared, what persists, what is resolved and what merely left the
// snapshot. An issue is resolved only when its subject was observed again in the current evaluation: a film by id
// in `scope.subjects` with the fields its subsystem reads present on the record, an observation by key, a whole-object subject by its source being observed under the same
// published generation, a coverage issue by its source being observed. Anything else is `unobserved`, with the
// reason, and is not a claim of health.
export function diffHealthIssues(previous, current) {
  const before = new Map((previous?.issues || []).map(item => [item.id, item]));
  const after = new Map((current?.issues || []).map(item => [item.id, item]));
  const appeared = [], persisting = [], resolved = [], unobserved = [];
  for (const [id, item] of after) (before.has(id) ? persisting : appeared).push(item);
  for (const [id, item] of before) {
    if (after.has(id)) continue;
    const reason = unobservedReason(item, previous, current);
    if (reason) unobserved.push({reason, issue: item});
    else resolved.push(item);
  }
  const byIssue = (left, right) => compareHealthIssues(left.issue, right.issue);
  return {appeared: appeared.sort(compareHealthIssues), persisting: persisting.sort(compareHealthIssues), resolved: resolved.sort(compareHealthIssues), unobserved: unobserved.sort(byIssue)};
}

const SUBJECT_SOURCES = {generation: 'published', queue: 'predictionQueue', continuation: 'discovery', catalog: 'posters', archive: 'letterboxd'};
const GENERATION_BOUND = new Set(['generation', 'queue', 'continuation', 'catalog']);

function unobservedReason(item, previous, current) {
  const scope = current?.scope;
  const kind = item.subject?.kind;
  if (!scope) return 'source_not_observed';
  if (kind === 'film' || kind === 'observation') {
    const list = kind === 'film' ? 'films' : 'observations';
    if (scope.sources?.[list] !== 'observed') return 'source_not_observed';
    if (!(scope.subjects?.[list] || []).includes(item.subject.id)) return 'subject_not_observed';
    if (kind === 'film') {
      const observed = scope.fields?.films?.[item.subject.id] || [];
      const required = DATA_HEALTH_FILM_FIELDS[item.subsystem] || [];
      if (!required.every(field => observed.includes(field))) return 'dimension_not_observed';
    }
    return null;
  }
  if (kind === 'subsystem') return scope.sources?.[item.provenance?.source] === 'observed' ? null : 'source_not_observed';
  const source = SUBJECT_SOURCES[kind];
  if (scope.sources?.[source] !== 'observed') return 'source_not_observed';
  if (GENERATION_BOUND.has(kind)) {
    const before = previous?.scope?.programmeRunId ?? null, now = scope.programmeRunId ?? null;
    if (before !== null && now !== null && before !== now) return 'generation_changed';
  }
  return null;
}
