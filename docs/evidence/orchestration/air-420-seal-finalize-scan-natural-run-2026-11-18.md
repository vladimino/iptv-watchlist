# AIR-420: where the 95 minutes of the 18 November 2026 EPG run went

Read-only evidence (L0): MCP `epg_status`, Cloudflare Workflow `GET` of `iptv-epg` instances `epg_20261118_0` and `epg_20261118_1`, Workers Observability (`epg_act`, `epg_act_stored`, `epg_phase`, `epg_memory_boundary`, `epg_continuation`) through the Cloudflare API connector with `dry: true`, and one D1 `SELECT` of generation metadata (no payload column). Nothing was created, retried, terminated or written; no flag, Task, lease or cron was touched. All times UTC (Madrid = UTC+1 on this date). No payload, Film id or secret is reproduced; the EPG `runId` is a run identifier, not a Film id. Code facts were read on `main` at `727e3fc`; the deployed Worker version was not read back for this report.

## Result

- Natural run `2026-11-18`, `runId` `cc26a2e7-ae15-4f15-8e21-62ff131e04fd`: due 16:00:00, `publication.publishedAt` 17:35:09.481, `latencyMs` 5 709 481 (**95 min 09 s**), target 900 000. Sync `complete` 17:35:47, producing instance finished 17:36:18. `health` ended `healthy` with `failure.total` 0.
- **The largest single cost is the `finalize_scan` unit, not the platform failures.** `seal_finalize` ran as 34 `seal_finalize_scan` executions of about 78 s each: **44 min 02 s of scan work, 68 min 22 s of finalize wall time, 72 % of the run**. On 14 and 15 November the same unit was one call of 8 s and 3 s.
- **The generation was already live far earlier than the SLA clock says.** The D1 generation row of this run was created 16:25:34.735 and the pointer step `seal_publish_pointer` exited 16:25:45 (25 min 45 s after due). `publishedAt` is the completion of `finalize`, 69 min later. Whether clients saw the new programme from 16:25 was **not** verified (read path not checked).
- Eight `WorkflowInternalError` attempts happened, as on 17 November. They cost about 25 minutes of lost or idle time in total. They are real, but they are not the dominant term: with that and the two unexplained `busy` sleeps removed the run would still take about 66 minutes.

## 1. Run timeline (UTC)

| Segment | From – to | Seconds | Note |
| --- | --- | --- | --- |
| Due → first `act` of series 0 | 16:00:00 – 16:01:23 | 83 | Workflow create after the hourly tick |
| Pre-seal work (`act-0` … start of `act-2`) | 16:01:23 – 16:04:55 | 212 | `epg_continuation` 122 s, input scan 9 s |
| `seal_stage`, attempt 1 of `act-2`, **killed in the callback** | 16:04:55 – 16:08:49 | 234 | No `exit` and no `error` edge; last phase line `seal_stage_archive` 16:08:41 |
| `step_lease_held` sleep after the retry | 16:08:49 – 16:11:44 | 175 | Retry returned `sleep` after 1.3 s |
| `seal_stage` redone, `act-4` of series 0 | 16:11:44 – 16:17:17 | 333 | `seal_stage` 236 s; callback returned `handoff` at 16:17:16.976 |
| **Idle after the callback returned** | 16:17:17 – 16:21:45 | 268 | Platform ended the attempt `WorkflowInternalError` at 16:21:45.168; retry replayed the handoff in 2.8 s |
| Handoff, successor create | 16:21:45 – 16:21:50 | 5 | |
| `seal_ledger`, series 1 `act-0` … `act-4` | 16:21:50 – 16:25:24 | 214 | 20 974 / 20 974 items, 5 steps of about 30 s |
| `seal_publish`, `act-5`, `act-6` | 16:25:24 – 16:26:31 | 67 | pointer exit 16:25:45, mirrors 16:25:55, copy and intent 16:26:25 |
| **`seal_finalize`, `act-7` … `act-46`** | 16:26:31 – 17:34:53 | 4 102 | section 2 |
| `seal_finalize_events`, `publishedAt` stamped | 17:34:53 – 17:35:09 | 16 | |
| `seal_queue` refresh | 17:35:14 – 17:35:47 | 33 | run `complete` 17:35:47 |

