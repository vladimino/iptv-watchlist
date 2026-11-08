# First natural EPG Cloudflare run: a D1 read failure stopped the first instance, the successor published (AIR-348)

Captured 2026-11-08 (UTC), 12:38 to 18:25, from read-only observation: the Cloudflare Workflows API (`GET` of the instance), D1 `SELECT`, the MCP `epg_status` and `ratings_sync_status`. Nothing was run, written or recovered by hand (no `ensure`, sync, lease reset, flag, Task or R2/D1 write). No private payload is recorded.

## Activation record (owner approvals on the [AIR-348 card](https://trello.com/c/PUrlzMuH); each step was its own approval)

| UTC | Step | Result and readback |
| --- | --- | --- |
| 2026-11-08 | Migration `0017` applied once | schema 17, table empty ([evidence](../d1-migration/air-348-0017-apply-2026-11-08.md), PR #418) |
| 2026-11-08 | Worker cron `37 * * * *` to `0 * * * *` | deployed and read back after the [coexistence preflight](cron-coexistence-air-348-2026-11-08.md) (PR #422, PR #426); Ratings logical due 17:00 Madrid (PR #419) |
| 12:41:45 | `close_admission` target `cloudflare` | HTTP 200, mode `switching`, epoch 0 to 1, mode document revision 1; preflight read-only: no document rows, seal `done`, no external step |
| 12:44:04 | `complete` | HTTP 200, mode `cloudflare`, epoch 1, `drain: verified`, mode document revision 2 |
| 16:00 | Natural run | the tick created the Workflows below (executor and migration code: PR #413) |

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
| 17:15 | PR #439 (guard: an unreadable read is transient) merged; deployed before 18:00 |
| 18:00:44 | The hourly tick created the successor `epg_20261108_1` (series 1, started 18:00:48), under the fixed guard |
| 18:09:16 | `discovery_seal` `done` for the same sync run `29146e6a…` (the successor resumed the run at the seal; the `epg` stage was not repeated and no second run was started) |
| 18:15:36 | The generation row for run `29146e6a…` was created in `published_epg_generation`; read at 18:25, `published_epg_authority` was `d1/open` on that run, generation 277 to 278, once (the exact switch time was not read) |
| 18:17:28 | Step `act-29` returned `{"kind":"stop","reason":"complete"}`; control revision 92: phase `done`, `doneAt` set, `publishedRunId` `29146e6a…`, budget consecutive 0 and total 1, no quarantine; the lease released 18:17:28; the sync run `complete`. Instance `epg_20261108_1` ended `complete` after 31 steps, no sleep, no failed or retried step (`stopped-30` recorded nothing because control was already done) |

## What the reads show

- The instance had 61 steps (59 actions plus the stop), no sleep, every step one attempt and successful. The step cap (400) was not reached.
- The mode document did not change: revision 2, epoch 1, `cloudflare`, 12:44:05. There was no epoch change and no `close_admission`.
- Control: revision 60, phase `running`, `doneAt` null, no quarantine, no failure, checkpoint `seal|ledger`, last durable progress 16:01:30 (stale: the progress count does not move inside a long seal phase). Lease: held by the last step, `released: false`, expired 16:48:50.
- `published_epg_authority`: `d1/open`, run `307a3e1d…`, generation 277, unchanged: no publication, so no duplicate publication either.
- `discovery_seal` for that run was `items`, last updated 16:44:19.466: the seal advanced until a second before the stop.

## Cause

`assertStep` read the mode revision and the lease in one D1 query and, in `look()`, turned **any** exception of that read into `epg_step_fenced`; `classifyThrown` maps that code to `epoch_mismatch`, which the executor treats as a stop, not a cooldown. At the end of `act-59` that read failed, and 50 ms later the stop step's own D1 read failed too (`d1_unavailable`), so a short D1 failure around 16:44:20 is the consistent explanation. The stop could not be recorded, which left the control record `running` for an instance that had ended.

Not proven: the text of the D1 error. The Workflow step logs are not readable through the Workers Observability events view (its events query fails to parse the Workflow records), and the error aggregate for 16:40 to 16:55 shows one `Error` event without a message.

## Change and recovery

The guard now reports an unreadable read as `epg_step_unreadable` (transient `d1_unavailable`, the mutation still refused); a mode revision, holder, release or expiry mismatch is still `epg_step_fenced` (PR #439). An ended instance with a `running` control was recorded as `instance_terminated` with a cooldown at the 17:00 tick, and a successor series resumed the same sync run at the 18:00 tick. Both halves were observed.

## Result of the natural run

- **One new published generation.** `published_epg_generation` holds one row for run `29146e6a…` (phase `published`, `published_at` 16:01:39, row created 18:15:36) with 1,661 shows and 790 members (the previous run `307a3e1d…`: 1,714 shows and 790 members). The authority generation moved once (277 to 278): no duplicate publication.
- **Ratings** ran in the same tick: `ratings_20261108_0` finished 16:01:34 with no failure.
- **Delay.** The first instance ran 43 minutes (16:00:51 to 16:44:20); its stop moved the rest of the work to the next hourly tick after the cooldown (18:00), and the day's run completed at 18:17 UTC. How long the first instance would have needed is not known.

## Limits

One day, one failure. The D1 error text is inferred, not read. Not observed here: the Discovery handoff to the new generation (`discovery_status` still named the previous run when read at 18:2x; the Discovery Workflow picks the intent up on its own), the R2 compatibility mirrors and the commit tail (no read route that can repair a mirror was called), and the legacy ChatGPT Daily EPG Task (not touched; by contract it receives 409 `external_writer_fenced`; its disabling is a separate owner approval checked in the live registry). `epg_status` reported `health: stalled` for the successor while its steps were advancing, because the progress count does not move inside a long seal phase; that observability gap is a separate decision, not part of this record.
