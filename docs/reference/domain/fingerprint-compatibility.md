# Fingerprint compatibility across schema and prompt versions

This page is the contract for keeping a stored fingerprint, and the predictions made from it, usable when the fingerprint schema, the fingerprint prompt or the prediction prompt changes. The decision is [ADR-0035](../../adr/0035-selective-fingerprint-transition-compatibility.md). It extends the outcome model of [prediction compatibility](prediction-compatibility.md) (ADR-0031).

**Status of the code.** The rule is specified, not implemented. Every consumer compares the fingerprint schema and the prediction prompt version by strict equality with the Worker constants (`FINGERPRINT_SCHEMA_VERSION`, `PREDICTION_PROMPT_VERSION`, both 1), and no fingerprint carries a prompt version. The [specification fixtures](../../../tests/fixtures/fingerprint-compatibility/cases.json) state the expected outcomes; `tests/fingerprint-compatibility-spec.mjs` keeps them aligned with the live vocabularies.

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
| `change_invalid` | a change names a value or dimension absent from the `from` vocabulary, or adds one already present |
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
fingerprintCompatibility(fingerprint, metadata, registry, target, mode)
// target: {fingerprintSchemaVersion, fingerprintPromptVersion}
// -> {outcome: 'current'|'compatible'|'stale', reason, migration: 'none'|'compatible'|'partial'|'full'|'global', fields, links}
```

The first deciding check wins:

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
| stored fingerprint fails the target validator, ignoring its version constant and the old values named by value-level changes on the path | `stale/fingerprint_structure_incompatible` | `full` |
| reached by a selector | `stale/transition_impacted` | the selector's `partial` (fields united across links) or `full` |
| an unknown feature | `stale/film_features_unknown` | `full` |
| every link passes | `compatible/transition_unaffected` | `compatible` |

Links on both fingerprint axes are walked in order. The first stale link gives the reason, and the widest migration wins.

A profile selector (ADR-0031) is read against the fingerprint a prediction was made with, in that fingerprint's schema vocabulary. A selector value that vocabulary lacks is an unknown feature.

## Prediction check

This replaces step 1 of the [prediction compatibility order of checks](prediction-compatibility.md#order-of-checks); steps 2–7 are unchanged.

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

Fingerprint versions are immutable objects addressed by `fingerprintHash` and written create-only; `fingerprint.json` is the pointer and names its previous version and how it was produced (`generated`, `partial`, `restored`). Pointer restoration to a stored version is the only rollback that avoids a model run. This storage is a precondition of activation, not current behaviour: `fingerprint.json` is currently replaced in place.

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
