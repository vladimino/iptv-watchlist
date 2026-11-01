# Prediction domain marker, local contract, 1 November 2026

**Captured:** 2026-11-01. Local tests only. Production D1 `iptv` and R2 bucket `iptv` were not read and were not written. No migration was applied, no snapshot was loaded, and the marker was not switched. No flag, cron, Access, Scheduled Task or model run.

**Scope:** the schema v7 marker in `migrations/0007_prediction_authority.sql`, the Worker path in `src/prediction-d1.js`, and the production entry `scripts/prediction-domain-production.mjs` against an injected local binding. Not a cutover, and not a measurement of the live queue. The decision record is [ADR 0078](../../adr/0078-d1-authoritative-prediction-domain.md), still Proposed. ADR 0076 remains the accepted backfill decision.

## Method

`node tests/prediction-domain.mjs` on a temporary SQLite file with migrations `0001` through `0007`, and the same file stopped at `0006`. The D1 binding is the test stand-in. The bucket is in memory. The projector run uses the Worker projector with `D1_ENRICHMENT_WRITE=on` against that file. The operator script is `scripts/prediction-domain-authority.mjs` against another temporary file. It is refused for a database path named `iptv`. `node tests/prediction-domain-production.mjs` calls `scripts/prediction-domain-production.mjs` with that same stand-in and an in-memory bucket, and again with `createPredictionBinding` over `createD1Adapter` against a local HTTP server and a temporary SQLite file. That server is not Cloudflare. No credential is read. `node tests/local-api.mjs` builds the Worker and requests `GET /api/enrichment/view`.

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
| Latest election | Saving an older run file after a newer latest-run leaves the latest run id unchanged. |
| Version 8 | Mode `d1` does not read the R2 queue. Dropping `prediction_queue` fails the read and leaves the object. Projector status is `schema: true` with `predictionMode` `r2` while the ten tables exist, and `schema: false` after `prediction_fingerprint` is dropped. |
| Import fence | A finished `r2` claim at generation 1 still loads. An open intent throws `prediction_domain_busy` after the hold and writes no queue chunk. A stale fence of generation 0 throws `prediction_domain_cas` and does not replace the queue. An active lease throws `prediction_domain_busy` before a queue row is written. Three fingerprints are separate batches, each at most 100 statements. |
| Missing binding | `PREDICTION_DB_REQUIRED=on` with no `DB` throws `prediction_domain_unavailable` and does not return the object. Without the variable, no binding stays `mode` `r2`. `wrangler.jsonc` sets the variable to `on` beside the `DB` binding. |
| Mood | The overlay takes the mood function as an argument. A `globalThis` assignment is not consulted. The built Worker, in `d1`, returns `GET /api/enrichment/view` mood ids from the D1 fingerprint (`tense`) where the stored index said `light`. The same route with the variable and no binding does not return 200. |
| Limits and transport | A prune of 101 extra ids goes through the production binding. Every write body is `{sql}`, not `{batch}`, and no statement names more than 80 of those ids. A queue whose JSON is longer than 100 KB round-trips as chunks, each rendered statement at most 100 KB. A `{sql}` unit whose last statement fails leaves the earlier insert of that request uncommitted. A dropped socket after one write is `writeState` `unknown`, `writes` true, and that request is not sent again. |
| Quiescence and partial writes | A queue put paused after the claim makes `--load` and `--activate` return `prediction_domain_busy` with `writeState` `partial`. Mode stays `r2` and the stale snapshot is not stored. After the put finishes, the load stores the new document. A failure after two committed batches reports `partial`, not `none`. `--release` sets `writes` back to `open` after a load. |
| Revert | A missing immutable body leaves mode `d1`. A successful revert rewrites a stale queue mirror to the D1 document. |
| Production entry, local only | No arguments write nothing and do not call fetch. `--load` without `--confirm load` and a target other than `iptv` are refused before the binding is used. `--apply` on schema v6 reads back version 7, mode `r2`, generation 0, and a second apply is `already_applied`. Load after a claim stays at that generation. An active lease imports nothing. A generation move during the first batch is retried and the second attempt commits. Activation with a drifted snapshot stays `r2` with `prediction_domain_parity`. Revert with a missing body stays `d1`. Revert rewrites the stale queue mirror and then sets `r2`. |

## Verdict

**The local contract holds.** Schema v7 defaults to `r2`. Mode `d1` is the only owner of the mutable rows, and it checks the immutable body before a pointer is trusted. The import does not create a Film. This does not apply `0007` and does not authorize a load, an activation, a revert, or a production write.

**Limits.** One fixture, not the live queue. The 80-row history cap and the 900000-character queue cap were not compared with production. The local HTTP adapter proved a queue above 100 KB and a prune above 100 ids. Activation of the production entry refuses an over-cap snapshot; that refusal was not exercised against a live snapshot. No scheduled run was observed. No production database or bucket was contacted.
