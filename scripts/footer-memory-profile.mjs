// AIR-519. Production-sized reproduction of GET /api/enrichment/footer/status, for the RCA and the nightly bounded-memory check (tests/footer-memory.mjs).
// Synthetic only: no production object is read. Sizes follow the production objects measured read-only on 17 November 2026 (view index 11.3 MB, catalog
// 8.0 MB, programme 2.6 MB, watchlist 1.4 MB; Film/Person D1 11,352 films, 12,168 external ids, 10,865 localizations), with the shapes the code writes.
//   node scripts/footer-memory-profile.mjs --build [--fixtures DIR]          build the fixtures once (R2 objects as files, the Film/Person D1 as sqlite, `open`)
//   node [--max-old-space-size=MB] scripts/footer-memory-profile.mjs [--fixtures DIR] [--concurrent C] [--requests K] [--dump body.json] [--freeze]
// Run from a checkout: its src/, migrations/, tests/ and scripts/ are used, so the same fixtures measure two versions. The R2 objects are Buffers (outside
// the V8 heap), so the smallest --max-old-space-size at which every request answers is the footer's own heap need. Prints one JSON line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import v8 from 'node:v8';
import {webcrypto} from 'node:crypto';

const cwd = process.cwd();
const {d1Standin} = await import(path.join(cwd, 'tests/d1-standin.mjs'));
const {scoped, scopedReplacing} = await import(path.join(cwd, 'scripts/bundle-scope.mjs'));
const {sqliteSync} = await import(path.join(cwd, 'tests/sqlite-session.mjs'));
const arg = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback;};
const REQUESTS = Number(arg('requests', 1)), CONCURRENT = Number(arg('concurrent', 1)), DUMP = arg('dump', null);
const SCALE = Number(arg('scale', 1));

