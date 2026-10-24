# ADR 0005: Scheduled EPG and prediction orchestration remains external

**Status:** Accepted  
**Original decision date:** 2026-10-21  
**Recorded at:** 2026-10-24 (retrospective, [AIR-116](https://trello.com/c/6MHbRFZR))  
**Approval source:** [AIR-62](https://trello.com/c/CU71gW4c)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Background EPG and prediction orchestration must be distinguished from Worker cron settings and from GitHub deployment. Existing tools are invoked by an authenticated ChatGPT agent.

## Decision

Unattended schedules are ChatGPT Scheduled Tasks outside the Worker, calling the owner-only MCP tools. The Worker exposes bounded EPG sync and prediction-runner operations, but deploying it neither configures nor triggers those tasks. `Worker schedules=0` does not imply external automations are disabled. Actual enabled/running state must be checked in the live automation registry.

## Alternatives considered

Not documented as a verifiable decision comparison. Do not infer rejected designs from the implementation alone.

## Consequences

Scheduler authorization and health become a separate operational dependency. A successful MCP probe or successful Worker deploy does not prove a completed EPG or prediction cycle.

## Recovery and migration boundary

Do not create, enable, disable, edit or manually trigger tasks without separate approval. Check leases and correlate actual run IDs with EPG/prediction completion; code rollback does not restore task state.

## Evidence

- [AIR-62 restoration](https://trello.com/c/CU71gW4c) (21 October 2026)
- [Deployment runbook, checked state on 24 October](../runbooks/deployment.md)
- [MCP orchestration contract](../reference/api/mcp.md)

**Uncertainty:** The listed sources support this adopted architecture, but do not necessarily establish the exact time of every intermediate approval. Deployment evidence is not permission to run data writers.

## Follow-ups

[AIR-116](https://trello.com/c/6MHbRFZR); later schedule changes are operational decisions, not implicit ADR approval.
