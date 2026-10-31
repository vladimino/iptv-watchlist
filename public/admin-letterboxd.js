// The archive preview page: one check per submit, the answer held in this tab's memory only. Leaving or resetting the page
// drops it; nothing is written to storage, the URL or history.
const archiveLive = {seq: 0, controller: null, pending: null, answer: null};

function archiveNode(selector) {return document.querySelector(selector);}

function archiveShow(state, payload) {
  archiveNode('#archive-loading').hidden = state !== 'loading';
  archiveNode('#archive-idle').hidden = state !== 'idle';
  const error = archiveNode('#archive-error');
  error.hidden = state !== 'error';
  error.textContent = state === 'error' ? payload : '';
  archiveNode('#archive-result').innerHTML = state === 'ready' ? archivePreviewHtml(payload) : '';
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
  archiveNode('#archive-form').reset();
  archiveNode('#archive-file').focus();
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
  window.addEventListener('keydown', onArchiveKey);
  window.addEventListener('pagehide', () => {archiveLive.seq++; archiveAbort(); archiveLive.answer = null;});
  archiveShow('idle');
}

startArchive();
