// The owner's manual poster restoration on /admin/posters, as pure functions: no DOM, no storage and no network of its own.
// It turns a read of GET /api/admin/posters into a preview, binds the owner's confirmation to that exact scope for a short
// time, re-checks the scope against a fresh read immediately before the first call, and then drives a bounded sequence of
// explicit calls to POST /api/enrichment/catalog/posters through an injected `call`, stopping on the first condition that
// makes another call unsafe or pointless. Every call and every record outcome lands in a receipt. The confirmation guards
// against an accidental click; it is not authorization, which stays with Cloudflare Access and the route's own guards
// (resolver lease, generation check, compare-and-swap per copy, the route's limit). Codes without a sentence in the closed
// tables below are never explained by guesswork: they stop the run and are shown as unknown.

export const POSTER_BATCH_MAX = 10;
export const POSTER_CALLS_MAX = 30;
export const POSTER_NO_PROGRESS_MAX = 5;
export const POSTER_CONFIRM_TTL_MS = 10 * 60000;
export const POSTER_CALL_CHOICES = Object.freeze([1, 2, 3, 5, 10, 20, 30]);
export const POSTER_HISTORY_KEY = 'iptv.admin.posters.v1';
const POSTER_HISTORY_RECEIPTS = 10;
const POSTER_HISTORY_OBSERVATIONS = 20;
const POSTER_HISTORY_TERMINAL_IDS = 200;

export const POSTER_TERMINAL = Object.freeze(['hydrated', 'already_present', 'no_poster_on_tmdb', 'tmdb_id_mismatch']);

// Every record outcome the route can return (src/discovery.js catalogPosterHydration). `terminal` outcomes move the cursor.
export const POSTER_OUTCOME_COPY = Object.freeze({
  hydrated: {terminal: true, tone: 'ready', text: 'Постер записан'},
  already_present: {terminal: true, tone: 'neutral', text: 'Постер уже был, ничего не менялось'},
  no_poster_on_tmdb: {terminal: true, tone: 'blocked', text: 'На TMDB постера нет — повтор не поможет'},
  tmdb_id_mismatch: {terminal: true, tone: 'blocked', text: 'TMDB ответил за другой фильм — нужен ручной разбор'},
  tmdb_failed: {terminal: false, tone: 'warning', text: 'Ошибка TMDB — можно повторить позже'},
  rate_limited: {terminal: false, tone: 'warning', text: 'TMDB ограничил частоту запросов — повтор после указанного времени'},
  not_attempted: {terminal: false, tone: 'warning', text: 'Не запрашивался: TMDB ограничил частоту раньше в этом пакете'},
  skipped_changed: {terminal: false, tone: 'warning', text: 'Запись изменилась во время пакета — пропущена без записи'},
  generation_changed: {terminal: false, tone: 'warning', text: 'Опубликовано новое поколение — запись остановлена'},
  lease_lost: {terminal: false, tone: 'warning', text: 'Потеряна блокировка резолвера — запись остановлена'},
  catalog_changed: {terminal: false, tone: 'warning', text: 'Каталог менялся параллельно — копия не записана'},
  not_written: {terminal: false, tone: 'warning', text: 'Не записано'},
});
export const POSTER_UNKNOWN_OUTCOME = 'Неизвестный результат — не повторяйте, пока не проверите данные вручную';

// Why a run stopped. `retry` says whether another run can help without a change somewhere else.
export const POSTER_STOP_COPY = Object.freeze({
  done: {tone: 'ready', text: 'Очередь пройдена до конца: каждая проверяемая запись получила окончательный результат.', retry: false},
  call_budget: {tone: 'neutral', text: 'Выполнено столько вызовов, сколько вы подтвердили. Остаток можно продолжить новым запуском с новой проверкой.', retry: true},
  no_progress: {tone: 'warning', text: `${POSTER_NO_PROGRESS_MAX} вызовов подряд без продвижения: ни одного нового постера и курсор не сдвинулся. Остановлено, чтобы не повторять одно и то же.`, retry: false},
  rate_limited: {tone: 'warning', text: 'TMDB ограничил частоту запросов. Следующая попытка — не раньше указанного времени.', retry: true},
  generation_changed: {tone: 'warning', text: 'Во время запуска опубликовано новое поколение программы. Продолжение — только после новой проверки.', retry: true},
  lease_lost: {tone: 'warning', text: 'Блокировка резолвера потеряна во время записи; одна из копий каталога могла записаться без другой. Смотрите результат по каждой копии.', retry: true},
  resolver_busy: {tone: 'warning', text: 'Резолвер сейчас пишет каталог. Этот вызов ничего не записал; повторите позже.', retry: true},
  tmdb_unconfigured: {tone: 'blocked', text: 'TMDB не настроен в Worker. Ничего не записано. Токен настраивается в секретах Worker, не через эту страницу.', retry: false},
  invalid_request: {tone: 'blocked', text: 'Сервер отклонил запрос как некорректный. Ничего не записано.', retry: false},
  unknown_result: {tone: 'warning', text: 'Результат последнего вызова неизвестен (сеть или неожиданный ответ): он мог как записать, так и не записать постеры. Перед повтором проверьте покрытие заново.', retry: false},
  owner_stopped: {tone: 'neutral', text: 'Остановлено по вашей команде после текущего пакета.', retry: true},
});

