// ADR 0181 / AIR-131: the owner group workflow of ONE movie: preview (read) -> explicit selection -> confirm -> execute -> readback.
// State lives in memory. Reads: the bounded EPG worklist (on open), the catalogue title search, the preview GET and the receipt GET. Writes: only
// the two POSTs after the owner's explicit confirmation. Nothing is selected for the owner and a write is never repeated automatically.
const gpLive = {queue: {rows: [], next: null, pin: null, mode: 'idle', seq: 0}, search: {mode: 'idle', items: [], seq: 0}, pending: null, groupKey: null, preview: null, selected: new Set(), confirmation: null, members: null, result: null, busy: false, seq: 0};
const GP_CAP = 10;
const GP_STORE = 'iptv-group-pending';

// The group key is generated and kept BEFORE the confirmation is sent, so an unknown outcome (timeout, lost response, reload) never
// loses the only handle on the stored group. It is kept in this tab only; nothing is requested from it until the owner presses the button.
function gpRemember(value) {
  try { if (value) sessionStorage.setItem(GP_STORE, JSON.stringify(value)); else sessionStorage.removeItem(GP_STORE); } catch { /* no storage: the page still works */ }
}
function gpRecall() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(GP_STORE) || 'null');
    return parsed && typeof parsed.groupKey === 'string' && typeof parsed.tmdbId === 'string' ? parsed : null;
  } catch { return null; }
}
function gpUncertain(result) {
  return result.status === 0 || result.status >= 500 || result.error === 'in_progress' || result.error === 'idempotency_conflict';
}
function gpPending() {
  const node = gpEl('group-recover');
  const pending = gpLive.pending;
  node.hidden = !pending;
  gpEl('group-recover-text').textContent = pending ? 'Запись группы не завершена или её исход неизвестен. Ничего не повторяется само: проверьте результат, он читается из D1. Новую группу можно подтвердить, когда эта проверена или забыта.' : '';
}
// Read-only: the stored children of the group. A proven group with receipt-less children can then be continued with its ORIGINAL scope.
async function gpRecover() {
  const pending = gpLive.pending;
  if (!pending || gpLive.busy) return null;
  gpError('');
  gpLive.busy = true; gpPaint();
  const receipt = await groupReceiptGet(pending.groupKey);
  gpLive.busy = false;
  if (!receipt.ok || !receipt.body || !Array.isArray(receipt.body.outcomes)) {
    gpError(receipt.status === 404 ? 'Подтверждение этого набора пока не найдено в D1. Проверьте ещё раз позже или забудьте группу кнопкой выше: новая группа возможна только после этого.' : gpRefusal(receipt));
    gpPaint();
    return receipt;
  }
  const body = receipt.body;
  gpLive.pending = {...gpLive.pending, phase: 'stored'};
  gpRemember(gpLive.pending);
  const open = body.outcomes.filter(item => item.outcome === 'pending').length;
  // A terminal success is shown only for a PROVEN group (the receipt's barrier succeeded). Unproven stays unproven, handle kept, no replay.
  const state = !body.complete ? 'unproven' : body.outcomes.some(item => item.outcome === 'unknown') ? 'unknown' : open ? 'partial' : 'applied';
  gpLive.result = {state, outcomes: body.outcomes, readback: body};
  if (body.complete && body.confirmation && open && !body.outcomes.some(item => item.outcome === 'unknown' || item.outcome === 'missing')) {
    gpLive.confirmation = body.confirmation; gpLive.members = body.outcomes.map(item => ({key: item.key, index: item.index, plan: null}));
  } else { gpLive.confirmation = null; gpLive.members = null; }
  // Forgotten only after a PROVEN terminal state: every child applied. Unknown, running, approved or missing children keep the handle.
  if (body.complete && body.outcomes.every(item => item.outcome === 'applied')) { gpLive.pending = null; gpLive.groupKey = null; gpRemember(null); }
  gpPending();
  gpPaint();
  return receipt;
}

