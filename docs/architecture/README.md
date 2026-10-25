# Architecture overview and diagram plan

This is a **navigation and planning index**, created by [AIR-120](https://trello.com/c/olwWKaXU) on 24 October 2026. **Four runtime/security pages from AIR-140 are merged.** Four catalog/discovery pages from AIR-141 are merged. Three predictions/data pages from AIR-142 are merged. The final two read-model/observability pages are drafts awaiting owner review in AIR-143. Drafts are not production authorization. Each page requires its own scoped task, source verification and review.

For decisions read the [ADR register](../adr/README.md); for maintained implementation contracts see [reference](../reference/README.md); for operations see [runbooks](../runbooks/README.md); for bounded historical measurements see [evidence](../evidence/README.md).

## Boundary and reading rules

- **Current production:** Cloudflare Worker `iptv` with authoritative R2 bucket `iptv`. The legacy ChatGPT Site is a reserve; it is not a second current source.
- **Not current production:** D1 schema and offline repositories/import are preparation. No live D1 authority should be inferred from an architectural plan.
- **Operational independence:** GitHub deployment, external ChatGPT Scheduled Tasks, MCP invocation, and R2 writes are separate actions. No diagram grants approval for live operations.
- **Plans versus facts:** proposed diagrams must show observed/current paths distinctly from future migration paths, citing supporting reference/ADR documents. No guessed alternatives or invented topology.

## Architecture pages — draft and planned

| Page and review status | Goal | Mermaid type | Starting evidence | Current vs future boundary |
| --- | --- | --- | --- | --- |
| [`system-context.md`](system-context.md) — **merged (AIR-140)** | Worker, external actors, Letterboxd, EPG, TMDB and storage boundaries | `flowchart` | [Deployment](../runbooks/deployment.md), [MCP ADR](../adr/0004-mcp-access-boundary.md) | current runtime and external dependencies; no assumption D1 active |
| [`runtime-topology.md`](runtime-topology.md) — **merged (AIR-140)** | Worker entrypoints, R2, internal continuation and HTTP/MCP trust boundaries | `flowchart` | [Deployment](../runbooks/deployment.md), [Worker/R2 ADR](../adr/0002-cloudflare-worker-r2-authority.md) | current Worker/R2; D1 is not a runtime dependency |
| [`deployment-and-rollback.md`](deployment-and-rollback.md) — **merged (AIR-140)** | Tested artifact delivery, deploy gates and code rollback limit | `flowchart` | [Deployment runbook](../runbooks/deployment.md), [CI/CD ADR](../adr/0003-github-ci-deployment.md) | deployed CI/CD; data rollback is separate |
| [`authentication-and-mcp.md`](authentication-and-mcp.md) — **merged (AIR-140)** | OAuth/Access challenge, verified JWT, MCP tools and caller boundary | `sequenceDiagram` | [MCP reference](../reference/api/mcp.md), [Security ADR](../adr/0004-mcp-access-boundary.md) | current owner-only Access; tools are not automatically invoked |
| [`letterboxd-ingestion.md`](letterboxd-ingestion.md) — **merged (AIR-141)** | Watchlist/ratings input, anti-bot failure and last-good snapshot | `sequenceDiagram` | [Letterboxd ratings](../reference/integrations/letterboxd-ratings.md), [Ratings ADR](../adr/0018-letterboxd-last-good-ratings.md) | current bounded ingestion; no bypass or automatic repair implied |
| [`epg-and-availability.md`](epg-and-availability.md) — **merged (AIR-141)** | Generation creation, publication pointer, transient shows and current window | `flowchart` | [Film/Person reference](../reference/domain/film-person.md), [EPG ADR](../adr/0008-atomic-epg-publication.md) | current published R2 generation; no D1 cutover |
| [`discovery-and-resolution.md`](discovery-and-resolution.md) — **merged (AIR-141)** | Persistent observations, candidate scoring, detail gate and retries | `flowchart` | [Scored resolution](../reference/domain/scored-resolution.md), [Detail gate ADR](../adr/0010-scored-detail-verification.md) | deployed mechanism versus separately gated search variants |
| [`film-person-lifecycle.md`](film-person-lifecycle.md) — **merged (AIR-141)** | Identity, metadata, localization, fingerprint and prediction dimensions | `stateDiagram-v2` | [Film/Person](../reference/domain/film-person.md), [Identity ADR](../adr/0009-canonical-film-person-identity.md) | domain contract and R2 projections; persistent canonical cutover not claimed |
| [`prediction-pipeline.md`](prediction-pipeline.md) — **merged (AIR-142)** | Profile publication, queued next/submit, reuse, errors and completion | `sequenceDiagram` | [Runner contract](../reference/api/prediction-runner.md), [Queue ADR](../adr/0015-queued-prediction-recovery.md) | existing queue; external model caller remains outside Worker |
| [`persistence-and-migration.md`](persistence-and-migration.md) — **merged (AIR-142)** | R2 authority, D1 schema, offline import, staged gates and receipts | `flowchart` | [D1 reference](../reference/data/d1-schema.md), [Migration ADR](../adr/0017-staged-d1-migration.md) | R2 current; D1 future target until separate cutover |
| [`ui-and-read-models.md`](ui-and-read-models.md) — **draft, owner review pending** | Programme/watchlist displays, view index, prediction and ratings projections | `flowchart` | [Film/Person](../reference/domain/film-person.md), [Prediction ADR](../adr/0014-fingerprint-prediction-lifecycle.md) | existing projections; do not assume read-model migration |
| [`scheduling-and-orchestration.md`](scheduling-and-orchestration.md) — **merged (AIR-142)** | External Scheduled Tasks, MCP calls, explicit chunk continuation and leases | `sequenceDiagram` | [Runner](../reference/api/prediction-runner.md), [Scheduling ADR](../adr/0005-external-chatgpt-tasks.md) | external automation; Worker cron is not scheduler |
| [`observability-and-failures.md`](observability-and-failures.md) — **draft, owner review pending** | Runtime diagnostic states, caller reports, retries, fault boundaries | `flowchart` | [Run diagnostics](../reference/api/run-diagnostics.md), [Provenance ADR](../adr/0016-run-diagnostic-provenance.md) | server evidence versus caller delivery remains distinct |

## Authoring checklist for future tasks

Each page should identify the authoritative code/ref at review time; label deployed versus planned transitions; explain data ownership, trust boundaries, retry/error paths and rollback implications where relevant; and link the source ADR and maintained reference. When Mermaid is added, check rendering in GitHub and confirm arrows do not imply a non-existent D1 writer, internal credential-forwarding hop or autonomous discovery recursion.

Creating these pages, validating rendered diagrams, and updating the eventual root README belong to later approved tasks. [AIR-119](https://trello.com/c/Mvi1pXYL) refreshes agent instructions after this index exists; [AIR-121](https://trello.com/c/eId8ykTr) refreshes the root README.
