// GET /api/admin/posters: the owner's poster coverage read. It counts both catalog copies with the same rule as the maintenance
// route's dry run, returns the next bounded batch of the actionable queue after a cursor, a sample of remembered terminal
// answers, the records without a verified TMDB identity, and the data health verdict of the catalog summary. It reads the
// pointer, both catalog copies and the negative index, never the lease, never calls TMDB and never writes.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const records = new Map(), etags = new Map(), raw = new Map();
let reads = [], fetches = [], failGet = null;
const bucket = {
  async get(key) {
    reads.push(key);
    if (failGet && failGet(key)) throw new Error('R2 unavailable');
    if (raw.has(key)) {const text = raw.get(key); return {etag: etags.get(key), uploaded: new Date('2026-10-30T07:00:00.000Z'), json: async () => JSON.parse(text), text: async () => text};}
    if (!records.has(key)) return null;
    const text = JSON.stringify(records.get(key));
    return {etag: etags.get(key), uploaded: new Date('2026-10-30T07:00:00.000Z'), json: async () => JSON.parse(text), text: async () => text};
  },
  async put() {throw new Error('the poster read never writes');},
  async delete() {throw new Error('the poster read never deletes');},
  async list() {throw new Error('the poster read never lists');},
};
const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, atob, btoa, crypto: webcrypto, console, setTimeout, structuredClone,
  ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [],
  fetch: async input => {fetches.push(String(input instanceof Request ? input.url : input)); throw new Error('no outbound request');}});
for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/sources.js', 'src/discovery.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), context);
vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), context);
vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), context);
vm.runInContext(fs.readFileSync('src/admin/posters.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), context);

const G1 = '11111111-1111-4111-8111-111111111111';
const POINTER = 'epg/published-generation.json', LIVE = 'epg/discovered-films.json', COPY = 'epg/generations/' + G1 + '/discovered-films.json', LEASE = 'epg/resolver-lease.json', NEG = 'epg/catalog-poster-negatives.json';
const POSTER = 'https://image.tmdb.org/t/p/w342/kept.jpg';
const film = (id, tmdbId, extra = {}) => ({id, tmdbId: String(tmdbId), canonicalIdentity: 'tmdb:' + tmdbId, title: 'Фильм ' + id, original: 'Film ' + id, year: 2001, poster: null, ...extra});
function seed(catalog, copy = catalog) {
  records.clear(); etags.clear(); raw.clear(); reads = []; fetches = []; failGet = null;
  records.set(POINTER, {phase: 'published', programmeRunId: G1, publishedAt: '2026-10-30T06:00:00.000Z'}); etags.set(POINTER, 'p1');
  records.set(LIVE, structuredClone(catalog)); etags.set(LIVE, 'live-1');
  if (copy) {records.set(COPY, structuredClone(copy)); etags.set(COPY, 'copy-1');}
  records.set(LEASE, {owner: 'someone', expiresAt: Date.now() + 60000}); etags.set(LEASE, 'lease-1');
}
const base = {
  a1: film('a1', 1), a2: film('a2', 2, {poster: POSTER}), a3: film('a3', 3), a4: film('a4', 4, {canonicalIdentity: null}),
  a5: film('a5', 5), a6: film('a6', 6, {tmdbId: null, canonicalIdentity: null}), a7: film('a7', 7, {poster: 'http://insecure.example/x.jpg'}),
};
const env = {BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'test'};
const get = async (query = '', init = {}) => {
  const response = await context.worker.fetch(new Request('https://iptv.example/api/admin/posters' + query, init), env, {waitUntil() {throw new Error('background work');}});
  return {status: response.status, body: await response.json()};
};
const post = async body => {
  const response = await context.worker.fetch(new Request('https://iptv.example/api/enrichment/catalog/posters', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}), env, {waitUntil() {}});
  return {status: response.status, body: await response.json()};
};

// 1. The counts agree with the maintenance route's dry run, over both copies, and nothing but the four objects is read.
seed(base);
let r = await get();
assert.equal(r.status, 200);
assert.deepEqual([...new Set(reads)].sort(), [LIVE, COPY, NEG, POINTER].sort(), 'pointer, both catalog copies and the negative index: no lease, no ledger');
assert.deepEqual(fetches, [], 'no TMDB request');
const dry = await post({});
for (const field of ['programmeRunId', 'catalogRecords', 'missingPoster', 'verifiedMissing', 'unverifiedMissing', 'actionable', 'noPosterHeld', 'identityReview']) assert.equal(r.body[field], dry.body[field], field);
assert.deepEqual([r.body.actionable, r.body.noPosterHeld, r.body.identityReview], [4, 0, 0], 'an absent index is an empty one');
assert.deepEqual(r.body.held, {noPoster: {count: 0, sample: []}, identityReview: {count: 0, sample: []}});
assert.deepEqual([r.body.catalogRecords, r.body.withPoster, r.body.missingPoster, r.body.verifiedMissing, r.body.unverifiedMissing], [7, 1, 6, 4, 2]);
assert.deepEqual(r.body.queue.items.map(item => item.id), Array.from(dry.body.ids), 'the batch is the head of the route queue');
assert.deepEqual(r.body.queue.items[0], {id: 'a1', tmdbId: '1', title: 'Фильм a1', original: 'Film a1', year: 2001});
assert.deepEqual([r.body.queue.cursor, r.body.queue.limit, r.body.queue.remainingAfterCursor, r.body.queue.total], [null, 10, 4, 4]);
assert.deepEqual(r.body.limits, {batch: 10, route: 20});
assert.deepEqual(r.body.evidence, {complete: true, problems: []});
assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.key, copy.present, copy.records, copy.missingPoster, copy.version]), [['generation', COPY, true, 7, 6, 'copy-1'], ['live', LIVE, true, 7, 6, 'live-1']]);
assert.deepEqual(r.body.unverified, {count: 2, sample: [{id: 'a4', title: 'Фильм a4', year: 2001, reason: 'identity_not_tmdb'}, {id: 'a6', title: 'Фильм a6', year: 2001, reason: 'tmdb_id_missing'}]});
assert.equal(r.body.health.issue.id, 'poster/missing_asset/catalog:published');
assert.deepEqual([r.body.health.issue.severity, r.body.health.issue.action.code, r.body.health.issue.action.eligible, r.body.health.posterBacklogCount], ['info', 'poster_hydration', true, 20]);
assert.equal(records.get(LIVE).a1.poster, null, 'nothing written');

