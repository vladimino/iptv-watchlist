# ADR 0007: Preserve discovery observations separately from transient showings

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-48](https://trello.com/c/rVf8rRoJ)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Broadcast showings expire, while title-resolution uncertainty, evidence fingerprints and retry states may remain useful between EPG generations.

## Decision

Keep a persistent discovery observation/resolution ledger keyed by normalized title and year; `epg/discovery-latest.json` is candidate evidence, `epg/discovery-resolution.json` stores decisions and their retry/evidence state. The currently published shows are a replaceable generation projection, not permanent Film identity. An unresolved observation is not a canonical Film.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

Retry history is preserved without treating old availability as current. Changed title/year/duration/show evidence can legitimately prompt reevaluation; stale or terminal decisions do not silently become current.

## Recovery and migration boundary

Do not clear retry states or replay production discovery when restructuring evidence. Any authoritative storage migration is a separate approval.

## Evidence

- [AIR-48](https://trello.com/c/rVf8rRoJ)
- [Film/Person contract](../reference/domain/film-person.md)
- [Candidate discovery](../reference/domain/candidate-discovery.md)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
