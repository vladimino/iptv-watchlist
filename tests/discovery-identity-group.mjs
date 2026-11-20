// AIR-131 / ADR 0181: owner-confirmed group assign of selected observations. Part 1 is the pure domain; part 2 drives the real Worker
// routes on a local sqlite D1 stand-in. No Cloudflare, no TMDB, no production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as G from '../src/domain/discovery-identity-group.js';
import * as Identity from '../src/domain/discovery-identity-review.js';
import {scoped, scopedImports} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// ---- 1. pure domain ------------------------------------------------------------------------------------------------------------
assert.deepEqual(G.groupAnchors(['тихий берег', ' тихий берег ', 'quiet shore', 'a', 'x y', 'one two', 'three four', 'five six']), {anchors: ['тихий берег', 'quiet shore', 'x y', 'one two'], omitted: 2}, 'dedupe, drop too short, cap four, count the rest');
assert.deepEqual(G.groupRange('беглец'), {from: 'беглец', to: 'беглец￿'});
{
  const rows = n => Array.from({length: n}, (_, i) => ({key: 'k' + String(i).padStart(3, '0')}));
  const merged = G.groupMerge([{anchor: 'a', rows: rows(26)}, {anchor: 'b', rows: [{key: 'k001'}, {key: 'z9'}]}]);
  assert.deepEqual(merged.anchors, [{anchor: 'a', returned: 25, more: true}, {anchor: 'b', returned: 2, more: false}]);
  assert.equal(merged.merged, 26, 'one row per key');
  assert.deepEqual(merged.candidates[1].anchors, ['a', 'b'], 'a key found by two anchors lists both');
  assert.deepEqual(merged.candidates.map(c => c.key).slice(-2), ['k024', 'z9'], 'ordered by key');
  assert.equal(merged.truncated, true);
  const capped = G.groupMerge([{anchor: 'a', rows: rows(25)}, {anchor: 'b', rows: rows(25).map(r => ({key: 'm' + r.key}))}, {anchor: 'c', rows: rows(25).map(r => ({key: 'x' + r.key}))}], 50);
  assert.deepEqual([capped.merged, capped.shown, capped.dropped, capped.truncated], [75, 50, 25, true], 'cut at 50 with an explicit count');
}
assert.deepEqual(G.runtimeVerdict([95], 100), {state: 'ok', diffMinutes: 5, toleranceMinutes: 15});
assert.equal(G.runtimeVerdict([150], 95).state, 'conflict');
assert.equal(G.runtimeVerdict([100], 60).toleranceMinutes, 10, 'the floor is ten minutes');
assert.equal(G.runtimeVerdict([], 95).state, 'unknown');
assert.equal(G.runtimeVerdict([95], null).state, 'unknown', 'an unknown runtime is shown, not a block');
assert.equal(G.runtimeVerdict([40, 96], 95).state, 'ok', 'any known duration within the tolerance agrees');
assert.deepEqual(G.groupSelection(['b', 'a']).keys, ['a', 'b']);
assert.equal(G.groupSelection([]).reason, 'invalid_selection');
assert.equal(G.groupSelection(['a', 'a']).reason, 'invalid_selection', 'duplicates refuse');
assert.equal(G.groupSelection(Array.from({length: 11}, (_, i) => 'k' + i)).reason, 'group_too_large', 'over the cap refuses, never truncates');
assert.equal(G.groupSelection(Array.from({length: 10}, (_, i) => 'k' + i)).ok, true);
assert.equal(G.groupChildKey('g'.repeat(72), 10).length, 75, 'a child key stays within 80');
{
  const preview = {status: 'eligible', affected: [{id: 'a', version: 'v1'}, {id: 'b', version: 'v2'}], excluded: [{id: 'c', reason: 'runtime_conflict'}]};
  assert.equal(G.groupExactSelection(['a', 'b'], preview, {a: 'v1', b: 'v2'}).ok, true);
  const shrunk = G.groupExactSelection(['a', 'b', 'c'], preview, {a: 'v1', b: 'v2'});
  assert.deepEqual([shrunk.ok, shrunk.failing], [false, [{id: 'c', reason: 'runtime_conflict'}]], 'an eligible subset is not the selection');
  assert.equal(G.groupExactSelection(['a'], preview, {a: 'v1'}).ok, false, 'an affected key the owner did not select refuses');
  assert.equal(G.groupExactSelection(['a', 'b'], preview, {a: 'v1', b: 'other'}).failing[0].reason, 'version_changed');
}
const HASH = 'a'.repeat(64);
const group = {id: 'grp-0123456789abcdef', tmdbId: '500', programmeRunId: 'run-1', ids: ['k1', 'k2'], versions: {k1: HASH + ':assign:500', k2: 'b'.repeat(64) + ':assign:500'}};
const child = (index, id, extra = {}) => ({idempotencyKey: G.groupChildKey(group.id, index), kind: 'identity_assign', state: 'approved', observationKey: id, expectedHash: group.versions[id].split(':')[0], command: {effect: 'assign', tmdbId: '500', group: {id: group.id, size: 2, index, anchorTmdbId: '500', programmeRunId: 'run-1'}}, ...extra});
assert.equal(G.groupBarrier({group, children: [child(1, 'k1'), child(2, 'k2')]}).ok, true);
assert.equal(G.groupBarrier({group, children: [child(1, 'k1')]}).reason, 'group_incomplete');
assert.equal(G.groupBarrier({group, children: [child(1, 'k1'), child(2, 'k2', {state: 'running'})]}).reason, 'group_running');
assert.equal(G.groupBarrier({group, children: [child(1, 'k1'), child(2, 'k2', {observationKey: 'other'})]}).reason, 'group_mismatch');
assert.equal(G.groupBarrier({group, children: [child(1, 'k1'), child(2, 'k2', {expectedHash: 'c'.repeat(64)})]}).reason, 'group_mismatch');
assert.equal(G.groupBarrier({group, children: [child(1, 'k1', {kind: 'identity_reject'}), child(2, 'k2')]}).reason, 'group_mismatch');
assert.equal(G.groupBarrier({group, children: [child(2, 'k2'), child(1, 'k1')]}).reason, 'group_mismatch', 'order is part of the scope');
assert.equal(G.groupBarrier({group, children: [child(1, 'k1', {state: 'receipt'}), child(2, 'k2')]}).ok, true, 'a receipt child is checked against the issued identity, not the current decision hash');
assert.equal(G.groupDrift({baseProgrammeRunId: 'r', observed: {programmeRunId: 'r', generation: 5}, lastGeneration: 5}), null);
assert.equal(G.groupDrift({baseProgrammeRunId: 'r', observed: {programmeRunId: 'r2', generation: 5}, lastGeneration: 5}), 'programme_moved');
assert.equal(G.groupDrift({baseProgrammeRunId: 'r', observed: {programmeRunId: 'r', generation: 9}, lastGeneration: 5}), 'generation_moved');
assert.equal(G.groupOutcomeState([{outcome: 'applied'}, {outcome: 'applied'}]), 'applied');
assert.equal(G.groupOutcomeState([{outcome: 'applied'}, {outcome: 'conflict'}]), 'partial');
assert.equal(G.groupOutcomeState([{outcome: 'conflict'}]), 'refused');
assert.equal(G.groupOutcomeState([{outcome: 'applied'}, {outcome: 'unknown'}]), 'unknown');
assert.equal(G.groupBasis('  ok  '), 'ok');
assert.equal(G.groupBasis(''), null);
assert.equal(G.groupBasis('x'.repeat(201)), null);
{
  const film = {id: 'tmdb_500', tmdbId: '500', canonicalIdentity: 'tmdb:500', title: 'Тихий берег', year: 2001, runtime: 95};
  const proof = (decision, extra = {}) => ({record: {key: 'тихий берег|2001', year: 2001, durations: [95], confirmedTmdbId: null, decision, ...extra}, decisionHash: HASH, hashOk: true, current: true});
  const ok = G.groupAssess({tmdbId: '500', film, proof: proof({status: 'needs_verification'})});
  assert.equal(ok.selectable, true);
  assert.equal(ok.version, HASH + ':assign:500');
  assert.deepEqual(ok.plan.after, {status: 'verified', tmdbId: '500', filmId: 'tmdb_500', rejectedTmdbIds: []});
  const reasons = (decision, extra, f = film) => G.groupAssess({tmdbId: '500', film: f, proof: proof(decision, extra)}).reasons;
  assert.deepEqual(reasons({status: 'needs_verification'}, {durations: [150]}), ['runtime_conflict']);
  assert.deepEqual(reasons({status: 'needs_verification'}, {year: 2010}), ['year_conflict'], 'a remake of another year is refused by the unchanged gate');
  assert.deepEqual(reasons({status: 'needs_verification'}, {}, {...film, canonicalIdentity: 'tmdb_tv:500', mediaType: 'tv'}), ['tmdb_tv']);
  assert.deepEqual(reasons({status: 'needs_verification'}, {}, null), ['film_absent']);
  assert.deepEqual(reasons({status: 'needs_verification', revokedOwnerAssign: {tmdbId: '500'}}), ['revoked_fence']);
  assert.deepEqual(reasons({status: 'verified', tmdbId: '777', ownerIdentity: {effect: 'assign', tmdbId: '777'}}), ['other_owner_assignment']);
  assert.deepEqual(reasons({status: 'needs_verification', scoring: {acceptedTmdbId: '999'}}), ['scorer_other_id']);
  assert.deepEqual(reasons({status: 'verified', tmdbId: '500', filmId: 'tmdb_500', identitySource: 'owner', ownerIdentity: {effect: 'assign', tmdbId: '500'}}), ['already_current']);
  assert.deepEqual(reasons(null), ['no_decision']);
  assert.deepEqual(G.groupAssess({tmdbId: '500', film, proof: {...proof({status: 'needs_verification'}), hashOk: false}}).reasons, ['proof_torn'], 'a torn proof is not trusted');
  assert.deepEqual(G.groupAssess({tmdbId: '500', film, proof: {...proof({status: 'needs_verification'}), current: false}}).reasons, ['proof_stale'], 'an observation of another run is not trusted');
  const unknown = G.groupAssess({tmdbId: '500', film: {...film, runtime: null}, proof: proof({status: 'needs_verification'})});
  assert.equal(unknown.selectable, true);
  assert.deepEqual(unknown.info, ['runtime_unknown'], 'unknown runtime is shown, not a block');
  assert.deepEqual(G.groupAssess({tmdbId: '500', film, proof: proof({status: 'verified', tmdbId: '600', filmId: 'tmdb_600', identitySource: 'tmdb_detail'})}).info, ['replaces_verified']);
}
assert.doesNotMatch(fs.readFileSync('src/domain/discovery-identity-group.js', 'utf8'), /\bfetch\b|BUCKET|Date\.now|new Date\(|env\./, 'the group domain is pure');

// ---- 2. the real routes on a D1 stand-in -------------------------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-identity-group-'));
process.on('exit', () => { try { fs.rmSync(root, {recursive: true, force: true}); } catch {} });
const chain = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 11).sort();
const file = path.join(root, 'group.sqlite');
const built = sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + chain.map(name => fs.readFileSync('migrations/' + name, 'utf8')).join('\n'), encoding: 'utf8', maxBuffer: 1 << 26});
if (built.status !== 0) throw new Error(built.stderr);
const db = d1Standin(file);
db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const bucket = new MemoryBucket();
const env = {DB: db, BUCKET: bucket, discoveryLease: null};
const RUN = '22222222-2222-4222-8222-222222222222';
const now = Date.now();
const show = start => ({channelId: 'c1', channel: 'Первый', start, end: start + 7200000});
const item = (key, title, year, durations = [95], extra = {}) => ({key, title, normalizedTitle: key.split('|')[0], year, durations, shows: [show(now + 3 * 3600000)], seenInLatestSnapshot: true, lastSeenAt: now - 3600000, lastAiring: now + 3 * 3600000, ...extra});
const items = [
  item('тихий берег|2001', 'Тихий берег', 2001),
  item('тихий берег|2002', 'Тихий берег', 2002),
  item('тихий берег фильм|2001', 'Тихий берег. Фильм', 2001),
  item('тихий берег 2|2001', 'Тихий берег 2', 2001, [150]),
  item('тихий берег|2010', 'Тихий берег', 2010),
  item('тихий берег|1999', 'Тихий берег', 1999),
  item('тихий берег три|2001', 'Тихий берег три', 2001),
  item('тихий берег четыре|2001', 'Тихий берег четыре', 2001),
  item('тихий берег пять|2001', 'Тихий берег пять', 2001),
  item('тихий берег шесть|2001', 'Тихий берег шесть', 2001, [95], {confirmedTmdbId: '600'}),
  item('громкий берег|2001', 'Громкий берег', 2001),
];
const lease = (await Authority.acquireLease(env, {programmeRunId: null})).lease;
env.discoveryLease = lease;
await Authority.replaceLedger(env, {programmeRunId: RUN, items});
const need = key => ({status: 'needs_verification', attempts: 1, evidenceKey: Authority.evidenceKey(items.find(entry => entry.key === key)), terminalReason: null, retryAt: null});
const decisions = {};
for (const entry of items) decisions[entry.key] = need(entry.key);
decisions['тихий берег|1999'] = {...need('тихий берег|1999'), scoring: {acceptedTmdbId: '999'}};
decisions['тихий берег три|2001'] = {...need('тихий берег три|2001'), revokedOwnerAssign: {tmdbId: '500', requestId: 'req-original-000001', revokedBy: 'req-revoke-00000001', at: '2026-11-20T08:00:00.000Z'}};
decisions['тихий берег четыре|2001'] = {...need('тихий берег четыре|2001'), status: 'verified', tmdbId: '777', filmId: 'tmdb_777', identitySource: 'owner', ownerIdentity: {effect: 'assign', tmdbId: '777', requestId: 'req-other-owner-0001', at: '2026-11-20T08:00:00.000Z', basis: 'b'}};
delete decisions['тихий берег пять|2001'];
await Authority.routeWrite(env, 'epg/discovery-resolution.json', decisions);
const film = {id: 'tmdb_500', tmdbId: '500', canonicalIdentity: 'tmdb:500', title: 'Тихий берег', original: 'Quiet Shore', year: 2001, runtime: 95, aliases: ['Тихий берег. Фильм'], movieTitles: []};
const tvFilm = {id: 'tmdb_tv_501', tmdbId: '501', canonicalIdentity: 'tmdb_tv:501', title: 'Сериал', year: 2001, mediaType: 'tv'};
await Authority.replaceCatalog(env, {tmdb_500: film, tmdb_600: {id: 'tmdb_600', tmdbId: '600', canonicalIdentity: 'tmdb:600', title: 'Шесть', year: 2001, runtime: 95}});
await Authority.writeContinuation(env, {stage: 'paused', reason: null, remainingChunks: 6, programmeRunId: RUN, at: new Date().toISOString()}, null);
await Authority.routeWrite(env, 'epg/discovery-status.json', {schemaVersion: 2, stage: 'complete', programmeRunId: RUN, retryAt: null, at: new Date().toISOString()});
await Authority.releaseLease(env, lease);
env.discoveryLease = null;
await bucket.put('epg/published-generation.json', JSON.stringify({phase: 'published', programmeRunId: RUN}));
// A catalogue admission of television: the anchor must be a movie.
db.sql("INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_501','501','tv','tmdb_tv:501',NULL,NULL,1,'current','" + JSON.stringify(tvFilm).replace(/'/g, "''") + "')");

let offset = 0;
const FrozenDate = class extends Date { constructor(...args) { super(...(args.length ? args : [Date.now() + offset])); } static now() { return Date.now.call(Date) + offset; } };
const realNow = Date.now.bind(Date);
FrozenDate.now = () => realNow() + offset;
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ReadableStream, WritableStream, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone, encodeURIComponent, decodeURIComponent, ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [], fetch: async () => new Response('{}'), DiscoveryAuthority: Authority});
vm.runInContext(scoped('src/domain/discovery-observation-index.js', 'DiscoveryIndex'), context);
for (const f of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), context);
for (const f of ['src/admin/owner-reviews.js', 'src/admin/read.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), context);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), context);
vm.runInContext(scoped('src/domain/limbo-inventory.js', 'LimboInventory'), context);
vm.runInContext(fs.readFileSync('src/admin/limbo.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-actions.js', 'AdminActions'), context);
vm.runInContext(scoped('src/domain/discovery-identity-review.js', 'DiscoveryIdentity'), context);
vm.runInContext(scoped('src/domain/discovery-recovery.js', 'DiscoveryRecovery'), context);
vm.runInContext(scopedImports('src/domain/discovery-identity-group.js', 'DiscoveryIdentityGroup', 'const {identityCommand,identityMovieId,identityVersion}=DiscoveryIdentity;'), context);
vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/admin/identity-group.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/film-availability.js', 'FilmAvailability'), context);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), context);
const origin = 'https://iptv.example';
const headers = (action = 'discovery_identity_correct') => ({'Cf-Access-Jwt-Assertion': 'header.payload.signature', Origin: origin, 'X-IPTV-Admin-Action': action, 'Content-Type': 'application/json'});
const withDb = handle => ({...env, DB: handle, BUCKET: bucket});
const send = async (route, init, handle = db) => { const response = await context.worker.fetch(new Request(origin + '/api/admin/discovery-recovery/' + route, init), withDb(handle), {waitUntil() {}}); return {status: response.status, body: await response.json()}; };
const preview = (tmdbId = '500', handle = db) => send('group-preview?tmdbId=' + tmdbId, undefined, handle);
const post = (route, body, handle = db) => send(route, {method: 'POST', headers: headers(), body: JSON.stringify(body)}, handle);
let n = 0;
const gid = () => 'group-' + String(++n).padStart(12, '0');
const snapshot = () => JSON.stringify([db.sql('SELECT * FROM discovery_decision ORDER BY observation_key'), db.sql('SELECT * FROM discovery_decision_history ORDER BY observation_key, revision'), db.sql('SELECT * FROM discovery_intent ORDER BY idempotency_key'), db.sql('SELECT * FROM discovery_admission ORDER BY film_id'), db.sql('SELECT * FROM discovery_lease'), db.sql('SELECT generation FROM discovery_authority')]);
const K = {a: 'тихий берег|2001', b: 'тихий берег|2002', c: 'тихий берег фильм|2001'};
const confirmBody = (keys, extra = {}) => ({tmdbId: '500', keys, basis: 'это тот фильм', accepted: true, idempotencyKey: gid(), ...extra});
const intents = () => db.sql("SELECT * FROM discovery_intent WHERE idempotency_key LIKE 'group-%' ORDER BY idempotency_key");
const read = async key => (await Authority.routeRead(env, 'epg/discovery-resolution.json')).value[key];

// GET: bounded, partial, deterministic, and it writes nothing.
const before = snapshot();
const first = await preview();
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.equal(snapshot(), before, 'the preview writes nothing');
assert.equal(first.body.available, true);
assert.equal(first.body.coverage.kind, 'partial');
assert.deepEqual(first.body.coverage.anchors.map(a => a.anchor), ['тихий берег', 'quiet shore', 'тихий берег фильм'], 'anchors in catalogue order, deduplicated');
assert.equal(first.body.coverage.dropped, 0);
assert.deepEqual(first.body.rows.map(r => r.key), [...first.body.rows.map(r => r.key)].sort(), 'ordered by key');
assert.equal(first.body.rows.some(r => r.key === 'громкий берег|2001'), false, 'a title that shares no anchor prefix is not offered');
const row = key => first.body.rows.find(r => r.key === key);
assert.equal(row(K.a).selectable, true);
assert.equal(row(K.b).selectable, true, 'one year apart is within the unchanged gate');
assert.equal(row(K.c).selectable, true, 'another spelling that shares the prefix');
assert.deepEqual(row('тихий берег 2|2001').reasons, ['runtime_conflict']);
assert.deepEqual(row('тихий берег|2010').reasons, ['year_conflict'], 'remake of another year');
assert.deepEqual(row('тихий берег|1999').reasons, ['year_conflict', 'scorer_other_id'].sort((x, y) => row('тихий берег|1999').reasons.indexOf(x) - row('тихий берег|1999').reasons.indexOf(y)));
assert.deepEqual(row('тихий берег три|2001').reasons, ['revoked_fence'], 'the revoked-assign fence is respected');
assert.deepEqual(row('тихий берег четыре|2001').reasons, ['other_owner_assignment']);
assert.deepEqual(row('тихий берег пять|2001').reasons, ['no_decision']);
assert.equal(row('тихий берег шесть|2001').selectable, true, 'a candidate that names another confirmed id still passes the unchanged gate on its own evidence');
assert.equal(first.body.film.runtime, 95);
assert.match(first.body.pin, /^D1\.[0-9a-f]{32}$/);
assert.equal((await preview('501')).body.reason, 'film_not_movie', 'television is never the anchor');
assert.equal((await preview('9999')).body.reason, 'film_absent');
assert.equal((await send('group-preview?tmdbId=abc')).status, 400);
assert.equal((await send('group-preview', {method: 'POST'})).status, 405);
assert.equal((await send('group-preview?tmdbId=500')).body.pin, first.body.pin, 'the pin is stable while nothing changes');

// POST guards.
assert.equal((await send('group-confirm', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(confirmBody([K.a]))})).status, 403, 'no Access assertion, no group');
assert.equal((await post('group-confirm', confirmBody([K.a], {pin: first.body.pin, accepted: false}))).body.refusal, 'confirmation_missing');
assert.equal((await post('group-confirm', confirmBody([K.a], {pin: first.body.pin, basis: ''}))).body.refusal, 'basis_required');
assert.equal((await post('group-confirm', confirmBody([K.a, K.a], {pin: first.body.pin}))).body.refusal, 'invalid_selection', 'duplicate keys');
assert.equal((await post('group-confirm', confirmBody(Array.from({length: 11}, (_, i) => 'k' + i), {pin: first.body.pin}))).body.refusal, 'group_too_large', 'over the cap refuses, never shrinks');
assert.equal((await post('group-confirm', confirmBody([K.a], {pin: 'D1.' + '0'.repeat(32)}))).body.refusal, 'stale_pin');
assert.equal((await post('group-confirm', confirmBody([K.a], {pin: first.body.pin, idempotencyKey: 'short'}))).status, 400);
// Exact binding: a key that is not selectable, not shown, or unselectable refuses the WHOLE confirmation and writes nothing.
for (const [label, keys, reason] of [['runtime conflict', [K.a, 'тихий берег 2|2001'], 'runtime_conflict'], ['not a candidate', [K.a, 'громкий берег|2001'], 'record_not_read'], ['revoked fence', [K.a, 'тихий берег три|2001'], 'revoked_fence']]) {
  const refused = await post('group-confirm', confirmBody(keys, {pin: first.body.pin}));
  assert.equal(refused.status, 409, label);
  assert.equal(refused.body.refusal, 'group_selection_changed', label);
  assert.ok(refused.body.failing.some(entry => entry.reason === reason), label + ': ' + JSON.stringify(refused.body.failing));
  assert.equal(intents().length, 0, label + ': no child was written, the selection was not shrunk');
}
// A live writer: the confirmation refuses.
{
  db.sql("UPDATE discovery_lease SET lease_id='someone', expires_at=" + (Date.now() + 60000) + ", programme_run_id='" + RUN + "' WHERE id=1");
  assert.equal((await post('group-confirm', confirmBody([K.a], {pin: first.body.pin}))).body.refusal, 'writer_active');
  db.sql('UPDATE discovery_lease SET expires_at=0 WHERE id=1');
}

// Confirm: N children in one batch.
const idemA = gid();
const confirmed = await post('group-confirm', confirmBody([K.c, K.a, K.b], {pin: first.body.pin, idempotencyKey: idemA}));
assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
assert.deepEqual(confirmed.body.confirmation.ids, [K.c, K.a, K.b].sort(), 'the issued ids are sorted and equal the selection');
assert.deepEqual(confirmed.body.members.map(m => m.index), [1, 2, 3]);
assert.deepEqual(confirmed.body.cost, {writes: 3, externalCalls: 0});
const children = intents();
assert.equal(children.length, 3);
assert.deepEqual(children.map(c => c.idempotency_key), [1, 2, 3].map(i => G.groupChildKey(idemA, i)));
assert.ok(children.every(c => c.kind === 'identity_assign' && c.state === 'approved'));
const command1 = JSON.parse(children[0].command_json);
assert.deepEqual([command1.group.id, command1.group.size, command1.group.index, command1.group.anchorTmdbId, command1.group.programmeRunId], [idemA, 3, 1, '500', RUN]);
assert.equal((await post('group-confirm', confirmBody([K.a], {pin: first.body.pin, idempotencyKey: idemA}))).body.refusal, 'idempotency_conflict', 'a group key cannot be reused');
assert.equal(intents().length, 3, 'a refused reuse writes nothing');
assert.equal(db.sql('SELECT COUNT(*) AS n FROM film')[0].n, 0, 'no Film is created');

// Execute: all applied, per-key receipts, history, unrelated keys untouched.
const unrelated = JSON.stringify(db.sql("SELECT * FROM discovery_decision WHERE observation_key NOT IN ('" + [K.a, K.b, K.c].join("','") + "') ORDER BY observation_key"));
const historyBefore = db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n;
const executed = await post('group-execute', {confirmation: confirmed.body.confirmation});
assert.equal(executed.status, 200, JSON.stringify(executed.body));
assert.equal(executed.body.state, 'applied');
assert.deepEqual(executed.body.outcomes.map(o => o.outcome), ['applied', 'applied', 'applied']);
for (const [index, key] of [K.c, K.a, K.b].sort().entries()) {
  const stored = await read(key);
  assert.deepEqual([stored.status, stored.tmdbId, stored.identitySource], ['verified', '500', 'owner']);
  assert.equal(stored.ownerIdentity.requestId, G.groupChildKey(idemA, index + 1));
  assert.match(stored.ownerIdentity.identityBasis, /^[0-9a-f]{64}$/, 'identityBasis recorded as provenance');
  assert.equal(JSON.parse(db.sql("SELECT receipt_json FROM discovery_intent WHERE idempotency_key='" + G.groupChildKey(idemA, index + 1) + "'")[0].receipt_json).capability, 'discovery_identity_group_assign');
}
assert.equal(db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n, historyBefore + 3, 'one history row per applied key');
assert.equal(JSON.stringify(db.sql("SELECT * FROM discovery_decision WHERE observation_key NOT IN ('" + [K.a, K.b, K.c].join("','") + "') ORDER BY observation_key")), unrelated, 'unrelated observations are untouched');
assert.equal(db.sql('SELECT COUNT(*) AS n FROM film')[0].n, 0);
assert.ok(Number(db.sql('SELECT expires_at FROM discovery_lease')[0].expires_at) <= Date.now(), 'the lease is released');
// Replay: receipts only, no write.
const afterRun = snapshot();
const replay = await post('group-execute', {confirmation: confirmed.body.confirmation});
assert.deepEqual([replay.status, replay.body.replayed, replay.body.state], [200, true, 'applied']);
assert.equal(snapshot(), afterRun, 'a replay of a finished group writes nothing');
const receiptRead = await send('group-receipt?groupKey=' + idemA);
assert.deepEqual([receiptRead.status, receiptRead.body.size, receiptRead.body.complete, receiptRead.body.outcomes.map(o => o.outcome)], [200, 3, true, ['applied', 'applied', 'applied']]);
assert.equal(snapshot(), afterRun, 'reading the receipt writes nothing');
assert.equal((await send('group-receipt?groupKey=group-doesnotexist00')).status, 404);
// The applied keys are now owner-assigned: a new preview shows them as already current.
const after = await preview();
assert.ok(after.body.rows.filter(r => [K.a, K.b, K.c].includes(r.key)).every(r => r.reasons.includes('already_current')));



// ---- 2b. refusals, partial results, drift, lease and expiry ----------------------------------------------------------------------
const order = [K.a, K.b, K.c].sort();
const dec = row => JSON.parse(db.sql("SELECT payload_json FROM discovery_decision WHERE observation_key='" + row.replace(/'/g, "''") + "'")[0].payload_json);
async function setDecision(key, payload) {
  db.sql("UPDATE discovery_decision SET payload_json='" + JSON.stringify(payload).replace(/'/g, "''") + "', decision_hash='" + await Authority.decisionHash(payload) + "', status='" + payload.status + "', tmdb_id=" + (payload.tmdbId ? "'" + payload.tmdbId + "'" : 'NULL') + ", film_id=" + (payload.filmId ? "'" + payload.filmId + "'" : 'NULL') + " WHERE observation_key='" + key.replace(/'/g, "''") + "'");
}
async function reset(keys = order) { for (const key of keys) await setDecision(key, need(key)); db.sql('DELETE FROM published_epg_show'); }
const hooked = fn => { const state = {renews: 0, writes: 0}; return d1Standin(file, {onBatch: async statements => fn(statements.map(statement => statement.text), state)}); };
const hasText = (texts, pattern) => texts.some(text => pattern.test(text));
async function stage(keys = order) {
  await reset();
  const view = await preview();
  const confirmation = await post('group-confirm', confirmBody(keys, {pin: view.body.pin}));
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
  return confirmation.body;
}
const states = group => db.sql("SELECT idempotency_key, state FROM discovery_intent WHERE idempotency_key LIKE '" + group.group.id + "-%' ORDER BY idempotency_key").map(row => row.state);

// Partial application: one key's decision changed after the owner confirmed. The others apply, the confirmed scope is never shrunk, and the
// replay finishes only what has no receipt, without asking a receipt child for its old hash.
{
  const group = await stage();
  const original = dec(order[1]);
  await setDecision(order[1], {...original, attempts: 7});
  const run = await post('group-execute', {confirmation: group.confirmation});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'conflict', 'applied'], 'per-key results, no all-or-nothing');
  assert.equal(run.body.outcomes[1].reason, 'decision_changed');
  assert.equal(run.body.state, 'partial');
  assert.deepEqual(states(group), ['receipt', 'approved', 'receipt'], 'the conflicting child stays approved, never rewritten');
  assert.equal(dec(order[1]).attempts, 7, 'the changed decision was not overwritten');
  const historyNow = db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n;
  const again = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual(again.body.outcomes.map(o => o.outcome), ['applied', 'conflict', 'applied'], 'the receipt children pass the barrier although their decision hash moved on purpose');
  assert.equal(again.body.outcomes[0].replayed, true);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n, historyNow, 'a replay rewrites no receipt child');
  await setDecision(order[1], original);
  const finished = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual(finished.body.outcomes.map(o => o.outcome), ['applied', 'applied', 'applied'], 'the pending key finishes once its CAS holds again');
  assert.equal(finished.body.state, 'applied');
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n, historyNow + 1, 'exactly the one pending key was written');
}

