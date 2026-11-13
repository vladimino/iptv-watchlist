# EPG OOM phase tracing: instrumentation and offline checks, AIR-462 (13 Nov 2026)

[AIR-462](https://trello.com/c/w73gROBl). Follow-up of [AIR-460](https://trello.com/c/ZXySuCJk) ([PR #595](https://github.com/vladimino/iptv-watchlist/pull/595), still open at this date, not merged here). Code only: no production read or write, no EPG, Discovery, Workflow, flag, lease or Task action.

**Captured:** 2026-11-13 (UTC). **Base:** `origin/main` at `2582b924`; this PR is built on `main`, not on #595, and the two touch `sealPayload` in `src/worker.js` (a mechanical rebase for whichever merges second). **Evidence lifecycle:** dated design and offline test record. **Operational authority:** none.

## What was added

Passive, bounded log lines described in [orchestration reliability](../../reference/orchestration-reliability.md#epg-correlation-and-memory-boundary-markers-air-462): `epg_act` enter, exit and error per `act-N` callback with a local `attemptTraceId`; the same trace on the `epg_phase` lines of the step the action drives; and `epg_memory_boundary` lines around the payload get, decode and parse of the publish, finalize and queue steps, the payload put of `seal_stage`, the archive and emit starts of `seal_stage`, the begin, read, every 25th batch and archive of `seal_ledger`, and the payload and merge of `seal_catalog`. How to stitch them with the Workflow history: [monitoring runbook](../../runbooks/monitoring.md#epg-workflow-attempt-correlation-air-462).

Inventory before the change: `epg_phase` already had enter, exit and error for `seal_stage`, `seal_ledger`, `seal_catalog`, `seal_publish` (and its four units), `seal_finalize`, `seal_queue`, with `seal_stage_plan`, `archive` and `emit` exits, but no link to the `act-N` step or attempt and nothing inside the payload read of publish, which is where the 13 Nov run died four seconds in.

No `JSON.stringify`, buffer copy or traversal was added for sizing: the sizes are `object.size`, the length of a string that already exists, item and cursor counters that already exist. `seal_stage` now keeps the payload JSON in a local string before the put (the same single stringify as before) to read its length.

## Offline checks

`tests/epg-orchestration.mjs` (a whole run: one `epg_act` enter and exit per callback, a retried `act-0` gets a second `attemptTraceId`, the driven step receives the trace through its per-action env, closed field set) and `tests/epg-trace-boundaries.mjs` (closed names and integer-only fields; two runs never see each other's trace and the trace is gone after the step, also on a throw; a throwing console changes no result or error; the payload read logs its boundaries in order and a kill inside the decode leaves the enter without an exit; no storage, network or memory-API use in the helpers; bounded line count). Review follow-up: paired `seal_ledger_read` and `seal_catalog_merge` boundaries, no catalog key enumeration for a count (a test rejects any marker that enumerates an object), a rejected action logs `error` without `exit`, and injected failures at a `JSON.parse` of the payload, the ledger stream, a ledger D1 write and the publish pointer commit each leave the last confirmed marker with no fabricated exit and the original error (the pointer test also shows no later unit ran); the milestone volume is asserted at runtime (60 batches log under 20 lines). Existing lease, CAS, pointer and recovery tests are unchanged and pass.

## Observed, inferred, unknown

- **Observed (offline):** the shapes and the behaviour above.
- **Inferred:** with these lines a future `exceededMemory` in an EPG step can be placed between two confirmed lines of one attempt.
- **Unknown, to be filled by the natural-run observation after deploy:** whether Workers Logs keep the last line of an attempt killed on memory; how a synchronous parse looks in the gaps; the real sizes of payload and catalog on a daily run. This file records no production observation yet. Until one exists, nothing here says where or why the production runs died, and no memory mechanism is proven.

Documentation impact: this file and its index entry, `docs/reference/orchestration-reliability.md`, `docs/runbooks/monitoring.md`. No architecture diagram changes: the flow of data is unchanged.
