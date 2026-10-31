const POSTERS_ERROR_TEXT = {
  storage_unavailable: 'Хранилище не ответило. Ничего не изменено; попробуйте перечитать.',
  health_unavailable: 'Не удалось оценить покрытие. Ничего не изменено.',
  invalid_limit: 'Размер пакета вне допустимого диапазона.',
  invalid_cursor: 'Сохранённая позиция повреждена. Выберите «с начала очереди».',
  network: 'Сервер недоступен. Проверьте соединение и перечитайте.',
};
const POSTERS_COPY_ROLE = {generation: 'копия поколения', live: 'живой каталог'};

const postersLive = {read: null, preview: null, confirmation: null, running: false, stop: false, pending: null, history: null, notice: ''};

function postersEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function postersDate(value) {
  if (value === null || value === undefined || value === '') return 'нет отметки';
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}).format(new Date(parsed)) + ' Madrid';
}

function postersStorage() {
  try {return window.localStorage || null;} catch {return null;}
}

function postersHistoryLoad() {
  const storage = postersStorage();
  let raw = null;
  try {raw = storage ? storage.getItem(POSTER_HISTORY_KEY) : null;} catch {raw = null;}
  return posterHistoryRead(raw);
}

function postersHistorySave(history) {
  postersLive.history = history;
  const storage = postersStorage();
  try {if (storage) storage.setItem(POSTER_HISTORY_KEY, JSON.stringify(history));} catch {}
}

function postersOptions() {
  return {
    limit: Number(document.querySelector('#posters-limit').value) || POSTER_BATCH_MAX,
    calls: Number(document.querySelector('#posters-calls').value) || 1,
    start: document.querySelector('#posters-start').value === 'first' ? 'first' : 'continue',
  };
}

function postersTitle(item) {
  const title = item.title || item.id;
  return item.year ? `${title} (${item.year})` : title;
}

function postersShow(selector, visible) {document.querySelector(selector).hidden = !visible;}

// One coverage read. A saved position is used only for the generation it was saved under; otherwise the queue starts over.
async function postersRead(limit, start) {
  const history = postersLive.history;
  const saved = start === 'continue' && history.resume ? history.resume : null;
  let answer = await loadPosterCoverage({limit, cursor: saved ? saved.cursor : null});
  postersLive.notice = '';
  if (saved && answer.ok && (answer.body.programmeRunId || null) !== (saved.programmeRunId || null)) {
    postersLive.notice = 'Сохранённая позиция относилась к другому поколению программы, поэтому очередь показана с начала.';
    answer = await loadPosterCoverage({limit, cursor: null});
  }
  return answer;
}

function postersSnapshotText(read) {
  const copies = (read.copies || []).map(copy => `${POSTERS_COPY_ROLE[copy.role] || copy.role}: ${!copy.present ? 'нет объекта' : copy.readable === false ? 'не читается как каталог' : copy.records + ' записей'}`).join(', ');
  return `Поколение ${String(read.programmeRunId || '—').slice(0, 8)} · прочитано ${postersDate(read.observedAt)} · ${copies}. Данные — из R2 сейчас; запись постеров на этой странице только по подтверждению.`;
}

function postersCopyState(copy) {
  if (!copy.present) return 'объекта нет';
  if (copy.readable === false) return 'объект есть, но не читается как каталог';
  return `записей ${copy.records}, без постера ${copy.missingPoster}, восстановимых ${copy.verifiedMissing}`;
}

