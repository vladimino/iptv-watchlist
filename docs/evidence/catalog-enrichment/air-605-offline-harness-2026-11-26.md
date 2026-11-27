# Catalog Enrichment Producer: offline cost harness, 26 Nov 2026

**What this is.** A measurement of the dormant producer on a synthetic catalog. It is **not** a production measurement and claims no production capacity. Nothing was fetched, nothing was applied and nothing was written to production: the run used the sqlite3 CLI as the D1 stand-in, over a scratch database built from the real migration chain (schema 47), with injected upstream responses.

**How to repeat it.**

```bash
node scripts/catalog-enrichment-harness.mjs base 60 12
node scripts/catalog-enrichment-harness.mjs base 20 140
node scripts/catalog-enrichment-harness.mjs mixed 24 24
node scripts/catalog-enrichment-harness.mjs epg 12
node scripts/catalog-enrichment-harness.mjs populated 20000
```

Each scenario runs the real drainer (`src/catalog-enrichment-drain.js`) with the default budget on the real migrated schema until the queue is idle, and prints one JSON report. **Statements** are counted by the wrapper around the D1 binding (every prepared statement, a failed one included, a batch counted per statement); the sqlite3 stand-in reports no billed rows, so **billed `rows_written` and `rows_read` are not measured** (index writes would add to them). **Requests** are counted at the fetch boundary, redirect hops included.

## `base`: cost per Film

| Measure | 60 Films, 13 credits | 20 Films, 141 credits |
| --- | --- | --- |
| Films drained | 60 of 60 (780 credits, 780 Persons) | 20 of 20 (2,820 credits, 2,060 distinct Persons) |
| Receipted units applied | 960 (16 per Film) | 2,160 (108 per Film) |
| Runs | 9: 8 handovers and one idle | 18: 17 handovers and one idle |
| Films per run | 5 to 7 | 1 to 6 (a Film resumes at the next unit group, without a second fetch) |
| D1 statements per Film | 718.4 | 4,254.8 |
| D1 statements per unit | 44.9 | 39.4 |
| Upstream requests per Film | 2 (one TMDB, one Wikidata) | 2 |

## `mixed`: classes and fairness

24 live Films (rated membership) and 24 background Films (held only by the historical widening) under a cap of five Films per run, so run indexes give a queue-latency resolution. Live Films finished by runs 0 to 5 (median 2); background Films progressed from the first run and finished by runs 0 to 9 (median 7). Live work is served first and the background share keeps progressing across the same runs. 10 runs, nine of them handovers, 34,474 statements for 48 Films.

## `epg`: the actual publication path with and without the producer

The scenario runs the real `publishGeneration` of `src/published-epg.js` (staging, validation, publication under its own claim) and interleaves the drainer at the publisher's own `afterValidate` point, the only point of the publication where another writer can run between its steps. 12 Films, three cases:

- **Publication alone:** about 26 ms on the stand-in. **Enrichment alone:** 2 runs, 8,602 statements, 12 TMDB and 12 Wikidata requests.
- **Both:** six producer runs while the stage was `validated` with a live claim. Every one ended in `yield` with the evidence `epg_stage`; **no canonical unit was committed during the publication**; the first held run made one Film probe (2 upstream requests, 126 statements) and each of the other five made **no upstream request** (55 statements each: the rechecks run before any fetch because the previous run yielded). The publication's own time was about 15 ms with the producer running (the total of about 120 ms includes the producer's six runs), so it was not slowed by the producer; the stand-in's timings are too coarse for more than that. The publication completed (stage `published`), and the queue drained in the next two runs.
- **A publisher that fails after validating:** the stage stays `validated`, nobody renews its claim, and after the claim expired the producer drained all 12 Films in two runs: a stalled publication does not hold enrichment past its own claim. The `held` cutover marker of the authority is not a hold at all.

This measures the producer side and the publisher's own steps on the stand-in; **EPG publication latency on the Worker is not measured**.

## `populated`: a 20,000 Film catalog

20,000 Films with a member row and a state row each (2,000 due now, 4,000 backed off, the rest complete, 15 percent in the history cohort). One due selection read 100 index rows (50 per cohort, in 4 pages, 8 statements, about 26 ms on the stand-in) and found 100 distinct runnable Films; the Monitor fact reader issued 11 statements (about 33 ms); the runnable-signal read about 6 ms. A single anchor change on a value held by 2,000 Films wrote 2,000 inbox rows, one per Film (about 9 ms). The wall times are the sqlite3 CLI's, not D1's.

## Reading

- **A run crosses its budget without waiting, and a large cast spans runs.** The successor starts at once; the persisted plan and receipts make it resume the same Film at the next unit group without a second fetch, and no operation key is applied twice.
- **The cost is dominated by Person units.** Each missing Person is its own receipted unit, so a Film's cost grows with its cast. The measured figures are a fixture's cost driver, not a capacity statement and not a reason for a cap.
- **A reusable inefficiency was found and measured, and left for a separate decision.** Profiling a six-Film run by statement text shows that about 31 percent of all statements are five reads repeated for every receipted unit: the authority marker and schema-contract reads of the fenced writers (four statements) and the receipt lookup of the reconcile step. Those gate reads precede a batch that itself proves the marker, so a drain-scoped reuse of the authority read would keep the fence, but it changes the shared `film-person-authority` module and the mutation anchors of the writers, which is outside this card; it is recorded here as the first candidate, not applied. One cheap reuse was applied: the EPG hold answer is cached for a few seconds within a run (it was three reads at every write boundary, about 5 percent of statements).
- **There is no steady-state capacity claim.** An estimate of daily statements is not compared with the per-instance budget here, because the two are different quantities (a day of work against one instance's slice); a real capacity statement needs production telemetry, which an offline fixture cannot give.

## Covered by tests, not by this script

Priority split and fairness across handovers, the bounded examination of a head wider than the window, of disabled scopes, repeated slots and locked rows, the EPG yield at the write boundary and its evidence cases, the due-time wake of a backed-off item and of a backed-off signal, the code-version repair wake, the uncapped Letterboxd credits path (`tests/catalog-enrichment-letterboxd-credits.mjs`), the Workflow kick, park, handover and reconcile with sliced steps (`tests/catalog-enrichment-workflow.mjs`), the causal postcommit wake through the real writers (`tests/catalog-enrichment-wake.mjs`) and the bootstrap (`tests/catalog-enrichment-bootstrap.mjs`).

## Not measured here

- Wall time and CPU on the Worker, real D1 latency and billed rows, TMDB, Letterboxd and Wikidata response times and rate limits.
- A Letterboxd-anchored Film in the harness itself (the Letterboxd path is covered by tests), a real EPG seal phase, and the platform limits of a real Cloudflare Workflow step (the wrapper runs bounded slices, but the harness calls the drainer directly).