The segments add up to 5 709 s.

## 2. `seal_finalize` step by step

`seal_finalize_handover` (1.4 s) and `seal_finalize_watchlist` (0.6 s) are negligible; every other second is `seal_finalize_scan`, i.e. `persistScan` (`src/worker.js`), which calls `applyRatedAdmissionRetention` on a slice of at most `UNIT_CAP = 12` retention items per step (`src/canonical-rated-admission-producer.js`) and then returns `continue`. `act-47` is `seal_finalize_events` (1.9 s); `act-48` is `seal_queue`.

| Step / attempt | `seal_finalize` enter | exit | `seal_finalize_scan` (s) | idle gap before this step (s) |
| --- | --- | --- | --- | --- |
| `act-7` a1 | 16:26:36 | 16:28:45 | 123.8 | |
| `act-7` a2 | 16:28:55 | 16:30:12 | 75.1 | 10 |
| `act-8` a1 | 16:30:23 | 16:31:40 | 75.3 | 11 |
| `act-9` a1 | 16:31:52 | 16:33:13 | 78.7 | 12 |
| `act-10` a1 | 16:33:24 | 16:34:47 | 77.6 | 11 |
| `act-11` a1 | 16:34:58 | 16:36:18 | 78.3 | 11 |
| `act-12` a1 | 16:36:29 | 16:37:51 | 79.1 | 11 |
| `act-12` a2 | 16:38:03 | 16:39:25 | 79.9 | 12 |
| `act-13` a1 | 16:39:35 | 16:40:58 | 78.9 | 10 |
| `act-14` a1 | 16:41:09 | 16:42:31 | 78.7 | 11 |
| `act-17` a1 | 16:44:16 | 16:45:39 | 80.0 | **105** |
| `act-18` a1 | 16:45:49 | 16:47:11 | 79.9 | 10 |
| `act-19` a1 | 16:47:22 | 16:48:43 | 78.5 | 11 |
| `act-21` a1 | 16:52:10 | 16:53:31 | 77.5 | **207** |
| `act-22` a1 | 16:53:41 | 16:55:03 | 79.6 | 10 |
| `act-23` a1 | 16:55:14 | 16:56:34 | 77.9 | 11 |
| `act-24` a1 | 16:56:44 | 16:58:05 | 78.3 | 10 |
| `act-25` a1 | 16:58:15 | 16:59:37 | 78.6 | 10 |
| `act-26` a1 | 16:59:47 | 17:01:08 | 78.7 | 10 |
| `act-28` a1 | 17:06:04 | 17:07:24 | 77.6 | **296** |
| `act-29` a1 | 17:07:34 | 17:08:54 | 77.9 | 10 |
| `act-30` a1 | 17:09:05 | 17:10:26 | 78.2 | 11 |
| `act-31` a1 | 17:10:37 | 17:11:55 | 76.0 | 11 |
| `act-33` a1 | 17:14:03 | 17:15:26 | 79.7 | **128** |
| `act-34` a1 | 17:15:37 | 17:16:57 | 77.7 | 11 |
| `act-35` a1 | 17:17:08 | 17:18:27 | 76.5 | 11 |
| `act-36` a1 | 17:18:37 | 17:19:56 | 76.0 | 10 |
| `act-37` a1 | 17:20:06 | 17:21:27 | 78.3 | 10 |
| `act-39` a1 | 17:25:22 | 17:26:42 | 78.0 | **235** |
| `act-42` a1 | 17:28:29 | 17:29:51 | 79.8 | **107** |
| `act-43` a1 | 17:30:02 | 17:31:21 | 77.5 | 11 |
| `act-44` a1 | 17:31:32 | 17:32:53 | 78.3 | 11 |
| `act-45` a1 | 17:33:03 | 17:34:22 | 77.1 | 10 |
| `act-46` a1 | 17:34:32 | 17:34:53 | 19.0 | 10 |

"a1/a2" is the order of executions of that `act-N` callback in the logs. The steps missing from the table (`act-15`, `act-16`, `act-20`, `act-27`, `act-32`, `act-38`, `act-40`, `act-41`, `act-47`, `act-48`) are `sleep` steps, the `sleep` results of retries, or the events and queue steps; they carry no `seal_finalize_scan` line.

