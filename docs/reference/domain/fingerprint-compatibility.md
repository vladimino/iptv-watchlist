# Fingerprint compatibility across schema and prompt versions

This page is the contract for keeping a stored fingerprint, and the predictions made from it, usable when the fingerprint schema, the fingerprint prompt or the prediction prompt changes. The decision is [ADR-0035](../../adr/0035-selective-fingerprint-transition-compatibility.md). It extends the outcome model of [prediction compatibility](prediction-compatibility.md) (ADR-0031).

**Status of the code.** The rule is implemented as the pure module `src/domain/fingerprint-compatibility.js` (evaluator, registry validator and the extended prediction check) and is not called by any consumer. Every consumer compares the fingerprint schema and the prediction prompt version by strict equality with the Worker constants (`FINGERPRINT_SCHEMA_VERSION`, `PREDICTION_PROMPT_VERSION`, both 1), and no fingerprint carries a prompt version. The [specification fixtures](../../../tests/fixtures/fingerprint-compatibility/cases.json) state the expected outcomes; `tests/fingerprint-compatibility-spec.mjs` keeps them aligned with the live vocabularies.

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

This storage is a precondition of activation, not current behaviour: `fingerprint.json` is currently replaced in place.

## Scheduling

Migration work joins the prediction queue:
- **Lane order:** hot (urgent first), watchlist, Finds, other cold. Within a lane, missing work precedes migration work, then the earliest availability deadline, then the film id.
- **Run limits:** migration items per run are capped.
- **Run binding:** a run ends with `contract_changed` when the Worker's fingerprint schema, fingerprint prompt, prediction prompt or profile hash differs from the one it started with.

## Rollback

| Path | Effect |
| --- | --- |
| switch to `strict` | every non-exact fingerprint is stale: a full re-fingerprint after a non-identity transition |
| code rollback | safe only down to the release with immutable fingerprint versions and `fingerprint_ahead` handling |
| schema or prompt constant restored | `fingerprint_ahead` fingerprints are restored to a stored current version where one exists, otherwise regenerated; predictions with the restored hash are current again; history predictions are not promoted |
| forced recompute | a `global` transition |
