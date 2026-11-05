# Contributing to IPTV Watchlist

GitHub `main` is the canonical code source. Begin with [AGENTS.md](AGENTS.md), the [documentation map](docs/README.md) and the [delivery workflow](docs/process/agent-workflow.md). The [architecture index](docs/architecture/README.md) contains actual diagrams; the [ADR register](docs/adr/README.md) explains durable choices.

## Work on a change

1. Read the live [Trello roadmap](https://trello.com/b/HODRHtcO/iptv-watchlist-roadmap), card acceptance criteria and any native prerequisites. Keep implementation separate from independently gated production rollout.
2. Run `git fetch origin main`, inspect `git status --short`, branch/head, remote and divergence. Start from fresh `origin/main` without overwriting unfinished work.
3. Work on a branch and open a focused PR. GitHub pre-fills the body from [the PR template](.github/pull_request_template.md); keep its sections and fill the three `Documentation impact` / `Architecture impact` / `Research evidence` lines, which the [documentation governance check](docs/process/documentation-governance.md#automated-pull-request-checks) enforces in CI; editing the description re-runs that check. Direct `main` documentation commits require **explicit owner approval**. Approval of the card includes normal PR merge after independent review and green CI; there is no extra per-PR owner confirmation. For diagrams or meaningful UI changes, include actual rendering and independent semantic QA. Owner inspection applies to a new material architectural/product choice or explicit exceptional gate, while production UI acceptance normally follows deploy.
4. Run `npm ci`, `npm test`, and `npm run build` where a local checkout exists. Verify PR CI, then review the real diff and links. Updating architecture, data flows or trust boundaries requires updated diagrams and reference/runbooks; significant new decisions require an [ADR](docs/adr/README.md).
5. After a normal pre-authorized merge or a merge requiring an exceptional owner gate, verify the new `main` SHA and **both** GitHub Actions jobs: `Test and build` and `Deploy to Cloudflare`. Record evidence and limitations in Trello before Done. A deployment is code publication only, not proof of a successful job invocation or migration.

## Safety and authorization

[Authorization policy](docs/process/authorization-and-escalation.md) defines L0–L3: proven read-only observation and approved routine PR delivery require no repeated owner prompt. L2 production recovery requires a separately approved, enforceable operation-specific contract; L3 material data, identity, migrations, Access, flags, schedules and out-of-plan production writers require an owner-approved execution plan. This documentation change grants no new production writer authorization.

GitHub main is the code source. Production runs behind Cloudflare Access, with **per-domain** D1/R2 storage authority verified through current markers and contracts. The former ChatGPT Site is reserve. A deploy does not migrate data, run jobs, change schedules or authorize new writers. Some GET routes repair state and are not L0. See [deployment](docs/runbooks/deployment.md), [MCP](docs/reference/api/mcp.md), [recovery](docs/runbooks/recovery/README.md) and [architecture](docs/architecture/README.md). Never publish tokens or private production payloads.