// 2. Cursor and limit select the batch the next POST with the same cursor and limit would process.
r = await get('?cursor=a1&limit=2');
assert.deepEqual(r.body.queue.items.map(item => item.id), ['a3', 'a5']);
assert.deepEqual([r.body.queue.cursor, r.body.queue.limit, r.body.queue.remainingAfterCursor], ['a1', 2, 3]);
r = await get('?cursor=');
assert.equal(r.body.queue.cursor, null, 'an empty cursor is the start of the queue');
r = await get('?cursor=zz');
assert.deepEqual([r.body.queue.items.length, r.body.queue.remainingAfterCursor, r.body.verifiedMissing], [0, 0, 4], 'past the end the queue is empty, the counts are not');

// 3. A record missing its poster in only one copy counts once, as in the route.
seed(base, {...base, a2: film('a2', 2)});
r = await get();
assert.deepEqual([r.body.missingPoster, r.body.verifiedMissing], [7, 5]);
assert.deepEqual(r.body.copies.map(copy => copy.missingPoster), [7, 6]);

// 4. Validation happens before any read.
for (const query of ['?limit=0', '?limit=11', '?limit=x', '?limit=01', '?limit=', '?limit=20']) {seed(base); r = await get(query); assert.deepEqual([r.status, r.body.error], [400, 'invalid_limit'], query); assert.deepEqual(reads, [], query);}
seed(base); r = await get('?cursor=' + 'x'.repeat(201)); assert.deepEqual([r.status, r.body.error], [400, 'invalid_cursor']); assert.deepEqual(reads, []);
for (const method of ['POST', 'PUT', 'DELETE']) {seed(base); r = await get('', {method, ...(method === 'DELETE' ? {} : {body: '{}', headers: {'Content-Type': 'application/json'}})}); assert.deepEqual([r.status, r.body.error], [405, 'method_not_allowed'], method); assert.deepEqual(reads, [], method);}

