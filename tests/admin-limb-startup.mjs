// /admin/limb startup, on the code the Worker actually serves. The page script is the `/admin-limbo.js` asset of the built Worker (the concatenation build.mjs makes,
// in its real source order), run in a vm over a generic DOM stand-in. A pure unit test of one source file cannot see an initialisation-order fault between the files of the
// bundle: the first version of the page-side serialisation called `iwIdle()` from `startLimbo()` before the later file had initialised `const iwLive`, so the live page
// threw «Cannot access 'iwLive' before initialization» and never sent a request. This test fails on that.
// It checks: no uncaught error at startup (synchronous or as a rejected promise); each initial read is scheduled exactly once; the identity list does not start while the
// first Limbo read is unresolved and starts once it settles, also when it fails; the controls are wired. Only GETs of the two read routes are sent.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const built = spawnSync(process.execPath, ['build.mjs'], {encoding: 'utf8'});
assert.equal(built.status, 0, built.stderr);
const bundleText = fs.readFileSync('dist/server/index.js', 'utf8');
const start = bundleText.indexOf('const ASSETS=') + 'const ASSETS='.length;
const end = bundleText.indexOf(';\nconst PERSON_NAME_DICTIONARY');
assert.ok(start >= 'const ASSETS='.length && end > start, 'the served assets are in the built Worker');
const ASSETS = JSON.parse(bundleText.slice(start, end));
const page = ASSETS['/admin-limbo.js'].body;
const html = ASSETS['/admin/limb'].body;
const returnHome = ASSETS['/return-home.js'].body;
assert.ok(html.indexOf('/return-home.js') < html.indexOf('/admin-limbo.js'), 'the page loads return-home.js before admin-limbo.js');
assert.ok(page.includes('function startLimbo()') && page.includes('function startIdentityWork()') && page.includes('const iwLive'), 'the served script holds both pages in one file');
assert.ok(html.includes('id="iw-section"'));

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
      if (key === 'children' || key === 'childNodes') return [];
      if (typeof key === 'symbol') return undefined;
      return (...args) => proxy;
    },
    set(_target, key, value) {store.set(key, value); return true;},
    apply() {return proxy;},
  });
  return proxy;
}

const LIMBO_BODY = {pin: 'L2|x', snapshot: {}, items: [], nextCursor: null, total: 0, counts: {total: 0, byCause: {}, bySubsystem: {}, byKind: {}, actionNow: 0, actionNowByCause: {}}, filmStates: {comparable: true, count: 0, films: [], programmeRunId: 'r'}, coverage: {films: 'partial', filmsObserved: 0, observations: {available: false, reason: 'index_unavailable'}, observationsObserved: 0}, context: [], unread: [], thresholds: {}, attention: {mode: 'now', checked: true, reason: null, now: 0}};
const IDENTITY_BODY = {pin: 'I1|a|b', snapshot: {}, rows: [], nextCursor: null, coverage: {film: {state: 'partial', observed: 0}}};

async function boot({limbo = 'ok'} = {}) {
  const registry = {listeners: []}, nodes = new Map();
  const get = selector => {if (!nodes.has(selector)) nodes.set(selector, node(selector, registry)); return nodes.get(selector);};
  const sent = [], gates = new Map();
  const errors = [], rejections = [];
  const gate = name => {let open; const promise = new Promise((resolve, reject) => {open = {resolve, reject};}); gates.set(name, {promise, open}); return gates.get(name);};
  gate('limbo'); gate('identity');
  const fetchImpl = async input => {
    const path = String(input);
    const name = path.startsWith('/api/admin/limbo') ? 'limbo' : path.startsWith('/api/admin/identity-work') ? 'identity' : 'other';
    sent.push({name, path});
    if (name === 'other') throw new Error('unexpected request ' + path);
    const held = gates.get(name);
    await held.promise;
    const failing = name === 'limbo' && limbo === 'fail';
    return failing ? {ok: false, status: 503, json: async () => ({error: 'storage_unavailable'})} : {ok: true, status: 200, json: async () => (name === 'limbo' ? LIMBO_BODY : IDENTITY_BODY)};
  };
  const location = {href: 'http://127.0.0.1/admin/limb', search: '', pathname: '/admin/limb', origin: 'http://127.0.0.1'};
  const windowObject = {addEventListener(type, fn) {registry.listeners.push({name: 'window', type, fn});}, location, history: {pushState() {}, replaceState() {}, back() {}}};
  const documentObject = {body: node('body', registry), activeElement: null, querySelector: get, querySelectorAll: () => [], addEventListener(type, fn) {registry.listeners.push({name: 'document', type, fn});}, createElement: () => node('created', registry), getElementById: id => get('#' + id)};
  const context = vm.createContext({URL, URLSearchParams, document: documentObject, window: windowObject, history: windowObject.history, location, fetch: fetchImpl, Array, Object, String, Number, Boolean, Math, JSON, Map, Set, Error, Promise, Date, Intl, RegExp, setTimeout, clearTimeout, AbortController, encodeURIComponent, decodeURIComponent, console: {log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' '))}});
  const onRejection = reason => rejections.push(String(reason && reason.stack || reason));
  process.on('unhandledRejection', onRejection);
  let thrown = null;
  try {vm.runInContext(returnHome, context); vm.runInContext(page, context);} catch (error) {thrown = error;}
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  await settle();
  return {registry, sent, gates, errors, rejections, thrown, settle, context, nodes, get, done: () => process.off('unhandledRejection', onRejection)};
}
const count = (page, name) => page.sent.filter(item => item.name === name).length;

