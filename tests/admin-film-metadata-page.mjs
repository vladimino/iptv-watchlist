// AIR-635 (PVU): the owner's provenance view of one Film. The pure decisions (refusal text, writable state, command builder, HTML) and the
// binding (lazy read, same-command retry, pagination, definite refusals) run against a stand-in DOM and a scripted fetch.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {bundleAdmin} from '../src/admin/bundle.js';

const source = fs.readFileSync('src/admin/film-metadata-client.js', 'utf8');
assert.doesNotMatch(source, /localStorage|sessionStorage|Authorization|Bearer|\/mcp/, 'no credential and no other API');
assert.equal((source.match(/method:'POST'/g) || []).length, 1, 'one write');

const calls = [];
let script = [];
const context = {
  ADMIN_API: '/api/admin', console, crypto: {randomUUID: (() => { let n = 0; return () => 'req-' + (++n) + '-aaaaaaaa'; })()},
  fetch: async (url, init) => {
    calls.push({url, init});
    const next = script.shift();
    if (next instanceof Error) throw next;
    return {ok: next.status < 400, status: next.status, json: async () => next.body};
  },
};
vm.createContext(context);
vm.runInContext(bundleAdmin([source]) + '\nglobalThis.api={adminMetaWritable,adminMetaFieldState,adminMetaCommand,adminMetaParseValue,adminMetaRefusalText,adminMetaHtml,adminMetaRetryable,adminFilmMetadataSection,adminBindFilmMetadata};', context);
const api = context.api;

const row = (over = {}) => ({tier: 'tmdb', source: 'tmdb', origin: 'enrichment', anchorScheme: 'tmdb', anchorValue: '603', anchorDigest: 'd1', agreement: 'confirmed', language: 'ru', languageBasis: 'localization', observedAt: '2026-11-01T00:00:00.000Z', checkedAt: null, writeKey: 'k', writtenRevision: 3, ...over});
const view = (over = {}) => ({
  found: true, filmId: 'film:1', revision: 7, redirectedTo: null, schemaAbsent: false, mode: 'enforce', controlRevision: 1, dimensionLocked: false, anchorDigest: 'd1', disagreement: false,
  fields: {
    year: {value: 1999, blank: false, rank: {name: 'confirmed', value: 2}, bound: true, mismatch: false, locked: false, row: row()},
    runtime: {value: 136, blank: false, rank: {name: 'unknown', value: 0}, bound: false, mismatch: false, locked: false, row: null},
    synopsis: {value: null, blank: true, rank: {name: 'unknown', value: 0}, bound: false, mismatch: false, locked: false, row: null},
    poster: {value: '/p.jpg', blank: false, rank: {name: 'owner', value: 4}, bound: true, mismatch: false, locked: true, row: row({tier: 'owner', source: 'owner'})},
    url: {value: 'https://x', blank: false, rank: {name: 'superseded', value: 1}, bound: true, mismatch: true, locked: false, row: row()},
    genres: {value: ['Drama', 'Sci-Fi'], blank: false, rank: {name: 'confirmed', value: 2}, bound: true, mismatch: false, locked: false, row: row()},
  },
  locks: {owner: ['poster'], dimension: false},
  c1: {rows: [{part: 'film', source: '*', slot: 0, status: 'complete', reason: null, updatedAt: 'x', refreshEpoch: 0, planEpoch: 1}, {part: 'core', source: 'tmdb', slot: 0, status: 'complete', reason: null, updatedAt: '2026-11-02T00:00:00.000Z', refreshEpoch: 2, planEpoch: 1}], film: null, conflicts: [{part: 'core', source: 'tmdb', value: {year: [1998, 1999]}}], hints: [], gaps: [], credits: {chunks: 0, withConflicts: 0, byStatus: {}}},
  redirects: {count: 0},
  history: {rows: [
    {id: 11, filmId: 'film:1', field: 'year', reason: 'owner_set', at: '2026-11-03T00:00:00.000Z', writeKey: 'w', mergedFrom: null, old: {value: 1998, source: 'tmdb', language: null}, new: {}, revertible: true, revertBlocked: null},
    {id: 10, filmId: 'film:1', field: 'runtime', reason: 'writer', at: '2026-11-02T00:00:00.000Z', writeKey: 'w2', mergedFrom: null, old: {value: 130, source: 'tmdb'}, new: {}, revertible: false, revertBlocked: 'anchor_changed'},
  ], next: '2026-11-02T00:00:00.000Z~10'},
  ...over,
});

