// Confirmed rated-only rows from a synthetic Letterboxd ZIP (AIR-340). Preview does not fetch.
// The identity step is one explicit film. Nothing here calls Letterboxd, TMDB or a production bucket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {putOwned} from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';
import {exportArchive} from './fixtures/letterboxd-archive.mjs';

const NOW = Date.parse('2026-10-31T09:00:00.000Z'), DAY = 86400000;
const ORIGIN = 'https://iptv.test', G1 = '11111111-1111-4111-8111-111111111111';
const NAME = 'letterboxd-demo-user-2026-10-20-08-15-utc.zip', GENERATED = '2026-10-20T08:15:00.000Z';
const ACCESS = 'owner-session-assertion';
const records = new Map();
let calls = [], version = 0, failReceipt = false;
const net = {calls: []};
function page({code, title, year, tmdb, type = 'movie', slug}) {
  const ld = JSON.stringify({name: title, releasedEvent: [{'@type': 'PublicationEvent', startDate: String(year)}]});
  return '<html><head><link rel="canonical" href="https://letterboxd.com/film/' + slug + '/"><link rel="shortlink" href="https://boxd.it/' + code + '">'
    + '<meta property="og:title" content="' + title + ' (' + year + ')">'
    + '<script type="application/ld+json">/* <![CDATA[ */' + ld + '/* ]]> */</script></head>'
    + '<body class="film" data-tmdb-type="' + type + '" data-tmdb-id="' + tmdb + '"></body></html>';
}
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
function http(status, body, headers = {}) {
  return {status, headers: headersOf(headers), async text() {return body;}};
}
net.handler = async () => {throw new Error('unexpected outbound request');};
const bucket = {
  async get(key) {
    calls.push('get:' + key);
    const entry = records.get(key);
    if (!entry) return null;
    return {etag: entry.etag, uploaded: new Date(NOW - DAY), body: null, json: async () => JSON.parse(entry.text), text: async () => entry.text};
  },
  async put(key, value, options = {}) {
    calls.push('put:' + key);
    if (failReceipt && key.endsWith('/chunks/0.candidates.json')) {failReceipt = false; throw new Error('receipt interrupted');}
    const current = records.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const etag = 'e' + (++version);
    records.set(key, {text: typeof value === 'string' ? value : new TextDecoder().decode(value), etag});
    return {etag};
  },
  async head(key) {return records.has(key) ? {etag: records.get(key).etag} : null;},
  async list() {throw new Error('rated archive never lists');},
  async delete() {throw new Error('rated archive never deletes');},
};
const put = (key, value) => records.set(key, {text: JSON.stringify(value), etag: 'e' + (++version)});
const read = key => records.has(key) ? JSON.parse(records.get(key).text) : undefined;
const env = {BUCKET: bucket};
const {context, worker, facts: Facts, resetCache} = loadArchiveWorker({now: NOW, console: {log() {}, warn() {}, error() {}, info() {}, debug() {}}, fetch: async (url, init) => {net.calls.push(String(url)); return net.handler(url, init);}});
const execution = {waitUntil() {throw new Error('no background work');}};
const film = (id, title, year, tmdbId) => ({id, tmdbId, title, original: title, titleRu: title, titleStatus: 'verified', year, directors: [], actors: [], shows: []});

