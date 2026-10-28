# AIR-206 S5 — selective prediction stabilization, read-only acceptance

**Observed:** 2026-10-28, production IPTV MCP read-only tools. **Owner authorization:** S5 read-only verification in the AIR-206 conversation; no manual model run, task edit, flag, queue reconcile, or R2/D1 mutation. **Card:** https://trello.com/c/87mg3VNi

**Verdict:** **GO for bounded selective-invalidation acceptance**, not proof of completed continuous prediction run or a full per-record audit. The observed queue is consistent, the original compatible count is stable, and new exact v2 predictions accumulate while stale predictions decrease.

| Metric | At S4 publication (05:49 UTC) | S5 final read (07:39:36.565 UTC) |
| --- | ---: | ---: |
| Films evaluated | 2,342 | 2,344 |
| Exact predictions under v2 | 0 | 62 |
| Compatible predictions retained from v1 | 2,054 | 2,054 |
| Stale | 288 | 228 |
| Profile-impacted stale | 286 | 226 |
| Unknown-feature stale | 2 | 2 |
| wouldRequeue / strictDisagreements | 0 / 0 | 0 / 0 |
| Coverage | 2,054 / 2,342 (87.7%) | 2,116 / 2,344 (90.3%) |

**Fresh snapshot:** `compatibility.mode=selective`, `profileVersion=2`, `evaluatorVersion=1`, unchanged `profileHash=78d004ea85340f941f8c53a1cc48c73c8c80622c49bc78a6166673a5c56f449d`. Queue `refreshedAt=2026-10-28T07:39:36.565Z`, overview `consistent=true`, `partial=false`, `reasons=[]`. Pending overview 228 (hot 175, cold 53), runner list `pendingCount=197`; the difference is 31 cold non-watchlist records, as documented at S4. Retry deferred 0.

**Film sample:** `2Eao`, `w0e6`, and `d2hI`: `prediction.current=true`, `profileMatch=false`, `cause=compatible`, `mode=selective`, index agreed. `Dh8e`, `H4k`, `3dqc`, `4sr2`: stale `profile_changed`, mode selective, index agreed (three hot, one outside queue). Sample does **not** prove all 2,054 predictions remained byte-identical; the stable aggregate and original-profile mismatch support that they were not restamped to v2.

**Intermediate observation:** An earlier read at 07:04:42.665Z saw `index_ahead_of_queue` and `partial=true`, resolved without intervention by 07:05:21.673Z; the latest check at 07:39:36.565Z remained consistent.

**Continuous execution limitation:** `lastBatch` still references a v1 scheduled run ending 05:25:54.006Z. The owner explained that the next prediction task remained in a continuous loop, which updates predictions and the queue incrementally; no completed v2 `lastBatch` was visible. This report verifies bounded progress and consumer invariants, **not** the final terminal outcome of the run. A later operational health check should confirm its eventual completion, but this is not a prerequisite to accepting the selective evaluation mechanism.

**Caveats:** two new evaluated film ids appeared between S4 and S5; attribution of all 62 exact results to individual run/submit records was not independently audited; current coverage is based on queue/index snapshots. No full census of impacted genres or unchanged prediction payloads was performed. Do not characterize the report as exhaustive storage parity.

**Documentation impact:** dated evidence report only, with registry indexes. No contract, architecture, ADR, or production configuration change.