// 1. Startup: nothing thrown, the first Limbo read is scheduled once, the identity list holds back.
{
  const p = await boot();
  assert.equal(p.thrown, null, 'the page script runs to its end without an uncaught error: ' + (p.thrown && p.thrown.message));
  assert.deepEqual(p.rejections, [], 'no rejected promise at startup');
  assert.deepEqual(p.errors, [], 'nothing logged as an error');
  assert.equal(count(p, 'limbo'), 1, 'the initial Limbo read is scheduled exactly once');
  assert.equal(count(p, 'identity'), 0, 'the identity list does not start while the first Limbo read is unresolved');
  assert.match(p.sent[0].path, /^\/api\/admin\/limbo\?/);
  // the controls of both sections are wired
  const wired = (name, type) => p.registry.listeners.some(item => item.name === name && item.type === type);
  assert.ok(wired('#limbo-refresh', 'click'), 'the Limbo refresh button is wired');
  assert.ok(wired('#iw-form', 'submit'), 'the identity form is wired');
  for (const id of ['#iw-reset', '#iw-refresh', '#iw-more', '#iw-reload', '#iw-retry']) assert.ok(wired(id, 'click'), id + ' is wired');
  // once the first Limbo read settles the identity list proceeds, once
  p.gates.get('limbo').open.resolve();
  await p.settle(); await p.settle();
  assert.equal(count(p, 'limbo'), 1, 'still one Limbo read');
  assert.equal(count(p, 'identity'), 1, 'the identity read starts after it, once');
  assert.match(p.sent.find(item => item.name === 'identity').path, /^\/api\/admin\/identity-work\?limit=25$/);
  p.gates.get('identity').open.resolve();
  await p.settle(); await p.settle();
  assert.equal(p.get('#iw-verdict').textContent.startsWith('Показано записей: 0'), true, 'the identity list rendered its verdict: ' + p.get('#iw-verdict').textContent);
  assert.deepEqual(p.sent.map(item => item.name), ['limbo', 'identity'], 'two reads in all, in that order');
  assert.deepEqual(p.rejections, []);
  assert.equal(p.thrown, null);
  p.done();
}

// 2. A failed first Limbo read does not hold the identity list back.
{
  const p = await boot({limbo: 'fail'});
  assert.equal(p.thrown, null, 'startup does not throw: ' + (p.thrown && p.thrown.message));
  assert.equal(count(p, 'identity'), 0);
  p.gates.get('limbo').open.resolve();
  await p.settle(); await p.settle();
  assert.equal(count(p, 'identity'), 1, 'the identity list starts although the Limbo read failed');
  assert.deepEqual(p.rejections, [], 'a failed read is handled, not an unhandled rejection');
  p.done();
}

// 3. A Limbo read that rejects outright (the request never reaches the Worker) is also released.
{
  const p = await boot();
  p.gates.get('limbo').open.reject(new TypeError('network down'));
  await p.settle(); await p.settle();
  assert.equal(count(p, 'identity'), 1, 'a rejected first read does not hold the list back');
  assert.deepEqual(p.rejections, []);
  p.done();
}

// 4. The order of the bundle is what makes it work: the bootstrap is one explicit call after every definition, not two starts that depend on file order.
{
  assert.equal((page.match(/startLimbo\(\);/g) || []).length >= 1, true);
  const bootstrap = page.lastIndexOf('startIdentityWork();');
  assert.ok(bootstrap > page.indexOf('const iwLive'), 'the bootstrap follows the initialisation of iwLive');
  assert.ok(page.lastIndexOf('startLimbo();') > page.indexOf('const iwLive') || page.indexOf('function startLimbo()') > 0);
}
console.log('admin-limb-startup: the served /admin-limbo.js starts without an error, reads once each in order, and releases the list after a failed read');
