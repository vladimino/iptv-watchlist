// AIR-559 (ADR 0184 decision 2b, ADR 0104): END-TO-END provenance of an inferred Letterboxd-to-TMDB pair, from the REAL import writer to the REAL claim planner. LetterboxdFacts runs on the real
// RatingsD1 over a sqlite D1 stand-in with the full migration chain (Film/Person `d1`/`open`, ratings `d1`/`open`); the import receipts live in an in-memory R2 stub. SYNTHETIC ids only.
// Covered: (1) the reviewed gap: a Diary-first record that already holds facts and its lid gains an INFERRED TMDB id from `commitBaselineChunk` and the planner refuses it; (2) a fresh inferred record;
// (3) a tmdb-only record that gains an inferred lid; (4) a pair linked independently BEFORE the inferred import is preserved (still provable); (5) a VERIFIED import of a Diary-first record stays provable;
// (6) an import interrupted after the mark (alias or record batch lost), then another writer completing the record from the index and a replay of the chunk: never provable; (7) a replay of a committed
// inferred chunk changes nothing; (8) a later independent verification of the same pair does not relabel it (documented limit); (9) a legacy pair linked by the import before AIR-559 (no mark) is NOT
// detected by the planner (documented limit: the producers do not offer index-only pairs, the backfill needs the owner's decision); (10) an inferred attempt whose link conflicts leaves a mark naming
// its own pair only; (11) an earlier failed pair never stands in for a later pair of the same lid (append-only entries); (12) an unreadable or full provenance list refuses the link.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC = process.env.CLAIM_SRC ? path.resolve(process.env.CLAIM_SRC) : path.resolve('src');
const {planLetterboxdClaim} = await import(path.join(SRC, 'canonical-letterboxd-claim.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air559-prov-'));
process.on('exit', () => {try {fs.rmSync(root, {recursive: true, force: true});} catch {/* best effort */}});
const sqlite = (file, text) => sqliteSync(['-bail', file], {input: 'PRAGMA foreign_keys=ON;\n' + text, encoding: 'utf8', maxBuffer: 1 << 26});
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

