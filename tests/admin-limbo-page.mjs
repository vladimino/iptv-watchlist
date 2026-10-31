// The /admin/limbo page on the live route: the page bundle runs against a DOM stand-in and its fetch goes to the Worker bundle
// over an R2 stand-in. Covers the filter state in the URL, history, pagination under the pin, and the states the owner must
// tell apart: empty, error, stale snapshot, unavailable observations.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const html = fs.readFileSync('public/admin-limbo.html', 'utf8');
const page = fs.readFileSync('public/admin-limbo.js', 'utf8');
const client = fs.readFileSync('src/admin/client.js', 'utf8');
const limboClient = fs.readFileSync('src/admin/limbo-client.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const shell = fs.readFileSync('public/admin.html', 'utf8');
const bundle = bundleAdmin([client, limboClient, fs.readFileSync('src/admin/prediction-recovery-view.js', 'utf8'), fs.readFileSync('src/admin/discovery-recovery-view.js', 'utf8'), page]);

// Static boundary: reads go through the client; the one write method is the guarded discovery action's POST to its own
// route; no token, no other API, no generic action button.
assert.match(html, /ЧТЕНИЕ И ОДНО ДЕЙСТВИЕ С ПОДТВЕРЖДЕНИЕМ/);
for (const id of ['limbo-snapshot-text', 'limbo-causes', 'limbo-subsystems', 'limbo-form', 'limbo-kind', 'limbo-age', 'limbo-reset', 'limbo-loading', 'limbo-stale', 'limbo-refresh', 'limbo-error', 'limbo-empty', 'limbo-results', 'limbo-total', 'limbo-context-body']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="limbo-causes"') < html.indexOf('id="limbo-results"'), 'filters come before results in tab order');
assert.match(html, /<script src="\/admin-limbo\.js"><\/script>/);
assert.match(html, /href="\/admin"/);
assert.match(shell, /<nav class="admin-views"[^>]*>.*<a href="\/admin\/limbo" id="admin-view-limbo">Лимбо<\/a>.*<\/nav>/, 'the admin sections link to the inventory');
assert.match(html, /<a href="\/admin\/limbo" aria-current="page">Лимбо<\/a>/, 'the inventory is the current section on its own page');
assert.doesNotMatch(html, /fetch\(|\/api\/|programme\.json/);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the client');
assert.doesNotMatch(bundle, /\/api\/enrichment|\/api\/sync|\/mcp|localStorage|sessionStorage|Authorization|Bearer|method:\s*['"](?:PUT|PATCH|DELETE)/);
assert.deepEqual([...bundle.matchAll(/method:\s*['"]POST/g)].length, 1, 'one write method');
assert.match(bundle, /fetchImpl\(ADMIN_API\+'\/discovery-recovery\/'\+path,\{method:'POST'/, 'and it goes to the discovery action route only');
assert.doesNotMatch(page, /Повторить<|retry\(|data-limbo-action/, 'no action button: retries are another card');
assert.match(css, /\.limbo-facts/);
assert.match(css, /@media\(max-width:800px\)\{\.limbo-facts div\{grid-template-columns:minmax\(0,1fr\)/);

// Worker over an R2 stand-in.
const records = new Map(), etags = new Map();
let requests = [];
const bucket = {
  async get(key) {
    if (!records.has(key)) return null;
    const text = JSON.stringify(records.get(key));
    return {etag: etags.get(key) || 'e-' + key, uploaded: new Date('2026-10-30T07:00:00.000Z'), json: async () => JSON.parse(text), text: async () => text};
  },
  async put() {throw new Error('the limbo page never writes');},
  async list() {throw new Error('the limbo page never lists');},
};
const NOW = Date.parse('2026-10-30T12:00:00.000Z'), H = 3600000, D = 86400000;
const iso = ms => new Date(NOW + ms).toISOString();
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [NOW]));} static now() {return NOW;}};
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async () => {throw new Error('the Worker makes no outbound request for the limbo page');}});
vm.runInContext(scoped('src/domain/discovery-observation-index.js', 'DiscoveryIndex'), workerContext);
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-actions.js', 'AdminActions'), workerContext);
vm.runInContext(scoped('src/domain/discovery-recovery.js', 'DiscoveryRecovery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), workerContext);

const G1 = '11111111-1111-4111-8111-111111111111';
function seed() {
  records.clear(); etags.clear(); requests = [];
  vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
  const films = [
    {id: 'stuck', tmdbId: '1', title: 'Застрявший', original: 'Stuck', titleRu: 'Застрявший', titleStatus: 'verified', year: 2020, metadataAt: iso(-D), synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
    {id: 'later', tmdbId: '2', title: 'Позже', original: 'Later', titleRu: 'Позже', titleStatus: 'verified', year: 2021, metadataAt: iso(-D), synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
  ];
  for (let index = 0; index < 30; index++) films.push({id: 'm' + String(index).padStart(2, '0'), tmdbId: String(100 + index), title: 'Без метаданных ' + index, original: 'No Meta ' + index, titleRu: 'Без метаданных ' + index, titleStatus: 'verified', directors: [], actors: [], shows: []});
  records.set('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: iso(-5 * H)}); etags.set('epg/published-generation.json', 'ptr-1');
  records.set('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: iso(-5 * H), films, people: {directors: [], actors: []}, stats: {}}); etags.set('epg/generations/' + G1 + '/programme.json', 'prog-1');
  records.set('titles.json', {}); etags.set('titles.json', 'titles-1');
  records.set('people.json', {}); etags.set('people.json', 'people-1');
  records.set('enrichment/prediction-queue.json', {programmeRunId: G1, refreshedAt: iso(-H), lastCheckAt: iso(-H), hotPending: ['stuck', 'later'], coldPending: ['tmdb_77'], pending: ['stuck', 'later'], retries: {later: {attempts: 1, retryAt: NOW + 2 * H, kind: 'parse_error', scope: 'item', lastRunId: 'run-1'}}, work: {stuck: {requiredWork: 'prediction_only'}}}); etags.set('enrichment/prediction-queue.json', 'queue-1');
  records.set('enrichment/view-index.json', {stuck: {fingerprintHash: 'f', prediction: {generatedAt: iso(-20 * D)}}, later: {fingerprintHash: 'g', prediction: {generatedAt: iso(-D)}}, tmdb_77: {fingerprintHash: 'c', prediction: {generatedAt: iso(-25 * D)}}}); etags.set('enrichment/view-index.json', 'index-1');
}
seed();
const fakeFetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1');
  requests.push({method: init.method || 'GET', path: url.pathname + url.search, credentials: init.credentials});
  return workerContext.worker.fetch(new Request('http://127.0.0.1' + url.pathname + url.search, {method: init.method || 'GET', headers: init.headers}), {BUCKET: bucket}, {waitUntil() {throw new Error('background work');}});
};

// DOM stand-in.
const listeners = new Map();
const attrs = new Map();
function element(selector) {
  return {
    selector, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute(name, value) {attrs.set(selector + ':' + name, value);},
    getAttribute(name) {return attrs.get(selector + ':' + name) ?? null;},
    focus() {document.activeElement = this;},
    insertAdjacentHTML(position, markup) {this.innerHTML += markup;},
    remove() {this.removed = true; const results = nodes.get('#limbo-results'); results.innerHTML = results.innerHTML.replace('<button type="button" class="admin-more" data-limbo-more="items">Показать ещё</button>', '');},
    addEventListener(type, fn) {const list = listeners.get(selector) || []; list.push({type, fn}); listeners.set(selector, list);},
  };
}
const nodes = new Map(['#limbo-snapshot-text', '#limbo-causes', '#limbo-subsystems', '#limbo-form', '#limbo-kind', '#limbo-age', '#limbo-reset', '#limbo-loading', '#limbo-stale', '#limbo-refresh', '#limbo-error', '#limbo-empty', '#limbo-results', '#limbo-total', '#limbo-context-body'].map(selector => [selector, element(selector)]));
const moreButton = element('[data-limbo-more="items"]');
const document = {
  body: {name: 'body'}, activeElement: null,
  querySelector(selector) {
    if (selector === '[data-limbo-more="items"]') {moreButton.removed = false; return nodes.get('#limbo-results').innerHTML.includes('data-limbo-more="items"') ? moreButton : null;}
    return nodes.get(selector) || null;
  },
};
const stack = [];
let index = -1;
const windowListeners = [];
const window = {
  addEventListener(type, fn) {windowListeners.push({type, fn});},
  location: {href: 'http://127.0.0.1/admin/limbo?cause=stalled'},
  history: {
    pushState(state, _title, url) {stack.splice(index + 1); stack.push({href: new URL(url, window.location.href).href}); index++; window.location.href = stack[index].href;},
    replaceState(state, _title, url) {const href = new URL(url, window.location.href).href; if (index < 0) {stack.push({href}); index = 0;} else stack[index] = {href}; window.location.href = href;},
    back() {if (index <= 0) return; index--; window.location.href = stack[index].href; for (const item of windowListeners) if (item.type === 'popstate') item.fn();},
  },
};
const ctx = vm.createContext({URL, URLSearchParams, document, window, history: window.history, fetch: fakeFetch, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, console});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = async () => {await run('limboLive.pending'); await new Promise(resolve => setTimeout(resolve, 0));};
const url = () => new URL(window.location.href);
const results = nodes.get('#limbo-results'), empty = nodes.get('#limbo-empty'), error = nodes.get('#limbo-error'), stale = nodes.get('#limbo-stale'), loading = nodes.get('#limbo-loading');

// 1. Deep link with a cause: one GET with the filter, the stalled film with why and since when, the context panel.
await settle();
assert.deepEqual(requests.map(request => [request.method, request.path.split('?')[0], request.credentials]), [['GET', '/api/admin/limbo', 'same-origin']]);
assert.match(requests[0].path, /cause=stalled/);
assert.match(requests[0].path, /limit=25/);
assert.match(results.innerHTML, /Застрявший/);
assert.match(results.innerHTML, /Застряло/);
assert.match(results.innerHTML, /20 дн\./, 'the age is shown');
assert.match(results.innerHTML, /последний переход 10\.10\.2026/);
assert.match(results.innerHTML, /нет прогресса дольше порога/);
assert.match(results.innerHTML, /href="\/admin\?kind=film&amp;id=film%3Astuck"/, 'a link to the film detail');
assert.match(results.innerHTML, /доверенная идентичность tmdb:1/);
assert.doesNotMatch(results.innerHTML, /Позже/, 'a valid backoff is not stalled');
assert.equal(nodes.get('#limbo-total').textContent, '2');
assert.match(results.innerHTML, /фильм каталога \(вне программы\)/);
assert.match(results.innerHTML, /Фильма нет в опубликованной программе: карточки в каталоге данных для него нет\./, 'the missing link is explained');
assert.equal((results.innerHTML.match(/Открыть в каталоге данных/g) || []).length, 1, 'only the programme film links to the catalogue');
assert.match(nodes.get('#limbo-snapshot-text').textContent, /Поколение 11111111/);
assert.match(nodes.get('#limbo-snapshot-text').textContent, /очередь прогнозов от 30\.10\.2026/);
assert.match(nodes.get('#limbo-causes').innerHTML, /data-limbo-cause="stalled" aria-pressed="true"/);
assert.match(nodes.get('#limbo-causes').innerHTML, /Ждёт по backoff<\/span><small>1</);
assert.match(nodes.get('#limbo-context-body').innerHTML, /Нерешённые наблюдения EPG недоступны: индекса наблюдений для опубликованного поколения ещё нет/, 'observations are honestly unavailable');
assert.match(nodes.get('#limbo-context-body').innerHTML, /неизвестны, а не здоровы/);
assert.equal(loading.hidden, true); assert.equal(error.hidden, true); assert.equal(stale.hidden, true); assert.equal(empty.hidden, true);
const heldPin = run('limboLive.pin');
assert.match(heldPin, /^L2\|/);

// 2. Toggle to backoff through a chip: the URL changes, the request sends the held pin, the item says it is a normal wait.
requests = [];
await run(`onLimboChip({target:{closest(){return {getAttribute(name){return name==='data-limbo-cause'?'backoff':null;}};}}})`);
assert.equal(url().searchParams.get('cause'), 'backoff');
assert.match(requests[0].path, /pin=/);
assert.match(results.innerHTML, /Позже/);
assert.match(results.innerHTML, /повтор назначен и ещё не наступил/);
assert.match(results.innerHTML, /parse_error/);
assert.match(results.innerHTML, /недопустимо \(идёт backoff\)/);

// 3. Back restores the previous filter.
window.history.back();
await settle();
assert.equal(url().searchParams.get('cause'), 'stalled');
assert.match(results.innerHTML, /Застрявший/);

// 4. The form: kind and age; reset clears every filter.
nodes.get('#limbo-kind').value = 'film';
nodes.get('#limbo-age').value = '14';
await run('onLimboForm({preventDefault(){}})');
assert.equal(url().searchParams.get('kind'), 'film');
assert.equal(url().searchParams.get('age'), '14');
assert.match(results.innerHTML, /Застрявший/);
nodes.get('#limbo-age').value = '9999';
await run('onLimboForm({preventDefault(){}})');
assert.equal(url().searchParams.get('age'), null, 'an out-of-range age is not sent');
await run('onLimboReset()');
assert.equal(url().search, '');

// 5. Pagination under the pin: 30 films without metadata plus the two prediction items, 25 then the rest.
requests = [];
window.location.href = 'http://127.0.0.1/admin/limbo';
await run('limboRender()');
await settle();
assert.equal((results.innerHTML.match(/class="admin-hit limbo-item"/g) || []).length, 25);
assert.match(results.innerHTML, /data-limbo-more="items"/);
assert.equal(nodes.get('#limbo-total').textContent, '33');
requests = [];
await run('onLimboMore()');
await settle();
assert.equal(requests.length, 1);
assert.match(requests[0].path, /cursor=/);
assert.match(requests[0].path, /pin=/);
assert.equal((results.innerHTML.match(/class="admin-hit limbo-item"/g) || []).length, 33);
assert.doesNotMatch(results.innerHTML, /data-limbo-more="items"/, 'the last page removes the button');
assert.doesNotMatch(results.innerHTML, /href="\/admin\?kind=film&amp;id=film%3Atmdb/, 'no catalogue link for a film outside the programme');

// 6. Empty is not an error: no observation is listed, and the page says why that is not a verdict.
window.location.href = 'http://127.0.0.1/admin/limbo?kind=observation';
await run('limboRender()');
await settle();
assert.equal(empty.hidden, false);
assert.equal(error.hidden, true);
assert.equal(results.innerHTML, '');

// 7. Stale snapshot: the queue changes under the held pin; the page keeps its results and offers a refresh.
window.location.href = 'http://127.0.0.1/admin/limbo?cause=stalled';
await run('limboRender()');
await settle();
assert.match(results.innerHTML, /Застрявший/);
etags.set('enrichment/prediction-queue.json', 'queue-2');
window.location.href = 'http://127.0.0.1/admin/limbo?cause=backoff';
await run('limboRender()');
await settle();
assert.equal(stale.hidden, false);
assert.equal(error.hidden, true);
assert.match(results.innerHTML, /Застрявший/, 'previous results stay on screen');
await run('onLimboRefresh()');
await settle();
assert.equal(stale.hidden, true);
assert.match(results.innerHTML, /Позже/);
assert.notEqual(run('limboLive.pin'), heldPin);

// 8. Error: no published programme; no results, no fallback.
records.delete('epg/published-generation.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
await run('onLimboRefresh()');
await settle();
assert.equal(error.hidden, false);
assert.match(error.textContent, /Опубликованная программа сейчас недоступна/);
assert.equal(results.innerHTML, '');
assert.equal(loading.hidden, true);

// 9. Keyboard: Escape clears the filters.
seed();
window.location.href = 'http://127.0.0.1/admin/limbo?cause=stalled';
const key = windowListeners.find(item => item.type === 'keydown').fn;
let prevented = false;
key({key: 'Escape', preventDefault() {prevented = true;}});
await settle();
assert.equal(prevented, true);
assert.equal(url().search, '');

assert.ok(requests.every(request => request.method === 'GET' && request.path.startsWith('/api/admin/limbo')), JSON.stringify(requests));
console.log('Admin limbo page: URL filters, history, pagination under the pin, empty, error, stale snapshot and keyboard passed');
