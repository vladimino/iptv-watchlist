# ADR 0216: Canonical Film lifecycle and the unified Film read contract

**Status:** Proposed  
**Original decision date:** pending Product Owner disposition  
**Recorded at:** 2026-11-25, from `main` `a537c9c7`  
**Approval source:** none yet. This record must not merge while it is `Proposed` ([ADR merge gate](../process/agent-workflow.md#adr-merge-gate)).  
**Related work:** [AIR-628](https://trello.com/c/zwJum962), companion audit [AIR-627](https://trello.com/c/IOERZ9GI). Coordinated with, and not extending, Accepted [ADR 0214](0214-film-metadata-per-field-provenance.md) (per-field metadata provenance, AIR-613) and Accepted [ADR 0215](0215-identity-evidence-full-model.md) (full identity evidence model, AIR-616).  
**Supersedes:** None. It amends no accepted decision.  
**Superseded by:** None

## Context

### What is already decided and is not reopened here

| Concern | Accepted source |
| --- | --- |
| Typed stable Film identity, `film:` ids distinct from observation keys | [ADR 0009](0009-canonical-film-person-identity.md) |
| Film/Person storage authority in D1 at `open`, redirects, retirement decisions | [ADR 0099](0099-canonical-film-person-d1-authority.md) |
| Five independent lifecycle dimensions and derived readiness | AIR-42, [Film/Person reference](../reference/domain/film-person.md) |
| A Film survives leaving the EPG and the Watchlist; rated archive admission | [ADR 0086](0086-durable-watchlist-film-retention.md), [ADR 0087](0087-rated-archive-film-admission.md), AIR-475 |
| Public permalink `/film/tmdb_<n>` for a trusted TMDB movie, `/film/<lid>` as alias and fallback | AIR-387, AIR-409, AIR-475, [UI read models](../architecture/ui-and-read-models.md#one-permanent-film-url-air-387) |
| Historical prediction storage keys stay under the Letterboxd id | [ADR 0201](0201-recovery-admits-stored-letterboxd-id-via-catalog-film.md) |
| One writer of Watchlist membership; several lids may name one Film | [ADR 0203](0203-watchlist-membership-letterboxd-single-writer-projection.md) |
| Letterboxd admissions coordinated in D1 only | [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) |
| Identity evidence ledger of typed propositions | [ADR 0213](0213-film-identity-evidence-ledger.md) |
| Dormant marker-gated bulk read model | AIR-372, `src/canonical-read-model.js` |

### The gap

Each domain has a safe reader of its own facts. No contract says how those facts form **one answer about one Film**:

- `GET /api/catalog/film/<tmdbId>` answers identity (`found`, `absent`, `retired`, `conflict`, `unavailable`) and the catalog body. It takes a TMDB movie id only.
- `GET /api/d1/films/<id>` reads schema v1 `actual_rating` and `prediction_current`. The authoritative personal facts are in `ratings_view` and the ratings documents, and the authoritative prediction pointer is `prediction_pointer`. The route cannot be presented as a complete personal view of a Film.
- `GET /api/enrichment/history?filmId=` already bridges a `tmdb_<n>` permalink to the verified lid storage id. Its bridge is strict: the owner Film may hold **at most one** trusted Letterboxd value. ADR 0203 allows several lids for one Film, so such a Film today reads only its requested id's history.
- `src/canonical-read-model.js` is not bundled and composes identity, titles and credits only.
- `src/catalog-d1.js` serves the `/api/d1/*` views, which read the canonical tables but not the personal or prediction domains.

There is also **no admission policy** for a verified Letterboxd film with no TMDB movie. The AIR-627 first census found no pure lid-only Film among the lid-owned Films: 402 carry a trusted TMDB movie id and 4 a TMDB TV identity. This is a future capability, not a live defect.

## Decision (proposed)

### 1. Lifecycle: existence is separate from facts

```
source observation / candidate        (its own domain; no Film exists)
        │ verified proof (typed, per ADR 0213)
        ▼
canonical Film  (permanent film.id; never deleted for lack of a fact)
        │
        ├── identity claims, aliases, redirects, retirements
        ├── metadata, localization, credits        (PF, ADR 0214)        
        ├── Watchlist membership                   (ADR 0203)
        ├── availability: shows of the published EPG generation
        ├── personal facts: watched, rating, Diary (ratings domain)
        └── prediction current + lineage           (prediction domain)
```

- An observation (an EPG title row, a Watchlist lid, an archive line) is **not** a Film. It stays in its domain until a typed proof admits it.
- A canonical Film is created only by an existing admission writer. This ADR adds no writer.
- `inWatchlist`, `available`, `watched`, `rated`, `predicted` and `metadataComplete` are **orthogonal facts or derived views**. None is a stage of existence. Losing one never removes the Film.
- A merge leaves a `film_redirect` and keeps every fact readable through the survivor. A retirement keeps the retired claim as evidence. Neither erases history.

### 2. The aggregate is a read-only composition, `FilmAggregateV1`

The aggregate is computed per request over the existing safe readers. It is not a new table, writer or authority (subject to choice B).

| Section | Authority read | Freshness token | Absent means |
| --- | --- | --- | --- |
| `identity` | D1 `film`, `film_external_id`, `film_redirect`, `tmdb_retirement_decision` | Film/Person marker generation | the typed id names no Film (`404`) |
| `display` | D1 `film_metadata`, localization sources, credits; per-field provenance of ADR 0214 once delivered | metadata row `updated_at`, PF version | field `absent` with provenance, never guessed |
| `watchlist` | ADR 0203 authority: `watchlist_current.version` and `watchlist_member`, or the EPG generation while the marker is `epg` | membership version and projection lag | `member:false` only from a complete snapshot; otherwise `unknown` |
| `availability` | published EPG generation and its pin | `programmeRunId`, `generation` | no current show; the Film still exists |
| `personal` | ratings domain D1 (`ratings_view`, `ratings_document` facts, Diary history) | ratings generation and document etags | `unknown`; a missing Diary entry is not "unwatched" |
| `predictions` | prediction domain D1 `prediction_pointer` and `prediction_lineage`; bodies in immutable R2 objects | prediction generation | `none`; never read from `prediction_current` as authority |
| `history` | existing `GET /api/enrichment/history` chronology, paged lazily | its cursor digest | as that route defines |

Every section carries `status` of `present`, `absent`, `unknown`, `unavailable` or `partial`, plus `source` and `asOf` or `version`. Example for a Film whose ratings domain is held:

```json
{
  "contract": "film-aggregate/v1",
  "identity": {
    "status": "present",
    "filmId": "film:tmdb:41009",
    "requested": {"scheme": "tmdb", "value": "41009"},
    "redirectedFrom": null,
    "claims": [
      {"scheme": "tmdb", "value": "41009", "trusted": true},
      {"scheme": "letterboxd", "value": "10oS", "trusted": true}
    ],
    "permalink": "/film/tmdb_41009",
    "generation": 2
  },
  "display": {"status": "partial", "missing": ["runtime"], "source": "d1:film_metadata"},
  "watchlist": {"status": "present", "member": true, "lids": ["10oS"], "version": 57, "lagVersions": 0},
  "availability": {"status": "present", "current": [], "generation": "…"},
  "personal": {"status": "unavailable", "reason": "ratings_held"},
  "predictions": {"status": "present", "current": {"storageId": "10oS"}, "lineageCount": 3},
  "history": {"status": "present", "href": "/api/enrichment/history?filmId=tmdb_41009"}
}
```

### 3. Identity resolution is bounded and typed

- Input is one typed id: `tmdb_<n>`, a lid, or `film:<id>`. A title, year or slug is never an input.
- Redirects are followed at most `CANONICAL_REDIRECT_DEPTH` hops with cycle detection, as in the dormant read model.
- Verdicts: `found`, `absent`, `retired`, `conflict`, `unavailable`. `conflict` and `retired` are terminal for the request and return no domain sections. `unavailable` of the identity domain is a `503`, never an empty Film.
- Storage ids per domain stay as stored (`tmdb_<n>`, lid). The resolver returns the **set of verified storage ids** of the survivor, each with its proof. Domain readers query that set. Nothing is renamed or rewritten.
- The four corrected TMDB TV identities resolve through `tmdb_tv` and their retired movie id stays an untrusted claim. A `tmdb_<n>` request for a retired movie id answers `retired`, never the TV Film silently.

### 4. Optional domains fail per section

Identity is the only fatal section. A held, unreadable or generation-moving optional domain marks its own section `unavailable` with the typed reason and leaves the rest. A section is never filled from a historical snapshot or a mirror unless an accepted degraded-read rule ([ADR 0177](0177-read-only-mirror-fallback-for-film-and-programme.md)) already allows that mirror for that domain.

### 5. Consistency guard

Each domain read captures its generation or version before and after. A move inside one section marks that section `unavailable` with `generation_moved`. Sections are **not** required to share a cross-domain snapshot, because the domains have independent writers. The response says so with per-section tokens. A cursor over the aggregate's history is the history route's own digest.

### 6. Cost and side effects

- One Film costs a fixed number of bounded point reads: identity (at most redirect depth plus one), metadata, membership, availability, ratings, predictions. No per-Film N+1 and no unbounded cross-domain join.
- A batch of ids reuses the chunked reads of the dormant read model (80 ids per query, 200 ids per call).
- The route is a pure GET under [ADR 0107](0107-get-head-read-side-effect-boundary.md) and must pass `tests/get-write-audit.mjs`. It repairs and enqueues nothing.

### 7. Reuse of the existing consumers

| Consumer | Role after this ADR |
| --- | --- |
| `GET /api/catalog/film/<tmdbId>` | Unchanged. It remains the public catalog permalink reader. A later card may let it embed `FilmAggregateV1` sections. |
| `GET /api/enrichment/history` | Unchanged route. Its bridge gains the multi-lid rule only through choice C. |
| `GET /api/d1/films/<id>` | Stays an operator view. Its docs must say it reads schema v1 `actual_rating` and `prediction_current`, not the authoritative personal and prediction facts. |
| `src/canonical-read-model.js` | Reused for identity, redirects and display. It stays inactive until an implementation card activates it. |
| `src/catalog-d1.js` | Unchanged. |

## Owner choices

Each choice is independent. Recommendations are the Executor's and need the Coordinator's own assessment under the facilitation protocol.

### A. Creating a Film without a TMDB movie id

- **A1. Not now.** Only the existing TMDB-proved admissions create Films. A verified lid with no TMDB stays a Letterboxd observation. Simplest; such a film never gets a page.
- **A2. Proof-gated lid-only admission as a future slice.** A Film may be created from a page-checked lid (ADR 0213 `exists` plus a page check) with no TMDB claim. Its permalink is `/film/<lid>`. A TMDB claim found later is attached to the same Film, never a second Film. Needs its own card and writer under ADR 0207.
- **A3. Owner-only creation.** Only an owner action creates a lid-only Film.

**Recommendation: A1 now, with A2 recorded as the intended direction.** The census shows no live case.

### B. Where the aggregate is computed

- **B1. On-demand composition per request.** No new table. Fresh by construction.
- **B2. Materialized aggregate table with its own writer.** Cheap reads, but a new writer, a new authority question and staleness.
- **B3. Hybrid.** On-demand for one Film; a separate list and search projection later.

**Recommendation: B3.** One-Film detail uses B1 now. A list or search projection is a separate future ADR once a load profile exists.

### C. Several trusted lids for one Film

- **C1. Keep the strict single-lid bridge.** A multi-lid Film reads only its requested id.
- **C2. Read every verified lid.** Each storage id contributes its own history with its own identity prefix. Conflicting current values are reported, never chosen.
- **C3. Read every verified lid, and pick one current value by a fixed rule.**

**Recommendation: C2.** It matches ADR 0203 and drops no supported history.

### D. Response contract when an optional domain fails

- **D1. Strict.** Any optional domain failure fails the whole response.
- **D2. Per-section status.** Identity is fatal; other sections degrade with a typed reason.

**Recommendation: D2.**

### E. Cross-domain consistency

- **E1. Per-section tokens only.** Each section is internally consistent and names its version.
- **E2. Retry until all domains are stable within one window.** Stronger, but costs extra reads and can starve.

**Recommendation: E1.**

### F. Migration and cutover

- **F1. Additive route first.** A new internal route returns `FilmAggregateV1`; consumers switch one by one on separate cards.
- **F2. Replace `/api/d1/films/<id>` in place.**

**Recommendation: F1.** No production reader switches without its own card.

## Invariants

1. No Film is deleted or hidden because a fact is missing.
2. No section reports `false`, `0` or an empty list unless its authority proved it; otherwise `unknown`.
3. No title, year or slug match links data to a Film.
4. A historical storage key is never renamed.
5. A `retired` or `conflict` identity returns no personal, prediction or availability data.
6. The read writes nothing.

## Typed errors

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 400 | `invalid` | not a typed id |
| 404 | `absent` | no Film holds the id |
| 409 | `conflict` | several Films or a conflicting claim hold the id |
| 410 | `retired` | the id was retired by an owner decision |
| 503 | `unavailable` | the identity domain cannot answer; `reason` names the marker state |

## Synthetic test plan

Every case asserts no false `404`, no false rating and no false prediction.

1. Prediction stored under a lid, requested by `/film/tmdb_<n>`: the prediction is present with `storageId` = lid.
2. One Film with two trusted lids: both histories appear; differing current ratings are reported as a conflict (choice C2).
3. Rated-only Film with no shows: `availability.current` is empty and the Film is `found`.
4. Film that left the Watchlist and came back: membership follows the version, retention keeps the Film between.
5. The four corrected TMDB TV identities: the TV Film resolves, the retired movie id answers `retired`.
6. Conflict, retirement and merge: redirect followed; conflict and retired return no domain data.
7. Ratings domain held: `personal` is `unavailable`, other sections present.
8. EPG generation moves during the read: `availability` is `unavailable` with `generation_moved`.
9. Partial metadata: `display` is `partial` with the missing fields named.
10. Stale membership projection: `watchlist.lagVersions` above zero and `member` taken from the authority, not the projection.
11. The GET write audit passes for the new route.

## Delivery graph (each a separate card, none authorized by this ADR)

1. Docs correction for `/api/d1/films/<id>` limits (can go first, no code).
2. Bounded identity resolver returning verified storage ids (offline code and tests).
3. Multi-lid history bridge, if C2 is chosen.
4. `FilmAggregateV1` internal route behind the Film/Person marker (F1), with the synthetic tests.
5. Consumer adoption, one consumer per card.
6. Lid-only admission writer, only if A2 is chosen later.
7. List and search projection ADR, only after a load profile.

## Rollback and fencing

The aggregate writes nothing, so rolling back its code restores the previous readers exactly. Every section reads behind its own domain marker, so a held domain fences its section. No data, marker, flag or Scheduled Task changes with this ADR.

## Out of scope

UI and global catalog pages; new migrations or schema; identity migration or renaming of storage keys; backfill, repair or cache population; changes to ADR 0214 or 0215; changing the permalink rules of AIR-387; any production reader switch, flag or Task change.

## Consequences

- One documented shape answers "everything about this Film" without a new authority.
- Readers stop treating schema v1 `actual_rating` and `prediction_current` as complete.
- Lid-only Films stay unsupported until choice A changes.
- Each section names its own freshness, so the caller sees lag instead of a false value.