async function encode(init) {
  const request = new Request('https://encode.test/', init);
  return {type: request.headers.get('content-type'), body: new Uint8Array(await request.arrayBuffer())};
}
async function send(path, {form, json, access = ACCESS, method = 'POST'} = {}) {
  const init = form ? {method: 'POST', body: form} : json ? {method: 'POST', body: JSON.stringify(json), headers: {'Content-Type': 'application/json'}} : {method};
  const encoded = method === 'GET' ? {type: null, body: null} : await encode(init);
  const headers = {...(encoded.type ? {'Content-Type': encoded.type} : {}), ...(encoded.body ? {'Content-Length': String(encoded.body.length)} : {}), Origin: ORIGIN, ...(access ? {'Cf-Access-Jwt-Assertion': access, 'X-IPTV-Admin-Action': 'letterboxd_archive_apply'} : {})};
  const response = await worker.fetch(new Request(ORIGIN + path, {method, headers, body: encoded.body}), env, execution);
  return {status: response.status, body: await response.json()};
}
async function preview(bytes) {
  const form = new FormData();
  form.append('archive', new File([bytes], NAME, {type: 'application/zip'}));
  return send('/api/admin/letterboxd-archive/preview', {form, access: null});
}
async function confirm(bytes, answer, chunk, key) {
  const batch = answer.batches.chunks.find(item => item.chunk === chunk);
  const form = new FormData();
  form.append('archive', new File([bytes], NAME, {type: 'application/zip'}));
  form.append('chunk', String(chunk));
  form.append('planHash', batch.planHash);
  form.append('programmeRunId', batch.pin || answer.batches.programmeRunId);
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
function seed(programme) {
  records.clear(); calls = []; version = 0; net.calls = []; failReceipt = false; resetCache();
  delete env.DB; delete env.TMDB_API_READ_ACCESS_TOKEN;
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - DAY).toISOString()});
  put('epg/generations/' + G1 + '/programme.json', {runId: G1, updatedAt: new Date(NOW - DAY).toISOString(), films: programme, people: {directors: [], actors: []}, stats: {}});
  put('titles.json', {}); put('people.json', {}); put('metadata.json', {});
  put(Facts.FACTS_KEYS.links, {});
  put(Facts.FACTS_KEYS.filmsList, {observedAt: '2026-02-01T00:00:00.000Z', scanId: 'scan-1', films: {}});
  put(Facts.FACTS_KEYS.watchlist, {observedAt: '2026-02-01T00:00:00.000Z', scanId: 'scan-2', films: []});
}

