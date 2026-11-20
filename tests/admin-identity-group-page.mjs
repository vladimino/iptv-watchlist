// AIR-131 / ADR 0181: the owner group page /admin/identity/group. Static boundary, the pure view (escaping, coverage wording, locking),
// the client (one GET, two POSTs, one receipt GET, no retry), the real page script on a minimal fake DOM, and the two read-only entries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as G from '../src/domain/discovery-identity-group.js';

const html = fs.readFileSync('public/admin-identity-group.html', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
assert.match(html, /<script src="\/admin-identity-group\.js"><\/script>/);
assert.doesNotMatch(html, /admin-limbo\.js|admin-identity\.js|admin-identity-revoke\.js/, 'it shares no bundle with the Limbo page, the queue or the revoke page');
assert.doesNotMatch(html, /\son[a-z]+=|<script>[^<]/i, 'no inline handler or script');
assert.match(html, /<a href="\/admin\/identity" data-return-carry>Идентификация<\/a>/, 'the queue is one link away');
for (const id of ['group-confirm-form', 'group-list-box', 'group-staged', 'group-result']) assert.match(html, new RegExp('id="' + id + '"[^>]*hidden'), id + ' stays hidden until a preview allows it');
assert.match(build, /assets\['\/admin\/identity\/group'\]=\{body:fs\.readFileSync\('public\/admin-identity-group\.html'/);
assert.match(build, /assets\['\/admin-identity-group\.js'\]=\{body:bundleAdmin\(\[fs\.readFileSync\('src\/admin\/identity-group-client\.js'/);
for (const own of ['/admin-limbo.js', '/admin-identity.js', '/admin-identity-revoke.js']) {
  const start = build.indexOf("assets['" + own + "']");
  assert.ok(!build.slice(start, build.indexOf('\n', start)).includes('identity-group'), own + ' holds no group file');
}

const context = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: ''}, globalThis: {}});
for (const file of ['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
const run = code => vm.runInContext(code, context);
const calls = [];
const reply = (status, body) => ({ok: status < 400, status, json: async () => body});
const fetchWith = answer => async (url, init) => { calls.push({url, init}); return answer; };
Object.assign(context, {reply, fetchWith, calls});

// Client: one GET, no body, no action header; two POSTs with the owner action header and a fresh key; the receipt GET.
let result = await run("groupPreviewGet('500', {fetch: fetchWith(reply(200, {available: true}))})");
assert.equal(result.ok, true);
assert.equal(calls[0].url, '/api/admin/discovery-recovery/group-preview?tmdbId=500');
assert.equal(calls[0].init.method, undefined);
assert.equal(calls[0].init.body, undefined);
calls.length = 0;
await run("groupReceiptGet('group-0123456789abcdef', {fetch: fetchWith(reply(200, {outcomes: []}))})");
assert.equal(calls[0].url, '/api/admin/discovery-recovery/group-receipt?groupKey=group-0123456789abcdef');
calls.length = 0;
await run("groupConfirmPost({tmdbId: '500', keys: ['a'], basis: 'b', pin: 'D1.x'}, {fetch: fetchWith(reply(200, {confirmation: {a: 1}}))})");
assert.equal(calls.length, 1);
assert.equal(calls[0].url, '/api/admin/discovery-recovery/group-confirm');
assert.equal(calls[0].init.method, 'POST');
assert.equal(calls[0].init.headers['X-IPTV-Admin-Action'], 'discovery_identity_correct');
assert.equal(calls[0].init.credentials, 'same-origin');
const sent = JSON.parse(calls[0].init.body);
assert.equal(sent.accepted, true);
assert.match(sent.idempotencyKey, /^group-[0-9a-f]{36}$/);
assert.ok(G.GROUP_KEY_PATTERN.test(sent.idempotencyKey), 'the key satisfies the server pattern, with room for the child suffix');
calls.length = 0;
await run("groupExecutePost({capability: 'x'}, {fetch: fetchWith(reply(409, {refusal: 'in_progress'}))})");
assert.equal(calls.length, 1, 'an unknown outcome is not retried');
assert.equal(calls[0].url, '/api/admin/discovery-recovery/group-execute');
result = await run("groupExecutePost({}, {fetch: async () => { throw new Error('offline'); }})");
assert.deepEqual([result.ok, result.error, result.status], [false, 'network', 0]);

// View: every reason the domain and the identity gate can answer has wording; stored text is escaped; coverage is always partial.
const copy = run('GROUP_REASON_COPY');
for (const reason of G.GROUP_REASONS) assert.equal(typeof copy[reason], 'string', reason);
for (const reason of ['year_conflict', 'tmdb_tv', 'already_current', 'identity_inconsistent', 'conflicting_identity', 'ambiguous_needs_stronger', 'film_year_unknown', 'year_unknown', 'catalogue_unread', 'invalid_movie_id']) assert.equal(typeof copy[reason], 'string', 'single-key gate reason ' + reason);
assert.match(run("groupReasonText('nope')"), /код: nope/, 'an unknown code is shown by code, not hidden');
const hostile = {film: {tmdbId: '500', title: '<img src=x onerror=1>', year: 2001, runtime: 95}, coverage: {kind: 'partial', anchors: [{anchor: '<b>a</b>', returned: 25, more: true}], anchorsOmitted: 1, merged: 60, shown: 50, dropped: 10, truncated: true},
  rows: [{key: '<script>k</script>|2001', observation: {title: '"><svg onload=1>', year: 2001, durations: [95]}, decision: {status: 'needs_verification'}, shows: [{channel: '<i>c</i>', start: 1000}], selectable: true, reasons: [], info: ['runtime_unknown'], runtime: {diffMinutes: 3, toleranceMinutes: 15}, yearGap: 0, plan: {before: {status: 'needs_verification'}, after: {status: 'verified', tmdbId: '500'}}},
    {key: 'k2|2010', observation: {title: 'Remake', year: 2010, durations: [95]}, decision: {status: 'needs_verification'}, shows: [], selectable: false, reasons: ['year_conflict'], info: [], runtime: null, yearGap: 9, plan: null}]};
context.hostile = hostile;
const painted = run('groupFilmHtml(hostile) + groupCoverageHtml(hostile) + groupRowsHtml(hostile, new Set(), false)');
assert.doesNotMatch(painted, /<img|<script|<svg|<i>|<b>a/, 'nothing stored is rendered as markup');
assert.ok(painted.includes('&lt;script&gt;k&lt;/script&gt;') && painted.includes('&quot;&gt;&lt;svg'), 'stored text is escaped, not dropped');
assert.match(painted, /Покрытие <b>частичное<\/b>/);
assert.match(painted, /Найдено 60, показано 50, отброшено 10/, 'every count is shown');
assert.match(painted, /Не использовано якорей: 1/);
assert.match(painted, /не находятся/, 'the gap is stated');
assert.match(painted, /data-group-key="k2\|2010"[^>]*disabled/, 'an unselectable key cannot be ticked');
assert.match(painted, /ремейк|другое издание/, 'the remake refusal is explained');
assert.match(run('groupRowsHtml({rows: []}, new Set(), false)'), /не доказывает/, 'an empty list is not a proof of absence');
assert.doesNotMatch(run("groupRowsHtml(hostile, new Set(), false)").split('data-group-key="k2|2010"')[0], /checked/, 'nothing is selected for the owner');
assert.match(run("groupRowsHtml(hostile, new Set(['<script>k</script>|2001']), true)"), /checked[^>]*disabled|disabled[^>]*checked/, 'while locked a ticked key stays ticked and cannot change');

// The page script on a minimal fake DOM.
{
  const elements = new Map();
  const make = id => {
    const listeners = new Map();
    const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() {}, setAttribute() {}, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      fire(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element, ...extra}); },
      querySelectorAll() { return []; }};
    elements.set(id, element);
    return element;
  };
  for (const id of ['group-form', 'group-tmdb', 'group-preview-button', 'group-loading', 'group-error', 'group-film', 'group-coverage', 'group-writer', 'group-list-box', 'group-list', 'group-count', 'group-confirm-form', 'group-basis', 'group-accept', 'group-accept-text', 'group-confirm-button', 'group-staged', 'group-plan', 'group-execute-button', 'group-cancel-button', 'group-result', 'group-recover', 'group-recover-text', 'group-recover-button', 'group-recover-dismiss']) make(id);
  const requests = [];
  const row = (key, selectable = true) => ({key, observation: {title: key, year: 2001, durations: [95]}, decision: {status: 'needs_verification'}, shows: [], selectable, reasons: selectable ? [] : ['year_conflict'], info: [], runtime: null, yearGap: 0, plan: {before: {status: 'needs_verification'}, after: {status: 'verified', tmdbId: '500'}}, version: 'v'});
  const rows = Array.from({length: 12}, (_, i) => row('k' + String(i).padStart(2, '0'))).concat(row('zz', false));
  const preview = {tmdbId: '500', available: true, pin: 'D1.' + 'a'.repeat(32), film: {tmdbId: '500', title: 'Тихий берег', year: 2001, runtime: 95}, coverage: {kind: 'partial', anchors: [], anchorsOmitted: 0, merged: 13, shown: 13, dropped: 0}, writerActive: false, rows};
  const answers = {
    'group-preview': () => ({ok: true, status: 200, json: async () => preview}),
    'group-confirm': body => ({ok: true, status: 200, json: async () => ({confirmation: {capability: 'x', idempotencyKey: body.idempotencyKey}, members: body.keys.map((key, index) => ({key, index: index + 1, plan: rows[0].plan}))})}),
    'group-execute': () => ({ok: true, status: 200, json: async () => ({state: 'applied', outcomes: [{key: 'k00', index: 1, outcome: 'applied'}]})}),
    'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, outcomes: [{index: 1, outcome: 'applied'}]})}),
  };
  const bodies = {};
  const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: '?tmdbId=500'},
    document: {querySelector: selector => elements.get(selector.slice(1)) || null},
    fetch: async (url, init) => { const route = String(url).split('/').pop().split('?')[0]; requests.push(route); if (init && init.body) bodies[route] = JSON.parse(init.body); return answers[route](bodies[route]); }});
  vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
  const el = id => elements.get(id);
  const wait = () => new Promise(resolve => setTimeout(resolve, 0));
  const tick = key => ({getAttribute: name => (name === 'data-group-key' ? key : null), checked: true});
  assert.equal(el('group-tmdb').value, '500', 'a link prefills the id');
  assert.deepEqual(requests, [], 'nothing is requested on load');
  assert.equal(el('group-confirm-form').hidden, true);
  el('group-form').fire('submit'); await wait();
  assert.deepEqual(requests, ['group-preview']);
  assert.equal(el('group-list-box').hidden, false);
  assert.match(el('group-count').textContent, /Выбрано: 0 из не более 10\. Ничего не выбрано за вас/, 'nothing is selected for the owner');
  assert.equal(el('group-confirm-form').hidden, true, 'no confirmation form without a selection');
  // Tick keys; the 11th is refused.
  for (let i = 0; i < 11; i++) { const box = tick('k' + String(i).padStart(2, '0')); el('group-list').fire('change', {target: box}); }
  assert.match(el('group-count').textContent, /Выбрано: 10 из/, 'the cap is 10');
  assert.equal(el('group-confirm-form').hidden, false);
  assert.equal(el('group-confirm-button').disabled, true, 'confirm needs the basis and the acknowledgement');
  el('group-basis').value = 'это тот фильм'; el('group-basis').fire('input');
  el('group-accept').checked = true; el('group-accept').fire('change');
  assert.equal(el('group-confirm-button').disabled, false);
  assert.match(el('group-accept-text').textContent, /набор из 10 наблюдений для фильма «Тихий берег»/, 'the acknowledgement names the exact set size and film');
  el('group-confirm-form').fire('submit'); await wait();
  assert.deepEqual(requests, ['group-preview', 'group-confirm']);
  assert.deepEqual(bodies['group-confirm'].keys.length, 10);
  assert.equal(bodies['group-confirm'].tmdbId, '500');
  assert.equal(el('group-staged').hidden, false, 'the staged set is shown with its plan');
  assert.match(el('group-plan').innerHTML, /<ol class="group-members">/);
  assert.equal(el('group-confirm-form').hidden, true, 'one staged mutation at a time');
  // A change while staged is ignored.
  el('group-list').fire('change', {target: {getAttribute: () => 'k00', checked: false}});
  assert.match(el('group-count').textContent, /Выбрано: 10 из/, 'the staged selection cannot change (un-ticking a staged key is ignored)');
  el('group-execute-button').fire('click'); await wait(); await wait();
  assert.deepEqual(requests, ['group-preview', 'group-confirm', 'group-execute', 'group-receipt', 'group-preview'], 'execute, then the stored read-back, then a fresh preview');
  assert.equal(el('group-result').hidden, false);
  assert.match(el('group-result').innerHTML, /Все выбранные наблюдения записаны/);
  assert.match(el('group-result').innerHTML, /Чтение из D1 после записи/, 'the receipt is read back from D1');
  assert.equal(el('group-staged').hidden, true);
  assert.match(el('group-count').textContent, /Выбрано: 0 из/, 'the selection is cleared after a write');
  // A refusal of the confirmation shows the failing keys and stages nothing.
  answers['group-confirm'] = () => ({ok: false, status: 409, json: async () => ({refusal: 'group_selection_changed', failing: [{id: 'k00', reason: 'runtime_conflict'}]})});
  el('group-list').fire('change', {target: tick('k00')});
  el('group-basis').value = 'b'; el('group-basis').fire('input'); el('group-accept').checked = true; el('group-accept').fire('change');
  el('group-confirm-form').fire('submit'); await wait();
  assert.match(el('group-error').textContent, /k00: Длительность наблюдения расходится/, 'the failing key and its reason are shown');
  assert.equal(el('group-staged').hidden, true, 'a refused confirmation stages nothing');
  assert.equal(el('group-accept').checked, false);
  // Review P1: a lost response never loses the group. The key exists before the POST, is kept, and nothing is repeated by itself.
  const attempt = async () => { el('group-basis').value = 'b'; el('group-basis').fire('input'); el('group-accept').checked = true; el('group-accept').fire('change'); el('group-confirm-form').fire('submit'); await wait(); await wait(); };
  const count = route => requests.filter(item => item === route).length;
  answers['group-confirm'] = () => { throw new Error('network lost'); };
  answers['group-receipt'] = () => ({ok: false, status: 404, json: async () => ({error: 'not_found'})});
  let postsBefore = count('group-confirm');
  await attempt();
  assert.equal(count('group-confirm'), postsBefore + 1, 'one confirm POST, no automatic retry');
  const lostKey = bodies['group-confirm'].idempotencyKey;
  assert.match(lostKey, /^group-[0-9a-f]{36}$/, 'the key was made before the POST');
  assert.equal(requests[requests.length - 1], 'group-receipt', 'after an unknown outcome the page only READS the stored group');
  assert.match(el('group-error').textContent, /ничего не записано/, 'a missing group is reported as not written');
  await attempt();
  assert.equal(bodies['group-confirm'].idempotencyKey, lostKey, 'a manual second submit reuses the SAME group key (idempotent), not an unrelated group');
  // The confirm landed in D1 but the response was lost: the receipt proves it and offers the ORIGINAL scope for a replay.
  const original = {capability: 'discovery_identity_group_assign', idempotencyKey: lostKey, ids: ['k00']};
  answers['group-receipt'] = () => ({ok: true, status: 200, json: async () => ({complete: true, groupKey: lostKey, confirmation: original, outcomes: [{key: 'k00', index: 1, state: 'approved', outcome: 'pending'}]})});
  postsBefore = count('group-confirm');
  await attempt();
  assert.equal(count('group-confirm'), postsBefore + 1);
  assert.equal(el('group-staged').hidden, false, 'a recovered, proven group can be continued by the owner');
  answers['group-execute'] = () => { throw new Error('network lost'); };
  const executes = count('group-execute');
  el('group-execute-button').fire('click'); await wait(); await wait();
  assert.deepEqual(bodies['group-execute'].confirmation, original, 'the replay carries the original issued scope');
  assert.equal(count('group-execute'), executes + 1, 'a lost execute response is not repeated automatically');
  assert.equal(requests[requests.length - 1], 'group-receipt', 'the stored children are read back instead');
  assert.match(el('group-result').innerHTML, /group-outcomes/, 'the stored per-key state is shown');
}

