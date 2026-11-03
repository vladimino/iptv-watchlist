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
// Display groups over the existing causes. Not a new cause and not a filter the API understands.
const LIMBO_QUEUES = ['owner', 'stalled', 'automatic', 'unverified'];
const LIMBO_QUEUE_COPY = {
  owner: {title: 'Требует моего решения', hint: 'Дальше человек: конфликт, внешние данные или остановка, которую может снять разбор.'},
  stalled: {title: 'Обычный шаг не назначен', hint: 'Прогресса нет, и повтор не стоит в расписании. Кнопки записи для этой причины нет.'},
  automatic: {title: 'Ожидает автоматическую обработку', hint: 'Следующий обычный шаг уже назначен или запись стоит в очереди.'},
  unverified: {title: 'Не удалось проверить', hint: 'По этим записям нельзя сказать, что они в порядке.'},
};
const LIMBO_RECOVERY_SUBSYSTEMS = ['prediction', 'fingerprint'];
const LIMBO_RECOVERY_FILM_ID = /^[A-Za-z0-9_-]{1,80}$/;

const limboLive = {pin: null, snapshot: null, counts: null, seq: 0, controller: null, timer: null, pending: null, stale: false, next: null, state: null, selected: null};
// One entry per rendered «Разобрать прогноз» panel: the stored film id it reads, whether it is open, the pin of its last
// answer and a sequence number so that an older answer never replaces a newer one.
const limboRecovery = new Map();
let limboRecoveryNext = 0;
let limboDetailNext = 0;
// Select tokens stay numeric so an observation key never appears on the card face. The map is rebuilt with each render.
const limboSelect = new Map();
// One entry per rendered «Разобрать наблюдение» panel: the observation key, its last answer and pin, and the owner's
// progress through the guarded action (the checkbox, the server-issued confirmation, the receipt).
const obsRecovery = new Map();

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
  return query ? '/admin/limb?' + query : '/admin/limb';
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
  const tools = document.querySelector('#limbo-tools');
  if (tools && (state.kind || state.subsystem || state.cause || state.age)) tools.open = true;
}

function limboBadge(tone, text) {
  return `<span class="admin-status admin-status-${tone}">${limboEscape(text)}</span>`;
}

function limboCauseTone(cause) {
  return cause === 'manual_review' ? 'conflict' : cause === 'retry_eligible' || cause === 'stalled' ? 'provisional' : cause === 'unknown' || cause === 'stale_projection' ? 'ambiguous' : cause === 'backoff' || cause === 'pending' ? 'reviewed' : 'plain';
}

function limboSentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const head = value.charAt(0).toLocaleUpperCase('ru-RU') + value.slice(1);
  return /[.!?…]$/.test(head) ? head : head + '.';
}

// One line under the verdict. It names the specific reason and stays quiet when it would only repeat the badge.
function limboReasonLine(item) {
  const reason = LIMBO_REASON_TEXT[item.reason];
  if (!reason) return '';
  const cause = LIMBO_CAUSE_LABELS[item.cause] || '';
  if (reason.toLocaleLowerCase('ru-RU') === cause.toLocaleLowerCase('ru-RU')) return '';
  return limboSentence(reason);
}

// Who moves next. A closed sentence, never the formal "разобраться · недопустимо (…)" combination and never a raw code.
function limboNextLine(item) {
  if (item.kind === 'observation' && (item.reason === 'identity_ambiguous' || item.reason === 'identity_conflict')) return 'Дальше человек. Кнопка ниже объясняет, можно ли записать идентичность, и показывает, что сейчас и что станет.';
  if (item.kind === 'observation' && item.reason === 'terminal_without_resolution') return 'Дальше человек, если разбор назовёт возврат в обычную очередь допустимым.';
  const lead = {
    retry_eligible: 'Дальше обычный проход системы.',
    stalled: 'Дальше никто не назначен.',
    backoff: 'Дальше система, в уже назначенное время.',
    pending: 'Дальше система: запись в очереди или недавно двигалась.',
    manual_review: 'Дальше человек.',
    stale_projection: 'Дальше перечитать снимок: данные другого поколения.',
    external_archive: 'Дальше данные извне.',
    unknown: 'Кто действует, по этим данным не назвать. Это не значит, что всё в порядке.',
  }[item.cause] || 'Кто действует, по этим данным не назвать.';
  return limboRecoveryFilm(item) ? lead.replace(/\.$/, '') + '. Разбор прогноза объясняет состояние.' : lead;
}

// Which control this row actually draws. The health model's action.eligible describes the subject, not a button and not a confirmed write.
function limboOfferLine(item) {
  if (limboRecoveryObservation(item)) return 'Кнопка ниже только читает разбор. Можно ли что-то записать, эта строка ещё не проверяла.';
  if (limboRecoveryFilm(item)) return 'Кнопка ниже только читает объяснение прогноза. Записи для этого фильма на странице нет.';
  return 'Кнопки записи на этой странице нет. Готовность в модели здоровья данных записью не является.';
}

// The clock facts that change a decision: a scheduled retry, and how long the record has stood still. Empty states stay out.
function limboWhenLine(item) {
  const parts = [];
  const progress = item.progress?.status;
  if (typeof item.age?.ms === 'number' && item.age.ms >= 86400000 && (item.cause === 'stalled' || item.cause === 'manual_review' || item.cause === 'retry_eligible' || item.cause === 'unknown')) parts.push('без прогресса ' + limboDays(item.age.ms));
  if (item.progress?.retryAt) parts.push('повтор ' + limboDate(item.progress.retryAt));
  if (item.age?.lastProgressAt && progress && progress !== 'not_applicable') parts.push('последний переход ' + limboDate(item.age.lastProgressAt));
  else if (item.age?.ms === null && item.cause === 'unknown') parts.push('время последнего перехода неизвестно');
  return parts.length ? limboSentence(parts.join(', ')) : '';
}

function limboIdentityText(item) {
  const identity = item.film?.identity;
  if (!identity) return 'идентичность не наблюдалась';
  const base = identity.canonicalIdentity ? 'доверенная идентичность ' + identity.canonicalIdentity : identity.trustedExternalIds.length ? 'доверенные id: ' + identity.trustedExternalIds.join(', ') : identity.status ? 'идентичность: ' + identity.status : 'идентичность не наблюдалась';
  return base + (identity.conflicting ? ' · конфликт' : '');
}

