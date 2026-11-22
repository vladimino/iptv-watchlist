# AIR-554: the owner-only cutover operator, offline evidence

22 November 2026 (Europe/Madrid) · [AIR-554](https://trello.com/c/UrS1gflv) Phase A, third line of the owner-approved preparation · implements the steps of [ADR 0196](../../adr/0196-prediction-aux-admission-closed-state.md) that write. Offline only: a sqlite D1 stand-in over the real migration chain (scratch database at schema 33), the four families written by the **real** Worker on its legacy R2 path, SQL printed by the **real** importer. **No production database was opened, no credential, no R2 read, no Task, no model.**

## What was built

`scripts/prediction-aux-cutover-production.mjs`, modeled on the verified 0033 operator: `status` (read-only default), `--apply` (the `0034` schema in one atomic batch), `--close`, `--import`, `--verify`, `--flip`, `--reopen`. Every write needs `--target iptv --confirm <command>`; the database identity is pinned; each command has its own pins (migration hash, closure generation, SQL hash, report, captures, release); an unknown outcome is read back and reported `write_uncertain` and never retried; only the aux tables are touched (every statement of a file must be one of the importer's exact forms, and only the exact guard may name the marker; the other domains are compared by mode and cutover, never by counters). The command table, the release and the limits are in the [runbook](../../runbooks/prediction-aux-state-cutover.md#the-owner-only-cutover-operator-dormant-nothing-here-is-authorized-by-merging-it).

## Tests (`tests/prediction-aux-cutover-production.mjs`, core)

| Claim | Result |
| --- | --- |
| Arguments: status needs no target; each write needs target, confirm, its pins, a valid generation and no foreign option; no other command exists | pass |
| `status` is byte-for-byte read-only, reports the next decision of each step and the sizing of an import file against the measured batch limits | pass |
| `apply`: pinned by the migration hash; refused when the prediction domain is not d1, on a partial schema, on a repeat; one atomic batch with an independent readback (schema 34, marker r2 at 0, empty tables, no mode changed); a proven statement failure is `statement_failed` (state unchanged), a lost reply is `write_uncertain` (one attempt, `retry: false`), a readback that disagrees is `write_uncertain` | pass |
| `close` pinned to the marker's generation; `import` / `verify` / `flip` refused while the marker is `r2`; the Worker's reader sees `closed` | pass |
| `import`: SQL hash pin, generation pin, **a plan of another closure refuses**, a file over the batch limits is refused with the numbers and nothing is sent, a repeat refuses (`tables_not_empty`) | pass |
| **SQL shapes (review of PR 897, P1):** every statement must be one of the importer's exact forms (string literals masked first); the first statement of an import is EXACTLY the importer's guard. A verify file that activates (`UPDATE prediction_aux_authority SET mode='d1' …`), the same appended to a good verify or import file, an insert into the marker table, any other `UPDATE`/`DELETE`/`DROP`, an `INSERT … SELECT`, an insert into the counter table, an empty file: all refused with **no byte of the database changed**; a document whose text merely names the marker is data and still imports and leaves the marker alone | pass |
| `verify` passes on the clean import | pass |
| **Flip carries the verification (review, P1):** the importer's exact verification of the whole dataset runs INSIDE the flip batch, must assert exactly the totals of the report, and a hash of it is a checksum only. A **same-count, same-state corruption** of a source piece and of an outbox event aborts the flip as a proven statement error with the marker still closed; a missing verification, a verification of another report, a fabricated zero-count report, an empty database and an honest empty-plan verification with a non-empty export are all refused | pass |
| **Provenance of the two listings (review, P2):** the captures are real converter outputs of the real exporter against the fake bucket; refused when the same cut is passed twice, when the later one is stale, from another bucket, not a consistent fenced cut, not bound to its own report (edited identity), or a malformed capture; the report must be the export's (`report_not_from_export`) | pass |
| **A late write for real (review, P2):** a legacy PUT lands in the bucket after the close (same key, same length, other bytes): the next fresh cut has another ETag and the flip is refused (`listing_changed`, by ETag with key set and size unchanged); the object restored to its exported bytes is a new ETag and the cut taken at the close is refused as stale; only two clean captures can flip | pass |
| `flip`: without `--release` it prints the exact release and writes nothing; a wrong release refuses; the release binds the final capture, the generation and the verification SQL; the flip is committed with `activated_at` and `verifiedInBatch` | pass |
| After `flip` the marker is `d1` at N+1; every command is refused (`marker_is_d1`); the schema refuses the marker moving back; no other domain changed mode or cutover | pass |
| `reopen` before an import returns to `r2` at N+1 and the later closure's plan is the only one that imports; after an import it refuses | pass |
| The operator's code names no R2, no Task, no flag, no child process and prepares no row write itself | pass |

Mutation checks (each makes the test fail, restoring passes): no listing comparison; no release check; no SQL generation guard; reopen with rows; no generation pin; no counts comparison; a release not bound to the listing; the import and verify shape checks switched off (**the activation bypass of the review then really activates the marker**); the verification left out of the flip batch; the verification not bound to the report; the report not bound to the export; captures not distinct, not fresh, not bound to their own report, or from another source; a release not bound to the verification.

## Import size (measured on the synthetic data, extrapolated only for production)

One run: **7 statements, 16,009 bytes** (largest statement 11,730 bytes) against the measured D1 batch limits of the adapter (2,000 statements, 8 MiB, 100 KiB per statement). A production history of up to 489 `batch_v2` runs with 39 KB manifests is, by extrapolation only, thousands of statements and tens of MB and likely over those limits: **this is an estimate, not a measurement**; the real number needs the real private export. If it does not fit, the operator refuses with the numbers (`import_too_large`) and a resumable import is a separate reviewed contract, not a silent chunking.

## Not covered, on purpose

A real production export and the scratch rehearsal on it (needs the owner's separate authorization); the real import's size; any production apply, close, import, verify, flip or reopen; the drain wait; the performance baseline. Nothing here authorizes a production operation.

## Review round 2 (22 Nov 2026, head `47a9e88`; docs `5e2d397`)

Offline scratch only; no production data, credential, migration, marker, flag or Task.

- The operator accepts no SQL file and no report file. `--converted <dir>` is one converter output directory; its `tree/` objects are re-hashed against its own `identity.json` (`tree_not_from_capture`), and the import SQL (`planSql`), the canonical row-level verification (`planVerifySql`) and the report (`planReport`) are derived from the rebuilt plan. A totals-only text carried next to the tree is never executed; a same-count corruption of a source piece or an outbox event aborts the flip with the marker still `closed`.
- The paused legacy write is exercised on the real Worker over the shared scratch database (`tests/prediction-aux-cutover-production.mjs`, section 4d): a `batch/hold` paused at its R2 PUT after the marker read, the close and the cut while it is in flight, the resumed PUT, import and verify, and the final cut refuses the flip as `listing_changed` for `enrichment/batch-stage.json`. A PUT landing after the final capture cannot be seen by an inventory (ADR 0196 residual, unchanged).
- Mutation checks re-run on this head, each fails the test: verification left out of the flip batch; tree bytes not re-hashed; tree file set not compared.
- Test runtime ~10 s; the test now stops its scratch bucket and removes its scratch directories at exit.
- Limits unchanged: a fully fabricated, internally consistent converted directory is not detectable offline; real import size is unmeasured.
