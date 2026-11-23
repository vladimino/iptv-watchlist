// AIR-519. Production-shaped reproduction of GET /api/enrichment/footer/status, for the RCA and the nightly bounded-memory check (tests/footer-memory.mjs).
// Synthetic only: no production object is read. Sizes and authority state follow production as read on 17 November 2026: R2 view index 11.3 MB,
// catalog 8.0 MB (served from D1 `discovery_admission`, Discovery d1/open), programme 2.6 MB and watchlist 1.4 MB (published EPG generation in D1),
// Film/Person d1/open (11,352 films, 12,168 external ids, 10,865 localizations), predictions d1 (4,061 fingerprints, 3.1 MB; 4,061 pointers,
// 3.2 MB; profile, queue and latest run in D1), ratings d1/open (4,487 ratings_view rows).
//   node scripts/footer-memory-profile.mjs --build [--fixtures DIR]     build the fixtures once: R2 objects as files and the D1 database as sqlite
//   node [--max-old-space-size=MB] scripts/footer-memory-profile.mjs [--fixtures DIR] [--concurrent C] [--requests K] [--dump body.json] [--freeze]
//   --sequential   with --paths: one route after the other (default: all at once).
//   --path /api/admin/limbo?limit=25&attention=now | --paths /api/admin/limbo?...,/api/admin/identity-work?limit=25   measure another route, or two routes at once.
// Run from a checkout after `npm run build`: the deployed bundle dist/server/index.js answers, the same code workerd runs, so one set of fixtures
// measures two versions. R2 objects are Buffers outside the V8 heap. --freeze stops the Worker's clock at the fixtures' clock. Prints one JSON line.
// --export DIR writes the fixtures as `wrangler r2 object put --local` and D1 inputs for a workerd measurement (docs/evidence/footer-status-oom-rca-2026-11-17.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const cwd = process.cwd();
const {d1Standin} = await import(pathToFileURL(path.join(cwd, 'tests/d1-standin.mjs')));
const {sqliteSync} = await import(pathToFileURL(path.join(cwd, 'tests/sqlite-session.mjs')));
const arg = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback;};
const REQUESTS = Number(arg('requests', 1)), CONCURRENT = Number(arg('concurrent', 1)), DUMP = arg('dump', null);
const FIX = arg('fixtures', path.join(os.tmpdir(), 'air519-fixtures'));
const file = path.join(FIX, 'd1.sqlite');
const G1 = '22222222-2222-4222-8222-222222222222', H = 3600000;
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

