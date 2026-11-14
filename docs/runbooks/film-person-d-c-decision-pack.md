# EPG producer durable execution: owner decision pack for D-C (design, not executed)

**Role:** the quantitative options for decision **D-C** of [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md) (`sliceSize`, `maxSlicesPerRun`, the slice deadline, the per-invocation ceiling and the numeric canonical-lag SLA), the arithmetic behind each option, what is still unmeasured, and a labelled recommendation. **This page decides nothing and authorizes nothing.** It starts no production read, no EPG run, no migration, flag, Task or marker change. The owner chooses; the choice is recorded in the ADR and the [E6 record](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md) in a separate PR.

Capture: 13 Nov 2026 (UTC), repository at `origin/main` `846c2bc`, updated 14 Nov 2026 with the synthetic measurement. Inputs are the E6 production measurement of 12 Nov 2026, the M3 telemetry evidence of 13 Nov 2026, the synthetic harness run of 14 Nov 2026 and the code constants named below. E6 counts, modelled synthetic cost and still-unmeasured production cost are kept apart. Every "scenario" row is arithmetic over those inputs, **not a measurement**.

## One-page summary

| Question | Short answer |
| --- | --- |
| What does D-C fix? | Five numbers the S4-4 durable driver takes as REQUIRED parameters with NO default, and the lag promise readers get from `canonicalFreshness` |
| Is D-C ready to decide? | **Partly.** Film-facts volume (about 397 units per run) and its offline unit cost (14 round trips unchanged, 38 applied) are known. A synthetic catalog at the E6 aggregate scale has now also been planned by the real harness ([measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md)): 7,240 units on the generation-shaped cohort, 14,474 on a heavier modelled cohort. That run does **not** measure production `changedShare`, `person_state`, the Worker to D1 round-trip time, D1 write cost or the observed consumption of the Workflow subrequest budget (the documented platform limits, M1, are recorded in [the M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md)) |
| What blocks a final choice? | Those unmeasured items. The synthetic run supplies modelled unit volume, local statement counts and local plan and fingerprint time. It does not price a round trip or an applied write, and it does not choose the five numbers. The owner may choose provisional values; the pack marks which numbers survive either way |
| What is the hard design fact? | The ceiling and the deadline bound ONE INVOCATION of the pass. The run row survives between invocations of the same run: an equal recomputed fingerprint resumes the cursor, while a changed fingerprint within the same run (source drift) resets the cursor and increments `pass_no`, and a new EPG run supersedes an unfinished pass ([ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), decisions 3 and 10). Whether a generation can reach `current` therefore depends on the wiring: with one invocation per generation (scenario A) a plan larger than one invocation stays `lagging` or fail-closed; with repeated invocations of the same run (scenario B) progress is bounded and resumable. Which wiring S5-1 supplies is an open owner decision The platform's subrequest budget per Workflow instance is a further limit whose real consumption is unmeasured ([scenarios A and B](#scenarios-a-and-b)) |
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
| Subrequests per Workflow instance | 10,000 by default (`limits.subrequests` is not set); D1 calls count | Platform default, [M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md) |

**Step and platform behaviour, M3** ([evidence](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md)): EPG step wall 4 to 36 s, with `seal_stage` the slow one (122.6 s in the natural run of 13 Nov, 146 s in the baseline). Two `Worker exceeded memory limit` deaths inside the EPG Workflow (invocations of 206 s with CPU 40.1 s, and 380 s with CPU 7.1 s), each followed by a roughly 300 s step-lease wait. The cause (memory accumulating across steps in one isolate) is a hypothesis, not measured. D1 calls per step, CPU per handler and a heap profile are not established.

