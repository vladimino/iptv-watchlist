const ADMIN_LABELS = {
  'localization-missing': 'Локализация отсутствует',
  'localization-provisional': 'Черновая локализация',
  'localization-conflict': 'Конфликт локализации',
  'identity-unresolved': 'Идентичность не сопоставлена',
  'identity-ambiguous': 'Идентичность неоднозначна',
  'identity-rejected': 'Идентичность отклонена',
  'metadata-missing': 'Метаданные отсутствуют',
  'metadata-stale': 'Метаданные устарели',
  'metadata-failed': 'Ошибка метаданных',
  'fingerprint-not-current': 'Отпечаток не актуален',
  'prediction-not-current': 'Прогноз не актуален',
  'external-id-conflict': 'Конфликт внешнего id',
};
const STATUS_TEXT = {
  missing: 'нет данных',
  provisional: 'черновое',
  reviewed: 'проверено',
  unresolved: 'не сопоставлено',
  resolving: 'сопоставляется',
  resolved: 'сопоставлено',
  ambiguous: 'неоднозначно',
  rejected: 'отклонено',
  fresh: 'свежие',
  stale: 'устарели',
  failed: 'ошибка',
  partial: 'частично',
  fetching: 'загружается',
  generating: 'считается',
  current: 'актуально',
};
const ERROR_TEXT = {
  network: 'Нет ответа от сервера. Проверьте соединение и доступ и повторите запрос.',
  programme_unavailable: 'Опубликованная программа сейчас недоступна: нет опубликованного поколения или его объект не совпадает с указателем. Ничего не запускалось.',
  storage_unavailable: 'Хранилище не ответило. Это чтение не повторяет запись и не запускает восстановление.',
  stale_pin: 'Опубликованный снимок изменился. Обновите снимок, чтобы продолжить.',
  invalid_pin: 'Снимок в запросе не распознан. Обновите снимок.',
  invalid_limit: 'Некорректный размер страницы. Принимается целое число от 1 до 25.',
  invalid_query: 'Пустой запрос не показывает весь каталог. Введите название, имя или внешний id до 200 символов.',
  unknown_queue: 'Такой очереди нет.',
  queue_unavailable: 'Эта очередь не читается из опубликованной программы: состояние отпечатков и прогнозов хранится отдельно.',
  stale_cursor: 'Страница устарела. Откройте запрос заново.',
  not_found: 'Запись не найдена в опубликованной программе.',
  method_not_allowed: 'Этот запрос не поддерживается.',
  missing_person: 'Этого человека нет в опубликованной программе.',
  version_conflict: 'Имя уже изменилось. Обновите карточку и повторите.',
  role_version_conflict: 'Связанная роль изменилась. Обновите карточку и повторите.',
  request_id_reused: 'Этот запрос уже записан с другим содержимым.',
  unknown_alias: 'Этого варианта нет у записи.',
  unrelated_role: 'Эту роль нельзя связать: проверка не считает её тем же человеком.',
  invalid_name: 'Имя не подходит: нужна одна строка от 1 до 200 символов без управляющих знаков.',
  invalid_basis: 'Пояснение длиннее 500 символов.',
  review_incomplete: 'Связанные роли не сошлись с записью. Ничего не перезаписано.',
  storage_conflict: 'Запись одновременно изменилась. Обновите карточку и повторите.',
  origin_not_allowed: 'Запрос отклонён.',
  action_not_allowed: 'Запрос отклонён: нет подтверждения действия.',
  review_unconditional: 'Сохранённое имя нельзя перезаписать без версии объекта.',
  body_too_large: 'Запрос слишком большой.',
  review_store_unreadable: 'Хранилище имён записано в неожиданном виде. Сохранение остановлено.',
  readback_failed: 'Неизвестно, записалось ли имя. Повторите отправку: это будет та же запись, без второй правки.',
  invalid_effect: 'Команда имени не распознана. Обновите карточку и повторите.',
  roles_not_allowed: 'Добавление варианта не связывает роли. Снимите роли или включите «Использовать как предпочтительное».',
};
const SKEW_TEXT = {
  titles_newer: 'словарь названий новее программы',
  people_newer: 'словарь имён новее программы',
  dictionary_older: 'словарь старше программы',
  dictionary_missing: 'словаря нет в хранилище',
  timestamp_missing: 'у объекта нет отметки времени',
};
const ADMIN_DEBOUNCE_MS = 200;

const adminLive = {pin: null, snapshot: null, queues: null, unavailableQueues: [], seq: 0, controller: null, timer: null, pending: null, stale: false, next: {film: null, person: null}, state: null};

function adminEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function adminState() {
  const url = new URL(window.location.href);
  return {
    view: url.searchParams.get('view') === 'health' ? 'health' : 'catalog',
    q: url.searchParams.get('q') ?? '',
    queue: url.searchParams.get('queue') ?? '',
    kind: url.searchParams.get('kind') === 'person' ? 'person' : 'film',
    id: url.searchParams.get('id') ?? '',
  };
}

function adminUrl(state) {
  const params = new URLSearchParams();
  if (state.view === 'health') params.set('view', 'health');
  if (state.q) params.set('q', state.q);
  if (state.queue) params.set('queue', state.queue);
  if (state.id) {
    params.set('kind', state.kind === 'person' ? 'person' : 'film');
    params.set('id', state.id);
  }
  const query = params.toString();
  return query ? '/admin?' + query : '/admin';
}

function adminWrite(state, mode) {
  const href = adminUrl(state);
  if (mode === 'push') history.pushState(state, '', href);
  else history.replaceState(state, '', href);
}

function adminErrorText(code) {
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (/^http_\d+$/.test(String(code))) return 'Сервер ответил ошибкой ' + String(code).slice(5) + '. Результаты не загружены.';
  return 'Запрос не выполнен: ' + String(code || 'неизвестная ошибка') + '.';
}

