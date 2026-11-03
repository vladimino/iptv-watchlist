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
const HEALTH_SEVERITY_TEXT = {critical: 'срочно', warning: 'важно', info: 'не срочно'};
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

function healthFilmLink(id, index, total) {
  const label = total > 1 ? `Открыть фильм ${index + 1}` : 'Открыть фильм';
  const accessible = total > 1 ? `${label} в этой проблеме` : label;
  return `<a href="${healthEscape('/admin?kind=film&id=' + encodeURIComponent(id))}" data-admin-kind="film" data-admin-id="${healthEscape(id)}" aria-label="${healthEscape(accessible)}">${label}</a>`;
}

function healthSubsystemCard(name, entry, derived) {
  const status = entry.status;
  const worst = entry.worst ? ` · худшее: ${HEALTH_SEVERITY_TEXT[entry.worst] || entry.worst}` : '';
  const evidence = HEALTH_EVIDENCE_TEXT[entry.evidence] || entry.evidence;
  const note = entry.derived === 'view_index' ? 'выводится из индекса отпечатков и прогнозов, который сейчас не прочитан' : derived || '';
  return `<div class="health-card health-card-${healthEscape(status)}" data-subsystem="${healthEscape(name)}"><span class="health-card-name">${healthEscape(HEALTH_SUBSYSTEM_TEXT[name] || name)}</span><span class="health-card-status">${healthEscape(HEALTH_STATUS_TEXT[status] || status)}</span><small>${healthEscape(evidence)}${entry.issues ? ` · проблем: ${entry.issues}` : ''}${healthEscape(worst)}</small>${note ? `<small class="health-card-note">${healthEscape(note)}</small>` : ''}</div>`;
}

const HEALTH_LIMB_SUBSYSTEMS = new Set(['identity', 'metadata', 'localization', 'fingerprint', 'prediction']);

function healthSituation(group) {
  if (group.reason === 'evidence_not_supplied' || group.reason === 'evidence_object_missing' || group.reason === 'progress_unknown') return 'неизвестно';
  if ((group.freshness || {}).unknown || (group.progress || {}).unknown) return 'неизвестно';
  if (group.reason === 'retry_waiting' || (group.progress || {}).waiting) return 'ожидание';
  if (group.category === 'stale' || (group.freshness || {}).stale) return 'устарело';
  if (group.reason === 'metadata_partial' || (group.evidence || {}).partial) return 'частично';
  return '';
}

const HEALTH_ELIGIBILITY_SHORT = {
  eligible: '', no_action_defined: 'шага нет', in_backoff: 'в паузе', awaiting_progress: 'ждёт прогресса',
  evidence_incomplete: 'данных мало', generation_changed: 'поколение сменилось', manual_review_required: 'нужна ручная проверка',
  identity_unverified: 'идентичность не подтверждена', terminal: 'терминально', owner_input_required: 'нужен ввод', already_queued: 'уже в очереди',
};
const HEALTH_GAP_REASONS = new Set(['evidence_not_supplied', 'evidence_object_missing', 'progress_unknown']);
const HEALTH_WAIT_REASONS = new Set(['retry_waiting', 'work_pending', 'work_queued', 'all_deferred_by_retry']);
const HEALTH_WAIT_ELIGIBILITY = new Set(['in_backoff', 'awaiting_progress', 'already_queued']);

// Presentation only. Critical and warning stay in the action band, including a missing published source and unknown
// queue progress: those are not the same as an info source this page does not read. An info group is routine waiting
// when the evaluator says to wait. An info gap stays unverified. Eligible work stays in the action band.
function healthRoutine(group) {
  const action = group.action || {};
  return action.eligible !== true && (
    action.suggested === 'wait' || HEALTH_WAIT_REASONS.has(group.reason) || HEALTH_WAIT_ELIGIBILITY.has(action.reason)
  );
}

function healthBand(group) {
  if (group.severity === 'critical' || group.severity === 'warning') return 'act';
  if (HEALTH_GAP_REASONS.has(group.reason)) return 'gap';
  return healthRoutine(group) ? 'wait' : 'act';
}

