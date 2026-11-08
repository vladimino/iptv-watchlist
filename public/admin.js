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
  roles_not_allowed: 'Добавление варианта не связывает роли. Снимите роли или нажмите «Сделать предпочтительным».',
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
    view: url.pathname === '/admin/health' || url.searchParams.get('view') === 'health' ? 'health' : 'catalog',
    q: url.searchParams.get('q') ?? '',
    queue: url.searchParams.get('queue') ?? '',
    kind: url.searchParams.get('kind') === 'person' ? 'person' : 'film',
    id: url.searchParams.get('id') ?? '',
  };
}

function adminUrl(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.queue) params.set('queue', state.queue);
  if (state.id) {
    params.set('kind', state.kind === 'person' ? 'person' : 'film');
    params.set('id', state.id);
  }
  const path = state.view === 'health' ? '/admin/health' : '/admin';
  const query = params.toString();
  // The programme page this admin was opened from stays reachable: its target is part of every admin URL (AIR-380).
  return ReturnHome.keep(query ? path + '?' + query : path, window.location.search);
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
    // A film row is the title text. `kind: title` is the model default, not a label. Provenance
    // and kind stay in the closed technical disclosure. A person row keeps its kind and provenance.
    const body = person
      ? `${adminEscape(alias.value ?? alias)}${alias.kind ? ' · ' + adminEscape(alias.kind) : ''} ${adminProvenance(alias.provenance)}`
      : adminEscape(alias.value ?? alias);
    return `<li>${body}</li>`;
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

function adminDetailHost() {
  return document.querySelector('#admin-detail-body') || document.querySelector('#admin-detail');
}

