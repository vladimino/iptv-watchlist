// AIR-559: the one-record repair of a legacy inferred Letterboxd pair (scripts/letterboxd-inferred-pair-repair.mjs) on the sqlite3-CLI D1 stand-in with the full
// migration chain, the REAL RatingsD1 write path and the REAL claim planner. SYNTHETIC ids only; no network, no Worker, no R2.
// Covered: the read-only dry run and its pins; one apply that changes only the record's `inferredPairs` (one entry appended), bumps the ratings generation by
// one and leaves the link index, the view rows, the admission rows and the canonical claims byte-identical; idempotency (already marked); every refusal
// before the batch (missing GO, pins moved, malformed or full list, unreadable entry, record identity, changed pair, ambiguous or missing link, redirect,
// non-canonical text, a lid claim, a missing or other-archive admission); every guard INSIDE the batch (a racing generation bump, link-index change,
// record change, admission removal or lid claim rolls the whole batch back); an aborted batch and a lost response (`unknown`, never retried); the CLI refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {applyRepair, dryRun, inspectRepair, main, RepairStop, INFERRED_PAIRS_MAX} from '../scripts/letterboxd-inferred-pair-repair.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air559-repair-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch {/* best effort */}});
const sqlite = (file, text) => sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + text, encoding: 'utf8', maxBuffer: 1 << 26});
const rows = (file, text) => {const r = sqliteSync(['-json', '-bail', file], {input: text + ';', encoding: 'utf8'}); if (r.status !== 0) throw new Error(r.stderr); const o = r.stdout.trim(); return o ? JSON.parse(o) : [];};
const q = value => value == null ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'";
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
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

const LID = 'Syn1', TMDB = '7001', KEY = 'lb-Syn1', A = 'a'.repeat(64), B = 'b'.repeat(64), U = '2026-11-01T00:00:00.000Z';
const RECORD_KEY = 'letterboxd/facts/films/' + KEY + '.json', LINKS = 'letterboxd/facts/links.json';
const INPUT = {lid: LID, tmdb: TMDB, archive: A};
const putDoc = (file, key, value, {text = JSON.stringify(value)} = {}) => assert.equal(sqlite(file, 'DELETE FROM ratings_document WHERE key=' + q(key) + ';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (' + q(key) + ',0,' + q(text) + ",'" + sha(text) + "','" + U + "')").status, 0);
const getDoc = (file, key) => {const r = rows(file, 'SELECT body FROM ratings_document WHERE key=' + q(key) + ' ORDER BY part'); return r.length ? JSON.parse(r.map(x => x.body).join('')) : null;};
const baseRecord = (over = {}) => ({schemaVersion: 1, factKey: KEY, links: {letterboxd: LID, tmdb: TMDB}, redirectTo: null, migrating: null,
  watched: {value: true, effectiveOn: null, observedAt: '2026-11-08T15:00:00.000Z', source: 'letterboxd_export', sourceRef: A, observationId: 'o1'},
  rating: {value: 4, effectiveOn: null, observedAt: '2026-11-01T00:00:00.000Z', source: 'letterboxd_diary', sourceRef: 'diary:1', observationId: 'o2'}, ...over});
