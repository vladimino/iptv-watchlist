# AIR-318 manual ratings run, 4 November 2026

**Captured:** 2026-11-04 08:26:54–08:28:51 UTC (09:26–09:28 Europe/Madrid). Production Worker `iptv`. One owner GO in chat covered one manual ratings run through the owner-only MCP: `ratings_sync_start` with trigger `manual`, then `ratings_sync_step` on that `runId` while `nextAction` was `continue`. It did not cover revert, `clearIsolation`, `ratings_storage_migrate`, a Ratings Scheduled Task change, a flag, Access, or releasing prediction `writes`.

**Scope:** one finished ratings run after the marker was already `d1` / `open`. The production entry `scripts/ratings-domain-production.mjs` was not used to write. This page's procedure in the diary runbook did not start the run.

## Before

Read-only `ratings_sync_status` at 2026-11-04T08:24:11.457Z returned HTTP 200. `switch` was `separate`, `pipeline` was `idle`, `migration` was `complete`, and `sideEffects` was `none`. The previous run `f7284dbc-c98b-45d1-8c22-dd7d35660163` was `scheduled` and `finished`, outcome `recent_window`, finished 2026-11-03T16:34:17.350Z. The lease was not live. Isolation was null. Removal pending was 2, unresolved was 2, and `event_missing` was 2. The activation read-back at 08:02:59 UTC had the ratings marker at generation 1 ([activation record](air-318-ratings-activate-2026-11-04.md)).

## Run

`ratings_sync_start` returned HTTP 200, `created` true, `runId` `740883e4-46ba-4879-974f-e568a2fe4dbb`, trigger `manual`, `nextAction` `continue`, reason `started`. No second start was sent.

Two steps, both HTTP 200. Neither was retried.

| Step | id | phase on the step | after the step |
| --- | --- | --- | --- |
| 1 | `1e26e30e-b208-4163-b07a-645db3a875f8` | diary | `running`, phase `removal`, `nextAction` `continue`, reason `more_work` |
| 2 | `a26d5a7c-c43b-42fc-987b-087584b56a96` | removal | `finished`, phase `done`, `nextAction` `stop`, reason `finished` |

Diary, the same summary on both steps: outcome `recent_window`, stop `recent_window_only`, pages 1, rows 50, added 0, updated 0, conflicts 0, facts written 0, unchanged 0, skipped 50, rated 50, unrated 0, `removalResolved` 0. Coverage newest watched date 2026-11-03, oldest 2026-09-06, reached end false, window `recent`, at 2026-11-04T08:27:02.262Z. Page 2 was not requested.

Removal, present only on the finished step: settled written 2, resolved 2, waiting 0, mismatched 0, left 0. Lookup checked 0, rated 0, not rated 0, failed 0. No 403 and no 429. The removal step reported `diaryPages` 0 and `lookups` 0.

`finishedAt` 2026-11-04T08:28:51.853Z. `cause` null. Isolation null.

## Read-back

`ratings_sync_status` at 2026-11-04T08:29:09.971Z returned HTTP 200. `pipeline` was `idle`, `migration` was `complete`, `switch` was `separate`, and `sideEffects` was `none`. The lease was not live. Removal entries 4, pending 0, unresolved 0, `event_missing` 0, `film_not_in_event` 0, `event_unrated` 0. The pinned programme run was `00ff34fa-e518-4ac7-ae63-b2e46f803503` and `removalPending` was 0. `diary.enabled` is the capability. The diary phase above is the fetch.

A separate D1 read immediately afterwards sent one `SELECT` (`reads` 1, `batches` 0). Operator status afterwards reported `writes` false. The database name was `iptv` and the opened identity matched the production constant. No etag was read.

| Check | Result |
| --- | --- |
| `schema_contract.version` | 10 |
| Marker | `mode` `d1`, `cutover` `open`, generation 12 |
| `ratings_document` rows | 475, and 475 distinct keys |
| `ratings_view` rows | 891 |
| `ratings_domain_cas.ok` | 1 |
| Owner reviews | still `d1` / `open` / generation 1 / `mirror_generation` 1 / 7 rows |
| Prediction marker | still `d1` / `held`; generation 2364 / queue generation 167 / profile generation 0 |
| Published EPG marker | still `d1` / `open` / generation 2 / watchlist generation 2 |
| Metadata cache marker | still `d1` / generation 34 / mirror generation 34 |

Generation was 1 at the 08:02:59 UTC activation read-back. This `SELECT` did not write. The manual run is the ratings writer in that interval. Document and view counts did not change, and facts written stayed 0. The two settled removal writes are projections onto events. Those events stay in R2.

Prediction generations moved from 2358 / queue 165 at the activation read-back to 2364 / queue 167 on this read. `writes` stayed `held`. This ratings run did not release that hold and did not write the prediction marker.

## Verdict

**Manual run finished.** Outcome `recent_window`. The ratings marker stayed `d1` with `cutover` `open` and advanced to generation 12. The scheduled Ratings Task at 17:30 Europe/Madrid was not enabled, disabled, or edited. `clearIsolation` was not sent. `ratings_storage_migrate` was not called. Revert was not run. The operator script made no R2 write.

**Not done.** Revert, a Scheduled Task change, and releasing prediction `writes` remain separate approvals. This record does not close AIR-318.

**Limits.** Counts and states only. Diary rows, film ids and rating values are not in this record. The number of fenced statements inside the two steps was not counted; the generation delta is the read-back.