function limboTechHtml(item) {
  const film = item.film;
  const action = item.action || {};
  const evidence = item.evidence || {};
  const diagnostics = item.diagnostics || {};
  const kindLabel = item.kind === 'observation' ? 'наблюдение' : film && film.inProgramme === false ? 'фильм каталога (вне программы)' : 'фильм';
  const actionText = (LIMBO_ACTION_TEXT[action.suggested] || action.suggested || '—') + (action.code ? ': ' + (LIMBO_ACTION_CODE_TEXT[action.code] || action.code) : '') + ' · ' + (action.eligible === true ? 'допустимо' : action.eligible === false ? 'недопустимо' : 'неизвестно') + (action.reason ? ' (' + (LIMBO_ELIGIBILITY_TEXT[action.reason] || action.reason) + ')' : '');
  const evidenceText = (LIMBO_EVIDENCE_TEXT[evidence.completeness] || evidence.completeness || '—') + ', источник ' + (evidence.source || '—') + ', прочитано ' + limboDate(evidence.observedAt) + ((evidence.missing || []).length ? ', нет: ' + evidence.missing.join(', ') : '') + ((evidence.anomalies || []).length ? ', аномалии: ' + evidence.anomalies.map(code => LIMBO_ANOMALY_TEXT[code] || code).join(', ') : '');
  const diagnosticParts = [];
  if (diagnostics.failureReason) diagnosticParts.push('последняя ошибка: ' + diagnostics.failureReason);
  if (diagnostics.retryScope) diagnosticParts.push('область: ' + diagnostics.retryScope);
  if (diagnostics.lastRunId) diagnosticParts.push('запуск: ' + diagnostics.lastRunId);
  if (typeof diagnostics.attempts === 'number') diagnosticParts.push('попыток: ' + diagnostics.attempts);
  if (diagnostics.nextAction) diagnosticParts.push('следующий шаг конвейера: ' + diagnostics.nextAction);
  if (diagnostics.terminalReason) diagnosticParts.push('терминальная причина: ' + diagnostics.terminalReason);
  if (diagnostics.rule) diagnosticParts.push('правило: ' + diagnostics.rule);
  const rows = [
    ['запись', item.id],
    ['ключ', item.kind === 'observation' ? (item.observation?.key || item.subjectId) : film?.storedId || item.subjectId],
    ['вид', kindLabel],
    ['подсистема', (LIMBO_SUBSYSTEM_LABELS[item.subsystem] || item.subsystem) + (item.subsystem ? ' (' + item.subsystem + ')' : '')],
    ['серьёзность', (LIMBO_SEVERITY_TEXT[item.severity] || item.severity || '') + (item.severity ? ' (' + item.severity + ')' : '')],
    ['причина', (LIMBO_REASON_TEXT[item.reason] || item.reason || '') + (item.reason ? ' (' + item.reason + ')' : '')],
    ['без прогресса', limboDays(item.age?.ms) + (item.age?.lastProgressAt ? ', последний переход ' + limboDate(item.age.lastProgressAt) : item.age?.ms === null ? ' (время последнего перехода неизвестно)' : '')],
    ['прогресс', (LIMBO_PROGRESS_TEXT[item.progress?.status] || item.progress?.status || '—') + (item.progress?.retryAt ? ', повтор ' + limboDate(item.progress.retryAt) : '')],
    ['ожидаемое действие', actionText],
    ['порог', item.threshold ? limboDays(item.threshold.value) + ' — ' + (LIMBO_THRESHOLD_TEXT[item.threshold.code] || item.threshold.code) : ''],
    ['данные', evidenceText],
    ['идентичность', limboIdentityText(item)],
  ];
  if (diagnosticParts.length) rows.push(['диагностика', diagnosticParts.join(' · ')]);
  const body = rows.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '').map(([name, value]) => `<div><dt>${limboEscape(name)}</dt><dd>${limboEscape(value)}</dd></div>`).join('');
  return `<details class="limbo-tech"><summary>Технические подробности</summary><dl class="limbo-facts">${body}</dl></details>`;
}

function limboQueueId(item) {
  if (item.cause === 'manual_review' || item.cause === 'external_archive') return 'owner';
  if (item.cause === 'stalled') return 'stalled';
  if (item.cause === 'retry_eligible' || item.cause === 'backoff' || item.cause === 'pending') return 'automatic';
  return 'unverified';
}

// What this page can honestly say about the outcome. A missing result is not a success, and a raw code stays in the technical block.
function limboResultLine(item) {
  const evidence = item.evidence || {};
  const terminal = item.diagnostics && item.diagnostics.terminalReason;
  if (item.cause === 'unknown' || evidence.completeness === 'missing' || evidence.completeness === 'partial' || item.progress?.status === 'unknown') return 'Результат не подтверждён: данных недостаточно, чтобы назвать исход. Это не значит, что всё в порядке.';
  if (item.cause === 'stale_projection') return 'Результат текущего поколения не подтверждён: запись относится к другому снимку. Действие с этой страницы не выполняется.';
  if (item.reason === 'terminal_without_resolution') {
    const exhausted = terminal === 'no_more_evidence' ? ' Автоматические попытки на тех же данных исчерпаны.' : '';
    return 'Итог конвейера — остановка без распознанного фильма.' + exhausted + ' Запись с карточки не делается, пока разбор сам не предложит действие.';
  }
  if (item.reason === 'identity_conflict' || item.reason === 'identity_ambiguous') return 'Итог автоматической сверки — столкновение или неоднозначность идентичности. Кнопка записи появится в разборе только если действие допустимо, и заранее покажет, что было и что станет.';
  if (item.cause === 'backoff' || item.cause === 'pending' || item.cause === 'retry_eligible') return 'Итога ещё нет.';
  if (item.cause === 'stalled') return 'Обычный шаг не назначен. Результата нет.';
  if (item.cause === 'manual_review' || item.cause === 'external_archive') return 'Автоматического итога нет.';
  return 'Итог этой записью не назван.';
}

function limboObservationGap(observations) {
  if (!observations) return 'unread';
  if (observations.available === false) return 'unavailable';
  if (observations.state === 'stale') return 'stale';
  const omitted = observations.omitted || {};
  const cut = (Number(omitted.cap) || 0) + (Number(omitted.oversized) || 0) + (Number(omitted.malformed) || 0);
  if (observations.complete === false || cut > 0 || (Number(observations.awaitingFirstLookup) || 0) > 0) return 'partial';
  return null;
}

