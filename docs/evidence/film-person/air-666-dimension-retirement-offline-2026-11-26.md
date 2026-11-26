# AIR-666: guarded retirement of legacy `film_dimension` copies, offline evidence

Captured 26 November 2026, offline: synthetic SQLite fixtures built from every migration and a read of the source. **No production read or write, no Cloudflare access, no retirement run.** The code is dormant; this report proves the offline contract only and says nothing about live rows.

## Claim and proof

| Claim | Proof |
| --- | --- |
| Only a `stale_copy` with proof `complete` in `fingerprint`, `prediction` or unlocked `metadata` can be proposed | `tests/film-dimension-retirement.mjs` section 1: reviewed and owner-authority rows (the ADR 0214 lock), an unreadable provenance, a `titleSource`, an unknown status and authority, a Film with no identity claim and a missing coverage supplier are retained and counted by reason; `identity` and `localization` rows are `dimension_not_retirable` |
| The SQL rule and the JS rule agree | section 11 compares `SAFE_DELETE_SQL` with `protectedReasons` over 900 rows (five dimensions, six statuses, five authorities, six provenance shapes). **It found a real defect during delivery:** `PROTECTED_ROW_SQL` is `NULL`, not `0`, for a row with no authority whose other terms are false, so `NOT PROTECTED_ROW_SQL` never matched a plain copy; the delete uses `COALESCE(PROTECTED_ROW_SQL,0)=0`. The importer, which uses the predicate positively, is unaffected |
| The GO names the exact allowlist | section 3: another digest, a longer allowlist, a non-`https` reference, a missing GO and a missing checkpoint are refused before anything is read for writing; the digest does not depend on list order |
| The pre-image is durable before the delete | section 3 records the order `record` at revision 0 with five rows, `settle` at revision 1 with two; section 6: a refused `record` leaves every row, revision and receipt unchanged |
| Unlisted rows are never deleted, a moved row is skipped | section 4: only the listed dimension goes; a changed row digest, a row that became a lock or owner row, and a proof that disappeared are reported `moved` and kept |
| Concurrency rolls the Film back whole | section 5: a revision bump and a status change inside the window each refuse the batch with all three rows kept; the receipt is `failed`, never applied |
| A lost reply is recovered, never replanned | section 8: `unknown` with the intent, `recoverDimensionRetirement` finds `applied`; a never-run intent is `not_applied` and resumes under the same request id |
| Restore only into an empty slot at the exact post-delete revision | section 9: exact restore (bytes equal the pre-image, revision +1), a second restore refused, a newer Film retained with no receipt, an occupied slot left and the others restored, and a slot refilled inside the window refuses the batch whole |
| A restore token is bound | section 10: fabricated, reordered, incomplete or foreign tokens are `film_person_invalid`; an intent with no applied receipt is `retire_restore_unbound`; a held marker refuses |
| Dormant | section 12: no file of `src` or `scripts` imports the module and neither the build nor `package.json` names it; `tests/film-dimension-parity.mjs` pins that its only importer is the retirement |

## Consumer inventory (source read, not live proof)

At this commit the Worker's SQL selects only `identity` (`src/catalog-d1.js`) and `localization` rows of `film_dimension` (`src/catalog-d1.js`, `src/canonical-catalog-reader.js`, `src/film-aggregate.js`); the fingerprint and prediction dimensions of the admin health view are derived from the view index and the profile. No `src` module other than the dormant importer, parity reader, reconciler and the canonical writers names the three retirable dimensions. The holdpoint of the operation ([AIR-648](https://trello.com/c/zh0cfDWK) reader switch and no remaining D1 consumer) is proved from live evidence before any GO, not by this read.

## Cost (fixture measurement, not a threshold)

25 Films with plain copies of the three dimensions: a dry run of all 25, 30 D1 queries and at least 551 rows read, no write; applying 1 Film, 40 queries in 2 batches and 17 changed rows (CAS and receipt rows included); applying 10 Films, 139 queries in 20 batches.

## Not proven

Behaviour on production D1 (limits, latency, row counts), the live cohort, the coverage supplier that proves a fingerprint or prediction absent, the checkpoint storage and any consumer outside the repository. Each belongs to the separate operation and its owner GO.