function healthNextLinks(group) {
  const links = [];
  if (group.subsystem === 'poster') links.push('<a href="/admin/posters">Постеры</a>');
  if (group.subsystem === 'letterboxd_archive') links.push('<a href="/admin/letterboxd">Архив Letterboxd</a>');
  if (HEALTH_LIMB_SUBSYSTEMS.has(group.subsystem)) links.push(`<a href="/admin/limb?subsystem=${healthEscape(group.subsystem)}">Лимб</a>`);
  return links.length ? ` ${links.join(', ')}` : '';
}

function healthNextStep(group) {
  const action = group.action || {};
  const concrete = healthEscape(HEALTH_ACTION_CODE_TEXT[action.code] || action.code || 'шаг не назван');
  const links = healthNextLinks(group);
  if (action.code === 'reread_snapshot') {
    const changed = action.reason === 'generation_changed' ? 'Поколение сменилось. ' : '';
    return `${changed}Обновить оценку можно кнопкой «Перечитать».${links}`;
  }
  if (group.reason === 'evidence_not_supplied' || group.reason === 'evidence_object_missing' || (group.reason === 'progress_unknown' && group.subjectKind === 'catalog' && !(group.affected > 0))) {
    return `Проверить нельзя: данных не хватает.${links}`;
  }
  if (healthRoutine(group)) {
    const queued = action.reason === 'already_queued' || group.reason === 'work_queued';
    const prediction = group.subsystem === 'prediction' || group.subsystem === 'prediction_queue';
    const waiting = {in_backoff: 'в паузе', awaiting_progress: 'ждёт прогресса', already_queued: 'уже в очереди'};
    const body = queued ? (prediction ? 'прогноз уже в очереди' : 'уже в очереди') : (waiting[action.reason] || (group.reason === 'work_pending' ? 'ждёт прогресса' : 'ждёт обычного хода'));
    const retry = group.retryAt?.earliest ? ` Ближайший повтор ${healthDate(group.retryAt.earliest)}.` : '';
    return `Дальше само: ${body}.${retry}${links}`;
  }
  if (action.eligible === true) return healthEligibleStep(action, concrete, links);
  const unknown = action.eligible === null ? ' Хватит ли данных, неизвестно.' : '';
  return `Разобраться вручную: ${concrete}.${unknown}${links}`;
}

// Eligible describes the subject in the health answer, not a control on this page. Only the poster and archive
// pages expose that workflow, and each still confirms on its own. Limb is a read-only list. Discovery has no page.
function healthEligibleStep(action, concrete, links) {
  const nav = links ? ' Ссылка только открывает страницу.' : '';
  if (action.code === 'poster_hydration') return `На странице «Постеры» есть свой запуск со своей проверкой.${nav}${links}`;
  if (action.code === 'archive_import') return `На странице «Архив Letterboxd» есть свой запуск со своей проверкой.${nav}${links}`;
  if (action.code === 'metadata_refresh') return `Лимб только показывает записи. Обновления метаданных там нет.${nav}${links}`;
  if (action.code === 'prediction_retry') return `Лимб только показывает записи. Повтора прогноза там нет.${nav}${links}`;
  if (action.code === 'discovery_retry') return 'Повтор discovery делает следующий шаг пайплайна. Страницы с этим действием нет.';
  return `Шаг «${concrete}» отмечен у записи. Страницы с этим действием нет.`;
}

function healthAffectedText(group) {
  const evidence = group.evidence || {};
  const observed = (evidence.complete || 0) + (evidence.partial || 0);
  const posterUnknown = group.reason === 'progress_unknown' && group.subjectKind === 'catalog' && !(group.affected > 0);
  const gap = group.reason === 'evidence_not_supplied' || group.reason === 'evidence_object_missing' || (!observed && (evidence.missing || 0) > 0) || posterUnknown;
  if (gap) return 'Неизвестно, сколько затронуто.';
  if (group.subjectKind === 'film') return healthPlural(group.affected || 0, 'фильм', 'фильма', 'фильмов');
  const kind = HEALTH_SUBJECT_TEXT[group.subjectKind] || group.subjectKind || 'запись';
  return `Затронуто: ${group.affected || 0} (${kind}).`;
}

