// Confirmed apply of a previewed Letterboxd archive. Synthetic archives only. The preview writes nothing; confirm stores
// the issued confirmation and not the ZIP; commit writes facts only after that confirmation; a later observation survives rollback.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';
import {exportArchive} from './fixtures/letterboxd-archive.mjs';

const NOW = Date.parse('2026-10-31T09:00:00.000Z'), D = 86400000;
const ORIGIN = 'https://iptv.test', G1 = '11111111-1111-4111-8111-111111111111', G2 = '22222222-2222-4222-8222-222222222222';
const NAME = 'letterboxd-demo-user-2026-10-20-08-15-utc.zip', GENERATED = '2026-10-20T08:15:00.000Z';
const ACCESS = 'owner-session-assertion';
const records = new Map();
let calls = [], version = 0;
const bucket = {
  async get(key) {
    calls.push('get:' + key);
    const entry = records.get(key);
    if (!entry) return null;
    return {etag: entry.etag, uploaded: new Date(NOW - D), body: new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode(entry.text)); c.close();}}), json: async () => JSON.parse(entry.text), text: async () => entry.text};
  },
  async put(key, value, options = {}) {
    calls.push('put:' + key);
    const current = records.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const etag = 'e' + (++version);
    records.set(key, {text: typeof value === 'string' ? value : new TextDecoder().decode(value), etag});
    return {etag};
  },
  async list() {throw new Error('apply never lists');},
  async delete() {throw new Error('apply never deletes');},
};
const put = (key, value) => records.set(key, {text: JSON.stringify(value), etag: 'e' + (++version)});
const read = key => records.has(key) ? JSON.parse(records.get(key).text) : undefined;
const env = {BUCKET: bucket};
const {context, worker, facts: Facts, resetCache} = loadArchiveWorker({now: NOW, console: {log() {}, warn() {}, error() {}, info() {}, debug() {}}, fetch: async () => {throw new Error('no outbound request');}});
const execution = {waitUntil() {throw new Error('no background work');}};
const film = (id, title, year, tmdbId) => ({id, tmdbId, title, original: title, titleRu: title, titleStatus: 'verified', year, directors: [], actors: [], shows: []});

async function encode(init) {
  const request = new Request('https://encode.test/', init);
  const body = new Uint8Array(await request.arrayBuffer());
  return {type: request.headers.get('content-type'), body};
}
async function send(path, {form, json, access = ACCESS, origin = ORIGIN, method = 'POST'} = {}) {
  const init = form ? {method: 'POST', body: form} : json ? {method: 'POST', body: JSON.stringify(json), headers: {'Content-Type': 'application/json'}} : {method};
  const encoded = method === 'GET' ? {type: null, body: null} : await encode(init);
  const headers = {...(encoded.type ? {'Content-Type': encoded.type} : {}), ...(encoded.body ? {'Content-Length': String(encoded.body.length)} : {}), ...(origin ? {Origin: origin} : {}), ...(access ? {'Cf-Access-Jwt-Assertion': access, 'X-IPTV-Admin-Action': 'letterboxd_archive_apply'} : {})};
  const response = await worker.fetch(new Request(ORIGIN + path, {method, headers, body: encoded.body}), env, execution);
  return {status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control')};
}
function archiveOf(films) {return exportArchive(films);}
async function preview(bytes) {
  const form = new FormData();
  form.append('archive', new File([bytes], NAME, {type: 'application/zip'}));
  return send('/api/admin/letterboxd-archive/preview', {form, access: null});
}
function batchOf(answer, chunk = 0) {return answer.batches.chunks.find(item => item.chunk === chunk);}
async function confirm(bytes, answer, chunk, key) {
  const batch = batchOf(answer, chunk);
  const form = new FormData();
  form.append('archive', new File([bytes], NAME, {type: 'application/zip'}));
  form.append('chunk', String(chunk));
  form.append('planHash', batch.planHash);
  form.append('programmeRunId', answer.batches.programmeRunId);
  form.append('scopeFingerprint', batch.scopeFingerprint);
  form.append('idempotencyKey', key);
  form.append('accepted', 'true');
  return send('/api/admin/letterboxd-archive/apply-confirm', {form});
}
async function commit(bytes, confirmation) {
  const form = new FormData();
  form.append('archive', new File([bytes], NAME, {type: 'application/zip'}));
  form.append('confirmation', JSON.stringify(confirmation));
  return send('/api/admin/letterboxd-archive/apply', {form});
}

function seed() {
  records.clear(); calls = []; version = 0; resetCache();
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - D).toISOString()});
  put('titles.json', {}); put('people.json', {});
  put('metadata.json', {});
  put(Facts.FACTS_KEYS.links, {'letterboxd:clash': 'lb-clash', 'tmdb:9010': 'tmdb-other'});
}
async function observation(factKey, fact, value, observedAt, source) {
  return Facts.observation({factKey, fact, value, observedAt, source, sourceRef: 'seed'});
}

