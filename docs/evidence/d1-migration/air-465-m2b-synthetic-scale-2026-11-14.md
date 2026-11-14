# Synthetic-at-scale M2b measurement (14 Nov 2026)

**Captured:** 2026-11-14, 00:50 UTC (remeasure of the same layout; the 00:18 UTC run had the same unit counts and statement totals, without the credit-cap stress). **Method:** `node scripts/epg-producer-m2b-synthetic.mjs measure` on the local sqlite file built from the repository migrations and the deterministic layout of seed `m2b-synthetic-e6-2026-11-14` (layout digest `af5f4d6094ad283ee5ca688da8ba718c789a267977dc121bb25fe243fd4f4ea1`, pinned by `tests/epg-producer-m2b-synthetic.mjs`). The harness is `runOnCopy` / `dryRun` ([`scripts/epg-producer-m2b.mjs`](../../../scripts/epg-producer-m2b.mjs), [`scripts/epg-producer-dry-run.mjs`](../../../scripts/epg-producer-dry-run.mjs)) with its read-only guard. **No production read or write, no connector, no export.** The sqlite file is not in the repository. Counts and timings only: [machine-readable result](air-465-m2b-synthetic-scale-2026-11-14.json).

**Environment:** Node v22.23.4, linux x64, 4 CPUs, sqlite 3.45.1. The measure command wall was about 9 s for the four scenarios. The harness timings below are this run. They move between machines. The unit counts and statement totals do not. They are local stand-in time, not Worker CPU, not a D1 round trip and not production latency.

## What the catalog is

The row counts are the sanitized E6 aggregates of 12 Nov 2026 ([evidence](air-374-e6-production-measurement-2026-11-12.md)). The placement is a model that hits those totals. It is not a sample of production and not the production distribution.

| | Target (E6 aggregate, except the elevated cohort) | Built |
| --- | --- | --- |
| Films / Persons / credit rows / dimension rows | 10,044 / 53,623 / 107,064 / 34,936 | same |
| Watchlist Films, their credit rows, distinct Persons | 391 / 8,600 / 6,452 | same; credit-list sizes 11 to 26 |
| Metadata and sync rows | 399 / 399 | same (every watchlist Film, plus the 8 elevated Films that include the 6 steady departed Films) |
| Elevated cohort | modelled, not an E6 count: another 391 Films, 8,600 credit rows, 6,452 Persons, disjoint from the watchlist | same |
| Shape, modelled | — | 1,846 Films with no credits; 2,035 Persons with no credits; 566 null titles; 98 watchlist metadata rows with a null year; 1,932 Films with no trusted external id; 169 conflicting external ids; 30 Films at the 50-credit unit cap; 20 redirects; foreign keys 0 |

`verifyCopy` accepted the file (`representative: true`). Schema 21.

## Steady load

Observed Films are the 391 watchlist members. Departed units are the first 6 Films of the elevated cohort (stored, not on the watchlist), the same sample `inputsFromCopy` selects.

| | Value |
| --- | --- |
| Units planned | 7,240 (397 `film_facts` = 391 observed + 6 departed, 6,452 `person_mutation`, 391 `film_credits`) |
| Planner refusals / failures | 0 / 0 |
| `changed` / harness `changedShare` | 0 / 0 |
| `person_state` | unmeasured (the harness does not build it) |
| Statements prepared | 30,999 (p50 4, p99 9, max 18) |
| Plan / fingerprint | 16.0 ms / 22.2 ms, 7,240 entries, `complete: true` |
| Wall / CPU user / CPU system | 2,577 ms / 1,528 ms / 527 ms |
| Writes / file bytes | 0 / unchanged |

The 30,999 statements reconcile exactly as 391 × 9 (an observed Film snapshot) + 6 × 18 (a release reads the snapshot twice) + 6,452 × 4 (`person_mutation`) + 391 × 4 (`film_credits`). That identity is arithmetic over the planners, confirmed because it equals the measured total. A Film snapshot's reads are issued together; the total is a statement count, not a serial Worker round-trip count.

The harness `changedShare` of 0 means the pre-plan matched the rows this fixture had just written. It is not the production share of units that apply.

## Absence and return

**Absence.** A film-only pass (persons and credits not re-planned) released the 6 stored departed Films plus 3 ids the store does not hold. Result: 6 no-op, 3 `absent`, fingerprint `complete: false` with `unresolved_release` 3. A departed id with no stored Film does not become a silent success.

