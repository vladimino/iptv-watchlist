// The archive preview page: one check per submit, the answer held in this tab's memory only. Leaving or resetting the page
// drops it; nothing is written to storage, the URL or history. A write that has already left the browser is not undone by
// Cancel, Escape, a new file or a failed response: the tab keeps that command and will not say the write never started.
const archiveLive = {seq: 0, controller: null, pending: null, answer: null, issued: {}, keys: {}, committed: {}, rollbackIssued: {}, rollbackKeys: {}, rollbackResult: {}, confirmUnknown: {}, rollbackConfirmUnknown: {}, bound: null, stale: false, inflight: null};

function archiveNode(selector) {return document.querySelector(selector);}

function archiveHasUnresolved() {
  const committed = archiveLive.committed || {};
  for (const key in committed) {
    const done = committed[key];
    if (done && done.state === 'unknown' && !done.resolved) return true;
  }
  const rollbackResult = archiveLive.rollbackResult || {};
  for (const key in rollbackResult) {
    const done = rollbackResult[key];
    if (done && done.state === 'unknown' && !done.resolved) return true;
  }
  for (const key in archiveLive.confirmUnknown || {}) if (archiveLive.confirmUnknown[key]) return true;
  for (const key in archiveLive.rollbackConfirmUnknown || {}) if (archiveLive.rollbackConfirmUnknown[key]) return true;
  return false;
}

function archiveCurrentStep(state) {
  if (state === 'loading') return archiveLive.inflight && archiveLive.inflight.kind !== 'preview' ? 5 : 2;
  if (state !== 'ready') return 1;
  if (archiveHasUnresolved()) return 5;
  const committed = archiveLive.committed || {};
  for (const key in committed) if (Object.prototype.hasOwnProperty.call(committed, key)) return 5;
  const rollbackResult = archiveLive.rollbackResult || {};
  for (const key in rollbackResult) if (Object.prototype.hasOwnProperty.call(rollbackResult, key)) return 5;
  const issued = archiveLive.issued || {};
  for (const key in issued) if (Object.prototype.hasOwnProperty.call(issued, key)) return 4;
  return 3;
}

function archiveMarkStep(step) {
  if (!document.querySelectorAll) return;
  for (const item of document.querySelectorAll('[data-archive-step]')) {
    const n = Number(item.getAttribute('data-archive-step'));
    if (n === step) item.setAttribute('aria-current', 'step');
    else if (item.removeAttribute) item.removeAttribute('aria-current');
    if (n < step) item.setAttribute('data-reached', 'true');
    else if (item.removeAttribute) item.removeAttribute('data-reached');
  }
}

function archiveRepaint() {
  if (!archiveLive.answer) return;
  archiveMarkStep(archiveCurrentStep('ready'));
  archiveNode('#archive-result').innerHTML = archivePreviewHtml(archiveLive.answer, archiveLive);
}

function archiveShow(state, payload) {
  archiveMarkStep(archiveCurrentStep(state));
  const loading = archiveNode('#archive-loading');
  loading.hidden = state !== 'loading';
  const writing = archiveLive.inflight && archiveLive.inflight.kind !== 'preview';
  loading.textContent = writing ? 'Запрос уже ушёл на сервер. Прервать ожидание не отменяет запись и не откатывает её.' : 'Сервер проверяет архив и сравнивает его с R2…';
  archiveNode('#archive-idle').hidden = state !== 'idle';
  const error = archiveNode('#archive-error');
  error.hidden = state !== 'error';
  error.textContent = state === 'error' ? payload : '';
  archiveNode('#archive-result').innerHTML = state === 'ready' ? archivePreviewHtml(payload, archiveLive) : '';
  archiveNode('#archive-submit').disabled = state === 'loading';
  const cancel = archiveNode('#archive-cancel');
  cancel.hidden = state !== 'loading';
  cancel.textContent = writing ? 'Прервать ожидание' : 'Отменить';
  if (state === 'error' && error.focus) error.focus();
  if (state === 'ready' && archiveNode('#archive-result').focus) archiveNode('#archive-result').focus();
}

