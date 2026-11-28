# AIR-664: production repair of the 16 stale Film localization rows

Date: **28 November 2026** (UTC). Card: [AIR-664](https://trello.com/c/Og9XxXfy); [ADR 0225](../../adr/0225-one-off-localization-repair-checkpoint-in-r2.md) (Accepted); delivery [PR #1058](https://github.com/vladimino/iptv-watchlist/pull/1058), `main` `9e57bb368a97ebeef3f58d0e85117ac00f0a1a64`; upstream [AIR-663](https://trello.com/c/UP10l6Js) (reconciler) and [AIR-683](https://trello.com/c/VJYgJuOW) ([cohort census](air-683-localization-cohort-diagnosis-2026-11-26.md)). Runbook: [one-off repair](../../runbooks/film-localization-reconciliation.md#one-off-repair-of-the-16-observed-films-air-664).

**Status: the repair was applied once and read back. All 16 Films are applied and current.** The `apply` response itself was not received (client timeout); the outcome is proved from durable receipts and read-only readbacks below. No restore, cleanup, migration, flag, Task, Workflow or Access change was made.

## 1. Authorization and actor

| Item | Record |
| --- | --- |
| Actor | Claude Code, through the owner-only IPTV MCP tool `film_localization_repair` (connector reconnected by the owner on 28 Nov 2026) |
| Delivered code | PR #1058 squash `9e57bb3`; [post-merge CI/CD](https://github.com/vladimino/iptv-watchlist/actions/runs/46116470725): Test and build, shard 2 of 3, shard 3 of 3 and Deploy to Cloudflare SUCCESS |
| Deployed Worker | `iptv`, Version ID `06ba3b6b-2d7b-4e55-b09a-b780638e69ef`, deployed 06:28:13 UTC (deploy job log). The tool answering the calls below is the merged `film_localization_repair`; the version was not re-read from the account in the calls |
| Handoff | [Controller handoff](https://trello.com/c/Og9XxXfy#comment-6b0a74f1ef0151cab288366c): L0 preflight, then an exact L3 plan, then a separate owner GO |
| L3 plan presented | [AIR-664 plan comment](https://trello.com/c/Og9XxXfy#comment-6b0a77bc73b594111ac01431), 28 Nov 2026 06:41 UTC, and in the session chat |
| Owner GO | 28 Nov 2026 about 06:42 UTC, in the Claude Code session ([session](https://claude.ai/code/session_014nGEiYM1Db5YvEyunyiYB7)), verbatim: «GO AIR-664 apply: digest 8258c795, planAt 2026-11-28T06:41:10.766Z, 16 Film». Recorded before the call in the [GO record](https://trello.com/c/Og9XxXfy#comment-6b0a77f2712bb1baa2270ee6) (06:42:49 UTC). The full digest below is the one presented in the plan; the GO named its prefix |

## 2. Cohort and read-only preflight (before)

Only the 16 ids of the AIR-683 census; no new census. Call at 2026-11-28T06:41:10.222Z (server `planAt` 06:41:10.766Z), answered within about 16 s of wall time (a round trip, not server time). `sideEffects: none`.

| Item | Result |
| --- | --- |
| Decision | `eligible`; eligible 16; recorded, in_flight, applied, applied_moved, applied_unproved, restored*, noop, held, absent, unavailable: 0 |
| Pins | Film/Person `open`, generation **2**; schema **54**; owner-review `d1`, writes **open**, generation **1** |
| expect | planAt `2026-11-28T06:41:10.766Z`, count 16, digest `8258c795706d53f9ffe49bbe0e0a39eaa60c1e78143d58cdeee72033ee68de69` |
| D1 cost | 222 queries of 1,000 |

| Film | planned revision | intent digest (first 16 of 64 hex) |
| --- | ---: | --- |
| `film:1XYA` | 3 | `4723512bda6e150a` |
| `film:27iE` | 3 | `25bd8096a7e58ef8` |
| `film:28R6` | 3 | `bad7a439c8202a58` |
| `film:DCVQ` | 0 | `12e3ed0dc1787ea2` |
| `film:MYia` | 3 | `472841177f727806` |
| `film:QGFo` | 5 | `dd88ce6908cd9504` |
| `film:R9dS` | 3 | `c23eb0a12f4f3fca` |
| `film:RTwc` | 5 | `88506b6c3c336a13` |
| `film:RfZI` | 6 | `6a764af940cb6d9c` |
| `film:iXBq` | 3 | `159eb9d5de31cc9c` |
| `film:jGuE` | 3 | `f11cf0826f16f648` |
| `film:tmdb:101669` | 7 | `a24e6c2cbfb1bfa2` |
| `film:tmdb:516486` | 7 | `a5ed62d3347363e2` |
| `film:tmdb:649409` | 8 | `7db87a385fc0a9da` |
| `film:vCu0` | 3 | `a980c6ac002dee1b` |
| `film:xG0M` | 3 | `b9fdd78fd94ed31f` |

## 3. The apply

One call, no retry: `film_localization_repair` mode `apply`, `confirmGo: true`, with exactly the approved values: `expectedFilmPersonGeneration` 2, `expectedSchemaVersion` 54, `expectedOwnerReviewGeneration` 1, `expectedOwnerReviewWrites` `open`, `expectedPlanAt` `2026-11-28T06:41:10.766Z`, `expectedCount` 16, `expectedDigest` as above. Started 2026-11-28T06:43:40.976Z.

The MCP client ended the call after 60 s with «timed out; the outcome is unknown». The apply response (counts, `writes`, D1 cost) was **not received**. Per the contract nothing was retried; the outcome was classified from durable state with the read-only `recover` (06:44:46 UTC) and a read-only `preflight` (06:45:14 UTC).

Server-side timing from the 16 receipts (read-only SELECT): first receipt created 06:43:52.604Z, last settled 06:44:42.172Z, so about 61 s from the call start to the last settlement (the derive of all 16 Films before the first receipt took about 12 s). That is at the edge of the client's 60 s timeout, which is why the response was lost; the Worker ran to completion.

## 4. Per-Film readback (after)

Read-only `preflight` at 06:45:13.985Z and `recover` at 06:44:46.692Z. Decision **`nothing_to_do`**; applied 16; every other state 0. For each Film the receipt is applied, the stored row equals the recorded post-image, the resolver reports the Film current (`noop`), and the revision is exactly the planned revision plus one:

| Film | planned revision | revision now | receipt | row = post-image | resolver | restore proof |
| --- | ---: | ---: | --- | --- | --- | --- |
| `film:1XYA` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:27iE` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:28R6` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:DCVQ` | 0 | 1 | applied | yes | noop | not applied, eligible |
| `film:MYia` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:QGFo` | 5 | 6 | applied | yes | noop | not applied, eligible |
| `film:R9dS` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:RTwc` | 5 | 6 | applied | yes | noop | not applied, eligible |
| `film:RfZI` | 6 | 7 | applied | yes | noop | not applied, eligible |
| `film:iXBq` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:jGuE` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:tmdb:101669` | 7 | 8 | applied | yes | noop | not applied, eligible |
| `film:tmdb:516486` | 7 | 8 | applied | yes | noop | not applied, eligible |
| `film:tmdb:649409` | 8 | 9 | applied | yes | noop | not applied, eligible |
| `film:vCu0` | 3 | 4 | applied | yes | noop | not applied, eligible |
| `film:xG0M` | 3 | 4 | applied | yes | noop | not applied, eligible |

Receipts (read-only SELECT): 16 of kind `film_localization_reconcile`, all `applied`, `attempts` 1 for each (no retry, no replay), `applied_revision` equal to `planned_revision` + 1 for all 16. The `updated_at` of every cohort revision is the approved plan time `2026-11-28T06:41:10.766Z` (not backdated). The intent digests recorded in the checkpoint equal the preflight digests of section 2: the request id of each receipt is derived from its digest and is identical in the preflight, `recover` and readback answers for all 16 Films. The full 64-hex digests are those returned by `preflight` and `recover`.

Cost: `preflight` before 222, `recover` 196, `preflight` after 238 D1 queries of 1,000 each. The cost of the `apply` call itself is **not known** (response lost); the fixture measurement of about 746 is not a production measurement.

## 5. Attribution

Exactly one `apply` call was made by this session, and no other caller of the tool is known. The receipts show a single attempt each, so the 16 effects are attributed to that one call **by exclusion**; its own counts and `writes` value were not observed. No `alreadyApplied`, `recoveredUnattributed` or `in_flight` classification was observed (the readback shows no such state), and `writes: null` is not read as zero: the effect is proved, only the call's own report is missing.

## 6. Collateral checks (read-only SELECT, before and after)

Counts, ids, revisions and statuses only; no localization value was read. Every statement reported `rows_written: 0`.

| Check | Before (06:43 UTC) | After (06:46 UTC) |
| --- | ---: | ---: |
| `film` rows | 13,869 | 13,869 |
| `localization` rows, whole table | 10,865 | 10,865 |
| `localization` rows outside the cohort | 10,849 | 10,849 |
| `canonical_revision` Film rows outside the cohort | 3,405 | 3,405 |
| sum of those revisions | 4,227 | 4,227 |
| `owner_review_entry` rows | 7 | 7 |
| owner-review generation / writes | 1 / open | 1 / open |
| schema version | 54 | 54 |
| `film_localization_source` rows, whole table | 5 | 16 |
| receipts of kind `film_localization_reconcile` | 0 | 16 (all applied) |

- No Film outside the cohort was revised, and no owner-review row count or generation moved. Protected owner and review rows were compared by count and generation only, not by content.
- `film_localization_source` grew by **11**. Before, 11 cohort Films had no source row (the five existing rows belonged to `film:RTwc`, `film:RfZI` and the three `tmdb` Films); after, each of the 16 Films has exactly one. This is the allowed effect «legacy source rows named by their intents» (the reconciler records a legacy provisional row losslessly before replacing it). The mapping of each new row to its intent was not inspected.
- Cohort revisions each moved by exactly +1 (section 4); `film:DCVQ` had no `canonical_revision` row before and has one now (0 to 1).
- Before-state detail of `film:DCVQ` was not captured (the baseline query started from `canonical_revision`); its planned revision 0 and the table totals are consistent with a Film that had a localization row and no revision row.

## 7. Recovery and restore boundary

- **Restore was not run** and is not authorized by the GO. For all 16 Films the read-only `recover` returned a fresh restore proof with state `not_applied` and `eligible: true`; a restore needs a separate owner decision on that proof and applies only while the Film is still at its recorded post-revision with the row equal to the post-image. Otherwise the remedy is a separately approved forward correction. A restore does not remove a preserved legacy source row.
- **Retained recovery artifacts:** one immutable intent object and one outcome event per Film in the private R2 bucket under the isolated AIR-664 prefix (16 intents, 16 events; one event each per `recover`). Keys and bodies are not published. They are kept until the cohort is accepted and the restore window is closed; cleanup and any TTL are a separately approved action, and the operation never deletes.

## 8. Limitations

- This is a scoped readback of 16 observed Films and aggregate collateral counts, not a global snapshot; concurrent legitimate writers were not frozen. No new Film was created in the table and no other Film was revised in the observed window.
- The `apply` response was lost to the 60 s client timeout; its counts, `writes` and D1 cost were not observed. A continuation or any future call of this duration should expect the same timeout and, as here, must not be retried: `recover`, then a fresh `preflight`.
- Localization values, raw intents, R2 object keys and credentials were not read into, and are not recorded in, this report. The new `film_localization_source` rows and the changed `localization` rows were verified by state, count and receipt, not by value.
- The deployed version is the one in the deploy log; the calls did not independently re-read it from the account.
- Acceptance of the repair as a product outcome, the merge of this evidence and the closing of the card belong to the Controller and the owner; no restore, cleanup or further write is implied.
