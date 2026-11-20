// Offline membership comparison for the view-index replacement: synthetic fixtures only, no production data and no network.
// The typed field gains are grounded in the real PredictionD1.overlayedItem (picked from the source), not in the classifier's own rule.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { compareMembership } from '../scripts/view-index-membership-parity.mjs';

const row = (alias_id, rating_known = 0, actual_rating = null) => ({ alias_id, rating_known, actual_rating });

// ---- The real overlay, extracted from the source (the function has no dependencies).
const source = fs.readFileSync('src/prediction-d1.js', 'utf8');
const pick = name => { const start = source.indexOf('function ' + name + '('); assert(start >= 0, name); let depth = 0; for (let j = source.indexOf('{', start); j < source.length; j++) { if (source[j] === '{') depth++; if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1); } throw new Error(name); };
const ctx = vm.createContext({});
vm.runInContext(pick('overlayedItem') + ';globalThis.overlayedItem=overlayedItem;', ctx);
const moodFacet = (fingerprint, prediction) => ({ fromFingerprint: !!fingerprint, fromPrediction: !!prediction });
const realOverlay = (pointer, fingerprint) => ctx.overlayedItem(undefined, {
  features: fingerprint ? { fingerprintHash: 'h', plotMechanics: [], moodLabels: [], execution: {} } : undefined,
  display: pointer ? { rating: 4 } : undefined,
}, moodFacet);

// ---- One id per category.
const result = compareMembership({
  raw: { both: {}, rawOnly: {}, rawSeed: {}, ratingsAlias: {}, fpOnlyInRaw: {} },
  predictionPointerIds: ['both', 'forecastOnly', 'forecastBoth', 'ratingsForecast', 'fpOnlyInRaw'],
  predictionFingerprintIds: ['both', 'featuresOnly', 'forecastBoth', 'ratingsFeatures'],
  ratingsRows: [row('both', 1, 4), row('ratingsAlias', 1, 3), row('ratingsOnly', 1, 2), row('ratingsForecast', 1, 5), row('ratingsFeatures', 1, 1), row('seedNull', 1, null), row('seedWins', 1, 4.5), row('seedFillsRow', 0)],
  seed: { seedOnly: 4, rawSeed: 3, seedNull: 2, seedWins: 1, seedFillsRow: 5 },
});

assert.deepEqual(result.removedKeys, ['rawOnly'], 'a raw key with no D1 row and no seed id is the only key that disappears');
assert.deepEqual(result.newKeys, ['featuresOnly', 'forecastBoth', 'forecastOnly'], 'a prediction id that is not already a key through the raw object, a ratings alias or the seed');
assert.deepEqual(result.forecastGains, ['forecastBoth', 'forecastOnly', 'ratingsForecast'], 'only a prediction_pointer row outside the raw object gains a forecast');
assert.deepEqual(result.featureGains, ['featuresOnly', 'forecastBoth', 'ratingsFeatures'], 'only a prediction_fingerprint row outside the raw object gains the fingerprint, impact features and mood facet');
assert.deepEqual(result.forecastOnly, ['forecastOnly', 'ratingsForecast'], 'a pointer row without a fingerprint row');
assert.deepEqual(result.featuresOnly, ['featuresOnly', 'ratingsFeatures'], 'a fingerprint row without a pointer row: no forecast, a different visible change');
assert.deepEqual(result.forecastAndFeatures, ['forecastBoth'], 'both rows');
assert.equal(result.impacts.find(item => item.id === 'ratingsForecast').keyAlreadyToday, true, 'a ratings alias is already a key, so only its forecast is new');
assert.equal(result.impacts.find(item => item.id === 'forecastOnly').keyAlreadyToday, false);
assert.equal(result.impacts.some(item => ['both', 'fpOnlyInRaw'].includes(item.id)), false, 'a raw key keeps its overlay in both models: no gain');
assert.equal(result.forecastGains.includes('featuresOnly'), false, 'a fingerprint-only id is never a forecast gain');

assert.equal(result.union.includes('rawOnly'), false);
assert.equal(result.union.includes('rawSeed'), true, 'a raw key that is a seed id stays through the seed layer');
assert.equal(result.today.includes('seedOnly') && result.union.includes('seedOnly'), true, 'a seed-only id is a key in both models');
assert.equal(result.today.includes('ratingsOnly') && result.union.includes('ratingsOnly'), true, 'a ratings alias is a key in both models');

