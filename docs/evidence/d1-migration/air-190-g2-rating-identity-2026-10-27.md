# Owner rating identity through the metadata TMDB id (G2): offline import on the production snapshot

**Captured:** 2026-10-27, 12:20–13:24 UTC, offline on the owner's machine; code on branch `claude/air-190-g2-tmdb-identity` (base `main` `edd7f49`)  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`; the directory stayed write-protected  
**Command:** `node scripts/offline-import.mjs --snapshot <private snapshot> --database <private SQLite>`, run twice on one new database (from `0001`–`0003`)  
**Scope:** private SQLite only; no Cloudflare D1 (scratch or production), no R2 request, Worker, Scheduled Task, flag or Access change. No acknowledged list was built or used  
**Verdict:** **the two G2 owner ratings resolve, and nothing else moves.** Class C goes from 36 to 34 (G1 4, G3 30); the rerun applies nothing  
**Used by:** [AIR-190](https://trello.com/c/jLOxHfLp), [ADR-0027](../../adr/0027-owner-rating-tmdb-identity.md), [AIR-74](https://trello.com/c/5AdAmKPe); compared with the [schema v3 offline import](air-177-candidate-show-identity-2026-10-27.md) of the same snapshot

Aggregates only; source keys, film ids, TMDB ids and ratings stay in the private reports.

## Before and after

| Measure | AIR-177 run (before) | This run (after) |
| --- | --- | --- |
| Units applied (first run) | 30,504 | **30,506** |
| Rerun: applied / resumed | 0 / 30,504 | **0 / 30,506** |
| Receipts matching / stale / foreign | 30,504 / 0 / 0 | 30,506 / 0 / 0 |
| Identity: direct / redirect / `metadata_tmdb` | 5,803 / 3 / — | 5,803 / 3 / **2** |
| Rows: \`film\` / \`actual_rating\` | 2,320 / 0 | 2,320 / **2** |
| Class C | 36 | **34** |
| Class C `actual_rating` | 7 | **5** |
| Class C `fingerprint_payload` / `prediction_current` / `candidate_decision` | 14 / 14 / 1 | 14 / 14 / 1 (unchanged) |
| Unportable (prediction version objects, AIR-179) | 2,321 | 2,321 (unchanged) |
| Conflicts | 0 | 0 |
| Class A blockers | `prediction_family_unportable` | same |
| Class B (R2-only families and counts) | — | identical |
| Parity missing / extra / mismatched | 0 / 0 / 1 (`fingerprint_payload`) | identical (the same mismatch) |
| `claimsFullParity` | false | false |

## Checks on the two resolved records

- They are exactly the two records of group G2 in the private AIR-180 packet; no other record left class C.
- Each is a `mapped` parity record with identity `via: metadata_tmdb`, the TMDB id and the `metadata.json` checksum in its provenance.
- Each rating is stored once, on two different existing Films, and neither Film had a rating before.
- No Film was created: the Film count and every Film row are unchanged (no parity difference on `film`).

## Limits

- One snapshot at its `finishedAt` (2026-10-26 22:19:31 UTC). A later snapshot can resolve more or fewer ratings by the same rule. Each one is reported with its provenance.
- The TMDB link rests on the stored `metadata.json` TMDB id; no network call re-checked it.
- The remaining 34 class C records (G1 retirement, G3 acknowledgement) and the acknowledged list are separate owner decisions.
