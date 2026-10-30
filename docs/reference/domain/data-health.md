# Data health: quality rules and the issue model

**Role:** maintained contract for the pure health evaluator `src/domain/data-health.js`. It turns bounded stored projections the caller already holds into a sorted, deduplicated list of health issues with stable ids. It is an offline library: no storage, network or clock of its own, no route, no UI, no writer. The Worker bundle, the public pages and the admin fixture do not include it. Rules and thresholds here are the implemented ones; consumers (an owner health page, a limbo inventory, a guarded action contract) are separate deliveries and must not change the model's meaning to fit a screen.

Related contracts: [Film/Person lifecycle](film-person.md) for the dimension envelopes the film rules read, [admin read contract](admin-read-contract.md) for the record shape and the snapshot pin, [prediction runner](../api/prediction-runner.md) and [prediction diagnostics](../api/prediction-diagnostics.md) for the queue and retry semantics, [read models](../../architecture/ui-and-read-models.md) for the projections themselves.

## Principles

- **Completeness, freshness and progress are three facts, not one.** A film can be complete and stale, incomplete and progressing, fresh and stuck. Each issue carries all three; none is folded into the other.
- **A retry inside its backoff is waiting, never stuck.** The policy caps of the existing retry writers are the rule: six hours for predictions, seven days for discovery. A retry due for longer than the grace period was not picked up and is stuck. A retry scheduled beyond the cap is an anomaly, also stuck.
- **Unknown is never healthy.** A subsystem whose projection the snapshot does not carry is `unknown` and reported as an issue. Missing observation times, missing progress times and timestamps from the future weaken the evidence and block eligibility instead of hiding the issue.
- **No aggregate score.** The result has per-subsystem evidence and status, per-severity and per-category counts, and the list. It has no number that pretends to summarize them.
- **Ids are stable.** An id names the subsystem, the category and the subject. Severity, counts and timestamps are not part of it, so two evaluations can be compared by id and a problem keeps its identity while it worsens, improves or resolves.
- **Bounded inputs.** The evaluator reads plain objects: the published-generation pointer, a list of Film records, a list of unresolved discovery observations, the prediction queue object, the discovery continuation record, a poster summary and the Letterboxd baseline facts. It never lists a bucket, never reads a lease or a continuation on its own, never calls TMDB, Letterboxd or a model.

## Call

```js
evaluateDataHealth(snapshot, {thresholds}) -> result | {error}
diffHealthIssues(previous, current) -> {appeared, persisting, resolved, unobserved}
healthIssueId(subsystem, category, subject) -> string
compareHealthIssues(left, right) -> number
progressOf(facts, clock, thresholds, maxBackoffMs) -> progress
```

Errors, checked in this order, return `{error}` and nothing else: `invalid_snapshot` (not a plain object), `invalid_clock` (`now` missing or unparseable), `invalid_thresholds` (an unknown key, or a value that is not a positive integer), `invalid_films`, `invalid_observations` (present and not an array), `invalid_coverage` (not an object, a key other than `films` / `observations`, or a value other than `complete` / `partial`). Any other field is optional. Entries of `films` that are not objects with a string `id`, and observations without a string `key`, are skipped.

### Snapshot

