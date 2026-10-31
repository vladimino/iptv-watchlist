# Film and Person — domain lifecycle contract

**Role:** active technical reference for the **implemented, storage-neutral contract**, not a claim that Film/Person entities have replaced production R2 records. Verified against `src/domain/film-person.js`, `src/domain/film-person-reader.js`, `src/domain/film-person-backfill.js`, and the current Worker/sources on **2026-10-24**. GitHub main and authorized runtime diagnostics are still required for current implementation/flag claims.

- **Historical source and original rollout observations:** [AIR-42 audit and rollout log](../../evidence/film-person/lifecycle-audit-and-rollout.md).
- **Work and decisions:** [AIR-42](https://trello.com/c/drLBuWjl), [AIR-48](https://trello.com/c/rVf8rRoJ), [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-49](https://trello.com/c/YNaLFwtW), [ADR-0001](../../adr/0001-d1-schema-v1.md).
- **Implementation:** [pure domain model](../../../src/domain/film-person.js), [storage-neutral reader](../../../src/domain/film-person-reader.js), [dry-run backfill](../../../src/domain/film-person-backfill.js), [diagnostics](../../../src/domain/film-person-diagnostics.js), [runtime read/write paths](../../../src/worker.js), [localization helpers](../../../src/sources.js). The owner's manual title review builds on `applyReviewedLocalization`; its rules are in [the title review contract](film-title-review.md). The owner's manual Person name review, with explicit role links instead of id merges, is in [the name review contract](person-name-review.md).
- **Related maintained contracts:** [scored resolution](scored-resolution.md), [candidate discovery](candidate-discovery.md), [prediction runner](../api/prediction-runner.md), [D1 schema (not production-authoritative)](../data/d1-schema.md).

## Where the model runs (do not confuse with source of truth)

`DOMAIN_CONTRACT_VERSION=1` describes pure lifecycle projections and guarded transitions. `film-person.js` has no HTTP/R2 effects and is not the deployed authoritative Film/Person storage adapter. `film-person-reader.js` constructs views from records already loaded by a caller; `film-person-backfill.js` computes desired lifecycle sidecars and a **dry-run** reconciliation; it does not write production storage. Diagnostics and offline parity are views/measurements, not cutover evidence. Since [ADR 0056](../../adr/0056-d1-enrichment-write-through.md), the Worker bundle carries the reader in its own scope for the D1 enrichment projector only. The projector calls it with `entitiesOnly`, which returns the Films and People without sidecars or legacy parity. The reader's per-object lookup indexes return what its linear scans returned.

Production content continues to use existing watchlist, metadata, programme, published EPG generation, discovery ledger/catalog and enrichment objects in **Cloudflare R2**. The D1 schema and repository adapters support a separately approved migration path; a schema and offline importer do not make D1 authoritative. The programme and watchlist reads and the EPG commit apply the domain localization rule unconditionally: a cached automatic title or name goes through the guarded transition, a reviewed value is never downgraded, and an owner-authored or unexplained reviewed value is kept with an explicit `titleConflicts` / `nameConflicts` entry ([ADR 0037](../../adr/0037-domain-localization-only.md)). The `LIFECYCLE_LOCALIZATION` runtime flag selects the localization of the metadata sync only (`on:metadata`, `shadow:metadata`; off by default); verify the **live** binding before claiming a particular metadata mode is active. The original [rollout log](../../evidence/film-person/lifecycle-audit-and-rollout.md) describes the 22–23 October staged switch of the other paths, whose tokens the Worker no longer reads. Neither setting is equivalent to deploying the full lifecycle entity repository.

## Identity and canonical records

- Letterboxd watchlist films retain their `lid` as the existing stored ID. A discovered, verified TMDB movie is usually stored as `tmdb_<tmdbId>`; if the TMDB id is already owned by a watchlist entry, that entry is reused. Neither storage ID nor discovery observation key (`normalizedTitle|year`) should be confused with the canonical TMDB identity (`tmdb:<id>`).
- `localFilmId()` mints `film:<letterboxd lid>`, `film:tmdb:<id>`, or a sorted `film:conflict:<ids>` for conflicting TMDB claims without Letterboxd. A previously assigned `localId` is preserved; it is not recomputed merely because new evidence appears.
- `canonicalFilmId()` is the one rule from a stored spelling back to the canonical id: `tmdb_<n>` → `film:tmdb:<n>`, a Letterboxd `lid` → `film:<lid>`, a `film:` id unchanged, an empty value `null`. It never mints: a result that names no stored Film is left unresolved by its caller. The offline importer loads this function from the domain source rather than keeping a copy.
- `externalIds` carry scheme, value, trusted/conflicting flags and provenance. Two different verified TMDB identities or distinct Letterboxd identities are collisions, **not** automatic merges. `canonicalIdentity` becomes `tmdb:<id>` only after identity is resolved against trusted evidence; an accepted score or search hit alone does not promote it.
- **Letterboxd slug alias** ([ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md), [AIR-276](https://trello.com/c/PeWwEti8)): see [below](#letterboxd-slug-alias). A slug is never an identity and never links two records.
- **TMDB TV identity** ([ADR 0057](../../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md), Accepted, [AIR-290](https://trello.com/c/70ldvbUB)): see [below](#tmdb-tv-identity-and-retired-movie-ids). `tmdb` is a movie id and `tmdb_tv` a TV id; an equal number in the two schemes is never evidence.
- `linkFilms(existing, incoming, at, evidence)` preserves the existing entity ID, payloads and reviewed localization. Linking separate entities requires matching Letterboxd evidence, the same *trusted* TMDB identity on both sides, or `evidence.verified === true`. Shared **proposed/untrusted** TMDB IDs are insufficient. Conflicts yield `identity_collision` or `unverified`/`unrelated` without changing entities.
- A successful link adds aliases and an old→surviving ID redirect, preserving existing fingerprint, prediction and metadata; incoming prediction and history are retained as history/preserved results, without repeat duplicates. A reviewed value must not be silently replaced with an automatic or conflicting incoming value.
- `localPersonId()` prefixes the **role-specific** ID: `person:actor/<slug>`, `person:director/<slug>`, `person:role/<name>`, `person:tmdb_actor/<id>`, or `person:tmdb_director/<id>`. Same real human appearing under different roles/authorities is **not** merged in storage. Embedded credits and localized names are not by themselves a canonical Person repository. The pure [canonical Person contract](canonical-person.md) ([ADR 0058](../../adr/0058-canonical-person-grouping.md)) groups those records by source key, verified coCredit or an owner decision. The [person identity projection](person-identity-projection.md) ([ADR 0059](../../adr/0059-person-identity-projection.md), Accepted) is the one consumer reference over that grouping: a watchlist filter and a catalog filter call it with records already loaded and receive the same human id, or an explicit unresolved, ambiguous or conflicting state. The watchlist grid still matches the stored role id. `GET /api/d1/persons/<role>/<key>/identity` is the one route that loads a D1 neighborhood and calls the projection ([ADR 0062](../../adr/0062-d1-person-identity-read.md)). The Finds actor and director filter reads that GET ([ADR 0065](../../adr/0065-finds-person-filter-d1-read.md)). A shared name never adds a member.

## Letterboxd slug alias

A Letterboxd film slug is kept as its own `externalIds` entry: `{scheme: 'letterboxd_slug', value, trusted: false, conflicting, provenance}`. It is separate from the lid (`scheme: letterboxd`), from TMDB ids and from title aliases.

- **Source.** `letterboxdSlugFromUrl` accepts only `https://letterboxd.com/film/<slug>/` and `https://letterboxd.com/<member>/film/<slug>/`: same origin, no query, fragment or credentials, lowercased. A title, a lid, a TMDB URL or Wikidata never yields a slug.
- **Attached only to a Film with a lid:**
  - `current`: the Film's own permalink, when every stored record of the lid that carries one agrees. The records are the programme, the watchlist, `metadata.json` and the record itself. Provenance: `source: letterboxd_film_url`, `records` (which of them carry it), canonical `url`, `observedAt`.
  - `ambiguous`: the same records carry different permalinks, such as a rename seen by one record and not yet by another. Every slug is kept with its `records`, and none is current, because no record is proved fresher.
  - `observed`: a slug from a Letterboxd Diary entry with the same lid (`source: letterboxd_diary`, `entry`), when the caller passes `store.diaryHistory`. An alias stamped by the diary writer keeps its own `firstObservedAt` as `observedAt`. An older alias without one has `observedAt: null` and `observedBetween {from, to}`, the entry's first and latest read; no exact time is claimed. One slug in several entries of the lid: `from` is the earliest lower bound (unknown if any is unknown), `to` the earliest upper bound, and `observedAt` is exact only when the two are equal;
  - `historical`: a slug stored on the same Film by an earlier backfill that the Film no longer carries, so a renamed permalink still names it.

  A TMDB-only Film, and a diary row without a lid, get no slug.
- **Stable.** The backfill keeps each stored slug's stored time: an exact `observedAt`, otherwise its stored `observedBetween`. A replay with the stored sidecars is therefore unchanged, even after later diary reads.
- **Collision.** One slug on two Films marks the entry `conflicting` on both and is reported as `aliasConflicts` by `readLifecycle` and in the backfill report. Nothing is merged, moved or re-rated.
- **Unchanged by the alias:** `id`, `canonicalIdentity`, the lid, TMDB trust, readiness, fingerprint, prediction and the Film count.
- **Storage.** The alias is part of `externalIds`: the R2 lifecycle sidecars and the D1 `film_external_id` rows hold it without a schema change. `trusted: false` keeps it outside the unique index on trusted identities.
- **Inventory.** `scripts/letterboxd-slug-inventory.mjs --snapshot <dir>` counts the aliases a snapshot's stored records would yield. It makes no request and writes nothing; running it on a production export needs owner approval for that export.

## TMDB TV identity and retired movie ids

A miniseries that TMDB keeps as a TV entry is identified by `{scheme: 'tmdb_tv', value, trusted, conflicting, provenance}` ([ADR 0057](../../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md), Accepted). The functions live in `src/domain/tmdb-tv-identity.js`, which is loaded beside this file. The Worker bundle loads it at top level: `parseFilm` keeps the typed link and the lifecycle reader applies the retirements object ([below](#runtime-projection)).

- **Separate namespaces.**
  - `tmdb` (movie) and `tmdb_tv` values are never compared.
  - `tmdbTvCollisions(films)` reports a trusted `tmdb_tv` held by two Films as a collision for owner review, and the same number as a movie id on another Film as a `numericOverlap` only.
  - `linkFilms` keeps refusing a Film whose `tmdb` value differs (`identity_collision`). It never links on a TV value.
- **Letterboxd link.**
  - `letterboxdTmdbLink(html)` returns the single visible `https://www.themoviedb.org/(movie|tv)/<id>` link, typed. Only an anchor's `href` counts, not a URL in text, a `<link>` or another element, with the page's `data-tmdb-type`/`data-tmdb-id` attributes.
  - The status is `resolved` only when exactly one link agrees with exactly one attribute pair.
  - The status is `review` for `link_disagrees_with_attributes`, `multiple_tmdb_links`, `contradictory_attributes` or `attributes_missing`.
  - With no link the status is `unresolved` (`no_tmdb_link`).
  - It never corrects a Film.
- **Retirement.**
  - `tmdbRetirement(entry)` validates an owner-confirmed retirement: `filmId` `film:<lid>`, `lid`, `movieId`, `tvId`, `evidence` and `confirmation` (`by: owner`, `at`, `source`).
  - The evidence must contain:
    - `movieStatus: 404` and `movieCheckedAt`;
    - the Letterboxd permalink in `letterboxdUrl`;
    - `link: tv/<tvId>` and `linkCheckedAt`;
    - `tvResponseId` equal to `tvId`, and `tvCheckedAt`.
  - Each missing or different piece is a named reason.
- **Applying it.**
  - `applyTmdbRetirement(film, retirement, at)` changes only that Film:
    - the `tmdb` entry becomes `trusted: false`, keeping its value; its provenance gets `status: retired`, `reason: tmdb_movie_404`, `replacement`, `evidence`, `confirmation` and `previous`;
    - a trusted `tmdb_tv` entry is added after it, with provenance `source: letterboxd_tmdb_link`;
    - `canonicalIdentity` becomes `tmdb_tv:<id>`;
    - the identity dimension stays `resolved`, with `sourceVersion` `tmdb_tv:<id>` and both ids in its provenance.
  - Everything else is unchanged.
  - The result depends on the Film and the retirement only, never on the time of the run (except the dimension's `updatedAt`), so any writer's correction reads back identically.
  - A Film carrying exactly the result is returned with `changed: false`. Exactly means all of these: the retired `tmdb` entry with its full provenance (including `previous`), the trusted `tmdb_tv` entry with its full provenance, `canonicalIdentity`, and the identity dimension's `sourceVersion` and both ids. Key order is ignored. Any other trace of a correction is `partial_correction`.
  - These states are refused, not repaired: `film_mismatch`, `lid_mismatch`, `identity_not_resolved`, `conflicting_tmdb`, `movie_id_mismatch`, `tv_id_mismatch`, `partial_correction`, `movie_not_trusted_identity`.
- **Storage.** The retirements are one owner-approved R2 object, `identity/tmdb-retirements.json`, applied by the projection ([below](#runtime-projection)). The records keep the movie id Letterboxd shows. D1 holds the untrusted retired `tmdb` row, the trusted `tmdb_tv` row and `canonical_identity` `tmdb_tv:<id>`; the unique index on trusted `(scheme, value)` separates the namespaces without a schema change.
- **Plan.** `scripts/tmdb-tv-identity-plan.mjs` plans exactly the four confirmed Films from the private AIR-286 artifact. It reads either D1 or a snapshot, writes nothing, and states each Film's expected D1 identity; `d1Readback` compares D1 with it ([runbook](../../runbooks/tmdb-tv-identity-correction.md)). D1 is written by the enrichment projector ([ADR 0056](../../adr/0056-d1-enrichment-write-through.md)), not by this tool.

### Runtime projection

- **The page link in the records.** `parseFilm` adds `tmdbLink`, the full `letterboxdTmdbLink(html)` result, to the record it returns. `tmdbId` is unchanged: it is still the first `data-tmdb-id` number, whatever the link or `data-tmdb-type` says.
  - The metadata refresh writes the record to `metadata.json` and to the sync run's watchlist. The completed sync writes the run's films to `watchlist.json`, and the EPG commit carries them into `programme.json`.
  - The field appears on a record only when the regular sync re-parses its page: a stale record (30 days) or a missing synopsis. A record written before has no field and stays valid. A fresh record keeps the field it has.
  - No Film view, readiness rule or change key reads `tmdbLink`, so the field alone changes nothing in D1.
- **The retirements object.** `readLifecycle(store, now, options)` applies `store.tmdbRetirements`, the body of `identity/tmdb-retirements.json`, only when it is not `null`.
  - Absent: the reader calls none of this and the view is exactly what it was. Nothing creates the object; it is written only by an owner-approved run ([runbook](../../runbooks/tmdb-tv-identity-correction.md)).
  - `tmdbRetirementSet(body)` checks the whole object first: `schemaVersion: 1`, a `retirements` array, every entry valid under `tmdbRetirement`, and no two entries naming the same Film, lid, movie id or TV id. One failure fails the object (`valid: false`, reasons such as `entry_0:owner_confirmation` or `entry_1:duplicate_tvId`), and no retirement of it applies.
  - `applyTmdbRetirements` runs after the watchlist and programme Films are built and before catalog records are linked, so a retired movie id, no longer trusted, links no catalog record. A retirement is **held**, and its Film stays as the records build it, when:
    - the Film is not in the view (`film_missing`);
    - a stored record of its lid (programme, watchlist, `metadata.json`) with a `tmdbLink` no longer shows the confirmed divergence, checked per record by `tmdbLinkChange`. That divergence is exactly one link, `tv/<tvId>`, with exactly one attribute pair, `movie`/`<movieId>`. Anything else is held:
      - no link, several links, another link or an unreadable field (`link_changed`);
      - attributes that are missing, several, of another type or another id (`attributes_changed`), including Letterboxd switching only the type, or type and id, to the TV entry;
    - `applyTmdbRetirement` refuses it (`movie_id_mismatch`, `lid_mismatch` and the other reasons above).
  - A record without a `tmdbLink` field (written before the field existed) is no evidence either way. The correction uses the identity dimension's own `updatedAt` as its time, so it is the same on every read.
  - `settleTmdbRetirements` checks the corrections against the whole view once catalog records are linked. A trusted `tmdb_tv` on a second Film (`tmdb_tv_collision`) or a second Film still trusting the retired movie id (`retired_movie_on_other_film`) undoes the correction and holds every Film involved.
  - The view then carries `tmdbRetirements: {valid, reasons, retirements, applied, held: [{filmId, reason}], numericOverlaps}`, with `entitiesOnly` too. It is absent when the object is absent. `numericOverlaps` (a TV id equal to a movie id on another Film) is reported only.
- **Consumers.** The corrected Film keeps its id, lid, slug alias, localization, fingerprint, prediction, history and redirects; `catalogReady` and `displayReady` still hold through the lid. Movie-only consumers read the records' `tmdbId`, which keeps the movie number, and never see `tmdb_tv`: EPG matching and discovery `knownTmdb`, catalog keys `tmdb_<n>`, posters, Wikidata P4947 and the model's TMDB URI (for a corrected Film still the retired movie URL, as before the correction). The retired movie ids answer `404`, so no TMDB movie can be verified under them. `recordsFor` adds catalog records only for a trusted `tmdb` id, so a `tmdb_tv` number never pulls the catalog record of an equal movie id into a Film's credits. The admin Film record (`src/admin/read.js`) builds its identity from the records and still shows the movie id; it reads, and writes nothing.
- **Offline tools.** `scripts/snapshot-store.mjs` loads the object into `store.tmdbRetirements` when a snapshot holds it (`null` otherwise), so the offline import, the projection seed and the lifecycle scripts derive the same corrected view as the Worker.

## Lifecycle dimensions and transition rules

`FILM_DIMENSIONS` defines **five independent state dimensions**; availability is a time-bound projection, **not** a sixth status. Every dimension state may hold `status`, `updatedAt`, `source`, `sourceVersion`, `provenance`, `lastError`, `failureReason`, `retryAt`, `attempts` and `nextAction`; localization alone also has `value`. These status envelopes do **not** contain entire fingerprint, metadata, or prediction payloads.

| Dimension | Status vocabulary | Conditions and consequences |
| --- | --- | --- |
| Identity | `unresolved / resolving / resolved / ambiguous / rejected` | Keep Letterboxd ID without inventing TMDB; `excluded_nonfilm` creates no Film. Historical/expired or unchanged terminal discovery is `wait_new_evidence`; future retry is `wait_retry`; only **eligible current** discovery can `continue_discovery`. Distinct verified IDs surface conflict. |
| Metadata | `missing / fetching / partial / fresh / stale / failed` | 30-day freshness threshold. Letterboxd metadata and TMDB-only metadata choose different next actions. A synopsis-only update that retains older credits is `partial`; `peopleNamesVersion: 2` means the name attempt finished, not that all names are reviewed. The decision clocks that are not columns of `film_metadata` are projected separately ([below](#metadata-sync-clocks)). |
| Localization | `missing / provisional / reviewed` | Verified dictionary/owner choice cannot be downgraded by Wikidata/cache; provisional transcription is **provisional** even when stored in a reviewed dictionary. Conflicting inputs remain aliases/provenance or `localizationConflicts`. |
| Fingerprint | `missing / generating / current / stale / failed` | Schema v1 and no `invalidatedAt` make the fingerprint current. Profile changes alone do **not** invalidate/recreate fingerprints. The reader and domain accept the fingerprint transition verdict per film (`fingerprintCompatible` on the store, [fingerprint compatibility](fingerprint-compatibility.md#readers-and-diagnostics)): a kept fingerprint of another schema version is current with its own version as provenance; an invalidated one never is. |
| Prediction | `missing / generating / current / stale / failed` | Current means fingerprint current **and** matching profile version/hash, fingerprint hash, schema and prompt version 1. Failures retain retries/backoff; profile changes make prediction stale, with `prediction_only` when fingerprint is still current. Every consumer compares the profile by strict version and hash equality; [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md) defines the selective rule that replaces it once connected and activated; its evaluator and the one switch that moves every consumer to it are described in [prediction compatibility](prediction-compatibility.md); the lifecycle reader and domain accept its verdict per film (`predictionCompatible` on the store): a positive verdict keeps a prediction that names the usable fingerprint current over another profile or prediction-prompt version, with its own provenance; a negative one is stale even over an exact match. |

`transition()` rejects edges not permitted by the domain graph (for example, `resolved` identity cannot regress to `unresolved`, and reviewed localization cannot become provisional). `applyAutomaticLocalization()` cannot set `reviewed` and records attempted overrides; only `applyReviewedLocalization()` with `authority: dictionary` or `owner` can promote reviewed content. `observeMetadata()` does not rewrite fingerprint or prediction. `invalidatePredictionForProfile()` preserves fingerprint and chooses the appropriate next action.

## Metadata sync clocks

`metadataSync` still decides freshness from `metadata.json`. The clocks it branches on, and that `film_metadata.updated_at` folds together, are `metadataAt`, `synopsisFetchedAt`, `peopleNamesVersion` and `peopleLocalizedAt`. `peopleVersion` is already `film_metadata.people_version`. Reviewed titles and reviewed names stay on the localization dimension; `titles.json` and `people.json` feed that dimension and are not copied into the clock row.

D1 table `film_sync_state` ([ADR 0070](../../adr/0070-metadatasync-freshness-clocks.md)) stores those four clocks and nothing else. For a Film that already has a row, no sync row means `metadata.json` has no entry for that Film. A NULL clock means the entry exists and the clock is absent. The integer 2 is the only `people_names_version` that means the name attempt finished. The 30-day window is not stored. The enrichment projector writes the row from R2 after schema version 5, including after the Film has left the view while the cache entry remains. A cache key with no Film row does not create one. Until that migration is applied the table is absent and nothing reads it. No sync step and no page reads the row to choose an R2 write. The contract is the [D1 schema](../data/d1-schema.md#metadata-sync-clocks-schema-v5).

## Readiness is derived, not a new entity status

- `displayReady`: non-rejected identity, a resolved identity or a Letterboxd external ID, and a usable preferred title (reviewed/provisional, original or EPG). Missing translation, fingerprint or prediction must **not** hide a film.
- `catalogReady`: stable Letterboxd ID or trusted, non-conflicting TMDB ID **and** fresh or partial metadata.
- `predictionReady`: both fingerprint and prediction are `current`. Neither a valid catalog id nor a fresh profile alone suffices.
- `preferredTitle()` uses reviewed/localized value first, otherwise original, otherwise EPG. UI parity must still compare the **actual displayed title** in existing programme/watchlist read paths, not assume it equals the domain projection.

## Availability and published generations

`availabilityProjection()` computes `availableUntil` as the latest known show start plus **72 hours**; `hot` evaluates shows from **72 hours back** through **24 hours ahead** (upper bound exclusive). Shows and `epgLastAiring` are not stable Film attributes and never invalidate fingerprint.

An explicit `shows: []` is known **no availability**. When a published programme run is known, missing `shows` or a mismatched `showsProgrammeRunId` must not produce hot. `epgLastAiring` is a fallback only when no explicit shows, no shows programme run and no published run are known. A new published EPG generation atomically replaces the current show set; it does not append old availability. See [candidate discovery](candidate-discovery.md).

## Existing storage and projections

| Existing store | Role (not a new canonical D1 entity) |
| --- | --- |
| `metadata.json`, `watchlist.json`, `programme.json` | Letterboxd/watchlist metadata and published programme snapshots; current user-facing read models |
| `epg/discovery-latest.json`, `epg/discovery-resolution.json` | EPG observation ledger and separately evaluated identity decisions; unresolved observation is **not** a Film |
| `epg/discovered-films.json` | Verified discovered catalog records; current show lists tied to the published generation |
| `data/film-titles.json`, `data/person-names.json`, plus `REVIEWED_PEOPLE` override | Reviewed/manual localization; always stronger than automatic cache |
| `titles.json`, `people.json` | Provisional/derived localization caches, **not** canonical Person identity |
| `enrichment/films/<id>/fingerprint.json`, `predictions.json`, `actual.json` | Current fingerprint (the pointer, with its prompt version and provenance), current prediction with history, independent actual rating |
| `enrichment/films/<id>/fingerprints/<hash>.json`, `fingerprint-generations/<hash>-s<schema>-p<prompt>.json` | Immutable fingerprint content bodies and generation records, written create-only for every accepted fingerprint ([fingerprint compatibility](fingerprint-compatibility.md#storage)); never identity, never read by display |
| `enrichment/view-index.json`, `enrichment/prediction-queue.json` | Derived dashboard/queue projections. Neither defines Film identity or personal truth. A view-index entry with a fingerprint also carries `impactFeatures`, a copy of the full fingerprint's mechanics and execution bound to its hash ([prediction compatibility](prediction-compatibility.md#prediction-queue)) |
| `enrichment/profile/current.json` and `profile/versions/<n>.json` | Taste-profile version/hash that controls prediction freshness |
| `letterboxd/diary/history.json`, `letterboxd/diary/state.json` | Letterboxd Diary viewing history (behind `LETTERBOXD_DIARY_HISTORY`): one entry per viewing-id row, otherwise per film and day with a viewing count (a lower bound unless proved by one page), the ratings and re-watch rows, plus the incremental run state. A record links to a Film only through its Letterboxd lid; a slug is an observation, not an identity. Not a rating or watched fact ([contract](../integrations/letterboxd-diary-history.md), [ADR 0049](../../adr/0049-letterboxd-diary-viewing-history.md)) |

The reader's `*.lifecycle.json` sidecars are **computed views**, not permission to overwrite current `programme.json`, `people.json`, `epg/discovery-latest.json` or `enrichment/prediction-queue.json`. The offline backfill compares `create/update/unchanged/orphan/conflict` without deleting orphaned data. Reviewed downgrades, unapproved identity replacement and prediction-history loss are explicit conflict types; `updatedAt` and redirect observation times alone do not constitute a changed entity. Tests for this scope include `tests/film-person.mjs`, `tests/film-person-reader.mjs`, `tests/film-person-backfill.mjs`, `tests/lifecycle-parity.mjs`, `tests/film-person-localize.mjs`.

## Architecture and operational boundaries

- Match scoring and canonical identity have separate owners: scoring cannot silently verify a TMDB identity. `src/domain/resolution-acceptance.js` requires trusted existing decision/owner evidence or valid TMDB movie-detail confirmation and a matching actionable programme generation.
- The localization of the reads and of the EPG commit has no runtime switch; the metadata sync's localization is still flag-gated, and neither is a Film/Person persistent-entity cutover. Do not change `LIFECYCLE_LOCALIZATION` or any production writer while maintaining this reference.
- D1 repositories `src/canonical-repository.js`, `src/epg-repository.js` and `src/prediction-repository.js` were developed for migration work but must not be portrayed as authoritative until a separately approved live migration. Historical parity observations remain in [the original audit and rollout record](../../evidence/film-person/lifecycle-audit-and-rollout.md); follow Trello for current rollout completion and flags.
- Owner admin search, quality queues, and a later live read API use the contract in [admin read boundaries](admin-read-contract.md). That page does not add a route or change this domain.
- **Do not rewrite historical evidence.** Material new architecture choices need future ADRs; current reference and historical audit have different jobs.