// The issuance barrier: nothing is written, nothing is recreated.
{
  const group = await stage();
  const baseline = snapshot();
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key='" + G.groupChildKey(group.group.id, 2) + "'");
  const missing = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual([missing.status, missing.body.refusal], [409, 'group_incomplete']);
  assert.equal(db.sql("SELECT COUNT(*) AS n FROM discovery_intent WHERE idempotency_key='" + G.groupChildKey(group.group.id, 2) + "'")[0].n, 0, 'a missing child is never recreated');
  assert.equal(JSON.stringify(db.sql('SELECT * FROM discovery_decision ORDER BY observation_key')), JSON.stringify(JSON.parse(baseline)[0]), 'no decision was written');
  const fresh = await stage();
  db.sql("UPDATE discovery_intent SET observation_key='другой|2001' WHERE idempotency_key='" + G.groupChildKey(fresh.group.id, 1) + "'");
  assert.equal((await post('group-execute', {confirmation: fresh.confirmation})).body.refusal, 'group_mismatch');
  const third = await stage();
  db.sql("UPDATE discovery_intent SET expected_hash='" + 'e'.repeat(64) + "' WHERE idempotency_key='" + G.groupChildKey(third.group.id, 3) + "'");
  assert.equal((await post('group-execute', {confirmation: third.confirmation})).body.refusal, 'group_mismatch', 'a child hash that is not the issued version refuses');
  const fourth = await stage();
  db.sql("UPDATE discovery_intent SET state='running' WHERE idempotency_key='" + G.groupChildKey(fourth.group.id, 2) + "'");
  const running = await post('group-execute', {confirmation: fourth.confirmation});
  assert.deepEqual([running.status, running.body.refusal, running.body.state], [409, 'in_progress', 'unknown'], 'a running child is unknown and is never continued past');
  assert.deepEqual(order.map(key => dec(key).status), ['needs_verification', 'needs_verification', 'needs_verification'], 'nothing was applied');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}

