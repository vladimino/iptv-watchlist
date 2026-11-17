# AIR-510: transferable stage drained by the next run (offline)

**Captured:** 17 Nov 2026 (UTC). Europe/Madrid same calendar day.
**Scope:** Offline Worker on sqlite D1 stand-in and in-memory R2. No production MCP write, Task edit, lease reset or live `prediction_batch_start`.
**Card:** [AIR-510](https://trello.com/c/01JAM4TP).

## Production FAIL and owner BLOCK

Controller L0 D1 window 16 Nov 23:40–17 Nov 08:07 Europe/Madrid: 34 owned `batch_v2` runs, 25 `manifest_spent`, 9 `external_termination` with `firstSubmitAt=null`. Owner BLOCK on PR #704 HEAD `b12b5bd2`: run-scoped hold recovery is not accepted. A terminated Task must not strand staged predictions; the next scheduled start must commit them.

## Offline checks (`tests/prediction-batch-start.mjs`)

1. **Live-prompt complete.** Five-film start, `external_termination` → HTTP 200, lease released, next start is a new run (not `already_running`).
2. **A stages, B drains.** Twelve eligible films. A starts 5, MCP `prediction_batch_validate` (`storage: not_accessed`), concurrent hold CAS-merge, digest conflict, `external_termination` 200 with **zero** committed results on A. B start: `drained.committed=5`, `films.length=5` disjoint from A's five, submit those five, `manifest_spent`. B run `results` has **10** unique settled film ids. A later start has `drained.committed=0` (field omitted when both counts are 0).
3. **Stale profile.** After hold, profile hash moves. B start: `drained.committed=0`, `dropped=5`, still five new films in the manifest.
4. **Lease expiry.** Expire A's runner lease without complete. B start still drains the five.

## Not proven

Live Scheduled Task discovery of hold. Prompt GO. Production series.
