# AIR-554: the owner-only cutover operator, offline evidence

22 November 2026 (Europe/Madrid) · [AIR-554](https://trello.com/c/UrS1gflv) Phase A, third line of the owner-approved preparation · implements the steps of [ADR 0196](../../adr/0196-prediction-aux-admission-closed-state.md) that write. Offline only: a sqlite D1 stand-in over the real migration chain (scratch database at schema 33), the four families written by the **real** Worker on its legacy R2 path, SQL printed by the **real** importer. **No production database was opened, no credential, no R2 read, no Task, no model.**

## What was built

`scripts/prediction-aux-cutover-production.mjs`, modeled on the verified 0033 operator: `status` (read-only default), `--apply` (the `0034` schema in one atomic batch), `--close`, `--import`, `--verify`, `--flip`, `--reopen`. Every write needs `--target iptv --confirm <command>`; the database identity is pinned; each command has its own pins (migration hash, closure generation, SQL hash with the first statement pinned to the generation, report, listing identity, release); an unknown outcome is read back and reported `write_uncertain` and never retried; only the aux tables are touched (statements are whitelisted by target table; the other domains are compared by mode and cutover, never by counters). The command table, the release and the limits are in the [runbook](../../runbooks/prediction-aux-state-cutover.md#the-owner-only-cutover-operator-dormant-nothing-here-is-authorized-by-merging-it).

## Tests (`tests/prediction-aux-cutover-production.mjs`, core)

| Claim | Result |
| --- | --- |
| Arguments: status needs no target; each write needs target, confirm, its pins, a valid generation and no foreign option; no other command exists | pass |
| `status` is byte-for-byte read-only, reports the next decision of each step and the sizing of an import file against the measured batch limits | pass |
| `apply`: pinned by the migration hash; refused when the prediction domain is not d1, on a partial schema, on a repeat; one atomic batch with an independent readback (schema 34, marker r2 at 0, empty tables, no mode changed); a proven statement failure is `statement_failed` (state unchanged), a lost reply is `write_uncertain` (one attempt, `retry: false`), a readback that disagrees is `write_uncertain` | pass |
| `close` pinned to the marker's generation; `import` / `verify` / `flip` refused while the marker is `r2`; the Worker's reader sees `closed` | pass |
| `import`: SQL hash pin, generation pin, **a plan of another closure refuses**, a statement outside the aux tables refuses, a file over the batch limits is refused with the numbers and nothing is sent, a repeat refuses (`tables_not_empty`) | pass |
| `verify` passes on the clean import; a changed imported row fails it as a proven statement error with nothing retried | pass |
| `flip`: counts and outbox states equal the report; **a rewritten object (same key, other ETag), a removed or an added object refuses** (`listing_changed`); a malformed listing or report refuses; without `--release` it prints the exact release and writes nothing; a wrong release refuses; the release binds the generation and the listing identity | pass |
| After `flip` the marker is `d1` at N+1 with `activated_at`; every command is refused (`marker_is_d1`); the schema refuses the marker moving back; no other domain changed mode or cutover | pass |
| `reopen` before an import returns to `r2` at N+1 and the later closure's plan is the only one that imports; after an import it refuses | pass |
| The operator's code names no R2, no Task, no flag, no child process and writes no row itself | pass |

Mutation checks (each makes the test fail, restoring passes): no listing comparison; no release check; no SQL generation guard; reopen with rows; no table whitelist; no generation pin; no counts comparison; a release not bound to the listing.

## Import size (measured on the synthetic data, extrapolated only for production)

One run: **7 statements, 16,009 bytes** (largest statement 11,730 bytes) against the measured D1 batch limits of the adapter (2,000 statements, 8 MiB, 100 KiB per statement). A production history of up to 489 `batch_v2` runs with 39 KB manifests is, by extrapolation only, thousands of statements and tens of MB and likely over those limits: **this is an estimate, not a measurement**; the real number needs the real private export. If it does not fit, the operator refuses with the numbers (`import_too_large`) and a resumable import is a separate reviewed contract, not a silent chunking.

## Not covered, on purpose

A real production export and the scratch rehearsal on it (needs the owner's separate authorization); the real import's size; any production apply, close, import, verify, flip or reopen; the drain wait; the performance baseline. Nothing here authorizes a production operation.
