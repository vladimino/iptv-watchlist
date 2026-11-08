# AIR-373: read-only D1 inventory of canonical Film/Person before any baseline decision

**Captured:** 2026-11-08, about 09:30–09:50 UTC (10:30–10:50 Europe/Madrid), production D1 `iptv` at schema 17. **Method:** read-only D1 `SELECT`s only (every response `changed_db=false`, `rows_written=0`); no R2 read, no snapshot export, no write, no marker move, no `epg_sync_*`, no flag, Task or cron change. Counts and flags only: no title, name or payload text is recorded here. This is the D1 side of the parity ledger; the R2-derived expected side is **not measured** (see the end).

## Canonical tables (counts)

| Item | Count |
| --- | --- |
| `film` / `person` | 3,036 / 25,724 |
| `film_external_id` (trusted / conflicting) | 3,836 (3,434 / 0) |
| `person_external_id` | 24,213 |
| `film_alias` / `person_alias` | 3,286 / 25,745 |
| `film_redirect` | 0 |
| `film_person_credit` (on `person:tmdb_*` Persons) | 37,288 (32,899) |
| `film_metadata` / `film_sync_state` | 398 / 398 |
| `film_dimension` / `person_dimension` | 13,912 / 48,426 |
| `watchlist_film` | 393 |
| `localization_conflict` | 1 |
| `projection_state` | 27,647 (enrichment: 3,036 film + 24,213 person keys; 398 other projection keys, the metadata sync clocks) |
| New tables of 0013–0017 | all empty; marker `r2` / `open` / 0, fence 1, baseline `empty`; `canonical_revision` 0 rows |

## Internal consistency (D1 only)

- Every Film has a projector key (0 without) and no key lacks its Film (0). Every Film has a trusted external id (0 without). No `watchlist_film` row lacks its Film. 2,643 Films are not in `watchlist_film` (retained or discovery-admitted Films, not an anomaly by itself).
- 24,213 of 25,724 Persons have a projector key; **1,511 have none**. They are the candidates for the D1-only Persons of AIR-286 (`person:tmdb_*`, no key by design); that identification is **not proven** here (22,234 Persons are `person:tmdb_*` in total and most of them are keyed).
- Owner reviews: 3 Film and 4 Person entries, all `verified`, generation 1, every `identity_link` present. The 3 entries that carry an owner localization (2 Film, 1 Person) equal the effective D1 value, and that row has authority `owner`; the other 4 entries carry no localization (aliases or links). Effective localization rows: Film 2,638 missing, 6 provisional, 390 reviewed, 2 owner; Person 20,774 missing, 2,573 provisional, 865 reviewed, 1 owner.
- Baseline import receipts (`import_receipt`, all 29 Oct 2026): 2,402 Film and 17,344 Person receipts, a historical import, not a current baseline.

## The projector's own plan: D1 is behind the R2-derived view

The latest `projection_run` summary (hourly cron, started 08:37:30 UTC, outcome **`deferred`**, reason `input_changed`, input `discovery_authority`, Discovery generation 30,766) reports the view the projector built before it stopped, without writing:

| Plan | Value |
| --- | --- |
| Films / people in the view | **6,110 / 36,541** |
| Stored keys (what D1 already holds) | 27,249 (= 3,036 + 24,213) |
| Changed Films / People (to write) | **3,163 / 12,400** (about 3,074 of the Films are not in D1 yet) |
| Absent / unmatched credit Films / membership removed | 0 / 0 / 0 |
| Changed sync clocks | 4 |
| TMDB retirements | valid, 4 applied, none held |
| Duration / queries | 21.2 s / 16 |

**Conclusion.** Parity between D1 and the R2-derived expected state does **not** hold now: D1 lacks about half of the Films and a third of the Persons that the projector would write, and the projector has been deferring on `input_changed` (see the AIR-375 evidence for the same pattern in earlier ticks). The baseline gate cannot be passed, and `prepared` cannot be proposed, until the projector completes runs (or a bounded load closes the difference) and a measured ledger shows zero unexplained differences.

## Not measured

The R2-derived expected state (it needs a read-only R2 snapshot or a projector `dry` run, each an owner decision); per-entity hashes; the D1-only Person identification; the class-C exceptions; whether the deferral is a transient race with Discovery (the hourly runs of both start at :37) or a persistent fault; and whether the pending Films are legitimately new or an artefact of the view.