function healthGroupKey(group, index) {
  if (group.key) return group.key;
  return [group.subsystem || '', group.category || '', group.reason || '', group.severity || '', group.subjectKind || '', index].join('|');
}

function healthGroupBody(group, now) {
  const action = group.action || {};
  const evidence = healthCounts(group.evidence, {complete: 'полные', partial: 'частичные', missing: 'отсутствуют'});
  const missing = Object.keys(group.missing || {}).length ? ` · не хватает: ${Object.keys(group.missing).join(', ')}` : '';
  const anomalies = Object.keys(group.anomalies || {}).length ? ` · аномалии: ${Object.keys(group.anomalies).join(', ')}` : '';
  const progress = healthCounts(group.progress, HEALTH_PROGRESS_TEXT);
  const freshness = healthCounts(group.freshness, HEALTH_FRESHNESS_TEXT);
  const retry = group.retryAt?.earliest ? `ближайший повтор ${healthDate(group.retryAt.earliest)}` : '';
  const since = group.lastProgressAt?.earliest ? `самый старый прогресс ${healthAge(group.lastProgressAt.earliest, now)}` : 'прогресс без отметки времени';
  const threshold = !group.threshold ? '' : group.threshold.unit === 'records' ? `порог ${group.threshold.code} = ${group.threshold.value} записей` : `порог ${group.threshold.code} = ${healthDuration(group.threshold.value)}`;
  const more = group.issues > (group.sample || []).length ? ` и ещё ${group.issues - group.sample.length}` : '';
  const samples = group.sample || [];
  const filmLinks = group.subjectKind === 'film' ? samples.map((id, index) => healthFilmLink(id, index, samples.length)).join(', ') : '';
  const rawSample = (group.sample || []).map(id => healthEscape(id)).join(', ');
  const categoryText = HEALTH_CATEGORY_TEXT[group.category] || group.category;
  const situation = healthSituation(group);
  const situationMark = situation && situation !== categoryText ? `<span class="health-situation">${healthEscape(situation)}</span>` : '';
  const eligible = action.eligible === true ? 'true' : action.eligible === false ? 'false' : 'null';
  return `<div class="health-group-head"><span class="health-severity health-severity-${healthEscape(group.severity)}">${healthEscape(HEALTH_SEVERITY_TEXT[group.severity] || group.severity)}</span><h4 id="admin-health-detail-subject" class="health-group-title">${healthEscape(HEALTH_SUBSYSTEM_TEXT[group.subsystem] || group.subsystem)} · ${healthEscape(categoryText)}</h4>${situationMark}</div>
    <p class="health-group-why">${healthEscape(HEALTH_REASON_TEXT[group.reason] || group.reason)}</p>
    <p class="health-group-affected">${healthEscape(healthAffectedText(group))}</p>
    <p class="health-group-next">${healthNextStep(group)}</p>
    <p class="health-group-result">Подтверждённого результата в этом чтении нет.</p>
    ${filmLinks ? `<p class="health-group-subjects">${filmLinks}${healthEscape(more)}</p>` : ''}
    <details class="health-tech"><summary>Технические подробности</summary>
    <dl class="health-group-facts">
      <div><dt>Доказательства</dt><dd>${healthEscape(evidence || '—')}${healthEscape(missing)}${healthEscape(anomalies)} · прочитано ${healthEscape(healthAge(group.observedAt?.latest, now))}</dd></div>
      <div><dt>Свежесть / прогресс</dt><dd>${healthEscape([freshness, progress].filter(Boolean).join(' · ') || '—')}${since ? ' · ' + healthEscape(since) : ''}${retry ? ' · ' + healthEscape(retry) : ''}${threshold ? ' · ' + healthEscape(threshold) : ''}</dd></div>
      <div><dt>Действие</dt><dd>${healthEscape(action.suggested || '—')} · ${healthEscape(action.code || '—')} · eligible ${eligible} · ${healthEscape(action.reason || '—')}</dd></div>
      <div><dt>Субъекты</dt><dd>${rawSample || '—'}${healthEscape(more)}</dd></div>
    </dl></details>`;
}