if (process.argv.includes('--build')) {
  fs.rmSync(FIX, {recursive: true, force: true}); fs.mkdirSync(FIX, {recursive: true});
  const now = Number(process.env.NOW || Date.now()), T = new Date(now - 20 * H).toISOString();
  let seed = 519; const rnd = () => {seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff;};
  const pick = list => list[Math.floor(rnd() * list.length)];
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
  const text = n => {let s = ''; while (s.length < n) s += pick(words) + ' '; return s.slice(0, n);};
  const GENRES = ['Drama', 'Comedy', 'Thriller', 'Crime', 'Horror', 'Romance', 'Action', 'Documentary', 'Animation', 'Fantasy'];
  const N_D1 = 11352, N_CATALOG = 9300, N_LID = 406, N_PRED = 4061, N_VIEW = 4487;
  const tmdbOf = i => String(10000 + i * 7), lidOf = i => 'film-' + i + '-' + (1950 + i % 70);
  const showsFor = () => {const k = 1 + Math.floor(rnd() * 6), out = []; for (let j = 0; j < k; j++) {const start = now + Math.round((rnd() * 240 - 120) * H); out.push({channelId: 'c' + Math.floor(rnd() * 120), channel: 'Channel ' + Math.floor(rnd() * 120), start, end: start + 2 * H, title: text(12)});} return out;};
  const filmBody = (id, tmdb) => ({id, tmdbId: tmdb, canonicalIdentity: 'tmdb:' + tmdb, title: text(20), original: text(18), year: 1950 + Math.floor(rnd() * 75), runtime: 80 + Math.floor(rnd() * 80), genres: [pick(GENRES), pick(GENRES)], poster: 'https://image.tmdb.org/t/p/w342/' + text(12).replace(/ /g, '') + '.jpg', url: 'https://www.themoviedb.org/movie/' + tmdb, directors: [text(14), text(14)], actors: [text(14), text(14), text(14), text(14), text(14)], overview: text(40)});
  const catalog = {};
  for (let i = 0; i < N_CATALOG; i++) {const tmdb = tmdbOf(i), id = 'tmdb_' + tmdb; catalog[id] = {...filmBody(id, tmdb), shows: showsFor(), showsProgrammeRunId: G1};}
  const watchlistFilms = [];
  for (let i = 0; i < 1100; i++) {const lid = i < N_LID ? lidOf(i) : lidOf(100000 + i), tmdb = i < N_LID ? tmdbOf(N_CATALOG + i) : tmdbOf(N_D1 + 1000 + i); watchlistFilms.push({...filmBody(lid, tmdb), url: 'https://letterboxd.com/film/' + lid + '/', overview: text(700)});}
  const programmeFilms = watchlistFilms.slice(0, 500).map(film => ({...film, shows: showsFor()}));
  for (let i = 0; i < 300; i++) {const c = catalog['tmdb_' + tmdbOf(i * 3)]; programmeFilms.push({...c, catalogOnly: true, shows: showsFor()});}
  const catalogFilms = []; for (let i = 0; i < 2600; i++) {const c = catalog['tmdb_' + tmdbOf(i * 3 % N_CATALOG)]; catalogFilms.push({id: c.id, tmdbId: c.tmdbId, title: c.title, original: c.original, year: c.year, genres: c.genres, poster: c.poster, shows: showsFor()});}
  const programme = {runId: G1, updatedAt: T, watchlistCount: watchlistFilms.length, watchlistUpdatedAt: T, films: programmeFilms, catalogFilms, stats: {epgStart: T, epgEnd: T, channels: 120, scanned: 90000, titleMissing: 0, titleProvisional: 3, metadataMissing: 2}};
  const watchlist = {updatedAt: T, films: watchlistFilms};
  const fpSchema = 1, promptVersion = 1;
  const prediction = () => ({predictedRating: Math.round((2.5 + rnd() * 2.4) * 10) / 10, probability4Plus: Math.round(rnd() * 100) / 100, confidence: pick(['low', 'medium', 'high']), matchSignals: [text(70), text(70), text(70)], mainRisk: text(150), moodLabels: [text(9), text(10)], tasteProfileVersion: 7, tasteProfileHash: 'p7', fingerprintHash: 'f', fingerprintSchemaVersion: fpSchema, fingerprintPromptVersion: 1, predictionPromptVersion: promptVersion, generatedAt: T, trigger: 'scheduled'});
  const features = () => ({fingerprintHash: 'f', fingerprintSchemaVersion: fpSchema, fingerprintPromptVersion: 1, invalidatedAt: null, plotMechanics: [text(90), text(90), text(90), text(90)], moodLabels: [text(9), text(10), text(8)], execution: {pacing: text(30), tone: text(30), payoff: 'strong', craft: text(40), ending_quality: 'mixed', hero_vulnerability: 'high'}});
  // The R2 view index is the older mirror the overlays start from: the same entries with their stored facts (all replaced by D1 at d1).
  const index = {};
  for (let i = 0; i < N_CATALOG; i++) {if (i >= 5600) {index['tmdb_' + tmdbOf(i)] = i % 9 === 0 ? {watched: true, actualRating: 3.5} : {}; continue;} const f = features(), item = {fingerprintHash: 'f', fingerprint: {plotMechanics: f.plotMechanics, moodLabels: f.moodLabels, execution: f.execution, fingerprintHash: 'f'}, prediction: prediction(), impactFeatures: {fingerprintHash: 'f', fingerprintSchemaVersion: fpSchema, fingerprintPromptVersion: 1, plotMechanics: f.plotMechanics.slice(0, 2), execution: {pacing: f.execution.pacing}}, moodFacet: {mappingVersion: 3, rawLabels: f.moodLabels, moodIds: ['calm', 'dark'], mapping: [], unmapped: []}}; if (i % 9 === 0) {item.watched = true; item.actualRating = Math.round(rnd() * 10) / 2;} index['tmdb_' + tmdbOf(i)] = item;}
  for (let i = 0; i < 1500; i++) {const lid = i < N_LID ? lidOf(i) : lidOf(200000 + i); index[lid] = {watched: true, actualRating: i % 3 ? Math.round(rnd() * 10) / 2 : null, ...(i % 2 ? {watchlist: true} : {})};}
  const queueIds = Object.keys(catalog);
  const queue = {schemaVersion: 3, programmeRunId: G1, hotPending: queueIds.slice(0, 3000), coldPending: queueIds.slice(3000, 9000), pending: queueIds.slice(0, 9000), priorityCount: 3000, coldRemaining: 6000, retries: Object.fromEntries(queueIds.slice(0, 2000).map((id, i) => [id, {attempts: 1 + i % 3, retryAt: now + (i % 5 - 2) * H, lastError: text(40)}])), work: Object.fromEntries(queueIds.slice(0, 4000).map(id => [id, {migration: false, reason: 'missing'}]))};
  const profile = {version: 7, updatedAt: T, profileHash: 'p7', profile: {summary: text(4000)}};

  const R2 = new Map();
  const put = (key, value) => R2.set(key, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  put('enrichment/view-index.json', index);
  const profileKey = 'enrichment/profile/versions/7.json'; put(profileKey, profile);
  put('sync.json', {stage: 'complete', runId: G1, completedAt: T, updatedAt: T});

  const names = fs.readdirSync(path.join(cwd, 'migrations')).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  const sqlite = input => {const r = sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + input, encoding: 'utf8', maxBuffer: 1 << 28}); if (r.status !== 0) throw new Error(r.stderr);};
  sqlite(names.map(name => fs.readFileSync(path.join(cwd, 'migrations', name), 'utf8')).join('\n'));
  const q = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
  let sql = 'BEGIN;\n';
  // Film/Person (d1/open).
  for (let i = 0; i < N_D1; i++) {
    const lid = i >= N_CATALOG && i < N_CATALOG + N_LID ? lidOf(i - N_CATALOG) : null, tmdb = tmdbOf(i), id = lid ? 'film:' + lid : 'film:tmdb:' + tmdb;
    sql += `INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,${q('tmdb:' + tmdb)},${q(text(18))},${q(T)});\n`;
    sql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'tmdb',${q(tmdb)},1,0,NULL);\n`;
    if (lid) {
      sql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'letterboxd',${q(lid)},1,0,NULL);\n`;
      sql += `INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES (${q(id)},1,1999,NULL,NULL,'https://a.example/p.jpg',${q('https://letterboxd.com/film/' + lid + '/')},'[]',NULL,'{}',NULL,NULL,${q(T)});\n`;
    }
    if (i % 100 < 96) sql += `INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES (${q(id)},'localization','provisional','wikidata','p','{"sources":[]}',${q(text(22))},'automatic',${q(T)});\n`;
  }
  for (let i = 0; i < 5; i++) sql += `INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q('film:tmdb:' + tmdbOf(i * 11 + 1))},'tmdb',${q(tmdbOf(i * 11 + 2))},0,1,NULL);\n`;
  // Discovery (d1/open): the catalog is the current admissions.
  for (const [id, film] of Object.entries(catalog)) sql += `INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES (${q(id)},${q(film.tmdbId)},'movie',${q(film.canonicalIdentity)},1,'current',${q(JSON.stringify(film))});\n`;
  // Discovery observations with a decision, as the owner Limbo reads them (GET /api/admin/limbo, /api/admin/identity-work): the cap of the D1 observation index
  // (3,000) active observations, each with its decision and one to six shows. OBS=0 builds none.
  {
    const {decisionHash} = await import(pathToFileURL(path.join(cwd, 'src/discovery-authority.js')));
    const N_OBS = Number(process.env.OBS ?? 3000);
    for (let i = 0; i < N_OBS; i++) {
      const key = 'obs-' + i + '|' + (1950 + i % 70), title = text(18), shows = showsFor();
      const payload = {title, year: 1950 + i % 70, normalizedTitle: title.toLowerCase(), evidenceKey: null, lastSeenAt: T, shows: undefined, sourceTitle: text(30), overview: text(160)};
      const decision = {key, status: i % 7 === 0 ? 'unresolved' : 'pending', attempts: i % 5, retryAt: i % 3 ? null : T, terminalReason: i % 50 === 0 ? 'no_match' : null, evidenceKey: null, programmeRunId: G1, updatedAt: T, note: text(120)};
      sql += `INSERT INTO discovery_observation (source_key,observation_key,residence,programme_run_id,normalized_title,title,year,evidence_key,seen_in_latest,last_seen_at,last_airing,confirmed_tmdb_id,payload_json) VALUES ('active',${q(key)},'active',${q(G1)},${q(title.toLowerCase())},${q(title)},${1950 + i % 70},NULL,1,${q(T)},0,NULL,${q(JSON.stringify(payload))});\n`;
      sql += `INSERT INTO discovery_decision (observation_key,programme_run_id,generation,status,attempts,evidence_key,terminal_reason,retry_at,tmdb_id,media_kind,film_id,decision_hash,payload_json) VALUES (${q(key)},${q(G1)},1,${q(decision.status)},${decision.attempts},NULL,${q(decision.terminalReason)},${q(decision.retryAt)},NULL,NULL,NULL,${q(await decisionHash(decision))},${q(JSON.stringify(decision))});\n`;
      shows.forEach((show, ordinal) => {sql += `INSERT INTO discovery_observation_show (source_key,observation_key,ordinal,channel_id,channel,start_ms,end_ms) VALUES ('active',${q(key)},${ordinal},${q(show.channelId)},${q(show.channel)},${show.start},${show.end});\n`;});
    }
  }
  // Predictions (d1): profile, queue, latest run, pointers and fingerprints.
  sql += `INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (7,'p7',1,${q(T)},${q(profileKey)},${q(sha(JSON.stringify(canonical(profile))))},NULL);\n`;
  // The queue is stored in parts, as the Worker writes it (D1 caps one statement), and read back joined in `seq` order.
  {const queueText = JSON.stringify(queue); for (let at = 0, part = 0; at < queueText.length; at += 60000, part++) sql += `INSERT INTO prediction_queue (seq,chunk_text,generation) VALUES (${part},${q(queueText.slice(at, at + 60000))},0);\n`;}
  sql += `INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('r1',1,${q(T)},${q(JSON.stringify({runId: 'r1', status: 'complete', createdAt: T, completedAt: T, results: {}, selectedIds: [], batchCount: 1, stopReason: 'queue_empty'}))});\n`;
  for (let i = 0; i < N_PRED; i++) {
    const id = 'tmdb_' + tmdbOf(i), display = {...prediction(), filmId: id, runId: 'run-' + i}, f = features();
    sql += `INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (${q(id)},7,'p7','f',${fpSchema},${promptVersion},${display.predictedRating},${q('pv/' + id)},${q('a'.repeat(64))},${q(T)},${q(JSON.stringify(display))});\n`;
    sql += `INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (${q(id)},'f',${fpSchema},1,${q(T)},NULL,${q('fp/' + id)},${q('b'.repeat(64))},${q(JSON.stringify(f))});\n`;
  }
  // Ratings (d1/open): the owner's marks and ratings.
  for (let i = 0; i < N_VIEW; i++) {
    const alias = i < 4000 ? 'tmdb_' + tmdbOf(i * 2) : lidOf(i - 4000);
    sql += `INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q(alias)},${q('fact-' + i)},${i % 3 ? 1 : 0},${i % 4 ? (1 + i % 9) / 2 : 'NULL'},${i % 5 === 0 ? 1 : 'NULL'},${i % 4 ? 1 : 0},${q(T)});\n`;
  }
  sql += 'COMMIT;\n';
  sql += "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;\n";
  sql += "UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='"+G1+"', published_programme_run_id='"+G1+"' WHERE id=1;UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;UPDATE published_epg_authority SET mode='d1' WHERE id=1;UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1;\n";
  sqlite(sql); sql = null;
  // The published generation, written by the EPG module itself (programme and watchlist documents in D1, R2 compatibility mirrors).
  const PublishedEpg = await import(pathToFileURL(path.join(cwd, 'src/published-epg.js')));
  const mirror = {async get(key) {const buf = R2.get(key); return buf ? {etag: 'e', json: async () => JSON.parse(buf.toString('utf8'))} : null;}, async put(key, value) {R2.set(key, Buffer.from(String(value))); return {etag: 'e'};}, async list() {return {objects: [], truncated: false};}};
  const published = await PublishedEpg.publishGeneration({DB: d1Standin(file), BUCKET: mirror}, {programmeRunId: G1, phase: 'published', expectedProgrammeRunId: null, programme, watchlist}, {now});
  if (!published.pointed) throw new Error('the generation was not published');
  fs.writeFileSync(path.join(FIX, 'r2.json'), JSON.stringify([...R2.keys()]));
  fs.writeFileSync(path.join(FIX, 'meta.json'), JSON.stringify({now}));
  for (const [key, buf] of R2) fs.writeFileSync(path.join(FIX, encodeURIComponent(key)), buf);
  const sizes = {viewIndexMB: +(R2.get('enrichment/view-index.json').length / 1e6).toFixed(2), catalogMB: +(JSON.stringify(catalog).length / 1e6).toFixed(2), programmeMB: +(JSON.stringify(programme).length / 1e6).toFixed(2), watchlistMB: +(JSON.stringify(watchlist).length / 1e6).toFixed(2)};
  console.log(JSON.stringify({built: FIX, sizes}));
  process.exit(0);
}

