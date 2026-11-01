// The owner-facing explanation of one discovery observation (GET /api/admin/discovery-recovery) and of the guarded
// action `discovery_reconsider`. Pure: it turns the typed answer into Russian HTML from closed copy tables and decides
// nothing. A verdict, reason or refusal without declared copy makes the explanation unavailable rather than guessed.
// Keys, digests, etags, the pin and the idempotency key appear only inside the closed «Технические подробности». The
// action controls are rendered only when the server's preview is `eligible`; the server checks everything again.

export const OBS_VERDICT_COPY = {
  resolved: {title: 'Наблюдение уже распознано', what: 'Для него есть подтверждённое решение о фильме. Делать ничего не нужно.'},
  excluded_nonfilm: {title: 'Это не фильм', what: 'Название попадает под правила «не фильм» (сериал, выпуск, шоу). Такие наблюдения не ищутся.'},
  not_current: {title: 'Наблюдения нет в текущем окне программы', what: 'Его эфиров нет в окне текущей программы (72 часа назад и 24 часа вперёд). Резолвер берёт только текущие наблюдения.'},
  queued: {title: 'Наблюдение в обычной очереди', what: 'Обычный чанк резолвера может взять его сам, когда до него дойдёт очередь.'},
  identity_conflict: {title: 'Идентичность неоднозначна', what: 'Под название подходят несколько фильмов. Автоматика между ними не выбирает, а повтор поиска даст тот же результат.'},
  backoff: {title: 'Ждёт назначенного повтора', what: 'Прошлая попытка не дала уверенного совпадения. Следующая уже назначена и ещё не наступила.'},
  no_more_evidence: {title: 'Автоматические попытки исчерпаны на тех же данных', what: 'Резолвер несколько раз подряд не нашёл уверенного совпадения на одних и тех же эфирах и остановился. Новые эфиры этого названия в программе сами вернут наблюдение в очередь.'},
  stale_generation: {title: 'Индекс относится к другому поколению программы', what: 'Запись индекса сделана для другого опубликованного поколения. Вывод о текущем поколении по ней не делается.'},
  not_found: {title: 'Наблюдение не найдено', what: 'В индексе нет такого ключа.'},
  unknown: {title: 'Оценить нельзя', what: 'Данных недостаточно или они расходятся между собой. Вывод не делается.'},
};

const OBS_TERMINAL_COPY = {
  repeated_uncertain_match: 'пять попыток подряд без уверенного совпадения',
  awaiting_confirmation: 'пять попыток подряд нашли кандидата, которому нужно подтверждение',
  terminal: 'терминальное решение другого вида',
};

const OBS_STATUS_COPY = {
  no_confident_match: 'уверенного совпадения нет',
  ambiguous: 'подходят несколько фильмов',
  duration_mismatch: 'длительность не совпала',
  needs_verification: 'кандидат ждёт подтверждения',
  excluded_nonfilm: 'исключено как «не фильм»',
  verified: 'подтверждено',
};

const OBS_ACTIVITY_COPY = {current: 'в текущем окне программы', historical: 'было в программе раньше', expired: 'давно не встречается'};

const OBS_SERIES_COPY = {
  continuing: 'серия резолвера идёт: следующий шаг возьмёт очередь',
  waiting: 'серия резолвера ждёт',
  live_writer: 'резолвер прямо сейчас пишет',
  recovering: 'серия восстанавливается после прерванного шага',
  interrupted: 'серия остановлена после повторных прерываний',
  stopped: 'серия этого поколения завершена или остановлена',
  unknown: 'состояние серии неизвестно',
};

const OBS_SERIES_WAIT_COPY = {chunk_budget: 'по лимиту чанков', backoff: 'после ограничения TMDB', error: 'после ошибки шага'};

const OBS_NEXT_COPY = {
  none: 'Ничего не произойдёт, и ничего не нужно.',
  scheduled_step: 'Следующий обычный шаг серии по расписанию',
  epg_commit: 'Только следующая публикация программы откроет новую серию резолвера.',
  new_epg_evidence: 'Новые эфиры этого названия в программе вернут наблюдение в очередь сами.',
  owner_investigation: 'Нужен разбор владельцем: серия остановлена, потому что не настроен ключ TMDB.',
  reread: 'Проверь заново позже: сейчас данных недостаточно.',
};

// Why the action is not offered. Every reason the assessment can give has copy here.
export const OBS_GATE_COPY = {
  eligible: 'действие допустимо',
  index_not_current: 'индекс наблюдений не соответствует текущим данным: решение о записи по нему не принимается',
  already_resolved: 'наблюдение уже распознано',
  not_a_film: 'это не фильм',
  not_current: 'наблюдения нет в текущем окне программы, резолвер его не берёт',
  already_eligible: 'наблюдение и так в обычной очереди: запись ничего не изменит',
  identity_ambiguous: 'идентичность неоднозначна: нужен разбор идентичности, а не повтор',
  backoff_is_policy: 'повтор уже назначен: время повтора не обходится',
  generation_changed: 'поколение программы сменилось: нужно перечитать',
  target_absent: 'наблюдения нет',
  evidence_incomplete: 'данных недостаточно',
  terminal_reason_unknown: 'вид терминального решения не распознан',
  writer_active: 'резолвер сейчас пишет: вмешиваться нельзя',
  series_unknown: 'состояние серии резолвера неизвестно',
  series_backoff: 'серия ждёт после ограничения TMDB или ошибки: это защита, она не обходится',
  tmdb_throttled: 'TMDB ограничил запросы: время повтора не обходится',
  configuration_required: 'не настроен ключ TMDB: сначала нужна настройка',
};

