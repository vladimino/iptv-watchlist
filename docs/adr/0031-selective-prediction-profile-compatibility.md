# ADR 0031: A prediction stays usable across taste-profile versions only through a published, typed change impact evaluated by one shared rule

**Status:** Accepted 2026-10-27, option A of section 4a (design only; it authorizes no profile publication, model run, queue change, flag, Scheduled Task, R2 or D1 operation)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner decision for option A on [AIR-32](https://trello.com/c/eKFV3v2j), recorded in the [final review](https://github.com/vladimino/iptv-watchlist/pull/162#pullrequestreview-5673703349)  
**Related work:** [AIR-32](https://trello.com/c/eKFV3v2j); successors [AIR-202](https://trello.com/c/POMLJNUx), [AIR-203](https://trello.com/c/2mnvn1hd), [AIR-204](https://trello.com/c/wFArDNnm), [AIR-205](https://trello.com/c/bjx64Z6X), [AIR-206](https://trello.com/c/87mg3VNi); [AIR-33](https://trello.com/c/rBFiUUZQ) (fingerprint schema, builds on this model); [equality guard audit](../evidence/prediction/air-32-profile-equality-guards-audit-2026-10-27.md); [specification fixtures](../../tests/fixtures/profile-compatibility/cases.json)  
**Supersedes:** [ADR-0013](0013-versioned-taste-profile.md) and [ADR-0014](0014-fingerprint-prediction-lifecycle.md) **in part, from activation**: the sentence "a new profile version makes predictions stale" becomes "a new profile version makes stale exactly the predictions its published impact reaches". Immutable versions, server-computed hashes, fingerprint independence and prediction history stay as decided there  
**Superseded by:** [ADR-0044](0044-retire-profile-compatibility-switch.md) (Proposed) in part: the mode switch and feature rollback of section 6; the rule itself stays

## Context

Every published taste profile makes every prediction stale. The [audit](../evidence/prediction/air-32-profile-equality-guards-audit-2026-10-27.md) found the rule as strict equality of `tasteProfileVersion` **and** `tasteProfileHash` (with fingerprint hash, fingerprint schema and prompt version) copied into at least ten places: the queue builder, the run start, next, submit and complete steps, the public prediction and view projections, the catalog route behind Finds, the prediction diagnostics, the Film lifecycle domain and reader, and the D1 prediction repository. A one-line edit to horror preferences therefore re-queues the whole catalog (about 2,300 films), spends model quota on films the edit cannot reach, and leaves the UI showing «ожидает пересчёта» on all of them until the queue drains.

The profile body already has the structure needed to say what an edit can reach: global guidance (`ratingScale`, `calibration`, `anchorFilms`), genre-specific sections, and execution-oriented sections (`characterLogic`, `pace`, `payoffEnding`). Fingerprints carry closed vocabularies for plot mechanics and execution dimensions, and catalog films carry genres. What is missing is a published, validated statement of the impact of each version, and one rule that every consumer applies to it.

## Decision

### 1. Version model

- A profile version record stays immutable and keeps `version` (strictly increasing, gaps allowed), `profileHash` (server-computed content hash of the profile body) and `profile`. It gains **`changeImpact`**, part of the immutable record but **not** of `profileHash`:

  ```json
  {"impactSchemaVersion": 1,
   "from": {"version": 4, "profileHash": "<hash of the version it replaces>"},
   "scope": "selective",
   "changedFields": ["horrorPreferences"],
   "selectors": [{"kind": "genre", "values": ["horror"]},
                 {"kind": "execution", "dimension": "horror_rule_consistency", "values": ["weak", "mixed"]}],
   "rationale": "free text, display only",
   "approval": {"approvedBy": "owner", "approvedAt": "<ISO time>", "reviewRef": "<id of the owner's recorded decision>",
                "declarationSha256": "<SHA-256 of the canonical declaration, section 4>"}}
  ```

- `scope` is `identity` (same `profileHash` as `from`, no changed field), `selective` (at least one selector) or `global`. The publisher may always choose `global`.
- `current.json` carries the current record plus a bounded **lineage**: the immutable `(version, profileHash, changeImpact)` of the most recent published versions, at most 32 links. A consumer evaluates compatibility from `current.json` alone, with no per-version read.
- A prediction record is **never rewritten**: its `tasteProfileVersion` and `tasteProfileHash` stay the original provenance. No consumer, migration or repair may stamp a newer version onto an older prediction. A new prediction always carries the profile that produced it.

### 2. Typed impact selectors

A selector says which films an edit **can** reach. Selectors inside one link are OR'ed. Kinds and values are closed; anything else is invalid.

| Kind | Values | A film is reached when | Feature unknown when (→ treated as reached) |
| --- | --- | --- | --- |
| `mechanic` | `MECHANICS` of the fingerprint contract | `plotMechanics` intersects `values` (an empty list is known and reaches nothing) | `plotMechanics` absent |
| `execution` | one `dimension` of `EXECUTION` and a non-empty list of its concrete values (never `unknown` or `not_applicable`) | the film's value for the dimension is in `values`; `not_applicable` reaches nothing; an absent **genre-specific** dimension reaches nothing **only when the film's genres are known, all mapped, and none is in that dimension's genre domain** (below) | the value is `unknown`; an absent **general** dimension; an absent genre-specific dimension on a film whose genres are empty, unmapped, or include the dimension's domain |
| `genre` | closed canonical genres (`action`, `adventure`, `animation`, `comedy`, `crime`, `documentary`, `drama`, `family`, `fantasy`, `history`, `horror`, `music`, `mystery`, `romance`, `science_fiction`, `thriller`, `tv_movie`, `war`, `western`) | a stored genre name, case-folded and mapped through the closed alias table, is in `values` | the film has no genres, or any stored genre name has no alias |

Genre domains of the genre-specific dimensions: `comedy_stupidity_for_gags`, `comedy_gross_out` → `comedy`; `horror_rule_consistency`, `horror_threat_causality` → `horror`; `scifi_plot_driven_concept` → `science_fiction`; `adventure_discovery_strength` → `adventure`; `action_readability`, `hero_vulnerability` → `action`. Absence is therefore never read as "unaffected" by itself: a horror film whose older fingerprint lacks `horror_rule_consistency` is reached by any selector on that dimension, whichever profile field declared it; only a film proved to be outside the domain is not.

Features are read from the stored fingerprint the prediction was made with (its `fingerprintHash` must equal the prediction's, see 3) and the film's current metadata genres. The view-index fingerprint facet is **not** sufficient: it drops `unknown`, `not_applicable` and every genre-specific dimension, so the queue needs its own impact features keyed by fingerprint hash (AIR-204).

### 3. One evaluation rule

`predictionCompatibility(prediction, fingerprint, features, profile, mode)` is a pure function. It returns `{outcome, reason, originalProfile, evaluatedAgainst, links}` with `outcome` ∈ `current | compatible | stale`. Checks run in this order and the first failure decides:

1. Fingerprint not current → `stale/fingerprint_not_current`; prediction fingerprint hash or schema differs → `stale/fingerprint_changed`; prompt version differs → `stale/prompt_changed`. These stay strict here; [AIR-33](https://trello.com/c/rBFiUUZQ) decides the fingerprint transition with the same outcome vocabulary.
2. Same version and hash as the current profile → `current/exact`. Same version, other hash → `stale/profile_provenance_mismatch`.
3. Mode `strict` → `stale/profile_changed` (today's behaviour).
4. Prediction version newer than current → `stale/profile_ahead`. Version not in the lineage → `stale/profile_outside_lineage`. In the lineage with another hash → `stale/profile_provenance_mismatch`.
5. Prediction hash equals the current hash (content restored) → `compatible/content_identical`.
6. For each link after the prediction's version up to the current one, in order: `from` must equal the previous lineage record (`stale/profile_chain_broken`); a missing, unknown-schema or invalid impact, an unknown scope or an unknown selector kind, or a `selective` impact without a valid owner approval bound to it (section 4) → `stale/profile_impact_unknown` (**unknown means global**); `global` → `stale/profile_global_change`; `identity` passes; `selective`: a reached film → `stale/profile_impacted`, otherwise an unknown feature → `stale/film_features_unknown`, otherwise the link passes.
7. All links pass → `compatible/profile_unaffected`.

`current` and `compatible` are both "not stale" for every consumer; `compatible` additionally exposes `originalProfile` and `evaluatedAgainst` so a reader can say which profile produced the number. Existing version records have no `changeImpact`, so every prediction made before activation evaluates to `profile_impact_unknown` across the first new version: activation cannot silently keep an old prediction.

### 4. Publication validation

The publisher (AIR-202) computes the changed top-level fields itself by comparing the new profile body with the current one, then rejects the whole publication (current pointer unchanged) unless, in this order: the impact exists (`impact_missing`), has schema 1 (`impact_schema_unknown`), `from` equals the current record (`from_mismatch`), the scope is known (`scope_unknown`), `identity` keeps the hash (`identity_requires_same_hash`), `changedFields` equals the computed set (`changed_fields_mismatch`), no changed field is global-only (`global_field_requires_global`), a selective impact has selectors (`selective_requires_selectors`), every selector kind and value is valid (`selector_kind_unknown`, `selector_invalid`), every changed field is covered by a selector it permits (`field_not_covered`), each genre-specific field includes its genre floor (`genre_floor_missing`), and a selective declaration carries a complete owner approval (`selective_requires_owner_approval`) whose `declarationSha256` equals the SHA-256 of the canonical declaration `[from.version, from.profileHash, to.version, to.profileHash, scope, sorted changedFields, selectors]` (`approval_mismatch`). Extra selectors only widen the impact and are allowed. `global` and `identity` need no approval.

| Changed field | Permitted selectors | Genre floor |
| --- | --- | --- |
| `ratingScale`, `calibration`, `anchorFilms` | none: `global` only | — |
| `genrePreferences` | `genre` | — |
| `comedyPreferences` | `genre`; `execution` on `comedy_stupidity_for_gags`, `comedy_gross_out` | `comedy` |
| `horrorPreferences` | `genre`; `execution` on `horror_rule_consistency`, `horror_threat_causality` | `horror` |
| `scifiAdventurePreferences` | `genre`; `execution` on `scifi_plot_driven_concept`, `adventure_discovery_strength` | `science_fiction`, `adventure` |
| `actionPreferences` | `genre`; `execution` on `action_readability`, `hero_vulnerability` | `action` |
| `characterLogic` | `execution` on `decision_logic`, `protagonist_competence`, `opposition_competence`, `problem_solving` | — |
| `pace` | `execution` on `pace`, `plot_engine` | — |
| `payoffEnding` | `execution` on `payoff`, `ending_quality` | — |
| `positiveSignals`, `negativeSignals`, `hardSkips` | `mechanic`, `execution` (any dimension), `genre` | — |

### 4a. Trust model and guarantees

The validator proves structure and coverage, never meaning: no table can show that a reworded `positiveSignals`, `hardSkips`, `characterLogic`, `pace`, `payoffEnding` or `genrePreferences` entry reaches only the declared films. A structurally valid but semantically too narrow declaration would silently keep incompatible scores. The contract therefore separates what the system guarantees from what a person decides:

- **Guaranteed mechanically:** closed vocabularies, coverage of every changed field, global-only fields, genre floors, fail-closed handling of every unknown (impact, schema, kind, feature, approval), immutable provenance, one rule for all consumers.
- **Decided by the owner:** that a selective declaration matches the meaning of the edit. **Every change is global by default.** A version is published `selective` only when the owner has reviewed that exact declaration and recorded the decision (`reviewRef`, for example the Trello comment of the decision); the publication carries the approval, and its SHA-256 binds it to the transition and the exact selectors, so a changed selector, field list or target hash invalidates it. The evaluator re-checks the binding on every link and treats a missing or mismatched approval as unknown, i.e. global.
- **Not a safety mechanism:** shadow telemetry (AIR-204) validates declarations after the fact (how many films each would keep, and whether owner-reviewed declarations look plausible). It never authorizes selective scope.
- **Residual risk the owner accepts by accepting this ADR:** the Worker can check that an approval record is present, complete and bound to the declaration, and that the publication is an authenticated owner request behind Access; it cannot prove a human actually read the declaration. A wrong approved declaration is recoverable by a `global` version or strict mode (section 6), not prevented.

The owner chose this model (option A): selective scope is available for every field the table permits, each time only with an approval of that exact declaration.

### 5. Every consumer uses the same rule and the same inputs

The queue builder, run start/next/submit/complete, `publicPrediction` and the view projection, the catalog route (and therefore Finds), prediction diagnostics and MCP diagnostic tools, the Film lifecycle domain and reader, and the D1 prediction repository projection call the one evaluator with the same `current.json` snapshot (version, hash, lineage), mode and features. Invariant: for every film the queue considers, *pending* ⇔ `outcome = stale`. The queue records the profile version, hash, mode and evaluator version it was built with; diagnostics report a disagreement between queue and readers as an inconsistency, as they do today for the view index. A run stays bound to the profile hash it started with (a publication mid-run still ends it), submit stamps the current profile, and a `compatible` film counts as `already_current` and is not regenerated. The offline importer and D1 parity copy stored fields and stay unchanged. The UI shows `compatible` as current; it may show the original profile version, never a rewritten one.

### 6. Modes and rollback

- **Mode** is `strict` (default, today's behaviour) or `selective`; a shadow stage evaluates `selective` but decides `strict` and only counts differences. The switch name, values and default are fixed and registered with the implementation (AIR-204), and changing it in production is a separate owner approval.
- **Feature rollback** is mode `strict`: every non-exact prediction becomes stale and the queue re-queues globally. No record is touched.
- **Code rollback** is safe: `changeImpact` and `lineage` are additive, and earlier code ignores them and compares strictly.
- **Profile content rollback** is a normal new version whose content equals an earlier one, with the reverse impact. Predictions made under the restored content are `content_identical`; predictions made under the reverted rules for reached films are stale; unreached films stay compatible. Older predictions in history are not promoted back to current by this decision.
- **Forced recompute** is a `global` publication.

### Not decided here

The publisher's write sequence and concurrency guard (AIR-202), the evaluator module layout and feature extraction (AIR-203), queue features and counters (AIR-204), reader payload fields (AIR-205), activation steps (AIR-206), the D1 column for `changeImpact` (a later D1 schema change), and fingerprint-schema compatibility (AIR-33). No Mermaid diagram changes in this decision: the [prediction pipeline diagram](../architecture/prediction-pipeline.md) stays accurate until activation, and the implementing card updates it under the owner's rendered visual gate.

## Dependency graph for the successor cards

| Card | Delivers | Needs |
| --- | --- | --- |
| [AIR-202](https://trello.com/c/POMLJNUx) | Validated `changeImpact` with approval binding (sections 4, 4a), immutable create-only version record, `lineage` in `current.json`, publication rejected without a pointer change | this ADR accepted |
| [AIR-203](https://trello.com/c/2mnvn1hd) | Pure evaluator (section 3) passing every [fixture](../../tests/fixtures/profile-compatibility/cases.json); feature extraction and genre alias table | AIR-202 record shape |
| [AIR-204](https://trello.com/c/wFArDNnm) | Queue built with the evaluator in shadow, impact features keyed by fingerprint hash, counters `exact/compatible/stale` by reason, the mode switch registered | AIR-203 |
| [AIR-205](https://trello.com/c/bjx64Z6X) | Every reader in section 5 on the evaluator; queue/reader agreement test; fail closed on unknown | AIR-204 |
| [AIR-206](https://trello.com/c/87mg3VNi) | Owner-approved staged activation, diagnostics, rollback to `strict` rehearsed | AIR-205 |
| [AIR-33](https://trello.com/c/rBFiUUZQ) | Fingerprint schema transitions reusing this outcome model | this ADR accepted |

## Alternatives considered

- **Keep strict equality.** Rejected: correct but recomputes every film on any edit, which is the cost this card exists to remove.
- **Rewrite the version of unaffected predictions.** Rejected: destroys provenance and makes a rollback or audit unable to tell which profile produced a number.
- **Let the model or the server infer impact from the text diff.** Rejected: not deterministic, not reviewable, and makes freshness depend on a model call.
- **Per-film impact lists in the publication.** Rejected: unbounded, stale as soon as the catalog changes, and impossible to validate against unseen films.
- **Only one-step compatibility (vN→vN+1).** Rejected: two quick publications would turn every film stale again; the bounded lineage makes the rule transitive at a fixed cost.
- **Unknown features or impact treated as unaffected.** Rejected: fails open. Unknown is always global/stale.
- **Structural validation alone authorizes selective scope.** Rejected in review: coverage cannot prove that free-form prose reaches only the declared films, so a narrow declaration could silently keep incompatible scores (section 4a).
- **Selective scope only for the four genre-specific sections, every other field global-only (option B).** Not chosen by the owner: it removes judgement calls on free-form fields but forgoes most of the savings; per-declaration approval (option A) keeps the same fail-closed default.
- **Absent genre-specific dimension always treated as unaffected.** Rejected in review: an older fingerprint of a film inside the genre may simply lack the field; absence counts only when the genres prove the film is outside the domain.

## Consequences

Profile edits cost model runs in proportion to their declared reach. Every consumer depends on one more input (the lineage) and one shared function, so a disagreement between queue and UI becomes a testable invariant instead of a copy-paste risk. Publication becomes stricter: a profile edit without a valid impact is refused, and a selective one needs a recorded owner review of its exact declaration, which adds a human step to every selective publication. The residual risk is a wrongly approved declaration; it is visible in the immutable record with its approval and recoverable by a `global` version or by strict mode.

## Recovery and migration boundary

This ADR changes no code or data. Its acceptance authorizes none of: a profile publication, a model or prediction run, a queue rebuild, a mode switch, a Scheduled Task change, an R2 or D1 read or write. Each successor card is a separate PR; activation (AIR-206) needs its own owner approvals. Rollback paths are in section 6; none of them rewrites a prediction.

## Evidence

- **Original decision:** [AIR-32](https://trello.com/c/eKFV3v2j), owner comment of 27 October 2026 (design-first phase A); owner acceptance of option A in the [final review](https://github.com/vladimino/iptv-watchlist/pull/162#pullrequestreview-5673703349)
- **Audit:** [equality guards and consumers on `main` `1f956dd`](../evidence/prediction/air-32-profile-equality-guards-audit-2026-10-27.md)
- **Specification:** [fixtures](../../tests/fixtures/profile-compatibility/cases.json) checked by `tests/profile-compatibility-spec.mjs` against the live mechanic, execution, genre and profile field vocabularies
- **Uncertainty:** the selectors' semantic accuracy cannot be proven by the system (section 4a: it is an owner decision, bound by approval); the share of films a typical edit reaches is not measured (AIR-204 shadow counters measure it)

## Follow-ups

[AIR-202](https://trello.com/c/POMLJNUx) → [AIR-203](https://trello.com/c/2mnvn1hd) → [AIR-204](https://trello.com/c/wFArDNnm) → [AIR-205](https://trello.com/c/bjx64Z6X) → [AIR-206](https://trello.com/c/87mg3VNi); [AIR-33](https://trello.com/c/rBFiUUZQ).