if (!fs.existsSync(path.join(FIX, 'meta.json'))) throw new Error('no fixtures in ' + FIX + ': run with --build first');
const {now} = JSON.parse(fs.readFileSync(path.join(FIX, 'meta.json'), 'utf8'));
const R2 = new Map(JSON.parse(fs.readFileSync(path.join(FIX, 'r2.json'), 'utf8')).map(key => [key, fs.readFileSync(path.join(FIX, encodeURIComponent(key)))]));

if (arg('export', null)) {
  // Inputs for a workerd run: one file per R2 object and the D1 database, with a shell script that loads them with wrangler --local.
  const out = arg('export'); fs.mkdirSync(path.join(out, 'r2'), {recursive: true});
  const lines = ['#!/bin/sh', 'set -e'];
  for (const [key, buf] of R2) {const name = encodeURIComponent(key); fs.writeFileSync(path.join(out, 'r2', name), buf); lines.push(`npx wrangler r2 object put "iptv/${key}" --file "${path.join(out, 'r2', name)}" --local --persist-to "$1" >/dev/null`);}
  fs.copyFileSync(file, path.join(out, 'd1.sqlite'));
  fs.writeFileSync(path.join(out, 'load.sh'), lines.join('\n') + '\n', {mode: 0o755});
  console.log(JSON.stringify({exported: out, objects: R2.size}));
  process.exit(0);
}

