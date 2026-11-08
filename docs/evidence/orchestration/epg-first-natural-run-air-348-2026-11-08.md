# First natural EPG Cloudflare run: a D1 read failure stopped the instance (AIR-348)

Captured 2026-11-08 (UTC) from read-only observation: the Cloudflare Workflows API (`GET` of the instance), D1 `SELECT`, the MCP `epg_status` and `ratings_sync_status`. Nothing was run, written or recovered by hand (no `ensure`, sync, lease reset, flag, Task or R2/D1 write). No private payload is recorded.

## Timeline (UTC)

| Time | Observation |
| --- | --- |
| 12:41:45 and 12:44:04 | `close_admission` (epoch 0 to 1) and `complete` (drain verified), mode document revision 2 |
| 16:00 | The hourly tick created one Workflow `epg_20261108_0` (series 0, epoch 1) and one Ratings Workflow `ratings_20261108_0`; the Ratings run finished at 16:01:34 with no failure |
| 16:01 to 16:44 | The EPG instance ran `epg`, then `seal` (phase `ledger`, then `items`); about 41 s per step, no failure, no cooldown, no quarantine |
| 16:43:50.527 to 16:44:20.748 | Step `act-59` (30 s) returned `{"kind":"stop","reason":"epoch_mismatch"}` |
| 16:44:20.8 | Step `stopped-60` returned `{"recorded":false,"reason":"d1_unavailable"}`; the instance ended `complete`, success true, output `{"stopped":true,"reason":"epoch_mismatch"}` |
| 16:53 | `epg_status`: instance liveness `finished`, control phase `running`, published `null` |
| 17:00:43 | The hourly tick: `ensure` recorded `instance_terminated` (transient), control phase `stopped`, budget 1 of 5 consecutive and 1 of 12 total, cooldown until 17:01:54; no successor yet |

## What the reads show

- The instance had 61 steps (59 actions plus the stop), no sleep, every step one attempt and successful. The step cap (400) was not reached.
- The mode document did not change: revision 2, epoch 1, `cloudflare`, 12:44:05. There was no epoch change and no `close_admission`.
- Control: revision 60, phase `running`, `doneAt` null, no quarantine, no failure, checkpoint `seal|ledger`, last durable progress 16:01:30 (stale: the progress count does not move inside a long seal phase). Lease: held by the last step, `released: false`, expired 16:48:50.
- `published_epg_authority`: `d1/open`, run `307a3e1d…`, generation 277, unchanged: no publication, so no duplicate publication either.
- `discovery_seal` for that run was `items`, last updated 16:44:19.466: the seal advanced until a second before the stop.

## Cause

`assertStep` read the mode revision and the lease in one D1 query and, in `look()`, turned **any** exception of that read into `epg_step_fenced`; `classifyThrown` maps that code to `epoch_mismatch`, which the executor treats as a stop, not a cooldown. At the end of `act-59` that read failed, and 50 ms later the stop step's own D1 read failed too (`d1_unavailable`), so a short D1 failure around 16:44:20 is the consistent explanation. The stop could not be recorded, which left the control record `running` for an instance that had ended.

Not proven: the text of the D1 error. The Workflow step logs are not readable through the Workers Observability events view (its events query fails to parse the Workflow records), and the error aggregate for 16:40 to 16:55 shows one `Error` event without a message.

## Change and expected recovery

The guard now reports an unreadable read as `epg_step_unreadable` (transient `d1_unavailable`, the mutation still refused); a mode revision, holder, release or expiry mismatch is still `epg_step_fenced`. By the code of `ensure` an ended instance with a `running` control is recorded as `instance_terminated` with a cooldown at the next tick, and a successor series resumes the same sync run on a later tick; publication happens once, at the end of the seal, so the successor cannot publish twice. The first half was observed at the 17:00:43 tick (the record and the cooldown); the successor series, expected at the next hourly tick, is not yet observed.

## Limits

One run, one failure. The D1 error is inferred. Whether the successor is created and finishes is unobserved at the time of this record; the cron is hourly, so the successor starts at 18:00 UTC at the earliest.