const FIX = arg('fixtures', path.join(os.tmpdir(), 'air519-fixtures'));
const file = path.join(FIX, 'd1.sqlite');
if (process.argv.includes('--build')) {
  fs.rmSync(FIX, {recursive: true, force: true}); fs.mkdirSync(FIX, {recursive: true});
// ---- deterministic data ----
let seed = 519; const rnd = () => {seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff;};
const pick = list => list[Math.floor(rnd() * list.length)];
const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
const text = n => {let s = ''; while (s.length < n) s += pick(words) + ' '; return s.slice(0, n);};
const GENRES = ['Drama', 'Comedy', 'Thriller', 'Crime', 'Horror', 'Romance', 'Action', 'Documentary', 'Animation', 'Fantasy'];
const now = Number(process.env.NOW || Date.now()), H = 3600000, G1 = '22222222-2222-4222-8222-222222222222', T = new Date(now - 20 * H).toISOString();
const N_D1 = Math.round(11352 * SCALE), N_CATALOG = Math.round(9300 * SCALE), N_LID = Math.round(406 * SCALE);
const tmdbOf = i => String(10000 + i * 7);
const lidOf = i => 'film-' + i + '-' + (1950 + i % 70);
const showsFor = () => {const k = 1 + Math.floor(rnd() * 6), out = []; for (let j = 0; j < k; j++) {const start = now + Math.round((rnd() * 240 - 120) * H); out.push({channelId: 'c' + Math.floor(rnd() * 120), channel: 'Channel ' + Math.floor(rnd() * 120), start, end: start + 2 * H, title: text(12)});} return out;};
const filmBody = (id, tmdb) => ({id, tmdbId: tmdb, canonicalIdentity: 'tmdb:' + tmdb, title: text(20), original: text(18), year: 1950 + Math.floor(rnd() * 75), runtime: 80 + Math.floor(rnd() * 80), genres: [pick(GENRES), pick(GENRES)], poster: 'https://image.tmdb.org/t/p/w342/' + text(12).replace(/ /g, '') + '.jpg', url: 'https://www.themoviedb.org/movie/' + tmdb, directors: [text(14), text(14)], actors: [text(14), text(14), text(14), text(14), text(14)], overview: text(40)});

// Catalog (epg/discovered-films.json ~8 MB): tmdb_ films with shows.
let catalog = {};
for (let i = 0; i < N_CATALOG; i++) {const tmdb = tmdbOf(i), id = 'tmdb_' + tmdb; catalog[id] = {...filmBody(id, tmdb), shows: showsFor(), showsProgrammeRunId: G1};}
// Watchlist (~1.3 MB): lids, part of them airing.
let watchlistFilms = [];
for (let i = 0; i < Math.round(1100 * SCALE); i++) {const lidIndex = i % N_LID === i ? i : i; const lid = i < N_LID ? lidOf(i) : lidOf(100000 + i); const tmdb = i < N_LID ? tmdbOf(N_CATALOG + i) : tmdbOf(N_D1 + 1000 + i); watchlistFilms.push({...filmBody(lid, tmdb), url: 'https://letterboxd.com/film/' + lid + '/', overview: text(560)});}
let watchlist = {updatedAt: T, films: watchlistFilms};
// Programme (~2.5 MB): watchlist films airing plus non-member catalog films.
let programmeFilms = watchlistFilms.slice(0, Math.round(500 * SCALE)).map(film => ({...film, shows: showsFor()}));
for (let i = 0; i < Math.round(300 * SCALE); i++) {const c = catalog['tmdb_' + tmdbOf(i * 3)]; programmeFilms.push({...c, catalogOnly: true, shows: showsFor()});}
let catalogFilms = []; for (let i = 0; i < Math.round(2600 * SCALE); i++) {const c = catalog['tmdb_' + tmdbOf(i * 3 % N_CATALOG)]; catalogFilms.push({id: c.id, tmdbId: c.tmdbId, title: c.title, shows: showsFor()});}
let programme = {runId: G1, updatedAt: T, watchlistCount: watchlistFilms.length, watchlistUpdatedAt: T, films: programmeFilms, catalogFilms, stats: {epgStart: T, epgEnd: T, channels: 120, scanned: 90000, titleMissing: 0, titleProvisional: 3, metadataMissing: 2}};
// View index (~11.3 MB): catalog films with predictions, plus lids (diary/watchlist facts).
const profile = {version: 7, updatedAt: T, profileHash: 'p7', profile: {summary: text(400)}};
const prediction = () => ({predictedRating: Math.round((2.5 + rnd() * 2.4) * 10) / 10, probability4Plus: Math.round(rnd() * 100) / 100, confidence: pick(['low', 'medium', 'high']), matchSignals: [text(30), text(30)], mainRisk: text(40), explanation: text(60), tasteProfileVersion: 7, tasteProfileHash: 'p7', fingerprintHash: 'f', fingerprintSchemaVersion: 1, predictionPromptVersion: 1, generatedAt: T});
const impact = () => ({fingerprintHash: 'f', fingerprintSchemaVersion: 1, fingerprintPromptVersion: 1, plotMechanics: [text(20), text(20)], execution: {pacing: text(12), tone: text(12)}});
let index = {};
const moods = () => {const raw = [text(8), text(9), text(7), text(8)]; return {mappingVersion: 3, rawLabels: raw, moodIds: ['calm', 'dark', 'tense', 'warm'], mapping: raw.map(r => ({raw: r, ids: ['dark', 'tense'], status: 'mapped'})), unmapped: []};};
const facet = imp => ({plotMechanics: imp.plotMechanics, moodLabels: [text(8), text(9), text(7), text(8)], execution: imp.execution, fingerprintHash: 'f'});
for (let i = 0; i < N_CATALOG; i++) {const id = 'tmdb_' + tmdbOf(i), imp = impact(), item = {fingerprintHash: 'f', fingerprint: facet(imp), prediction: prediction(), impactFeatures: imp, moodFacet: moods()}; if (i % 9 === 0) {item.watched = true; item.actualRating = Math.round(rnd() * 10) / 2;} if (i % 23 === 0) item.watchlist = false; index[id] = item;}
for (let i = 0; i < Math.round(1500 * SCALE); i++) {const lid = i < N_LID ? lidOf(i) : lidOf(200000 + i), item = {watched: true, actualRating: i % 3 ? Math.round(rnd() * 10) / 2 : null}; if (i % 2) item.watchlist = true; if (i % 4 === 0) {item.fingerprintHash = 'f'; item.prediction = prediction(); item.impactFeatures = impact();} index[lid] = item;}
let queue = {schemaVersion: 3, programmeRunId: G1, hotPending: Object.keys(catalog).slice(0, 3000), coldPending: Object.keys(catalog).slice(3000, 9000), pending: Object.keys(catalog).slice(0, 9000), priorityCount: 3000, coldRemaining: 6000, retries: Object.fromEntries(Object.keys(catalog).slice(0, 2000).map((id, i) => [id, {attempts: 1 + i % 3, retryAt: now + (i % 5 - 2) * H, lastError: text(40)}])), work: Object.fromEntries(Object.keys(catalog).slice(0, 4000).map(id => [id, {migration: false, reason: 'missing'}]))};

const R2 = new Map();
const put = (key, value) => R2.set(key, Buffer.from(JSON.stringify(value)));
put('epg/published-generation.json', {phase: 'published', programmeRunId: G1});
for (const key of ['epg/discovered-films.json', 'epg/generations/' + G1 + '/discovered-films.json']) put(key, catalog);
for (const key of ['programme.json', 'epg/generations/' + G1 + '/programme.json']) put(key, programme);
for (const key of ['watchlist.json', 'epg/generations/' + G1 + '/watchlist.json']) put(key, watchlist);
put('enrichment/profile/current.json', profile);
put('enrichment/view-index.json', index);
put('enrichment/prediction-queue.json', queue);
put('sync.json', {stage: 'complete', runId: G1, completedAt: T, updatedAt: T});
put('enrichment/latest-run.json', {runId: 'r1', status: 'complete', createdAt: T, completedAt: T, results: {}, selectedIds: [], batchCount: 1, stopReason: 'queue_empty'});
catalog = watchlistFilms = watchlist = programmeFilms = catalogFilms = programme = index = queue = null;
const sizes = Object.fromEntries(['enrichment/view-index.json', 'epg/discovered-films.json', 'programme.json', 'watchlist.json', 'enrichment/prediction-queue.json'].map(key => [key, +(R2.get(key).length / 1e6).toFixed(2)]));

// ---- D1 (Film/Person open) ----

const names = fs.readdirSync(path.join(cwd, 'migrations')).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite = input => {const r = sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + input, encoding: 'utf8', maxBuffer: 1 << 28}); if (r.status !== 0) throw new Error(r.stderr);};
sqlite(names.map(name => fs.readFileSync(path.join(cwd, 'migrations', name), 'utf8')).join('\n'));
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
let seedSql = 'BEGIN;\n';
for (let i = 0; i < N_D1; i++) {
  const lid = i >= N_CATALOG && i < N_CATALOG + N_LID ? lidOf(i - N_CATALOG) : null, tmdb = tmdbOf(i), id = lid ? 'film:' + lid : 'film:tmdb:' + tmdb;
  seedSql += `INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,${q('tmdb:' + tmdb)},${q(text(18))},${q(T)});\n`;
  seedSql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'tmdb',${q(tmdb)},1,0,NULL);\n`;
  if (lid) {
    seedSql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'letterboxd',${q(lid)},1,0,NULL);\n`;
    seedSql += `INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES (${q(id)},1,1999,NULL,NULL,'https://a.example/p.jpg',${q('https://letterboxd.com/film/' + lid + '/')},'[]',NULL,'{}',NULL,NULL,${q(T)});\n`;
  }
  if (i % 100 < 96) seedSql += `INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES (${q(id)},'localization','provisional','wikidata','p','{"sources":[]}',${q(text(22))},'automatic',${q(T)});\n`;
}
// A handful of conflicting identity claims, as the D1 rules must still see them.
for (let i = 0; i < 5; i++) seedSql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q('film:tmdb:' + tmdbOf(i * 11 + 1))},'tmdb',${q(tmdbOf(i * 11 + 2))},0,1,NULL);\n`;
seedSql += 'COMMIT;\n';
seedSql += "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;\n";
sqlite(seedSql);
seedSql = null;

  fs.writeFileSync(path.join(FIX, 'r2.json'), JSON.stringify([...R2.keys()]));
  fs.writeFileSync(path.join(FIX, 'meta.json'), JSON.stringify({now}));
  for (const [key, buf] of R2) fs.writeFileSync(path.join(FIX, encodeURIComponent(key)), buf);
  console.log(JSON.stringify({built: FIX, sizes}));
  process.exit(0);
}
if (!fs.existsSync(path.join(FIX, 'meta.json'))) throw new Error('no fixtures in ' + FIX + ': run with --build first');
// The clock the fixtures were built at: showings sit relative to it.
const {now} = JSON.parse(fs.readFileSync(path.join(FIX, 'meta.json'), 'utf8'));
const R2 = new Map(JSON.parse(fs.readFileSync(path.join(FIX, 'r2.json'), 'utf8')).map(key => [key, fs.readFileSync(path.join(FIX, encodeURIComponent(key)))]));
const sizes = Object.fromEntries(['enrichment/view-index.json', 'epg/discovered-films.json', 'programme.json', 'watchlist.json', 'enrichment/prediction-queue.json'].map(key => [key, +(R2.get(key).length / 1e6).toFixed(2)]));
const work = path.join(os.tmpdir(), 'air519-run-' + process.pid + '.sqlite'); fs.copyFileSync(file, work);
// ---- the Worker ----
const IMPORT = 'const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
// --freeze: the Worker's clock stands still at the fixtures' clock, so two versions are compared on the same instant (the window edges cannot move between runs).
const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}};
const ctx = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, Date: process.argv.includes('--freeze') ? FrozenDate : Date, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, ReadableStream, crypto: webcrypto, console: {log() {}, warn() {}, error: (...a) => process.stderr.write(a.map(String).join(' ').slice(0, 600) + '\n')}, setTimeout, clearTimeout, ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, fetch: async () => {throw new Error('no fetch');}});
const at = rel => path.join(cwd, rel);
process.chdir(cwd);
vm.runInContext(scoped('src/domain/film-availability.js', 'FilmAvailability'), ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js', 'utf8'), ctx); vm.runInContext(scoped('src/film-person-authority.js', 'FilmPersonAuthority'), ctx); vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js', 'CanonicalCatalogReader', IMPORT), ctx); vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js', 'utf8'), ctx);
for (const f of ['src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/sources.js', 'src/discovery.js', 'src/domain/prediction-confidence.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/filter-presets.js', 'src/worker.js']) vm.runInContext(fs.readFileSync(at(f), 'utf8').replace('export default', 'globalThis.worker='), ctx);

let r2Gets = 0, d1Queries = 0, writes = 0;
const bucket = {
  async get(key) {r2Gets++; const buf = R2.get(key); if (!buf) return null; return {etag: 'e', size: buf.length, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8'), body: new ReadableStream({start(c) {c.enqueue(new Uint8Array(buf)); c.close();}})};},
  async head(key) {const buf = R2.get(key); return buf ? {etag: 'e', size: buf.length} : null;},
  async put() {writes++; throw new Error('no R2 write from a GET');}, async delete() {writes++; throw new Error('no R2 delete from a GET');},
  async list() {return {objects: [], truncated: false};},
};
const db = d1Standin(work, {onQuery: async sql => {d1Queries++; if (!/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) writes++;}});
const env = {BUCKET: bucket, DB: db};

// Peak heap: sampled by a tight interval timer plus a GC-callback-free high-water mark of v8 heap statistics around each await.
let peak = 0; const sample = () => {const used = v8.getHeapStatistics().used_heap_size; if (used > peak) peak = used;};
const timer = setInterval(sample, 1);
global.gc?.(); global.gc?.();
const baseline = v8.getHeapStatistics().used_heap_size; peak = baseline;
if (REQUESTS === 0) {console.log(JSON.stringify({statuses: [200], baselineHeapMB: +(baseline / 1e6).toFixed(1)})); process.exit(0);}
const one = async () => {const r = await ctx.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/footer/status'), env, {waitUntil() {}}); const body = await r.text(); sample(); return {status: r.status, body};};
const cpu0 = process.cpuUsage(), t0 = performance.now();
const results = [];
for (let i = 0; i < REQUESTS; i++) results.push(...await Promise.all(Array.from({length: CONCURRENT}, one)));
const wall = performance.now() - t0, cpu = process.cpuUsage(cpu0);
clearInterval(timer);
const body = JSON.parse(results[0].body);
const strip = value => {const {generatedAt, ...rest} = value; return rest;};
if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(strip(body), null, 1));
console.log(JSON.stringify({sizesMB: sizes, statuses: results.map(r => r.status), degraded: body.degraded || [], collection: body.collection, newUnseen: body.recommendations?.newUnseen, coverage: body.coverage && {confirmed: body.coverage.confirmedFilmsTotal, current: body.coverage.currentPredictionsTotal, window: body.coverage.windowFilmsTotal}, requests: REQUESTS * CONCURRENT, concurrent: CONCURRENT, wallMs: Math.round(wall), cpuMs: Math.round((cpu.user + cpu.system) / 1000), baselineHeapMB: +(baseline / 1e6).toFixed(1), peakHeapMB: +(peak / 1e6).toFixed(1), peakAboveBaselineMB: +((peak - baseline) / 1e6).toFixed(1), r2Gets, d1Queries, writes}));
fs.rmSync(work, {force: true});
