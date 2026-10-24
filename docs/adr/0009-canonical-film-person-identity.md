# ADR 0009: Canonical Film/Person identity requires trusted provenance

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-42](https://trello.com/c/drLBuWjl)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Letterboxd watchlist ids, EPG observation keys, TMDB ids and localized titles represent different identity authorities; conflating them creates duplicates and unsafe merges.

## Decision

Use stable local Film/Person identities, external ids with provenance/trust and explicit aliases. Preserve existing assigned IDs and watchlist identity; merge films only with matching Letterboxd evidence, trusted common TMDB identity or explicit verified evidence. Conflicting verified identities are collisions. Role-specific Person ids are not automatically unified by a shared name. Reviewed localization is not downgraded by inferred data.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

Proposed scorer matches cannot silently promote canonical identity. Redirects, metadata and prediction history are retained across a valid link. The domain contract and sidecar parity are not themselves a production persistent-entity cutover.

## Recovery and migration boundary

Do not rewrite existing R2 records or switch D1 authority as a consequence of documenting this contract; migration follows separate gates.

## Evidence

- [AIR-42](https://trello.com/c/drLBuWjl)
- [Film/Person domain implementation](https://github.com/vladimino/iptv-watchlist/blob/main/src/domain/film-person.js)
- [Maintained contract](../reference/domain/film-person.md)
- [Historical audit](../evidence/film-person/lifecycle-audit-and-rollout.md)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
