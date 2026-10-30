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

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,80}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]{1,40}$/;
const DEFAULT_CONFIRM_TTL_MS = 10 * 60000;
const MAX_CONFIRM_TTL_MS = 60 * 60000;
const MAX_RECORDS = 50;

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

// One capability: what it may touch and how. A capability is a declaration; registering it executes nothing.
export function defineCapability(spec) {
  if (!isObject(spec) || !CAPABILITY_ID.test(spec.id ?? '') || !Number.isInteger(spec.version) || spec.version < 1) throw new Error('invalid capability');
  if (!Array.isArray(spec.subjectKinds) || !spec.subjectKinds.length) throw new Error('invalid capability subject kinds');
  if (typeof spec.healthActionCode !== 'string' || !spec.healthActionCode) throw new Error('invalid capability action code');
  const maxRecords = spec.budget?.maxRecords ?? 10;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new Error('invalid capability budget');
  const maxAttempts = spec.retry?.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('invalid capability retry');
  const compensation = spec.compensation?.kind ?? 'manual';
  if (!ADMIN_ACTION_COMPENSATION.includes(compensation)) throw new Error('invalid capability compensation');
  const confirmTtlMs = spec.confirmTtlMs ?? DEFAULT_CONFIRM_TTL_MS;
  if (!Number.isInteger(confirmTtlMs) || confirmTtlMs < 1000 || confirmTtlMs > MAX_CONFIRM_TTL_MS) throw new Error('invalid capability confirmation ttl');
  return Object.freeze({
    id: spec.id, version: spec.version, title: String(spec.title ?? spec.id),
    subjectKinds: Object.freeze([...spec.subjectKinds]), healthActionCode: spec.healthActionCode,
    budget: Object.freeze({maxRecords, maxWritesPerRecord: spec.budget?.maxWritesPerRecord ?? 1, externalCallsPerRecord: spec.budget?.externalCallsPerRecord ?? 0}),
    retry: Object.freeze({maxAttempts, backoffMs: spec.retry?.backoffMs ?? 0, retryOutcomes: Object.freeze(['failed'])}),
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
function recordEligibility(capability, record, issues) {
  const matching = issues.filter(item => item?.subject?.id === record.id && item?.action?.code === capability.healthActionCode);
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
    const eligibility = recordEligibility(capability, record, observation.issues);
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

// The owner's explicit confirmation of exactly one previewed scope. It is a value the page holds and sends back with
// the submission; it carries no credential and grants nothing outside its scope and its expiry.
export function confirmAction(preview, {now, idempotencyKey, accepted}) {
  if (!isObject(preview) || preview.status !== 'eligible') return {error: 'not_eligible'};
  if (accepted !== true) return {error: 'confirmation_missing'};
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) return {error: 'invalid_request'};
  const nowMs = clockOf(now);
  if (nowMs === null) return {error: 'invalid_request'};
  return {
    schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, capability: preview.capability, version: preview.version, subject: preview.subject, pin: preview.pin,
    scopeKey: preview.scopeKey, scopeFingerprint: preview.scopeFingerprint, ids: preview.affected.map(item => item.id),
    idempotencyKey, confirmedAt: iso(nowMs), expiresAt: iso(nowMs + preview.confirmTtlMs),
  };
}

// The checks every submission passes against a fresh read made at submission time, in this order. The first failure
// refuses the whole submission before any write. `principal` is what the Access-verified request says about the caller.
export function checkSubmission(registry, confirmation, fresh, {principal} = {}) {
  if (!isObject(principal) || principal.owner !== true) return {ok: false, refusal: 'access_denied'};
  if (!isObject(confirmation)) return {ok: false, refusal: 'confirmation_missing'};
  if (typeof confirmation.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(confirmation.idempotencyKey)) return {ok: false, refusal: 'invalid_request'};
  const capability = registry.get(confirmation.capability, confirmation.version);
  if (!capability) return {ok: false, refusal: 'unsupported_capability'};
  const nowMs = clockOf(fresh?.now), expires = clockOf(confirmation.expiresAt);
  if (nowMs === null || expires === null) return {ok: false, refusal: 'invalid_request'};
  if (nowMs > expires) return {ok: false, refusal: 'confirmation_expired'};
  if (fresh.pin !== confirmation.pin) return {ok: false, refusal: 'stale_pin'};
  const again = previewAction(registry, {capability: confirmation.capability, version: confirmation.version, subject: confirmation.subject, pin: confirmation.pin, ids: confirmation.ids}, fresh);
  if (again.status === 'stale') return {ok: false, refusal: 'stale_pin'};
  const versions = new Map((fresh.records || []).map(record => [record.id, record.version]));
  if (confirmation.ids.some(id => versions.get(id) === undefined)) return {ok: false, refusal: 'record_changed'};
  const parsed = JSON.parse(confirmation.scopeKey);
  if (parsed.records.some(record => versions.get(record.id) !== record.version)) return {ok: false, refusal: 'record_changed'};
  if (again.status === 'ineligible' && again.reason === 'budget_exceeded') return {ok: false, refusal: 'budget_exceeded'};
  if (again.scopeKey !== confirmation.scopeKey) return {ok: false, refusal: 'eligibility_changed'};
  return {ok: true, capability, preview: again};
}

// The receipt of one submission. `outcomes` is one entry per confirmed record; nothing is claimed for records the run
// did not reach. The run state follows from the outcomes, never from a hope: any `unknown` record makes the run
// `unknown`, a mix of written and not written is `partial`. No credential, token or identity enters a receipt.
export function receiptOf({confirmation, capability, startedAt, finishedAt, outcomes, aborted = false, refusal = null}) {
  const counts = Object.fromEntries(ADMIN_ACTION_RECORD_OUTCOMES.map(value => [value, 0]));
  for (const entry of outcomes || []) counts[entry.outcome]++;
  const total = (outcomes || []).length;
  const done = counts.written + counts.already_applied;
  let state;
  if (refusal) state = 'refused';
  else if (counts.unknown) state = 'unknown';
  else if (total && done === total) state = 'succeeded';
  else if (aborted) state = 'aborted';
  else if (done) state = 'partial';
  else state = 'failed';
  const retryable = (outcomes || []).filter(entry => capability?.retry.retryOutcomes.includes(entry.outcome) || entry.outcome === 'not_attempted').map(entry => entry.id);
  return {
    schemaVersion: ADMIN_ACTION_SCHEMA_VERSION,
    idempotencyKey: confirmation?.idempotencyKey ?? null, capability: confirmation?.capability ?? null, version: confirmation?.version ?? null,
    subject: confirmation?.subject ?? null, pin: confirmation?.pin ?? null, scopeFingerprint: confirmation?.scopeFingerprint ?? null,
    state, refusal, atomic: false, startedAt: startedAt ?? null, finishedAt: finishedAt ?? null,
    outcomes: (outcomes || []).map(entry => ({id: entry.id, outcome: entry.outcome, ...(entry.error ? {error: String(entry.error).slice(0, 120)} : {})})),
    counts,
    retry: {retryable: state === 'unknown' ? [] : retryable, maxAttempts: capability?.retry.maxAttempts ?? 0, note: state === 'unknown' ? 'An unknown outcome is never retried blindly: read the records again first.' : null},
    compensation: capability?.compensation ?? null,
    audit: {actor: 'owner', confirmedAt: confirmation?.confirmedAt ?? null},
  };
}

export const ADMIN_ACTION_LIMITS = Object.freeze({maxRecords: MAX_RECORDS, defaultConfirmTtlMs: DEFAULT_CONFIRM_TTL_MS, maxConfirmTtlMs: MAX_CONFIRM_TTL_MS, idempotencyKey: IDEMPOTENCY_KEY.source});
