# AIR-374 M2b step 0: offline tooling of the EPG producer dry run on a local copy (13 Nov 2026)

**Captured:** 2026-11-13 (UTC), offline, on the sqlite3-CLI D1 stand-in. **Nothing was run against production.** No D1, R2, Cloudflare, connector or credential was used, no flag, Task or marker was touched. Every row in the tests is synthetic.

**Scope:** the owner's chat GO of 13 Nov 2026 covered the offline step 0 only. Delivered: [`scripts/epg-producer-m2b.mjs`](../../../scripts/epg-producer-m2b.mjs) (`emit-sql`, `load-copy`, `verify-copy`, `run`), the procedure [runbook](../../runbooks/film-person-m2b-dry-run-copy.md), the tests `tests/epg-producer-m2b.mjs` and `tests/epg-producer-m2b-mutation.mjs`.

**Results:** `tests/epg-producer-m2b.mjs` passes; `tests/epg-producer-m2b-mutation.mjs` kills 26 mutants. The tests prove: the emitted statements are read-only keyset pages over exactly the migrated columns; the copy plan covers every table the M2 harness really reads (a new read fails the test until the plan names it); pages pasted from a synthetic "production" file load into a row-for-row identical copy and the harness gives the same report on the copy as on the original; every refusal of the results file and of the copy; the copy is byte-identical after a run; the report holds counts and timings only; the script imports no apply function or writer.

**Limits:** the inputs are derived from stored rows (observed Film units are no-op by construction); `person_state` units are not built; the real `changedShare` is not measured; no production copy exists. The caps are proposals for a future owner GO and the platform price of D1 rows read is not verified.

**Next:** an owner decision on the copy scope (the full planned tables or only the observed Films and their Persons) and a separate, exactly scoped read-only GO for the copy. Nothing here authorizes either.
