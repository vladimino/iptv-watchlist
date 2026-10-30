// Machine-to-human presentation of a guarded owner action. Pure and deterministic: no DOM, no storage, no network and no
// model. It turns what the contract in src/domain/admin-actions.js returned (a preview, a receipt) plus trusted context
// (display titles and the data health issues the preview was judged on) into plain Russian sentences, using only a
// capability's display descriptor and the closed code tables below. It never decides eligibility: it can only take an
// explanation away. A code without a declared sentence, a descriptor that disagrees with the capability, or an affected
// record without a trusted title or issue makes the whole presentation unexplainable, and an unexplainable preview can
// never be confirmed. Raw codes, ids, versions, pins and fingerprints appear only in `technical`, which the view shows
// inside a closed "Технические подробности" disclosure.

export const ACTION_UNEXPLAINABLE = 'Невозможно достоверно объяснить действие; выполнение недоступно';
export const ACTION_RECEIPT_UNEXPLAINABLE = 'Невозможно достоверно объяснить результат. Не повторяйте действие, пока не проверите данные вручную.';

// Explains non-atomic execution without promising an automatic rollback.
export const ACTION_NON_ATOMIC = 'Изменения выполняются по одному фильму. Если что-то пойдёт не так, часть фильмов может обновиться, остальные нет. Мы покажем результат каждого. Автоматический откат не обещаем.';

// The headline of each preview state. `tone` drives colour only; the words carry the meaning.
export const ACTION_PREVIEW_STATE_COPY = Object.freeze({
  eligible: {tone: 'ready', headline: 'Можно подтвердить'},
  ineligible: {tone: 'blocked', headline: 'Сейчас изменять нечего'},
  stale: {tone: 'warning', headline: 'Данные обновились после начала проверки'},
  unsupported: {tone: 'blocked', headline: 'Это действие здесь недоступно'},
  unknown: {tone: 'warning', headline: 'Недостаточно сведений, чтобы решить'},
  empty: {tone: 'neutral', headline: 'Проверять нечего'},
});

// Every reason a preview as a whole can carry (src/domain/admin-actions.js previewAction).
export const ACTION_PREVIEW_REASON_COPY = Object.freeze({
  eligible: {detail: '', next: 'Прочитайте, что изменится и чем это грозит, затем подтвердите.'},
  not_eligible: {detail: 'Ни один фильм сейчас нельзя изменить безопасно — причина указана у каждого.', next: 'Устраните причины и повторите проверку.'},
  budget_exceeded: {detail: 'Выбрано больше фильмов, чем разрешено изменить за один раз.', next: 'Уменьшите выбор и повторите проверку.'},
  evidence_incomplete: {detail: 'Сведений недостаточно, чтобы понять, нужно ли и безопасно ли изменение.', next: 'Дождитесь полной проверки данных и повторите.'},
  no_records: {detail: 'Подходящих фильмов не нашлось.', next: 'Ничего делать не нужно.'},
  stale_pin: {detail: 'Пока шла проверка, на сайте опубликовались новые данные, и её вывод мог устареть.', next: 'Повторите проверку.'},
  observation_incomplete: {detail: 'Данные не удалось прочитать полностью.', next: 'Повторите проверку.'},
  invalid_request: {detail: 'Запрос на проверку повреждён или неполон.', next: 'Обновите страницу и повторите.'},
  unsupported_capability: {detail: 'Такое действие не зарегистрировано.', next: 'Обновите страницу; если не поможет, действие недоступно.'},
  unsupported_subject: {detail: 'Действие не работает с записями этого типа.', next: 'Выберите другое действие.'},
});

