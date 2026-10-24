# ADR 0010: Separate candidate scoring from verified TMDB identity

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-48](https://trello.com/c/rVf8rRoJ)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

A high ranking match from title, year, uniqueness and runtime is a candidate hypothesis, not authoritative identity evidence.

## Decision

`scoreFilmResolution` ranks candidates using deduplicated TMDB identities and explicit contradictions. `acceptScoredIdentity` independently gates persistence using the accepted id, actionable pinned generation, movie-detail evidence, title/year/runtime checks and known competing editions. Only `detail_verified` may create/update a scored-discovered catalog Film; another observation's verification is not transferable.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

This separation prevents a strong score or repeated candidate rows from bypassing identity verification; extra detail reads and ambiguity checks increase work but protect catalogue correctness.

## Recovery and migration boundary

Do not weaken the detail gate in response to a shadow score or retrospective report. Runtime activation is controlled separately, not by this ADR.

## Evidence

- [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-48](https://trello.com/c/rVf8rRoJ)
- [Scored resolution contract](../reference/domain/scored-resolution.md)
- [Scorer implementation](https://github.com/vladimino/iptv-watchlist/blob/main/src/domain/scored-resolution.js)
- [Gate implementation](https://github.com/vladimino/iptv-watchlist/blob/main/src/domain/resolution-acceptance.js)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
