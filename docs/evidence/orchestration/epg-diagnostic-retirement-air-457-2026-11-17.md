# EPG diagnostic runtime retirement: fresh preflight and detach (AIR-457, 17 November 2026)

Scope: [ADR 0159](../../adr/0159-detach-epg-diagnostic-runtime.md), [ADR 0121](../../adr/0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](../../adr/0124-epg-diagnostic-canary-run-contract.md). Everything here was read-only; no resource, binding, token, flag, Workflow or data was changed, and no diagnostic or production run was started. This is not an owner GO for deploy or deprovisioning.

## Fresh read-only preflight (17 November 2026, about 14:40 Madrid, 13:40 UTC; `main` `30896e2`)

| Check | Result |
|---|---|
| Deployed Worker `iptv` bindings (Cloudflare API settings read) | 22 bindings (26 on 12 November). Diagnostic ones present: `EPG_DIAGNOSTIC_DB` (D1 `38033d5e-9460-4d24-95d1-ff4a0af56b20`), `EPG_DIAGNOSTIC_BUCKET` (R2 `iptv-epg-diagnostic`, jurisdiction `eu`), `EPG_DIAGNOSTIC_WORKFLOW` (`iptv-epg-diagnostic`, `EpgDiagnosticWorkflow`), var `EPG_DIAGNOSTIC_RESOURCE_ID` = `epg-diag-20261112` |
| Production bindings | `DB` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, `BUCKET` `iptv`: unchanged |
| Workflow `iptv-epg-diagnostic` | 0 instances in every state, `triggered_on` null; instances list `total_count` 0 |
| Other Workflows (not touched) | `iptv-epg` 10 complete, 1 terminated; `iptv-ratings` 7 complete; `iptv-discovery` 1 running, 1 errored, 581 complete; `iptv-producer` 24 errored (unrelated to this card, noted only) |
| Diagnostic D1 | WEUR, 109 tables by metadata (111 in `sqlite_master`), 946 176 B; `epg_diagnostic_receipt` 0 rows; `epg_diagnostic_identity` 1 row (`epg-diagnostic`, `epg-diag-20261112`, created 2026-11-12T18:37:34Z); `rows_written` 0 on every read |
| EU R2 `iptv-epg-diagnostic` | Exists: location EEUR, jurisdiction `eu`, created 2026-11-12T16:30:29Z (bucket info with the `cf-r2-jurisdiction: eu` header). The default-jurisdiction query returns 404, which proves nothing about the EU bucket |
| EU bucket contents | **Not verified.** This connector cannot list objects in the EU jurisdiction; the bucket must not be treated as empty until a read-only EU-aware listing (Wrangler or the scoped key) is done before any deletion |

## Detach in code (PR of AIR-457)

Removed: the four diagnostic entries of `wrangler.jsonc`, the `/api/epg/diagnostic/*` route in `src/worker.js`, the `EpgDiagnosticWorkflow` class in `build.mjs`. Kept: the inert modules, operator script and tests (now driving `EpgDiagnosticRun.route` directly), ADR 0121/0124/0139, evidence. `tests/epg-diagnostic-bindings-ready.mjs` now asserts the absence of every diagnostic binding, var, route and class and the unchanged production bindings, Workflows, cron and `keep_vars`.

## Not done, needs a separate owner GO

Merge and deploy of the PR (live binding, route and Workflow-class change, L3); readback of the deployed bindings afterwards (including whether `keep_vars` left the var); deprovisioning of the Workflow definition, D1 and EU R2 bucket with exact UUID and name and no blind retry of an unknown DELETE. Tokens and keys are explicitly out of scope.
