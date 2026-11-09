# D1 enrichment projector: Films starved behind a Person backlog

**Captured:** 2026-11-09 07:00–08:05 Madrid (06:00–07:05 UTC), read-only: D1 `SELECT`, Worker logs (`event=d1_enrichment_projection`, eight hourly cron runs from 2026-11-09 00:00 to 07:00 UTC) and one R2 `HEAD`. No manual projector run, no window or lease reset, no flag, schedule or migration change. Counts only: no Film title, Person name or Letterboxd code.
**Scope:** [AIR-388](https://trello.com/c/fFvwYLjM), the 703 Films that the verified Letterboxd archive admitted on 2026-11-09 and that did not appear. Not a statement about the correctness of any other projector behavior.
**Verdict:** **CONFIRMED CAUSE, FIXED IN CODE (fairness only).** The projector ran every hour with a granted window and no error, but it wrote Persons and no Film, so the admissions never became Films.
**Used by:** the AIR-388 projector fairness change (`src/d1-enrichment.js`, `tests/d1-enrichment-fairness.mjs`); [ADR 0056](../../adr/0056-d1-enrichment-write-through.md) decision 7 (bounded runs), [ADR 0103](../../adr/0103-projector-exclusive-window.md) (window)

## What was observed

The write queue of one run was built in a fixed order: every changed Person (25 per batch), then every changed Film, then the Film sync clocks, then the entities no source lists any more. All of it shares one budget of 800 queries and 60 s of wall time. After the 00:00 run, which the import's own commit deferred with `input_changed` on `letterboxd/admissions/verified-films.json`, the seven runs from 01:00 to 07:00 UTC each had the window granted (`generationAtGrant` equal to `generationAtFirstBatch`), no lease or window loss and no error, and each ended `outcome=budget`:

| Run (UTC) | Persons written | Films written | Changed Persons | Changed Films | Queries | Load time |
| --- | --- | --- | --- | --- | --- | --- |
| 01:00 | 200 | 0 | 13,741 | 4,350 | 224 | 17.0 s |
| 02:00 | 250 | 0 | 13,605 | 4,365 | 276 | 18.2 s |
| 03:00 | 75 | 0 | 13,612 | 4,417 | 94 | 28.9 s |
| 04:00 | 775 | 0 | 13,537 | 4,417 | 822 | 5.2 s |
| 05:00 | 100 | 0 | 13,233 | 4,512 | 120 | 32.2 s |
| 06:00 | 775 | 0 | 13,553 | 4,589 | 822 | 5.7 s |
| 07:00 | 775 | 0 | 13,064 | 4,645 | 822 | 5.8 s |

Over the seven runs 2,950 Persons and no Film were written. The Person backlog fell by 677 in six intervals while 2,750 were written, so about 345 Persons an hour were added by Discovery (the Person total grew from 38,925 to 40,420). A run wrote between 75 and 775 Persons depending on how much of the 60 s its load used. In D1 the last Film checkpoint was 2026-11-05 08:37 UTC (`film` 3,036 rows, no Film projected for four days), `film_rated_admission` was empty, and `projector_window` was `idle`. The admissions object in R2 held the 703 inferred entries of the archive and did not change after the commit (same ETag and size). The monitor showed no projector issue.

## What the fix does

The write step of a run is three lanes that share the same budget instead of one fixed queue: Films, Persons, and housekeeping (the sync clocks, then the absent entities). Each step takes the lane with the lowest spent cost divided by its weight (Films 3, Persons 2, housekeeping 1), where cost is the lane's own queries, the unit of the budget. A tie goes to Films, so a run begins with the first Film. Among the Films, those a verified archive admitted and D1 never projected go first; once projected a Film is no longer new, so the priority ends by itself. A Film's credits reference Person rows, so the Persons a Film needs are written just before it, in the same step (groups of 25), and they leave the Person lane. The budget is checked between those groups and again just before the Film's own batch (review finding on the first version): a Film is never started after the budget or the wall time is spent. If the Persons used what was left, only they are written and checkpointed, the Film stays pending and counts as remaining, and the next run writes it, its Persons then being stored. The budget, the wall time, the window, the lease, the fences, the change keys and the cron are unchanged, and the new summary fields (`admittedFirst`, `laneQueries`, `peopleForFilms`) only report.

## What the offline test shows

`node tests/d1-enrichment-fairness.mjs` on a local SQLite database through migrations `0001`–`0004`, 30 watchlist Films with 7 actors each and 12 admitted Films (264 Persons for 42 Films): with a budget that fits a fraction of the Person backlog every run writes Films and Persons, the first run projects admitted Films only, the priority ends, no Film is written before its Persons (no dangling credit), a run starved of budget after its load writes only the first Film's own Persons and the Film follows in the next run, a Film with 61 prerequisite Persons whose budget runs out in the middle is not started (only Person batches are sent), stays pending and is completed by the next runs with exactly the rows of an unconstrained run, backlogs that grow every run progress on both sides, a Film no source lists any more is released in a run that also writes Films and Persons, the runs converge to exactly what one unconstrained run writes, and nothing is written twice. On the code before the change the same test fails at the first run (`films: 0, people: 75`).

## Natural acceptance (read-only, after the deploy)

On the next hourly runs, from the Worker logs and D1 `SELECT` only: `writtenFilms > 0` and `writtenPeople > 0` in the same run while both backlogs are non-zero, no `leaseLost` or `windowLost`, no error, the window released, Discovery resumed; `film_rated_admission` for the archive rising toward 703; then a small sample of the admitted Films on `/film/tmdb_<id>`, with their Letterboxd aliases. The drain rate is not promised here: the Film backlog (4,645 changed Films at the time) is larger than the 703, and each run stays bounded. If a run after the deploy writes no Film, stop and record the data; do not run the projector by hand.
