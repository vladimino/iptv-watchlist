# AIR-555: audit of `letterboxd/admissions/verified-films.json` and its D1 disposition

**Date:** 24 November 2026, 09:29 to 09:35 UTC (10:29 to 10:35 Madrid). **Source:** `main` `6ca5c24037db8ed61bb9dd46a78d7a784e6f68ed`. **Work:** [AIR-555](https://trello.com/c/JPgjoBzK), a mandatory outcome of [AIR-546](https://trello.com/c/1dRSJEbp) under [AIR-275](https://trello.com/c/4x7hH0gI). Related: [AIR-559](https://trello.com/c/733sRAxu), documentation closeout [AIR-547](https://trello.com/c/99faXisC). **Scope:** read-only (L0) production reads, offline analysis and one offline reproduction. Nothing was written to R2 or D1. **Revised** after the independent review of [PR #972](https://github.com/vladimino/iptv-watchlist/pull/972): the review added the first-admission pinning role, the payload and handover requirements of option B, and narrower evidence wording.

## Verdict

1. **The object is live mutable writer coordination, not an immutable receipt.**
   - Three production-reachable writers compare-and-swap it at Film/Person `d1`/`open`:
     - the inferred baseline import commit;
     - the Diary identity check (automatic). It is reached from the Ratings Diary phase and from the Watchlist admission step of the Letterboxd Sync (correction after review: the second caller was missing from the first version);
     - the rated-archive identity and enrichment steps (owner-only).
   - The inferred writer also deletes an entry it has just created.
   - Those writers also read it. No serving path reads it at `open`: the catalog reads D1 only.
2. **Observed parity with D1 at read time.** Bounded to the reads described below:
   - 714 R2 entries and 714 `film_rated_admission` rows agree on movie id, source code, archive digest, receipt key, verification time and year;
   - 0 R2-only, 0 D1-only and 0 mismatched;
   - 0 open `rated_admission_retention` write receipts;
   - 0 objects under `letterboxd/imports/`;
   - 0 entries in the Diary identity pending document.

   This is not proof that no unfinished import ever existed. Deleted receipts cannot be recovered.
3. **The inferred and verified distinction no longer depends on this object.**
   - All 703 inferred admissions are marked inferred on their D1 Ratings fact record: 702 by the record `identity` mark and 1 by an `inferredPairs` entry, written by the AIR-559 repair of 24 November.
   - D1 `film_rated_admission` has no identity column. Its archive digest is negative provenance only.
4. **The object carries a second role: it pins the first admission.**
   - Each writer passes the stored first entry to the D1 writer, never a new one. An existing movie entry is kept, and a code bound to another movie is refused before the Ratings link.
   - D1 alone does not give the same result. `admitRatedFilm` would overwrite `archive_sha256`, `title` and `year` for the same code and movie when given a different archive (G4). `planAdmission` refuses a second code for an admitted Film where the inferred writer today keeps the entry and still links.
5. **One latent defect was reproduced offline (G1).** A replay of the committed chunk offers the D1 admission writer an inferred entry that an interrupted withdrawal left behind. The chunk receipt marks that item as a conflict, and the replay ignores the mark. No instance was observed in production (2 above).
6. **Recommendation: option B, with conditions.**
   - Freeze the object as retained historical evidence and make D1 the only admission coordinator.
   - B is possible without a schema change only if F1 first preserves pinning and conflict semantics in D1 and persists each writer's exact proof payload. Those guarantees do not exist today.
   - After the first D1-only admission, the only recovery is roll-forward.
   - G3 (rated enrichment) stays open until F3 is decided.
   - This report decides nothing and authorizes no write.

## Method and evidence boundary

- **Credentials.** The bucket-scoped R2 **Object Read** pair (`R2_SNAPSHOT_*`, with the account id taken from `D1_BACKFILL_ACCOUNT_ID`) and the D1 API token (`D1_BACKFILL_API_TOKEN`), both from the session environment. Values were neither printed nor stored.
- **R2.** `scripts/r2-s3-store.mjs` with no write allowlist, so the client cannot build a PUT or DELETE. Calls: HEAD and GET of the object, one LIST of `letterboxd/`, a closing HEAD and a LIST of `letterboxd/imports/`. Total: 3 HEAD, 1 GET, 2 LIST, 0 PUT.
- **D1.** A local helper that refuses anything but one `SELECT` per request and rejects a response that reports `rows_written` or `changed_db`. Every response reported `rows_written: 0`, `changed_db: false`.
- **Observations.**
  - 09:29:34 and 09:29:38 UTC: schema **37**; Film/Person `d1`/`open` generation **2**; Ratings `d1`/`open` generation **4371**, both before and after. The object's ETag was identical at the first HEAD, at the GET and at the HEAD after the reads (177,072 bytes).
  - 09:33 UTC: the Ratings fact records were read with the Ratings generation at **4387** before and after that read. Natural Ratings runs advanced it between the two reads.
  - 09:34:43 UTC (closing read): the same ETag and size, 714 D1 admission rows, Film/Person generation 2, `letterboxd/imports/` empty.
- **What the reads prove: bounded observed parity, not a cross-store consistent snapshot.** R2 and D1 have no shared transaction.
  - The stable ETag shows that the R2 object did not change between 09:29 and 09:35.
  - The Film/Person generation is an authority epoch, not a per-row change counter, and a D1 row can be updated in place. The D1 rows were read once, at 09:29, and only their count was read again.
  - The Ratings records were read at a different Ratings generation (4387) from the link index (4371).
  - So the parity holds for what each read saw, not for one instant across stores.
  - The freeze gate of a future option B must repeat full row fingerprints and the predicates below under a fenced quiet handover (F2).
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

- **P1 kind:** an entry's `identity` (`inferred`, `diary_page`, or absent for the rated archive).
- **P2 verifies:** `verifiedAdmission(key, entry)` from `src/film-admission.js` is `ok`.
- **P3 agree:** a D1 row with the same `tmdb`, `source_code`, `archive_sha256` and `receipt_film_key`. **R2-only:** no D1 row for the movie id. **D1-only:** no entry for a row's movie id. **Mismatch:** a row for the movie id that differs in code, archive or key.
- **P4 link:** for `inferred` and `diary_page` (whose source code is the Letterboxd id), the facts link index maps `letterboxd:<code>` and `tmdb:<n>` to the same record.
- **P5 inferred mark:** that record carries `identity`, or an `inferredPairs` entry naming exactly this code and movie id.
- **P6 enrichment stage:** `metadataAt` present (metadata), `peopleNamesVersion` 2 (localized), `titleRu` present.
- **P7 identity health in D1:** the Film exists and is not redirected, and the movie id has exactly one `tmdb` row, the Film's own trusted non-conflicting row.

## Results

| Check | Result |
| --- | ---: |
| Entries (P1) | 714: `inferred` 703, `diary_page` 6, rated (no `identity`) 5 |
| P2 verifies | 714 of 714 |
| Archive digest by kind | `inferred`: 703 × `26fdeeff2460…` (the AIR-388 export); rated: 5 × `12ebcc2d2d2a…`; `diary_page`: 6 distinct evidence digests |
| P3 agree / R2-only / D1-only / mismatch | 714 / 0 / 0 / 0 (verification time and year also equal) |
| D1 rows by `request_id` family | 708 from the H1 load of 13 Nov (`p5-…`), 6 from the producer (`rated…`, 18 and 19 Nov) |
| `rated_admission_retention` receipts | `film_admission` applied 6, `film_retention` applied 1,197; open (pending, failed, unknown) **0** |
| P4 link | `inferred` 703 and `diary_page` 6 on the same record |
| P5 inferred mark | `inferred`: 702 record mark + 1 `inferredPairs` entry = **703**; `diary_page`: 0 (correct, these are verified) |
| P6 enrichment stage | 0 of 714 have metadata, localization or `titleRu` |
| `filmPath` | `null` on all 703 inferred; present on 5 rated and 6 Diary entries; **not stored in D1** |
| P7 | 714 Films exist, 0 redirected, 714 with only their own trusted `tmdb` row |
| `letterboxd_short_code` alias | 6 (the producer admissions); 0 on the 708 H1-loaded rows (the H1 load did not write aliases) |
| `letterboxd` claim on an admission Film | 0 of 714 (see the observation on the six Diary pairs below) |
| Retired movie ids among the entries | 0 of 4 retirement decisions |
| Duplicate source code or movie id across entries | 0 / 0 |
| `letterboxd/` listing | `admissions` 1, `diary` 2, `facts` 470 (frozen pre-cutover images), `ratings` 2, `display-exclusion.json` 1; `imports/` **0** |
| Diary identity pending document | 0 entries |

The earlier figures (714 admissions, 703 / 6 / 5, [AIR-559 audit](air-559-legacy-inferred-pair-audit-2026-11-23.md)) are history; the table above is the readback of 24 November.

## Call-path inventory

All modules below are concatenated into the Worker by `build.mjs` (`letterboxd-facts.js`, `letterboxd-diary-identity.js`, `letterboxd-rated-candidates.js`, `film-admission.js` as `CanonicalFilmAdmission`, `canonical-rated-admission-producer.js` as `CanonicalRatedAdmission`). The object is **not** in `ratingsMutableKey` (`src/ratings-d1.js:37`), so `casJSON` and `readRawJSON` in `letterboxd-facts.js` reach the bucket for it. `letterboxd-rated-candidates.js` reads and writes the bucket directly (`readDoc`, `casDoc`).

| # | Call site (main `6ca5c24`) | Operation | Reached from | Production status at `open` |
| --- | --- | --- | --- | --- |
| W1 | `letterboxd-facts.js:575` `admitInferredFilm` | CAS add `{…, filmPath:null, verifiedAt:now, identity:"inferred"}`. Returns `conflict` when the code names another movie and `present` when the key exists (the first entry is kept, whatever its code or archive) | `commitBaselineChunk` for an item with `admit`, after the link pre-check (`:720`) | Reachable, owner-only (`POST /api/letterboxd/baseline/commit`, `worker.js:2840`, and the browser apply confirm, `admin/letterboxd-archive-apply.js:441`). Idle: no import object exists |
| W2 | `letterboxd-facts.js:590` `withdrawInferredAdmission` | CAS **delete** of the entry this commit created when the link then conflicts (`:735`) | same | Reachable, owner-only |
| R1 | `letterboxd-facts.js:739-746` | GET, then `applyRatedAdmissionRetention` of the stored entry, only when it names this archive and code (`event inferred:<sha>:<lid>`) | first commit, after the link succeeds | Reachable, owner-only |
| R2 | `letterboxd-facts.js:600` `applyCanonicalInferredAdmissions` | GET, then offer again every request item with `admit` whose entry matches archive and code, in slices of 12 | **replay** of a committed chunk (`:702`) | Reachable, owner-only; see G1 |
| W3 | `letterboxd-facts.js:660` `admitDiaryFilm` | CAS add `{…, identity:"diary_page"}` with the evidence digest as `archiveSha256`. Returns `present` (same code; the first entry is kept), `other_code` or `conflict` | `LetterboxdDiaryIdentity.writeReceipt` (`letterboxd-diary-identity.js:91`) | **Automatic**, from two callers. (1) The Diary phase of the ordinary Ratings run (`letterboxd-ratings.js:374`). (2) The Watchlist admission step of the Letterboxd Sync (`admitNew`, `src/letterboxd-sync-watchlist.js:92`, wired to `LetterboxdDiaryIdentity.resolve` at `src/worker.js:2764`), at most 3 ids per step (ADR 0186 decision 5, generalizing ADR 0166 to Watchlist ids). At most 3 source checks per step. 6 entries, 18 and 19 Nov. The entry does not record which caller wrote it |
| R3 | `letterboxd-diary-identity.js:202-205` | `readAdmissionReceipts`, then `applyRatedAdmissionRetention` of the **stored** entry (`event diary:<lid>`) | same | Automatic |
| R4 | `letterboxd-rated-candidates.js:87` `ownedMovieIds` | GET; movie ids held by other codes are excluded from the identity search | rated identity step | Reachable, owner-only (`/api/admin/letterboxd-archive/identity-step`, `admin/letterboxd-archive-apply.js:494`); idle, no candidate document |
| W4 | `letterboxd-rated-candidates.js:125` `writeAdmission` | CAS add, no `identity` field. Refuses `historical_alias_conflict` and `duplicate_tmdb`; keeps the first entry and its `verifiedAt` | `commitVerified` (`:292`), then `applyRatedAdmissionRetention` of the stored entry (`rated:<sha>:<code>`) | Reachable, owner-only; idle |
| R5 | `letterboxd-rated-candidates.js:422` `enrichOne` | GET; `metadataAt` selects the metadata or the localization phase | enrichment continuation of the identity step | Reachable, owner-only; idle |
| W5 | `letterboxd-rated-candidates.js:356` `storeMetadata` | CAS update: synopsis, credits, genres, runtime, poster, url, `metadataAt`, `peopleVersion`; fenced by `sameAdmission` (code, movie, archive, path) | `enrichOne` | Reachable; output has **no serving reader at `open`** (G3) |
| W6 | `letterboxd-rated-candidates.js:377` `storeLocalization` | CAS update: `titleRu`, `titleStatus`, localized credits, `peopleNamesVersion`, `peopleLocalizedAt` | `enrichOne` | Same as W5 |
| R6 | `worker.js:608` `catalogArchiveFallbackR2` | GET of one key | `catalogArchiveFallback` (`:599`) | **Unreachable in production**: at `open` it returns `catalogCanonicalFilmFromD1`. `held` and an unreadable marker fail closed. Only the explicit local stand-in reaches R2 (ADR 0162) |
| R7 | `film-admission.js:209` `compareAdmissions` | pure compare of a passed body | no caller in `src/` | Dead helper (tests only) |
| — | `scripts/film-person-h1-*`, prepared loader | offline copy of the object as an input file | owner-run, historical (H1 load of 13 Nov) | Not a Worker path. Retaining the script is not approval to run it |

D1 transitions of the canonical form:
- `admitRatedFilm` (`film-admission.js:71`) inserts or confirms `film`, the trusted `tmdb` external id, the `letterboxd_short_code` alias and the `film_rated_admission` row in one fenced batch (marker generation, entity revision, receipt tail).
- For an existing row with the same movie id and code but another archive digest, it **updates** `archive_sha256`, `title` and `year` (`film-admission.js:90,104`). `planAdmission` treats that case as work, not as a no-op (`canonical-rated-admission-producer.js:98-103`).
- A row with another code for the same Film, or a code held by another Film, is `admission_conflict`.
- `mergeFilms` moves a retired Film's row to a survivor that has none, or refuses two different admissions (`canonical-mutations.js:227-240`).

Readers of the D1 row:
- `canonical-catalog-reader.js` (title and year fill);
- `admin/identity-work.js` and `domain/identity-work-inventory.js` (proof that a verified candidate was admitted, joined on archive and code);
- `canonical-film-external-ids-producer.js:96` (the admission's movie id cannot be dropped).

None of them reads R2.

## Field and transition ownership

| Field (R2 entry) | D1 equivalent | Written by | Changes after creation | Current authority / role | Target owner (option B) |
| --- | --- | --- | --- | --- | --- |
| key `tmdb_<n>`, `tmdb` | `receipt_film_key`, `tmdb` (unique) | W1, W3, W4 | R2: never, but W2 may delete the entry. D1: moved by a merge | D1 row is canonical; the R2 key is the writers' uniqueness and replay index | D1 only |
| `sourceCode` | `source_code` (unique) | W1, W3, W4 | never | D1 canonical. R2 enforces code-to-movie uniqueness a second time, with rules that differ per writer (table below) | D1, with the per-writer outcomes preserved (F1) |
| `archiveSha256` | `archive_sha256` | W1, W3 (evidence digest), W4 | R2: never (the first entry is kept). **D1: replaceable** by `admitRatedFilm` for the same code and movie | R2 pins the first value; D1 copies it only because the writers pass the stored entry | D1, with an explicit keep-first rule (G4, F1) |
| `title`, `year` | `title`, `year` | W1, W3, W4 | R2: never. D1: replaceable on the same path as the archive | first observation, pinned by R2 | as above |
| `verifiedAt` | `verified_at` | W1 (time of the R2 write), W3 (check time), W4 (first write kept) | R2: never. D1: not updated on conflict | part of the producer content digest. Its only durable copy before the D1 row exists is the R2 entry | a stable value that each writer persists **before its first effect** (F1; none persists it today) |
| `identity` | **none** | W1, W3 | never | inferred and verified provenance. For inferred items now also on the Ratings record (P5, 703 of 703) | Ratings domain (`identity` / `inferredPairs`), already authoritative for the claim planner (ADR 0184) |
| `filmPath` | **none** | W1 (`null`), W3, W4 | never | proof input for rated enrichment (`sameAdmission`, `enrichmentAgrees`). The rated candidate row carries the same path | rated candidate document (R2 archive work, ADR 0170), subject to F3 |
| enrichment: `synopsis`, `synopsisFetchedAt`, `metadataAt`, `directors`, `actors`, `genres`, `runtime`, `poster`, `peopleVersion`, `url` | none here (D1 `film_metadata` is written by the canonical producers) | W5 | yes, CAS | mutable progress and cache payload. Read only by `enrichOne` and the unreachable R6 | F3 decides: write through the canonical metadata path, or retire the phase |
| localization: `titleRu`, `titleStatus`, `peopleNamesVersion`, `peopleLocalizedAt` | none here | W6 | yes, CAS | same as above | same as above |
| whole-object CAS (ETag, 5 attempts) | fenced D1 batch | all writers | — | cross-writer serialization of one 177 KB JSON document | D1 fence (marker generation and Film revision) |

The process of admission (who may admit what, in which order, with which retry) is not the same thing as the canonical Film authority. Film authority is D1 at `open` and is not in question here. The question is whether the R2-side coordination step in front of the D1 writer can be removed without losing what it currently guarantees.

### Existing-entry outcomes per writer (today)

| Situation | W1 inferred commit | W3 Diary step | W4 rated step | D1 alone (`planAdmission` / `admitRatedFilm`) |
| --- | --- | --- | --- | --- |
| Code already bound to another movie | `conflict` before the link; no link, no fact | `conflict`: pending `admission_conflict`, no link | `historical_alias_conflict`: candidate `needs_review` | `admission_conflict` |
| Same movie, another code | `present`: entry kept, **no D1 call** (archive/code mismatch), link and facts proceed | `other_code`: pending, no link | `duplicate_tmdb`: `needs_review` | `admission_conflict` |
| Same movie and code, another archive or evidence | `present`: entry kept, no D1 call (archive mismatch), link and facts proceed | `present`: the **stored** entry goes to D1 (no-op) | the stored entry is kept and passed | **update** of archive, title, year (G4) |
| Same movie, code and archive | `present`: stored entry to D1, no-op | `present`: no-op | `ok`: no-op | no-op |

## Gap and recovery analysis

| Scenario | Current behaviour | Evidence |
| --- | --- | --- |
| Inferred: crash after W1, before the link | Chunk intent without a receipt. A re-commit finds the entry (`present`), links, then admits in D1 | code path `:715-747`; general resume tests in `tests/letterboxd-inferred.mjs` |
| Inferred: crash after the link, before the D1 admission | Re-commit: `present`, link already the same, D1 admission | same |
| Inferred: D1 admission refused (held, conflict) or incomplete | `assertRatedAdmissionAccepted` throws, so the chunk stops before its receipt while the entry and the **Ratings link stay**. Every re-commit stops again until the identity is resolved (fail closed). The R2 entry has no D1 row meanwhile | `canonical-rated-admission-producer.js:232-238` |
| Inferred: link conflicts after W1 | W2 deletes only the entry this commit created | `tests/letterboxd-inferred.mjs:313-326` |
| **G1** Inferred: crash or CAS failure between W1 and W2 | The re-commit stops at the link pre-check (`:720`) and never calls W2, so the entry stays (R2-only). The receipt records the item as a conflict. A **replay** of that committed chunk then offers the orphan to `applyRatedAdmissionRetention` (R2 path, `:600`), which ignores the receipt's conflict mark. At `open` that would admit `film:tmdb:<n>` with a trusted `tmdb` row and a short-code alias for a pair the import rejected | offline reproduction below; untested in the suite |
| **G2** Any writer: R2 entry written, D1 admission never completed | The entry stays and still blocks the other writers' R2 uniqueness checks (W1/W3 code conflict, W4 `duplicate_tmdb`, R4 excluded ids), although no Film was admitted. It is recovered only while its writer's own retry state exists: a chunk intent, a Diary pending entry (at most six attempts), or a rated candidate in `admitting` | P3 = 714/714 at read time; 0 open receipts |
| **G3** Rated enrichment at `open` | W5/W6 store metadata and localization on the R2 entry. No serving reader exists at `open` (R6 is unreachable; the catalog reads `film_metadata`), so the work does not reach the Film. 0 entries carry it at read time | R6 row above; P6 count 0 |
| **G4** First-admission pinning | Today the R2 entry keeps the first archive, title, year and `verifiedAt`, and every writer passes that stored entry to D1. Given a new receipt for the same code and movie with another archive, D1 would overwrite them. Not reachable through today's writers; it becomes reachable the moment a writer builds the receipt itself | `film-admission.js:90,104`; table above |
| Diary: crash after W3, before the D1 admission | The link intent (`reason: linking`, with the movie id only) is written first. The next ordinary step **re-checks the source**; W3 answers `present` and passes the stored entry to D1. Without the R2 entry the step would have no stored title, year, path, evidence digest or `verifiedAt` | `letterboxd-diary-identity.js:121-123`; `tests/letterboxd-diary-identity-d1.mjs:82` |
| Rated: D1 admission throws after W4 | The candidate stays `admitting` (it stores `intendedTmdb` and `filmPath` only). The next identity step finds `held`; W4 answers `ok` and passes the stored entry to D1 | `letterboxd-rated-candidates.js:316-326` |
| Concurrent writers | Each writer CASes the whole document with 5 attempts; contention ends as `write_contention` (a failed commit or step, retried by the writer's own state). Rules differ per writer (outcome table above) | code above; `tests/letterboxd-rated-candidates.mjs:546-566` |
| Lost response | Baseline: re-run the command (replay or resume; G1 caveat). Diary and rated: the writer's own state retries. W1/W3/W4 are idempotent because they return the stored entry | runbook; tests above |
| Stale epoch, generation moved, held, unavailable | The D1 batch asserts marker generation and Film revision. `film_person_*` errors propagate, and the writers stop or keep the item pending. Nothing falls back to R2 | `film-admission.js:71-114`; `canonical-rated-admission-producer.js:15` |
| Merge | The D1 row moves to the survivor while the R2 key stays. A replay resolves to the owner of the trusted `tmdb` row and is a no-op | `canonical-mutations.js:227-240` |
| Retirement | A retirement decision changes no external id, and `admitRatedFilm` does not consult the ledger. Re-admitting a retired movie id lands on the existing Film; the catalog reader hides it | `tmdb-retirement-decisions.js:8`; `canonical-catalog-reader.js:62` |
| Re-admission from the historical object | No bulk path re-admits from R2 at `open`: the projector was removed and H1 is an offline tool. The three per-item paths offer again only an entry that matches the item in hand: R1/R2 need the same archive and code in the request, R3 the same verified id, W4 `already`. G1 is the one case where that match is not enough | inventory above |
| R2 serving fallback | None at `open`: R6 is unreachable. `tests/admin-identity-work-api.mjs:211` asserts the inventory never reads the object | — |

### Offline reproduction of G1

The fixture uses invented ids, an in-memory bucket and `src/letterboxd-facts.js` loaded the way `tests/letterboxd-inferred.mjs` loads it, with a stub admission writer that records its calls. No network, R2 or D1 is involved. Save it anywhere outside the repository and run it from the repository root with `node <file>`. The expected output is `G1 reproduced: replay offered [["tmdb_333"]]`. Verified on `main` `6ca5c24`.

```js
import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';import fs from 'node:fs';import vm from 'node:vm';import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/');
const {installRawViewProjection}=await import(new URL('tests/letterboxd-view-double.mjs',root));
const ADM='letterboxd/admissions/verified-films.json';
const store=new Map(),tags=new Map();let rev=0,admissionPuts=0,failAfter=Infinity,links=0;const calls=[];
const bucket={async get(k){if(k==='letterboxd/facts/links.json'){links++;if(links===1)return null;return {etag:'l'+links,json:async()=>({'letterboxd:Rr1':'tmdb-999','tmdb:999':'tmdb-999'})};}return store.has(k)?{etag:tags.get(k),json:async()=>structuredClone(store.get(k))}:null;},
 async put(k,v,o={}){if(k===ADM&&++admissionPuts>failAfter)throw new Error('simulated crash before the withdrawal');const c=o.onlyIf||{};if(c.etagDoesNotMatch==='*'&&store.has(k)||c.etagMatches&&c.etagMatches!==tags.get(k))return null;store.set(k,JSON.parse(v));tags.set(k,String(++rev));return {etag:tags.get(k)};}};
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set,Response,Request,URL,
 CanonicalRatedAdmission:{UNIT_CAP:12,applyRatedAdmissionRetention:async(env,{admissions})=>{calls.push(admissions.map(a=>a.receiptKey));return {state:'complete',units:[]};},assertRatedAdmissionAccepted:x=>x}});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);installRawViewProjection(ctx);
const commit=async body=>(await F.handleBaselineRequest(new Request('https://x/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{BUCKET:bucket},'/api/letterboxd/baseline/commit')).json();
const body={origin:{archiveSha256:'3'.repeat(64),generatedAt:'2026-11-08T15:00:00.000Z',generatedAtSource:'archive_name'},chunk:0,items:[{lid:'Rr1',tmdb:'333',facts:{watched:true},effectiveOn:{},identity:'inferred',admit:{title:'Race Movie',year:2012}}]};
failAfter=1;await assert.rejects(commit(body),/simulated crash/);   // 1. the link races to a conflict; the withdrawal is interrupted
assert.ok(store.get(ADM).films.tmdb_333);failAfter=Infinity;
const second=await commit(body);                                    // 2. re-commit: pre-check conflict; the entry stays
assert.equal(second.replay,false);assert.equal(second.conflicts,1);assert.ok(store.get(ADM).films.tmdb_333);assert.equal(calls.length,0);
const third=await commit(body);                                     // 3. replay of the committed chunk
assert.equal(third.replay,true);assert.equal(third.entries[0].conflict,true);
assert.equal(JSON.stringify(calls),'[["tmdb_333"]]','the orphan is offered although the receipt marks a conflict');
console.log('G1 reproduced: replay offered',JSON.stringify(calls));
```

## Stale statements

Corrected in this change (statements about this object and its D1 form only):

- `docs/reference/integrations/letterboxd-user-facts.md`:
  - "the existing enrichment projector creates the Film from the entry eventually";
  - "nothing removes the entry";
  - "a repeated commit of a chunk with a receipt is a replay and writes nothing";
  - "A missing map admits nobody": the map is not a serving input at `open`.
- `docs/runbooks/letterboxd-baseline-import.md`: the commit's write list now names the admissions entry and the D1 admission of an `admit` item, and the replay behaviour. The unconditional "safe" replay is qualified by G1.
- `docs/reference/domain/film-person.md`: the admission side "inactive", "nothing writes these rows" and "the R2 object stays the immutable receipt"; the rated-archive reader description, which is pre-`open` only.
- `docs/reference/data/d1-schema.md` (schema 15 section):
  - "not applied in production";
  - "`src/film-admission.js` is not bundled and nothing calls it";
  - "the R2 object stays the immutable evidence and receipt";
  - "the projector stays the only canonical writer".
- `docs/architecture/film-person-lifecycle.md`: ADR 0090 "is Proposed" (it is Accepted), and the R2 object as admission entry point.

Left to others:

- **Source comments, for follow-up F1 (code, not docs-only):** `src/film-admission.js:1-10` ("immutable evidence and receipt", "compare-only (inactive)") and the commit-route comment at `src/letterboxd-facts.js:570-574` (projector upserts the Film).
- **Handed to [AIR-547](https://trello.com/c/99faXisC):** the dated status column of `migrations/README.md` row 15, and the other stale schema-section bullets of `docs/reference/data/d1-schema.md` outside the admission tables.

`docs/architecture/persistence-and-migration.md` mentions the object only in a paragraph already marked historical. `docs/runbooks/letterboxd-claim-backfill.md` and `docs/reference/integrations/letterboxd-ratings.md` describe the claim and Diary steps correctly. They need no change here.

## Decision options

| Option | What changes | Consequences |
| --- | --- | --- |
| **A. Retain as live R2 coordination** | Keep W1-W6. Fix G1 (a replay offers only items whose receipt entry is a non-conflict `admitted`/`present`). Decide F3. The owner accepts the object as an explicit mutable R2 exception | Least code; keeps first-admission pinning (G4) where it works today. Keeps a second, R2-side uniqueness and replay authority in front of the D1 writer, with per-writer rules and cross-store partial commits (G2). AIR-275 cannot honestly report "no mutable R2 authority" for admissions |
| **B. Freeze as historical evidence; D1 is the only admission coordinator (recommended, conditional)** | Writers stop writing the object and call `applyRatedAdmissionRetention` directly, under the F1 requirements below. The object is retained read-only at its last ETag. Any deletion is a later, separate owner decision | One admission authority. G1 and G2 disappear with the R2 step; G4 must be closed by F1 before the switch; G3 stays until F3. No data migration: parity is already observed (to be re-proven at the freeze gate), and the inferred mark is on the Ratings records (703/703). Likely no schema change, if the existing documents can carry the payloads (an F1 finding, not a given). Needs a new ADR that supersedes ADR 0087 decision 4 (the object as entry point), ADR 0105 decision 5 (the receipt written before the facts) and the receipt step of ADR 0166, and updates the ADR 0170 inventory row. **Recovery after the first D1-only admission is roll-forward only** (see the requirements below) |
| B′. B plus an additive `identity_kind` column on `film_rated_admission` | B, and a migration that stores `inferred` / `diary_page` / `rated_archive` on the D1 row, backfilled from the frozen object | Makes the distinction queryable on the admission row, for example to harden the ADR 0170 inventory join on archive and code. Costs a schema step and an L3 backfill. Today no reader needs it: the claim planner uses the Ratings marks |
| C. Migrate the whole object into a new normalized D1 table | New table for every R2 field (kind, path, evidence, enrichment), import, parity, cutover; R2 frozen | Highest fidelity and highest cost. Most columns have no consumer, and it risks a second admission record beside `film_rated_admission` |

### Requirements that option B must meet (F1 acceptance)

1. **Per-writer existing-row outcomes.** The outcome table above must hold with D1 as the only coordinator:
   - a code bound to another movie is refused **before** the Ratings link (W1) or before any link (W3, W4);
   - the inferred writer keeps today's "same movie, another code: no admission, link proceeds" behaviour, or the owner explicitly accepts a change;
   - D1 never replaces the first archive, title, year or `verifiedAt` of an admitted pair (close G4 with a keep-first rule in the writer or the plan, refused or no-op, decided in the ADR).
2. **Conflict between the pre-link check and the final D1 write.**
   - A D1 read before the link is not a cross-domain transaction. F1 must define the durable settlement when the D1 admission is refused after the Ratings link committed (today: the chunk stops before its receipt, fail closed, with the link in place).
   - It must also define how that state is recorded, retried and surfaced without a blind retry.
   - The ADR 0184 negative proof must stay: an inferred pair is never a claim proof, whatever admits it.
3. **Stable proof payload persisted before the first effect.** The D1 content digest covers title, year, archive or evidence digest and `verifiedAt`. Each writer must persist the exact payload before its first non-atomic effect and reuse it, without another source fetch or a fresh timestamp. This must hold for lost responses, proof changes, and expired or evicted pending work (the Diary document is bounded to 200 entries). None of the current records does this:
   - Inferred: the request body carries movie id, code and admitted title and year, and the archive is the origin. `verifiedAt` has no durable copy before the R2 entry; the create-only chunk intent's `openedAt` is a candidate.
   - Diary: `intend` stores reason, slug, movie id, attempts and times only, and is replaced on retry. It must also store title, year, path, evidence digest and `verifiedAt`.
   - Rated: the `admitting` candidate row stores `intendedTmdb` and `filmPath` only. It must also store title, year and `verifiedAt`.
4. **Historical replay.** The acceptance tests cover:
   - an old entry's `verifiedAt` versus the intent's `openedAt`;
   - a different archive;
   - another code;
   - an existing D1 row and its receipt digest;
   - old pending intents, `linking` entries or `admitting` candidates created by the old code at the freeze. The freeze gate requires none, or reconstructs them from the frozen object as a documented read-only reconciliation input.
5. **Freeze and writer handover fence.** The switch is not one instant:
   - Old Worker requests that are already running may still CAS the object after the deploy.
   - The natural Diary writer runs on its own schedule inside the Ratings run.
   - F1 defines the fence: for example, a quiet window with no Letterboxd Sync or archive step in flight, verified from run state, followed by an ETag pin. It also defines how a late old-code write is detected.
6. **Rollback boundary.**
   - Before the first D1-only admission, a code revert is an ordinary rollback: the object is still complete.
   - After it, a code revert is **prohibited as routine**. The frozen object lacks the new admission, so the old writers would again consult an incomplete uniqueness and replay index, including the old enrichment checkpoint.
   - Recovery is roll-forward. Restoring legacy R2 coordination needs its own owner-approved reconciliation plan (R2 rebuilt from D1 under a fence), never an implicit rebuild.
7. **Sequencing with F3.** F3 is a required disposition. If the rated enrichment phase is kept, its new target must exist before the R2 writes stop. Otherwise the phase is retired in the same change. B does not remove G3 by itself.

**Recommendation: B, subject to requirements 1-7.** It is the smallest option that leaves one admission authority. The only proven-independent function of the R2 object that remains is historical evidence, which needs no writer. Compatibility:

- **AIR-559 / ADR 0184.** The claim planner reads the Ratings marks; requirement 2 keeps the negative proof.
- **ADR 0170.** The candidate and registry documents stay R2 archive work; only the inventory row's wording changes.
- **ADR 0087, 0105, 0166.** The listed decisions are superseded, not silently rewritten.
- **ADR 0192.** No view-index dependency.

There is no dual authority at any point: D1 already makes the canonical decision, and B removes the R2 pre-step once D1 carries the guarantees that step provides today. If F1 shows that the payloads cannot live in the existing documents, the owner chooses between a schema change (B′ or a payload column) and option A.

## Follow-up scopes (proposed; cards only after the owner's disposition)

- **F1 (option B): ADR and implementation, offline.**
  - A new ADR, Proposed until the owner decides.
  - Writer changes to W1-W6 and R1-R4 under requirements 1-7.
  - Regression tests for G1, G4, the outcome table, the interruption matrix and the historical replay cases, on the R2 stand-in and the D1 harness.
  - The source comments (see Stale statements), maintained docs and diagrams.
  - A code PR with the full local suite. No production write.
- **F2 (option B): freeze gate and verification.**
  - Before the switch: under the F1 handover fence, an L0 readback with full row fingerprints of the R2 entries and the D1 rows (not counts alone), predicates P1-P7, 0 open admission receipts and 0 pending writer state.
  - After the deploy: the ETag is unchanged and the first natural Diary admission (or an owner-run archive step, if one happens) produces a D1 row and no R2 change.
  - This is the `Верификация` stage of F1, or a separate card if the owner prefers.
- **F3 (required under A and B): rated enrichment at `open` (G3).** Decide whether the rated metadata and localization phase writes through the canonical metadata path (`film_metadata` and localization sources) or is retired. Under B it is sequenced before or with F1 (requirement 7).
- **F-A (only under option A):** the G1 fix and its regression test, plus explicit acceptance of the mutable exception in the AIR-546 ledger.

Each prerequisite created for AIR-275 goes into its existing native Prerequisites checklist as a bare card URL.

## Observation outside this scope

The six Diary-verified pairs (bridged 18 and 19 Nov, before the claim producer was activated) have no `letterboxd` claim: 0 rows for those codes, against 415 claims in total. A later Diary step does not revisit an id that is already linked, and the backfill runbook's cohort is the published programme lids. This is passed to [AIR-559](https://trello.com/c/733sRAxu) as information. It is not an admission gap, and this card decides nothing about it.

## Decision boundary

Evidence and options only. No ADR status, writer, flag, Task, migration, import, repair or cleanup is decided or authorized here. The object, its 714 entries and the 714 D1 rows were left exactly as read.
