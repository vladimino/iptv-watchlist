# ADR 0002: Cloudflare Worker and R2 are the production authority

**Status:** Accepted  
**Original decision date:** 2026-10-19  
**Recorded at:** 2026-10-24 (retrospective, [AIR-116](https://trello.com/c/6MHbRFZR))  
**Approval source:** [19 October production cutover](https://github.com/vladimino/iptv-watchlist/commit/58737738275fca182afd8afbdd035870db63315e)  
**Supersedes:** None documented  
**Superseded by:** [ADR 0078](0078-d1-authoritative-prediction-domain.md) only for mutable prediction-domain state when `prediction_domain_authority.mode` becomes `d1`; R2 continues to own all other domains covered here and the immutable prediction bodies remain in R2. ADR 0078 acceptance does not activate that marker.

## Context

The IPTV service previously ran on ChatGPT Sites. A verified 6,520-object historical snapshot was transferred to Cloudflare R2; the legacy Site and its storage remain separate.

## Decision

GitHub `main` is the canonical code source. Worker `iptv` serves production and uses Cloudflare R2 bucket `iptv` as authoritative storage. The old ChatGPT Site is a temporary reserve and historical source only, not a second active writer. D1 is not made authoritative by this decision; see [ADR-0001](0001-d1-schema-v1.md).

## Alternatives considered

Not documented as a verifiable decision comparison. Do not infer rejected designs from the implementation alone.

## Consequences

One deployed runtime and authoritative R2 store simplify operational ownership. Legacy Site access is hazardous because some GET endpoints can write. The historical snapshot and leases require explicit recovery handling.

## Recovery and migration boundary

A Worker code rollback does not roll back R2 content. Never import, restore, delete leases or run jobs on the legacy Site without a separate owner-approved procedure.

## Evidence

- [Cutover commit](https://github.com/vladimino/iptv-watchlist/commit/58737738275fca182afd8afbdd035870db63315e)
- [Deployment and snapshot verification](../runbooks/deployment.md)
- [Legacy migration archive](../archive/legacy-sites/migration-export.md)

**Uncertainty:** The listed sources support this adopted architecture, but do not necessarily establish the exact time of every intermediate approval. Deployment evidence is not permission to run data writers.

## Follow-ups

[AIR-116](https://trello.com/c/6MHbRFZR); any later D1 authority change requires a separate ADR and operational gate.
