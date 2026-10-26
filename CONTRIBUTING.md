# Contributing to IPTV Watchlist

GitHub `main` is the canonical code source. Begin with [AGENTS.md](AGENTS.md), the [documentation map](docs/README.md) and the [delivery workflow](docs/process/agent-workflow.md). The [architecture index](docs/architecture/README.md) contains actual diagrams; the [ADR register](docs/adr/README.md) explains durable choices.

## Work on a change

1. Read the live [Trello roadmap](https://trello.com/b/HODRHtcO/iptv-watchlist-roadmap), card acceptance criteria and any native prerequisites. Keep implementation separate from independently gated production rollout.
2. Run `git fetch origin main`, inspect `git status --short`, branch/head, remote and divergence. Start from fresh `origin/main` without overwriting unfinished work.
3. Work on a branch and open a focused PR. GitHub pre-fills the body from [the PR template](.github/pull_request_template.md); keep its sections and fill the three `Documentation impact` / `Architecture impact` / `Research evidence` lines, which the [documentation governance check](docs/process/documentation-governance.md#automated-pull-request-checks) enforces in CI; editing the description re-runs that check. Direct `main` documentation commits require **explicit owner approval**. Approval of the card includes normal PR merge after independent review and green CI; there is no extra per-PR owner confirmation. For diagrams or meaningful UI changes, include evidence of actual rendering; honor any explicit pre-merge owner visual gate (Mermaid rendering in particular), while production UI acceptance normally follows deploy.
4. Run `npm ci`, `npm test`, and `npm run build` where a local checkout exists. Verify PR CI, then review the real diff and links. Updating architecture, data flows or trust boundaries requires updated diagrams and reference/runbooks; significant new decisions require an [ADR](docs/adr/README.md).
5. After a normal pre-authorized merge or a merge requiring an exceptional owner gate, verify the new `main` SHA and **both** GitHub Actions jobs: `Test and build` and `Deploy to Cloudflare`. Record evidence and limitations in Trello before Done. A deployment is code publication only, not proof of a successful job invocation or migration.

## Safety

Production runs on Cloudflare Worker `iptv`, with R2 bucket `iptv` authoritative. The old ChatGPT Site is a reserve, and D1 is not the current authoritative store. Worker deployment does not migrate data, invoke MCP writers, change Cloudflare Access or manage external ChatGPT Scheduled Tasks.

Do **not** execute EPG, discovery/TMDB, ratings refresh, model/prediction, production mutation endpoints, feature-flag changes, scheduled jobs, R2/D1 import, cutover or lease recovery without separate owner authorization. Access-protected GET endpoints are not always side-effect-free. Keep secrets, actual production records and raw prompts out of public code and PRs.

For operations use the [deployment and rollback runbook](docs/runbooks/deployment.md), [recovery procedures](docs/runbooks/recovery/README.md), [MCP contract](docs/reference/api/mcp.md) and [architecture diagrams](docs/architecture/README.md). The full process and review rules live in [agent workflow](docs/process/agent-workflow.md), not in this short contributor entrypoint.
