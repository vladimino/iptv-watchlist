# Repeat platform failure and disable of the daily EPG Scheduled Task — RCA

- **Captured:** 1 November 2026. Worker reads at `2026-11-01T16:34:39Z` (`probe_read`) and a second `epg_status` in the same session. Europe/Madrid is UTC+1 on this date.
- **Card:** [AIR-322](https://trello.com/c/MBQEUdpO). Predecessor [AIR-292](https://trello.com/c/CTxq4Khy) stays the inconclusive record of the 30 October incident and is not rewritten.
- **Code inspected:** `main` at `359784e18c8f1ec419f4adda2021867c0bb243d4`. `DISCOVERY_CHUNK_BUDGET` is 12 (`src/discovery.js`).
- **Scope:** the daily task's platform `recorded_status=failed` on 30 October and 1 November, and the unattributed `is_enabled=false` after each. Worker success and platform failure are separate facts.
- **Evidence lifecycle:** dated read-only RCA. **Verdict: INCONCLUSIVE.** Not a fix, and not a guarantee that the next run stays enabled.
- **Used by:** AIR-322 owner decision (support draft, prompt change, independent alert). **Supersedes:** nothing. **Superseded by:** nothing.
- **Operational authority:** none. No Scheduled Task update, `run_now`, EPG, discovery, ratings or prediction writer, flag, Access, R2 or D1 change was made. The 1 November re-enable recorded below was already done by the coordinator, before this report, under a separate owner approval. It was not repeated.

## Sources and what this session could not read

| Source | What it is |
| --- | --- |
| AIR-322 card text | Coordinator's recorded platform fields for both runs, including task id, run ids, `recorded_status`, result flags, and the `is_enabled` read-backs. Not re-read from the registry here. |
| AIR-292 card text | 30 October Worker run id, watchlist count, and the owner's re-enable. Not re-investigated. |
| `probe_read`, `epg_status`, `epg_pipeline_status` | Read-only MCP, 1 November 2026, 16:34 UTC. Current Worker objects only. The continuation diagnostic ring keeps 20 entries, so 30 October's chunks are gone. |
| `src/discovery.js`, `docs/reference/scheduled-tasks.md`, `docs/reference/api/mcp.md` | The chunk budget and the daily/hourly handoff on the pinned `main`. |
| [openai/codex#38350](https://github.com/openai/codex/issues/38350) | Public issue. GitHub `created_at` `2026-08-13T10:51:52Z`, state open. The AIR-322 card says the issue was opened on 1 November; this read does not confirm that. |

This session has no Automations registry, no execution transcript, and no mutation audit. `Automations.peek`, as described on the card, does not name who set `is_enabled`. The Help article `https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt` returned HTTP 403 here, so its pause list was not copied. Nothing below invents an actor or a deadline.

## Timeline

Task `Automation_5d50308ce72c8191a50242fa604836b2`, expected daily at 17:00 Europe/Madrid. The hourly task is a different automation and was not reported disabled on 30 October.

### 30 October — platform fields from the cards, Worker chunks not retained

| UTC | Madrid | Fact | Source |
| --- | --- | --- | --- |
| 16:00:00 | 17:00 | Scheduled | AIR-292 |
| 16:02:44.843 | 17:02 | Platform run `f9046624-bdf0-832b-857b-9ab188c1489f` started | AIR-322 |
| 16:14:42.842 | 17:14 | Same run ended, `recorded_status=failed`. Wall time 11 min 58 s | AIR-322 |
| — | — | Worker EPG `08abd946-668b-4164-83f1-4826459003b4`, `stage=complete`, 396 watchlist, `failures=0` | AIR-292 / AIR-322 |
| unknown | unknown | `is_enabled=false` seen later. Actor and time absent | AIR-292 |
| 16:39:45.806869 | 17:39 | Owner re-enable read-back, `is_enabled=true`, schedule unchanged | AIR-292 |

### 1 November — platform fields from the card, Worker fields from this read

| UTC | Madrid | Fact |
| --- | --- | --- |
| 16:00:00 | 17:00 | `scheduled_for` of platform run `d3bd3648-2c40-8323-a806-e767927c8c83` |
| 15:59:10.653 | 16:59 | Platform run started. `chat_ref=null` |
| 15:59:50.649 | 16:59 | Continuation ring: one `entered` MCP call on `/api/sync/epg` for Worker run `b91305f4-b093-4622-ac25-d680ddcb18f1`. Its `completed` entry is no longer in the 20-entry ring |
| 16:00:27.491 | 17:00 | Checkpoint `paused` / `epg_committed` / `remainingChunks` 12, pinned to that run |
| 16:00:33.948 | 17:00 | `epg_status`: `stage=complete`, `remaining=0`, `failures=0`, `ratingsPending=false`, `enrichmentQueueError=null`. Still those values at both reads |
| 16:00:40–16:10:13 | 17:00–17:10 | Twelve discovery chunks, all HTTP 200, then `paused` / `chunk_budget` / `remainingChunks` 0. Table below |
| 16:10:13.741 | 17:10 | Checkpoint `nextCatchUpAt` `2026-11-01T17:00:00.000Z` (18:00 Madrid). `continuationHealth.status=settled`, lease null |
| 16:10:37.187 | 17:10 | Latest platform result created, about 8 s before the failed completion. Card: `is_failure_message=false`, `requires_user_action=false`; the text said the EPG/watchlist succeeded and that one MCP Internal error was recovered |
| 16:10:45.171 | 17:10 | Platform run completed, `recorded_status=failed`. Wall time 11 min 34.5 s. This is 31 s after the Worker checkpoint |
| 16:11:48.683 | 17:11 | Card: `is_enabled=false`, `updated_at` this instant. Actor unknown |
| 16:24:54.283 | 17:24 | Card: coordinator `Automations.update(is_enabled=true)` under owner approval; a later peek read `true`. Prompt and 17:00 schedule unchanged. Not repeated here |
| 16:34:39 | 17:34 | This session's read. Same Worker run, still `complete`. Continuation still the 16:10 checkpoint. No newer EPG run |

The card also records, for this publication: 268 films with showings / 1,018 showings; watchlist 397, membership unchanged; the owner checked Letterboxd and the new films had arrived in the 31 October sync. Those counts were not re-read here (`GET /api/events` can write). `epg_pipeline_status` at 16:34 UTC still shows `programmeRunId` `b91305f4-b093-4622-ac25-d680ddcb18f1`, `queuedForPrediction` 14, and the same settled `chunk_budget` checkpoint. Discovery did not finish the backlog: `currentUnresolved` 16,402. That is the normal budget stop, not an EPG failure.

## Twelve chunks after a finished commit

The ring's twelve `completed` entries for `b91305f4-…` are one series. Each is `caller=mcp`, `route=/api/sync/epg`, `runStage=complete`, `httpStatus=200`, `error=null`, `leaseReleased=true`. `remainingChunks` goes 12 → 0. The first entry's prior checkpoint is `reason=epg_committed`. The last saved checkpoint is `reason=chunk_budget`.

| Saved at (UTC) | After | `durationMs` | Checked | Added |
| --- | --- | --- | --- | --- |
| 16:01:16.818 | 11 | 66,876 | 183 | 2 |
| 16:02:25.041 | 10 | 42,490 | 4 | 2 |
| 16:03:12.852 | 9 | 44,118 | 4 | 3 |
| 16:04:04.274 | 8 | 50,816 | 3 | 2 |
| 16:04:52.824 | 7 | 48,196 | 4 | 2 |
| 16:05:40.014 | 6 | 42,560 | 4 | 2 |
| 16:06:26.078 | 5 | 41,753 | 3 | 3 |
| 16:07:06.388 | 4 | 41,138 | 4 | 2 |
| 16:07:51.309 | 3 | 40,376 | 3 | 3 |
| 16:08:30.998 | 2 | 45,174 | 6 | 1 |
| 16:09:25.770 | 1 | 49,475 | 4 | 2 |
| 16:10:13.741 | 0 | 43,611 | 4 | 3 |

Worker time inside those twelve calls: 556.6 s (9 min 17 s). Wall time from the `epg_committed` checkpoint to the budget checkpoint: 586 s (9 min 46 s). Time from the platform start to `epg_status.updatedAt`: 83 s. The publication was done in about a minute and a half. The chunks are almost all of the 11 min 35 s platform run. Later chunks still take about 40–50 s when they check only 3–6 candidates, so the cost is per call, not only the first scan of 183.

No `exceededMemory`, no `ratingsPending`, and no failed chunk appear in this ring. The recovered MCP Internal error named in the platform result is not one of these twelve errors. It is not in the retained ring. It is not evidence that the Worker failed the commit.

The same ring still holds the tail of an earlier series, programme run `f22228c5-29b9-48e6-9e46-2488e92c2e4a`: seven `completed` chunks from 15:23:40Z to a `chunk_budget` checkpoint at 15:30:06.778Z (`nextCatchUpAt` 16:00:00Z), also HTTP 200, about 50–60 s each. Earlier chunks of that series have rotated out, so its length is unknown. The caller is only `mcp`. The clock matches the 16:20 Madrid hourly trigger (15:20 UTC) plus a few minutes, which is consistent with Stage A and not proof of which automation it was. That tail shows another invocation the same day also spending many minutes on sequential chunks. Its platform `recorded_status` is unknown, so it is not a counterexample that a ~12 minute run succeeds.

## What is known, separately

1. **Worker EPG succeeded both days.** 1 November is re-read: `stage=complete`, `failures=0`, publication timestamp 16:00:33.948Z, discovery left `settled` on `chunk_budget`. 30 October is the card's Worker run `08abd946-…`, not re-read.
2. **The platform recorded `failed` after that success.** On 1 November the success-shaped result (`is_failure_message=false`) was stored 24 s after the Worker checkpoint and 8 s before `recorded_status=failed`. The model had already written a non-failure result. This session cannot see the termination reason.
3. **`is_enabled` then became false, actor unknown.** 1 November: 63 s after the failed completion (`updated_at` 16:11:48.683Z). 30 October: the time is unknown. Re-enable worked both times and did not change the prompt or the 17:00 recurrence. `next_run_time=null` is not, by the contract, proof that the schedule is gone.
4. **The two symptoms are not one finding.** A failed recording does not by itself explain a later disable, and a disable after a successful run is what public issue 38350 describes. That issue is open, intermittent, and not identified as this task. It is a similar report, not this root cause. The issue's `created_at` is 13 August 2026, not 1 November.

## Hypotheses

| Hypothesis | For | Against | Unknown | Safe test |
| --- | --- | --- | --- | --- |
| Execution budget near 12 minutes | Both platform runs end at 11 min 35 s and 11 min 58 s. On 1 November the Worker was already idle on `chunk_budget` 31 s before the failed completion, and the result text was not a failure. Twelve ~40–67 s chunk calls account for 9 min 17 s of that run | No documented deadline was readable here. No successful daily run of a known duration was available to compare. The earlier same-day chunk tail is not a known platform success or failure | Whether any limit exists, and whether it sets `recorded_status` after the assistant has already saved a result | Owner-approved prompt that returns after the commit, then two ordinary daily cycles. Not an artificial failure, and not done in this report |
| The twelve-chunk tail is why the run is that long | Measured: 83 s to `stage=complete`, then 9 min 46 s of chunks. Code opens the series at 12 and the daily contract follows `nextAction=continue` until `wait` | The budget explains duration. It does not by itself explain `recorded_status` or `is_enabled` | Whether a run that stopped at the commit would have been recorded successful | The same two-cycle observation |
| Recovered MCP Internal error | The result text, per the card, mentioned one | All twelve retained chunks are HTTP 200 with `error=null`. The commit's `completed` diagnostic has rotated out, so that call's error is not visible. A recovered transport error is not a Worker `failures` count | Which call it was | None on production. Do not provoke one |
| Post-result platform termination | Result saved, then `failed` 8 s later, then disable 63 s later | The order fits a platform action after the assistant finished. It does not identify the action | Termination reason, model tool list, deadline | Support audit, draft below. Not sent |
| Implicit pause: the prompt's `stop` / `wait`, or a silent end, was applied to the task | Issue 38350 warns that "exit silently" must not pause the automation | The Worker answer was a normal `wait` for `chunk_budget`, which the contract already tells the caller to honor until `nextCatchUpAt`. The daily prompt is not in this repo and was not re-read. The card says the prompt was not changed by the re-enable | Whether this prompt contains a phrase the platform treats as a task mutation | Registry read of the prompt, separately authorized. No edit |
| Cloudflare OOM, quota, or an archived chat | Historical Diary OOM is [AIR-263](https://trello.com/c/uNoGwtid) / the 30 October profile. `chat_ref=null` on 1 November | This ring has no memory kill. `ratingsPending=false`. `failures=0`. Quota is not a field on these reads | 30 October's chunks. Whether `chat_ref=null` means anything | Do not replay. Support can see the run |
| Product pause policy from the Help article | The card says the article lists pause reasons and does not audit the actor | Article body not retrieved (HTTP 403) | Which listed reason, if any, matches | Support, not a guess |
| Issue 38350 is this defect | Open report of recurring tasks flipping to disabled after runs, including successful ones, without a user request; other tasks can stay enabled. Matches the unattributed disable and the 30 October note that the hourly task stayed enabled | The issue does not document `recorded_status=failed`, a ~12 minute boundary, or these run ids. Our failed recording and the disable still need separate explanations | Whether OpenAI considers this the same bug | Ask in the draft. Do not comment on the public issue |

No hypothesis above is promoted to a cause.

## Duration mitigation, not applied

`queueDiscovery` writes `paused` / `epg_committed` / `remainingChunks` 12 / no `nextCatchUpAt` for the published generation, and the contract's `nextAction` is `continue`. The daily task's contract then calls `epg_sync_step` once per chunk until `wait` or `stop`. The twelfth chunk stores `chunk_budget`, `remainingChunks` 0, and `nextCatchUpAt` at the next whole UTC hour. That is exactly the 1 November checkpoint. The hourly task may take the next series only after that gate, with `epg_status.stage=complete` and a settled health record (the due `chunk_budget` renewal in the [Scheduled Task contract](../reference/scheduled-tasks.md)). It must not step while `stage` is still `epg`.

If the daily prompt returned after the commit read-back and did not take those twelve steps:

- The checkpoint would stay `paused` / `epg_committed` / `remainingChunks` 12 / `nextAction=continue`, with no live lease (`queueDiscovery` does not hold the resolver lease; each finished chunk in this ring released its lease).
- The hourly Stage A contract would be allowed to continue that series on the next `:20` trigger, because `stage=complete` and `remainingChunks` is positive. It would not need the hour gate. On 1 November that would have been the 17:20 Madrid trigger (16:20 UTC), about 20 minutes after the commit, instead of the chunks running inside the 16:59–17:10 Madrid daily invocation.
- A kill during a chunk can leave `running` until the lease expires. The hourly orphan rule is fail-closed and can answer `stop`. A shorter daily invocation reduces that window. It does not remove it.
- An incomplete commit (`stage=epg`) must still be finished by the daily task. The hourly task must not adopt it. The proposal does not skip publication or the final `epg_status` read.

Moving all twelve chunks onto the hourly invocation does **not** shrink platform time. It moves about ten minutes onto the automation that also runs predictions. The same-day tail already shows an invocation spending many minutes on chunks. If a ~12 minute recording is what marks `failed` and is followed by a disable, the hourly task would be the worse place to absorb it: a disabled hourly task stops both catch-up and predictions, while a disabled daily task at least leaves today's programme published.

A per-invocation cap (daily: commit and read-back only; hourly: one or two chunks, then Stage B, leaving `remainingChunks` > 0 and `nextAction=continue`) keeps each run far below the observed 11–12 minutes. Leftover chunks wait for later hours, so newly published films are recognized more slowly. Twelve chunks at one or two per hour is several hours, not twenty minutes. Lowering `DISCOVERY_CHUNK_BUDGET` in the Worker would change every caller and still pause on the hour gate; that is a broader code change and is not proposed here.

Either prompt change is a contract change. It needs its own owner approval, a docs update of `docs/reference/scheduled-tasks.md` and the drift runbook, and a later observation of two ordinary cycles: enabled before and after, `recorded_status`, Worker `stage` and `updatedAt`, duration, and the warnings. Rollback is restoring the previous prompt, which is itself a task edit and needs approval. **No prompt was edited for this report.**

## Drift monitor

The contract on this `main` expects `IPTV Scheduled Task Drift` (`6ade65245de481919b816c5f5026c121`) daily at 18:15 Europe/Madrid, read-only, notifying on a disabled task and on a failed latest run. The 30 October evidence file recorded 17:45 Europe/Madrid. This session did not read the registry, so the live time is unverified. Whichever of those times is live, it is after 17:00.

At the 16:34 UTC read (17:34 Madrid) the nominal 18:15 Madrid run had not started. This report cannot say whether it notified. The disable was already visible to the coordinator at 17:11 Madrid, and the task was re-enabled at 17:24 Madrid, both before 18:15. A working monitor can still report a failed latest run after re-enable, because the contract treats a failed last run as an anomaly even when the task is enabled again. That is a warning before the next day's 17:00 EPG, not prevention of the failed recording, and not a substitute for the registry audit. The monitor runs on the same platform and can itself fail or be disabled, so silence does not mean the daily task is healthy. A second watchdog was not created.

The Worker cannot see `is_enabled`. An alert that does not depend on ChatGPT Scheduled Tasks has to live somewhere else and needs its own owner approval. None is proposed as part of this RCA.

## Support draft — not sent

Do not post this to the public issue and do not send it until the owner says so.

```
Subject: Scheduled Task recorded failed and then disabled after a completed run

Please check execution termination and the enabled-state audit for one recurring
ChatGPT Scheduled Task. I did not ask for it to be paused.

Task: Automation_5d50308ce72c8191a50242fa604836b2
Expected schedule: daily 17:00 Europe/Madrid. Prompt and recurrence were not
changed by the re-enables below.

Run 1
- id: f9046624-bdf0-832b-857b-9ab188c1489f
- scheduled: 2026-10-30T16:00:00Z
- started: 2026-10-30T16:02:44.843Z
- ended: 2026-10-30T16:14:42.842Z
- recorded_status: failed
- Our worker run 08abd946-668b-4164-83f1-4826459003b4 completed with failures=0.
- is_enabled was later false. Actor and time were not in Automations.peek.
- Re-enabled by the account owner. Read-back updated_at 2026-10-30T16:39:45.806869Z.

Run 2
- id: d3bd3648-2c40-8323-a806-e767927c8c83
- scheduled_for: 2026-11-01T16:00:00Z
- started: 2026-11-01T15:59:10.653108Z
- completed: 2026-11-01T16:10:45.171635Z
- recorded_status: failed
- chat_ref: null
- Latest result created 2026-11-01T16:10:37.187821Z, is_failure_message=false,
  requires_user_action=false. The result text described a successful programme
  update and one recovered MCP Internal error.
- Our worker run b91305f4-b093-4622-ac25-d680ddcb18f1 was stage=complete at
  2026-11-01T16:00:33.948Z, failures=0. Twelve later discovery steps all
  returned HTTP 200. The last checkpoint, 2026-11-01T16:10:13.741Z, is
  paused/chunk_budget, remainingChunks=0, settled.
- is_enabled=false, updated_at 2026-11-01T16:11:48.683279Z. Actor unknown.
- Re-enabled with an explicit update. Independent peek updated_at
  2026-11-01T16:24:54.283420Z, is_enabled=true. Schedule and prompt unchanged.

Please tell us:
1. Why recorded_status is failed when the stored result is not a failure message.
2. The audit event that set is_enabled=false: who or what, why, and the exact time,
   for both incidents.
3. Whether a deadline, model/tool error, or post-result termination applied,
   and the timestamps.
4. Whether this is the same defect as https://github.com/openai/codex/issues/38350
   (open; recurring tasks disabling themselves after runs).

I am not asking you to change the schedule.
```

## Owner decision still open

This report does not choose. Closing AIR-322 as fixed would be wrong. It can close later as inconclusive once the owner picks:

1. **Support.** Send the draft, or hold it. Not sent.
2. **Daily prompt.** Leave it, or approve a follow-up card that stops the daily task after the commit read-back and caps hourly Stage A at one or two chunks before predictions. Moving all twelve chunks onto one hourly run is the option this evidence argues against. No edit now.
3. **Independent monitoring.** Keep the existing drift task only, or approve a separate non-ChatGPT alert. No second task was created.

Until one of those is approved, the accepted risk is a repeat: the next 17:00 Madrid run can again spend ~10 minutes on twelve chunks, be recorded `failed` after a successful Worker commit, and come back disabled, with no actor in `Automations.peek`. The 2 November 17:00 Madrid run is the next ordinary observation. This report does not claim it will stay enabled.
