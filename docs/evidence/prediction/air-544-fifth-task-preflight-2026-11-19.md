# AIR-544 fifth hourly Predictions Task: read-only preflight and PoC plan

> Dated evidence, 19 November 2026 UTC. Not a runtime authority. It authorizes no Scheduled Task create, edit, enable, disable or run.

[AIR-544](https://trello.com/c/w6lw3KYy) prepares a controlled proof of concept (PoC) of **one** additional independent hourly ChatGPT Scheduled Task running the unchanged research-first batch v2 prompt (`manifestSize=5`). Context: [AIR-461](https://trello.com/c/a9TdXgNM). Batch sizes above five are out of scope ([AIR-450](https://trello.com/c/VPd21Y9d), [AIR-473](https://trello.com/c/b9oTfOpI)); the four current Tasks (`:00/:15/:30/:45`) are not changed.

## Scope and method

Everything below was read from production **without any write**: Worker MCP `prediction_queue_overview` and `feature_flags` (both read-only by contract), and `SELECT` statements on D1 `iptv` table `prediction_run` (every query reported `changed_db=false`, `rows_written=0`). No Task, model, API, flag, lease or queue operation was performed. Window: runs with `createdAt` in `2026-11-18T22:14Z` to `2026-11-19T22:14Z` (24 h), `protocol=batch_v2`. D1 measures Worker time between `start` and `complete`, not the ChatGPT Task wall time.

## Read-only baseline (24 h)

| Metric | Value |
| --- | --- |
| Persisted batch v2 runs | 77 of 96 nominal slots (80.2 %) |
| `complete` / `manifest_spent` | 65 |
| `interrupted` / `lease_expired` | 11 (14.3 % of runs) |
| `partial` / `api_error` | 1 |
| Films created | **312 = 13.0 per hour** (4.8 per complete run) |
| Per-film failures | 12 of 324 outcomes (3.7 %) |
| Worker run wall, complete runs | min 1.84, p50 4.05, **p90 5.48**, max 8.32 min |
| Queue now | 6 922 pending (3 758 hot and eligible now, 1 deferred by retry), coverage 40.2 % |
| Flags | no prediction-related flag set; `MONITOR=on`, `MONITOR_TRANSPORT=telegram` |

Findings that change how the PoC must be judged:

1. **The baseline moved by 4.2 per hour in one day.** The 18 November reading in AIR-461 was 17.2 per hour (421 films, 24.52 h); the next 24 h gave 13.0. The windows differ and the cause is not established (candidate confounders: the longer scoring prompt installed on 18 November, Task-side interruptions, Discovery load). The observed end-to-end yield is 312 films / (4 Tasks × 24 h) = **3.25 committed films per nominal Task-hour**, which is the initial point estimate of a fifth Task's marginal gain *before* any added contention. The theoretical ceiling is 5 films per hour (one full manifest per slot), an upper bound only; 312 / 65 = 4.8 is a per-complete-run average, not a per-slot yield. Either figure is **of the same size as that day-to-day swing** (4.2 per hour in total, about 1 per Task-hour). A before/after total cannot prove the gain; the plan below uses the fifth Task's own yield and the effect on the other four as primary evidence.
2. **11 runs ended `lease_expired`.** The runner lease is 15 minutes but is renewed by every heartbeat, checkpoint and submit ([runner contract](../../reference/api/prediction-runner.md)), so `lease_expired` means that no renewal arrived for 15 minutes before the next start reclaimed the lease. It is **not** a measure of how long the lease was held or of how many slots were blocked, and no lease-held time or contention share is derived here. The stored `completedAt` of these runs is the reclaim instant (the next run starts about 3 s later), so their 15 to 44 min durations include time after the last renewal. Two pairs were consecutive (22:56 and 23:19 on 18 November; 19:43 and 20:28 on 19 November). The Worker answers a start while a live lease exists with `already_running`, which writes no run; the 19 slots with no persisted run may include such answers, but D1 cannot tell them from a Task that did not fire, a usage error or a no-op. **Real collision counts are unknown** until `already_running` is read from authorized Worker logs. The 11 runs left their manifests (up to 55 films, an upper bound, not a measurement) uncommitted in that period; the cause is not visible in D1 and is not claimed here.
3. The queue is not the limit: at 13 per hour 3 758 hot films last about 290 h, far beyond a 48 h measurement.
4. Gap arithmetic: run starts already spread over a few minutes around each slot. A fifth slot at `:07` leaves gaps 7, 8, 15, 15, 15 min against the p90 Worker wall of 5.5 min; an equal spread (about 12 min) needs editing the four existing Tasks and is out of scope.

## Not verifiable from this session

No tool in this session reads the ChatGPT Scheduled Task registry or usage allowance. **Supplemental, reported by the independent reviewer** (read-only registry listing on 19 November 2026; not independently repeated here): all four Predictions v2 Tasks are enabled with `exact_schedule` hourly at `:00/:15/:30/:45` in `Europe/Madrid`. That listing does not establish the saved prompt bytes or the account cap. These items still need an authorized read-only readback by the Controller or owner **before** a GO is requested, and are not claimed as verified:

- the exact saved prompt of the four Tasks against the canonical prompt (45 938 characters, 69 379 UTF-8 bytes, SHA-256 `ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520`);
- the plan tier and active-Task cap (the AIR-461 note lists Plus 5, Business/Edu 10, Pro/Enterprise 15; the account tier is unknown) and remaining usage allowance, read without any test creation;
- Task/model usage errors and the saved-report F/P/S baseline (full text, partial text, snippet) of recent natural runs, which live in the Task reports, not in D1;
- `already_running` counts (Worker logs through an approved read path).

## Proposed experiment (for owner decision; nothing is started)

1. **Change:** create one hourly `exact_schedule` Task, `Europe/Madrid`, offset `:07` (alternative `:08`), titled `IPTV Predictions v2 07`, with the exact current canonical prompt (byte-identical, readback SHA-256 above). Server side stays `manifestSize=5`, one shared lease, epoch and compare-and-swap. No edit of the four Tasks; no manual model or Worker run; no retry or lease reset.
2. **Pre-GO conditions:** the registry and usage readbacks above show a free slot under the tier cap and the four Tasks unchanged; a fresh 24 h baseline snapshot taken in the same hour as the GO.
3. **Duration:** 48 h of natural ticks (about 48 slots of the fifth Task).
   a. **Observation path.** The Controller role (a named person or agent, to be stated in the GO) runs read-only checkpoints at about 1 h, 3 h, 6 h, 12 h, 24 h, 36 h and 48 h after creation: D1 `SELECT` on `prediction_run`, `prediction_queue_overview`, the saved reports of the fifth Task and of the four, and Worker logs for `already_running` where an approved read path exists. Each checkpoint checks the stop rules of item 6 and writes a short dated note to the Trello card. **There is no continuous monitoring and no automatic rollback**; the plan configures no alert for Task-side usage or quota messages. Exposure between checkpoints is therefore up to 12 h. If the observer is unavailable at a checkpoint, the owner is told, and the fifth Task keeps running until a person disables it; the owner accepts that exposure (consumption of the shared usage allowance and extra lease contention, no data corruption path) in the GO or does not grant it.
   b. **Operations covered by a future GO.** The GO must name both the creation and the contingent disable of the fifth Task, the observer, and the checkpoint times; a disable by the observer then needs no second approval.
4. **Measurements** (Controller, read-only): per Task slot: run persisted or not, status, films created and failed, Task wall from the saved report against Worker wall; across all five: runs per day, `interrupted` share, `already_running` count, `partial/api_error`; quality of the fifth Task's reports against the same rubric as the four: full-text review reading counted as F/P/S (not snippets), at most two searches per film, traceable author and URL, execution finding beyond the synopsis, valid `assessment`, report sections *Итог → Прогнозы → Ошибки → Очередь → Исследование*.
5. **Primary evidence:** the fifth Task's own persisted-run share and films created per slot, plus no degradation of the four (interrupted share, `already_running`, per-film failure share). Total films per hour before/after is reported as secondary because of finding 1; no conclusion from the nominal 25 per hour.
6. **Proposed stop rules** (thresholds are owner decisions): disable the fifth Task when a checkpoint (item 3a) finds any platform usage or quota message on any of the five Tasks; on a research-quality failure in the fifth Task's report (snippet-only research where the four read full text, missing F/P/S, invalid output); on interrupted share above 25 % of started runs over 24 h (baseline 14.3 %); on a per-film failure share above 7.4 % (twice the baseline); on a new Worker error code; or when the owner says stop.
7. **Rollback:** disable the fifth Task (the stop action is requested in the same GO so that it is not blocked by a second approval); stored predictions stay valid, the lease expires by itself, and no lease reset, queue reset or data revert is needed. Deleting the Task is a separate decision. The four Tasks are untouched at every point.
8. **After the window:** a dated evidence report with the comparison and an owner decision to keep, move or remove the fifth Task. Scaling to 6–8 Tasks is out of scope. `docs/reference/scheduled-tasks.md` and `docs/runbooks/prediction-operations.md` change only if the owner approves a runtime rollout.

## Verdict

**Preflight plan ready; no execution.** Baseline recorded; the owner GO, the registry/usage readbacks and the numeric stop thresholds are open. Recommendation: the PoC is worth running only after the readbacks, and the owner may reasonably first ask for a separate investigation of the 11 interrupted runs, since the films left uncommitted by them (an upper bound of about 2.3 per hour) are of the same order as the fifth Task's point estimate of 3.25 per hour, and a fifth Task may add lease contention that is not yet measured.

Limits: one 24 h window; D1 sees no Task wall time, `already_running` or usage errors; the run document does not store which Task started it, so per-Task attribution relies on the saved reports.

Documentation impact for this card: this evidence file and its index row only.