// 1. A rating with no diary row is its own fact. Confirm stores no archive. Commit writes that rating and the view.
{
  seed();
  const programme = [
    film('rateonly', 'Rated Only', 2014, 9001), film('keep', 'Kept Film', 2015, 9002), film('newer', 'Newer Film', 2016, 9003),
    film('clash', 'Clash', 2018, 9010), film('twin-a', 'Twin Title', 1999, 9011), film('twin-b', 'Twin Title', 1999, 9012),
  ];
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: programme, people: {directors: [], actors: []}, stats: {}});
  const keepKey = 'tmdb-9002', newerKey = 'tmdb-9003';
  const links = read(Facts.FACTS_KEYS.links);
  links['letterboxd:keep'] = keepKey; links['tmdb:9002'] = keepKey; links['letterboxd:newer'] = newerKey; links['tmdb:9003'] = newerKey;
  put(Facts.FACTS_KEYS.links, links);
  put(Facts.recordKey(keepKey), {...Facts.emptyRecord(keepKey, {letterboxd: 'keep', tmdb: '9002'}), watched: await observation(keepKey, 'watched', true, '2026-10-25T00:00:00.000Z', 'owner'), rating: await observation(keepKey, 'rating', 3, '2026-10-25T00:00:00.000Z', 'owner')});
  put(Facts.recordKey(newerKey), {...Facts.emptyRecord(newerKey, {letterboxd: 'newer', tmdb: '9003'}), watched: await observation(newerKey, 'watched', true, '2026-10-25T00:00:00.000Z', 'letterboxd_films_list'), rating: await observation(newerKey, 'rating', 5, '2026-10-25T00:00:00.000Z', 'letterboxd_films_list')});
  const films = [
    {code: 'rateonly', name: 'Rated Only', year: 2014, rating: 4},
    {code: 'keep', name: 'Kept Film', year: 2015, watched: true, rating: 3},
    {code: 'newer', name: 'Newer Film', year: 2016, watched: true, rating: 2},
    {code: 'clash', name: 'Clash', year: 2018, watched: true, rating: 4},
    {code: 'twin', name: 'Twin Title', year: 1999, watched: true, rating: 5},
  ];
  const bytes = archiveOf(films);
  calls = [];
  const seen = await preview(bytes);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.writes, false);
  assert.equal(seen.body.export.sets.ratedNotWatched, 1, 'the rating-only film has no watched row and no diary row');
  const adds = seen.body.details.adds.rows.filter(row => row.code === 'rateonly');
  assert.equal(adds.length, 1);
  assert.equal(adds[0].facts.rating, 4);
  assert.equal(adds[0].outcomes.rating, 'new');
  assert.equal(seen.body.details.identity.rows.some(row => row.code === 'twin'), true, 'an ambiguous title stays held');
  assert.equal(seen.body.details.conflicts.rows.some(row => row.code === 'clash'), true);
  assert.equal(seen.body.batches.chunks.length, 1);
  assert.equal(seen.body.batches.chunks[0].films, 3, 'only the three compared films can be approved');
  assert.equal(seen.body.batches.chunks[0].confirmable, true);
  assert.equal(calls.some(call => call.startsWith('put:')), false, 'preview writes nothing');

  calls = [];
  const issued = await confirm(bytes, seen.body, 0, 'apply-key-00000001');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.mode, 'apply_confirm');
  assert.equal(issued.body.writes, false);
  assert.equal(issued.cache, 'no-store');
  const actionKey = 'admin/actions/letterboxd_archive_apply/v1/apply-key-00000001.json';
  const action = read(actionKey);
  assert.equal(action.kind, 'letterboxd_archive_apply');
  assert.equal(action.state, 'approved');
  assert.equal(JSON.stringify(action).includes('Rated Only'), false);
  assert.equal(JSON.stringify(action).includes('"rating"'), false);
  assert.equal(JSON.stringify(action).includes(ACCESS), false);
  assert.equal(JSON.stringify(action).includes('watched.csv'), false);
  assert.equal(read(Facts.recordKey('tmdb-9001')), undefined, 'confirm does not write the fact');
  const puts = calls.filter(call => call.startsWith('put:'));
  assert.deepEqual(puts, ['put:' + actionKey]);

  const again = await confirm(bytes, seen.body, 0, 'apply-key-00000001');
  assert.equal(again.status, 200);
  assert.equal(again.body.writes, false);
  assert.deepEqual(again.body.confirmation, issued.body.confirmation);

  const written = await commit(bytes, issued.body.confirmation);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.mode, 'apply');
  assert.equal(written.body.writes, true);
  const byId = Object.fromEntries(written.body.receipt.outcomes.map(item => [item.id, item.outcome]));
  assert.equal(byId.rateonly, 'written');
  assert.equal(byId.keep, 'skipped_changed');
  assert.equal(byId.newer, 'skipped_changed');
  const created = read(Facts.recordKey('tmdb-9001'));
  assert.equal(created.rating.value, 4);
  assert.equal(created.watched.value, true);
  assert.equal(created.rating.source, 'letterboxd_export');
  assert.equal(read(Facts.FACTS_KEYS.viewIndex).rateonly.actualRating, 4);
  assert.equal(read(Facts.FACTS_KEYS.viewIndex).tmdb_9001.actualRating, 4);
  assert.equal(read(Facts.recordKey(newerKey)).rating.value, 5, 'a newer stored rating is kept');
  assert.equal(read(Facts.recordKey(keepKey)).rating.value, 3, 'an already current rating is kept');
  assert.equal(read(Facts.recordKey('lb-clash')), undefined, 'an alias conflict is not written');
  assert.equal(read(Facts.recordKey('tmdb-9011')), undefined, 'an ambiguous film is not written');

  const replay = await commit(bytes, issued.body.confirmation);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.writes, false);
  assert.equal(read(Facts.recordKey('tmdb-9001')).rating.value, 4);

  calls = [];
  const fresh = await preview(bytes);
  const second = await confirm(bytes, fresh.body, 0, 'apply-key-00000002');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const repeated = await commit(bytes, second.body.confirmation);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.receipt.outcomes.every(item => item.outcome === 'already_applied'), true);
  assert.equal(read(Facts.recordKey('tmdb-9001')).rating.value, 4);

  const later = await Facts.recordObservations(env, 'tmdb-9001', {letterboxd: 'rateonly', tmdb: '9001'}, [{fact: 'rating', observation: await observation('tmdb-9001', 'rating', 5, '2026-10-30T00:00:00.000Z', 'owner')}]);
  await Facts.projectRecords(env, [later.record]);
  assert.equal(read(Facts.recordKey('tmdb-9001')).rating.value, 5);
  const rollbackKey = 'rollback-key-000001';
  const rollbackIssued = await send('/api/admin/letterboxd-archive/rollback-confirm', {json: {archiveSha256: seen.body.archive.sha256, chunk: 0, idempotencyKey: rollbackKey, accepted: true}});
  assert.equal(rollbackIssued.status, 200, JSON.stringify(rollbackIssued.body));
  assert.equal(rollbackIssued.body.writes, false);
  const rolled = await send('/api/admin/letterboxd-archive/rollback', {json: {confirmation: rollbackIssued.body.confirmation}});
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.equal(read(Facts.recordKey('tmdb-9001')).rating.value, 5, 'a later observation survives rollback');
  assert.equal(read(Facts.FACTS_KEYS.viewIndex).rateonly.actualRating, 5);
  assert.equal(rolled.body.rollback.superseded > 0, true);
}

