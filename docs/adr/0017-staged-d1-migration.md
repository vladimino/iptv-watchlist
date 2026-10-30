# ADR 0017: Migrate R2 to D1 through separate evidence-gated stages

**Status:** Accepted  
**Original decision date:** unknown (original migration planning date not documented)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [AIR-49](https://trello.com/c/YNaLFwtW) and [ADR-0001](0001-d1-schema-v1.md)  
**Supersedes:** None documented  
**Superseded by:** [ADR 0051](0051-d1-domain-r2-blobs.md) for the stages after the backfill (shadow writes, shadow reads and the separate cutovers)

## Context

Production R2 and prospective D1 do not share a transaction. Offline sample parity does not prove a safe live authority cutover, especially when record IDs and generations can disagree.

## Decision

Keep immutable D1 schema v1 and caller-supplied offline repositories independent of Worker production bindings. Follow separate stages: offline archive import/parity, separately approved live backfill, shadow writes, shadow reads, read cutover, authoritative write cutover and retirement. Record import receipts by source key/checksum, preserving conflicts and unmapped data rather than silently manufacturing parity.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Allows reconciliation and rollback gates at each stage. The 24 October AIR-73 import documented partial offline mapping, not complete parity or live D1 readiness.

## Recovery and migration boundary

R2 remains production authority until distinct owner-approved cutover. An R2 commit and D1 receipt cannot be rolled back atomically; no production backfill or storage binding change follows from this ADR.

## Evidence

- [ADR-0001](0001-d1-schema-v1.md)
- [D1 schema contract and migration mapping](../reference/data/d1-schema.md)
- [AIR-73 offline results](../evidence/d1-migration/air-73-offline-run.md)
- [AIR-74 proposed live backfill](https://trello.com/c/5AdAmKPe)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
