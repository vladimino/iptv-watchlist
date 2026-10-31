// POST /api/admin/letterboxd-archive/preview on the Worker bundle over an R2 stand-in. The answer must equal what the
// baseline import's own validate route says for the same films, read only named keys with `get`, never write, list, fetch or
// log, and refuse every request outside the upload contract before it reads anything.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';
import {parseExport, EXPORT_FILES} from '../src/letterboxd-export.js';
import {buildIndex, matchExport} from '../src/letterboxd-match.js';
import {planItem} from '../scripts/letterboxd-baseline-import.mjs';
import {zipArchive, exportArchive, exportFiles} from './fixtures/letterboxd-archive.mjs';

const NOW = Date.parse('2026-10-31T09:00:00.000Z'), D = 86400000;
const ORIGIN = 'https://iptv.test', ROUTE = ORIGIN + '/api/admin/letterboxd-archive/preview';
const NAME = 'letterboxd-demo-user-2026-10-20-08-15-utc.zip', GENERATED = '2026-10-20T08:15:00.000Z';

// R2 stand-in: get-only unless a test opens it for the seeding commit. Every call is recorded.
const records = new Map();
let calls = [], writable = false, failing = new Set(), onGet = null, version = 0;
const bucket = {
  async get(key) {
    calls.push('get:' + key);
    if (failing.has(key)) throw new Error('R2 unavailable');
    if (onGet) onGet(key);
    const entry = records.get(key);
    if (!entry) return null;
    const {text, etag} = entry;
    return {etag, uploaded: new Date(NOW - D), body: new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode(text)); c.close();}}), json: async () => JSON.parse(text), text: async () => text};
  },
  async put(key, value, options = {}) {
    calls.push('put:' + key);
    if (!writable) throw new Error('the preview never writes');
    const current = records.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const etag = 'e' + (++version);
    records.set(key, {text: typeof value === 'string' ? value : JSON.stringify(value), etag});
    return {etag};
  },
  async delete(key) {calls.push('delete:' + key); if (!writable) throw new Error('the preview never deletes'); records.delete(key);},
  async list() {calls.push('list'); throw new Error('the preview never lists');},
  async head(key) {calls.push('head:' + key); throw new Error('the preview never heads');},
};
const put = (key, value) => records.set(key, {text: JSON.stringify(value), etag: 'e' + (++version)});
const env = {BUCKET: bucket};
const logged = [], fetches = [];
const recorder = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logged.push([level, ...args])]));
const {context, worker, facts: Facts} = loadArchiveWorker({now: NOW, console: recorder, fetch: async input => {fetches.push(String(input)); throw new Error('no outbound request');}});
const execution = {waitUntil() {throw new Error('no background work');}};

async function encode(form) {
  const request = new Request('https://encode.test/', {method: 'POST', body: form});
  return {type: request.headers.get('content-type'), body: new Uint8Array(await request.arrayBuffer())};
}
async function send({bytes, name = NAME, generatedAt, method = 'POST', origin = ORIGIN, headers = {}, form, length} = {}) {
  let body = null, type = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const data = form || new FormData();
    if (!form) {
      data.append('archive', new File([bytes], name, {type: 'application/zip'}));
      if (generatedAt !== undefined) data.append('generatedAt', generatedAt);
    }
    ({type, body} = await encode(data));
  }
  const all = {...(type ? {'Content-Type': type} : {}), ...(body ? {'Content-Length': String(length ?? body.length)} : {}), ...(origin ? {Origin: origin} : {}), ...headers};
  for (const [key, value] of Object.entries(all)) if (value === null) delete all[key];
  const response = await worker.fetch(new Request(ROUTE, {method, headers: all, body}), env, execution);
  return {status: response.status, headers: response.headers, body: await response.json()};
}