const archiveSource = fs.readFileSync('src/admin/letterboxd-archive.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
assert.doesNotMatch(archiveSource, /\benv\.(?!BUCKET\b)\w/);
assert.doesNotMatch(archiveSource, /\.(put|delete|list)\(|\bfetch\(|console\.|waitUntil|caches\./);
assert.match(fs.readFileSync('src/worker.js', 'utf8'), /async scheduled\(controller,env,execution\)\{execution\.waitUntil\(runD1EnrichmentProjection\(/);
assert.doesNotMatch(fs.readFileSync('src/worker.js', 'utf8'), /LetterboxdRatedCandidates|identity-step/);

const view = vm.createContext({});
vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive-view.js', 'utf8'), view);

// 1. An unknown rating is a candidate. A remake is review. A watched row with no rating is excluded. Preview fetches nothing.
{
  seed([film('rem-a', 'Remade Story', 2004, 11), film('rem-b', 'Remade Story', 2004, 12)]);
  const films = [
    {code: 'Zz9', name: 'Invented Alpha', year: 2001, rating: 4},
    {code: 'Rm1', name: 'Remade Story', year: 2004, rating: 3},
    {code: 'Ww1', name: 'Watched Only', year: 2002, watched: true},
  ];
  const bytes = exportArchive(films);
  const seen = await preview(bytes);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.writes, false);
  assert.equal(net.calls.length, 0, 'preview does not fetch');
  assert.equal(calls.some(call => call.startsWith('put:')), false);
  assert.equal(calls.some(call => call.includes('rated-candidates') || call.includes('verified-films')), false, 'preview does not read the candidate or admissions object');
  assert.equal(seen.body.ratedAdmission.pending, 1);
  assert.equal(seen.body.ratedAdmission.needsReview, 1);
  assert.equal(seen.body.ratedAdmission.excluded, 1);
  assert.equal(seen.body.ratedAdmission.matched, 0);
  assert.deepEqual(seen.body.ratedAdmission.pendingRows.map(row => row.code), ['Zz9']);
  assert.equal(Object.prototype.hasOwnProperty.call(seen.body.ratedAdmission.pendingRows[0], 'rating'), false);
  const html = view.archiveRatedHtml(seen.body);
  assert.match(html, /Уже сопоставлены/);
  assert.match(html, /Новые кандидаты на проверку/);
  assert.match(html, /Ошибки и неоднозначности/);
  assert.match(html, /не называет непроверенный фильм подтверждённым/);
  const batchHtml = view.archiveActionHtml(seen.body, {});
  assert.match(batchHtml, /не подтверждает TMDB, не ставит фильм в watchlist и не скачивает страницу/);
  const chunk = seen.body.batches.chunks.find(item => item.kind === 'candidates');
  assert.equal(chunk.films, 2);
  assert.equal(chunk.confirmable, true);
  assert.equal(chunk.pin, 'archive-' + seen.body.archive.sha256);

  const issued = await confirm(bytes, seen.body, chunk.chunk, 'rated-key-00000001');
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.writes, false);
  failReceipt = true;
  const interrupted = await commit(bytes, issued.body.confirmation);
  assert.equal(interrupted.status, 500, JSON.stringify(interrupted.body));
  const docKey = 'letterboxd/imports/' + seen.body.archive.sha256 + '/rated-candidates.json';
  const opened = read(docKey);
  assert.deepEqual(Object.keys(opened.candidates).sort(), ['Rm1', 'Zz9']);
  assert.equal(opened.candidates.Zz9.state, 'pending');
  const recovered = await commit(bytes, issued.body.confirmation);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.baseline.kind, 'candidates');
  assert.equal(Object.keys(read(docKey).candidates).length, 2, 'recovery does not register the code twice');
  const replay = await commit(bytes, issued.body.confirmation);
  assert.equal(replay.body.replayed, true);
  assert.equal(Object.keys(read(docKey).candidates).length, 2);
  put('epg/published-generation.json', {phase: 'published', programmeRunId: '22222222-2222-4222-8222-222222222222', publishedAt: new Date(NOW).toISOString()});
  assert.equal(read(docKey).archiveSha256, seen.body.archive.sha256, 'the candidate document is the archive, not the programme generation');
  put('epg/published-generation.json', {phase: 'published', programmeRunId: G1, publishedAt: new Date(NOW - DAY).toISOString()});
  resetCache();

  const receiptHtml = view.archiveReceiptHtml(seen.body, {committed: {[chunk.chunk]: {kind: 'candidates', state: 'succeeded'}}});
  assert.match(receiptHtml, /Проверить одну идентичность/);
  assert.match(receiptHtml, /ещё не читались/);

  net.handler = async url => {
    if (String(url) === 'https://boxd.it/Zz9') return http(403, 'forbidden');
    throw new Error('unexpected url ' + url);
  };
  let step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: seen.body.archive.sha256, accepted: true}});
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.fetched, false);
  assert.equal(step.body.verified, false);
  assert.equal(step.body.stop.reason, 'forbidden');
  assert.equal(net.calls.length, 1);
  const parked = net.calls.length;
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: seen.body.archive.sha256, accepted: true}});
  assert.equal(step.body.stop.reason, 'forbidden');
  assert.equal(net.calls.length, parked, 'a stop is not retried inside the next step');
  assert.equal(read(docKey).candidates.Zz9.state, 'pending');

  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/Zz9') return http(301, '', {location: 'https://letterboxd.com/film/invented-zz9/'});
    if (address === 'https://letterboxd.com/film/invented-zz9/') return http(200, page({code: 'Zz9', title: 'Invented Alpha', year: 2001, tmdb: '900001', slug: 'invented-zz9'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900001')) return http(200, JSON.stringify({id: 900001, media_type: 'movie', title: 'Invented Alpha', original_title: 'Invented Alpha', release_date: '2001-06-01'}));
    throw new Error('unexpected url ' + address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: seen.body.archive.sha256, accepted: true, resume: true}});
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.verified, false, JSON.stringify(step.body));
  assert.equal(step.body.stop && step.body.stop.reason, 'tmdb_unavailable', JSON.stringify(step.body));
  assert.equal(read('letterboxd/admissions/verified-films.json'), undefined);
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: seen.body.archive.sha256, accepted: true, resume: true}});
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.verified, true);
  assert.equal(step.body.filmId, 'tmdb_900001');
  assert.equal(step.body.tmdb, '900001');
  const factKey = read(Facts.FACTS_KEYS.links)['tmdb:900001'];
  const fact = read(Facts.recordKey(factKey));
  assert.equal(fact.links.letterboxd, null, 'the short code is not a Letterboxd lid');
  assert.equal(fact.links.tmdb, '900001');
  assert.equal(fact.rating.value, 4);
  assert.equal(fact.watched.value, true);
  assert.equal(Object.prototype.hasOwnProperty.call(fact, 'watchlist'), false);
  const admitted = read('letterboxd/admissions/verified-films.json').films.tmdb_900001;
  assert.equal(admitted.tmdb, '900001');
  assert.equal(admitted.sourceCode, 'Zz9');
  assert.equal(Object.prototype.hasOwnProperty.call(admitted, 'watchlist'), false);
  const viewIndex = read(Facts.FACTS_KEYS.viewIndex) || {};
  for (const item of Object.values(viewIndex)) assert.equal(Object.prototype.hasOwnProperty.call(item, 'watchlist'), false);
  assert.equal(read(docKey).candidates.Zz9.state, 'verified');
  assert.equal(read(docKey).candidates.Rm1.state, 'needs_review');

  const rollbackKey = 'rollback-key-0000a1';
  const rollbackIssued = await send('/api/admin/letterboxd-archive/rollback-confirm', {json: {archiveSha256: seen.body.archive.sha256, chunk: chunk.chunk, idempotencyKey: rollbackKey, accepted: true}});
  assert.equal(rollbackIssued.status, 200, JSON.stringify(rollbackIssued.body));
  const rolled = await send('/api/admin/letterboxd-archive/rollback', {json: {confirmation: rollbackIssued.body.confirmation}});
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  assert.equal(read(docKey).candidates.Zz9.state, 'verified', 'rollback keeps a verified film');
  assert.equal(read(docKey).candidates.Rm1.state, 'removed');
  assert.equal(read(Facts.recordKey(factKey)).rating.value, 4);
}

