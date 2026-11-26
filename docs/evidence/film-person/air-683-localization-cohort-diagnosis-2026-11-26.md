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

- `diagnoseLocalizationCohort` (in `src/film-localization-reconciler.js`) over the same `classifyFilm` the dry run uses; the only Worker entry is the owner-only MCP tool `film_localization_diagnose`. No new service, Workflow, queue, storage, table or migration.
- Equality with the oracle: on a 121-Film fixture (5 stale, 1 reviewed-row hold, 1 redirect, the rest current) the contiguous ranges of the walk sum to the summed dry-run pages (stale ids, held reasons, noop, absent, unavailable).
- **Real limit** (review of the first revision corrected it): [D1 allows 1,000 queries per Worker invocation on Paid, a batch counting as one](https://developers.cloudflare.com/d1/platform/limits/) (page updated 20 Nov 2026); the earlier 10,000-subrequest and 500-Film rationale was wrong and is removed. The call counts its own D1 executions and stops before the next Film (`d1_query_budget`). Measured on the fixture: **2 invocations for 121 Films (983 + 486 D1 queries, none above 1,000 including the closing pin reads), at most 13 queries per Film.** A Film with many owner entries or ancestors costs more, which is why the stop uses the largest cost seen.
- Range semantics: a resumed call, a clean suffix after the last stale Film and a cursor beyond the last Film are never `complete` or `zeroEligible` (fixtures); an empty table with a non-D1 owner-review domain or a held marker is refused; a moved owner-review generation during the walk gives `pinsStable: false` and blocks zero; an unavailable Film is never zero.
- No effect: the fixture snapshot of `film_dimension`, `film_localization_source` and receipts is unchanged; `tests/get-write-audit.mjs` (8 scenarios, instrumented R2 and D1) shows no R2 or D1 write, receipt, workflow, dispatch, background or outbound effect; the tool is anonymous-refused (403) and never reads R2.

## 3. Live cohort (to be filled by a scoped L0 read)

| Item | Value |
| --- | --- |
| Films examined, current (noop), stale, held (by reason), absent, unavailable (by code) | **unknown, not read** |
| Coverage and time boundary | **unknown** |
| Authority and schema pins (Film/Person marker, schema version, owner-review domain and generation) per call | **unknown, not read** |
| Observed cost and duration of the live walk | **unknown** |
| Verdict | **none**: AIR-664 cannot be closed as a no-op and no eligible count is claimed until contiguous ranges from the first Film to a `reachedEnd` range, every one `rangeClean` with identical pins and no `failure`, are recorded here (`stopped` of `d1_query_budget` or `budget` is a normal continuation) |

Next step for the Controller or owner: after the post-merge deploy, call `film_localization_diagnose` repeatedly with the returned `cursor` until a range reports `reachedEnd`, then aggregate the ranges and record the sanitized aggregates in section 3 (ids and counts only, no payload).
