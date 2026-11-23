# AIR-559: read-only audit of legacy inferred Letterboxd pairs

Date: **23 November 2026, 22:40 to 22:52 UTC**. Scope: read-only. The audit looks for Letterboxd-to-TMDB pairs in the production ratings facts that an `inferred` export import linked without a durable inferred mark. The canonical claim planner cannot tell such pairs from verified ones ([PR #958](https://github.com/vladimino/iptv-watchlist/pull/958), merged as `b6c3dea7e8979a7d7f6fb975e8fbfc35a388f0b8`; the known limit is described in the [claim backfill runbook](../../runbooks/letterboxd-claim-backfill.md)). Requested by the owner on [AIR-559](https://trello.com/c/733sRAxu) as the prerequisite for any decision on producer activation or a further backfill.

**Verdict: exactly one legacy unmarked inferred pair exists. No trusted `letterboxd` claim stands on it or on any inferred-marked pair.** That includes the nine claims of the 21 November backfill. **Nothing was written.**

## Why the planned method changed

The handoff planned to read the chunk receipts of the AIR-388 import, archive `26fdeeff2460…` ([import evidence](../letterboxd/air-388-full-import-2026-11-10.md)), whose entries list `identity: "inferred"` per film. Those receipts no longer exist. On 19 November 2026 the owner-authorized AIR-528 cleanup deleted all 90 objects under that archive's `chunks/` prefix, along with the receipts of archive `ab7fbe7e…` ([AIR-528 evidence](../letterboxd/air-528-r2-cleanup-2026-11-19.md)). A fresh LIST of `letterboxd/imports/` returned 0 objects. The audit therefore uses the durable traces that remain:

1. **The fact records themselves (D1).** The two inferred imports wrote `identity` on every record that was new or had no Letterboxd id. By the writer's code (`recordObservations`), an unmarked inferred pair can only exist on a record that already held facts and its lid but no TMDB id. That is a Diary-first record with key `lb-<lid>`: a `tmdb-<n>` record is created with its TMDB id, and one that lacks a lid is marked when the lid is added.
2. **`letterboxd/admissions/verified-films.json` (R2, retained).** Every Film the inferred import admitted has an entry with `identity: "inferred"`, its source code (the lid) and its movie id. Nothing removes an entry.
3. **Canonical claims (D1).** `film_external_id` rows of scheme `letterboxd`, with their provenance.

## Method

- **Credentials:** the bucket-scoped R2 **Object Read** pair (`R2_SNAPSHOT_*`) and the D1 API token (`D1_BACKFILL_*`) from the session environment. No value was printed or stored.
- **R2:** one LIST of `letterboxd/` (476 objects, none under `letterboxd/imports/`) and one GET of the admissions object, through `scripts/r2-s3-store.mjs` with no write allowlist, so the client cannot write.
- **D1:** `SELECT` statements only, through a local helper that refuses any other statement. The queries read `ratings_document` (the link index and every `letterboxd/facts/films/*` record, parts joined), `film_external_id`, `film_alias`, `published_epg_authority` and `published_epg_member`.
- **Consistent snapshot:** the ratings authority was `d1`/`open` at generation **4345** before and after the document reads; Film/Person was `d1`/`open` at generation 2.
- **Privacy:** the lid-to-movie lists stay in the session's private scratch space. They are not in this report, GitHub or Trello.

## Results

| Check | Count |
| --- | ---: |
| Fact records | 2,267 (`tmdb-<n>` keys 2,240, `lb-<lid>` keys 27) |
| Records with an inferred `identity` mark | 1,784 |
| Records stating both ids | 2,230, all agreeing with the link index |
| Records with an export observation of `26fdeeff…` | 1,909 |
| Of those, stating an agreeing pair without `identity` | 125 (124 on `tmdb-<n>` keys, 1 on an `lb-<lid>` key) |
| `lb-<lid>` records stating both ids | 7 |
| — independently verified: an admissions entry `identity: "diary_page"` for the same lid and movie (the Diary page and TMDB check) | 6 |
| — **legacy unmarked inferred pair**: admissions entry `identity: "inferred"` from `26fdeeff…` for the same lid and movie, no `identity` on the record | **1** |
| Inferred admissions in `verified-films.json` | 703 (plus 6 `diary_page`, 5 without an identity field) |
| — linked to the same movie on the lid's current record | 703 |
| — record carries `identity` | 702 |
| — **record carries no mark** (the same pair as above) | **1** |
| `letterboxd` claims in `film_external_id` | 415, all trusted and non-conflicting (406 with no provenance, 9 `ratings_alias_bridge` from the 21 November backfill) |
| Claims on a record with an inferred `identity` | **0** |
| Claims on the legacy unmarked pair | **0** |

The legacy pair has no `letterboxd` claim, no `letterboxd_short_code` alias, and is not a member of the published programme run. Its Film exists with one trusted `tmdb` claim, so the current planner would answer `pass` for it if a flow offered it.

## Interpretation and limits

- **The 124 unmarked pairs on `tmdb-<n>` keys** that carry an export observation are not inferred links. A `tmdb-<n>` record always holds its TMDB id. An inferred lid added to a record without one is marked (`letterboxdMissing`). So on those records the import either found the pair already stated (it changes no link then) or added a verified item's lid. This rests on the writer's code at the time of both imports, unchanged since ADR 0104. The audit does not re-prove it per record.
- **An import can link a pair without leaving an observation.** When every export fact is older than the stored one, no export observation is kept. That is why all seven `lb-<lid>` pairs were checked against independent evidence, not only the export-touched one. Six have a Diary page verification of the same pair; the seventh is the inferred admission.
- **Not covered:** a pair linked by an inferred item **without** an admission (the Film already existed) on a Diary-first record, where the record keeps no export observation either. Within the seven `lb-<lid>` pairs, none is unexplained, so no such pair exists today.
- The 21 November backfill (nine claims) is clear of both kinds of inferred pair.
- This is a snapshot at ratings generation 4345. It proves nothing about future imports; those mark every inferred pair since PR #958.

## Owner decision this informs

Only one pair needs a disposition. Options and the executor's recommendation are on the [AIR-559 card](https://trello.com/c/733sRAxu). This report authorizes no write, activation, backfill, flag, Task or migration.
