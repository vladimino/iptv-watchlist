# D1 enrichment projector: throughput spike (baseline, offline benchmark, three variants)

**Captured:** 2026-11-09 (Madrid afternoon, UTC 09:00–11:00), read-only: Worker logs (`event=d1_enrichment_projection`, 30 h), D1 `SELECT` aggregates, Cloudflare documentation. The benchmark is offline (in-memory SQLite, virtual clock). No projector run, window, flag, cron, Task, Workflow, migration or production write.
**Scope:** [AIR-391](https://trello.com/c/9hvEhvfJ). Where the time of one hourly projector run goes, which write path and which window shape reach at least 500 changed Films an hour, and what a non-stop (continuation) design costs. It decides nothing by itself; the owner selected C + L1 in [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (Accepted 2026-11-09; design only, with separate implementation and production gates).
**Verdict:** **Two costs, not one.** (1) The write phase is round-trip bound today (about 11 D1 round trips and 71 statements per Film) and a grouped write that proves its reads inside its write batch removes the round trips (0.2 per Film) at the price of more statements (95 per Film, guards included) with the same rows. (2) Before its first write a run spends **3 to 9 s in 3 of the last 11 productive runs and 50 to 60 s in the other 8**; in the slow mode that is the whole 60 s budget, so no write-path change helps at 60 s and the wall budget is the decisive lever. With the 300 s request-to-release deadline of ADR 0103 the simulation gives about 930 to 1,430 Films an hour (median 1,127) while the backlog lasts; at 150 s from grant, about 340 to 500; at 60 s, 13 to 150 (median 60). Chopping the same hold into continuation windows does not add throughput; it is effective only when the pre-write overhead is cut or the hold cap is raised. The owner selected the single bounded window an hour (L1) on 2026-11-09; the numbers here are exploratory.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md), [ADR 0056](../../adr/0056-d1-enrichment-write-through.md) decision 7, [ADR 0103](../../adr/0103-projector-exclusive-window.md) decision 6.

## 1. Baseline from recorded events (no new load)

Hourly cron runs from 2026-11-08 21:00 to 2026-11-09 09:00 (UTC; the 00:01 and 22:01 runs were deferred and are left out), fields of the run summary. `held` is the exclusive window hold, `wait` the time to get it.

| Run | Outcome | Load ms | View ms | Window wait | Held | Queries | Films / Persons written | Changed Films / Persons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11-08 21:01 | budget | 26,476 | 2,044 | 12.2 s | 61.0 s | 68 | 0 / 50 | 3,467 / 13,061 |
| 11-08 23:01 | budget | 19,878 | 1,545 | 2.0 s | 63.2 s | 172 | 0 / 150 | 4,001 / 13,334 |
| 01:01 | budget | 17,041 | 1,464 | 2.0 s | 61.7 s | 224 | 0 / 200 | 4,350 / 13,741 |
| 02:02 | budget | 18,229 | 1,205 | 13.4 s | 62.8 s | 276 | 0 / 250 | 4,365 / 13,605 |
| 03:01 | budget | 28,858 | 1,813 | 2.8 s | 64.4 s | 94 | 0 / 75 | 4,417 / 13,612 |
| 04:01 | budget | 5,192 | 422 | 11.9 s | 49.2 s | 822 | 0 / 775 | 4,417 / 13,537 |
| 05:02 | budget | 32,171 | 2,063 | 40.5 s | 63.2 s | 120 | 0 / 100 | 4,512 / 13,233 |
| 06:01 | budget | 5,728 | 485 | 0.8 s | 43.5 s | 822 | 0 / 775 | 4,589 / 13,553 |
| 07:01 | budget | 5,830 | 453 | 12.0 s | 48.6 s | 822 | 0 / 775 | 4,645 / 13,064 |
| 08:02 (fixed code) | budget | 28,830 | 2,200 | 31.4 s | 64.8 s | 113 | 9 / 55 | 4,737 / 12,692 |
| 09:02 (fixed code) | budget | 32,926 | 2,237 | 15.0 s | 60.4 s | 74 | 8 / 25 | 4,730 / 12,641 |

What the table says:

- Two kinds of run. The budget clock restarts at the grant, so the load, the view and the rest of the diff are **inside** the hold. Subtracting the writes a run made (0.7 s a Film, 0.052 s a Person, the two production anchors) from its hold leaves its pre-write overhead: 09:02 53.5 s, 08:02 55.7 s, 07:01 8.3 s, 06:01 3.1 s, 05:02 58.0 s, 04:01 8.9 s, and earlier 03:01 60.5 s, 02:02 49.8 s, 01:01 51.3 s, 23:01 55.4 s, 21:01 58.4 s (11 productive runs of the last 30 hours: 3 fast with 3 to 9 s, 8 slow with 50 to 60 s). `loadMs` plus `viewMs` explain only 18 to 35 s of the slow overhead; the rest (the D1 reads of the diff: the 40,000-row checkpoint read, members, aliases, sync clocks) is **not instrumented** and its cause is not established. In a slow run nothing is left of the 60 s budget for writes.
- Persons alone: 775 Persons with 822 queries in 37.6 s and 42.5 s of write phase (06:01, 07:01), about 50 ms per query.
- Films: in the fixed runs the Film lane used 4.0 to 4.8 queries per Film and the checkpoints are about 0.7 s apart per Film, Persons of that Film included.
- Backlog and inflow, from the changed counts and what was written: Films about +55 an hour, Persons about +300 an hour (bursty, 0 to 470). The Film backlog is 4,730, of which 694 are admitted-first.
- Window wait is 0.8 to 40.5 s. It is a cost of every window, whatever is written in it.
- D1 holds 3,053 Films, 29,691 Persons and 37,321 credits (12.2 per Film, most Films 14 or fewer); the view has 7,673 Films and 40,825 Persons. The database is 1.3 GB of the 10 GB limit.

## 2. Platform limits that bear on the design (Cloudflare documentation, 2026-11-09)

| Limit | Value | Bearing |
| --- | --- | --- |
| Cron Trigger wall time | 15 min | The 60 s budget and 800 queries are **self-imposed** (ADR 0056); the window hold of 300 s (ADR 0103) is the real cap |
| CPU per invocation | 30 s default, up to 5 min (`limits.cpu_ms`) | Statement building plus in-memory SQLite is about 2 ms of CPU per Film in the benchmark (not Worker CPU), so 1,000 Films an hour is about 2 s |
| Subrequests per invocation | 10,000 on Workers Paid | A `db.batch()` counts as **one** query against the invocation limit, whatever its statements |
| D1 batch | each statement ≤ 100 KB and ≤ 100 bound parameters; no statement-count limit stated; a 2,000-statement batch is documented as fine | A group batch of 10 Films is about 770 statements |
| D1 concurrency | one database processes queries one at a time; up to 6 connections per invocation | Concurrent reads do not make writes parallel |
| Workflows | steps 10,000 default (25,000 max), CPU per invocation 30 s default, unlimited step wall time | A Workflow step can hold a longer run, but it still needs the same window |
| Database size | 10 GB | 1.3 GB used |

## 3. Method of the offline benchmark and the simulation

`scripts/projector-spike-bench.mjs` (offline only, `node scripts/projector-spike-bench.mjs --films 5000 --pool 8000`) loads the **real** `src/d1-enrichment.js` and `src/canonical-repository.js` as the bundle carries them (`tests/d1-enrichment-context.mjs`), applies the real migrations 0001 to 0004 to an in-memory SQLite (plus a one-row stand-in of the 0013 marker) and runs the unmodified projector on a synthetic store shaped like production (1 director and 11, 6 or 35 actors per Film, mean 12.2 credits; 1 to 5, mean 3, new Persons per Film; the rest of the actors from a pool the database already holds). The D1 stand-in counts every read, single write, batch and statement; time is a virtual clock (a round trip costs `rtt`, a statement in a batch `stmt`). The full run (5,000 Films, 20,000 new Persons, view of 5,728 Films and 28,728 Persons, 357,212 statements in 8,606 batches) takes 54 s on the benchmark machine and completes. Variant C replays the captured inputs in groups of 10 Films with their Persons (500 groups) and leaves **identical rows** (every canonical table and the change-key ids; run timestamps masked), 0 fallbacks.

Calibration (two production anchors from section 1): 775 Persons in 37.6 to 42.5 s and about 0.7 s per Film. `rtt` 35 to 50 ms with `stmt` 1 to 2 ms reproduces both, so the simulation draws `rtt` uniformly from 35 to 50 ms and `stmt` from 1 to 2 ms for every window.

`scripts/projector-spike-sim.mjs` simulates 24 hours (60 seeds) from the recorded state: Films 4,730 changed and +55 an hour, Persons 12,641 and +300 an hour (Poisson), the real lane rule (Films 3, Persons 2, cost in statements), per-unit D1 costs taken from the real runs, and for every window the recorded wait (0.8 to 40.5 s) and the **empirical pre-write overhead** of section 1, bootstrap-sampled. Request-to-release accounting follows ADR 0103: write time = deadline - wait - overhead - reserve (15 s), and a grant needs the minimum run time left. "Catch-up rate" is the mean of the first three hours, while the backlog lasts; the backlog itself bounds anything above about 1,600.