// 2. A television page and a conflicting historical movie id stay needs_review and write no Film.
{
  async function one(code, title, type, historicalTmdb) {
    seed([]);
    const bytes = exportArchive([{code, name: title, year: 2001, rating: 4}]);
    const seen = await preview(bytes);
    const chunk = seen.body.batches.chunks.find(item => item.kind === 'candidates');
    const issued = await confirm(bytes, seen.body, chunk.chunk, 'rated-key-' + code + '0001');
    const written = await commit(bytes, issued.body.confirmation);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const docKey = 'letterboxd/imports/' + seen.body.archive.sha256 + '/rated-candidates.json';
    if (historicalTmdb) {
      const doc = read(docKey);
      doc.candidates[code].historicalTmdb = historicalTmdb;
      put(docKey, doc);
    }
    env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
    net.handler = async url => {
      const address = String(url);
      if (address === 'https://boxd.it/' + code) return http(301, '', {location: 'https://letterboxd.com/film/invented-' + code.toLowerCase() + '/'});
      if (address.startsWith('https://letterboxd.com/film/')) return http(200, page({code, title, year: 2001, tmdb: type === 'tv' ? '88' : '900002', type, slug: 'invented-' + code.toLowerCase()}));
      if (address.startsWith('https://api.themoviedb.org/')) return http(200, JSON.stringify({id: 900002, media_type: 'movie', title, release_date: '2001-01-01'}));
      throw new Error('unexpected url ' + address);
    };
    const step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: seen.body.archive.sha256, accepted: true}});
    assert.equal(step.body.verified, false, code);
    assert.equal(step.body.state, 'needs_review', code + ' ' + JSON.stringify(step.body));
    assert.equal(read('letterboxd/admissions/verified-films.json'), undefined, code);
    return step.body.reason;
  }
  assert.equal(await one('Tv1', 'Series Thing', 'tv', null), 'tmdb_not_movie');
  assert.equal(await one('Old1', 'Invented Alpha', 'movie', '1'), 'ledger_candidate_differs');
}