let n = 0;
// One provable legacy case: a Diary-first record stating the pair, the link index, the view rows, the canonical Film with its trusted tmdb claim and the admission row.
function setup({record = baseRecord(), links = {['letterboxd:' + LID]: KEY, ['tmdb:' + TMDB]: KEY}, admission = A, lidClaim = false, onBatch = null, afterBatch = null, text} = {}) {
  const file = path.join(root, 'r' + (n++) + '.sqlite');
  fs.copyFileSync(template, file);
  const film = 'film:tmdb:' + TMDB;
  assert.equal(sqlite(file, "INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('" + film + "',2,'tmdb:" + TMDB + "','Synthetic','" + U + "');"
    + "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('" + film + "','tmdb','" + TMDB + "',1,0,NULL);"
    + (lidClaim ? "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('" + film + "','letterboxd','" + LID + "',1,0,NULL);" : '')
    + (admission ? "INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('" + film + "','" + TMDB + "','" + LID + "','" + admission + "','Synthetic',2001,'tmdb_" + TMDB + "','tmdb_" + TMDB + "','2026-11-09T00:00:00.000Z','req-1','" + U + "');" : '')
    + "INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('" + LID + "','" + KEY + "',1,4,NULL,1,'" + U + "'),('tmdb_" + TMDB + "','" + KEY + "',1,4,NULL,1,'" + U + "');").status, 0);
  putDoc(file, LINKS, links);
  putDoc(file, RECORD_KEY, record, text ? {text} : {});
  const calls = {batches: 0, afterBatch: 0};
  // `afterBatch(file, text, n)` sees every statement that runs AFTER the (first) batch committed, in order: the place for a real post-commit race.
  const DB = d1Standin(file, {onBatch: async statements => {calls.batches++; if (onBatch) await onBatch(file, statements, calls.batches);},
    onQuery: async sqlText => {if (calls.batches > 0 && afterBatch) await afterBatch(file, sqlText, ++calls.afterBatch);}});
  return {file, env: {DB}, calls};
}
const TABLES = ['film', 'film_external_id', 'film_alias', 'film_rated_admission', 'ratings_view', 'ratings_document', 'ratings_domain_authority', 'canonical_write_receipt', 'canonical_revision'];
const dump = (file, except = []) => JSON.stringify(TABLES.filter(t => !except.includes(t)).map(t => [t, rows(file, 'SELECT * FROM ' + t + ' ORDER BY 1,2,3')]));
const generation = file => Number(rows(file, 'SELECT generation FROM ratings_domain_authority WHERE id=1')[0].generation);
const GO = pins => ({expected: pins, confirmGo: true, requestId: 'AIR559_repair_test_01'});

// 1. dry_run is read-only, names no identifier, and shows the exposure: today's planner would pass the pair.
{
  const {file, env, calls} = setup(), before = dump(file);
  const out = await dryRun(env, INPUT);
  assert.equal(out.decision, 'eligible'); assert.equal(out.sideEffects, 'none'); assert.equal(out.ratingsGeneration, 3);
  assert.deepEqual(Object.keys(out.expect).sort(), ['generation', 'linksEtag', 'planDigest', 'recordEtag']);
  assert.deepEqual(out.planner, {verdict: 'pass', reason: 'proved'}, 'precondition: the legacy pair is provable before the repair');
  assert.ok(!JSON.stringify(out).includes(LID) && !JSON.stringify(out).includes(TMDB) && !JSON.stringify(out).includes(KEY), 'the report carries no identifier');
  assert.equal(dump(file), before, 'dry_run writes nothing'); assert.equal(calls.batches, 0, 'dry_run sends no batch');
}

// 2. One apply: only the record's inferredPairs grows by exactly this entry, the generation moves by one, nothing else changes, and the planner now refuses.
{
  const {file, env, calls} = setup();
  const pins = (await dryRun(env, INPUT)).expect;
  const before = dump(file, ['ratings_document', 'ratings_domain_authority']), linksBefore = JSON.stringify(getDoc(file, LINKS)), recordBefore = getDoc(file, RECORD_KEY);
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.equal(out.outcome, 'applied', JSON.stringify(out)); assert.equal(out.writes, 1); assert.equal(calls.batches, 1, 'exactly one batch');
  assert.equal(out.readback.ok, true, JSON.stringify(out.readback)); assert.deepEqual(out.readback.planner, {verdict: 'not_proved', reason: 'ratings_link_inferred'});
  assert.equal(dump(file, ['ratings_document', 'ratings_domain_authority']), before, 'claims, admissions, view rows and Films are byte-identical');
  assert.equal(JSON.stringify(getDoc(file, LINKS)), linksBefore, 'the link index is unchanged');
  assert.equal(generation(file), 4, 'the ratings generation moved by exactly one');
  const after = getDoc(file, RECORD_KEY);
  const {inferredPairs, ...rest} = after;
  assert.deepEqual(rest, recordBefore, 'every other field of the record is unchanged (facts included)');
  assert.deepEqual(inferredPairs, [{kind: 'inferred', basis: 'original_title_exact_year_unique', sourceRef: A, letterboxd: LID, tmdb: TMDB}]);
  // 3. Idempotent: a second dry_run says already marked; a repeat apply with the old pins attempts nothing.
  const again = await dryRun(env, INPUT);
  assert.deepEqual([again.decision, again.reason], ['already_marked', 'pair_entry']);
  const snapshot = dump(file), repeat = await applyRepair(env, INPUT, GO(pins));
  assert.deepEqual([repeat.outcome, repeat.decision, repeat.writes], ['not_attempted', 'already_marked', 0]);
  assert.equal(dump(file), snapshot, 'a repeat writes nothing'); assert.equal(calls.batches, 1);
}

