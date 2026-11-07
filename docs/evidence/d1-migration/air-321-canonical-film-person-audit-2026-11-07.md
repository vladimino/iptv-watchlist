# AIR-321: code-backed audit of canonical Film/Person and a proposed decomposition

**Captured:** 2026-11-07 (UTC), on `main` at `357bf2d`. **Method:** read-only code reading (three independent passes: writers and keys, readers and consumers, neighbouring domains and ADRs). No production read or write, no network call, no schema or code change. Much of `src` is dense one-line JavaScript, so line numbers point at function or statement starts. **Status:** input for an owner decision; it authorizes nothing.

## Headline findings

1. **One writer.** The only code that creates or changes `film`, `person`, credits, aliases, external ids and redirects in D1 is the D1 enrichment projector (`src/d1-enrichment.js` through `src/canonical-repository.js`), driven by the hourly cron and gated by `D1_ENRICHMENT_WRITE` (`off|dry|on`). It reads R2 documents and the D1-resident inputs, derives rows with `LifecycleReader.readLifecycle`, and writes one fenced batch per Film. Two offline paths also write (the importer used by backfill and reload scripts, and the owner-run D1-only TMDB credits script). No Admin or owner-review code writes these tables.
2. **No request route reads the canonical tables for rendering.** `GET /api/programme`, `/api/watchlist`, `/api/catalog/available`, the film page and the admin routes read published programme documents (D1 publication authority since 3 November) and derive localization in memory from dictionaries, R2 `titles.json`/`people.json` and owner reviews. The canonical tables feed only `GET /api/d1/*` (`authoritative:false`, `catalog-d1.js`) and the Finds person filter.
3. **There is no canonical Film/Person authority marker.** Every cut-over domain has one (`published_epg_authority`, `owner_review_authority`, `ratings_domain_authority`, `discovery_authority`, `metadata_cache_authority`, `prediction_domain_authority`). Nothing equivalent exists here; `projection_run`/`projection_fence`/`projection_state` fence the projector's own writes only.
4. **The neighbours hold no foreign key to `film`/`person`.** Owner reviews, Discovery admission, ratings facts, the metadata cache and publication membership reference a Film by a string key (programme id, `tmdb_<n>`, Letterboxd alias, cache key). The link is derived (`identity_link` hint on an owner review, trusted external-id lookups).
5. **Person grouping is a derived read model** (ADR 0058/0059/0062): `canonicalPersons()` is pure, recomputed per request, with `owner_decisions_not_stored` and `role_links_not_stored`. Nothing about a human is persisted.

## Ownership matrix

