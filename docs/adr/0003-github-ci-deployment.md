# ADR 0003: GitHub Actions publishes tested Worker builds

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-116](https://trello.com/c/6MHbRFZR))  
**Approval source:** [Delivery workflow](../process/agent-workflow.md) and [deployment runbook](../runbooks/deployment.md)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

A separate deployment mechanism risked publishing a build that differed from the tested source; deployments also required repeatable code-only recovery boundaries.

## Decision

Pushes to GitHub `main` run Test and build, then Deploy to Cloudflare using the verified `dist/` artifact. PRs run tests/build but do not deploy. The deploy job checks `GITHUB_SHA` against remote main HEAD before Wrangler publication, uses the Cloudflare Prod environment, and retains dashboard variables via `keep_vars`. The former independent Workers Builds integration is disconnected.

## Alternatives considered

Not documented as a verifiable decision comparison. Do not infer rejected designs from the implementation alone.

## Consequences

A reproducible artifact links the tested commit to deployment. The freshness check limits stale publishes but is not atomic with release. Automatic code deployment does not run sync, migration, predictions or Scheduled Tasks.

## Recovery and migration boundary

Rollback concerns Worker code, not R2 state, OAuth credentials, Cloudflare policy, task schedules, or other external state. Follow the recovery runbook and obtain authorization for operational changes.

## Evidence

- [CI/CD operational contract](../runbooks/deployment.md)
- [Workflow source](../../.github/workflows/ci.yml)
- [Representative successful main CI/CD after AIR-115](https://github.com/vladimino/iptv-watchlist/actions/runs/40122831875) (verification example, not original decision date)

**Uncertainty:** The listed sources support this adopted architecture, but do not necessarily establish the exact time of every intermediate approval. Deployment evidence is not permission to run data writers.

## Follow-ups

[AIR-116](https://trello.com/c/6MHbRFZR); [recovery runbook](../runbooks/recovery/cloudflare-worker-rollback.md).
