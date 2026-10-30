const LIMBO_CAUSE_LABELS = {
  retry_eligible: 'Можно повторить',
  stalled: 'Застряло',
  backoff: 'Ждёт по backoff',
  pending: 'В работе, ждёт очереди',
  manual_review: 'Нужен ручной разбор',
  stale_projection: 'Устаревшая проекция',
  external_archive: 'Нужен внешний архив',
  unknown: 'Неизвестно',
};
const LIMBO_CAUSE_HINTS = {
  retry_eligible: 'повтор просрочен или наступил; система его пока не взяла',
  stalled: 'повтор не запланирован, прогресса нет дольше порога',
  backoff: 'повтор назначен и ещё не наступил; это нормальное ожидание',
  pending: 'запись в очереди или недавно двигалась',
  manual_review: 'конфликт или терминальное решение; автоматика не поможет',
  stale_projection: 'данные относятся к другому опубликованному поколению',
  external_archive: 'нужны данные извне (архив Letterboxd)',
  unknown: 'данных недостаточно, чтобы судить; это не значит «всё хорошо»',
};
const LIMBO_SUBSYSTEM_LABELS = {
  identity: 'Идентичность',
  metadata: 'Метаданные',
  localization: 'Локализация',
  fingerprint: 'Отпечаток',
  prediction: 'Прогноз',
  programme: 'Программа',
  prediction_queue: 'Очередь прогнозов',
  discovery: 'Discovery',
  poster: 'Постеры',
  letterboxd_archive: 'Архив Letterboxd',
};
const LIMBO_REASON_TEXT = {
  retry_waiting: 'повтор назначен и ещё не наступил',
  retry_due: 'время повтора наступило',
  retry_overdue: 'повтор просрочен дольше допустимого',
  backoff_beyond_policy: 'повтор назначен дальше, чем разрешает политика',
  no_progress: 'нет прогресса дольше порога',
  terminal_without_resolution: 'терминальное решение без результата',
  progress_unknown: 'время последнего прогресса неизвестно',
  work_pending: 'работа ожидается, прогресс недавний',
  work_queued: 'стоит в очереди прогнозов',
  repeated_failures: 'много повторных неудач, ждёт следующего повтора',
  metadata_stale: 'метаданные устарели',
  metadata_partial: 'метаданные неполные',
  metadata_missing: 'метаданных нет',
  identity_conflict: 'конфликт внешних идентификаторов',
  identity_ambiguous: 'идентичность неоднозначна',
  localization_conflict: 'удержанный конфликт локализации',
  queue_disagreement: 'прогноз не актуален, а очередь его не содержит',
  projection_generation_differs: 'проекция другого опубликованного поколения',
  generation_stale: 'опубликованное поколение устарело',
  generation_not_published: 'поколение не опубликовано',
  eligible_work_without_runs: 'есть готовая работа, но запусков не было',
  all_deferred_by_retry: 'вся работа отложена повторами',
  evidence_object_missing: 'объект не найден в хранилище',
  evidence_not_supplied: 'этим чтением не читается',
};
const LIMBO_ACTION_TEXT = {wait: 'ждать', investigate: 'разобраться', bounded_action: 'ограниченное действие'};
const LIMBO_ACTION_CODE_TEXT = {
  reread_snapshot: 'перечитать снимок',
  check_scheduled_tasks: 'проверить Scheduled Tasks',
  manual_review: 'ручной разбор',
  discovery_retry: 'повтор discovery',
  metadata_refresh: 'обновление метаданных',
  prediction_retry: 'повтор прогноза',
  poster_hydration: 'загрузка постера',
  archive_import: 'импорт архива',
  supply_evidence: 'нужны данные',
};
const LIMBO_ELIGIBILITY_TEXT = {
  eligible: 'действие допустимо по состоянию записи; здесь оно не выполняется',
  no_action_defined: 'ограниченного действия для этого нет',
  in_backoff: 'идёт backoff',
  awaiting_progress: 'прогресс недавний, ждём',
  evidence_incomplete: 'данных недостаточно',
  generation_changed: 'поколение сменилось, нужно перечитать',
  manual_review_required: 'нужен ручной разбор',
  identity_unverified: 'идентичность не подтверждена',
  terminal: 'терминальное решение',
  owner_input_required: 'нужны данные от владельца',
  already_queued: 'уже в очереди',
};
const LIMBO_PROGRESS_TEXT = {progressing: 'двигается', waiting: 'ждёт backoff', due: 'повтор наступил', overdue: 'просрочено', stalled: 'застряло', terminal: 'терминально', unknown: 'неизвестно', not_applicable: 'не применимо'};
const LIMBO_SEVERITY_TEXT = {critical: 'критично', warning: 'внимание', info: 'справка'};
const LIMBO_THRESHOLD_TEXT = {stalledMs: 'без прогресса', retryGraceMs: 'просрочка повтора', predictionMaxBackoffMs: 'предел backoff прогнозов', discoveryMaxBackoffMs: 'предел backoff discovery', metadataMaxBackoffMs: 'предел backoff метаданных', metadataFreshMs: 'свежесть метаданных', queueStalledMs: 'очередь без запусков'};
const LIMBO_EVIDENCE_TEXT = {complete: 'полные', partial: 'частичные', missing: 'отсутствуют'};
const LIMBO_ANOMALY_TEXT = {clock_skew: 'отметка времени из будущего', projection_generation_differs: 'другое поколение', duplicate_subject: 'запись встретилась дважды'};
const LIMBO_ERROR_TEXT = {
  network: 'Нет ответа от сервера. Проверьте соединение и доступ и повторите запрос.',
  programme_unavailable: 'Опубликованная программа сейчас недоступна: нет опубликованного поколения или его объект не совпадает с указателем. Ничего не запускалось.',
  storage_unavailable: 'Хранилище не ответило. Это чтение не повторяет запись и не запускает восстановление.',
  stale_pin: 'Снимок изменился. Обновите снимок, чтобы продолжить.',
  invalid_pin: 'Снимок в запросе не распознан. Обновите снимок.',
  invalid_limit: 'Некорректный размер страницы. Принимается целое число от 1 до 25.',
  invalid_age: 'Срок без прогресса задаётся целым числом дней от 0 до 365.',
  unknown_kind: 'Такого вида записей нет.',
  unknown_subsystem: 'Такой подсистемы нет.',
  unknown_cause: 'Такой причины нет.',
  stale_cursor: 'Страница устарела. Откройте список заново.',
  evaluation_failed: 'Модель не смогла оценить снимок. Ничего не изменено.',
  method_not_allowed: 'Страница делает только GET-запросы.',
};
const LIMBO_DEBOUNCE_MS = 200;