function postersCoverageHtml(read, before) {
  const coverage = posterCoverage(read);
  const change = (field) => before && before.complete && coverage.complete && before[field] !== coverage[field] ? ` <small class="posters-change">было ${before[field]}</small>` : '';
  const rows = [
    ['Записей в каталоге', coverage.catalogRecords, 'catalogRecords'],
    ['С постером', coverage.withPoster, 'withPoster'],
    ['Без постера', coverage.missingPoster, 'missingPoster'],
    ['Можно восстановить (проверенный TMDB id)', coverage.verifiedMissing, 'verifiedMissing'],
    ['Нельзя восстановить (нет проверенного TMDB id)', coverage.unverifiedMissing, 'unverifiedMissing'],
  ];
  const known = Object.keys(postersLive.history.terminal || {}).length;
  const note = known ? `<p class="posters-source">Из восстановимых этот браузер уже знает ${known} с окончательным отказом (на TMDB постера нет или TMDB ответил за другой фильм). Сервер такие исходы не хранит, поэтому они остаются в счёте «можно восстановить».</p>` : '';
  const incomplete = coverage.complete ? '' : `<div class="action-status action-tone-blocked" id="posters-incomplete"><p><b>Покрытие неизвестно: данные неполные.</b> Числа ниже не считаются нулём, запуск недоступен, пока данные не будут полными. Страница эти объекты не создаёт и не чинит.</p><ul class="posters-list">${coverage.problems.map(code => `<li>${postersEscape(posterEvidenceText(code))}</li>`).join('')}</ul><ul class="posters-list">${(read.copies || []).map(copy => `<li>${postersEscape(POSTERS_COPY_ROLE[copy.role] || copy.role)}: ${postersEscape(postersCopyState(copy))}</li>`).join('')}</ul></div>`;
  return `${incomplete}<dl class="posters-facts">${rows.map(([label, value, field]) => `<div data-posters-field="${field}"><dt>${postersEscape(label)}</dt><dd><b>${value === null ? 'неизвестно' : value}</b>${change(field)}</dd></div>`).join('')}</dl>${note}
    <details class="action-tech"><summary>Технические подробности</summary><dl class="action-facts">${(read.copies || []).map(copy => `<div><dt>${postersEscape(copy.key)}</dt><dd>${postersEscape(postersCopyState(copy))}${copy.version ? `, версия ${postersEscape(copy.version)}` : ''}</dd></div>`).join('')}${coverage.complete ? '' : `<div><dt>Полнота</dt><dd>${postersEscape(coverage.problems.join(', '))}</dd></div>`}<div><dt>Проверка здоровья</dt><dd>${postersEscape(read.health?.issue ? `${read.health.issue.id} · ${read.health.issue.severity} · ${read.health.issue.action?.code}/${read.health.issue.action?.reason}` : 'проблем нет')}</dd></div><div><dt>Прочитано</dt><dd>${postersEscape((read.reads || []).join(', '))}</dd></div></dl></details>`;
}

function postersBacklogText(read) {
  const coverage = posterCoverage(read);
  if (!coverage || !coverage.backlog) return '';
  return `Накопилось ${coverage.verifiedMissing} записей без постера, которые можно восстановить (порог — ${coverage.backlogThreshold}). Предупреждение зависит только от числа восстановимых записей, а не от времени с последнего запуска.`;
}

function postersDynamicsHtml(history) {
  const parts = [];
  parts.push(history.lastSuccess ? `<p>Последняя успешная дозагрузка: <b>${postersDate(history.lastSuccess.at)}</b>, записано постеров: ${history.lastSuccess.hydrated}.</p>` : '<p>В этом браузере успешных дозагрузок ещё не было.</p>');
  if (history.retryAt) parts.push(`<p class="posters-warning">TMDB просил подождать до ${postersDate(history.retryAt)}.</p>`);
  const observations = history.observations.slice(-6).reverse();
  if (observations.length) parts.push(`<h3>Чтения покрытия</h3><ul class="posters-list">${observations.map(item => `<li>${postersDate(item.at)} · без постера ${item.missingPoster} · восстановимых ${item.verifiedMissing} · без проверенного id ${item.unverifiedMissing ?? '—'}</li>`).join('')}</ul>`);
  const receipts = history.receipts.slice(-5).reverse();
  if (receipts.length) parts.push(`<h3>Запуски</h3><ul class="posters-list">${receipts.map(item => `<li>${postersDate(item.finishedAt)} · вызовов ${item.calls} · записано ${item.hydrated}${item.noPoster ? ` · без постера на TMDB ${item.noPoster}` : ''}${item.retryable ? ` · можно повторить ${item.retryable}` : ''} · ${postersEscape(posterStopText(item.stop))}</li>`).join('')}</ul>`);
  return parts.join('');
}

