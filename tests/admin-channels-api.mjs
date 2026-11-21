// AIR-562: the owner Channel admin API on the code the Worker serves (dist/server/index.js), over the real migration chain on a sqlite D1 stand-in.
// Offline only: no production database, bucket or network. Proves: fail-closed schema, the write gate (origin, action header, JSON, size, confirm), the
// preview that writes nothing, a confirmed import with CAS / readback / idempotent retry, owner decisions that survive an import, unlisted retention,
// XMLTV-only channels, malformed / duplicate / unknown / unsafe input, stale revisions, a lost reply, and that nothing else is touched or sent anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Admin from '../src/domain/epg-channel-admin.js';

const built = spawnSync(process.execPath, ['build.mjs'], {encoding: 'utf8'});
assert.equal(built.status, 0, built.stderr);
const worker = (await import(pathToFileURL(path.resolve('dist/server/index.js')).href + '?channels=' + process.pid)).default;

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'iptv-admin-channels-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch {}});
const names = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite = (file, text) => {const r = sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + text, encoding: 'utf8', maxBuffer: 1 << 26}); if (r.status !== 0) throw new Error(r.stderr);};
const rows = (file, text) => {const r = sqliteSync(['-json', '-bail', file], {input: text + ';', encoding: 'utf8', maxBuffer: 1 << 26}); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout) : [];};
const v31 = path.join(root, 'v31.sqlite'); sqlite(v31, names.filter(n => Number(n.slice(0, 4)) <= 31).map(n => fs.readFileSync('migrations/' + n, 'utf8')).join('\n'));
const v32 = path.join(root, 'v32.sqlite'); fs.copyFileSync(v31, v32); sqlite(v32, fs.readFileSync('migrations/0032_epg_channel_authority.sql', 'utf8'));

// Anything outside D1 is a failure: no bucket access, no outbound request.
const outbound = [];
globalThis.fetch = async input => {outbound.push(String(input)); throw new Error('no outbound request');};
const bucket = new Proxy({}, {get: (_, name) => () => {throw new Error('the Channel admin never touches R2: ' + String(name));}});
let copies = 0;
function fresh(source = v32, options = {}) {
  const file = path.join(root, 'db-' + (copies++) + '.sqlite'); fs.copyFileSync(source, file);
  const db = d1Standin(file, options);
  return {file, db, env: {DB: db, BUCKET: bucket}};
}
const T = 'https://iptv.example';
const HEADERS = {Origin: T, 'X-IPTV-Admin-Action': 'epg_channel_admin', 'Content-Type': 'application/json'};
const sent = [];
async function call(env, pathname, init = {}) {
  if (init.body !== undefined && typeof init.body !== 'string') init = {...init, body: JSON.stringify(init.body)};
  const response = await worker.fetch(new Request(T + '/api/admin/channels' + pathname, init), env, {waitUntil() {throw new Error('no background work');}});
  const answer = {status: response.status, body: await response.json(), headers: response.headers};
  if (answer.status === 200 && typeof init.body === 'string') sent.push(init.body, JSON.stringify(answer.body));
  return answer;
}
const post = (env, pathname, body, headers = HEADERS) => call(env, pathname, {method: 'POST', headers, body});
const SHA = 'a'.repeat(64);
const id = n => 'r' + String(n).padStart(2, '0') + 'xxxxxxxx';

