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
const uploadBlock = html.slice(html.indexOf('id="archive-upload"'), html.indexOf('id="archive-progress"'));
assert.doesNotMatch(uploadBlock, /id="archive-cancel"|id="archive-loading"/, 'the stop-wait control is outside the file form');
assert.ok(html.indexOf('id="archive-progress"') < html.indexOf('id="archive-cancel"') && html.indexOf('id="archive-cancel"') < html.indexOf('id="archive-result"'));
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
    selector, parent: null, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false, files: [],
    focus() {document.activeElement = this;},
    reset() {nodes.get('#archive-file').files = []; nodes.get('#archive-file').value = ''; nodes.get('#archive-generated-at').value = '';},
    addEventListener(type, fn) {const list = listeners.get(selector) || []; list.push({type, fn}); listeners.set(selector, list);},
  };
}
const nodes = new Map(['#archive-form', '#archive-file', '#archive-generated-at', '#archive-submit', '#archive-cancel', '#archive-reset', '#archive-loading', '#archive-error', '#archive-idle', '#archive-result', '#archive-upload', '#archive-progress'].map(selector => [selector, element(selector)]));
nodes.get('#archive-cancel').parent = nodes.get('#archive-progress');
nodes.get('#archive-loading').parent = nodes.get('#archive-progress');
const steps = [1, 2, 3, 4, 5].map(n => ({
  n, attrs: {},
  getAttribute(name) {return name === 'data-archive-step' ? String(this.n) : (Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null);},
  setAttribute(name, value) {this.attrs[name] = String(value);},
  removeAttribute(name) {delete this.attrs[name];},
}));
const document = {activeElement: null, querySelector: selector => nodes.get(selector) || null, querySelectorAll: selector => selector === '[data-archive-step]' ? steps : []};
function effectivelyShown(node) {
  for (let item = node; item; item = item.parent) if (item.hidden) return false;
  return true;
}
function currentStep() {
  const item = steps.find(step => step.attrs['aria-current'] === 'step');
  assert.ok(item, 'one step is current');
  assert.equal(steps.filter(step => step.attrs['aria-current'] === 'step').length, 1);
  return item.n;
}
function oneStep(html, n) {
  assert.equal((html.match(/class="admin-card archive-result archive-step"/g) || []).length, 1, 'one step is mounted');
  assert.match(html, new RegExp(`id="archive-step-${n}-title"`));
  for (const other of [2, 3, 4, 5]) if (other !== n) assert.doesNotMatch(html, new RegExp(`id="archive-step-${other}-title"`));
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(html, /<button[^>]*\shidden|hidden=""/, 'a mounted step does not keep another control hidden');
}
const windowListeners = [];
const window = {addEventListener(type, fn) {windowListeners.push({type, fn});}};
const ctx = vm.createContext({document, window, fetch: fakeFetch, FormData, File, Blob, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = () => run('archiveLive.pending');
const fileInput = nodes.get('#archive-file'), time = nodes.get('#archive-generated-at'), result = nodes.get('#archive-result'), error = nodes.get('#archive-error'), idle = nodes.get('#archive-idle'), loading = nodes.get('#archive-loading'), upload = nodes.get('#archive-upload');
const choose = (bytes, name) => {fileInput.files = [new File([bytes], name, {type: 'application/zip'})];};
const submit = () => run('onArchiveSubmit({preventDefault(){}})');

// 1. Opening the page sends nothing and reads nothing.
assert.deepEqual(requests, []);
assert.equal(gets, 0);
assert.equal(idle.hidden, false); assert.equal(loading.hidden, true); assert.equal(error.hidden, true); assert.equal(result.innerHTML, '');
assert.equal(upload.hidden, false);
assert.equal(effectivelyShown(nodes.get('#archive-cancel')), false);
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
assert.equal(currentStep(), 1, 'a preview stays on the file step until it succeeds');
assert.match(loading.textContent, /Сервер проверяет архив/);
assert.equal(nodes.get('#archive-submit').disabled, true);
assert.equal(effectivelyShown(nodes.get('#archive-cancel')), true, 'preview cancel is visible, including its ancestors');
assert.equal(nodes.get('#archive-cancel').textContent, 'Отменить');
assert.equal(nodes.get('#archive-progress').hidden, false);
assert.equal(upload.hidden, false);
await pending;
assert.deepEqual(requests.map(request => [request.url, request.method, request.credentials, request.cache, request.fields.join(',')]), [['/api/admin/letterboxd-archive/preview', 'POST', 'same-origin', 'no-store', 'archive']]);
assert.equal(requests[0].headers.Authorization, undefined);
assert.equal(error.hidden, true); assert.equal(loading.hidden, true); assert.equal(idle.hidden, true);
assert.equal(upload.hidden, true, 'the file form is not a second task beside the check');
assert.equal(document.activeElement, result);
assert.equal(currentStep(), 2);
const step2 = result.innerHTML;
oneStep(step2, 2);
assert.match(step2, /Архив успешно прочитан: 4\/4 CSV, ошибок нет, создан 11 дн\. назад/);
assert.doesNotMatch(step2, /создан менее часа назад|скачивать новый ZIP не нужно/);
assert.match(step2, /Нужен свежий архив/);
assert.match(step2, /оценка в R2 новее этого архива/);
assert.match(step2, /Шаг 2\. Проверка и свежесть/);
assert.match(step2, /Посмотреть разницу/);
assert.match(step2, /data-archive-nav="3"/);
assert.match(step2, /data-archive-nav="back"/);
assert.match(step2, /<details class="archive-details"><summary>Подробности проверки<\/summary>/);
assert.match(step2, /20\.10\.2026, 10:15 Madrid/, 'the export time in Madrid time');
assert.match(step2, /из имени файла/);
assert.match(step2, /<code class="archive-sha">[0-9a-f]{64}<\/code>/);
assert.doesNotMatch(step2.split('<details')[0], /archive-sha/);
assert.match(step2, /<details class="archive-technical"><summary>Технические подробности<\/summary>[\s\S]*class="archive-sha"/);
assert.match(step2, /базовая линия.*неизвестно/s);
assert.match(step2, /этот архив не импортировался/);
assert.doesNotMatch(step2, /Квитанции ещё нет|data-archive-confirm|data-archive-commit|Изменений значений/);
const postsAfterPreview = requests.length;
run('onArchiveNav("3")');
assert.equal(requests.length, postsAfterPreview, 'opening the difference does not POST');
assert.equal(currentStep(), 3);
const step3 = result.innerHTML;
oneStep(step3, 3);
assert.match(step3, /Изменений значений: 0\. Новых значений: 2\./);
assert.match(step3, /Эти числа — факты среди проверенных фильмов, не весь архив/);
assert.match(step3, /не проверено \(фильмов\)/);
assert.match(step3, /<div class="archive-total"><b>\d+<\/b><span>добавится<\/span>/);
assert.match(step3, /<span>изменится<\/span>/);
assert.match(step3, /<span>пропущено<\/span>/);
assert.match(step3, /ничего не записано/);
assert.match(step3, /Выбрать партию/);
assert.match(step3, /Показать подробности/);
assert.match(step3, /Alpha &lt;b&gt;/, 'archive values are escaped');
assert.doesNotMatch(step3, /Alpha <b>/);
assert.match(step3, /точный id Letterboxd: 2/);
assert.match(step3, /не найдено: 1/);
assert.match(step3, /<details class="archive-details"><summary>Новое значение <small>1<\/small>/);
assert.match(step3, /<details class="archive-details"><summary>В R2 новее <small>1<\/small>/);
assert.match(step3, /в R2: 5/);
assert.doesNotMatch(step3, /Квитанции ещё нет|data-archive-confirm|data-archive-commit/);
run('onArchiveNav("back")');
assert.equal(currentStep(), 2);
assert.equal(upload.hidden, true);
assert.equal(requests.length, postsAfterPreview, 'back does not POST or re-read the ZIP');
assert.match(result.innerHTML, /Посмотреть разницу/);
run('onArchiveNav("back")');
assert.equal(currentStep(), 1);
assert.equal(upload.hidden, false);
assert.match(result.innerHTML, /К проверке/);
assert.doesNotMatch(result.innerHTML, /id="archive-step-2-title"|data-archive-confirm/);
assert.equal(run('archiveLive.answer.mode'), 'preview');
run('onArchiveNav("2")');
assert.equal(currentStep(), 2);
assert.equal(upload.hidden, true);
assert.equal(requests.length, postsAfterPreview);
run('onArchiveNav("3")');
run('onArchiveNav("4")');
assert.equal(requests.length, postsAfterPreview, 'opening the batch does not POST');
assert.equal(currentStep(), 4);
const step4 = result.innerHTML;
oneStep(step4, 4);
assert.match(step4, /Новых или изменённых значений: 2\. Обновлений наблюдений без смены значения: 0\./);
assert.match(step4, /data-archive-confirm="0"/, 'the compared batch can be confirmed');
assert.doesNotMatch(step4, /data-archive-commit/, 'confirmation is not yet issued, so nothing can be recorded');
assert.match(step4, /Запись не начинается сама/);
assert.match(step4, /Подтвердить партию/);
assert.doesNotMatch(step4, /Квитанции ещё нет/);
run('onArchiveNav("5")');
assert.equal(currentStep(), 4, 'step 5 stays closed until a write is attempted');
assert.equal(requests.length, postsAfterPreview);
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

// 11. A lost confirm and a lost rollback confirmation can be retried with the same key or forgotten, even beside an apply receipt.
run(`(() => {
  const batches = archiveLive.answer.batches || (archiveLive.answer.batches = {});
  if (!batches.chunks || !batches.chunks.length) batches.chunks = [{chunk:0, films:1, planHash:'${'ab'.repeat(32)}', scopeFingerprint:'cdef1234', changes:{}, values:{}, confirmable:true}];
  batches.chunks[0].confirmable = true;
  batches.programmeRunId = batches.programmeRunId || '${'11111111-1111-4111-8111-111111111111'}';
  archiveLive.issued = {};
  archiveLive.keys = {};
  archiveLive.confirmUnknown = {};
  archiveLive.committed = {};
  archiveLive.rollbackResult = {};
  archiveLive.stale = false;
})()`);
ctx.fetch = async () => {throw new Error('offline');};
await run('onArchiveConfirm(0)');
assert.match(result.innerHTML, /Повторить то же подтверждение/);
assert.match(result.innerHTML, /data-archive-abandon="0"/);
assert.equal(run('archiveHasUnresolved()'), true);
assert.doesNotMatch(result.innerHTML, /не записана/);
const confirmKey = run('archiveLive.keys[0]');
let confirmPosts = 0, confirmKeySent = null;
ctx.fetch = async (_url, init) => {
  confirmPosts++;
  confirmKeySent = init.body.get('idempotencyKey');
  return new Response(JSON.stringify({mode: 'apply_confirm', writes: false, confirmation: {idempotencyKey: confirmKey, chunk: 0}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveConfirm(0)');
assert.equal(confirmPosts, 1);
assert.equal(confirmKeySent, confirmKey);
assert.equal(run('archiveLive.confirmUnknown[0]'), false);
run('archiveLive.issued = {}; archiveLive.confirmUnknown = {};');
ctx.fetch = async () => {throw new Error('offline');};
await run('onArchiveConfirm(0)');
run('onArchiveResultClick({target: {getAttribute(name){return name === "data-archive-abandon" ? "0" : null;}, hasAttribute(name){return name === "data-archive-abandon";}, parentElement: null}})');
assert.equal(run('archiveHasUnresolved()'), false);
assert.match(error.textContent, /не откатывает/);

run('archiveLive.committed[0] = {state:"succeeded", replayed:false, counts:{written:1}}; archiveLive.rollbackResult = {}; archiveLive.rollbackIssued = {}; archiveLive.rollbackKeys = {}; archiveLive.rollbackConfirmUnknown = {}; archiveShow("ready", archiveLive.answer);');
ctx.fetch = async () => {throw new Error('offline');};
await run('onArchiveRollbackConfirm(0)');
assert.match(result.innerHTML, /записана полностью/);
assert.match(result.innerHTML, /Повторить то же подтверждение отката/);
assert.match(result.innerHTML, /data-archive-abandon="0"/);
assert.doesNotMatch(result.innerHTML, /Подтвердить откат партии/);
assert.doesNotMatch(result.innerHTML, /не записана/);
const rollbackKey = run('archiveLive.rollbackKeys[0]');
let rollbackConfirmBody = null;
ctx.fetch = async (_url, init) => {
  rollbackConfirmBody = JSON.parse(String(init.body));
  return new Response(JSON.stringify({mode: 'rollback_confirm', writes: false, confirmation: {idempotencyKey: rollbackKey, chunk: 0}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveRollbackConfirm(0)');
assert.equal(rollbackConfirmBody.idempotencyKey, rollbackKey);
assert.match(result.innerHTML, /записана полностью/);
assert.match(result.innerHTML, /Откатить партию 1/);
assert.equal(run('archiveHasUnresolved()'), false);

// 12. HTTP 409 in_progress stays unknown and replays the same confirmation.
ctx.fetch = async () => new Response(JSON.stringify({error: 'in_progress', refusal: 'in_progress'}), {status: 409, headers: {'Content-Type': 'application/json'}});
run('archiveLive.issued[0] = {idempotencyKey:"lb0123456789abcdef", chunk:0}; archiveLive.committed = {}; archiveLive.stale = false;');
await run('onArchiveCommit(0)');
assert.match(result.innerHTML, /уже записывается/);
assert.match(result.innerHTML, /Повторить ту же запись/);
assert.doesNotMatch(result.innerHTML, /не записана/);
assert.equal(run('archiveLive.committed[0].state'), 'unknown');
const progressFrozen = run('JSON.stringify(archiveLive.issued[0])');
let progressPosted = null;
ctx.fetch = async (_url, init) => {
  progressPosted = init.body.get('confirmation');
  return new Response(JSON.stringify({mode: 'apply', writes: true, replayed: false, state: 'succeeded', receipt: {state: 'succeeded', counts: counts({written: 1})}}), {status: 200, headers: {'Content-Type': 'application/json'}});
};
await run('onArchiveCommit(0)');
assert.equal(progressPosted, progressFrozen);
assert.match(result.innerHTML, /записана полностью/);

// 13. A refused rollback does not rewrite the apply receipt as a write that never happened.
run('archiveLive.rollbackIssued[0] = {idempotencyKey:"lbrollback0123456789ab", chunk:0};');
ctx.fetch = async () => new Response(JSON.stringify({error: 'confirmation_expired', refusal: 'confirmation_expired'}), {status: 400, headers: {'Content-Type': 'application/json'}});
await run('onArchiveRollback(0)');
assert.match(result.innerHTML, /записана полностью/);
assert.match(result.innerHTML, /Откат партии 1 отклонён/);
assert.doesNotMatch(result.innerHTML, /не записана|Ничего не записано/);
assert.doesNotMatch(error.textContent, /не записана|Ничего не записано/);
assert.equal(run('archiveLive.committed[0].state'), 'succeeded');
assert.equal(run('archiveLive.rollbackResult[0].state'), 'refused');

// 14. Back and Continue do not POST, and they do not drop a frozen command.
const navPosts = requests.length;
const frozenKey = run('archiveLive.issued[0].idempotencyKey');
run('onArchiveNav("back")');
assert.equal(currentStep(), 4);
assert.equal(requests.length, navPosts);
assert.equal(run('archiveLive.issued[0].idempotencyKey'), frozenKey);
assert.equal(run('archiveLive.committed[0].state'), 'succeeded');
run('onArchiveNav("5")');
assert.equal(currentStep(), 5);
assert.equal(requests.length, navPosts);
assert.match(result.innerHTML, /записана полностью/);
assert.match(result.innerHTML, /Откат партии 1 отклонён/);
assert.doesNotMatch(result.innerHTML, /не записана|Ничего не записано/);
ctx.fetch = (_url, init) => new Promise((_resolve, reject) => {
  if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
});
run('archiveLive.committed = {}; archiveLive.viewStep = 4; archiveLive.reached = 4; archiveLive.navAway = false;');
const leftDuring = run('onArchiveCommit(0)');
run('onArchiveNav("back")');
assert.equal(currentStep(), 3);
assert.notEqual(run('archiveLive.controller'), null, 'back does not abort a write that has left the browser');
run('onArchiveNav("4")');
assert.equal(currentStep(), 4);
run('onArchiveCancel()');
await leftDuring;
assert.equal(currentStep(), 5);
assert.match(result.innerHTML, /Исход партии 1 неизвестен/);
assert.doesNotMatch(result.innerHTML, /не начиналась/);
assert.equal(run('archiveLive.issued[0].idempotencyKey'), frozenKey);

// 15. Stop-wait stays visible through its ancestors on every write, and it does not mint a new key.
function prepareWritable() {
  choose(ARCHIVE, 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
  run(`(() => {
    const file = document.querySelector('#archive-file').files[0];
    archiveLive.bound = {file, declared: '', mark: [file.name, file.size, file.lastModified, ''].join('\\0')};
    archiveLive.stale = false;
    archiveLive.answer.batches.chunks[0].confirmable = true;
    archiveLive.answer.batches.programmeRunId = archiveLive.answer.batches.programmeRunId || '${G1}';
  })()`);
}
const waitKinds = [
  ['confirm', `archiveLive.viewStep=4; archiveLive.reached=4; archiveLive.issued={}; archiveLive.keys={}; archiveLive.confirmUnknown={}; archiveLive.committed={}; archiveLive.rollbackResult={}; archiveLive.rollbackIssued={}; archiveLive.rollbackConfirmUnknown={};`, 'onArchiveConfirm(0)', 4, () => run('archiveLive.keys[0]')],
  ['commit', `archiveLive.viewStep=4; archiveLive.reached=4; archiveLive.issued[0]={idempotencyKey:'lb0123456789abcdef',chunk:0}; archiveLive.committed={}; archiveLive.confirmUnknown={};`, 'onArchiveCommit(0)', 4, () => run('archiveLive.issued[0].idempotencyKey')],
  ['rollback-confirm', `archiveLive.viewStep=5; archiveLive.reached=5; archiveLive.committed[0]={state:'succeeded',replayed:false,counts:{written:1}}; archiveLive.rollbackIssued={}; archiveLive.rollbackKeys={}; archiveLive.rollbackResult={}; archiveLive.rollbackConfirmUnknown={};`, 'onArchiveRollbackConfirm(0)', 5, () => run('archiveLive.rollbackKeys[0]')],
  ['rollback', `archiveLive.viewStep=5; archiveLive.reached=5; archiveLive.rollbackIssued[0]={idempotencyKey:'lbrollback0123456789ab',chunk:0}; archiveLive.rollbackResult={};`, 'onArchiveRollback(0)', 5, () => run('archiveLive.rollbackIssued[0].idempotencyKey')],
];
for (const [kind, setup, invoke, step, keyOf] of waitKinds) {
  let posts = 0;
  ctx.fetch = (_url, init) => new Promise((_resolve, reject) => {
    posts++;
    if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
  });
  prepareWritable();
  run(setup);
  const pending = run(invoke);
  const kept = keyOf();
  assert.equal(upload.hidden, true, kind + ' hides the file form');
  assert.equal(effectivelyShown(nodes.get('#archive-cancel')), true, kind + ' stop-wait is visible through its ancestors');
  assert.equal(nodes.get('#archive-cancel').textContent, 'Прервать ожидание', kind);
  assert.match(loading.textContent, /не отменяет запись и не откатывает/);
  assert.equal((loading.textContent.match(/не отменяет запись/g) || []).length + (result.innerHTML.match(/не отменяет запись|ответ ещё не прочитан/g) || []).length, 1, kind + ' progress is not duplicated');
  assert.equal((result.innerHTML.match(/class="admin-card archive-result archive-step"/g) || []).length, 1, kind);
  assert.equal(currentStep(), step, kind);
  run('onArchiveCancel()');
  await pending;
  assert.equal(posts, 1, kind + ' cancel does not send another request');
  assert.equal(keyOf(), kept, kind + ' keeps the same key');
  assert.equal(effectivelyShown(nodes.get('#archive-cancel')), false, kind);
  assert.doesNotMatch(result.innerHTML, /не начиналась/);
}

// 16. A rated film the matcher does not accept is named before any write. The identity button waits for a candidates receipt.
ctx.fetch = fakeFetch;
run('archiveLive.committed = {}; archiveLive.confirmUnknown = {}; archiveLive.rollbackConfirmUnknown = {}; archiveLive.rollbackResult = {}; archiveLive.issued = {}; archiveLive.rollbackIssued = {};');
requests = [];
choose(exportArchive([{code: 'qq1', name: 'Quiet Quiz', year: 1991, watched: true, rating: 4}]), 'letterboxd-demo-user-2026-10-20-08-15-utc.zip');
time.value = '';
await submit();
assert.equal(requests.at(-1).url, '/api/admin/letterboxd-archive/preview');
assert.equal(requests.at(-1).headers['X-IPTV-Admin-Action'], undefined);
run('onArchiveNav("3")');
assert.match(result.innerHTML, /Уже сопоставлены/);
assert.match(result.innerHTML, /Новые кандидаты на проверку/);
assert.match(result.innerHTML, /Ошибки и неоднозначности/);
assert.match(result.innerHTML, /Предпросмотр ничего не скачивает и не называет непроверенный фильм подтверждённым/);
assert.match(result.innerHTML, /Quiet Quiz/);
assert.doesNotMatch(result.innerHTML, /data-archive-identity/);
run('onArchiveNav("4")');
assert.match(result.innerHTML, /Запись сохраняет код и архив/);
assert.match(result.innerHTML, /не подтверждает TMDB/);
assert.match(result.innerHTML, /не ставит фильм в watchlist/);
assert.match(result.innerHTML, /не скачивает страницу/);
assert.doesNotMatch(result.innerHTML, /data-archive-identity/);
run(`archiveLive.committed[0] = {kind:'candidates', state:'succeeded'}; archiveLive.reached = 5;`);
run('onArchiveNav("5")');
assert.equal(currentStep(), 5);
assert.match(result.innerHTML, /Проверить следующий в общей очереди/);
assert.match(result.innerHTML, /Страница Letterboxd и TMDB ещё не читались/);
assert.equal((result.innerHTML.match(/data-archive-identity/g) || []).length, 1);

// 17. The general step takes the shared queue; after each step the page reads the stored queue instead of guessing.
const identityAnswers = [
  {mode: 'identity', writes: true, verified: true, enriched: false, fetched: true, pending: true, stop: null, code: 'Aa1', state: 'verified', phase: 'identity', filmId: 'tmdb_1'},
  {mode: 'identity', writes: false, verified: false, enriched: false, fetched: false, pending: true, stop: {reason: 'forbidden', code: 'Bb1'}, code: 'Bb1', state: 'pending', phase: 'identity'},
  {mode: 'identity', writes: false, verified: false, enriched: false, fetched: false, pending: true, stop: {reason: 'forbidden', code: 'Bb1'}, code: 'Bb1', state: 'pending', phase: 'identity'},
];
let identityPosts = 0, storedStop = null;
const previousFetch = ctx.fetch;
ctx.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/identity-step')) {
    const body = JSON.parse(String(init.body));
    const answer = identityAnswers[identityPosts++];
    assert.equal(body.resume, identityPosts >= 3, 'resume follows a stored stop');
    assert.equal(body.code, undefined, 'the general step names no code');
    storedStop = answer.stop;
    return new Response(JSON.stringify(answer), {status: 200, headers: {'Content-Type': 'application/json'}});
  }
  if (url.endsWith('/identity-status')) {
    return new Response(JSON.stringify({mode: 'identity_status', writes: false, present: true, pending: 1, admitting: 0, verified: 1, needsReview: 0, enrichmentPending: 1, stopped: storedStop, next: null, phase: 'identity', retryable: [], requeued: []}), {status: 200, headers: {'Content-Type': 'application/json'}});
  }
  throw new Error('unexpected page request ' + url);
};
await run('onArchiveIdentity()');
assert.match(result.innerHTML, /Aa1: Film admitted \(tmdb_1\)/);
assert.match(result.innerHTML, /Проверить следующий в общей очереди/);
assert.match(result.innerHTML, /берёт следующий код общей очереди, а не выбранный фильм/);
await run('onArchiveIdentity()');
assert.match(result.innerHTML, /Проверка остановлена \(forbidden\)/);
assert.match(result.innerHTML, /Продолжить проверку/);
await run('onArchiveIdentity()');
assert.equal(identityPosts, 3);
run('archiveLive.committed = {}; archiveLive.identity = null; archiveLive.identityStatus = null; archiveLive.viewStep = 4; archiveLive.reached = 4;');
run('archiveRepaint()');
assert.match(result.innerHTML, /Прочитать сохранённое состояние/);
await run('onArchiveStatus()');
assert.equal(currentStep(), 5);
assert.match(result.innerHTML, /Продолжить проверку/);
assert.match(result.innerHTML, /ожидают 1/);

// 18. AIR-350: retry is chosen per code, confirm does not send the document ETag, outcomes are per code, and a
// targeted identity step names the code and touches no other.
const json200 = value => new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});
const json409 = value => new Response(JSON.stringify(value), {status: 409, headers: {'Content-Type': 'application/json'}});
const retryRow = (code, name, year) => ({code, name, year, state: 'needs_review', reason: 'shortlink_missing', reasonKind: 'page_incomplete', fingerprint: 'needs_review|shortlink_missing|2026-10-20T08:15:00.000Z|2026-11-01T00:00:00.000Z', observedAt: '2026-10-20T08:15:00.000Z', registeredAt: '2026-11-01T00:00:00.000Z'});
const reviewStatus = {mode: 'identity_status', writes: false, present: true, pending: 48, admitting: 0, verified: 0, needsReview: 2, enrichmentPending: 0, stopped: null, next: 'Stay', phase: 'identity', documentEtag: 'etag-1', retryable: [retryRow('103U', 'Men in Black 3', 2012), retryRow('10TQ', 'The Green Hornet', 2011)], requeued: []};
run(`archiveLive.identity = {mode:'identity',writes:true,verified:false,enriched:false,fetched:true,pending:true,stop:null,code:'103U',state:'needs_review',reason:'shortlink_missing',reasons:['shortlink_missing'],reasonKind:'page_incomplete',persisted:'review'};`);
run(`archiveLive.identityStatus = ${JSON.stringify(reviewStatus)};`);
run(`archiveLive.identityRetry = null; archiveLive.retryKey = null; archiveLive.retryPick = null; archiveLive.identityByCode = {}; archiveLive.viewStep = 5; archiveLive.reached = 5;`);
run('archiveRepaint()');
assert.match(result.innerHTML, /103U: состояние кандидата записано в R2/);
assert.match(result.innerHTML, /Повтор разметки доступен для 2 кодов/);
assert.match(result.innerHTML, /Подтвердить повтор разметки \(2\)/);
assert.match(result.innerHTML, /data-archive-retry-pick="103U" checked/);
assert.match(result.innerHTML, /Men in Black 3 \(2012\)/);
assert.doesNotMatch(result.innerHTML, /Вернуть в очередь/);
// The owner unticks 10TQ: only 103U is confirmed.
run('onArchiveRetryPick("10TQ", false)');
assert.match(result.innerHTML, /Подтвердить повтор разметки \(1\)/);
let retryPosts = [], confirmBodies = [], retryMode = 'lost-confirm';
let statusAnswer = reviewStatus;
ctx.fetch = async (input, init = {}) => {
  const url = String(input);
  retryPosts.push(url);
  if (url.endsWith('/identity-retry-confirm')) {
    const body = JSON.parse(String(init.body));
    confirmBodies.push(body);
    assert.equal(body.documentEtag, undefined, 'the document-wide ETag is not sent');
    assert.equal(body.accepted, true);
    for (const code of body.codes) assert.ok(body.expected[code] && body.expected[code].fingerprint.includes('|'), 'each code carries its full expected row');
    if (retryMode === 'lost-confirm') {retryMode = 'confirm'; throw new TypeError('network down');}
    if (retryMode === 'changed-confirm') {retryMode = 'confirm'; return json409({error: 'record_changed', refusal: 'record_changed', writes: false, changed: ['103U']});}
    return json200({mode: 'identity_retry_confirm', writes: false, confirmation: {capability: 'letterboxd_identity_retry', idempotencyKey: body.idempotencyKey}, retryable: body.codes.length, preview: {codes: body.codes, requeue: body.codes}});
  }
  if (url.endsWith('/identity-retry')) {
    if (retryMode === 'lost-retry') {retryMode = 'replay'; return new Response('{"error":"storage_error"}', {status: 500, headers: {'Content-Type': 'application/json'}});}
    if (retryMode === 'replay') return json200({mode: 'identity_retry', writes: false, replayed: true, state: 'succeeded', receipt: {outcomes: [{id: '103U', outcome: 'written'}]}, outcomes: [{id: '103U', outcome: 'written'}]});
    return json200({mode: 'identity_retry', writes: true, replayed: false, state: 'succeeded', outcomes: [{id: '103U', outcome: 'written'}]});
  }
  if (url.endsWith('/identity-status')) return json200(statusAnswer);
  if (url.endsWith('/identity-step')) throw new Error('no identity step in this part');
  throw new Error('unexpected retry request ' + url);
};
// A lost confirm answer keeps the key and the exact request; the next click reads it back.
await run('onArchiveRetryConfirm()');
assert.match(error.textContent, /Следующее нажатие отправит тот же ключ/);
assert.match(result.innerHTML, /Прочитать подтверждение \(тот же ключ\)/);
assert.doesNotMatch(error.textContent, /Факты в R2|Проверь архив/, 'no ZIP facts text for an identity retry');
await run('onArchiveRetryConfirm()');
assert.equal(confirmBodies.length, 2);
assert.equal(confirmBodies[1].idempotencyKey, confirmBodies[0].idempotencyKey, 'a lost confirm is read back with the same key');
assert.deepEqual(confirmBodies[1].codes, ['103U']);
assert.match(result.innerHTML, /Подтверждение выдано для: 103U\. В очередь ещё ничего не возвращено/);
assert.match(result.innerHTML, /Вернуть в очередь/);
// A lost execute answer is unknown: same confirmation, no new key, no «ничего не записано».
retryMode = 'lost-retry';
await run('onArchiveRetry()');
assert.match(error.textContent, /Исход неизвестен/);
assert.doesNotMatch(error.textContent, /Ничего не записано|Ничего не вернул/);
assert.match(result.innerHTML, /Узнать исход \(тот же ключ\)/);
assert.doesNotMatch(result.innerHTML, /Подтвердить повтор разметки/, 'no new confirmation while the outcome is unknown');
statusAnswer = {...reviewStatus, needsReview: 1, pending: 49, retryable: [retryRow('10TQ', 'The Green Hornet', 2011)], requeued: [{code: '103U', name: 'Men in Black 3', year: 2012, state: 'pending', reason: null, retryOf: 'shortlink_missing', retriedAt: '2026-11-05T09:00:00.000Z', tmdb: null, filmId: null, enrichment: null}]};
await run('onArchiveRetry()');
assert.match(result.innerHTML, /Повтор уже был выполнен раньше; показана сохранённая квитанция/);
assert.match(result.innerHTML, /<code>103U<\/code> — возвращён в очередь/);
assert.match(result.innerHTML, /Возвращённые в очередь коды/);
assert.match(result.innerHTML, /103U · Men in Black 3 \(2012\)<\/strong> — в очереди, идентичность ещё не проверена/);
assert.match(result.innerHTML, /data-archive-identity-code="103U"/);
assert.ok(retryPosts.filter(url => url.endsWith('/identity-status')).length >= 1, 'the queue is read back from the server');

// A changed row on confirm is per code, re-reads the state and asks for a new conscious confirmation.
retryMode = 'changed-confirm';
await run('onArchiveRetryConfirm()');
assert.match(error.textContent, /Состояние выбранных кодов изменилось/);
assert.doesNotMatch(error.textContent, /Факты в R2|Проверь архив ещё раз/);
assert.match(result.innerHTML, /Изменились: 103U/);
assert.match(result.innerHTML, /Подтвердить повтор разметки \(1\)/, 'a new confirmation is offered, not run');
const lastKey = confirmBodies[confirmBodies.length - 1].idempotencyKey;
retryMode = 'confirm';
await run('onArchiveRetryConfirm()');
assert.notEqual(confirmBodies[confirmBodies.length - 1].idempotencyKey, lastKey, 'a definite refusal frees the key for a new confirmation');

// AIR-350 review: any 5xx after dispatch is an unknown outcome, whatever its body says. The confirmation and the key are kept,
// no new confirmation is offered, and the same-key read-back recovers the stored receipt.
for (const [label, make] of [
  ['storage_error', () => new Response('{"error":"storage_error"}', {status: 500, headers: {'Content-Type': 'application/json'}})],
  ['5xx with another error word', () => new Response('{"error":"invalid_request"}', {status: 500, headers: {'Content-Type': 'application/json'}})],
  ['5xx with an unreadable body', () => new Response('<html>boom</html>', {status: 502, headers: {'Content-Type': 'text/html'}})],
]) {
  const keyBefore = run('archiveLive.retryKey');
  assert.ok(keyBefore, label + ': a confirmed retry holds its key');
  let sawKey = [];
  ctx.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/identity-retry')) {
      sawKey.push(JSON.parse(String(init.body)).confirmation.idempotencyKey);
      return sawKey.length === 1 ? make() : json200({mode: 'identity_retry', writes: false, replayed: true, state: 'succeeded', receipt: {outcomes: [{id: '103U', outcome: 'written'}]}, outcomes: [{id: '103U', outcome: 'written'}]});
    }
    if (url.endsWith('/identity-status')) return json200(statusAnswer);
    throw new Error('unexpected request ' + url);
  };
  await run('onArchiveRetry()');
  assert.equal(run('archiveLive.retryKey'), keyBefore, label + ': the key is kept');
  assert.equal(run('archiveLive.identityRetry.phase'), 'unknown', label);
  assert.match(error.textContent, /Исход неизвестен/, label);
  assert.match(result.innerHTML, /Узнать исход \(тот же ключ\)/, label);
  assert.doesNotMatch(result.innerHTML, /Подтвердить повтор разметки/, label + ': no new action while unknown');
  await run('onArchiveRetry()');
  assert.deepEqual(sawKey, [keyBefore, keyBefore], label + ': the read-back uses the same confirmation key');
  assert.equal(run('archiveLive.identityRetry.phase'), 'done', label);
  // Back to a confirmed retry for the next case.
  ctx.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/identity-retry-confirm')) {
      const body = JSON.parse(String(init.body));
      return json200({mode: 'identity_retry_confirm', writes: false, confirmation: {capability: 'letterboxd_identity_retry', idempotencyKey: body.idempotencyKey}, retryable: body.codes.length, preview: {codes: body.codes, requeue: body.codes}});
    }
    if (url.endsWith('/identity-status')) return json200({...reviewStatus, retryable: [retryRow('103U', 'Men in Black 3', 2012)], requeued: []});
    throw new Error('unexpected request ' + url);
  };
  await run('onArchiveStatus()');
  await run('onArchiveRetryConfirm()');
  assert.equal(run('archiveLive.identityRetry.phase'), 'confirmed', label + ': re-confirmed for the next case');
}
// A confirm whose answer is a 5xx may have been stored: the key and exact request are kept for a same-key read-back.
{
  const posts = [];
  ctx.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/identity-retry-confirm')) {
      posts.push(JSON.parse(String(init.body)));
      return posts.length === 1 ? new Response('{"error":"storage_error"}', {status: 500, headers: {'Content-Type': 'application/json'}}) : json200({mode: 'identity_retry_confirm', writes: false, replayed: true, confirmation: {capability: 'letterboxd_identity_retry', idempotencyKey: posts[0].idempotencyKey}, retryable: 1, preview: {codes: posts[0].codes, requeue: posts[0].codes}});
    }
    if (url.endsWith('/identity-status')) return json200({...reviewStatus, retryable: [retryRow('103U', 'Men in Black 3', 2012)], requeued: []});
    throw new Error('unexpected request ' + url);
  };
  run('archiveLive.identityRetry = null; archiveLive.retryKey = null; archiveLive.retryPick = null');
  await run('onArchiveStatus()');
  await run('onArchiveRetryConfirm()');
  assert.equal(run('archiveLive.identityRetry.phase'), 'confirm_unknown', 'a 5xx confirm is unknown, not refused');
  assert.ok(run('archiveLive.retryKey'), 'the confirm key is kept');
  await run('onArchiveRetryConfirm()');
  assert.equal(posts[1].idempotencyKey, posts[0].idempotencyKey, 'the read-back uses the same key');
  assert.equal(run('archiveLive.identityRetry.phase'), 'confirmed');
}
// Restore the queue state the targeted-step part below reads.
ctx.fetch = async input => {
  if (String(input).endsWith('/identity-status')) return json200(statusAnswer);
  throw new Error('unexpected request ' + input);
};
await run('onArchiveStatus()');

// Targeted identity step: the request names 103U; the answer and the re-read state are shown for 103U.
let stepBodies = [];
ctx.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/identity-step')) {
    const body = JSON.parse(String(init.body));
    stepBodies.push(body);
    if (body.code === '10TQ') return json409({error: 'not_eligible', refusal: 'not_eligible'});
    return json200({mode: 'identity', writes: true, verified: true, enriched: false, fetched: true, pending: true, stop: null, code: '103U', state: 'verified', phase: 'identity', persisted: 'admission', filmId: 'tmdb_41117', tmdb: '41117'});
  }
  if (url.endsWith('/identity-status')) return json200({...statusAnswer, requeued: [{...statusAnswer.requeued[0], state: 'verified', tmdb: '41117', filmId: 'tmdb_41117', enrichment: null}]});
  throw new Error('unexpected step request ' + url);
};
await run('onArchiveIdentityCode("103U")');
assert.equal(stepBodies.length, 1);
assert.equal(stepBodies[0].code, '103U', 'the step names the chosen code');
assert.match(result.innerHTML, /103U: Film admitted \(tmdb_41117\)/);
assert.match(result.innerHTML, /Film admitted \(tmdb_41117\), enrichment pending/);
assert.match(result.innerHTML, /Дозаполнить метаданные 103U/);
await run('onArchiveIdentityCode("10TQ")');
assert.equal(stepBodies.length, 1, 'a code that is not in the requeued list is not posted');
ctx.fetch = previousFetch;
console.log('admin-letterboxd-page: ok');
