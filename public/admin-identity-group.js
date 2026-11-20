// ADR 0181 / AIR-131: the owner group workflow of ONE movie: preview (read) -> explicit selection -> confirm -> execute -> readback.
// State lives in memory. The only requests are the preview GET, the two POSTs and the receipt GET of the group-* routes. Nothing is
// requested on load: a link may prefill the TMDB id, the owner presses the button. Nothing is selected for the owner and a write is
// never repeated automatically.
const gpLive = {preview: null, selected: new Set(), confirmation: null, members: null, result: null, busy: false, seq: 0};
const GP_CAP = 10;

function gpEl(id) {return document.querySelector('#' + id);}
function gpShow(id, shown) {const node = gpEl(id); if (node) node.hidden = !shown;}
function gpError(text) {
  const node = gpEl('group-error');
  node.textContent = text || '';
  node.hidden = !text;
}
function gpRefusal(result) {
  const body = result.body || {};
  const reason = typeof body.reason === 'string' ? body.reason : result.error;
  const failing = Array.isArray(body.failing) && body.failing.length ? ' ' + body.failing.map(item => item.id + ': ' + groupReasonText(item.reason)).join('; ') : '';
  return groupReasonText(result.error === 'group_selection_changed' ? 'group_selection_changed' : reason) + failing;
}
function gpPaint() {
  const preview = gpLive.preview;
  const available = !!(preview && preview.available);
  const staged = !!gpLive.confirmation;
  const locked = staged || gpLive.busy;
  gpEl('group-film').innerHTML = available ? groupFilmHtml(preview) : '';
  gpEl('group-coverage').innerHTML = available ? groupCoverageHtml(preview) : '';
  gpShow('group-writer', available && preview.writerActive === true);
  gpShow('group-list-box', available);
  gpEl('group-list').innerHTML = available ? groupRowsHtml(preview, gpLive.selected, locked) : '';
  if (available) {
    const full = gpLive.selected.size >= GP_CAP;
    for (const box of gpEl('group-list').querySelectorAll('input[data-group-key]')) if (!box.checked && full) box.disabled = true;
  }
  gpEl('group-count').textContent = available ? 'Выбрано: ' + gpLive.selected.size + ' из не более ' + GP_CAP + '. Ничего не выбрано за вас.' : '';
  const size = gpLive.selected.size;
  gpShow('group-confirm-form', available && size >= 1 && !staged);
  gpEl('group-accept-text').textContent = available ? 'Я подтверждаю именно этот набор из ' + size + ' наблюдений для фильма «' + (preview.film.title || preview.tmdbId) + '»' : '';
  const basis = gpEl('group-basis'), accept = gpEl('group-accept');
  basis.disabled = gpLive.busy; accept.disabled = gpLive.busy;
  gpEl('group-confirm-button').disabled = gpLive.busy || !accept.checked || !basis.value.trim() || !available || preview.writerActive === true || size < 1;
  gpShow('group-staged', staged);
  gpEl('group-plan').innerHTML = staged ? groupMembersHtml(gpLive.members) : '';
  gpEl('group-execute-button').disabled = gpLive.busy;
  gpEl('group-cancel-button').disabled = gpLive.busy;
  gpEl('group-preview-button').disabled = gpLive.busy;
  gpEl('group-loading').setAttribute('aria-busy', gpLive.busy ? 'true' : 'false');
  gpShow('group-loading', gpLive.busy);
  const result = gpEl('group-result');
  result.innerHTML = gpLive.result ? groupOutcomesHtml(gpLive.result) : '';
  result.hidden = !gpLive.result;
}
async function gpPreview(keepResult) {
  const tmdbId = gpEl('group-tmdb').value.trim();
  gpError('');
  if (!/^[1-9]\d{0,11}$/.test(tmdbId)) { gpError(groupReasonText('invalid_request')); return null; }
  const seq = ++gpLive.seq;
  gpLive.busy = true; gpLive.confirmation = null; gpLive.members = null; gpLive.selected = new Set();
  if (!keepResult) gpLive.result = null;
  gpPaint();
  const result = await groupPreviewGet(tmdbId);
  if (seq !== gpLive.seq) return result;
  gpLive.busy = false;
  if (result.ok && result.body && result.body.available) gpLive.preview = result.body;
  else { gpLive.preview = null; gpError(groupReasonText(result.body && result.body.reason ? result.body.reason : result.error)); }
  gpPaint();
  return result;
}
function gpToggle(event) {
  const box = event.target;
  const key = box && box.getAttribute ? box.getAttribute('data-group-key') : null;
  if (key === null || gpLive.busy || gpLive.confirmation) return;
  if (box.checked) { if (gpLive.selected.size < GP_CAP) gpLive.selected.add(key); else box.checked = false; }
  else gpLive.selected.delete(key);
  gpEl('group-accept').checked = false;
  gpPaint();
}
async function gpConfirm() {
  const preview = gpLive.preview;
  if (!preview || !preview.available || gpLive.busy || gpLive.confirmation || !gpLive.selected.size) return null;
  gpError('');
  gpLive.busy = true; gpPaint();
  const result = await groupConfirmPost({tmdbId: preview.tmdbId, keys: [...gpLive.selected], basis: gpEl('group-basis').value.trim(), pin: preview.pin});
  gpLive.busy = false;
  if (result.ok && result.body && result.body.confirmation) { gpLive.confirmation = result.body.confirmation; gpLive.members = result.body.members; gpPaint(); gpEl('group-execute-button').focus(); return result; }
  gpError(gpRefusal(result));
  gpEl('group-accept').checked = false;
  if (result.error === 'stale_pin') return gpPreview(true);
  gpPaint();
  return result;
}
async function gpExecute() {
  if (!gpLive.confirmation || gpLive.busy) return null;
  gpError('');
  const confirmation = gpLive.confirmation;
  gpLive.busy = true; gpPaint();
  const result = await groupExecutePost(confirmation);
  gpLive.busy = false;
  if (result.ok && result.body && Array.isArray(result.body.outcomes)) {
    gpLive.confirmation = null; gpLive.members = null;
    gpLive.result = {state: result.body.state, outcomes: result.body.outcomes};
    gpEl('group-accept').checked = false;
    // Readback: the stored per-key children, read from D1, not the answer above.
    const receipt = await groupReceiptGet(confirmation.idempotencyKey);
    if (receipt.ok && receipt.body && Array.isArray(receipt.body.outcomes)) gpLive.result = {state: result.body.state, outcomes: result.body.outcomes, readback: receipt.body};
    await gpPreview(true);
    gpPaint();
    gpEl('group-result').focus();
    return result;
  }
  // A refusal or an unknown outcome is shown as it is. A write is never repeated from here.
  gpError(gpRefusal(result));
  if (result.error !== 'lease_held' && result.error !== 'writer_active') { gpLive.confirmation = null; gpLive.members = null; }
  gpPaint();
  return result;
}
function gpCancel() {
  if (gpLive.busy) return;
  gpLive.confirmation = null; gpLive.members = null;
  gpEl('group-accept').checked = false;
  gpPaint();
}
function gpStart() {
  const query = new URLSearchParams(location.search);
  if (query.get('tmdbId')) gpEl('group-tmdb').value = query.get('tmdbId').slice(0, 12);
  gpEl('group-form').addEventListener('submit', event => { event.preventDefault(); gpPreview(false); });
  gpEl('group-list').addEventListener('change', gpToggle);
  gpEl('group-confirm-form').addEventListener('submit', event => { event.preventDefault(); gpConfirm(); });
  gpEl('group-execute-button').addEventListener('click', () => { gpExecute(); });
  gpEl('group-cancel-button').addEventListener('click', gpCancel);
  gpEl('group-accept').addEventListener('change', gpPaint);
  gpEl('group-basis').addEventListener('input', gpPaint);
  gpEl('group-tmdb').addEventListener('input', () => { gpLive.preview = null; gpLive.selected = new Set(); gpLive.confirmation = null; gpLive.members = null; gpPaint(); });
  gpPaint();
}
if (typeof document !== 'undefined' && document.querySelector('#group-form')) gpStart();
