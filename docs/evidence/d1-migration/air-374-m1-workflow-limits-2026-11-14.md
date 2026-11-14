# AIR-374 M1: Cloudflare Workflow platform limits and the limits configured in this repository (14 Nov 2026)

**Captured:** 2026-11-14 (UTC), repository at `origin/main` `d57bba6`. **Method:** documentation only. The platform values come from the Cloudflare documentation search connector (the documentation host itself was not reachable from the capturing session), so each value is a chunk of a primary page, not the whole page. The repository values were read from `wrangler.jsonc` and `src/epg-orchestration.js`. No production read, no D1, R2 or Cloudflare API call against the account, no code change. **Scope of this page:** the M1 row of [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md) (limits "documented" or "not documented", none inferred). It chooses no D-C number and no wiring point.

**Reviewer note.** M1 asks the Controller to re-read the primary pages. The page dates visible in the retrieved chunks are: Workers limits `dateModified` 2026-11-13, Workflows "Sleeping and retrying" last updated 24 Sep 2026, Workflows pricing last updated 4 Nov 2026. The dates of the Workflows limits page and the D1 limits page were not visible. Re-reading them is the acceptance step of this page.

## Platform limits (Workers Paid), marked documented or not documented

| Limit | Value | Status | Primary page |
| --- | --- | --- | --- |
| Steps per Workflow instance | 10,000 by default, configurable up to 25,000 through `workflows[].limits.steps`; `step.sleep` does not count | Documented | Workflows limits; Workers API |
| Wall time per step | Unlimited (the step is bound by the CPU limit) | Documented | Workflows limits |
| CPU time per Workflow invocation | 30 s by default, raised for every invocation of a Workflow definition by `limits.cpu_ms`, at most 300,000 ms (5 min). CPU time is active processing, not I/O wait | Documented | Workflows limits ("Increasing Workflow CPU limits"); Workers wrangler configuration |
| **Subrequests per Workflow INSTANCE** | **10,000 by default, configurable up to 10 million through `limits.subrequests`.** A subrequest is any `fetch` or request to R2, KV or D1 | Documented | Workflows limits ("Increasing Workflow subrequest limits"); Workers 11 Feb 2026 changelog |
| D1 queries per Worker invocation | The D1 limits page lists 1,000 (Workers Paid) and points to the subrequest limits; a `db.batch()` counts as one query. The Workers and Workflows pages give 10,000 per invocation or instance. The pages disagree | Documented, **inconsistent**: treat the lower value as unverified until the Controller re-reads both pages | D1 limits; Workers limits |
| Memory | 128 MB per isolate, shared by the requests the isolate handles. When it is exceeded the runtime lets in-flight requests finish and starts a new isolate | Documented | Workers limits |
| Memory released between Workflow steps | The documentation says a Workflow engine may hibernate and lose all in-memory state when it has no pending work, and that state outside a step must not be relied on. It does **not** say whether memory is released between two steps of one running instance | **Not documented** | Workflows "Rules of Workflows" |
| Non-stream step result | 1 MiB | Documented | Workflows limits |
| Persisted state per instance | 1 GB | Documented | Workflows limits |
| `step.sleep` maximum | 365 days | Documented | Workflows limits |
| Concurrent instances | 50,000 per account; instances in `waiting` do not count. Creation rate 300/s per account, 100/s per Workflow | Documented | Workflows limits; 15 Apr 2026 changelog |
| Default step retry | 5 retries, 10 s delay, exponential backoff, 10 minutes timeout per attempt | Documented | Workflows "Sleeping and retrying" |
| Cron Trigger CPU | 15 minutes for an interval of one hour or more (30 s below one hour) | Documented | Workers limits |
| Instance state and log retention | 7 days by default on Workers Paid, configurable to 30 days | Documented | Workflows limits |
| D1 result, statement and parameters | Query result at most 50 MB (enforced from 4 Nov 2026); statement at most 100,000 bytes; at most 100 bound parameters; at most six simultaneous connections per invocation | Documented | D1 limits |
| D1 throughput | Each database processes queries one at a time; throughput follows query duration; a query runs at most 30 s | Documented | D1 limits and FAQ |
| Whether limits are enforced in local development | They are enforced only on the deployed Worker | Documented | Wrangler configuration |
| Subrequest cost of a D1 call inside a Workflow step, per step or per instance | The Workflows page counts D1 requests as subrequests and states the budget per **instance**. Whether a long instance shares one budget across all its steps is read from that sentence, not from a measurement | Documented (wording), **not measured** | Workflows limits |

## Limits configured in this repository

