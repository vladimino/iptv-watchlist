# Predictions auxiliary-state cutover: run sheet (proposal for owner review, nothing is authorized by this page)

This is the minute-by-minute sequence of the bounded L3 operation behind [ADR 0194](../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) and [ADR 0196](../adr/0196-prediction-aux-admission-closed-state.md). It describes who does what, what is read before each step and when to stop. **Every row marked GO needs its own explicit owner decision; none is granted by this page.** The commands are those of [the operator](prediction-aux-state-cutover.md#the-owner-only-cutover-operator-dormant-nothing-here-is-authorized-by-merging-it) and [the export runbook](r2-snapshot-export.md). The live readback behind the gates is in the [readiness evidence](../evidence/prediction/air-554-cutover-readiness-readback-2026-11-22.md).

Actors: **Owner** (GO, flip release, extensions), **Coordinator** (the Predictions coordinator: Task registry snapshot, disable and enable, and nothing else), **Migration** (the executor: schema, marker, export, import, verification, integrity evidence). Times are minutes from **T0**, the moment the coordinator reads back four of four Tasks disabled. `T-` rows are done before the window and outside any freeze.

## Preconditions (a window is not scheduled until all hold)

| # | Gate | Evidence | Actor |
| --- | --- | --- | --- |
| P1 | One real read-only full-bucket export, rehearsed outside any freeze under its own GO (credential issued and revoked by the owner) | `--verify` is `consistent_fenced`; converter integrity; importer `report`, `digest`, `preflight`; real counts and bytes | Owner GO, Migration |
| P2 | Real import size fits one atomic batch (at most 2,000 statements, 8 MiB, 100 KiB per statement) | `status --converted` prints the derived SQL sizing | Migration |
| P3 | The measured duration of one cut (T_cut), of the import (T_imp) and of the verification (T_ver) satisfy `2 x T_cut + T_imp + T_ver <= 25 minutes` | P1 and a scratch rehearsal on the real export | Migration |
| P4 | No unresolved blocker: the whole-bucket cut either has a quiet interval proven for the competing writers or a reviewed prefix-scoped export exists (blocker B1 of the readiness page) | owner decision | Owner |
| P5 | D1 health gate accepted by the owner and met: no D1 overload or CPU-limit error in any run in the previous 60 minutes and the 15-minute analytics buckets inside the agreed envelope (blocker B2) | analytics read, Task registry | Migration, Coordinator |
| P6 | `0034` applied under its own GO, read back as schema 34, marker `r2` at generation 0, empty tables (may be done well before the window) | operator `--apply`, readback | Owner GO, Migration |
| P7 | Fresh natural-run baseline (no reconfiguration) and `prediction_step_timing` percentiles recorded | Worker log read, D1 | Migration |
| P8 | The owner has accepted the residual of ADR 0196 and the drain bound below | owner comment | Owner |

If any gate is open: **NO-GO, nothing is started, no Task is touched.** A freeze is never started in the hope that something will fit.

## The window

| T | Step | Actor | Read or check before | STOP if |
| --- | --- | --- | --- | --- |
| T-10 | Fresh readback: schema, marker, runner and writer leases, Workflow instances (queued, running, paused) of all six Workflows, the D1 gate, competing-writer activity | Migration | all of it | any gate of P1 to P8 changed, a Workflow instance is live, the D1 gate is not met |
| T-5 | Read-only before-image of the four Tasks (id, enabled, title, exact prompt, recurrence, time zone) and of Task `48` | Coordinator | registry | any difference from the last snapshot |
| T0 | **GO (owner): disable the four Tasks.** The coordinator disables only `is_enabled`, reads back four of four disabled and `48` unchanged, and sends `TASKS_PAUSED`. No prompt, schedule, batch size or TTL is touched | Owner GO, Coordinator | registry | readback is not four of four |
| T0 to T+4 | Terminal check: the last run of each Task is terminal, the D1 runner lease is not live (`expires_at` passed or 0), the writer lease is released, no Workflow instance is queued, running or paused. This is `WRITERS_DRAINED` candidate, **not** `TASKS_PAUSED` | Migration with Coordinator | leases, Workflows, registry | any live lease, run or instance: wait at most to T+10, then STOP |
| T+5 | **GO (owner): `r2` to `closed`.** `--close --generation G` with the generation the marker holds; read back marker `closed` at G+1. The Worker now refuses new legacy writes (`prediction_aux_closed`) | Owner GO, Migration | marker readback | the marker is not exactly `r2` at G, tables not empty |
| T+5 to T+10 | **Drain wait of five minutes** (the Workflow `prepare` step times out at four minutes; the bound for a Task-side HTTP call is unknown and is the residual accepted at P8). Nothing is written by anyone | Migration | none | an unexpected write appears in the D1 or R2 inventory |
| T+10 | First cut (`--capture-before`): export, `--verify`, converter. Quiet-writer check immediately before and after | Migration | competing writers (P4) | the cut is `no_go`; one retry at most while time allows |
| next | Import (`--import --generation N --converted ... --sql-sha256 ...`), then `--verify` | Migration | `status` readback of pins | any refusal other than a clean one; **from the first import statement `closed` to `r2` is no longer allowed** |
| T+30 | **Checkpoint.** If the second cut has not started, do not flip; stop new operations; Tasks stay disabled; ask the owner (extend or hold) | Migration, Owner | clock | always at T+30 |
| next | Second cut (`--capture-now`), at most 15 minutes before the flip | Migration | competing writers | `listing_changed`, a changed ETag or size, `capture_not_fresh` |
| next | Print the release (`--flip` without `--release`) and hand the exact string, the verified counts and the digests to the owner | Migration | operator output | the report is not the dataset imported |
| next | **GO (owner): flip release `closed` to `d1`.** `--flip --release ...`; one atomic batch (verification, counts guard, marker). Irreversible | Owner GO, Migration | release matches | any mismatch |
| after | Readback: marker `d1` at N+1, counts, outbox states, a reader parity check (Events, Results), no `prediction_aux_closed` in the Worker | Migration | D1 | any difference |
| after | Coordinator enables the four Tasks (`is_enabled:true` only), reads back four of four enabled and `48` disabled, no manual run; the next natural run is the first acceptance observation | Coordinator | registry | readback is not four of four |
| T+45 | Hard limit of the planned freeze. At T+45 without a verified flip, Tasks remain disabled and the owner decides; a timer never triggers a flip or an unfreeze | Owner | clock | always |

## Stop and recovery

- **Stop beats the timer.** The checkpoint is T+30; the planned maximum is T+45 from the disable readback. Silence of a Task, an equal listing or a green status is never proof of a drained writer.
- **Before the first import statement:** `--reopen` (`closed` to `r2` at G+2) is allowed only while the auxiliary tables are empty; after it the coordinator enables the four Tasks with only `is_enabled:true`. Marker and rows must be read back first.
- **After an import exists:** `--reopen` is refused by design and the flip is irreversible. If time runs out or marker and rows are unclear: the marker stays `closed`, the Tasks stay disabled, no blind rollback, no forced unfreeze, the owner decides. A restore from the snapshot is not designed here and would be its own approved operation.
- **Uncertain write:** the operator reports `write_uncertain`, reads back, never retries; the next step is read-only until the owner decides.
- **Code rollback** does not revert the marker or the data: a Worker older than the `closed` gate must not run against a marker at `closed` or `d1`.
- The residual of ADR 0196 stands: a PUT that passed its marker read and lands after the final capture is not seen by any listing and cannot be recalled.

## What this page does not authorize

The export, the credential, `0034`, the Task disable, the close, the import, the flip, any Workflow or flag change and any manual run each need their own owner decision. Merging this page records a proposal.
