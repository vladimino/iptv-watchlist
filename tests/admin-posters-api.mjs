// GET /api/admin/posters: the owner's poster coverage read. It counts both catalog copies with the same rule as the maintenance
// route's dry run, returns the next bounded batch after a cursor, the records without a verified TMDB identity, and the data
// health verdict of the catalog summary. It reads three objects, never the lease, never calls TMDB and never writes.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const records = new Map(), etags = new Map();
let reads = [], fetches = [], failGet = null;
const bucket = {
  async get(key) {
    reads.push(key);
    if (failGet && failGet(key)) throw new Error('R2 unavailable');
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
const POINTER = 'epg/published-generation.json', LIVE = 'epg/discovered-films.json', COPY = 'epg/generations/' + G1 + '/discovered-films.json', LEASE = 'epg/resolver-lease.json';
const POSTER = 'https://image.tmdb.org/t/p/w342/kept.jpg';
const film = (id, tmdbId, extra = {}) => ({id, tmdbId: String(tmdbId), canonicalIdentity: 'tmdb:' + tmdbId, title: 'Фильм ' + id, original: 'Film ' + id, year: 2001, poster: null, ...extra});
function seed(catalog, copy = catalog) {
  records.clear(); etags.clear(); reads = []; fetches = []; failGet = null;
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

// 1. The counts agree with the maintenance route's dry run, over both copies, and nothing but three objects is read.
seed(base);
let r = await get();
assert.equal(r.status, 200);
assert.deepEqual([...new Set(reads)].sort(), [LIVE, COPY, POINTER].sort(), 'pointer and both catalog copies only: no lease, no ledger');
assert.deepEqual(fetches, [], 'no TMDB request');
const dry = await post({});
for (const field of ['programmeRunId', 'catalogRecords', 'missingPoster', 'verifiedMissing', 'unverifiedMissing']) assert.equal(r.body[field], dry.body[field], field);
assert.deepEqual([r.body.catalogRecords, r.body.withPoster, r.body.missingPoster, r.body.verifiedMissing, r.body.unverifiedMissing], [7, 1, 6, 4, 2]);
assert.deepEqual(r.body.queue.items.map(item => item.id), Array.from(dry.body.ids), 'the batch is the head of the route queue');
assert.deepEqual(r.body.queue.items[0], {id: 'a1', tmdbId: '1', title: 'Фильм a1', original: 'Film a1', year: 2001});
assert.deepEqual([r.body.queue.cursor, r.body.queue.limit, r.body.queue.remainingAfterCursor, r.body.queue.total], [null, 10, 4, 4]);
assert.deepEqual(r.body.limits, {batch: 10, route: 20});
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

// 6. Without a published generation only the live catalog is counted, like the route.
seed(base, null); records.set(POINTER, {phase: 'publishing', programmeRunId: G1});
r = await get();
assert.equal(r.body.programmeRunId, null);
assert.deepEqual(r.body.copies.map(copy => copy.role), ['live']);
assert.deepEqual([...new Set(reads)].sort(), [LIVE, POINTER].sort());
assert.equal(r.body.verifiedMissing, (await post({})).body.verifiedMissing);

// 7. Missing and malformed objects are counted as absent, a failing read is a 503 with nothing written.
seed(base); records.delete(LIVE); records.set(COPY, ['not', 'a', 'catalog']);
r = await get();
assert.deepEqual([r.status, r.body.catalogRecords, r.body.health.issue], [200, 0, null]);
assert.deepEqual(r.body.copies.map(copy => [copy.role, copy.present, copy.readable]), [['generation', true, false], ['live', false, false]], 'a malformed copy is present but unreadable');
seed(base); failGet = key => key === COPY;
r = await get();
assert.deepEqual([r.status, r.body.error], [503, 'storage_unavailable']);

// 8. Titles are bounded text; a non-string title is null, never markup the page has to trust.
seed({a1: film('a1', 1, {title: 'x'.repeat(500), year: '2001', original: {html: '<b>'}})});
r = await get();
assert.deepEqual([r.body.queue.items[0].title.length, r.body.queue.items[0].year, r.body.queue.items[0].original], [200, null, null]);

console.log('Admin posters API: dry-run parity over both copies, cursor and limit, validation before reads, backlog threshold, unverified sample, no generation, absent and failing objects passed');
