// ADR 0178 / AIR-132: the owner revoke workflow of ONE saved identity correction: preview (read) -> confirm -> execute ->
// readback. State lives in memory. The only requests are the preview GET and the two POSTs of the revoke routes. Nothing is
// requested on load: a link may prefill the two fields, the owner presses the button. No automatic retry of any write.
const rvLive = {preview: null, confirmation: null, busy: false, seq: 0};

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
  const basis = rvEl('revoke-basis'), accept = rvEl('revoke-accept');
  basis.disabled = staged || rvLive.busy;
  accept.disabled = staged || rvLive.busy;
  rvEl('revoke-confirm-button').hidden = staged;
  rvEl('revoke-confirm-button').disabled = rvLive.busy || !accept.checked || !basis.value.trim();
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
  rvLive.busy = true; rvLive.confirmation = null; rvPaint();
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
  if (!preview || !preview.available || rvLive.busy || rvLive.confirmation) return null;
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
  rvEl('revoke-basis').addEventListener('input', rvPaint);
  for (const id of ['revoke-key', 'revoke-request']) rvEl(id).addEventListener('input', () => { rvLive.preview = null; rvLive.confirmation = null; rvPaint(); });
  rvPaint();
}
if (typeof document !== 'undefined' && document.querySelector('#revoke-form')) rvStart();
