# AIR-320 pipeline status above the D1 read cap, 4 November 2026

**Captured:** 2026-11-04 22:32:50 UTC (coordinator MCP) and a later local test of the status walk. Production Worker `iptv`, production D1 `iptv`. The MCP call was `epg_pipeline_status` and wrote nothing.

**Scope:** after the discovery marker was `d1` / `open` at generation 1 with 36999 active observations, the pipeline status still answered `ledgerTotal` 0, `candidates` 0, `checked` 0 and `archive.activeItems` 0, while it did return `verifiedFilms` 2635 and `scoringPreview.rows` 1.

## Method

The coordinator compared that HTTP 200 body with an operator D1 count of 36999 active observations. The code path on `main` `e0ba4188e8b9aaac85b98f24e8e252cc1781077c` was `DiscoveryAuthority.readLedger`: a count above `READ_CAP` 20000 returns `{paged:true,itemCount,items:null}`. `ledgerStatusAggregates` then walked `loaded.items||[]` and published those zeros. `READ_CAP` was not raised in this delivery.

The fix walks active observations in `LEDGER_PAGE` rows with that page's decisions only (`streamActiveLedger`). A whole-document `routeRead` of the ledger is still paged above the cap. Held stays on R2. `loading` and a torn version-11 marker fail closed.

Local proof is `tests/discovery-pipeline-d1-status.mjs` (21001 active rows plus one archive-only key) and the existing streamed R2 status test.

## Verdict

**Reader defect confirmed on the live marker; the local walk matches `ledgerCounts`.** A production status read after this deploy is a separate check. It is not Finds, Admin limbo, or a discovery writer.
