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
  method_not_allowed: 'Страница делает только GET-запросы.',
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

function adminProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return '';
  const parts = Object.entries(provenance).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  return parts.length ? `<span class="admin-provenance">${adminEscape(parts.join(' · '))}</span>` : '';
}

function adminSource(dimension) {
  const parts = [dimension?.source ? adminEscape(dimension.source) : '', adminProvenance(dimension?.provenance)].filter(Boolean);
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
  const meta = [item.id, item.year ? String(item.year) : null, item.canonicalIdentity].filter(Boolean).join(' · ');
  return `<a class="admin-hit" href="${adminEscape(next)}" data-admin-kind="${adminEscape(kind)}" data-admin-id="${adminEscape(item.id)}"${current}><span class="admin-hit-title">${adminEscape(title)}</span><span class="admin-hit-meta">${adminEscape(meta)}</span>${collision}<span class="admin-badges">${badges.join('')}</span></a>`;
}

function adminGroup(kind, items, next, state) {
  if (!items.length) return '';
  const heading = kind === 'person' ? 'Люди' : 'Фильмы';
  const more = next ? `<button type="button" class="admin-more" data-admin-more="${kind}">Показать ещё</button>` : '';
  return `<section class="admin-group" data-admin-group="${kind}"><h3>${heading} <small>${items.length}${next ? '+' : ''}</small></h3><div class="admin-group-items">${items.map(item => adminHit(item, kind, state)).join('')}</div>${more}</section>`;
}

function adminFacts(record, kind) {
  const rows = [
    ['id', record.id],
    [kind === 'person' ? 'роль' : 'хранение', kind === 'person' ? record.roleId : record.storedId],
    ['предпочтительное', record.preferred],
    ['оригинал', kind === 'person' ? record.original : record.originalTitle],
    ['название в программе', record.epgTitle],
    ['год', record.year],
    ['canonical identity', record.canonicalIdentity],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => `<div><dt>${adminEscape(name)}</dt><dd>${adminEscape(value)}</dd></div>`).join('');
}

function adminAliases(record) {
  const aliases = record.aliases || [];
  if (!aliases.length) return '<p class="muted">Других названий нет.</p>';
  const items = aliases.map(alias => `<li>${adminEscape(alias.value ?? alias)}${alias.kind ? ' · ' + adminEscape(alias.kind) : ''} ${adminProvenance(alias.provenance)}</li>`).join('');
  return `<details class="other-titles"><summary>Другие названия (${aliases.length})</summary><ul>${items}</ul></details>`;
}

function adminExternalIds(record) {
  const ids = record.externalIds || [];
  if (!ids.length) return '<p class="muted">Внешних id нет.</p>';
  return `<ul>${ids.map(entry => `<li>${adminEscape(entry.scheme || 'id')} ${adminEscape(entry.value)}${entry.trusted === true ? ' · доверенный' : entry.trusted === false ? ' · не доверенный' : ''}${entry.conflicting ? ' · конфликт' : ''} ${adminProvenance(entry.provenance)}</li>`).join('')}</ul>`;
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
  const form = kind === 'film' ? adminTitleForm(record) : '';
  detail.innerHTML = `<p class="eyebrow">${kind === 'person' ? 'ЧЕЛОВЕК' : 'ФИЛЬМ'}</p><h2 id="admin-detail-title" tabindex="-1">${adminEscape(title)}</h2>${originalLine}<div class="admin-badges">${adminStatus('локализация', record.localization?.status)}${adminStatus('идентичность', record.identity?.status)}${(record.externalIds || []).some(entry => entry?.conflicting) ? '<span class="admin-status admin-status-conflict">конфликт внешнего id</span>' : ''}</div><p class="admin-provenance">Происхождение локализации: ${adminSource(record.localization)}. Происхождение идентичности: ${adminSource(record.identity)}.</p>${form}<h3>Сводка</h3><dl>${adminFacts(record, kind)}</dl>${adminAliases(record)}<h3>Внешние id</h3>${adminExternalIds(record)}<h3>Конфликты локализации</h3>${conflicts ? `<ul>${conflicts}</ul>` : '<p class="muted">Конфликтов локализации нет. Неоднозначная идентичность и конфликт внешнего id показаны отдельно.</p>'}${kind === 'film' ? `<h3>Другие статусы</h3><div class="admin-badges">${other}</div><p class="muted admin-outside-note">Отпечаток и прогноз хранятся вне опубликованной программы и этим чтением не читаются.</p>` : ''}`;
  adminBindTitleReview(detail);
}

