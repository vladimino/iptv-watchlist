// AIR-527 (ADR 0170): GET /api/admin/identity-work over a fake R2 and a fake D1. Covers the first import into an empty registry,
// unindexed archives, registry orphans, registry_stale, oversized and unreadable documents, a truncated listing, admission proof by
// archive AND short code, per-archive paging with one candidate document per request, stale_cursor / stale_pin, lane order with the Limbo
// lanes, and the read-only boundary: no put, no delete, one delimiter list, only SELECT statements, no outbound request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {scoped} from '../scripts/bundle-scope.mjs';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';

const SOURCE = fs.readFileSync('src/admin/identity-work.js', 'utf8');
assert.doesNotMatch(SOURCE.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\.put\(|\.delete\(|\bfetch\(|waitUntil|identityStep|retryCandidates|registerCandidates|rollbackCandidates|\.prepare\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|TMDB|letterboxd\.com|\bzip\b|Zip/, 'the route never writes, fetches or starts a step');
assert.match(fs.readFileSync('src/worker.js', 'utf8'), /url\.pathname==='\/api\/admin\/identity-work'\)return await adminIdentityWorkRoute\(request,env,url\)/);
const build = fs.readFileSync('build.mjs', 'utf8');
assert.match(build, /scoped\('src\/domain\/letterboxd-import-registry\.js','LetterboxdImportRegistry'\)/);
assert.match(build, /scoped\('src\/domain\/identity-work-inventory\.js','IdentityWorkInventory'\)/);
assert.ok(build.indexOf('src/admin/limbo.js') < build.indexOf('src/admin/identity-work.js') && build.indexOf('src/admin/identity-work.js') < build.lastIndexOf('src/worker.js'), 'the route follows the limbo module and precedes the Worker entry');
assert.ok(build.indexOf('letterboxd-import-registry.js') < build.indexOf('src/letterboxd-rated-candidates.js'), 'the registry scope precedes the candidate writers that call it');

const NOW = Date.parse('2026-11-18T12:00:00.000Z'), DAY = 86400000;
const SHA = {A: 'a'.repeat(64), B: 'b'.repeat(64), C: 'c'.repeat(64), D: 'd'.repeat(64)};
const REGISTRY = 'letterboxd/imports/registry.json';
const docKey = sha => 'letterboxd/imports/' + sha + '/rated-candidates.json';
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

// ---- fake R2 ----
const records = new Map();
const tally = {gets: [], heads: [], lists: [], puts: 0, deletes: 0, fetches: 0, sql: []};
let version = 0, listLimitSeen = null;
const bucket = {
  async get(key) {
    tally.gets.push(key);
    const entry = records.get(key);
    if (!entry) return null;
    return {etag: entry.etag, size: entry.size ?? entry.text.length, body: {cancel: async () => {}}, text: async () => entry.text, json: async () => JSON.parse(entry.text)};
  },
  async head(key) {tally.heads.push(key); const entry = records.get(key); return entry ? {etag: entry.etag, size: entry.size ?? entry.text.length} : null;},
  async list(options) {
    tally.lists.push(options); listLimitSeen = options.limit;
    const prefixes = new Set();
    for (const key of records.keys()) if (key.startsWith(options.prefix)) {const rest = key.slice(options.prefix.length), slash = rest.indexOf('/'); if (slash > 0) prefixes.add(options.prefix + rest.slice(0, slash + 1));}
    const all = [...prefixes].sort();
    return {objects: [], delimitedPrefixes: all.slice(0, options.limit), truncated: all.length > options.limit};
  },
  async put() {tally.puts++; throw new Error('a GET never writes');},
  async delete() {tally.deletes++; throw new Error('a GET never deletes');},
};
const seed = (key, value, extra = {}) => records.set(key, {text: typeof value === 'string' ? value : JSON.stringify(value), etag: 'e' + (++version), ...extra});
const admissionsTable = [];
const DB = {rows: async (sql, params) => {tally.sql.push(sql); return admissionsTable.filter(row => row.archive_sha256 === params[0]);}};
const env = {BUCKET: bucket, DB};

const {context} = loadArchiveWorker({now: NOW, console: {log() {}, warn() {}, error() {}}, fetch: async () => {tally.fetches++; throw new Error('no outbound request');}});
let limboMode = 'unavailable', limboItems = [], limboPinValue = 'L:1', limboItemsFn = null;
context.__stub = {
  load: async () => {if (limboMode === 'unavailable') return {error: 'programme_unavailable'}; if (limboMode === 'throws') throw new Error('boom'); return {tuple: {n: 1}, observations: {state: 'fresh'}};},
  items: now => (limboItemsFn ? limboItemsFn(now) : limboItems), pin: () => limboPinValue,
};
vm.runInContext(`
var adminLimboLoad = (env, hasPin) => __stub.load(env, hasPin);
var limboEvaluate = (snapshot, nowMs) => ({now: nowMs, scope: {coverage: {films: 'partial'}, subjects: {films: [1, 2], observations: [1]}}});
var limboIndexReadable = index => ['fresh', 'stale'].includes(index?.state);
var limboEncodePin = () => __stub.pin();
var limboObservationCoverage = () => ({available: true, state: 'fresh', complete: false});
var LimboInventory = {limboItems: health => __stub.items(health.now)};
var FilmPersonAuthority = {database: env => env.DB, many: (db, sql, params) => db.rows(sql, params)};
`, context);
vm.runInContext(scoped('src/domain/identity-work-inventory.js', 'IdentityWorkInventory'), context);
vm.runInContext(SOURCE, context);
const Candidates = vm.runInContext('LetterboxdRatedCandidates', context);

async function get(query = '', method = 'GET') {
  const url = 'https://iptv.test/api/admin/identity-work' + query;
  const response = await context.adminIdentityWorkRoute(new Request(url, {method}), env, new URL(url));
  return {status: response.status, body: await response.json()};
}
const lbc = (query = '') => get('?type=letterboxd_rated_candidate' + query);
const candidate = (code, state, extra = {}) => ({code, state, reason: null, name: 'Film ' + code, year: 2001, rating: 4, chunk: 0, observedAt: iso(10), registeredAt: iso(9), ...extra});
const doc = (sha, list, stopped = null) => ({schemaVersion: 1, archiveSha256: sha, generatedAt: iso(11), candidates: Object.fromEntries(list.map(entry => [entry.code, entry])), checkpoint: {cursor: null, stopped}});
const registryRow = (sha, pending, etag, registeredAt = iso(9)) => ({registeredAt, generatedAt: iso(11), counts: {pending, admitting: 0, needs_review: 0, verified: 0, removed: 0}, documentEtag: etag, summarizedAt: iso(1)});
const putRegistry = archives => seed(REGISTRY, {schemaVersion: 1, updatedAt: iso(1), archives});
const reset = () => {records.clear(); admissionsTable.length = 0; Object.assign(tally, {gets: [], heads: [], lists: [], puts: 0, deletes: 0, fetches: 0, sql: []}); limboMode = 'unavailable'; limboItems = [];};
const docReads = () => tally.gets.filter(key => key.endsWith('/rated-candidates.json'));

// ---- validation, method ----
reset();
assert.equal((await get('', 'POST')).status, 405);
for (const [query, error] of [['?type=tv', 'unknown_type'], ['?disposition=done', 'unknown_disposition'], ['?include=all', 'unknown_include'], ['?archive=xyz', 'invalid_archive'], ['?limit=26', 'invalid_limit'], ['?q=', 'invalid_query'], ['?pin=nope', 'invalid_pin'], ['?cursor=garbage', 'stale_cursor']]) {
  const result = await get(query);
  assert.deepEqual([query, result.status, result.body.error], [query, 400, error]);
}
assert.equal(tally.gets.length + tally.lists.length, 0, 'a refused query reads nothing');

// ---- an empty bucket: enumeration is complete, the estimate is zero, and nothing says "no work" ----
{
  const result = await lbc();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, []);
  const lane = result.body.coverage.letterboxd_rated_candidate;
  assert.equal(lane.enumeration.state, 'complete');
  assert.equal(lane.counts.basis, 'registry_estimate'); assert.equal(lane.counts.state, 'absent'); assert.equal(lane.counts.byStatus.pending, 0);
  assert.equal(lane.snapshot, 'per_archive');
  assert.doesNotMatch(JSON.stringify(result.body), /"full"|no_work|"empty"/, 'the candidate lane is never called full or empty');
  assert.equal(listLimitSeen, 1000);
  assert.deepEqual({...tally.lists[0]}, {prefix: 'letterboxd/imports/', delimiter: '/', limit: 1000});
  assert.equal(result.body.coverage.film, undefined, 'a lane that was not asked for has no coverage entry');
}

// ---- the first new import into an empty registry (through the real writer hook), then a read ----
reset();
await Candidates.registerCandidates({BUCKET: {...bucket, put: async (key, value, options) => {const current = records.get(key); if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null; if (options?.onlyIf?.etagDoesNotMatch === '*' && current) return null; const etag = 'w' + (++version); records.set(key, {text: value, etag}); return {etag};}}}, {sha: SHA.A, generatedAt: iso(11), chunk: 0, rows: [{code: 'Aa1', disposition: 'pending', reason: null, rating: 4, name: 'First', year: 2020}]});
{
  tally.gets.length = 0;
  const result = await lbc();
  assert.equal(result.status, 200);
  const lane = result.body.coverage.letterboxd_rated_candidate;
  assert.deepEqual(result.body.rows.map(row => row.key), ['lbc:' + SHA.A + ':Aa1']);
  assert.deepEqual([lane.enumeration.state, lane.enumeration.registered, lane.enumeration.listed, lane.enumeration.unindexed], ['complete', 1, 1, 0]);
  assert.deepEqual([lane.page.state, lane.page.indexed, lane.page.archiveSha256, lane.counts.byStatus.pending, lane.counts.state], ['read_whole', true, SHA.A, 1, 'estimate']);
  assert.equal(lane.page.documentEtag, records.get(docKey(SHA.A)).etag);
  assert.equal(result.body.nextCursor, null);
  assert.equal(docReads().length, 1);
}

// ---- unindexed archive, registry orphan, stale registry, oversized, unreadable ----
reset();
putRegistry({[SHA.A]: registryRow(SHA.A, 1, null)});
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending')]));
records.get(REGISTRY).text = JSON.stringify({schemaVersion: 1, updatedAt: iso(1), archives: {[SHA.A]: registryRow(SHA.A, 1, records.get(docKey(SHA.A)).etag)}});
seed(docKey(SHA.B), doc(SHA.B, [candidate('Bb2', 'pending')]));
{
  const result = await lbc();
  const lane = result.body.coverage.letterboxd_rated_candidate;
  assert.deepEqual([lane.enumeration.state, lane.enumeration.reason, lane.enumeration.unindexed, lane.enumeration.unindexedArchives], ['partial', 'unindexed_archives', 1, [SHA.B]]);
  assert.deepEqual(result.body.rows.map(row => row.key), ['lbc:' + SHA.A + ':Aa1'], 'registered archives come first');
  assert.equal(JSON.parse(JSON.stringify(result.body.nextCursor !== null)), true, 'the unindexed archive follows on the next page');
  const second = await lbc('&cursor=' + encodeURIComponent(result.body.nextCursor));
  assert.deepEqual(second.body.rows.map(row => row.key), ['lbc:' + SHA.B + ':Bb2']);
  assert.deepEqual([second.body.coverage.letterboxd_rated_candidate.page.indexed, second.body.coverage.letterboxd_rated_candidate.page.state], [false, 'read_whole'], 'an unindexed archive is read and labelled, never shown as an empty queue');
  assert.equal(second.body.nextCursor, null);
}
// a registry row whose prefix is gone
reset();
putRegistry({[SHA.A]: registryRow(SHA.A, 1, 'x'), [SHA.C]: registryRow(SHA.C, 4, 'y')});
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending')]));
{
  const lane = (await lbc()).body.coverage.letterboxd_rated_candidate;
  assert.deepEqual([lane.enumeration.state, lane.enumeration.reason, lane.enumeration.registryOrphans, lane.enumeration.orphanArchives], ['partial', 'registry_orphans', 1, [SHA.C]]);
  assert.equal(lane.counts.byStatus.pending, 5, 'orphan counts stay in the estimate and are shown');
}
// stale registry: the document moved after the registry row was written
reset();
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending')]));
putRegistry({[SHA.A]: registryRow(SHA.A, 1, 'older-etag')});
{
  const result = await lbc();
  const page = result.body.coverage.letterboxd_rated_candidate.page;
  assert.deepEqual([page.state, page.reason], ['registry_stale', 'document_etag_differs']);
  assert.equal(result.body.rows.length, 1, 'the rows are the document\'s own, the estimate is what is stale');
}
// oversized: the body is never fetched; unreadable: no rows invented
reset();
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending')]), {size: 2 * 1024 * 1024 + 1});
seed(docKey(SHA.B), '{"broken":');
putRegistry({[SHA.A]: registryRow(SHA.A, 9, 'x', iso(5)), [SHA.B]: registryRow(SHA.B, 2, 'y', iso(4))});
{
  const first = await lbc();
  assert.deepEqual([first.body.coverage.letterboxd_rated_candidate.page.state, first.body.rows.length], ['oversized', 0]);
  assert.equal(docReads().length, 0, 'an oversized document is judged by head and never read');
  const second = await lbc('&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.deepEqual([second.body.coverage.letterboxd_rated_candidate.page.state, second.body.rows.length, second.body.nextCursor], ['unreadable', 0, null]);
  assert.equal(second.body.coverage.letterboxd_rated_candidate.counts.byStatus.pending, 11, 'the estimate still counts them');
}
// a document for another archive is unreadable
reset();
seed(docKey(SHA.A), doc(SHA.B, [candidate('Aa1', 'pending')]));
assert.equal((await lbc()).body.coverage.letterboxd_rated_candidate.page.state, 'unreadable');
// a truncated listing is partial and judges no orphan
reset();
for (let i = 0; i < 1001; i++) seed('letterboxd/imports/' + i.toString(16).padStart(64, '0') + '/chunks/0.receipt.json', '{}');
{
  const lane = (await lbc()).body.coverage.letterboxd_rated_candidate;
  assert.deepEqual([lane.enumeration.state, lane.enumeration.reason, lane.enumeration.listed, lane.enumeration.registryOrphans], ['partial', 'listing_truncated', 1000, null]);
}
// registry states other than a good registry
for (const [name, text, expected] of [['unreadable', '{nope', 'registry_unreadable'], ['invalid', JSON.stringify({schemaVersion: 7}), 'registry_invalid'], ['oversized', 'x', 'registry_oversized']]) {
  reset();
  seed(REGISTRY, text, name === 'oversized' ? {size: 256 * 1024 + 1} : {});
  seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending')]));
  const result = await lbc();
  const lane = result.body.coverage.letterboxd_rated_candidate;
  assert.deepEqual([lane.enumeration.state, lane.enumeration.reason, lane.counts.state, lane.counts.byStatus], ['partial', expected, name, null]);
  assert.deepEqual(result.body.rows.map(row => row.key), ['lbc:' + SHA.A + ':Aa1'], 'archives are still paged from the listing');
}

// ---- admission proof: archive AND code AND typed movie id ----
reset();
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'verified'), candidate('Bb2', 'verified'), candidate('Cc3', 'verified'), candidate('Dd4', 'pending')]));
putRegistry({[SHA.A]: registryRow(SHA.A, 1, records.get(docKey(SHA.A)).etag)});
admissionsTable.push({film_id: 'tmdb_603', tmdb: '603', source_code: 'Aa1', archive_sha256: SHA.A}, {film_id: 'tmdb_700', tmdb: '700', source_code: 'Bb2', archive_sha256: SHA.B});
{
  const unresolved = await lbc();
  assert.deepEqual(unresolved.body.rows.map(row => [row.shortCode, row.disposition, row.reason]), [['Bb2', 'needs_owner_review', 'admission_unconfirmed'], ['Cc3', 'needs_owner_review', 'admission_unconfirmed'], ['Dd4', 'waiting', null]], 'resolved rows are excluded; another archive\'s admission for Bb2 confirms nothing');
  const all = await lbc('&include=resolved');
  const aa1 = all.body.rows.find(row => row.shortCode === 'Aa1');
  assert.deepEqual([aa1.disposition, aa1.film], ['resolved', {filmId: 'tmdb_603', proof: 'film_rated_admission'}]);
  assert.equal(all.body.rows.find(row => row.shortCode === 'Bb2').film, null);
  assert.equal(all.body.coverage.letterboxd_rated_candidate.page.admissions, 'read');
  assert.equal(tally.sql.length, 2); assert.ok(tally.sql.every(sql => /^SELECT /.test(sql)), 'one bounded SELECT per request');
  assert.match(tally.sql[0], /LIMIT 5001$/);
  assert.ok(!tally.gets.includes('letterboxd/admissions/verified-films.json'), 'the historical receipt is never read, so it can never confirm');
  // D1 unreadable: not confirmed, not called unconfirmed
  const saved = DB.rows; DB.rows = async () => {throw new Error('d1 down');};
  const down = await lbc('&include=resolved');
  DB.rows = saved;
  assert.deepEqual([down.body.coverage.letterboxd_rated_candidate.page.admissions, down.body.rows.find(row => row.shortCode === 'Aa1').disposition, down.body.rows.find(row => row.shortCode === 'Aa1').film], ['unavailable', 'waiting', null]);
}