function limboEmptyCopy(view, state) {
  const observations = view.coverage && view.coverage.observations;
  const gap = state.kind === 'film' ? null : limboObservationGap(observations);
  if (gap === 'unavailable') return {title: 'Нельзя подтвердить, что записей нет', text: 'Индекс наблюдений не прочитан: ' + (LIMBO_OBSERVATION_UNAVAILABLE[observations.reason] || 'причина не названа') + '. Пустой список не означает, что нерешённых наблюдений нет.'};
  if (gap === 'stale') return {title: 'Нельзя подтвердить, что записей нет', text: 'Индекс наблюдений устарел: карта решений или реестр изменились после его записи. Пустой список относится к моменту записи и не подтверждает отсутствие записей.'};
  if (gap === 'partial') return {title: 'Нельзя подтвердить, что записей нет', text: 'Индекс наблюдений частичный. Записи, которые в него не вошли, здесь не видны, и их отсутствие не подтверждено.'};
  if (gap === 'unread') return {title: 'Нельзя подтвердить, что записей нет', text: 'Покрытие наблюдений этим чтением не получено. Пустой список не означает, что нерешённых наблюдений нет.'};
  return {title: 'По этому фильтру записей нет', text: 'В прочитанном снимке нет записей без прогресса, которые проходят фильтр. Подсистемы, которые эта страница не читает, от этого не становятся здоровыми.'};
}

function limboEmptyHtml(view, state) {
  const copy = limboEmptyCopy(view, state);
  return `<span aria-hidden="true">∅</span><b id="limbo-empty-title">${limboEscape(copy.title)}</b><span id="limbo-empty-text">${limboEscape(copy.text)}</span>`;
}

function limboItemHtml(item) {
  const film = item.film;
  const title = film?.title || (item.kind === 'observation' ? item.observation?.title || 'Наблюдение без названия' : 'Фильм без названия');
  const year = film?.year || item.observation?.year;
  const kindLabel = item.kind === 'observation' ? 'наблюдение' : film && film.inProgramme === false ? 'фильм каталога (вне программы)' : 'фильм';
  const meta = [year ? String(year) : null, kindLabel].filter(Boolean).join(' · ');
  const reason = limboReasonLine(item);
  const when = limboWhenLine(item);
  const links = [];
  if (item.links?.film) links.push(`<a class="limbo-link" href="${limboEscape(item.links.film)}">Открыть в каталоге данных</a>`);
  else if (item.links?.filmUnavailable === 'not_in_programme') links.push('<span class="muted limbo-unlinked">Фильма нет в опубликованной программе: карточки в каталоге данных для него нет.</span>');
  else if (item.links?.filmUnavailable === 'record_not_observed') links.push('<span class="muted limbo-unlinked">Запись фильма в этом снимке не прочитана: карточку открыть нельзя.</span>');
  let recovery = '';
  const recoveryFilm = limboRecoveryFilm(item);
  if (recoveryFilm) {
    const slot = String(++limboRecoveryNext);
    limboRecovery.set(slot, {filmId: recoveryFilm, open: false, pin: null, seq: 0});
    links.push(`<button type="button" class="admin-more limbo-recovery-open" data-limbo-recovery="${slot}" aria-expanded="false" aria-controls="limbo-recovery-${slot}">Разобрать прогноз</button>`);
    recovery = `<section class="limbo-recovery" id="limbo-recovery-${slot}" data-limbo-recovery-slot="${slot}" aria-label="Разбор прогноза" hidden></section>`;
  }
  const observationKey = limboRecoveryObservation(item);
  if (observationKey) {
    const slot = 'o' + String(++limboRecoveryNext);
    obsRecovery.set(slot, {key: observationKey, open: false, pin: null, seq: 0, answer: null, changed: false, accepted: false, confirmation: null, receipt: null, durable: null, index: null, busy: false, error: null, identityEffect: '', identityTarget: '', identityBasis: '', identityAccepted: false, identityConfirmation: null, identityPlan: null, identityApplication: null, identityReceipt: null, identityIndex: null, identityReason: null, identityBusy: false});
    links.push(`<button type="button" class="admin-more limbo-recovery-open" data-obs-recovery="${slot}" aria-expanded="false" aria-controls="obs-recovery-${slot}">Разобрать наблюдение</button>`);
    recovery = `<section class="limbo-recovery" id="obs-recovery-${slot}" data-obs-recovery-slot="${slot}" aria-label="Разбор наблюдения" hidden></section>`;
  }
  const selected = item.id === limboLive.selected;
  const selectToken = String(++limboDetailNext);
  limboSelect.set(selectToken, item.id);
  const detailId = 'limbo-detail-' + selectToken;
  const face = `<button type="button" class="limbo-select" data-limbo-select="${selectToken}" aria-expanded="${selected ? 'true' : 'false'}" aria-controls="${detailId}"><span class="admin-hit-title">${limboEscape(title)}</span>${meta ? `<span class="admin-hit-meta">${limboEscape(meta)}</span>` : ''}<span class="admin-badges">${limboBadge(limboCauseTone(item.cause), LIMBO_CAUSE_LABELS[item.cause] || 'Состояние не распознано')}</span></button>`;
  const jump = `<button type="button" class="limbo-jump" data-limbo-jump="${selectToken}" aria-controls="${detailId}"${selected ? '' : ' hidden'}>К объяснению: ${limboEscape(title)}</button>`;
  const heading = `<h3 class="limbo-detail-title" tabindex="-1">${limboEscape(title)}${meta ? ` <span class="admin-hit-meta">${limboEscape(meta)}</span>` : ''}</h3>`;
  const detail = `<div class="limbo-detail" id="${detailId}" data-limbo-title="${limboEscape(title)}"${selected ? '' : ' hidden'}>${heading}${reason ? `<p class="limbo-happened"><b>Что произошло.</b> ${limboEscape(reason)}</p>` : ''}<p class="limbo-next"><b>Кто дальше.</b> ${limboEscape(limboNextLine(item))}</p>${when ? `<p class="limbo-when"><b>Когда.</b> ${limboEscape(when)}</p>` : ''}<p class="limbo-result"><b>Итог.</b> ${limboEscape(limboResultLine(item))}</p><p class="limbo-offer"><b>Действие.</b> ${limboEscape(limboOfferLine(item))}</p>${links.length ? `<div class="limbo-actions">${links.join('')}</div>` : ''}${recovery}${limboTechHtml(item)}</div>`;
  return `<article class="admin-hit limbo-item" data-limbo-item="${limboEscape(item.id)}">${face}${jump}${detail}</article>`;
}

