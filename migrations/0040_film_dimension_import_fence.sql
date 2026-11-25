-- Schema v40: the target-side fence of the offline Film importer (ADR 0218, Accepted, decision 7 stage 2; AIR-661).
-- One trigger: no `fingerprint` or `prediction` row is ever inserted into film_dimension again. Those states are derived from the prediction
-- domain (ADR 0218 decision 2, option A1), and no writer of the current code inserts them. An importer that predates stage 2 inserts both rows
-- for every Film in the same transaction that overwrites the title and deletes the identity and metadata rows, so on a target with this trigger
-- the whole Film unit of an old importer aborts and rolls back: the old importer is refused by the target itself, not trusted to check itself.
-- The current importer (src/offline-importer.js) reads this trigger before any mutation and refuses a target without it (import_target_unfenced).
-- Existing rows are untouched: UPDATE (a merge moving a row) and DELETE (a merge, a retirement, the later stage-6 retirement) stay allowed.
-- The trigger body is the same text as FILM_DIMENSION_IMPORT_FENCE_SQL in src/film-dimension-import-fence.js; a test pins the two together.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO.
-- It follows a complete version 39 and refuses anything else before it changes a table: the first statement inserts a second schema_contract row
-- and so aborts the file. The version becomes 40 and never goes down. Renumbered at merge if another migration lands first.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 39
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_write_receipt' AND sql LIKE '%operation_key%')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'film_dimension_import_fence')
);

CREATE TRIGGER film_dimension_import_fence
BEFORE INSERT ON film_dimension
FOR EACH ROW
WHEN NEW.dimension IN ('fingerprint', 'prediction')
BEGIN
 SELECT RAISE(ABORT, 'film_dimension_import_fence');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 40,
    note = 'Schema v40: film_dimension import fence (no new fingerprint or prediction row). Follows a complete version 39.'
WHERE id = 1 AND version = 39;
