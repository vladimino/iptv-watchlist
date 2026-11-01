# Letterboxd Diary viewing history — operation

Contract: [Letterboxd Diary viewing history](../reference/integrations/letterboxd-diary-history.md). Decisions: [ADR 0049](../adr/0049-letterboxd-diary-viewing-history.md), [ADR 0054](../adr/0054-diary-first-epg-ratings.md) (Diary-first ratings), [ADR 0067](../adr/0067-diary-recent-window.md) (page 1 only), [ADR 0075](../adr/0075-retire-letterboxd-diary-history-switch.md) (the gate is retired). Card: [AIR-307](https://trello.com/c/5ZU2RsEt). The original activation was [AIR-51](https://trello.com/c/33d4hKJ3).

Diary page 1 on a migrated ratings run is permanent. The Worker does not read `LETTERBOXD_DIARY_HISTORY`. Setting the binding to `off`, emptying it or deleting it does not stop the Diary phase. `diary.enabled: true` on `ratings_sync_status` and `enabled: true` on `GET /api/letterboxd/diary` mean the capability is on. They do not prove a fetch happened and they do not prove the binding is absent. `feature_flags` does: while the binding exists, `state: set` and `issue: retired`; after the later owner deletion, `state: absent`, `retired: true`, `valid: true`. `effective` is null either way.

This code change does not delete the Cloudflare binding. `keep_vars: true` leaves it. The production binding was `on` at the 2026-11-01 AIR-306 readback. Deleting only that binding is a later owner step, after this code is deployed and a read-only check accepts it. Do not substitute that deletion with `off` or an empty value. `diary.enabled: true` after the deletion still does not prove a Diary fetch. Only a later routine Ratings Task run, not a manual start, confirms page-1 processing.

### Rollback of this retirement

1. Disabling or deleting the binding does not stop Diary.
2. After the binding is deleted, code from before ADR 0075 must not be deployed until `LETTERBOXD_DIARY_HISTORY=on` is restored and read back. That older code skips Diary when the binding is absent.
3. A code revert does not roll back R2 history, the Diary cursor, facts or the removal queue.

A deploy does not start a ratings run. Each production change still needs its own owner approval.

## Historical activation (AIR-51)

The steps below are how the gate was introduced. They are not a current instruction. Do not set the flag off, and do not remove it, to stop Diary.

### Before activation (read-only) — historical

1. Read `feature_flags` (MCP): `LETTERBOXD_DIARY_HISTORY` was expected absent or `off` before the first activation.
2. Read the sync status (`epg_status`). Note the last commit time. At that time the stage ran only inside a routine commit.
3. Read `GET /api/letterboxd/diary`. Before the first run, `state` is `null` and `entries` is `0`.

### Activation (owner) — historical

1. The owner set `LETTERBOXD_DIARY_HISTORY=on` (plain text) on Worker `iptv`, then read it back through `feature_flags`. That `effective: on` reading belonged to the old gate. The retired flag's `effective` is null.
2. The next routine ratings run, not an EPG commit, is what reads Diary. Do not start one for this retirement.

## Observation after a commit (read-only)

Since [ADR 0074](../adr/0074-retire-ratings-pipeline-switch.md) the EPG commit does not write these fields. They are on the ratings run record. See [Separate ratings pipeline](#separate-ratings-pipeline).

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

[ADR 0060](../adr/0060-independent-letterboxd-ratings-pipeline.md), [ADR 0074](../adr/0074-retire-ratings-pipeline-switch.md); contract: [separate ratings pipeline](../reference/integrations/letterboxd-ratings.md#separate-ratings-pipeline); tools: [MCP reference](../reference/api/mcp.md#ratings-tools). The Worker does not read `RATINGS_PIPELINE`. When migration is `complete`, the EPG commit only enqueues removal references and the Ratings Task is the ratings writer. When migration is `none`, `partial` or `regressed`, the commit publishes and fails closed: no Diary, no lookup, no enqueue, and start and step answer `not_migrated`. Setting the binding to `inline` or deleting it does not put Diary back inside the commit.

### Reading the status (read-only)

`ratings_sync_status` (or `GET /api/letterboxd/ratings/status`) writes nothing, not even a recovery.

- **`switch`, `pipeline`, `migration`.** `switch` is always `separate`. That string is the permanent mode; it does not prove the binding is absent. `feature_flags` does. `pipeline` is `blocked` until migration is `complete`, then `idle`, `running` or `isolated`. There is no `separate_pending_migration` and no `disabled` answer. `migration: regressed` (with `regressedObjects`) is a defect: stop and report it. The commit does not read Diary in that state.
- **`run`.** `state`, `phase`, `checkpoint` (`diaryPagesRead`, `diaryNextPage`, `removalChecked`, `legacyPagesLinked`), `outcome`/`cause`, `lease.live` and `stale`. A run with `stale` set is not closed by the read; the next start or step closes it `unknown`. Never repeat a step that ended without a response. `legacyPagesLinked` counts event-list pages saved while linking a rated legacy entry; it is not a request to list events by hand.
- **`removal`.** Queue version, entries, pending, unresolved references, legacy, expired, `droppedRefs`, `pausedUntil`, and `refIssues`: unresolved references by issue. A growing `event_missing` count means removal events that were never written; record it, nothing retries them by hand. **`diary`**: cursor coverage, `historicalCoverage` (`incomplete` when `coverage.window` is `recent`, otherwise `unknown`), `overflowSuspected`, resume page (not a request), last outcome and `lastSuccessAt`. A finished recent window is `recent_window`, not a complete diary.
- **`freshness`.** The last finished and the last successful run.

### Cutover (owner) — historical AIR-295 sequence

The steps below are the sequence that was followed on 2026-10-31. They are not a current instruction and not a rollback. Do not set `RATINGS_PIPELINE=inline` or remove the binding to restore Diary on the commit. Current behaviour is [above](#separate-ratings-pipeline).

A sequence of owner actions. Each step was approved separately and checked before the next one.

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

### Rated legacy entries and historical removal events

[ADR 0071](../adr/0071-legacy-removal-event-link.md) (Accepted 2026-10-31). A version 1 queue entry that migrated as `legacy: true` with `refs: []` and is already `rated` with a confirmed half-star can be linked to watchlist-removal events of that same film id. The link runs inside a ratings removal step: one page of 20 `events/items/` keys, then the existing settle writes the stored rating. It does not run on deploy, on an EPG commit, or on `ratings_sync_status`. It does not call Letterboxd, does not invent a rating, and does not treat the removal itself as a viewing.

This is not a storage migration and it is not a reason to repeat the cutover above. A production repair happens only when an owner-approved ratings run reaches the removal phase while such an entry exists. Until then the historical events stay as they are. Read-only checks may record `removal.legacy` and `removal.refs`; they must not start the run. The discrepancy observed on 2026-10-31 is in [the evidence note](../evidence/letterboxd/air-303-legacy-removal-events-2026-10-31.md): one legacy entry, no references, two removal events for that film. The scan cost is one page per removal step until `events/items/` is exhausted, and later steps list nothing once `legacyLink.done` is set.

### Isolation

`isolated` means two consecutive runs were interrupted in the same phase at the same checkpoint: the step dies at the same place, typically a Worker resource limit. Record `isolation` (phase, checkpoint, run ids) and the Workers Observability end reason, and stop. Clearing it is an owner decision: one `ratings_sync_start({trigger:'manual', clearIsolation:true})`, normally after the cause has been fixed. A Scheduled Task never clears it.

### Rollback

1. Disable the Ratings Task, if enabled. That stops the scheduled run. It does not put Diary back inside the EPG commit.
2. Do not set `RATINGS_PIPELINE=inline` and do not delete the binding as a rollback. The Worker ignores the binding. After the leftover binding is deleted, code from before ADR 0074 must not be deployed until `RATINGS_PIPELINE=separate` is restored and read back: that older code treats a missing binding as `inline`.
3. Once migrated (cutover step 3), a code revert is **not** a rollback of R2. Earlier code prunes the version 2 queue without its references and writes the cursor back as version 1. Undoing it needs a separate owner decision on the stored objects. A run left `running` stays until a later start closes it.

## Historical rollback (AIR-51)

These steps described turning the gate off. They are not current. Current rollback is [above](#rollback-of-this-retirement).

1. The owner used to set `LETTERBOXD_DIARY_HISTORY=off`, or remove it, and read it back.
2. The next commit then made no diary history request. That is no longer true: the ratings run still reads page 1, and the EPG commit does not read Diary either way.
3. `letterboxd/diary/history.json` and `state.json` stay. Deleting them is a separate owner-approved storage operation. A code revert does not delete them.