function limboGrouped(items) {
  const groups = new Map(LIMBO_QUEUES.map(id => [id, []]));
  for (const item of items) groups.get(limboQueueId(item)).push(item);
  return groups;
}

function limboQueueSection(id, articles) {
  const copy = LIMBO_QUEUE_COPY[id];
  return `<section class="limbo-queue" data-limbo-queue="${id}" aria-label="${limboEscape(copy.title)}"><h3>${limboEscape(copy.title)}</h3><p class="limbo-queue-hint">${limboEscape(copy.hint)}</p>${articles}<span data-limbo-queue-end="${id}" hidden></span></section>`;
}

// Place a queue that this page has not shown yet. Later queues stay after earlier ones, even when a later page arrives first.
function limboInsertSection(html, id, block) {
  const index = LIMBO_QUEUES.indexOf(id);
  for (let later = index + 1; later < LIMBO_QUEUES.length; later++) {
    const token = `<section class="limbo-queue" data-limbo-queue="${LIMBO_QUEUES[later]}"`;
    const pos = html.indexOf(token);
    if (pos !== -1) return html.slice(0, pos) + block + html.slice(pos);
  }
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const marker = `<span data-limbo-queue-end="${LIMBO_QUEUES[earlier]}" hidden></span>`;
    const pos = html.indexOf(marker);
    if (pos !== -1) {
      const end = html.indexOf('</section>', pos);
      const cut = end + '</section>'.length;
      return html.slice(0, cut) + block + html.slice(cut);
    }
  }
  return html + block;
}

// Add rows to the queues already on screen. Each queue section exists at most once, in owner, automatic, unverified order.
function limboMergeHtml(html, items) {
  let next = String(html || '');
  const groups = limboGrouped(items);
  for (const id of LIMBO_QUEUES) {
    const list = groups.get(id);
    if (!list.length) continue;
    const articles = list.map(limboItemHtml).join('');
    const marker = `<span data-limbo-queue-end="${id}" hidden></span>`;
    if (next.includes(marker)) next = next.replace(marker, articles + marker);
    else next = limboInsertSection(next, id, limboQueueSection(id, articles));
  }
  return next;
}

function limboResultsHtml(items) {
  return limboMergeHtml('', items);
}

function limboAppendGrouped(results, items) {
  if (typeof results.querySelector !== 'function') {
    results.innerHTML = limboMergeHtml(results.innerHTML, items);
    return;
  }
  const groups = limboGrouped(items);
  for (const id of LIMBO_QUEUES) {
    const list = groups.get(id);
    if (!list.length) continue;
    const articles = list.map(limboItemHtml).join('');
    const section = results.querySelector(`[data-limbo-queue="${id}"]`);
    if (section) {
      const marker = typeof section.querySelector === 'function' ? section.querySelector(`[data-limbo-queue-end="${id}"]`) : null;
      if (marker && typeof marker.insertAdjacentHTML === 'function') marker.insertAdjacentHTML('beforebegin', articles);
      else if (typeof section.insertAdjacentHTML === 'function') section.insertAdjacentHTML('beforeend', articles);
      continue;
    }
    const block = limboQueueSection(id, articles);
    let anchor = null;
    const index = LIMBO_QUEUES.indexOf(id);
    for (let later = index + 1; later < LIMBO_QUEUES.length && !anchor; later++) anchor = results.querySelector(`[data-limbo-queue="${LIMBO_QUEUES[later]}"]`);
    if (anchor && typeof anchor.insertAdjacentHTML === 'function') anchor.insertAdjacentHTML('beforebegin', block);
    else results.insertAdjacentHTML('beforeend', block);
  }
}

function limboQueueNotice(view, state) {
  if (!state || state.kind === 'film') return '';
  const observations = view.coverage && view.coverage.observations;
  if (!observations || !limboObservationGap(observations)) return '';
  return limboObservationText(observations, view.coverage.observationsObserved);
}

// A film item of the fingerprint or prediction subsystem with a stored id can be explained by the recovery assessment.
function limboRecoveryFilm(item) {
  if (item.kind !== 'film' || !LIMBO_RECOVERY_SUBSYSTEMS.includes(item.subsystem)) return null;
  const storedId = item.film?.storedId;
  return typeof storedId === 'string' && LIMBO_RECOVERY_FILM_ID.test(storedId) ? storedId : null;
}

function limboRecoveryLoad(slot) {
  const entry = limboRecovery.get(slot);
  const panel = document.querySelector(`[data-limbo-recovery-slot="${slot}"]`);
  if (!entry || !panel) return Promise.resolve(null);
  const seq = ++entry.seq;
  panel.innerHTML = '<p class="admin-state" role="status" aria-busy="true">Читаем состояние прогноза…</p>';
  const pending = loadPredictionRecovery(entry.filmId, {pin: entry.pin}).then(result => {
    if (seq !== entry.seq || result.mode === 'aborted') return result;
    if (result.mode === 'error') {
      panel.innerHTML = recoveryErrorHtml(result.error);
      return result;
    }
    entry.pin = result.answer && typeof result.answer.pin === 'string' ? result.answer.pin : null;
    panel.innerHTML = recoveryPanelHtml(result.answer, {changed: result.changed});
    return result;
  });
  limboLive.pending = pending;
  return pending;
}

function onLimboRecoveryToggle(slot) {
  const entry = limboRecovery.get(slot);
  const panel = document.querySelector(`[data-limbo-recovery-slot="${slot}"]`);
  const button = document.querySelector(`[data-limbo-recovery="${slot}"]`);
  if (!entry || !panel) return Promise.resolve(null);
  entry.open = !entry.open;
  panel.hidden = !entry.open;
  if (button) {
    button.setAttribute('aria-expanded', entry.open ? 'true' : 'false');
    button.textContent = entry.open ? 'Скрыть разбор' : 'Разобрать прогноз';
  }
  return entry.open ? limboRecoveryLoad(slot) : Promise.resolve(null);
}

