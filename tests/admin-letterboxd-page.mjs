// The /admin/letterboxd page: its bundle runs against a DOM stand-in and its one POST goes to the Worker route over an R2
// stand-in. Covers the boundary (no request on open, no import button, nothing stored), the local checks, the answer the
// owner reads, errors, cancel and reset.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';
import {exportArchive, zipArchive} from './fixtures/letterboxd-archive.mjs';

const html = fs.readFileSync('public/admin-letterboxd.html', 'utf8');
const page = fs.readFileSync('public/admin-letterboxd.js', 'utf8');
const client = fs.readFileSync('src/admin/letterboxd-archive-client.js', 'utf8');
const view = fs.readFileSync('src/admin/letterboxd-archive-view.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const bundle = bundleAdmin([client, view, page]);
const build = fs.readFileSync('build.mjs', 'utf8');

// Static boundary.
assert.match(html, /ПРЕДПРОСМОТР БЕЗ ЗАПИСИ/);
for (const id of ['archive-form', 'archive-file', 'archive-generated-at', 'archive-submit', 'archive-cancel', 'archive-reset', 'archive-loading', 'archive-error', 'archive-idle', 'archive-result']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="archive-file"') < html.indexOf('id="archive-generated-at"') && html.indexOf('id="archive-generated-at"') < html.indexOf('id="archive-submit"'), 'file, time, then submit in tab order');
assert.match(html, /accept="\.zip,application\/zip"/);
assert.match(html, /<script src="\/admin-letterboxd\.js"><\/script>/);
assert.match(html, /<a href="\/admin\/health">Здоровье данных<\/a><a href="\/admin\/letterboxd" aria-current="page">Архив Letterboxd<\/a><a href="\/admin\/limb">Лимб<\/a><a href="\/admin\/posters">Постеры<\/a><\/nav>/);
for (const file of ['public/admin.html', 'public/admin-limbo.html', 'public/admin-posters.html']) assert.match(fs.readFileSync(file, 'utf8'), /<a href="\/admin\/letterboxd"[^>]*>Архив Letterboxd<\/a><a href="\/admin\/limb"/, file + ' links to the archive page');
assert.doesNotMatch(html, /\/api\/|fetch\(/);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the client');
assert.doesNotMatch(bundle, /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|Authorization|Bearer|history\.(push|replace)State|\/api\/letterboxd\/baseline|\/api\/sync|\/mcp/);
assert.doesNotMatch(bundle + html, /Импортировать|Применить|\/commit|\/validate|data-archive-apply/i, 'no control commits by itself or calls the service-token route');
assert.equal((html.match(/<button/g) || []).length, 3, 'submit, cancel and reset are the only buttons in the static page');
assert.match(html, /<ol id="archive-steps" class="archive-steps" aria-label="Шаги проверки архива">/);
assert.equal((html.match(/data-archive-step="/g) || []).length, 5);
assert.doesNotMatch(html.slice(html.indexOf('id="archive-steps"'), html.indexOf('</ol>')), /<button/, 'the step list is not a row of buttons');
assert.match(bundle, /data-archive-confirm/, 'a preview can offer a separate confirmation');
assert.match(bundle, /data-archive-commit/, 'recording is a second control');
assert.doesNotMatch(client, /Cf-Access|service.token|CF-Access-Client/, 'the page never carries an Access token');
assert.equal((bundle.match(/\bfetchImpl\(/g) || []).length, 1, 'one request site');
assert.match(client, /method:'POST'/);
assert.match(client, /credentials:'same-origin'/);
assert.match(build, /assets\['\/admin\/letterboxd'\]/);
assert.match(build, /assets\['\/admin-letterboxd\.js'\]/);
assert.match(css, /\.archive-totals\{/);
assert.match(css, /@media\(max-width:800px\)\{\.archive-totals\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);

// Worker over an R2 stand-in.
const NOW = Date.parse('2026-10-31T09:00:00.000Z'), D = 86400000, G1 = '11111111-1111-4111-8111-111111111111';
const records = new Map();
let gets = 0;
const bucket = {
  async get(key) {gets++; const text = records.get(key); return text === undefined ? null : {etag: 'e-' + key, json: async () => JSON.parse(text), text: async () => text};},
  async put() {throw new Error('the page never writes');},
  async list() {throw new Error('the page never lists');},
};
const put = (key, value) => records.set(key, JSON.stringify(value));
const {worker, facts} = loadArchiveWorker({now: NOW, console: {log() {throw new Error('log');}, warn() {throw new Error('log');}, error() {throw new Error('log');}, info() {throw new Error('log');}}, fetch: async () => {throw new Error('no outbound request');}});
const film = (id, title, year) => ({id, tmdbId: null, title, original: title, titleRu: title, titleStatus: 'verified', year, directors: [], actors: [], shows: []});
put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - D).toISOString()});
put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: [film('a1', 'Alpha <b>', 2001), film('b2', 'Beta', 2002)], people: {directors: [], actors: []}, stats: {}});
put(facts.FACTS_KEYS.links, {'letterboxd:b2': 'lb-b2'});
put(facts.recordKey('lb-b2'), {...facts.emptyRecord('lb-b2', {letterboxd: 'b2'}), rating: await facts.observation({factKey: 'lb-b2', fact: 'rating', value: 5, observedAt: '2026-10-29T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 's'}), watched: await facts.observation({factKey: 'lb-b2', fact: 'watched', value: true, observedAt: '2026-10-29T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 's'})});
const ARCHIVE = exportArchive([{code: 'a1', name: 'Alpha <b>', year: 2001, watched: true, rating: 4}, {code: 'b2', name: 'Beta', year: 2002, watched: true, rating: 3}, {code: 'zz', name: 'Nowhere', year: 1990, watched: true}]);
let requests = [];
const fakeFetch = async (input, init = {}) => {
  requests.push({url: String(input), method: init.method, credentials: init.credentials, cache: init.cache, headers: init.headers, fields: [...init.body.keys()]});
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
  const encoded = new Request('https://iptv.test/x', {method: 'POST', body: init.body});
  const body = new Uint8Array(await encoded.arrayBuffer());
  const response = await worker.fetch(new Request('https://iptv.test' + input, {method: init.method, headers: {...init.headers, Origin: 'https://iptv.test', 'Content-Type': encoded.headers.get('content-type'), 'Content-Length': String(body.length)}, body}), {BUCKET: bucket}, {waitUntil() {throw new Error('background work');}});
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
  return response;
};

// DOM stand-in.
const listeners = new Map();
function element(selector) {
  return {
    selector, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false, files: [],
    focus() {document.activeElement = this;},
    reset() {nodes.get('#archive-file').files = []; nodes.get('#archive-file').value = ''; nodes.get('#archive-generated-at').value = '';},
    addEventListener(type, fn) {const list = listeners.get(selector) || []; list.push({type, fn}); listeners.set(selector, list);},
  };
}
const nodes = new Map(['#archive-form', '#archive-file', '#archive-generated-at', '#archive-submit', '#archive-cancel', '#archive-reset', '#archive-loading', '#archive-error', '#archive-idle', '#archive-result'].map(selector => [selector, element(selector)]));
const steps = [1, 2, 3, 4, 5].map(n => ({
  n, attrs: {},
  getAttribute(name) {return name === 'data-archive-step' ? String(this.n) : (Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null);},
  setAttribute(name, value) {this.attrs[name] = String(value);},
  removeAttribute(name) {delete this.attrs[name];},
}));
const document = {activeElement: null, querySelector: selector => nodes.get(selector) || null, querySelectorAll: selector => selector === '[data-archive-step]' ? steps : []};
function currentStep() {
  const item = steps.find(step => step.attrs['aria-current'] === 'step');
  assert.ok(item, 'one step is current');
  assert.equal(steps.filter(step => step.attrs['aria-current'] === 'step').length, 1);
  return item.n;
}
const windowListeners = [];
const window = {addEventListener(type, fn) {windowListeners.push({type, fn});}};
const ctx = vm.createContext({document, window, fetch: fakeFetch, FormData, File, Blob, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = () => run('archiveLive.pending');
const fileInput = nodes.get('#archive-file'), time = nodes.get('#archive-generated-at'), result = nodes.get('#archive-result'), error = nodes.get('#archive-error'), idle = nodes.get('#archive-idle'), loading = nodes.get('#archive-loading');
const choose = (bytes, name) => {fileInput.files = [new File([bytes], name, {type: 'application/zip'})];};
const submit = () => run('onArchiveSubmit({preventDefault(){}})');

// 1. Opening the page sends nothing and reads nothing.
assert.deepEqual(requests, []);
assert.equal(gets, 0);
assert.equal(idle.hidden, false); assert.equal(loading.hidden, true); assert.equal(error.hidden, true); assert.equal(result.innerHTML, '');
assert.equal(currentStep(), 1);

// 2. Local checks stop the request before it is sent.
for (const [setup, pattern] of [
  [() => {fileInput.files = [];}, /Выбери ZIP-архив/],
  [() => choose(ARCHIVE, 'export.txt'), /файл \.zip/],
  [() => {fileInput.files = [{name: 'big.zip', size: 11 * 1024 * 1024}];}, /больше 10 МБ/],
  [() => choose(ARCHIVE, 'renamed.zip'), /Укажи его в поле «Время экспорта, UTC»/],
  [() => {choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip'); time.value = '2026-10-20T08:15Z';}, /Очисти поле/],
]) {
  time.value = '';
  setup();
  await submit();
  assert.match(error.textContent, pattern);
  assert.equal(error.hidden, false);
  assert.equal(document.activeElement, error, 'the error takes focus so a screen reader announces it');
  assert.equal(currentStep(), 1);
}
assert.deepEqual(requests, []);

// 3. One POST with the archive, and the answer the owner reads.
time.value = '';
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
const pending = submit();
assert.equal(loading.hidden, false);
assert.equal(currentStep(), 2);
assert.equal(nodes.get('#archive-submit').disabled, true);
assert.equal(nodes.get('#archive-cancel').hidden, false);
await pending;
assert.deepEqual(requests.map(request => [request.url, request.method, request.credentials, request.cache, request.fields.join(',')]), [['/api/admin/letterboxd-archive/preview', 'POST', 'same-origin', 'no-store', 'archive']]);
assert.equal(requests[0].headers.Authorization, undefined);
assert.equal(error.hidden, true); assert.equal(loading.hidden, true); assert.equal(idle.hidden, true);
assert.equal(document.activeElement, result);
const shown = result.innerHTML;
assert.match(shown, /Архив успешно прочитан: 4\/4 CSV, ошибок нет, создан 11 дн\. назад/);
assert.doesNotMatch(shown, /создан менее часа назад|скачивать новый ZIP не нужно/);
assert.match(shown, /Нужен свежий архив/);
assert.match(shown, /оценка в R2 новее этого архива/);
assert.match(shown, /Изменений значений: 0\. Новых значений: 2\./);
assert.match(shown, /Эти числа — факты среди проверенных фильмов, не весь архив/);
assert.match(shown, /не проверено \(фильмов\)/);
assert.equal(currentStep(), 3);
assert.match(shown, /<div class="archive-total"><b>\d+<\/b><span>добавится<\/span>/);
assert.match(shown, /<span>изменится<\/span>/);
assert.match(shown, /<span>пропущено<\/span>/);
assert.match(shown, /Шаг 2\. Свежесть/);
assert.match(shown, /Шаг 5\. Квитанция/);
assert.match(shown, /Квитанции ещё нет/);
assert.match(shown, /<details class="archive-technical"><summary>Технические подробности<\/summary>[\s\S]*class="archive-sha"/);
assert.doesNotMatch(shown.split('<details class="archive-technical">')[0], /archive-sha|Отпечаток плана/);
assert.match(shown, /Новых или изменённых значений: 2\. Обновлений наблюдений без смены значения: 0\./);
assert.match(shown, /20\.10\.2026, 10:15 Madrid/, 'the export time in Madrid time');
assert.match(shown, /из имени файла/);
assert.match(shown, /<code class="archive-sha">[0-9a-f]{64}<\/code>/);
assert.match(shown, /базовая линия.*неизвестно/s);
assert.match(shown, /этот архив не импортировался/);
assert.match(shown, /ничего не записано/);
assert.match(shown, /Alpha &lt;b&gt;/, 'archive values are escaped');
assert.doesNotMatch(shown, /Alpha <b>/);
assert.match(shown, /точный id Letterboxd: 2/);
assert.match(shown, /не найдено: 1/);
assert.match(shown, /<details class="archive-details"><summary>Новое значение <small>1<\/small>/);
assert.match(shown, /<details class="archive-details"><summary>В R2 новее <small>1<\/small>/);
assert.match(shown, /в R2: 5/);
assert.doesNotMatch(shown, /<details[^>]* open/, 'detail lists start closed');
assert.match(shown, /data-archive-confirm="0"/, 'the compared batch can be confirmed');
assert.doesNotMatch(shown, /data-archive-commit/, 'confirmation is not yet issued, so nothing can be recorded');
assert.match(shown, /Запись не начинается сама/);
assert.equal(requests.length, 1, 'showing the confirmation does not send a second request');
const held = run('archiveLive.answer');
assert.equal(held.mode, 'preview');

// 4. A renamed archive with a declared time; a server refusal with its reason.
requests = [];
choose(ARCHIVE, 'renamed.zip'); time.value = '2026-10-30T07:00Z';
await submit();
assert.deepEqual(requests[0].fields, ['archive', 'generatedAt']);
assert.match(result.innerHTML, /указано вручную/);
choose(zipArchive([{name: 'watched.csv', data: Buffer.from([0x44, 0xff, 0x0a])}]), 'letterboxd-demo-user-2026-10-20-08-15-utc.zip'); time.value = '';
await submit();
assert.equal(error.hidden, false);
assert.match(error.textContent, /Архив не прошёл проверку.*текст не в UTF-8 \(watched\.csv\)/);
assert.equal(result.innerHTML, '', 'an old answer is not left beside a new error');
assert.equal(run('archiveLive.answer'), null);

// 5. Cancel drops the request; Escape cancels too; reset clears the form and the answer.
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
const cancelled = submit();
run('onArchiveCancel()');
await cancelled;
assert.equal(idle.hidden, false); assert.equal(result.innerHTML, ''); assert.equal(error.hidden, true);
const escaped = submit();
for (const item of windowListeners) if (item.type === 'keydown') item.fn({key: 'Escape', preventDefault() {}});
await escaped;
assert.equal(idle.hidden, false); assert.equal(result.innerHTML, '');
await submit();
assert.notEqual(result.innerHTML, '');
run('onArchiveReset()');
assert.equal(result.innerHTML, ''); assert.equal(run('archiveLive.answer'), null);
assert.deepEqual(fileInput.files, []); assert.equal(time.value, '');
assert.equal(document.activeElement, fileInput);
assert.equal(currentStep(), 1);
// Leaving the page drops the answer.
await submit().catch(() => {});
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
await submit();
for (const item of windowListeners) if (item.type === 'pagehide') item.fn();
assert.equal(run('archiveLive.answer'), null);
// 6. Confirming a batch is a second request. Recording is a third. Neither follows the preview by itself.
ctx.crypto = webcrypto;
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
await submit();
const beforeConfirm = requests.length;
await run('onArchiveConfirm(0)');
assert.equal(requests.length, beforeConfirm + 1);
assert.equal(requests.at(-1).url, '/api/admin/letterboxd-archive/apply-confirm');
assert.equal(requests.at(-1).headers['X-IPTV-Admin-Action'], 'letterboxd_archive_apply');
assert.equal(requests.at(-1).headers.Authorization, undefined);
assert.equal(requests.at(-1).headers['Cf-Access-Jwt-Assertion'], undefined, 'the page does not attach an Access token');
assert.equal(requests.filter(request => request.url.endsWith('/apply')).length, 0, 'confirm does not commit');
await run('onArchiveCommit(0)');
assert.equal(requests.filter(request => request.url.endsWith('/apply')).length, 0, 'without an issued confirmation the record control sends nothing');

// 7. A commit answer is shown by its receipt, not as a full write merely because the HTTP status is 200.
const counts = (extra) => ({written: 0, already_applied: 0, skipped_changed: 0, failed: 0, unknown: 0, not_attempted: 0, ...extra});
const paintCommit = async (state, extra, replayed = false) => {
  const previous = ctx.fetch;
  ctx.fetch = async () => new Response(JSON.stringify({mode: 'apply', writes: state === 'succeeded', replayed, state, receipt: {state, counts: counts(extra)}}), {status: 200, headers: {'Content-Type': 'application/json'}});
  run('archiveLive.issued[0] = {idempotencyKey:"lb0123456789abcdef"}; archiveLive.committed = {};');
  await run('onArchiveCommit(0)');
  ctx.fetch = previous;
  return result.innerHTML;
};
run('archiveLive.issued[0] = {idempotencyKey:"lb0123456789abcdef"}; archiveLive.committed = {}; archiveShow("ready", archiveLive.answer);');
assert.equal(currentStep(), 4);
assert.match(result.innerHTML, /Записать партию 1/);
assert.match(result.innerHTML, /data-archive-commit="0"/);
assert.doesNotMatch(result.innerHTML, /Повторить ту же запись/);
const failedHtml = await paintCommit('failed', {skipped_changed: 2});
assert.match(failedHtml, /Факты партии 1 не изменились/);
assert.match(failedHtml, /пропущено: 2/);
assert.doesNotMatch(failedHtml, /Партия 1 записана/);
assert.doesNotMatch(failedHtml, /Повторить ту же запись/);
const partialHtml = await paintCommit('partial', {written: 1, skipped_changed: 1, failed: 1});
assert.match(partialHtml, /Партия 1 записана частично/);
assert.match(partialHtml, /записано: 1/);
assert.match(partialHtml, /пропущено: 1/);
assert.match(partialHtml, /ошибки: 1/);
assert.doesNotMatch(partialHtml, /записана полностью/);
assert.doesNotMatch(partialHtml, /Повторить ту же запись/);
const fullHtml = await paintCommit('succeeded', {written: 2});
assert.match(fullHtml, /Партия 1 записана полностью/);
assert.match(fullHtml, /записано: 2/);
assert.doesNotMatch(fullHtml, /Повторить ту же запись/);
assert.equal(currentStep(), 5);
const replayHtml = await paintCommit('succeeded', {already_applied: 2}, true);
assert.match(replayHtml, /уже была записана/);
assert.match(replayHtml, /Повтор ничего не меняет/);
assert.doesNotMatch(replayHtml, /записана полностью/);
const replayPartial = await paintCommit('partial', {already_applied: 1, skipped_changed: 1}, true);
assert.match(replayPartial, /Партия 1 записана частично/);
assert.match(replayPartial, /пропущено: 1/);
assert.doesNotMatch(replayPartial, /записана полностью/);
const replayFailed = await paintCommit('failed', {skipped_changed: 2}, true);
assert.match(replayFailed, /Факты партии 1 не изменились/);
assert.doesNotMatch(replayFailed, /записана полностью/);
assert.doesNotMatch(replayFailed, /Партия 1 записана/);
const unknownHtml = await paintCommit('unknown', {unknown: 2});
assert.match(unknownHtml, /Исход партии 1 неизвестен/);
assert.match(unknownHtml, /Повтор вслепую не запускается/);
assert.match(unknownHtml, /Это не успех/);
assert.match(unknownHtml, /Повторить ту же запись/);
assert.match(unknownHtml, /data-archive-commit="0"/);
assert.doesNotMatch(unknownHtml, /записана полностью|записана частично/);
assert.equal(currentStep(), 5);
const issued = run('JSON.stringify(archiveLive.issued[0])');
const keyBefore = run('archiveLive.keys[0]');
let posted = null;
ctx.fetch = async (_url, init) => {
  posted = init.body.get('confirmation');
  return new Response(JSON.stringify({mode: 'apply', writes: false, replayed: true, state: 'unknown', receipt: {state: 'unknown', counts: counts({unknown: 2})}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveCommit(0)');
assert.equal(posted, issued);
assert.equal(JSON.parse(posted).idempotencyKey, 'lb0123456789abcdef');
assert.equal(run('archiveLive.keys[0]'), keyBefore);

// 8. A commit whose response is lost is unknown, never "the write did not start", and the manual retry sends the same confirmation.
function fire(selector, type) {
  for (const item of listeners.get(selector) || []) if (item.type === type) item.fn({});
}
const lostCommit = async (fetchImpl) => {
  ctx.fetch = fetchImpl;
  run('archiveLive.issued[0] = {idempotencyKey:"lb0123456789abcdef", chunk:0}; archiveLive.committed = {}; archiveLive.stale = false;');
  await run('onArchiveCommit(0)');
  return result.innerHTML;
};
const networkHtml = await lostCommit(async () => {throw new Error('offline');});
assert.match(networkHtml, /Исход партии 1 неизвестен/);
assert.match(networkHtml, /Запрос на запись уже ушёл/);
assert.match(networkHtml, /Повторить ту же запись/);
assert.doesNotMatch(networkHtml, /не начиналась/);
const unavailableHtml = await lostCommit(async () => new Response(JSON.stringify({error: 'storage_unavailable'}), {status: 503, headers: {'Content-Type': 'application/json'}}));
assert.match(unavailableHtml, /Исход партии 1 неизвестен/);
assert.doesNotMatch(unavailableHtml, /не начиналась|Ничего не записано/);
const unreadableHtml = await lostCommit(async () => new Response('<html>cut</html>', {status: 200, headers: {'Content-Type': 'text/html'}}));
assert.match(unreadableHtml, /Исход партии 1 неизвестен/);
assert.doesNotMatch(unreadableHtml, /не начиналась/);
const frozen = run('JSON.stringify(archiveLive.issued[0])');
let replayed = null, replayPosts = 0;
ctx.fetch = async (_url, init) => {
  replayPosts++;
  replayed = init.body.get('confirmation');
  return new Response(JSON.stringify({mode: 'apply', writes: false, replayed: true, state: 'unknown', receipt: {state: 'unknown', counts: counts({unknown: 1})}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveCommit(0)');
assert.equal(replayPosts, 1);
assert.equal(replayed, frozen);

// 9. Cancel or Escape after a write has left the browser does not idle the page or mint a new command.
let commitPosts = 0;
ctx.fetch = (_url, init) => new Promise((_resolve, reject) => {
  commitPosts++;
  if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
});
run('archiveLive.issued[0] = {idempotencyKey:"lb0123456789abcdef", chunk:0}; archiveLive.committed = {};');
const hangingCommit = run('onArchiveCommit(0)');
assert.equal(commitPosts, 1);
run('onArchiveCancel()');
await hangingCommit;
assert.match(result.innerHTML, /Исход партии 1 неизвестен/);
assert.match(error.textContent, /не отменяет и не откатывает/);
assert.doesNotMatch(result.innerHTML, /не начиналась/);
assert.equal(idle.hidden, true, 'a cancelled commit does not return to the idle page');
assert.equal(commitPosts, 1, 'cancel does not send a second commit');
const afterCancel = run('JSON.stringify(archiveLive.issued[0])');
let cancelReplay = null;
ctx.fetch = async (_url, init) => {
  cancelReplay = init.body.get('confirmation');
  return new Response(JSON.stringify({mode: 'apply', writes: false, replayed: true, state: 'succeeded', receipt: {state: 'succeeded', counts: counts({already_applied: 1})}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveCommit(0)');
assert.equal(cancelReplay, afterCancel);
run('archiveLive.rollbackIssued[0] = {idempotencyKey:"lbrollback0123456789ab", chunk:0}; archiveLive.committed = {};');
let rollbackPosts = 0;
ctx.fetch = (_url, init) => new Promise((_resolve, reject) => {
  rollbackPosts++;
  if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
});
const hangingRollback = run('onArchiveRollback(0)');
for (const item of windowListeners) if (item.type === 'keydown') item.fn({key: 'Escape', preventDefault() {}});
await hangingRollback;
assert.match(result.innerHTML, /Исход отката партии 1 неизвестен/);
assert.doesNotMatch(result.innerHTML, /не начиналась/);
assert.equal(rollbackPosts, 1);
const rollbackFrozen = run('JSON.stringify(archiveLive.rollbackIssued[0])');
let rollbackReplay = null;
ctx.fetch = async (_url, init) => {
  rollbackReplay = JSON.parse(String(init.body)).confirmation;
  return new Response(JSON.stringify({mode: 'rollback', writes: false, replayed: true, state: 'succeeded'}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveRollback(0)');
assert.deepEqual(rollbackReplay, JSON.parse(rollbackFrozen));

// 10. Choosing another file or export time stale the open preview. An unknown command stays frozen to the old file.
ctx.fetch = fakeFetch;
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
time.value = '';
await submit();
const scopeA = run('archiveLive.bound.file.name');
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-21-08-15-utc.zip');
fire('#archive-file', 'change');
assert.match(result.innerHTML, /Эта проверка относится к другому файлу/);
assert.doesNotMatch(result.innerHTML, /data-archive-confirm|data-archive-commit/);
const beforeStaleWrite = requests.length;
await run('onArchiveConfirm(0)');
await run('onArchiveCommit(0)');
assert.equal(requests.length, beforeStaleWrite, 'the stale preview cannot confirm or apply the new file');
await submit();
assert.equal(run('archiveLive.stale'), false);
assert.equal(run('archiveLive.bound.file.name'), 'letterboxd-demo-user-2026-10-21-08-15-utc.zip');
assert.equal(run('archiveLive.issued[0]'), undefined, 'a fresh preview sets a new scope');
assert.notEqual(run('archiveLive.bound.file.name'), scopeA);
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
await submit();
await lostCommit(async () => {throw new Error('offline');});
const oldFile = run('archiveLive.bound.file');
choose(ARCHIVE, 'letterboxd-demo-user-2026-10-21-08-15-utc.zip');
fire('#archive-file', 'change');
assert.match(result.innerHTML, /другому файлу/);
assert.match(result.innerHTML, /Повторить ту же запись/);
assert.doesNotMatch(result.innerHTML, /не начиналась/);
const requestsBeforeHold = requests.length;
await submit();
assert.equal(requests.length, requestsBeforeHold, 'a new check does not discard the unknown command');
assert.equal(run('archiveLive.issued[0].idempotencyKey'), 'lb0123456789abcdef');
let heldName = null;
ctx.fetch = async (_url, init) => {
  heldName = init.body.get('archive').name;
  return new Response(JSON.stringify({mode: 'apply', writes: false, replayed: true, state: 'unknown', receipt: {state: 'unknown', counts: counts({unknown: 1})}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveCommit(0)');
assert.equal(heldName, oldFile.name);
time.value = '2026-10-20T09:00Z';
fire('#archive-generated-at', 'input');
assert.equal(run('archiveLive.stale'), true);
time.value = '';
fire('#archive-generated-at', 'input');
run('onArchiveResultClick({target: {getAttribute(name){return name === "data-archive-abandon" ? "0" : null;}, hasAttribute(name){return name === "data-archive-abandon";}, parentElement: null}})');
assert.equal(run('archiveHasUnresolved()'), false);
assert.match(error.textContent, /не откатывает/);
console.log('admin-letterboxd-page: ok');
