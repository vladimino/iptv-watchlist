-- Schema v22: the EPG-priority Discovery pause (ADR 0135, AIR-459). INERT: this file is in the repository and is NOT applied to any database by a deploy.
-- The Worker treats an ABSENT `discovery_epg_priority` table as "no pause": every Discovery path behaves exactly as before. Applying this file is the
-- activation of the gate (the table's presence is the only switch; there is no flag), so applying it is a separate owner GO and is not part of AIR-459.
-- Three additive changes, the first two described in ADR 0135 decisions 3 and 4:
--  1. `published_epg_authority.madrid_run_key` (YYYY-MM-DD, nullable): the frozen Madrid run day of the sync run whose pointer was published. It is written in the
--     same UPDATE that moves `programme_run_id`. A NULL (every generation published before this file) matches no owed day, so the pause fails closed; there is no backfill
--     from `published_at`.
--  2. `discovery_epg_priority`: ONE row. `state` is `clear` or `paused`, `owed_day_key` names the Madrid date whose publication is awaited, `override_day_key` is the
--     owner's CAS override for that date. There is NO expiry column: a business pause is not a TTL.
--  3. `discovery_lease.holder_kind` (`discovery` or `epg`, nullable): who took the lease, so a refused caller can report the owner kind (ADR 0135 decision 5). Never read for a decision.
-- It follows a complete version 21 and refuses anything else before a change is made: the first statement inserts a second schema_contract row and so aborts the file.
-- The version becomes 22 and never goes down.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 21
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'published_epg_authority',
   'discovery_authority',
   'discovery_lease',
   'projector_window',
   'canonical_producer_run'
  )
 ) = 5
);

ALTER TABLE published_epg_authority ADD COLUMN madrid_run_key TEXT
 CHECK (madrid_run_key IS NULL OR (length(madrid_run_key) = 10 AND madrid_run_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));

ALTER TABLE discovery_lease ADD COLUMN holder_kind TEXT CHECK (holder_kind IS NULL OR holder_kind IN ('discovery', 'epg'));

-- Patterns stay under D1's 50-byte LIKE/GLOB limit (see 0021).
CREATE TABLE discovery_epg_priority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('clear', 'paused')),
 owed_day_key TEXT CHECK (owed_day_key IS NULL OR (length(owed_day_key) = 10 AND owed_day_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
 override_day_key TEXT CHECK (override_day_key IS NULL OR (length(override_day_key) = 10 AND override_day_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
 CHECK (state = 'clear' OR owed_day_key IS NOT NULL)
) STRICT;

INSERT INTO discovery_epg_priority (id, state, owed_day_key, override_day_key) VALUES (1, 'clear', NULL, NULL);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 22,
    note = 'Schema v22: the EPG-priority Discovery pause row and the published run day (ADR 0135). Follows a complete version 21.'
WHERE id = 1 AND version = 21;
