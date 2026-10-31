// The /admin/posters page on the live routes: the page bundle runs against a DOM stand-in, and its requests go to the Worker
// bundle over an R2 stand-in with a TMDB stand-in. Opening the page and every re-check read only; one confirmed run sends
// exactly the confirmed POSTs to the existing maintenance route; a stale scope, a repeated click, a busy resolver and a TMDB
// rate limit are refused or stopped with an honest receipt.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const html = fs.readFileSync('public/admin-posters.html', 'utf8');
const page = fs.readFileSync('public/admin-posters.js', 'utf8');
const client = fs.readFileSync('src/admin/client.js', 'utf8');
const postersClient = fs.readFileSync('src/admin/posters-client.js', 'utf8');
const run = fs.readFileSync('src/admin/posters-run.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const shell = fs.readFileSync('public/admin.html', 'utf8');
const limbo = fs.readFileSync('public/admin-limbo.html', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const bundle = bundleAdmin([client, postersClient, run, page]);

// Static boundary: no token, no TMDB, no other write route, no flag, no lease handling; one POST target only.
const ids = ['posters-snapshot-text', 'posters-loading', 'posters-error', 'posters-backlog', 'posters-coverage', 'posters-dynamics', 'posters-forget', 'posters-form', 'posters-limit', 'posters-calls', 'posters-start', 'posters-preview', 'posters-accept-label', 'posters-accept', 'posters-accept-text', 'posters-run', 'posters-recheck', 'posters-stop', 'posters-refusal', 'posters-progress', 'posters-receipt', 'posters-unverified'];
for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
assert.match(html, /<script src="\/admin-posters\.js"><\/script>/);
assert.match(html, /<a href="\/admin\/posters" aria-current="page">Постеры<\/a>/);
assert.match(shell, /<a href="\/admin\/posters" id="admin-view-posters">Постеры<\/a><\/nav>/, 'the catalog shell links to the poster page');
assert.match(limbo, /<a href="\/admin\/posters">Постеры<\/a><\/nav>/, 'the limbo page links to the poster page');
assert.match(html, /<option value="10" selected>10 \(максимум\)<\/option><\/select>/);
assert.doesNotMatch(html, /value="(?:1[1-9]|[2-9]\d)"[^>]*>[^<]*<\/option><\/select><\/label>\s*<label class="limbo-field">Вызовов/, 'no batch above ten');
assert.doesNotMatch(html, /fetch\(|\/api\//);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the clients');
assert.doesNotMatch(bundle, /Authorization|Bearer|TMDB_API_READ_ACCESS_TOKEN|api\.themoviedb\.org|CATALOG_POSTER_HYDRATION|resolver-lease|\/api\/sync|\/api\/enrichment\/(?!catalog\/posters)|\/mcp|method:\s*['"](?:PUT|PATCH|DELETE)/);
assert.equal((bundle.match(/method:\s*['"]POST['"]/g) || []).length, 1, 'one POST call site');
assert.match(postersClient, /POSTER_HYDRATION_ROUTE='\/api\/enrichment\/catalog\/posters'/);
assert.match(build, /assets\['\/admin\/posters'\]/);
assert.match(build, /assets\['\/admin-posters\.js'\]=\{body:bundleAdmin\(\[fs\.readFileSync\('src\/admin\/client\.js','utf8'\),fs\.readFileSync\('src\/admin\/posters-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/posters-run\.js','utf8'\),fs\.readFileSync\('public\/admin-posters\.js','utf8'\)\]\)/);
assert.match(build, /fs\.readFileSync\('src\/admin\/posters\.js','utf8'\)/, 'the Worker bundle carries the coverage route');
assert.match(css, /@media\(max-width:800px\)\{\.posters-layout\{grid-template-columns:minmax\(0,1fr\)\}/);

// Worker over an R2 stand-in, with a TMDB stand-in.
const records = new Map(), etags = new Map();
let revision = 0, puts = [], tmdbCalls = [], requests = [], tmdb = {};
const bucket = {
  async get(key) {
    if (!records.has(key)) return null;
    const text = JSON.stringify(records.get(key));
    return {etag: etags.get(key), uploaded: new Date(), json: async () => JSON.parse(text), text: async () => text};
  },
  async put(key, value, options = {}) {
    const condition = options.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && records.has(key) || condition?.etagMatches && condition.etagMatches !== etags.get(key)) return null;
    records.set(key, JSON.parse(value)); etags.set(key, 'v' + (++revision)); puts.push(key); return {etag: etags.get(key)};
  },
  async list() {throw new Error('never lists');},
};
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async input => {
    const url = String(input instanceof Request ? input.url : input);
    const match = url.match(/^https:\/\/api\.themoviedb\.org\/3\/movie\/(\d+)\?language=ru-RU$/);
    if (!match) throw new Error('unexpected outbound request ' + url);
    tmdbCalls.push(match[1]);
    const reply = tmdb[match[1]];
    if (typeof reply === 'function') return reply();
    return reply ? new Response(JSON.stringify(reply), {status: 200}) : new Response('missing', {status: 404});
  }});
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/posters.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), workerContext);
const env = {BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'secret-token', TMDB_REQUEST_INTERVAL_MS: 0};

const G1 = '11111111-1111-4111-8111-111111111111';
const POINTER = 'epg/published-generation.json', LIVE = 'epg/discovered-films.json', COPY = 'epg/generations/' + G1 + '/discovered-films.json', LEASE = 'epg/resolver-lease.json';
const film = (id, tmdbId, extra = {}) => ({id, tmdbId: String(tmdbId), canonicalIdentity: 'tmdb:' + tmdbId, title: 'Фильм ' + id, original: 'Film ' + id, year: 2000 + tmdbId, poster: null, ...extra});
function seed() {
  records.clear(); etags.clear(); puts = []; tmdbCalls = []; requests = [];
  const catalog = {};
  for (let index = 1; index <= 14; index++) catalog['f' + String(index).padStart(2, '0')] = film('f' + String(index).padStart(2, '0'), index);
  catalog.kept = film('kept', 50, {poster: 'https://image.tmdb.org/t/p/w342/kept.jpg'});
  catalog.lost = film('lost', 51, {canonicalIdentity: null, title: 'Без идентичности'});
  for (const key of [LIVE, COPY]) {records.set(key, structuredClone(catalog)); etags.set(key, 'seed-' + key);}
  records.set(POINTER, {phase: 'published', programmeRunId: G1, publishedAt: new Date().toISOString()}); etags.set(POINTER, 'p1');
  tmdb = {};
  for (let index = 1; index <= 14; index++) tmdb[index] = {id: index, poster_path: index === 2 ? null : '/p' + index + '.jpg'};
}
seed();
const fakeFetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1');
  const method = init.method || 'GET';
  requests.push({method, path: url.pathname + url.search, credentials: init.credentials, body: init.body ? JSON.parse(init.body) : null, headers: init.headers});
  const headers = new Headers(init.headers || {});
  if (method !== 'GET') headers.set('Origin', 'http://127.0.0.1');
  return workerContext.worker.fetch(new Request('http://127.0.0.1' + url.pathname + url.search, {method, headers, body: init.body}), env, {waitUntil() {throw new Error('background work');}});
};

// DOM stand-in: fixed nodes, plus nodes the page renders inside innerHTML and later looks up by id.
const listeners = new Map();
function element(selector) {
  return {
    selector, hidden: false, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    focus() {document.activeElement = this;},
    addEventListener(type, fn) {const list = listeners.get(selector) || []; list.push({type, fn}); listeners.set(selector, list);},
  };
}
const nodes = new Map(ids.map(id => [`#${id}`, element(`#${id}`)]));
nodes.get('#posters-limit').value = '10';
nodes.get('#posters-calls').value = '1';
nodes.get('#posters-start').value = 'continue';
const rendered = new Map();
const document = {
  activeElement: null,
  querySelector(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    if (!id || ![...nodes.values()].some(node => node.innerHTML.includes(`id="${id}"`))) return null;
    if (!rendered.has(selector)) rendered.set(selector, element(selector));
    return rendered.get(selector);
  },
};
const store = new Map();
const localStorage = {getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key)};
const window = {localStorage, location: {href: 'http://127.0.0.1/admin/posters'}, addEventListener() {}};
const ctx = vm.createContext({URL, URLSearchParams, document, window, fetch: fakeFetch, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const exec = code => vm.runInContext(code, ctx);
const settle = async () => {await exec('postersLive.pending'); await new Promise(resolve => setTimeout(resolve, 0));};
const text = selector => nodes.get(selector).innerHTML + nodes.get(selector).textContent;
const fire = (selector, type) => Promise.all((listeners.get(selector) || []).filter(item => item.type === type).map(item => item.fn({preventDefault() {}})));
const posts = () => requests.filter(request => request.method === 'POST');
const accept = async () => {nodes.get('#posters-accept').checked = true; await fire('#posters-accept', 'change');};

// 1. Opening the page reads only: one GET, no POST, no TMDB, no write.
await settle();
assert.deepEqual(requests.map(request => [request.method, request.path, request.credentials]), [['GET', '/api/admin/posters?limit=10', 'same-origin']]);
assert.deepEqual([puts, tmdbCalls], [[], []]);
const coverage = text('#posters-coverage');
assert.match(coverage, /data-posters-field="missingPoster"><dt>Без постера<\/dt><dd><b>15<\/b>/);
assert.match(coverage, /data-posters-field="verifiedMissing"><dt>Можно восстановить \(проверенный TMDB id\)<\/dt><dd><b>14<\/b>/);
assert.match(coverage, /data-posters-field="unverifiedMissing"><dt>Нельзя восстановить \(нет проверенного TMDB id\)<\/dt><dd><b>1<\/b>/);
assert.match(coverage, /<details class="action-tech"><summary>Технические подробности<\/summary>/, 'raw keys and versions stay in a closed disclosure');
assert.match(text('#posters-unverified'), /Без идентичности \(2051\)<\/b> · TMDB id есть, но идентичность не подтверждена этим id/);
assert.equal(nodes.get('#posters-backlog').hidden, true, '14 restorable records are under the backlog threshold');
assert.match(nodes.get('#posters-snapshot-text').textContent, /Поколение 11111111/);
const preview = text('#posters-preview');
assert.match(preview, /Можно запустить после подтверждения/);
assert.match(preview, /Фильм f01 \(2001\)/);
assert.match(preview, /не больше <b>10<\/b> записей/);
assert.match(preview, /Проверка ничего не записала и не обращалась к TMDB/);
assert.equal(nodes.get('#posters-accept-label').hidden, false);
assert.match(nodes.get('#posters-accept-text').textContent, /до 1 вызовов по 10 записей, не больше 10 записей, с начала очереди, поколение 11111111/);
assert.equal(nodes.get('#posters-run').disabled, true, 'nothing runs before the exact scope is confirmed');
assert.match(text('#posters-dynamics'), /В этом браузере успешных дозагрузок ещё не было/);

// 2. A click without the confirmation sends nothing.
assert.equal(await exec('onPostersRun()'), null);
assert.deepEqual(posts(), []);

// 3. The queue changes after the confirmation: the fresh read refuses, nothing is sent, the confirmation is gone.
await accept();
assert.equal(nodes.get('#posters-run').disabled, false);
for (const key of [LIVE, COPY]) {const catalog = records.get(key); catalog.a00 = film('a00', 99); records.set(key, catalog); etags.set(key, 'changed-' + key);}
tmdb[99] = {id: 99, poster_path: '/p99.jpg'};
requests = [];
assert.equal(await exec('onPostersRun()'), null);
assert.deepEqual(requests.map(request => request.method), ['GET']);
assert.equal(nodes.get('#posters-refusal').hidden, false);
assert.match(nodes.get('#posters-refusal').textContent, /первый пакет уже не тот/);
assert.equal(nodes.get('#posters-accept').checked, false);
assert.equal(nodes.get('#posters-run').disabled, true);
assert.match(text('#posters-preview'), /Фильм a00/, 'the preview shows the new head of the queue');
assert.deepEqual([puts, tmdbCalls], [[], []]);

// 4. One confirmed run: exactly one POST with the confirmed body, at most ten TMDB requests, a receipt, a re-read.
await accept();
requests = [];
const receipt = await exec('onPostersRun()');
await settle();
assert.deepEqual(posts().map(request => [request.path, request.body, request.credentials, request.headers['Content-Type']]), [['/api/enrichment/catalog/posters', {dryRun: false, limit: 10}, 'same-origin', 'application/json']]);
assert.deepEqual(requests.map(request => request.method), ['GET', 'POST', 'GET'], 'fresh check, the call, the re-read');
assert.equal(tmdbCalls.length, 10);
assert.deepEqual([...new Set(puts)].sort(), [COPY, LEASE, LIVE].sort(), 'only both catalog copies and the lease are written');
assert.equal(records.get(LIVE).a00.poster, 'https://image.tmdb.org/t/p/w342/p99.jpg');
assert.equal(records.get(COPY).f01.poster, 'https://image.tmdb.org/t/p/w342/p1.jpg');
assert.equal(records.get(LIVE).f02.poster, null, 'no poster on TMDB stays absent');
assert.equal(records.get(LIVE).f10.poster, null, 'the eleventh record is not touched');
assert.equal(receipt.stop, 'call_budget');
assert.equal(receipt.summary.hydrated, 9);
assert.equal(receipt.summary.noPoster, 1);
const box = text('#posters-receipt');
assert.match(box, /Выполнено столько вызовов, сколько вы подтвердили/);
assert.match(box, /<dt>Записано постеров<\/dt><dd>9<\/dd>/);
assert.match(box, /<b>Фильм f02 \(2002\)<\/b><span>На TMDB постера нет — повтор не поможет<\/span>/);
assert.match(box, /<details class="action-tech"><summary>Технические подробности<\/summary>/);
assert.equal(nodes.get('#posters-receipt').hidden, false);
assert.match(document.querySelector('#posters-recheck-note').textContent, /без постера 16 → 7, можно восстановить 15 → 6/);
assert.match(text('#posters-coverage'), /<b>7<\/b> <small class="posters-change">было 16<\/small>/, 'coverage is re-read after the run');
const stored = JSON.parse(store.get('iptv.admin.posters.v1'));
assert.deepEqual([stored.lastSuccess.hydrated, stored.resume, stored.terminal], [9, {programmeRunId: G1, cursor: 'f09'}, {f02: 'no_poster_on_tmdb'}]);
assert.match(text('#posters-dynamics'), /записано постеров: 9/);
assert.match(nodes.get('#posters-accept-text').textContent, /после записи f09/, 'the next preview continues after the receipt position');
assert.match(text('#posters-preview'), /Фильм f10/);
assert.doesNotMatch(text('#posters-preview'), /Фильм f02/, 'the terminal record is behind the cursor');
assert.ok(!JSON.stringify([...store.values()]).includes('secret-token'), 'no credential reaches the browser');

// 5. A repeated click reuses nothing: no new POST without a new confirmation.
requests = [];
assert.equal(await exec('onPostersRun()'), null);
assert.deepEqual(posts(), []);

// 6. The resolver is busy: the call writes nothing and the receipt says so.
await accept();
records.set(LEASE, {id: 'discovery', expiresAt: Date.now() + 60000}); etags.set(LEASE, 'held');
puts = []; tmdbCalls = []; requests = [];
let result = await exec('onPostersRun()');
await settle();
assert.deepEqual([result.stop, posts().length, puts, tmdbCalls], ['resolver_busy', 1, [], []]);
assert.match(text('#posters-receipt'), /Резолвер сейчас пишет каталог/);
records.set(LEASE, {id: 'discovery', expiresAt: 0});

// 7. TMDB rate limit: the run stops, the time is kept, and the next preview cannot be confirmed until it passes.
tmdb[10] = () => new Response('slow down', {status: 429, headers: {'Retry-After': '120'}});
nodes.get('#posters-calls').value = '5';
await fire('#posters-calls', 'change');
await settle();
assert.match(nodes.get('#posters-accept-text').textContent, /до 5 вызовов по 10 записей, не больше 50 записей/);
await accept();
puts = []; tmdbCalls = []; requests = [];
result = await exec('onPostersRun()');
await settle();
assert.deepEqual([result.stop, posts().length, tmdbCalls], ['rate_limited', 1, ['10']]);
assert.match(text('#posters-receipt'), /TMDB ограничил частоту запросов/);
assert.match(text('#posters-receipt'), /Следующая попытка — не раньше/);
assert.match(text('#posters-preview'), /TMDB ограничил частоту запросов — запуск пока недоступен/);
assert.equal(nodes.get('#posters-accept-label').hidden, true);
assert.ok(JSON.parse(store.get('iptv.admin.posters.v1')).retryAt);

// 8. Forgetting the history drops the browser position and gate; the counts stay what R2 says.
await fire('#posters-forget', 'click');
assert.equal(store.has('iptv.admin.posters.v1'), false);
assert.match(text('#posters-dynamics'), /В этом браузере успешных дозагрузок ещё не было/);
await fire('#posters-recheck', 'click');
await settle();
assert.match(text('#posters-preview'), /Можно запустить после подтверждения/);
assert.match(nodes.get('#posters-accept-text').textContent, /с начала очереди/);

// 9. A failing read is an error with nothing to confirm.
const realGet = bucket.get;
bucket.get = async key => {if (key === LIVE) throw new Error('down'); return realGet(key);};
await fire('#posters-recheck', 'click');
await settle();
assert.equal(nodes.get('#posters-error').hidden, false);
assert.match(nodes.get('#posters-error').textContent, /Хранилище не ответило/);
assert.equal(nodes.get('#posters-accept-label').hidden, true);
assert.match(text('#posters-preview'), /Не удалось прочитать состояние/);
bucket.get = realGet;

console.log('Admin posters page: read-only open, exact-scope confirmation, stale scope refused before any POST, one bounded batch with receipt and re-read, no repeat without confirmation, resolver busy, TMDB rate limit gate, forget history and read failure passed');
