# ADR 0018: Preserve last-good ratings when Letterboxd returns HTTP 403

**Status:** Accepted  
**Original decision date:** unknown (AIR-64 documents contract, initial motivation date unverified)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [AIR-64](https://trello.com/c/WTnyO8bX)  
**Supersedes:** None documented  
**Superseded by:** None documented; [ADR 0040](0040-retire-ratings-only-refresh.md) (Accepted) retires the separate refresh route only, the last-good rule stays

## Context

Letterboxd films pages may return an anti-bot HTTP 403. An incomplete scan must not replace a previously published rating snapshot or corrupt the view index.

## Decision

Maintain immutable successful ratings generations and a `published.json` pointer advanced only after projection. Keep pending projection checkpoints and the prior successful generation on HTTP 403 or interrupted fetch. Limit owner-triggered full retries with backoff; do not circumvent anti-bot challenges. A per-film repair is distinct from a completed full scan.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Ratings availability degrades visibly while last-known-good data remains available. The rating refresh has its own opt-in flag and does not change the EPG sync contract.

## Recovery and migration boundary

No live Letterboxd retry, flag toggle, production rating repair or anti-bot bypass is authorized by this ADR.

## Evidence

- [AIR-64](https://trello.com/c/WTnyO8bX)
- [Letterboxd ratings refresh contract](../reference/integrations/letterboxd-ratings.md)
- [Maintained integration index](../reference/integrations/README.md)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
