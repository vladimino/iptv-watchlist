// AIR-489 / ADR 0166, review of PR #720 (fifth): the partial-commit recovery on the REAL ratings D1 path (RatingsD1 over a sqlite D1 stand-in, marker d1/open).
// The facts, the alias index, the pending document and ratings_view are D1 documents/rows; faults are injected into D1 batches. Synthetic pages, stub canonical writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air489-d1-'));
const MIGRATIONS = ['0001_schema_v1', '0002_generation_stage', '0003_candidate_show_identity', '0004_projection_state', '0005_film_sync_state', '0006_metadata_cache', '0007_prediction_authority', '0008_published_epg_authority', '0010_ratings_authority'];
const fault = {record: null, identityWrites: null};
let n = 0;
function database() {
  const db = d1Standin(path.join(root, 'r' + (n++) + '.sqlite'), {onBatch: async statements => {
    const text = statements.map(item => item.text).join('\n');
    if (fault.record && text.includes('letterboxd/facts/films/lb-' + fault.record + '.json') && /ratings_view/.test(text)) {fault.record = null; throw new Error('D1_ERROR: record batch lost');}
    if (fault.identityWrites !== null && statements.some(item => item.text.includes('letterboxd/facts/scans/diary-identity.json') && /^\s*(INSERT INTO|DELETE FROM) ratings_document/i.test(item.text))) {if (fault.identityWrites <= 0) throw new Error('D1_ERROR: pending write lost'); fault.identityWrites--;}
  }});
  for (const name of MIGRATIONS) db.sql(fs.readFileSync('migrations/' + name + '.sql', 'utf8'));
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3");
  return db;
}
const r2 = new Map(), etags = new Map(); let rev = 0;
const bucket = {
  async get(key) {return r2.has(key) ? {etag: etags.get(key), json: async () => structuredClone(r2.get(key))} : null;},
  async put(key, value, options = {}) {const c = options.onlyIf; if (c?.etagDoesNotMatch === '*' && r2.has(key) || c?.etagMatches && c.etagMatches !== etags.get(key)) return null; r2.set(key, JSON.parse(value)); etags.set(key, String(++rev)); return {etag: etags.get(key)};},
};
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
const http = (status, body, headers = {}) => ({status, ok: status < 300, headers: headersOf(headers), async text() {return body;}});
const site = new Map(), movies = new Map(), calls = [];
const fetchImpl = async url => {
  url = String(url); calls.push(url);
  const boxd = /^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
  if (boxd) {const item = site.get(boxd[1]); return item ? http(301, '', {location: 'https://letterboxd.com/film/' + item.slug + '/'}) : http(404, '');}
  const film = /^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
  if (film) {const item = [...site.values()].find(entry => entry.slug === film[1]); return item ? http(200, item.html) : http(404, '');}
  const tm = /api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url); if (tm && movies.has(tm[1])) return http(200, movies.get(tm[1]));
  return http(404, '');
};
const add = (lid, slug, tmdb, title, year) => {
  site.set(lid, {slug, html: `<html><head><link rel="canonical" href="https://letterboxd.com/film/${slug}/"><link rel="shortlink" href="https://boxd.it/${lid}"><meta property="og:title" content="${title} (${year})"><script type="application/ld+json">${JSON.stringify({name: title, releasedEvent: [{startDate: String(year)}]})}</script></head><body data-tmdb-type="movie" data-tmdb-id="${tmdb}"></body></html>`});
  movies.set(tmdb, JSON.stringify({id: Number(tmdb), title, original_title: title, release_date: year + '-05-01'}));
};
const applied = [], seenGuard = [];
const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, console: {...console, log: () => {}}, RatingsD1,
  CanonicalCatalogReader: {catalogReaderGate: async () => ({mode: 'd1', state: 'open', generation: 2}), catalogFilmIdentityBridge: async () => ({state: 'absent'}), catalogTitlesFromD1: async () => ({})},
  CanonicalRatedAdmission: {applyRatedAdmissionRetention: async (env, input) => {seenGuard.push(env.effectGuard || null); applied.push(input); return {state: 'complete', applied: 1, failed: 0, unknown: 0, preflightFailed: 0, deferred: 0, refused: 0, units: [{kind: 'film_admission', state: 'applied'}]};}}});
