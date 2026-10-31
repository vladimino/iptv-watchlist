# ADR 0020: Owner-triggered, bounded poster hydration for verified catalog records

**Status:** Accepted  
**Original decision date:** 2026-10-26  
**Recorded at:** 2026-10-26  
**Approval source:** owner explicitly approved the rendered architecture diagram and ADR decision on 2026-10-26, in the AIR-15 delivery conversation  
**Related work:** [AIR-15](https://trello.com/c/Yz6SGd3R), [AIR-102](https://trello.com/c/8wKyN4c7), [PR #122](https://github.com/vladimino/iptv-watchlist/pull/122)  
**Supersedes:** None  
**Superseded by:** [ADR-0048](0048-permanent-catalog-poster-maintenance-route.md) (Accepted 2026-10-29) in part: the `CATALOG_POSTER_HYDRATION` gate and the one-time framing of the operation; the route, the dry run, the identity rule, the lease, generation and compare-and-swap checks, the batch limit and the per-call owner approval stay. [ADR 0063](0063-catalog-poster-negative-index.md) (Proposed) in part: the completion invariant that a cursor followed until `done` settles every verified record without a poster

## Context

The «Находки» section shows catalog-only films from `GET /api/catalog/available`. The owner's production visual QA showed all five finds with the year placeholder. In the Worker the placeholder appears only when `poster` is empty; there is no CSP or image-host restriction, and a broken URL would render a broken image instead. The catalog records of those films therefore carry `poster: null`.

`epg/discovered-films.json` (and the published generation's copy under `epg/generations/<runId>/`) is written by the discovery writer under the resolver lease. It stores a TMDB poster (`https://image.tmdb.org/t/p/w342` + `poster_path`) only when it inserts a record from TMDB movie detail; every later write (`touchCanonicalFilm`, `replaceCatalogAvailability`, `mergeCatalogIdentity`) preserves the field. Records inserted before the field existed, or by an older resolver, keep `poster: null` indefinitely. The read-only `metadata.json` fallback only covers films that were on the watchlist, which these were not. No stored data holds the missing assets, so filling them requires an outbound TMDB request and an R2 write.

## Decision

Add a separate, owner-triggered writer, `POST /api/enrichment/catalog/posters`, gated by the off-by-default flag `CATALOG_POSTER_HYDRATION` (exact string `on`):

- **Authority.** TMDB movie detail requested by the record's own verified TMDB id is the only source, and only for records whose `canonicalIdentity` is exactly `tmdb:<tmdbId>`. The only field written is `poster`, in the discovery writer's form. Identity, aliases, shows, decisions, the generation pointer and every other key are not written; no record, decision or identity is ever created.
- **Read-only dry run** is the default and needs no flag: counts and a sample of verified ids without a poster, no TMDB request, no write.
- **Bounded execution.** At most 20 records per call in id order, through the resolver's TMDB client, token and pacing, one retry on a failure, a `429` stops the batch.
- **Lease and generation consistency.** The call holds the resolver lease, so it excludes a discovery chunk and an EPG publication for its duration. Immediately before every write attempt, including the retry after a lost compare-and-swap, it re-checks that the published generation is still the one it started from and renews the lease. The two catalog copies (generation copy first, then the live catalog) are separate R2 objects, each written with its own ETag compare-and-swap on a fresh read that sets `poster` only where the record is still the same verified id without a poster. The copies are **not** atomic together: a stop between them leaves the first copy written, which is reported per copy and per record.
- **Retry and cursor semantics.** Outcomes are terminal (`hydrated`, `already_present`, `no_poster_on_tmdb`, `tmdb_id_mismatch`) or retryable (`tmdb_failed`, `rate_limited`, `not_attempted`, `skipped_changed`, `generation_changed`, `lease_lost`, `catalog_changed`). The cursor never moves past a retryable record. **Completion invariant:** `done: true` (with `nextCursor: null`) is reported only when the batch reached the end of the queue and every outcome in it is terminal, so a cursor chain started without a cursor and followed until `done` leaves every verified record without a poster hydrated or terminally settled.
- **Owner gates.** Setting the flag, every execution call and any rollback write are separate owner approvals. The procedure is the [poster hydration runbook](../runbooks/catalog-poster-hydration.md). The route does not run on a schedule.

Accepted design: code, tests and documentation remain behind the unset flag. Acceptance does not approve activation, execution or production writes.

## Alternatives considered

- **One-time, bounded, owner-triggered manual operation (chosen).** Reuses the Worker's lease, fences, TMDB client and token; each step is visible and approved; nothing runs unattended.
- **Scheduled or recurring hydration task.** Rejected for now: it would add an unattended production writer for a problem that is not known to recur. It is to be considered separately only if missing posters recur after the one-time operation.
- **A local script with TMDB and R2 credentials on a laptop.** Rejected: it moves production write credentials off the Worker, cannot hold the resolver lease the Worker uses, and bypasses the Worker's fences and Access boundary.
- **Folding the repair into the resolver chunk.** Rejected: it would widen the identity-critical resolver with an unrelated write, change its TMDB budget and make a field repair depend on discovery scheduling.

## Consequences

- A new production write path (TMDB → R2) exists in code, inert until the flag is set. It competes with discovery for the resolver lease while it runs.
- TMDB request volume is bounded per call (≤ 20 records, ≤ 2 requests each) and paced like the resolver.
- A partial state (generation copy written, live catalog not) is possible and reported; it is harmless because the written value is the correct asset of the verified id, and the next call completes it.
- Films whose TMDB entry has no poster keep the placeholder; a persistently failing request keeps the sweep open and is reported rather than skipped.

## Recovery and migration boundary

Reversible: unsetting the flag refuses further execution. Written posters stay; nulling them is a separate approved write from the per-call receipts. No pointer, identity, show or decision changes, so nothing else needs restoring. This ADR authorizes no flag change, execution or production write.

## Evidence

- **Original decision:** owner handoffs on [AIR-15](https://trello.com/c/Yz6SGd3R) (2026-10-26) and the review of [PR #122](https://github.com/vladimino/iptv-watchlist/pull/122).
- **Implementation:** [PR #122](https://github.com/vladimino/iptv-watchlist/pull/122); tests in `tests/catalog-posters.mjs` (fixtures and fakes only).
- **Dated verification:** not recorded; no production execution has taken place.
- **Uncertainty:** how many of the affected films have a poster on TMDB is unknown until an approved dry run and execution.

## Follow-ups

A recurring hydration, if missing posters recur, needs its own decision. The D1 importer's catalog mapping is unaffected: `poster` is an existing field.
