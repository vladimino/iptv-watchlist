# Ratings Scheduled Task deactivation after Cloudflare cutover

Captured 2026-11-06 (Europe/Madrid) under the owner's explicit AIR-347 authorization. This is a dated production readback, not an authorization to trigger writers or edit other tasks.

## Registry mutation and readback

- Target: ChatGPT Scheduled Task `Обновление рейтингов «В эфире»`, id `6ae52289ae9481919a68eec9310f5d8c`.
- Mutation: `is_enabled=false` only. The automation service returned `success=true`, `Automation updated.` and `is_enabled=false`.
- Independent registry readback: `is_enabled=false`, `updated_at=2026-11-06T13:51:32.780383Z`, last ChatGPT run time `2026-11-05T17:12:03.172096Z`. Prompt and schedule were not changed.
- Other Tasks, cron, flags, Access, D1/R2 and Workflow were not modified.

## Read-only production Ratings readback

The owner-only IPTV MCP `probe_read` returned `status=ok`, `cloudflare-access-jwt-verified` and `sideEffects=none` on 2026-11-06T13:51:45Z. `ratings_sync_status` returned:

- `orchestration.mode=cloudflare`, `epoch=1`, `runKey=2026-11-05`, `phase=done`, owner `workflow`, instance `ratings_20261105_0`; `health=idle`.
- Natural scheduled run `5d283118-e270-4004-8d57-039ce699ffe7`, started `2026-11-05T16:37:36.911Z` and finished `16:38:08.851Z`; `state=finished`, `phase=done`, `outcome=recent_window`.
- Diary page 1, 50 rows, 1 newly written fact, zero reported conflicts. This is deliberately a *recent window*, not full historical Diary coverage.
- Removal queue `pending=0`, `unresolved=0`; lease not live, no quarantine or failure counters. Next due `2026-11-06T16:30:00Z` (17:30 Madrid), not a promise of exact cron arrival.
- The last legacy ChatGPT run on November 5 saw that the Cloudflare pipeline had already completed and did not start a second writer.

## Boundaries and follow-up

The read-only status plus registered Task disable supports the single-active-scheduled-writer cutover. It does not independently establish complete per-row D1/viewing parity, all prior removal histories, exact billed CPU/cost or a rehearsed rollback. No manual Ratings run was performed. The Drift Task prompt was subsequently updated with separate owner approval on 2026-11-06T13:59:03.892Z. Registry readback confirms it remains enabled on its unchanged daily 18:15 Europe/Madrid recurrence, expects the legacy Ratings Task disabled, checks Cloudflare Ratings Workflow status, and preserves its read-only/no-repair policy. The update did not change the schedule or other Tasks. The source of truth for Registry enabled status remains its live state, not this dated report.

[Delivery card](https://trello.com/c/j2Ua76yv) · [Implementation PR #375](https://github.com/vladimino/iptv-watchlist/pull/375) · [Workflow delivery CI](https://github.com/vladimino/iptv-watchlist/actions/runs/41978648299)
