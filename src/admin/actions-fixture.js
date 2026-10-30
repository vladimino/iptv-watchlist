// Fixture exemplar of the guarded action contract: an in-memory store, an executor that obeys every check of
// src/domain/admin-actions.js, and a transport that mimics the shape a future owner route would have (GET preview,
// POST execute) without being one. Nothing here reaches R2, D1, a Scheduled Task, Access or a flag, and the Worker does
// not bundle it: only the demonstration page and the tests load it.
import {checkSubmission, defineCapability, createRegistry, previewAction, receiptOf} from '../domain/admin-actions.js';

// One synthetic capability. Its action code is the data health code it answers; its writes go to the fixture store only.
export const FIXTURE_CAPABILITY = defineCapability({
  id: 'fixture_metadata_refresh', version: 1, title: 'Обновить метаданные (демонстрация)', subjectKinds: ['film'], healthActionCode: 'metadata_refresh',
  budget: {maxRecords: 5, maxWritesPerRecord: 1, externalCallsPerRecord: 0},
  retry: {maxAttempts: 2, backoffMs: 60000},
  compensation: {kind: 'restore_before_image', guidance: 'Каждая запись хранит прежнее значение в квитанции; откат — отдельная подтверждённая операция по той же квитанции.'},
  confirmTtlMs: 10 * 60000,
});

// A store of versioned records plus the executor's own receipts and lease. `version` changes on every write, as an R2 etag does.
export function createFixtureStore(seed) {
  const records = new Map();
  for (const record of seed.records || []) records.set(record.id, {id: record.id, version: record.version, value: structuredClone(record.value ?? {})});
  return {
    pin: seed.pin, records, receipts: new Map(), inflight: new Map(), lease: null, writes: [], issues: seed.issues || [], beforeImages: new Map(),
    read(now) {
      return {pin: this.pin, now, records: [...this.records.values()].map(record => ({id: record.id, version: record.version})), issues: this.issues};
    },
  };
}

let fixtureVersionCounter = 0;
function fixtureNextVersion(id) {
  fixtureVersionCounter += 1;
  return 'v-' + id + '-' + fixtureVersionCounter;
}

// Executes one confirmed submission against the fixture store. `options.apply(record)` is the per-record write; it may
// throw (a failure) or reject with `{unknown: true}` (the write may or may not have landed). `options.signal` aborts
// between records. A repeated submission with the same idempotency key replays the stored receipt; a concurrent one
// waits for the same run; the same key with another scope is refused.
export async function executeFixtureAction(store, registry, confirmation, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const key = confirmation?.idempotencyKey;
  if (typeof key === 'string' && store.receipts.has(key)) {
    const stored = store.receipts.get(key);
    if (stored.scopeKey !== confirmation.scopeKey) return {receipt: receiptOf({confirmation, refusal: 'idempotency_conflict', outcomes: []}), replay: false};
    return {receipt: stored.receipt, replay: true};
  }
  if (typeof key === 'string' && store.inflight.has(key)) {
    const pending = store.inflight.get(key);
    if (pending.scopeKey !== confirmation.scopeKey) return {receipt: receiptOf({confirmation, refusal: 'idempotency_conflict', outcomes: []}), replay: false};
    const result = await pending.promise;
    return {receipt: result.receipt, replay: true};
  }
  const check = checkSubmission(registry, confirmation, store.read(now), {principal: options.principal});
  if (!check.ok) return {receipt: receiptOf({confirmation, refusal: check.refusal, outcomes: []}), replay: false};
  if (store.lease && store.lease.key !== key) return {receipt: receiptOf({confirmation, refusal: 'lease_held', outcomes: []}), replay: false};
  const run = (async () => {
    const fence = (store.lease?.fence ?? 0) + 1;
    store.lease = {key, fence};
    const capability = check.capability, scope = JSON.parse(confirmation.scopeKey), outcomes = [];
    let aborted = false;
    try {
      for (const target of scope.records) {
        if (options.signal?.aborted) {aborted = true; outcomes.push({id: target.id, outcome: 'not_attempted'}); continue;}
        const record = store.records.get(target.id);
        if (!record || record.version !== target.version) {outcomes.push({id: target.id, outcome: 'skipped_changed'}); continue;}
        if (store.lease?.fence !== fence) {outcomes.push({id: target.id, outcome: 'not_attempted', error: 'fence_lost'}); continue;}
        try {
          const next = options.apply ? await options.apply(structuredClone(record)) : {...record.value, refreshed: true};
          store.beforeImages.set(key + '/' + target.id, structuredClone(record.value));
          record.value = next;
          record.version = fixtureNextVersion(target.id);
          store.writes.push(target.id);
          outcomes.push({id: target.id, outcome: 'written'});
        } catch (error) {
          outcomes.push({id: target.id, outcome: error?.unknown ? 'unknown' : 'failed', error: error?.code || error?.message || 'error'});
        }
      }
    } finally {
      if (store.lease?.fence === fence) store.lease = null;
    }
    const receipt = receiptOf({confirmation, capability, startedAt: now, finishedAt: options.finishedAt ?? now, outcomes, aborted});
    store.receipts.set(key, {scopeKey: confirmation.scopeKey, receipt});
    return {receipt, replay: false};
  })();
  store.inflight.set(key, {scopeKey: confirmation.scopeKey, promise: run});
  try {return await run;} finally {store.inflight.delete(key);}
}

// The transport shape: GET only previews, POST only executes. A GET can never reach the executor, whatever it carries.
export async function fixtureActionRequest(store, registry, {method, path, body, principal, now, apply, signal}) {
  if (!principal || principal.owner !== true) return {status: 403, body: {error: 'access_denied'}};
  if (path === '/preview') {
    if (method !== 'GET') return {status: 405, body: {error: 'method_not_allowed'}};
    return {status: 200, body: previewAction(registry, body, store.read(now))};
  }
  if (path === '/execute') {
    if (method !== 'POST') return {status: 405, body: {error: 'method_not_allowed'}};
    const {receipt, replay} = await executeFixtureAction(store, registry, body, {principal, now, apply, signal});
    return {status: receipt.state === 'refused' ? (receipt.refusal === 'stale_pin' || receipt.refusal === 'record_changed' || receipt.refusal === 'eligibility_changed' || receipt.refusal === 'in_progress' || receipt.refusal === 'lease_held' || receipt.refusal === 'idempotency_conflict' ? 409 : 400) : 200, body: {...receipt, replay}};
  }
  return {status: 404, body: {error: 'not_found'}};
}

export function fixtureRegistry() {
  return createRegistry([FIXTURE_CAPABILITY]);
}