// A reload keeps the handle: nothing is requested on load, the owner presses one button, and only the receipt is read.
{
  const elements = new Map();
  const make = id => { const listeners = new Map(); const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() {}, setAttribute() {}, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, fire(type) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element}); }, querySelectorAll() { return []; }}; elements.set(id, element); return element; };
  for (const id of ['group-form', 'group-tmdb', 'group-preview-button', 'group-loading', 'group-error', 'group-film', 'group-coverage', 'group-writer', 'group-list-box', 'group-list', 'group-count', 'group-confirm-form', 'group-basis', 'group-accept', 'group-accept-text', 'group-confirm-button', 'group-staged', 'group-plan', 'group-execute-button', 'group-cancel-button', 'group-result', 'group-recover', 'group-recover-text', 'group-recover-button', 'group-recover-dismiss']) make(id);
  const store = new Map([['iptv-group-pending', JSON.stringify({groupKey: 'group-' + 'a'.repeat(36), tmdbId: '500'})]]);
  const requests = [];
  const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: ''},
    sessionStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)},
    document: {querySelector: selector => elements.get(selector.slice(1)) || null},
    fetch: async url => { requests.push(String(url).split('/api/admin/discovery-recovery/')[1]); return {ok: true, status: 200, json: async () => ({complete: true, confirmation: {idempotencyKey: 'x'}, outcomes: [{key: 'k00', index: 1, state: 'receipt', outcome: 'applied'}]})}; }});
  vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
  assert.deepEqual(requests, [], 'nothing is requested on load, not even the recovery read');
  assert.equal(elements.get('group-recover').hidden, false, 'an unfinished group is announced after a reload');
  assert.equal(elements.get('group-tmdb').value, '500');
  elements.get('group-recover-button').fire('click'); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['group-receipt?groupKey=group-' + 'a'.repeat(36)], 'one read-only receipt GET, no POST');
  assert.equal(store.has('iptv-group-pending'), false, 'a finished group is forgotten');
}

