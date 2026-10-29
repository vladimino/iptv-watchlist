# Prediction compatibility across taste-profile versions

`src/domain/prediction-compatibility.js` is the one rule that decides whether a stored prediction is still usable after the taste profile moves on, as decided in [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md). It is a pure function with no storage, network or clock access, built on the selector and approval rules of `src/domain/profile-impact.js` (the publisher's rules, see [taste-profile publication](../api/enrichment.md#taste-profile-publication)).

**Consumers.** Every consumer uses the selective rule ([below](#one-rule-for-every-consumer)). No variable selects it: the former `PREDICTION_PROFILE_COMPATIBILITY` switch is retired and inert ([ADR 0044](../../adr/0044-retire-profile-compatibility-switch.md)). The strict outcome is still computed beside it for the queue's counters.

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
- `featureVocabulary` (optional) is the vocabulary of the fingerprint's own schema when it differs from the current one ([fingerprint compatibility](fingerprint-compatibility.md#prediction-check)); a selector value it lacks is an unknown feature. Without it, `vocabulary` answers both.
- `digest` must be synchronous. A caller in the Worker computes the SHA-256 of each lineage link's declaration once (they are few) and passes a lookup.
- `links` is the number of lineage transitions between the prediction's version and the current one.
- `predictionCompatibilityFresh(result)` is true for `current` and `compatible`.

## Order of checks

The first failing check decides:

1. Fingerprint not current (schema or `invalidatedAt`) → `stale/fingerprint_not_current`. Prediction fingerprint hash or schema differs → `fingerprint_changed`. Prompt version differs → `prompt_changed`. These checks are strict equality; [fingerprint compatibility](fingerprint-compatibility.md#prediction-check) specifies the rule that replaces them for fingerprint schema and prompt transitions.
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
- **Decision.** A `current` or `compatible` prediction stays out of the queue and every other predicted film is queued again. The runner chooses the work per film: `prediction_only` while the fingerprint is current.
- **Counters.** `enrichment/prediction-queue.json` and `GET /api/enrichment/queue/status` carry `compatibility`:

  ```json
  {"mode": "selective", "evaluatorVersion": 1, "profileVersion": 2, "films": 4, "missing": 1,
   "strict": {"current": 0, "stale": 3}, "selective": {"current": 0, "compatible": 1, "stale": 2},
   "reasons": {"profile_unaffected": 1, "profile_impacted": 1, "film_features_unknown": 1},
   "wouldKeep": 1, "wouldRequeue": 0, "strictDisagreements": 0}
  ```

  - `missing` counts films without a prediction; they are excluded from the other counts.
  - `wouldKeep` counts predictions the selective rule keeps that strict equality would queue.
  - `wouldRequeue` counts the reverse; it should stay 0, because an exact match is always current.
  - `strictDisagreements` compares the evaluator in strict mode with the plain equality check; it should stay 0.

  The same refresh records `fingerprintCompatibility` and a `work` map for the fingerprint transition rule, decided by its own switch ([fingerprint compatibility](fingerprint-compatibility.md#queue-and-runner)). Under that rule's `selective` mode one verdict per film decides, with this profile rule applied in its selective mode.
## One rule for every consumer

`predictionFreshness(env, profile)` fixes the profile snapshot (version, hash, lineage, approval digests) once per request. Its two checks are what every consumer calls:

- `state(prediction, fingerprint, genres)` takes the stored prediction and the **full** fingerprint file;
- `indexed(item, film)` takes the view-index entry and its `impactFeatures` (above), with the catalog or programme film for the genres.

Both ask the evaluator in `selective` mode.

| Consumer | Check |
| --- | --- |
| Prediction queue | `indexed` (with the counters above) |
| View `GET /api/enrichment/view` (`stale`; it also reads the programme and catalog for genres) | `indexed` |
| Coverage in the footer status and the prediction Events | `indexed` |
| Catalog `GET /api/catalog/available` and therefore Finds | `indexed` |
| Runner `start` (pending count), `next` (completion, retried failures, index repair, work selection), `submit` (`already_current`, caller-reported failure) and `complete` (pending count) | `state`, genres from the run's source metadata |
| Diagnostics and MCP `prediction_film_diagnostics`, `prediction_queue_overview`, `prediction_pending` | `state` for the file, `indexed` for index agreement and `index_ahead_of_queue` |
| Film/Person lifecycle reader and domain | an optional evaluator verdict per film (`predictionCompatible(id)` on the store); without one, strict |

The same `state` and `indexed` checks apply the fingerprint transition rule in the same call ([fingerprint compatibility](fingerprint-compatibility.md#readers-and-diagnostics)); the fingerprint rule follows its own switch, and the fingerprint is judged before the profile.

Two consumers stay strict by contract:

- **The isolated prediction benchmark** compares fresh trial predictions with stored references made under the same profile.
- **The D1 prediction projection.** `profile_version` holds no lineage, and the evaluator with no lineage gives the strict answer for every non-exact prediction.

**Agreement and provenance.**

- A kept prediction is never rewritten: its record and every reader keep its own `tasteProfileVersion` and `tasteProfileHash`.
- Diagnostics report `cause: compatible` and the `mode`. The lifecycle domain records the original profile as provenance and the evaluated one as `evaluatedAgainst`.
- The queue, the view, coverage and the catalog read the same index entry, so they agree.
- The runner reads the full fingerprint. For an entry written before `impactFeatures` existed it may therefore keep a prediction that the index-based consumers still treat as stale. Its `next` step then repairs the entry (record and impact facet), and every consumer agrees from the next refresh on.

## Rollback

There is no runtime rollback to strict equality: the switch is retired ([ADR 0044](../../adr/0044-retire-profile-compatibility-switch.md)). Returning to strict is a code revert to a version that reads the switch, with `PREDICTION_PROFILE_COMPATIBILITY` unset or `strict`; it returns every non-exact prediction as stale and requeues it, without touching any record. Once the leftover binding has been removed, a revert that should keep today's behaviour needs `selective` restored. A profile republished with earlier content is `content_identical` for predictions made under that content.

## Tests

`tests/queue-compatibility.mjs` covers the consumers end to end:

- no code path reads a profile-rule switch, and a stale binding of any value changes no queue or reader decision;
- impact features written on submit;
- the counters with the strict outcome beside the decision, and queue/view agreement;
- the same kept film in the queue, view, coverage, diagnostics, catalog and runner (`already_current`, no recomputation, version kept), while the reached film is recalculated;
- the runner keeping an entry without impact features and repairing it;
- a tampered approval;
- a global edit.

`tests/film-person-reader.mjs` covers the lifecycle verdict. `tests/prediction-compatibility.mjs` checks every case of `tests/fixtures/profile-compatibility/cases.json` against the live vocabulary, together with negative cases (missing or wrong digest, tampered or unapproved links, broken or unordered lineage, features with a missing, null or foreign fingerprint hash, stored values outside the vocabulary, absent genre-specific dimensions in and outside their genre, unknown mode), feature extraction, and a lineage built by the publisher's own functions.
