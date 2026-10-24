# IPTV Watchlist documentation

**Inventory baseline:** 24 October 2026 — [AIR-109](https://trello.com/c/whae9vKn), covering 35 original `docs/` files. [AIR-111](https://trello.com/c/WXVqNJ25) has now moved maintained process/runbooks and three historical procedures; the original locations contain link-only compatibility stubs. Other target folders in the plan may still be unpopulated. Use the canonical links below, not the old stubs.

## Entrypoints and sources of truth

- [Agent guide](../AGENTS.md): essential repository/safety instructions. [Agent workflow](process/agent-workflow.md) and [Trello conventions](process/trello-card-conventions.md): the maintained collaboration policies (relocated by AIR-111).
- [Deployment](runbooks/deployment.md), [Recovery](runbooks/recovery/README.md), [MCP](mcp.md), [Local setup](runbooks/local-setup.md): operational reference. [AIR-110](https://trello.com/c/HIMB8pfv) reconciled its dated schedule/scored rollout claims with completed AIR-62/AIR-68; still verify live task state, runtime flags and permissions before acting.
- [Film/Person](film-person-lifecycle.md), [Scored resolution](scored-resolution.md), [Prediction runner](prediction-runner.md), [D1 schema](d1-schema.md): technical contracts, some mixed with historical notes.
- [Architecture decisions](adr/README.md) and [ADR template](adr/template.md): why substantial design choices were accepted, not a record of temporary task status.
- Root [ENRICHMENT_API.md](../ENRICHMENT_API.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [README.md](../README.md) remain outside `docs/` and are also in scope for AIR-110/113/119.

**Authoritative information:** current Trello cards/linked checklists give delivery status; GitHub main gives versioned source; authorized production reads establish current runtime settings/data; current reference defines the contract; runbooks define safe procedures; ADRs explain adopted choices; evidence proves only the specific dated sample. Historic reports and past handoffs are not proof of live flags/schedules.

**GitHub directory landing pages:** every navigable documentation directory must use a `README.md` (rather than `index.md`) so GitHub automatically renders its contents when the folder is opened. This applies to [`adr/`](adr/README.md), [`process/`](process/README.md), [`runbooks/`](runbooks/README.md), [`archive/`](archive/README.md) and the planned `architecture/README.md` in [AIR-120](https://trello.com/c/olwWKaXU). Do not link to pages that have not been created.

## Intended folders

| Folder | Responsibility | Implementation |
| --- | --- | --- |
| `architecture/` | current topology and flows with planned vs deployed clearly separated; index and 13 page plans, **no diagrams yet** | [AIR-120](https://trello.com/c/olwWKaXU) |
| `adr/` | numbered, stable architectural decisions and register | [AIR-109](https://trello.com/c/whae9vKn), [AIR-116](https://trello.com/c/6MHbRFZR)–[118](https://trello.com/c/5qf3Zn3p) |
| `reference/{api,domain,data,integrations}/` | maintained interfaces, invariants and schemas | [AIR-112](https://trello.com/c/uzsaLuye), [AIR-113](https://trello.com/c/svVrqavq) |
| [`runbooks/`](runbooks/README.md) with [`recovery/`](runbooks/recovery/README.md) | currently maintained operational procedures | [AIR-110](https://trello.com/c/HIMB8pfv), [AIR-111](https://trello.com/c/WXVqNJ25) |
| [`process/`](process/README.md) | delivery workflow and Trello formatting | [AIR-111](https://trello.com/c/WXVqNJ25) |
| `evidence/{scored-resolver,prediction,d1-migration,film-person,legacy-r2}/` | frozen audits, outcomes, aggregate machine-readable results and a usage registry | [AIR-114](https://trello.com/c/ia9tnXbc), [AIR-115](https://trello.com/c/TRp1oXpA) |
| [`archive/`](archive/README.md) (legacy-sites, legacy-r2; superseded planned) | superseded instructions retained with references to successors; never an operational runbook | [AIR-111](https://trello.com/c/WXVqNJ25), [AIR-114](https://trello.com/c/ia9tnXbc) |

## Document lifecycle and evidence governance

Do **not** confuse these independent axes:

- **Document role:** active reference / operational runbook / ADR / dated evidence / obsolete procedure. A mixed file must be split: current contract in reference, dated observations in evidence, obsolete procedures in archive.
- **Evidence verdict:** GO, NO-GO, INSUFFICIENT/INCONCLUSIVE, or MEASUREMENT ONLY. Its meaning is limited to the tested candidate and capture time. Historical NO-GO must not masquerade as a current production prohibition; historical GO does not grant fresh owner approval.
- **Evidence lifecycle:** current-for-its-scope, superseded, or archived. This is independent of the verdict.

[AIR-114](https://trello.com/c/ia9tnXbc) creates `evidence/index.md`. Each record must state **capturedAt (UTC), environment/generation/code SHA or limitations, measured scope, source, verdict, lifecycle, operational authority (historical or maintained), Used by (direct ADR/PR/Trello decision URLs, or explicitly not yet consumed), Superseded by (if any), and unresolved caveats**. Do not retroactively rewrite measurements or claim an uncertain sample was accepted. A subsequent result is a new record; the index documents how it changed the decision.

Major design choices are documented as [ADRs](adr/README.md). Accepted ADR text is stable; reverse a decision by writing a successor and recording the link in the index. A PR merge is not the same as activation, runtime parity, or user authorization.

## Original inventory and current disposition

| Document (canonical link where moved) | Type | Disposition / next owner |
| --- | --- | --- |
| [`adr/0001-d1-schema-v1.md`](adr/0001-d1-schema-v1.md) | Decision | `adr/` |
| [`process/agent-workflow.md`](process/agent-workflow.md) | Process | **Moved (AIR-111)** |
| [`process/trello-card-conventions.md`](process/trello-card-conventions.md) | Process | **Moved (AIR-111)** |
| [`runbooks/local-setup.md`](runbooks/local-setup.md) | Runbook | **Moved (AIR-111)** |
| [`air-64-ratings.md`](air-64-ratings.md) | Reference | `reference/` |
| [`air-88-run-diagnostics.md`](air-88-run-diagnostics.md) | Reference | `reference/` |
| [`air-98-prediction-diagnostics.md`](air-98-prediction-diagnostics.md) | Reference | `reference/` |
| [`candidate-discovery.md`](candidate-discovery.md) | Reference | `reference/` |
| [`d1-schema.md`](d1-schema.md) | Reference | `reference/` |
| [`scored-resolution.md`](scored-resolution.md) | Reference | `reference/` |
| [`air-47-taxonomy-audit.md`](air-47-taxonomy-audit.md) | Mixed—split | `reference/ + evidence/` |
| [`film-person-lifecycle.md`](film-person-lifecycle.md) | Mixed—split | `reference/ + evidence/` |
| [`mcp.md`](mcp.md) | Mixed—split | `reference/ + evidence/` |
| [`prediction-runner.md`](prediction-runner.md) | Mixed—split | `reference/ + evidence/` |
| [`air-100-rollout.md`](air-100-rollout.md) | Historical scored rollout plan + evidence | `archive/ or evidence/` in AIR-114; **not moved by AIR-111** |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Operational runbook | **Moved and split (AIR-111)**; active [`recovery/`](runbooks/recovery/README.md) and archived [`Sites release`](archive/legacy-sites/site-release.md) |
| [`air-43-shadow-rollout.md`](air-43-shadow-rollout.md) | Evidence | `evidence/scored-resolver/` |
| [`air-43-verification-audit.md`](air-43-verification-audit.md) | Evidence | `evidence/scored-resolver/` |
| [`air-67-parity.md`](air-67-parity.md) | Evidence | `evidence/scored-resolver/` |
| [`air-81-parity.md`](air-81-parity.md) | Evidence | `evidence/scored-resolver/` |
| [`air-84-shadow.md`](air-84-shadow.md) | Evidence | `evidence/scored-resolver/` |
| [`air-86-census.md`](air-86-census.md) | Evidence | `evidence/scored-resolver/` |
| [`air-86-replay-plan.md`](air-86-replay-plan.md) | Evidence | `evidence/scored-resolver/` |
| [`air-86-replay.md`](air-86-replay.md) | Evidence | `evidence/scored-resolver/` |
| [`air-97-verdict.md`](air-97-verdict.md) | Evidence | `evidence/scored-resolver/` |
| [`air-99-verdict.md`](air-99-verdict.md) | Evidence | `evidence/scored-resolver/` |
| [`air-82-prediction-rca.md`](air-82-prediction-rca.md) | Evidence | `evidence/prediction/` |
| [`air-73-offline-run.md`](air-73-offline-run.md) | Evidence | `evidence/d1-migration/` |
| [`air-73-offline-run.json`](air-73-offline-run.json) | Evidence JSON—code refs | `evidence/scored-resolver/ or d1-migration/` |
| [`air-86-replay-manifest.json`](air-86-replay-manifest.json) | Evidence JSON—code refs | `evidence/scored-resolver/ or d1-migration/` |
| [`air-86-replay-results.json`](air-86-replay-results.json) | Evidence JSON—code refs | `evidence/scored-resolver/ or d1-migration/` |
| [`air-99-detail.json`](air-99-detail.json) | Evidence JSON—code refs | `evidence/scored-resolver/ or d1-migration/` |
| [`archive/legacy-sites/migration-export.md`](archive/legacy-sites/migration-export.md) | Archived procedure | **Moved (AIR-111), not operational** |
| [`archive/legacy-r2/r2-import.md`](archive/legacy-r2/r2-import.md) | Archived procedure | **Moved (AIR-111), not operational** |
| [`archive/legacy-sites/prediction-scheduled-prompt.md`](archive/legacy-sites/prediction-scheduled-prompt.md) | Archived procedure | **Moved (AIR-111), not operational** |

**Machine-readable caution:** `scripts/air-86-replay.mjs`, `scripts/air-97-rescore.mjs`, `scripts/air-99-detail.mjs`, and `tests/air-86-replay.mjs` read or write hardcoded `docs/...` JSON paths. AIR-115 must migrate code, tests, and default output paths *in one PR*. Historical samples must remain byte-for-byte equivalent where verification requires it. AIR-109 does not move them.

## Modification policy

1. Keep the source and metadata of historical experiments; do not update past NO-GO/GO statements to describe a newer release. Corrections to *active* guides go in AIR-110 or their owning card.
2. Before relocating docs, update all relative links and code/script references, identify the new canonical path and avoid duplicate active contracts; run appropriate tests. No fake links to future docs.
3. GitHub documentation is English, Trello and Cursor instructions are Russian. Never publish production secrets or raw private data.
4. Documentation-only direct changes to main require owner approval and still require post-commit diff verification plus **both** CI/CD jobs. Executable script/test changes are handled in an independently reviewed PR. No documentation work grants permission for production R2/D1, sync, flags, retries or Scheduled Tasks.
5. **Documentation workstream exception:** report a finished commit and terminal CI/CD, close the Trello card, and **wait for owner signal** before taking the next card.

## Approved delivery sequence (order is not a fabricated dependency)

[AIR-109](https://trello.com/c/whae9vKn) → [AIR-110](https://trello.com/c/HIMB8pfv) → [AIR-111](https://trello.com/c/WXVqNJ25) → [AIR-112](https://trello.com/c/uzsaLuye) → [AIR-113](https://trello.com/c/svVrqavq) → [AIR-114](https://trello.com/c/ia9tnXbc) → [AIR-115](https://trello.com/c/TRp1oXpA) → [AIR-116](https://trello.com/c/6MHbRFZR) → [AIR-117](https://trello.com/c/ORglHnul) → [AIR-118](https://trello.com/c/5qf3Zn3p) → [AIR-119](https://trello.com/c/Mvi1pXYL) → [AIR-120](https://trello.com/c/olwWKaXU).

**Actual blockers:** native Trello prerequisite checklists, not every predecessor in this priority sequence.
