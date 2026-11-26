# Catalog Enrichment Producer: offline cost harness, 26 Nov 2026

**What this is.** A measurement of the dormant producer on a synthetic catalog. It is **not** a production measurement and claims no production capacity. Nothing was fetched, nothing was applied and nothing was written to production: the run used the sqlite3 CLI as the D1 stand-in, over a scratch database built from the real migration chain (schema 46), with injected upstream responses.

**How to repeat it.**

```bash
node scripts/catalog-enrichment-harness.mjs 60 12
```

The arguments are the number of Films and the number of cast members per Film. The script runs the real drainer (`src/catalog-enrichment-drain.js`) with the default budget until the queue is idle.

## Fixture

- 60 Films, each with a trusted `tmdb` claim and an `admitted` signal in the rated scope (so the applicable sources are `tmdb` and `wikidata`; no Letterboxd anchor).
- One TMDB response per Film with 12 actors and 1 director (13 credits), a Russian translation and the core fields; one Wikidata answer with no label.
- Budget: the defaults of the drainer (6,000 statements per run, handover at 5,000, a reserve of 1,000, a step estimate of 150).

## Result

| Measure | Value |
| --- | --- |
| Films drained | 60 of 60 (60 metadata rows, 60 Russian title rows, 780 credits, 780 Persons) |
| Receipted units applied | 960, that is 16 per Film (1 core, 1 localization, 13 Persons, 1 credits chunk) |
| Runs | 9: 8 ended at the statement budget (handover) and the ninth found the queue idle |
| Films per run | 4 to 8 |
| D1 statements, total | 43,833 |
| D1 statements per Film | 730.6 (13 credits) |
| D1 statements per unit | 45.7 |
| Upstream requests per Film | 1 TMDB, 1 Wikidata |
| Pending signals afterwards | 0 (the producer's own writes emitted none) |

## Reading

- **More than two Films drain per run, and a run crosses the statement budget without waiting.** The successor run starts at once (the harness calls the next run immediately); the runs share no clock-based quota.
- **The cost is dominated by Person units.** Each missing Person is its own receipted unit (reconcile read, reservation, fenced batch, state write), so a Film's cost grows with its cast. At 13 credits a Film costs about 730 statements; a cast of 140 would cost roughly ten times that. This is a measurement, not a gate: on the Workers Paid baseline it is neither a limit nor a reason to cap the credits (decision 8 of ADR 0219 keeps every correctly identified credit). If the cost proves to matter, the lever is a cheaper per-Person unit, a separate decision with evidence.
- **Steady state is far below the budget.** The dated census behind ADR 0219 estimates about 280 new Discovery admissions per day. At the measured cost that is of the order of 200,000 statements per day for the fixture's cast size, spread over runs that each stop at the budget.

## Not measured here

- Wall time and CPU on the Worker, real D1 latency, TMDB, Letterboxd and Wikidata response times and rate limits.
- The Letterboxd path (the fixture has no Letterboxd anchor), a Film with a very large cast across several runs, EPG contention (the yield predicate is injected, not read from a real EPG seal phase) and the priority split between live and background Films (availability in the pinned EPG generation is read as unknown, which is live).
- The Cloudflare Workflow wrapper, the kick and the due-time wake: the drainer is the body of a run; its Worker wiring is not part of what was measured.
