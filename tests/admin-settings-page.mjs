// The /admin/settings page (card CU, AIR-611; ADR 0219): static boundary of the page and its bundle, the pure view logic, and the page script against a DOM stand-in with a fake fetch. Opening the page reads only; the checkbox sends
// exactly one pause or resume compare-and-swap request; reads and writes are serialized and every control stays disabled until a VALID fresh read succeeds; the POST evidence is separate from the read status; a disabled box sends nothing; no activation, no second flag and no other write route exist on the page.
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
  const retryButtons = [];
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = {};
      nodes.set(selector, {selector, hidden: false, disabled: false, checked: false, textContent: '', innerHTML: '', className: '', listeners,
        addEventListener(type, fn) {(listeners[type] ||= []).push(fn);}, getAttribute: () => null, closest: () => null});
    }
    return nodes.get(selector);
  };
  const click = index => ({target: {closest: () => ({getAttribute: () => String(index)})}});
  return {nodes, node, click, retryButtons, document: {querySelector: node, querySelectorAll: selector => selector === '.settings-retry' ? retryButtons : []}};
}
// A spec is {status, body, raw, throw, gate}: `gate` is a promise the answer waits for, so a test decides when each request finishes.
function run({reads = [], answers = []}) {
  const dom = makeDom();
  const requests = [];
  let readIndex = 0;
  const queue = [...answers];
  const answer = async spec => {
    if (spec.gate) await spec.gate;
    if (spec.throw) throw new TypeError('offline');
    const payload = spec.raw !== undefined ? spec.raw : JSON.stringify(spec.body ?? {});
    return new Response(payload, {status: spec.status ?? 200, headers: {'Content-Type': spec.raw !== undefined ? 'text/html' : 'application/json'}});
  };
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const method = init.method || 'GET';
    requests.push({method, path: url.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null});
    if (method === 'GET') {
      const spec = reads[Math.min(readIndex++, reads.length - 1)];
      return answer(spec.configured !== undefined || spec.control !== undefined || spec.status === undefined && spec.body === undefined && spec.raw === undefined && !spec.throw && !spec.gate ? {body: spec} : spec);
    }
    return answer(queue.shift());
  };
  const context = vm.createContext({document: dom.document, fetch: fakeFetch, Response, URLSearchParams, Intl, Date, JSON, Math, Number, String, Object, Array, globalThis: undefined, crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000000'}});
  context.globalThis = context;
  vm.runInContext(bundle, context);
  return {dom, requests, context, posts: () => requests.filter(r => r.method === 'POST'), gets: () => requests.filter(r => r.method === 'GET')};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => {for (let i = 0; i < 20; i++) await tick();};
const control = (state, revision = 3) => ({state, generation: revision, revision, updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'owner'});
const readOf = (state, extra = {}) => ({configured: true, control: control(state), scopes: [], lastRun: null, draining: null, signals: {pending: 2, oldestArmedAt: null}, due: {films: 4, oldestDueSince: null}, cooldowns: [], attention: [], attentionTruncated: false, ...extra});
const change = dom => {for (const fn of dom.node('#settings-toggle').listeners.change) fn();};
const reread = dom => {for (const fn of dom.node('#settings-reread').listeners.click) fn();};
const gate = () => {let open; const promise = new Promise(resolve => {open = resolve;}); return {promise, open};};
const applied = (action, revision) => ({status: 200, body: {ok: true, outcome: 'applied', action, requestId: '', control: control(action === 'pause' ? 'paused' : 'active', revision)}});

// A POST answer echoes the request id, so the fake answer takes it from what was actually sent.
async function runWithEcho(options) {
  const env = run(options);
  const queue = options.answers;
  const original = env.context.fetch;
  env.context.fetch = async (input, init = {}) => {
    if ((init.method || 'GET') === 'POST') {
      const sent = JSON.parse(init.body);
      const spec = queue.shift();
      if (spec.body && spec.body.requestId === '') spec.body.requestId = sent.requestId;
      queue.unshift(spec);
    }
    return original(input, init);
  };
  return env;
}

// Opening the page reads once and sends nothing else; the box is writable only after that read.
{
  const {dom, requests} = run({reads: [readOf('active')]});
  assert.equal(dom.node('#settings-toggle').disabled, true, 'disabled before any read');
  await settle();
  assert.deepEqual(requests.map(r => r.method + ' ' + r.path), ['GET /api/admin/settings']);
  const box = dom.node('#settings-toggle');
  assert.equal(box.checked, true);
  assert.equal(box.disabled, false);
  assert.match(dom.node('#settings-snapshot-text').textContent, /^Прочитано /);
}

// Inactive and unreadable: the box is disabled and a change event sends nothing (no activation from the UI).
for (const read of [readOf('inactive', {control: control('inactive', 0)}), {configured: false, reason: 'schema_missing', state: 'inactive'}]) {
  const {dom, posts} = run({reads: [read]});
  await settle();
  const box = dom.node('#settings-toggle');
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  change(dom);
  await settle();
  assert.equal(posts().length, 0, 'a disabled box writes nothing');
}

// Unknown diagnostics are shown as unknown, never as empty: initial, failed read, schema_missing, no_database and a malformed 200.
for (const [name, reads] of [['failed read', [{status: 503, body: {error: 'unavailable'}}]], ['schema_missing', [{configured: false, reason: 'schema_missing', state: 'inactive'}]], ['no_database', [{configured: false, reason: 'no_database'}]],
  ['malformed 200', [{status: 200, body: {hello: 1}}]], ['html 200', [{status: 200, raw: '<html>Access login</html>'}]]]) {
  const {dom} = run({reads});
  await settle();
  for (const id of ['#settings-scopes', '#settings-cooldowns', '#settings-attention', '#settings-backlog', '#settings-drain']) assert.match(dom.node(id).innerHTML, /Неизвестно/, name + ' ' + id);
  assert.doesNotMatch(dom.node('#settings-scopes').innerHTML, /Областей нет/, name);
  assert.doesNotMatch(dom.node('#settings-attention').innerHTML, /нет строк/, name);
  assert.equal(dom.node('#settings-toggle').disabled, true, name);
}
{
  const {dom} = run({reads: [{gate: new Promise(() => {}), body: readOf('active')}]});
  await settle();
  assert.match(dom.node('#settings-scopes').innerHTML, /Неизвестно/, 'before the first answer the diagnostics are unknown');
}
// A malformed control never becomes a writable revision.
for (const control_ of [{state: 'active', generation: 1, revision: '7'}, {state: 'active', generation: 1}, {state: 'exploded', generation: 1, revision: 1}, {state: 'active', generation: 1, revision: -1}]) {
  const {dom, posts} = run({reads: [{...readOf('active'), control: control_}]});
  await settle();
  assert.equal(dom.node('#settings-toggle').disabled, true, JSON.stringify(control_));
  change(dom);
  await settle();
  assert.equal(posts().length, 0);
}
// Valid zero and empty values are shown as such, and a missing field is unknown while its neighbours stay known.
{
  const {dom} = run({reads: [readOf('active', {cooldowns: undefined})]});
  await settle();
  assert.match(dom.node('#settings-scopes').innerHTML, /Областей нет/);
  assert.match(dom.node('#settings-attention').innerHTML, /нет строк/);
  assert.match(dom.node('#settings-cooldowns').innerHTML, /Неизвестно/);
}
assert.match(html, /Пустой список здесь не доказывает отсутствия проблем/, 'the server limitation is disclosed');

// Active -> unchecking sends one pause with the revision the owner saw, then reads again.
{
  const {dom, posts, gets} = await runWithEcho({reads: [readOf('active', {control: control('active', 7)}), readOf('paused', {control: control('paused', 8)})], answers: [applied('pause', 8)]});
  await settle();
  change(dom);
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, '/api/admin/settings/catalog-enrichment');
  assert.equal(posts()[0].headers['X-IPTV-Admin-Action'], 'catalog_enrichment_settings');
  assert.deepEqual({...posts()[0].body, requestId: 'x'}, {action: 'pause', expectedRevision: 7, requestId: 'x'});
  assert.match(posts()[0].body.requestId, /^[A-Za-z0-9:._-]{8,100}$/);
  assert.equal(gets().length, 2);
  assert.match(dom.node('#settings-outcome').textContent, /сервер подтвердил запись/);
  assert.doesNotMatch(dom.node('#settings-outcome').textContent, /перечитыв|перечитала/, 'the outcome line claims nothing about the read');
  assert.equal(dom.node('#settings-toggle').checked, false);
  assert.equal(dom.node('#settings-toggle').disabled, false, 'writable again after a valid read');
}

// Serialization: while the POST (and then its readback) is in flight nothing else starts, and the controls are locked.
{
  const post = gate(), readback = gate();
  const {dom, posts, gets} = await runWithEcho({reads: [readOf('active', {control: control('active', 7)}), {gate: readback.promise, body: readOf('paused', {control: control('paused', 8)})}], answers: [{...applied('pause', 8), gate: post.promise}]});
  await settle();
  change(dom);
  await settle();
  assert.equal(dom.node('#settings-toggle').disabled, true);
  assert.equal(dom.node('#settings-reread').disabled, true);
  reread(dom); change(dom);
  await settle();
  assert.equal(posts().length, 1, 'no second POST during the first');
  assert.equal(gets().length, 1, 'no competing GET during the POST');
  post.open(); await settle();
  assert.equal(gets().length, 2, 'the readback has started');
  assert.equal(dom.node('#settings-toggle').disabled, true, 'still locked until the readback is valid');
  reread(dom); change(dom);
  await settle();
  assert.equal(gets().length, 2, 'no competing GET during the readback');
  assert.equal(posts().length, 1);
  readback.open(); await settle();
  assert.equal(dom.node('#settings-toggle').disabled, false);
  assert.equal(dom.node('#settings-toggle').checked, false);
  assert.equal(dom.node('#settings-reread').disabled, false);
}

// A failed readback after applied, rejected and unknown keeps the old snapshot labelled stale with ITS read time, disables every write control, and a successful manual read restores them.
for (const [name, answer, outcomeText] of [['applied', applied('pause', 8), /сервер подтвердил запись/], ['rejected', {status: 409, body: {ok: false, outcome: 'rejected', action: 'pause', control: control('paused', 9)}}, /отклонено/], ['unknown', {status: 503, body: {error: 'readback_failed', outcome: 'unknown'}}, /итог неизвестен/]]) {
  const {dom, posts, gets} = await runWithEcho({reads: [readOf('active', {control: control('active', 7), attention: [{filmId: 'film:a', part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', updatedAt: '2026-11-27T10:00:00.000Z'}]}), {status: 503, body: {error: 'unavailable'}}, readOf('paused', {control: control('paused', 8)})], answers: [answer]});
  dom.retryButtons.push({disabled: false});
  await settle();
  const first = dom.node('#settings-snapshot-text').textContent;
  assert.match(first, /^Прочитано /);
  await new Promise(resolve => setTimeout(resolve, 5));
  change(dom);
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, outcomeText, name);
  assert.doesNotMatch(dom.node('#settings-outcome').textContent, /перечитыв|перечитала|список перечитан/, name);
  assert.match(dom.node('#settings-snapshot-text').textContent, /Данные устарели: последнее успешное чтение/, name);
  assert.equal(dom.node('#settings-toggle').disabled, true, name + ': the stale box is not writable');
  assert.equal(dom.retryButtons[0].disabled, true, name + ': the stale retry buttons are not writable');
  assert.equal(dom.node('#settings-error').hidden, false);
  change(dom); dom.node('#settings-attention').listeners.click[0](dom.click(0));
  await settle();
  assert.equal(posts().length, 1, name + ': nothing is written from a stale snapshot');
  reread(dom);
  await settle();
  assert.equal(gets().length, 3);
  assert.match(dom.node('#settings-snapshot-text').textContent, /^Прочитано /, name);
  assert.equal(dom.node('#settings-toggle').disabled, false, name + ': restored only by a successful read');
  assert.equal(dom.node('#settings-error').hidden, true);
}

// A failed manual reread also locks the page; the old snapshot keeps its own time.
{
  const {dom} = run({reads: [readOf('active'), {throw: true}]});
  await settle();
  const at = dom.node('#settings-snapshot-text').textContent.replace(/^Прочитано /, '').replace(/\.$/, '');
  reread(dom);
  await settle();
  assert.equal(dom.node('#settings-toggle').disabled, true);
  assert.ok(dom.node('#settings-snapshot-text').textContent.includes(at), 'the stale label shows the last successful read time');
}

// POST evidence: a non-JSON 200 (an Access login page), a non-JSON 502, a generic 500 and a malformed envelope are UNKNOWN, never "nothing was written"; no automatic resubmission.
for (const [name, answer] of [['html 200', {status: 200, raw: '<html>login</html>'}], ['html 502', {status: 502, raw: '<html>bad gateway</html>'}], ['json 500', {status: 500, body: {error: 'boom'}}], ['500 no body', {status: 500, raw: ''}],
  ['malformed 200', {status: 200, body: {ok: true}}], ['applied for another request', {status: 200, body: {ok: true, outcome: 'applied', action: 'pause', requestId: 'someone-else'}}], ['network', {throw: true}], ['503 unknown', {status: 503, body: {error: 'storage_unavailable', outcome: 'unknown'}}], ['503 generic', {status: 503, body: {error: 'weird'}}]]) {
  const {dom, posts, gets} = run({reads: [readOf('paused')], answers: [answer]});
  await settle();
  change(dom);
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, /итог неизвестен/, name);
  assert.doesNotMatch(dom.node('#settings-outcome').textContent, /Ничего не записано|ничего не записано/, name);
  assert.match(dom.node('#settings-outcome').className, /admin-state-stale/, name);
  assert.equal(posts().length, 1, name + ': no resubmission');
  assert.equal(gets().length, 2, name + ': a read follows');
  assert.match(dom.node('#settings-outcome').textContent, /не докажет судьбу/, name);
}
// A known commit with the server's own readback missing stays applied and says so, even when the page's read then fails.
{
  const {dom} = await runWithEcho({reads: [readOf('active', {attention: [{filmId: 'film:a', part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', updatedAt: '2026-11-27T10:00:00.000Z'}]}), {status: 503, body: {error: 'unavailable'}}],
    answers: [{status: 200, body: {ok: true, outcome: 'applied', action: 'retry', requestId: '', filmId: 'film:a', retried: [{part: 'core', source: 'tmdb', slot: 0}], readback: null, readbackUnavailable: true}}]});
  await settle();
  dom.node('#settings-attention').listeners.click[0](dom.click(0));
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, /Повтор: сервер подтвердил запись\. Собственное перечитывание сервером не удалось/);
  assert.match(dom.node('#settings-outcome').className, /^admin-state$/, 'a known commit is not an error');
  assert.match(dom.node('#settings-snapshot-text').textContent, /Данные устарели/);
}
// Definite typed refusals and CAS rejections keep their "nothing was written" wording.
for (const [answer, text] of [[{status: 403, body: {error: 'origin_not_allowed'}}, /до записи.*Ничего не записано/], [{status: 503, body: {error: 'schema_missing'}}, /до записи.*Ничего не записано/], [{status: 409, body: {error: 'stale_rows', outcome: 'rejected'}}, /отклонено\. Строки изменились после чтения\. Ничего не записано/]]) {
  const {dom} = run({reads: [readOf('paused')], answers: [answer]});
  await settle();
  change(dom);
  await settle();
  assert.match(dom.node('#settings-outcome').textContent, text);
}

// Pause with a run still draining shows the lease expiry as the bound; active cooldowns and problem rows are listed with their full place.
{
  const read = readOf('paused', {draining: {leaseUntil: Date.now() + 90000}, cooldowns: [{scope: 'tmdb', untilAt: Date.now() + 600000, reason: 'rate_limited'}, {scope: 'wikidata', untilAt: 1, reason: 'old'}],
    attention: [{filmId: 'film:tt1', part: 'core', source: 'tmdb', slot: 2, status: 'needs_attention', reason: 'x', failureClass: 'http', failures: 3, retryAt: null, updatedAt: '2026-11-27T10:00:00.000Z'}]});
  const {dom} = run({reads: [read]});
  await settle();
  assert.match(dom.node('#settings-drain').innerHTML, /срок его аренды/);
  assert.match(dom.node('#settings-drain').innerHTML, /осталось около (?:89|90) с/);
  assert.match(dom.node('#settings-cooldowns').innerHTML, /tmdb/);
  assert.doesNotMatch(dom.node('#settings-cooldowns').innerHTML, /wikidata/, 'an expired cooldown is not active');
  assert.match(dom.node('#settings-attention').innerHTML, /data-retry-index="0"/);
  assert.match(dom.node('#settings-attention').innerHTML, /core \/ tmdb \/ слот 2/, 'the slot is shown');
}

// Retry scope: a real click POSTs exactly the clicked row, never the other rows of the Film, and the UI says which row that is.
{
  const at = '2026-11-27T10:00:00.000Z';
  const row = (filmId, part, source, slot, status) => ({filmId, part, source, slot, status, reason: null, failureClass: null, failures: 0, retryAt: null, updatedAt: at});
  const attention = [row('film:a', 'film', '*', 0, 'identity_disagreement'), row('film:a', 'core', 'tmdb', 0, 'needs_attention'), row('film:a', 'core', 'tmdb', 1, 'deferred_repair'), row('film:a', 'credits', 'letterboxd', 0, 'needs_attention'), row('film:b', 'core', 'tmdb', 0, 'needs_attention')];
  const expected = [
    {action: 'retry', filmId: 'film:a', expectedRows: [{part: 'film', source: '*', slot: 0, status: 'identity_disagreement', updatedAt: at}]},
    {action: 'retry', filmId: 'film:a', part: 'core', source: 'tmdb', expectedRows: [{part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', updatedAt: at}]},
    {action: 'retry', filmId: 'film:a', part: 'core', source: 'tmdb', expectedRows: [{part: 'core', source: 'tmdb', slot: 1, status: 'deferred_repair', updatedAt: at}]},
    {action: 'retry', filmId: 'film:a', part: 'credits', source: 'letterboxd', expectedRows: [{part: 'credits', source: 'letterboxd', slot: 0, status: 'needs_attention', updatedAt: at}]},
    {action: 'retry', filmId: 'film:b', part: 'core', source: 'tmdb', expectedRows: [{part: 'core', source: 'tmdb', slot: 0, status: 'needs_attention', updatedAt: at}]},
  ];
  const shown = (() => {const {dom} = run({reads: [readOf('active', {attention})]}); return dom;})();
  await settle();
  const html_ = shown.node('#settings-attention').innerHTML;
  assert.match(html_, /Охват: только строка фильма/, 'the Film-level row is disclosed as Film-level');
  assert.equal((html_.match(/Охват: только часть core · источник tmdb · слот 0/g) || []).length, 2, 'slot 0 of core/tmdb on film:a and film:b');
  assert.match(html_, /Охват: только часть core · источник tmdb · слот 1/);
  assert.match(html_, /Охват: только часть credits · источник letterboxd · слот 0/);
  assert.match(html_, /Другие строки (?:фильма )?не затрагиваются/);
  for (let index = 0; index < expected.length; index++) {
    const {dom, posts} = await runWithEcho({reads: [readOf('active', {attention}), readOf('active', {attention})], answers: [{status: 200, body: {ok: true, outcome: 'applied', action: 'retry', requestId: ''}}]});
    await settle();
    dom.node('#settings-attention').listeners.click[0](dom.click(index));
    await settle();
    assert.equal(posts().length, 1, 'click ' + index);
    const {requestId, ...sent} = posts()[0].body;
    assert.match(requestId, /^[A-Za-z0-9:._-]{8,100}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), expected[index], 'click ' + index + ' names exactly the clicked row');
  }
  // A stale snapshot or a lock sends nothing from a retry click either.
  const {dom, posts} = run({reads: [readOf('active', {attention}), {status: 503, body: {error: 'unavailable'}}]});
  await settle();
  reread(dom);
  await settle();
  dom.node('#settings-attention').listeners.click[0](dom.click(1));
  await settle();
  assert.equal(posts().length, 0);
}
console.log('admin settings page ok');