function adminDetail(view) {
  const detail = document.querySelector('#admin-detail');
  const host = adminDetailHost();
  if (!detail || !host) return;
  if (view.mode !== 'ready' || !view.id) {
    detail.hidden = true;
    host.innerHTML = '';
    adminPlaceCatalog();
    return;
  }
  detail.hidden = false;
  if (!view.entity) {
    host.innerHTML = '<h2 id="admin-detail-title" tabindex="-1">Запись не найдена</h2><p>В опубликованной программе нет записи с этим id.</p>';
    adminPlaceCatalog();
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
  const conflictBlock = `<details class="admin-conflicts"><summary>Конфликты локализации</summary>${conflicts ? `<ul>${conflicts}</ul>` : '<p class="muted">Конфликтов локализации нет. Неоднозначная идентичность и конфликт внешнего id показаны отдельно.</p>'}</details>`;
  const diagnostics = kind === 'person'
    ? `<details class="admin-folded"><summary>Алиасы, внешние id и конфликты</summary>${aliasBlock}<h3>Внешние id</h3>${adminExternalIds(record)}${conflictBlock}</details>`
    : `${aliasBlock}${conflictBlock}${adminFilmTechnical(record)}`;
  const filmTail = kind === 'film' ? `<h3>Другие статусы</h3><div class="admin-badges">${other}</div><p class="muted admin-outside-note">Отпечаток и прогноз хранятся вне опубликованной программы и этим чтением не читаются.</p>` : '';
  const filmJournal = kind === 'film' ? adminTitleJournal(record) : '';
  const personForm = kind === 'person' ? adminNameForm(record) : '';
  const provenance = kind === 'film'
    ? `<p class="admin-provenance">Происхождение локализации: ${adminEscape(record.localization?.source || record.localization?.provenance?.authority || 'не указано')}. Происхождение идентичности: ${adminEscape(record.identity?.source || 'не указано')}.</p>`
    : `<p class="admin-provenance">Происхождение локализации: ${adminSource(record.localization)}. Происхождение идентичности: ${adminSource(record.identity)}.</p>`;
  host.innerHTML = `<p class="eyebrow">${kind === 'person' ? 'ЧЕЛОВЕК' : 'ФИЛЬМ'}</p><h2 id="admin-detail-title" tabindex="-1">${adminEscape(title)}</h2>${kind === 'film' ? originalLine : ''}<div class="admin-badges">${adminStatus('локализация', record.localization?.status)}${adminStatus('идентичность', record.identity?.status)}${(record.externalIds || []).some(entry => entry?.conflicting) ? '<span class="admin-status admin-status-conflict">конфликт внешнего id</span>' : ''}</div>${provenance}${filmForm}<h3>Сводка</h3><dl>${adminFacts(record, kind)}</dl>${diagnostics}${filmTail}${filmJournal}${personForm}`;
  if (kind === 'film') adminBindTitleReview(host);
  else {
    const form = host.querySelector('#admin-name-form');
    if (form && adminNamePending && adminNamePending.personId === record.id) adminRestoreNameAttempt(form, adminNamePending.command);
    else if (form) adminNameSync(form, record);
  }
  adminPlaceCatalog();
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

// The stored audit keeps the original UTC instant. The card shows Madrid civil time only.
function adminMadridWhen(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return formatted.replace(/[\u00a0\u202f]/g, ' ') + ' (Мадрид)';
}

function adminTitleHistory(review) {
  return ((review && review.reviews) || []).map(entry => {
    const whenText = adminMadridWhen(entry.at);
    const when = whenText ? ' · ' + adminEscape(whenText) : '';
    const basis = entry.basis ? ' · ' + adminEscape(entry.basis) : '';
    if (entry.effect === 'alias_added') return `<li>добавлен вариант «${adminEscape(entry.to && entry.to.value || '')}»${when}${basis}</li>`;
    const from = entry.from && entry.from.value;
    const to = entry.to && entry.to.value || '';
    const change = from && from !== to ? `${adminEscape(from)} → ${adminEscape(to)}` : adminEscape(to);
    return `<li>${change}${when}${basis}</li>`;
  }).join('');
}

// The audit is not part of the form. An empty trail adds nothing. A trail is one closed
// disclosure, and the card places it after every other film section.
function adminTitleJournal(record) {
  const review = record && record.titleReview;
  const entries = (review && review.reviews) || [];
  if (!entries.length) return '';
  return `<details class="title-review-journal"><summary>Журнал (${entries.length})</summary><ul>${adminTitleHistory(review)}</ul></details>`;
}

function adminChoiceSource(review, value) {
  const option = ((review && review.options) || []).find(item => item && item.value === value);
  const provenance = option && option.provenance;
  if (!provenance) return '';
  return provenance.source || provenance.authority || '';
}

function adminTitleForm(record) {
  const review = record.titleReview;
  if (!review || !review.version || !record.storedId) return '';
  const current = adminFilmCurrentTitle(review);
  const choices = adminRussianChoices(review);
  const options = choices.map(option => {
    const source = adminChoiceSource(review, option.value);
    const mark = option.mark ? `<small class="muted">${adminEscape(option.mark)}</small>` : '';
    const from = source ? `<small class="muted">${adminEscape(source)}</small>` : '';
    return `<label class="title-review-option"><input type="radio" name="title-review-choice" value="${adminEscape(option.value)}"> <span>${adminEscape(option.value)}</span>${mark ? ' ' + mark : ''}${from ? ' ' + from : ''}</label>`;
  }).join('');
  const picker = options
    ? `<fieldset><legend>Варианты</legend><div class="title-review-options">${options}</div></fieldset>`
    : '<p class="muted">Нет варианта с подтверждённым русским происхождением. Введите название.</p>';
  return `<section class="title-review" aria-labelledby="title-review-title"><h3 id="title-review-title">Название</h3><form data-title-review data-film-id="${adminEscape(review.filmId || '')}" data-stored-id="${adminEscape(record.storedId)}" data-version="${adminEscape(review.version)}" data-current="${adminEscape(current)}"><p class="title-review-current">Сейчас: <b>${adminEscape(current || 'нет')}</b></p><p class="muted">«Добавить вариант» не меняет предпочтительное название. «Сделать предпочтительным» меняет его в карточках и поиске.</p>${picker}<label>Название <input type="text" name="manual" maxlength="200" autocomplete="off" data-title-manual></label><p class="title-review-preview" data-title-preview aria-live="polite" hidden></p><label>Основание, необязательно <textarea name="basis" maxlength="500" rows="2"></textarea></label><div class="title-review-actions"><button type="submit" data-title-add data-title-effect="add_alias">Добавить вариант</button><button type="submit" data-title-promote data-title-effect="promote">Сделать предпочтительным</button></div><p class="title-review-result" data-title-result role="status" tabindex="-1"></p></form></section>`;
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

function adminTitleManual(form) {
  const manual = form.querySelector('[data-title-manual]');
  return manual ? manual.value.replace(/\s+/g, ' ').trim() : '';
}

function adminTitleSelected(form) {
  return form.querySelector('input[name="title-review-choice"]:checked');
}

// An existing radio is already on the film. Adding it again is not a command. The current
// preferred title is not a command either. A typed title is a command: the server decides duplicates.
function adminTitleBlocked(form, effect) {
  const typed = adminTitleManual(form);
  const selected = adminTitleSelected(form);
  const next = typed || (selected && selected.value) || '';
  if (!next) return 'Выберите вариант или введите название.';
  const current = form.dataset.current || '';
  if (effect === 'promote') return next === current ? 'Это уже предпочтительное название.' : '';
  if (!typed && selected) return 'Этот вариант уже есть. «Добавить вариант» ничего не запишет.';
  if (typed === current) return 'Это уже предпочтительное название. Новой записи нет.';
  return '';
}

function adminTitlePreviewText(form, effect) {
  const next = adminTitleChosen(form);
  const current = form.dataset.current || '';
  if (!next || adminTitleBlocked(form, effect)) return '';
  if (effect === 'promote') return 'Сейчас: ' + (current || 'нет') + ' → Станет: ' + next + '. Предпочтительное название изменится во всех карточках и поиске.';
  return 'Сейчас: ' + (current || 'нет') + ' → Станет: ' + (current || 'нет') + '. Добавится вариант «' + next + '». Предпочтительное название не изменится.';
}

function adminTitleSync(form) {
  if (!form) return;
  const add = form.querySelector('[data-title-add]');
  const promote = form.querySelector('[data-title-promote]');
  const preview = form.querySelector('[data-title-preview]');
  const result = form.querySelector('[data-title-result]');
  const frozen = !!(form.dataset.requestId && adminTitleFrozen(form.dataset.storedId, form.dataset.requestId));
  const busy = form.dataset.busy === '1';
  const addBlocked = adminTitleBlocked(form, 'add_alias');
  const promoteBlocked = adminTitleBlocked(form, 'promote');
  if (add) {
    add.disabled = busy || (!frozen && !!addBlocked);
    if (addBlocked) add.setAttribute('title', addBlocked);
    else adminClearAttr(add, 'title');
    add.setAttribute('aria-pressed', form.dataset.intent === 'add_alias' ? 'true' : 'false');
  }
  if (promote) {
    promote.disabled = busy || (!frozen && !!promoteBlocked);
    if (promoteBlocked) promote.setAttribute('title', promoteBlocked);
    else adminClearAttr(promote, 'title');
    promote.setAttribute('aria-pressed', form.dataset.intent === 'promote' ? 'true' : 'false');
  }
  if (preview) {
    const armed = form.dataset.intent === 'add_alias' || form.dataset.intent === 'promote' ? adminTitlePreviewText(form, form.dataset.intent) : '';
    const both = !armed && !addBlocked && !promoteBlocked ? adminTitlePreviewText(form, 'add_alias') + ' ' + adminTitlePreviewText(form, 'promote') : '';
    const text = armed || both || adminTitlePreviewText(form, 'promote') || adminTitlePreviewText(form, 'add_alias');
    preview.hidden = !text;
    preview.textContent = text;
  }
  if (result && addBlocked && promoteBlocked && !busy && !frozen) result.textContent = promoteBlocked;
}

function adminClearAttr(node, name) {
  if (!node) return;
  if (typeof node.removeAttribute === 'function') node.removeAttribute(name);
  else if (node.attrs) delete node.attrs[name];
}

function adminControlName(target) {
  if (!target) return '';
  if (typeof target.getAttribute === 'function') {
    const named = target.getAttribute('name');
    if (typeof named === 'string' && named) return named;
  }
  return typeof target.name === 'string' ? target.name : '';
}

// Choosing another stored title arms «Сделать предпочтительным». Typing a new title arms
// «Добавить вариант», unless the owner already armed promote and is still editing that text.
function adminTitleApplyChoice(form, target) {
  if (!form || !target) return;
  const manual = form.querySelector('[data-title-manual]');
  if (adminControlName(target) === 'title-review-choice') {
    if (manual) manual.value = '';
    const current = form.dataset.current || '';
    const other = target.value !== current;
    form.dataset.intent = other ? 'promote' : '';
    if (other) form.dataset.intentAuto = '1';
    else delete form.dataset.intentAuto;
    return;
  }
  if (typeof target.getAttribute === 'function' && target.getAttribute('data-title-effect')) {
    form.dataset.intent = target.getAttribute('data-title-effect');
    delete form.dataset.intentAuto;
    return;
  }
  if (manual && target === manual) {
    const typed = manual.value.replace(/\s+/g, ' ').trim();
    if (!typed) return;
    for (const choice of form.querySelectorAll('input[name="title-review-choice"]')) choice.checked = false;
    if (form.dataset.intentAuto === '1' || form.dataset.intent !== 'promote') {
      form.dataset.intent = 'add_alias';
      delete form.dataset.intentAuto;
    }
  }
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
  // A command that omits effect is the historical promote. The armed button is that same effect.
  form.dataset.intent = kept.effect === 'add_alias' ? 'add_alias' : 'promote';
  delete form.dataset.busy;
  form.dataset.requestId = kept.requestId;
  const result = form.querySelector('[data-title-result]');
  if (result && form.dataset.busy !== '1') result.textContent = adminTitleRetryText(kept);
  adminTitleSync(form);
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

function adminUrlMatches(kind, ids) {
  if (typeof window === 'undefined' || !window.location) return true;
  let state;
  try { state = adminState(); } catch { return true; }
  if (!state || state.kind !== kind || !state.id) return false;
  return ids.indexOf(state.id) !== -1;
}

function adminViewMatchesRecord(view, kind, ids) {
  if (!view || view.mode !== 'ready') return false;
  if (view.kind && view.kind !== kind) return false;
  if (view.id && ids.indexOf(view.id) === -1) return false;
  const entity = view.entity;
  if (!entity) return true;
  if (entity.id && ids.indexOf(entity.id) === -1) return false;
  if (entity.storedId && ids.indexOf(entity.storedId) === -1) return false;
  return true;
}

// A readback that returns after the owner has opened another record must not paint this command
// onto that record. The command stays until its own card is on screen.
function adminTitleSurface(kept) {
  const pending = adminTitlePending;
  if (!pending || !kept || pending.command.requestId !== kept.requestId || pending.storedId !== (kept.storedId || pending.storedId)) return null;
  const detail = document.querySelector('#admin-detail');
  const form = detail && detail.querySelector('[data-title-review]');
  if (!form || form.dataset.storedId !== pending.storedId) return null;
  if (kept.filmId && form.dataset.filmId && form.dataset.filmId !== kept.filmId) return null;
  const ids = [pending.storedId, form.dataset.filmId, kept.filmId].filter(Boolean);
  if (!adminUrlMatches('film', ids)) return null;
  return form;
}

function adminFinishUnknownTitle(kept, view) {
  const form = adminTitleSurface(kept);
  if (!form) return;
  const ids = [form.dataset.storedId, form.dataset.filmId, kept.filmId].filter(Boolean);
  if (!adminViewMatchesRecord(view, 'film', ids)) return;
  const result = form.querySelector('[data-title-result]');
  if (adminTitleReviewLanded(kept, view)) {
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

function adminTitleEffectOf(event) {
  const submitter = event && event.submitter;
  if (!submitter || typeof submitter.getAttribute !== 'function') return '';
  return submitter.getAttribute('data-title-effect') || '';
}

function adminBindTitleReview(detail) {
  const form = detail && detail.querySelector ? detail.querySelector('[data-title-review]') : null;
  if (!form) return;
  const manual = form.querySelector('[data-title-manual]');
  const result = form.querySelector('[data-title-result]');
  const discardAttempt = () => { delete form.dataset.requestId; adminTitleDrop(); };
  const noteCleared = () => { if (result && form.dataset.busy !== '1') result.textContent = ''; };
  const follow = event => {
    discardAttempt();
    adminTitleApplyChoice(form, event.target);
    noteCleared();
    adminTitleSync(form);
  };
  form.addEventListener('change', follow);
  form.addEventListener('input', follow);
  form.addEventListener('focusin', event => {
    const effect = event.target && typeof event.target.getAttribute === 'function' ? event.target.getAttribute('data-title-effect') : '';
    if (!effect) return;
    const pending = adminTitleFrozen(form.dataset.storedId, form.dataset.requestId);
    if (pending) {
      form.dataset.intent = pending.effect === 'add_alias' ? 'add_alias' : 'promote';
      adminTitleSync(form);
      return;
    }
    form.dataset.intent = effect;
    delete form.dataset.intentAuto;
    adminTitleSync(form);
  });
  const kept = adminTitlePending && adminTitleFrozen(form.dataset.storedId, adminTitlePending.command.requestId);
  if (kept) adminRestoreTitleAttempt(form, kept);
  else adminTitleSync(form);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const storedId = form.dataset.storedId;
    const effect = adminTitleEffectOf(event);
    let body = adminTitleFrozen(storedId, form.dataset.requestId);
    if (!body) {
      const typed = manual.value.replace(/\s+/g, ' ').trim();
      const selected = form.querySelector('input[name="title-review-choice"]:checked');
      const value = typed || (selected ? selected.value : '');
      const chosen = effect || form.dataset.intent || (typed ? 'add_alias' : '');
      if (!value) { result.textContent = form.querySelector('input[name="title-review-choice"]') ? 'Выберите вариант или введите название.' : 'Введите название.'; if (typeof result.focus === 'function') result.focus(); return; }
      if (!chosen) { result.textContent = 'Выберите «Добавить вариант» или «Сделать предпочтительным».'; if (typeof result.focus === 'function') result.focus(); return; }
      const blocked = adminTitleBlocked(form, chosen);
      if (blocked) { result.textContent = blocked; if (typeof result.focus === 'function') result.focus(); return; }
      const button = form.querySelector(chosen === 'promote' ? '[data-title-promote]' : '[data-title-add]');
      if (button && button.disabled) return;
      if (!form.dataset.requestId) form.dataset.requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      body = {filmId: form.dataset.filmId, requestId: form.dataset.requestId, mode: typed ? 'manual' : 'alias', value, expectedVersion: form.dataset.version, effect: chosen};
      const basis = form.querySelector('[name="basis"]').value;
      if (basis.trim()) body.basis = basis;
      adminTitleHold(storedId, body);
      body = adminTitleFrozen(storedId, body.requestId);
    }
    form.dataset.requestId = body.requestId;
    form.dataset.busy = '1';
    adminTitleSync(form);
    result.textContent = 'Записываем…';
    const keptBody = JSON.parse(JSON.stringify(body));
    adminSaveFilmTitle(storedId, body).then(response => {
      form.dataset.busy = '0';
      if (response.ok) {
        const payload = response.body;
        const duplicate = payload && payload.reason === 'duplicate_alias';
        const unchanged = payload && payload.changed === false && !payload.idempotent;
        if (duplicate || unchanged) {
          adminTitleDrop();
          delete form.dataset.requestId;
          adminTitleSync(form);
          result.textContent = duplicate ? 'Такой вариант уже есть. Новой записи нет.' : 'Название уже такое. Новой записи нет.';
          if (typeof result.focus === 'function') result.focus();
          return;
        }
        result.textContent = 'Сверяю карточку.';
        if (typeof result.focus === 'function') result.focus();
        Promise.resolve(onAdminRefresh()).then(view => {
          if (!adminTitleFrozen(storedId, keptBody.requestId)) return;
          adminFinishUnknownTitle(keptBody, view);
        });
        return;
      }
      if (!adminTitleFrozen(storedId, body.requestId)) {
        adminTitleSync(form);
        result.textContent = 'Поле изменено. Эта карточка больше не повторяет прошлую отправку. Отправьте название ещё раз.';
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
        result.textContent = 'Неизвестно, записалось ли название. Сверяю карточку.';
        result.focus();
        Promise.resolve(onAdminRefresh()).then(view => {
          if (!adminTitleFrozen(storedId, keptBody.requestId)) return;
          adminFinishUnknownTitle(keptBody, view);
        });
        return;
      }
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
  const audit = (review.reviews || []).map(entry => {
    const when = adminMadridWhen(entry.at);
    return `<li>${when ? adminEscape(when) + ' · ' : ''}${adminEscape(entry.mode || '')} · ${adminEscape(entry.from?.value || '—')} → ${adminEscape(entry.to?.value || '')}${entry.linkedFrom ? ' · из ' + adminEscape(entry.linkedFrom) : ''}</li>`;
  }).join('');
  const preferred = review.preferred || {};
  const roleInputs = (review.collisions || []).map(item => `<label class="admin-name-option"><input type="checkbox" name="person-name-role" value="${adminEscape(item.id)}" data-version="${adminEscape(item.version || '')}"${item.linked ? ' checked disabled' : ''}> <span>${adminEscape(item.original || item.id)}</span> <small class="muted">${adminEscape(item.id)} · ${adminEscape(item.reason || '')}${item.linked ? ' · уже связано' : ''}</small></label>`).join('');
  const roleField = roleInputs ? `<fieldset><legend>Тот же человек в другой роли</legend><p class="muted">Связь записывается только кнопкой «Сделать предпочтительным».</p><div class="admin-name-options">${roleInputs}</div></fieldset>` : '';
  const roleBlockLive = (review.collisions || []).length > 4 ? `<details class="admin-name-more"><summary>Тот же человек в другой роли (${review.collisions.length})</summary>${roleField}</details>` : roleField;
  return `<form id="admin-name-form" class="admin-name-form" data-person-id="${adminEscape(record.id)}"><h3>Имя</h3><p class="admin-name-current">Сейчас: <b>${adminEscape(preferred.value || 'нет')}</b></p><p class="admin-name-current">Оригинал: <b>${adminEscape(review.original || record.original || 'нет')}</b></p><p class="muted">«Добавить вариант» не меняет предпочтительное имя. «Сделать предпочтительным» меняет его в фильмах и поиске.</p>${options ? `<fieldset><legend>Варианты</legend><div class="admin-name-options">${options}</div></fieldset>` : '<p class="muted">Нет варианта с подтверждённым русским происхождением. Введите имя.</p>'}<label>Вариант<input id="admin-name-manual" name="person-name-manual" type="text" maxlength="200" autocomplete="off" spellcheck="true"></label><p id="admin-name-preview" class="admin-name-preview" aria-live="polite" hidden></p><label>Пояснение, необязательно<textarea id="admin-name-basis" name="person-name-basis" maxlength="500" rows="2"></textarea></label>${roleBlockLive}<details class="admin-name-more"><summary>Остальные варианты и происхождение</summary>${folded ? `<ul>${folded}</ul>` : '<p class="muted">Других вариантов нет.</p>'}</details>${audit ? `<details class="admin-name-more"><summary>Журнал</summary><ul>${audit}</ul></details>` : ''}<p id="admin-name-status" class="admin-name-status" role="status" tabindex="-1"></p><div class="admin-name-actions"><button type="submit" data-name-add data-name-effect="add_alias" aria-pressed="false">Добавить вариант</button><button type="submit" data-name-promote data-name-effect="promote" aria-pressed="false">Сделать предпочтительным</button></div></form>`;
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

function adminNameCurrentText(record) {
  const value = record && record.nameReview && record.nameReview.preferred && record.nameReview.preferred.value;
  return value || 'нет';
}

function adminNameBlocked(form, record, effect) {
  const manualNode = form.querySelector('#admin-name-manual');
  const manual = manualNode ? manualNode.value.replace(/\s+/g, ' ').trim() : '';
  const selected = form.querySelector('input[name="person-name-alias"]:checked');
  const next = manual || (selected && selected.value) || '';
  if (!next) return 'Введите вариант или выберите его.';
  const current = adminNameCurrentText(record);
  if (effect === 'promote') return next === current ? 'Это уже предпочтительное имя.' : '';
  if (!manual && selected) return 'Этот вариант уже есть. «Добавить вариант» ничего не запишет.';
  if (manual === current) return 'Это уже предпочтительное имя. Новой записи нет.';
  return '';
}

function adminNamePreviewText(form, record, effect) {
  if (adminNameBlocked(form, record, effect)) return '';
  const next = adminNameChosen(form);
  const current = adminNameCurrentText(record);
  if (effect === 'promote') return 'Сейчас: ' + current + ' → Станет: ' + next + '. Новое имя появится в фильмах и поиске.';
  return 'Сейчас: ' + current + ' → Станет: ' + current + '. Добавится вариант «' + next + '». Предпочтительное имя не изменится.';
}

function adminNameSync(form, record) {
  if (!form) return;
  const box = form.querySelector('#admin-name-preferred');
  const add = form.querySelector('[data-name-add]');
  const promote = form.querySelector('[data-name-promote]');
  if (!add && !promote) {
    const prefer = !!(box && box.checked);
    for (const input of form.querySelectorAll('input[name="person-name-role"]')) input.disabled = !prefer;
    const preview = form.querySelector('#admin-name-preview');
    if (!preview) return;
    const next = adminNameChosen(form);
    const current = adminNameCurrentText(record);
    if (!prefer || !next) {
      preview.hidden = true;
      preview.textContent = '';
      return;
    }
    preview.hidden = false;
    preview.textContent = 'Сейчас: ' + current + ' → Станет: ' + next + '. Новое имя появится в фильмах и поиске.';
    return;
  }
  const addBlocked = adminNameBlocked(form, record, 'add_alias');
  const promoteBlocked = adminNameBlocked(form, record, 'promote');
  const frozen = !!(form.dataset.requestId && record && adminNameFrozen(record.id, form.dataset.requestId));
  if (add) {
    add.disabled = !frozen && !!addBlocked;
    if (addBlocked) add.setAttribute('title', addBlocked);
    else adminClearAttr(add, 'title');
    add.setAttribute('aria-pressed', form.dataset.intent === 'add_alias' ? 'true' : 'false');
  }
  if (promote) {
    promote.disabled = !frozen && !!promoteBlocked;
    if (promoteBlocked) promote.setAttribute('title', promoteBlocked);
    else adminClearAttr(promote, 'title');
    promote.setAttribute('aria-pressed', form.dataset.intent === 'promote' ? 'true' : 'false');
  }
  const preview = form.querySelector('#admin-name-preview');
  if (!preview) return;
  const armed = form.dataset.intent === 'add_alias' || form.dataset.intent === 'promote' ? adminNamePreviewText(form, record, form.dataset.intent) : '';
  const text = armed || adminNamePreviewText(form, record, 'promote') || adminNamePreviewText(form, record, 'add_alias');
  preview.hidden = !text;
  preview.textContent = text;
}

function adminNameSubmitEffect(event, form) {
  const submitter = event && event.submitter;
  const fromButton = submitter && typeof submitter.getAttribute === 'function' ? submitter.getAttribute('data-name-effect') : '';
  if (fromButton) return fromButton;
  if (form.dataset && form.dataset.intent) return form.dataset.intent;
  const box = form.querySelector('#admin-name-preferred');
  if (box) return box.checked ? 'promote' : 'add_alias';
  const manual = form.querySelector('#admin-name-manual');
  if (manual && manual.value.replace(/\s+/g, ' ').trim()) return 'add_alias';
  return '';
}

function adminNameCommand(form, record, requestId, effect) {
  const manual = form.querySelector('#admin-name-manual').value.replace(/\s+/g, ' ').trim();
  const selected = form.querySelector('input[name="person-name-alias"]:checked');
  const basis = form.querySelector('#admin-name-basis').value.trim();
  const box = form.querySelector('#admin-name-preferred');
  const buttons = form.querySelector('[data-name-add]');
  if (!manual && !selected) return {error: 'Введите вариант или выберите его.'};
  let explicit = !!box || !!buttons;
  let prefer;
  if (buttons) {
    if (effect !== 'promote' && effect !== 'add_alias') return {error: 'Выберите «Добавить вариант» или «Сделать предпочтительным».'};
    prefer = effect === 'promote';
  } else {
    prefer = explicit ? box.checked === true : effect === 'add_alias' ? false : true;
    if (!explicit && effect === 'add_alias') explicit = true;
  }
  const blocked = buttons ? adminNameBlocked(form, record, prefer ? 'promote' : 'add_alias') : '';
  if (blocked) return {error: blocked};
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
  // A command that omits effect is the historical promote. The armed button is that same effect.
  if (prefer) prefer.checked = kept.effect !== 'add_alias';
  form.dataset.intent = kept.effect === 'add_alias' ? 'add_alias' : 'promote';
  form.dataset.requestId = kept.requestId;
  const result = form.querySelector('#admin-name-status');
  if (result) result.textContent = adminNameRetryText(kept);
  adminNameSync(form, adminLive.entity);
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

function adminNameSurface(kept) {
  const detail = document.querySelector('#admin-detail');
  const form = detail && detail.querySelector('#admin-name-form');
  if (!form || !kept) return null;
  const personId = kept.personId || (adminNamePending && adminNamePending.command.requestId === kept.requestId ? adminNamePending.personId : '');
  if (form.dataset.personId) {
    if (!personId || form.dataset.personId !== personId) return null;
    if (!adminUrlMatches('person', [personId])) return null;
    return form;
  }
  return form;
}

function adminFinishUnknownName(kept, view) {
  const form = adminNameSurface(kept);
  if (!form) return;
  if (form.dataset.personId && !adminViewMatchesRecord(view, 'person', [form.dataset.personId])) return;
  const result = form.querySelector('#admin-name-status');
  if (adminNameReviewLanded(kept, view)) {
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

function onAdminNameFocus(event) {
  const target = event.target;
  if (!target || typeof target.getAttribute !== 'function') return;
  const effect = target.getAttribute('data-name-effect');
  if (!effect) return;
  const form = target.closest ? target.closest('#admin-name-form') : null;
  if (!form || !form.dataset) return;
  const personId = form.dataset.personId || (adminLive.entity && adminLive.entity.id);
  const pending = adminNameFrozen(personId, form.dataset.requestId);
  if (pending) {
    form.dataset.intent = pending.effect === 'add_alias' ? 'add_alias' : 'promote';
    adminNameSync(form, adminLive.entity);
    return;
  }
  form.dataset.intent = effect;
  adminNameSync(form, adminLive.entity);
}

function onAdminNameEdit(event) {
  const target = event.target;
  const form = target && target.id === 'admin-name-form' ? target : target && target.closest ? target.closest('#admin-name-form') : null;
  if (!form || !form.dataset) return;
  const effect = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-name-effect') : '';
  const named = target && (target.name || (typeof target.getAttribute === 'function' ? target.getAttribute('name') : ''));
  if (effect) form.dataset.intent = effect;
  else if (target && target.id === 'admin-name-manual' && form.dataset.intent !== 'promote') form.dataset.intent = 'add_alias';
  else if (named === 'person-name-alias') {
    const manual = form.querySelector('#admin-name-manual');
    if (manual) manual.value = '';
    form.dataset.intent = target.value !== adminNameCurrentText(adminLive.entity) ? 'promote' : '';
  }
  delete form.dataset.requestId;
  adminNameDrop();
  adminNameSync(form, adminLive.entity);
}

async function onAdminNameSubmit(event) {
  const form = event.target && event.target.id === 'admin-name-form' ? event.target : null;
  if (!form) return;
  event.preventDefault();
  const status = form.querySelector('#admin-name-status');
  const buttons = [...form.querySelectorAll('button[type="submit"]')];
  const button = buttons[0] || form.querySelector('button[type="submit"]');
  const entity = adminLive.entity;
  if (!entity || !entity.nameReview) return;
  const effect = adminNameSubmitEffect(event, form);
  let command = adminNameFrozen(entity.id, form.dataset.requestId);
  if (!command) {
    const requestId = form.dataset.requestId || adminNameRequestId();
    const built = adminNameCommand(form, entity, requestId, effect);
    if (built.error) {status.textContent = built.error; return;}
    command = built.command;
    adminNameHold(entity.id, command);
  }
  form.dataset.requestId = command.requestId;
  for (const item of buttons) item.disabled = true;
  if (button && !buttons.length) button.disabled = true;
  status.textContent = 'Сохраняем…';
  const kept = JSON.parse(JSON.stringify(command));
  const result = await adminPost('/people/'+encodeURIComponent(command.personId)+'/name-review', command);
  for (const item of buttons) item.disabled = false;
  if (button && !buttons.length) button.disabled = false;
  if (result.ok) {
    const duplicate = result.body && result.body.reason === 'duplicate_alias';
    const unchanged = result.body && result.body.changed === false && !result.body.idempotent;
    if (duplicate || unchanged) {
      adminNameDrop();
      delete form.dataset.requestId;
      status.textContent = duplicate ? 'Такой вариант уже есть. Новой записи нет.' : 'Имя уже такое. Новой записи нет.';
      if (typeof status.focus === 'function') status.focus();
      return;
    }
    status.textContent = 'Сверяю карточку.';
    adminLive.pin = null;
    const view = await onAdminRefresh();
    if (!adminNameFrozen(entity.id, kept.requestId)) return;
    adminFinishUnknownName(kept, view);
    return;
  }
  const stillPending = adminNameFrozen(entity.id, command.requestId);
  if (!stillPending) {
    status.textContent = 'Поле изменено. Эта карточка больше не повторяет прошлую отправку. Отправьте имя ещё раз.';
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
    status.textContent = adminNameCommitUnknown(result) ? adminNameRetryText(command) : adminErrorText(result.error);
    if (typeof status.focus === 'function') status.focus();
  }
}

function adminRenderQueues(state) {
  const queues = document.querySelector('#admin-queues');
  if (!queues) return;
  const summary = document.querySelector('#admin-queues-summary');
  const panel = document.querySelector('#admin-queues-panel');
  const items = Array.isArray(adminLive.queues) ? adminLive.queues : [];
  if (adminLive.queues == null) {
    queues.innerHTML = '';
    if (summary) summary.textContent = 'Очереди качества';
  } else {
    const shown = items.filter(item => item && (item.count > 0 || state.queue === item.code));
    const group = (kind, title) => {
      const rows = shown.filter(item => (item.kind === 'person' ? 'person' : 'film') === kind);
      if (!rows.length) return '';
      const buttons = rows.map(item => {
        const pressed = state.queue === item.code;
        return `<button type="button" class="admin-queue" data-admin-queue="${adminEscape(item.code)}" data-admin-kind="${adminEscape(item.kind)}" aria-pressed="${pressed ? 'true' : 'false'}"><span>${adminEscape(ADMIN_LABELS[item.code] || item.code)}</span><small>${item.kind === 'person' ? 'люди' : 'фильмы'} · ${item.count}</small></button>`;
      }).join('');
      return `<div class="admin-queue-group"><h3>${title}</h3><div class="admin-queue-buttons">${buttons}</div></div>`;
    };
    const html = group('film', 'Фильмы') + group('person', 'Люди');
    queues.innerHTML = html || '<p class="muted admin-queues-empty">Нет записей в очередях.</p>';
    const active = items.filter(item => item && item.count > 0).length;
    if (summary) summary.textContent = active ? 'Очереди качества · ' + active : 'Очереди качества';
    if (panel && state.queue) panel.open = true;
  }
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
  adminLive.resultsReady = showResults;
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

const ADMIN_CHROME = {
  catalog: {
    title: 'Данные каталога',
    description: 'Страница владельца: поиск фильмов и людей и очереди качества по опубликованной программе. Название одного фильма и русское имя человека записываются только после подтверждения.',
  },
  health: {
    title: 'Здоровье данных',
    description: 'Страница владельца: ограниченное чтение опубликованного снимка: что требует внимания и какие источники эта страница не читает. Чтение ничего не меняет.',
  },
};

function adminApplyChrome(view) {
  const health = view === 'health';
  const root = document.documentElement;
  if (root && root.classList) {
    root.classList.toggle('admin-is-health', health);
    root.classList.toggle('admin-is-catalog', !health);
  }
  const chrome = ADMIN_CHROME[health ? 'health' : 'catalog'];
  document.title = chrome.title;
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', chrome.description);
  const section = document.querySelector('#admin-health');
  if (section) section.setAttribute('aria-labelledby', health ? 'admin-health-page-title' : 'admin-health-title');
}

function adminShowView(view) {
  adminApplyChrome(view);
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
    if (result.body.snapshot) {
      adminLive.snapshot = result.body.snapshot;
      const line = document.querySelector('#admin-snapshot-text');
      if (line) line.textContent = adminSnapshotText(result.body.snapshot);
      const banner = document.querySelector('#admin-snapshot');
      if (banner) banner.setAttribute('data-admin-skew', result.body.snapshot.skew ? 'true' : 'false');
    }
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
  if (!state.id) adminDismissDetail();
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

// The right-hand card is the record in the URL. Leaving that record hides it at once. An unknown
// owner-review command stays on its film or person and is not posted again from here.
function adminDismissDetail() {
  const detail = document.querySelector('#admin-detail');
  const host = adminDetailHost();
  if (host) host.innerHTML = '';
  if (detail) detail.hidden = true;
  adminLive.entity = null;
  adminPlaceCatalog();
}

function adminCancelCatalogueRead() {
  adminLive.seq += 1;
  if (adminLive.controller) {
    adminLive.controller.abort();
    adminLive.controller = null;
  }
}

function adminPlaceCatalog() {
  const detail = document.querySelector('#admin-detail');
  const results = document.querySelector('#admin-results-section');
  const back = document.querySelector('#admin-detail-back');
  const layout = document.querySelector('#admin-catalog-layout');
  if (!detail) return;
  let narrow = false;
  const mediaHost = typeof window === 'undefined' ? null : window;
  if (mediaHost && mediaHost.matchMedia) {
    const media = mediaHost.matchMedia('(max-width: 800px)');
    narrow = !!(media && media.matches);
  }
  const state = adminLive.state || {id: ''};
  const focus = !!(narrow && !detail.hidden && state.id);
  if (back) back.hidden = !focus;
  if (layout && layout.classList) layout.classList.toggle('admin-catalog-focus', focus);
  if (results) results.hidden = focus ? true : !adminLive.resultsReady;
}

function onAdminDetailBack() {
  const state = adminState();
  state.id = '';
  adminWrite(state, 'push');
  return adminRender().then(view => {
    const search = document.querySelector('#admin-search');
    if (search && typeof search.focus === 'function') search.focus();
    return view;
  });
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
  const field = document.querySelector('#admin-search');
  const state = adminState();
  const next = field ? field.value : state.q;
  if (next === state.q) {
    adminWrite(state, 'replace');
    adminSchedule();
    return;
  }
  state.q = next;
  state.id = '';
  adminLive.state = state;
  adminWrite(state, 'replace');
  adminDismissDetail();
  adminCancelCatalogueRead();
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
  state.id = '';
  adminLive.state = state;
  adminWrite(state, 'push');
  adminDismissDetail();
  return adminRender();
}

function onAdminKey(event) {
  if (event.key !== 'Escape') return;
  if (event.target && event.target.closest && (event.target.closest('#admin-name-form') || event.target.closest('[data-title-review]'))) return;
  const state = adminState();
  if (state.view === 'health' || !state.q) return;
  event.preventDefault();
  state.q = '';
  state.id = '';
  adminLive.state = state;
  adminWrite(state, 'replace');
  const search = document.querySelector('#admin-search');
  search.value = '';
  adminDismissDetail();
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
  document.querySelector('#admin-detail').addEventListener('focusin', onAdminNameFocus);
  document.querySelector('#admin-queues').addEventListener('click', onAdminQueue);
  const catalogBack = document.querySelector('#admin-detail-back');
  if (catalogBack) catalogBack.addEventListener('click', onAdminDetailBack);
  document.querySelector('#admin-refresh').addEventListener('click', onAdminRefresh);
  document.querySelector('.admin-views').addEventListener('click', onAdminView);
  document.querySelector('#admin-health-refresh').addEventListener('click', onAdminHealthRefresh);
  document.querySelector('#admin-health-stale-refresh').addEventListener('click', onAdminHealthRefresh);
  document.querySelector('#admin-health-issues').addEventListener('click', onAdminHealthLink);
  document.querySelector('#admin-health-detail').addEventListener('click', onAdminHealthLink);
  document.querySelector('#admin-health').addEventListener('click', onAdminHealthSelect);
  document.querySelector('#admin-health').addEventListener('keydown', onAdminHealthOptionKey);
  if (window.matchMedia) {
    const healthMedia = window.matchMedia('(max-width: 800px)');
    const placeHealth = () => healthPlaceDetail(healthMedia.matches);
    if (healthMedia.addEventListener) healthMedia.addEventListener('change', placeHealth);
    placeHealth();
    const placeCatalog = () => adminPlaceCatalog();
    if (healthMedia.addEventListener) healthMedia.addEventListener('change', placeCatalog);
  }
  window.addEventListener('keydown', onAdminKey);
  window.addEventListener('popstate', onAdminHistory);
  adminWrite(adminState(), 'replace');
  adminRender();
}

startAdmin();
