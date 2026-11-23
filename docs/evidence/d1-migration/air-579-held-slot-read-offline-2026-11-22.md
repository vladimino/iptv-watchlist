# AIR-579: per-observation slot read by coordinates, offline evidence (22 Nov 2026)

Repository change and offline tests only. No production read or write, no migration, no flag, Task, Workflow, cron or R2 operation. The effect in production is **not measured**: it needs a deploy and a natural EPG/Discovery catch-up, compared with the [RCA](air-579-d1-overload-rca-2026-11-22.md) signatures (left unchanged as history).

## What changed

`assignObservationSlots` in `src/discovery-authority.js` read the rows an observation key already holds in the published run twice per observation (before and after its write):

```sql
SELECT channel_id, start_ms, film_id FROM published_epg_show
WHERE programme_run_id=? AND basis='discovery' AND match_reason=?
```

The only index of `published_epg_show` besides the primary key is `(programme_run_id, start_ms)` ([migration 0008](../../../migrations/0008_published_epg_authority.sql)), so the engine could search only by run and then walked every row of the run (about 19.7 k per execution in the RCA window: 685 and 153 executions of the two by-key `SELECT` signatures plus the `DELETE` of another path read 13.5 M and 5.8 M rows).

The caller only ever looks up its **own slots** in the result (`channel:start`). The read is now the exported helper `heldSlotRows`, which adds `AND start_ms IN (<the start times of those slots>)` in chunks of at most `BIND_CAP - 3` binds. The same index is then searched by `(programme_run_id, start_ms)` for each start time. `basis` and `match_reason` are kept, so for every coordinate the caller looks up the result is identical to the former statement; rows of another run, another basis, another key or another film at the same time are not reported, and a different film holding the same key at a slot is still reported (the caller compares the film). No fence, guard, CAS, lease, write statement or return value changed; the per-slot `INSERT` guards are untouched.

## Measurement (scratch sqlite, production table and index from migration 0008)

20,000-row run, 3,000 keys, 400 channels; an observation key holding 7 rows.

| Read | Plan | SQLite VM steps | Rows returned |
| --- | --- | --- | --- |
| Former statement | `SEARCH ... (programme_run_id=?)`, then filter | 140,060 | 7 |
| `heldSlotRows` | `SEARCH ... (programme_run_id=? AND start_ms=?)` | 195 | 7 |

VM steps are the SQLite virtual-machine instruction count of the statement, a proxy for the rows visited; D1 `rows_read` was not measured here. Round trips per observation are unchanged (one statement per 97 distinct start times, so one for an ordinary observation).

`tests/discovery-held-slot-read.mjs` (core suite) proves: parity with the former statement for every looked-up slot, including adversarial rows (another run, another basis, another key on the same start time, another film for the same key, a slot nobody holds); the 100-bind bound with 250 start times (three statements); no round trip for no slots; the deployed plan (`programme_run_id=? AND start_ms=?`) against the former one (`programme_run_id=?` only); and a cost ratio of at least 100 in VM steps. The existing `discovery-slot-assignment`, `discovery-bundle-slot-scan`, `discovery-fence-collision` and catalog tests still pass unchanged.

## Not changed, with reason

- **The 120 whole-catalog reads (`discovery_admission`), priority one of the card: still unattributed.** The Worker logs read by the coordinator are aggregates and do not name the caller. By code, `readFilmsById` (batch metadata) is already bounded by id (`readAdmissionsById`) and is not a cause. The callers that read the whole catalog by design are: `loadPredictionDiagnosticSnapshot` (`src/prediction-diagnostics.js:15`, for `prediction_queue_overview`, `prediction_pending`, `prediction_film_diagnostics` and two admin recovery pages), `loadCatalogForQueue`, `predictionEventSnapshot`, `footerStatus`, `loadGenreCatalog`, `predictionBenchmarkStart`, the catalog-poster step (`src/discovery.js:481`) and the published-key read (`src/worker.js:812`). Of these only `prediction_queue_overview` needs the whole catalog for its coverage counts; `prediction_film_diagnostics` needs one film and `prediction_pending` needs the films of the outstanding ids (the `index_ahead_of_queue` check). A bounded reader for those two changes the shape of the snapshot (the `catalog` status and `policyExcludedPresentedFilm` filtering) and needs its own parity tests; a cache would need a proven invalidation on `discovery_authority.generation` (every admission writer moves it, see the fence batches) and a memory bound, and is a material choice. It is the next step, after the logs name the dominant caller.
- **`film_external_id(scheme, value)` and `published_epg_show(programme_run_id, basis, match_reason)` indexes.** Both need a migration. Production is at schema 33 and `0034_prediction_aux_authority.sql` is reserved for AIR-554 and not applied, so a sequential `0035` is not applicable now and 0034 is not touched. Options, none applied: (a) `0035` after 0034 under its own GO; (b) a separate, owner-approved, idempotent `CREATE INDEX IF NOT EXISTS` operation that leaves `schema_contract` unchanged, later folded into `0035` (idempotent, and independent of 0034, which touches only `prediction_aux_*` tables). Each needs an operator plan and an explicit owner GO before any production schema change.
- **`ledgerArchive`.** A `NOT EXISTS` form of the archive count was measured on a synthetic ledger (108,000 archive and 12,000 active rows): 1,452,010 VM steps against 1,464,015 for the current statement, the same covering-index plan. There is no code-only gain; the count walks the archive by definition. It is informational; reducing it needs a contract decision (a bounded or cached figure) and is left alone.
- **`sqlite_master` inventory.** Not cached: the inventory is the fail-closed guard against a partly installed domain, and no invalidation proof is made here.

## Rollback

Code-only: return to the previous commit. No data, marker, Task or schema is touched, so nothing else reverts.
