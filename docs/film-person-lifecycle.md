# Film and Person lifecycle: legacy audit

Phase 0 of [AIR-42](https://trello.com/c/drLBuWjl) mapped the records that exist today. Phase 1 implements that decision table in `src/domain/film-person.js`. The module is pure: `build.mjs` does not bundle it, and the Worker, discovery, enrichment, and MCP processors do not call it. Readers, writers, R2, Scheduled Tasks, and the MCP contract are unchanged.

The domain model has to be built from these objects. A Letterboxd id, a TMDB id, a title, and a current broadcast are different facts. Availability is computed from EPG show times. An EPG discovery candidate is not a Film.

## Record inventory

Authoritative means a later phase must not invent a replacement id or drop the payload. Cache means the value can be rebuilt, but a reviewed value that was copied into it must survive. Projection means the object is derived at read or write time and is not a second entity.

| R2 key or source | Role | Identity it uses | What it is |
| --- | --- | --- | --- |
| `metadata.json` | Authoritative watchlist metadata cache | Letterboxd `lid` | One object per watchlist film after `parseFilm` |
| `watchlist.json` | Snapshot of the latest watchlist commit | Letterboxd `lid` | Films without `shows`. Written from the in-memory watchlist after title and name localization |
| `programme.json` | Authoritative schedule snapshot | Letterboxd `lid` on `films[]`; embedded people | Watchlist films merged with matched shows. `people` is a unique list of those embedded people |
| `titles.json` | Cache of automatic Russian titles | Letterboxd `lid` | Wikidata label when exactly one Russian label exists. Status stored here is `provisional` |
| `people.json` | Cache of automatic Russian names | `actor/<slug>` or `director/<slug>` | `{name, original}` after Wikidata. Reviewed names are also copied here |
| `data/film-titles.json` | Authoritative reviewed titles, compiled into the Worker | Letterboxd `lid` plus `tmdbId` | 413 records, every `status` is `verified` |
| `data/person-names.json` | Authoritative reviewed names, compiled into the Worker | `actor/<slug>` or `director/<slug>` | 868 records: 864 `verified`, 4 `provisional` |
| `src/sources.js` `REVIEWED_PEOPLE['actor/chris-pratt']` | Authoritative name override outside the dictionary | `actor/chris-pratt` | Hardcoded after the dictionary. Not present in `data/person-names.json` |
| `epg/discovery-latest.json` | Authoritative candidate catalog | `normalizedTitle\|year` | EPG titles that are not yet films. Merged across programme commits |
| `epg/discovery-resolution.json` | Authoritative candidate decisions | Same candidate key | `verified`, `excluded_nonfilm`, `ambiguous`, `no_confident_match`, `duration_mismatch` |
| `epg/discovered-films.json` | Authoritative catalog of films found from EPG | `tmdb_<tmdbId>`, or the watchlist `lid` when that TMDB id is already on the watchlist | Separate from watchlist films. Carries `canonicalIdentity: "tmdb:<tmdbId>"` |
| `uncertain.json` | Diagnostic snapshot | Channel and start time | EPG rows that matched more than one watchlist film, or lacked year and duration |
| `enrichment/films/<id>/fingerprint.json` | Authoritative fingerprint | The film id used by the queue, URL-encoded | One current fingerprint. Replaced in place. `invalidatedAt: null` on write |
| `enrichment/films/<id>/predictions.json` | Authoritative prediction and its history | Same film id | `{current, history}`. The replaced prediction is appended with `replacedAt` |
| `enrichment/films/<id>/actual.json` | Authoritative personal rating record | Same film id | Letterboxd rating. Absence does not erase an older view-index rating |
| `enrichment/view-index.json` | Read model for the dashboard | Same film id | Compact fingerprint facet, prediction, `actualRating`, mood facet |
| `enrichment/profile/current.json` and `profile/versions/<n>.json` | Authoritative taste profile | Profile version and `profileHash` | A new version makes existing predictions stale. It does not delete fingerprints |
| `enrichment/prediction-queue.json` | Work queue projection | Film ids from the watchlist and discovered catalog | Rebuilt by `refreshPredictionQueue`. Not a film record |
| `enrichment/sources/<runId>.json` | Snapshot for one prediction run | Film id | `modelMetadata` copied at run start |
| `enrichment/diagnostics/baseline.json` | Frozen diagnostic snapshot | Film id | Copy of film fields, fingerprint, and prediction at freeze time |
| `sync.json` | Run record | Sync `runId` | Stage, metadata failures, localization error counts, rating error. Not a film |

`events/items/*` and `started/*` copy a film id and a display title. They are not a film store.

## Two film ids, one person id

A watchlist film id is the Letterboxd `lid` from `data-postered-identifier`. `parseWatchlist` stores only `id`, `title`, `original`, `year`, and `url`. `title` and `original` both start as the poster name with the trailing year removed.

`parseFilm` adds Letterboxd metadata onto that object: `tmdbId` from `data-tmdb-id` (or `null`), `original` from JSON-LD `name`, `aliases`, `genres`, `poster`, `runtime`, `synopsis`, `synopsisFetchedAt`, `metadataAt`, `directors`, `actors`, and `peopleVersion: 1`. A person id is `director/<letterboxd-slug>` or `actor/<letterboxd-slug>`. When the page has no slug, the id falls back to `role/<display name>`. The same human as both actor and director is two ids. The committed dictionary currently has no slug that appears in both roles.

A discovered film is created only after TMDB confirms a movie. Its stored id is `tmdb_<tmdbId>` unless `knownTmdb` already maps that TMDB id to a watchlist `lid`; then the catalog reuses the watchlist id. `canonicalIdentity` is the string `tmdb:<tmdbId>`. Enrichment dedupe uses the same string, computed as `tmdb:<tmdbId>` when `tmdbId` is present and `legacy:<id>` otherwise. Watchlist films are visited first, so a discovered film with the same TMDB id does not become a second enrichment row.

`people.json` and `programme.people` are not person entities. The person fields live on each film. `peopleCatalog` collects unique `{id, name, original}` values for the programme response. `reviewedPeople` applies the compiled dictionary again on `GET /api/programme` and `GET /api/watchlist`.

## How a watchlist film moves

1. `beginSync` reads the Letterboxd watchlist and merges `metadata.json`. The cached object is spread first, then the fresh watchlist fields, and `aliases` stay on the cached value. A film is pending when `metadataAt` is missing, `peopleVersion` is not `1`, `peopleNamesVersion` is not `2`, `synopsisFetchedAt` is missing, or `metadataAt` is older than 30 days.
2. `metadataSync` fetches the Letterboxd film page. A fresh film with people already parsed only refreshes the synopsis. A full parse replaces the metadata cache. A page error is stored on `sync.failures` as `{id, error}` and the run continues. Wikidata name lookup then sets `peopleNamesVersion` to `2` and `peopleLocalizedAt`. If that lookup throws, the version stays unset and the film stays pending.
3. `epgSync` calls `localizeFilmTitles` and `localizeByLetterboxd`, then applies `people.json` and `applyReviewedTitle`, then scans EPG. `scanEPG` copies the watchlist film into the matched row and may replace `title` with the Cyrillic EPG title. The programme film is `{...watchlistFilm, ...matchedFilm, shows}`. The saved `programme.json` can therefore show an EPG title while `titleRu` and `titleStatus` still come from the reviewed or provisional title. `GET /api/programme` runs `applyReviewedTitle` again, so a dictionary title wins on the API even when the stored programme title differs.
4. `finishSync` writes `watchlist.json` without `shows` when the programme film count matches `watchlistCount`. `refreshPredictionQueue` runs with trigger `programme_updated`. A queue failure is stored as `enrichmentQueueError` and does not roll back the programme.
5. Ratings run once inside that commit. A Letterboxd films-page failure leaves the previous bulk rating index in place. That retry is [AIR-64](https://trello.com/c/WTnyO8bX), not a film-identity transition.

## How an EPG candidate becomes a catalog film

`scanEPG` emits a discovery item only when the row is 55–300 minutes, is not a non-film title, and is not exactly one watchlist match. The item key is `normalizedTitle|year`. Fields are `key`, `confirmedTmdbId` (set when the only match is a catalog film), `title`, `rawTitles`, `normalizedTitle`, `year`, `duration`, `description`, `firstAiring`, `lastAiring`, `airings`, and `shows`. `mergeDiscoveryCandidates` keeps the earlier `firstAiring`, the later `lastAiring`, and at most eight raw titles and twelve durations.

`resolveDiscoveryChunk` is a separate lifecycle, owned by [AIR-48](https://trello.com/c/rVf8rRoJ) for candidate retention. For AIR-42 the decision records are only the input to Film identity:

| Decision | Meaning for a future Film |
| --- | --- |
| No decision, or `retryAt` already due | Identity unresolved. Next action is another discovery chunk, subject to the discovery lease and chunk budget |
| `excluded_nonfilm` | Not a film. Reason is the EPG label (`show_label`, `series_label`, `episode_label`, `season_episode_suffix`, `broadcast_episode`) |
| `ambiguous` or `no_confident_match` or `duration_mismatch` | Identity unresolved, with `attempts` and `retryAt`. Delay doubles per attempt and stops growing at seven days |
| `verified` | Identity resolved to `tmdbId` and `filmId`. `identitySource` is `known_epg_alias`, `known_alias_year_runtime`, `known_alias_unique_runtime`, or absent when this chunk created the TMDB record |
| `canonicalizeDiscoveryLedger` finds two verified TMDB ids for one key | The reconcile route rejects the catalog. It does not pick a winner |

A verified TMDB movie is written to `epg/discovered-films.json` before its decision. A crash between those writes is repaired by alias reuse on the next chunk. `touchCanonicalFilm` updates aliases, recent shows, `epgLastAiring`, and `hotEnteredAt`. It does not change `tmdbId`.

`uncertain.json` is the watchlist-side ambiguity list (`ambiguous` or `insufficient_year_or_duration`), capped at 100 rows. It is not the discovery resolution ledger.

## Titles and names

Reviewed film titles live in `data/film-titles.json` and win over Wikidata and over a cached provisional title. `reviewedTitle` also requires the TMDB id to match when both sides have one. Applying a reviewed title sets `title`, `titleRu`, `titleStatus`, and `titleSources`, and folds the previous title into `aliases`.

`titles.json` receives a record only from Wikidata, and only when that TMDB id has exactly one Russian label. The object key is the Letterboxd id. The value is `{tmdbId, title, status: "provisional", sources: [wikidata wiki url]}`. A cached record whose `tmdbId` differs from the film is ignored. Multiple Wikidata labels produce no cache entry, so the film keeps the Letterboxd or EPG title and has no `titleStatus`.

The committed title dictionary has this shape. `28nq` is the Letterboxd id; the title is the reviewed Russian name:

```json
{"id":"28nq","tmdbId":"1656","original":"The Legend of Zorro","year":2005,"title":"Легенда Зорро","sources":["https://www.kinopoisk.ru/film/77407/"],"kinopoiskId":"77407","aliases":[],"status":"verified"}
```

Reviewed names live in `data/person-names.json`. A verified record supplies `name`, `aliases`, `nameStatus`, `nameVerificationBasis`, and `nameSource`. Four records are `provisional` with `verification_basis` `provisional_transcription`: `actor/delia-enea`, `actor/lee-chung-hee`, `actor/leonardo-orsolini`, and `actor/luca-papp`. Every `aliases` array in that file is empty. The only in-code alias is `actor/chris-pratt` (`Крис Прэтт`, alias `Крис Пратт`), applied after the dictionary.

Wikidata name lookup writes `people.json` only when exactly one Russian label matches the film's TMDB id plus the normalized English name, or the Letterboxd slug. Several labels leave the embedded `name` equal to `original`. `localizePeople` copies a reviewed person into the cache and does not replace that name with Wikidata.

`peopleNamesVersion: 2` means the localization attempt finished. It does not mean every person has a Russian name.

## Fingerprint, prediction, and availability

A fingerprint file is current when `fingerprintSchemaVersion` is `1` and `invalidatedAt` is absent. The writer sets `invalidatedAt` to `null`, `generatedAt`, `filmId`, and `fingerprintHash`. The hash covers the model payload plus `filmId`. Required fields are `plotMechanics`, `execution`, `moodLabels` (2–4), `strengths`, `risks`, `confidence`, `sourceBasis`, and `sourceRefs`. There is no fingerprint history object. A new fingerprint replaces the file.

A prediction is current when its fingerprint is current and `tasteProfileVersion`, `tasteProfileHash`, `fingerprintHash`, `fingerprintSchemaVersion`, and `predictionPromptVersion` match. `predictionPromptVersion` is `1`. The queue treats a view-index prediction as missing when those profile and hash fields do not match. That is the stale signal. Profile publish writes `enrichment/profile/versions/<version>.json` and refreshes the queue with `profile_updated`. It does not open fingerprint files.

`predictions.json` keeps the previous current prediction in `history` with `replacedAt`. `view-index.json` keeps the compact copy the dashboard reads. `GET /api/enrichment/view` reports `stale` on that copy when the profile or fingerprint hash does not match. Personal `actualRating` is independent of both.

Availability is not stored as a status. `shows` on a programme film are the matched broadcasts. `availableUntil` is the latest show start plus 72 hours, computed by `withAvailability` and again on programme read. `filmIsHot` is true when a show starts in the last 72 hours or the next 24 hours, or when a discovered film's `epgLastAiring` falls in that window. Hot only changes queue order.

## Mapping to the future contract

These rows are the decision table implemented by `src/domain/film-person.js`. The statuses below are the AIR-42 vocabulary. The Worker still does not write them.

| What exists today | Dimension | Proposed status | Proposed next action |
| --- | --- | --- | --- |
| Watchlist film with no `tmdbId` after a successful page parse | identity | `rejected` is wrong; the page had no TMDB id | `unresolved`. Next action: do not invent a TMDB id. Keep the Letterboxd id |
| Discovery decision missing or due | identity | `unresolved` | Continue discovery under the existing chunk contract |
| `ambiguous`, `no_confident_match`, `duration_mismatch` with future `retryAt` | identity | `ambiguous` for `ambiguous`; `unresolved` for the other two | Wait until `retryAt`. Do not start a second identity |
| `verified` decision and a catalog or watchlist film with that `tmdbId` | identity | `resolved` | Stop identity work. External ids are Letterboxd `lid` and `tmdb:<id>` |
| `excluded_nonfilm` | identity | Not an entity | No Film |
| Two verified TMDB ids for one candidate key | identity | `ambiguous` | Do not merge. Surface the reconcile error |
| No `metadata.json` entry | metadata | `missing` | Fetch the Letterboxd page |
| `metadataAt` within 30 days, `peopleVersion` 1, synopsis present, names not yet version 2 | metadata | `fresh`, while localization can still be `missing` | Run name localization only |
| Synopsis refreshed, older credits kept | metadata | `partial` | Credits stay until a full parse is actually required |
| `metadataAt` older than 30 days | metadata | `stale` | Full parse |
| `sync.failures[]` for that id | metadata | `failed` | Retry on the next metadata step. The error string is the failure reason |
| No `titleRu` and no dictionary row | localization | `missing` | Wikidata title lookup when `tmdbId` exists |
| `titles.json` `status: provisional`, or a single Wikidata name in `people.json` | localization | `provisional` | Keep it until a reviewed value exists. A new automatic value may replace it |
| Dictionary `status: verified`, or the `chris-pratt` override | localization | `reviewed` | Automatic sync must not replace `title` / `name`. A conflicting automatic label is kept as provenance |
| Dictionary person `provisional_transcription` | localization | `provisional`, even though the file is the reviewed dictionary | Do not treat the file name as the status. The record's `status` wins |
| Stored programme `title` is the EPG title while `titleRu` is reviewed | localization | `reviewed` for the preferred title | Readers already reapply the dictionary. The stored EPG title is an alias source, not the preferred title |
| No fingerprint file, or `invalidatedAt` set, or schema is not 1 | fingerprint | `missing` for absent; `stale` for a bad schema or `invalidatedAt` | `requiredWork: fingerprint_and_prediction` |
| Fingerprint file passes `fingerprintCurrent` | fingerprint | `current` | Do not regenerate because the taste profile changed |
| No prediction, or profile version/hash, fingerprint hash, or prompt version differs | prediction | `missing` or `stale` | Queue the film. `requiredWork` is `prediction_only` when the fingerprint is current |
| Prediction passes `predictionCurrent` | prediction | `current` | Leave it. History stays in `predictions.json` |
| `run.failures[id]` or queue `retries[id]` | prediction | `failed` | Existing backoff. Do not mark `current` |
| `shows` / `availableUntil` / hot | availability | Projection | Recompute from the programme or `epgLastAiring`. Do not store a sixth status |

`displayReady` is true when identity is `resolved`, or a Letterboxd id is already known, and some title exists: reviewed, provisional, original, or EPG. `rejected` identity is not displayable. Missing and provisional localization do not block display. The dashboard already shows the Letterboxd or EPG title in that case. `catalogReady` means a stable external id is known (a trusted non-conflicting `tmdbId` or, for a watchlist film that never received one, the Letterboxd id alone) and metadata is `fresh` or `partial`. `predictionReady` means fingerprint and prediction are both `current` for the published profile. `canonicalIdentity` is published only when identity is `resolved`. An `ambiguous`, `no_confident_match`, or `duration_mismatch` decision does not promote a proposed TMDB id. Conflicting verified TMDB ids do not become `canonicalIdentity`.

## Phase 1 contract

`DOMAIN_CONTRACT_VERSION` is 1. Tests in `tests/film-person.mjs` use the examples in this document, including `28nq` / TMDB `1656` / `Легенда Зорро`, the four `provisional_transcription` people, and the `actor/chris-pratt` override as input. The override stays in `src/sources.js` until [AIR-44](https://trello.com/c/ojtZjVc9). The domain module does not copy it.

`localFilmId` mints a new record: `film:<letterboxd lid>` when the observation starts from Letterboxd, `film:tmdb:<tmdbId>` when it starts from one TMDB id, and `film:conflict:<sorted ids>` when two verified TMDB ids disagree and no Letterboxd id is known. Passing `localId` keeps an id that was already minted. `linkFilms(existing, incoming, at, evidence)` is the only way to attach another external id. `existing.id` stays. A different incoming local id becomes `{from, to}` on `redirects`. The survivor keeps its fingerprint object, prediction object, metadata object, and existing prediction-history entries. The incoming fingerprint and prediction are returned on `preserved`, and the incoming prediction is appended to history once. A repeat, including after a JSON round trip, does not add another history entry, redirect, or localization conflict. Those keys ignore the timestamp. Aliases are the union. A reviewed localization on the survivor stays; a reviewed incoming value is adopted only when the survivor is not reviewed. Two different Letterboxd ids, or two different TMDB ids, return `identity_collision` and leave both records untouched. Merging two local records requires the same Letterboxd id, the same trusted TMDB id on both records, or `evidence.verified === true`. A shared proposed TMDB id is not that evidence, even when one record already trusts it; the result is `unverified` and neither record changes. Records that share neither a Letterboxd id nor a trusted TMDB id return `unrelated`. An external id without its own local id can still be attached to the existing record. `canonicalIdentity` remains `tmdb:<id>` or null and is not the object id. A person id is `person:` plus the current role id (`actor/<slug>`, `director/<slug>`, `role/<name>`, or a catalog credit `tmdb_actor/<id>` / `tmdb_director/<id>`). The same slug as actor and director stays two people. A TMDB credit id stays separate from a Letterboxd role id. Person dedupe is [AIR-44](https://trello.com/c/ojtZjVc9).

Each dimension state is `status`, `updatedAt`, `source`, `sourceVersion`, `provenance`, `lastError`, `failureReason`, `retryAt`, `attempts`, and `nextAction`. Localization also has `value`, the preferred title or name. The state does not carry the metadata, fingerprint, or prediction payload. `peopleNamesVersion === 2` means the name pass finished. It does not mark a person `reviewed`. A record's own `status` wins over the dictionary file, so `provisional_transcription` stays `provisional`.

`transition(state, status, patch)` refuses an edge outside the graph and returns the previous state. Resolved identity does not return to `resolving` or `unresolved`. Reviewed localization does not return to `provisional` or `missing`. `applyAutomaticLocalization` cannot write `reviewed`, including when the automatic input claims that status. The attempted value is kept on `localizationConflicts` and in `aliases`. `applyReviewedLocalization` is the trusted path and requires `authority` `dictionary` or `owner`. Fingerprint `current` does not become `missing`. `invalidatePredictionForProfile` moves prediction to `stale` and leaves the fingerprint state object in place. When that fingerprint is `current`, the next action is `prediction_only`. `observeMetadata` replaces the metadata observation only. A profile change or a metadata observation does not regenerate the fingerprint. `availabilityProjection` returns `{availableUntil, hot}` and no status. Hot uses the same window as `filmIsHot`: 72 hours back and 24 hours ahead, end exclusive. `availableUntil` is the latest show start plus 72 hours. An empty `shows` list uses `epgLastAiring` for hot and does not invent `availableUntil`.

Metadata actions follow the source. A record with a Letterboxd id uses `fetch_letterboxd_page`, `full_parse`, and `retry_metadata`. A TMDB-only record uses `fetch_tmdb_metadata`, `refresh_tmdb_metadata`, and `retry_tmdb_metadata`. The other next action tokens are `keep_letterboxd_id`, `continue_discovery`, `wait_retry`, `stop`, `surface_conflict`, `refresh_synopsis`, `localize_names`, `lookup_wikidata_title`, `lookup_wikidata_name`, `keep_provisional`, `keep_reviewed`, `fingerprint_and_prediction`, `prediction_only`, `retry_prediction`, `leave`, and `none`. `none` on fresh metadata means the credits and synopsis are present and the name pass has finished. `creditsRetained` is the synopsis-only refresh: metadata stays `partial`, and the next action is not a full parse.

## Invariants the adapter must keep

- Letterboxd `lid` and TMDB id stay recoverable. `canonicalIdentity` does not replace the object key.
- Reviewed titles and reviewed names are not downgraded to provisional. The `chris-pratt` override is reviewed data until [AIR-44](https://trello.com/c/ojtZjVc9) absorbs it.
- `aliases` on a film accumulate. `beginSync` currently keeps the cached alias list when it merges a new watchlist row.
- A missing fingerprint still allows the film to appear. A missing prediction still allows the film to appear. A missing Russian title still allows the film to appear.
- Prediction history and the diagnostic baseline are not rewritten by a metadata refresh.
- Discovery candidate keys are not film ids. Candidate `verified` is an identity result, not a prediction status.
- Hot and `shows` change without a new fingerprint.
- A profile version change enqueues prediction refresh and leaves fingerprint files in place.
- Partial writes that already exist must remain readable: film saved before its discovery decision, view-index updated per rating, prediction history appended only after the new current prediction is the payload being saved.

## What the next PRs are, and what they are not

Phase 0 was the audit. The sequence on the card is:

1. **Phase 1, implemented.** `src/domain/film-person.js` is a pure module, with no Worker, R2, or network import. It defines local Film and Person ids, external ids, the five Film dimensions above, availability as a function, transition guards, `displayReady`, `catalogReady`, `predictionReady`, and the invalidation rules in the table. Person dedupe stays in [AIR-44](https://trello.com/c/ojtZjVc9). Tests use the examples in this document. No production path calls the module.
2. **Phase 2a, implemented.** `src/domain/film-person-reader.js` builds Film and Person views from records the caller already loaded. It does not read or write storage, and it does not change those records. Sidecars are returned as `*.lifecycle.json` siblings: watchlist, metadata, and the discovered catalog, plus fingerprint status beside an existing fingerprint. They carry the lifecycle state, not the fingerprint or prediction payload, and not prediction history. The reader does not emit `programme.json`, `epg/discovery-latest.json`, `enrichment/prediction-queue.json`, or a `predictions.json` key. A catalog row is `verified` unless a decision names that catalog id and says otherwise. `linkFilms` then keeps the existing local id when both sides trust the same TMDB id. The discovered sidecar uses that catalog row, or the redirect left by that link. It does not attach the row to another film merely because the TMDB numbers match. A decision that is not `verified` and names that catalog id stays a separate record, so `shadowParity` reports the catalog id as extra when the legacy enrichment set already collapsed the same TMDB number. For ids that are in both sets, `parity.mismatches` compares fingerprint status, prediction status, display, catalog, and prediction readiness, and the title `GET /api/programme` would render. That title is the programme or watchlist `title`. A verified dictionary entry replaces it, and a `titles.json` row replaces it when its TMDB id matches. `original` and a provisional `titleRu` do not. The lifecycle preferred title can therefore differ from the title on screen, and parity reports that. A null TMDB id does not hide a TMDB id on another loaded row. The order is the programme row, metadata, the watchlist row, then the record. Two different ids stay a conflict and do not become `canonicalIdentity`. A reviewed `titleRu` is kept on the lifecycle view from metadata, then the programme row, the watchlist row, and the record; an empty value does not hide a later reviewed one. Sorting the catalog for the legacy id list copies the array first. `excluded_nonfilm` is a candidate, not a film. People come from names embedded on the programme, watchlist, metadata, and catalog, not from dictionary entries that no record uses. Existing routes stay authoritative. No production path calls the reader. Tests load this file after `src/domain/film-person.js`; the Worker bundle includes neither.
3. **Phase 2b, implemented as a dry-run.** `src/domain/film-person-backfill.js` builds the phase 2a sidecars again, adds `people.lifecycle.json`, and compares that set with sidecars the caller already has. The comparison is `create`, `update`, `unchanged`, `orphan`, or `conflict`. A reviewed name or title that would be removed or replaced is a conflict. So is a body that carries prediction history. A catalog row that gains a Letterboxd id stays an update when the new body redirects from the previous id. Orphan keys are reported and not deleted. The person sidecar is not `people.json` or `programme.json`. `node scripts/lifecycle-parity.mjs --snapshot /absolute/private/snapshot-directory` reads a migration-export snapshot outside this repository, checks the manifest, and prints counts only. It writes nothing. The 19 October 2026 snapshot is a historical archive, not a current copy of production, and its output is not committed. No production path calls the backfill.
4. **Phase 3.** One existing processor at a time, behind the current lease. The first safe connections are title localization and name localization, because their reviewed rule is already implemented. Identity stays on the current resolver until [AIR-43](https://trello.com/c/7NY6n1Az). The resolver algorithm, candidate retention, and fingerprint evidence rules do not change in AIR-42.
5. **Phase 4.** Read-only diagnostics for one entity and for counts. [AIR-53](https://trello.com/c/gkuy1awG) is the owner UI. [AIR-49](https://trello.com/c/YNaLFwtW) is the later D1 move and is not required to finish AIR-42.

Rollback for the audit is deleting this document. Rollback for phase 1 is deleting `src/domain/film-person.js` and `tests/film-person.mjs`. Rollback for phase 2a is deleting `src/domain/film-person-reader.js` and `tests/film-person-reader.mjs`. Rollback for phase 2b is deleting `src/domain/film-person-backfill.js` and `tests/film-person-backfill.mjs`. No data migration runs.
