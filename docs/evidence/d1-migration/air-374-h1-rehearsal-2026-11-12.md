# AIR-374 H1: snapshot route, loader and verifier rehearsed offline on a synthetic schema-19 database

**Captured:** 2026-11-12 (UTC), offline, from `origin/main` at `79811ce`. Authority: [AIR-374](https://trello.com/c/ha7ais3w), open questions 8 and the "not verified" lines of the [H1 operator package](../../runbooks/film-person-h1-load-package.md). **Nothing was run against production.** No D1, R2, Cloudflare, connector, MCP, Trello or GitHub-comment call was made, no credential was read, no Scheduled Task was touched. Every row is synthetic; nothing was copied from production.

**Result in one sentence:** on the sqlite stand-in the route "connector `ddl` and `copy`, then `load`, then loader `plan`, then the H1 verifier on its real output" works **without** the lease and `resync` functions, the full H1 sequence (plan, verify, emit, apply, fresh copy, `verify`, `noop`) closes, and a failing statement in the middle of a batch rolls the whole batch back in every case rehearsed; the real D1 API's atomicity and the production connector are **not** provable offline and remain unverified.

## What was run

The rehearsal is `tests/film-person-h1-rehearsal.mjs` (about 4.7 s on its own on the authoring machine, one file in the shard plan). It builds:

- **Synthetic production:** a sqlite file from migrations `0001` to `0019` (`schema_contract` version 19, 39 copy-plan tables), the marker `prepared`/open/generation 1 over a baseline `verified` at a reference of the real shape (`cutover_accepted/v2:<64 hex>`), the same synthetic world as the loader test at the accepted counts (708 receipts, 401 view-index entries, 4 retirements, plus unverified and Film-less noise), and 250 extra `canonical_revision` rows so the copy resumes inside a table.
- **A fake connector:** `cloudflare.request` over that file. It accepts a request only if every statement is a `SELECT` with no write or DDL keyword; anything else throws. Only the `ddl` and `copy` function texts of the plan are executed (the `copy` text edited to a 60 kB result budget and 100-row pages, as the connector test does, so a copy takes three calls). `leaseAcquire`, `leaseRenew`, `leaseRelease`, `check` and `resync` are never executed, and the test refuses any other function name.

| Step | What ran | What was proven |
| --- | --- | --- |
| 1 | `film-person-connector-run.mjs plan` (CLI), `ddl`, `copy` through the fake connector, `load` (CLI for the DDL file and the first data file, API for the rest) | All 39 tables are copied and equal production row by row, rowids included. The copy log holds one `ddl` and the `data` files only (no `verify`, no `resync`). The two function texts hold no write statement; every request the stand-in received was a `SELECT`; the production tables and file are byte-identical after the copy and no lease row exists. A second load of the same file stops with `already_loaded`. |
| 2 | The loader's eight `STATE_STATEMENTS` on the copy and on production | The eight result sets are equal. All eight tables are in the copy plan. |
| 3 | Loader `plan --out` (CLI) on the copy | `ok`, `dry-run`, `complete`, not `noop`, 708 / 401 / 4 to load, 30 batches. The digest equals the digest of a plan from production directly and of a plan from a second, independently taken copy; the plan is deterministic. |
| 4 | `verify-plan` on the printed summary and `verify-private-plan` on `plan.private.json` (CLI), the first time on a real `buildLoadPlan` output through `plan --out` | The diagnostic pass never passes; the pinned pass passes (exit 0, no refusal); the private verdict contains no film id, title, lease id or SQL. The verdict refuses, on the real file: another lease id (`lease_id_mismatch`), no lease id (`lease_id_missing`), a window owner the plan does not carry (`window_owner_mismatch`), another digest (`plan_digest_mismatch`), another count (`class_planned_not_pinned`), another source digest (`source_sha_mismatch`), the private file passed as a summary (`private_plan_pasted`), and a statement edited inside the private plan (`batch_digest_mismatch`). |
| 5 | `sql --apply --plan-digest` (CLI), `verifyEmitted` | The 30 batches (1,113 rows) are emitted and accepted by `verify-emitted`; plan and `sql` write nothing. |
| 6 | The emitted batches applied to the synthetic production, one request per batch, with a lease row live | 708 / 401 / 4 rows stored; every batch response passes `verify-batch`; replaying a batch changes 0 rows per statement (and `verify-batch` calls that a STOP, as the runbook says); no table outside the three changed. |
| 7 | A fresh copy (same route), loader `verify`, loader `plan` | `verify` is ok (stored equals planned, `missing`, `different` and `unexpected` all 0), a receipt is written, a pinned generation that is not the copy's is refused (exit 2); `plan` reports `noop` with no batch; `verify-plan` refuses that plan (`plan_noop`); the old plan digest is refused by `sql` (`plan_digest_mismatch`). |

## Multi-statement atomicity on the stand-in

The connector request is modelled as **one transaction**: the batch's statements are sent as one script inside `BEGIN` and `COMMIT`, a failing statement ends the request, and the per-statement `changes` come from `changes()` (the shape `verify-batch` reads). This is the semantics the runbook assumes of D1. Each case runs on a fresh copy of the pre-load state and compares a digest of every table before and after.

| Case | Result |
| --- | --- |
| Guard false (lease id differs) in the first, a middle (17th) and the last statement of a 40-row batch | The request fails; **no row** of the batch is stored; every table equals its snapshot. |
| Primary-key conflict in the middle (20th statement; the row already stands with other content, as with a plan older than the state) | The request fails; the 20 earlier rows are rolled back; nothing else moved. |
| Marker generation moved, projector lease expired, baseline no longer `verified` before the batch | Every row fails its guard; nothing is written. |
| A failing batch (6th statement) after an acknowledged batch | Exactly the 40 rows of the acknowledged batch remain: a partial apply exists only between batches. |
| Contrast: the same mid-batch failure on an executor that commits each statement | 17 of 40 rows remain; 17 is not a multiple of the acknowledged batches, which is how the runbook says a non-transactional connector would show itself. |
| Mutation check of the harness | With the `BEGIN` and `COMMIT` removed from the model the mid-batch case fails (the assertion has teeth). |

## What is NOT provable offline

- That the **real D1 REST API** runs a multi-statement `sql` body in one transaction and rolls it back when one statement fails. The stand-in is sqlite, driven by a model written to the same assumption; it shows that the guards, the readback-before-resend rule, the count rule and `verify-batch` behave as designed **if** the API is atomic, and what each looks like if it is not. Open question 8 stays an owner decision: accept the risk, or commission an online rehearsal on a scratch D1 database (a Cloudflare write of its own).
- The real connector: its `execute` tool limits (60 s per call, result size), what a refused or timed-out call returns, how `rows_written`, `changes` and `success` appear for a multi-statement body, and behaviour under concurrent writers (the Discovery Workflow, the projector, the Predictions Task).
- The time of the snapshot, of the 30 batches and of the post-run copy on production (the only measurement is the 19-minute full copy of 11 Nov 2026); the production sizes of the three sources and of `film_external_id`.
- Any production value: counts, digests, lease or window rows, flags, the Predictions slot, whether the projector can merge or redirect a Film that carries a loaded row at `prepared`.
- Whether the operator's pasted results match the stand-in's shapes byte for byte (the connector test already runs the same function texts against the same shapes; a live call is the only proof).

## Finding: the loader does not check that the copy is complete

`copyReadBinding` in `scripts/film-person-prepared-loader.mjs` reads whatever tables the sqlite file holds and never consults the connector's `connector_copy_table` log, which records which tables are `done`. So an unfinished copy is read as it stands. The rehearsal observed (copy cut at connector-call boundaries, 15 kB result budget so that eleven calls make a copy):

- Cut inside `film_external_id` or before it: `plan` refuses (`count_mismatch`, exit 2): the pinned counts catch it.
- Post-load copy cut after `tmdb_retirement_decision` and before `film_rated_admission`: `plan` is **accepted** (exit 0, not a no-op, the other two classes read as empty, so it would plan the load again) and `verify` fails. No false all-clear arises: every in-row guard, `verify-batch` (`statement_no_change`) and the readback still stop a wrong action, so this is a missed refusal, not a hole.

Nothing here changed production-relevant code. **Proposed minimal fix** (not applied; it changes the loader, a reviewed tool with a 73-mutant check): in `copyReadBinding`, when the file holds `connector_copy_table`, refuse the read (`copy_incomplete`) unless the eight tables of `STATE_STATEMENTS` are all `done = 1`, with a test and a mutant. Until then the runbook tells the operator to check that the last `load` printed `done: true`. `tests/film-person-h1-rehearsal.mjs` asserts only what must hold whatever the reader does (refusal by count pins; never `noop`; never a passing readback), so a later fix does not break it.

## Smaller observations

- The verifier requires the baseline reference to have the real shape `cutover_accepted/v2:<64 hex>` (`expected_reference_invalid` otherwise); the loader test's placeholder reference is looser. The rehearsal uses the real shape.
- Editing a statement inside `plan.private.json` is caught as `batch_digest_mismatch` (the plan digest covers the batch digests, not the statements), not as `plan_tampered`; `plan_tampered` is raised when a plan field covered by the plan digest is edited.

## Reproduce

`node tests/film-person-h1-rehearsal.mjs` (needs the `sqlite3` CLI as the other stand-in tests do). It is registered in `scripts/run-tests.mjs` with a weight of 12, in the range of `film-person-prepared-loader.mjs` (13), whose measured time on the same machine is of the same order (4.3 s against 4.7 s).
