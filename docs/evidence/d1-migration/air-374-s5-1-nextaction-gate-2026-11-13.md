# AIR-374 S5-1 pre-wiring gate: the `nextAction` semantics of the continuation branch (13 Nov 2026)

**Captured:** 2026-11-13 (UTC), against `origin/main` at `846c2bc`. **Method:** code reading and the test inventory only. No production read, no D1, R2 or connector access, no code change, no test run beyond the documentation checks of this PR. Every statement below is about the repository at that commit; none of it was observed in production.

**Why this page exists.** [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md) guardrail G6 says the producer phase is post-commit, isolated, and that a producer error never changes the published EPG result or the executor's failure budget; it adds "Before wiring, the existing `nextAction` semantics of the continuation branch are verified (not verified here; pre-wiring gate S5-1)". The S5-1 row of the staged plan says the producer pass is wired "in the continuation branch of `epgSync`". This page records what the code says about that gate and where the S5-1 row's assumption does not hold. It decides nothing and changes no ADR text; the ADR and the S5-1 scope are for the Controller and the owner to amend.

## Verdict in four lines

1. **`nextAction` is a client contract, not an executor input.** It is built by `discoveryContract` (`src/discovery.js`, values `continue`, `wait`, `stop`) and read by external clients (the MCP tools `epg_sync_step` and `epg_sync_start`, [MCP reference](../../reference/api/mcp.md)). The Cloudflare EPG executor never reads it.
2. **The "continuation branch" (`run.stage==='complete'` in `syncStep`) is not on the Cloudflare executor's path.** The executor stops at the reply that completes the run, and a completed run of the same Madrid date makes `drive` return `finished` before it posts anything. In the current production mode it is also fenced for external callers. So a producer pass placed inside that branch would not run in the mode production is in.
3. **The isolation half of G6 is satisfiable**, but only if the producer pass never touches the four fields the executor does read (HTTP status, `discovery.state` or `state` equal to `busy` with `nextCatchUpAt`, `reason` equal to `programme_changed`, `state` equal to `error`, `stage`), and never writes `sync.json` fields the executor reads.
4. **S5-1 needs an amended wiring point before it can start.** Options are in [the last section](#where-a-post-commit-producer-pass-could-be-called); choosing one is a design decision for the Controller and owner, not made here.

## What `nextAction` is and who reads it

| Fact | Evidence in the repository |
| --- | --- |
| Produced by `discoveryContract(record, override)`; the values are `continue`, `wait`, `stop` | `src/discovery.js`, function `discoveryContract` |
| Attached to Discovery replies through `presentQueuedDiscovery` and `presentContinuationDiscovery` | `src/discovery.js` |
| Documented as the client instruction after `stage` is `complete` (continue means call the step tool again with the same `runId`; wait means not before `nextCatchUpAt`; stop means Discovery is finished until the next EPG commit) | [MCP reference](../../reference/api/mcp.md), tool text of `epg_sync_start` and `epg_sync_step` |
| Referenced by 45 test files under `tests/` (counted with `grep -l nextAction tests/*.mjs`) | The tests that exercise the continuation branch itself include `continuation-diagnostics.mjs`, `epg-commit-interrupted-handoff.mjs`, `discovery-workflow.mjs` (asserts the delegated contract), `mcp-tools.mjs` and `epg-orchestration.mjs` |
| Read by the Cloudflare EPG executor | **No.** `drive` in `src/epg-orchestration.js` contains no reference to `nextAction` |

Consequence for any change: `nextAction` and the shape of the Discovery reply are a **public, tested contract** shared with external callers. A producer pass must not add to, remove from or alter these fields in a reply that clients read.

## What the Cloudflare executor actually reads

`drive` (`src/epg-orchestration.js`) posts one step to the internal `/api/sync/epg` (or `/api/sync/metadata`) route and decides from the reply and from the durable `sync.json`:

| Signal | Source | Executor outcome |
| --- | --- | --- |
| HTTP 409 | status | failure `owner_conflict` |
| HTTP 429, 5xx, other 4xx | status | failure `rate_limited`, `upstream_5xx`, `step_failed` |
| `reply.discovery.state==='busy'` or `reply.state==='busy'`, with `nextCatchUpAt` | body | sleep until `nextCatchUpAt` (or five times the sleep floor when absent) |
| `reply.reason==='programme_changed'` or `reply.discovery.reason==='programme_changed'` | body | failure `stale_generation_write` |
| `reply.state==='error'` or `reply.discovery.state==='error'` | body | failure `step_failed` |
| `reply.stage==='complete'` or `sync.json` stage `complete` after the step | body and `sync.json` | **finished**, the daily run is published |
| everything else | `sync.json` (`stage`, cursor, `remaining`, `seal.phase`) | progress, next step |

Bounds that belong to the same loop: `STEP_CAP=400`, `SLEEP_FLOOR_MS=1000`, `EXTERNAL_FRESH_MS=15 min`, `LEASE_MS=5 min`, `BOUNDARY_MARGIN_MS=15 s`.

**An executor-visible hazard for a producer pass.** Any producer outcome that surfaces as `state: 'error'`, a status of 400 or more, or `state`/`discovery.state` equal to `busy` in a reply the executor reads changes the executor's behaviour (failure budget, sleep). G6's "a producer error never reaches the executor" is therefore a property of where the pass is called and how its result is reported, not something the existing reply shape provides for free.

## The continuation branch, step by step

`syncStep` (`src/worker.js`) routes by `run.stage`:

| `run.stage` | Branch (`step.branch`) | What it does |
| --- | --- | --- |
| `complete` | `continuation` | `flushEpgEvent`, flushes the removal handover when the ratings gate is active, `closeInterruptedRatings`, then reads `discoveryExecutorMode`. `invalid`: 503 `discovery_executor_invalid`, branch `executor_invalid`. `workflow`: branch `delegated`, returns `presentContinuationDiscovery`. Otherwise `advanceDiscovery` runs one Discovery chunk and returns its `discovery` object (which carries `nextAction`) |
| `seal` | `sealStep` | When the stage is still not `complete` it returns the seal result; otherwise it calls `queueDiscovery(env,'epg_committed',run.runId)` and returns `presentQueuedDiscovery` |
| `epg` | `epg_commit` (`epgSync`) | A busy projector window returns `windowBusyResponse`; other errors set `run.error` and rethrow. Success returns `stageSealedGeneration` (a `sealResponse` with `discovery: {state: 'paused', nextAction: 'continue', reason: 'ledger_seal'}`) or `completeWithRatings`, which ends in `finishSync` (stage `complete`) |

So the **only** places where the commit of a daily EPG run finishes are the `seal` branch (the last seal step publishes and sets `complete`) and `finishSync` through `completeWithRatings`. After either, `sync.json` is `complete`.

## Why the continuation branch is not reached in production's current mode

Two independent reasons, both from the code:

1. **The executor never calls it.** `drive` returns `finished` as soon as a reply or `sync.json` says `complete`. Its first line after loading `sync.json` returns `finished` when the stored run is `complete`, started on the run key's date and has no error. A `complete` run of another date is "not usable" (`usable` is true only for `seal`, or a fresh `metadata` or `epg`), so the next daily run starts a new run instead of posting to the completed one. The executor therefore never posts a step to a run whose stage is `complete`.
2. **External callers are fenced.** The external routes (`/api/sync/start|metadata|epg`) and the MCP tools `epg_sync_start` and `epg_sync_step` pass `beginExternalStep`, which calls `externalGate`: `switch_in_progress` while the mode is `switching` and `external_writer_fenced` once the mode is `cloudflare` (the production mode, per [AGENTS.md](../../../AGENTS.md) and [ADR 0100](../../adr/0100-epg-cloudflare-workflow-executor.md)). In mode `external` the continuation branch is reachable, and it is the only mode in which `nextAction` drives a client loop.

Both facts were read from code on `origin/main`; the live mode document was **not** read for this page (no production read in scope). Nothing here proves the continuation branch has never run in production under the Cloudflare mode; it shows the code gives it no caller in that mode.

## Which G6 and S5-1 assumptions this confirms and contradicts

| Assumption | Verdict from the code | Note |
| --- | --- | --- |
| G6: a producer error must not change the published EPG result | **Satisfiable.** Publication is complete (`finishSync`, `stage` complete) before any post-commit work can run | A pass after the commit cannot affect what was published |
| G6: a producer error must not reach the executor's failure budget | **Satisfiable only outside the reply the executor reads.** The failure budget is fed by status 400 or more, `state: 'error'`, `reason: 'programme_changed'` and `busy` | The pass must catch everything and report through its own store results, not through those fields |
| S5-1: the producer pass lives in the continuation branch of `epgSync` | **Contradicted for production's mode.** The branch is in `syncStep` (not `epgSync`), is never posted to by the executor and is fenced externally under `cloudflare` | A pass there would be dormant exactly where it must run |
| S5-1: `nextAction` of the continuation branch is the contract to keep | **Confirmed as a public contract** (45 test files, MCP reference), irrelevant to the executor | Keep it byte-identical in `external` mode |
| S5-1: byte-identical publication behaviour with the producer disabled | Not verified here (no S5-1 code exists) | Stays an S5-1 acceptance criterion |

## Where a post-commit producer pass could be called

Candidate wiring points, from the code. None is chosen here; each has a cost the Controller and owner should weigh. All assume the pass is skipped, with one marker read and nothing written, below the marker `open` (ADR 0128 dormancy rule).

| Option | Where | What the code says | Risks to check before choosing |
| --- | --- | --- | --- |
| **W1** | Inside the EPG Workflow instance, as its own step after the loop returns `finished` | The executor's loop ends at `finished`; a further Workflow step runs in the Workflow's own retry and wait semantics. This is the option closest to the text of ADR 0128 decisions 1 and 10 ("a bounded continuation phase of the EPG run", "the producer step ends the Workflow loop at (2)"), which already speak of a producer step in the Workflow and not of the `syncStep` branch | Workflow memory: M3 recorded two `Worker exceeded memory limit` deaths inside the EPG Workflow ([M3 evidence](air-374-m3-epg-step-metrics-2026-11-13.md)); a new step adds a failure surface and a place to lose memory. Workflow step limits (M1) were never recorded. Adds an executor change, so its effect on the daily run's wall time and on the 6-hour pause must be reasoned about |
| **W2** | At the end of the commit path itself, after `finishSync`/the last `sealStep`, in a `try/catch` that swallows everything and reports nothing in the reply | Both finishing paths already persist watchlist, scan and events (`finishSyncPersist`) before `stage` becomes `complete` | It runs inside the same request as the daily commit: its CPU and wall time add to a step that already reaches 146 s ([M3](air-374-m3-epg-step-metrics-2026-11-13.md)); a throw that escapes would change the reply and the failure budget; the slice deadline would have to fit the remaining lease, not a fresh one |
| **W3** | A separate, independently scheduled pass over the producer store (a new Workflow instance or the hourly tick) that reads the committed run and works through due units | The hourly tick (`0 * * * *`) already calls several named, independent writers; ADR 0128 designed the run store so a pass can resume across invocations | A new writer: needs its own contract, authorization and ADR amendment; the cron and Workflow creation rules in [AGENTS.md](../../../AGENTS.md) forbid adding one silently |
| **W4** | The continuation branch as written in the S5-1 row | Reachable only in mode `external` | Dormant in production's mode; would need the executor to post to a completed run, which it deliberately does not do |

What is the same under every option: the pass must (a) read canonical membership only through `canonicalFreshness`, (b) leave the reply shape, `nextAction` and the four executor-read fields untouched, and (c) keep its D1 round trips inside the slice budget chosen under D-C (see [the D-C decision pack](../../runbooks/film-person-d-c-decision-pack.md)).

## Not verified here

- The live EPG mode document, the live `DISCOVERY_EXECUTOR` flag and the live marker (no production read in scope).
- That the continuation branch has never been reached in production under the Cloudflare mode (the code gives it no caller; absence of runtime evidence is not claimed).
- Whether a Workflow step after `finished` (W1) is possible without changing the Workflow's existing replay and retry guarantees; M1 (Workflow platform limits) was never recorded.
- The cost of any option in CPU, wall time or memory; no producer code exists beyond the dormant S4-1 and S4-3 modules.
- Whether the tests that mention `nextAction` pin the exact reply shape; only the count and the five files named above were read for relevance.

[Back to the D1 migration evidence index](README.md).