export const POSTER_PREVIEW_COPY = Object.freeze({
  eligible: {tone: 'ready', headline: 'Можно запустить после подтверждения'},
  nothing: {tone: 'neutral', headline: 'У всех записей каталога есть постер'},
  unverified_only: {tone: 'blocked', headline: 'Восстанавливать нечего: у оставшихся записей нет проверенного TMDB id'},
  end_of_queue: {tone: 'neutral', headline: 'После этой позиции очередь пуста'},
  rate_limited: {tone: 'warning', headline: 'TMDB ограничил частоту запросов — запуск пока недоступен'},
  incomplete: {tone: 'blocked', headline: 'Данные неполные: покрытие неизвестно, запуск недоступен'},
  unknown: {tone: 'warning', headline: 'Не удалось прочитать состояние — запуск недоступен'},
});

// Why the coverage is unknown (GET /api/admin/posters evidence.problems). A code without a sentence is shown as unknown.
export const POSTER_EVIDENCE_COPY = Object.freeze({
  pointer_missing: 'Нет указателя опубликованного поколения программы.',
  pointer_unreadable: 'Указатель опубликованного поколения не читается.',
  generation_not_published: 'Поколение программы сейчас не опубликовано.',
  generation_copy_missing: 'Нет копии каталога опубликованного поколения.',
  generation_copy_unreadable: 'Копия каталога опубликованного поколения не читается.',
  live_copy_missing: 'Нет рабочей копии каталога.',
  live_copy_unreadable: 'Рабочая копия каталога не читается.',
  evidence_missing: 'Сервер не сообщил, полны ли данные.',
});
export function posterEvidenceText(code) {return POSTER_EVIDENCE_COPY[code] || 'Неизвестная проблема с данными.';}

export const POSTER_REFUSAL_COPY = Object.freeze({
  not_accepted: 'Отметьте, что подтверждаете именно этот объём.',
  not_eligible: 'Сейчас запускать нечего: проверка не нашла записей для восстановления.',
  confirmation_expired: 'Подтверждение устарело. Проверьте состояние заново и подтвердите ещё раз.',
  confirmation_used: 'Это подтверждение уже использовано. Для нового запуска нужна новая проверка и новое подтверждение.',
  stale_generation: 'После подтверждения опубликовано новое поколение. Ничего не отправлено; проверьте заново.',
  scope_changed: 'После подтверждения очередь изменилась: первый пакет уже не тот, что вы видели. Ничего не отправлено; проверьте заново.',
  read_failed: 'Не удалось перечитать состояние перед запуском. Ничего не отправлено.',
  evidence_incomplete: 'Перед запуском данные оказались неполными: покрытие неизвестно. Ничего не отправлено.',
});

const UNVERIFIED_COPY = Object.freeze({
  tmdb_id_missing: 'нет числового TMDB id',
  identity_not_tmdb: 'TMDB id есть, но идентичность не подтверждена этим id',
});
export function posterUnverifiedText(reason) {
  return UNVERIFIED_COPY[reason] || 'причина неизвестна';
}

function isObject(value) {return !!value && typeof value === 'object' && !Array.isArray(value);}
function count(value) {return Number.isInteger(value) && value >= 0 ? value : null;}
function cursorOf(value) {return typeof value === 'string' && value ? value : null;}
function retryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;}
  return null;
}

