-- Schema v55: one ADDITIVE, non-unique lookup index on the Ratings projection by its fact key, `ratings_view_fact_key` on ratings_view (fact_key) (AIR-653). It serves the
-- projection corroboration of the Letterboxd claim planner (src/canonical-letterboxd-claim.js, ADR 0184), `SELECT alias_id,fact_key FROM ratings_view WHERE alias_id=? OR
-- alias_id=? OR fact_key=?`, and the same predicate of the bounded private capture (AIR-652). `alias_id` is the primary key, so only that term of the OR was index-served;
-- `fact_key` has no index, which made the whole statement a SCAN of the table whose size is not capped (AIR-627 saw such a predicate time out). With this index every term
-- of the OR is index-served and SQLite answers it by a MULTI-INDEX OR.
-- The owner decided on 28 Nov 2026 (card AIR-653): this index, delivered inside AIR-653, not a new card and not a new dependency; the planner and its limits are NOT changed.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO with its own L3 plan, preflight
-- and readback (docs/runbooks/ratings-view-fact-key-index-0055-apply.md); it is not applied on its own initiative and not applied again.
-- It follows a complete version 54 and refuses anything else before the index is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the
-- file (a second apply and a missing schema_contract row included). The version becomes 55 and never goes down.
--
-- Nothing is written to any table: no rating, alias, fact, claim, marker, authority, trigger or table is touched; 0010 is NOT changed. The only new object is one index; the
-- only row that changes is the single schema_contract row. A query returns the same rows with or without it. The index adds one entry per ratings_view row to the database
-- (the projection is rebuilt by the Ratings writer, which then also maintains the entry; D1 counts index writes in rows_written).
-- Rollback: the version never goes down, so removing the index is a new numbered file with `DROP INDEX ratings_view_fact_key` and its own owner GO, not a downgrade.
-- If another change takes number 55 first, this file is renumbered at merge. Identifiers only; one LIKE pattern, far below the 50-byte D1 limit (see 0021).

-- The refusal inserts id 0, which CHECK (id = 1) always forbids: it aborts the file whether or not the singleton row exists. Accepted is exactly one schema_contract row at
-- version 54, the 0010 projection with its `fact_key` column and no explicit index on it (only the implicit primary-key autoindex), the 0040 retirement-ledger index, the
-- 0054 retirement of the three legacy identity tables (they are absent), the shared no-downgrade trigger, and no object of the new name. These are PRESENCE checks, not a claim
-- of full schema integrity, and 0054 itself is not touched.
INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 54)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ratings_view' AND sql LIKE '%fact_key%')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ratings_view' AND sql IS NOT NULL)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tmdb_retirement_decision_movie')
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('identity_application', 'identity_assertion', 'identity_rule_version')
 ) = 0
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'ratings_view_fact_key')
);

CREATE INDEX ratings_view_fact_key ON ratings_view (fact_key);

UPDATE schema_contract
SET version = 55,
    note = 'Schema v55: lookup index ratings_view_fact_key on ratings_view (fact_key), no data change. Version 55 follows a complete version 54.'
WHERE id = 1 AND version = 54;
