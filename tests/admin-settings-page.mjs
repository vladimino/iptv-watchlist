// The /admin/settings page (card CU, AIR-611; ADR 0219): static boundary of the page and its bundle, the pure view logic, and the page script against a DOM stand-in with a fake fetch. Opening the page reads only; the checkbox sends
// exactly one pause or resume compare-and-swap request; every answer (applied, rejected, uncertain) ends in a fresh read; a disabled box sends nothing; no activation, no second flag and no other write route exist on the page.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {bundleAdmin} from '../src/admin/bundle.js';

const html = fs.readFileSync('public/admin-settings.html', 'utf8');
const page = fs.readFileSync('public/admin-settings.js', 'utf8');
const sources = ['src/admin/client.js', 'src/admin/settings-client.js', 'src/admin/settings-view.js'].map(file => fs.readFileSync(file, 'utf8'));
const bundle = bundleAdmin([...sources, page]);
const build = fs.readFileSync('build.mjs', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');

// ---- static boundary ----
for (const id of ['settings-snapshot-text', 'settings-loading', 'settings-error', 'settings-reread', 'settings-toggle', 'settings-toggle-label', 'settings-toggle-text', 'settings-revision', 'settings-outcome', 'settings-drain', 'settings-backlog', 'settings-scopes', 'settings-cooldowns', 'settings-attention']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.match(html, /<input type="checkbox" id="settings-toggle" disabled>/, 'the box starts disabled until a state is read');
assert.match(html, /<script src="\/admin-settings\.js"><\/script>/);
assert.match(html, /<a href="\/admin\/settings" aria-current="page" data-return-carry>Настройки<\/a><\/nav>/);
assert.doesNotMatch(html, /fetch\(|\/api\//);
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through its clients');
assert.doesNotMatch(bundle, /Authorization|Bearer|\/mcp|localStorage|'activate'|"activate"|\/api\/sync|\/api\/enrichment/, 'no credential, no activation, no other route, no browser storage');
assert.equal((bundle.match(/method:\s*['"]POST['"]/g) || []).length, 1, 'one POST call site');
assert.match(sources[1], /CATALOG_SETTINGS_ROUTE='\/api\/admin\/settings\/catalog-enrichment'/);
assert.match(sources[1], /CATALOG_SETTINGS_ACTIONS=\['pause','resume','retry'\]/);
assert.match(build, /assets\['\/admin\/settings'\]=\{body:fs\.readFileSync\('public\/admin-settings\.html'/);
assert.match(build, /assets\['\/admin-settings\.js'\]=\{body:bundleAdmin\(\[fs\.readFileSync\('src\/admin\/client\.js','utf8'\),fs\.readFileSync\('src\/admin\/settings-client\.js','utf8'\),fs\.readFileSync\('src\/admin\/settings-view\.js','utf8'\),fs\.readFileSync\('public\/admin-settings\.js','utf8'\)\]\)/);
assert.match(css, /@media\(max-width:800px\)\{\.settings-kpis\{grid-template-columns:minmax\(0,1fr\)\}\}/, 'mobile layout');
for (const file of fs.readdirSync('public').filter(name => /^admin.*\.html$/.test(name) && name !== 'admin-actions.html')) {
  assert.match(fs.readFileSync('public/' + file, 'utf8'), /<a href="\/admin\/settings"[^>]*data-return-carry>Настройки<\/a><\/nav>/, file + ' links the settings page');
}

// ---- the bundle in a DOM stand-in ----
function makeDom() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = {};
      nodes.set(selector, {selector, hidden: false, disabled: false, checked: false, textContent: '', innerHTML: '', className: '', listeners,
        addEventListener(type, fn) {(listeners[type] ||= []).push(fn);}, getAttribute: () => null, closest: () => null});
    }
    return nodes.get(selector);
  };
  return {nodes, node, document: {querySelector: node, querySelectorAll: () => []}};
}
function run({read, answers = [], reads = []}) {
  const dom = makeDom();
  const requests = [];
  let readIndex = 0;
  const queue = [...answers];
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const method = init.method || 'GET';
    requests.push({method, path: url.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null});
    if (method === 'GET') {
      const body = reads.length ? reads[Math.min(readIndex++, reads.length - 1)] : read;
      return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    const next = queue.shift();
    if (next === 'throw') throw new TypeError('offline');
    return new Response(JSON.stringify(next.body), {status: next.status, headers: {'Content-Type': 'application/json'}});
  };
  const context = vm.createContext({document: dom.document, fetch: fakeFetch, Response, URLSearchParams, Intl, Date, JSON, Math, Number, String, Object, Array, globalThis: undefined, crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000000'}});
  context.globalThis = context;
  vm.runInContext(bundle, context);
  return {dom, requests, context};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => {for (let i = 0; i < 12; i++) await tick();};
const control = (state, revision = 3) => ({state, generation: revision, revision, updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'owner'});
const readOf = (state, extra = {}) => ({configured: true, control: control(state), scopes: [], lastRun: null, draining: null, signals: {pending: 2, oldestArmedAt: null}, due: {films: 4, oldestDueSince: null}, cooldowns: [], attention: [], attentionTruncated: false, ...extra});

// Opening the page reads once and sends nothing else.
{
  const {dom, requests} = run({read: readOf('active')});
  await settle();
  assert.deepEqual(requests.map(r => r.method + ' ' + r.path), ['GET /api/admin/settings']);
  const box = dom.node('#settings-toggle');
  assert.equal(box.checked, true);
  assert.equal(box.disabled, false);
  assert.match(dom.node('#settings-toggle-text').textContent, /отсечка и работа сохраняются/);
}

// Inactive and unreadable: the box is disabled and a change event sends nothing (no activation from the UI).
for (const read of [readOf('inactive', {control: {...control('inactive', 0)}}), {configured: false, reason: 'schema_missing', state: 'inactive'}]) {
  const {dom, requests} = run({read});
  await settle();
  const box = dom.node('#settings-toggle');
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  for (const fn of box.listeners.change || []) fn();
  await settle();
  assert.deepEqual(requests.map(r => r.method), ['GET'], 'a disabled box writes nothing');
}

// Active -> unchecking sends one pause with the revision the owner saw, then re-reads and shows applied.
{
  const {dom, requests} = run({reads: [readOf('active', {control: control('active', 7)}), readOf('paused', {control: control('paused', 8)})], answers: [{status: 200, body: {ok: true, outcome: 'applied', action: 'pause', control: control('paused', 8)}}]});
  await settle();
  for (const fn of dom.node('#settings-toggle').listeners.change) fn();
  await settle();
  const posts = requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/admin/settings/catalog-enrichment');
  assert.equal(posts[0].headers['X-IPTV-Admin-Action'], 'catalog_enrichment_settings');
  assert.deepEqual({...posts[0].body, requestId: 'x'}, {action: 'pause', expectedRevision: 7, requestId: 'x'});
  assert.match(posts[0].body.requestId, /^[A-Za-z0-9:._-]{8,100}$/);
  assert.equal(requests.filter(r => r.method === 'GET').length, 2, 'a fresh read after the answer');
  assert.match(dom.node('#settings-outcome').textContent, /применено и подтверждено перечитыванием/);
  assert.equal(dom.node('#settings-toggle').checked, false);
  assert.match(dom.node('#settings-toggle-text').textContent, /не расширяется/);
}

// Stale CAS: the server refuses, the page says so and shows the current state it re-read.
{
  const {dom} = run({reads: [readOf('active', {control: control('active', 7)}), readOf('paused', {control: control('paused', 9)})], answers: [{status: 409, body: {ok: false, outcome: 'rejected', action: 'pause', control: control('paused', 9)}}]});
  await settle();
  for (const fn of dom.node('#settings-toggle').listeners.change) fn();
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, /отклонено\. Состояние изменилось после чтения/);
  assert.match(dom.node('#settings-outcome').className, /admin-state-error/);
  assert.equal(dom.node('#settings-toggle').checked, false);
}

// Uncertain: a 503 with outcome unknown and a network failure both say the result is unknown and re-read.
for (const answer of [{status: 503, body: {error: 'readback_failed', outcome: 'unknown'}}, 'throw']) {
  const {dom, requests} = run({read: readOf('paused'), answers: [answer]});
  await settle();
  for (const fn of dom.node('#settings-toggle').listeners.change) fn();
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, /итог неизвестен/);
  assert.match(dom.node('#settings-outcome').className, /admin-state-stale/);
  assert.equal(requests.filter(r => r.method === 'POST')[0].body.action, 'resume');
  assert.equal(requests.filter(r => r.method === 'GET').length, 2);
}

// Pause with a run still draining shows the lease expiry as the bound; active cooldowns and problem rows are listed.
{
  const read = readOf('paused', {draining: {leaseUntil: Date.now() + 90000}, cooldowns: [{scope: 'tmdb', untilAt: Date.now() + 600000, reason: 'rate_limited'}, {scope: 'wikidata', untilAt: 1, reason: 'old'}],
    attention: [{filmId: 'film:tt1', part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', reason: 'x', failureClass: 'http', failures: 3, retryAt: null, updatedAt: '2026-11-27T10:00:00.000Z', retry: {action: 'retry', filmId: 'film:tt1', part: 'core', source: 'tmdb'}}]});
  const {dom} = run({read});
  await settle();
  assert.match(dom.node('#settings-drain').innerHTML, /срок его аренды/);
  assert.match(dom.node('#settings-drain').innerHTML, /осталось около (?:89|90) с/);
  assert.match(dom.node('#settings-cooldowns').innerHTML, /tmdb/);
  assert.doesNotMatch(dom.node('#settings-cooldowns').innerHTML, /wikidata/, 'an expired cooldown is not active');
  assert.match(dom.node('#settings-attention').innerHTML, /data-retry-index="0"/);
  assert.match(dom.node('#settings-attention').innerHTML, /film:tt1/);
}

// The retry body carries exactly the rows the owner saw.
{
  const context = vm.createContext({});
  vm.runInContext(bundleAdmin([sources[2]]), context);
  const row = (part, source, status) => ({filmId: 'film:a', part, source, slot: 0, status, updatedAt: '2026-11-27T10:00:00.000Z', retry: {action: 'retry', filmId: 'film:a', part: part === 'film' ? undefined : part, source: source === '*' ? undefined : source}});
  const read = {attention: [row('film', '*', 'identity_disagreement'), row('core', 'tmdb', 'needs_attention'), {...row('core', 'tmdb', 'needs_attention'), filmId: 'film:b'}]};
  const body = vm.runInContext('catalogSettingsRetryBody', context)(read, 0, 'cu:request-id');
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {action: 'retry', filmId: 'film:a', expectedRows: [
    {part: 'film', source: '*', slot: 0, status: 'identity_disagreement', updatedAt: '2026-11-27T10:00:00.000Z'},
    {part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', updatedAt: '2026-11-27T10:00:00.000Z'}], requestId: 'cu:request-id'});
  assert.equal(vm.runInContext('catalogSettingsRetryBody', context)(read, 9, 'cu:request-id'), null);
}
console.log('admin settings page ok');