**Store behaviour** ([producer run store reference](../reference/data/producer-run-store.md)): `commitSlice` is ONE batch (marker fence, run-revision compare-and-set, the slice's failure results, one cursor and counts UPDATE), capped at 48 statements. No slice size, budget or per-run ceiling is chosen there.

## What is NOT known

| Gap | Why it matters for D-C | Closed by |
| --- | --- | --- |
| `changedShare` (share of units that apply rather than no-op) | Moves the Film-only cost between 14 and 38 round trips per unit, a factor of 2.7 | **Not the synthetic run.** Stored units are no-ops because the fixture wrote the rows the harness reads back (harness share 0). Plausible future sources: the S5-2 differential (`epg_commit_natural`) and a later authorized observation of a real EPG commit's planned units. E6 `film_updates_by_day` (median 254) is not automatically the applied-unit share |
| Person and credit unit volume per run and their unit cost (`person_mutation`, `film_credits`) | The first pass after activation and every credit-bearing run depend on it | **Volume, on the synthetic model only.** The harness planned 6,452 `person_mutation` and 391 `film_credits` beside 397 `film_facts` (7,240 units), and 4 statements per Person or credit unit on the no-op path. The applied cost per unit still needs S5-2 or a later observation. The E6 population figures are not themselves per-run volumes |
| `person_state` units (localized Person names) | Not built by the harness, reported unmeasured | Not the synthetic run. A future harness extension once the unit is built, or the S5-2 differential |
| Round-trip time on the EPG path (Worker to D1) | Turns statement counts into seconds; the only way to size a slice deadline | **Not the synthetic run** (local sqlite). Plausible future sources: D1 `meta` timings on a natural EPG step, as AIR-396 did for the projector, or instrumentation shipped in a reviewed code change and observed under a separate GO |
| Observed D1 calls per EPG step and per instance, and memory behaviour across steps (the documented platform limits, M1, are recorded in [the M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md)) | The documented subrequest budget per instance is only useful against a measured consumption; the platform does not document whether memory is released between steps | Not planned; a reviewed instrumentation change and a natural run under L0 observation are the minimal route |
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

**The ceiling per invocation.** The ceiling in units is `sliceSize x maxSlicesPerRun`, per invocation. With one invocation per generation (scenario A) a ceiling below the plan (about 397 for Film-facts alone) leaves each daily pass partial, `passing`, and superseded by the next generation's pass, so the canonical store never catches up; any option below 400 is rejected for that wiring without further measurement. With repeated invocations of the same run (scenario B) a lower ceiling only adds invocations.

## Options

`maxSlicesPerRun` and the ceiling are in units per invocation of the pass. The deadline is the time, counted from the start of the producer step's invocation, after which the driver starts no further slice and ends the pass `passing`; it must sit inside the 5 minute lease with its 15 s margin, so it can never exceed 285 s. (This definition is the pack's reading of the ADR sentence "the slice deadline must sit inside the 5 minute step lease with its margin"; S4-4 fixes the exact semantics.)

| Option | `sliceSize` | `maxSlicesPerRun` | Per-invocation ceiling (units) | Slice deadline | Film-only: fits when | Unit-count upper bound 7,240 versus this ceiling | Main risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A, small slices** | 10 | 50 | 500 | 240 s | steady state yes (397 < 500); about 140 to 380 round trips per slice | Visits 500 units per invocation: scenario A completes 500 of 7,240; scenario B needs at least 15 invocations (7,240 / 500 = 14.5) | Many commits (50 per run) and many fence reads; slow first pass |
| **B, the existing default** | 25 | 40 | 1,000 | 240 s | steady state yes; 350 to 950 round trips per slice; 16 slices cover the Film-only run | Visits 1,000 units per invocation: scenario A completes 1,000 of 7,240; scenario B needs at least 8 invocations (7,240 / 1,000 = 7.24) | Middle of the road; a slice at 950 round trips and 50 ms is 47.5 s, inside the deadline |
| **C, the hard cap** | 50 | 20 | 1,000 | 240 s | steady state yes; 700 to 1,900 round trips per slice (95 s at 50 ms and `changedShare` 1) | Visits 1,000 units per invocation: scenario A completes 1,000 of 7,240; scenario B needs at least 8 invocations | Fewer commits, but a longer slice at risk of the lease and of a memory death mid-slice (M3), and a larger replay on a lost slice |
| **D, large ceiling** | 25 | 100 | 2,500 | 270 s | steady state yes | Visits 2,500 units per invocation: scenario A completes 2,500 of 7,240; scenario B needs at least 3 invocations (7,240 / 2,500 = 2.9) | The pass can use most of one lease; with the observed memory deaths and `seal_stage` of 122 to 146 s it competes with the commit's own step if not separated |