Totals of the table: 34 scan executions, **2 642 s (44 min 02 s)**; typical full slice 75–80 s (mean 78.1 s over the 32 full ones); the final slice is 19 s. In-step work other than the scan sums to about 90 s. The 27 ordinary gaps (about 10–12 s, the step hand-off) sum to about 290 s. The six gaps above 100 s sum to **1 078 s (17 min 58 s)**.

| Part of `seal_finalize` wall time (4 102 s) | Seconds | Share |
| --- | --- | --- |
| `seal_finalize_scan` | 2 642 | 64 % |
| ordinary hand-off between steps | about 290 | 7 % |
| idle gaps above 100 s (failures and `busy` sleeps) | 1 078 | 26 % |
| other in-step work | about 90 | 2 % |

## 3. The same unit on neighbouring days

`seal_finalize_scan` `exit` lines, 16:00–20:00 UTC of each day:

| Day | Executions | Sum of scan time | Longest | First – last exit |
| --- | --- | --- | --- | --- |
| 14 Nov | 1 | 8 s | 8 s | 16:19:59 |
| 15 Nov | 1 | 3 s | 3 s | 16:08:27 |
| 16 Nov | 34 | 1 630 s (27 min) | 63 s | 16:09:48 – 19:15:26 |
| 17 Nov | 34 | 2 290 s (38 min) | 103 s | 17:08:35 – 17:55:05 |
| 18 Nov | 34 | 2 642 s (44 min) | 124 s | 16:28:43 – 17:34:52 |

The number of executions is the same on three days; the time per execution grows (average over the day 48, 67, 78 s). The 17 November log of the same unit also appears in the [AIR-522 evidence](air-522-workflow-internal-error-rca-2026-11-17.md) (about 68 s per scan).

## 4. The eight failed attempts of 18 November

| # | Instance / step | Attempt end (UTC) | What the application logged | Idle caused |
| --- | --- | --- | --- | --- |
| 1 | `epg_20261118_0` `act-2` | 16:08:49.491 (5 min 02 s attempt) | no `exit`, no `error`: killed inside the callback | 234 s lost, then 175 s `step_lease_held` sleep |
| 2 | `epg_20261118_0` `act-4` | 16:21:45.168 (10 min 02 s attempt) | `exit kind=handoff` at 16:17:16.976 | 268 s between callback return and the platform failure |
| 3 | `epg_20261118_1` `act-7` | 16:28:50 | `exit kind=continue` at 16:28:50.013 | about 0 s |
| 4 | `epg_20261118_1` `act-12` | 16:37:57 | `exit kind=continue` at 16:37:56.716 | about 0 s |
| 5 | `epg_20261118_1` `act-19` | 16:50:45 | `exit kind=continue` at 16:48:48.168 | 118 s (the 207 s gap before `act-21` includes a short retry `sleep` and a 70 s `sleep`) |
| 6 | `epg_20261118_1` `act-26` | 17:04:45 | `exit kind=continue` at 17:01:14.186 | 211 s (gap before `act-28`: 296 s) |
| 7 | `epg_20261118_1` `act-31` | 17:12:33 | `exit kind=continue` at 17:11:59.966 | 33 s (gap before `act-33`: 128 s) |
| 8 | `epg_20261118_1` `act-37` | 17:20:37 (attempt 1 declared failed after 36 s) | attempt 1's callback **kept running** and logged `exit kind=continue` at 17:21:32.630; attempt 2 entered 17:20:37.490 and returned `sleep` after 1.2 s | about 224 s until the next productive step (17:25:22) |

