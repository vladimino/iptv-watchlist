# Shared orchestration reliability contract: design inventory

**Captured:** 2026-11-04 (Europe/Madrid)  
**Source:** repository `main` at `8e66423` (`docs(process): require final Trello AIR number uniqueness readback`), accepted ADRs and the dated evidence linked below  
**Scope:** the inputs used to write [ADR 0089](../../adr/0089-shared-orchestration-reliability-contract.md) and the [orchestration reliability reference](../../reference/orchestration-reliability.md)  
**Related work:** [AIR-345](https://trello.com/c/rKtXn5tl)  
**Operational authority:** none. No production read, no MCP call, no Cloudflare, R2, D1, TMDB, Letterboxd or Scheduled Task access was made for this report.

## Method

Read the current code and configuration, the accepted ADRs for the three Cloudflare-bound domains and the dated incident evidence, and recorded which reliability pieces already exist, under which names, and with which numbers. Nothing was executed against production. Local tests were not run for this report because it changes no code.

## Findings

| Area | What exists on `main` | Source |
| --- | --- | --- |
| Worker cron | One trigger, `37 * * * *`, used by the enrichment projector only | `wrangler.jsonc` `triggers.crons` |
| Discovery Workflow | Binding `DISCOVERY_WORKFLOW`, class `DiscoveryWorkflow`, no `schedules`; inert while `DISCOVERY_EXECUTOR` is absent | `wrangler.jsonc` `workflows`; [ADR 0083](../../adr/0083-inert-discovery-workflow.md) |
| Discovery recovery backoff | `[60000, 300000, 900000, 3600000]` ms; the fifth failure sets `recovery_exhausted` and `quarantined` | `src/discovery-workflow.js` (`DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS`, recovery limit) |
| Discovery recoverable stops | `no_progress`, `write_uncertain`, `step_cap`, `rollover_uncertain`, `no_continuation` | `src/discovery-workflow.js` (`DISCOVERY_WORKFLOW_RECOVERABLE`) |
| Discovery terminal stops | `complete`, `backlog_empty`, `stale_generation`, `executor_not_workflow`, `recovery_exhausted` | `src/discovery-workflow.js` (`DISCOVERY_WORKFLOW_TERMINAL`) |
| Discovery external interrupted stop | Two consecutive pre-checkpoint hop losses write `paused` / `interrupted`; only the gated confirm resumes | [ADR 0088](../../adr/0088-guarded-interrupted-discovery-recovery.md) |
| Ratings stale run | A stale run is closed `unknown`; a second interruption at the same phase and checkpoint sets `isolation`; starts answer `isolated` until a manual start with `clearIsolation` | `src/letterboxd-ratings.js`; [scheduling page](../../architecture/scheduling-and-orchestration.md#the-separate-ratings-pipeline) |
| Ratings Letterboxd refusals | 403 is not bypassed; 403 or 429 on the removal queue pauses six hours | [ADR 0018](../../adr/0018-letterboxd-last-good-ratings.md); [scheduling page](../../architecture/scheduling-and-orchestration.md#the-separate-ratings-pipeline) |
| EPG publication | Atomic D1 pointer switch, `published_epg_authority` `d1` / `open`; R2 mirrors | [ADR 0079](../../adr/0079-d1-authoritative-published-epg.md) |
| Past platform kills | EPG commit and discovery chunks ended `exceededMemory` | [commit interruption](../epg-commit-interrupted-2026-10-27.md), [MCP internal error RCA](../discovery-mcp-internal-error-rca-2026-10-28.md), [chunk memory](../discovery/air-342-chunk-memory-2026-11-04.md) |
| External task reliability | Unattributed task disables; hourly trigger versus server gate drift | [repeat disable RCA](../scheduled-task-repeat-disable-2026-11-01.md), [timing RCA](../scheduled-tasks-hourly-timing-rca-2026-10-28.md) |

## Result

The three domains already use leases, compare-and-swap, checkpoints and fail-closed stops, but with different names, no shared failure classes and only Discovery with a budgeted recovery. The contract keeps the Discovery numbers (1, 5, 15, 60 minutes; quarantine on the fifth consecutive failure) as the shared defaults, maps the Ratings `unknown` and `isolated` states and the Discovery stops onto the shared classes, and leaves the platform limits and pricing to each delivery.

## Verdict

Design input sufficient for a Proposed ADR. Not evidence of any production state.

## Limits

- Production state (task registry, markers, Workflow instances, current backlog) was not read for this report; the values above are from code and earlier dated evidence.
- Cloudflare Workflow and cron limits and pricing were not checked; each delivery verifies them.
- The default budgets are product choices, not measurements.