// An existing entry of ANOTHER pair (an earlier attempt) is kept and the new entry is appended after it.
{
  const prior = {kind: 'inferred', basis: 'original_title_exact_year_unique', sourceRef: B, letterboxd: LID, tmdb: '7999'};
  const {file, env} = setup({record: baseRecord({inferredPairs: [prior]})});
  const out = await applyRepair(env, INPUT, GO((await dryRun(env, INPUT)).expect));
  assert.equal(out.outcome, 'applied'); assert.equal(out.readback.ok, true, JSON.stringify(out.readback.checks));
  assert.deepEqual(getDoc(file, RECORD_KEY).inferredPairs.map(entry => entry.tmdb), ['7999', TMDB], 'append-only');
}

// 4. The GO gate and the pins, before any batch.
{
  const {file, env, calls} = setup(), before = dump(file);
  const pins = (await dryRun(env, INPUT)).expect;
  await assert.rejects(() => applyRepair(env, INPUT, {expected: pins, requestId: 'AIR559_repair_test_01'}), error => error instanceof RepairStop && error.reason === 'confirm_go_required');
  await assert.rejects(() => applyRepair(env, INPUT, {expected: pins, confirmGo: true, requestId: 'x'}), error => error.reason === 'invalid_request_id');
  await assert.rejects(() => applyRepair(env, INPUT, {expected: {...pins, planDigest: undefined}, confirmGo: true, requestId: 'AIR559_repair_test_01'}), error => error.reason === 'expected_pins_required');
  for (const [name, value] of [['generation', pins.generation + 1], ['recordEtag', 'c'.repeat(64)], ['linksEtag', 'd'.repeat(64)], ['planDigest', 'e'.repeat(64)]]) {
    const out = await applyRepair(env, INPUT, GO({...pins, [name]: value}));
    assert.deepEqual([out.outcome, out.reason, out.moved], ['not_attempted', 'pins_moved', [name]], name);
  }
  for (const bad of [{...INPUT, lid: 'tmdb_1'}, {...INPUT, lid: 'a b'}, {...INPUT, tmdb: '0'}, {...INPUT, archive: 'xyz'}])
    await assert.rejects(() => dryRun(env, bad), error => error instanceof RepairStop, JSON.stringify(bad));
  assert.equal(dump(file), before); assert.equal(calls.batches, 0, 'no refusal sends a batch');
}

// 5. Data refusals: every one is decided before the batch and writes nothing.
const refuses = async (name, options, expected) => {
  const {file, env, calls} = setup(options), before = dump(file);
  const out = await dryRun(env, INPUT);
  assert.deepEqual([out.decision, out.reason], expected, name);
  const applied = await applyRepair(env, INPUT, GO({generation: 3, recordEtag: 'c'.repeat(64), linksEtag: 'd'.repeat(64), planDigest: 'e'.repeat(64)}));
  assert.equal(applied.outcome, 'not_attempted', name); assert.equal(applied.writes, 0, name);
  assert.equal(dump(file), before, name + ': nothing written'); assert.equal(calls.batches, 0, name + ': no batch');
};
const full = Array.from({length: INFERRED_PAIRS_MAX}, (_, i) => ({kind: 'inferred', basis: 'b', sourceRef: B, letterboxd: LID, tmdb: String(8000 + i)}));
await refuses('malformed list', {record: baseRecord({inferredPairs: 'x'})}, ['refused', 'inferred_pairs_unreadable']);
await refuses('unreadable entry', {record: baseRecord({inferredPairs: [{kind: 'inferred'}]})}, ['refused', 'inferred_pairs_unreadable']);
await refuses('full list', {record: baseRecord({inferredPairs: full})}, ['refused', 'inferred_pairs_full']);
await refuses('already marked by the record identity', {record: baseRecord({identity: {kind: 'inferred', basis: 'b', sourceRef: A}})}, ['already_marked', 'record_identity']);
await refuses('already marked by an entry', {record: baseRecord({inferredPairs: [{kind: 'inferred', basis: 'b', sourceRef: A, letterboxd: LID, tmdb: TMDB}]})}, ['already_marked', 'pair_entry']);
await refuses('record states another movie', {record: baseRecord({links: {letterboxd: LID, tmdb: '7002'}})}, ['refused', 'record_states_other_pair']);
await refuses('lid not linked', {links: {['tmdb:' + TMDB]: KEY}}, ['refused', 'lid_not_linked']);
await refuses('movie linked elsewhere', {links: {['letterboxd:' + LID]: KEY, ['tmdb:' + TMDB]: 'tmdb-' + TMDB}}, ['refused', 'pair_not_linked']);
await refuses('ambiguous link', {links: {['letterboxd:' + LID]: KEY, ['tmdb:' + TMDB]: KEY, 'letterboxd:Other': KEY}}, ['refused', 'link_ambiguous']);
await refuses('record is a redirect', {record: baseRecord({redirectTo: 'tmdb-9'})}, ['refused', 'record_not_settled']);
await refuses('non-canonical stored text', {text: JSON.stringify(baseRecord(), null, 1)}, ['refused', 'record_not_canonical']);
await refuses('a canonical lid claim exists', {lidClaim: true}, ['refused', 'lid_claim_exists']);
await refuses('no admission row', {admission: null}, ['refused', 'admission_not_matched']);
await refuses('admission of another archive', {admission: B}, ['refused', 'admission_not_matched']);

