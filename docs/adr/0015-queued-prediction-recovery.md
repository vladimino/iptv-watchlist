# ADR 0015: Use a leased queue with per-film retry and hot priority

**Status:** Accepted  
**Original decision date:** unknown (original runner adoption date not documented)  
**Recorded at:** 2026-10-24 (retrospective; [AIR-118](https://trello.com/c/5qf3Zn3p))  
**Approval source:** [Continuous prediction runner v5](../reference/api/prediction-runner.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Long-running prediction batches encounter quota, invalid model outputs and interrupted callers. A single run must not lose already submitted films or let cold candidates delay currently watchable titles.

## Decision

Use a persistent CAS lease with runId, heartbeat and expiry. Each `next` reevaluates hot priority; cold work runs only when no hot work remains. Submit each film immediately and checkpoint it. Retry isolated validation/parse failures per film with exponential backoff rather than failing the whole queue. Record aggregate progress and stop reasons separately.

## Alternatives considered

Not documented as a confirmed comparison. Earlier ChatGPT Sites motivations or rejected alternatives cannot be reconstructed from the present sources alone.

## Consequences

Partial progress is durable; repeated or recovered runs can reuse current outputs and distinguish deferred work from empty current work. The protocol introduces lease and caller-health obligations.

## Recovery and migration boundary

A live runner invocation and lease recovery are writer operations requiring explicit approval. Deployment is not evidence that an external Scheduled Task ran successfully.

## Evidence

- [Runner contract and lease/retry semantics](../reference/api/prediction-runner.md)
- [Prediction operations](../runbooks/prediction-operations.md)
- [AIR-62 external scheduling](https://trello.com/c/CU71gW4c)

**Uncertainty:** Sources establish the scoped contract, not necessarily the original date when the architecture was first chosen. Historical evidence is not proof of present runtime configuration.

## Follow-ups

[AIR-118](https://trello.com/c/5qf3Zn3p); any materially different design or production cutover requires its own approval and documentation.