// ---- paging: one candidate document per request, stale_cursor, stale_pin ----
reset();
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending'), candidate('Bb2', 'pending'), candidate('Cc3', 'pending')]));
seed(docKey(SHA.B), doc(SHA.B, [candidate('Dd4', 'pending')]));
putRegistry({[SHA.A]: registryRow(SHA.A, 3, records.get(docKey(SHA.A)).etag, iso(9)), [SHA.B]: registryRow(SHA.B, 1, records.get(docKey(SHA.B)).etag, iso(8))});
{
  tally.gets.length = 0;
  const one = await lbc('&limit=2');
  assert.deepEqual(one.body.rows.map(row => row.shortCode), ['Aa1', 'Bb2']);
  assert.equal(docReads().length, 1);
  const two = await lbc('&limit=2&cursor=' + encodeURIComponent(one.body.nextCursor));
  assert.deepEqual(two.body.rows.map(row => row.shortCode), ['Cc3'], 'a short page: the next archive is not read in the same request');
  assert.equal(docReads().length, 2, 'one document per request');
  const three = await lbc('&limit=2&cursor=' + encodeURIComponent(two.body.nextCursor));
  assert.deepEqual(three.body.rows.map(row => row.key), ['lbc:' + SHA.B + ':Dd4']);
  assert.equal(three.body.nextCursor, null);
  assert.equal(three.body.pin, one.body.pin);
  // a cursor of another filter or limit is refused
  assert.equal((await lbc('&limit=3&cursor=' + encodeURIComponent(one.body.nextCursor))).body.error, 'stale_cursor');
  assert.equal((await get('?type=film&limit=2&cursor=' + encodeURIComponent(one.body.nextCursor))).body.error, 'stale_cursor');
  // the page archive changed between pages: stale_cursor (400)
  seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending'), candidate('Bb2', 'pending'), candidate('Cc3', 'pending'), candidate('Zz9', 'pending')]));
  const changed = await lbc('&limit=2&cursor=' + encodeURIComponent(one.body.nextCursor));
  assert.deepEqual([changed.status, changed.body.error], [400, 'stale_cursor']);
  // the registry moved: stale_pin (409), for a cursor and for a pin parameter
  putRegistry({[SHA.A]: registryRow(SHA.A, 4, records.get(docKey(SHA.A)).etag, iso(9)), [SHA.B]: registryRow(SHA.B, 1, records.get(docKey(SHA.B)).etag, iso(8))});
  const moved = await lbc('&limit=2&cursor=' + encodeURIComponent(two.body.nextCursor));
  assert.deepEqual([moved.status, moved.body.error], [409, 'stale_pin']);
  assert.equal((await lbc('&pin=' + encodeURIComponent(one.body.pin))).status, 409);
  const fresh = await lbc('&limit=2');
  assert.equal((await lbc('&pin=' + encodeURIComponent(fresh.body.pin))).status, 200);
  // the archive filter restricts the candidate lane and still reports global enumeration
  const only = await lbc('&archive=' + SHA.B);
  assert.deepEqual(only.body.rows.map(row => row.key), ['lbc:' + SHA.B + ':Dd4']);
  assert.equal(only.body.coverage.letterboxd_rated_candidate.enumeration.registered, 2);
  assert.equal(only.body.coverage.letterboxd_rated_candidate.selected, SHA.B);
  assert.equal((await lbc('&archive=' + SHA.D)).body.coverage.letterboxd_rated_candidate.page.state, 'absent');
}

