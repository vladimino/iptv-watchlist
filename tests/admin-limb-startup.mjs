// The two owner pages /admin/limb and /admin/identity, on the code the Worker actually serves. Both page scripts are assets of the built Worker (the files build.mjs
// makes, run after `return-home.js` as the pages load them) and run in a vm over a generic DOM stand-in. Earlier the identity queue was a section of the Limbo page and
// shared one bundle with it; the start order between the two files threw «Cannot access 'iwLive' before initialization» on the live page. They are now two pages with two
// bundles, and this test holds that apart: each page starts only its own script, sends exactly one initial GET to its own route and none to the other's, throws nothing, and
// the identity queue is not part of the Limbo page again. It also reads the nav of every owner page and asks the built Worker for both routes.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const built = spawnSync(process.execPath, ['build.mjs'], {encoding: 'utf8'});
assert.equal(built.status, 0, built.stderr);
const bundleText = fs.readFileSync('dist/server/index.js', 'utf8');
const start = bundleText.indexOf('const ASSETS=') + 'const ASSETS='.length;
const end = bundleText.indexOf(';\nconst PERSON_NAME_DICTIONARY');
assert.ok(start >= 'const ASSETS='.length && end > start, 'the served assets are in the built Worker');
const ASSETS = JSON.parse(bundleText.slice(start, end));
const returnHome = ASSETS['/return-home.js'].body;
const PAGES = {
  limb: {route: '/admin/limb', script: '/admin-limbo.js', own: 'limbo', other: 'identity-work', ownPath: /^\/api\/admin\/limbo\?/},
  identity: {route: '/admin/identity', script: '/admin-identity.js', own: 'identity-work', other: 'limbo', ownPath: /^\/api\/admin\/identity-work\?limit=25$/},
};

