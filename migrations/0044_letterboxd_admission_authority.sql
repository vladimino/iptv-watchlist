-- Schema v44: the Letterboxd admission authority marker `letterboxd_admission_authority` (AIR-602, card A1 of the ADR 0207 delivery graph; ADR 0207 Accepted, decision 1; ADR 0217 Accepted).
-- ONE additive table, its single row and three triggers. No data migration: the 714 existing admissions are already the canonical D1 rows, and the R2 object is only frozen at the flip.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it is card M1 (AIR-603), a separate production GO, together with the other approved pending
-- migrations in the coordinated pre-activation window. The inserted marker is mode `r2`, generation 0: the delivered code keeps running the legacy R2 coordination exactly as before, writes no
-- new payload field, no `d1:` marker and no new receipt shape. Applying this file copies nothing and switches nothing. The only rows it writes are the marker and the schema_contract version.
-- It follows a complete version 43 and refuses anything else before the table is created: the first statement inserts a row that CHECK (id = 1) forbids (id 0) and so aborts the file (a second apply,
-- a missing schema_contract row and a wrong version included). The version becomes 44 and never goes down.
--
-- The marker has three modes (ADR 0207 decision 1, the pattern of ADR 0194 and ADR 0196):
--   r2      the delivered code behaves exactly as today. Every writer uses the R2 step.
--   closed  every admission writer refuses BEFORE its first effect (a pre-activation state; nothing is admitted). Reads are unchanged. `closed -> r2` (the reopen) is allowed.
--   d1      the new path of ADR 0207 decisions 2 to 6. Terminal: a trigger refuses `d1 -> r2`, `d1 -> closed`, deleting the row and a lower generation.
-- The chain is `r2 -> closed -> d1` and `closed -> r2`. `d1` is reachable ONLY from `closed`, so an activation cannot skip the admission close, and every change of mode raises the generation. The trigger
-- is the enforcement, not only the state names: a writer that never read the marker cannot be told apart from one that did, so the database itself refuses an illegal transition.
-- The data tables carry no marker trigger: every writer asserts the marker (mode and generation) inside its own fenced batch (the legacy admission batch asserts `r2` or "migration absent", the new-path
-- batches assert `d1` at the generation they read), and the Worker guards each R2 PUT or delete of letterboxd/admissions/verified-films.json against a FRESH read of the marker.
-- Identifiers, short lowercase codes, ISO-8601 UTC times only. D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every CHECK keeps its patterns short (see 0021).

-- Accepted is exactly one schema_contract row at version 43 AND the objects this file depends on, by name (PRESENCE checks, not a claim of full schema integrity): the Film admission table the marker
-- guards, the receipt table with the 0039 `operation_key` column, the 0041 identity evidence ledger, the Film/Person fence table, the 0043 redirect index, the shared no-downgrade trigger, and no object of
-- the new name.
INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 43)
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_rated_admission', 'canonical_write_receipt', 'film_identity_evidence', 'film_person_cas', 'film_redirect')
 ) = 5
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_write_receipt' AND sql LIKE '%operation_key%')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'film_redirect_by_target')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'letterboxd_admission_authority%')
);

CREATE TABLE letterboxd_admission_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'closed', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 -- The time of the `closed -> d1` flip (the irreversibility boundary). NULL in every other mode.
 activated_at TEXT CHECK (activated_at IS NULL OR (length(activated_at) BETWEEN 20 AND 32 AND substr(activated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(activated_at, 11, 1) = 'T' AND substr(activated_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(activated_at, -1) = 'Z' AND activated_at NOT GLOB '*[^0-9TZ:.-]*')),
 CHECK ((mode = 'd1') = (activated_at IS NOT NULL)),
 -- `r2` is generation 0 only until its first close: a row that never changed is generation 0, and any change of mode raises it (the chain trigger), so `r2` after a reopen is generation >= 2.
 CHECK (mode <> 'closed' OR generation >= 1)
) STRICT;

-- d1 is terminal, and the generation never goes down.
CREATE TRIGGER letterboxd_admission_authority_one_way
BEFORE UPDATE ON letterboxd_admission_authority
FOR EACH ROW
WHEN (OLD.mode = 'd1' AND NEW.mode <> 'd1') OR NEW.generation < OLD.generation
BEGIN
 SELECT RAISE(ABORT, 'letterboxd_admission_authority_one_way');
END;

-- The chain is r2 -> closed -> d1, and closed -> r2 (the reopen, only before an activation). `d1` is reachable ONLY from `closed`; every change of mode raises the generation. A row that keeps its mode
-- may not move its generation sideways either: only an actual transition raises it.
CREATE TRIGGER letterboxd_admission_authority_chain
BEFORE UPDATE ON letterboxd_admission_authority
FOR EACH ROW
WHEN (NEW.mode <> OLD.mode
  AND (NOT ((OLD.mode = 'r2' AND NEW.mode = 'closed') OR (OLD.mode = 'closed' AND NEW.mode IN ('r2', 'd1'))) OR NEW.generation <= OLD.generation))
 OR (NEW.mode = OLD.mode AND NEW.generation <> OLD.generation)
BEGIN
 SELECT RAISE(ABORT, 'letterboxd_admission_authority_chain');
END;

-- The row is never deleted: an absent row at or above this version is a damaged schema, never a legacy one.
CREATE TRIGGER letterboxd_admission_authority_keep
BEFORE DELETE ON letterboxd_admission_authority
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'letterboxd_admission_authority_keep');
END;

INSERT INTO letterboxd_admission_authority (id, mode, generation, activated_at) VALUES (1, 'r2', 0, NULL);

UPDATE schema_contract
SET version = 44,
    note = 'Schema v44: the Letterboxd admission authority marker letterboxd_admission_authority (inserted as r2, generation 0; chain r2 -> closed -> d1, closed -> r2 before an activation; d1 terminal). Version 44 follows a complete version 43.'
WHERE id = 1 AND version = 43;
