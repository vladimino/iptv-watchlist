# AIR-625: retirement of the unused 0001 identity tables, audit and offline contract, 27 Nov 2026

**Card:** [AIR-625](https://trello.com/c/ibrRmnwA). **Scope of this report:** a read-only audit, one read-only production observation and an offline migration with its tests. **Nothing was applied to production.** Applying `0054` is a separate owner GO (see "Apply plan").

## Authority

- Card scope: read-only audit of readers, writers, schema dependencies and retained evidence; cleanup migration only if no use is proven and the owner decides retention ([ADR 0213](../../adr/0213-film-identity-evidence-ledger.md), Accepted, "Unused tables"; [ADR 0215](../../adr/0215-identity-evidence-full-model.md) Table 6).
- Owner decisions in the executor session on 27 Nov 2026: (1) «да, делай live-проверку» (one read-only production observation, L0/L1); (2) disposition **(a)**: an additive migration that drops the three tables. The session transcript is the source; no ADR is added or changed.

## Tables

`identity_assertion`, `identity_rule_version`, `identity_application` from `migrations/0001_schema_v1.sql` (STRICT). `identity_application` references the other two by foreign key. `0001` is never edited.

## Audit: code (main `7679bfe`, offline)

- No reader or writer in `src/`, `scripts/`, `public/` or in any migration `0002`-`0050`.
- Only references outside `0001` and prose: `tests/fixtures/d1-schema-v1.sql` (one synthetic row each, applied on top of `0001` only by `tests/d1-schema.mjs`), `tests/prediction-repository.mjs` (asserts `identity_assertion` has 0 rows; its database is `0001` only), and documentation (`reference/data/d1-schema.md`, ADR 0213 and 0215). Those tests build from `0001` alone and are unaffected by `0054`.
- No dynamic access by name: every `sqlite_master` read in `src/` and `scripts/` names its own tables with `IN (...)` or a prefix (`published_epg%`, `identity_evidence_import_%`, `canonical_producer_outcome%`); none lists these three.
- The new evidence ledger (`0041` and later) has no foreign key to them and does not read them.

## Audit: production D1 `iptv` (read-only, 27 Nov 2026)

Two `SELECT`s through the Cloudflare D1 query tool against UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` (`served_by_primary` true, `rows_written` 0, `changed_db` false):

| Fact | Value |
| --- | --- |
| `COUNT(*)` of `identity_assertion` / `identity_rule_version` / `identity_application` | 0 / 0 / 0 |
| The three tables present in `sqlite_master` | 3 |
| Views or triggers whose SQL names any of them | 0 |
| `sqlite_master` objects whose SQL names any of them | exactly the three tables themselves (so no foreign key from any other table) |
| `schema_contract` version at the time | **38** |

Retained evidence: **none**; no row ever existed, so no historical record is lost. This matches the dated figure in ADR 0215 ("0, 0, 0"), now confirmed live.

**Consequence for the apply order.** Production is at schema 38 while the repository chain ends at 52 (0051 and 0052 on `main`, 0053 taken by a neighbouring change). `0054` follows a complete version 53 and refuses anything else, so it cannot be applied until `0039`-`0053` are applied by their own owner operations. The retirement therefore waits for that chain; it does not accelerate it.

## Offline migration

`migrations/0054_retire_legacy_identity_assertion_tables.sql`:

- Guard first (the `CHECK (id = 1)` trick): refuses unless `schema_contract` is one row at version 53, all three tables exist, all three are empty, no object outside the three tables names them in its SQL (a foreign key, view, trigger or index; `instr` over `sqlite_master`, no `LIKE`/`GLOB`). `pragma_foreign_key_list` is deliberately not used: the first draft used it and `tests/local-dev-smoke.mjs` (real workerd D1) refused it with `SQLITE_AUTH`, which production D1 would too.
- `DROP TABLE identity_application; DROP TABLE identity_assertion; DROP TABLE identity_rule_version;` (child first), then `schema_contract` to 54 (never down).

Tests (offline, scratch SQLite built from the real migrations): `tests/migration-0054-retire-identity-assertion.mjs` (chain 53 to 54, exactly three tables gone, ledger untouched, second apply refused, refusal with byte-identical dump for wrong predecessor, a row in each table, a view, a trigger, a foreign key of another table, and a missing table); `tests/migration-pattern-limit.mjs` scans the file for long patterns. Existing tests that pinned "the chain ends at 50" were moved to 54; the "a later migration keeps every earlier object" checks in `migration-0040-*` and `migration-0043-*` now exempt exactly these three retired tables. Results of the full `npm run test:all` and `npm run build` are recorded in the PR.

## Apply plan (not executed; separate owner GO)

1. **Preconditions:** production at schema 53 (`0039`-`0053` applied under their own GOs); merged `main` with green post-merge CI and Deploy to Cloudflare.
2. **Operator:** a reviewed single-purpose operator in the pattern of [AIR-594](air-594-0038-apply-2026-11-24.md) (pinned D1 UUID and SQL SHA-256, `--status` then `--apply`, one atomic batch, no retry, clock guard outside :55-:05 and the EPG publication window). Written and reviewed in the apply card, not here.
3. **Preflight (`--status`):** schema exactly 53; the three tables present with 0 rows each; no dependent object; decision `apply` only then. Any row or dependency means **stop and report; no drop**.
4. **Readback:** schema 54; the three tables absent; every other table's row count unchanged; independent `SELECT` against `sqlite_master`.
5. **Rollback:** none by code. The tables were empty, so the schema is restored by a new numbered file that re-creates the three `CREATE TABLE` statements of `0001` (the version never goes down). Record the D1 Time Travel bookmark before the apply. Code rollback does not revert D1.

## Limitations

Dated observation of 27 Nov 2026 only; re-verify at the apply preflight. Natural acceptance does not apply (no runtime path uses the tables).
