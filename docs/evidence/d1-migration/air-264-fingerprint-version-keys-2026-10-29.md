# Immutable fingerprint version keys in the offline importer (AIR-264)

**Captured:** 2026-10-29, 05:12–10:14 UTC, in the agent container; code at branch `claude/air-264-fingerprint-version-keys` commits `7e6d7f8` and, after review, `e44460f` (both from `main` `f1c9dbd`).  
**Input:** the private post-materialization production snapshot taken for [AIR-74](https://trello.com/c/5AdAmKPe) at 22:58–23:08 UTC on 28 October: `consistent_fenced`, 11,544 objects, 741,370,844 bytes, aggregate `7a0117e7b5a05749039167e28fc96d84af6104586e3bf55999652146d7f3af58`, `manifest.json` SHA-256 `8d1dbc0855d2ed8f64ee08c5ad62e68e6fb158179493cf82b8ebd986f3429612`. No new export.  
**Scope:** private files and local SQLite only. No R2 or D1 request, no flag, Task or migration change. The AIR-210 writer is unchanged.  
**Card:** [AIR-264](https://trello.com/c/P0elt7dL); follows blocker 1 of the [post-split replay](air-261-post-split-replay-2026-10-28.md).  
**Verdict:** **GO for the fingerprint version keys.** The 38 keys are mapped through the current `fingerprint.json`, 0 keys are unknown, parity is clean and reruns apply 0. **This is not a G5 GO**: class C 39 remains, and the executor replay is not part of this card.

Aggregates only. Reports, SQLite files and film ids stay private.

## 1. What the 38 keys are

With `FINGERPRINT_VERSION_OBJECTS=on` the Worker's `writeFingerprint` writes, create-only, a content body `enrichment/films/<id>/fingerprints/<hash>.json` (the content with `filmId` and `fingerprintHash`) and a generation record `enrichment/films/<id>/fingerprint-generations/<hash>-s<schema>-p<prompt>.json` (film, hash, schema and prompt versions, first `generatedAt`, `produced`, `fields`, `previous`), and then moves `fingerprint.json` ([ADR-0035](../../adr/0035-selective-fingerprint-transition-compatibility.md) section 2). A private read of the snapshot, independent of the importer:

| Check | Result |
| --- | --- |
| Films with version objects | 19, each with exactly 1 body and 1 generation record |
| Body hash | 19/19 equal the Worker's canonical content hash of the body without `fingerprintHash` |
| Body content | 19/19 equal the content of the current `fingerprint.json` |
| Generation records | 19/19 name the current record's hash, schema and prompt version; `produced: generated`, `previous: null` |
| Older generations, orphan bodies, records without a body | 0 |

They are therefore immutable copies of the current records, not a second source of history. ADR-0035 already states that `fingerprint_payload` (current pointer, `r2_key`, `content_sha256`) needs no change for this storage, so the disposition follows the prediction version precedent of [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) item 4 and changes no D1 contract.

## 2. Disposition implemented

- The body and generation record whose film and identity equal the current `fingerprint.json` are `mapped` through it (`via` `fingerprint_pointer`). They add no row; the `fingerprint_payload` row still comes from `fingerprint.json`.
- A valid object nothing current names (an older generation, or a body whose record write never followed) is `unreferenced` (`fingerprint_version_unreferenced`), listed in `classes.B.unreferencedVersions` and kept in R2, where `restoreFingerprint` reads it.
- Every defect stops the run before any write, with target `fingerprint_payload`: `fingerprint_version_unreadable`, `fingerprint_body_identity_mismatch`, `fingerprint_body_hash_mismatch`, `fingerprint_generation_invalid`, `fingerprint_generation_body_missing`, `fingerprint_current_body_mismatch`.
- The hash rule is the Worker's own `canonical` from `src/enrichment.js`, loaded by `loadDomainRules`; the importer keeps no copy. Version keys without the rule throw.

## 3. Synthetic regression (`tests/fingerprint-version-import.mjs`)

Fixtures are written by the Worker's own `writeFingerprint` on a create-only bucket fake. The test checks:
- the importer's hash equals the writer's;
- coverage classifies both patterns as mapped, and near-miss keys (63-character hash, missing suffix, nested path) and alias spellings (`-s01-p1`, `-s1-p01`, a needless `%5F`, a lower-case `%2f`, an undecodable escape, an unencoded space) as unknown, while a properly encoded film id stays mapped end to end;
- after a second write, the current pair is mapped and the replaced pair is unreferenced; the result is deterministic under key reordering;
- a body without its record is unreferenced;
- a restore of identical content reuses the body and the record (the pointer's `generatedAt`, `produced` and `previous` differ from the record's) and stays mapped;
- nine defects block: tampered content, another film, unreadable body, a record with the wrong schema version, an unknown field, an invalid `produced`, an invalid `previous`, a record without a body, and a current record that disagrees with its body;
- the rule is required;
- `projectSource` accounts every key and carries the blockers.

## 4. Real-snapshot replay (`offline-import.mjs`, no test-only change)

| Run | Window (UTC) | Result |
| --- | --- | --- |
| Before, `main` `f1c9dbd` | 28 Oct, earlier | **stopped `unknown_key`**, 38 keys, before any write |
| 1 | 05:14:27–06:23:50 | exit 0; 33,811 units applied |
| 2, rerun | 06:23:50–06:45:40 | exit 0; **applied 0**, resumed 33,811 |
| 3, rerun | 06:45:40–07:09:46 | exit 0; **applied 0**, resumed 33,811; output byte-identical to run 2 |

After review, `e44460f` accepts only the Worker's own key spelling (no leading zeros in the versions; the film segment exactly `encodeURIComponent` of its id). The replay was repeated on a fresh SQLite database:

| Run at `e44460f` | Window (UTC) | Result |
| --- | --- | --- |
| 1 | 07:20:17–08:52:56 | exit 0; 33,811 units applied; output byte-identical to run 1 at `7e6d7f8` |
| 2, rerun | 09:20:24–09:45:54 | exit 0; **applied 0**, resumed 33,811 |
| 3, rerun | 09:45:54–10:13:13 | exit 0; **applied 0**, resumed 33,811; output byte-identical to run 2 and to the reruns at `7e6d7f8` |

A first attempt at rerun 2 (08:52:56–09:20) was stopped by the agent's background time limit during the read-back, before any write (the database was unchanged since 08:33); it was started again.

Every run, at both commits:
- **Coverage:** 11,544 = 7,558 mapped + 3,986 R2-only; 0 excluded, **0 unmapped**.
- **`fingerprintVersions`:** bodies 19, generations 19, **mapped 38**, unreferenced 0, blocked 0. All 38 parity records are `mapped` via `fingerprint_pointer`.
- **Parity:** ok; denominator 87,506; 0 missing, 0 extra, 0 mismatched, 0 unprojected.
- **Class A:** no blockers. Receipts: 33,811 matching, 0 stale, 0 foreign. Conflicts, unportable, partial and pending are all 0.
- **Identity:** 8,615 direct, 2 via metadata TMDB id. Discovery evidence: 99 stored, 63,041 derived, 122 `stale_evidence`.
- **Class C:** 39 `film_unresolved` (unchanged, outside this card). Class S 0. `claimsFullParity` false because of class C.

## 5. Limits

- The snapshot has no older generation, so `unreferenced` is proven synthetically only.
- The executor (`d1-backfill.mjs`) was not replayed; it stops on the unacknowledged class C list and is AIR-74 work.
- History of non-current fingerprint generations is not imported into D1. A read or write cutover that needs `restoreFingerprint` from D1 needs its own decision.
- No production R2 or D1 action. The SQLite files and reports are private.