1. In six of the eight attempts (#2 to #7) the callback returned before the platform reported the failure. In #8 the platform ended the attempt 55 s before the callback returned. In #1 it never returned. No `error` edge exists on this day.
2. A returned callback had already committed its work (the control record and `sync.json` are written inside it). The retries of #3 to #7 processed **the next slice**, not the same one: the logs show a new `seal_finalize_scan` after each failure with the same duration as the others. A repeated slice was not observed. Only #1 repeated work (`seal_stage`).
3. The failures add up to about **25 min (1 503 s) of lost or idle time**: #1 234 s lost plus 175 s lease sleep = 409 s; #2 268 s; and the four finalize gaps of #5 to #8 net of the ordinary 10 s hand-off, 197 + 286 + 118 + 225 = 826 s (these gaps also contain the short retry `sleep` and the following `sleep` step). #3 and #4 add nothing measurable. Two more `busy` sleeps appear without a failed attempt before them (105 s gap before `act-17`, 107 s gap before `act-42`); their reason is not in the logs read.
4. Counterfactual, order of magnitude only: without the killed attempt (234 s), the lease sleep (175 s), the 268 s idle and the six gaps above 100 s (1 078 s, two of them not failure-related), 1 755 s (29 min 15 s) in total, the run would have taken about 66 min. The finalize scan alone is 44 min.

## Observed

- Section 1 to 4 and the D1 row: generation `cc26a2e7…` in `published_epg_generation` has `phase = published`, `created_at` 2026-11-18T16:25:34.735Z, `published_at` 2026-11-18T16:12:34.754Z (the scan time of the programme report, not a completion time); `published_epg_authority` points to the same run, generation 513. The moment the authority pointer switched is not stored separately; it lies between the row creation and the `seal_publish_pointer` exit 16:25:45.
- `epg_status` during finalize reports `seal.phase = finalize`, `ledgerPhase = done` and a constant `cursorItems = itemTotal = 20974`. It carries no progress of the finalize scan, so 68 minutes of work looked like a stalled `finalize`.

## Inferred

- Roughly 34 slices × up to 12 items ≈ 400 retention items per run, so ≈ 6 s per item. The queue length and cursor live in `run.ratedAdmissionScan` of `sync.json` (R2), which was **not** read; the 400 is an estimate from the execution count, not a count.
- The unit appears from 16 November on. That is consistent with the rated-admission writer route being open since the Film/Person and rated-admission activations (`ratedAdmissionWriterOpen` gates the slice loop in `persistScan`); the exact activation time of the route was not read.

## Not proven

- Why one slice takes 78 s (D1 round trips per retention unit, receipts, reconcile) and why it grew from 48 s to 78 s per execution between 16 and 18 November. D1 statement counts and per-statement latency for these steps were not read.
- The cause of `WorkflowInternalError`, and whether the 268 s, 211 s and 118 s idle times are the platform or a wait on our own step lease; the `sleep` reason of the retries is not logged.
- Whether clients saw the new programme from 16:25 (read path, `/api/programme`, not checked), and which moment the product treats as publication.
- A link to the deployment of AIR-508 (17:07:54 Madrid = 16:07:54 UTC) is not established; the first failure started at 16:03:47.

## Corrections to earlier AIR-420 card comments (18 November)

1. «нормальная работа без отказов по этим же шагам укладывается примерно в 10 минут»: wrong for this run; the failure-free path contains about 44 min of finalize scan.
2. «retry переделал шаг (87 с / 93 с)» for `act-7` and `act-12`: not what the logs show; the retry processed the next slice. The cost of #3 to #7 is idle time only.
3. «суммарное время упавших попыток ≈ 30 мин, включает работу, которую потом сделали заново»: only #1 repeated work; the lost and idle time of section 4 (about 25 min) replaces the figure.
4. «три из четырёх … после успешного `exit`» became six of eight (#2 to #7); #8 returned after the platform ended the attempt; #1 never returned.
5. «≈ 20 из первых 45 минут» was an idle-time estimate without the finalize scan as baseline; it is superseded by section 2.

## Follow-ups (cards not created here)

Listed in the AIR-420 card. They are separate atomic cards; none is implemented by this report. In order of measured weight: (1) the `finalize_scan` cost per run (batching or a larger unit cap, or moving it off the path to the completion stamp), (2) the publication clock: pointer move versus completion, (3) read-model progress of the finalize scan, (4) the 15-minute alert, (5) the `WorkflowInternalError` idle time and the retry lease wait, (6) a Cloudflare Support case with the new timestamps.

**Documentation impact:** evidence only (this file and its row in the [evidence registry](../README.md)); no runtime contract changed. [Orchestration reliability](../../reference/orchestration-reliability.md) and the monitoring runbook change only with a later implementation card.