// The stored world: one published generation, metadata, a ratings generation, the link index, two scan summaries and records.
const G1 = '11111111-1111-4111-8111-111111111111';
const stored = (id, title, year, tmdbId, extra = {}) => ({id, tmdbId, title, original: title, titleRu: title, titleStatus: 'verified', year, directors: [], actors: [], shows: [], ...extra});
const programmeFilms = [
  stored('a1', 'Alpha', 2001, 101), stored('b2', 'Beta', 2002, 102), stored('c3', 'Gamma', 2003, 103), stored('d4', 'Delta', 2004, 104),
  stored('g7', 'Stored Title', 2007, 107), stored('zz1', 'Epsilon', 2005, 105), stored('om1', 'Omega', 2010, 110), stored('om2', 'Omega', 2010, 111),
  stored('h8', 'Eta', 2008, 108), stored('l1', 'Lambda', 2011, 112), stored('w1', 'Watch', 2012, 113), stored('m1', 'Mu', 2013, 114),
];
const exportFilms = [
  {code: 'a1', name: 'Alpha', year: 2001, watched: true, watchedDate: '2026-09-01', rating: 4, diary: [{date: '2026-09-01', rating: '4'}, {date: '2026-10-01', rating: '4'}]},
  {code: 'b2', name: 'Beta', year: 2002, watched: true, rating: 3.5},
  {code: 'c3', name: 'Gamma', year: 2003, watched: true, rating: 4},
  {code: 'd4', name: 'Delta', year: 2004, watched: true},
  {code: 'g7', name: 'Other Name', year: 2007, watched: true, rating: 2},
  {code: 'e5', name: 'Epsilon', year: 2005, watched: true},
  {code: 'o9', name: 'Omega', year: 2010, watched: true, rating: 3},
  {code: 'h8', name: 'Eta', year: 2008, rating: 5},
  {code: 'l1', name: 'Lambda', year: 2011, watched: true},
  {code: 'w1', name: 'Watch', year: 2012, watchlist: true},
  {code: 'm1', name: 'Mu', year: 2013, watched: true, rating: 1, watchlist: true},
  {code: 'u1', name: 'Nowhere', year: 1999, watched: true},
];
let observe;
async function seedWorld() {
  records.clear(); calls = []; failing = new Set(); onGet = null; writable = false;
  vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', context);
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - D).toISOString()});
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - D).toISOString(), films: programmeFilms, people: {directors: [], actors: []}, stats: {}});
  put('titles.json', {}); put('people.json', {});
  put('metadata.json', {m1: stored('m1', 'Mu', 2013, 114)});
  put('enrichment/ratings/published.json', {projected: true, generationId: 'gen-1'});
  put('enrichment/ratings/generations/gen-1.json', {ratings: {a1: 4, c3: 4.5}});
  observe = (factKey, fact, value, observedAt, source = 'letterboxd_films_list') => Facts.observation({factKey, fact, value, observedAt, source, sourceRef: 'scan-0'});
  put(Facts.FACTS_KEYS.links, {'letterboxd:b2': 'tmdb-102', 'tmdb:102': 'tmdb-102', 'letterboxd:c3': 'tmdb-103', 'tmdb:103': 'tmdb-103', 'letterboxd:l1': 'tmdb-900', 'tmdb:112': 'tmdb-112', 'letterboxd:m1': 'tmdb-114', 'tmdb:114': 'tmdb-114'});
  put(Facts.recordKey('tmdb-102'), {...Facts.emptyRecord('tmdb-102', {letterboxd: 'b2', tmdb: '102'}), watched: await observe('tmdb-102', 'watched', true, '2026-01-01T00:00:00.000Z'), rating: await observe('tmdb-102', 'rating', 3, '2026-01-01T00:00:00.000Z')});
  put(Facts.recordKey('tmdb-103'), {...Facts.emptyRecord('tmdb-103', {letterboxd: 'c3', tmdb: '103'}), watched: await observe('tmdb-103', 'watched', true, '2026-10-25T00:00:00.000Z'), rating: await observe('tmdb-103', 'rating', 4.5, '2026-10-25T00:00:00.000Z')});
  put(Facts.recordKey('tmdb-114'), {...Facts.emptyRecord('tmdb-114', {letterboxd: 'm1', tmdb: '114'}), migrating: {to: 'tmdb-115'}});
  put(Facts.FACTS_KEYS.filmsList, {observedAt: '2026-02-01T00:00:00.000Z', scanId: 'scan-1', films: {d4: null}});
  put(Facts.FACTS_KEYS.watchlist, {observedAt: '2026-10-28T00:00:00.000Z', scanId: 'scan-2', films: ['w1']});
}
const reads = () => calls.filter(call => call.startsWith('get:')).map(call => call.slice(4));
const nonGets = () => calls.filter(call => !call.startsWith('get:'));