function adminDate(value) {
  if (!value) return 'нет отметки';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function adminSnapshotText(snapshot) {
  if (!snapshot) return 'Снимок программы ещё не прочитан.';
  const generation = String(snapshot.programmeRunId || '').slice(0, 8) || '—';
  const parts = [
    'Поколение ' + generation + ', программа от ' + adminDate(snapshot.programmeUpdatedAt),
    'фильмов: ' + (snapshot.films ?? '—') + ', людей: ' + (snapshot.people ?? '—'),
    'словарь названий от ' + adminDate(snapshot.titlesUpdatedAt),
    'словарь имён от ' + adminDate(snapshot.peopleUpdatedAt),
  ];
  let text = parts.join(' · ') + '.';
  if (snapshot.skew) text += ' Расхождение: ' + (snapshot.skewReasons || []).map(reason => SKEW_TEXT[reason] || reason).join(', ') + '. Страница всё равно отвечает по этим версиям.';
  return text;
}

function adminStatus(name, value) {
  const text = STATUS_TEXT[value] || value || 'нет данных';
  const tone = value === 'reviewed' ? 'reviewed' : value === 'provisional' ? 'provisional' : value === 'ambiguous' ? 'ambiguous' : value === 'missing' || !value ? 'missing' : 'plain';
  return `<span class="admin-status admin-status-${tone}">${adminEscape(name)}: ${adminEscape(text)}</span>`;
}

function adminOutsideStatus(name) {
  return `<span class="admin-status admin-status-outside">${adminEscape(name)}: вне снимка программы</span>`;
}

function adminProvenance(provenance, seen) {
  if (!provenance || typeof provenance !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(provenance)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (seen && seen.has(text)) continue;
    if (seen) seen.add(text);
    parts.push(`${key}: ${text}`);
  }
  return parts.length ? `<span class="admin-provenance">${adminEscape(parts.join(' · '))}</span>` : '';
}

function adminSource(dimension, seen) {
  const parts = [dimension?.source ? adminEscape(dimension.source) : '', adminProvenance(dimension?.provenance, seen)].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'не указано';
}

function adminHit(item, kind, state) {
  const title = item.preferred || item.originalTitle || item.original || item.epgTitle || item.id;
  const next = adminUrl({...state, kind, id: item.id});
  const badges = [
    adminStatus(kind === 'person' ? 'имя' : 'название', item.localization?.status),
    adminStatus('идентичность', item.identity?.status),
  ];
  if (kind === 'film') badges.push(adminStatus('метаданные', item.metadata?.status));
  if ((item.localizationConflicts || []).length) badges.push('<span class="admin-status admin-status-conflict">конфликт локализации</span>');
  if ((item.externalIds || []).some(entry => entry?.conflicting)) badges.push('<span class="admin-status admin-status-conflict">конфликт внешнего id</span>');
  const collision = item.collision ? '<span class="admin-collision">Одинаковое название в этой выдаче. Записи не объединяются, canonical identity не меняется.</span>' : '';
  const current = state.kind === kind && state.id === item.id ? ' aria-current="true"' : '';
  const meta = (kind === 'film' ? [item.year ? String(item.year) : null] : [item.id, item.year ? String(item.year) : null, item.canonicalIdentity]).filter(Boolean).join(' · ');
  return `<a class="admin-hit" href="${adminEscape(next)}" data-admin-kind="${adminEscape(kind)}" data-admin-id="${adminEscape(item.id)}"${current}><span class="admin-hit-title">${adminEscape(title)}</span><span class="admin-hit-meta">${adminEscape(meta)}</span>${collision}<span class="admin-badges">${badges.join('')}</span></a>`;
}

function adminGroup(kind, items, next, state) {
  if (!items.length) return '';
  const heading = kind === 'person' ? 'Люди' : 'Фильмы';
  const more = next ? `<button type="button" class="admin-more" data-admin-more="${kind}">Показать ещё</button>` : '';
  return `<section class="admin-group" data-admin-group="${kind}"><h3>${heading} <small>${items.length}${next ? '+' : ''}</small></h3><div class="admin-group-items">${items.map(item => adminHit(item, kind, state)).join('')}</div>${more}</section>`;
}

function adminFacts(record, kind) {
  const rows = kind === 'film'
    ? [['год', record.year], ['название в программе', record.epgTitle]]
    : [
      ['id', record.id],
      ['роль', record.roleId],
      ['предпочтительное', record.preferred],
      ['оригинал', record.original],
      ['год', record.year],
      ['canonical identity', record.canonicalIdentity],
    ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => `<div><dt>${adminEscape(name)}</dt><dd>${adminEscape(value)}</dd></div>`).join('');
}

function adminAliases(record, kind) {
  const aliases = record.aliases || [];
  const person = kind === 'person';
  if (!aliases.length) return person ? '<p class="muted">Других имён нет.</p>' : '<p class="muted">Других названий нет.</p>';
  const items = aliases.map(alias => {
    const body = `${adminEscape(alias.value ?? alias)}${alias.kind ? ' · ' + adminEscape(alias.kind) : ''}`;
    // A film alias is a title the owner may pick. Its request id and provenance stay in the closed
    // technical disclosure. A person alias keeps that provenance beside the name, as before.
    return `<li>${body}${person ? ' ' + adminProvenance(alias.provenance) : ''}</li>`;
  }).join('');
  const label = person ? 'Другие имена' : 'Другие названия';
  return `<details class="other-titles"><summary>${label} (${aliases.length})</summary><ul>${items}</ul></details>`;
}

function adminExternalIds(record, seen) {
  const ids = record.externalIds || [];
  const items = [];
  const shown = new Set();
  for (const entry of ids) {
    if (!entry) continue;
    const value = entry.value == null ? '' : String(entry.value);
    const scheme = entry.scheme || 'id';
    // The same scheme and value with the same trust and conflict marks is one row. A canonical
    // identity that contains the number is not that row: the marks live only here.
    const key = scheme + '\0' + value + '\0' + (entry.trusted === true ? '1' : entry.trusted === false ? '0' : '') + '\0' + (entry.conflicting ? '1' : '');
    if (seen && shown.has(key)) continue;
    if (seen) shown.add(key);
    items.push(`<li>${adminEscape(scheme)} ${adminEscape(value)}${entry.trusted === true ? ' · доверенный' : entry.trusted === false ? ' · не доверенный' : ''}${entry.conflicting ? ' · конфликт' : ''} ${adminProvenance(entry.provenance, seen)}</li>`);
  }
  if (!items.length) return '<p class="muted">Внешних id нет.</p>';
  return `<ul>${items.join('')}</ul>`;
}

function adminFilmAliasFacts(record, seen) {
  const aliases = record.aliases || [];
  if (!aliases.length) return '';
  const items = aliases.map(alias => `<li>${adminEscape(alias.value ?? alias)}${alias.kind ? ' · ' + adminEscape(alias.kind) : ''} ${adminProvenance(alias.provenance, seen)}</li>`).join('');
  return `<h3>Происхождение вариантов</h3><ul>${items}</ul>`;
}

function adminFilmTechnical(record) {
  const seen = new Set();
  const rows = [];
  const add = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    const text = String(value);
    if (seen.has(text)) return;
    seen.add(text);
    rows.push(`<div><dt>${adminEscape(name)}</dt><dd>${adminEscape(text)}</dd></div>`);
  };
  add('id', record.id);
  add('хранение', record.storedId);
  add('canonical identity', record.canonicalIdentity);
  return `<details class="admin-technical"><summary>Технические сведения</summary><dl>${rows.join('')}</dl><h3>Внешние id</h3>${adminExternalIds(record, seen)}${adminFilmAliasFacts(record, seen)}<p>Происхождение локализации: ${adminSource(record.localization, seen)}. Происхождение идентичности: ${adminSource(record.identity, seen)}.</p></details>`;
}

