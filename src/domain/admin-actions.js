// Guarded owner actions: the versioned contract every Data Health recovery action follows before it may write. Pure and
// deterministic: no storage, network or clock of its own. The caller passes what it read (the snapshot pin, the subject
// records with their versions, the data health issues) and the instant it read them. This module decides eligibility,
// builds a dry-run preview, issues an explicit confirmation of one exact scope with an expiry, checks a submission
// against a fresh read (pin, record versions, eligibility, confirmation, idempotency, access) and assembles the receipt
// of an execution. It never executes anything: an executor is a separate adapter that obeys the checks below, and no
// production executor exists. A confirmation here authorizes one scope of one capability, never a writer in general.

export const ADMIN_ACTION_SCHEMA_VERSION = 1;

// The state of a preview (and of the eligibility of each record in it). `eligible` alone allows a confirmation.
export const ADMIN_ACTION_PREVIEW_STATES = ['eligible', 'ineligible', 'stale', 'unsupported', 'unknown', 'empty'];
// The lifecycle of one submission, as the receipt records it.
export const ADMIN_ACTION_RUN_STATES = ['approved', 'running', 'succeeded', 'partial', 'failed', 'aborted', 'unknown', 'refused'];
// The outcome of one record inside a run. `unknown` means the executor cannot tell whether the write landed.
export const ADMIN_ACTION_RECORD_OUTCOMES = ['written', 'already_applied', 'skipped_changed', 'failed', 'unknown', 'not_attempted'];
export const ADMIN_ACTION_REFUSALS = [
  'access_denied', 'unsupported_capability', 'invalid_request', 'confirmation_missing', 'confirmation_expired', 'confirmation_mismatch',
  'stale_pin', 'record_changed', 'eligibility_changed', 'not_eligible', 'budget_exceeded', 'idempotency_conflict', 'in_progress', 'lease_held',
];
export const ADMIN_ACTION_COMPENSATION = ['none', 'restore_before_image', 'manual'];
// The only error codes a receipt may carry. An executor classifies every failure into one of these; a raw exception
// message never reaches a receipt, because it can hold a provider secret, a credentialed URL or owner data.
export const ADMIN_ACTION_ERROR_CODES = ['provider_error', 'timeout', 'rate_limited', 'conflict', 'fence_lost', 'validation_error', 'storage_error', 'aborted', 'internal_error'];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,80}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]{1,40}$/;
const TEXT_ID = /^[^\u0000-\u001f]{1,200}$/;
const DEFAULT_CONFIRM_TTL_MS = 10 * 60000;
const MAX_CONFIRM_TTL_MS = 60 * 60000;
const MAX_RECORDS = 50;
const MAX_SCOPE_KEY = 20000;
// The bounded numeric fields of a capability: [default, minimum, maximum]. Every value must be an integer in range.
const CAPABILITY_BOUNDS = Object.freeze({
  maxRecords: [10, 1, MAX_RECORDS],
  maxWritesPerRecord: [1, 1, 10],
  externalCallsPerRecord: [0, 0, 10],
  maxAttempts: [1, 1, 5],
  backoffMs: [0, 0, 7 * 86400000],
  confirmTtlMs: [DEFAULT_CONFIRM_TTL_MS, 1000, MAX_CONFIRM_TTL_MS],
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function clockOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function iso(ms) {
  return new Date(ms).toISOString();
}
function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}
// A canonical JSON text: object keys sorted, so the same scope always yields the same key.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
// A short display fingerprint of a scope key (FNV-1a, 32 bit). Matching compares the full key, never this.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

// A bounded integer field of a capability: absent takes the default; present must be an integer within the bounds.
// Strings, fractions, negatives, NaN and Infinity are rejected, so a preview's cost figures are always finite.
function boundedField(name, value) {
  const [fallback, min, max] = CAPABILITY_BOUNDS[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('invalid capability ' + name);
  return value;
}

// One capability: what it may touch and how. A capability is a declaration; registering it executes nothing.
export function defineCapability(spec) {
  if (!isObject(spec) || !CAPABILITY_ID.test(spec.id ?? '') || !Number.isInteger(spec.version) || spec.version < 1) throw new Error('invalid capability');
  if (!Array.isArray(spec.subjectKinds) || !spec.subjectKinds.length || spec.subjectKinds.some(kind => typeof kind !== 'string' || !kind)) throw new Error('invalid capability subject kinds');
  if (typeof spec.healthActionCode !== 'string' || !spec.healthActionCode) throw new Error('invalid capability action code');
  for (const [key, value] of [['budget', spec.budget], ['retry', spec.retry], ['compensation', spec.compensation]]) if (value !== undefined && !isObject(value)) throw new Error('invalid capability ' + key);
  const maxRecords = boundedField('maxRecords', spec.budget?.maxRecords);
  const maxWritesPerRecord = boundedField('maxWritesPerRecord', spec.budget?.maxWritesPerRecord);
  const externalCallsPerRecord = boundedField('externalCallsPerRecord', spec.budget?.externalCallsPerRecord);
  const maxAttempts = boundedField('maxAttempts', spec.retry?.maxAttempts);
  const backoffMs = boundedField('backoffMs', spec.retry?.backoffMs);
  const confirmTtlMs = boundedField('confirmTtlMs', spec.confirmTtlMs);
  const compensation = spec.compensation?.kind ?? 'manual';
  if (!ADMIN_ACTION_COMPENSATION.includes(compensation)) throw new Error('invalid capability compensation');
  return Object.freeze({
    id: spec.id, version: spec.version, title: String(spec.title ?? spec.id),
    subjectKinds: Object.freeze([...spec.subjectKinds]), healthActionCode: spec.healthActionCode,
    budget: Object.freeze({maxRecords, maxWritesPerRecord, externalCallsPerRecord}),
    retry: Object.freeze({maxAttempts, backoffMs, retryOutcomes: Object.freeze(['failed'])}),
    compensation: Object.freeze({kind: compensation, guidance: String(spec.compensation?.guidance ?? 'No automatic undo. Inspect the receipt and repair by hand.')}),
    confirmTtlMs,
  });
}

export function createRegistry(capabilities) {
  const byKey = new Map();
  for (const capability of capabilities || []) {
    const key = capability.id + '@' + capability.version;
    if (byKey.has(key)) throw new Error('duplicate capability ' + key);
    byKey.set(key, capability);
  }
  return Object.freeze({get: (id, version) => byKey.get(id + '@' + version) ?? null, list: () => [...byKey.values()]});
}

// The eligibility of one record from the data health issues the caller evaluated. The issue that names this
// capability's action code decides: `eligible: true` on complete evidence is eligible, `false` is ineligible with the
// model's reason, `null` is unknown. No such issue means the record has nothing for this capability to do.
// An issue counts for a record only when both its subject kind and its subject id match: an observation and a film that
// share a textual id never share evidence or eligibility.
function recordEligibility(capability, kind, record, issues) {
  const matching = issues.filter(item => item?.subject?.kind === kind && item?.subject?.id === record.id && item?.action?.code === capability.healthActionCode);
  if (!matching.length) return {status: 'ineligible', reason: 'no_issue'};
  if (matching.some(item => item.action.eligible === true && item.evidence?.completeness === 'complete')) return {status: 'eligible', reason: 'eligible', issueId: matching.find(item => item.action.eligible === true).id};
  if (matching.some(item => item.action.eligible === null)) return {status: 'unknown', reason: matching.find(item => item.action.eligible === null).action.reason || 'evidence_incomplete'};
  return {status: 'ineligible', reason: matching[0].action.reason || 'not_eligible'};
}

function validRequest(request) {
  if (!isObject(request)) return false;
  if (typeof request.capability !== 'string' || !Number.isInteger(request.version)) return false;
  if (!isObject(request.subject) || typeof request.subject.kind !== 'string' || typeof request.subject.id !== 'string') return false;
  if (typeof request.pin !== 'string' || !request.pin) return false;
  if (request.ids !== undefined && (!Array.isArray(request.ids) || request.ids.some(id => typeof id !== 'string' || !id))) return false;
  return true;
}

// Dry run. Reads nothing and writes nothing: it judges the records the caller read under `observation.pin`.
// `request`: {capability, version, subject: {kind, id}, pin, ids?}. `observation`: {pin, now, records: [{id, version}], issues}.
// The scope key names the capability, the subject, the pin and every affected record with its version; a later
// submission is accepted only for exactly this key.
export function previewAction(registry, request, observation) {
  if (!validRequest(request)) return {schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, status: 'unsupported', reason: 'invalid_request', affected: [], excluded: []};
  const capability = registry.get(request.capability, request.version);
  const base = {schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, capability: request.capability, version: request.version, subject: {kind: request.subject.kind, id: request.subject.id}, pin: request.pin};
  if (!capability) return {...base, status: 'unsupported', reason: 'unsupported_capability', affected: [], excluded: []};
  if (!capability.subjectKinds.includes(request.subject.kind)) return {...base, status: 'unsupported', reason: 'unsupported_subject', affected: [], excluded: []};
  const nowMs = clockOf(observation?.now);
  if (nowMs === null || !Array.isArray(observation?.records) || !Array.isArray(observation?.issues)) return {...base, status: 'unknown', reason: 'observation_incomplete', affected: [], excluded: []};
  if (observation.pin !== request.pin) return {...base, status: 'stale', reason: 'stale_pin', currentPin: observation.pin ?? null, affected: [], excluded: []};
  const wanted = request.ids ? new Set(request.ids) : null;
  const records = observation.records.filter(record => isObject(record) && typeof record.id === 'string' && (!wanted || wanted.has(record.id))).sort((left, right) => compareText(left.id, right.id));
  const missing = wanted ? [...wanted].filter(id => !records.some(record => record.id === id)).sort(compareText).map(id => ({id, status: 'unknown', reason: 'record_not_read'})) : [];
  const affected = [], excluded = [...missing];
  for (const record of records) {
    if (record.kind !== undefined && record.kind !== request.subject.kind) {excluded.push({id: record.id, status: 'unsupported', reason: 'subject_kind_differs'}); continue;}
    const eligibility = recordEligibility(capability, request.subject.kind, record, observation.issues);
    if (eligibility.status === 'eligible' && typeof record.version === 'string' && record.version) affected.push({id: record.id, version: record.version, issueId: eligibility.issueId});
    else if (eligibility.status === 'eligible') excluded.push({id: record.id, status: 'unknown', reason: 'version_unknown'});
    else excluded.push({id: record.id, status: eligibility.status, reason: eligibility.reason});
  }
  const budget = {records: affected.length, maxRecords: capability.budget.maxRecords, writes: affected.length * capability.budget.maxWritesPerRecord, externalCalls: affected.length * capability.budget.externalCallsPerRecord};
  const scope = {capability: capability.id, version: capability.version, subject: base.subject, pin: request.pin, records: affected.map(item => ({id: item.id, version: item.version}))};
  const scopeKey = canonical(scope);
  let status = 'eligible', reason = 'eligible';
  if (!affected.length) {
    status = excluded.some(item => item.status === 'unknown') ? 'unknown' : records.length || missing.length ? 'ineligible' : 'empty';
    reason = status === 'unknown' ? 'evidence_incomplete' : status === 'empty' ? 'no_records' : 'not_eligible';
  } else if (affected.length > capability.budget.maxRecords) {
    status = 'ineligible'; reason = 'budget_exceeded';
  }
  return {
    ...base, status, reason, observedAt: iso(nowMs),
    affected, excluded: excluded.sort((left, right) => compareText(left.id, right.id)), budget,
    scopeKey, scopeFingerprint: fingerprint(scopeKey),
    retry: capability.retry, compensation: capability.compensation, atomic: false,
    confirmTtlMs: capability.confirmTtlMs,
  };
}

// The owner's explicit confirmation of exactly one previewed scope. The checkbox the owner ticks is a UI
// acknowledgement only; what makes a confirmation binding is its **issuance**: the issuer (the server, for a live action;
// the fixture store here) keeps the confirmation it issued, and a submission is honoured only when it matches that
// record exactly. The expiry that counts is the issued one, so editing `expiresAt` in a submission changes nothing.
export function confirmAction(preview, {now, idempotencyKey, accepted}) {
  if (!isObject(preview) || preview.status !== 'eligible') return {error: 'not_eligible'};
  if (accepted !== true) return {error: 'confirmation_missing'};
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) return {error: 'invalid_request'};
  const nowMs = clockOf(now);
  if (nowMs === null) return {error: 'invalid_request'};
  return {
    schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, capability: preview.capability, version: preview.version, subject: {kind: preview.subject.kind, id: preview.subject.id}, pin: preview.pin,
    scopeKey: preview.scopeKey, scopeFingerprint: preview.scopeFingerprint, ids: preview.affected.map(item => item.id),
    idempotencyKey, confirmedAt: iso(nowMs), expiresAt: iso(nowMs + preview.confirmTtlMs),
  };
}

const CONFIRMATION_FIELDS = ['schemaVersion', 'capability', 'version', 'subject', 'pin', 'scopeKey', 'scopeFingerprint', 'ids', 'idempotencyKey', 'confirmedAt', 'expiresAt'];

function isText(value, pattern = TEXT_ID) {
  return typeof value === 'string' && pattern.test(value);
}

// A submitted confirmation is untrusted input. Every field is checked for type and range, and the scope key must parse
// to exactly the canonical scope it claims (same capability, version, subject and pin, one record per id, in order,
// re-serialized byte for byte). Anything else is `invalid_request`; this function never throws.
export function validateConfirmation(confirmation) {
  if (!isObject(confirmation)) return null;
  if (Object.keys(confirmation).some(key => !CONFIRMATION_FIELDS.includes(key))) return null;
  const {capability, version, subject, pin, scopeKey, ids, idempotencyKey} = confirmation;
  if (confirmation.schemaVersion !== ADMIN_ACTION_SCHEMA_VERSION) return null;
  if (!isText(capability, CAPABILITY_ID) || !Number.isInteger(version) || version < 1) return null;
  if (!isObject(subject) || Object.keys(subject).length !== 2 || !isText(subject.kind) || !isText(subject.id)) return null;
  if (!isText(pin) || !isText(idempotencyKey, IDEMPOTENCY_KEY)) return null;
  if (!isText(confirmation.scopeFingerprint, /^[0-9a-f]{8}$/)) return null;
  if (clockOf(confirmation.confirmedAt) === null || clockOf(confirmation.expiresAt) === null) return null;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_RECORDS || ids.some(id => !isText(id)) || new Set(ids).size !== ids.length) return null;
  if (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > MAX_SCOPE_KEY) return null;
  let scope;
  try {scope = JSON.parse(scopeKey);} catch {return null;}
  if (!isObject(scope) || canonical(scope) !== scopeKey) return null;
  if (Object.keys(scope).sort().join(',') !== 'capability,pin,records,subject,version') return null;
  if (scope.capability !== capability || scope.version !== version || scope.pin !== pin) return null;
  if (!isObject(scope.subject) || scope.subject.kind !== subject.kind || scope.subject.id !== subject.id || Object.keys(scope.subject).length !== 2) return null;
  if (!Array.isArray(scope.records) || scope.records.length !== ids.length) return null;
  for (let index = 0; index < ids.length; index++) {
    const record = scope.records[index];
    if (!isObject(record) || Object.keys(record).length !== 2 || record.id !== ids[index] || !isText(record.version)) return null;
  }
  if (fingerprint(scopeKey) !== confirmation.scopeFingerprint) return null;
  return {capability, version, subject, pin, scopeKey, ids, idempotencyKey, records: scope.records};
}

