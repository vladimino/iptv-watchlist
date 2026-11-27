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
  stale_revision: 'Карточка изменилась с момента чтения. Данные перечитаны, повторите действие.',
  stale_rows: 'Состояние источников изменилось с момента чтения. Данные перечитаны, повторите действие.',
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
  invalid_value: 'Значение не подходит для этого поля.',
  invalid_command: 'Команда составлена неверно.',
  not_owner: 'Действие доступно только владельцу.',
  forbidden: 'Действие доступно только владельцу.',
  storage_unavailable: 'Хранилище не ответило, результат неизвестен. Можно отправить ту же команду ещё раз: requestId решит, записана ли она.',
  network: 'Нет ответа от сервера. Можно повторить: это будет та же команда, без второй правки.',
};
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
// Whether a write can be offered at all, and the reason when it cannot.
function adminMetaWritable(view) {
  if (!view || view.redirectedTo) return {ok: false, reason: 'redirected'};
  if (view.schemaAbsent) return {ok: false, reason: 'schema_absent'};
  if (view.mode === 'off') return {ok: false, reason: 'provenance_off'};
  return {ok: true, reason: null};
}
// The state of one field as the owner must read it: never more provenance than the API stored.
function adminMetaFieldState(entry) {
  if (!entry) return {kind: 'none', label: 'нет данных'};
  if (entry.blank) return {kind: 'blank', label: 'пусто'};
  if (!entry.rank) return {kind: 'plain', label: 'происхождение недоступно'};
  if (!entry.row) return {kind: 'unattributed', label: 'без происхождения (unattributed)'};
  if (entry.row.tier === 'owner' && entry.rank.name === 'owner') return {kind: 'locked', label: 'закреплено владельцем'};
  return {kind: entry.rank.name, label: ADMIN_META_RANK_TEXT[entry.rank.name] || entry.rank.name};
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

// ---- 3. the HTML ----
function adminMetaSummary(view) {
  const writable = adminMetaWritable(view);
  const mode = view.schemaAbsent ? 'схема не установлена' : (ADMIN_META_MODE_TEXT[view.mode] || adminMetaText(view.mode) || 'не указан');
  const items = [`<span class="admin-status admin-status-plain">режим: ${adminMetaEsc(mode)}</span>`];
  if (view.dimensionLocked) items.push('<span class="admin-status admin-status-plain">метаданные закреплены целиком</span>');
  if (view.disagreement) items.push('<span class="admin-status admin-status-conflict">источники расходятся</span>');
  if (view.anchorDigest === null && !view.schemaAbsent && view.mode !== 'off') items.push('<span class="admin-status admin-status-plain">идентичность неизвестна</span>');
  const note = writable.ok ? '' : `<p class="muted" data-meta-readonly>${adminMetaEsc(adminMetaRefusalText(writable.reason))}</p>`;
  return `<div class="admin-badges">${items.join('')}</div>${note}`;
}
function adminMetaFieldRow(field, entry, writable) {
  const state = adminMetaFieldState(entry);
  const row = entry && entry.row;
  const value = adminMetaValueText(field, entry && entry.value);
  const lineage = row
    ? `<dl class="admin-meta-lineage"><dt>источник</dt><dd>${adminMetaEsc(row.source || '')}${row.tier ? ' · ' + adminMetaEsc(row.tier) : ''}</dd>`
      + (row.anchorScheme ? `<dt>идентичность</dt><dd>${adminMetaEsc(row.anchorScheme)}:${adminMetaEsc(row.anchorValue || '')}</dd>` : '')
      + (row.language ? `<dt>язык</dt><dd>${adminMetaEsc(row.language)}${row.languageBasis ? ' · ' + adminMetaEsc(row.languageBasis) : ''}</dd>` : '')
      + (row.observedAt ? `<dt>наблюдалось</dt><dd>${adminMetaEsc(row.observedAt)}</dd>` : '') + '</dl>'
    : (entry && entry.rank ? '<p class="muted">Происхождение не записано: значение показано как есть.</p>' : '');
  const flags = [];
  if (entry && entry.mismatch) flags.push('<span class="admin-status admin-status-conflict">идентичность изменилась</span>');
  if (entry && entry.rank && entry.bound === false && !entry.blank) flags.push('<span class="admin-status admin-status-plain">значение не привязано к записи</span>');
  const disabled = writable.ok ? '' : ' disabled';
  const lockButton = entry && entry.locked
    ? `<button type="button" data-meta-action="release" data-field="${field}"${disabled}>${ADMIN_META_ACTION_TEXT.release}</button>`
    : `<button type="button" data-meta-action="lock" data-field="${field}"${disabled}${entry && entry.blank ? ' disabled' : ''}>${ADMIN_META_ACTION_TEXT.lock}</button>`;
  const inputLabel = `${ADMIN_META_FIELD_TEXT[field]}: новое значение${field === 'genres' ? ' (через запятую)' : ''}`;
  return `<li class="admin-meta-field" data-meta-field="${field}"><h4>${ADMIN_META_FIELD_TEXT[field]} <span class="admin-status admin-status-${adminMetaEsc(state.kind)}">${adminMetaEsc(state.label)}</span>${flags.join('')}</h4>`
    + `<p class="admin-meta-value">${value ? adminMetaEsc(value) : '<span class="muted">нет значения</span>'}</p>${lineage}`
    + `<div class="admin-meta-controls"><label>${adminMetaEsc(inputLabel)} <input type="text" data-meta-input="${field}" maxlength="2000"${disabled}></label>`
    + `<button type="button" data-meta-action="set" data-field="${field}"${disabled}>${ADMIN_META_ACTION_TEXT.set}</button>${lockButton}</div></li>`;
}
function adminMetaC1(view) {
  const c1 = view.c1;
  if (!c1) return '<p class="muted">Состояние обогащения каталога не установлено.</p>';
  const coreRows = (c1.rows || []).filter(row => row.part === 'core');
  const conflicts = (c1.conflicts || []).map(item => `<li>${adminMetaEsc(item.part)} · ${adminMetaEsc(item.source)}: <code>${adminMetaEsc(JSON.stringify(item.value))}</code></li>`).join('');
  const hints = (c1.hints || []).map(item => `<li>${adminMetaEsc(item.part)} · ${adminMetaEsc(item.source)}: <code>${adminMetaEsc(JSON.stringify(item.value))}</code></li>`).join('');
  const sources = coreRows.map(row => `<li>${adminMetaEsc(row.source)} · ${adminMetaEsc(row.status)}${row.reason ? ' · ' + adminMetaEsc(row.reason) : ''}</li>`).join('');
  const writable = adminMetaWritable(view);
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
function adminMetaHtml(view) {
  const writable = adminMetaWritable(view);
  const fields = ADMIN_META_FIELDS.map(field => adminMetaFieldRow(field, view.fields && view.fields[field], writable)).join('');
  const redirects = view.redirects && view.redirects.count ? `<p class="muted">В этот фильм объединено записей: ${Number(view.redirects.count)}. Их журнал включён ниже.</p>` : '';
  return `${adminMetaSummary(view)}<ul class="admin-meta-fields">${fields}</ul>${adminMetaC1(view)}${redirects}${adminMetaHistory(view, writable)}`;
}

// ---- 3. the binding ----
// `state.pending` is the unfinished command: while the outcome is unknown the SAME command (same requestId, same body) is sent again.
function adminBindFilmMetadata(host, storedId) {
  const section = host && host.querySelector ? host.querySelector('[data-film-metadata]') : null;
  if (!section || !storedId) return;
  const body = section.querySelector('[data-meta-body]');
  const status = section.querySelector('[data-meta-status]');
  const state = {view: null, pending: null, loaded: false, busy: false};
  const say = text => { status.textContent = text; };
  const render = () => { body.innerHTML = adminMetaHtml(state.view); };
  const load = async cursor => {
    say('Читаю метаданные…');
    const response = await adminReadFilmMetadata(storedId, cursor);
    if (!response.ok) { say(response.status === 404 ? 'Фильм не найден.' : 'Не удалось прочитать метаданные. Можно открыть раздел ещё раз.'); state.loaded = false; return false; }
    if (cursor && state.view) {
      state.view = {...response.body, history: {rows: state.view.history.rows.concat(response.body.history.rows), next: response.body.history.next}};
    } else state.view = response.body;
    state.loaded = true;
    render();
    say('');
    return true;
  };
  section.addEventListener('toggle', () => { if (section.open && !state.loaded) load(null); });
  body.addEventListener('click', async event => {
    const target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target || target.disabled || state.busy) return;
    const more = target.getAttribute('data-meta-more');
    if (more) { state.busy = true; await load(more); state.busy = false; return; }
    const action = target.getAttribute('data-meta-action');
    if (!action || !state.view) return;
    const field = target.getAttribute('data-field');
    let command = state.pending && state.pending.signature === action + '|' + (field || '') + '|' + (target.getAttribute('data-history-ref') || '') ? state.pending.command : null;
    if (!command) {
      const options = {field, requestId: adminMetaNewRequestId()};
      if (action === 'set') {
        const input = body.querySelector('[data-meta-input="' + field + '"]');
        const parsed = adminMetaParseValue(field, input ? input.value : '');
        if (parsed.error) { say(parsed.error); return; }
        options.value = parsed.value;
      }
      if (action === 'revert') options.historyRef = Number(target.getAttribute('data-history-ref'));
      command = adminMetaCommand(state.view, action, options);
      if (action === 'refresh' && !command.expectedRows.length) { say(adminMetaRefusalText('not_in_scope')); return; }
      state.pending = {signature: action + '|' + (field || '') + '|' + (target.getAttribute('data-history-ref') || ''), command};
    }
    state.busy = true;
    say('Записываем…');
    const response = await adminWriteFilmMetadata(storedId, command);
    state.busy = false;
    if (response.ok) {
      state.pending = null;
      say(adminMetaOutcomeText(response, action));
      await load(null);
      say(adminMetaOutcomeText(response, action));
      return;
    }
    if (adminMetaRetryable(response)) { say(adminMetaRefusalText(response.error === 'network' ? 'network' : 'storage_unavailable')); return; }
    // a definite refusal: the attempt is over, the readback is refreshed so the next command is planned on what is stored now
    state.pending = null;
    say(adminMetaRefusalText(response.error));
    if (response.error === 'stale_revision' || response.error === 'stale_rows') { const message = adminMetaRefusalText(response.error); await load(null); say(message); }
  });
}
function adminFilmMetadataSection(record) {
  if (!record || !record.storedId) return '';
  return `<details class="admin-meta" data-film-metadata data-stored-id="${adminMetaEsc(record.storedId)}"><summary>Происхождение метаданных</summary><div class="admin-meta-status" data-meta-status role="status" tabindex="-1"></div><div data-meta-body><p class="muted">Раздел читает данные при открытии. Запись выполняется только по кнопке.</p></div></details>`;
}