// Review P1: the recovery handle is forgotten only after a PROVEN terminal state, never because an HTTP 200 arrived.
{
  const IDS = ['group-pending-a', 'group-pending-b'];
  async function session(answers, {stored = null, query = '?tmdbId=500'} = {}) {
    const elements = new Map();
    const make = id => { const listeners = new Map(); const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() {}, setAttribute() {}, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, fire(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element, ...extra}); }, querySelectorAll() { return []; }}; elements.set(id, element); return element; };
    for (const id of ['group-form', 'group-tmdb', 'group-preview-button', 'group-loading', 'group-error', 'group-film', 'group-coverage', 'group-writer', 'group-list-box', 'group-list', 'group-count', 'group-confirm-form', 'group-basis', 'group-accept', 'group-accept-text', 'group-confirm-button', 'group-staged', 'group-plan', 'group-execute-button', 'group-cancel-button', 'group-result', 'group-recover', 'group-recover-text', 'group-recover-button', 'group-recover-dismiss']) make(id);
    const store = new Map(stored ? [['iptv-group-pending', stored]] : []);
    const requests = [], bodies = {};
    const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: query},
      sessionStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)},
      document: {querySelector: selector => elements.get(selector.slice(1)) || null},
      fetch: async (url, init) => { const route = String(url).split('/').pop().split('?')[0]; requests.push(route); if (init && init.body) bodies[route] = JSON.parse(init.body); return answers[route](bodies[route]); }});
    vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
    const el = id => elements.get(id), wait = () => new Promise(resolve => setTimeout(resolve, 0));
    return {el, store, requests, bodies, wait, flush: async () => { for (let i = 0; i < 4; i++) await wait(); }};
  }
  const rowsOf = n => Array.from({length: n}, (_, i) => ({key: 'k' + i, observation: {title: 'k' + i, year: 2001, durations: [95]}, decision: {status: 'needs_verification'}, shows: [], selectable: true, reasons: [], info: [], runtime: null, yearGap: 0, plan: {before: {status: 'needs_verification'}, after: {status: 'verified', tmdbId: '500'}}}));
  const previewBody = {tmdbId: '500', available: true, pin: 'D1.' + 'a'.repeat(32), film: {tmdbId: '500', title: 'Т', year: 2001, runtime: 95}, coverage: {kind: 'partial', anchors: [], anchorsOmitted: 0, merged: 2, shown: 2, dropped: 0}, writerActive: false, rows: rowsOf(2)};
  const confirmation = {capability: 'discovery_identity_group_assign', idempotencyKey: 'will-be-replaced', ids: ['k0', 'k1']};
  const run = async answers => {
    const page = await session(answers);
    page.el('group-form').fire('submit'); await page.flush();
    for (const key of ['k0', 'k1']) page.el('group-list').fire('change', {target: {getAttribute: () => key, checked: true}});
    page.el('group-basis').value = 'b'; page.el('group-basis').fire('input'); page.el('group-accept').checked = true; page.el('group-accept').fire('change');
    page.el('group-confirm-form').fire('submit'); await page.flush();
    page.el('group-execute-button').fire('click'); await page.flush();
    return page;
  };
  const base = {
    'group-preview': () => ({ok: true, status: 200, json: async () => previewBody}),
    'group-confirm': body => ({ok: true, status: 200, json: async () => ({confirmation: {...confirmation, idempotencyKey: body.idempotencyKey}, members: body.keys.map((key, index) => ({key, index: index + 1, plan: null}))})}),
  };
  // (a) HTTP 200, state unknown: receipt, running, not_attempted.
  const unknown = await run({...base,
    'group-execute': () => ({ok: true, status: 200, json: async () => ({state: 'unknown', outcomes: [{key: 'k0', index: 1, outcome: 'applied'}, {key: 'k1', index: 2, outcome: 'unknown'}]})}),
    'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'receipt', outcome: 'applied'}, {key: 'k1', index: 2, state: 'running', outcome: 'unknown'}]})})});
  assert.equal(unknown.store.has('iptv-group-pending'), true, 'HTTP 200 with state unknown keeps the group handle');
  assert.equal(unknown.el('group-recover').hidden, false, 'and the read-only recovery control');
  assert.equal(unknown.el('group-staged').hidden, true, 'an unknown child is not offered for replay');
  // (b) HTTP 200, partial: approved children remain.
  const partial = await run({...base,
    'group-execute': () => ({ok: true, status: 200, json: async () => ({state: 'partial', outcomes: [{key: 'k0', index: 1, outcome: 'applied'}, {key: 'k1', index: 2, outcome: 'not_attempted', reason: 'generation_moved'}]})}),
    'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'receipt', outcome: 'applied'}, {key: 'k1', index: 2, state: 'approved', outcome: 'pending'}]})})});
  assert.equal(partial.store.has('iptv-group-pending'), true, 'a partial group keeps its handle');
  assert.equal(partial.el('group-recover').hidden, false);
  partial.el('group-recover-button').fire('click'); await partial.flush();
  assert.equal(partial.el('group-staged').hidden, false, 'the receipt-less child can be continued with the original scope');
  assert.equal(partial.store.has('iptv-group-pending'), true, 'still remembered until proven terminal');
  partial.el('group-recover-dismiss').fire('click'); await partial.flush();
  assert.equal(partial.store.has('iptv-group-pending'), false, 'only a deliberate dismissal forgets an unfinished group');
  // (c) a lost execute response, readback with the sole child running, then a reload with the SAME group key.
  const key = 'group-' + 'b'.repeat(36);
  const running = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'running', outcome: 'unknown'}]})})}, {stored: JSON.stringify({groupKey: key, tmdbId: '500'})});
  assert.deepEqual(running.requests, [], 'nothing is requested on load');
  running.el('group-recover-button').fire('click'); await running.flush();
  assert.equal(running.store.has('iptv-group-pending'), true, 'a running child never clears the handle');
  assert.equal(running.el('group-staged').hidden, true, 'a running child is not resumable');
  const reloaded = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'running', outcome: 'unknown'}]})})}, {stored: running.store.get('iptv-group-pending')});
  reloaded.el('group-recover-button').fire('click'); await reloaded.flush();
  assert.deepEqual(reloaded.requests, ['group-receipt?groupKey=' + key].map(item => item.split('?')[0]), 'after the reload the same key supports a manual read-only check');
  assert.equal(reloaded.requests.filter(route => route !== 'group-receipt').length, 0, 'no POST');
  // A fully applied group is the proven terminal state.
  const done = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'receipt', outcome: 'applied'}]})})}, {stored: JSON.stringify({groupKey: key, tmdbId: '500'})});
  done.el('group-recover-button').fire('click'); await done.flush();
  assert.equal(done.store.has('iptv-group-pending'), false, 'forgotten only after a proven terminal state');
  void IDS;
}