function archiveAbort() {
  if (archiveLive.controller) archiveLive.controller.abort();
  archiveLive.controller = null;
}

function archiveClearMemory() {
  archiveLive.answer = null;
  archiveLive.issued = {};
  archiveLive.keys = {};
  archiveLive.committed = {};
  archiveLive.rollbackIssued = {};
  archiveLive.rollbackKeys = {};
  archiveLive.rollbackResult = {};
  archiveLive.confirmUnknown = {};
  archiveLive.rollbackConfirmUnknown = {};
  archiveLive.bound = null;
  archiveLive.stale = false;
  archiveLive.inflight = null;
}

function archiveFileMark(file, declared) {
  if (!file) return '';
  return [file.name, file.size, file.lastModified, String(declared || '').trim()].join('\0');
}

function archiveHoldUnresolved(message) {
  const error = archiveNode('#archive-error');
  error.hidden = false;
  error.textContent = message;
  if (error.focus) error.focus();
  archiveRepaint();
  return Promise.resolve(null);
}

function onArchiveSubmit(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (archiveHasUnresolved()) return archiveHoldUnresolved('Новая проверка не стирает неизвестный исход. Сервер мог уже записать факты. Повтори ту же команду или явно нажми «Забыть команду в этой вкладке». Это не откат.');
  const input = archiveNode('#archive-file');
  const file = input.files && input.files[0] ? input.files[0] : null;
  const declared = archiveNode('#archive-generated-at').value;
  const check = archiveLocalCheck(file, declared);
  archiveAbort();
  const seq = ++archiveLive.seq;
  archiveClearMemory();
  if (check.error) {
    archiveShow('error', archiveErrorText(check.error, null));
    return Promise.resolve(null);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  archiveLive.controller = controller;
  archiveLive.inflight = {kind: 'preview'};
  archiveShow('loading');
  const pending = postArchivePreview(file, declared, {signal: controller ? controller.signal : undefined}).then(result => {
    if (seq !== archiveLive.seq) return result;
    archiveLive.controller = null;
    archiveLive.inflight = null;
    if (result.mode === 'aborted') {archiveShow('idle'); return result;}
    if (result.mode === 'error') {archiveShow('error', archiveErrorText(result.error, result.detail)); return result;}
    archiveLive.answer = result.answer;
    archiveLive.bound = {file, declared, mark: archiveFileMark(file, declared)};
    archiveLive.stale = false;
    archiveShow('ready', result.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveCancel() {
  const inflight = archiveLive.inflight;
  archiveLive.seq++;
  archiveAbort();
  archiveLive.controller = null;
  archiveLive.inflight = null;
  if (!inflight || inflight.kind === 'preview') {
    archiveShow('idle');
    return;
  }
  archiveSettleLostWrite(inflight);
  archiveNode('#archive-loading').hidden = true;
  archiveNode('#archive-submit').disabled = false;
  archiveNode('#archive-cancel').hidden = true;
  archiveNode('#archive-cancel').textContent = 'Отменить';
  const error = archiveNode('#archive-error');
  error.hidden = false;
  error.textContent = 'Ожидание прервано в браузере. Сервер это не отменяет и не откатывает. Исход неизвестен. Повтор сам не запускается.';
  if (error.focus) error.focus();
  archiveRepaint();
}

function onArchiveReset() {
  if (archiveHasUnresolved()) return archiveHoldUnresolved('«Очистить» не стирает неизвестный исход и не откатывает сервер. Чтобы забыть команду для повтора, нажми «Забыть команду в этой вкладке».');
  onArchiveCancel();
  archiveClearMemory();
  archiveNode('#archive-form').reset();
  archiveNode('#archive-file').focus();
}

function onArchiveBindingChange() {
  if (!archiveLive.answer || !archiveLive.bound) return;
  const input = archiveNode('#archive-file');
  const file = input.files && input.files[0] ? input.files[0] : null;
  const declared = archiveNode('#archive-generated-at').value;
  archiveLive.stale = archiveFileMark(file, declared) !== archiveLive.bound.mark;
  archiveRepaint();
}

function archiveCurrentFile() {
  const input = archiveNode('#archive-file');
  const file = input.files && input.files[0] ? input.files[0] : null;
  const declared = archiveNode('#archive-generated-at').value;
  const check = archiveLocalCheck(file, declared);
  return check.error ? {error: check.error} : {file, declared};
}

function archiveCommandSource() {
  if (archiveLive.bound && archiveLive.stale) return {file: archiveLive.bound.file, declared: archiveLive.bound.declared};
  return archiveCurrentFile();
}

function archiveLostText(kind) {
  if (kind === 'confirm') return 'Ответ на подтверждение не получен. Согласие могло сохраниться. Факты этим шагом не записываются. Повтор сам не запускается.';
  if (kind === 'rollback-confirm') return 'Ответ на подтверждение отката не получен. Повтор сам не запускается.';
  if (kind === 'rollback') return 'Ответ на откат не получен или не прочитан. Откат мог начаться. Повтор сам не запускается.';
  return 'Ответ на запись не получен или не прочитан. Исход неизвестен: сервер мог уже изменить факты. Повтор сам не запускается.';
}

function archiveTransportLost(result) {
  if (!result || result.mode === 'aborted') return true;
  if (result.mode !== 'error') return false;
  const error = String(result.error || '');
  return error === 'network' || error === 'unexpected_answer' || error === 'storage_unavailable' || error === 'storage_error' || /^http_5\d\d$/.test(error);
}

function archiveSettleLostWrite(inflight) {
  const chunk = inflight.chunk;
  if (inflight.kind === 'commit') archiveLive.committed[chunk] = {state: 'unknown', transport: true, counts: null};
  else if (inflight.kind === 'rollback') archiveLive.rollbackResult[chunk] = {state: 'unknown', transport: true, counts: null};
  else if (inflight.kind === 'confirm') archiveLive.confirmUnknown[chunk] = true;
  else if (inflight.kind === 'rollback-confirm') archiveLive.rollbackConfirmUnknown[chunk] = true;
}

function archiveMarkInProgress(inflight) {
  const chunk = inflight.chunk;
  if (inflight.kind === 'commit') archiveLive.committed[chunk] = {state: 'unknown', inProgress: true, counts: null};
  else if (inflight.kind === 'rollback') archiveLive.rollbackResult[chunk] = {state: 'unknown', inProgress: true, counts: null};
  else if (inflight.kind === 'confirm') archiveLive.confirmUnknown[chunk] = true;
  else if (inflight.kind === 'rollback-confirm') archiveLive.rollbackConfirmUnknown[chunk] = true;
}

function archiveApplyFailed(result) {
  archiveNode('#archive-loading').hidden = true;
  archiveNode('#archive-submit').disabled = false;
  archiveNode('#archive-cancel').hidden = true;
  archiveNode('#archive-cancel').textContent = 'Отменить';
  archiveLive.controller = null;
  const inflight = archiveLive.inflight;
  archiveLive.inflight = null;
  if (!result || result.mode === 'aborted') {
    if (inflight && inflight.kind !== 'preview') archiveSettleLostWrite(inflight);
    if (archiveLive.answer) archiveRepaint();
    return result;
  }
  const inProgress = !!(inflight && inflight.kind !== 'preview' && result.error === 'in_progress');
  const lost = inflight && inflight.kind !== 'preview' && archiveTransportLost(result);
  const rollbackRefused = !!(inflight && inflight.kind === 'rollback' && !inProgress && !lost);
  if (inProgress) archiveMarkInProgress(inflight);
  else if (lost) archiveSettleLostWrite(inflight);
  else if (rollbackRefused) archiveLive.rollbackResult[inflight.chunk] = {state: 'refused', error: result.error};
  else if (inflight && inflight.kind === 'commit' && archiveLive.committed[inflight.chunk] && archiveLive.committed[inflight.chunk].transport) archiveLive.committed[inflight.chunk] = {state: 'refused', error: result.error, counts: null};
  else if (inflight && inflight.kind === 'confirm') archiveLive.confirmUnknown[inflight.chunk] = false;
  else if (inflight && inflight.kind === 'rollback-confirm') archiveLive.rollbackConfirmUnknown[inflight.chunk] = false;
  const error = archiveNode('#archive-error');
  error.hidden = false;
  error.textContent = inProgress ? archiveErrorText(result.error, result.detail) : lost ? archiveLostText(inflight.kind) : rollbackRefused ? archiveRollbackRefusedBanner(result.error) : archiveErrorText(result.error, result.detail);
  if (error.focus) error.focus();
  if (archiveLive.answer) archiveRepaint();
  return result;
}

function archiveBeginAction(kind, chunk) {
  archiveAbort();
  const seq = ++archiveLive.seq;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  archiveLive.controller = controller;
  archiveLive.inflight = {kind, chunk};
  const loading = archiveNode('#archive-loading');
  loading.hidden = false;
  loading.textContent = 'Запрос уже ушёл на сервер. Прервать ожидание не отменяет запись и не откатывает её.';
  archiveNode('#archive-error').hidden = true;
  archiveNode('#archive-submit').disabled = true;
  const cancel = archiveNode('#archive-cancel');
  cancel.hidden = false;
  cancel.textContent = 'Прервать ожидание';
  return {seq, signal: controller ? controller.signal : undefined};
}

function onArchiveConfirm(chunk) {
  if (!archiveLive.answer || archiveLive.controller) return Promise.resolve(null);
  if (archiveLive.stale && !archiveLive.confirmUnknown[chunk]) return Promise.resolve(null);
  const current = archiveCommandSource();
  if (current.error) return archiveApplyFailed({mode: 'error', error: current.error, detail: null});
  const batch = (archiveLive.answer.batches && archiveLive.answer.batches.chunks || []).find(item => item.chunk === chunk);
  if (!batch || !batch.confirmable) return archiveApplyFailed({mode: 'error', error: 'not_eligible', detail: null});
  if (!archiveLive.keys[chunk]) archiveLive.keys[chunk] = archiveIdempotencyKey();
  const run = archiveBeginAction('confirm', chunk);
  archiveLive.confirmUnknown[chunk] = true;
  archiveRepaint();
  const pending = postArchiveConfirm(current.file, current.declared, {
    chunk: String(chunk), planHash: batch.planHash, programmeRunId: archiveLive.answer.batches.programmeRunId,
    scopeFingerprint: batch.scopeFingerprint, idempotencyKey: archiveLive.keys[chunk], accepted: 'true',
  }, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.confirmUnknown[chunk] = false;
    archiveLive.issued[chunk] = result.answer.confirmation;
    archiveLive.inflight = null;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveCommit(chunk) {
  if (!archiveLive.answer || !archiveLive.issued[chunk] || archiveLive.controller) return Promise.resolve(null);
  if (archiveLive.stale && !(archiveLive.committed[chunk] && archiveLive.committed[chunk].state === 'unknown')) return Promise.resolve(null);
  const current = archiveCommandSource();
  if (current.error) return archiveApplyFailed({mode: 'error', error: current.error, detail: null});
  const confirmation = archiveLive.issued[chunk];
  const run = archiveBeginAction('commit', chunk);
  archiveLive.committed[chunk] = {state: 'unknown', transport: true, pending: true, counts: null};
  archiveRepaint();
  const pending = postArchiveCommit(current.file, current.declared, confirmation, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    const receipt = result.answer.receipt || {};
    archiveLive.committed[chunk] = {state: result.answer.state, replayed: result.answer.replayed === true, counts: receipt.counts || null};
    archiveLive.inflight = null;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveRollbackConfirm(chunk) {
  if (!archiveLive.answer || archiveLive.controller) return Promise.resolve(null);
  if (archiveLive.stale && !archiveLive.rollbackConfirmUnknown[chunk]) return Promise.resolve(null);
  const sha = archiveLive.answer.archive && archiveLive.answer.archive.sha256;
  if (!sha) return archiveApplyFailed({mode: 'error', error: 'invalid_request', detail: null});
  if (!archiveLive.rollbackKeys[chunk]) archiveLive.rollbackKeys[chunk] = archiveIdempotencyKey();
  const run = archiveBeginAction('rollback-confirm', chunk);
  archiveLive.rollbackConfirmUnknown[chunk] = true;
  archiveRepaint();
  const pending = postArchiveRollbackConfirm({archiveSha256: sha, chunk, idempotencyKey: archiveLive.rollbackKeys[chunk], accepted: true}, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.rollbackConfirmUnknown[chunk] = false;
    archiveLive.rollbackIssued[chunk] = result.answer.confirmation;
    archiveLive.inflight = null;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveRollback(chunk) {
  if (!archiveLive.rollbackIssued[chunk] || archiveLive.controller) return Promise.resolve(null);
  const confirmation = archiveLive.rollbackIssued[chunk];
  const run = archiveBeginAction('rollback', chunk);
  archiveLive.rollbackResult[chunk] = {state: 'unknown', transport: true, pending: true, counts: null};
  archiveRepaint();
  const pending = postArchiveRollback(confirmation, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.rollbackResult[chunk] = {state: result.answer.state, replayed: result.answer.replayed === true, rolledBack: true};
    archiveLive.inflight = null;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveAbandon(chunk) {
  delete archiveLive.issued[chunk];
  delete archiveLive.keys[chunk];
  delete archiveLive.committed[chunk];
  delete archiveLive.rollbackIssued[chunk];
  delete archiveLive.rollbackKeys[chunk];
  delete archiveLive.rollbackResult[chunk];
  delete archiveLive.confirmUnknown[chunk];
  delete archiveLive.rollbackConfirmUnknown[chunk];
  const error = archiveNode('#archive-error');
  error.hidden = false;
  error.textContent = 'Команда для повтора забыта в этой вкладке. Сервер это не откатывает: если запись уже прошла, факты на месте.';
  if (error.focus) error.focus();
  archiveRepaint();
  return null;
}

function onArchiveResultClick(event) {
  let node = event && event.target;
  let action = null, chunk = null;
  while (node && node !== archiveNode('#archive-result')) {
    if (node.getAttribute) {
      for (const name of ['data-archive-confirm', 'data-archive-commit', 'data-archive-rollback-confirm', 'data-archive-rollback', 'data-archive-abandon']) {
        if (node.hasAttribute && node.hasAttribute(name)) {action = name; chunk = Number(node.getAttribute(name)); break;}
      }
    }
    if (action) break;
    node = node.parentElement || node.parentNode;
  }
  if (action === 'data-archive-confirm') return onArchiveConfirm(chunk);
  if (action === 'data-archive-commit') return onArchiveCommit(chunk);
  if (action === 'data-archive-rollback-confirm') return onArchiveRollbackConfirm(chunk);
  if (action === 'data-archive-rollback') return onArchiveRollback(chunk);
  if (action === 'data-archive-abandon') return onArchiveAbandon(chunk);
  return null;
}

function onArchiveKey(event) {
  if (event.key !== 'Escape' || !archiveLive.controller) return;
  event.preventDefault();
  onArchiveCancel();
}

function startArchive() {
  archiveNode('#archive-form').addEventListener('submit', onArchiveSubmit);
  archiveNode('#archive-cancel').addEventListener('click', onArchiveCancel);
  archiveNode('#archive-reset').addEventListener('click', onArchiveReset);
  archiveNode('#archive-file').addEventListener('change', onArchiveBindingChange);
  archiveNode('#archive-generated-at').addEventListener('input', onArchiveBindingChange);
  archiveNode('#archive-result').addEventListener('click', onArchiveResultClick);
  window.addEventListener('keydown', onArchiveKey);
  window.addEventListener('pagehide', () => {archiveLive.seq++; archiveAbort(); archiveClearMemory();});
  archiveShow('idle');
}

startArchive();