// The coverage figures of a GET /api/admin/posters body, or null when the body is not one. `complete` is true only when the
// server says every object behind the counts was read; otherwise the counts are null and `problems` says why.
export function posterCoverage(read) {
  if (!isObject(read) || !isObject(read.queue) || !Array.isArray(read.queue.items)) return null;
  const fields = ['catalogRecords', 'missingPoster', 'verifiedMissing', 'unverifiedMissing'];
  const evidence = isObject(read.evidence) ? read.evidence : null;
  const problems = evidence && Array.isArray(evidence.problems) ? evidence.problems.filter(code => typeof code === 'string').slice(0, 20) : ['evidence_missing'];
  const programmeRunId = typeof read.programmeRunId === 'string' && read.programmeRunId ? read.programmeRunId : null;
  const complete = evidence?.complete === true && problems.length === 0 && programmeRunId !== null;
  if (complete && fields.some(name => count(read[name]) === null)) return null;
  const value = name => complete ? read[name] : null;
  return {
    programmeRunId, complete, problems: complete ? [] : problems.length ? problems : ['generation_not_published'],
    observedAt: typeof read.observedAt === 'string' ? read.observedAt : null,
    catalogRecords: value('catalogRecords'), missingPoster: value('missingPoster'),
    verifiedMissing: value('verifiedMissing'), unverifiedMissing: value('unverifiedMissing'),
    withPoster: complete ? read.catalogRecords - read.missingPoster : null,
    backlog: complete && read.health?.issue?.severity === 'warning' && read.health.issue.reason === 'posters_missing',
    backlogThreshold: count(read.health?.posterBacklogCount),
  };
}

function normalizeChoice(value, choices, fallback) {return choices.includes(value) ? value : fallback;}

// What one run would do, from one read made with the same cursor and limit. Only `eligible` can be confirmed.
export function posterPreview(read, {limit, calls, retryAt = null, now}) {
  const coverage = posterCoverage(read);
  const batch = normalizeChoice(limit, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], POSTER_BATCH_MAX);
  const budget = normalizeChoice(calls, POSTER_CALL_CHOICES, 1);
  if (!coverage) return {status: 'unknown', limit: batch, calls: budget, items: [], coverage: null, scopeKey: null};
  if (!coverage.complete) return {status: 'incomplete', limit: batch, calls: budget, cursor: cursorOf(read.queue.cursor), items: [], coverage, remaining: null, maxRecords: batch * budget, planned: 0, retryAt: null, scopeKey: null};
  const cursor = cursorOf(read.queue.cursor);
  const items = read.queue.items.filter(item => isObject(item) && typeof item.id === 'string' && /^\d+$/.test(String(item.tmdbId))).slice(0, batch)
    .map(item => ({id: item.id, tmdbId: String(item.tmdbId), title: typeof item.title === 'string' ? item.title : null, year: Number.isInteger(item.year) ? item.year : null}));
  const remaining = count(read.queue.remainingAfterCursor) ?? 0;
  const base = {limit: batch, calls: budget, cursor, items, coverage, remaining, maxRecords: batch * budget, planned: Math.min(remaining, batch * budget), retryAt: null, scopeKey: null};
  const gate = retryMs(retryAt);
  if (coverage.missingPoster === 0) return {...base, status: 'nothing'};
  if (coverage.verifiedMissing === 0) return {...base, status: 'unverified_only'};
  if (!items.length || remaining === 0) return {...base, status: 'end_of_queue'};
  if (gate !== null && gate > now) return {...base, status: 'rate_limited', retryAt: new Date(gate).toISOString()};
  return {...base, status: 'eligible', scopeKey: posterScopeKey(coverage.programmeRunId, cursor, batch, budget, items)};
}

export function posterScopeKey(programmeRunId, cursor, limit, calls, items) {
  return JSON.stringify([programmeRunId || '', cursor || '', limit, calls, items.map(item => item.id + '=' + item.tmdbId)]);
}

// The owner's confirmation of one exact preview, valid for a short time and for one run.
export function posterConfirm(preview, {accepted, now}) {
  if (!accepted) return {ok: false, reason: 'not_accepted'};
  if (!preview || preview.status !== 'eligible' || !preview.scopeKey || !preview.coverage?.programmeRunId) return {ok: false, reason: 'not_eligible'};
  return {ok: true, confirmation: {
    scopeKey: preview.scopeKey, programmeRunId: preview.coverage.programmeRunId, cursor: preview.cursor, limit: preview.limit, calls: preview.calls,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + POSTER_CONFIRM_TTL_MS).toISOString(), consumedAt: null,
  }};
}

