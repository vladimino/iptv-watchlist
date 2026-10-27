# Executor replay after ADR-0029 on the production snapshot (local SQLite)

**Captured:** 2026-10-27, 16:50–18:39 UTC, offline on the owner's machine. Code: branch `claude/air-194-superseded-redirect` at `7af4f18` (on `main` `a01ac96`); the ADR was renumbered from 0028 to 0029 in `22d9ee7` without any change to the code logic  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`. The directory stayed write-protected  
**Commands:**
- `node scripts/d1-backfill.mjs --target sqlite --acknowledged <private list>`, plain and `--staged-generation`, each three times on its own new database built from `0001`–`0003`;
- the same acknowledged list as [S1](air-74-s1-executor-dry-run-2026-10-27.md): 34 records, SHA-256 `2fe0618a…`.

**Scope:** private SQLite files only. No Cloudflare D1, no R2 request, no Worker, Scheduled Task, flag or Access change  
**Verdict:** **The `fingerprint_kept` blocker is resolved; G5 stays NO-GO.**
- The redirected fingerprint that stopped S1 is now recorded as `superseded_by_canonical` (class S) with both checksums.
- The run continues and applies 1,452 more units.
- It then stops honestly on the prediction family: `class_a_blocker` on `prediction_version_object_missing`, giving `prediction_family_unportable`.
- Both reruns apply nothing.

**Used by:** [AIR-194](https://trello.com/c/WfATFVSP), [ADR-0029](../../adr/0029-superseded-redirect-payloads.md), [AIR-74](https://trello.com/c/5AdAmKPe); follows [S1](air-74-s1-executor-dry-run-2026-10-27.md)

Aggregates only. The reports, ledgers and SQLite files stay private.

## Runs

| Run | Path | Wall time | Status | Applied | Resumed | Pending | Superseded (S) | Class C passed as acknowledged | Receipts (matching / stale / foreign) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | plain | 35 min 57 s | `stopped: class_a_blocker` | 21,520 | 0 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |
| 2 | plain | 11 min 44 s | same stop | **0** | 21,520 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |
| 3 | plain | 12 min 53 s | same stop | **0** | 21,520 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |
| 1 | staged | 43 min 9 s | same stop | 21,520 | 0 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |
| 2 | staged | 12 min 34 s | same stop | **0** | 21,520 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |
| 3 | staged | 11 min 18 s | same stop | **0** | 21,520 | 11,326 | 1 | 14 | 21,521 / 0 / 0 |

The staged runs started 41 minutes after plain, and the two then overlapped, so their wall times are not comparable with S1. Both paths gave identical counts:
- Staged gate: 0 commits, because the generation unit is still not reached.
- Identity: direct 5,803, redirect 2, `metadata_tmdb` 2, superseded 1. In S1 the redirect count was 3; the third redirected unit is the superseded fingerprint, now counted under `superseded`.
- Evidence keys: unchanged from S1.

## What changed against S1

- **Superseded record.** The single class S record is a `fingerprint_payload` record.
  - Its stored id is the retired side of a redirect (`via: "redirect"`).
  - Its `generatedAt` is earlier than that of the survivor's own fingerprint.
  - Both manifest checksums are in the ledger.
  - It wrote no row and no receipt, and the R2 object is untouched.
  - The independent projection lists it as `superseded` and expects only the survivor's fingerprint.
- **Fingerprint parity is clean.** It was 1,452 missing rows and 1 mismatched row in S1. Now `fingerprint_payload` has 0 missing and 0 mismatched; the 2,320 expected fingerprints read back equal.
- **Applied count.** It is 20,068 → 21,520, all of them the remaining fingerprints. Receipts went from 20,069 to 21,521, all matching.
- **Acknowledged class C records.** 14 of the 34 were reached and passed. The 14th is reached only because the run now gets past the fingerprints.

## Where it stops now and why

- **The stop.** The first prediction unit is a `prediction_current` record with no immutable version object. It is class A unportable, so the executor stops (`class_a_blocker`), and `classes.A.blockers` reads `prediction_family_unportable`, `import_stopped`.
- **Prediction family.** The mandatory family reports 2,335 keys, 0 applied, 1 unportable reached, `portable: false`. The offline importer on the same snapshot reports 2,321 unportable bundles.
- **The retired id's bundle.** It is **not** superseded. ADR-0029 refuses it with `canonical_unportable`, because neither bundle has version objects. It stays class A, as the decision requires, and no missing version object is passed off as portable.
- **Supersession counts on the whole snapshot,** from `supersededPayloads()` with the offline importer's inputs: fingerprint `superseded_by_canonical` 1, prediction `canonical_unportable` 1, and nothing else.

## What the run did not reach

- **Not yet reached.** The predictions, ratings, decisions and the generation unit are pending.
- **Parity.** It lists 60,629 rows as missing: `candidate_generation` 51,643, `candidate_decision` 8,983, `actual_rating` 2, `programme_generation` 1. The three generation-dependent tables `film_show`, `film_generation` and `published_generation` are mismatched. All of this is a consequence of the stop.
- **No prediction parity is claimed.** The staged generation path is still not exercised on real data.

## Next blocker

The only open class A item on this snapshot is the prediction family without version objects (S1 decision 2). It needs:
- the approved writer activation ([AIR-195](https://trello.com/c/8gzh6iES));
- materialization under ADR-0026;
- a new fenced snapshot, with a fresh acknowledged list checked against that snapshot.

Once materialized, the retired bundle will be decided by ADR-0029 on its own merits.

## Limits

- One snapshot, at its `finishedAt` (2026-10-26 22:19:31 UTC). SQLite, not D1.
- The executor stops at the first class A blocker. Blockers after it are known only from the offline importer.
