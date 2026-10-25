import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {filmQueue, searchFilms} from '../src/domain/admin-query.js';
import {ADMIN_FILMS, ADMIN_PEOPLE, loadAdmin} from '../src/admin/fixtures.js';
import {bundleAdmin} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin.html', 'utf8');
const page = fs.readFileSync('public/admin.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const movie = fs.readFileSync('public/app.js', 'utf8');
const movieHtml = fs.readFileSync('public/index.html', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const bundle = bundleAdmin([
  fs.readFileSync('src/domain/admin-query.js', 'utf8'),
  fs.readFileSync('src/admin/fixtures.js', 'utf8'),
  page,
]);

assert.match(html, /Это демонстрационные данные/);
assert.match(html, /id="admin-search"/);
assert.match(html, /id="admin-queues"/);
assert.match(html, /id="admin-results"/);
assert.match(html, /id="admin-detail"/);
assert.match(html, /id="admin-empty"/);
assert.match(html, /id="admin-error"/);
assert.match(html, /id="admin-loading"/);
assert.ok(html.indexOf('id="admin-search"') < html.indexOf('id="admin-queues"') && html.indexOf('id="admin-queues"') < html.indexOf('id="admin-results"'));
assert.match(html, /<script src="\/admin\.js"><\/script>/);
assert.doesNotMatch(html, /type="module"|fetch\(|\/api\/|programme\.json/);
assert.doesNotMatch(page, /\bfetch\b|\/api\/|programme\.json/);
assert.doesNotMatch(bundle, /\bfetch\b|\/api\/|programme\.json/);
assert.doesNotMatch(css, /\bfetch\b|\/api\/|programme\.json/);
assert.doesNotMatch(movie, /admin-query|\/admin/);
assert.doesNotMatch(movieHtml, /id="admin-search"|admin-query/);
assert.match(worker, /url\.pathname==='\/events'\?'\/':\/\^\\\/film\\\/\[A-Za-z0-9_-\]\{1,80\}\$\/\.test\(url\.pathname\)\?'\/':url\.pathname/);
assert.doesNotMatch(worker, /\/api\/admin|pathname==='\/admin'\?'\/'/);
assert.match(build, /bundleAdmin/);
assert.match(build, /src\/domain\/admin-query\.js/);
assert.match(css, /overflow-wrap:anywhere/);
assert.match(css, /minmax\(0,1fr\)/);

const reviewed = ADMIN_FILMS.find(film => film.id === 'film:north-bridge');
assert.equal(reviewed.localization.status, 'reviewed');
assert.ok(reviewed.aliases.length >= 2);
assert.equal(ADMIN_FILMS.find(film => film.id === 'film:quiet-harbor').localization.status, 'provisional');
const ambiguous = ADMIN_FILMS.find(film => film.id === 'film:double');
assert.equal(ambiguous.identity.status, 'ambiguous');
assert.equal(ambiguous.externalIds.filter(entry => entry.conflicting).length, 2);
const same = ADMIN_FILMS.filter(film => film.preferred === 'Одинаковый рассвет');
assert.equal(same.length, 2);
assert.notEqual(same[0].canonicalIdentity, same[1].canonicalIdentity);
const mira = ADMIN_PEOPLE.find(person => person.id === 'person:mira');
assert.equal(mira.original, 'Mira Sol');
assert.equal(mira.aliases[0].value, 'M. Sol');

const overview = loadAdmin(new URLSearchParams());
assert.equal(overview.demo, true);
assert.equal(overview.pin, null);
assert.equal(overview.limit, 25);
assert.equal(overview.mode, 'ready');
assert.equal(overview.scope, 'overview');
assert.equal(overview.filmResults.length, 0);
assert.equal(overview.queues.find(item => item.code === 'identity-ambiguous' && item.kind === 'film').count, 1);
assert.equal(JSON.stringify(filmQueue(ADMIN_FILMS, {queue: 'localization-missing', limit: overview.limit}).items.map(item => item.id)), JSON.stringify(['film:blank-reel', 'film:double']));

const omitted = loadAdmin(new URLSearchParams('q=мост'));
assert.equal(omitted.limit, 25);
assert.equal(omitted.filmResults[0].id, 'film:north-bridge');
const invalid = loadAdmin(new URLSearchParams('q=мост'), {limit: 0});
assert.equal(invalid.error, 'invalid_limit');
assert.equal(invalid.mode, 'error');
assert.equal(invalid.filmResults.length, 0);
assert.equal(Object.hasOwn(invalid, 'items'), false);

const unavailable = loadAdmin(new URLSearchParams('error=unavailable&q=мост'));
assert.equal(unavailable.mode, 'error');
assert.equal(unavailable.error, 'unavailable');
assert.equal(unavailable.queues.length, 0);
assert.equal(unavailable.filmResults.length, 0);
const loading = loadAdmin(new URLSearchParams('loading=1'));
assert.equal(loading.mode, 'loading');
assert.equal(loading.error, null);
assert.equal(loading.filmResults.length, 0);

const collision = loadAdmin(new URLSearchParams('q=одинаковый'));
assert.equal(collision.filmResults.length, 2);
assert.equal(collision.filmResults.every(item => item.collision), true);
assert.equal(JSON.stringify(collision.filmResults.map(item => item.canonicalIdentity)), JSON.stringify(['tmdb:900201', 'tmdb:900202']));
assert.equal(loadAdmin(new URLSearchParams('q=неттакого')).filmResults.length, 0);
assert.equal(loadAdmin(new URLSearchParams('q=неттакого')).personResults.length, 0);
assert.equal(loadAdmin(new URLSearchParams('q=неттакого')).error, null);
assert.equal(loadAdmin(new URLSearchParams('q=...')).error, 'invalid_query');
assert.equal(loadAdmin(new URLSearchParams('q=...')).filmResults.length, 0);
assert.equal(loadAdmin(new URLSearchParams('q=M.+Sol')).personResults[0].id, 'person:mira');
assert.equal(loadAdmin(new URLSearchParams('kind=film&id=film:double')).entity.identity.status, 'ambiguous');
assert.equal(loadAdmin(new URLSearchParams('kind=person&id=person:mira')).entity.original, 'Mira Sol');
assert.equal(loadAdmin(new URLSearchParams('kind=film&id=missing')).entityMissing, true);
const narrowed = loadAdmin(new URLSearchParams('q=тень&queue=identity-ambiguous'));
assert.equal(JSON.stringify(narrowed.filmResults.map(item => item.id)), JSON.stringify(['film:double']));
assert.equal(loadAdmin(new URLSearchParams('q=мост&queue=identity-ambiguous')).filmResults.length, 0);
assert.equal(loadAdmin(new URLSearchParams('queue=not-a-queue')).error, 'unknown_queue');
function fixtureFilm(id, preferred, localization) {
  return {id, preferred, originalTitle: preferred, aliases: [], externalIds: [], identity: {status: 'resolved'}, localization: {status: localization}, localizationConflicts: [], metadata: {status: 'fresh'}, fingerprint: {status: 'current'}, prediction: {status: 'current'}};
}
const manyFilms = [];
for (let index = 0; index < 25; index += 1) manyFilms.push(fixtureFilm(`film:beacon-${String(index).padStart(2, '0')}`, 'beacon', 'reviewed'));
manyFilms.push(fixtureFilm('film:beacon-late', 'beacon late', 'missing'));
for (let index = 0; index < 25; index += 1) manyFilms.push(fixtureFilm(`film:queue-${String(index).padStart(2, '0')}`, 'other', 'missing'));
manyFilms.push(fixtureFilm('film:queue-99', 'hidden beacon', 'missing'));
assert.equal(manyFilms.length > 25, true);
const pastSearchPage = loadAdmin(new URLSearchParams('q=beacon&queue=localization-missing'), {films: manyFilms});
assert.equal(JSON.stringify(pastSearchPage.filmResults.map(item => item.id)), JSON.stringify(['film:beacon-late', 'film:queue-99']));
const pastQueuePage = loadAdmin(new URLSearchParams('q=hidden&queue=localization-missing'), {films: manyFilms});
assert.equal(JSON.stringify(pastQueuePage.filmResults.map(item => item.id)), JSON.stringify(['film:queue-99']));
const searchPage = loadAdmin(new URLSearchParams('q=beacon'), {films: manyFilms});
assert.equal(searchPage.filmResults.length, 25);
assert.equal(searchPage.filmResults.some(item => item.id === 'film:beacon-late'), false);
assert.equal(JSON.stringify(searchFilms(ADMIN_FILMS, {query: 'одинаковый', limit: 25}).items.map(item => item.id)), JSON.stringify(collision.filmResults.map(item => item.id)));

const listeners = new Map();
const attrs = new Map();
function element(selector) {
  return {
    selector,
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    form: {addEventListener() {}},
    setAttribute(name, value) {attrs.set(selector + ':' + name, value);},
    getAttribute(name) {return attrs.get(selector + ':' + name) ?? null;},
    focus() {document.activeElement = this;},
    addEventListener(type, fn) {
      const list = listeners.get(selector) || [];
      list.push({type, fn});
      listeners.set(selector, list);
    },
  };
}
const nodes = new Map(['#admin-search', '#admin-queues', '#admin-results', '#admin-detail', '#admin-loading', '#admin-error', '#admin-empty', '#admin-demo', '#admin-detail-title'].map(selector => [selector, element(selector)]));
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
  querySelector(selector) {return nodes.get(selector) || null;},
};
document.activeElement = document.body;
const stack = [];
let index = -1;
const windowListeners = [];
const window = {
  addEventListener(type, fn) {windowListeners.push({type, fn});},
  location: {href: 'http://127.0.0.1/admin?kind=person&id=person:mira'},
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
  URL, URLSearchParams, document, window, history: window.history,
  Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error,
  Uint8Array, Uint32Array, DataView, TextEncoder, TextDecoder, atob, btoa,
});
vm.runInContext(bundle, ctx);
const run = code => vm.runInContext(code, ctx);
assert.match(nodes.get('#admin-detail').innerHTML, /Мира Соль/);
assert.match(nodes.get('#admin-detail').innerHTML, /M\. Sol/);
assert.match(nodes.get('#admin-detail').innerHTML, /letterboxd/);
assert.equal(attrs.get('#admin-demo:data-admin-limit'), '25');

window.history.pushState(null, '', '/admin');
run('onAdminHistory()');
assert.equal(nodes.get('#admin-detail').hidden, true);
assert.match(nodes.get('#admin-queues').innerHTML, /Идентичность неоднозначна/);
nodes.get('#admin-search').value = 'одинаковый';
document.activeElement = nodes.get('#admin-search');
run('onAdminSearch()');
assert.equal(new URL(window.location.href).searchParams.get('q'), 'одинаковый');
assert.match(nodes.get('#admin-results').innerHTML, /Одинаковое название в этой выдаче/);
assert.match(nodes.get('#admin-results').innerHTML, /tmdb:900201/);
assert.match(nodes.get('#admin-results').innerHTML, /tmdb:900202/);
assert.doesNotMatch(nodes.get('#admin-results').innerHTML, /identity collision|каноническ(?:ая|ое) коллизи/);
document.activeElement = document.body;
run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
assert.equal(new URL(window.location.href).searchParams.get('id'), 'film:same-east');
assert.equal(new URL(window.location.href).searchParams.get('q'), 'одинаковый');
assert.match(nodes.get('#admin-detail').innerHTML, /tmdb:900201/);
assert.equal(document.activeElement, nodes.get('#admin-detail-title'));
window.history.back();
assert.equal(new URL(window.location.href).searchParams.get('q'), 'одинаковый');
assert.equal(new URL(window.location.href).searchParams.get('id'), null);
assert.equal(nodes.get('#admin-detail').hidden, true);
window.history.forward();
assert.equal(new URL(window.location.href).searchParams.get('id'), 'film:same-east');
assert.match(nodes.get('#admin-detail').innerHTML, /Одинаковый рассвет/);

nodes.get('#admin-search').value = '';
run('onAdminSearch()');
run(`onAdminQueue({target:{closest(){return {getAttribute(name){return name==='data-admin-queue'?'external-id-conflict':null;}};}}})`);
assert.equal(new URL(window.location.href).searchParams.get('queue'), 'external-id-conflict');
assert.match(nodes.get('#admin-results').innerHTML, /film:double/);
window.history.back();
assert.equal(new URL(window.location.href).searchParams.get('queue'), null);
assert.equal(new URL(window.location.href).searchParams.get('id'), 'film:same-east');

nodes.get('#admin-search').value = 'одинаковый';
nodes.get('#admin-search').selectionStart = 4;
document.activeElement = nodes.get('#admin-search');
run('onAdminSearch()');
assert.equal(nodes.get('#admin-search').selectionStart, 4);
assert.equal(document.activeElement, nodes.get('#admin-search'));
run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
nodes.get('#admin-search').value = 'мост';
document.activeElement = nodes.get('#admin-search');
run('onAdminSearch()');
window.history.back();
assert.equal(new URL(window.location.href).searchParams.get('q'), 'одинаковый');
assert.equal(nodes.get('#admin-search').value, 'одинаковый');
assert.match(nodes.get('#admin-results').innerHTML, /tmdb:900201/);
assert.match(nodes.get('#admin-results').innerHTML, /tmdb:900202/);
assert.equal(document.activeElement, nodes.get('#admin-search'));
window.history.forward();
assert.equal(new URL(window.location.href).searchParams.get('q'), 'мост');
assert.equal(nodes.get('#admin-search').value, 'мост');
assert.match(nodes.get('#admin-results').innerHTML, /film:north-bridge/);
assert.equal(document.activeElement, nodes.get('#admin-search'));
nodes.get('#admin-search').value = 'одинаковый';
run('onAdminSearch()');
run(`onAdminKey({key:'Escape',preventDefault(){this.defaultPrevented=true;}})`);
assert.equal(new URL(window.location.href).searchParams.get('q'), null);
assert.equal(nodes.get('#admin-search').value, '');
assert.equal(document.activeElement, nodes.get('#admin-search'));

window.location.href = 'http://127.0.0.1/admin?kind=film&id=film:double';
run('adminRender()');
assert.match(nodes.get('#admin-detail').innerHTML, /Двойная тень/);
assert.match(nodes.get('#admin-detail').innerHTML, /900101/);
assert.match(nodes.get('#admin-detail').innerHTML, /900102/);
assert.match(nodes.get('#admin-detail').innerHTML, /Тень два/);
assert.match(nodes.get('#admin-detail').innerHTML, /конфликт внешнего id/);
assert.match(nodes.get('#admin-detail').innerHTML, /неоднозначно/);

window.location.href = 'http://127.0.0.1/admin?q=неттакого';
run('adminRender()');
assert.equal(nodes.get('#admin-empty').hidden, false);
assert.equal(nodes.get('#admin-results').innerHTML, '');
assert.equal(nodes.get('#admin-error').hidden, true);

window.location.href = 'http://127.0.0.1/admin?error=unavailable';
run('adminRender()');
assert.equal(nodes.get('#admin-error').hidden, false);
assert.match(nodes.get('#admin-error').textContent, /недоступны/);
assert.equal(nodes.get('#admin-results').innerHTML, '');
assert.equal(nodes.get('#admin-loading').hidden, true);

window.location.href = 'http://127.0.0.1/admin?loading=1';
run('adminRender()');
assert.equal(nodes.get('#admin-loading').hidden, false);
assert.equal(nodes.get('#admin-results').innerHTML, '');
assert.equal(nodes.get('#admin-error').hidden, true);

console.log('Admin shell: fixtures, limit, history, empty and error states passed');
