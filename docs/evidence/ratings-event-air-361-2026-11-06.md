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
| Record replaced before delivery | the event is carried on the new record with a retry time; attempts are rate-bounded (delay up to a day) and never discard it; after recovery one look delivers it without a new run |
| More than 60 owed | the two oldest are discarded and counted in `eventsDropped`; the other 60 are delivered after recovery |
| Stale-close compare-and-swap lost to a renewed run | no event; the run is still live and later gets its own `finished` event |
| Removal counters | already-rated entry with its reference settled: rated 0, resolved 1; lookup rating with a settled reference: 1 and 1; lookup rating whose event is missing: rated 1, resolved 0 |
| Cloudflare executor | a run through the Workflow loop gives one event tied to the run id; with the Events Log unreachable the run still completes and the hourly `ensure` tick delivers the event once, with no Letterboxd request |
| Stale run closed as unknown | an honest `unknown` event at the close time; a running run has none |
| Events UI | «Рейтинги обновлены» with rows, new facts, unchanged and removals; zero is shown as zero; errors and interruptions are worded as such; values are escaped; the `epg` event is unchanged |

Browser QA (local Chromium, mocked `/api/events`, no screenshots): at 1280 px and 390 px the Events list shows the finished, no-change, blocked-error and interrupted `ratings` events and a legacy `epg` event in order, with no horizontal overflow in the page or the list.

Limitations: the R2 failure is injected, not observed; the executor path is exercised with a fake Workflow binding, not a live instance; no production event was inspected.
