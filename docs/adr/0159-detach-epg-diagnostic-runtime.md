# ADR 0159: Detach the EPG diagnostic runtime from the production Worker

**Status:** **Proposed** (2026-11-17; owner GO on merge and deploy is pending, see AIR-457 holdpoints)
**Original decision date:** 2026-11-17
**Recorded at:** 2026-11-17
**Approval source:** Owner card scope of [AIR-457](https://trello.com/c/InwLNuYs) (14 November 2026: GO for planning, safe reads and PR preparation only)
**Related work:** [AIR-456](https://trello.com/c/eb948eA5) (documented NO-GO), [AIR-457](https://trello.com/c/InwLNuYs); [ADR 0121](0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](0124-epg-diagnostic-canary-run-contract.md), [ADR 0139](0139-epg-diagnostic-chunked-replay-dataset.md)
**Supersedes:** The deployment wiring of ADR 0121 and ADR 0124 (bindings, var, route, Workflow class). Their design, isolation reasoning and contracts stay Accepted as history and as the contract of the inert modules.
**Superseded by:** None

## Context

The diagnostic canary never ran: AIR-456 ended as a documented NO-GO (the full-size replay of about 100 MiB exceeds the 96 MiB cap), and the owner chose evidence from natural production EPG runs. The deployed Worker `iptv` still carries `EPG_DIAGNOSTIC_DB`, `EPG_DIAGNOSTIC_BUCKET`, `EPG_DIAGNOSTIC_WORKFLOW`, the var `EPG_DIAGNOSTIC_RESOURCE_ID`, the owner-only `/api/epg/diagnostic/*` routes and the `EpgDiagnosticWorkflow` export. They widen the attack and mistake surface of the production Worker for a tool with no scheduled use, and the isolation of the canary is application-enforced inside the same Worker that is bound to production D1 and R2.

## Decision

1. Remove the four diagnostic entries from `wrangler.jsonc`, the `/api/epg/diagnostic/*` route from `src/worker.js` and the `EpgDiagnosticWorkflow` class from the bundle entry in `build.mjs`.
2. Keep the inert modules (`src/epg-diagnostic*.js`, `src/epg-replay.js`), the operator script, ADR 0121/0124/0139 and every dated evidence. Their tests drive the modules directly.
3. Deprovisioning of the diagnostic Workflow definition, D1 `iptv-epg-diagnostic` and the EU-jurisdiction R2 bucket is a later, separately approved operation, after the detach is deployed and read back, with zero active instances, zero receipts and a read-only EU bucket check.
4. Permanent D1/R2 API tokens and the shared `R2_SNAPSHOT_*` are not part of this decision.

## Consequences

- No new production writer, route or authority; deployment creates and deletes no data. Production Workflows, modes, flags, cron, Access and data are unchanged.
- Rollback of the code restores the wiring but never recreates a deleted D1, bucket or Workflow; reviving the canary after deprovisioning needs a new owner GO, a recreated domain and, for a full-size dataset, the unresolved memory design.
- `keep_vars: true` can leave the live var `EPG_DIAGNOSTIC_RESOURCE_ID` after deploy; removal is a separate owner-approved settings operation.

## Alternatives considered

- Keep the wiring dormant: rejected by the card scope; it leaves an unused owner route and three bindings on the production Worker.
- Delete the inert modules: not necessary and loses the reviewed design; revisit only if independent review finds a concrete reason.
