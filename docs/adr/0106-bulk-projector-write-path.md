# ADR 0106: The D1 enrichment projector writes in groups that prove their reads inside the write batch, in windows whose budget is accounted from the request

**Status:** Proposed  
**Original decision date:** not decided (proposal of 2026-11-09, revised after the independent review of PR #446)  
**Recorded at:** 2026-11-09  
**Approval source:** not documented. This is a proposal for the owner's architecture decision on [AIR-391](https://trello.com/c/9hvEhvfJ); it is **not** approved and authorizes no implementation, flag, window change or production operation.  
**Related work:** [AIR-391](https://trello.com/c/9hvEhvfJ), [AIR-388](https://trello.com/c/fFvwYLjM), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [spike evidence](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md)  
**Supersedes:** None. It would change decision 7 of ADR 0056 (bounded runs) and, if the owner chooses option L3 below, the 300 s an hour bound of ADR 0103; no fence of either.  
**Superseded by:** None

## Context

After the fairness fix of AIR-388 the projector writes Films again, but only 8 to 9 in a slow hourly run, against a backlog of 4,730 changed Films that Discovery refills at about 55 an hour. The owner's target is a sustained 500 or more changed Films an hour, investigated up to 1,000, with Persons progressing, no harm to other consumers, and **progress between hourly ticks** (AIR-391 asks for non-stop, resumable backfill, not an hour-long pause after every window).

The [spike](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md) measured, on the real projector and repository code and on recorded production runs:

- A Film costs about 11 D1 round trips (9 serial reads) and 71 statements; at about 50 ms per round trip the round trips are most of its 0.5 to 0.7 s. The 800-query and 60 s limits are self-imposed; the platform allows a 15 minute cron run and counts a `db.batch()` as one query.
- Before its first write a run spends 3 to 9 s (3 of 11 recent runs) or **50 to 60 s (8 of 11)**; the wait for the window adds 0.8 to 40.5 s. In the slow mode nothing is left of the 60 s budget, whatever the write path. Only part of that overhead is explained (the load and view, 18 to 35 s); the rest is un-instrumented D1 reads of the diff.
- The Discovery generation moves about 17 times a minute, so nothing computed in one window is valid in the next without per-entity revalidation, which the owner rejected in the closed PR #429.

## Decision (proposed)

1. **A grouped write path inside the existing repository (variant C), behind a flag.** The projector applies Films and their still unwritten Persons in groups (proposal: 10 Films; Persons also 25 at a time when no Film needs them). One cycle: (a) trace the reads the repository will make for the group, (b) fetch them and a digest of each in **one** read batch, (c) run the unchanged `projectFilm`/`projectPerson` against that read cache while collecting their writes, (d) apply them in **one** fenced batch with the guards of decision 3. The repository, its statements and the change keys are unchanged; on the benchmark fixtures the rows equal the per-entity path's.
2. **Same fences, same atomicity.** The write batch starts with the projector lease fence, or the window fence when a window is held (ADR 0103), stores the change keys and clears the fence. A group commits whole or not at all.
3. **Read-validity: proved inside the write batch, never assumed.** The prefetch batch and the write batch are two D1 round trips and **not** one snapshot, so nothing is claimed from their timing. The permitted writers during a window are the projector alone: with the `film_person_authority` marker `r2` or `prepared` the R2-sourced projector is the only canonical writer (ADR 0099 decision 11), the fenced canonical mutations refuse unless the marker is `d1`, and the owner-run scripts (offline import, backfill, TMDB credits) are separately approved operations that are not run during a window. On top of that exclusivity every group proves its reads: the write batch re-runs **every distinct read the group made** and compares it with the digest the prefetch saw, and asserts the marker generation (mode `r2` or `prepared`, cutover `open`, the generation the group was planned under). Any difference fails a `CHECK` and rolls back the whole batch. The cycle then falls back to the existing per-entity path (one fenced transaction per Film and per Person, as today) for that group. The same fallback applies to: a read shape that cannot be digested, a read the collecting pass issues that the tracing pass did not see (the tracing pass answers `null` or `[]`, so data-dependent branches are not trusted: any miss refuses the group), and a planning error of any entity. Cost: one guard statement per distinct read, so a Film is 95 statements, not 71. The deterministic tests of the spike (`tests/projector-bulk-spike.mjs`) cover an appearing redirect, an owner review of a Person in the group, a marker generation move and a lost lease (each refuses the group with no row written), an unseen read and an undigestable read (fall back), and row equivalence with the per-entity path; the stage (a) tests extend them to the real marker, stale credits and metadata, and the unique constraints (a conflicting trusted external id fails the batch, never writes a duplicate).
4. **Window budget accounted from the request (ADR 0103 unchanged).** ADR 0103's absolute deadline starts at the request, so a window's write time is `deadline - wait - pre-write overhead - reserve` (reserve proposed 15 s: release, one group's latency and margin), never the deadline itself, and a grant is refused unless the minimum run time remains. With the recorded wait (mean 13 s, worst 40.5 s), overhead (50 to 60 s in slow runs) and the 300 s deadline, a slow window writes about 217 s on average and no less than 184 s in the worst recorded case. The per-run budget is a wall time and a statement count (a batch is one platform query); the 800-query and 60 s limits of ADR 0056 are replaced by it.
5. **Plan and generation consistency (unchanged protocol).** Every window derives its plan inside the held window from inputs read under the strict generation pin of ADR 0056; no plan, snapshot identity or checkpoint outlives a window. The change keys in `projection_state` are the only checkpoints, written atomically with the rows, so a crash or a lost window is recovered by the next window's diff, and a retry after an unknown outcome is safe because it is idempotent and receipt-free (the diff is the readback). A window that ends mid-run fails the next batch closed (`window_lost`); no batch is sent after the deadline. No stale write is possible after release: every batch asserts the lease and a held, unexpired, own window, and Discovery only runs once the window is released.
6. **Fairness (unchanged).** The weighted lanes of AIR-388 (Films 3, Persons 2, housekeeping 1, cost in statements) and admitted-first ordering stay. A Film's own Persons are written before it, in the same group batch. The 694 admitted Films are not special: they clear in the first hours of a catch-up.
7. **Liveness is an owner decision with three consistent options.** The requirement is progress between hourly ticks. Under the strict fence it means more windows, each paying wait, overhead and reserve again; it never means a durable plan. Simulated, 24 h, 60 seeds, calibrated (Films a hour while the backlog lasts, median of p10 to p90):
   - **L1, one long window an hour** (deadline 300 s, hold 8.3 %): about **1,127** (930 to 1,430), backlog gone in about 4 hours. Idle about 55 minutes of each hour: it does **not** meet the literal requirement. Recommended first stage because it needs no change to ADR 0103's bound and no new mechanism.
   - **L2, continuation windows within the same 8.3 % cap** (for example 4 windows of 75 s): useless while the pre-write overhead is 50 to 60 s (median window writes nothing; 190 an hour), and about 720 an hour if it were 3 to 9 s. Needs the overhead's cause found and removed (an instrumentation card), a lower minimum run time, a hold ledger and a trigger.
   - **L3, continuation windows at a higher cap** (for example 4 windows of 150 s, 16.7 %): about **1,631** an hour today, backlog gone in under 3 hours, with Discovery admission closed 16.7 % of the time. It changes ADR 0103's accepted bound and is the owner's decision.
   The trigger of L2 and L3 is a bounded loop (a Workflow instance created idempotently by the existing cron when work remains, in the pattern of ADR 0093 and ADR 0100): request, run, release, **cooldown during which Discovery runs**, repeat while work remains and the hold ledger (rolling hour) allows. Nothing busy-loops: with no work the loop ends and the hourly cron is the only trigger. The ledger and the loop are additive schema and code, separately approved.
8. **Observability.** The run summary gains `groups`, `groupSize`, `statements`, `prefetchReads`, `guardRefusals`, `groupFallbacks`, `prefetchMisses`, per-phase seconds (grant wait, load, view, **each diff D1 read**, writes, reserve) and Films and Persons written per window second. Every non-success outcome is a visible `deferred` or `partial`.
9. **Safe disable and rollback.** A flag (proposal `D1_ENRICHMENT_BULK`, off by default, in the flag contract) selects the grouped path; off restores today's path. Both paths write identical rows; rows written are real writes that a code rollback does not undo (ADR 0056).
10. **Coexistence.** One projector lease, one window row, one owner writer: no second Film authority and no new writer. The grouped path stays gated on the marker `r2` or `prepared`; at `d1` the projector is not the writer and the guard refuses. Film/Person migration (AIR-321, AIR-373, AIR-374) is untouched.
11. **Stages, each a separate Trello card and owner GO.** (a) Offline code and tests (the guards against the real marker and tables, group failure and retry, lease and window loss mid-group, unique violations, budget accounting). (b) Instrumentation of the diff phases (no behaviour change), to find the cause of the 50 to 60 s overhead. (c) Inert deploy, flag off. (d) Owner GO: flag on, current budget, first D1 measurement of batch latency. (e) Owner GO: the L1 window budget. (f) Owner decision and cards for L2 or L3. (g) Natural acceptance at consecutive runs. **STOP** at any group-fallback rate above 5 %, any dangling credit, any window overrun, a D1 error naming batch size, or throughput below half of the model; the card then ends with a decision brief.

**Not decided here:** the group size, the reserve, the budgets, the flag name, which of L1, L2 or L3, any change of the 300 s hold or the minimum run time, statement-level change detection in the repository (it would cut the 95 statements a Film but changes the repository), any Workflow, schema change, flag, Task or production action. Nothing in this record is implemented, deployed, activated or verified in production.

## Algorithm

```text
window (a cron tick, or one iteration of a bounded continuation loop):
  lease -> writer-idle checks -> request window (absolute deadline, request to release, <= 300 s)
  wait for grant (Discovery drains its in-flight chunk; admission closed); refused if < minimum run left
  read inputs under the generation pin; diff against projection_state       (fresh plan, every window)
  while time left (deadline - elapsed - reserve) and lease and window held:
      pick lane by weighted deficit (Films 3, Persons 2, housekeeping 1)
      form a group; trace reads -> ONE read batch (rows + digests)
      collect writes with the unchanged repository
      ONE fenced batch: fence, marker guard, one guard per read, rows, change keys
      guard refused / read unseen / planning error -> per-entity path for this group
  release window and lease                                                    (Discovery resumes)
cooldown (L2/L3 only): Discovery runs; repeat while work remains and the hold ledger allows
```

Between windows Discovery runs and nothing from the window is trusted: the plan is rebuilt from R2 and D1 and the change keys are the checkpoint. The plan therefore cannot accumulate stale entities, and the queue is diffed once per window, not once per step. The price of every extra window is its wait, its overhead and its reserve, which is why splitting a fixed hold into more windows only pays once the overhead is small.

## Alternatives considered

- **A, minimal change (concurrent reads, Persons in the Film's batch).** About 2.5 times the current Film rate in the model; statements unchanged. Lower risk, but it does not reach 500 an hour at the current budget in any shape.
- **B, resumable Workflow with a durable plan.** Rejected as a way to survive windows: a plan cannot outlive a window under the strict generation fence without per-entity revalidation (rejected by the owner, PR #429, ADR 0102). A Workflow is only the trigger of L2 and L3, where each step is a fresh window.
- **Raising the wall budget alone.** At 240 s from grant the current path reaches about 250 an hour in the simulation, half the target.
- **Trusting the prefetch because the projector is the only writer.** Rejected: two batches are not a snapshot and an owner action or a marker transition could land between them; the in-batch proof makes the claim local and testable.
- **Statement-level change detection in the repository.** Not measured; the largest remaining lever after the grouped path, recorded as a follow-up.

## Consequences

- With the grouped path and the L1 window the simulation gives about 930 to 1,430 Films an hour (median 1,127) and a backlog gone in about 4 hours; at 150 s from grant about 340 to 500; at 60 s it does little in any variant, because the slow-mode overhead is the whole budget. These are exploratory estimates validated 12 to 22 % low against two production runs, not capacity targets.
- New complexity: the group cycle, a read trace and cache, guards, a fallback and a second write path behind a flag; a Film costs 95 statements instead of 71, which the model includes.
- The unmeasured risks: the real D1 cost of a batch of about 950 statements; the cause of the slow-mode overhead; linearity to a 5,000-Film backlog. Stages (b) and (d) measure them before any budget rise.
- A group batch holds the single-threaded database longer than a Film batch; the Worker's own routes may see latency during a window (stage (d) reads it).

## Recovery and migration boundary

Stage (a) is code and tests; nothing is applied. Disabling the flag restores the current path; rows written are not undone. No migration, schema change, authority marker, Task, cron or Workflow is created by this ADR, and every stage after (a) needs its own explicit owner approval.

## Evidence

- **Original decision:** pending owner decision on [AIR-391](https://trello.com/c/9hvEhvfJ)
- **Implementation:** none; offline `scripts/projector-spike-bench.mjs`, `scripts/projector-spike-sim.mjs` and `tests/projector-bulk-spike.mjs` only
- **Dated verification:** [AIR-391 spike, 2026-11-09](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md), read-only logs, offline benchmark and simulation
- **Uncertainty:** D1 latency of large batches; the cause of the 50 to 60 s pre-write overhead; the real marker's behaviour under a D1 writer; linearity to 5,000 Films

## Follow-ups

Stage cards (a) to (g) are created after the owner's decision. L2/L3 hold-ledger and trigger design, statement-level change detection and any change of the hold bound are separate proposals.
