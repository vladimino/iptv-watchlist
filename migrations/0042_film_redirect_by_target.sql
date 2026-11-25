-- Schema v42: one ADDITIVE, non-unique lookup index on the Film redirect table by its target, `film_redirect_by_target` on film_redirect (to_film_id) (AIR-647). It
-- serves the owner-ancestry step of the dormant FilmAggregateV1 `display` section (src/film-aggregate.js, ADR 0216 decisions 5 and 7): the Films merged INTO a survivor,
-- found by `film_redirect WHERE to_film_id = ?`, bounded in depth and breadth. `from_id` is the primary key, so no existing index serves a lookup by target, and an
-- owner_review_entry link is a snapshot that a Film merge does not rewrite (ADR 0081): the owner values of a Film are those of every link in the redirect tree that ends
-- at it. The owner decided on 25 Nov 2026 (review of PR #1004, AIR-647): this index, delivered inside AIR-647, not a full-scan exception and not a separate card.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO, together with the other approved
-- pending migrations in the coordinated pre-activation window (cards AIR-603 M1 and AIR-648); it is not applied on its own and not applied again.
-- It follows a complete version 41 and refuses anything else before the index is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the
-- file (a second apply and a missing schema_contract row included). The version becomes 42 and never goes down. The number is the next free one on `main` at implementation
-- and is renumbered at merge if another migration lands first.
--
-- Nothing is written to any table: no redirect row, Film, claim, marker, authority, trigger or table is touched; 0001 is NOT changed. The only new object is one index; the
-- only row that changes is the single schema_contract row. A query returns the same rows with or without it.
-- Identifiers only. One LIKE pattern, far below the 50-byte D1 limit (see 0021).

-- The refusal inserts id 0, which CHECK (id = 1) always forbids: it aborts the file whether or not the singleton row exists. Accepted is exactly one schema_contract row at
-- version 41, the redirect table with the Film table it points at, the 0040 retirement-ledger index, the 0041 identity evidence ledger with its append-only triggers, the
-- shared no-downgrade trigger, and no object of the new name.
INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 41)
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film', 'film_redirect', 'film_identity_evidence', 'tmdb_retirement_decision')
 ) = 4
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_redirect' AND sql LIKE '%to_film_id%')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tmdb_retirement_decision_movie')
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'trigger' AND name IN (
   'film_identity_evidence_no_update', 'film_identity_evidence_no_delete', 'schema_contract_no_downgrade'
  )
 ) = 3
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'film_redirect_by_target')
);

CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id);

UPDATE schema_contract
SET version = 42,
    note = 'Schema v42: lookup index film_redirect_by_target on film_redirect (to_film_id), no data change. Version 42 follows a complete version 41.'
WHERE id = 1 AND version = 41;