// An observation item can be explained by the discovery recovery assessment when it carries a well-formed key.
function limboRecoveryObservation(item) {
  if (item.kind !== 'observation') return null;
  const key = item.observation?.key ?? item.subjectId;
  return typeof key === 'string' && key.length >= 1 && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}

function obsPanel(slot) {
  return document.querySelector(`[data-obs-recovery-slot="${slot}"]`);
}

function obsRender(slot, focus) {
  const entry = obsRecovery.get(slot);
  const panel = obsPanel(slot);
  if (!entry || !panel) return;
  panel.innerHTML = entry.answer ? obsRecoveryPanelHtml(entry.answer, {...entry, slot}) : obsRecoveryErrorHtml(entry.error || 'network');
  const target = focus ? panel.querySelector(focus) : null;
  if (target && typeof target.focus === 'function') target.focus();
}

// Reads the observation again. `keep` preserves the receipt and the last error so the owner reads the outcome beside the
// fresh state; 'confirmation' clears them but keeps an unexpired server-issued confirmation, so a refusal for a busy
// resolver can be retried once it is free; anything else starts the action over from the checkbox.
function obsRecoveryLoad(slot, keep = false) {
  const entry = obsRecovery.get(slot);
  const panel = obsPanel(slot);
  if (!entry || !panel) return Promise.resolve(null);
  const seq = ++entry.seq;
  if (keep !== true) {
    const held = keep === 'confirmation' && entry.confirmation && Date.parse(entry.confirmation.expiresAt) > Date.now() ? entry.confirmation : null;
    const identityHeld = keep === 'confirmation' && entry.identityConfirmation && Date.parse(entry.identityConfirmation.expiresAt) > Date.now() ? entry.identityConfirmation : null;
    Object.assign(entry, {accepted: false, confirmation: held, receipt: null, durable: null, index: null, error: null, identityAccepted: false, identityConfirmation: identityHeld, identityReceipt: null, identityIndex: null, identityReason: null});
  }
  panel.setAttribute('aria-busy', 'true');
  if (!entry.answer) panel.innerHTML = '<p class="admin-state" role="status" aria-busy="true">Читаем состояние наблюдения…</p>';
  const pending = loadDiscoveryRecovery(entry.key, {pin: entry.pin}).then(result => {
    if (seq !== entry.seq || result.mode === 'aborted') return result;
    panel.removeAttribute('aria-busy');
    if (result.mode === 'error') {
      entry.answer = null;
      entry.pin = null;
      panel.innerHTML = obsRecoveryErrorHtml(result.error);
      return result;
    }
    entry.answer = result.answer;
    entry.changed = result.changed;
    entry.pin = result.answer && typeof result.answer.pin === 'string' ? result.answer.pin : null;
    obsRender(slot);
    return result;
  });
  limboLive.pending = pending;
  return pending;
}

function onObsRecoveryToggle(slot) {
  const entry = obsRecovery.get(slot);
  const panel = obsPanel(slot);
  const button = document.querySelector(`[data-obs-recovery="${slot}"]`);
  if (!entry || !panel) return Promise.resolve(null);
  entry.open = !entry.open;
  panel.hidden = !entry.open;
  if (button) {
    button.setAttribute('aria-expanded', entry.open ? 'true' : 'false');
    button.textContent = entry.open ? 'Скрыть разбор' : 'Разобрать наблюдение';
  }
  return entry.open ? obsRecoveryLoad(slot) : Promise.resolve(null);
}

// The checkbox only enables «Подтвердить»; the panel is not redrawn, so focus stays on the checkbox.
function onObsRecoveryAccept(slot, checked) {
  const entry = obsRecovery.get(slot);
  const panel = obsPanel(slot);
  if (!entry || !panel) return;
  entry.accepted = checked === true;
  const confirm = panel.querySelector('[data-obs-recovery-confirm]');
  if (confirm) confirm.disabled = !entry.accepted || entry.busy;
}

function onObsRecoveryConfirm(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || !entry.accepted || entry.busy || !entry.pin) return Promise.resolve(null);
  entry.busy = true;
  entry.error = null;
  obsRender(slot);
  const pending = confirmDiscoveryReconsider(entry.key, entry.pin).then(result => {
    entry.busy = false;
    if (result.ok && result.body && result.body.confirmation) {
      entry.confirmation = result.body.confirmation;
      obsRender(slot, '[data-obs-recovery-execute]');
      return result;
    }
    entry.error = result.error;
    entry.accepted = false;
    if (result.error === 'stale_pin' || result.error === 'not_eligible') return obsRecoveryLoad(slot, true).then(() => result);
    obsRender(slot, '[role="alert"]');
    return result;
  });
  limboLive.pending = pending;
  return pending;
}

// The execution is sent once. Whatever comes back — a receipt, a refusal or no answer — the observation is read again,
// and the outcome stays on screen beside it.
function onObsRecoveryExecute(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || !entry.confirmation || entry.busy) return Promise.resolve(null);
  entry.busy = true;
  entry.error = null;
  obsRender(slot);
  const pending = executeDiscoveryReconsider(entry.confirmation).then(result => {
    entry.busy = false;
    const body = result.body || {};
    if (body.receipt) {
      entry.receipt = body.receipt;
      entry.durable = typeof body.durable === 'boolean' ? body.durable : null;
      entry.index = body.index ?? null;
      entry.confirmation = null;
    } else {
      entry.error = result.error;
      if (result.error !== 'lease_held' && result.error !== 'lease_unknown') entry.confirmation = null;
    }
    entry.accepted = false;
    return obsRecoveryLoad(slot, true).then(() => {
      const panel = obsPanel(slot);
      const target = panel ? panel.querySelector('.obs-receipt, [role="alert"]') : null;
      if (target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
      }
      return result;
    });
  });
  limboLive.pending = pending;
  return pending;
}

