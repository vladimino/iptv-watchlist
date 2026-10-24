# AIR-82 prediction queue RCA

[AIR-82](https://trello.com/c/Oa33pTQK) investigates five prediction films and the difference between a finished run, an empty eligible set, and outstanding pending work. [AIR-98](https://trello.com/c/JQEa1aK7) supplied the read-only MCP view used for the 24 October 2026 baseline. [AIR-88](reference/api/run-diagnostics.md) records step chronology and caller-reported faults. It does not change the queue result below. This change does not alter retry policy, queue completion, generation, validation, or Scheduled Tasks.

## Confirmed state on 24 October 2026

Read-only `prediction_queue_overview` and `prediction_film_diagnostics` at `2026-10-24T09:06:33.620Z` (11:06 GMT+2, same clock as Europe/Madrid):

| Film | Fingerprint | Prediction | Profile | Index | Queue | Retry |
| --- | --- | --- | --- | --- | --- | --- |
| `tmdb_617505` | current | current | match | agreed | not in queue | `not_recorded` |
| `tmdb_25539` | current | current | match | agreed | not in queue | `not_recorded` |
| `tmdb_28512` | current | current | match | agreed | not in queue | `not_recorded` |
| `tmdb_2193` | current | current | match | agreed | not in queue | `not_recorded` |
| `tmdb_927107` | current | current | match | agreed | not in queue | `not_recorded` |

The queue was `drained`: pending, hot, cold, eligible, and deferred were all 0. Coverage was 2260/2260 and 1812/1812, so both percents are exactly 100. All five films are resolved in that snapshot. Their recovery does not show that the earlier completion bug is gone.

`refreshPredictionQueue` keeps `retries` only for films that are still missing a current prediction. Once a film becomes current, its kind, attempts, `failedAt`, `retryAt`, and `lastRunId` are dropped. The `not_recorded` result is therefore expected after recovery. It is not evidence that no retry ever existed.

## Confirmed history, without a per-film cause

These observations come from earlier read-only status and Events. None of them names the five film ids, so they are not attributed to a particular film.

- The five films entered the catalogue around 22 October 2026 23:53–23:57 UTC (23 October 01:53–01:57 GMT+2).
- 23 October 04:57 UTC (06:57 GMT+2), run `ac7415fe-…`: 2 successes and 6 failures.
- 23 October 05:58 UTC (07:58 GMT+2): `retry_backoff`.
- 23 October 07:03 UTC (09:03 GMT+2), run `afdec3d6-…`: 1 success, 0 failures, 5 hot pending, stop `queue_empty`.
- 23 October 22:00–22:05 UTC (24 October 00:00–00:05 GMT+2), run `f966ad39-08c8-412c-9d54-3397d1554332`: five failures and `format_error_storm`. Later starts were blocked by `retry_backoff`.
- 24 October 02:04–02:09 UTC (04:04–04:09 GMT+2), run `c9119c13-4642-47ed-96ec-7db9c82b44fc`: added 2, failed 3, `hotRemaining` 4, `eligible_queue_empty`.
- 24 October 06:01–06:03 UTC (08:01–08:03 GMT+2), run `bafee3ee-e9e4-48e1-80f4-577a32aa4b70`: added 1, failed 0, `selectedCount` 1, `batchSize` 3, `hotRemaining` 3, status completed, `stopReason` `queue_empty`. The Events text said the queue was fully processed.
- Around 24 October 06:30 UTC (08:30 GMT+2): coverage 2257/2260 and 1829/1832, `pendingCount` 3. Both percents displayed as 100.
- 24 October 09:06 UTC: the five films and the whole queue were current.

Classification for each of the five films: resolved in the 09:06 snapshot; the original per-film failure kind is **insufficient evidence**. The shared queue mechanism below is confirmed.

## Confirmed code path

`refreshPredictionQueue` rebuilds `hotPending` and `coldPending` from films whose indexed prediction is not current, then copies forward retries only for those ids.

`queueReadyIds` uses hot ids while `priorityCount` is non-zero, and drops any id whose numeric `retries[id].retryAt` is still in the future. Outstanding pending and eligible work are different sets. Cold films also wait while any hot film remains, including one that is only in backoff.

`enrichmentNext` asks `queueReadyIds` again. An empty ready set with `priorityCount + coldRemaining > 0` returns `eligible_queue_empty`. An empty ready set with no outstanding remainder returns `queue_empty`. A start that finds the same non-empty but not-ready queue returns `retry_backoff` instead. Those three reasons are different observations, not three names for one state.

`enrichmentSubmit` stores an item failure as `parse_error` even when the caller reported `validation_error`. The validator text is not kept. Five consecutive item format failures set `format_error_storm`. A saved retry therefore cannot show which schema check failed. That is a confirmed reporting limit. It is not proof that these five films were the five `format_error_storm` failures.

`enrichmentComplete` then discards a caller reason of `queue_empty`, `eligible_queue_empty`, or `parse_error`. If the films selected for this run have no saved failure and no still-pending selection, it writes `stopReason=queue_empty` and `status=complete`. Only after that does it refresh the queue and copy `hotRemaining` onto the event. A non-zero remainder does not change `stopReason`. `lastBatch.reason` keeps the cleared `run.reason`, so it can be null while the event `stopReason` is `queue_empty`.

That matches run `bafee3ee-e9e4-48e1-80f4-577a32aa4b70`: one eligible film was saved, the run completed as `queue_empty`, and three hot films were still outstanding. The UI sentence «Очередь обработана полностью» follows `queue_empty`. It does not mean the refreshed queue was empty. `status=complete` is also allowed when this run recorded item failures, because failure count does not by itself set `partial`.

The desired distinction, not changed here: `queue_empty` only when the refreshed outstanding set is empty; `eligible_queue_empty` when work remains but none of it is eligible now; run completion stays separate from a drained queue. Retry timestamps are not reset.

## Hypothesis, not a finding

The three films still pending around 06:30 UTC may have been part of the original five, and the five `format_error_storm` failures may have been those films. Current storage no longer has the retry records, and the cited events do not list film ids. Both links stay unproven.

## Coverage percent

`coveragePercent(current, total)` used `Math.round(current / total * 100)`, so 2257/2260, 1829/1832, 2234/2239, and 9999/10000 all became 100. The footer repeated that rounding from the raw counts. Events stored the same integer on `snapshot.coverage.localPercent` and `windowPercent`.

The function now returns tenths. `100` is returned only when `current === total`. A smaller non-negative numerator cannot round up to 100; the ceiling is `99.9`. The examples are `2257/2260 → 99.9`, `1829/1832 → 99.8`, `2234/2239 → 99.8`, `9999/10000 → 99.9`, and `2260/2260 → 100`.

An empty denominator still returns `100`, as before. A snapshot with no confirmed films therefore has `localPercent: 100` and `confirmedFilmsTotal: 0`. That 100 is not full coverage. Consumers have to read the counts.

`predictionEventSnapshot` and the footer status payload both use this function for `localPercent` and `windowPercent`. The counts are unchanged. The UI only formats the stored number: Russian decimal comma, and `100` without a trailing decimal. Older events keep the integer that was stored; formatting them does not rewrite the event.

## Production impact and rollback

No production write, queue reset, prediction run, EPG sync, flag change, or event backfill is part of this change. After review, ordinary CI/CD deploys the Worker. New events and the footer then show tenths. Rollback is reverting the PR. Stored events stay as they were.