// Why a record stays out of the scope: every eligibility reason of the data health model
// (DATA_HEALTH_ELIGIBILITY_REASONS) plus the reasons previewAction adds itself.
export const ACTION_EXCLUSION_COPY = Object.freeze({
  eligible: {why: 'сведения в порядке, но фильм не попал в проверенный список', next: 'Повторите проверку.'},
  no_action_defined: {why: 'для этой проблемы нет безопасного автоматического действия', next: 'Разберитесь с фильмом вручную на странице данных.'},
  in_backoff: {why: 'предыдущая попытка недавно не удалась, и время следующей ещё не наступило', next: 'Подождите и повторите проверку позже.'},
  awaiting_progress: {why: 'работа над ним уже идёт', next: 'Дождитесь её завершения и повторите проверку.'},
  evidence_incomplete: {why: 'сведений недостаточно, чтобы понять, нужно ли и безопасно ли обновление', next: 'Дождитесь полной проверки данных и повторите.'},
  generation_changed: {why: 'сведения относятся к предыдущему обновлению, поэтому сейчас нельзя безопасно продолжать', next: 'Сначала обновите сведения и повторите проверку.'},
  manual_review_required: {why: 'нужна ручная проверка', next: 'Проверьте фильм вручную на странице данных.'},
  identity_unverified: {why: 'не подтверждено, какой именно это фильм', next: 'Сначала подтвердите сопоставление фильма.'},
  terminal: {why: 'обработка завершилась окончательно без результата, и автоматический повтор не поможет', next: 'Разберитесь с фильмом вручную.'},
  owner_input_required: {why: 'нужно ваше решение', next: 'Примите решение на странице данных и повторите проверку.'},
  already_queued: {why: 'он уже стоит в очереди на обработку', next: 'Ничего делать не нужно — дождитесь обработки.'},
  no_issue: {why: 'проблем, которые решает это действие, у него не найдено', next: 'Ничего делать не нужно.'},
  not_eligible: {why: 'сведения не позволяют безопасно его менять', next: 'Посмотрите фильм на странице данных.'},
  record_not_read: {why: 'его не удалось прочитать при проверке', next: 'Повторите проверку.'},
  subject_kind_differs: {why: 'это запись другого типа, к которой действие не относится', next: 'Ничего делать не нужно.'},
  version_unknown: {why: 'не удалось установить, какая версия записи сейчас сохранена, поэтому её нельзя безопасно перезаписать', next: 'Повторите проверку.'},
});

// What is wrong with a record: every issue reason of the data health model (DATA_HEALTH_REASONS).
export const ACTION_ISSUE_REASON_COPY = Object.freeze({
  evidence_not_supplied: 'нужные сведения не были переданы для проверки',
  evidence_object_missing: 'нужный объект данных не найден',
  generation_not_published: 'новый выпуск данных ещё не опубликован',
  generation_stale: 'опубликованный выпуск данных устарел',
  pin_generation_changed: 'данные успели обновиться во время чтения',
  projection_generation_differs: 'производные данные построены по другому выпуску',
  identity_conflict: 'источники по-разному определяют, какой это фильм',
  identity_ambiguous: 'не удаётся однозначно определить, какой это фильм',
  localization_conflict: 'переводы названия или описания противоречат друг другу',
  queue_disagreement: 'очереди обработки расходятся между собой',
  retry_waiting: 'ожидается запланированный повтор',
  retry_due: 'наступило время повторной попытки',
  retry_overdue: 'повторная попытка просрочена',
  backoff_beyond_policy: 'пауза перед повтором дольше допустимой',
  no_progress: 'обработка давно не продвигается',
  terminal_without_resolution: 'обработка остановилась без результата',
  progress_unknown: 'неизвестно, продвигается ли обработка',
  work_pending: 'обработка ещё не завершена',
  work_queued: 'работа стоит в очереди',
  repeated_failures: 'несколько попыток подряд завершились ошибкой',
  metadata_stale: 'метаданные давно не обновлялись',
  metadata_partial: 'метаданные заполнены не полностью',
  metadata_missing: 'метаданных нет совсем',
  eligible_work_without_runs: 'есть готовая работа, но обработка не запускалась',
  all_deferred_by_retry: 'вся работа отложена до повторных попыток',
  continuation_running_stale: 'продолжение обработки давно не отвечает',
  continuation_not_advanced: 'продолжение обработки не продвинулось',
  poster_missing: 'нет постера',
  posters_missing: 'нет части постеров',
  baseline_missing: 'нет исходных данных для сравнения',
  baseline_age_unknown: 'неизвестно, насколько свежи исходные данные для сравнения',
  baseline_stale: 'исходные данные для сравнения устарели',
  clock_skew: 'время в источниках расходится, и сроки нельзя оценить надёжно',
});