const OBS_EFFECT_COPY = {
  next_ordinary_chunk: 'Наблюдение вернётся в обычную очередь. Его возьмёт обычный чанк резолвера, когда до него дойдёт очередь: сначала идут наблюдения с эфиром в ближайшие сутки. Сейчас ничего не запускается.',
  after_series_wait: 'Серия сейчас ждёт по лимиту чанков. После этого наблюдение возьмёт обычный чанк в порядке очереди. Сейчас ничего не запускается.',
  next_series: 'Серия этого поколения уже закончилась: наблюдение возьмёт только серия, которую откроет следующая публикация программы. Если в ней изменятся эфиры, наблюдение вернулось бы в очередь и без этого действия.',
};

const OBS_INDEX_COPY = {
  missing: 'Индекса наблюдений для опубликованного поколения нет. Он появится после первого обычного чанка резолвера в этом поколении. До этого разбор недоступен.',
  stale: 'Индекс наблюдений устарел: карта решений или реестр наблюдений изменились после его записи. Его обновит следующий обычный чанк. Показаны данные на момент записи индекса; действие недоступно.',
  other_generation: 'Индекс наблюдений записан для другого поколения программы. Его обновит первый обычный чанк текущего поколения. Разбор недоступен.',
  malformed: 'Индекс наблюдений не распознан. Разбор недоступен.',
  torn: 'Индекс наблюдений записан не до конца. Его перезапишет следующий обычный чанк. Разбор недоступен.',
  unavailable: 'Нет опубликованного поколения программы. Разбор недоступен.',
};

export const OBS_REFUSAL_COPY = {
  access_denied: 'Запрос не прошёл проверку доступа. Открой страницу заново через обычный вход.',
  invalid_request: 'Запрос не распознан. Ничего не записано.',
  unsupported_capability: 'Такого действия нет. Ничего не записано.',
  confirmation_missing: 'Подтверждение не найдено или не отмечено. Ничего не записано.',
  confirmation_expired: 'Срок подтверждения истёк. Ничего не записано: проверь наблюдение заново.',
  confirmation_mismatch: 'Подтверждение не совпадает с выданным. Ничего не записано.',
  stale_pin: 'Данные изменились после просмотра. Ничего не записано: проверь наблюдение заново.',
  record_changed: 'Решение по наблюдению изменилось после просмотра. Ничего не записано.',
  eligibility_changed: 'Действие больше не допустимо для этого наблюдения. Ничего не записано.',
  not_eligible: 'Действие для этого наблюдения недопустимо. Ничего не записано.',
  budget_exceeded: 'Действие касается больше записей, чем разрешено. Ничего не записано.',
  idempotency_conflict: 'Ключ запроса уже использован. Подготовь подтверждение заново.',
  in_progress: 'Запрос с этим ключом уже начинал выполняться и не оставил квитанции. Исход неизвестен: перечитай наблюдение, повторно ничего не выполняется.',
  lease_held: 'Резолвер сейчас занят. Ничего не записано: попробуй позже, подтверждение действует до своего срока.',
  lease_unknown: 'Блокировка резолвера в непонятном состоянии: неизвестно, кто им сейчас владеет. Ничего не записано; блокировку никто не перехватывал.',
  storage_unavailable: 'Хранилище не ответило. Исход проверь по квитанции и по наблюдению.',
  network: 'Нет ответа от сервера. Исход неизвестен: проверь квитанцию и наблюдение, прежде чем повторять.',
};

