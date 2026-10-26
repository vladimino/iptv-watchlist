# Letterboxd export reconciliation against the production snapshot

**Captured:** 2026-10-26, offline on the owner's machine; `scripts/letterboxd-reconcile.mjs` at `main` `80712e7`, re-run with the namesake fix of this PR (identical results except `lidHypothesis`)  
**Inputs:** the owner's Letterboxd account export of 2026-10-26 13:48 UTC (`watched.csv`, `ratings.csv`, `watchlist.csv`, `diary.csv` only); the [AIR-175 production R2 snapshot](../d1-migration/air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, re-verified offline before the run (`--verify`: 7,994 objects, 581,345,885 bytes, aggregate `f71eee10…`, `manifest.json` SHA-256 `c26e0453…`, `finishedAt` 2026-10-26T22:19:31.757Z)  
**Scope:** offline only; no network, no R2 or D1 access, no Worker route, no import or write of any rating, watched mark or watchlist entry  
**Verdict:** export codes **are** the stored Letterboxd ids for this snapshot (`supported`: 420 of 420 stored ids equal an export code, 0 disagreements); 420 films accepted, the other 2,040 need an identity source the snapshot does not hold  
**Used by:** [AIR-169](https://trello.com/c/pFtiCeYW); input for [AIR-170](https://trello.com/c/UaOFSsF9) (storage contract)

Aggregates only. The extracted CSV files and the per-film `matches.jsonl` stay in private directories outside the repository; no title, code, URI or rating appears here. Procedure: [letterboxd-export-reconciliation.md](../../runbooks/letterboxd-export-reconciliation.md); rules: [export contract](../../reference/integrations/letterboxd-export.md).

## Export sets

| Set | Films |
| --- | --- |
| Watched | 2,160 |
| Rated | 2,152 |
| Watched without rating | 8 |
| Rated but not watched | 0 |
| Watchlist | 397 |
| Watchlist ∩ watched | 97 |
| Distinct films across files | 2,460 |
| Diary entries (auxiliary) | 469 |

Every row of every file is valid: 0 invalid, 0 duplicates, 0 conflicts, 0 missing years, 0 cross-file mismatches.

## Snapshot index

| Measure | Value |
| --- | --- |
| Stored Letterboxd ids | 420 (watchlist 397, programme 397, metadata 420, view index 413, ratings generation 0) |
| Stored ids with a TMDB id / with conflicting TMDB ids | 420 / 0 |
| Verified catalog records (`tmdb_<n>`) | 1,924 |
| Missing snapshot keys | 1: `enrichment/ratings/published.json` (no ratings generation is published, so the index has no Letterboxd ratings) |

## Match status

| Status | All films | Watched | Rated | Watched unrated | Watchlist | Watchlist ∩ watched |
| --- | --- | --- | --- | --- | --- | --- |
| `accepted` | 420 | 120 | 116 | 4 | 397 | 97 |
| `provisional` | 0 | 0 | 0 | 0 | 0 | 0 |
| `candidate` | 561 | 561 | 561 | 0 | 0 | 0 |
| `ambiguous` | 1 | 1 | 1 | 0 | 0 | 0 |
| `conflict` | 0 | 0 | 0 | 0 | 0 | 0 |
| `unmatched` | 1,478 | 1,478 | 1,474 | 4 | 0 | 0 |
| **Total** | **2,460** | **2,160** | **2,152** | **8** | **397** | **97** |

Accepted by method: `lid_exact` 411, `tmdb_verified` 9, `title_year` 0 (title and year never accept on their own). Non-accepted reasons: `no_stored_title` 1,439, `identity_unverified` 561, `title_without_year_match` 39, `multiple_targets` 1 (sum 2,040 = 2,460 − 420). Nine accepted films link to a verified catalog record.

## Whether the export code is the stored Letterboxd id

| Evidence on the 420 stored ids | Count |
| --- | --- |
| Export code equal to the stored id | 420 |
| Title and year agree | 420 (0 title differs, 0 year only, 0 disagree) |
| Rating agrees / disagrees / unknown | 109 / 0 / 311 |
| Title-only match to a stored id no code equals | 0 |
| Title-only match to a stored id another code equals (namesake) | 1 |

The first run reported `mixed` because the matcher counted the one namesake, a second watched film whose title matches a stored id within a year while that id already equals another export code, as evidence against the hypothesis. It is not: the stored id is correctly claimed by its own code. This PR excludes such rows from the verdict and reports them separately; re-run, the verdict is `supported` and every other count and every private row is byte-identical.

## What the numbers mean

- **Watchlist is fully reconciled.** All 397 watchlist films, including the 97 rewatches, are accepted by exact id.
- **Most watched films are unknown to production.** The snapshot stores Letterboxd ids only for watchlist and programme films (420). 1,478 watched films have no stored record at all; 561 match a verified catalog record by title and year but have no second signal, so they stay `candidate`. The export carries no TMDB id, so these 2,039 films need an identity source outside this snapshot (for example TMDB lookup by the owner-approved path chosen in AIR-170) before any import.
- **Ratings evidence is thin.** With no published ratings generation, rating agreement comes only from the view index (109 agree, 0 disagree, 311 unknown).
- **Watched without rating:** 4 of 8 accepted, 4 unmatched.

## Limits

- The snapshot is the production state at `finishedAt`; later watchlist or programme changes are not reflected.
- `candidate`, `ambiguous` and `unmatched` rows were not reviewed by hand; their per-film data stays private.
- This report authorizes no import, rating write, watchlist change or D1 work; [AIR-173](https://trello.com/c/w2bVRb72) is the separately approved import.
