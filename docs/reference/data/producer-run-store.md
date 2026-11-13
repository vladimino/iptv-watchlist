# Producer run store (S4-3, dormant)

**Status:** implemented as dormant offline code on 13 Nov 2026 ([ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md), Accepted as design). Nothing imports it, the Worker bundle does not carry it and nothing calls it; the pass driver (S4-4) and the `epgSync` wiring (S5-1) do not exist yet. Source of truth: `src/canonical-producer-store.js` and the tables of migration 0020 (`canonical_producer_run`, `canonical_producer_unit_result`, applied to the production D1 on 13 Nov 2026).

The store is the only module that writes those two tables. The decisions come from the pure module `src/canonical-producer-run.js` (S4-1); the store turns each into one fenced D1 batch.

| Function | Writes | Contract |
| --- | --- | --- |
| `openEpgRun` | insert-or-ignore, then a compare-and-set replay | Create or resume the run of one EPG event (`run_key` is the event id). The fingerprint equal to the stored one resumes after the stored cursor; a different one is one compare-and-set (`pass_no + 1`, new fingerprint, cursor and strike cleared). A run that already carries an applied claim is never replayed (`producer_cas_lost`). |
| `mintDictionaryRun` | one guarded insert, the previous run `superseded` in the same batch | Reuse the latest dictionary run on an equal snapshot digest, else mint `seq + 1`; A, B, A gives three versions. A lost race re-reads and decides again (at most twice). |
| `commitStrike` | the strike columns only | Compare-and-set on the run revision; the count is 1 or 2 (the third strike goes through `commitSlice`). |
| `commitSlice` | results, counts and cursor in ONE batch | Failure results as decided by `failureWrite` (insert, update or supersede), counts added, new cursor and strike columns, compare-and-set on the run revision. At most 48 statements. |
| `commitPassComplete` | `pass_state='passed'`, `applied_generation`, `open_at_completion` | The only writer of `applied_generation` (an EPG run: equal to its `source_generation`). |
| `commitStop` | `pass_state='stopped'`, `stopped_by` | Touches no strike column and no cursor. |
| `dueResults` | read only | Due live results with retry owner `unit` (open or recoverable), ordered by `next_attempt_at` then key, at most 50. |
| `settleResult` | one terminal update | Compare-and-set on state and attempts; a terminal row never reopens. |
| `readRun`, `latestDictionaryRun`, `liveResult` | read only | A missing table is `producer_store_missing`. |

**Dormancy and fences.** Every writer reads the marker once through `writerRoute`; below `open` it returns `{state:'skipped'}` after that read. Every batch starts with the marker fence (`d1`, `open`, the generation read), and the SQL triggers of migration 0020 refuse any write outside `open`, so at `prepared` both tables stay empty even against a code defect.

**Failure names.** A failed batch changes nothing and is named from the stored state: `film_person_fence` (the marker moved), `producer_cas_lost` (the run revision moved or the row is gone), `producer_slice_commit_failed` or `producer_strike_commit_failed` (the data itself was refused), `producer_store_missing`, `producer_marker_unreadable`, `producer_run_unreadable` or `producer_transport`.

**Limits.** No D1 budget for a slice, no slice size and no per-run ceiling is chosen here (decision D-C is open); the 48-statement cap is the only bound. The store does not classify errors, plan units or retry: that is the S4-4 driver and the S4-1 module.
