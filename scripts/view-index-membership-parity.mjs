// Offline membership comparison for the view-index replacement (pure functions, no I/O, never bundled into the Worker).
//
// Today a full view's key set is: raw view-index keys, plus every ratings_view alias (RatingsD1.overlayView adds them), plus the ids of the compiled
// ratings seed (applyRatingsSeed creates a key for a seed-only id). The prediction overlay changes only keys already in the raw object.
// The proposed replacement ("union") takes the key set from the D1 rows instead of the raw object: prediction_pointer, prediction_fingerprint and
// ratings_view film ids, plus the same seed layer applied afterwards.
//
// The two sets differ in exactly two ways, and both are reported by id:
//   disappears    a raw key with no D1 row of any of the three kinds and not in the seed (an entry with no fact left after the overlays)
//   gainsForecast a prediction_pointer or prediction_fingerprint id that is not a raw key (today it shows no forecast; the union shows it)
// Every other id keeps its key and its facts, because the field values come from the same overlays in both models.
//
// The inputs of a real comparison are an owner-approved read-only export of the raw object and the film ids of the three D1 tables; this module only
// classifies them. It is exercised with synthetic fixtures by tests/view-index-membership-parity.mjs.

const ids = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : []).map(String);
const sorted = set => [...set].sort();

export function compareMembership({ raw = null, predictionPointerIds = [], predictionFingerprintIds = [], ratingsRows = [], seed = {} } = {}) {
  const rawIds = new Set(ids(raw));
  const predictionIds = new Set([...ids(predictionPointerIds), ...ids(predictionFingerprintIds)]);
  const ratingsIds = new Set(ratingsRows.map(row => String(row.alias_id)));
  const seedIds = new Set(ids(seed));
  const d1Ids = new Set([...predictionIds, ...ratingsIds]);

  const today = new Set([...rawIds, ...ratingsIds, ...seedIds]);
  const union = new Set([...d1Ids, ...seedIds]);

  const disappears = sorted([...rawIds].filter(id => !d1Ids.has(id) && !seedIds.has(id)));
  const gainsForecast = sorted([...predictionIds].filter(id => !rawIds.has(id)));

  // The seed rule on top of either key set: an own actualRating (a ratings_view row with rating_known=1, null included) wins; otherwise the seed fills it.
  const knownRating = new Map(ratingsRows.filter(row => Number(row.rating_known) === 1).map(row => [String(row.alias_id), row.actual_rating == null ? null : Number(row.actual_rating)]));
  const seedNullWins = sorted([...seedIds].filter(id => knownRating.has(id) && knownRating.get(id) === null));
  const seedRatingsWin = sorted([...seedIds].filter(id => knownRating.has(id) && knownRating.get(id) !== null));
  const seedFills = sorted([...seedIds].filter(id => !knownRating.has(id)));
  const seedOnlyKeys = sorted([...seedIds].filter(id => !rawIds.has(id) && !d1Ids.has(id)));

  return {
    counts: { raw: rawIds.size, prediction: predictionIds.size, ratings: ratingsIds.size, seed: seedIds.size, today: today.size, union: union.size },
    disappears,
    gainsForecast,
    seed: { nullWins: seedNullWins, ratingsWin: seedRatingsWin, fills: seedFills, onlyKeys: seedOnlyKeys },
    // Keys the union adds that today's view does not hold (a forecast-only id that is also a ratings alias or seed id is already a key today).
    addedKeys: sorted([...union].filter(id => !today.has(id))),
    // True when the two key sets differ by nothing but `disappears` and `addedKeys`.
    onlyTheReportedDifferences: sorted([...today].filter(id => !disappears.includes(id))).join('\n') === sorted([...union].filter(id => today.has(id))).join('\n'),
    today: sorted(today),
    union: sorted(union),
  };
}
