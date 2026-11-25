// AIR-599 (third review of PR #1009): the stale-seed interleaving on the REAL D1 path with the REAL resolver. A Watchlist step reads a due row (attempts 5), awaits its snapshot reads; an owner `requeue` atomically resets
// the entry (if any) and the row to 0; only then the resolver reads the new state but still holds the OLD seed (5). The reservation carries the row-token guard in its batch, so the stale seed is never installed: no check
// runs, the next ordinary step starts from 0 (one 404 = 1, not 6). Both a row with an entry and a row-only case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {admissionStep} from '../src/letterboxd-sync-admission.js';
import {d1Standin} from './d1-standin.mjs';
import {RESERVATION_SQL, DIARY_KEY, guardOf, splitRows} from './reservation-guard-fixture.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {scoped, scopedReplacing} from '../scripts/bundle-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-owner-race-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch { /* best effort */ }});
const chain = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort().map(name => fs.readFileSync('migrations/' + name, 'utf8')).join('\n');
const template = path.join(root, 'template.sqlite');
{const r = sqliteSync(['-bail', template], {input: 'PRAGMA foreign_keys=ON;\n' + chain}); if (r.status !== 0) throw new Error(r.stderr);}
let n = 0;
function open() {
  const file = path.join(root, 'db-' + (n++) + '.sqlite'); fs.copyFileSync(template, file);
  const db = d1Standin(file);
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3");
  db.sql("UPDATE watchlist_authority SET mode='d1', generation=1 WHERE id=1");
  return db;
}
const calls = [];
const headersOf = map => ({get: key => map[String(key).toLowerCase()] ?? null});
const bridgeState = {};
const fetchMock = async url => {calls.push(String(url)); return {status: 404, ok: false, headers: headersOf({}), async text() {return '';}};};
const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, console: {...console, log: () => {}}, RatingsD1, fetch: fetchMock,
  CanonicalCatalogReader: {catalogReaderGate: async () => ({mode: 'd1', state: 'open', generation: 2}), catalogFilmIdentityBridge: async (e, lid) => bridgeState[lid] || {state: 'absent'}, catalogTitlesFromD1: async () => ({})},
  CanonicalRatedAdmission: {applyRatedAdmissionRetention: async () => ({state: 'complete', applied: 1, failed: 0, unknown: 0, preflightFailed: 0, deferred: 0, refused: 0, units: [{kind: 'film_admission', state: 'applied'}]})}});
