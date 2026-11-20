// Offline membership comparison for the view-index replacement (pure functions, no I/O, never bundled into the Worker).
//
// Today a full view's key set is: raw view-index keys, plus every ratings_view alias (RatingsD1.overlayView adds them), plus the ids of the compiled
// ratings seed (applyRatingsSeed creates a key for a seed-only id). The prediction overlay changes only keys already in the raw object.
// The proposed replacement ("union") takes the key set from the D1 rows instead of the raw object: prediction_pointer, prediction_fingerprint and
// ratings_view film ids, plus the same seed layer applied afterwards.
//
// What the prediction overlay (PredictionD1.overlayedItem) supplies depends on WHICH table holds the row, so the two are never merged:
//   a prediction_pointer row     -> item.prediction (the forecast)
//   a prediction_fingerprint row -> item.fingerprint, item.fingerprintHash, item.impactFeatures
//   either of them               -> item.moodFacet (computed from the fingerprint or the prediction, whichever exists)
//
// The key sets differ in exactly these ways, each reported by id:
//   removedKeys   a raw key with no D1 row of any of the three kinds and not in the seed (an entry with no fact left after the overlays)
//   newKeys       a prediction id (pointer or fingerprint) that is not a raw key, not a ratings alias and not a seed id (the key itself is new)
// and, for an id that is NOT a raw key but has D1 prediction rows, the typed field gains:
//   forecastGains a pointer row exists: `prediction` and the forecast-derived mood appear (footer prediction coverage, queue freshness, Finds)
//   featureGains  a fingerprint row exists: `fingerprint`, `fingerprintHash`, `impactFeatures` and the mood facet appear (mood and mechanics filters)
// `impacts` lists those ids with both flags and whether the key already exists today through a ratings alias or the seed. Every other id keeps its key
// and its facts, because the field values come from the same overlays in both models.
//
// The inputs of a real comparison are an owner-approved read-only export of the raw object and the film ids of the three D1 tables; this module only
// classifies them. It is exercised with synthetic fixtures by tests/view-index-membership-parity.mjs.

const ids = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : []).map(String);
const sorted = set => [...set].sort();

export function compareMembership({ raw = null, predictionPointerIds = [], predictionFingerprintIds = [], ratingsRows = [], seed = {} } = {}) {
  const rawIds = new Set(ids(raw));
  const pointerIds = new Set(ids(predictionPointerIds));
  const fingerprintIds = new Set(ids(predictionFingerprintIds));
  const ratingsIds = new Set(ratingsRows.map(row => String(row.alias_id)));
  const seedIds = new Set(ids(seed));
  const predictionIds = new Set([...pointerIds, ...fingerprintIds]);
  const d1Ids = new Set([...predictionIds, ...ratingsIds]);

  const today = new Set([...rawIds, ...ratingsIds, ...seedIds]);
  const union = new Set([...d1Ids, ...seedIds]);

  const removedKeys = sorted([...rawIds].filter(id => !d1Ids.has(id) && !seedIds.has(id)));
  const newKeys = sorted([...predictionIds].filter(id => !today.has(id)));

  // Typed field gains: only an id that is not a raw key changes, because the prediction overlay never touched it.
  const impacts = sorted([...predictionIds].filter(id => !rawIds.has(id))).map(id => ({
    id,
    forecast: pointerIds.has(id),
    features: fingerprintIds.has(id),
    keyAlreadyToday: today.has(id),
  }));
  const forecastGains = impacts.filter(item => item.forecast).map(item => item.id);
  const featureGains = impacts.filter(item => item.features).map(item => item.id);
  const forecastOnly = impacts.filter(item => item.forecast && !item.features).map(item => item.id);
  const featuresOnly = impacts.filter(item => item.features && !item.forecast).map(item => item.id);
  const forecastAndFeatures = impacts.filter(item => item.forecast && item.features).map(item => item.id);

  // The seed rule on top of either key set: an own actualRating (a ratings_view row with rating_known=1, null included) wins; otherwise the seed fills it.
  const knownRating = new Map(ratingsRows.filter(row => Number(row.rating_known) === 1).map(row => [String(row.alias_id), row.actual_rating == null ? null : Number(row.actual_rating)]));
  const seedNullWins = sorted([...seedIds].filter(id => knownRating.has(id) && knownRating.get(id) === null));
  const seedRatingsWin = sorted([...seedIds].filter(id => knownRating.has(id) && knownRating.get(id) !== null));
  const seedFills = sorted([...seedIds].filter(id => !knownRating.has(id)));
  const seedOnlyKeys = sorted([...seedIds].filter(id => !rawIds.has(id) && !d1Ids.has(id)));

  return {
    counts: { raw: rawIds.size, pointer: pointerIds.size, fingerprint: fingerprintIds.size, ratings: ratingsIds.size, seed: seedIds.size, today: today.size, union: union.size },
    removedKeys,
    newKeys,
    impacts,
    forecastGains,
    featureGains,
    forecastOnly,
    featuresOnly,
    forecastAndFeatures,
    seed: { nullWins: seedNullWins, ratingsWin: seedRatingsWin, fills: seedFills, onlyKeys: seedOnlyKeys },
    today: sorted(today),
    union: sorted(union),
  };
}