function healthGroupRow(group, now) {
  return `<li class="health-group health-group-${healthEscape(group.severity)}" data-group="${healthEscape(group.key)}">${healthGroupBody(group, now)}</li>`;
}

function healthOptionsHtml(groups, all, selectedKey) {
  return groups.map(group => {
    const index = all.indexOf(group);
    const key = healthGroupKey(group, index);
    const selected = key === selectedKey;
    const title = `${HEALTH_SUBSYSTEM_TEXT[group.subsystem] || group.subsystem} · ${HEALTH_CATEGORY_TEXT[group.category] || group.category}`;
    const why = HEALTH_REASON_TEXT[group.reason] || group.reason;
    return `<button type="button" class="health-option${selected ? ' is-selected' : ''}" role="option" id="health-opt-${index}" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}" data-issue-key="${healthEscape(key)}"><span class="health-severity health-severity-${healthEscape(group.severity)}">${healthEscape(HEALTH_SEVERITY_TEXT[group.severity] || group.severity)}</span><span class="health-option-title">${healthEscape(title)}</span><span class="health-option-why">${healthEscape(why)}</span></button>`;
  }).join('');
}

function healthVerdictCounts(health) {
  const counts = {attention: 0, clear: 0, unknown: 0, total: 0};
  for (const entry of Object.values(health.subsystems || {})) {
    counts.total++;
    if (entry.status === 'unknown') counts.unknown++;
    else if (entry.status === 'clear' || entry.status === 'clear_in_scope') counts.clear++;
    else counts.attention++;
  }
  return counts;
}

function healthUnreadText(sources) {
  return Object.entries(sources || {}).filter(([, entry]) => entry.evidence !== 'observed').map(([name, entry]) => {
    const label = HEALTH_SOURCE_TEXT[name] || name;
    return `${label}: ${entry.evidence === 'object_missing' ? 'объекта нет' : 'не читается'}`;
  }).join(', ');
}

function healthKpiCounts(body) {
  const groups = body.health?.groups || [];
  const sources = Object.values(body.sources || {});
  return {
    critical: groups.filter(group => group.severity === 'critical').length,
    warning: groups.filter(group => group.severity === 'warning').length,
    unknown: sources.filter(entry => entry.evidence !== 'observed').length,
  };
}

function healthKpiHtml(body) {
  const counts = healthKpiCounts(body);
  const card = (kind, count, label, unit) => `<li class="health-kpi health-kpi-${kind}${count ? '' : ' is-zero'}" data-kpi="${kind}"><b class="health-kpi-value">${count}</b><span class="health-kpi-label">${label}</span><small>${unit}</small></li>`;
  return `<ul class="health-kpis" data-critical="${counts.critical}" data-warning="${counts.warning}" data-unknown="${counts.unknown}">${card('critical', counts.critical, 'Критично', 'групп с важностью «срочно»')}${card('warning', counts.warning, 'Предупреждения', 'групп с важностью «важно»')}${card('unknown', counts.unknown, 'Неизвестно', 'источников не прочитано')}</ul>`;
}

