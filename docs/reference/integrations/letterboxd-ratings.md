# Letterboxd ratings — retired refresh, EPG ratings and the separate pipeline

[AIR-64](https://trello.com/c/WTnyO8bX) added an owner-triggered ratings-only refresh behind `RATINGS_REFRESH`. [AIR-92](https://trello.com/c/yP6I0sjp) retired it ([ADR 0040](../../adr/0040-retire-ratings-only-refresh.md)) after the [AIR-85](https://trello.com/c/NVS7Ywdq) preflight found the public films list answering HTTP 403 with an anti-bot page on page 2. This path never tried to get past that challenge, and no replacement scraper exists.

## What answers now

`POST /api/enrichment/ratings/refresh` answers `410 Gone` with `{"error":"gone","detail":"…"}` for every method, body and value of `RATINGS_REFRESH`. The Worker returns before it parses the body: no Letterboxd request, no lease, no bucket read, list or write. Nothing in the Worker reads `RATINGS_REFRESH` any more; the `feature_flags` readout lists it as retired so a stale binding stays visible ([feature flags](../feature-flags.md)).

`GET /api/enrichment/ratings/status` still only reads. It returns the stored `enrichment/ratings/status.json` (or an `idle` placeholder when none exists) with `generationId` and `pendingGenerationId` resolved from `enrichment/ratings/published.json` and `enrichment/ratings/pending.json`, and always `enabled: false`. The fields keep their AIR-64 meaning: `state` is `idle`, `healthy`, `degraded` or `blocked`; `lastSuccessAt` is the last complete films list the retired refresh read; `attempt` is its last call. No code path writes these objects any more, so the values are the last ones the refresh wrote.

The integration footer does not use this document for current ratings health; that comes from the EPG commit fields in `sync.json` ([enrichment API](../api/enrichment.md)). The footer only reports the document as the `retiredRefresh` history of the `letterboxd_ratings` source, labelled in the UI as the retired separate refresh with its last attempt time and outcome. `manualRefreshEnabled` on that source is always `false`.

## Where ratings come from

- **Ratings run, Diary page 1** ([ADR 0054](../../adr/0054-diary-first-epg-ratings.md), [ADR 0067](../../adr/0067-diary-recent-window.md), [ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md), [ADR 0075](../../adr/0075-retire-letterboxd-diary-history-switch.md)).
  - When migration is complete, the [diary history stage](letterboxd-diary-history.md#rating-facts) runs on the ratings run and turns each film on page 1 into a watched fact. Where the diary proves one, it also writes a rating fact, observed at the watched date. `LETTERBOXD_DIARY_HISTORY` is retired and does not select this.
  - The EPG commit does not read Diary. The public films list is not requested after a commit.
  - A blocked or failed diary ends the ratings run `error` and leaves every stored rating in place.
  - Attempts written while Diary still ran inside the commit are described under [Ratings attempt](#ratings-attempt). That marker is not written by the current commit.
- The per-film lookup and the owner `PUT /api/enrichment/actual-ratings` write single ratings through the fact records ([user facts contract](letterboxd-user-facts.md)); no switch selects a legacy writer ([ADR 0055](../../adr/0055-retire-letterboxd-facts-switch.md)).
- A watchlist removal event still receives a half-star rating when the per-film lookup records one.
- A historical removal event receives an already stored half-star when a ratings removal step links a rated legacy entry of that exact film id ([ADR 0071](../../adr/0071-legacy-removal-event-link.md)). The removal is not itself a viewing, and a missing rating is not invented.
- The films-list scan (`refreshRatingsFromFilms`) and the diary and baseline repairs stay in the code but are not part of the EPG commit. A stored films-list summary remains the floor of later observations.

## Ratings attempt

[AIR-270](https://trello.com/c/DJ6Jvg4F). The ratings work after an EPG commit carries a durable marker, `sync.json` `ratingAttempt`, also returned by the sync status:

| Field | Meaning |
| --- | --- |
| `id`, `startedAt` | One attempt per commit that still has `ratingPending` |
| `phase`, `at` | The phase entered last and when, on attempts this commit used to write: `post_commit` (saved with `stage: complete`, covers the prediction queue refresh), `diary`, `removal_lookup`. Attempts written before ADR 0054 may name `films_list` or `repair`. The current commit does not open this marker |
| `state` | `started` (work in progress), `finished`, `error` or `unknown`. Historical `finished` with `source: letterboxd_diary` means the diary page was read (`recent_window`). Historical `finished` with `source: none` and `cause: diary_off` means the old gate was off. `error`: the diary ended `blocked`, `rate_limited` or `failed`. `unknown`: closed after an interruption. The current ratings run records its own outcome on `letterboxd/ratings/run.json`, not here |
| `source` | Historical: `letterboxd_diary`, or `none` when the old diary gate was off |
| `finishedAt`, `closedAt`, `cause`, `interruptedPhase` | End of a finished or failed attempt; for `unknown`, when it was closed and the phase it died in |

Each phase is saved before its work starts and logged as `{"event":"epg_ratings_phase","runId",…,"phase"}`, so Workers Observability shows the last phase before an `exceededMemory` or time-limit end of the request.

**Recovery.** A later `/api/sync/epg` step on the completed run, before the discovery continuation, closes an attempt that is still `started` and whose last phase is older than five minutes (or, for a run written before this marker, `ratingPending` on a run updated more than five minutes ago): `state: unknown`, `cause: interrupted`, `interruptedPhase`, `ratingError` "Ratings step interrupted during <phase>; no outcome recorded" and `ratingPending` removed. It never reads the diary again, writes no programme, generation or event, and leaves a finished or failed attempt alone; further steps change nothing. The EPG commit does not read Diary ([ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md)). A later ratings run reads page 1; its history and facts writes are idempotent. An interruption is reported as a failure, never as a success.

## Removed films

`REMOVAL_RATING_LOOKUP` is retired ([ADR 0077](../../adr/0077-retire-removal-rating-lookup-switch.md), [ADR 0043](../../adr/0043-removal-rating-lookup-queue.md), [AIR-268](https://trello.com/c/7ePpEYev)). A removal event no longer waits for a complete films list. After the storage migration the ratings run looks up removed films the Diary did not rate. The binding does not select that lookup. The EPG commit does not ([ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md)): it only enqueues references when migration is complete. Films the Diary rated get that rating on the removal event during the ratings run. A blocked Diary leaves those films to the lookup, and the run still ends `error` with the Diary cause:

- **Queue.** `enrichment/removal-rating-lookups.json` keeps one entry per film id: `url`, `state` (`pending`, `rated`, `not_rated`, `not_found`, `conflict`, `gave_up`), `attempts`, `enqueuedAt`, `nextAttemptAt`, `lastAttemptAt`, `lastResult`, `lastError`, and `rating` once found. A film already in the queue is not added again. A pending film is not dropped by the cap: after 14 days it becomes `expired` (no more requests). An `expired` entry is deleted 28 days after `enqueuedAt`, other finished entries after 14 days, and at most 100 non-pending entries, `expired` ones included, are kept; the cap never removes a pending film. A film removed again while its entry is still stored gains no new entry, so the second removal event is not queued. Every write is a compare-and-swap. These are the version 1 rules; after the storage migration the queue follows [version 2](#removal-queue-version-2), keyed by removal event, and the ratings run is the only writer.
- **Bounded requests.** One call requests the member page `/<user>/film/<slug>/` of at most five due films, oldest first; the others stay pending for the next call. The attempt is recorded before the request, so a request killed mid-lookup counts the attempt and retries no sooner than an hour later. A film gets at most three attempts in all.
- **Outcomes.** A rating found goes through the existing per-film path (fact record, `actual.json`, view index, removal event with `ratingObservedAt`); the first confirmed rating on an event is never replaced. A page without the owner's rating is retried after 24 hours and becomes final `not_rated` after the third attempt; it never marks the film watched. A 404 is final `not_found`.
- **Upstream blocks.** A 403 or 429 stops the batch at once, no request is repeated, and the whole queue waits six hours (`pausedUntil`, `pausedBy`) because the block is about the source, not the film. A network or 5xx error retries that film after an hour.
- **Independence.** The lookup runs inside the ratings step, not the EPG commit. An error stays on that step. A film left pending is retried on a later ratings step. A summary stored on an older `sync.json` as `removalRatingLookup` is not written by the commit.
- **Recovery.** A hand-over left on `sync.json` (`removalRefs` or `removalLookups`) stays there while migration is not complete. Once migration is complete, the next `/api/sync/epg` step on that run, or the next `beginSync`, enqueues it and requests nothing from Letterboxd. There is no lookup replay on the commit.

## Separate ratings pipeline

[ADR 0060](../../adr/0060-independent-letterboxd-ratings-pipeline.md) and [ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md). Code: [`src/letterboxd-ratings.js`](../../../src/letterboxd-ratings.js). `RATINGS_PIPELINE` is retired and unread ([feature flags](../feature-flags.md)). Tools and routes: [MCP reference](../api/mcp.md#ratings-tools). Operation: [runbook](../../runbooks/letterboxd-diary-history.md#separate-ratings-pipeline).

**When it acts.** When the [storage migration](#storage-migration-and-witness) is `complete`, for every value of the retired binding, including absence. Otherwise:

- the EPG commit publishes and fails closed: no Diary read, no member-page lookup, no enqueue, no automatic migration. It still writes the removal event and stores `removalRefs` on `sync.json`. A later blocked commit keeps the earlier references and appends its own. `ratings_sync_status` is unchanged by that, and `sync.json` and the reply carry `ratingsPipeline: blocked` and `ratingsMigration`;
- `ratings_sync_start` and `ratings_sync_step` answer `not_migrated` and write nothing;
- `ratings_sync_status` still reads, with `switch: separate` and `pipeline: blocked`.

`switch: separate` is the permanent mode. It does not prove the binding is absent. `feature_flags` does.

### The EPG commit under the separate pipeline

- **No ratings work.** The commit makes no Diary or member-page request, writes no `ratingPending`, `ratingAttempt`, `diaryHistory` or `removalRatingLookup`, and its reply and `sync.json` carry `ratingsPipeline: separate`.
- **Durable enqueue.** The films the watchlist diff removed are saved with the run as `removalRefs {ref, films}`: `ref` names the removal event (`eventKey`, `sourceRunId`, `at`). Before publication they are added to the queue as references and `removalRefs` is cleared. The retired binding is not read, and the enqueue never requests anything.
- **Recovery.** If the request dies between saving `sync.json` and the queue write, the next `/api/sync/epg` step on that run, or the next `beginSync`, adds the saved references. A replay of the same event adds nothing. While migration is not complete the same `removalRefs` value stays on `sync.json` and is not enqueued; one value is `{ref, films}`, and consecutive blocked commits store a list of those. The next start or step after migration is complete enqueues every one. `ratings_storage_migrate` copies them into the queue as well and does not delete them from `sync.json`. A version 1 hand-over still in `sync.json` (`removalLookups`) is converted the same way: films the saved watchlist event removed get that event as their reference, others become legacy entries.

### Run record — `letterboxd/ratings/run.json`

One record holds the running or the last run, written only by compare-and-swap.

| Field | Meaning |
| --- | --- |
| `runId`, `trigger`, `startedAt`, `lastStartAt` | The run and how it started (`scheduled` or `manual`). `lastStartAt` is the same instant as `startedAt` on this record and is not a gate between starts |
| `state` | `running`, `finished`, `error` (the Diary ended `blocked`, `rate_limited` or `failed`; `cause` names it) or `unknown` (closed after an interruption) |
| `phase` | `diary`, `removal`, then `done` |
| `lease` | `{step, expiresAt}`: the id of the step that owns the record and its expiry, three minutes after the step began |
| `checkpoint` | `diaryPagesRead`, `diaryNextPage`, `diaryMode`, `removalChecked`, `legacyPagesLinked`: this run's counters. The Diary cursor and the queue are the authority; the checkpoint never plans another run's read. `legacyPagesLinked` counts event-list pages saved for a rated legacy entry ([ADR 0071](../../adr/0071-legacy-removal-event-link.md)). An absent value compares as 0, so a run stored before the field still matches a new run that linked no page; 0 does not match 1. Other checkpoint fields still treat absence as null |
| `pinned` | At start: the published `programmeRunId` and the number of pending queue entries |
| `diary`, `removal` | Summaries: outcome, stop reason, pages, counts (including `overflowSuspected`), `historicalCoverage` (`incomplete` after a page-1 write), facts and queue entries resolved by the Diary; references settled (`written`, `resolved`, `waiting` for a missing event, `mismatched`, `left`) and lookups (`checked`, `rated`, `notRated`, `failed`, `refused`, `stoppedBy`, `pausedUntil`) |
| `outcome`, `cause`, `interruptedPhase`, `finishedAt`, `closedAt` | End of the run. A recent window has `cause: null`. A blocked, rate-limited or failed Diary is the `cause`. The retired binding does not end a run as `diary_off` |
| `isolation`, `isolationClearedAt` | See [isolation](#stale-runs-and-isolation) |
| `lastStepError` | The last exception a step threw, with its phase, the lease released |
| `recent` | The ten most recent runs as summaries, newest first |

### Start and step

- **Start** (`trigger`, optional `clearIsolation`). Answers `started` with a new `runId`, or one of:
  - `busy`: a run is active; its id is not handed out;
  - `isolated`, with `isolation`;
  - `not_migrated` (with `migration`) when storage is not migrated. There is no `disabled` answer.

  Neither `scheduled` nor `manual` is refused for following the previous start ([ADR 0069](../../adr/0069-no-scheduled-ratings-start-gap.md)). A stale `running` record is first closed as `unknown`. A start makes no Letterboxd request.
- **Step** (`runId`). Takes the lease by compare-and-swap, does one bounded piece of work, writes the record only while its lease holds, then releases it. Answers:
  - `continue` / `more_work`;
  - `wait` / `busy` while another step's lease is live, not before `nextCatchUpAt`;
  - `stop` with `finished`, `error`, `unknown` (a stale run closed by this call), `run_mismatch`, `not_running`, `lease_lost` or `not_migrated`.
- **Diary phase.** One GET of `https://letterboxd.com/<user>/diary/` per run ([ADR 0067](../../adr/0067-diary-recent-window.md), [ADR 0075](../../adr/0075-retire-letterboxd-diary-history-switch.md)). The retired `LETTERBOXD_DIARY_HISTORY` binding is not read. A checkpoint with `diaryPagesRead >= 1` does not fetch. No request is started once less than 45 seconds of the lease remain (`step_budget`); the step answers `continue` so the same run retries that page. After the page: the history merge, that page's facts, the queue entries the Diary rated (`rated`, `lastResult: diary`), the cursor join, then the checkpoint. A successful page is `recent_window` / `recent_window_only` and does not fetch another page. A blocked, rate-limited or failed Diary ends the run `error`; stored facts and history stay. `resumePage` is not a URL.
- **Removal phase.**
  1. While a legacy entry is `rated` with a confirmed half-star and its event scan is not done, list one page of `events/items/` (20 keys) and attach a reference for each stored watchlist event that removed that exact film id ([ADR 0071](../../adr/0071-legacy-removal-event-link.md)). The cursor is `legacyLink` on the queue. The entry is not reopened and no Letterboxd request is made. A step with nothing left to link does not list. A late step deletes an obsolete cursor only when the queue still has the ids and cursor that step read and those ids are still not candidates; it does not erase a newer scan, and the checkpoint counts a page only for a queue write that step committed. While the scan is unfinished the step answers `continue` (`stoppedBy: legacy_link`, unless settle still has a backlog). Retention does not run until the scan is done.
  2. Rated entries with unresolved references get their rating written to each referenced removal event, at most 100 references per step, least recently checked first. A run visits each reference once: references checked since the run started are skipped, and while unvisited ones are left the step answers `continue` (`stoppedBy: settling`). A reference is resolved only once the stored event lists the film as removed with a confirmed rating. Otherwise it stays unresolved with `checkedAt` and `issue`: `event_missing` (the event is not stored, for example a commit that never wrote it), `film_not_in_event` or `event_unrated`. So references that never resolve neither keep a run going nor hide later ones, and the next run starts with those it has not checked for longest. A confirmed rating already on the event is left in place.
  3. The [retention rules](#removal-queue-version-2).
  4. At most five member-page lookups per step, oldest due entry first, for a film the Diary did not already rate, with the claim, attempt, pause and outcome rules of [removed films](#removed-films) ([ADR 0077](../../adr/0077-retire-removal-rating-lookup-switch.md)). The retired `REMOVAL_RATING_LOOKUP` binding is not read. While due entries remain the step answers `continue`; each claim moves the entry's next attempt at least an hour ahead, so a run ends once none is due. A paused queue ends the lookups with the pause. There is no `lookup_off` stop.
- **Lease lost.** A step whose lease ran out, or whose record another writer took, writes nothing more to the record and answers `lease_lost`. What it already merged into the cursor, history, facts, queue and events stays: those merges only move forward.

### Stale runs and isolation

- **Stale.** A `running` record is `interrupted` when an active step's lease has expired, and `abandoned` when no step has begun or ended for 30 minutes. Only a start or a step closes it: `state: unknown`, `cause`, `interruptedPhase`, `closedAt`. It is never resumed. `ratings_sync_status` reports `stale` and never closes anything.
- **Isolation.** Two consecutive runs closed as `interrupted` in the same phase at the same checkpoint set `isolation {since, phase, checkpoint, runIds}`. Starts then answer `isolated` until a start with `trigger: manual` and `clearIsolation: true` clears it (`isolationClearedAt`). `clearIsolation` with a scheduled trigger is a `400`.

### Removal queue version 2

The same object, `enrichment/removal-rating-lookups.json`, with `schemaVersion: 2`, `droppedRefs` and `migratedAt`. `films[id]` stays the unit of lookup.

- **References.** `refs` lists every removal event that removed the film: `{eventKey, sourceRunId, at, resolved}`, plus `checkedAt` and `issue` once a settle has tried it. A replay of the same event adds nothing. A new reference on a finished entry reopens it: `pending`, no attempts, fresh `enqueuedAt`, no claim. Past 20 references the oldest resolved one is dropped, or the oldest unresolved one when none is resolved, and counted in `droppedRefs`.
- **Legacy entries.** Version 1 entries and films without an event to name become `legacy: true` with `refs: []`. An entry that is not `rated` with a confirmed half-star still promises nothing for an event and is pruned by the version 1 rules. A rated one is linked, once, to existing removal events of the same film id by the ratings removal step ([ADR 0071](../../adr/0071-legacy-removal-event-link.md)): one page of 20 keys per step, exact id only, no new lookup. When that scan finishes, a match drops `legacy` and leaves the new references unresolved until settle; no match keeps `legacy` and sets `legacyLink.done` so later steps do not list. The EPG commit does not do this scan. Merging the code does not run it.
- **Claims.** A claim stores a random token; only the outcome carrying it is accepted, and only while the entry is still pending. A reopened entry has no claim, so a late outcome of the earlier lookup is refused (its attempt counted).
- **Retention.** An entry with an unresolved reference is never deleted, by age or by the cap. A pending entry still becomes `expired` after 14 days. Entries whose references are all resolved, legacy ones included, follow the version 1 rules. Those rules wait while a rated legacy scan is unfinished, so an unmatched `refs: []` entry is not deleted between pages.
- **Writers.** Every write is the read-apply-compare-and-swap of the queue and branches on the version read in that attempt, so a writer that started on version 1 follows version 2 once the migration lands.
- **EPG commit.** When migration is complete the commit stores the removal event as the reference and does not look the film up. When it is not, the commit does not enqueue. The ratings run's member-page lookup does not read `REMOVAL_RATING_LOOKUP`.

### Storage migration and witness

`ratings_storage_migrate` is the only conversion. It makes no Letterboxd request and is refused (`refused: run_running`) while a ratings run is running and not stale.

- **`dry_run`** writes nothing. It reports, per object, `would_migrate` or `already`, with the predicted counts: queue entries, legacy entries, references and unresolved references, the version 1 hand-over in `sync.json`, and the cursor's coverage, resume page and last attempt.
- **`apply`**:
  1. Converts the queue by one compare-and-swap.
  2. Records it in the witness `letterboxd/ratings/migration.json` (`queue.migratedAt`).
  3. Gives the Diary cursor its [merge form](letterboxd-diary-history.md#run-state--letterboxddiarystatejson) by a second compare-and-swap.
  4. Records that (`cursor.migratedAt`).

  An object already converted is `already`. A failed queue leaves the cursor untouched, so the answer is `partial` or `none`, and a repeated `apply` continues.
- **`migration`** is derived on every read: `none`, `partial`, `complete`, or `regressed` when the witness records an object that is found back at version 1 (`regressedObjects`). Anything other than `complete` is fail-closed: the commit does not read Diary, and start and step answer `not_migrated`. It does not fall back to an inline Diary stage.

### Footer under the separate pipeline

When migration is complete, the `letterboxd_ratings` source of the integration footer comes from the run record, with `pipeline: separate`:

- `ok`, with freshness from the last finished run;
- `running`;
- `degraded` (`ratings_pending`) for an isolated, stale or `unknown` run;
- `degraded` or `failed` for a Diary that ended `blocked`, `rate_limited` or `failed`;
- `unknown` (`no_data`) before the first run.

`lastSuccessAt` and `lastFailureAt` come from the run and the ten recent runs. When migration is not complete the source is `degraded` / `ratings_migration_blocked` with `pipeline: blocked`, and old `sync.json` rating fields are not used.

## Rollback

**Separate pipeline.** The retired `RATINGS_PIPELINE` binding cannot put Diary back inside the EPG commit. Disabling the Ratings Task stops the scheduled run; it does not change the commit. Setting that binding to `inline`, or deleting it, does not restore a Diary stage on the commit. After `ratings_storage_migrate apply`, a code revert to a version without these rules is not a rollback: that code ignores the references, so its pruning can delete entries with unresolved ones, and it writes the cursor back as version 1 (`migration: regressed`). Code from before ADR 0074 treats a missing `RATINGS_PIPELINE` binding as `inline`. After the leftover binding is deleted, that code must not be deployed until `RATINGS_PIPELINE=separate` is restored and read back. Undoing the migration needs a separate owner decision on the stored objects.

**Diary gate.** `LETTERBOXD_DIARY_HISTORY` is retired ([ADR 0075](../../adr/0075-retire-letterboxd-diary-history-switch.md)). Setting it to `off` or deleting it does not stop Diary page 1. After that binding is deleted, code from before ADR 0075 must not be deployed until `LETTERBOXD_DIARY_HISTORY=on` is restored and read back: that older code skips Diary when the binding is absent. A revert does not roll back Diary history, the cursor, facts or the removal queue.

**Removal lookup.** `REMOVAL_RATING_LOOKUP` is retired ([ADR 0077](../../adr/0077-retire-removal-rating-lookup-switch.md)). Setting it to `off` or deleting it does not stop the member-page lookup. After that binding is deleted, code from before ADR 0077 must not be deployed until `REMOVAL_RATING_LOOKUP=on` is restored and read back: that older code skips the lookup when the binding is absent. A revert does not roll back rating facts, the queue or removal events. After the deletion the lookup cannot be turned off by a flag.

**Retired refresh.** Reverting the code restores the AIR-64 route behind `RATINGS_REFRESH`, which is unset in production (read 2026-10-29 05:16 UTC). Bringing the refresh back for real is a new decision under a new ADR, not a flag change. Deleting `enrichment/ratings/` is a separate owner-approved storage operation; the view index keeps the ratings already projected.

## Kept objects

The retirement deletes nothing. `enrichment/ratings/status.json`, `published.json`, `pending.json`, `lease.json` and `generations/<id>.json` stay in R2 as written. The view index keeps every `actualRating` already projected from a generation. A leftover `pending.json` is no longer finished by anyone; `status` reports its id as `pendingGenerationId` and the view index is unaffected by it.
