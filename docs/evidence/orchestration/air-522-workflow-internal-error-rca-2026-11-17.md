# AIR-522: repeated EPG `WorkflowInternalError` after a returned callback, 17 November 2026

Read-only evidence (L0): Cloudflare Workflow `GET` of the `iptv-epg` instances and Workers Observability (`epg_act`, `epg_phase`, `epg_memory_boundary`, `epg_continuation`) queried through the Cloudflare API connector. Nothing was created, retried, terminated or written. All times UTC (Madrid = UTC+1 on this date). No payload, Film id or secret is reproduced. The exact deployed commit SHA was **not** read for this report; the Workflow version ids below are the identity that was observed.

## Observed

Four attempts of `act-N` steps ended `WorkflowInternalError: Attempt failed due to internal workflows error` on 17 November. Parent `epg_20261117_0` ran version `88456ba2`, child `epg_20261117_1` version `f7f32f43`; no instance changed version between attempts.

| # | Instance / step | Attempt (UTC) | Callback `epg_act exit` (UTC) | Platform attempt end / retry `enter` | Gap after callback return |
| --- | --- | --- | --- | --- | --- |
| 1 | `epg_20261117_0` `act-2-1` | 16:03:39.970 – 16:08:26.298 (286 s) | 16:08:25.656 (callback 285.6 s) | 16:08:26.298 / 16:08:26.342 | 0.64 s |
| 2 | `epg_20261117_1` `act-11-1` | 17:08:41.146 – 17:13:42.799 (302 s) | 17:10:01.698 (callback 80.5 s, `kind=continue`) | 17:13:42.799 / 17:13:42.840 | **221 s** |
| 3 | `epg_20261117_1` `act-15-1` | 17:19:02.682 – 17:20:23.822 (81 s) | 17:20:22.022 (callback 79.3 s) | 17:20:23.822 / 17:20:23.861 | 1.8 s |
| 4 | `epg_20261117_1` `act-23-1` | 17:31:00.684 – 17:32:21.943 (81 s) | 17:32:19.952 (callback 79.2 s) | 17:32:21.943 | 2.0 s |

1. In **every** failed attempt the callback had run to its end and logged `epg_act exit`; in #1 and #2 the `epg_phase` exits of the phase it drove (`seal_stage`, `seal_finalize`) and the closing `epg_continuation completed` line are present too. No `error` edge and no `enter` without an `exit` exists for any of the four. The platform ended the attempt after the callback returned: 0.6 to 2.0 s later in three cases, 221 s later in one.
2. The step output is a few bytes (`{"kind":"continue","reason":null}`), so an output-size limit is not plausible. Every step in both instances is configured `timeout: 10 minutes`, `retries: limit 5, delay 10 s, exponential`; the longest attempt was 302 s.
3. The failed attempt's work was durable before it returned (the control record and `sync.json` are committed inside the callback). The retry therefore continued from that state and did the next chunk; it did not repeat the lost chunk. Re-loading the staged payload on a retry costs about 0.35 s (`seal_payload_get` 17:13:48.261 to `seal_payload_parse` 17:13:48.612). The lost time of a post-return failure is the gap in the last column, not a repeated 80 s.
4. Baseline from the same Workflow history. 15 and 16 November: instances `epg_20261115_0/1` and `epg_20261116_0/1/2` have **no** failed attempt. 12 to 14 November: seven attempts failed with the explicit message `Worker exceeded memory limit`, lasting 2 to 43 s, always mid-callback (a different signature). 11 November: `epg_20261111_1` `act-10-1` failed once with the same `WorkflowInternalError` after 82 s, before the successor handoff of ADR 0144 existed.
5. Other Workflows on 17 November (`ratings_20261117_0`, the current Discovery instance, two Producer instances) show no failed attempt. These instances are short, so this does not show that the platform was healthy.
6. `epg_20261117_1` ran `seal_finalize` in 14 consecutive steps (`act-11` to `act-25`, still running at 17:36), each about 80 s with `seal_finalize_scan` about 68 s and `kind=continue`. Each failure above therefore hit a step that a natural run takes in large numbers; the cause of the long finalize scan is not analysed here ([AIR-420](https://trello.com/c/J0dit94i) owns publication latency).

## Inferred

- The failure boundary is the platform's persistence of the step result (or its checkpoint) after a callback that returned. This follows from item 1; it is the only boundary all four share.
- Failure #1 is the case [AIR-520](https://trello.com/c/AJEULl3k) fixes: its first attempt had already committed the D1 handoff claim, the retry ran `act` again and answered `not_owner`, and no successor was created. The platform error and the orphaned claim are two separate problems; this card does not change the claim logic.
- Failure #2 cost 221 s of publication time. Failures #3, #4 and #1 cost under 3 s each, apart from the AIR-520 consequence of #1.

## Unknown

- Why Cloudflare failed the attempts. No Worker log line, error text or metric on our side marks the failure, and the platform error carries no cause.
- Whether the 221 s gap in #2 is a platform hang, a lost acknowledgement or a queueing delay.
- Why the signature appeared four times on 17 November and not on 15 and 16 November (the 11 November occurrence shows it is not new). A platform incident or load effect cannot be confirmed or excluded from our data.
- Memory: `Worker exceeded memory limit` is a different, explicit error and is not seen here, and the callback completed, so memory is not the observed cause; it is not excluded for the platform's own bookkeeping.
- Timeout, terminate and version switch are excluded by the data above (all attempts under the 10-minute limit, the instances were not terminated, one version per instance).

## What this card delivers

No application-side fix of the platform error is claimed, because no application cause was found. Retrying is what the platform already does; it is not a fix.

- **Markers, no behaviour change.** `epg_act` lines now carry the platform's own `attempt` number (from the step context, only when it is a small integer), and a new `epg_act_stored` line is written after `step.do` returned, i.e. after the platform acknowledged the output. An `epg_act exit` with no `epg_act_stored` before the next `enter` of the same `act-N` is a returned callback whose attempt the platform failed, which is exactly the 17 November pattern; the two edges were not separable before. Tests: `tests/epg-orchestration.mjs` (7c2) reproduces a platform failure after a returned callback, asserts the exit-without-stored signature, the attempt numbers, that the retry starts no second run and that the result is unchanged.
- **Not reproducible offline.** The Workflow engine is not available to a local test; the stand-in reproduces the consequence (lost output after a returned callback), not the platform fault.

## Options that need an owner decision (not implemented)

1. Open a Cloudflare support case with the four attempts above (instance ids, versions, the callback-exit and attempt-end times). Recommended: it is the only route to the cause.
2. Shorter explicit `timeout` for the seal and finalize steps (for example 3 minutes) to cut a hang such as #2 from about 3.7 minutes. Trade-off: `seal_stage` legitimately ran 285 s, so a single value is wrong and the steps would need two classes; a too-short value kills healthy steps.
3. A smaller per-step budget for the finalize scan, which exceeds `SEAL_REQUEST_BUDGET_MS` (about 80 s against 32 s). Trade-off: more steps for the same work, each exposed to this boundary. Separate card (AIR-420 area).

## Post-fix acceptance (natural runs, read-only)

For each daily run, take the Workflow `GET` attempts (count, durations, error text) and the `epg_act` / `epg_act_stored` pairs per `act-N`. Record per failure whether it is a returned callback without a stored line, the gap, the publication time and the status. Do not treat a day without failures as proof of a fix. Multi-day SLA acceptance stays with AIR-420.
