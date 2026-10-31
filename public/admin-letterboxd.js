// The archive preview page: one check per submit, the answer held in this tab's memory only. Leaving or resetting the page
// drops it; nothing is written to storage, the URL or history.
const archiveLive = {seq: 0, controller: null, pending: null, answer: null, issued: {}, keys: {}, committed: {}, rollbackIssued: {}, rollbackKeys: {}};

function archiveNode(selector) {return document.querySelector(selector);}

function archiveShow(state, payload) {
  archiveNode('#archive-loading').hidden = state !== 'loading';
  archiveNode('#archive-idle').hidden = state !== 'idle';
  const error = archiveNode('#archive-error');
  error.hidden = state !== 'error';
  error.textContent = state === 'error' ? payload : '';
  archiveNode('#archive-result').innerHTML = state === 'ready' ? archivePreviewHtml(payload, archiveLive) : '';
  archiveNode('#archive-submit').disabled = state === 'loading';
  archiveNode('#archive-cancel').hidden = state !== 'loading';
  if (state === 'error' && error.focus) error.focus();
  if (state === 'ready' && archiveNode('#archive-result').focus) archiveNode('#archive-result').focus();
}

function archiveAbort() {
  if (archiveLive.controller) archiveLive.controller.abort();
  archiveLive.controller = null;
}