function adminDetail(view) {
  const detail = document.querySelector('#admin-detail');
  if (view.mode !== 'ready' || !view.id) {
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }
  detail.hidden = false;
  if (!view.entity) {
    detail.innerHTML = '<h2 id="admin-detail-title" tabindex="-1">Запись не найдена</h2><p>В опубликованной программе нет записи с этим id.</p>';
    return;
  }
  const record = view.entity;
  const kind = view.kind === 'person' ? 'person' : 'film';
  const title = record.preferred || record.original || record.originalTitle || record.id;
  const original = kind === 'film' ? record.originalTitle : record.original;
  const originalLine = original ? `<p class="admin-original">Оригинал: ${adminEscape(original)}</p>` : '';
  const conflicts = (record.localizationConflicts || []).map(conflict => `<li>${adminEscape(conflict.value || '')}${conflict.reason ? ' · ' + adminEscape(conflict.reason) : ''}${conflict.source ? ' · ' + adminEscape(conflict.source) : ''}</li>`).join('');
  const other = kind === 'film'
    ? adminStatus('метаданные', record.metadata?.status) + (record.metadata?.nextAction && record.metadata.nextAction !== 'none' ? `<span class="admin-status admin-status-plain">следующий шаг: ${adminEscape(record.metadata.nextAction)}</span>` : '') + adminOutsideStatus('отпечаток') + adminOutsideStatus('прогноз')
    : '';
  const filmForm = kind === 'film' ? adminTitleForm(record) : '';
  const aliasBlock = adminAliases(record, kind);
  const conflictBlock = `<h3>Конфликты локализации</h3>${conflicts ? `<ul>${conflicts}</ul>` : '<p class="muted">Конфликтов локализации нет. Неоднозначная идентичность и конфликт внешнего id показаны отдельно.</p>'}`;
  const diagnostics = kind === 'person'
    ? `<details class="admin-folded"><summary>Алиасы, внешние id и конфликты</summary>${aliasBlock}<h3>Внешние id</h3>${adminExternalIds(record)}${conflictBlock}</details>`
    : `${aliasBlock}${conflictBlock}${adminFilmTechnical(record)}`;
  const filmTail = kind === 'film' ? `<h3>Другие статусы</h3><div class="admin-badges">${other}</div><p class="muted admin-outside-note">Отпечаток и прогноз хранятся вне опубликованной программы и этим чтением не читаются.</p>` : '';
  const personForm = kind === 'person' ? adminNameForm(record) : '';
  const provenance = kind === 'film'
    ? `<p class="admin-provenance">Происхождение локализации: ${adminEscape(record.localization?.source || record.localization?.provenance?.authority || 'не указано')}. Происхождение идентичности: ${adminEscape(record.identity?.source || 'не указано')}.</p>`
    : `<p class="admin-provenance">Происхождение локализации: ${adminSource(record.localization)}. Происхождение идентичности: ${adminSource(record.identity)}.</p>`;
  detail.innerHTML = `<p class="eyebrow">${kind === 'person' ? 'ЧЕЛОВЕК' : 'ФИЛЬМ'}</p><h2 id="admin-detail-title" tabindex="-1">${adminEscape(title)}</h2>${kind === 'film' ? originalLine : ''}<div class="admin-badges">${adminStatus('локализация', record.localization?.status)}${adminStatus('идентичность', record.identity?.status)}${(record.externalIds || []).some(entry => entry?.conflicting) ? '<span class="admin-status admin-status-conflict">конфликт внешнего id</span>' : ''}</div>${provenance}${filmForm}<h3>Сводка</h3><dl>${adminFacts(record, kind)}</dl>${diagnostics}${filmTail}${personForm}`;
  if (kind === 'film') adminBindTitleReview(detail);
}

// A script that happens to be Cyrillic is not a Russian title. A dictionary or owner mark on
// provenance.source or provenance.authority is enough to offer an ordinary choice. Programme,
// Letterboxd and EPG aliases stay in the collapsed list and in the API, and they are not radio
// choices unless they are the current localized preferred title or a confirmed previous one.
function adminRussianMarked(provenance) {
  if (!provenance) return false;
  return provenance.source === 'dictionary' || provenance.source === 'owner' || provenance.authority === 'dictionary' || provenance.authority === 'owner';
}

// preferredTitle falls back to the original when localization is missing. That fallback is not a
// Russian choice: only a substantive localization (provisional or reviewed) is pinned first.
function adminFilmCurrentTitle(review) {
  const preferred = review && review.preferred;
  if (!preferred || preferred.status === 'missing') return '';
  const value = typeof preferred.value === 'string' ? preferred.value.trim() : '';
  return value;
}

// A promote that landed before previousPreferred existed still names the replaced title in the
// audit. An alias add is not that replacement. A row that did not review the preferred title is not
// either. Nothing here rewrites the stored record.
function adminLegacyPrevious(review) {
  const out = [];
  const seen = new Set();
  for (const entry of (review && review.reviews) || []) {
    if (!entry || !entry.from || !entry.to) continue;
    if (entry.effect === 'alias_added') continue;
    const from = entry.from.value;
    const to = entry.to.value;
    if (!from || from === to) continue;
    if (entry.effect == null) {
      if (entry.to.status !== 'reviewed') continue;
    } else if (entry.effect !== 'preferred_changed') continue;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push(from);
  }
  return out;
}

function adminRussianChoices(review) {
  const current = adminFilmCurrentTitle(review);
  const pinned = [];
  const seen = new Set();
  const push = (value, mark) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    pinned.push({value, mark});
  };
  if (current) push(current, 'текущее предпочтительное');
  for (const option of (review && review.options) || []) {
    if (option && option.provenance && option.provenance.previousPreferred === true) push(option.value, 'было предпочтительным');
  }
  for (const value of adminLegacyPrevious(review)) push(value, 'было предпочтительным');
  const added = [];
  const rest = [];
  for (const option of (review && review.options) || []) {
    if (!option || !option.value || seen.has(option.value) || !adminRussianMarked(option.provenance)) continue;
    if (option.provenance.added === 'alias') added.push(option.value);
    else rest.push(option.value);
  }
  const ordinary = [];
  for (const value of [...added, ...rest]) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordinary.push({value, mark: ''});
    if (ordinary.length >= 5) break;
  }
  return [...pinned, ...ordinary];
}

function adminTitleHistory(review) {
  return ((review && review.reviews) || []).map(entry => {
    const when = entry.at ? ' · ' + adminEscape(entry.at) : '';
    const basis = entry.basis ? ' · ' + adminEscape(entry.basis) : '';
    if (entry.effect === 'alias_added') return `<li>добавлен вариант «${adminEscape(entry.to && entry.to.value || '')}»${when}${basis}</li>`;
    const from = entry.from && entry.from.value;
    const to = entry.to && entry.to.value || '';
    const change = from && from !== to ? `${adminEscape(from)} → ${adminEscape(to)}` : adminEscape(to);
    return `<li>${change}${when}${basis}</li>`;
  }).join('');
}