function onObsIdentityEdit(slot, event) {
  const entry = obsRecovery.get(slot);
  const panel = obsPanel(slot);
  if (!entry || !panel || entry.identityConfirmation || entry.identityBusy) return;
  const target = event && event.target;
  const attr = target && target.getAttribute ? name => target.getAttribute(name) : () => null;
  if (attr('data-obs-identity-effect') !== null && target.checked) entry.identityEffect = target.value;
  if (attr('data-obs-identity-choice') !== null && target.checked) entry.identityTarget = target.value;
  if (attr('data-obs-identity-id') !== null) entry.identityTarget = target.value;
  if (attr('data-obs-identity-basis') !== null) entry.identityBasis = target.value;
  if (attr('data-obs-identity-accept') !== null) entry.identityAccepted = target.checked === true;
  entry.identityReason = null;
  const hint = obsIdentityBlocked(entry.answer, entry);
  const previewText = obsIdentityPreviewText(entry.answer, entry);
  const preview = panel.querySelector('[data-obs-identity-preview]');
  if (preview) {
    preview.textContent = previewText;
    preview.hidden = !previewText;
  }
  const note = panel.querySelector('[data-obs-identity-hint]');
  if (note) note.textContent = hint;
  const confirm = panel.querySelector('[data-obs-identity-confirm]');
  const basisText = entry.identityBasis.trim();
  if (confirm) confirm.disabled = !entry.identityEffect || !/^[1-9]\d{0,11}$/.test(entry.identityTarget.trim()) || !basisText || basisText.length > 200 || !!hint || !entry.identityAccepted;
}

function onObsIdentityConfirm(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || entry.identityBusy || entry.identityConfirmation || !entry.pin) return Promise.resolve(null);
  const hint = obsIdentityBlocked(entry.answer, entry);
  if (hint || !entry.identityAccepted || !entry.identityEffect) return Promise.resolve(null);
  entry.identityBusy = true;
  entry.identityReason = null;
  obsRender(slot);
  const pending = confirmDiscoveryIdentity({key: entry.key, pin: entry.pin, effect: entry.identityEffect, tmdbId: entry.identityTarget.trim(), basis: entry.identityBasis.trim()}).then(result => {
    entry.identityBusy = false;
    if (result.ok && result.body && result.body.confirmation) {
      entry.identityConfirmation = result.body.confirmation;
      entry.identityPlan = result.body.plan || null;
      entry.identityApplication = result.body.application || null;
      entry.identityReason = null;
      obsRender(slot, '[data-obs-identity-execute]');
      return result;
    }
    entry.identityReason = result.body && typeof result.body.reason === 'string' ? result.body.reason : result.error;
    entry.identityAccepted = false;
    if (result.error === 'stale_pin') return obsRecoveryLoad(slot, true).then(() => result);
    obsRender(slot, '[data-obs-identity-hint]');
    return result;
  });
  limboLive.pending = pending;
  return pending;
}

function onObsIdentityExecute(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || !entry.identityConfirmation || entry.identityBusy) return Promise.resolve(null);
  entry.identityBusy = true;
  entry.identityReason = null;
  obsRender(slot);
  const pending = executeDiscoveryIdentity(entry.identityConfirmation).then(result => {
    entry.identityBusy = false;
    const body = result.body || {};
    const expiredCommitted = body.decisionReadBack && !body.receipt && (body.refusal === 'confirmation_expired' || result.error === 'confirmation_expired');
    if (expiredCommitted) {
      entry.identityReceipt = {state: 'expired_committed', refusal: 'confirmation_expired'};
      entry.identityDurable = false;
      entry.identityApplication = body.application || entry.identityApplication;
      entry.identityIndex = body.index ?? null;
      entry.identityReason = null;
      entry.identityConfirmation = null;
      entry.identityPlan = null;
    } else if (body.decisionReadBack && !body.receipt) {
      entry.identityReceipt = {state: 'unstored'};
      entry.identityDurable = false;
      entry.identityApplication = body.application || entry.identityApplication;
      entry.identityIndex = body.index ?? null;
      entry.identityReason = null;
    } else if (body.receipt && body.receipt.state === 'succeeded' && body.durable === false) {
      entry.identityReceipt = {state: 'unstored'};
      entry.identityDurable = false;
      entry.identityApplication = body.application || entry.identityApplication;
      entry.identityIndex = body.index ?? null;
      entry.identityReason = null;
    } else if (body.receipt) {
      entry.identityReceipt = body.receipt;
      entry.identityDurable = body.receipt.state !== 'succeeded' || body.durable !== false;
      entry.identityApplication = body.application || entry.identityApplication;
      entry.identityIndex = body.index ?? null;
      entry.identityReason = body.reason || null;
      entry.identityConfirmation = null;
      entry.identityPlan = null;
    } else {
      entry.identityReason = body.reason || result.error;
      if (result.error !== 'lease_held' && result.error !== 'lease_unknown') entry.identityConfirmation = null;
    }
    entry.identityAccepted = false;
    return obsRecoveryLoad(slot, true).then(() => {
      const panel = obsPanel(slot);
      const target = panel ? panel.querySelector('.obs-identity-receipt, [data-obs-identity-hint]') : null;
      if (target && typeof target.focus === 'function') target.focus();
      return result;
    });
  });
  limboLive.pending = pending;
  return pending;
}

function onObsIdentityCancel(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || entry.identityBusy) return;
  Object.assign(entry, {identityAccepted: false, identityConfirmation: null, identityPlan: null, identityReason: null});
  obsRender(slot, '[data-obs-identity-accept]');
}

function onObsRecoveryCancel(slot) {
  const entry = obsRecovery.get(slot);
  if (!entry || entry.busy) return;
  Object.assign(entry, {accepted: false, confirmation: null, error: null});
  obsRender(slot, '[data-obs-recovery-accept]');
}

const LIMBO_OBSERVATION_UNAVAILABLE = {
  index_missing: 'индекса наблюдений для опубликованного поколения ещё нет: его записывает первый обычный чанк резолвера в этом поколении',
  index_other_generation: 'индекс наблюдений записан для другого поколения программы',
  index_malformed: 'индекс наблюдений не распознан',
  index_torn: 'индекс наблюдений записан не до конца',
  index_unavailable: 'нет опубликованного поколения или индекс не прочитан',
};

