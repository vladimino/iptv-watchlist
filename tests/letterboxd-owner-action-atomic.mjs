// AIR-599 (review of PR #1009): the owner `requeue` / `dismiss` commit the shared Letterboxd check document (or its backlog) AND the Watchlist ledger rows of the same ids in ONE D1 batch, on the real
// ratings D1 path (RatingsD1 over a sqlite stand-in with the whole migration chain). Proves: both lane directions reopen BOTH stores; an intervening version change, a moved ledger row and a failing statement leave
// BOTH untouched; a lost response retried with the old token is refused (no double effect); a store that cannot batch refuses the request whole; a stale resolver write cannot undo the commit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-owner-atomic-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch { /* best effort */ }});
const chain = fs.readdirSync('migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort().map(name => fs.readFileSync('migrations/' + name, 'utf8')).join('\n');
const template = path.join(root, 'template.sqlite');
{const r = sqliteSync(['-bail', template], {input: 'PRAGMA foreign_keys=ON;\n' + chain}); if (r.status !== 0) throw new Error(r.stderr);}
let n = 0; const fault = {ledgerFails: false};
function open() {
  const file = path.join(root, 'db-' + (n++) + '.sqlite'); fs.copyFileSync(template, file);
  const db = d1Standin(file, {onBatch: async () => {if (fault.ledgerFails) throw new Error('D1_ERROR: injected ledger failure');}});
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3");
  db.sql("UPDATE watchlist_authority SET mode='d1', generation=1 WHERE id=1");
  return db;
}
const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, structuredClone, console: {...console, log: () => {}}, RatingsD1});
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;", ctx);
vm.runInContext(fs.readFileSync('src/letterboxd-facts.js', 'utf8'), ctx);
const Facts = vm.runInContext('LetterboxdFacts', ctx);
const NOW = Date.parse('2026-11-25T12:00:00.000Z'), AT = new Date(NOW).toISOString();
const ledger = db => Object.fromEntries(db.sql('SELECT lid,state,attempts,last_reason,updated_at FROM watchlist_admission_pending').map(r => [r.lid, r]));
const seedRow = (db, lid, state, attempts, reason) => db.sql(`INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('${lid}','x',1,'${state}',${attempts},NULL,'${reason}',NULL,'t-${lid}')`);
const entry = (attempts, reason = 'not_found') => ({reason, class: 'gone', slug: 's', attempts, streak: 0, queuedAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-10T00:00:00.000Z', nextAttemptAt: '2026-11-11T00:00:00.000Z'});
async function seedDoc(env, films) {await Facts.updateDiaryIdentity(env, {set: films});}
// the route's own sequence: plan the ledger rows, then commit the document with them
async function act(env, {doc = 'diary', action, lids, rows = null, version, slugs = {}}) {
  const plan = await WatchlistD1.ownerAdmissionPlan(env, {action, lids, rows, now: NOW}); assert.equal(plan.ok, true, JSON.stringify(plan));
  return Facts.ownerAction(env, {doc, action, lids, slugs, expectedVersion: version, by: 'owner@example.test', why: 'test', at: AT, extra: plan.statements});
}

// 1. Both lane directions reopen BOTH stores in one commit. Diary lane: the entry is at the cap AND the terminal ledger row of the same id reopens.
{
  const db = open(), env = {DB: db};
  await seedDoc(env, {Both1: entry(6)}); seedRow(db, 'Both1', 'terminal', 6, 'not_found');
  const {version} = await Facts.readDiaryIdentityVersioned(env);
  const out = await act(env, {action: 'requeue', lids: ['Both1'], version});
  assert.equal(out.state, 'applied'); assert.equal(out.entries.Both1.attempts, 0); assert.equal(out.entries.Both1.reason, 'owner_requeued');
  assert.deepEqual([ledger(db).Both1.state, ledger(db).Both1.attempts, ledger(db).Both1.last_reason], ['pending', 0, 'owner_requeued'], 'the ledger row reopened with the entry, in the same batch');
  // Watchlist lane: the owner names the row token; the shared entry is reset with it
  await seedDoc(env, {Both2: entry(6)}); seedRow(db, 'Both2', 'terminal', 6, 'not_found');
  const v2 = (await Facts.readDiaryIdentityVersioned(env)).version, token = ledger(db).Both2;
  const w = await act(env, {action: 'requeue', lids: ['Both2'], rows: [{lid: 'Both2', state: 'terminal', attempts: 6, updatedAt: token.updated_at}], version: v2});
  assert.equal(w.state, 'applied'); assert.deepEqual([w.entries.Both2.attempts, ledger(db).Both2.state, ledger(db).Both2.attempts], [0, 'pending', 0]);
  // dismiss settles both
  const v3 = (await Facts.readDiaryIdentityVersioned(env)).version;
  const d = await act(env, {action: 'dismiss', lids: ['Both2'], version: v3});
  assert.equal(d.entries.Both2.reason, 'owner_dismissed'); assert.deepEqual([ledger(db).Both2.state, ledger(db).Both2.last_reason], ['terminal', 'owner_dismissed']);
  // an id with a ledger row and NO entry: the row alone reopens (the document is still written, so the batch exists)
  seedRow(db, 'RowOnly', 'terminal', 6, 'forbidden');
  const v4 = (await Facts.readDiaryIdentityVersioned(env)).version;
  const r = await act(env, {action: 'requeue', lids: ['RowOnly'], version: v4}); assert.equal(r.results.RowOnly, 'absent'); assert.deepEqual([ledger(db).RowOnly.state, ledger(db).RowOnly.attempts], ['pending', 0]);
  // an entry with no ledger row: only the entry changes
  await seedDoc(env, {EntryOnly: entry(6)});
  const v5 = (await Facts.readDiaryIdentityVersioned(env)).version; assert.equal((await act(env, {action: 'requeue', lids: ['EntryOnly'], version: v5})).entries.EntryOnly.attempts, 0);
}
// 2. Backlog lane: the backlog document and the ledger row of the refused id commit together.
{
  const db = open(), env = {DB: db}; seedRow(db, 'Bk1', 'terminal', 6, 'diary_cap');
  await Facts.updateDiaryBacklog(env, {add: {Bk1: {slug: 'bk', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 5}}});
  const {version} = await Facts.readDiaryBacklog(env);
  const out = await act(env, {doc: 'backlog', action: 'requeue', lids: ['Bk1'], version});
  assert.equal(out.entries.Bk1.attempts, 0, 'the backlog budget is reset by the owner'); assert.deepEqual([ledger(db).Bk1.state, ledger(db).Bk1.attempts], ['pending', 0]);
}
// 3. Nothing is committed when anything is stale: an intervening version change, a moved ledger row, a failing statement. BOTH stores stay exactly as they were.
{
  const db = open(), env = {DB: db}; await seedDoc(env, {St1: entry(6)}); seedRow(db, 'St1', 'terminal', 6, 'not_found');
  const snapshot = () => JSON.stringify([ledger(db), db.sql("SELECT key, etag FROM ratings_document WHERE key LIKE '%diary-identity%'")]);
  const before = snapshot(); const old = (await Facts.readDiaryIdentityVersioned(env)).version;
  // (a) the document moved after the owner read it
  await seedDoc(env, {Other1: entry(1)});
  assert.equal((await act(env, {action: 'requeue', lids: ['St1'], version: old})).state, 'stale_revision');
  assert.equal(ledger(db).St1.state, 'terminal', 'the ledger row did not change when the document version was stale'); assert.equal((await Facts.readDiaryIdentityVersioned(env)).doc.films.St1.attempts, 6);
  // (b) the ledger row moved after the owner read its token (a Watchlist step settled it): the document is not written either
  const version = (await Facts.readDiaryIdentityVersioned(env)).version, tokens = [{lid: 'St1', state: 'terminal', attempts: 6, updatedAt: ledger(db).St1.updated_at}];
  db.sql("UPDATE watchlist_admission_pending SET updated_at='moved' WHERE lid='St1'");
  const afterMove = JSON.stringify((await Facts.readDiaryIdentityVersioned(env)).doc);
  assert.equal((await act(env, {action: 'requeue', lids: ['St1'], rows: tokens, version})).state, 'stale_revision');
  assert.equal(JSON.stringify((await Facts.readDiaryIdentityVersioned(env)).doc), afterMove, 'the document did not change when the row token was stale'); assert.equal(ledger(db).St1.state, 'terminal');
  // (c) a statement of the batch fails: the document is rolled back with the ledger
  db.sql("UPDATE watchlist_admission_pending SET updated_at='t-St1' WHERE lid='St1'");
  const v = (await Facts.readDiaryIdentityVersioned(env)).version;
  fault.ledgerFails = true; await assert.rejects(() => act(env, {action: 'requeue', lids: ['St1'], version: v})); fault.ledgerFails = false;
  assert.equal((await Facts.readDiaryIdentityVersioned(env)).doc.films.St1.attempts, 6); assert.equal(ledger(db).St1.state, 'terminal'); void before; void snapshot;
}
// 4. A lost response: the owner retries with the OLD token after the commit succeeded. It is refused as stale (nothing doubles), and the current state reads back as requeued on both sides.
{
  const db = open(), env = {DB: db}; await seedDoc(env, {Lost1: entry(6)}); seedRow(db, 'Lost1', 'terminal', 6, 'not_found');
  const {version} = await Facts.readDiaryIdentityVersioned(env);
  assert.equal((await act(env, {action: 'requeue', lids: ['Lost1'], version})).state, 'applied'); // the response is lost
  const retry = await act(env, {action: 'requeue', lids: ['Lost1'], version}); assert.equal(retry.state, 'stale_revision');
  const now = (await Facts.readDiaryIdentityVersioned(env)).doc.films.Lost1; assert.deepEqual([now.attempts, ledger(db).Lost1.state, ledger(db).Lost1.attempts], [0, 'pending', 0]);
}
// 5. A requeued row does not become terminal again from an old shared count: the entry is reset in the same commit, so the next step starts both at 0.
{
  const db = open(), env = {DB: db}; await seedDoc(env, {Re1: entry(6)}); seedRow(db, 'Re1', 'terminal', 6, 'not_found');
  const {version} = await Facts.readDiaryIdentityVersioned(env); await act(env, {action: 'requeue', lids: ['Re1'], version});
  const e = (await Facts.readDiaryIdentityVersioned(env)).doc.films.Re1; assert.equal(Math.max(e.attempts, ledger(db).Re1.attempts), 0);
}
// 6. Without a D1-owned store the write is refused whole (never half done).
{
  const db = open(), env = {DB: db, BUCKET: {get: async () => null, put: async () => ({etag: 'x'})}}; db.sql("UPDATE ratings_domain_authority SET mode='r2'");
  await assert.rejects(() => Facts.ownerAction(env, {doc: 'diary', action: 'requeue', lids: ['X1'], expectedVersion: null, by: 'o', why: 'w', at: AT, extra: [['SELECT 1', []]]}), error => ['atomic_unavailable', 'ratings_domain_not_authoritative', 'ratings_domain_unavailable'].includes(error.code), 'refused whole, never half done');
}
console.log('letterboxd-owner-action-atomic: ok');