function healthSummaryHtml(body) {
  const health = body.health || {};
  const scope = health.scope || {};
  const counts = healthVerdictCounts(health);
  const films = scope.coverage?.films === 'complete' ? 'вся программа' : scope.coverage?.films === 'partial' ? 'часть программы' : 'покрытие не заявлено';
  const anomalies = (health.clock?.anomalies || []).length ? `<p class="health-anomalies">Аномалии часов: ${healthEscape(health.clock.anomalies.join(', '))}.</p>` : '';
  const sources = body.sources || {};
  const sourceTotal = Object.keys(sources).length;
  const sourceRead = Object.values(sources).filter(entry => entry.evidence === 'observed').length;
  const unread = healthUnreadText(sources);
  const groups = health.groups || [];
  const steps = {act: 0, wait: 0, gap: 0};
  for (const group of groups) steps[healthBand(group)]++;
  const lead = groups.length ? (steps.act ? 'act' : 'calm') : counts.attention ? 'attention' : counts.unknown ? 'unknown' : 'clear';
  const leadText = lead === 'act' ? 'Разобраться' : lead === 'calm' ? 'Срочного шага нет' : lead === 'attention' ? 'Требует внимания' : lead === 'unknown' ? 'Недостаточно данных' : 'В пределах проверенного всё хорошо';
  const leadCount = lead === 'act' ? healthPlural(steps.act, 'проблема', 'проблемы', 'проблем') : lead === 'calm' ? 'среди текущих групп' : healthPlural(lead === 'attention' ? counts.attention : lead === 'unknown' ? counts.unknown : counts.clear, 'подсистема', 'подсистемы', 'подсистем');
  return `<div class="health-board" data-lead="${lead}">
    <p class="health-lead health-lead-${lead}"><b>${leadText}</b><span>${healthEscape(leadCount)}</span></p>
    <dl class="health-facts">
      <div><dt>Время</dt><dd>${healthEscape(healthDate(health.now))}</dd></div>
      <div><dt>Источники</dt><dd>прочитано ${sourceRead} из ${sourceTotal}</dd></div>
      <div><dt>Фильмы</dt><dd>${scope.subjects?.films ?? '—'}, ${healthEscape(films)}</dd></div>
    </dl>
    ${unread ? `<p class="health-unread">Не прочитано: ${healthEscape(unread)}.</p>` : ''}
    ${anomalies}
    <p class="health-score-note">Сводного балла нет. Ноль остаётся нулём.</p>
  </div>`;
}

function healthQueueGroups(groups) {
  return groups.filter(group => healthBand(group) !== 'wait');
}

function healthInboxHtml(groups, now, selectedKey) {
  const queue = healthQueueGroups(groups);
  const waits = groups.filter(group => healthBand(group) === 'wait');
  const chosen = groups.find((group, index) => healthGroupKey(group, index) === selectedKey) || queue[0] || waits[0] || null;
  const key = chosen ? healthGroupKey(chosen, groups.indexOf(chosen)) : '';
  return {
    key,
    queue: queue.length ? healthOptionsHtml(queue, groups, key) : '<p class="health-queue-empty">Срочных проблем нет.</p>',
    wait: healthOptionsHtml(waits, groups, key),
    detail: chosen ? healthGroupBody(chosen, now) : '<p class="health-detail-empty">Выбранной проблемы нет.</p>',
  };
}

function healthIssuesHtml(groups, now) {
  const inbox = healthInboxHtml(groups, now, '');
  return `<div class="health-queue">${inbox.queue}</div><div class="health-detail-slot">${inbox.detail}</div><div class="health-wait-slot">${inbox.wait}</div>`;
}

function healthSourcesText(sources) {
  return Object.entries(sources || {}).map(([name, entry]) => {
    const label = HEALTH_SOURCE_TEXT[name] || name;
    if (entry.evidence === 'observed') return `${label}: прочитано${entry.count !== undefined ? ', ' + entry.count : ''}${entry.entries !== undefined ? ', записей ' + entry.entries : ''}`;
    if (entry.evidence === 'object_missing') return `${label}: объекта нет`;
    return `${label}: не читается здесь`;
  }).join(' · ');
}

let healthRenderedGroups = [];
let healthRenderedNow = '';
let healthSelectedKey = '';

function healthParkDetail() {
  const detail = document.querySelector('#admin-health-detail');
  const master = document.querySelector('.health-master');
  if (!detail || !master || typeof master.append !== 'function' || detail.parentElement === master) return;
  master.append(detail);
}

function healthPlaceDetail(narrow) {
  const detail = document.querySelector('#admin-health-detail');
  if (!detail) return;
  detail.setAttribute('data-placement', narrow ? 'under-selected' : 'beside');
  const selected = document.querySelector('#admin-health-issues .is-selected, #admin-health-wait-list .is-selected');
  const master = document.querySelector('.health-master');
  if (!selected || !master || typeof selected.after !== 'function' || typeof master.append !== 'function') return;
  if (narrow) selected.after(detail);
  else if (detail.parentElement !== master) master.append(detail);
}

