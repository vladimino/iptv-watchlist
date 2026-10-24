# Admin Film/Person read contract

**Role:** maintained contract for the owner admin shell. It records what the current source can already answer and what [AIR-123](https://trello.com/c/uatDiouD), [AIR-52](https://trello.com/c/siWtiRcm), and [AIR-124](https://trello.com/c/Xotv4r2f) must not invent. The read paths were checked against source on GitHub `main` `8596d2f` (24 October 2026). Authority and access statements follow [ADR 0002](../../adr/0002-cloudflare-worker-r2-authority.md) and [ADR 0004](../../adr/0004-mcp-access-boundary.md), recorded in `d4c50e3`. This audit did **not** call production, list R2, or open a GET that can write.

Related work: [AIR-122](https://trello.com/c/MouyDTjX), [AIR-69](https://trello.com/c/FlcWZX7W), [Film/Person contract](film-person.md), [D1 schema](../data/d1-schema.md). Upstream admin cards [AIR-53](https://trello.com/c/gkuy1awG), [AIR-54](https://trello.com/c/yKtj1ahy), and [AIR-65](https://trello.com/c/MKb4JMXi) stay writers and are out of this read contract.

## Access

The site is personal. Cloudflare Access Zero Trust is the only authentication boundary, and its policy already admits the owner. `/admin` does not get a second login, an owner-role middleware, or an anonymous exception.

- Keep the existing Access application in front of the Worker hostname. Do not add an Access bypass, a service token for the browser, or a public `/admin` route.
- A static `/admin` page is covered by that same application. Shipping the page does not by itself authorize a new API.
- `/mcp` stays the separate Access application `IPTV MCP` from [ADR 0004](../../adr/0004-mcp-access-boundary.md). Admin search must not call MCP write tools (`epg_sync_start`, `epg_sync_step`, `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, `prediction_complete`).
- Do not put an admin token, a Letterboxd URL, or an R2 key in the page or in fixtures.

## What can be read without a model or a recompute

`filmView` and `personView` in `src/domain/film-person.js` are pure. Given facts the caller already loaded, they return the fields below. They do not fetch TMDB, score a candidate, or call a model. `readLifecycle` in `src/domain/film-person-reader.js` only projects records the caller already placed in memory.

A Film projection can already expose:

| Field | Source on the projection | Not included |
| --- | --- | --- |
| `id` (`film:…`), `canonicalIdentity` (`tmdb:<id>` or null) | Derived from Letterboxd id, trusted TMDB id, or a conflict id | Storage id (`lid`, `tmdb_<id>`) is separate; the reader keeps it as `storedId` on the lifecycle body |
| `externalIds[]` | `scheme`, `value`, `trusted`, `conflicting`, `provenance` | A trusted TMDB id is set only when identity is `resolved` and there is a single id |
| `aliases[]` | `kind: title`, `value`, `provenance.source` (`letterboxd`, `epg`, and later merges) | Alias text is not a reviewed title |
| `originalTitle`, `epgTitle` | Facts already on the record | |
| `localization` | `status` `missing` / `provisional` / `reviewed`, `value`, dimension envelope | The envelope is not the full title dictionary |
| `localizationConflicts[]` | Held automatic overwrites | |
| `identity` | `unresolved` / `resolving` / `resolved` / `ambiguous` / `rejected` plus `provenance`, `nextAction`, errors, `retryAt` | An accepted score is not itself `resolved` |
| `metadata` | `missing` / `fetching` / `partial` / `fresh` / `stale` / `failed` | Synopsis, year, runtime, and genres stay on the raw programme/metadata record, not inside the status envelope |
| `fingerprint`, `prediction` | `missing` / `generating` / `current` / `stale` / `failed` | The fingerprint and prediction payloads stay in `enrichment/films/<id>/` |
| `predictionHistory` | Only if the caller passed the stored history | |
| `redirects` | Empty on a fresh `filmView`; filled when `linkFilms` already ran | |
| `availability` | Only after `attachAvailability` | Shows are not part of `filmView` itself |

`displayReady`, `catalogReady`, and `predictionReady` are derived booleans. They are not stored statuses.

A Person projection can already expose `id` (`person:<role id>`), `roleId`, `original`, `aliases` (`kind: name` from Letterboxd, the dictionary, or the Wikidata cache), `externalIds` (`scheme: letterboxd-role`), `localization`, and an identity whose provenance says `dedupe: deferred`. The same human under two role ids is two Person records. There is no stored duplicate cluster to read.

`createCanonicalRepository` can `readFilm` and `readPerson` by id from a caller-supplied database. That row adds credits, a watchlist flag, metadata columns (`year`, `runtime`, `synopsis`, `poster`, `genres`, `r2Key`, `contentSha256`), and redirect resolution. The Worker bundle does not import this module. Production has no D1 read path. `migrations/0001_schema_v1.sql` is frozen and has no alias-value index: `film_alias` is keyed by `(film_id, kind, value)`, so a value search would scan the table. Do not plan admin search as SQL against that schema.

Quality is not a stored queue. These classes are filters over the projection the caller already has:

| Queue code | Rule on the supplied projection |
| --- | --- |
| `localization-missing` | `localization.status === 'missing'` |
| `localization-provisional` | `localization.status === 'provisional'` |
| `localization-conflict` | `localizationConflicts.length > 0` |
| `identity-unresolved` | `identity.status === 'unresolved'` |
| `identity-ambiguous` | `identity.status === 'ambiguous'` |
| `identity-rejected` | `identity.status === 'rejected'` |
| `metadata-missing` | `metadata.status === 'missing'` |
| `metadata-stale` | `metadata.status === 'stale'` |
| `metadata-failed` | `metadata.status === 'failed'` |
| `fingerprint-not-current` | Film only, `fingerprint.status !== 'current'` |
| `prediction-not-current` | Film only, `prediction.status !== 'current'` |
| `external-id-conflict` | Any `externalIds[]` item with `conflicting: true` |

Person queues stop at localization and external-id conflict. Do not add a dedupe queue. `identity.status === 'resolving'` is not a quality defect by itself.

## Authority, projections, and snapshot consistency

Production authority is Cloudflare R2 for Worker `iptv`, as [ADR 0002](../../adr/0002-cloudflare-worker-r2-authority.md) records. D1 adapters and the lifecycle sidecar are not that authority. ADR 0002 does not make D1 authoritative.

| Object | Role | Consistency |
| --- | --- | --- |
| `programme.json` | Published programme the public UI reads | Replaced at EPG commit together with the generation copies of `discovery-latest.json` and `discovered-films.json` |
| `epg/published-generation.json` | Pointer to that generation | A new pointer does not prove the scored resolver finished that generation |
| `watchlist.json` | Watchlist films without shows | `GET /api/watchlist` may **return** programme films when `updatedAt` differs; it does not write that substitution back |
| `titles.json`, `people.json` | Localization caches updated during metadata and EPG steps | Not inside the EPG generation object. Their `updatedAt` can disagree with `programme.json` |
| `metadata.json` | Letterboxd metadata cache | Separate from the programme pin |
| `epg/discovery-latest.json`, `epg/discovery-resolution.json` | Observation ledger and decisions | Hot path of the resolver AIR-69 is watching. Not an admin catalog |
| `epg/discovered-films.json` | Verified discovered catalog | Generation-pinned shows. Still not a search index |
| `epg/resolver-lease.json`, `epg/resolver-continuation.json` | In-flight resolver coordination | Do not read these on an admin page load |
| `enrichment/films/<id>/fingerprint.json`, `predictions.json` | Per-film prediction state | Point reads exist for diagnostics. Listing the prefix is a scan |
| `enrichment/view-index.json`, `enrichment/prediction-queue.json` | Dashboard and queue projections | Not Film identity |
| Lifecycle `*.lifecycle.json` sidecars | Computed by `readLifecycle` | Forbidden from replacing `discovery-latest` or predictions. Nothing in the Worker writes them on a GET |
| D1 `film` / `person` tables | Offline and future migration | Empty of production authority until a separate cutover |

One admin response must name its pin. [ADR 0008](../../adr/0008-atomic-epg-publication.md) makes the published generation the coherent EPG snapshot: programme, discovery-latest, and discovered-films for that generation. Titles and people are a second clock, outside that object. A response that mixes them must set `skew: true` rather than imply one snapshot. [ADR 0007](../../adr/0007-persistent-discovery-evidence.md) keeps the resolution ledger as candidate evidence, not canonical Film. An unresolved observation is not a Film row. Those rows are a third set and are not part of `programme.json`.

## GET side effects and safe reads

`tests/get-side-effects.mjs` allows exactly four GET routes to write R2:

| Route | Why it can write | Admin use |
| --- | --- | --- |
| `GET /api/events` | Recovers an undelivered stop event, then may list `events/items/` | Do not call |
| `GET /api/enrichment/view` | Can initialize a missing rating in the view index | Do not call |
| `GET /api/enrichment/status` | Same stop-event recovery | Do not call. MCP `enrichment_status` calls this route |
| `GET /api/enrichment/runs` | Writes diagnostic history | Do not call |

These GETs do not write, and they still are not an admin query:

- `GET /api/programme` and `GET /api/watchlist` load a few known keys and localize in memory. Safe to read, too coarse for quality queues, and they return the public catalogue shape rather than `filmView`.
- `GET /api/status`, `GET /api/integrations/tmdb/status`, `GET /api/ui/filter-presets`, `GET /api/enrichment/schema`, `GET /api/enrichment/profile`, `GET /api/enrichment/runner`, `GET /api/enrichment/queue/status`, `GET /api/enrichment/footer/status`, `GET /api/enrichment/pipeline/status`, `GET /api/enrichment/discovery/status`, `GET /api/enrichment/moods/diagnostics`, and the frozen diagnostic snapshot/accuracy GETs are status reads. They do not search Film or Person.
- `GET /api/started` lists the entire `started/` prefix. It does not write, and it is not bounded by a cursor. Do not copy that pattern.
- `GET /api/enrichment/diagnostics/export` does not write. `group=global` reads a fixed key list that includes `programme.json` and `epg/discovered-films.json`. `group=films` lists `enrichment/films/` 24 keys at a time. That is a prefix scan, not a search index. Admin search must not use it.
- MCP reads that stay off the write tools: `probe_read`, `probe_echo`, `epg_status`, `epg_pipeline_status`, `enrichment_schema`, `enrichment_profile`, `enrichment_runner`, `enrichment_queue`, `prediction_queue_overview`, `prediction_film_diagnostics` (one stored film id), `prediction_pending` (one page of queue ids, limit 1–20). None of them is a Film/Person text search. `prediction_pending` is the pagination shape to copy: a pinned snapshot, an opaque cursor, and no storage list.

There is no `/api/admin` route and no in-Worker call to `readLifecycle`.

## Search without a full R2 scan

`env.BUCKET.list` without a tight prefix walks the bucket. Admin must not do that, and must not list `enrichment/films/`, `events/items/`, or `started/` to build a catalogue.

What is already one object, not a scan:

- `programme.json` holds the films and embedded directors/actors the public UI searches in the browser.
- `titles.json` and `people.json` are single objects.
- `metadata.json` and `watchlist.json` are single objects.

What is not safe to project on every admin open:

- `readLifecycle` walks programme films, discovered films, and **every** resolution entry. The resolution ledger is the resolver's working set. Loading it per keystroke also reads the object [AIR-69](https://trello.com/c/FlcWZX7W) is observing. Do not put that walk on a request path during AIR-69.
- A D1 `LIKE` or scan of `film_alias` is unavailable: the table is not in production, and the frozen schema cannot serve "alias contains text" without a new migration.

The bounded design is:

1. **AIR-123** searches and classifies arrays the caller already holds. No I/O.
2. **AIR-52** feeds those functions from a fixture module. No I/O.
3. **AIR-124**, only after AIR-69, may load the pinned `programme.json`, `titles.json`, and `people.json` (three known keys, plus the published-generation pointer) once per snapshot, project the programme films and embedded people, and run the AIR-123 functions in memory. Repeat page requests reuse that pin. They do not list the bucket.
4. Quality rows that exist only on the discovery ledger (an unresolved observation with no programme film) need a **generation-scoped index object written at EPG publish**, not a GET. That writer is a separate change. It is not part of AIR-123, AIR-52, or the first AIR-124 slice, and it must not land while AIR-69 is watching the publish path.

## Offline now, live later

| Work | Now | After AIR-69 |
| --- | --- | --- |
| [AIR-123](https://trello.com/c/uatDiouD) pure query | Yes. Storage-neutral functions and deterministic tests | Unchanged library |
| [AIR-52](https://trello.com/c/siWtiRcm) `/admin` shell | Yes, fixture adapter only | Still no live fetch until AIR-124 is separately accepted |
| Point read of one prediction via existing MCP `prediction_film_diagnostics` | Already shipped for prediction diagnosis. Not the admin page | Still not a catalog search |
| [AIR-124](https://trello.com/c/Xotv4r2f) programme-snapshot search | No | Yes, behind the checks below, and only with a separate acceptance |
| Ledger-wide candidate queues and a publish-time admin index | No | Only as its own card after AIR-69. Not implied by AIR-124's first slice |
| D1 `readFilm` / `readPerson` as the admin source | No | Only after the D1 cutover that makes those tables authoritative. AIR-69 finishing does not do that |
| Reviewed-title and reviewed-name writes ([AIR-53](https://trello.com/c/gkuy1awG), [AIR-54](https://trello.com/c/yKtj1ahy)) | No | Those cards stay behind AIR-69 and the storage gate. This contract does not add them |

## AIR-123 query contract

Implement a storage-neutral module. It accepts records and returns pages. It must not import the Worker, the R2 SDK, `fetch`, or the domain reader. Callers may build records with `filmView` / `personView` in their own tests; the query module itself stays pure.

Film record fields the functions read: `id`, `preferred` (localized value or null), `originalTitle`, `epgTitle`, `aliases[]`, `externalIds[]`, `identity`, `metadata`, `localization`, `fingerprint`, `prediction`, `localizationConflicts`, and optional `storedId`. Person record fields: `id`, `roleId`, `preferred`, `original`, `aliases[]`, `externalIds[]`, `localization`, `localizationConflicts`. Ignore unknown fields. Do not require synopsis, shows, or prediction payloads.

```text
searchFilms(records, { query, limit, cursor }) -> { pin: null, items, nextCursor }
searchPeople(records, { query, limit, cursor }) -> { pin: null, items, nextCursor }
filmQueue(records, { queue, limit, cursor }) -> { pin: null, items, nextCursor }
personQueue(records, { queue, limit, cursor }) -> { pin: null, items, nextCursor }
getFilm(records, id) -> record | null
getPerson(records, id) -> record | null
```

- `pin` is always `null` offline. AIR-124 fills it.
- `limit` is an integer 1–25. Missing `limit` is an error the caller can surface as 400. Default inside the UI adapter may be 25, but the function does not silently substitute a default that hides a bad call.
- `cursor` is opaque. It is valid only for the same records array, the same query or queue, and the same limit. A mismatched cursor returns an error result `{ error: 'stale_cursor' }`, not an empty page.
- Sort a search by rank, then `id` ascending with `en` comparison. Ranks: `0` exact external id, `1` exact preferred, `2` exact original or alias, `3` prefix of any of those, `4` substring. Tokens of a multi-word query are AND. Fold Latin diacritics, map `ё`/`Ё` to `е`, and compare case-insensitively. Do not score synopsis.
- Two records with the same folded preferred title are both returned. Each item includes `collision: true` when another item on the full result, not only the page, shares that folded title. Do not merge them. This flag is a search result, not the identity collision in [ADR 0009](../../adr/0009-canonical-film-person-identity.md). It does not authorize linking films or unifying two Person role ids.
- `filmQueue` accepts every code in the table above. `personQueue` accepts only `localization-missing`, `localization-provisional`, `localization-conflict`, and `external-id-conflict`. Any other code is `{ error: 'unknown_queue' }`.
- `getFilm` / `getPerson` follow no redirects. Redirects are data on the record, not a hidden hop.
- Items are the supplied records plus `rank` and `collision` on searches. Do not drop fields and do not add a model score.

Tests must cover empty query (error, not "all records"), empty records, the rank order, Cyrillic `ё`, a collision, every queue code, a stale cursor, and a limit outside 1–25. No network.

## AIR-52 fixture boundary

The shell is a local `/admin` page. Its only data import is a fixture module that calls the AIR-123 functions. The production bundle of that page must not call `fetch`, must not reference `/api/`, and must not read `programme.json`.

The fixture is synthetic. Do not paste a production watchlist, a private snapshot, or the AIR-86 cohort. Include at least:

- one Film with `localization.status: 'reviewed'` and a second title alias;
- one Film with `localization.status: 'provisional'`;
- one Film with `identity.status: 'ambiguous'` and `external-id-conflict`;
- one Person with an original name and an alias;
- a query that matches nothing;
- two Films that collide on the folded preferred title;
- an adapter-level error state the page can open without a failed request, for example a fixture flag `?error=unavailable`.

The page shows search, an entity summary (id, preferred title or name, identity status, localization status, external ids, alias provenance), the quality queues, and deep links of the form `/admin?q=&kind=film&id=&queue=`. Empty, loading, and error states are visible. Loading is local only: the fixture returns on the same turn, or the page may show the loading state in a test harness. There is no background refresh.

Keyboard: the search field, queue controls, and results are reachable in order; Escape clears the query. Desktop width about 1280 px and a 390 px mobile width are both required screenshots, attached to the AIR-52 PR and not committed. The public movie UI is unchanged.

Deploying the static page is allowed only while the data module stays the fixture. Adding a live client in that PR is a failure of this boundary even if the route is unused.

## AIR-124 live API requirements

Do not implement this section in AIR-123 or AIR-52. When it is implemented, it is a read-only adapter behind the existing Access application. It is off until a separate acceptance after AIR-69. Suggested routes, all `GET`:

- `/api/admin/films?q=&queue=&limit=&cursor=&pin=`
- `/api/admin/films/:id?pin=`
- `/api/admin/people?q=&queue=&limit=&cursor=&pin=`
- `/api/admin/people/:id?pin=`

The handler loads only `epg/published-generation.json`, `programme.json`, `titles.json`, and `people.json`. It builds AIR-123 records from that programme and those dictionaries, then calls the AIR-123 functions. It does not import a write path, does not call `recoverStopEvents`, and does not read the resolver lease, the continuation, the resolution ledger, or `discovery-latest.json`.

Performance:

- At most those four R2 gets for a cold snapshot. A warm isolate may reuse the snapshot while `programme.runId` is unchanged.
- No `BUCKET.list`. No per-result R2 get. No TMDB and no model call.
- `limit` 1–25, default 25. A larger limit is 400.
- The response body for a page stays a projection, not the raw programme object.

Snapshot pin, returned on every success:

```text
pin: { programmeRunId, programmeUpdatedAt, titlesUpdatedAt, peopleUpdatedAt, skew }
```

`skew` is true when the titles or people object time is newer than `programmeUpdatedAt`. The client sends `pin` back as the `pin` query parameter. If the stored programme run id differs, respond **409** `{ error: 'stale_pin' }` and do not return a mixed page.

Errors:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_limit` | `limit` is missing or not an integer 1–25 |
| 400 | `invalid_query` | `q` is present and blank, or longer than 200 characters |
| 400 | `unknown_queue` | `queue` is not in the table above |
| 400 | `stale_cursor` | Cursor was not minted for this pin, query, queue, and limit |
| 404 | `not_found` | Id is absent from the pinned programme snapshot |
| 409 | `stale_pin` | `pin` does not match the current programme run |
| 503 | `programme_unavailable` | `programme.json` is missing. Same idea as the public programme 503, without starting sync |

A 5xx from R2 is a failure of this read. The handler does not retry into a writer. The page shows the error state and does not fall back to the fixture.

`nextCursor` is null on the last page. The cursor encodes the pin id, the query or queue, the limit, and the last item id. It is not an R2 list cursor.

## Risks and checks before a live route is enabled

| Risk | What would go wrong | Check before enablement |
| --- | --- | --- |
| Writing GET | An admin poll repairs events or seeds a rating | The route is not one of the four writing GETs. A test fails if the handler calls `recoverStopEvents` or `enrichmentView` |
| Bucket scan | Opening `/admin` lists the bucket or `enrichment/films/` | The handler's R2 calls are the four known keys only. Assert no `list` |
| Resolver interference | A search reads the lease, continuation, or resolution ledger and is mistaken for AIR-69 activity | Those keys are absent from the handler. AIR-69 is closed or explicitly still excluded |
| Skew presented as one snapshot | Titles from a later sync appear as if they belonged to the pinned programme | Response has `skew`. A test uses a newer `titles.json` and expects `skew: true` |
| Stale page | Cursor from generation A is applied to generation B | 409 `stale_pin` or 400 `stale_cursor`, empty `items` |
| Anonymous admin | A new route is excluded from Access | No Access bypass. The route stays on the existing Worker hostname. No token in the client |
| Fixture leak | AIR-52 ships a `fetch('/api/admin/...')` | Bundle test: admin script contains neither `fetch` nor `/api/` |
| D1 mistaken for production | Admin reads an empty or stale SQLite | AIR-124 does not open D1. The contract says R2 programme snapshot |
| Schema edit | An alias index is added to frozen `0001` | No migration in the admin PRs |
| Publish-path change during AIR-69 | A new index object is written from EPG commit | Not in AIR-123, AIR-52, or the first AIR-124 slice |
| Private data in git | A fixture copies the live watchlist | Fixture ids and titles are synthetic. Review the fixture file |
| Model or TMDB on search | A miss triggers discovery | No `fetch` to TMDB and no discovery call in the handler |

Rollback of a later AIR-124 is revert of that route. It does not delete R2 objects, because the route must not have written any. Rollback of AIR-52 is revert of the static page.

## Compatibility with AIR-69

[AIR-69](https://trello.com/c/FlcWZX7W) is in progress. This audit did not re-read production. The latest owner checkpoint on that card (24 October 2026) says `SCORED_RESOLUTION` stayed `on`, schedules were 0, a published generation existed, and scored resolver activity for that generation was **not** confirmed. The card is not closed. Those statements are the card's checkpoint, not a new measurement.

That state is compatible with AIR-123 and AIR-52. Both are offline. They do not start sync, a resolver chunk, a prediction, or a migration, and they do not change flags or schedules.

That state is **not** compatible with turning on AIR-124 or with writing an admin index from EPG publish. Reasons:

- AIR-69's acceptance is two ordinary full EPG generations with resolver activity on each. A new reader of the resolution ledger, or a new object written at publish, changes the path being observed.
- The published pointer is not evidence the resolver finished. An admin page that treated the pointer as a complete Film catalog would over-claim.
- [ADR 0005](../../adr/0005-external-chatgpt-tasks.md) keeps unattended EPG and prediction on external ChatGPT Scheduled Tasks. `Worker schedules=0` on the AIR-69 checkpoint is the Worker setting only. It is not a reading of that external registry, and this contract must not add Worker cron or enable, disable, or trigger those tasks.
- Finishing AIR-69 still leaves R2 authoritative. It does not make D1 the admin source and does not authorize AIR-53 or AIR-54 writes.

AIR-124 may start only after AIR-69 is accepted **and** the checks in the risk table pass in that PR. Until then the admin UI shows fixture data only.