**Return.** The elevated run inserts the whole elevated cohort, including those 6 Films, into `watchlist_film` and plans again. All 6 are observed Films and none is still a departed unit (`returnedSteadyDeparted` 6 of 6). They pre-plan as no-ops, because the stored membership now matches the observed facts. The watchlist manifest is rewritten from the table after the insert: `row_count` 782 and `max_rowid` 782, both equal to the table.

## Elevated load

Same catalog, watchlist widened to both cohorts (782 Films), plus 6 departed Films from outside both.

| | Value |
| --- | --- |
| Units planned | 14,474 (788 `film_facts`, 12,904 `person_mutation`, 782 `film_credits`) |
| `changed` / harness `changedShare` | 0 / 0, same fixture meaning as the steady run |
| `person_state` | unmeasured |
| Statements prepared | 61,890 (p50 4, p99 9, max 18), reconciling as 782 × 9 + 6 × 18 + 12,904 × 4 + 782 × 4 |
| Plan / fingerprint | 19.4 ms / 32.9 ms, 14,474 entries, `complete: true` |
| Wall / CPU user / CPU system | 4,193 ms / 2,293 ms / 838 ms |

The elevated cohort repeats the watchlist's credit shape on a disjoint Person set. It is a heavier modelled load, not a second production generation. Its Films have credit lists of 11 to 26. The 30 Films at the 50-credit cap are in the rest of the catalog and are not observed here.

## Credit-cap stress (not an E6 cohort)

One rest Film whose credit list is exactly 50, the unit cap, is copied onto a scratch watchlist that contains only that Film. The other 29 cap Films stay unobserved. Departed units are 0. This is a probe of the guarded harness at the cap, not the watchlist's credit distribution and not a production sample.

| | Value |
| --- | --- |
| Units planned | 52 (1 `film_facts`, 50 `person_mutation`, 1 `film_credits`) |
| `changed` / harness `changedShare` | 0 / 0, same fixture meaning |
| Statements prepared | 213 (p50 4, max 9), reconciling as 1 × 9 + 50 × 4 + 1 × 4 |
| Plan / fingerprint | 0.2 ms / 0.2 ms, 52 entries, `complete: true` |
| Wall / CPU user / CPU system | 564 ms / 403 ms / 126 ms |
| Watchlist manifest | `row_count` 1 and `max_rowid` 1, both equal to the table |

## What this does not decide

- **Not parity, not production latency, not the production `changedShare`.** Every stored unit was a no-op because the fixture and the harness describe the same rows.
- **Not `person_state`.** Still unmeasured.
- **Not a D1 cost and not a deadline.** 30,999 statements × an unmeasured Worker-to-D1 round trip is arithmetic, not an observation. At an assumed 5 / 20 / 50 ms, a serial reading of the steady statement count is 155 / 620 / 1,550 s, and an applied unit costs more than these no-op prepares. Local plan time (18 ms) and fingerprint time (23 ms) are not the constraint. None of those seconds was measured on the Worker.
- **Not a ceiling.** The steady plan is 7,240 units before `person_state`. A per-run ceiling of 1,000 covers 1,000 of them. A no-op is still one unit, so cheaper processing does not make 7,240 fit 1,000. No option in the [decision pack](../../runbooks/film-person-d-c-decision-pack.md) covers 7,240 in one generation, and option B is kept there as a Film-only illustration. `person_state` would add units. This run does not choose a larger ceiling, a catch-up design, a pre-plan filter or an acceptance of a perpetually `lagging` generation.
- **Not an L1 SLA.** A local wall of 2.6 s does not say the pass finishes within an hour of a real commit.

## Residual gap

The next measurement that can calibrate a deadline, a ceiling or a lag SLA is a real natural pass (the S5-2 differential, or D1 timings on a natural EPG step under its own GO), not another export of this catalog. It has to observe `changedShare`, `person_state` once that unit exists, the Worker-to-D1 round trip, and D1 CPU and write cost. Workflow limits (M1) are still unrecorded. A small production sample is an optional later card with its own GO ([runbook](../../runbooks/film-person-m2b-dry-run-copy.md)); this run did not take one.

Nothing here authorizes a production read, a writer, a flag, a Task, a migration or a marker change.