function adminTitleForm(record) {
  const review = record.titleReview;
  if (!review || !review.version || !record.storedId) return '';
  const current = adminFilmCurrentTitle(review);
  const choices = adminRussianChoices(review);
  const options = choices.map(option => `<label class="title-review-option"><input type="radio" name="title-review-choice" value="${adminEscape(option.value)}"> <span>${adminEscape(option.value)}</span>${option.mark ? ` <small class="muted">${adminEscape(option.mark)}</small>` : ''}</label>`).join('');
  const picker = options
    ? `<fieldset><legend>Варианты</legend><div class="title-review-options">${options}</div></fieldset>`
    : '<p class="muted">Нет варианта с подтверждённым русским происхождением. Введите название.</p>';
  const history = adminTitleHistory(review);
  return `<section class="title-review" aria-labelledby="title-review-title"><h3 id="title-review-title">Вариант названия</h3><form data-title-review data-film-id="${adminEscape(review.filmId || '')}" data-stored-id="${adminEscape(record.storedId)}" data-version="${adminEscape(review.version)}" data-current="${adminEscape(current)}"><p class="title-review-current">Сейчас: <b>${adminEscape(current || 'нет')}</b></p>${picker}<label>Название <input type="text" name="manual" maxlength="200" autocomplete="off" data-title-manual></label><label class="title-review-prefer"><input type="checkbox" data-title-prefer> <span>Использовать как предпочтительное</span></label><p class="title-review-preview" data-title-preview>Добавится альтернативное название; текущее предпочтительное не изменится.</p><label>Основание, необязательно <textarea name="basis" maxlength="500" rows="2"></textarea></label><button type="submit" data-title-save>Сохранить вариант</button><p class="title-review-result" data-title-result role="status" tabindex="-1"></p></form><h3>История правок</h3>${history ? `<ul>${history}</ul>` : '<p class="muted">Записей ещё нет.</p>'}</section>`;
}

// The command that was posted and whose outcome is still unknown. A refresh replaces the card and
// its version token; the retry posts this object, not a command rebuilt from the new card.
let adminTitlePending = null;

function adminTitleHold(storedId, command) {
  adminTitlePending = {storedId, command: JSON.parse(JSON.stringify(command))};
}

function adminTitleDrop() {
  adminTitlePending = null;
}

function adminTitleFrozen(storedId, requestId) {
  const pending = adminTitlePending;
  if (!pending || pending.storedId !== storedId || !requestId || pending.command.requestId !== requestId) return null;
  return pending.command;
}

function adminTitleChosen(form) {
  const manual = form.querySelector('[data-title-manual]');
  const selected = form.querySelector('input[name="title-review-choice"]:checked');
  const typed = manual ? manual.value.replace(/\s+/g, ' ').trim() : '';
  return typed || (selected && selected.value) || '';
}

function adminTitleSync(form) {
  if (!form) return;
  const save = form.querySelector('[data-title-save]');
  if (save) save.disabled = form.dataset.busy === '1';
  const preview = form.querySelector('[data-title-preview]');
  if (!preview) return;
  const box = form.querySelector('[data-title-prefer]');
  const prefer = !!(box && box.checked);
  const next = adminTitleChosen(form);
  const current = form.dataset.current || 'нет';
  if (!prefer) {
    preview.textContent = 'Добавится альтернативное название; текущее предпочтительное не изменится.';
    return;
  }
  preview.textContent = 'Сейчас: ' + current + ' → Станет: ' + (next || '…') + '. Предпочтительное название изменится во всех карточках и поиске.';
}

function adminTitleRetryText(kept) {
  const value = kept && typeof kept.value === 'string' ? kept.value : '';
  const head = 'Неизвестно, записалось ли название. Повторите отправку: это будет та же запись, без второй правки.';
  if (kept && kept.effect === 'add_alias') return head + ' Она только добавит вариант «' + value + '». Предпочтительное название не изменится.';
  return head + ' Она сделает предпочтительным «' + value + '».';
}

function adminRestoreTitleAttempt(form, kept) {
  if (!form || !kept || !kept.requestId) return;
  const manual = form.querySelector('[data-title-manual]');
  const basis = form.querySelector('[name="basis"]');
  if (basis) basis.value = kept.basis || '';
  let shown = false;
  if (kept.mode === 'alias') {
    for (const choice of form.querySelectorAll('input[name="title-review-choice"]')) {
      choice.checked = choice.value === kept.value;
      if (choice.checked) shown = true;
    }
  } else {
    for (const choice of form.querySelectorAll('input[name="title-review-choice"]')) choice.checked = false;
  }
  // A radio the refresh removed is not a cancelled command. The field shows that value, and the
  // retry still posts the original command until the owner edits the form.
  if (manual) manual.value = shown ? '' : (kept.value || '');
  const prefer = form.querySelector('[data-title-prefer]');
  // A command that omits effect is the historical promote. The checkbox shows the effect the
  // retry will apply, including when the card was rebuilt with the box off.
  if (prefer) prefer.checked = kept.effect !== 'add_alias';
  delete form.dataset.busy;
  adminTitleSync(form);
  form.dataset.requestId = kept.requestId;
}

// A 503 readback_failed can follow a put that already landed. The reread proves a promote only when
// the audit carries this requestId, an after-token and the preferred title. An added alias is proved
// by that audit plus the saved owner alias on the record. titleReview.options lists original, EPG
// and dictionary texts that were never stored as this alias, so membership there is not the proof.
// An unchanged preferred title is the ordinary result of add_alias, so it is not that proof either.
function adminOwnerAddedAlias(alias, value) {
  if (!alias) return false;
  const text = typeof alias === 'string' ? alias : alias.value;
  if (text !== value) return false;
  const provenance = alias.provenance;
  return !!(provenance && (provenance.authority === 'owner' || provenance.source === 'owner' || provenance.added === 'alias'));
}

function adminTitleReviewLanded(kept, view) {
  const entity = view && view.entity;
  const review = entity && entity.titleReview;
  if (!kept || typeof kept.requestId !== 'string' || !kept.requestId || !review) return false;
  const entry = (review.reviews || []).find(item => item && item.requestId === kept.requestId);
  if (!entry || !entry.version || typeof entry.version.after !== 'string' || !entry.version.after) return false;
  if (kept.effect === 'add_alias') {
    if (entry.effect !== 'alias_added' || !entry.to || entry.to.value !== kept.value) return false;
    return (entity.aliases || []).some(alias => adminOwnerAddedAlias(alias, kept.value));
  }
  if (entry.effect === 'alias_added') return false;
  const preferred = entity.preferred || (review.preferred && review.preferred.value);
  return preferred === kept.value;
}

function adminFinishUnknownTitle(kept, view) {
  const detail = document.querySelector('#admin-detail');
  const form = detail && detail.querySelector('[data-title-review]');
  const result = form && form.querySelector('[data-title-result]');
  if (form && adminTitleReviewLanded(kept, view)) {
    adminTitleDrop();
    delete form.dataset.requestId;
    if (result) {
      result.textContent = kept.effect === 'add_alias' ? 'Вариант записан. Предпочтительное название не изменилось.' : 'Название записано. Карточка сверена.';
      if (typeof result.focus === 'function') result.focus();
    }
    return;
  }
  if (form) adminRestoreTitleAttempt(form, kept);
  if (result) {
    result.textContent = adminTitleRetryText(kept);
    if (typeof result.focus === 'function') result.focus();
  }
}

