# D1 executor dry-runs on the production snapshot with the acknowledged class C list (local SQLite)

**Captured:** 2026-10-27, 14:02–14:49 UTC, offline on the owner's machine; code at `main` `f3c635e` (after AIR-190, [PR #148](https://github.com/vladimino/iptv-watchlist/pull/148))  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, `manifest.json` SHA-256 `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a` re-checked first; the directory stayed write-protected  
**Commands:** `node scripts/d1-backfill.mjs --target sqlite --acknowledged <private list>`, plain and `--staged-generation`, each three times on its own new database from `0001`–`0003`  
**Scope:** private SQLite files only; no Cloudflare D1 (scratch or production), no R2 request, Worker, Scheduled Task, flag or Access change  
**Verdict:** **NO-GO for G5, unchanged.** The executor applies 20,068 units, passes every acknowledged class C record it reaches, and both reruns apply nothing; it then stops by contract (`class_a_blocker`) at a fingerprint of a retired Film id that a redirect sends to a Film with its own newer fingerprint. The prediction family and the generation unit are not reached, so neither the staged path nor prediction parity was exercised  
**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe) S1, [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) items 4 and 8, [ADR-0021](../../adr/0021-staged-atomic-generation-import.md); follows the [AIR-190 offline import](air-190-g2-rating-identity-2026-10-27.md)

Aggregates only. The acknowledged list, reports, ledgers and SQLite files stay private.

## Acknowledged list

Built from the class C ledger of the AIR-190 offline import of the same snapshot. Before use it was checked against the private AIR-180 packet:
- It has exactly **34** records: G1 4, G3 30. The two G2 ratings are not in it; AIR-190 resolved them.
- Each entry matches the packet on source key, target table, target id, reason (`film_unresolved`) and source checksum. Each checksum equals the snapshot manifest.
- The set equals the packet's G1 ∪ G3 set exactly. Nothing is a wildcard or a count-only entry.
- The list's SHA-256 is `2fe0618aa5c56dc838e8e0579f43e699a57fe8754eaf9110da42a4652ce7abac`.

## Runs

| Run | Path | Wall time | Status | Applied | Resumed | Pending | Class C passed as acknowledged | Receipts (matching / stale / foreign) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | plain | 28 min 51 s | `stopped: class_a_blocker` | 20,068 | 0 | 12,780 | 13 | 20,069 / 0 / 0 |
| 2 | plain | 9 min 6 s | same stop | **0** | 20,068 | 12,780 | 13 | 20,069 / 0 / 0 |
| 3 | plain | 9 min 21 s | same stop | **0** | 20,068 | 12,780 | 13 | 20,069 / 0 / 0 |
| 1–3 | staged | same as plain | same stop, same counts | 20,068 / 0 / 0 | — | 12,780 | 13 | 20,069 / 0 / 0 |

Both paths ran in parallel and gave identical counts. The staged gate reports 0 commits (`go: true` only means no commit was over budget; nothing was staged). Identity: direct 5,803, redirect 3, `metadata_tmdb` 2. Evidence keys: stored 65, derived 60,482, `stale_evidence` 79. There were no conflicts, no uncheckpointed units and no unportable unit before the stop. The schema version is 3 and the identity receipt is the AIR-175 aggregate.

## Where it stops and why

The 20,069th unit is a `fingerprint_payload` unit. Its stored film id is the retired side of one of the three redirects. The Film it resolves to already holds its own fingerprint (a different hash, newer `generatedAt`, the same schema). The repository keeps that newer fingerprint and reports the unit `explained: fingerprint_kept`. This is class A: the acknowledged list cannot name it (ADR-0019 item 8 allows class C only), so the executor stops before the next unit. The same retired id also has a prediction bundle, which would meet the same Film later in the run.

This is the single `fingerprint_payload` parity mismatch that every offline import of this snapshot has reported. It is not new, and it is not caused by the acknowledged list.

## What the run did not reach

- **Predictions (2,335 keys).** The family is ordered after fingerprints. The report's `classes.A.mandatory.prediction` shows `applied: 0, unportable: 0, portable: true` only because no prediction unit ran. The offline importer on the same snapshot reports 2,321 of them unportable (`prediction_version_object_missing`). Production version objects do not exist; the AIR-179 materializer has not been run. **No prediction parity is claimed.**
- **Ratings, decisions, the generation unit.** All of them are pending. Parity therefore lists 62,081 rows as missing (`candidate_generation` 51,643, `candidate_decision` 8,983, `fingerprint_payload` 1,452, `actual_rating` 2, `programme_generation` 1, …). Mismatches are reported for `fingerprint_payload` and for the three generation-dependent tables `film_show`, `film_generation` and `published_generation`. These are consequences of the stop, not import defects. The staged generation commit at the real scale has only been proven on the scratch D1 with synthetic data ([AIR-178](air-178-scratch-g4-real-scale-2026-10-27.md)).
- **21 of the 34 acknowledged records.** The other 13 (fingerprints) were reached and passed; the remaining prediction, rating and decision records come after the stop.

## Decisions needed before the next executor run

| # | Blocker | Options seen | Blocks |
| --- | --- | --- | --- |
| 1 | A retired id's older fingerprint (and its prediction bundle) collides through a redirect with the survivor's own payload; class A `fingerprint_kept` | Treat the survivor's payload as authoritative and carry the retired record as a reviewed known gap (needs an ADR and an executor change, because class A cannot be acknowledged today); or import it as the survivor's history; or stop the backfill on it as a source-quality refusal | every unit after the 20,068th, so the predictions, ratings, decisions and the generation unit |
| 2 | 2,321 prediction bundles without version objects | Approved production materialization (AIR-179 / ADR-0026: flags, `apply`, then a new fenced snapshot) | the mandatory prediction family; on AIR-175 itself it stays unportable whatever is decided |

Because of item 2, a run on AIR-175 can never pass the prediction family. A complete executor run needs a new fenced snapshot taken after an approved materialization, plus a fresh acknowledged list checked against that snapshot.

## Limits

- One snapshot, at its `finishedAt` (2026-10-26 22:19:31 UTC).
- SQLite, not D1: no network timing, batch-size or atomicity limit of D1 is measured here.
- The executor stops at the first class A blocker. Blockers after it are known only from the offline importer, which does not stop.