export const ACTION_RUN_STATE_COPY = Object.freeze({
  approved: {tone: 'neutral', headline: 'Подтверждено, выполнение ещё не началось'},
  running: {tone: 'neutral', headline: 'Выполняется'},
  succeeded: {tone: 'ready', headline: 'Всё получилось'},
  partial: {tone: 'warning', headline: 'Получилось частично'},
  failed: {tone: 'blocked', headline: 'Не получилось'},
  aborted: {tone: 'warning', headline: 'Остановлено, не дойдя до конца'},
  unknown: {tone: 'warning', headline: 'Результат части изменений неизвестен'},
  refused: {tone: 'blocked', headline: 'Отказано: ничего не выполнялось'},
});

export const ACTION_OUTCOME_COPY = Object.freeze({
  written: {text: 'изменено', next: ''},
  already_applied: {text: 'уже было изменено раньше, повторно не меняли', next: ''},
  skipped_changed: {text: 'не тронули: фильм изменился, пока шла работа, и мы его не перезаписали', next: 'Повторите проверку, чтобы увидеть его текущее состояние.'},
  failed: {text: 'не удалось', next: 'Проверьте фильм вручную.'},
  unknown: {text: 'не знаем, применилось ли изменение', next: 'НЕ повторяйте, пока не проверите карточку этого фильма.'},
  not_attempted: {text: 'до него не дошли', next: 'Повторите проверку и подтвердите заново.'},
});

// Every error code a receipt may carry (ADMIN_ACTION_ERROR_CODES).
export const ACTION_ERROR_COPY = Object.freeze({
  provider_error: 'источник данных вернул ошибку',
  timeout: 'источник не ответил вовремя',
  rate_limited: 'источник временно ограничил число запросов',
  conflict: 'фильм изменился во время работы',
  fence_lost: 'работу перехватила другая операция, поэтому мы остановились',
  validation_error: 'полученные сведения не прошли проверку',
  storage_error: 'не удалось сохранить изменение',
  aborted: 'работа была остановлена',
  internal_error: 'произошла внутренняя ошибка',
});

// Every refusal (ADMIN_ACTION_REFUSALS): why nothing ran and how to fix it.
export const ACTION_REFUSAL_COPY = Object.freeze({
  access_denied: {why: 'нет прав владельца', fix: 'Войдите под учётной записью владельца.'},
  unsupported_capability: {why: 'такое действие не зарегистрировано', fix: 'Обновите страницу; если не поможет, действие недоступно.'},
  invalid_request: {why: 'запрос повреждён или неполон', fix: 'Повторите проверку и подтвердите заново.'},
  confirmation_missing: {why: 'нет действительного подтверждения', fix: 'Отметьте подтверждение и нажмите кнопку ещё раз.'},
  confirmation_expired: {why: 'подтверждение истекло', fix: 'Повторите проверку и подтвердите заново.'},
  confirmation_mismatch: {why: 'подтверждение не совпадает с проверенным списком', fix: 'Повторите проверку и подтвердите заново.'},
  stale_pin: {why: 'после проверки на сайте опубликовались новые данные', fix: 'Повторите проверку: новые данные могли изменить список.'},
  record_changed: {why: 'один из фильмов изменился после проверки', fix: 'Повторите проверку.'},
  eligibility_changed: {why: 'после проверки изменилось, какие фильмы можно менять', fix: 'Повторите проверку.'},
  not_eligible: {why: 'проверка не допускает изменения', fix: 'Посмотрите причину у каждого фильма.'},
  budget_exceeded: {why: 'выбрано больше фильмов, чем можно изменить за один раз', fix: 'Уменьшите выбор и повторите проверку.'},
  idempotency_conflict: {why: 'это подтверждение уже использовано для другого списка', fix: 'Повторите проверку и подтвердите заново.'},
  in_progress: {why: 'такое же изменение уже выполняется', fix: 'Дождитесь его результата.'},
  lease_held: {why: 'сейчас выполняется другая операция', fix: 'Подождите и попробуйте снова.'},
});