function gpEl(id) {return document.querySelector('#' + id);}
function gpShow(id, shown) {const node = gpEl(id); if (node) node.hidden = !shown;}
function gpError(text) {
  const node = gpEl('group-error');
  node.textContent = text || '';
  node.hidden = !text;
}
// Controlled inline validation (Russian, role=alert): the browser's own tooltip is never used. An invalid field is marked, described and focused.
function gpField(inputId, errorId, code) {
  const input = gpEl(inputId), note = gpEl(errorId);
  note.textContent = code ? groupValidationText(code) : '';
  note.hidden = !code;
  if (input) { if (code) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  if (code && input && input.focus) input.focus();
  return !code;
}
function gpClearFields() {
  for (const [inputId, errorId] of [['group-query', 'group-query-error'], ['group-tmdb', 'group-tmdb-error'], ['group-basis', 'group-basis-error'], ['group-accept', 'group-accept-error']]) {
    const note = gpEl(errorId), input = gpEl(inputId);
    note.textContent = ''; note.hidden = true;
    if (input) input.removeAttribute('aria-invalid');
  }
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
  gpShow('group-step2', available);
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
  // Enabled whenever a submit is possible: a missing basis or acknowledgement is explained inline on submit, not by a silent disabled button.
  gpEl('group-confirm-button').disabled = gpLive.busy || !available || preview.writerActive === true || size < 1;
  gpShow('group-staged', staged);
  gpEl('group-plan').innerHTML = staged ? groupMembersHtml(gpLive.members) : '';
  gpEl('group-execute-button').disabled = gpLive.busy;
  gpEl('group-cancel-button').disabled = gpLive.busy;
  gpEl('group-preview-button').disabled = gpLive.busy;
  gpEl('group-search-button').disabled = gpLive.busy || gpLive.search.mode === 'loading';
  gpEl('group-loading').setAttribute('aria-busy', gpLive.busy ? 'true' : 'false');
  gpShow('group-loading', gpLive.busy);
  const result = gpEl('group-result');
  result.innerHTML = gpLive.result ? groupOutcomesHtml(gpLive.result) : '';
  result.hidden = !gpLive.result;
}
async function gpPreview(keepResult) {
  const tmdbId = gpEl('group-tmdb').value.trim();
  gpError('');
  gpClearFields();
  if (!tmdbId) { gpEl('group-advanced').open = true; gpField('group-tmdb', 'group-tmdb-error', 'tmdb_empty'); return null; }
  if (!/^[1-9]\d{0,11}$/.test(tmdbId)) { gpEl('group-advanced').open = true; gpField('group-tmdb', 'group-tmdb-error', 'tmdb_invalid'); return null; }
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
  if (!gpLive.pending) gpLive.groupKey = null;
  gpPaint();
}
async function gpConfirm() {
  const preview = gpLive.preview;
  if (!preview || !preview.available || gpLive.busy || gpLive.confirmation) return null;
  gpError('');
  gpClearFields();
  // Any unfinished group blocks a fresh confirmation: it must be proven terminal or deliberately forgotten first. No same-key resubmit from here.
  if (gpLive.pending) { gpError('Есть незавершённая группа. Проверьте её результат или забудьте её кнопками выше: новая группа возможна только после этого.'); return null; }
  if (!gpLive.selected.size) { gpError(groupValidationText('none_selected')); return null; }
  const basisText = gpEl('group-basis').value.trim();
  if (!basisText) { gpField('group-basis', 'group-basis-error', 'basis_empty'); return null; }
  if (basisText.length > 200) { gpField('group-basis', 'group-basis-error', 'basis_long'); return null; }
  if (!gpEl('group-accept').checked) { gpField('group-accept', 'group-accept-error', 'accept_missing'); return null; }
  gpLive.groupKey = groupIdempotencyKey();
  gpLive.pending = {groupKey: gpLive.groupKey, tmdbId: preview.tmdbId};
  gpRemember(gpLive.pending);
  gpLive.busy = true; gpPaint();
  const result = await groupConfirmPost({tmdbId: preview.tmdbId, keys: [...gpLive.selected], basis: gpEl('group-basis').value.trim(), pin: preview.pin}, {idempotencyKey: gpLive.groupKey});
  gpLive.busy = false;
  if (result.ok && result.body && result.body.confirmation) { gpPending(); gpLive.confirmation = result.body.confirmation; gpLive.members = result.body.members; gpPaint(); gpEl('group-execute-button').focus(); return result; }
  gpError(gpRefusal(result));
  gpEl('group-accept').checked = false;
  if (gpUncertain(result)) { gpPending(); gpPaint(); return gpRecover(); }
  gpLive.pending = null; gpLive.groupKey = null; gpRemember(null); gpPending();
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
    if (gpLive.pending) { gpLive.pending = {...gpLive.pending, phase: 'stored'}; gpRemember(gpLive.pending); }
    gpPending();
    gpLive.result = {state: result.body.state, outcomes: result.body.outcomes};
    if (gpLive.pending) gpLive.pending = {...gpLive.pending, phase: 'stored'};
    gpEl('group-accept').checked = false;
    // Readback: the stored per-key children, read from D1, not the answer above.
    const receipt = await groupReceiptGet(confirmation.idempotencyKey);
    if (receipt.ok && receipt.body && Array.isArray(receipt.body.outcomes)) gpLive.result = {state: receipt.body.complete ? result.body.state : 'unproven', outcomes: result.body.outcomes, readback: receipt.body};
    // Forgotten only when the D1 readback PROVES the group and every child is applied; an unread or unproven group keeps its handle.
    if (receipt.ok && receipt.body && receipt.body.complete === true && receipt.body.outcomes.every(item => item.outcome === 'applied')) { gpLive.pending = null; gpLive.groupKey = null; gpRemember(null); }
    gpPending();
    await gpPreview(true);
    gpPaint();
    gpEl('group-result').focus();
    return result;
  }
  // A refusal or an unknown outcome is shown as it is. A write is never repeated from here.
  gpError(gpRefusal(result));
  if (gpUncertain(result)) { gpPending(); gpPaint(); return gpRecover(); }
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
// ---- Step 1 without knowing an id: the bounded EPG worklist and the catalogue search. Both only READ; nothing here posts.
function gpQueuePaint() {
  const queue = gpLive.queue;
  const busy = queue.mode === 'loading' || queue.mode === 'more';
  gpShow('group-queue-loading', busy);
  gpEl('group-queue-loading').setAttribute('aria-busy', busy ? 'true' : 'false');
  const failed = queue.mode === 'error' || queue.mode === 'stale';
  gpShow('group-queue-error', failed);
  gpEl('group-queue-error-text').textContent = failed ? groupValidationText(queue.mode === 'stale' ? 'stale_cursor' : 'queue_failed') : '';
  const empty = queue.mode === 'ready' && !queue.rows.length;
  gpShow('group-queue-empty', empty);
  gpEl('group-queue-empty-text').textContent = empty ? ' ' + groupValidationText('queue_empty') : '';
  gpEl('group-queue-list').innerHTML = groupQueueHtml(queue.rows);
  const more = gpEl('group-queue-more');
  more.hidden = !queue.next || failed;
  more.disabled = busy;
}
async function gpQueueLoad(more) {
  const queue = gpLive.queue;
  if (queue.mode === 'loading' || queue.mode === 'more') return null;
  const seq = ++queue.seq;
  const cursor = more ? queue.next : null;
  queue.mode = more ? 'more' : 'loading';
  if (!more) { queue.rows = []; queue.next = null; queue.pin = null; }
  gpQueuePaint();
  const result = await groupQueueGet({cursor, pin: more ? queue.pin : null});
  if (seq !== queue.seq) return result;
  const body = result.body || {};
  if (result.status === 409 || (result.status === 400 && result.error === 'stale_cursor') || (more && queue.pin && body.pin && body.pin !== queue.pin)) { queue.mode = 'stale'; gpQueuePaint(); return result; }
  if (!result.ok) { queue.mode = 'error'; gpQueuePaint(); return result; }
  queue.pin = body.pin || null;
  queue.rows = (more ? queue.rows : []).concat(Array.isArray(body.rows) ? body.rows : []);
  queue.next = body.nextCursor || null;
  queue.mode = 'ready';
  gpQueuePaint();
  return result;
}
async function gpSearch() {
  const query = gpEl('group-query').value.trim();
  gpError('');
  gpClearFields();
  gpShow('group-search-empty', false);
  if (!query) { gpField('group-query', 'group-query-error', 'query_empty'); return null; }
  if (query.length > 200) { gpField('group-query', 'group-query-error', 'query_long'); return null; }
  const search = gpLive.search;
  const seq = ++search.seq;
  search.mode = 'loading'; search.items = [];
  gpEl('group-search-results').innerHTML = '';
  gpShow('group-search-loading', true); gpEl('group-search-loading').setAttribute('aria-busy', 'true');
  gpPaint();
  const result = await groupFilmSearchGet(query);
  if (seq !== search.seq) return result;
  search.mode = 'ready';
  gpShow('group-search-loading', false); gpEl('group-search-loading').setAttribute('aria-busy', 'false');
  const empty = gpEl('group-search-empty');
  if (!result.ok) {
    const code = result.error === 'invalid_query' ? 'invalid_query' : 'search_failed';
    search.mode = 'error';
    empty.textContent = groupValidationText(code); empty.hidden = false;
  } else {
    search.items = Array.isArray(result.body && result.body.items) ? result.body.items : [];
    gpEl('group-search-results').innerHTML = groupFilmResultsHtml(search.items);
    empty.textContent = search.items.length ? '' : groupValidationText('search_empty');
    empty.hidden = !!search.items.length;
  }
  gpPaint();
  return result;
}
// A chosen catalogue Film becomes the anchor: its TRUSTED tmdb id goes through the unchanged group-preview (D1 proof), never a title or hint.
async function gpPick(tmdbId) {
  if (gpLive.busy) return null;
  gpEl('group-tmdb').value = tmdbId;
  const result = await gpPreview(false);
  const heading = gpEl('group-step2');
  if (heading && !heading.hidden && heading.focus) heading.focus();
  return result;
}
function gpFind(title) {
  gpEl('group-query').value = String(title || '').slice(0, 200);
  gpEl('group-query').focus();
  return gpSearch();
}
function gpStart() {
  const query = new URLSearchParams(location.search);
  if (query.get('tmdbId')) gpEl('group-tmdb').value = query.get('tmdbId').slice(0, 12);
  gpEl('group-form').addEventListener('submit', event => { event.preventDefault(); gpPreview(false); });
  gpEl('group-search-form').addEventListener('submit', event => { event.preventDefault(); gpSearch(); });
  gpEl('group-search-results').addEventListener('click', event => { const button = event.target && event.target.closest ? event.target.closest('[data-group-pick]') : null; if (button) gpPick(button.getAttribute('data-group-pick')); });
  gpEl('group-queue-list').addEventListener('click', event => { const button = event.target && event.target.closest ? event.target.closest('[data-group-find]') : null; if (button) gpFind(button.getAttribute('data-group-find')); });
  gpEl('group-queue-more').addEventListener('click', () => { gpQueueLoad(true); });
  gpEl('group-queue-retry').addEventListener('click', () => { gpQueueLoad(false); });
  gpEl('group-list').addEventListener('change', gpToggle);
  gpEl('group-confirm-form').addEventListener('submit', event => { event.preventDefault(); gpConfirm(); });
  gpEl('group-execute-button').addEventListener('click', () => { gpExecute(); });
  gpEl('group-cancel-button').addEventListener('click', gpCancel);
  gpEl('group-recover-button').addEventListener('click', () => { gpRecover(); });
  gpEl('group-recover-dismiss').addEventListener('click', () => { if (gpLive.busy) return; gpLive.pending = null; gpLive.groupKey = null; gpLive.confirmation = null; gpLive.members = null; gpLive.result = null; gpEl('group-accept').checked = false; gpRemember(null); gpPending(); gpPaint(); });
  gpLive.pending = gpRecall(); gpLive.groupKey = gpLive.pending ? gpLive.pending.groupKey : null; gpPending();
  if (gpLive.pending && !gpEl('group-tmdb').value) gpEl('group-tmdb').value = gpLive.pending.tmdbId;
  gpEl('group-accept').addEventListener('change', gpPaint);
  gpEl('group-basis').addEventListener('input', gpPaint);
  gpEl('group-tmdb').addEventListener('input', () => { gpLive.preview = null; gpLive.selected = new Set(); gpLive.confirmation = null; gpLive.members = null; gpPaint(); });
  gpPaint();
  gpQueuePaint();
  // Opening the page is useful at once and read-only: the bounded EPG worklist is read, and a deep link with a movie id shows its group. No POST starts here.
  gpQueueLoad(false);
  if (query.get('tmdbId')) gpPreview(false);
}
if (typeof document !== 'undefined' && document.querySelector('#group-form')) gpStart();