function adminBindTitleReview(detail) {
  const form = detail.querySelector('[data-title-review]');
  if (!form) return;
  const save = form.querySelector('[data-title-save]');
  const manual = form.querySelector('[data-title-manual]');
  const result = form.querySelector('[data-title-result]');
  const prefer = form.querySelector('[data-title-prefer]');
  const discardAttempt = () => { delete form.dataset.requestId; adminTitleDrop(); };
  form.addEventListener('change', () => { discardAttempt(); adminTitleSync(form); });
  form.addEventListener('input', () => { discardAttempt(); adminTitleSync(form); });
  adminTitleSync(form);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled) return;
    const storedId = form.dataset.storedId;
    let body = adminTitleFrozen(storedId, form.dataset.requestId);
    if (!body) {
      const typed = manual.value.replace(/\s+/g, ' ').trim();
      const selected = form.querySelector('input[name="title-review-choice"]:checked');
      const value = typed || (selected ? selected.value : '');
      if (!value) { result.textContent = form.querySelector('input[name="title-review-choice"]') ? 'Выберите вариант или введите название.' : 'Введите название.'; return; }
      if (!form.dataset.requestId) form.dataset.requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      body = {filmId: form.dataset.filmId, requestId: form.dataset.requestId, mode: typed ? 'manual' : 'alias', value, expectedVersion: form.dataset.version, effect: prefer && prefer.checked ? 'promote' : 'add_alias'};
      const basis = form.querySelector('[name="basis"]').value;
      if (basis.trim()) body.basis = basis;
      adminTitleHold(storedId, body);
      body = adminTitleFrozen(storedId, body.requestId);
    }
    form.dataset.requestId = body.requestId;
    form.dataset.busy = '1';
    adminTitleSync(form);
    result.textContent = 'Записываем…';
    adminSaveFilmTitle(storedId, body).then(response => {
      form.dataset.busy = '0';
      if (response.ok) {
        adminTitleDrop();
        if (prefer) prefer.checked = false;
        adminTitleSync(form);
        const payload = response.body;
        const duplicate = payload && payload.reason === 'duplicate_alias';
        result.textContent = duplicate ? 'Такой вариант уже есть. Новой записи нет.' : payload && payload.changed === false ? 'Название уже такое. Новой записи нет.' : body.effect === 'add_alias' ? 'Вариант добавлен. Предпочтительное название не изменилось.' : 'Название записано. Обновляю карточку.';
        result.focus();
        onAdminRefresh();
        return;
      }
      if (!adminTitleFrozen(storedId, body.requestId)) {
        adminTitleSync(form);
        result.textContent = 'Поле изменено, прошлая отправка отменена. Отправьте название ещё раз.';
        result.focus();
        return;
      }
      if (response.error === 'network') {
        adminTitleSync(form);
        result.textContent = 'Нет ответа от сервера. Можно повторить: это будет та же запись, без второй правки.';
        result.focus();
        return;
      }
      if (response.status === 503 && response.error === 'readback_failed') {
        adminTitleSync(form);
        const kept = JSON.parse(JSON.stringify(body));
        result.textContent = 'Неизвестно, записалось ли название. Сверяю карточку.';
        result.focus();
        Promise.resolve(onAdminRefresh()).then(view => {
          if (!adminTitleFrozen(storedId, body.requestId)) return;
          adminFinishUnknownTitle(kept, view);
        });
        return;
      }
      if (prefer) prefer.checked = false;
      adminTitleSync(form);
      discardAttempt();
      const reason = response.error;
      result.textContent = reason === 'version_conflict' ? 'Карточка уже изменилась. Обновите страницу и повторите.' : reason === 'request_id_reused' ? 'Этот запрос уже записан с другим текстом. Отправьте название ещё раз.' : 'Записать не удалось' + (reason ? ': ' + reason : '') + '. Название не изменено.';
      result.focus();
    });
  });
}


// The current preferred text is always a choice, including a provisional Wikidata name. Every
// other radio still needs a Russian mark: owner or dictionary authority/source, an explicit
// language "ru", or previousPreferred. Script is not a language. The full option list stays
// on the record. Showing the current name does not store another alias.
function adminNameCurrentValue(review) {
  const value = review && review.preferred && review.preferred.value;
  return typeof value === 'string' && value.trim() ? value : '';
}

function adminNameRussian(option, review) {
  const provenance = option && option.provenance;
  if (provenance && typeof provenance === 'object') {
    if (provenance.previousPreferred === true) return true;
    if (provenance.authority === 'owner' || provenance.authority === 'dictionary') return true;
    if (provenance.source === 'owner' || provenance.source === 'dictionary') return true;
    if (provenance.language === 'ru') return true;
  }
  const preferred = option && option.preferred && review && review.preferred;
  if (!preferred) return false;
  return preferred.source === 'dictionary' || preferred.source === 'owner' || preferred.authority === 'dictionary' || preferred.authority === 'owner';
}

function adminNameChoices(review) {
  const current = adminNameCurrentValue(review);
  const out = [];
  const seen = new Set();
  const push = option => {
    if (!option || !option.value || seen.has(option.value)) return;
    seen.add(option.value);
    out.push(option);
  };
  if (current) push({value: current, origin: 'preferred', preferred: true});
  for (const option of (review && review.options) || []) {
    if (option && option.value === current) {
      if (out.length && out[0].value === current) out[0] = option;
      continue;
    }
    if (adminNameRussian(option, review)) push(option);
  }
  return out;
}

function adminNameForm(record) {
  const review = record.nameReview;
  if (!review || !review.version) return '';
  const current = adminNameCurrentValue(review);
  const russian = adminNameChoices(review);
  const options = russian.map(option => {
    const isCurrent = option.value === current;
    const mark = isCurrent ? ' · текущее предпочтительное' : (option.provenance && option.provenance.previousPreferred ? ' · было предпочтительным' : '');
    return `<label class="admin-name-option"><input type="radio" name="person-name-alias" value="${adminEscape(option.value)}"> <span>${adminEscape(option.value)}</span> <small class="muted">${adminEscape(option.origin || '')}${mark}</small></label>`;
  }).join('');
  const folded = (review.options || []).map(option => `<li>${adminEscape(option.value)} · ${adminEscape(option.origin || '')} ${adminProvenance(option.provenance)}</li>`).join('');
  const collisions = (review.collisions || []).map(item => `<label class="admin-name-option"><input type="checkbox" name="person-name-role" value="${adminEscape(item.id)}" data-version="${adminEscape(item.version || '')}" disabled${item.linked ? ' checked' : ''}> <span>${adminEscape(item.original || item.id)}</span> <small class="muted">${adminEscape(item.id)} · ${adminEscape(item.reason || '')}${item.linked ? ' · уже связано' : ''}</small></label>`).join('');
  const roleList = collisions ? `<fieldset><legend>Тот же человек в другой роли</legend><div class="admin-name-options">${collisions}</div></fieldset>` : '';
  const roleBlock = (review.collisions || []).length > 4 ? `<details class="admin-name-more"><summary>Тот же человек в другой роли (${review.collisions.length})</summary>${roleList}</details>` : roleList;
  const audit = (review.reviews || []).map(entry => `<li>${adminEscape(entry.at || '')} · ${adminEscape(entry.mode || '')} · ${adminEscape(entry.from?.value || '—')} → ${adminEscape(entry.to?.value || '')}${entry.linkedFrom ? ' · из ' + adminEscape(entry.linkedFrom) : ''}</li>`).join('');
  const preferred = review.preferred || {};
  return `<form id="admin-name-form" class="admin-name-form"><h3>Вариант имени</h3><p class="admin-name-current">Сейчас: <b>${adminEscape(preferred.value || 'нет')}</b></p><p class="admin-name-current">Оригинал: <b>${adminEscape(review.original || record.original || 'нет')}</b></p><p class="muted">Без галочки сохранение только добавляет вариант. Предпочтительное имя, оригинал и показы не меняются.</p>${options ? `<fieldset><legend>Варианты</legend><div class="admin-name-options">${options}</div></fieldset>` : '<p class="muted">Нет варианта с подтверждённым русским происхождением. Введите имя.</p>'}<label>Вариант<input id="admin-name-manual" name="person-name-manual" type="text" maxlength="200" autocomplete="off" spellcheck="true"></label><label class="admin-name-preferred"><input id="admin-name-preferred" name="person-name-preferred" type="checkbox"> <span>Использовать как предпочтительное</span></label><p id="admin-name-preview" class="admin-name-preview" hidden></p><label>Пояснение, необязательно<textarea id="admin-name-basis" name="person-name-basis" maxlength="500" rows="2"></textarea></label>${roleBlock}<details class="admin-name-more"><summary>Остальные варианты и происхождение</summary>${folded ? `<ul>${folded}</ul>` : '<p class="muted">Других вариантов нет.</p>'}</details>${audit ? `<details class="admin-name-more"><summary>Журнал</summary><ul>${audit}</ul></details>` : ''}<p id="admin-name-status" class="admin-name-status" role="status" tabindex="-1"></p><button type="submit">Сохранить вариант</button></form>`;
}

