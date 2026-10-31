// The "Здоровье данных" view of the owner page: one health read per render (made by the client), the evaluated health shown as
// subsystem cards and a ranked list of issue groups with evidence age, counts, the suggested action and where to
// look next. The evaluation happens in the Worker; this file only renders its answer. Nothing here executes an
// action: a suggested action is text, and an action the page cannot offer says so.
const HEALTH_SUBSYSTEM_TEXT = {
  programme: 'Программа', identity: 'Идентичность', metadata: 'Метаданные', localization: 'Локализация', fingerprint: 'Отпечатки',
  prediction: 'Прогнозы', prediction_queue: 'Очередь прогнозов', discovery: 'Discovery', poster: 'Постеры', letterboxd_archive: 'Архив Letterboxd',
};
const HEALTH_STATUS_TEXT = {clear: 'в порядке', clear_in_scope: 'в порядке в пределах снимка', attention: 'требует внимания', unknown: 'неизвестно'};
const HEALTH_EVIDENCE_TEXT = {observed: 'прочитано', not_supplied: 'источник не читается этой страницей', object_missing: 'объекта нет в хранилище'};
const HEALTH_SEVERITY_TEXT = {critical: 'критично', warning: 'внимание', info: 'сведение'};
const HEALTH_CATEGORY_TEXT = {conflict: 'конфликт', stuck: 'застряло', stale: 'устарело', missing_asset: 'нет ресурса', external_refresh: 'нужен внешний источник', incomplete: 'не завершено'};
const HEALTH_REASON_TEXT = {
  evidence_not_supplied: 'Источник не входит в это ограниченное чтение; состояние неизвестно, а не здорово.',
  evidence_object_missing: 'Объект-источник отсутствует в хранилище; состояние неизвестно.',
  generation_not_published: 'Нет опубликованного поколения программы.',
  generation_stale: 'Опубликованное поколение старше порога ежедневного обновления.',
  pin_generation_changed: 'Поколение, под которым читался снимок, сменилось.',
  projection_generation_differs: 'Проекция собрана для другого поколения программы.',
  identity_conflict: 'Конфликт внешних id или несколько TMDB-идентичностей.',
  identity_ambiguous: 'Идентичность неоднозначна и ждёт решения.',
  localization_conflict: 'Удержанные конфликты локализации ждут ручного решения.',
  queue_disagreement: 'Состояние фильма не актуально, но очередь его не содержит.',
  retry_waiting: 'Повтор назначен и ещё в пределах backoff: это ожидание, не зависание.',
  retry_due: 'Время повтора наступило, работа ждёт часового запуска.',
  retry_overdue: 'Время повтора прошло, а запуск его не подобрал.',
  backoff_beyond_policy: 'Повтор назначен дальше, чем допускает политика.',
  no_progress: 'Нет записанного прогресса дольше порога.',
  terminal_without_resolution: 'Терминальная причина без решения.',
  progress_unknown: 'Нет отметки времени, чтобы судить о прогрессе.',
  work_pending: 'Работа ожидается, прогресс недавний.',
  work_queued: 'Фильм стоит в очереди.',
  repeated_failures: 'Повторяющиеся сбои при повторе.',
  metadata_stale: 'Метаданные старше окна свежести.',
  metadata_partial: 'Метаданные неполные.',
  metadata_missing: 'Метаданные отсутствуют.',
  eligible_work_without_runs: 'Есть работа для прогнозов, но запусков или проверок не было.',
  all_deferred_by_retry: 'Вся оставшаяся работа отложена повторами.',
  continuation_running_stale: 'Continuation числится запущенным дольше двух lease.',
  continuation_not_advanced: 'Continuation не продвинулся после истечения gate.',
  poster_missing: 'У фильма нет постера.',
  posters_missing: 'В каталоге есть записи без постера.',
  baseline_missing: 'Baseline Letterboxd не импортирован.',
  baseline_age_unknown: 'Возраст baseline Letterboxd не определить.',
  baseline_stale: 'Baseline Letterboxd старше порога.',
  clock_skew: 'Отметка времени из будущего.',
};
const HEALTH_ACTION_TEXT = {wait: 'ждать', investigate: 'разобраться', bounded_action: 'ограниченное действие'};
const HEALTH_ACTION_CODE_TEXT = {
  reread_snapshot: 'перечитать снимок', check_scheduled_tasks: 'проверить Scheduled Tasks', manual_review: 'ручная проверка', discovery_retry: 'повтор discovery',
  metadata_refresh: 'обновление метаданных', prediction_retry: 'повтор прогноза', poster_hydration: 'гидрация постеров', archive_import: 'импорт архива', supply_evidence: 'нужны данные',
};
const HEALTH_ELIGIBILITY_TEXT = {
  eligible: 'субъект готов к действию; на этой странице действия не выполняются', no_action_defined: 'действия не определено', in_backoff: 'в backoff, ждать',
  awaiting_progress: 'ждёт прогресса', evidence_incomplete: 'данных недостаточно, чтобы судить', generation_changed: 'поколение сменилось, перечитать',
  manual_review_required: 'нужна ручная проверка', identity_unverified: 'идентичность не подтверждена', terminal: 'терминальное состояние',
  owner_input_required: 'нужен ввод владельца', already_queued: 'уже в очереди',
};
const HEALTH_PROGRESS_TEXT = {progressing: 'идёт', waiting: 'ожидание', due: 'пора', overdue: 'просрочено', stalled: 'застряло', terminal: 'терминально', unknown: 'неизвестно', not_applicable: 'н/п'};
const HEALTH_FRESHNESS_TEXT = {fresh: 'свежо', stale: 'устарело', unknown: 'неизвестно'};
const HEALTH_SUBJECT_TEXT = {generation: 'поколение', film: 'фильм', observation: 'наблюдение', queue: 'очередь', continuation: 'continuation', catalog: 'каталог', archive: 'архив', subsystem: 'подсистема'};
const HEALTH_SOURCE_TEXT = {
  published: 'указатель поколения', films: 'фильмы программы', viewIndex: 'индекс отпечатков и прогнозов', profile: 'профиль вкуса', predictionQueue: 'очередь прогнозов',
  discovery: 'continuation discovery', posters: 'копия каталога (постеры)', observations: 'нерешённые наблюдения', letterboxd: 'baseline Letterboxd',
};

