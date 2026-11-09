# ADR 0106: The D1 enrichment projector writes in groups through a read-prefetching bulk path of the existing repository, inside one longer exclusive window

**Status:** Proposed  
**Original decision date:** not decided (proposal of 2026-11-09)  
**Recorded at:** 2026-11-09  
**Approval source:** not documented. This is a proposal for the owner's architecture decision on [AIR-391](https://trello.com/c/9hvEhvfJ); it is **not** approved and authorizes no implementation, flag, window change or production operation.  
**Related work:** [AIR-391](https://trello.com/c/9hvEhvfJ), [AIR-388](https://trello.com/c/fFvwYLjM), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [spike evidence](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md)  
**Supersedes:** None. It changes decision 7 of ADR 0056 (bounded runs) and the budget part of decision 6 of ADR 0103 only if accepted, and no fence of either.  
**Superseded by:** None

## Context

After the fairness fix of AIR-388 the projector writes Films again, but only 8 to 9 Films in a slow hourly run, against a backlog of 4,730 changed Films that Discovery refills at about 55 an hour. The owner's target is a sustained 500 or more changed Films an hour, investigated up to 1,000, with Persons progressing and no harm to other consumers.

The [spike](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md) measured on the real projector and repository code (offline, calibrated against two production anchors):

- A Film costs about 11 D1 round trips (9 of them serial reads) and 71 statements; at about 50 ms per round trip the round trips are most of its 0.5 to 0.7 s.
- The 800-query and 60 s limits are self-imposed. The platform allows 15 minutes of wall time for a cron run and counts a `db.batch()` as one query.
- The load after the window grant takes 5.5 s in fast runs and 17 to 33 s in slow runs, and the window wait 0.8 to 40 s; both repeat in every window.
- The Discovery generation moves about 17 times a minute, so nothing computed in one window is valid in the next without per-entity revalidation (rejected by the owner in the closed PR #429).

## Decision (proposed)

1. **Bulk write path inside the existing repository (variant C).** The projector applies Films and their Persons in **groups** (proposal: 10 Films and the still unwritten Persons they need, Persons also in groups of 25 when no Film needs them). One group cycle: (a) trace the reads the repository will make for the group, (b) fetch all of them in **one** read batch, (c) run the unchanged `projectFilm`/`projectPerson` against that read cache while collecting their writes, (d) apply the writes in **one** fenced batch that also stores the change keys. The repository, its statements and the change keys are unchanged; the prototype left identical rows for groups of 1, 10, 25 and 50.
2. **Same fences, same atomicity.** Every group batch starts with the projector lease fence, or the window fence when a window is held (ADR 0103), and clears it at the end. A group is atomic: it commits whole or not at all; its entities keep their old keys on failure. A failed group is retried **entity by entity** in the same run with the existing fence (the existing "retry one by one" rule), so one bad Film cannot hold its group back.
3. **Group invariants.** The read cache is only valid for reads issued before the group's own writes. A group is therefore formed so that no two Films share a trusted external id and no Person is listed twice; the database's unique index `film_external_id_one_trusted` and the `person.role_id` unique constraint turn a violation into a failed batch, never into a silent duplicate. The prefetch uses the same connection and the same instant as the batch, with the fence statement first, so a read that went stale between prefetch and batch fails the fence or the unique constraints, not the data. A read that is not in the cache falls back to a live read and is counted (`prefetchMisses`).
4. **One window an hour, larger budget, no new Discovery hold beyond ADR 0103.** The per-run wall budget may rise from 60 s to a value measured in stage (b) and not above what fits in the 300 s absolute deadline of ADR 0103 together with the wait and the load; the query budget is replaced by a budget of **statements and wall time** (a group batch is one query to the platform). The projector still takes one window per tick with one absolute deadline, so Discovery admission stays closed for at most 300 s an hour. Raising that bound, or a second window an hour, is a separate owner decision.
5. **Plan and generation consistency (unchanged protocol).** The plan is derived inside the held window from inputs read under the strict generation pin of ADR 0056; no plan, checkpoint or snapshot identity outlives the window. The group batches assert the lease and the window; a window that ends mid-run fails the next batch closed (`window_lost`), no later group is started, and the next tick re-derives the plan from R2 and D1 (the change keys are the idempotent checkpoint). Stale writes after the window cannot happen: no batch is sent after the deadline, and a batch that straddles it is refused by its own fence statement.
6. **Fairness and priority (unchanged).** The three-lane weighted scheduler of AIR-388 (Films 3, Persons 2, housekeeping 1, cost in statements) and admitted-first ordering stay. The 694 admitted Films need no special path: at the proposed rate they clear in a few runs. A Film's own Persons are still written before it (credits reference `person.id`), now inside its group's batch in dependency order.
7. **Observability.** The run summary gains `groups`, `groupSize`, `statements`, `prefetchReads`, `prefetchMisses`, `groupRetries`, write seconds and the Films and Persons written per window second, next to the existing `window` fields. Every non-success outcome stays a visible `deferred` or `partial`, never success.
8. **Safe disable and rollback.** A flag (proposal: `D1_ENRICHMENT_BULK`, off by default, registered in the flag contract) selects the bulk path; off restores today's path exactly. Rows written by either path are real writes that a code rollback does not undo, as in ADR 0056, and the two paths write identical rows.
9. **Coexistence.** One projector lease, one window row, one owner writer: the hourly cron; no second Film authority and no new writer. The Film/Person migration of [ADR 0099](0099-canonical-film-person-d1-authority.md) (AIR-321, AIR-373, AIR-374) is unaffected while the Film/Person authority marker stays `r2`; a cutover to D1 authority needs the bulk path to keep writing through the repository, which it does. The housekeeping, absent-entity guards and membership guards are unchanged.
10. **Steady state is idle without a busy loop.** After the backlog drains, each hourly run diffs, finds a few changed entities and finishes `complete` in the fast path; there is no standing loop or Workflow.
11. **Stages, each a separate Trello card and owner GO.** (a) Offline code and deterministic tests: group cycle, equivalence with the current path over generated plans, group failure and retry, lease and window loss mid-group, unique-index violations, budget accounting; flag registered; nothing applied. (b) Inert deploy with the flag off. (c) Owner GO: switch the flag with the current 60 s budget and read the first measurements (statements per second, batch latency, prefetch misses) at the next natural ticks. (d) Owner GO: raise the wall budget to the measured value within the 300 s deadline. (e) Natural acceptance at consecutive ticks: Films and Persons rising, `remaining` falling, no `leaseLost`, no unexplained `deferred`, Discovery chunks completing between windows. **STOP** at any `partial` with group retries above 5 %, any dangling credit, any window overrun, a D1 batch error that names size, or throughput below the model by more than half; the card ends with a decision brief, not a retry or a larger window.

**Not decided here:** the group size, the wall and statement budgets (measured in stages c and d), the flag name, a second window an hour, a change of the 300 s hold, statement-level change detection inside the repository (it would cut the 77 statements per Film, but changes the repository and needs its own proposal), any Workflow, any schema change, any flag, Task or production action. Nothing in this record is implemented, deployed, activated or verified in production.

## Algorithm

```text
tick (hourly cron): lease -> writer-idle checks -> request window (one absolute deadline <= 300 s)
  wait for grant (Discovery drains its in-flight chunk; admission closed)
  read inputs under the generation pin; diff against projection_state     (full load, per window)
  while budget left and window held and lease held:
      pick lane by weighted deficit (Films 3, Persons 2, housekeeping 1)
      form a group (<= 10 Films + their unwritten Persons, or <= 25 Persons)
      trace reads -> ONE read batch -> collect writes -> ONE fenced batch (rows + change keys)
      on group failure: retry entity by entity; on lease/window loss: stop
  release window and lease; Discovery resumes
next tick: the change keys are the checkpoint; nothing from this tick is trusted
```

Discovery runs between windows: admission reopens at release, and the window is bounded at 300 s an hour (8.3 %). No plan, snapshot identity or checkpoint crosses a window, so the plan cannot accumulate stale entities and the queue is diffed once per window, not once per step.

## Alternatives considered

- **A, minimal change (concurrent reads, Persons in the Film's batch).** About 2.5 times the current Film rate in the model; statements unchanged. Lower risk but does not reach 500 an hour in slow runs.
- **B, resumable Workflow with a durable plan.** Rejected for now: a plan cannot outlive a window under the strict generation fence without per-entity revalidation, which the owner rejected (PR #429, ADR 0102); each Workflow step would repeat the load and the wait, and it removes no round trip or statement. It also adds a second orchestration and recovery path beside the cron.
- **B plus C.** No throughput gain over C. Revisit only if the owner wants several windows an hour with an incremental load.
- **Raising the wall budget alone.** 60 to 150 s at 0.6 s a Film gives roughly 110 to 190 Films an hour in a slow run, well below the target.
- **Statement-level change detection in the repository.** Not measured; the largest remaining lever after C, recorded as a follow-up.

## Consequences

- Estimated 3.5 to 4 times the current Film rate; with a 150 s budget 438 to 1,376 Films an hour in slow runs and with 300 s 985 to 2,146 (calibrated model, not measured on D1). 500 an hour is reachable only with the larger budget; 60 s alone does not reach it in any variant.
- New complexity: the group cycle, a read-trace pass, a read cache and a second write path behind a flag; the tests must prove row equivalence with the current path.
- The risk the model cannot remove: the real D1 cost of a batch of several hundred statements. Stage (c) measures it before any budget rise.
- A group batch holds the single-threaded database for longer than a Film batch; other D1 users (Discovery is paused by the window, but the Worker's own routes are not) may see added latency during the window. Stage (c) reads it.
- Persons progress faster as well (about 1,500 an hour against 775).

## Recovery and migration boundary

Stage (a) is code and tests; nothing is applied. Disabling the flag restores the current path; rows written are not undone. No migration, no schema change, no authority marker, no Task or cron change, no Workflow. Every stage after (a) needs its own explicit owner approval; this ADR authorizes none of them.

## Evidence

- **Original decision:** pending owner decision on [AIR-391](https://trello.com/c/9hvEhvfJ)
- **Implementation:** none; offline benchmark `scripts/projector-spike-bench.mjs` only
- **Dated verification:** [AIR-391 spike, 2026-11-09](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md), read-only logs and offline benchmark
- **Uncertainty:** D1 latency of large batches; the cause of the 17 to 33 s slow load; linearity from 200 to 5,000 Films; the share of Persons that Films need in future backlogs

## Follow-ups

Stage cards (a) to (e) are created after the owner's decision. Statement-level change detection, a second window an hour and any Workflow executor are separate proposals.
