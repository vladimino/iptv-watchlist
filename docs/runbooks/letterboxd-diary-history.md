# Letterboxd Diary viewing history — activation, observation, rollback

Contract: [Letterboxd Diary viewing history](../reference/integrations/letterboxd-diary-history.md). Decisions: [ADR 0049](../adr/0049-letterboxd-diary-viewing-history.md), [ADR 0054](../adr/0054-diary-first-epg-ratings.md) (Diary-first ratings). Card: [AIR-51](https://trello.com/c/33d4hKJ3).

A deploy does not activate anything. Each step below that changes production needs its own owner approval.

## Before activation (read-only)

1. Read `feature_flags` (MCP): `LETTERBOXD_DIARY_HISTORY` should be absent or `off`.
2. Read the sync status (`epg_status`). Note the last commit time, so the next routine EPG commit can be observed. The stage runs only inside a routine commit; there is no manual endpoint.
3. Read `GET /api/letterboxd/diary`. Before the first run, `state` is `null` and `entries` is `0`.

## Activation (owner)

1. The owner sets `LETTERBOXD_DIARY_HISTORY=on` (plain text) on Worker `iptv`, then reads it back through `feature_flags`: `effective: on`.
2. Wait for the next routine EPG commit. Do not start a sync for this.

## Observation after a commit (read-only)

- **`sync.json` `diaryHistory`** (in the sync status):
  - `outcome` and `stopReason`;
  - `counts`: pages at most 3, rows, added, unchanged, updated, conflicts, unresolved, undated;
  - `resumePage`.
- **Facts (ADR 0054):** `diaryHistory.facts` shows `rated`, `unrated`, `ambiguous` and `partial`, and the write outcomes `written`, `unchanged`, `older` and `skipped`. `ratingAttempt` ends `finished` with `source: letterboxd_diary`. No request to `/<user>/films/` appears; if one does, stop and report it.
- **Removed films:** `removalDiaryResolved` lists those rated by the diary. `removalRatingLookup` shows at most five member-page requests, only for the rest.
- **`ratingAttempt.phase`** passes through `diary`. A `ratingAttempt` that ends `unknown` with `interruptedPhase: diary` means the request died in the stage.
- **`GET /api/letterboxd/diary`:** `state`, entry counts and, for a film, its viewings.
- **Workers Observability:** `epg_ratings_phase` with `phase: diary`. The diary requests show as at most three subrequests to `letterboxd.com/<user>/diary/…`.
- **Expected first run:** page 1 and, if it is entirely new, pages 2–3. `partial` with a `resumePage` until the backfill reaches the last page. Later commits continue the backfill.
- **`blocked`** means the challenge answered at that page. Record it and stop; never retry or work around it. The history keeps what was read.

## Proposed separate ratings run (design, not live)

[ADR 0059](../adr/0059-independent-letterboxd-ratings-pipeline.md) is `Proposed`; none of the following exists in production. If it is accepted and delivered, observation would move from `sync.json` to `ratings_sync_status`:

- **Run record:** `state`, `phase`, `checkpoint` (`diaryPagesRead`, `diaryNextPage`, `removalChecked`) and `outcome`/`cause`. A run with `lease.live: false` is not closed by the read; the next start or step closes it `unknown`. Never repeat a step that ended without a response.
- **`isolated`:** two runs interrupted at the same phase and checkpoint. Record it and stop; only an owner-approved manual start with `clearIsolation` lifts it.
- **Cutover and rollback** are owner actions in this order: `RATINGS_PIPELINE=separate`, then enable the Ratings Task, then extend the drift monitor; back: disable the task, then `RATINGS_PIPELINE=inline`. The Diary state and the removal queue carry over both ways.

## Rollback

1. The owner sets `LETTERBOXD_DIARY_HISTORY=off`, or removes it, and reads it back.
2. The next commit makes no diary history request. The diary repair returns to its own page-1 request after a failed films list.
3. `letterboxd/diary/history.json` and `state.json` stay. Deleting them is a separate owner-approved storage operation. A code revert removes the reader and the route; the objects are then ignored.
