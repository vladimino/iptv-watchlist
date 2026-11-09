# ADR 0106: The D1 enrichment projector writes in groups that prove their reads inside the write batch, in windows whose budget is accounted from the request

**Status:** Accepted 2026-11-09 (owner-approved direction C with liveness option L1; implementation, activation and every production step remain separately gated)  
**Original decision date:** 2026-11-09 (owner accepted ADR in the IPTV Ratings chat after exact-HEAD independent review and green CI)  
**Recorded at:** 2026-11-09  
**Approval source:** the owner's architecture decision on [PR #446](https://github.com/vladimino/iptv-watchlist/pull/446), recorded by the IPTV Ratings coordinator on 2026-11-09 after reviewing HEAD `e633702`: variant C with liveness option L1 is the initial delivery direction, and preparing this ADR and implementation planning is approved. It is **not** approval to merge without independent exact-HEAD review and green CI, to activate the grouped path, to raise the wall budget, to create or run a Workflow, or to change a production flag, Task or cron or trigger the projector or Discovery by hand.  
**Related work:** [AIR-391](https://trello.com/c/9hvEhvfJ), [AIR-392](https://trello.com/c/ivMqVpKC) (diff-latency instrumentation), [AIR-388](https://trello.com/c/fFvwYLjM), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [spike evidence](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md)  
**Supersedes:** None. It changes the budget part of decision 7 of ADR 0056 (bounded runs) only; no fence of ADR 0056 or ADR 0103 and not the 300 s bound of ADR 0103.  
**Superseded by:** None

## Context

After the fairness fix of AIR-388 the projector writes Films again, but only 8 to 9 in a slow hourly run, against a backlog of 4,730 changed Films that Discovery refills at about 55 an hour. The owner's target is a sustained 500 or more changed Films an hour, investigated up to 1,000, with Persons progressing and no harm to other consumers. AIR-391 originally asked for non-stop, resumable backfill; the owner has revised that literal requirement (decision 7): the goal is to drain the backlog sustainably and keep pace with incoming changes, and one bounded window per hourly cron is acceptable if the measured throughput and backlog reduction are sufficient.

The [spike](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md) measured, on the real projector and repository code and on recorded production runs:

- A Film costs about 11 D1 round trips (9 serial reads) and 71 statements; at about 50 ms per round trip the round trips are most of its 0.5 to 0.7 s. The 800-query and 60 s limits are self-imposed; the platform allows a 15 minute cron run and counts a `db.batch()` as one query.
- Before its first write a run spends 3 to 9 s (3 of 11 recent runs) or **50 to 60 s (8 of 11)**; the wait for the window adds 0.8 to 40.5 s. In the slow mode nothing is left of the 60 s budget, whatever the write path. Only part of that overhead is explained (the load and view, 18 to 35 s); the rest is un-instrumented D1 reads of the diff.
- The Discovery generation moves about 17 times a minute, so nothing computed in one window is valid in the next without per-entity revalidation, which the owner rejected in the closed PR #429.

## Decision

1. **A grouped write path inside the existing repository (variant C), behind a flag.** The projector applies Films and their still unwritten Persons in groups (proposal: 10 Films; Persons also 25 at a time when no Film needs them). One cycle: (a) trace the reads the repository will make for the group, (b) fetch them and a digest of each in **one** read batch, (c) run the unchanged `projectFilm`/`projectPerson` against that read cache while collecting their writes, (d) apply them in **one** fenced batch with the guards of decision 3. The repository, its statements and the change keys are unchanged; on the benchmark fixtures the rows equal the per-entity path's.
2. **Same fences, same atomicity.** The write batch starts with the projector lease fence, or the window fence when a window is held (ADR 0103), stores the change keys and clears the fence. A group commits whole or not at all.
3. **Read-validity: proved inside the write batch, never assumed.** The prefetch batch and the write batch are two D1 round trips and **not** one snapshot, so nothing is claimed from their timing. The permitted writers during a window are the projector alone: with the `film_person_authority` marker `r2` or `prepared` the R2-sourced projector is the only canonical writer (ADR 0099 decision 11), the fenced canonical mutations refuse unless the marker is `d1`, and the owner-run scripts (offline import, backfill, TMDB credits) are separately approved operations that are not run during a window. On top of that exclusivity every group proves its reads: the write batch re-runs **every distinct read the group made** and compares it with the digest the prefetch saw, and asserts the marker generation (mode `r2` or `prepared`, cutover `open`, the generation the group was planned under). Any difference fails a `CHECK` and rolls back the whole batch. The cycle then falls back to the existing per-entity path (one fenced transaction per Film and per Person, as today) for that group. The same fallback applies to: a read shape that cannot be digested, a read the collecting pass issues that the tracing pass did not see (the tracing pass answers `null` or `[]`, so data-dependent branches are not trusted: any miss refuses the group), and a planning error of any entity. Cost: one guard statement per distinct read, so a Film is 95 statements, not 71. The deterministic tests of the spike (`tests/projector-bulk-spike.mjs`) cover an appearing redirect, an owner review of a Person in the group, a marker generation move and a lost lease (each refuses the group with no row written), an unseen read and an undigestable read (fall back), and row equivalence with the per-entity path; the stage (a) tests extend them to the real marker, stale credits and metadata, and the unique constraints (a conflicting trusted external id fails the batch, never writes a duplicate).
4. **Window budget accounted from the request; the 300 s cap of ADR 0103 stays.** The cap is **300 s from window request through release**, wait, load, diff and reserve included, and is not raised. ADR 0103's absolute deadline starts at the request, so a window's write time is `deadline - wait - pre-write overhead - reserve` (reserve proposed 15 s: release, one group's latency and margin), never the deadline itself, and a grant is refused unless the minimum run time remains. With the recorded wait (mean 13 s, worst 40.5 s), overhead (50 to 60 s in slow runs) and the 300 s deadline, a slow window writes about 217 s on average and no less than 184 s in the worst recorded case. The per-run budget is a wall time and a statement count (a batch is one platform query); the 800-query and 60 s limits of ADR 0056 are replaced by it.
5. **Plan and generation consistency (unchanged protocol).** Every window derives its plan inside the held window from inputs read under the strict generation pin of ADR 0056; no plan, snapshot identity or checkpoint outlives a window. The change keys in `projection_state` are the only checkpoints, written atomically with the rows, so a crash or a lost window is recovered by the next window's diff, and a retry after an unknown outcome is safe because it is idempotent and receipt-free (the diff is the readback). A window that ends mid-run fails the next batch closed (`window_lost`); no batch is sent after the deadline. No stale write is possible after release: every batch asserts the lease and a held, unexpired, own window, and Discovery only runs once the window is released.
6. **Fairness (unchanged).** The weighted lanes of AIR-388 (Films 3, Persons 2, housekeeping 1, cost in statements) and admitted-first ordering stay. A Film's own Persons are written before it, in the same group batch. The 694 admitted Films are not special: they clear in the first hours of a catch-up.
7. **Liveness: option L1 is selected (owner decision, 2026-11-09).** One bounded window per hourly cron, the cap of decision 4, the grouped path of decisions 1 to 3 and a window budget sized inside that cap. The product goal is to drain the Film and Person backlog sustainably and keep pace with incoming changes, not to keep the projector running continuously; this revises the literal non-stop requirement of AIR-391. **Acceptance target:** sustained **at least 500 changed Films an hour** with Person progress, bounded Discovery and EPG impact and a demonstrably shrinking backlog, shown by natural production runs; no guarantee rests on an offline simulation. For orientation only, the exploratory simulation (24 h, 60 seeds, calibrated, validated 12 to 22 % low against two production runs) gave about 1,127 Films an hour (p10 930, p90 1,430) for this shape while the backlog lasts, and a backlog of 4,730 gone in about 4 hours; the real D1 latency of a large batch and the full diff overhead are not measured and may change this.
   **Not approved, and not specified here beyond what the evidence records:** continuation windows within or above the cap (L2, L3), a continuation Workflow, a hold ledger, extra windows an hour, and any increase of the Discovery hold allocation. They are revisited only if real acceptance shows a concrete need; the [evidence](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md) keeps their simulated trade-offs for that day.
8. **Observability.** The run summary gains `groups`, `groupSize`, `statements`, `prefetchReads`, `guardRefusals`, `groupFallbacks`, `prefetchMisses`, per-phase seconds (grant wait, load, view, **each diff D1 read**, writes, reserve) and Films and Persons written per window second. Every non-success outcome is a visible `deferred` or `partial`.
9. **Safe disable and rollback.** A flag (proposal `D1_ENRICHMENT_BULK`, off by default, in the flag contract) selects the grouped path; off restores today's path. Both paths write identical rows; rows written are real writes that a code rollback does not undo (ADR 0056).
10. **Coexistence.** One projector lease, one window row, one owner writer: no second Film authority and no new writer. The grouped path stays gated on the marker `r2` or `prepared`; at `d1` the projector is not the writer and the guard refuses. Film/Person migration (AIR-321, AIR-373, AIR-374) is untouched.
11. **Delivery steps, each an independently gated Trello card with its own owner GO.** (a) Offline code and tests: the grouped path behind a flag, the guards against the real marker and tables, group failure and retry, lease and window loss mid-group, unique violations, budget accounting. (b) **[AIR-392](https://trello.com/c/ivMqVpKC), separate:** instrumentation of the diff phases to explain the 50 to 60 s before the first write; a diagnostic only, no change to the window or to projector behavior. (c) Inert deploy, flag off. (d) First D1 measurement of grouped-batch latency at the current budget (flag on, owner GO). (e) L1 budget activation inside the 300 s cap (owner GO). (f) Natural production acceptance against the target of decision 7. **STOP** at any group-fallback rate above 5 %, any dangling credit, any window overrun of the cap, a D1 error naming batch size, or throughput below half of the model; the card then ends with a decision brief.

**Not decided here:** the group size, the reserve, the exact L1 budget (measured by steps (d) and (e)), the flag name, any change of the 300 s cap or the minimum run time, statement-level change detection in the repository (it would cut the 95 statements a Film but changes the repository), any Workflow, schema change, flag, Task or production action. Nothing in this record is implemented, deployed, activated or verified in production.

## Algorithm

```text
window (one hourly cron tick, L1 only):
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
next hourly tick: Discovery has run for the rest of the hour; the window starts again from a fresh diff
```

Between windows Discovery runs and nothing from the window is trusted: the plan is rebuilt from R2 and D1 and the change keys are the checkpoint. The plan therefore cannot accumulate stale entities, and the queue is diffed once per window, not once per step. The price of every window is its wait, its overhead and its reserve, which is why one window an hour is the most efficient use of the capped hold.

## Alternatives considered

- **A, minimal change (concurrent reads, Persons in the Film's batch).** About 2.5 times the current Film rate in the model; statements unchanged. Lower risk, but it does not reach 500 an hour at the current budget in any shape.
- **B, resumable Workflow with a durable plan.** Rejected as a way to survive windows: a plan cannot outlive a window under the strict generation fence without per-entity revalidation (rejected by the owner, PR #429, ADR 0102).
- **L2 and L3, continuation windows (within or above the 300 s an hour cap).** Not approved by the owner for the initial delivery; kept in the evidence with simulated numbers (L2 about 190 an hour while the pre-write overhead is 50 to 60 s, L3 about 1,631 an hour at a 16.7 % hold) for the case that natural acceptance shows a concrete need.
- **Raising the wall budget alone.** At 240 s from grant the current path reaches about 250 an hour in the simulation, half the target.
- **Trusting the prefetch because the projector is the only writer.** Rejected: two batches are not a snapshot and an owner action or a marker transition could land between them; the in-batch proof makes the claim local and testable.
- **Statement-level change detection in the repository.** Not measured; the largest remaining lever after the grouped path, recorded as a follow-up.

## Consequences

- With the grouped path and an L1 window of 300 s the simulation gives about 930 to 1,430 Films an hour (median 1,127); at 150 s from grant about 340 to 500; at 60 s it does little in any variant, because the slow-mode overhead is the whole budget. These are exploratory estimates validated 12 to 22 % low against two production runs; the acceptance target of decision 7 is met only by natural production runs.
- The projector idles about 55 minutes of every hour once it has caught up or between windows; that is the accepted cost of L1.
- New complexity: the group cycle, a read trace and cache, guards, a fallback and a second write path behind a flag; a Film costs 95 statements instead of 71, which the model includes.
- The unmeasured risks: the real D1 cost of a batch of about 950 statements; the cause of the slow-mode overhead; linearity to a 5,000-Film backlog. Stages (b) and (d) measure them before any budget rise.
- A group batch holds the single-threaded database longer than a Film batch; the Worker's own routes may see latency during a window (stage (d) reads it).

## Recovery and migration boundary

Stage (a) is code and tests; nothing is applied. Disabling the flag restores the current path; rows written are not undone. No migration, schema change, authority marker, Task, cron or Workflow is created by this ADR, and every stage after (a) needs its own explicit owner approval.

## Evidence

- **Original decision:** owner architecture decision on [PR #446](https://github.com/vladimino/iptv-watchlist/pull/446), 2026-11-09 (direction C + L1)
- **Implementation:** none; offline `scripts/projector-spike-bench.mjs`, `scripts/projector-spike-sim.mjs` and `tests/projector-bulk-spike.mjs` only
- **Dated verification:** [AIR-391 spike, 2026-11-09](../evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md), read-only logs, offline benchmark and simulation
- **Uncertainty:** D1 latency of large batches; the cause of the 50 to 60 s pre-write overhead; the real marker's behaviour under a D1 writer; linearity to 5,000 Films

## Follow-ups

Cards for steps (a) and (c) to (f) follow this ADR's merge; (b) is AIR-392. L2/L3, a hold ledger, statement-level change detection and any change of the hold bound are separate proposals that need a concrete need from natural acceptance.
