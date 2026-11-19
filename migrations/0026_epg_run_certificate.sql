-- Schema v26: the EPG run completion certificate (AIR-539; ADR 0175, Accepted).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate
-- owner GO (preflight, one apply, readback); nothing in the Worker applies it. While the columns are absent the Worker keeps today's
-- behaviour: the EPG-priority pause lifts in the pointer batch (ADR 0135), so deploying the code before the migration is safe.
-- Two nullable columns on the single published_epg_authority row: `finalized_run_id`, the programme run whose seal is durably
-- `stage=complete`, and `finalized_at`, the time the certificate was written (telemetry only). Once the columns exist the pointer move
-- resets both when a DIFFERENT programme run is published, and the pause lifts only when `finalized_run_id = programme_run_id`.
-- Written by the one fenced certify batch (step lease, mode revision, programme run, Madrid day, CAS). No title, id list or payload.
-- It follows a complete version 25 and refuses anything else before a column is added: the first statement inserts a second
-- schema_contract row and so aborts the file. The version becomes 26 and never goes down.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 25
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'published_epg_authority',
   'discovery_epg_priority',
   'epg_orchestration_document',
   'film_retention_scan'
  )
 ) = 4
);

ALTER TABLE published_epg_authority ADD COLUMN finalized_run_id TEXT;
ALTER TABLE published_epg_authority ADD COLUMN finalized_at TEXT;

UPDATE schema_contract
SET version = 26,
    note = 'Schema v26: EPG run completion certificate columns finalized_run_id and finalized_at (NULL). Follows a complete version 25.'
WHERE id = 1 AND version = 25;
