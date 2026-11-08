# ADR 0101: The daily Ratings run is due at 17:00 Europe/Madrid, the same logical time as the EPG publication

**Status:** Accepted  
**Original decision date:** 2026-11-07  
**Recorded at:** 2026-11-08  
**Approval source:** owner approval on the [AIR-348 card](https://trello.com/c/PUrlzMuH), 2026-11-07 (Madrid): "EPG и Ratings logical due 17:00 Europe/Madrid (с отдельной документированной supersession ADR 0090)"; the owner asked for this change as its own record on 2026-11-08. A time-of-day decision only; no production operation  
**Related work:** [AIR-348](https://trello.com/c/PUrlzMuH); [ADR 0090](0090-ratings-cloudflare-workflow-executor.md); [ADR 0089](0089-shared-orchestration-reliability-contract.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md)  
**Supersedes:** [ADR 0090](0090-ratings-cloudflare-workflow-executor.md) in one respect only: its decision that the Ratings logical due time is 17:30 Europe/Madrid (and the same figure in the Ratings column of [ADR 0089](0089-shared-orchestration-reliability-contract.md)). Everything else in both ADRs stands.  
**Superseded by:** None

## Context

ADR 0090 (Accepted 2026-11-05) fixed the Ratings logical due time at 17:30 Europe/Madrid, a half hour after the EPG publication (17:00), at the time when the existing hourly cron's first tick after the due time was normally near 17:37. The owner has since approved moving the Worker's single cron from `37 * * * *` to `0 * * * *` (a separate, not yet authorized production step) and asked that EPG and Ratings share one logical due time, 17:00, so that both daily producers are reached by the first tick of that hour.

Ratings and EPG do not call each other: EPG commits no Diary or rating inline ([ADR 0074](0074-retire-ratings-pipeline-switch.md)), and Ratings has its own pipeline and mode. A shared due time therefore creates no ordering dependency.

## Decision

1. `RATINGS_SCHEDULE` is `{hour: 17, minute: 0}` in `src/domain/orchestration-policy.js`: the logical due time of the Ratings run, its run key's `dueAt`, its `ensure` admission and the stall and health derivation of its read model (which measure from `dueAt`) use 17:00 Europe/Madrid, converted with the IANA zone on every date, so CET and CEST and both change days are handled as before.
2. The Madrid-date run key, the failure classes, the retry budget, the mode switch and every other part of ADR 0090 are unchanged. The Workflow, its binding and its D1 documents are unchanged.
3. The change moves the earliest instant the executor may start by 30 minutes. While the cron is `37 * * * *` the first tick at or after 17:00 is the same 17:37 as it was after 17:30, so the deployed behaviour is unchanged until the cron is moved; the read model reports `dueAt` and starts its two-hour stall clock 30 minutes earlier.

Not decided: the cron change. Moving `37 * * * *` to `0 * * * *` remains a separate operation-specific owner approval, with a coexistence check against the projector, the monitor and Discovery.

## Alternatives considered

- **Keep 17:30:** the owner chose one shared logical time; not documented further.
- **Shift only the cron:** rejected; the logical due time and not the cron instant is the contract of ADR 0089 (the run key and the stall clock follow it).

## Consequences

One constant and the Ratings tests change. The Ratings read model's `dueAt` and `oldestPendingAt` move 30 minutes earlier, and a missed Ratings run is reported as stalled 30 minutes earlier. The legacy Ratings Task, disabled since 2026-11-06, keeps its historical 17:30 recurrence in the registry; it is not edited here.

## Recovery and migration boundary

Reversible: code. Restoring 17:30 is the same one-constant change with a new record. Nothing stored changes: a control record written under either due time names a Madrid date, and `dueAt` is derived at read time. This ADR authorizes no flag, Task, cron, Workflow instance, D1/R2 write or cutover.

## Evidence

- **Original decision:** [AIR-348](https://trello.com/c/PUrlzMuH)
- **Implementation:** the AIR-348 Ratings due-time pull request; `tests/ratings-orchestration.mjs` covers 17:00 across both DST change days, `ensure` before and after the due time, and the read model
- **Uncertainty:** none observed in production; behaviour changes only once the cron moves.
