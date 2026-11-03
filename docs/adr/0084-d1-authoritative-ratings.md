# ADR 0084: Letterboxd ratings and viewing facts are D1-authoritative only after their own marker is open

**Status:** Proposed  
**Original decision date:** 2026-11-03  
**Recorded at:** 2026-11-03  
**Approval source:** not documented  
**Related work:** [AIR-318](https://trello.com/c/slj7UjN5), [ADR 0023](0023-letterboxd-user-facts.md), [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md), [ADR 0075](0075-retire-letterboxd-diary-history-switch.md), [ADR 0077](0077-retire-removal-rating-lookup-switch.md), [ADR 0078](0078-d1-authoritative-prediction-domain.md), [ADR 0079](0079-d1-authoritative-published-epg.md)  
**Supersedes:** [ADR 0002](0002-cloudflare-worker-r2-authority.md) in part, for the mutable ratings documents named below, and only while `ratings_domain_authority.mode` is `d1` and `cutover` is `open`. [ADR 0023](0023-letterboxd-user-facts.md) remains the fact model.  
**Superseded by:** None

## Context

Watched, rating and watchlist are separate Letterboxd facts with provenance. A newer observation replaces one fact and does not invent the others ([ADR 0023](0023-letterboxd-user-facts.md)). The Ratings Task is its own leased pipeline. Diary page 1 is the recent window. A bounded per-film member-page lookup is the permanent removal fallback. The EPG commit enqueues removals and does not read Diary, look up films or write ratings ([ADR 0060](0060-independent-letterboxd-ratings-pipeline.md), [ADR 0075](0075-retire-letterboxd-diary-history-switch.md), [ADR 0077](0077-retire-removal-rating-lookup-switch.md)).

Those facts, the diary cursor and history, the ratings run and migration witness, and the removal queue are mutable R2 objects. The view index repeats `watched`, `actualRating` and `watchlist` for catalogue exclusion. Removal events stay in the event log and receive a confirmed rating as a projection. ZIP bytes, HTML snapshots and archive receipts stay immutable sources. Schema v1 `actual_rating` is a legacy mirror, not this authority.

There is no transaction that covers D1 and R2 together. Applying a migration, copying objects, and opening a marker are separate approvals. This record does not authorize any of them.

## Decision

1. **Own the mutable documents, not the blobs.** Migration `0010_ratings_authority.sql` adds `ratings_domain_authority`, `ratings_domain_cas`, `ratings_document` and `ratings_view`. `ratings_document` stores the mutable JSON of `letterboxd/facts/links.json`, `letterboxd/facts/conflicts.json`, `letterboxd/facts/films/*.json`, `letterboxd/facts/scans/*.json`, `letterboxd/diary/history.json`, `letterboxd/diary/state.json`, `letterboxd/ratings/run.json`, `letterboxd/ratings/migration.json` and `enrichment/removal-rating-lookups.json`. Each document is the full JSON text, split into 60 KiB UTF-8 parts. The etag is the SHA-256 of that full text. The view index, the event log, `letterboxd/imports/` receipts, ZIP bytes and HTML snapshots are not rows. `enrichment/films/*/actual.json` is not this store.
2. **One marker, default `r2`.** The migration inserts `mode` `r2`, `cutover` `open` and generation 0. `ratings_domain_cas` is the batch fence (`ok >= 1`). It is not a Worker flag. Applying the file copies nothing and does not set `d1`. The contract becomes 10 only from a complete version of at least 8 and below 10: the ten prediction tables, the nine published-EPG tables, and both of those authority rows. Version 9 is accepted and is not required. Owner-review tables are not required. Version 6, version 7, a partial version 8, and any other contract are refused before a table is created. A later run does not lower a higher version. `0009` applied after version 10 still creates the owner-review tables and does not set the version to 9.
3. **Readers follow an open `d1` marker.** With no D1 binding, or with a contract below version 10 that has none of these tables, readers and writers stay on the objects. `RATINGS_DB_REQUIRED=on` makes a missing binding, or a bound database with no `schema_contract`, fail closed. The variable is not an operational ratings flag and does not apply the migration. A partial set of these tables, or version below 10 with some of them, fails closed. None of the tables on a later contract means the domain is not installed and stays on the objects. `mode` `d1` with `cutover` `held` is not authority: a public read stays on R2 and a writer fails closed with `ratings_domain_not_authoritative`. `mode` `d1` with `cutover` `open` reads and writes D1 and does not fall back to R2.
4. **The view is a projection.** `ratings_view` repeats `watched` (`0`, `1` or null), `actual_rating`, `watchlist` and `rating_known` per alias id. `rating_known` 1 with a null `actual_rating` is an explicit null rating. Unknown omits the field. Missing watched stays null and is not false. A non-null rating can exist when watched is false. A removal does not infer a viewing. While the marker is open, `GET /api/enrichment/view` and the catalogue exclusion strip the R2 personal fields and replace them from this table, including an alias that is not on the watchlist. Prediction and fingerprint fields on the same index stay. `projectRecords` does not write those personal fields back to R2. Once the marker is ready, `saveActualMirror` does not write `actual.json`.
5. **The pipeline behaviour does not change.** Diary page 1 stays first. The removal lookup stays the permanent fallback: at most five member-page requests per step, three attempts, claim before request, and the six-hour cooldown on 403 or 429. `not_found` and `not_rated` do not set watched. Migration `none`, `partial` or `regressed` still fails closed. The EPG commit still does not read Diary. A failed Diary page is not silently skipped into removal in a way that drops the update. The event log stays in R2. A confirmed rating on a removal event is the projection of the fact, which is the D1 document once the marker is open, and is not a second owner.
6. **Import, hold, seal and revert are separate commands.** `scripts/ratings-domain-production.mjs` prints status unless asked to write. Each write needs `--target iptv` and its own `--confirm`. `--apply --confirm apply` sends `0010` only when the decision is `apply`. `--load --confirm load` replaces the document table and rebuilds `ratings_view` from film records while `mode` stays `r2`, in chunks of 200, each re-probed. `--activate --confirm activate` also requires `--producers-drained`. It compares the exact texts, sets `d1` and `held`, re-reads, and opens the cutover only when they still match. A mismatch releases the marker to `r2` without an R2 write. A failed re-read leaves the hold. `--release-hold --confirm release-hold` returns a hold to `r2` without a mirror write. `--seal-hold --confirm seal-hold` also requires `--producers-drained` and the generation. `--revert --confirm r2` copies the D1 documents back to R2 and only then sets `mode` `r2`, and only when the marker was already open. A writer that is still active refuses the command. This record does not authorize running any of those commands.

Not decided here: applying `0010` to production, the live import, the hold, the seal, the revert, a ratings run, and any change to Cloudflare Access, Scheduled Tasks, the Ratings Task prompt, or the prediction and published-EPG markers.

## Alternatives considered

- **Rewrite observation precedence into columns.** Rejected. The fact model, the diary window and the removal lookup already have accepted records. Moving the JSON they already compare keeps that behaviour and still gives one fenced store.
- **Move `enrichment/view-index.json` wholesale.** Rejected. The index also carries prediction and fingerprint fields. Personal fields are replaced from `ratings_view` only when the ratings marker is open.
- **Treat `cutover` `held` as authority.** Rejected. The published-EPG marker uses the same hold: public reads stay on R2, and a writer does not fall back to an R2 put.
- **Require `0009` before `0010`.** Rejected. Owner reviews are a different marker. Version 9 is accepted. A complete version 8 is enough, and a later `0009` must still be able to create its tables without lowering version 10.

## Consequences

Until `0010` is applied, production behaviour is unchanged: the Ratings Task and the fact writers use R2. After it is applied, and while the marker stays `r2`, those writers still use R2. Readers do not see D1. After `mode` is `d1` and `cutover` is `open`, the same writers use D1, the R2 view index cannot compete on personal fields, and there is no silent R2 fallback. `/api/d1/status` does not gain a ratings field in this delivery.

Code rollback does not drop the tables, does not return the contract version, and does not change the marker. A Worker that only reads R2, running while the marker is open, would show objects that may lag. A deploy that includes `RATINGS_DB_REQUIRED=on` fails a ratings read or write closed when `DB` is missing. It does not apply `0010` and does not switch the marker. This delivery does not deploy.

The two Mermaid edits — the note on the ratings sequence, and the dashed ratings arrow on the persistence page — are part of this proposal and need owner visual approval. They are not a claim that production has applied `0010`.

## Recovery and migration boundary

Returning an open marker to `r2` is `--revert --confirm r2` after the documents have been copied back, and is its own approval. A hold that has not been sealed returns with `--release-hold --confirm release-hold`, also its own approval. Restoring the database is a Time Travel of the whole database and is its own approval. Disabling the Ratings Task stops the scheduled run. It does not change the marker and it does not put Diary back inside the EPG commit. This record does not authorize applying `0010`, loading, activating, sealing, releasing, reverting, a flag change, a Task change, or any production R2 or D1 write.

## Evidence

- **Original decision:** [AIR-318](https://trello.com/c/slj7UjN5)
- **Implementation:** this record's pull request
- **Dated verification:** [local contract check, 3 November 2026](../evidence/d1-migration/air-318-ratings-domain-contract-2026-11-03.md). No production migration, import or marker change.
- **Uncertainty:** the live ratings objects were not read or copied for this delivery. Counts of facts, diary entries and queue rows are not claimed. Owner visual approval of the two Mermaid edits is not yet recorded.

## Follow-ups

Applying migration `0010`, the fenced import, the hold, and opening the cutover are separate owner approvals. None is implied by accepting this record. A new nullable field on the AIR-39 view is a separate owner decision and is not a prerequisite.
