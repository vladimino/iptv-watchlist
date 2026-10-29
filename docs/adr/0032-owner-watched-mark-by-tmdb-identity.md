# ADR 0032: The owner's "watched" mark on a verified catalog film is an owner fact keyed by that film's TMDB identity, with no Letterboxd id and no title matching

**Status:** Accepted 2026-10-27 (owner-approved design only; it authorizes no route, button, flag, R2 or D1 write, and no Letterboxd or TMDB request)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner proposal of a manual «Смотрел» mark after the AIR-198 rollout, recorded on [AIR-198](https://trello.com/c/9xpmq2fc) and scoped as [AIR-213](https://trello.com/c/VbE31Rzj); owner explicitly accepted this design on 2026-10-27  
**Related work:**
- [AIR-213](https://trello.com/c/VbE31Rzj) (this decision), [AIR-214](https://trello.com/c/dX5YZlFY) (implementation), [AIR-198 rollout evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md)
- [ADR-0023](0023-letterboxd-user-facts.md), [ADR-0024](0024-letterboxd-scan-summary.md), [ADR-0028](0028-finds-display-only-watched-exclusion.md), [ADR-0009](0009-canonical-film-person-identity.md), [ADR-0027](0027-owner-rating-tmdb-identity.md)
- [Letterboxd user facts contract](../reference/integrations/letterboxd-user-facts.md), [catalog API](../reference/api/catalog.md)

**Supersedes:** [ADR-0023](0023-letterboxd-user-facts.md) in part: the boundary that every fact record carries a Letterboxd id. This record allows one owner-only writer to create a record with only a trusted TMDB alias.  
**Superseded by:** [ADR-0042](0042-retire-finds-watched-mark-switch.md) (Proposed) in part: the mark's own switch in decision 6 is retired; the `LETTERBOXD_FACTS` gate and every other guard stay

## Context

Finds offer verified catalog films (`tmdb_<n>` records with `canonicalIdentity` `tmdb:<n>`) that the owner has neither watched nor rated, judged by identity ([catalog API](../reference/api/catalog.md#watched-and-rated-films)). The owner's watched films reach that check only as Letterboxd fact records ([ADR-0023](0023-letterboxd-user-facts.md)).

2,040 watched films from the export have no accepted Letterboxd ↔ TMDB identity. The only independent identity source, the Letterboxd film page, is blocked by a challenge, and the general identity bridge is not being pursued now.

The display-only title exclusion ([ADR-0028](0028-finds-display-only-watched-exclusion.md)) hides about 478 of them with no observed false hide. After the rollout, though, all five films at the top of Finds were films the owner had seen ([AIR-198 evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md)). They fail the strict rule by design: an alias-only match, a year off by one, a namesake in the export, or a namesake in the catalog.

The owner is the one source who knows for certain whether they have seen the film on a given card. That card already names one verified TMDB film.

Today's facts code cannot record that statement. `linkFilm` refuses a record without a Letterboxd id (`invalid_identity`). The owner rating edit (`PUT /api/enrichment/actual-ratings`) takes a stored film id and a rating, not a catalog film and a watched value. The contract's identity boundary assumes every writer knows a Letterboxd id.

## Decision

1. **What the mark is.** An owner assertion about one verified catalog film: "I have watched this film" (`watched: true`) or "I have not" (`watched: false`, the revocation). It is a fact observation with `source: owner` under the existing merge order (`observedAt`, source rank, `observationId`). It changes only the `watched` fact. It never sets, clears or infers a rating, never touches `watchlist`, and never writes a prediction, a fingerprint, the taste profile, a Film/Person record or the catalog.

2. **Identity comes from the card, never from a name.** The request names exactly one film by its TMDB id (`tmdbId`, digits only). The Worker accepts it only when the **published generation's catalog copy** holds a verified record for it: `tmdbId` equal to the id and `canonicalIdentity` exactly `tmdb:<id>`.
   - That record must not be an observation key or a record with a conflicting identity.
   - Titles, years, aliases, localized titles, a Letterboxd id or slug, and any other field in the request are never read for identity. A request that carries anything other than the allowed fields is refused.
   - Without a published generation, or without such a record, nothing is written (`409 film_not_in_catalog`). The UI then reloads Finds.
   - The trusted TMDB alias of this decision is the catalog's verified identity confirmed by the owner. It is not a Letterboxd identity, and no Letterboxd ↔ TMDB link is created or implied.

3. **Where the fact is stored.** One fact record per film, as in ADR-0023, found through the link index by the alias `tmdb:<n>`:
   - If `tmdb:<n>` already points at a record (`tmdb-<n>`, or an `lb-<lid>` record that carries this trusted TMDB link), the observation goes to that record, following a redirect or fence as every writer does.
   - Otherwise the writer creates `tmdb-<n>` with `links: {"tmdb": "<n>"}` and adds `tmdb:<n>` to the link index by compare-and-swap. This is the only writer allowed to create a record without a Letterboxd id.
   - A later writer that knows both `letterboxd:<lid>` and the same trusted `tmdb:<n>` adds the Letterboxd alias to that record through the existing `linkFilm` rules, which already accept a writer's trusted TMDB link (for example a watchlist film's stored TMDB id); this decision adds no new way to form such a link, in line with the pause on new cross-source links until [AIR-201](https://trello.com/c/1uvzKiGg). If that Letterboxd id already has another record, the pair is the existing `alias_conflict` for the identity review and its convergence migration ([contract](../reference/integrations/letterboxd-user-facts.md#writes-and-convergence)). The owner mark never merges records.
   - The films-list and watchlist scans address records by Letterboxd id only. They therefore never write a TMDB-only record, and absence from a scan still changes nothing.

4. **Merge and revocation.**
   - **Time.** `observedAt` is the Worker's clock when the request is accepted; any client time is ignored.
   - **Order.** As an owner observation it outranks every other source at the same time, and a later observation from any source still replaces it.
   - **Revocation:**
     - `watched: false` from the owner replaces an earlier `watched: true` from any source, so a mistaken export or a mistaken click can be undone.
     - A later complete films-list scan that shows the film under a linked Letterboxd id sets `watched: true` again, because it is newer.
     - Revocation never deletes a record and never clears a rating. A film with an actual rating stays consumed in Finds whatever `watched` says, because rated films are excluded by rating (ADR-0023 rule 1).
   - **Idempotency:** a request whose value equals the record's current effective `watched` value (the greater of the stored value and any scan summary observation) is `unchanged` and writes nothing, whatever source holds it. A repeated click or a client retry therefore writes once. The record write is a compare-and-swap with bounded retries that re-read and re-apply the order. Two concurrent marks are ordered by their `observedAt`, so the later accepted request wins.

5. **Projection and persistence across EPG generations.**
   - After the record write, the fact is projected into `enrichment/view-index.json` as `watched` under every alias id of the record (`tmdb_<n>`, and the Letterboxd id once linked), exactly like the other writers' projections.
   - The record is not tied to a generation. A film that leaves the catalog and returns in a later generation is still watched, because Finds read the projection by TMDB identity.
   - The view index stays a projection: if it is rebuilt or loses an entry, re-projecting from the records restores the mark.
   - **Readers:** Finds need no new rule. `watched: true` under `tmdb_<n>` already excludes the film ([catalog API](../reference/api/catalog.md#watched-and-rated-films)), and the display-only title exclusion is unaffected.

6. **Authority and gates.**
   - The mark writes only through the fact records, so it requires `LETTERBOXD_FACTS=on`. It has no legacy path that writes the view index directly; with the facts gate off the route answers `409 facts_disabled`.
   - It also has its own switch, enabled only by the exact string `on`, absent by default. With the switch off the route answers `409` and writes nothing. The implementation names the switch and adds it to the [flag register](../reference/feature-flags.md).
   - R2 stays authoritative (ADR-0002); nothing is written to D1.

7. **Request safety.**
   - **Access:** the route sits behind the Worker's owner-only Cloudflare Access application like every `/api/` route.
   - **Request shape:** it accepts only `POST` with `Content-Type: application/json`. That content type cannot be sent cross-site without a CORS preflight, which the Worker never grants.
   - **Origin:** it requires an `Origin` header equal to the Worker's own origin. This is stricter than the shared check, which lets a request without `Origin` through.
   - **Body:** one film per request, with `tmdbId` and `watched` (boolean) only; any other field is refused.
   - **Not exposed elsewhere:** the route is not an MCP tool, not reachable from a Scheduled Task and not part of the baseline import route.
   - **Response:** the outcome (`saved`, `unchanged`, `older`) and the film's resulting `watched` value only, nothing else from the record.

8. **D1 mapping (future migration).** The fact becomes a row of `film_user_fact` with `fact = 'watched'` and `source = 'owner'`, under ADR-0023 decision 7. Its `film_id` is the canonical Film that holds the trusted TMDB external id `n` ([D1 schema](../reference/data/d1-schema.md)). The backfill resolves it like [ADR-0027](0027-owner-rating-tmdb-identity.md): exactly one trusted, non-conflicting holder. Otherwise the fact stays unresolved and is reported. The backfill never mints a Film from a TMDB-only fact record. This record changes neither the schema nor ADR-0019.

### What is not decided

- The UI: placement, wording, confirmation and undo affordance. That belongs to the implementation and its visual QA.
- Marking films outside Finds, or by Letterboxd id.
- Any rating entry from Finds.
- The general Letterboxd ↔ TMDB identity bridge, the convergence migration, and any change to ADR-0028.

### Specification cases the implementation must test

| Case | Expected |
| --- | --- |
| Verified catalog film, no record for `tmdb:<n>` | Record `tmdb-<n>` created with only the TMDB link; `watched: true` from `owner`; view index `tmdb_<n>.watched = true`; the film leaves Finds |
| `tmdb:<n>` already links an `lb-<lid>` record | Observation written to that record; view index updated under both ids |
| Same request twice, or a retry | Second is `unchanged`; one record write in total |
| Mark, then revoke | `watched: false` replaces `true`; the film returns to Finds if it has no rating |
| Revoke a film with an actual rating | `watched: false` stored; rating kept; film still excluded |
| Export said watched, owner revokes | Owner observation is newer and replaces it |
| Owner mark, then a newer complete films list shows the linked film | Scan observation replaces the mark (newer) |
| Film absent from a later films list or a 403 | Nothing changes |
| Two concurrent requests | Both compare-and-swap; the later `observedAt` is current; no lost write |
| TMDB id not in the published catalog copy, an observation key, or a conflicting record | `409 film_not_in_catalog`; nothing written |
| Request carrying a title, year, Letterboxd id or any extra field | `400`; nothing written |
| New EPG generation without the film, then one with it | Mark persists; film still excluded when it returns |
| Later writer links `letterboxd:<lid>` + `tmdb:<n>` where `lid` has no record | Alias added to `tmdb-<n>`; one record |
| Later writer links them where `lid` already has `lb-<lid>` | `alias_conflict` recorded for review; no merge; both projections still apply |
| `LETTERBOXD_FACTS` off, or the mark switch not exactly `on` | `409`; nothing written |
| Missing or foreign `Origin`, non-JSON content type, `GET`/`PUT` | `403`/`415`/`405`; nothing written |
| Response body | Only outcome and `watched`; no record, provenance or ids beyond the request |
| Finds, ratings, predictions, display-only exclusion | Unchanged apart from the excluded film |

## Alternatives considered

- **Reuse `PUT /api/enrichment/actual-ratings`.** It takes a stored film id and a rating, and a rating is not what the owner states here; it would also have to accept `tmdb_<n>` as a fact identity. Rejected.
- **Map the card to a Letterboxd id by title and year, then write a normal fact.** That is the identity bridge ADR-0023, ADR-0028 and [AIR-201](https://trello.com/c/1uvzKiGg) keep closed. Rejected.
- **A separate "hidden from Finds" list.** It would duplicate the watched fact, lose its provenance and ordering, and leave ratings, predictions and future readers unaware of it. Rejected.
- **Write the view index directly (legacy path when facts are off).** It would make a projection a source and could be overwritten by a re-projection. Rejected.
- **Key the record by the catalog record id (`tmdb_<n>`) rather than through the link index.** It would bypass alias uniqueness and later convergence. Rejected in favour of the existing `tmdb-<n>` key and `tmdb:<n>` alias.
- **Allow marking any TMDB id.** It would let a typo or a stale client write a fact for a film the owner never saw on a card. Rejected: only a verified record of the published catalog copy.

## Consequences

- Any film on a Finds card, including the ones the title rule cannot reach, can be removed by the owner in one action. The removal has proper provenance and stays reversible.
- Fact records may now lack a Letterboxd id. Every reader and writer that assumed one (scans, projections, convergence, rollback of imports) must handle a TMDB-only record, which AIR-214 tests.
- More `alias_conflict` pairs may appear when a watchlist or import later brings a Letterboxd id for a film the owner marked. They wait for the convergence migration, and both projections still exclude the film meanwhile.
- One more owner write route, with a stricter request guard than the shared one.

## Recovery and migration boundary

- **Code:** reverting it removes the route; stored marks remain valid fact records and keep their projection.
- **Disable:** setting the switch to anything other than `on` stops new marks.
- **Undo a mark:** the owner revokes it.
- **No bulk rollback:** none is defined, because each mark is a single owner observation. Removing marks in bulk would be a separately approved R2 operation.
- **Not authorized by this ADR:** merging an implementation, setting the switch, writing any production mark, and any D1 change. Each needs its own approval.

## Evidence

- **Original decision:** owner proposal, 2026-10-27, on [AIR-198](https://trello.com/c/9xpmq2fc); scope on [AIR-213](https://trello.com/c/VbE31Rzj).
- **Implementation:** [AIR-214](https://trello.com/c/dX5YZlFY): `POST /api/catalog/watched` (`catalogWatchedRoute` in `src/worker.js`), `linkTmdbOnly` and `recordOwnerWatchedMark` in `src/letterboxd-facts.js`, the Finds button in `public/app.js`, tests `tests/finds-watched-mark.mjs`; the switch is named `FINDS_WATCHED_MARK` and stays unset (off) until a separate owner approval.
- **Dated verification:** [AIR-198 rollout evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md) (five watched films remaining in Finds); code reading at `main` `0591589` (`linkFilm` refuses a record without a Letterboxd id; the owner rating route takes a stored id).
- **Uncertainty:** how often a later Letterboxd link will meet an existing `lb-<lid>` record and need convergence; the expected number of marks is small (cards the owner sees).

## Follow-ups

- [AIR-214](https://trello.com/c/dX5YZlFY): route, switch, UI, tests above, API reference, flag register and contract update.
- [AIR-215](https://trello.com/c/MC9Ku87Z): rollout under its own owner approvals.
- The convergence migration for `alias_conflict` pairs remains a separate task.