function postersUnverifiedHtml(read) {
  const unverified = read.unverified || {count: null, sample: []};
  if (!posterCoverage(read)?.complete || !Number.isInteger(unverified.count)) return '<p>Неизвестно: данные неполные.</p>';
  if (!unverified.count) return '<p>Таких записей нет.</p>';
  const more = unverified.count > unverified.sample.length ? `<p class="muted">Показаны первые ${unverified.sample.length} из ${unverified.count}.</p>` : '';
  return `<ul class="posters-list">${unverified.sample.map(item => `<li><b>${postersEscape(postersTitle(item))}</b> · ${postersEscape(posterUnverifiedText(item.reason))} <small class="muted">${postersEscape(item.id)}</small></li>`).join('')}</ul>${more}`;
}

function postersStartText(cursor) {
  return cursor ? `после записи ${cursor}` : 'с начала очереди';
}

function postersPreviewHtml(preview) {
  const copy = POSTER_PREVIEW_COPY[preview.status] || POSTER_PREVIEW_COPY.unknown;
  const lines = [`<div class="action-status action-tone-${copy.tone}"><p><b>${postersEscape(copy.headline)}</b></p>`];
  if (preview.status === 'rate_limited') lines.push(`<p class="action-next">Следующая попытка — не раньше ${postersDate(preview.retryAt)}.</p>`);
  if (preview.status === 'end_of_queue') lines.push('<p class="action-next">Выберите «с начала очереди», чтобы пройти её заново.</p>');
  if (preview.status === 'unverified_only') lines.push('<p class="action-next">Нужна проверка идентичности этих записей — это другая работа.</p>');
  if (preview.status === 'incomplete') lines.push(`<ul class="posters-list">${preview.coverage.problems.map(code => `<li>${postersEscape(posterEvidenceText(code))}</li>`).join('')}</ul><p class="action-next">Ничего не отправлено. Подтвердить запуск можно только по полным данным; восстановление недостающих объектов — отдельная работа.</p>`);
  lines.push('</div>');
  if (preview.status === 'eligible') {
    const terminal = postersLive.history.terminal || {};
    lines.push(`<p>В очереди ${postersEscape(postersStartText(preview.cursor))}: <b>${preview.remaining}</b> записей. За этот запуск — до ${preview.calls} вызовов по ${preview.limit}, то есть не больше <b>${preview.maxRecords}</b> записей (сейчас подходит ${preview.planned}).</p>`);
    lines.push(`<h3 class="action-result-title">Первый пакет</h3><ol class="action-items">${preview.items.map(item => `<li><b>${postersEscape(postersTitle(item))}</b><span class="muted">TMDB ${postersEscape(item.tmdbId)} · ${postersEscape(item.id)}${terminal[item.id] ? ' · в прошлый раз: ' + postersEscape(posterOutcomeText(terminal[item.id])) : ''}</span></li>`).join('')}</ol>`);
    lines.push('<p class="action-next">Проверка ничего не записала и не обращалась к TMDB.</p>');
  }
  return lines.join('');
}

function postersAcceptText(preview) {
  return `Подтверждаю: до ${preview.calls} вызовов по ${preview.limit} записей, не больше ${preview.maxRecords} записей, ${postersStartText(preview.cursor)}, поколение ${String(preview.coverage.programmeRunId || '—').slice(0, 8)}. Подтверждение действует 10 минут и один раз; перед первым вызовом страница перечитает очередь.`;
}