// An unknown outcome stops the run: the rest is not attempted, and a replay does not continue past the running child.
{
  const group = await stage();
  const flaky = hooked((texts, state) => { if (hasText(texts, /^UPDATE discovery_decision SET/) && ++state.writes === 2) throw new Error('D1_ERROR: connection lost'); });
  const run = await post('group-execute', {confirmation: group.confirmation}, flaky);
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'unknown', 'not_attempted'], JSON.stringify(run.body));
  assert.equal(run.body.outcomes[2].reason, 'unknown');
  assert.equal(run.body.state, 'unknown');
  assert.deepEqual(states(group), ['receipt', 'running', 'approved']);
  const history = db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n;
  const blind = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual([blind.status, blind.body.refusal], [409, 'in_progress'], 'no blind retry');
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n, history);
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}

// Drift: only this run's own generation progress is allowed between keys.
for (const [label, mutate, reason] of [
  ['an external generation move', () => db.sql('UPDATE discovery_authority SET generation=generation+1'), 'generation_moved'],
  ['the programme run moving', () => db.sql("UPDATE discovery_authority SET programme_run_id='33333333-3333-4333-8333-333333333333'"), 'programme_moved'],
]) {
  const group = await stage();
  const flaky = hooked((texts, state) => { if (hasText(texts, /^UPDATE discovery_lease SET expires_at=/) && ++state.renews === 2) mutate(); });
  const run = await post('group-execute', {confirmation: group.confirmation}, flaky);
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'not_attempted', 'not_attempted'], label + ': ' + JSON.stringify(run.body));
  assert.equal(run.body.outcomes[1].reason, reason, label);
  assert.equal(run.body.outcomes[2].reason, reason, label + ': the rest stops too');
  assert.equal(run.body.state, 'partial');
  db.sql("UPDATE discovery_authority SET programme_run_id='" + RUN + "'");
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// Own progress is allowed: a clean run advances the generation by its own writes and never trips the fence (the full run above).
{
  const group = await stage();
  const generation = db.sql('SELECT generation FROM discovery_authority')[0].generation;
  const run = await post('group-execute', {confirmation: group.confirmation});
  assert.equal(run.body.state, 'applied');
  assert.ok(db.sql('SELECT generation FROM discovery_authority')[0].generation >= generation + 3, 'the run moved the generation itself');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// A lease that cannot be renewed stops the run.
{
  const group = await stage();
  const flaky = hooked((texts, state) => { if (hasText(texts, /^UPDATE discovery_lease SET expires_at=/) && ++state.renews === 2) db.sql('UPDATE discovery_lease SET expires_at=0 WHERE id=1'); });
  const run = await post('group-execute', {confirmation: group.confirmation}, flaky);
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'not_attempted', 'not_attempted'], JSON.stringify(run.body));
  assert.equal(run.body.outcomes[1].reason, 'lease_lost');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// The run budget: no new key starts later than 60 seconds after the lease was taken.
{
  const group = await stage();
  const flaky = hooked((texts, state) => { if (hasText(texts, /^UPDATE discovery_lease SET expires_at=/) && ++state.renews === 1) offset = 61000; });
  const run = await post('group-execute', {confirmation: group.confirmation}, flaky);
  offset = 0;
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'not_attempted', 'not_attempted'], JSON.stringify(run.body));
  assert.equal(run.body.outcomes[1].reason, 'budget_exhausted');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// Expiry: before the run it refuses; between keys the keys not yet started are expired.
{
  const group = await stage();
  offset = 11 * 60000;
  const late = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual([late.status, late.body.refusal], [409, 'confirmation_expired']);
  offset = 0;
  assert.deepEqual(states(group), ['approved', 'approved', 'approved'], 'nothing was written');
  // Near the end of the 10-minute issuance (9.5 minutes old at the start), the clock passes it after the first key but inside the run budget.
  offset = 9.5 * 60000;
  const flaky = hooked((texts, state) => { if (hasText(texts, /^UPDATE discovery_lease SET expires_at=/) && ++state.renews === 1) offset = 10.05 * 60000; });
  const run = await post('group-execute', {confirmation: group.confirmation}, flaky);
  offset = 0;
  assert.deepEqual(run.body.outcomes.map(o => o.outcome), ['applied', 'expired', 'expired'], JSON.stringify(run.body));
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// A competing live writer: the run refuses before anything is written.
{
  const group = await stage();
  db.sql("UPDATE discovery_lease SET lease_id='someone', expires_at=" + (Date.now() + 60000) + ", programme_run_id='" + RUN + "' WHERE id=1");
  const held = await post('group-execute', {confirmation: group.confirmation});
  assert.deepEqual([held.status, held.body.refusal], [409, 'lease_held']);
  assert.deepEqual(states(group), ['approved', 'approved', 'approved']);
  db.sql('UPDATE discovery_lease SET expires_at=0 WHERE id=1');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}
// Stale pins and torn evidence: nothing is issued.
{
  await reset();
  const view = await preview();
  await setDecision(order[0], {...dec(order[0]), attempts: 9});
  const stale = await post('group-confirm', confirmBody(order, {pin: view.body.pin}));
  assert.deepEqual([stale.status, stale.body.refusal], [409, 'stale_pin'], 'a decision that changed after the preview makes the pin stale');
  const fresh = await preview();
  db.sql("UPDATE discovery_decision SET decision_hash='" + '0'.repeat(64) + "' WHERE observation_key='" + order[1] + "'");
  const torn = await preview();
  assert.deepEqual(torn.body.rows.find(r => r.key === order[1]).reasons, ['proof_torn'], 'a hash that does not match its payload is not trusted');
  const refused = await post('group-confirm', confirmBody(order, {pin: torn.body.pin}));
  assert.equal(refused.body.refusal, 'group_selection_changed');
  assert.equal(intents().length, 0);
  assert.ok(fresh.body.pin !== torn.body.pin);
}

// Atomic issuance: all N children or none, never a partial group.
{
  await reset();
  const view = await preview();
  const dead = hooked(texts => { if (hasText(texts, /^INSERT INTO discovery_intent/)) throw new Error('D1_ERROR: connection lost'); });
  const lost = await post('group-confirm', confirmBody(order, {pin: view.body.pin}), dead);
  assert.deepEqual([lost.status, lost.body.refusal], [503, 'storage_unavailable'], 'a failed issuance batch is a truthful storage failure');
  assert.equal(intents().length, 0, 'none of the children exists');
  const taken = gid();
  db.sql("INSERT INTO discovery_intent (idempotency_key, kind, state, observation_key) VALUES ('" + G.groupChildKey(taken, 2) + "', 'identity_assign', 'approved', 'другой|2001')");
  const clash = await post('group-confirm', confirmBody(order, {pin: view.body.pin, idempotencyKey: taken}));
  assert.deepEqual([clash.status, clash.body.refusal], [409, 'idempotency_conflict']);
  assert.equal(db.sql("SELECT COUNT(*) AS n FROM discovery_intent WHERE idempotency_key LIKE '" + taken + "-%'")[0].n, 1, 'only the pre-existing child is there: the other children were not inserted');
  db.sql("DELETE FROM discovery_intent WHERE idempotency_key LIKE 'group-%'");
}

console.log('discovery-identity-group ok');