function onArchiveSubmit(event) {
  if (event && event.preventDefault) event.preventDefault();
  const input = archiveNode('#archive-file');
  const file = input.files && input.files[0] ? input.files[0] : null;
  const declared = archiveNode('#archive-generated-at').value;
  const check = archiveLocalCheck(file, declared);
  archiveAbort();
  const seq = ++archiveLive.seq;
  archiveLive.answer = null;
  archiveLive.issued = {};
  archiveLive.keys = {};
  archiveLive.committed = {};
  archiveLive.rollbackIssued = {};
  archiveLive.rollbackKeys = {};
  if (check.error) {
    archiveShow('error', archiveErrorText(check.error, null));
    return Promise.resolve(null);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  archiveLive.controller = controller;
  archiveShow('loading');
  const pending = postArchivePreview(file, declared, {signal: controller ? controller.signal : undefined}).then(result => {
    if (seq !== archiveLive.seq) return result;
    archiveLive.controller = null;
    if (result.mode === 'aborted') {archiveShow('idle'); return result;}
    if (result.mode === 'error') {archiveShow('error', archiveErrorText(result.error, result.detail)); return result;}
    archiveLive.answer = result.answer;
    archiveShow('ready', result.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveCancel() {
  archiveLive.seq++;
  archiveAbort();
  archiveShow('idle');
}

function onArchiveReset() {
  onArchiveCancel();
  archiveLive.answer = null;
  archiveLive.issued = {};
  archiveLive.keys = {};
  archiveLive.committed = {};
  archiveLive.rollbackIssued = {};
  archiveLive.rollbackKeys = {};
  archiveNode('#archive-form').reset();
  archiveNode('#archive-file').focus();
}

function archiveCurrentFile() {
  const input = archiveNode('#archive-file');
  const file = input.files && input.files[0] ? input.files[0] : null;
  const declared = archiveNode('#archive-generated-at').value;
  const check = archiveLocalCheck(file, declared);
  return check.error ? {error: check.error} : {file, declared};
}

function archiveApplyFailed(result) {
  archiveNode('#archive-loading').hidden = true;
  archiveNode('#archive-submit').disabled = false;
  archiveNode('#archive-cancel').hidden = true;
  archiveLive.controller = null;
  if (!result || result.mode === 'aborted') return result;
  const error = archiveNode('#archive-error');
  error.hidden = false;
  error.textContent = archiveErrorText(result.error, result.detail);
  if (error.focus) error.focus();
  if (archiveLive.answer) archiveNode('#archive-result').innerHTML = archivePreviewHtml(archiveLive.answer, archiveLive);
  return result;
}

function archiveBeginAction() {
  archiveAbort();
  const seq = ++archiveLive.seq;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  archiveLive.controller = controller;
  archiveNode('#archive-loading').hidden = false;
  archiveNode('#archive-error').hidden = true;
  archiveNode('#archive-submit').disabled = true;
  archiveNode('#archive-cancel').hidden = false;
  return {seq, signal: controller ? controller.signal : undefined};
}

function onArchiveConfirm(chunk) {
  if (!archiveLive.answer || archiveLive.controller) return Promise.resolve(null);
  const current = archiveCurrentFile();
  if (current.error) return archiveApplyFailed({mode: 'error', error: current.error, detail: null});
  const batch = (archiveLive.answer.batches && archiveLive.answer.batches.chunks || []).find(item => item.chunk === chunk);
  if (!batch || !batch.confirmable) return archiveApplyFailed({mode: 'error', error: 'not_eligible', detail: null});
  if (!archiveLive.keys[chunk]) archiveLive.keys[chunk] = archiveIdempotencyKey();
  const run = archiveBeginAction();
  const pending = postArchiveConfirm(current.file, current.declared, {
    chunk: String(chunk), planHash: batch.planHash, programmeRunId: archiveLive.answer.batches.programmeRunId,
    scopeFingerprint: batch.scopeFingerprint, idempotencyKey: archiveLive.keys[chunk], accepted: 'true',
  }, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.issued[chunk] = result.answer.confirmation;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveCommit(chunk) {
  if (!archiveLive.answer || !archiveLive.issued[chunk] || archiveLive.controller) return Promise.resolve(null);
  const current = archiveCurrentFile();
  if (current.error) return archiveApplyFailed({mode: 'error', error: current.error, detail: null});
  const run = archiveBeginAction();
  const pending = postArchiveCommit(current.file, current.declared, archiveLive.issued[chunk], {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    const receipt = result.answer.receipt || {};
    archiveLive.committed[chunk] = {state: result.answer.state, replayed: result.answer.replayed === true, counts: receipt.counts || null};
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveRollbackConfirm(chunk) {
  if (!archiveLive.answer || archiveLive.controller) return Promise.resolve(null);
  const sha = archiveLive.answer.archive && archiveLive.answer.archive.sha256;
  if (!sha) return archiveApplyFailed({mode: 'error', error: 'invalid_request', detail: null});
  if (!archiveLive.rollbackKeys[chunk]) archiveLive.rollbackKeys[chunk] = archiveIdempotencyKey();
  const run = archiveBeginAction();
  const pending = postArchiveRollbackConfirm({archiveSha256: sha, chunk, idempotencyKey: archiveLive.rollbackKeys[chunk], accepted: true}, {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.rollbackIssued[chunk] = result.answer.confirmation;
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveRollback(chunk) {
  if (!archiveLive.rollbackIssued[chunk] || archiveLive.controller) return Promise.resolve(null);
  const run = archiveBeginAction();
  const pending = postArchiveRollback(archiveLive.rollbackIssued[chunk], {signal: run.signal}).then(result => {
    if (run.seq !== archiveLive.seq) return result;
    if (result.mode !== 'ready') return archiveApplyFailed(result);
    archiveLive.committed[chunk] = {state: result.answer.state, replayed: result.answer.replayed === true, rolledBack: true};
    archiveLive.controller = null;
    archiveShow('ready', archiveLive.answer);
    return result;
  });
  archiveLive.pending = pending;
  return pending;
}

function onArchiveResultClick(event) {
  let node = event && event.target;
  let action = null, chunk = null;
  while (node && node !== archiveNode('#archive-result')) {
    if (node.getAttribute) {
      for (const name of ['data-archive-confirm', 'data-archive-commit', 'data-archive-rollback-confirm', 'data-archive-rollback']) {
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
  archiveNode('#archive-result').addEventListener('click', onArchiveResultClick);
  window.addEventListener('keydown', onArchiveKey);
  window.addEventListener('pagehide', () => {archiveLive.seq++; archiveAbort(); archiveLive.answer = null; archiveLive.issued = {}; archiveLive.keys = {}; archiveLive.committed = {}; archiveLive.rollbackIssued = {}; archiveLive.rollbackKeys = {};});
  archiveShow('idle');
}

startArchive();
