# AIR-596: prediction no-progress verdict across a series of ownerless runs (offline, 24 November 2026)

**Scope.** Offline, deterministic replay of the AIR-588 pattern against the code of the AIR-596 pull request and against `main` at `79a36c5`. No production read or write, no Task, no model, no Cloudflare call. Decision record: [ADR 0210](../../adr/0210-prediction-no-progress-verdict-survives-live-runs.md) (Proposed).

**Test.** `tests/prediction-no-progress-series.mjs` (core suite). One in-memory bucket and an injected clock; runs and leases are written by the Worker's own `runnerLease` and `savePredictionRun` (run record, `latest-run.json`, diagnostic checkpoint), the Footer is the real route `GET /api/enrichment/footer/status`, the Monitor is `Monitor.run` with its real policy, outbox and a fake webhook.

## Scenario

- Last productive batch `ffae2f94` completes at 2026-11-23T20:28:21.539Z (21:28:21 Madrid): 5 created, 2 recalculated; the queue's `lastBatch` names it; 3171 hot and 3798 cold films stay outstanding.
- From 20:45Z a run starts every 15 minutes (:00/:15/:30/:45), takes the 12-minute lease and never submits or completes; every fourth slot a second Task is turned away with `already_running`. 57 runs up to 10:45Z.
- Monitor ticks at hh:00:23.490Z, a Footer read 30 s after each. At every tick a run younger than 60 minutes holds the lease.

## Results

| Tick (UTC) | `main` `79a36c5` Monitor / Footer | AIR-596 Monitor / Footer | Stored `progressAt` (AIR-596) |
| --- | --- | --- | --- |
| 21:00:23 | healthy / running | healthy / running (32 min, one abandoned run: nothing proven) | 20:28:21.539 |
| 22:00:23 | **healthy / running** (assertion fails here) | degraded / `prediction_no_recent_progress`, `lastSuccessAt` 20:28:21.539 | 20:28:21.539 |
| 23:00:23 to 10:00:23 | not reached | degraded / `prediction_no_recent_progress` at every tick, run line «выполняется» | 20:28:21.539 |

- Alerts (AIR-596): `alert` at 22:00:23, `reminder` at 04:00:23 and 10:00:23 (6-hour cooldown), no recovery. The reminder names the ownerless starts and that the lease holder is not progress; no ChatGPT-side cause.
- By then the last success is out of both bounded histories (Footer 8, Monitor 20 diagnostics); the clock comes from `queue.lastBatch` and the stored Monitor clock. With `lastBatch` removed (an older queue imported) both surfaces still show 20:28:21.539.
- A queue recount between ticks (new `refreshedAt`, `advancedAt`, moved `hotProcessedTotal`, unchanged `lastBatch`) moves nothing.
- An unreadable queue split during the open incident: stream `degraded`, `facts.stall` `unknown`, the issue held, no recovery.
- Recovery: a run commits 2 films and fails 1 at 12:24Z and is still working at 13:00:23: stream healthy, `progressAt` 12:24:00 (its first commit, not its start or its later lease expiry), exactly one recovery «progress is confirmed again (last confirmed progress 2026-11-24T12:24:00.000Z)».
- Other cases in the same file: recovery worded as «waits for its retry time» or «no prediction is eligible», never as progress; an absent queue holds the incident; a start, a heartbeat and a failed-only batch are not progress; an ordinary overlap with progress 25 minutes earlier stays `running`; a drained check in `lastBatch` dates progress, a retry-backoff wake-up does not; rollout over the persisted state of 24 Nov 11:00 Madrid keeps `firstSeenAt` 07:00:23Z and `sendCount` 1 and sends nothing inside the cooldown; real batch start, three submits and `complete(manifest_spent)` over the D1 stand-in with `prediction_aux_authority=d1`, then a new live run 90 minutes later: Footer and Monitor facts give `no_progress` with the completion time, and the reads write no D1 batch.

## Review fixtures (AIR-596 review of 24 Nov 2026)

- Unreadable lanes, no incident: Footer `unknown`/`no_data` with `lastSuccessAt` kept and the run line `running` (young live lease), also with an old success and with no history; Monitor `delayed`, no alert. An empty `pending` list without lanes is proven zero work: healthy on both.
- One observation basis: with no progress time the Footer measures from the Monitor's stored `unknownSince` (70 min: degraded, as the Monitor); without it, from its oldest attempt (42 min: unknown).
- An old productive run that expired without `firstSubmitAt` is dated by its start (70 min), not its projected end (58 min); the latest valid progress time wins over run order; a future time is ignored.
- Recovery with a progress time equal to the one the open incident knew is held (`progress_unconfirmed`, original `metricsAt`); a newer one recovers.
- A reminder due while the split is unreadable: «Сейчас: нельзя прочитать, сколько фильмов доступно к прогнозу; инцидент остаётся открытым», «было не меньше 2 ч (на последнем наблюдении 23.11 23:28)», no current counts; the alert entry keeps `firstSeenAt` and `metricsAt` of the alert. The genuine recovery then shows «Причина: прогресс снова подтверждён», the same last observation and «Длительность инцидента … 7 ч».

## Re-review fixture (24 Nov 2026)

- A commit at 12:59:55-equivalent lands while the lanes are unreadable: the held tick advances the stored clock to it but keeps the incident baseline (`metrics.lastProgressAt` = the pre-incident success). The next readable tick 59 minutes after the commit, with no second commit, recovers exactly once and the Footer is healthy; one alert, no extra reminder. With the baseline replaced by the stored clock the fixture fails. A legacy entry without typed metrics falls back to the previous clock: equal holds, newer recovers. Chained through `planAlerts`: a legacy entry held twice on an unreadable split stores only `{held}`, still falls back (equal holds, newer or proven zero recovers); without the fix the equal time recovered.

## Commands

- AIR-596 branch: `node tests/prediction-no-progress-series.mjs` → `prediction-no-progress-series: ok`; `npm test` → 534 of 534 core files passed.
- `main`: the same test file copied into a `git archive origin/main` tree → `AssertionError` at the 22:00:23.490Z tick, `"monitor":"healthy","reason":"active_run","footer":"running","success":null`.

## Limits

Offline replay of stored records, not a production measurement. It does not explain why the Tasks abandon their runs (AIR-588). The production readback after deploy is recorded on the card.