// 3. An open ratings marker is the fact the preview compares. R2 is not a fallback. A held marker stays on R2.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air-340-'));
  const file = path.join(root, 'ratings.sqlite');
  const db = d1Standin(file);
  for (const name of ['0001_schema_v1', '0002_generation_stage', '0003_candidate_show_identity', '0004_projection_state', '0005_film_sync_state', '0006_metadata_cache', '0007_prediction_authority', '0008_published_epg_authority', '0010_ratings_authority']) db.sql(fs.readFileSync('migrations/' + name + '.sql', 'utf8'));
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=4");
  seed([film('aa', 'Rated Absent', 1999, 55)]);
  env.DB = db;
  const r2Record = {...Facts.emptyRecord('tmdb-55', {letterboxd: 'aa', tmdb: '55'}), rating: await Facts.observation({factKey: 'tmdb-55', fact: 'rating', value: 2, observedAt: '2026-01-01T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 'seed'}), watched: await Facts.observation({factKey: 'tmdb-55', fact: 'watched', value: true, observedAt: '2026-01-01T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 'seed'})};
  put(Facts.FACTS_KEYS.links, {'letterboxd:aa': 'tmdb-55', 'tmdb:55': 'tmdb-55'});
  put(Facts.recordKey('tmdb-55'), r2Record);
  const d1Record = {...Facts.emptyRecord('tmdb-55', {letterboxd: 'aa', tmdb: '55'}), rating: await Facts.observation({factKey: 'tmdb-55', fact: 'rating', value: 5, observedAt: '2026-10-25T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 'seed'}), watched: await Facts.observation({factKey: 'tmdb-55', fact: 'watched', value: true, observedAt: '2026-10-25T00:00:00.000Z', source: 'letterboxd_films_list', sourceRef: 'seed'})};
  assert.equal((await putOwned(env, Facts.FACTS_KEYS.links, null, {'letterboxd:aa': 'tmdb-55', 'tmdb:55': 'tmdb-55'})).owned, true);
  assert.equal((await putOwned(env, Facts.recordKey('tmdb-55'), null, d1Record)).owned, true);
  db.sql('UPDATE ratings_domain_authority SET generation=4');
  const bytes = exportArchive([{code: 'aa', name: 'Rated Absent', year: 1999, rating: 4}]);
  calls = []; resetCache();
  const open = await preview(bytes);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.details.heldNewer.rows.find(row => row.code === 'aa').outcomes.rating, 'older', 'the open D1 fact is newer than the archive');
  assert.equal(calls.some(call => call === 'get:' + Facts.recordKey('tmdb-55')), false, 'an open marker does not read the R2 fact');
  assert.equal(calls.some(call => call === 'get:' + Facts.FACTS_KEYS.links), false);
  assert.equal(net.calls.length, 0);

  let bumped = false;
  const originalGet = bucket.get.bind(bucket);
  bucket.get = async key => {if (!bumped && key.endsWith('/programme.json')) {bumped = true; db.sql('UPDATE ratings_domain_authority SET generation=5');} return originalGet(key);};
  resetCache();
  const drifted = await preview(bytes);
  assert.equal(drifted.status, 200, JSON.stringify(drifted.body));
  assert.equal(drifted.body.consistency.status, 'drift');
  assert.ok(drifted.body.consistency.changed.includes('ratings_domain_generation'));
  bucket.get = originalGet;
  db.sql('UPDATE ratings_domain_authority SET generation=4');

  db.sql("UPDATE ratings_domain_authority SET cutover='held'");
  resetCache(); calls = [];
  const held = await preview(bytes);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const heldRow = held.body.details.updates.rows.find(row => row.code === 'aa') || held.body.details.adds.rows.find(row => row.code === 'aa');
  assert.equal(heldRow.outcomes.rating, 'replaces', 'a held marker keeps the R2 fact');
  assert.ok(calls.some(call => call === 'get:' + Facts.recordKey('tmdb-55')));

  db.sql('DROP TABLE ratings_view');
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open'");
  resetCache();
  const broken = await preview(bytes);
  assert.equal(broken.status, 200, JSON.stringify(broken.body));
  assert.ok(broken.body.consistency.changed.includes('ratings_domain_unavailable'));
  assert.equal(broken.body.writes, false);
}

console.log('Rated archive candidates: preview is local, a commit keeps the code, a stop waits, a verified movie is not a watchlist fact, D1 wins only while open');
