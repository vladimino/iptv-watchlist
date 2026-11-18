# AIR-535: time to available Finds after an EPG publication, replay throughput

18 November 2026 (UTC). Code, tests and docs on the AIR-535 branch against `main` at `ec05b82`. No production chunk, EPG, TMDB, lease reset, flag, migration or Workflow create. The production figures below are the read-only observations recorded on the card; this branch ran none.

## What the card's observations separate

| Phase after the published EPG run `cc26a2e7-…` (18 Nov, Madrid time on the card; UTC = Madrid − 1 h) | Observation | Owner of the delay |
| --- | --- | --- |
| publication 18:35:09 → first Workflow chunk that could assign | `_0` stopped at 19:00 (`programme_changed`), next Cron-created successor `_1` at 21:00 | Lifecycle: AIR-534. Not replay. |
| 21:00 → 21:30, series `_1`–`_7` | 63 chunks, 16 388 Discovery shows / 6 200 Films, from 986 | Replay throughput: this card |

The replay itself worked as designed once a chunk was admitted (AIR-523). The 2.5 h gap is dominated by the stopped Workflow; the 30 minutes after the restart are replay throughput and are not inside the 15-minute target even with an immediate start.

## Offline benchmark (`tests/discovery-replay-timeline.mjs`)

1 200 verified observations (2 800 eligible slots), a new run with no assigned row, replay slices of 10 s on a **modelled** clock of 300 ms per D1 round trip (the card's 5 752 ms for 2 pages of 40 observations, about 10 round trips a page), chunks every 30 s (63 chunks in about 30 minutes on 18 Nov). These are modelled, not measured, wall times.

| Page | Round trips per restored row | Rows per chunk | Chunks for 2 800 rows | T50 / T90 / T95 / T99 (modelled minutes) |
| --- | --- | --- | --- | --- |
| 40 observations (before) | 0.128 | 280 | 10 | 2.5 / 4.5 / 5.0 / 5.0 |
| 96 observations (after) | 0.076 | 400 | 7 | 2.0 / 3.0 / 3.0 / 3.5 |

Calibration check: 280 rows per chunk scales to 16 400 rows in about 59 chunks, about 29 minutes, which matches the 63 chunks and about 30 minutes observed on 18 Nov. The model reproduces the production rate; it does not prove the production rate after the change.

## Root cause (narrow)

A replay page costs six fixed round trips (verified-observation select, free slots, members, admissions, and the two counts around the write) plus one per 38 statements. At 40 observations the fixed part was about 6 of 9 round trips; the page was capped at 40 although the bind cap (100) allows 96 keys plus the run in the slot and count queries. So the replay slice spent most of its time on reads that scale with pages, not rows.

## Change

- `REPLAY_PAGE` is now `BIND_CAP - 4` (96). The statements are unchanged: every ADR 0142 decision 4 guard still runs inside the guarded insert, batches stay at 38 statements, the cursor, lap and rest rules (AIR-523) are untouched.
- Read-only metrics in the stored Discovery status (`replayStats`, per programme run; no heavy GET). The clock is the **completion receipt** of `sync.json` for the same run (the contract of `epgPublicationState`: stage `complete`, same `runId`, `completedAt`, or `updatedAt` of a legacy record without an error), named `epgCompletedAt` with `clock: "sync_completion_receipt"`. It is not `published_epg_generation.published_at`, which is the scan time (D1 16:12:34Z against completion 17:35:09Z on 18 Nov, AIR-420). Without a receipt (run in flight, another run, unreadable record) the clock and every interval are `null`; intervals are never clamped, so a replay that starts before completion shows a negative value.
- Coverage is read from D1 with one bounded statement per replaying chunk (`replayCoverage`): `assigned` is every Discovery row the run holds, `verifiedSlots` the slots of verified current observations. The latter is an **upper bound** of what `slotEligibility` can assign (drift, a Film with no record, a slot held by another Film stay inside it), so coverage is a lower bound; it is labelled `basis: "verified_slots_upper_bound"`. T50/T90/T95/T99 are stamped once, with `at` and `sinceCompletedMs`, the first chunk that sees the share reached. A chunk resting after a completed lap carries the previous reading.
- `chunks` counts each hop once: a hop retried under the same lease after its status was saved reads that status as prior and does not add itself again. Running sums of assigned rows were removed; the D1 counts replace them.

## Mixed replay and TMDB workload (`tests/discovery-chunk-budget.mjs` case 26)

The same full 40-second hop, the same fixture (288 verified observations needing replay plus 30 unresolved candidates), page of 40 against 96, a modelled D1 on the fake clock. Modelled, not measured; it shows no displacement of TMDB work, nothing about production latency.

| Modelled D1 | Page | TMDB started / checked | TMDB ms | Replay ms | Rows restored | Hop ms |
| --- | --- | --- | --- | --- | --- | --- |
| 50 ms per round trip | 40 | 16 / 8 | 4 031 | 3 469 | 288 | 13 442 |
| 50 ms per round trip | 96 | 16 / 8 | 4 025 | 1 704 | 288 | 11 664 |
| 100 ms per round trip | 40 | 16 / 8 | 8 040 | 6 867 | 288 | 26 751 |
| 100 ms per round trip | 96 | 16 / 8 | 8 027 | 3 362 | 288 | 23 226 |
| 2.8 s per write batch, 50 ms reads | 40 | 2 / 1 | 6 006 | 3 361 | 38 | 40 066 |
| 2.8 s per write batch, 50 ms reads | 96 | 2 / 1 | 6 005 | 3 360 | 38 | 40 053 |

TMDB requests, checked candidates and TMDB time are unchanged; the same rows take about half the replay time at the two faster models; with 2.8 s batches nothing changes and the hop ends about 50 ms past 40 s on both (an in-flight batch cannot be pre-empted, an existing property). With 300 ms on **every** statement both pages end in `wall_budget` with no replay and no TMDB (the chunk's own pre-replay reads use the budget first, as the 10-11 s `preChunkMs` on 18 Nov also show); that model cannot separate the pages and is not used. This is not a claim that the cross-stream goal (fresh hot Films by 17:30 Madrid) is met by this PR.

## What this does not claim

- With 96 observations a page is three write batches, so on a 2.8 s D1 one page may not finish inside the 10 s slice. The cursor then stays at the page start; rows already written are no longer selected, so the next chunk continues without rescanning them (`tests/discovery-chunk-budget.mjs` case 23 asserts it).
- The model predicts about 1.4× the rows per chunk, about 20 minutes for 16 400 rows at the observed cadence. The ≤15 minute target is **not** shown by this change alone. Remaining levers are a larger replay slice while an initial restore is pending and fewer count round trips; both trade against TMDB progress and were not applied without a measured case for them.
- Time to first chunk after publication is AIR-534's outcome and was not changed.

## Acceptance still open

At the next natural EPG publication, read-only: `replayStats` in the Discovery status give `epgCompletedAt`, the first assigned chunk, the coverage milestones and the lap completion; D1 aggregate of assigned `basis='discovery'` rows against verified observations; no duplicate slot, no generation leakage, TMDB `checked` per chunk not lower than before. If the start is blocked by AIR-534 the card records that gate and does not trigger a manual run.