// The check immediately before the first call: the confirmation is unused and fresh, and a new read made with the confirmed
// cursor and limit yields the same generation and the same first batch. Success consumes the confirmation.
export function posterBeginRun(confirmation, freshRead, {now, retryAt = null}) {
  if (!confirmation || typeof confirmation.scopeKey !== 'string') return {ok: false, reason: 'not_eligible'};
  if (confirmation.consumedAt) return {ok: false, reason: 'confirmation_used'};
  if (!(Date.parse(confirmation.expiresAt) > now)) return {ok: false, reason: 'confirmation_expired'};
  const preview = posterPreview(freshRead, {limit: confirmation.limit, calls: confirmation.calls, retryAt, now});
  if (preview.status === 'unknown') return {ok: false, reason: 'read_failed', preview};
  if (preview.status === 'incomplete') return {ok: false, reason: 'evidence_incomplete', preview};
  if ((preview.coverage.programmeRunId || null) !== (confirmation.programmeRunId || null)) return {ok: false, reason: 'stale_generation', preview};
  if (preview.status !== 'eligible') return {ok: false, reason: 'not_eligible', preview};
  if (preview.scopeKey !== confirmation.scopeKey) return {ok: false, reason: 'scope_changed', preview};
  return {ok: true, confirmation: {...confirmation, consumedAt: new Date(now).toISOString()}, preview};
}

function callRecord(index, cursor, answer) {
  const body = isObject(answer?.body) ? answer.body : null;
  return {
    index, cursor, httpStatus: Number.isInteger(answer?.status) ? answer.status : 0, error: answer?.error || null,
    programmeRunId: typeof body?.programmeRunId === 'string' ? body.programmeRunId : null,
    processed: count(body?.processed), hydrated: count(body?.hydrated) ?? 0,
    outcomes: Array.isArray(body?.outcomes) ? body.outcomes.filter(isObject).map(item => ({id: String(item.id), tmdbId: item.tmdbId == null ? null : String(item.tmdbId), outcome: String(item.outcome), ...(Array.isArray(item.writtenTo) && item.writtenTo.length ? {writtenTo: item.writtenTo.map(String)} : {}), ...(typeof item.error === 'string' ? {error: item.error.slice(0, 200)} : {})})) : [],
    writes: Array.isArray(body?.writes) ? body.writes.filter(isObject).map(write => ({key: String(write.key), written: write.written === true, reason: write.reason == null ? null : String(write.reason), records: count(write.records) ?? 0})) : [],
    nextCursor: body?.nextCursor === null || typeof body?.nextCursor === 'string' ? body.nextCursor : undefined,
    done: body?.done === true, retryAt: body?.retryAt ?? null, generationChanged: body?.generationChanged === true, leaseLost: body?.leaseLost === true,
    remainingAfterCursor: count(body?.remainingAfterCursor),
  };
}

// The stop reason of one answer that ends the run before its outcomes are judged, or null for an ordinary answer.
function answerStop(answer, record) {
  if (!answer || answer.error === 'network' || answer.error === 'aborted' || answer.status === 0) return 'unknown_result';
  const body = isObject(answer.body) ? answer.body : null;
  if (answer.status === 409 && body?.leaseLost === true) return 'lease_lost';
  if (answer.status === 409 && body?.generationChanged === true) return 'generation_changed';
  if (answer.status === 409 && body?.error === 'Resolver is writing the catalog') return 'resolver_busy';
  if (answer.status === 503 && body?.error === 'TMDB is not configured') return 'tmdb_unconfigured';
  if (answer.status === 400) return 'invalid_request';
  if (answer.status !== 200 || !body || body.dryRun !== false || !Array.isArray(body.outcomes) || record.nextCursor === undefined) return 'unknown_result';
  if (record.outcomes.some(item => !Object.hasOwn(POSTER_OUTCOME_COPY, item.outcome))) return 'unknown_result';
  return null;
}