function healthPlural(count, one, few, many) {
  const tens = count % 100, ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
  return count + ' ' + word;
}

function healthEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function healthAge(value, now) {
  if (!value) return 'нет отметки';
  const ms = Date.parse(value), base = Date.parse(now);
  if (!Number.isFinite(ms) || !Number.isFinite(base)) return String(value);
  const diff = base - ms;
  if (diff < 0) return 'в будущем';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return minutes + ' мин назад';
  const hours = Math.round(diff / 3600000);
  if (hours < 48) return hours + ' ч назад';
  return Math.round(diff / 86400000) + ' дн назад';
}

function healthDate(value) {
  if (!value) return 'нет отметки';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function healthDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms % 86400000 === 0) return ms / 86400000 + ' дн';
  if (ms % 3600000 === 0) return ms / 3600000 + ' ч';
  return Math.round(ms / 60000) + ' мин';
}

function healthCounts(map, texts) {
  return Object.entries(map || {}).filter(([, count]) => count > 0).map(([key, count]) => `${texts[key] || key}: ${count}`).join(', ');
}

function healthSubjectLink(kind, id) {
  if (kind === 'film') return `<a href="${healthEscape('/admin?kind=film&id=' + encodeURIComponent(id))}" data-admin-kind="film" data-admin-id="${healthEscape(id)}">${healthEscape(id)}</a>`;
  return `<span>${healthEscape(id)}</span>`;
}

