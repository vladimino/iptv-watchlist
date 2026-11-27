# Catalog Enrichment writers: gate reuse, before and after, 27 Nov 2026

**What this is.** A comparable offline before/after measurement of the time-bounded, operation-scoped reuse of the canonical writer gate ([AIR-688](https://trello.com/c/cj14HCue)), a follow-up found while measuring AIR-605 ([harness evidence](air-605-offline-harness-2026-11-26.md)). It is **not** a production measurement: nothing was fetched, applied or written to production. The run used the sqlite3 CLI as the D1 stand-in over a scratch database built from the real migration chain, with injected upstream responses. It claims no production throughput, no billed `rows_read` or `rows_written` and no fixed saving.

**How to repeat it.** `--no-reuse` is the baseline (a drain without the scope, the behaviour before the change); `--profile` classifies each statement by a literal-free fingerprint.

```bash
node scripts/catalog-enrichment-harness.mjs base 60 12 --profile --no-reuse
node scripts/catalog-enrichment-harness.mjs base 60 12 --profile
node scripts/catalog-enrichment-harness.mjs base 6 220 --profile --no-reuse   # >200 credits, shared Persons
node scripts/catalog-enrichment-harness.mjs base 6 220 --profile
node scripts/catalog-enrichment-harness.mjs mixed 24 24 --profile --no-reuse
node scripts/catalog-enrichment-harness.mjs mixed 24 24 --profile
node scripts/catalog-enrichment-harness.mjs epg 12 --no-reuse
node scripts/catalog-enrichment-harness.mjs epg 12
```

## The redundant reads, separated

The gate is **four logical facts** (the marker row, the fence row, the baseline row and the schema contract with the table inventory) read by **three SQL statements** (`readState` in `src/film-person-authority.js`: the table inventory, the schema-contract version and one statement for the marker, fence and baseline rows), repeated by every fenced writer entry. Counted per statement kind on the merged tree (60 Films, 13 credits each, 960 receipted units):

| Statement kind | Before | After | Reused? |
| --- | --- | --- | --- |
| Table inventory of the four authority tables | 2,880 | 960 | the routing read of each unit stays fresh; the writers reuse it |
| `schema_contract` version | 2,880 | 960 | as above |
| Marker, fence and baseline rows (one statement) | 2,880 | 960 | as above |
| Receipt-table and operation-key schema probes | 2,880 | 16 | yes, positive answers only |
| **Receipt lookup of the reconcile step** | 2,880 | 2,880 | **never reused** |
| All other statements | 29,091 | 29,191 | unchanged |

One routing read per unit remains (3 statements, 960 units); the gate reads that went away are the repeats inside the unit's writers (about 9 of 12 statements per unit, plus the schema probes). The profile counts every statement the stand-in saw, including the few the drainer's own counter does not count (the run bookkeeping on the raw binding): 43,491 and 34,967 against the drainer's 43,446 and 34,927, a difference of 45 and 40 statements. The table totals are the profile's; the comparison table below uses the drainer's counts.

## Review correction (P1): the routing gate is always fresh

The first version of this change also served the **routing** read (`writerRoute`) from the snapshot. The independent review showed that a unit whose effect is already in place (a settled replay, a fresh no-op, a facts call that finds everything stored) executes no fenced batch, so a warmed snapshot followed by a held marker would let it settle although the marker is held. `writerRoute` now calls `readRouteGate`: always a fresh authoritative read at the start of every unit, which refreshes the scope for the writers of that unit and clears it on a non-open answer. A unit that starts after a hold or a generation move is refused exactly as before the change. The saving fell accordingly, from the 26 to 30 percent first measured to the figures below.

## Comparable profile

Same fixtures and the same real drainer in both columns, on the merged tree (main with AIR-684 included; the earlier baseline was taken before that merge and is replaced); only `gateReuse` differs. Counts are the drainer's own statements (a batch counted per statement).

| Fixture | Statements before | Statements after | Change | Result |
| --- | --- | --- | --- | --- |
| `base 60 12`: 60 Films, 13 credits, 780 Persons | 43,446 (724.1 per Film) | 34,927 (582.1 per Film) | -19.6% | 60 of 60 Films, 780 credits, 960 units in both; 149 and 150 upstream requests (a different handover boundary re-fetches a different number of resumed Films, the 120 first-fetch requests are equal) |
| `base 6 220`: 6 Films, 1,326 credits (more than 200 per Film), 726 distinct shared Persons | 30,405 (5,067.5 per Film) | 23,376 (3,896 per Film) | -23.1% | 6 of 6, 1,326 credits, 768 units, 12 requests in both |
| `mixed 24 24`: 24 live and 24 background Films, 768 units | 34,665 | 27,779 | -19.9% | 768 units, 13 runs and 113 requests in both |
| `epg 12`: the producer alone, 12 Films | 8,578 | 6,854 | -20.1% | 12 TMDB and 12 Wikidata requests; the EPG yield cases unchanged |

Wall time of the harness on the stand-in follows the statement count (it spawns a process per statement); **it is not a Worker or D1 wall time** and is not claimed. The saving is a measurement of this fixture, not a promise of any fraction on production. The cost is still dominated by Person units: the remaining statements are the actual writes, the revision and receipt assertions, the per-unit receipt lookup and the per-unit routing read.

## What was and was not reused

- **Reused:** inside one drain, for at most 5 s, the `open` marker snapshot taken by the unit's fresh routing read, by the fenced writers' entries (`mutateFilm`, `writeFilmFacts`, the receipted write) of that unit; and a positive receipt-table and operation-key schema probe for the same time. The snapshot is a copy, only `open` is kept, any failed batch drops it, and a drain without the scope reads fresh as before.
- **Never served from the scope:** the routing read of each unit (`readRouteGate`), the receipt lookup and reconcile, receipt state, reconcile-then-reserve, request correlation, the epoch and lease assertions, the entity revision assertions, the failed-CHECK classification (a fresh re-read), reports and the authority transition.
- **The fence:** every canonical batch asserts `mode='d1' AND cutover='open' AND generation=?` (plus the producer or Letterboxd epoch fence and the entity revisions) in its own transaction. A snapshot that went stale **inside a unit** fails a writing batch whole with `film_person_fence`, writes nothing and drops the snapshot. The remaining window is the rest of one unit (milliseconds, at most the TTL): a no-batch outcome later in the same unit, after the routing read, is not re-validated; this was the case for a hold between a unit's own steps before the change as well, and a unit that starts after the hold is always refused.
- **The schema limit:** the schema contract and the table inventory are not asserted inside the batch (they were not before either). `tests/film-person-gate-reuse.mjs` shows that the database refuses to lower the contract (`schema_contract_downgrade`).

## Tests of the actual shared writers

`tests/catalog-enrichment-units.mjs` (new section): a gate scope warmed by an applied unit, the marker moved to held, then a settled replay and a fresh no-op are both refused with `film_person_held`, nothing is settled or written, the scope is cleared, and after the reopen (new generation) the unit settles and the scope is refreshed to it; it fails without the routing fix. `tests/catalog-enrichment-units-scoped.mjs` re-runs the whole receipted-unit suite (Person and credit units, facts, replay, noop, settled, lost response, concurrent writers, a closed route) with the gate scope on every env. `tests/film-person-gate-reuse.mjs`, on the real migrated schema through `mutateFilm`: no scope reads fresh; the snapshot is served inside the TTL and read again at it; a copy per caller (a bound producer fence does not leak); only `open` is kept, a held marker is read fresh and a prepared one throws; a generation that moved (held then open) after the snapshot fails the batch whole with nothing written, drops the snapshot and the next call succeeds on the new generation; a cutover moved to held fails the batch, then refuses with `film_person_held`; a rival writer that advanced the Film revision still conflicts; a positive schema fact is kept and a negative one is not; the schema downgrade is refused by the database. The existing suites for the shared writers (`canonical-film-writers`, `canonical-receipts`, `canonical-person-state`, the enrichment drain, producer, workflow, wake and units suites) and the mutation suites whose anchors moved (`canonical-film-writers-mutation`, `canonical-receipts-mutation`) pass unchanged in meaning; the receipt and operation-key readiness checks and the producer fences are retained (the positive-only schema facts are kept only when `ready`).

## Not measured here

Wall time and CPU on the Worker, real D1 latency, billed rows read or written, upstream response times, and production behaviour. No Scheduled Task, flag, migration, fetch, retry or D1/R2 write was involved.
