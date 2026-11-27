-- Schema v54: retirement of the three unused 0001 identity tables (AIR-625; numbers 0051-0053 are taken by neighbouring changes; ADR 0213 "Unused tables", ADR 0215 Table 6). Additive in the sense that 0001 is never rewritten; this file only drops what 0001 created.
--  `identity_application`, `identity_assertion` and `identity_rule_version` have no runtime reader or writer (code audit and a live read of production on 27 Nov 2026: 0, 0, 0 rows, no view, trigger or foreign key
--  from any other table). The film identity evidence ledger (0041 and later) is the identity evidence store; nothing here is its predecessor and no historical record is lost because no row ever existed.
-- It follows a complete version 53 and refuses anything else before an object is dropped: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file. The refusal also covers any row in the
-- three tables, a missing table (a partial or repeated apply), and any object outside the three tables whose SQL names one of them (a foreign key of another table, a view, a trigger or an index). Nothing is dropped in that case.
-- The version becomes 54 and never goes down. NOT applied by a deploy: applying it is a separate owner GO with its own preflight and readback (docs/runbooks/d1-backfill.md).
-- Rollback: the tables were empty, so recreating the three CREATE TABLE statements of 0001 restores the schema exactly; the version never goes down, so a restore is a new numbered file, not a downgrade.
-- If another change takes number 54 first, this file is renumbered at merge. Identifiers only; no LIKE or GLOB pattern and no pragma table function (D1 refuses `pragma_foreign_key_list` with SQLITE_AUTH; the dependency check reads `sqlite_master` text with `instr`) (tests/migration-pattern-limit.mjs scans this file).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 53)
 AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('identity_assertion', 'identity_rule_version', 'identity_application')) = 3
 AND (SELECT COUNT(*) FROM identity_assertion) = 0
 AND (SELECT COUNT(*) FROM identity_rule_version) = 0
 AND (SELECT COUNT(*) FROM identity_application) = 0
 AND NOT EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE tbl_name NOT IN ('identity_assertion', 'identity_rule_version', 'identity_application')
    AND (instr(sql, 'identity_assertion') > 0 OR instr(sql, 'identity_rule_version') > 0 OR instr(sql, 'identity_application') > 0)
 )
);

DROP TABLE identity_application;
DROP TABLE identity_assertion;
DROP TABLE identity_rule_version;

UPDATE schema_contract
SET version = 54,
    note = 'Schema v54: the three unused 0001 identity tables (identity_assertion, identity_rule_version, identity_application) are retired; they were empty. Version 54 follows a complete version 53.'
WHERE id = 1 AND version = 53;
