// The /admin page on the live read API: the page bundle runs against a DOM stand-in, its fetch goes to the Worker bundle
// over an R2 stand-in with a published generation. Covers the search and queue state in the URL, history, the detail
// view, pagination, and the three distinct states the owner must tell apart: empty, error, stale snapshot.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const html = fs.readFileSync('public/admin.html', 'utf8');
const page = fs.readFileSync('public/admin.js', 'utf8');
const client = fs.readFileSync('src/admin/client.js', 'utf8');
const titleClient = fs.readFileSync('src/admin/film-title-client.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const movie = fs.readFileSync('public/app.js', 'utf8');
const movieHtml = fs.readFileSync('public/index.html', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const healthView = fs.readFileSync('src/admin/health-view.js', 'utf8');
const nameClient = fs.readFileSync('src/admin/person-name-client.js', 'utf8');
const bundle = bundleAdmin([client, titleClient, nameClient, healthView, page]);

// Static boundary: the page is owner-only through the existing Access session. The catalogue reads are GET. The one
// write in this bundle is the confirmed film title. No token, no other API.
assert.doesNotMatch(html, /демонстрационные|Это демонстрационные данные/i);
assert.match(html, /ТОЛЬКО ЧТЕНИЕ/);
for (const id of ['admin-search', 'admin-queues', 'admin-queues-note', 'admin-results', 'admin-detail', 'admin-empty', 'admin-error', 'admin-loading', 'admin-stale', 'admin-refresh', 'admin-snapshot', 'admin-snapshot-text']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="admin-search"') < html.indexOf('id="admin-queues"') && html.indexOf('id="admin-queues"') < html.indexOf('id="admin-results"'));
assert.match(html, /<script src="\/admin\.js"><\/script>/);
assert.doesNotMatch(html, /type="module"|fetch\(|\/api\/|programme\.json/);
assert.match(client, /const ADMIN_API='\/api\/admin'/);
assert.match(build, /src\/admin\/film-title-client\.js/);
assert.match(build, /src\/admin\/person-name-client\.js/);
assert.doesNotMatch(client, /method:\s*['"]POST/, 'the shared read client stays GET');
assert.equal((bundle.match(/method:\s*'POST'/g) || []).length, 2, 'the catalogue bundle posts the film title and the person name');
assert.match(bundle, /X-IPTV-Admin-Action':'film_title_review'/);
assert.match(bundle, /\/name-review/);
assert.match(bundle, /X-IPTV-Admin-Action':'person_name_review'/);
const bundleWithoutWrites = bundle.replaceAll("method:'POST'", 'method:read');
assert.doesNotMatch(bundleWithoutWrites, /admin-query|\/api\/enrichment|\/api\/sync|\/mcp|localStorage|sessionStorage|Authorization|Bearer|programme\.json|method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
assert.doesNotMatch(page, /\bfetch\(/, 'the page script reaches the API only through the client');
assert.doesNotMatch(healthView, /\bfetch\(|\/api\//, 'the health view renders answers and makes no request of its own');
for (const id of ['admin-health', 'admin-catalog', 'admin-view-catalog', 'admin-view-health', 'admin-health-refresh', 'admin-health-stale-refresh', 'admin-health-summary', 'admin-health-sources', 'admin-health-subsystems', 'admin-health-issues', 'admin-health-empty', 'admin-health-loading', 'admin-health-error', 'admin-health-stale']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.doesNotMatch(html, /<button[^>]*(?:retry|hydrat|import|запустить|повторить)/i, 'no execution buttons on the health view');
assert.match(css, /\.health-group-critical/);
assert.match(bundle, /credentials:'same-origin'/);
assert.doesNotMatch(movie, /admin-query|\/admin/);
assert.doesNotMatch(movieHtml, /id="admin-search"|admin-query/);
assert.match(worker, /url\.pathname==='\/events'\?'\/':\/\^\\\/film\\\/\[A-Za-z0-9_-\]\{1,80\}\$\/\.test\(url\.pathname\)\?'\/':url\.pathname/);
assert.match(worker, /\/api\/admin\//);
assert.doesNotMatch(worker, /pathname==='\/admin'\?'\/'/);
assert.match(build, /bundleAdmin\(\[fs\.readFileSync\('src\/admin\/client\.js','utf8'\),fs\.readFileSync\('src\/admin\/film-title-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/person-name-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/health-view\.js','utf8'\),fs\.readFileSync\('public\/admin\.js','utf8'\)\]\)/);
assert.match(build, /src\/domain\/admin-query\.js/);
assert.match(css, /overflow-wrap:anywhere/);
assert.match(css, /minmax\(0,1fr\)/);
assert.match(css, /\.admin-state-stale/);
assert.match(css, /\.admin-more/);

// The Worker over an R2 stand-in with one published generation.
const records = new Map(), etags = new Map();
let requests = [];
const bucket = {
  async get(key) {
    if (!records.has(key)) return null;
    const text = JSON.stringify(records.get(key));
    return {etag: etags.get(key) || 'e-' + key, uploaded: new Date('2026-10-29T10:00:00.000Z'), json: async () => JSON.parse(text), text: async () => text};
  },
  async put() {throw new Error('the admin page never writes');},
  async list() {throw new Error('the admin page never lists');},
};
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone, Number, Math,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {},
  FILM_TITLE_DICTIONARY: [{id: 'north', tmdbId: '900001', original: 'North Bridge', title: 'Северный мост', sources: ['https://www.wikidata.org/wiki/Q1'], aliases: ['Мост на севере'], status: 'verified'}],
  PERSON_NAME_DICTIONARY: [{id: 'director/lea-nord', original: 'Lea Nord', name: 'Лея Норд', aliases: ['Л. Норд'], status: 'verified', verification_basis: 'user_supplied', source_url: null}],
  fetch: async () => {throw new Error('the Worker makes no outbound request for the admin page');}});
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/domain/person-name-review.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/health.js', 'utf8'), workerContext);
vm.runInContext(worker.replace('export default', 'globalThis.worker='), workerContext);

const G1 = '11111111-1111-4111-8111-111111111111', AT = '2026-10-29T10:00:00.000Z';
const mira = {id: 'actor/mira-sol', name: 'Мира Соль', original: 'Mira Sol'};
const lea = {id: 'director/lea-nord', name: 'Лея Норд', original: 'Lea Nord'};
const extra = {id: 'actor/unnamed-extra', name: 'Unnamed Extra', original: 'Unnamed Extra'};
function seed() {
  records.clear(); etags.clear(); requests = [];
  const films = [
    {id: 'north', tmdbId: '900001', title: 'Северный мост', original: 'North Bridge', metadataAt: AT, synopsis: 's', peopleVersion: 1, year: 2021, directors: [lea], actors: [mira], shows: []},
    {id: 'quiet', tmdbId: '900002', title: 'Тихая гавань', original: 'Quiet Harbor', titleRu: 'Тихая гавань', titleStatus: 'provisional', metadataAt: AT, synopsis: 's', peopleVersion: 1, year: 2019, directors: [], actors: [extra], shows: []},
    {id: 'blank', title: 'Blank Reel', original: 'Blank Reel', year: 2024, directors: [], actors: [], shows: []},
    {id: 'same-east', tmdbId: '900201', title: 'Одинаковый рассвет', original: 'Same Dawn East', titleRu: 'Одинаковый рассвет', titleStatus: 'verified', metadataAt: AT, synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
    {id: 'same-west', tmdbId: '900202', title: 'Одинаковый рассвет', original: 'Same Dawn West', titleRu: 'Одинаковый рассвет', titleStatus: 'verified', metadataAt: AT, synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []},
  ];
  for (let index = 0; index < 30; index++) films.push({id: 'p' + String(index).padStart(2, '0'), tmdbId: String(7000 + index), title: 'Маяк ' + index, original: 'Beacon ' + index, titleRu: 'Маяк ' + index, titleStatus: 'verified', metadataAt: AT, synopsis: 's', peopleVersion: 1, directors: [], actors: [], shows: []});
  records.set('epg/published-generation.json', {phase: 'published', programmeRunId: G1}); etags.set('epg/published-generation.json', 'ptr-1');
  records.set('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: AT, watchlistCount: films.length, films, people: {directors: [lea], actors: [mira, extra]}, stats: {}}); etags.set('epg/generations/' + G1 + '/programme.json', 'prog-1');
  records.set('titles.json', {quiet: {tmdbId: '900002', title: 'Тихая гавань', status: 'provisional', sources: ['https://www.wikidata.org/wiki/Q2']}}); etags.set('titles.json', 'titles-1');
  records.set('people.json', {'actor/mira-sol': {name: 'Мира Соль', original: 'Mira Sol'}}); etags.set('people.json', 'people-1');
  records.set('enrichment/prediction-queue.json', {schemaVersion: 3, programmeRunId: G1, hotPending: ['quiet'], coldPending: [], pending: ['quiet'], retries: {}, lastCheckAt: new Date(Date.now() - 3600000).toISOString(), lastBatch: {finishedAt: new Date(Date.now() - 3600000).toISOString(), stage: 'complete'}}); etags.set('enrichment/prediction-queue.json', 'queue-1');
  records.set('epg/resolver-continuation.json', {stage: 'complete', reason: null, at: new Date(Date.now() - 3600000).toISOString(), remainingChunks: 0, programmeRunId: G1}); etags.set('epg/resolver-continuation.json', 'cont-1');
}
seed();
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
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
    selector,
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    form: {addEventListener(type, fn) {listeners.set('form:' + type, fn);}},
    setAttribute(name, value) {attrs.set(selector + ':' + name, value);},
    getAttribute(name) {return attrs.get(selector + ':' + name) ?? null;},
    focus() {document.activeElement = this;},
    querySelector() {return null;},
    closest(sel) {return sel === 'section' && selector === '#admin-results' ? nodes.get('#admin-results-section') : null;},
    insertAdjacentHTML(position, markup) {this.innerHTML += markup;},
    remove() {this.removed = true;},
    addEventListener(type, fn) {
      const list = listeners.get(selector) || [];
      list.push({type, fn});
      listeners.set(selector, list);
    },
  };
}
const nodes = new Map(['#admin-search', '#admin-queues', '#admin-queues-note', '#admin-results', '#admin-results-section', '#admin-detail', '#admin-loading', '#admin-error', '#admin-stale', '#admin-refresh', '#admin-empty', '#admin-snapshot', '#admin-snapshot-text', '#admin-detail-title', '#admin-health', '#admin-catalog', '#admin-view-catalog', '#admin-view-health', '.admin-views', '#admin-health-refresh', '#admin-health-stale-refresh', '#admin-health-summary', '#admin-health-sources', '#admin-health-subsystems', '#admin-health-issues', '#admin-health-empty', '#admin-health-loading', '#admin-health-error', '#admin-health-stale'].map(selector => [selector, element(selector)]));
const moreButton = element('[data-admin-more="film"]');
const filmGroup = element('[data-admin-group="film"] .admin-group-items');
const searchNode = nodes.get('#admin-search');
let searchValue = '';
let searchCaret = 0;
Object.defineProperty(searchNode, 'value', {
  get() {return searchValue;},
  set(next) {searchValue = String(next); searchCaret = searchValue.length;},
});
Object.defineProperty(searchNode, 'selectionStart', {
  get() {return searchCaret;},
  set(next) {searchCaret = next;},
});
const document = {
  body: {name: 'body'},
  activeElement: null,
  querySelector(selector) {
    if (selector === '[data-admin-more="film"]') return nodes.get('#admin-results').innerHTML.includes('data-admin-more="film"') || moreButton.removed === false ? moreButton : null;
    if (selector === '[data-admin-group="film"] .admin-group-items') return filmGroup;
    return nodes.get(selector) || null;
  },
};
document.activeElement = document.body;
const stack = [];
let index = -1;
const windowListeners = [];
const window = {
  addEventListener(type, fn) {windowListeners.push({type, fn});},
  location: {href: 'http://127.0.0.1/admin?kind=person&id=person:actor/mira-sol'},
  history: {
    pushState(state, _title, url) {
      stack.splice(index + 1);
      stack.push({href: new URL(url, window.location.href).href, state});
      index++;
      window.location.href = stack[index].href;
    },
    replaceState(state, _title, url) {
      const href = new URL(url, window.location.href).href;
      if (index < 0) {stack.push({href, state}); index = 0;}
      else stack[index] = {href, state};
      window.location.href = href;
    },
    back() {
      if (index <= 0) return;
      index--;
      window.location.href = stack[index].href;
      for (const item of windowListeners) if (item.type === 'popstate') item.fn();
    },
    forward() {
      if (index >= stack.length - 1) return;
      index++;
      window.location.href = stack[index].href;
      for (const item of windowListeners) if (item.type === 'popstate') item.fn();
    },
  },
};
const ctx = vm.createContext({
  URL, URLSearchParams, document, window, history: window.history, fetch: fakeFetch, crypto: webcrypto,
  Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp,
  setTimeout, clearTimeout, AbortController, console,
});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
const settle = async () => {await run('adminLive.pending'); await new Promise(resolve => setTimeout(resolve, 0));};
const url = () => new URL(window.location.href);
const results = nodes.get('#admin-results'), detail = nodes.get('#admin-detail'), empty = nodes.get('#admin-empty'), error = nodes.get('#admin-error'), stale = nodes.get('#admin-stale'), loading = nodes.get('#admin-loading');

// 1. Initial load with a deep link: detail from the live snapshot, the snapshot line, queue counts.
await settle();
assert.match(detail.innerHTML, /Мира Соль/);
assert.match(detail.innerHTML, /Mira Sol/);
assert.match(detail.innerHTML, /letterboxd/);
assert.match(detail.innerHTML, /wikidata/, 'provenance of the cached name');
assert.match(detail.innerHTML, /Сохранить вариант/);
assert.match(detail.innerHTML, /id="admin-name-preferred"/);
assert.doesNotMatch(detail.innerHTML, /id="admin-name-preferred"[^>]*checked/);
assert.match(detail.innerHTML, /Без галочки сохранение только добавляет вариант/);
assert.match(detail.innerHTML, /id="admin-name-form"/);
assert.match(detail.innerHTML, /admin-folded/, 'person aliases stay in a collapsed section');
assert.match(detail.innerHTML, /name="person-name-alias" value="Мира Соль"/);
assert.match(detail.innerHTML, /текущее предпочтительное/);
assert.doesNotMatch(detail.innerHTML, /name="person-name-alias" value="Mira Sol"/, 'the Latin credit is not a radio');
assert.doesNotMatch(detail.innerHTML, /Нет варианта с подтверждённым русским происхождением/);
assert.equal(detail.hidden, false);
assert.match(nodes.get('#admin-snapshot-text').textContent, /Поколение 11111111, программа от 29\.10\.2026/);
assert.match(nodes.get('#admin-snapshot-text').textContent, /фильмов: 35, людей: 3/);
assert.equal(attrs.get('#admin-snapshot:data-admin-skew'), 'false');
assert.match(nodes.get('#admin-queues').innerHTML, /Локализация отсутствует<\/span><small>фильмы · 1/);
assert.match(nodes.get('#admin-queues').innerHTML, /Черновая локализация<\/span><small>фильмы · 1/);
assert.match(nodes.get('#admin-queues').innerHTML, /Идентичность не сопоставлена<\/span><small>фильмы · 1/);
assert.match(nodes.get('#admin-queues').innerHTML, /Локализация отсутствует<\/span><small>люди · 1/);
assert.doesNotMatch(nodes.get('#admin-queues').innerHTML, /Отпечаток|Прогноз/);
assert.match(nodes.get('#admin-queues-note').textContent, /Отпечаток не актуален, Прогноз не актуален/);
assert.equal(nodes.get('#admin-queues-note').hidden, false);
assert.equal(loading.hidden, true);
assert.equal(stale.hidden, true);
assert.equal(error.hidden, true);
assert.equal(typeof run('adminLive.pin'), 'string');
assert.ok(requests.every(request => request.method === 'GET' && request.path.startsWith('/api/admin/') && request.credentials === 'same-origin'), JSON.stringify(requests));
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/overview', '/api/admin/people/person%3Aactor%2Fmira-sol']);

// 2. Back to the overview: no detail, queues still shown without a second overview read.
requests = [];
window.history.pushState(null, '', '/admin');
await run('onAdminHistory()');
assert.equal(detail.hidden, true);
assert.match(results.innerHTML, /Введите запрос или выберите очередь/);
assert.match(nodes.get('#admin-queues').innerHTML, /Идентичность не сопоставлена/);
assert.deepEqual(requests, [], 'the overview is held with the pin');

// 3. Search through the debounced input: the query is in the URL at once, the request follows, results carry the collision note.
searchNode.value = 'одинаковый';
document.activeElement = searchNode;
run('onAdminSearch()');
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.deepEqual(requests, [], 'debounced');
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
assert.deepEqual(requests.map(request => request.path.split('?')[0]).sort(), ['/api/admin/films', '/api/admin/people']);
assert.ok(requests.every(request => request.path.includes('pin=')), 'the held pin is sent back');
assert.match(results.innerHTML, /Одинаковое название в этой выдаче/);
assert.match(results.innerHTML, /tmdb:900201/);
assert.match(results.innerHTML, /tmdb:900202/);
assert.match(results.innerHTML, /<h3>Фильмы <small>2<\/small><\/h3>/);
assert.doesNotMatch(results.innerHTML, /Показать ещё/);
assert.equal(empty.hidden, true);
assert.equal(document.activeElement, searchNode);

// 4. Open a result, go back and forward: the detail and the search are both in the URL.
document.activeElement = document.body;
await run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
assert.equal(url().searchParams.get('id'), 'film:same-east');
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.match(detail.innerHTML, /tmdb:900201/);
assert.match(detail.innerHTML, /Same Dawn East/);
assert.match(detail.innerHTML, /вне снимка программы/, 'fingerprint and prediction are shown as outside this read');
assert.doesNotMatch(detail.innerHTML, /Сохранить вариант/, 'a film card has no person-name confirmation');
assert.equal(document.activeElement, nodes.get('#admin-detail-title'));
window.history.back();
await settle();
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.equal(url().searchParams.get('id'), null);
assert.equal(detail.hidden, true);
window.history.forward();
await settle();
assert.equal(url().searchParams.get('id'), 'film:same-east');
assert.match(detail.innerHTML, /Одинаковый рассвет/);

// 5. Queue toggle in the URL; a film-only queue asks the films route alone.
searchNode.value = '';
run('onAdminSearch()');
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
requests = [];
await run(`onAdminQueue({target:{closest(){return {getAttribute(name){return name==='data-admin-queue'?'identity-unresolved':null;}};}}})`);
assert.equal(url().searchParams.get('queue'), 'identity-unresolved');
assert.match(results.innerHTML, /film:blank/);
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/films', '/api/admin/films/film%3Asame-east']);
window.history.back();
await settle();
assert.equal(url().searchParams.get('queue'), null);
assert.equal(url().searchParams.get('id'), 'film:same-east');

// 6. Pagination: 25 of 30 beacons, then the rest through the cursor under the same pin.
window.location.href = 'http://127.0.0.1/admin?q=beacon';
await run('adminRender()');
await settle();
assert.match(results.innerHTML, /<h3>Фильмы <small>25\+<\/small><\/h3>/);
assert.match(results.innerHTML, /data-admin-more="film"/);
assert.equal(typeof run('adminLive.next.film'), 'string');
moreButton.removed = false;
filmGroup.innerHTML = '';
requests = [];
await run(`onAdminMore('film')`);
await settle();
assert.equal(requests.length, 1);
assert.match(requests[0].path, /cursor=/);
assert.match(requests[0].path, /pin=/);
assert.equal((filmGroup.innerHTML.match(/class="admin-hit"/g) || []).length, 5);
assert.equal(run('adminLive.next.film'), null);
assert.equal(moreButton.removed, true, 'the last page removes the button');

// 7. Empty is not an error.
window.location.href = 'http://127.0.0.1/admin?q=неттакого';
await run('adminRender()');
await settle();
assert.equal(empty.hidden, false);
assert.equal(results.innerHTML, '');
assert.equal(error.hidden, true);
assert.equal(stale.hidden, true);

// 8. Unavailable programme: the error state, no results, no fallback to fixture data.
records.delete('epg/published-generation.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
window.location.href = 'http://127.0.0.1/admin?q=beacon';
await run('adminRender()');
await settle();
assert.equal(error.hidden, false);
assert.match(error.textContent, /Опубликованная программа сейчас недоступна/);
assert.equal(results.innerHTML, '');
assert.equal(nodes.get('#admin-results-section').hidden, true);
assert.equal(loading.hidden, true);
assert.equal(stale.hidden, true);

// 9. Stale snapshot: the dictionary version changes under the held pin; the page keeps what it shows and offers a refresh.
seed();
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
window.location.href = 'http://127.0.0.1/admin?q=beacon';
await run('adminRender()');
await settle();
assert.equal(error.hidden, true);
assert.match(results.innerHTML, /film:p00/);
const heldPin = run('adminLive.pin');
etags.set('titles.json', 'titles-2');
window.location.href = 'http://127.0.0.1/admin?q=мост';
await run('adminRender()');
await settle();
assert.equal(stale.hidden, false, 'a 409 shows the stale state');
assert.equal(error.hidden, true);
assert.match(results.innerHTML, /film:p00/, 'the previous results stay on screen');
assert.equal(run('adminLive.pin'), heldPin);
await run('onAdminRefresh()');
await settle();
assert.equal(stale.hidden, true);
assert.notEqual(run('adminLive.pin'), heldPin);
assert.match(results.innerHTML, /Северный мост/);
assert.match(results.innerHTML, /название: проверено/);
assert.doesNotMatch(results.innerHTML, /undefined|null · /);

// 9b. An unknown queue in the URL is an error state without a request.
requests = [];
window.location.href = 'http://127.0.0.1/admin?queue=nope';
await run('adminRender()');
await settle();
assert.equal(error.hidden, false);
assert.match(error.textContent, /Такой очереди нет/);
assert.deepEqual(requests, []);
assert.equal(nodes.get('#admin-results-section').hidden, true);
assert.match(css, /\.admin-state-stale\[hidden\]\{display:none\}/, 'a flex banner still honours hidden');

// 9c. Health view: one GET /api/admin/health, subsystem cards, grouped issues, unknown sources named, links back to the catalogue, stale and error states.
const healthNode = nodes.get('#admin-health'), catalogNode = nodes.get('#admin-catalog');
requests = [];
window.history.pushState(null, '', '/admin?view=health');
await run('adminRender()');
await settle();
assert.equal(healthNode.hidden, false);
assert.equal(catalogNode.hidden, true);
assert.equal(attrs.get('#admin-view-health:aria-current'), 'page');
assert.equal(attrs.get('#admin-view-catalog:aria-current'), 'false');
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/health']);
assert.ok(requests.every(request => request.method === 'GET'));
assert.match(nodes.get('#admin-health-summary').textContent, /Оценка на .* · поколение 11111111/);
assert.match(nodes.get('#admin-health-summary').textContent, /Сводного балла нет/);
assert.match(nodes.get('#admin-health-sources').textContent, /нерешённые наблюдения: не читается здесь/);
assert.match(nodes.get('#admin-health-sources').textContent, /baseline Letterboxd: не читается здесь/);
const cards = nodes.get('#admin-health-subsystems').innerHTML;
assert.match(cards, /Архив Letterboxd<\/span><span class="health-card-status">неизвестно/);
assert.match(cards, /Отпечатки<\/span><span class="health-card-status">неизвестно/, 'no view index in the store, so the dimension is unknown');
assert.match(cards, /выводится из индекса отпечатков и прогнозов/);
assert.match(cards, /Метаданные<\/span><span class="health-card-status">требует внимания/);
assert.match(cards, /Очередь прогнозов<\/span><span class="health-card-status">требует внимания/, 'a queued film is pending work, reported as information');
assert.match(cards, /Discovery<\/span><span class="health-card-status">в порядке/);
assert.match(cards, /Постеры<\/span><span class="health-card-status">в порядке в пределах снимка/, 'no catalog copy, so posters cannot be claimed clear');
const issuesHtml = nodes.get('#admin-health-issues').innerHTML;
assert.match(issuesHtml, /health-severity-warning/);
assert.match(issuesHtml, /Метаданные отсутствуют/);
assert.match(issuesHtml, /data-admin-id="film:blank"/);
assert.match(issuesHtml, /Источник не входит в это ограниченное чтение/);
assert.doesNotMatch(issuesHtml, /<button/, 'no execution controls in the issue list');
assert.ok(issuesHtml.indexOf('health-severity-warning') < issuesHtml.indexOf('health-severity-info'), 'warnings before information');
assert.equal(nodes.get('#admin-health-empty').hidden, true);
assert.equal(nodes.get('#admin-health-loading').hidden, true);
assert.equal(nodes.get('#admin-health-error').hidden, true);
assert.equal(nodes.get('#admin-health-stale').hidden, true);
assert.equal(typeof run('adminHealth.pin'), 'string');
await run(`onAdminHealthLink({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:blank','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
await settle();
assert.equal(url().searchParams.get('view'), null);
assert.equal(url().searchParams.get('id'), 'film:blank');
assert.equal(healthNode.hidden, true);
assert.equal(catalogNode.hidden, false);
assert.match(detail.innerHTML, /Blank Reel/);
window.history.back();
await settle();
assert.equal(url().searchParams.get('view'), 'health');
assert.equal(healthNode.hidden, false);
await run(`onAdminView({target:{closest(){return {getAttribute(){return 'catalog';}};}},preventDefault(){},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
await settle();
assert.equal(url().searchParams.get('view'), null);
assert.equal(catalogNode.hidden, false);
window.location.href = 'http://127.0.0.1/admin?view=health';
await run('adminRender()');
await settle();
const healthPin = run('adminHealth.pin');
etags.set('people.json', 'people-2');
await run('adminRenderHealth()');
await settle();
assert.equal(nodes.get('#admin-health-stale').hidden, false, 'a changed dictionary under the held pin is a stale answer');
assert.match(nodes.get('#admin-health-summary').textContent, /Оценка на/, 'the previous evaluation stays on screen');
await run('onAdminHealthRefresh()');
await settle();
assert.equal(nodes.get('#admin-health-stale').hidden, true);
assert.notEqual(run('adminHealth.pin'), healthPin);
records.delete('epg/published-generation.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
await run('onAdminHealthRefresh()');
await settle();
assert.equal(nodes.get('#admin-health-error').hidden, false);
assert.match(nodes.get('#admin-health-error').textContent, /Опубликованная программа сейчас недоступна/);
seed();
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
run(`onAdminKey({key:'Escape',preventDefault(){}})`);
assert.equal(url().searchParams.get('view'), 'health', 'Escape does not leave the health view');
assert.deepEqual(['1 подсистема', '3 подсистемы', '5 подсистем', '11 подсистем', '21 подсистема'], [1, 3, 5, 11, 21].map(count => run(`healthPlural(${count}, 'подсистема', 'подсистемы', 'подсистем')`)));

// 10. Escape clears the query and keeps focus in the field.
window.location.href = 'http://127.0.0.1/admin?q=мост';
await run('adminRender()');
await settle();
assert.equal(searchNode.value, 'мост', 'the field follows the URL');
run(`onAdminKey({key:'Escape',preventDefault(){this.defaultPrevented=true;}})`);
await settle();
assert.equal(url().searchParams.get('q'), null);
assert.equal(searchNode.value, '');
assert.equal(document.activeElement, searchNode);
assert.ok(requests.every(request => request.method === 'GET'));

// 11. An unknown save keeps the requestId; a confirmed refusal starts a new one. Editing the form drops it.
assert.ok((listeners.get('#admin-detail') || []).some(item => item.type === 'input'));
assert.ok((listeners.get('#admin-detail') || []).some(item => item.type === 'change'));
assert.equal(run(`adminNameCommitUnknown({ok:false,status:0,error:'network'})`), true);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:503,error:'readback_failed'})`), true);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:500,error:'http_500'})`), true);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:412,error:'version_conflict'})`), false);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:409,error:'request_id_reused'})`), false);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:503,error:'review_unconditional'})`), false);
assert.equal(run(`adminNameCommitUnknown({ok:false,status:503,error:'storage_unavailable'})`), false);
window.location.href = 'http://127.0.0.1/admin?kind=person&id=person:actor/mira-sol';
await run('onAdminRefresh()');
await settle();
await run(`(async () => {
  globalThis.__namePosts = [];
  globalThis.__namePost = adminPost;
  const status = {textContent:'', focus(){this.focused=true;}};
  const button = {disabled:false};
  const form = {id:'admin-name-form', dataset:{}, querySelector(sel){
    if(sel==='#admin-name-status')return status;
    if(sel==='button[type="submit"]')return button;
    if(sel==='#admin-name-manual')return {value:'Актёр Клавиатура'};
    if(sel==='#admin-name-basis')return {value:''};
    if(sel==='input[name="person-name-alias"]:checked')return null;
    return null;
  }, querySelectorAll(){return [];}};
  globalThis.__nameForm = form;
  globalThis.__nameStatus = status;
  globalThis.__nameButton = button;
  adminPost = async (path, body) => { globalThis.__namePosts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:0, error:'network', body:null}; };
  await onAdminNameSubmit({target:form, preventDefault(){}});
  await onAdminNameSubmit({target:form, preventDefault(){}});
  adminPost = async (path, body) => { globalThis.__namePosts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:503, error:'readback_failed', body:{error:'storage_unavailable', reason:'readback_failed'}}; };
  await onAdminNameSubmit({target:form, preventDefault(){}});
})()`);
const namePosts = run('__namePosts');
assert.equal(namePosts.length, 3);
assert.equal(namePosts[0].requestId, namePosts[1].requestId);
assert.equal(namePosts[1].requestId, namePosts[2].requestId);
assert.equal(run('__nameForm.dataset.requestId'), namePosts[0].requestId);
assert.equal(run('__nameStatus.textContent'), 'Неизвестно, записалось ли имя. Сверяю карточку.');
assert.equal(run('__nameButton.disabled'), false);
await run(`(async () => {
  adminPost = async (path, body) => { globalThis.__namePosts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:412, error:'version_conflict', body:{error:'version_conflict'}}; };
  await onAdminNameSubmit({target:__nameForm, preventDefault(){}});
})()`);
assert.equal(run('__nameForm.dataset.requestId'), undefined);
assert.match(run('__nameStatus.textContent'), /Имя уже изменилось/);
await run(`(async () => {
  adminPost = async (path, body) => { globalThis.__namePosts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:0, error:'network', body:null}; };
  await onAdminNameSubmit({target:__nameForm, preventDefault(){}});
  onAdminNameEdit({target:{closest(sel){return sel==='#admin-name-form'?__nameForm:null;}}});
})()`);
const afterEdit = run('__namePosts');
assert.equal(afterEdit.length, 5);
assert.notEqual(afterEdit[4].requestId, afterEdit[0].requestId);
assert.equal(run('__nameForm.dataset.requestId'), undefined, 'editing the form drops the pending request');
await run('adminPost = __namePost');

// 12. A matching preferred name is not proof of a link-only save. Radios are provenance, not script.
await run(`(async () => {
  const status = {textContent:'', focus(){this.focused=true;}};
  const manual = {value:''};
  const basis = {value:''};
  const radios = [{value:'Мира Соль', checked:false}];
  const roles = [{value:'person:director/mira-sol', checked:false, getAttribute(name){return name==='data-version'?'role-v':null;}}];
  const form = {id:'admin-name-form', dataset:{}, querySelector(sel){
    if(sel==='#admin-name-status')return status;
    if(sel==='#admin-name-manual')return manual;
    if(sel==='#admin-name-basis')return basis;
    if(sel==='input[name="person-name-alias"]:checked')return radios.find(item=>item.checked)||null;
    if(sel==='button[type="submit"]')return {disabled:false};
    return null;
  }, querySelectorAll(sel){
    if(sel==='input[name="person-name-alias"]')return radios;
    if(sel==='input[name="person-name-role"]')return roles;
    if(sel==='input[name="person-name-role"]:checked')return roles.filter(item=>item.checked);
    return [];
  }};
  const detailNode = document.querySelector('#admin-detail');
  detailNode.querySelector = sel => sel==='#admin-name-form'?form:null;
  adminLive.entity = {id:'person:actor/mira-sol', nameReview:{version:'name-review:1:stale'}};
  const preferred = 'Мира Соль';
  const kept = {requestId:'req-link-only', value:preferred, mode:'alias', basis:'', roles:[{id:'person:director/mira-sol', expectedVersion:'role-v'}]};
  const stale = {entity:{preferred, nameReview:{preferred:{value:preferred}, reviews:[], roleLinks:[], version:'name-review:1:stale'}}};
  adminFinishUnknownName(kept, stale);
  globalThis.__linkStatus = status.textContent;
  globalThis.__linkRequest = form.dataset.requestId;
  globalThis.__linkChecked = roles[0].checked;
  const previous = adminPost;
  globalThis.__linkPosts = [];
  adminPost = async (path, body) => { globalThis.__linkPosts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:0, error:'network', body:null}; };
  await onAdminNameSubmit({target:form, preventDefault(){}});
  adminPost = previous;
  const proved = {entity:{preferred, nameReview:{preferred:{value:preferred}, reviews:[{requestId:'req-link-only', linkedFrom:null, roles:['person:director/mira-sol']}], roleLinks:[{id:'person:director/mira-sol'}], version:'name-review:1:new'}}};
  adminFinishUnknownName(kept, proved);
  globalThis.__linkProved = status.textContent;
  globalThis.__linkProvedRequest = form.dataset.requestId;
  detailNode.querySelector = () => null;
})()`);
assert.equal(run('__linkStatus'), 'Неизвестно, записалось ли имя. Повторите отправку: это будет та же запись, без второй правки. Она сделает предпочтительным «Мира Соль».');
assert.doesNotMatch(run('__linkStatus'), /Имя записано/);
assert.equal(run('__linkRequest'), 'req-link-only');
assert.equal(run('__linkChecked'), true);
const linkPosts = run('__linkPosts');
assert.equal(linkPosts.length, 1);
assert.equal(linkPosts[0].requestId, 'req-link-only');
assert.equal(linkPosts[0].value, 'Мира Соль');
assert.deepEqual(linkPosts[0].roles, [{id:'person:director/mira-sol', expectedVersion:'role-v'}]);
assert.equal(run('__linkProved'), 'Имя записано. Карточка сверена.');
assert.equal(run('__linkProvedRequest'), undefined);

// 13. A refresh with new version tokens must not rewrite the pending command, even if the alias radio is gone.
await run(`(async () => {
  adminNameDrop();
  const status = {textContent:'', focus(){}};
  const manual = {value:''};
  const basis = {value:'заметка'};
  const preferBox = {checked:true};
  const preview = {hidden:true, textContent:''};
  const radios = [{value:'Старое имя', checked:true}];
  let roleVersion = 'name-review:1:role-old';
  const roles = [{value:'person:director/mira-sol', checked:true, disabled:true, getAttribute(name){return name==='data-version'?roleVersion:null;}}];
  const form = {id:'admin-name-form', dataset:{}, querySelector(sel){
    if(sel==='#admin-name-status')return status;
    if(sel==='#admin-name-manual')return manual;
    if(sel==='#admin-name-basis')return basis;
    if(sel==='#admin-name-preferred')return preferBox;
    if(sel==='#admin-name-preview')return preview;
    if(sel==='input[name="person-name-alias"]:checked')return radios.find(item=>item.checked)||null;
    if(sel==='button[type="submit"]')return {disabled:false};
    return null;
  }, querySelectorAll(sel){
    if(sel==='input[name="person-name-alias"]')return radios;
    if(sel==='input[name="person-name-role"]')return roles;
    if(sel==='input[name="person-name-role"]:checked')return roles.filter(item=>item.checked);
    return [];
  }};
  const detailNode = document.querySelector('#admin-detail');
  detailNode.querySelector = sel => sel==='#admin-name-form'?form:null;
  adminLive.entity = {id:'person:actor/mira-sol', preferred:'Старое имя', nameReview:{version:'name-review:1:old', preferred:{value:'Старое имя'}, reviews:[], roleLinks:[]}};
  const posts = [];
  const previousPost = adminPost;
  const previousRefresh = onAdminRefresh;
  adminPost = async (path, body) => { posts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:503, error:'readback_failed', body:{error:'storage_unavailable', reason:'readback_failed'}}; };
  onAdminRefresh = async () => {
    adminLive.entity = {id:'person:actor/mira-sol', preferred:'Старое имя', nameReview:{version:'name-review:1:new', preferred:{value:'Старое имя'}, reviews:[], roleLinks:[]}};
    roleVersion = 'name-review:1:role-new';
    radios.splice(0, radios.length);
    roles[0].checked = false;
    return {mode:'ready', kind:'person', id:'person:actor/mira-sol', entity:adminLive.entity};
  };
  await onAdminNameSubmit({target:form, preventDefault(){}});
  globalThis.__frozenPreferred = preferBox.checked;
  globalThis.__frozenValue = manual.value;
  globalThis.__frozenPreview = preview.hidden ? '' : preview.textContent;
  globalThis.__frozenRole = roles[0].checked;
  globalThis.__frozenStatus = status.textContent;
  await onAdminNameSubmit({target:form, preventDefault(){}});
  globalThis.__frozenPosts = posts;
  adminPost = previousPost;
  onAdminRefresh = previousRefresh;
  adminNameDrop();
  detailNode.querySelector = () => null;
})()`);
const frozenPosts = run('__frozenPosts');
assert.equal(frozenPosts.length, 2);
assert.deepEqual(frozenPosts[1], frozenPosts[0]);
assert.equal(frozenPosts[0].mode, 'alias');
assert.equal(frozenPosts[0].value, 'Старое имя');
assert.equal(frozenPosts[0].expectedVersion, 'name-review:1:old');
assert.equal(frozenPosts[0].basis, 'заметка');
assert.equal(frozenPosts[0].effect, 'promote');
assert.deepEqual(frozenPosts[0].roles, [{id:'person:director/mira-sol', expectedVersion:'name-review:1:role-old'}]);
assert.equal(frozenPosts[0].requestId, frozenPosts[1].requestId);
assert.equal(run('__frozenPreferred'), true, 'a promote that is still pending stays checked after the card is rebuilt');
assert.equal(run('__frozenValue'), 'Старое имя', 'a radio the refresh removed stays visible as the pending value');
assert.match(run('__frozenPreview'), /Станет: Старое имя/);
assert.equal(run('__frozenRole'), true);
assert.match(run('__frozenStatus'), /Повторите отправку/);
assert.match(run('__frozenStatus'), /сделает предпочтительным «Старое имя»/);
assert.doesNotMatch(run('__frozenStatus'), /Имя записано/);

// 14. An add-only command stays add-only after a 503, and a proved reread does not say the preferred name changed.
await run(`(async () => {
  adminNameDrop();
  const status = {textContent:'', focus(){}};
  const manual = {value:'Сандра Баллок'};
  const basis = {value:'устаревший вариант'};
  const preferBox = {checked:false};
  const preview = {hidden:true, textContent:''};
  const form = {id:'admin-name-form', dataset:{}, querySelector(sel){
    if(sel==='#admin-name-status')return status;
    if(sel==='#admin-name-manual')return manual;
    if(sel==='#admin-name-basis')return basis;
    if(sel==='#admin-name-preferred')return preferBox;
    if(sel==='#admin-name-preview')return preview;
    if(sel==='input[name="person-name-alias"]:checked')return null;
    if(sel==='button[type="submit"]')return {disabled:false};
    return null;
  }, querySelectorAll(){return [];}};
  const detailNode = document.querySelector('#admin-detail');
  detailNode.querySelector = sel => sel==='#admin-name-form'?form:null;
  adminLive.entity = {id:'person:actor/sandra-bullock', preferred:'Сандра Буллок', nameReview:{version:'name-review:1:old', preferred:{value:'Сандра Буллок'}, reviews:[], roleLinks:[]}};
  const posts = [];
  const previousPost = adminPost;
  const previousRefresh = onAdminRefresh;
  adminPost = async (path, body) => { posts.push(JSON.parse(JSON.stringify(body))); return {ok:false, status:503, error:'readback_failed', body:{error:'storage_unavailable', reason:'readback_failed'}}; };
  onAdminRefresh = async () => {
    adminLive.entity = {id:'person:actor/sandra-bullock', preferred:'Сандра Буллок', nameReview:{version:'name-review:1:new', preferred:{value:'Сандра Буллок'}, reviews:[], roleLinks:[]}};
    preferBox.checked = true;
    manual.value = '';
    return {mode:'ready', kind:'person', id:'person:actor/sandra-bullock', entity:adminLive.entity};
  };
  await onAdminNameSubmit({target:form, preventDefault(){}});
  globalThis.__aliasPreferred = preferBox.checked;
  globalThis.__aliasValue = manual.value;
  globalThis.__aliasPreview = preview.hidden ? '' : preview.textContent;
  globalThis.__aliasStatus = status.textContent;
  await onAdminNameSubmit({target:form, preventDefault(){}});
  const proved = {entity:{id:'person:actor/sandra-bullock', nameReview:{reviews:[{requestId:posts[0].requestId, linkedFrom:null, effect:'alias_added'}], roleLinks:[], preferred:{value:'Сандра Буллок'}}}};
  adminFinishUnknownName(JSON.parse(JSON.stringify(posts[0])), proved);
  globalThis.__aliasPosts = posts;
  globalThis.__aliasLanded = status.textContent;
  globalThis.__aliasLandedRequest = form.dataset.requestId;
  adminPost = previousPost;
  onAdminRefresh = previousRefresh;
  adminNameDrop();
  detailNode.querySelector = () => null;
})()`);
const aliasPosts = run('__aliasPosts');
assert.equal(aliasPosts.length, 2);
assert.deepEqual(aliasPosts[1], aliasPosts[0]);
assert.equal(aliasPosts[0].effect, 'add_alias');
assert.equal(aliasPosts[0].value, 'Сандра Баллок');
assert.equal(aliasPosts[0].mode, 'manual');
assert.equal(aliasPosts[0].basis, 'устаревший вариант');
assert.equal(aliasPosts[0].roles, undefined);
assert.equal(run('__aliasPreferred'), false, 'an add-only command stays unchecked after the card is rebuilt');
assert.equal(run('__aliasValue'), 'Сандра Баллок');
assert.equal(run('__aliasPreview'), '');
assert.match(run('__aliasStatus'), /только добавит вариант «Сандра Баллок»/);
assert.match(run('__aliasStatus'), /Предпочтительное имя не изменится/);
assert.doesNotMatch(run('__aliasStatus'), /сделает предпочтительным/);
assert.equal(run('__aliasLanded'), 'Вариант записан. Предпочтительное имя не изменилось.');
assert.equal(run('__aliasLandedRequest'), undefined);
const wall = run(`(() => {
  const foreign = Array.from({length:32}, (_, index) => ({value:'Alias '+index, origin:'alias', provenance:index % 2 ? {source:'tmdb'} : {source:'letterboxd'}, preferred:false}));
  foreign.push({value:'Кириллица без языка', origin:'alias', provenance:{source:'wikidata'}, preferred:false});
  foreign.push({value:'Имя Словаря', origin:'preferred', provenance:{value:'Имя Словаря'}, preferred:true});
  foreign.push({value:'Словарь Алиас', origin:'alias', provenance:{source:'dictionary'}, preferred:false});
  foreign.push({value:'Имя Владельца', origin:'alias', provenance:{authority:'owner', source:'owner'}, preferred:false});
  foreign.push({value:'Прошлое имя', origin:'alias', provenance:{source:'wikidata', previousPreferred:true, historicalSource:'wikidata'}, preferred:false});
  return adminNameForm({id:'person:actor/wall', original:'Wall Person', preferred:'Имя Словаря', nameReview:{version:'name-review:1:wall', original:'Wall Person', preferred:{value:'Имя Словаря', status:'reviewed', source:'dictionary', authority:'dictionary'}, options:foreign, collisions:[{id:'person:director/wall', original:'Wall Person', reason:'same_original', version:'v2', linked:false}], reviews:[], roleLinks:[]}});
})()`);
const wallRadios = [...wall.matchAll(/name="person-name-alias" value="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(wallRadios.slice().sort(), ['Имя Владельца', 'Имя Словаря', 'Прошлое имя', 'Словарь Алиас']);
assert.match(wall, /<details class="admin-name-more">/);
assert.match(wall, /Alias 31/);
assert.match(wall, /Кириллица без языка/);
assert.doesNotMatch(wall, /name="person-name-alias" value="Кириллица без языка"/);
assert.doesNotMatch(wall, /name="person-name-alias" value="Alias 0"/);
assert.match(wall, /Оригинал: <b>Wall Person<\/b>/);
assert.match(wall, /id="admin-name-manual"/);
assert.match(wall, /Сохранить вариант/);
assert.match(wall, /Использовать как предпочтительное/);
assert.match(wall, /name="person-name-role"/);
const bare = run(`adminNameForm({id:'person:actor/bare', original:'Bare', nameReview:{version:'v', original:'Bare', preferred:{value:'Голое', status:'provisional', source:'wikidata', authority:null}, options:[{value:'Голое', origin:'preferred', provenance:{source:'wikidata'}, preferred:true},{value:'Bare', origin:'original', provenance:{source:'letterboxd'}}], collisions:[], reviews:[]}})`);
assert.match(bare, /name="person-name-alias" value="Голое"/);
assert.match(bare, /текущее предпочтительное/);
assert.doesNotMatch(bare, /name="person-name-alias" value="Bare"/);
assert.doesNotMatch(bare, /Нет варианта с подтверждённым русским происхождением/);
assert.match(bare, /Сейчас: <b>Голое<\/b>/);
const bruce = run(`adminNameForm({id:'person:actor/bruce-willis', original:'Bruce Willis', preferred:'Брюс Уиллис', nameReview:{version:'name-review:1:bruce', original:'Bruce Willis', preferred:{value:'Брюс Уиллис', status:'provisional', source:'wikidata', authority:null}, options:[{value:'Брюс Уиллис', origin:'preferred', provenance:{source:'wikidata'}, preferred:true},{value:'Брюс Виллис', origin:'alias', provenance:{source:'owner', authority:'owner', added:'alias'}, preferred:false},{value:'Bruce Willis', origin:'original', provenance:{source:'letterboxd'}, preferred:false},{value:'Кириллица без языка', origin:'alias', provenance:{source:'tmdb'}, preferred:false}], collisions:[], reviews:[], roleLinks:[]}})`);
const bruceRadios = [...bruce.matchAll(/name="person-name-alias" value="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(bruceRadios, ['Брюс Уиллис', 'Брюс Виллис']);
assert.match(bruce, /Брюс Уиллис<\/span> <small class="muted">preferred · текущее предпочтительное<\/small>/);
assert.doesNotMatch(bruce, /name="person-name-alias" value="Bruce Willis"/);
assert.doesNotMatch(bruce, /name="person-name-alias" value="Кириллица без языка"/);
assert.match(bruce, /Кириллица без языка/);
const bruceRestored = run(`adminNameForm({id:'person:actor/bruce-willis', original:'Bruce Willis', nameReview:{version:'name-review:1:bruce-restored', original:'Bruce Willis', preferred:{value:'Брюс Уиллис', status:'reviewed', source:'owner', authority:'owner'}, options:[{value:'Брюс Уиллис', origin:'preferred', provenance:{source:'owner', authority:'owner'}, preferred:true},{value:'Брюс Виллис', origin:'alias', provenance:{source:'wikidata', previousPreferred:true, historicalSource:'wikidata'}, preferred:false},{value:'Bruce Willis', origin:'original', provenance:{source:'letterboxd'}}], collisions:[], reviews:[], roleLinks:[]}})`);
const restoredRadios = [...bruceRestored.matchAll(/name="person-name-alias" value="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(restoredRadios, ['Брюс Уиллис', 'Брюс Виллис']);
assert.match(bruceRestored, /Брюс Уиллис<\/span> <small class="muted">preferred · текущее предпочтительное<\/small>/);
assert.match(bruceRestored, /было предпочтительным/);
run(`adminDetail({mode:'ready', id:'north', kind:'film', entity:{id:'film:north', storedId:'north', preferred:'Северный мост', originalTitle:'North Bridge', aliases:[{value:'North Bridge', kind:'title', provenance:{source:'letterboxd'}}], titleReview:{version:'title-review:1:north', filmId:'film:north', preferred:{value:'Северный мост', status:'reviewed', source:'dictionary'}, options:[{value:'Северный мост', origin:'preferred', provenance:{source:'dictionary'}},{value:'Мост на севере', origin:'alias', provenance:{source:'dictionary'}},{value:'North Bridge', origin:'alias', provenance:{source:'letterboxd'}}], reviews:[]}, localization:{status:'reviewed', source:'dictionary'}, identity:{status:'resolved'}, externalIds:[], localizationConflicts:[]}})`);
assert.match(detail.innerHTML, /data-title-review/);
assert.match(detail.innerHTML, /Записать название/);
assert.match(detail.innerHTML, /<summary>Другие названия \(1\)<\/summary>/);
assert.match(detail.innerHTML, /Мост на севере/);
assert.doesNotMatch(detail.innerHTML, /name="title-review-choice" value="North Bridge"/);
assert.doesNotMatch(detail.innerHTML, /admin-folded/);
assert.doesNotMatch(detail.innerHTML, /admin-name-form/);
assert.ok(detail.innerHTML.indexOf('Оригинал:') < detail.innerHTML.indexOf('data-title-review') && detail.innerHTML.indexOf('data-title-review') < detail.innerHTML.indexOf('<h3>Сводка</h3>'));
run(`adminDetail({mode:'ready', id:'person:actor/mira-sol', kind:'person', entity:{id:'person:actor/mira-sol', preferred:'Мира Соль', original:'Mira Sol', aliases:[{value:'M. Sol', provenance:{source:'letterboxd'}}], localization:{status:'provisional', source:'wikidata'}, identity:{status:'resolved'}, externalIds:[], localizationConflicts:[], nameReview:{version:'name-review:1:mira', original:'Mira Sol', preferred:{value:'Мира Соль', status:'provisional', source:'wikidata'}, options:[{value:'Мира Соль', origin:'preferred', provenance:{source:'wikidata'}, preferred:true}], collisions:[{id:'person:director/mira-sol', original:'Mira Sol', reason:'same_original', version:'name-review:1:role', linked:false}], reviews:[], roleLinks:[]}}})`);
assert.match(detail.innerHTML, /id="admin-name-form"/);
assert.match(detail.innerHTML, /Сохранить вариант/);
assert.match(detail.innerHTML, /name="person-name-role"/);
assert.match(detail.innerHTML, /admin-folded/);
assert.match(detail.innerHTML, /<summary>Другие имена \(1\)<\/summary>/);
assert.doesNotMatch(detail.innerHTML, /data-title-review/);
assert.doesNotMatch(detail.innerHTML, /Записать название/);
assert.ok((listeners.get('#admin-detail') || []).some(item => item.type === 'submit' && item.fn === run('onAdminNameSubmit')));
console.log('Admin shell: live snapshot, URL state, history, pagination, empty, error, stale-pin and health view states passed');
