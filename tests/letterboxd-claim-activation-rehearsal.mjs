// AIR-559 activation rehearsal: the canonical Letterboxd claim producer with its activation gate ON, end to end, BEFORE the shipped constant is switched.
// A private copy of src/ has `LETTERBOXD_CLAIM_ACTIVATED=true` (the one-line activation change); the real claim module, the real canonical reader, the real
// RatingsD1 and the real Diary identity step and baseline import run over a sqlite D1 stand-in with the full migration chain (Film/Person and ratings both
// d1/open). Only the network (Letterboxd page, TMDB) and the Film admission writer are stand-ins: the admission stand-in creates the canonical Film with its
// trusted tmdb claim, as the real admission producer would. SYNTHETIC ids only.
// Covered, as the activation plan's natural-pass and readback criteria: (A) a Diary-verified pair is claimed (receipt applied, provenance
// ratings_alias_bridge, catalogStartedFilm found); (B) a lid that the link index alone ties to a movie is never offered; (C) a refused claim (Film not yet
// admitted) keeps a bounded claim_pending entry that a later ordinary step writes once the Film exists; (D) the baseline import claims a verified item, never
// offers an inferred one, and a verified item over a marked inferred pair is refused; (E) no Started mark, alias or other claim scheme is written; (F) the
// read-only producer status tool measures exactly these writes on its own and re-proves each one; (G) its CLI and read-only binding boundary; (H) the Sync's
// epoch fence; (I) the interruption points of the bridge-to-claim handoff (kill after the handoff, lost handoff write plus kill, lost final write, a
// mismatched intent, gate off).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air559-rehearsal-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch {/* best effort */}});

// The activation change, applied to a private copy of src/ only (the shipped constant is not touched by this test).
const SRC = path.join(root, 'src');
fs.cpSync('src', SRC, {recursive: true});
{
  const file = path.join(SRC, 'canonical-letterboxd-claim.js');
  const text = fs.readFileSync(file, 'utf8');
  const on = text.replace(/export const LETTERBOXD_CLAIM_ACTIVATED=(false|true);/, 'export const LETTERBOXD_CLAIM_ACTIVATED=true;');
  assert.equal((text.match(/export const LETTERBOXD_CLAIM_ACTIVATED=(false|true);/g) || []).length, 1, 'the activation is exactly one constant');
  fs.writeFileSync(file, on);
}
// The status tool resolves its imports from ../src relative to itself, so it is copied next to the activated src/.
fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
fs.copyFileSync('scripts/letterboxd-claim-producer-status.mjs', path.join(root, 'scripts/letterboxd-claim-producer-status.mjs'));
const load = name => import(pathToFileURL(path.join(SRC, name)).href);
const Claim = await load('canonical-letterboxd-claim.js');
const Reader = await load('canonical-catalog-reader.js');
const RatingsD1 = await load('ratings-d1.js');
const LetterboxdSync = await load('letterboxd-sync.js');
const {claimProducerStatus} = await import(pathToFileURL(path.join(root, 'scripts/letterboxd-claim-producer-status.mjs')).href);
assert.equal(Claim.LETTERBOXD_CLAIM_ACTIVATED, true, 'the rehearsal runs with the gate on');

const sqlite = (file, text) => sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + text, encoding: 'utf8', maxBuffer: 1 << 26});
const rows = (file, text) => {const r = sqliteSync(['-json', '-bail', file], {input: text + ';', encoding: 'utf8'}); if (r.status !== 0) throw new Error(r.stderr); const o = r.stdout.trim(); return o ? JSON.parse(o) : [];};
const template = path.join(root, 'template.sqlite');
{
  const chain = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
  assert.equal(sqlite(template, chain.map(name => fs.readFileSync('migrations/' + name, 'utf8')).join('\n')).status, 0);
  const EMPTY = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
  assert.equal(sqlite(template, "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;"
    + "UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
    + "INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');"
    + "INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'" + EMPTY + "','" + EMPTY + "','2026-11-11T09:00:01.000Z');"
    + "UPDATE ratings_domain_authority SET mode='d1',cutover='open',generation=3 WHERE id=1;").status, 0);
}
const file = path.join(root, 'rehearsal.sqlite');
fs.copyFileSync(template, file);
const filmExists = k => rows(file, "SELECT 1 AS hit FROM film WHERE id='film:tmdb:" + k + "'").length > 0;
const createFilm = k => {if (!filmExists(k)) assert.equal(sqlite(file, "INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:" + k + "',2,'tmdb:" + k + "','Synthetic " + k + "','2026-11-01T00:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:" + k + "','tmdb','" + k + "',1,0,NULL);").status, 0);};

