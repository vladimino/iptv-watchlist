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

[ADR 0060](../adr/0060-independent-letterboxd-ratings-pipeline.md) is `Proposed`; none of the following exists in production. If it is accepted and delivered, observation would move from `sync.json` to `ratings_sync_status`:

- **Run record:** `state`, `phase`, `checkpoint` (`diaryPagesRead`, `diaryNextPage`, `removalChecked`) and `outcome`/`cause`. A run with `lease.live: false` is not closed by the read; the next start or step closes it `unknown`. Never repeat a step that ended without a response.
- **`isolated`:** two runs interrupted at the same phase and checkpoint. Record it and stop; only an owner-approved manual start with `clearIsolation` lifts it.
- **Cutover** is a sequence of owner actions. Each step is approved separately and checked before the next one:
  1. Read-only export of `enrichment/removal-rating-lookups.json` and `letterboxd/diary/state.json`, with sizes and hashes recorded.
  2. `ratings_storage_migrate` `dry_run`. It writes nothing; its counts must match the export.
  3. `ratings_storage_migrate` `apply`, still under `inline`. Run it only after at least one routine EPG commit has completed on the deployed version, while `epg_status` shows `stage: complete` with no step in the last 15 minutes, and outside the daily EPG window. Read back `migration: complete`, `removal.schemaVersion: 2`, `unresolved` and `legacy` as predicted, and cursor progress (coverage, `resumePage`) equal to the export. On `partial` or `failed`, repeat `apply`; the commit keeps running ratings meanwhile. A later status of `migration: regressed` is a defect: stop the cutover and report it.
  4. Set `RATINGS_PIPELINE=separate`; the switch writes no storage. Read back `pipeline: idle`, and check that the next EPG commit makes no Diary or lookup request. On a problem, set `inline` back.
  5. One manual `ratings_sync_start` and its steps. Expect `finished` or `error` with a cause; the cursor and queue only move forward. On a problem, set `inline`.
  6. Enable the Ratings Task, then extend the drift monitor.
- **Rollback:** disable the task, then set `RATINGS_PIPELINE=inline`. The commit keeps the migrated queue and cursor rules, so nothing is lost. Once migrated (step 3), a code revert is not a rollback; it needs a separate owner decision on the queue.

## Rollback

1. The owner sets `LETTERBOXD_DIARY_HISTORY=off`, or removes it, and reads it back.
2. The next commit makes no diary history request. The diary repair returns to its own page-1 request after a failed films list.
3. `letterboxd/diary/history.json` and `state.json` stay. Deleting them is a separate owner-approved storage operation. A code revert removes the reader and the route; the objects are then ignored.