// 5. The backlog escalates by the count of restorable records only.
const many = {}; for (let index = 0; index < 25; index++) many['m' + String(index).padStart(2, '0')] = film('m' + String(index).padStart(2, '0'), 100 + index);
seed(many);
r = await get();
assert.deepEqual([r.body.health.issue.severity, r.body.health.issue.threshold], ['warning', {code: 'posterBacklogCount', value: 20, unit: 'records'}]);
assert.equal(r.body.queue.items.length, 10, 'the default batch is the maximum, 10');
const unverifiedOnly = {}; for (let index = 0; index < 30; index++) unverifiedOnly['u' + index] = film('u' + index, 200 + index, {canonicalIdentity: 'title:u' + index});
seed(unverifiedOnly);
r = await get();
assert.deepEqual([r.body.health.issue.severity, r.body.health.issue.action.reason, r.body.queue.items.length, r.body.unverified.count, r.body.unverified.sample.length], ['info', 'identity_unverified', 0, 30, 10]);
seed({a2: film('a2', 2, {poster: POSTER})});
r = await get();
assert.deepEqual([r.body.missingPoster, r.body.health.issue], [0, null], 'a full catalog has no poster issue');

// 6–7. Unknown is never zero: a pointer that names no published generation, or a missing or unreadable catalog copy, makes
// every count and the batch unknown, the health verdict incomplete, and keeps the per-copy diagnostics. The read writes nothing,
// creates no copy and fixes nothing.
const unknown = (body, problems, label) => {
  assert.equal(r.status, 200, label);
  assert.deepEqual(body.evidence, {complete: false, problems}, label);
  assert.deepEqual([body.catalogRecords, body.withPoster, body.missingPoster, body.verifiedMissing, body.unverifiedMissing, body.actionable, body.noPosterHeld, body.identityReview], [null, null, null, null, null, null, null, null], label + ': no count is reported as zero');
  assert.deepEqual([body.queue.items, body.queue.remainingAfterCursor, body.queue.total], [[], null, null], label + ': no batch is offered');
  assert.deepEqual(body.held, {noPoster: {count: null, sample: []}, identityReview: {count: null, sample: []}}, label);
  assert.deepEqual(body.unverified, {count: null, sample: []}, label);
  assert.deepEqual([body.health.issue.category, body.health.issue.reason, body.health.issue.action.code], ['incomplete', 'progress_unknown', 'supply_evidence'], label);
  assert.deepEqual(fetches, [], label + ': no TMDB request');
};
const keysBefore = () => JSON.stringify([[...records.entries()].sort(), [...raw.entries()].sort()]);
let before;
// 6a. No published generation: the generation copy cannot even be named; the live copy is still read and described.
seed(base, null); records.set(POINTER, {phase: 'publishing', programmeRunId: G1}); before = keysBefore();
r = await get();
unknown(r.body, ['generation_not_published'], 'unpublished');
assert.equal(r.body.programmeRunId, null);
assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.present, copy.readable, copy.records, copy.missingPoster]), [['live', true, true, 7, 6]]);
assert.deepEqual([...new Set(reads)].sort(), [LIVE, NEG, POINTER].sort());
assert.equal(keysBefore(), before);
// 6b. No pointer at all.
seed(base, null); records.delete(POINTER); before = keysBefore();
r = await get();
unknown(r.body, ['pointer_missing'], 'pointer missing');
assert.equal(keysBefore(), before, 'the read does not create the pointer');
// 6c. A pointer that does not parse.
seed(base); records.delete(POINTER); raw.set(POINTER, '{"phase": "published", '); etags.set(POINTER, 'p-bad');
r = await get();
unknown(r.body, ['pointer_unreadable'], 'pointer malformed');
// 7a. The live copy is missing: the generation copy is still described, the counts are not.
seed(base); records.delete(LIVE); before = keysBefore();
r = await get();
unknown(r.body, ['live_copy_missing'], 'live missing');
assert.equal(r.body.programmeRunId, G1);
assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.present, copy.readable, copy.records, copy.missingPoster, copy.version]), [['generation', true, true, 7, 6, 'copy-1'], ['live', false, false, null, null, null]]);
assert.equal(keysBefore(), before, 'the read does not create the live copy');
// 7b. The generation copy is missing.
seed(base, null); before = keysBefore();
r = await get();
unknown(r.body, ['generation_copy_missing'], 'generation copy missing');
assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.present, copy.readable, copy.records]), [['generation', false, false, null], ['live', true, true, 7]]);
assert.equal(records.has(COPY), false, 'the read does not create the generation copy');
assert.equal(keysBefore(), before);
// 7c. The generation copy does not parse, or parses to something that is not a catalog.
for (const [label, setup] of [['truncated JSON', () => {records.delete(COPY); raw.set(COPY, '{"a1": {"id": "a1"');}], ['an array', () => records.set(COPY, ['not', 'a', 'catalog'])], ['null', () => {records.delete(COPY); raw.set(COPY, 'null');}]]) {
  seed(base); setup(); before = keysBefore();
  r = await get();
  unknown(r.body, ['generation_copy_unreadable'], 'generation copy ' + label);
  assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.present, copy.readable, copy.records, copy.version]), [['generation', true, false, null, 'copy-1'], ['live', true, true, 7, 'live-1']], label);
  assert.equal(keysBefore(), before, label + ': the read does not repair the copy');
}
// 7d. A malformed live copy and a missing generation copy are both named.
seed(base, null); records.delete(LIVE); raw.set(LIVE, 'oops');
r = await get();
unknown(r.body, ['generation_copy_missing', 'live_copy_unreadable'], 'two problems');
// 7e. A failing storage call is a 503, not a partial answer.
seed(base); failGet = key => key === COPY;
r = await get();
assert.deepEqual([r.status, r.body.error], [503, 'storage_unavailable']);