// 1. The full answer on an ordinary export.
await seedWorld();
const files = exportFiles(exportFilms);
files['ratings.csv'] += '2026-01-02,Bad Row,2001,https://example.com/x,4\n';
const archive = zipArchive([{name: 'profile.csv', data: 'x\n'}, ...Object.entries(files).map(([name, data]) => ({name, data}))]);
const main = await send({bytes: archive});
assert.equal(main.status, 200, JSON.stringify(main.body));
assert.equal(main.headers.get('Cache-Control'), 'no-store');
const answer = main.body;
assert.equal(answer.mode, 'preview');
assert.equal(answer.writes, false);
assert.equal(answer.schemaVersion, 1);
assert.equal(answer.archive.sha256, webcryptoHex(await webcrypto.subtle.digest('SHA-256', archive)));
assert.equal(answer.archive.generatedAt, GENERATED);
assert.equal(answer.archive.generatedAtSource, 'archive_name');
assert.equal(answer.archive.nameStandard, true);
assert.equal(answer.archive.ageMs, NOW - Date.parse(GENERATED));
assert.equal(answer.archive.entries, 5);
assert.equal(answer.archive.ignoredEntries, 1);
assert.deepEqual(Object.keys(answer.archive.files), ['watched.csv', 'ratings.csv', 'watchlist.csv', 'diary.csv']);
assert.equal(answer.completeness.status, 'complete');
assert.equal(answer.export.films, 12);
assert.equal(answer.export.files.diary.records, 2, 'diary rewatches are counted, not imported');
assert.equal(answer.export.files.diary.auxiliary, true);
assert.equal(answer.export.sets.ratedNotWatched, 1);
assert.equal(answer.export.invalidRows, 1);
assert.deepEqual(answer.export.invalidByReason, {invalid_uri: 1});
assert.deepEqual(answer.baseline, {status: 'unknown', reason: 'no_bounded_summary', confirmedAt: null, sha256: null, thisArchive: {status: 'absent', committedAt: null}});
assert.deepEqual(answer.matching.byStatus, {accepted: 8, provisional: 0, candidate: 1, ambiguous: 1, conflict: 1, unmatched: 1});
assert.equal(answer.matching.acceptedByMethod.lid_exact, 8, 'without the catalog every code match is lid_exact');
assert.equal(answer.matching.status, 'complete');
assert.equal(answer.matching.sources.programme.evidence, 'observed');
assert.equal(answer.matching.sources.ratingsGeneration.evidence, 'observed');
assert.deepEqual(Object.keys(answer.matching.omitted), ['catalog', 'viewIndex']);
assert.equal(answer.proposal.films.accepted, 8);
assert.equal(answer.proposal.films.aliasConflict, 1, 'l1: its two aliases name different records');
assert.equal(answer.proposal.films.unverified, 1, 'm1: its record is migrating');
assert.equal(answer.proposal.films.compared, 6);
assert.equal(answer.proposal.status, 'partial');
assert.deepEqual(answer.proposal.reasons, ['records_not_read']);
const byCode = list => Object.fromEntries(list.rows.map(row => [row.code, row]));
const adds = byCode(answer.details.adds), updates = byCode(answer.details.updates), held = byCode(answer.details.heldNewer);
assert.deepEqual(Object.keys(adds).sort(), ['a1', 'd4', 'h8']);
assert.deepEqual(adds.a1.outcomes, {watched: 'new', rating: 'new'});
assert.deepEqual(adds.h8.facts, {watched: true, rating: 5}, 'a rated film is also watched');
assert.deepEqual(adds.d4.outcomes, {watched: 'new', rating: 'new'}, 'the films-list floor is older than the archive');
assert.deepEqual(adds.d4.current.rating, {value: null, observedAt: '2026-02-01T00:00:00.000Z', source: 'letterboxd_films_list'});
assert.deepEqual(Object.keys(updates), ['b2']);
assert.deepEqual(updates.b2.outcomes, {watched: 'replaces', rating: 'replaces'});
assert.equal(updates.b2.current.rating.value, 3);
assert.deepEqual(Object.keys(held).sort(), ['c3', 'w1']);
assert.deepEqual(held.c3.outcomes, {watched: 'older', rating: 'older'});
assert.deepEqual(held.w1.outcomes, {watchlist: 'older'});
assert.equal(answer.proposal.byFact.rating.older, 1);
assert.deepEqual(answer.freshness, {needsFreshArchive: true, reasons: ['ratings_newer_in_r2'], archiveStaleMs: 60 * D, ageMs: NOW - Date.parse(GENERATED), ratingsNewerInR2: 1});
assert.deepEqual(answer.details.conflicts.rows.map(row => [row.code, row.held]), [['l1', 'alias_conflict']]);
assert.deepEqual(answer.details.unverified.rows.map(row => [row.code, row.held]), [['m1', 'record_converging']]);
assert.deepEqual(answer.details.identity.rows.map(row => [row.code, row.status, row.reason]).sort(), [['e5', 'candidate', 'identity_unverified'], ['g7', 'conflict', 'stored_title_differs'], ['o9', 'ambiguous', 'multiple_targets'], ['u1', 'unmatched', 'no_stored_title']]);
assert.deepEqual(answer.details.invalidRows.rows, [{file: 'ratings.csv', record: 9, reason: 'invalid_uri'}]);
assert.equal(answer.consistency.status, 'stable');
assert.equal(answer.status, 'partial');
assert.deepEqual(answer.proposal.recordReads, {limit: 300, needed: 3, done: 3}, 'b2, c3 and m1 have a link alias; the others have no record yet');
// Reads: only named keys, the archive's own receipt keys, and records behind a link alias. Nothing else is touched.
const expectedKeys = new Set(['epg/published-generation.json', 'epg/generations/' + G1 + '/programme.json', 'titles.json', 'people.json', 'metadata.json', 'enrichment/ratings/published.json', 'enrichment/ratings/generations/gen-1.json', Facts.FACTS_KEYS.links, Facts.FACTS_KEYS.filmsList, Facts.FACTS_KEYS.watchlist, 'letterboxd/imports/' + answer.archive.sha256 + '/chunks/0.receipt.json', 'letterboxd/imports/' + answer.archive.sha256 + '/chunks/0.intent.json', Facts.recordKey('tmdb-102'), Facts.recordKey('tmdb-103'), Facts.recordKey('tmdb-114')]);
assert.deepEqual(new Set(reads()), expectedKeys);
assert.deepEqual(nonGets(), []);
assert.ok(!reads().some(key => /view-index|discovered-films/.test(key)), 'the large objects are not read');
assert.deepEqual(new Set(answer.reads), expectedKeys, 'the answer lists the keys it rests on');