function adminNameRequestId() {
  return globalThis.crypto && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'person-name-' + Date.now();
}

// The command that was posted and whose outcome is still unknown. A refresh may replace the card
// and its version tokens; the retry posts this object, not a command rebuilt from the new card.
var adminNamePending = null;

function adminNameHold(personId, command) {
  adminNamePending = {personId, command: JSON.parse(JSON.stringify(command))};
}

function adminNameDrop() {
  adminNamePending = null;
}

function adminNameFrozen(personId, requestId) {
  const pending = adminNamePending;
  if (!pending || pending.personId !== personId || !requestId || pending.command.requestId !== requestId) return null;
  return pending.command;
}

function adminNameChosen(form) {
  const manualNode = form.querySelector('#admin-name-manual');
  const selected = form.querySelector('input[name="person-name-alias"]:checked');
  const manual = manualNode ? manualNode.value.replace(/\s+/g, ' ').trim() : '';
  return manual || (selected && selected.value) || '';
}

function adminNameSync(form, record) {
  if (!form) return;
  const box = form.querySelector('#admin-name-preferred');
  const prefer = !!(box && box.checked);
  for (const input of form.querySelectorAll('input[name="person-name-role"]')) input.disabled = !prefer;
  const preview = form.querySelector('#admin-name-preview');
  if (!preview) return;
  const next = adminNameChosen(form);
  const current = record && record.nameReview && record.nameReview.preferred && record.nameReview.preferred.value || 'нет';
  if (!prefer || !next) {
    preview.hidden = true;
    preview.textContent = '';
    return;
  }
  preview.hidden = false;
  preview.textContent = 'Сейчас: ' + current + ' → Станет: ' + next + '. Новое имя появится в фильмах и поиске.';
}

function adminNameCommand(form, record, requestId) {
  const manual = form.querySelector('#admin-name-manual').value.replace(/\s+/g, ' ').trim();
  const selected = form.querySelector('input[name="person-name-alias"]:checked');
  const basis = form.querySelector('#admin-name-basis').value.trim();
  const box = form.querySelector('#admin-name-preferred');
  if (!manual && !selected) return {error: 'Введите вариант или выберите его.'};
  const explicit = !!box;
  const prefer = explicit ? box.checked === true : true;
  const roles = prefer ? [...form.querySelectorAll('input[name="person-name-role"]:checked')].map(input => ({id: input.value, expectedVersion: input.getAttribute('data-version')})) : [];
  const command = {personId: record.id, requestId, mode: manual ? 'manual' : 'alias', value: manual || selected.value, expectedVersion: record.nameReview.version, ...(basis ? {basis} : {}), ...(roles.length ? {roles} : {})};
  if (explicit) command.effect = prefer ? 'promote' : 'add_alias';
  return {command};
}

function adminNameRetryText(kept) {
  const value = kept && typeof kept.value === 'string' ? kept.value : '';
  const head = 'Неизвестно, записалось ли имя. Повторите отправку: это будет та же запись, без второй правки.';
  if (kept && kept.effect === 'add_alias') return head + ' Она только добавит вариант «' + value + '». Предпочтительное имя не изменится.';
  return head + ' Она сделает предпочтительным «' + value + '».';
}

function adminRestoreNameAttempt(form, kept) {
  if (!form || !kept || !kept.requestId) return;
  const manual = form.querySelector('#admin-name-manual');
  const basis = form.querySelector('#admin-name-basis');
  if (basis) basis.value = kept.basis || '';
  let shown = false;
  if (kept.mode === 'alias') {
    for (const choice of form.querySelectorAll('input[name="person-name-alias"]')) {
      choice.checked = choice.value === kept.value;
      if (choice.checked) shown = true;
    }
  }
  // A radio that the refresh removed is not a cancelled command. The variant field shows that
  // value, and the retry still posts the original command until the owner edits the form.
  if (manual) manual.value = shown ? '' : (kept.value || '');
  const wanted = new Set((kept.roles || []).map(role => role.id));
  for (const box of form.querySelectorAll('input[name="person-name-role"]')) box.checked = wanted.has(box.value);
  const prefer = form.querySelector('#admin-name-preferred');
  // A command that omits effect is the historical promote. The checkbox shows the effect the
  // retry will apply, including when the card was rebuilt with the box off.
  if (prefer) prefer.checked = kept.effect !== 'add_alias';
  adminNameSync(form, adminLive.entity);
  form.dataset.requestId = kept.requestId;
}

// A 503 readback_failed can follow a put that already landed. The reread proves it only when the
// primary audit carries this requestId and every requested role id is linked. The preferred text
// is not that proof: a link-only command can leave the name unchanged on a card that never stored
// the link. Anything short of that proof keeps the same command.
function adminNameReviewLanded(kept, view) {
  const review = view && view.entity && view.entity.nameReview;
  if (!kept || typeof kept.requestId !== 'string' || !kept.requestId || !review) return false;
  const entry = (review.reviews || []).find(item => item && item.requestId === kept.requestId && item.linkedFrom == null);
  if (!entry) return false;
  const linked = new Set((review.roleLinks || []).map(link => link && link.id).filter(id => typeof id === 'string'));
  const wanted = Array.isArray(kept.roles) ? kept.roles.map(role => role && role.id).filter(id => typeof id === 'string') : [];
  return wanted.every(id => linked.has(id));
}

function adminFinishUnknownName(kept, view) {
  const detail = document.querySelector('#admin-detail');
  const form = detail && detail.querySelector('#admin-name-form');
  const result = form && form.querySelector('#admin-name-status');
  if (form && adminNameReviewLanded(kept, view)) {
    adminNameDrop();
    delete form.dataset.requestId;
    if (result) {
      result.textContent = kept.effect === 'add_alias' ? 'Вариант записан. Предпочтительное имя не изменилось.' : 'Имя записано. Карточка сверена.';
      if (typeof result.focus === 'function') result.focus();
    }
    return;
  }
  if (form) adminRestoreNameAttempt(form, kept);
  if (result) {
    result.textContent = adminNameRetryText(kept);
    if (typeof result.focus === 'function') result.focus();
  }
}