export const OBS_IDENTITY_REASON_COPY = {
  eligible: 'действие допустимо',
  index_not_current: 'индекс наблюдений не соответствует текущим данным: решение о записи по нему не принимается',
  index_incomplete: 'индекс неполный: подтверждать или отклонять идентичность по нему нельзя',
  unknown_authority: 'авторитет хранилища идентичности не R2 или неизвестен: запись не делается',
  writer_active: 'резолвер сейчас пишет: вмешиваться нельзя',
  series_unknown: 'состояние серии резолвера неизвестно',
  target_absent: 'наблюдения нет в индексе',
  evidence_incomplete: 'данных недостаточно',
  identity_ambiguous: 'идентичность неоднозначна, а уже известного id фильма нет: выбрать по одному названию нельзя',
  already_current: 'Уже так. Новой записи нет.',
  invalid_effect: 'Выберите: подтвердить фильм или отклонить совпадение.',
  invalid_movie_id: 'Нужен числовой id фильма TMDB, не сериала.',
  basis_required: 'Напишите, на каком основании.',
  not_on_decision: 'Отклонить можно только id, который уже стоит на этом решении.',
  ambiguous_needs_stronger: 'При неоднозначности можно подтвердить только id, который уже записан за наблюдением.',
  film_absent: 'В каталоге нет такого фильма. По одному названию запись не создаётся.',
  film_year_unknown: 'У фильма в каталоге нет года. Без уже известного id запись не делается.',
  year_unknown: 'У наблюдения нет года, а этот id ещё не был за ним записан.',
  year_conflict: 'Год наблюдения и год фильма расходятся больше чем на один.',
  tmdb_tv: 'Это id сериала, не фильма.',
  identity_inconsistent: 'Запись каталога не сходится в один фильм.',
  conflicting_identity: 'У фильма конфликт идентификаторов.',
  catalogue_unread: 'Каталог не прочитан. Ничего не записано.',
  title_only: 'Одного названия недостаточно.',
};

const OBS_IDENTITY_SHOWS_COPY = {
  next_ordinary_chunk: 'Показы каталога обновятся следующим обычным чанком, если фильм есть в каталоге и эфир в текущем окне. Сейчас ничего не запускается.',
  after_series_wait: 'Серия ждёт по лимиту чанков. Показы обновятся обычным чанком после этого ожидания, если фильм есть в каталоге. Сейчас ничего не запускается.',
  next_series: 'Серия этого поколения уже закончилась: показы обновятся в серии, которую откроет следующая публикация программы. Сейчас ничего не запускается.',
  awaiting_catalog_film: 'Решение записано. В каталоге этой записи фильма нет, поэтому показы не изменятся, пока она не появится. Сейчас ничего не запускается.',
  not_this_action: 'Отказ записан только для этого наблюдения и этого id. Похожие названия не блокируются. Следующий обычный чанк не подтвердит этот id и не запросит по нему карточку.',
};

const OBS_RECEIPT_COPY = {
  succeeded: {tone: 'reviewed', text: 'Записано: терминальная отметка снята, наблюдение вернулось в обычную очередь.'},
  refused: {tone: 'conflict', text: 'Отказ.'},
  failed: {tone: 'conflict', text: 'Не записано: карта решений изменилась в момент записи.'},
  aborted: {tone: 'provisional', text: 'Прервано: резолвер перехватил блокировку до записи. Ничего не записано.'},
  unknown: {tone: 'ambiguous', text: 'Исход неизвестен: запись могла пройти или нет. Повторно ничего не выполняется; перечитай наблюдение.'},
  partial: {tone: 'ambiguous', text: 'Записано частично.'},
};

function obsEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function obsDate(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function obsTone(verdict) {
  if (verdict === 'resolved' || verdict === 'excluded_nonfilm' || verdict === 'queued' || verdict === 'backoff') return 'reviewed';
  if (verdict === 'no_more_evidence' || verdict === 'identity_conflict') return 'provisional';
  return 'ambiguous';
}

function obsNextText(next) {
  const base = OBS_NEXT_COPY[next?.actor];
  if (!base) return null;
  if (next.actor !== 'scheduled_step') return base;
  const at = obsDate(next.at);
  return base + (at ? ', не раньше ' + at : '') + '.';
}

function obsSeriesText(series) {
  const base = OBS_SERIES_COPY[series?.state];
  if (!base) return null;
  if (series.state === 'waiting') return base + ' ' + (OBS_SERIES_WAIT_COPY[series.reason] || 'по своему правилу') + (obsDate(series.at) ? ' до ' + obsDate(series.at) : '');
  if (series.state === 'live_writer' && obsDate(series.at)) return base + ' (блокировка до ' + obsDate(series.at) + ')';
  return base;
}

function obsShowsText(shows) {
  if (!Array.isArray(shows) || !shows.length) return 'эфиров в записи нет';
  const listed = shows.slice(0, 6).map(show => [show.channel || 'канал без названия', obsDate(show.start)].filter(Boolean).join(', '));
  return listed.join('; ') + (shows.length > 6 ? '; и ещё ' + (shows.length - 6) : '');
}

// Whether every code of the answer has declared copy.
export function obsRecoveryExplainable(answer) {
  const assessment = answer?.assessment;
  if (!assessment || typeof assessment !== 'object' || assessment.error) return false;
  if (!OBS_VERDICT_COPY[assessment.verdict] || obsNextText(assessment.next) === null || !obsSeriesText(assessment.series)) return false;
  if (!assessment.execute || !OBS_GATE_COPY[assessment.execute.reason]) return false;
  if (assessment.verdict === 'no_more_evidence' && !OBS_TERMINAL_COPY[assessment.reason]) return false;
  if (assessment.execute.available && !OBS_EFFECT_COPY[assessment.execute.effect?.when]) return false;
  return true;
}

function obsDetails(answer, state) {
  const assessment = answer?.assessment || {};
  const observation = answer?.observation || {};
  const index = answer?.index || {};
  const action = answer?.action || {};
  const rows = [
    ['key', answer?.target?.key],
    ['verdict', [assessment.verdict, assessment.reason].filter(Boolean).join(' / ') || '—'],
    ['series', [assessment.series?.state, assessment.series?.reason, assessment.series?.at].filter(Boolean).join(' / ') || '—'],
    ['retry', [assessment.retry?.helps, assessment.retry?.reason].filter(Boolean).join(' / ') || '—'],
    ['execute', assessment.execute ? [assessment.execute.capability + '@' + assessment.execute.version, assessment.execute.available ? 'available' : 'unavailable', assessment.execute.reason, assessment.execute.effect?.when].filter(Boolean).join(' / ') : '—'],
    ['preview', [action.status, action.reason, action.scopeFingerprint].filter(Boolean).join(' / ') || '—'],
    ['evidence', (assessment.evidence?.completeness ?? '—') + ((assessment.evidence?.missing || []).length ? ' (' + assessment.evidence.missing.join(', ') + ')' : '') + ((assessment.evidence?.anomalies || []).length ? ' [' + assessment.evidence.anomalies.join(', ') + ']' : '')],
    ['decision.status', observation.decision?.status ?? '—'],
    ['decision.evidenceKey', observation.decision?.evidenceKey ?? '—'],
    ['decisionHash', observation.decisionHash ?? '—'],
    ['index', [index.state, ...(index.reasons || [])].filter(Boolean).join(' / ') || '—'],
    ['index.programmeRunId', index.programmeRunId ?? '—'],
    ['index.writer', index.writer ?? '—'],
    ['pin', answer?.pin ?? '—'],
    ['sources', (answer?.sources || []).join(', ') || '—'],
  ];
  if (state?.confirmation) rows.push(['idempotencyKey', state.confirmation.idempotencyKey], ['confirmation.expiresAt', state.confirmation.expiresAt]);
  if (state?.receipt) rows.push(['receipt', [state.receipt.state, state.receipt.refusal, ...(state.receipt.outcomes || []).map(item => item.outcome + (item.error ? ':' + item.error : ''))].filter(Boolean).join(' / ')]);
  return `<details class="recovery-tech"><summary>Технические подробности</summary><dl>${rows.map(([name, value]) => `<div><dt>${obsEscape(name)}</dt><dd>${obsEscape(value)}</dd></div>`).join('')}</dl></details>`;
}

function obsFactsHtml(answer) {
  const observation = answer.observation;
  const decision = observation.decision || {};
  const assessment = answer.assessment;
  const rows = [
    ['название', [observation.title || observation.normalizedTitle || 'без названия', observation.year ? String(observation.year) : null].filter(Boolean).join(', ')],
    ['длительность', Array.isArray(observation.durations) && observation.durations.length ? observation.durations.join(', ') + ' мин.' : 'не указана'],
    ['эфиры', obsShowsText(observation.shows)],
    ['в программе', OBS_ACTIVITY_COPY[assessment.observation?.activity] || 'неизвестно'],
    ['решение', OBS_STATUS_COPY[decision.status] || 'другое (см. технические подробности)'],
    ['попыток', decision.attempts === null || decision.attempts === undefined ? 'неизвестно' : String(decision.attempts)],
    ['последняя попытка', obsDate(decision.lastAttemptAt) || 'нет отметки'],
    ['следующий повтор', decision.retryAt ? obsDate(decision.retryAt) || 'время не распознано' : 'не назначен'],
    ['данные с прошлой попытки', assessment.observation?.evidence === 'same' ? 'те же эфиры' : assessment.observation?.evidence === 'changed' ? 'эфиры изменились' : 'решения ещё не было'],
    ['серия резолвера', obsSeriesText(assessment.series)],
  ];
  if (decision.terminalReason) rows.push(['терминальная причина', OBS_TERMINAL_COPY[decision.terminalReason] || 'другая']);
  if (decision.reconsidered) rows.push(['повторно направлено', (obsDate(decision.reconsidered.at) || 'время не распознано') + ' владельцем']);
  if (assessment.review?.suggested) {
    const identity = answer.identity;
    const text = !identity ? 'нужен разбор идентичности; инструмента для наблюдений пока нет' : identity.available ? 'идентичность этого наблюдения можно подтвердить или отклонить в форме ниже' : (OBS_IDENTITY_REASON_COPY[identity.reason] || 'разбор идентичности сейчас недоступен');
    rows.push(['идентичность', text]);
  }
  if (answer.identity?.hypothesis) rows.push(['гипотеза автоматики', answer.identity.hypothesis.tmdbId + ' (не доверенная: одного совпадения мало)']);
  return `<dl class="limbo-facts recovery-facts">${rows.map(([name, value]) => `<div><dt>${obsEscape(name)}</dt><dd>${obsEscape(value)}</dd></div>`).join('')}</dl>`;
}

function obsReceiptHtml(receipt, extra = {}) {
  const copy = OBS_RECEIPT_COPY[receipt?.state];
  if (!copy) return '<p class="recovery-error" role="alert">Квитанция не распознана. Перечитай наблюдение.</p>';
  const refusal = receipt.refusal ? ' ' + (OBS_REFUSAL_COPY[receipt.refusal] || 'Причина отказа не распознана.') : '';
  const durable = extra.durable === false ? '<p class="recovery-error" role="alert">Квитанция не сохранилась в хранилище. Исход выше получен из ответа сервера; при следующем запросе он будет считаться неизвестным.</p>' : '';
  const index = receipt.state === 'succeeded' && extra.index && extra.index.refreshed === false ? '<p class="muted">Индекс наблюдений не обновился сразу: до следующего обычного чанка он будет считаться устаревшим.</p>' : '';
  return `<div class="obs-receipt" role="status"><p><span class="admin-status admin-status-${copy.tone}">Квитанция</span> ${obsEscape(copy.text + refusal)}</p>${durable}${index}</div>`;
}

// The action block: a preview with cost, risk and expected effect; a checkbox naming the exact observation; then the
// server-issued confirmation with its expiry and the button that executes it.
function obsActionHtml(answer, state) {
  const assessment = answer.assessment;
  const gate = assessment.execute;
  const action = answer.action || {};
  if (!gate.available || action.status !== 'eligible') {
    const expires = state?.confirmation && gate.reason === 'writer_active' ? obsDate(state.confirmation.expiresAt) : null;
    const held = expires ? `<p class="obs-confirmed" role="status">Подтверждение сохранено до ${obsEscape(expires)}. Выполнить его можно, когда резолвер освободится: нажми «Проверить заново».</p>` : '';
    return `<h4>Повторно направить на проверку</h4><p>Недоступно — ${obsEscape(OBS_GATE_COPY[gate.reason])}.</p>${held}`;
  }
  const title = answer.observation.title || answer.observation.normalizedTitle || 'без названия';
  const minutes = Math.round((action.confirmTtlMs || 600000) / 60000);
  const parts = [
    '<h4>Повторно направить на проверку</h4>',
    `<p><b>Что изменится.</b> ${obsEscape(OBS_EFFECT_COPY[gate.effect.when])}</p>`,
    '<p><b>Стоимость.</b> Запросов к TMDB: 0. Запусков резолвера: 0. Записей: одно решение в общей карте решений, запись действия с квитанцией и обновление индекса.</p>',
    '<p><b>Риск.</b> Запись идёт под блокировкой резолвера и только если решение не изменилось с момента просмотра. Счётчик попыток и история сохраняются, поэтому следующая неуверенная попытка на тех же эфирах сразу вернёт терминальное состояние: это ровно одна дополнительная обычная попытка. Автоматической отмены нет; прежнее решение хранится в записи действия.</p>',
  ];
  if (state?.receipt) return parts.join('');
  if (state?.confirmation) {
    const expires = obsDate(state.confirmation.expiresAt);
    parts.push(`<p class="obs-confirmed" role="status">Подтверждение выдано${expires ? ', действует до ' + obsEscape(expires) : ''}. Оно относится только к наблюдению «${obsEscape(title)}» в его текущем состоянии.</p>`);
    parts.push(`<p class="recovery-controls"><button type="button" class="admin-more obs-execute" data-obs-recovery-execute${state.busy ? ' disabled aria-busy="true"' : ''}>Повторно направить на проверку</button> <button type="button" class="admin-more" data-obs-recovery-cancel${state.busy ? ' disabled' : ''}>Отменить</button></p>`);
    return parts.join('');
  }
  const id = 'obs-accept-' + obsEscape(state?.slot ?? '0');
  parts.push(`<p class="obs-accept"><input type="checkbox" id="${id}" data-obs-recovery-accept${state?.accepted ? ' checked' : ''}> <label for="${id}">Я хочу снять терминальную отметку только с наблюдения «${obsEscape(title)}»${answer.observation.year ? ' (' + obsEscape(answer.observation.year) + ')' : ''} и вернуть его в обычную очередь. Подтверждение действует ${minutes} мин.</label></p>`);
  parts.push(`<p class="recovery-controls"><button type="button" class="admin-more" data-obs-recovery-confirm${state?.accepted && !state.busy ? '' : ' disabled'}${state?.busy ? ' aria-busy="true"' : ''}>Подтвердить</button></p>`);
  return parts.join('');
}

function obsMovieId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,11}$/.test(value.trim()) ? value.trim() : '';
}

