# Owner admin read API (read-only)

`GET /api/admin/*` answers the owner's `/admin` page from one **published snapshot** of the programme: the generation pointer, that generation's programme object and the two localization dictionaries. It searches Film and Person projections, lists quality queues and returns one record, always from the same version tuple, which every answer names as an opaque `pin`. The routes only read; they never list the bucket, never fall back to the root `programme.json`, never write, never read a lease, the resolution ledger, the discovery snapshot or an enrichment object, and never call TMDB, Letterboxd, a model or MCP. The [GET side-effect test](../../../tests/get-side-effects.mjs) covers them like every other read.

Access is the existing owner-only Cloudflare Access application in front of the Worker hostname ([ADR 0004](../../adr/0004-mcp-access-boundary.md)). The routes add no second login, no admin middleware, no token in the page and no bypass; the browser session is the only credential, and the page sends `credentials: 'same-origin'`.

Source: [`src/admin/read.js`](../../../src/admin/read.js) (handler and snapshot), [`src/domain/admin-query.js`](../../../src/domain/admin-query.js) (pure paging, bundled into the Worker script as the `AdminQuery` namespace by `scoped` in `scripts/bundle-scope.mjs`), [`src/admin/client.js`](../../../src/admin/client.js) and [`public/admin.js`](../../../public/admin.js) (the page). Tests: [`tests/admin-read-api.mjs`](../../../tests/admin-read-api.mjs), [`tests/admin-shell.mjs`](../../../tests/admin-shell.mjs). The read model, the queue rules and the design constraints are in the [admin read contract](../domain/admin-read-contract.md).

## What is read

Exactly these objects, in this order, on every request. There is no `BUCKET.list`, no per-result read and no other key.

| Step | Key | Rule |
| --- | --- | --- |
| 1 | `epg/published-generation.json` | Must be `phase: published` with a `programmeRunId` of letters, digits, `_` or `-` (at most 80). Otherwise 503 `programme_unavailable`. The etag is kept |
| 2 | `epg/generations/<programmeRunId>/programme.json` | Must exist and carry `runId` equal to the pointer's run. Otherwise 503 `programme_unavailable`; the root `programme.json` is **not** read instead |
| 3 | `epg/published-generation.json` again | If the etag or the run differs from step 1, the programme body is discarded and the read starts over once. A second move is 503 `programme_unavailable` without a client pin and 409 `stale_pin` with one |
| 4 | `titles.json`, `people.json` | The provisional title cache and the cached person names. A missing dictionary is an empty map and a `null` version, not an error |

Each object's version is its R2 etag; when the object exists and the etag is empty, the version is the SHA-256 of the loaded bytes. A missing etag is never "unchanged". `updatedAt` is not a match key.

A failure of R2 itself (an exception from the binding) is 503 `storage_unavailable`. No retry reaches a writer and nothing is repaired.

### Warm isolate

The handler keeps one immutable in-memory projection keyed by the full version tuple. A later request still performs the five reads above and compares every version; a held body is reused only when its version is unchanged, and the records are rebuilt when any version differs. The pointer is always parsed because it decides the run. An R2 `get` opens a live response stream, so a body the handler does not read is cancelled before the earlier parse is reused; no stream is left open for garbage collection, and the test's R2 stand-in opens real streams to prove it. The cache is not an R2 object and nothing writes it at EPG publish.

## The projection

Film records come from the programme films of the pinned generation, Person records from the people embedded in them and in the programme's `people` catalogue, both through the pure `filmView` / `personView` of the [Film/Person contract](../domain/film-person.md):

- **Identity** from the stored Letterboxd id and the TMDB id on the film (`resolved` with `canonicalIdentity: tmdb:<id>` when both are present, `unresolved` otherwise). The resolution ledger is not read, so no record is `ambiguous` or `rejected` from this route; those codes stay in the queue list for the contract's sake and count zero.
- **Localization** from the reviewed dictionaries baked into the Worker (`data/film-titles.json`, `data/person-names.json`), the film's own `titleRu`/`titleStatus`, the `titles.json` provisional cache and the `people.json` name cache. `localizationConflicts` come from `titleConflicts` / `nameConflicts` on the record.
- **Metadata** from the fields the programme film carries (`metadataAt`, `synopsis`, `peopleVersion`); freshness is judged against the programme's `updatedAt`, not the wall clock, so a page is stable for the life of its pin.
- **Not on the record:** `fingerprint` and `prediction`. That state lives under `enrichment/`, which this read does not load. The two queues `fingerprint-not-current` and `prediction-not-current` answer 400 `queue_unavailable`, and the overview lists them under `unavailableQueues` so the page can say so instead of counting every film.
- Each record also carries `storedId` (the programme id), `preferred` (the localized value or `null`) and `year`. Shows, synopsis and credits are not returned.

Records are sorted by `storedId` (films) and `roleId` (people) with `en` comparison before paging, and `now` for every dimension is the programme clock, so the same tuple always yields the same records and the same cursors.

## Routes

All routes are `GET`; any other method is 405 `method_not_allowed`. Unknown paths under `/api/admin/` are 404 `not_found`.

| Route | Answer |
| --- | --- |
| `/api/admin/overview?pin=` | `{pin, snapshot, counts: {films, people}, queues: [{code, kind, count}], unavailableQueues}` — counts of every available queue over the whole snapshot |
| `/api/admin/films?q=&queue=&limit=&cursor=&pin=` | `{pin, snapshot, kind: "film", query, queue, limit, items, nextCursor}` — a page of Film records; `items` carry `rank` and `collision` on a search |
| `/api/admin/people?q=&queue=&limit=&cursor=&pin=` | The same for Person records |
| `/api/admin/films/<id>?pin=` | `{pin, snapshot, kind: "film", item}`; `<id>` is the record id (`film:<storedId>`), 404 `not_found` with the pin when absent |
| `/api/admin/people/<id>?pin=` | `{pin, snapshot, kind: "person", item}`; the id may contain `/` (`person:actor/<slug>`), encoded or not |

`snapshot` is `{programmeRunId, programmeUpdatedAt, titlesUpdatedAt, peopleUpdatedAt, skew, skewReasons, films, people}`. The `*UpdatedAt` fields are the object's JSON `updatedAt` when it has one, otherwise the R2 `uploaded` time, otherwise `null`; they are for display and never part of the match.

### Parameters of the collection routes