for (const file of ['src/domain/tmdb-tv-identity.js', 'src/sources.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
vm.runInContext(scoped('src/letterboxd-match.js', 'LetterboxdMatch') + '\n' + scopedReplacing('src/letterboxd-identity.js', 'LetterboxdIdentity', 'const normTitle=LetterboxdMatch.normTitle;\n') + '\n' + scoped('src/domain/letterboxd-rated-admission.js', 'LetterboxdRatedAdmission'), ctx);
for (const file of ['src/letterboxd-facts.js', 'src/letterboxd-rated-candidates.js', process.env.DIARY_IDENTITY_SRC || 'src/letterboxd-diary-identity.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;", ctx);
const Facts = vm.runInContext('LetterboxdFacts', ctx), Identity = vm.runInContext('LetterboxdDiaryIdentity', ctx);
const NOW = Date.parse('2026-11-25T12:00:00.000Z'), AT = new Date(NOW).toISOString();
const GUARD = ['INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok', []];
const ledger = db => Object.fromEntries(db.sql('SELECT lid,state,attempts,last_reason,updated_at FROM watchlist_admission_pending').map(r => [r.lid, r]));
const entryOf = lid => Facts.readDiaryIdentity({DB: currentDb}).then(doc => doc.films[lid]);
let currentDb = null;
async function ownerRequeue(env, lid, action = 'requeue', at = NOW) {
  const {version} = await Facts.readDiaryIdentityVersioned(env);
  const plan = await WatchlistD1.ownerAdmissionPlan(env, {action, lids: [lid], now: at}); assert.equal(plan.ok, true);
  const out = await Facts.ownerAction(env, {action, lids: [lid], expectedVersion: version, by: 'o', why: 'w', at: new Date(at).toISOString(), extra: plan.statements}); assert.equal(out.state, 'applied', JSON.stringify(out)); return out;
}
async function scenario({withEntry, slugless = false, fullCap = false}) {
  const db = open(), env = {DB: db}; currentDb = db; calls.length = 0;
  const lid = fullCap ? 'Fc1' : slugless ? 'Sl1' : withEntry ? 'Wi1' : 'Wo1';
  await Facts.applyDiaryEvidence(env, [{lid, watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:1'}]);
  const fillers = Array.from({length: 200}, (_, i) => 'Fill' + i);
  // a FULL document: 200 entries that may not be evicted, so the row-only id has no place and its seed would go to the backlog
  if (fullCap) await Facts.updateDiaryIdentity(env, {set: Object.fromEntries(fillers.map(id => [id, {reason: 'not_found', class: 'gone', slug: 'f-' + id.toLowerCase(), attempts: 1, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2099-01-01T00:00:00.000Z'}]))});
  if (withEntry) await Facts.updateDiaryIdentity(env, {set: {[lid]: {reason: 'not_found', class: 'gone', slug: 'film-one', attempts: 5, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'}}});
  db.sql(`INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('${lid}','none',1,'pending',5,NULL,'not_found',NULL,'2026-11-24T00:00:00.000Z')`);
  let fired = false;
  // the owner requeue lands DURING the snapshot read of the due row (the step already holds attempts = 5 and its token)
  const repository = {...WatchlistD1,
    readSnapshot: async () => {if (!fired) {fired = true; await ownerRequeue(env, lid);} return {ok: false, reason: 'absent'};},
    currentMemberUrls: async () => ({ok: true, urls: slugless ? new Map() : new Map([[lid, 'https://letterboxd.com/film/film-one/']])})};
  const identity = {MAX_ATTEMPTS: Identity.MAX_ATTEMPTS, resolve: (e, items, opts) => Identity.resolve(e, items, opts), diaryLinks: (e, lids) => Facts.diaryLinks(e, lids)};
  const step = (at) => admissionStep({repository, identity, epochGuard: () => GUARD})({env, epoch: 1, now: () => at, deadline: at + 600000}, {limit: 3, now: at});
  const first = await step(NOW);
  assert.equal(calls.length, 0, 'the stale seed reached no source check');
  assert.equal(first.counts.entryChanged >= 1 || first.counts.rowChanged >= 1 || first.counts.notNow >= 1, true, JSON.stringify(first.counts));
  assert.deepEqual([ledger(db)[lid].state, ledger(db)[lid].attempts, ledger(db)[lid].last_reason], ['pending', 0, 'owner_requeued'], 'the row keeps the owner requeue');
  const entry = await entryOf(lid); assert.ok(!entry || entry.attempts === 0, 'no entry carries the stale budget: ' + JSON.stringify(entry));
  if (fullCap) {
    const backlog = (await Facts.readDiaryIdentity(env)).backlog || {};
    assert.ok(!backlog[lid] || backlog[lid].attempts === 0, 'no backlog record carries the stale budget: ' + JSON.stringify(backlog[lid]));
    // a place returns; the next ordinary check charges from ZERO (one 404 = 1, not 6)
    await Facts.updateDiaryIdentity(env, {clear: ['Fill0']});
  }
  // the next ordinary step starts from the NEW budget: one 404 is one attempt, not six
  const later = NOW + 60000;
  const second = await step(later);
  assert.equal(calls.filter(url => url.includes('boxd.it')).length, slugless ? 0 : 1, slugless ? 'no source request without a slug' : 'one real check'); void second;
  assert.deepEqual([ledger(db)[lid].state, ledger(db)[lid].attempts], ['pending', 1], 'the new budget is not restored to five or six');
  assert.equal((await entryOf(lid)).attempts, 1);
}
await scenario({withEntry: true});
await scenario({withEntry: false});
// a non-source outcome (no slug anywhere) also applies the seed: its write carries the row-token guard too
await scenario({withEntry: false, slugless: true});
// a full document: the stale seed would be written to the BACKLOG (no entry slot); that write carries the row-token guard too
await scenario({withEntry: false, fullCap: true});
// Isolation: two due rows in ONE step; an owner requeue of the first lands during the snapshot read. The stale id is refused (`entry_changed`) but the OTHER id's answered check keeps its charge.
async function pair() {
  const db = open(), env = {DB: db}; currentDb = db; calls.length = 0;
  const A = 'Pa1', B = 'Pb1';
  await Facts.applyDiaryEvidence(env, [A, B].map((lid, i) => ({lid, watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:' + i})));
  for (const lid of [A, B]) db.sql(`INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('${lid}','none',1,'pending',2,NULL,'not_found',NULL,'2026-11-24T00:00:00.000Z')`);
  // A has no slug anywhere (a non-source outcome that applies A's seed in the FINAL write); B is checked at the source, and the owner requeue of A lands during B's request.
  let fired = false; const base = ctx.fetch;
  ctx.fetch = async (...args) => {if (!fired) {fired = true; await ownerRequeue(env, A);} return base(...args);};
  const repository = {...WatchlistD1,
    readSnapshot: async () => ({ok: false, reason: 'absent'}),
    currentMemberUrls: async () => ({ok: true, urls: new Map([[B, 'https://letterboxd.com/film/film-b/']])})};
  const identity = {MAX_ATTEMPTS: Identity.MAX_ATTEMPTS, resolve: (e, items, opts) => Identity.resolve(e, items, opts), diaryLinks: (e, lids) => Facts.diaryLinks(e, lids)};
  await admissionStep({repository, identity, epochGuard: () => GUARD})({env, epoch: 1, now: () => NOW, deadline: NOW + 600000}, {limit: 3, now: NOW});
  assert.equal((await entryOf(B))?.attempts, 3, 'the other id keeps its answered check (2 + 1)');
  assert.equal(ledger(db)[B].attempts, 3, 'and its ledger row');
  assert.deepEqual([ledger(db)[A].attempts, ledger(db)[A].last_reason], [0, 'owner_requeued'], 'the stale id keeps the owner requeue');
  const ea = await entryOf(A); assert.ok(!ea || ea.attempts === 0, 'no stale budget on the stale id: ' + JSON.stringify(ea));
}
await pair(); ctx.fetch = fetchMock;
// Fifth review: an effect PAUSED across the expiry of its reservation. The trusted bridge returns, the reservation is taken and the intent written; the step stalls past expiry; the owner dismisses the id (an expired
// reservation is no longer in flight); the stalled step then resumes its link. The link is refused AT COMMIT (the batch asserts the reservation), so no alias is written for the dismissed id.
async function paused(kind = 'bridge') {
  const db = open(), env = {DB: db}; currentDb = db;
  const lid = kind === 'bridge' ? 'Pz1' : 'Pz2', tmdb = kind === 'bridge' ? '900555' : '900556';
  await Facts.applyDiaryEvidence(env, [{lid, watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:9'}]);
  if (kind === 'bridge') bridgeState[lid] = {state: 'ok', tmdb, filmId: 'film:tmdb:' + tmdb, lid};
  // a `link_failed` entry: a confirmed admission whose alias/record link did not commit; completed locally, under its own reservation
  else await Facts.updateDiaryIdentity(env, {set: {[lid]: {reason: 'link_failed', class: 'intent', slug: 'film-z', tmdb, attempts: 0, streak: 0, queuedAt: AT, lastAttemptAt: AT, nextAttemptAt: AT, route: 'ratings_diary'}}});
  const original = Facts.bridgeDiaryFilm; let dismissed = false;
  Facts.bridgeDiaryFilm = async (e, args) => {if (!dismissed) {dismissed = true; await ownerRequeue(env, lid, 'dismiss', NOW + 6 * 60000);} return original(e, args);};
  try {await Identity.resolve(env, kind === 'bridge' ? [{lid, slug: 'film-z'}] : [], {clock: () => NOW, remaining: () => 120000, route: 'ratings_diary'});}
  finally {Facts.bridgeDiaryFilm = original; delete bridgeState[lid];}
  assert.equal(dismissed, true, 'the link was attempted');
  const links = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value || {};
  assert.equal(links['tmdb:' + tmdb], undefined, 'no TMDB alias is written for the dismissed id: ' + JSON.stringify(links));
  assert.equal((await entryOf(lid)).reason, 'owner_dismissed', 'the owner dismissal stands');
}
await paused();
await paused('link_failed');
// Sixth review: the reservation fence on the REAL D1 path when the reservation text is cut by the 60,000-byte part boundary of the stored check document. A live reservation permits the Ratings link; a replaced or removed
// reservation refuses it. The contract text is pinned to the one the canonical writer is tested with (canonical-rated-admission-producer).
{
  const built = Facts.reservationGuard('c-live-0001');
  assert.deepEqual(JSON.parse(JSON.stringify(built)), guardOf('c-live-0001'), 'one fence contract'); assert.equal(built.sql, RESERVATION_SQL);
  assert.equal(Facts.reservationGuard('bad id'), null);
  const rows = (checkId, offset) => splitRows(checkId, offset, AT).map(([key, part, body, etag, at]) => `INSERT INTO ratings_document (key, part, body, etag, updated_at) VALUES ('${key}', ${part}, '${body}', '${etag}', '${at}');`).join('\n');
  const db = open(), env = {DB: db}; currentDb = db;
  for (const offset of [1, 20, 38]) {
    db.sql(`DELETE FROM ratings_document WHERE key='${DIARY_KEY}'`); db.sql(rows('c-live-0001', offset));
    assert.equal(db.sql(`SELECT length(CAST(body AS BLOB)) AS n FROM ratings_document WHERE key='${DIARY_KEY}' AND part=0`)[0].n, 60000, 'the needle is cut at byte 60000');
    const lid = 'Bd' + offset, tmdb = String(900700 + offset);
    await Facts.applyDiaryEvidence(env, [{lid, watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:' + offset}]);
    // another holder: refused
    await assert.rejects(() => Facts.bridgeDiaryFilm({...env, effectGuard: guardOf('c-gone-0002')}, {lid, tmdb}), error => error.code === 'write_contention');
    assert.equal(((await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value || {})['tmdb:' + tmdb], undefined, 'a foreign reservation links nothing');
    // the live reservation (cut by the boundary): permitted
    const linked = await Facts.bridgeDiaryFilm({...env, effectGuard: guardOf('c-live-0001')}, {lid, tmdb});
    assert.equal(linked.state, 'linked', 'a live reservation across the boundary permits the link (offset ' + offset + ')');
  }
  // removed: refused
  db.sql(`DELETE FROM ratings_document WHERE key='${DIARY_KEY}'`);
  await Facts.applyDiaryEvidence(env, [{lid: 'Bd99', watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:99'}]);
  await assert.rejects(() => Facts.bridgeDiaryFilm({...env, effectGuard: guardOf('c-live-0001')}, {lid: 'Bd99', tmdb: '900799'}));
}
console.log('letterboxd-owner-race-d1: ok');
