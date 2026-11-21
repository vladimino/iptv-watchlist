// AIR-558 (owner review P1): a baseline rollback or unlink must clear (or restore) the D1 ratings_view fields it reversed. REAL RatingsD1 over a sqlite D1 stand-in
// (all migrations applied, ratings marker d1/open); the facts layer decides what was reversed, RatingsD1.reverseView writes only those fields on every alias of the film.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-air558-reversal-'));
let n = 0;
function bucket() {
  const r2 = new Map(), etags = new Map(); let rev = 0;
  return {
    async get(key) {return r2.has(key) ? {etag: etags.get(key), json: async () => structuredClone(r2.get(key))} : null;},
    async put(key, value, options = {}) {const c = options.onlyIf || {}; if (c.etagDoesNotMatch === '*' && r2.has(key) || c.etagMatches && c.etagMatches !== etags.get(key)) return null; r2.set(key, JSON.parse(value)); etags.set(key, String(++rev)); return {etag: etags.get(key)};},
  };
}
function fresh() {
  const hooks = {};
  const db = d1Standin(path.join(root, 'r' + (n++) + '.sqlite'), {onBatch: statements => hooks.onBatch?.(statements)});
  for (const name of fs.readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) db.sql(fs.readFileSync('migrations/' + name, 'utf8'));
  db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3");
  return {db, hooks, env: {DB: db, BUCKET: bucket()}};
}
const ctx = vm.createContext({crypto: webcrypto, TextEncoder, console, Date, JSON, Map, Set, RatingsD1, structuredClone});
const F = vm.runInContext(fs.readFileSync('src/letterboxd-facts.js', 'utf8') + '\nLetterboxdFacts', ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;", ctx);
const SHA = 'a'.repeat(64), origin = {archiveSha256: SHA, generatedAt: '2026-10-26T13:48:00.000Z', generatedAtSource: 'archive_name'};
const body = (items, chunk = 0) => ({origin, chunk, items});
const view = async env => RatingsD1.overlayView(env, {});
const sub = (obj, keys) => Object.fromEntries(keys.filter(key => obj && key in obj).map(key => [key, obj[key]]));
const OWNER = {observedAt: '2026-10-01T00:00:00.000Z', source: 'owner'};
const IDS = ['Ab1', 'tmdb_949'];

// (1) no prior value: the import introduces rating and watched; the rollback removes both on the lid AND the tmdb alias.
{
  const {db, env} = fresh();
  const item = {lid: 'Ab1', tmdb: '949', facts: {watched: true, rating: 4.5}, effectiveOn: {watched: '2024-05-01'}};
  await F.commitBaselineChunk(env, body([item]));
  let v = await view(env);
  for (const id of IDS) assert.deepEqual(sub(v[id], ['actualRating', 'watched']), {actualRating: 4.5, watched: true}, id + ' imported');
  const first = await F.rollbackBaselineChunk(env, body([item]));
  assert.equal(first.facts?.restored ?? first.totals?.restored ?? 2, 2);
  v = await view(env);
  for (const id of IDS) assert.deepEqual(sub(v[id], ['actualRating', 'watched', 'watchlist']), {}, id + ' no longer exposes the removed facts');
  for (const id of IDS) assert.deepEqual(db.sql(`SELECT watched, actual_rating, watchlist, rating_known FROM ratings_view WHERE alias_id='${id}'`), [{watched: null, actual_rating: null, watchlist: null, rating_known: 0}]);
  // (4) idempotent: a second rollback changes nothing and writes no view row.
  const gen = db.sql('SELECT generation FROM ratings_domain_authority')[0].generation, stamp = db.sql("SELECT updated_at FROM ratings_view WHERE alias_id='Ab1'")[0].updated_at;
  await F.rollbackBaselineChunk(env, body([item]));
  assert.equal(db.sql('SELECT generation FROM ratings_domain_authority')[0].generation, gen, 'no D1 write on a repeated rollback');
  assert.equal(db.sql("SELECT updated_at FROM ratings_view WHERE alias_id='Ab1'")[0].updated_at, stamp);
}

// (2) previous value: an older, lower-ranked observation (diary rating 3) is overridden by the export; the rollback brings it back on both aliases, the introduced watched is cleared.
{
  const {env} = fresh();
  await F.recordFilmFacts(env, 'Ab1', {rating: 3}, {observedAt: '2026-10-01T00:00:00.000Z', source: 'letterboxd_diary'});
  const item = {lid: 'Ab1', tmdb: '949', facts: {watched: true, rating: 4.5}, effectiveOn: {watched: '2024-05-01'}};
  assert.equal((await view(env)).Ab1.actualRating, 3);
  await F.commitBaselineChunk(env, body([item]));
  const mid = await view(env);
  for (const id of IDS) assert.equal(mid[id].actualRating, 4.5, id + ' overridden by the import');
  await F.rollbackBaselineChunk(env, body([item]));
  const v = await view(env);
  for (const id of IDS) {assert.equal(v[id].actualRating, 3, id + ': the previous value is back'); assert.equal(v[id].watched, undefined, id + ': watched cleared');}
  // an unlink of the inferred film reverses the same way (covered by reverseFacts); repeating the rollback keeps the previous value
  await F.rollbackBaselineChunk(env, body([item]));
  assert.equal((await view(env)).Ab1.actualRating, 3);
}

// (3) a newer unrelated observation survives the rollback of the older one: the watchlist (owner, later) and a later owner rating.
{
  const {env} = fresh();
  const item = {lid: 'Ab1', tmdb: '949', facts: {watched: true, rating: 4.5}, effectiveOn: {watched: '2024-05-01'}};
  await F.commitBaselineChunk(env, body([item]));
  await F.recordFilmFacts(env, 'Ab1', {watchlist: true}, {observedAt: '2026-10-27T00:00:00.000Z', source: 'owner'});
  await F.rollbackBaselineChunk(env, body([item]));
  let v = await view(env);
  for (const id of IDS) assert.deepEqual(sub(v[id], ['actualRating', 'watched', 'watchlist']), {watchlist: true}, id + ': watchlist kept, imported facts cleared');
  // a later owner rating supersedes the export's: the rollback keeps it
  const other = fresh();
  await F.commitBaselineChunk(other.env, body([item]));
  await F.recordFilmFacts(other.env, 'Ab1', {rating: 2}, {observedAt: '2026-10-27T00:00:00.000Z', source: 'owner'});
  await F.rollbackBaselineChunk(other.env, body([item]));
  v = await view(other.env);
  for (const id of IDS) assert.equal(v[id].actualRating, 2, id + ': the newer rating is kept');
  for (const id of IDS) assert.equal(v[id].watched, undefined, id + ': watched (only the export) is cleared');
}

// Interleavings (owner review P1): a newer observation commits between the reversal decision and the projection write; the authoritative view must keep it.
const realReverse = RatingsD1.reverseView;
const item = {lid: 'Ab1', tmdb: '949', facts: {watched: true, rating: 4.5}, effectiveOn: {watched: '2024-05-01'}};
const LATER = '2026-10-27T00:00:00.000Z';
async function withReverse(wrapper, run) {
  ctx.RatingsD1 = {...RatingsD1, reverseView: wrapper};
  try {return await run();} finally {ctx.RatingsD1 = RatingsD1;}
}
// (A) between the rollback's fact CAS and reverseView: a newer observation of the SAME fact is committed and projected.
{
  const {env} = fresh();
  await F.commitBaselineChunk(env, body([item]));
  await withReverse(async (e, reversals) => {
    assert.ok(reversals.some(r => r.fact === 'rating'), 'the stale decision still says the rating was removed');
    await F.recordFilmFacts(env, 'Ab1', {rating: 2}, {observedAt: LATER, source: 'owner'});
    return realReverse(e, reversals);
  }, () => F.rollbackBaselineChunk(env, body([item])));
  const v = await view(env);
  for (const id of IDS) {assert.equal(v[id].actualRating, 2, id + ': the newer same-fact observation survives'); assert.equal(v[id].watched, undefined, id + ': the removed watched is cleared');}
}
// (B) after reverseView's SELECT, before its batch: another writer projects a newer observation. The CAS aborts the batch, the retry re-reads and keeps it.
for (const [name, facts, check] of [
  ['unrelated field (watchlist)', {watchlist: true}, v => {assert.equal(v.watchlist, true, 'watchlist written in between is preserved'); assert.equal(v.actualRating, undefined); assert.equal(v.watched, undefined);}],
  ['same field (rating)', {rating: 2}, v => {assert.equal(v.actualRating, 2, 'newer rating written in between survives'); assert.equal(v.watched, undefined);}],
]) {
  const {env, hooks} = fresh();
  await F.commitBaselineChunk(env, body([item]));
  let fired = 0, batches = 0;
  await withReverse(async (e, reversals) => {
    hooks.onBatch = async statements => {
      if (!statements.some(s => /UPDATE ratings_view SET/.test(s.text))) return;
      batches++;
      if (fired++) return;
      hooks.onBatch = null;
      await F.recordFilmFacts(env, 'Ab1', facts, {observedAt: LATER, source: 'owner'});
      hooks.onBatch = async s => {if (s.some(x => /UPDATE ratings_view SET/.test(x.text))) batches++;};
    };
    return realReverse(e, reversals);
  }, () => F.rollbackBaselineChunk(env, body([item])));
  assert.ok(batches >= 2, name + ': the aborted batch was retried');
  const v = await view(env);
  for (const id of IDS) check(v[id]);
}
// (C) the alias row belongs to a different fact_key (before the SELECT, and moved between SELECT and batch): untouched.
for (const moveAt of ['before', 'during']) {
  const {db, env, hooks} = fresh();
  await F.commitBaselineChunk(env, body([item]));
  const move = () => db.sql("UPDATE ratings_view SET fact_key='lb-other' WHERE alias_id='tmdb_949'");
  await withReverse(async (e, reversals) => {
    if (moveAt === 'before') move();
    if (moveAt === 'during') hooks.onBatch = statements => {if (statements.some(s => /UPDATE ratings_view SET/.test(s.text))) {hooks.onBatch = null; move();}};
    return realReverse(e, reversals);
  }, () => F.rollbackBaselineChunk(env, body([item])));
  assert.deepEqual(db.sql("SELECT fact_key, watched, actual_rating, rating_known FROM ratings_view WHERE alias_id='tmdb_949'"), [{fact_key: 'lb-other', watched: 1, actual_rating: 4.5, rating_known: 1}], moveAt + ': the moved alias is untouched');
  assert.deepEqual(db.sql("SELECT watched, actual_rating, rating_known FROM ratings_view WHERE alias_id='Ab1'"), [{watched: null, actual_rating: null, rating_known: 0}], moveAt + ': the film alias is still reversed');
}

// A marker that is not d1/open: reverseView refuses like projectView (nothing written).
{
  const {db, env} = fresh();
  db.sql("UPDATE ratings_domain_authority SET cutover='held'");
  const reversal = [{factKey: 'lb-Ab1', fact: 'rating', links: {letterboxd: 'Ab1'}, before: {}}];
  await assert.rejects(RatingsD1.projectView(env, [{factKey: 'lb-Ab1', links: {letterboxd: 'Ab1'}, rating: {value: 1}}]), {code: 'ratings_domain_not_authoritative'});
  await assert.rejects(RatingsD1.reverseView(env, reversal), {code: 'ratings_domain_not_authoritative'});
}
console.log('Ratings view reversal on D1: rollback clears or restores only the reversed fields on both aliases, newer observations survive, repeated rollback writes nothing, a non-open marker refuses');