const ctx = vm.createContext({URL, Date, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto: webcrypto, structuredClone, console: {...console, log: () => {}}, RatingsD1});
vm.runInContext(fs.readFileSync(path.join(SRC, 'letterboxd-facts.js'), 'utf8'), ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;", ctx);
const Facts = vm.runInContext('LetterboxdFacts', ctx);

let n = 0, fault = null;
function setup() {
  const file = path.join(root, 'p' + (n++) + '.sqlite');
  fs.copyFileSync(template, file);
  const r2 = new Map(), etags = new Map(); let rev = 0;
  const BUCKET = {
    async get(key) {return r2.has(key) ? {etag: etags.get(key), json: async () => structuredClone(r2.get(key))} : null;},
    async put(key, value, options = {}) {const c = options.onlyIf; if (c?.etagDoesNotMatch === '*' && r2.has(key) || c?.etagMatches && c.etagMatches !== etags.get(key)) return null; r2.set(key, JSON.parse(value)); etags.set(key, String(++rev)); return {etag: String(rev)};},
    async head(key) {return r2.has(key) ? {etag: etags.get(key)} : null;},
  };
  const DB = d1Standin(file, {onBatch: async statements => {
    const text = statements.map(item => item.text + ' ' + JSON.stringify(item.params || [])).join('\n');
    if (fault && fault(text)) {fault = null; throw new Error('D1_ERROR: injected batch loss');}
  }});
  const film = k => assert.equal(sqlite(file, "INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:" + k + "',2,'tmdb:" + k + "','Synthetic','2026-11-01T00:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:" + k + "','tmdb','" + k + "',1,0,NULL);").status, 0);
  return {env: {DB, BUCKET}, file, film};
}
const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const origin = sha => ({archiveSha256: sha, generatedAt: '2026-11-08T15:00:00.000Z', generatedAtSource: 'archive_name'});
const commit = (env, items, {sha = SHA, chunk = 0} = {}) => Facts.commitBaselineChunk(env, {origin: origin(sha), chunk, items});
const inferred = (lid, tmdb, extra = {}) => ({lid, tmdb, facts: {watched: true, rating: 3}, effectiveOn: {}, identity: 'inferred', ...extra});
const verified = (lid, tmdb) => ({lid, tmdb, facts: {watched: true}, effectiveOn: {}});
const diaryFirst = (env, lid) => Facts.applyDiaryEvidence(env, [{lid, watchedDate: '2026-11-01', rating: 4, ratingState: 'rated', sourceRef: 'diary:viewing:' + lid}]);
const plan = async (env, lid, tmdb) => {const out = await planLetterboxdClaim(env, {lid, tmdb}); return [out.verdict, out.reason];};
const record = async (env, lid) => {const links = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value || {}; const key = links['letterboxd:' + lid]; return key ? (await RatingsD1.readOwned(env, 'letterboxd/facts/films/' + key + '.json')).value : null;};

// 1. The reviewed gap. A Diary-first record (lid + rating, no TMDB id) gains an INFERRED TMDB id from the real import; before AIR-559 nothing marked the pair and the planner passed.
{
  const {env, film} = setup(); film('101');
  await diaryFirst(env, 'Df1');
  const before = await record(env, 'Df1');
  assert.ok(before.rating && before.links.letterboxd === 'Df1' && before.links.tmdb == null, 'precondition: facts and lid, no TMDB id');
  const out = await commit(env, [inferred('Df1', '101')]);
  assert.equal(out.conflicts, 0);
  const after = await record(env, 'Df1');
  assert.equal(after.links.tmdb, '101', 'the import linked the pair');
  assert.equal(after.identity, undefined, 'the record-level identity rule leaves a Diary-first record unlabelled (ADR 0104 unchanged)');
  assert.deepEqual((after.inferredPairs || []).map(({kind, letterboxd, tmdb}) => ({kind, letterboxd, tmdb})), [{kind: 'inferred', letterboxd: 'Df1', tmdb: '101'}], 'the pair is marked');
  assert.deepEqual(await plan(env, 'Df1', '101'), ['not_proved', 'ratings_link_inferred'], 'the planner refuses the inferred pair');
}

// 2. A fresh inferred record (the import creates it) and 3. a tmdb-only record that gains an inferred lid: both refused.
{
  const {env, film} = setup(); film('102'); film('103');
  await commit(env, [inferred('Fr2', '102')]);
  assert.deepEqual(await plan(env, 'Fr2', '102'), ['not_proved', 'ratings_link_inferred']);
  await Facts.recordOwnerWatchedMark(env, '103', true, {observedAt: '2026-11-02T00:00:00.000Z'});
  await commit(env, [inferred('Tm3', '103')], {chunk: 1});
  assert.equal((await record(env, 'Tm3')).links.tmdb, '103');
  assert.deepEqual(await plan(env, 'Tm3', '103'), ['not_proved', 'ratings_link_inferred']);
}

// 4. A pair linked independently BEFORE the inferred import (a Diary-first record later bridged to its verified movie) is preserved: the inferred import adds facts, not a mark.
{
  const {env, film} = setup(); film('104');
  await diaryFirst(env, 'Pv4');
  assert.equal((await Facts.bridgeDiaryFilm(env, {lid: 'Pv4', tmdb: '104'})).state, 'linked');
  assert.deepEqual(await plan(env, 'Pv4', '104'), ['pass', 'proved'], 'precondition: the verified pair is provable');
  await commit(env, [inferred('Pv4', '104')]);
  const after = await record(env, 'Pv4');
  assert.equal(after.inferredPairs, undefined); assert.equal(after.identity, undefined);
  assert.deepEqual(await plan(env, 'Pv4', '104'), ['pass', 'proved'], 'an independently linked pair stays provable');
}

// 5. A VERIFIED import item on a Diary-first record links the pair with no mark and stays provable.
{
  const {env, film} = setup(); film('105');
  await diaryFirst(env, 'Vf5');
  await commit(env, [verified('Vf5', '105')]);
  const after = await record(env, 'Vf5');
  assert.equal(after.links.tmdb, '105'); assert.equal(after.inferredPairs, undefined);
  assert.deepEqual(await plan(env, 'Vf5', '105'), ['pass', 'proved']);
}

// 6. Interrupted inferred import: the mark is durable BEFORE the alias, so a lost record batch, another writer completing the record's ids from the index, and a replay never make the pair provable.
for (const loss of ['record', 'alias']) {
  const {env, film} = setup(); film('106');
  await diaryFirst(env, 'Ir6');
  // lose the first batch that writes the fact record after the alias (`record`), or the alias batch itself (`alias`)
  let seenMark = false;
  fault = text => {
    if (!text.includes('letterboxd/facts/')) return false;
    if (!seenMark && text.includes('inferredPairs')) {seenMark = true; return false;}
    if (loss === 'alias') return seenMark && text.includes('letterboxd/facts/links.json');
    return seenMark && text.includes('letterboxd/facts/films/') && text.includes('"rating"') && text.includes('letterboxd_export');
  };
  await assert.rejects(() => commit(env, [inferred('Ir6', '106')]), loss + ': the commit fails');
  fault = null;
  const mid = await record(env, 'Ir6');
  assert.ok(mid.inferredPairs?.some(entry => entry.tmdb === '106'), loss + ': the mark survived the loss');
  assert.notDeepEqual((await plan(env, 'Ir6', '106'))[0], 'pass', loss + ': not provable mid-commit');
  // another writer completes the record from the index (the owner's watched mark resolves the movie alias); then the replay commits the chunk
  if (loss === 'record') {
    await Facts.recordOwnerWatchedMark(env, '106', false, {observedAt: '2026-11-03T00:00:00.000Z'});
    assert.equal((await record(env, 'Ir6')).links.tmdb, '106', 'the other writer filled the TMDB id from the index');
    assert.deepEqual(await plan(env, 'Ir6', '106'), ['not_proved', 'ratings_link_inferred'], 'still refused: the mark predates the alias');
  }
  const replay = await commit(env, [inferred('Ir6', '106')]);
  assert.equal(replay.replay, false, loss + ': the replay commits the chunk');
  assert.deepEqual(await plan(env, 'Ir6', '106'), ['not_proved', 'ratings_link_inferred'], loss + ': refused after the replay');
}

// 7. A replay of a committed inferred chunk changes nothing; 8. a later independent verification of the same pair does not relabel it (a documented limit: the claim then needs an owner decision).
{
  const {env, film} = setup(); film('107');
  await diaryFirst(env, 'Rp7');
  await commit(env, [inferred('Rp7', '107')]);
  const first = JSON.stringify(await record(env, 'Rp7'));
  const again = await commit(env, [inferred('Rp7', '107')]);
  assert.equal(again.replay, true); assert.equal(JSON.stringify(await record(env, 'Rp7')), first, 'a replay changes nothing');
  assert.equal((await Facts.bridgeDiaryFilm(env, {lid: 'Rp7', tmdb: '107'})).state, 'linked');
  await commit(env, [verified('Rp7', '107')], {sha: SHA2});
  assert.deepEqual(await plan(env, 'Rp7', '107'), ['not_proved', 'ratings_link_inferred'], 'a later verification does not lift the mark');
}

// 9. LEGACY: a pair the import linked before AIR-559 on a Diary-first record carries no mark and is NOT detected by the planner. Simulated by the pre-AIR-559 effect: the alias and the record's TMDB id,
// written by an export observation, with neither `identity` nor `inferredPairs`. This is why the Diary step offers only pairs it verified itself and why a backfill cohort needs the owner's decision.
{
  const {env, film} = setup(); film('109');
  await diaryFirst(env, 'Lg9');
  const key = await Facts.linkFilm(env, {letterboxd: 'Lg9', tmdb: '109'});
  await Facts.recordObservations(env, key, {letterboxd: 'Lg9', tmdb: '109'}, []);
  const legacy = await record(env, 'Lg9');
  assert.equal(legacy.inferredPairs, undefined); assert.equal(legacy.identity, undefined);
  assert.deepEqual(await plan(env, 'Lg9', '109'), ['pass', 'proved'], 'LIMIT: a legacy unmarked inferred pair is not distinguishable from a verified one');
}

// 10. An inferred attempt whose link conflicts (the movie already belongs to another lid) writes no alias; its mark names its own pair, so it never blocks another provable pair.
{
  const {env, film} = setup(); film('110');
  await diaryFirst(env, 'Ok10');
  assert.equal((await Facts.bridgeDiaryFilm(env, {lid: 'Ok10', tmdb: '110'})).state, 'linked');
  await diaryFirst(env, 'Cf10');
  const out = await commit(env, [inferred('Cf10', '110')]);
  assert.equal(out.conflicts, 1, 'the conflicting inferred link is refused');
  const links = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value;
  assert.equal(links['tmdb:110'], links['letterboxd:Ok10'], 'the movie stays with its verified lid');
  assert.deepEqual(await plan(env, 'Ok10', '110'), ['pass', 'proved'], 'the verified pair is not blocked');
  assert.deepEqual(await plan(env, 'Cf10', '110'), ['conflict', 'ratings_link_points_elsewhere']);
}

// 11. Review of 76072543: an earlier inferred pair A whose alias batch failed must not stand in for a later inferred pair B of the same lid. Each pair keeps its own append-only entry; B is refused too,
// A's entry is kept unchanged, the mark of B is read back before its alias, and a repeat of B is idempotent.
{
  const {env, film} = setup(); film('111'); film('112');
  await diaryFirst(env, 'Ab11');
  fault = text => text.includes('letterboxd/facts/links.json') && text.includes('tmdb:111');
  await assert.rejects(() => commit(env, [inferred('Ab11', '111')]), 'A: the alias batch is lost');
  fault = null;
  const afterA = await record(env, 'Ab11');
  assert.deepEqual(afterA.inferredPairs.map(entry => entry.tmdb), ['111'], 'A left its own entry');
  assert.equal(afterA.links.tmdb, null, 'A linked nothing');
  const outB = await commit(env, [inferred('Ab11', '112')], {sha: SHA2});
  assert.equal(outB.conflicts, 0, 'B links');
  const afterB = await record(env, 'Ab11');
  assert.equal(afterB.links.tmdb, '112');
  assert.deepEqual(afterB.inferredPairs.map(entry => entry.letterboxd + ':' + entry.tmdb + ':' + entry.sourceRef.slice(0, 1)), ['Ab11:111:a', 'Ab11:112:b'], 'B has its own entry; A is kept, not replaced');
  assert.deepEqual(await plan(env, 'Ab11', '112'), ['not_proved', 'ratings_link_inferred'], 'B is refused');
  const again = await commit(env, [inferred('Ab11', '112')], {sha: SHA2});
  assert.equal(again.replay, true);
  assert.equal((await record(env, 'Ab11')).inferredPairs.length, 2, 'a repeat adds no entry');
}

// 12. Fail closed at the write boundary: a record whose provenance list is unreadable, or full, is never linked to a new inferred pair (the item is a conflict, nothing aliased).
for (const bad of ['unreadable', 'full']) {
  const {env, film} = setup(); film('113');
  await diaryFirst(env, 'Fc12');
  const links = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value;
  const key = links['letterboxd:Fc12'], recKey = 'letterboxd/facts/films/' + key + '.json';
  const current = (await RatingsD1.readOwned(env, recKey));
  const value = {...current.value, inferredPairs: bad === 'unreadable' ? 'x' : Array.from({length: 8}, (_, i) => ({kind: 'inferred', basis: 'b', sourceRef: 'c'.repeat(64), letterboxd: 'Fc12', tmdb: String(900 + i)}))};
  await RatingsD1.putOwned(env, recKey, current.etag, value);
  const out = await commit(env, [inferred('Fc12', '113')]);
  assert.equal(out.conflicts, 1, bad + ': refused');
  assert.equal((await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value['tmdb:113'], undefined, bad + ': no alias');
}

// 13. Review of 26f28574 (hardening): a record that already states the pair but carries a malformed (non-array) provenance list is a typed conflict, not a TypeError.
{
  const {env, film} = setup(); film('114');
  await diaryFirst(env, 'Sh13');
  assert.equal((await Facts.bridgeDiaryFilm(env, {lid: 'Sh13', tmdb: '114'})).state, 'linked');
  const links = (await RatingsD1.readOwned(env, 'letterboxd/facts/links.json')).value;
  const recKey = 'letterboxd/facts/films/' + links['letterboxd:Sh13'] + '.json';
  const current = await RatingsD1.readOwned(env, recKey);
  await RatingsD1.putOwned(env, recKey, current.etag, {...current.value, inferredPairs: 'x'});
  const out = await commit(env, [inferred('Sh13', '114')]);
  assert.equal(out.conflicts, 1, 'a malformed list on a record stating the pair is a conflict, not a crash');
}

console.log('letterboxd claim provenance (D1, end to end): ok');