// ---- pure decisions ----
assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaWritable(view()))), {ok: true, reason: null});
assert.equal(api.adminMetaWritable(view({mode: 'off'})).reason, 'provenance_off');
assert.equal(api.adminMetaWritable(view({schemaAbsent: true, mode: null})).reason, 'schema_absent');
assert.equal(api.adminMetaWritable(view({redirectedTo: 'film:2'})).reason, 'redirected');
assert.equal(api.adminMetaWritable(view({mode: 'hold'})).ok, true, 'hold keeps the route working');
for (const code of ['provenance_off', 'schema_absent', 'identity_unknown', 'anchor_changed', 'stale_revision', 'stale_rows', 'request_mismatch', 'storage_unavailable', 'network']) assert.ok(api.adminMetaRefusalText(code).length > 20, code);
assert.match(api.adminMetaRefusalText('identity_unknown'), /Задать новое значение можно/);
assert.match(api.adminMetaRefusalText('anchor_changed'), /Задать новое значение можно/);
assert.match(api.adminMetaRefusalText('brand_new_code'), /brand_new_code/);

const v = view();
assert.equal(api.adminMetaFieldState(v.fields.runtime).kind, 'unattributed', 'a value without lineage is not given an invented one');
assert.equal(api.adminMetaFieldState(v.fields.synopsis).kind, 'blank');
assert.equal(api.adminMetaFieldState(v.fields.poster).kind, 'locked');
assert.equal(api.adminMetaFieldState(v.fields.url).kind, 'superseded');
assert.equal(api.adminMetaFieldState({value: 1, blank: false}).kind, 'plain', 'mode off: no rank, no provenance claimed');

assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaParseValue('year', ' 2001 '))), {value: 2001});
assert.ok(api.adminMetaParseValue('year', '20x1').error);
assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaParseValue('genres', 'Drama, , Sci-Fi'))), {value: ['Drama', 'Sci-Fi']});
assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaParseValue('synopsis', ' text '))), {value: 'text'});
assert.ok(api.adminMetaParseValue('url', '  ').error);

assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaCommand(v, 'set', {field: 'year', value: 2001, requestId: 'r-12345678'}))), {action: 'set', expectedRevision: 7, requestId: 'r-12345678', field: 'year', value: 2001});
assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaCommand(v, 'revert', {field: 'year', historyRef: 11, requestId: 'r-12345678'}))), {action: 'revert', expectedRevision: 7, requestId: 'r-12345678', field: 'year', historyRef: 11});
assert.deepEqual(JSON.parse(JSON.stringify(api.adminMetaCommand(v, 'refresh', {requestId: 'r-12345678'}))), {action: 'refresh', expectedRevision: 7, requestId: 'r-12345678', expectedRows: [{part: 'core', source: 'tmdb', status: 'complete', updatedAt: '2026-11-02T00:00:00.000Z', refreshEpoch: 2}]});
assert.equal(api.adminMetaRetryable({error: 'network', status: 0}), true);
assert.equal(api.adminMetaRetryable({error: 'storage_unavailable', status: 503, outcome: 'unknown'}), true);
assert.equal(api.adminMetaRetryable({error: 'stale_revision', status: 409, outcome: 'rejected'}), false);