// A synthetic playlist with stream URLs and a token: parsed in the "browser" (the same module), only normalized entries are sent.
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="tvg_1" tvg-name="Film One" group-title="Movies",Film One', 'http://stream.example/live/USER/PASS/1.ts?token=SECRET123',
  '#EXTINF:-1 tvg-id="tvg_2" tvg-name="News" group-title="Old",News', '#EXTGRP:News', 'https://stream.example/2.m3u8?auth=SECRET456',
  '#EXTINF:-1 tvg-id="tvg_1259" tvg-name="Sport" group-title="Sport",Sport', 'http://stream.example/3.ts',
  '#EXTINF:-1 group-title="Movies",No id', 'http://stream.example/4.ts',
].join('\r\n');
const parsed = Admin.parseM3u(PLAYLIST);
assert.deepEqual(parsed.entries, [{sourceId: 'tvg_1', name: 'Film One', group: 'Movies'}, {sourceId: 'tvg_2', name: 'News', group: 'News'}, {sourceId: 'tvg_1259', name: 'Sport', group: 'Sport'}], '#EXTGRP wins over group-title; an entry without tvg-id is dropped');
assert.deepEqual(parsed.groups, ['Movies', 'News', 'Sport']);
assert.equal(parsed.issues.missingId, 1);
assert.ok(!JSON.stringify(parsed).includes('stream.example') && !JSON.stringify(parsed).includes('SECRET'), 'no stream URL or token survives the parse');
const submission = {groups: [{name: 'Movies', policy: 'discover'}, {name: 'News', policy: 'deny_all'}, {name: 'Sport', policy: 'deny_all'}], entries: parsed.entries};
const importBody = (revision, extra = {}) => ({...structuredClone(submission), sourceSha256: SHA, expectedRevision: revision, requestId: id(revision), confirm: true, ...extra});
const batchesOf = db => db.calls.batches;

