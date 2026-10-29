# ADR 0035: A fingerprint stays usable across fingerprint schema and prompt versions only through a declared, typed transition evaluated by one shared rule

**Status:** Accepted (design only; it authorizes no fingerprint or prediction regeneration, model run, queue change, flag, Scheduled Task, R2 or D1 operation)  
**Original decision date:** 2026-10-28 (owner accepted)  
**Recorded at:** 2026-10-28  
**Approval source:** [owner's explicit Accepted decision recorded on AIR-33](https://trello.com/c/rBFiUUZQ#comment-6ae1b5871d105d86d6309487), following [positive independent re-review](https://github.com/vladimino/iptv-watchlist/pull/192#pullrequestreview-5679876831)  
**Related work:** [AIR-33](https://trello.com/c/rBFiUUZQ); successors [AIR-207](https://trello.com/c/GiFL0jy8), [AIR-208](https://trello.com/c/54RDVHNj), [AIR-209](https://trello.com/c/kDbOGZuj), [AIR-210](https://trello.com/c/DM1Rrnrz); [ADR-0031](0031-selective-prediction-profile-compatibility.md), whose outcome model this extends; [fingerprint contract audit](../evidence/prediction/air-33-fingerprint-contract-audit-2026-10-28.md); [specification fixtures](../../tests/fixtures/fingerprint-compatibility/cases.json)  
**Supersedes:** [ADR-0014](0014-fingerprint-prediction-lifecycle.md) and step 1 of [ADR-0031](0031-selective-prediction-profile-compatibility.md) section 3 **in part, from activation**:
- "fingerprint current means schema version equal to the code" becomes "the fingerprint is exact, or compatible through every declared transition between its versions and the code's";
- the prediction's fingerprint check becomes equality of the fingerprint **hash** alone, plus a declared transition rule for the prediction prompt.

Independent fingerprint and prediction freshness, prediction history and every profile rule of ADR-0031 stay as decided there.  
**Superseded by:** [ADR-0047](0047-retire-fingerprint-compatibility-switch.md) (Accepted 2026-10-29) in part: the mode switch and the feature rollback of section 7; the transition rule, the registry, storage, migration scheduling, the code rollback floor and the schema or prompt rollback stay

## Context

A fingerprint is the model's structured description of one film. A prediction is the model's personal score for that film, made from one exact fingerprint, one taste-profile version and one prediction prompt. Today every consumer requires `fingerprintSchemaVersion === 1` on the fingerprint and on the prediction ([audit](../evidence/prediction/air-33-fingerprint-contract-audit-2026-10-28.md)). Raising the schema constant would therefore make every fingerprint and every prediction stale at once: about 2,300 films would need a full model run, whatever the change was. That is the fingerprint-side twin of the problem ADR-0031 solved for profile edits.

The audit also found three gaps that any transition must close first:
1. **The fingerprint is overwritten in place.** `enrichment/films/<id>/fingerprint.json` is replaced whenever a submitted fingerprint arrives for a film whose stored one is not current. No earlier version is kept. A prediction in history can then name a `fingerprintHash` whose content no longer exists.
2. **The fingerprint prompt is not versioned.** Fingerprints carry the schema version only. The guidance the model follows lives in the Scheduled Task prompt and the runner instructions, and no record says which revision produced a fingerprint. Predictions already carry `predictionPromptVersion`.
3. **A run is not bound to the contract it started with.** Next, submit and complete end a run when the profile hash changes. A deploy that changes the fingerprint schema or a prompt version during a run is not detected; the run's later submits would be judged against the new constants.

## Decision

### 1. Version axes

| Axis | Source of truth | Stamped on | Value today |
| --- | --- | --- | --- |
| `fingerprintSchemaVersion` | Worker constant; the submit validator requires it as a constant field | the fingerprint (inside its hashed content) and, as provenance, every prediction made from it | 1 |
| `fingerprintPromptVersion` | Worker constant, published by the runner contract together with the schema version; the Scheduled Task prompt names the revision it implements | the fingerprint record at submit, **outside** the hashed content | not stamped |
| `predictionPromptVersion` | Worker constant (exists) | every prediction | 1 |
| `tasteProfileVersion` / `tasteProfileHash` | published profile ([ADR-0031](0031-selective-prediction-profile-compatibility.md)) | every prediction | per publication |

- **A stored fingerprint with no `fingerprintPromptVersion` reads as version 1.** Today every stored fingerprint counts as current, so this reading keeps every current outcome unchanged when the field is introduced. Any later prompt revision is a declared transition from 1.
- **`fingerprintPromptVersion` is outside `fingerprintHash`.** Two fingerprints with equal content are the same input to a prediction, whichever prompt produced them. The prompt provenance of each generation is kept in its own immutable generation record (section 2), not in the content.
- **Not version axes:** the runner `pipelineVersion` (protocol), `MOOD_MAPPING_VERSION` (a derived display vocabulary), the evaluator versions, and the D1 schema. Changing them never makes a fingerprint or a prediction stale.
- **Provenance is immutable.** A fingerprint keeps the schema and prompt versions that produced it, and a prediction keeps its `fingerprintHash`, `fingerprintSchemaVersion` and `predictionPromptVersion`. No transition, migration or repair stamps a newer version onto an older record. A record is kept by being judged compatible, never by being rewritten.

### 2. Immutable fingerprint versions (precondition)

Before any transition other than `identity` is activated, fingerprint storage follows the pattern prediction version objects already use ([ADR-0019](0019-live-d1-backfill-boundaries.md) item 4). It separates **what** was generated from **how**:

- **Content body.** One immutable object per distinct content, addressed by `fingerprintHash`, written create-only. Identical content from any generation shares one body.
- **Generation record.** One immutable record per distinct `(fingerprintHash, fingerprintSchemaVersion, fingerprintPromptVersion)`, written create-only. It holds:
  - those three values;
  - the first `generatedAt`;
  - how it was produced: `generated`, or `partial` with the regenerated fields.

  This is the fingerprint's provenance. A regeneration under another prompt with identical content reuses the body and adds its own generation record; the earlier record stays.
- **Pointer.** `fingerprint.json` names the current generation record and the previous one. The pointer is the only mutable part. It moves only after the body and the record exist, and a restoration (section 7) moves it to an existing record.
- **Nothing immutable is rewritten or deleted.**

**Consequences of the split:**
- The fingerprint rule (section 4) evaluates the generation record the pointer names: its prompt version is that record's, not the body's.
- A prediction depends on the content: it records the `fingerprintHash` and the schema version (part of the content). A new generation record with the same body therefore keeps the prediction current.
- Rollback restores a generation record, so the prompt provenance after a rollback is the restored record's.

The object key layout and the record field names are decided by the implementing card. The D1 `fingerprint_payload` table already records the pointer and the R2 key of the body; it needs no change for this decision.

### 3. Transition declarations

A version change on one axis ships with a **transition declaration** in an append-only registry in the Worker code. It is reviewed in the same pull request that changes the constant:

```json
{"transitionSchemaVersion": 1,
 "axis": "fingerprint_schema",
 "from": 1, "to": 2,
 "scope": "selective",
 "changes": [{"kind": "value_split", "field": "plotMechanics", "from": "chase_escape", "to": ["chase", "escape"]}],
 "selectors": [{"kind": "mechanic", "values": ["chase_escape"], "regenerate": {"mode": "partial", "fields": ["plotMechanics"]}}],
 "approval": {"approvedBy": "owner", "approvedAt": "<ISO time>", "reviewRef": "<id of the owner's recorded decision>",
              "declarationSha256": "<SHA-256 of the canonical [axis, from, to, scope, changes, selectors]>"}}
```

- **The registry is code, not stored data.** A transition is part of a release. Its content never changes after release, and tests pin each released declaration by its hash. Each axis forms one contiguous chain: `from` names the previous `to`, and versions increase.
- **`scope`** is one of:
  - `identity`: every stored fingerprint stays valid as it is, decided by the structural check of section 4;
  - `selective`: the selectors name the films the change can reach;
  - `global`: every film. The publisher may always choose `global`.
- **`changes`** is a closed, typed list of what changed:

| Change kind | Axis | Films it reaches | Allowed scopes |
| --- | --- | --- | --- |
| `value_removed`, `value_split`, `value_merged`, `value_renamed`, `value_redefined` | schema | films whose old field holds an old value; a `mechanic` or `execution` selector must include every old value | `selective`, `global` |
| `dimension_redefined` | schema | films with any value of the dimension; an `execution` selector on it | `selective`, `global` |
| `dimension_added` (genre-specific, with a closed genre domain) | schema | films in the domain; a `genre` selector must include the whole domain (genre floor). The dimension is **optional** in the target validator, as every genre-specific dimension of the live schema is; a declaration with a domain and `required: true` is `change_invalid` | `selective`, `global` |
| `value_added`, `prompt_revised` | schema, prompt | not provable: any film may now qualify for the new value or the revised guidance; the owner's selectors | `selective` (owner-approved), `global` |
| `constraint_tightened` | schema | films whose stored fingerprint fails the new rule (section 4); no selector | `identity`, `selective`, `global` |
| `constraint_relaxed`, `field_removed`, `dimension_removed` | schema | none | `identity`, `selective`, `global` |
| `field_added`, `field_redefined`, a general `dimension_added` | schema | every film: no selector kind reads text fields, and a new required field is missing everywhere | `global` |

- **Selectors** use the kinds of ADR-0031: `mechanic`, `execution` and `genre`. They are evaluated on the **old** fingerprint, in the vocabulary of its own schema version, and on the film's current metadata genres through the closed alias table. Each selector names its work: `regenerate.mode` is `partial` (only the listed fingerprint fields), `full` (the whole fingerprint), or, on the prediction prompt axis only, `prediction`. Selectors in one declaration are OR'ed.
- **Partial regeneration** keeps every other field from the previous version and produces a new version with a new hash. Until the runner can request a partial fingerprint, `partial` runs as `full`. That costs more model work; it never keeps a wrong field.
- **Validation** rejects the whole registry, which then counts as unknown (every link global, section 4), unless every transition passes, in this order:
  1. a known schema (`transition_schema_unknown`) and axis (`axis_unknown`);
  2. increasing versions (`version_not_increasing`) and a contiguous chain (`chain_broken`);
  3. a known scope (`scope_unknown`);
  4. known (`change_kind_unknown`) and valid changes, checked against the vocabulary of the `from` version; a genre-scoped added dimension must be optional (`change_invalid`);
  5. an `identity` declaration only with changes the structural check can decide (`identity_change_not_compatible`) and without selectors (`identity_has_selectors`);
  6. no `global`-only change in a `selective` declaration (`global_only_change`);
  7. selectors present (`selective_requires_selectors`), of a known kind (`selector_kind_unknown`) and valid, including the right `regenerate` mode for the axis (`selector_invalid`);
  8. every change covered as the table requires (`change_not_covered`), including the genre floor (`genre_floor_missing`);
  9. partial fields that include the changed field (`partial_fields_invalid`);
  10. for `selective`, a complete owner approval (`selective_requires_owner_approval`) whose `declarationSha256` equals the SHA-256 of the canonical declaration (`approval_mismatch`).

  `identity` and `global` need no approval.
- **Trust model**, as in ADR-0031 section 4a:
  - **Guaranteed mechanically:** closed kinds, the coverage of value-level and dimension-level changes, the genre floor of an added dimension, the structural check, and fail-closed handling of every unknown.
  - **Decided by the owner:** that a `selective` declaration reaches every film the change can affect. This matters most for `value_added` and `prompt_revised`, whose reach no table can prove.

  Every change is global by default; selective scope needs an approval bound to the exact declaration.

### 4. The fingerprint rule

`fingerprintCompatibility(fingerprint, metadata, registry, target, mode)` is a pure function. `target` holds the code's `fingerprintSchemaVersion` and `fingerprintPromptVersion`. It returns `{outcome, reason, migration, fields, links}`:
- `outcome` is `current`, `compatible` or `stale`;
- `migration` is `none`, `compatible`, `partial`, `full` or `global`.

Checks, in order:
1. No fingerprint → `stale/fingerprint_missing`, `full`. `invalidatedAt` set → `stale/fingerprint_invalidated`, `full`.
2. A schema or prompt version newer than the target → `stale/fingerprint_ahead`, `full` (see rollback, section 7).
3. Both versions equal the target → `current/exact`, `none`.
4. Mode `strict` → `stale/fingerprint_version_changed`, `full` (today's behaviour).
5. Walk the links from the fingerprint's versions to the target, on both fingerprint axes. Every link is evaluated; the first stale link gives the reason, and the widest work wins (`global` > `full` > `partial`, partial fields united):
   - no registry path to the target → `stale/transition_unknown`, `global`;
   - an invalid registry or link (section 3) → `stale/transition_impact_unknown`, `global` (**unknown means global**);
   - `global` → `stale/transition_global`, `global`;
   - `selective`: a reached film → `stale/transition_impacted`, with the selector's work; otherwise an unknown feature (no genres, an unmapped genre, an absent or `unknown` value for an `execution` selector, absent `plotMechanics` for a `mechanic` selector, or a stored value outside the fingerprint's own vocabulary) → `stale/film_features_unknown`, `full`; otherwise the selectors pass;
   - **structural check**, once, on `identity` and `selective` schema links after their selectors: the stored fingerprint must pass the target schema's validator. Two things are ignored:
     - its own version constant;
     - the old values that value-level changes anywhere on the path name. Coverage (section 3) guarantees that a film holding one is reached by that link's selector.

     A genre-scoped added dimension is optional, so its absence never fails this check; whether the film needs it is decided by the genre floor. Failure → `stale/fingerprint_structure_incompatible`, `full`. A partial regeneration therefore never keeps a field that fails the new schema. Otherwise the link passes.
6. All links pass → `compatible/transition_unaffected`, `compatible`.

`current` and `compatible` are both "not stale" for every consumer. A compatible fingerprint is served as it is stored: its record, its hash and its versions are unchanged.

**Cross-rule with ADR-0031.** A profile selector is read against the fingerprint the prediction was made with, in that fingerprint's own schema vocabulary. A selector value that does not exist there (for example `chase` against a schema-1 fingerprint that still says `chase_escape`) is an unknown feature, so `stale/film_features_unknown`. A kept old fingerprint therefore never proves a film unaffected by a profile edit written in the new vocabulary.

### 5. The prediction boundary

Step 1 of ADR-0031 section 3 becomes the following. The rest of that rule (profile steps 2–7) is unchanged.

1. The film's current fingerprint is not `current` or `compatible` under section 4 → `stale/fingerprint_not_current`.
2. The prediction's `fingerprintHash` differs from the current fingerprint's → `stale/fingerprint_changed`. The same hash with another `fingerprintSchemaVersion` → `stale/fingerprint_provenance_mismatch`, which is impossible for consistent data, so it fails closed.
3. Prediction prompt:
   - In mode `strict`, a different version → `stale/prompt_changed`.
   - In mode `selective`, a version newer than the target → `stale/prompt_ahead`.
   - Otherwise walk the `prediction_prompt` links:
     - a missing path or an invalid link → `stale/prompt_transition_unknown`;
     - `global` → `stale/prompt_global_change`;
     - reached by a selector (features from the prediction's own fingerprint) → `stale/prompt_impacted`;
     - an unknown feature → `stale/prompt_features_unknown`;
     - every link passes → `compatible/prompt_unaffected`.

The required work for a film follows from the two verdicts:

| Fingerprint | Prediction | Work | Effect |
| --- | --- | --- | --- |
| `current` or `compatible` | `current` or `compatible` | none | both records kept, provenance unchanged |
| `current` or `compatible` | `stale` | `prediction_only` | the stored fingerprint is reused; the new prediction carries the current profile, prompt version and that fingerprint's hash and schema |
| `stale` (`partial`, `full`, `global`) | any | `fingerprint_and_prediction` | a new fingerprint version is written, so the hash changes; the dependent prediction is regenerated |

- **A fingerprint change always regenerates the dependent prediction.** Every fingerprint field is input to the prediction model: the runner sends the whole fingerprint. A diagnostic-only edit is handled by declaring it so that no stored fingerprint needs rewriting (`constraint_relaxed`, `field_removed`, an `identity` declaration). Then nothing is regenerated. If a rewrite is needed, the prediction is regenerated too.
- **Queue and reader agreement** (ADR-0031 section 5) extends to the new verdict. For every film the queue considers, *pending* ⇔ fingerprint `stale` or prediction `stale`. Every consumer uses the same registry, target and mode. The queue records the registry digest and mode it was built with; diagnostics report a disagreement as an inconsistency.

### 6. Migration scheduling

The future migration queue applies these rules (the exact sizes and fields are decided by the implementing card):
- **One queue.** Migration work joins the existing prediction queue; there is no second runner.
- **Priority, in order:**
  1. hot films (the urgent rank first, then the rest of the hot window);
  2. watchlist films;
  3. Finds candidates;
  4. other cold films.

  Within a lane, missing work comes before migration work, then the earliest availability deadline, then the film id. New hot work therefore always preempts the migration backlog.
- **Bounded batches.** Migration items are capped per run within the adaptive batch, and the existing quota and lease rules stop a run as they do today.
- **Version conflicts.** A run is bound to the fingerprint schema, fingerprint prompt, prediction prompt and profile hash it started with. Next, submit and complete end it (`contract_changed`) when any of them differs from the Worker's, as they already do for the profile hash. Submit stamps the Worker's versions and refuses a fingerprint whose schema constant differs from the target, as today.
- **Repeated application is a no-op.** A migrated or compatible film evaluates `current` or `compatible` and has no work. A regenerated fingerprint equal to a stored version reuses its body and, under the same versions, its generation record (section 2).

### 7. Modes and rollback

- **Mode.** A separate switch, default `strict` (today's behaviour), moves every consumer from exact version equality to this rule. A shadow stage evaluates `selective`, decides `strict` and only counts differences. The switch name and values are registered with the implementation. Changing it in production is a separate owner approval.
- **Feature rollback** is mode `strict`. Every non-exact fingerprint becomes stale, so after a non-identity transition this means a full re-fingerprint of the catalogue. It is the costly last resort, not the first reaction.
- **Code rollback** is safe only down to the release that introduced immutable fingerprint versions and `fingerprint_ahead` handling, the **rollback floor**. Code below the floor overwrites `fingerprint.json` and would lose versions; it must not be deployed once a transition is active.
- **Schema or prompt rollback** above the floor:
  - A fingerprint newer than the restored constant is `fingerprint_ahead`.
  - The scheduler first looks for a stored generation record of that film that is `current` for the restored target. When one exists, it moves the pointer back to it, with no model run and no rewrite.
  - When none exists, the film is regenerated.
  - Predictions in history are not promoted back to current (as in ADR-0031). A prediction whose `fingerprintHash` equals the restored record's is current again by the hash rule.
- **Forced recompute** is a `global` transition.

### Not decided here

Not decided here, and why:
- The evaluator module layout and feature extraction belong to AIR-207.
- The version-object key layout, pointer fields and migration queue fields belong to AIR-208.
- Reader payloads and diagnostics belong to AIR-209.
- Activation steps belong to AIR-210.
- How the runner requests a partial fingerprint is open.
- Deterministic derivation without a model run (applying a rename or merge mechanically) is open: the first version regenerates through the model.
- A prediction-input projection that would let diagnostic-only fingerprint edits keep predictions is open.

No Mermaid diagram changes in this decision. The [prediction pipeline diagram](../architecture/prediction-pipeline.md) stays accurate until activation, and the implementing card updates it under the owner's rendered visual gate.

## Dependency graph for the successor cards

| Card | Delivers | Needs |
| --- | --- | --- |
| [AIR-207](https://trello.com/c/GiFL0jy8) | Pure fingerprint rule (section 4) and the extended prediction check (section 5), the registry validator (section 3), all passing every [fixture](../../tests/fixtures/fingerprint-compatibility/cases.json); synthetic tests | this ADR accepted |
| [AIR-208](https://trello.com/c/54RDVHNj) | Immutable fingerprint versions and pointer (section 2), `fingerprintPromptVersion` stamping, run binding to the contract, migration work in the queue with priorities and caps (section 6), counters in shadow | AIR-207 |
| [AIR-209](https://trello.com/c/kDbOGZuj) | Every reader and diagnostic on the shared rule; queue/reader agreement; fail closed on unknown | AIR-208 |
| [AIR-210](https://trello.com/c/DM1Rrnrz) | Owner-approved staged activation, rollback to `strict` and pointer restoration rehearsed | AIR-209 |

## Alternatives considered

- **Keep strict schema equality.** Rejected: correct, but any schema change re-fingerprints and re-predicts the whole catalogue.
- **Rewrite old fingerprints to the new schema version.** Rejected: destroys provenance, changes the hash every prediction depends on, and loses the record a rollback needs.
- **A separate compatibility model for fingerprints.** Rejected: ADR-0031 already defines outcomes, fail-closed unknowns, lineage walking and owner-bound approvals; a second vocabulary would let the queue and the readers diverge.
- **Store transitions as published data, like profile versions.** Rejected: the schema and prompt constants change only with a code release, so the declaration belongs in the same reviewed change and needs no publication API.
- **Let the model or the server infer impact from the schema diff.** Rejected: not deterministic and not reviewable.
- **Treat every fingerprint without a prompt version as unknown.** Rejected: it would make the first prompt revision global by construction and changes nothing about today's risk, since those fingerprints count as current now.
- **Keep the prediction when only diagnostic fields of a rewritten fingerprint changed.** Deferred: it needs a fixed prediction-input projection that the runner sends instead of the whole fingerprint; without it, every field is input.
- **Unknown features or a missing transition treated as compatible.** Rejected: fails open. Unknown is always global or stale.

## Consequences

- **Cost in proportion to reach.** A fingerprint schema or prompt change costs model runs in proportion to the films it can reach. Value-level and dimension-level changes have mechanically checked coverage; new values and prompt revisions need the owner's approval or are global.
- **A storage precondition.** Fingerprint history becomes immutable before the first transition, so history and rollback stop depending on a mutable pointer.
- **One more input.** Every consumer gains one more input, the registry, and one more shared function, and the queue/reader invariant covers both verdicts.
- **Residual risk:** a wrongly approved selective declaration. It is visible in the released registry with its approval, and recoverable by a `global` transition or by strict mode.

## Recovery and migration boundary

This ADR changes no code or data. Its acceptance authorizes none of these:
- a fingerprint or prediction regeneration or model run;
- a queue rebuild or a mode switch;
- a Scheduled Task prompt change;
- an R2 or D1 read or write.

Each successor card is a separate PR; activation (AIR-210) needs its own owner approvals. Rollback paths are in section 7; none of them rewrites a fingerprint or a prediction.

## Evidence

- **Audit:** [fingerprint and prediction contracts on `main` `c435504`](../evidence/prediction/air-33-fingerprint-contract-audit-2026-10-28.md)
- **Specification:** [fixtures](../../tests/fixtures/fingerprint-compatibility/cases.json), checked by `tests/fingerprint-compatibility-spec.mjs`. The test checks them against the live mechanic, execution and genre vocabularies, derives each synthetic schema from the live one through its declared changes, and decides every declaration case with the validation order of section 3.
- **Uncertainty:**
  - The reach of `value_added` and `prompt_revised` cannot be proven by the system; it is an owner decision, bound by approval.
  - Which Scheduled Task prompt revisions produced today's fingerprints is not recorded; section 1 reads them all as version 1, as today's code does.

## Follow-ups

[AIR-207](https://trello.com/c/GiFL0jy8) → [AIR-208](https://trello.com/c/54RDVHNj) → [AIR-209](https://trello.com/c/kDbOGZuj) → [AIR-210](https://trello.com/c/DM1Rrnrz).