| Record / key | Producer today (file) | Store today | Authority today | Reader(s) | Desired owner after cutover | Fence / CAS | Pending migration | Rollback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `film`, `film_external_id`, `film_alias`, `film_redirect`, identity dimension | projector (`canonical-repository.js` `writeFilm`, `planFilm`, `retireFilm`) | D1 | R2 sources, D1 follows (ADR 0056) | `/api/d1/*`, Finds person filter, owner-review `classify()` | D1 canonical writer under a marker | new marker + per-entity CAS (none today) | marker, fenced mutation API, baseline | marker back to `r2`, projector resumes |
| `person`, `person_external_id`, `person_alias`, identity dimension | projector (`writePerson`) | D1 | same | same | same | same | same | same |
| `film_person_credit` (R2-derived) | projector: delete all, reinsert, ordinals renumbered on every rewrite | D1 | R2 `metadata.json` (cache in D1 when `metadata_cache_authority` is `d1`) | `/api/d1/*` | D1, per-credit upsert keyed (film, person, role) | per-entity CAS | change from delete-reinsert to keyed upsert | marker |
| `film_person_credit` (TMDB, D1-only, AIR-286) | `scripts/tmdb-watchlist-credits.mjs` (owner-run, direct SQL) | D1 | D1 already | `/api/d1/*` | D1 (unchanged); must survive the new writer | per-credit keyed insert | none; keep ordinal rule | n/a |
| Film localization, automatic (`titles.json`) | `metadataSync`, `localizeFilmTitles` (`worker.js`) | R2 | R2 | programme/watchlist/admin read-time derivation | D1 localization dimension (decision needed) | per-entity CAS | producer + reader | marker |
| Person localization, automatic (`people.json`) | `metadataSync`, `localizeByLetterboxd` | R2 | R2 | admin read, programme read-time derivation | D1 localization dimension | same | same | marker |
| Film/Person localization, owner | Admin POST (`film-title-route.js`, `person-name-route.js`) via `OwnerReview.commit` | D1 `owner_review_entry` (mode `d1`) | **D1 already** (ADR 0081) | `OwnerReview.loadForRead`, overlay on `/api/d1/*` | unchanged; precedence preserved | `owner_review_cas`, `requestId` replay | none; keep `guardReviewed` and the read overlay | n/a |
| Verified rated-only Film admission (`letterboxd/admissions/verified-films.json`, key `tmdb_<n>`) | `letterboxd-rated-candidates.js` `writeAdmission` (R2 CAS) | R2 | R2 (ADR 0087/0090) | projector (`archiveAdmissions`), `retainedArchiveRecords` | D1 canonical writer admits the Film; the R2 object stays as an immutable source/receipt | etag CAS today; per-entity CAS after | producer rewiring | marker |
| Watchlist retention flag (`enrichment/view-index.json` boolean `watchlist`) | enrichment pipeline | R2 | R2 | projector `watchlistAdmissionsFromIndex`, `retainedWatchlistRecords` | D1 (AIR-191/ADR 0086 semantics) | per-entity | producer rewiring | marker |
| TMDB retirements (`identity/tmdb-retirements.json`) | owner runbook (writer function not found in `src`) | R2 | R2, owner-approved only | reader `applyTmdbRetirement` | D1 owner decision record, or stays an owner input (decision) | n/a | decide | marker |
| Discovery admission (`discovery_admission`, key `film_id`/`tmdb_<n>`, unique `(media_kind,tmdb_id)`) | `discovery-authority.js` | D1 | **D1 already** (ADR 0085) | catalog, projector via `routeRead` | unchanged; the canonical writer consumes it and creates `film:tmdb:<id>`; `tmdb` ≠ `tmdb_tv` | `discovery_authority` fence | writer consumes admissions | n/a |
| Published programme/watchlist membership (`published_epg_member`, `watchlist_film`) | EPG commit; `watchlist_film` written by the projector | D1 | **D1 already** (ADR 0079) for documents; `watchlist_film` projected | `/api/programme`, `/api/watchlist`, `/api/d1/*` | membership stays AIR-319's; canonical keeps only the link | `published_epg_authority` | none | n/a |
| Metadata cache (`metadata_cache`) | `metadataSync` | D1 | **D1 already** (ADR 0073) | projector (`useAuthoritativeMetadata`), `beginSync` | unchanged input | `metadata_cache_authority` | none | n/a |
| Ratings facts | `ratings-d1.js` | D1 | **D1 already** | `RatingsD1` | unchanged; link to canonical Film only by proven identity | `ratings_domain_authority` | none | n/a |
| Person grouping / filmography | derived (`canonicalPersons`, `projectPersonIdentity`) | none | derived | `catalog-d1.js` `d1PersonIdentity`, Finds | stays a derived read model | n/a | none | n/a |

## Readers: what reads what today