// 2. A tampered archive, a moved generation and a changed fact never reach the commit.
{
  seed();
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: [film('rateonly', 'Rated Only', 2014, 9001)], people: {directors: [], actors: []}, stats: {}});
  const bytes = archiveOf([{code: 'rateonly', name: 'Rated Only', year: 2014, rating: 4}]);
  const seen = await preview(bytes);
  const issued = await confirm(bytes, seen.body, 0, 'apply-key-tamper0001');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const other = archiveOf([{code: 'rateonly', name: 'Rated Only', year: 2014, rating: 1}]);
  const tampered = await commit(other, issued.body.confirmation);
  assert.equal(tampered.status, 409);
  assert.equal(tampered.body.refusal, 'confirmation_mismatch');
  assert.equal(read(Facts.recordKey('tmdb-9001')), undefined);

  resetCache();
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G2, publishedAt: new Date(NOW).toISOString()});
  const moved = await commit(bytes, issued.body.confirmation);
  assert.equal(moved.status, 409);
  assert.equal(moved.body.refusal, 'stale_pin');
  assert.equal(read(Facts.recordKey('tmdb-9001')), undefined);
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - D).toISOString()});
  resetCache();

  const changed = await confirm(bytes, seen.body, 0, 'apply-key-changed001');
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  put(Facts.recordKey('tmdb-9001'), {...Facts.emptyRecord('tmdb-9001', {letterboxd: 'rateonly', tmdb: '9001'}), rating: await observation('tmdb-9001', 'rating', 1, '2026-10-30T00:00:00.000Z', 'owner'), watched: await observation('tmdb-9001', 'watched', true, '2026-10-30T00:00:00.000Z', 'owner')});
  const links = read(Facts.FACTS_KEYS.links);
  links['letterboxd:rateonly'] = 'tmdb-9001'; links['tmdb:9001'] = 'tmdb-9001';
  put(Facts.FACTS_KEYS.links, links);
  const refused = await commit(bytes, changed.body.confirmation);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.refusal, 'record_changed');
  assert.equal(read(Facts.recordKey('tmdb-9001')).rating.value, 1, 'the newer fact is not overwritten');
}

