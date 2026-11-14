# AIR-462: production EPG attempt correlation, 14 November 2026

## Scope and sources

Read-only observation of the **natural** EPG Workflow on 2026-11-14. Sources: Cloudflare Workflow History `iptv-epg/epg_20261114_0`, Workers Observability telemetry queries (`view=events`, `dry=true`, service `iptv`), the read-only `epg_status` MCP diagnostic, and the Worker deployment history. Evidence collected within telemetry retention. No manual Workflow invocation, retry, replay, data write, flag or schedule change.

- Diagnostics delivered by [AIR-462 PR #596](https://github.com/vladimino/iptv-watchlist/pull/596), merge/main SHA `1d7185352699ac0d18f33dbe710e6d96b93e2c94`; post-merge [Actions run 43512243505](https://github.com/vladimino/iptv-watchlist/actions/runs/43512243505): all three test jobs and deployment succeeded.
- Worker deployment covering the natural run: **2026-11-14 15:16:33.787 UTC (16:16:33 Madrid)**, deployed version `cda4d6ef-8f75-40de-90e3-8d78b3f89b05`. The next deployment was at 16:30:09.822 UTC, after this EPG run. These are Worker deployment version identifiers, not Git commit SHAs.
- Workflow start **16:00:58.429 UTC (17:00:58 Madrid)**, status `complete`, end **16:20:21.285 UTC (17:20:21 Madrid)**. EPG published at **16:20:03.349 UTC (17:20:03 Madrid)**, runId `0e4a5f90-8f50-4c6d-b749-80c7565194a2`; subsequent read-only `epg_status` showed `phase=done`, `stage=complete`, `remaining=0`, `health=healthy`. This is successful eventual publication, not absence of memory failures.

## Observed

| Platform step | Failed attempt (UTC; +01:00 Madrid) | Local attemptTraceId | Last confirmed telemetry | Platform result |
| --- | --- | --- | --- | --- |
| `act-5-1` | 16:08:11.682–16:08:40.397 (17:08 Madrid) | `a1b44b3f-1ba0-4086-bb83-d931e518bd71` | `seal_ledger` entered; `seal_ledger_read` entered; `seal_ledger_batches` at **16:08:39.567 UTC** reported **21,434 items / 150 batches**; no matching `epg_act:exit/error` from this trace | `Worker exceeded memory limit.` |
| `act-10-1` | 16:14:19.219–16:14:30.662 (17:14 Madrid) | `c458eac5-38df-429a-997a-cbed7701a9d8` | `seal_payload_get/text/parse` exited; `seal_publish_pointer` and `seal_publish_mirrors` exited; last `seal_publish_copy:enter` at **16:14:28.916 UTC**; no matching `epg_act:exit/error` from this trace | `Worker exceeded memory limit.` |

Cloudflare History then recorded successful automatic reattempts: `act-5-1` 16:08:50.397–16:08:50.638 UTC and `act-10-1` 16:14:40.662–16:14:40.908 UTC. Their local `epg_act` trace IDs differ from those of the failed callbacks and have matching enter/exit. No owner-triggered retry was performed.

The diagnostic design's key acceptance property was observed **during actual OOM**: platform attempts could be associated with distinct local traces and ordered bounded phase markers. The `epg_act` trace is **not** a Cloudflare platform attempt ID; correlation uses Workflow History, step name and time range.

## Inferred, not proven

- The last confirmed work in `act-5` was in the ledger read/batch path; the last confirmed work in `act-10` was in the publish/copy path. This narrows investigation but **does not identify the allocation or instruction causing OOM**.
- `epg_memory_boundary` sizes/counts are workload or allocation proxies, **not** `heapUsed`, isolate lifetime or 128 MiB headroom.
- Log loss, buffering, truncation and synchronous work between markers can shift the true failure point. Last observed line is **not** the definitive killing instruction.

## Acceptance and follow-up

**AIR-462 instrumentation acceptance: positive**, based on observed production correlation, post-merge delivery and owner verification on 14 November 2026. This acceptance covers bounded passive diagnostics only.

The underlying OOM problem is **not fixed or causally established** by this evidence. Keep [AIR-460](https://trello.com/c/ZXySuCJk) and [AIR-420](https://trello.com/c/J0dit94i) on their own acceptance paths; use the observed phase bounds to target further RCA without forcing production runs.

Documentation impact: this evidence record and [evidence index](../README.md); no new runtime topology, API, storage, scheduler or architectural contract.
