# AIR-314 owner-review import, 3 November 2026

**Captured:** 2026-11-03 23:06:51 UTC. Production D1 database `iptv` and R2 bucket `iptv`. One owner GO, given in chat at 00:04 Europe/Madrid on 4 November, covered the import of `admin/owner-reviews.json` only. Activation of `owner_review_authority.mode` to `d1` was not included and was not run. The schema apply at 22:54 UTC is a separate record ([apply](air-314-0009-apply-2026-11-03.md)).

**Scope:** copy the live object into `owner_review_entry` and leave the marker at `r2`. Not an authority flip, not an R2 write, and not a prediction, published-EPG, metadata-cache, ratings or discovery write.

## Method

`scripts/owner-review-authority.mjs` does not call the network and refuses a production database path, so it was not the entry. The import is `importOwnerReviews` from `src/owner-review-d1.js` with `confirm` `load`. Reads used the D1 HTTP adapter. The write was that function's one `batch`: the same `{batch}` body the published-EPG operator sends, not a Worker binding `batch`. The R2 client sent `GET` and `HEAD` only. The request was sent once. `adapter.stats.batches` was 1 and `writeState` was `committed`.

Immediately before that request the same process read version 9, marker `mode` `r2`, generation 0, `mirror_generation` 0, `mirror_etag` null, `writes` `open`, and 0 entry rows. `HEAD admin/owner-reviews.json` returned 20069 bytes and ETag prefix `07d2d33117a4`. The prediction marker was `d1` / `writes` `held` / generation 2304. The published-EPG marker was `d1` / `open` / generation 2. The metadata-cache marker was `d1` / generation 34. No Time Travel bookmark was read.

The function then read the object, checked the ETag again, classified each source key against the existing Film and Person rows, and sent one batch: hold `writes`, fence, replace the entry rows, set generation 1 and the mirror ETag, fence again. It proved the stored document equalled the object and left `mode` at `r2`.

## Read-back

| Check | Result |
| --- | --- |
| `schema_contract.version` | 9 |
| Marker | `mode` `r2`, generation 1, `mirror_generation` 1, `writes` `open` |
| `mirror_etag` | prefix `07d2d33117a4`, the object's ETag |
| `owner_review_entry` rows | 7 |
| Film rows | 3, all `identity_state` `verified` |
| Person rows | 4, all `identity_state` `verified` |
| Held rows | 0 |
| Document | equal to the object on a second read |
| `admin/owner-reviews.json` | still 20069 bytes, ETag prefix `07d2d33117a4` |
| Prediction, published EPG, metadata cache | unchanged |

No source key, identity link or review text is in this record.

## Verdict

**Import holds.** Seven rows match the object. The marker stays `r2`, so Admin, programme, watchlist and the catalogue still read `admin/owner-reviews.json`. An Admin save while the marker stays `r2` advances `generation` and puts the object; it does not rewrite these rows. Activation then refuses until a new import proves the object again. This import does not authorize that second import or the activation.

**Not done by this import.** Revert remains separate. Activation later ran at 23:13 UTC under its own confirmation and set the marker to `d1` without a second import ([activation record](air-314-owner-review-activate-2026-11-03.md)). A code rollback does not drop the rows or return the marker. This file is the 23:06 UTC read-back: marker `r2`, generation 1.

**Limits.** One request, one read-back. No Worker route. No bookmark. The REST `{batch}` is not proof of Worker-binding atomicity; the read-back is the proof that this import landed.