**Does the Film-only run fit the deadline?** The deadline bounds the whole pass of one invocation, so it must exceed the Film-only run's wall time (round trips x round-trip time, from the table above). A pass that hits the deadline ends `passing`. In scenario A the next generation's pass supersedes it (decision 10); in scenario B the next invocation of the same run continues from the cursor while the fingerprint is equal. Either way the deadline, not the unit ceiling, is what sets the work per invocation when the round trip is slow.

| Deadline | 5 ms (28 / 40 / 75 s) | 20 ms (111 / 159 / 302 s) | 50 ms (278 / 397 / 754 s) |
| --- | --- | --- | --- |
| 120 s (considered, not proposed) | fits at every `changedShare` shown | fits only at `changedShare` 0 | never |
| **240 s (Film-only illustration, not a full-plan proposal)** | fits at every share shown | fits up to `changedShare` 0.5 (206 s), not at 1 | never |
| 270 s (option D only) | fits at every share shown | fits up to `changedShare` 0.75 (254 s), not at 1 | never |

The three values in each header are `changedShare` 0, 0.25 and 1. At 50 ms no deadline below the 285 s ceiling holds a Film-only run in one invocation, so one invocation cannot finish that run: scenario A would be partial every day, and scenario B needs several invocations (or a cheaper unit, a different change than D-C). A measured round-trip time decides which table column is real.

Rejected for a one-invocation-per-generation wiring (scenario A): any option with a per-invocation ceiling under 397 (steady state never completes); a `sliceSize` above 50 (above `EPG_UNIT_HARD_CAP`); a slice deadline above 285 s (above the lease less its margin).

The 7,240 column assumes nothing about unit cost and is only a scale of the population. It is not a completion estimate.

## The per-generation cap and what it does not promise

### Scenarios A and B

`maxSlicesPerRun` and the deadline bound ONE INVOCATION of the pass. What happens between invocations depends on the wiring, which is the open S5-1 choice, not a D-C number. The store resumes a run whose recomputed fingerprint equals the stored one (ADR 0128 decision 3; the driver opens or resumes the run). A fingerprint that changes WITHIN the same run (source drift: a unit digest, a planner refusal or the plan version moved) resets the cursor and increments `pass_no`, and the replay costs reads, not writes (unmeasured). A new EPG run opens a new run row and supersedes an unfinished pass (decision 10).

| | **Scenario A: one invocation per EPG generation** | **Scenario B: repeated invocations of the same run** |
| --- | --- | --- |
| Progress between invocations | None: the unfinished pass is superseded by the next generation's pass | Resumes from the cursor while the recomputed fingerprint stays equal; a fingerprint change replays from the start |
| 7,240 units at a ceiling of 1,000 | Cannot complete in one invocation whatever the unit cost: the generation stays `passing` and `lagging`, and stays so run after run while the plan exceeds one invocation | At least 8 invocations (7,240 / 1,000, rounded up), subject to the deadline per invocation, the platform budgets (below), the time before the next EPG generation arrives and fingerprint stability |
| Readers | Labelled non-current or refused (decision 11) with no end date | Labelled non-current until the pass completes, then `current` |
| What it needs | Nothing beyond S4-4; completion only if one invocation covers the plan | A repeated caller: which caller, how it is scheduled, how it is isolated and what it costs are open for the Controller and the owner ([the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md)) |

**What the platform budget does and does not determine.** The subrequest budget is per Workflow instance (10,000 by default, not raised in `wrangler.jsonc`) and a D1 call is a subrequest ([M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md)). Whether the real count exceeds it is decided only by the actual D1, batch and R2 request counts of the pass plus the existing consumption of the instance that runs it, none of which is measured. The figures below are an unbatched stand-in scenario, not a bound in either direction: the planner statement counts of the [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md) would be one subrequest each only if nothing were batched, and they omit the per-pass and EPG-step requests of the instance.

