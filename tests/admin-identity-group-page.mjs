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

const readOnly = {'identity-work': () => ({ok: true, status: 200, json: async () => ({pin: 'p', rows: [], nextCursor: null})}), films: () => ({ok: true, status: 200, json: async () => ({items: []})})};
const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
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
    const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() { this.focused = true; }, setAttribute(name, value) { this.attrs = {...this.attrs, [name]: value}; }, removeAttribute(name) { if (this.attrs) delete this.attrs[name]; }, closest() { return null; }, open: false, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      fire(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element, ...extra}); },
      querySelectorAll() { return []; }};
    elements.set(id, element);
    return element;
  };
  for (const id of htmlIds) make(id);
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
  const sessionStore = new Map();
  const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: '?tmdbId=500'},
    sessionStorage: {getItem: key => sessionStore.get(key) ?? null, setItem: (key, value) => sessionStore.set(key, value), removeItem: key => sessionStore.delete(key)},
    document: {querySelector: selector => elements.get(selector.slice(1)) || null},
    fetch: async (url, init) => { const route = String(url).split('/').pop().split('?')[0]; requests.push(route); if (init && init.body) bodies[route] = JSON.parse(init.body); return (answers[route] || readOnly[route])(bodies[route]); }});
  vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
  const el = id => elements.get(id);
  const wait = () => new Promise(resolve => setTimeout(resolve, 0));
  const tick = key => ({getAttribute: name => (name === 'data-group-key' ? key : null), checked: true});
  assert.equal(el('group-tmdb').value, '500', 'a link prefills the id');
  assert.deepEqual(requests, ['identity-work', 'group-preview'], 'on open only READS start: the bounded EPG worklist and the preview of a deep-linked movie, never a POST');
  assert.equal(el('group-confirm-form').hidden, true);
  await wait(); await wait();
  assert.deepEqual(requests, ['identity-work', 'group-preview']);
  assert.equal(el('group-list-box').hidden, false);
  assert.match(el('group-count').textContent, /Выбрано: 0 из не более 10\. Ничего не выбрано за вас/, 'nothing is selected for the owner');
  assert.equal(el('group-confirm-form').hidden, true, 'no confirmation form without a selection');
  // Tick keys; the 11th is refused.
  for (let i = 0; i < 11; i++) { const box = tick('k' + String(i).padStart(2, '0')); el('group-list').fire('change', {target: box}); }
  assert.match(el('group-count').textContent, /Выбрано: 10 из/, 'the cap is 10');
  assert.equal(el('group-confirm-form').hidden, false);
  assert.equal(el('group-confirm-button').disabled, false, 'the button is never silently disabled by a missing field: the submit explains it');
  // Controlled Russian inline validation instead of a browser tooltip: an empty basis, then a missing acknowledgement. No POST for either.
  el('group-confirm-form').fire('submit'); await wait();
  assert.equal(el('group-basis-error').hidden, false);
  assert.equal(el('group-basis-error').textContent, 'Укажите основание: почему эти наблюдения относятся к этому фильму (до 200 знаков).');
  assert.equal(el('group-basis').attrs['aria-invalid'], 'true');
  assert.equal(el('group-basis').focused, true, 'the field with the problem is focused');
  assert.deepEqual(requests, ['identity-work', 'group-preview'], 'a validation error posts nothing');
  el('group-basis').value = 'это тот фильм'; el('group-basis').fire('input');
  el('group-confirm-form').fire('submit'); await wait();
  assert.equal(el('group-accept-error').textContent, 'Отметьте, что вы подтверждаете именно этот набор.');
  assert.equal(el('group-basis-error').hidden, true, 'the satisfied field clears its message');
  assert.deepEqual(requests, ['identity-work', 'group-preview'], 'a missing acknowledgement posts nothing either');
  el('group-accept').checked = true; el('group-accept').fire('change');
  assert.match(el('group-accept-text').textContent, /набор из 10 наблюдений для фильма «Тихий берег»/, 'the acknowledgement names the exact set size and film');
  el('group-confirm-form').fire('submit'); await wait();
  assert.deepEqual(requests, ['identity-work', 'group-preview', 'group-confirm']);
  assert.deepEqual(bodies['group-confirm'].keys.length, 10);
  assert.equal(bodies['group-confirm'].tmdbId, '500');
  assert.equal(el('group-staged').hidden, false, 'the staged set is shown with its plan');
  assert.match(el('group-plan').innerHTML, /<ol class="group-members">/);
  assert.equal(el('group-confirm-form').hidden, true, 'one staged mutation at a time');
  // A change while staged is ignored.
  el('group-list').fire('change', {target: {getAttribute: () => 'k00', checked: false}});
  assert.match(el('group-count').textContent, /Выбрано: 10 из/, 'the staged selection cannot change (un-ticking a staged key is ignored)');
  el('group-execute-button').fire('click'); await wait(); await wait();
  assert.deepEqual(requests, ['identity-work', 'group-preview', 'group-confirm', 'group-execute', 'group-receipt', 'group-preview'], 'execute, then the stored read-back, then a fresh preview');
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
  assert.match(el('group-error').textContent, /не найдено в D1/, 'a group not (yet) found is reported honestly, not as proven unwritten');
  // Review P1: an unfinished group blocks every fresh confirmation, including after a reload; its handle is never overwritten.
  const kept = sessionStore.get('iptv-group-pending');
  postsBefore = count('group-confirm');
  await attempt();
  assert.equal(count('group-confirm'), postsBefore, 'zero new confirm POSTs while a group is unfinished');
  assert.equal(sessionStore.get('iptv-group-pending'), kept, 'the stored group handle is unchanged');
  assert.match(el('group-error').textContent, /незавершённая группа/);
  el('group-recover-dismiss').fire('click');
  assert.equal(sessionStore.has('iptv-group-pending'), false, 'a deliberate dismissal forgets it');
  assert.equal(el('group-staged').hidden, true, 'and clears any staged scope');
  // The confirm landed in D1 but the response was lost: the receipt proves it and offers the ORIGINAL scope for a replay.
  postsBefore = count('group-confirm');
  answers['group-receipt'] = () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation: {capability: 'discovery_identity_group_assign', idempotencyKey: bodies['group-confirm'].idempotencyKey, ids: ['k00']}, outcomes: [{key: 'k00', index: 1, state: 'approved', outcome: 'pending'}]})});
  await attempt();
  assert.equal(count('group-confirm'), postsBefore + 1, 'after the dismissal a fresh group starts');
  const original = {capability: 'discovery_identity_group_assign', idempotencyKey: bodies['group-confirm'].idempotencyKey, ids: ['k00']};
  assert.notEqual(original.idempotencyKey, lostKey, 'a deliberately forgotten group is replaced by an unrelated one');
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
  const make = id => { const listeners = new Map(); const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() { this.focused = true; }, setAttribute(name, value) { this.attrs = {...this.attrs, [name]: value}; }, removeAttribute(name) { if (this.attrs) delete this.attrs[name]; }, closest() { return null; }, open: false, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, fire(type) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element}); }, querySelectorAll() { return []; }}; elements.set(id, element); return element; };
  for (const id of htmlIds) make(id);
  const store = new Map([['iptv-group-pending', JSON.stringify({groupKey: 'group-' + 'a'.repeat(36), tmdbId: '500'})]]);
  const requests = [];
  const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: ''},
    sessionStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)},
    document: {querySelector: selector => elements.get(selector.slice(1)) || null},
    fetch: async url => { requests.push(String(url).replace(/^.*\/api\/admin\//, '').replace('discovery-recovery/', '')); return {ok: true, status: 200, json: async () => ({complete: true, confirmation: {idempotencyKey: 'x'}, outcomes: [{key: 'k00', index: 1, state: 'receipt', outcome: 'applied'}]})}; }});
  vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
  assert.deepEqual(requests, ['identity-work?type=epg_observation&limit=10'], 'on open only the read-only worklist is requested, not even the recovery read');
  assert.equal(elements.get('group-recover').hidden, false, 'an unfinished group is announced after a reload');
  assert.equal(elements.get('group-tmdb').value, '500');
  elements.get('group-recover-button').fire('click'); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests.slice(1), ['group-receipt?groupKey=group-' + 'a'.repeat(36)], 'one read-only receipt GET, no POST');
  assert.equal(store.has('iptv-group-pending'), false, 'a finished group is forgotten');
}

// Review P1: the recovery handle is forgotten only after a PROVEN terminal state, never because an HTTP 200 arrived.
{
  const IDS = ['group-pending-a', 'group-pending-b'];
  async function session(answers, {stored = null, query = '?tmdbId=500'} = {}) {
    const elements = new Map();
    const make = id => { const listeners = new Map(); const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', focus() { this.focused = true; }, setAttribute(name, value) { this.attrs = {...this.attrs, [name]: value}; }, removeAttribute(name) { if (this.attrs) delete this.attrs[name]; }, closest() { return null; }, open: false, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, fire(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element, ...extra}); }, querySelectorAll() { return []; }}; elements.set(id, element); return element; };
    for (const id of htmlIds) make(id);
    const store = new Map(stored ? [['iptv-group-pending', stored]] : []);
    const requests = [], bodies = {};
    const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: query},
      sessionStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)},
      document: {querySelector: selector => elements.get(selector.slice(1)) || null},
      fetch: async (url, init) => { const route = String(url).split('/').pop().split('?')[0]; requests.push(route); if (init && init.body) bodies[route] = JSON.parse(init.body); return (answers[route] || readOnly[route])(bodies[route]); }});
    vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
    const el = id => elements.get(id), wait = () => new Promise(resolve => setTimeout(resolve, 0));
    for (let i = 0; i < 6; i++) await wait();
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
  assert.deepEqual(running.requests, ['identity-work', 'group-preview'], 'on open only READS start: the worklist and the deep-linked preview, never a POST');
  running.el('group-recover-button').fire('click'); await running.flush();
  assert.equal(running.store.has('iptv-group-pending'), true, 'a running child never clears the handle');
  assert.equal(running.el('group-staged').hidden, true, 'a running child is not resumable');
  const reloaded = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'running', outcome: 'unknown'}]})})}, {stored: running.store.get('iptv-group-pending')});
  reloaded.el('group-recover-button').fire('click'); await reloaded.flush();
  assert.deepEqual(reloaded.requests, ['identity-work', 'group-preview', 'group-receipt'], 'after the reload the same key supports a manual read-only check');
  assert.equal(reloaded.requests.filter(route => route === 'group-confirm' || route === 'group-execute').length, 0, 'no POST');
  // A fully applied group is the proven terminal state.
  const done = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'receipt', outcome: 'applied'}]})})}, {stored: JSON.stringify({groupKey: key, tmdbId: '500'})});
  done.el('group-recover-button').fire('click'); await done.flush();
  assert.equal(done.store.has('iptv-group-pending'), false, 'forgotten only after a proven terminal state');
  // Review (third): a pending group A survives a reload and blocks a fresh group B until proven terminal or deliberately dismissed.
  const keyA = 'group-' + 'c'.repeat(36);
  const answersB = {...base, 'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: true, confirmation, outcomes: [{key: 'k0', index: 1, state: 'approved', outcome: 'pending'}, {key: 'k1', index: 2, state: 'receipt', outcome: 'applied'}]})})};
  const tryB = async page => {
    page.el('group-form').fire('submit'); await page.flush();
    for (const key of ['k0', 'k1']) page.el('group-list').fire('change', {target: {getAttribute: () => key, checked: true}});
    page.el('group-basis').value = 'b'; page.el('group-basis').fire('input'); page.el('group-accept').checked = true; page.el('group-accept').fire('change');
    page.el('group-confirm-form').fire('submit'); await page.flush();
  };
  const storedA = JSON.stringify({groupKey: keyA, tmdbId: '500'});
  const reloadA = await session(answersB, {stored: storedA});
  await tryB(reloadA);
  assert.equal(reloadA.requests.filter(route => route === 'group-confirm').length, 0, 'after a reload, zero POSTs for a new group while A is unfinished');
  assert.equal(JSON.parse(reloadA.store.get('iptv-group-pending')).groupKey, keyA, "A's stored handle is unchanged");
  reloadA.el('group-recover-button').fire('click'); await reloadA.flush();
  assert.equal(JSON.parse(reloadA.store.get('iptv-group-pending')).phase, 'stored', 'the readback phase is persisted, not only in memory');
  const second = await session(answersB, {stored: reloadA.store.get('iptv-group-pending')});
  await tryB(second);
  assert.equal(second.requests.filter(route => route === 'group-confirm').length, 0, 'after the readback and another reload the guard still holds');
  assert.equal(JSON.parse(second.store.get('iptv-group-pending')).groupKey, keyA);
  second.el('group-recover-dismiss').fire('click');
  assert.equal(second.store.has('iptv-group-pending'), false);
  assert.equal(second.el('group-staged').hidden, true, 'a forgotten group cannot be executed through a staged action');
  await tryB(second);
  assert.equal(second.requests.filter(route => route === 'group-confirm').length, 1, 'after the dismissal B can start');
  assert.notEqual(JSON.parse(second.store.get('iptv-group-pending')).groupKey, keyA);
  // Review (third) P2: an unproven receipt is never shown as success, keeps the handle and offers no replay.
  const unproven = await session({'group-receipt': () => ({ok: true, status: 200, json: async () => ({complete: false, confirmation: null, outcomes: [{key: 'k0', index: 1, state: 'receipt', outcome: 'applied'}, {key: 'k1', index: 2, state: 'receipt', outcome: 'applied'}]})})}, {stored: storedA});
  unproven.el('group-recover-button').fire('click'); await unproven.flush();
  assert.doesNotMatch(unproven.el('group-result').innerHTML, /Все выбранные наблюдения записаны/, 'no success claim without a proven group');
  assert.match(unproven.el('group-result').innerHTML, /Группа не доказана/);
  assert.equal(unproven.store.has('iptv-group-pending'), true, 'the handle is kept');
  assert.equal(unproven.el('group-staged').hidden, true, 'and no replay is offered');
  void IDS;
}