export function obsIdentityBlocked(answer, state) {
  const identity = answer?.identity;
  if (!identity?.available) return OBS_IDENTITY_REASON_COPY[identity?.reason] || 'Сейчас записать нельзя.';
  const effect = state?.identityEffect === 'assign' || state?.identityEffect === 'reject' ? state.identityEffect : '';
  const id = obsMovieId(state?.identityTarget || '');
  const raw = String(state?.identityTarget || '').trim();
  const basis = String(state?.identityBasis || '').trim();
  if (!effect) return raw || basis ? OBS_IDENTITY_REASON_COPY.invalid_effect : '';
  if (!raw) return '';
  if (!id) return OBS_IDENTITY_REASON_COPY.invalid_movie_id;
  if (effect === 'reject' && !(identity.rejectable || []).includes(id)) return OBS_IDENTITY_REASON_COPY.not_on_decision;
  if (effect === 'reject' && (identity.rejectedTmdbIds || []).includes(id) && identity.current?.tmdbId !== id) return OBS_IDENTITY_REASON_COPY.already_current;
  if (effect === 'assign' && identity.current?.status === 'ambiguous' && !(identity.trusted || []).some(item => item.tmdbId === id)) return OBS_IDENTITY_REASON_COPY.ambiguous_needs_stronger;
  if (basis.length > 200) return 'Основание длиннее 200 знаков.';
  return '';
}

