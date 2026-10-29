# Fingerprint compatibility across schema and prompt versions

This page is the contract for keeping a stored fingerprint, and the predictions made from it, usable when the fingerprint schema, the fingerprint prompt or the prediction prompt changes. The decision is [ADR-0035](../../adr/0035-selective-fingerprint-transition-compatibility.md). It extends the outcome model of [prediction compatibility](prediction-compatibility.md) (ADR-0031).

**Status of the code.** The rule is the pure module `src/domain/fingerprint-compatibility.js` (evaluator, registry validator and the extended prediction check). The prediction queue, the runner steps and every reader of current/stale call it through one freshness rule per request ([queue and runner](#queue-and-runner), [readers and diagnostics](#readers-and-diagnostics)), decided by `PREDICTION_FINGERPRINT_COMPATIBILITY` ([feature flags](../feature-flags.md)); with the default `strict` they keep exact schema and prompt version equality. Every consumer compares the fingerprint schema and the prediction prompt version by strict equality with the Worker constants (`FINGERPRINT_SCHEMA_VERSION`, `PREDICTION_PROMPT_VERSION`, both 1), and no fingerprint carries a prompt version. The [specification fixtures](../../../tests/fixtures/fingerprint-compatibility/cases.json) state the expected outcomes; `tests/fingerprint-compatibility-spec.mjs` keeps them aligned with the live vocabularies.

## Version axes

| Axis | Stamped on | Hashed into | Reading of an absent value |
| --- | --- | --- | --- |
| `fingerprintSchemaVersion` | fingerprint; copied to each prediction as provenance | `fingerprintHash` | never absent: the submit validator requires it |
| `fingerprintPromptVersion` | fingerprint record | no | `1` |
| `predictionPromptVersion` | prediction | no | never absent on a stored prediction |
| `tasteProfileVersion`, `tasteProfileHash` | prediction | no | [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md) |

A record keeps the versions that produced it. A kept record is judged compatible; it is never re-stamped.

## Transition declaration

Each version change on one axis (`fingerprint_schema`, `fingerprint_prompt` or `prediction_prompt`) has one declaration in an append-only registry in the Worker code:

```json
{"transitionSchemaVersion": 1, "axis": "fingerprint_schema", "from": 1, "to": 2, "scope": "selective",
 "changes": [{"kind": "dimension_added", "dimension": "horror_climax_setup",
              "values": ["weak", "mixed", "strong", "unknown", "not_applicable"], "domain": ["horror"]}],
 "selectors": [{"kind": "genre", "values": ["horror"], "regenerate": {"mode": "partial", "fields": ["execution"]}}],
 "approval": {"approvedBy": "owner", "approvedAt": "2026-01-01T00:00:00.000Z", "reviewRef": "<recorded decision>",
              "declarationSha256": "<SHA-256 of canonical [axis, from, to, scope, changes, selectors]>"}}
```

- `scope` is `identity`, `selective` or `global`.
- `changes` uses these kinds:
  - values: `value_added`, `value_removed`, `value_split`, `value_merged`, `value_renamed`, `value_redefined`;
  - dimensions: `dimension_added`, `dimension_removed`, `dimension_redefined`;
  - fields: `field_added`, `field_removed`, `field_redefined`;
  - constraints: `constraint_relaxed`, `constraint_tightened`;
  - a `dimension_added` with a genre `domain` is optional in the target validator; with no domain it is a required general dimension and `global` only;
  - prompts: `prompt_revised` (prompt axes only).
- `selectors` use the ADR-0031 kinds `mechanic`, `execution` and `genre`, read from the **old** fingerprint in its own schema vocabulary and from the film's metadata genres. `regenerate.mode` is:
  - `partial`, with the regenerated `fields`;
  - `full`;
  - `prediction`, on the prediction prompt axis only.
- The canonical declaration sorts object keys and keeps array order; `declarationSha256` is the SHA-256 of its JSON text.

**Validation.** Rejection codes, in the order the validator checks them:

| Code | Rejected when |
| --- | --- |
| `transition_schema_unknown` | `transitionSchemaVersion` is not 1 |
| `axis_unknown` | the axis is not one of the three |
| `version_not_increasing` | `to` is not greater than `from` |
| `chain_broken` | `from` is not the previous transition's `to` on the same axis |
| `scope_unknown` | the scope is not one of the three |
| `change_kind_unknown` | a change kind is not in the list |
| `change_invalid` | a change names a value or dimension absent from the `from` vocabulary, adds one already present, or declares a genre-scoped added dimension `required` |
| `identity_change_not_compatible` | an `identity` declaration contains a change the structural check cannot decide |
| `identity_has_selectors` | an `identity` declaration has selectors |
| `global_only_change` | `field_added`, `field_redefined` or a general `dimension_added` in a `selective` declaration |
| `selective_requires_selectors` | a `selective` declaration has none |
| `selector_kind_unknown` | a selector kind is not in the list |
| `selector_invalid` | a selector value is outside the `from` vocabulary, or the regenerate mode does not fit the axis |
| `change_not_covered` | a value-level or dimension-level change has no selector including every old value |
| `genre_floor_missing` | an added genre-specific dimension's domain is not in a `genre` selector |
| `partial_fields_invalid` | partial fields omit the changed field |
| `selective_requires_owner_approval` | a `selective` declaration lacks a complete approval |
| `approval_mismatch` | the approval's hash differs from the declaration's |

An invalid registry counts as unknown: every link is global.

## Fingerprint rule

```js
fingerprintCompatibility(fingerprint, metadata, registry, target, mode, {vocabulary, digest})
// fingerprint: the generation record the pointer names; metadata: {genres}
// target: {fingerprintSchemaVersion, fingerprintPromptVersion}
// vocabulary: {mechanics, execution, general, domains} of schema 1; digest(text) -> SHA-256 hex, synchronous
// -> {outcome: 'current'|'compatible'|'stale', reason, migration: 'none'|'compatible'|'partial'|'full'|'global', fields, links}
```

- `fingerprint`, `metadata` and `registry` are never modified.
- A stored `fingerprintPromptVersion` that is absent reads as 1.
- `links` is the number of version steps between the record and the target on both fingerprint axes.
- `fingerprintCompatibilityFresh(result)` is true for `current` and `compatible`.
- `fingerprintRestoreCandidate(history, metadata, registry, target, options)` returns the first stored generation record that is `current` for the target, or null: the record a rollback restores the pointer to without a model run.
- `fingerprintRegistryIssue(registry, options)` validates the whole registry (`{code, index}` or null); `fingerprintTransitionIssue(transition, previous, vocabulary, digest)` one declaration, with the codes of the table above.
- `fingerprintSchemaVocabulary(schemaTransitions, version, base)` derives the vocabulary and tightened constraints of a schema version from schema 1 through the declared changes.

The first deciding check wins. Within one link the selectors are read before the structural check, so a stored value outside the fingerprint's own vocabulary is unknown, never a structure difference:

| Step | Outcome / reason | Migration |
| --- | --- | --- |
| no fingerprint | `stale/fingerprint_missing` | `full` |
| `invalidatedAt` set | `stale/fingerprint_invalidated` | `full` |
| a version newer than the target | `stale/fingerprint_ahead` | `full` (a stored current version may be restored instead) |
| both versions equal the target | `current/exact` | `none` |
| mode `strict` | `stale/fingerprint_version_changed` | `full` |
| no registry path | `stale/transition_unknown` | `global` |
| invalid registry or link | `stale/transition_impact_unknown` | `global` |
| a `global` link | `stale/transition_global` | `global` |
| reached by a selector | `stale/transition_impacted` | the selector's `partial` (fields united across links) or `full` |
| an unknown feature, including a stored value outside the own vocabulary | `stale/film_features_unknown` | `full` |
| stored fingerprint fails the target validator (once, after the selectors of the link), ignoring its version constant and the old values named by value-level changes on the path | `stale/fingerprint_structure_incompatible` | `full` |
| every link passes | `compatible/transition_unaffected` | `compatible` |

Links on both fingerprint axes are walked in order. The first stale link gives the reason, and the widest migration wins.

A profile selector (ADR-0031) is read against the fingerprint a prediction was made with, in that fingerprint's schema vocabulary. A selector value that vocabulary lacks is an unknown feature.

## Prediction check

```js
predictionTransitionCompatibility(prediction, fingerprint, metadata, profile, registry, target, mode, {vocabulary, digest})
// target also carries predictionPromptVersion
// -> {outcome, reason, requiredWork: 'none'|'prediction_only'|'fingerprint_and_prediction', fingerprint, prompt, profile}
```

This replaces step 1 of the [prediction compatibility order of checks](prediction-compatibility.md#order-of-checks); steps 2–7 are unchanged and run through `predictionCompatibility` with the target schema's vocabulary for the profile selectors and the fingerprint's own vocabulary for its features (`featureVocabulary`). The verdicts of the three parts are returned as `fingerprint`, `prompt` and `profile`.

| Check | Reason |
| --- | --- |
| current fingerprint is not `current` or `compatible` | `fingerprint_not_current` |
| `fingerprintHash` differs | `fingerprint_changed` |
| same hash, different `fingerprintSchemaVersion` | `fingerprint_provenance_mismatch` |
| prompt version differs, mode `strict` | `prompt_changed` |
| prompt version newer than the target | `prompt_ahead` |
| no path, or an invalid link, on the prediction prompt axis | `prompt_transition_unknown` |
| a `global` prompt link | `prompt_global_change` |
| reached by a prompt selector | `prompt_impacted` |
| an unknown feature for a prompt selector | `prompt_features_unknown` |
| every prompt link passes | `compatible/prompt_unaffected` |

## Required work

| Fingerprint | Prediction | Work |
| --- | --- | --- |
| `current` or `compatible` | `current` or `compatible` | none |
| `current` or `compatible` | `stale` | `prediction_only` |
| `stale` | any | `fingerprint_and_prediction` |

A new fingerprint version always has a new hash, so the dependent prediction is regenerated with it. A diagnostic-only change is declared so that no stored fingerprint needs rewriting.

## Storage

Three parts, the first two immutable and create-only:

| Part | Identity | Holds |
| --- | --- | --- |
| content body | `fingerprintHash` | the fingerprint content; shared by every generation with equal content |
| generation record | `(fingerprintHash, fingerprintSchemaVersion, fingerprintPromptVersion)` | the versions, first `generatedAt`, and `generated` or `partial` with its fields |
| pointer `fingerprint.json` | one per film | the current and the previous generation record |

- The fingerprint rule reads the prompt version from the generation record the pointer names.
- A prediction depends on the content hash, so a new generation record with the same body keeps it current.
- Restoring the pointer to a stored generation record is the only rollback that avoids a model run.

Objects under `enrichment/films/<id>/`:

| Object | Written | Content |
| --- | --- | --- |
| `fingerprints/<fingerprintHash>.json` | create-only, with `FINGERPRINT_VERSION_OBJECTS=on` | the content: the submitted fingerprint fields, `filmId` and `fingerprintHash`; a different text under the same key is a storage conflict and the submit fails |
| `fingerprint-generations/<fingerprintHash>-s<schema>-p<prompt>.json` | create-only, with the flag on | `{filmId, fingerprintHash, fingerprintSchemaVersion, fingerprintPromptVersion, generatedAt, produced, fields?, previous}`; an object already under the key is accepted only when it parses as a record of the same film, hash and versions with valid provenance and a stored body (it then keeps its first values); anything else is a storage conflict and the film's submit fails |
| `fingerprint.json` | always, last | the full current record every reader understands (content, `generatedAt`, `invalidatedAt`), plus `fingerprintPromptVersion`, `produced` (`generated`, `partial` with `fields`, or `restored`) and `previous` (`{fingerprintHash, fingerprintSchemaVersion, fingerprintPromptVersion}` of the record it replaced, or null) |

A pointer written before the prompt version existed has none of the three provenance fields and reads as prompt version 1, `generated`, no predecessor. The view index's `impactFeatures` facet also carries `fingerprintPromptVersion` (null for older entries, read as 1), so the queue evaluates from the index without opening fingerprints. Every reader keeps reading `fingerprint.json` alone.

## Queue and runner

The transition registry is the code constant `FINGERPRINT_TRANSITIONS` in `src/enrichment.js`, next to `FINGERPRINT_SCHEMA_VERSION` and `FINGERPRINT_PROMPT_VERSION`; its declarations are digested once per isolate, and a digest of the whole registry binds queues and runs to it. The evaluator derives every schema vocabulary from `FINGERPRINT_SCHEMA_BASE`, the frozen vocabulary of schema 1; `tests/fingerprint-migration-queue.mjs` checks that the registry applied to the base reproduces the live `MECHANICS`, `EXECUTION`, `GENERAL_EXECUTION` and genre domains, so a release cannot change a constant without declaring the transition.

**Queue.** Every refresh evaluates each film that has a fingerprint, from the index facet, in both fingerprint modes, and records `fingerprintCompatibility` next to the profile block of [prediction compatibility](prediction-compatibility.md#prediction-queue):

```json
{"mode": "strict", "evaluatorVersion": 1, "registryDigest": "<sha256>", "target": {"fingerprintSchemaVersion": 2, "fingerprintPromptVersion": 1, "predictionPromptVersion": 1},
 "films": 5, "unindexed": 0, "strict": {"current": 0, "stale": 4}, "selective": {"current": 2, "compatible": 0, "stale": 2},
 "reasons": {"exact": 2, "fingerprint_not_current": 2}, "fingerprintReasons": {"transition_unaffected": 2, "transition_impacted": 2},
 "migration": {"none": 0, "compatible": 2, "partial": 2, "full": 0, "global": 0},
 "classes": {"unchanged": 0, "missing": 1, "prediction_only": 0, "fingerprint_and_prediction": 4, "migration": 4, "unknown": 0},
 "wouldKeep": 2, "wouldRequeue": 0, "strictDisagreements": 0}
```

- `reasons` counts the selective prediction verdict, `fingerprintReasons` the selective fingerprint verdict, `migration` its work class.
- `classes` describes the decision in force: `unchanged` films are out of the queue; `missing` have no prediction; `prediction_only` and `fingerprint_and_prediction` are outstanding; `migration` counts outstanding films whose work comes from a transition (the fingerprint is stale, or the prediction prompt moved), `unknown` those whose outcome is fail-closed (`transition_unknown`, `transition_impact_unknown`, `film_features_unknown`, `prompt_transition_unknown`, `prompt_features_unknown`).
- `strictDisagreements` compares the decision in force with the evaluator in the same mode. Under `strict` it counts the films the evaluator judges differently from plain equality, for example a stored prompt version newer than the code's, which equality does not see.
- `work` maps each outstanding film to `{class, requiredWork, migration, reason, fields?}`; `migration` is `partial` (with the fields to regenerate), `full`, `global`, `prediction` (prompt axis) or null for work that is not a transition's. The queue also records `fingerprintSchemaVersion`, `fingerprintPromptVersion`, `predictionPromptVersion` and the registry digest it was built with.
- **Decision.** Under `strict` the queue decides as before the transition rule existed; the profile switch keeps its own meaning. Under `selective` one verdict per film decides: fingerprint, prediction prompt and (in the profile switch's mode) profile.

**Order.** Within the hot lane and the cold lane, films without a prediction come before migration work; then the existing order (urgency, deadline, availability, arrival, id). A new hot film therefore enters a batch ahead of waiting migration films, and the lanes keep their current meaning: hot first, then watchlist films of the cold lane; cold catalog films stay counted but outside the runner list.

**Batches.** `queueBatchIds` takes the ready ids in queue order and lets migration work fill at most half of the slots (rounded up, `FINGERPRINT_MIGRATION_SHARE`); missing work fills the rest; slots migration cannot fill stay empty. The runner's `start` and `next` both select through it, and the adaptive batch size, the lease and the quota rules are unchanged.

**Runner.** `start` records `fingerprintPromptVersion` and the registry digest with the schema and prediction prompt versions it already kept; `next`, `submit` and `complete` (without a reason) answer `409 {code: "contract_changed"}` when any of them differs from the Worker's, as they answer `Profile changed` for the profile hash. `next` reports `fingerprintPromptVersion` with the other versions and chooses `prediction_only` when the stored fingerprint is usable under the mode in force (exact under `strict`; exact or compatible under `selective`); `submit` accepts a new fingerprint only when the stored one is not usable, stamps the new prediction with the fingerprint's own schema version, and writes the fingerprint as described under [Storage](#storage). Under `selective`, `next` first restores a fingerprint whose stored versions are newer than the code's from a stored generation record that is exact for the code (`produced: restored`, no model call) and lists the film in the run's `restored`; without such a record the film regenerates.

## Readers and diagnostics

`predictionFreshness(env, profile)` fixes both switches, the profile snapshot, the registry digests and the target versions once per request. Its `state` and `indexed` checks decide for every consumer; its `work` (the combined verdict) and `fingerprintVerdict` explain in every mode, so a reader can name the reason the queue would record. Under `strict` the decisions are the exact equality checks of before; the verdicts then only explain.

| Consumer | Connection |
| --- | --- |
| Prediction queue | `indexed`, with the `fingerprintCompatibility` block and the `work` map ([above](#queue-and-runner)) |
| Runner `start`, `next`, `submit`, `complete` | `state`, `fingerprintUsable` and `work` ([above](#queue-and-runner)) |
| View `GET /api/enrichment/view` | `indexed` decides `stale` for every film; the programme and catalog genres are always read, for the selective profile rule; `compatibility` carries `profileMode`, `fingerprintMode` and the three target versions |
| Coverage in the status route and the prediction events | `indexed` |
| Catalog `GET /api/catalog/available` and therefore Finds | `indexed` |
| Queue status `GET /api/enrichment/queue/status`, MCP `enrichment_queue` | the stored `fingerprintCompatibility` block and the schema, prompt and prediction prompt versions the queue was built with (the per-film `work` map stays in the queue object) |
| Status `GET /api/enrichment/status`, MCP `enrichment_status` | `fingerprintPromptVersion` next to the schema and prediction prompt versions, and `compatibility: {profileMode, fingerprintMode}`; `profileMode` is always `selective` ([ADR 0043](../../adr/0043-retire-profile-compatibility-switch.md)) |
| Queue overview, MCP `prediction_queue_overview` | `snapshot.fingerprint`: the mode in force, the target versions and registry digest, and the stored block's classes and migration counts; `snapshot.reasons` gains `fingerprint_schema_differs`, `fingerprint_prompt_differs`, `prediction_prompt_differs` and `fingerprint_registry_differs` when the stored queue was built under other versions than the Worker's |
| Film diagnostics, MCP `prediction_film_diagnostics` | `fingerprint`: `current` (exact schema), `usable` (the verdict in force), `reason`, `migration`, `mode`, `promptVersion`, `produced`, `previous`; `prediction`: `reason` and `requiredWork` of the combined verdict, `fingerprintMode`, and `cause` judged with the usable fingerprint (`fingerprint_not_current` only when the fingerprint is not usable under the rule in force) |
| Index agreement and `index_ahead_of_queue` | `indexed` against `state` |
| Film/Person lifecycle reader and domain | an optional verdict per film, `fingerprintCompatible(id)` on the store next to `predictionCompatible(id)`: a true verdict makes a fingerprint of another schema version current with its own version as provenance, never an invalidated one; a true `predictionCompatible` verdict keeps a prediction that names the usable fingerprint (same hash and schema) current whatever profile or prompt version produced it, with that provenance; the prediction's schema provenance is compared with the fingerprint's own; without a verdict, strict |

Strict by contract, and unchanged: the D1 prediction projection (`src/prediction-repository.js`, no registry or lineage in D1), the isolated prediction benchmark (fresh trials against references made under the same versions) and the fingerprint-view backfill route (it writes the facet of an exact fingerprint only). The display facet of a usable fingerprint is kept in the index on submit and on the runner's repair, so a compatible fingerprint keeps showing its mechanics.

## Rollback

| Path | Effect |
| --- | --- |
| switch to `strict` | every non-exact fingerprint is stale: a full re-fingerprint after a non-identity transition, bounded per batch like any migration work |
| code rollback | safe only down to the release with immutable fingerprint versions and `fingerprint_ahead` handling |
| schema or prompt constant restored | under `selective`, the runner's `next` restores `fingerprint_ahead` fingerprints to a stored generation record that is exact for the code where one exists (written with `FINGERPRINT_VERSION_OBJECTS=on`), otherwise the film regenerates (the records are read page by page; a history over 1,000 records fails the step as a storage error rather than regenerating); a prediction made from the restored content is current again, one made from the newer content is `prediction_only`; history predictions are not promoted. Under `strict` the film regenerates in full |
| forced recompute | a `global` transition |
