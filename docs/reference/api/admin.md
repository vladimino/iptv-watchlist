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

## The page

`/admin` is the owner's page over this API: a search field, the queue buttons with their counts, one result list per kind with a "Показать ещё" button while a `nextCursor` exists, and the detail card of the record in the URL. The search and the queue live in the URL (`/admin?q=&queue=&kind=&id=`), so a link reproduces a view; the pin, the cursors and the queue counts live in memory and are dropped by a refresh. Each keystroke is debounced and the previous requests are aborted; an answer that arrives after a newer request is discarded.

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

Film records are the snapshot's programme films ([projection](#the-projection)) with `programmeRunId` of the pinned generation, plus a minimal record (`id`, `storedId`, the queue's `programmeRunId`, `inProgramme: false`) for an outstanding queue film the programme does not carry, such as a catalog film. Only outstanding films get fingerprint and prediction state, from the queue's own verdict: `prediction` is `stale` when the index has a prediction and `missing` otherwise, with the index `generatedAt` as `updatedAt`, the retry `attempts` and `kind`, and the work plan as `nextAction`; `fingerprint` is `current` for `prediction_only` work and `stale` or `missing` for `fingerprint_and_prediction`. A film the queue does not list carries neither field and stays unobserved for those subsystems, so the route never claims a prediction is current. Queue ids are translated to record ids with `canonicalFilmId`. The evaluation runs with `coverage.films: partial`, because a programme snapshot is not every Film.

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

`/admin/limbo` holds the filter in the URL (`kind`, `subsystem`, `cause`, `age`), the pin and cursors in memory. Cause and subsystem chips carry the whole-inventory counts; a form sets kind and age; Escape and "Сбросить фильтры" clear the filter. Each item shows why it is waiting (reason, cause, progress, retry time), since when (days without progress and the last transition), the expected action and whether it is eligible, the threshold, the evidence source and read time, the identity provenance and the last diagnostic, and links to the film in `/admin`. The side panel shows the snapshot, the pipeline context, the unread subsystems and the thresholds, and states that observations are unavailable. Empty, error and stale snapshot are distinct states as on `/admin`. The page has no action button: retries and refreshes are guarded actions of another card.

## Limits

- The catalogue is the pinned generation's programme: watchlist films and the people on them. Catalog-only films (`epg/discovered-films.json`), unresolved observations and the resolution ledger are not searched; identity codes that need the ledger (`ambiguous`, `rejected`) are not produced here.
- Fingerprint and prediction state is not read; see `queue_unavailable` above.
- Pages run over an in-memory projection of the whole programme object; a cold request costs five R2 reads and one parse of the programme, a warm one five reads and no parse of the programme.
- The route edits nothing. Reviewed titles and names are still the dictionaries in `data/` and the writers of other cards; this API has no `POST`.

Rollback is a revert of the route and the page: no R2 object was written by them.
