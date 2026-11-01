# ADR 0060: Letterboxd ratings run as their own leased, checkpointed pipeline, driven by a separate Scheduled Task through dedicated MCP tools

**Status:** Accepted  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** The owner explicitly accepted ADR 0060 and visually approved both rendered Mermaid diagrams in `docs/architecture/scheduling-and-orchestration.md` on 2026-10-31 (Europe/Madrid), after a [positive independent review](https://github.com/vladimino/iptv-watchlist/pull/266#pullrequestreview-5721734814) of reviewed HEAD `31d0370dc58522cc89f6593d2793d1aa4dbbc060` and successful PR CI. [Owner decision recorded in PR #266](https://github.com/vladimino/iptv-watchlist/pull/266#issuecomment-6540460858); [AIR-296 owner-gate record](https://trello.com/c/6lFnWkr8#comment-6ae5947f3c4913889317726e). Approval covers the architecture and documentation only; no production migration, R2/D1 write, flag change, Scheduled Task change or manual ratings/EPG run is authorized.  
**Related work:** [AIR-296](https://trello.com/c/6lFnWkr8) (this decision); [AIR-294](https://trello.com/c/IzWiVABa) (code); [AIR-295](https://trello.com/c/VtFZ6cci) (production cutover); [AIR-263](https://trello.com/c/uNoGwtid) and its [memory profile](../evidence/epg-diary-oom-profile-2026-10-30.md); [AIR-288](https://trello.com/c/bpXgN1nV); [AIR-293 staging record](../evidence/scheduled-tasks-drift-and-ratings-staging-2026-10-30.md); [ADR 0005](0005-external-chatgpt-tasks.md); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0043](0043-removal-rating-lookup-queue.md); [ADR 0049](0049-letterboxd-diary-viewing-history.md); [ADR 0054](0054-diary-first-epg-ratings.md)  
**Supersedes:** In part: [ADR 0054](0054-diary-first-epg-ratings.md) decision 1 (where the diary is read) and decision 6 (where the attempt is recorded); [ADR 0049](0049-letterboxd-diary-viewing-history.md) decisions 2 and 3 (one read and three pages per EPG commit, run state written last); [ADR 0043](0043-removal-rating-lookup-queue.md) decisions 1, 2, 3 and 6 (when films are queued and looked up, the entry identity and retention, how the hand-over is replayed, what the switch gates). Every other decision of those records stays.  
**Superseded by:** [ADR 0067](0067-diary-recent-window.md) (Accepted 2026-10-31) in part: the Diary-phase page budget (three pages a step, nine a run) and the use of `resumePage` as the next unread page. [ADR 0069](0069-no-scheduled-ratings-start-gap.md) (Accepted 2026-10-31) in part: the six-hour minimum between scheduled starts (`too_soon` in decision 7). [ADR 0071](0071-legacy-removal-event-link.md) (Accepted 2026-10-31) in part: a rated legacy entry is linked to existing removal events of the same film id. [ADR 0073](0073-retire-ratings-pipeline-switch.md) (Proposed 2026-11-01) in part: the `RATINGS_PIPELINE` switch, the inline default, `separate_pending_migration` and the `disabled` answer. The cursor join, lease, the 403/429 queue pause, the migration shape and the promise of an unrated legacy entry stay.

## Context

- **Ratings live inside the EPG commit.** `epgSync` ends with `completeWithRatings`: after the generation publish, `finishSync` and the prediction queue, the same request reads up to three Diary pages, writes facts per page and runs up to five removal lookups (`src/worker.js`, ADR 0054).
- **That request dies.** On 2026-10-30 the first production run with `LETTERBOXD_DIARY_HISTORY=on` ended with `exceededMemory` two seconds into phase `diary`, before the first diary history commit ([AIR-288](https://trello.com/c/bpXgN1nV), [AIR-263 profile](../evidence/epg-diary-oom-profile-2026-10-30.md)). Offline, the publish peaks at 254 MB and up to 169 MB of commit garbage is still on the heap when the Diary stage starts; the stage itself needs about 13–30 MB live plus a 50 MB facts projection. The programme was published; the ratings attempt was closed `unknown`.
- **The ratings state is owned by the EPG run.** `ratingPending`, `ratingAttempt`, `diaryHistory`, `removalLookups` and `removalRatingLookup` are fields of `sync.json`. `beginSync` replaces `sync.json` with every new EPG run, so pending ratings work and an un-queued removal hand-over do not survive the next day's start. Ratings never run when the EPG run does not reach `complete`.
- **The Diary run state is written last.** `letterboxd/diary/state.json` is saved once, after the last page, by a plain write. A request killed after page 2 keeps both pages' history but loses the resume point, and two overlapping runs can overwrite each other's state.
- **The removal queue can drop work.** It holds one entry per film id and enqueues only an absent id, so a second removal of a film whose entry is still stored is not queued; `pruneRemovalLookups` deletes `expired` entries 28 days after enqueue and counts them toward the 100-entry cap (`src/enrichment.js`).
- **No caller owns ratings.** The EPG Task prompt was clarified on 2026-10-31 to call no ratings tool; a separate Ratings Task exists in the registry, disabled, because the Worker exposes no ratings contract ([staging record](../evidence/scheduled-tasks-drift-and-ratings-staging-2026-10-30.md)).

## Decision

Option B below. Its parts:

### 1. Ownership

| Workflow | Owns | Never does |
| --- | --- | --- |
| Daily EPG Task and the EPG commit | Programme, watchlist and its events, discovery, prediction queue; **enqueuing** every film the watchlist diff removed into the durable removal queue | Diary reads, rating facts, removal lookups, any ratings state |
| Ratings Task and the ratings run | Diary history and its facts (ADR 0049, ADR 0054 decisions 2–5), rating precedence (ADR 0023), removal ratings from the diary first and the per-film lookup after (ADR 0043), its own run, lease, checkpoint and `unknown` recovery | `epg_sync_start`, `epg_sync_step`, discovery, predictions |
| Hourly Task | Discovery catch-up and predictions | Any ratings tool |
| Drift monitor | Read-only checks of every active producer task, including the Ratings Task once it is enabled, and `ratings_sync_status` freshness | Any write |

### 2. Input provenance

- **Diary.** The ratings run reads the owner's public Diary itself; it does not depend on an EPG run, its stage or its watchlist.
- **Removed films.** The only input is the removal queue `enrichment/removal-rating-lookups.json` (decision 3). Every removal event that removed a film is referenced in it by its own key. The ratings run never reads `sync.json` or the live watchlist.
- **Pinned at start.** The run records the published `programmeRunId` and the queue's pending count at start, for the status only; nothing is gated on them.

### 3. The removal queue: one lookup per film, one reference per removal event

Today the queue holds one entry per film id and enqueues only an absent id, so a film removed, re-added and removed again while its first entry is still stored gets no entry for the second removal event; and `expired` entries are deleted after 28 days and count toward the 100-entry cap. Under `RATINGS_PIPELINE=separate` the queue becomes `schemaVersion: 2`; when and how it is migrated is decision 10:

- **Identity.** `films[id]` stays the unit of **lookup** (one member-page request serves every event of that film): `url`, `state` (the existing states, `expired` included), `attempts`, `nextAttemptAt`, `claim`, `lastResult`, `enqueuedAt`. The unit of **work** is a removal event: `refs` lists `{eventKey, sourceRunId, at, resolved}`, where `eventKey` is the removal event's object key (`events/items/<inverted time>-<event id>.json`) and `sourceRunId` the EPG run whose diff produced it.
- **Enqueue** is a compare-and-swap that adds an absent `(id, eventKey)` pair. A replay of the same event adds nothing. A new reference on a finished entry (any state but `pending`) reopens it: `pending`, `attempts: 0`, a fresh `enqueuedAt`; the earlier `lastResult` stays for the status.
- **Re-add** to the watchlist changes nothing in the queue: each reference stays bound to the removal event that happened.
- **Resolution.** When the entry becomes `rated` (by the diary or by the lookup), the rating is written to the event of every unresolved reference with the existing `writeEvent` compare-and-swap and merge, and each reference is marked `resolved` after its event write. A kill between the two leaves the reference unresolved and the next step repeats the idempotent event write. A later rewrite of the same event (an EPG replay) keeps the confirmed rating, as `mergeRemovalEvent` does today. `not_rated` after three attempts leaves the references unresolved: no rating found never means watched (ADR 0043 decision 5).
- **Retention.** An entry with an unresolved reference is never deleted, by age or by the cap. `expired` (14 days pending, no more requests) and every other finished entry with unresolved references (`not_rated`, `not_found`, `conflict`, `gave_up`) are kept and stay resolvable by the diary. Only entries whose references are all resolved fall under the existing 14-day and 100-entry pruning. The size is bounded by the distinct films ever removed and not yet rated; the status reports `unresolved`, and deleting such an entry is an owner-approved storage operation.
- **The one deliberate loss.** At most 20 references per film. A 21st drops the oldest resolved reference, or, when none is resolved, the oldest unresolved one, counted in the queue's `droppedRefs` and reported by the status and the Drift monitor.
- **Version 1 entries** carry no event key. On migration they become `refs: []` with `legacy: true`: their rating still becomes a fact and they are pruned by the old rules; they promise nothing for an event. A version 1 hand-over still in `sync.json` (`run.removalLookups`) gets its references from the watchlist event saved beside it in `run.events`; a film without such an event becomes a `legacy` entry.

**Under `separate`, the EPG commit enqueues, durably.** Under `inline` it keeps today's path (decision 10).

- The references are written to the queue in the same step that first saves `run.events` to `sync.json`, before the generation publish.
- `beginSync` flushes a `sync.json` hand-over that is not yet in the queue (a run killed between the event save and the enqueue) before it replaces `sync.json`.
- Enqueuing happens whatever `REMOVAL_RATING_LOOKUP` holds. The switch gates only the member-page requests, so a removal event is never dropped while the lookup is off; the diary can still rate it.
- The commit no longer sets `ratingPending` or `ratingAttempt`, runs no `completeWithRatings`, and its continuation steps no longer call `resumeRemovalLookups` or `closeInterruptedRatings`.

### 4. Run record and lease — `letterboxd/ratings/run.json`

One object, every write a compare-and-swap on its ETag:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `runId`, `trigger` (`scheduled`, `manual`) | Identity |
| `state` | `running`, `finished`, `error`, `unknown` |
| `phase` | `diary`, `removal`, `done` |
| `lease` | `{step, expiresAt}`. A step stores its random id and a three-minute expiry when it begins and clears `step` when it ends. The lease keeps live steps apart and owns `run.json`; it does not make writes to other objects safe, which decision 6 handles |
| `startedAt`, `updatedAt`, `finishedAt`, `closedAt` | Times |
| `checkpoint` | `{diaryPagesRead, diaryNextPage, diaryMode, removalChecked}`: progress of this run for the status and the run budget, written after each page and each lookup. It is a counter: the Diary cursor in `letterboxd/diary/state.json` and the queue are authoritative (decision 6) |
| `pinned` | `{programmeRunId, removalPending}` at start |
| `outcome`, `cause`, `interruptedPhase` | `cause` is `blocked`, `rate_limited`, `failed`, `diary_off`, `interrupted` (a step's lease expired) or `abandoned` (no step for 30 minutes) |
| `isolation` | `null`, or `{since, phase, checkpoint, runIds}` (decision 8) |
| `recent` | Summaries of the last ten finished runs |

The prefix `letterboxd/ratings/` is new; the retired refresh objects under `enrichment/ratings/` are neither read nor reused.

### 5. State machine

```
none / finished / error / unknown --ratings_sync_start--> running(diary)
running(diary) --step: up to 3 pages--> running(diary) | running(removal)
running(removal) --step: up to 5 lookups--> running(removal) | finished | error
running, step lease expired or idle 30 min --next start or step--> unknown (never resumed)
two interrupted runs, same phase and checkpoint --> isolated (start refuses)
```

A run between steps is still `running`: `lease.step` is empty and the next step may begin at once. It is stale only when an active step's lease has expired (`interrupted`) or no step has begun for 30 minutes (`abandoned`).

- **Diary phase.** One step reads at most three Diary pages with the existing order, overlap and stop rules (ADR 0049 decision 3). After each page: the history compare-and-swap, that page's facts (ADR 0054), then the **per-page checkpoint**: `letterboxd/diary/state.json` (now a progress join under compare-and-swap, decision 6), then `run.json` `checkpoint`. A run reads at most **three steps (nine pages)**; pages left are resumed by the next run from `resumePage`.
- **Removal phase.** During the diary phase, a queued film whose lid the diary proves rated is resolved on the spot: the entry becomes `rated` with `lastResult: diary` and its unresolved references get that rating (decision 3). The removal phase first finishes the event writes of `rated` entries with unresolved references, then looks up at most **five** due entries per step, with the existing claim-before-request, three-attempt, 403/429 six-hour pause and expiry rules (ADR 0043). A paused queue ends the phase for this run.
- **Outcome.** `finished` when the diary ended `complete` or `partial`; `error` with the diary's cause when it ended `blocked`, `rate_limited` or `failed`. A diary error still runs the removal phase, as ADR 0054 decision 5 requires.

### 6. Ownership of the run, monotone merges everywhere else

R2 has no transaction over several keys, and a compare-and-swap on one object cannot check the state of another. A step can pass its lease check on `run.json`, stall, outlive its lease, and then write a different key while a newer step or run is between its own lease compare-and-swap and its first write to that key. No per-object fence based on the run record can close that window, so the design does not try: **only `run.json` is owned; every shared object changes by a monotone merge**, so a late write from any step can add real progress and never move anything back.

| Object | Write rule (each a read, merge, compare-and-swap retry on that object alone) | A step that outlived its lease |
| --- | --- | --- |
| `letterboxd/ratings/run.json` | Compare-and-swap on its ETag, and only while `lease.step` is the step's own id | Refused; the step stops with `lease_lost`. Nothing it does later is counted in any run's budget or checkpoint |
| `letterboxd/diary/state.json` (the Diary cursor) | Progress join and deterministic diagnostics merge, below | Its page was really read and its history merged, so the join can only carry the cursor forward to include that page |
| `letterboxd/diary/history.json` | The existing per-page merge (ADR 0049) | Re-merges viewings it really read; idempotent |
| Rating facts and the view index | The newer-observation rule (ADR 0023, ADR 0054) | Writes the observation its own read made; an older observation never replaces a newer one |
| Removal queue entry | Monotone entry transitions, below | A real outcome under its own claim is accepted; otherwise refused, its attempt already counted |
| Removal events | `writeEvent` compare-and-swap and merge; the first confirmed rating on a film in an event is never replaced | May write a rating it really observed to a still-unrated reference; never replaces one |

- **The Diary cursor: a convergent progress part and a diagnostic part.** `letterboxd/diary/state.json` is merged in two parts with different guarantees.
  - *Progress*, the only part that plans reads: `coverage.newestWatchedDate` takes the later, `coverage.oldestWatchedDate` the earlier, `coverage.reachedEnd` is true if either is, and `resumePage`, the **next unread backfill page**, is `null` once `reachedEnd` is true and otherwise the larger of the two, an absent value counting as page 2 (the existing start rule). This is a join: commutative, associative and idempotent, so every interleaving converges to the same progress and none moves it back. The larger page is the authoritative next unread page, not just a maximum, because no gap can open below it: a page enters the cursor only after its history merge, and every writer's backfill reads a contiguous range that starts at or before the `resumePage` it read (one page of overlap, ADR 0049), which is never above the cursor's current value; so the union of committed pages is contiguous up to that value. A page read twice adds nothing.
  - *Diagnostics*: `lastAttemptAt`, `lastSuccessAt` and `lastFailureAt` each take the later (a join too); `lastOutcome`, `stopReason`, `counts` and `writer {runId, step}` move together as one record, last writer wins, ordered by `(lastAttemptAt, writer.runId, writer.step)` compared lexicographically. Ids are random and distinct, so the order is total and the merge is deterministic for any order of arrival. The record is a report of the latest attempt; it never feeds planning, the run budget or a phase decision, and it is not part of the convergence guarantee beyond that determinism. Serialization is canonical (sorted keys), so equal states are equal bytes.
- **Queue entries move one way.** `attempts` only grows. A claim (before the request) requires the entry `pending` and due, adds one attempt, moves `nextAttemptAt` an hour on and stores `claim {token, at}` with a random token. An outcome is accepted only while `claim.token` is the step's own and the entry is still `pending`; it moves the entry to its result and clears the claim. A reference's `resolved` goes from false to true only. Only a new reference reopens a finished entry (decision 3), which clears any claim, so a late outcome for the earlier lookup is refused.
- **The edge between a lease and the first write.** Schedule: step A of run X stalls after reading page *n*; its lease expires; a start closes X `unknown` and step B of run Y takes the lease and reads `state.json`; A resumes, merges page *n* into the history and joins its cursor; B reads its page from the cursor it had read, merges it, and its own cursor compare-and-swap fails on the ETag A changed; B re-reads, joins and plans its next page from the joined cursor. Outcome: page *n* may be read twice, the cursor includes both pages, Y's budget counts only B's pages, and A's `run.json` write is refused. The same holds within one run: a step whose predecessor's lease expired closes the run instead of continuing it (decision 5).
- **Allowed late side effects.** At most one extra Diary page read or one extra member-page request per step that outlived its lease, the merges of what it really read, a cursor joined forward to include that page, a real outcome under its own claim, and a first rating on a still-unrated event. Never: a cursor or entry moved back, a run checkpoint, a run state, or a page counted in a run's budget.
- **Authority.** `state.json` is authoritative for Diary progress and the queue for lookups; the `run.json` `checkpoint` is a per-run counter for the status and the budget, written by the owning step after the cursor. A run never resumes from another run's checkpoint.
- **Crash at each edge of a page.** A killed step's run is closed `unknown` by the next start or step (decision 5), and the next run plans from the cursor. Killed before the history merge: the page is read again. After the history, before the facts: read again, the merge adds nothing, the facts are written. After the facts, before the cursor: read again, everything idempotent. After the cursor, before `run.json`: not read again; the closed run's counter lags by that page, which is reported, not resumed.

### 7. MCP and HTTP contract (owner-only, Access and JWT as every tool)

| Tool | Writes | HTTP route | Contract |
| --- | --- | --- | --- |
| `ratings_sync_status` | no | `GET /api/letterboxd/ratings/status` | `run` (fields above, `lease.live` and `stale` instead of the step id), `pipeline` (`inline`, `separate_pending_migration`, `idle`, `running`, `isolated`), `migration` (`none`, `partial`, `complete`, `regressed`), `diary` (`lastOutcome`, `coverage`, `resumePage`, `lastSuccessAt`), `removal` (`schemaVersion`, `pending`, `unresolved`, `legacy`, `expired`, `droppedRefs`, `pausedUntil`), `freshness` (`lastSuccessAt`, `lastFinishedAt`), `contractVersion`. **No write, not even recovery**: a stale run is reported as `lease.live: false`, never closed here |
| `ratings_sync_start` | yes | `POST /api/letterboxd/ratings/start` | `{trigger, clearIsolation?}`. Answers `{runId, created, nextAction, reason}`: `started`; `busy` (a `running` record that is not stale exists; its id is not handed out for adoption); `too_soon` (a scheduled start less than six hours after the last start); `isolated`; `disabled` (pipeline switch not `separate`); `not_migrated` (switch `separate`, storage not yet migrated). Closes a stale `running` record as `unknown` before deciding. `clearIsolation` is accepted only with `trigger: manual` |
| `ratings_storage_migrate` | on `apply` | `POST /api/letterboxd/ratings/migrate` | `{mode: dry_run \| apply}`. The only storage migration (decision 10); no Letterboxd request. Answers `{mode, migration, queue, cursor}`, each object `migrated`, `already`, `failed` or, on `dry_run`, `would_migrate`, with counts. Accepted under either switch value; refused while a ratings run is `running` |
| `ratings_sync_step` | yes, open world | `POST /api/letterboxd/ratings/step` | `{runId}`. One bounded step. Answers `{runId, state, phase, nextAction, reason, nextCatchUpAt, step, summary}`. `continue`: more work in this run. `wait`: `busy` (another step's lease is live; `nextCatchUpAt` is its expiry). `stop`: `finished`, `error`, `unknown`, `run_mismatch`, `not_running`, `lease_lost` |

The caller (the Ratings Task) calls `ratings_sync_start` once, then `ratings_sync_step` sequentially while `nextAction` is `continue`, honors `wait`, and never retries a `stop`. The tools join the MCP allowlist; `ratings_sync_status` is read-only and added to the GET side-effect tests.

### 8. Races, recovery and what cannot be promised

- **Exactly once is impossible.** A Letterboxd read and the R2 writes that follow are not one transaction, and a killed request leaves no trace of how far it got after its last checkpoint. The pipeline guarantees instead: idempotent writes (history merge, facts with the newer-observation rule, enqueue of absent `(id, eventKey)` pairs), monotone merges of every shared object (decision 6), checkpoints after every page and lookup, and a claimed attempt before every lookup request, so a kill repeats at most one page read and never grants a free lookup.
- **No writer retry on `unknown`.** A stale `running` record is closed `unknown` with `interruptedPhase` by the next start or step, never by the status read, and never resumed. The Task does not retry it; the next run starts from the durable checkpoints.
- **False `unknown`.** The lease (three minutes) exceeds a step's bound (three pages with 15-second timeouts plus their writes). A step checks its remaining lease before each page and each lookup and returns `continue` early when it is short. A step that still outlives its lease finds its next compare-and-swap refused, stops with `lease_lost`, and its finished page is idempotent; the run is reported `unknown`, honestly, not `finished`.
- **Two ratings runs.** Only one `running` record exists. A second start answers `busy`; a step while another step's lease is live answers `wait`; a step for an old `runId` answers `run_mismatch`. A step that outlived its lease is refused at `run.json`; elsewhere it can leave only the late side effects decision 6 lists, none of which moves a cursor or entry back.
- **EPG against ratings.** They share only idempotent or compare-and-swap objects: fact records and the view index (ETag retries, ADR 0023), the removal queue (the commit only adds absent `(id, eventKey)` pairs and reopens finished entries, the ratings run only claims, resolves and updates entries, each a compare-and-swap on the queue), removal events (`writeEvent` compare-and-swap; the first confirmed rating on an event is never replaced). Neither holds the other's lease, so neither can block the other.
- **First run and missing EPG.** The first run starts from whatever the Diary state holds (on 2026-10-30 none) and backfills nine pages per run. A run after a day without a completed EPG still reads the diary and works the queue; no new removals means nothing to lose.
- **Watchlist changed after capture.** The run never reads the watchlist. A film removed and re-added keeps its queue entry and the reference to its removal event; removed again, it gains a second reference and its entry reopens (decision 3). Facts are independent of watchlist membership (ADR 0023).
- **Isolation.** Two consecutive `interrupted` runs that died in the same phase at the same checkpoint mark `isolation`: starts answer `isolated`, the Drift monitor reports it, and only an owner-approved manual start with `clearIsolation` lifts it. This stops a daily memory-kill loop from re-reading the same page forever.
- **Queue never lost.** An entry with an unresolved reference is never pruned, by age or by the cap; only fully resolved entries follow the 14-day and 100-entry rules. The one deliberate, counted loss is a reference beyond 20 per film (decision 3).

### 9. Switch, status and transition

- **`RATINGS_PIPELINE`** (`inline` default, `separate`). Everything new in this record acts only on storage that `ratings_storage_migrate` has migrated: the run record, the ratings run tools, the queue's version 2 and the cursor merge. `separate` takes effect only once the migration is `complete` (decision 10). It is not registered in the deployed Worker and not set in production; its proposed definition is in the [feature flag register](../reference/feature-flags.md#proposed-flags-not-implemented), and it becomes a registered contract row only with the code, together with its removal card under the flag lifecycle. `inline` keeps today's commit path and the tools answer `disabled`; `separate` removes ratings from the commit and opens the tools. The two never run ratings together.
- The footer's `letterboxd_ratings` health reads `run.json` in `separate` and the `sync.json` fields in `inline`; EPG health never includes ratings.
- A `sync.json` written before the switch still carrying `ratingPending` is closed by the existing `closeInterruptedRatings` rule.

### 10. Inert deployment and an explicit, owner-approved migration

- **`inline` with version 1 objects keeps today's contents.** While the queue is `schemaVersion: 1` and the Diary cursor has no `writer`, the code under `inline` writes today's formats with today's rules: one entry per film id, today's pruning, today's cursor fields. One mechanism changes with the code: every write follows the version-aware rule below instead of a plain overwrite. Deploying the code therefore changes no stored content; offline tests compare its inline object contents with today's on the same fixtures.
- **Every writer is version-aware at its final write.** A process may read an object before the migration and publish after it, so no writer decides the format from an earlier read.
  - **Cursor writes.** The inline Diary stage still holds the cursor it read at its start. Its final write is conditional on the ETag of that read, no longer a plain `saveJSON`. When the condition fails, it re-reads the cursor and applies the rule of the version it finds now. On a version 1 cursor that is today's write. On a migrated cursor it converts its own result to the merge form, with `writer {runId: <the EPG run>, step: inline}`, and merges it (decision 6), so progress cannot move back and the `writer` marker cannot be erased.
  - **Queue writes.** Every queue mutation, inline enqueue, claim, outcome and pruning included, is the existing read, apply, compare-and-swap retry. Its apply function is re-run on the content read in that retry and branches on that content's `schemaVersion`. A version 1 enqueue that lands on a version 2 queue becomes the version 2 reference for its event, derived from the event saved with the hand-over, and version 2 entries are pruned only by version 2 rules.
  - **Migration writes.** `ratings_storage_migrate` writes with the same compare-and-swap. A writer that lands first changes the ETag; `apply` then re-reads and converts the newer content.
  - **No path is left.** No code path of this version writes either object unconditionally, so after `apply` returns `complete` no later write of this version can turn either object back into version 1.
- **Quiescence before `apply`.** Version-aware writes cover writers running this code. A request still running an older Worker version would not follow them, so the owner runs `apply` only when no such request can exist:
  - at least one routine EPG commit has completed on the deployed version that carries this rule;
  - `epg_status` shows `stage: complete` with no step in the last 15 minutes;
  - `apply` happens outside the daily EPG window.
  `apply` also refuses while a ratings run is `running`. A later `ratings_sync_status` that shows a migrated object back at version 1 reports `migration: regressed`. That is a defect, not a state: the cutover stops, and the next action is the owner's decision. Another `apply` is safe, because every conversion is a merge.
- **Only the migration tool migrates.** No commit, flush, ratings step or flag change converts storage. `ratings_storage_migrate` (decision 7) is the single trigger, and it runs under `inline`:
  - `dry_run` writes nothing and reports what `apply` would do: queue entries, `legacy` entries, references derivable from a hand-over still in `sync.json`, and the cursor's current progress.
  - `apply` converts the queue to version 2 by one compare-and-swap, then gives the cursor its `writer` and merge form by a second one. It is idempotent: an object already migrated is left alone and reported `already`.
  - Each object is reported `migrated`, `already` or `failed`, plus `migration`: `none`, `partial` or `complete`.
  - **Failure between the two writes** leaves `partial`, with the queue migrated and the cursor not. Each object follows the rules of its own version, under either switch value, so `partial` is safe; the remedy is another `apply`.
- **`separate` acts only on migrated storage.** While `migration` is not `complete`, `RATINGS_PIPELINE=separate` behaves as `inline`, `ratings_sync_start` answers `not_migrated`, and the status reports `pipeline: separate_pending_migration`. Setting the switch therefore never writes storage and never splits the pipeline on half-migrated objects.
- **Migrated objects stay migrated.** Under `inline`, the code finding a version 2 queue keeps version 2's enqueue and retention rules, and finding a cursor with `writer` keeps its merge. A migrated system under `inline` loses no reference and no retention; the commit keeps running ratings.
- **Cutover order, each step a separate owner-approved action, with its check and its way back:**

| Step | Check before the next step | If it fails or is abandoned |
| --- | --- | --- |
| 1. Read-only export of `enrichment/removal-rating-lookups.json` and `letterboxd/diary/state.json` | Both copies readable, and their sizes and hashes recorded | Nothing changed |
| 2. `ratings_storage_migrate` `dry_run` | The reported counts match the export | Nothing changed |
| 3. `ratings_storage_migrate` `apply`, still under `inline`, after the quiescence conditions above | Status shows `migration: complete`, `removal.schemaVersion: 2` with `unresolved` and `legacy` as `dry_run` predicted, and the cursor's progress (coverage, `resumePage`) equal to the export | `partial` or `failed`: repeat `apply`; the commit keeps running ratings under `inline` meanwhile |
| 4. `RATINGS_PIPELINE=separate` | Status shows `pipeline: idle`, and the next EPG commit reads no Diary and runs no lookup | Set `inline` back; storage is untouched by the switch |
| 5. One manual `ratings_sync_start` and its steps | The run ends `finished` or `error` with a recorded cause, and the cursor and queue moved forward only | Set `inline`; the commit resumes ratings on the same migrated objects |
| 6. Enable the Ratings Task, then extend the Drift monitor | The first scheduled run is visible in the status | Disable the task, then set `inline` |

- **A code revert is not the rollback once migrated.** Older code would read version 2 entries by `films[id]`, ignore `refs` and prune by version 1 rules. Before step 3, a revert is an ordinary code rollback. After it, the rollback is `inline` with the new code; reverting that code needs its own owner decision on the queue: keep version 2 and accept version 1 pruning, or restore the export and lose the references added since.

Not decided here: the Ratings Task's final prompt and time, its activation and the switch's production value ([AIR-295](https://trello.com/c/VtFZ6cci)); the run budget beyond nine pages; the bounded discovery ledger, which stays the commit's largest allocation; a D1 projection of the run record.

## Alternatives considered

- **(A) Ratings as the next `epg_sync_step` on the completed run, in the EPG Task.** The [AIR-263 profile](../evidence/epg-diary-oom-profile-2026-10-30.md)'s minimal fix: a fresh request with 13–30 MB live heap, reusing `ratingPending` and `ratingAttempt`. Rejected by the owner on 2026-10-31: ratings stay owned by the EPG run, so they are lost when `beginSync` replaces `sync.json`, never run when EPG fails, share the EPG Task's prompt and drift, and put a writer behind the continuation branch that the hourly task also reaches.
- **(B) A separate Ratings Task with its own MCP tools, run record and checkpoints.** Chosen.
- **(C) Keep ratings inline and lower the commit's memory** (bounded ledger, earlier release of the scan, forced collection). Rejected as the primary fix: the publish peak stays in the same request, workerd's accounting of uncollected garbage is not controllable or measured, and every daily run keeps the coupling and its kill risk. The ledger work remains useful on its own.

## Consequences

- **Isolation.** A ratings kill can no longer cost the programme, and an EPG failure no longer skips ratings. Each pipeline starts from a small heap in its own request.
- **New complexity.** One run object with a lease, four tools (`ratings_sync_status`, `ratings_sync_start`, `ratings_sync_step`, `ratings_storage_migrate`) on four routes under `/api/letterboxd/ratings/` (`status`, `start`, `step`, `migrate`), a switch, a fourth scheduled automation and its Drift checks. The Diary state becomes a monotone join under compare-and-swap; the removal queue gains event references and a second schema version.
- **Unbounded by time, bounded by films.** Unresolved removal entries are no longer pruned; their number is bounded by the distinct films removed and never rated, and they are visible in the status.
- **Ordering preserved.** Diary before lookup, per-page facts after each history commit, the observation rules of ADR 0054 and the queue bounds of ADR 0043 are unchanged; only their caller and checkpoints move.
- **Latency.** Ratings arrive at the Ratings Task's time, not with the commit; a removal event waits for that run.
- **Load.** At most nine Diary pages and five lookups per step budget per run, the same per-request bounds as today.

## Recovery and migration boundary

- **Code only, behind `RATINGS_PIPELINE=inline`.** Deploying the code changes no stored content: with version 1 objects, `inline` writes today's formats, only through version-aware conditional writes (decision 10). A code revert before the migration is an ordinary rollback.
- **Cutover** ([AIR-295](https://trello.com/c/VtFZ6cci)): the six steps of decision 10, each a separate owner-approved action with its own check and way back: export, migration `dry_run`, migration `apply` under `inline`, `separate`, one manual run, then the Ratings Task and the Drift monitor.
- **Rollback:** disable the Ratings Task, then set `RATINGS_PIPELINE=inline`; the commit runs ratings again from the same cursor and the same version 2 queue, keeping every reference and the retention rule. Objects under `letterboxd/ratings/` stay and are ignored. After the migration a code revert is not a rollback path; it needs the owner's queue decision of decision 10. No rollback restores R2, the switch or the task schedule.
- This record authorizes no flag, Task, EPG, Diary, lookup, R2 or D1 operation.

## Evidence

- **Original decision:** this record, [AIR-296](https://trello.com/c/6lFnWkr8); explicitly Accepted by the owner on 2026-10-31, with both changed Mermaid diagrams visually approved ([recorded decision](https://github.com/vladimino/iptv-watchlist/pull/266#issuecomment-6540460858)).
- **Implementation:** none; [AIR-294](https://trello.com/c/IzWiVABa).
- **Dated verification:** the incident and profile in the [AIR-263 report](../evidence/epg-diary-oom-profile-2026-10-30.md) and the [AIR-288 card](https://trello.com/c/bpXgN1nV); the code facts above were read at `main` `bbb9efe`.
- **Uncertainty:**
  - whether a ratings run in its own request stays under 128 MB in workerd (offline ranks only);
  - whether Diary page 2 answers the Worker;
  - whether nine pages per run and a six-hour minimum between scheduled starts suit the owner's diary volume;
  - how long a step takes in production; the three-minute lease is a proposal.

## Follow-ups

[AIR-294](https://trello.com/c/IzWiVABa) (code, tests, the switch with its removal card per the flag lifecycle), [AIR-295](https://trello.com/c/VtFZ6cci) (cutover and Drift monitor scope).

Tests the implementation must carry, offline, with an R2 fake that can delay and kill between any two writes:

- **Queue identity:** remove, re-add and remove a film while its first entry is `pending`, `rated`, `not_rated` and `expired`: two references, the entry reopened, both events rated once; a replay of either event adds nothing; a 21st reference drops as decision 3 states and is counted.
- **Retention:** an `expired` or `not_rated` entry with an unresolved reference survives 28 days and more than 100 finished entries; a fully resolved one is pruned by the old rules; version 1 entries migrate as `legacy`.
- **Resolution:** a kill between the event write and `resolved` repeats the event write and keeps the first confirmed rating.
- **Late writes:** the exact schedule of decision 6 — step A stalls after reading a page, its lease expires, a start closes the run and step B of a new run takes the lease and reads the cursor, then A merges its page and joins its cursor before B's first cursor write — ends with B's compare-and-swap retried, the cursor including both pages and never behind either, B's budget counting only B's pages, and A refused at `run.json`. The same with A's late write after B's cursor write, and with A's claim outcome after a reopening reference (refused) and without one (accepted). Property tests: any interleaving of cursor merges and entry transitions converges to byte-identical objects, including cursors with equal `lastAttemptAt` and different outcomes, counts or writers; the progress part never moves back; planning reads only the progress part.
- **Crash edges:** a kill before and after each of the history, facts, `state.json` and `run.json` writes of a page, and between the claim, the request and the outcome of a lookup: the next run re-reads at most that page, never moves the cursor back, never counts a page of a closed run in its own budget and never grants a free request.
- **Writers across the migration:** an inline EPG request reads the version 1 cursor and queue, pauses, `apply` migrates both and reports `complete`, then the request resumes and publishes. Assert the cursor keeps `writer` and its merge form with progress never behind either side, the queue stays version 2 with every reference, the hand-over becomes references, and the status stays `complete`. Repeat with the late write landing between the two `apply` writes, and with the queue claim, outcome and pruning paths.
- **Inert deployment and migration:** under `inline` with version 1 objects the object contents equal today's on the same fixtures, and no write is unconditional; no commit, flush, step or switch value migrates anything; `dry_run` writes nothing; `apply` migrates the queue (v1 entries `legacy`, a v1 hand-over referenced from its saved event) and then the cursor, is idempotent, and a kill between the two leaves a `partial` state that both switch values handle and a second `apply` completes; `separate` before `complete` behaves as `inline` and start answers `not_migrated`; `inline` after the migration keeps version 2 rules and the cursor merge.
- **Runs:** two concurrent starts, a step for an old `runId`, an interrupted and an abandoned run closed `unknown` by the next start and never by the status, isolation after two interruptions at the same checkpoint.