function healthPaintSelection() {
  healthParkDetail();
  const inbox = healthInboxHtml(healthRenderedGroups, healthRenderedNow, healthSelectedKey);
  healthSelectedKey = inbox.key;
  document.querySelector('#admin-health-issues').innerHTML = inbox.queue;
  const wait = document.querySelector('#admin-health-wait');
  wait.hidden = !inbox.wait;
  document.querySelector('#admin-health-wait-list').innerHTML = inbox.wait;
  document.querySelector('#admin-health-detail-body').innerHTML = inbox.detail;
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches;
  healthPlaceDetail(narrow);
}

function healthApplySelection(key) {
  if (!healthRenderedGroups.some((group, index) => healthGroupKey(group, index) === key)) return;
  const focused = document.activeElement;
  const keepFocus = !!(focused && focused.closest && focused.closest('[data-issue-key]'));
  healthSelectedKey = key;
  healthPaintSelection();
  if (!keepFocus) return;
  const selected = document.querySelector('#admin-health-issues .is-selected, #admin-health-wait-list .is-selected');
  if (selected) selected.focus();
}

function onAdminHealthSelect(event) {
  const option = event.target && event.target.closest ? event.target.closest('[data-issue-key]') : null;
  if (!option || (event.target.closest && event.target.closest('a, summary, details'))) return;
  event.preventDefault();
  healthApplySelection(option.getAttribute('data-issue-key'));
}

function onAdminHealthOptionKey(event) {
  const option = event.target && event.target.closest ? event.target.closest('[data-issue-key]') : null;
  if (!option || (event.target.closest && event.target.closest('input, textarea, select'))) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    healthApplySelection(option.getAttribute('data-issue-key'));
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const list = option.closest('[role="listbox"]');
  if (!list || !list.querySelectorAll) return;
  const options = [...list.querySelectorAll('[data-issue-key]')];
  const index = options.indexOf(option);
  const next = options[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  healthApplySelection(next.getAttribute('data-issue-key'));
}

// Renders one health answer into the view's nodes. `body` is the parsed health answer. Choosing a row only
// repaints the already read groups; it does not fetch again and it does not write.
function renderAdminHealth(body) {
  const health = body.health || {};
  const now = health.now;
  const groups = health.groups || [];
  healthRenderedGroups = groups;
  healthRenderedNow = now;
  if (!groups.some((group, index) => healthGroupKey(group, index) === healthSelectedKey)) healthSelectedKey = '';
  document.querySelector('#admin-health-summary').innerHTML = healthSummaryHtml(body);
  document.querySelector('#admin-health-kpis').innerHTML = healthKpiHtml(body);
  document.querySelector('#admin-health-sources').textContent = 'Источники: ' + healthSourcesText(body.sources);
  const subsystems = document.querySelector('#admin-health-subsystems');
  subsystems.innerHTML = Object.entries(health.subsystems || {}).map(([name, entry]) => healthSubsystemCard(name, entry)).join('');
  const empty = document.querySelector('#admin-health-empty');
  const counts = healthVerdictCounts(health);
  const filmsComplete = health.scope?.coverage?.films === 'complete';
  healthPaintSelection();
  empty.hidden = groups.length > 0;
  if (groups.length) {
    empty.textContent = '';
    empty.setAttribute('data-verdict', '');
  } else if (counts.unknown || !filmsComplete) {
    empty.textContent = counts.unknown
      ? `Недостаточно данных. Не прочитано и остаётся неизвестным, а не здоровым: ${healthPlural(counts.unknown, 'подсистема', 'подсистемы', 'подсистем')}.`
      : 'В пределах прочитанного проблем нет. Покрытие фильмов неполное, это не вся программа.';
    empty.setAttribute('data-verdict', counts.unknown ? 'unknown' : 'scoped');
  } else {
    empty.textContent = 'В пределах проверенного всё хорошо.';
    empty.setAttribute('data-verdict', 'clear');
  }
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