// 6. Guards INSIDE the batch: a change between the preflight and the batch rolls the WHOLE batch back (the record, its etag and the generation stay as the racer left them).
const raced = async (name, change) => {
  let armed = false;
  const {file, env, calls} = setup({onBatch: async (db, _statements, count) => {if (armed && count === 1) change(db);}});
  const pins = (await dryRun(env, INPUT)).expect;
  armed = true;
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.deepEqual([out.outcome, out.writes], ['refused_in_batch', 0], name + ': ' + JSON.stringify(out));
  assert.equal(calls.batches, 1, name + ': one batch, no retry');
  assert.equal(getDoc(file, RECORD_KEY).inferredPairs, undefined, name + ': no entry written');
};
await raced('generation moved', db => assert.equal(sqlite(db, 'UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1').status, 0));
await raced('link index changed', db => putDoc(db, LINKS, {['letterboxd:' + LID]: KEY, ['tmdb:' + TMDB]: KEY, 'letterboxd:Late': 'lb-Late'}));
await raced('record changed by another writer', db => putDoc(db, RECORD_KEY, baseRecord({watchlist: {value: true, effectiveOn: null, observedAt: U, source: 'letterboxd_diary', sourceRef: null, observationId: 'o3'}})));
await raced('admission row removed', db => assert.equal(sqlite(db, 'DELETE FROM film_rated_admission').status, 0));
await raced('a lid claim appeared', db => assert.equal(sqlite(db, "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:" + TMDB + "','letterboxd','" + LID + "',1,0,NULL)").status, 0));

// 7. An aborted batch and a lost response are `unknown`; a committed batch whose own read-back throws is `committed_unverified`. One attempt, never retried, never reported as applied.
{
  // a statement of the batch fails with an error that is not a guard (the admission table vanished under the guard's SELECT): the transaction aborts, nothing of it remains
  let armed = false;
  const {file, env, calls} = setup({onBatch: async (db, _s, count) => {if (armed && count === 1) assert.equal(sqlite(db, 'DROP TABLE film_rated_admission').status, 0);}});
  const pins = (await dryRun(env, INPUT)).expect;
  armed = true;
  const before = rows(file, 'SELECT * FROM ratings_document WHERE key=' + q(RECORD_KEY));
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.equal(out.outcome, 'unknown', JSON.stringify(out)); assert.equal(out.writes, null); assert.equal(calls.batches, 1, 'never retried');
  assert.deepEqual(rows(file, 'SELECT * FROM ratings_document WHERE key=' + q(RECORD_KEY)), before, 'the aborted batch left the record unchanged');
  assert.equal(generation(file), 3, 'no generation bump from the aborted batch');
}
{
  // the batch commits but putOwned's own read-back throws (a racer planted a stray part row): a write happened, so the outcome is `committed_unverified` with writes 1
  let armed = false;
  const {file, env, calls} = setup({onBatch: async (db, _s, count) => {if (armed && count === 1) assert.equal(sqlite(db, 'INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (' + q(RECORD_KEY) + ",1,'x','other','" + U + "')").status, 0);}});
  const pins = (await dryRun(env, INPUT)).expect;
  armed = true;
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.deepEqual([out.outcome, out.writes], ['committed_unverified', 1], JSON.stringify(out)); assert.match(out.reason, /^putowned_readback_failed:/); assert.equal(calls.batches, 1, 'never retried');
  await assert.rejects(() => dryRun(env, INPUT), 'the next dry_run refuses an unreadable record instead of guessing');
  assert.equal(generation(file), 4, 'the batch did commit');
}
{
  let armed = false;
  const {file, env, calls} = setup({onBatch: async () => {if (armed) throw new Error('connection reset after send');}});
  const pins = (await dryRun(env, INPUT)).expect, before = dump(file);
  armed = true;
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.equal(out.outcome, 'unknown'); assert.match(out.next, /never repeat apply/); assert.equal(calls.batches, 1, 'a lost response is not retried');
  assert.equal(dump(file), before);
}

