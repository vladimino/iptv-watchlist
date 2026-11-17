# EPG diagnostic runtime retirement: fresh preflight and detach (AIR-457, 17 November 2026)

Scope: [ADR 0159](../../adr/0159-detach-epg-diagnostic-runtime.md), [ADR 0121](../../adr/0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](../../adr/0124-epg-diagnostic-canary-run-contract.md). The preflight below was read-only, before the owner's later retirement decision and manual deprovisioning. The final verification and its independent evidence sources are recorded at the end. The reviewer performed only read operations against Cloudflare.

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

## Delivered and verified (17 November 2026)

- [PR #714](https://github.com/vladimino/iptv-watchlist/pull/714), merged as `106e40cfc15e6b86a5e8019d6e428215411d9b6d`, detached the diagnostic D1/R2/Workflow bindings, diagnostic API route and Workflow class. [Post-merge CI/CD](https://github.com/vladimino/iptv-watchlist/actions/runs/44106114307): all three test/build jobs and Cloudflare deploy passed.
- The owner removed the residual `EPG_DIAGNOSTIC_RESOURCE_ID` plain-text Worker variable separately. Subsequent Cloudflare script settings API readback returned 18 bindings, with **zero** `EPG_DIAGNOSTIC_*` entries. Production `DB` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`), `BUCKET` (`iptv`), and the EPG, Discovery, Ratings and Producer Workflows remained bound.
- Following an explicit owner decision to retire all diagnostic resources, the owner reported manually deleting the dedicated Workflow, diagnostic D1 and EU R2 bucket. Independent read-only Cloudflare API GETs confirmed `iptv-epg-diagnostic` Workflow **404** (`workflow.not_found`) and D1 UUID `38033d5e-9460-4d24-95d1-ff4a0af56b20` **404** (`database not found`).
- The diagnostic EU R2 bucket could not be verified by the connector's default-jurisdiction API: **404 was already returned before deletion**, and was not used as proof. For independent verification the reviewer read the owner's open Cloudflare Dashboard tab `R2 Object Storage` at `/r2/overview`. The bucket inventory table had an **empty search field** and showed exactly **one bucket, `iptv`**, with about 26.06k objects and 2.29 GB. `iptv-epg-diagnostic` was absent from this visible inventory. A stale `Recents` shortcut was not treated as evidence of an existing bucket. This dashboard inventory, the owner's deletion report, and the separate D1/Workflow API 404 results jointly support retirement acceptance.
- No diagnostic instance was ever launched (pre-deletion API result: 0 instances); D1 pre-deletion had 0 receipts and one diagnostic identity row. Production resources, flags, Access, scheduled Tasks and the permanent D1/R2 credentials were not changed by the reviewer. Any future recreation is a new owner-approved operation; a code rollback cannot recreate the deleted resources.

**Acceptance:** the unused diagnostic runtime and three dedicated cloud resources have been retired. Reviewer/Controller access was read-only for Cloudflare throughout the verification; all cloud deprovisioning was performed by the owner.
