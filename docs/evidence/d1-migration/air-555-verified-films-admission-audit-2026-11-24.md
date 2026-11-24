# AIR-555: audit of `letterboxd/admissions/verified-films.json` and its D1 disposition

**Date:** 24 November 2026, 09:29 to 09:35 UTC (10:29 to 10:35 Madrid). **Source:** `main` `6ca5c24037db8ed61bb9dd46a78d7a784e6f68ed`. **Work:** [AIR-555](https://trello.com/c/JPgjoBzK), a mandatory outcome of [AIR-546](https://trello.com/c/1dRSJEbp) under [AIR-275](https://trello.com/c/4x7hH0gI). Related: [AIR-559](https://trello.com/c/733sRAxu), documentation closeout [AIR-547](https://trello.com/c/99faXisC). **Scope:** read-only (L0) production reads, offline analysis and one offline reproduction. Nothing was written to R2 or D1.

## Verdict

1. **The object is live mutable writer coordination, not an immutable receipt.** Three production-reachable writers compare-and-swap it at Film/Person `d1`/`open`: the inferred baseline import commit, the Diary identity step (automatic, inside the ordinary Ratings Diary phase) and the rated-archive identity and enrichment steps (owner-only). The inferred writer also deletes an entry it has just created. No serving path reads it at `open`: the catalog reads D1 only.
2. **D1 `film_rated_admission` already holds every admission.** Current state: 714 R2 entries and 714 D1 rows, 714 agree on movie id, source code, archive digest, receipt key, verification time and year. There are 0 R2-only, 0 D1-only and 0 mismatched rows, 0 open `rated_admission_retention` write receipts, 0 objects under `letterboxd/imports/` (so no unfinished chunk intent, rated-candidate document or registry) and 0 entries in the Diary identity pending document.
3. **The inferred and verified distinction no longer depends on this object.** All 703 inferred admissions are marked inferred on their D1 Ratings fact record: 702 by the record `identity` mark and 1 by an `inferredPairs` entry, written by the AIR-559 repair of 24 November. D1 `film_rated_admission` has no identity column. Its archive digest is negative provenance only.
4. **One latent defect was reproduced offline (G1).** An inferred entry that is left behind when a withdrawal is interrupted is offered to the canonical admission writer by a later replay of the committed chunk, although the chunk receipt marks that item as a conflict. Production has no instance today (2 above).
5. **Recommendation: option B.** Freeze the object as retained historical evidence and make D1 the only admission coordinator, with no schema change. This needs a new ADR and its own implementation card after the owner's disposition. This report decides nothing and authorizes no write.

## Method and snapshot boundary

- **Credentials.** The bucket-scoped R2 **Object Read** pair (`R2_SNAPSHOT_*`, with the account id taken from `D1_BACKFILL_ACCOUNT_ID`) and the D1 API token (`D1_BACKFILL_API_TOKEN`), both from the session environment. Values were neither printed nor stored.
- **R2.** `scripts/r2-s3-store.mjs` with no write allowlist, so the client cannot build a PUT or DELETE. Calls: HEAD and GET of the object, one LIST of `letterboxd/`, a closing HEAD and a LIST of `letterboxd/imports/`. Total: 3 HEAD, 1 GET, 2 LIST, 0 PUT.
- **D1.** A local helper that refuses anything but one `SELECT` per request and rejects a response that reports `rows_written` or `changed_db`. Every response reported `rows_written: 0`, `changed_db: false`.
- **Pins.**
  - 09:29:34 and 09:29:38 UTC: schema **37**; Film/Person `d1`/`open` generation **2**; Ratings `d1`/`open` generation **4371**, both before and after. The object's ETag was identical at the first HEAD, at the GET and at the HEAD after the reads (177,072 bytes).
  - 09:33 UTC: the Ratings fact records were read with the Ratings generation at **4387** before and after that read. Natural Ratings runs advanced it between the two reads.
  - 09:34:43 UTC (closing pin): the same ETag and size, 714 D1 admission rows, Film/Person generation 2, `letterboxd/imports/` empty.
- **Consistent snapshot.** R2 and D1 have no shared transaction. The comparison is consistent because the object's ETag and the D1 row count did not change between 09:29 and 09:35, and because the Ratings generation was pinned around each Ratings read. The snapshot proves nothing about later writes.
- **Privacy.** Letterboxd ids, short codes, movie ids and per-entry payloads stay in the session's private scratch space, outside this report, GitHub and Trello. Archive digests appear only as the 12-character prefixes already published in earlier evidence.

### D1 statements

Literals are bound as parameters. No identifier appears here.

1. `SELECT version FROM schema_contract WHERE id=1`, then `SELECT mode,cutover,generation FROM film_person_authority WHERE id=1` and the same from `ratings_domain_authority`, before and after.
2. `SELECT a.film_id,a.tmdb,a.source_code,a.archive_sha256,a.title IS NOT NULL,a.year,a.receipt_key,a.receipt_film_key,a.verified_at,a.request_id,a.updated_at` from `film_rated_admission a`, with correlated counts of: `film` (exists), `film_redirect` (from), `film_external_id` (`tmdb` rows for the movie id, and the Film's own trusted non-conflicting row), `film_alias` (`letterboxd_short_code` equal to the source code), and `film_external_id` (`letterboxd` rows on the Film, and those equal to the source code).
3. `SELECT operation,state,error_class,COUNT(*) FROM canonical_write_receipt WHERE origin='rated_admission_retention' GROUP BY 1,2,3`, and the count of rows in `pending`, `failed` or `unknown`.
4. `SELECT movie_id,kind FROM tmdb_retirement_decision`.
5. `SELECT part,body,etag FROM ratings_document WHERE key=? ORDER BY part` for `letterboxd/facts/links.json` and `letterboxd/facts/scans/diary-identity.json`. Then `SELECT key,part,body FROM ratings_document WHERE key LIKE 'letterboxd/facts/films/%' ORDER BY key,part`.
6. `SELECT COUNT(*),SUM(trusted) FROM film_external_id WHERE scheme='letterboxd' AND value IN (…)` for the six Diary-verified codes, and `SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd'`.

### Predicates (evaluated offline on the documents read)

- **R1 kind:** an entry's `identity` (`inferred`, `diary_page`, or absent for the rated archive).
- **R2 verifies:** `verifiedAdmission(key, entry)` from `src/film-admission.js` is `ok`.
- **R3 agree:** a D1 row with the same `tmdb`, the same `source_code`, `archive_sha256` and `receipt_film_key`. **R2-only:** no D1 row for the movie id. **D1-only:** no entry for a row's movie id. **Mismatch:** a row for the movie id that differs in code, archive or key.
- **R4 link:** for `inferred` and `diary_page` (whose source code is the Letterboxd id), the facts link index maps `letterboxd:<code>` and `tmdb:<n>` to the same record.
- **R5 inferred mark:** that record carries `identity`, or an `inferredPairs` entry naming exactly this code and movie id.
- **R6 enrichment stage:** `metadataAt` present (metadata), `peopleNamesVersion` 2 (localized), `titleRu` present.
- **R7 identity health in D1:** the Film exists and is not redirected; the movie id has exactly one `tmdb` row, the Film's own trusted non-conflicting row.

## Results

| Check | Result |
| --- | ---: |
| Entries (R1) | 714: `inferred` 703, `diary_page` 6, rated (no `identity`) 5 |
| R2 verifies | 714 of 714 |
| Archive digest by kind | `inferred`: 703 × `26fdeeff2460…` (the AIR-388 export); rated: 5 × `12ebcc2d2d2a…`; `diary_page`: 6 distinct evidence digests |
| R3 agree / R2-only / D1-only / mismatch | 714 / 0 / 0 / 0 (verification time and year also equal) |
| D1 rows by `request_id` family | 708 from the H1 load of 13 Nov (`p5-…`), 6 from the producer (`rated…`, 18 and 19 Nov) |
| `rated_admission_retention` receipts | `film_admission` applied 6, `film_retention` applied 1,197; open (pending, failed, unknown) **0** |
| R4 link | `inferred` 703 and `diary_page` 6 on the same record |
| R5 inferred mark | `inferred`: 702 record mark + 1 `inferredPairs` entry = **703**; `diary_page`: 0 (correct, these are verified) |
| R6 enrichment stage | 0 of 714 have metadata, localization or `titleRu` |
| `filmPath` | `null` on all 703 inferred; present on 5 rated and 6 Diary entries; **not stored in D1** |
| R7 | 714 Films exist, 0 redirected, 714 with only their own trusted `tmdb` row |
| `letterboxd_short_code` alias | 6 (the producer admissions); 0 on the 708 H1-loaded rows (the H1 load did not write aliases) |
| `letterboxd` claim on an admission Film | 0 of 714 (see the observation on the six Diary pairs below) |
| Retired movie ids among the entries | 0 of 4 retirement decisions |
| Duplicate source code or movie id across entries | 0 / 0 |
| `letterboxd/` listing | `admissions` 1, `diary` 2, `facts` 470 (frozen pre-cutover images), `ratings` 2, `display-exclusion.json` 1; `imports/` **0** |
| Diary identity pending document | 0 entries |

The earlier figures (714 admissions, 703 / 6 / 5, [AIR-559 audit](air-559-legacy-inferred-pair-audit-2026-11-23.md)) are history; the table above is the current readback.

## Call-path inventory

All modules below are concatenated into the Worker by `build.mjs` (`letterboxd-facts.js`, `letterboxd-diary-identity.js`, `letterboxd-rated-candidates.js`, `film-admission.js` as `CanonicalFilmAdmission`, `canonical-rated-admission-producer.js` as `CanonicalRatedAdmission`). The object is **not** in `ratingsMutableKey` (`src/ratings-d1.js:37`), so `casJSON` and `readRawJSON` in `letterboxd-facts.js` reach the bucket for it. `letterboxd-rated-candidates.js` reads and writes the bucket directly (`readDoc`, `casDoc`).

| # | Call site (main `6ca5c24`) | Operation | Reached from | Production status at `open` |
| --- | --- | --- | --- | --- |
| W1 | `letterboxd-facts.js:575` `admitInferredFilm` | CAS add `{…, filmPath:null, verifiedAt:now, identity:"inferred"}`; `conflict` when the code names another movie, `present` when the key exists | `commitBaselineChunk` for an item with `admit`, after the link pre-check (`:721`) | Reachable, owner-only (`POST /api/letterboxd/baseline/commit`, `worker.js:2840`, and the browser apply confirm, `admin/letterboxd-archive-apply.js:441`). Idle: no import object exists |
| W2 | `letterboxd-facts.js:590` `withdrawInferredAdmission` | CAS **delete** of the entry this commit created when the link then conflicts (`:735`) | same | Reachable, owner-only |
| R1 | `letterboxd-facts.js:739-746` | GET, then `applyRatedAdmissionRetention` of the matching entry (`event inferred:<sha>:<lid>`) | first commit, after the link succeeds | Reachable, owner-only |
| R2 | `letterboxd-facts.js:600` `applyCanonicalInferredAdmissions` | GET, then re-offer every request item with `admit` whose entry matches archive and code, in slices of 12 | **replay** of a committed chunk (`:702`) | Reachable, owner-only; see G1 |
| W3 | `letterboxd-facts.js:660` `admitDiaryFilm` | CAS add `{…, identity:"diary_page"}` with the evidence digest as `archiveSha256` | `LetterboxdDiaryIdentity.writeReceipt` (`letterboxd-diary-identity.js:91`) | **Automatic**: Diary phase of the ordinary Ratings run (`letterboxd-ratings.js:374`), at most 3 source checks per step. 6 entries, 18 and 19 Nov |
| R3 | `letterboxd-diary-identity.js:202-205` | `readAdmissionReceipts` then `applyRatedAdmissionRetention` (`event diary:<lid>`) | same | Automatic |
| R4 | `letterboxd-rated-candidates.js:87` `ownedMovieIds` | GET; movie ids held by other codes are excluded for the identity search | rated identity step | Reachable, owner-only (`/api/admin/letterboxd-archive/identity-step`, `admin/letterboxd-archive-apply.js:494`); idle, no candidate document |
| W4 | `letterboxd-rated-candidates.js:125` `writeAdmission` | CAS add, no `identity` field; refuses `historical_alias_conflict` and `duplicate_tmdb`; keeps the first `verifiedAt` | `commitVerified` (`:292`), then `applyRatedAdmissionRetention` (`rated:<sha>:<code>`) | Reachable, owner-only; idle |
| R5 | `letterboxd-rated-candidates.js:422` `enrichOne` | GET; `metadataAt` selects the metadata or the localization phase | enrichment continuation of the identity step | Reachable, owner-only; idle |
| W5 | `letterboxd-rated-candidates.js:356` `storeMetadata` | CAS update: synopsis, credits, genres, runtime, poster, url, `metadataAt`, `peopleVersion`; fenced by `sameAdmission` (code, movie, archive, path) | `enrichOne` | Reachable; output has **no reader at `open`** (G3) |
| W6 | `letterboxd-rated-candidates.js:377` `storeLocalization` | CAS update: `titleRu`, `titleStatus`, localized credits, `peopleNamesVersion`, `peopleLocalizedAt` | `enrichOne` | Same as W5 |
| R6 | `worker.js:608` `catalogArchiveFallbackR2` | GET of one key | `catalogArchiveFallback` (`:599`) | **Unreachable in production**: at `open` it returns `catalogCanonicalFilmFromD1`; `held` and an unreadable marker fail closed; only the explicit local stand-in reaches R2 (ADR 0162) |
| R7 | `film-admission.js:209` `compareAdmissions` | pure compare of a passed body | no caller in `src/` | Dead helper (tests only) |
| — | `scripts/film-person-h1-*`, prepared loader | offline copy of the object as an input file | owner-run, historical (H1 load of 13 Nov) | Not a Worker path; retaining the script is not approval to run it |

D1 transitions of the canonical form: `admitRatedFilm` (`film-admission.js:71`) inserts or confirms `film`, the trusted `tmdb` external id, the `letterboxd_short_code` alias and the `film_rated_admission` row in one fenced batch (marker generation, entity revision, receipt tail). `mergeFilms` moves a retired Film's row to a survivor that has none, or refuses two different admissions (`canonical-mutations.js:227-240`). Readers: `canonical-catalog-reader.js` (title and year fill), `admin/identity-work.js` and `domain/identity-work-inventory.js` (proof that a verified candidate was admitted, joined on archive and code), `canonical-film-external-ids-producer.js:96` (the admission's movie id cannot be dropped). None reads R2.

## Field and transition ownership

| Field (R2 entry) | D1 equivalent | Written by | Changes after creation | Current authority / role | Target owner (option B) |
| --- | --- | --- | --- | --- | --- |
| key `tmdb_<n>`, `tmdb` | `receipt_film_key`, `tmdb` (unique) | W1, W3, W4 | never; the entry may be deleted by W2 | D1 row is canonical; R2 key is the writers' uniqueness and replay index | D1 only |
| `sourceCode` | `source_code` (unique) | W1, W3, W4 | never | D1 canonical; R2 enforces code-to-movie uniqueness again, with rules that differ per writer | D1 only (`planAdmission` holder/prior checks and the unique index already refuse) |
| `archiveSha256` | `archive_sha256` | W1, W3 (evidence digest), W4 | never | same value in both; immutable source proof | D1; R2 frozen copy as history |
| `title`, `year` | `title`, `year` (fill only) | W1, W3, W4 | never | immutable observation | D1 |
| `verifiedAt` | `verified_at` | W1 (time of the R2 write), W3 (check time), W4 (first write kept) | never | part of the producer content digest, so a stable value matters for replay | each writer's own durable record (chunk intent, Diary pending intent, candidate row) |
| `identity` | **none** | W1, W3 | never | inferred and verified provenance; for inferred items now also on the Ratings record (R5, 703 of 703) | Ratings domain (`identity` / `inferredPairs`), already authoritative for the claim planner (ADR 0184) |
| `filmPath` | **none** | W1 (`null`), W3, W4 | never | proof input for rated enrichment (`sameAdmission`, `enrichmentAgrees`); the rated candidate row carries the same path | rated candidate document (R2 archive work, ADR 0170) |
| enrichment: `synopsis`, `synopsisFetchedAt`, `metadataAt`, `directors`, `actors`, `genres`, `runtime`, `poster`, `peopleVersion`, `url` | none here (D1 `film_metadata` is written by the canonical producers) | W5 | yes, CAS | mutable progress and cache payload; read only by `enrichOne` and the unreachable R6 | decision in follow-up F3: write through the canonical metadata path, or retire the phase |
| localization: `titleRu`, `titleStatus`, `peopleNamesVersion`, `peopleLocalizedAt` | none here | W6 | yes, CAS | same as above | same as above |
| whole-object CAS (ETag, 5 attempts) | fenced D1 batch | all writers | — | cross-writer serialization of one 177 KB JSON document | D1 fence (marker generation and Film revision) |

The process of admission (who may admit what, in which order, with which retry) is not the same thing as the canonical Film authority. Film authority is D1 at `open` and is not in question here. The question is only whether a second, R2-side coordination step must stay in front of the D1 writer.

## Gap and recovery analysis

| Scenario | Current behaviour | Evidence |
| --- | --- | --- |
| Inferred: crash after W1, before the link | Chunk intent without a receipt. A re-commit finds the entry (`present`), links, then admits in D1 | code path `:715-747`; general resume tests in `tests/letterboxd-inferred.mjs` |
| Inferred: crash after the link, before the D1 admission | Re-commit: `present`, link already the same, D1 admission | same |
| Inferred: D1 admission refused (held, conflict) or incomplete | `assertRatedAdmissionAccepted` throws, the chunk stops before its receipt, and the entry and the link stay. Every re-commit stops again until the identity is resolved (fail closed). The R2 entry has no D1 row meanwhile | `canonical-rated-admission-producer.js:232-238` |
| Inferred: link conflicts after W1 | W2 deletes only the entry this commit created | `tests/letterboxd-inferred.mjs:313-326` |
| **G1** Inferred: crash or CAS failure between W1 and W2 | The re-commit stops at the link pre-check (`:720`) and never calls W2, so the entry stays (R2-only). The receipt records the item as a conflict. A **replay** of that committed chunk then offers the orphan to `applyRatedAdmissionRetention` (R2, `:600`), which ignores the receipt's conflict mark. At `open` that would admit `film:tmdb:<n>` with a trusted `tmdb` row and a short-code alias for a pair the import rejected | offline reproduction below; untested in the suite |
| **G2** Any writer: R2 entry written, D1 admission never completed | The entry stays and still blocks the other writers' R2 uniqueness checks (W1/W3 code conflict, W4 `duplicate_tmdb`, R4 excluded ids), although no Film was admitted. It is recovered only while its writer's own retry state exists (chunk intent, Diary pending entry for at most six attempts, rated candidate in `admitting`) | R3 = 714/714 today; 0 open receipts |
| Diary: crash after W3, before the D1 admission | The link intent (`reason: linking`) is written first. The next ordinary step re-checks the source, W3 answers `present`, and the D1 admission follows | `tests/letterboxd-diary-identity-d1.mjs:82`; `tests/letterboxd-diary-identity.mjs` |
| Rated: D1 admission throws after W4 | The candidate stays `admitting`. The next identity step finds `held`, W4 answers `ok` (same entry), and the D1 admission follows | `letterboxd-rated-candidates.js:316-326` |
| **G3** Rated enrichment at `open` | W5/W6 store metadata and localization on the R2 entry. No production reader exists at `open` (R6 is unreachable; the catalog reads `film_metadata`), so the work does not reach the Film. 0 entries carry it today | R6 row above; R6 count 0 |
| Concurrent writers | Each writer CASes the whole document with 5 attempts; contention ends as `write_contention` (a failed commit or step, retried by the writer's own state). Uniqueness rules differ: W1/W3 refuse a code bound to another movie and keep an existing key; W4 also refuses a second code for the same movie | code above; `tests/letterboxd-rated-candidates.mjs:546-566` |
| Lost response | Baseline: re-run the command (replay or resume). Diary and rated: the writer's own state retries; W1/W3/W4 are idempotent on the same content | runbook; tests above |
| Stale epoch, generation moved, held, unavailable | The D1 batch asserts marker generation and Film revision. `film_person_*` errors propagate, and the writers stop or keep the item pending. Nothing falls back to R2 | `film-admission.js:71-114`; `canonical-rated-admission-producer.js:15` |
| Merge | The D1 row moves to the survivor; the R2 key stays. A replay resolves to the owner of the trusted `tmdb` row and is a no-op | `canonical-mutations.js:227-240` |
| Retirement | A retirement decision changes no external id, and `admitRatedFilm` does not consult the ledger. Re-admitting a retired movie id lands on the existing Film; the catalog reader hides it | `tmdb-retirement-decisions.js:8`; `canonical-catalog-reader.js:62` |
| Re-admission from the historical object | No bulk path re-admits from R2 at `open` (the projector was removed, and H1 is an offline tool). The three per-item paths re-offer only an entry that matches the item in hand: R1/R2 need the same archive and code in the request, R3 the same verified id, W4 `already`. G1 is the one case where that match is not enough | inventory above |
| R2 serving fallback | None at `open`: R6 is unreachable. `tests/admin-identity-work-api.mjs:211` asserts the inventory never reads the object | — |

### Offline reproduction of G1

Invented ids, an in-memory bucket, `src/letterboxd-facts.js` loaded the way `tests/letterboxd-inferred.mjs` loads it, and a stub `CanonicalRatedAdmission` that records its calls:

1. The links read returns no conflict at the pre-check and a conflicting index afterwards (the race of the existing test at `:313`). The second admissions PUT (the withdrawal) throws. Result: the commit throws, and the entry remains.
2. Re-commit of the same chunk: HTTP 200, `conflicts: 1`, `replay: false`. The entry is still present, and the admission writer was called 0 times.
3. Replay of the same chunk: HTTP 200, `replay: true`, and the receipt marks the item `conflict: true`. The admission writer was called **once**, with `tmdb_<n>` of the orphan.

The script stays in the session's scratch space. Turning it into a regression test belongs to the follow-up that fixes or removes the path.

## Stale statements

Corrected in this change (statements about this object and its D1 form only):

- `docs/reference/integrations/letterboxd-user-facts.md`: "the existing enrichment projector creates the Film from the entry eventually" and "nothing removes the entry"; "a repeated commit of a chunk with a receipt is a replay and writes nothing"; "A missing map admits nobody" (no serving reader at `open`).
- `docs/runbooks/letterboxd-baseline-import.md`: the commit's write list now names the admissions entry and the D1 admission of an `admit` item, and the replay behaviour.
- `docs/reference/domain/film-person.md`: the admission side "inactive", "nothing writes these rows" and "the R2 object stays the immutable receipt"; the rated-archive reader description, which is pre-`open` only.
- `docs/reference/data/d1-schema.md` (schema 15 section): "not applied in production", "`src/film-admission.js` is not bundled and nothing calls it", "the R2 object stays the immutable evidence and receipt", "the projector stays the only canonical writer".
- `docs/architecture/film-person-lifecycle.md`: ADR 0090 "is Proposed" (it is Accepted), and the R2 object as admission entry point.

Left to others:

- **Source comments, for follow-up F1 (code, not docs-only):** `src/film-admission.js:1-10` ("immutable evidence and receipt", "compare-only (inactive)") and the commit-route comment at `src/letterboxd-facts.js:570-574` (projector upserts the Film).
- **Handed to [AIR-547](https://trello.com/c/99faXisC):** the dated status column of `migrations/README.md` row 15, and the other stale schema-section bullets of `docs/reference/data/d1-schema.md` outside the admission tables.

`docs/architecture/persistence-and-migration.md` mentions the object only in a paragraph already marked historical. `docs/runbooks/letterboxd-claim-backfill.md` and `docs/reference/integrations/letterboxd-ratings.md` describe the claim and Diary steps correctly. They need no change here.

## Decision options

| Option | What changes | Consequences |
| --- | --- | --- |
| **A. Retain as live R2 coordination** | Keep W1-W6. Fix G1 (a replay offers only items whose receipt entry is a non-conflict `admitted`/`present`). Owner accepts the object as an explicit mutable R2 exception | Least code. It keeps a second, R2-side uniqueness and replay authority in front of the D1 writer, with per-writer rules, cross-store partial commits (G2) and a dead-end enrichment output (G3). AIR-275 cannot honestly report "no mutable R2 authority" for admissions |
| **B. Freeze as historical evidence; D1 is the only admission coordinator (recommended)** | Writers stop writing the object. Each builds the receipt-shaped input in memory from its own durable record and calls `applyRatedAdmissionRetention` directly. Uniqueness comes from D1 (`planAdmission` holder/prior checks, unique indexes on `tmdb` and `source_code`). The inferred commit admits only after the link succeeds, so nothing needs withdrawing and G1 disappears. A replay offers only the receipt's non-conflict items. `verifiedAt` comes from the writer's own durable record (chunk intent `openedAt`, Diary pending intent, candidate row), so the producer digest is stable across retries. Rated enrichment per F3. The object is retained read-only at its pinned ETag; any deletion is a later, separate owner decision | No schema change, no data migration: 714/714 already agree and the inferred mark is on the Ratings records (703/703). Removes G1-G3 by construction. Needs a new ADR that supersedes ADR 0087 decision 4 (the object as entry point), ADR 0105 decision 5 (the receipt written before the facts) and the receipt step of ADR 0166, and updates the ADR 0170 inventory row ("no writer"). Rollback is a code revert: the writers resume on a still-consistent object |
| B′. B plus an additive `identity_kind` column on `film_rated_admission` | B, and a migration that stores `inferred` / `diary_page` / `rated_archive` on the D1 row, backfilled from the frozen object | Makes the distinction queryable on the admission row, for example to harden the ADR 0170 inventory join on archive and code. It costs a schema step and an L3 backfill. Today no reader needs it: the claim planner uses the Ratings marks |
| C. Migrate the whole object into a new normalized D1 table | New table for every R2 field (kind, path, evidence, enrichment), import, parity, cutover; R2 frozen | Highest fidelity and highest cost. Most columns have no consumer, and it risks a second admission record beside `film_rated_admission` |

**Recommendation: B.** It is the smallest option that leaves one admission authority. The only R2 function that is proven independent is historical evidence, which needs no writer. Compatibility:

- **AIR-559 / ADR 0184.** The claim planner reads the Ratings marks; nothing changes.
- **ADR 0170.** The candidate and registry documents stay R2 archive work; only the inventory row's wording changes.
- **ADR 0087, 0105, 0166.** The listed decisions are superseded, not silently rewritten.
- **ADR 0192.** No view-index dependency.

Parity gate before the switch: repeat predicates R1-R7 on the deploy SHA, with the ETag pinned. The freeze point is that deploy. After it, a natural Diary admission must leave the ETag unchanged and add a matching D1 row. There is no dual authority at any point: D1 already decides, and B removes the R2 pre-step.

## Follow-up scopes (proposed; cards only after the owner's disposition)

- **F1 (option B): ADR and implementation, offline.**
  - A new ADR, Proposed until the owner decides.
  - Writer changes W1-W6 and R1-R4 as described in option B.
  - Regression tests for G1 and the interruption matrix above, on the R2 stand-in and the D1 harness.
  - Source comments (see Stale statements), maintained docs and diagrams.
  - Code PR with the full local suite. No production write.
- **F2 (option B): production freeze verification.** After F1 merges and deploys, L0 only: the ETag is unchanged and the counts are equal at deploy; then the first natural Diary admission (or an owner-run archive step, if one happens) produces a D1 row and no R2 change. This is the `Верификация` stage of F1, or a separate card if the owner prefers.
- **F3: rated enrichment at `open` (G3).** Decide whether the rated metadata and localization phase writes through the canonical metadata path (`film_metadata` and localization sources) or is retired. Under option A this is needed regardless.
- **F-A (only under option A):** the G1 fix and its regression test, plus explicit acceptance of the mutable exception in the AIR-546 ledger.

Each prerequisite created for AIR-275 goes into its existing native Prerequisites checklist as a bare card URL.

## Observation outside this scope

The six Diary-verified pairs (bridged 18 and 19 Nov, before the claim producer was activated) have no `letterboxd` claim (0 rows for those codes; 415 claims in total). A later Diary step does not revisit an id that is already linked, and the backfill runbook's cohort is the published programme lids. This is passed to [AIR-559](https://trello.com/c/733sRAxu) as information. It is not an admission gap and this card decides nothing about it.

## Decision boundary

Evidence and options only. No ADR status, writer, flag, Task, migration, import, repair or cleanup is decided or authorized here. The object, its 714 entries and the 714 D1 rows were left exactly as read.
