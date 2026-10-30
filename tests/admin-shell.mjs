// The /admin page on the live read API: the page bundle runs against a DOM stand-in, its fetch goes to the Worker bundle
// over an R2 stand-in with a published generation. Covers the search and queue state in the URL, history, the detail
// view, pagination, and the three distinct states the owner must tell apart: empty, error, stale snapshot.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin, bundleAdminQuery} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin.html', 'utf8');
const page = fs.readFileSync('public/admin.js', 'utf8');
const client = fs.readFileSync('src/admin/client.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const movie = fs.readFileSync('public/app.js', 'utf8');
const movieHtml = fs.readFileSync('public/index.html', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const bundle = bundleAdmin([client, page]);

// Static boundary: the page is owner-only through the existing Access session, GET only, no token, no other API.
assert.doesNotMatch(html, /демонстрационные|Это демонстрационные данные/i);
assert.match(html, /ТОЛЬКО ЧТЕНИЕ/);
for (const id of ['admin-search', 'admin-queues', 'admin-queues-note', 'admin-results', 'admin-detail', 'admin-empty', 'admin-error', 'admin-loading', 'admin-stale', 'admin-refresh', 'admin-snapshot', 'admin-snapshot-text']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="admin-search"') < html.indexOf('id="admin-queues"') && html.indexOf('id="admin-queues"') < html.indexOf('id="admin-results"'));
assert.match(html, /<script src="\/admin\.js"><\/script>/);
assert.doesNotMatch(html, /type="module"|fetch\(|\/api\/|programme\.json/);
assert.match(client, /const ADMIN_API='\/api\/admin'/);
assert.doesNotMatch(bundle, /admin-query|\/api\/enrichment|\/api\/sync|\/mcp|localStorage|sessionStorage|Authorization|Bearer|programme\.json|method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
assert.doesNotMatch(page, /\bfetch\(/, 'the page script reaches the API only through the client');
assert.match(bundle, /credentials:'same-origin'/);
assert.doesNotMatch(movie, /admin-query|\/admin/);
assert.doesNotMatch(movieHtml, /id="admin-search"|admin-query/);
assert.match(worker, /url\.pathname==='\/events'\?'\/':\/\^\\\/film\\\/\[A-Za-z0-9_-\]\{1,80\}\$\/\.test\(url\.pathname\)\?'\/':url\.pathname/);
assert.match(worker, /\/api\/admin\//);
assert.doesNotMatch(worker, /pathname==='\/admin'\?'\/'/);
assert.match(build, /bundleAdmin\(\[fs\.readFileSync\('src\/admin\/client\.js','utf8'\),fs\.readFileSync\('public\/admin\.js','utf8'\)\]\)/);
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
const workerContext = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {},
  FILM_TITLE_DICTIONARY: [{id: 'north', tmdbId: '900001', original: 'North Bridge', title: 'Северный мост', sources: ['https://www.wikidata.org/wiki/Q1'], aliases: ['Мост на севере'], status: 'verified'}],
  PERSON_NAME_DICTIONARY: [{id: 'director/lea-nord', original: 'Lea Nord', name: 'Лея Норд', aliases: ['Л. Норд'], status: 'verified', verification_basis: 'user_supplied', source_url: null}],
  fetch: async () => {throw new Error('the Worker makes no outbound request for the admin page');}});
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(bundleAdminQuery(fs.readFileSync('src/domain/admin-query.js', 'utf8')), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
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
const nodes = new Map(['#admin-search', '#admin-queues', '#admin-queues-note', '#admin-results', '#admin-results-section', '#admin-detail', '#admin-loading', '#admin-error', '#admin-stale', '#admin-refresh', '#admin-empty', '#admin-snapshot', '#admin-snapshot-text', '#admin-detail-title'].map(selector => [selector, element(selector)]));
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
  URL, URLSearchParams, document, window, history: window.history, fetch: fakeFetch,
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
console.log('Admin shell: live snapshot, URL state, history, pagination, empty, error and stale-pin states passed');
