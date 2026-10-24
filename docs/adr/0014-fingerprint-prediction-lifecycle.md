# ADR 0014: Keep fingerprint and prediction freshness independent

**Status:** Accepted  
**Original decision date:** unknown (earlier Sites-era origin not established)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [Film lifecycle contract](../reference/domain/film-person.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

A film fingerprint describes its narrative attributes; a personal prediction depends additionally on a particular taste profile and prediction prompt. Availability updates do not change either semantic artifact.

## Decision

Track fingerprint by schema version, content/hash and invalidation; track prediction by its fingerprint hash, profile version/hash and prompt version. Retain previous predictions and use freshness predicates to select reusable records. Profile publication invalidates prediction only. Airing/show changes invalidate neither fingerprint nor prediction. Actual ratings remain separate and are not passed to the model as its target answer.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Reduces unnecessary model runs and prevents stale personalization from being presented as current, while preserving prediction history for comparison.

## Recovery and migration boundary

Do not regenerate fingerprints or predictions, modify actual ratings, or change queue freshness rules while recording this decision.

## Evidence

- [Film/Person lifecycle dimensions](../reference/domain/film-person.md)
- [Prediction runner](../reference/api/prediction-runner.md)
- [D1 future mapping](../reference/data/d1-schema.md)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