function postersSetPreview(preview) {
  postersLive.preview = preview;
  postersLive.confirmation = null;
  const accept = document.querySelector('#posters-accept');
  accept.checked = false;
  document.querySelector('#posters-preview').innerHTML = postersPreviewHtml(preview) + (postersLive.notice ? `<p class="action-next">${postersEscape(postersLive.notice)}</p>` : '');
  postersShow('#posters-accept-label', preview.status === 'eligible' && !postersLive.running);
  document.querySelector('#posters-accept-text').textContent = preview.status === 'eligible' ? postersAcceptText(preview) : '';
  document.querySelector('#posters-run').disabled = true;
  document.querySelector('#posters-run').textContent = preview.status === 'eligible' ? `Запустить: до ${preview.calls} × ${preview.limit}` : 'Запустить';
}

function postersShowRead(read, before) {
  postersLive.read = read;
  const coverage = posterCoverage(read);
  postersHistorySave(posterHistoryObserve(postersLive.history, coverage));
  document.querySelector('#posters-snapshot-text').textContent = postersSnapshotText(read);
  document.querySelector('#posters-coverage').innerHTML = postersCoverageHtml(read, before);
  const backlog = postersBacklogText(read);
  document.querySelector('#posters-backlog').textContent = backlog;
  postersShow('#posters-backlog', !!backlog);
  document.querySelector('#posters-unverified').innerHTML = postersUnverifiedHtml(read);
  document.querySelector('#posters-dynamics').innerHTML = postersDynamicsHtml(postersLive.history);
}

function postersErrorText(code) {
  return POSTERS_ERROR_TEXT[code] || `Чтение не удалось (${code}). Ничего не изменено.`;
}

// Reads the catalog and rebuilds the preview. Any change of the options or a re-check drops an earlier confirmation.
function postersRender(before = null) {
  const pending = (async () => {
    const options = postersOptions();
    postersShow('#posters-loading', true);
    postersShow('#posters-error', false);
    const answer = await postersRead(options.limit, options.start);
    postersShow('#posters-loading', false);
    if (!answer.ok || !posterCoverage(answer.body)) {
      const error = document.querySelector('#posters-error');
      error.textContent = postersErrorText(answer.ok ? 'invalid_answer' : answer.error);
      postersShow('#posters-error', true);
      postersSetPreview(posterPreview(null, {limit: options.limit, calls: options.calls, now: Date.now()}));
      return null;
    }
    postersShowRead(answer.body, before);
    postersSetPreview(posterPreview(answer.body, {limit: options.limit, calls: options.calls, retryAt: postersLive.history.retryAt, now: Date.now()}));
    return answer.body;
  })();
  postersLive.pending = pending;
  return pending;
}

function onPostersAccept() {
  const accept = document.querySelector('#posters-accept');
  const result = posterConfirm(postersLive.preview, {accepted: accept.checked, now: Date.now()});
  postersLive.confirmation = result.ok ? result.confirmation : null;
  document.querySelector('#posters-run').disabled = !result.ok || postersLive.running;
}

function postersProgressText(summary, remaining) {
  return `Вызов ${summary.calls} из ${summary.callsPlanned}: записано постеров ${summary.hydrated}, без постера на TMDB ${summary.noPoster}, можно повторить ${summary.retryable}${remaining !== null && remaining !== undefined ? `, в очереди после позиции ${remaining}` : ''}.`;
}