- **Bulk, document-shaped (no per-entity reads):** programme, watchlist and catalog routes read whole generation documents; owner reviews are read as a whole table; metadata through `readAllRecords`. This is why none of these routes has an N+1.
- **Per-entity D1 reads:** the Finds person filter makes one `GET /api/d1/persons/<role>/<key>/identity` per selected person (cached 8 per generation); each runs several queries over up to six rounds, chunked at 80 ids. `/api/d1/persons` has correlated subqueries per person, page size capped at 100. `overlayCatalogResponse` reads the entire owner-review table on every `/api/d1/*` request in `d1` mode.
- **Still R2:** `titles.json`, `people.json`, `enrichment/view-index.json`, `enrichment/films/*`, and `admin/owner-reviews.json` when the owner-review mode is `r2`. `/api/enrichment/diagnostics/export` reads R2 directly and bypasses D1 routing.
- **Silent R2 fallbacks that exist today:** publication reads fall through to R2 when no D1 generation exists (`worker.js` `loadJSON`); the admin read returns reviews from R2 when the owner marker is `r2` or legacy. Once a marker is `d1` there is no fallback for programme or owner reviews.
- **GET side effects:** `GET /api/programme`, `/api/watchlist` and the admin read call `PublishedEpg.repairMirrors`, which writes R2 mirrors. Any production verification of a reader must treat these as writing (AGENTS.md; `tests/get-side-effects.mjs`).
- **Owner precedence is applied in code after the SQL:** `/api/d1/*` selects a localization row without ordering by authority and relies on one stored row per dimension, then rewrites `title`/`localName` in `overlayCatalogBody`. A future consumer that reads the tables directly would miss the owner overlay unless the canonical read model includes it.
- **The projector write path deletes and reinserts credits** and renumbers ordinals; the D1-only credits are re-added after the highest R2 ordinal. Credit identity is `(film, person, role)`; ordinals are not stable keys.

## Constraints from Accepted ADRs

| ADR | Constraint for a switch |
| --- | --- |
| 0009 | Stable local ids, external ids with provenance; merge only on the same Letterboxd id, a trusted common TMDB id or explicit verified evidence; never by name or title. |
| 0056 | The projector is today's single writer; its guards, lease and `projection_state` must be honoured or replaced under a new marker. |
| 0058/0059/0062 | Person grouping is derived; no persisted human, owner decision or role link without a new ADR. |
| 0073 | The metadata cache has its own marker; no Film is minted for a key without one. |
| 0079 | Published programme and watchlist are D1-authoritative; membership is not re-migrated. |
| 0081 | Owner reviews have no FK to Film/Person; `identity_link` is a derived hint; identity ownership was explicitly not decided there. |
| 0085 | Discovery never inserts `film`/`person` rows; `tmdb` and `tmdb_tv` must not collapse. |
| 0086/0087/0090 | A watchlist departure keeps the Film; a rated-only Film is admitted only through `verified-films.json`; no second Film authority was created there. |

## Options (trade-offs, no choice made)

- **A. Move the remaining R2 inputs into D1 domains, then flip a marker; the projector becomes an in-D1 derivation.** Smallest change in behaviour; keeps the proven derivation; the work is the input migration (localization, rated admissions, retention flag, retirements) and the marker.
- **B. Direct canonical writers: each producer calls fenced repository mutations at event time and the projector retires.** Cleanest end state, largest blast radius (EPG commit, `metadataSync`, Discovery, rated admission all change).
- **C. Declare the D1 rows authoritative now with the projector kept as a repair job.** Rejected: it leaves two owners of the same fields and an R2 source that still wins.

**Recommendation: a staged A→B.** First a marker and a fenced, per-entity-CAS mutation API with the projector still the only writer (mode `r2`); then move the remaining R2 inputs to D1 owners; then switch the readers that need canonical identity behind the marker (fail-closed, no silent R2 fallback); then a bounded fenced baseline plus delta, a parity and conflict ledger, and activation. Projector retirement and `D1_ENRICHMENT_WRITE` cleanup stay with AIR-308 under AIR-275.

## Proposed decomposition (for the owner to approve; no Trello card is created)