| Field | Source projection | Read fields |
| --- | --- | --- |
| `now` | the caller's clock, ISO string or milliseconds | required; every age and every "in the future" is relative to it |
| `pin` | the caller's snapshot pin | `programmeRunId`; a non-object is ignored |
| `coverage` | the caller's declaration of each list | `films`, `observations`: `complete` (the whole population) or `partial` (a bounded page); undeclared is `partial` |
| `published` | `epg/published-generation.json` | `programmeRunId`, `phase`, `publishedAt`, `observedAt` |
| `films[]` | Film records in the admin read contract shape | `id`, `programmeRunId`, `observedAt`, `identity`, `metadata`, `localization`, `localizationConflicts`, `externalIds`, `fingerprint`, `prediction`, `poster` |
| `observations[]` | unresolved entries of the discovery resolution ledger, already bounded by the caller | `key`, `status`, `attempts`, `retryAt`, `lastAttemptAt`, `checkedAt`, `terminalReason`, `programmeRunId`, `observedAt` |
| `predictionQueue` | `enrichment/prediction-queue.json` | `programmeRunId`, `hotPending`, `coldPending`, `pending`, `retries[id].{retryAt, attempts, kind, scope, failedAt, lastRunId}`, `lastCheckAt`, `lastBatch.{startedAt, finishedAt, stage, reason}`, `observedAt` |
| `discovery` | `epg/resolver-continuation.json` as the pipeline status reports it | `stage`, `reason`, `at`, `retryAt`, `nextCatchUpAt`, `remainingChunks`, `programmeRunId`, `observedAt` |
| `posters` | the read-only poster summary of the published catalog | `programmeRunId`, `missingPoster`, `verifiedMissing`, `unverifiedMissing`, `sample`, `observedAt` |
| `letterboxd` | the Letterboxd baseline facts | `baseline.{confirmedAt, sha256}`, `observedAt` |

A dimension envelope (`identity`, `metadata`, `fingerprint`, `prediction`) is read for `status`, `updatedAt`, `retryAt`, `attempts`, `nextAction`, `failureReason`, `terminalReason` and `provenance.conflictingTmdbIds`. Unknown fields are ignored. A field that is `undefined` was not supplied; a field that is `null` was read and the object was absent. The two are reported differently (below).

`observedAt` on a projection is when the caller read it. It is not required, but without it the issue's evidence is `partial` and `observedAt` on the issue is `null`.

### Result

```text
{
  schemaVersion: 1,
  now,                                   // the caller's clock as ISO
  clock: {skewToleranceMs, anomalies},   // anomalies: ['clock_skew'] when any evidence time lies in the future
  published: {programmeRunId, phase, publishedAt},
  scope: {programmeRunId, coverage: {films, observations}, sources: {<source>: evidence}, subjects: {films: [ids], observations: [keys]}},
  subsystems: {<name>: {evidence, status, issues, worst}},
  counts: {bySeverity: {critical, warning, info}, byCategory: {...}},
  thresholds,                            // the thresholds in force
  issues: [issue, ...]                   // sorted, deduplicated
}
```

`scope` says what the evaluation actually saw: the published generation, the declared coverage of each list, the evidence of every source (`observed`, `not_supplied`, `object_missing`) and the sorted ids of the films and observations that were read. It is what `diffHealthIssues` uses to tell a resolved issue from one whose subject merely left the snapshot.

`subsystems[name].evidence` is `observed`, `not_supplied` or `object_missing`; `status` is `clear` (observed, no issue, and every list the subsystem reads is declared `complete`), `clear_in_scope` (observed, no issue, but the evaluation saw a bounded page, so nothing is claimed about subjects outside it), `attention` (observed, at least one issue) or `unknown` (not observed, whatever the issue count). `identity` is `clear` only with complete films **and** complete observations; `poster` only with complete films and the poster summary; the other film dimensions with complete films. A page of 25 films can never make a subsystem `clear`. The subsystems are `programme`, `identity`, `metadata`, `localization`, `fingerprint`, `prediction`, `prediction_queue`, `discovery`, `poster` and `letterboxd_archive`. The film dimensions and `poster` are observed when `films` is supplied; `programme` reads `published`, `prediction_queue` reads `predictionQueue`, `discovery` reads `discovery`, `letterboxd_archive` reads `letterboxd`. The `posters` summary and `observations` add issues to `poster` and `identity` without being a subsystem of their own.

### Issue

