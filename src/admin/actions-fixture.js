// Fixture exemplar of the guarded action contract: an in-memory store, an executor that obeys every check of
// src/domain/admin-actions.js, and a transport that mimics the shape a future owner route would have (GET preview,
// POST execute) without being one. Nothing here reaches R2, D1, a Scheduled Task, Access or a flag, and the Worker does
// not bundle it: only the demonstration page and the tests load it.
import {actionErrorCode, checkSubmission, confirmAction, defineCapability, createRegistry, previewAction, receiptOf} from '../domain/admin-actions.js';

// One synthetic capability. Its action code is the data health code it answers; its writes go to the fixture store only.
export const FIXTURE_CAPABILITY = defineCapability({
  id: 'fixture_metadata_refresh', version: 1, title: 'Обновить метаданные (демонстрация)', subjectKinds: ['film'], healthActionCode: 'metadata_refresh',
  budget: {maxRecords: 5, maxWritesPerRecord: 1, externalCallsPerRecord: 0},
  retry: {maxAttempts: 2, backoffMs: 60000},
  compensation: {kind: 'restore_before_image', guidance: 'Каждая запись хранит прежнее значение в квитанции; откат — отдельная подтверждённая операция по той же квитанции.'},
  confirmTtlMs: 10 * 60000,
});

// The display descriptor of the synthetic capability: the human contract src/admin/actions-presentation.js renders.
// It must agree with FIXTURE_CAPABILITY (id, version, action code, subject kind, compensation) or the panel refuses to
// explain, and therefore to confirm, anything.
export const FIXTURE_DESCRIPTOR = Object.freeze({
  capability: 'fixture_metadata_refresh', version: 1, healthActionCode: 'metadata_refresh', subjectKind: 'film', compensation: 'restore_before_image',
  simulation: true,
  title: 'Проверка перед обновлением метаданных',
  noun: {one: 'тестовый фильм', few: 'тестовых фильма', many: 'тестовых фильмов', ofOne: 'тестового фильма', ofMany: 'тестовых фильмов'},
  subjectLabel: 'тестовый фильм «{name}»',
  problem: 'У некоторых фильмов метаданные — описание, год, жанры, длительность — отсутствуют, заполнены не полностью или давно не обновлялись. Из-за этого на сайте видны неполные или старые сведения.',
  change: 'Для каждого фильма из списка ниже заново получим карточку метаданных и сохраним её вместо прежней.',
  fields: ['описание', 'год выпуска', 'жанры', 'длительность'],
  untouched: 'Название, оценки, прогнозы и расписание эфира не меняются.',
  effect: 'После изменения у фильма будет полная и свежая карточка метаданных.',
  simulationNote: 'В тренажёре изменение только моделируется: меняется копия данных в памяти этой вкладки. Реальные фильмы и сайт не затрагиваются.',
  externalCalls: null,
  risks: [
    'Обновление отдельного фильма может завершиться ошибкой — тогда этот фильм не изменится, а остальные продолжат обновляться.',
    'Сохранение может прерваться так, что неизвестно, применилось ли изменение. Такой фильм нельзя повторять вслепую — сначала проверьте его карточку.',
  ],
  cta: 'Смоделировать изменение',
  confirm: 'Подтверждаю: смоделировать обновление метаданных для {count} — {names}. Понимаю, что часть фильмов может не обновиться; результат будет показан по каждому.',
});

let fixtureVersionCounter = 0;
function fixtureNextVersion(id) {
  fixtureVersionCounter += 1;
  return 'v-' + id + '-' + fixtureVersionCounter;
}

// A store of versioned records plus the executor's receipts, the issued confirmations and the lease. `version` changes
// on every write, as an R2 etag does. `commit` is the only way the executor writes: a compare-and-swap on the record
// version and the lease fence in one synchronous step, so nothing can change either between the check and the write.
export function createFixtureStore(seed) {
  const records = new Map();
  for (const record of seed.records || []) records.set(record.id, {id: record.id, version: record.version, value: structuredClone(record.value ?? {})});
  return {
    pin: seed.pin, records, receipts: new Map(), inflight: new Map(), issued: new Map(), lease: null, writes: [], issues: seed.issues || [], beforeImages: new Map(),
    read(now) {
      return {pin: this.pin, now, records: [...this.records.values()].map(record => ({id: record.id, version: record.version})), issues: this.issues};
    },
    commit(id, expectedVersion, fence, value, beforeKey) {
      if (this.lease?.fence !== fence) return 'fence_lost';
      const record = this.records.get(id);
      if (!record || record.version !== expectedVersion) return 'changed';
      this.beforeImages.set(beforeKey, structuredClone(record.value));
      record.value = structuredClone(value);
      record.version = fixtureNextVersion(id);
      this.writes.push(id);
      return 'written';
    },
    revokeLease() {
      if (this.lease) this.lease = {key: null, fence: this.lease.fence + 1};
    },
  };
}

