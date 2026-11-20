// Offline membership comparison for the view-index replacement: synthetic fixtures only, no production data and no network.
import assert from 'node:assert/strict';
import { compareMembership } from '../scripts/view-index-membership-parity.mjs';

const row = (alias_id, rating_known = 0, actual_rating = null) => ({ alias_id, rating_known, actual_rating });

// One id per category.
const result = compareMembership({
  raw: { both: {}, rawOnly: {}, rawSeed: {}, ratingsAlias: {}, fpOnlyInRaw: {} },
  predictionPointerIds: ['both', 'gainsForecast', 'ratingsForecast', 'fpOnlyInRaw'],
  predictionFingerprintIds: ['both', 'gainsForecast', 'fingerprintOnly'],
  ratingsRows: [row('both', 1, 4), row('ratingsAlias', 1, 3), row('ratingsOnly', 1, 2), row('ratingsForecast', 1, 5), row('seedNull', 1, null), row('seedWins', 1, 4.5), row('seedFillsRow', 0)],
  seed: { seedOnly: 4, rawSeed: 3, seedNull: 2, seedWins: 1, seedFillsRow: 5 },
});

assert.deepEqual(result.disappears, ['rawOnly'], 'a raw key with no D1 row and no seed id is the only key that disappears');
assert.deepEqual(result.gainsForecast, ['fingerprintOnly', 'gainsForecast', 'ratingsForecast'], 'a prediction or fingerprint id outside the raw object gains its forecast');
assert.deepEqual(result.addedKeys, ['fingerprintOnly', 'gainsForecast'], 'a forecast id that is already a ratings alias is not a new key');
assert.equal(result.onlyTheReportedDifferences, true, 'the two key sets differ only by the reported ids');

assert.equal(result.today.includes('rawOnly'), true);
assert.equal(result.union.includes('rawOnly'), false);
assert.equal(result.union.includes('rawSeed'), true, 'a raw key that is a seed id stays through the seed layer');
assert.equal(result.union.includes('seedOnly'), true, 'a seed-only id is a key in both models');
assert.equal(result.today.includes('ratingsOnly') && result.union.includes('ratingsOnly'), true, 'a ratings alias is a key in both models');

assert.deepEqual(result.seed.nullWins, ['seedNull'], 'a ratings_view own null wins over the seed');
assert.deepEqual(result.seed.ratingsWin, ['seedWins'], 'a ratings_view rating wins over the seed');
assert.deepEqual(result.seed.fills, ['rawSeed', 'seedFillsRow', 'seedOnly'], 'the seed fills only where there is no own rating');
assert.deepEqual(result.seed.onlyKeys, ['seedOnly'], 'a seed id that is neither a raw key nor a D1 row');

assert.deepEqual(result.counts, { raw: 5, prediction: 5, ratings: 7, seed: 5, today: 11, union: 12 }, 'today minus the one disappearing key equals the union minus its two added keys');

// Degenerate inputs: no raw object, no rows, an empty seed (the committed one).
const empty = compareMembership();
assert.deepEqual([empty.today, empty.union, empty.disappears, empty.gainsForecast, empty.addedKeys], [[], [], [], [], []]);
assert.equal(empty.onlyTheReportedDifferences, true);
const rawOnly = compareMembership({ raw: { a: {}, b: {} } });
assert.deepEqual(rawOnly.disappears, ['a', 'b'], 'with no D1 rows every raw key without facts disappears: the parity run must show this is empty or inert');
// Id spelling is not normalized: two spellings of one film are two ids, so an alias collision is visible instead of merged.
const alias = compareMembership({ raw: { tmdb_1: {}, L1: {} }, predictionPointerIds: ['tmdb_1'], ratingsRows: [row('L1', 1, 3)] });
assert.deepEqual([alias.disappears, alias.gainsForecast, alias.onlyTheReportedDifferences], [[], [], true]);
// The input is not mutated.
const raw = { a: {} }, rows = [row('a')];
compareMembership({ raw, ratingsRows: rows, seed: { z: 1 } });
assert.deepEqual([raw, rows], [{ a: {} }, [row('a')]]);

console.log('View index membership parity: only disappearing raw keys and forecast gains differ, seed precedence classified, empty seed inert passed');
