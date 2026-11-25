# AIR-683: read-only diagnosis of the Film localization reconciliation cohort

Date: **26 November 2026** (UTC). Card: [AIR-683](https://trello.com/c/VJYgJuOW); upstream [AIR-663](https://trello.com/c/UP10l6Js), consumer [AIR-664](https://trello.com/c/Og9XxXfy); [ADR 0218](../../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 stage 4 (unchanged). Runbook: [Read-only cohort diagnosis](../../runbooks/film-localization-reconciliation.md#read-only-cohort-diagnosis-air-683).

**Status: capability delivered offline; the live cohort is NOT yet measured.** Delivering the code runs nothing. The live scan needs the owner-only IPTV MCP identity, which the delivering session did not have, so every live count below is **unknown**, not zero.

## 1. Existing means checked first

| Means | Result |
| --- | --- |
| Authorized read-only D1 SELECT (Cloudflare connector, IPTV MCP read tools) | Reads rows, cannot run `resolveLocalization` (owner precedence, redirect ancestors); an SQL filter would replace the effective-value check the card forbids. Not sufficient. |
| Offline private copy with proven freshness | None available. |
| Entry to the AIR-663 dry run | **None** (module was dormant): the one proven gap. |

## 2. Capability (offline, synthetic SQLite fixtures built from every migration)

- `diagnoseLocalizationCohort` (in `src/film-localization-reconciler.js`) on top of `dryRunLocalizationReconcile`; the only Worker entry is the owner-only MCP tool `film_localization_diagnose`. No new service, Workflow, queue, storage, table or migration.
- Equality with the oracle: on a 121-Film fixture (5 stale, 1 reviewed-row hold, 1 redirect, the rest current) the aggregate equals the sum of the dry-run pages (stale ids, held reasons, noop, absent, unavailable). An unavailable owner domain is `unavailable`, never zero; an early stop is incomplete and never zero; an empty table walked to its end is zero.
- No effect: the fixture snapshot of `film_dimension`, `film_localization_source` and receipts is unchanged; `tests/get-write-audit.mjs` (8 scenarios, instrumented R2 and D1) shows no R2 or D1 write, receipt, workflow, dispatch, background or outbound effect; the tool is anonymous-refused (403) and never reads R2.
- Measured cost: **12.13 D1 statements per Film** (1,468 for 121 Films). A Worker invocation allows 10,000 subrequests (Workers Paid), so one call examines at most **500 Films** (about 6,100 statements) or stops after a 20 s budget and returns a cursor. This bound comes from the subrequest limit, not from the dormant reconciler's 50 and 25.

## 3. Live cohort (to be filled by a scoped L0 read)

| Item | Value |
| --- | --- |
| Films examined, current (noop), stale, held (by reason), absent, unavailable (by code) | **unknown, not read** |
| Coverage and time boundary | **unknown** |
| Authority and schema pins (marker, owner-review domain, version) | **unknown, not read** |
| Observed cost and duration of the live walk | **unknown** |
| Verdict | **none**: AIR-664 cannot be closed as a no-op and no eligible count is claimed until a complete walk (`complete`, `unavailable` 0, `authorityStable`, `stopped` null across all calls) is recorded here |

Next step for the Controller or owner: after the post-merge deploy, call `film_localization_diagnose` repeatedly with the returned `cursor` until `complete`, then record the sanitized aggregates in section 3 (ids and counts only, no payload).
