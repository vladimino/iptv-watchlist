# Cron move to `0 * * * *`: coexistence preflight (AIR-348)

Captured 2026-11-08 (UTC), 09:50–10:00 UTC, **read-only**: Cloudflare Worker schedules readout, Workers Observability events (17:30 UTC on 2026-11-07 to 09:55 UTC on 2026-11-08), the IPTV MCP status tools, four `SELECT` statements on production D1 `iptv`, the repository at `8db76bf` and one offline simulation. **No cron, flag, Task, Workflow instance, D1/R2 write, EPG sync, lease reset or mode change was made.** This record decides nothing and authorizes nothing: the cron change stays a separate owner approval.

## What was read

| Item | Observation |
| --- | --- |
| Worker schedule (Cloudflare readout) | exactly one trigger, `37 * * * *`, created 2026-10-30; `wrangler.jsonc` on `main` agrees |
| `scheduled()` (`src/worker.js`) | one `Promise.allSettled` of five calls: `runD1EnrichmentProjection`, `RatingsOrchestration.ensure`, `EpgOrchestration.ensure`, `reconcileDiscoveryWorkflow`, `Monitor.run`; the handler awaits nothing itself, holds no lease and shares nothing between the members |
| Assumptions of the minute 37 | none in `src/` or `scripts/` (searched, and asserted by the simulation) |
| Flags | `DISCOVERY_EXECUTOR=workflow`, `D1_ENRICHMENT_WRITE=on`, `MONITOR=on`, `MONITOR_TRANSPORT=telegram` |
| Ratings | `orchestration.mode=cloudflare`, epoch 1, `dueAt=2026-11-08T16:00:00Z` (17:00 Madrid), health `idle`; the run of 2026-11-07 started 16:37:37Z (the first tick after the old 17:30 due) and finished 16:38:00Z |
| EPG | `orchestration.available=true`, `mode=external`, epoch 0, no instance; published run `307a3e1d…` (2026-11-06 17:57Z); the external Daily Task is still the executor |
| Discovery authority | `d1` / `open`, generation 32088 and moving, lease free (`expires_at=0`), seal `done`; published EPG `d1` / `open` generation 258 |

## The projector and Discovery, tick by tick

`d1_enrichment_projection` at each natural tick after the AIR-375 fix (UTC, `:37` ticks; `writtenPeople`/`writtenFilms`, `remaining`, duration):

| Tick | Outcome | Written | Remaining | Duration |
| --- | --- | --- | --- | --- |
| 07 Nov 19:38 | deferred `input_changed` | 0/0 | n/a | 36.0 s |
| 07 Nov 20:37 | deferred `input_changed` | 0/0 | n/a | 19.3 s |
| 07 Nov 21:38 | budget | 775/0 | 16,524 | 45.9 s |
| 07 Nov 22:38 | budget | 775/0 | 16,234 | 48.7 s |
| 07 Nov 23:37 | deferred `input_changed` | 0/0 | n/a | 23.6 s |
| 08 Nov 00:38 | budget | 775/0 | 16,071 | 42.1 s |
| 08 Nov 01:38 | budget | 775/0 | 15,296 | 44.0 s |
| 08 Nov 02:38 | budget | 325/0 | 14,971 | 60.4 s |
| 08 Nov 03:37 | deferred `authority_unavailable` | 0/0 | n/a | 5.4 s, 2 queries |
| 08 Nov 04:37 | deferred `authority_unavailable` | 0/0 | n/a | 5.1 s, 2 queries |
| 08 Nov 05:37 | deferred `authority_unavailable` | 0/0 | n/a | 2.1 s, 2 queries |
| 08 Nov 06:37 | deferred `authority_unavailable` | 0/0 | n/a | 9.5 s, 2 queries |
| 08 Nov 07:37 | deferred `authority_unavailable` | 0/0 | n/a | 10.3 s, 2 queries |
| 08 Nov 08:37 | deferred `input_changed` | 0/0 | n/a | 21.2 s, 16 queries |
| 08 Nov 09:37 | deferred `authority_unavailable` | 0/0 | n/a | 5.2 s, 2 queries |

`errorCount` was 0 and `leaseLost` false on every writing tick. Since 03:37 UTC six of seven ticks were `authority_unavailable` and the remaining count has not moved from 14,971. At 09:51 UTC `epg_pipeline_status` itself answered the short token `discovery_fence`. The Discovery authority generation was 25,463 at 23:37 UTC and 32,088 at about 09:54 UTC, about 10.7 fenced writes a minute through the night: a read that spans several statements is fenced whenever one write lands inside it. The projector's two reads and the monitor's Discovery read are such reads. **This is independent of the cron minute**: the write rate is the Discovery Workflow's, it ran the same way at `:37`, and a tick at `:00` meets the same rate. It is recorded here because it decides what the projector can do on the day of an EPG publication.

The monitor at the same ticks: `discovery_unreadable` appeared at 19:37, 22:37, 03:37, 06:37 and 09:37 UTC; messages were sent at 21:37, 22:37, 03:37, 04:37 and 09:37 (the first of them the confirmed Telegram delivery of `predictions_stale`). Which messages carried which issue is not in the log; the `discovery_unreadable` snapshots coincide with the fenced reads and are probably the same cause, not a failed source.

## Schedule arithmetic and idempotency (offline)

`tests/cron-schedule-simulation.mjs` (no network, no production): on a winter day, a summer day and both DST change days, an hourly UTC cron has a tick exactly at Madrid 17:00 when the expression is `0 * * * *` (Madrid is a whole-hour offset: 16:00Z in CET, 15:00Z in CEST), and 37 minutes later when it is `37 * * * *`; the Worker decides due from the Madrid date, not from the cron. The real `EpgOrchestration.ensure`, driven through every hourly tick of each date with duplicate firings, creates exactly one instance per date, at the first tick after the logical due time; with that tick missed it creates one at the next hourly tick; the next Madrid date is a new run key. The handler's members are asserted independent (no `await`, no lease). Ratings uses the same `dailyDue` and the same Madrid-date run key under the same compare-and-set (`tests/ratings-orchestration.mjs`).

## What this does not show

- A real tick at `:00`: delivery delay, duplicate delivery and a missed tick are simulated, not observed. The observed ticks start at the same sub-minute offset each hour (the projector's `startedAt` is `hh:37:30.103`), so a `:00` tick would be expected at `hh:00:30`.
- The behaviour of the projector, the monitor and Ratings in the 17:00 hour on a day with an EPG publication under the Cloudflare executor.
- The reason of the Discovery write rate (the backlog and its end are not read here).
