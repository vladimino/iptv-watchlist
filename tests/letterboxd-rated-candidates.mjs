// Confirmed rated-only rows from a synthetic Letterboxd ZIP (AIR-340). Preview does not fetch.
// The identity step is one explicit film. Nothing here calls Letterboxd, TMDB or a production bucket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {retryFingerprint} from '../src/domain/letterboxd-rated-admission.js';
import {putOwned} from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {loadArchiveWorker} from './fixtures/letterboxd-archive-worker.mjs';
import {exportArchive} from './fixtures/letterboxd-archive.mjs';

function expectRow(row) {
  return {state: row.state, reason: row.reason || null, fingerprint: row.fingerprint || retryFingerprint(row), observedAt: row.observedAt || null, registeredAt: row.registeredAt || null};
}
const NOW = Date.parse('2026-10-31T09:00:00.000Z'), DAY = 86400000;
const ORIGIN = 'https://iptv.test', G1 = '11111111-1111-4111-8111-111111111111';
const NAME = 'letterboxd-demo-user-2026-10-20-08-15-utc.zip', GENERATED = '2026-10-20T08:15:00.000Z';
const ACCESS = 'owner-session-assertion';
const records = new Map();
let calls = [], version = 0, failReceipt = false, failPut = null;
const net = {calls: []};
function page({code, title, year, tmdb, type = 'movie', slug, shortlink = true, shortlinkHref, extraRel = ''}) {
  const ld = JSON.stringify({name: title, releasedEvent: [{'@type': 'PublicationEvent', startDate: String(year)}]});
  const rel = extraRel ? 'shortlink ' + extraRel : 'shortlink';
  const href = shortlinkHref || ('https://boxd.it/' + code);
  const short = shortlink ? '<link href="' + href + '" rel="' + rel + '">' : '';
  return '<html><head><link rel="canonical" href="https://letterboxd.com/film/' + slug + '/">' + short
    + '<meta property="og:title" content="' + title + ' (' + year + ')">'
    + '<script type="application/ld+json">/* <![CDATA[ */' + ld + '/* ]]> */</script></head>'
    + '<body class="film" data-tmdb-type="' + type + '" data-tmdb-id="' + tmdb + '"></body></html>';
}
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
function http(status, body, headers = {}) {
  return {status, ok: status >= 200 && status < 300, headers: headersOf(headers), async text() {return body;}, async json() {return JSON.parse(body);}};
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
    if (failPut && failPut(key)) {failPut = null; throw new Error('injected');}
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
  records.clear(); calls = []; version = 0; net.calls = []; failReceipt = false; failPut = null; resetCache();
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

// 4. Two short codes for one movie, a code registered after the cursor, a bounded upstream, and a recoverable write.
{
  async function committed(films, key) {
    seed([]);
    const bytes = exportArchive(films);
    const seen = await preview(bytes);
    const chunk = seen.body.batches.chunks.find(item => item.kind === 'candidates');
    const issued = await confirm(bytes, seen.body, chunk.chunk, key);
    const written = await commit(bytes, issued.body.confirmation);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.baseline.fact, 'candidate');
    assert.equal(written.body.receipt.outcomes.some(item => item.outcome === 'written'), true);
    return seen.body.archive.sha256;
  }
  const sha = await committed([{code: 'Aa1', name: 'First Cut', year: 2001, rating: 4}, {code: 'Bb1', name: 'Second Cut', year: 2002, rating: 3}], 'rated-key-aabb0001');
  const docKey = 'letterboxd/imports/' + sha + '/rated-candidates.json';
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  net.handler = async (url, init) => {
    assert.ok(init && init.signal, 'identity fetch has a timeout');
    const address = String(url);
    if (address === 'https://boxd.it/Aa1') return http(301, '', {location: 'https://letterboxd.com/film/first-cut/'});
    if (address === 'https://letterboxd.com/film/first-cut/') return http(200, page({code: 'Aa1', title: 'First Cut', year: 2001, tmdb: '900010', slug: 'first-cut'}));
    if (address === 'https://boxd.it/Bb1') return http(301, '', {location: 'https://letterboxd.com/film/second-cut/'});
    if (address === 'https://letterboxd.com/film/second-cut/') return http(200, page({code: 'Bb1', title: 'Second Cut', year: 2002, tmdb: '900010', slug: 'second-cut'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900010')) return http(200, JSON.stringify({id: 900010, media_type: 'movie', title: 'First Cut', original_title: 'First Cut', release_date: '2001-01-01'}));
    throw new Error('unexpected url ' + address);
  };
  failPut = key => key === 'letterboxd/admissions/verified-films.json';
  let step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
  assert.equal(step.status, 500, JSON.stringify(step.body));
  assert.equal(read(docKey).candidates.Aa1.state, 'admitting');
  assert.equal(read('letterboxd/admissions/verified-films.json'), undefined);
  assert.equal(read(Facts.FACTS_KEYS.links)['tmdb:900010'], undefined, 'a failed admission writes no rating');
  const fetched = net.calls.length;
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
  assert.equal(step.body.verified, true, JSON.stringify(step.body));
  assert.equal(net.calls.length, fetched, 'an admitting fence does not fetch again');
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900010.sourceCode, 'Aa1');
  const admissionAt = calls.findIndex(call => call === 'put:letterboxd/admissions/verified-films.json');
  const ratingAt = calls.findIndex(call => call.startsWith('put:' + Facts.recordKey('tmdb-900010')));
  assert.ok(admissionAt >= 0 && ratingAt > admissionAt, 'the admission is fenced before the rating');
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
  assert.equal(step.body.verified, false, JSON.stringify(step.body));
  assert.equal(step.body.state, 'needs_review');
  assert.equal(step.body.reason, 'tmdb_already_imported');
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900010.sourceCode, 'Aa1', 'a second short code does not replace the Film');
  assert.equal(read(docKey).candidates.Bb1.state, 'needs_review');
  const late = read(docKey);
  late.candidates.Cc1 = {code: 'Cc1', state: 'pending', reason: 'unmatched', rating: 4, observedAt: GENERATED, name: 'Late Cut', year: 1999, historicalTmdb: null, tmdb: null};
  late.checkpoint.cursor = 'Zz9';
  put(docKey, late);
  net.handler = async (url, init) => {
    assert.ok(init && init.signal);
    const address = String(url);
    if (address === 'https://boxd.it/Cc1') return http(301, '', {location: 'https://letterboxd.com/film/late-cut/'});
    if (address === 'https://letterboxd.com/film/late-cut/') return http(200, page({code: 'Cc1', title: 'Late Cut', year: 1999, tmdb: '900011', slug: 'late-cut'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900011')) return http(200, JSON.stringify({id: 900011, media_type: 'movie', title: 'Late Cut', original_title: 'Late Cut', release_date: '1999-01-01'}));
    throw new Error('unexpected url ' + address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
  assert.equal(step.body.code, 'Cc1', JSON.stringify(step.body));
  assert.equal(step.body.verified, true);
  const sameName = await committed([{code: 'Dd1', name: 'Same Title', year: 2004, rating: 4}, {code: 'Ee1', name: 'Same Title', year: 2004, rating: 5}], 'rated-key-ddee0001');
  net.calls = [];
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sameName, accepted: true}});
  assert.equal(step.body.reason, 'same_title_year');
  assert.equal(net.calls.length, 0, 'a namesake is not fetched');
  assert.equal(read('letterboxd/admissions/verified-films.json'), undefined);

  async function stopped(code, handler, reason) {
    const archive = await committed([{code, name: 'Stop Cut', year: 2003, rating: 4}], 'rated-key-' + code + '000001');
    net.handler = handler;
    const result = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: archive, accepted: true}});
    assert.equal(result.body.stop && result.body.stop.reason, reason, code + ' ' + JSON.stringify(result.body));
    assert.equal(read('letterboxd/imports/' + archive + '/rated-candidates.json').candidates[code].state, 'pending');
    return archive;
  }
  await stopped('Tm1', async (url, init) => {assert.ok(init.signal); throw Object.assign(new Error('timed out'), {name: 'TimeoutError'});}, 'timeout');
  await stopped('Big1', async () => http(200, 'x'.repeat(3000001)), 'oversized');
  await stopped('Rt1', async () => http(429, 'slow'), 'rate_limited');
  await stopped('Ch1', async () => http(200, '<title>Just a moment...'), 'challenge');

  const rich = await committed([{code: 'Ff1', name: 'Enrich Cut', year: 2005, rating: 4}], 'rated-key-ff1000001');
  const richKey = 'letterboxd/imports/' + rich + '/rated-candidates.json';
  const richPage = code => {
    const ld = JSON.stringify({name: 'Enrich Cut', director: {name: 'Ada Queue', sameAs: 'https://letterboxd.com/director/ada-queue/'}, actor: [{name: 'Bo Queue', sameAs: 'https://letterboxd.com/actor/bo-queue/'}], releasedEvent: [{startDate: '2005'}]});
    return '<html><head><meta name="description" content="A bounded invented synopsis."><link rel="canonical" href="https://letterboxd.com/film/enrich-cut/"><link rel="shortlink" href="https://boxd.it/' + code + '"><meta property="og:title" content="Enrich Cut (2005)"><script type="application/ld+json">' + ld + '</script></head><body data-tmdb-type="movie" data-tmdb-id="900012"></body></html>';
  };
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  net.handler = async (url, init) => {
    assert.ok(init && init.signal);
    const address = String(url);
    if (address === 'https://boxd.it/Ff1') return http(301, '', {location: 'https://letterboxd.com/film/enrich-cut/'});
    if (address === 'https://letterboxd.com/film/enrich-cut/') return http(200, richPage('Ff1'));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900012')) return http(200, JSON.stringify({id: 900012, media_type: 'movie', title: 'Enrich Cut', original_title: 'Enrich Cut', release_date: '2005-01-01'}));
    throw new Error('unexpected url ' + address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: rich, accepted: true}});
  assert.equal(step.body.verified, true, JSON.stringify(step.body));
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900012.metadataAt, undefined, 'verification does not pretend the page was enriched');
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: rich, accepted: true}});
  assert.equal(step.body.enriched, true, JSON.stringify(step.body));
  assert.equal(step.body.phase, 'enrich');
  const admitted = read('letterboxd/admissions/verified-films.json').films.tmdb_900012;
  assert.equal(admitted.synopsis, 'A bounded invented synopsis.');
  assert.equal(admitted.directors[0].id, 'director/ada-queue');
  assert.equal(read(richKey).candidates.Ff1.enrichment, 'metadata');
  net.handler = async url => {
    const address = String(url);
    if (!address.startsWith('https://query.wikidata.org/')) throw new Error(address);
    const query = new URL(address).searchParams.get('query') || '';
    if (query.includes('?en')) return http(200, JSON.stringify({results: {bindings: []}}));
    return http(200, JSON.stringify({results: {bindings: [{tmdb: {value: '900012'}, film: {value: 'http://www.wikidata.org/entity/Q9'}, ru: {value: 'Обогащённый'}}]}}));
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: rich, accepted: true}});
  assert.equal(step.body.enriched, true, JSON.stringify(step.body));
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900012.titleRu, 'Обогащённый');
  assert.equal(read(richKey).candidates.Ff1.enrichment, 'done');

  const broken = await committed([{code: 'Gg1', name: 'Fence Cut', year: 2006, rating: 4}], 'rated-key-gg1000001');
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  net.handler = async (url, init) => {
    const address = String(url);
    if (address === 'https://boxd.it/Gg1') return http(301, '', {location: 'https://letterboxd.com/film/fence-cut/'});
    if (address === 'https://letterboxd.com/film/fence-cut/') return http(200, page({code: 'Gg1', title: 'Fence Cut', year: 2006, tmdb: '900013', slug: 'fence-cut'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900013')) return http(200, JSON.stringify({id: 900013, media_type: 'movie', title: 'Fence Cut', original_title: 'Fence Cut', release_date: '2006-01-01'}));
    throw new Error(address);
  };
  failPut = key => key.includes('/films/tmdb-');
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: broken, accepted: true}});
  assert.equal(step.status, 500);
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900013.sourceCode, 'Gg1');
  assert.equal(read(Facts.recordKey('tmdb-900013')), undefined);
  const before = net.calls.length;
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: broken, accepted: true}});
  assert.equal(step.body.verified, true, JSON.stringify(step.body));
  assert.equal(net.calls.length, before);
  assert.equal(read(Facts.recordKey('tmdb-900013')).rating.value, 4);
  const marked = await committed([{code: 'Hh1', name: 'Mark Cut', year: 2007, rating: 4}], 'rated-key-hh1000001');
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  let candidatePuts = 0;
  failPut = key => {
    if (!key.includes('/rated-candidates.json')) return false;
    candidatePuts += 1;
    return candidatePuts > 1;
  };
  net.handler = async (url) => {
    const address = String(url);
    if (address === 'https://boxd.it/Hh1') return http(301, '', {location: 'https://letterboxd.com/film/mark-cut/'});
    if (address === 'https://letterboxd.com/film/mark-cut/') return http(200, page({code: 'Hh1', title: 'Mark Cut', year: 2007, tmdb: '900014', slug: 'mark-cut'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900014')) return http(200, JSON.stringify({id: 900014, media_type: 'movie', title: 'Mark Cut', original_title: 'Mark Cut', release_date: '2007-01-01'}));
    throw new Error(address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: marked, accepted: true}});
  assert.equal(step.status, 500, JSON.stringify(step.body));
  assert.equal(read('letterboxd/imports/' + marked + '/rated-candidates.json').candidates.Hh1.state, 'admitting');
  assert.equal(read(Facts.recordKey('tmdb-900014')).rating.value, 4);
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: marked, accepted: true}});
  assert.equal(step.body.verified, true, JSON.stringify(step.body));
  assert.equal(read(Facts.recordKey('tmdb-900014')).rating.value, 4, 'resuming the verified mark does not write a second rating');

  const ratedApi = vm.runInContext('LetterboxdRatedCandidates', context);
  const pulled = await committed([{code: 'Ii1', name: 'Pull Cut', year: 2008, rating: 4}], 'rated-key-ii1000001');
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/Ii1') return http(301, '', {location: 'https://letterboxd.com/film/pull-cut/'});
    if (address === 'https://letterboxd.com/film/pull-cut/') {
      const removed = await ratedApi.rollbackCandidates(env, pulled, ['Ii1']);
      if (!removed || removed.removed[0] !== 'Ii1') throw new Error('rollback did not remove the in-flight code');
      return http(200, page({code: 'Ii1', title: 'Pull Cut', year: 2008, tmdb: '900015', slug: 'pull-cut'}));
    }
    if (address.startsWith('https://api.themoviedb.org/3/movie/900015')) return http(200, JSON.stringify({id: 900015, media_type: 'movie', title: 'Pull Cut', original_title: 'Pull Cut', release_date: '2008-01-01'}));
    throw new Error(address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: pulled, accepted: true}});
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.verified, false, JSON.stringify(step.body));
  assert.equal(step.body.reason, 'removed', JSON.stringify(step.body));
  assert.equal(read('letterboxd/imports/' + pulled + '/rated-candidates.json').candidates.Ii1.state, 'removed');
  assert.equal(read('letterboxd/admissions/verified-films.json'), undefined, 'a rollback during the fetch admits nothing');
  assert.equal(read(Facts.recordKey('tmdb-900015')), undefined, 'a rollback during the fetch writes no rating');

  const race = await committed([{code: 'Jj1', name: 'Race Cut', year: 2010, rating: 4}], 'rated-key-jj1000001');
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  let arrived = 0;
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/Jj1') return http(301, '', {location: 'https://letterboxd.com/film/race-cut/'});
    if (address === 'https://letterboxd.com/film/race-cut/') {
      arrived += 1;
      const mine = arrived;
      if (arrived >= 2) release();
      else await gate;
      const tmdb = mine === 1 ? '900020' : '900021';
      return http(200, page({code: 'Jj1', title: 'Race Cut', year: 2010, tmdb, slug: 'race-cut'}));
    }
    if (address.startsWith('https://api.themoviedb.org/3/movie/900020')) return http(200, JSON.stringify({id: 900020, media_type: 'movie', title: 'Race Cut', original_title: 'Race Cut', release_date: '2010-01-01'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900021')) return http(200, JSON.stringify({id: 900021, media_type: 'movie', title: 'Race Cut', original_title: 'Race Cut', release_date: '2010-01-01'}));
    throw new Error(address);
  };
  const fetchImpl = async (url, init) => {net.calls.push(String(url)); return net.handler(url, init);};
  const pair = await Promise.all([
    ratedApi.identityStep(env, {sha: race, fetchImpl}),
    ratedApi.identityStep(env, {sha: race, fetchImpl}),
  ]);
  const winner = pair.find(item => item.verified === true);
  const loser = pair.find(item => item !== winner);
  assert.ok(winner, JSON.stringify(pair));
  assert.equal(loser.reason, 'intent_conflict', JSON.stringify(pair));
  const raceFilms = read('letterboxd/admissions/verified-films.json').films;
  assert.deepEqual(Object.keys(raceFilms), ['tmdb_' + winner.tmdb]);
  assert.equal(raceFilms['tmdb_' + winner.tmdb].sourceCode, 'Jj1');
  assert.equal(read(Facts.recordKey('tmdb-' + (winner.tmdb === '900020' ? '900021' : '900020'))), undefined, 'the losing movie id is not rated');
  assert.equal(read('letterboxd/imports/' + race + '/rated-candidates.json').candidates.Jj1.tmdb, winner.tmdb);

  const bound = await committed([{code: 'Kk1', name: 'Bound Cut', year: 2009, rating: 4}], 'rated-key-kk1000001');
  put('letterboxd/admissions/verified-films.json', {schemaVersion: 1, films: {tmdb_42: {tmdb: '42', sourceCode: 'Kk1', archiveSha256: 'b'.repeat(64), title: 'Older Cut', year: 1990, filmPath: '/film/older-cut/'}}});
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/Kk1') return http(301, '', {location: 'https://letterboxd.com/film/bound-cut/'});
    if (address === 'https://letterboxd.com/film/bound-cut/') return http(200, page({code: 'Kk1', title: 'Bound Cut', year: 2009, tmdb: '900016', slug: 'bound-cut'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/900016')) return http(200, JSON.stringify({id: 900016, media_type: 'movie', title: 'Bound Cut', original_title: 'Bound Cut', release_date: '2009-01-01'}));
    throw new Error(address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: bound, accepted: true}});
  assert.equal(step.body.verified, false, JSON.stringify(step.body));
  assert.equal(step.body.reason, 'historical_alias_conflict');
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_42.sourceCode, 'Kk1');
  assert.equal(read('letterboxd/admissions/verified-films.json').films.tmdb_900016, undefined, 'one short code keeps one movie id across archives');
  assert.equal(read(Facts.recordKey('tmdb-900016')), undefined);

  async function poisoned(code, key, reason, mutate) {
    const sha = await committed([{code, name: 'Enrich Cut', year: 2005, rating: 4}], key);
    env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
    const good = page({code, title: 'Enrich Cut', year: 2005, tmdb: '900030', slug: 'enrich-cut'});
    net.handler = async url => {
      const address = String(url);
      if (address === 'https://boxd.it/' + code) return http(301, '', {location: 'https://letterboxd.com/film/enrich-cut/'});
      if (address === 'https://letterboxd.com/film/enrich-cut/') {
        const seen = net.calls.filter(item => item === address).length;
        return http(200, seen > 1 ? mutate(good) : good);
      }
      if (address.startsWith('https://api.themoviedb.org/3/movie/900030')) return http(200, JSON.stringify({id: 900030, media_type: 'movie', title: 'Enrich Cut', original_title: 'Enrich Cut', release_date: '2005-01-01'}));
      throw new Error(address);
    };
    const verified = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
    assert.equal(verified.body.verified, true, code + ' ' + JSON.stringify(verified.body));
    const enrich = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true}});
    assert.equal(enrich.body.enriched, false, JSON.stringify(enrich.body));
    assert.equal(enrich.body.stop && enrich.body.stop.reason, reason, JSON.stringify(enrich.body));
    const stored = read('letterboxd/admissions/verified-films.json').films.tmdb_900030;
    assert.equal(stored.synopsis, undefined);
    assert.equal(stored.metadataAt, undefined);
    assert.equal(stored.sourceCode, code);
    assert.equal(read('letterboxd/imports/' + sha + '/rated-candidates.json').candidates[code].state, 'verified');
    assert.notEqual(read('letterboxd/imports/' + sha + '/rated-candidates.json').candidates[code].enrichment, 'metadata');
    return sha;
  }
  await poisoned('Mm1', 'rated-key-mm1000001', 'tmdb_mismatch', html => html.replace('data-tmdb-id="900030"', 'data-tmdb-id="900031"'));
  await poisoned('Nn1', 'rated-key-nn1000001', 'tmdb_tv', html => html.replace('data-tmdb-type="movie"', 'data-tmdb-type="tv"'));
  await poisoned('Oo1', 'rated-key-oo1000001', 'shortlink_mismatch', html => html.replace('https://boxd.it/Oo1', 'https://boxd.it/Zz9'));
  await poisoned('Pp1', 'rated-key-pp1000001', 'canonical_mismatch', html => html.replace('https://letterboxd.com/film/enrich-cut/', 'https://letterboxd.com/film/other-cut/'));
}

