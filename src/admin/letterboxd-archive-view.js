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
  unexpected_answer: 'Сервер ответил не предпросмотром. Ничего не показано.',
  network: 'Нет ответа от сервера. Проверь соединение и доступ и повтори.',
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
const ARCHIVE_DETAIL_TEXT = {
  adds: ['Добавится', 'факты, которых у фильма в R2 ещё нет'],
  updates: ['Изменится', 'значение в R2 другое и старше архива'],
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

function archiveFreshnessHtml(answer) {
  const freshness = answer.freshness || {};
  const verdict = freshness.verdict || (freshness.needsFreshArchive ? 'needs_fresh' : 'verified');
  const age = `Экспорт сделан ${archiveEscape(archiveAge(freshness.ageMs))} назад (порог ${archiveEscape(archiveAge(freshness.archiveStaleMs))}).`;
  if (verdict === 'inconclusive') return `<div class="archive-callout archive-callout-warn" role="status"><b>Сравнение неполное, свежесть оценок не подтверждена</b><span>${age} Прочитанных оценок недостаточно, чтобы решить, нужен ли новый экспорт.</span></div>`;
  if (verdict !== 'needs_fresh') return `<div class="archive-callout archive-callout-ok" role="status"><b>Архив достаточно свежий</b><span>${age} Среди проверенных фильмов ни одна оценка не новее этого архива.</span></div>`;
  const reasons = (freshness.reasons || []).map(reason => reason === 'archive_stale'
    ? `<li>Экспорту ${archiveEscape(archiveAge(freshness.ageMs))}: это больше порога ${archiveEscape(archiveAge(freshness.archiveStaleMs))}.</li>`
    : reason === 'ratings_newer_in_r2' ? `<li>У ${freshness.ratingsNewerInR2} проверенных фильм(ов) оценка в R2 новее этого архива: значит, после экспорта оценки менялись.</li>`
    : reason === 'ratings_unconfirmed' ? '<li>Остальные оценки не подтверждены: часть записей не прочитана или источники были недоступны. Это число не охватывает все оценки в R2.</li>'
    : `<li>${archiveEscape(reason)}</li>`).join('');
  return `<div class="archive-callout archive-callout-warn" role="alert"><b>Нужен свежий архив</b><ul>${reasons}</ul><span>Скачай новый экспорт в настройках Letterboxd и проверь его здесь.</span></div>`;
}

function archiveSummaryHtml(answer) {
  const archive = answer.archive || {}, proposal = answer.proposal || {}, facts = proposal.facts || {}, details = answer.details || {};
  const tone = answer.status === 'complete' ? 'reviewed' : 'provisional';
  const cards = [
    ['добавится', details.adds ? details.adds.total : '—'],
    ['изменится', details.updates ? details.updates.total : '—'],
    ['без изменений', facts.unchanged ?? '—'],
    ['в R2 новее', details.heldNewer ? details.heldNewer.total : '—'],
    ['удержано', (details.conflicts ? details.conflicts.total : 0) + (details.identity ? details.identity.total : 0)],
    ['не проверено', details.unverified ? details.unverified.total : '—'],
  ];
  return `<div class="archive-summary-head">${archiveBadge(tone, answer.status === 'complete' ? 'полный предпросмотр' : 'частичный предпросмотр')}${archiveBadge('plain', 'ничего не записано')}<span class="muted">оценка на ${archiveEscape(archiveDate(answer.evaluatedAt))}</span></div>`
    + `<div class="archive-totals">${cards.map(([name, value]) => `<div class="archive-total"><b>${archiveEscape(value)}</b><span>${archiveEscape(name)}</span></div>`).join('')}</div>`
    + `<p class="muted archive-note">Фильмов в архиве: ${answer.export ? answer.export.films : '—'}; сопоставлено и принято: ${proposal.films ? proposal.films.accepted : '—'}. «Добавится» и «изменится» считаются по фильмам; «без изменений» — по фактам. Импорт здесь не выполняется: это отдельный шаг с отдельным разрешением.</p>`
    + (answer.consistency && answer.consistency.status !== 'stable' ? '<p class="archive-callout archive-callout-warn" role="alert"><b>Данные в R2 менялись во время проверки.</b> Сравнение смешивает два состояния: повтори проверку.</p>' : '')
    + (archive.generatedAtSource === 'owner_declared' ? '<p class="muted archive-note">Время экспорта указано вручную: имя файла нестандартное.</p>' : '');
}

function archiveArchiveHtml(answer) {
  const archive = answer.archive || {}, exported = answer.export || {}, completeness = answer.completeness || {};
  const files = Object.entries(exported.files || {}).map(([kind, file]) => {
    const entry = archive.files && archive.files[file.name];
    if (!file.present) return `<tr><th scope="row">${archiveEscape(file.name)}</th><td colspan="5">${file.auxiliary ? 'нет (вспомогательный файл)' : 'нет в архиве'}</td></tr>`;
    return `<tr><th scope="row">${archiveEscape(file.name)}${file.auxiliary ? ' <small class="muted">вспом.</small>' : ''}</th><td>${file.records}</td><td>${file.valid}</td><td>${Object.values(file.invalid || {}).reduce((a, b) => a + b, 0)}</td><td>${file.duplicates} / ${file.conflicts}</td><td><code title="${archiveEscape(entry && entry.sha256)}">${archiveEscape(entry ? entry.sha256.slice(0, 12) : '—')}</code></td></tr>`;
  }).join('');
  const rows = [
    ['время экспорта', archiveEscape(archiveDate(archive.generatedAt)) + ' · ' + (archive.generatedAtSource === 'archive_name' ? 'из имени файла' : 'указано вручную') + ' · ' + archiveEscape(archiveAge(archive.ageMs)) + ' назад'],
    ['SHA-256', `<code class="archive-sha">${archiveEscape(archive.sha256)}</code>`],
    ['размер', archiveEscape(archiveBytes(archive.bytes)) + ' · файлов в архиве ' + archiveEscape(archive.entries) + ', из них не читались ' + archiveEscape(archive.ignoredEntries)],
    ['полнота', completeness.status === 'complete' ? 'все четыре файла на месте' : 'нет: ' + archiveEscape((completeness.missing || []).join(', '))],
    ['наборы', archiveCounts(exported.sets, ARCHIVE_SET_TEXT)],
    ['расхождения', 'название или год расходятся между файлами: ' + archiveEscape(exported.crossFileMismatches ?? 0) + ' · негодных строк: ' + archiveEscape(exported.invalidRows ?? 0) + (exported.invalidRows ? ' (' + archiveCounts(exported.invalidByReason, ARCHIVE_INVALID_TEXT) + ')' : '')],
  ];
  return archiveFacts(rows) + `<div class="archive-table-wrap"><table class="archive-table"><caption>Файлы экспорта</caption><thead><tr><th scope="col">файл</th><th scope="col">записей</th><th scope="col">годных</th><th scope="col">негодных</th><th scope="col">дубли / конфликты</th><th scope="col">SHA-256</th></tr></thead><tbody>${files}</tbody></table></div>`;
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

function archiveProposalHtml(answer) {
  const proposal = answer.proposal || {};
  if (proposal.status === 'unavailable') return '<p class="muted">Предложение не посчитано: факты в R2 не прочитались.</p>';
  const outcomes = ['new', 'replaces', 'unchanged', 'older', 'tie', 'unverified'];
  const rows = Object.entries(proposal.byFact || {}).map(([fact, counts]) => `<tr><th scope="row">${archiveEscape(ARCHIVE_FACT_TEXT[fact] || fact)}</th>${outcomes.map(code => `<td>${counts[code] ?? 0}</td>`).join('')}</tr>`).join('');
  const reads = proposal.recordReads || {};
  const films = proposal.films || {};
  return `<div class="archive-table-wrap"><table class="archive-table"><caption>Факты по исходу</caption><thead><tr><th scope="col">факт</th>${outcomes.map(code => `<th scope="col">${archiveEscape(ARCHIVE_OUTCOME_TEXT[code])}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    + archiveFacts([
      ['фильмы', 'сравнено ' + archiveEscape(films.compared ?? 0) + ' · не проверено ' + archiveEscape(films.unverified ?? 0) + ' · конфликт псевдонимов ' + archiveEscape(films.aliasConflict ?? 0) + ' · недопустимый id ' + archiveEscape(films.invalidIdentity ?? 0) + ' · удержано до идентичности ' + archiveEscape(films.heldForIdentity ?? 0)],
      ['записи фактов', 'прочитано ' + archiveEscape(reads.done ?? 0) + ' из нужных ' + archiveEscape(reads.needed ?? 0) + ' (лимит ' + archiveEscape(reads.limit ?? '—') + ')'],
      ['статус', proposal.status === 'complete' ? 'посчитано полностью' : 'частично: ' + archiveEscape((proposal.reasons || []).join(', '))],
    ]);
}

function archiveRowHtml(kind, row) {
  if (kind === 'invalidRows') return `<li><b>${archiveEscape(row.file)}</b>, запись ${archiveEscape(row.record)}: ${archiveEscape(ARCHIVE_INVALID_TEXT[row.reason] || row.reason)}</li>`;
  const title = archiveEscape(row.name || row.code) + (row.year ? ' (' + archiveEscape(row.year) + ')' : '');
  const meta = [row.code, row.method ? ARCHIVE_METHOD_TEXT[row.method] || row.method : null, row.status && row.status !== 'accepted' ? ARCHIVE_STATUS_TEXT[row.status] || row.status : null, row.reason ? ARCHIVE_REASON_TEXT[row.reason] || row.reason : null, row.held ? ARCHIVE_HELD_TEXT[row.held] || row.held : null].filter(Boolean);
  const facts = Object.entries(row.facts || {}).map(([fact, value]) => {
    const current = row.current && row.current[fact];
    const outcome = row.outcomes && row.outcomes[fact];
    const shown = value === null ? 'без оценки' : value === true ? 'да' : String(value);
    return archiveEscape(ARCHIVE_FACT_TEXT[fact] || fact) + ': ' + archiveEscape(shown) + (outcome ? ' — ' + archiveEscape(ARCHIVE_OUTCOME_TEXT[outcome] || outcome) : '') + (current ? ' (в R2: ' + archiveEscape(current.value === null ? 'без оценки' : current.value === true ? 'да' : current.value === false ? 'нет' : current.value) + ', ' + archiveEscape(archiveDate(current.observedAt)) + ')' : '');
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

function archivePreviewHtml(answer) {
  return `<section class="admin-card archive-result" aria-labelledby="archive-summary-title"><h2 id="archive-summary-title">Итог предпросмотра</h2>${archiveFreshnessHtml(answer)}${archiveSummaryHtml(answer)}</section>`
    + `<section class="admin-card archive-result" aria-labelledby="archive-file-title"><h2 id="archive-file-title">Архив</h2>${archiveArchiveHtml(answer)}</section>`
    + `<section class="admin-card archive-result" aria-labelledby="archive-baseline-title"><h2 id="archive-baseline-title">Базовая линия</h2>${archiveBaselineHtml(answer)}</section>`
    + `<section class="admin-card archive-result" aria-labelledby="archive-matching-title"><h2 id="archive-matching-title">Сопоставление с R2</h2>${archiveMatchingHtml(answer)}</section>`
    + `<section class="admin-card archive-result" aria-labelledby="archive-proposal-title"><h2 id="archive-proposal-title">Что сделал бы импорт</h2>${archiveProposalHtml(answer)}</section>`
    + `<section class="admin-card archive-result" aria-labelledby="archive-details-title"><h2 id="archive-details-title">Фильмы</h2><p class="muted">В каждом списке не больше ${archiveEscape(archiveDetailLimit(answer))} строк.</p>${archiveDetailsHtml(answer)}</section>`;
}
function archiveDetailLimit(answer) {return answer.details && answer.details.limit || 25;}
