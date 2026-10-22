# Film and Person lifecycle: legacy audit

Phase 0 of [AIR-42](https://trello.com/c/drLBuWjl) mapped the records that exist today. Phase 1 implements that decision table in `src/domain/film-person.js`. The module stays pure: it does not fetch, and it does not read or write storage. Phase 3 includes that one file in the Worker bundle. Title and name localization use its reviewed guard only when `LIFECYCLE_LOCALIZATION` names a path. The variable is unset by default, so metadata sync, EPG sync, and the programme and watchlist reads keep the previous assignment. The reader, the backfill, discovery, enrichment, fingerprint, and prediction still do not call it. R2 keys, Scheduled Tasks, and the MCP contract are unchanged.

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

`scanEPG` emits a discovery item only when the row is 55–300 minutes, is not a non-film title, and is not exactly one watchlist match. The item key is `normalizedTitle|year`. Fields are `key`, `confirmedTmdbId` (set when the only match is a catalog film), `title`, `rawTitles`, `normalizedTitle`, `year`, `duration`, `description`, `firstAiring`, `lastAiring`, `airings`, and `shows`. A successful EPG scan replaces `shows` with that scan alone. A candidate missing from the new feed keeps its key, titles, and airing history, and its `shows` become empty. `mergeDiscoveryCandidates` still keeps the earlier `firstAiring`, the later `lastAiring`, and at most eight raw titles and twelve durations. It does not combine show lists from two scans.

`resolveDiscoveryChunk` is a separate lifecycle, owned by [AIR-48](https://trello.com/c/rVf8rRoJ) for candidate retention. A replacement scan marks each candidate `seenInLatestSnapshot` and stores `lastSeenAt` and `lastSeenProgrammeRunId`. Only a candidate seen in the latest feed with a show inside the last 72 hours or next 24 hours is actionable. A current candidate whose identical evidence already stopped stays stored and is not pending work. Historical and expired rows stay in the ledger and are not selected. A payload written before those fields is current only when it already stores an in-window show. Match quality is a separate pure function in `src/domain/scored-resolution.js`, described in [scored resolution](scored-resolution.md). Discovery calls it only when `SCORED_RESOLUTION` is set. For AIR-42 the decision records are only the input to Film identity:

| Decision | Meaning for a future Film |
| --- | --- |
| No decision, or `retryAt` already due | Identity unresolved. Next action is another discovery chunk, subject to the discovery lease and chunk budget |
| `excluded_nonfilm` | Not a film. Reason is the EPG label (`show_label`, `series_label`, `episode_label`, `season_episode_suffix`, `broadcast_episode`) |
| `ambiguous` or `no_confident_match` or `duration_mismatch` | Identity unresolved. Identical evidence retries up to five times, then `terminalReason` is `repeated_uncertain_match` and the candidate stays stored. A changed title, year, duration, or broadcast starts a new series |
| `verified` | Identity resolved to `tmdbId` and `filmId`. `identitySource` is `known_epg_alias`, `known_alias_year_runtime`, `known_alias_unique_runtime`, or absent when this chunk created the TMDB record |
| `canonicalizeDiscoveryLedger` finds two verified TMDB ids for one key | The reconcile route rejects the catalog. It does not pick a winner |

A verified TMDB movie is written to `epg/discovered-films.json` before its decision. A crash between those writes is repaired by alias reuse on the next chunk. `touchCanonicalFilm` updates aliases, `epgLastAiring`, and `hotEnteredAt`. Shows from every alias in the same `programmeRunId` are combined. A different programme run replaces them. It does not change `tmdbId`. `epgLastAiring` is historical metadata. An empty `shows` list is not currently available, even when that airing time is still inside 72 hours. A successful scan stages the discovery ledger, the catalog, and the programme, then switches `epg/published-generation.json`. Readers follow that pointer. A resolver that still holds the previous generation does not write the catalog. The same replacement is applied to the catalog when an EPG scan commits, so a failed scan leaves the previous programme and catalog together.

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

`transition(state, status, patch)` refuses an edge outside the graph and returns the previous state. Resolved identity does not return to `resolving` or `unresolved`. Reviewed localization does not return to `provisional` or `missing`. `applyAutomaticLocalization` cannot write `reviewed`, including when the automatic input claims that status. The attempted value is kept on `localizationConflicts` and in `aliases`. `applyReviewedLocalization` is the trusted path and requires `authority` `dictionary` or `owner`. Fingerprint `current` does not become `missing`. `invalidatePredictionForProfile` moves prediction to `stale` and leaves the fingerprint state object in place. When that fingerprint is `current`, the next action is `prediction_only`. `observeMetadata` replaces the metadata observation only. A profile change or a metadata observation does not regenerate the fingerprint. `availabilityProjection` returns `{availableUntil, hot}` and no status. Hot uses the same window as `filmIsHot`: 72 hours back and 24 hours ahead, end exclusive. `availableUntil` is the latest show start plus 72 hours. An explicit `shows` array, including `[]`, is the current list. Hot is true only when one of those starts falls in the window, and `[]` stays cold even if `epgLastAiring` is fresh. When a published programme run is known, a missing `shows` list is cold too. `epgLastAiring` supplies hot only when `shows` is absent, `showsProgrammeRunId` is absent, and no published run is known. Shows stored for programme run A are not hot when the published run is B.

Metadata actions follow the source. A record with a Letterboxd id uses `fetch_letterboxd_page`, `full_parse`, and `retry_metadata`. A TMDB-only record uses `fetch_tmdb_metadata`, `refresh_tmdb_metadata`, and `retry_tmdb_metadata`. The other next action tokens are `keep_letterboxd_id`, `continue_discovery`, `wait_retry`, `wait_new_evidence`, `stop`, `surface_conflict`, `refresh_synopsis`, `localize_names`, `lookup_wikidata_title`, `lookup_wikidata_name`, `keep_provisional`, `keep_reviewed`, `fingerprint_and_prediction`, `prediction_only`, `retry_prediction`, `leave`, and `none`. `none` on fresh metadata means the credits and synopsis are present and the name pass has finished. `creditsRetained` is the synopsis-only refresh: metadata stays `partial`, and the next action is not a full parse.

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

## Scoring result to identity gate

[AIR-43](https://trello.com/c/7NY6n1Az) owns match quality. [AIR-42](https://trello.com/c/drLBuWjl) owns canonical Film identity. `src/domain/resolution-acceptance.js` is the pure gate between them. The Worker bundle loads the gate and the scorer. Discovery calls them only when `SCORED_RESOLUTION` is `shadow` or `on`. The repository leaves that variable unset. `shadow` keeps the previous decision and catalog. `on` does not verify a score, create a Film, or call `linkFilms`. Unset the variable to roll back.

The caller passes these separate inputs:

- The `scoreFilmResolution()` result, unchanged: `scorerVersion`, `observationKey`, `status`, `confidence`, `score`, `acceptedTmdbId`, `reason`, and `considered`.
- `pinnedProgrammeRunId` and the observation's own programme run id. The scorer does not return either one.
- The observation's own candidate key. It must equal `score.observationKey`. The programme-run pin does not bind a scorer result to an observation.
- Eligibility facts already computed by [AIR-48](https://trello.com/c/rVf8rRoJ): `eligible`, `activity` (`current`, `historical`, or `expired`), `evidenceChanged`, and `terminal`. This gate and `identityState` do not call `resolutionActionability`, `candidateActivity`, or `candidateEvidence`, and they do not rebuild the retry schedule.
- The existing Film id, `canonicalIdentity`, and every external id, plus an optional confirmation. A confirmation is trusted only for authority `verified_decision` or `owner`. `verified_decision` requires evidence whose decision is `status: 'verified'` for the same TMDB id. `owner` requires evidence with `authority: 'owner'`, `reviewed: true`, and that same TMDB id. A cache row, a display name, a score, or any other authority stays unverified.

`observationKey` names the decision. It is not a Film id. Provenance stays on the scoring decision even when no Film changes. Two observations can name the same TMDB id and remain two decisions. A scorer key that does not match the supplied observation key is refused.

A scoring status maps onto an existing AIR-48 candidate decision only as follows. The original scorer status, reason, and evidence stay on the scoring record.

| Scorer status and reason | AIR-48 candidate status |
|---|---|
| `contradicted` / `contradicted_runtime` | `duration_mismatch` |
| `contradicted` / `contradicted_year` | `no_confident_match` |
| `ambiguous` | `ambiguous` |
| `no_confident_match` | `no_confident_match` |
| `accepted` | no candidate status is written |

`accepted` and `acceptedTmdbId` are scoring acceptance, not trusted identity acceptance. `considered[].trusted` does not promote a Film. Without a recognized confirmation the outcome is `needs_verification`: no `linkFilms` evidence, no `verified: true`, and no canonical change. A new film can be recognized and left for verification. A recognized confirmation, the same TMDB id, the pinned generation, current eligibility, and no collision can return `trusted_acceptance`. That transition is a separate object from the scoring result and from the candidate decision. It still does not set `evidence.verified`. A second application of the same observation key to a Film that already has that canonical id is `already_applied`.

Discovery passes a `verified_decision` confirmation only from the decision stored on that same observation key. Another candidate's verified row is not authority for this title. An accepted score without that confirmation is held as `needs_verification`: it is not verified, it keeps the attempt cap, and the same evidence does not request another lookup. `candidate_decision` and `trusted_acceptance` are the only outcomes that authorize a later identity write. Both require the supplied facts `eligible: true` and `activity: 'current'`, and a terminal fact whose evidence has not changed blocks them. A historical, expired, or missing gate refuses with `not_actionable` and leaves the scoring record in place. The gate does not invent a new discovery attempt.

Every existing TMDB claim is a collision check: an untrusted id, a `conflicting` id, more than one id, or a different `canonicalIdentity`. Any of those refuses with `identity_collision` and does not change the Film. A programme run other than the pinned run refuses with `stale_generation` and does not change the Film.

`identityState` uses the supplied eligibility facts and does not rediscover them. `discoveryPending` does not authorize `continue_discovery` when eligibility is missing or unknown. A historical or expired candidate, a terminal decision whose evidence has not changed, or a missing eligibility fact does not receive `continue_discovery`. A future `retryAt` with unchanged evidence stays `wait_retry`. Changed evidence plus `eligible: true` and `activity: 'current'` can return `continue_discovery`. A TMDB id with `decision: null` and no Letterboxd id is not trusted and does not become `canonicalIdentity`. The 808 cache-versus-dictionary name differences are not TMDB evidence and do not raise this gate.

[AIR-49](https://trello.com/c/YNaLFwtW) later has to store these separately: canonical Film and Person identities with trusted external ids; the historical EPG candidate ledger and observations; scored results with `scorerVersion`, evidence, acceptance, provenance, and decision history; `attempts`, `retryAt`, `terminalReason`, and `evidenceKey`; current shows bound to the published EPG generation, including an explicit `[]`; historical `epgLastAiring`; reviewed localization, fingerprints, predictions, and immutable history. The lifecycle sidecars and the dry-run reader are not that repository. This document does not add a D1 schema.

The AIR-43 PR 2 gate is this contract plus the regression tests, accepted by both sides. Opening the compatibility pull request does not close the gate. Phase 4, a D1 move, and the remaining localization paths are not part of the gate. `programme` and `watchlist` are on for the generation recorded in the rollout log. `metadata` and `epg` stay off until their own decisions, and the EPG path still waits on the 808 name review.

## What the next PRs are, and what they are not

Phase 0 was the audit. The sequence on the card is:

1. **Phase 1, implemented.** `src/domain/film-person.js` is a pure module, with no Worker, R2, or network import. It defines local Film and Person ids, external ids, the five Film dimensions above, availability as a function, transition guards, `displayReady`, `catalogReady`, `predictionReady`, and the invalidation rules in the table. Person dedupe stays in [AIR-44](https://trello.com/c/ojtZjVc9). Tests use the examples in this document. Phase 3 is the first caller of the localization guards, and only when `LIFECYCLE_LOCALIZATION` names that path.
2. **Phase 2a, implemented.** `src/domain/film-person-reader.js` builds Film and Person views from records the caller already loaded. It does not read or write storage, and it does not change those records. Sidecars are returned as `*.lifecycle.json` siblings: watchlist, metadata, and the discovered catalog, plus fingerprint status beside an existing fingerprint. They carry the lifecycle state, not the fingerprint or prediction payload, and not prediction history. The reader does not emit `programme.json`, `epg/discovery-latest.json`, `enrichment/prediction-queue.json`, or a `predictions.json` key. A catalog row is `verified` unless a decision names that catalog id and says otherwise. `linkFilms` then keeps the existing local id when both sides trust the same TMDB id. The discovered sidecar uses that catalog row, or the redirect left by that link. It does not attach the row to another film merely because the TMDB numbers match. A decision that is not `verified` and names that catalog id stays a separate record, so `shadowParity` reports the catalog id as extra when the legacy enrichment set already collapsed the same TMDB number. For ids that are in both sets, `parity.mismatches` compares fingerprint status, prediction status, display, catalog, and prediction readiness, and the title `GET /api/programme` would render. That title is the programme or watchlist `title`. A verified dictionary entry replaces it, and a `titles.json` row replaces it when its TMDB id matches. `original` and a provisional `titleRu` do not. The lifecycle preferred title can therefore differ from the title on screen, and parity reports that. A null TMDB id does not hide a TMDB id on another loaded row. The order is the programme row, metadata, the watchlist row, then the record. Two different ids stay a conflict and do not become `canonicalIdentity`. A reviewed `titleRu` is kept on the lifecycle view from metadata, then the programme row, the watchlist row, and the record; an empty value does not hide a later reviewed one. Sorting the catalog for the legacy id list copies the array first. `excluded_nonfilm` is a candidate, not a film. People come from names embedded on the programme, watchlist, metadata, and catalog, not from dictionary entries that no record uses. Existing routes stay authoritative. No production path calls the reader. Tests load this file after `src/domain/film-person.js`. The Worker bundle includes the contract and not this reader.
3. **Phase 2b, implemented as a dry-run.** `src/domain/film-person-backfill.js` builds the phase 2a sidecars again, adds `people.lifecycle.json`, and compares that set with sidecars the caller already has. The comparison is `create`, `update`, `unchanged`, `orphan`, or `conflict`. A reviewed name or title that would be removed or replaced is a conflict. So is a body that carries prediction history. `updatedAt` and the `at` on a redirect are observation times: the same sidecar a minute later stays `unchanged`, while a real status change, including metadata that crosses the 30-day fresh window, stays an `update`. A catalog row that already has a persisted local id keeps that id when Letterboxd evidence arrives. The new body redirects from the Letterboxd id to the persisted id, and a fingerprint sidecar stored under the earlier id stays. Aliases stay with that survivor. Fingerprint and prediction status are recomputed from the current payload and taste profile: a persisted sidecar cannot mark either one `current` when the payload is gone, the fingerprint schema no longer matches, or the taste profile has changed. A persisted reviewed title that disagrees with a new reviewed title stays in place, the disagreement is kept on the body, and that sidecar is `reviewed_conflict`. Prediction history stays on the caller's record and is not copied into the sidecar. Orphan keys are reported and not deleted. The person sidecar is not `people.json` or `programme.json`. `node scripts/lifecycle-parity.mjs --snapshot /absolute/private/snapshot-directory` reads a migration-export snapshot outside this repository. The clock is `manifest.finishedAt`, or an ISO timestamp passed with `--as-of`. Before the comparison it checks schema, provisional status, an empty `changes` list, source identity, the exporter totals, and that every file in `objects/` is listed. The person comparison uses the reviewed override compiled in `src/sources.js`. It prints counts only and writes nothing. The 19 October 2026 snapshot is a historical archive, not a current copy of production, and its output is not committed. No production path calls the backfill.
4. **Phase 3, implemented for titles and names, and off until a path is named.** `LIFECYCLE_LOCALIZATION` is a Worker variable. The repository leaves it unset, and the rollout log records any production value. A token is `shadow:<path>` or `on:<path>`. The paths are `metadata`, `epg`, `programme`, and `watchlist`. The last token for a path wins, and an unknown token is ignored. A path that is off keeps the previous title and name assignment. The programme and watchlist readers apply a cached title only when `reviewedTitle` does not match, so a dictionary film does not gain the cache label as an alias. `shadow` runs that assignment and the lifecycle guard on copies and keeps the previous result. The counts are separate for films, people, and cache entries. Each group has `compared` and `mismatched`. Films and people also have `displayed`, which counts a changed title or name. `mismatched` does not exceed `compared` in a group, and `displayed` does not exceed `mismatched`. An alias-only or status-only change is mismatched and not displayed. The header is `films=compared/mismatched/displayed;people=compared/mismatched/displayed;cache=compared/mismatched`. `on` uses the guard. Metadata and EPG store the counts on the sync run only when that path is not off. The programme and watchlist reads send `X-Lifecycle-Localization` only when their path is not off, and those reads do not write the counts to R2. On the guard path, `titleAuthority` or `nameAuthority` of `owner` keeps a different verified value. The dictionary value is an alias and one `owner_kept` conflict. A verified value whose `titleSources` equal the current dictionary sources, or whose `nameVerificationBasis` and `nameSource` equal the current dictionary person, is a previous dictionary value and takes the corrected entry. A verified value with neither owner authority nor that dictionary provenance stays in place as one `unresolved` conflict with authority `unknown`. A repeat does not add another conflict. A missing or provisional value still takes the dictionary. A Wikidata label for a person keeps `nameStatus` of `provisional`, `nameSource` of `wikidata`, and the previous name as an alias. A `titles.json` row that claims `verified` is applied as `provisional` on that path. A dictionary person whose own status is `provisional` stays provisional. The calls remain inside the existing metadata and EPG sync steps and on the existing GET routes. No lifecycle sidecar is written. Identity stays on the current resolver until [AIR-43](https://trello.com/c/7NY6n1Az). The resolver algorithm, candidate retention, and fingerprint evidence rules do not change in AIR-42.
5. **Phase 4.** Read-only diagnostics for one entity and for counts. [AIR-53](https://trello.com/c/gkuy1awG) is the owner UI. [AIR-49](https://trello.com/c/YNaLFwtW) is the later D1 move and is not required to finish AIR-42.

Rollback for the audit is deleting this document. Rollback for phase 1 is deleting `src/domain/film-person.js` and `tests/film-person.mjs`. Rollback for phase 2a is deleting `src/domain/film-person-reader.js` and `tests/film-person-reader.mjs`. Rollback for phase 2b is deleting `src/domain/film-person-backfill.js` and `tests/film-person-backfill.mjs`. Rollback for phase 3 is unsetting `LIFECYCLE_LOCALIZATION`, restoring the previous title and name assignment in `src/sources.js` and `src/worker.js`, and removing `src/domain/film-person.js` from `build.mjs`. No data migration runs.

## Phase 3 rollout log

### 2026-10-21 offline shadow-equivalent checkpoint

This is an offline comparison. It is not a live `shadow:programme` or `shadow:watchlist` rollout, and no `X-Lifecycle-Localization` header was observed on the Worker.

- Date: 2026-10-21 13:45 (GMT+2). Commit `a908e681cad1f4164d6c069b82c3c39674dbddb6`, the merge of PR #30. GitHub Actions run [39590207857](https://github.com/vladimino/iptv-watchlist/actions/runs/39590207857) deployed it. The Worker deployment was created at 2026-10-21 13:13 (GMT+2).
- Mode: the deployed localization functions were run locally against the current R2 objects. `LIFECYCLE_LOCALIZATION` was absent and is still absent. No path was set to `shadow` or `on`. Cloudflare Access answered an unauthenticated status request with 302, so the deployed Worker was not asked to compare anything. The variable stays unset until an authenticated GET can capture the real header.
- Generation: `programme.json` and `watchlist.json` share one `updatedAt`, 2026-10-20 21:08:33 (GMT+2). `epg/published-generation.json` is absent, so the reader uses the public programme object. The read did not change the etags of `programme.json`, `watchlist.json`, `titles.json`, `people.json`, or `sync.json`. `sync.json` is `complete`, updated 2026-10-20 21:08:53 (GMT+2), and has no `lifecycleLocalization`. Worker schedules are empty. No sync was started.
- Fixture tests: `tests/titles.mjs` and `tests/names.mjs` passed locally against the private 2026-10-02 cloud fixtures. The dictionaries still have 413 titles and 868 names, and that watchlist had no untranslated name. The fixtures are not in this repository, so those two files stay outside `npm test`.

Predicted programme header, not a header returned by the Worker: `programme;shadow;films=398/1/0;people=7685/0/0;cache=0/0`.

- The offline off and shadow bodies match. The one film mismatch is alias order only: the same alias values, and the displayed title is unchanged. No alias was removed. No reviewed status was lost. There is no owner conflict and no unresolved conflict.
- People: 0 mismatched and 0 displayed, across 3296 distinct people. The people `compared` count includes each credit on a film and the programme people catalog. Cache is 0/0 because this reader does not compare `titles.json`. The title cache has 7 keys. A second domain pass did not change the domain result.

Predicted watchlist header, not a header returned by the Worker: `watchlist;shadow;films=398/0/0;people=4389/0/0;cache=0/0`.

- The offline off and shadow bodies match. There is no film, person, alias, reviewed, owner, or unresolved difference. A second domain pass was stable.

Metadata and EPG were not switched. There is no ordinary sync to observe.

An EPG dry replay, not a production sync and not a flag change, ran `applyEpgLocalization` on the current watchlist and `people.json`. It did not call Wikidata and it did not write R2. The predicted counts were films 398/0/0, people 4389/4348/857, and cache 0/0. The 857 displayed differences are 808 distinct people. In every case the legacy EPG assignment copies a Latin cache name and the guard keeps the Cyrillic dictionary name. The current GET reader, applied to both results, leaves 0 displayed name differences. A later live shadow would keep the legacy write. `on` would persist the dictionary names inside the normal sync write. That stored difference needs its own review before any EPG path is activated. It is not a current user-visible change.

No lifecycle sidecar was written. No film was waiting on a new Wikidata title fetch.

Decision: the live shadow rollout is not done. Stop before `shadow` on the Worker and before `on`.

Rollback of this checkpoint is to leave `LIFECYCLE_LOCALIZATION` unset. If a later step sets it, delete that Worker binding. An empty value is also off. Do not commit the variable in `wrangler.jsonc`. Merging this document does not change the Worker.

Next, still with no path set to `on`: use an authenticated Cloudflare Access GET against the existing production Worker, without publishing a credential. Capture the off baseline for the same EPG generation, then set only `shadow:programme`. Confirm the actual `X-Lifecycle-Localization` header, a JSON body equal to that baseline, and no GET writes. If that check cannot be read back, set the path back to off. Repeat for `shadow:watchlist` alone. Do not start a sync, and do not set `shadow:metadata` or `shadow:epg`, as part of that trial. The 808 cache-versus-dictionary names stay a separate review before either of those paths is activated.

Only after that live shadow is recorded, and only with a fresh baseline if the programme etag has changed, turn one path to `on` at a time:

1. `on:programme`. Displayed titles should stay. The one alias-order difference becomes part of the response. People should stay equal.
2. `on:watchlist`. The response should stay equal to off.
3. `on:metadata` only while observing a real sync. Do not start a sync only for this check.
4. `on:epg` only after the 808 cache-versus-dictionary names are accepted, and only on a real sync.

On a regression, set that path back to off.

### 2026-10-21 live GET shadow

Authenticated Cloudflare Access reads of production. No path is `on`. No sync was started. `shadow:metadata` and `shadow:epg` were not set.

- Date: 2026-10-21 23:14 (GMT+2). The Worker code is current `main`, including localization from `a908e681cad1f4164d6c069b82c3c39674dbddb6` (PR #30). The flag is a production secret and is not in `wrangler.jsonc`. The watchlist value deployed as `1ddc6a2a-a824-41e1-b4ec-77ed345cf4a4` at 2026-10-21 23:14:32 (GMT+2), source `dash`.
- Generation: programme and watchlist `updatedAt` 2026-10-21 17:05:51 (GMT+2), 398 films. `epg/published-generation.json` is present and published. This is a later generation than the checkpoint above, so the predicted programme mismatch of 1 does not apply. The live mismatch count is 0.
- Off baseline, with the variable absent: no `X-Lifecycle-Localization` header. Programme SHA-256 `dc469c2488e26b1e5e0b60f6904185f4fce1da5b6601478f74e81b47d08cb567`. Watchlist SHA-256 `648da957636430ef4732ddc02e50162d6cd9183b19bc7d59b675a54b248abb3d`. Two programme reads matched.
- `shadow:programme` only. Observed header: `programme;shadow;films=398/0/0;people=7685/0/0;cache=0/0`. The JSON body matched the off baseline. A second read was the same. Watchlist had no header and the same hash. `sync.json` has no `lifecycleLocalization`.
- Then `shadow:watchlist` only, which returns programme to off. Observed header: `watchlist;shadow;films=398/0/0;people=4389/0/0;cache=0/0`. The JSON body matched the off baseline. A second read was the same. Programme had no header and the same hash.
- Displayed title and name changes: 0 on both paths. Mismatched: 0. Cache stayed 0/0 because these reads do not compare `titles.json`.
- The GETs did not change the etags of `programme.json`, `watchlist.json`, `titles.json`, `people.json`, `sync.json`, `epg/published-generation.json`, or the published generation programme object. The R2 bucket binding, the existing plain-text variables, and the existing TMDB secret stayed in place.

Decision: leave production at `shadow:watchlist` only. Programme, metadata, and EPG stay off. Do not set `on` from this entry. The 808 cache-versus-dictionary names in the checkpoint stay a separate review before `shadow:metadata`, `shadow:epg`, or any `on` path. On this generation, `on:programme` is not expected to change the JSON body either: the live shadow found no alias-order mismatch.

Rollback: delete the `LIFECYCLE_LOCALIZATION` secret. An empty value is also off. Do not commit the variable. Merging this document does not change the Worker.

### 2026-10-22 read paths on

Authenticated Cloudflare Access reads. No sync was started. `metadata` and `epg` were not set. This entry follows the live shadow above; it does not rewrite that entry.

- `on:programme` was set on 2026-10-21 23:45:34 (GMT+2), deployment `c7016c92-4b3d-411a-a5bb-0ceac868d59f`, source `dash`. Before adding watchlist it was read again on 2026-10-22: `programme;on;films=398/0/0;people=7685/0/0;cache=7/0`. Watchlist had no `X-Lifecycle-Localization` header.
- Watchlist was added on 2026-10-22 09:48:28 (GMT+2), deployment `ec8a28c1-9349-4d8f-9d4c-353d0b944399`, source `dash`. The value keeps `on:programme` and adds `on:watchlist`. Worker code stayed `f14badfb172e6d314cff53583609e515c30ec749`, the merge of PR #36, already deployed that morning as `91e2163a-cd24-457b-92b2-f8922f1e9a90`. `keep_vars` remains true, and the variable stays out of `wrangler.jsonc`.
- Generation: `b8d147fd-d8ce-4fc2-ae08-5f1d2d468964`, phase `published`. Programme and watchlist `updatedAt` 2026-10-21 17:05:51 (GMT+2), 398 films. This is the same generation as the live shadow. `sync.json` is `complete`, updated 2026-10-21 17:07:17 (GMT+2), and has no `lifecycleLocalization`. The resolver continuation is paused.
- Baseline and result SHA-256, both reads: programme `dc469c2488e26b1e5e0b60f6904185f4fce1da5b6601478f74e81b47d08cb567`, watchlist `648da957636430ef4732ddc02e50162d6cd9183b19bc7d59b675a54b248abb3d`. A second pair of reads matched the first.
- After the switch the headers were `programme;on;films=398/0/0;people=7685/0/0;cache=7/0` and `watchlist;on;films=398/0/0;people=4389/0/0;cache=7/0`. Mismatched and displayed are 0 on both paths. All 398 films kept an id and their aliases, 14144 alias values in total. Title status stayed 393 verified and 5 provisional. Embedded name status stayed 877 verified, 4 provisional, and 3508 without a status field. The cache compared count is 7 because `on` counts keys in `titles.json`; mismatched stays 0, and the JSON body is unchanged.
- The GETs did not change the etags of `programme.json` (`a51413331b706515c757a92da9064ee5`), `watchlist.json` (`f1c50695d8bba9f467f2d59e2b7b3f97`), `sync.json` (`be025a257b59b951e153c78b3fc2470a`), `titles.json` (`60062e5fc0d022384324b742aeadfbe9`), `people.json` (`9b8491e23e6e4914eac7ce23c6515b05`), or `epg/published-generation.json` (`be3d3a3e7519016a58ca95b108cb6d04`).

Decision: accept `on:watchlist` together with the already accepted `on:programme`. Leave both on. Do not set `on:metadata` or `on:epg` from this entry. The 808 cache-versus-dictionary names remain a separate review before any EPG path, and they are not Film or TMDB identity collisions.

Rollback of watchlist alone is to set the secret back to `on:programme`. Deleting the binding turns every path off. Do not commit the variable. Merging this document does not change the Worker.

### 2026-10-22 plain text binding

The accepted value stayed `on:programme,on:watchlist`. Only its type changed, from a secret to text. No other binding was edited. No sync was started. `metadata` and `epg` stayed off. This entry follows the read-path rollout above; it does not rewrite that entry.

- GitHub Actions run [39743931492](https://github.com/vladimino/iptv-watchlist/actions/runs/39743931492) finished successfully, including the Cloudflare deploy of `3f3721fbfbdaf6586a4c140f87224e97fadcf2c7` (PR #38) as deployment `412bf4bf-7623-4f75-a1f4-9f5ee336deae` at 2026-10-22 09:56:30 (GMT+2). The type change waited until that deploy finished.
- The text binding deployed as `ee014d41-3b2f-4a51-bb7a-15b4c36fbc68` at 2026-10-22 10:01:23 (GMT+2), source `dash`. Settings read-back: type `plain_text`, text exactly `on:programme,on:watchlist`. The other six bindings kept their names and types: the R2 bucket, the existing plain-text variables, and the TMDB secret. `keep_vars` remains true, and the variable stays out of `wrangler.jsonc`.
- Generation unchanged: `b8d147fd-d8ce-4fc2-ae08-5f1d2d468964`, programme and watchlist `updatedAt` 2026-10-21 17:05:51 (GMT+2), 398 films. Two authenticated reads of each path matched. Programme header `programme;on;films=398/0/0;people=7685/0/0;cache=7/0`, SHA-256 `dc469c2488e26b1e5e0b60f6904185f4fce1da5b6601478f74e81b47d08cb567`. Watchlist header `watchlist;on;films=398/0/0;people=4389/0/0;cache=7/0`, SHA-256 `648da957636430ef4732ddc02e50162d6cd9183b19bc7d59b675a54b248abb3d`.
- The GETs did not change the etags of `programme.json` (`a51413331b706515c757a92da9064ee5`), `watchlist.json` (`f1c50695d8bba9f467f2d59e2b7b3f97`), `sync.json` (`be025a257b59b951e153c78b3fc2470a`), `titles.json` (`60062e5fc0d022384324b742aeadfbe9`), `people.json` (`9b8491e23e6e4914eac7ce23c6515b05`), or `epg/published-generation.json` (`be3d3a3e7519016a58ca95b108cb6d04`). The unchanged `sync.json` etag is the check that sync did not start.

Decision: leave `on:programme` and `on:watchlist` on, now as a text variable. Do not set `on:metadata` or `on:epg` from this entry. The 808 cache-versus-dictionary names remain a separate review before any EPG path.

Rollback of the type is one configuration deployment that restores a secret with the same name and the exact value `on:programme,on:watchlist`. The current text binding already keeps both read paths on, so it stays unless that type rollback is required. Do not delete the binding in an intermediate deployment: that turns both paths off. Do not commit the variable. Merging this document does not change the Worker.

### 2026-10-22 EPG write-path review

This entry follows the plain-text binding above. It does not rewrite the offline checkpoint, the live shadow, the read-path rollout, or the type change. No sync was started. The text binding stayed `on:programme,on:watchlist`. `metadata` and `epg` were not set, and `SCORED_RESOLUTION` was not set.

The offline checkpoint says the 857 displayed differences are 808 people and that, in every case, the legacy EPG assignment copies a Latin cache name while the guard keeps the Cyrillic dictionary name. That cache sentence is wrong. The correction below is a new measurement of the same EPG generation, not a different catalogue: programme and watchlist `updatedAt` 2026-10-21 17:05:51 (GMT+2), generation `b8d147fd-d8ce-4fc2-ae08-5f1d2d468964`, 398 films.

- 826 dictionary people are on this watchlist. 808 of them have a displayed-name difference. 802 have no `people.json` entry, and the stored name is the Latin original. Six have a Latin cache entry: five equal that original, and one is a different Latin spelling. 804 of the 808 are verified dictionary names and 4 are provisional. The other 18 already display the dictionary name through a Cyrillic cache entry. There is no Cyrillic-versus-Cyrillic difference, and none of the differences disappear after normalization.
- `applyEpgLocalization` was compared for `off`, `shadow`, and `on` on that snapshot. `off` copies a cache name when one exists and otherwise leaves the stored name. `shadow` restores that same body. `on` applies the dictionary. The result is 822 verified and 4 provisional: the 804 verified differences stay verified, the 4 provisional stay provisional, and the 18 already-matching people stay verified. Displayed names change for 808 people and 857 credit slots. That 857 belongs to this generation. A later generation is judged by unexplained or unsafe changes, not by repeating it.
- No stored alias was dropped. Where the displayed name changes, the Latin original and the previous stored name stay in aliases. No name conflict was added. No owner-protected name was overwritten: this snapshot has no `nameAuthority`. Names that were already stored as verified did not change. No stored source was cleared. Repeating `on` left the film JSON unchanged, so aliases, conflicts, and statuses do not grow. `applyEpgLocalization` does not mutate `people.json`.
- 393 watchlist films match the title dictionary. All 393 are already verified. Legacy and domain title application produce the same film object: no displayed-title change, no alias loss, no title conflict, and no change to id, TMDB id, URL, original title, year, or the other stored film fields. Repeating the domain title apply stays equal. The other 5 films are provisional and are not in the title dictionary, so `applyReviewedTitle` does not rewrite them. No film has `titleAuthority`. No film object carries a fingerprint or a prediction history, and `applyEpgLocalization` does not read or write those records.
- This snapshot has no `nameStatus` of `reviewed` and no owner authority, so there is no owner-protected value to overwrite. A fixture of the same functions keeps an owner-protected verified name and title, records one conflict, and does not add a second conflict on the next pass. A stored status of exactly `reviewed` is not that protection: a verified dictionary entry replaces it. That status is absent here, and `shadow` restores the legacy body rather than persisting the domain result.

`shadow:epg` does not make a sync read-only. It counts the localization difference and then stores the legacy body. The rest of an ordinary sync still runs. The table below separates that ordinary work from the localization write, which happens only if `epg` is later set to `on`. This entry does not set it.

| Object | Localization, only if `epg` is `on` | Ordinary sync, including `off` and `shadow` |
| --- | --- | --- |
| `watchlist.json` | Dictionary person names, `nameStatus`, `nameVerificationBasis`, `nameSource`, and aliases are stored on the film credits. The 18 already-matching names stay. Reviewed film titles do not change on this snapshot, because legacy and domain title application match. Film ids, TMDB ids, and the other identity fields stay. | `updatedAt` and the post-localization watchlist are saved. `finishSync` does not overwrite that watchlist when `updatedAt` already matches the report. |
| `programme.json` | Person names on the saved films come from the localized watchlist copy. | A matched programme can still replace the film title with the EPG title. Show lists, stats, and `updatedAt` change with the new EPG. |
| `people.json` | Not written by `applyEpgLocalization`. | `localizeByLetterboxd` writes entries for people who are neither in the dictionary nor already cached. It does not fill the 802 dictionary gaps. |
| `titles.json` | On this snapshot the reviewed film titles already match, so the film-object application does not differ by mode. | `localizeFilmTitles` may fetch Wikidata and add cache keys before the mode branch. Those new keys remain for `off`, `shadow`, and `on`. |
| `sync.json`, events, `uncertain.json`, discovery generation, prediction queue | No separate localization object. | The sync writes its stage, events, uncertain matches, the published EPG generation, and a refreshed prediction queue. The queue refresh does not rewrite fingerprint or prediction files. |

Decision: `shadow:epg` can be added on the next ordinary sync. Do not start a special sync for it. Do not set `on:metadata` or `on:epg` from this entry. Leave the text binding at `on:programme,on:watchlist` until that ordinary sync. Do not commit the variable. Merging this document does not change the Worker.

Rollback of a future `shadow:epg` token is to remove that token and leave `on:programme,on:watchlist`. Deleting the binding turns every path off.

### 2026-10-22 EPG shadow enabled

This entry follows the write-path review above. It does not rewrite that review. The text binding now includes `shadow:epg`. `on:metadata` and `on:epg` were not set. `SCORED_RESOLUTION` was not set. No sync was started. The rollout is not accepted: `shadow:epg` runs only inside an ordinary EPG sync, and that sync has not happened.

- Preflight matched the deployed `main` `4fdb108983b4522d06daad6498a85813febb6450`. GitHub Actions run [39756109685](https://github.com/vladimino/iptv-watchlist/actions/runs/39756109685) had finished, including the Cloudflare deploy of PR #41 as `ea4aaa56-a04a-46b3-b632-08b1489a79f4` at 2026-10-22 11:32:52 (GMT+2), source `wrangler`. No newer deployment was present. The binding was still `plain_text` with the exact text `on:programme,on:watchlist`. The other six bindings kept their names and types.
- `sync.json` was `complete`, updated 2026-10-21 17:07:17 (GMT+2), remaining 0, with no error and no `lifecycleLocalization`. Generation `b8d147fd-d8ce-4fc2-ae08-5f1d2d468964` stayed `published`. Programme and watchlist `updatedAt` 2026-10-21 17:05:51 (GMT+2), 398 films.
- Authenticated reads before the switch: programme `programme;on;films=398/0/0;people=7685/0/0;cache=7/0`, SHA-256 `dc469c2488e26b1e5e0b60f6904185f4fce1da5b6601478f74e81b47d08cb567`. Watchlist `watchlist;on;films=398/0/0;people=4389/0/0;cache=7/0`, SHA-256 `648da957636430ef4732ddc02e50162d6cd9183b19bc7d59b675a54b248abb3d`.
- The text value became `on:programme,on:watchlist,shadow:epg` at 2026-10-22 12:33:00 (GMT+2), deployment `917bcd32-f824-4c7a-b618-26992917fef7`, source `dash`. Settings read-back: type `plain_text`, that exact text. `keep_vars` remains true, and the variable stays out of `wrangler.jsonc`.
- The same two reads after the switch kept those headers and SHA-256 values. The six control etags were unchanged: `programme.json` `a51413331b706515c757a92da9064ee5`, `watchlist.json` `f1c50695d8bba9f467f2d59e2b7b3f97`, `titles.json` `60062e5fc0d022384324b742aeadfbe9`, `people.json` `9b8491e23e6e4914eac7ce23c6515b05`, `sync.json` `be025a257b59b951e153c78b3fc2470a`, `epg/published-generation.json` `be3d3a3e7519016a58ca95b108cb6d04`. `sync.json` still has no `lifecycleLocalization`. The switch did not start a sync and did not write R2.
- The GET headers confirm the read modes. They do not show that `shadow:epg` has run.

Decision: leave `shadow:epg` on and wait for the next ordinary sync. Do not start a special sync. Do not call this rollout accepted until that sync records `lifecycleLocalization.epg` with mode `shadow` for the generation it actually processed, and the stored watchlist still matches the legacy path. Do not set `on:metadata` or `on:epg` from this entry. Before `on:epg`, add a regression test for a stored `nameStatus` of `reviewed` with `nameAuthority` `owner`; if that status is overwritten, fix it separately. Do not commit the variable. Merging this document does not change the Worker.

Rollback of `shadow:epg` is to set the text back to `on:programme,on:watchlist`. Do not delete the binding, and do not turn the two accepted read paths off. A flag rollback does not undo ordinary writes of a sync that has already finished. Do not restore an older EPG generation from this entry.