assert.deepEqual(result.seed.nullWins, ['seedNull'], 'a ratings_view own null wins over the seed');
assert.deepEqual(result.seed.ratingsWin, ['seedWins'], 'a ratings_view rating wins over the seed');
assert.deepEqual(result.seed.fills, ['rawSeed', 'seedFillsRow', 'seedOnly'], 'the seed fills only where there is no own rating');
assert.deepEqual(result.seed.onlyKeys, ['seedOnly'], 'a seed id that is neither a raw key nor a D1 row');
assert.deepEqual(result.counts, { raw: 5, pointer: 5, fingerprint: 4, ratings: 8, seed: 5, today: 12, union: 14 });

// ---- Exhaustive check over every combination of the five memberships of one id, against the REAL overlay and independent boolean formulas.
let combinations = 0;
for (let mask = 0; mask < 32; mask++) {
  const [inRaw, inPointer, inFingerprint, inRatings, inSeed] = [0, 1, 2, 3, 4].map(bit => !!(mask & (1 << bit)));
  const out = compareMembership({
    raw: inRaw ? { x: {} } : {},
    predictionPointerIds: inPointer ? ['x'] : [],
    predictionFingerprintIds: inFingerprint ? ['x'] : [],
    ratingsRows: inRatings ? [row('x', 1, 3)] : [],
    seed: inSeed ? { x: 1 } : {},
  });
  const label = JSON.stringify({ inRaw, inPointer, inFingerprint, inRatings, inSeed });
  const hasD1Prediction = inPointer || inFingerprint;

  // Key sets, from the definitions in the contract (not from the module).
  assert.equal(out.today.includes('x'), inRaw || inRatings || inSeed, 'today ' + label);
  assert.equal(out.union.includes('x'), hasD1Prediction || inRatings || inSeed, 'union ' + label);
  assert.equal(out.removedKeys.includes('x'), inRaw && !hasD1Prediction && !inRatings && !inSeed, 'removed ' + label);
  assert.equal(out.newKeys.includes('x'), hasD1Prediction && !inRaw && !inRatings && !inSeed, 'new key ' + label);
  // Every key difference is one of the two reported kinds and nothing else.
  const gained = out.union.includes('x') && !out.today.includes('x'), lost = out.today.includes('x') && !out.union.includes('x');
  assert.equal(gained, out.newKeys.includes('x'), 'a gained key is reported ' + label);
  assert.equal(lost, out.removedKeys.includes('x'), 'a lost key is reported ' + label);

  // Typed field gains against what the real overlay supplies for an id that is not a raw key.
  const item = realOverlay(inPointer, inFingerprint);
  const reported = out.impacts.find(entry => entry.id === 'x');
  if (inRaw || !hasD1Prediction) {
    assert.equal(reported, undefined, 'no typed gain ' + label);
  } else {
    assert.ok(reported, 'typed gain ' + label);
    assert.equal(reported.forecast, 'prediction' in item, 'forecast gain matches the real overlay ' + label);
    assert.equal(reported.features, 'fingerprint' in item && 'fingerprintHash' in item && 'impactFeatures' in item, 'feature gain matches the real overlay ' + label);
    assert.equal('moodFacet' in item, reported.forecast || reported.features, 'a mood facet appears with either row ' + label);
    assert.equal(reported.keyAlreadyToday, inRatings || inSeed, 'key already present ' + label);
  }
  combinations++;
}
assert.equal(combinations, 32);

// ---- Degenerate inputs: no raw object, no rows, an empty seed (the committed one).
const empty = compareMembership();
assert.deepEqual([empty.today, empty.union, empty.removedKeys, empty.newKeys, empty.impacts], [[], [], [], [], []]);
const rawOnly = compareMembership({ raw: { a: {}, b: {} } });
assert.deepEqual(rawOnly.removedKeys, ['a', 'b'], 'with no D1 rows every raw key without facts disappears: the parity run must show this is empty or inert');
// Id spelling is not normalized: two spellings of one film are two ids, so an alias collision is visible instead of merged.
const alias = compareMembership({ raw: { tmdb_1: {}, L1: {} }, predictionPointerIds: ['tmdb_1'], ratingsRows: [row('L1', 1, 3)] });
assert.deepEqual([alias.removedKeys, alias.newKeys, alias.impacts], [[], [], []]);
// The input is not mutated.
const raw = { a: {} }, rows = [row('a')];
compareMembership({ raw, ratingsRows: rows, seed: { z: 1 } });
assert.deepEqual([raw, rows], [{ a: {} }, [row('a')]]);

console.log('View index membership parity: pointer forecasts and fingerprint features typed against the real overlay, 32 combinations, seed precedence classified, empty seed inert passed');
