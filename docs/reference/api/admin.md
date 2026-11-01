# Owner admin API

`GET /api/admin/*` answers the owner's `/admin` page from one **published snapshot** of the programme: the generation pointer, that generation's programme object, the two localization dictionaries and the owner-review overlay. It searches Film and Person projections, lists quality queues and returns one record, always from the same version tuple, which every answer names as an opaque `pin`. Those routes never list the bucket, never fall back to the root `programme.json`, never write, never read a lease, the resolution ledger, the discovery snapshot or an enrichment object, and never call TMDB, Letterboxd, a model or MCP. The [GET side-effect test](../../../tests/get-side-effects.mjs) covers them like every other read. The later sections add bounded reads with their own read sets, and the guarded writes under `/api/admin/`: the [film title review](#film-title-review-post-apiadminfilmsstoredidtitle-review), the [person name confirmation](#person-name-confirmation-post-apiadminpeopleidname-review) and the [discovery observation reconsideration](#discovery-observation-recovery-get-apiadmindiscovery-recovery).

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
| 5 | `admin/owner-reviews.json`, or `owner_review_entry` when that marker is `d1` | The owner-review overlay for Film titles and Person names ([ADR 0072](../../adr/0072-owner-reviewed-localization-overlay.md)). While `owner_review_authority` is absent or `mode` is `r2`, a missing object is an empty document and a `null` version, not an error. Its etag is `reviewsVersion`. The body is not written by this read. When `mode` is `d1` ([ADR 0081](../../adr/0081-d1-authoritative-owner-reviews.md), Proposed), this step reads the rows. `reviewsVersion` is `d1:<generation>`. The read does not write the rows and does not repair the R2 mirror. A pin from the other mode does not match. Version 9 without the tables, or an invalid marker, is 503 `storage_unavailable` and does not fall back to the object. Migration `0009` is not applied, so production still uses the object |

Each object's version is its R2 etag; when the object exists and the etag is empty, the version is the SHA-256 of the loaded bytes. A missing etag is never "unchanged". `updatedAt` is not a match key.

While `published_epg_authority.mode` is `d1` ([ADR 0079](../../adr/0079-d1-authoritative-published-epg.md)), steps 1 and 3 are one read of that D1 pointer and step 2 is `published_epg_document` for the same run. The generation etag in the pin is the D1 fence token, and the programme etag is the SHA-256 of the D1 document. The root `programme.json` is still not read. A failed D1 read is `503`, not a fallthrough to another R2 generation. Dictionaries and `admin/owner-reviews.json` stay R2. The poster and discovery-index reads use the same D1 run and still load their R2 generation copies. This is not the production path until `0008` is applied and a later activation sets the marker. The table above remains the path while the marker is `r2` or the migration is absent.

A failure of R2 itself (an exception from the binding) is 503 `storage_unavailable`. No retry reaches a writer and nothing is repaired.

### Warm isolate

The handler keeps one immutable in-memory projection keyed by the full version tuple, including `reviewsVersion`. In `d1` mode that part is the generation string, so a new owner-review generation drops the held body even when the published EPG pointer did not move. A later request still performs the six reads above and compares every version; a held body is reused only when its version is unchanged, and the records are rebuilt when any version differs. The pointer is always parsed because it decides the run. An R2 `get` opens a live response stream, so a body the handler does not read is cancelled before the earlier parse is reused; no stream is left open for garbage collection, and the test's R2 stand-in opens real streams to prove it. The cache is not an R2 object and nothing writes it at EPG publish. A successful film-title put drops the cache so the next read cannot serve the previous title.

## The projection

Film records come from the programme films of the pinned generation, Person records from the people embedded in them and in the programme's `people` catalogue, both through the pure `filmView` / `personView` of the [Film/Person contract](../domain/film-person.md):

- **Identity** from the stored Letterboxd id and the TMDB id on the film (`resolved` with `canonicalIdentity: tmdb:<id>` when both are present, `unresolved` otherwise). The resolution ledger is not read, so no record is `ambiguous` or `rejected` from this route; those codes stay in the queue list for the contract's sake and count zero.
- **Localization** from the reviewed dictionaries baked into the Worker (`data/film-titles.json`, `data/person-names.json`), the film's own `titleRu`/`titleStatus`, the `titles.json` provisional cache and the `people.json` name cache. A film entry in the overlay whose localization is `reviewed` with `authority: owner` replaces that localization, the title aliases, `titleReviews` and `localizationConflicts`. A film slice with aliases and no owner localization does not replace the preferred title: admin search, the film card, the programme and the watchlist keep the dictionary or automatic title and gain the stored alias strings, so search finds the alias. A Person entry in the `people` map keeps that reviewed name when its localization is `reviewed` with `authority: owner`; a different dictionary or cached value is held beside it with reason `owner_kept`. A slice with aliases and no owner localization does not replace the preferred name: the admin record and the programme credit keep the live name and gain the stored alias strings, so search finds the alias. The Person id stays the programme credit's id. `localizationConflicts` otherwise come from `titleConflicts` / `nameConflicts` on the record. The film detail answer adds `item.titleReview`, the read model from the [title review contract](../domain/film-title-review.md). Its choices include the published film's title aliases and the dictionary entry's aliases, which `filmView` alone does not copy. Search rows do not carry `titleReview`; they do carry those aliases on the record. The person detail answer adds `item.nameReview` from the [name review contract](../domain/person-name-review.md) when that module is loaded.
- **Metadata** from the fields the programme film carries (`metadataAt`, `synopsis`, `peopleVersion`); freshness is judged against the programme's `updatedAt`, not the wall clock, so a page is stable for the life of its pin.
- **Not on the record:** `fingerprint` and `prediction`. That state lives under `enrichment/`, which this read does not load. The two queues `fingerprint-not-current` and `prediction-not-current` answer 400 `queue_unavailable`, and the overview lists them under `unavailableQueues` so the page can say so instead of counting every film.
- Each record also carries `storedId` (the programme id), `preferred` (the localized value or `null`) and `year`. Shows, synopsis and credits are not returned.

Records are sorted by `storedId` (films) and `roleId` (people) with `en` comparison before paging, and `now` for every dimension is the programme clock, so the same tuple always yields the same records and the same cursors.

## Routes

The routes in this table are `GET`; any other method is 405 `method_not_allowed`. Unknown paths under `/api/admin/` are 404 `not_found`. The [film title review](#film-title-review-post-apiadminfilmsstoredidtitle-review) and the [person name confirmation](#person-name-confirmation-post-apiadminpeopleidname-review) are separate POSTs.

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

`pin` is an opaque string. It is version `2` and encodes `programmeRunId`, `generationEtag`, `programmeEtag`, `titlesVersion`, `peopleVersion`, `reviewsVersion`; the client sends it back verbatim and never assembles one. A pin matches only when all six version parts equal the tuple just read. A missing `admin/owner-reviews.json`, while the owner-review marker is absent or `r2`, is an empty `reviewsVersion`, not an error. A change of `titles.json` alone, `people.json` alone, or the owner-review revision alone is a stale pin, as is a new generation or a rewritten programme object of the same run. In `d1` mode `reviewsVersion` is `d1:<generation>`, not the mirror etag. A pin minted under the other mode is 409 `stale_pin`. A pin from version `1` (no overlay part) does not parse and is 400 `invalid_pin`.

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
| the admin snapshot (the six reads above, cached by version) | pointer, generation programme, `titles.json`, `people.json`, `admin/owner-reviews.json` | `published` (`publishedAt` from the pointer, else the programme clock) and the Film records with `programmeRunId`, `observedAt`, and `poster` when the programme film carries that field |
| `enrichment/view-index.json` with `enrichment/profile/current.json` | the per-film fingerprint and prediction facets | `fingerprint` and `prediction` envelopes (`current`, `stale` or `missing`; `updatedAt` from the prediction's `generatedAt`) judged by the same freshness rule as every other reader. Without the index or the profile no envelope is derived and the route reports both subsystems as `unknown` with `derived: "view_index"` |
| `enrichment/prediction-queue.json` | the queue | `predictionQueue`, with its film ids re-keyed to the record ids (`film:<storedId>`) so membership and retries meet the same identifiers as the records |
| `epg/resolver-continuation.json` | the raw continuation record | `discovery` (`stage`, `reason`, `at`, `retryAt`, `nextCatchUpAt`, `remainingChunks`, `programmeRunId`). The lease is not read; a stale `running` record is reported as old, not as orphaned |
| `epg/generations/<run>/discovered-films.json` | the generation's catalog copy | `posters` (the counts `catalogPosterMissing` gives: `missingPoster`, `verifiedMissing`, `unverifiedMissing`, a sample of verified ids) |

Not read, and therefore **not supplied** to the model, which reports them as unknown rather than healthy: the unresolved observations (they live in the resolution ledger; the limbo inventory is their bounded view) and the Letterboxd baseline (the import leaves per-chunk receipts under `letterboxd/imports/<sha256>/` and no summary object; finding the latest one would list the bucket). `coverage` is `films: complete` (the whole programme) and `observations: partial`, so `identity` can at most be `clear_in_scope`.

A cold request is eleven R2 reads (six of the admin snapshot, five health objects), one parse of each changed object and no other work; every read settles before the answer, so a failed read never leaves another half-open. `now` is the Worker clock at the request.

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

`/admin` is the owner's page over this API, in two views switched by `?view=`: the catalogue (default) and [data health](#the-health-view). The catalogue view: a search field, the queue buttons with their counts, one result list per kind with a "Показать ещё" button while a `nextCursor` exists, and the detail card of the record in the URL. A Person card adds the name form described below. The health view stays read-only. The search and the queue live in the URL (`/admin?q=&queue=&kind=&id=`), so a link reproduces a view; the pin, the cursors and the queue counts live in memory and are dropped by a refresh. Each keystroke is debounced and the previous requests are aborted; an answer that arrives after a newer request is discarded.

The page distinguishes three states the owner must not confuse: **empty** (200 with no items: "Ничего не найдено"), **error** (a 4xx/5xx or a network failure: the message of the code above, no results shown) and **stale snapshot** (a 409, or two answers with different pins: the results on screen stay, a banner says the published snapshot changed and a button reloads without the pin). The snapshot line names the generation, the programme and dictionary clocks and any skew. Fingerprint and prediction appear as "вне снимка программы" on a film card. The film card also holds the [title review form](#film-title-review-post-apiadminfilmsstoredidtitle-review) immediately under the preferred title, the original title and the localization status. Names, the original, the year and the statuses are on the open card. Storage ids, canonical identity and the full provenance sit in one closed «Технические сведения»; they stay in the API. An external id is listed there with its scheme and its trusted, untrusted or conflicting mark even when its number also appears in the canonical identity, so that mark is not dropped. Film alias text stays in «Другие названия»; the request id and the rest of that alias's provenance stay in the technical disclosure. A person card still shows alias provenance beside the name. The form offers the current localized preferred title, a confirmed previous preferred title, and at most five other choices whose provenance `source` or `authority` is `dictionary` or `owner`. Either field is enough, including `authority: dictionary` when `source` is absent or is something else. A provisional Wikidata preferred title is the first radio. Programme, Letterboxd and EPG aliases are not choices unless they are that current or previous title, and a Cyrillic string is not treated as Russian. The checkbox «Использовать как предпочтительное» starts unchecked, and the preview is hidden. Choosing another existing Russian radio checks the box and shows `Сейчас: … → Станет: …` plus the card and search consequence; nothing is posted until «Сохранить вариант», which then sends `mode: "alias"` and `effect: "promote"`. Choosing the current preferred title leaves the box off, disables the button and says that title is already preferred. Turning the box off again on any other existing radio disables the button and says that variant is already stored; that click does not send `add_alias`. A typed title clears the radios. An automatic check from a radio does not stay on once the owner types, so the typed title is `add_alias` unless the owner checks the box after that. With the box off, «Сохранить вариант» sends `effect: "add_alias"`. With the box on, it sends `effect: "promote"`. The preview stays hidden, with no border and no leftover gap, until the box is on and the chosen text differs from the current preferred title. It never shows «Станет» without that text. A 200 with `changed: false` that is not an idempotent replay stays on the form: the status says nothing was written (`duplicate_alias` or an already preferred title) and the card is not reloaded. An idempotent replay still reloads. Every alias stays on the record and in search; the film card lists the rest inside a closed «Другие названия (N)», as the title text only, not as a second set of controls and not with a kind label. Kind and provenance stay in the technical disclosure. The audit is not part of the form. When the film has review entries, one closed «Журнал (N)» is the last block on the card, after the other statuses and the technical disclosure, and it stays closed until the owner opens it. An empty audit adds no block. An alias add reads as an added variant. A preferred change, including an older entry that has no effect, reads as the previous title, an arrow and the new title, with the basis. The time is Europe/Madrid civil time (day, month, year, hour and minute), labelled «(Мадрид)», including summer time; the stored instant stays UTC. A missing or unreadable time is omitted. The person card keeps its own «Журнал» inside the name form and uses the same clock. A person card keeps its name form and folds aliases, external ids and conflicts under «Алиасы, внешние id и конфликты»; the alias list inside that fold is «Другие имена (N)» (or «Других имён нет.»). A 409 `version_conflict` tells the owner to reload and is not shown as success. A network failure keeps the original command for the retry. A 503 `readback_failed` is an unknown commit: the page reloads the card and does not say the title is unchanged. It says the command is stored only when the reloaded card's audit contains this `requestId` with an after-token and, for a promote, the preferred title matches. For `add_alias` the audit effect must be `alias_added`, `to.value` must be the submitted text, and the record's aliases must contain that text with owner-added provenance (`authority` or `source` `owner`, or `added: alias`). A matching `titleReview.options` entry, including an EPG or original title, is not that proof, and neither is a programme alias of the same text. An unchanged preferred title is the normal result of that command and is not proof. Otherwise it keeps the original command — `filmId`, `requestId`, `mode`, `value`, `basis`, `effect` and `expectedVersion` — and the next send posts that same object. The restored checkbox shows that same effect. A later edit of a field, including the checkbox, or a confirmed refusal, discards it.

## Person name confirmation: `POST /api/admin/people/<id>/name-review`

The Person card on `/admin` is the only caller. The button **Сохранить вариант** sends one command from the [name review contract](../domain/person-name-review.md):

```text
{ personId, requestId, mode: "alias" | "manual", value, expectedVersion, basis?, effect?: "promote" | "add_alias", roles?: [{ id, expectedVersion }] }
```

`<id>` and `personId` are the same role-specific id (`person:actor/<slug>`, `person:director/<slug>`, …). The path encodes the id. `requestId` is the idempotency key for one command. The page mints it on the first submit and keeps the whole posted command while the outcome is unknown (the request failed on the network, or the server answered `readback_failed`): `expectedVersion`, each role id with its `expectedVersion`, mode, value, basis and `effect`. A refreshed card does not replace those tokens, and a choice that is no longer on the card is still sent. A confirmed refusal, or an edit of the form, drops that command and the next submit mints a new one. `expectedVersion` and each role token are the tokens the detail read showed when the command was first posted. The form's checkbox **Использовать как предпочтительное** starts unchecked every time the card is opened and after a save. Unchecked, the page sends `effect: "add_alias"` and no roles: the preferred name, the original credit and the shows stay, and a text that is already on the record answers `changed: false` with `reason: "duplicate_alias"`. Checked, the page sends `effect: "promote"`, shows `Сейчас: … → Станет: …` and that the new name will appear in films and search, and includes `roles` only for the other roles the owner checked. A command that omits `effect` is still a promote, so a retry posted before this checkbox existed does not change meaning. `roles` on `add_alias` is 400 `roles_not_allowed`. The request is `POST`, `Content-Type: application/json`, header `X-IPTV-Admin-Action: person_name_review`, same origin, `credentials: 'same-origin'`, and at most 8000 bytes. A missing or different `Origin` is 403 `origin_not_allowed`. A missing or different action header is 403 `action_not_allowed`. GET of this path is 405. Nothing else on the catalogue page sends this request.

The detail answer still carries every alias and every `nameReview.options` entry. The card shows the preferred Russian name, the original credit, the variant field and the checkbox in front. The current preferred value is always a radio, including a provisional Wikidata name, and that radio is marked «текущее предпочтительное». Showing it does not store another alias and does not change its source or status. A radio is also offered for another option whose provenance names `owner` or `dictionary`, whose provenance records `language: "ru"`, or whose provenance has `previousPreferred: true` (the localization this promote just replaced, including a Wikidata or provisional one). A different name in Cyrillic with no such provenance is not a choice, and a Latin credit is not a choice unless it is the current preferred value. The remaining aliases, provenance and the audit sit in collapsed sections. More than four role collisions sit there too; a shorter role list stays a fieldset and its boxes are disabled until the checkbox is on. Alias mode on the server still accepts any option the contract lists.

The Worker loads the same published snapshot as the other admin reads and runs `applyPersonNameReview`. It does not call TMDB, Letterboxd, Wikidata or a model, and it does not rewrite `programme.json`, `people.json`, `titles.json`, `data/person-names.json`, a published generation, or Film and Person rows. While the owner-review marker is absent or `r2`, a change is one conditional `put` of `admin/owner-reviews.json`. When `owner_review_authority.mode` is `d1`, both maps commit in one fenced D1 batch and the object is the mirror written afterwards. The form is unchanged. The body is `{contractVersion: 1, films, people}`. This route replaces only the `people` entries named by the contract's `commit` and copies `films` unchanged. The object's etag is the compare-and-swap guard. A missing object is created only when the key is still absent. An object whose `contractVersion` is not 1, or whose `films` or `people` is not an object, is left untouched (`review_store_unreadable`). An existing object with an empty etag is not overwritten (`review_unconditional`). A put the storage accepts is not yet success: the route reads the object again and checks the primary `requestId` plus every committed record's after-token. If that read fails, the body is unreadable, or any record disagrees, the answer is 503 `{error: "storage_unavailable", reason: "readback_failed"}` and the pre-write snapshot is not returned as a saved card. The page reloads the card. It says the name is stored only when that card's primary audit contains this `requestId` and every requested role id is in `roleLinks`. A matching preferred name is not that proof. Otherwise it keeps that same posted command and sends it again unchanged. The restored form shows that command: the checkbox is on when the command changes the preferred name and off when it only adds a variant, and the submitted value stays in the variant field when the card no longer offers it as a radio.

| Status | `error` | When |
| --- | --- | --- |
| 200 | — | `{ok, idempotent, changed, version, personId, nameReview, pin, snapshot}`. `nameReview` is `personNameState` of the record read back after the put, and `version` is that record's token. A replay of the same `requestId` and payload is `idempotent: true` and does not write again, and only when every committed record is still at its after-token. A current `add_alias` whose text is already on the record is `changed: false` and `reason: "duplicate_alias"` and does not write |
| 400 | `invalid_json`, `invalid_name`, `invalid_mode`, `invalid_effect`, `invalid_basis`, `invalid_roles`, `roles_not_allowed`, `unknown_alias`, `unknown_role`, `unrelated_role`, `person_mismatch`, `identity_change_forbidden`, `missing_request_id` | the command is refused; nothing is written |
| 403 | `origin_not_allowed`, `action_not_allowed` | `Origin` is missing or is not this host, or `X-IPTV-Admin-Action` is not `person_name_review` |
| 404 | `missing_person` | that id is not in the published programme |
| 405 | `method_not_allowed` | not POST |
| 409 | `request_id_reused`, `rejected_identity`, `rejected_role`, `review_incomplete`, `review_store_unreadable`, `storage_conflict` | the request id was used for a different command, a role set does not match the stored tokens, or the conditional put lost. A `review_incomplete` answer names `records` and does not overwrite the object |
| 412 | `version_conflict`, `role_version_conflict` | `expectedVersion` is not the record's current token. The body includes `expected` and `received` |
| 413 | `body_too_large` | the body is over 8000 bytes |
| 503 | `programme_unavailable`, `storage_unavailable`, `review_unconditional` | the snapshot cannot be read, or the stored object has no etag to compare. A put that was accepted but whose following read could not prove the committed records is also `storage_unavailable`, with `reason: "readback_failed"`. That reason does not say the name failed to save; the page repeats the same `requestId` |

Deploying this route writes nothing. The programme and watchlist reads overlay a reviewed name from the `people` map onto credits after the dictionary and the name cache, so both films that credit the role show the saved name without a credit rebuild. An alias stored without an owner-reviewed localization is added to those credits' alias lists and does not replace the name. The EPG commit does not read or write the object. A later dictionary or automatic name does not replace an owner review; the admin card holds it as `owner_kept`. The identity GET and the Finds person filter do not read this object, so a saved role link does not by itself change that grouping.

Rollback of the Worker stops reading and writing the object. The object itself stays. Code rollback does not delete or downgrade a review already stored. A later EPG commit on a build without the overlay can publish the dictionary name again; the stored review remains for the build that reads it.

## Limbo inventory

`GET /api/admin/limbo` lists the films that are not progressing and why, for the owner page `/admin/limbo`. It is read-only and behind the same Access application. Source: [`src/admin/limbo.js`](../../../src/admin/limbo.js) (handler), [`src/domain/limbo-inventory.js`](../../../src/domain/limbo-inventory.js) and [`src/domain/data-health.js`](../../../src/domain/data-health.js) (pure, bundled as `LimboInventory` and `DataHealth`), [`src/admin/limbo-client.js`](../../../src/admin/limbo-client.js) and [`public/admin-limbo.js`](../../../public/admin-limbo.js) (the page). Tests: [`tests/admin-limbo-api.mjs`](../../../tests/admin-limbo-api.mjs), [`tests/admin-limbo-page.mjs`](../../../tests/admin-limbo-page.mjs), [`tests/limbo-inventory.mjs`](../../../tests/limbo-inventory.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins its read set.

### What is read

The six reads of the [snapshot above](#what-is-read), in the same order and with the same failures, then two more objects and the published generation's [observation index](../domain/discovery-observation-index.md). No `BUCKET.list`, no per-film object under `enrichment/films/`, no body of the resolution map or of the discovery ledger, no lease or continuation.

| Step | Key | Use |
| --- | --- | --- |
| 6 | `enrichment/prediction-queue.json` | Outstanding films (`hotPending`, `coldPending`, `pending`), `retries` (`retryAt`, `attempts`, `kind`, `scope`, `lastRunId`), the per-film `work` plan, `programmeRunId`, `refreshedAt`, `lastCheckAt`. Absent is reported, not treated as an empty queue |
| 7 | `enrichment/view-index.json` | The stored prediction's `generatedAt` and the `fingerprintHash` of an outstanding film: the clock of its last progress. Only entries of outstanding films are used |
| 8 | `epg/published-generation.json` again, then `epg/generations/<run>/discovery-observations/manifest.json` | The run the index must belong to, and the manifest. A warm isolate reuses the parsed shards and cancels the manifest body when the manifest etag is unchanged |
| 9 | `…/discovery-observations/shard-NN.json` | Only the shards the manifest counts records in |
| 10 | `head` of `epg/discovery-resolution.json` and of `epg/generations/<run>/discovery-latest.json` | Freshness only: the etags are compared with the manifest's `sources`; no body is read |

The queue and index versions and the manifest etag join the pin; a warm isolate reuses a parsed body only when its version is unchanged, as above. The index's freshness is judged on every request, never taken from the cache.

### Projection

Film records are the snapshot's programme films ([projection](#the-projection)) with `programmeRunId` of the pinned generation, plus a minimal record (`id`, `storedId`, the queue's `programmeRunId`, `inProgramme: false`) for an outstanding queue film the programme does not carry, such as a catalog film. Only outstanding films get fingerprint and prediction state, from the queue's own verdict and stamped with the queue's `programmeRunId`: `prediction` is `stale` when the index has a prediction and `missing` otherwise, with the index `generatedAt` as `updatedAt`, the retry `attempts` and `kind`, and the work plan as `nextAction`; `fingerprint` is `current` for `prediction_only` work and `stale` or `missing` for `fingerprint_and_prediction`. A film the queue does not list carries neither field and stays unobserved for those subsystems, so the route never claims a prediction is current. When the queue was built for another generation than the published one, every such per-film diagnosis fails closed: cause `stale_projection`, action `wait` / `reread_snapshot`, `eligible: false`; `context` carries the queue-level `projection_generation_differs` issue, and programme-derived items of the same films keep their own verdict. Queue ids are translated to record ids with `canonicalFilmId`. The evaluation runs with `coverage.films: partial`, because a programme snapshot is not every Film.

**Unresolved observations come from the observation index.** With a `fresh` or `stale` index of the published generation, its records are supplied to the model as `observations` with `coverage.observations: partial` and `observedAt` = the index's `writtenAt`. They become observation items with the index title (`item.observation`). The index holds only current observations that already have a decision, so the list is never the whole population: an observation awaiting its first lookup is counted in `awaitingFirstLookup`, not listed. Without a readable index (`missing`, `other_generation`, `malformed`, `torn`, no published generation, or a storage failure) no observation is supplied. The answer says so in `coverage.observations` (`available: false`, `reason: index_<state>`), and a `kind=observation` filter returns an empty list beside that statement, never a claim that nothing is unresolved.

### Parameters

| Parameter | Rule |
| --- | --- |
| `kind` | `film` or `observation`; otherwise 400 `unknown_kind` |
| `subsystem` | `identity`, `metadata`, `localization`, `fingerprint`, `prediction`; otherwise 400 `unknown_subsystem` |
| `cause` | `retry_eligible`, `stalled`, `backoff`, `pending`, `manual_review`, `stale_projection`, `external_archive`, `unknown` ([meaning](../domain/data-health.md#limbo-inventory)); otherwise 400 `unknown_cause` |
| `age` | Minimum days without progress, digits `0`–`365`; otherwise 400 `invalid_age`. Items of unknown age are kept |
| `limit` | As for the collection routes: omitted is 25, present must be `1`–`25` |
| `cursor` | The `nextCursor` of the previous page of the same filter, limit and pin; otherwise 400 `stale_cursor` |
| `pin` | A limbo pin (`L2|…`). An admin catalogue pin is 400 `invalid_pin`; a limbo pin that is not the tuple just read is 409 `stale_pin` |

Parameters are validated before any read. No filter is required: the whole inventory is bounded by the snapshot.

### Answer

`{pin, snapshot, kind, subsystem, cause, age, limit, items, nextCursor, total, counts, coverage, context, unread, thresholds, vocabulary}`.

- `snapshot` is the catalogue snapshot object plus `evaluatedAt` (the clock of this evaluation), `sources` (the keys above, with `<programmeRunId>` and `shard-NN` as placeholders), `clock` (skew anomalies), `queuePresent`, `queueRefreshedAt`, `queueProgrammeRunId`, `queueLastCheckAt`, `queueUploadedAt`, `indexPresent`, `indexUploadedAt`.
- `items` are [limbo items](../domain/data-health.md#limbo-inventory) of the filtered list; `total` is that list's length; `counts` cover the whole unfiltered inventory.
- `context` holds the whole-object health issues of the same evaluation (the published generation, the prediction queue), so an item is read with the pipeline state around it: a queue built for another generation, eligible work without runs. `unread` names the subsystems this route does not observe (`discovery`, `letterboxd_archive`, and `prediction_queue` when the object is absent); they are unknown, not healthy.
- `coverage` is `{films, filmsObserved, observations, observationsObserved}`. `observations` is either `{available: false, reason, state, programmeRunId}` or `{available: true, state: fresh|stale, reasons, programmeRunId, writtenAt, writer, scope, indexed, eligible, omitted, complete, awaitingFirstLookup}` from the manifest; `stale` means the decision map or the ledger changed after the index was written.
- `thresholds` are the model's thresholds in force.

**Pin and cursor.** The pin is `L2|` + the catalogue pin + the queue version + the index version + the observation manifest etag (empty without a readable index). A change of the queue, the view index or the observation manifest alone is a stale pin, as is any change of the catalogue tuple. The cursor carries the pin and the evaluation clock (`evaluatedAt`) in front of the inventory cursor: every later page is cut from the same evaluation, so an age or a due retry does not shift between pages, and a fresh first page evaluates at the current clock.

**Errors.** Those of the catalogue routes, plus `unknown_kind`, `unknown_subsystem`, `unknown_cause`, `invalid_age` (400) and `evaluation_failed` (500, the model refused the snapshot; nothing is written).

### The page

`/admin/limbo` holds the filter in the URL (`kind`, `subsystem`, `cause`, `age`), the pin and cursors in memory. Cause and subsystem chips carry the whole-inventory counts; a form sets kind and age; Escape and "Сбросить фильтры" clear the filter. Each item is a short card: the title and year, the kind (film, a film outside the programme, or an observation), one cause badge, the specific reason when it adds something the badge does not, one sentence naming who moves next, and the retry time or the last transition when that time changes the decision. It does not show empty states, "not applicable", raw codes or a second copy of the badge. The record id, the observation key, the subsystem, the severity, the formal action and its eligibility, the threshold, the evidence source and read time, the identity provenance and the diagnostics sit in a closed «Технические подробности». A link to the film in `/admin` is given only when the film is in the published programme; a film known only from the queue says that the catalogue has no card for it. The actions sit in their own row, wrapping inside the card. The side panel shows the snapshot, the pipeline context, the unread subsystems and the thresholds, and the observation coverage: partial, with the indexed count, what the cap cut, how many await a first lookup and when the index was written, with a warning when it is stale; or unavailable, with the reason. Empty, error and stale snapshot are distinct states as on `/admin`. The page is the third section of the admin navigation (Каталог, Здоровье данных, Лимбо, Постеры). A film item of the prediction or fingerprint subsystem carries «Разобрать прогноз», which opens the [prediction recovery panel](#the-prediction-recovery-panel) for that film. An observation item carries «Разобрать наблюдение», which opens the [observation recovery panel](#the-observation-recovery-panel) and only explains the observation, except for the one guarded write below. That panel holds the page's only write control, the guarded reconsideration of one observation. There is no button for a film: no targeted prediction write exists ([why](admin-actions.md#prediction-recovery)).

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

## Discovery observation recovery: `GET /api/admin/discovery-recovery`

One discovery observation (one EPG candidate key) is explained from the [observation index](../domain/discovery-observation-index.md). When the explanation allows it, the owner can send that observation back to the ordinary resolver queue with `discovery_reconsider@1` ([ADR 0061](../../adr/0061-discovery-observation-index-and-reconsider.md)), or assign or reject one movie id with `discovery_identity_correct@1` ([ADR 0080](../../adr/0080-discovery-identity-correction.md), Proposed). Neither action calls TMDB, runs a chunk or starts a series. Everything sits behind the same Access application.

Source: [`src/admin/discovery-recovery.js`](../../../src/admin/discovery-recovery.js) (handlers and both executors), [`src/domain/discovery-recovery.js`](../../../src/domain/discovery-recovery.js) (assessment and the reconsider gate, bundled as `DiscoveryRecovery`), [`src/domain/discovery-identity-review.js`](../../../src/domain/discovery-identity-review.js) (the identity offer and command, bundled as `DiscoveryIdentity`), [`src/domain/admin-actions.js`](../../../src/domain/admin-actions.js) (the [guarded action contract](admin-actions.md), bundled as `AdminActions`), [`src/admin/discovery-recovery-view.js`](../../../src/admin/discovery-recovery-view.js) (the panel), and `loadDiscoveryRecovery`, `confirmDiscoveryReconsider`, `executeDiscoveryReconsider`, `confirmDiscoveryIdentity` and `executeDiscoveryIdentity` in [`src/admin/limbo-client.js`](../../../src/admin/limbo-client.js). Tests: [`tests/discovery-reconsider.mjs`](../../../tests/discovery-reconsider.mjs), [`tests/discovery-identity-review.mjs`](../../../tests/discovery-identity-review.mjs), [`tests/admin-discovery-recovery-page.mjs`](../../../tests/admin-discovery-recovery-page.mjs), [`tests/discovery-recovery.mjs`](../../../tests/discovery-recovery.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins the read sets of the GETs.

| Route | Effect |
| --- | --- |
| `GET /api/admin/discovery-recovery?key=<key>[&pin=<pin>]` | Read-only assessment, reconsider preview and identity offer |
| `POST /api/admin/discovery-recovery/confirm` | Issues a reconsideration and stores it as an `approved` action record; changes no decision |
| `POST /api/admin/discovery-recovery/reconsider` | Executes one issued reconsideration |
| `GET /api/admin/discovery-recovery/receipt?idempotencyKey=<key>` | Returns the stored reconsideration record; read-only |
| `POST /api/admin/discovery-recovery/identity-confirm` | Issues one assign or reject; changes no decision |
| `POST /api/admin/discovery-recovery/identity-correct` | Executes one issued identity correction |
| `GET /api/admin/discovery-recovery/identity-receipt?idempotencyKey=<key>` | Returns the stored identity record; read-only |

Any other method is 405 `method_not_allowed`, and an unknown path under `/api/admin/discovery-recovery/` is 404.

### What is read

The GET routes get a bucket wrapper with only `get` and `head`, so they cannot put, list or delete. The assessment reads exactly:

| Key | Use |
| --- | --- |
| `epg/published-generation.json` | The published run |
| `epg/generations/<run>/discovery-observations/manifest.json` and the one shard of the key | The record, its `decisionHash`, the index state |
| `head` of `epg/discovery-resolution.json` and `epg/generations/<run>/discovery-latest.json` | Index freshness; no body |
| `epg/resolver-continuation.json`, `epg/discovery-status.json`, `epg/resolver-lease.json` | The series state, the TMDB throttle (`retryAt`) and the live writer |

A shard is read only when the manifest is readable. The reconsideration receipt reads only `admin/actions/discovery_reconsider/v1/<idempotencyKey>.json`. The identity receipt reads only `admin/actions/discovery_identity_correct/v1/<idempotencyKey>.json`. Nothing on these GETs reads the ledger, the resolution-map body or the catalogue.

### Parameters and pin

| Parameter | Rule |
| --- | --- |
| `key` | Required: 1–200 characters, no control characters; otherwise 400 `invalid_key`, before any read |
| `pin` | Optional: `D1.` + 32 lowercase hex digits; otherwise 400 `invalid_pin`. A pin that is not the version set just read is 409 `{error: "stale_pin", pin}` |

The pin is a digest of every key read with its etag (`absent`, `unavailable`). The resolver lease is left out: it is judged on its own, and the executor's own lease must not make the pin it compares stale. The page uses the pin to say "the state changed", and the action uses it as the confirmed scope.

### Answer

`{pin, evaluatedAt, atomic: false, target: {key}, index, indexed, observation, assessment, identity, action, coordination, sources}`:

- `index`: `{state, reasons, programmeRunId, writtenAt, writer, coverage, counts}`.
- `indexed`: whether the key has an index record. Without one, `observation` and `assessment` are `null`.
- `observation`: the index record (title, year, durations, shows, activity fields, `decision`, `decisionHash`).
- `assessment`: the [recovery assessment](../domain/discovery-recovery.md), with `execute` as the [reconsideration gate](../domain/discovery-recovery.md#the-reconsideration-gate). `review.available` stays false; it is not the identity action.
- `identity`: the offer from [ADR 0080](../../adr/0080-discovery-identity-correction.md). `{capability, version, available, reason, trusted, hypothesis, rejectable, rejectedTmdbIds, current, coverage, effect, authority, programmeRunId}`. `trusted` holds the observation's confirmed movie id, or is empty. `hypothesis` is the scorer's accepted id with `trusted: false`, or null. `coverage.scope` is `current_unresolved_with_decision` and `coverage.complete` is the index flag. `effect.when` is when a later ordinary chunk would touch catalogue shows. The offer is not an admin-actions preview: the effect and the id are not chosen yet.
- `action`: the reconsideration preview, `{capability, version, status, reason, gate, scopeFingerprint, affected, excluded, budget, confirmTtlMs, compensation, atomic: false, cost}`. `status` is `eligible` only when the reconsideration gate is available on complete evidence. `cost` is `{tmdbCalls: 0, chunksStarted: 0, writes: {resolutionMap: 1, actionRecord: 3, observationIndex: 2}}`.
- `coordination`: the read status (`recorded`, `not_recorded`, `unavailable`) of the lease, the continuation and the status.
- `sources`: the keys read.

**Errors.** 400 `invalid_key`, 400 `invalid_pin`, 405, 409 `stale_pin`, 503 `storage_unavailable`.

### Owner requests and refusals

Both POSTs need all of these, or they answer 403 `access_denied` before any read:

- the Cloudflare Access assertion header (`Cf-Access-Jwt-Assertion`), which the edge adds to every request it admits;
- `Origin` equal to the Worker's origin; the Worker itself refuses any other origin earlier with 403 `Origin not allowed`;
- `X-IPTV-Admin-Action: discovery_reconsider`;
- `Content-Type: application/json`.

The body is a JSON object of at most 16 KB. The Worker does not verify the assertion's signature; the Access application in front of the Worker is the authority, as for every other owner route.

**Confirm.** The body is `{key, pin, idempotencyKey, accepted: true}`, where `idempotencyKey` is 16–80 letters, digits, `_` or `-` and the page generates it randomly. The route judges the observation again and refuses with nothing written when:

- `pin` differs: 409 `stale_pin` with the current `pin`;
- the preview is not eligible: 409 `not_eligible` with the gate `reason`.

Otherwise it issues the contract confirmation (10 minutes) and creates the action record only if none exists under that key (409 `idempotency_conflict` otherwise). The answer is `{confirmation, preview}`. 400 `invalid_request` and 400 `confirmation_missing` (`accepted` not `true`) come before any read.

**Reconsider.** The body is `{confirmation}`, exactly as issued. In this order:

1. An invalid confirmation is 400 `invalid_request`, an unknown capability version 400 `unsupported_capability`, and no stored record 409 `confirmation_missing`.
2. A stored receipt is returned as `{replayed: true, receipt, state}`, and nothing is written. A stored `running` intent without a receipt is 409 `in_progress` with `state: unknown`: an earlier submission started and its outcome is unknown, and it is never redone.
3. The resolver lease is checked. If it cannot be read, the answer is 503 `storage_unavailable`. If the stored lease is not one the resolver would write (no string `id` or no finite `expiresAt` ≥ 0), it is 409 `lease_unknown` and the lease is not taken over. A live lease is 409 `lease_held`. Neither of these consumes the confirmation.
4. Under the acquired lease, a fresh read is checked against the issued confirmation by the contract's `checkSubmission`. It can refuse with `access_denied`, `confirmation_mismatch`, `confirmation_expired`, `stale_pin`, `record_changed` or `eligibility_changed`.
5. The decision map is read. The action refuses with `record_changed` when the map's etag differs from the one the fresh index named, or the decision's digest differs from `decisionHash`.
6. The `running` intent is stored by compare-and-swap, with the before-image `{resolutionEtag, decisionHash, decision}` and the planned after-image.
7. The lease is renewed as the fence. Then the map is written with `onlyIf.etagMatches`, changing only that key, to [`reconsideredDecision`](../domain/discovery-recovery.md#the-reconsideration-gate).
8. The decision is read back and compared by digest.
9. The index record and the manifest are refreshed, each by compare-and-swap behind the fence.
10. The final record with the receipt is stored.

A refusal in step 4 or 5 is stored as a `refused` receipt, so that key is used up; a new check and confirmation are needed. The lease is released in every case.

| Outcome | `receipt.state` | HTTP |
| --- | --- | --- |
| Written and read back | `succeeded` | 200 |
| The map changed between read and write (compare-and-swap lost) | `failed` (`skipped_changed`, `conflict`) | 200 |
| The put threw, or the read-back did not show the new decision | `unknown` (`storage_error`); read the observation again, nothing is retried | 200 |
| The lease was lost before the write | `aborted` (`fence_lost`); nothing written | 200 |
| A refusal of step 4 or 5 | `refused` with `refusal` | 409 |

The answer is `{replayed: false, receipt, durable, state, index, refusal?}`. `durable: false` means the final action record could not be stored, so the receipt exists only in this answer. `index` is `{refreshed, reason}`. With `refreshed: false` (`fence_lost`, `shard_changed`, `manifest_changed`, `source_unread`, `record_absent`, `error` or an index state), the index stays stale until the next chunk.

**Action record.** `admin/actions/discovery_reconsider/v1/<idempotencyKey>.json`:

```text
{schemaVersion: 1, kind: "discovery_reconsider_action", idempotencyKey, state, issued, createdAt, startedAt, finishedAt,
 provenance: {actor: "owner", authority: "cloudflare_access", programmeRunId, manifestEtag, observationKey},
 beforeImage, afterImage, receipt, index}
```

`state` is `approved`, `running` or a receipt state. The receipt route returns `{idempotencyKey, state, record}`, with `state: unknown` for a `running` record. It answers 404 `not_found` when no record exists and 400 `invalid_request` for a malformed key.

### Identity correction: `POST /api/admin/discovery-recovery/identity-confirm`

`discovery_identity_correct@1` ([ADR 0080](../../adr/0080-discovery-identity-correction.md), Proposed; [capability](admin-actions.md#identity-correction-discovery_identity_correct1)). The owner assigns or rejects one numeric TMDB movie id on the one observation the panel is showing. Confirm writes the action record and no decision. Execute writes that one decision under the resolver lease.

Both POSTs need the same Access assertion, same-origin `Origin` and `Content-Type: application/json` as reconsideration, and `X-IPTV-Admin-Action: discovery_identity_correct`. A reconsideration header on these routes is 403 `access_denied`.

**Confirm.** The body is `{key, pin, idempotencyKey, accepted: true, effect, tmdbId, basis}`. `effect` is `assign` or `reject`. `tmdbId` matches `^[1-9]\d{0,11}$`. `basis` is required, trimmed, at most 200 characters, and has no control characters. The route refuses, with no action record, when the pin is stale, the offer is unavailable, or the command fails (`film_absent`, `year_conflict`, `tmdb_tv`, `not_on_decision`, `already_current`, `ambiguous_needs_stronger`, and the other reasons of `identityCommand`). An assign reads one key of `epg/discovered-films.json`, `tmdb_<id>`, and does not scan titles. A second confirm with the same idempotency key and a different effect or id is 409 `idempotency_conflict`. The answer is `{confirmation, command, plan, application, scope}`. `plan` is `{before, after}` for that key. `application.consumers` is `["resolution_decision"]`.

**Execute.** The body is `{confirmation}`. The order matches reconsideration: replay a stored receipt, then a `running` intent. When that intent's after-image digest matches the stored decision, the route stores the receipt only and does not put the map again. When it does not match, the answer is unknown and nothing is written. Otherwise it refuses a live or unreadable lease before taking one, re-reads the index under the lease, re-checks the stored command (including the catalogue object for an assign), compare-and-swaps a running intent that holds the before-image, puts the resolution map by etag changing only that key, reads the decision back by digest, then refreshes the index. A digest or etag mismatch is `record_changed` and writes no decision. A lost compare-and-swap of the map is `failed` and keeps the other writer's decision. A put whose read-back does not match is `unknown`. The same confirmation then replays that receipt. If the decision read back and the final action-record put fails or loses its compare-and-swap, the answer is HTTP 409 with `decisionReadBack: true`, `durable: false` and `receipt: null`. That is not success. A replay of a stored receipt is `{replayed: true, receipt, durable: true, state}`. Receipt-only recovery accepts only the stored issuance: a different `confirmedAt`, `expiresAt`, scope or effect is `confirmation_mismatch` and does not put the map or a receipt. When that original issuance has expired and the decision already matches, the answer is `confirmation_expired` with `decisionReadBack: true` and `receipt: null`. It does not store a receipt and does not issue another confirmation.

An assign sets `status: verified`, `tmdbId`, `filmId: tmdb_<id>`, `canonicalIdentity: tmdb:<id>`, `identitySource: owner`, clears `terminalReason` and `retryAt`, and drops that id from `rejectedTmdbIds`. A reject sets `needs_verification` when the status was `verified`, otherwise leaves the status, clears `tmdbId` only when it is the rejected id, clears `terminalReason` and `retryAt`, and appends the id to `rejectedTmdbIds` (at most eight). It does not block a similar title. The next ordinary chunk may search for a different id and does not fetch the rejected movie.

The answer adds `application` and `reason` beside the receipt. `application.shows` is `next_ordinary_chunk`, `after_series_wait` or `next_series` when the assigned film is already canonical; `awaiting_catalog_film` when the confirmed id has no catalogue object; `not_this_action` for a reject. The route does not start the chunk and does not write `programme.json` or a historical generation. If `index.refreshed` is false, the list may still show the row until the next chunk.

**Action record.** `admin/actions/discovery_identity_correct/v1/<idempotencyKey>.json`:

```text
{schemaVersion: 1, kind: "discovery_identity_action", idempotencyKey, state, issued, command, application, plan,
 createdAt, startedAt, finishedAt,
 provenance: {actor: "owner", authority: "cloudflare_access", programmeRunId, manifestEtag, observationKey},
 beforeImage, afterImage, receipt, index}
```

`command` is `{effect, tmdbId, basis}`. The receipt route is read-only and returns the same `{idempotencyKey, state, record}` shape as reconsideration.

### The observation recovery panel

«Разобрать наблюдение» on a limbo observation item toggles a panel under the item (`aria-expanded`, `aria-controls`) and issues one GET for that key. In Russian, the panel shows:

- the verdict and what happened;
- what will happen next;
- the sentence «Автоматическое исправление этой проблемы пока недоступно» only when identity review is suggested and the answer has no `identity` object;
- the facts: title, year, durations, the next airings in Europe/Madrid, the programme window, the decision, attempts, last and next attempt, whether the airings changed, the resolver series, the terminal reason, and, when the identity offer is present, the evidence key, the known decision source, the untrusted hypothesis and the coverage limit;
- the snapshot line.

The identifiers (key, pin, digests, etags, the idempotency key, source keys and raw codes) appear only inside the closed «Технические подробности». A verdict, reason, gate, next step, series state or effect without declared copy renders «Невозможно достоверно объяснить состояние наблюдения» with no action. A stale or unavailable index says so, and offers only «Проверить заново».

**Action block «Повторно направить на проверку».**

- **Unavailable.** When the gate is unavailable, the block names the reason in plain words.
- **Preview.** When the gate is available, the block shows the effect, the cost (TMDB requests 0, resolver runs 0, the writes) and the risk: the lease, the compare-and-swap, one extra ordinary attempt, no automatic undo. Then comes a checkbox naming the exact observation («Я хочу снять терминальную отметку только с наблюдения «…» (год)…»).
- **Confirm.** The checkbox only enables «Подтвердить», without redrawing the panel, so focus stays on it. «Подтвердить» sends the confirm POST.
- **Execute.** The panel then shows the issued confirmation with its expiry in Madrid time, «Повторно направить на проверку» (focused) and «Отменить», which drops the confirmation and returns focus to the checkbox. Execution is sent once; whatever comes back, the panel reads the observation again with the held pin. The receipt (focused) stays above the fresh state: written, refused with the reason, aborted, failed or unknown, plus a warning when it was not stored or the index was not refreshed.
- **Retry after a busy resolver.** A `lease_held` or `lease_unknown` refusal keeps the confirmation. «Проверить заново» then keeps it until it expires, so the owner can execute once the resolver is free; the execute button is offered only when the gate is available again.

**Identity block «Идентичность этого наблюдения».** It is a separate section on the same panel, not a `<form>`. «Одно проверенное совпадение» above the inventory opens one key that is not a limbo row: the read uses the verified-observation index, one shard, and does not scan the ledger. When the offer is available it shows the evidence key, the coverage limit (unresolved observations that already have a decision, or current verified decisions; neither is the whole ledger), the current verified movie id when that is what is recorded, the untrusted hypothesis as text, the ids that may be rejected, radios for `assign` and `reject` (reject disabled when nothing may be rejected), a radio only for a confirmed movie id, a numeric movie-id field, a basis field, and a checkbox that names the observation key and the generation. The preview stays hidden until an effect and a real movie id are chosen and states the before and after. «Подтвердить идентичность» then «Записать идентичность» are the two posts. A repeat rejection that is already recorded stays on the form and sends nothing. `already_current` and the other command refusals stay on the form; only `stale_pin` reloads. The identity receipt is separate from the reconsideration receipt. A decision that read back without a stored receipt says the decision is already written, keeps the same confirmation, and labels the button «Сохранить квитанцию». That press stores the receipt and does not write the decision again. A replayed succeeded receipt, including one that omits `durable`, is shown as stored. An expired confirmation of an already written decision says the receipt will not be saved and does not offer that button. Controls are at least 44 px, and below 800 px the buttons in `.recovery-controls` are full width.

Below 800 px the controls are full width. The page sends no token: the Access session is the only credential.

## Poster coverage

`GET /api/admin/posters` is the read behind the owner page `/admin/posters`: how many catalog records lack a poster, how many can be requested now, how many TMDB has already refused, which ones have no verified id, and the next bounded batch of the actionable queue. It is read-only and behind the same Access application. The only write the page can cause is an owner-confirmed call of the existing maintenance route `POST /api/enrichment/catalog/posters` ([catalog reference](catalog.md#poster-hydration), [ADR 0048](../../adr/0048-permanent-catalog-poster-maintenance-route.md)); this route never calls it. Source: [`src/admin/posters.js`](../../../src/admin/posters.js) (handler), [`src/admin/posters-client.js`](../../../src/admin/posters-client.js), [`src/admin/posters-run.js`](../../../src/admin/posters-run.js) and [`public/admin-posters.js`](../../../public/admin-posters.js) (the page). Tests: [`tests/admin-posters-api.mjs`](../../../tests/admin-posters-api.mjs), [`tests/admin-posters-run.mjs`](../../../tests/admin-posters-run.mjs), [`tests/admin-posters-page.mjs`](../../../tests/admin-posters-page.mjs); the [GET side-effect test](../../../tests/get-side-effects.mjs) pins its read set.

### What is read

Four objects, in order: `epg/published-generation.json`, the live catalog `epg/discovered-films.json`, the published generation's copy `epg/generations/<programmeRunId>/discovered-films.json` (only when the pointer is `published`), and the negative index `epg/catalog-poster-negatives.json` (always, including when no generation is published). The catalog copies are counted with the maintenance route's rule (`catalogPosterMissing`): a record counts once, as missing when either copy lacks an `https://` poster, and as verified (`verifiedMissing`) when its numeric `tmdbId` is also its `canonicalIdentity`. The index then splits those verified records into `actionable`, `noPosterHeld` and `identityReview` by the same rule as the maintenance route. An absent index is an empty one and the read stays complete. No snapshot pin, no programme, no `BUCKET.list`, no resolver lease, no ledger, no TMDB request and no write; the read never creates, rewrites or repairs any of these objects.

**Complete or unknown.** The counts are reported only when every object that was required was read and is trusted: the pointer is a JSON object with `phase: "published"` and a `programmeRunId`, both catalog copies exist and parse to a JSON object, and the negative index is either absent or this schema. Otherwise the answer is `evidence: {complete: false, problems}` and nothing is counted as zero: every count, including `actionable`, `noPosterHeld` and `identityReview`, plus `withPoster`, `queue.remainingAfterCursor`, `queue.total` and `unverified.count` are `null`, `queue.items` and both `held` samples are empty, and `health.issue` is the data health `incomplete` / `progress_unknown` issue with the action `supply_evidence`. `problems` lists, in this order, at most one pointer problem (`pointer_missing`, `pointer_unreadable`, `generation_not_published`), at most one generation copy problem (`generation_copy_missing`, `generation_copy_unreadable`; the copy is not read without a published generation), at most one live copy problem (`live_copy_missing`, `live_copy_unreadable`), and `negatives_unreadable` when the index object is present but is not the schema. A present unreadable index is unknown, not an empty queue. `copies[]` still describes every copy that was read. A storage call that fails, as opposed to an object that is absent or does not parse, is 503 `storage_unavailable`.

### Parameters

| Parameter | Rule |
| --- | --- |
| `limit` | Size of the batch shown, digits `1`–`10`, default `10`; otherwise 400 `invalid_limit`. Ten is the page's batch cap, below the route's own limit of 20 |
| `cursor` | The position in the queue, as the maintenance route uses it: records whose id sorts after it (`localeCompare`, `en`). Empty or absent is the start; longer than 200 characters is 400 `invalid_cursor` |

Parameters are validated before any read. Any other method is 405 `method_not_allowed`.

### Answer

`{schemaVersion, observedAt, programmeRunId, catalogRecords, withPoster, missingPoster, verifiedMissing, unverifiedMissing, actionable, noPosterHeld, identityReview, publishedAt, evidence, copies, queue, held, unverified, health, limits, reads}`.

- `evidence`: `{complete, problems}` as above. Only a `complete: true` answer carries counts and a batch.
- The counts are the maintenance route's dry-run counts of the same objects.
- `copies[]`: `{key, role: generation|live, present, readable, version, records, missingPoster, verifiedMissing}` per copy; `records`, `missingPoster` and `verifiedMissing` are `null` for a copy that is absent or unreadable.
- `actionable`, `noPosterHeld` and `identityReview` are the maintenance route's partition of `verifiedMissing`. `actionable` is what the ordinary queue will request. `noPosterHeld` waits until `nextCheckAt`. `identityReview` is never requested by an ordinary call.
- `queue`: `{cursor, limit, items, remainingAfterCursor, total}`. `items` are the next `limit` actionable records after `cursor` — `{id, tmdbId, title, original, year}` with titles cut to 200 characters — which are exactly the records a `POST {dryRun: false, limit, cursor}` would process next. `total` is the actionable length, not `verifiedMissing`.
- `held`: `{noPoster, identityReview}`, each `{count, sample}`. A sample is at most ten records in id order, each an item plus `checkedAt` and `nextCheckAt` (`null` for an identity mismatch). There is no paging or search: the page can recheck only an id that appears in that sample, while `count` is the full number.
- `unverified`: `{count, sample}`, up to ten records without a poster that the route will not touch, each with `reason` `tmdb_id_missing` (no numeric TMDB id) or `identity_not_tmdb` (the id is not the record's canonical identity).
- `health`: the [data health](../domain/data-health.md#rules-by-subsystem) catalog poster summary issue of these counts (`id`, `severity`, `reason`, `category`, `action`, `evidence`, `threshold`) or `null` when no poster is missing, and the `posterBacklogCount` in force.
- `limits`: `{batch: 10, route: 20}`; `reads`: the keys read.

### The page

`/admin/posters` is the last section of the admin navigation. It shows the coverage (records, with a poster, without one, actionable now, no poster on TMDB until a date, a TMDB identity to review, and without a verified id) with the per-copy figures in a closed «Технические подробности»; a warning when the verified-missing backlog reaches `posterBacklogCount`, which does not mean every one of those records can be filled; the remembered answers, each with its TMDB link, date and a separate recheck; the records without a verified TMDB id; when the read is incomplete, «Покрытие неизвестно: данные неполные» with each problem and each copy's state in plain Russian, every figure as «неизвестно», no preview batch and no confirmation; and the browser's own history: the last successful restoration, recent coverage readings and runs. The server keeps no run journal. That history lives only in this browser's `localStorage` (`iptv.admin.posters.v1`), is labelled as such, and can be forgotten. It does not decide the queue: the index does, and old browser verdicts are not imported.

A manual run follows the guarded-action principles of [admin actions](admin-actions.md#the-poster-page):

1. **Preview.** The owner picks the batch size (1–10, default 10), the call budget (1–30, default 1) and the start (the position saved by the last run for the same generation, or the start of the queue). The preview is one GET: the first batch by title and TMDB id, how many records follow, and the most this run can touch. It writes nothing and calls no TMDB. An answer without `evidence.complete: true` and a published generation is the `incomplete` preview, which cannot be confirmed; an incomplete reading is not stored in the browser history. Film names in the first batch here and in the receipt link to `https://www.themoviedb.org/movie/<tmdbId>` (new tab, `rel="noopener noreferrer"`), built by `posterTmdbUrl` only from a numeric id; the queue and the outcomes contain only records whose numeric `tmdbId` is their canonical identity, so a link always points at the verified film, and `tmdb_id_mismatch` links to the stored id for checking. The list of records without a verified TMDB id stays plain text. No TMDB request is made for a link, and titles are escaped.
2. **Confirmation.** A checkbox restates the exact scope (calls, batch size, maximum records, start, generation). It is valid for ten minutes and one run, and is dropped by any change of the options or a re-check. It guards against an accidental click; authorization is still Cloudflare Access.
3. **Fresh check.** Immediately before the first call the page re-reads the queue with the confirmed cursor and limit. Incomplete evidence, a different generation, a different first batch, nothing left to restore or a rate-limit gate refuses the run with nothing sent.
4. **Bounded execution.** One `POST /api/enrichment/catalog/posters` with `{dryRun: false, limit, expectedProgrammeRunId}` and the route's `nextCursor` per call, never in parallel and never above ten records. `expectedProgrammeRunId` is the confirmed generation on every call, the first included, so the route refuses a call once another generation is published, before any TMDB request and any write ([generation fence](catalog.md#poster-hydration)). The run stops at the first of: `done`; the confirmed call budget; five consecutive calls with no new poster and an unchanged cursor; `retryAt` (TMDB rate limit, kept as a gate for the next preview); a generation change, refused by the route's fence (409 `generationChanged`), reported in its outcomes or seen in its answer; the resolver lease held by discovery (409); a lost lease (409, with the copies already written); TMDB not configured (503); a rejected request (400); an answer the page cannot read or an outcome code it has no sentence for. "Остановить после текущего пакета" stops between calls; a call in flight always completes and is recorded.
5. **Receipt.** Every record is named by the `title` and `year` the route returns with its outcome, in every batch, falling back to the preview's title and then to the record id. The stop reason in plain Russian, the totals (written, already present, no poster on TMDB, TMDB answered for another film, retryable), a partial-write warning when one copy was written without the other, the latest outcome of every record, and per call the HTTP status, cursors and writes per copy in «Технические подробности». A negative outcome with `negativeSaved: false` says the verdict was not stored. The page then re-reads the coverage and shows before → after for the missing count and the actionable count. `done` means the actionable queue was walked; remembered refusals are not in it.
6. **Recheck.** The remembered-answer list offers one id at a time, and only from the sample of at most ten per group. An id outside that sample is not offered; there is no paging or search. Its confirmation is separate from the sweep: one `POST` with `{dryRun: false, limit: 1, expectedProgrammeRunId, recheck: ["<tmdbId>"]}` and no cursor, after a fresh read still contains that id in the sample. It does not move the sweep's saved position. An unreadable index stops the sweep the same way as any other answer the page cannot treat as a batch (`503` `Poster negatives unreadable`).

## Letterboxd archive preview: `POST /api/admin/letterboxd-archive/preview`

The read behind `/admin/letterboxd`: the owner sends the Letterboxd account export ZIP and gets back what it contains and what an import of it would do to the stored facts now. It **writes nothing**: the archive, its rows and the answer exist only in the request and its `no-store` response; nothing is put to R2, D1, KV or a cache, nothing is logged, `waitUntil` is not used and no outbound request is made, not even to a URL in the archive ([ADR 0066](../../adr/0066-ephemeral-letterboxd-archive-preview.md)). This route has no apply mode. A later, separate confirmation can record one compared chunk ([confirmed apply](#letterboxd-archive-apply)). The CLI import stays the [baseline route](../../runbooks/letterboxd-baseline-import.md). Source: [`src/admin/letterboxd-archive.js`](../../../src/admin/letterboxd-archive.js) (handler), [`src/domain/letterboxd-archive-zip.js`](../../../src/domain/letterboxd-archive-zip.js) (ZIP reader, `LetterboxdArchiveZip`), [`src/domain/letterboxd-archive-preview.js`](../../../src/domain/letterboxd-archive-preview.js) (answer, `LetterboxdArchivePreview`), the bundled offline [parser and matcher](../integrations/letterboxd-export.md), [`src/admin/letterboxd-archive-client.js`](../../../src/admin/letterboxd-archive-client.js), [`src/admin/letterboxd-archive-view.js`](../../../src/admin/letterboxd-archive-view.js) and [`public/admin-letterboxd.js`](../../../public/admin-letterboxd.js) (the page). Tests: [`tests/letterboxd-archive-zip.mjs`](../../../tests/letterboxd-archive-zip.mjs), [`tests/letterboxd-archive-preview.mjs`](../../../tests/letterboxd-archive-preview.mjs), [`tests/admin-letterboxd-archive-api.mjs`](../../../tests/admin-letterboxd-archive-api.mjs), [`tests/admin-letterboxd-page.mjs`](../../../tests/admin-letterboxd-page.mjs); the real-runtime probe is [`scripts/letterboxd-archive-probe.mjs`](../../../scripts/letterboxd-archive-probe.mjs).

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
| 404 | `not_found` | a path under `/api/admin/letterboxd-archive/` other than preview and the four [apply routes](#letterboxd-archive-apply). `POST …/commit` is one of those 404s |
| 405 | `method_not_allowed` | not a POST |
| 403 | `origin_not_allowed` | `Origin` missing or not the Worker's own |
| 415 | `unsupported_media_type` | not `multipart/form-data` with a boundary |
| 411 | `length_required` | no numeric `Content-Length` |
| 413 | `archive_too_large` | the declared or read body, or the file, is above the cap |
| 429 | `preview_busy` | another preview or apply holds this isolate's slot (below) |
| 400 | `invalid_form` | unreadable form, a missing, repeated or extra field, or an unusable file name |
| 422 | `generated_at_required`, `generated_at_conflict`, `generated_at_invalid`, `generated_at_future`, `generated_at_too_old` | a renamed archive without a time; a standard name with one; not the UTC form; later than now; before 2011 |
| 422 | `archive_invalid` with `code` and `file` | the ZIP reader refused: `not_zip`, `archive_too_large`, `zip64_unsupported`, `multi_disk_unsupported`, `too_many_entries`, `central_directory_invalid`, `entry_name_invalid`, `duplicate_entry`, `encrypted_entry`, `unsupported_method`, `local_header_invalid`, `entry_truncated`, `entry_overlap`, `entry_too_large`, `total_too_large`, `ratio_exceeded`, `entry_size_mismatch`, `inflate_failed`, `checksum_failed`, `invalid_utf8`, `too_many_rows`, `time_budget`, `aborted` |
| 422 | `csv_invalid` with `file` and `record` | a CSV file the parser cannot read |
| 422 | `missing_watched` | the archive has no `watched.csv` |
| 500 | `preview_failed` | anything else; no detail is returned |

**One archive request per isolate.** A worst-case preview needs about half of the isolate's 128 MB, so the handler holds one slot per isolate and answers 429 to a second concurrent preview or apply on the same isolate. The slot is the start time of the running request and is taken over after 60 s, because a request the runtime cancels never reaches its `finally`. Length and content type are checked before the slot is taken.

### What is read

Through a bucket wrapper that exposes only `get`; no key is listed:

| Read | Use |
| --- | --- |
| The admin snapshot (six reads above) | The published programme for the matcher; failure leaves matching `partial` |
| `metadata.json` | Catalog metadata for the matcher |
| `enrichment/ratings/published.json`, then its generation when `projected: true` | The ratings the matcher uses as evidence |
| `letterboxd/facts/links.json` | The link index: which films already have a fact record and under which key |
| `letterboxd/facts/scans/films-list.json`, `letterboxd/facts/scans/watchlist.json` | The scan summaries, the floor of every observation ([ADR 0024](../../adr/0024-letterboxd-scan-summary.md)) |
| `letterboxd/imports/<sha256>/chunks/0.intent.json`, `0.receipt.json` | Whether **this** archive was already imported (`committed`, `opened`, `absent`) |
| `letterboxd/facts/films/<key>.json` | Only for accepted films whose alias is in the link index. At most 300 fact-record GETs, six at a time; one redirect hop counts toward that cap. A film whose hop does not fit is `unverified` with `record_read_limit` and is not compared from the stub. A record that is migrating, a second redirect or a failed read makes the film `unverified` |
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
  freshness: {needsFreshArchive, verdict: needs_fresh|inconclusive|verified, reasons: [archive_stale, ratings_newer_in_r2, ratings_unconfirmed], archiveStaleMs, ageMs, ratingsNewerInR2},
  matching: {status, sources: {<source>: {evidence, key, ...}}, omitted, index, byStatus, acceptedByMethod: {lid_exact, tmdb_verified, title_year}, reasons, lidHypothesis},
  proposal: {status, reasons, films: {accepted, compared, unverified, aliasConflict, invalidIdentity, heldForIdentity}, facts: {new, replaces, unchanged, older, tie, unverified}, byFact: {watched|rating|watchlist: {...}}, values: {newValues, changedValues, sameValueUpdates, unchanged, older, unverified, byFact: {watched|rating|watchlist: {...}}}, recordReads: {limit, needed, done}},
  consistency: {status: stable|drift, changed: [key, ...]},
  details: {limit: 25, adds, updates, sameValue, heldNewer, unverified, conflicts, identity, invalidRows},   // each {total, rows ≤ 25}
  reads: [key, ...],
  batches: {size: 50, programmeRunId, confirmable, reason, chunks: [{chunk, films, planHash, scopeFingerprint, changes: {new, replaces, unchanged, older, tie}, values: {same shape as proposal.values, this chunk}, confirmable, reason, receipt: {status, committedAt}}]}
}
```

- **Outcomes** are the baseline commit's, computed on a copy of each record with the same observation ids and summary floors: `new` (no value yet), `replaces` (the export's observation is greater), `unchanged`, `older` (a stored or scanned observation is newer and wins), `tie` (counted beside the outcome when the observation equals the stored one), `unverified` (the record was not read).
- **Held** films are not proposed: `heldNewer` (R2 is newer for some fact), `unverified` (`record_read_limit`, `record_unavailable`, `record_converging`, `links_unavailable`), `conflicts` (`alias_conflict`: the Letterboxd and TMDB aliases point to two records; `invalid_identity`), and `identity` (every film the matcher did not accept, with its status, method, reason and number of candidates). Only `accepted` films are compared, as in the import.
- **Rows** carry the film's export code, name, year, match status and method, the proposed facts, the outcome per fact, `valueKind` per fact and the current value where one exists. They are capped at 25 per list; `total` is the full count. They are personal data and appear only in this response. `details.adds` lists films with a `new` value, `details.updates` films with a changed value, and `details.sameValue` films whose `replaces` keeps the stored value. A film can appear in more than one list.
- **`proposal.values`** counts facts of films in state `compared`, not films. `newValues` is outcome `new`. `changedValues` is `replaces` whose stored value differs, or `replaces` with no stored value to compare. `sameValueUpdates` is `replaces` whose stored value is equal, including a null rating (`JSON` equality). `unchanged` is the identical observation, not "the value happened to match". `byFact` repeats the same counts for `watched`, `rating` and `watchlist`. These counts do not change `facts`, the plan hash or what a commit writes: a same-value replace is still `replaces`. Each batch's `values` is the same projection of that chunk, and the chunks sum to `proposal.values`. The page states value changes and same-value observation updates separately. That sentence counts facts among the films that were compared, not the whole export. The tile «не проверено (фильмов)» is the film count in `details.unverified`, including films the read limit left unread. It is not `values.unverified`, which counts facts only for films in state `compared` and therefore leaves those unread films out.
- `baseline` is always `unknown`: the import stores receipts per archive and no summary, so the latest confirmed baseline cannot be found without listing the bucket. `freshness.needsFreshArchive` is true only when `verdict` is `needs_fresh`. That is a proven reason: `archive_stale` when the export is older than the data health `archiveStaleMs` (60 days), or `ratings_newer_in_r2` when at least one compared film has a newer rating in R2 (`ratingsNewerInR2` is that count, and it is omitted when R2 was not read). `ratings_unconfirmed` is added when `ratings.csv` is missing, or when matching or the proposal is not complete: an unavailable programme or metadata, an unavailable ratings generation, link index or scan summary, an unread linked record, or ETag drift. With no proven reason that verdict is `inconclusive`. `verified` means the ratings file was present, the match and the proposal were complete, and the checked films showed no newer rating; it does not certify ratings outside that comparison. A missing object (`object_missing`) is evidence of absence and does not by itself make freshness inconclusive. `needsFreshArchive` is never set from an unknown. A `verified` verdict is not permission to write.
- **`batches`** splits the films this preview compared into chunks of 50, in the preview's order. A film that is unverified, conflicting, invalid or unmatched is in none of them. `planHash` is the SHA-256 of the baseline items of that chunk, the same digest a commit stores as `itemsHash`. `scopeFingerprint` is the guarded-action fingerprint of those films' versions. A film's version covers the planned facts and the current value, time and source, so a newer stored fact changes it. `programmeRunId` is the published programme run id when that read was observed and the id matches the pin shape. Otherwise it is null and no chunk is confirmable. Drift (`consistency.status` other than `stable`) also leaves every chunk unconfirmable. Chunk 0 copies the comparison's receipt status. Later chunks say `not_read` and do not add a GET. `batches` is hashes and counts only. The preview still writes nothing.

### The page

`/admin/letterboxd` («Архив Letterboxd») sits between data health and limbo in the admin navigation. Opening it sends nothing. The form takes the ZIP and, for a renamed archive, the export time. The static page has three controls: «Проверить архив», «Отменить» and «Очистить». The page checks the name, the size and the time locally, then sends one preview `POST` with `credentials: 'same-origin'` and `cache: 'no-store'` and accepts only an answer with `mode: "preview"` and `writes: false`. States: idle, loading (with «Отменить», also on Escape, which aborts the request), error (focused, the code's Russian text), result (focused): three separate notices when they apply — the ZIP read («Архив успешно прочитан», the positive callout, only when every CSV is present, there is no invalid row, no CSV conflict and no cross-file mismatch; otherwise the same notice is a warning and does not say «ошибок нет»; the export age includes «создан менее часа назад»), the coverage notice «Сравнение с R2 частичное» when the verdict is `inconclusive` or `ratings_unconfirmed` is set (it says a new ZIP is not required for that gap alone), and «Нужен свежий архив» only for a proven `archive_stale` or `ratings_newer_in_r2` reason — then the value totals (new values, changed values, same-value observation updates, identical observations, newer in R2) and the film tile «не проверено (фильмов)», the archive's files and SHA-256, the baseline as «неизвестно» with the reason, the matching by method and status, the proposal by fact and outcome, and the detail lists in closed `<details>`. Times are shown in Europe/Madrid. «Очистить» drops the answer and returns focus to the file field. Leaving the page drops it too, including any confirmation the tab was holding. Nothing is put in `localStorage` or the URL.

After a confirmable chunk, the result (not the form) offers «Подтвердить партию N». That click uploads the ZIP again and does not record facts. Only after it returns does «Записать партию N» appear, and that second click is the commit. A chunk whose import receipt is already `committed` offers the two rollback clicks instead. The page reads the file from the input again at each click, so a replaced file is what is sent. Idempotency keys are random, live only in the tab, and are dropped on «Очистить» and on `pagehide`. A failed apply leaves the preview on screen. The commit sentence follows the receipt, not the HTTP status: `succeeded` with writes is «записана полностью», `succeeded` with nothing newly written is «уже была записана», `partial` is «записана частично», and `failed` is either «не записана» or «факты не изменились» when every film was skipped. Each sentence includes the non-zero counts (`записано`, `уже было`, `пропущено`, `ошибки`). The page sends `X-IPTV-Admin-Action: letterboxd_archive_apply` on those four calls and never a Cloudflare Access client id or secret. Preview does not call them.

## Letterboxd archive apply

Four POST routes behind the same Access application as the preview ([ADR 0068](../../adr/0068-letterboxd-archive-confirmed-apply.md)). Source: [`src/admin/letterboxd-archive-apply.js`](../../../src/admin/letterboxd-archive-apply.js), [`src/domain/letterboxd-archive-apply.js`](../../../src/domain/letterboxd-archive-apply.js). Tests: [`tests/admin-letterboxd-apply.mjs`](../../../tests/admin-letterboxd-apply.mjs). They do not consult `LETTERBOXD_FACTS` or `LETTERBOXD_BASELINE_IMPORT`. Fact writes go through `commitBaselineChunk` and `rollbackBaselineChunk` only. The ZIP is never stored.

### Principal, before the body

In order: method (GET is 405), then the principal, then a bucket that can `get` and `put`. The principal is an owner only when `Cf-Access-Jwt-Assertion` is present and at most 8192 characters, `Origin` equals the Worker origin, and `X-IPTV-Admin-Action` is `letterboxd_archive_apply`. The Worker does not check the JWT signature. Access does. A missing `BUCKET` binding is still the Worker's `{error: "Storage unavailable"}`, before this route. A bucket without `put` is 503 `{error: "storage_unavailable"}` and is not read.

| Path | Body | Writes |
| --- | --- | --- |
| `/api/admin/letterboxd-archive/apply-confirm` | multipart: `archive`, optional `generatedAt`, `chunk`, `planHash`, `programmeRunId`, `scopeFingerprint`, `idempotencyKey`, `accepted=true` | the issued confirmation only |
| `/api/admin/letterboxd-archive/apply` | multipart: `archive`, optional `generatedAt`, `confirmation` (the issued JSON) | one baseline chunk, then the action receipt |
| `/api/admin/letterboxd-archive/rollback-confirm` | JSON: `archiveSha256`, `chunk`, `idempotencyKey`, `accepted: true` | the issued rollback confirmation only |
| `/api/admin/letterboxd-archive/rollback` | JSON: `confirmation` | one baseline rollback, then the action receipt |

Multipart limits and ZIP errors are the preview's, checked before the shared isolate slot. A second archive request on the isolate is 429 `preview_busy`.

### What confirm checks

The ZIP is parsed again. The chunk must be an integer 0–10000, the plan hash 64 hex characters, the programme run id and the idempotency key the guarded-action shapes, the fingerprint 8 hex characters, and `accepted` the string `true`. The comparison must still be stable. The programme pin must equal `programmeRunId`. The chunk's plan hash and scope fingerprint must equal the fresh comparison. Anything else refuses before an action record is stored: `invalid_request` (400), `record_changed` (409), `stale_pin` (409), `not_eligible` (409).

A passing confirm calls `confirmAction` and puts `admin/actions/letterboxd_archive_apply/v1/<idempotencyKey>.json` only when that key is absent. The record holds the schema version, kind, key, state `approved`, the issued confirmation, times, archive SHA-256, export time and its source, chunk, plan hash, programme run id, and null receipt and baseline. It does not hold the ZIP, CSV text, film names, rating values or a token. Letterboxd ids are the record ids inside the issued scope. The answer is `{mode: "apply_confirm", writes: false, confirmation, batch}`. The same key and the same scope (capability, version, subject, pin, scope key, fingerprint, ids and idempotency key) return the stored confirmation and write nothing. `confirmedAt` and `expiresAt` stay as first issued; a later clock does not extend them. A different scope is 409 `idempotency_conflict`.

### What commit checks, then writes

The submitted confirmation must parse as `letterboxd_archive_apply` version 1. The stored record's archive hash, export time and source must match this ZIP, and the subject id must be `<sha256>:<chunk>`. A stored action receipt returns `{mode: "apply", writes: false, replayed: true}` and does not call the commit. Otherwise the comparison runs again. `checkSubmission` uses the same principal. `confirmation_expired` and `invalid_request` are 400. Other refusals are 409.

The action is then marked `running` by compare-and-swap. A lost race is 409 `in_progress`. `commitBaselineChunk` then runs with this ZIP's origin and the chunk's items. A baseline intent or receipt whose `itemsHash` is not this plan is 409 `idempotency_conflict` and writes no fact. A `chunk_conflict` is the same refusal. Any other commit failure is 500 `{error: "storage_error"}` and leaves the action `running`, so the same confirmation can be sent again and the baseline intent finishes. A `running` record without an action receipt is retried on purpose. If its baseline intent or receipt already has this plan's hash, `checkSubmission` uses the issued record versions, so the intent's own fact writes are not `record_changed`. The baseline commit still keeps a newer observation. A `running` record that has not opened an intent yet is checked against the fresh versions. That differs from discovery reconsideration, which does not retry one.

Outcomes, per film, including a replay of a baseline receipt stored before the action receipt: a fact conflict is `failed` with `conflict`; an `older` fact and nothing written is `skipped_changed`; any `new` or `replaces` is `written` on the first commit and `already_applied` on that replay. A replay does not turn a partial or failed import into `succeeded`. The action receipt is `receiptOf`. The answer's `baseline` is `{chunk, replay, conflicts, outcomes}` counts only. The import's view before-image is not copied into the action record and is not returned. A `ratings.csv` row is written as watched and rated even when `diary.csv` has no row for that film. Absence is not `watched: false`. A newer stored fact stays.

### Rollback

Confirm reads `letterboxd/imports/<sha256>/chunks/<n>.receipt.json`. A missing or unusable receipt is 409 `not_eligible` (503 `invalid_request` when the read itself fails). The pin and the record version are that receipt's `itemsHash`. The capability is `letterboxd_archive_rollback` version 1, one record id `chunk`, subject `<sha256>:rollback:<chunk>`. Execute calls `rollbackBaselineChunk` with the origin stored on that receipt, not a client field. A later observation is `skipped_changed` (`superseded`) and kept. A second rollback of the same confirmation replays.

### Action record

Apply records live at `admin/actions/letterboxd_archive_apply/v1/<key>.json`. Rollback records live at `admin/actions/letterboxd_archive_rollback/v1/<key>.json`. Neither object is the import receipt. The import receipt under `letterboxd/imports/` is unchanged, including the view before-image the rollback already uses.

## Film title review: `POST /api/admin/films/<storedId>/title-review`

One confirmed preferred Russian title for one Film already in the published programme. `<storedId>` is the programme id, not the record id `film:<storedId>`. The transition is [`applyTitleReview`](../domain/film-title-review.md). The route persists a changed result and does nothing else. Source: [`src/admin/film-title-route.js`](../../../src/admin/film-title-route.js), [`src/admin/owner-reviews.js`](../../../src/admin/owner-reviews.js), [`src/admin/film-title-client.js`](../../../src/admin/film-title-client.js). Tests: [`tests/admin-film-title-api.mjs`](../../../tests/admin-film-title-api.mjs).

The request is JSON, at most 8192 bytes, `Content-Type: application/json`. The command is `{filmId, requestId, mode, value, expectedVersion, basis?, effect?}`. `filmId` is the record id. `mode` is `alias` or `manual`. `effect`, when present, is `promote` or `add_alias`. Absent `effect` is a promote. Identity fields are refused.

The caller is the owner session already admitted by Cloudflare Access. The route also requires `Origin` equal to the page origin, `X-IPTV-Admin-Action: film_title_review`, and a non-empty `Cf-Access-Jwt-Assertion` of at most 8192 characters. It checks that the assertion is present. It does not verify the JWT. A mismatched `Origin` is rejected by the Worker before this route, as for every other POST. A missing principal is 403 `forbidden`, and nothing is written.

While the owner-review marker is absent or `r2`, the write is one conditional put of `admin/owner-reviews.json`. The screen compare-and-set is `expectedVersion`. The storage compare-and-set is the object etag (`onlyIf.etagMatches`, or `etagDoesNotMatch: '*'` when the object is absent). When `owner_review_authority.mode` is `d1`, the storage compare-and-set is `d1:<generation>` for both maps in one batch, and the object is mirrored afterwards. An uncertain read-back is 503 `storage_unavailable` with `reason` `readback_failed` or `commit_unknown`. The form is unchanged. The film slice replaces `films[<storedId>]`. The `people` map is copied unchanged. There is no unconditional put. A lost etag reloads the snapshot once. If the domain token then mismatches, the answer is 409 `version_conflict`. A second lost put is the same 409. After a put the route reads the object back. The stored audit entry must contain the `requestId` and the new domain token. An `alias_added` entry must also have that alias in the stored slice. Otherwise the answer is 503 `storage_unavailable` with reason `readback_failed`. That answer is not success and it is not proof the put failed: the conditional put may already have committed. The page reloads the card and applies the proof in the page section above. An option-list entry is not the stored alias. It keeps the original command (`filmId`, `requestId`, `mode`, `value`, `basis`, `effect` and `expectedVersion`) until that proof is present. A later edit of a field, or a confirmed refusal, discards the command. A replay then returns the stored review without a second audit, or applies the review once if the put did not land. A different `effect` under the same `requestId` is `request_id_reused`. The admin snapshot cache is dropped after the put. An alias-only slice stores `localization: null`.

A replay of the same `requestId` and the same payload, including the same `effect`, is 200 `{ok: true, changed: false, idempotent: true, version, readback: true, titleReview}` and does not put, including when `expectedVersion` is stale or absent. A different payload under that `requestId` is 409 `request_id_reused`. An already reviewed title of the same text is 200 with `changed: false` and does not put; selecting the dictionary title unchanged does not mint owner authority. An `add_alias` whose text is already on the film is 200 with `changed: false` and `reason: "duplicate_alias"` and does not put.

Success is 200 `{ok: true, changed: true, idempotent: false, version, readback: true, titleReview}`.

| Status | `reason` | When |
| --- | --- | --- |
| 400 | `invalid_command`, `invalid_mode`, `invalid_effect`, `invalid_title`, `invalid_basis`, `missing_request_id`, `identity_change_forbidden`, `unknown_alias`, `rejected_identity` | the command shape, from the domain contract |
| 403 | `forbidden` | origin, action header or access assertion missing or wrong |
| 404 | `missing_film`, `film_mismatch` | no such stored id, or `filmId` is not that film |
| 409 | `version_conflict`, `request_id_reused`, `illegal_transition` | stale screen, reused request id, or a transition the domain refuses |
| 503 | `storage_unavailable` | the binding threw, the overlay body is unreadable (`overlay_invalid`), or readback failed (`readback_failed`). `readback_failed` means the commit outcome is unknown |

The route does not write `programme.json`, `titles.json`, `people.json`, `epg/published-generation.json`, or a generation object. It writes D1 only for the owner-review rows, and only when that marker is `d1`. GET does not enter it. Deploying the Worker does not create the object. Programme and watchlist reads load the same key and stamp a reviewed owner title before the dictionary and before `titles.json`. An alias stored without an owner localization is appended and does not replace that title. The next EPG publication leaves the object where it is.

## Limits

- The catalogue is the pinned generation's programme: watchlist films and the people on them. Catalog-only films (`epg/discovered-films.json`), unresolved observations and the resolution ledger are not searched; identity codes that need the ledger (`ambiguous`, `rejected`) are not produced here.
- The catalogue routes do not read fingerprint and prediction state; see `queue_unavailable` above. Only the [prediction recovery read](#prediction-recovery-get-apiadminprediction-recovery) reads them, for one film per request.
- Pages run over an in-memory projection of the whole programme object; a cold request costs six R2 reads and one parse of the programme, a warm one six reads and no parse of the programme.
- The catalogue GET routes edit nothing. `POST /api/admin/films/<storedId>/title-review` is the [film title review](#film-title-review-post-apiadminfilmsstoredidtitle-review): one confirmed title, one conditional put of the overlay. `POST /api/admin/letterboxd-archive/preview` is the [archive preview](#letterboxd-archive-preview-post-apiadminletterboxd-archivepreview): it accepts a body and writes nothing. The [archive apply](#letterboxd-archive-apply) is four other POSTs and writes only after a separate confirmation. The health read suggests actions as the model states them and offers no way to run one; the poster summary links to `/admin/posters`.
- Three admin pages can cause a write, each only after the owner's confirmation. `/admin/posters` calls the existing `POST /api/enrichment/catalog/posters`; `/admin/limbo` calls the reconsideration and identity-correction posts of one observation; `/admin/letterboxd` calls the archive apply routes for one compared chunk.
- On `/admin/posters`: `no_poster_on_tmdb` and `tmdb_id_mismatch` are stored in `epg/catalog-poster-negatives.json` by the maintenance route ([ADR 0063](../../adr/0063-catalog-poster-negative-index.md)). They stay inside `verifiedMissing`, which is what the poster summary warns on, and they leave the ordinary queue. The browser history does not decide that queue. A code revert leaves the index in place; older code then shows those records as actionable again.

Rollback of the read routes and the archive preview removes no R2 object, because they wrote none. Decisions reconsidered or identity-corrected by confirmed actions stay that way, and their action records stay ([runbook](../../runbooks/discovery-ledger.md#one-stuck-observation)). Posters written by confirmed runs stay, as described in the [poster runbook](../../runbooks/catalog-poster-hydration.md#rollback). Facts written by a confirmed archive apply stay until that chunk's own rollback. A code revert does not remove them.
