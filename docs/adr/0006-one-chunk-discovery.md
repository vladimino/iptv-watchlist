# ADR 0006: Discovery continuation executes one chunk per explicit request

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-116](https://trello.com/c/6MHbRFZR))  
**Approval source:** [AIR-60](https://trello.com/c/UO0YqoWw) and [deployment runbook](../runbooks/deployment.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

Recursive continuation under `waitUntil` and Worker memory constraints made unattended discovery continuation unsafe. A deployment cannot assume a continuation hop obtains an independent isolate.

## Decision

Each explicit `epg_sync_step` or authorized `POST /api/enrichment/discovery/resolve` processes at most one discovery chunk within that request. The EPG commit does not start the next chunk. `DiscoveryContinuation` remains internal-only; no public self-fetch, forwarded tokens, second Worker or Access bypass is introduced. MCP next-action reporting guides a later explicit request.

## Alternatives considered

Not documented as a verifiable decision comparison. Do not infer rejected designs from the implementation alone.

## Consequences

Bounded work reduces isolate memory risk and makes continuation visible to the orchestrator. Completion requires repeated authorized requests; a single successful chunk is not completion of the overall backlog.

## Recovery and migration boundary

Do not introduce background recursive hops or trigger live discovery merely to test documentation. Running a real continuation writes EPG/R2 state and can call TMDB, requiring separate authorization.

## Evidence

- [AIR-60 continuation work](https://trello.com/c/UO0YqoWw)
- [Discovery operational topology](../runbooks/deployment.md)
- [MCP epg_sync_step contract](../reference/api/mcp.md)

**Uncertainty:** The listed sources support this adopted architecture, but do not necessarily establish the exact time of every intermediate approval. Deployment evidence is not permission to run data writers.

## Follow-ups

[AIR-116](https://trello.com/c/6MHbRFZR); changes to chunking or orchestration need tests and a new decision review.
