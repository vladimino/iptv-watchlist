# AIR-625: retirement of the unused 0001 identity tables, audit and offline contract, 27 Nov 2026

**Card:** [AIR-625](https://trello.com/c/ibrRmnwA). **Scope of this report:** a read-only audit, one read-only production observation and an offline migration with its tests. **Nothing was applied to production.** Applying `0054` is a separate owner GO (see "Apply plan").

## Authority

- Card scope: read-only audit of readers, writers, schema dependencies and retained evidence; cleanup migration only if no use is proven and the owner decides retention ([ADR 0213](../../adr/0213-film-identity-evidence-ledger.md), Accepted, "Unused tables"; [ADR 0215](../../adr/0215-identity-evidence-full-model.md) Table 6).
- Owner decisions given to the executor on 27 Nov 2026: (1) «да, делай live-проверку» (one read-only production observation, L0/L1); (2) disposition **(a)**: an additive migration that drops the three tables; (3) number `0054` after version 53. They are recorded once, durably, in the [Trello handoff comment on the card](https://trello.com/c/ibrRmnwA) and are linked from [PR #1052](https://github.com/vladimino/iptv-watchlist/pull/1052); they are not requested again. No ADR is added or changed.

## Tables

`identity_assertion`, `identity_rule_version`, `identity_application` from `migrations/0001_schema_v1.sql` (STRICT). `identity_application` references the other two by foreign key. `0001` is never edited.

## Audit: code (main `2b138282`, through migration `0053`, offline; re-run after the review of PR #1052)

- No reader or writer in `src/`, `scripts/`, `public/` or in any migration `0002`-`0053`.
- Only references outside `0001` and prose: `tests/fixtures/d1-schema-v1.sql` (one synthetic row each, applied on top of `0001` only by `tests/d1-schema.mjs`), the `RETIRED` exemption lists of `tests/migration-0040-*` and `tests/migration-0043-*`, `tests/prediction-repository.mjs` (asserts `identity_assertion` has 0 rows; its database is `0001` only), and documentation (`reference/data/d1-schema.md`, ADR 0213 and 0215). Those tests build from `0001` alone and are unaffected by `0054`.
- No dynamic access by name: every `sqlite_master` read in `src/` and `scripts/` names its own tables with `IN (...)` or a prefix (`published_epg%`, `identity_evidence_import_%`, `canonical_producer_outcome%`); none lists these three.
- The new evidence ledger (`0041` and later) has no foreign key to them and does not read them.

## Audit: production D1 `iptv` (read-only, 27 Nov 2026)

This is **executor evidence, not an independent production query**. Two `SELECT`s through the Cloudflare D1 query tool against UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` (`served_by_primary` true, `rows_written` 0, `changed_db` false):

| Fact | Value |
| --- | --- |
| `COUNT(*)` of `identity_assertion` / `identity_rule_version` / `identity_application` | 0 / 0 / 0 |
| The three tables present in `sqlite_master` | 3 |
| Views or triggers whose SQL names any of them | 0 |
| `sqlite_master` objects whose SQL names any of them | exactly the three tables themselves (so no foreign key from any other table) |
| `schema_contract` version at the time | **38** |

Retained evidence: **two observed zero counts**, the dated figure in ADR 0215 ("0, 0, 0") and the live read above. That supports "nothing is retained now"; it does **not** prove that no row ever existed (rows deleted earlier, or in a restored copy, were not examined). The apply preflight re-checks emptiness immediately before the drop and refuses on any row.

**Consequence for the apply order.** Production is at schema 38 while the repository chain ends at 52 (0051 and 0052 on `main`, 0053 taken by a neighbouring change). `0054` follows a complete version 53 and refuses anything else, so it cannot be applied until `0039`-`0053` are applied by their own owner operations. The retirement therefore waits for that chain; it does not accelerate it.

## Offline migration

`migrations/0054_retire_legacy_identity_assertion_tables.sql`:

- Guard first (the `CHECK (id = 1)` trick, after review of PR #1052): refuses unless `schema_contract` is one row at version 53, all three tables exist, all three are empty, no object names them in its SQL in **any letter case or quoting** (SQLite resolves identifiers case-insensitively; `instr(lower(sql), ...)` over `sqlite_master`, no `LIKE`/`GLOB`), and no explicit index or trigger is attached to them: only their own table definitions and the implicit autoindexes are expected, because `DROP TABLE` would silently remove any other attached object. `pragma_foreign_key_list` is deliberately not used: the first draft used it and `tests/local-dev-smoke.mjs` (real workerd D1) refused it with `SQLITE_AUTH`, which production D1 would too.
- `DROP TABLE identity_application; DROP TABLE identity_assertion; DROP TABLE identity_rule_version;` (child first), then `schema_contract` to 54 (never down).

Tests (offline, scratch SQLite built from the real migrations): `tests/migration-0054-retire-identity-assertion.mjs` (chain 53 to 54; exactly three tables gone; every other schema object and row, including a representative Film row, identical before and after; second apply refused; byte-identical refusal for a wrong predecessor, a row in **each** table seeded alone, a missing table, and ten dependent or attached objects: views, triggers, foreign keys, indexes, in lower, mixed, quoted and bracketed spellings); `tests/migration-pattern-limit.mjs` scans the file for long patterns. Existing tests that pinned "the chain ends at 50" were moved to 54; the "a later migration keeps every earlier object" checks in `migration-0040-*` and `migration-0043-*` now exempt exactly these three retired tables. Results of the full `npm run test:all` and `npm run build` are recorded in the PR.

## Apply plan (not executed; separate owner GO)

1. **Preconditions:** production at schema 53 (`0039`-`0053` applied under their own GOs); merged `main` with green post-merge CI and Deploy to Cloudflare.
2. **Operator and window:** reuse the already approved migration operator and quiet-window convention that applied the preceding migrations (pattern of [AIR-594](air-594-0038-apply-2026-11-24.md): pinned D1 UUID and SQL SHA-256, `--status` then `--apply`, one atomic batch, no retry). No separate card and no new clock restriction are introduced here; the owner's apply GO names the operator, the pins and the window.
3. **Preflight (`--status`):** schema exactly 53; the three tables present with 0 rows each; no dependent or attached object, **using the same case-insensitive semantics as the migration guard**; decision `apply` only then. Any row or dependency means **stop and report; no drop**.
4. **Readback:** schema 54; the three tables absent; every other table's row count unchanged; independent `SELECT` against `sqlite_master`.
5. **Rollback:** none by code. The tables were empty, so the schema is restored by a new numbered file that re-creates the three `CREATE TABLE` statements of `0001` (the version never goes down). Record the D1 Time Travel bookmark before the apply. Code rollback does not revert D1.

## Limitations

This PR is preparation only. The card cannot be marked Done until its apply criteria (separate apply GO and readback) are met, unless the owner changes the scope. Dated observation of 27 Nov 2026 only; re-verify at the apply preflight. Natural acceptance does not apply (no runtime path uses the tables).
