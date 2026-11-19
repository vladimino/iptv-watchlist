-- Schema v25: the watchlist retention scan watermark (AIR-532; ADR 0173, Proposed).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a
-- separate owner GO; nothing in the Worker applies it. While the table is absent the producer keeps the previous behaviour
-- (every scan rewrites `film_retention.observed_at`), so deploying the code before the migration is safe.
-- ONE row, `id = 1`: the observation time of the newest complete watchlist scan whose retention work was admitted. Since ADR 0173
-- `film_retention.observed_at` is the start of a Film's current watchlist state, not the last scan that confirmed it, so it cannot
-- order a late observation against a later unchanged confirmation. This row can: an observation older than it is stale for every Film,
-- because a complete scan observes every listed Film. The row only moves forward (trigger), is never deleted, and is advanced by the
-- fenced producer (marker generation asserted) once per scan, not once per Film.
-- Times only: no title, name, id or payload. The two guard triggers on film_retention make a code rollback after the apply safe (docs/runbooks/film-person-0025-apply.md).
-- It follows a complete version 24 and refuses anything else before a table is created: the first statement inserts a second
-- schema_contract row and so aborts the file. The version becomes 25 and never goes down.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so the CHECK keeps its patterns short (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 24
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film_retention',
   'film_person_authority',
   'canonical_write_receipt',
   'prediction_recovery_revision',
   'prediction_recovery_cohort',
   'prediction_recovery_intent'
  )
 ) = 6
);

CREATE TABLE film_retention_scan (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 observed_at TEXT NOT NULL CHECK (length(observed_at) = 24 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND substr(observed_at, 20, 1) = '.' AND substr(observed_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(observed_at, 24, 1) = 'Z'),
 updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER film_retention_scan_monotonic
BEFORE UPDATE ON film_retention_scan
WHEN NEW.observed_at < OLD.observed_at
BEGIN
 SELECT RAISE(ABORT, 'film_retention_scan_monotonic');
END;

CREATE TRIGGER film_retention_scan_no_delete
BEFORE DELETE ON film_retention_scan
BEGIN
 SELECT RAISE(ABORT, 'film_retention_scan_delete');
END;

-- The ordering guard lives in the database, so it holds for ANY writer, including a Worker rolled back to code that never reads
-- film_retention_scan: a write that CONTRADICTS the stored boolean with an observation that is newer than the stored row but
-- older than the watermark is a late observation (a complete scan newer than it already confirmed the stored state) and aborts the
-- whole fenced batch. BEFORE INSERT also covers INSERT ... ON CONFLICT DO UPDATE, the writer's own statement. Writes at or after the
-- watermark, writes that agree with the stored boolean, and the first row of a Film are not affected.
CREATE TRIGGER film_retention_scan_guard_insert
BEFORE INSERT ON film_retention
WHEN EXISTS (SELECT 1 FROM film_retention r WHERE r.film_id = NEW.film_id AND r.watchlist <> NEW.watchlist AND r.observed_at < NEW.observed_at)
 AND EXISTS (SELECT 1 FROM film_retention_scan s WHERE s.id = 1 AND s.observed_at > NEW.observed_at)
BEGIN
 SELECT RAISE(ABORT, 'film_retention_scan_stale');
END;

CREATE TRIGGER film_retention_scan_guard_update
BEFORE UPDATE ON film_retention
WHEN NEW.watchlist <> OLD.watchlist AND NEW.observed_at > OLD.observed_at
 AND EXISTS (SELECT 1 FROM film_retention_scan s WHERE s.id = 1 AND s.observed_at > NEW.observed_at)
BEGIN
 SELECT RAISE(ABORT, 'film_retention_scan_stale');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 25,
    note = 'Schema v25: the watchlist retention scan watermark film_retention_scan (empty). Follows a complete version 24.'
WHERE id = 1 AND version = 24;
