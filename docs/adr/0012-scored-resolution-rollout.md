# ADR 0012: Require measured shadow and explicit GO before scored cutover

**Status:** Accepted  
**Original decision date:** 2026-10-24 (accepted scoped cutover)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-68](https://trello.com/c/qbLDc6Ql)  
**Supersedes:** None documented  
**Superseded by:** [ADR 0035](0035-scored-resolution-only.md) for the runtime-mode boundary (the `SCORED_RESOLUTION` variable and flag rollback); the rollout decision itself stays accepted history

## Context

Scored resolution affects production catalogue identity, so implementation or a passing offline test alone is insufficient reason to replace the legacy resolver.

## Decision

Deliver scorer/gate first, evaluate in `shadow`, record bounded parity and explicit GO/NO-GO evidence, and activate only with owner approval. The 24 October AIR-68 decision enabled scoped `SCORED_RESOLUTION=on` while leaving `CANDIDATE_DISCOVERY` unset. AIR-69 is a separate stabilization gate; historical AIR-67 NO-GO and later narrower approval are not contradictory measurements.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

Separating experiments, authorization, activation and stabilization keeps operational claims auditable. Flag values are runtime configuration, not source-code defaults.

## Recovery and migration boundary

Do not infer current flag state from this dated cutover; read Cloudflare configuration before any change. Rollback to shadow/off needs separate approval, and reverting code is not a data rollback.

## Evidence

- AIR-66 implementation, [AIR-67](https://trello.com/c/R4RuNVNw) (historical NO-GO), [AIR-68](https://trello.com/c/qbLDc6Ql), [AIR-69](https://trello.com/c/FlcWZX7W)
- [Historical shadow/parity evidence](../evidence/scored-resolver/shadow-parity-register.md)
- [AIR-100 rollout plan](../evidence/scored-resolver/air-100-rollout.md)
- [Current resolution contract](../reference/domain/scored-resolution.md)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