// ===== 1. fail closed: no schema, no DB =====
{
  const {env} = fresh(v31);
  let r = await call(env, '');
  assert.equal(r.status, 200); assert.deepEqual([r.body.available, r.body.reason], [false, 'absent']);
  assert.equal(r.body.activation.state, 'not_active');
  r = await post(env, '/import', importBody(0));
  assert.equal(r.status, 503); assert.equal(r.body.error, 'channel_authority_unavailable'); assert.equal(r.body.reason, 'absent');
  assert.equal(rows(fresh(v31).file, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'epg_channel%'")[0].n, 0, 'nothing is created implicitly');
  r = await call({BUCKET: bucket}, '');
  assert.equal(r.status, 503);
  r = await post({BUCKET: bucket}, '/override', {channelId: 'ch001', policy: null, expectedRevision: 1, requestId: id(1), confirm: true});
  assert.equal(r.status, 503);
}

// ===== 2. the write gate =====
{
  const {env, db} = fresh();
  const body = importBody(0);
  for (const [label, headers, status, error] of [
    ['no origin', {'X-IPTV-Admin-Action': 'epg_channel_admin', 'Content-Type': 'application/json'}, 403, 'origin_not_allowed'],
    ['other origin', {...HEADERS, Origin: 'https://evil.example'}, 403, null],
    ['no action header', {Origin: T, 'Content-Type': 'application/json'}, 403, 'action_not_allowed'],
    ['wrong action header', {...HEADERS, 'X-IPTV-Admin-Action': 'person_name_review'}, 403, 'action_not_allowed'],
    ['not JSON', {...HEADERS, 'Content-Type': 'text/plain'}, 400, 'invalid_json'],
  ]) {
    const r = await post(env, '/import', body, headers);
    assert.equal(r.status, status, label); if (error) assert.equal(r.body.error, error, label);
  }
  assert.equal((await call(env, '/import', {method: 'GET'})).status, 405);
  assert.equal((await call(env, '', {method: 'POST', headers: HEADERS, body: '{}'})).status, 405);
  assert.equal((await post(env, '/nope', {})).status, 404);
  assert.equal((await post(env, '/import', '[1]')).body.error, 'invalid_json');
  assert.equal((await call(env, '/import', {method: 'POST', headers: HEADERS, body: '{bad'})).body.error, 'invalid_json');
  const big = await call(env, '/import', {method: 'POST', headers: HEADERS, body: JSON.stringify({groups: [], entries: [], pad: 'x'.repeat(1100000)})});
  assert.equal(big.status, 413);
  assert.equal(batchesOf(db), 0, 'a refused request writes nothing');
  let r = await post(env, '/import', {...body, confirm: false}); assert.equal(r.body.error, 'confirmation_required');
  r = await post(env, '/import', {...body, confirm: undefined}); assert.equal(r.body.error, 'confirmation_required');
  r = await post(env, '/import', {...body, requestId: 'x'}); assert.equal(r.body.error, 'invalid_request_id');
  r = await post(env, '/import', {...body, expectedRevision: '0'}); assert.equal(r.body.error, 'invalid_revision');
  r = await post(env, '/import', {...body, sourceSha256: 'zz'}); assert.equal(r.body.error, 'invalid_source_digest');
  assert.equal(batchesOf(db), 0);
}

// ===== 3. malformed / duplicate / unknown / unsafe / oversized: honest error, zero writes =====
{
  const {env, db} = fresh();
  const refuse = async (label, mutate, code) => {
    const body = importBody(0); mutate(body);
    const r = await post(env, '/import', body);
    assert.equal(r.status, 422, label); assert.equal(r.body.error, 'invalid_import', label);
    assert.ok(r.body.errors.some(e => e.code === code), label + ': ' + JSON.stringify(r.body.errors));
    const p = await post(env, '/preview', {groups: body.groups, entries: body.entries});
    assert.equal(p.status, 422, label + ' preview');
  };
  await refuse('malformed id', b => {b.entries[0].sourceId = 'tvg_001';}, 'invalid_source_id');
  await refuse('not a tvg id', b => {b.entries[0].sourceId = 'bogus';}, 'invalid_source_id');
  await refuse('duplicate id', b => {b.entries.push({sourceId: 'tvg_1', name: 'Again', group: 'News'});}, 'duplicate_channel_id');
  await refuse('unknown category', b => {b.entries[0].group = 'Nope';}, 'unknown_category');
  await refuse('duplicate category', b => {b.groups.push({name: ' movies ', policy: 'deny_all'});}, 'duplicate_category');
  await refuse('bad policy', b => {b.groups[0].policy = 'allow';}, 'invalid_policy');
  await refuse('url in a name', b => {b.entries[0].name = 'http://stream.example/1.ts';}, 'unsafe_value');
  await refuse('token in a name', b => {b.entries[0].name = 'x token=SECRET';}, 'unsafe_value');
  await refuse('url in a group', b => {b.groups[0].name = 'rtsp://x/y'; b.entries[0].group = 'rtsp://x/y';}, 'unsafe_value');
  await refuse('stream url field', b => {b.entries[0].url = 'http://stream.example/1.ts';}, 'invalid_entry');
  await refuse('extra entry key', b => {b.entries[1].token = 'x';}, 'invalid_entry');
  await refuse('control characters', b => {b.entries[0].name = 'a\u0000b';}, 'invalid_name');
  await refuse('too many entries', b => {b.entries = Array.from({length: 4001}, (_, n) => ({sourceId: 'tvg_' + (n + 1), name: null, group: null}));}, 'too_many_entries');
  const raw = await post(env, '/import', {...importBody(0), rawPlaylist: PLAYLIST});
  assert.equal(raw.status, 422); assert.equal(raw.body.errors[0].code, 'unknown_field');
  assert.equal(batchesOf(db), 0, 'every refusal wrote nothing');
  assert.equal(rows(fresh().file, 'SELECT revision FROM epg_channel_revision')[0].revision, 0);
}

// ===== 4. preview writes nothing; import: CAS, readback, receipt, idempotent retry =====
{
  const {env, db, file} = fresh();
  const p = await post(env, '/preview', {groups: submission.groups, entries: submission.entries});
  assert.equal(p.status, 200); assert.equal(p.body.writes, false); assert.equal(p.body.revision, 0);
  assert.deepEqual([p.body.preview.totals.new, p.body.preview.totals.unlisted, p.body.preview.totals.unchanged], [3, 0, 0]);
  assert.equal(batchesOf(db), 0, 'the preview wrote nothing');
  let r = await post(env, '/import', importBody(5));
  assert.equal(r.status, 409); assert.equal(r.body.error, 'stale_revision'); assert.equal(r.body.currentRevision, 0);
  assert.equal(batchesOf(db), 0);
  r = await post(env, '/import', importBody(0));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.changed, r.body.idempotent, r.body.revision, r.body.previousRevision], [true, true, false, 1, 0]);
  assert.deepEqual([r.body.receipt.channels, r.body.receipt.categories, r.body.receipt.requestId], [3, 3, id(0)]);
  assert.equal(r.body.activation.state, 'not_active');
  assert.equal(batchesOf(db), 1);
  assert.deepEqual(rows(file, 'SELECT channel_id, source_id, category_key FROM epg_channel ORDER BY channel_id'), [{channel_id: 'ch001', source_id: 'tvg_1', category_key: 'movies'}, {channel_id: 'ch002', source_id: 'tvg_2', category_key: 'news'}, {channel_id: 'ch1259', source_id: 'tvg_1259', category_key: 'sport'}]);
  // a lost reply retried with the OLD revision: the stored plan is exactly this one, so it is a no-op success
  r = await post(env, '/import', importBody(0));
  assert.equal(r.status, 200); assert.deepEqual([r.body.idempotent, r.body.changed, r.body.revision], [true, false, 1]);
  assert.equal(batchesOf(db), 1, 'the retry wrote nothing');
  // a different plan on the old revision is stale, on the new revision it writes revision 2
  const other = importBody(0); other.entries = other.entries.slice(0, 2);
  assert.equal((await post(env, '/import', other)).body.error, 'stale_revision');
  const list = await call(env, '');
  assert.deepEqual([list.body.available, list.body.revision, list.body.importRevision, list.body.totals.channels, list.body.totals.byPolicy], [true, 1, 1, 3, {deny_all: 2, discover: 1, known_only: 0}]);
  assert.equal(list.body.presence.available, true);
  // published FILM-show presence: a channel with one published Film show reports it; a channel without one reports null (not "absent from the EPG")
  sqlite(file, "PRAGMA foreign_keys=OFF; UPDATE published_epg_authority SET programme_run_id='run-1' WHERE id=1; INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms) VALUES ('run-1','f1','ch001',1700000000000);");
  const withShow = Object.fromEntries((await call(env, '')).body.channels.map(c => [c.channelId, c]));
  assert.deepEqual(withShow.ch001.publishedFilmShows, {shows: 1, lastStartMs: 1700000000000});
  assert.equal(withShow.ch002.publishedFilmShows, null, 'a channel with no published Film show');
  assert.equal(withShow.ch001.lastSeenInEpg, undefined, 'the old misleading field name is gone');
}