// The R2 stand-in (admission receipts, import receipts) and the network stand-in (Letterboxd page and TMDB document).
const r2 = new Map(), etags = new Map(); let rev = 0;
const bucket = {
  async get(key) {return r2.has(key) ? {etag: etags.get(key), json: async () => structuredClone(r2.get(key))} : null;},
  async put(key, value, options = {}) {const c = options.onlyIf; if (c?.etagDoesNotMatch === '*' && r2.has(key) || c?.etagMatches && c.etagMatches !== etags.get(key)) return null; r2.set(key, JSON.parse(value)); etags.set(key, String(++rev)); return {etag: etags.get(key)};},
  async head(key) {return r2.has(key) ? {etag: etags.get(key)} : null;},
};
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
const http = (status, body, headers = {}) => ({status, ok: status < 300, headers: headersOf(headers), async text() {return body;}});
const site = new Map(), movies = new Map();
const fetchImpl = async url => {
  url = String(url);
  const boxd = /^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
  if (boxd) {const item = site.get(boxd[1]); return item ? http(301, '', {location: 'https://letterboxd.com/film/' + item.slug + '/'}) : http(404, '');}
  const film = /^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
  if (film) {const item = [...site.values()].find(entry => entry.slug === film[1]); return item ? http(200, item.html) : http(404, '');}
  const tm = /api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url); if (tm && movies.has(tm[1])) return http(200, movies.get(tm[1]));
  return http(404, '');
};
const page = (lid, slug, tmdb, title, year) => {
  site.set(lid, {slug, html: `<html><head><link rel="canonical" href="https://letterboxd.com/film/${slug}/"><link rel="shortlink" href="https://boxd.it/${lid}"><meta property="og:title" content="${title} (${year})"><script type="application/ld+json">${JSON.stringify({name: title, releasedEvent: [{startDate: String(year)}]})}</script></head><body data-tmdb-type="movie" data-tmdb-id="${tmdb}"></body></html>`});
  movies.set(tmdb, JSON.stringify({id: Number(tmdb), title, original_title: title, release_date: year + '-05-01'}));
};
// The admission stand-in: the real producer creates the canonical Film with its trusted tmdb claim; `withholdFilm` models a Film not yet admitted.
const withholdFilm = new Set();
const CanonicalRatedAdmission = {applyRatedAdmissionRetention: async (env, input) => {
  for (const item of input.admissions || []) {const k = String(item.receipt?.tmdb || item.receiptKey.replace('tmdb_', '')); if (!withholdFilm.has(k)) createFilm(k);}
  return {state: 'complete', applied: 1, failed: 0, unknown: 0, preflightFailed: 0, deferred: 0, refused: 0, units: [{kind: 'film_admission', state: 'applied'}]};
}, assertRatedAdmissionAccepted: () => {}, UNIT_CAP: 12};

// The claim module as the Worker sees it, with two test switches: `claimMode.hang` makes the claim call never return (a process killed after the handoff and
// before the claim), `claimMode.off` models the shipped gate (constant false; the real ensure is called with `enabled:false`).
const claimMode = {hang: false, off: false, calls: 0};
const ClaimSeen = {get LETTERBOXD_CLAIM_ACTIVATED() {return !claimMode.off;}, ensureLetterboxdClaims: (e, input) => {claimMode.calls++; if (claimMode.hang) return new Promise(() => {}); return Claim.ensureLetterboxdClaims(e, claimMode.off ? {...input, enabled: false} : input);}};
const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, console: {...console, log: () => {}},
  RatingsD1, CanonicalCatalogReader: Reader, CanonicalRatedAdmission, CanonicalLetterboxdClaim: ClaimSeen});
