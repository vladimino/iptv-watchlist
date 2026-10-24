# Architecture Decision Records

ADRs document durable accepted choices, not live feature flags, operational permissions or observations. See [template](template.md), [documentation governance](../README.md) and [evidence registry](../evidence/README.md).

## Accepted records

| ADR | Status | Decision and evidence |
| --- | --- | --- |
| [0001 — D1 schema v1 is unapplied](0001-d1-schema-v1.md) | Accepted (existing record, unchanged) | Local-only D1 schema/repositories; [AIR-49](https://trello.com/c/YNaLFwtW), [PR #51](https://github.com/vladimino/iptv-watchlist/pull/51) |
| [0002 — Cloudflare Worker and R2 authority](0002-cloudflare-worker-r2-authority.md) | Accepted; retrospective record 2026-10-24 | Production cutover on 19 October; legacy Sites reserve |
| [0003 — GitHub Actions tested-artifact deployment](0003-github-ci-deployment.md) | Accepted; original date unknown | GitHub main build and Cloudflare CD, code-only rollback |
| [0004 — Owner-only MCP Access and JWT boundary](0004-mcp-access-boundary.md) | Accepted; original date unknown | Managed OAuth, JWT verification, tool allowlist |
| [0005 — External ChatGPT Scheduled Tasks](0005-external-chatgpt-tasks.md) | Accepted; retrospective record 2026-10-24 | AIR-62 restored orchestration 21 October, independent of Worker cron |
| [0006 — One-chunk explicit discovery continuation](0006-one-chunk-discovery.md) | Accepted; original date unknown | Bounded request-driven discovery, no recursive waitUntil |

[Platform ADR reconstruction](https://trello.com/c/6MHbRFZR) is distinct from the planned [domain ADRs](https://trello.com/c/ORglHnul) and [prediction/data ADRs](https://trello.com/c/5qf3Zn3p). Never infer an original approval date from a later deployment test.

## Lifecycle

- **Proposed:** under review.
- **Accepted:** documented decision at the specified scope; original date and retrospective recording date are separate.
- **Superseded:** successor ADR explicitly replaces the previous record.
- **Rejected:** evaluated but not adopted.

Each ADR must cite evidence, include consequences and recovery boundaries, and identify unsupported assumptions. Current runtime state requires separate safe verification. A GitHub commit, a successful deploy and a production data migration are not equivalent. Rollback of code is not rollback of R2 data, OAuth policy or external schedules.
