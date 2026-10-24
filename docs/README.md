# IPTV Watchlist documentation

**Inventory baseline:** 24 October 2026 — [AIR-109](https://trello.com/c/whae9vKn), covering 35 original `docs/` files. [AIR-111](https://trello.com/c/WXVqNJ25) has now moved maintained process/runbooks and three historical procedures; the original locations contain link-only compatibility stubs. AIR-112 created `reference/domain/` and `evidence/film-person/`; AIR-113 organized maintained API, domain, data and integration references and added operator runbooks plus superseded procedure archives. AIR-114 has classified the historical reports in the [evidence registry](evidence/README.md); machine-readable fixtures and their executable dependencies move only in AIR-115. Architecture diagrams are still future work. Use the canonical links below, not the old stubs.

## Entrypoints and sources of truth

- [Agent guide](../AGENTS.md): essential repository/safety instructions. [Agent workflow](process/agent-workflow.md) and [Trello conventions](process/trello-card-conventions.md): the maintained collaboration policies (relocated by AIR-111).
- [Deployment](runbooks/deployment.md), [Recovery](runbooks/recovery/README.md), [MCP protocol](reference/api/mcp.md), [MCP runbook](runbooks/mcp-connectivity.md), [Local setup](runbooks/local-setup.md): operational reference. [AIR-110](https://trello.com/c/HIMB8pfv) reconciled its dated schedule/scored rollout claims with completed AIR-62/AIR-68; still verify live task state, runtime flags and permissions before acting.
- [Film/Person](reference/domain/film-person.md), [Scored resolution](reference/domain/scored-resolution.md), [Prediction runner](reference/api/prediction-runner.md), [D1 schema](reference/data/d1-schema.md): technical contracts, some mixed with historical notes.
- [Evidence registry](evidence/README.md): captured scope, original verdict, downstream decision and historical authority.
- [Architecture decisions](adr/README.md) and [ADR template](adr/template.md): why substantial design choices were accepted, not a record of temporary task status.
- The canonical [Enrichment API](reference/api/enrichment.md) now lives under `docs/`; the root `ENRICHMENT_API.md` remains a link-only compatibility stub. Root [CONTRIBUTING.md](../CONTRIBUTING.md) and [README.md](../README.md) remain in the scope of later AIR-119/121 refresh.

**Authoritative information:** current Trello cards/linked checklists give delivery status; GitHub main gives versioned source; authorized production reads establish current runtime settings/data; current reference defines the contract; runbooks define safe procedures; ADRs explain adopted choices; evidence proves only the specific dated sample. Historic reports and past handoffs are not proof of live flags/schedules.

**GitHub directory landing pages:** every navigable documentation directory must use a `README.md` (rather than `index.md`) so GitHub automatically renders its contents when the folder is opened. This applies to [`adr/`](adr/README.md), [`process/`](process/README.md), [`runbooks/`](runbooks/README.md), [`archive/`](archive/README.md) and [`evidence/`](evidence/README.md) plus the planned `architecture/README.md` in [AIR-120](https://trello.com/c/olwWKaXU). Do not link to pages that have not been created.

## Intended folders

| Folder | Responsibility | Implementation |
| --- | --- | --- |
| `architecture/` | current topology and flows with planned vs deployed clearly separated; index and 13 page plans, **no diagrams yet** | [AIR-120](https://trello.com/c/olwWKaXU) |
| `adr/` | numbered, stable architectural decisions and register | [AIR-109](https://trello.com/c/whae9vKn), [AIR-116](https://trello.com/c/6MHbRFZR)–[118](https://trello.com/c/5qf3Zn3p) |
| [`reference/`](reference/README.md) (API, domain, data, integrations) | maintained interfaces, invariants and schemas | [AIR-112](https://trello.com/c/uzsaLuye), [AIR-113](https://trello.com/c/svVrqavq) |
| [`runbooks/`](runbooks/README.md) with [`recovery/`](runbooks/recovery/README.md) | currently maintained operational procedures | [AIR-110](https://trello.com/c/HIMB8pfv), [AIR-111](https://trello.com/c/WXVqNJ25) |
| [`process/`](process/README.md) | delivery workflow and Trello formatting | [AIR-111](https://trello.com/c/WXVqNJ25) |
| [`evidence/`](evidence/README.md) (scored-resolver, prediction, D1, taxonomy, Film/Person, legacy-R2) | frozen audits, outcomes, aggregate machine-readable results and a usage registry | [AIR-114](https://trello.com/c/ia9tnXbc), [AIR-115](https://trello.com/c/TRp1oXpA) |
| [`archive/`](archive/README.md) (legacy-sites, legacy-r2, superseded) | superseded instructions retained with references to successors; never an operational runbook | [AIR-111](https://trello.com/c/WXVqNJ25), [AIR-114](https://trello.com/c/ia9tnXbc) |

## Document lifecycle and evidence governance

Do **not** confuse these independent axes:

- **Document role:** active reference / operational runbook / ADR / dated evidence / obsolete procedure. A mixed file must be split: current contract in reference, dated observations in evidence, obsolete procedures in archive.
- **Evidence verdict:** GO, NO-GO, INSUFFICIENT/INCONCLUSIVE, or MEASUREMENT ONLY. Its meaning is limited to the tested candidate and capture time. Historical NO-GO must not masquerade as a current production prohibition; historical GO does not grant fresh owner approval.
- **Evidence lifecycle:** current-for-its-scope, superseded, or archived. This is independent of the verdict.

[AIR-114](https://trello.com/c/ia9tnXbc) created the canonical [evidence registry](evidence/README.md); `evidence/index.md` is a compatibility link. Each record must state **capturedAt (UTC), environment/generation/code SHA or limitations, measured scope, source, verdict, lifecycle, operational authority (historical or maintained), Used by (direct ADR/PR/Trello decision URLs, or explicitly not yet consumed), Superseded by (if any), and unresolved caveats**. Do not retroactively rewrite measurements or claim an uncertain sample was accepted. A subsequent result is a new record; the index documents how it changed the decision.

Major design choices are documented as [ADRs](adr/README.md). Accepted ADR text is stable; reverse a decision by writing a successor and recording the link in the index. A PR merge is not the same as activation, runtime parity, or user authorization.

## Original inventory and current disposition

| Document (canonical link where moved) | Type | Disposition / next owner |
| --- | --- | --- |
| [`adr/0001-d1-schema-v1.md`](adr/0001-d1-schema-v1.md) | Decision | `adr/` |
| [`process/agent-workflow.md`](process/agent-workflow.md) | Process | **Moved (AIR-111)** |
| [`process/trello-card-conventions.md`](process/trello-card-conventions.md) | Process | **Moved (AIR-111)** |
| [`runbooks/local-setup.md`](runbooks/local-setup.md) | Runbook | **Moved (AIR-111)** |
| [`reference/integrations/letterboxd-ratings.md`](reference/integrations/letterboxd-ratings.md) | Maintained reference | **Moved (AIR-113)** |
| [`reference/api/run-diagnostics.md`](reference/api/run-diagnostics.md) | Maintained reference | **Moved (AIR-113)** |
| [`reference/api/prediction-diagnostics.md`](reference/api/prediction-diagnostics.md) | Maintained reference | **Moved (AIR-113)** |
| [`reference/domain/candidate-discovery.md`](reference/domain/candidate-discovery.md) | Maintained reference | **Moved (AIR-113)** |
| [`reference/data/d1-schema.md`](reference/data/d1-schema.md) | Maintained reference | **Moved (AIR-113)** |
| [`reference/domain/scored-resolution.md`](reference/domain/scored-resolution.md) | Maintained reference | **Moved (AIR-113)** |
| [`evidence/taxonomy/air-47-taxonomy-audit.md`](evidence/taxonomy/air-47-taxonomy-audit.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`reference/domain/film-person.md`](reference/domain/film-person.md) | Maintained domain contract | **Split (AIR-112)**; [historical audit](evidence/film-person/lifecycle-audit-and-rollout.md) retained, legacy path is a compatibility link |
| [`reference/api/mcp.md`](reference/api/mcp.md) | API/operations split | **Split (AIR-113)**; [MCP runbook](runbooks/mcp-connectivity.md), [historical checklist](archive/superseded/mcp-air-62-checklist.md) |
| [`reference/api/prediction-runner.md`](reference/api/prediction-runner.md) | API/operations split | **Split (AIR-113)**; [MCP runbook](runbooks/mcp-connectivity.md), [historical checklist](archive/superseded/mcp-air-62-checklist.md) |
| [`evidence/scored-resolver/air-100-rollout.md`](evidence/scored-resolver/air-100-rollout.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Operational runbook | **Moved and split (AIR-111)**; active [`recovery/`](runbooks/recovery/README.md) and archived [`Sites release`](archive/legacy-sites/site-release.md) |
| [`evidence/scored-resolver/air-43-shadow-rollout.md`](evidence/scored-resolver/air-43-shadow-rollout.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-43-verification-audit.md`](evidence/scored-resolver/air-43-verification-audit.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-67-parity.md`](evidence/scored-resolver/air-67-parity.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-81-parity.md`](evidence/scored-resolver/air-81-parity.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-84-shadow.md`](evidence/scored-resolver/air-84-shadow.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-86-census.md`](evidence/scored-resolver/air-86-census.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-86-replay-plan.md`](evidence/scored-resolver/air-86-replay-plan.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-86-replay.md`](evidence/scored-resolver/air-86-replay.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-97-verdict.md`](evidence/scored-resolver/air-97-verdict.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/scored-resolver/air-99-verdict.md`](evidence/scored-resolver/air-99-verdict.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/prediction/air-82-prediction-rca.md`](evidence/prediction/air-82-prediction-rca.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`evidence/d1-migration/air-73-offline-run.md`](evidence/d1-migration/air-73-offline-run.md) | Historical evidence | **Filed (AIR-114)**; [registry](evidence/README.md), original path now a compatibility link |
| [`air-73-offline-run.json`](air-73-offline-run.json) | Machine-readable evidence | **Stay in docs/ until AIR-115**, scripts/tests require coordinated path changes |
| [`air-86-replay-manifest.json`](air-86-replay-manifest.json) | Machine-readable evidence | **Stay in docs/ until AIR-115**, scripts/tests require coordinated path changes |
| [`air-86-replay-results.json`](air-86-replay-results.json) | Machine-readable evidence | **Stay in docs/ until AIR-115**, scripts/tests require coordinated path changes |
| [`air-99-detail.json`](air-99-detail.json) | Machine-readable evidence | **Stay in docs/ until AIR-115**, scripts/tests require coordinated path changes |
| [`archive/legacy-sites/migration-export.md`](archive/legacy-sites/migration-export.md) | Archived procedure | **Moved (AIR-111), not operational** |
| [`archive/legacy-r2/r2-import.md`](archive/legacy-r2/r2-import.md) | Archived procedure | **Moved (AIR-111), not operational** |
| [`archive/legacy-sites/prediction-scheduled-prompt.md`](archive/legacy-sites/prediction-scheduled-prompt.md) | Archived procedure | **Moved (AIR-111), not operational** |

**Machine-readable caution:** `scripts/air-86-replay.mjs`, `scripts/air-97-rescore.mjs`, `scripts/air-99-detail.mjs`, and `tests/air-86-replay.mjs` read or write hardcoded `docs/...` JSON paths. AIR-115 must migrate code, tests, and default output paths *in one PR*. Historical samples must remain byte-for-byte equivalent where verification requires it. AIR-114 did not move them; AIR-115 owns the coupled script/test changes.

## Modification policy

1. Keep the source and metadata of historical experiments; do not update past NO-GO/GO statements to describe a newer release. Corrections to *active* guides go in AIR-110 or their owning card.
2. Before relocating docs, update all relative links and code/script references, identify the new canonical path and avoid duplicate active contracts; run appropriate tests. No fake links to future docs.
3. GitHub documentation is English, Trello and Cursor instructions are Russian. Never publish production secrets or raw private data.
4. Documentation-only direct changes to main require owner approval and still require post-commit diff verification plus **both** CI/CD jobs. Executable script/test changes are handled in an independently reviewed PR. No documentation work grants permission for production R2/D1, sync, flags, retries or Scheduled Tasks.
5. **Documentation workstream exception:** report a finished commit and terminal CI/CD, close the Trello card, and **wait for owner signal** before taking the next card.

## Approved delivery sequence (order is not a fabricated dependency)

[AIR-109](https://trello.com/c/whae9vKn) → [AIR-110](https://trello.com/c/HIMB8pfv) → [AIR-111](https://trello.com/c/WXVqNJ25) → [AIR-112](https://trello.com/c/uzsaLuye) → [AIR-113](https://trello.com/c/svVrqavq) → [AIR-114](https://trello.com/c/ia9tnXbc) → [AIR-115](https://trello.com/c/TRp1oXpA) → [AIR-116](https://trello.com/c/6MHbRFZR) → [AIR-117](https://trello.com/c/ORglHnul) → [AIR-118](https://trello.com/c/5qf3Zn3p) → [AIR-119](https://trello.com/c/Mvi1pXYL) → [AIR-120](https://trello.com/c/olwWKaXU).

**Actual blockers:** native Trello prerequisite checklists, not every predecessor in this priority sequence.