// ---- stopped checkpoint, filters by disposition and q ----
reset();
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending'), candidate('Bb2', 'needs_review', {reason: 'tmdb_fetch_failed'})], {code: 'tmdb_unavailable'}));
{
  const all = await lbc();
  assert.deepEqual(all.body.rows.map(row => [row.shortCode, row.disposition]), [['Aa1', 'blocked'], ['Bb2', 'needs_owner_review']].map(pair => pair));
  assert.deepEqual((await lbc('&disposition=blocked')).body.rows.map(row => row.shortCode), ['Aa1']);
  assert.deepEqual((await lbc('&q=bb2')).body.rows.map(row => row.shortCode), ['Bb2']);
}

// ---- the Limbo lanes: lane order, one list, coverage, and a candidate lane that survives an unavailable Limbo ----
reset();
const issue = (id, cause, ageMs) => ({kind: 'film', subjectId: id, subsystem: 'metadata', cause, reason: 'r', film: {id, title: 'T ' + id, year: 2000}, age: {ms: ageMs, lastProgressAt: iso(2)}, evidence: {observedAt: iso(0)}});
const obs = (key, cause, ageMs) => ({kind: 'observation', subjectId: key, subsystem: 'identity', cause, reason: 'z', observation: {title: 'Obs ' + key, year: 1999}, age: {ms: ageMs}, evidence: {}});
seed(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending'), candidate('Bb2', 'pending')]));
putRegistry({[SHA.A]: registryRow(SHA.A, 2, records.get(docKey(SHA.A)).etag)});
limboMode = 'ok';
limboItems = [issue('tmdb_1', 'stalled', 3 * DAY), issue('tmdb_2', 'pending', 8 * DAY), obs('k1', 'manual_review', 1 * DAY), obs('k2', 'backoff', 6 * DAY)];
{
  const one = await get('?limit=3');
  assert.deepEqual(one.body.rows.map(row => row.key), ['film:tmdb_2', 'film:tmdb_1', 'epg:k2'], 'film lane by age, then the next lane; no cross-lane age sort');
  assert.equal(one.body.coverage.film.state, 'partial'); assert.equal(one.body.coverage.epg_observation.state, 'partial');
  const two = await get('?limit=3&cursor=' + encodeURIComponent(one.body.nextCursor));
  assert.deepEqual(two.body.rows.map(row => row.key), ['epg:k1', 'lbc:' + SHA.A + ':Aa1', 'lbc:' + SHA.A + ':Bb2']);
  assert.equal(two.body.nextCursor, null);
  assert.deepEqual(two.body.rows.map(row => row.type), ['epg_observation', 'letterboxd_rated_candidate', 'letterboxd_rated_candidate']);
  // a page filled exactly by the memory lanes hands over to the candidate lane without reading it
  tally.gets.length = 0;
  const exact = await get('?limit=4');
  assert.deepEqual(exact.body.rows.map(row => row.type), ['film', 'film', 'epg_observation', 'epg_observation']);
  assert.equal(docReads().length, 0); assert.notEqual(exact.body.nextCursor, null);
  assert.equal((await get('?limit=4&cursor=' + encodeURIComponent(exact.body.nextCursor))).body.rows.length, 2);
  // hints only between rows of one response
  limboItems = [obs('k9', 'pending', DAY)];
  limboItems[0].observation = {title: 'Film Aa1', year: 2001};
  const hinted = await get('?limit=5');
  const epgRow = hinted.body.rows.find(row => row.key === 'epg:k9');
  assert.deepEqual(epgRow.observedHints.map(hint => [hint.kind, hint.trusted, hint.ref]), [['title_year_match', false, 'lbc:' + SHA.A + ':Aa1']]);
  assert.equal(epgRow.film, null);
  const narrow = await get('?limit=1');
  assert.deepEqual(narrow.body.rows[0].observedHints, [], 'the candidate is on another page: not observed, so no hint');
  // an unavailable Limbo leaves the candidate lane readable and says so, never "none"
  limboMode = 'unavailable';
  const down = await get('?limit=5');
  assert.deepEqual(down.body.rows.map(row => row.type), ['letterboxd_rated_candidate', 'letterboxd_rated_candidate']);
  assert.deepEqual([down.body.coverage.film.state, down.body.coverage.film.reason, down.body.coverage.epg_observation.state], ['unavailable', 'programme_unavailable', 'unavailable']);
  limboMode = 'throws';
  assert.equal((await get('?limit=5')).body.coverage.film.state, 'unavailable');
  // a pin that names a Limbo tuple that moved
  limboMode = 'ok'; limboPinValue = 'L:1';
  const pinned = await get('?limit=2');
  limboPinValue = 'L:2';
  assert.equal((await get('?limit=2&pin=' + encodeURIComponent(pinned.body.pin))).status, 409);
  assert.equal((await get('?limit=2&cursor=' + encodeURIComponent(pinned.body.nextCursor))).status, 409);
  limboPinValue = 'L:1';
  // a film-only request never lists or reads the candidate store
  limboItems = [issue('tmdb_1', 'stalled', 3 * DAY), issue('tmdb_2', 'pending', 8 * DAY)];
  tally.lists.length = 0; tally.gets.length = 0; tally.heads.length = 0;
  const filmOnly = await get('?type=film');
  assert.equal(filmOnly.status, 200); assert.deepEqual(filmOnly.body.rows.map(row => row.type), ['film', 'film']);
  assert.equal(tally.lists.length + tally.gets.length + tally.heads.length, 0);
  assert.equal(filmOnly.body.coverage.letterboxd_rated_candidate, undefined);
}

// ---- the evaluation clock is pinned in the cursor: a threshold crossed between pages changes nothing ----
{
  reset();
  limboMode = 'ok';
  const THRESHOLD = NOW + 60 * 60 * 1000;
  const film = (id, now) => issue(id, now < THRESHOLD ? 'pending' : 'stalled', 4 * DAY);
  limboItemsFn = now => ['tmdb_1', 'tmdb_2', 'tmdb_3'].map(id => film(id, now));
  const realNow = context.Date.now;
  context.Date.now = () => NOW;
  const one = await get('?type=film&disposition=waiting&limit=2');
  assert.deepEqual(one.body.rows.map(row => [row.key, row.disposition]), [['film:tmdb_1', 'waiting'], ['film:tmdb_2', 'waiting']]);
  assert.equal(one.body.snapshot.evaluatedAt, new Date(NOW).toISOString());
  context.Date.now = () => THRESHOLD + 5 * 60 * 1000;
  const two = await get('?type=film&disposition=waiting&limit=2&cursor=' + encodeURIComponent(one.body.nextCursor));
  assert.equal(two.status, 200, 'the threshold was crossed, the source versions did not move: the cursor stays valid');
  assert.deepEqual(two.body.rows.map(row => [row.key, row.disposition]), [['film:tmdb_3', 'waiting']], 'the same evaluation as the first page');
  assert.equal(two.body.snapshot.evaluatedAt, new Date(NOW).toISOString(), 'the first page\'s clock is reported');
  const fresh = await get('?type=film&disposition=waiting&limit=2');
  assert.deepEqual(fresh.body.rows, [], 'a new first request evaluates at the new time: the films are blocked now');
  assert.equal(fresh.body.snapshot.evaluatedAt, new Date(THRESHOLD + 5 * 60 * 1000).toISOString());
  context.Date.now = realNow; limboItemsFn = null;
}

// ---- ADR 0222: at marker `d1` the candidate documents are D1 Ratings documents: the archive list and the document come from D1 (the seam is tested in letterboxd-admission-documents.mjs), R2 is not read, the registry projection is frozen ----
{
  reset();
  const d1Docs = new Map();
  let route = 'd1';
  const stub = {
    MANIFEST_KEY: 'letterboxd/imports/documents-manifest.json',
    documentRoute: async () => {if (route === 'closed') {const error = new Error('letterboxd_admission_closed'); error.code = 'letterboxd_admission_closed'; throw error;} if (route === 'unreadable') throw new Error('letterboxd_admission_unavailable'); return {d1: route === 'd1'};},
    readDocument: async (_env, key) => ({value: d1Docs.get(key) ?? null, etag: 'd1-etag'}),
    listCandidateArchives: async () => ({shas: [...d1Docs.keys()].filter(key => key.endsWith('/rated-candidates.json')).map(key => key.split('/')[2]).sort(), truncated: false}),
  };
  context.LetterboxdAdmissionDocuments = stub;
  seed(docKey(SHA.B), doc(SHA.B, [candidate('Bb1', 'pending')]));            // a stale R2 copy must NOT be read at d1
  d1Docs.set(docKey(SHA.A), doc(SHA.A, [candidate('Aa1', 'pending'), candidate('Aa2', 'needs_review', {reason: 'duplicate_tmdb'})]));
  tally.gets.length = 0; tally.heads.length = 0; tally.lists.length = 0;
  const result = await lbc();
  assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
  assert.deepEqual(result.body.rows.map(row => row.key).sort(), ['lbc:' + SHA.A + ':Aa1', 'lbc:' + SHA.A + ':Aa2'], 'the rows come from the D1 document');
  const lane = result.body.coverage.letterboxd_rated_candidate;
  assert.equal(lane.page.state, 'read_whole');assert.equal(lane.page.archiveSha256, SHA.A);assert.equal(lane.page.documentEtag, 'd1-etag');
  assert.deepEqual([tally.gets.length, tally.heads.length, tally.lists.length], [0, 0, 0], 'no R2 read, head or list at d1: no fallback and no registry projection');
  assert.equal(lane.counts.state, 'absent', 'the registry projection is frozen: it is not the estimate source at d1');
  // an unreadable marker: unavailable states, never the R2 copy
  route = 'unreadable'; tally.gets.length = 0;
  const unreadable = await lbc('&archive=' + SHA.B);
  assert.equal(unreadable.status, 200);
  assert.equal(unreadable.body.coverage.letterboxd_rated_candidate.page.state, 'unreadable');
  assert.deepEqual(unreadable.body.rows, []);
  assert.equal(docReads().length, 0, 'an unreadable marker never reads the R2 copy');
  // under `closed` the R2 objects are quiescent and still the record
  route = 'closed'; tally.gets.length = 0;
  const closed = await lbc('&archive=' + SHA.B);
  assert.deepEqual(closed.body.rows.map(row => row.key), ['lbc:' + SHA.B + ':Bb1'], 'closed: R2 is still the record');
  delete context.LetterboxdAdmissionDocuments;
  reset();
}

// ---- the read-only boundary over the whole file ----
assert.equal(tally.puts + tally.deletes + tally.fetches, 0, 'no write, no delete, no outbound request in any request above');
assert.ok(tally.lists.every(options => options.delimiter === '/' && options.limit === 1000), 'the only list is the bounded delimiter listing');
console.log('admin-identity-work-api: ok');