function postersReceiptHtml(receipt, titles) {
  const summary = receipt.summary;
  const stop = POSTER_STOP_COPY[receipt.stop] || POSTER_STOP_COPY.unknown_result;
  const facts = [
    ['Вызовов', `${summary.calls} из ${summary.callsPlanned}`],
    ['Записано постеров', summary.hydrated],
    ['Постер уже был', summary.alreadyPresent],
    ['На TMDB постера нет', summary.noPoster],
    ['TMDB ответил за другой фильм', summary.mismatch],
    ['Можно повторить', summary.retryable],
    ['Следующая позиция', receipt.done ? 'очередь пройдена' : postersStartText(receipt.nextCursor)],
  ];
  const partial = summary.partialWrites ? '<p class="action-unexplainable">Одна копия каталога записана, другая — нет. Записанное не откатывается; смотрите копии в технических подробностях и повторите после новой проверки.</p>' : '';
  const unknown = summary.unknown ? `<p class="action-unexplainable">${postersEscape(POSTER_UNKNOWN_OUTCOME)}</p>` : '';
  const retry = receipt.retryAt != null ? `<p class="action-next">Следующая попытка — не раньше ${postersDate(receipt.retryAt)}.</p>` : '';
  const items = summary.outcomes.map(item => `<li><b>${postersEscape(titles.get(item.id) || item.id)}</b><span>${postersEscape(posterOutcomeText(item.outcome))}</span></li>`).join('');
  const technical = receipt.calls.map(call => `<div><dt>Вызов ${call.index}</dt><dd>HTTP ${call.httpStatus || '—'}${call.error ? ' · ' + postersEscape(call.error) : ''} · курсор ${postersEscape(call.cursor || '∅')} → ${postersEscape(call.nextCursor === undefined ? '?' : call.nextCursor === null ? 'конец' : call.nextCursor || '∅')} · обработано ${call.processed ?? '—'} · записано ${call.hydrated}${call.retryAt != null ? ' · retryAt ' + postersEscape(call.retryAt) : ''}${call.generationChanged ? ' · generationChanged' : ''}${call.leaseLost ? ' · leaseLost' : ''}${call.writes.map(write => ` · ${postersEscape(write.key)}: ${write.written ? 'записано ' + write.records : 'не записано (' + postersEscape(write.reason || '—') + ')'}`).join('')}${call.outcomes.length ? ' · ' + postersEscape(call.outcomes.map(item => item.id + '=' + item.outcome + (item.error ? '(' + item.error + ')' : '')).join(', ')) : ''}</dd></div>`).join('');
  return `<h3 class="action-result-title" id="posters-receipt-title" tabindex="-1">Результат запуска</h3>
    <div class="action-status action-tone-${stop.tone}"><p><b>${postersEscape(stop.text)}</b></p>${retry}</div>${partial}${unknown}
    <dl class="posters-facts">${facts.map(([label, value]) => `<div><dt>${postersEscape(label)}</dt><dd>${postersEscape(value)}</dd></div>`).join('')}</dl>
    ${items ? `<ol class="action-items posters-outcomes">${items}</ol>` : '<p>Ни одна запись не была обработана.</p>'}
    <p class="action-next" id="posters-recheck-note">Покрытие перечитывается…</p>
    <details class="action-tech"><summary>Технические подробности</summary><dl class="action-facts"><div><dt>Начало / конец</dt><dd>${postersEscape(receipt.startedAt)} → ${postersEscape(receipt.finishedAt)}</dd></div><div><dt>Поколение</dt><dd>${postersEscape(receipt.programmeRunId || '—')}</dd></div><div><dt>Причина остановки</dt><dd>${postersEscape(receipt.stop)}</dd></div>${technical}</dl></details>`;
}