const limboLive = {pin: null, snapshot: null, counts: null, seq: 0, controller: null, timer: null, pending: null, stale: false, next: null, state: null};

function limboEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function limboState() {
  const url = new URL(window.location.href);
  const age = url.searchParams.get('age') ?? '';
  return {
    kind: url.searchParams.get('kind') ?? '',
    subsystem: url.searchParams.get('subsystem') ?? '',
    cause: url.searchParams.get('cause') ?? '',
    age: /^(?:0|[1-9]\d{0,2})$/.test(age) ? age : '',
  };
}

function limboUrl(state) {
  const params = new URLSearchParams();
  for (const name of ['kind', 'subsystem', 'cause', 'age']) if (state[name]) params.set(name, state[name]);
  const query = params.toString();
  return query ? '/admin/limbo?' + query : '/admin/limbo';
}

function limboWrite(state, mode) {
  const href = limboUrl(state);
  if (mode === 'push') history.pushState(state, '', href);
  else history.replaceState(state, '', href);
}

function limboErrorText(code) {
  if (LIMBO_ERROR_TEXT[code]) return LIMBO_ERROR_TEXT[code];
  if (/^http_\d+$/.test(String(code))) return 'Сервер ответил ошибкой ' + String(code).slice(5) + '. Записи не загружены.';
  return 'Запрос не выполнен: ' + String(code || 'неизвестная ошибка') + '.';
}

