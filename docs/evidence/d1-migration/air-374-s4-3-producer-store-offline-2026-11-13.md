# AIR-374 S4-3: producer run store, offline verification (13 Nov 2026)

**Scope:** offline code and tests on the sqlite3-CLI D1 stand-in with the real migration chain (the tables, CHECKs and triggers of 0020). No production, R2, D1, Cloudflare, flag, Task, migration or marker access. Counts only.

**Delivered:** `src/canonical-producer-store.js` ([reference](../../reference/data/producer-run-store.md)), dormant and not bundled. It is the only writer of `canonical_producer_run` and `canonical_producer_unit_result`.

**Verified**

- Below `open` every writer returns `skipped` after exactly the marker read and writes nothing; `held` throws.
- Create, resume and replay by compare-and-set; parallel planners converge on one row; a replay clears the cursor and an active strike; a passed run with an applied claim is never replayed.
- The slice commit is one batch (cursor, results, counts); a lost compare-and-set, a refused row and the statement cap leave nothing partial; a replaced result of another digest is superseded in the same batch under the new pass.
- Strikes touch only their columns, count up while the identity is unchanged, a decrement and a count outside 1 to 2 are refused; the third strike goes through the slice commit; a systemic stop touches no strike.
- `applied_generation` is written only by the pass-complete commit; a second claim is refused.
- Dictionary versions: reuse on an equal digest, A, B, A gives three versions, the SQL guard refuses a gap and an equal-digest mint, a lost race re-reads.
- Due results (owner `unit`, ordered, limited) and the terminal settle (compare-and-set on state and attempts; a terminal row never reopens).
- A moved marker is `film_person_fence`; a missing table is `producer_store_missing`; static dormancy (no importer, not bundled, no network, timer, R2 or flag, writes only its two tables, rows never deleted).

**Results:** `tests/canonical-producer-store.mjs` passes; `tests/canonical-producer-store-mutation.mjs` kills 22 mutants. Four candidate mutants were dropped as equivalent because the SQL triggers or CHECKs of 0020 independently enforce the same rule (the marker fence on create and on slice writes, the compare-and-set of the replay, and the refusal to replay a passed run with a claim); the SQL tests of 0020 own those rules.

**Not done / limits:** the S4-4 driver, the D-C decision (slice size, `maxSlicesPerRun`, deadline, ceiling, lag SLA), the wiring in `epgSync` (S5-1), M2/M2b/M3 measurements. No D1 cost of a slice is measured. Nothing here authorizes a production operation.