// The two read-only entries: the queue row and the Limbo detail.
{
  const qctx = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/admin/identity-work-view.js', 'utf8'), qctx);
  const rowHtml = qctx.iwRowHtml({key: 'film:tmdb_500', type: 'film', status: 'x', reason: null, disposition: 'blocked', title: 'Тихий берег', year: 2001, film: {filmId: 'tmdb_500', proof: 'canonical'}, provenance: []});
  assert.match(rowHtml, /href="\/admin\/identity\/group\?tmdbId=500"/, 'a Film row links to the group page');
  assert.doesNotMatch(rowHtml, /<form|method=/, 'the queue gets an anchor, not a form');
  assert.doesNotMatch(qctx.iwRowHtml({key: 'epg:k', type: 'epg_observation', status: 'x', disposition: 'blocked', title: 't', provenance: []}), /identity\/group/, 'a row without a trusted movie has no link');
  assert.doesNotMatch(qctx.iwRowHtml({key: 'film:tmdb_tv_5', type: 'film', status: 'x', disposition: 'blocked', title: 't', film: {filmId: 'tmdb_tv_5'}, provenance: []}), /identity\/group/, 'a television id has no link');
  const vctx = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/admin/discovery-recovery-view.js', 'utf8').replace(/^export /gm, ''), vctx);
  const answer = trusted => ({identity: {available: false, reason: 'index_not_current', coverage: {}, trusted}, observation: {key: 'k|2001'}, target: {key: 'k|2001'}});
  const linked = vctx.obsRecoveryPanelHtml({...answer([{tmdbId: '500', source: 'confirmed_tmdb'}]), assessment: null}, {slot: 'o1'});
  assert.ok(linked.includes('/admin/identity/group?tmdbId=500') || vctx.obsGroupEntryHtml(answer([{tmdbId: '500'}])).includes('/admin/identity/group?tmdbId=500'), 'a confirmed id offers the group page');
  assert.equal(vctx.obsGroupEntryHtml(answer([])), '', 'no trusted id, no link');
  assert.equal(vctx.obsGroupEntryHtml(answer([{tmdbId: '5"><script>'}])), '', 'a hostile id is not a link');
}
console.log('admin-identity-group-page: ok');
