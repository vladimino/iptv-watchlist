# AIR-314 owner-review activation, 3 November 2026

**Captured:** 2026-11-03 23:13:04 UTC. Production D1 database `iptv` and R2 bucket `iptv`. One owner confirmation, given in chat at 00:11 Europe/Madrid on 4 November, covered setting `owner_review_authority.mode` to `d1` only. It did not include a second import, an R2 write, or any other marker. The schema apply at 22:54 UTC and the import at 23:06 UTC are separate records ([apply](air-314-0009-apply-2026-11-03.md), [import](air-314-owner-review-import-2026-11-03.md)).

**Scope:** flip the marker from `r2` to `d1` and leave generation, the mirror generation, the rows and the object as the import left them. Not a second import, not an R2 put, and not a prediction, published-EPG, metadata-cache, ratings or discovery write.

## Method

`scripts/owner-review-authority.mjs` does not call the network and refuses a production database path, so it was not the entry. The activation is `activateOwnerReviews` from `src/owner-review-d1.js` with `confirm` `activate`. Reads used the D1 HTTP adapter. The write was that function's one `batch` of two statements: set `mode` to `d1` only while `mode` is `r2`, `writes` is `open`, and `generation`, `mirror_generation` and `mirror_etag` still match the import fence, plus the compare-and-swap fence. The body is the same `{batch}` the published-EPG operator sends, not a Worker binding `batch`. The R2 client sent `GET` and `HEAD` only and has no put. The request was sent once. `adapter.stats.batches` was 1 and `writeState` was `committed`.

Immediately before that request the same process read version 9, marker `mode` `r2`, generation 1, `mirror_generation` 1, `mirror_etag` prefix `07d2d33117a4`, `writes` `open`, and 7 entry rows. `HEAD admin/owner-reviews.json` returned 20069 bytes and the same ETag prefix. The function required generation equal to `mirror_generation` and the object ETag equal to `mirror_etag`, proved the stored document equalled the object, then sent the batch. It does not change generation and does not rewrite rows.

The prediction marker was `d1` / `writes` `held` / generation 2304. The published-EPG marker was `d1` / `open` / generation 2 / watchlist generation 2. The metadata-cache marker was `d1` / generation 34. No Time Travel bookmark was read.

## Read-back

| Check | Result |
| --- | --- |
| `schema_contract.version` | 9 |
| Marker | `mode` `d1`, generation 1, `mirror_generation` 1, `writes` `open` |
| `mirror_etag` | prefix `07d2d33117a4`, unchanged |
| `owner_review_entry` rows | 7 |
| Film rows | 3, all `identity_state` `verified` |
| Person rows | 4, all `identity_state` `verified` |
| Held rows | 0 |
| Document | equal to the object on a second read |
| `admin/owner-reviews.json` | still 20069 bytes, ETag prefix `07d2d33117a4` |
| Prediction, published EPG, metadata cache | unchanged |
| `activatedGeneration` | 1 |

No source key, identity link or review text is in this record.

## Verdict

**Activation holds.** `mode` is `d1`. Generation stayed 1. Admin, programme, watchlist and the catalogue read the rows and do not fall back to the mirror. `reviewsVersion` is `d1:1`. A pin taken while the marker was `r2` does not match. An open admin card that still holds the R2 etag needs a refresh before the next save.

**Not done.** UI acceptance of the live Admin cards, and revert. A code rollback does not drop the rows or return the marker. Returning the marker to `r2` is `--revert --confirm r2` on the offline script after a matching mirror put, and is its own approval. This activation did not put the mirror. Restoring the database is a Time Travel of the whole database and is its own approval.

**Limits.** One request, one read-back. No Worker route. No bookmark. The REST `{batch}` is not proof of Worker-binding atomicity; the read-back is the proof that this activation landed.