// Every compensation kind (ADMIN_ACTION_COMPENSATION): what undo exists, without promising an automatic one.
export const ACTION_COMPENSATION_COPY = Object.freeze({
  none: 'Отменить изменение будет нельзя.',
  restore_before_image: 'Прежние сведения каждого изменённого фильма сохраняются. Вернуть их можно отдельной подтверждённой операцией; автоматического отката нет.',
  manual: 'Автоматического отката нет: если результат не устроит, исправлять придётся вручную.',
});

const ACTION_DESCRIPTOR_TEXT = ['capability', 'healthActionCode', 'subjectKind', 'compensation', 'title', 'subjectLabel', 'problem', 'change', 'untouched', 'effect', 'cta', 'confirm'];

function presentIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function presentNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function presentOwn(table, code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null;
}
function presentFill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}
function presentCapitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// A display descriptor is the human contract of one capability version. It is plain data; every text field is required,
// `noun` gives the Russian count forms (one/few/many, and ofOne/ofMany after «из»), `fields` lists what may change, `risks` the capability's own risks.
export function validDescriptor(descriptor) {
  if (!presentIsObject(descriptor) || !Number.isInteger(descriptor.version) || descriptor.version < 1) return false;
  if (ACTION_DESCRIPTOR_TEXT.some(key => !presentNonEmpty(descriptor[key]))) return false;
  if (!descriptor.subjectLabel.includes('{name}') || !descriptor.confirm.includes('{count}')) return false;
  if (!presentIsObject(descriptor.noun) || !['one', 'few', 'many', 'ofOne', 'ofMany'].every(key => presentNonEmpty(descriptor.noun[key]))) return false;
  if (!Array.isArray(descriptor.fields) || !descriptor.fields.length || !descriptor.fields.every(presentNonEmpty)) return false;
  if (!Array.isArray(descriptor.risks) || !descriptor.risks.every(presentNonEmpty)) return false;
  if (descriptor.externalCalls !== null && !presentNonEmpty(descriptor.externalCalls)) return false;
  if (typeof descriptor.simulation !== 'boolean' || (descriptor.simulation && !presentNonEmpty(descriptor.simulationNote))) return false;
  return Boolean(presentOwn(ACTION_COMPENSATION_COPY, descriptor.compensation));
}

export function createDescriptorRegistry(descriptors) {
  const byKey = new Map();
  for (const descriptor of descriptors || []) {
    if (!validDescriptor(descriptor)) throw new Error('invalid action descriptor');
    const key = descriptor.capability + '@' + descriptor.version;
    if (byKey.has(key)) throw new Error('duplicate action descriptor ' + key);
    byKey.set(key, Object.freeze({...descriptor}));
  }
  return Object.freeze({get: (capability, version) => byKey.get(capability + '@' + version) ?? null});
}

// Russian count with the right noun form: 1 фильм, 2 фильма, 5 фильмов, 21 фильм, 11 фильмов.
export function actionCount(count, noun) {
  const tens = count % 100, units = count % 10;
  const form = tens >= 11 && tens <= 14 ? noun.many : units === 1 ? noun.one : units >= 2 && units <= 4 ? noun.few : noun.many;
  return count + ' ' + form;
}

