# ADR 0008: Publish an EPG generation as one coherent snapshot

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-48](https://trello.com/c/rVf8rRoJ), [PR #28](https://github.com/vladimino/iptv-watchlist/pull/28)  
**Supersedes:** None documented  
**Superseded by:** [Accepted ADR 0079](0079-d1-authoritative-published-epg.md) in part, and only while `published_epg_authority.mode` is `d1` and `cutover` is `open`: the coherent snapshot is that D1 generation, and `epg/published-generation.json` is the compatibility mirror. The decision below stands. Until that activation, R2 remains the pointer.

## Context

Independent writes and readers could otherwise mix showings, candidates and catalogue state from different EPG runs.

## Decision

Write a complete generation before switching `epg/published-generation.json`. Readers use the pinned published generation and writers reject attempts to update decisions or programme belonging to an obsolete generation. Replacing a generation replaces its show set; it does not append old broadcasts.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

The previous generation remains visible until publication; late resolver work cannot overwrite a newer published programme. This requires generation-aware writes and explicit stale-work handling.

## Recovery and migration boundary

An incomplete publication must leave the previous pointer authoritative. Do not manually repoint or clean generation data without separately approved recovery.

## Evidence

- [AIR-48](https://trello.com/c/rVf8rRoJ)
- [PR #28](https://github.com/vladimino/iptv-watchlist/pull/28), [PR #31](https://github.com/vladimino/iptv-watchlist/pull/31)
- [Scored resolution](../reference/domain/scored-resolution.md)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