// The deployed bundle, loaded fresh (a copy, so two checkouts never share a module cache).
const bundle = path.join(cwd, 'dist/server/index.js');
if (!fs.existsSync(bundle)) throw new Error('run `npm run build` in ' + cwd + ' first');
if (process.argv.includes('--freeze')) {const RealDate = Date; globalThis.Date = class extends RealDate {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}};}
const copy = path.join(os.tmpdir(), 'air519-bundle-' + process.pid + '.mjs'); fs.copyFileSync(bundle, copy);
process.removeAllListeners('warning');
const quiet = console.log; console.log = () => {}; console.warn = () => {}; const errors = []; console.error = (...a) => errors.push(a.map(String).join(' ').slice(0, 300));
const worker = (await import(pathToFileURL(copy))).default;
fs.rmSync(copy, {force: true});
const work = path.join(os.tmpdir(), 'air519-run-' + process.pid + '.sqlite'); fs.copyFileSync(file, work);

let r2Gets = 0, d1Queries = 0, writes = 0;
// --phases (needs --expose-gc): the live heap after a full GC at every R2 read and D1 statement, labelled, to attribute what a request retains.
const phases = process.argv.includes('--phases') && typeof gc === 'function' ? [] : null;
const mark = label => {if (!phases) return; gc(); phases.push([label.slice(0, 60), +(v8.getHeapStatistics().used_heap_size / 1e6).toFixed(1)]);};
const bucket = {
  async get(key, options) {r2Gets++; mark('r2 ' + key); let buf = R2.get(key); if (!buf) return null; if (options?.range) buf = buf.subarray(options.range.offset, options.range.offset + options.range.length); const body = buf; return {etag: 'e', size: R2.get(key).length, json: async () => JSON.parse(body.toString('utf8')), text: async () => body.toString('utf8'), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), get body() {return new ReadableStream({start(c) {for (let at = 0; at < body.length; at += 65536) c.enqueue(new Uint8Array(body.subarray(at, at + 65536))); c.close();}});}};},
  async head(key) {const buf = R2.get(key); return buf ? {etag: 'e', size: buf.length} : null;},
  async put() {writes++; throw new Error('no R2 write from a GET');}, async delete() {writes++; throw new Error('no R2 delete from a GET');},
  async list() {return {objects: [], truncated: false};},
};
// An in-process D1 binding over node:sqlite (the tests' sqlite3 stand-in starts a process per statement, which only adds wall time). Rows arrive as
// plain objects, as D1 returns them; the database itself lives outside the V8 heap, as D1 does. Every statement is counted; a write fails the run.
const {DatabaseSync} = await import('node:sqlite');
const native = new DatabaseSync(work);
const statement = (sql, params) => {
  const check = () => {d1Queries++; if (!/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {writes++; throw new Error('no D1 write from a GET');}};
  const rows = () => {check(); mark('d1 ' + sql.replace(/\s+/g, ' ').trim()); return native.prepare(sql).all(...params.map(v => typeof v === 'boolean' ? Number(v) : v)).map(row => ({...row}));};
  return {sql, bind: (...next) => statement(sql, next), async all() {return {success: true, results: rows(), meta: {}};}, async first(column) {const row = rows()[0] ?? null; return column && row ? row[column] : row;}, async run() {check(); return {success: true, meta: {}};}, async raw() {return rows().map(row => Object.values(row));}};
};
const db = {prepare: sql => statement(sql, []), async batch(list) {return Promise.all(list.map(item => item.all()));}, async exec() {throw new Error('no exec from a GET');}};
// The profile serves the run checkpoint (`sync.json`) from its R2 object: that is the local stand-in, since production reads only the D1 checkpoint (ADR 0199).
const env = {BUCKET: bucket, DB: db, PREDICTION_DB_REQUIRED: 'on', EPG_CHECKPOINT_DB_OPTIONAL: 'standin'};

if (REQUESTS === 0) {quiet(JSON.stringify({statuses: [200], requests: 0, baselineHeapMB: +(v8.getHeapStatistics().used_heap_size / 1e6).toFixed(1)})); fs.rmSync(work, {force: true}); process.exit(0);}
let peak = 0; const sample = () => {const used = v8.getHeapStatistics().used_heap_size; if (used > peak) peak = used;};
const timer = setInterval(sample, 1);
const baseline = v8.getHeapStatistics().used_heap_size; peak = baseline;
// --path (default: the footer) names the route measured; --paths a,b runs those routes together, one request each, as the owner page does.
const PATHS = (arg('paths', null) || arg('path', '/api/enrichment/footer/status')).split(',');
const one = async (_, index = 0) => {const r = await worker.fetch(new Request('https://iptv.vladimino.workers.dev' + PATHS[index % PATHS.length]), env, {waitUntil() {}}); const body = await r.text(); sample(); return {status: r.status, body};};
const cpu0 = process.cpuUsage(), t0 = performance.now();
const results = [];
for (let i = 0; i < REQUESTS; i++) if (process.argv.includes('--sequential') && arg('paths', null)) for (let index = 0; index < PATHS.length; index++) results.push(await one(null, index));   // one route after the other, as the owner page does after the change
  else results.push(...await Promise.all(Array.from({length: Math.max(CONCURRENT, arg('paths', null) ? PATHS.length : 1)}, (_, index) => one(_, index))));
const wall = performance.now() - t0, cpu = process.cpuUsage(cpu0);
clearInterval(timer);
let body = {}; try {body = JSON.parse(results[0].body);} catch {body = {raw: results[0].body.slice(0, 200)};}
const {generatedAt, ...stable} = body;
if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(stable, null, 1));
quiet(JSON.stringify({statuses: results.map(r => r.status), degraded: body.degraded || [], collection: body.collection, newUnseen: body.recommendations?.newUnseen, coverage: body.coverage && {confirmed: body.coverage.confirmedFilmsTotal, current: body.coverage.currentPredictionsTotal, window: body.coverage.windowFilmsTotal}, requests: REQUESTS * CONCURRENT, concurrent: CONCURRENT, wallMs: Math.round(wall), cpuMs: Math.round((cpu.user + cpu.system) / 1000), baselineHeapMB: +(baseline / 1e6).toFixed(1), sampledPeakHeapMB: +(peak / 1e6).toFixed(1), r2Gets, d1Queries, writes, errors: errors.slice(0, 3), ...(phases ? {phases} : {})}));
fs.rmSync(work, {force: true});
