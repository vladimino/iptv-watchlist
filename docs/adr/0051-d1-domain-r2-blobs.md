# ADR 0051: D1 is the home of the relational domain and R2 the home of blobs; the migration runs as per-domain flips without shadow stages

**Status:** Accepted  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-30  
**Approval source:** Owner decision recorded on [AIR-275](https://trello.com/c/4x7hH0gI) on 2026-10-29, rejecting [AIR-75](https://trello.com/c/AXPYIVCa), [AIR-76](https://trello.com/c/HHrDozK6), [AIR-77](https://trello.com/c/f3QzcNYf) and [AIR-78](https://trello.com/c/COdMTjqU)  
**Related work:** [AIR-74](https://trello.com/c/5AdAmKPe) (backfill), [AIR-275](https://trello.com/c/4x7hH0gI), [PR #233](https://github.com/vladimino/iptv-watchlist/pull/233), [PR #241](https://github.com/vladimino/iptv-watchlist/pull/241)  
**Supersedes:** The stage sequence of [ADR 0017](0017-staged-d1-migration.md) after the backfill (shadow writes, shadow reads, read cutover, write cutover as separate evidence-gated stages); the backfill boundaries of [ADR 0019](0019-live-d1-backfill-boundaries.md) stay in force for any future reload  
**Superseded by:** [ADR 0056](0056-d1-enrichment-write-through.md) (Proposed 2026-10-30) in part, if accepted: for the enrichment domain, decision 2's immediate "writer writes D1 as the truth" is preceded by an R2-authoritative projection into D1 from a Worker cron trigger. Everything else here stands.

## Context

The domain (Films, Persons, credits, external identities, programme candidates and decisions, ratings and prediction pointers) lives in R2 as JSON documents. Persons are nested inside films and keyed per role and per source, so a person can exist as a Letterboxd actor, a Letterboxd director, a TMDB actor and a TMDB director at once, and matching Letterboxd against TMDB has no relational ground. ADR 0017 planned the move to D1 as six gated stages. The backfill alone took four days, many snapshots and reruns. For a single-user project with a reproducible discovery cycle, the owner judged the remaining shadow stages disproportionate.

On 29 October 2026 the D1 database `iptv` was created, given schema v3 and loaded with a backfilled copy of R2 (AIR-74).

## Decision

1. **Split by kind.** D1 is the home of the relational domain: Films, Persons, credits, external ids, aliases, redirects, candidates, decisions, generations, shows, ratings and current prediction and fingerprint pointers. R2 stays the home of blobs: immutable fingerprint and prediction versions, raw EPG, snapshots and exports.
2. **Per-domain flips, no shadow stages.** Each domain moves on its own:
   - the writer writes D1 as the truth;
   - it also keeps refreshing the former R2 JSON as a cache for pages that still read it;
   - pages then move to SQL one by one, and each cache is removed once nothing reads it.

   Shadow writes, shadow reads and full parity reports are not required. A discrepancy found later becomes a bug card and a recomputation.
3. **First step (phase 1).** The Worker is bound to D1 as `DB` and only reads it, through the [D1 catalog views](../reference/api/d1-catalog.md). R2 stays authoritative for every existing page and writer until that domain's flip.
4. **Cross-source person identity.** It follows [ADR 0009](0009-canonical-film-person-identity.md): evidence comes through a verified Film (same Film, same role, same name). A name alone is a review candidate, never a link.

Not decided here: the order and mechanics of each write flip, the person merge model, and when R2 JSON caches are deleted. Each comes with its own PR.

## Alternatives considered

- **ADR 0017 stages (shadow writes, shadow reads, read cutover, write cutover).** Rejected by the owner on 29 October 2026 as disproportionate to the risk of a single-user project.
- **Keep R2 and add D1 only as an analytics copy.** Discussed the same day. Rejected because the goal is to improve person matching, lifecycle, filters and the admin on top of a relational model, not to run reports.

## Consequences

- The relational model becomes usable at once (person filmographies, duplicate queues) without touching existing pages.
- Until a domain flips, D1 does not follow R2 changes. A reload uses the [backfill runbook](../runbooks/d1-backfill.md). Qualified by [ADR 0056](0056-d1-enrichment-write-through.md) (Proposed), if accepted: enrichment follows R2 through its projector before its flip.
- During a flip, two copies of one domain exist: the D1 truth and the R2 cache. The writer keeps them together; a cache that drifts is a bug, not a second authority.
- Without shadow stages, a defect can reach the user. It is caught by tests, by the owner using the app, and by recomputation from R2 blobs or from reproducible discovery.

## Recovery and migration boundary

- **Phase 1:** rollback is a code revert of the binding and routes; D1 data is untouched.
- **Each write flip:** it is preceded by a fenced R2 snapshot and a D1 Time Travel bookmark, and it is reversible by switching the writer back while the R2 cache is still maintained.
- **Approvals:** every production action (D1 schema change, reload, deploy with a new binding, write flip, Scheduled Task pause or resume, cache deletion) needs its own explicit owner approval. This ADR authorizes none of them.

## Evidence

- **Original decision:** [AIR-275](https://trello.com/c/4x7hH0gI); rejections recorded on AIR-75 to AIR-78 on 2026-10-29
- **Implementation:** backfill recorded on [AIR-74](https://trello.com/c/5AdAmKPe); phase 1 in [PR #241](https://github.com/vladimino/iptv-watchlist/pull/241)
- **Dated verification:** on 2026-10-29 between 23:34 and 23:35 UTC, the D1 import of a local executor build was checked against that build. All 36 tables matched by row count: 2,402 Films, 17,344 Persons, 34,221 receipts. Private evidence is with the owner.
- **Uncertainty:** the TMDB credits of catalog films are missing from the 29 October load because of an importer id-spelling defect. A follow-up PR fixes it, and D1 must then be reloaded before co-credit evidence exists.

## Follow-ups

[AIR-275](https://trello.com/c/4x7hH0gI) phases 2–4; [AIR-201](https://trello.com/c/1uvzKiGg) and [AIR-44](https://trello.com/c/ojtZjVc9) for the person identity model.
