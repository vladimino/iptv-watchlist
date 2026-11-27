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
    if (next.gate) await next.gate; // a response that is held until the test lets it go
    return {ok: next.status < 400, status: next.status, json: async () => next.body};
  },
};
vm.createContext(context);
vm.runInContext(bundleAdmin([source]) + '\nglobalThis.api={adminMetaWritable,adminMetaFieldState,adminMetaCommand,adminMetaParseValue,adminMetaDescribe,adminMetaPendingHtml,adminMetaRefusalText,adminMetaHtml,adminMetaRetryable,adminFilmMetadataSection,adminBindFilmMetadata};', context);
const api = context.api;

const row = (over = {}) => ({tier: 'tmdb', source: 'tmdb', origin: 'enrichment', anchorScheme: 'tmdb', anchorValue: '603', anchorDigest: 'd1', agreement: 'confirmed', language: 'ru', languageBasis: 'localization', observedAt: '2026-11-01T00:00:00.000Z', checkedAt: null, writeKey: 'k', writtenRevision: 3, ...over});
const view = (over = {}) => ({
  found: true, filmId: 'film:1', revision: 7, redirectedTo: null, schemaAbsent: false, mode: 'enforce', controlRevision: 1, dimensionLocked: false, anchorDigest: 'd1', disagreement: false,
  fields: {
    year: {value: 1999, blank: false, rank: {name: 'confirmed', value: 2}, bound: true, mismatch: false, locked: false, row: row()},
    runtime: {value: 136, blank: false, rank: {name: 'unknown', value: 0}, bound: false, mismatch: false, locked: false, row: null},
    synopsis: {value: null, blank: true, rank: {name: 'unknown', value: 0}, bound: false, mismatch: false, locked: false, row: null},
    poster: {value: '/p.jpg', blank: false, rank: {name: 'owner', value: 4}, bound: true, mismatch: false, locked: true, row: row({tier: 'owner', source: 'owner'})},
    url: {value: 'https://x', blank: false, rank: {name: 'superseded', value: 3}, bound: true, mismatch: false, locked: false, row: row()},
    genres: {value: ['Drama', 'Sci-Fi'], blank: false, rank: {name: 'unknown', value: 1}, bound: false, mismatch: true, locked: false, row: row({source: 'wikidata'})},
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
const J = value => JSON.parse(JSON.stringify(value));
const st = (entry, dim = false) => J(api.adminMetaFieldState(entry, dim));
assert.equal(st(v.fields.runtime).kind, 'unattributed', 'a value without lineage is not given an invented one');
assert.equal(st(v.fields.synopsis).kind, 'blank');
assert.equal(st(v.fields.poster).kind, 'owner'); assert.equal(st(v.fields.poster).pin, true);
assert.equal(st(v.fields.url).kind, 'superseded');
assert.equal(st(v.fields.genres).unbound, true);
assert.equal(st({value: 1, blank: false}).kind, 'plain', 'mode off: no rank, no provenance claimed');
// PV3-shaped entries under the metadata DIMENSION lock: `locked` and rank `owner` are true for every field, the pin is only `row.tier === owner`
const dimAuto = {value: 1999, blank: false, rank: {name: 'owner', value: 5}, bound: true, mismatch: false, locked: true, row: row({tier: 'automatic'})};
const dimBlank = {value: null, blank: true, rank: {name: 'owner', value: 5}, bound: false, mismatch: false, locked: true, row: null};
const dimReleased = {value: 1999, blank: false, rank: {name: 'owner', value: 5}, bound: true, mismatch: false, locked: true, row: row({tier: 'released'})};
assert.deepEqual([st(dimAuto, true).pin, st(dimAuto, true).dimension, st(dimAuto, true).label], [false, true, 'защищено блокировкой метаданных']);
assert.equal(st(dimReleased, true).pin, false, 'a released field is not pinned, the dimension still protects it');
assert.equal(st(dimBlank, true).kind, 'blank');
assert.equal(st(v.fields.poster, true).pin, true);
const unbound = {value: 'x', blank: false, rank: {name: 'unknown', value: 1}, bound: false, mismatch: true, locked: false, row: row({source: 'tmdb', language: 'en'})};
assert.equal(st(unbound).unbound, true);
assert.equal(st({value: 'x', blank: false, rank: {name: 'owner', value: 5}, bound: false, mismatch: true, row: row({tier: 'owner'})}).pin, true, 'an owner row is a pin even when its value moved');

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
assert.match(html, /вытеснено: идентичность фильма изменилась/);
assert.match(html, /значение не совпадает с записью происхождения/);
assert.match(html, /data-meta-unbound/, 'a row of another value is shown as history, not as the value\'s lineage');
assert.match(html, /<textarea data-meta-input="synopsis" rows="4" maxlength="20000"/);
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


// dimension lock in the HTML: Lock (not Release) for an unpinned field, Lock disabled for a blank one, Release only for a real pin, and the note about the dimension
{
  const dim = api.adminMetaHtml(view({dimensionLocked: true, fields: {...v.fields, year: dimAuto, synopsis: dimBlank, runtime: dimReleased}}));
  const li = field => dim.match(new RegExp('<li class="admin-meta-field" data-meta-field="' + field + '">[\\s\\S]*?</li>'))[0];
  assert.match(li('year'), /data-meta-action="lock" data-field="year"/);
  assert.doesNotMatch(li('year'), /data-meta-action="release"/);
  assert.match(li('runtime'), /data-meta-action="lock" data-field="runtime"/, 'released: lockable again');
  assert.match(li('synopsis'), /data-meta-action="lock" data-field="synopsis" disabled/, 'a blank field cannot be locked');
  assert.match(li('poster'), /data-meta-action="release" data-field="poster"/);
  assert.match(li('poster'), /остаётся под блокировкой метаданных/);
  assert.match(li('year'), /защищено блокировкой метаданных/);
}
// a valid 20000-character synopsis is accepted by the page; the other bounds are the server's
assert.equal(api.adminMetaParseValue('synopsis', 'x'.repeat(20000)).value.length, 20000);
assert.equal(api.adminMetaParseValue('year', '1500').value, 1500, 'the range of the year is the writer\'s to judge');
assert.match(api.adminMetaRefusalText('invalid_value'), /20000/);
assert.match(api.adminMetaHtml(view(), {pending: true}), /data-meta-action="set" data-field="year" disabled/);
assert.match(api.adminMetaHtml(view(), {stale: true}), /Данные устарели/);
assert.match(api.adminMetaPendingHtml({command: {action: 'set', field: 'year', value: 1999, requestId: 'req-1-aaaaaaaa', expectedRevision: 7}}), /Задать значение Год = 1999[\s\S]*req-1-aaaaaaaa[\s\S]*data-meta-retry[\s\S]*data-meta-discard/);

// ---- the binding ----
function node(attrs = {}) {
  const n = {attrs, listeners: {}, _html: '', textContent: '', open: false, disabled: false, children: {}, value: '',
    getAttribute(k) { return this.attrs[k] ?? null; },
    hasAttribute(k) { return Object.hasOwn(this.attrs, k); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(sel) { return this.children[sel] || null; },
    closest() { return this; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }};
  return n;
}
function mount() {
  const section = node(), body = node(), result = node(), reading = node(), pendingBox = node();
  section.children = {'[data-meta-body]': body, '[data-meta-result]': result, '[data-meta-reading]': reading, '[data-meta-pending]': pendingBox};
  const inputs = {};
  body.querySelector = sel => { const m = /data-meta-input="(\w+)"/.exec(sel); return m ? (inputs[m[1]] ||= node()) : null; };
  api.adminBindFilmMetadata({querySelector: sel => sel === '[data-film-metadata]' ? section : null}, 'film:1');
  const press = attrs => section.listeners.click({target: node(attrs)});
  return {section, body, result, reading, pendingBox, inputs, press, open: () => { section.open = true; return section.listeners.toggle(); }};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const posts = () => calls.filter(c => c.init && c.init.method === 'POST').map(c => JSON.parse(c.init.body));
const reset = () => { calls.length = 0; context.eval && 0; vm.runInContext('adminMetaPending = null;', context); };
const gate = () => { let go; const promise = new Promise(resolve => { go = resolve; }); return {promise, go}; };
const SET = {'data-meta-action': 'set', 'data-field': 'year'};

// lazy: nothing is read before the section is opened; one GET after, and a second toggle while reading adds none
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  assert.equal(calls.length, 0, 'binding alone reads nothing');
  await m.open(); m.section.listeners.toggle(); await settle();
  assert.equal(calls.length, 1, 'overlapping toggles read once');
  assert.match(calls[0].url, /\/api\/admin\/films\/film%3A1\/metadata$/);
  assert.equal(calls[0].init.method, undefined);
  assert.match(m.body.innerHTML, /data-meta-field="year"/);
  assert.doesNotMatch(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
}
// a delayed first read: a second toggle and a press while it is pending add no request, and the late answer is applied once
{
  reset(); const g = gate(); script = [{status: 200, body: view(), gate: g.promise}];
  const m = mount();
  await m.open(); m.section.listeners.toggle(); await settle();
  assert.equal(calls.length, 1);
  assert.match(m.reading.innerHTML, /Читаю метаданные/);
  g.go(); await settle();
  assert.equal(calls.length, 1);
  assert.match(m.body.innerHTML, /data-meta-field="year"/);
}
// a failed first read: said, controls absent, an explicit retry exists
{
  reset(); script = [{status: 503, body: {error: 'unavailable'}}, {status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  assert.match(m.reading.innerHTML, /Не удалось прочитать/);
  assert.match(m.reading.innerHTML, /data-meta-reload/);
  await m.press({'data-meta-reload': ''}); await settle();
  assert.equal(calls.length, 2);
  assert.match(m.body.innerHTML, /data-meta-field/);
  assert.equal(m.reading.innerHTML, '');
}
// pagination appends; a revision or anchor that moved between pages reloads the first page so revert flags stay coherent
{
  reset();
  const page2 = view({history: {rows: [{id: 5, filmId: 'film:1', field: 'genres', reason: 'writer', at: '2026-10-01T00:00:00.000Z', old: {value: ['X']}, revertible: true, revertBlocked: null}], next: null}});
  script = [{status: 200, body: view()}, {status: 200, body: page2}];
  const m = mount();
  await m.open(); await settle();
  await m.press({'data-meta-more': '2026-11-02T00:00:00.000Z~10'}); await settle();
  assert.match(calls[1].url, /\?cursor=2026-11-02T00%3A00%3A00\.000Z~10$/);
  assert.match(m.body.innerHTML, /data-history-id="11"/);
  assert.match(m.body.innerHTML, /data-history-id="5"/);
  assert.doesNotMatch(m.body.innerHTML, /data-meta-more/);
}
{
  reset();
  const moved = view({revision: 9, history: {rows: [{id: 5, filmId: 'film:1', field: 'genres', reason: 'writer', at: '2026-10-01T00:00:00.000Z', old: {value: ['X']}, revertible: true, revertBlocked: null}], next: null}});
  const fresh = view({revision: 9, history: {rows: [{id: 11, filmId: 'film:1', field: 'year', reason: 'owner_set', at: '2026-11-03T00:00:00.000Z', old: {value: 1998}, revertible: false, revertBlocked: 'anchor_changed'}], next: null}});
  script = [{status: 200, body: view()}, {status: 200, body: moved}, {status: 200, body: fresh}];
  const m = mount();
  await m.open(); await settle();
  await m.press({'data-meta-more': '2026-11-02T00:00:00.000Z~10'}); await settle();
  assert.equal(calls.length, 3, 'the first page was read again');
  assert.doesNotMatch(calls[2].url, /cursor/);
  assert.match(m.body.innerHTML, /data-meta-revert-blocked="anchor_changed"/);
  assert.doesNotMatch(m.body.innerHTML, /data-history-id="5"/, 'no row of the old state is kept under the new revision');
  assert.match(m.result.textContent, /перечитан с начала/);
  const anchor = view({anchorDigest: 'd2', history: {rows: [], next: null}});
  reset(); script = [{status: 200, body: view()}, {status: 200, body: anchor}, {status: 200, body: view({anchorDigest: 'd2'})}];
  const m2 = mount();
  await m2.open(); await settle();
  await m2.press({'data-meta-more': 'c~2'}); await settle();
  assert.equal(calls.length, 3, 'a moved anchor reloads too');
}
// invalid input sends nothing; a valid set posts the exact shape and reads again
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = 'abc';
  await m.press(SET);
  assert.equal(calls.length, 1, 'an invalid value sends nothing');
  assert.match(m.result.textContent, /целое число/);
  m.inputs.year.value = '2001';
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view({revision: 8})}];
  await m.press(SET); await settle();
  const post = calls[1].init;
  assert.equal(post.method, 'POST'); assert.equal(post.headers['X-IPTV-Admin-Action'], 'film_metadata_owner'); assert.equal(post.credentials, 'same-origin');
  assert.deepEqual(Object.keys(JSON.parse(post.body)).sort(), ['action', 'expectedRevision', 'field', 'requestId', 'value']);
  assert.equal(calls.length, 3, 'a re-read follows the write');
  assert.match(m.result.textContent, /выполнено/);
  assert.equal(m.pendingBox.innerHTML, '');
}
// a valid 20000-character synopsis is posted whole; the page does not cap it at 2000
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.synopsis = node(); m.inputs.synopsis.value = 'я'.repeat(20000);
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view()}];
  await m.press({'data-meta-action': 'set', 'data-field': 'synopsis'}); await settle();
  assert.equal(posts()[0].value.length, 20000);
  // the writer's refusal of an out-of-bounds value is explained, and the attempt is over
  m.inputs.synopsis.value = 'я'.repeat(20001);
  script = [{status: 400, body: {error: 'invalid_value', outcome: 'rejected'}}];
  await m.press({'data-meta-action': 'set', 'data-field': 'synopsis'}); await settle();
  assert.match(m.result.textContent, /20000/);
  assert.equal(m.pendingBox.innerHTML, '');
}
// UNKNOWN OUTCOME: the command is frozen, shown with its value, the only thing that can be sent, kept across a remount, retried identically, and given up only explicitly
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = '1999';
  script = [new Error('offline')];
  await m.press(SET); await settle();
  assert.match(m.result.textContent, /Нет ответа/);
  assert.match(m.pendingBox.innerHTML, /Задать значение Год = 1999/, 'the held command is shown with its action, field and value');
  assert.match(m.pendingBox.innerHTML, /data-meta-retry/);
  assert.match(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/, 'every other action is disabled');
  const sent = calls.length;
  // edited input: the ordinary Set button does nothing
  m.inputs.year.value = '2005';
  await m.press(SET); await m.press({'data-meta-action': 'lock', 'data-field': 'year'}); await settle();
  assert.equal(calls.length, sent, 'an edited value or another action sends nothing while a command is held');
  // a different action cannot replace it
  await m.press({'data-meta-action': 'refresh'}); await settle();
  assert.equal(calls.length, sent);
  // remount (a re-render of the detail): the held command is shown again, and only a read happens
  script = [{status: 200, body: view()}];
  const again = mount(); await settle();
  assert.equal(calls.length, sent + 1, 'a remount reads, it does not write');
  assert.equal(posts().length, 1);
  assert.match(again.pendingBox.innerHTML, /Год = 1999/);
  assert.equal(again.section.open, true);
  assert.match(again.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  // identical retry: first a 503 with unknown outcome again, then the stored command answers
  script = [{status: 503, body: {error: 'storage_unavailable', outcome: 'unknown'}}];
  await again.press({'data-meta-retry': ''}); await settle();
  assert.match(again.pendingBox.innerHTML, /Год = 1999/);
  script = [{status: 200, body: {ok: true, outcome: 'already_applied', action: 'set'}}, {status: 200, body: view({revision: 8})}];
  await again.press({'data-meta-retry': ''}); await settle();
  const all = posts();
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map(item => JSON.stringify(item))).size, 1, 'three attempts, one identical command, whatever the input now says');
  assert.match(again.result.textContent, /уже была выполнена/);
  assert.equal(again.pendingBox.innerHTML, '');
}
// giving up is explicit, does not claim the outcome, and unlocks the other actions
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = '1999';
  script = [new Error('offline')];
  await m.press(SET); await settle();
  script = [{status: 200, body: view()}];
  await m.press({'data-meta-discard': ''}); await settle();
  assert.match(m.result.textContent, /Исход прошлой команды неизвестен/);
  assert.doesNotMatch(m.result.textContent, /не записан/);
  assert.equal(m.pendingBox.innerHTML, '');
  assert.doesNotMatch(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view()}];
  m.inputs.year.value = '2005';
  await m.press(SET); await settle();
  const sentBodies = posts();
  assert.notEqual(sentBodies[0].requestId, sentBodies[1].requestId, 'a new intent is a new command');
  assert.equal(sentBodies[1].value, 2005);
}
// SERIALIZATION: while a POST or its readback is in flight nothing else is sent, and the stale controls are disabled
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = '2001';
  const postGate = gate(), readGate = gate();
  script = [{status: 200, body: {ok: true, outcome: 'applied'}, gate: postGate.promise}, {status: 200, body: view({revision: 8}), gate: readGate.promise}];
  const first = m.press(SET); await settle();
  assert.match(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/, 'controls are disabled while the command is in flight');
  m.inputs.year.value = '2002';
  await m.press(SET); await m.press({'data-meta-action': 'lock', 'data-field': 'year'}); await settle();
  assert.equal(posts().length, 1, 'no second command during the POST');
  postGate.go(); await settle();
  assert.equal(calls.filter(c => !c.init.method).length, 2, 'the readback is pending');
  assert.match(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/, 'still stale until the read lands');
  await m.press(SET); await settle();
  assert.equal(posts().length, 1, 'no command on the old revision while the readback is pending');
  readGate.go(); await first; await settle();
  assert.doesNotMatch(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view({revision: 9})}];
  await m.press(SET); await settle();
  assert.equal(posts()[1].expectedRevision, 8, 'planned on the revision that was read after the first command');
}
// a failed readback after a success: the result stays, the controls stay disabled, an explicit read retry brings them back
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = '2001';
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 503, body: {error: 'unavailable'}}];
  await m.press(SET); await settle();
  assert.match(m.result.textContent, /выполнено/, 'the command result is not overwritten by the read failure');
  assert.match(m.reading.innerHTML, /Не удалось прочитать/);
  assert.match(m.reading.innerHTML, /data-meta-reload/);
  assert.match(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  const before = posts().length;
  await m.press(SET); await settle();
  assert.equal(posts().length, before, 'no command from the stale view');
  script = [{status: 200, body: view({revision: 8})}];
  await m.press({'data-meta-reload': ''}); await settle();
  assert.doesNotMatch(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  assert.equal(m.reading.innerHTML, '');
  assert.match(m.result.textContent, /выполнено/);
}
// a stale refusal re-reads; a failed re-read keeps the refusal text and the controls disabled
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  m.inputs.year = node(); m.inputs.year.value = '2001';
  script = [{status: 409, body: {error: 'stale_revision', outcome: 'rejected'}}, {status: 503, body: {error: 'unavailable'}}];
  await m.press(SET); await settle();
  assert.match(m.result.textContent, /Карточка изменилась/);
  assert.match(m.result.textContent, /Команда не выполнена/);
  assert.match(m.reading.innerHTML, /data-meta-reload/);
  assert.match(m.body.innerHTML, /data-meta-action="set" data-field="year" disabled/);
  assert.equal(m.pendingBox.innerHTML, '', 'a definite refusal ends the attempt');
  script = [{status: 200, body: view({revision: 8})}];
  await m.press({'data-meta-reload': ''}); await settle();
  script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view({revision: 9})}];
  await m.press(SET); await settle();
  const sentNow = posts();
  assert.notEqual(sentNow[0].requestId, sentNow[1].requestId);
  assert.equal(sentNow[1].expectedRevision, 8);
}
// the shapes of revert, lock, release and refresh
{
  reset(); script = [{status: 200, body: view()}];
  const m = mount();
  await m.open(); await settle();
  const sentBody = async attrs => { script = [{status: 200, body: {ok: true, outcome: 'applied'}}, {status: 200, body: view()}]; const n = posts().length; await m.press(attrs); await settle(); return posts()[n]; };
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'revert', 'data-field': 'year', 'data-history-ref': '11'})).sort(), ['action', 'expectedRevision', 'field', 'historyRef', 'requestId']);
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'lock', 'data-field': 'year'})).sort(), ['action', 'expectedRevision', 'field', 'requestId']);
  assert.deepEqual(Object.keys(await sentBody({'data-meta-action': 'release', 'data-field': 'poster'})).sort(), ['action', 'expectedRevision', 'field', 'requestId']);
  const refresh = await sentBody({'data-meta-action': 'refresh'});
  assert.deepEqual(Object.keys(refresh).sort(), ['action', 'expectedRevision', 'expectedRows', 'requestId']);
  assert.equal(refresh.expectedRows[0].refreshEpoch, 2);
}
console.log('Admin film metadata page: provenance view, pin vs dimension lock, frozen unknown command, serialized readback, pagination coherence and write shapes passed');
