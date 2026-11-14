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

## What the limits imply for the producer pass (arithmetic, not measurement)

A pass spends D1 calls, and D1 calls are subrequests. The documented budget is 10,000 per Workflow instance by default. The statement counts below are the local counts of the [AIR-465 synthetic-at-scale measurement](air-465-m2b-synthetic-scale-2026-11-14.md) (a model at the E6 aggregate scale on a local stand-in, not a production figure). A statement count is an UPPER bound on subrequests: statements issued in one `batch` are one query against the D1 limit, and the harness does not say how many of the planner's reads the Worker would batch.

| Quantity | Value | Basis |
| --- | --- | --- |
| Full generation-shaped plan, every unit a no-op | 30,999 statements for 7,240 units (397 `film_facts`, 6,452 `person_mutation`, 391 `film_credits`); at least 4 instance budgets | AIR-465: 391 x 9 + 6 x 18 + 6,452 x 4 + 391 x 4; 30,999 / 10,000 rounded up |
| Heavier modelled cohort, every unit a no-op | 61,890 statements for 14,474 units; at least 7 instance budgets | AIR-465 elevated run |
| First pass, lower bound | 397 Film-facts units applied at 38 round trips each (15,086), 391 credit units and 6,452 Person units at the no-op price of 4 (27,372): 42,458, at least 5 instance budgets. The applied cost of a Person or credit unit is **not measured** and can be far above 4 | stand-in unit costs plus AIR-465 |
| Film-facts-only plan of about 397 units | 5,558 unchanged (fits one budget); 15,086 applied (does not) | 397 x 14 and 397 x 38 |
| Units per invocation, whatever the unit cost | 7,240 units need at least 8 invocations at a ceiling of 1,000 | 7,240 / 1,000 rounded up |

Two consequences, both conditional on the assumptions named here:

1. The subrequest budget is per **instance**, so one instance that loops over many steps still spends one budget. A producer pass that must walk the full plan needs either a raised `limits.subrequests` (a top-level change touching every Workflow) or a chain of instances. Which of the two is a design decision, not made here.
2. A producer step placed inside the existing EPG instance shares the EPG instance's budget. How much of the 10,000 the EPG commit itself spends is not established (D1 calls per step are not measured).

## Not verified here

- The primary pages themselves (see the reviewer note); the D1 queries-per-invocation inconsistency above.
- Whether a Workflow instance can create another instance from a step, whether creating an instance with an existing id is idempotent, and whether a successor chain behaves as the Discovery successor of [ADR 0098](../../adr/0098-discovery-workflow-step-failure-recovery.md) does: not read for this page.
- Whether the isolate of a separate Workflow instance is a fresh isolate (the memory hypothesis cannot be settled from the documentation).
- Any production value: the live mode, flags, marker and run state were not read.

## What this page does not do

No ADR is edited, no D-C value is chosen, no wiring point is chosen, no `wrangler.jsonc` change is made or proposed as approved, and no production system is touched. Raising `limits.subrequests` or changing the Workflow set is a design decision for the Controller and the owner.

[Back to the D1 migration evidence index](README.md).
