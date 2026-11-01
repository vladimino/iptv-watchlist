# ADR 0081: Owner-reviewed titles and names are D1-authoritative only after their own marker is switched

**Status:** Proposed  
**Original decision date:** 2026-11-01  
**Recorded at:** 2026-11-01  
**Approval source:** not documented  
**Related work:** [AIR-314](https://trello.com/c/RBxi5Pcf), [ADR 0072](0072-owner-reviewed-localization-overlay.md), [ADR 0073](0073-metadata-cache-d1-authority.md), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0051](0051-d1-domain-r2-blobs.md)  
**Supersedes:** None. Acceptance would supersede, and only while `owner_review_authority.mode` is `d1`, the rejection of a D1 store in [ADR 0072](0072-owner-reviewed-localization-overlay.md). ADR 0072 stays the contract while the marker is absent or `r2`.  
**Superseded by:** None

## Context

Owner-confirmed Film titles and Person names live in one R2 object, `admin/owner-reviews.json`, contract version 1, with `films` keyed by the programme stored id and `people` keyed by the role-specific person id ([ADR 0072](0072-owner-reviewed-localization-overlay.md)). The Film route and the Person route each replace one map and copy the other. The storage compare-and-set is that object's R2 etag. The screen compare-and-set stays `title-review:1:…` or `name-review:1:…`. A reviewed owner value beats the dictionary and the automatic cache, and an EPG publication does not write the object.

The admin pin is version 2 and uses that etag as `reviewsVersion`. The hourly projector reads R2 and writes `film_dimension` and `person_dimension`. Its localization upsert already refuses to replace an `authority: owner` row with a dictionary value, but the view it builds prefers a verified dictionary title, so a dimension that does not yet hold the owner value can be written as the dictionary. Catalogue SQL then shows that dimension.

Production schema is v6. The metadata-cache marker is `d1`. Migration `0007` and [ADR 0078](0078-d1-authoritative-prediction-domain.md) are on `main` and are not applied. Migration `0008` and [ADR 0079](0079-d1-authoritative-published-epg.md) are on `main`, Accepted, and are not applied. Open [PR #318](https://github.com/vladimino/iptv-watchlist/pull/318) reserves ADR 0080. This record is 0081. A schema version is not proof that every domain table exists. There is no transaction that covers D1 and R2 together. Applying a migration, importing the object, and switching a marker are separate approvals.

## Decision

1. **Own tables, keyed by the source id.** Migration `0009_owner_review_authority.sql` adds `owner_review_entry`, `owner_review_authority` and `owner_review_cas`. `source_key` is the programme stored id or the role-specific person id. There is no foreign key to `film` or `person` and this migration inserts neither. `payload_json` is the slice already stored in the R2 map, including aliases, review history, conflicts and `roleLinks`. `identity_link` is optional. `identity_state` is `verified` only when one existing canonical row matches by id, trusted external id or redirect, and `held` otherwise. `tmdb` is not `tmdb_tv`. A title or a name is not a match. A missing canonical row does not drop the slice.
2. **One marker, default `r2`.** `owner_review_authority` is a single row. The migration inserts `mode` `r2`, generation 0 and `writes` `open`. `owner_review_cas` is the fence that fails a batch when the compare-and-swap matches nothing. It is not a Worker flag. Applying `0009` does not copy the object and does not set `d1`. The contract version moves forward to 9 only from a complete version 8, and it never goes down. The prerequisite is a version of at least 8 and below 9, all ten prediction tables, all nine published-EPG tables, and both authority rows. Version 6, version 7, a partial version 8, and any other contract are refused before any table is created. A later run does not rewrite a higher version: the refusal fires because the version is no longer below 9. Version 9 does not, by itself, prove that the prediction tables, the published-EPG tables, or these three tables are still present.
3. **Readers follow the marker, not the version number.** With no D1 binding, or with a contract that has no owner-review tables and is below version 9, Admin and the programme/watchlist reads keep today's R2 object. Version 9 without those tables, or a marker row that is missing or not `r2` or `d1`, fails closed and does not read the object. In `r2` after the tables exist, a save advances `generation` before the conditional put and does not write rows. In `d1`, both maps commit in one fenced batch at one generation. The R2 object is a mirror written after the batch. A failed mirror leaves the rows. A `d1` read uses the rows and does not fall back to the mirror, and it does not repair the mirror. That read takes the marker, the rows and the marker again. Mode, generation and writes must agree, and every row must carry that generation. One disagreement retries once. A second disagreement fails closed and does not read the mirror. A generation that advanced and is consistent on the retry is the generation the response reports. The rows are not labeled with the generation seen before that move. A whole-document commit or import that would exceed one batch — 950 statements, 1 MiB, or 90,000 bytes in one statement — is refused before any row is deleted.
4. **One revision for both maps.** In `d1` the pin's `reviewsVersion` is `d1:<generation>`, not the mirror etag and not a constant. A pin or cursor from the other mode does not match. A film edit and a multi-role person edit take the same generation, so one cannot publish a revision the other has not seen. The domain tokens, `requestId`, omitted-effect promote, `add_alias` and `promote` stay. The route reads the rows back. An uncertain read is 503 `readback_failed` or `commit_unknown`. A GET of Admin, programme, watchlist or the catalogue does not write the rows or the mirror.
5. **The overlay is not a new EPG generation.** A confirmed title or name does not write `epg/published-generation.json`, `programme.json`, a generation object, watchlist order, or published-EPG rows. Programme, watchlist, admin search and the D1 catalogue apply the owner slice onto the programme they already pinned. The same overlay result holds whether that programme was read from R2 or from a later D1 generation, whether the metadata cache is `r2` or `d1`, and whatever prediction mode is in force. A reviewed owner value replaces a disagreeing dictionary value. Alias-only slices do not replace the preferred text.
6. **The projector follows the same marker.** Before the tables exist it does not read the object. After they exist, `r2` reads the object and `d1` reads the rows. A failed `d1` read stops the run before a write. The owner localization is applied to the view the projector writes, so a dictionary title does not replace it. The projector still does not write the owner-review rows or R2.
7. **Import and revert are checked.** `scripts/owner-review-authority.mjs` prints status unless asked to write. It refuses a database path that names production and does not call the network. `--load` with `--confirm load` copies a local file. An empty document is allowed only when the get returns no object. A thrown read, a body that is not contract version 1, or a map that is not an object is refused and writes nothing. `--activate` with `--confirm activate` sets `d1` only when the generations match and the file still matches the rows. `--revert` with `--confirm r2` sets `r2` only after the mirror put of both maps succeeds. If the put fails, the mode stays `d1`. This record does not ship a production entry and does not authorize applying `0009`, loading the live object, or switching the marker.

Not decided here: applying `0009` to production, the live import, activation, revert, and any change to Cloudflare Access, Scheduled Tasks, feature flags, identity merge, or the published-EPG and prediction markers.

## Alternatives considered

- **Reuse the metadata-cache marker.** Rejected. That marker already means the metadata working set. An owner-title edit must not move it, and a metadata sync must not become the authority for a title.
- **Store the slice only on `film_dimension` and `person_dimension`.** Rejected. Those tables require a canonical row. Historical and orphan keys would be dropped, and a foreign key would mint a row the identity rules do not allow.
- **Keep the R2 etag as the pin after the flip.** Rejected. The mirror can lag. A pin that still matches the old etag would publish a mixed revision.
- **Fall back to the mirror when D1 is unread in `d1` mode.** Rejected. The mirror is the stale copy a failed put leaves behind.

## Consequences

Until `0009` is applied, production behaviour is unchanged: Admin writes `admin/owner-reviews.json` and the projector does not read it. After it is applied, and while the marker stays `r2`, Admin still writes that object, and the save claims `generation` first. The next projector run reads the object and can write an owner localization onto a dimension that previously held the dictionary. That is the existing projector following R2, not the authority flip. `/api/d1/status` gains `ownerReviewMode` and `ownerReviewGeneration` only when the three tables exist. Schema v6 without them does not gain those fields.

A later contract version no longer makes the metadata cache ignore a `d1` marker. The cache reader treats version 6 or later, with the cache tables and a valid marker, as the cache contract. Version 9 is not evidence that prediction or published-EPG tables exist.

Code rollback does not drop the tables, does not return the contract version, and does not change the marker. A Worker that only reads the R2 object, running while the marker is `d1`, would show a mirror that may lag.

## Recovery and migration boundary

Returning the marker to `r2` is `--revert` with `--confirm r2` and a mirror that matches the rows, or the equivalent fenced update, and is its own approval. A revert whose mirror cannot be written leaves the mode at `d1`. Unsetting `D1_ENRICHMENT_WRITE` stops the projector, not an Admin save. Restoring the database is a Time Travel of the whole database and is its own approval. This record does not authorize applying `0009`, importing, activating, reverting, a flag change, a cron change, or any production R2 or D1 write.

`0008` and ADR 0079 are on `main` and are not applied. The only supported order is `0007`, then `0008`, then `0009`. `0009` refuses version 6, version 7, and a partial version 8 before it creates a table. `0009` before `0008`, and `0007` after `0009`, are not supported paths. This delivery does not apply `0007`, `0008` or `0009`. Production apply of `0009` waits for a separate approval after that order is the one installed on the real tables.

## Evidence

- **Original decision:** [AIR-314](https://trello.com/c/RBxi5Pcf)
- **Implementation:** this record's pull request
- **Dated verification:** [local contract check, 1 November 2026](../evidence/d1-migration/air-314-owner-review-authority-2026-11-01.md). No production migration, import or marker change.
- **Uncertainty:** the live `admin/owner-reviews.json` was not read for this delivery. Counts of films, people and orphans are not claimed.

## Follow-ups

Applying migration `0009`, the fenced import, and the marker activation are separate owner approvals. None is implied by accepting this record.