// The issued record and the submission must agree on every bound field; the issued expiry is the one enforced.
function sameIssuance(issued, confirmation) {
  return CONFIRMATION_FIELDS.every(key => canonical(issued[key]) === canonical(confirmation[key]));
}

// The checks every submission passes against a fresh read made at submission time, in this order. The first failure
// refuses the whole submission before any write; no input makes it throw. `principal` is what the Access-verified
// request says about the caller; `issued` is the issuer's own record of the confirmation with this idempotency key.
export function checkSubmission(registry, confirmation, fresh, {principal, issued} = {}) {
  if (!isObject(principal) || principal.owner !== true) return {ok: false, refusal: 'access_denied'};
  if (confirmation === undefined || confirmation === null) return {ok: false, refusal: 'confirmation_missing'};
  const submitted = validateConfirmation(confirmation);
  if (!submitted) return {ok: false, refusal: 'invalid_request'};
  const capability = registry.get(submitted.capability, submitted.version);
  if (!capability) return {ok: false, refusal: 'unsupported_capability'};
  if (!isObject(issued) || !validateConfirmation(issued)) return {ok: false, refusal: 'confirmation_missing'};
  if (!sameIssuance(issued, confirmation)) return {ok: false, refusal: 'confirmation_mismatch'};
  const nowMs = clockOf(fresh?.now), expires = clockOf(issued.expiresAt);
  if (nowMs === null || !Array.isArray(fresh?.records) || !Array.isArray(fresh?.issues)) return {ok: false, refusal: 'invalid_request'};
  if (nowMs > expires) return {ok: false, refusal: 'confirmation_expired'};
  if (fresh.pin !== submitted.pin) return {ok: false, refusal: 'stale_pin'};
  const versions = new Map(fresh.records.filter(record => isObject(record) && typeof record.id === 'string').map(record => [record.id, record.version]));
  if (submitted.records.some(record => versions.get(record.id) !== record.version)) return {ok: false, refusal: 'record_changed'};
  const again = previewAction(registry, {capability: submitted.capability, version: submitted.version, subject: submitted.subject, pin: submitted.pin, ids: submitted.ids}, fresh);
  if (again.status === 'stale') return {ok: false, refusal: 'stale_pin'};
  if (again.status === 'ineligible' && again.reason === 'budget_exceeded') return {ok: false, refusal: 'budget_exceeded'};
  if (again.status !== 'eligible' || again.scopeKey !== submitted.scopeKey) return {ok: false, refusal: 'eligibility_changed'};
  return {ok: true, capability, preview: again, scope: submitted};
}