| # | Deliverable | Depends on | Parallel with | Tests / readback | Owner holdpoints |
| --- | --- | --- | --- | --- | --- |
| C1 | Marker `film_person_authority` (`mode r2|d1`, `cutover open|held`, `generation`) with a `*_cas` fence row; a per-entity revision or CAS key; a fenced mutation API in `canonical-repository.js` (keyed credit upsert instead of delete-reinsert, D1-only credits preserved); the projector stays the only writer | ADR Accepted | none | collisions and typed ids, per-entity CAS, crash and retry, held and missing marker fail closed, ordinal stability, D1-only credits survive | production schema apply |
| C2 | Automatic localization (`titles.json`, `people.json`) moves to D1 canonical dimensions; `metadataSync` and `localize*` write them; owner precedence unchanged | C1 | C3, C5 | owner edit vs reproject race, reviewed value kept, missing R2 mirror | none beyond deploy |
| C3 | Verified rated-only admissions, the watchlist retention flag and the TMDB retirement decision get a D1 owner; the R2 admission object stays an immutable receipt; coordinate the pre-Film queue boundary with AIR-343 | C1 | C2, C5 | rated-only Film, departed watchlist, duplicate Letterboxd vs TMDB, `tmdb` vs `tmdb_tv`, idempotent admission | none beyond deploy |
| C4 | Canonical writers wired to the producers (Discovery admission, EPG commit Film identity, rated admission) through the fenced mutation API; the projector runs as a compare-only shadow | C1; interfaces from C2 and C3 | C5 | mixed-generation fencing, stale generation, retry and unknown outcome, no duplicate or phantom identity | none beyond deploy |
| C5 | Canonical read model: bulk readers by id set (no N+1), owner overlay inside the read model, marker-gated and fail-closed, applied to Finds, person identity and admin | C1 | C2, C3, C4 | read-after-write, held and unavailable authority, owner value survives refresh, bulk vs N+1 budgets | none beyond deploy |
| C6 | Fenced production inventory, full plus delta baseline, parity and conflict ledger (counts, hashes, class-C exceptions, redirects, old owner-review links), activation, rollback tooling, natural-action verification | C1 to C5 accepted | none | parity ledger, activation read-back, natural Film/Person/Admin actions, owner value after cron | schema apply, import, activation and rollback are separate owner GOs |

Producer authority must be accepted before readers switch (C1 before everything; C2, C3 and C4 before C6). C2, C3 and C5 can run in parallel after C1. Every production step is a separate action-specific GO; a deploy authorizes none. The AIR-75 to AIR-78 cards are not reused.

## Test matrix the plan must keep

Same and different typed TMDB ids; duplicate Letterboxd vs TMDB Film; rated-only admission; departed watchlist; orphan and ambiguous identities; redirects A→B→C and a repeated or partial merge; owner edit vs metadata and projector race; D1-only credits with ordinals; per-entity CAS, crash and retry; mixed-generation fencing; held and unavailable authority; missing R2 mirrors; large bounded inventory and idempotent rerun. A GET that writes (`repairMirrors`) cannot be a side-effect-free production probe.

## Impact on the documents (for the later cards)

`docs/architecture/film-person-lifecycle.md`, `persistence-and-migration.md`, `runtime-topology.md`; `docs/reference/domain/film-person.md` (which still says R2 holds Film/Person), `canonical-person.md`, `docs/reference/data/d1-schema.md`, `docs/reference/api/d1-catalog.md`; `docs/runbooks/d1-backfill.md`, `deployment.md`; a dated evidence record per production step. Any changed Mermaid needs the real GitHub rendering and an independent semantic review. This record changes none of them.

## Open decisions for the owner

1. **Scope of authority.** Recommended: canonical D1 owns identity, aliases, external ids, localization and credits; the generation-pinned programme and watchlist documents keep embedding their render fields (AIR-319 domain) and are not changed here. Alternative: also move the embedded fields.
2. **Marker shape and per-entity concurrency key.** A new table in a new migration; whether `film`/`person` gain a revision column or a separate revision table.
3. **Where automatic localization lives** (existing dimensions or a new table) and whether `titles.json`/`people.json` remain as compatibility mirrors.
4. **Mirrors and rollback.** Whether R2 compatibility mirrors are kept current while the marker is `d1` (the AIR-319 pattern) or rollback is by a documented reverse load.
5. **TMDB retirements**: a D1 owner decision record, or an owner-run input.
6. **Person grouping** stays derived (no persisted human); confirmed unless the owner decides otherwise in a separate ADR.

## Not established

The function that writes `identity/tmdb-retirements.json`; the exact CAS call sites of the admin routes; the ratings alias-to-film mapping beyond the ADRs; whether `film-person-backfill.js` and `film-person-diagnostics.js` write (they appear pure); production row counts, parity and class-C exceptions (no production read was made).