| Setting | Value | Where | Effect |
| --- | --- | --- | --- |
| `limits.cpu_ms` | 120,000 (2 minutes) | `wrangler.jsonc`, top level | Applies to the Worker and, per the Workflows page, to every invocation of the Workflow definitions in it (`iptv-discovery`, `iptv-ratings`, `iptv-epg`, `iptv-epg-diagnostic`) |
| `limits.subrequests` | **Not set**, so the default of 10,000 per Workflow instance applies | `wrangler.jsonc` | Every D1 or R2 call of an instance spends this one budget. Raising it is a top-level change that applies to all four Workflows and the Worker |
| `workflows[].limits.steps` | Not set, so 10,000 | `wrangler.jsonc` | The EPG loop is bounded by its own `STEP_CAP` of 400 |
| `workflows[].limits.concurrency` | Not set | `wrangler.jsonc` | Each Workflow may use the account concurrency |
| `compatibility_date` | 2026-10-18 | `wrangler.jsonc` | |
| Cron | `0 * * * *` (one hourly trigger) | `wrangler.jsonc` | |
| EPG step retry configuration | None: `step.do(actStep, ...)` passes no configuration, so the platform defaults above apply (5 retries, 10 minutes per attempt) | `src/epg-orchestration.js`, `run` | A platform failure of an `act-N` step is retried by the platform; the application-level lease is separate |
| EPG loop constants | `STEP_CAP` 400, `SLEEP_FLOOR_MS` 1,000, `LEASE_MS` 5 min, `BOUNDARY_MARGIN_MS` 15 s | `src/epg-orchestration.js` | An `act-N` plus `sleep-N` pair is one executed step plus one sleep; the sleeps do not count towards the 10,000 steps |

## Documented limits, not measured costs

The values above are **platform limits**. The measured runtime costs live elsewhere and are separate facts:

| Fact | Source | Status |
| --- | --- | --- |
| EPG step wall time 4 to 36 s, `seal_stage` 122.6 s (13 Nov) and 146 s (baseline) | [M3 evidence](air-374-m3-epg-step-metrics-2026-11-13.md) | Measured, Worker logs |
| Two `Worker exceeded memory limit` deaths inside the EPG Workflow, each followed by about 300 s of step-lease wait | M3 evidence | Measured; the cause (memory accumulating across steps in one isolate) is a hypothesis and the platform documentation neither confirms nor refutes it |
| D1 calls per EPG step, CPU per handler, heap profile | M3 evidence | **Not established** |
| Unit cost on the offline stand-in: 14 round trips unchanged, 38 applied (Film-facts only) | `UNIT_COST` in `scripts/film-person-e6-measure.mjs` | Offline stand-in, not a production figure |
| Worker to D1 round-trip time, `changedShare`, Person and credit applied cost | [D-C decision pack](../../runbooks/film-person-d-c-decision-pack.md), gap table | **Not measured** |

## What the limits imply for the producer pass (conditional scenarios, not measurements)

A pass spends D1 calls, and D1 calls are subrequests. The documented budget is 10,000 per Workflow instance by default. Whether a producer pass exceeds it is decided only by the **actual** D1, batch and R2 request counts of the pass plus the existing consumption of the instance that runs it. None of those is measured: statements issued in one `batch()` are one query against the D1 limit, the planner statement counts below say nothing about batching, and they omit the requests of the EPG step and of the pass itself, so they are neither a lower nor a complete upper bound. The figures are an **unbatched, stand-in scenario** only (every planner statement counted as one subrequest), from the local [AIR-465 synthetic-at-scale measurement](air-465-m2b-synthetic-scale-2026-11-14.md), which is a model at the E6 aggregate scale and not a production figure.

| Scenario (stand-in, unbatched) | Units | Planner statements | Ratio to a budget of 10,000 |
| --- | --- | --- | --- |
| Full generation-shaped plan, every unit a no-op | 7,240 (397 `film_facts`, 6,452 `person_mutation`, 391 `film_credits`) | 30,999 | about 3.1 |
| Heavier modelled cohort, every unit a no-op | 14,474 | 61,890 | about 6.2 |
| Film-facts-only plan, every unit unchanged / every unit applied (stand-in unit costs of 14 and 38 round trips) | about 397 | 5,558 / 15,086 | about 0.56 / 1.5 |

No first-pass figure is given: the applied cost of a Person or credit unit is not measured, so no bound for it exists on this page.

One count needs no assumption: at a ceiling of 1,000 units per invocation, 7,240 units need **at least 8 invocations** (7,240 / 1,000, rounded up), whatever the unit cost.

What the documented limits establish, and what they leave open:

1. The budget is per **instance**: one instance that loops over many steps spends one budget. Whether a pass fits one budget, needs a raised `limits.subrequests` (a top-level change touching every Workflow) or needs a chain of instances depends on the measured request counts and is not decided here.
2. A producer step placed inside the existing EPG instance shares the EPG instance's budget. How much of the 10,000 the EPG commit itself spends is not established (D1 calls per step are not measured).

## Not verified here

- The primary pages themselves (see the reviewer note); the D1 queries-per-invocation inconsistency above.
- Whether a Workflow instance can create another instance from a step, whether creating an instance with an existing id is idempotent, and whether a successor chain behaves as the Discovery successor of [ADR 0098](../../adr/0098-discovery-workflow-step-failure-recovery.md) does: not read for this page.
- Whether the isolate of a separate Workflow instance is a fresh isolate (the memory hypothesis cannot be settled from the documentation).
- Any production value: the live mode, flags, marker and run state were not read.

## What this page does not do

No ADR is edited, no D-C value is chosen, no wiring point is chosen, no `wrangler.jsonc` change is made or proposed as approved, and no production system is touched. Raising `limits.subrequests` or changing the Workflow set is a design decision for the Controller and the owner.

[Back to the D1 migration evidence index](README.md).
