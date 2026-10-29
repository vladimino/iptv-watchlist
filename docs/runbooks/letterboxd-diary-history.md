# Letterboxd Diary viewing history — activation, observation, rollback

Contract: [Letterboxd Diary viewing history](../reference/integrations/letterboxd-diary-history.md). Decision: [ADR 0048](../adr/0048-letterboxd-diary-viewing-history.md). Card: [AIR-51](https://trello.com/c/33d4hKJ3).

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
- **`ratingAttempt.phase`** passes through `diary`. A `ratingAttempt` that ends `unknown` with `interruptedPhase: diary` means the request died in the stage.
- **`GET /api/letterboxd/diary`:** `state`, entry counts and, for a film, its viewings.
- **Workers Observability:** `epg_ratings_phase` with `phase: diary`. The diary requests show as at most three subrequests to `letterboxd.com/<user>/diary/…`.
- **Expected first run:** page 1 and, if it is entirely new, pages 2–3. `partial` with a `resumePage` until the backfill reaches the last page. Later commits continue the backfill.
- **`blocked`** means the challenge answered at that page. Record it and stop; never retry or work around it. The history keeps what was read.

## Rollback

1. The owner sets `LETTERBOXD_DIARY_HISTORY=off`, or removes it, and reads it back.
2. The next commit makes no diary history request. The diary repair returns to its own page-1 request after a failed films list.
3. `letterboxd/diary/history.json` and `state.json` stay. Deleting them is a separate owner-approved storage operation. A code revert removes the reader and the route; the objects are then ignored.
