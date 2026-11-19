// ADR 0178 / AIR-132: the owner revoke workflow of ONE saved identity correction: preview (read) -> confirm -> execute ->
// readback. State lives in memory. The only requests are the preview GET and the two POSTs of the revoke routes. Nothing is
// requested on load: a link may prefill the two fields, the owner presses the button. No automatic retry of any write.
const rvLive = {preview: null, confirmation: null, supersede: null, busy: false, seq: 0};

function rvEl(id) {return document.querySelector('#' + id);}
function rvShow(id, shown) {const node = rvEl(id); if (node) node.hidden = !shown;}
function rvError(text) {
  const node = rvEl('revoke-error');
  node.textContent = text || '';
  node.hidden = !text;
}
function rvRefusal(result) {
  const reason = result.body && typeof result.body.reason === 'string' ? result.body.reason : result.error;
  return revokeReasonText(reason);
}
function rvPaint() {
  const preview = rvLive.preview;
  rvEl('revoke-preview').innerHTML = preview ? revokePreviewHtml(preview) : '';
  const eligible = !!(preview && preview.available);
  const staged = !!rvLive.confirmation;
  rvShow('revoke-confirm-form', eligible || staged);
  const replacing = !!rvLive.supersede;
  rvShow('supersede-form', eligible || replacing);
  for (const id of ['supersede-effect', 'supersede-id', 'supersede-basis', 'supersede-accept']) rvEl(id).disabled = replacing || rvLive.busy || staged;
  rvEl('supersede-confirm-button').hidden = replacing;
  rvEl('supersede-confirm-button').disabled = rvLive.busy || staged || !rvEl('supersede-accept').checked || !/^[1-9]\d{0,11}$/.test(rvEl('supersede-id').value.trim()) || !rvEl('supersede-basis').value.trim();
  rvShow('supersede-execute-button', replacing);
  rvEl('supersede-execute-button').disabled = rvLive.busy;
  rvShow('supersede-cancel-button', replacing);
  const basis = rvEl('revoke-basis'), accept = rvEl('revoke-accept');
  basis.disabled = staged || replacing || rvLive.busy;
  accept.disabled = staged || replacing || rvLive.busy;
  rvEl('revoke-confirm-button').hidden = staged;
  // Only one staged mutation at a time: while a replacement is prepared, the revoke cannot be confirmed (and the other way round).
  rvEl('revoke-confirm-button').disabled = rvLive.busy || replacing || !accept.checked || !basis.value.trim();
  rvShow('revoke-execute-button', staged);
  rvEl('revoke-execute-button').disabled = rvLive.busy;
  rvShow('revoke-cancel-button', staged);
  rvEl('revoke-preview-button').disabled = rvLive.busy;
  rvEl('revoke-loading').setAttribute('aria-busy', rvLive.busy ? 'true' : 'false');
  rvShow('revoke-loading', rvLive.busy);
}
function rvFields() {
  return {key: rvEl('revoke-key').value.trim(), requestId: rvEl('revoke-request').value.trim()};
}
async function rvPreview() {
  const {key, requestId} = rvFields();
  rvError('');
  if (!key || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) { rvError(revokeReasonText('invalid_request')); return null; }
  const seq = ++rvLive.seq;
  rvLive.busy = true; rvLive.confirmation = null; rvLive.supersede = null; rvPaint();
  const result = await revokePreviewGet(key, requestId);
  if (seq !== rvLive.seq) return result;
  rvLive.busy = false;
  if (result.ok && result.body) rvLive.preview = result.body;
  else { rvLive.preview = null; rvError(rvRefusal(result)); }
  rvPaint();
  return result;
}
async function rvConfirm() {
  const preview = rvLive.preview;
  if (!preview || !preview.available || rvLive.busy || rvLive.confirmation || rvLive.supersede) return null;
  rvError('');
  rvLive.busy = true; rvPaint();
  const result = await revokeConfirmPost({key: preview.key, pin: preview.pin, requestId: preview.requestId, basis: rvEl('revoke-basis').value.trim()});
  rvLive.busy = false;
  if (result.ok && result.body && result.body.confirmation) { rvLive.confirmation = result.body.confirmation; rvPaint(); rvEl('revoke-execute-button').focus(); return result; }
  rvError(rvRefusal(result));
  rvEl('revoke-accept').checked = false;
  if (result.error === 'stale_pin') return rvPreview();
  rvPaint();
  return result;
}
async function rvSupersedeConfirm() {
  const preview = rvLive.preview;
  if (!preview || !preview.available || rvLive.busy || rvLive.supersede || rvLive.confirmation) return null;
  rvError('');
  rvLive.busy = true; rvPaint();
  const result = await supersedeConfirmPost({key: preview.key, pin: preview.pin, effect: rvEl('supersede-effect').value, tmdbId: rvEl('supersede-id').value.trim(), basis: rvEl('supersede-basis').value.trim(), supersedes: {requestId: preview.requestId}});
  rvLive.busy = false;
  if (result.ok && result.body && result.body.confirmation) { rvLive.supersede = result.body.confirmation; rvPaint(); rvEl('supersede-execute-button').focus(); return result; }
  rvError(supersedeReasonText(result.body && typeof result.body.reason === 'string' ? result.body.reason : result.error));
  rvEl('supersede-accept').checked = false;
  if (result.error === 'stale_pin') return rvPreview();
  rvPaint();
  return result;
}
async function rvSupersedeExecute() {
  if (!rvLive.supersede || rvLive.busy) return null;
  rvError('');
  rvLive.busy = true; rvPaint();
  const result = await supersedeExecutePost(rvLive.supersede);
  rvLive.busy = false;
  const note = rvEl('revoke-receipt');
  if (result.ok && result.body && result.body.receipt) {
    note.textContent = (result.body.replayed ? 'Это повтор: ' : '') + 'замена записана. Решение переоценит обычный чанк Discovery.';
    note.hidden = false;
    rvLive.supersede = null;
    rvEl('supersede-accept').checked = false;
    await rvPreview();
    note.focus();
    return result;
  }
  // A refusal or an unknown outcome is shown as it is. A write is never repeated from here.
  rvError(supersedeReasonText(result.body && typeof result.body.reason === 'string' ? result.body.reason : result.error));
  if (result.error !== 'lease_held') rvLive.supersede = null;
  rvPaint();
  return result;
}
function rvSupersedeCancel() {
  if (rvLive.busy) return;
  rvLive.supersede = null;
  rvEl('supersede-accept').checked = false;
  rvPaint();
}
async function rvExecute() {
  if (!rvLive.confirmation || rvLive.busy) return null;
  rvError('');
  rvLive.busy = true; rvPaint();
  const result = await revokeExecutePost(rvLive.confirmation);
  rvLive.busy = false;
  const note = rvEl('revoke-receipt');
  if (result.ok && result.body && result.body.receipt) {
    note.textContent = revokeReceiptText(result.body);
    note.hidden = false;
    rvLive.confirmation = null;
    rvEl('revoke-accept').checked = false;
    await rvPreview();
    note.focus();
    return result;
  }
  // A refusal or an unknown outcome is shown as it is. A write is never repeated from here.
  rvError(rvRefusal(result));
  if (result.error !== 'lease_held') rvLive.confirmation = null;
  rvPaint();
  return result;
}
function rvCancel() {
  if (rvLive.busy) return;
  rvLive.confirmation = null;
  rvEl('revoke-accept').checked = false;
  rvPaint();
}
function rvStart() {
  const query = new URLSearchParams(location.search);
  if (query.get('key')) rvEl('revoke-key').value = query.get('key').slice(0, 300);
  if (query.get('requestId')) rvEl('revoke-request').value = query.get('requestId').slice(0, 80);
  rvEl('revoke-form').addEventListener('submit', event => { event.preventDefault(); rvPreview(); });
  rvEl('revoke-confirm-form').addEventListener('submit', event => { event.preventDefault(); rvConfirm(); });
  rvEl('revoke-execute-button').addEventListener('click', () => { rvExecute(); });
  rvEl('revoke-cancel-button').addEventListener('click', rvCancel);
  rvEl('revoke-accept').addEventListener('change', rvPaint);
  rvEl('supersede-form').addEventListener('submit', event => { event.preventDefault(); rvSupersedeConfirm(); });
  rvEl('supersede-execute-button').addEventListener('click', () => { rvSupersedeExecute(); });
  rvEl('supersede-cancel-button').addEventListener('click', rvSupersedeCancel);
  for (const id of ['supersede-effect', 'supersede-id', 'supersede-basis', 'supersede-accept']) rvEl(id).addEventListener(id === 'supersede-accept' || id === 'supersede-effect' ? 'change' : 'input', rvPaint);
  rvEl('revoke-basis').addEventListener('input', rvPaint);
  for (const id of ['revoke-key', 'revoke-request']) rvEl(id).addEventListener('input', () => { rvLive.preview = null; rvLive.confirmation = null; rvLive.supersede = null; rvPaint(); });
  rvPaint();
}
if (typeof document !== 'undefined' && document.querySelector('#revoke-form')) rvStart();