Validation of the model against production: the current path at 60 s from grant, simulated, writes a median of 7 Films in a window (p95 76); the two fixed-code runs of 2026-11-09 wrote 9 and 8 (both slow runs). The model is therefore about 12 to 22 % low for the slow case; the mean over fast and slow mixes is 22 Films an hour.

| Counter (per Film, real code, 5,000 Films) | A0 current | C bulk, group of 10 |
| --- | --- | --- |
| D1 round trips | 10.7 | 0.2 |
| Statements in batches | 71.4 | 95.3 (including one guard per distinct read and the prefetch's own SELECTs) |
| Same rows as A0 | n/a | yes (these fixtures) |
| Group batch latency p50 / p95 / max (`rtt` 50, `stmt` 1.5) | n/a | 1.53 / 1.62 / 1.68 s for a group of 10 Films with about 40 Persons |
| Film cost at the calibrated points | 0.45 to 0.68 s | 0.10 to 0.20 s |
| JS plus in-memory SQLite CPU per Film | 1.6 ms | 2.1 ms |

## 4. The three variants

- **A, minimal change.** One fenced batch per Film, reads concurrent (6 D1 connections), a Film's Persons in its batch. Round trips fall from 10.7 to about 4 per Film (modelled, not run); statements are unchanged.
- **B, resumable Cloudflare Workflow with a durable plan.** Not built. A plan made in one window is not valid in the next (the Discovery generation moves about 17 times a minute) without per-entity revalidation, which the owner rejected in [PR #429](https://github.com/vladimino/iptv-watchlist/pull/429). A Workflow therefore re-runs the whole window protocol per step: it removes no wait, no pre-write overhead and no statement; its value is only the trigger and the checkpoints between windows (section 6).
- **C, bulk write into the existing repository.** Built and tested as the prototype above. One group cycle: trace the repository's reads, fetch them and a digest of each in **one** read batch, run the same `projectFilm`/`projectPerson` against that read cache collecting the writes, and apply them in **one** fenced batch that first re-runs every prefetched read inside the batch and compares it with its digest, and asserts the lease (or window) and the marker generation. Any difference rolls the whole batch back and sends the group to the existing per-entity path. `tests/projector-bulk-spike.mjs` proves an appearing redirect, an owner review of a Person in the group, a marker generation move and a lost lease each refuse the group with no row written; an unseen read and an undigestable read fall back; the rows equal the per-entity path's when nothing interferes. Two D1 batches are **not** one snapshot: safety comes from the in-batch proof, not from the prefetch.
- **B plus C.** No throughput gain over C; see section 6.

## 5. Simulated throughput (60 seeds, calibrated box, recorded wait and overhead)

| Configuration | Catch-up Films an hour p10 / p50 / p90 | Films per window, first 3 h, p50 / p95 | Hold, % of time | Backlog 4,730 drained (median) |
| --- | --- | --- | --- | --- |
| A0 now, hourly, 60 s from grant | 4 / 22 / 50 | 7 / 76 | 2 | not in 24 h |
| A0, hourly, 150 s from grant | 117 / 134 / 171 | 129 / 211 | 4.5 | not in 24 h |
| A0, hourly, 240 s from grant | 230 / 250 / 293 | 248 / 343 | 7 | 17 h |
| C, hourly, 60 s from grant | 13 / 60 / 150 | 20 / 240 | 2 | not in 24 h |
| C, hourly, 150 s from grant | 337 / 397 / 497 | 390 / 640 | 4.5 | 9 h |
| **C, hourly, deadline 300 s (request to release), reserve 15 s** | **930 / 1,127 / 1,430** | 1,090 / 1,910 | 8.3 | 4 h |
| C, 4 windows an hour, deadline 75 s each (same 300 s/h cap) | 83 / 190 / 320 | 0 / 210 | 9.1 | 22 h (37 of 60 seeds) |
| C, 6 windows an hour, deadline 100 s each (600 s/h, 16.7 %) | 583 / 800 / 1,130 | 100 / 380 | 16.8 | 5.3 h |
| C, 4 windows an hour, deadline 150 s each (600 s/h, 16.7 %) | 1,503 / 1,631 / 1,638 | 370 / 840 | 16.7 | 2.8 h |
| What-if, slow overhead fixed (3 to 9 s): C, 4 windows, 75 s each | 563 / 720 / 847 | 170 / 300 | 8.3 | 5.8 h |
| What-if, slow overhead fixed: C, hourly, 300 s | 1,173 / 1,410 / 1,619 | 1,350 / 2,080 | 8.3 | 4 h |

Reading it:

- 60 s from grant gives nothing in any variant, because 8 of 11 recent runs spend 50 to 60 s before the first write. The 8 slow runs are the reason the backlog has not moved, more than the write path.
- Raising the wall budget alone helps the current path (A0 at 240 s: 250 an hour) but is not enough; with C the same budget gives 3 to 4 times more. 500 an hour is reached with C at the 300 s deadline (p10 930) and not at 150 s from grant (p10 337, p50 397).
- The 300 s deadline is not a 300 s write budget: with a mean wait of 13 s (worst 40.5 s), an overhead of 50 to 60 s in slow runs and a 15 s reserve, a slow window writes for about 217 s on average and at least 184 s in the worst recorded case (300 - 40.5 - 60.5 - 15); a grant needs 120 s left (`WINDOW_MIN_RUN_MS`), so a wait above 180 s refuses the window. Discovery admission is closed from the request, so the wait counts as hold.
- Splitting the same 300 s an hour into four windows does not help while the overhead is 55 s (median window writes 0). It becomes useful only after the overhead is cut (what-if: 720 an hour) or with a higher hold cap (16.7 %: 1,631 an hour). One long window is always the most efficient use of a hold second, because the wait, the overhead and the reserve are paid once.
- The 13,000-Person backlog: the Person lane writes 25 Persons per cycle for 9 statements each; in the simulation it drains alongside the Films within the first hours at the C configurations with 150 s or more.

## 6. Liveness: what "non-stop" costs, and the owner's decision

The product requirement of AIR-391 was progress between hourly ticks. Under the strict generation fence and ADR 0103's exclusive window that means **more windows**, each paying its own wait, overhead and reserve (section 5), never a plan that survives a release. Three consistent ways were measured:

1. **L1**, one long window an hour (C, deadline 300 s request to release): about 1,100 Films an hour, backlog gone in about 4 hours, hold 8.3 %. The projector idles about 55 minutes of every hour. Cheapest and most efficient per hold second.
2. **L2**, continuation windows within the same 8.3 % cap: effective only after the 50 to 60 s pre-write overhead is cut (what-if: 4 windows of 75 s, about 720 an hour).
3. **L3**, continuation windows at a higher cap (16.7 %): about 1,630 an hour today, at a cost to ADR 0103's accepted bound.

**Owner decision (2026-11-09, [PR #446](https://github.com/vladimino/iptv-watchlist/pull/446)):** variant C with L1 as the initial delivery direction, within the ADR 0103 cap of 300 s from request to release; the literal non-stop requirement is revised to "drain the backlog sustainably and keep pace with incoming changes". L2, L3, a continuation Workflow, a hold ledger, extra windows and a larger Discovery hold are **not** approved; they are revisited only if natural acceptance shows a concrete need. The un-explained 50 to 60 s overhead is investigated separately in [AIR-392](https://trello.com/c/ivMqVpKC) (diagnostic only). Acceptance is at least 500 changed Films an hour sustained, with Person progress, bounded Discovery and EPG impact and a shrinking backlog, shown by natural production runs, not by this simulation.

## Limitations

- `rtt` and `stmt` are calibrated from two production anchors, not measured; the real cost on D1 of a batch of about 950 statements has never been observed and may not be linear. The first D1 measurement is stage (c) of the proposal.
- The pre-write overhead is derived (hold minus estimated writes), bootstrap-sampled from 11 runs of one day; its cause in the slow mode is unknown, and the benchmark's own view CPU on the synthetic 5,728-Film store (28 s on this machine) is **not** representative of production's 0.45 to 2.2 s, so no snapshot or diff cost of the benchmark is used; the recorded production values are used instead. A representative R2 load and diff cannot be reproduced offline.
- The simulation uses mean unit costs per group type and the recorded Film inflow; it validates 12 to 22 % low against the two fixed-code production runs. The tiers above are exploratory estimates, not capacity targets.
- Not simulated: the Film sync clocks, owner overlays, the metadata cache read, admitted-first ordering, the Person-FK wait inside a Film group (Persons are written in the same batch before the Film).
- Row equivalence and read-validity are proven on these fixtures and this stand-in only. The marker used in the guard is a one-row stand-in of migration 0013's; the real marker's behaviour under a D1 writer is ADR 0099's contract and untested here.
