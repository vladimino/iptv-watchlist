# EPG producer durable execution: owner decision pack for D-C (design, not executed)

**Role:** the quantitative options for decision **D-C** of [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md) (`sliceSize`, `maxSlicesPerRun`, the slice deadline, the per-run ceiling and the numeric canonical-lag SLA), the arithmetic behind each option, what is still unmeasured, and a labelled recommendation. **This page decides nothing and authorizes nothing.** It starts no production read, no EPG run, no migration, flag, Task or marker change. The owner chooses; the choice is recorded in the ADR and the [E6 record](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md) in a separate PR.

Capture: 13 Nov 2026 (UTC), repository at `origin/main` `846c2bc`. Inputs are the E6 production measurement of 12 Nov 2026, the M3 telemetry evidence of 13 Nov 2026 and the code constants named below. Every "scenario" row is arithmetic over those inputs, **not a measurement**.

## One-page summary

| Question | Short answer |
| --- | --- |
| What does D-C fix? | Five numbers the S4-4 durable driver takes as REQUIRED parameters with NO default, and the lag promise readers get from `canonicalFreshness` |
| Is D-C ready to decide? | **Partly.** Film-facts volume (about 397 units per run) and its offline unit cost (14 round trips unchanged, 38 applied) are known. `changedShare`, Person and credit unit volume and cost, the round-trip time on the EPG path and the Workflow platform limits (M1) are **not measured** |
| What blocks a final choice? | M2b production read (`changedShare`, first-pass size, Person and credit cost) and the round-trip time; M1 was never recorded. The owner may choose provisional values now and re-decide after M2b; the pack marks which numbers survive either way |
| What is the hard design fact? | A pass that exhausts `maxSlicesPerRun` stays `passing` and is superseded by the **next run's** pass ([ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), decision 10): with one EPG run a day, an undersized ceiling means a 24 hour lag, not a slow catch-up |
| Recommendation (a recommendation, not a decision) | Option **B** below: `sliceSize` 25 (the existing `EPG_UNIT_LIMIT_DEFAULT`), `maxSlicesPerRun` 40, a per-run ceiling of 1,000 units, a slice deadline of 240 s, lag SLA "complete within one hour of the EPG commit, reported as `lagging` beyond it", provisional until M2b. Reasons in [the recommendation](#recommendation) |
| Needs the owner to sign | The five numbers (or "provisional B, re-decide after M2b"), and whether the lag SLA is a reporting threshold or an alert (ADR 0128 says no new alert) |

## What is known (inputs)

**Volumes, E6 production measurement of 12 Nov 2026** ([evidence](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md), an operator attestation):

| Input | Value |
| --- | --- |
| Watchlist Films per generation | about 394 to 395 members; 391 watchlist Films; 399 metadata and sync rows |
| Film-facts units per EPG run (observed plus departed) | about 397 and 395 |
| Persons credited from the watchlist | 6,452 Persons, 8,600 credit rows; credits per watchlist Film min 11, p50 22, max 26 |
| Whole catalog | 10,044 Films, 53,623 Persons, 107,064 credit rows, 34,936 dimension rows |
| Film updates per day | median 254 (max 5,884); Person updates per day median 1,550 (max 18,692) |

**Unit cost, offline sqlite stand-in** (`UNIT_COST` in `scripts/film-person-e6-measure.mjs`): an unchanged Film-facts unit costs 14 queries and 14 round trips; an applied one 36 queries in 2 batches, 38 round trips. This is Film-facts only. It is **not** a bound for Person or credit kinds.

**Code limits that constrain the choice:**

| Constant | Value | Where |
| --- | --- | --- |
| `EPG_UNIT_HARD_CAP` | 50 | `src/canonical-epg-producer.js` |
| `EPG_UNIT_LIMIT_DEFAULT` | 25 | `src/canonical-epg-producer.js` |
| `SLICE_STATEMENT_CAP` | 48 | `src/canonical-producer-store.js` (one `commitSlice` batch) |
| `DUE_LIMIT_MAX` | 50 | `src/canonical-producer-store.js` |
| `STRIKE_LIMIT` | 3 | `src/canonical-producer-run.js` |
| `LEASE_MS` / `BOUNDARY_MARGIN_MS` | 5 min / 15 s | `src/epg-orchestration.js` |
| `limits.cpu_ms` | 120,000 | `wrangler.jsonc` |

**Step and platform behaviour, M3** ([evidence](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md)): EPG step wall 4 to 36 s, with `seal_stage` the slow one (122.6 s in the natural run of 13 Nov, 146 s in the baseline). Two `Worker exceeded memory limit` deaths inside the EPG Workflow (invocations of 206 s with CPU 40.1 s, and 380 s with CPU 7.1 s), each followed by a roughly 300 s step-lease wait. The cause (memory accumulating across steps in one isolate) is a hypothesis, not measured. D1 calls per step, CPU per handler and a heap profile are not established.

**Store behaviour** ([producer run store reference](../reference/data/producer-run-store.md)): `commitSlice` is ONE batch (marker fence, run-revision compare-and-set, the slice's failure results, one cursor and counts UPDATE), capped at 48 statements. No slice size, budget or per-run ceiling is chosen there.

## What is NOT known

| Gap | Why it matters for D-C | Closed by |
| --- | --- | --- |
| `changedShare` (share of units that apply rather than no-op) | Moves the Film-only cost between 14 and 38 round trips per unit, a factor of 2.7 | M2b |
| Person and credit unit volume per run and their unit cost (`person_state`, `person_mutation`, `film_credits`) | The first pass after activation and every credit-bearing run depend on it; the E6 numbers are upper bounds on the population (up to about 391 credit units and 6,452 Person units), not per-run volumes | M2b |
| Round-trip time on the EPG path (D1 from the Worker) | Turns round trips into seconds; the only way to size a slice deadline | M2b or a measured EPG step with D1 `meta` |
| Workflow platform limits (M1: step duration, CPU and memory per step, steps per instance) | An upper bound on `maxSlicesPerRun` and on the wiring choice | M1, never recorded |
| Why the EPG Workflow died of memory twice | A producer pass in the same isolate may inherit the problem | Not planned; see [the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md) |
| The wiring point of the pass (Workflow step or other) | Decides whether the pass has its own lease or shares the commit's | S5-1 gate, [evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md) |

## The arithmetic

All figures are Film-facts units only, 397 units per run, 14 round trips unchanged and 38 applied (so 14 + 24 x `changedShare` per unit). Scenarios, not measurements.

**Round trips per run by `changedShare` (Film-facts only):**

| `changedShare` | 0 | 0.1 | 0.25 | 0.5 | 1 |
| --- | --- | --- | --- | --- | --- |
| Round trips per run | 5,558 | 6,511 | 7,940 | 10,322 | 15,086 |

**Wall time per run at an assumed round-trip time** (round trips x time; a time that was NOT measured, shown only to size the lease risk):

| Round trip | `changedShare` 0 | 0.25 | 1 |
| --- | --- | --- | --- |
| 5 ms | 28 s | 40 s | 75 s |
| 20 ms | 111 s | 159 s | 302 s |
| 50 ms | 278 s | 397 s | 754 s |

Reading: at 20 ms a fully changed Film-only run (302 s) already exceeds one 300 s lease window, and at 50 ms even `changedShare` 0.25 does. A pass that must fit one step needs M2b's round-trip time before the deadline is meaningful.

**Slices per run and per-slice cost by `sliceSize` (Film-only, 397 units):**

| `sliceSize` | Slices per run | Round trips per slice, unchanged / applied | Slices for the first-pass upper bound of 7,240 units (397 + 391 + 6,452) |
| --- | --- | --- | --- |
| 10 | 40 | 140 / 380 | 724 |
| 25 | 16 | 350 / 950 | 290 |
| 50 | 8 | 700 / 1,900 | 145 |

The 7,240 figure is the sum of three population upper bounds, not a measured first-pass size, and Person and credit units cost something other than 14 or 38 round trips (unmeasured). Add one `commitSlice` batch round trip per slice.

**Statement cap (derived, to be confirmed by S4-4):** `commitSlice` needs a fixed set of statements (marker fence, run-revision compare-and-set, the cursor and counts UPDATE, three in all, by the store's description) plus one per failure write. With the 48-statement cap that leaves room for at most about 45 failure writes in one slice, so a `sliceSize` of 50 can hit the cap only if nearly every unit fails. The driver must end the slice early in that case; it is an S4-4 requirement, not a D-C number.

**Steady state needs the ceiling above the plan.** The per-run ceiling in units is `sliceSize x maxSlicesPerRun`. If it is below about 397 (the Film-facts plan), each daily pass is partial, ends `passing`, and is superseded by the next day's pass: the canonical store never catches up. Any option below 400 is therefore rejected without needing M2b.

## Options

`maxSlicesPerRun` and the ceiling are in units per run. The deadline is the time, counted from the start of the producer step's invocation, after which the driver starts no further slice and ends the pass `passing`; it must sit inside the 5 minute lease with its 15 s margin, so it can never exceed 285 s. (This definition is the pack's reading of the ADR sentence "the slice deadline must sit inside the 5 minute step lease with its margin"; S4-4 fixes the exact semantics.)

| Option | `sliceSize` | `maxSlicesPerRun` | Per-run ceiling (units) | Slice deadline | Film-only: fits when | First pass (upper-bound population) | Main risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A, small slices** | 10 | 50 | 500 | 240 s | steady state yes (397 < 500); about 140 to 380 round trips per slice | 500 of 7,240 units per run: about 15 runs, 15 days | Many commits (50 per run) and many fence reads; slow first pass |
| **B, the existing default** | 25 | 40 | 1,000 | 240 s | steady state yes; 350 to 950 round trips per slice; 16 slices cover the Film-only run | 1,000 of 7,240: about 8 runs | Middle of the road; a slice at 950 round trips and 50 ms is 47.5 s, inside the deadline |
| **C, the hard cap** | 50 | 20 | 1,000 | 240 s | steady state yes; 700 to 1,900 round trips per slice (95 s at 50 ms and `changedShare` 1) | 1,000 of 7,240: about 8 runs | Fewer commits, but a longer slice at risk of the lease and of a memory death mid-slice (M3), and a larger replay on a lost slice |
| **D, large ceiling** | 25 | 100 | 2,500 | 270 s | steady state yes; first pass in about 3 runs | 2,500 of 7,240: about 3 runs | The pass can use most of one lease; with the observed memory deaths and `seal_stage` of 122 to 146 s it competes with the commit's own step if not separated |

**Does the Film-only run fit the deadline?** The deadline bounds the whole pass of one invocation, so it must exceed the Film-only run's wall time (round trips x round-trip time, from the table above). A pass that hits the deadline ends `passing` and is superseded by the next run's pass (decision 10), so the deadline, not the unit ceiling, is what sets the lag when the round trip is slow.

| Deadline | 5 ms (28 / 40 / 75 s) | 20 ms (111 / 159 / 302 s) | 50 ms (278 / 397 / 754 s) |
| --- | --- | --- | --- |
| 120 s | fits at every `changedShare` shown | fits only at `changedShare` 0 | never |
| 240 s | fits at every share shown | fits up to `changedShare` 0.5 (206 s), not at 1 | never |
| 270 s | fits at every share shown | fits up to `changedShare` 0.75 (254 s), not at 1 | never |

The three values in each header are `changedShare` 0, 0.25 and 1. At 50 ms no deadline below the 285 s ceiling holds a Film-only run in one invocation, so a pass would be partial every day; that case needs either a measured faster path, a cheaper unit (fewer round trips per unit, a different change than D-C) or a resume across invocations that ADR 0128 does not currently allow. M2b's round-trip time decides which table row is real.

Rejected: any option with a per-run ceiling under 397 (steady state never completes); a `sliceSize` above 50 (above `EPG_UNIT_HARD_CAP`); a slice deadline above 285 s (above the lease less its margin).

The first-pass columns assume the same unit cost for every kind and are only a scale. M2b replaces them.

## Lag SLA options

"Canonical lag" is the time from the EPG commit until `canonicalFreshness` can report the generation complete (ADR 0128 decision 11: `applied_generation` is set only by the pass-complete commit). Readers fail closed or label the state non-current until then; the SLA is the number the owner accepts for "labelled non-current".

| Option | Promise | What it requires | What it cannot promise |
| --- | --- | --- | --- |
| **L1** | Complete within 1 hour of the commit, in the same Workflow run | The pass runs right after the commit (the Workflow step wiring in [the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md)) and its ceiling covers the plan | A first pass larger than the ceiling; any pass interrupted by a memory death (the instance retries after the lease wait of about 5 minutes, so that case adds minutes, not hours, but only if the step is retried at all) |
| **L2** | Complete within 6 hours | The same, plus tolerating a pass that needs a retry | Same as L1 for an undersized ceiling |
| **L3** | Complete by the next daily run (24 hours) | Nothing beyond a bounded partial pass superseded by the next run | Anything faster; it is the floor ADR 0128 already implies for an undersized ceiling |

In all three, no new alert is added (ADR 0128 decision 10: the state surfaces through the read model and derived readiness blockers). A numeric SLA is therefore a reporting threshold for the `producer` object, not a pager.

## Recommendation

**This section is a recommendation of the pack's author, not a decision and not an owner approval.**

- **Option B**, `sliceSize` 25, `maxSlicesPerRun` 40, per-run ceiling 1,000 units, slice deadline 120 s, lag SLA **L1 as a reporting threshold** (one hour), **provisional until M2b**.
- Why B: 25 equals the existing `EPG_UNIT_LIMIT_DEFAULT`, so the planner already produces slices of that size and no new unit shape is introduced; the ceiling is about 2.5 times the Film-facts plan, so the unit ceiling is never the limit in steady state; a 240 s deadline holds the Film-only run at 5 ms for every share shown and at 20 ms up to `changedShare` 0.5, and still leaves 45 s inside the lease for the slice running when the deadline hit. Against A: up to 50 commits a run, and a slower first pass. Against C: a smaller replay when a slice is lost, with the memory deaths of M3 in mind. Against D: a pass bounded well inside the lease.
- What would change it: a round-trip time near 50 ms (no deadline holds the Film-only run; the pass is partial daily and L1 cannot be promised, so the owner would have to choose L3 or ask for a cheaper unit), a measured `changedShare` near 1 (lower `sliceSize`), M1 platform limits below the lease (lower the deadline), a measured Person or credit cost far above 38 round trips per unit (raise the ceiling or accept a multi-run first pass explicitly).
- What survives M2b unchanged: the rejection of any ceiling below 397, the hard bounds (50, 285 s) and the principle that a partial pass is superseded by the next run.

## What stays NOT authorized by this page

- No production read: the M2b production copy and any D1 or R2 read need their own explicit, operation-specific owner GO (digest and scope in [the M2b runbook](film-person-m2b-dry-run-copy.md)).
- No EPG run, no producer pass, no S4-4 or S5-1 code merge, no migration, no flag, no Scheduled Task, no marker switch, no H2 (`prepared` to `open`), and no change to `D1_ENRICHMENT_*`, `DISCOVERY_EXECUTOR` or `MONITOR`.
- No ADR edit: a decision here is recorded in ADR 0128 and the E6 record in a separate PR after the owner signs.

## Not verified here

- Any live value: the marker, flags, EPG mode, schema version and run state were not read (no production access in this change).
- `changedShare`, Person and credit unit counts per run, their unit cost, the round-trip time, D1 calls and CPU per EPG step, the heap behaviour and M1 limits.
- That the slice deadline semantics above match what S4-4 will implement.
- The statement-cap arithmetic ("three fixed statements"): derived from the store's description, to be confirmed against `commitSlice` in S4-4.
- Every scenario value in this page (round trips per run, wall time, slices) is arithmetic over the inputs listed, not an observation.

Related: [holdpoint decision pack](film-person-holdpoint-decision-pack.md), [S5-1 `nextAction` gate evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md), [M3 evidence](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md), [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), [runbook index](README.md).