// ===== 5. owner decisions survive an import; unlisted channels are kept; XMLTV-only channels are shown and unclassified =====
{
  const {env, db, file} = fresh();
  assert.equal((await post(env, '/import', importBody(0))).status, 200);
  // an XMLTV-only channel registered through the repository contract (the admin never invents one)
  sqlite(file, "INSERT INTO epg_channel (channel_id,source_id,origin,name,revision,last_seen_revision) VALUES ('ch777',NULL,'xmltv','Only XMLTV',1,1); UPDATE epg_channel_revision SET channel_count=channel_count+1;");
  let list = await call(env, '');
  assert.equal(list.body.totals.channels, 4); assert.equal(list.body.totals.unclassified, 1);
  const xml = list.body.channels.find(c => c.channelId === 'ch777');
  assert.deepEqual([xml.origin, xml.sourceId, xml.effective], ['xmltv', null, {policy: 'known_only', basis: 'unclassified'}]);
  assert.deepEqual((await call(env, '?queue=unclassified')).body.channels.map(c => c.channelId), ['ch777'], 'the unclassified queue');
  assert.equal((await call(env, '?q=sport')).body.channels.length, 1);
  assert.deepEqual((await call(env, '?category=news')).body.channels.map(c => c.channelId), ['ch002']);
  assert.deepEqual((await call(env, '?category=none')).body.channels.map(c => c.channelId), ['ch777']);
  assert.deepEqual((await call(env, '?policy=discover')).body.channels.map(c => c.channelId), ['ch001']);
  assert.deepEqual((await call(env, '?source=xmltv')).body.channels.map(c => c.channelId), ['ch777']);
  assert.deepEqual((await call(env, '?limit=2')).body.page, {offset: 0, limit: 2, total: 4, next: 2});

  const revision = () => rows(file, 'SELECT revision FROM epg_channel_revision')[0].revision;
  const decide = (pathname, body) => post(env, pathname, {requestId: id(revision() + 20), expectedRevision: revision(), confirm: true, ...body});
  // owner category + override (separate fields, override wins), C1: an unknown channel is not created
  let r = await decide('/category', {channelId: 'ch777', categoryKey: 'movies', note: 'owner says film'});
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true);
  r = await decide('/override', {channelId: 'ch001', policy: 'deny_all', note: 'manual'});
  assert.equal(r.status, 200); assert.equal(r.body.revision, 3);
  list = await call(env, '');
  const by = Object.fromEntries(list.body.channels.map(c => [c.channelId, c]));
  assert.deepEqual(by.ch777.effective, {policy: 'discover', basis: 'owner_category'});
  assert.deepEqual(by.ch001.effective, {policy: 'deny_all', basis: 'override'});
  assert.equal(by.ch001.category.name, 'Movies', 'the provider category is untouched by the override');
  assert.equal((await decide('/override', {channelId: 'ch404', policy: 'discover'})).status, 404);
  assert.equal((await decide('/category', {channelId: 'ch001', categoryKey: 'nope'})).body.error, 'unknown_category');
  assert.equal((await decide('/override', {channelId: 'ch001', policy: 'allow'})).body.error, 'invalid_policy');
  assert.equal((await decide('/override', {channelId: 'bad id', policy: 'discover'})).body.error, 'invalid_channel');
  assert.equal((await decide('/override', {channelId: 'ch001'})).body.error, 'invalid_policy');
  // idempotent retry of the exact same decision on a stale revision: no write
  const before = batchesOf(db);
  r = await post(env, '/override', {requestId: id(99), expectedRevision: 1, confirm: true, channelId: 'ch001', policy: 'deny_all', note: 'manual'});
  assert.deepEqual([r.status, r.body.idempotent, r.body.changed, r.body.revision], [200, true, false, 3]);
  assert.equal(batchesOf(db), before);
  // a different decision on a stale revision is a conflict and writes nothing
  r = await post(env, '/override', {requestId: id(98), expectedRevision: 1, confirm: true, channelId: 'ch002', policy: 'discover'});
  assert.deepEqual([r.status, r.body.error, r.body.currentRevision], [409, 'stale_revision', 3]);
  assert.equal(batchesOf(db), before);

  // re-import: Sport is gone, Movies changes group, News is renamed. Override and owner category survive; the unlisted channel is kept.
  const next = {groups: [{name: 'Movies', policy: 'discover'}, {name: 'News', policy: 'discover'}], entries: [{sourceId: 'tvg_1', name: 'Film One', group: 'News'}, {sourceId: 'tvg_2', name: 'News HD', group: 'News'}]};
  const prev = await post(env, '/preview', next);
  const t = prev.body.preview.totals, items = prev.body.preview.items;
  assert.deepEqual([t.unlisted, t.renamed, t.changedCategory, t.new, t.overridesKept, t.ownerCategoriesKept], [1, 1, 1, 0, 1, 1]);
  assert.deepEqual(items.unlisted.map(x => x.channelId), ['ch1259']);
  assert.deepEqual(items.renamed.map(x => [x.channelId, x.from, x.to]), [['ch002', 'News', 'News HD']]);
  assert.ok(items.conflicts.some(x => x.channelId === 'ch001' && x.kind === 'override_retained'), 'the override is reported as retained');
  assert.deepEqual(prev.body.preview.categories.removed.map(c => c.name), ['Sport']);
  r = await post(env, '/import', {...next, sourceSha256: 'b'.repeat(64), expectedRevision: 3, requestId: id(50), confirm: true});
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.revision, 4);
  list = await call(env, '?limit=200');
  const after = Object.fromEntries(list.body.channels.map(c => [c.channelId, c]));
  assert.equal(list.body.totals.channels, 4, 'nothing was deleted');
  assert.deepEqual(after.ch1259.effective, {policy: 'known_only', basis: 'unclassified'}); assert.equal(after.ch1259.listed, false); assert.equal(after.ch1259.category, null);
  assert.deepEqual(after.ch001.effective, {policy: 'deny_all', basis: 'override'}); assert.equal(after.ch001.overrideNote, 'manual');
  assert.equal(after.ch777.ownerCategory.name, 'Movies'); assert.equal(after.ch777.listed, true, 'a registered XMLTV channel stays listed');
  assert.equal(after.ch002.name, 'News HD'); assert.deepEqual(after.ch002.effective, {policy: 'discover', basis: 'category'});
  assert.deepEqual((await call(env, '?source=unlisted')).body.channels.map(c => c.channelId), ['ch1259']);
  // the override note and the owner-category note are independent decisions: saving one never rewrites the other
  r = await decide('/category', {channelId: 'ch001', categoryKey: 'news', note: 'category note'});
  assert.equal(r.status, 200);
  const notes = rows(file, "SELECT override_policy, override_note, owner_category_key, owner_category_note FROM epg_channel WHERE channel_id='ch001'")[0];
  assert.deepEqual(notes, {override_policy: 'deny_all', override_note: 'manual', owner_category_key: 'news', owner_category_note: 'category note'});
  r = await decide('/override', {channelId: 'ch001', policy: 'discover', note: 'policy note'});
  assert.equal(r.status, 200);
  assert.deepEqual(rows(file, "SELECT override_note, owner_category_note FROM epg_channel WHERE channel_id='ch001'")[0], {override_note: 'policy note', owner_category_note: 'category note'});
  // clearing a decision
  r = await decide('/override', {channelId: 'ch001', policy: null});
  assert.equal(r.status, 200);
  assert.equal(rows(file, "SELECT override_policy, override_note, override_at FROM epg_channel WHERE channel_id='ch001'")[0].override_policy, null);
}

