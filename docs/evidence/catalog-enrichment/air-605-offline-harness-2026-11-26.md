# Catalog Enrichment Producer: offline cost harness, 26 Nov 2026

**What this is.** A measurement of the dormant producer on a synthetic catalog. It is **not** a production measurement and claims no production capacity. Nothing was fetched, nothing was applied and nothing was written to production: the run used the sqlite3 CLI as the D1 stand-in, over a scratch database built from the real migration chain (schema 47), with injected upstream responses.

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

Two fixtures, same script, current code. Statements are counted by the harness wrapper around the D1 binding (every prepared statement, failed ones included); the sqlite3 stand-in reports no billed rows, so **billed `rows_written` is not measured here** (index writes would add to it).

| Measure | 60 Films, 13 credits | 20 Films, 141 credits |
| --- | --- | --- |
| Films drained | 60 of 60 (780 credits, 780 Persons) | 20 of 20 (2,820 credits, 2,060 distinct Persons) |
| Receipted units applied | 960 (16 per Film) | 2,160 (108 per Film: 1 core, 1 localization, Person units, 3 credits chunks) |
| Runs | 9: 8 ended at the statement budget (handover), the ninth found the queue idle | 17: 16 handovers and one idle |
| Films per run | 5 to 7 | 1 to 5 (a Film is resumed by the next run without refetching) |
| D1 statements per Film | 705.3 | 4,186.7 |
| D1 statements per unit | 44.1 | 38.8 |
| Upstream requests per Film | 1 TMDB, 1 Wikidata | 1 TMDB, 1 Wikidata |
| Applied receipts | 960, one per unit | 2,160, one per unit |
| Pending signals afterwards | 0 | 0 |

## Reading

- **A run crosses the statement budget without waiting, and a large cast spans runs.** The successor starts at once; the plan, rows and receipts make the next run resume the same Film at the next unit group without a second fetch. No operation key is applied twice.
- **The cost is dominated by Person units.** Each missing Person is its own receipted unit (reconcile read, reservation, fenced batch, state write), so a Film's cost grows with its cast: about 705 statements at 13 credits and about 4,190 at 141. Shared Persons are reused (2,060 Persons for 2,820 credits).
- **Steady state is far below the budget.** The dated census behind ADR 0219 estimates about 280 new Discovery admissions per day; at the measured cost that is of the order of 200,000 statements per day at the first fixture's cast size, spread over runs that each stop at their own budget.

## Covered by tests, not by this script

These are executable tests on the same stand-in, not measurements: priority split and fairness across handovers (`tests/catalog-enrichment-drain.mjs`), EPG yield and its resumption, the due-time wake for a backed-off item and for a backed-off signal, the code-version repair wake, the uncapped Letterboxd credits path (`tests/catalog-enrichment-letterboxd-credits.mjs`), the Workflow kick, park, handover and reconcile (`tests/catalog-enrichment-workflow.mjs`) and the causal postcommit wake (`tests/catalog-enrichment-wake.mjs`).

## Not measured here

- Wall time and CPU on the Worker, real D1 latency and billed rows, TMDB, Letterboxd and Wikidata response times and rate limits.
- A Letterboxd-anchored Film in the harness itself, a real EPG seal phase (the yield predicate is injected), trigger fan-out cost on a populated catalog and recovery-scan cost on a large retained set.
- The Cloudflare Workflow platform itself: a whole drain is one step in the wrapper, so step-level replay limits are not measured.
