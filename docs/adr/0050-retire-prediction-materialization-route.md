# ADR 0050: The one-time prediction version materialization route and PREDICTION_MATERIALIZATION are retired

**Status:** Proposed (owner decision `retire now` recorded; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner decision `retire now` recorded on AIR-227 on 2026-10-29: remove the `PREDICTION_MATERIALIZATION` switch and the one-time route entirely, keep neither as a permanent tool; acceptance of this record is pending  
**Related work:** [AIR-227](https://trello.com/c/KjFwF0Zp); prerequisite [AIR-179](https://trello.com/c/vdLts7tJ) (route, CLI and rehearsal); [AIR-74](https://trello.com/c/5AdAmKPe) (the production run); [AIR-226](https://trello.com/c/Upzk5DqR); [ADR-0026](0026-historical-prediction-version-materialization.md); [ADR 0045](0045-retire-prediction-version-objects-switch.md); [ADR 0040](0040-retire-ratings-only-refresh.md) (the precedent for a retired route); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0026](0026-historical-prediction-version-materialization.md) for its route, its gate and its CLI after the completed run: decisions 2, 3 and 7 and the `rehearse`, `validate` and `apply` steps. Its record of how the run was done, the plan rule (decision 1), the per-film rule (decision 4) and the meaning of its receipts (decision 5) stay as history  
**Superseded by:** None

## Context

ADR-0026 added `POST /api/enrichment/predictions/materialize`, gated by `PREDICTION_MATERIALIZATION`, and the CLI `scripts/prediction-versions-materialize.mjs` (`plan`, `rehearse`, `validate`, `apply`) to link historical prediction records to immutable version objects once, before the D1 backfill. AIR-74 ran it in production on 28 October 2026 under owner approval: 47 of 47 batches sealed, 2,346 records processed (2,306 materialized, 40 already materialized), none incomplete; the reconciling snapshot found 2,670 linked records with none pending, missing or mismatched. The switch was set only for that run and then removed. Since ADR 0045 every new prediction is written as an immutable version on submit, so no new unlinked record arises. The owner-only `feature_flags` read of 2026-10-29 22:59 UTC showed `PREDICTION_MATERIALIZATION` absent.

The route can rewrite prediction bundles in bulk. Leaving it in code after its only job is done keeps a bulk writer that a single settings change would reopen.

## Decision

1. **The route is retired.** `POST /api/enrichment/predictions/materialize` (any method) answers `410 Gone` with `{error: "gone", detail}` before reading the body, as the retired ratings-only refresh does (ADR 0040): no read, list or write, no lease, no receipt, no outbound request. The handler and its request validation are removed.
2. **`PREDICTION_MATERIALIZATION` is retired.** The Worker never reads it, and a binding of any value is inert. It stays in the `feature_flags` registry as retired, so an unexpected binding would be visible. The binding is already absent; none is created or removed for this retirement.
3. **The CLI is removed.** `scripts/prediction-versions-materialize.mjs` and its tests go away, so no command looks like a working production apply.
4. **Kept:** the submit's immutable version writer (ADR 0045); the shared body, key and pointer rules and the plan rule in `src/domain/prediction-versions.js`; `scripts/prediction-versions-plan.mjs`, the read-only check of a snapshot; the offline importer, which keeps classifying the receipts as run records; every stored version object, linked bundle with its `materialized` block and receipt under `enrichment/predictions-materialization/`.
5. **Reopening historical materialization needs a new decision**, a code change under a new ADR, never a flag.

Not decided here: anything about the D1 backfill gates of AIR-74, `REMOVAL_RATING_LOOKUP` or the writer. Neither the acceptance of this record nor the approval of its PR authorizes a settings change, an R2 or D1 write, or any production call.

## Alternatives considered

- **Keep the route as a permanent admin tool.** Rejected by the owner: no new unlinked record can arise, and a bulk bundle writer is a larger surface than any remaining use.
- **Keep the route behind its switch.** Rejected by the owner: the switch would be the only thing between a settings change and a bulk rewrite of prediction bundles.
- **Answer `404`.** Not chosen: `410 Gone` tells a caller of the old procedure that the route existed and is retired, as for the ratings-only refresh.

## Consequences

- One bulk prediction writer less; the submit is again the only prediction writer.
- The runbook keeps the outcome of the run and the read-only check; its procedure, outcome table and recovery steps for the route go away.
- A record found without a pointer in a later snapshot has no route to fix it; it needs a new decision.

## Recovery and migration boundary

Reversible by a code revert, which restores the route behind its gate; a write batch would then need `PREDICTION_MATERIALIZATION=on` set under a separate owner approval. Nothing stored changes in either direction: objects, bundles and receipts stay. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner decision recorded on AIR-227 on 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `tests/prediction-materialization.mjs` (rewritten for the retired route), `tests/prediction-versions.mjs`, `tests/feature-flags.mjs`; removed `scripts/prediction-versions-materialize.mjs`.
- **Dated verification:** [AIR-74 apply evidence](../evidence/prediction/air-74-materialization-apply-2026-10-28.md) and [validate evidence](../evidence/prediction/air-74-materialization-validate-2026-10-28.md); `feature_flags` read 2026-10-29 22:59 UTC: `PREDICTION_MATERIALIZATION` `state: absent`, `valid: true`, `effective: off`. After deployment, a `feature_flags` read showing it `retired` and `absent` with 0 invalid is the acceptance step; the route is not called in production for it.
- **Uncertainty:** none on behaviour.

## Follow-ups

None.
