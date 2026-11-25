-- Schema v40: one ADDITIVE, non-unique lookup index on the TMDB retirement ledger by movie id (AIR-667). It serves the retirement column of the dormant
-- Film identity snapshot IDENTITY_SNAPSHOT_SQL (src/film-aggregate-resolver.js, ADR 0216 decision 7): `tmdb_retirement_decision WHERE movie_id IN (...)`.
-- The owner chose option A on 25 Nov 2026 in the review of PR #1000: an index, not a full-scan exception. The ledger has no Film foreign key and a decision
-- retires a movie id whatever Film it names, so the existing tmdb_retirement_decision_film (film_id, seq) cannot serve the lookup; this index is by movie_id.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO (card AIR-667).
-- It follows a complete version 39 and refuses anything else before the index is created: the first statement inserts a second schema_contract row and so
-- aborts the file (a second apply included). The version becomes 40 and never goes down. The number is the next free one on `main` at implementation and is
-- renumbered at merge if another migration lands first.
--
-- Nothing is written to any table: no ledger row, marker, authority, trigger or table is touched; 0016 is NOT changed. The only new object is one index; the
-- only row that changes is the single schema_contract row. A query returns the same rows with or without it.
-- Identifiers only. No LIKE or GLOB pattern (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 39
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('tmdb_retirement_decision', 'canonical_write_receipt')
 ) = 2
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'index' AND name IN ('tmdb_retirement_decision_film', 'tmdb_retirement_decision_tv', 'canonical_write_receipt_operation_history')
 ) = 3
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'tmdb_retirement_decision_movie')
);

CREATE INDEX tmdb_retirement_decision_movie ON tmdb_retirement_decision (movie_id);

UPDATE schema_contract
SET version = 40,
    note = 'Schema v40: lookup index tmdb_retirement_decision_movie on tmdb_retirement_decision (movie_id), no data change. Version 40 follows a complete version 39.'
WHERE id = 1 AND version = 39;