// The same films through the baseline import's own validate route give the same outcome counts.
{
  const texts = Object.fromEntries(Object.entries(EXPORT_FILES).map(([kind, name]) => [kind, files[name]]));
  const parsed = parseExport(texts);
  const programme = JSON.parse(records.get('epg/generations/' + G1 + '/programme.json').text);
  const index = buildIndex({programme, metadata: JSON.parse(records.get('metadata.json').text), ratings: JSON.parse(records.get('enrichment/ratings/generations/gen-1.json').text)});
  const films = new Map(parsed.films.map(film => [film.code, film]));
  const items = matchExport(parsed.films, index).filter(match => match.status === 'accepted' && match.filmId !== 'm1').map(match => planItem(films.get(match.code), match));
  const validate = JSON.parse(JSON.stringify(await Facts.previewBaselineChunk(env, {origin: {archiveSha256: answer.archive.sha256, generatedAt: GENERATED, generatedAtSource: 'archive_name'}, chunk: 0, items})));
  const facts = Object.fromEntries(Object.entries(answer.proposal.facts).filter(([code, n]) => n > 0 && code !== 'unverified'));
  assert.deepEqual(validate.outcomes, facts);
  assert.equal(validate.films.conflict, answer.proposal.films.aliasConflict);
  assert.equal(validate.films.planned, answer.proposal.films.compared);
}

