# ADR 0059: Letterboxd ratings run as their own leased, checkpointed pipeline, driven by a separate Scheduled Task through dedicated MCP tools

**Status:** Proposed  
**Original decision date:** not decided (proposed 2026-10-31)  
**Recorded at:** 2026-10-31  
**Approval source:** not documented; the owner decides `Accepted` or `Declined` before merge. The owner's 2026-10-31 direction (a separate daily Ratings Task, no ratings ownership in the EPG Task) is recorded on [AIR-296](https://trello.com/c/6lFnWkr8); it chose the direction, not this record.  
**Related work:** [AIR-296](https://trello.com/c/6lFnWkr8) (this decision); [AIR-294](https://trello.com/c/IzWiVABa) (code); [AIR-295](https://trello.com/c/VtFZ6cci) (production cutover); [AIR-263](https://trello.com/c/uNoGwtid) and its [memory profile](../evidence/epg-diary-oom-profile-2026-10-30.md); [AIR-288](https://trello.com/c/bpXgN1nV); [AIR-293 staging record](../evidence/scheduled-tasks-drift-and-ratings-staging-2026-10-30.md); [ADR 0005](0005-external-chatgpt-tasks.md); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0043](0043-removal-rating-lookup-queue.md); [ADR 0049](0049-letterboxd-diary-viewing-history.md); [ADR 0054](0054-diary-first-epg-ratings.md)  
**Supersedes:** None while Proposed. On acceptance, in part: [ADR 0054](0054-diary-first-epg-ratings.md) decision 1 (where the diary is read) and decision 6 (where the attempt is recorded); [ADR 0049](0049-letterboxd-diary-viewing-history.md) decisions 2 and 3 (one read and three pages per EPG commit, run state written last); [ADR 0043](0043-removal-rating-lookup-queue.md) decisions 1, 3 and 6 (when films are queued and looked up, how the hand-over is replayed, what the switch gates). Every other decision of those records stays.  
**Superseded by:** None

## Context

- **Ratings live inside the EPG commit.** `epgSync` ends with `completeWithRatings`: after the generation publish, `finishSync` and the prediction queue, the same request reads up to three Diary pages, writes facts per page and runs up to five removal lookups (`src/worker.js`, ADR 0054).
- **That request dies.** On 2026-10-30 the first production run with `LETTERBOXD_DIARY_HISTORY=on` ended with `exceededMemory` two seconds into phase `diary`, before the first diary history commit ([AIR-288](https://trello.com/c/bpXgN1nV), [AIR-263 profile](../evidence/epg-diary-oom-profile-2026-10-30.md)). Offline, the publish peaks at 254 MB and up to 169 MB of commit garbage is still on the heap when the Diary stage starts; the stage itself needs about 13–30 MB live plus a 50 MB facts projection. The programme was published; the ratings attempt was closed `unknown`.
- **The ratings state is owned by the EPG run.** `ratingPending`, `ratingAttempt`, `diaryHistory`, `removalLookups` and `removalRatingLookup` are fields of `sync.json`. `beginSync` replaces `sync.json` with every new EPG run, so pending ratings work and an un-queued removal hand-over do not survive the next day's start. Ratings never run when the EPG run does not reach `complete`.
- **The Diary run state is written last.** `letterboxd/diary/state.json` is saved once, after the last page, by a plain write. A request killed after page 2 keeps both pages' history but loses the resume point, and two overlapping runs can overwrite each other's state.
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
- **Removed films.** The only input is the removal queue `enrichment/removal-rating-lookups.json`. Each entry gains `sourceRunId` (the EPG run whose diff removed it) and `eventKey` (its removal event). The ratings run never reads `sync.json` or the live watchlist.
- **Pinned at start.** The run records the published `programmeRunId` and the queue's pending count at start, for the status only; nothing is gated on them.

### 3. The EPG commit enqueues, durably

- The removed films are written to the queue in the same step that first saves `run.events` to `sync.json`, before the generation publish. Enqueuing is a compare-and-swap that adds only absent ids, so a replay adds nothing.
- `beginSync` flushes a `sync.json` hand-over that is not yet in the queue (a run killed between the event save and the enqueue) before it replaces `sync.json`.
- Enqueuing happens whatever `REMOVAL_RATING_LOOKUP` holds. The switch gates only the member-page requests, so a removed film is never lost while the lookup is off; the diary can still rate it.
- The commit no longer sets `ratingPending` or `ratingAttempt`, runs no `completeWithRatings`, and its continuation steps no longer call `resumeRemovalLookups` or `closeInterruptedRatings`.

### 4. Run record and lease — `letterboxd/ratings/run.json`

One object, every write a compare-and-swap on its ETag:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `runId`, `trigger` (`scheduled`, `manual`) | Identity |
| `state` | `running`, `finished`, `error`, `unknown` |
| `phase` | `diary`, `removal`, `done` |
| `lease` | `{step, expiresAt}`. A step stores its random id and a three-minute expiry when it begins and clears `step` when it ends; it owns the run only while its id is stored and unexpired |
| `startedAt`, `updatedAt`, `finishedAt`, `closedAt` | Times |
| `checkpoint` | `{diaryPagesRead, diaryNextPage, diaryMode, removalChecked}`: progress of this run, written after each page and each lookup |
| `pinned` | `{programmeRunId, removalPending}` at start |
| `outcome`, `cause`, `interruptedPhase` | `cause` is `blocked`, `rate_limited`, `failed`, `diary_off`, `interrupted` (a step's lease expired) or `abandoned` (no step for 30 minutes) |
| `isolation` | `null`, or `{since, phase, checkpoint, runIds}` (decision 7) |
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

- **Diary phase.** One step reads at most three Diary pages with the existing order, overlap and stop rules (ADR 0049 decision 3). After each page: the history compare-and-swap, that page's facts (ADR 0054), then the **per-page checkpoint**: `letterboxd/diary/state.json` (now a compare-and-swap, carrying `runId`) and `run.json` `checkpoint`. A run reads at most **three steps (nine pages)**; pages left are resumed by the next run from `resumePage`.
- **Removal phase.** During the diary phase, a queued film whose lid the diary proves rated is resolved on the spot: its removal event gets that rating, and the entry becomes `rated` with `lastResult: diary`. The removal phase then looks up at most **five** due entries per step, with the existing claim-before-request, three-attempt, 403/429 six-hour pause and expiry rules (ADR 0043). A paused queue ends the phase for this run.
- **Outcome.** `finished` when the diary ended `complete` or `partial`; `error` with the diary's cause when it ended `blocked`, `rate_limited` or `failed`. A diary error still runs the removal phase, as ADR 0054 decision 5 requires.

### 6. MCP and HTTP contract (owner-only, Access and JWT as every tool)

| Tool | Writes | HTTP route | Contract |
| --- | --- | --- | --- |
| `ratings_sync_status` | no | `GET /api/letterboxd/ratings/status` | `run` (fields above, `lease.live` and `stale` instead of the step id), `pipeline` (`idle`, `running`, `isolated`), `diary` (`lastOutcome`, `coverage`, `resumePage`, `lastSuccessAt`), `removal` (`pending`, `pausedUntil`, `expired`), `freshness` (`lastSuccessAt`, `lastFinishedAt`), `contractVersion`. **No write, not even recovery**: a stale run is reported as `lease.live: false`, never closed here |
| `ratings_sync_start` | yes | `POST /api/letterboxd/ratings/start` | `{trigger, clearIsolation?}`. Answers `{runId, created, nextAction, reason}`: `started`; `busy` (a `running` record that is not stale exists; its id is not handed out for adoption); `too_soon` (a scheduled start less than six hours after the last start); `isolated`; `disabled` (pipeline switch not `separate`). Closes a stale `running` record as `unknown` before deciding. `clearIsolation` is accepted only with `trigger: manual` |
| `ratings_sync_step` | yes, open world | `POST /api/letterboxd/ratings/step` | `{runId}`. One bounded step. Answers `{runId, state, phase, nextAction, reason, nextCatchUpAt, step, summary}`. `continue`: more work in this run. `wait`: `busy` (another step's lease is live; `nextCatchUpAt` is its expiry). `stop`: `finished`, `error`, `unknown`, `run_mismatch`, `not_running`, `lease_lost` |

The caller (the Ratings Task) calls `ratings_sync_start` once, then `ratings_sync_step` sequentially while `nextAction` is `continue`, honors `wait`, and never retries a `stop`. The tools join the MCP allowlist; `ratings_sync_status` is read-only and added to the GET side-effect tests.

### 7. Races, recovery and what cannot be promised

- **Exactly once is impossible.** A Letterboxd read and the R2 writes that follow are not one transaction, and a killed request leaves no trace of how far it got after its last checkpoint. The pipeline guarantees instead: idempotent writes (history merge, facts with the newer-observation rule, enqueue of absent ids), checkpoints after every page and lookup, and a claimed attempt before every lookup request, so a kill repeats at most one page read and never grants a free lookup.
- **No writer retry on `unknown`.** A stale `running` record is closed `unknown` with `interruptedPhase` by the next start or step, never by the status read, and never resumed. The Task does not retry it; the next run starts from the durable checkpoints.
- **False `unknown`.** The lease (three minutes) exceeds a step's bound (three pages with 15-second timeouts plus their writes). A step checks its remaining lease before each page and each lookup and returns `continue` early when it is short. A step that still outlives its lease finds its next compare-and-swap refused, stops with `lease_lost`, and its finished page is idempotent; the run is reported `unknown`, honestly, not `finished`.
- **Two ratings runs.** Only one `running` record exists. A second start answers `busy`; a step while another step's lease is live answers `wait`; a step for an old `runId` answers `run_mismatch`. Every checkpoint write is fenced by the `run.json` ETag and the step's id, so a zombie step cannot move a newer step's or run's checkpoint.
- **EPG against ratings.** They share only idempotent or compare-and-swap objects: fact records and the view index (ETag retries, ADR 0023), the removal queue (the commit only adds absent ids, the ratings run only updates entries), removal events (`writeEvent` compare-and-swap; the first confirmed rating on an event is never replaced). Neither holds the other's lease, so neither can block the other.
- **First run and missing EPG.** The first run starts from whatever the Diary state holds (on 2026-10-30 none) and backfills nine pages per run. A run after a day without a completed EPG still reads the diary and works the queue; no new removals means nothing to lose.
- **Watchlist changed after capture.** The run never reads the watchlist. A film removed and re-added keeps its queue entry and its removal event; facts are independent of watchlist membership (ADR 0023).
- **Isolation.** Two consecutive `interrupted` runs that died in the same phase at the same checkpoint mark `isolation`: starts answer `isolated`, the Drift monitor reports it, and only an owner-approved manual start with `clearIsolation` lifts it. This stops a daily memory-kill loop from re-reading the same page forever.
- **Queue never lost.** An entry leaves the queue only by the existing 14-day and 100-entry rules for finished entries; a pending entry becomes `expired`, kept.

### 8. Switch, status and transition

- **`RATINGS_PIPELINE`** (`inline` default, `separate`), registered with the code. `inline` keeps today's commit path and the tools answer `disabled`; `separate` removes ratings from the commit and opens the tools. The two never run ratings together.
- The footer's `letterboxd_ratings` health reads `run.json` in `separate` and the `sync.json` fields in `inline`; EPG health never includes ratings.
- A `sync.json` written before the switch still carrying `ratingPending` is closed by the existing `closeInterruptedRatings` rule.

Not decided here: the Ratings Task's final prompt and time, its activation and the switch's production value ([AIR-295](https://trello.com/c/VtFZ6cci)); the run budget beyond nine pages; the bounded discovery ledger, which stays the commit's largest allocation; a D1 projection of the run record.

## Alternatives considered

- **(A) Ratings as the next `epg_sync_step` on the completed run, in the EPG Task.** The [AIR-263 profile](../evidence/epg-diary-oom-profile-2026-10-30.md)'s minimal fix: a fresh request with 13–30 MB live heap, reusing `ratingPending` and `ratingAttempt`. Rejected by the owner on 2026-10-31: ratings stay owned by the EPG run, so they are lost when `beginSync` replaces `sync.json`, never run when EPG fails, share the EPG Task's prompt and drift, and put a writer behind the continuation branch that the hourly task also reaches.
- **(B) A separate Ratings Task with its own MCP tools, run record and checkpoints.** Chosen.
- **(C) Keep ratings inline and lower the commit's memory** (bounded ledger, earlier release of the scan, forced collection). Rejected as the primary fix: the publish peak stays in the same request, workerd's accounting of uncollected garbage is not controllable or measured, and every daily run keeps the coupling and its kill risk. The ledger work remains useful on its own.

## Consequences

- **Isolation.** A ratings kill can no longer cost the programme, and an EPG failure no longer skips ratings. Each pipeline starts from a small heap in its own request.
- **New complexity.** One run object with a lease, three tools, two routes, a switch, a fourth scheduled automation and its Drift checks. The Diary state becomes a compare-and-swap object.
- **Ordering preserved.** Diary before lookup, per-page facts after each history commit, the observation rules of ADR 0054 and the queue bounds of ADR 0043 are unchanged; only their caller and checkpoints move.
- **Latency.** Ratings arrive at the Ratings Task's time, not with the commit; a removal event waits for that run.
- **Load.** At most nine Diary pages and five lookups per step budget per run, the same per-request bounds as today.

## Recovery and migration boundary

- **Code only, behind `RATINGS_PIPELINE=inline`.** Deploying the code changes nothing in production. The new fields of the queue and the Diary state are additive; older readers ignore them.
- **Cutover** ([AIR-295](https://trello.com/c/VtFZ6cci)): set `RATINGS_PIPELINE=separate`, then enable the Ratings Task, then extend the Drift monitor. Each is a separate owner-approved action.
- **Rollback:** disable the Ratings Task, then set `RATINGS_PIPELINE=inline`; the commit runs ratings again from the same Diary state and queue. Objects under `letterboxd/ratings/` stay and are ignored. A code revert restores ADR 0054's path; it does not restore R2, the switch or the task schedule.
- This record authorizes no flag, Task, EPG, Diary, lookup, R2 or D1 operation.

## Evidence

- **Original decision:** this record, [AIR-296](https://trello.com/c/6lFnWkr8); owner decision pending.
- **Implementation:** none; [AIR-294](https://trello.com/c/IzWiVABa).
- **Dated verification:** the incident and profile in the [AIR-263 report](../evidence/epg-diary-oom-profile-2026-10-30.md) and the [AIR-288 card](https://trello.com/c/bpXgN1nV); the code facts above were read at `main` `bbb9efe`.
- **Uncertainty:**
  - whether a ratings run in its own request stays under 128 MB in workerd (offline ranks only);
  - whether Diary page 2 answers the Worker;
  - whether nine pages per run and a six-hour minimum between scheduled starts suit the owner's diary volume;
  - how long a step takes in production; the three-minute lease is a proposal.

## Follow-ups

[AIR-294](https://trello.com/c/IzWiVABa) (code, tests, the switch with its removal card per the flag lifecycle), [AIR-295](https://trello.com/c/VtFZ6cci) (cutover and Drift monitor scope).
