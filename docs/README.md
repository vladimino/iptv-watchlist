# IPTV Watchlist documentation

The documentation is organized by **purpose**, not by the former flat file layout. Start with the maintained page for the task you are working on. Old link-only redirect stubs have been removed; original historical reports remain in evidence or archive.

## Find the right document

| Section | What to read |
| --- | --- |
| [Architecture](architecture/README.md) | Thirteen implemented Mermaid diagrams covering system context, Worker, MCP, EPG, discovery, Film/Person, predictions, data, UI and failures |
| [Architecture decisions](adr/README.md) | Accepted ADRs, constraints and historical approval evidence |
| [Reference](reference/README.md) | Maintained API, integration, domain and data contracts |
| [Runbooks](runbooks/README.md) | Approved operations, deployment, local development and [recovery](runbooks/recovery/README.md) |
| [Process](process/README.md) | Delivery workflow, Trello card conventions and review gates |
| [Evidence](evidence/README.md) | Dated investigations, parity measurements and original rollout outcomes |
| [Archive](archive/README.md) | Superseded procedures and legacy Sites/R2 material; **not current instructions** |

## Common starting points

- **New contributor:** [README](../README.md), [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md) and [agent workflow](process/agent-workflow.md).
- **Runtime feature flags:** [flag contract and dated production evidence](reference/feature-flags.md); live bindings must be verified separately.
- **Runtime / deployment:** [system context](architecture/system-context.md), [deployment and rollback diagram](architecture/deployment-and-rollback.md), [deployment runbook](runbooks/deployment.md).
- **EPG / discovery:** [EPG publication](architecture/epg-and-availability.md), [discovery and resolution](architecture/discovery-and-resolution.md), [scored-resolution contract](reference/domain/scored-resolution.md), [candidate discovery](reference/domain/candidate-discovery.md).
- **Film/Person:** [lifecycle diagram](architecture/film-person-lifecycle.md) and [domain contract](reference/domain/film-person.md).
- **Owner admin:** [read model and queues](reference/domain/admin-read-contract.md), [read-only route `GET /api/admin/*`](reference/api/admin.md). `/admin` reads one pinned published snapshot through the owner's Access session and writes nothing; its [data health view](reference/api/admin.md#data-health-get-apiadminhealth) evaluates bounded read-only sources with the [data health model](reference/domain/data-health.md).
- **Predictions / profiles:** [prediction pipeline](architecture/prediction-pipeline.md), [runner API](reference/api/prediction-runner.md), [enrichment API](reference/api/enrichment.md), [taste-profile publication](runbooks/taste-profile-publication.md).
- **Storage / migrations:** [persistence architecture](architecture/persistence-and-migration.md), [D1 contract](reference/data/d1-schema.md), [migration ADR](adr/0017-staged-d1-migration.md).
- **Security / MCP:** [authentication diagram](architecture/authentication-and-mcp.md), [MCP contract](reference/api/mcp.md), [connectivity runbook](runbooks/mcp-connectivity.md).
- **Failures / observability:** [observability diagram](architecture/observability-and-failures.md), [run diagnostics](reference/api/run-diagnostics.md), [prediction diagnostics](reference/api/prediction-diagnostics.md).

## How to interpret the documentation

GitHub `main` is the canonical **code** source. The currently deployed Cloudflare Worker `iptv` uses R2 bucket `iptv` as authoritative production storage. D1 schema and offline repositories do **not** imply production D1 cutover; the historical ChatGPT Site is a reserve, not a concurrent writer. External ChatGPT Scheduled Tasks orchestrate EPG/predictions, rather than Worker Cron. A successful GitHub deployment does not execute these jobs or establish production acceptance.

**Use the right evidence:** Trello and live GitHub establish delivery state; the maintained reference describes contracts; ADRs record durable choices; runbooks describe allowed operations; dated evidence proves only the captured sample. Before relying on a runtime claim, check its current state through an **authorized safe diagnostic**. Some GET endpoints have write side effects. Do not launch production sync, discovery/TMDB, model calls, retries, lease resets, flag changes, Tasks, Access changes or storage operations without separate owner approval.

New architecture changes should update the relevant [diagrams](architecture/README.md), [ADR register](adr/README.md) when a substantial decision changes, and current [reference](reference/README.md) / [runbooks](runbooks/README.md) in the same reviewed delivery. Mermaid diagrams need actual rendered visual QA when an owner-review gate applies.
