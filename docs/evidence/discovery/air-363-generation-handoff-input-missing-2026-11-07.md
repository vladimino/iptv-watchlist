# AIR-363: `input_missing` in the generation handoff window

**Captured:** 2026-11-07 (UTC). **Method:** code reading and offline tests only (`tests/d1-enrichment.mjs` block 15, `tests/discovery-workflow.mjs`). No production read or write; Worker observability for the 2026-11-06 16:00-17:30 UTC window returned no line containing `input_missing`, so the original record is not independently re-read here.

## Where the text comes from

`input_missing: <key>` is the message of `D1EnrichmentInputError` in `src/d1-enrichment.js`. `reconcileDiscoveryWorkflow` and `ensureDiscoveryWorkflow` never read `epg/generations/<run>/discovered-films.json` and have no such error. The hourly cron runs both in one firing; the text came from the D1 enrichment projector's summary (`outcome: failed`, `reason: input_missing`, `inputKey: epg/generations/<published run>/discovered-films.json`).

## Source of the failure

In the ADR 0092 window the D1 ledger is committed for run B and the discovery authority names B, while the published pointer still names A. The projector reads the published generation's catalog copy from R2. Under D1 discovery authority that R2 copy of A is a compatibility mirror and may be absent, so the projector failed on an absent mirror of the old generation instead of waiting for the pointer to move. Whether the copy of A was absent because of an earlier failed mirror write was not established from production data.

## Reconcile in the same window

Already fail-closed (ADR 0093): the pin B differs from the published A, so it answers `generation_handoff`, creates nothing and writes nothing. The test now also runs three concurrent crons in the window (all `generation_handoff`, no create, no write), and after the pointer is B a reconcile opens one successor and a repeat creates nothing more.

## Change

The projector reads the discovery authority before its reads. When the authority names another run than the published pointer it defers as `generation_pending` (`inputKey: discovery_authority`) before any catalog read or D1 write. An unreadable authority leaves the previous behaviour. Outside the window a missing copy is still `failed`/`input_missing`.

The guard repeats right before the D1 write, so an authority that moves to the next run while the plan is built defers the run with nothing written (offline race test; removing the second check fails it). A D1 authority that cannot be read or is held defers as `authority_unavailable` instead of guessing; an authority that is not D1 has no window and the R2 catalog stays the source. The remaining gap between the second check and the write is milliseconds, and a projection of the still-published run A is correct data for the pointer that is still A, so it does no harm.

Offline results: in dry and on, two crons and a newer pointer all defer with no catalog read and no batch; the missing copy outside the window stays `failed`; after the handoff the projection completes. Reverting the change fails the test. The next hourly run after the publish projects on its own. Production behaviour is not measured.
