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
| TMDB retirements (`identity/tmdb-retirements.json`) | no code writes it; one owner-approved manual R2 write per the [runbook](../../runbooks/tmdb-tv-identity-correction.md) (see the trace below) | R2 | R2, owner-approved only | reader `applyTmdbRetirement`, projector | D1 owner-only decision and history model; the R2 object stays an input and audit artifact | request-id idempotent, append-only | model and loader (writer now traced) | marker |
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

## The retirements object: traced writer and lifecycle

- **Writer.** No code in `src`, no Worker route, Scheduled Task or script writes `identity/tmdb-retirements.json`. It is created by the owner through the [correction runbook](../../runbooks/tmdb-tv-identity-correction.md): a plan built by `scripts/tmdb-tv-identity-plan.mjs` (read-only; it emits the object body as `r2Retirements`, only for `ready` Films), then one owner-approved write of those exact bytes, preferably a conditional put with the key absent, or the Cloudflare REST `PUT` (no conditional put; allowed only with a direct `GET` of `404` immediately before and a single-writer guarantee). The runbook's own text: no Worker, Task or script writes this key.
- **History.** One write so far: [AIR-291](air-291-tmdb-tv-correction-2026-10-31.md), 31 October 2026, four watchlist miniseries, a body with SHA-256 `c8aa44c2…`, created on an absent key; the evidence records its read-back and the projector's scoped result.
- **Semantics.** `tmdbRetirementSet` validates the whole object (one invalid entry or a duplicate invalidates all; the projector then stops with `input_invalid` before any write). `applyTmdbRetirement` makes the `tmdb` row untrusted (provenance `retired`, reason `tmdb_movie_404`), adds a trusted `tmdb_tv` row and sets the canonical identity to `tmdb_tv:<id>`; the retired movie id is never deleted. `settleTmdbRetirements` undoes and holds a Film on `tmdb_tv_collision` or `retired_movie_on_other_film`; the projector neither writes nor releases a held Film. The runtime also needs a refreshed Letterboxd evidence (`link_changed`, `attributes_changed`, `film_missing` hold).
- **Un-retirement.** There is no un-retirement function. The only inverse is the runbook rollback: removing entries (or deleting the object) as a separately approved owner action, after which the next projector run writes the movie identity back.
- **Consequence for the plan.** The writer and lifecycle are now known, so the D1 owner model below is feasible; it is still a recommendation pending the owner's approval, and nothing is migration-ready until its card is accepted.

## Options (trade-offs, no choice made)

- **A. Move the remaining R2 inputs into D1 domains, then flip a marker; the projector becomes an in-D1 derivation.** Smallest change in behaviour; keeps the proven derivation; the work is the input migration and the marker.
- **B. Direct canonical writers: each producer calls fenced repository mutations at event time and the projector retires.** Cleanest end state, largest blast radius.
- **C. Declare the D1 rows authoritative now with the projector kept as a repair job.** Rejected: two owners of the same fields and an R2 source that still wins.

