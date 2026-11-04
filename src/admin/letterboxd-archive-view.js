// Presentation of the archive preview answer: pure functions from the Worker's JSON to HTML strings. No request, storage or
// timer; every value from the archive is escaped. Nothing here offers to apply the proposal: this page only previews.
const ARCHIVE_ERROR_TEXT = {
  file_required: 'Выбери ZIP-архив экспорта Letterboxd.',
  not_zip_name: 'Нужен ZIP-архив экспорта Letterboxd (файл .zip).',
  archive_too_large: 'Архив больше 10 МБ. Экспорт Letterboxd обычно намного меньше; проверь, тот ли это файл.',
  generated_at_required: 'Имя файла не похоже на стандартное имя экспорта Letterboxd, поэтому время экспорта неизвестно. Укажи его в поле «Время экспорта, UTC».',
  generated_at_conflict: 'Имя файла уже содержит время экспорта. Очисти поле «Время экспорта, UTC».',
  generated_at_invalid: 'Время экспорта задаётся в UTC в виде 2026-10-31T08:15Z.',
  generated_at_future: 'Время экспорта позже текущего времени сервера.',
  generated_at_too_old: 'Время экспорта раньше 2011 года: такого экспорта Letterboxd не бывает.',
  archive_invalid: 'Архив не прошёл проверку, ничего не сопоставлялось.',
  csv_invalid: 'CSV-файл в архиве повреждён, ничего не сопоставлялось.',
  missing_watched: 'В архиве нет watched.csv. Без него предпросмотр невозможен.',
  invalid_form: 'Запрос не распознан: нужен один файл и, при необходимости, время экспорта.',
  unsupported_media_type: 'Запрос не распознан: архив отправляется формой.',
  length_required: 'Браузер не сообщил размер запроса. Повтори загрузку.',
  origin_not_allowed: 'Запрос пришёл не с этой страницы и отклонён.',
  method_not_allowed: 'Предпросмотр принимает только отправку формы.',
  preview_failed: 'Предпросмотр не удался на сервере. Ничего не записано; повтори проверку.',
  preview_busy: 'Сервер ещё проверяет предыдущий архив. Дождись окончания и повтори.',
  unexpected_answer: 'Сервер ответил не тем, что страница ждала. Ничего нового не записано.',
  network: 'Нет ответа от сервера. Проверь соединение и доступ и повтори.',
  access_denied: 'Запись доступна только владельцу с этой страницы. Ничего не записано.',
  storage_unavailable: 'Хранилище сейчас недоступно. Ничего не записано.',
  storage_error: 'Запись не завершилась. Повтори то же подтверждение: уже записанная партия не дублируется.',
  invalid_request: 'Запрос на запись не сошёлся с проверкой. Ничего не записано. Проверь архив ещё раз.',
  confirmation_missing: 'Нет подтверждения этой партии. Сначала нажми «Подтвердить партию».',
  confirmation_mismatch: 'Архив или партия не совпали с подтверждением. Ничего не записано.',
  confirmation_expired: 'Подтверждение истекло. Проверь архив ещё раз и подтверди партию заново.',
  stale_pin: 'Опубликованная программа сменилась. Проверь архив ещё раз. Ничего не записано.',
  record_changed: 'Факты в R2 изменились после проверки. Проверь архив ещё раз. Ничего не записано.',
  eligibility_changed: 'Партия больше не совпадает с проверкой. Проверь архив ещё раз. Ничего не записано.',
  not_eligible: 'Эту партию нельзя записать. Ничего не записано.',
  idempotency_conflict: 'Этот ключ уже использован для другой партии. Ничего нового не записано.',
  in_progress: 'Эта партия уже записывается. Подожди и повтори то же действие.',
  preview_busy: 'Сервер ещё занят предыдущим архивом. Дождись окончания и повтори.',
};
const ARCHIVE_ZIP_TEXT = {
  not_zip: 'это не ZIP-архив',
  archive_too_large: 'архив больше допустимого размера',
  zip64_unsupported: 'формат ZIP64 не поддерживается',
  multi_disk_unsupported: 'многотомный архив не поддерживается',
  too_many_entries: 'слишком много файлов в архиве',
  central_directory_invalid: 'оглавление архива повреждено',
  entry_name_invalid: 'недопустимое имя файла в архиве',
  encrypted_entry: 'файл в архиве зашифрован',
  unsupported_method: 'неподдерживаемый способ сжатия',
  duplicate_entry: 'файл встречается в архиве дважды',
  local_header_invalid: 'заголовок файла не совпадает с оглавлением',
  entry_truncated: 'файл в архиве обрезан',
  entry_overlap: 'файлы в архиве перекрываются',
  entry_too_large: 'файл после распаковки больше 4 МБ',
  total_too_large: 'файлы после распаковки больше 8 МБ вместе',
  ratio_exceeded: 'подозрительно высокая степень сжатия',
  entry_size_mismatch: 'размер после распаковки не совпадает с заявленным',
  inflate_failed: 'файл не распаковывается',
  checksum_failed: 'контрольная сумма не совпала',
  invalid_utf8: 'текст не в UTF-8',
  too_many_rows: 'слишком много строк',
  aborted: 'проверка отменена',
  time_budget: 'проверка заняла слишком много времени',
};
const ARCHIVE_OUTCOME_TEXT = {new: 'добавится', replaces: 'заменит наблюдение', unchanged: 'без изменений', older: 'в R2 новее, не меняется', tie: 'то же время, другое значение', unverified: 'не проверено'};
const ARCHIVE_FACT_TEXT = {watched: 'просмотрен', rating: 'оценка', watchlist: 'в watchlist'};
const ARCHIVE_STATUS_TEXT = {accepted: 'принято', provisional: 'предварительно', candidate: 'кандидат', ambiguous: 'неоднозначно', conflict: 'конфликт', unmatched: 'не найдено'};
const ARCHIVE_METHOD_TEXT = {lid_exact: 'точный id Letterboxd', tmdb_verified: 'id Letterboxd + TMDB', title_year: 'название и год'};
const ARCHIVE_REASON_TEXT = {
  code_uncorroborated: 'код совпал, но название не подтверждено',
  stored_tmdb_conflict: 'в R2 у фильма разные TMDB id',
  stored_year_disagrees: 'год в R2 расходится больше чем на год',
  stored_title_differs: 'название в R2 другое',
  no_stored_title: 'такого названия в R2 нет',
  title_without_year_match: 'название есть, год не совпал',
  multiple_targets: 'подходит несколько фильмов',
  missing_year_multiple_targets: 'нет года, подходит несколько фильмов',
  missing_year: 'нет года',
  identity_unverified: 'идентичность только по названию и году',
};
const ARCHIVE_HELD_TEXT = {
  alias_conflict: 'псевдонимы фильма ведут к разным записям фактов',
  invalid_identity: 'id фильма недопустим для записи фактов',
  record_read_limit: 'превышен лимит чтения записей',
  record_unavailable: 'запись фактов не прочиталась',
  record_converging: 'запись фактов сейчас сливается с другой',
  links_unavailable: 'индекс связей не прочитался',
  record_not_read: 'запись не читалась',
};
const ARCHIVE_INVALID_TEXT = {missing_name: 'нет названия', missing_uri: 'нет ссылки', invalid_uri: 'недопустимая ссылка', invalid_year: 'недопустимый год', invalid_rating: 'недопустимая оценка', invalid_date: 'недопустимая дата', column_count: 'неверное число колонок', invalid_code: 'недопустимый код'};
const ARCHIVE_SOURCE_TEXT = {programme: 'программа опубликованного поколения', metadata: 'metadata.json', ratingsGeneration: 'поколение оценок', links: 'индекс связей фактов', filmsListSummary: 'сводка списка фильмов', watchlistSummary: 'сводка watchlist'};
const ARCHIVE_EVIDENCE_TEXT = {observed: 'прочитано', object_missing: 'объекта нет', unavailable: 'не прочиталось'};
const ARCHIVE_SET_TEXT = {watched: 'просмотрено', rated: 'с оценкой', watchedUnrated: 'просмотрено без оценки', ratedNotWatched: 'оценено, но не в watched', watchlist: 'в watchlist', watchlistWatched: 'в watchlist и просмотрено'};
const ARCHIVE_RECEIPT_TEXT = {committed: 'этот архив уже импортирован', opened: 'импорт этого архива начат, но не завершён', absent: 'этот архив не импортировался', unavailable: 'квитанция не прочиталась', not_read: 'квитанция не читалась'};
const ARCHIVE_VERDICT_TEXT = {supported: 'подтверждается', mixed: 'смешанная картина', refuted: 'опровергается', inconclusive: 'данных недостаточно'};
const ARCHIVE_BATCH_REASON = {
  facts_changed_during_read: 'Данные менялись во время проверки. Повтори проверку, затем подтверждай партию.',
  programme_unavailable: 'Нет опубликованной программы, поэтому партию подтвердить нельзя.',
  no_compared_films: 'Нет фильмов, которые предпросмотр полностью сравнил. Непроверенные и спорные в партию не входят.',
  not_eligible: 'Партия не подходит для записи.',
  budget_exceeded: 'В партии больше фильмов, чем можно подтвердить за раз.',
};
const ARCHIVE_DETAIL_TEXT = {
  adds: ['Новое значение', 'факты, которых у фильма в R2 ещё нет'],
  updates: ['Другое значение', 'наблюдение новее и значение отличается от того, что в R2'],
  sameValue: ['То же значение', 'наблюдение обновится: значение то же, сменятся источник и время'],
  heldNewer: ['В R2 новее', 'архив старше того, что уже известно; импорт это не перепишет'],
  unverified: ['Не проверено', 'запись фактов не читалась или сейчас меняется'],
  conflicts: ['Удержано: конфликт', 'импорт не тронет эти фильмы'],
  identity: ['Удержано: идентичность', 'фильм не сопоставлен однозначно'],
  invalidRows: ['Негодные строки', 'строки CSV, которые не прочитались'],
};

function archiveEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}
function archiveDate(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'нет отметки';
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}
function archiveAge(ms) {
  if (typeof ms !== 'number') return 'неизвестно';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return days + ' дн.';
  const hours = Math.floor(ms / 3600000);
  return hours >= 1 ? hours + ' ч.' : 'меньше часа';
}
function archiveBytes(n) {
  if (typeof n !== 'number') return '—';
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n >= 1024 ? Math.round(n / 1024) + ' КБ' : n + ' Б';
}
function archiveBadge(tone, text) {
  return `<span class="admin-status admin-status-${tone}">${archiveEscape(text)}</span>`;
}
function archiveFacts(rows) {
  return `<dl class="limbo-facts">${rows.map(([name, value]) => `<div><dt>${archiveEscape(name)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}
function archiveCounts(counts, labels) {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return 'нет';
  return entries.map(([code, n]) => archiveEscape(labels && labels[code] || code) + ': ' + n).join(' · ');
}

function archiveErrorText(error, detail) {
  let text = ARCHIVE_ERROR_TEXT[error] || (/^http_\d+$/.test(String(error)) ? 'Сервер ответил ошибкой ' + String(error).slice(5) + '. Ничего не записано.' : 'Проверка не выполнена: ' + String(error || 'неизвестная ошибка') + '.');
  if (error === 'archive_invalid' && detail && detail.code) text += ' Причина: ' + (ARCHIVE_ZIP_TEXT[detail.code] || detail.code) + (detail.file ? ' (' + detail.file + ')' : '') + '.';
  if (error === 'csv_invalid' && detail) text += ' Файл: ' + (detail.file || 'неизвестен') + (detail.record ? ', запись ' + detail.record : '') + '.';
  return text;
}

function archivePlural(n, one, few, many) {
  const abs = Math.abs(Number(n) || 0), mod10 = abs % 10, mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
function archiveAgePhrase(ms) {
  if (typeof ms !== 'number') return 'время экспорта неизвестно';
  if (ms < 3600000) return 'создан менее часа назад';
  return 'создан ' + archiveAge(ms) + ' назад';
}
function archiveZipStatusHtml(answer) {
  const files = answer.export && answer.export.files;
  if (!files) return '';
  const list = Object.values(files);
  const present = list.filter(file => file.present).length;
  const conflicts = list.reduce((sum, file) => sum + (file.present ? file.conflicts || 0 : 0), 0);
  const invalid = answer.export.invalidRows || 0;
  const mismatches = answer.export.crossFileMismatches || 0;
  const age = archiveAgePhrase((answer.archive && answer.archive.ageMs) ?? (answer.freshness && answer.freshness.ageMs));
  const clean = present === list.length && invalid === 0 && conflicts === 0 && mismatches === 0;
  const title = clean
    ? `Архив успешно прочитан: ${present}/${list.length} CSV, ошибок нет, ${age}`
    : `Архив прочитан: ${present}/${list.length} CSV, негодных строк ${invalid}, конфликтов CSV ${conflicts}, расхождений между файлами ${mismatches}, ${age}`;
  return `<div class="archive-callout ${clean ? 'archive-callout-ok' : 'archive-callout-warn'}" role="status"><b>${archiveEscape(title)}</b></div>`;
}
function archiveCoverageHtml(answer) {
  const freshness = answer.freshness || {};
  const reasons = freshness.reasons || [];
  if (freshness.verdict !== 'inconclusive' && !reasons.includes('ratings_unconfirmed')) return '';
  const films = answer.proposal && answer.proposal.films || {};
  const reads = answer.proposal && answer.proposal.recordReads || {};
  const limit = typeof films.compared === 'number' && typeof films.unverified === 'number' && films.unverified > 0 && reads.limit && reads.done >= reads.limit;
  let text;
  if (typeof films.compared === 'number' && typeof films.accepted === 'number' && typeof films.unverified === 'number' && films.unverified > 0) {
    text = `Сравнение с R2 частичное: сопоставлено фильмов: ${films.accepted}; проверено: ${films.compared}; не проверено: ${films.unverified}${limit ? ' из-за лимита чтения' : ''}. Свежесть остальных оценок подтвердить нельзя; только ради этого сообщения скачивать новый ZIP не нужно.`;
  } else text = 'Сравнение с R2 частичное: не все оценки проверены. Свежесть остальных подтвердить нельзя; только ради этого сообщения скачивать новый ZIP не нужно.';
  if (films.heldForIdentity) text += ` Ещё ${films.heldForIdentity} ${archivePlural(films.heldForIdentity, 'фильм', 'фильма', 'фильмов')} архива ${archivePlural(films.heldForIdentity, 'не сопоставлен', 'не сопоставлены', 'не сопоставлены')} и в это сравнение ${archivePlural(films.heldForIdentity, 'не входит', 'не входят', 'не входят')}.`;
  return `<div class="archive-callout archive-callout-warn" role="status"><b>Сравнение с R2 частичное</b><span>${archiveEscape(text)}</span></div>`;
}
function archiveFreshnessHtml(answer) {
  const freshness = answer.freshness || {};
  const verdict = freshness.verdict || (freshness.needsFreshArchive ? 'needs_fresh' : 'verified');
  const zip = archiveZipStatusHtml(answer);
  const coverage = archiveCoverageHtml(answer);
  if (verdict === 'needs_fresh') {
    const reasons = (freshness.reasons || []).filter(reason => reason !== 'ratings_unconfirmed').map(reason => reason === 'archive_stale'
      ? `<li>Экспорту ${archiveEscape(archiveAge(freshness.ageMs))}: это больше порога ${archiveEscape(archiveAge(freshness.archiveStaleMs))}.</li>`
      : reason === 'ratings_newer_in_r2' ? `<li>У ${freshness.ratingsNewerInR2} проверенных фильм(ов) оценка в R2 новее этого архива: значит, после экспорта оценки менялись.</li>`
      : `<li>${archiveEscape(reason)}</li>`).join('');
    return zip + coverage + `<div class="archive-callout archive-callout-warn" role="alert"><b>Нужен свежий архив</b><ul>${reasons}</ul><span>Это отдельная причина, не полнота сравнения. Скачай новый экспорт в настройках Letterboxd и проверь его здесь.</span></div>`;
  }
  if (verdict === 'inconclusive') return zip + coverage;
  const checked = `<div class="archive-callout archive-callout-ok" role="status"><b>Среди проверенных фильмов архив не устарел</b><span>Ни одна проверенная оценка не новее этого архива. Это не суждение о фильмах, которые не сопоставлены.</span></div>`;
  return zip + coverage + checked;
}

function archiveValueParagraph(answer) {
  const values = answer.proposal && answer.proposal.values;
  if (!values) return '';
  const by = values.byFact || {};
  const watched = by.watched && by.watched.sameValueUpdates || 0;
  const rating = by.rating && by.rating.sameValueUpdates || 0;
  const watchlist = by.watchlist && by.watchlist.sameValueUpdates || 0;
  const films = answer.proposal.films || {};
  const exportFilms = answer.export && answer.export.films;
  const partial = (typeof exportFilms === 'number' && typeof films.compared === 'number' && exportFilms !== films.compared) || (films.unverified || 0) > 0;
  const scope = partial ? ' Эти числа — факты среди проверенных фильмов, не весь архив.' : '';
  const same = values.sameValueUpdates || 0;
  const sameText = same
    ? ` При записи этого архива ${archivePlural(same, 'обновится', 'обновятся', 'обновятся')} ${same} ${archivePlural(same, 'наблюдение', 'наблюдения', 'наблюдений')} без изменения оценок, просмотренного и watchlist (${watched}/${rating}/${watchlist}). Изменятся источник и время подтверждения; это реальные R2 writes и может влиять на последующие синхронизации.`
    : ' Обновлений наблюдений с тем же значением нет.';
  return `<p>Изменений значений: ${values.changedValues || 0}. Новых значений: ${values.newValues || 0}.${sameText} Пока ничего не записано.${scope}</p>`;
}
function archiveSummaryCounts(answer) {
  const proposal = answer.proposal || {}, values = proposal.values || {}, details = answer.details || {};
  const tone = answer.status === 'complete' ? 'reviewed' : 'provisional';
  const unverified = details.unverified && typeof details.unverified.total === 'number' ? details.unverified.total : '—';
  const cards = [
    ['добавится', values.newValues ?? '—'],
    ['изменится', values.changedValues ?? '—'],
    ['пропущено', values.older ?? '—'],
  ];
  const unread = typeof unverified === 'number' && unverified > 0 ? ' archive-callout archive-callout-warn' : '';
  return `<div class="archive-summary-head">${archiveBadge(tone, answer.status === 'complete' ? 'полный предпросмотр' : 'частичный предпросмотр')}${archiveBadge('plain', 'ничего не записано')}<span class="muted">оценка на ${archiveEscape(archiveDate(answer.evaluatedAt))}</span></div>`
    + `<div class="archive-totals">${cards.map(([name, value]) => `<div class="archive-total"><b>${archiveEscape(value)}</b><span>${archiveEscape(name)}</span></div>`).join('')}</div>`
    + `<p class="archive-unverified${unread}" role="status"><b>${archiveEscape(unverified)}</b> <span>не проверено (фильмов)</span></p>`
    + archiveValueParagraph(answer);
}
function archiveSummaryNote(answer) {
  const archive = answer.archive || {}, proposal = answer.proposal || {}, values = proposal.values || {};
  return `<p class="muted archive-note">Фильмов в архиве: ${answer.export ? answer.export.films : '—'}; сопоставлено и принято: ${proposal.films ? proposal.films.accepted : '—'}; проверено: ${proposal.films ? proposal.films.compared : '—'}. «Добавится», «изменится» и «пропущено» считают факты среди проверенных фильмов. «Пропущено» — в R2 уже новее, запись это не перепишет, и это не все фильмы без изменений. «Не проверено (фильмов)» считает фильмы, чьи записи не читались, и не входит в эти факты. «То же значение, новое наблюдение»: ${archiveEscape(values.sameValueUpdates ?? '—')}. Это факт с исходом replaces, но прежним значением: запись обновит источник и время. «Наблюдение совпало»: ${archiveEscape(values.unchanged ?? '—')}. Это полностью то же наблюдение, а не «значение не менялось». Запись — отдельное подтверждение конкретной партии.</p>`
    + (archive.generatedAtSource === 'owner_declared' ? '<p class="muted archive-note">Время экспорта указано вручную: имя файла нестандартное.</p>' : '');
}
function archiveSummaryTail(answer) {
  return answer.consistency && answer.consistency.status !== 'stable' ? '<p class="archive-callout archive-callout-warn" role="alert"><b>Данные в R2 менялись во время проверки.</b> Сравнение смешивает два состояния: повтори проверку.</p>' : '';
}
function archiveSummaryHtml(answer) {
  return archiveSummaryCounts(answer) + archiveSummaryNote(answer) + archiveSummaryTail(answer);
}

function archiveArchiveHtml(answer) {
  const archive = answer.archive || {}, exported = answer.export || {}, completeness = answer.completeness || {};
  const files = Object.entries(exported.files || {}).map(([, file]) => {
    if (!file.present) return `<tr><th scope="row">${archiveEscape(file.name)}</th><td colspan="4">${file.auxiliary ? 'нет (вспомогательный файл)' : 'нет в архиве'}</td></tr>`;
    return `<tr><th scope="row">${archiveEscape(file.name)}${file.auxiliary ? ' <small class="muted">вспом.</small>' : ''}</th><td>${file.records}</td><td>${file.valid}</td><td>${Object.values(file.invalid || {}).reduce((a, b) => a + b, 0)}</td><td>${file.duplicates} / ${file.conflicts}</td></tr>`;
  }).join('');
  const manual = archive.generatedAtSource === 'owner_declared';
  const source = manual
    ? 'Время на экране показано по Мадриду. Файл переименован, поэтому дата экспорта — то, что указано вручную в поле UTC, а не время из имени.'
    : 'Время на экране показано по Мадриду. Дата экспорта прочитана из имени файла. Поле UTC нужно только для переименованного архива.';
  const rows = [
    ['время экспорта', archiveEscape(archiveDate(archive.generatedAt)) + ' · ' + (manual ? 'указано вручную' : 'из имени файла') + ' · ' + archiveEscape(archiveAge(archive.ageMs)) + ' назад'],
    ['размер', archiveEscape(archiveBytes(archive.bytes)) + ' · файлов в архиве ' + archiveEscape(archive.entries) + ', из них не читались ' + archiveEscape(archive.ignoredEntries)],
    ['полнота', completeness.status === 'complete' ? 'все четыре файла на месте' : 'нет: ' + archiveEscape((completeness.missing || []).join(', '))],
    ['наборы', archiveCounts(exported.sets, ARCHIVE_SET_TEXT)],
    ['расхождения', 'название или год расходятся между файлами: ' + archiveEscape(exported.crossFileMismatches ?? 0) + ' · негодных строк: ' + archiveEscape(exported.invalidRows ?? 0) + (exported.invalidRows ? ' (' + archiveCounts(exported.invalidByReason, ARCHIVE_INVALID_TEXT) + ')' : '')],
  ];
  return archiveFacts(rows) + `<p class="muted archive-note">${archiveEscape(source)}</p>` + `<div class="archive-table-wrap"><table class="archive-table"><caption>Файлы экспорта</caption><thead><tr><th scope="col">файл</th><th scope="col">записей</th><th scope="col">годных</th><th scope="col">негодных</th><th scope="col">дубли / конфликты</th></tr></thead><tbody>${files}</tbody></table></div>`;
}

function archiveBaselineHtml(answer) {
  const baseline = answer.baseline || {}, receipt = baseline.thisArchive || {};
  const receiptText = (ARCHIVE_RECEIPT_TEXT[receipt.status] || receipt.status) + (receipt.committedAt ? ', ' + archiveDate(receipt.committedAt) : '');
  return archiveFacts([
    ['базовая линия', archiveBadge('ambiguous', 'неизвестно') + ' В R2 нет ограниченной сводки о последнем подтверждённом импорте, а угадывать её по квитанциям, списку ключей или часам браузера нельзя. Поэтому разница считается с текущими фактами, а не с прошлым архивом.'],
    ['этот архив', archiveEscape(receiptText)],
  ]);
}

function archiveMatchingHtml(answer) {
  const matching = answer.matching || {};
  if (matching.status === 'unavailable') return '<p class="muted">Сопоставление не выполнялось.</p>';
  const sources = Object.entries(matching.sources || {}).map(([name, source]) => archiveEscape(ARCHIVE_SOURCE_TEXT[name] || name) + ': ' + archiveEscape(ARCHIVE_EVIDENCE_TEXT[source.evidence] || source.evidence)).join(' · ');
  const hypothesis = matching.lidHypothesis || {};
  return archiveFacts([
    ['статус', matching.status === 'complete' ? 'все источники прочитаны' : 'часть источников не прочиталась: результат неполный'],
    ['по статусу', archiveCounts(matching.byStatus, ARCHIVE_STATUS_TEXT)],
    ['принято по способу', archiveCounts(matching.acceptedByMethod, ARCHIVE_METHOD_TEXT)],
    ['причины', archiveCounts(matching.reasons, ARCHIVE_REASON_TEXT)],
    ['код = id Letterboxd', archiveEscape(ARCHIVE_VERDICT_TEXT[hypothesis.verdict] || hypothesis.verdict || '—') + ' · совпало кодов: ' + archiveEscape(hypothesis.codesEqualToStoredLid ?? '—') + ' из ' + archiveEscape(hypothesis.storedLids ?? '—') + ' известных id'],
    ['источники', sources || '—'],
    ['не читается', 'каталог discovery и индекс просмотров: каждый весит мегабайты и не меняет, какие фильмы принимаются. Без каталога способ «id Letterboxd + TMDB» показывается как «точный id Letterboxd».'],
  ]);
}

function archiveRatedHtml(answer) {
  const rated = answer.ratedAdmission;
  if (!rated) return '';
  const item = (label, count) => `<li><b>${label}</b>: ${archiveEscape(count)}</li>`;
  const names = list => (list || []).map(row => archiveEscape((row.name || row.code) + (row.year ? ' (' + row.year + ')' : ''))).join(', ');
  return `<section class="archive-rated"><h3>Оценённые фильмы</h3><p class="muted">Предпросмотр ничего не скачивает и не называет непроверенный фильм подтверждённым. Короткий код boxd.it — это ключ кандидата, не id фильма и не членство в watchlist.</p><ul>${item('Уже сопоставлены', rated.matched || 0)}${item('Новые кандидаты на проверку', rated.pending || 0)}${item('Ошибки и неоднозначности', rated.needsReview || 0)}</ul>${rated.pendingRows && rated.pendingRows.length ? `<p>Кандидаты: ${names(rated.pendingRows)}.</p>` : ''}${rated.reviewRows && rated.reviewRows.length ? `<p>На проверке: ${names(rated.reviewRows)}.</p>` : ''}</section>`;
}
function archiveProposalHtml(answer) {
  const proposal = answer.proposal || {};
  if (proposal.status === 'unavailable') return '<p class="muted">Предложение не посчитано: факты в R2 не прочитались.</p>';
  const outcomes = ['new', 'replaces', 'unchanged', 'older', 'tie', 'unverified'];
  const rows = Object.entries(proposal.byFact || {}).map(([fact, counts]) => `<tr><th scope="row">${archiveEscape(ARCHIVE_FACT_TEXT[fact] || fact)}</th>${outcomes.map(code => `<td>${counts[code] ?? 0}</td>`).join('')}</tr>`).join('');
  const reads = proposal.recordReads || {};
  const films = proposal.films || {};
  const values = proposal.values;
  const split = values ? `<p class="muted">Колонки — исход записи и не меняются. «Без изменений» значит, что наблюдение совпало целиком, а не что значение случайно то же. Среди «заменит наблюдение»: то же значение ${values.sameValueUpdates || 0}, другое значение ${values.changedValues || 0}. Запись по-прежнему видит один исход replaces.</p>` : '';
  return `<div class="archive-table-wrap"><table class="archive-table"><caption>Факты по исходу</caption><thead><tr><th scope="col">факт</th>${outcomes.map(code => `<th scope="col">${archiveEscape(ARCHIVE_OUTCOME_TEXT[code])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    + split
    + archiveFacts([
      ['фильмы', 'сравнено ' + archiveEscape(films.compared ?? 0) + ' · не проверено ' + archiveEscape(films.unverified ?? 0) + ' · конфликт псевдонимов ' + archiveEscape(films.aliasConflict ?? 0) + ' · недопустимый id ' + archiveEscape(films.invalidIdentity ?? 0) + ' · удержано до идентичности ' + archiveEscape(films.heldForIdentity ?? 0)],
      ['записи фактов', 'прочитано ' + archiveEscape(reads.done ?? 0) + ' из нужных ' + archiveEscape(reads.needed ?? 0) + ' (лимит ' + archiveEscape(reads.limit ?? '—') + ')'],
      ['статус', proposal.status === 'complete' ? 'посчитано полностью' : 'частично: ' + archiveEscape((proposal.reasons || []).join(', '))],
    ]);
}

function archiveFactOutcome(row, fact, outcome) {
  if (outcome !== 'replaces') return ARCHIVE_OUTCOME_TEXT[outcome] || outcome;
  const kind = row.valueKind && row.valueKind[fact];
  if (kind === 'same') return 'обновит наблюдение, значение то же';
  if (kind === 'changed') return 'заменит наблюдение, значение другое';
  const current = row.current && row.current[fact];
  const proposed = row.facts ? row.facts[fact] : undefined;
  if (current && JSON.stringify(current.value) === JSON.stringify(proposed)) return 'обновит наблюдение, значение то же';
  return 'заменит наблюдение, значение другое';
}
function archiveRowHtml(kind, row) {
  if (kind === 'invalidRows') return `<li><b>${archiveEscape(row.file)}</b>, запись ${archiveEscape(row.record)}: ${archiveEscape(ARCHIVE_INVALID_TEXT[row.reason] || row.reason)}</li>`;
  const title = archiveEscape(row.name || row.code) + (row.year ? ' (' + archiveEscape(row.year) + ')' : '');
  const meta = [row.code, row.method ? ARCHIVE_METHOD_TEXT[row.method] || row.method : null, row.status && row.status !== 'accepted' ? ARCHIVE_STATUS_TEXT[row.status] || row.status : null, row.reason ? ARCHIVE_REASON_TEXT[row.reason] || row.reason : null, row.held ? ARCHIVE_HELD_TEXT[row.held] || row.held : null].filter(Boolean);
  const facts = Object.entries(row.facts || {}).map(([fact, value]) => {
    const current = row.current && row.current[fact];
    const outcome = row.outcomes && row.outcomes[fact];
    const shown = value === null ? 'без оценки' : value === true ? 'да' : String(value);
    return archiveEscape(ARCHIVE_FACT_TEXT[fact] || fact) + ': ' + archiveEscape(shown) + (outcome ? ' — ' + archiveEscape(archiveFactOutcome(row, fact, outcome)) : '') + (current ? ' (в R2: ' + archiveEscape(current.value === null ? 'без оценки' : current.value === true ? 'да' : current.value === false ? 'нет' : current.value) + ', ' + archiveEscape(archiveDate(current.observedAt)) + ')' : '');
  });
  return `<li><b>${title}</b> <small class="muted">${archiveEscape(meta.join(' · '))}</small>${facts.length ? `<br><span class="archive-row-facts">${facts.join('; ')}</span>` : ''}</li>`;
}

function archiveDetailsHtml(answer) {
  const details = answer.details || {};
  return Object.keys(ARCHIVE_DETAIL_TEXT).filter(kind => details[kind]).map(kind => {
    const list = details[kind], [title, hint] = ARCHIVE_DETAIL_TEXT[kind];
    const shown = list.rows.length < list.total ? 'показано ' + list.rows.length + ' из ' + list.total : String(list.total);
    return `<details class="archive-details"${list.total ? '' : ' data-empty="true"'}><summary>${archiveEscape(title)} <small>${archiveEscape(shown)}</small></summary><p class="muted">${archiveEscape(hint)}</p>${list.rows.length ? `<ul>${list.rows.map(row => archiveRowHtml(kind, row)).join('')}</ul>` : '<p class="muted">Нет.</p>'}</details>`;
  }).join('');
}

function archiveChangeLine(changes) {
  const counts = changes || {};
  return ['new', 'replaces', 'unchanged', 'older'].filter(code => counts[code]).map(code => ARCHIVE_OUTCOME_TEXT[code] + ': ' + counts[code]).join(' · ') || 'без фактов';
}
function archiveValueLine(values) {
  if (!values) return '';
  const fresh = (values.newValues || 0) + (values.changedValues || 0);
  const same = values.sameValueUpdates || 0;
  return `<p>Новых или изменённых значений: ${fresh}. Обновлений наблюдений без смены значения: ${same}. Запись в R2 произойдёт только после отдельного подтверждения.</p>`;
}
const ARCHIVE_COUNT_TEXT = {written: 'записано', already_applied: 'уже было', skipped_changed: 'пропущено', failed: 'ошибки', unknown: 'неизвестно', not_attempted: 'не начато'};
function archiveCountLine(counts) {
  return ['written', 'already_applied', 'skipped_changed', 'failed', 'unknown', 'not_attempted'].filter(code => counts && counts[code]).map(code => ARCHIVE_COUNT_TEXT[code] + ': ' + counts[code]).join(' · ');
}
function archiveCommitText(number, done) {
  const counts = done.counts || {};
  const line = archiveCountLine(counts);
  const detail = line ? ' ' + line + '.' : '';
  const wrote = counts.written || 0;
  const skipped = counts.skipped_changed || 0;
  const failed = counts.failed || 0;
  if (done.state === 'succeeded') {
    const replay = done.replayed ? ' Повтор ничего не меняет.' : '';
    return wrote ? `Партия ${number} записана полностью.${detail}${replay}` : `Партия ${number} уже была записана.${detail}${replay}`;
  }
  if (done.state === 'partial') return `Партия ${number} записана частично.${detail} Это не успех.`;
  if (done.state === 'failed' && !wrote && !failed && skipped) return `Факты партии ${number} не изменились: более новые записи оставлены.${detail}`;
  if (done.state === 'failed' || done.state === 'aborted' || done.state === 'refused') return `Партия ${number} не записана.${detail} Это не успех.`;
  if (done.state === 'unknown' && done.inProgress) return `Партия ${number} уже записывается. Исход ещё не получен. Повтори ту же запись тем же ключом. Это не отказ и не успех.`;
  if (done.state === 'unknown' && done.transport && done.rollback) return `Исход отката партии ${number} неизвестен. Запрос уже ушёл, ответ не получен. Откат мог начаться. Повтор вслепую не запускается. Это не успех.`;
  if (done.state === 'unknown' && done.transport) return `Исход партии ${number} неизвестен. Запрос на запись уже ушёл, ответ не получен. Запись могла начаться.${detail} Повтор вслепую не запускается. Это не успех.`;
  if (done.state === 'unknown') return `Исход партии ${number} неизвестен.${detail} Повтор вслепую не запускается. Это не успех.`;
  return `Партия ${number}: состояние ${done.state || '—'}.${detail}`;
}
function archiveBatchIntro() {
  return '<p class="muted archive-apply-note">Запись не начинается сама. Сначала «Подтвердить партию» — сервер запоминает только согласие, без фактов. Затем «Записать партию» отправляет тот же архив ещё раз. Откат — тоже два отдельных шага. Архив нигде не сохраняется, поэтому новая проверка и новая запись просят выбрать файл снова. Одной кнопки на весь архив нет.</p>';
}
function archiveRollbackRefusedBanner(error) {
  const known = {
    confirmation_expired: 'Подтверждение отката истекло.',
    confirmation_mismatch: 'Подтверждение отката не совпало с партией.',
    confirmation_missing: 'Подтверждение отката не найдено.',
    record_changed: 'Факты изменились после записи.',
    not_eligible: 'Откат этой партии сейчас недоступен.',
    invalid_request: 'Запрос отката не принят.',
    idempotency_conflict: 'Ключ отката занят другой командой.',
    stale_pin: 'Откат не сошёлся с квитанцией импорта.',
  };
  return (known[error] || 'Сервер отклонил откат.') + ' Запись, если она прошла, остаётся. Это не отмена записи.';
}
function archiveRollbackText(number, done) {
  if (done.inProgress) return `Откат партии ${number} уже выполняется. Исход ещё не получен. Повтори тот же откат тем же ключом. Это не отказ и не успех.`;
  if (done.state === 'refused') return `Откат партии ${number} отклонён. Запись, если она прошла, остаётся. Это не отмена записи.`;
  return `Исход отката партии ${number} неизвестен. Запрос уже ушёл, ответ не получен. Откат мог начаться. Повтор вслепую не запускается. Это не успех.`;
}
function archiveRollbackHtml(chunk, number, rollback) {
  return rollback
    ? `<div class="archive-actions"><button type="button" class="admin-more" data-archive-rollback="${chunk.chunk}">Откатить партию ${number}</button></div>`
    : `<div class="archive-actions"><button type="button" class="admin-more" data-archive-rollback-confirm="${chunk.chunk}">Подтвердить откат партии ${number}</button></div>`;
}
function archiveStaleNote() {
  return '<p class="archive-callout archive-callout-warn" role="alert"><b>Эта проверка относится к другому файлу.</b> <span>Разница и новые кнопки записи выключены, пока выбранный сейчас файл не пройдёт свою проверку. Смена файла сервер не откатывает.</span></p>';
}
function archiveActionHtml(answer, session) {
  const batches = answer.batches;
  if (!batches) return archiveBatchIntro() + '<p>Нет партии, которую можно подтвердить.</p>';
  const issued = session && session.issued || {};
  const committed = session && session.committed || {};
  const confirmUnknown = session && session.confirmUnknown || {};
  const stale = !!(session && session.stale);
  const inflight = session && session.inflight;
  const chunks = batches.chunks || [];
  if (!chunks.length) return archiveBatchIntro() + `<p>${archiveEscape(ARCHIVE_BATCH_REASON[batches.reason] || 'Нет партии, которую можно подтвердить.')}</p>`;
  const saved = chunks.some(chunk => chunk.kind === 'candidates') ? '<article class="archive-batch"><h3>Сохранённые кандидаты</h3><p class="muted">Повторная проверка этого архива читает очередь, которая уже записана. Она ничего не скачивает.</p><div class="archive-actions"><button type="button" class="admin-more" data-archive-status="1">Прочитать сохранённое состояние</button></div></article>' : '';
  return archiveBatchIntro() + saved + chunks.map(chunk => {
    const number = chunk.chunk + 1;
    const held = issued[chunk.chunk];
    const done = committed[chunk.chunk];
    const why = !chunk.confirmable ? `<p class="archive-callout archive-callout-warn" role="status">${archiveEscape(ARCHIVE_BATCH_REASON[chunk.reason] || 'Эту партию сейчас подтвердить нельзя.')}</p>` : '';
    const waiting = inflight && inflight.chunk === chunk.chunk;
    let actions = '';
    if (done && done.pending) actions += '';
    else if (done || (chunk.receipt && chunk.receipt.status === 'committed')) actions += '<p class="muted">Эта партия уже отправлена или уже есть в квитанции импорта. Итог и откат — в квитанции, отдельным подтверждением.</p>';
    else if (stale && !confirmUnknown[chunk.chunk]) actions += '<p class="muted">Запись по этой проверке выключена: выбран другой файл.</p>';
    else if (confirmUnknown[chunk.chunk] && !held) actions += waiting ? '' : `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-confirm="${chunk.chunk}">Повторить то же подтверждение</button></div><p class="muted">Ответ на подтверждение не получен. Согласие могло сохраниться. Повтор отправит тот же ключ и не создаёт новый. Это не запись фактов.</p>${archiveAbandonHtml(chunk.chunk)}`;
    else if (!stale && chunk.confirmable && held) actions += `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-commit="${chunk.chunk}">Записать партию ${number}</button></div><p class="muted">Подтверждение выдано, запись ещё не отправлялась. Запись отправит архив заново. Это не новая партия.</p>`;
    else if (!stale && chunk.confirmable) actions += `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-confirm="${chunk.chunk}">Подтвердить партию ${number}</button></div>`;
    const intro = chunk.kind === 'candidates'
      ? `<p>${chunk.films} оценённых фильмов без принятой идентичности. Запись сохраняет код и архив. Она не подтверждает TMDB, не ставит фильм в watchlist и не скачивает страницу.</p>`
      : `<p>${chunk.films} фильмов, которых предпросмотр сравнил. ${archiveEscape(archiveChangeLine(chunk.changes))}.</p>${archiveValueLine(chunk.values)}`;
    return `<article class="archive-batch"><h3>Партия ${number}</h3>${intro}${why}${actions}</article>`;
  }).join('');
}
function archiveAbandonHtml(chunk) {
  return `<div class="archive-actions"><button type="button" class="admin-more" data-archive-abandon="${chunk}">Забыть команду в этой вкладке</button></div><p class="muted">Это не откат. Команда для повтора исчезнет из вкладки, даже если сервер уже записал факты.</p>`;
}
function archiveIdentityOpen(session) {
  const status = session && session.identityStatus;
  const identity = session && session.identity;
  const committed = session && session.committed && Object.values(session.committed).some(item => item && item.kind === 'candidates' && item.state === 'succeeded');
  const durable = status && status.present && ((status.pending || 0) + (status.admitting || 0) + (status.enrichmentPending || 0) > 0 || status.stopped);
  if (!committed && !durable && !identity) return null;
  if (identity && identity.pending === false && !identity.stop && !durable) return 'done';
  return 'open';
}
function archiveIdentityHtml(session) {
  const open = archiveIdentityOpen(session);
  if (!open) return '';
  const identity = session && session.identity;
  const status = session && session.identityStatus;
  const stopped = (identity && identity.stop) || (status && status.stopped && (status.stopped.reason || status.stopped));
  let note = 'Кандидаты сохранены. Страница Letterboxd и TMDB ещё не читались.';
  if (identity && identity.verified) note = 'Один фильм сверен и добавлен по TMDB. Watchlist не менялся.';
  else if (identity && identity.enriched) note = 'Один фильм получил метаданные или имена. Watchlist не менялся. Это не новая идентичность.';
  else if (identity && identity.stop) note = 'Проверка остановлена (' + identity.stop + '). Кандидат остаётся непроверенным. Это не подтверждение.';
  else if (identity && identity.state === 'needs_review') note = 'Фильм неоднозначен и не добавлен. Это не подтверждение.';
  else if (identity) note = 'Идентичность не подтверждена.';
  if (status && status.present) note += ' Сохранено: ожидают ' + (status.pending || 0) + ', сверяются ' + (status.admitting || 0) + ', метаданные ' + (status.enrichmentPending || 0) + '.';
  const button = open === 'open' ? `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-identity="1">${archiveEscape(stopped ? 'Продолжить проверку' : 'Проверить одну идентичность')}</button></div>` : '';
  return `<article class="archive-batch"><h3>Проверка идентичности</h3><p class="muted" role="status">${archiveEscape(note)}</p>${button}</article>`;
}
function archiveReceiptHtml(answer, session) {
  const batches = answer.batches || {};
  const issued = session && session.issued || {};
  const committed = session && session.committed || {};
  const rollbackIssued = session && session.rollbackIssued || {};
  const confirmUnknown = session && session.confirmUnknown || {};
  const rollbackConfirmUnknown = session && session.rollbackConfirmUnknown || {};
  const rollbackResult = session && session.rollbackResult || {};
  const chunks = batches.chunks || [];
  if (!chunks.length) return '<p class="muted">Квитанции нет: записывать нечего. Проверка ничего не записала.</p>';
  const identityHtml = archiveIdentityHtml(session);
  const inflight = session && session.inflight;
  return chunks.map(chunk => {
    const number = chunk.chunk + 1;
    const done = committed[chunk.chunk];
    const rollback = rollbackIssued[chunk.chunk];
    const attempt = rollbackResult[chunk.chunk];
    const waiting = inflight && inflight.chunk === chunk.chunk;
    const applyReceipt = done && !done.rollback && !done.rolledBack;
    let body = '';
    if (applyReceipt && done.pending) body += '';
    else if (applyReceipt) {
      body += `<p role="status">${archiveEscape(archiveCommitText(number, done))}</p>`;
      if (done.state === 'unknown' && !done.pending) body += `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-commit="${chunk.chunk}">Повторить ту же запись</button></div><p class="muted">Кнопка отправляет то же подтверждение и тот же ключ. Новый запрос не создаётся, и повтор сам не начинается.</p>${archiveAbandonHtml(chunk.chunk)}`;
    }
    if (attempt && attempt.rolledBack) {
      const replay = attempt.replayed ? ' Повтор того же отката ничего не меняет.' : '';
      body += `<p role="status">Откат партии ${number} выполнен.${archiveEscape(replay)} Состояние: ${archiveEscape(attempt.state || '—')}. Более поздняя запись, если она была, сохранена.</p>`;
    } else if (attempt && attempt.pending) body += '';
    else if (attempt && attempt.state === 'unknown') {
      body += `<p role="status">${archiveEscape(archiveRollbackText(number, attempt))}</p>`;
      body += `<div class="archive-actions"><button type="button" class="admin-refresh" data-archive-rollback="${chunk.chunk}">Повторить тот же откат</button></div><p class="muted">Кнопка отправляет то же подтверждение отката и тот же ключ. Новый запрос не создаётся, и повтор сам не начинается.</p>${archiveAbandonHtml(chunk.chunk)}`;
    } else if (attempt && attempt.state === 'refused') body += `<p role="status">${archiveEscape(archiveRollbackText(number, attempt))}</p>`;
    else if (rollbackConfirmUnknown[chunk.chunk] && !rollback) body += waiting ? '' : `<p class="muted">Ответ на подтверждение отката не получен. Повтор отправит тот же ключ. Это не успех.</p><div class="archive-actions"><button type="button" class="admin-refresh" data-archive-rollback-confirm="${chunk.chunk}">Повторить то же подтверждение отката</button></div>${archiveAbandonHtml(chunk.chunk)}`;
    else if (applyReceipt && done.state !== 'unknown' && !done.pending) body += archiveRollbackHtml(chunk, number, rollback);
    else if (!done && !attempt && chunk.receipt && chunk.receipt.status === 'committed' && chunk.confirmable && !(session && session.stale)) {
      body += '<p class="muted">Эта партия уже есть в квитанции импорта. Повтор записи идемпотентен. Откат — отдельное подтверждение.</p>';
      body += archiveRollbackHtml(chunk, number, rollback);
    } else if (!done && !attempt && confirmUnknown[chunk.chunk] && !issued[chunk.chunk]) body += '<p class="muted">Ответ на подтверждение не получен. Запись фактов из этого шага не отправлялась. Неизвестный ответ не называется успехом.</p>' + archiveAbandonHtml(chunk.chunk);
    else if (!done && !attempt && issued[chunk.chunk]) body += '<p class="muted">Квитанции ещё нет: подтверждение выдано, запись ещё не отправлялась. Это не успех.</p>';
    else if (!body) body += '<p class="muted">Квитанции ещё нет. Проверка ничего не записала.</p>';
    return `<article class="archive-batch"><h3>Квитанция партии ${number}</h3>${body}</article>`;
  }).join('') + identityHtml;
}
function archiveTechnicalHtml(answer) {
  const archive = answer.archive || {}, batches = answer.batches || {};
  const files = Object.entries((answer.export && answer.export.files) || {}).map(([, file]) => {
    const entry = archive.files && archive.files[file.name];
    return `<li>${archiveEscape(file.name || 'файл')}: <code>${archiveEscape(entry && entry.sha256 || '—')}</code></li>`;
  }).join('');
  const chunks = (batches.chunks || []).map(chunk => `<li>партия ${chunk.chunk + 1}, id ${archiveEscape(chunk.chunk)}: хэш плана <code>${archiveEscape(chunk.planHash || '—')}</code>${chunk.scopeFingerprint ? '; отпечаток области <code>' + archiveEscape(chunk.scopeFingerprint) + '</code>' : ''}</li>`).join('');
  return `<details class="archive-technical"><summary>Технические подробности</summary><p class="muted">Хэш плана — значение, с которым запись сверяет партию перед compare-and-swap (CAS). Отпечаток области — версии фактов на момент проверки. id прогона — опубликованная программа.</p><dl class="limbo-facts"><div><dt>SHA-256 архива</dt><dd><code class="archive-sha">${archiveEscape(archive.sha256)}</code></dd></div><div><dt>id прогона программы</dt><dd><code>${archiveEscape(batches.programmeRunId || '—')}</code></dd></div></dl><ul>${files}</ul><ul>${chunks}</ul></details>`;
}
function archiveStepPanel(n, title, body) {
  return `<section class="admin-card archive-result archive-step" aria-labelledby="archive-step-${n}-title"><h2 id="archive-step-${n}-title">Шаг ${n}. ${archiveEscape(title)}</h2>${body}</section>`;
}
function archiveNavHtml(options) {
  const back = options && options.back === false ? '' : '<button type="button" class="admin-more" data-archive-nav="back">Назад</button>';
  const next = options && options.next ? `<button type="button" class="admin-refresh" data-archive-nav="${archiveEscape(options.next.step)}">${archiveEscape(options.next.label)}</button>` : '';
  return `<div class="archive-actions archive-nav">${back}${next}</div>`;
}
function archiveSessionHasOutcome(session) {
  if (!session) return false;
  const committed = session.committed || {};
  for (const key in committed) if (committed[key] && !committed[key].pending) return true;
  const rollbackResult = session.rollbackResult || {};
  for (const key in rollbackResult) if (rollbackResult[key] && !rollbackResult[key].pending) return true;
  const unknown = session.rollbackConfirmUnknown || {};
  for (const key in unknown) if (unknown[key]) return true;
  return false;
}
function archiveStepCheckHtml(answer) {
  return archiveStepPanel(2, 'Проверка и свежесть', archiveFreshnessHtml(answer) + archiveNavHtml({next: {step: '3', label: 'Посмотреть разницу'}}) + `<details class="archive-details"><summary>Подробности проверки</summary>${archiveArchiveHtml(answer)}<h3>Базовая линия</h3>${archiveBaselineHtml(answer)}${archiveTechnicalHtml(answer)}</details>`);
}
function archiveStepDiffHtml(answer) {
  return archiveStepPanel(3, 'Разница', archiveSummaryCounts(answer) + archiveRatedHtml(answer) + archiveSummaryTail(answer) + archiveNavHtml({next: {step: '4', label: 'Выбрать партию'}}) + `<details class="archive-details"><summary>Показать подробности</summary>${archiveSummaryNote(answer)}<h3>Сопоставление с R2</h3>${archiveMatchingHtml(answer)}<h3>Что сделал бы импорт</h3>${archiveProposalHtml(answer)}<h3>Фильмы</h3><p class="muted">В каждом списке не больше ${archiveEscape(archiveDetailLimit(answer))} строк.</p>${archiveDetailsHtml(answer)}</details>`);
}
function archiveStepBatchHtml(answer, session) {
  const next = archiveSessionHasOutcome(session) ? {step: '5', label: 'Квитанция'} : null;
  return archiveStepPanel(4, 'Одна партия', archiveActionHtml(answer, session) + archiveNavHtml({next}) + archiveTechnicalHtml(answer));
}
function archiveStepReceiptHtml(answer, session) {
  return archiveStepPanel(5, 'Квитанция', archiveReceiptHtml(answer, session) + archiveNavHtml());
}
function archiveStepReturnHtml() {
  return '<p class="muted archive-note">Проверка этого файла уже есть в этой вкладке. «К проверке» не отправляет архив заново и не читает ZIP ещё раз.</p><div class="archive-actions archive-nav"><button type="button" class="admin-more" data-archive-nav="2">К проверке</button></div>';
}
function archivePreviewHtml(answer, session) {
  const held = session || {};
  const step = held.viewStep;
  let html = step === 3 ? archiveStepDiffHtml(answer) : step === 4 ? archiveStepBatchHtml(answer, held) : step === 5 ? archiveStepReceiptHtml(answer, held) : archiveStepCheckHtml(answer);
  if (held.stale) html = html.replace('</h2>', '</h2>' + archiveStaleNote());
  return html;
}
function archiveDetailLimit(answer) {return answer.details && answer.details.limit || 25;}
