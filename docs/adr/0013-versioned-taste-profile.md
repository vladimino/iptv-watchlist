# ADR 0013: Publish immutable versioned taste profiles

**Status:** Accepted  
**Original decision date:** unknown (earlier Sites-era origin not established)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [Taste-profile publication procedure](../runbooks/taste-profile-publication.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Taste preferences evolve independently of stored film fingerprints and model predictions. Historical initial motivation and rejected alternatives are not recoverable from the available source.

## Decision

Publish a schema-validated taste profile with increasing version and server-computed hash. Keep immutable `enrichment/profile/versions/<n>.json` records and switch `enrichment/profile/current.json` to the approved version. Scheduled predictions consume the published server profile, rather than reading live ChatGPT Project files or memory. A new profile version makes predictions stale, not fingerprints.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Explicit version/hash provenance enables deterministic freshness checks and recalculation without erasing earlier output. Publication is a controlled writer, not an automatic side effect of editing preferences.

## Recovery and migration boundary

Changing the published profile invalidates prediction freshness and requires separate owner authorization. Rollback or republishing must respect version monotonicity and preserved history.

## Evidence

- [Publication procedure](../runbooks/taste-profile-publication.md)
- [Prediction lifecycle contract](../reference/domain/film-person.md)
- [Prediction runner protocol](../reference/api/prediction-runner.md)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