export function obsIdentityPreviewText(answer, state) {
  const effect = state?.identityEffect === 'assign' || state?.identityEffect === 'reject' ? state.identityEffect : '';
  const id = obsMovieId(state?.identityTarget || '');
  if (!effect || !id || obsIdentityBlocked(answer, state)) return '';
  const identity = answer.identity || {};
  const title = answer.observation?.title || answer.observation?.normalizedTitle || 'без названия';
  const current = identity.hypothesis ? 'гипотеза ' + identity.hypothesis.tmdbId : identity.current?.tmdbId ? 'id ' + identity.current.tmdbId : 'решение не подтверждено';
  if (effect === 'reject') return 'Сейчас: ' + current + ' → Станет: id ' + id + ' заблокирован только у наблюдения «' + title + '».';
  const when = OBS_IDENTITY_SHOWS_COPY[identity.effect?.when] || OBS_IDENTITY_SHOWS_COPY.next_series;
  return 'Сейчас: ' + current + ' → Станет: фильм ' + id + '. ' + when;
}

function obsIdentityReceiptHtml(state) {
  const receipt = state.identityReceipt;
  if (!receipt) return '';
  const application = state.identityApplication || {};
  const shows = OBS_IDENTITY_SHOWS_COPY[application.shows] || '';
  if (receipt.state === 'succeeded') {
    const index = state.identityIndex && state.identityIndex.refreshed === false ? '<p class="muted">Индекс наблюдений не обновился сразу: до следующего обычного чанка список может ещё показывать эту строку, а читатель увидит индекс устаревшим.</p>' : '';
    return `<div class="obs-identity-receipt" role="status" tabindex="-1"><p><span class="admin-status admin-status-reviewed">Квитанция</span> Решение по этому наблюдению записано. ${obsEscape(shows)}</p>${index}</div>`;
  }
  if (receipt.state === 'unknown') return '<div class="obs-identity-receipt" role="status" tabindex="-1"><p><span class="admin-status admin-status-ambiguous">Квитанция</span> Исход неизвестен: запись могла пройти или нет. Повторно ничего не выполняется; перечитай наблюдение.</p></div>';
  if (receipt.state === 'aborted') return '<div class="obs-identity-receipt" role="alert" tabindex="-1"><p>Прервано до записи. Ничего не записано.</p></div>';
  if (receipt.state === 'failed') return '<div class="obs-identity-receipt" role="alert" tabindex="-1"><p>Не записано: карта решений изменилась в момент записи.</p></div>';
  const reason = state.identityReason && OBS_IDENTITY_REASON_COPY[state.identityReason] ? OBS_IDENTITY_REASON_COPY[state.identityReason] : (OBS_REFUSAL_COPY[receipt.refusal] || '');
  return `<div class="obs-identity-receipt" role="alert" tabindex="-1"><p>Отказ. ${obsEscape(reason)}</p></div>`;
}