```text
{
  schemaVersion: 1,
  id,                       // `<subsystem>/<category>/<subjectKind>:<subjectId>`
  subsystem, subject: {kind, id}, category, severity, reason,
  evidence: {completeness, source, missing, anomalies},
  observedAt, lastProgressAt,
  freshness: {status, ageMs, thresholdMs},
  progress: {status, reason, retryAt, lastProgressAt, sinceProgressMs, attempts, thresholdMs, skew, overdueMs?},
  threshold: {code, value, unit} | null,
  provenance: {source, rule, ...},
  affected: {count, sample},
  action: {suggested, code, eligible, reason}
}
```

Vocabularies are closed and exported (`DATA_HEALTH_*`):

| Field | Values |
| --- | --- |
| `category` | `conflict`, `stuck`, `stale`, `missing_asset`, `external_refresh`, `incomplete` |
| `severity` | `critical`, `warning`, `info` |
| `subject.kind` | `generation`, `film`, `observation`, `queue`, `continuation`, `catalog`, `archive`, `subsystem` |
| `evidence.completeness` | `complete`, `partial` (something is missing or anomalous), `missing` (the projection itself) |
| `evidence.anomalies` | `clock_skew`, `projection_generation_differs`, `duplicate_subject` |
| `freshness.status` | `fresh`, `stale`, `unknown` |
| `progress.status` | `progressing`, `waiting`, `due`, `overdue`, `stalled`, `terminal`, `unknown`, `not_applicable` |
| `action.suggested` | `wait`, `investigate`, `bounded_action` |
| `action.code` | `reread_snapshot`, `check_scheduled_tasks`, `manual_review`, `discovery_retry`, `metadata_refresh`, `prediction_retry`, `poster_hydration`, `archive_import`, `supply_evidence` |
| `action.eligible` | `true` (the subject's state allows the named action now), `false` (it does not; `reason` says why), `null` (the evidence cannot tell) |
| `action.reason` | `eligible`, `no_action_defined`, `in_backoff`, `awaiting_progress`, `evidence_incomplete`, `generation_changed`, `manual_review_required`, `identity_unverified`, `terminal`, `owner_input_required`, `already_queued` |

`action` is a suggestion and an eligibility statement about the subject, nothing more. An `eligible: true` does not run anything and does not replace the owner gate of the action it names; a guarded action contract decides execution. `eligible` is `true` only with `reason: eligible` and only on `complete` evidence: when a rule would call the subject eligible but the issue's evidence is `partial` (no `observedAt`, a skewed timestamp, another generation) or `missing`, the action is downgraded to `suggested: investigate`, `eligible: null`, `reason: evidence_incomplete`, and `code` still names the action that would apply. This guard sits in the issue constructor, so every rule obeys it.

`affected.count` is the number of records the issue stands for: `1` for one film or observation, the eligible or deferred count for the queue, the stored count for the poster summary, the number of held conflicts for a localization conflict, `0` for a coverage issue. `affected.sample` holds at most `sampleSize` ids, sorted.

## Progress

`progressOf` is the one rule for anything retried or pending. It reads `retryAt`, the latest of `lastProgressAt` / `lastAttemptAt` / `updatedAt` / `failedAt`, `attempts` and `terminal`.

| Facts | `progress.status` | Category | Severity | Action |
| --- | --- | --- | --- | --- |
| `terminal` | `terminal` | `incomplete` | warning | `investigate` / `manual_review`, reason `terminal` |
| `retryAt` in the future, within the cap plus the skew tolerance | `waiting` | `incomplete` | info (warning at `repeatedFailureAttempts`, reason `repeated_failures`) | `wait`, reason `in_backoff` |
| `retryAt` in the future, beyond the cap | `overdue`, reason `backoff_beyond_policy` | `stuck` | warning | `bounded_action` with the subsystem's retry code, eligible |
| `retryAt` passed, within `retryGraceMs` | `due` | `incomplete` | info | `bounded_action`, eligible |
| `retryAt` passed by more than `retryGraceMs` | `overdue`, reason `retry_overdue` | `stuck` | warning | `bounded_action`, eligible |
| no `retryAt`, last progress older than `stalledMs` | `stalled`, reason `no_progress` | `stuck` | warning | `investigate` with the retry code, eligible |
| no `retryAt`, recent progress | `progressing`, reason `work_pending` | `incomplete` | info | `wait`, reason `awaiting_progress` |
| no `retryAt`, no usable progress time | `unknown` | `incomplete` | warning | `investigate` / `supply_evidence`, eligible `null` |

Exactly at a threshold the state is the milder one (a retry exactly at the grace is `due`; progress exactly at `stalledMs` is `progressing`). The per-subsystem cap is `discoveryMaxBackoffMs` for identity and observations, `metadataMaxBackoffMs` for metadata, `predictionMaxBackoffMs` for fingerprint, prediction and the queue. The threshold the issue reports is the one that decided: the cap while waiting or beyond it, `retryGraceMs` when due or overdue, `stalledMs` otherwise.

A record of another generation than the published one cannot be acted on: its action becomes `wait` / `reread_snapshot`, reason `generation_changed`, whatever the progress says, and its evidence carries `projection_generation_differs`.

## Rules by subsystem

**programme** (`published`). `phase` other than `published`, or no `programmeRunId`: `incomplete` / `generation_not_published`, critical. `publishedAt` older than `programmeStaleMs`: `stale` / `generation_stale`, warning, `investigate` / `check_scheduled_tasks`. `publishedAt` missing or in the future: `incomplete` / `progress_unknown`, info. A `pin.programmeRunId` that differs from the published one: `stale` / `pin_generation_changed`, warning, `wait` / `reread_snapshot`; the subject is the pinned generation.

**identity** (`films[]`, `observations[]`). Any `externalIds[]` entry with `conflicting: true`, more than one `provenance.conflictingTmdbIds`, or `identity.status === 'ambiguous'`: `conflict` / `identity_conflict` or `identity_ambiguous`, warning, `investigate` / `manual_review`. `unresolved` and `resolving` go through the progress rule; `rejected` is terminal. `nextAction: keep_letterboxd_id` (a Letterboxd film kept without TMDB) is not an issue. An observation with `status: ambiguous` is a conflict; `verified` and `excluded_nonfilm` yield nothing; anything else goes through the progress rule with `terminalReason` as terminal. The observation subject kind is `observation`, so an unresolved observation is never counted as a Film.

**metadata** (`films[]`). `failed` goes through the progress rule with `metadata_refresh`. `missing`: `incomplete` / `metadata_missing`, warning. `partial`: `incomplete` / `metadata_partial`, info. `stale`: `stale` / `metadata_stale`, info, with `freshness` from `updatedAt` against `metadataFreshMs`. All three suggest `bounded_action` / `metadata_refresh`, eligible when the generation matches. `fetching` and `fresh` yield nothing.

**localization** (`films[]`). Held conflicts (`localizationConflicts.length > 0`): `conflict` / `localization_conflict`, info, `manual_review`, with the number of conflicts as `affected.count`. `missing` and `provisional` are review queues, not health issues, and yield nothing here.

**fingerprint**, **prediction** (`films[]` with `predictionQueue`). `current` yields nothing. A `failed` state, or a film with a queue `retries` entry, goes through the progress rule with the retry's `retryAt`, `failedAt` and `attempts` and the `prediction_retry` code; `provenance` keeps `retryScope` and `lastRunId`. Otherwise a non-current state is `incomplete` / `work_queued` (the queue lists the film; `wait`, reason `already_queued`) or `work_pending`, and `stuck` / `no_progress` once `updatedAt` is older than `stalledMs`. A non-current state that the queue does **not** list is a `conflict` / `queue_disagreement`: warning when the queue was checked after the state changed, info (evidence `partial`) when the queue may simply not have been refreshed yet. Without the queue projection the film's issue says so (`evidence.missing: ['predictionQueue']`, eligible `null`).

**prediction_queue** (`predictionQueue`). Outstanding work is the union of `hotPending`, `coldPending` and `pending`; a film with `retries[id].retryAt` in the future is deferred, the rest is eligible. Nothing outstanding yields nothing. Eligible work and the latest of `lastCheckAt` / `lastBatch.finishedAt` / `lastBatch.startedAt` older than `queueStalledMs`: `stuck` / `eligible_work_without_runs`, warning, `investigate` / `check_scheduled_tasks`; with a recent check: `incomplete` / `work_pending`, info; with no check time at all: `incomplete` / `progress_unknown`, warning. Only deferred work: `incomplete` / `all_deferred_by_retry`, info, `progress.retryAt` the earliest retry; a retry beyond `predictionMaxBackoffMs` is `stuck` / `backoff_beyond_policy`, warning. A queue built for another generation adds `stale` / `projection_generation_differs`, warning, and its other issues wait for a re-read. `affected` is the eligible or deferred count with a sample.

**discovery** (`discovery`). A record of another generation: `stale` / `projection_generation_differs`, info, `wait`. `running` older than `continuationRunningStaleMs`: `stuck` / `continuation_running_stale`, warning, `manual_review` (the read-only pipeline status decides whether the writer is orphaned; this rule only says it is old). `paused` or `error` with a gate (`retryAt`, else `nextCatchUpAt`) go through the progress rule: a future gate waits, a gate just passed is `due` (reason `already_queued`: the hourly task takes it), a gate passed by more than the grace or progress older than `stalledMs` is `stuck` / `continuation_not_advanced`, a gate beyond `discoveryMaxBackoffMs` is `backoff_beyond_policy`. `complete`, `idle`, and `paused` with nothing left and no retry yield nothing. `affected.count` is `remainingChunks`.

**poster** (`films[]`, `posters`). A film with `poster: null` is `missing_asset` / `poster_missing`, info; `bounded_action` / `poster_hydration` eligible only with a trusted, non-conflicting TMDB id, otherwise `investigate`, reason `identity_unverified`. `poster: undefined` is not a missing poster. The summary with `missingPoster > 0` is one `missing_asset` / `posters_missing` for the `catalog` subject with the stored counts; eligible when `verifiedMissing > 0`, `identity_unverified` when it is `0`, `supply_evidence` when it is absent. A summary without `missingPoster` is `incomplete` / `progress_unknown`.

**letterboxd_archive** (`letterboxd`). `baseline: null`: `external_refresh` / `baseline_missing`, warning. A baseline older than `archiveStaleMs`: `external_refresh` / `baseline_stale`, warning. A baseline without a usable `confirmedAt`: `external_refresh` / `baseline_age_unknown`, info, evidence partial. The action is always `bounded_action` / `archive_import` with `eligible: false`, reason `owner_input_required`: the export comes from the owner, the system cannot make it eligible. `provenance.sha256` repeats the stored baseline digest.

**coverage** (every subsystem). A projection the snapshot does not carry yields one `incomplete` issue per affected subsystem with `subject.kind: subsystem`, evidence `missing`, `affected.count: 0` and eligible `null`: `evidence_not_supplied` (info) when the field is `undefined`, `evidence_object_missing` (warning; critical for `published`) when it is `null`. These issues are what keeps an unobserved subsystem from looking clear.

## Thresholds

`DATA_HEALTH_THRESHOLDS` are the defaults; `options.thresholds` overrides any of them with a positive integer and the result reports the values in force.

| Code | Default | Decides |
| --- | --- | --- |
| `programmeStaleMs` | 36 h | the published generation is stale (the daily update missed a cycle and half of the next) |
| `metadataFreshMs` | 30 d | metadata freshness, the same window as the Film lifecycle |
| `stalledMs` | 14 d | no recorded progress is stalled |
| `retryGraceMs` | 2 h | a due retry was not picked up by the hourly work |
| `predictionMaxBackoffMs` | 6 h | the cap of the prediction retry policy |
| `discoveryMaxBackoffMs` | 7 d | the cap of the discovery retry policy |
| `metadataMaxBackoffMs` | 7 d | no stored policy; the widest cap in use |
| `queueStalledMs` | 24 h | eligible prediction work without a run or a check |
| `continuationRunningStaleMs` | 30 min | a running continuation older than twice its lease |
| `archiveStaleMs` | 60 d | a Letterboxd baseline asks for a fresh export |
| `skewToleranceMs` | 5 min | a timestamp this far ahead of `now` is treated as now |
| `repeatedFailureAttempts` | 5 | attempts that escalate a waiting retry to warning |
| `sampleSize` | 5 | ids kept on an aggregate issue |

## Clock skew and generations

Every evidence time is compared with the caller's `now`. A progress or publication time ahead of `now` by more than `skewToleranceMs` is clock skew: the issue gets `clock_skew` in `evidence.anomalies`, its `progress.status` or `freshness.status` is `unknown`, its action is `supply_evidence` with eligible `null`, and `result.clock.anomalies` lists `clock_skew`. Within the tolerance a future time has age `0`. A `retryAt` is expected in the future and is never skew; the policy cap bounds it instead.

Each projection may say which `programmeRunId` it was built from. One that differs from `published.programmeRunId` is of another generation: film and observation issues keep their category and severity but carry `projection_generation_differs` with partial evidence and a `wait` / `reread_snapshot` action; the queue, the continuation and the poster summary add a `stale` / `projection_generation_differs` issue. Without a published pointer no generation comparison is made. The pin check is separate: `pin.programmeRunId` is what the caller believed it was reading and produces its own `pin_generation_changed` issue.

## Order and deduplication

Issues are sorted by severity (`critical`, `warning`, `info`), then category (`conflict`, `stuck`, `stale`, `missing_asset`, `external_refresh`, `incomplete`), then subsystem in the order listed above, then subject kind, then subject id and id with `en` comparison. Input order never changes the output.

Two issues with one id describe one problem: the more severe is kept; on equal severity the one with weaker evidence, then the earlier in input order; the kept issue carries `duplicate_subject` in its anomalies and its count is not doubled. A repeated Film record therefore yields one issue per subsystem and category, and the same film in `stuck` and `incomplete` of one subsystem stays two issues, because they are two categories.

`diffHealthIssues(previous, current)` compares two results by id and returns `appeared`, `persisting`, `resolved` and `unobserved`, each sorted the same way (`unobserved` entries are `{reason, issue}`). An issue that disappeared is **resolved only when its subject was observed again** in `current`: a film or an observation when its id is in `current.scope.subjects`; a whole-object subject (`generation`, `queue`, `continuation`, `catalog`, `archive`) when its source is `observed`, and for the generation-bound ones also under the same `scope.programmeRunId`; a coverage issue when its source is now `observed`. Otherwise it is `unobserved` with `subject_not_observed` (another page of films), `source_not_observed` (the projection was not read, or `current` has no `scope`) or `generation_changed`. Comparing two bounded pages therefore never reports a film as resolved because it fell off the page, and a missing projection never resolves anything it used to report.

## Boundaries

- The library has no I/O and no clock. `build.mjs` does not bundle it into the Worker, `public/app.js` and the admin fixture do not import it. Its first consumer, when one is approved, builds the snapshot from a bounded read and passes it in.
- The model does not rank films, does not compute a health score, does not retry, does not reset a lease, does not touch flags or Tasks. `action.eligible` is a statement about the subject, not an authorization.
- A consumer that reads a bounded page passes `coverage: {films: 'partial'}` (or nothing) and shows `clear_in_scope` for what it is; only a reader of the whole population may declare `complete`.
- Tests: `node tests/data-health.mjs` covers the vocabularies, errors, coverage and scope, empty snapshots in both senses, stale, stalled, backoff at the edges, missing evidence and clock skew, the eligibility guard on every path, identity and queue conflicts, resolved and unobserved issues in the diff across pages, missing projections and generations, a stale pin and a changed generation, the queue, the continuation, posters, thresholds and determinism. No network, no clock.
