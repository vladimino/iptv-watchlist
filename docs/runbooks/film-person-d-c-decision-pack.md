# EPG producer durable execution: owner decision pack for D-C (design, not executed)

**Role:** the quantitative options for decision **D-C** of [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md) (`sliceSize`, `maxSlicesPerRun`, the slice deadline, the per-run ceiling and the numeric canonical-lag SLA), the arithmetic behind each option, what is still unmeasured, and a labelled recommendation. **This page decides nothing and authorizes nothing.** It starts no production read, no EPG run, no migration, flag, Task or marker change. The owner chooses; the choice is recorded in the ADR and the [E6 record](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md) in a separate PR.

Capture: 13 Nov 2026 (UTC), repository at `origin/main` `846c2bc`, updated 14 Nov 2026 with the synthetic measurement. Inputs are the E6 production measurement of 12 Nov 2026, the M3 telemetry evidence of 13 Nov 2026, the synthetic harness run of 14 Nov 2026 and the code constants named below. E6 counts, modelled synthetic cost and still-unmeasured production cost are kept apart. Every "scenario" row is arithmetic over those inputs, **not a measurement**.

## One-page summary

| Question | Short answer |
| --- | --- |
| What does D-C fix? | Five numbers the S4-4 durable driver takes as REQUIRED parameters with NO default, and the lag promise readers get from `canonicalFreshness` |
| Is D-C ready to decide? | **Partly.** Film-facts volume (about 397 units per run) and its offline unit cost (14 round trips unchanged, 38 applied) are known. A synthetic catalog at the E6 aggregate scale has now also been planned by the real harness ([measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md)): 7,240 units on the generation-shaped cohort, 14,474 on a heavier modelled cohort. That run does **not** measure production `changedShare`, `person_state`, the Worker to D1 round-trip time, D1 write cost or the Workflow platform limits (M1) |
| What blocks a final choice? | Those unmeasured items. The synthetic run supplies modelled unit volume, local statement counts and local plan and fingerprint time. It does not price a round trip or an applied write, and it does not choose the five numbers. The owner may choose provisional values; the pack marks which numbers survive either way |
| What is the hard design fact? | The ceiling is **per generation**. A pass that exhausts `maxSlicesPerRun` stays `passing` and is superseded by the **next run's** pass ([ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), decision 10); the ADR does not say the next run resumes the previous cursor. An undersized ceiling or deadline can therefore leave every generation `lagging` or fail-closed, with no multi-day completion promised ([per-generation cap](#the-per-generation-cap-and-what-it-does-not-promise)) |
| Recommendation (a recommendation, not a decision) | **No full-plan option is recommended.** Option B (`sliceSize` 25, `maxSlicesPerRun` 40, ceiling 1,000) is a Film-only illustration: 25 × 40 = 1,000 visits, and the modelled plan is 7,240 units before `person_state`. A faster or no-op unit does not reduce that count. Choosing a strategy that can finish the full plan is a separate architecture and owner decision. This pack does not make it and does not implement catch-up. Reasons in [the recommendation](#recommendation) |
| Needs the owner to sign | Nothing on this page. The five numbers are not chosen. A viable full-plan completion strategy is a separate architecture and owner decision |

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

**Modelled plan volume, synthetic harness of 14 Nov 2026** ([evidence](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md)): the real planner on a catalog built to the E6 totals, not a production sample. Steady: 7,240 units (397 `film_facts` including 6 departed, 6,452 `person_mutation`, 391 `film_credits`), 30,999 statements prepared. Elevated (a repeated model, not a second production generation): 14,474 units, 61,890 statements. A separate credit-cap stress observes one rest Film of 50 credits alone (52 units, 213 statements). It is not the E6 cohort. Harness `changedShare` 0 is the fixture matching itself. These figures are not the E6 counts and not a production cost. A no-op is still one unit, so the 7,240 count does not fit a ceiling of 1,000.

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
| `changedShare` (share of units that apply rather than no-op) | Moves the Film-only cost between 14 and 38 round trips per unit, a factor of 2.7 | **Not the synthetic run.** Stored units are no-ops because the fixture wrote the rows the harness reads back (harness share 0). Plausible future sources: the S5-2 differential (`epg_commit_natural`) and a later authorized observation of a real EPG commit's planned units. E6 `film_updates_by_day` (median 254) is not automatically the applied-unit share |
| Person and credit unit volume per run and their unit cost (`person_mutation`, `film_credits`) | The first pass after activation and every credit-bearing run depend on it | **Volume, on the synthetic model only.** The harness planned 6,452 `person_mutation` and 391 `film_credits` beside 397 `film_facts` (7,240 units), and 4 statements per Person or credit unit on the no-op path. The applied cost per unit still needs S5-2 or a later observation. The E6 population figures are not themselves per-run volumes |
| `person_state` units (localized Person names) | Not built by the harness, reported unmeasured | Not the synthetic run. A future harness extension once the unit is built, or the S5-2 differential |
| Round-trip time on the EPG path (Worker to D1) | Turns statement counts into seconds; the only way to size a slice deadline | **Not the synthetic run** (local sqlite). Plausible future sources: D1 `meta` timings on a natural EPG step, as AIR-396 did for the projector, or instrumentation shipped in a reviewed code change and observed under a separate GO |
| Workflow platform limits (M1: step duration, CPU and memory per step, steps per instance) | An upper bound on `maxSlicesPerRun` and on the wiring choice | M1, never recorded |
| Why the EPG Workflow died of memory twice | A producer pass in the same isolate may inherit the problem | Not planned; see [the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md) |
| The wiring point of the pass (Workflow step or other) | Decides whether the pass has its own lease or shares the commit's | S5-1 gate, [evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md) |

## What the synthetic M2b run measured, and what it did not

From [the M2b runbook](film-person-m2b-dry-run-copy.md) and the [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md) of 14 Nov 2026 (UTC). The catalog is a deterministic model at the E6 aggregate totals, not a production sample. The harness is the production planner behind the read-only guard, on local sqlite.

| Measured on that model | Not measured |
| --- | --- |
| Unit volume by kind. Steady: 7,240 units (397 `film_facts` including 6 departed, 6,452 `person_mutation`, 391 `film_credits`). Elevated: 14,474 units. Absence: 3 unknown departed ids are `unresolved_release` and the fingerprint is incomplete. Return: those 6 departed Films are observed, not released, once they are on the watchlist | Production `changedShare`. The harness `changedShare` was 0 because every stored unit matched rows the fixture had just written |
| Statements prepared on the stand-in. Steady 30,999 (p50 4, max 18), which reconciles as 9 per observed Film, 18 per release, 4 per Person or credit unit. Elevated 61,890, same shape | `person_state`: not built, reported unmeasured. An applied (write) cost per unit |
| Local plan and fingerprint time. Steady 17.8 ms and 23.5 ms for 7,240 entries; elevated 21.6 ms and 33.7 ms for 14,474. Local wall 2.8 s and 4.4 s on the measurement machine | Worker to D1 round-trip time, D1 CPU, Workflow limits (M1), memory behaviour. Local milliseconds do not convert the statement count into a deadline |

The E6 counts in [what is known](#what-is-known-inputs) are production aggregates. The rows above are modelled cost on a catalog built to those aggregates. A run the verifier marks inconsistent is `notADCInput`. No production read is requested by this pack. The full-table copy remains blocked and is not a step that has to be chosen before a provisional decision.

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

Reading: at 20 ms a fully changed Film-only run (302 s) already exceeds one 300 s lease window, and at 50 ms even `changedShare` 0.25 does. A pass that must fit one step needs a measured Worker to D1 round-trip time (not an M2b output) before the deadline is meaningful.

**Slices per run and per-slice cost by `sliceSize` (Film-only, 397 units):**

| `sliceSize` | Slices per run | Round trips per slice, unchanged / applied | Slices to cover the unit-count upper bound of 7,240 (397 + 391 + 6,452), plain division |
| --- | --- | --- | --- |
| 10 | 40 | 140 / 380 | 724 |
| 25 | 16 | 350 / 950 | 290 |
| 50 | 8 | 700 / 1,900 | 145 |

The 7,240 figure was first the sum of three population upper bounds. The synthetic harness emits exactly that plan for the generation-shaped cohort (397 + 6,452 + 391), so the count is the planner's output on the model, still before `person_state`, and still not a production measurement. The slice counts are plain division (units / `sliceSize`), not a measured completion throughput. A Person or credit unit on the no-op path prepared 4 statements, not 14 or 38; the applied cost is unmeasured. Add one `commitSlice` batch round trip per slice.

**Statement cap (derived, to be confirmed by S4-4):** `commitSlice` needs a fixed set of statements (marker fence, run-revision compare-and-set, the cursor and counts UPDATE, three in all, by the store's description) plus one per failure write. With the 48-statement cap that leaves room for at most about 45 failure writes in one slice, so a `sliceSize` of 50 can hit the cap only if nearly every unit fails. The driver must end the slice early in that case; it is an S4-4 requirement, not a D-C number.

**Steady state needs the ceiling above the plan.** The per-run ceiling in units is `sliceSize x maxSlicesPerRun`. If it is below about 397 (the Film-facts plan), each daily pass is partial, ends `passing`, and is superseded by the next day's pass: the canonical store never catches up. Any option below 400 is therefore rejected without any further measurement.

## Options

`maxSlicesPerRun` and the ceiling are in units per run. The deadline is the time, counted from the start of the producer step's invocation, after which the driver starts no further slice and ends the pass `passing`; it must sit inside the 5 minute lease with its 15 s margin, so it can never exceed 285 s. (This definition is the pack's reading of the ADR sentence "the slice deadline must sit inside the 5 minute step lease with its margin"; S4-4 fixes the exact semantics.)

| Option | `sliceSize` | `maxSlicesPerRun` | Per-run ceiling (units) | Slice deadline | Film-only: fits when | Unit-count upper bound 7,240 versus this ceiling | Main risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A, small slices** | 10 | 50 | 500 | 240 s | steady state yes (397 < 500); about 140 to 380 round trips per slice | Covers 500 of 7,240 units per generation (plain 7,240 / 500 = 14.5); no multi-day completion is implied | Many commits (50 per run) and many fence reads; slow first pass |
| **B, the existing default** | 25 | 40 | 1,000 | 240 s | steady state yes; 350 to 950 round trips per slice; 16 slices cover the Film-only run | Covers 1,000 of 7,240 per generation (plain 7,240 / 1,000 = 7.2); no multi-day completion is implied | Middle of the road; a slice at 950 round trips and 50 ms is 47.5 s, inside the deadline |
| **C, the hard cap** | 50 | 20 | 1,000 | 240 s | steady state yes; 700 to 1,900 round trips per slice (95 s at 50 ms and `changedShare` 1) | Covers 1,000 of 7,240 per generation (7.2 by plain division); no multi-day completion is implied | Fewer commits, but a longer slice at risk of the lease and of a memory death mid-slice (M3), and a larger replay on a lost slice |
| **D, large ceiling** | 25 | 100 | 2,500 | 270 s | steady state yes | Covers 2,500 of 7,240 per generation (2.9 by plain division); no multi-day completion is implied | The pass can use most of one lease; with the observed memory deaths and `seal_stage` of 122 to 146 s it competes with the commit's own step if not separated |

**Does the Film-only run fit the deadline?** The deadline bounds the whole pass of one invocation, so it must exceed the Film-only run's wall time (round trips x round-trip time, from the table above). A pass that hits the deadline ends `passing` and is superseded by the next run's pass (decision 10), so the deadline, not the unit ceiling, is what sets the lag when the round trip is slow.

| Deadline | 5 ms (28 / 40 / 75 s) | 20 ms (111 / 159 / 302 s) | 50 ms (278 / 397 / 754 s) |
| --- | --- | --- | --- |
| 120 s (considered, not proposed) | fits at every `changedShare` shown | fits only at `changedShare` 0 | never |
| **240 s (Film-only illustration, not a full-plan proposal)** | fits at every share shown | fits up to `changedShare` 0.5 (206 s), not at 1 | never |
| 270 s (option D only) | fits at every share shown | fits up to `changedShare` 0.75 (254 s), not at 1 | never |

The three values in each header are `changedShare` 0, 0.25 and 1. At 50 ms no deadline below the 285 s ceiling holds a Film-only run in one invocation, so a pass would be partial every day; that case needs either a measured faster path, a cheaper unit (fewer round trips per unit, a different change than D-C) or a catch-up design that ADR 0128 does not currently provide (see the next section). A measured round-trip time decides which table column is real.

Rejected: any option with a per-run ceiling under 397 (steady state never completes); a `sliceSize` above 50 (above `EPG_UNIT_HARD_CAP`); a slice deadline above 285 s (above the lease less its margin).

The 7,240 column assumes nothing about unit cost and is only a scale of the population. It is not a completion estimate.

## The per-generation cap and what it does not promise

`maxSlicesPerRun` and the deadline cap the work a pass may do for ONE generation. When either is reached the pass stays `passing` and the next run's pass supersedes it (decision 10). The ADR does not say that the next run resumes the previous plan's cursor; decision 3 says a changed plan replays from the start. So:

- 7,240 / 1,000 = 7.2 is plain arithmetic about counts. It is not "seven or eight days to finish": a new generation may start its pass from the beginning of its own plan, and a deadline that cuts the same amount of work every day finishes the same prefix every day.
- The state that follows is a **perpetual `lagging` (or fail-closed) generation**: readers see it labelled non-current or are refused (decision 11), run after run, with no end date.
- Promising multi-day completion needs one of: (a) a **catch-up or resume design** (a cursor that survives into the next generation's pass, or a catch-up pass of its own), which is an ADR 0128 amendment and an S4-4 change, not a D-C number and not implemented here; (b) a **separately designed pre-plan filter** that removes units before the ceiling counts them; or (c) a ceiling and deadline that cover the whole plan in one generation. A no-op is still one visit. Cheaper no-ops can change a time deadline. They cannot make 7,240 units fit a cap of 1,000 unless that filter actually reduces the plan. Choosing among (a), (b) and (c) is a separate architecture and owner decision. This pack does not make it.
- No measured completion throughput exists for any option. None of the figures in this pack is one.

## Lag SLA options

"Canonical lag" is the time from the EPG commit until `canonicalFreshness` can report the generation complete (ADR 0128 decision 11: `applied_generation` is set only by the pass-complete commit). Readers fail closed or label the state non-current until then; the SLA is the number the owner accepts for "labelled non-current".

| Option | Promise | What it requires | What it cannot promise |
| --- | --- | --- | --- |
| **L1** | Complete within 1 hour of the commit, in the same Workflow run | The pass runs right after the commit (the Workflow step wiring in [the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md)), and the per-generation ceiling and deadline cover the whole plan | A plan larger than the ceiling or deadline (that generation stays `lagging`); any pass interrupted by a memory death (the instance retries after the lease wait of about 5 minutes, so that case adds minutes, not hours, but only if the step is retried at all) |
| **L2** | Complete within 6 hours | The same, plus a retry of an interrupted step inside the window | Same as L1 for a plan larger than the per-generation cap |
| **L3** | No completion time promised; completion is reported per generation as `current`, `lagging` or `partial` | Nothing beyond the bounded pass of decision 10 | Any completion time. It does NOT mean "by the next daily run": a pass cut by the ceiling or deadline is superseded, not resumed, so a generation can stay `lagging` indefinitely unless a catch-up design (previous section) exists |

In all three, no new alert is added (ADR 0128 decision 10: the state surfaces through the read model and derived readiness blockers). A numeric SLA is therefore a reporting threshold for the `producer` object, not a pager.

## Recommendation

**This section is a recommendation of the pack's author, not a decision and not an owner approval.**

- **No option below is recommended for the full plan.** The modelled generation is 7,240 units before `person_state`. Option B allows 25 × 40 = 1,000 visits per generation. A unit that is a no-op is still one of those visits, so faster processing cannot put 7,240 units inside a 1,000-unit cap. B is a **Film-only illustration** of the existing `EPG_UNIT_LIMIT_DEFAULT`, not a recommended full-plan option.
- The Film-only illustration, for that narrower plan only: `sliceSize` 25, `maxSlicesPerRun` 40, ceiling 1,000 units, slice deadline 240 s (inside the 285 s limit of the 5 minute lease less its 15 s margin). 25 equals `EPG_UNIT_LIMIT_DEFAULT`. The ceiling is about 2.5 times the Film-facts plan of about 397, so the unit ceiling is not the limit while the plan is Film-facts alone. At an assumed 5 ms the Film-only run fits 240 s at every `changedShare` shown, and at 20 ms it fits up to 0.5. None of that prices the 7,240-unit plan, and none of it is an owner-approved parameter. L1 is not promised.
- What the synthetic run shows about that illustration: local plan and fingerprint time (under 40 ms at 14,474 units) is not what makes the deadline. A serial reading of the steady 30,999 statements at an assumed 20 ms is about 620 s, which is arithmetic, not a measurement. The credit-cap stress is one rest Film of 50 credits observed alone (52 units, 213 statements). It is not the E6 cohort, and it does not change the 7,240 count.
- A strategy that can finish the full plan is one of the three in [the per-generation cap](#the-per-generation-cap-and-what-it-does-not-promise): a catch-up design, a pre-plan filter that actually removes units, or a ceiling that covers the plan. That choice is a separate architecture and owner decision. This pack does not implement catch-up and does not choose the strategy.
- What survives any later measurement unchanged: the rejection of any ceiling below 397 for a Film-facts plan, the hard bounds (50, 285 s), the principle that a partial pass is superseded, not resumed, and the fact that a no-op does not reduce the unit count.

## What stays NOT authorized by this page

- No production read: the synthetic path needs none. The blocked full-table copy, and any later small sample, need their own explicit, operation-specific owner GO (scope in [the M2b runbook](film-person-m2b-dry-run-copy.md)). Choosing a full-table delivery option is not a prerequisite for a provisional decision.
- No EPG run, no producer pass, no S4-4 or S5-1 code merge, no migration, no flag, no Scheduled Task, no marker switch, no H2 (`prepared` to `open`), and no change to `D1_ENRICHMENT_*`, `DISCOVERY_EXECUTOR` or `MONITOR`.
- No ADR edit: a decision here is recorded in ADR 0128 and the E6 record in a separate PR after the owner signs.

## Not verified here

- Any live value: the marker, flags, EPG mode, schema version and run state were not read (no production access in this change).
- Production `changedShare` (the synthetic harness share of 0 is the fixture matching itself), `person_state`, Person and credit applied cost per unit, the Worker to D1 round-trip time, D1 CPU per EPG step, the heap behaviour and M1 limits, and any completion throughput. The synthetic statement counts and local timings are recorded; they are not those quantities.
- Whether the next run's pass restarts its plan from the beginning (read from ADR 0128 decisions 3 and 10, which do not say it resumes).
- That the slice deadline semantics above match what S4-4 will implement.
- The statement-cap arithmetic ("three fixed statements"): derived from the store's description, to be confirmed against `commitSlice` in S4-4.
- Every scenario value in this page (round trips per run, wall time, slices) is arithmetic over the inputs listed, not an observation.

Related: [holdpoint decision pack](film-person-holdpoint-decision-pack.md), [S5-1 `nextAction` gate evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md), [M3 evidence](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md), [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), [runbook index](README.md).