// 2. Nothing in the answer, the logs or an outbound request leaks the archive beyond the response itself.
assert.deepEqual(logged, []);
assert.deepEqual(fetches, []);
assert.doesNotMatch(JSON.stringify(answer), /demo-user|letterboxd-demo/, 'the archive name is not echoed');

// 3. One preview at a time per isolate: a second one while the first runs is refused before its body is read; once the
// first is done the next runs and reads the same state.
{
  calls = [];
  const [x, y] = await Promise.all([send({bytes: archive}), send({bytes: archive})]);
  assert.equal(x.status, 200);
  assert.deepEqual([y.status, y.body], [429, {error: 'preview_busy'}]);
  assert.equal(y.headers.get('Cache-Control'), 'no-store');
  const z = await send({bytes: archive});
  assert.equal(z.status, 200);
  assert.deepEqual(x.body, z.body);
  assert.deepEqual({...x.body, reads: null}, {...answer, reads: null});
  assert.deepEqual(nonGets(), []);
  // A slot left by a request the runtime cancelled is taken over once it is older than the slot time.
  vm.runInContext('LBA_ACTIVE_AT=Date.now()-1000', context);
  assert.equal((await send({bytes: archive})).status, 429);
  vm.runInContext('LBA_ACTIVE_AT=Date.now()-60001', context);
  assert.equal((await send({bytes: archive})).status, 200);
  // A failed preview releases the slot too.
  const bad = await send({bytes: Buffer.from('not a zip at all, definitely not')});
  assert.equal(bad.status, 422);
  assert.equal((await send({bytes: archive})).status, 200);
}

// 4. The same archive after its baseline commit: the receipt is seen and every compared fact is unchanged.
{
  await seedWorld();
  const clean = exportFilms.filter(film => ['a1', 'b2', 'd4', 'h8'].includes(film.code));
  const zip = exportArchive(clean);
  const first = await send({bytes: zip});
  assert.equal(first.status, 200);
  const parsed = parseExport(Object.fromEntries(Object.entries(EXPORT_FILES).map(([kind, name]) => [kind, exportFiles(clean)[name]])));
  const index = buildIndex({programme: {films: programmeFilms}, metadata: {}, ratings: {ratings: {a1: 4, c3: 4.5}}});
  const films = new Map(parsed.films.map(film => [film.code, film]));
  const items = matchExport(parsed.films, index).filter(match => match.status === 'accepted').map(match => planItem(films.get(match.code), match)).sort((a, b) => a.lid < b.lid ? -1 : 1);
  writable = true;
  await Facts.commitBaselineChunk(env, {origin: {archiveSha256: first.body.archive.sha256, generatedAt: GENERATED, generatedAtSource: 'archive_name'}, chunk: 0, items});
  writable = false;
  vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', context);
  calls = [];
  const again = await send({bytes: zip});
  assert.equal(again.status, 200);
  assert.equal(again.body.baseline.status, 'unknown', 'a receipt of one archive is not a baseline');
  assert.equal(again.body.baseline.thisArchive.status, 'committed');
  assert.equal(again.body.proposal.films.compared, 4);
  assert.deepEqual(Object.entries(again.body.proposal.facts).filter(([, n]) => n > 0), [['unchanged', 8]]);
  assert.equal(again.body.details.adds.total, 0);
  assert.equal(again.body.details.updates.total, 0);
  assert.deepEqual(nonGets(), []);
}