// The issuer side of a confirmation: the store keeps exactly what it issued, keyed by idempotency key. A live action
// would keep the same record server side (or sign it with a server key); the page only ever holds a copy.
export function issueFixtureConfirmation(store, preview, options) {
  const confirmation = confirmAction(preview, options);
  if (confirmation.error) return confirmation;
  if (store.issued.has(confirmation.idempotencyKey)) return {error: 'idempotency_conflict'};
  store.issued.set(confirmation.idempotencyKey, Object.freeze(structuredClone(confirmation)));
  return structuredClone(confirmation);
}

// Executes one confirmed submission against the fixture store. `options.apply(record)` computes the new value; it may
// throw (a failure, classified by its `code`) or throw with `unknown: true` (the effect may or may not have happened).
// After `apply` returns, the record version and the lease fence are checked again and the write is committed in one
// synchronous compare-and-swap; a record changed or a lease lost during `apply` is never overwritten. `options.signal`
// aborts between records. A repeated submission with the same key replays the stored receipt; a concurrent one waits
// for the same run; the same key with another scope is refused.
export async function executeFixtureAction(store, registry, confirmation, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const key = typeof confirmation?.idempotencyKey === 'string' ? confirmation.idempotencyKey : null;
  if (key && store.receipts.has(key)) {
    const stored = store.receipts.get(key);
    if (stored.scopeKey !== confirmation.scopeKey) return {receipt: receiptOf({confirmation, refusal: 'idempotency_conflict', outcomes: []}), replay: false};
    return {receipt: stored.receipt, replay: true};
  }
  if (key && store.inflight.has(key)) {
    const pending = store.inflight.get(key);
    if (pending.scopeKey !== confirmation.scopeKey) return {receipt: receiptOf({confirmation, refusal: 'idempotency_conflict', outcomes: []}), replay: false};
    const result = await pending.promise;
    return {receipt: result.receipt, replay: true};
  }
  const check = checkSubmission(registry, confirmation, store.read(now), {principal: options.principal, issued: key ? store.issued.get(key) : undefined});
  if (!check.ok) return {receipt: receiptOf({confirmation, refusal: check.refusal, outcomes: []}), replay: false};
  if (store.lease && store.lease.key !== key) return {receipt: receiptOf({confirmation, refusal: 'lease_held', outcomes: []}), replay: false};
  const run = (async () => {
    const fence = (store.lease?.fence ?? 0) + 1;
    store.lease = {key, fence};
    const capability = check.capability, outcomes = [];
    let aborted = false, fenceLost = false;
    try {
      for (const target of check.scope.records) {
        if (options.signal?.aborted) {aborted = true; outcomes.push({id: target.id, outcome: 'not_attempted', error: 'aborted'}); continue;}
        if (fenceLost || store.lease?.fence !== fence) {fenceLost = true; outcomes.push({id: target.id, outcome: 'not_attempted', error: 'fence_lost'}); continue;}
        const record = store.records.get(target.id);
        if (!record || record.version !== target.version) {outcomes.push({id: target.id, outcome: 'skipped_changed', error: 'conflict'}); continue;}
        let next;
        try {
          next = options.apply ? await options.apply(structuredClone(record)) : {...record.value, refreshed: true};
        } catch (error) {
          outcomes.push({id: target.id, outcome: error?.unknown ? 'unknown' : 'failed', error: actionErrorCode(error)});
          continue;
        }
        const committed = store.commit(target.id, target.version, fence, next, key + '/' + target.id);
        if (committed === 'written') outcomes.push({id: target.id, outcome: 'written'});
        else if (committed === 'changed') outcomes.push({id: target.id, outcome: 'skipped_changed', error: 'conflict'});
        else {fenceLost = true; outcomes.push({id: target.id, outcome: 'not_attempted', error: 'fence_lost'});}
      }
    } finally {
      if (store.lease?.fence === fence) store.lease = null;
    }
    const receipt = receiptOf({confirmation, capability, startedAt: now, finishedAt: options.finishedAt ?? now, outcomes, aborted: aborted || fenceLost});
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
    const conflict = ['stale_pin', 'record_changed', 'eligibility_changed', 'in_progress', 'lease_held', 'idempotency_conflict'];
    return {status: receipt.state === 'refused' ? (conflict.includes(receipt.refusal) ? 409 : 400) : 200, body: {...receipt, replay}};
  }
  return {status: 404, body: {error: 'not_found'}};
}

export function fixtureRegistry() {
  return createRegistry([FIXTURE_CAPABILITY]);
}
