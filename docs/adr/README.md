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
| [0007 — Preserve discovery observations separately from transient showings](0007-persistent-discovery-evidence.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0008 — Publish an EPG generation as one coherent snapshot](0008-atomic-epg-publication.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0009 — Canonical Film/Person identity requires trusted provenance](0009-canonical-film-person-identity.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0010 — Separate candidate scoring from verified TMDB identity](0010-scored-detail-verification.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0011 — Constrain title variants and preserve ambiguity gates](0011-bounded-title-variants.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0012 — Require measured shadow and explicit GO before scored cutover](0012-scored-resolution-rollout.md) | Accepted; retrospectively recorded 2026-10-24 | [AIR-117](https://trello.com/c/ORglHnul), primary sources in ADR |
| [0013 — Publish immutable versioned taste profiles](0013-versioned-taste-profile.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |
| [0014 — Keep fingerprint and prediction freshness independent](0014-fingerprint-prediction-lifecycle.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |
| [0015 — Use a leased queue with per-film retry and hot priority](0015-queued-prediction-recovery.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |
| [0016 — Separate server-formed responses from caller-confirmed delivery](0016-run-diagnostic-provenance.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |
| [0017 — Migrate R2 to D1 through separate evidence-gated stages](0017-staged-d1-migration.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |
| [0018 — Preserve last-good ratings when Letterboxd returns HTTP 403](0018-letterboxd-last-good-ratings.md) | Accepted; retrospective 2026-10-24 | [AIR-118](https://trello.com/c/5qf3Zn3p), primary evidence in ADR |

[Platform ADRs](https://trello.com/c/6MHbRFZR) and [domain ADRs](https://trello.com/c/ORglHnul) are recorded here; [prediction/data ADRs](https://trello.com/c/5qf3Zn3p) are recorded here; [agent guide updates](https://trello.com/c/Mvi1pXYL) are next. Never infer an original approval date from a later deployment test.

## Lifecycle

- **Proposed:** under review.
- **Accepted:** documented decision at the specified scope; original date and retrospective recording date are separate.
- **Superseded:** successor ADR explicitly replaces the previous record.
- **Rejected:** evaluated but not adopted.

Each ADR must cite evidence, include consequences and recovery boundaries, and identify unsupported assumptions. Current runtime state requires separate safe verification. A GitHub commit, a successful deploy and a production data migration are not equivalent. Rollback of code is not rollback of R2 data, OAuth policy or external schedules.