// 8. Titles are bounded text; a non-string title is null, never markup the page has to trust.
seed({a1: film('a1', 1, {title: 'x'.repeat(500), year: '2001', original: {html: '<b>'}})});
r = await get();
assert.deepEqual([r.body.queue.items[0].title.length, r.body.queue.items[0].year, r.body.queue.items[0].original], [200, null, null]);

// 9. Remembered answers leave the actionable batch and stay visible. The health backlog still counts every verified record without a poster.
seed(base);
records.set(NEG, {schemaVersion: 1, entries: {
  '1': {status: 'no_poster_on_tmdb', checkedAt: '2026-10-01T00:00:00.000Z', nextCheckAt: '2099-01-01T00:00:00.000Z'},
  '5': {status: 'tmdb_id_mismatch', checkedAt: '2026-10-02T00:00:00.000Z'},
}});
etags.set(NEG, 'neg-1');
r = await get();
assert.deepEqual(r.body.queue.items.map(item => item.id), ['a3', 'a7']);
assert.deepEqual([r.body.queue.total, r.body.actionable, r.body.noPosterHeld, r.body.identityReview, r.body.verifiedMissing], [2, 2, 1, 1, 4]);
assert.deepEqual(r.body.held.noPoster, {count: 1, sample: [{id: 'a1', tmdbId: '1', title: 'Фильм a1', original: 'Film a1', year: 2001, checkedAt: '2026-10-01T00:00:00.000Z', nextCheckAt: '2099-01-01T00:00:00.000Z'}]});
assert.deepEqual(r.body.held.identityReview.sample.map(item => [item.id, item.tmdbId, item.checkedAt, item.nextCheckAt]), [['a5', '5', '2026-10-02T00:00:00.000Z', null]]);
assert.equal(r.body.health.issue.reason, 'posters_missing', 'held records still count toward the poster summary');
const heldMany = {};
for (let index = 0; index < 25; index++) heldMany['m' + String(index).padStart(2, '0')] = film('m' + String(index).padStart(2, '0'), 100 + index);
const heldEntries = {};
for (let index = 0; index < 25; index++) heldEntries[String(100 + index)] = {status: 'no_poster_on_tmdb', checkedAt: '2026-10-01T00:00:00.000Z', nextCheckAt: '2099-01-01T00:00:00.000Z'};
seed(heldMany);
records.set(NEG, {schemaVersion: 1, entries: heldEntries}); etags.set(NEG, 'neg-many');
r = await get();
assert.deepEqual([r.body.actionable, r.body.noPosterHeld, r.body.queue.total, r.body.held.noPoster.sample.length, r.body.health.issue.severity], [0, 25, 0, 10, 'warning']);
// An unreadable index makes the queue unknown, not empty and not ready.
seed(base);
records.set(NEG, {schemaVersion: 1, entries: {nope: 1}}); etags.set(NEG, 'bad');
before = keysBefore(); fetches = [];
r = await get();
unknown(r.body, ['negatives_unreadable'], 'negatives unreadable');
assert.equal(r.body.programmeRunId, G1);
assert.deepEqual(fetches, []);
assert.equal(keysBefore(), before, 'an unreadable index is not repaired');

console.log('Admin posters API: dry-run parity over both copies, cursor and limit, validation before reads, backlog threshold, unverified sample, unknown-not-zero for an unpublished or missing pointer and a missing or malformed copy, remembered answers held out of the batch, an unreadable index that is not an empty queue, and failing reads passed');