for (const file of ['src/domain/tmdb-tv-identity.js', 'src/sources.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
vm.runInContext(scoped('src/letterboxd-match.js', 'LetterboxdMatch') + '\n' + scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n') + '\n' + scoped('src/domain/letterboxd-rated-admission.js', 'LetterboxdRatedAdmission'), ctx);
for (const file of ['src/letterboxd-facts.js', 'src/letterboxd-rated-candidates.js', process.env.DIARY_IDENTITY_SRC || 'src/letterboxd-diary-identity.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
// AIR-558: the facts reader takes the ratings-only view index from the Worker's derivedViewIndex; this context has no Worker, so the same two derivations are bound here (ratings_view aliases over the D1 stand-in, the D1 version token).
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;",ctx);
const Facts = vm.runInContext('LetterboxdFacts', ctx), Identity = vm.runInContext('LetterboxdDiaryIdentity', ctx);
const NOW = Date.parse('2026-11-17T22:00:00.000Z');
const opts = (at = NOW) => ({clock: () => at, remaining: () => 120000, fetchImpl});
const viewRow = (db, id) => db.sql(`SELECT watched, actual_rating FROM ratings_view WHERE alias_id='${id}'`)[0] || null;
const pendingOf = async (env, lid) => (await Facts.readDiaryIdentity(env)).films[lid];

// On D1 the record compare-and-swap writes ratings_view in the SAME batch, so `record linked but not projected` cannot happen; the non-atomic gap is between the
// alias index (links.json) and that record batch. (a) the alias commits, the record+view batch fails, and the final pending write is lost: the intent written first
// survives and a later ordinary step whose page holds another id completes the link and tmdb_<n> in ratings_view.
{
  const db = database(), env = {DB: db, BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'fixture-token'};
  await Facts.applyDiaryEvidence(env, [{lid: 'Dd1a', watchedDate: '2026-11-17', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:7'}]);
  assert.deepEqual(viewRow(db, 'Dd1a'), {watched: 1, actual_rating: 4}); assert.equal(viewRow(db, 'tmdb_900140'), null);
  add('Dd1a', 'fixture-dd1a-2001', '900140', 'Fixture Dd1a', 2001);
  fault.record = 'Dd1a'; fault.identityWrites = 2;
  const first = await Identity.resolve(env, [{lid: 'Dd1a', slug: 'fixture-dd1a-2001'}], opts());
  fault.record = null; fault.identityWrites = null;
  assert.equal(first.counts.persistFailed, 1);
  const intent = await pendingOf(env, 'Dd1a'); assert.equal(intent.reason, 'linking'); assert.equal(intent.tmdb, '900140');
  assert.equal((await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value['tmdb:900140'], 'lb-Dd1a', 'the alias committed');
  assert.equal(viewRow(db, 'tmdb_900140'), null, 'the projection is missing after the partial commit');
  const later = await Identity.resolve(env, [{lid: 'Oth1', slug: 'oth-1'}], opts(NOW + 6 * 60000));
  assert.equal(later.counts.verified, 1, 'the surviving intent is served off-page and completes the link');
  assert.deepEqual(viewRow(db, 'tmdb_900140'), {watched: 1, actual_rating: 4}, 'ratings_view now knows the TMDB id: Finds excludes it');
  assert.equal(await pendingOf(env, 'Dd1a'), undefined);
  assert.equal(Object.keys(r2.get('letterboxd/admissions/verified-films.json').films).filter(key => key === 'tmdb_900140').length, 1, 'one receipt; the real writer answers the replay with noop');
}
// (b) D1: the record batch fails after a confirmed admission at the source cap (attempts 6): `link_failed` keeps the verified movie id and a later off-page step
// completes the link locally, with no source request and no admission.
{
  const db = database(), env = {DB: db, BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'fixture-token'};
  await Facts.applyDiaryEvidence(env, [{lid: 'Dd1b', watchedDate: '2026-11-17', rating: 3.5, ratingState: 'rated', sourceRef: 'diary:viewing:8'}]);
  await Facts.updateDiaryIdentity(env, {set: {Dd1b: {reason: 'forbidden', slug: 'fixture-dd1b-2000', attempts: 5, lastAttemptAt: '2026-11-17T10:00:00.000Z', nextAttemptAt: '2026-11-17T12:00:00.000Z'}}});
  add('Dd1b', 'fixture-dd1b-2000', '900141', 'Fixture Dd1b', 2000);
  fault.record = 'Dd1b'; await Identity.resolve(env, [{lid: 'Dd1b', slug: 'fixture-dd1b-2000'}], opts()); fault.record = null;
  const stuck = await pendingOf(env, 'Dd1b'); assert.deepEqual([stuck.reason, stuck.attempts, stuck.tmdb], ['link_failed', 5, '900141'], 'AIR-599: a failed link after a verified page consumes no attempt'); assert.equal(viewRow(db, 'tmdb_900141'), null);
  await Facts.updateDiaryIdentity(env, {set: {Dd1b: {...stuck, attempts: 6}}}); // the repair is served at the source cap too
  const before = calls.length, admitted = applied.length;
  const later = await Identity.resolve(env, [{lid: 'Oth2', slug: 'oth-2'}], opts(NOW + 6 * 60000));
  assert.equal(later.counts.repaired, 1); assert.deepEqual(viewRow(db, 'tmdb_900141'), {watched: 1, actual_rating: 3.5}); assert.equal(await pendingOf(env, 'Dd1b'), undefined);
  assert.equal(calls.slice(before).filter(url => url.includes('Dd1b') || url.includes('fixture-dd1b')).length, 0); assert.equal(applied.length, admitted);
}
// (c) Fifth review of PR #1009: the canonical admission of a verified page commits through the check reservation (its env carries it; the canonical writer asserts it in its batch, see canonical-rated-admission-producer).
{
  const db = database(), env = {DB: db, BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'fixture-token'};
  await Facts.applyDiaryEvidence(env, [{lid: 'Dd1c', watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:11'}, {lid: 'Dd1d', watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:12'}]);
  add('Dd1c', 'fixture-dd1c-2002', '900150', 'Fixture Dd1c', 2002); add('Dd1d', 'fixture-dd1d-2003', '900151', 'Fixture Dd1d', 2003);
  seenGuard.length = 0;
  await Identity.resolve(env, [{lid: 'Dd1c', slug: 'fixture-dd1c-2002'}], opts());
  assert.equal(seenGuard.length, 1); assert.match(seenGuard[0]?.params?.[1] || '', /^"reservation":\{"checkId":"[\w-]+"$/, 'the canonical admission carries the reservation');
  // an effect PAUSED across the expiry of its reservation, the owner dismissing the id meanwhile (an expired reservation is not in flight): the final link is refused AT COMMIT
  const original = Facts.bridgeDiaryFilm; let paused = false;
  Facts.bridgeDiaryFilm = async (e, args) => {
    if (!paused) {paused = true; const {version} = await Facts.readDiaryIdentityVersioned(env); const out = await Facts.ownerAction(env, {action: 'dismiss', lids: ['Dd1d'], expectedVersion: version, by: 'o', why: 'w', at: new Date(NOW + 6 * 60000).toISOString(), extra: []}); assert.equal(out.state, 'applied', JSON.stringify(out));}
    return original(e, args);
  };
  try {await Identity.resolve(env, [{lid: 'Dd1d', slug: 'fixture-dd1d-2003'}], opts());} finally {Facts.bridgeDiaryFilm = original;}
  assert.equal(paused, true);
  assert.equal((await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value['tmdb:900151'], undefined, 'no TMDB alias for the dismissed id');
  assert.equal((await pendingOf(env, 'Dd1d')).reason, 'owner_dismissed', 'the owner dismissal stands');
}
fs.rmSync(root, {recursive: true, force: true});
console.log('letterboxd-diary-identity-d1: ok');