function onAdminNameEdit(event) {
  const target = event.target;
  const form = target && target.id === 'admin-name-form' ? target : target && target.closest ? target.closest('#admin-name-form') : null;
  if (!form || !form.dataset) return;
  adminNameSync(form, adminLive.entity);
  delete form.dataset.requestId;
  adminNameDrop();
}

async function onAdminNameSubmit(event) {
  const form = event.target && event.target.id === 'admin-name-form' ? event.target : null;
  if (!form) return;
  event.preventDefault();
  const status = form.querySelector('#admin-name-status');
  const button = form.querySelector('button[type="submit"]');
  const entity = adminLive.entity;
  if (!entity || !entity.nameReview) return;
  const frozen = adminNameFrozen(entity.id, form.dataset.requestId);
  let command = frozen;
  if (!command) {
    const requestId = form.dataset.requestId || adminNameRequestId();
    const built = adminNameCommand(form, entity, requestId);
    if (built.error) {status.textContent = built.error; return;}
    command = built.command;
    adminNameHold(entity.id, command);
  }
  form.dataset.requestId = command.requestId;
  button.disabled = true;
  status.textContent = 'Сохраняем…';
  const result = await adminPost('/people/'+encodeURIComponent(command.personId)+'/name-review', command);
  button.disabled = false;
  if (result.ok) {
    const added = command.effect === 'add_alias';
    const duplicate = result.body && result.body.reason === 'duplicate_alias';
    adminNameDrop();
    delete form.dataset.requestId;
    adminLive.pin = null;
    await adminRender();
    const statusNow = document.querySelector('#admin-name-status');
    if (statusNow) {
      statusNow.textContent = duplicate ? 'Такой вариант уже есть. Новой записи нет.' : added ? 'Вариант добавлен. Предпочтительное имя не изменилось.' : 'Имя записано. Карточка сверена.';
      if (typeof statusNow.focus === 'function') statusNow.focus();
    }
    return;
  }
  const stillPending = adminNameFrozen(entity.id, command.requestId);
  if (!stillPending) {
    status.textContent = 'Поле изменено, прошлая отправка отменена. Отправьте имя ещё раз.';
    if (typeof status.focus === 'function') status.focus();
    return;
  }
  if (result.error === 'network') {
    status.textContent = 'Нет ответа от сервера. Можно повторить: это будет та же запись, без второй правки.';
    if (typeof status.focus === 'function') status.focus();
    return;
  }
  if (result.status === 503 && result.error === 'readback_failed') {
    const kept = JSON.parse(JSON.stringify(command));
    status.textContent = 'Неизвестно, записалось ли имя. Сверяю карточку.';
    if (typeof status.focus === 'function') status.focus();
    const view = await onAdminRefresh();
    if (!adminNameFrozen(entity.id, command.requestId)) return;
    adminFinishUnknownName(kept, view);
    return;
  }
  if (!result.ok) {
    if (!adminNameCommitUnknown(result)) {
      delete form.dataset.requestId;
      adminNameDrop();
    }
    status.textContent = adminNameCommitUnknown(result) ? ERROR_TEXT.readback_failed : adminErrorText(result.error);
    if (typeof status.focus === 'function') status.focus();
  }
}

function adminRenderQueues(state) {
  const queues = document.querySelector('#admin-queues');
  queues.innerHTML = (adminLive.queues || []).map(item => {
    const pressed = state.queue === item.code;
    return `<button type="button" class="admin-queue" data-admin-queue="${adminEscape(item.code)}" data-admin-kind="${adminEscape(item.kind)}" aria-pressed="${pressed ? 'true' : 'false'}"><span>${adminEscape(ADMIN_LABELS[item.code] || item.code)}</span><small>${item.kind === 'person' ? 'люди' : 'фильмы'} · ${item.count}</small></button>`;
  }).join('');
  const note = document.querySelector('#admin-queues-note');
  const unavailable = adminLive.unavailableQueues || [];
  note.hidden = !unavailable.length;
  note.textContent = unavailable.length ? 'Не читаются из опубликованной программы: ' + unavailable.map(code => ADMIN_LABELS[code] || code).join(', ') + '.' : '';
}

function adminShow(view, state) {
  adminLive.entity = view.entity || null;
  const loading = document.querySelector('#admin-loading');
  const error = document.querySelector('#admin-error');
  const stale = document.querySelector('#admin-stale');
  const empty = document.querySelector('#admin-empty');
  const results = document.querySelector('#admin-results');
  const resultsSection = results.closest ? results.closest('section') : null;
  loading.hidden = true;
  stale.hidden = !adminLive.stale;
  document.querySelector('#admin-snapshot-text').textContent = adminSnapshotText(adminLive.snapshot);
  document.querySelector('#admin-snapshot').setAttribute('data-admin-skew', adminLive.snapshot?.skew ? 'true' : 'false');
  adminRenderQueues(state);
  error.hidden = view.mode !== 'error';
  error.textContent = view.mode === 'error' ? adminErrorText(view.error) : '';
  const showResults = view.mode === 'ready';
  if (resultsSection) resultsSection.hidden = !showResults;
  if (!showResults) {
    empty.hidden = true;
    results.innerHTML = '';
    adminDetail(view);
    return;
  }
  const hasQuery = Boolean(state.q.trim() || state.queue);
  if (!hasQuery) {
    empty.hidden = true;
    results.innerHTML = '<p class="muted">Введите запрос или выберите очередь.</p>';
    adminDetail(view);
    return;
  }
  const filmHtml = adminGroup('film', view.filmResults, adminLive.next.film, state);
  const personHtml = adminGroup('person', view.personResults, adminLive.next.person, state);
  empty.hidden = Boolean(filmHtml || personHtml);
  results.innerHTML = filmHtml + personHtml;
  adminDetail(view);
}

function adminShowView(view) {
  const health = document.querySelector('#admin-health');
  const catalog = document.querySelector('#admin-catalog');
  health.hidden = view !== 'health';
  catalog.hidden = view === 'health';
  for (const name of ['catalog', 'health']) {
    const link = document.querySelector('#admin-view-' + name);
    if (link) link.setAttribute('aria-current', view === name ? 'page' : 'false');
  }
}

const adminHealth = {seq: 0, pending: null, body: null, pin: null, stale: false};

// One GET /api/admin/health. The held pin is sent so a changed snapshot shows as stale; a refresh drops the pin and
// reads whatever is published now. The last answer stays on screen while the next one loads.
function adminRenderHealth(options = {}) {
  const seq = ++adminHealth.seq;
  const pin = options.refresh ? null : adminHealth.pin;
  healthState('loading');
  const pending = adminCall('/health', {}, {pin}).then(result => {
    if (seq !== adminHealth.seq) return result;
    if (result.status === 409) {
      adminHealth.stale = true;
      healthState('stale');
      return result;
    }
    if (!result.ok) {
      healthState('error', adminErrorText(result.error));
      return result;
    }
    adminHealth.stale = false;
    adminHealth.body = result.body;
    adminHealth.pin = result.body.pin || null;
    adminLive.pin = adminLive.pin || adminHealth.pin;
    healthState('ready');
    renderAdminHealth(result.body);
    return result;
  });
  adminHealth.pending = pending;
  return pending;
}

