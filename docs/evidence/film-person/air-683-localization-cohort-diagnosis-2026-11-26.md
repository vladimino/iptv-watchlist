# AIR-683: read-only diagnosis of the Film localization reconciliation cohort

Date: **26 November 2026** (UTC). Card: [AIR-683](https://trello.com/c/VJYgJuOW); upstream [AIR-663](https://trello.com/c/UP10l6Js), consumer [AIR-664](https://trello.com/c/Og9XxXfy); [ADR 0218](../../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 stage 4 (unchanged). Runbook: [Read-only cohort diagnosis](../../runbooks/film-localization-reconciliation.md#read-only-cohort-diagnosis-air-683).

**Status: live diagnosis complete on 27 November 2026 (UTC).** The capability delivered on 26 November was exercised through the owner-only IPTV MCP identity on 27 November. No production repair was authorized or performed.

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

## 3. Live cohort (27 November 2026, scoped L0 read)

The Delivery Controller walked the canonical D1 Film table through the already delivered `film_localization_diagnose` entry, from the first Film to the last cursor. The implementation and its independent review were delivered in [PR #1027](https://github.com/vladimino/iptv-watchlist/pull/1027), main `b6fdb822ac441076a909becd1910ac4926fd6ace`; [post-merge CI/deploy](https://github.com/vladimino/iptv-watchlist/actions/runs/45785582713) passed. No alternate resolver or approximate SQL eligibility filter was used.

| Item | Live result |
| --- | --- |
| Examined | 13,867 |
| Current (noop) | 13,851 |
| Stale (eligible at the time observed) | 16 (0.1154% of examined Films) |
| Held / reasons | 0 / none |
| Absent (redirect or missing) | 0 |
| Unavailable / codes | 0 / none |
| Accepted invocations | 185 (184 normal `d1_query_budget` continuations; last `reachedEnd: true`) |
| D1 queries reported by accepted invocations | 182,136; largest call 989 of 1,000; largest reported per-Film query cost 14 |
| Sum of accepted invocation `elapsedMs` | 2,921,571 ms (48 min 41.571 s); not overall wall-clock time |
| Coverage | First call `startedAfter: ""`, last cursor `film:zu4c`, `reachedEnd: true`; independent read-only D1 count before and after: 13,867 Films; zero Films after the final cursor |
| Time boundary | 27 Nov 2026 UTC; first range recorded by 20:46:49 UTC in [Trello](https://trello.com/c/VJYgJuOW), final count and read-only probe by 21:49:41 UTC. These are evidence-record bounds, not exact start/end timestamps. |

Every accepted response was checked for HTTP 200, matching preceding cursor, strict advancement for nonterminal ranges, matching classification totals, normal continuation or terminal end, no failure, query budget, and identical stable start/end authority pins across the walk. The pins were Film/Person `open`, generation 2, schema 38, baseline `verified`; owner-review `d1`, writes `open`, generation 1. The final read-only SQL verification returned schema 38 and `rows_written: 0`.

| Contiguous range groups | Start after | End cursor | Examined | Noop | Stale | D1 queries | Sum elapsed ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1-131 | empty | `film:tmdb:56648` | 9,825 | 9,812 | 13 | 129,050 | 2,083,410 |
| 132-185 | `film:tmdb:56648` | `film:zu4c` | 4,042 | 4,039 | 3 | 53,086 | 838,161 |
| Total | | | 13,867 | 13,851 | 16 | 182,136 | 2,921,571 |

One orchestration batch timed out without returned range evidence; its unconfirmed results were excluded, and the walk resumed from the last accepted cursor. There were no gaps in accepted ranges. The resource totals cover only the 185 returned, validated invocations, not the abandoned attempts, independent SQL count checks, probe, pauses or tool overhead. The first 75 Films were observed before the continuation request; the walk was not restarted for a clean result.

**Observed stale Film ids (16, sanitized; no localization values or intent bodies):**

`film:1XYA`, `film:27iE`, `film:28R6`, `film:DCVQ`, `film:MYia`, `film:QGFo`, `film:R9dS`, `film:RTwc`, `film:RfZI`, `film:iXBq`, `film:jGuE`, `film:tmdb:101669`, `film:tmdb:516486`, `film:tmdb:649409`, `film:vCu0`, `film:xG0M`.

**Verdict.** The walk is complete for the observed keyset ranges; it is not a globally consistent snapshot. Stable authority pins and equal start/end counts do not rule out concurrent Film edits or insertion behind a cursor. Positive stale counts correctly make affected ranges not clean; the all-`rangeClean` condition is required for a zero-eligible verdict, not for accepting a positive census. AIR-664 cannot be closed as a no-op. The measured cohort is small: revalidate these 16 candidates immediately before any proposed repair and prefer a narrow, one-off operation using the existing resolver, per-Film fenced writer, receipt, pre-image and exact-revision restore contracts. Determine the minimal durable intent-recording mechanism against that real scope before selecting a storage or operator design. Do not assume the historical wave architecture is necessary, create a new service or implement writes from this evidence. A separate owner-approved operation contract/GO is required.

The diagnosis invoked no production writer, external producer, sync, flag, migration, Task, Access change or R2/D1 mutation. The [read-side effect audit](../../reference/api/read-side-effects.md) and offline fixtures remain the evidence for the diagnostic entry's no-write behavior. Independent count verification and the read-only MCP probe also completed successfully. The diagnostic result, not the later repair, is the AIR-683 acceptance boundary.