function limboDate(value) {
  if (!value) return 'нет отметки';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function limboDays(ms) {
  if (typeof ms !== 'number') return 'неизвестно';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return days + ' дн.';
  const hours = Math.floor(ms / 3600000);
  return hours >= 1 ? hours + ' ч.' : 'меньше часа';
}

function limboSnapshotText(snapshot) {
  if (!snapshot) return 'Снимок ещё не прочитан.';
  const generation = String(snapshot.programmeRunId || '').slice(0, 8) || '—';
  const parts = [
    'Поколение ' + generation + ', программа от ' + limboDate(snapshot.programmeUpdatedAt),
    'оценка на ' + limboDate(snapshot.evaluatedAt),
    snapshot.queuePresent === false ? 'очереди прогнозов нет в хранилище' : 'очередь прогнозов от ' + limboDate(snapshot.queueRefreshedAt) + (snapshot.queueProgrammeRunId && snapshot.queueProgrammeRunId !== snapshot.programmeRunId ? ' (поколение ' + String(snapshot.queueProgrammeRunId).slice(0, 8) + ')' : ''),
    snapshot.indexPresent === false ? 'индекса прогнозов нет в хранилище' : 'индекс прогнозов прочитан',
  ];
  let text = parts.join(' · ') + '.';
  if (snapshot.clock && snapshot.clock.anomalies && snapshot.clock.anomalies.length) text += ' Часы: ' + snapshot.clock.anomalies.map(code => LIMBO_ANOMALY_TEXT[code] || code).join(', ') + '.';
  return text;
}

function limboChip(group, code, label, count, pressed, hint) {
  return `<button type="button" class="admin-queue" data-limbo-${group}="${limboEscape(code)}" aria-pressed="${pressed ? 'true' : 'false'}"${hint ? ` title="${limboEscape(hint)}"` : ''}><span>${limboEscape(label)}</span><small>${count === null ? '—' : count}</small></button>`;
}

function limboRenderFilters(state) {
  const counts = limboLive.counts;
  const causes = document.querySelector('#limbo-causes');
  causes.innerHTML = Object.keys(LIMBO_CAUSE_LABELS).map(code => limboChip('cause', code, LIMBO_CAUSE_LABELS[code], counts ? counts.byCause[code] ?? 0 : null, state.cause === code, LIMBO_CAUSE_HINTS[code])).join('');
  const subsystems = document.querySelector('#limbo-subsystems');
  subsystems.innerHTML = ['identity', 'metadata', 'localization', 'fingerprint', 'prediction'].map(code => limboChip('subsystem', code, LIMBO_SUBSYSTEM_LABELS[code], counts ? counts.bySubsystem[code] ?? 0 : null, state.subsystem === code)).join('');
  const kind = document.querySelector('#limbo-kind');
  if (kind.value !== state.kind) kind.value = state.kind;
  const age = document.querySelector('#limbo-age');
  if (age.value !== state.age) age.value = state.age;
}

function limboBadge(tone, text) {
  return `<span class="admin-status admin-status-${tone}">${limboEscape(text)}</span>`;
}

function limboCauseTone(cause) {
  return cause === 'manual_review' ? 'conflict' : cause === 'retry_eligible' || cause === 'stalled' ? 'provisional' : cause === 'unknown' || cause === 'stale_projection' ? 'ambiguous' : cause === 'backoff' || cause === 'pending' ? 'reviewed' : 'plain';
}

function limboItemHtml(item) {
  const film = item.film;
  const title = film?.title || (item.kind === 'observation' ? 'Наблюдение ' + item.subjectId : film?.storedId || item.subjectId);
  const kindLabel = item.kind === 'observation' ? 'наблюдение' : film && film.inProgramme === false ? 'фильм каталога (вне программы)' : 'фильм';
  const identity = film?.identity;
  const identityText = identity ? (identity.canonicalIdentity ? 'доверенная идентичность ' + identity.canonicalIdentity : identity.trustedExternalIds.length ? 'доверенные id: ' + identity.trustedExternalIds.join(', ') : identity.status ? 'идентичность: ' + identity.status : 'идентичность не наблюдалась') + (identity.conflicting ? ' · конфликт' : '') : 'идентичность не наблюдалась';
  const action = item.action || {};
  const actionText = (LIMBO_ACTION_TEXT[action.suggested] || action.suggested || '—') + (action.code ? ': ' + (LIMBO_ACTION_CODE_TEXT[action.code] || action.code) : '') + ' · ' + (action.eligible === true ? 'допустимо' : action.eligible === false ? 'недопустимо' : 'неизвестно') + (action.reason ? ' (' + (LIMBO_ELIGIBILITY_TEXT[action.reason] || action.reason) + ')' : '');
  const evidence = item.evidence || {};
  const evidenceText = (LIMBO_EVIDENCE_TEXT[evidence.completeness] || evidence.completeness || '—') + ', источник ' + (evidence.source || '—') + ', прочитано ' + limboDate(evidence.observedAt) + ((evidence.missing || []).length ? ', нет: ' + evidence.missing.join(', ') : '') + ((evidence.anomalies || []).length ? ', аномалии: ' + evidence.anomalies.map(code => LIMBO_ANOMALY_TEXT[code] || code).join(', ') : '');
  const diagnostics = item.diagnostics || {};
  const diagnosticParts = [];
  if (diagnostics.failureReason) diagnosticParts.push('последняя ошибка: ' + diagnostics.failureReason);
  if (diagnostics.retryScope) diagnosticParts.push('область: ' + diagnostics.retryScope);
  if (diagnostics.lastRunId) diagnosticParts.push('запуск: ' + diagnostics.lastRunId);
  if (typeof diagnostics.attempts === 'number') diagnosticParts.push('попыток: ' + diagnostics.attempts);
  if (diagnostics.nextAction) diagnosticParts.push('следующий шаг конвейера: ' + diagnostics.nextAction);
  if (diagnostics.terminalReason) diagnosticParts.push('терминальная причина: ' + diagnostics.terminalReason);
  const rows = [
    ['причина', LIMBO_REASON_TEXT[item.reason] || item.reason],
    ['без прогресса', limboDays(item.age?.ms) + (item.age?.lastProgressAt ? ', последний переход ' + limboDate(item.age.lastProgressAt) : item.age?.ms === null ? ' (время последнего перехода неизвестно)' : '')],
    ['прогресс', (LIMBO_PROGRESS_TEXT[item.progress?.status] || item.progress?.status || '—') + (item.progress?.retryAt ? ', повтор ' + limboDate(item.progress.retryAt) : '')],
    ['ожидаемое действие', actionText],
    ['порог', item.threshold ? limboDays(item.threshold.value) + ' — ' + (LIMBO_THRESHOLD_TEXT[item.threshold.code] || item.threshold.code) : '—'],
    ['данные', evidenceText],
    ['идентичность', identityText],
  ];
  if (diagnosticParts.length) rows.push(['диагностика', diagnosticParts.join(' · ')]);
  const links = [];
  if (item.links?.film) links.push(`<a class="limbo-link" href="${limboEscape(item.links.film)}">Открыть в каталоге данных</a>`);
  if (item.kind === 'observation') links.push('<span class="muted">Identity Review для наблюдений ещё не доступен.</span>');
  return `<article class="admin-hit limbo-item" data-limbo-item="${limboEscape(item.id)}"><span class="admin-hit-title">${limboEscape(title)}</span><span class="admin-hit-meta">${limboEscape([kindLabel, film?.storedId, film?.year ? String(film.year) : null, item.id].filter(Boolean).join(' · '))}</span><span class="admin-badges">${limboBadge(limboCauseTone(item.cause), LIMBO_CAUSE_LABELS[item.cause] || item.cause)}${limboBadge('plain', LIMBO_SUBSYSTEM_LABELS[item.subsystem] || item.subsystem)}${limboBadge(item.severity === 'critical' ? 'conflict' : item.severity === 'warning' ? 'provisional' : 'missing', LIMBO_SEVERITY_TEXT[item.severity] || item.severity)}</span><dl class="limbo-facts">${rows.map(([name, value]) => `<div><dt>${limboEscape(name)}</dt><dd>${limboEscape(value)}</dd></div>`).join('')}</dl>${links.length ? `<p class="limbo-links">${links.join(' ')}</p>` : ''}</article>`;
}

function limboContextHtml(view) {
  const parts = [];
  const coverage = view.coverage || {};
  parts.push(`<p>Фильмы: ${coverage.films === 'complete' ? 'полное покрытие' : 'частичное покрытие'} — прочитано записей: ${coverage.filmsObserved ?? '—'}. Запись вне списка не считается здоровой: о ней просто ничего не известно.</p>`);
  if (coverage.observations && coverage.observations.available === false) parts.push('<p class="limbo-unavailable">Нерешённые наблюдения EPG недоступны этим чтением: для них нужен отдельный ограниченный индекс поколения, который записывается при публикации программы. Их отсутствие в списке ничего не говорит об их состоянии.</p>');
  if (view.context && view.context.length) {
    parts.push('<h3>Состояние конвейера</h3><ul>' + view.context.map(issue => `<li>${limboEscape(LIMBO_SUBSYSTEM_LABELS[issue.subsystem] || issue.subsystem)} · ${limboEscape(LIMBO_SEVERITY_TEXT[issue.severity] || issue.severity)} · ${limboEscape(LIMBO_REASON_TEXT[issue.reason] || issue.reason)}${issue.affected && issue.affected.count ? ' · затронуто: ' + issue.affected.count : ''}${issue.progress && issue.progress.retryAt ? ' · повтор ' + limboEscape(limboDate(issue.progress.retryAt)) : ''}</li>`).join('') + '</ul>');
  } else parts.push('<p class="muted">Поколение и очередь прогнозов без замечаний в прочитанном снимке.</p>');
  if (view.unread && view.unread.length) parts.push('<h3>Не читается этой страницей</h3><p class="muted">' + view.unread.map(entry => limboEscape(LIMBO_SUBSYSTEM_LABELS[entry.subsystem] || entry.subsystem) + (entry.evidence === 'object_missing' ? ' (объекта нет в хранилище)' : '')).join(', ') + '. Эти подсистемы здесь неизвестны, а не здоровы.</p>');
  if (view.thresholds) parts.push(`<h3>Пороги</h3><p class="muted">застряло: ${limboDays(view.thresholds.stalledMs)} без прогресса · просрочка повтора: ${limboDays(view.thresholds.retryGraceMs)} · backoff прогнозов до ${limboDays(view.thresholds.predictionMaxBackoffMs)} · backoff discovery до ${limboDays(view.thresholds.discoveryMaxBackoffMs)} · очередь без запусков: ${limboDays(view.thresholds.queueStalledMs)}</p>`);
  return parts.join('');
}

function limboShow(view, state) {
  const loading = document.querySelector('#limbo-loading');
  const error = document.querySelector('#limbo-error');
  const stale = document.querySelector('#limbo-stale');
  const empty = document.querySelector('#limbo-empty');
  const results = document.querySelector('#limbo-results');
  const total = document.querySelector('#limbo-total');
  loading.hidden = true;
  stale.hidden = !limboLive.stale;
  document.querySelector('#limbo-snapshot-text').textContent = limboSnapshotText(limboLive.snapshot);
  limboRenderFilters(state);
  error.hidden = view.mode !== 'error';
  error.textContent = view.mode === 'error' ? limboErrorText(view.error) : '';
  const showResults = view.mode === 'ready';
  if (!showResults) {
    empty.hidden = true;
    results.innerHTML = '';
    total.textContent = '';
    return;
  }
  total.textContent = view.total ? String(view.total) : '';
  empty.hidden = view.items.length > 0;
  results.innerHTML = view.items.map(limboItemHtml).join('') + (view.nextCursor ? '<button type="button" class="admin-more" data-limbo-more="items">Показать ещё</button>' : '');
  document.querySelector('#limbo-context-body').innerHTML = limboContextHtml(view);
}

function limboRender() {
  const state = limboState();
  limboLive.state = state;
  const seq = ++limboLive.seq;
  if (limboLive.controller) limboLive.controller.abort();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  limboLive.controller = controller;
  document.querySelector('#limbo-loading').hidden = false;
  const pending = loadLimboLive(state, {pin: limboLive.pin, snapshot: limboLive.snapshot, signal: controller ? controller.signal : undefined}).then(view => {
    if (seq !== limboLive.seq || view.mode === 'aborted') return view;
    if (view.mode === 'stale') {
      limboLive.stale = true;
      document.querySelector('#limbo-loading').hidden = true;
      document.querySelector('#limbo-stale').hidden = false;
      document.querySelector('#limbo-error').hidden = true;
      return view;
    }
    if (view.mode === 'ready') {
      limboLive.pin = view.pin || limboLive.pin;
      limboLive.snapshot = view.snapshot || limboLive.snapshot;
      limboLive.counts = view.counts || limboLive.counts;
      limboLive.next = view.nextCursor;
      limboLive.stale = false;
    }
    limboShow(view, state);
    return view;
  });
  limboLive.pending = pending;
  return pending;
}

function limboSchedule() {
  if (limboLive.timer) clearTimeout(limboLive.timer);
  limboLive.timer = setTimeout(() => {
    limboLive.timer = null;
    limboRender();
  }, LIMBO_DEBOUNCE_MS);
}

function onLimboRefresh() {
  limboLive.pin = null;
  limboLive.snapshot = null;
  limboLive.counts = null;
  limboLive.stale = false;
  limboLive.next = null;
  document.querySelector('#limbo-stale').hidden = true;
  return limboRender();
}

function onLimboMore() {
  const state = limboState();
  const cursor = limboLive.next;
  if (!cursor) return Promise.resolve(null);
  const button = document.querySelector('[data-limbo-more="items"]');
  if (button) button.disabled = true;
  const seq = limboLive.seq;
  const pending = loadLimboMore(state, cursor, {pin: limboLive.pin}).then(page => {
    if (seq !== limboLive.seq) return page;
    if (page.mode === 'stale') {
      limboLive.stale = true;
      document.querySelector('#limbo-stale').hidden = false;
      if (button) button.disabled = false;
      return page;
    }
    if (page.mode === 'error') {
      const error = document.querySelector('#limbo-error');
      error.hidden = false;
      error.textContent = limboErrorText(page.error);
      if (button) button.disabled = false;
      return page;
    }
    limboLive.next = page.nextCursor;
    const results = document.querySelector('#limbo-results');
    if (button) button.remove();
    results.insertAdjacentHTML('beforeend', page.items.map(limboItemHtml).join('') + (page.nextCursor ? '<button type="button" class="admin-more" data-limbo-more="items">Показать ещё</button>' : ''));
    return page;
  });
  limboLive.pending = pending;
  return pending;
}

function onLimboChip(event) {
  const button = event.target.closest ? event.target.closest('[data-limbo-cause],[data-limbo-subsystem]') : null;
  if (!button) return;
  const state = limboState();
  const cause = button.getAttribute('data-limbo-cause');
  const subsystem = button.getAttribute('data-limbo-subsystem');
  if (cause !== null) state.cause = state.cause === cause ? '' : cause;
  if (subsystem !== null) state.subsystem = state.subsystem === subsystem ? '' : subsystem;
  limboWrite(state, 'push');
  return limboRender();
}

function onLimboForm(event) {
  if (event && event.preventDefault) event.preventDefault();
  const state = limboState();
  state.kind = document.querySelector('#limbo-kind').value || '';
  const age = String(document.querySelector('#limbo-age').value || '').trim();
  state.age = /^(?:0|[1-9]\d{0,2})$/.test(age) && Number(age) <= 365 ? age : '';
  limboWrite(state, 'push');
  if (limboLive.timer) clearTimeout(limboLive.timer);
  limboLive.timer = null;
  return limboRender();
}

function onLimboReset() {
  limboWrite({kind: '', subsystem: '', cause: '', age: ''}, 'push');
  return limboRender();
}

function onLimboResult(event) {
  const more = event.target.closest ? event.target.closest('[data-limbo-more]') : null;
  if (!more) return;
  event.preventDefault();
  onLimboMore();
}

function onLimboKey(event) {
  if (event.key !== 'Escape') return;
  const state = limboState();
  if (!state.kind && !state.subsystem && !state.cause && !state.age) return;
  event.preventDefault();
  onLimboReset();
}

function onLimboHistory() {
  return limboRender();
}

function startLimbo() {
  document.querySelector('#limbo-form').addEventListener('submit', onLimboForm);
  document.querySelector('#limbo-kind').addEventListener('change', onLimboForm);
  document.querySelector('#limbo-age').addEventListener('input', limboSchedule);
  document.querySelector('#limbo-reset').addEventListener('click', onLimboReset);
  document.querySelector('#limbo-causes').addEventListener('click', onLimboChip);
  document.querySelector('#limbo-subsystems').addEventListener('click', onLimboChip);
  document.querySelector('#limbo-results').addEventListener('click', onLimboResult);
  document.querySelector('#limbo-refresh').addEventListener('click', onLimboRefresh);
  window.addEventListener('keydown', onLimboKey);
  window.addEventListener('popstate', onLimboHistory);
  limboWrite(limboState(), 'replace');
  limboRender();
}

startLimbo();
