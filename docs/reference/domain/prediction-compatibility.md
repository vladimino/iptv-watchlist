# Prediction compatibility across taste-profile versions

`src/domain/prediction-compatibility.js` is the one rule that decides whether a stored prediction is still usable after the taste profile moves on, as decided in [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md). It is a pure function with no storage, network or clock access, built on the selector and approval rules of `src/domain/profile-impact.js` (the publisher's rules, see [taste-profile publication](../api/enrichment.md#taste-profile-publication)).

**Consumers.** The prediction queue uses it ([below](#prediction-queue)). Readers, the runner steps, catalog, Finds, diagnostics, MCP, UI and the D1 repository still compare the profile version and hash strictly (see the prediction row in [Film/Person lifecycle](film-person.md)).

## Call

```js
predictionCompatibility(prediction, fingerprint, features, profile, mode, {
  vocabulary: {mechanics, execution, general}, // MECHANICS, EXECUTION, GENERAL_EXECUTION of the fingerprint contract
  digest,                                    // text -> SHA-256 hex, synchronous
  fingerprintSchemaVersion, predictionPromptVersion
})
// -> {outcome: 'current'|'compatible'|'stale', reason, originalProfile: {version, profileHash},
//     evaluatedAgainst: {version, profileHash}, links}
```

- `prediction` is the stored record; it is never modified. `originalProfile` repeats its `tasteProfileVersion`/`tasteProfileHash` and `evaluatedAgainst` is the profile it was judged against.
- `profile` is `current.json`: `{version, profileHash, lineage}`.
- `features` comes from `predictionImpactFeatures(fingerprint, genres)`: a copy of the fingerprint's `plotMechanics` and raw `execution` (including `unknown` and `not_applicable`), its `fingerprintHash`, and the film's stored genre names.
- `mode` is `strict` or `selective`; any other value behaves as `strict`.
- `digest` must be synchronous. A caller in the Worker computes the SHA-256 of each lineage link's declaration once (they are few) and passes a lookup.
- `links` is the number of lineage transitions between the prediction's version and the current one.
- `predictionCompatibilityFresh(result)` is true for `current` and `compatible`.

## Order of checks

The first failing check decides:

1. Fingerprint not current (schema or `invalidatedAt`) → `stale/fingerprint_not_current`. Prediction fingerprint hash or schema differs → `fingerprint_changed`. Prompt version differs → `prompt_changed`.
2. Same profile version: same hash → `current/exact`, otherwise `profile_provenance_mismatch`.
3. Mode other than `selective` → `profile_changed`.
4. Non-integer version → `profile_provenance_mismatch`. Prediction version newer than current → `profile_ahead`. Version not in the lineage → `profile_outside_lineage`; there with another hash → `profile_provenance_mismatch`. A lineage that does not end at the current version and hash → `profile_chain_broken`.
5. Prediction hash equals the current hash → `compatible/content_identical`.
6. For each later link, in order:
   - versions must increase and `from` must name the previous link (`profile_chain_broken`);
   - the link's impact must be well formed (schema 1, known scope, valid selectors, no selectors outside `selective`); a `selective` link also needs a complete owner approval whose `declarationSha256` equals `digest` of its canonical declaration; an `identity` link must keep the hash. Any failure → `profile_impact_unknown`;
   - `global` → `profile_global_change`; `identity` passes;
   - `selective`: features without a `fingerprintHash` equal to the fingerprint's (missing, null, empty or another hash), or no features → `film_features_unknown`; a reached film → `profile_impacted`; otherwise any unknown feature → `film_features_unknown`.
7. Otherwise → `compatible/profile_unaffected`.

## Selector reach

| Selector | Reached when | Unknown when |
| --- | --- | --- |
| `mechanic` | `plotMechanics` contains a value | `plotMechanics` absent or not a list, or any stored value outside the mechanics vocabulary (an empty list reaches nothing) |
| `execution` | the dimension's value is in `values`; `not_applicable` reaches nothing | `execution` is not an object; the value is `unknown` or outside that dimension's vocabulary (including `not_applicable` where the dimension does not allow it); a general dimension is absent; a genre-specific dimension is absent and the film's genres are unknown or include the dimension's genre |
| `genre` | a canonical genre of the film is in `values` | no genres, or any stored name without an alias |

Stored genre names are mapped case-insensitively, after trimming, by `PROFILE_GENRE_ALIASES`. It covers the Russian TMDB names, the Letterboxd source labels and the English TMDB names, onto the canonical genres of the ADR. Genre domains of the genre-specific dimensions are in `PROFILE_GENRE_DOMAINS`: `comedy_*` → comedy, `horror_*` → horror, `scifi_plot_driven_concept` → science_fiction, `adventure_discovery_strength` → adventure, `action_readability` and `hero_vulnerability` → action.

## Prediction queue

Every queue refresh evaluates each queue film against the current profile:

- **Inputs.** The fingerprint and features come from the film's `impactFeatures` in `enrichment/view-index.json`: `{fingerprintHash, fingerprintSchemaVersion, invalidatedAt, plotMechanics, execution}`. They are copied from the full fingerprint whenever the index receives it: on submit, on runner repair and by the fingerprint-view backfill. The display facet is never used as input. An entry whose `impactFeatures` is missing, or carries another fingerprint hash, has unknown features. The genres are the film's stored genres. Lineage approvals are re-checked with the SHA-256 of each link's declaration, computed once per refresh.
- **Decision.** `PREDICTION_PROFILE_COMPATIBILITY` (see the [flag register](../feature-flags.md)) chooses the rule. `strict` (the default) keeps exact version and hash equality, the same rule as before. Only the exact value `selective` lets the evaluator decide: then a `current` or `compatible` prediction stays out of the queue and every other predicted film is queued again. The runner chooses the work per film: `prediction_only` while the fingerprint is current.
- **Counters.** `enrichment/prediction-queue.json` and `GET /api/enrichment/queue/status` carry `compatibility` in both modes:

  ```json
  {"mode": "strict", "evaluatorVersion": 1, "profileVersion": 2, "films": 4, "missing": 1,
   "strict": {"current": 0, "stale": 3}, "selective": {"current": 0, "compatible": 1, "stale": 2},
   "reasons": {"profile_unaffected": 1, "profile_impacted": 1, "film_features_unknown": 1},
   "wouldKeep": 1, "wouldRequeue": 0, "strictDisagreements": 0}
  ```

  - `missing` counts films without a prediction; they are excluded from the other counts.
  - `wouldKeep` counts predictions strict equality queues but the evaluator keeps.
  - `wouldRequeue` counts the reverse; it should stay 0, because an exact match is always current.
  - `strictDisagreements` compares the evaluator in strict mode with the plain equality check; it should stay 0.
- **Not switched by the mode.** Coverage, catalog and Finds, the view (`stale`), the runner's start, next, submit and complete steps, diagnostics and the D1 projection keep strict equality. While that holds, a prediction kept by `selective` is out of the queue but still shown as awaiting recalculation. The value therefore stays `strict` until those consumers use the same evaluator and the activation is approved.

## Rollback

Setting the queue back to `strict` restores exact equality on the next refresh. Strict mode returns every non-exact prediction as stale, so the selective rule can be turned off without touching any record. A profile republished with earlier content is `content_identical` for predictions made under that content.

## Tests

`tests/queue-compatibility.mjs` covers the queue: the exact mode values, impact features written on submit, the strict default with its counters, queue/view agreement under strict, a selective publication that keeps an unaffected film, entries without impact features, a tampered approval, a global edit and the return to strict. `tests/prediction-compatibility.mjs` checks every case of `tests/fixtures/profile-compatibility/cases.json` against the live vocabulary, together with negative cases (missing or wrong digest, tampered or unapproved links, broken or unordered lineage, features with a missing, null or foreign fingerprint hash, stored values outside the vocabulary, absent genre-specific dimensions in and outside their genre, unknown mode), feature extraction, and a lineage built by the publisher's own functions.