// ---- the HTML ----
const html = api.adminMetaHtml(v);
for (const field of ['year', 'runtime', 'synopsis', 'poster', 'url', 'genres']) assert.match(html, new RegExp('data-meta-field="' + field + '"'));
assert.match(html, /Drama, Sci-Fi/);
assert.match(html, /закреплено владельцем/);
assert.match(html, /без происхождения \(unattributed\)/);
assert.match(html, /data-meta-action="release" data-field="poster"/);
assert.match(html, /data-meta-conflicts/);
assert.match(html, /data-meta-revert-blocked="anchor_changed"/);
assert.match(html, /data-meta-more="2026-11-02T00:00:00.000Z~10"/);
assert.match(html, /data-meta-action="revert" data-field="year" data-history-ref="11"/);
assert.doesNotMatch(html, /data-meta-readonly/);
const off = api.adminMetaHtml(view({mode: 'off', fields: {year: {value: 1999, blank: false}, runtime: {value: null, blank: true}, synopsis: {value: 'x', blank: false}, poster: {value: null, blank: true}, url: {value: null, blank: true}, genres: {value: ['A'], blank: false}}, history: {rows: [], next: null}}));
assert.match(off, /data-meta-readonly/);
assert.match(off, /Режим provenance выключен/);
for (const button of off.match(/<button[^>]*data-meta-action[^>]*>/g)) assert.match(button, /disabled/, 'every write is disabled while the mode is off: ' + button);
assert.match(api.adminMetaHtml(view({schemaAbsent: true, mode: null, c1: null, history: {rows: [], next: null}})), /Схема provenance ещё не установлена/);
assert.match(api.adminMetaHtml(view({history: {rows: [], next: null}})), /data-meta-history-empty/);
assert.equal(api.adminFilmMetadataSection({}), '', 'no stored id, no section');
assert.match(api.adminFilmMetadataSection({storedId: 'film:a b'}), /data-film-metadata data-stored-id="film:a b"/);
const escaped = api.adminMetaHtml(view({fields: {...v.fields, synopsis: {value: '<script>alert(1)</script>', blank: false, rank: {name: 'confirmed', value: 2}, row: row()}}}));
assert.doesNotMatch(escaped, /<script>alert/);

