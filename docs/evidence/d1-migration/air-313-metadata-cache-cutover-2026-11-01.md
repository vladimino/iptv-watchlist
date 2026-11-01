# AIR-313 metadata cache marker cutover, 1 November 2026

**Captured:** 2026-11-01, reads at 12:06–12:48 UTC. Production D1 `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`) and R2 bucket `iptv`. Worker code for the cache path was already deployed; the deploy that was current before the 12:37 UTC cron is `main` `01a9bb2ce5c52c4a1ac49005cc6520f27af8d63a` (PR #304). The operator commands ran from that same operator, merged in `016ff3989286466d4c664c38ed0ebf185e590aa4` (PR #303). No flag, cron, Access, Scheduled Task or R2 write.

**Scope:** schema `0006`, copy of live `metadata.json` into `metadata_cache`, marker `r2` → `d1`, then the next natural projector cron. Not Film/Person authority, not the general D1 backfill, not a `metadataSync` save.

**Method:** `scripts/metadata-cache-production.mjs` against `iptv` only, three separate owner confirms. Each command read the D1 bookmark before its write. A later read-only status and three read-only D1 queries (`describe`, `projection_run` for `enrichment`, `metadata_cache_authority` plus `COUNT(*)`) checked the cron. `adapter.stats.batches` stayed 0 on those reads. `GET /api/enrichment/status` was not called.

## Commands

| Step | UTC | Result |
| --- | --- | --- |
| `--apply --confirm apply` | 12:06 | `writeState=committed`. Schema 6, three cache tables present, `mode=r2`, generations 0 and 0, 0 cache rows. Bookmark before the write: `0000005f-00000000-00005116-b1d8e782aa7ff044496ef6141edbf08c` |
| `--load --confirm load` | 12:08 | `writeState=committed`. 423 keys round-tripped. `mode=r2`, `cacheGeneration=1`, `mirrorGeneration=1`. Bookmark: `00000060-00000002-00005116-1c234607e39625df8bef713e5e7a733e` |
| `--activate --confirm activate` | 12:10 | `writeState=committed`. `mode=d1`, generations still 1 and 1, 423 rows. Bookmark: `00000060-00000005-00005116-4f0afa460001b5c3319701a075b0e9c3` |

`metadata.json` at each of those reads: 423 keys, 1,170,720 bytes, etag `f1d608dafc2d6755bf4ec7545d3084f0`, sha256 `154aac883a31936896e40a9da7c4a02dfaf6d3f8e474e705e21f68516204c869`.

## Natural cron

`projection_run` for `enrichment` started `2026-11-01T12:37:31.416Z` and finished `2026-11-01T12:37:39.617Z`. `trigger=cron`, `mode=on`, `schemaVersion=6`, `outcome=partial`, lease released. 8,201 ms, 323 queries, `remaining=0`, `leaseLost=false`. It wrote 178 people and 30 of 31 changed films. `errorCount=1`: `film:K1R2` / `identity_collision`. `changedSync=1` and `syncWrites=0`, so that planned sync change did not land. The cache marker after the run was still `mode=d1`, generations 1 and 1, `mirror_etag` the same, 423 rows. The R2 object etag, size and key count were unchanged. Writers were idle on the following status.

On schema v6 the projector calls `useAuthoritativeMetadata` before the view. In `d1` mode that call replaces the in-memory metadata from `metadata_cache` and fails the run before any write when the cache cannot be read. This run wrote films and people, so that call returned. It is not an observation of `beginSync` or `metadataSync` saving the cache.

## Verdict

**Marker cutover holds after the first natural projector cron.** The cache is the metadata source that cron used. The run was `partial` because one film write failed, and the one planned sync change did not write. No `metadataSync` save was observed, so the mirror-repair path is unproven. This does not close AIR-313 and does not authorize a revert, a Time Travel restore, or another load.

**Limits.** One cron. `film:K1R2` was not retried. `/api/d1/status` was not fetched through the Worker. The read-back is the D1 rows and the R2 head, not a second copy of all 423 payloads.
