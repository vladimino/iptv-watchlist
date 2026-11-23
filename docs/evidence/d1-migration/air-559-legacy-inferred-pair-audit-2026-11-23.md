# AIR-559: read-only audit of legacy inferred Letterboxd pairs

Date: **23 November 2026, 22:40 to 22:52 UTC** (the D1 admission rows were re-read at 23:20 UTC for the review). Scope: read-only.

The audit looks for Letterboxd-to-TMDB pairs in the production ratings facts that an `inferred` export import linked without a durable inferred mark. The canonical claim planner cannot tell such pairs from verified ones ([PR #958](https://github.com/vladimino/iptv-watchlist/pull/958), merged as `b6c3dea7e8979a7d7f6fb975e8fbfc35a388f0b8`; the known limit is in the [claim backfill runbook](../../runbooks/letterboxd-claim-backfill.md)). The owner requested the audit on [AIR-559](https://trello.com/c/733sRAxu) as an input to any decision on producer activation or a further backfill.

**Verdict.** Under the historical writer invariant set out below, the current fact records contain **one** detectable legacy unmarked inferred pair. This is a reconstruction of the current state, not a replay of the deleted import receipts. **No** trusted `letterboxd` claim was found on that pair or on any record that carries an inferred mark; that includes the nine claims of the 21 November backfill. These are the claims detected in the current tables, not a proof about every claim that ever existed. **Nothing was written.**

## Why the planned method changed

The handoff planned to read the chunk receipts of the AIR-388 import, archive `26fdeeff2460…` ([import evidence](../letterboxd/air-388-full-import-2026-11-10.md)), whose entries list `identity: "inferred"` per film. Those receipts no longer exist: on 19 November 2026 the owner-authorized AIR-528 cleanup deleted all 90 objects under that archive's `chunks/` prefix, together with the receipts of archive `ab7fbe7e…` ([AIR-528 evidence](../letterboxd/air-528-r2-cleanup-2026-11-19.md)). A fresh LIST of `letterboxd/imports/` returned 0 objects.

The audit therefore reconstructs the cohort from the traces that remain, each with its own limits:

1. **The fact records (D1 `ratings_document`).**
   - **Writer invariant** (`recordObservations` and `commitBaselineChunk`, unchanged from ADR 0104 until PR #958): an inferred item wrote the record-level `identity` mark on every record that was new or had no Letterboxd id. It wrote nothing on a record that already held facts and its lid.
   - **Consequence:** an unmarked inferred pair can only sit on a record that held facts and its lid but no TMDB id before the import. In practice that is a Diary-first record with key `lb-<lid>`, because a `tmdb-<n>` record is created with its TMDB id.
   - **Assumption:** the audit relies on that invariant and does not re-prove it record by record.
2. **`letterboxd/admissions/verified-films.json` (R2, a mutable object).**
   - Each Film the inferred import admitted got an entry with `identity: "inferred"`, its source code (the lid) and its movie id.
   - The object is not immutable. Other writers add entries or update fields (the Diary and rated-archive admissions, enrichment), and `withdrawInferredAdmission` deletes an inferred entry that the same commit had just created when its link then conflicted.
   - What remains are the **retained, settled** admissions: those whose link did not conflict. The object is a current-state witness, not a historical log.
3. **D1 `film_rated_admission`.**
   - This is the canonical form of the same admissions, with `source_code`, `tmdb` and `archive_sha256` but no identity column.
   - The baseline import only admits inferred items: `validateBaselineRequest` refuses `admit` on any other item. So a row whose archive is that import's archive identifies an inferred admission.
   - The archive value is negative provenance, not a positive identity proof.
   - Rows can be moved or deleted by fenced canonical Film merges (`canonical-mutations.js`).
4. **Canonical claims (D1 `film_external_id`).** Rows of scheme `letterboxd`, with their provenance.

## Method

- **Credentials.** The bucket-scoped R2 **Object Read** pair (`R2_SNAPSHOT_*`) and the D1 API token (`D1_BACKFILL_*`), both from the session environment. No value was printed or stored.
- **R2.** One LIST of `letterboxd/` (476 objects, none under `letterboxd/imports/`) and one GET of the admissions object. Both went through `scripts/r2-s3-store.mjs` with no write allowlist, so the client cannot write.
- **D1.** `SELECT` statements only, through a local helper that refuses any other statement. The statements are listed below; every literal is bound as a parameter, and no identifier appears here.
  1. `SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1` (before and after the reads), and the same from `film_person_authority`.
  2. `SELECT DISTINCT key FROM ratings_document WHERE key LIKE 'letterboxd/facts/films/%'`. Then, per key and for `letterboxd/facts/links.json`, `SELECT part,body,etag FROM ratings_document WHERE key=? ORDER BY part`, with the parts joined and parsed as JSON.
  3. `SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='letterboxd'`, and per examined pair `… WHERE (scheme='letterboxd' AND value=?) OR (scheme='tmdb' AND value=?)`.
  4. `SELECT film_id,kind,value FROM film_alias WHERE kind='letterboxd_short_code' AND value=?`.
  5. `SELECT programme_run_id FROM published_epg_authority WHERE id=1`, then `SELECT COUNT(*) FROM published_epg_member WHERE programme_run_id=? AND film_id=?`.
  6. `SELECT substr(archive_sha256,1,12), COUNT(*) FROM film_rated_admission GROUP BY 1`, and for the examined pair `… WHERE source_code=? OR tmdb=?`.
- **Predicates**, evaluated offline on the read documents:
  - **P1 (agreeing pair):** the record states both `links.letterboxd` and `links.tmdb`; the index maps `letterboxd:<lid>` and `tmdb:<n>` to the record's key; and the record is neither a redirect nor mid-migration.
  - **P2 (marked):** the record carries `identity`.
  - **P3 (export-touched):** some current fact (`watched`, `rating`, `watchlist`) or `ratingHistory` observation has `source = letterboxd_export` with this archive's digest as `sourceRef`.
  - **P4 (inferred admission):** an admissions entry `tmdb_<n>` has `identity = inferred` and `sourceCode = <lid>`.
  - **P5 (Diary-verified):** the same entry has `identity = diary_page` and `sourceCode = <lid>`.
  - **Legacy pair:** P1, not P2, and P4. Every `lb-<lid>` record that satisfies P1 was classified by P4 or P5, whether or not it satisfies P3.
- **Consistent snapshot.** The ratings authority was `d1`/`open` at generation **4345** before and after the document reads; Film/Person was `d1`/`open` at generation 2.
- **Privacy.** The lid-to-movie lists stay in the session's private scratch space, outside this report, GitHub and Trello.

## Results

| Check | Count |
| --- | ---: |
| Fact records | 2,267 (`tmdb-<n>` keys 2,240, `lb-<lid>` keys 27) |
| P2: records with an inferred `identity` mark | 1,784 |
| P1: records with an agreeing pair | 2,230 (every record that states both ids) |
| P3: records touched by `26fdeeff…` | 1,909 |
| P1 and P3 and not P2 | 125 (124 on `tmdb-<n>` keys, 1 on an `lb-<lid>` key) |
| `lb-<lid>` records with P1 | 7 |
| — P5 (Diary page and TMDB check of the same pair) | 6 |
| — **P4 and not P2: legacy unmarked inferred pair** | **1** |
| Admissions entries | 714: P4-type (`inferred`) 703, `diary_page` 6, no identity field 5 |
| — `inferred` entries whose lid's current record states the same movie (P1) | 703 |
| — of those, P2 | 702 |
| — **of those, not P2** (the same pair as above) | **1** |
| D1 `film_rated_admission` rows by archive | 703 with archive `26fdeeff…`, 5 with `12ebcc2d…` (rated archive), 6 with distinct Diary evidence digests |
| — the legacy pair's row | archive `26fdeeff…`, the same lid and movie |
| `letterboxd` claims in `film_external_id` | 415, all trusted and non-conflicting (406 with no provenance, 9 `ratings_alias_bridge` from the 21 November backfill) |
| Detected claims on a P2 record | **0** |
| Detected claims on the legacy pair | **0** |

The legacy pair has no `letterboxd` claim and no `letterboxd_short_code` alias, and it is not a member of the published programme run. Its Film exists with one trusted `tmdb` claim, so the current planner would answer `pass` for it if a flow offered it.

## Interpretation and limits

- **"One" is the detectable current cohort, not a historical replay.** The receipts that would have listed every inferred item are gone. The count rests on the writer invariant above and on the current admissions entries and fact records.
- **The 124 unmarked export-touched pairs on `tmdb-<n>` keys.** Under the invariant these are not inferred links. On such a record the import either found the pair already stated, and then changes no link, or it added a lid as a verified item. A missing lid added by an inferred item would have been marked.
- **An import can link a pair without leaving an observation.** When every export fact is older than the stored one, no export observation is kept. That is why every `lb-<lid>` pair was classified by its admissions evidence, not only the export-touched one.
- **Not detectable.** The case is a pair linked by an inferred item **without** an admission (the Film already existed) on a Diary-first record, with no export observation left. It leaves no P4 trace. All seven `lb-<lid>` pairs are explained by P4 or P5, so no such pair is detected among the current records. That is an absence of evidence under the invariant, not a proof.
- **Claims.** Zero claims were detected on inferred pairs in the current `film_external_id` rows, including the nine backfill claims. This says nothing about claims that may have existed and been removed earlier.
- **Snapshot.** This is a snapshot at ratings generation 4345 and proves nothing about later writes. Imports since PR #958 mark every inferred pair (`inferredPairs`).

## Decision boundary

The disposition of the one pair is a separate owner decision. This report records evidence only and does not choose a repair. It authorizes no write, activation, backfill, flag, Task or migration.
