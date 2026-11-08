// The /admin/limb page on the live route: the page bundle runs against a DOM stand-in and its fetch goes to the Worker bundle
// over an R2 stand-in. Covers the filter state in the URL, history, pagination under the pin, and the states the owner must
// tell apart: empty, error, stale snapshot, unavailable observations.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const html = fs.readFileSync('public/admin-limbo.html', 'utf8');
const page = fs.readFileSync('public/return-home.js', 'utf8') + '\n' + fs.readFileSync('public/admin-limbo.js', 'utf8');
const client = fs.readFileSync('src/admin/client.js', 'utf8');
const limboClient = fs.readFileSync('src/admin/limbo-client.js', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const shell = fs.readFileSync('public/admin.html', 'utf8');
const bundle = bundleAdmin([client, limboClient, fs.readFileSync('src/admin/prediction-recovery-view.js', 'utf8'), fs.readFileSync('src/admin/discovery-recovery-view.js', 'utf8'), page]);

// Static boundary: reads go through the client; the two write methods are the guarded discovery posts on their own
// route; no token, no other API, no generic action button.
assert.match(html, /ЧТЕНИЕ И ДЕЙСТВИЯ С ПОДТВЕРЖДЕНИЕМ/);
for (const id of ['limbo-snapshot-text', 'limbo-causes', 'limbo-subsystems', 'limbo-form', 'limbo-kind', 'limbo-age', 'limbo-reset', 'limbo-loading', 'limbo-stale', 'limbo-refresh', 'limbo-error', 'limbo-empty', 'limbo-results', 'limbo-total', 'limbo-context-body', 'limbo-coverage', 'limbo-coverage-title', 'limbo-coverage-text', 'limbo-find', 'limbo-find-note']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.ok(html.indexOf('id="limbo-mode-now"') < html.indexOf('id="limbo-verdict"') && html.indexOf('id="limbo-verdict"') < html.indexOf('id="limbo-results"') && html.indexOf('id="limbo-results"') < html.indexOf('id="limbo-find"') && html.indexOf('id="limbo-find"') < html.indexOf('id="limbo-causes"'), 'the verdict and the queue sit above the filters');
assert.match(html, /id="limbo-focus"/);
assert.match(html, /id="limbo-focus-body"/);
assert.match(html, /<summary>Снимок и дополнительные фильтры<\/summary>/);
assert.match(html, /<label class="limbo-field limbo-find-field" for="limbo-find">Найти запись/);
assert.match(html, /<div id="limbo-causes" class="limbo-causes" role="group" aria-label="Причины">/);
assert.match(html, /id="limbo-mode-now"[^>]*aria-pressed="true">Требует моего внимания/);
assert.match(html, /id="limbo-mode-all"[^>]*aria-pressed="false">Все состояния/);
assert.match(html, /id="limbo-causes-all">Все причины/);
assert.match(html, /id="limbo-causes-none">Снять выбор/);
assert.doesNotMatch(html, /class="limbo-primary"/);
assert.match(html, /id="limbo-refresh"[^>]*>Обновить</);
assert.doesNotMatch(html.slice(html.indexOf('id="limbo-stale"'), html.indexOf('id="limbo-error"')), /limbo-refresh/);
assert.match(html, /Discovery, TMDB и синхронизация не запускаются/);
assert.match(html, /<summary>Контекст конвейера и пороги<\/summary>/);
assert.match(html, /<h2 id="limbo-focus-title">Выбранная запись<\/h2>/);
assert.match(html, /<script src="\/admin-limbo\.js"><\/script>/);
assert.match(html, /href="\/admin"/);
assert.match(shell, /<nav class="admin-views"[^>]*>.*<a href="\/admin\/limb" id="admin-view-limbo" data-return-carry>Лимб<\/a>.*<\/nav>/, 'the admin sections link to the inventory');
assert.match(html, /<a href="\/admin\/limb" aria-current="page" data-return-carry>Лимб<\/a>/, 'the inventory is the current section on its own page');
assert.match(html, /<title>Лимб данных<\/title>/);
assert.match(html, /brand-sub">\/ лимб</);
assert.match(html, /<h1>Лимб данных<\/h1>/);
const limbHeading = html.indexOf('<h1>Лимб данных</h1>');
const limbNav = html.indexOf('<nav class="admin-views"');
const limbSnapshot = html.indexOf('id="limbo-snapshot"');
const limbVerified = html.indexOf('class="obs-verified-open"');
const limbCauses = html.indexOf('id="limbo-causes"');
const limbResults = html.indexOf('id="limbo-results"');
const limbSubsystems = html.indexOf('id="limbo-subsystems"');
assert.ok(limbHeading >= 0 && limbHeading < limbNav && limbNav < limbResults && limbResults < limbCauses && limbCauses < limbSnapshot && limbSnapshot < limbSubsystems && limbSubsystems < limbVerified, 'the queue sits under the nav and above the filters, and the verified key sits after the extra filters');
for (const id of ['verified-open-title', 'verified-key', 'verified-open', 'verified-open-hint', 'verified-panel', 'limbo-verified']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.match(html, /<summary>Технический поиск проверенного совпадения<\/summary>/);
assert.doesNotMatch(html, /<details[^>]*\bopen\b/, 'the verified search stays closed');
assert.doesNotMatch(html, /В лимбе ничего нет/);
assert.match(page, /Требует моего решения/);
assert.match(page, /Ожидает автоматическую обработку/);
assert.match(page, /Не удалось проверить/);
assert.match(css, /\.limbo-select\{[^}]*min-height:44px/);
assert.match(css, /#limbo-find,#limbo-causes\{min-height:44px\}/);
assert.match(css, /\.limbo-find-field\{flex:1 1 18rem\}/);
assert.match(css, /\.limbo-cause-field\{flex:0 1 16rem\}/);
assert.match(css, /\.limbo-item\[hidden\],\.limbo-queue\[hidden\]\{display:none\}/);
assert.match(css, /@media\(max-width:800px\)\{\.limbo-head\{align-items:stretch\}/);
assert.match(css, /\.limbo-modes button\[aria-pressed=true\]\{[^}]*border-color:var\(--lime\)/);
assert.match(css, /\.limbo-cause\[aria-pressed=false\]\{[^}]*color:var\(--muted\)/);
assert.match(css, /\.limbo-queue\{/);
assert.match(html, /action="\/admin\/limb"/);
assert.doesNotMatch(html, /Лимбо|лимбо/);
assert.doesNotMatch(html, /fetch\(|\/api\/|programme\.json/);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the client');
assert.doesNotMatch(bundle, /\/api\/enrichment|\/api\/sync|\/mcp|localStorage|sessionStorage|Authorization|Bearer|method:\s*['"](?:PUT|PATCH|DELETE)/);
assert.deepEqual([...bundle.matchAll(/method:\s*['"]POST/g)].length, 2, 'two write methods');
assert.equal([...bundle.matchAll(/fetchImpl\(ADMIN_API\+'\/discovery-recovery\/'\+path,\{method:'POST'/g)].length, 2, 'both go to the discovery action route only');
assert.doesNotMatch(page, /Повторить<|retry\(|data-limbo-action/, 'no action button: retries are another card');
assert.match(css, /\.limbo-facts/);
assert.match(css, /\.limbo-actions\{display:flex;flex-wrap:wrap;[^}]*min-width:0/);
assert.match(css, /\.limbo-actions \.limbo-recovery-open\{display:inline-flex/);
assert.match(css, /@media\(max-width:800px\)\{\.limbo-facts div\{grid-template-columns:minmax\(0,1fr\)/);
assert.match(css, /@media\(max-width:800px\)\{[\s\S]*?\.limbo-actions\{flex-direction:column;align-items:stretch\}/);
const limboVisible = html => html.replace(/<details class="limbo-tech">[\s\S]*?<\/details>/g, '');

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
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), workerContext);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), workerContext);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), workerContext);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), workerContext);
vm.runInContext(scoped('src/domain/admin-actions.js', 'AdminActions'), workerContext);
vm.runInContext(scoped('src/domain/discovery-identity-review.js', 'DiscoveryIdentity'), workerContext);
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
const nodes = new Map(['#limbo-snapshot-text', '#limbo-causes', '#limbo-subsystems', '#limbo-form', '#limbo-kind', '#limbo-age', '#limbo-reset', '#limbo-loading', '#limbo-stale', '#limbo-stale-text', '#limbo-refresh', '#limbo-error', '#limbo-empty', '#limbo-results', '#limbo-total', '#limbo-context-body', '#verified-open', '#verified-key', '#verified-panel', '#verified-open-hint', '#limbo-coverage', '#limbo-coverage-title', '#limbo-coverage-text', '#limbo-coverage-line', '#limbo-find', '#limbo-find-note', '#limbo-find-form', '#limbo-focus-empty', '#limbo-mode-now', '#limbo-mode-all', '#limbo-causes-all', '#limbo-causes-none', '#limbo-action-count', '#limbo-verdict', '#limbo-freshness', '#limbo-freshness-text', '#limbo-filters-panel'].map(selector => [selector, element(selector)]));
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
assert.equal(url().pathname, '/admin/limb', 'the old page path is replaced once on boot');
assert.equal(url().searchParams.get('cause'), 'stalled');
const canonicalLimb = window.location.href;
run('limboWrite(limboState(), "replace")');
assert.equal(window.location.href, canonicalLimb, 'a second replace does not move the address');
assert.deepEqual(requests.map(request => [request.method, request.path.split('?')[0], request.credentials]), [['GET', '/api/admin/limbo', 'same-origin']]);
assert.match(requests[0].path, /cause=stalled/);
assert.match(requests[0].path, /limit=25/);
assert.match(results.innerHTML, /Застрявший/);
assert.match(results.innerHTML, /Застряло/);
assert.match(results.innerHTML, /20 дн\./, 'the age is shown');
assert.match(results.innerHTML, /последний переход 10\.10\.2026/);
assert.match(results.innerHTML, /нет прогресса дольше порога/);
assert.match(limboVisible(results.innerHTML), /Дальше никто не назначен\. Разбор прогноза объясняет состояние/);
assert.match(limboVisible(results.innerHTML), /Что произошло/);
assert.match(limboVisible(results.innerHTML), /Кто дальше/);
assert.match(limboVisible(results.innerHTML), /<b>Итог\.<\/b>/);
assert.match(limboVisible(results.innerHTML), /Кнопка ниже только читает объяснение прогноза\. Записи для этого фильма на странице нет/);
assert.doesNotMatch(limboVisible(results.innerHTML), /Действие для этой записи допустимо|просит подтверждение/);
assert.match(results.innerHTML, /<h3 class="limbo-detail-title" tabindex="-1">Застрявший <span class="admin-hit-meta">2020 · фильм<\/span><\/h3>/);
assert.match(results.innerHTML, /data-limbo-jump="[^"]+" aria-controls="limbo-detail-[^"]+">К объяснению: Застрявший<\/button>/);
assert.match(results.innerHTML, /data-limbo-jump="[^"]+" aria-controls="limbo-detail-[^"]+" hidden>К объяснению:/);
assert.doesNotMatch(limboVisible(results.innerHTML), /Требует моего решения/);
assert.doesNotMatch(limboVisible(results.innerHTML), /не применимо|недопустимо|Identity Review|admin-status-plain/);
assert.match(results.innerHTML, /href="\/admin\?kind=film&amp;id=film%3Astuck"/, 'a link to the film detail');
assert.match(results.innerHTML, /доверенная идентичность tmdb:1/);
assert.doesNotMatch(results.innerHTML, /Позже/, 'a valid backoff is not stalled');
assert.equal(nodes.get('#limbo-total').textContent, '2');
assert.match(results.innerHTML, /фильм каталога \(вне программы\)/);
assert.match(results.innerHTML, /Фильма нет в опубликованной программе: карточки в каталоге данных для него нет\./, 'the missing link is explained');
assert.equal((results.innerHTML.match(/Открыть в каталоге данных/g) || []).length, 1, 'only the programme film links to the catalogue');
assert.match(nodes.get('#limbo-snapshot-text').textContent, /Поколение 11111111/);
assert.match(nodes.get('#limbo-snapshot-text').textContent, /очередь прогнозов от 30\.10\.2026/);
assert.match(nodes.get('#limbo-causes').innerHTML, /data-limbo-cause="stalled"[^>]*aria-pressed="true"/);
assert.match(nodes.get('#limbo-causes').innerHTML, /data-limbo-cause="backoff"[^>]*aria-pressed="false"/);
assert.match(nodes.get('#limbo-causes').innerHTML, /Ждёт по backoff/);
assert.equal(nodes.get('#limbo-mode-all').getAttribute('aria-pressed'), 'true');
assert.match(results.innerHTML, /data-limbo-queue="stalled"/);
assert.match(results.innerHTML, /Обычный шаг не назначен\. Результата нет/);
assert.match(results.innerHTML, /data-limbo-select=/);
assert.match(results.innerHTML, /aria-expanded="true"/);
assert.equal(nodes.get('#limbo-coverage').getAttribute('data-coverage'), 'unavailable');
assert.match(nodes.get('#limbo-coverage-title').textContent, /Наблюдения не проверены/);
assert.match(nodes.get('#limbo-coverage-text').textContent, /индекса наблюдений для опубликованного поколения ещё нет/);
assert.match(nodes.get('#limbo-coverage-text').textContent, /Фильмы в этом чтении:/);
assert.equal(nodes.get('#limbo-refresh').hidden, false);
assert.doesNotMatch(results.innerHTML, /Нерешённые наблюдения EPG недоступны/, 'the coverage banner, not the queue, carries the index gap');
assert.doesNotMatch(results.innerHTML, /В лимбе ничего нет/);
requests = [];
await listeners.get('#limbo-refresh').find(item => item.type === 'click').fn();
await settle();
assert.equal(requests.length, 1);
assert.equal(requests[0].method, 'GET');
assert.doesNotMatch(requests[0].path, /(?:^|[?&])(?:q|pin)=/);
assert.match(requests[0].path, /\/api\/admin\/limbo/);
assert.equal(stale.hidden, true);
assert.match(nodes.get('#limbo-coverage-title').textContent, /Наблюдения не проверены/);
assert.match(nodes.get('#limbo-context-body').innerHTML, /Нерешённые наблюдения EPG недоступны: индекса наблюдений для опубликованного поколения ещё нет/, 'observations are honestly unavailable');
assert.match(nodes.get('#limbo-context-body').innerHTML, /неизвестны, а не здоровы/);
assert.equal(loading.hidden, true); assert.equal(error.hidden, true); assert.equal(stale.hidden, true); assert.equal(empty.hidden, true);
const heldPin = run('limboLive.pin');
assert.match(heldPin, /^L2\|/);

// 2. Pressing another cause keeps the first: the selection is an OR, the request sends the held pin, and the added row says it is a normal wait.
requests = [];
await run(`onLimboCauseToggle('backoff')`);
assert.deepEqual(url().searchParams.getAll('causes').sort(), ['backoff', 'stalled']);
assert.match(requests[0].path, /pin=/);
assert.match(results.innerHTML, /Позже/);
assert.match(results.innerHTML, /повтор назначен и ещё не наступил/);
assert.match(results.innerHTML, /parse_error/);
assert.match(results.innerHTML, /Ожидает автоматическую обработку/);
assert.match(results.innerHTML, /<b>Итог\.<\/b> Итога ещё нет\./);
assert.match(limboVisible(results.innerHTML), /Дальше система, в уже назначенное время/);
assert.match(results.innerHTML, /<details class="limbo-tech">[\s\S]*недопустимо \(идёт backoff\)/);
assert.doesNotMatch(limboVisible(results.innerHTML), /недопустимо|parse_error/);

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

// 5. The bare URL is the attention queue. With no readable index it does not pretend the films are actions, and it does not drop the register: «Все состояния» still pages it.
requests = [];
window.location.href = 'http://127.0.0.1/admin/limbo';
await run('limboRender()');
await settle();
assert.match(requests.at(-1).path, /attention=now/);
assert.match(empty.innerHTML, /Подтверждённых действий нет/);
assert.match(empty.innerHTML, /не значит, что проблем нет/);
assert.match(nodes.get('#limbo-verdict').textContent, /Не удалось проверить доступные действия/);
assert.match(nodes.get('#limbo-coverage-line').textContent, /Наблюдения не проверены/);
const unreadCopy = run(`limboEmptyCopy({attention:{checked:false,reason:'coordination_status'}},{attention:'now'})`);
assert.equal(unreadCopy.title, 'Подтверждённых действий нет');
assert.match(unreadCopy.text, /состояние discovery не прочитано/);
assert.match(unreadCopy.text, /не значит, что проблем нет/);
assert.equal(results.innerHTML, '');
assert.equal(nodes.get('#limbo-mode-now').getAttribute('aria-pressed'), 'true');
// Pagination under the pin, in the full register: 30 films without metadata plus the two prediction items, 25 then the rest.
requests = [];
window.location.href = 'http://127.0.0.1/admin/limbo?attention=all';
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
const queueIds = [...results.innerHTML.matchAll(/<section class="limbo-queue" data-limbo-queue="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(queueIds, ['owner', 'stalled', 'automatic', 'unverified'].filter(id => queueIds.includes(id)), 'later pages join the existing queues in order: ' + queueIds.join(','));
assert.equal(new Set(queueIds).size, queueIds.length, 'each queue heading exists once');
assert.doesNotMatch(results.innerHTML, /data-limbo-more="items"/, 'the last page removes the button');
assert.doesNotMatch(results.innerHTML, /href="\/admin\?kind=film&amp;id=film%3Atmdb/, 'no catalogue link for a film outside the programme');

// 5b. The title field filters rows already painted, including a later page, and never sends a query.
window.location.href = 'http://127.0.0.1/admin/limb?attention=all';
await run('limboRender()');
await settle();
assert.match(results.innerHTML, /data-limbo-more="items"/);
const beforeFind = requests.length;
nodes.get('#limbo-find').value = 'нет такого названия';
await listeners.get('#limbo-find').find(item => item.type === 'input').fn({preventDefault() {}});
assert.equal(requests.length, beforeFind, 'typing in the title field sends no request');
assert.doesNotMatch(requests.map(request => request.path).join('\n'), /(?:^|[?&])q=/);
const hiddenMiss = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="[^"]+"( hidden)?>[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)];
assert.ok(hiddenMiss.length >= 25);
assert.ok(hiddenMiss.every(match => match[1] === ' hidden'));
assert.match(nodes.get('#limbo-find-note').textContent, /Показать ещё/);
assert.match(nodes.get('#limbo-find-note').textContent, /не поиск по всему списку/);
assert.match(nodes.get('#limbo-focus-empty').textContent, /Среди показанных строк совпадений нет\. Это не весь список/);
assert.match(results.innerHTML, /data-limbo-more="items"/);
await run('onLimboMore()');
await settle();
assert.equal(requests.length, beforeFind + 1);
assert.doesNotMatch(requests.at(-1).path, /(?:^|[?&])q=/);
const stillHidden = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="[^"]+"( hidden)?>[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)];
assert.ok(stillHidden.length > hiddenMiss.length, 'the next page is painted and then filtered');
assert.ok(stillHidden.every(match => match[1] === ' hidden'));
nodes.get('#limbo-find').value = 'Застрявший';
run('onLimboFind()');
const found = [...results.innerHTML.matchAll(/<article class="admin-hit limbo-item" data-limbo-item="[^"]+"( hidden)?>[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)];
assert.ok(found.some(match => !match[1] && match[2] === 'Застрявший'));
assert.ok(found.filter(match => match[2] !== 'Застрявший').every(match => match[1] === ' hidden'));
assert.equal(requests.length, beforeFind + 1);
const expandedStuck = [...results.innerHTML.matchAll(/aria-expanded="true"[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)].map(match => match[1]);
assert.deepEqual(expandedStuck, ['Застрявший']);
nodes.get('#limbo-find').value = 'Позже';
const focusBefore = document.activeElement;
run('onLimboFind()');
const expandedLater = [...results.innerHTML.matchAll(/aria-expanded="true"[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)].map(match => match[1]);
assert.deepEqual(expandedLater, ['Позже'], 'a different visible title becomes the explanation');
assert.equal(document.activeElement, focusBefore, 'the title field keeps focus');
assert.equal(requests.length, beforeFind + 1);
const findKey = {closest() {return null;}};
document.activeElement = findKey;
let findKeyPrevented = false;
listeners.get('#limbo-results').find(item => item.type === 'keydown').fn({key: 'ArrowDown', target: findKey, preventDefault() {findKeyPrevented = true;}});
assert.equal(findKeyPrevented, false);
nodes.get('#limbo-find').value = '';
run('onLimboFind()');
assert.doesNotMatch(results.innerHTML, /<article class="admin-hit limbo-item"[^>]* hidden>/);

// 6. Empty is not an error: no observation is listed, and the page says why that is not a verdict.
window.location.href = 'http://127.0.0.1/admin/limbo?kind=observation';
await run('limboRender()');
await settle();
assert.equal(empty.hidden, false);
assert.equal(error.hidden, true);
assert.equal(results.innerHTML, '');
assert.match(empty.innerHTML, /Нельзя подтвердить, что записей нет/);
assert.match(empty.innerHTML, /индекса наблюдений для опубликованного поколения ещё нет/);
assert.doesNotMatch(empty.innerHTML, /В лимбе ничего нет/);

// 7. A changed pin on a filter read is one bounded retry without the old pin. The new list replaces the old one.
// An etag change that does not change a film's diagnostic state is not a freshness warning.
window.location.href = 'http://127.0.0.1/admin/limbo?cause=stalled';
await run('limboRender()');
await settle();
assert.match(results.innerHTML, /Застрявший/);
etags.set('enrichment/prediction-queue.json', 'queue-2');
window.location.href = 'http://127.0.0.1/admin/limbo?cause=backoff';
requests = [];
await run('limboRender()');
await settle();
assert.equal(requests.length, 2, 'a stale pin is retried once');
assert.match(requests[0].path, /pin=/);
assert.doesNotMatch(requests[1].path, /(?:^|[?&])pin=/);
assert.equal(stale.hidden, true);
assert.equal(error.hidden, true);
assert.match(results.innerHTML, /Позже/);
assert.doesNotMatch(results.innerHTML, /Застрявший/);
assert.equal(nodes.get('#limbo-freshness').hidden, true);
assert.notEqual(run('limboLive.pin'), heldPin);
await run('globalThis._loadLimboLive = loadLimboLive; loadLimboLive = (state, options) => options && options.pin ? Promise.resolve({mode:\'stale\', error:\'stale_pin\'}) : Promise.resolve({mode:\'error\', error:\'storage_unavailable\'})');
await run('limboRender()');
await settle();
assert.equal(results.innerHTML, '', 'a failed retry does not keep the previous rows');
assert.equal(stale.hidden, false);
assert.match(nodes.get('#limbo-stale-text').textContent, /не удалось перечитать/);
assert.match(nodes.get('#limbo-verdict').textContent, /Список недоступен/);
assert.match(nodes.get('#limbo-verdict').textContent, /не проверены/);
assert.equal(run('limboLive.pin'), null, 'a failed retry drops the old pin');
await run('loadLimboLive = globalThis._loadLimboLive');

// 8. Error: no published programme; no results, no fallback.
records.delete('epg/published-generation.json');
vm.runInContext('ADMIN_SNAPSHOT_CACHE=null;ADMIN_LIMBO_CACHE=null', workerContext);
await run('onLimboRefresh()');
await settle();
assert.equal(error.hidden, false);
assert.match(error.textContent, /Опубликованная программа сейчас недоступна/);
assert.equal(results.innerHTML, '');
assert.equal(loading.hidden, true);

// 9. Keyboard: Escape in the title field is local. Escape outside a field, and reset, clear the server filter and the title.
seed();
window.location.href = 'http://127.0.0.1/admin/limbo?cause=stalled';
await run('limboRender()');
await settle();
const key = windowListeners.find(item => item.type === 'keydown').fn;
const findInput = nodes.get('#limbo-find');
findInput.value = 'Застрявший';
run('onLimboFind()');
const searchCauseRequests = requests.length;
document.activeElement = findInput;
let findEscapePrevented = false;
key({key: 'Escape', target: findInput, preventDefault() {findEscapePrevented = true;}});
assert.equal(findEscapePrevented, true);
assert.equal(findInput.value, '');
assert.equal(document.activeElement, findInput, 'Escape in the title field keeps focus there');
assert.equal(url().searchParams.get('cause'), 'stalled', 'Escape in the title field leaves the server cause');
assert.equal(requests.length, searchCauseRequests, 'Escape in the title field sends no request');
assert.doesNotMatch(results.innerHTML, /<article class="admin-hit limbo-item"[^>]* hidden>/);
const expandedAfterEscape = [...results.innerHTML.matchAll(/aria-expanded="true"[\s\S]*?<span class="admin-hit-title">([^<]+)<\/span>/g)].map(match => match[1]);
assert.deepEqual(expandedAfterEscape, ['Застрявший']);
findInput.value = 'Застрявший';
run('onLimboFind()');
let ageEscapePrevented = false;
key({key: 'Escape', target: {tagName: 'INPUT', type: 'number'}, preventDefault() {ageEscapePrevented = true;}});
assert.equal(ageEscapePrevented, false, 'Escape in another field does not take the server shortcut');
assert.equal(findInput.value, 'Застрявший');
assert.equal(url().searchParams.get('cause'), 'stalled');
assert.equal(requests.length, searchCauseRequests);
let outsidePrevented = false;
key({key: 'Escape', target: document.body, preventDefault() {outsidePrevented = true;}});
assert.equal(outsidePrevented, true);
assert.equal(findInput.value, '', 'Escape outside a field clears the local title with the server filter');
assert.equal(url().search, '');
await settle();
assert.equal(requests.length, searchCauseRequests + 1);
assert.equal(requests.at(-1).method, 'GET');
assert.doesNotMatch(requests.at(-1).path, /(?:^|[?&])(?:q|cause)=/);
assert.doesNotMatch(results.innerHTML, /<article class="admin-hit limbo-item"[^>]* hidden>/);
window.location.href = 'http://127.0.0.1/admin/limb';
await run('limboRender()');
await settle();
findInput.value = 'нет такого названия';
run('onLimboFind()');
const localOnlyRequests = requests.length;
await listeners.get('#limbo-reset').find(item => item.type === 'click').fn();
assert.equal(findInput.value, '');
assert.equal(requests.length, localOnlyRequests, 'reset with only a local title sends no request');
assert.equal(url().search, '');
assert.doesNotMatch(results.innerHTML, /<article class="admin-hit limbo-item"[^>]* hidden>/);
window.location.href = 'http://127.0.0.1/admin/limbo?cause=stalled';
await run('limboRender()');
await settle();
findInput.value = 'Застрявший';
run('onLimboFind()');
const resetRequests = requests.length;
await listeners.get('#limbo-reset').find(item => item.type === 'click').fn();
await settle();
assert.equal(findInput.value, '');
assert.equal(url().search, '');
assert.equal(requests.length, resetRequests + 1, 'reset of a server cause is one GET');
assert.doesNotMatch(requests.at(-1).path, /(?:^|[?&])q=/);
assert.doesNotMatch(results.innerHTML, /<article class="admin-hit limbo-item"[^>]* hidden>/);

assert.ok(requests.every(request => request.method === 'GET' && request.path.startsWith('/api/admin/limbo')), JSON.stringify(requests));
window.location.href = 'http://127.0.0.1/admin/limbo?kind=film&subsystem=metadata&cause=backoff&age=3';
run('limboWrite(limboState(), "replace")');
assert.equal(url().pathname, '/admin/limb');
assert.equal(url().search, '?kind=film&subsystem=metadata&cause=backoff&age=3');
window.location.href = 'http://127.0.0.1/admin/limb?cause=stalled';
run('limboWrite(limboState(), "replace")');
assert.equal(url().pathname, '/admin/limb');
assert.equal(url().searchParams.get('cause'), 'stalled');

// 10. Empty copy follows the observation index. A gap is not an empty limb; a film-only filter can still be an empty filter.
const showEmpty = (observations, kind) => run(`limboShow({mode:'ready', items:[], total:0, coverage:{films:'partial', filmsObserved:0, observations:${JSON.stringify(observations)}}, context:[], unread:[]}, {kind:'${kind}', subsystem:'', cause:'', age:''})`);
await showEmpty({available: true, state: 'stale', complete: true, indexed: 3, omitted: {}, awaitingFirstLookup: 0, writtenAt: '2026-10-01T00:00:00.000Z'}, '');
assert.match(empty.innerHTML, /Нельзя подтвердить, что записей нет/);
assert.match(empty.innerHTML, /Индекс наблюдений устарел/);
assert.equal(nodes.get('#limbo-coverage').getAttribute('data-coverage'), 'stale');
assert.match(nodes.get('#limbo-coverage-title').textContent, /Индекс наблюдений устарел/);
assert.match(nodes.get('#limbo-coverage-text').textContent, /В индексе 3/);
assert.doesNotMatch(empty.innerHTML, /В лимбе ничего нет/);
await showEmpty({available: true, state: 'fresh', complete: false, indexed: 4, omitted: {cap: 1, oversized: 0, malformed: 0}, awaitingFirstLookup: 2, writtenAt: '2026-10-01T00:00:00.000Z'}, 'observation');
assert.match(empty.innerHTML, /Индекс наблюдений частичный/);
assert.equal(nodes.get('#limbo-coverage').getAttribute('data-coverage'), 'partial');
assert.match(nodes.get('#limbo-coverage-title').textContent, /Наблюдения проверены частично/);
assert.match(nodes.get('#limbo-coverage-text').textContent, /В индексе 4/);
assert.match(nodes.get('#limbo-coverage-text').textContent, /ждут первой проверки 2/);
await showEmpty({available: true, state: 'fresh', complete: true, indexed: 0, omitted: {}, awaitingFirstLookup: 0}, 'film');
assert.match(empty.innerHTML, /По этому фильтру записей нет/);
assert.equal(nodes.get('#limbo-coverage').getAttribute('data-coverage'), 'fresh');
assert.match(nodes.get('#limbo-coverage-title').textContent, /Индекс наблюдений прочитан/);
assert.doesNotMatch(empty.innerHTML, /В лимбе ничего нет/);
await run(`limboShow({mode:'ready', items:[], total:0, coverage:{films:'partial', filmsObserved:2}, context:[], unread:[]}, {kind:'', subsystem:'', cause:'', age:''})`);
assert.equal(nodes.get('#limbo-coverage').getAttribute('data-coverage'), 'unknown');
assert.match(nodes.get('#limbo-coverage-title').textContent, /Покрытие не прочитано/);

// 11. The three sentences name a terminal stop, a collision and a stale projection. The raw terminal code stays out of the result line.
const sample = (extra) => run(`limboResultLine(${JSON.stringify(extra)})`);
assert.match(sample({cause: 'manual_review', reason: 'terminal_without_resolution', diagnostics: {terminalReason: 'no_more_evidence'}, evidence: {completeness: 'complete'}, progress: {status: 'terminal'}}), /Автоматические попытки на тех же данных исчерпаны/);
assert.doesNotMatch(sample({cause: 'manual_review', reason: 'terminal_without_resolution', diagnostics: {terminalReason: 'no_more_evidence'}, evidence: {completeness: 'complete'}, progress: {status: 'terminal'}}), /no_more_evidence/);
assert.match(sample({cause: 'manual_review', reason: 'identity_conflict', evidence: {completeness: 'complete'}, progress: {status: 'terminal'}}), /столкновение или неоднозначность/);
assert.match(sample({cause: 'stale_projection', reason: 'projection_generation_differs', evidence: {completeness: 'complete'}, progress: {status: 'stalled'}}), /Действие с этой страницы не выполняется/);
assert.match(sample({cause: 'unknown', reason: 'progress_unknown', evidence: {completeness: 'missing'}, progress: {status: 'unknown'}}), /Результат не подтверждён/);
assert.equal(run(`limboQueueId({cause:'stalled'})`), 'stalled');
assert.equal(run(`limboQueueId({cause:'manual_review'})`), 'owner');
assert.equal(run(`limboQueueId({cause:'backoff'})`), 'automatic');
assert.equal(run(`limboQueueId({cause:'unknown'})`), 'unverified');
assert.equal(run(`limboQueueId({cause:'stale_projection'})`), 'unverified');

// 12. A later page may repeat a queue and arrive in another order. Rows join the one existing section; headings stay in queue order.
const row = (id, cause, reason, progress, completeness) => ({id, kind: 'film', cause, reason, subsystem: 'metadata', film: {title: id, year: 2001, inProgramme: true, storedId: 'raw-' + id}, evidence: {completeness, source: 'snapshot', observedAt: null, missing: [], anomalies: []}, progress: {status: progress}, age: {ms: cause === 'unknown' ? null : 86400000}, action: {suggested: 'wait', eligible: false}});
run(`limboLive.state={kind:'',subsystem:'',causes:null,age:'',attention:'all'}`);
const merged = run(`limboMergeHtml(limboResultsHtml(${JSON.stringify([row('a', 'stalled', 'no_progress', 'stalled', 'complete'), row('b', 'unknown', 'metadata_missing', 'unknown', 'missing')])}), ${JSON.stringify([row('c', 'unknown', 'metadata_missing', 'unknown', 'missing'), row('d', 'backoff', 'retry_waiting', 'waiting', 'complete'), row('e', 'stalled', 'no_progress', 'stalled', 'complete')])})`);
assert.deepEqual([...merged.matchAll(/<section class="limbo-queue" data-limbo-queue="([^"]+)"/g)].map(match => match[1]), ['stalled', 'automatic', 'unverified']);
const stalled = merged.slice(merged.indexOf('data-limbo-queue="stalled"'), merged.indexOf('data-limbo-queue="automatic"'));
const unverified = merged.slice(merged.indexOf('data-limbo-queue="unverified"'));
assert.match(stalled, /data-limbo-item="a"[\s\S]*data-limbo-item="e"/);
assert.match(unverified, /data-limbo-item="b"[\s\S]*data-limbo-item="c"/);
assert.doesNotMatch(stalled, /data-limbo-item="b"|data-limbo-item="d"/);

// 13. Arrow keys move the queue only from a queue button. A field in the open recovery keeps the key and the selection.
const selectKey = listeners.get('#limbo-results').find(item => item.type === 'keydown').fn;
const heldSelection = run('limboLive.selected');
const field = {tagName: 'INPUT', closest() {return null;}};
document.activeElement = field;
let fieldPrevented = false;
for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) selectKey({key, target: field, preventDefault() {fieldPrevented = true;}});
assert.equal(fieldPrevented, false);
assert.equal(document.activeElement, field);
assert.equal(run('limboLive.selected'), heldSelection);
const first = {getAttribute: () => 't1', closest(selector) {return selector === '[data-limbo-select]' ? this : null;}, focus() {}};
const second = {getAttribute: () => 't2', closest(selector) {return selector === '[data-limbo-select]' ? this : null;}, focus() {document.activeElement = this;}};
results.querySelectorAll = selector => selector === '[data-limbo-select]' ? [first, second] : [];
document.activeElement = first;
run(`limboSelect.set('t2','film-b'); limboLive.selected='film-a'`);
let buttonPrevented = false;
selectKey({key: 'ArrowDown', target: first, preventDefault() {buttonPrevented = true;}});
assert.equal(buttonPrevented, true);
assert.equal(document.activeElement, second);
assert.equal(run('limboLive.selected'), 'film-b');
delete results.querySelectorAll;

// 14. A film with no title does not put its stored id on the card face.
const untitled = run(`limboItemHtml(${JSON.stringify({id: 'bare', kind: 'film', cause: 'unknown', reason: 'metadata_missing', subsystem: 'metadata', film: {title: null, storedId: 'tmdb_77', inProgramme: false}, evidence: {completeness: 'missing', source: 'snapshot', observedAt: null, missing: [], anomalies: []}, progress: {status: 'unknown'}, age: {ms: null}, action: {suggested: 'investigate', eligible: null}})})`);
const untitledFace = untitled.replace(/<details class="limbo-tech">[\s\S]*<\/details>/, '');
assert.match(untitledFace, /Фильм без названия/);
assert.doesNotMatch(untitledFace, /tmdb_77/);
assert.match(untitled, /<details class="limbo-tech">[\s\S]*tmdb_77/);

// 15. The offer follows the control on the row, never the health-model eligibility flag.
const offerItem = (extra) => ({id: extra.id, kind: extra.kind, cause: 'retry_eligible', reason: 'retry_due', subsystem: extra.subsystem, film: extra.film, observation: extra.observation, subjectId: extra.subjectId, evidence: {completeness: 'complete', source: 'snapshot', observedAt: '2026-10-01T00:00:00.000Z', missing: [], anomalies: []}, progress: {status: 'due'}, age: {ms: 86400000}, action: extra.action});
const offerHtml = extra => run(`limboItemHtml(${JSON.stringify(offerItem(extra))})`);
const offerFace = html => html.replace(/<details class="limbo-tech">[\s\S]*?<\/details>/, '');
const metadata = offerHtml({id: 'meta-1', kind: 'film', subsystem: 'metadata', film: {title: 'Справочник', year: 1999, inProgramme: true, storedId: 'tmdb_9'}, action: {suggested: 'bounded_action', code: 'metadata_refresh', eligible: true, reason: 'eligible'}});
assert.match(offerFace(metadata), /Кнопки записи на этой странице нет\. Готовность в модели здоровья данных записью не является/);
assert.doesNotMatch(metadata, /Разобрать прогноз|Разобрать наблюдение/);
assert.doesNotMatch(offerFace(metadata), /Действие для этой записи допустимо|просит подтверждение|неизвестно|недопустимо|не применимо/);
const prediction = offerHtml({id: 'pred-1', kind: 'film', subsystem: 'prediction', film: {title: 'Прогноз', year: 2011, inProgramme: true, storedId: 'pred_1'}, action: {suggested: 'bounded_action', code: 'prediction_retry', eligible: true, reason: 'eligible'}});
assert.match(prediction, /Разобрать прогноз/);
assert.match(offerFace(prediction), /Кнопка ниже только читает объяснение прогноза\. Записи для этого фильма на странице нет/);
assert.doesNotMatch(offerFace(prediction), /Действие для этой записи допустимо|просит подтверждение/);
const watched = offerHtml({id: 'obs-yes', kind: 'observation', subsystem: 'discovery', observation: {key: 'тихий|2001', title: 'Тихий дождь', year: 2001}, action: {suggested: 'review', eligible: true, reason: 'eligible'}});
assert.match(watched, /Разобрать наблюдение/);
assert.match(offerFace(watched), /Кнопка ниже только читает разбор\. Можно ли что-то записать, эта строка ещё не проверяла/);
assert.doesNotMatch(offerFace(watched), /Действие для этой записи допустимо|просит подтверждение|неизвестно/);
const unkeyed = offerHtml({id: 'obs-no', kind: 'observation', subsystem: 'discovery', subjectId: 'bad\nkey', observation: {title: 'Без ключа'}, action: {suggested: 'review', eligible: true, reason: 'eligible'}});
assert.doesNotMatch(unkeyed, /Разобрать наблюдение|Разобрать прогноз/);
assert.match(offerFace(unkeyed), /Кнопки записи на этой странице нет/);
assert.doesNotMatch(offerFace(unkeyed), /Действие для этой записи допустимо/);
const rows = [metadata, prediction, watched];
for (const [html, title, year] of [[metadata, 'Справочник', '1999'], [prediction, 'Прогноз', '2011'], [watched, 'Тихий дождь', '2001']]) {
  assert.match(html, new RegExp(`<h3 class="limbo-detail-title" tabindex="-1">${title} <span class="admin-hit-meta">${year} ·`));
  assert.match(html, new RegExp(`К объяснению: ${title}</button>`));
  assert.doesNotMatch(html.slice(0, html.indexOf('<details class="limbo-tech">')), /tmdb_9|pred_1|тихий\|2001/);
}
assert.equal(rows.length, 3);

// 16. The jump focuses the detail heading. Arrow, Home and End stay on the queue buttons.
const heading = {focus() {document.activeElement = this;}};
const detail = {id: 'limbo-detail-9', parentElement: null, hidden: false, getAttribute(name) {return name === 'data-limbo-title' ? 'Тихий дождь' : null;}, querySelector(selector) {return selector === '.limbo-detail-title' ? heading : null;}};
const queueButton = {getAttribute(name) {return name === 'aria-controls' ? 'limbo-detail-9' : name === 'data-limbo-select' ? '9' : null;}, closest(selector) {return selector === '[data-limbo-select]' ? this : null;}, focus() {document.activeElement = this;}};
const otherButton = {getAttribute() {return '10';}, closest(selector) {return selector === '[data-limbo-select]' ? this : null;}, focus() {document.activeElement = this;}};
results.querySelector = selector => selector === '[data-limbo-select="9"]' ? queueButton : selector === '.limbo-select[aria-expanded="true"]' ? queueButton : null;
results.querySelectorAll = selector => selector === '[data-limbo-select]' ? [queueButton, otherButton] : [];
document.getElementById = id => id === 'limbo-detail-9' ? detail : null;
const click = listeners.get('#limbo-results').find(item => item.type === 'click').fn;
const jump = {getAttribute(name) {return name === 'data-limbo-jump' ? '9' : null;}, closest(selector) {return selector === '[data-limbo-jump]' ? this : null;}};
let jumpPrevented = false;
click({target: jump, preventDefault() {jumpPrevented = true;}});
assert.equal(jumpPrevented, true);
assert.equal(document.activeElement, heading, 'the jump moves focus to the detail heading');
document.activeElement = queueButton;
let arrowPrevented = false;
selectKey({key: 'ArrowDown', target: queueButton, preventDefault() {arrowPrevented = true;}});
assert.equal(arrowPrevented, true);
assert.equal(document.activeElement, otherButton, 'an arrow from a queue button does not focus the detail');
const focusBody = element('#limbo-focus-body');
focusBody.querySelectorAll = () => [];
focusBody.appendChild = node => {node.parentElement = focusBody; focusBody.child = node;};
const focusTitle = element('#limbo-focus-title');
const focusEmpty = element('#limbo-focus-empty');
nodes.set('#limbo-focus-body', focusBody);
nodes.set('#limbo-focus-title', focusTitle);
nodes.set('#limbo-focus-empty', focusEmpty);
window.matchMedia = () => ({matches: true});
run('limboPlaceDetail()');
assert.equal(focusTitle.textContent, 'Тихий дождь');
assert.equal(detail.parentElement, focusBody);
assert.equal(focusEmpty.hidden, true);
window.matchMedia = () => ({matches: false});
run('limboPlaceDetail()');
assert.equal(focusTitle.textContent, 'Выбранная запись');
assert.equal(focusEmpty.hidden, false);
// 13. Freshness is a quiet hint: 49 films do not ask for a refresh, 50 do, an hour does, a minute does not, and none of that sends a request.
const filmSet = count => Array.from({length: count}, (_, index) => ({id: 'f' + index, signature: 'stalled'}));
const readsBefore = requests.length;
await run(`limboLive.adoptBaseline = false; limboLive.filmNotice = null; limboLive.filmStates = {comparable:true, programmeRunId:'g1', count:0, films:[]}; limboRememberFilms({filmStates:{comparable:true, programmeRunId:'g1', count:49, films:${JSON.stringify(filmSet(49))}}}); limboNoteFreshness()`);
assert.equal(nodes.get('#limbo-freshness').hidden, true);
await run(`limboLive.filmStates = {comparable:true, programmeRunId:'g1', count:0, films:[]}; limboRememberFilms({filmStates:{comparable:true, programmeRunId:'g1', count:50, films:${JSON.stringify(filmSet(50))}}}); limboNoteFreshness()`);
assert.equal(nodes.get('#limbo-freshness').hidden, false);
assert.match(nodes.get('#limbo-freshness-text').textContent, /Список обновлён: изменилось состояние не меньше 50 фильмов/);
assert.doesNotMatch(nodes.get('#limbo-freshness-text').textContent, /можно обновить/);
await run(`limboLive.filmNotice = null; limboLive.shownAt = Date.now() - 60 * 1000; limboNoteFreshness()`);
assert.equal(nodes.get('#limbo-freshness').hidden, true, 'a minute is not an hour');
await run(`limboLive.shownAt = Date.now() - 61 * 60 * 1000; limboNoteFreshness()`);
assert.match(nodes.get('#limbo-freshness-text').textContent, /больше часа/);
await run(`limboLive.filmNotice = null`);
nodes.get('#limbo-freshness').hidden = true;
const hourReads = requests.length;
for (const item of windowListeners) if (item.type === 'focus') item.fn();
assert.equal(nodes.get('#limbo-freshness').hidden, false);
assert.match(nodes.get('#limbo-freshness-text').textContent, /больше часа/);
assert.equal(requests.length, hourReads, 'returning to the tab paints the hour line and does not read');
await run(`limboLive.filmStates = {comparable:true, programmeRunId:'g1', count:1, films:[{id:'a', signature:'stalled'}]}; limboLive.shownAt = Date.now(); limboRememberFilms({filmStates:{comparable:true, programmeRunId:'g2', count:1, films:[{id:'a', signature:'stalled'}]}}); limboNoteFreshness()`);
assert.match(nodes.get('#limbo-freshness-text').textContent, /Сравнение с прошлым снимком недоступно/);
assert.equal(requests.length, readsBefore, 'the hint does not read');

// 14. A stale confirmation is cancelled. The write is not sent again.
await run(`globalThis.limboPosts = {confirm:0, execute:0}; confirmDiscoveryReconsider = () => { limboPosts.confirm++; return Promise.resolve({ok:false, error:'stale_pin', body:null}); }; executeDiscoveryReconsider = () => { limboPosts.execute++; return Promise.resolve({ok:true, body:{}}); }; obsRecovery.set('queue', {key:'alpha|2014', pin:'old', accepted:true, busy:false, seq:1, open:true, confirmation:{id:'c'}});`);
await run(`onObsRecoveryConfirm('queue')`);
await settle();
assert.equal(run('limboPosts.confirm'), 1);
assert.equal(run('limboPosts.execute'), 0);
assert.equal(run(`obsRecovery.get('queue').accepted`), false);
assert.equal(run(`obsRecovery.get('queue').confirmation`), null);

// 15. A 409 whose unpinned retry fails drops the desktop detail and its action controls. Refresh is the way back.
const focusPanel = nodes.get('#limbo-focus-body');
focusPanel.innerHTML = '<section class="limbo-detail"><button type="button" data-obs-recovery-confirm>Подтвердить</button><button type="button" data-obs-recovery-execute>Выполнить</button></section>';
nodes.get('#limbo-verdict').textContent = 'Подтверждённых действий: 1. Выберите запись.';
nodes.get('#limbo-action-count').textContent = 'Подтверждённых действий во всём снимке: 1.';
nodes.get('#limbo-coverage-line').textContent = 'Покрытие частичное.';
await run(`globalThis.limboPosts = {confirm:0, execute:0}; confirmDiscoveryReconsider = () => { limboPosts.confirm++; return Promise.resolve({ok:true, body:{confirmation:{id:'c'}}}); }; executeDiscoveryReconsider = () => { limboPosts.execute++; return Promise.resolve({ok:true, body:{}}); }; globalThis._loadLimboLive = loadLimboLive; limboLive.selected = 'obs-1'; limboLive.pin = 'old-pin'; limboLive.next = 'cursor-old'; limboLive.snapshot = {programmeRunId:'g1'}; limboLive.counts = {total:10, actionNow:1, actionNowByCause:{manual_review:1}}; obsRecovery.set('queue', {key:'alpha|2014', pin:'old', accepted:true, busy:false, open:true, confirmation:{id:'c'}}); limboRecovery.set('pred', {filmId:'tmdb_1', pin:'p', open:true}); limboSelect.set('tok', 'obs-1'); loadLimboLive = (state, options) => options && options.pin ? Promise.resolve({mode:'stale', error:'stale_pin'}) : Promise.resolve({mode:'error', error:'http_503'});`);
await run('limboRender()');
await settle();
assert.equal(run('limboPosts.confirm'), 0, 'a failed list retry does not confirm');
assert.equal(run('limboPosts.execute'), 0, 'a failed list retry does not execute');
assert.equal(focusPanel.innerHTML, '');
assert.doesNotMatch(focusPanel.innerHTML, /Подтвердить|Выполнить|data-obs-recovery/);
assert.equal(run('obsRecovery.size'), 0);
assert.equal(run('limboRecovery.size'), 0);
assert.equal(run('limboSelect.size'), 0);
assert.equal(run('limboLive.selected'), null);
assert.equal(run('limboLive.pin'), null);
assert.equal(run('limboLive.next'), null);
assert.equal(run('limboLive.snapshot'), null);
assert.equal(results.innerHTML, '');
assert.match(nodes.get('#limbo-verdict').textContent, /Список недоступен\. Доступные действия не проверены/);
assert.doesNotMatch(nodes.get('#limbo-verdict').textContent, /Подтверждённых действий: 1/);
assert.equal(nodes.get('#limbo-action-count').textContent, '');
assert.match(nodes.get('#limbo-coverage-line').textContent, /Покрытие не прочитано/);
assert.doesNotMatch(nodes.get('#limbo-coverage-line').textContent, /частичное/);
await run('loadLimboLive = globalThis._loadLimboLive');
await run('onLimboRefresh()');
await settle();
assert.equal(stale.hidden, true);
assert.doesNotMatch(nodes.get('#limbo-verdict').textContent, /Список недоступен/);
assert.equal(typeof run('limboLive.pin'), 'string');
assert.doesNotMatch(focusPanel.innerHTML, /Подтвердить|Выполнить/);
assert.equal(run('limboPosts.confirm'), 0);
assert.equal(run('limboPosts.execute'), 0);

// 16. A successful unpinned retry that changes 50 films does not ask for another refresh.
await run(`globalThis._loadLimboLive = loadLimboLive; limboLive.pin = 'held'; limboLive.adoptBaseline = false; limboLive.filmNotice = null; limboLive.filmStates = {comparable:true, programmeRunId:'g-delta', count:0, films:[]}; limboLive.shownAt = Date.now(); const films = ${JSON.stringify(filmSet(50))}; loadLimboLive = (state, options) => options && options.pin ? Promise.resolve({mode:'stale', error:'stale_pin'}) : Promise.resolve({mode:'ready', pin:'fresh-pin', snapshot:{programmeRunId:'g-delta', evaluatedAt:'2026-11-03T14:00:00.000Z', sources:[], clock:{}}, attention:{mode:'now', checked:true, reason:null, now:0}, items:[], nextCursor:null, total:0, counts:{total:0, actionNow:0, byCause:{}, bySubsystem:{identity:0, metadata:0, localization:0, fingerprint:0, prediction:0}, byKind:{film:0, observation:0}, actionNowByCause:{}}, filmStates:{comparable:true, programmeRunId:'g-delta', count:50, films}, coverage:{films:'partial', filmsObserved:0, observations:null}, context:[], unread:[], thresholds:null});`);
await run('limboRender()');
await settle();
assert.equal(nodes.get('#limbo-freshness').hidden, false);
assert.match(nodes.get('#limbo-freshness-text').textContent, /Список обновлён: изменилось состояние не меньше 50 фильмов/);
assert.doesNotMatch(nodes.get('#limbo-freshness-text').textContent, /можно обновить/);
assert.equal(stale.hidden, true);
assert.equal(run('limboPosts.confirm'), 0);
assert.equal(run('limboPosts.execute'), 0);
await run('loadLimboLive = globalThis._loadLimboLive');

console.log('Admin limbo page: URL filters, history, pagination under the pin, empty, error, stale snapshot and keyboard passed');