// Unresolved observations come only from the generation's bounded index: unavailable means unknown, never none, and the
// index itself never covers observations that have not had a first lookup.
function limboObservationText(observations, observed) {
  if (observations.available === false) return `<p class="limbo-unavailable">Нерешённые наблюдения EPG недоступны: ${limboEscape(LIMBO_OBSERVATION_UNAVAILABLE[observations.reason] || 'индекс наблюдений не прочитан')}. Их отсутствие в списке ничего не говорит об их состоянии.</p>`;
  const omitted = observations.omitted || {};
  const cut = (omitted.cap || 0) + (omitted.oversized || 0) + (omitted.malformed || 0);
  const parts = [`Наблюдения: частичное покрытие — в индексе ${observations.indexed ?? '—'} нерешённых наблюдений с решением резолвера, прочитано ${observed ?? '—'}`];
  if (cut) parts.push(`не вошло в индекс по его пределам: ${cut}`);
  if (typeof observations.awaitingFirstLookup === 'number') parts.push(`ждут первой проверки и в индекс не входят: ${observations.awaitingFirstLookup}`);
  parts.push('индекс записан ' + limboDate(observations.writtenAt));
  let text = '<p>' + limboEscape(parts.join(' · ')) + '.</p>';
  if (observations.state === 'stale') text += '<p class="limbo-unavailable">Индекс наблюдений устарел: карта решений или реестр наблюдений изменились после его записи. Показано состояние на момент записи; его обновит следующий обычный чанк.</p>';
  return text;
}

function limboContextHtml(view) {
  const parts = [];
  const coverage = view.coverage || {};
  parts.push(`<p>Фильмы: ${coverage.films === 'complete' ? 'полное покрытие' : 'частичное покрытие'} — прочитано записей: ${coverage.filmsObserved ?? '—'}. Запись вне списка не считается здоровой: о ней просто ничего не известно.</p>`);
  const observations = coverage.observations;
  if (observations) parts.push(limboObservationText(observations, coverage.observationsObserved));
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
  limboClearFocus();
  if (!showResults) {
    empty.hidden = true;
    results.innerHTML = '';
    total.textContent = '';
    return;
  }
  total.textContent = view.total ? String(view.total) : '';
  empty.hidden = view.items.length > 0;
  limboRecovery.clear();
  obsRecovery.clear();
  limboSelect.clear();
  if (!view.items.length) {
    limboLive.selected = null;
    results.innerHTML = '';
    empty.innerHTML = limboEmptyHtml(view, state);
  } else {
    if (!view.items.some(item => item.id === limboLive.selected)) limboLive.selected = view.items[0].id;
    results.innerHTML = limboQueueNotice(view, state) + limboResultsHtml(view.items) + (view.nextCursor ? '<button type="button" class="admin-more" data-limbo-more="items">Показать ещё</button>' : '');
    limboPlaceDetail();
  }
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
    limboAppendGrouped(results, page.items);
    if (page.nextCursor) results.insertAdjacentHTML('beforeend', '<button type="button" class="admin-more" data-limbo-more="items">Показать ещё</button>');
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

function onVerifiedOpen() {
  const input = document.querySelector('#verified-key');
  const hint = document.querySelector('#verified-open-hint');
  const panel = document.querySelector('#verified-panel');
  const raw = String(input && input.value || '').trim();
  if (!raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) {
    if (hint) hint.textContent = 'Нужен ключ наблюдения, без управляющих знаков.';
    if (input && typeof input.focus === 'function') input.focus();
    return Promise.resolve(null);
  }
  if (hint) hint.textContent = '';
  let entry = obsRecovery.get('verified');
  if (!entry || entry.key !== raw) {
    entry = {key: raw, open: true, pin: null, seq: 0, answer: null, changed: false, accepted: false, confirmation: null, receipt: null, durable: null, index: null, busy: false, error: null, identityEffect: '', identityTarget: '', identityBasis: '', identityAccepted: false, identityConfirmation: null, identityPlan: null, identityApplication: null, identityReceipt: null, identityIndex: null, identityReason: null, identityBusy: false, identityDurable: null};
    obsRecovery.set('verified', entry);
  }
  entry.open = true;
  if (panel) panel.hidden = false;
  return obsRecoveryLoad('verified');
}

function limboUseFocusColumn() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width:801px)').matches;
}

function limboFocusTitle(text) {
  const node = document.querySelector('#limbo-focus-title');
  if (node) node.textContent = text ? String(text) : 'Выбранная запись';
}

function limboClearFocus() {
  const focus = document.querySelector('#limbo-focus-body');
  if (!focus) return;
  if (typeof focus.replaceChildren === 'function') focus.replaceChildren();
  else focus.innerHTML = '';
  const empty = document.querySelector('#limbo-focus-empty');
  if (empty) empty.hidden = false;
  limboFocusTitle('');
}

function limboDetailNode(button) {
  const id = button && button.getAttribute ? button.getAttribute('aria-controls') : '';
  if (!id || typeof document.getElementById !== 'function') return null;
  return document.getElementById(id);
}

function limboRestoreDetail(detail) {
  if (!detail || !detail.id) return;
  const token = detail.id.startsWith('limbo-detail-') ? detail.id.slice('limbo-detail-'.length) : '';
  const results = document.querySelector('#limbo-results');
  const button = token && results && typeof results.querySelector === 'function' ? results.querySelector(`[data-limbo-select="${token}"]`) : null;
  const article = button && button.closest ? button.closest('article') : null;
  if (article && detail.parentElement !== article) article.appendChild(detail);
}

// On a wide screen the selected explanation is the column beside the queue. The markup stays the record's own detail,
// so the guarded recovery controls keep their handlers. A narrow screen leaves it under the selected row.
function limboPlaceDetail() {
  const focus = document.querySelector('#limbo-focus-body');
  const results = document.querySelector('#limbo-results');
  if (!focus || !results || typeof results.querySelector !== 'function' || typeof document.getElementById !== 'function') return;
  const empty = document.querySelector('#limbo-focus-empty');
  if (!limboUseFocusColumn()) {
    for (const detail of [...focus.querySelectorAll('.limbo-detail')]) limboRestoreDetail(detail);
    if (empty) empty.hidden = false;
    limboFocusTitle('');
    return;
  }
  const selected = results.querySelector('.limbo-select[aria-expanded="true"]');
  const detail = limboDetailNode(selected);
  for (const extra of [...focus.querySelectorAll('.limbo-detail')]) if (extra !== detail) limboRestoreDetail(extra);
  if (!detail) {
    if (empty) empty.hidden = false;
    limboFocusTitle('');
    return;
  }
  detail.hidden = false;
  if (detail.parentElement !== focus) focus.appendChild(detail);
  if (empty) empty.hidden = true;
  limboFocusTitle(detail.getAttribute('data-limbo-title') || '');
}