// The same count after «из» (genitive): из 1 фильма, из 2 фильмов, из 21 фильма.
export function actionCountOf(count, noun) {
  return count + ' ' + (count % 10 === 1 && count % 100 !== 11 ? noun.ofOne : noun.ofMany);
}

function presentTitleOf(context, id) {
  const titles = context?.titles;
  const value = titles instanceof Map ? titles.get(id) : presentIsObject(titles) && Object.prototype.hasOwnProperty.call(titles, id) ? titles[id] : null;
  return presentNonEmpty(value) ? value.trim() : null;
}
function presentLabelOf(descriptor, context, id) {
  const title = presentTitleOf(context, id);
  return title ? presentFill(descriptor.subjectLabel, {name: title}) : null;
}
function presentMinutes(ms) {
  return Math.max(1, Math.round(ms / 60000));
}

function presentPreviewTechnical(preview) {
  const rows = [];
  if (!presentIsObject(preview)) return rows;
  rows.push(['Действие', String(preview.capability ?? '—') + ' v' + String(preview.version ?? '—')]);
  rows.push(['Состояние', String(preview.status ?? '—') + ' / ' + String(preview.reason ?? '—')]);
  rows.push(['Снимок (pin)', String(preview.pin ?? '—')]);
  if (preview.currentPin !== undefined) rows.push(['Текущий снимок', String(preview.currentPin ?? '—')]);
  if (preview.observedAt) rows.push(['Прочитано', String(preview.observedAt)]);
  if (preview.scopeFingerprint) rows.push(['Отпечаток объёма', String(preview.scopeFingerprint)]);
  if (presentIsObject(preview.budget)) rows.push(['Бюджет', `records ${preview.budget.records}/${preview.budget.maxRecords}, writes ${preview.budget.writes}, externalCalls ${preview.budget.externalCalls}`]);
  if (preview.atomic !== undefined) rows.push(['atomic', String(preview.atomic)]);
  if (presentIsObject(preview.compensation)) rows.push(['Компенсация', String(preview.compensation.kind)]);
  if (presentIsObject(preview.retry)) rows.push(['Повтор', `maxAttempts ${preview.retry.maxAttempts}, backoffMs ${preview.retry.backoffMs}`]);
  if (preview.confirmTtlMs !== undefined) rows.push(['confirmTtlMs', String(preview.confirmTtlMs)]);
  for (const item of preview.affected || []) rows.push(['В объёме', `${item.id} · ${item.version} · issue ${item.issueId ?? '—'}`]);
  for (const item of preview.excluded || []) rows.push(['Исключено', `${item.id} · ${item.status} · ${item.reason}`]);
  return rows;
}

function presentUnexplainable(descriptor, technical) {
  return {explainable: false, title: descriptor?.title ?? 'Действие', simulation: Boolean(descriptor?.simulation), message: ACTION_UNEXPLAINABLE, confirm: null, technical};
}

