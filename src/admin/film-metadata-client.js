// AIR-635 (card PVU; ADR 0214 decision 9, language-bound per ADR 0224): the owner's view of the per-field provenance of one Film
// and the manual corrections of the PV3 API (`/api/admin/films/<id>/metadata`). Three layers, all in this file:
//  1. the client: ONE read (GET, paged history) and ONE write (POST, `X-IPTV-Admin-Action: film_metadata_owner`). No credential is attached.
//  2. pure functions: the explanation of a refusal, the command builder and the HTML. They hold every decision, so they are testable without a DOM.
//  3. adminBindFilmMetadata(host): loads on demand (a `<details>` is opened), keeps the requestId of an unfinished command so a retry is the SAME command.
// The page never invents provenance: a value without a stored lineage is shown as `unknown`/`unattributed`, and a mode `off` or an absent schema
// shows the value only. Deploying or opening this view writes nothing; only a button press sends a command.
const ADMIN_META_FIELDS = ['year', 'runtime', 'synopsis', 'poster', 'url', 'genres'];
const ADMIN_META_FIELD_TEXT = {year: 'Год', runtime: 'Длительность', synopsis: 'Описание', poster: 'Постер', url: 'Ссылка', genres: 'Жанры'};
const ADMIN_META_RANK_TEXT = {owner: 'закреплено владельцем', confirmed: 'подтверждено', superseded: 'вытеснено', unconfirmed: 'не подтверждено', unknown: 'неизвестно'};
const ADMIN_META_MODE_TEXT = {off: 'выключено', hold: 'приостановлено', enforce: 'включено', shadow: 'наблюдение'};
const ADMIN_META_ACTION_TEXT = {set: 'Задать значение', lock: 'Закрепить', release: 'Снять закрепление', revert: 'Вернуть', refresh: 'Обновить из источников'};
const ADMIN_META_REFUSAL_TEXT = {
  schema_absent: 'Схема provenance ещё не установлена. Значения видны, записать нельзя.',
  provenance_off: 'Режим provenance выключен (off). Значения видны, записать нельзя.',
  identity_unknown: 'Набор идентификаторов фильма неизвестен, поэтому вернуть старое значение нельзя. Задать новое значение можно.',
  anchor_changed: 'Идентичность фильма изменилась после этой записи, поэтому вернуть её нельзя. Задать новое значение можно.',
  no_value: 'В этой записи не было значения, возвращать нечего.',
  stale_revision: 'Карточка изменилась с момента чтения. Команда не выполнена. Данные перечитываются, повторите действие.',
  stale_rows: 'Состояние источников изменилось с момента чтения. Команда не выполнена. Данные перечитываются, повторите действие.',
  pending: 'Есть команда с неизвестным исходом: повторите её или откажитесь от повтора выше. Другие действия отключены.',
  pending_other: 'Команда с неизвестным исходом ждёт в другом фильме. Откройте его в каталоге, чтобы повторить её или отказаться от повтора. Здесь действия отключены, чтобы не потерять её.',
  flight: 'Идёт отправка команды. Действия отключены, пока она и перечитывание не завершатся.',
  stale_view: 'Данные устарели или читаются заново. Действия отключены, пока чтение не завершится успешно.',
  request_mismatch: 'Этот requestId уже использован для другой команды. Нажмите действие ещё раз, получится новая команда.',
  redirected: 'Фильм объединён с другим. Откройте целевой фильм.',
  blank_field: 'Поле пустое, закреплять нечего. Сначала задайте значение.',
  foreign_history: 'Эта запись журнала относится к другому фильму.',
  history_not_found: 'Записи журнала больше нет.',
  not_in_scope: 'У фильма нет состояния обогащения каталога, обновлять нечего.',
  not_refreshable: 'Ни один источник сейчас нельзя переоткрыть.',
  authority_not_open: 'Запись канонического фильма сейчас закрыта (authority).',
  precondition_failed: 'Условие записи изменилось. Перечитайте фильм и повторите.',
  bounded: 'Значение превышает допустимый размер.',
  invalid_value: 'Сервер отклонил значение. Допустимо: год 1870–2200, длительность 1–10000, описание до 20000 знаков, постер и ссылка до 2000 знаков (ссылка начинается с http:// или https://), жанров до 40, каждый до 80 знаков.',
  invalid_command: 'Команда составлена неверно.',
  not_owner: 'Действие доступно только владельцу.',
  forbidden: 'Действие доступно только владельцу.',
  storage_unavailable: 'Хранилище не ответило, результат неизвестен. Можно отправить ту же команду ещё раз: requestId решит, записана ли она.',
  network: 'Нет ответа от сервера. Можно повторить: это будет та же команда, без второй правки.',
};
// the writer's own bounds (ownerValue in src/film-metadata-provenance.js); the server stays the judge, the page only does not forbid a value the writer accepts
const ADMIN_META_MAXLENGTH = {year: 5, runtime: 5, synopsis: 20000, poster: 2000, url: 2000};
// Shared by EVERY mounted Film, because the page replaces the detail's DOM on navigation:
//  adminMetaPending  {storedId, label, command}: the one command whose outcome is unknown
//  adminMetaFlight   {storedId, requestId}: the one command (POST and its readback) in flight
//  adminMetaLive     the binding of the Film now on screen; an older binding is `dead` and only settles the shared state
// Writes are serialized across Films; a settlement touches the shared state only when its own `requestId` is the one stored.
let adminMetaPending = null;
let adminMetaFlight = null;
let adminMetaLive = null;
const adminMetaText = value => String(value === null || value === undefined ? '' : value);
const adminMetaEsc = value => adminMetaText(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// ---- 1. the client ----
async function adminReadFilmMetadata(storedId, cursor) {
  let response;
  try { response = await fetch(ADMIN_API + '/films/' + encodeURIComponent(storedId) + '/metadata' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), {headers: {Accept: 'application/json'}, credentials: 'same-origin'}); }
  catch { return {ok: false, status: 0, error: 'network', body: null}; }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {ok: response.ok && !!payload && payload.found === true, status: response.status, error: payload && payload.error || (response.ok ? null : 'unavailable'), body: payload};
}
// A network failure is `error: 'network'`; a 503 `storage_unavailable` has `outcome: 'unknown'`. Both keep the requestId for a retry.
async function adminWriteFilmMetadata(storedId, body) {
  let response;
  try { response = await fetch(ADMIN_API + '/films/' + encodeURIComponent(storedId) + '/metadata', {method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':'film_metadata_owner'}, credentials: 'same-origin', body: JSON.stringify(body)}); }
  catch { return {ok: false, status: 0, error: 'network', outcome: 'unknown', body: null}; }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {ok: response.ok && !!payload && payload.ok === true, status: response.status, error: payload && payload.error || null, outcome: payload && payload.outcome || (response.ok ? null : 'unknown'), body: payload};
}

// ---- 2. pure decisions ----
// Whether a write can be offered at all, and the reason when it cannot. `options.stale`: the readback is not current (a command or a read is in flight, or the last read failed).
// `options.pending`: a command with an unknown outcome is held; it must be retried or given up before any other action.
function adminMetaWritable(view, options) {
  if (!view || view.redirectedTo) return {ok: false, reason: 'redirected'};
  if (view.schemaAbsent) return {ok: false, reason: 'schema_absent'};
  if (view.mode === 'off') return {ok: false, reason: 'provenance_off'};
  // a command in flight is not an unknown outcome yet: it is said first
  if (options && options.flight) return {ok: false, reason: 'flight'};
  if (options && options.pending) return {ok: false, reason: 'pending'};
  if (options && options.pendingElsewhere) return {ok: false, reason: 'pending_other'};
  if (options && options.stale) return {ok: false, reason: 'stale_view'};
  return {ok: true, reason: null};
}
// The state of one field as the owner must read it: never more provenance than the API stored, and three separate facts.
//  pin        the owner's own pin of this field (`row.tier === 'owner'`); `entry.locked` is NOT it, it is the effective rank and is also `owner` under the metadata dimension lock
//  rank       the effective rank (`entry.rank`); `owner` without a pin means the dimension lock protects the field
//  unbound    a stored row whose value digest is not the displayed value's: its lineage is history, not the value's source
function adminMetaFieldState(entry, dimensionLocked) {
  if (!entry) return {kind: 'none', label: 'нет данных', pin: false, dimension: false, unbound: false};
  const row = entry.row || null;
  const pin = !!row && row.tier === 'owner';
  const dimension = !!dimensionLocked && !!entry.rank;
  const unbound = !!row && !entry.blank && entry.bound === false;
  const base = {pin, dimension, unbound};
  if (entry.blank) return {kind: 'blank', label: 'пусто', ...base};
  if (!entry.rank) return {kind: 'plain', label: 'происхождение недоступно', ...base};
  if (!row) return {kind: 'unattributed', label: 'без происхождения (unattributed)', ...base};
  if (entry.rank.name === 'owner') return {kind: 'owner', label: pin ? 'закреплено владельцем' : 'защищено блокировкой метаданных', ...base};
  if (entry.rank.name === 'superseded') return {kind: 'superseded', label: 'вытеснено: идентичность фильма изменилась после записи', ...base};
  return {kind: entry.rank.name, label: ADMIN_META_RANK_TEXT[entry.rank.name] || entry.rank.name, ...base};
}
function adminMetaValueText(field, value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  return adminMetaText(value);
}
function adminMetaNewRequestId() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'meta-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
}
// The command the page sends. `expectedRevision` is the revision of the readback the owner SAW; refresh sends the core rows the owner SAW.
function adminMetaCommand(view, action, options) {
  const base = {action, expectedRevision: view.revision, requestId: options.requestId};
  if (action === 'refresh') {
    const rows = ((view.c1 && view.c1.rows) || []).filter(row => row.part === 'core').map(row => ({part: 'core', source: row.source, status: row.status, updatedAt: row.updatedAt, refreshEpoch: row.refreshEpoch}));
    return {...base, expectedRows: rows};
  }
  const command = {...base, field: options.field};
  if (action === 'set') command.value = options.value;
  if (action === 'revert') command.historyRef = options.historyRef;
  return command;
}
// The raw JSON type the API demands: integers for year/runtime, an array of strings for genres, a string otherwise.
function adminMetaParseValue(field, text) {
  const trimmed = adminMetaText(text).trim();
  if (!trimmed) return {error: 'Введите значение.'};
  if (field === 'year' || field === 'runtime') return /^\d{1,5}$/.test(trimmed) ? {value: Number(trimmed)} : {error: 'Нужно целое число.'};
  if (field === 'genres') {
    const items = trimmed.split(',').map(item => item.trim()).filter(Boolean);
    return items.length ? {value: items} : {error: 'Введите жанры через запятую.'};
  }
  return {value: trimmed};
}
function adminMetaRefusalText(code) {
  return ADMIN_META_REFUSAL_TEXT[code] || (code ? 'Отказ: ' + code + '.' : 'Не удалось выполнить действие.');
}
function adminMetaOutcomeText(response, action) {
  const outcome = response.body && response.body.outcome || response.outcome;
  if (outcome === 'already_applied') return 'Эта команда уже была выполнена раньше. Повторной записи нет.';
  if (outcome === 'noop') return 'Значение уже такое, изменений нет.';
  return (ADMIN_META_ACTION_TEXT[action] || 'Действие') + ': выполнено.';
}
// An answer after which the same command may be sent again (the outcome is unknown); every other answer finishes the attempt.
const adminMetaRetryable = response => response.error === 'network' || response.outcome === 'unknown' || response.status === 503;

// What a held command is, in words: action, field and the exact value that will be sent again.
function adminMetaDescribe(command) {
  const parts = [ADMIN_META_ACTION_TEXT[command.action] || command.action];
  if (command.field) parts.push(ADMIN_META_FIELD_TEXT[command.field] || command.field);
  if (command.action === 'set') parts.push('= ' + adminMetaValueText(command.field, command.value));
  if (command.action === 'revert') parts.push('(запись журнала ' + Number(command.historyRef) + ')');
  if (command.action === 'refresh') parts.push('(источники: ' + (command.expectedRows || []).map(row => row.source).join(', ') + ')');
  return parts.join(' ');
}
// `elsewhere`: the held command belongs to another Film; it can be retried or given up only there
function adminMetaPendingHtml(pending, elsewhere) {
  if (!pending) return '';
  if (elsewhere) return `<div class="admin-meta-pending" data-meta-pending-elsewhere><p><strong>Команда с неизвестным исходом ждёт в другом фильме:</strong> ${adminMetaEsc(pending.label || pending.storedId)}. ${adminMetaEsc(adminMetaDescribe(pending.command))}.</p><p class="muted">${adminMetaEsc(ADMIN_META_REFUSAL_TEXT.pending_other)}</p></div>`;
  return `<div class="admin-meta-pending" data-meta-pending-box><p><strong>Команда с неизвестным исходом.</strong> ${adminMetaEsc(adminMetaDescribe(pending.command))}. requestId: <code>${adminMetaEsc(pending.command.requestId)}</code>.</p>`
    + '<p class="muted">Неизвестно, записана ли она. «Повторить» отправит ровно эту же команду, а сохранённая запись решит, выполнена ли она уже. Другие действия отключены. Отказ от повтора не означает, что команда не записалась: после него проверьте значение и журнал.</p>'
    + '<div class="admin-meta-controls"><button type="button" data-meta-retry>Повторить ту же команду</button><button type="button" data-meta-discard>Отказаться от повтора</button></div></div>';
}

// ---- 3. the HTML ----
function adminMetaSummary(view, writable) {
  const mode = view.schemaAbsent ? 'схема не установлена' : (ADMIN_META_MODE_TEXT[view.mode] || adminMetaText(view.mode) || 'не указан');
  const items = [`<span class="admin-status admin-status-plain">режим: ${adminMetaEsc(mode)}</span>`];
  if (view.dimensionLocked) items.push('<span class="admin-status admin-status-plain">метаданные закреплены целиком</span>');
  if (view.disagreement) items.push('<span class="admin-status admin-status-conflict">источники расходятся</span>');
  if (view.anchorDigest === null && !view.schemaAbsent && view.mode !== 'off') items.push('<span class="admin-status admin-status-plain">идентичность неизвестна</span>');
  const note = writable.ok ? '' : `<p class="muted" data-meta-readonly>${adminMetaEsc(adminMetaRefusalText(writable.reason))}</p>`;
  return `<div class="admin-badges">${items.join('')}</div>${note}`;
}
function adminMetaFieldRow(field, entry, ctx) {
  const {writable, dimensionLocked} = ctx;
  const state = adminMetaFieldState(entry, dimensionLocked);
  const row = entry && entry.row;
  const value = adminMetaValueText(field, entry && entry.value);
  let lineage = '';
  if (row && state.unbound) {
    // the stored row describes ANOTHER value (digest mismatch): it is history, never the displayed value's source or language
    lineage = '<p class="muted" data-meta-unbound>Запись происхождения относится к другому, прежнему значению и не описывает показанное. '
      + `Историческая запись: источник ${adminMetaEsc(row.source || '')}${row.tier ? ' · ' + adminMetaEsc(row.tier) : ''}${row.language ? ' · язык ' + adminMetaEsc(row.language) : ''}.</p>`;
  } else if (row) {
    lineage = `<dl class="admin-meta-lineage"><dt>источник</dt><dd>${adminMetaEsc(row.source || '')}${row.tier ? ' · ' + adminMetaEsc(row.tier) : ''}</dd>`
      + (row.anchorScheme ? `<dt>идентичность</dt><dd>${adminMetaEsc(row.anchorScheme)}:${adminMetaEsc(row.anchorValue || '')}</dd>` : '')
      + (row.language ? `<dt>язык</dt><dd>${adminMetaEsc(row.language)}${row.languageBasis ? ' · ' + adminMetaEsc(row.languageBasis) : ''}</dd>` : '')
      + (row.observedAt ? `<dt>наблюдалось</dt><dd>${adminMetaEsc(row.observedAt)}</dd>` : '') + '</dl>';
  } else if (entry && entry.rank && !entry.blank) lineage = '<p class="muted">Происхождение не записано: значение показано как есть.</p>';
  const flags = [];
  if (state.pin && state.kind !== 'owner') flags.push('<span class="admin-status admin-status-plain">закреплено владельцем</span>');
  if (state.dimension && state.pin) flags.push('<span class="admin-status admin-status-plain">и защищено блокировкой метаданных</span>');
  if (entry && entry.mismatch) flags.push('<span class="admin-status admin-status-conflict">значение не совпадает с записью происхождения</span>');
  const disabled = writable.ok ? '' : ' disabled';
  const blank = !entry || entry.blank;
  const lockButton = state.pin
    ? `<button type="button" data-meta-action="release" data-field="${field}"${disabled}>${ADMIN_META_ACTION_TEXT.release}</button>`
    : `<button type="button" data-meta-action="lock" data-field="${field}"${disabled}${blank ? ' disabled' : ''}>${ADMIN_META_ACTION_TEXT.lock}</button>`;
  const releaseNote = state.pin && dimensionLocked ? '<p class="muted">После снятия закрепления поле остаётся под блокировкой метаданных фильма.</p>' : '';
  const inputLabel = `${ADMIN_META_FIELD_TEXT[field]}: новое значение${field === 'genres' ? ' (через запятую)' : ''}`;
  const max = ADMIN_META_MAXLENGTH[field] ? ` maxlength="${ADMIN_META_MAXLENGTH[field]}"` : '';
  const control = field === 'synopsis'
    ? `<textarea data-meta-input="${field}" rows="4"${max}${disabled}></textarea>`
    : `<input type="text" data-meta-input="${field}"${max}${disabled}>`;
  return `<li class="admin-meta-field" data-meta-field="${field}"><h4>${ADMIN_META_FIELD_TEXT[field]} <span class="admin-status admin-status-${adminMetaEsc(state.kind)}">${adminMetaEsc(state.label)}</span>${flags.join('')}</h4>`
    + `<p class="admin-meta-value">${value ? adminMetaEsc(value) : '<span class="muted">нет значения</span>'}</p>${lineage}${releaseNote}`
    + `<div class="admin-meta-controls"><label>${adminMetaEsc(inputLabel)} ${control}</label>`
    + `<button type="button" data-meta-action="set" data-field="${field}"${disabled}>${ADMIN_META_ACTION_TEXT.set}</button>${lockButton}</div></li>`;
}
function adminMetaC1(view, writable) {
  const c1 = view.c1;
  if (!c1) return '<p class="muted">Состояние обогащения каталога не установлено.</p>';
  const coreRows = (c1.rows || []).filter(row => row.part === 'core');
  const conflicts = (c1.conflicts || []).map(item => `<li>${adminMetaEsc(item.part)} · ${adminMetaEsc(item.source)}: <code>${adminMetaEsc(JSON.stringify(item.value))}</code></li>`).join('');
  const hints = (c1.hints || []).map(item => `<li>${adminMetaEsc(item.part)} · ${adminMetaEsc(item.source)}: <code>${adminMetaEsc(JSON.stringify(item.value))}</code></li>`).join('');
  const sources = coreRows.map(row => `<li>${adminMetaEsc(row.source)} · ${adminMetaEsc(row.status)}${row.reason ? ' · ' + adminMetaEsc(row.reason) : ''}</li>`).join('');
  const refreshable = coreRows.length && writable.ok;
  const credits = c1.credits && c1.credits.chunks ? `<p class="muted">Блоков состава: ${Number(c1.credits.chunks)}, с конфликтами: ${Number(c1.credits.withConflicts || 0)}.</p>` : '';
  return `<h4>Источники и конфликты</h4>${sources ? `<ul>${sources}</ul>` : '<p class="muted">Строк состояния источников нет.</p>'}`
    + `<h5>Конфликты</h5>${conflicts ? `<ul data-meta-conflicts>${conflicts}</ul>` : '<p class="muted">Конфликтов нет.</p>'}`
    + `<h5>Подсказки</h5>${hints ? `<ul data-meta-hints>${hints}</ul>` : '<p class="muted">Подсказок нет.</p>'}${credits}`
    + `<button type="button" data-meta-action="refresh"${refreshable ? '' : ' disabled'}>${ADMIN_META_ACTION_TEXT.refresh}</button>`
    + (refreshable ? '<p class="muted">Только ставит источники в очередь: значения не меняются, пока обогащение не отработает.</p>' : '');
}
function adminMetaHistoryRow(row, writable) {
  const old = row.old || {};
  const value = adminMetaValueText(row.field, old.value);
  const blocked = row.revertible ? null : row.revertBlocked;
  const button = row.revertible
    ? `<button type="button" data-meta-action="revert" data-field="${adminMetaEsc(row.field)}" data-history-ref="${Number(row.id)}"${writable.ok ? '' : ' disabled'}>${ADMIN_META_ACTION_TEXT.revert}</button>`
    : `<span class="muted" data-meta-revert-blocked="${adminMetaEsc(blocked)}">${adminMetaEsc(adminMetaRefusalText(blocked))}</span>`;
  return `<li class="admin-meta-history-row" data-history-id="${Number(row.id)}"><strong>${adminMetaEsc(ADMIN_META_FIELD_TEXT[row.field] || row.field)}</strong> · ${adminMetaEsc(row.at)} · ${adminMetaEsc(row.reason || '')}`
    + `<br>было: ${value ? adminMetaEsc(value) : '<span class="muted">пусто</span>'}${old.source ? ' · ' + adminMetaEsc(old.source) : ''}${old.language ? ' · ' + adminMetaEsc(old.language) : ''}${row.mergedFrom ? ' · из ' + adminMetaEsc(row.mergedFrom) : ''}<br>${button}</li>`;
}
function adminMetaHistory(view, writable) {
  const history = view.history || {rows: [], next: null};
  const rows = history.rows.map(row => adminMetaHistoryRow(row, writable)).join('');
  const more = history.next ? `<button type="button" data-meta-more="${adminMetaEsc(history.next)}">Показать ещё</button>` : '';
  return `<h4>Журнал изменений</h4>${rows ? `<ul data-meta-history>${rows}</ul>` : '<p class="muted" data-meta-history-empty>Записей в журнале нет.</p>'}${more}`;
}
function adminMetaHtml(view, options) {
  const writable = adminMetaWritable(view, options);
  const ctx = {writable, dimensionLocked: !!view.dimensionLocked};
  const fields = ADMIN_META_FIELDS.map(field => adminMetaFieldRow(field, view.fields && view.fields[field], ctx)).join('');
  const redirects = view.redirects && view.redirects.count ? `<p class="muted">В этот фильм объединено записей: ${Number(view.redirects.count)}. Их журнал включён ниже.</p>` : '';
  return `${adminMetaSummary(view, writable)}<ul class="admin-meta-fields">${fields}</ul>${adminMetaC1(view, writable)}${redirects}${adminMetaHistory(view, writable)}`;
}

// ---- 3. the binding ----
// ONE chain at a time: a read, a command and the readback that follows it are serialized by `state.busy`; a response that is not the latest read is dropped.
// After a command (or a stale refusal) the rendered controls stay disabled until a read SUCCEEDS; a failed read is said as such, with its own retry, and never overwrites the command's result.
// `adminMetaPending` (module level, like the title form's pending command) holds a command with an unknown outcome across a re-render of the detail: it is shown, it is the only thing
// that can be sent, and the same body is sent again. Opening or re-mounting only READS; nothing is sent without a press.
function adminBindFilmMetadata(host, storedId) {
  const section = host && host.querySelector ? host.querySelector('[data-film-metadata]') : null;
  if (!section || !storedId) return;
  const body = section.querySelector('[data-meta-body]');
  const result = section.querySelector('[data-meta-result]');
  const reading = section.querySelector('[data-meta-reading]');
  const pendingBox = section.querySelector('[data-meta-pending]');
  const label = section.getAttribute && section.getAttribute('data-film-label') || storedId;
  const state = {view: null, stale: true, loaded: false, busy: false, seq: 0, readFailed: false, dead: false};
  const mine = () => (adminMetaPending && adminMetaPending.storedId === storedId ? adminMetaPending : null);
  const elsewhere = () => (adminMetaPending && adminMetaPending.storedId !== storedId ? adminMetaPending : null);
  // a command of ANY Film in flight blocks this view's writes too
  const flying = () => !!adminMetaFlight;
  const say = text => { if (!state.dead) result.textContent = text; };
  const render = () => {
    if (state.dead) return;
    if (state.view) body.innerHTML = adminMetaHtml(state.view, {stale: state.stale || state.busy, pending: !!mine(), pendingElsewhere: !!elsewhere(), flight: flying()});
    pendingBox.innerHTML = flying() ? '<p class="muted" data-meta-flight>Идёт отправка команды…</p>' : (mine() ? adminMetaPendingHtml(mine()) : (elsewhere() ? adminMetaPendingHtml(elsewhere(), true) : ''));
    reading.innerHTML = state.readFailed ? '<span>Не удалось прочитать метаданные. Действия отключены.</span> <button type="button" data-meta-reload>Повторить чтение</button>' : (state.busy && !state.loaded ? '<span>Читаю метаданные…</span>' : '');
  };
  // one read of the first page, or of the page after `cursor`; resolves true only when the answer was applied
  const load = async cursor => {
    const token = ++state.seq;
    state.stale = true; state.readFailed = false;
    render();
    const response = await adminReadFilmMetadata(storedId, cursor);
    if (state.dead || token !== state.seq) return false; // an answer that is not the latest read, or from a view that left the screen, is dropped
    if (!response.ok) { state.readFailed = true; state.stale = true; if (response.status === 404) reading.textContent = 'Фильм не найден.'; else render(); return false; }
    const incoming = response.body;
    if (cursor && state.view) {
      // a later page carries the CURRENT revision and anchor: when they moved, the earlier rows' revert flags belong to the old state, so the first page is read again
      if (incoming.revision !== state.view.revision || incoming.anchorDigest !== state.view.anchorDigest || incoming.mode !== state.view.mode || incoming.controlRevision !== state.view.controlRevision) {
        state.seq++;
        const again = await load(null);
        if (again) say('Данные изменились, пока листался журнал: он перечитан с начала.');
        return again;
      }
      state.view = {...incoming, history: {rows: state.view.history.rows.concat(incoming.history.rows), next: incoming.history.next}};
    } else state.view = incoming;
    state.loaded = true; state.stale = false; state.readFailed = false;
    render();
    return true;
  };
  const run = async work => {
    if (state.busy || state.dead) return;
    state.busy = true;
    try { await work(); } finally {
      state.busy = false;
      // a command settled while this view was reading: what it read may predate the commit, so it reads once more before any control is enabled
      if (state.again && !state.dead) { state.again = false; run(() => load(null)); } else render();
    }
  };
  // a command that settled while ANOTHER view is on screen: the live view re-renders, and reads again when it is the Film that changed
  const settled = film => {
    const live = adminMetaLive;
    if (!live || live === self || live.state.dead) return; // the view on screen settled its own command and has just read again
    if (live.storedId === film) live.reread(); else live.render();
  };
  const send = async (command, action) => {
    const own = command.requestId;
    // the flight and the held command are claimed together, inside the serialized chain; they are released only by the attempt that owns them
    adminMetaFlight = {storedId, requestId: own};
    adminMetaPending = {storedId, label, command: JSON.parse(JSON.stringify(command))};
    state.stale = true; render();
    say('Записываем…');
    let response;
    try { response = await adminWriteFilmMetadata(storedId, command); }
    finally { /* adminWriteFilmMetadata never throws; the finally keeps the claim honest if that changes */ }
    const ownsPending = () => adminMetaPending && adminMetaPending.command.requestId === own;
    const release = () => { if (adminMetaFlight && adminMetaFlight.requestId === own) adminMetaFlight = null; };
    if (response.ok) {
      if (ownsPending()) adminMetaPending = null;
      say(adminMetaOutcomeText(response, action));
      if (state.dead) { release(); settled(storedId); return; }
      await load(null); // a failed read leaves the controls disabled and says so in its own place; the result above stays
      release(); settled(storedId); render();
      return;
    }
    if (adminMetaRetryable(response)) {
      state.stale = false; // the old read is still the latest known state; only the held command can be sent
      say(adminMetaRefusalText(response.error === 'network' ? 'network' : 'storage_unavailable'));
      release(); settled(storedId);
      return;
    }
    // a definite refusal ends THIS attempt, and only this one
    if (ownsPending()) adminMetaPending = null;
    say(adminMetaRefusalText(response.error));
    const reload = !state.dead && (response.error === 'stale_revision' || response.error === 'stale_rows');
    if (reload) await load(null); else state.stale = false;
    release(); settled(storedId); render();
  };
  const self = {storedId, state, render, reread: () => { if (state.busy) state.again = true; else run(() => load(null)); }};
  // the view that was on screen before is gone: it may still be settling a command, and must not touch this one's DOM
  if (adminMetaLive && adminMetaLive !== self) adminMetaLive.state.dead = true;
  adminMetaLive = self;
  section.addEventListener('toggle', () => { if (section.open && !state.loaded && !state.busy) run(() => load(null)); });
  section.addEventListener('click', event => {
    const target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target || target.disabled || state.busy || state.dead) return;
    if (target.hasAttribute && target.hasAttribute('data-meta-reload')) return run(() => load(null));
    if (target.hasAttribute && target.hasAttribute('data-meta-retry')) {
      const pending = mine();
      if (!pending || flying()) return;
      return run(() => send(pending.command, pending.command.action));
    }
    if (target.hasAttribute && target.hasAttribute('data-meta-discard')) {
      if (!mine() || flying()) return;
      adminMetaPending = null;
      say('Повтор отменён. Исход прошлой команды неизвестен: проверьте значение и журнал.');
      return run(() => load(null));
    }
    const more = target.getAttribute('data-meta-more');
    if (more) return run(() => load(more));
    const action = target.getAttribute('data-meta-action');
    if (!action || !state.view || state.stale || adminMetaPending || flying()) return;
    const field = target.getAttribute('data-field');
    const options = {field, requestId: adminMetaNewRequestId()};
    if (action === 'set') {
      const input = body.querySelector('[data-meta-input="' + field + '"]');
      const parsed = adminMetaParseValue(field, input ? input.value : '');
      if (parsed.error) { say(parsed.error); return; }
      options.value = parsed.value;
    }
    if (action === 'revert') options.historyRef = Number(target.getAttribute('data-history-ref'));
    const command = adminMetaCommand(state.view, action, options);
    if (action === 'refresh' && !command.expectedRows.length) { say(adminMetaRefusalText('not_in_scope')); return; }
    return run(() => send(command, action));
  });
  render();
  // a command held for THIS Film survives a re-render of the detail: show it again; this READS only and never sends
  if (mine()) { section.open = true; say(flying() ? 'Команда ещё отправляется.' : 'Команда с неизвестным исходом сохранена. Её можно повторить или отменить.'); run(() => load(null)); }
}
function adminFilmMetadataSection(record) {
  if (!record || !record.storedId) return '';
  const label = record.preferred || record.original || record.originalTitle || record.id || record.storedId;
  return `<details class="admin-meta" data-film-metadata data-stored-id="${adminMetaEsc(record.storedId)}" data-film-label="${adminMetaEsc(label)}"><summary>Происхождение метаданных</summary><div class="admin-meta-status" data-meta-result role="status" tabindex="-1"></div><div class="admin-meta-status" data-meta-reading role="status"></div><div data-meta-pending></div><div data-meta-body><p class="muted">Раздел читает данные при открытии. Запись выполняется только по кнопке.</p></div></details>`;
}