// A script that happens to be Cyrillic is not a Russian title. Only a dictionary alias or an
// earlier owner title is marked well enough to offer. Programme, Letterboxd and EPG aliases stay
// in the collapsed list and in the API, and they are not radio choices.
function adminRussianChoices(review) {
  const preferred = review && review.preferred && review.preferred.value;
  const out = [];
  const seen = new Set();
  for (const option of (review && review.options) || []) {
    if (!option || !option.value || option.value === preferred || seen.has(option.value)) continue;
    const source = option.provenance && (option.provenance.authority === 'owner' ? 'owner' : option.provenance.source);
    if (source !== 'dictionary' && source !== 'owner') continue;
    seen.add(option.value);
    out.push(option);
    if (out.length >= 5) break;
  }
  return out;
}

function adminTitleForm(record) {
  const review = record.titleReview;
  if (!review || !review.version || !record.storedId) return '';
  const choices = adminRussianChoices(review);
  const options = choices.map(option => `<label class="title-review-option"><input type="radio" name="title-review-choice" value="${adminEscape(option.value)}"> <span>${adminEscape(option.value)}</span></label>`).join('');
  const picker = options ? `<fieldset><legend>Известные русские варианты</legend><div class="title-review-options">${options}</div></fieldset>` : '';
  const history = (review.reviews || []).map(entry => `<li>${adminEscape(entry.to && entry.to.value || '')}${entry.at ? ' · ' + adminEscape(entry.at) : ''}${entry.basis ? ' · ' + adminEscape(entry.basis) : ''}</li>`).join('');
  return `<section class="title-review" aria-labelledby="title-review-title"><h3 id="title-review-title">Русское название</h3><form data-title-review data-film-id="${adminEscape(review.filmId || '')}" data-stored-id="${adminEscape(record.storedId)}" data-version="${adminEscape(review.version)}">${picker}<label>Название <input type="text" name="manual" maxlength="200" autocomplete="off" data-title-manual></label><label>Основание, необязательно <textarea name="basis" maxlength="500" rows="2"></textarea></label><label class="title-review-accept"><input type="checkbox" data-title-accept> Записать это название в каталог. Это одно изменение одного фильма.</label><button type="submit" data-title-save disabled>Записать название</button><p class="title-review-result" data-title-result role="status" tabindex="-1"></p></form><h3>История правок</h3>${history ? `<ul>${history}</ul>` : '<p class="muted">Записей ещё нет.</p>'}</section>`;
}

function adminRestoreTitleAttempt(form, kept) {
  if (!form || !kept || !kept.requestId) return;
  const manual = form.querySelector('[data-title-manual]');
  const basis = form.querySelector('[name="basis"]');
  if (manual) manual.value = kept.mode === 'manual' ? kept.value : '';
  if (basis) basis.value = kept.basis || '';
  if (kept.mode === 'alias') {
    for (const choice of form.querySelectorAll('input[name="title-review-choice"]')) choice.checked = choice.value === kept.value;
  }
  const accept = form.querySelector('[data-title-accept]');
  if (accept) accept.checked = false;
  const save = form.querySelector('[data-title-save]');
  if (save) save.disabled = true;
  delete form.dataset.busy;
  form.dataset.requestId = kept.requestId;
}