// 5. A stale export, a renamed archive and the export time rules.
{
  await seedWorld();
  const zip = exportArchive(exportFilms.slice(0, 2));
  const stale = await send({bytes: zip, name: 'letterboxd-demo-user-2026-07-01-10-00-utc.zip'});
  assert.equal(stale.status, 200);
  assert.ok(stale.body.freshness.needsFreshArchive);
  assert.deepEqual(stale.body.freshness.reasons, ['archive_stale']);
  const renamed = await send({bytes: zip, name: 'my-export.zip'});
  assert.equal(renamed.status, 422); assert.equal(renamed.body.error, 'generated_at_required');
  const declared = await send({bytes: zip, name: 'my-export.zip', generatedAt: '2026-10-30T07:00Z'});
  assert.equal(declared.status, 200);
  assert.equal(declared.body.archive.generatedAt, '2026-10-30T07:00:00.000Z');
  assert.equal(declared.body.archive.generatedAtSource, 'owner_declared');
  assert.equal(declared.body.archive.nameStandard, false);
  for (const [name, generatedAt, error] of [[NAME, '2026-10-30T07:00Z', 'generated_at_conflict'], ['x.zip', '2026-11-30T07:00Z', 'generated_at_future'], ['x.zip', '2010-01-01T00:00Z', 'generated_at_too_old'], ['x.zip', 'yesterday', 'generated_at_invalid'], ['x.zip', '2026-10-30 07:00', 'generated_at_invalid'], ['letterboxd-demo-user-2026-11-30-10-00-utc.zip', undefined, 'generated_at_future']]) {
    const response = await send({bytes: zip, name, generatedAt});
    assert.equal(response.status, 422, name + ' ' + generatedAt);
    assert.equal(response.body.error, error);
  }
}

// 6. Missing files, broken archives and broken CSV.
{
  await seedWorld();
  const partial = await send({bytes: exportArchive(exportFilms, {omit: ['ratings.csv', 'diary.csv']})});
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body.completeness, {status: 'partial', missing: ['ratings.csv', 'diary.csv']});
  assert.equal(partial.body.status, 'partial');
  const noWatched = await send({bytes: exportArchive(exportFilms, {omit: ['watched.csv']})});
  assert.deepEqual([noWatched.status, noWatched.body.error], [422, 'missing_watched']);
  const utf = await send({bytes: zipArchive([{name: 'watched.csv', data: Buffer.from([0x44, 0xff, 0x0a])}])});
  assert.deepEqual([utf.status, utf.body], [422, {error: 'archive_invalid', code: 'invalid_utf8', file: 'watched.csv'}]);
  const bomb = await send({bytes: zipArchive([{name: 'watched.csv', data: Buffer.alloc(3 * 1024 * 1024)}])});
  assert.deepEqual([bomb.status, bomb.body.code], [422, 'ratio_exceeded']);
  const notZip = await send({bytes: Buffer.from('this is not an archive at all')});
  assert.deepEqual([notZip.status, notZip.body.code], [422, 'not_zip']);
  const csv = await send({bytes: zipArchive([{name: 'watched.csv', data: 'Date,Name,Year,Letterboxd URI\n2026-01-01,"Broken,2000,https://boxd.it/a1\n'}])});
  assert.deepEqual([csv.status, csv.body.error, csv.body.file], [422, 'csv_invalid', 'watched.csv']);
  const header = await send({bytes: zipArchive([{name: 'watched.csv', data: 'Name,Year\nA,2000\n'}])});
  assert.deepEqual([header.status, header.body.error, header.body.file, header.body.record], [422, 'csv_invalid', 'watched.csv', 1]);
  const duplicates = exportFiles([{code: 'a1', name: 'Alpha', year: 2001, watched: true, rating: 4}]);
  duplicates['ratings.csv'] += '2026-01-05,Alpha,2001,https://boxd.it/a1,2\n';
  duplicates['watched.csv'] += '2026-01-01,Alpha,2001,https://boxd.it/a1\n';
  const dup = await send({bytes: zipArchive(Object.entries(duplicates).map(([name, data]) => ({name, data})))});
  assert.equal(dup.status, 200);
  assert.equal(dup.body.export.files.ratings.conflicts, 1, 'two different ratings of one film withhold it from ratings');
  assert.equal(dup.body.export.files.watched.duplicates, 1);
  assert.deepEqual(byCode(dup.body.details.adds).a1.facts, {watched: true, rating: null}, 'the withheld rating is not proposed');
  assert.deepEqual(nonGets(), []);
}

