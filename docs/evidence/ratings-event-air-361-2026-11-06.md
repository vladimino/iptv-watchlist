# Ratings run result in the Events Log: offline evidence (AIR-361)

Captured 2026-11-06 (UTC) from the repository only. **No production read or write, Ratings or Workflow run, retry or R2/D1 action was made.**

`tests/ratings-event.mjs` drives the real Ratings run code against an in-memory bucket and an injected clock.

| Scenario | Result |
| --- | --- |
| Natural successful run (50 Diary rows) | one event, id `<runId>-ratings`, `at` equals the run's `finishedAt`, 50 rows and the real number of written facts |
| Next run with nothing new | a second event for another runId, `written: 0`, all 50 rows already recorded, later time |
| 403 and 429 | an `error` event with cause `blocked` / `rate_limited`, never a success |
| Not migrated | no run started, no event |
| Event put fails after the terminal commit | the run stays `finished`, no Diary request is repeated, a later reconcile writes the event once; repeats and concurrent reconciles add nothing |
| Record replaced before delivery | the event is carried on the new record and written later; with a persistent failure it is dropped after five attempts |
| Stale run closed as unknown | an honest `unknown` event at the close time; a running run has none |
| Events UI | «Рейтинги обновлены» with rows, new facts, unchanged and removals; zero is shown as zero; errors and interruptions are worded as such; values are escaped; the `epg` event is unchanged |

Limitations: the R2 failure is injected, not observed; the Cloudflare Workflow path shares the same reconcile (a terminal read by the executor) but was not run end to end; no production event was inspected.