function obsIdentityHtml(answer, state) {
  const identity = answer?.identity;
  if (!identity) return '';
  const receipt = obsIdentityReceiptHtml(state);
  if (!identity.available) {
    const text = OBS_IDENTITY_REASON_COPY[identity.reason] || 'Разбор идентичности сейчас недоступен.';
    return `${receipt}<section class="obs-identity"><h4>Идентичность этого наблюдения</h4><p>${obsEscape(text)}</p><p class="muted">Индекс покрывает только текущие нерешённые наблюдения, по которым уже есть решение. Наблюдения без первой проверки в него не входят.</p></section>`;
  }
  const title = answer.observation?.title || answer.observation?.normalizedTitle || 'без названия';
  const key = answer.observation?.key || answer.target?.key || '';
  const run = identity.programmeRunId || answer.index?.programmeRunId || '';
  const evidence = answer.observation?.decision?.evidenceKey;
  const sourceCopy = {owner: 'владелец', tmdb_detail: 'карточка TMDB', known_epg_alias: 'уже известный фильм в программе'};
  const source = sourceCopy[answer.observation?.decision?.identitySource] || '';
  const provenance = `<p>Ключ доказательства: ${obsEscape(evidence || 'в индексе не назван')}. ${source ? 'Источник решения: ' + obsEscape(source) + '.' : 'Источник автоматического решения в этом индексе не назван: старая запись индекса называет его после следующего обычного чанка.'}</p>`;
  const limit = '<p class="muted">Индекс покрывает только текущие нерешённые наблюдения с решением. Он не является всем реестром и не включает наблюдения без первой проверки. Другие наблюдения, фильмы, люди и прошлые поколения этим действием не меняются.</p>';
  if (state.identityConfirmation) {
    const plan = state.identityPlan || {};
    const before = plan.before ? (plan.before.status || '—') + (plan.before.tmdbId ? ' · ' + plan.before.tmdbId : '') : '—';
    const after = plan.after ? (plan.after.status || '—') + (plan.after.tmdbId ? ' · ' + plan.after.tmdbId : '') : '—';
    const shows = OBS_IDENTITY_SHOWS_COPY[state.identityApplication?.shows] || OBS_IDENTITY_SHOWS_COPY[identity.effect?.when] || '';
    return `${receipt}<section class="obs-identity"><h4>Идентичность этого наблюдения</h4>${provenance}${limit}<p class="obs-identity-preview">Сейчас: ${obsEscape(before)} → Станет: ${obsEscape(after)}. ${obsEscape(shows)}</p><p class="obs-confirmed" role="status">Подтверждение выдано для ключа «${obsEscape(key)}» в поколении ${obsEscape(run)}. Запись ещё не сделана.</p><p class="recovery-controls"><button type="button" class="admin-more" data-obs-identity-execute${state.identityBusy ? ' disabled aria-busy="true"' : ''}>Записать идентичность</button> <button type="button" class="admin-more" data-obs-identity-cancel${state.identityBusy ? ' disabled' : ''}>Отменить</button></p></section>`;
  }
  const effect = state.identityEffect === 'assign' || state.identityEffect === 'reject' ? state.identityEffect : '';
  const target = String(state.identityTarget || '');
  const basis = String(state.identityBasis || '');
  const preview = obsIdentityPreviewText(answer, state);
  const hint = state.identityReason && OBS_IDENTITY_REASON_COPY[state.identityReason] ? OBS_IDENTITY_REASON_COPY[state.identityReason] : obsIdentityBlocked(answer, state);
  const ready = effect && obsMovieId(target) && basis.trim() && basis.trim().length <= 200 && !obsIdentityBlocked(answer, state);
  const choices = (identity.trusted || []).map(item => `<label class="obs-identity-option"><input type="radio" name="obs-identity-choice-${obsEscape(state.slot || '0')}" value="${obsEscape(item.tmdbId)}" data-obs-identity-choice${target === item.tmdbId ? ' checked' : ''}> id ${obsEscape(item.tmdbId)}, уже записан за наблюдением</label>`).join('');
  const hypothesis = identity.hypothesis ? `<p>Гипотеза автоматики (не выбор): ${obsEscape(identity.hypothesis.tmdbId)}. Её нельзя подтвердить одним только этим совпадением.</p>` : '';
  const rejectable = (identity.rejectable || []).length ? `<p>Можно отклонить только: ${obsEscape(identity.rejectable.join(', '))}.</p>` : '<p>На этом решении нет id, который можно отклонить.</p>';
  const acceptId = 'obs-identity-accept-' + obsEscape(state.slot || '0');
  return `${receipt}<section class="obs-identity"><h4>Идентичность этого наблюдения</h4>${provenance}${limit}${hypothesis}${rejectable}`
    + `<label class="obs-identity-option"><input type="radio" name="obs-identity-effect-${obsEscape(state.slot || '0')}" value="assign" data-obs-identity-effect${effect === 'assign' ? ' checked' : ''}> Подтвердить фильм</label>`
    + `<label class="obs-identity-option"><input type="radio" name="obs-identity-effect-${obsEscape(state.slot || '0')}" value="reject" data-obs-identity-effect${effect === 'reject' ? ' checked' : ''}${identity.rejectable?.length ? '' : ' disabled'}> Отклонить совпадение</label>`
    + choices
    + `<label class="obs-identity-option">Другой id фильма <input type="text" inputmode="numeric" autocomplete="off" data-obs-identity-id value="${obsEscape(target)}"></label>`
    + `<label class="obs-identity-option">Основание <input type="text" maxlength="200" data-obs-identity-basis value="${obsEscape(basis)}"></label>`
    + `<p class="obs-identity-preview" data-obs-identity-preview${preview ? '' : ' hidden'}>${obsEscape(preview)}</p>`
    + `<p class="obs-identity-hint" data-obs-identity-hint role="status">${obsEscape(hint)}</p>`
    + `<p class="obs-identity-accept"><input type="checkbox" id="${acceptId}" data-obs-identity-accept${state.identityAccepted ? ' checked' : ''}> <label for="${acceptId}">Я меняю идентичность только наблюдения «${obsEscape(title)}», ключ ${obsEscape(key)}, поколение ${obsEscape(run)}. Подтверждение действует 10 мин.</label></p>`
    + `<p class="recovery-controls"><button type="button" class="admin-more" data-obs-identity-confirm${ready && state.identityAccepted && !state.identityBusy ? '' : ' disabled'}${state.identityBusy ? ' aria-busy="true"' : ''}>Подтвердить идентичность</button></p></section>`;
}