| Parameter | Rule |
| --- | --- |
| `q` | Optional. When present it must have at least one non-blank character and at most 200; otherwise 400 `invalid_query`. A query that folds to no search token (punctuation only) is also 400 `invalid_query`. Ranking and folding are the library's ([contract](../domain/admin-read-contract.md#air-123-query-contract)) |
| `queue` | Optional. A code of the [queue table](../domain/admin-read-contract.md#what-can-be-read-without-a-model-or-a-recompute) for that kind; otherwise 400 `unknown_queue`. `fingerprint-not-current` and `prediction-not-current` are 400 `queue_unavailable` |
| `q` and `queue` together | The queue filters the records first, the search pages the subset |
| neither | 400 `invalid_query`: an empty request does not list the catalogue |
| `limit` | Optional. Omitted means 25. Present, it must be an integer from 1 to 25 written as digits (`1`…`25`); `0`, `26`, `1.5`, `abc`, `+5` or an empty value are 400 `invalid_limit`, before any read. Detail routes and the overview ignore it |
| `cursor` | The `nextCursor` of the previous page of the same route, query, queue, limit and pin. At most 4000 characters. A cursor of another snapshot, query, queue or limit is 400 `stale_cursor` |
| `pin` | The `pin` of an earlier answer. Unparseable is 400 `invalid_pin`. Parseable but not the tuple just read is 409 `stale_pin` |

Parameters are validated before the snapshot is read, so a bad `limit`, `q`, `queue` or `pin` costs no R2 request.

## Pin and cursor

`pin` is an opaque string. It encodes the version tuple `programmeRunId`, `generationEtag`, `programmeEtag`, `titlesVersion`, `peopleVersion`; the client sends it back verbatim and never assembles one. A pin matches only when all five parts equal the tuple just read. A change of `titles.json` alone or `people.json` alone is a stale pin, as is a new generation or a rewritten programme object of the same run.

`nextCursor` is `null` on the last page. It is the pin the page was served under followed by the library cursor, which binds the operation, the folded query or queue, the limit, the digest of the paged records and the last item. It is not an R2 list cursor. With the old pin a cursor of an older tuple is 409 `stale_pin`; without a pin, or with a pin that already matches the new tuple, it is 400 `stale_cursor`. Neither answer carries `items`; the client starts again from the first page.

`skew` is diagnostic. The page is still returned, and the pin and its cursors stay valid while the versions match. `skewReasons` can hold `titles_newer`, `people_newer` (that dictionary's clock is later than the programme's), `dictionary_older` (a dictionary clock is earlier than the programme's), `dictionary_missing` (`titles.json` or `people.json` is absent) and `timestamp_missing` (the programme or a present dictionary has neither a JSON `updatedAt` nor an upload time). Newer and older are not inferred when a clock is missing.

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_limit` | `limit` present and not an integer 1–25 |
| 400 | `invalid_query` | `q` blank or longer than 200 characters; `q` folds to no token; neither `q` nor `queue` given |
| 400 | `unknown_queue` | `queue` is not a code of that kind |
| 400 | `queue_unavailable` | `queue` is a fingerprint or prediction queue |
| 400 | `invalid_pin` | `pin` cannot be parsed |
| 400 | `stale_cursor` | the cursor is not from this snapshot, query, queue and limit |
| 404 | `not_found` | the id is not in the matched snapshot (the answer still names `pin`), or the path is unknown |
| 405 | `method_not_allowed` | not a GET |
| 409 | `stale_pin` | the pin is not the tuple just read, or the pointer moved twice during a pinned read |
| 503 | `programme_unavailable` | no published pointer, a run id that is unsafe, a missing generation programme object or one of another run, or the pointer moved twice during an unpinned read |
| 503 | `storage_unavailable` | the R2 binding threw |

## Data health: `GET /api/admin/health`

One request answers the owner's "Здоровье данных" view: it builds the snapshot the [data health model](../domain/data-health.md) expects from bounded single-object reads, evaluates it in the Worker and returns the evaluation grouped for the page. Same Access session, GET only, no write, no list, no lease, no ledger, no outbound call. `pin` is optional and follows the rules above (400 `invalid_pin`, 409 `stale_pin`); the answer carries the admin `pin` and `snapshot` so the page can tell when the published snapshot moved.

| Read | Key | Becomes |
| --- | --- | --- |
| the admin snapshot (the five reads above, cached by version) | pointer, generation programme, `titles.json`, `people.json` | `published` (`publishedAt` from the pointer, else the programme clock) and the Film records with `programmeRunId`, `observedAt`, and `poster` when the programme film carries that field |
| `enrichment/view-index.json` with `enrichment/profile/current.json` | the per-film fingerprint and prediction facets | `fingerprint` and `prediction` envelopes (`current`, `stale` or `missing`; `updatedAt` from the prediction's `generatedAt`) judged by the same freshness rule as every other reader. Without the index or the profile no envelope is derived and the route reports both subsystems as `unknown` with `derived: "view_index"` |
| `enrichment/prediction-queue.json` | the queue | `predictionQueue`, with its film ids re-keyed to the record ids (`film:<storedId>`) so membership and retries meet the same identifiers as the records |
| `epg/resolver-continuation.json` | the raw continuation record | `discovery` (`stage`, `reason`, `at`, `retryAt`, `nextCatchUpAt`, `remainingChunks`, `programmeRunId`). The lease is not read; a stale `running` record is reported as old, not as orphaned |
| `epg/generations/<run>/discovered-films.json` | the generation's catalog copy | `posters` (the counts `catalogPosterMissing` gives: `missingPoster`, `verifiedMissing`, `unverifiedMissing`, a sample of verified ids) |

Not read, and therefore **not supplied** to the model, which reports them as unknown rather than healthy: the unresolved observations (they live in the resolution ledger; the limbo inventory is their bounded view) and the Letterboxd baseline (the import leaves per-chunk receipts under `letterboxd/imports/<sha256>/` and no summary object; finding the latest one would list the bucket). `coverage` is `films: complete` (the whole programme) and `observations: partial`, so `identity` can at most be `clear_in_scope`.

A cold request is ten R2 reads (five of the admin snapshot, five health objects), one parse of each changed object and no other work; every read settles before the answer, so a failed read never leaves another half-open. `now` is the Worker clock at the request.

Answer, 200:

```text
{
  pin, snapshot,                      // as the other routes
  health: {
    schemaVersion, now, clock, published,
    scope: {programmeRunId, coverage, sources, subjects: {films: <count>, observations: <count>}},   // no per-film field lists
    subsystems: {<name>: {evidence, status, issues, worst, derived?}},
    counts, thresholds,
    groups: [group, ...],             // ranked
    issues: [issue, ...]              // only whole-object subjects: generation, queue, continuation, catalog, archive, subsystem
  },
  sources: {<source>: {key?, evidence, present?, count?, entries?, version?, observedAt?, reason?}},
  reads: [key, ...]                   // the R2 keys this answer read, in order
}
```

A **group** is every issue of one subsystem, category, reason, severity, subject kind and action, in the order of the sorted issues: `{key, subsystem, category, reason, severity, subjectKind, action, threshold, issues, affected, sample (≤10 subject ids), ids (≤10 issue ids), evidence: {complete, partial, missing}, missing: {<field>: count}, anomalies: {<anomaly>: count}, freshness: {<status>: count}, progress: {<status>: count}, observedAt: {earliest, latest}, lastProgressAt: {earliest, latest}, retryAt: {earliest, latest}, rules: {<rule>: count}}`. Per-film issues reach the page only through their group; the film's own card is the place to look at one record.

Errors are the ones of the table above plus 503 `health_unavailable` when the evaluator refuses the snapshot (it cannot, given how the route builds it; the code is kept for a reviewer's eye).

### The health view

`/admin?view=health` shows: a summary line (evaluation time, generation, films read and whether that is the whole programme, counts per severity, clock anomalies; there is no aggregate score), the sources line (what was read, what the store lacked, what this page does not read), one card per subsystem with its status (`в порядке`, `в порядке в пределах снимка`, `требует внимания`, `неизвестно`) and evidence, and the ranked list of groups: severity, subsystem and category, why, the evidence (completeness, what is missing, anomalies, how long ago it was read), freshness and progress with the oldest progress, the nearest retry and the deciding threshold, the suggested action with its code and eligibility as the model states it, and the subjects (films link to their card in the catalogue view). Loading, error, stale snapshot (409 under the held pin; "Перечитать снимок" drops the pin) and empty (no issue among the read subsystems, with the unread ones named as unknown) are distinct states. "Перечитать" repeats the GET. No control on the page executes an action.

## The page

`/admin` is the owner's page over this API, in two views switched by `?view=`: the catalogue (default) and [data health](#the-health-view). The catalogue view: a search field, the queue buttons with their counts, one result list per kind with a "Показать ещё" button while a `nextCursor` exists, and the detail card of the record in the URL. The search and the queue live in the URL (`/admin?q=&queue=&kind=&id=`), so a link reproduces a view; the pin, the cursors and the queue counts live in memory and are dropped by a refresh. Each keystroke is debounced and the previous requests are aborted; an answer that arrives after a newer request is discarded.

The page distinguishes three states the owner must not confuse: **empty** (200 with no items: "Ничего не найдено"), **error** (a 4xx/5xx or a network failure: the message of the code above, no results shown) and **stale snapshot** (a 409, or two answers with different pins: the results on screen stay, a banner says the published snapshot changed and a button reloads without the pin). The snapshot line names the generation, the programme and dictionary clocks and any skew. Fingerprint and prediction appear as "вне снимка программы" on a film card.

## Limbo inventory

`GET /api/admin/limbo` lists the films that are not progressing and why, for the owner page `/admin/limbo`. It is read-only and behind the same Access application. Source: [`src/admin/limbo.js`](../../../src/admin/limbo.js) (handler), [`src/domain/limbo-inventory.js`](../../../src/domain/limbo-inventory.js) and [`src/domain/data-health.js`](../../../src/domain/data-health.js) (pure, bundled as `LimboInventory` and `DataHealth`), [`src/admin/limbo-client.js`](../../../src/admin/limbo-client.js) and [`public/admin-limbo.js`](../../../public/admin-limbo.js) (the page). Tests: [`tests/admin-limbo-api.mjs`](../../../tests/admin-limbo-api.mjs), [`tests/admin-limbo-page.mjs`](../../../tests/admin-limbo-page.mjs), [`tests/limbo-inventory.mjs`](../../../tests/limbo-inventory.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins its read set.

### What is read

The five reads of the [snapshot above](#what-is-read), in the same order and with the same failures, then exactly two more objects. No `BUCKET.list`, no per-film object under `enrichment/films/`, no resolution ledger, discovery snapshot, lease or continuation.

| Step | Key | Use |
| --- | --- | --- |
| 6 | `enrichment/prediction-queue.json` | Outstanding films (`hotPending`, `coldPending`, `pending`), `retries` (`retryAt`, `attempts`, `kind`, `scope`, `lastRunId`), the per-film `work` plan, `programmeRunId`, `refreshedAt`, `lastCheckAt`. Absent is reported, not treated as an empty queue |
| 7 | `enrichment/view-index.json` | The stored prediction's `generatedAt` and the `fingerprintHash` of an outstanding film: the clock of its last progress. Only entries of outstanding films are used |

Both versions join the pin; a warm isolate reuses a parsed body only when its version is unchanged, as above.

### Projection

Film records are the snapshot's programme films ([projection](#the-projection)) with `programmeRunId` of the pinned generation, plus a minimal record (`id`, `storedId`, the queue's `programmeRunId`, `inProgramme: false`) for an outstanding queue film the programme does not carry, such as a catalog film. Only outstanding films get fingerprint and prediction state, from the queue's own verdict and stamped with the queue's `programmeRunId`: `prediction` is `stale` when the index has a prediction and `missing` otherwise, with the index `generatedAt` as `updatedAt`, the retry `attempts` and `kind`, and the work plan as `nextAction`; `fingerprint` is `current` for `prediction_only` work and `stale` or `missing` for `fingerprint_and_prediction`. A film the queue does not list carries neither field and stays unobserved for those subsystems, so the route never claims a prediction is current. When the queue was built for another generation than the published one, every such per-film diagnosis fails closed: cause `stale_projection`, action `wait` / `reread_snapshot`, `eligible: false`; `context` carries the queue-level `projection_generation_differs` issue, and programme-derived items of the same films keep their own verdict. Queue ids are translated to record ids with `canonicalFilmId`. The evaluation runs with `coverage.films: partial`, because a programme snapshot is not every Film.

**Unresolved observations are not available.** They live only in the resolution ledger, which this route does not read. The answer says so in `coverage.observations` (`available: false`, `reason: no_bounded_projection`); a `kind=observation` filter returns an empty list beside that statement, never a claim that nothing is unresolved. Serving them needs a generation-scoped index object written at EPG publish, a separate writer change.

### Parameters

| Parameter | Rule |
| --- | --- |
| `kind` | `film` or `observation`; otherwise 400 `unknown_kind` |
| `subsystem` | `identity`, `metadata`, `localization`, `fingerprint`, `prediction`; otherwise 400 `unknown_subsystem` |
| `cause` | `retry_eligible`, `stalled`, `backoff`, `pending`, `manual_review`, `stale_projection`, `external_archive`, `unknown` ([meaning](../domain/data-health.md#limbo-inventory)); otherwise 400 `unknown_cause` |
| `age` | Minimum days without progress, digits `0`–`365`; otherwise 400 `invalid_age`. Items of unknown age are kept |
| `limit` | As for the collection routes: omitted is 25, present must be `1`–`25` |
| `cursor` | The `nextCursor` of the previous page of the same filter, limit and pin; otherwise 400 `stale_cursor` |
| `pin` | A limbo pin (`L1|…`). An admin catalogue pin is 400 `invalid_pin`; a limbo pin that is not the tuple just read is 409 `stale_pin` |

Parameters are validated before any read. No filter is required: the whole inventory is bounded by the snapshot.

### Answer

`{pin, snapshot, kind, subsystem, cause, age, limit, items, nextCursor, total, counts, coverage, context, unread, thresholds, vocabulary}`.

- `snapshot` is the catalogue snapshot object plus `evaluatedAt` (the clock of this evaluation), `sources` (the seven keys above), `clock` (skew anomalies), `queuePresent`, `queueRefreshedAt`, `queueProgrammeRunId`, `queueLastCheckAt`, `queueUploadedAt`, `indexPresent`, `indexUploadedAt`.
- `items` are [limbo items](../domain/data-health.md#limbo-inventory) of the filtered list; `total` is that list's length; `counts` cover the whole unfiltered inventory.
- `context` holds the whole-object health issues of the same evaluation (the published generation, the prediction queue), so an item is read with the pipeline state around it: a queue built for another generation, eligible work without runs. `unread` names the subsystems this route does not observe (`discovery`, `letterboxd_archive`, and `prediction_queue` when the object is absent); they are unknown, not healthy.
- `thresholds` are the model's thresholds in force.

**Pin and cursor.** The pin is `L1|` + the catalogue pin + the queue version + the index version. A change of the queue or the index alone is a stale pin, as is any change of the catalogue tuple. The cursor carries the pin and the evaluation clock (`evaluatedAt`) in front of the inventory cursor: every later page is cut from the same evaluation, so an age or a due retry does not shift between pages, and a fresh first page evaluates at the current clock.

**Errors.** Those of the catalogue routes, plus `unknown_kind`, `unknown_subsystem`, `unknown_cause`, `invalid_age` (400) and `evaluation_failed` (500, the model refused the snapshot; nothing is written).

### The page

`/admin/limbo` holds the filter in the URL (`kind`, `subsystem`, `cause`, `age`), the pin and cursors in memory. Cause and subsystem chips carry the whole-inventory counts; a form sets kind and age; Escape and "Сбросить фильтры" clear the filter. Each item shows why it is waiting (reason, cause, progress, retry time), since when (days without progress and the last transition), the expected action and whether it is eligible, the threshold, the evidence source and read time, the identity provenance and the last diagnostic, and links to the film in `/admin` only when the film is in the published programme; a film known only from the queue says that the catalogue has no card for it. The side panel shows the snapshot, the pipeline context, the unread subsystems and the thresholds, and states that observations are unavailable. Empty, error and stale snapshot are distinct states as on `/admin`. The page is the third section of the admin navigation (Каталог, Здоровье данных, Лимбо, Постеры). A film item of the prediction or fingerprint subsystem carries «Разобрать прогноз», which opens the [prediction recovery panel](#the-prediction-recovery-panel) for that film. The page has no action button: no targeted prediction write exists ([why](admin-actions.md#prediction-recovery)), and retries and refreshes belong to the guarded action contract.

## Prediction recovery: `GET /api/admin/prediction-recovery`

`GET /api/admin/prediction-recovery?film=<storedId>[&pin=<pin>]` explains why one stored film has or lacks a current prediction and what will happen to it, from the objects the system already keeps. It is read-only, behind the same Access application, and has no `POST`, no action and no capability: it never requeues, resets a retry, refreshes the queue, takes or clears a lease, starts a run or calls a model. Source: [`src/admin/prediction-recovery.js`](../../../src/admin/prediction-recovery.js) (handler), [`src/domain/prediction-recovery.js`](../../../src/domain/prediction-recovery.js) (pure assessment, bundled as `PredictionRecovery`), [`src/admin/prediction-recovery-view.js`](../../../src/admin/prediction-recovery-view.js) (the panel), `loadPredictionRecovery` in [`src/admin/limbo-client.js`](../../../src/admin/limbo-client.js). Tests: [`tests/prediction-recovery.mjs`](../../../tests/prediction-recovery.mjs), [`tests/admin-prediction-recovery-api.mjs`](../../../tests/admin-prediction-recovery-api.mjs), [`tests/admin-prediction-recovery-page.mjs`](../../../tests/admin-prediction-recovery-page.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins its read set.

### What is read

The handler gives the loader a bucket wrapper that has only `get`, so no code path of the route can put, list or delete. It reads what `prediction_film_diagnostics` reads ([prediction diagnostics](prediction-diagnostics.md)) plus two runner objects, each a single object:

| Key | Use |
| --- | --- |
| `enrichment/prediction-queue.json` | lane (`hot`, `cold`, none), `retries[film]` (`attempts`, `retryAt`, classification, validation summary), `programmeRunId`, `refreshedAt`, `lastCheckAt`, `lastBatch.finishedAt` |
| `enrichment/profile/current.json` | the profile version and hash a prediction is judged against; the profile text is never returned |
| `enrichment/view-index.json` | whether the index agrees with the film's own objects |
| `epg/published-generation.json`, the generation's `programme.json` and `discovered-films.json` | programme and catalog membership of the film; the generation copy of the catalog falls back to the root `epg/discovered-films.json` as every reader does |
| `enrichment/films/<id>/fingerprint.json`, `enrichment/films/<id>/predictions.json` | fingerprint and prediction presence, freshness and profile compatibility under the rule in force |
| `enrichment/runner-lease.json`, `enrichment/latest-run.json` | whether a run is live (lease not expired) and whether that run selected the film and has no result for it yet |

A read that throws is `unavailable` for that source, a missing object is `not_recorded`; neither is treated as empty or healthy.

### Parameters and pin

| Parameter | Rule |
| --- | --- |
| `film` | Required. Letters, digits, `_` or `-`, at most 80; otherwise 400 `invalid_film`, before any read |
| `pin` | Optional. `R1.` + 32 lowercase hex digits; otherwise 400 `invalid_pin`. A pin that is not the version set just read is 409 `stale_pin` |

The pin is a digest of every key read with its R2 etag (`absent` when missing, `unavailable` when the read threw). Any change to one of those objects, including a lease heartbeat that rewrites the lease with the same content, makes the pin stale. A key read twice in one request (the generation pointer) keeps every version it showed, so a pointer that moves between those reads yields a pin no later read can match. The page uses the pin only to say "the state changed since your last check"; it confirms nothing and authorizes nothing.

### Answer

`{pin, evaluatedAt, atomic: false, assessment, snapshot, sources}`. `atomic: false` because the objects are read one by one. `snapshot` carries `consistent` and `reasons` (the diagnostic's disagreement codes), the queue's `status`, `refreshedAt`, `programmeRunId` and `lastActivityAt` (the later of `lastCheckAt` and `lastBatch.finishedAt`), the profile `status` and `version`, the programme and published generation run ids, `runnerLease` and `latestRun` read statuses and `nominalNextRunAt` (the nominal hourly trigger, an estimate). `sources` lists the keys read.

`assessment` is `{version, filmId, status, cause, work, nextExpected: {kind, at}, targetedAction: {available: false, capability: null, reason}, writer: {exists: false, decision: "no_go"}, missingPrerequisites, evidence: {completeness, missing}, facts, runner}`. `facts` holds the fingerprint (presence, current, usable, reason, migration), the prediction (presence, current, `profileCompatible`, cause, reason, required work), the queue lane and eligibility, the retry (classification, scope, attempts, `failedAt`, `retryAt`, `lastRunId`, validation stage and issue count) and the index agreement. `runner` is `{live, runId, leaseExpiresAt, filmSelected}`, with `null` where the lease or run could not be read.

**Verdicts.** `status` is `no_action`, `wait`, `investigate`, `blocked` or `unknown`. `cause` is decided in this order; the first that applies wins:

| Order | Cause | Status | `nextExpected.kind` | `targetedAction.reason` |
| --- | --- | --- | --- | --- |
| 1 | `film_unreadable` — the film objects could not be read | `unknown` | `reread` | `evidence_incomplete` |
| 2 | `queue_unavailable` — queue missing or unreadable, or the lane is unknown | `unknown` | `reread` | `evidence_incomplete` |
| 3 | `profile_missing` — the taste profile is missing or unreadable | `blocked` | `reread` | `evidence_incomplete` |
| 4 | `snapshot_partial` — any disagreement reason other than the queue-wide `index_ahead_of_queue` | `blocked` | `reread` | `evidence_incomplete` |
| 5 | `in_flight` — a live lease, the latest run is that lease's run, it selected the film and has no result for it | `wait` | `run_progress` | `ordinary_schedule` |
| 6 | the prediction is current: `index_inconsistent` (`investigate`), `index_ahead_of_queue` when still queued (`wait`, `queue_refresh`), otherwise `prediction_current` (`no_action`, `none`, `not_needed`) | | | |
| 7 | `index_inconsistent` — index and film objects disagree | `investigate` | `owner_investigation` | `other_subsystem` |
| 8 | `not_in_catalog` — read programme and catalog, the film is in neither | `investigate` | `owner_investigation` | `other_subsystem` |
| 9 | `queue_refresh_pending` — not current and not queued | `wait` | `queue_refresh` | `queue_derived` |
| 10 | `retry_backoff` — a future `retryAt`; `repeated_failures` from 5 attempts | `wait` / `investigate` | `retry_at` / `owner_investigation` | `backoff_respected` / by failure kind (below) |
| 11 | ready now: `repeated_failures` from 5 attempts, `run_active` under a live lease, `ready_no_runs` when the queue's last activity is older than 24 hours (`investigate`, `check_scheduled_tasks`), otherwise `queued_ready` (`wait`, `scheduled_run` at `nominalNextRunAt`) | | | |
| 12 | `waiting_behind_hot` — cold film while hot work remains | `wait` | `hot_drain` | `ordinary_schedule` |
| 13 | `queue_state_unknown` — anything else | `unknown` | `reread` | `evidence_incomplete` |

The 5 attempts and 24 hours are the data health thresholds `repeatedFailureAttempts` and `queueStalledMs`. The reason of `repeated_failures` follows the retry's classification: `caller_contract` for `validation_error`, `parse_error` and `format_error_storm` (the model output breaks the contract); `system_failure` for `storage_error`, `quota`, `time_budget`, `model_unavailable`, `api_error`, `lease_lost`, `lease_expired` and `external_termination` (the infrastructure around the run); `failure_unclassified` for everything else, including the classifier's catch-all `model_error` and a missing classification. Unknown programme or catalog membership is never read as absence. An unreadable lease or latest run leaves the verdict to the queue and marks `evidence.completeness: partial` with `runner_lease` or `latest_run` in `evidence.missing`. The same holds for a recorded lease without a readable `expiresAt` (`runner.live: null`, never "no run"), a live lease without a `runId` (the film's in-flight state is `null`; the verdict can still be `run_active`) and a latest run of the lease's run without a `runId`, a `selectedIds` list or a `results` object; an unknown last activity adds `queue_activity` and is not taken as proof of an idle schedule. `missingPrerequisites` names `taste_profile`, `prediction_queue`, `catalog_membership` or `film_state` when one of them is what blocks a prediction.

**Errors.** 400 `invalid_film`, 400 `invalid_pin`, 405 `method_not_allowed`, 409 `stale_pin`, 503 `storage_unavailable` (the loader itself failed; individual unreadable objects are reported in the answer instead).

### The prediction recovery panel

«Разобрать прогноз» on a limbo film item of the prediction or fingerprint subsystem toggles a panel under the item (`aria-expanded`, `aria-controls`) and issues one GET for that film. The panel shows, in Russian: the status and the cause, what is happening with the prediction, what will happen next (times in Europe/Madrid, the scheduled run labelled as an estimate), why there is no "retry" button for this case, the missing prerequisites, the facts (prediction, fingerprint, required work, lane, failed attempts, index agreement, run) and the snapshot line. Codes, ids, the pin and the source keys appear only inside the closed «Технические подробности». For `repeated_failures` the «why» text follows the reason: the model's output, the infrastructure, or an unrecognised kind; an infrastructure failure never tells the owner to fix the model output. An unknown run state reads «состояние запуска неизвестно». A status, cause, reason, next step, prerequisite or evidence code without declared copy, or an answer that claims an available action or an existing writer, renders «Невозможно достоверно объяснить состояние прогноза» instead of a partial explanation. «Проверить заново» repeats the GET with the held pin; a 409 is followed by one unpinned read and the panel says the state changed. The only control is that recheck.

## Poster coverage

`GET /api/admin/posters` is the read behind the owner page `/admin/posters`: how many catalog records lack a poster, how many of them can be restored from TMDB by a verified id, which ones cannot, and the next bounded batch of the restoration queue. It is read-only and behind the same Access application. The only write the page can cause is an owner-confirmed call of the existing maintenance route `POST /api/enrichment/catalog/posters` ([catalog reference](catalog.md#poster-hydration), [ADR 0048](../../adr/0048-permanent-catalog-poster-maintenance-route.md)); this route never calls it. Source: [`src/admin/posters.js`](../../../src/admin/posters.js) (handler), [`src/admin/posters-client.js`](../../../src/admin/posters-client.js), [`src/admin/posters-run.js`](../../../src/admin/posters-run.js) and [`public/admin-posters.js`](../../../public/admin-posters.js) (the page). Tests: [`tests/admin-posters-api.mjs`](../../../tests/admin-posters-api.mjs), [`tests/admin-posters-run.mjs`](../../../tests/admin-posters-run.mjs), [`tests/admin-posters-page.mjs`](../../../tests/admin-posters-page.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins its read set.

### What is read

Exactly three objects, in order: `epg/published-generation.json`, the live catalog `epg/discovered-films.json`, and the published generation's copy `epg/generations/<programmeRunId>/discovered-films.json` (only when the pointer is `published`). These are the objects the maintenance route counts, with the same rule (`catalogPosterMissing`): a record counts once, as missing when either copy lacks an `https://` poster, and as restorable (`verifiedMissing`) when its numeric `tmdbId` is also its `canonicalIdentity`. No snapshot pin, no programme, no `BUCKET.list`, no resolver lease, no ledger, no TMDB request and no write; the read never creates, rewrites or repairs any of these objects.

**Complete or unknown.** The counts are reported only when all three objects were read and are trusted: the pointer is a JSON object with `phase: "published"` and a `programmeRunId`, and both catalog copies exist and parse to a JSON object. Otherwise the answer is `evidence: {complete: false, problems}` and nothing is counted as zero: every count, `withPoster`, `queue.remainingAfterCursor`, `queue.total` and `unverified.count` are `null`, `queue.items` and `unverified.sample` are empty, and `health.issue` is the data health `incomplete` / `progress_unknown` issue with the action `supply_evidence`. `problems` lists, in this order, at most one pointer problem (`pointer_missing`, `pointer_unreadable`, `generation_not_published`), at most one generation copy problem (`generation_copy_missing`, `generation_copy_unreadable`; the copy is not read without a published generation) and at most one live copy problem (`live_copy_missing`, `live_copy_unreadable`). `copies[]` still describes every copy that was read. A storage call that fails, as opposed to an object that is absent or does not parse, is 503 `storage_unavailable`.

### Parameters

| Parameter | Rule |
| --- | --- |
| `limit` | Size of the batch shown, digits `1`–`10`, default `10`; otherwise 400 `invalid_limit`. Ten is the page's batch cap, below the route's own limit of 20 |
| `cursor` | The position in the queue, as the maintenance route uses it: records whose id sorts after it (`localeCompare`, `en`). Empty or absent is the start; longer than 200 characters is 400 `invalid_cursor` |

Parameters are validated before any read. Any other method is 405 `method_not_allowed`.

### Answer

`{schemaVersion, observedAt, programmeRunId, catalogRecords, withPoster, missingPoster, verifiedMissing, unverifiedMissing, publishedAt, evidence, copies, queue, unverified, health, limits, reads}`.

- `evidence`: `{complete, problems}` as above. Only a `complete: true` answer carries counts and a batch.
- The counts are the maintenance route's dry-run counts of the same objects.
- `copies[]`: `{key, role: generation|live, present, readable, version, records, missingPoster, verifiedMissing}` per copy; `records`, `missingPoster` and `verifiedMissing` are `null` for a copy that is absent or unreadable.
- `queue`: `{cursor, limit, items, remainingAfterCursor, total}`. `items` are the next `limit` restorable records after `cursor` — `{id, tmdbId, title, original, year}` with titles cut to 200 characters — which are exactly the records a `POST {dryRun: false, limit, cursor}` would process next.
- `unverified`: `{count, sample}`, up to ten records without a poster that the route will not touch, each with `reason` `tmdb_id_missing` (no numeric TMDB id) or `identity_not_tmdb` (the id is not the record's canonical identity).
- `health`: the [data health](../domain/data-health.md#rules) catalog poster summary issue of these counts (`id`, `severity`, `reason`, `category`, `action`, `evidence`, `threshold`) or `null` when no poster is missing, and the `posterBacklogCount` in force.
- `limits`: `{batch: 10, route: 20}`; `reads`: the keys read.

### The page

`/admin/posters` is the last section of the admin navigation. It shows the coverage (records, with a poster, without one, restorable, not restorable) with the per-copy figures in a closed «Технические подробности»; a warning when the restorable backlog reaches `posterBacklogCount`; the records without a verified TMDB id; when the read is incomplete, «Покрытие неизвестно: данные неполные» with each problem and each copy's state in plain Russian, every figure as «неизвестно», no preview batch and no confirmation; and the browser's own history: the last successful restoration, recent coverage readings and runs. The server keeps no run journal, so that history lives only in this browser's `localStorage` (`iptv.admin.posters.v1`), is labelled as such, and can be forgotten; it is never an input to the route.

A manual run follows the guarded-action principles of [admin actions](admin-actions.md#the-poster-page):

1. **Preview.** The owner picks the batch size (1–10, default 10), the call budget (1–30, default 1) and the start (the position saved by the last run for the same generation, or the start of the queue). The preview is one GET: the first batch by title and TMDB id, how many records follow, and the most this run can touch. It writes nothing and calls no TMDB. An answer without `evidence.complete: true` and a published generation is the `incomplete` preview, which cannot be confirmed; an incomplete reading is not stored in the browser history.
2. **Confirmation.** A checkbox restates the exact scope (calls, batch size, maximum records, start, generation). It is valid for ten minutes and one run, and is dropped by any change of the options or a re-check. It guards against an accidental click; authorization is still Cloudflare Access.
3. **Fresh check.** Immediately before the first call the page re-reads the queue with the confirmed cursor and limit. Incomplete evidence, a different generation, a different first batch, nothing left to restore or a rate-limit gate refuses the run with nothing sent.
4. **Bounded execution.** One `POST /api/enrichment/catalog/posters` with `{dryRun: false, limit, expectedProgrammeRunId}` and the route's `nextCursor` per call, never in parallel and never above ten records. `expectedProgrammeRunId` is the confirmed generation on every call, the first included, so the route refuses a call once another generation is published, before any TMDB request and any write ([generation fence](catalog.md#poster-hydration)). The run stops at the first of: `done`; the confirmed call budget; five consecutive calls with no new poster and an unchanged cursor; `retryAt` (TMDB rate limit, kept as a gate for the next preview); a generation change, refused by the route's fence (409 `generationChanged`), reported in its outcomes or seen in its answer; the resolver lease held by discovery (409); a lost lease (409, with the copies already written); TMDB not configured (503); a rejected request (400); an answer the page cannot read or an outcome code it has no sentence for. "Остановить после текущего пакета" stops between calls; a call in flight always completes and is recorded.
5. **Receipt.** The stop reason in plain Russian, the totals (written, already present, no poster on TMDB, TMDB answered for another film, retryable), a partial-write warning when one copy was written without the other, the latest outcome of every record, and per call the HTTP status, cursors and writes per copy in «Технические подробности». The page then re-reads the coverage and shows before → after.

## Letterboxd archive preview: `POST /api/admin/letterboxd-archive/preview`

The read behind `/admin/letterboxd`: the owner sends the Letterboxd account export ZIP and gets back what it contains and what an import of it would do to the stored facts now. It **writes nothing**: the archive, its rows and the answer exist only in the request and its `no-store` response; nothing is put to R2, D1, KV or a cache, nothing is logged, `waitUntil` is not used and no outbound request is made, not even to a URL in the archive ([ADR 0061](../../adr/0061-ephemeral-letterboxd-archive-preview.md)). Applying an archive is the separately approved [baseline import](../../runbooks/letterboxd-baseline-import.md); this route has no apply mode. Source: [`src/admin/letterboxd-archive.js`](../../../src/admin/letterboxd-archive.js) (handler), [`src/domain/letterboxd-archive-zip.js`](../../../src/domain/letterboxd-archive-zip.js) (ZIP reader, `LetterboxdArchiveZip`), [`src/domain/letterboxd-archive-preview.js`](../../../src/domain/letterboxd-archive-preview.js) (answer, `LetterboxdArchivePreview`), the bundled offline [parser and matcher](../integrations/letterboxd-export.md), [`src/admin/letterboxd-archive-client.js`](../../../src/admin/letterboxd-archive-client.js), [`src/admin/letterboxd-archive-view.js`](../../../src/admin/letterboxd-archive-view.js) and [`public/admin-letterboxd.js`](../../../public/admin-letterboxd.js) (the page). Tests: [`tests/letterboxd-archive-zip.mjs`](../../../tests/letterboxd-archive-zip.mjs), [`tests/letterboxd-archive-preview.mjs`](../../../tests/letterboxd-archive-preview.mjs), [`tests/admin-letterboxd-archive-api.mjs`](../../../tests/admin-letterboxd-archive-api.mjs), [`tests/admin-letterboxd-page.mjs`](../../../tests/admin-letterboxd-page.mjs); the real-runtime probe is [`scripts/letterboxd-archive-probe.mjs`](../../../scripts/letterboxd-archive-probe.mjs).

### Request

`multipart/form-data` with exactly the field `archive` (the ZIP file) and, only for a renamed archive, `generatedAt` (the export time in UTC, `YYYY-MM-DDTHH:MMZ` with optional seconds and milliseconds). The export time comes from the Letterboxd file name `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc.zip`; a standard name with `generatedAt` is refused, so the two never disagree. The checks run in this order, and a refused request reads nothing from R2: path, method, `Origin` equal to the Worker origin, content type, `Content-Length` present and within 10 MiB plus 64 KiB of form overhead, the per-isolate slot, the body read with the same cap, the form fields, the file name (at most 255 characters) and size, the export time, the ZIP, the CSV files.

### Archive limits

| Limit | Value |
| --- | --- |
| Compressed archive | 10 MiB |
| Central directory entries | 2,000 |
| Entry name | 255 bytes; no absolute or drive path, empty, `.` or `..` segment, backslash or control character |
| One inflated CSV | 4 MiB |
| The inflated CSVs together | 8 MiB |
| Declared inflated size over compressed size | 100 |
| Lines per CSV | 10,000 |
| Wall time of the read | 20 s, checked between inflated chunks |

Only `watched.csv`, `ratings.csv`, `watchlist.csv` and `diary.csv` at the top level are inflated, each checked for size, CRC-32 and strict UTF-8; every other entry is only checked for a safe name, method and flags. `watched.csv` is required; a missing other file makes the answer `partial`.

### Errors

| Status | `error` | When |
| --- | --- | --- |
| 404 | `not_found` | another path under `/api/admin/letterboxd-archive/` |
| 405 | `method_not_allowed` | not a POST |
| 403 | `origin_not_allowed` | `Origin` missing or not the Worker's own |
| 415 | `unsupported_media_type` | not `multipart/form-data` with a boundary |
| 411 | `length_required` | no numeric `Content-Length` |
| 413 | `archive_too_large` | the declared or read body, or the file, is above the cap |
| 429 | `preview_busy` | another preview runs on this isolate (below) |
| 400 | `invalid_form` | unreadable form, a missing, repeated or extra field, or an unusable file name |
| 422 | `generated_at_required`, `generated_at_conflict`, `generated_at_invalid`, `generated_at_future`, `generated_at_too_old` | a renamed archive without a time; a standard name with one; not the UTC form; later than now; before 2011 |
| 422 | `archive_invalid` with `code` and `file` | the ZIP reader refused: `not_zip`, `archive_too_large`, `zip64_unsupported`, `multi_disk_unsupported`, `too_many_entries`, `central_directory_invalid`, `entry_name_invalid`, `duplicate_entry`, `encrypted_entry`, `unsupported_method`, `local_header_invalid`, `entry_truncated`, `entry_overlap`, `entry_too_large`, `total_too_large`, `ratio_exceeded`, `entry_size_mismatch`, `inflate_failed`, `checksum_failed`, `invalid_utf8`, `too_many_rows`, `time_budget`, `aborted` |
| 422 | `csv_invalid` with `file` and `record` | a CSV file the parser cannot read |
| 422 | `missing_watched` | the archive has no `watched.csv` |
| 500 | `preview_failed` | anything else; no detail is returned |

**One preview per isolate.** A worst-case preview needs about half of the isolate's 128 MB, so the handler holds one slot per isolate and answers 429 to a second concurrent request on the same isolate. The slot is the start time of the running preview and is taken over after 60 s, because a request the runtime cancels never reaches its `finally`.

### What is read

Through a bucket wrapper that exposes only `get`; no key is listed:

| Read | Use |
| --- | --- |
| The admin snapshot (five reads above) | The published programme for the matcher; failure leaves matching `partial` |
| `metadata.json` | Catalog metadata for the matcher |
| `enrichment/ratings/published.json`, then its generation when `projected: true` | The ratings the matcher uses as evidence |
| `letterboxd/facts/links.json` | The link index: which films already have a fact record and under which key |
| `letterboxd/facts/scans/films-list.json`, `letterboxd/facts/scans/watchlist.json` | The scan summaries, the floor of every observation ([ADR 0024](../../adr/0024-letterboxd-scan-summary.md)) |
| `letterboxd/imports/<sha256>/chunks/0.intent.json`, `0.receipt.json` | Whether **this** archive was already imported (`committed`, `opened`, `absent`) |
| `letterboxd/facts/films/<key>.json` | Only for accepted films whose alias is in the link index, at most 300, six at a time, one redirect hop; a record that is migrating, a second redirect or a failed read makes the film `unverified` |
| The pointer, `metadata.json`, the ratings pointer, the link index and both summaries again | ETag fence: any change makes `consistency.status` `drift` and the proposal `partial` |

Not read: the generation catalog copy (several megabytes; it only adds `title_year` candidates) and `enrichment/view-index.json` (a projection of the records). `matching.omitted` names both. The keys actually read are listed in `reads`.

### Answer, 200

```text
{
  schemaVersion: 1, mode: "preview", writes: false, evaluatedAt, status: complete|partial,
  archive: {sha256, bytes, entries, ignoredEntries, nameStandard, generatedAt, generatedAtSource: archive_name|owner_declared, ageMs, files: {<name>: {sha256, bytes}}},
  completeness: {status, missing: [file, ...]},
  export: {files: {watched|ratings|watchlist|diary: {name, present, records, valid, invalid, duplicates, conflicts, missingYear, auxiliary}}, sets: {<set>: count}, films, crossFileMismatches, invalidRows, invalidByReason},
  baseline: {status: "unknown", reason: "no_bounded_summary", confirmedAt: null, sha256: null, thisArchive: {status: committed|opened|absent|unavailable, committedAt}},
  freshness: {needsFreshArchive, reasons: [archive_stale, ratings_newer_in_r2], archiveStaleMs, ageMs, ratingsNewerInR2},
  matching: {status, sources: {<source>: {evidence, key, ...}}, omitted, index, byStatus, acceptedByMethod: {lid_exact, tmdb_verified, title_year}, reasons, lidHypothesis},
  proposal: {status, reasons, films: {accepted, compared, unverified, aliasConflict, invalidIdentity, heldForIdentity}, facts: {new, replaces, unchanged, older, tie, unverified}, byFact: {watched|rating|watchlist: {...}}, recordReads: {limit, needed, done}},
  consistency: {status: stable|drift, changed: [key, ...]},
  details: {limit: 25, adds, updates, heldNewer, unverified, conflicts, identity, invalidRows},   // each {total, rows ≤ 25}
  reads: [key, ...]
}
```

- **Outcomes** are the baseline commit's, computed on a copy of each record with the same observation ids and summary floors: `new` (no value yet), `replaces` (the export's observation is greater), `unchanged`, `older` (a stored or scanned observation is newer and wins), `tie` (counted beside the outcome when the observation equals the stored one), `unverified` (the record was not read).
- **Held** films are not proposed: `heldNewer` (R2 is newer for some fact), `unverified` (`record_read_limit`, `record_unavailable`, `record_converging`, `links_unavailable`), `conflicts` (`alias_conflict`: the Letterboxd and TMDB aliases point to two records; `invalid_identity`), and `identity` (every film the matcher did not accept, with its status, method, reason and number of candidates). Only `accepted` films are compared, as in the import.
- **Rows** carry the film's export code, name, year, match status and method, the proposed facts, the outcome per fact and the current value where one exists. They are capped at 25 per list; `total` is the full count. They are personal data and appear only in this response.
- `baseline` is always `unknown`: the import stores receipts per archive and no summary, so the latest confirmed baseline cannot be found without listing the bucket. `freshness.reasons` has `archive_stale` when the export is older than the data health `archiveStaleMs` (60 days) and `ratings_newer_in_r2` when R2 holds a newer rating than the archive for at least one compared film.

### The page

`/admin/letterboxd` («Архив Letterboxd») sits between data health and limbo in the admin navigation. Opening it sends nothing. The form takes the ZIP and, for a renamed archive, the export time; the page checks the name, the size and the time locally, then sends one `POST` with `credentials: 'same-origin'` and `cache: 'no-store'` and accepts only an answer with `mode: "preview"` and `writes: false`. States: idle, loading (with «Отменить», also on Escape, which aborts the request), error (focused, the code's Russian text), result (focused): the freshness banner («Нужен свежий архив» with its reasons, or «Архив достаточно свежий»), the totals, the archive's files and SHA-256, the baseline as «неизвестно» with the reason, the matching by method and status, the proposal by fact and outcome, and the detail lists in closed `<details>`. Times are shown in Europe/Madrid. «Очистить» drops the answer and returns focus to the file field; leaving the page drops it too. There is no import, commit or validate control, and nothing is put in `localStorage` or the URL.

## Limits

- The catalogue is the pinned generation's programme: watchlist films and the people on them. Catalog-only films (`epg/discovered-films.json`), unresolved observations and the resolution ledger are not searched; identity codes that need the ledger (`ambiguous`, `rejected`) are not produced here.
- The catalogue routes do not read fingerprint and prediction state; see `queue_unavailable` above. Only the [prediction recovery read](#prediction-recovery-get-apiadminprediction-recovery) reads them, for one film per request.
- Pages run over an in-memory projection of the whole programme object; a cold request costs five R2 reads and one parse of the programme, a warm one five reads and no parse of the programme.
- The route edits nothing. Reviewed titles and names are still the dictionaries in `data/` and the writers of other cards; these routes have no `POST`; the only `POST` under `/api/admin/` is the [archive preview](#letterboxd-archive-preview-post-apiadminletterboxd-archivepreview), which writes nothing. The health read suggests actions as the model states them and offers no way to run one; the poster summary links to `/admin/posters`.
- `/admin/posters` is the one admin page that calls a write route, and only the existing `POST /api/enrichment/catalog/posters`, after the owner's confirmation. Outcomes `no_poster_on_tmdb` and `tmdb_id_mismatch` are not stored by that route, so those records stay in `verifiedMissing`; only the browser history remembers them.

Rollback is a revert of the routes and the pages: the read routes and the archive preview wrote no R2 object. Posters written by confirmed runs stay, as described in the [poster runbook](../../runbooks/catalog-poster-hydration.md#rollback).
