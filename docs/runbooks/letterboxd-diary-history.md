# Letterboxd Diary viewing history — activation, observation, rollback

Contract: [Letterboxd Diary viewing history](../reference/integrations/letterboxd-diary-history.md). Decisions: [ADR 0049](../adr/0049-letterboxd-diary-viewing-history.md), [ADR 0054](../adr/0054-diary-first-epg-ratings.md) (Diary-first ratings), [ADR 0067](../adr/0067-diary-recent-window.md) (page 1 only). Card: [AIR-51](https://trello.com/c/33d4hKJ3).

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
  - `counts`: `pages` is 0 or 1, plus rows, added, unchanged, updated, conflicts, unresolved, undated, and `overflowSuspected` when the page was full, new, and linked onward;
  - `resumePage`, kept as stored and not a request.
- **Facts (ADR 0054, ADR 0067):** `diaryHistory.facts` shows `rated` and `unrated`. `ambiguous` and `partial` stay 0. The write outcomes are `written`, `unchanged`, `older` and `skipped`. A successful page ends `ratingAttempt` `finished` with `source: letterboxd_diary` and `diaryHistory.outcome` `recent_window`. No request to `/<user>/films/` or to `/diary/page/2/` appears; if one does, stop and report it.
- **Removed films:** `removalDiaryResolved` lists those rated by the diary. `removalRatingLookup` shows at most five member-page requests, only for the rest.
- **`ratingAttempt.phase`** passes through `diary`. A `ratingAttempt` that ends `unknown` with `interruptedPhase: diary` means the request died in the stage.
- **`GET /api/letterboxd/diary`:** `state`, entry counts and, for a film, its viewings.
- **Workers Observability:** `epg_ratings_phase` with `phase: diary`. The diary request is one subrequest to `letterboxd.com/<user>/diary/`.
- **Expected run:** page 1 only, `recent_window` / `recent_window_only`, `lastSuccessAt` moved, `coverage.window: recent`, `historicalCoverage: incomplete`, `reachedEnd` left false. A stored `resumePage` does not cause another request. More than 50 new viewings since the previous success can miss this page; that is not a failed run, and this task does not start an archive import.
- **`blocked`** means the challenge or HTTP 403 answered on page 1. Record it and stop; never retry or work around it, and never request page 2. The history keeps what was already stored, and `lastSuccessAt` stays.

## Separate ratings pipeline

[ADR 0060](../adr/0060-independent-letterboxd-ratings-pipeline.md); contract: [separate ratings pipeline](../reference/integrations/letterboxd-ratings.md#separate-ratings-pipeline); tools: [MCP reference](../reference/api/mcp.md#ratings-tools). The code is deployed inactive: with `RATINGS_PIPELINE` unset or `inline` and the storage unmigrated, the EPG commit runs ratings as above, and no Scheduled Task calls a ratings tool.

### Reading the status (read-only)

`ratings_sync_status` (or `GET /api/letterboxd/ratings/status`) writes nothing, not even a recovery.

- **`switch`, `pipeline`, `migration`.** Before the cutover: `inline`, `inline`, `none`. `separate_pending_migration` means the switch is set but the migration is not complete, so the commit still runs ratings. `migration: regressed` (with `regressedObjects`) is a defect: stop and report it.
- **`run`.** `state`, `phase`, `checkpoint` (`diaryPagesRead`, `diaryNextPage`, `removalChecked`), `outcome`/`cause`, `lease.live` and `stale`. A run with `stale` set is not closed by the read; the next start or step closes it `unknown`. Never repeat a step that ended without a response.
- **`removal`.** Queue version, entries, pending, unresolved references, legacy, expired, `droppedRefs`, `pausedUntil`, and `refIssues`: unresolved references by issue. A growing `event_missing` count means removal events that were never written; record it, nothing retries them by hand. **`diary`**: cursor coverage, `historicalCoverage` (`incomplete` when `coverage.window` is `recent`, otherwise `unknown`), `overflowSuspected`, resume page (not a request), last outcome and `lastSuccessAt`. A finished recent window is `recent_window`, not a complete diary.
- **`freshness`.** The last finished and the last successful run.

### Cutover (owner)

A sequence of owner actions. Each step is approved separately and checked before the next one.

**Gate before the first separate writer (step 4).** The offline profile measures the Diary step's heap at 27.5 MB above the Node baseline with 5,000 history entries and 99.3 MB with 20,000, because every page reads and rewrites the single `letterboxd/diary/history.json` ([evidence](../evidence/letterboxd/air-294-separate-ratings-pipeline-offline-2026-10-31.md)). That does not prove a step fits the 128 MB Worker. Before `RATINGS_PIPELINE=separate`, record the size of `history.json` via a read-only storage check (the step 2 pre-apply backup may include this measurement), and either verify a maximal Diary step in a Workers-like runtime (workerd) at that size with headroom, or decide a history guard or sharding (a design change: new ADR). Never test this against production without owner permission.

**AIR-295 owner-approved sequencing adjustment (2026-10-31):** A read-only `dry_run` does not require an R2 backup beforehand. This replaces the export/dry-run order in the original ADR 0060 rollout checklist for AIR-295 only; it does not alter the storage migration design or authorize `apply`, a feature flag change, or Task activation.

1. `ratings_storage_migrate` `dry_run`. It writes nothing; record the returned counts (entries, legacy, references, hand-over, cursor coverage and resume page) and `writes: 0`. Do not call `apply` based on the dry-run alone.
2. **Immediately before the separately approved `apply`**, take read-only backup copies of `enrichment/removal-rating-lookups.json` and `letterboxd/diary/state.json`; record object sizes and hashes outside the public repository. Compare their current contents/counts with the dry-run, repeating the read-only dry-run if the source has changed. If either backup cannot be read and preserved, stop before `apply`. Preserve the copies for rollback analysis, never publish private R2 payloads.
3. `ratings_storage_migrate` `apply`, still under `inline`. Run it only:
   - after at least one routine EPG commit has completed on the deployed version;
   - while `epg_status` shows `stage: complete` with no step in the last 15 minutes;
   - outside the daily EPG window.

   Read back:
   - `migration: complete`;
   - `removal.schemaVersion: 2`;
   - `unresolved` and `legacy` as predicted;
   - cursor progress (coverage, `resumePage`) equal to the export.

   On `partial` or `failed`, repeat `apply`; the commit keeps running ratings meanwhile.
4. Set `RATINGS_PIPELINE=separate`. The switch writes no storage. Read back `feature_flags` and `pipeline: idle`. Then check that the next EPG commit makes no Diary or lookup request, carries `ratingsPipeline: separate` and grows the queue's references for its removals. On a problem, set `inline` back.
5. One manual `ratings_sync_start({trigger:'manual'})`, then `ratings_sync_step({runId})` while `nextAction` is `continue`. Expect `finished`, or `error` with a cause. The cursor and the queue only move forward. On a problem, set `inline`.
6. Enable the Ratings Task, then extend the drift monitor ([Scheduled Tasks](../reference/scheduled-tasks.md#ratings-task)).

As of the live read-only check on 2026-10-31 the storage is migrated, `RATINGS_PIPELINE=separate` and the Ratings Task is enabled. A later owner-approved registry change the same day set the drift monitor to daily 18:15 Europe/Madrid, DTSTART 2026-10-31, reading the three task entries and read-only `ratings_sync_status` ([Scheduled Tasks](../reference/scheduled-tasks.md#read-only-drift-monitor)). The list above is the sequence that was followed. It is not an instruction to repeat it, and this page does not change the flag or the task.

The expected Ratings Task recurrence is daily at 17:30 Europe/Madrid, flexible, DTSTART 2026-11-01, as recorded in the [Scheduled Tasks contract](../reference/scheduled-tasks.md#ratings-task). A scheduled start is not refused because it follows the previous start ([ADR 0069](../adr/0069-no-scheduled-ratings-start-gap.md)). `busy` and `isolated` still end that invocation. The six-hour pause after a Letterboxd 403 or 429 on the removal queue is unchanged.

### Isolation

`isolated` means two consecutive runs were interrupted in the same phase at the same checkpoint: the step dies at the same place, typically a Worker resource limit. Record `isolation` (phase, checkpoint, run ids) and the Workers Observability end reason, and stop. Clearing it is an owner decision: one `ratings_sync_start({trigger:'manual', clearIsolation:true})`, normally after the cause has been fixed. A Scheduled Task never clears it.

### Rollback

1. Disable the Ratings Task, if enabled.
2. Set `RATINGS_PIPELINE=inline`, or remove it, and read it back. The next commit runs the Diary stage and lookups again under the migrated queue and cursor rules, so nothing is lost. A run left `running` stays until a later start closes it.
3. Once migrated (cutover step 3), a code revert is **not** a rollback. Earlier code prunes the version 2 queue without its references and writes the cursor back as version 1. Undoing it needs a separate owner decision on the stored objects.

## Rollback

1. The owner sets `LETTERBOXD_DIARY_HISTORY=off`, or removes it, and reads it back.
2. The next commit makes no diary history request. The diary repair returns to its own page-1 request after a failed films list.
3. `letterboxd/diary/history.json` and `state.json` stay. Deleting them is a separate owner-approved storage operation. A code revert removes the reader and the route; the objects are then ignored.