function onAdminHealthRefresh() {
  return adminRenderHealth({refresh: true});
}

function adminRender() {
  const state = adminState();
  adminLive.state = state;
  adminShowView(state.view);
  if (state.view === 'health') {
    const pending = adminRenderHealth();
    adminLive.pending = pending;
    return pending;
  }
  const seq = ++adminLive.seq;
  if (adminLive.controller) adminLive.controller.abort();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  adminLive.controller = controller;
  const search = document.querySelector('#admin-search');
  if (search.value !== state.q) search.value = state.q;
  document.querySelector('#admin-loading').hidden = false;
  const pending = loadAdminLive(state, {pin: adminLive.pin, queues: adminLive.queues, snapshot: adminLive.snapshot, unavailableQueues: adminLive.unavailableQueues, signal: controller ? controller.signal : undefined}).then(view => {
    if (seq !== adminLive.seq || view.mode === 'aborted') return view;
    if (view.mode === 'stale') {
      adminLive.stale = true;
      document.querySelector('#admin-loading').hidden = true;
      document.querySelector('#admin-stale').hidden = false;
      document.querySelector('#admin-error').hidden = true;
      return view;
    }
    if (view.mode === 'ready') {
      adminLive.pin = view.pin || adminLive.pin;
      adminLive.snapshot = view.snapshot || adminLive.snapshot;
      if (view.queues && view.queues.length) {
        adminLive.queues = view.queues;
        adminLive.unavailableQueues = view.unavailableQueues || [];
      }
      adminLive.next = {film: view.filmNext, person: view.personNext};
      adminLive.stale = false;
    }
    adminShow(view, state);
    return view;
  });
  adminLive.pending = pending;
  return pending;
}

function adminSchedule() {
  if (adminLive.timer) clearTimeout(adminLive.timer);
  adminLive.timer = setTimeout(() => {
    adminLive.timer = null;
    adminRender();
  }, ADMIN_DEBOUNCE_MS);
}

function onAdminRefresh() {
  adminLive.pin = null;
  adminLive.snapshot = null;
  adminLive.queues = null;
  adminLive.stale = false;
  adminLive.next = {film: null, person: null};
  document.querySelector('#admin-stale').hidden = true;
  return adminRender();
}

function onAdminMore(kind) {
  const state = adminState();
  const cursor = adminLive.next[kind];
  if (!cursor) return Promise.resolve(null);
  const button = document.querySelector(`[data-admin-more="${kind}"]`);
  if (button) button.disabled = true;
  const seq = adminLive.seq;
  const pending = loadAdminMore(state, kind, cursor, {pin: adminLive.pin}).then(page => {
    if (seq !== adminLive.seq) return page;
    if (page.mode === 'stale') {
      adminLive.stale = true;
      document.querySelector('#admin-stale').hidden = false;
      if (button) button.disabled = false;
      return page;
    }
    if (page.mode === 'error') {
      const error = document.querySelector('#admin-error');
      error.hidden = false;
      error.textContent = adminErrorText(page.error);
      if (button) button.disabled = false;
      return page;
    }
    adminLive.next[kind] = page.nextCursor;
    const group = document.querySelector(`[data-admin-group="${kind}"] .admin-group-items`);
    if (group) group.insertAdjacentHTML('beforeend', page.items.map(item => adminHit(item, kind, state)).join(''));
    if (button && !page.nextCursor) button.remove();
    else if (button) button.disabled = false;
    return page;
  });
  adminLive.pending = pending;
  return pending;
}

function onAdminSearch() {
  const state = adminState();
  state.q = document.querySelector('#admin-search').value;
  adminWrite(state, 'replace');
  adminSchedule();
}

function onAdminView(event) {
  const link = event.target.closest ? event.target.closest('[data-admin-view]') : null;
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault();
  const state = adminState();
  state.view = link.getAttribute('data-admin-view') === 'health' ? 'health' : 'catalog';
  adminWrite(state, 'push');
  return adminRender();
}

function onAdminHealthLink(event) {
  const link = event.target.closest ? event.target.closest('[data-admin-id]') : null;
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault();
  const state = adminState();
  state.view = 'catalog';
  state.kind = link.getAttribute('data-admin-kind');
  state.id = link.getAttribute('data-admin-id');
  adminWrite(state, 'push');
  return adminRender();
}

function onAdminResult(event) {
  const more = event.target.closest ? event.target.closest('[data-admin-more]') : null;
  if (more) {
    event.preventDefault();
    onAdminMore(more.getAttribute('data-admin-more'));
    return;
  }
  const link = event.target.closest ? event.target.closest('[data-admin-id]') : null;
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault();
  const state = adminState();
  state.kind = link.getAttribute('data-admin-kind');
  state.id = link.getAttribute('data-admin-id');
  adminWrite(state, 'push');
  return adminRender().then(view => {
    const title = document.querySelector('#admin-detail-title');
    if (title) title.focus();
    return view;
  });
}

function onAdminQueue(event) {
  const button = event.target.closest ? event.target.closest('[data-admin-queue]') : null;
  if (!button) return;
  const state = adminState();
  const code = button.getAttribute('data-admin-queue');
  state.queue = state.queue === code ? '' : code;
  adminWrite(state, 'push');
  return adminRender();
}

function onAdminKey(event) {
  if (event.key !== 'Escape') return;
  if (event.target && event.target.closest && (event.target.closest('#admin-name-form') || event.target.closest('[data-title-review]'))) return;
  const state = adminState();
  if (state.view === 'health' || !state.q) return;
  event.preventDefault();
  state.q = '';
  adminWrite(state, 'replace');
  const search = document.querySelector('#admin-search');
  search.value = '';
  adminRender();
  search.focus();
}

function onAdminHistory() {
  return adminRender();
}

function startAdmin() {
  document.querySelector('#admin-search').form.addEventListener('submit', event => {
    event.preventDefault();
    if (adminLive.timer) clearTimeout(adminLive.timer);
    adminLive.timer = null;
    adminRender();
  });
  document.querySelector('#admin-search').addEventListener('input', onAdminSearch);
  document.querySelector('#admin-results').addEventListener('click', onAdminResult);
  document.querySelector('#admin-detail').addEventListener('submit', onAdminNameSubmit);
  document.querySelector('#admin-detail').addEventListener('input', onAdminNameEdit);
  document.querySelector('#admin-detail').addEventListener('change', onAdminNameEdit);
  document.querySelector('#admin-queues').addEventListener('click', onAdminQueue);
  document.querySelector('#admin-refresh').addEventListener('click', onAdminRefresh);
  document.querySelector('.admin-views').addEventListener('click', onAdminView);
  document.querySelector('#admin-health-refresh').addEventListener('click', onAdminHealthRefresh);
  document.querySelector('#admin-health-stale-refresh').addEventListener('click', onAdminHealthRefresh);
  document.querySelector('#admin-health-issues').addEventListener('click', onAdminHealthLink);
  window.addEventListener('keydown', onAdminKey);
  window.addEventListener('popstate', onAdminHistory);
  adminWrite(adminState(), 'replace');
  adminRender();
}

startAdmin();