| Scenario (stand-in, unbatched) | Units | Planner statements | Ratio to 10,000 |
| --- | --- | --- | --- |
| Full generation-shaped plan, every unit a no-op | 7,240 | 30,999 | about 3.1 |
| Heavier modelled cohort, every unit a no-op | 14,474 | 61,890 | about 6.2 |
| Film-facts-only plan, unchanged / applied (stand-in unit costs 14 and 38) | 397 | 5,558 / 15,086 | about 0.56 / 1.5 |

No first-pass figure is stated: the applied cost of a Person or credit unit is unmeasured, so no lower or upper bound for it exists in this pack. The one count that needs no assumption is the invocation count: at a ceiling of 1,000 units, 7,240 units need at least 8 invocations.

**Conditions under which `current` is reachable in scenario B:** (1) the run resumes on an equal fingerprint (true in the store), (2) every invocation is bounded by the deadline, the slice count and the budgets above, (3) a repeated caller continues the pass until it completes or the next EPG generation arrives, and (4) the summed invocation time fits the window before that generation, which needs a measured round-trip time. Whether the instance budget forces a raised `limits.subrequests` (a top-level change touching every Workflow) or a chain of instances is decided by measured request counts, and is open.

**If scenario A is the wiring**, the earlier reading holds:

- 7,240 / 1,000 = 7.2 is plain arithmetic about counts. It is not "seven or eight days to finish": a new generation may start its pass from the beginning of its own plan, and a deadline that cuts the same amount of work every day finishes the same prefix every day.
- The state that follows is a **perpetual `lagging` (or fail-closed) generation**, run after run, with no end date.
- Completing the full plan then needs one of: (a) repeated invocations of the same run (scenario B, a wiring choice, not implemented here); (b) a **separately designed pre-plan filter** that removes units before the ceiling counts them; or (c) a ceiling and deadline that cover the whole plan in one invocation. A no-op is still one visit; cheaper no-ops can change a time deadline, but they cannot make 7,240 units fit a cap of 1,000 unless a filter actually reduces the plan. Choosing among them is a separate architecture and owner decision. This pack does not make it.

No measured completion throughput exists for any option. None of the figures in this pack is one.

## Lag SLA options

"Canonical lag" is the time from the EPG commit until `canonicalFreshness` can report the generation complete (ADR 0128 decision 11: `applied_generation` is set only by the pass-complete commit). Readers fail closed or label the state non-current until then; the SLA is the number the owner accepts for "labelled non-current".

| Option | Promise | What it requires | What it cannot promise |
| --- | --- | --- | --- |
| **L1** | Complete within 1 hour of the commit, in the same Workflow run | The pass runs right after the commit (the wiring choices in [the S5-1 gate](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md)), and either one invocation covers the whole plan (scenario A) or the summed invocations of the same run finish inside the hour (scenario B, needs measured costs) | Scenario A: a plan larger than one invocation (that generation stays `lagging`). Scenario B: a plan whose summed invocation time exceeds the hour. Either: a pass interrupted by a memory death (the instance retries after the lease wait of about 5 minutes, so that case adds minutes, not hours, but only if the step is retried at all) |
| **L2** | Complete within 6 hours | The same, plus a retry of an interrupted step inside the window | Scenario A: a plan larger than one invocation. Scenario B: a plan whose summed invocation time exceeds the window |
| **L3** | No completion time promised; completion is reported per generation as `current`, `lagging` or `partial` | Nothing beyond the bounded pass of decision 10 (and, for scenario B, a repeated caller) | Any completion time. It does NOT mean "by the next daily run": in scenario A a pass cut by the ceiling or deadline is superseded by the next generation, so a generation can stay `lagging` indefinitely; in scenario B completion is bounded by the number of invocations, the platform budgets and the arrival of the next generation, none of which is measured |

In all three, no new alert is added (ADR 0128 decision 10: the state surfaces through the read model and derived readiness blockers). A numeric SLA is therefore a reporting threshold for the `producer` object, not a pager.

## Recommendation

**This section is a recommendation of the pack's author, not a decision and not an owner approval.**