// `state`: {slot, changed, accepted, confirmation, receipt, durable, index, busy, error}.
export function obsRecoveryPanelHtml(answer, state = {}) {
  const changed = state.changed ? '<p class="recovery-changed" role="status">Состояние изменилось с прошлой проверки; ниже свежий разбор.</p>' : '';
  const recheck = '<button type="button" class="admin-more recovery-recheck" data-obs-recovery-recheck>Проверить заново</button>';
  const receipt = state.receipt ? obsReceiptHtml(state.receipt, state) : '';
  const identityReceipt = state.identityReceipt && !answer?.indexed ? obsIdentityReceiptHtml(state) : '';
  const error = state.error ? `<p class="recovery-error" role="alert">${obsEscape(OBS_REFUSAL_COPY[state.error] || 'Запрос не выполнен. Перечитай наблюдение.')}</p>` : '';
  if (!answer || typeof answer !== 'object') return `${receipt}${identityReceipt}${error}<p class="recovery-unexplained" role="alert">Ответ не получен.</p><p class="recovery-controls">${recheck}</p>`;
  if (!answer.indexed) {
    const state_ = answer.index?.state;
    const text = state_ && state_ !== 'fresh' && OBS_INDEX_COPY[state_] ? OBS_INDEX_COPY[state_] : 'Наблюдения нет в индексе. Индекс хранит только текущие нерешённые наблюдения, по которым уже было решение: ключ может ждать первой проверки, быть распознан, исключён или не входить в текущее окно программы.';
    return `${changed}${receipt}${identityReceipt}${error}<p class="recovery-unexplained">${obsEscape(text)}</p>${obsDetails(answer, state)}<p class="recovery-controls">${recheck}</p>`;
  }
  if (!obsRecoveryExplainable(answer)) {
    return `${changed}${receipt}${error}<p class="recovery-unexplained" role="alert">Невозможно достоверно объяснить состояние наблюдения. Ничего не выполнялось; подробности ниже.</p>${obsDetails(answer, state)}<p class="recovery-controls">${recheck}</p>`;
  }
  const assessment = answer.assessment;
  const copy = OBS_VERDICT_COPY[assessment.verdict];
  const reason = assessment.verdict === 'no_more_evidence' ? ' (' + OBS_TERMINAL_COPY[assessment.reason] + ')' : '';
  const stale = answer.index?.state === 'stale' ? `<p class="limbo-unavailable">${obsEscape(OBS_INDEX_COPY.stale)}</p>` : '';
  const checked = obsDate(answer.evaluatedAt), written = obsDate(answer.index?.writtenAt);
  const snapshot = [checked ? 'проверено ' + checked : null, written ? 'индекс записан ' + written : null].filter(Boolean).join(' · ');
  return `${changed}${receipt}${error}${stale}<p class="recovery-headline"><span class="admin-status admin-status-${obsTone(assessment.verdict)}">${obsEscape(copy.title)}</span></p>`
    + `<h4>Что с наблюдением</h4><p>${obsEscape(copy.what + reason)}</p>`
    + `<h4>Что будет дальше</h4><p>${obsEscape(obsNextText(assessment.next))}</p>`
    + (assessment.review?.reason === 'identity_ambiguous' && !assessment.execute?.available && !answer.identity ? '<p>Автоматическое исправление этой проблемы пока недоступно.</p>' : '')
    + `<h4>Данные</h4>${obsFactsHtml(answer)}`
    + obsIdentityHtml(answer, state)
    + obsActionHtml(answer, state)
    + (snapshot ? `<p class="muted recovery-snapshot">${obsEscape(snapshot)}.</p>` : '')
    + obsDetails(answer, state)
    + `<p class="recovery-controls">${recheck}</p>`;
}

const OBS_ERROR_COPY = {
  network: 'Нет ответа от сервера. Проверь соединение и доступ и повтори.',
  storage_unavailable: 'Хранилище не ответило. Ничего не выполнялось.',
  invalid_key: 'Ключ наблюдения не распознан.',
  invalid_pin: 'Отметка прошлой проверки не распознана. Проверь заново.',
};

export function obsRecoveryErrorHtml(code) {
  const text = OBS_ERROR_COPY[code] || (/^http_\d+$/.test(String(code)) ? 'Сервер ответил ошибкой ' + String(code).slice(5) + '. Разбор не получен.' : 'Разбор не получен.');
  return `<p class="recovery-error" role="alert">${obsEscape(text)}</p><p class="recovery-controls"><button type="button" class="admin-more recovery-recheck" data-obs-recovery-recheck>Проверить заново</button></p>`;
}