// ---- the served pages: routes, nav, no identity queue on the Limbo page ----
const NAV = [['/admin', 'Каталог'], ['/admin/health', 'Здоровье данных'], ['/admin/letterboxd', 'Архив Letterboxd'], ['/admin/limb', 'Лимб'], ['/admin/identity', 'Идентификация'], ['/admin/posters', 'Постеры'], ['/admin/channels', 'Каналы'], ['/admin/settings', 'Настройки']];
for (const route of ['/admin', '/admin/health', '/admin/letterboxd', '/admin/limb', '/admin/identity', '/admin/posters', '/admin/channels']) {
  const asset = ASSETS[route];
  assert.ok(asset, route + ' is a served page');
  const nav = asset.body.match(/<nav class="admin-views"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(nav, route + ' has the sections nav');
  const links = [...nav[0].matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(match => [match[1].match(/href="([^"]+)"/)[1], match[2]]);
  assert.deepEqual(links, NAV, route + ': the same eight tabs in the same order');
  const current = [...nav[0].matchAll(/<a\b([^>]*aria-current="page"[^>]*)>([^<]*)<\/a>/g)].map(match => match[1].match(/href="([^"]+)"/)[1]);
  // /admin/health is the catalog document (the page script marks the health tab at runtime), so its served markup marks the catalog tab.
  assert.deepEqual(current, [route === '/admin/health' ? '/admin' : route], route + ': exactly its own tab is current');
}
{
  const identity = ASSETS['/admin/identity'].body, limb = ASSETS['/admin/limb'].body;
  assert.match(identity, /<h1>Единая очередь идентификации<\/h1>/);
  assert.match(identity, /<script src="\/admin-identity\.js"><\/script>/);
  assert.doesNotMatch(identity, /admin-limbo\.js|id="limbo-/, 'the identity page holds nothing of the Limbo page');
  assert.doesNotMatch(limb, /iw-section|id="iw-|Единая очередь идентификации|admin-identity\.js/, 'the Limbo page no longer holds the identity queue, nested or linked');
  assert.match(limb, /<script src="\/admin-limbo\.js"><\/script>/);
  const limboJs = ASSETS['/admin-limbo.js'].body, identityJs = ASSETS['/admin-identity.js'].body;
  assert.doesNotMatch(limboJs, /iwLive|startIdentityWork|loadIdentityWork|identity-work|iwIdle|iwAfterLimbo/, 'the Limbo bundle holds no identity code');
  assert.doesNotMatch(identityJs, /startLimbo|limboLive|loadLimboLive|\/limbo\b|prediction-recovery|discovery-recovery/, 'the identity bundle holds no Limbo code');
  assert.ok(limboJs.includes('function startLimbo()') && identityJs.includes('function startIdentityWork()'));
  assert.equal((limboJs.match(/\bstartLimbo\(\);/g) || []).length, 1, 'one start of the Limbo page, at the end of its own script');
  assert.equal((identityJs.match(/\bstartIdentityWork\(\);/g) || []).length, 1, 'one start of the identity page');
}

// ---- the built Worker serves both routes, owner pages only through the same Access application ----
{
  const worker = (await import(pathToFileURL(path.resolve('dist/server/index.js')).href + '?startup=' + process.pid)).default;
  for (const [route, key] of [['/admin/identity', '/admin/identity'], ['/admin/limb', '/admin/limb']]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request('https://iptv.example' + route, {method}), {BUCKET: {}}, {waitUntil() {}});
      assert.equal(response.status, 200, method + ' ' + route);
      assert.match(response.headers.get('Content-Type'), /^text\/html/);
      assert.equal(await response.text(), method === 'HEAD' ? '' : ASSETS[key].body);
    }
  }
  const script = await worker.fetch(new Request('https://iptv.example/admin-identity.js'), {BUCKET: {}}, {waitUntil() {}});
  assert.equal(script.status, 200); assert.match(script.headers.get('Content-Type'), /javascript/);
}

// A generic element: every property can be set and read back, every method is a no-op that returns an element.
function node(name, registry) {
  const store = new Map([['hidden', false], ['value', ''], ['checked', false], ['disabled', false], ['textContent', ''], ['innerHTML', ''], ['dataset', {}], ['open', false], ['selector', name]]);
  const proxy = new Proxy(function () {}, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (store.has(key)) return store.get(key);
      if (key === 'addEventListener') return (type, fn) => registry.listeners.push({name, type, fn});
      if (key === 'classList') return {add() {}, remove() {}, toggle() {}, contains: () => false};
      if (key === 'style') return {};
      if (key === 'querySelectorAll') return () => [];
      if (key === 'closest' || key === 'matches' || key === 'getAttribute') return () => null;
      if (key === 'children' || key === 'childNodes') return [];
      if (typeof key === 'symbol') return undefined;
      return () => proxy;
    },
    set(_target, key, value) {store.set(key, value); return true;},
    apply() {return proxy;},
  });
  return proxy;
}

const LIMBO_BODY = {pin: 'L2|x', snapshot: {}, items: [], nextCursor: null, total: 0, counts: {total: 0, byCause: {}, bySubsystem: {}, byKind: {}, actionNow: 0, actionNowByCause: {}}, filmStates: {comparable: true, count: 0, films: [], programmeRunId: 'r'}, coverage: {films: 'partial', filmsObserved: 0, observations: {available: false, reason: 'index_unavailable'}, observationsObserved: 0}, context: [], unread: [], thresholds: {}, attention: {mode: 'now', checked: true, reason: null, now: 0}};
const IDENTITY_BODY = {pin: 'I1|a|b', snapshot: {}, rows: [], nextCursor: null, coverage: {film: {state: 'partial', observed: 0}}};

async function boot(page, {fail = false, hold = false} = {}) {
  const spec = PAGES[page], registry = {listeners: []}, nodes = new Map();
  const get = selector => {if (!nodes.has(selector)) nodes.set(selector, node(selector, registry)); return nodes.get(selector);};
  const sent = [], errors = [], rejections = [];
  let release = null;
  const gate = hold ? new Promise(resolve => {release = resolve;}) : null;
  const fetchImpl = async input => {
    const path = String(input);
    const name = path.startsWith('/api/admin/limbo') ? 'limbo' : path.startsWith('/api/admin/identity-work') ? 'identity-work' : 'other';
    sent.push({name, path});
    if (name === 'other') throw new Error('unexpected request ' + path);
    if (gate) await gate;
    return fail ? {ok: false, status: 503, json: async () => ({error: 'storage_unavailable'})} : {ok: true, status: 200, json: async () => (name === 'limbo' ? LIMBO_BODY : IDENTITY_BODY)};
  };
  const location = {href: 'http://127.0.0.1' + spec.route, search: '', pathname: spec.route, origin: 'http://127.0.0.1'};
  const windowObject = {addEventListener(type, fn) {registry.listeners.push({name: 'window', type, fn});}, location, history: {pushState() {}, replaceState() {}, back() {}}};
  const documentObject = {body: node('body', registry), activeElement: null, querySelector: get, querySelectorAll: () => [], addEventListener(type, fn) {registry.listeners.push({name: 'document', type, fn});}, createElement: () => node('created', registry), getElementById: id => get('#' + id)};
  const context = vm.createContext({URL, URLSearchParams, document: documentObject, window: windowObject, history: windowObject.history, location, fetch: fetchImpl, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, encodeURIComponent, decodeURIComponent, console: {log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' '))}});
  const onRejection = reason => rejections.push(String(reason && reason.stack || reason));
  process.on('unhandledRejection', onRejection);
  let thrown = null;
  try {vm.runInContext(returnHome, context); vm.runInContext(ASSETS[spec.script].body, context);} catch (error) {thrown = error;}
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  await settle();
  return {spec, registry, sent, errors, rejections, thrown, settle, release: () => release && release(), get, done: () => process.off('unhandledRejection', onRejection)};
}
const wired = (p, name, type) => p.registry.listeners.some(item => item.name === name && item.type === type);
const own = p => p.sent.filter(item => item.name === p.spec.own);
const foreign = p => p.sent.filter(item => item.name !== p.spec.own);