// 7b. Real post-commit races (review of #963): the batch COMMITS, then something changes before or during the readback. The answer is never `applied` and never
// zero writes: it is `committed_unverified`, with the failed check named, and nothing is retried.
const postCommit = async (name, afterBatch, check) => {
  const {file, env, calls} = setup({afterBatch});
  const pins = (await dryRun(env, INPUT)).expect;
  const out = await applyRepair(env, INPUT, GO(pins));
  assert.deepEqual([out.outcome, out.writes], ['committed_unverified', 1], name + ': ' + JSON.stringify(out));
  assert.equal(calls.batches, 1, name + ': one batch, no retry');
  check(out, file);
};
// A valid concurrent writer replaces the record right after our batch committed, before putOwned's own read-back: `saved:null` with `committed:true`, not a rollback.
await postCommit('record replaced before putOwned read-back', (db, sqlText, n) => {
  if (n === 1 && sqlText.includes('FROM ratings_document WHERE key=' + q(RECORD_KEY))) {
    const current = getDoc(db, RECORD_KEY);
    assert.ok(Array.isArray(current.inferredPairs), 'our batch had committed');
    putDoc(db, RECORD_KEY, {...current, watchlist: {value: true, effectiveOn: null, observedAt: U, source: 'letterboxd_diary', sourceRef: null, observationId: 'o9'}});
  }
}, out => assert.equal(out.reason, 'record_replaced_after_commit'));
let seen = 0;
await postCommit('generation moved before the readback', (db, sqlText) => {
  if (sqlText.includes('schema_contract') && ++seen === 1) assert.equal(sqlite(db, 'UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1').status, 0);
}, out => {assert.equal(out.reason, 'readback_check_failed'); assert.equal(out.readback.checks.generationPlusOne, false);});
await postCommit('view row changed before the readback', (db, sqlText) => {
  if (sqlText.includes('FROM ratings_view WHERE alias_id=')) assert.equal(sqlite(db, "UPDATE ratings_view SET watched=0 WHERE alias_id='" + LID + "'").status, 0);
}, out => assert.equal(out.readback.checks.viewUnchanged, false));
await postCommit('planner cannot confirm (Film/Person held after the commit)', (db, sqlText) => {
  if (sqlText.includes('film_person_authority')) assert.equal(sqlite(db, "UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status, 0);
}, out => {assert.equal(out.readback.checks.plannerRefuses, false); assert.equal(out.readback.planner.verdict, 'error');});
let reads = 0;
await postCommit('readback throws', (db, sqlText) => {
  if (sqlText.includes('FROM ratings_document WHERE key=' + q(RECORD_KEY)) && ++reads === 2) assert.equal(sqlite(db, 'INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (' + q(RECORD_KEY) + ",1,'x','other','" + U + "')").status, 0);
}, out => assert.match(out.reason, /^readback_failed:/));

// 7c. The CLI keeps the outcome and the tracked write state on every path (a tracked binding over the stand-in models the production adapter's writeState).
{
  const tracked = env => {
    const ctx = {writeState: 'none'}, inner = env.DB;
    return {ctx, binding: {prepare: (...a) => inner.prepare(...a), async batch(statements) {ctx.writeState = 'unknown'; await inner.batch(statements); ctx.writeState = 'committed';}}};
  };
  const cli = async (env, extra) => {
    const printed = [];
    const code = await main({argv: ['node', 'x', '--lid', LID, '--tmdb', TMDB, '--archive', A, ...extra], env: {}, print: text => printed.push(text), openBinding: async () => tracked(env)});
    return {code, out: JSON.parse(printed.at(-1))};
  };
  const pinArgs = pins => ['--expected-generation', String(pins.generation), '--expected-record-etag', pins.recordEtag, '--expected-links-etag', pins.linksEtag, '--expected-plan-digest', pins.planDigest];
  const goArgs = pins => ['--apply', '--confirm-go', '--request-id', 'AIR559_repair_cli_01', ...pinArgs(pins)];
  {
    const {env} = setup();
    const dry = await cli(env, []);
    assert.equal(dry.code, 0); assert.equal(dry.out.decision, 'eligible');
    const applied = await cli(env, goArgs(dry.out.expect));
    assert.deepEqual([applied.code, applied.out.outcome, applied.out.writeState], [0, 'applied', 'committed']);
    const missing = await cli(env, ['--apply', '--request-id', 'AIR559_repair_cli_01', ...pinArgs(dry.out.expect)]);
    assert.deepEqual([missing.code, missing.out.error, missing.out.writeState], [2, 'confirm_go_required', 'none']);
  }
  {
    const {env} = setup({afterBatch: (db, sqlText, n) => {if (n === 1) putDoc(db, RECORD_KEY, {...getDoc(db, RECORD_KEY), watchlist: {value: true, effectiveOn: null, observedAt: U, source: 'letterboxd_diary', sourceRef: null, observationId: 'o9'}});}});
    const dry = await cli(env, []);
    const raced = await cli(env, goArgs(dry.out.expect));
    assert.deepEqual([raced.code, raced.out.outcome, raced.out.writes, raced.out.writeState], [4, 'committed_unverified', 1, 'committed']);
  }
  {
    let armed = false;
    const {env} = setup({onBatch: async () => {if (armed) throw new Error('connection reset after send');}});
    const dry = await cli(env, []);
    armed = true;
    const lost = await cli(env, goArgs(dry.out.expect));
    assert.deepEqual([lost.code, lost.out.outcome, lost.out.writeState], [5, 'unknown', 'unknown']);
  }
  {
    let armed = false;
    const {env} = setup({onBatch: async (db, _s, count) => {if (armed && count === 1) assert.equal(sqlite(db, 'UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1').status, 0);}});
    const dry = await cli(env, []);
    armed = true;
    const refused = await cli(env, goArgs(dry.out.expect));
    assert.deepEqual([refused.code, refused.out.outcome, refused.out.writes], [3, 'refused_in_batch', 0], 'a guard refusal is reported as no write whatever the transport state');
  }
}

// 8. The CLI: unknown options and invalid ids stop before any request; it never builds a production connection without valid input.
{
  const printed = [];
  let fetched = 0;
  const fetchImpl = async () => {fetched++; throw new Error('no network in tests');};
  const run = argv => main({argv: ['node', 'x', ...argv], env: {}, fetchImpl, print: text => printed.push(text)});
  assert.equal(await run(['--bogus']), 2); assert.equal(await run(['--lid', 'a b', '--tmdb', '1', '--archive', A]), 2); assert.equal(await run(['--lid', LID, '--tmdb', TMDB]), 2);
  assert.equal(await run(['--lid', LID, '--tmdb', TMDB, '--archive', A]), 2, 'missing credentials stop as configuration before any request');
  assert.ok(printed.at(-1).includes('"writeState":"none"'), 'a stop before any write says so');
  assert.equal(fetched, 0, 'no request was made');
  assert.ok(printed.every(text => !text.includes(LID)), 'errors carry no identifier');
}

// 9. Static boundaries: the existing RatingsD1 putOwned path only (no casOwned rebase), no R2 module, no generic writer.
{
  const source = fs.readFileSync('scripts/letterboxd-inferred-pair-repair.mjs', 'utf8');
  assert.ok(/putOwned\(env,recordKey\(result\.plan\.key\),expected\.recordEtag,result\.plan\.next,\{extra\}\)/.test(source), 'one putOwned call pinned to the record etag');
  assert.ok(!/casOwned\(|r2-s3-store|r2-snapshot-export|\.BUCKET\b/.test(source), 'no casOwned retry and no R2');
  assert.equal((source.match(/putOwned\(/g) || []).length, 1, 'exactly one write call site');
}

console.log('letterboxd inferred pair repair: ok');