// ---- the binding ----
function node(attrs = {}) {
  const n = {attrs, listeners: {}, _html: '', textContent: '', open: false, disabled: false, children: {},
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(sel) { return this.children[sel] || null; },
    closest() { return this; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }};
  return n;
}
function mount() {
  const section = node(), body = node(), status = node();
  section.children = {'[data-meta-body]': body, '[data-meta-status]': status};
  const input = node(); input.value = '';
  body.children = {};
  body.querySelector = sel => sel.startsWith('[data-meta-input') ? input : null;
  const host = {querySelector: sel => sel === '[data-film-metadata]' ? section : null};
  api.adminBindFilmMetadata(host, 'film:1');
  const press = async attrs => { const b = node(attrs); await body.listeners.click({target: b}); };
  return {section, body, status, input, press, open: async () => { section.open = true; await section.listeners.toggle(); }};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// lazy: nothing is read before the section is opened; one GET after
{
  calls.length = 0; script = [{status: 200, body: view()}];
  const m = mount();
  assert.equal(calls.length, 0, 'binding alone reads nothing');
  await m.open(); await tick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/admin\/films\/film%3A1\/metadata$/);
  assert.equal(calls[0].init.method, undefined, 'the read is a GET');
  assert.match(m.body.innerHTML, /data-meta-field="year"/);
}
// read failure: said, and the section can be opened again
{
  calls.length = 0; script = [{status: 503, body: {error: 'unavailable'}}, {status: 200, body: view()}];
  const m = mount();
  await m.open(); await tick();
  assert.match(m.status.textContent, /Не удалось прочитать/);
  await m.open(); await tick();
  assert.equal(calls.length, 2);
  assert.match(m.body.innerHTML, /data-meta-field/);
}
// pagination appends the next page
{
  calls.length = 0;
  const second = view({history: {rows: [{id: 5, filmId: 'film:1', field: 'genres', reason: 'writer', at: '2026-10-01T00:00:00.000Z', old: {value: ['X']}, revertible: true}], next: null}});
  script = [{status: 200, body: view()}, {status: 200, body: second}];
  const m = mount();
  await m.open(); await tick();
  await m.press({'data-meta-more': '2026-11-02T00:00:00.000Z~10'}); await tick();
  assert.match(calls[1].url, /\?cursor=2026-11-02T00%3A00%3A00\.000Z~10$/);
  assert.match(m.body.innerHTML, /data-history-id="11"/);
  assert.match(m.body.innerHTML, /data-history-id="5"/);
  assert.doesNotMatch(m.body.innerHTML, /data-meta-more/);
}
// set: validation first (no request), then the POST, then a re-read
{
  calls.length = 0; script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await tick();
  m.input.value = 'abc';
  await m.press({'data-meta-action': 'set', 'data-field': 'year'});
  assert.equal(calls.length, 1, 'an invalid value sends nothing');
  assert.match(m.status.textContent, /целое число/);
  m.input.value = '2001';
  script = [{status: 200, body: {ok: true, outcome: 'applied', action: 'set'}}, {status: 200, body: view()}];
  await m.press({'data-meta-action': 'set', 'data-field': 'year'}); await tick();
  const post = calls[1];
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['X-IPTV-Admin-Action'], 'film_metadata_owner');
  assert.equal(post.init.credentials, 'same-origin');
  const sent = JSON.parse(post.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['action', 'expectedRevision', 'field', 'requestId', 'value']);
  assert.equal(sent.value, 2001); assert.equal(sent.expectedRevision, 7);
  assert.equal(calls.length, 3, 'a re-read follows the write');
  assert.match(m.status.textContent, /выполнено/);
}
// unknown outcome (network, then 503): the SAME requestId and body are sent again; success clears it
{
  calls.length = 0; script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await tick();
  m.input.value = '1999';
  script = [new Error('offline')];
  await m.press({'data-meta-action': 'set', 'data-field': 'year'});
  assert.match(m.status.textContent, /Нет ответа/);
  script = [{status: 503, body: {error: 'storage_unavailable', outcome: 'unknown'}}];
  m.input.value = '2005'; // changed text must not change a command whose outcome is unknown
  await m.press({'data-meta-action': 'set', 'data-field': 'year'});
  assert.match(m.status.textContent, /requestId решит|Хранилище не ответило/);
  script = [{status: 200, body: {ok: true, outcome: 'already_applied', action: 'set'}}, {status: 200, body: view()}];
  await m.press({'data-meta-action': 'set', 'data-field': 'year'}); await tick();
  const posts = calls.filter(c => c.init && c.init.method === 'POST').map(c => c.init.body);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts).size, 1, 'three attempts, one identical command');
  assert.match(m.status.textContent, /уже была выполнена/);
}
// a definite refusal ends the attempt (a new command gets a new requestId); stale_revision re-reads
{
  calls.length = 0; script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await tick();
  m.input.value = '2001';
  script = [{status: 409, body: {error: 'stale_revision', outcome: 'rejected'}}, {status: 200, body: view({revision: 8})}];
  await m.press({'data-meta-action': 'set', 'data-field': 'year'}); await tick();
  assert.match(m.status.textContent, /Карточка изменилась/);
  assert.equal(calls.length, 3);
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view({revision: 9})}];
  await m.press({'data-meta-action': 'set', 'data-field': 'year'}); await tick();
  const posts = calls.filter(c => c.init && c.init.method === 'POST').map(c => JSON.parse(c.init.body));
  assert.notEqual(posts[0].requestId, posts[1].requestId);
  assert.equal(posts[1].expectedRevision, 8, 'the next command is planned on the re-read revision');
}
// revert, lock, release and refresh send the shapes the API validates
{
  calls.length = 0; script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await tick();
  const sentBody = async (attrs, response) => { script = [{status: 200, body: response}, {status: 200, body: view()}]; const before = calls.length; await m.press(attrs); await tick(); return JSON.parse(calls[before].init.body); };
  const ok = {ok: true, outcome: 'applied'};
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'revert', 'data-field': 'year', 'data-history-ref': '11'}, ok)).sort(), ['action', 'expectedRevision', 'field', 'historyRef', 'requestId']);
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'lock', 'data-field': 'year'}, ok)).sort(), ['action', 'expectedRevision', 'field', 'requestId']);
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'release', 'data-field': 'poster'}, ok)).sort(), ['action', 'expectedRevision', 'field', 'requestId']);
  const refresh = await sentBody({'data-meta-action': 'refresh'}, ok);
  assert.deepEqual(Object.keys(refresh).sort(), ['action', 'expectedRevision', 'expectedRows', 'requestId']);
  assert.equal(refresh.expectedRows[0].refreshEpoch, 2);
}
console.log('Admin film metadata page: provenance view, refusal explanations, same-command retry, pagination and write shapes passed');
