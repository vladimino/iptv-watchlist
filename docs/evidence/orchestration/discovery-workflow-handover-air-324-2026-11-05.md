# AIR-324 Discovery Workflow handover — offline evidence

**Captured:** 2026-11-05, Europe/Madrid (code only)  
**Related work:** [AIR-324](https://trello.com/c/kNtaEbm8), [ADR 0091](../../adr/0091-discovery-workflow-cron-reconcile.md) (Proposed)  
**Scope:** local `npm test` / `npm run build` against the AIR-324 branch. No production Worker, Cloudflare setting, D1, R2, MCP writer, flag or Scheduled Task was read or changed.

## What was exercised

`tests/discovery-workflow.mjs` (existing AIR-323 cases plus AIR-324 additions):

- Absent `DISCOVERY_EXECUTOR` still runs one explicit chunk and never calls `create()`.
- `workflow` mode answers `delegated` on `epg_sync_step` / resolve and does not run the chunk in the request.
- Duplicate `ensure` attaches to the same instance id; an uncertain create keeps that id; reconcile waits out `dueAt` and then retries or opens a successor; quarantine creates nothing.
- Thirteen stubbed chunks renew a spent series without the hourly sleep; a 20-chunk product cap still rolls over.
- A stale generation and a superseded series write no Discovery decisions and make no TMDB call.
- Cron `scheduled` invokes `reconcileDiscoveryWorkflow` and not `advanceDiscovery`. With the flag absent the cron creates nothing. With `workflow` it creates at most one instance and writes no decisions.
- A missing continuation after a published generation is reconstructed by `queueDiscovery` compare-and-swap; the receipt names the published `programmeRunId`.
- A same-generation `programme_changed` artefact is replaced once; the next `ensure` attaches to the same instance and does not open a second series.
- A terminal `stop` (`complete`) is not re-queued.
- A held, `loading` or throwing D1 authority returns `authority_held` / `authority_loading` / `d1_unavailable` and does not call `create()`.
- `closed()` (absent DB), schema v10 and an explicit `r2/open` marker return `authority_not_ready` from both `ensure` and `reconcile`: no `create()`, no continuation/workflow/decision R2 write.
- Clearing the flag (`external` rollback) creates nothing.

The binding in `wrangler.jsonc` still has no `schedules`. `DISCOVERY_EXECUTOR` is still absent from `vars`.

## What this is not

Not a production activation. Not a live `DISCOVERY_EXECUTOR=workflow` readback. Not a ChatGPT Task prompt change. Not a Workflow instance, TMDB call, EPG run or D1/R2 write. Not evidence that the reconciler's CPU on the production isolate is acceptable under load.