// The plain-language model of a preview. `descriptors` is a descriptor registry; `context` is the trusted read the
// preview was judged on: {titles: {id: title} | Map, issues: [data health issue]}. Returns `explainable: false` with
// ACTION_UNEXPLAINABLE whenever any part cannot be explained from declared text and typed evidence.
export function presentPreview(preview, descriptors, context) {
  const technical = presentPreviewTechnical(preview);
  if (!presentIsObject(preview)) return presentUnexplainable(null, technical);
  const descriptor = descriptors?.get?.(preview.capability, preview.version) ?? null;
  const state = presentOwn(ACTION_PREVIEW_STATE_COPY, preview.status), reason = presentOwn(ACTION_PREVIEW_REASON_COPY, preview.reason);
  if (!descriptor || !state || !reason) return presentUnexplainable(descriptor, technical);
  if (preview.subject?.kind !== undefined && preview.subject.kind !== descriptor.subjectKind) return presentUnexplainable(descriptor, technical);
  if (presentIsObject(preview.compensation) && preview.compensation.kind !== descriptor.compensation) return presentUnexplainable(descriptor, technical);
  const externalCalls = preview.budget?.externalCalls ?? 0;
  if (externalCalls > 0 && !descriptor.externalCalls) return presentUnexplainable(descriptor, technical);
  const issues = Array.isArray(context?.issues) ? context.issues : [];

  const included = [];
  for (const item of preview.affected || []) {
    const label = presentLabelOf(descriptor, context, item.id);
    const issue = issues.find(entry => entry?.id === item.issueId && entry?.subject?.id === item.id && entry?.subject?.kind === descriptor.subjectKind);
    const why = presentOwn(ACTION_ISSUE_REASON_COPY, issue?.reason);
    // An included record must be named, and its reason must come from its own typed issue for this capability's code.
    if (!label || !issue || issue.action?.code !== descriptor.healthActionCode || !why) return presentUnexplainable(descriptor, technical);
    const evidence = issue.evidence?.completeness === 'complete' ? 'Сведения собраны полностью.' : null;
    if (!evidence) return presentUnexplainable(descriptor, technical);
    included.push({name: presentCapitalize(label), text: `Причина: ${why}. ${evidence}`});
  }
  const excluded = [];
  for (const item of preview.excluded || []) {
    const copy = presentOwn(ACTION_EXCLUSION_COPY, item.reason);
    if (!copy) return presentUnexplainable(descriptor, technical);
    const label = presentLabelOf(descriptor, context, item.id) ?? 'запись без проверенного названия';
    excluded.push({name: presentCapitalize(label), text: `Не будем изменять ${label}: ${copy.why}.`, next: copy.next});
  }

  const count = included.length;
  let detail = reason.detail;
  if (preview.status === 'eligible') detail = `Изменение затронет ${actionCount(count, descriptor.noun)}` + (excluded.length ? `, ещё ${actionCount(excluded.length, descriptor.noun)} пропустим.` : '.');
  const risks = [ACTION_NON_ATOMIC];
  risks.push('Если фильм изменится, пока идёт работа, мы его пропустим и не перезапишем.');
  risks.push(...descriptor.risks);
  risks.push(externalCalls > 0 ? descriptor.externalCalls : 'Внешние сервисы это действие не вызывает.');
  risks.push(ACTION_COMPENSATION_COPY[descriptor.compensation]);
  const ttl = Number.isInteger(preview.confirmTtlMs) ? `Подтверждение действует ${presentMinutes(preview.confirmTtlMs)} мин; если данные изменятся раньше, оно будет отклонено и проверку нужно будет повторить.` : null;
  if (ttl) risks.push(ttl);
  const names = included.map(item => item.name.replace(/^./, char => char.toLowerCase()));
  const confirm = preview.status === 'eligible' && count > 0 ? {
    label: presentFill(descriptor.confirm, {count: actionCount(count, descriptor.noun), names: names.join(', ')}),
    cta: `${descriptor.cta} (${actionCount(count, descriptor.noun)})`,
    count,
  } : null;
  return {
    explainable: true, title: descriptor.title, simulation: descriptor.simulation,
    status: {tone: state.tone, headline: preview.status === 'eligible' && descriptor.simulation ? 'Можно смоделировать изменение' : state.headline, detail, next: reason.next},
    problem: descriptor.problem,
    change: {summary: descriptor.change, fields: descriptor.fields.join(', '), untouched: descriptor.untouched, effect: descriptor.effect, simulation: descriptor.simulation ? descriptor.simulationNote : null},
    included, excluded, risks, confirm, technical,
  };
}

