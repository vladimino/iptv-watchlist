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
| [0019 — Live D1 backfill reads a verified production baseline and maps identities by rule](0019-live-d1-backfill-boundaries.md) | Accepted 2026-10-26 (design decision; no production operation authorized) | [AIR-74](https://trello.com/c/5AdAmKPe) owner G0 decision; [readiness assessment](../evidence/d1-migration/air-74-backfill-readiness-2026-10-26.md) |
| [0020 — Owner-triggered, bounded poster hydration for verified catalog records](0020-owner-triggered-catalog-poster-hydration.md) | Accepted 2026-10-26 (accepted on owner review; no flag change or execution authorized) | [AIR-15](https://trello.com/c/Yz6SGd3R), [PR #122](https://github.com/vladimino/iptv-watchlist/pull/122) |
| [0021 — A large programme generation is staged in bounded chunks and published by one fixed-size commit](0021-staged-atomic-generation-import.md) | Accepted 2026-10-26 conceptually, conditional on the scratch G4 performance and atomicity gate (design decision; no migration, scratch or production write authorized) | [AIR-167](https://trello.com/c/6ZaRfXWL), [owner review](https://github.com/vladimino/iptv-watchlist/pull/123#pullrequestreview-5655427816); [generation unit size](../evidence/d1-migration/generation-unit-size-2026-10-26.md) |
| [0022 — A discovery decision taken against earlier airings is imported with its own evidence key](0022-stale-decision-evidence-import.md) | Accepted 2026-10-27 (design decision; no D1 or production operation authorized); supersedes ADR-0019 item 5 in part | [AIR-74](https://trello.com/c/5AdAmKPe) owner decision; [dry-run evidence](../evidence/d1-migration/air-74-sqlite-dry-run-2026-10-26.md) |

| [0023 — Watched, rating and watchlist are separate Letterboxd facts with provenance, and only a newer observation replaces one](0023-letterboxd-user-facts.md) | Accepted 2026-10-27; owner-approved architecture and GitHub-rendered Mermaid (design only; no production operations authorized) | [AIR-170](https://trello.com/c/UaOFSsF9); [AIR-169 reconciliation](../evidence/letterboxd/air-169-reconciliation-2026-10-26.md) |

## Proposed records

None at present.

[Platform ADRs](https://trello.com/c/6MHbRFZR) and [domain ADRs](https://trello.com/c/ORglHnul) are recorded here; [prediction/data ADRs](https://trello.com/c/5qf3Zn3p) are recorded here; [agent guide updates](https://trello.com/c/Mvi1pXYL) are next. Never infer an original approval date from a later deployment test.

## Lifecycle

- **Proposed:** under review.
- **Accepted:** documented decision at the specified scope; original date and retrospective recording date are separate.
- **Superseded:** successor ADR explicitly replaces the previous record.
- **Rejected:** evaluated but not adopted.

Each ADR must cite evidence, include consequences and recovery boundaries, and identify unsupported assumptions. Current runtime state requires separate safe verification. A GitHub commit, a successful deploy and a production data migration are not equivalent. Rollback of code is not rollback of R2 data, OAuth policy or external schedules.