function onLimboSelect(token) {
  const id = limboSelect.get(token) || token;
  if (!id || id === limboLive.selected) return;
  limboLive.selected = id;
  const results = document.querySelector('#limbo-results');
  if (!results || typeof results.querySelectorAll !== 'function') return;
  for (const article of results.querySelectorAll('[data-limbo-item]')) {
    const current = article.getAttribute('data-limbo-item') === id;
    const button = typeof article.querySelector === 'function' ? article.querySelector('[data-limbo-select]') : null;
    if (button) button.setAttribute('aria-expanded', current ? 'true' : 'false');
    const jump = typeof article.querySelector === 'function' ? article.querySelector('[data-limbo-jump]') : null;
    if (jump) jump.hidden = !current;
    const detail = (typeof article.querySelector === 'function' && article.querySelector('.limbo-detail')) || limboDetailNode(button);
    if (detail) detail.hidden = !current;
  }
  limboPlaceDetail();
}

function onLimboJump(token) {
  const results = document.querySelector('#limbo-results');
  const button = results && typeof results.querySelector === 'function' ? results.querySelector(`[data-limbo-select="${token}"]`) : null;
  const detail = limboDetailNode(button);
  const heading = detail && typeof detail.querySelector === 'function' ? detail.querySelector('.limbo-detail-title') : null;
  if (heading && typeof heading.focus === 'function') heading.focus();
}

function onLimboSelectKey(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const target = event.target;
  const select = target && target.closest ? target.closest('[data-limbo-select]') : null;
  if (!select || target !== select) return;
  const results = document.querySelector('#limbo-results');
  if (!results || typeof results.querySelectorAll !== 'function') return;
  const buttons = [...results.querySelectorAll('[data-limbo-select]')];
  if (!buttons.length) return;
  const current = buttons.findIndex(button => button === document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, current < 0 ? 0 : current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
  if (next === current) return;
  event.preventDefault();
  buttons[next].focus();
  onLimboSelect(buttons[next].getAttribute('data-limbo-select'));
}

function onLimboResult(event) {
  const closest = selector => event.target.closest ? event.target.closest(selector) : null;
  const open = closest('[data-limbo-recovery]');
  if (open) {
    event.preventDefault();
    return onLimboRecoveryToggle(open.getAttribute('data-limbo-recovery'));
  }
  const obsOpen = closest('[data-obs-recovery]');
  if (obsOpen) {
    event.preventDefault();
    return onObsRecoveryToggle(obsOpen.getAttribute('data-obs-recovery'));
  }
  const obsSlot = closest('[data-obs-recovery-slot]');
  if (obsSlot) {
    const slot = obsSlot.getAttribute('data-obs-recovery-slot');
    if (closest('[data-obs-recovery-recheck]')) {
      event.preventDefault();
      return obsRecoveryLoad(slot, 'confirmation');
    }
    if (closest('[data-obs-recovery-confirm]')) {
      event.preventDefault();
      return onObsRecoveryConfirm(slot);
    }
    if (closest('[data-obs-recovery-execute]')) {
      event.preventDefault();
      return onObsRecoveryExecute(slot);
    }
    if (closest('[data-obs-recovery-cancel]')) {
      event.preventDefault();
      return onObsRecoveryCancel(slot);
    }
    if (closest('[data-obs-identity-confirm]')) {
      event.preventDefault();
      return onObsIdentityConfirm(slot);
    }
    if (closest('[data-obs-identity-execute]')) {
      event.preventDefault();
      return onObsIdentityExecute(slot);
    }
    if (closest('[data-obs-identity-cancel]')) {
      event.preventDefault();
      return onObsIdentityCancel(slot);
    }
    return;
  }
  if (closest('[data-limbo-recovery-recheck]')) {
    const panel = closest('[data-limbo-recovery-slot]');
    event.preventDefault();
    return panel ? limboRecoveryLoad(panel.getAttribute('data-limbo-recovery-slot')) : null;
  }
  const more = closest('[data-limbo-more]');
  if (more) {
    event.preventDefault();
    onLimboMore();
    return;
  }
  const jump = closest('[data-limbo-jump]');
  if (jump) {
    event.preventDefault();
    onLimboJump(jump.getAttribute('data-limbo-jump'));
    return;
  }
  const select = closest('[data-limbo-select]');
  if (!select) return;
  event.preventDefault();
  onLimboSelect(select.getAttribute('data-limbo-select'));
}

function onLimboResultChange(event) {
  const identity = event.target.closest ? event.target.closest('[data-obs-identity-effect],[data-obs-identity-choice],[data-obs-identity-id],[data-obs-identity-basis],[data-obs-identity-accept]') : null;
  const identityPanel = identity && identity.closest ? identity.closest('[data-obs-recovery-slot]') : null;
  if (identityPanel) onObsIdentityEdit(identityPanel.getAttribute('data-obs-recovery-slot'), event);
  const accept = event.target.closest ? event.target.closest('[data-obs-recovery-accept]') : null;
  const panel = accept && accept.closest ? accept.closest('[data-obs-recovery-slot]') : null;
  if (panel) onObsRecoveryAccept(panel.getAttribute('data-obs-recovery-slot'), accept.checked);
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
  document.querySelector('#limbo-results').addEventListener('keydown', onLimboSelectKey);
  document.querySelector('#limbo-results').addEventListener('change', onLimboResultChange);
  document.querySelector('#limbo-results').addEventListener('input', onLimboResultChange);
  const focusBody = document.querySelector('#limbo-focus-body');
  if (focusBody && focusBody.addEventListener) {
    focusBody.addEventListener('click', onLimboResult);
    focusBody.addEventListener('change', onLimboResultChange);
    focusBody.addEventListener('input', onLimboResultChange);
  }
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(min-width:801px)');
    if (typeof media.addEventListener === 'function') media.addEventListener('change', () => limboPlaceDetail());
  }
  document.querySelector('#verified-open').addEventListener('click', onVerifiedOpen);
  document.querySelector('#verified-key').addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault(); onVerifiedOpen();}});
  const verifiedPanel = document.querySelector('#verified-panel');
  verifiedPanel.addEventListener('click', onLimboResult);
  verifiedPanel.addEventListener('change', onLimboResultChange);
  verifiedPanel.addEventListener('input', onLimboResultChange);
  document.querySelector('#limbo-refresh').addEventListener('click', onLimboRefresh);
  window.addEventListener('keydown', onLimboKey);
  window.addEventListener('popstate', onLimboHistory);
  limboWrite(limboState(), 'replace');
  limboRender();
}

startLimbo();