function presentReceiptTechnical(receipt) {
  const rows = [];
  if (!presentIsObject(receipt)) return rows;
  rows.push(['Состояние', String(receipt.state ?? '—') + (receipt.refusal ? ' / ' + receipt.refusal : '')]);
  rows.push(['Ключ идемпотентности', String(receipt.idempotencyKey ?? '—')]);
  rows.push(['Отпечаток объёма', String(receipt.scopeFingerprint ?? '—')]);
  rows.push(['Снимок (pin)', String(receipt.pin ?? '—')]);
  if (receipt.atomic !== undefined) rows.push(['atomic', String(receipt.atomic)]);
  for (const entry of receipt.outcomes || []) rows.push(['Запись', `${entry.id} · ${entry.outcome}${entry.error ? ' · ' + entry.error : ''}`]);
  if (presentIsObject(receipt.retry)) rows.push(['Повтор', `retryable [${(receipt.retry.retryable || []).join(', ')}], maxAttempts ${receipt.retry.maxAttempts}`]);
  if (presentIsObject(receipt.audit)) rows.push(['Аудит', `${receipt.audit.actor ?? '—'} · ${receipt.audit.confirmedAt ?? '—'}`]);
  if (receipt.replay) rows.push(['replay', 'true']);
  return rows;
}

// The plain-language model of a receipt: a summary ("Удалось для N из M"), one line per record with its next step, and
// for a refusal the reason and the fix. An undeclared code anywhere yields ACTION_RECEIPT_UNEXPLAINABLE.
export function presentReceipt(receipt, descriptors, context) {
  const technical = presentReceiptTechnical(receipt);
  const state = presentIsObject(receipt) ? presentOwn(ACTION_RUN_STATE_COPY, receipt.state) : null;
  const descriptor = presentIsObject(receipt) && receipt.capability ? descriptors?.get?.(receipt.capability, receipt.version) ?? null : null;
  const fail = () => ({explainable: false, tone: 'warning', headline: 'Результат не удалось объяснить', message: ACTION_RECEIPT_UNEXPLAINABLE, lines: [], technical});
  if (!state) return fail();
  if (receipt.state === 'refused') {
    const refusal = presentOwn(ACTION_REFUSAL_COPY, receipt.refusal);
    if (!refusal) return fail();
    return {explainable: true, tone: state.tone, headline: state.headline, summary: `Причина: ${refusal.why}.`, next: `Как исправить: ${refusal.fix}`, lines: [], technical};
  }
  if (!descriptor) return fail();
  const retryable = new Set(receipt.retry?.retryable || []);
  const lines = [];
  for (const entry of receipt.outcomes || []) {
    const outcome = presentOwn(ACTION_OUTCOME_COPY, entry.outcome);
    const error = entry.error === undefined ? '' : presentOwn(ACTION_ERROR_COPY, entry.error);
    if (!outcome || error === null) return fail();
    const label = presentLabelOf(descriptor, context, entry.id) ?? 'запись без проверенного названия';
    let next = outcome.next;
    if (entry.outcome === 'failed' && retryable.has(entry.id)) next = 'Можно повторить: запустите проверку заново и подтвердите новый список.';
    lines.push({outcome: entry.outcome, name: presentCapitalize(label), text: presentCapitalize(outcome.text) + (error ? ` — ${error}` : '') + '.', next});
  }
  const total = lines.length, done = lines.filter(line => line.outcome === 'written' || line.outcome === 'already_applied').length;
  const summary = `Удалось для ${done} из ${actionCountOf(total, descriptor.noun)}.` + (descriptor.simulation ? ' Это моделирование: реальные фильмы не менялись.' : '');
  let next = 'Больше ничего делать не нужно.';
  if (receipt.state === 'unknown') next = 'По фильмам с неизвестным результатом НЕ повторяйте действие, пока не проверите их карточки.';
  else if (done < total) next = 'Посмотрите следующий шаг у каждого фильма, который не изменился.';
  return {explainable: true, tone: state.tone, headline: state.headline, summary, next, replay: receipt.replay ? 'Это повторная отправка того же подтверждения: заново ничего не выполнялось, показан прежний итог.' : null, lines, technical};
}
