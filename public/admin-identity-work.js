// The unified identity queue on /admin/limb: one read-only list over GET /api/admin/identity-work. It starts no action, no import, no step,
// no external call. The only requests are GETs of that route. State lives in memory; a stale cursor or pin keeps the rows on screen and
// says they are not current, and the owner reloads from the first page.
const iwLive = {state: {type: '', disposition: '', include: false, q: ''}, pin: null, rows: [], next: null, coverage: {}, mode: 'idle', seq: 0, controller: null, error: null, started: false, inflight: null};

function iwEl(id) {return document.querySelector('#' + id);}
function iwSetHidden(id, hidden) {const node = iwEl(id); if (node) node.hidden = hidden;}
function iwReadForm() {
  return {type: iwEl('iw-type').value, disposition: iwEl('iw-disposition').value, include: iwEl('iw-include').checked, q: iwEl('iw-q').value.trim()};
}
function iwPaint() {
  const view = {mode: iwLive.mode, rows: iwLive.rows, nextCursor: iwLive.next, coverage: iwLive.coverage};
  const busy = iwLive.mode === 'loading' || iwLive.mode === 'more';
  iwSetHidden('iw-loading', !busy);
  iwEl('iw-loading').setAttribute('aria-busy', busy ? 'true' : 'false');
  const failed = iwLive.mode === 'error';
  iwSetHidden('iw-error', !failed);
  iwEl('iw-error-text').textContent = failed ? iwEl('iw-error-text').dataset.text || '' : '';
  iwSetHidden('iw-stale', iwLive.mode !== 'stale');
  iwEl('iw-verdict').textContent = iwLive.mode === 'idle' ? 'Очередь ещё не прочитана.' : iwVerdict(view);
  iwEl('iw-results').innerHTML = iwRowsHtml(iwLive.rows);
  const empty = !busy && !failed && !iwLive.rows.length && iwLive.mode !== 'idle';
  iwSetHidden('iw-empty', !empty);
  if (empty) iwEl('iw-empty-text').textContent = iwEmptyText(view);
  iwEl('iw-coverage-body').innerHTML = iwCoverageHtml(iwLive.coverage);
  const more = iwEl('iw-more');
  // No paging from a failed or stale list: the owner reloads from the first page instead.
  more.hidden = !iwLive.next || iwLive.mode === 'error' || iwLive.mode === 'stale';
  more.disabled = iwLive.mode === 'more' || iwLive.mode === 'loading';
  more.textContent = iwLive.mode === 'more' ? 'Читаем…' : 'Показать ещё';
  iwEl('iw-include').disabled = iwEl('iw-disposition').value !== '';
}
function iwFail(code) {
  iwLive.mode = 'error';
  iwEl('iw-error-text').dataset.text = iwErrorText(code);
  iwEl('iw-error-text').textContent = iwErrorText(code);
}
// The Limbo queue above and this list are two reads of the same sources (published programme, dictionaries, queue, view index, Discovery index). Loaded at once
// they overran the isolate's memory on the live page, and the Worker cannot be asked to share one load between requests, so the page itself never has both in flight:
// this list waits for the Limbo read the page started first, and a Limbo read that starts while this list is loading waits for it (iwIdle, called by limboRead).
function iwAfterLimbo() {
  const pending = typeof limboLive !== 'undefined' && limboLive && limboLive.pending ? limboLive.pending : null;
  return pending ? Promise.resolve(pending).then(() => {}, () => {}) : Promise.resolve();
}
function iwIdle() {
  return iwLive.inflight ? iwLive.inflight.then(() => {}, () => {}) : Promise.resolve();
}
async function iwLoad(more) {
  if (iwLive.controller) iwLive.controller.abort();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  iwLive.controller = controller;
  const seq = ++iwLive.seq;
  const state = more ? iwLive.state : iwReadForm();
  // A first page starts a new query: nothing of the previous query (rows, coverage, pin, cursor) may stay on screen as current,
  // and the previous cursor must never be sent with the new filter.
  if (!more) {iwLive.state = state; iwLive.rows = []; iwLive.next = null; iwLive.pin = null; iwLive.coverage = {};}
  iwLive.mode = more ? 'more' : 'loading';
  iwPaint();
  const cursor = more ? iwLive.next : null, pin = more ? iwLive.pin : null;
  const run = (async () => {
    await iwAfterLimbo();
    if (seq !== iwLive.seq) return null;
    return loadIdentityWork(state, cursor, {pin, signal: controller ? controller.signal : undefined});
  })();
  iwLive.inflight = run;
  const result = await run;
  if (iwLive.inflight === run) iwLive.inflight = null;
  if (result === null || seq !== iwLive.seq || result.mode === 'aborted') return;
  if (result.mode === 'stale') {iwLive.mode = 'stale'; iwPaint(); return;}
  if (result.mode === 'error') {iwFail(result.error); iwPaint(); return;}
  iwLive.mode = 'ready';
  iwLive.pin = result.pin;
  iwLive.rows = more ? iwLive.rows.concat(result.rows) : result.rows;
  iwLive.next = result.nextCursor;
  iwLive.coverage = result.coverage;
  iwPaint();
}
function iwReset() {
  iwEl('iw-type').value = ''; iwEl('iw-disposition').value = ''; iwEl('iw-include').checked = false; iwEl('iw-q').value = '';
  iwLoad(false);
}
function startIdentityWork() {
  if (iwLive.started || !iwEl('iw-section')) return;
  iwLive.started = true;
  iwEl('iw-form').addEventListener('submit', event => {event.preventDefault(); iwLoad(false);});
  iwEl('iw-disposition').addEventListener('change', iwPaint);
  iwEl('iw-reset').addEventListener('click', iwReset);
  iwEl('iw-refresh').addEventListener('click', () => iwLoad(false));
  iwEl('iw-reload').addEventListener('click', () => iwLoad(false));
  iwEl('iw-retry').addEventListener('click', () => iwLoad(false));
  iwEl('iw-more').addEventListener('click', () => iwLoad(true));
  iwLoad(false);
}

// The one bootstrap of the served bundle, after every definition and every initialised const of both files: the Limbo page first (its first read is scheduled once), then
// this list, which waits for that read. Without the Limbo file (the tests of this controller) only the list starts.
if (typeof startLimbo === 'function') startLimbo();
startIdentityWork();