// A 503 readback_failed can follow a put that already landed. The reread decides the sentence.
// Until the card shows the submitted title, the same requestId and payload stay for one replay.
function adminFinishUnknownTitle(kept, view) {
  const detail = document.querySelector('#admin-detail');
  const form = detail && detail.querySelector('[data-title-review]');
  const preferred = view && view.entity && (view.entity.preferred || (view.entity.titleReview && view.entity.titleReview.preferred && view.entity.titleReview.preferred.value));
  const landed = preferred != null && preferred === kept.value;
  if (form && landed) {
    const result = form.querySelector('[data-title-result]');
    if (result) {
      result.textContent = 'Название записано. Карточка сверена.';
      result.focus();
    }
    return;
  }
  if (form) adminRestoreTitleAttempt(form, kept);
  const result = form && form.querySelector('[data-title-result]');
  if (result) {
    result.textContent = 'Неизвестно, записалось ли название. Повторите отправку: это будет та же запись, без второй правки.';
    result.focus();
  }
}

function adminBindTitleReview(detail) {
  const form = detail.querySelector('[data-title-review]');
  if (!form) return;
  const accept = form.querySelector('[data-title-accept]');
  const save = form.querySelector('[data-title-save]');
  const manual = form.querySelector('[data-title-manual]');
  const result = form.querySelector('[data-title-result]');
  const sync = () => { save.disabled = !accept.checked || form.dataset.busy === '1'; };
  const clearRequest = () => { delete form.dataset.requestId; };
  form.addEventListener('change', event => { if (event.target !== accept) clearRequest(); sync(); });
  form.addEventListener('input', () => { clearRequest(); });
  accept.addEventListener('change', sync);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled) return;
    const typed = manual.value.trim();
    const selected = form.querySelector('input[name="title-review-choice"]:checked');
    const value = typed || (selected ? selected.value : '');
    if (!value) { result.textContent = form.querySelector('input[name="title-review-choice"]') ? 'Выберите вариант или введите название.' : 'Введите название.'; return; }
    if (!form.dataset.requestId) form.dataset.requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
    const body = {filmId: form.dataset.filmId, requestId: form.dataset.requestId, mode: typed ? 'manual' : 'alias', value, expectedVersion: form.dataset.version};
    const basis = form.querySelector('[name="basis"]').value;
    if (basis.trim()) body.basis = basis;
    form.dataset.busy = '1';
    sync();
    result.textContent = 'Записываем…';
    adminSaveFilmTitle(form.dataset.storedId, body).then(response => {
      form.dataset.busy = '0';
      if (response.error === 'network') {
        sync();
        result.textContent = 'Нет ответа от сервера. Можно повторить: это будет та же запись, без второй правки.';
        result.focus();
        return;
      }
      if (response.status === 503 && response.error === 'readback_failed') {
        sync();
        const kept = {requestId: form.dataset.requestId, value, mode: body.mode, basis: body.basis || ''};
        result.textContent = 'Неизвестно, записалось ли название. Сверяю карточку.';
        result.focus();
        Promise.resolve(onAdminRefresh()).then(view => adminFinishUnknownTitle(kept, view));
        return;
      }
      accept.checked = false;
      sync();
      const payload = response.body;
      if (response.ok) {
        result.textContent = payload && payload.changed === false ? 'Название уже такое. Новой записи нет.' : 'Название записано. Обновляю карточку.';
        result.focus();
        onAdminRefresh();
        return;
      }
      clearRequest();
      const reason = response.error;
      result.textContent = reason === 'version_conflict' ? 'Карточка уже изменилась. Обновите страницу и повторите.' : reason === 'request_id_reused' ? 'Этот запрос уже записан с другим текстом. Отправьте название ещё раз.' : 'Записать не удалось' + (reason ? ': ' + reason : '') + '. Название не изменено.';
      result.focus();
    });
  });
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
