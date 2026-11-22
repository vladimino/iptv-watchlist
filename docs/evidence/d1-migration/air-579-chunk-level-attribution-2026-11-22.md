# AIR-579: chunk-level attribution of the whole-catalog reads (22 Nov 2026)

Follows [the first attribution page](air-579-catalog-read-attribution-2026-11-22.md), which left the Discovery chunk as an unproven hypothesis. Read-only observation at about 21:2x UTC, 22 Nov 2026 (the Cloudflare Workflows `GET` of the `iptv-discovery` instances and their step records, one D1 analytics read of statement counts) plus an offline census of one chunk. Step **names and timestamps only** were read; no payload, no key, no log text. No D1 write, schema, flag, Task, Workflow, cron or R2 operation and no manual run. The first attribution page and the [RCA](air-579-d1-overload-rca-2026-11-22.md) are history and are not rewritten.

## Result: the chunk is not the dominant caller

**Observed (Workflows step records).** In the window 18:05:00 to 18:12:00 UTC the two overlapping `iptv-discovery` instances (created 18:01:23 and 18:06:50; the next, 18:13:52, lies after the window) started these steps, counted by step name:

| Step | Started in the window | Total step time |
| --- | --- | --- |
| `chunk` (one bounded chunk) | **13** (median about 26 s each, about 312 s, 74 % of the window's wall time) | 312 s |
| `owner`, `plan` | 16 each | 3 s and 17 s |
| `progress` | 13 | 6 s |
| `version`, `renew`, `wait`, `sleep`, `stall-sleep`, `rollover` | 1 each | negligible |

There are **13 chunk step starts** inside the window and one more chunk started at 18:04:57 UTC and was still running at 18:05:00 (second independent read-only Cloudflare GET). All 13 in-window chunks have **one recorded attempt each**. This establishes the step-start count, not a strict upper bound for SQL in the window: steps can straddle the time boundary and their collaborators may perform additional reads. The `owner`, `plan` and `progress` steps read the continuation, lease, status and generation documents and write the workflow state; by code none of them reads the catalog (`workflowPlanInput`, `settleWorkflowIfOwner`, `src/discovery-workflow.js`).

**Offline census (`tests/discovery-chunk-catalog-read-census.mjs`).** The actual `resolveDiscoveryChunk` code ran for three successive chunks on both paged and non-paged paths against a synthetic D1 fixture migrated through `0011` (not the current production schema). It issued **one direct whole-catalog alias-index read per call** on each path. The test **stubs `refreshPredictionQueue` and does not install `CanonicalDiscoveryAdmission`**, so it cannot put a strict upper bound on all catalog reads made by fully wired production collaborators. The non-paged path may refresh the prediction queue with its own bounded retries; the production paged path intentionally does not refresh it on its checkpoint.

**Consequence.** The available evidence does **not** support the **direct per-chunk alias-index read** as the dominant source of the 120 catalog statements. For the production paged path, roughly 14 chunks intersected the window and the direct reader normally runs once per chunk, a small minority of 120. This is neither an exact production SQL attribution nor an upper bound on additional reads from other callbacks, retries or concurrent requests. The cache, catalog-revision, title-column and cadence options are therefore **not justified as the next step**; no owner decision on them is requested now.

## What the analytics show about the rest (observed)

In the 18:00-18:15 UTC bucket the statements by count are dominated by the authority gate and the decision write fences, not by the catalog: `SELECT version FROM schema_contract` 2,963; `discovery_transfer` 1,841; the `sqlite_master` inventory 1,671 (plus 630, 244 and 240 for other domains); `UPDATE discovery_cas` 1,650; the authority row 1,579 and 516; `discovery_decision_history` inserts 573, `discovery_decision` inserts 458, `discovery_score` inserts 213. Together the gate reads (`schema_contract`, `discovery_transfer`, the three `sqlite_master` inventories, the authority rows) and the fence updates add up to about 12,000 of the bucket's 21,067 statements. They are the per-write overhead of Discovery decision writes (each writer re-reads the gate and moves the fence). At the observed cadence a 15-minute bucket would contain roughly 28 chunk starts, but extrapolating the synthetic fixture's ~84 statements per chunk to live production is unsound: the fixture has few actionable observations, uses schema `0011`, and omits wired collaborators. The observed SQL signature totals still do **not** attribute those statements to a particular writer.

## Still unattributed

Most of the 120 full-catalog reads in the window remain unattributed even after accounting for the approximately 14 intersecting chunks. Named classes can contribute some: the Task starts (two in the window, a reconcile and a start each), `GET /api/catalog/available` and `GET /api/enrichment/view` (13 between them in the coordinator's aggregate), and MCP calls of the read-only diagnostics (`prediction_queue_overview` and `prediction_film_diagnostics`, one read each; `prediction_pending` no longer reads the catalog since [PR #920](https://github.com/vladimino/iptv-watchlist/pull/920)). The draft prompts in `docs/reference/scheduled-task-prompts/` do not call those three diagnostics, but drafts are not the live Scheduled Task registry. The callers of the 52 `POST /mcp` requests remain unknown. Which client, and how many of the 52 `POST /mcp` calls were diagnostics, is not known: the Worker does not log the MCP tool name. A per-tool counter on the MCP route (a log line with the tool name and no payload) would settle it; that is a code change, proposed here, not made.

## Next steps (proposals, none taken)

1. **Count the MCP tools.** A one-line structured log per `tools/call` (tool name, status, no arguments) would attribute the MCP share on the next natural run, read-only, with no behaviour change.
2. **Bound `prediction_film_diagnostics`** (code-only), unchanged from the first page.
3. **Gate overhead of the Discovery writers** (the `schema_contract`, `discovery_transfer`, `sqlite_master` and authority reads that every decision write repeats): the largest source of statement *count*, cheap per statement and so a possible target for batching one gate read across a chunk's writes. It needs its own proof that the fence semantics are unchanged; the first page's caution against caching the marker or the fence stands.
4. Re-run the analytics after the next natural EPG/Discovery catch-up to compare, as the card requires.