// 7. A source that fails, and state that changes during the read.
{
  await seedWorld();
  failing = new Set(['metadata.json']);
  const noMetadata = await send({bytes: archive});
  assert.equal(noMetadata.status, 200);
  assert.equal(noMetadata.body.matching.sources.metadata.evidence, 'unavailable');
  assert.equal(noMetadata.body.matching.status, 'partial');
  assert.equal(noMetadata.body.status, 'partial');
  await seedWorld();
  failing = new Set([Facts.FACTS_KEYS.links]);
  const noLinks = await send({bytes: archive});
  assert.equal(noLinks.status, 200);
  assert.equal(noLinks.body.proposal.films.unverified, 8);
  assert.ok(noLinks.body.proposal.reasons.includes('source_unavailable:links'));
  assert.equal(noLinks.body.details.adds.total, 0, 'nothing is proposed as new when the link index is unknown');
  await seedWorld();
  failing = new Set(['epg/published-generation.json']);
  const noProgramme = await send({bytes: archive});
  assert.equal(noProgramme.status, 200);
  assert.equal(noProgramme.body.matching.sources.programme.evidence, 'unavailable');
  await seedWorld();
  failing = new Set([Facts.recordKey('tmdb-103')]);
  const noRecord = await send({bytes: archive});
  assert.deepEqual(noRecord.body.details.unverified.rows.map(row => [row.code, row.held]).sort(), [['c3', 'record_unavailable'], ['m1', 'record_converging']]);
  assert.equal(noRecord.body.freshness.ratingsNewerInR2, 0);
  await seedWorld();
  let seen = 0;
  onGet = key => {if (key === Facts.FACTS_KEYS.links && ++seen === 1) Promise.resolve().then(() => put(Facts.FACTS_KEYS.links, JSON.parse(records.get(key).text)));};
  const drift = await send({bytes: archive});
  assert.equal(drift.status, 200);
  assert.deepEqual(drift.body.consistency, {status: 'drift', changed: [Facts.FACTS_KEYS.links]});
  assert.ok(drift.body.proposal.reasons.includes('facts_changed_during_read'));
  assert.equal(drift.body.status, 'partial');
}

// 8. The record read cap: films past it are unverified, never guessed.
{
  await seedWorld();
  const many = Array.from({length: 305}, (_, i) => ({code: 'p' + i, name: 'Cap Film ' + i, year: 1990 + (i % 30), watched: true}));
  const programme = JSON.parse(records.get('epg/generations/' + G1 + '/programme.json').text);
  programme.films = many.map(film => stored(film.code, film.name, film.year, null));
  put('epg/generations/' + G1 + '/programme.json', programme);
  put(Facts.FACTS_KEYS.links, Object.fromEntries(many.map(film => ['letterboxd:' + film.code, 'lb-' + film.code])));
  const capped = await send({bytes: exportArchive(many)});
  assert.equal(capped.status, 200);
  assert.deepEqual(capped.body.proposal.recordReads, {limit: 300, needed: 305, done: 300});
  assert.equal(capped.body.proposal.films.unverified, 5);
  assert.equal(capped.body.details.unverified.total, 5);
  assert.equal(capped.body.details.unverified.rows[0].held, 'record_read_limit');
  assert.equal(capped.body.details.adds.total, 300);
  assert.equal(capped.body.details.adds.rows.length, 25, 'detail lists are bounded');
  assert.equal(reads().filter(key => key.startsWith('letterboxd/facts/films/')).length, 300);
}

