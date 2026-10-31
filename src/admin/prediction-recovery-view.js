// The owner-facing explanation of one film's prediction recovery assessment (GET /api/admin/prediction-recovery). Pure: it
// turns the typed answer into Russian HTML from closed copy tables and decides nothing. A status, cause, reason or next
// step without declared copy makes the whole explanation unavailable rather than guessed. Codes, ids and the pin appear
// only inside the closed «Технические подробности». There is no action control: the assessment offers none.

export const RECOVERY_STATUS_COPY = {
  no_action: 'Ничего делать не нужно',
  wait: 'Ждать: система сделает это сама',
  investigate: 'Нужен разбор',
  blocked: 'Оценить нельзя: данные расходятся',
  unknown: 'Неизвестно',
};

export const RECOVERY_CAUSE_COPY = {
  prediction_current: {title: 'Прогноз актуален', what: 'Прогноз посчитан для текущего профиля вкуса и пригодного отпечатка. Фильма нет в очереди, и это правильно.', why: 'Пересчитывать нечего.'},
  queued_ready: {title: 'Фильм в очереди и готов к обработке', what: 'Прогноз нужно посчитать, фильм стоит в очереди, и ничто его не задерживает.', why: 'Фильм уже готов к обработке: повторная постановка в очередь ничего не ускорит.'},
  ready_no_runs: {title: 'Фильм готов, но запусков давно не было', what: 'Фильм стоит в очереди и готов к обработке, но очередь не проверялась больше суток.', why: 'Обработку запускает только запуск прогнозов по расписанию. Запись одного фильма его не запустит: причина не в этом фильме.'},
  waiting_behind_hot: {title: 'Фильм ждёт, пока обработаются фильмы из окна эфира', what: 'Фильм в холодной очереди. Холодная очередь обрабатывается только после того, как в горячей не осталось работы.', why: 'Это правило приоритета; обходить его вручную не предусмотрено.'},
  retry_backoff: {title: 'Прошлая попытка не удалась, следующая уже назначена', what: 'Предыдущая попытка посчитать прогноз завершилась ошибкой. Система сама повторит её, но не раньше назначенного времени.', why: 'Время повтора — правило защиты от повторяющихся сбоев; вручную оно не обходится.'},
  repeated_failures: {title: 'Попытки повторяются и не удаются', what: 'Прогноз для фильма не удаётся посчитать уже несколько раз подряд.', why: null},
  in_flight: {title: 'Фильм обрабатывается прямо сейчас', what: 'Текущий запуск прогнозов взял этот фильм и ещё не сохранил результат.', why: 'Вмешиваться в идущий запуск нельзя.'},
  run_active: {title: 'Идёт запуск прогнозов', what: 'Фильм в очереди и готов. Его возьмёт текущий запуск или следующий.', why: 'Вмешиваться в идущий запуск нельзя.'},
  queue_refresh_pending: {title: 'Прогноз не актуален, а в очереди фильма пока нет', what: 'Очередь была собрана раньше, чем прогноз устарел. Она пересобирается при каждом запуске прогнозов, после обновления программы и после смены профиля вкуса, и фильм попадёт в неё сам.', why: 'Очередь каждый раз вычисляется заново из правил: ручная запись одного фильма будет перезаписана при следующей пересборке.'},
  index_ahead_of_queue: {title: 'Прогноз уже актуален, а очередь ещё числит фильм', what: 'Прогноз посчитан после того, как очередь была собрана. Следующая пересборка уберёт фильм из очереди, а запуск пропустит его как уже готовый.', why: 'Делать ничего не нужно.'},
  index_inconsistent: {title: 'Индекс просмотра и файлы фильма расходятся', what: 'Индекс, по которому строится очередь, говорит об актуальности прогноза иначе, чем сохранённые файлы фильма.', why: 'Это вопрос индекса, а не очереди прогнозов: повтор прогноза расхождение не устранит.'},
  not_in_catalog: {title: 'Фильма нет ни в программе, ни в каталоге найденных фильмов', what: 'Прогноз считается только для фильмов из опубликованной программы или каталога найденных фильмов.', why: 'Сначала нужна подтверждённая идентичность фильма; это другая подсистема.'},
  profile_missing: {title: 'Профиль вкуса не прочитан', what: 'Без профиля вкуса нельзя сказать, актуален ли прогноз.', why: 'Без полных данных действие не предлагается.'},
  snapshot_partial: {title: 'Источники расходятся между собой', what: 'Очередь, программа, профиль или индекс прочитаны в несогласованном состоянии, например очередь собрана для другого поколения программы или другого профиля.', why: 'Без согласованных данных действие не предлагается. Обычно расхождение исчезает после следующей пересборки очереди.'},
  film_unreadable: {title: 'Данные фильма не прочитаны', what: 'Отпечаток и прогноз фильма прочитать не удалось.', why: 'Без данных действие не предлагается.'},
  queue_unavailable: {title: 'Очередь прогнозов не прочитана', what: 'Очередь прогнозов в хранилище не найдена или не прочитана.', why: 'Без очереди нельзя сказать, что произойдёт с фильмом.'},
  queue_state_unknown: {title: 'Состояние фильма в очереди непонятно', what: 'Фильм записан в очереди так, что нельзя определить, готов ли он к обработке.', why: 'Без ясного состояния действие не предлагается.'},
};