// An error as a receipt may show it: one code of the closed vocabulary, never the message.
export function actionErrorCode(error) {
  const code = typeof error === 'string' ? error : error?.code;
  return ADMIN_ACTION_ERROR_CODES.includes(code) ? code : 'internal_error';
}

// The receipt of one submission. `outcomes` is one entry per confirmed record; nothing is claimed for records the run
// did not reach. The run state follows from the outcomes, never from a hope: any `unknown` record makes the run
// `unknown`, a mix of written and not written is `partial`. Only validated fields of the confirmation are echoed, errors
// are codes of the closed vocabulary, and no credential, token, message or identity enters a receipt.
export function receiptOf({confirmation, capability, startedAt, finishedAt, outcomes, aborted = false, refusal = null}) {
  const valid = validateConfirmation(confirmation);
  const entries = (outcomes || []).filter(entry => ADMIN_ACTION_RECORD_OUTCOMES.includes(entry?.outcome));
  const counts = Object.fromEntries(ADMIN_ACTION_RECORD_OUTCOMES.map(value => [value, 0]));
  for (const entry of entries) counts[entry.outcome]++;
  const total = entries.length;
  const done = counts.written + counts.already_applied;
  let state;
  if (refusal) state = 'refused';
  else if (counts.unknown) state = 'unknown';
  else if (total && done === total) state = 'succeeded';
  else if (aborted) state = 'aborted';
  else if (done) state = 'partial';
  else state = 'failed';
  const retryable = entries.filter(entry => capability?.retry.retryOutcomes.includes(entry.outcome) || entry.outcome === 'not_attempted').map(entry => String(entry.id));
  return {
    schemaVersion: ADMIN_ACTION_SCHEMA_VERSION,
    idempotencyKey: valid?.idempotencyKey ?? null, capability: valid?.capability ?? null, version: valid?.version ?? null,
    subject: valid ? {kind: valid.subject.kind, id: valid.subject.id} : null, pin: valid?.pin ?? null, scopeFingerprint: valid ? confirmation.scopeFingerprint : null,
    state, refusal: refusal && ADMIN_ACTION_REFUSALS.includes(refusal) ? refusal : refusal ? 'invalid_request' : null, atomic: false, startedAt: startedAt ?? null, finishedAt: finishedAt ?? null,
    outcomes: entries.map(entry => ({id: String(entry.id), outcome: entry.outcome, ...(entry.error !== undefined ? {error: actionErrorCode(entry.error)} : {})})),
    counts,
    retry: {retryable: state === 'unknown' ? [] : retryable, maxAttempts: capability?.retry.maxAttempts ?? 0, note: state === 'unknown' ? 'An unknown outcome is never retried blindly: read the records again first.' : null},
    compensation: capability?.compensation ?? null,
    audit: {actor: 'owner', confirmedAt: valid ? confirmation.confirmedAt : null},
  };
}

export const ADMIN_ACTION_LIMITS = Object.freeze({maxRecords: MAX_RECORDS, maxScopeKey: MAX_SCOPE_KEY, idempotencyKey: IDEMPOTENCY_KEY.source, capability: CAPABILITY_BOUNDS});