// 9. The request boundary: everything outside the contract is refused before any read.
{
  await seedWorld();
  const zip = exportArchive(exportFilms.slice(0, 1));
  const refused = async (options, status, error) => {
    calls = [];
    const response = await send({bytes: zip, ...options});
    assert.equal(response.status, status, JSON.stringify(options) + ' ' + JSON.stringify(response.body));
    if (error) assert.equal(response.body.error, error);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(calls, [], 'no storage call for a refused request');
  };
  await refused({method: 'GET'}, 405, 'method_not_allowed');
  await refused({method: 'PUT'}, 405, 'method_not_allowed');
  await refused({origin: null}, 403, 'origin_not_allowed');
  await refused({origin: 'https://evil.test'}, 403);
  await refused({headers: {'Content-Type': 'application/json'}}, 415, 'unsupported_media_type');
  await refused({headers: {'Content-Length': null}}, 411, 'length_required');
  await refused({length: 11 * 1024 * 1024}, 413, 'archive_too_large');
  await refused({bytes: Buffer.alloc(10 * 1024 * 1024 + 1)}, 413, 'archive_too_large');
  const two = new FormData(); two.append('archive', new File([zip], NAME)); two.append('archive', new File([zip], NAME));
  await refused({form: two}, 400, 'invalid_form');
  const extra = new FormData(); extra.append('archive', new File([zip], NAME)); extra.append('note', 'x');
  await refused({form: extra}, 400, 'invalid_form');
  const none = new FormData(); none.append('generatedAt', '2026-10-30T07:00Z');
  await refused({form: none}, 400, 'invalid_form');
  const text = new FormData(); text.append('archive', 'not a file');
  await refused({form: text}, 400, 'invalid_form');
  const long = new FormData(); long.append('archive', new File([zip], 'x'.repeat(300) + '.zip'));
  await refused({form: long}, 400, 'invalid_form');
  await refused({headers: {'Content-Type': 'multipart/form-data; boundary=zzz'}}, 400, 'invalid_form');
  const other = await worker.fetch(new Request(ORIGIN + '/api/admin/letterboxd-archive/commit', {method: 'POST', headers: {Origin: ORIGIN}}), env, execution);
  assert.equal(other.status, 404);
}

// 10. An unexpected failure answers preview_failed and nothing else; no message, no stack, no log.
{
  await seedWorld();
  const original = context.LetterboxdArchivePreview;
  vm.runInContext('globalThis.__keep=LetterboxdArchivePreview.buildPreview', context);
  vm.runInContext('LetterboxdArchivePreview.buildPreview=()=>{throw new Error("boom with Alpha a1")}', context);
  const failed = await send({bytes: archive});
  assert.deepEqual([failed.status, failed.body], [500, {error: 'preview_failed'}]);
  vm.runInContext('LetterboxdArchivePreview.buildPreview=globalThis.__keep', context);
  assert.equal(original, undefined, 'the bundle keeps its modules in the script scope, not on the global');
  assert.deepEqual(logged, []);
}

// 11. The asset page and route stay inside the admin boundary.
{
  const source = fs.readFileSync('src/admin/letterboxd-archive.js', 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /\.put\(|\.delete\(|\.list\(|\bfetch\(|console\.|waitUntil|caches\.|\benv\.(?!BUCKET\b)\w/, 'only the bucket binding, only get');
}
console.log('admin-letterboxd-archive-api: ok');

function webcryptoHex(buffer) {return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');}