// 3. The same idempotency key cannot approve a different chunk, and an interrupted plan conflicts instead of overwriting.
{
  seed();
  const many = Array.from({length: 51}, (_, index) => film('f' + index.toString(36), 'Synthetic ' + index, 2000 + (index % 20), 10000 + index));
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: many, people: {directors: [], actors: []}, stats: {}});
  const exported = many.map(item => ({code: item.id, name: item.title, year: item.year, rating: 3}));
  const bytes = archiveOf(exported);
  const seen = await preview(bytes);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.batches.chunks.length, 2);
  assert.equal(seen.body.batches.chunks[0].films, 50);
  assert.equal(seen.body.batches.chunks[1].films, 1);
  const first = await confirm(bytes, seen.body, 0, 'apply-key-chunk00001');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const clash = await confirm(bytes, seen.body, 1, 'apply-key-chunk00001');
  assert.equal(clash.status, 409);
  assert.equal(clash.body.refusal, 'idempotency_conflict');
  const wrote = await commit(bytes, first.body.confirmation);
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  const ordered = [...many].sort((a, b) => a.id < b.id ? -1 : 1);
  assert.equal(read(Facts.recordKey('tmdb-' + ordered[50].tmdbId)), undefined, 'the next chunk is not written with the first');
  assert.ok(read(Facts.recordKey('tmdb-' + ordered[0].tmdbId)), 'a film in the approved chunk is written');
  const second = await confirm(bytes, seen.body, 1, 'apply-key-chunk00002');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const rest = await commit(bytes, second.body.confirmation);
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(read(Facts.recordKey('tmdb-' + ordered[50].tmdbId)).rating.value, 3);

  const lone = archiveOf([{code: 'rateonly', name: 'Rated Only', year: 2014, rating: 4}]);
  seed();
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: [film('rateonly', 'Rated Only', 2014, 9001)], people: {directors: [], actors: []}, stats: {}});
  const opened = await preview(lone);
  const held = await confirm(lone, opened.body, 0, 'apply-key-conflict01');
  put('letterboxd/imports/' + opened.body.archive.sha256 + '/chunks/0.receipt.json', {schemaVersion: 1, itemsHash: 'ab'.repeat(32), archiveSha256: opened.body.archive.sha256, chunk: 0, origin: {archiveSha256: opened.body.archive.sha256, generatedAt: GENERATED, generatedAtSource: 'archive_name'}});
  const blocked = await commit(lone, held.body.confirmation);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.refusal, 'idempotency_conflict');
  assert.equal(read(Facts.recordKey('tmdb-9001')), undefined);
}

