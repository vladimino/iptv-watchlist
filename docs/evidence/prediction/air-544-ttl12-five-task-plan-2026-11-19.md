# AIR-544 five-Task configuration: 12-minute lease, heartbeat wording and rollout plan

> Dated evidence, 19 November 2026 UTC. Not a runtime authority. It authorizes no Scheduled Task create, edit, enable, disable or run, no Worker deploy and no production write. **Merging the pull request that carries this file deploys the 12-minute TTL to production** (the deploy job runs after merge), so the merge is itself a gated step of the plan below.

[AIR-544](https://trello.com/c/w6lw3KYy) now targets five independent hourly Predictions v2 Tasks at `:00/:12/:24/:36/:48`, one shared runner lease with a **12-minute TTL**, `manifestSize=5` and the unchanged research-first prompt, replacing the rejected single extra Task at `:07` ([preflight](air-544-fifth-task-preflight-2026-11-19.md), historical). The owner's reasons: ChatGPT scheduler drift of about ±7 minutes and collisions already seen. This document covers the offline work: lease code audit, the minimal code change, the heartbeat wording, the rollout order and the 48 h experiment.

No production call was made for it. The only production figures cited are those already recorded in the [preflight](air-544-fifth-task-preflight-2026-11-19.md) and in the Controller's read-only Workers Logs readout on the Trello card (same 24 h window, 2026-11-18 22:14Z to 2026-11-19 22:14Z).

## Lease code audit (`src/enrichment.js`)

| Place | Behaviour | Effect of a shorter TTL |
| --- | --- | --- |
| `RUNNER_LEASE_TTL` | The only TTL constant for the runner lease. Every expiry is `now + RUNNER_LEASE_TTL`; no other literal (`15*60000` elsewhere belongs to unrelated clocks). | One-line change. |
| `runnerLease` acquire | Refuses (`already_running`) while `old.expiresAt > now`; otherwise takes over with `epoch + 1` by compare-and-swap (D1 row token). A lost swap re-reads; two concurrent starts yield one owner. | Unchanged logic; takeover possible 3 minutes earlier. |
| `runnerLease` renew / release | `lease_lost` when the lease is missing, held by another run or `expiresAt <= now`; epoch kept; up to 3 CAS attempts, then `busy`/`lease_lost` by the lease read afterwards. | Unchanged. |
| `runnerHeartbeat` | Renews through `runnerLease`; a lease of another epoch answers `lease_lost`. | Unchanged. |
| `batchGateSet/Renew/Clear` (submit) | Each sets `expiresAt = now + TTL` and a 60 s submit gate; the gate token fences a superseded handler. | A submit renews the lease; unchanged. |
| `batchHold` | Calls `runnerLease(...)` in renew mode. | A hold renews the lease; unchanged. |
| Interrupted detection (`leaseExpiredAt` rows, takeover path) | A run whose lease expired is marked `interrupted`/`lease_expired` and recoverable; the next acquire records `recoveredRunId`. | Unchanged; the reclaim happens after 12 minutes of silence instead of 15. |
| `liveLeaseAgeMs` log note | `now - (expiresAt - TTL)`, the time since the last renewal. | Derived from the constant; meaning unchanged. |
| Monitor, admin recovery readers | Read the lease document only; no TTL assumption found. | None. |

The lease is **renewed by every start, heartbeat, hold and submit**, so the TTL bounds the silence between two calls of one owner, not the length of a run. Ownership, epoch, compare-and-swap and idempotent per-film submit are not changed by this work.

## Code change

- `RUNNER_LEASE_TTL` from 15 to 12 minutes.
- Client instruction (runner contract `instructions`) and the `prediction_heartbeat` tool description: TTL 12 minutes, heartbeat at least every 5 minutes, and that start, hold and submit also renew.
- Tests: the TTL assertions and the frozen start baseline (`ttlMs`) follow the constant; the aged-holder fixtures keep the same 60 s age under the new TTL. `tests/lease-recovery.mjs` gains the boundary section: alive after 11 minutes of silence (a rival start is `already_running`, the owner's heartbeat restores a full 12 minutes and keeps the epoch); six rounds of 5-minute silence (30 simulated minutes) keep ownership; a submit after 11 minutes of silence succeeds and renews; after 12.5 minutes the owner's heartbeat is `409 lease_lost`, its late submit and a rival-film submit are fenced and write nothing, one start takes over with `epoch + 1`, and the film the owner had committed is not selected again. Elapsed time is simulated by moving the stored expiry; renewals, takeover and refusals run the real code on D1 stand-ins.
- Maintained contract docs that describe the Worker (`docs/reference/api/prediction-runner.md`, `docs/runbooks/prediction-operations.md`, the heartbeat line of `docs/architecture/prediction-pipeline.md`) state 12 minutes and 5 minutes. The installed-Task descriptions (`docs/reference/scheduled-tasks.md` and the canonical prompt snapshot) are **not** changed here: they describe the prompt that is installed, and change in the delivery that installs the new wording.

## Is 12 minutes safe? What is and is not proven

- **Margin.** With the installed wording (heartbeat at least every 10 minutes) a 12-minute TTL leaves 2 minutes for one uninterruptible step plus network, against 5 minutes today. That is why the TTL change alone is not safe. At a 5-minute cadence the margin is 7 minutes.
- **Observed step length.** In the 24 h window all 65 complete runs ended within 8.32 minutes of Worker wall (p50 4.05, p90 5.48), including research for five films, so even with no heartbeat they would have fit in 12 minutes. The earlier AIR-461 window recorded a 25.8-minute maximum, which must have been renewed along the way. One day is a small sample.
- **What cannot be observed.** `heartbeat` writes no timing log and the run keeps only the last `lastHeartbeatAt`, so the real heartbeat cadence of the Tasks is not measurable from D1 or Workers Logs. The proxies are the `lease_expired` share and the Worker wall distribution. An optional, separate change could log the gap since the previous renewal at each renewal; it is not part of this work and needs the owner's decision.
- **What a violation costs.** A run that is silent for 12 minutes loses the lease: its heartbeat and later submit are refused (`lease_lost`, fenced by epoch), uncommitted films stay in the queue and a later start takes over. No data is corrupted and nothing is committed twice (tests above); the cost is lost generation work of that run.
- **Expected benefit, not a forecast.** Of the 16 `already_running` refusals in the window, 11 were refused 15 to 35 seconds after a renewal (near-simultaneous starts) and 5 were refused 7.6 to 13.4 minutes after one; per the Controller's readout only 2 of the 16 would have crossed expiry under a 12-minute TTL. Most collisions come from start jitter, which a TTL cannot remove; equal spacing of five Tasks changes the arithmetic, and neither the TTL nor the spacing proves fewer collisions.

## Heartbeat wording (candidate, not installed)

The installed prompt (45 938 characters, 69 379 UTF-8 bytes, SHA-256 `ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520`) has one heartbeat sentence, in step 3. The candidate replaces exactly one phrase and nothing else:

```diff
-Держи lease живым: prediction_heartbeat({runId}) перед долгой генерацией и не реже, чем раз в 10 минут (TTL 15 минут);
+Держи lease живым: prediction_heartbeat({runId}) перед долгой генерацией и не реже, чем раз в 5 минут (TTL 12 минут);
```

Candidate: **45 937 characters, 69 378 UTF-8 bytes, SHA-256 `59208a479175bcb829ca979f69c3f7370e9abc3b545978f899efbb128e17b4e7`**. `tests/scheduled-task-prompt-v2.mjs` checks that the phrase occurs once and that applying it to the snapshot gives these figures. The same text must be installed on all five Tasks (the fifth is a copy of the new text). A period of 5 minutes was chosen inside the 5 to 6 minute range of the card: the Task already heartbeats before each long generation, and one film cycle takes about a minute at the observed run wall, so the rule only bounds the worst case. Whether the model obeys it cannot be proven offline.

## Rollout order (each step needs its own owner GO; none is granted here)

| Step | Operation | Readback | Reversal |
| --- | --- | --- | --- |
| 0 | Review this pull request; **do not merge** (merge deploys TTL 12) | CI green on the exact head | Close the PR |
| 1 | Edit the four Tasks: heartbeat wording only, TTL still 15 | Four independent readbacks equal the candidate hash; then a prompt-install delivery updates the snapshot and `scheduled-tasks.md`; observe natural runs for a period the owner sets | Restore the frozen installed text (snapshot at the base commit) |
| 2 | Merge and deploy the Worker with TTL 12 (Controller; `Test and build`, shards 2 and 3, `Deploy to Cloudflare`) | Read-only `enrichment_runner` shows `leaseTtlMs` 720000 and the new instruction; no start is run for the check | Revert PR and deploy (TTL back to 15; the faster heartbeat is harmless at 15) |
| 3 | Move the four schedules to `:00/:12/:24/:36` one at a time in the order `:15`→`:12`, `:30`→`:24`, `:45`→`:36`, then create the fifth at `:48` with the step-1 text | Registry readback after each edit: schedule, enabled state, prompt hash | Disable the fifth; restore `:15/:30/:45`; revert TTL by step 2's reversal if the owner decides |

No manual prediction or model run, no lease reset, no flag, queue or data write is part of any step. Whether a schedule edit can fire an extra run or skip an hour is not known and must be checked in the registry readback, not assumed.

## 48 h end-to-end experiment

It changes the Task count, the spacing and the TTL together, so it measures the configuration, not the effect of the fifth Task alone, and it proves no cause.

- **Baseline** (preflight and Controller readout, 24 h): 312 films = 13.0 per hour; 77 persisted runs of 96 nominal slots; 65 complete, 11 `lease_expired`, 1 `api_error`; 107 `batch_start` requests, 93 answered 200 and 14 answered 409 (not counted as lease collisions), 16 of the 200 answers with `leaseRefused=1`. A fresh 48 h baseline is taken after step 1 and before step 2, because the day-to-day swing (13.0 against 17.2 per hour) is as large as the expected gain.
- **Measured** (read-only): committed unique films per hour; the funnel nominal slots (240 against 192), actual Task starts, `batch_start` requests, 200 answers, `leaseRefused` (real `already_running`), other 409 (separate), persisted runs; complete, `interrupted`, `partial`; Task wall against Worker wall; full-text, partial-text and snippet counts (F/P/S) and the report sections; schema validity; platform messages.
- **Checkpoints** by the Controller named in the GO, at about 1, 3, 6, 12, 24, 36 and 48 h after step 3: D1 `SELECT` on `prediction_run`, the Workers Logs query used for the baseline, the saved Task reports and a registry listing, `prediction_queue_overview`; a dated note on the card at each. **No continuous monitoring and no automatic rollback exist**; exposure between checkpoints is up to 12 h; an unavailable observer means the configuration keeps running until a person acts, which the owner accepts in the GO or does not grant.
- **Proposed stop rules** (thresholds are owner decisions): any platform usage or limit message on any Task, then disable the fifth; `lease_expired` above 25 % of persisted runs in any 12 h (baseline 14.3 %); per-film failures above 7.4 % (twice the 3.7 % baseline); `leaseRefused` above 16 in any 12 h (twice the baseline rate); a research-quality failure (snippet-only where the Tasks read full text, missing F/P/S, invalid output); a new Worker error code; net committed films below 10 per hour over the first 24 h (about 23 % under baseline); the owner's stop.
- **After the window**: a dated report and the owner's decision to keep or roll back the configuration. 6 to 8 Tasks stay out of scope.

## Decisions and gates open for the owner

1. GO per step above, with the named Controller and checkpoint times.
2. Whether an ADR is wanted: the work changes two parameters (TTL, heartbeat cadence) of the accepted ownership design and no component responsibility, so it is classified as no architecture change; the owner may require a new ADR.
3. Whether a merge-time deploy is acceptable at step 2, or the TTL should first be made a configuration value so that merge and activation are separate operations (a larger change, not made here).
4. Whether to add the optional renewal-gap log line.
5. Open measurements: tier limit and usage are accepted from the owner (Plus, 5 active Tasks); the account-level Task limit was not read by any tool.

Documentation impact: this file and its index row; `docs/reference/api/prediction-runner.md`, `docs/runbooks/prediction-operations.md` and `docs/architecture/prediction-pipeline.md` for the 12-minute contract. `docs/reference/scheduled-tasks.md` and the prompt snapshot change only with an approved prompt install.