// ===== 6. partial failure and a lost reply: honest unknown outcome, retry is safe =====
{
  let fail = false;
  const {env, db, file} = fresh(v32, {onBatch: async () => {if (fail) throw new Error('D1 unavailable');}});
  fail = true;
  let r = await post(env, '/import', importBody(0));
  assert.equal(r.status, 503); assert.equal(r.body.error, 'storage_unavailable'); assert.equal(r.body.outcome, 'unknown');
  assert.equal(rows(file, 'SELECT revision FROM epg_channel_revision')[0].revision, 0, 'a failed batch left nothing behind');
  fail = false;
  r = await post(env, '/import', importBody(0));
  assert.equal(r.status, 200); assert.equal(r.body.revision, 1);
  fail = true;
  r = await post(env, '/override', {requestId: id(7), expectedRevision: 1, confirm: true, channelId: 'ch001', policy: 'discover'});
  assert.equal(r.status, 503); assert.equal(r.body.outcome, 'unknown');
  fail = false;
  r = await post(env, '/override', {requestId: id(7), expectedRevision: 1, confirm: true, channelId: 'ch001', policy: 'discover'});
  assert.deepEqual([r.status, r.body.revision], [200, 2]);
  // a reply lost AFTER the write (the batch ran, then the answer was dropped): the retry on the old revision is a no-op, not a second write
  const calls = batchesOf(db);
  r = await post(env, '/override', {requestId: id(7), expectedRevision: 1, confirm: true, channelId: 'ch001', policy: 'discover'});
  assert.deepEqual([r.status, r.body.idempotent], [200, true]); assert.equal(batchesOf(db), calls);
  // an incomplete schema is refused, never repaired
  sqlite(file, 'DROP TABLE epg_channel; ');
  r = await call(env, ''); assert.equal(r.status, 503); assert.equal(r.body.reason, 'incomplete');
  r = await post(env, '/override', {requestId: id(8), expectedRevision: 2, confirm: true, channelId: 'ch001', policy: null});
  assert.equal(r.status, 503);
}

// ===== 7. nothing leaked, nothing else touched =====
assert.deepEqual(outbound, [], 'no outbound request (no EPG, Discovery or TMDB call)');
for (const text of sent) assert.ok(!/stream\.example|SECRET|https?:\/\//i.test(text), 'no stream URL, token or raw playlist in any accepted request or in any answer');
const asset = await worker.fetch(new Request(T + '/admin/channels'), {BUCKET: bucket, ASSETS: undefined}, {waitUntil() {}});
assert.equal(asset.status, 200); assert.match(await asset.text(), /Каналы/);
console.log('Channel admin API: fail-closed schema, same-origin write gate, preview without writes, confirmed import with CAS, readback and idempotent retry, owner decisions and unlisted/XMLTV-only channels, malformed/duplicate/unsafe/oversized refusals, lost-reply handling, no outbound request.');