// Owner acceptance (UX): a first-time owner without a TMDB id can start, with Russian inline validation and no hidden write.
assert.doesNotMatch(html, /\srequired[\s>=]|\spattern=/, 'no native constraint validation: the browser would show its own English tooltip');
assert.equal((html.match(/<form[^>]*\snovalidate/g) || []).length, 3, 'all three forms validate through the page, not the browser');
assert.match(html, /<a class="admin-more" href="\/admin\/identity" id="group-back-queue"/, 'a visible way back to the identity queue');
{
  const queuePage = fs.readFileSync('public/admin-identity.html', 'utf8');
  assert.match(queuePage, /<a class="admin-refresh iw-apply" id="iw-group-entry-link" href="\/admin\/identity\/group">Открыть групповую идентификацию<\/a>/, 'a permanent, visible entry on the queue page, not only on rows with a confirmed Film');
  assert.ok(queuePage.indexOf('id="iw-group-entry-link"') < queuePage.indexOf('class="admin-workspace"'), 'the entry sits in the page heading, above the workspace');
}
{
  const tmdbOf = item => run('groupFilmTmdb(' + JSON.stringify(item) + ')');
  assert.equal(tmdbOf({externalIds: [{scheme: 'tmdb', value: '500', trusted: true, conflicting: false}]}), '500');
  assert.equal(tmdbOf({externalIds: [{scheme: 'tmdb', value: '500', trusted: false}]}), null, 'an untrusted id never starts a group');
  assert.equal(tmdbOf({externalIds: [{scheme: 'tmdb', value: '500', trusted: true, conflicting: true}]}), null, 'a conflicting id never starts a group');
  assert.equal(tmdbOf({externalIds: [{scheme: 'letterboxd', value: '500', trusted: true}]}), null, 'only a tmdb scheme counts');
  assert.equal(tmdbOf({externalIds: [{scheme: 'tmdb', value: '5<b>', trusted: true}]}), null);
  context.picks = [{preferred: '<img src=x onerror=1>', originalTitle: 'Q"uiet', year: 2001, collision: true, externalIds: [{scheme: 'tmdb', value: '500', trusted: true}]}, {preferred: 'Без id', year: null, externalIds: []}];
  const picksHtml = run('groupFilmResultsHtml(picks)');
  assert.doesNotMatch(picksHtml, /<img/, 'titles are escaped');
  assert.match(picksHtml, /data-group-pick="500"/);
  assert.match(picksHtml, /нет подтверждённого TMDB id: начать группу для него нельзя/, 'a film without a trusted id is explained, not offered');
  assert.equal((picksHtml.match(/data-group-pick=/g) || []).length, 1);
  assert.match(picksHtml, /есть фильм с таким же названием, сверьте год и id/, 'same-title films are flagged');
  context.qrows = [{title: '<b>Тихий берег</b>', year: 2001, status: 'x', reason: 'no_decision'}];
  assert.doesNotMatch(run('groupQueueHtml(qrows)'), /<b>Тихий/, 'queue titles are escaped');
  assert.match(run('groupQueueHtml(qrows)'), /data-group-find="&lt;b&gt;Тихий берег&lt;\/b&gt;"/);
}
{
  const urls = [], bodies = [];
  const make = async (answers, {query = ''} = {}) => {
    const elements = new Map();
    const mk = id => { const listeners = new Map(); const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', open: false, focused: false, attrs: {}, focus() { this.focused = true; }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; }, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, fire(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element, ...extra}); }, querySelectorAll() { return []; }}; elements.set(id, element); return element; };
    for (const id of htmlIds) mk(id);
    const seen = [];
    const page = vm.createContext({URLSearchParams, JSON, Math, Array, Set, Uint8Array, String, Promise, Date, crypto: webcrypto, location: {search: query},
      document: {querySelector: selector => elements.get(selector.slice(1)) || null},
      fetch: async (url, init) => { const text = String(url); seen.push((init && init.method ? init.method + ' ' : 'GET ') + text.replace(/^.*\/api\/admin\//, '')); const route = text.split('/').pop().split('?')[0]; if (init && init.body) bodies.push(route); const handler = answers[route] || readOnly[route]; return handler(text); }});
    vm.runInContext(['src/admin/identity-group-client.js', 'src/admin/identity-group-view.js', 'public/admin-identity-group.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
    const wait = () => new Promise(resolve => setTimeout(resolve, 0));
    const settle = async () => { for (let i = 0; i < 6; i++) await wait(); };
    await settle();
    return {el: id => elements.get(id), seen, settle};
  };
  const ok = body => () => ({ok: true, status: 200, json: async () => body});
  const fail = status => () => ({ok: false, status, json: async () => ({error: 'x'})});
  const target = value => ({closest: () => ({getAttribute: () => value})});
  const epgRow = (title, year = 2001) => ({key: 'epg:' + title + '|' + year, type: 'epg_observation', title, year, status: 'manual_review', reason: 'no_decision'});
  const filmItem = (title, tmdb) => ({id: 'film:tmdb_' + tmdb, preferred: title, originalTitle: title, year: 2001, externalIds: tmdb ? [{scheme: 'tmdb', value: String(tmdb), trusted: true, conflicting: false}] : []});

  // A first-time owner with no id: the page opens on a useful bounded list, not an empty required field.
  const first = await make({'identity-work': ok({pin: 'p1', rows: [epgRow('Тихий берег'), epgRow('Громкий берег')], nextCursor: 'c2'})});
  assert.deepEqual(first.seen, ['GET identity-work?type=epg_observation&limit=10'], 'the only request on open is the read-only worklist');
  assert.match(first.el('group-queue-list').innerHTML, /Тихий берег/);
  assert.match(first.el('group-queue-list').innerHTML, /data-group-find="Громкий берег"/);
  assert.equal(first.el('group-queue-more').hidden, false, 'a longer queue offers more, never claims to be complete');
  assert.equal(first.el('group-step2').hidden, true, 'step 2 appears only after a movie is chosen');
  assert.equal(first.el('group-confirm-form').hidden, true);
  // More: the cursor travels with the pin; a different pin is a stale read and is said so.
  first.el('group-queue-more').fire('click'); await first.settle();
  assert.match(first.seen[first.seen.length - 1], /cursor=c2&pin=p1$/);
  // Queue row -> search by its title -> pick a Film with a trusted id -> read-only preview.
  const journey = await make({
    'identity-work': ok({pin: 'p1', rows: [epgRow('Тихий берег')], nextCursor: null}),
    films: ok({items: [filmItem('Тихий берег', 500), filmItem('Тихий берег без id', null)]}),
    'group-preview': ok({tmdbId: '500', available: true, pin: 'D1.' + 'a'.repeat(32), film: {tmdbId: '500', title: 'Тихий берег', year: 2001, runtime: 95}, coverage: {kind: 'partial', anchors: [], anchorsOmitted: 0, merged: 1, shown: 1, dropped: 0}, writerActive: false, rows: [{key: 'k0', observation: {title: 'Тихий берег', year: 2001, durations: [95]}, decision: {status: 'needs_verification'}, shows: [], selectable: true, reasons: [], info: [], runtime: null, yearGap: 0, plan: null}]}),
  });
  journey.el('group-queue-list').fire('click', {target: target('Тихий берег')}); await journey.settle();
  assert.equal(journey.el('group-query').value, 'Тихий берег', 'the queue record fills the title search');
  assert.match(journey.seen[journey.seen.length - 1], /^GET films\?q=%D0%A2.*&limit=10$/, 'the catalogue is searched by title through the existing read-only route');
  assert.equal((journey.el('group-search-results').innerHTML.match(/data-group-pick=/g) || []).length, 1, 'only the Film with a trusted id can be picked');
  assert.equal(journey.el('group-search-form').hidden, false);
  journey.el('group-search-results').fire('click', {target: target('500')}); await journey.settle();
  assert.equal(journey.el('group-tmdb').value, '500');
  assert.match(journey.seen[journey.seen.length - 1], /^GET discovery-recovery\/group-preview\?tmdbId=500$/, 'the chosen Film goes through the unchanged D1 group-preview');
  assert.equal(journey.el('group-step2').hidden, false);
  assert.equal(journey.el('group-step2').focused, true, 'focus moves to step 2');
  assert.equal(journey.el('group-list-box').hidden, false);
  assert.equal(journey.el('group-count').textContent.includes('Выбрано: 0'), true, 'nothing is preselected');
  assert.deepEqual(journey.seen.filter(line => line.startsWith('POST')), [], 'no write anywhere in the journey');
  // Review P2: the worklist speaks Russian; an unknown code gets a Russian fallback and the raw id only as escaped technical detail.
  context.qreal = [
    {key: 'epg:a|2001', title: 'А', year: 2001, status: 'manual_review', reason: 'tmdb_fetch_failed'},
    {key: 'epg:b|2001', title: 'Б', year: 2001, status: 'retry_eligible', reason: 'no_decision'},
    {key: 'epg:c|2001', title: 'В', year: 2001, status: 'brand_new_state', reason: '<i>odd</i>'},
  ];
  const realHtml = run('groupQueueHtml(qreal)');
  assert.match(realHtml, /нужен ручной разбор: не удалось получить страницу фильма/);
  assert.match(realHtml, /можно повторить: у наблюдения ещё нет решения/);
  assert.match(realHtml, /состояние не распознано <code>brand_new_state<\/code>/);
  assert.match(realHtml, /причина не распознана <code>&lt;i&gt;odd&lt;\/i&gt;<\/code>/, 'an unknown code is a Russian fallback with an escaped technical detail');
  assert.doesNotMatch(realHtml.replace(/<code>[^<]*<\/code>/g, ''), /manual_review|retry_eligible|tmdb_fetch_failed|no_decision/, 'no raw code is shown as the primary text');
  // Review P1: the chosen EPG record stays with the owner; the page says where it stands in the bounded group answer and never promotes a title match.
  const rowOf = (key, extra = {}) => ({key, observation: {title: key.split('|')[0], year: 2001, durations: [95]}, decision: {status: 'needs_verification'}, shows: [], selectable: true, reasons: [], info: [], runtime: null, yearGap: 0, plan: null, ...extra});
  const previewWith = rows => ({tmdbId: '500', available: true, pin: 'D1.' + 'a'.repeat(32), film: {tmdbId: '500', title: 'Тихий берег', year: 2001, runtime: 95}, coverage: {kind: 'partial', anchors: [], anchorsOmitted: 0, merged: rows.length, shown: rows.length, dropped: 0}, writerActive: false, rows});
  const picked = async rows => {
    const page = await make({'identity-work': ok({pin: 'p', rows: [{key: 'epg:тихий берег|2001', type: 'epg_observation', title: 'Тихий берег', year: 2001, status: 'manual_review', reason: 'no_decision'}], nextCursor: null}), films: ok({items: [filmItem('Тихий берег', 500)]}), 'group-preview': ok(previewWith(rows))});
    const attr = {'data-group-find': 'Тихий берег', 'data-group-key': 'epg:тихий берег|2001'};
    page.el('group-queue-list').fire('click', {target: {closest: () => ({getAttribute: name => attr[name]})}}); await page.settle();
    assert.equal(page.el('group-task').hidden, false, 'the chosen record is shown as the current task');
    assert.match(page.el('group-task-text').textContent, /Выбрана запись EPG «Тихий берег» \(2001\)/);
    page.el('group-search-results').fire('click', {target: target('500')}); await page.settle();
    return page;
  };
  // (a) the record is absent from the bounded result: only observation B comes back.
  const absent = await picked([rowOf('другой фильм|2001')]);
  assert.equal(absent.el('group-task-note').hidden, false);
  assert.match(absent.el('group-task-note').innerHTML, /нет среди кандидатов этого фильма/);
  assert.match(absent.el('group-task-note').innerHTML, /другие записи, а не ваша/, 'the shown observations are not described as the chosen task');
  assert.match(absent.el('group-task-note').innerHTML, /href="\/admin\/limb"/, 'a recovery path: the single-key route');
  assert.doesNotMatch(absent.el('group-list').innerHTML, /group-task-badge/, 'no candidate is marked as the chosen record');
  assert.doesNotMatch(absent.el('group-list').innerHTML, /checked/, 'nothing is selected for the owner');
  // (b) present but not selectable: the reason is stated.
  const blocked = await picked([rowOf('тихий берег|2001', {selectable: false, reasons: ['runtime_conflict']}), rowOf('другой фильм|2001')]);
  assert.match(blocked.el('group-task-note').innerHTML, /есть среди кандидатов, но её нельзя подтвердить/);
  assert.match(blocked.el('group-task-note').innerHTML, /Длительность наблюдения расходится/);
  assert.match(blocked.el('group-list').innerHTML, /group-task-badge/, 'the chosen record is marked');
  // (c) present and selectable: marked, still never selected for the owner; the owner can clear the task.
  const present = await picked([rowOf('тихий берег|2001'), rowOf('другой фильм|2001')]);
  assert.match(present.el('group-task-note').innerHTML, /есть среди кандидатов\.<\/b> За вас она не отмечена/);
  assert.equal((present.el('group-list').innerHTML.match(/group-task-badge/g) || []).length, 1, 'only the chosen record is marked');
  assert.doesNotMatch(present.el('group-list').innerHTML, /checked/);
  assert.deepEqual(present.seen.filter(line => line.startsWith('POST')), [], 'no write');
  present.el('group-task-clear').fire('click');
  assert.equal(present.el('group-task').hidden, true);
  assert.equal(present.el('group-task-note').hidden, true, 'clearing the task removes the claim');
  // Empty worklist, failing worklist, stale worklist: honest, never a dead end, never a hidden action.
  const empty = await make({'identity-work': ok({pin: 'p', rows: [], nextCursor: null})});
  assert.equal(empty.el('group-queue-empty').hidden, false);
  assert.match(empty.el('group-queue-empty-text').textContent, /нет наблюдений EPG на разбор.*не доказывает.*найдите фильм по названию/s);
  const broken = await make({'identity-work': fail(500)});
  assert.equal(broken.el('group-queue-error').hidden, false);
  assert.equal(broken.el('group-queue-error-text').textContent, 'Не удалось прочитать очередь EPG. Найдите фильм по названию ниже или повторите чтение.');
  const staleLoad = await make({'identity-work': ok({pin: 'p', rows: [epgRow('A')], nextCursor: 'c'})});
  staleLoad.el('group-queue-more').fire('click');
  await staleLoad.settle();
  assert.ok(staleLoad.seen.length >= 2);
  const stale = await make({'identity-work': (() => { let n = 0; return () => (n++ ? {ok: false, status: 409, json: async () => ({error: 'stale_pin'})} : {ok: true, status: 200, json: async () => ({pin: 'p', rows: [epgRow('A')], nextCursor: 'c'})}); })()});
  stale.el('group-queue-more').fire('click'); await stale.settle();
  assert.match(stale.el('group-queue-error-text').textContent, /Очередь изменилась после первой страницы/);
  // Russian inline validation: the title search and the optional id. Nothing is requested for an invalid input.
  const before = journey.seen.length;
  journey.el('group-query').value = '   ';
  journey.el('group-search-form').fire('submit'); await journey.settle();
  assert.equal(journey.el('group-query-error').textContent, 'Введите название фильма.');
  assert.equal(journey.el('group-query-error').hidden, false);
  assert.equal(journey.el('group-query').attrs['aria-invalid'], 'true');
  assert.equal(journey.el('group-query').focused, true);
  journey.el('group-tmdb').value = '';
  journey.el('group-form').fire('submit'); await journey.settle();
  assert.equal(journey.el('group-tmdb-error').textContent, 'Введите числовой TMDB id фильма или выберите фильм из списка выше.');
  assert.equal(journey.el('group-advanced').open, true, 'the optional section opens to show its own error');
  journey.el('group-tmdb').value = 'abc';
  journey.el('group-form').fire('submit'); await journey.settle();
  assert.equal(journey.el('group-tmdb-error').textContent, 'TMDB id — это число из цифр (до 12), без пробелов и букв.');
  assert.equal(journey.seen.length, before, 'an invalid input requests nothing');
  assert.doesNotMatch(Object.values({a: journey.el('group-query-error').textContent, b: journey.el('group-tmdb-error').textContent}).join(' '), /Please|fill out/, 'no English browser text');
  // A title with no match, and a failing search, are explained in Russian.
  const none = await make({films: ok({items: []})});
  none.el('group-query').value = 'Несуществующий';
  none.el('group-search-form').fire('submit'); await none.settle();
  assert.match(none.el('group-search-empty').textContent, /нет фильмов с таким названием/);
  const failing = await make({films: fail(503)});
  failing.el('group-query').value = 'Тихий';
  failing.el('group-search-form').fire('submit'); await failing.settle();
  assert.equal(failing.el('group-search-empty').textContent, 'Не удалось выполнить поиск. Ничего не записано, повторите.');
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
