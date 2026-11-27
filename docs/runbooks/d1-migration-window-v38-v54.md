# D1 migration window v38 to v47 (checkpoint A) and v54 (checkpoint B): one manifest, one operator, readback per file (the apply needs one exact owner L3 GO)

**Status:** prepared on 27 Nov 2026 under [AIR-603](https://trello.com/c/wc7pHJTB) (owner decision of 27 Nov 2026: AIR-603 is the single coordination point of the shared window, AIR-275 first, the global catalog second). Operator, manifest and tests are in the repository and **not applied**. The last dated observation of production was schema 38; it is **not** a fresh readback. The present schema, markers, leases and the deployed commit are read live (`--status`, authorized read-only sources), never from this page. **This runbook authorizes no production operation.** Time of the window: not assigned.

## What it is

One operator, `scripts/d1-migration-window-production.mjs` (offline tests: `tests/d1-migration-window-production.mjs`, `tests/migration-window-v47-runtime-compat.mjs`), for one ordered manifest of the 16 unchanged files `0039`-`0054`:

| Checkpoint | Files | Schema | Status |
| --- | --- | --- | --- |
| **A** (mandatory) | `0039`-`0047` | 38 to 47 | M1 finishes its results at v46 and the Catalog Enrichment schema (CM) at v47. AIR-607 then AIR-608, and AIR-609 then AIR-610 may continue after a confirmed A. They do **not** wait for AIR-648's internal route, the E2 writers' activation, historical imports, provenance enforce, Discovery scope, LID-only or v54. |
| **B** (additional) | `0048`-`0054` | 47 to 54 | Same window when ready and exactly approved. If B is not ready or not agreed, the window ends at the confirmed v47, and A is never delayed by B. |

Per-file contracts (what each file creates, its guard and its readback) stay in the file runbooks ([0040](retirement-movie-index-0040-apply.md), [0043](film-redirect-target-index-0043-apply.md), [0048](film-lid-admission-0048-apply.md), [0051 and 0052](lid-recheck-intent-0051-0052-apply.md), [0054 in the backfill runbook](d1-backfill.md)) and in the [D1 schema contract](../reference/data/d1-schema.md). This page is the procedure of the window.

## Manifest (pins baseline from `main` bd621cc29d020e7ef9ec8d75b396a2a36cd210b7)

Each file is pinned twice in the operator: Git blob and SHA-256 of its exact bytes. The operator refuses (`file_not_pinned`, before any statement) if either differs. The digest of the ordered manifest (one line `version file sha256 blob` per file) is **`2560570f3e4fca317cec2fdbf34eda5424492b646e4eb250e9f68577aac9ca8e`**; `--status` prints it, the operator's own SHA-256 and every file's pins. The executor recomputes all of them before the GO is requested; the GO names the printed values.

| v | File | From to | Git blob | Scope |
| --- | --- | --- | --- | --- |
| 39 | `0039_receipt_operation_key.sql` | 38 to 39 | `976a35b9ff936344bc1cd032f18e3cd9bddb51a7` | AIR-603 R1 (A) |
| 40 | `0040_tmdb_retirement_decision_movie_index.sql` | 39 to 40 | `9dfaa6886a6b518c5acc45550fb3c162a703737a` | AIR-603 / AIR-667 (A) |
| 41 | `0041_film_identity_evidence.sql` | 40 to 41 | `6fb13f8c081c907f31a8f56d3d7ff3285a8c4def` | AIR-603 E1 (A) |
| 42 | `0042_identity_evidence_writer_control.sql` | 41 to 42 | `8cc69ce68ea8a0241f274c6001d90a43553f00df` | AIR-638 ECM (A) |
| 43 | `0043_film_redirect_by_target.sql` | 42 to 43 | `82531769f25cc90441ea6e2b9e0189f9a7f8755e` | AIR-648 schema substep (A) |
| 44 | `0044_identity_evidence_reconstruction_import.sql` | 43 to 44 | `49e3390e4bbf18b213a629eb30fbe09c1b9e3f05` | AIR-640 ERM (A) |
| 45 | `0045_upstream_cooldown.sql` | 44 to 45 | `c232acbef86e5edcf37dd972878f181376edef02` | AIR-606 UC1 (A) |
| 46 | `0046_letterboxd_admission_authority.sql` | 45 to 46 | `7e39e3abb0b2ceb03e702f374982e7842e3f6968` | AIR-603 A1 (A) |
| 47 | `0047_catalog_enrichment.sql` | 46 to 47 | `3c570fad8745bf1028425b47370aa96cf43869e2` | AIR-606 C1 (A) |
| 48 | `0048_film_lid_admission.sql` | 47 to 48 | `2a3af828fdbd188b10a2bbbe062f016736e48e53` | AIR-676 (B) |
| 49 | `0049_film_metadata_provenance.sql` | 48 to 49 | `c46cd8d1c3d3ad18623950b50182053bd2c47e64` | AIR-632 part 1 (B) |
| 50 | `0050_discovery_enrichment_scope.sql` | 49 to 50 | `056e8b600ce034f58547b6e8a95add36577b3762` | AIR-685 schema substep (B) |
| 51 | `0051_lid_recheck_intent.sql` | 50 to 51 | `85c8efc9c8c679204cfd067b1386730541933793` | AIR-677 part 1 (B) |
| 52 | `0052_lid_tmdb_attach_writer.sql` | 51 to 52 | `9119adb9a29ad23912296822ff969f9217235c8a` | AIR-677 part 2 (B) |
| 53 | `0053_provenance_other_language.sql` | 52 to 53 | `551bb8649a6d1960cc9fd52ef9ab0f85150fa2db` | AIR-632 part 2 (B) |
| 54 | `0054_retire_legacy_identity_assertion_tables.sql` | 53 to 54 | `15443386be326a8d5bbb7ba7e154bb87adc245c7` | AIR-625 (B) |

The SHA-256 of each file is in the operator (`MANIFEST`) and in `--status`; it is not repeated here so that this page cannot drift from the code. The candidate is the baseline for review, not a permission to apply the current bytes blindly.

## Operator contract

```bash
node scripts/d1-migration-window-production.mjs --target iptv --status
```

```bash
node scripts/d1-migration-window-production.mjs --target iptv --apply --through 47 --start <ACTUAL_VERSION> --confirm apply --manifest-sha256 <FROM_STATUS> --operator-sha256 <FROM_STATUS>
```

Credentials: `D1_BACKFILL_ACCOUNT_ID` and `D1_BACKFILL_API_TOKEN` ([credentials](../../.claude/skills/iptv-credentials/SKILL.md)); behind the container proxy add `NODE_USE_ENV_PROXY=1`. The token is never printed.

- **Target.** The production account, database name `iptv` and UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` are pinned and each is checked against Cloudflare before any statement. Zero retries: no request is ever repeated automatically.
- **`--status`** is strictly read-only: pins, actual version, whether the chain up to that version is **verified** (every object of every file up to it present with the stored `CREATE` text of the files, folded so a later rebuild supersedes an earlier text; no object of a later file present; no staging table left), the plan to A and to B, the quiet-window facts below, the step guards and the decision per target. It lists what it **cannot** see (`unobservable`): Workflow instances, Scheduled Tasks, the EPG orchestration documents and the deployed Worker version. Those come from the authorized read-only sources of the preflight.
- **`--apply`** takes the target (`--through 47` or `54`), the **start pin** (the actual version it was approved from), the manifest digest and the operator digest. For each remaining file, in order: re-read the whole state, require the decision `apply`, then read the **real clock again at the write boundary** (refuses inside :55:00-:05:00 UTC, the hourly tick, and when the reads took longer than 60 s), send **one atomic D1 batch** of the statements extracted from the unchanged file, and read back. It stops at the target, at the first refusal and at any unknown outcome. It never splits a file, never sends two files in one transaction, never runs in parallel, never re-sends after an uncertain answer.
- **Recovery point.** The Time Travel bookmark is read before the first write and after the last, and is recorded. No whole-database restore without a separate GO.

### Atomicity is not assumed of the transport

Every file starts with a guard statement that aborts it unless the exact predecessor is present, and ends with the version update. A partial outcome is therefore always **visible**: the version has not moved while objects of the file exist. That state is `partial_schema`; the operator stops and a later `--status` or `--apply` refuses it. A refusal is classified `statement_failed` (nothing changed) only when the read-back equals the before-state in the version, the chain and every invariant; everything else (a lost response, a timeout, a transient status, a mismatch) is `write_uncertain`. The offline tests exercise a transaction that rolls back whole, a refusal before commit, a lost response after commit and a **non-atomic** transport that dies halfway. **Measured on 27 Nov 2026** against a one-off scratch D1 database created for the purpose (not the production database; deleted afterwards; the owner authorized its creation), through the same adapter the operator uses: a `{batch}` body of two valid inserts and one primary-key violation left **0 rows** (rolled back whole); the same through the `{sql}` multi-statement body left **0 rows**; a `{batch}` with `CREATE TABLE`, `CREATE TRIGGER ... BEGIN ... END`, an insert and a failing insert left **neither the table, the trigger nor any row**. So the REST batch is atomic for a statement error, including DDL and trigger bodies. This does **not** cover a lost connection or a timeout, whose outcome stays unknown: the guard, the version-last order and the readback remain the defence there, and the operator never retries.

### Readback after every file (all must hold)

Version equals the file's `to` with exactly one `schema_contract` row; the chain is verified (every stored `CREATE` text equals the file's; added columns present; staging tables `*_hold` and `*_v53` absent); every authority marker (`*_authority`), the identity evidence writer control and change history, the provenance control and the rebuilt provenance tables are **identical** to the before-state except for rows the file itself seeds; the row count and highest rowid of `film`, `film_metadata`, `film_external_id`, `canonical_write_receipt` and `film_identity_evidence` are unchanged. Seeds: `0046` inserts the Letterboxd admission marker as `r2` at generation 0, `0049` the provenance control as `off`; nothing else writes a row.

## Decisions

| Decision | Meaning |
| --- | --- |
| `apply` | The next file is due, the chain is verified, no observable activity, outside the tick window. |
| `already_at_target` / `target_behind` | Version equals or is above the target. |
| `start_mismatch` | The pinned start differs from the actual version (the approved plan no longer matches reality). |
| `partial_schema` | An object (or added column) of a later file exists, or a staging table was left: a file was started or the schema is mixed. Stop. |
| `predecessor_unverified` | An object of an earlier file is missing or has another body. Stop; never flip anything on it. |
| `schema_unexpected` / `schema_contract_unexpected` | Version outside 38-54, or the contract is not one integer row. |
| `producer_busy` / `prediction_busy` / `discovery_busy` / `discovery_transfer_loading` / `projector_busy` / `import_in_flight` | A live Producer chain (a `pending` chain, or an `active` lease within its boundary margin), an unexpired prediction lease, an unexpired Discovery lease, a loading Discovery transfer, a non-idle projector window, an open identity evidence import run. Wait for quiet; **no forced drain, reset, pause or Task change** without separate authorization. |
| `hourly_tick_window` | :55:00-:05:00 UTC inclusive, at the decision or at the write boundary. |
| `defer_0054` | `0054` only: a retired table has a row, is missing, or an object depends on or is attached to it. **Stop without undoing the verified predecessors**; the owner decides. |
| `file_not_pinned` / `manifest_sha256_mismatch` / `operator_sha256_mismatch` | Bytes or pins differ from the approved ones. |
| `statement_failed` / `write_uncertain` | See above. After `write_uncertain` run `--status` first; never re-run blindly. |

## Stop, checkpoint and resume

- **Checkpoint A.** `--through 47` stops after `0047` and reports the verified chain. B is a separate invocation (`--through 54 --start 47`), in the same window only with its own exact GO.
- **Stopped inside B** (for example after `0050`): read `--status`. If the chain is verified at the actual version, A is intact and the remaining suffix is listed (`plan.54.remaining`); resuming needs the **current** exact GO or an updated plan naming the new start pin. An unknown outcome or a damaged schema blocks any flip and any resume. Versions are never skipped and `schema_contract` is never rolled back.
- **0054 deferred** keeps `0039`-`0053` applied; it is a documented end of the window, not a failure.

## Per-file notes for the preflight and the readback

- **0047** installs inbox-only triggers on existing tables. Natural lawful anchor events may fill the inbox: do not require it to stay empty.
- **0049 and 0053**: provenance stays `off`, locks are inert; the 0053 rebuild keeps every row (the operator compares the rows of the provenance tables before and after).
- **0050** installs the staged-transfer triggers even before the scope is activated: the operator requires no loading Discovery transfer, and no pending Discovery admission work may be promoted while the scope row is absent (the read-only check is the activation preflight of the Discovery scope).
- **0052**: the existing writer control rows and the whole change history come back unchanged with the same `seq`; the new writer has no control row (absent means off); nothing is activated.
- **0054**: drops only the three empty tables, using the same condition as its own guard.
- **0043 and 0050** are schema substeps only: AIR-648 and AIR-685 are neither activated nor closed by this window.

## Production preflight and execution (separate owner L3 GO; none of it is done by this change)

1. Confirm the production D1 `iptv` UUID, the current deployed commit/version and that the approved bytes are the bytes on `main`.
2. Fresh authorized read-only `--status`, plus the unobservable facts from authorized sources: active Workflow/EPG/Producer/Discovery/Ratings/Watchlist/import state and leases, receipt state, no conflicting operation, no loading Discovery transfer.
3. Choose the nearest **actually quiet** window in Europe/Madrid from live work and schedules; no invented fixed duration.
4. Record the recovery bookmark (the operator does it) before the first high-impact change.
5. Execute; at each file boundary the operator rechecks quietness and the predecessor, applies the one pinned file and reads back.
6. After all approved steps: one independent read-only readback and a dated evidence page under `docs/evidence/d1-migration/` (per file: version, pins, timestamps, authorized writes, marker invariants, failures).

Not part of the window, each separately gated: C2 (AIR-607, own GO, active rated scope with its approved cutoff before A2, no other scope), A2 (AIR-608, drain/close, exact import and parity of the remaining mutable Letterboxd state, old-key checks, fenced `d1` flip, natural acceptance), E2 writers' activation, the AIR-648 internal route, provenance enforce, Discovery scope activation, LID-only and attach, historical imports, any backfill or authority flip. At v47 and at v54 the H1 rules stay empty, no LID-only kind is enabled, attach is off and the evidence writers stay off. After the readback the coordinator closes M1, ECM, ERM and CM by their own scope and real prerequisites with the one evidence, without re-applying.

## Checkpoint A against the bundled Worker (offline proof)

`tests/migration-window-v47-runtime-compat.mjs` builds v47 **with the operator** and runs the current Worker code on it: the Letterboxd admission authority reads `r2` at generation 0 and routes legacy; the lid-only table, the provenance control, the `0050` columns and every `0048`-`0054` object are absent; no identity writer control row exists; the Discovery scope activation preflight refuses (`schema_not_applied`); the Discovery ingest writes no enrichment signal; no scope row exists. This proves compatibility of the C2 and A2 paths with v47, not only that the full chain applies.

## Rollback and forward recovery

There is no schema rollback: `schema_contract.version` never goes down and a code revert does not undo a schema. After a failed or unclear execution read the state back with `--status` and decide with the owner; never re-run blindly. Whole-database restore (Time Travel) needs its own GO.
