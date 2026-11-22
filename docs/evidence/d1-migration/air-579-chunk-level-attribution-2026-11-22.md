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

So the window holds **13 chunks**, not the roughly 120 that the whole-catalog statement ran. The denominator is now measured, not inferred. The `owner`, `plan` and `progress` steps read the continuation, lease, status and generation documents and write the workflow state; by code none of them reads the catalog (`workflowPlanInput`, `settleWorkflowIfOwner`, `src/discovery-workflow.js`).

**Offline census (`tests/discovery-chunk-catalog-read-census.mjs`).** The real chunk code over a D1 stand-in at the real schema, three consecutive chunks each, a non-paged and a paged ledger (above the read cap): **exactly one whole-catalog statement per chunk, on both paths** (the queue refresh that a chunk may trigger is stubbed in this fixture; a reconcile reads the catalog once, see the first page). A chunk therefore explains at most 13 reads, or 26 with a refresh each, of the 120 in the window: **at most 11 % to 22 %**.

**Consequence.** The hypothesis that the per-chunk alias-index load is the dominant caller is **not supported**: it is a minor share. A change to the chunk reader (the cache, the catalog revision, the title column and the cadence options of the first page) would not remove most of the burst's catalog reads, and its measured expected gain is at most about a fifth of them. It is **not recommended as the next step**, and none of those options needs the owner's decision now.

## What the analytics show about the rest (observed)

In the 18:00-18:15 UTC bucket the statements by count are dominated by the authority gate and the decision write fences, not by the catalog: `SELECT version FROM schema_contract` 2,963; `discovery_transfer` 1,841; the `sqlite_master` inventory 1,671 (plus 630, 244 and 240 for other domains); `UPDATE discovery_cas` 1,650; the authority row 1,579 and 516; `discovery_decision_history` inserts 573, `discovery_decision` inserts 458, `discovery_score` inserts 213. Together the gate reads (`schema_contract`, `discovery_transfer`, the three `sqlite_master` inventories, the authority rows) and the fence updates add up to about 12,000 of the bucket's 21,067 statements. They are the per-write overhead of Discovery decision writes (each writer re-reads the gate and moves the fence). For scale, the roughly 28 chunks a 15-minute bucket holds at the observed cadence (13 in 7 minutes) account for about 2,300 statements by the offline census (about 84 per chunk), so most of the statement count is not the chunk's own reads. This is an observation of volume, not a proof of which writer issues each statement.

## Still unattributed

The remaining reads of the window, about 94 to 107 of the 120. Named classes can contribute some: the Task starts (two in the window, a reconcile and a start each), `GET /api/catalog/available` and `GET /api/enrichment/view` (13 between them in the coordinator's aggregate), and MCP calls of the read-only diagnostics (`prediction_queue_overview` and `prediction_film_diagnostics`, one read each; `prediction_pending` no longer reads the catalog since [PR #920](https://github.com/vladimino/iptv-watchlist/pull/920)). The scheduled Task prompts in `docs/reference/scheduled-task-prompts/` do not call those three diagnostics, so any of their reads come from other MCP clients. Which client, and how many of the 52 `POST /mcp` calls were diagnostics, is not known: the Worker does not log the MCP tool name. A per-tool counter on the MCP route (a log line with the tool name and no payload) would settle it; that is a code change, proposed here, not made.

## Next steps (proposals, none taken)

1. **Count the MCP tools.** A one-line structured log per `tools/call` (tool name, status, no arguments) would attribute the MCP share on the next natural run, read-only, with no behaviour change.
2. **Bound `prediction_film_diagnostics`** (code-only), unchanged from the first page.
3. **Gate overhead of the Discovery writers** (the `schema_contract`, `discovery_transfer`, `sqlite_master` and authority reads that every decision write repeats): the largest source of statement *count*, cheap per statement and so a possible target for batching one gate read across a chunk's writes. It needs its own proof that the fence semantics are unchanged; the first page's caution against caching the marker or the fence stands.
4. Re-run the analytics after the next natural EPG/Discovery catch-up to compare, as the card requires.