**Recommendation (pending the owner's final approval): staged A then B** with a prepared-but-inactive stage in between and a single generation-fenced writer handoff (below). Projector retirement and the `D1_ENRICHMENT_WRITE` cleanup stay with AIR-308 under AIR-275.

## Recommended architectural choices (each pending the owner's final approval)

1. **Scope.** D1 owns canonical Film/Person identity, trusted typed external ids, aliases, redirects, entity lifecycle, localization and credits. The generation-pinned programme and watchlist documents and their embedded render fields stay with the published-EPG domain (AIR-319); ratings, Discovery admission, the metadata cache and owner reviews keep their authorities. Links are made only through verified identities, never by title and year, name or a coinciding numeric id.
2. **Marker and per-entity concurrency.** A single-row marker `film_person_authority` (`mode`, `cutover`, `generation`) with a companion CAS fence row, plus a per-entity revision (a column or a revision table; a C1 design point). Every canonical mutation proves both the current domain generation and the target entity revision inside its atomic batch, using the existing fence idiom (a statement that fails a CHECK and rolls the batch back). A mutation that spans entities (a redirect touches both Films and the redirect row; a merge adopts credits and aliases) declares its entity set and carries the expected revision of every entity; the batch asserts all of them and bumps all of them, and re-asserts that a redirect target is not itself a redirect (no cycle or chain growth). A lost entity revision is a retryable conflict, never a partial write.
3. **The marker is a state machine, not a boolean:**

| State | Meaning | Readers | Writers |
| --- | --- | --- | --- |
| no table (schema below the marker's version) | before the feature; legacy behaviour | R2 and the projector as today | the projector only |
| `r2` (initial) | marker present, R2 authoritative | R2 (authorized by this verified state) | the projector only |
| `prepared` | D1 baseline loaded and parity-verified; R2 still authoritative | R2 | the projector; direct writers run compare-only (shadow) |
| `open` | D1 authoritative | D1 canonical read model | fenced canonical writers only; the projector is off |
| `held` (from `open`) | fail-closed freeze | **fail closed (503), not R2** | refuse |

   Transitions: `r2`→`prepared` (baseline load, owner gate); `prepared`→`r2` (discard, reversible); `prepared`→`open` (activation, owner gate, parity gate passed); `open`→`held` (owner action, or a failed parity or integrity gate); `held`→`open` (owner, after validation). A marker row that is missing or malformed, a read error, a held authority or a failed parity gate fails closed everywhere once the marker exists; R2 reads are allowed only in the verified `no table`, `r2` and `prepared` states. Correction to the earlier draft: `held` after activation never sends readers back to R2.
4. **Automatic localization.** D1 stores automatic source values with their provenance separately from the effective preferred title or name. The existing `film_dimension`/`person_dimension` rows hold one effective value per entity, and the audit found the SQL does not rank authority, so the recommendation is a small new source table (entity kind and id, source, value, provenance, revision) with the effective value resolved in the canonical read model as owner > reviewed dictionary > automatic. Owner-review entries, audit, revisions and CAS stay in the owner-review domain. No projector or metadata refresh may downgrade an owner value (the `guardReviewed` rule moves into the mutation API). The owner precedence belongs to every D1 read consumer, not only `GET /api/d1/*`.
5. **Mirrors and rollback.** R2 keeps immutable source inputs and receipts (`letterboxd/admissions/verified-films.json`, import archives, snapshots). Once `open`, no R2 object is a competing mutable owner of Film/Person fields. Recommended mirror policy: the published programme and watchlist mirrors stay current (AIR-319); `titles.json` and `people.json` are frozen at activation as archive snapshots and their consumers move to the canonical read model (programme and watchlist read-time localization, the admin read, the diagnostics export, the `metadataSync` writers); the retention flag in `enrichment/view-index.json` keeps its prediction role only. **Rollback has two different meanings.** Before activation (`prepared` to `r2`) it is a reversible marker move. After activation a code revert or setting `mode=r2` after D1-only writes is not a rollback: recovery is `held`, then a fenced, owner-approved reverse reconciliation (rebuild the R2 documents from canonical D1, validate against the parity ledger, keep `held` until the owner accepts), and only then `r2`.
6. **TMDB retirements.** A D1-owned owner-only decision and history model: append-only rows (the film, the retired scheme and value, the trusted scheme and value, an evidence reference, the approving owner action, a unique request id for replay, a state, a revision), no implicit un-retirement (a separate explicit owner decision record is the only inverse). The existing R2 object stays an input and audit artifact. The writer is traced (above); the model is a recommendation until the owner approves it.
7. **Person grouping** stays derived (ADR 0058/0059/0062): no persisted human, no automatic person merge, no new owner cross-source link.

## Single generation-fenced writer handoff

The R2-sourced projector must never race a direct writer. Each field has exactly one owner at each stage, and the marker generation is in every batch.

| Field group | `r2` | `prepared` | `open` |
| --- | --- | --- | --- |
| Film and Person rows, external ids, aliases, redirects | projector | projector (direct writers compare only) | canonical writers |
| R2-derived credits | projector | projector (compare only) | canonical writers, keyed upsert |
| D1-only TMDB credits (AIR-286) | owner script | owner script | owner script through the mutation API |
| Automatic localization | projector, from R2 | projector (compare only) | canonical writers |
| Owner localization | owner-review domain | owner-review domain | owner-review domain (read model applies it) |
| Rated-only admissions, retention flag, retirements | R2 inputs read by the projector | R2 inputs; D1 owner tables loaded and compared | D1 owners |
| Publication membership (`watchlist_film` link) | published-EPG domain | published-EPG domain | published-EPG domain |

Direct canonical writers and readers can be built and deployed inactive; deploying them is not a change of authority. Readers are activated only after writer ownership and parity are proven.

## Proposed decomposition (the owner approves it first; no card is created)

| # | Deliverable | Depends on | Parallel with | Acceptance and tests | Safe readback | Owner gates |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | The marker and its state machine, per-entity revisions, the fenced mutation API (multi-entity fencing), keyed non-destructive credit upserts (D1-only credits preserved), the projector still the only writer; a deployed schema and API change no authority | ADR Accepted | none | collisions and typed ids, per-entity and domain CAS losses, multi-entity batch atomicity, redirect-chain checks, held and missing marker fail closed, ordinal stability, uncertain outcomes | marker row and schema version by `SELECT` | production schema apply |
| C2 | Localization: the automatic-source table and the canonical effective resolution, `metadataSync` and `localize*` writers (inactive), owner precedence inside the read model | C1 | C3a, C3b, C5 | owner value vs late metadata and projector writes, reviewed value kept, missing R2 mirror, replay | counts per source by `SELECT` | none beyond deploy |
| C3a | Verified rated-only admissions and the watchlist retention flag (the two inputs that decide which Films exist outside the watchlist; ADR 0086/0087) get a D1 owner; the R2 admission object stays a receipt; the pre-Film queue stays with AIR-343 | C1 | C2, C3b, C5 | rated-only Film, departed watchlist, duplicate Letterboxd vs TMDB, `tmdb` vs `tmdb_tv`, idempotent admission, rating link | admission counts by `SELECT` | none beyond deploy |
| C3b | TMDB retirements: the D1 decision and history model and a loader from the existing R2 object | C1 | C2, C3a, C5 | replay by request id, no implicit un-retirement, held cases, invalid object | rows by `SELECT` | none beyond deploy; the load itself is part of C6a |
| C4 | Producer integration: Discovery admission, the EPG commit's Film identity and rated admission call the fenced mutations, inactive or compare-only; the projector as a compare-only shadow | C1; interfaces of C2, C3a, C3b | C5 | mixed-generation fencing, stale generation, retry and unknown outcome, no duplicate or phantom identity, compare reports | shadow compare ledger | none beyond deploy |
| C5 | The canonical bulk read model with owner precedence, used by all D1 consumers (`GET /api/d1/*`, Finds, person identity, admin), inactive until the marker is `open`, fail-closed | C1 | C2, C3a, C3b, C4 | read-after-write, held and unavailable authority, owner value after refresh, bulk and N+1 budgets, the owner overlay everywhere | read-model output on a fixture; no writing GET as a probe | none beyond deploy |
| C6a | Baseline: a fenced production inventory, full plus delta load into D1 in `prepared`, a bounded parity and conflict ledger (counts, hashes, class-C exceptions, redirects, old owner-review links, D1-only credits), cutover readiness | C1 to C5 accepted | none | the ledger reaches zero unexplained differences; idempotent re-run; resume after a crash | ledger and `SELECT` counts | separate owner gates: schema apply (if not done in C1), import, `r2`→`prepared` |
| C6b | Activation: the owner-approved `prepared`→`open`, natural Film/Person/metadata/Admin actions with read-after-write, owner value surviving a refresh and the cron, stabilization, rollback readiness (the reverse reconciliation rehearsed) and acceptance | C6a accepted | none | no phantom or duplicate identity, `held` drill fails closed, reverse reconciliation validated on a copy | natural-write evidence without a writing GET | separate owner gates: marker flip, any rollback or reverse reconciliation |

Dependency graph: C1 first; C2, C3a, C3b and C5 in parallel after C1; C4 after the C2, C3a and C3b interfaces; C6a after C1 to C5 are accepted; C6b after C6a. C3 is split on real producer boundaries only: admissions and retention are one existing-Film-set semantic with one producer family, retirements are a separate owner-only model with a manual writer. Every production action (schema apply, import, marker flip, rollback) is a separate owner gate and never bundled with another into one card. The AIR-75 to AIR-78 cards are not reused. AIR-321 stays the umbrella until every accepted child and the canonical production read and write authority are accepted; AIR-308 and AIR-79 stay under AIR-275.

## Acceptance checks the design must keep

Typed `tmdb` vs `tmdb_tv`; Letterboxd/TMDB duplicates; conflict and redirect chains (A→B→C, repeated or partial merge); departed watchlist Films; verified rated-only admissions; owner-review precedence against late metadata writes; D1-only credits and ordering; per-entity and repository CAS losses; uncertain outcomes; generation changes and `held` failures; bulk and N+1 limits; full plus delta replay with verifiable parity. `GET /api/programme`, `/api/watchlist` and the Admin read routes call `PublishedEpg.repairMirrors` and may write R2; none is a side-effect-free production probe.

## Impact on the documents (for the later cards)

`docs/architecture/film-person-lifecycle.md`, `persistence-and-migration.md`, `runtime-topology.md`; `docs/reference/domain/film-person.md` (which still says R2 holds Film/Person), `canonical-person.md`, `docs/reference/data/d1-schema.md`, `docs/reference/api/d1-catalog.md`; `docs/runbooks/d1-backfill.md`, `deployment.md`, `tmdb-tv-identity-correction.md`; a dated evidence record per production step. Any changed Mermaid needs the real GitHub rendering and an independent semantic review. This record changes none of them.

## Not established

The exact CAS call sites of the admin routes; the ratings alias-to-film mapping beyond the ADRs; whether `film-person-backfill.js` and `film-person-diagnostics.js` write (they appear pure); production row counts, parity and class-C exceptions (no production read was made); the per-entity revision's storage form (a C1 design point).
