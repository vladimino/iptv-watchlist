# ADR 0052: A Letterboxd film slug is a typed, untrusted alias of the Film that carries its lid

**Status:** Proposed  
**Original decision date:** 2026-10-30  
**Recorded at:** 2026-10-30  
**Approval source:** not yet decided; the direction ("keep the slug wherever it is known") was approved on [AIR-276](https://trello.com/c/PeWwEti8)  
**Related work:** [AIR-276](https://trello.com/c/PeWwEti8); [AIR-273](https://trello.com/c/TVB01Xm0) (Diary rows carry lid and film permalink); [AIR-51](https://trello.com/c/33d4hKJ3) and [ADR 0049](0049-letterboxd-diary-viewing-history.md) (diary slug observations); [AIR-193](https://trello.com/c/DqBF3HLy) (a slug is not the boxd.it lid); [AIR-275](https://trello.com/c/4x7hH0gI) (D1); [ADR 0009](0009-canonical-film-person-identity.md); [contract](../reference/domain/film-person.md#letterboxd-slug-alias)  
**Supersedes:** None  
**Superseded by:** None

## Context

A watchlist Film is stored under its Letterboxd `lid`. Its film permalink `https://letterboxd.com/film/<slug>/` is kept in `watchlist.json` as `url`, but the lifecycle projection and the D1 `film_external_id` rows carry only `letterboxd` (the lid) and `tmdb`. The slug is therefore lost wherever a Film is read as an entity. Diary rows (ADR 0049) observe a lid and a member permalink `/<member>/film/<slug>/` together. The slug is a different value from the lid (AIR-193), Letterboxd can rename it, and two records showing one slug do not prove they are one film.

## Decision

1. **A separate scheme.** A slug is an `externalIds` entry `{scheme: 'letterboxd_slug', value, trusted: false, conflicting, provenance}`. It is never stored under `letterboxd`, never as a title alias, never changes `id`, `canonicalIdentity`, the lid or TMDB trust, and is never a reason for `linkFilms` to link two records.
2. **Only from a proved permalink, only with a lid.**
   - `letterboxdSlugFromUrl` accepts `https://letterboxd.com/film/<slug>/` and `https://letterboxd.com/<member>/film/<slug>/`: same origin, no query, fragment or credentials, lowercased. Nothing is derived from a title, a lid or Wikidata.
   - A slug is attached only to a Film that has a lid: the Film's own permalink (programme, watchlist, then the record) is `current`; a diary entry with the same lid gives an `observed` slug. A TMDB-only Film, or a diary row without a lid, gets none.
   - Provenance: `source` (`letterboxd_film_url` or `letterboxd_diary`), `status`, the canonical `url` or the diary `entry`, and `observedAt`.
3. **Rename and collision.**
   - The lifecycle backfill keeps a slug's first `observedAt`. A stored slug the Film no longer carries stays as `historical`, so an old permalink still names the Film.
   - One slug on two Films is a collision: both entries become `conflicting`, the collision is reported (`aliasConflicts`), and nothing is merged, moved or re-rated.
4. **Storage-neutral.** The alias travels in the existing `externalIds` list, so the R2 lifecycle sidecars and the D1 `film_external_id` rows hold it without a schema change. `trusted: false` keeps it outside the D1 unique index on trusted identities. Under [ADR 0051](0051-d1-domain-r2-blobs.md) D1 is the future home of external ids; R2 stays authoritative until the Film domain's write flip. Once imported, the read-only `GET /api/d1/films/<id>` lists the alias with the other external ids.
5. **Offline inventory only.** `scripts/letterboxd-slug-inventory.mjs` counts what a snapshot's stored records would yield. It makes no request and writes nothing.

Not decided here:
- writing the lifecycle sidecars or D1 rows with slugs in production (a separate owner-approved materialization);
- any consumer that resolves a Film by slug;
- slugs for TMDB-only Films.

## Alternatives considered

- **Storing the slug under `scheme: letterboxd`**: rejected by the card; it would mix two different Letterboxd identifiers.
- **A title alias**: rejected; a slug is an identifier, not a display name.
- **Deriving a slug from the title**: rejected; unproved, and Letterboxd disambiguates slugs (`-1`, a year suffix).

## Consequences

- Every Film with a stored Letterboxd permalink or a diary row exposes its slug, with provenance.
- Renames stay resolvable through `historical` aliases, at the cost of a list that only grows.
- The first backfill after this change updates each Letterboxd Film sidecar once to add the alias; later replays are unchanged.

## Recovery and migration boundary

Code only. The Worker bundle gains the pure parser and functions, unused by any Worker route. A revert stops projecting slugs; any stored alias entries are inert data for readers that ignore the scheme. Writing sidecars or D1 rows is a separate owner-approved operation; this record authorizes none.

## Evidence

- **Original decision:** [AIR-276](https://trello.com/c/PeWwEti8).
- **Implementation:** `src/domain/film-person.js` (`letterboxdSlugFromUrl`, `markSlugCollisions`), `src/domain/film-person-reader.js`, `src/domain/film-person-backfill.js`, `scripts/letterboxd-slug-inventory.mjs`, `scripts/snapshot-store.mjs`, `tests/letterboxd-slug-alias.mjs`.
- **Dated verification:** [slug coverage on the 2026-10-29 fenced production snapshot](../evidence/letterboxd/air-276-slug-coverage-2026-10-30.md): all 394 lid Films carry a valid permalink and get a `current` slug; 2,008 TMDB-only Films get none; 0 collisions; read-only, no write or request.
- **Uncertainty:**
  - how often Letterboxd renames or reuses a slug is unknown;
  - no diary slug has been observed yet, because the diary history has not run in production.

## Follow-ups

- Production materialization of the alias, if wanted, as its own card.
- A D1 import of the alias with [AIR-275](https://trello.com/c/4x7hH0gI).
