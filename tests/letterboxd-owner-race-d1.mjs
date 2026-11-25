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
const fetchMock = async url => {calls.push(String(url)); return {status: 404, ok: false, headers: headersOf({}), async text() {return '';}};};
const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, console: {...console, log: () => {}}, RatingsD1, fetch: fetchMock,
  CanonicalCatalogReader: {catalogReaderGate: async () => ({mode: 'd1', state: 'open', generation: 2}), catalogFilmIdentityBridge: async () => ({state: 'absent'}), catalogTitlesFromD1: async () => ({})},
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
async function ownerRequeue(env, lid) {
  const {version} = await Facts.readDiaryIdentityVersioned(env);
  const plan = await WatchlistD1.ownerAdmissionPlan(env, {action: 'requeue', lids: [lid], now: NOW}); assert.equal(plan.ok, true);
  const out = await Facts.ownerAction(env, {action: 'requeue', lids: [lid], expectedVersion: version, by: 'o', why: 'w', at: AT, extra: plan.statements}); assert.equal(out.state, 'applied', JSON.stringify(out)); return out;
}
async function scenario({withEntry, slugless = false}) {
  const db = open(), env = {DB: db}; currentDb = db; calls.length = 0;
  const lid = slugless ? 'Sl1' : withEntry ? 'Wi1' : 'Wo1';
  await Facts.applyDiaryEvidence(env, [{lid, watchedDate: '2026-11-17', rating: 3, ratingState: 'rated', sourceRef: 'diary:viewing:1'}]);
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
console.log('letterboxd-owner-race-d1: ok');
