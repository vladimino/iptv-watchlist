# ADR 0045: Every committed prediction is written as an immutable version object, and PREDICTION_VERSION_OBJECTS is retired

**Status:** Proposed (owner flag disposition given; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, keeping the behaviour of the current value, given in the AIR-226 session on 2026-10-29; acceptance of this record is pending; separate approval is required to delete the production binding  
**Related work:** [AIR-226](https://trello.com/c/Upzk5DqR); prerequisites [AIR-164](https://trello.com/c/iZzON44A) (writer) and [AIR-195](https://trello.com/c/8gzh6iES) (activation readiness); [AIR-74](https://trello.com/c/5AdAmKPe); [ADR-0019](0019-live-d1-backfill-boundaries.md) item 4; [ADR-0026](0026-historical-prediction-version-materialization.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0026](0026-historical-prediction-version-materialization.md) in part: the second gate of decision 3 (`PREDICTION_VERSION_OBJECTS=on` for a write batch, refusal `version_objects_off`); the `PREDICTION_MATERIALIZATION` gate and every other part of the operation stay  
**Superseded by:** None

## Context

AIR-164 added the immutable prediction version writer behind `PREDICTION_VERSION_OBJECTS`, enabled only by the exact string `on`, because turning it on changes what every prediction submit writes to R2. The owner set it on 27 October 2026 at about 17:42 UTC under the approval recorded on AIR-74. The read-only check of 28 October found every one of the 89 films committed since then linked to an existing version object whose bytes match the pointer checksum and the writer's canonical body, with no `storage_error` stop. The one-time materialization of historical records (ADR-0026) ran on 28 October with the writer on. The owner-only `feature_flags` read of 2026-10-29 08:42 UTC showed `PREDICTION_VERSION_OBJECTS` set to `on` and valid.

Two things now depend on the writer staying on. ADR-0019 item 4 makes immutable versions the prerequisite of the prediction import, and ADR-0026 kept a second gate on the materialization route only because a submit with the writer off would put an unlinked record back into a materialized bundle. Switching the writer off is therefore no longer a safe rollback: it would undo what the materialization established.

## Decision

1. **The submit always writes the version object.** A submit that creates or recalculates a prediction writes `enrichment/films/<id>/predictions/versions/<sha256>.json` create-only before the bundle and stores `r2Key` and `contentSha256` on the record, which is the behaviour of the production value `PREDICTION_VERSION_OBJECTS=on`. The key, the canonical body, the byte check of an existing object, the write order and the `storage_error` handling of a conflict are unchanged.
2. **`PREDICTION_VERSION_OBJECTS` is retired.** The Worker never reads it, and a binding of any value is inert; `off` no longer stops the writer. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. **The materialization route has one gate.** A write batch of `POST /api/enrichment/predictions/materialize` needs `PREDICTION_MATERIALIZATION=on` only; the refusal `409 version_objects_off` no longer exists. The reason for the second gate is now guaranteed by code. The dry run, the writer lease, the per-film preconditions, receipts and outcome classes are unchanged, as are the offline plan and rehearsal.
4. **Stopping the writer is a code revert, never a flag.**
5. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `PREDICTION_VERSION_OBJECTS` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-226: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the version key, body, pointer rule, the readers, the materialization operation beyond its gates, or the D1 import. Neither the acceptance of this record nor the approval of its PR authorizes a settings change, a submit, a materialization batch or an R2 write; the binding removal in decision 5 needs its own owner authorization.

## Alternatives considered

- **Retain as a permanent operational gate.** Considered and not chosen by the owner. Its only use would be to stop the writer, and stopping it re-creates unlinked records in bundles that the materialization linked, which the D1 import then rejects. A storage failure of the writer already stops the run with `storage_error` and leaves the bundle unchanged.
- **Retire after stabilization.** Not chosen. The writer has run in production since 27 October, was verified on every film committed in its first day, and the materialization that depends on it has run; no further rollout step depends on the switch.

## Consequences

- One write path for the submit, and one gate for the materialization route. The `off` branch, the `version_objects_off` refusal, their tests and their documentation go away.
- The writer can no longer be switched off at runtime. A version write that fails stops the run as `storage_error`, exactly as before.
- Until the owner removes it as the last step of AIR-226, the leftover `PREDICTION_VERSION_OBJECTS` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back and the leftover binding `on` keeps the writer on. After the binding is removed, a revert to code that reads the switch also needs `PREDICTION_VERSION_OBJECTS=on` restored on Worker `iptv` (owner authorization), or new submits write records without a pointer. Version objects already written stay in R2 in every case; the Worker never deletes. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition in the AIR-226 session on 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `scripts/prediction-versions-materialize.mjs`, `tests/prediction-versions.mjs`, `tests/prediction-materialization.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** [AIR-74 version writer check](../evidence/prediction/air-74-version-writer-production-check-2026-10-28.md) (89 of 89 films linked, no storage-error stop); [AIR-74 materialization apply](../evidence/prediction/air-74-materialization-apply-2026-10-28.md); `feature_flags` read 2026-10-29 08:42 UTC: `PREDICTION_VERSION_OBJECTS` `state: set`, `raw: on`, `valid: true`, `effective: on`, `PREDICTION_MATERIALIZATION` absent. After deployment, a `feature_flags` read showing the switch as retired, and, at the next naturally scheduled run that commits a prediction, a read-only check of one touched bundle's pointer, are the acceptance steps; no run is started for them.
- **Uncertainty:** none on behaviour. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-226: the binding removal and its readback (decision 5) close that card.
