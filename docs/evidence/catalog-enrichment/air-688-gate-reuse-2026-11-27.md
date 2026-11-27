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

Before the change five reads repeated for every receipted unit of a Film; two more schema probes belonged to the receipt writer. Counted per statement kind (60 Films, 13 credits each, 960 receipted units):

| Statement kind | Before | After | Reused? |
| --- | --- | --- | --- |
| Marker inventory (`sqlite_master` of the four authority tables) | 2,880 | 7 | yes: one per drain |
| `schema_contract` version | 2,880 | 7 | yes |
| Marker, fence and baseline rows (one statement) | 2,880 | 7 | yes |
| Receipt-table and operation-key schema probes | 2,880 | 14 | yes, positive answers only |
| **Receipt lookup of the reconcile step** | 2,880 | 2,880 | **never reused** |
| All other statements | 28,806 | 28,911 | unchanged |

The first four rows are the redundant reads; they fall from 11,520 to 35 (one gate read and two schema probes per drain, seven drains). The other statements rose by 105 only because the smaller drain stopped at its statement budget later and the Film that was in flight resumed across a different handover.

## Comparable profile

Same fixtures and the same real drainer in both columns; only `gateReuse` differs. Counts are the drainer's own statements (a batch counted per statement).

| Fixture | Statements before | Statements after | Change | Result |
| --- | --- | --- | --- | --- |
| `base 60 12`: 60 Films, 13 credits, 780 Persons | 43,161 (719.4 per Film) | 31,791 (529.9 per Film) | -26.3% | 60 of 60 Films, 780 credits, 960 units, 120 upstream requests in both |
| `base 6 220`: 6 Films, 1,326 credits (more than 200 per Film), 726 distinct shared Persons | 30,447 (5,074.5 per Film) | 21,183 (3,530.5 per Film) | -30.4% | 6 of 6, 1,326 credits, 768 units, 12 requests in both |
| `mixed 24 24`: 24 live and 24 background Films, 768 units | 34,522 | 25,356 | -26.6% | 48 Films, same 10 runs, same fairness |
| `epg 12`: the producer alone, 12 Films | 8,662 | 6,368 | -26.5% | same two runs, 12 TMDB and 12 Wikidata requests; the EPG yield cases and their evidence unchanged |

Upstream requests and receipted units are identical before and after in every fixture. Wall time of the whole harness process on the stand-in (`base 60 12`, two runs each): about 10.9 and 11.0 s before, about 8.0 and 7.7 s after. The stand-in spawns a process per statement, so this follows the statement count; **it is not a Worker or D1 wall time**.

The saving is a measurement of this fixture, not a promise of 31% or of any fraction on production. The cost is still dominated by Person units, and the remaining statements are the actual writes, the revision and receipt assertions and the per-unit receipt lookup.

## What was and was not reused

- **Reused:** the `open` marker snapshot of the fenced writers (`mutateFilm`, `writeFilmFacts`, the receipted write, `writerRoute`) for at most 5 s inside one drain, and a positive receipt-table and operation-key schema probe for the same time. The snapshot is handed out as a copy, only `open` is kept, any failed batch drops it, and a drain without the scope reads fresh as before.
- **Not reused:** the receipt lookup and reconcile (the previous result is not proof of the current operation), receipt state, reconcile-then-reserve, request correlation, the epoch and lease assertions, the entity revision assertions, the failed-CHECK classification (it re-reads the marker fresh), reports and the authority transition.
- **Why the fence is unchanged:** every canonical batch already asserts `mode='d1' AND cutover='open' AND generation=?` (plus the producer or Letterboxd epoch fence and the entity revisions) in its own transaction, which is the authoritative check; the pre-read only chose the error code and refused early. A snapshot that went stale fails the batch whole with `film_person_fence`, writes nothing and drops the snapshot. Before the change the same fence failure was reachable in the window between the read and the commit; the window is now at most 5 s wide.
- **The schema limit, stated plainly:** the schema contract and the table inventory are not asserted inside the batch (they were not before either). `tests/film-person-gate-reuse.mjs` shows that the database refuses to lower the contract (`schema_contract_downgrade`), so a snapshot cannot become false inside the window; a migration only moves it forward. A **held** cutover seen by a stale snapshot is reported as `film_person_fence` instead of `film_person_held` for at most one unit, then the next call reads fresh and reports `film_person_held`.

## Tests of the actual shared writers

`tests/film-person-gate-reuse.mjs`, on the real migrated schema through `mutateFilm`: no scope reads fresh; the snapshot is served inside the TTL and read again at it; a copy per caller (a bound producer fence does not leak); only `open` is kept, a held marker is read fresh and a prepared one throws; a generation that moved (held then open) after the snapshot fails the batch whole with nothing written, drops the snapshot and the next call succeeds on the new generation; a cutover moved to held fails the batch, then refuses with `film_person_held`; a rival writer that advanced the Film revision still conflicts; a positive schema fact is kept and a negative one is not; the schema downgrade is refused by the database. The existing suites for the shared writers (`canonical-film-writers`, `canonical-receipts`, `canonical-person-state`, the enrichment drain, producer, workflow, wake and units suites) and the mutation suites whose anchors moved (`canonical-film-writers-mutation`, `canonical-receipts-mutation`) pass unchanged in meaning.

## Not measured here

Wall time and CPU on the Worker, real D1 latency, billed rows read or written, upstream response times, and production behaviour. No Scheduled Task, flag, migration, fetch, retry or D1/R2 write was involved.