// 6. AIR-346: a valid movie page without a shortlink tag still verifies, writes is honest, and retry is bounded.
{
  async function committed(films, key) {
    seed([]);
    const bytes = exportArchive(films);
    const seen = await preview(bytes);
    const chunk = seen.body.batches.chunks.find(item => item.kind === 'candidates');
    const issued = await confirm(bytes, seen.body, chunk.chunk, key);
    const written = await commit(bytes, issued.body.confirmation);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    return seen.body.archive.sha256;
  }
  const sha = await committed([
    {code: '103U', name: 'Men in Black 3', year: 2012, rating: 4},
    {code: '10TQ', name: 'The Green Hornet', year: 2011, rating: 3.5},
    {code: 'Zz9', name: 'Invented Alpha', year: 2001, rating: 4},
  ], 'rated-key-air346001');
  env.TMDB_API_READ_ACCESS_TOKEN = 'synthetic-token';
  const docKey = 'letterboxd/imports/' + sha + '/rated-candidates.json';
  net.calls = [];
  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/103U') return http(301, '', {location: 'https://letterboxd.com/film/men-in-black-3/'});
    if (address === 'https://letterboxd.com/film/men-in-black-3/') return http(200, page({code: '103U', title: 'Men in Black 3', year: 2012, tmdb: '41117', slug: 'men-in-black-3', shortlink: false}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/41117')) return http(200, JSON.stringify({id: 41117, media_type: 'movie', title: 'Men in Black 3', original_title: 'Men in Black 3', release_date: '2012-05-23'}));
    throw new Error(address);
  };
  let step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true, code: '103U'}});
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.verified, true, JSON.stringify(step.body));
  assert.equal(step.body.writes, true);
  assert.equal(step.body.persisted, 'admission');
  assert.equal(read(docKey).candidates['10TQ'].state, 'pending', 'a targeted step does not walk the rest of the queue');
  assert.equal(read(docKey).candidates.Zz9.state, 'pending');

  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/10TQ') return http(301, '', {location: 'https://letterboxd.com/film/the-green-hornet/'});
    if (address === 'https://letterboxd.com/film/the-green-hornet/') return http(200, page({code: '10TQ', title: 'The Green Hornet', year: 2011, tmdb: '40805', slug: 'the-green-hornet', extraRel: 'alternate', shortlinkHref: '//boxd.it/10TQ/'}));
    if (address.startsWith('https://api.themoviedb.org/3/movie/40805')) return http(200, JSON.stringify({id: 40805, media_type: 'movie', title: 'The Green Hornet', original_title: 'The Green Hornet', release_date: '2011-01-14'}));
    throw new Error(address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true, code: '10TQ'}});
  assert.equal(step.body.verified, true, JSON.stringify(step.body));

  net.handler = async url => {
    if (String(url) === 'https://letterboxd.com/film/men-in-black-3/') return http(200, '<html>no metadata</html>');
    throw new Error(String(url));
  };
  const unparsed = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: sha, accepted: true, code: '103U'}});
  assert.equal(unparsed.body.reason, 'metadata_unparsed', JSON.stringify(unparsed.body));
  assert.equal(unparsed.body.enriched, false);
  assert.equal(unparsed.body.writes, true, 'markEnrichment is a write even when metadata is not stored');
  assert.equal(unparsed.body.persisted, 'enrichment');
  assert.equal(read(docKey).candidates['103U'].enrichment, 'pending');

  const reviewSha = await committed([{code: 'Rv1', name: 'Review Film', year: 2003, rating: 4}, {code: 'Stay', name: 'Stay Pending', year: 2004, rating: 3}], 'rated-key-air346002');
  const reviewKey = 'letterboxd/imports/' + reviewSha + '/rated-candidates.json';
  net.handler = async url => {
    const address = String(url);
    if (address === 'https://boxd.it/Rv1') return http(301, '', {location: 'https://letterboxd.com/film/review-film/'});
    if (address === 'https://letterboxd.com/film/review-film/') return http(200, page({code: 'Rv1', title: 'Review Film', year: 2003, tmdb: '9', type: 'tv', slug: 'review-film'}));
    throw new Error(address);
  };
  step = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: reviewSha, accepted: true, code: 'Rv1'}});
  assert.equal(step.body.state, 'needs_review', JSON.stringify(step.body));
  assert.equal(step.body.writes, true, 'a review CAS is a write even though no Film was admitted');
  assert.equal(step.body.persisted, 'review');
  assert.equal(step.body.verified, false);
  assert.ok(step.body.reasons.includes(step.body.reason));
  const reviewDoc = read(reviewKey);
  assert.equal(reviewDoc.candidates.Rv1.state, 'needs_review');
  reviewDoc.candidates.Rv1.reason = 'shortlink_missing';
  reviewDoc.candidates.Rv1.reasons = ['shortlink_missing'];
  reviewDoc.candidates.Rv1.reasonKind = 'page_incomplete';
  put(reviewKey, reviewDoc);
  assert.equal(read(reviewKey).candidates.Stay.state, 'pending');

  const status = await send('/api/admin/letterboxd-archive/identity-status', {json: {archiveSha256: reviewSha}});
  assert.equal(status.body.writes, false);
  assert.equal(status.body.retryable.length, 1);
  assert.equal(status.body.retryable[0].code, 'Rv1');
  const etag = status.body.documentEtag;
  const fetchedAtStatus = net.calls.length;
  const retryKey = 'rated-retry-key000001';
  const retryRow = status.body.retryable[0];
  const omitted = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], documentEtag: etag, idempotencyKey: 'rated-retry-key000006', accepted: true}});
  assert.equal(omitted.status, 400, JSON.stringify(omitted.body));
  const incomplete = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: {Rv1: {state: 'needs_review', reason: 'shortlink_missing'}}, documentEtag: etag, idempotencyKey: 'rated-retry-key000007', accepted: true}});
  assert.equal(incomplete.status, 400, JSON.stringify(incomplete.body));
  const expected = {Rv1: expectRow(retryRow), Stay: expectRow(read(reviewKey).candidates.Stay)};
  const previewed = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1', 'Stay'], expected, documentEtag: etag, idempotencyKey: retryKey, accepted: true}});
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  assert.equal(previewed.body.writes, false);
  assert.equal(previewed.body.retryable, 1);
  assert.equal(net.calls.length, fetchedAtStatus, 'retry confirm does not fetch');
  const retried = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: previewed.body.confirmation}});
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.writes, true);
  assert.equal(read(reviewKey).candidates.Rv1.state, 'pending');
  assert.equal(read(reviewKey).candidates.Rv1.retryOf, 'shortlink_missing');
  assert.equal(read(reviewKey).candidates.Stay.state, 'pending');
  assert.equal(read(reviewKey).candidates.Stay.retryOf, undefined, 'an ordinary pending code is not mass-retried');
  const replay = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: previewed.body.confirmation}});
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.writes, false);

  const resetReview = read(reviewKey);
  resetReview.candidates.Rv1.state = 'needs_review';
  resetReview.candidates.Rv1.reason = 'shortlink_missing';
  resetReview.candidates.Rv1.reasons = ['shortlink_missing'];
  resetReview.candidates.Rv1.retryOf = null;
  put(reviewKey, resetReview);
  const statusDrift = await send('/api/admin/letterboxd-archive/identity-status', {json: {archiveSha256: reviewSha}});
  const driftRow = statusDrift.body.retryable[0];
  const driftExpected = {Rv1: expectRow(driftRow)};
  const driftConfirm = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: driftExpected, documentEtag: statusDrift.body.documentEtag, idempotencyKey: 'rated-retry-key000004', accepted: true}});
  assert.equal(driftConfirm.status, 200, JSON.stringify(driftConfirm.body));
  const drifted = read(reviewKey);
  drifted.candidates.Rv1.observedAt = '2026-11-04T00:00:00.000Z';
  put(reviewKey, drifted);
  const driftExec = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: driftConfirm.body.confirmation}});
  assert.equal(driftExec.status, 409, JSON.stringify(driftExec.body));
  drifted.candidates.Rv1.observedAt = driftRow.observedAt;
  put(reviewKey, drifted);

  failPut = key => {
    if (!String(key).includes('letterboxd_identity_retry')) return false;
    const stored = records.get(key);
    if (!stored) return false;
    const record = JSON.parse(stored.text);
    if (record.state === 'approved' && !record.receipt) {
      const live = JSON.parse(records.get(reviewKey).text);
      live.candidates.Rv1.registeredAt = '2026-11-04T12:00:00.000Z';
      records.set(reviewKey, {text: JSON.stringify(live), etag: 'raced-registeredAt'});
    }
    return false;
  };
  const raceConfirm = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: driftExpected, documentEtag: records.get(reviewKey).etag, idempotencyKey: 'rated-retry-key000008', accepted: true}});
  assert.equal(raceConfirm.status, 200, JSON.stringify(raceConfirm.body));
  const raced = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: raceConfirm.body.confirmation}});
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(read(reviewKey).candidates.Rv1.state, 'needs_review', 'a write between checkSubmission and CAS is not requeued');
  failPut = null;
  const unraced = read(reviewKey);
  unraced.candidates.Rv1.registeredAt = driftRow.registeredAt;
  put(reviewKey, unraced);

  failPut = key => {
    if (!String(key).includes('letterboxd_identity_retry')) return false;
    const stored = records.get(key);
    if (!stored) return false;
    const record = JSON.parse(stored.text);
    return record.state === 'running' && !record.receipt;
  };
  const lostConfirm = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: driftExpected, documentEtag: records.get(reviewKey).etag, idempotencyKey: 'rated-retry-key000005', accepted: true}});
  assert.equal(lostConfirm.status, 200, JSON.stringify(lostConfirm.body));
  const lostFirst = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: lostConfirm.body.confirmation}});
  assert.equal(lostFirst.status, 500, JSON.stringify(lostFirst.body));
  assert.equal(read(reviewKey).candidates.Rv1.state, 'pending', 'the candidate mutation survives a lost receipt');
  failPut = null;
  const lostReplay = await send('/api/admin/letterboxd-archive/identity-retry', {json: {confirmation: lostConfirm.body.confirmation}});
  assert.equal(lostReplay.status, 200, JSON.stringify(lostReplay.body));
  assert.equal(lostReplay.body.replayed, true);
  assert.ok(lostReplay.body.receipt);

  const needs = await send('/api/admin/letterboxd-archive/identity-step', {json: {archiveSha256: reviewSha, accepted: true, code: 'Rv1'}});
  assert.equal(needs.status, 200, 'requeued code can be checked by itself');

  const verifiedDoc = read(reviewKey);
  verifiedDoc.candidates.Rv1.state = 'verified';
  verifiedDoc.candidates.Rv1.reason = null;
  put(reviewKey, verifiedDoc);
  const refuseVerified = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: driftExpected, idempotencyKey: 'rated-retry-key000002', accepted: true}});
  assert.equal(refuseVerified.status, 409, JSON.stringify(refuseVerified.body));

  const stale = await send('/api/admin/letterboxd-archive/identity-retry-confirm', {json: {archiveSha256: reviewSha, codes: ['Rv1'], expected: driftExpected, documentEtag: 'not-the-etag', idempotencyKey: 'rated-retry-key000003', accepted: true}});
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
}

console.log('Rated archive candidates: preview is local, a commit keeps the code, a stop waits, a verified movie is not a watchlist fact, D1 wins only while open');
