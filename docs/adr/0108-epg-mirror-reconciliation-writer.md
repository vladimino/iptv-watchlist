# ADR 0108: EPG compatibility mirrors are reconciled by the existing EPG writer, never by GET

**Status:** Proposed  
**Original decision date:** 2026-11-10  
**Recorded at:** 2026-11-10  
**Approval source:** not documented (implementation of Accepted [ADR 0107](0107-get-head-read-side-effect-boundary.md) item 3 for EPG mirrors; owner acceptance of this record is a merge gate)  
**Related work:** [AIR-414](https://trello.com/c/GJefgNm8), [AIR-411](https://trello.com/c/6abdVoGq), [AIR-412](https://trello.com/c/TuRMtgFF); [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0100](0100-epg-cloudflare-workflow-executor.md), [ADR 0107](0107-get-head-read-side-effect-boundary.md)  
**Supersedes:** [ADR 0096](0096-bounded-seal-publication-steps.md) item 4 only in the claim that readers also repair R2 mirrors. The seal-unit retry, `gave_up` recording and watchlist fallback are unchanged.  
**Superseded by:** None

## Context

D1 is the authority for the published programme and watchlist generation ([ADR 0079](0079-d1-authoritative-published-epg.md)). R2 holds compatibility mirrors (`programme.json`, `watchlist.json`, `epg/published-generation.json` and the generation copies). GET `/api/programme`, `/api/watchlist`, `/api/catalog/available`, the Admin reads and MCP tools that pin the published generation called `PublishedEpg.repairMirrors` through shared helpers. The alignment test compared the watchlist etag with a field `currentGeneration()` did not return, so even current mirrors paid a fenced D1 `UPDATE`. Errors were partly swallowed. [ADR 0107](0107-get-head-read-side-effect-boundary.md) (Accepted) assigned that repair to the existing EPG writer and its `ensure` on the hourly Worker cron; it forbade a new cron, Task, Workflow binding or parallel writer.

`EpgOrchestration.ensure` already runs on `0 * * * *`. Before this decision it returned immediately unless the Cloudflare mode was set and the daily 17:00 Europe/Madrid publication was due, so a light mirror reconcile would never run on most ticks.

## Decision

1. **GET and HEAD never call `PublishedEpg.repairMirrors`.** Programme and watchlist reads stay fenced at the pinned D1 generation (`readDocumentAt`). They do not substitute R2 for a missing, held or unreadable D1 document; they fail closed. Lag is visible from the D1 marker fields (`mirrorProgrammeRunId`, `mirrorEtag`, `mirrorWatchlistEtag`) without a write.
2. **`currentGeneration()` returns `mirrorWatchlistEtag`.** Alignment is true only when the five R2 objects match the published D1 generation including both etags. An aligned reconcile writes nothing.
3. **The existing hourly `EpgOrchestration.ensure` is the reconciliation owner.** On every tick it runs a named `reconcileMirrors` even when the daily publication is not due and even when it will not create a Workflow instance. Publication still ends in `writeMirrors`; `revertPublished` still repairs then flips. There is no new cron, Task, Workflow binding or schedule.
4. **The reconcile is fenced, idempotent and fail-closed.** It writes R2 first and the D1 marker last under the published-EPG generation fence. It writes nothing when the cutover is held, the mode is `switching`, the durable EPG step lease is live, the lease is unreadable, or the mirrors are already aligned. A repair error is returned on the `ensure` result and does not throw, so the rest of the hourly tick still runs. A partial write is retried on the next tick.
5. **Not decided:** a production repair run, a flag, a mode switch, a change to the cron expression, or moving prediction-run or event recovery (AIR-415, AIR-416) or the ratings-seed overlay (AIR-413).

## Alternatives considered

- **Reconcile only when the daily publication is due.** Rejected: mirrors could stay drifted for a whole Madrid day; ADR 0107 assigned the existing hourly tick.
- **A second cron or a Workflow created only to repair.** Rejected: new schedule or binding needs its own owner decision.
- **Keep GET repair as a fallback when ensure has not yet run.** Rejected: that is the race ADR 0107 removed.
- **Take the EPG step lease for every repair.** Rejected: it would block the daily publication for a light copy; the generation fence already refuses a stale marker write.

## Consequences

- Reads of the published generation are query-only, including Admin and MCP tools that only pin it.
- Compatibility mirrors may lag the D1 generation until the next hourly tick (or the next publication/revert). Clients that still read R2 keys directly can see the previous generation until then; Worker GET programme/watchlist do not.
- A deploy of this code starts the light reconcile on the existing production cron. That is the intended writer, not a new schedule. It does not start an EPG download, TMDB, discovery or a Workflow solely to repair.
- Code rollback restores GET-side repair only if the previous Worker is redeployed; it does not undo R2 objects or D1 marker rows already rewritten.

## Recovery and migration boundary

This ADR authorizes no production operation. A merge and deploy enable the hourly reconcile on the existing cron; they do not authorize an extra EPG run, a flag change or a manual `repairMirrors`. Rollback of the Worker stops GET-side writes only while the previous code is live again. Repairing or reverting production mirrors remains a separate owner-approved procedure.

## Evidence

- **Original decision:** [ADR 0107](0107-get-head-read-side-effect-boundary.md) item 3 (EPG mirrors).
- **Implementation:** AIR-414 pull request (`src/published-epg.js`, `src/epg-orchestration.js`, GET helpers in `src/worker.js` and `src/admin/read.js`).
- **Dated verification:** [offline AIR-414 evidence](../evidence/api/air-414-epg-mirror-reconciliation-2026-11-10.md).
- **Uncertainty:** production mirror lag after deploy is not measured here.

## Follow-ups

[AIR-413](https://trello.com/c/orvuzDW5), [AIR-415](https://trello.com/c/NHyIKM6z) and [AIR-416](https://trello.com/c/f7FX4Elk) remove the remaining GET writers. Current state belongs to Trello and GitHub.
