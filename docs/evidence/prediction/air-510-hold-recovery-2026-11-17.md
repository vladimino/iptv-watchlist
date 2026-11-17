# AIR-510: held submit-ready items and honest complete (offline)

**Captured:** 17 Nov 2026 (UTC). Europe/Madrid same calendar day.
**Scope:** Offline Worker on sqlite D1 stand-in and in-memory R2. No production MCP write, Task edit, lease reset or live `prediction_batch_start`.
**Card:** [AIR-510](https://trello.com/c/01JAM4TP).

## Production FAIL that this tests (not repeated here)

Controller L0 D1 window 16 Nov 23:40–17 Nov 08:07 Europe/Madrid: 34 owned `batch_v2` runs, 25 `manifest_spent`, 9 `external_termination` with `firstSubmitAt=null`. Task B `946948a1-c2e2-4103-9cc0-777c7d6554f4` validated five films then lost submit-ready objects. Task A `fb56603c-fc6c-41ea-ae08-9bd69696e08b` lost the schema contract before preflight. Identical `manifestHash` later succeeded. Connected catalogs still omitted `prediction_batch_manifest`.

## Offline checks (`tests/prediction-batch-start.mjs`)

1. **Interrupt before validate.** Five-film start, drop the client copy of the contract, `prediction_complete({reason:'external_termination'})` → **409 `client_state_lost`** with the five `filmIds` and `manifestHash`. Completing with **`client_state_lost`** is HTTP 200 (honest stop).
2. **Interrupt after validate.** Same start, `POST /api/enrichment/batch/hold` of the five generated items, drop the client items, `external_termination` → **409 `held_unsubmitted`**. `batch/submit` with **`useHeld: true`** (no items) creates the five predictions; `manifest_spent` succeeds. Evidence is not regenerated.

`prediction_batch_validate` is not called in these fixtures (it remains I/O-free per ADR 0131). Hold stores the same objects a passing preflight would have accepted.

## Not proven

Live Scheduled Task discovery of `prediction_batch_manifest` / `prediction_batch_hold` after `listChanged: true`. A prompt GO to call hold. Production series after deploy.