- **No option below is recommended for the full plan.** The modelled generation is 7,240 units before `person_state`. Option B allows 25 × 40 = 1,000 visits per invocation. A unit that is a no-op is still one of those visits, so faster processing cannot put 7,240 units inside one 1,000-unit invocation; completing them takes at least 8 invocations of the same run (scenario B). B is a **Film-only illustration** of the existing `EPG_UNIT_LIMIT_DEFAULT`, not a recommended full-plan option.
- The Film-only illustration, for that narrower plan only: `sliceSize` 25, `maxSlicesPerRun` 40, ceiling 1,000 units, slice deadline 240 s (inside the 285 s limit of the 5 minute lease less its 15 s margin). 25 equals `EPG_UNIT_LIMIT_DEFAULT`. The ceiling is about 2.5 times the Film-facts plan of about 397, so the unit ceiling is not the limit while the plan is Film-facts alone. At an assumed 5 ms the Film-only run fits 240 s at every `changedShare` shown, and at 20 ms it fits up to 0.5. None of that prices the 7,240-unit plan, and none of it is an owner-approved parameter. L1 is not promised.
- What the synthetic run shows about that illustration: local plan and fingerprint time (under 40 ms at 14,474 units) is not what makes the deadline. A serial reading of the steady 30,999 statements at an assumed 20 ms is about 620 s, which is arithmetic, not a measurement. The credit-cap stress is one rest Film of 50 credits observed alone (52 units, 213 statements). It is not the E6 cohort, and it does not change the 7,240 count.
- A strategy that can finish the full plan is repeated invocations of the same run (scenario B), a pre-plan filter that actually removes units, or a ceiling that covers the plan in one invocation (see [scenarios A and B](#scenarios-a-and-b)). That choice, and who invokes repeatedly, is a separate architecture and owner decision. This pack does not choose the strategy and implements nothing.
- What survives any later measurement unchanged: the rejection of any ceiling below 397 for a one-invocation-per-generation wiring, the hard bounds (50, 285 s), the rule that a partial pass resumes only on an equal fingerprint within the same run and is superseded by a new run, and the fact that a no-op does not reduce the unit count.

## What stays NOT authorized by this page

- No production read: the synthetic path needs none. The blocked full-table copy, and any later small sample, need their own explicit, operation-specific owner GO (scope in [the M2b runbook](film-person-m2b-dry-run-copy.md)). Choosing a full-table delivery option is not a prerequisite for a provisional decision.
- No EPG run, no producer pass, no S4-4 or S5-1 code merge, no migration, no flag, no Scheduled Task, no marker switch, no H2 (`prepared` to `open`), and no change to `D1_ENRICHMENT_*`, `DISCOVERY_EXECUTOR` or `MONITOR`.
- No ADR edit: a decision here is recorded in ADR 0128 and the E6 record in a separate PR after the owner signs.

## Not verified here

- Any live value: the marker, flags, EPG mode, schema version and run state were not read (no production access in this change).
- Production `changedShare` (the synthetic harness share of 0 is the fixture matching itself), `person_state`, Person and credit applied cost per unit, the Worker to D1 round-trip time, D1 CPU per EPG step, the heap behaviour, the real enforcement and consumption against the documented Workflow platform limits (the limits themselves are recorded in the M1 evidence), and any completion throughput. The synthetic statement counts and local timings are recorded; they are not those quantities.
- Whether a repeated invocation of the same run resumes its cursor in production (read from ADR 0128 decision 3 and the S4-4 tests: an equal recomputed fingerprint resumes, a changed one replays from the start); no producer pass has run in production.
- That the slice deadline semantics above match what S4-4 implemented (the driver is delivered and dormant; its parameters are required and the deadline is at most the lease less its margin, but no pass has run in production).
- The statement-cap arithmetic ("three fixed statements"): derived from the store's description, to be confirmed against `commitSlice` in S4-4.
- Every scenario value in this page (round trips per run, wall time, slices) is arithmetic over the inputs listed, not an observation.

Related: [holdpoint decision pack](film-person-holdpoint-decision-pack.md), [S5-1 `nextAction` gate evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md), [M3 evidence](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md), [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md), [runbook index](README.md).
