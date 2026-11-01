# Prediction domain marker, local contract, 1 November 2026

**Captured:** 2026-11-01. Local tests only. Production D1 `iptv` and R2 bucket `iptv` were not read and were not written. No migration was applied, no snapshot was loaded, and the marker was not switched. No flag, cron, Access, Scheduled Task or model run.

**Scope:** the schema v7 marker in `migrations/0007_prediction_authority.sql` and the Worker path in `src/prediction-d1.js`. Not a cutover, and not a measurement of the live queue.

## Method

`node tests/prediction-domain.mjs` on a temporary SQLite file with migrations `0001` through `0007`, and the same file stopped at `0006`. The D1 binding is the test stand-in. The bucket is in memory. The projector run uses the Worker projector with `D1_ENRICHMENT_WRITE=on` against that file. The operator script is `scripts/prediction-domain-authority.mjs` against another temporary file. It is refused for a database path named `iptv`.

## Result

| Check | Result |
| --- | --- |
| Schema v6 | Marker tables are absent. Queue reads and writes stay on the object. |
| Schema v7, mode `r2` | A mutable save advances `generation` and does not insert a domain row. A stale generation does not put. |
| Partial v7 | A missing fence table fails the read. The object is not the fallback. The projector run is `failed` with `prediction_domain_unavailable` and writes nothing. |
| Import | One off-watchlist fingerprint, one redirect prediction with one history row, the queue retries and one run. `film` row count is unchanged. No `film:off-watchlist` row. |
| Mode `d1` | Reads return the tables after the mirror objects are replaced with different bytes. A missing or altered version object fails the read. A second queue write with the old generation does not land. A lease write with the old token does not land. A prediction pointer is not inserted when its version object is absent. 81 history rows are refused. |
| Revert | Mode returns to `r2`. The profile row remains. A later activate with the wrong generation fails. |
| Projector on a complete v7 | Outcome `complete`, `schemaVersion` 7, `predictionMode` `r2`. The fingerprint table stays empty. Schema v6 status stays `schema: true` and has no `predictionMode`. |
| One fingerprint read | Fewer than 8 D1 queries. |
| Script | Status writes nothing. Load, activate and revert on the temporary file leave mode `r2`, then `d1`, then `r2`. |

## Verdict

**The local contract holds.** Schema v7 defaults to `r2`. Mode `d1` is the only owner of the mutable rows, and it checks the immutable body before a pointer is trusted. The import does not create a Film. This does not apply `0007` and does not authorize a load, an activation, a revert, or a production write.

**Limits.** One fixture, not the live queue. The 80-row history cap and the 900000-character queue cap were not compared with production. No scheduled run was observed.