// Drives the confirmed run. `call(body)` performs one POST and resolves to {ok, status, error, body}; `stopRequested()` is
// read between calls only, so a call in flight always completes and is recorded. The receipt says why the run stopped.
export async function runPosterSweep({confirmation, call, now, stopRequested = () => false, onProgress = () => {}}) {
  const receipt = {
    startedAt: new Date(now()).toISOString(), finishedAt: null, programmeRunId: confirmation.programmeRunId, startCursor: confirmation.cursor,
    limit: confirmation.limit, callsPlanned: confirmation.calls, calls: [], stop: null, nextCursor: confirmation.cursor, done: false, retryAt: null,
  };
  let cursor = confirmation.cursor, idle = 0;
  while (true) {
    if (receipt.calls.length >= confirmation.calls) {receipt.stop = 'call_budget'; break;}
    if (receipt.calls.length > 0 && stopRequested()) {receipt.stop = 'owner_stopped'; break;}
    const body = {dryRun: false, limit: Math.min(confirmation.limit, POSTER_BATCH_MAX), expectedProgrammeRunId: confirmation.programmeRunId};
    if (cursor) body.cursor = cursor;
    let answer;
    try {answer = await call(body);} catch {answer = null;}
    const record = callRecord(receipt.calls.length + 1, cursor, answer);
    receipt.calls.push(record);
    const stop = answerStop(answer, record);
    if (stop) {
      receipt.stop = stop;
      if (stop === 'lease_lost' && record.nextCursor !== undefined) receipt.nextCursor = cursorOf(record.nextCursor);
      onProgress(posterReceiptSummary(receipt));
      break;
    }
    const next = cursorOf(record.nextCursor);
    const moved = next !== cursor;
    receipt.nextCursor = next;
    if (record.retryAt != null) receipt.retryAt = record.retryAt;
    onProgress(posterReceiptSummary(receipt));
    if ((record.programmeRunId || null) !== (confirmation.programmeRunId || null) || record.generationChanged) {receipt.stop = 'generation_changed'; break;}
    if (record.done) {receipt.done = true; receipt.nextCursor = null; receipt.stop = 'done'; break;}
    if (record.retryAt != null) {receipt.stop = 'rate_limited'; break;}
    idle = record.hydrated > 0 || moved ? 0 : idle + 1;
    if (idle >= POSTER_NO_PROGRESS_MAX) {receipt.stop = 'no_progress'; break;}
    cursor = next;
  }
  receipt.finishedAt = new Date(now()).toISOString();
  return {...receipt, summary: posterReceiptSummary(receipt)};
}

// The latest outcome of each record over all calls, and the totals the page shows.
export function posterReceiptSummary(receipt) {
  const latest = new Map();
  for (const record of receipt.calls) for (const item of record.outcomes) latest.set(item.id, item);
  const outcomes = [...latest.values()];
  const by = code => outcomes.filter(item => item.outcome === code).length;
  const partial = receipt.calls.some(record => record.writes.some(write => write.written) && record.writes.some(write => !write.written && write.reason !== 'nothing_to_apply'));
  return {
    calls: receipt.calls.length, callsPlanned: receipt.callsPlanned, hydrated: by('hydrated'), alreadyPresent: by('already_present'), noPoster: by('no_poster_on_tmdb'), mismatch: by('tmdb_id_mismatch'),
    retryable: outcomes.filter(item => POSTER_OUTCOME_COPY[item.outcome] && !POSTER_OUTCOME_COPY[item.outcome].terminal).length,
    unknown: outcomes.filter(item => !POSTER_OUTCOME_COPY[item.outcome]).length,
    partialWrites: partial, remaining: receipt.calls.length ? receipt.calls[receipt.calls.length - 1].remainingAfterCursor : null, outcomes,
  };
}

export function posterOutcomeText(code) {return POSTER_OUTCOME_COPY[code]?.text || POSTER_UNKNOWN_OUTCOME;}
export function posterStopText(code) {return POSTER_STOP_COPY[code]?.text || POSTER_STOP_COPY.unknown_result.text;}