// 4. Refusals that must not read or write facts.
{
  seed();
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: [film('rateonly', 'Rated Only', 2014, 9001)], people: {directors: [], actors: []}, stats: {}});
  const bytes = archiveOf([{code: 'rateonly', name: 'Rated Only', year: 2014, rating: 4}]);
  calls = [];
  const denied = await send('/api/admin/letterboxd-archive/apply-confirm', {form: new FormData(), access: null});
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'access_denied');
  assert.deepEqual(calls, []);
  const empty = await send('/api/admin/letterboxd-archive/apply', {form: new FormData(), access: ''});
  assert.equal(empty.status, 403);
  const huge = await send('/api/admin/letterboxd-archive/rollback', {json: {confirmation: {}}, access: 'x'.repeat(9000)});
  assert.equal(huge.status, 403);
  calls = [];
  const half = {BUCKET: {async get() {calls.push('get'); throw new Error('should not read');}}};
  const unbound = await worker.fetch(new Request(ORIGIN + '/api/admin/letterboxd-archive/apply-confirm', {method: 'POST', headers: {Origin: ORIGIN, 'Cf-Access-Jwt-Assertion': ACCESS, 'X-IPTV-Admin-Action': 'letterboxd_archive_apply', 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': '0'}}), half, execution);
  assert.equal(unbound.status, 503);
  assert.deepEqual(await unbound.json(), {error: 'storage_unavailable'});
  assert.deepEqual(calls, [], 'a bucket without put is refused before the archive is read');
  const absent = await worker.fetch(new Request(ORIGIN + '/api/admin/letterboxd-archive/apply', {method: 'POST', headers: {Origin: ORIGIN, 'Cf-Access-Jwt-Assertion': ACCESS, 'X-IPTV-Admin-Action': 'letterboxd_archive_apply'}}), {}, execution);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error, 'Storage unavailable');
  calls = [];
  const form = new FormData();
  form.append('archive', new File([Buffer.from('not a zip')], NAME, {type: 'application/zip'}));
  const broken = await send('/api/admin/letterboxd-archive/apply-confirm', {form});
  assert.equal(broken.status, 422);
  assert.equal(broken.body.error, 'archive_invalid');
  assert.equal(calls.some(call => call.startsWith('get:') || call.startsWith('put:')), false);
  const missing = await send('/api/admin/letterboxd-archive/rollback-confirm', {json: {archiveSha256: 'ab'.repeat(32), chunk: 0, idempotencyKey: 'rollback-key-missing1', accepted: true}});
  assert.equal(missing.status, 409);
  assert.equal(missing.body.refusal, 'not_eligible');
}

console.log('admin-letterboxd-apply: ok');
