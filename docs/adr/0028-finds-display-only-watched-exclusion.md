# ADR 0028: Finds hide an export film without a proven identity only by a strict, display-only title-and-year match behind an off-by-default switch

**Status:** Proposed (design only; it authorizes no code activation, flag change, R2 or D1 write, upload, production read or Letterboxd request)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner approval of the strict strategy, recorded on [AIR-196](https://trello.com/c/cvVor8KO) on 2026-10-27; this record awaits review  
**Related work:** [AIR-196](https://trello.com/c/cvVor8KO), [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md), [AIR-197](https://trello.com/c/4lY20BgM) (implementation), [AIR-198](https://trello.com/c/9xpmq2fc) (rollout), [ADR-0009](0009-canonical-film-person-identity.md), [ADR-0011](0011-bounded-title-variants.md), [ADR-0023](0023-letterboxd-user-facts.md), [catalog API](../reference/api/catalog.md#watched-and-rated-films)  
**Supersedes:** None (it adds one display rule to the Finds read path; identity, facts and ratings keep their accepted rules)  
**Superseded by:** None

## Context

`GET /api/catalog/available` excludes a catalog film from Finds when the owner has watched or rated the same TMDB film, and it decides "the same film" only by trusted identity; titles, years and aliases are never compared ([catalog API](../reference/api/catalog.md#watched-and-rated-films)). The Letterboxd account export lists the owner's watched and rated films by `boxd.it` code, name and year only. 420 of them have an accepted identity and are stored as facts ([ADR-0023](0023-letterboxd-user-facts.md)); 2,040 do not. The only independent identity source, the Letterboxd film page, is blocked by a Cloudflare challenge, and no offline source proves a code ↔ TMDB link ([AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md)). As a result Finds still offer films the owner has seen; the owner's visual check found that the shown Finds were watched films.

The [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) separates two problems: proving identity, which must stay strict because a false link is persisted and feeds ratings and predictions, and hiding a seen film from one display list, where an error costs one hidden suggestion. Offline, a strict title-and-year rule covered 503 of the 560 unresolved films that have a catalog record, 145 of them with a strong forecast, and 4 of the 5 films the owner reported. These counts come from a private snapshot and still need a fresh production preflight.

## Decision

1. **Display only.** A *display exclusion* removes a catalog film from the `GET /api/catalog/available` response and nothing else. It never writes or implies a Letterboxd ↔ TMDB link, a fact, a rating, a `watched` value, a view-index entry, a prediction input or a taste-profile input. A title-and-year match is not identity evidence for [ADR-0009](0009-canonical-film-person-identity.md), [ADR-0011](0011-bounded-title-variants.md) or [ADR-0023](0023-letterboxd-user-facts.md), and no other route, writer or importer may read it as such. `GET /api/programme`, `GET /api/watchlist`, the enrichment routes and the scoring pipeline are unaffected.

2. **Input: one private derived list.** The rule reads one R2 object, `letterboxd/display-exclusion.json`, replaced only as a whole. It is built offline on the owner's machine from an owner-supplied Letterboxd export by a builder script in this repository, with no network request. It holds only what matching needs:

   ```json
   {
     "schemaVersion": 1,
     "kind": "letterboxd_display_exclusion",
     "rule": "strict_original_exact_year",
     "normalization": "normTitle_v1",
     "source": {"type": "letterboxd_export", "archiveSha256": "<64 hex>", "exportedAt": "<ISO date>", "baselinePlanSha256": "<64 hex>"},
     "builtAt": "<ISO time>",
     "counts": {"exportFilms": 0, "withIdentity": 0, "droppedNoYear": 0, "droppedExportNamesake": 0, "entries": 0},
     "entries": [{"title": "<normalized name>", "year": 2000}],
     "contentSha256": "<sha256 of the canonical JSON of entries>"
   }
   ```

   The builder includes a watched or rated export film only when it has **no** accepted identity, a year, and a normalized name that no other film of the same export carries in any year. It drops codes, ratings, dates, URIs and review text. Accepted identities are read from one verified baseline plan, the committed import plan whose hash `source.baselinePlanSha256` records; the builder refuses to run without it, so it cannot silently fall back to an empty identity set and put identified films back into the list. Because identified films are left out, the list is rebuilt from the newer plan after every import that adds identities. `normTitle_v1` is `normTitle` of [`src/letterboxd-match.js`](../../src/letterboxd-match.js); changing that function requires a new normalization tag, and the reader refuses a tag it does not know.

3. **The strict rule.** With the switch on and a valid list, a catalog record is excluded when all of the following hold, evaluated on every request against the pinned generation's catalog copy:
   1. The record has a verified identity (`canonicalIdentity` equals `tmdb:<tmdbId>`) and an integer `year`.
   2. The normalized **original** title of the record equals an entry's `title`, and the record's `year` equals the entry's `year` exactly. The localized title and aliases never produce a match.
   3. **Catalog uniqueness:** in the same catalog copy, no verified record of another TMDB film has that normalized key as its original title, localized title or alias, in any year. A remake, an earlier version or any namesake blocks the rule for every film with that name.
   4. **One entry, one film:** exactly one entry matches the record.
   5. **Identity wins:** the record's TMDB id has no trusted Letterboxd id in the sources the identity rule already reads (`metadata.json`, `watchlist.json`, the programme, a verified catalog record with a Letterboxd id). Such a film is decided by its identity alone: it is excluded if consumed, and otherwise shown. This also keeps the 420 imported films and any film with a later accepted identity out of the title rule.

   Anything that does not satisfy every condition is shown. The rule can only remove films from the response; it never adds one, reorders the rest or changes a prediction.

4. **Generation scope.** Nothing is precomputed or stored: matching runs per request on the pinned generation. A new generation is evaluated afresh, so a film can be hidden in one generation and shown in the next when a namesake enters or leaves the catalog. The list is not bound to a generation; the guards are.

5. **Switch and fail-open.** A Worker environment variable `FINDS_TITLE_EXCLUSION` enables the rule only with the exact string `on` (no trimming, case-sensitive; absent, any other value or a non-string is `off`), like the other gates in the [flag register](../reference/feature-flags.md). With the switch off the object is not read. With the switch on, a missing, unreadable, oversized or invalid list disables the rule for that request. Invalid means any of: an object larger than 2 MiB, checked from the R2 object size before the body is read or parsed; JSON that does not parse; an unknown `schemaVersion`, `kind`, `rule` or `normalization`; a `source` that is not exactly `letterboxd_export` with a 64-hex `archiveSha256`, a 64-hex `baselinePlanSha256` and a valid `exportedAt` date; an invalid `builtAt`; an entry without a non-empty title or an integer year in 1870–2100; two entries with the same title and year; more than 20,000 entries; `counts.entries` different from the number of entries; or a `contentSha256` that does not match. Then every film is shown and the route still answers `200`. Unknown provenance means show, never hide.

6. **Observable effect without private data.** The response gains one aggregate, `displayExclusion`: `{"state": "off" | "applied" | "unavailable", "excluded": <count>}`. It carries no title, code or id of an excluded film, and no hash of the list or of its source: an unkeyed hash of a private list is a stable fingerprint of the owner's watch history that could be correlated across deployments or checked against guessed datasets. `contentSha256` is used only inside the Worker for the integrity check and in the owner-approved preflight. Logs follow the same rule. Per-film samples for owner acceptance come from a separately approved preflight, not from this route.

7. **No writer.** The Worker only reads the list. There is no Worker route, MCP tool or scheduled task that writes it. Placing, replacing or deleting the object is an owner-approved, out-of-band R2 operation under its own runbook; the switch is changed only with separate owner approval.

### Risk model

| Error | Effect | Visibility | How this decision bounds it |
| --- | --- | --- | --- |
| False find (a seen film is shown) | The owner sees a film already watched; this is the current state | Visible at once | Reduced for unique original-title, same-year films; alias-only and ±1-year films stay shown by design |
| False suppression (an unseen film is hidden) | One suggestion is lost from Finds; no data changes | Invisible on the page | Original title only, exact year, uniqueness in the export and in the catalog, identity wins, aggregate count per response, switch off restores every film |

A false suppression remains possible for an unseen catalog film that shares its original title and year with a watched film absent from the catalog (for example, a short or a TV film). The guards measure uniqueness only within the export and the current catalog. The owner accepted this residual risk for a display list that can be switched off.

### Synthetic cases the implementation must pass

| Case | Expected |
| --- | --- |
| Unique original title, same year, unique in export and catalog | Excluded |
| Same name, a remake with another year in the catalog | Neither excluded |
| Same name, year ±1 | Not excluded |
| Match only through an alias or the localized title | Not excluded |
| Two export films with the same name in different years | Neither in the list, so neither excluded |
| Catalog TMDB id already has a trusted Letterboxd id (an imported film) | Title rule not applied; identity decides |
| Two entries match one record | Not excluded |
| Record or entry without a year | Not excluded |
| New generation adds a namesake of an excluded film | Shown in the new generation |
| List missing, unreadable, unknown version or tag, bad checksum, oversized | `state: "unavailable"`, every film shown, `200` |
| Switch off with a valid list present | `state: "off"`, object not read, every film shown |
| Excluded film | Absent from `films`; counted in `displayExclusion.excluded`; no R2 write |
| Any state | The response and logs carry no title, code, list hash or source hash |
| Object above 2 MiB | `unavailable` without reading or parsing the body |
| Duplicate entry, wrong `counts.entries`, malformed `source` or `builtAt` | `unavailable`, every film shown |

## Alternatives considered

- **Relaxed rule with a year difference of one.** It covered 514 rather than 503 films in the [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md), still not the fifth reported film, and widens false suppression. The owner chose the strict rule.
- **Alias and localized-title matches.** They would catch the fifth reported film but match on titles that many films share; rejected.
- **Writing a Letterboxd ↔ TMDB link or a fact from the title match.** It would persist an unproven identity into ratings and predictions, contrary to [ADR-0009](0009-canonical-film-person-identity.md) and [ADR-0023](0023-letterboxd-user-facts.md); rejected.
- **Precomputing excluded ids per generation.** It needs a writer and a binding between list and generation, and adds stale state; a per-request match over two bounded sets is cheap. Rejected.
- **Hashing entries.** A hash of a normalized title and year is reversible against the catalog, so it gives no real privacy and complicates review; the object stays private in R2 instead. Rejected.
- **Compiling the list into the Worker or a secret.** It would put private data in GitHub or overload a secret meant for credentials; rejected.
- **Matching in the browser.** It would ship the list to the client and duplicate the rule; rejected.
- **Owner confirmation per film.** The owner declined it at this scale.
- **Waiting for identity resolution.** The film-page resolver is blocked; it stays the path for identity, and this rule does not replace or unblock it.

## Consequences

- Finds stop offering most seen films that have a unique original title, without touching identity, facts, ratings, the watchlist or predictions.
- Finds gain a second, weaker exclusion source. It must stay visibly separate from identity in code, tests, the API contract and the [Letterboxd ingestion diagram](../architecture/letterboxd-ingestion.md), which the implementation updates.
- One more R2 read and an integrity check per request while the switch is on; the list is bounded at 2 MiB and 20,000 entries.
- A false suppression is invisible to the owner on the page. The aggregate count, the rollout preflight and the switch are the controls.
- The list must be rebuilt after each export or identity import; a stale list misses films watched after its export and keeps hiding what it already matches.
- Films matched only through an alias or with a different year stay in Finds until identity is proven.

## Recovery and migration boundary

Fully reversible. Setting `FINDS_TITLE_EXCLUSION` to anything other than `on` restores every film on the next request; deleting the object makes the rule `unavailable` with the same effect; reverting the code removes it. No other data is written, so nothing needs restoring. This ADR authorizes none of the following, each of which needs its own owner approval: merging an implementation, building the list from the real export, uploading or deleting the object, any production read for the preflight, and changing the switch.

## Evidence

- **Original decision:** owner approval of the strict strategy on [AIR-196](https://trello.com/c/cvVor8KO), 2026-10-27.
- **Implementation:** none; planned in [AIR-197](https://trello.com/c/4lY20BgM) behind the off-by-default switch.
- **Dated verification:** offline estimate in the [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) (private snapshot, not production).
- **Uncertainty:** the effect on the current Finds and the false-suppression rate on fresh production data are not measured; uniqueness outside the export and the catalog is not checked; the export does not say whether an entry is a film or a series.

## Follow-ups

- [AIR-197](https://trello.com/c/4lY20BgM): offline builder, read-path rule behind `FINDS_TITLE_EXCLUSION`, synthetic tests above, catalog API contract, flag register and diagram.
- [AIR-198](https://trello.com/c/9xpmq2fc): owner-approved preflight, upload, switch change and visual acceptance.
- Identity for the 2,040 unresolved films remains open ([AIR-185](https://trello.com/c/PKvrDGKZ), [AIR-187](https://trello.com/c/JWCpAsY3)).