// Browser-local history: the last receipts, coverage observations, the last successful restoration, the resume position and a
// TMDB rate-limit gate. It is a convenience of this browser only and never an input to the route; a malformed value is dropped.
export function posterHistoryRead(raw) {
  let value = null;
  try {value = typeof raw === 'string' && raw ? JSON.parse(raw) : null;} catch {value = null;}
  const empty = {version: 1, receipts: [], observations: [], lastSuccess: null, resume: null, retryAt: null, terminal: {}};
  if (!isObject(value) || value.version !== 1) return empty;
  const receipts = Array.isArray(value.receipts) ? value.receipts.filter(item => isObject(item) && typeof item.finishedAt === 'string').slice(-POSTER_HISTORY_RECEIPTS) : [];
  const observations = Array.isArray(value.observations) ? value.observations.filter(item => isObject(item) && typeof item.at === 'string' && count(item.missingPoster) !== null && count(item.verifiedMissing) !== null).slice(-POSTER_HISTORY_OBSERVATIONS) : [];
  const lastSuccess = isObject(value.lastSuccess) && typeof value.lastSuccess.at === 'string' && count(value.lastSuccess.hydrated) ? value.lastSuccess : null;
  const resume = isObject(value.resume) && typeof value.resume.cursor === 'string' && value.resume.cursor ? {programmeRunId: typeof value.resume.programmeRunId === 'string' ? value.resume.programmeRunId : null, cursor: value.resume.cursor.slice(0, 200)} : null;
  const terminal = {};
  if (isObject(value.terminal)) for (const [id, code] of Object.entries(value.terminal)) if ((code === 'no_poster_on_tmdb' || code === 'tmdb_id_mismatch') && Object.keys(terminal).length < POSTER_HISTORY_TERMINAL_IDS) terminal[id] = code;
  return {version: 1, receipts, observations, lastSuccess, resume, retryAt: retryMs(value.retryAt) === null ? null : value.retryAt, terminal};
}

export function posterHistoryObserve(history, coverage) {
  if (!coverage || !coverage.complete || !coverage.observedAt) return history;
  const entry = {at: coverage.observedAt, programmeRunId: coverage.programmeRunId, catalogRecords: coverage.catalogRecords, missingPoster: coverage.missingPoster, verifiedMissing: coverage.verifiedMissing, unverifiedMissing: coverage.unverifiedMissing};
  const last = history.observations[history.observations.length - 1];
  const same = last && last.programmeRunId === entry.programmeRunId && last.missingPoster === entry.missingPoster && last.verifiedMissing === entry.verifiedMissing && last.unverifiedMissing === entry.unverifiedMissing;
  const observations = same ? [...history.observations.slice(0, -1), {...last, at: entry.at}] : [...history.observations, entry];
  return {...history, observations: observations.slice(-POSTER_HISTORY_OBSERVATIONS)};
}

export function posterHistoryRecord(history, receipt) {
  const summary = receipt.summary || posterReceiptSummary(receipt);
  const entry = {startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, programmeRunId: receipt.programmeRunId, startCursor: receipt.startCursor, nextCursor: receipt.nextCursor, stop: receipt.stop, done: receipt.done, calls: summary.calls, hydrated: summary.hydrated, noPoster: summary.noPoster, mismatch: summary.mismatch, retryable: summary.retryable, partialWrites: summary.partialWrites};
  const terminal = {...history.terminal};
  for (const item of summary.outcomes) {
    if (item.outcome === 'no_poster_on_tmdb' || item.outcome === 'tmdb_id_mismatch') terminal[item.id] = item.outcome;
    else if (item.outcome === 'hydrated' || item.outcome === 'already_present') delete terminal[item.id];
  }
  const kept = Object.fromEntries(Object.entries(terminal).slice(-POSTER_HISTORY_TERMINAL_IDS));
  // The resume position belongs to one generation, and an unknown result never advances it: the owner re-checks first.
  const resume = receipt.done ? null : receipt.stop === 'unknown_result' ? history.resume : receipt.nextCursor ? {programmeRunId: receipt.programmeRunId, cursor: receipt.nextCursor} : null;
  return {
    ...history,
    receipts: [...history.receipts, entry].slice(-POSTER_HISTORY_RECEIPTS),
    lastSuccess: summary.hydrated > 0 ? {at: receipt.finishedAt, hydrated: summary.hydrated, programmeRunId: receipt.programmeRunId} : history.lastSuccess,
    resume, retryAt: receipt.retryAt ?? (receipt.stop === 'rate_limited' ? history.retryAt : null), terminal: kept,
  };
}

export function posterResumeCursor(history, programmeRunId) {
  return history.resume && history.resume.programmeRunId === (programmeRunId || null) ? history.resume.cursor : null;
}
