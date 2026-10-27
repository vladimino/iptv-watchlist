# Prediction compatibility across taste-profile versions

`src/domain/prediction-compatibility.js` is the one rule that decides whether a stored prediction is still usable after the taste profile moves on, as decided in [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md). It is a pure function with no storage, network or clock access, built on the selector and approval rules of `src/domain/profile-impact.js` (the publisher's rules, see [taste-profile publication](../api/enrichment.md#taste-profile-publication)).

**Not wired.** No route, queue, reader, MCP tool, UI or D1 repository calls it. Every consumer still compares the profile version and hash strictly (see the prediction row in [Film/Person lifecycle](film-person.md)). Connecting it, and the mode switch, are separate changes.

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

## Rollback

Strict mode returns every non-exact prediction as stale, so the selective rule can be turned off without touching any record. A profile republished with earlier content is `content_identical` for predictions made under that content.

## Tests

`tests/prediction-compatibility.mjs` checks every case of `tests/fixtures/profile-compatibility/cases.json` against the live vocabulary, together with negative cases (missing or wrong digest, tampered or unapproved links, broken or unordered lineage, features with a missing, null or foreign fingerprint hash, stored values outside the vocabulary, absent genre-specific dimensions in and outside their genre, unknown mode), feature extraction, and a lineage built by the publisher's own functions.
