# Full personal Letterboxd import into the canonical catalog: production validate, commit and projection (counts only)

**Captured:** 2026-11-08 20:00 UTC to 2026-11-10 10:40 UTC, from the executor's receipts on the [AIR-388](https://trello.com/c/fFvwYLjM) card (validate, commit, read-only reconciliation, 8 to 9 Nov) and from read-only checks made on 10 Nov (Worker logs `event=d1_enrichment_projection`, D1 `SELECT`s, `feature_flags`). Counts only: no film title, rating, archive file name or private row is copied here, and the archive digest is given as a 12-character prefix.
**Scope:** AIR-388 only: the personal Letterboxd archive imported into the existing Film catalog by the plan, validate and commit path of [ADR 0104](../../adr/0104-inferred-letterboxd-identity.md) (a unique original title and year may link a film to TMDB as `inferred`) and [ADR 0105](../../adr/0105-live-catalog-input-and-tmdb-search-admission.md) (live catalog input, bounded TMDB search, admission as `inferred`). It is the record of what was run and read; it neither repeats nor proposes any write.
**Verdict:** **IMPORT COMMITTED AND ITS FILMS PROJECTED; THE PERMANENT FILM URL DOES NOT RESOLVE FOR THE ADMITTED (`inferred`) FILMS.** All 45 of 45 chunks passed `validate` and were committed, each commit confirmed by a replayed request that returned the same receipt; 4,217 facts were written with the plan's own total, 703 `inferred` admissions were recorded with no conflict, and the projector has since turned every admitted Film into a canonical Film (`admittedFirst` 0 on the run of 2026-11-10 10:00 UTC). 254 rows of the archive stay unresolved on purpose. **A read-only check of four imported Films on 10 Nov found that the permanent catalog lookup `GET /api/catalog/film/<tmdb>` answers `absent` (404) for the two admitted Films and `found` (200) for the two Films that were already in the Discovery catalog**; the lookup reads only the Discovery catalog, which the admitted Films are not in (see below). What this report does not show: the rendered Film page and its watched mark and actual rating, the credits of the new Films (the owner does not require them) and any second import of the same archive.
**Used by:** [AIR-388](https://trello.com/c/fFvwYLjM); [ADR 0104](../../adr/0104-inferred-letterboxd-identity.md), [ADR 0105](../../adr/0105-live-catalog-input-and-tmdb-search-admission.md); the [projector fairness evidence](../d1-migration/air-388-projector-lane-starvation-2026-11-09.md) (the other half of AIR-388).

## What was run

| Step | When (UTC) | Result |
| --- | --- | --- |
| Offline plan with the live catalog input and the bounded TMDB search (842 of the 1,500 requests used by then) | 8 Nov | 2,210 films, 45 chunks, 4,217 facts: watched 1,911, rating 1,911 (1,903 numeric, 8 with no value), watchlist 395; 706 admissions to record; the archive digest begins `26fdeeff2460` |
| Production `validate`, no write, 45 of 45 chunks | 8 Nov 20:0x to 20:51 | Every chunk one successful answer, HTTP 200, `conflicts` 0, replay 0; outcomes `new` 3,557, `replaces` 265, `older` 395, `unchanged` 0, sum 4,217 = the plan; one chunk (43) lost its connection and chunks 43 and 44 were re-validated once with no state left |
| Freshness and authority check before commit | 8 Nov, about 21:20 | The catalog had grown from 5,971 to 6,006 current movies (+35, none removed); offline rebase #2 (no TMDB request, still 842 of 1,500; kept 839: `inferred` 703, review 136; superseded 3) gave the same 2,210 films, 45 chunks and 4,217 facts and **703 admissions instead of 706** (three films now link to an existing Film); the three chunks concerned were validated again, `conflicts` 0 |
| Production `commit`, 45 of 45 chunks | 8 Nov 21:20 to 9 Nov 00:03 | Below |
| Read-only reconciliation | 9 Nov, after the last receipt | Below |
| Projection of the admitted Films | 9 Nov 08:00 to 10 Nov 10:00 | Below |

The first commit command was refused by the session's own permission classifier before any request reached the Worker (no chunk was written, no receipt created); the commit ran from chunk 0 once the command was permitted in the session.

## The commit

- **Chunks:** 45 of 45, in order and without gaps. Each answered HTTP 200 with a receipt equal to the one `validate` predicted (films, outcomes, admitted), and **each read-back, a second request of the same chunk, returned `replay: true` with the same receipt and the same item hash (45 of 45).**
- **Facts:** 2,210 films, **4,217 facts = the plan's total**. Outcomes `new` 3,431, `replaces` 255, `older` 395, `unchanged` 136. The `unchanged` ones are facts the Worker had already stored before a connection broke (chunks 10 and 26); `older` 395 are the newer production observations that the import leaves alone by the newer-wins rule. Reconciled with `validate`: 3,557 + 265 = 3,822 = 3,431 + 255 + 136.
- **Admissions:** 703 of 703 recorded in the admissions object: 708 records = 703 `inferred` of this archive plus 5 earlier ones, `conflicts` 0, no unexpected kind.
- **Two deviations, both closed:** the connection was reset at chunk 10 (21:55:13 UTC) and at chunk 26 (22:55:56 UTC), 61 minutes apart (the periodic cause is a guess and not tested). Each time the run stopped under its stop rule, and the owner allowed **one repeat of that chunk**: chunk 10 had been written whole, chunk 26 partly (46 facts and 9 admissions already stored, the rest completed from the stored intent). Both ended with a receipt and a read-back. No other error or stop; no rollback, unlink, lease reset, flag, Task, migration, sync or Discovery run.
- **Markers:** the Film/Person authority stayed `r2`, `open`, generation 0; the ratings marker `d1`, `open` went from generation 107 to 3,803 after the commit (the generation moves with every fact written).

## Read-only reconciliation after the commit

- `ratings_view` holds a row for the Letterboxd id and one for `tmdb_<id>`, so counts double: watchlist rows 790 = 2 × 395. Watched (3,861) and rated (3,831) rows also include facts that existed before; the import's expected share is 2 × 1,911 and 2 × 1,903.
- A sample of 6 films (a rating with and without admission, a watched mark without a rating, watched and on the watchlist, watchlist only): each has both the Letterboxd and the TMDB alias in the ratings view, and the watched, rating and watchlist values match the plan.
- The catalog route (`GET /api/catalog/film/<tmdb>`, shown read-only) answered 200 for an existing Film that the import linked and 404 for a Film that was admitted but not yet projected.

## Projection of the admitted Films

The 703 admitted Films were created by the projector, not by the import. They waited behind a Person backlog until the lane fix of [PR #445](https://github.com/vladimino/iptv-watchlist/pull/445) (see the [projector evidence](../d1-migration/air-388-projector-lane-starvation-2026-11-09.md)); the first run with it (2026-11-09 08:00 UTC) projected 9, the second 8, and `admittedFirst` (admitted Films not yet projected) read 703, then 694. After the grouped write path was switched on for the projector on 2026-11-10 06:46 UTC, runs wrote hundreds of Films each; the run of **2026-11-10 10:00 UTC reports `admittedFirst` 0**, 630 Films and 1,808 Persons written, `errorCount` 0, no lease or window loss. `film` rows in D1: 3,036 before the fix, **6,675** at 10 Nov 10:40 UTC (read-only `SELECT`, all Films, not only the imported ones); no credit refers to a missing Person. The general backlog of changed Films (3,234) is not part of this import.

## What the new Films look like in D1 (read-only, 4 samples)

Four admitted Films read on 10 Nov exist under `film:tmdb:<id>` with one TMDB external id each, **no credits and no Letterboxd alias row in `film_external_id`**. Of all Films, 565 have no credits and 398 carry a Letterboxd alias row. Two owner decisions of 2026-11-10 bound what that means: credits are not a condition of this import (an existing credit must not be lost; missing ones may arrive through the ordinary metadata flow, nothing is run for them), and a missing materialized Letterboxd alias on an `inferred` Film is not a blocker while its watched, rating and watchlist facts read correctly on the TMDB page and the export's Letterboxd id stays with the facts and their provenance ([ADR 0104](../../adr/0104-inferred-letterboxd-identity.md): the identity of an inferred film is `inferred`, never `verified`, and is correctable per film). The `/film/<letterboxd id>` permalink for an inferred Film is not shown to work here and is not claimed.

## What is left, by design

**254 rows of the archive are not resolved**, none promoted to `inferred`: 136 from the TMDB search (`alias_title_only` 66, `year_drift` 29, `multiple_exact` 22, `no_match` 16, `no_result` 3), 93 matcher review rows, 24 provisional and 1 ambiguous. TMDB search requests: 842 of the 1,500 budget, none since.

## Read-only check of the permanent Film lookup (10 Nov, 10:50 to 11:10 UTC)

Through the owner's Cloudflare Access session, one `GET /api/catalog/film/<tmdb>` per Film (the route `tests/get-side-effects.mjs` proves read-only) for four imported Films chosen from the commit window (watched and rated and admitted: 2; watched without a rating: 1; an older catalog Film watched and rated: 1). No title, rating or id is recorded here.

| Film | In D1 `film` | In the Discovery catalog (`discovery_admission`, `current`) | `GET /api/catalog/film/<tmdb>` |
| --- | --- | --- | --- |
| admitted, watched and rated (2 Films) | yes | **no** | **404 `absent`** |
| watched without a rating | yes | yes | 200 `found` |
| older catalog Film, watched and rated | yes | yes | 200 `found` |

- **Why the two answer `absent`:** `catalogFilmRoute` (`src/worker.js`) answers from the Discovery catalog only (under Discovery authority `d1`, `readFilmAdmission` over `discovery_admission`, 8,312 current movies on 10 Nov); it has no fallback to the canonical `film` row or to the admissions object. The permanent page of a Film absent from that catalog shows the `absent` state (`ensureCatalogFilm` in `public/app.js`). In D1, 549 `film:tmdb:*` Films have no catalog admission; the imported `inferred` Films are expected to be most of them, which is not proven here.
- **What was not read:** the page itself. Its watched mark and actual rating come from `GET /api/enrichment/view` (a route that can write, per `tests/get-side-effects.mjs`) and the programme and watchlist reads (not safe probes); none was called. The admin Film detail route is keyed by programme ids and answered 404 for TMDB ids. The catalog lookup returns no watched or rating field. So the watched mark, the actual rating, the first-watch exclusion and rewatch are **not observed**; only the permanent lookup is.

## What this does not show

- **The rendered Film page.** Beyond the lookup above, no page was opened and no watched or rated value was read through a user-facing route; the first-watch exclusion and rewatch are not checked.
- **A second import.** The idempotence shown is within this commit: the replayed request of every chunk returned the same receipt, and the 136 `unchanged` facts were stored once. The same archive was never submitted again, so "a repeat creates no duplicate" is argued by the receipts, not observed.
- **Credits, Letterboxd alias rows and the permalink by Letterboxd id** of the new Films (see above).
- **The cause of the two connection resets**, and every number that rests only on the executor's receipts (the digests, the chunk outcomes, the 6-film sample): they were read from the card, not re-run.
- **Product acceptance**, which belongs to the owner.
