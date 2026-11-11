# ADR 0111: Discovery reports to the Events Log once per scheduled hourly firing, as deltas

**Status:** Accepted  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** the Product Owner's reopening of [AIR-410](https://trello.com/c/M9yidPgX) on 11 November 2026, which fixes the approved semantics (one report per real scheduled hourly cron, deltas, every state)  
**Related work:** [AIR-410](https://trello.com/c/M9yidPgX), [PR #476](https://github.com/vladimino/iptv-watchlist/pull/476) (first delivery, merge `2e07e3d`), [ADR 0093](0093-discovery-workflow-cron-reconcile.md), [ADR 0103](0103-projector-exclusive-window.md), [RCA of 11 Nov 2026](../evidence/discovery/air-410-hourly-reports-rca-2026-11-11.md)  
**Supersedes:** None as an ADR: the per-chain tick model of AIR-410's first delivery was documented in the events reference and architecture pages, not in an ADR, and those pages are rewritten here  
**Superseded by:** None

## Context

The first AIR-410 delivery (PR #476) wrote one `discovery` event per *logical tick*: the chain of Workflow instances of a generation, settled at its terminal stop, or one scheduled firing that confirmed an empty queue. A chain that runs across several hours (rollovers, `step_cap`, recovery successors) is one tick, so every hourly cron in between returned `in_progress` or `recovery_waiting` and wrote nothing. After an EPG publication reopens the queue, the Events Log therefore goes silent for as long as the chain runs, which is exactly when the owner wants to see progress. The owner rejected that boundary: **each real scheduled hourly cron must produce one report for its hour**, with the change since the previous report, in every state.

## Decision

1. **One report per scheduled firing.** `reconcileDiscoveryWorkflow` ends, for a real scheduled firing only (`options.scheduled` with a finite `options.now`, executor mode `workflow`), by closing the period of its UTC hour. The chain, its rollovers and its terminal stop write no event. An unscheduled caller writes none and no report is invented for an hour the cron did not fire.
2. **Identity.** `discovery-hour-<12 characters of the published generation>-<UTC hour>`, `at` = hour start. UTC hours are DST-safe; a repeated, delayed or concurrent firing finds the closed hour (`lastClosedHour`) and writes nothing; a firing of any hour not later than `lastClosedHour` is rejected without touching the open accumulator.
3. **Deltas by commit time.** The executor record carries one open accumulator `report`. A chunk checkpoint adds its summary inside the owner's compare-and-swap and records its chunk key in a bounded `seen` list (a replay adds nothing). The hourly close moves the report into an `outbox` and resets the accumulator in **one** compare-and-swap of the same record, so a chunk is counted in exactly one report. A chunk belongs to the period in which its checkpoint was saved.
4. **Honest states and unknowns.** `status` is `running`, `waiting`, `blocked`, `failed`, `empty` or `idle` with a typed `reason`. Empty is claimed only for proven numeric zeros (`remaining`, `cheapRemaining`, no error) and a `complete` continuation of the generation. An unreadable or unwritable reading yields an `incomplete` event with every number `null` (never `0`), leaves the accumulator alone and is not backfilled: its deltas arrive, once, in the next report (`from` shows the reach).
5. **Durable, idempotent delivery.** The report is durable in the `outbox` before it is put create-only into `events/items/`; an entry leaves only after a confirmed put and delivery never changes `updatedAt`. The outbox is capped at 64 and drops nothing (at the limit the deltas coalesce in the accumulator). The close uses no lease, runs no chunk, calls no TMDB, and its only write is the existing record compare-and-swap that a held projector window already refuses softly; a replacement of the record carries `report` and `outbox` forward.
6. **Compatibility.** Earlier `run` / `empty` events stay readable with their card; a settled undelivered legacy tick is delivered once and an open legacy tick is dropped.

**Not decided here.** No production run, flag, schedule, backfill or event repair is authorized. Delivered in code; not deployed or production-verified until a post-merge deploy and two consecutive natural hourly events. AIR-428 (successor after `step_cap`) is unchanged and independent.

## Alternatives considered

- **Keep one event per chain and add a progress event at each rollover.** Rollovers are not hourly and a long wait or refusal still writes nothing. Rejected by the owner's semantics.
- **Derive the report from lifetime counters and subtract at read time.** The counters are not stored per hour and a read would write or compute a stored fact the Events Log does not own. Rejected.
- **A separate R2 accumulator object written by every chunk.** Adds a second writer and a second compare-and-swap target next to the executor record, and a chunk could count in two periods. Rejected in favor of the record that already carries the owner's compare-and-swap.
- **Backfill missed hours.** Would invent reports for hours in which the cron did not fire; the Monitor owns gaps. Rejected.

## Consequences

- The Events Log shows a Discovery line every hour, including quiet hours (`running`, 0 new) and refusals; the volume is one small event per hour (24 a day).
- The executor record grows by one accumulator and an outbox of at most 64 small entries; every chunk checkpoint carries a few extra counters.
- A chunk whose checkpoint is not saved loses its numbers, so counters are a lower bound by exactly that; an hour whose close cannot be persisted is an incomplete event and the next report is larger.
- An incomplete event occupies its hour key and is never replaced by a later complete one for the same hour.
- Rollback of the code does not remove stored events, `report`, `outbox` or legacy fields; old code ignores them.