for (const page of ['limb', 'identity']) {
  // 1. A normal start: nothing thrown, one initial GET to the page's own route, none to the other's, controls wired.
  {
    const p = await boot(page);
    assert.equal(p.thrown, null, page + ': the page script runs to its end without an uncaught error: ' + (p.thrown && p.thrown.message));
    assert.deepEqual(p.rejections, [], page + ': no rejected promise');
    assert.deepEqual(p.errors, [], page + ': nothing logged as an error');
    assert.equal(own(p).length, 1, page + ': exactly one initial GET to its own route');
    assert.match(own(p)[0].path, p.spec.ownPath);
    assert.deepEqual(foreign(p), [], page + ': no request at all to the other page\'s route');
    if (page === 'limb') assert.ok(wired(p, '#limbo-refresh', 'click'), 'the Limbo refresh button is wired');
    else {
      assert.ok(wired(p, '#iw-form', 'submit'), 'the identity form is wired');
      for (const id of ['#iw-reset', '#iw-refresh', '#iw-more', '#iw-reload', '#iw-retry']) assert.ok(wired(p, id, 'click'), id + ' is wired');
      assert.equal(p.get('#iw-verdict').textContent.startsWith('Показано записей: 0'), true, 'the identity list rendered its verdict: ' + p.get('#iw-verdict').textContent);
      assert.equal(p.get('#iw-loading').hidden, true, 'and left its loading state');
    }
    await p.settle();
    assert.equal(own(p).length, 1, page + ': still one GET after settling (no automatic repeat)');
    assert.deepEqual(foreign(p), []);
    p.done();
  }
  // 2. The first read still in flight: still one GET, nothing else started.
  {
    const p = await boot(page, {hold: true});
    assert.equal(p.thrown, null);
    assert.equal(own(p).length, 1); assert.deepEqual(foreign(p), []);
    p.release(); await p.settle(); await p.settle();
    assert.equal(own(p).length, 1); assert.deepEqual(foreign(p), []); assert.deepEqual(p.rejections, []);
    p.done();
  }
  // 3. A failed first read (503 body) is shown, handled, and not retried by itself.
  {
    const p = await boot(page, {fail: true});
    assert.equal(p.thrown, null, page + ': startup does not throw on a failing read');
    assert.deepEqual(p.rejections, [], page + ': a failed read is handled, not an unhandled rejection');
    assert.equal(own(p).length, 1, page + ': a failed read is not repeated by itself');
    assert.deepEqual(foreign(p), []);
    if (page === 'identity') {
      assert.equal(p.get('#iw-error').hidden, false, 'the identity page shows its error state');
      assert.match(p.get('#iw-error-text').textContent, /Хранилище сейчас недоступно/);
    }
    p.done();
  }
}
console.log('admin-limb-startup: two pages, two served bundles; each starts only its own read, sends one GET to its own route and none to the other, throws nothing; the identity queue is not on the Limbo page; eight tabs on every owner page');
