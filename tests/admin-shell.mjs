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
for (const id of ['admin-health', 'admin-catalog', 'admin-view-catalog', 'admin-view-health', 'admin-health-refresh', 'admin-health-stale-refresh', 'admin-health-summary', 'admin-health-sources', 'admin-health-subsystems', 'admin-health-issues', 'admin-health-empty', 'admin-health-loading', 'admin-health-error', 'admin-health-stale', 'admin-catalog-page-title', 'admin-health-page-title', 'admin-catalog-page-intro', 'admin-health-page-intro', 'admin-health-title']) assert.match(html, new RegExp(`id="${id}"`), id);
const healthDescription = 'Страница владельца: ограниченное чтение опубликованного снимка: что требует внимания и какие источники эта страница не читает. Чтение ничего не меняет.';
const healthIntro = 'Ограниченное чтение опубликованного снимка: что требует внимания и какие источники эта страница не читает. Чтение ничего не меняет.';
assert.match(html, /<title>Данные каталога<\/title>/);
assert.match(html, /<h1 id="admin-catalog-page-title">Каталог данных<\/h1>/);
assert.match(html, /<h1 id="admin-health-page-title">Здоровье данных<\/h1>/);
assert.match(html, new RegExp(healthIntro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.ok(html.includes(healthDescription), 'the first-paint script uses the health description');
assert.ok(page.includes(healthDescription), 'the view switch uses the same health description');
assert.match(html, /var path = location\.pathname/);
assert.match(html, /path === '\/admin\/health' \|\| \(path === '\/admin' && new URLSearchParams\(location\.search\)\.get\('view'\) === 'health'\)/);
assert.match(html, /documentElement\.classList\.add\(health \? 'admin-is-health' : 'admin-is-catalog'\)/);
assert.ok(html.indexOf('<title>Данные каталога</title>') < html.indexOf('documentElement.classList.add'), 'the route class is set from the head, before the body');
assert.ok(html.indexOf('id="admin-catalog-page-title"') < html.indexOf('class="admin-views"') && html.indexOf('id="admin-health-page-title"') < html.indexOf('class="admin-views"') && html.indexOf('class="admin-views"') < html.indexOf('id="admin-health-title"'), 'both page headings sit above the nav; the section heading stays inside the health view');
assert.ok(html.indexOf('id="admin-health-summary"') < html.indexOf('id="admin-health-issues"') && html.indexOf('id="admin-health-issues"') < html.indexOf('id="admin-health-subsystems"') && html.indexOf('id="admin-health-subsystems"') < html.indexOf('id="admin-health-sources"'), 'issues come before subsystem cards and sources');
assert.match(css, /html\.admin-is-health \.admin-catalog-heading,html\.admin-is-health \.brand-sub-catalog\{display:none\}/);
assert.match(css, /html\.admin-is-health \.admin-health-heading\{display:block\}/);
assert.match(css, /html\.admin-is-health #admin-health-title\{display:none\}/);
assert.match(css, /@media\(max-width:760px\)\{html\.admin-is-health \.brand-sub-health\{display:none\}/);
assert.doesNotMatch(html, /<button[^>]*(?:retry|hydrat|import|запустить|повторить)/i, 'no execution buttons on the health view');
assert.match(css, /\.health-group-critical/);
assert.match(bundle, /credentials:'same-origin'/);
assert.doesNotMatch(movie, /admin-query|\/admin/);
assert.doesNotMatch(movieHtml, /id="admin-search"|admin-query/);
assert.match(worker, /url\.pathname==='\/events'\?'\/':\/\^\\\/film\\\/\[A-Za-z0-9_-\]\{1,80\}\$\/\.test\(url\.pathname\)\?'\/':url\.pathname/);
assert.match(worker, /\/api\/admin\//);
assert.doesNotMatch(worker, /pathname==='\/admin'\?'\/'/);
assert.match(worker, /request\.method==='GET'\|\|request\.method==='HEAD'\)&&url\.pathname==='\/admin\/limbo'/);
assert.match(build, /assets\['\/admin\/health'\]=assets\['\/admin'\]/);
assert.match(build, /assets\['\/admin\/limb'\]/);
assert.doesNotMatch(build, /assets\['\/admin\/limbo'\]/);
assert.match(build, /bundleAdmin\(\[fs\.readFileSync\('src\/admin\/client\.js','utf8'\),fs\.readFileSync\('src\/admin\/film-title-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/person-name-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/health-view\.js','utf8'\),fs\.readFileSync\('public\/admin\.js','utf8'\)\]\)/);
const limboHtml = fs.readFileSync('public/admin-limbo.html', 'utf8');
const letterboxdHtml = fs.readFileSync('public/admin-letterboxd.html', 'utf8');
const postersHtml = fs.readFileSync('public/admin-posters.html', 'utf8');
const expectedNav = [['/admin', 'Каталог'], ['/admin/health', 'Здоровье данных'], ['/admin/letterboxd', 'Архив Letterboxd'], ['/admin/limb', 'Лимб'], ['/admin/posters', 'Постеры']];
for (const [name, source] of [['admin', html], ['letterboxd', letterboxdHtml], ['limb', limboHtml], ['posters', postersHtml]]) {
  const nav = source.match(/<nav class="admin-views"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(nav, name);
  const links = [...nav[0].matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(match => [match[1].match(/href="([^"]+)"/)[1], match[2]]);
  assert.deepEqual(links, expectedNav, name);
  assert.equal((source.match(/<nav class="admin-views"/g) || []).length, 1, name);
  assert.ok(source.indexOf('class="admin-workspace"') < source.indexOf('<nav class="admin-views"') && source.indexOf('<nav class="admin-views"') < source.indexOf('class="admin-main"'), name);
  assert.doesNotMatch(source, /Лимбо|view=health|href="\/admin\/limbo"/, name);
  assert.match(source, /<script src="\/status-footer\.js"><\/script>/, name);
  assert.doesNotMatch(source, /src="\/app\.js"/, name);
  assert.ok(source.indexOf('</main>') < source.indexOf('src="/status-footer.js"'), name);
}
assert.match(build, /assets\['\/status-footer\.js'\]=\{body:fs\.readFileSync\('public\/status-footer\.js','utf8'\),type:'text\/javascript'\}/);
assert.doesNotMatch(fs.readFileSync('public/admin-actions.html', 'utf8'), /status-footer\.js/);
assert.match(css, /\.admin-workspace\{display:grid;grid-template-columns:215px minmax\(0,1fr\)/);
assert.match(css, /\.admin-main\{min-width:0\}/);
assert.match(css, /\.admin-views\{display:flex;flex-direction:column;[^}]*border-right:1px solid var\(--line\)/);
assert.match(css, /\.admin-views a\[aria-current=page\]\{[^}]*font-weight:650/);
assert.match(css, /@media\(max-width:1130px\)\{\.admin-workspace\{grid-template-columns:180px minmax\(0,1fr\)/);
assert.match(css, /@media\(max-width:760px\)\{\.admin-workspace\{display:flex;flex-direction:column;align-items:stretch/);
assert.match(css, /@media\(max-width:760px\)\{[^}]*\}\.admin-views\{align-self:stretch;width:100%/);
assert.doesNotMatch(css, /\.admin-views\{[^}]*overflow-x:auto/);
assert.doesNotMatch(css, /\.admin-views a\{[^}]*white-space:nowrap/);
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
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/domain/person-name-review.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/health.js', 'utf8'), workerContext);
vm.runInContext(worker.replace('export default', 'globalThis.worker='), workerContext);

workerContext.ASSETS['/admin'] = {body: html, type: 'text/html'};
workerContext.ASSETS['/admin/health'] = workerContext.ASSETS['/admin'];
workerContext.ASSETS['/admin/limb'] = {body: limboHtml, type: 'text/html'};
const aliasBucket = {async get() {throw new Error('the page alias reads nothing');}, async put() {throw new Error('the page alias writes nothing');}, async list() {throw new Error('the page alias lists nothing');}};
const aliasExecution = {waitUntil() {throw new Error('the page alias does no background work');}};
const pageResponse = (path, method = 'GET') => workerContext.worker.fetch(new Request('https://iptv.example' + path, {method}), {BUCKET: aliasBucket}, aliasExecution);
const catalogPage = await pageResponse('/admin?q=мост');
assert.equal(catalogPage.status, 200);
assert.equal(catalogPage.headers.get('location'), null);
assert.equal(await catalogPage.text(), html);
const healthPage = await pageResponse('/admin/health');
assert.equal(healthPage.status, 200);
assert.match(healthPage.headers.get('content-type'), /text\/html/);
assert.equal(healthPage.headers.get('location'), null);
assert.equal(await healthPage.text(), html, 'health is the same document, not a second page');
const limbPage = await pageResponse('/admin/limb?cause=stalled');
assert.equal(limbPage.status, 200);
assert.equal(limbPage.headers.get('location'), null);
assert.equal(await limbPage.text(), limboHtml);
const alias = await pageResponse('/admin/limbo?kind=observation&cause=stalled&age=14');
assert.equal(alias.status, 302);
assert.equal(alias.headers.get('location'), '/admin/limb?kind=observation&cause=stalled&age=14');
assert.equal(alias.headers.get('cache-control'), 'no-store');
const followed = await pageResponse(alias.headers.get('location'));
assert.equal(followed.status, 200);
assert.equal(followed.headers.get('location'), null, 'the canonical path does not redirect again');
assert.equal(await followed.text(), limboHtml);
const headAlias = await pageResponse('/admin/limbo?kind=film', 'HEAD');
assert.equal(headAlias.status, 302);
assert.equal(headAlias.headers.get('location'), '/admin/limb?kind=film');
const headFollowed = await pageResponse(headAlias.headers.get('location'), 'HEAD');
assert.equal(headFollowed.status, 200, 'HEAD of the canonical page is not a 404');
assert.equal(headFollowed.headers.get('location'), null);
assert.match(headFollowed.headers.get('content-type'), /text\/html/);
assert.equal(headFollowed.headers.get('cache-control'), 'no-cache');
assert.equal(await headFollowed.text(), '', 'HEAD carries the content type and an empty body');
const postedAlias = await pageResponse('/admin/limbo?kind=film', 'POST');
assert.equal(postedAlias.status, 404);
assert.equal(postedAlias.headers.get('location'), null, 'a POST to the page alias is not redirected');
const apiAlias = await pageResponse('/api/admin/limbo?cause=stalled');
assert.notEqual(apiAlias.status, 302);
assert.equal(apiAlias.headers.get('location'), null, 'the inventory API is not the page alias');

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
let pauseAdminReads = null;
const fakeFetch = async (input, init = {}) => {
  if (pauseAdminReads) await pauseAdminReads(init);
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
const nodes = new Map(['#admin-search', '#admin-queues', '#admin-queues-note', '#admin-results', '#admin-results-section', '#admin-detail', '#admin-loading', '#admin-error', '#admin-stale', '#admin-refresh', '#admin-empty', '#admin-snapshot', '#admin-snapshot-text', '#admin-detail-title', '#admin-health', '#admin-catalog', '#admin-view-catalog', '#admin-view-health', '.admin-views', '#admin-health-refresh', '#admin-health-stale-refresh', '#admin-health-summary', '#admin-health-sources', '#admin-health-subsystems', '#admin-health-issues', '#admin-health-empty', '#admin-health-loading', '#admin-health-error', '#admin-health-stale', '#admin-health-kpis', '#admin-health-detail', '#admin-health-detail-body', '#admin-health-wait', '#admin-health-wait-list', '.health-master', 'meta[name="description"]'].map(selector => [selector, element(selector)]));
function detachNode(node) {
  const parent = node && node.parentElement;
  if (!parent || !parent.childNodes) return;
  parent.childNodes = parent.childNodes.filter(child => child !== node);
}
function attachNode(parent, node, index) {
  detachNode(node);
  if (!parent.childNodes) parent.childNodes = [];
  node.parentElement = parent;
  parent.childNodes.splice(index === undefined ? parent.childNodes.length : index, 0, node);
}
function mountOptions(host) {
  host.childNodes = [];
  host.querySelector = selector => host.childNodes.find(child => child.matches && child.matches(selector)) || null;
  host.querySelectorAll = selector => host.childNodes.filter(child => child.matches && child.matches(selector));
  let html = '';
  Object.defineProperty(host, 'innerHTML', {
    get() {return html;},
    set(value) {
      html = String(value);
      host.childNodes = [];
      const pattern = /<button\b([^>]*)>/g;
      let match;
      while ((match = pattern.exec(html))) {
        const attrs = match[1];
        const className = (/class="([^"]*)"/.exec(attrs) || [])[1] || '';
        const key = (/data-issue-key="([^"]*)"/.exec(attrs) || [])[1] || '';
        const button = {
          className,
          parentElement: host,
          getAttribute(name) {return name === 'data-issue-key' ? key : null;},
          matches(selector) {
            if (selector === '.is-selected') return className.split(/\s+/).includes('is-selected');
            if (selector === '[data-issue-key]') return true;
            return false;
          },
          closest(selector) {return this.matches(selector) ? this : null;},
          focus() {document.activeElement = this;},
          after(node) {
            const at = host.childNodes.indexOf(this);
            attachNode(host, node, at + 1);
          },
        };
        host.childNodes.push(button);
      }
    },
  });
}
mountOptions(nodes.get('#admin-health-issues'));
mountOptions(nodes.get('#admin-health-wait-list'));
const healthMaster = nodes.get('.health-master');
healthMaster.childNodes = [];
healthMaster.append = function(node) {attachNode(this, node);};
healthMaster.append(nodes.get('#admin-health-detail'));
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
    if (selector === '#admin-health-issues .is-selected, #admin-health-wait-list .is-selected') return nodes.get('#admin-health-issues').querySelector('.is-selected') || nodes.get('#admin-health-wait-list').querySelector('.is-selected');
    return nodes.get(selector) || null;
  },
};
const rootClasses = new Set();
document.documentElement = {classList: {
  add(name) {rootClasses.add(name);},
  remove(name) {rootClasses.delete(name);},
  toggle(name, force) {
    const on = force === undefined ? !rootClasses.has(name) : Boolean(force);
    if (on) rootClasses.add(name);
    else rootClasses.delete(name);
    return on;
  },
  contains(name) {return rootClasses.has(name);},
}};
document.title = '';
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
const HEALTH_DESCRIPTION = 'Страница владельца: ограниченное чтение опубликованного снимка: что требует внимания и какие источники эта страница не читает. Чтение ничего не меняет.';
const CATALOG_DESCRIPTION = 'Страница владельца: поиск фильмов и людей и очереди качества по опубликованной программе. Название одного фильма и русское имя человека записываются только после подтверждения.';
function chrome() {
  return {
    title: document.title,
    health: document.documentElement.classList.contains('admin-is-health'),
    catalog: document.documentElement.classList.contains('admin-is-catalog'),
    label: attrs.get('#admin-health:aria-labelledby'),
    description: attrs.get('meta[name="description"]:content'),
  };
}
const results = nodes.get('#admin-results'), detail = nodes.get('#admin-detail'), empty = nodes.get('#admin-empty'), error = nodes.get('#admin-error'), stale = nodes.get('#admin-stale'), loading = nodes.get('#admin-loading');

// 1. Initial load with a deep link: detail from the live snapshot, the snapshot line, queue counts.
await settle();
assert.match(detail.innerHTML, /Мира Соль/);
assert.match(detail.innerHTML, /Mira Sol/);
assert.match(detail.innerHTML, /letterboxd/);
assert.match(detail.innerHTML, /wikidata/, 'provenance of the cached name');
assert.match(detail.innerHTML, /Добавить вариант/);
assert.match(detail.innerHTML, /Сделать предпочтительным/);
assert.doesNotMatch(detail.innerHTML, /Сохранить вариант/);
assert.doesNotMatch(detail.innerHTML, /id="admin-name-preferred"/);
assert.doesNotMatch(detail.innerHTML, /Использовать как предпочтительное/);
assert.match(detail.innerHTML, /«Добавить вариант» не меняет предпочтительное имя/);
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
assert.deepEqual(chrome(), {title: 'Данные каталога', health: false, catalog: true, label: 'admin-health-title', description: CATALOG_DESCRIPTION}, 'a catalogue deep link keeps the catalogue title and heading');

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
assert.match(results.innerHTML, /Одинаковый рассвет/);
assert.doesNotMatch(results.innerHTML, /tmdb:900201/);
assert.doesNotMatch(results.innerHTML, /tmdb:900202/);
assert.match(results.innerHTML, /<h3>Фильмы <small>2<\/small><\/h3>/);
assert.doesNotMatch(results.innerHTML, /Показать ещё/);
assert.equal(empty.hidden, true);
assert.equal(document.activeElement, searchNode);

// 4. Open a result, go back and forward: the detail and the search are both in the URL.
document.activeElement = document.body;
await run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
assert.equal(url().searchParams.get('id'), 'film:same-east');
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.match(detail.innerHTML, /Same Dawn East/);
assert.match(detail.innerHTML, /вне снимка программы/, 'fingerprint and prediction are shown as outside this read');
assert.match(detail.innerHTML, /<details class="admin-technical">/);
assert.doesNotMatch(detail.innerHTML, /<details class="admin-technical" open/);
const technicalAt = detail.innerHTML.indexOf('Технические сведения');
assert.ok(technicalAt > 0 && detail.innerHTML.slice(0, technicalAt).includes('tmdb:900201') === false);
assert.ok(detail.innerHTML.slice(technicalAt).includes('tmdb:900201'));
assert.equal(detail.innerHTML.slice(0, technicalAt).includes('доверенный'), false, 'trust marks stay inside the technical disclosure');
assert.match(detail.innerHTML.slice(technicalAt), /tmdb 900201 · доверенный/, 'the canonical number does not hide the trusted TMDB row');
assert.match(detail.innerHTML.slice(technicalAt), /letterboxd same-east · доверенный/);
assert.doesNotMatch(detail.innerHTML, /Внешних id нет/);
assert.doesNotMatch(detail.innerHTML, /id="admin-name-form"/, 'a film card has no person-name form');
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

// 5. Changing the search drops the open card before the debounced read and replaces this history entry.
const readsBeforeClear = requests.length;
searchNode.value = '';
run('onAdminSearch()');
assert.equal(url().searchParams.get('q'), null);
assert.equal(url().searchParams.get('id'), null);
assert.equal(url().searchParams.get('kind'), null);
assert.equal(detail.hidden, true);
assert.equal(detail.innerHTML, '');
assert.equal(requests.length, readsBeforeClear, 'the card is cleared before the debounced read');
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
assert.equal(detail.hidden, true);
assert.equal(url().searchParams.get('id'), null);
assert.match(results.innerHTML, /Введите запрос или выберите очередь/);
assert.equal(requests.length, readsBeforeClear, 'an empty catalogue reuses the held overview');
window.history.back();
await settle();
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.equal(url().searchParams.get('id'), null, 'Back returns to the search under the replaced entry');
window.history.forward();
await settle();
assert.equal(url().searchParams.get('id'), null);

// 5b. A film queue drops a selected person at once. Back restores the card that the push left behind.
document.activeElement = document.body;
await run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'person:actor/mira-sol','data-admin-kind':'person'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
assert.equal(url().searchParams.get('id'), 'person:actor/mira-sol');
assert.match(detail.innerHTML, /Мира Соль/);
requests = [];
const queuePending = run(`onAdminQueue({target:{closest(){return {getAttribute(name){return name==='data-admin-queue'?'localization-provisional':null;}};}}})`);
assert.equal(url().searchParams.get('queue'), 'localization-provisional');
assert.equal(url().searchParams.get('id'), null);
assert.equal(url().searchParams.get('kind'), null);
assert.equal(detail.hidden, true);
assert.equal(detail.innerHTML, '');
await queuePending;
await settle();
assert.equal(detail.hidden, true);
assert.match(results.innerHTML, /Тихая гавань/);
assert.equal(requests.some(request => request.path.includes('/films/film%3A') || request.path.includes('/people/person%3A')), false, 'the old card is not read again');
assert.ok(requests.some(request => request.path.split('?')[0] === '/api/admin/films'));
assert.ok(requests.every(request => request.method === 'GET'));
window.history.back();
await settle();
assert.equal(url().searchParams.get('queue'), null);
assert.equal(url().searchParams.get('id'), 'person:actor/mira-sol');
assert.match(detail.innerHTML, /Мира Соль/);

// 5c. A film-only queue still lists films, and Back restores the film the push left in history.
await run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
requests = [];
await run(`onAdminQueue({target:{closest(){return {getAttribute(name){return name==='data-admin-queue'?'identity-unresolved':null;}};}}})`);
assert.equal(url().searchParams.get('queue'), 'identity-unresolved');
assert.equal(url().searchParams.get('id'), null);
assert.match(results.innerHTML, /film:blank/);
assert.equal(detail.hidden, true);
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/films']);
window.history.back();
await settle();
assert.equal(url().searchParams.get('queue'), null);
assert.equal(url().searchParams.get('id'), 'film:same-east');
assert.match(detail.innerHTML, /Одинаковый рассвет/);

// 5d. A query with no hits, a failed read, and a late answer for the old card all leave the editor closed.
searchNode.value = 'неттакого';
run('onAdminSearch()');
assert.equal(detail.hidden, true, 'the card is gone before the empty read');
assert.equal(url().searchParams.get('id'), null);
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
assert.equal(empty.hidden, false);
assert.equal(results.innerHTML, '');
assert.equal(detail.hidden, true);
assert.equal(error.hidden, true);

await run(`onAdminResult({target:{closest(selector){return selector==='[data-admin-id]'?{getAttribute(name){return {'data-admin-id':'film:same-east','data-admin-kind':'film'}[name]||null;}}:null;}},preventDefault(){this.defaultPrevented=true;},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
assert.match(detail.innerHTML, /Одинаковый рассвет/);
records.delete('epg/published-generation.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
searchNode.value = 'маяк';
run('onAdminSearch()');
assert.equal(detail.hidden, true);
assert.equal(detail.innerHTML, '');
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
assert.equal(error.hidden, false);
assert.equal(detail.hidden, true);
assert.equal(url().searchParams.get('id'), null);
seed();
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', workerContext);
window.location.href = 'http://127.0.0.1/admin?q=одинаковый';
await run('onAdminRefresh()');
await settle();

const heldReads = [];
pauseAdminReads = () => new Promise(resolve => { heldReads.push(resolve); });
window.location.href = 'http://127.0.0.1/admin?q=одинаковый&kind=film&id=film:same-east';
const lateRead = run('adminRender()');
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(heldReads.length > 0, 'the old catalogue read is still in flight');
searchNode.value = 'маяк';
run('onAdminSearch()');
assert.equal(detail.hidden, true);
assert.equal(url().searchParams.get('id'), null);
assert.equal(url().searchParams.get('q'), 'маяк');
const releaseLate = heldReads.splice(0);
pauseAdminReads = null;
for (const release of releaseLate) release();
await lateRead;
await settle();
assert.equal(detail.hidden, true, 'the late answer does not put the old card back');
assert.equal(detail.innerHTML, '');
assert.equal(url().searchParams.get('id'), null);
await new Promise(resolve => setTimeout(resolve, 260));
await settle();
assert.equal(url().searchParams.get('q'), 'маяк');
assert.equal(url().searchParams.get('id'), null);
assert.equal(detail.hidden, true);
assert.doesNotMatch(detail.innerHTML, /Same Dawn|Одинаковый рассвет/);

// 5e. Escape clears the query and the card. On a narrow screen the results come back.
window.location.href = 'http://127.0.0.1/admin?q=мост&kind=film&id=film:blank';
await run('adminRender()');
await settle();
assert.match(detail.innerHTML, /Blank Reel/);
run(`onAdminKey({key:'Escape',target:{closest(){return null;}},preventDefault(){this.defaultPrevented=true;}})`);
assert.equal(url().searchParams.get('q'), null);
assert.equal(url().searchParams.get('id'), null);
assert.equal(detail.hidden, true);
await settle();
assert.equal(detail.hidden, true);
assert.equal(document.activeElement, searchNode);

window.matchMedia = query => ({matches: String(query).includes('800px'), addEventListener() {}, removeEventListener() {}});
window.location.href = 'http://127.0.0.1/admin?q=одинаковый&kind=person&id=person:actor/mira-sol';
await run('adminRender()');
await settle();
run('adminPlaceCatalog()');
assert.equal(nodes.get('#admin-results-section').hidden, true, 'a narrow open card hides the results');
const backPending = run('onAdminDetailBack()');
assert.equal(url().searchParams.get('id'), null);
assert.equal(detail.hidden, true);
assert.equal(nodes.get('#admin-results-section').hidden, false, 'leaving the card shows the results');
await backPending;
await settle();
assert.equal(document.activeElement, searchNode);
delete window.matchMedia;

// 5f. Closing the card keeps an unknown command on that record and does not post it.
window.location.href = 'http://127.0.0.1/admin?kind=person&id=person:actor/mira-sol';
await run('adminRender()');
await settle();
const nameCommand = {personId: 'person:actor/mira-sol', requestId: 'req-keep-name', mode: 'manual', value: 'Брюс', expectedVersion: 'name-review:1:mira', effect: 'promote'};
const titleCommand = {filmId: 'film:blank', requestId: 'req-keep-title', mode: 'manual', value: 'Пустая', expectedVersion: 'title-review:1:blank', effect: 'add_alias'};
run(`adminNameHold(${JSON.stringify(nameCommand.personId)}, ${JSON.stringify(nameCommand)})`);
run(`adminTitleHold('blank', ${JSON.stringify(titleCommand)})`);
const postsBefore = requests.filter(request => request.method !== 'GET').length;
await run(`onAdminQueue({target:{closest(){return {getAttribute(name){return name==='data-admin-queue'?'identity-unresolved':null;}};}}})`);
assert.equal(detail.hidden, true);
assert.equal(url().searchParams.get('id'), null);
assert.equal(requests.filter(request => request.method !== 'GET').length, postsBefore);
assert.equal(run(`adminNameFrozen('person:actor/mira-sol', 'req-keep-name').requestId`), 'req-keep-name');
assert.equal(run(`adminNameFrozen('person:actor/mira-sol', 'req-keep-name').value`), 'Брюс');
assert.equal(run(`adminTitleFrozen('blank', 'req-keep-title').requestId`), 'req-keep-title');
window.location.href = 'http://127.0.0.1/admin?kind=film&id=film:blank';
await run('adminRender()');
await settle();
assert.match(detail.innerHTML, /Blank Reel/);
assert.doesNotMatch(detail.innerHTML, /req-keep-name/);
assert.equal(run(`adminNameFrozen('person:actor/mira-sol', 'req-keep-name').effect`), 'promote');
window.location.href = 'http://127.0.0.1/admin?kind=person&id=person:actor/mira-sol';
await run('adminRender()');
await settle();
assert.equal(run(`adminNameFrozen('person:actor/mira-sol', 'req-keep-name').requestId`), 'req-keep-name');
assert.equal(run(`adminTitleFrozen('blank', 'req-keep-title').value`), 'Пустая');
assert.equal(requests.filter(request => request.method !== 'GET').length, postsBefore);
run('adminNameDrop()');
run('adminTitleDrop()');

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
assert.deepEqual(chrome(), {title: 'Здоровье данных', health: true, catalog: false, label: 'admin-health-page-title', description: HEALTH_DESCRIPTION}, 'the old health alias paints the health title before it is canonicalised');
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/health']);
assert.ok(requests.every(request => request.method === 'GET'));
const healthSummary = nodes.get('#admin-health-summary').innerHTML;
assert.match(healthSummary, /data-lead="act"/);
assert.match(healthSummary, /<b>Разобраться<\/b><span>[1-9]/);
assert.match(healthSummary, /Источники<\/dt><dd>прочитано [1-9] из [1-9]/);
assert.match(healthSummary, /Фильмы<\/dt>/);
assert.match(healthSummary, /Не прочитано:/);
assert.match(healthSummary, /Сводного балла нет/);
assert.doesNotMatch(healthSummary, /поколение/, 'the generation stays on the snapshot line, not in the summary paragraph');
assert.match(nodes.get('#admin-snapshot-text').textContent, /Поколение 11111111/, 'the health answer keeps the pinned snapshot line');
assert.match(html, /Ссылки открывают другую страницу админки и ничего не запускают/);
assert.ok(html.indexOf('id="admin-health-summary"') < html.indexOf('id="admin-health-kpis"') && html.indexOf('id="admin-health-kpis"') < html.indexOf('Что требует внимания') && html.indexOf('Что требует внимания') < html.indexOf('id="admin-health-detail"') && html.indexOf('Выбранная проблема') < html.indexOf('id="admin-health-detail-body"') && html.indexOf('id="admin-health-detail-body"') < html.indexOf('Штатное ожидание') && html.indexOf('Штатное ожидание') < html.indexOf('Подсистемы и источники'));
assert.match(html, /aria-labelledby="admin-health-detail-title admin-health-detail-subject"/);
assert.match(css, /\.health-detail \.health-group-title\{[^}]*font-size:22px/, 'the selected name is the panel headline');
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
const kpis = nodes.get('#admin-health-kpis').innerHTML;
assert.match(kpis, /data-critical="0"/);
assert.match(kpis, /data-warning="[1-9]/);
assert.match(kpis, /data-unknown="[1-9]/);
assert.match(kpis, /Критично/);
assert.match(kpis, /Предупреждения/);
assert.match(kpis, /Неизвестно/);
assert.match(kpis, /источников не прочитано/);
const issuesHtml = nodes.get('#admin-health-issues').innerHTML;
assert.match(issuesHtml, /role="option"/);
assert.match(issuesHtml, /Метаданные/);
assert.match(issuesHtml, /Источник не входит в это ограниченное чтение/);
assert.doesNotMatch(issuesHtml, /type="submit"|<form/, 'the queue selects a problem and does not submit a writer');
assert.doesNotMatch(issuesHtml, /Открыть фильм|Технические подробности/, 'the queue stays compact; the chosen problem carries the detail');
assert.doesNotMatch(issuesHtml, /Дальше само:/, 'routine waiting is not an incident in the queue');
const waitHtml = nodes.get('#admin-health-wait-list').innerHTML;
assert.match(waitHtml, /role="option"/);
assert.doesNotMatch(waitHtml, /Метаданные отсутствуют|Объект-источник отсутствует/);
const detailHtml = nodes.get('#admin-health-detail-body').innerHTML;
assert.match(detailHtml, /<h4 id="admin-health-detail-subject" class="health-group-title">[^<]+<\/h4>/);
assert.ok(detailHtml.indexOf('admin-health-detail-subject') < detailHtml.indexOf('health-group-why') && detailHtml.indexOf('health-group-why') < detailHtml.indexOf('Технические подробности'), 'the selected name is a heading above the reason, and the disclosure stays below it');
assert.doesNotMatch(detailHtml.slice(0, detailHtml.indexOf('health-group-why')), /film:|<\/h4>[^]*<\/h4>/);
assert.match(detailHtml, /Технические подробности/);
assert.ok(detailHtml.indexOf('health-group-why') < detailHtml.indexOf('Технические подробности'), 'the reason stays outside the technical disclosure');
assert.match(detailHtml, /Неизвестно, сколько затронуто|Обновить оценку можно кнопкой|Подтверждённого результата в этом чтении нет/);
assert.doesNotMatch(detailHtml, /На другой странице|Сейчас:/);
assert.doesNotMatch(detailHtml, /href="\/admin\/discovery|href="\/api\//);
const metadataKey = issuesHtml.split('<button').find(part => part.includes('>Метаданные<') || part.includes('Метаданные ·')).match(/data-issue-key="([^"]+)"/)[1];
const requestsBeforeSelect = requests.length;
run(`healthApplySelection(${JSON.stringify(metadataKey)})`);
assert.equal(requests.length, requestsBeforeSelect, 'choosing a problem does not read again');
const chosen = nodes.get('#admin-health-detail-body').innerHTML;
assert.notEqual(chosen.match(/<h4 id="admin-health-detail-subject" class="health-group-title">([^<]*)<\/h4>/)[1], detailHtml.match(/<h4 id="admin-health-detail-subject" class="health-group-title">([^<]*)<\/h4>/)[1], 'changing the row replaces the selected heading');
assert.match(chosen, /Метаданные отсутствуют|Обновления метаданных там нет/);
assert.match(chosen, /Открыть фильм/);
assert.match(chosen, /aria-label="Открыть фильм"/);
assert.match(chosen, /<details class="health-tech">[\s\S]*?film:/);
const issuesVisibleText = chosen.replace(/<details class="health-tech">[\s\S]*?<\/details>/g, '').replace(/<[^>]+>/g, ' ');
assert.match(issuesVisibleText, /Открыть фильм/);
assert.doesNotMatch(issuesVisibleText, /film:/, 'a stored film id is not visible text above the disclosure');
assert.match(chosen, /<details class="health-tech">[\s\S]*?film:blank/, 'the stored film id stays inside the disclosure');
assert.match(issuesVisibleText, /Неизвестно, сколько затронуто|Обновления метаданных там нет/);
assert.doesNotMatch(issuesVisibleText, /Затронуто записей: 0/);
assert.doesNotMatch(issuesVisibleText, /сведение|Эта страница ничего не выполняет|не запуск|не выполняет|сейчас недоступно/);
assert.doesNotMatch(issuesVisibleText, /(^|[^а-яё])готово([^а-яё]|$)/i);
assert.match(issuesVisibleText, /Обновления метаданных там нет/);
assert.match(nodes.get('#admin-health-issues').innerHTML, /aria-selected="true"/);
run(`onAdminHealthOptionKey({key:' ',target:{closest(sel){if(sel==='input, textarea, select')return null;if(sel==='[data-issue-key]')return {getAttribute(name){return name==='data-issue-key'?${JSON.stringify(metadataKey)}:null;}};return null;}},preventDefault(){globalThis.__healthKey=true;}})`);
assert.equal(run('globalThis.__healthKey'), true, 'Enter or Space selects the focused problem');
run(`onAdminHealthOptionKey({key:'ArrowDown',target:{closest(sel){if(sel==='input, textarea, select')return {tag:'input'};return null;}},preventDefault(){globalThis.__healthArrow=true;}})`);
assert.equal(run('typeof globalThis.__healthArrow'), 'undefined', 'arrows inside a field are not taken by the queue');
const healthDetail = nodes.get('#admin-health-detail');
const selectedInbox = nodes.get('#admin-health-issues').querySelector('.is-selected');
run('healthPlaceDetail(true)');
assert.equal(healthDetail.getAttribute('data-placement'), 'under-selected');
assert.equal(healthDetail.parentElement, nodes.get('#admin-health-issues'), 'a narrow inbox selection sits in the inbox, not beside an empty column');
assert.equal(nodes.get('#admin-health-issues').childNodes[nodes.get('#admin-health-issues').childNodes.indexOf(selectedInbox) + 1], healthDetail);
run('healthPlaceDetail(false)');
assert.equal(healthDetail.getAttribute('data-placement'), 'beside');
assert.equal(healthDetail.parentElement, nodes.get('.health-master'), 'widening puts the panel back in the second column');
const placedRequests = requests.length;
const waitKey = nodes.get('#admin-health-wait-list').innerHTML.match(/data-issue-key="([^"]+)"/)[1];
const waitRow = nodes.get('#admin-health-wait-list').querySelector('[data-issue-key]');
document.activeElement = waitRow;
run(`healthApplySelection(${JSON.stringify(waitKey)})`);
assert.equal(requests.length, placedRequests, 'choosing a waiting row does not read or write');
const repaintedWait = nodes.get('#admin-health-wait-list').querySelector('.is-selected');
assert.equal(document.activeElement, repaintedWait, 'focus follows the repainted waiting row');
assert.equal(repaintedWait.getAttribute('data-issue-key'), waitKey);
run('healthPlaceDetail(true)');
assert.equal(healthDetail.parentElement, nodes.get('#admin-health-wait-list'));
assert.equal(nodes.get('#admin-health-wait-list').childNodes[nodes.get('#admin-health-wait-list').childNodes.indexOf(repaintedWait) + 1], healthDetail, 'a narrow waiting selection is under that row, not under the inbox');
assert.match(nodes.get('#admin-health-detail-body').innerHTML, /<h4 id="admin-health-detail-subject"/);
run('healthPlaceDetail(false)');
assert.equal(healthDetail.parentElement, nodes.get('.health-master'));
run(`renderAdminHealth({health:{now:'2026-11-02T21:00:00.000Z',published:{programmeRunId:'11111111-1111-4111-8111-111111111111'},scope:{coverage:{films:'complete'},subjects:{films:1}},subsystems:{prediction:{status:'attention',evidence:'observed'}},groups:[{severity:'info',subsystem:'prediction',category:'incomplete',reason:'work_queued',subjectKind:'film',issues:1,affected:1,sample:['film:q'],action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'already_queued'},evidence:{complete:1},progress:{},freshness:{}}]},sources:{}})`);
assert.match(nodes.get('#admin-health-issues').innerHTML, /Срочных проблем нет/);
assert.equal(nodes.get('#admin-health-issues').querySelector('.is-selected'), null);
const onlyWait = nodes.get('#admin-health-wait-list').querySelector('.is-selected');
assert.ok(onlyWait, 'a waiting-only answer selects the waiting row');
run('healthPlaceDetail(true)');
assert.equal(healthDetail.parentElement, nodes.get('#admin-health-wait-list'));
assert.equal(nodes.get('#admin-health-wait-list').childNodes[nodes.get('#admin-health-wait-list').childNodes.indexOf(onlyWait) + 1], healthDetail, 'the only waiting row keeps the panel, rather than the empty inbox');
run('healthPlaceDetail(false)');
assert.equal(healthDetail.parentElement, nodes.get('.health-master'));
assert.doesNotMatch(issuesVisibleText, /На другой странице|Запись к этому готова/);
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
assert.equal(chrome().title, 'Данные каталога');
assert.equal(chrome().catalog, true);
assert.equal(chrome().health, false);
assert.match(detail.innerHTML, /Blank Reel/);
window.history.back();
await settle();
assert.equal(url().searchParams.get('view'), 'health');
assert.equal(healthNode.hidden, false);
assert.equal(chrome().title, 'Здоровье данных', 'Back restores the health title');
assert.equal(chrome().health, true);
await run(`onAdminView({target:{closest(){return {getAttribute(){return 'catalog';}};}},preventDefault(){},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
await settle();
assert.equal(url().searchParams.get('view'), null);
assert.equal(catalogNode.hidden, false);
assert.equal(chrome().title, 'Данные каталога');
assert.equal(chrome().catalog, true);
window.location.href = 'http://127.0.0.1/admin?view=health';
await run('adminRender()');
await settle();
const healthPin = run('adminHealth.pin');
etags.set('people.json', 'people-2');
await run('adminRenderHealth()');
await settle();
assert.equal(nodes.get('#admin-health-stale').hidden, false, 'a changed dictionary under the held pin is a stale answer');
assert.match(nodes.get('#admin-health-summary').innerHTML, /Разобраться/, 'the previous evaluation stays on screen');
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
const snapshotText = nodes.get('#admin-snapshot-text').textContent;
nodes.get('#admin-health-stale').hidden = false;
run(`renderAdminHealth({health:{now:'2026-11-02T21:00:00.000Z',published:{programmeRunId:'11111111-1111-4111-8111-111111111111'},scope:{programmeRunId:'11111111-1111-4111-8111-111111111111',coverage:{films:'partial'},subjects:{films:2}},subsystems:{metadata:{status:'clear_in_scope',evidence:'observed',issues:0}},groups:[]},sources:{}})`) ;
assert.equal(nodes.get('#admin-health-stale').hidden, false, 'ranking the answer does not hide the stale banner');
assert.equal(nodes.get('#admin-snapshot-text').textContent, snapshotText, 'ranking the answer does not clear the pinned snapshot line');
assert.equal(nodes.get('#admin-health-empty').hidden, false);
assert.match(nodes.get('#admin-health-empty').textContent, /Покрытие фильмов неполное/);
assert.equal(attrs.get('#admin-health-empty:data-verdict'), 'scoped');
assert.doesNotMatch(nodes.get('#admin-health-empty').textContent, /В пределах проверенного всё хорошо/);
run(`renderAdminHealth({health:{now:'2026-11-02T21:00:00.000Z',published:{programmeRunId:'11111111-1111-4111-8111-111111111111'},scope:{coverage:{films:'complete'},subjects:{films:2}},subsystems:{metadata:{status:'unknown',evidence:'not_supplied'}},groups:[]},sources:{}})`) ;
assert.match(nodes.get('#admin-health-summary').innerHTML, /<b>Недостаточно данных<\/b><span>1 подсистема/);
assert.match(nodes.get('#admin-health-summary').innerHTML, /data-lead="unknown"/);
assert.match(nodes.get('#admin-health-empty').textContent, /неизвестным, а не здоровым/);
assert.equal(attrs.get('#admin-health-empty:data-verdict'), 'unknown');
run(`renderAdminHealth({health:{now:'2026-11-02T21:00:00.000Z',published:{programmeRunId:'11111111-1111-4111-8111-111111111111'},scope:{coverage:{films:'complete'},subjects:{films:2}},subsystems:{metadata:{status:'clear',evidence:'observed'}},groups:[]},sources:{}})`) ;
assert.equal(nodes.get('#admin-health-empty').textContent, 'В пределах проверенного всё хорошо.');
assert.equal(attrs.get('#admin-health-empty:data-verdict'), 'clear');
const situation = run(`({
  unknown: healthSituation({reason:'evidence_not_supplied',category:'incomplete',progress:{},freshness:{},evidence:{}}),
  waiting: healthSituation({reason:'retry_waiting',category:'incomplete',progress:{waiting:1},freshness:{},evidence:{}}),
  stale: healthSituation({reason:'metadata_stale',category:'stale',progress:{},freshness:{stale:1},evidence:{}}),
  partial: healthSituation({reason:'metadata_partial',category:'incomplete',progress:{},freshness:{},evidence:{partial:1}}),
})`);
assert.equal(situation.unknown, 'неизвестно');
assert.equal(situation.waiting, 'ожидание');
assert.equal(situation.stale, 'устарело');
assert.equal(situation.partial, 'частично');
const links = run(`({
  poster: healthNextStep({subsystem:'poster',reason:'posters_missing',action:{suggested:'bounded_action',code:'poster_hydration',eligible:true,reason:'eligible'}}),
  archive: healthNextStep({subsystem:'letterboxd_archive',action:{suggested:'bounded_action',code:'archive_import',eligible:true,reason:'eligible'}}),
  metadata: healthNextStep({subsystem:'metadata',reason:'metadata_missing',action:{suggested:'bounded_action',code:'metadata_refresh',eligible:true,reason:'eligible'}}),
  prediction: healthNextStep({subsystem:'prediction',reason:'prediction_missing',action:{suggested:'bounded_action',code:'prediction_retry',eligible:true,reason:'eligible'}}),
  discovery: healthNextStep({subsystem:'discovery',reason:'work_pending',action:{suggested:'bounded_action',code:'discovery_retry',eligible:true,reason:'eligible'}}),
  limb: healthNextStep({subsystem:'metadata',action:{suggested:'investigate',code:'manual_review',eligible:null,reason:'evidence_incomplete'}}),
  programme: healthNextStep({subsystem:'programme',action:{suggested:'investigate',code:'check_scheduled_tasks',eligible:null,reason:'evidence_incomplete'}}),
  queue: healthNextStep({subsystem:'prediction_queue',reason:'work_queued',action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'already_queued'}}),
  retry: healthNextStep({subsystem:'prediction_queue',reason:'all_deferred_by_retry',retryAt:{earliest:'2026-11-03T00:00:00.000Z'},action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'in_backoff'}}),
  reread: healthNextStep({subsystem:'programme',reason:'projection_generation_differs',action:{suggested:'wait',code:'reread_snapshot',eligible:false,reason:'generation_changed'}}),
})`);
assert.equal(links.poster, 'На странице «Постеры» есть свой запуск со своей проверкой. Ссылка только открывает страницу. <a href="/admin/posters">Постеры</a>');
assert.doesNotMatch(links.poster, /На другой странице|Запись к этому готова|запускает|выполнит|<button/);
assert.equal(links.archive, 'На странице «Архив Letterboxd» есть свой запуск со своей проверкой. Ссылка только открывает страницу. <a href="/admin/letterboxd">Архив Letterboxd</a>');
assert.doesNotMatch(links.archive, /На другой странице|Запись к этому готова|<button/);
assert.equal(links.metadata, 'Лимб только показывает записи. Обновления метаданных там нет. Ссылка только открывает страницу. <a href="/admin/limb?subsystem=metadata">Лимб</a>');
assert.doesNotMatch(links.metadata, /На другой странице|Запись к этому готова/);
assert.equal(links.prediction, 'Лимб только показывает записи. Повтора прогноза там нет. Ссылка только открывает страницу. <a href="/admin/limb?subsystem=prediction">Лимб</a>');
assert.doesNotMatch(links.prediction, /На другой странице|Запись к этому готова/);
assert.equal(links.discovery, 'Повтор discovery делает следующий шаг пайплайна. Страницы с этим действием нет.');
assert.doesNotMatch(links.discovery, /На другой странице|href=/);
assert.equal(links.limb, 'Разобраться вручную: ручная проверка. Хватит ли данных, неизвестно. <a href="/admin/limb?subsystem=metadata">Лимб</a>');
assert.equal(links.programme, 'Разобраться вручную: проверить Scheduled Tasks. Хватит ли данных, неизвестно.');
assert.doesNotMatch(links.programme, /href=/);
assert.equal(links.queue, 'Дальше само: прогноз уже в очереди.');
assert.doesNotMatch(links.queue, /повтор прогноза|недоступно|href=/);
assert.equal(links.retry, 'Дальше само: в паузе. Ближайший повтор 03.11.2026, 01:00 Madrid.');
assert.equal(links.reread, 'Поколение сменилось. Обновить оценку можно кнопкой «Перечитать».');
assert.doesNotMatch(links.reread, /недоступно|Сейчас:/);
assert.doesNotMatch(links.poster + links.archive + links.limb, /<button/);
const rows = run(`({
  supplied: healthGroupRow({severity:'warning',subsystem:'observations',category:'incomplete',reason:'evidence_not_supplied',subjectKind:'subsystem',issues:1,affected:0,sample:['observations'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}}, '2026-11-02T21:00:00.000Z'),
  absent: healthGroupRow({severity:'warning',subsystem:'letterboxd_archive',category:'incomplete',reason:'evidence_object_missing',subjectKind:'archive',issues:1,affected:0,sample:['letterboxd'],action:{suggested:'investigate',code:'supply_evidence',eligible:false,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}}, '2026-11-02T21:00:00.000Z'),
  zero: healthGroupRow({severity:'info',subsystem:'metadata',category:'incomplete',reason:'work_pending',subjectKind:'film',issues:0,affected:0,sample:[],action:{suggested:'wait',code:'reread_snapshot',eligible:true,reason:'eligible'},evidence:{complete:1},progress:{},freshness:{}}, '2026-11-02T21:00:00.000Z'),
  film: healthGroupRow({severity:'warning',subsystem:'metadata',category:'incomplete',reason:'metadata_missing',subjectKind:'film',issues:2,affected:2,sample:['film:blank','film:other'],action:{suggested:'investigate',code:'metadata_refresh',eligible:false,reason:'identity_unverified'},evidence:{complete:2},progress:{},freshness:{}}, '2026-11-02T21:00:00.000Z'),
  queueRow: healthGroupRow({severity:'info',subsystem:'prediction_queue',category:'incomplete',reason:'work_queued',subjectKind:'queue',issues:1,affected:1,sample:['prediction-queue'],action:{suggested:'wait',code:'check_scheduled_tasks',eligible:false,reason:'already_queued'},evidence:{complete:1},progress:{},freshness:{}}, '2026-11-02T21:00:00.000Z'),
})`);
const outside = html => html.replace(/<details class="health-tech">[\s\S]*?<\/details>/g, '');
const shown = html => outside(html).replace(/<[^>]+>/g, ' ');
assert.match(shown(rows.supplied), /Неизвестно, сколько затронуто/);
assert.doesNotMatch(shown(rows.supplied), /Затронуто: 0/);
assert.match(shown(rows.absent), /Неизвестно, сколько затронуто/);
assert.doesNotMatch(shown(rows.absent), /Затронуто: 0/);
assert.match(rows.supplied, /<details[\s\S]*supply_evidence/);
assert.match(rows.absent, /<details[\s\S]*letterboxd/);
assert.doesNotMatch(shown(rows.absent), /letterboxd/);
assert.match(shown(rows.zero), /0 фильмов/);
assert.doesNotMatch(shown(rows.zero), /фильм: 0/);
assert.match(shown(rows.film), /Открыть фильм 1/);
assert.match(shown(rows.film), /Открыть фильм 2/);
assert.match(outside(rows.film), /aria-label="Открыть фильм 1 в этой проблеме"/);
assert.match(outside(rows.film), /aria-label="Открыть фильм 2 в этой проблеме"/);
assert.doesNotMatch(outside(rows.film), /aria-label="[^"]*film:/);
assert.match(outside(rows.film), /data-admin-id="film:blank"/);
assert.match(outside(rows.film), /href="\/admin\?kind=film&(?:amp;)?id=film%3Ablank"/);
assert.doesNotMatch(shown(rows.film), /film:/);
assert.match(rows.film, /<details[\s\S]*film:blank/);
assert.match(rows.film, /<details[\s\S]*film:other/);
assert.match(rows.film, /<details[\s\S]*metadata_refresh/);
assert.doesNotMatch(shown(rows.queueRow), /prediction-queue/);
assert.match(rows.queueRow, /<details[\s\S]*prediction-queue/);
assert.match(shown(rows.queueRow), /Дальше само: прогноз уже в очереди/);
assert.doesNotMatch(shown(rows.queueRow), /проверить Scheduled Tasks|сейчас недоступно/);
assert.match(rows.queueRow, /<details[\s\S]*check_scheduled_tasks/);
assert.doesNotMatch(shown(rows.film) + shown(rows.queueRow), /сведение|не выполняет|не запуск/);
const bands = run(`healthIssuesHtml([
  {severity:'warning',subsystem:'metadata',category:'incomplete',reason:'metadata_missing',subjectKind:'film',issues:1,affected:1,sample:['film:blank'],action:{suggested:'investigate',code:'metadata_refresh',eligible:false,reason:'identity_unverified'},evidence:{complete:1},progress:{},freshness:{}},
  {severity:'info',subsystem:'prediction',category:'incomplete',reason:'work_queued',subjectKind:'film',issues:1,affected:1,sample:['film:queued'],action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'already_queued'},evidence:{complete:1},progress:{waiting:1},freshness:{}},
  {severity:'info',subsystem:'discovery',category:'incomplete',reason:'work_pending',subjectKind:'subsystem',issues:1,affected:1,sample:['discovery'],action:{suggested:'wait',code:'check_scheduled_tasks',eligible:null,reason:'awaiting_progress'},evidence:{complete:1},progress:{waiting:1},freshness:{}},
  {severity:'info',subsystem:'letterboxd_archive',category:'incomplete',reason:'evidence_not_supplied',subjectKind:'archive',issues:1,affected:0,sample:['letterboxd'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}},
], '2026-11-02T21:00:00.000Z')`);
const queueHtml = bands.slice(bands.indexOf('health-queue'), bands.indexOf('health-detail-slot'));
const detailSlot = bands.slice(bands.indexOf('health-detail-slot'), bands.indexOf('health-wait-slot'));
const waitSlot = bands.slice(bands.indexOf('health-wait-slot'));
assert.match(queueHtml, /Метаданные отсутствуют/);
assert.match(queueHtml, /Источник не входит в это ограниченное чтение/);
assert.doesNotMatch(queueHtml, /Фильм стоит в очереди|Работа ожидается/);
assert.match(detailSlot, /1 фильм/);
assert.doesNotMatch(detailSlot, /уже в очереди/);
assert.match(waitSlot, /Фильм стоит в очереди/);
assert.match(waitSlot, /Работа ожидается, прогресс недавний/);
assert.doesNotMatch(waitSlot, /Метаданные отсутствуют/);
assert.equal(run(`healthBand({severity:'info',reason:'work_queued',action:{suggested:'wait',eligible:false,reason:'already_queued'}})`), 'wait');
assert.equal(run(`healthBand({severity:'warning',reason:'work_queued',action:{suggested:'wait',eligible:false,reason:'already_queued'}})`), 'act');
assert.equal(run(`healthBand({severity:'info',reason:'work_pending',action:{suggested:'wait',eligible:true,reason:'eligible'}})`), 'act');
assert.equal(run(`healthBand({severity:'info',reason:'evidence_not_supplied',action:{suggested:'investigate',eligible:null,reason:'evidence_incomplete'}})`), 'gap');
assert.equal(run(`healthBand({severity:'critical',reason:'evidence_object_missing',action:{suggested:'investigate',code:'reread_snapshot',eligible:null,reason:'evidence_incomplete'}})`), 'act');
assert.equal(run(`healthBand({severity:'warning',reason:'progress_unknown',action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'}})`), 'act');
const buried = run(`healthIssuesHtml([
  {severity:'info',subsystem:'prediction',category:'incomplete',reason:'work_queued',subjectKind:'film',issues:1,affected:1,sample:['film:q'],action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'already_queued'},evidence:{complete:1},progress:{},freshness:{}},
  {severity:'critical',subsystem:'programme',category:'incomplete',reason:'evidence_object_missing',subjectKind:'subsystem',issues:1,affected:0,sample:['programme'],action:{suggested:'investigate',code:'reread_snapshot',eligible:null,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}},
  {severity:'warning',subsystem:'prediction_queue',category:'incomplete',reason:'progress_unknown',subjectKind:'queue',issues:1,affected:4,sample:['prediction'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{partial:1},progress:{},freshness:{}},
  {severity:'info',subsystem:'letterboxd_archive',category:'incomplete',reason:'evidence_not_supplied',subjectKind:'archive',issues:1,affected:0,sample:['letterboxd'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}},
], '2026-11-02T21:00:00.000Z')`);
const buriedQueue = buried.slice(buried.indexOf('health-queue'), buried.indexOf('health-detail-slot'));
const buriedDetail = buried.slice(buried.indexOf('health-detail-slot'), buried.indexOf('health-wait-slot'));
const buriedWait = buried.slice(buried.indexOf('health-wait-slot'));
assert.ok(buriedQueue.indexOf('Программа') < buriedQueue.indexOf('Очередь прогнозов'), 'a critical missing source stays above a warning and above routine waiting');
assert.doesNotMatch(buriedQueue, /Фильм стоит в очереди/);
assert.match(buriedWait, /Фильм стоит в очереди/);
assert.match(buriedDetail, /Программа/);
assert.match(buriedDetail, /Обновить оценку можно кнопкой/);
assert.doesNotMatch(buriedDetail, /Затронуто: 4/);
assert.equal(run(`healthGroupBody({severity:'warning',subsystem:'prediction_queue',reason:'progress_unknown',subjectKind:'queue',affected:4,sample:['prediction'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{partial:1},progress:{},freshness:{},category:'incomplete'}, '2026-11-02T21:00:00.000Z').includes('Затронуто: 4 (очередь)')`), true);
assert.equal(run(`healthAffectedText({reason:'progress_unknown',subjectKind:'catalog',affected:0,evidence:{partial:1,missing:1}})`), 'Неизвестно, сколько затронуто.');
assert.equal(run(`healthAffectedText({reason:'progress_unknown',subjectKind:'queue',affected:4,evidence:{partial:1}})`), 'Затронуто: 4 (очередь).');
run(`renderAdminHealth({health:{now:'2026-11-02T21:00:00.000Z',published:{programmeRunId:'11111111-1111-4111-8111-111111111111'},scope:{coverage:{films:'complete'},subjects:{films:2}},subsystems:{prediction:{status:'attention',evidence:'observed'},letterboxd_archive:{status:'unknown',evidence:'not_supplied'}},groups:[{severity:'info',subsystem:'prediction',category:'incomplete',reason:'work_queued',subjectKind:'film',issues:1,affected:1,sample:['film:q'],action:{suggested:'wait',code:'prediction_retry',eligible:false,reason:'already_queued'},evidence:{complete:1},progress:{},freshness:{}},{severity:'info',subsystem:'letterboxd_archive',category:'incomplete',reason:'evidence_not_supplied',subjectKind:'archive',issues:1,affected:0,sample:['letterboxd'],action:{suggested:'investigate',code:'supply_evidence',eligible:null,reason:'evidence_incomplete'},evidence:{missing:1},progress:{},freshness:{}}]},sources:{letterboxd:{evidence:'not_supplied'}}})`);
const calm = nodes.get('#admin-health-summary').innerHTML;
assert.match(calm, /data-lead="calm"/);
assert.match(calm, /<b>Срочного шага нет<\/b>/);
assert.doesNotMatch(calm, /<b>Требует внимания<\/b>/);
const calmKpis = nodes.get('#admin-health-kpis').innerHTML;
assert.match(calmKpis, /data-critical="0"/);
assert.match(calmKpis, /data-warning="0"/);
assert.match(calmKpis, /data-unknown="1"/);
assert.match(nodes.get('#admin-health-issues').innerHTML, /Архив Letterboxd/);
assert.doesNotMatch(nodes.get('#admin-health-issues').innerHTML, /Фильм стоит в очереди/);
assert.match(nodes.get('#admin-health-wait-list').innerHTML, /Фильм стоит в очереди/);
nodes.get('#admin-health-stale').hidden = true;
assert.equal(url().searchParams.get('view'), 'health', 'Escape does not leave the health view');
assert.deepEqual(['1 подсистема', '3 подсистемы', '5 подсистем', '11 подсистем', '21 подсистема'], [1, 3, 5, 11, 21].map(count => run(`healthPlural(${count}, 'подсистема', 'подсистемы', 'подсистем')`)));

// 9d. Canonical health path. The alias is replaced once and is not written again. A direct /admin/health stays there.
// Switching views pushes, so Back restores the catalogue search. Ctrl-click is left to the real link.
window.location.href = 'http://127.0.0.1/admin?view=health&q=мост&queue=title_missing&kind=film&id=film:blank';
run('adminWrite(adminState(), "replace")');
assert.equal(url().pathname, '/admin/health');
assert.equal(url().searchParams.get('view'), null);
assert.equal(url().searchParams.get('q'), 'мост');
assert.equal(url().searchParams.get('queue'), 'title_missing');
assert.equal(url().searchParams.get('kind'), 'film');
assert.equal(url().searchParams.get('id'), 'film:blank');
const canonicalHealth = window.location.href;
run('adminWrite(adminState(), "replace")');
assert.equal(window.location.href, canonicalHealth, 'a second replace does not move the address');
window.location.href = 'http://127.0.0.1/admin/health?q=мост';
run('adminWrite(adminState(), "replace")');
assert.equal(url().pathname, '/admin/health');
assert.equal(url().searchParams.get('view'), null);
assert.equal(url().searchParams.get('q'), 'мост');
requests = [];
await run('adminRender()');
await settle();
assert.equal(url().pathname, '/admin/health', 'rendering a direct health URL does not rewrite it to /admin');
assert.equal(url().searchParams.get('q'), 'мост');
assert.deepEqual(chrome(), {title: 'Здоровье данных', health: true, catalog: false, label: 'admin-health-page-title', description: HEALTH_DESCRIPTION}, 'a direct /admin/health load uses the health title, heading class and description');
assert.deepEqual(requests.map(request => request.path.split('?')[0]), ['/api/admin/health']);
window.history.pushState(null, '', '/admin?q=одинаковый');
await run('onAdminHistory()');
await settle();
assert.equal(url().pathname, '/admin');
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.equal(chrome().title, 'Данные каталога', 'a catalogue history entry restores its title');
assert.equal(chrome().catalog, true);
await run(`onAdminView({target:{closest(){return {getAttribute(){return 'health';}};}},preventDefault(){},metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,button:0})`);
await settle();
assert.equal(url().pathname, '/admin/health');
assert.equal(url().searchParams.get('q'), 'одинаковый');
assert.equal(url().searchParams.get('view'), null);
assert.equal(chrome().title, 'Здоровье данных');
assert.equal(chrome().health, true);
assert.equal(attrs.get('#admin-view-health:aria-current'), 'page');
window.history.back();
await settle();
assert.equal(url().pathname, '/admin');
assert.equal(url().searchParams.get('q'), 'одинаковый', 'Back restores the catalogue search');
assert.equal(chrome().title, 'Данные каталога');
assert.equal(chrome().health, false);
assert.equal(attrs.get('#admin-view-catalog:aria-current'), 'page');
const modifiedClick = run(`(() => { const event = {target:{closest(){return {getAttribute(){return 'health';}};}},preventDefault(){this.prevented=true;},metaKey:false,ctrlKey:true,shiftKey:false,altKey:false,button:0}; const before = window.location.href; const result = onAdminView(event); return {prevented: event.prevented === true, same: window.location.href === before, untouched: result == null}; })()`);
assert.equal(modifiedClick.prevented, false);
assert.equal(modifiedClick.same, true);
assert.equal(modifiedClick.untouched, true);

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
assert.match(wall, /Добавить вариант/);
assert.match(wall, /Сделать предпочтительным/);
assert.doesNotMatch(wall, /Сохранить вариант/);
assert.doesNotMatch(wall, /Использовать как предпочтительное/);
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
const personWhen = run(`adminNameForm({id:'person:actor/bruce-willis', original:'Bruce Willis', nameReview:{version:'v', original:'Bruce Willis', preferred:{value:'Брюс Уиллис'}, options:[], collisions:[], reviews:[{at:'2026-07-01T14:53:00.000Z', mode:'manual', from:{value:'Брюс Виллис'}, to:{value:'Брюс Уиллис'}}], roleLinks:[]}})`);
assert.match(personWhen, /01\.07\.2026, 16:53 \(Мадрид\) · manual · Брюс Виллис → Брюс Уиллис/);
assert.doesNotMatch(personWhen, /2026-07-01T|Invalid Date/);
assert.match(personWhen, /<summary>Журнал<\/summary>/);
run(`adminDetail({mode:'ready', id:'north', kind:'film', entity:{id:'film:north', storedId:'north', preferred:'Северный мост', originalTitle:'North Bridge', aliases:[{value:'North Bridge', kind:'title', provenance:{source:'letterboxd'}}], titleReview:{version:'title-review:1:north', filmId:'film:north', preferred:{value:'Северный мост', status:'reviewed', source:'dictionary'}, options:[{value:'Северный мост', origin:'preferred', provenance:{source:'dictionary'}},{value:'Мост на севере', origin:'alias', provenance:{source:'dictionary'}},{value:'North Bridge', origin:'alias', provenance:{source:'letterboxd'}}], reviews:[]}, localization:{status:'reviewed', source:'dictionary'}, identity:{status:'resolved'}, externalIds:[], localizationConflicts:[]}})`);
assert.match(detail.innerHTML, /data-title-review/);
assert.match(detail.innerHTML, /data-title-add/);
assert.match(detail.innerHTML, /data-title-promote/);
assert.match(detail.innerHTML, /Добавить вариант/);
assert.match(detail.innerHTML, /Сделать предпочтительным/);
assert.doesNotMatch(detail.innerHTML, /Сохранить вариант/);
assert.doesNotMatch(detail.innerHTML, /Использовать как предпочтительное/);
assert.match(detail.innerHTML, /name="title-review-choice" value="Северный мост"/);
assert.match(detail.innerHTML, /текущее предпочтительное/);
assert.match(detail.innerHTML, /<summary>Другие названия \(1\)<\/summary>/);
assert.match(detail.innerHTML, /Мост на севере/);
assert.match(detail.innerHTML, /name="title-review-choice" value="Мост на севере"/);
assert.doesNotMatch(detail.innerHTML, /name="title-review-choice" value="North Bridge"/);
const northHtml = detail.innerHTML;
const northAlias = northHtml.indexOf('Другие названия');
const northTech = northHtml.indexOf('Технические сведения');
assert.ok(northAlias > 0 && northTech > northAlias);
assert.equal(northHtml.slice(northAlias, northTech).includes('· title'), false, 'the open film alias list is the title text');
assert.match(northHtml.slice(northTech), /· title/, 'kind stays in the technical disclosure');
assert.doesNotMatch(detail.innerHTML, /admin-folded/);
assert.doesNotMatch(detail.innerHTML, /admin-name-form/);
assert.doesNotMatch(detail.innerHTML, /Журнал|История правок/, 'an empty film audit adds no journal');
assert.ok(detail.innerHTML.indexOf('Оригинал:') < detail.innerHTML.indexOf('data-title-review') && detail.innerHTML.indexOf('data-title-review') < detail.innerHTML.indexOf('<h3>Сводка</h3>'));
run(`adminDetail({mode:'ready', id:'care', kind:'film', entity:{id:'film:mcHk', storedId:'mcHk', preferred:'Аферистка', originalTitle:'I Care a Lot', aliases:[{value:'Мошенница', provenance:{source:'programme'}},{value:'I Care a Lot', provenance:{source:'letterboxd'}}], titleReview:{version:'title-review:1:mch', filmId:'film:mcHk', preferred:{value:'Аферистка', status:'reviewed', source:'owner', authority:'owner'}, options:[{value:'Аферистка', origin:'preferred', provenance:{source:'owner', authority:'owner'}},{value:'Мошенница', origin:'alias', provenance:{source:'programme'}},{value:'I Care a Lot', origin:'original', provenance:{source:'letterboxd'}}], reviews:[{from:{value:'Аферистка', status:'provisional'}, to:{value:'Мошенница', status:'reviewed'}, at:'2026-11-01T11:23:58.438Z', basis:'Вариант перевода'},{from:{value:'Мошенница', status:'reviewed'}, to:{value:'Аферистка', status:'reviewed'}, at:'2026-11-01T14:53:34.457Z', basis:'Это и есть главный вариант'}]}, localization:{status:'reviewed', source:'owner'}, identity:{status:'resolved'}, externalIds:[{scheme:'tmdb', value:'601666', trusted:true}], localizationConflicts:[]}})`);
const journalAt = detail.innerHTML.indexOf('title-review-journal');
assert.match(detail.innerHTML, /<details class="title-review-journal"><summary>Журнал \(2\)<\/summary>/);
assert.doesNotMatch(detail.innerHTML, /<details class="title-review-journal" open/);
assert.ok(journalAt > detail.innerHTML.indexOf('Другие статусы') && journalAt > detail.innerHTML.indexOf('Технические сведения') && journalAt > detail.innerHTML.indexOf('data-title-review'));
assert.match(detail.innerHTML, /Аферистка → Мошенница · 01\.11\.2026, 12:23 \(Мадрид\) · Вариант перевода/);
assert.match(detail.innerHTML, /Мошенница → Аферистка · 01\.11\.2026, 15:53 \(Мадрид\) · Это и есть главный вариант/);
assert.doesNotMatch(detail.innerHTML, /2026-11-01T|Invalid Date/);
const journalRadios = [...detail.innerHTML.matchAll(/name="title-review-choice" value="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(journalRadios, ['Аферистка', 'Мошенница']);
run(`adminDetail({mode:'ready', id:'person:actor/mira-sol', kind:'person', entity:{id:'person:actor/mira-sol', preferred:'Мира Соль', original:'Mira Sol', aliases:[{value:'M. Sol', provenance:{source:'letterboxd'}}], localization:{status:'provisional', source:'wikidata'}, identity:{status:'resolved'}, externalIds:[], localizationConflicts:[], nameReview:{version:'name-review:1:mira', original:'Mira Sol', preferred:{value:'Мира Соль', status:'provisional', source:'wikidata'}, options:[{value:'Мира Соль', origin:'preferred', provenance:{source:'wikidata'}, preferred:true}], collisions:[{id:'person:director/mira-sol', original:'Mira Sol', reason:'same_original', version:'name-review:1:role', linked:false}], reviews:[], roleLinks:[]}}})`);
assert.match(detail.innerHTML, /id="admin-name-form"/);
assert.match(detail.innerHTML, /Добавить вариант/);
assert.match(detail.innerHTML, /Сделать предпочтительным/);
assert.match(detail.innerHTML, /Связь записывается только кнопкой «Сделать предпочтительным»/);
assert.doesNotMatch(detail.innerHTML, /Сохранить вариант/);
assert.doesNotMatch(detail.innerHTML, /id="admin-name-preferred"/);
assert.match(detail.innerHTML, /name="person-name-role"/);
assert.match(detail.innerHTML, /admin-folded/);
assert.match(detail.innerHTML, /<summary>Другие имена \(1\)<\/summary>/);
assert.doesNotMatch(detail.innerHTML, /data-title-review/);
assert.doesNotMatch(detail.innerHTML, /title-review-journal/);
assert.doesNotMatch(detail.innerHTML, /Записать название/);
assert.match(css, /\.admin-technical summary/);
assert.match(css, /\.title-review-journal summary/);
run(`(() => {
  const previous = adminLive.queues;
  adminLive.queues = [{code:'localization-missing', kind:'film', count:0}, {code:'localization-missing', kind:'person', count:0}];
  adminRenderQueues({q:'', queue:'', kind:'', id:''});
  globalThis.__zeroQueues = document.querySelector('#admin-queues').innerHTML;
  adminLive.queues = [{code:'localization-missing', kind:'film', count:0}];
  adminRenderQueues({q:'', queue:'localization-missing', kind:'film', id:''});
  globalThis.__activeZero = document.querySelector('#admin-queues').innerHTML;
  adminLive.queues = null;
  adminRenderQueues({q:'', queue:'', kind:'', id:''});
  globalThis.__unreadQueues = document.querySelector('#admin-queues').innerHTML;
  adminLive.queues = previous;
  adminRenderQueues(adminState());
})()`);
assert.match(run('__zeroQueues'), /Нет записей в очередях/);
assert.doesNotMatch(run('__zeroQueues'), /admin-queue"/);
assert.match(run('__activeZero'), /data-admin-queue="localization-missing"/);
assert.match(run('__activeZero'), /фильмы · 0/);
assert.equal(run('__unreadQueues'), '');
assert.ok((listeners.get('#admin-detail') || []).some(item => item.type === 'submit' && item.fn === run('onAdminNameSubmit')));
console.log('Admin shell: live snapshot, URL state, history, pagination, empty, error, stale-pin and health view states passed');
