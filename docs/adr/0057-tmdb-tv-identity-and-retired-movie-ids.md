# ADR 0057: A TMDB TV entry is a typed `tmdb_tv` identity, and a confirmed retired TMDB movie id leaves the trusted identity

**Status:** Proposed  
**Original decision date:** 2026-10-30 (direction chosen by the owner on [AIR-290](https://trello.com/c/70ldvbUB); acceptance pending)  
**Recorded at:** 2026-10-30  
**Approval source:** not yet decided; the owner's ADR decision gate applies before merge  
**Related work:** [AIR-290](https://trello.com/c/70ldvbUB) (this contract and offline tooling); [AIR-291](https://trello.com/c/OWV3rL9q) (the production correction); [AIR-286](https://trello.com/c/EswNQuv8) (TMDB credits for watchlist Films, where the retired ids surfaced); [AIR-275](https://trello.com/c/4x7hH0gI) (D1); [ADR 0009](0009-canonical-film-person-identity.md); [ADR 0051](0051-d1-domain-r2-blobs.md); [ADR 0052](0052-letterboxd-slug-film-alias.md); [contract](../reference/domain/film-person.md#tmdb-tv-identity-and-retired-movie-ids)  
**Supersedes:** None  
**Superseded by:** None

## Context

Every stored TMDB id of a Film is a movie id. Letterboxd's page attributes `data-tmdb-id`/`data-tmdb-type` feed `parseFilm`, which keeps only the number. The lifecycle projection, discovery, the catalog keys `tmdb_<n>`/`film:tmdb:<n>`, `linkFilms` and the D1 unique index on trusted `(scheme, value)` all treat that number as a movie id.

During AIR-286, four watchlist miniseries had a TMDB movie id that answers `404`. The ids are 17266, 101915, 378779 and 452736, for lids 1IUo, 3tCe, daU4 and g97G. TMDB moved these miniseries to TV entries: tv/9687, tv/8042, tv/64099 and tv/1457. Their Letterboxd pages still carry the retired movie id in the attributes, but the TMDB link the pages show names the live TV entry. The owner confirmed the four TV entries. AIR-286 used the TV entries as a credits source only, so the stored identity still names the retired movie.

Writing the TV number into the existing `tmdb` slot is unsafe, for three reasons:

- **Numbers overlap.** TMDB movie and TV ids are separate namespaces that reuse the same numbers. Movie 9687 is a different title from tv/9687.
  - Discovery (`knownTmdb`) would attach an EPG showing verified as movie 9687 to the miniseries.
  - `readLifecycle` and `linkFilms` would link the Film to a catalog record of movie 9687, or report a collision.
  - The D1 unique index would refuse one of the two Films.
- **Sync reverts the value.** The metadata refresh re-parses Letterboxd and writes the retired movie id back.
- **A partial edit mints a conflict.** If metadata, watchlist and programme disagree, the reader mints `film:conflict:…`.

## Decision

1. **A separate scheme, separate namespace.**
   - A TV entry is an `externalIds` entry `{scheme: 'tmdb_tv', value, trusted, conflicting, provenance}`.
   - A `tmdb` value and a `tmdb_tv` value are never compared. An equal number in the two schemes is neither evidence that two records are one Film nor a collision. It is reported only as a numeric overlap.
   - A trusted `tmdb_tv` held by two Films is a collision for owner review, never a merge.
   - D1's existing unique index on trusted `(scheme, value)` already keeps the two namespaces apart, so no schema change is needed.
2. **The TMDB link is read from the page and compared with the attributes.**
   - `letterboxdTmdbLink(html)` returns the single visible `https://www.themoviedb.org/(movie|tv)/<id>` link of a Letterboxd film page, typed. Only an anchor's `href` counts.
   - It resolves only when exactly one link agrees with exactly one attribute pair.
   - These cases go to review: a link that disagrees with the attributes, several links, contradictory or missing attributes.
   - A page with no link stays unresolved.
   - The parser never corrects a Film. A disagreement is evidence, not a fix.
3. **A retired movie id leaves the trusted identity only through an owner-confirmed retirement.**
   - A retirement names one Film: Film id, lid, movie id and TV id.
   - It carries the evidence:
     - the movie `404` and when it was observed;
     - the Film's Letterboxd permalink and the single TV link it showed;
     - the fetched TV entry of the same id.
   - It also carries the owner's confirmation.
   - `applyTmdbRetirement` applies a valid retirement to its own Film and to nothing else:
     - **The movie id is kept, not trusted.** It stays as an untrusted `tmdb` entry whose provenance records `status: retired`, the reason, the evidence, the confirmation, the replacement and the provenance it replaced. Nothing is deleted.
     - **The TV entry becomes the identity.** It is the trusted `tmdb_tv` identity, with provenance from the Letterboxd link and the confirmation. `canonicalIdentity` becomes `tmdb_tv:<id>`. The identity dimension stays `resolved` and records both ids.
     - **Everything else is kept.** The Film id, lid, slug alias, aliases, localization, fingerprint, prediction, prediction history and redirects are unchanged.
     - **A repeat is a no-op, and only an exact one.** The result depends on the Film and the retirement only, not on the time of the run. A Film carrying exactly that result is returned unchanged. Exactly means: both entries with their full provenance, the canonical identity, and the identity dimension's version and ids. Any other trace of a correction is refused as partial.
     - **Any other state is refused, not repaired.** That covers a different Film, lid, movie id or TV id, a conflict, a half-applied correction and an unresolved identity.
   - Retirement is never inferred for other Films from a disagreement between the link and the attributes.
4. **Where the retirement lives.**
   - The retirement entries are one owner-approved R2 object, `identity/tmdb-retirements.json`. R2 stays authoritative ([ADR 0051](0051-d1-domain-r2-blobs.md)).
   - The records keep the movie id Letterboxd shows. A later metadata refresh therefore cannot restore the retired id as trusted, because the projection applies the retirement over whatever the records say.
   - In D1 the corrected Film holds:
     - the untrusted retired `tmdb` row;
     - the trusted `tmdb_tv` row;
     - `canonical_identity = 'tmdb_tv:<id>'`.
5. **Consumers.**
   - Movie-only consumers keep reading only scheme `tmdb`, so they never receive a TV id under a movie id: discovery, catalog keys, posters, Wikidata P4947 and the model's TMDB URI.
   - A credits reader uses a trusted `tmdb_tv` as the Film's TMDB entry. `scripts/tmdb-watchlist-credits.mjs` does this already, so a D1 reload replays the four Films from the saved TV entries without asking the retired movie endpoints.

Delivered by this record:
- the pure contract `src/domain/tmdb-tv-identity.js`, outside the Worker bundle;
- the offline planner `scripts/tmdb-tv-identity-plan.mjs` for the four confirmed Films;
- the credits replay rule.

Not decided or delivered here:
- **The runtime integration**, a separate card. It covers:
  - `parseFilm` keeping a typed `tmdbLink`;
  - the field surviving metadata refresh and reaching `metadata.json`, `watchlist.json`, `programme.json` and the lifecycle reader;
  - the projection applying `identity/tmdb-retirements.json`;
  - `tmdb_tv` reaching D1 through the Film projection;
  - every movie-only path checked against TV ids;
  - the AIR-275 enrichment projector ([ADR 0056](0056-d1-enrichment-write-through.md)) carrying the corrected identity. That projector owns each Film's row, external ids and identity dimension and rewrites them from R2. It must project the Film with the retirement applied, or its next run reverts a D1-only correction.
- **The production correction** of the four Films in R2 and D1 ([AIR-291](https://trello.com/c/OWV3rL9q)).
- **Whether `tmdb_tv` is ever derived** without an owner confirmation.

## Alternatives considered

- **Replace the movie number with the TV number under `tmdb`.** Rejected for the reasons in Context: the namespaces collide, sync reverts the value, and a partial edit mints conflicting Films.
- **A `type` field on the `tmdb` entry instead of a new scheme.** Rejected. Every existing reader, the reader's linking and the D1 unique index key on `(scheme, value)`, so a type field would leave the collision in place. A scheme keeps it out by construction, as `letterboxd_slug` does ([ADR 0052](0052-letterboxd-slug-film-alias.md)).
- **Mark the retired movie id `trusted: false` only.** Rejected as insufficient. The projection rebuilds trust from the records on every read, so the retirement must be a stored, applied fact. The canonical identity and the identity dimension must also stop naming the retired movie.
- **Correct every Film whose link disagrees with its attributes.** Rejected by the owner. A disagreement is review evidence; only the four confirmed cases are retired.
- **An owner-maintained list of TV ids for credits only** (the first AIR-286 iteration). Rejected as not scalable; replaced by reading the Letterboxd link.

## Consequences

- Miniseries can be a Film with a typed, verifiable TMDB identity, without any risk of being matched to a movie of the same number.
- A retired movie id stays visible with its evidence, so the change is auditable and reversible.
- Until the runtime integration ships, R2 and the lifecycle projection still produce the retired movie id as trusted. AIR-291 must not run before the runtime card is delivered, or the next projection undoes the correction. This applies above all to the ADR 0056 projector: it rewrites the external ids and `canonical_identity` of every changed Film from R2.
- Once the projection applies the retirement, D1 follows R2 through the projector. The planner writes nothing. It states each Film's expected D1 identity, and `d1Readback` checks D1 against it. There is no hand-written D1 write path to race the projector.
- `catalogReady` and the other readiness rules keep working, because the four Films keep their Letterboxd lid. Readers that need a TMDB entry must learn `tmdb_tv`; that is part of the runtime card.

## Recovery and migration boundary

Code and documentation only. Nothing in this record writes R2 or D1, sends a request, or changes a flag, Scheduled Task or binding. Reverting the code removes unused offline tooling.

The production correction is AIR-291, with its own preflight, fenced R2 snapshot, D1 Time Travel bookmark and owner approvals. It is reversible:
- R2 by deleting the retirement entries;
- D1 by the next projector run after the R2 rollback, checked by `d1Readback`. A Time Travel restore to the bookmark is a separate, separately authorized whole-database recovery that also discards every later D1 write.

The retired movie ids are never deleted. This record authorizes no operation.

## Evidence

- **Original decision:** owner direction on [AIR-290](https://trello.com/c/70ldvbUB) on 2026-10-30: option (a) as the target architecture, AIR-290 offline-only, runtime integration and AIR-291 separate.
- **Implementation:** `src/domain/tmdb-tv-identity.js`, `scripts/tmdb-tv-identity-plan.mjs`, `scripts/tmdb-watchlist-credits.mjs`, `tests/tmdb-tv-identity.mjs`, `tests/tmdb-watchlist-credits.mjs`.
- **Dated verification:** the four retired movie ids and TV links were observed in the AIR-286 run on 2026-10-30, recorded on [AIR-286](https://trello.com/c/EswNQuv8). The offline dry-run against a fresh snapshot and D1 is a separately approved step.
- **Uncertainty:**
  - how many other watchlist Films have a retired movie id is unknown; only these four failed in AIR-286;
  - whether Letterboxd ever updates its attributes for such pages is unknown.

## Follow-ups

- Runtime integration card (to be created with the coordinator).
- [AIR-291](https://trello.com/c/OWV3rL9q) production correction.