function healthSubsystemCard(name, entry, derived) {
  const status = entry.status;
  const worst = entry.worst ? ` · худшее: ${HEALTH_SEVERITY_TEXT[entry.worst] || entry.worst}` : '';
  const evidence = HEALTH_EVIDENCE_TEXT[entry.evidence] || entry.evidence;
  const note = entry.derived === 'view_index' ? 'выводится из индекса отпечатков и прогнозов, который сейчас не прочитан' : derived || '';
  return `<div class="health-card health-card-${healthEscape(status)}" data-subsystem="${healthEscape(name)}"><span class="health-card-name">${healthEscape(HEALTH_SUBSYSTEM_TEXT[name] || name)}</span><span class="health-card-status">${healthEscape(HEALTH_STATUS_TEXT[status] || status)}</span><small>${healthEscape(evidence)}${entry.issues ? ` · проблем: ${entry.issues}` : ''}${healthEscape(worst)}</small>${note ? `<small class="health-card-note">${healthEscape(note)}</small>` : ''}</div>`;
}

function healthGroupRow(group, now) {
  const action = group.action || {};
  const eligibility = action.eligible === true ? 'готово' : action.eligible === false ? 'недоступно' : 'неизвестно';
  const evidence = healthCounts(group.evidence, {complete: 'полные', partial: 'частичные', missing: 'отсутствуют'});
  const missing = Object.keys(group.missing || {}).length ? ` · не хватает: ${Object.keys(group.missing).join(', ')}` : '';
  const anomalies = Object.keys(group.anomalies || {}).length ? ` · аномалии: ${Object.keys(group.anomalies).join(', ')}` : '';
  const progress = healthCounts(group.progress, HEALTH_PROGRESS_TEXT);
  const freshness = healthCounts(group.freshness, HEALTH_FRESHNESS_TEXT);
  const retry = group.retryAt?.earliest ? `ближайший повтор ${healthDate(group.retryAt.earliest)}` : '';
  const since = group.lastProgressAt?.earliest ? `самый старый прогресс ${healthAge(group.lastProgressAt.earliest, now)}` : 'прогресс без отметки времени';
  const threshold = !group.threshold ? '' : group.threshold.unit === 'records' ? `порог ${group.threshold.code} = ${group.threshold.value} записей` : `порог ${group.threshold.code} = ${healthDuration(group.threshold.value)}`;
  const sample = (group.sample || []).map(id => healthSubjectLink(group.subjectKind, id)).join(', ');
  const more = group.issues > (group.sample || []).length ? ` и ещё ${group.issues - group.sample.length}` : '';
  const navigation = group.subjectKind === 'film' ? 'Открыть фильм в каталоге по ссылке.' : group.subsystem === 'prediction_queue' ? 'Смотреть очередь прогнозов в диагностике предсказаний.' : group.subsystem === 'discovery' ? 'Смотреть статус discovery pipeline.' : group.subsystem === 'poster' ? '' : group.subsystem === 'letterboxd_archive' ? 'Импорт архива — отдельная owner-операция.' : '';
  return `<li class="health-group health-group-${healthEscape(group.severity)}" data-group="${healthEscape(group.key)}">
    <div class="health-group-head"><span class="health-severity health-severity-${healthEscape(group.severity)}">${healthEscape(HEALTH_SEVERITY_TEXT[group.severity] || group.severity)}</span><span class="health-group-title">${healthEscape(HEALTH_SUBSYSTEM_TEXT[group.subsystem] || group.subsystem)} · ${healthEscape(HEALTH_CATEGORY_TEXT[group.category] || group.category)}</span><span class="health-group-count">${healthEscape(HEALTH_SUBJECT_TEXT[group.subjectKind] || group.subjectKind)}: ${group.issues}${group.affected !== group.issues ? ` · затронуто: ${group.affected}` : ''}</span></div>
    <p class="health-group-why">${healthEscape(HEALTH_REASON_TEXT[group.reason] || group.reason)}</p>
    <dl class="health-group-facts">
      <div><dt>Доказательства</dt><dd>${healthEscape(evidence || '—')}${healthEscape(missing)}${healthEscape(anomalies)} · прочитано ${healthEscape(healthAge(group.observedAt?.latest, now))}</dd></div>
      <div><dt>Свежесть / прогресс</dt><dd>${healthEscape([freshness, progress].filter(Boolean).join(' · ') || '—')}${since ? ' · ' + healthEscape(since) : ''}${retry ? ' · ' + healthEscape(retry) : ''}${threshold ? ' · ' + healthEscape(threshold) : ''}</dd></div>
      <div><dt>Действие</dt><dd><b>${healthEscape(HEALTH_ACTION_TEXT[action.suggested] || action.suggested)}</b>: ${healthEscape(HEALTH_ACTION_CODE_TEXT[action.code] || action.code)} · ${healthEscape(eligibility)} (${healthEscape(HEALTH_ELIGIBILITY_TEXT[action.reason] || action.reason)})${navigation ? ' · ' + healthEscape(navigation) : ''}${group.subsystem === 'poster' && group.subjectKind !== 'film' ? ' · <a href="/admin/posters">Постеры: покрытие и ручная дозагрузка</a> (здесь не запускается)' : ''}</dd></div>
      <div><dt>Субъекты</dt><dd>${sample || '—'}${healthEscape(more)}</dd></div>
    </dl>
  </li>`;
}

