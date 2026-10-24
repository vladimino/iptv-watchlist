# ADR 0004: Owner-only Access and Worker JWT verification protect MCP

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-116](https://trello.com/c/6MHbRFZR))  
**Approval source:** [AIR-58](https://trello.com/c/BB01YN2f) and [MCP contract](../reference/api/mcp.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

The Worker exposes an MCP interface with both read-only probes and writer tools. Authentication at the edge alone would not document an explicit application audience check or limit the capabilities available to connected clients.

## Decision

The same Worker serves the exact `/mcp` path behind the separate Cloudflare Access application `IPTV MCP`, Managed OAuth and an owner-only policy. Worker code verifies the signed Access JWT (signature, issuer, audience, expiry, identity). MCP tools use an explicit narrow allowlist: no arbitrary URL, API route or R2 key. The wider Worker remains behind its existing Access application.

## Alternatives considered

Not documented as a verifiable decision comparison. Do not infer rejected designs from the implementation alone.

## Consequences

No second Worker or storage subsystem is needed. The edge policy plus token verification establish complementary boundaries; writer tools still have operational side effects only when invoked.

## Recovery and migration boundary

Do not add anonymous Access bypasses, broaden tool arguments, or relax JWT checks for troubleshooting. A successful deployment is not permission to call writer tools. Changes to Access policy and secrets require separate approval.

## Evidence

- [AIR-58](https://trello.com/c/BB01YN2f)
- [MCP security and tool contract](../reference/api/mcp.md)
- [Deployment topology](../runbooks/deployment.md)

**Uncertainty:** The listed sources support this adopted architecture, but do not necessarily establish the exact time of every intermediate approval. Deployment evidence is not permission to run data writers.

## Follow-ups

[AIR-62](https://trello.com/c/CU71gW4c) provides separately approved scheduled orchestration; [AIR-116](https://trello.com/c/6MHbRFZR).