async function onPostersRun() {
  if (postersLive.running || !postersLive.confirmation) return null;
  const confirmation = postersLive.confirmation;
  postersLive.confirmation = null;
  document.querySelector('#posters-run').disabled = true;
  postersShow('#posters-refusal', false);
  const fresh = await loadPosterCoverage({limit: confirmation.limit, cursor: confirmation.cursor});
  const begin = posterBeginRun(confirmation, fresh.ok ? fresh.body : null, {now: Date.now(), retryAt: postersLive.history.retryAt});
  if (!begin.ok) {
    const refusal = document.querySelector('#posters-refusal');
    refusal.textContent = POSTER_REFUSAL_COPY[begin.reason] || POSTER_REFUSAL_COPY.read_failed;
    postersShow('#posters-refusal', true);
    if (fresh.ok && posterCoverage(fresh.body)) {
      postersShowRead(fresh.body, null);
      const options = postersOptions();
      postersSetPreview(posterPreview(fresh.body, {limit: options.limit, calls: options.calls, retryAt: postersLive.history.retryAt, now: Date.now()}));
    } else postersSetPreview(postersLive.preview);
    return null;
  }
  const before = posterCoverage(fresh.body);
  const titles = new Map((fresh.body.queue.items || []).map(item => [item.id, postersTitle(item)]));
  postersLive.running = true;
  postersLive.stop = false;
  postersShow('#posters-accept-label', false);
  postersShow('#posters-receipt', false);
  const stopButton = document.querySelector('#posters-stop');
  stopButton.disabled = false;
  stopButton.textContent = 'Остановить после текущего пакета';
  postersShow('#posters-stop', true);
  document.querySelector('#posters-recheck').disabled = true;
  const progress = document.querySelector('#posters-progress');
  progress.textContent = `Отправляем первый пакет: до ${confirmation.limit} записей…`;
  postersShow('#posters-progress', true);
  const receipt = await runPosterSweep({
    confirmation: begin.confirmation,
    call: body => posterHydrationCall(body),
    now: () => Date.now(),
    stopRequested: () => postersLive.stop,
    onProgress: summary => {progress.textContent = postersProgressText(summary, summary.remaining);},
  });
  postersHistorySave(posterHistoryRecord(postersLive.history, receipt));
  postersLive.running = false;
  postersShow('#posters-stop', false);
  document.querySelector('#posters-recheck').disabled = false;
  progress.textContent = postersProgressText(receipt.summary, null) + ' Запуск завершён.';
  const box = document.querySelector('#posters-receipt');
  box.innerHTML = postersReceiptHtml(receipt, titles);
  postersShow('#posters-receipt', true);
  const heading = document.querySelector('#posters-receipt-title');
  if (heading && heading.focus) heading.focus();
  document.querySelector('#posters-start').value = 'continue';
  const after = await postersRender(before);
  const note = document.querySelector('#posters-recheck-note');
  if (note) {
    const coverage = after ? posterCoverage(after) : null;
    note.textContent = coverage && !coverage.complete ? 'Покрытие после запуска неизвестно: данные неполные.' : coverage ? `Покрытие перечитано: без постера ${before.missingPoster} → ${coverage.missingPoster}, можно восстановить ${before.verifiedMissing} → ${coverage.verifiedMissing}.` : 'Перечитать покрытие не удалось; результат выше — по ответам маршрута.';
  }
  return receipt;
}

function onPostersStop() {
  postersLive.stop = true;
  const button = document.querySelector('#posters-stop');
  button.disabled = true;
  button.textContent = 'Остановим после текущего пакета…';
}

function onPostersOptions() {
  if (postersLive.running) return null;
  postersShow('#posters-refusal', false);
  return postersRender();
}

function onPostersForget() {
  const storage = postersStorage();
  try {if (storage) storage.removeItem(POSTER_HISTORY_KEY);} catch {}
  postersLive.history = posterHistoryRead(null);
  document.querySelector('#posters-dynamics').innerHTML = postersDynamicsHtml(postersLive.history);
  if (postersLive.read) document.querySelector('#posters-coverage').innerHTML = postersCoverageHtml(postersLive.read, null);
}

function startPosters() {
  postersLive.history = postersHistoryLoad();
  for (const selector of ['#posters-limit', '#posters-calls', '#posters-start']) document.querySelector(selector).addEventListener('change', onPostersOptions);
  document.querySelector('#posters-accept').addEventListener('change', onPostersAccept);
  document.querySelector('#posters-run').addEventListener('click', onPostersRun);
  document.querySelector('#posters-recheck').addEventListener('click', onPostersOptions);
  document.querySelector('#posters-stop').addEventListener('click', onPostersStop);
  document.querySelector('#posters-forget').addEventListener('click', onPostersForget);
  document.querySelector('#posters-form').addEventListener('submit', event => {event.preventDefault(); onPostersOptions();});
  postersRender();
}

startPosters();
