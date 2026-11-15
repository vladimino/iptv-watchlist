# AIR-467: Natural EPG-priority Discovery pause, refusal, release and resumption

**Observation:** 15 November 2026, Europe/Madrid (CET = UTC+1). **Verdict:** natural-run functional PASS for [AIR-467](https://trello.com/c/yuBApRtz). Accepted contract: [ADR 0135](../../adr/0135-epg-priority-discovery-pause.md). The implementation was delivered in [PR #605](https://github.com/vladimino/iptv-watchlist/pull/605), and the gate was activated by the separately authorized production D1 migration `0022` on 14 November ([AIR-466](https://trello.com/c/o7HHT0B4)). The 15 November EPG run used deployed Worker version `fcf1d8ff-9fdc-4999-9199-eee0c67fbe12` (deployed 15:51:55 UTC by [PR #651](https://github.com/vladimino/iptv-watchlist/pull/651), commit `910206361a7d0a2d77bb9514273ff67540f25502`).

## Sources and safety

Read-only Cloudflare Workflows GET for `iptv-discovery` instances `discovery_0e4a5f908f504c6db74980c7565194a2_94` and `discovery_3b7c7152eb5445f7898592c377b57181_0`, Cloudflare `iptv-epg` Workflow and `epg_phase` historical logs; production D1 SELECTs against `discovery_epg_priority`, `published_epg_authority`, `discovery_authority`, `discovery_lease` (all returned `rows_written=0`); read-only `epg_status` and `epg_pipeline_status(view=operational)`. Cloudflare Observability searches used `dry:true`. No manual EPG/Discovery run, recovery, lease reset, scheduler change, or D1/R2 mutation was performed.

## Chronology (Madrid time, 15 November; UTC is one hour earlier)

| Time | Observed natural event |
| --- | --- |
| 17:00:02-17:00:07 | Previous-generation Discovery `chunk-10-1` returned `busy=true`, `progress=false`, `checked=0`. The durable `busy-11-1` Workflow reply recorded **`reason=epg_priority`**, `window.state=epg_priority`, `owedDayKey=2026-11-15`, `ownerKind=none`; retry was delayed about one minute. |
| 17:01:09-17:01:10 | `wait-15-1` again recorded **`reason=epg_priority`** and the same owed date. No productive old-generation chunk was admitted. |
| 17:04:55-17:04:58 | EPG `seal_publish_pointer` entered and exited successfully. The accepted pointer batch stamps the frozen Madrid day and releases the priority row only after the Discovery published pin matches. |
| 17:05:13-17:05:46 | New-generation Discovery instance `discovery_3b7c7152eb5445f7898592c377b57181_0` started **after** pointer commit; its first chunk had `progress=true`, `busy=false`, `checked=11`, `stage=partial`, no error, and saved progress. |
| 17:05:47-17:08:20 | Five further productive chunks on the new generation, `checked=8,10,10,7,8`. The previous instance woke at 17:05:47 but returned `owner=false, reason=not_owner`, so it did not resume old-generation writes. |
| 17:08:30 | EPG control reached `done`. This is **after** the pointer handoff and is not the gate-release criterion. |

The gate starts at 16:55 Madrid by a predicate in the D1 admission statement and is **lazily armed on an attempted admission**, not by an extra 16:55 cron. The old Workflow was asleep until 17:00, so a historical `paused` row **at exactly 16:55 was not sampled**. Instead, the two typed `epg_priority` refusals prove the pause took effect and persisted across a retry. The observed 17:05 resumption is correctly after the pointer/day/pin handoff but before final EPG orchestration completion.

## Post-publication state (D1 read-only)

- `discovery_epg_priority`: `state=clear`, `owed_day_key=NULL`, `override_day_key=NULL`.
- `published_epg_authority`: `mode=d1`, `cutover=open`, `madrid_run_key=2026-11-15`, `programme_run_id=3b7c7152-eb54-45f7-8985-92c377b57181`, `generation=510`.
- `discovery_authority`: `mode=d1`, `cutover=open`, both `programme_run_id` and `published_programme_run_id` equal the new published EPG runId.
- `discovery_lease`: `expires_at=0` (no live lease; retained `holder_kind=epg` does not imply a live holder).
- EPG status: `syncRun.stage=complete`, `failure.total=0`, no quarantine, identical published runId.

**Acceptance:** natural typed priority refusal, sustained pause across a poll, successful pointer/day/pin release, safe productive Discovery restart on the new generation, and an old-series owner fence. A late `clear` read alone would not have established historical pause; the Workflow output supplies that missing evidence.

**Not exercised in production:** an in-flight Discovery lease renewing across 16:55, a failed/stalled EPG holding pause indefinitely, owner override, and cross-midnight adoption ([AIR-464](https://trello.com/c/asr6KVU8)). These remain test and separate-scope scenarios, not claims of this observation.

**Documentation-only:** no functional or architectural change. The evidence index and ADR/reference implementation-status notes link this capture. No runbook or Mermaid update is required because the accepted protocol and operational procedures are unchanged.
