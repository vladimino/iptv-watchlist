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
  unavailable: 'Демонстрационные данные сейчас недоступны. Это локальная отметка, запрос никуда не уходил.',
  invalid_limit: 'Некорректный размер страницы. Демонстрация принимает только явное значение от 1 до 25.',
  invalid_query: 'Пустой запрос не показывает весь каталог.',
  unknown_queue: 'Такой очереди нет в демонстрационных данных.',
  stale_cursor: 'Страница демонстрации устарела. Откройте очередь заново.',
  invalid_records: 'Демонстрационные записи повреждены.',
};

function adminEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function adminState() {
  const url = new URL(window.location.href);
  return {
    q: url.searchParams.get('q') ?? '',
    queue: url.searchParams.get('queue') ?? '',
    kind: url.searchParams.get('kind') === 'person' ? 'person' : 'film',
    id: url.searchParams.get('id') ?? '',
    error: url.searchParams.get('error') ?? '',
    loading: url.searchParams.get('loading') === '1',
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
  if (state.error) params.set('error', state.error);
  if (state.loading) params.set('loading', '1');
  const query = params.toString();
  return query ? '/admin?' + query : '/admin';
}

function adminWrite(state, mode) {
  const href = adminUrl(state);
  if (mode === 'push') history.pushState(state, '', href);
  else history.replaceState(state, '', href);
}

function adminStatus(name, value) {
  const text = STATUS_TEXT[value] || value || 'нет данных';
  const tone = value === 'reviewed' ? 'reviewed' : value === 'provisional' ? 'provisional' : value === 'ambiguous' ? 'ambiguous' : value === 'missing' || !value ? 'missing' : 'plain';
  return `<span class="admin-status admin-status-${tone}">${adminEscape(name)}: ${adminEscape(text)}</span>`;
}

function adminProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return '';
  const parts = Object.entries(provenance).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${value}`);
  return parts.length ? `<span class="admin-provenance">${adminEscape(parts.join(' · '))}</span>` : '';
}

function adminHit(item, kind, state) {
  const title = item.preferred || item.originalTitle || item.original || item.epgTitle || item.id;
  const next = adminUrl({...state, kind, id: item.id, error: '', loading: false});
  const badges = [
    adminStatus(kind === 'person' ? 'имя' : 'название', item.localization?.status),
    adminStatus('идентичность', item.identity?.status),
  ];
  if ((item.localizationConflicts || []).length) badges.push('<span class="admin-status admin-status-conflict">конфликт локализации</span>');
  if ((item.externalIds || []).some(entry => entry?.conflicting)) badges.push('<span class="admin-status admin-status-conflict">конфликт внешнего id</span>');
  const collision = item.collision ? '<span class="admin-collision">Одинаковое название в этой выдаче. Записи не объединяются, canonical identity не меняется.</span>' : '';
  const current = state.kind === kind && state.id === item.id ? ' aria-current="true"' : '';
  return `<a class="admin-hit" href="${adminEscape(next)}" data-admin-kind="${adminEscape(kind)}" data-admin-id="${adminEscape(item.id)}"${current}><span class="admin-hit-title">${adminEscape(title)}</span><span class="admin-hit-meta">${adminEscape(item.id)}${item.canonicalIdentity ? ' · ' + adminEscape(item.canonicalIdentity) : ''}</span>${collision}<span class="admin-badges">${badges.join('')}</span></a>`;
}

function adminFacts(record, kind) {
  const rows = [
    ['id', record.id],
    [kind === 'person' ? 'роль' : 'хранение', kind === 'person' ? record.roleId : record.storedId],
    ['предпочтительное', record.preferred],
    ['оригинал', kind === 'person' ? record.original : record.originalTitle],
    ['название в программе', record.epgTitle],
    ['canonical identity', record.canonicalIdentity],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => `<div><dt>${adminEscape(name)}</dt><dd>${adminEscape(value)}</dd></div>`).join('');
}

function adminAliases(record) {
  const aliases = record.aliases || [];
  if (!aliases.length) return '<p class="muted">Алиасов нет.</p>';
  return `<ul>${aliases.map(alias => `<li>${adminEscape(alias.value ?? alias)}${alias.kind ? ' · ' + adminEscape(alias.kind) : ''} ${adminProvenance(alias.provenance)}</li>`).join('')}</ul>`;
}

function adminExternalIds(record) {
  const ids = record.externalIds || [];
  if (!ids.length) return '<p class="muted">Внешних id нет.</p>';
  return `<ul>${ids.map(entry => `<li>${adminEscape(entry.scheme || 'id')} ${adminEscape(entry.value)} · ${entry.trusted ? 'доверенный' : 'не доверенный'}${entry.conflicting ? ' · конфликт' : ''} ${adminProvenance(entry.provenance)}</li>`).join('')}</ul>`;
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
    detail.innerHTML = '<h2 id="admin-detail-title" tabindex="-1">Запись не найдена</h2><p>В демонстрационных данных нет записи с этим id.</p>';
    return;
  }
  const record = view.entity;
  const kind = view.kind === 'person' ? 'person' : 'film';
  const title = record.preferred || record.original || record.originalTitle || record.id;
  const conflicts = (record.localizationConflicts || []).map(conflict => `<li>${adminEscape(conflict.value || '')}${conflict.reason ? ' · ' + adminEscape(conflict.reason) : ''}</li>`).join('');
  detail.innerHTML = `<p class="eyebrow">${kind === 'person' ? 'ЧЕЛОВЕК' : 'ФИЛЬМ'}</p><h2 id="admin-detail-title" tabindex="-1">${adminEscape(title)}</h2><div class="admin-badges">${adminStatus('локализация', record.localization?.status)}${adminStatus('идентичность', record.identity?.status)}${(record.externalIds || []).some(entry => entry?.conflicting) ? '<span class="admin-status admin-status-conflict">конфликт внешнего id</span>' : ''}</div><p class="admin-provenance">Происхождение локализации: ${adminProvenance(record.localization?.provenance) || 'не указано'}. Происхождение идентичности: ${adminProvenance(record.identity?.provenance) || 'не указано'}.</p><h3>Сводка</h3><dl>${adminFacts(record, kind)}</dl><h3>Алиасы и происхождение</h3>${adminAliases(record)}<h3>Внешние id</h3>${adminExternalIds(record)}<h3>Конфликты локализации</h3>${conflicts ? `<ul>${conflicts}</ul>` : '<p class="muted">Конфликтов локализации нет. Неоднозначная идентичность и конфликт внешнего id показаны отдельно.</p>'}<h3>Другие статусы</h3><div class="admin-badges">${kind === 'film' ? adminStatus('метаданные', record.metadata?.status) + adminStatus('отпечаток', record.fingerprint?.status) + adminStatus('прогноз', record.prediction?.status) : ''}</div>`;
}

function adminRender() {
  const state = adminState();
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.queue) params.set('queue', state.queue);
  if (state.id) {
    params.set('kind', state.kind);
    params.set('id', state.id);
  }
  if (state.error) params.set('error', state.error);
  if (state.loading) params.set('loading', '1');
  const view = loadAdmin(params);
  document.querySelector('#admin-demo').setAttribute('data-admin-limit', String(view.limit));
  const search = document.querySelector('#admin-search');
  if (search.value !== state.q) search.value = state.q;
  const loading = document.querySelector('#admin-loading');
  const error = document.querySelector('#admin-error');
  const empty = document.querySelector('#admin-empty');
  const results = document.querySelector('#admin-results');
  const queues = document.querySelector('#admin-queues');
  loading.hidden = view.mode !== 'loading';
  error.hidden = view.mode !== 'error';
  error.textContent = view.mode === 'error' ? (ERROR_TEXT[view.error] || view.error) : '';
  const showResults = view.mode === 'ready';
  queues.innerHTML = (view.queues || []).map(item => {
    const pressed = state.queue === item.code;
    return `<button type="button" class="admin-queue" data-admin-queue="${adminEscape(item.code)}" data-admin-kind="${adminEscape(item.kind)}" aria-pressed="${pressed ? 'true' : 'false'}"><span>${adminEscape(ADMIN_LABELS[item.code] || item.code)}</span><small>${item.kind === 'person' ? 'люди' : 'фильмы'} · ${item.count}</small></button>`;
  }).join('');
  const resultsSection = results.closest ? results.closest('section') : null;
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
  const filmHtml = view.filmResults.map(item => adminHit(item, 'film', state)).join('');
  const personHtml = view.personResults.map(item => adminHit(item, 'person', state)).join('');
  empty.hidden = !hasQuery || Boolean(filmHtml || personHtml);
  results.innerHTML = `${filmHtml ? `<section class="admin-group"><h3>Фильмы</h3>${filmHtml}</section>` : ''}${personHtml ? `<section class="admin-group"><h3>Люди</h3>${personHtml}</section>` : ''}`;
  adminDetail(view);
}

function onAdminSearch() {
  const state = adminState();
  state.q = document.querySelector('#admin-search').value;
  adminWrite(state, 'replace');
  adminRender();
}

function onAdminResult(event) {
  const link = event.target.closest ? event.target.closest('[data-admin-id]') : null;
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault();
  const state = adminState();
  state.kind = link.getAttribute('data-admin-kind');
  state.id = link.getAttribute('data-admin-id');
  state.error = '';
  state.loading = false;
  adminWrite(state, 'push');
  adminRender();
  const title = document.querySelector('#admin-detail-title');
  if (title) title.focus();
}

function onAdminQueue(event) {
  const button = event.target.closest ? event.target.closest('[data-admin-queue]') : null;
  if (!button) return;
  const state = adminState();
  const code = button.getAttribute('data-admin-queue');
  state.queue = state.queue === code ? '' : code;
  state.error = '';
  state.loading = false;
  adminWrite(state, 'push');
  adminRender();
}

function onAdminKey(event) {
  if (event.key !== 'Escape') return;
  const state = adminState();
  if (!state.q) return;
  event.preventDefault();
  state.q = '';
  adminWrite(state, 'replace');
  const search = document.querySelector('#admin-search');
  search.value = '';
  adminRender();
  search.focus();
}

function onAdminHistory() {
  adminRender();
}

function startAdmin() {
  document.querySelector('#admin-search').form.addEventListener('submit', event => event.preventDefault());
  document.querySelector('#admin-search').addEventListener('input', onAdminSearch);
  document.querySelector('#admin-results').addEventListener('click', onAdminResult);
  document.querySelector('#admin-queues').addEventListener('click', onAdminQueue);
  window.addEventListener('keydown', onAdminKey);
  window.addEventListener('popstate', onAdminHistory);
  adminWrite(adminState(), 'replace');
  adminRender();
}

startAdmin();
