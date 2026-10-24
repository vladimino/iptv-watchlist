# ADR 0016: Separate server-formed responses from caller-confirmed delivery

**Status:** Accepted  
**Original decision date:** unknown (AIR-88 records implementation, not original motivation date)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [AIR-88](https://trello.com/c/xWA4evuk)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

A Worker can attest it entered a handler and produced a response, but a later transport or orchestration failure can prevent the caller receiving it. Treating `api_error` as proof of server failure would invent an attribution.

## Decision

Record bounded server-observed steps with requestId, phase and delivery `unconfirmed`. Only a later caller acknowledgement of that exact requestId establishes receipt. External failures may carry a separately tagged caller-reported `fault`; absence of that data stays `external_unattributed`. Do not backfill historical attribution from inference.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Diagnostic history distinguishes server and caller evidence while preventing false root-cause claims. It cannot on its own attest client reception.

## Recovery and migration boundary

No synthetic fault reports, task edits or production runner calls under this documentation task. Preserve existing historical RCA as partial.

## Evidence

- [AIR-88](https://trello.com/c/xWA4evuk)
- [Run diagnostics contract](../reference/api/run-diagnostics.md)
- [AIR-82 partial RCA](../evidence/prediction/air-82-prediction-rca.md)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