function healthSummaryText(body) {
  const health = body.health || {};
  const counts = health.counts?.bySeverity || {};
  const scope = health.scope || {};
  const parts = [
    `Оценка на ${healthDate(health.now)}`,
    `поколение ${String(health.published?.programmeRunId || scope.programmeRunId || '—').slice(0, 8)}${health.published?.publishedAt ? ' от ' + healthDate(health.published.publishedAt) : ''}`,
    `фильмов прочитано: ${scope.subjects?.films ?? '—'} (${scope.coverage?.films === 'complete' ? 'вся программа' : 'часть'})`,
    `критично: ${counts.critical ?? 0}, внимание: ${counts.warning ?? 0}, сведений: ${counts.info ?? 0}`,
  ];
  if ((health.clock?.anomalies || []).length) parts.push('аномалии часов: ' + health.clock.anomalies.join(', '));
  return parts.join(' · ') + '. Сводного балла нет: полнота, свежесть и прогресс показаны отдельно.';
}

function healthSourcesText(sources) {
  return Object.entries(sources || {}).map(([name, entry]) => {
    const label = HEALTH_SOURCE_TEXT[name] || name;
    if (entry.evidence === 'observed') return `${label}: прочитано${entry.count !== undefined ? ', ' + entry.count : ''}${entry.entries !== undefined ? ', записей ' + entry.entries : ''}`;
    if (entry.evidence === 'object_missing') return `${label}: объекта нет`;
    return `${label}: не читается здесь`;
  }).join(' · ');
}

// Renders one health answer into the view's nodes. `body` is the parsed health answer.
function renderAdminHealth(body) {
  const health = body.health || {};
  const now = health.now;
  document.querySelector('#admin-health-summary').textContent = healthSummaryText(body);
  document.querySelector('#admin-health-sources').textContent = 'Источники: ' + healthSourcesText(body.sources);
  const subsystems = document.querySelector('#admin-health-subsystems');
  subsystems.innerHTML = Object.entries(health.subsystems || {}).map(([name, entry]) => healthSubsystemCard(name, entry)).join('');
  const groups = health.groups || [];
  const list = document.querySelector('#admin-health-issues');
  const empty = document.querySelector('#admin-health-empty');
  const unknown = Object.values(health.subsystems || {}).filter(entry => entry.status === 'unknown').length;
  const actionable = groups.filter(group => group.reason !== 'evidence_not_supplied');
  list.innerHTML = groups.map(group => healthGroupRow(group, now)).join('');
  empty.hidden = actionable.length > 0;
  empty.textContent = actionable.length ? '' : unknown ? `Среди прочитанных подсистем проблем не найдено. Не прочитано и остаётся неизвестным, а не здоровым: ${healthPlural(unknown, 'подсистема', 'подсистемы', 'подсистем')}.` : 'Проблем не найдено во всех прочитанных подсистемах.';
}

// The health view state: loading, error, stale and ready are distinct nodes; ready keeps the last answer on screen
// while a refresh is in flight.
function healthState(mode, text) {
  const loading = document.querySelector('#admin-health-loading');
  const error = document.querySelector('#admin-health-error');
  const stale = document.querySelector('#admin-health-stale');
  loading.hidden = mode !== 'loading';
  error.hidden = mode !== 'error';
  error.textContent = mode === 'error' ? text : '';
  stale.hidden = mode !== 'stale';
}