// Why repeated failures are not fixed by a queue write depends on what failed; the answer's reason says which.
export const RECOVERY_REPEATED_WHY = {
  caller_contract: 'Сбой в ответе модели: тот же запрос даст ту же ошибку. Исправлять нужно то, что модель возвращает (контракт отпечатка и прогноза), а не очередь.',
  system_failure: 'Сбой на стороне инфраструктуры: хранилище, квота, время запуска, доступность модели или право запуска на работу. Ответ модели здесь ни при чём. Нужно проверить эту причину; система сама повторит попытку в назначенное время.',
  failure_unclassified: 'Вид сбоя не распознан, поэтому нельзя сказать, где причина. Посмотрите классификацию в технических подробностях и историю запусков. Повторная постановка в очередь причину не устранит.',
};

export const RECOVERY_ACTION_REASON_COPY = {
  not_needed: 'действие не нужно',
  ordinary_schedule: 'фильм обработает обычный запуск по расписанию',
  backoff_respected: 'время повтора не обходится',
  queue_derived: 'очередь пересобирается из правил целиком',
  caller_contract: 'нужно исправить ответ модели, а не очередь',
  system_failure: 'нужно устранить сбой инфраструктуры, а не очередь',
  failure_unclassified: 'вид сбоя не распознан',
  other_subsystem: 'причина в другой подсистеме',
  evidence_incomplete: 'данных недостаточно',
};

export const RECOVERY_PREREQUISITE_COPY = {
  taste_profile: 'профиль вкуса',
  prediction_queue: 'очередь прогнозов',
  catalog_membership: 'фильм в опубликованной программе или в каталоге найденных фильмов (подтверждённая идентичность)',
  film_state: 'данные фильма в хранилище',
};

export const RECOVERY_EVIDENCE_COPY = {
  runner_lease: 'состояние текущего запуска',
  latest_run: 'последний запуск',
  queue_activity: 'время последней проверки очереди',
  catalog: 'каталог найденных фильмов',
};

const RECOVERY_CLASSIFICATION_COPY = {
  parse_error: 'ответ модели не удалось разобрать',
  validation_error: 'ответ модели не прошёл проверку схемы',
  storage_error: 'ошибка хранилища',
  quota: 'исчерпана квота модели',
  time_budget: 'не хватило времени запуска',
  model_error: 'ошибка модели',
  model_unavailable: 'модель недоступна',
  api_error: 'ошибка API модели',
  lease_lost: 'запуск потерял право на работу',
  lease_expired: 'запуск прервался',
  format_error_storm: 'серия ошибок формата',
  profile_changed: 'сменился профиль вкуса',
  external_termination: 'запуск остановлен извне',
};
const RECOVERY_VALIDATION_COPY = {
  caller_reported: 'вызывающая сторона не смогла разобрать ответ модели',
  fingerprint_schema: 'отпечаток нарушает контракт',
  fingerprint_missing: 'в ответе нет отпечатка',
  prediction_schema: 'прогноз нарушает контракт',
};
const RECOVERY_LANE_COPY = {hot: 'горячая очередь (фильм в окне эфира)', cold: 'холодная очередь', pending: 'очередь', none: 'не в очереди', unknown: 'неизвестно'};
const RECOVERY_INDEX_COPY = {agreed: 'согласован с файлами фильма', inconsistent: 'расходится с файлами фильма', not_recorded: 'записи о фильме нет', unknown: 'неизвестно'};
const RECOVERY_WORK_COPY = {prediction_only: 'только прогноз; отпечаток переиспользуется', fingerprint_and_prediction: 'отпечаток и прогноз'};

function recoveryEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

export function recoveryDate(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function recoveryNextText(next) {
  const at = recoveryDate(next?.at);
  switch (next?.kind) {
    case 'none': return 'Ничего не произойдёт, пока не сменится профиль вкуса или отпечаток фильма.';
    case 'scheduled_run': return 'Фильм возьмёт ближайший запуск прогнозов по расписанию' + (at ? ' (по расписанию около ' + at + '; это оценка, а не обещание)' : '') + '.';
    case 'check_scheduled_tasks': return 'Проверьте, что Scheduled Task прогнозов включён и выполняется, и посмотрите историю его запусков.';
    case 'retry_at': return at ? 'Система повторит попытку сама, не раньше ' + at + '.' : 'Система повторит попытку сама; время повтора не записано.';
    case 'hot_drain': return 'Фильм будет обработан, когда в горячей очереди не останется работы.';
    case 'run_progress': return 'Дождитесь окончания текущего запуска и проверьте заново.';
    case 'queue_refresh': return 'Следующая пересборка очереди учтёт фильм; она происходит при запуске прогнозов, после обновления программы и после смены профиля вкуса.';
    case 'owner_investigation': return 'Нужен разбор причины владельцем' + (at ? '; следующая автоматическая попытка не раньше ' + at : '') + '.';
    case 'reread': return 'Проверьте заново позже: сейчас данных недостаточно для вывода.';
    default: return null;
  }
}

function recoveryPredictionText(prediction) {
  if (prediction.presence === 'not_recorded') return 'ещё не посчитан';
  if (prediction.presence === 'recorded_without_current') return 'нет текущей версии';
  if (prediction.presence !== 'recorded') return 'не прочитан';
  if (prediction.current === true) return prediction.cause === 'compatible' ? 'актуален: сохранён по правилу совместимости с прежней версией профиля или отпечатка' : 'актуален';
  if (prediction.cause === 'profile_changed') return 'устарел: сменился профиль вкуса';
  if (prediction.cause === 'fingerprint_not_current') return 'устарел: отпечаток фильма непригоден для текущих правил';
  if (prediction.cause === 'profile_not_recorded') return 'неизвестно: профиль вкуса не прочитан';
  return 'устарел';
}

function recoveryFingerprintText(fingerprint) {
  if (fingerprint.presence === 'not_recorded') return 'нет';
  if (fingerprint.presence !== 'recorded') return 'не прочитан';
  if (fingerprint.usable === true) return fingerprint.current === true ? 'есть, актуален' : 'есть, пригоден по правилу совместимости';
  if (fingerprint.usable === false) return 'есть, но непригоден для текущих правил';
  return 'есть, пригодность неизвестна';
}

function recoveryRetryText(retry) {
  if (retry.classification === 'not_recorded') return 'неудачных попыток не записано';
  const parts = [];
  if (retry.attempts !== null) parts.push('попыток: ' + retry.attempts);
  parts.push('последняя ошибка: ' + (RECOVERY_CLASSIFICATION_COPY[retry.classification] || 'другая причина (см. технические подробности)'));
  if (retry.validationStage) parts.push('проверка: ' + (RECOVERY_VALIDATION_COPY[retry.validationStage] || 'этап не распознан') + (retry.validationIssues ? ', замечаний: ' + retry.validationIssues : ''));
  const failed = recoveryDate(retry.failedAt);
  if (failed) parts.push('была ' + failed);
  const next = recoveryDate(retry.retryAt);
  if (next) parts.push('следующая не раньше ' + next);
  return parts.join(' · ');
}

function recoveryRunText(runner) {
  if (runner?.live === true) return 'идёт запуск прогнозов' + (recoveryDate(runner.leaseExpiresAt) ? ' (право на работу до ' + recoveryDate(runner.leaseExpiresAt) + ')' : '') + (runner.filmSelected === true ? '; фильм взят в работу' : '');
  if (runner?.live === false) return 'сейчас запуска нет';
  return 'состояние запуска неизвестно';
}

function recoveryDetails(answer) {
  const assessment = answer.assessment || {};
  const facts = assessment.facts || {};
  const rows = [
    ['film', assessment.filmId], ['status', assessment.status], ['cause', assessment.cause],
    ['targetedAction', (assessment.targetedAction?.available === true ? 'available' : 'unavailable') + ' / ' + (assessment.targetedAction?.reason ?? '—')],
    ['writer', assessment.writer?.exists === true ? 'exists' : 'none (' + (assessment.writer?.decision ?? '—') + ')'],
    ['nextExpected', (assessment.nextExpected?.kind ?? '—') + (assessment.nextExpected?.at ? ' ' + assessment.nextExpected.at : '')],
    ['work', assessment.work ?? '—'],
    ['fingerprint', [facts.fingerprint?.presence, facts.fingerprint?.reason, facts.fingerprint?.migration].filter(Boolean).join(' / ') || '—'],
    ['prediction', [facts.prediction?.presence, facts.prediction?.cause, facts.prediction?.reason].filter(Boolean).join(' / ') || '—'],
    ['queue', [facts.queue?.lane, facts.queue?.cause].filter(Boolean).join(' / ') || '—'],
    ['retry', [facts.retry?.classification, facts.retry?.scope, facts.retry?.validationStage].filter(Boolean).join(' / ') || '—'],
    ['index', facts.index ?? '—'],
    ['evidence', (assessment.evidence?.completeness ?? '—') + ((assessment.evidence?.missing || []).length ? ' (' + assessment.evidence.missing.join(', ') + ')' : '')],
    ['snapshot.reasons', (answer.snapshot?.reasons || []).join(', ') || '—'],
    ['queue.programmeRunId', answer.snapshot?.queue?.programmeRunId ?? '—'],
    ['run', assessment.runner?.runId ?? '—'],
    ['pin', answer.pin ?? '—'],
    ['sources', (answer.sources || []).join(', ') || '—'],
  ];
  return `<details class="recovery-tech"><summary>Технические подробности</summary><dl>${rows.map(([name, value]) => `<div><dt>${recoveryEscape(name)}</dt><dd>${recoveryEscape(value)}</dd></div>`).join('')}</dl></details>`;
}

// Whether every code of the answer has declared copy. Anything else is not explained.
export function recoveryExplainable(answer) {
  const assessment = answer?.assessment;
  if (!assessment || typeof assessment !== 'object') return false;
  if (!RECOVERY_STATUS_COPY[assessment.status] || !RECOVERY_CAUSE_COPY[assessment.cause]) return false;
  if (!RECOVERY_ACTION_REASON_COPY[assessment.targetedAction?.reason]) return false;
  if (recoveryNextText(assessment.nextExpected) === null) return false;
  if (assessment.cause === 'repeated_failures' ? !RECOVERY_REPEATED_WHY[assessment.targetedAction.reason] : !RECOVERY_CAUSE_COPY[assessment.cause].why) return false;
  if (assessment.targetedAction?.available !== false || assessment.writer?.exists !== false) return false;
  if (!Array.isArray(assessment.missingPrerequisites) || assessment.missingPrerequisites.some(code => !RECOVERY_PREREQUISITE_COPY[code])) return false;
  if (!Array.isArray(assessment.evidence?.missing) || assessment.evidence.missing.some(code => !RECOVERY_EVIDENCE_COPY[code])) return false;
  return true;
}

function recoveryTone(status) {
  return status === 'no_action' ? 'reviewed' : status === 'wait' ? 'reviewed' : status === 'investigate' ? 'provisional' : 'ambiguous';
}

// `options.changed` says the state differs from the previous check of the same film.
export function recoveryPanelHtml(answer, options = {}) {
  const changed = options.changed ? '<p class="recovery-changed" role="status">Состояние изменилось с прошлой проверки; ниже — свежий разбор.</p>' : '';
  const recheck = '<button type="button" class="admin-more recovery-recheck" data-limbo-recovery-recheck>Проверить заново</button>';
  if (!recoveryExplainable(answer)) {
    return `${changed}<p class="recovery-unexplained" role="alert">Невозможно достоверно объяснить состояние прогноза. Ничего не выполнялось; подробности ниже.</p>${answer && typeof answer === 'object' ? recoveryDetails(answer) : ''}<p class="recovery-controls">${recheck}</p>`;
  }
  const assessment = answer.assessment;
  const copy = RECOVERY_CAUSE_COPY[assessment.cause];
  const facts = assessment.facts;
  const checked = recoveryDate(answer.evaluatedAt);
  const queueAt = recoveryDate(answer.snapshot?.queue?.refreshedAt);
  const snapshotParts = [checked ? 'проверено ' + checked : null, queueAt ? 'очередь собрана ' + queueAt : null, answer.snapshot?.profile?.version != null ? 'профиль вкуса, версия ' + answer.snapshot.profile.version : null].filter(Boolean);
  const factRows = [
    ['прогноз', recoveryPredictionText(facts.prediction)],
    ['отпечаток', recoveryFingerprintText(facts.fingerprint)],
    ['нужная работа', assessment.work ? RECOVERY_WORK_COPY[assessment.work] || 'другая' : facts.prediction.current === true ? 'нет' : 'не определена'],
    ['очередь', RECOVERY_LANE_COPY[facts.queue.lane] || 'неизвестно'],
    ['неудачные попытки', recoveryRetryText(facts.retry)],
    ['индекс просмотра', RECOVERY_INDEX_COPY[facts.index] || 'неизвестно'],
    ['запуск', recoveryRunText(assessment.runner)],
  ];
  const missing = assessment.missingPrerequisites.length ? '<ul>' + assessment.missingPrerequisites.map(code => `<li>${recoveryEscape(RECOVERY_PREREQUISITE_COPY[code])}</li>`).join('') + '</ul>' : '<p>Ничего: все условия для прогноза есть.</p>';
  const evidence = assessment.evidence.missing.length ? `<p class="muted">Не удалось прочитать: ${recoveryEscape(assessment.evidence.missing.map(code => RECOVERY_EVIDENCE_COPY[code]).join(', '))}. Вывод сделан без этих данных.</p>` : '';
  return `${changed}<p class="recovery-headline"><span class="admin-status admin-status-${recoveryTone(assessment.status)}">${recoveryEscape(RECOVERY_STATUS_COPY[assessment.status])}</span> <b>${recoveryEscape(copy.title)}</b></p>`
    + `<h4>Что с прогнозом</h4><p>${recoveryEscape(copy.what)}</p>`
    + `<h4>Что будет дальше</h4><p>${recoveryEscape(recoveryNextText(assessment.nextExpected))}</p>`
    + `<h4>Почему здесь нет кнопки «повторить»</h4><p>${recoveryEscape(assessment.cause === 'repeated_failures' ? RECOVERY_REPEATED_WHY[assessment.targetedAction.reason] : copy.why)}</p><p class="muted">Точечного действия для прогноза одного фильма нет: очередь прогнозов каждый раз собирается заново из программы, каталога, индекса и профиля вкуса, а время повтора — правило защиты от сбоев. Эта панель только читает и ничего не запускает.</p>`
    + `<h4>Чего не хватает</h4>${missing}`
    + `<h4>Факты</h4><dl class="limbo-facts recovery-facts">${factRows.map(([name, value]) => `<div><dt>${recoveryEscape(name)}</dt><dd>${recoveryEscape(value)}</dd></div>`).join('')}</dl>${evidence}`
    + (snapshotParts.length ? `<p class="muted recovery-snapshot">${recoveryEscape(snapshotParts.join(' · '))}.</p>` : '')
    + recoveryDetails(answer)
    + `<p class="recovery-controls">${recheck}</p>`;
}

const RECOVERY_ERROR_COPY = {
  network: 'Нет ответа от сервера. Проверьте соединение и доступ и повторите.',
  storage_unavailable: 'Хранилище не ответило. Ничего не выполнялось.',
  invalid_film: 'Идентификатор фильма не распознан.',
  invalid_pin: 'Отметка прошлой проверки не распознана. Проверьте заново.',
  method_not_allowed: 'Разбор делает только чтение.',
};

export function recoveryErrorHtml(code) {
  const text = RECOVERY_ERROR_COPY[code] || (/^http_\d+$/.test(String(code)) ? 'Сервер ответил ошибкой ' + String(code).slice(5) + '. Разбор не получен.' : 'Разбор не получен.');
  return `<p class="recovery-error" role="alert">${recoveryEscape(text)}</p><p class="recovery-controls"><button type="button" class="admin-more recovery-recheck" data-limbo-recovery-recheck>Проверить заново</button></p>`;
}