for (const name of ['domain/tmdb-tv-identity.js', 'sources.js']) vm.runInContext(fs.readFileSync(path.join(SRC, name), 'utf8'), ctx);
vm.runInContext(scoped(path.join(SRC, 'letterboxd-match.js'), 'LetterboxdMatch') + '\n' + scopedReplacing(path.join(SRC, 'letterboxd-identity.js'), 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n') + '\n' + scoped(path.join(SRC, 'domain/letterboxd-rated-admission.js'), 'LetterboxdRatedAdmission'), ctx);
for (const name of ['letterboxd-facts.js', 'letterboxd-rated-candidates.js', 'letterboxd-diary-identity.js']) vm.runInContext(fs.readFileSync(path.join(SRC, name), 'utf8'), ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;", ctx);
const Facts = vm.runInContext('LetterboxdFacts', ctx), Identity = vm.runInContext('LetterboxdDiaryIdentity', ctx);
// `fault(statements)` may throw to lose one D1 batch (a write the platform did not commit).
let fault = null;
const env = {DB: d1Standin(file, {onBatch: async statements => {if (fault) await fault(statements);}}), BUCKET: bucket, TMDB_API_READ_ACCESS_TOKEN: 'fixture-token'};
const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const opts = (at = NOW) => ({clock: () => at, remaining: () => 120000, fetchImpl});
const claimOf = lid => rows(file, "SELECT film_id, trusted, conflicting, provenance_json FROM film_external_id WHERE scheme='letterboxd' AND value='" + lid + "'");
const receipts = () => rows(file, "SELECT state, target_id FROM canonical_write_receipt WHERE origin='letterboxd_claim' ORDER BY target_id");
const pending = async lid => (await Facts.readDiaryIdentity(env)).films[lid];
const SINCE = '2026-11-24T00:00:00.000Z';
const aliasCount = () => rows(file, 'SELECT COUNT(*) AS c FROM film_alias')[0].c;
const startedCount = () => rows(file, 'SELECT COUNT(*) AS c FROM started_mark')[0].c;
const baseline = {alias: aliasCount(), started: startedCount()};
const status0 = await claimProducerStatus(env, {since: SINCE, now: NOW});
assert.deepEqual([status0.checkoutGate, status0.receipts.all.applied, status0.claims.letterboxd, status0.producerWritesSince.films, status0.claimPending.entries], [true, 0, 0, 0, 0], 'a clean baseline');

// (A) A Diary-verified pair: the page check proves the pair, the admission creates the Film, the bridge links the movie, and the ACTIVE producer claims it.
await Facts.applyDiaryEvidence(env, [{lid: 'Ra1', watchedDate: '2026-11-23', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:1'}]);
page('Ra1', 'rehearsal-alpha-2001', '910001', 'Rehearsal Alpha', 2001);
{
  const out = await Identity.resolve(env, [{lid: 'Ra1', slug: 'rehearsal-alpha-2001'}], opts());
  assert.equal(out.counts.verified, 1); assert.equal(out.counts.claim, 'complete');
  const claim = claimOf('Ra1');
  assert.equal(claim.length, 1); assert.deepEqual([claim[0].film_id, claim[0].trusted, claim[0].conflicting], ['film:tmdb:910001', 1, 0]);
  assert.deepEqual(JSON.parse(claim[0].provenance_json), {source: 'ratings_alias_bridge', tmdb: '910001', adr: '0184'});
  assert.deepEqual(receipts(), [{state: 'applied', target_id: 'film:tmdb:910001'}]);
  assert.equal((await Reader.catalogStartedFilm(env, 'Ra1')).state, 'found', 'the Started reader now finds the lid (the AIR-549 defect class is closed for it)');
  assert.equal(await pending('Ra1'), undefined, 'a proved claim leaves no pending state');
  // a later ordinary run does not offer the proved, already-linked id again (index-only links are never offered)
  const again = await Identity.resolve(env, [{lid: 'Ra1', slug: 'rehearsal-alpha-2001'}], opts(NOW + 3600000));
  assert.equal(again.counts.claim, undefined); assert.equal(receipts().length, 1);
}

// (B) A lid the link index alone ties to a movie (as a legacy inferred import left it, unmarked) is never offered by the Diary step, so nothing is claimed.
{
  createFilm('910002');
  await Facts.applyDiaryEvidence(env, [{lid: 'Rb2', watchedDate: '2026-11-23', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:2'}]);
  const key = await Facts.linkFilm(env, {letterboxd: 'Rb2', tmdb: '910002'});
  await Facts.recordObservations(env, key, {letterboxd: 'Rb2', tmdb: '910002'}, []);
  const out = await Identity.resolve(env, [{lid: 'Rb2', slug: 'rehearsal-beta-2002'}], opts());
  assert.equal(out.counts.claim, undefined, 'no claim step for an index-only pair');
  assert.deepEqual(claimOf('Rb2'), []); assert.equal(await pending('Rb2'), undefined);
}

// (C) A verified pair whose Film is not admitted yet: the claim is refused (film_absent), a bounded claim_pending entry is kept, and a later ordinary step,
// once the Film exists, writes the claim with no source request and clears the entry.
{
  withholdFilm.add('910003');
  await Facts.applyDiaryEvidence(env, [{lid: 'Rc3', watchedDate: '2026-11-23', rating: 5, ratingState: 'rated', sourceRef: 'diary:viewing:3'}]);
  page('Rc3', 'rehearsal-gamma-2003', '910003', 'Rehearsal Gamma', 2003);
  const first = await Identity.resolve(env, [{lid: 'Rc3', slug: 'rehearsal-gamma-2003'}], opts());
  assert.equal(first.counts.verified, 1); assert.equal(first.counts.claim, 'incomplete');
  const entry = await pending('Rc3');
  assert.deepEqual([entry.reason, entry.tmdb, entry.attempts], ['claim_pending', '910003', 1]);
  assert.deepEqual(claimOf('Rc3'), []);
  const mid = await claimProducerStatus(env, {since: SINCE, now: NOW});
  assert.deepEqual([mid.claimPending.entries, mid.claimPending.due], [1, 0], 'the status tool sees the bounded pending claim, not yet due');
  withholdFilm.delete('910003'); createFilm('910003');
  const later = await Identity.resolve(env, [], opts(NOW + 13 * 3600000));
  assert.equal(later.counts.claim, 'complete', 'the off-page pending claim is served by a later ordinary step');
  assert.equal(claimOf('Rc3').length, 1); assert.equal(await pending('Rc3'), undefined);
}

// (D) The baseline import: a verified item is claimed after its chunk receipt; an inferred item is never offered; a verified item over a pair an earlier
// inferred chunk marked is offered but refused (the mark is not lifted by a later verification).
{
  createFilm('910004'); createFilm('910005'); createFilm('910006');
  const origin = sha => ({archiveSha256: sha.repeat(64), generatedAt: '2026-11-20T10:00:00.000Z', generatedAtSource: 'archive_name'});
  await Facts.commitBaselineChunk(env, {origin: origin('1'), chunk: 0, items: [{lid: 'Rd4', tmdb: '910004', facts: {watched: true}, effectiveOn: {}}]});
  assert.equal(claimOf('Rd4').length, 1, 'a verified import item is claimed');
  await Facts.commitBaselineChunk(env, {origin: origin('2'), chunk: 0, items: [{lid: 'Re5', tmdb: '910005', facts: {watched: true, rating: 3}, effectiveOn: {}, identity: 'inferred'}]});
  assert.deepEqual(claimOf('Re5'), [], 'an inferred import item is never offered');
  await Facts.commitBaselineChunk(env, {origin: origin('3'), chunk: 0, items: [{lid: 'Rf6', tmdb: '910006', facts: {watched: true, rating: 4}, effectiveOn: {}, identity: 'inferred'}]});
  await Facts.commitBaselineChunk(env, {origin: origin('4'), chunk: 0, items: [{lid: 'Rf6', tmdb: '910006', facts: {watched: true}, effectiveOn: {}}]});
  assert.deepEqual(claimOf('Rf6'), [], 'a verified item over a marked inferred pair is refused');
  assert.deepEqual((await Claim.planLetterboxdClaim(env, {lid: 'Rf6', tmdb: '910006'})).reason, 'ratings_link_inferred');
}

// (H) The Letterboxd Sync admission path runs the same Diary step with the Sync's fenced env (`fencedEnv`: the ratings guard and the `letterboxd` producer
// fence). With the current Sync epoch the claim is written inside that fence; with a stale epoch nothing is written and the pair stays pending.
{
  assert.equal(sqlite(file, "INSERT INTO letterboxd_sync_mode (id,mode,target,from_mode,epoch,drain,quarantine_reason,quarantined_at,changed_at,revision,write_id) VALUES (1,'cloudflare',NULL,'external',1,NULL,NULL,NULL,'2026-11-22T00:00:00.000Z',1,'w1')").status, 0);
  createFilm('910007'); createFilm('910008');
  await Facts.applyDiaryEvidence(env, [{lid: 'Rg7', watchedDate: '2026-11-23', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:7'}, {lid: 'Rh8', watchedDate: '2026-11-23', rating: 2, ratingState: 'rated', sourceRef: 'diary:viewing:8'}]);
  page('Rg7', 'rehearsal-g7-2007', '910007', 'Rehearsal G7', 2007); page('Rh8', 'rehearsal-h8-2008', '910008', 'Rehearsal H8', 2008);
  const current = await Identity.resolve(LetterboxdSync.fencedEnv(env, 1), [{lid: 'Rg7', slug: 'rehearsal-g7-2007'}], opts());
  assert.deepEqual([current.counts.verified, current.counts.claim], [1, 'complete'], 'current Sync epoch: claimed inside the fence');
  assert.equal(claimOf('Rg7').length, 1);
  const stale = await Identity.resolve(LetterboxdSync.fencedEnv(env, 0), [{lid: 'Rh8', slug: 'rehearsal-h8-2008'}], opts());
  assert.deepEqual(claimOf('Rh8'), [], 'stale Sync epoch: no claim');
  assert.notEqual(stale.counts.claim, 'complete');
}

// (E) The producer writes nothing but the claims: no Started mark, no alias, every claim trusted with the fixed provenance, every receipt applied.
{
  assert.equal(startedCount(), baseline.started, 'no Started mark'); assert.equal(aliasCount(), baseline.alias, 'no alias');
  const bridge = rows(file, "SELECT value, provenance_json FROM film_external_id WHERE scheme='letterboxd'");
  assert.deepEqual(bridge.map(row => row.value).sort(), ['Ra1', 'Rc3', 'Rd4', 'Rg7']);
  assert.ok(bridge.every(row => JSON.parse(row.provenance_json).source === 'ratings_alias_bridge'));
  assert.ok(receipts().every(row => row.state === 'applied')); assert.equal(receipts().length, 4);
}

// (F) The read-only status tool measures the claim writer on its own and re-proves every write: three Films claimed since the activation time, each proof
// still holds, each lid found by the Started reader, no pending entry, and it wrote nothing.
{
  const before = JSON.stringify(rows(file, 'SELECT * FROM ratings_domain_authority')) + JSON.stringify(rows(file, 'SELECT COUNT(*) AS c FROM canonical_write_receipt'));
  const status = await claimProducerStatus(env, {since: SINCE, now: NOW + 14 * 3600000});
  assert.deepEqual(status.receipts.since, {pending: 0, applied: 4, failed: 0, unknown: 0, abandoned: 0});
  assert.deepEqual(status.producerWritesSince, {films: 4, claimed: 4, proofHolds: 4, startedFound: 4, problems: {}});
  assert.deepEqual([status.claims.letterboxd, status.claims.bySource.ratings_alias_bridge], [4, 4]);
  assert.deepEqual(status.acceptance, {authoritiesOpen: true, settled: true, natural: true, allProved: true, pendingAtBoundZero: true, accepted: true}, 'the plan acceptance holds');
  assert.equal(JSON.stringify(rows(file, 'SELECT * FROM ratings_domain_authority')) + JSON.stringify(rows(file, 'SELECT COUNT(*) AS c FROM canonical_write_receipt')), before, 'the status tool wrote nothing');
  assert.ok(!JSON.stringify(status).match(/Ra1|Rc3|Rd4|Rg7|910001|film:tmdb/), 'the status report names no lid, movie or Film');
  // a claim whose proof is gone later (its Ratings link withdrawn by a case-specific repair) is reported as a problem, never counted as holding
  const index = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json'));
  const next = {...index.value}; delete next['letterboxd:Rd4'];
  await RatingsD1.putOwned(env, 'letterboxd/facts/links.json', index.etag, next);
  const after = await claimProducerStatus(env, {since: SINCE, now: NOW});
  assert.deepEqual([after.producerWritesSince.proofHolds, after.producerWritesSince.problems], [3, {proof_not_proved_ratings_link_absent: 1}]);
  assert.deepEqual([after.acceptance.allProved, after.acceptance.accepted], [false, false], 'a claim that no longer re-proves blocks the acceptance');
  const quiet = await claimProducerStatus(env, {since: '2030-01-01T00:00:00.000Z', now: NOW});
  assert.deepEqual([quiet.acceptance.natural, quiet.acceptance.accepted], [false, false], 'no natural write since T is not an acceptance');
}

// (G) The status CLI: invalid input stops before any connection; with a binding it prints the same sanitized report; the tool has no write path.
{
  const {main} = await import(pathToFileURL(path.join(root, 'scripts/letterboxd-claim-producer-status.mjs')).href);
  const printed = [];
  let opened = 0;
  const openBinding = async () => {opened++; return env.DB;};
  assert.equal(await main({argv: ['node', 'x', '--bogus'], print: text => printed.push(text), openBinding}), 2);
  assert.equal(await main({argv: ['node', 'x', '--since', 'yesterday'], print: text => printed.push(text), openBinding}), 2);
  assert.equal(await main({argv: ['node', 'x'], print: text => printed.push(text), openBinding}), 2, 'a mode is required (no silent baseline)');
  assert.equal(JSON.parse(printed.at(-1)).error, 'mode_required');
  assert.equal(await main({argv: ['node', 'x', '--baseline', '--since', SINCE], print: text => printed.push(text), openBinding}), 2, 'an ambiguous mode is refused');
  // A bare, empty or malformed `--since` is refused before any connection; it never degrades to a baseline (activation PR, handoff of 24 Nov 2026).
  for (const argv of [['--since'], ['--since', ''], ['--since', '--baseline'], ['--since', '2026-02-30T00:00:00Z'], ['--since', '2026-11-24T25:00:00Z'], ['--since', '2026-11-24'], ['--since', SINCE, '--since', SINCE]]) {
    const code = await main({argv: ['node', 'x', ...argv], print: text => printed.push(text), openBinding});
    assert.equal(code, 2, JSON.stringify(argv)); assert.match(JSON.parse(printed.at(-1)).error, /^(invalid_since|mode_ambiguous)$/, JSON.stringify(argv));
  }
  assert.equal(opened, 0, 'no refused --since opened a connection');
  assert.equal(opened, 0, 'no connection for invalid input');
  assert.equal(await main({argv: ['node', 'x', '--since', SINCE], print: text => printed.push(text), openBinding}), 0);
  const report = JSON.parse(printed.at(-1));
  assert.deepEqual([report.mode, report.sideEffects, report.producerWritesSince.films], ['status', 'none', 4]);
  assert.equal(await main({argv: ['node', 'x', '--baseline'], print: text => printed.push(text), openBinding}), 0);
  assert.equal(JSON.parse(printed.at(-1)).acceptance, null, 'a baseline states no acceptance');
  // The production read-only binding, over a REST stand-in: a SELECT reaches the API; a write or a non-SELECT read is refused BEFORE any request.
  const {openReadOnlyBinding} = await import(pathToFileURL(path.resolve('scripts/letterboxd-claim-producer-status.mjs')).href);
  const {PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, PRODUCTION_DATABASE_NAME} = await import(pathToFileURL(path.resolve('scripts/published-epg-production.mjs')).href);
  const sent = [];
  const rest = async (url, init = {}) => {
    sent.push({url: String(url), method: init.method || 'GET', body: init.body || null});
    if ((init.method || 'GET') === 'GET') return {status: 200, ok: true, json: async () => ({success: true, result: {uuid: PRODUCTION_DATABASE_ID, name: PRODUCTION_DATABASE_NAME}})};
    return {status: 200, ok: true, json: async () => ({success: true, result: [{success: true, results: [{c: 1}], meta: {rows_written: 0}}]})};
  };
  const ro = await openReadOnlyBinding({D1_BACKFILL_ACCOUNT_ID: PRODUCTION_ACCOUNT_ID, D1_BACKFILL_API_TOKEN: 'synthetic-token'}, rest);
  const reads = sent.length;
  assert.deepEqual(await ro.prepare('SELECT 1 AS c').bind().first(), {c: 1}); assert.equal(sent.length, reads + 1, 'a SELECT is sent');
  for (const sql of ["UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1", "DELETE FROM film_external_id", "SELECT 1; DELETE FROM film"]) {
    await assert.rejects(() => ro.prepare(sql).bind().first(), error => error.reason === 'write_refused', sql);
    await assert.rejects(() => ro.prepare(sql).bind().run(), error => error.reason === 'write_refused', sql);
  }
  await assert.rejects(() => ro.batch([ro.prepare("INSERT INTO film_alias (film_id,kind,value) VALUES ('a','b','c')").bind()]), error => error.reason === 'write_refused');
  assert.equal(sent.length, reads + 1, 'no refused statement reached the API');
  const source = fs.readFileSync('scripts/letterboxd-claim-producer-status.mjs', 'utf8');
  assert.ok(!/putOwned|casOwned|mutateFilm|applyLetterboxdClaim|ensureLetterboxdClaims|\.run\(/.test(source), 'the status tool has no write call');
  assert.ok(/run:refuse,executeRendered:refuse/.test(source), 'the production binding refuses every write before a request');
}

// (I) Interruption points of the bridge-to-claim handoff (review of PR #966), with the gate on and real D1. A verified pair must never end with neither a claim
// nor a durable retry entry, and the ordinary next step (off page, no source request) must finish it.
const identityWrites = statements => statements.some(item => String(item.text).includes("'letterboxd/facts/scans/diary-identity.json'") && /INSERT|DELETE/i.test(String(item.text)));
const settle = async () => {await new Promise(resolve => setTimeout(resolve, 50));};
// (I1) killed after the handoff and before the claim: the durable claim_pending entry for the exact pair is there, no claim; the next ordinary step claims it.
{
  createFilm('910011');
  await Facts.applyDiaryEvidence(env, [{lid: 'Ri1', watchedDate: '2026-11-23', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:11'}]);
  page('Ri1', 'rehearsal-i1-2011', '910011', 'Rehearsal I1', 2011);
  claimMode.calls = 0; claimMode.hang = true;
  const killed = Identity.resolve(env, [{lid: 'Ri1', slug: 'rehearsal-i1-2011'}], opts());
  for (let i = 0; i < 200 && claimMode.calls === 0; i++) await settle();
  claimMode.hang = false; void killed; // the step never returns: the process is gone
  const entry = await pending('Ri1');
  assert.deepEqual([entry?.reason, entry?.tmdb, entry?.attempts], ['claim_pending', '910011', 0], 'the handoff entry is durable before the claim');
  assert.deepEqual(claimOf('Ri1'), []);
  const next = await Identity.resolve(env, [], opts(NOW + 60000));
  assert.equal(next.counts.claim, 'complete', 'the off-page pending entry is served at once');
  assert.equal(claimOf('Ri1').length, 1); assert.equal(await pending('Ri1'), undefined);
}
// (I2) the handoff write itself is lost AND the step is killed before the claim: the `linking` intent survives with the exact movie, the alias and record committed;
// the next ordinary step repairs the projection and hands the pair off to the claim (it is this step's own verified intent, not an index-only link).
{
  createFilm('910012');
  await Facts.applyDiaryEvidence(env, [{lid: 'Ri2', watchedDate: '2026-11-23', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:12'}]);
  page('Ri2', 'rehearsal-i2-2012', '910012', 'Rehearsal I2', 2012);
  let writes = 0;
  fault = statements => {if (identityWrites(statements) && ++writes === 3) throw new Error('D1_ERROR: handoff write lost');};
  claimMode.calls = 0; claimMode.hang = true;
  const killed = Identity.resolve(env, [{lid: 'Ri2', slug: 'rehearsal-i2-2012'}], opts());
  for (let i = 0; i < 200 && claimMode.calls === 0; i++) await settle();
  claimMode.hang = false; fault = null; void killed;
  const entry = await pending('Ri2');
  assert.deepEqual([entry?.reason, entry?.tmdb], ['linking', '910012'], 'the link intent survived the lost handoff write');
  assert.deepEqual(claimOf('Ri2'), []);
  const next = await Identity.resolve(env, [], opts(NOW + 6 * 60000)); // after the cut-off step's check reservation expired
  assert.equal(next.counts.repaired, 1); assert.equal(next.counts.claim, 'complete');
  assert.equal(claimOf('Ri2').length, 1); assert.equal(await pending('Ri2'), undefined);
}
// (I3) the claim is written but the final pending write that clears the entry is lost: the entry stays (attempts 0, due), the next step proves `already` and clears it.
{
  createFilm('910013');
  await Facts.applyDiaryEvidence(env, [{lid: 'Ri3', watchedDate: '2026-11-23', rating: 5, ratingState: 'rated', sourceRef: 'diary:viewing:13'}]);
  page('Ri3', 'rehearsal-i3-2013', '910013', 'Rehearsal I3', 2013);
  let writes = 0;
  fault = statements => {if (identityWrites(statements) && ++writes === 4) throw new Error('D1_ERROR: final pending write lost');};
  const out = await Identity.resolve(env, [{lid: 'Ri3', slug: 'rehearsal-i3-2013'}], opts());
  fault = null;
  assert.equal(out.counts.persistFailed, 1); assert.equal(claimOf('Ri3').length, 1, 'the claim was written');
  assert.equal((await pending('Ri3'))?.reason, 'claim_pending', 'the entry survived the lost write');
  const receiptsBefore = receipts().length;
  const next = await Identity.resolve(env, [], opts(NOW + 60000));
  assert.equal(next.counts.claim, 'complete'); assert.equal(await pending('Ri3'), undefined);
  assert.equal(receipts().length, receiptsBefore, 'the repeat writes no second receipt (already)');
}
// (I4) a link intent for ANOTHER movie than the link now names (the link was made by another flow) is repaired and cleared, never handed off or claimed.
{
  createFilm('910014');
  await Facts.applyDiaryEvidence(env, [{lid: 'Ri4', watchedDate: '2026-11-23', rating: 2, ratingState: 'rated', sourceRef: 'diary:viewing:14'}]);
  const key = await Facts.linkFilm(env, {letterboxd: 'Ri4', tmdb: '910014'});
  await Facts.recordObservations(env, key, {letterboxd: 'Ri4', tmdb: '910014'}, []);
  await Facts.updateDiaryIdentity(env, {set: {Ri4: {reason: 'linking', slug: 'x', tmdb: '919999', attempts: 1, lastAttemptAt: new Date(NOW).toISOString(), nextAttemptAt: new Date(NOW).toISOString()}}});
  const out = await Identity.resolve(env, [], opts(NOW + 60000));
  assert.equal(out.counts.claim, undefined, 'a mismatched intent reaches no claim step');
  assert.deepEqual(claimOf('Ri4'), []); assert.equal(await pending('Ri4'), undefined);
}
// (I5) gate off (the shipped constant): a verified pair is linked as before, no claim, no receipt, no claim_pending entry, no handoff state.
{
  createFilm('910015');
  await Facts.applyDiaryEvidence(env, [{lid: 'Ri5', watchedDate: '2026-11-23', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:15'}]);
  page('Ri5', 'rehearsal-i5-2015', '910015', 'Rehearsal I5', 2015);
  claimMode.off = true;
  const receiptsBefore = receipts().length;
  const out = await Identity.resolve(env, [{lid: 'Ri5', slug: 'rehearsal-i5-2015'}], opts());
  claimMode.off = false;
  assert.equal(out.counts.verified, 1); assert.equal(out.counts.claim, undefined);
  assert.deepEqual(claimOf('Ri5'), []); assert.equal(receipts().length, receiptsBefore); assert.equal(await pending('Ri5'), undefined);
}

console.log('letterboxd claim activation rehearsal: ok');
