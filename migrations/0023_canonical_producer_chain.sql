-- Schema v23: the durable Film/Person producer Workflow chain row (AIR-497; ADR 0141 Accepted as DESIGN).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1
-- is a separate owner GO on AIR-499; nothing in the Worker applies it. While the Film/Person marker is not d1/open
-- the table stays empty (the same trigger pattern as 0020). The table starts EMPTY.
-- It follows a complete version 22 and refuses anything else before a table is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 23 and never goes down.
-- Identifiers, short lowercase codes and ISO-8601 UTC times only: no payload, title, name or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every time CHECK is split into short GLOB and substr() tests.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 22
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film_person_authority',
   'film_person_cas',
   'canonical_producer_run',
   'published_epg_authority',
   'discovery_epg_priority'
  )
 ) = 5
);

CREATE TABLE canonical_producer_chain (
 programme_run_id TEXT NOT NULL CHECK (length(programme_run_id) BETWEEN 1 AND 160),
 input_generation INTEGER NOT NULL CHECK (input_generation >= 0),
 run_key TEXT CHECK (run_key IS NULL OR length(run_key) BETWEEN 1 AND 160),
 owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
 owner_instance TEXT NOT NULL CHECK (length(owner_instance) BETWEEN 1 AND 80 AND owner_instance GLOB 'pw_*'),
 claim_nonce TEXT CHECK (claim_nonce IS NULL OR (length(claim_nonce) BETWEEN 8 AND 64 AND claim_nonce NOT GLOB '*[^0-9a-f-]*')),
 owner_state TEXT NOT NULL CHECK (owner_state IN ('pending', 'active', 'released', 'complete', 'stopped', 'superseded')),
 lease_expires_at TEXT NOT NULL CHECK (length(lease_expires_at) BETWEEN 20 AND 32 AND substr(lease_expires_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(lease_expires_at, 11, 1) = 'T' AND substr(lease_expires_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(lease_expires_at, -1) = 'Z' AND lease_expires_at NOT GLOB '*[^0-9TZ:.-]*'),
 handoff_count INTEGER NOT NULL DEFAULT 0 CHECK (handoff_count >= 0),
 takeover_count INTEGER NOT NULL DEFAULT 0 CHECK (takeover_count >= 0),
 rebase_count INTEGER NOT NULL DEFAULT 0 CHECK (rebase_count >= 0),
 relaunch_count INTEGER NOT NULL DEFAULT 0 CHECK (relaunch_count >= 0),
 reopen_count INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
 stopped_by TEXT CHECK (stopped_by IS NULL OR (length(stopped_by) BETWEEN 1 AND 80 AND stopped_by GLOB '[a-z]*' AND stopped_by NOT GLOB '*[^a-z_0-9]*')),
 recovery_class TEXT CHECK (recovery_class IS NULL OR recovery_class IN ('transient', 'authority', 'terminal', 'receipt', 'fail_closed', 'exhausted')),
 recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
 streak_started_at TEXT CHECK (streak_started_at IS NULL OR (length(streak_started_at) BETWEEN 20 AND 32 AND substr(streak_started_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(streak_started_at, 11, 1) = 'T' AND substr(streak_started_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(streak_started_at, -1) = 'Z' AND streak_started_at NOT GLOB '*[^0-9TZ:.-]*')),
 next_attempt_at TEXT CHECK (next_attempt_at IS NULL OR (length(next_attempt_at) BETWEEN 20 AND 32 AND substr(next_attempt_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(next_attempt_at, 11, 1) = 'T' AND substr(next_attempt_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(next_attempt_at, -1) = 'Z' AND next_attempt_at NOT GLOB '*[^0-9TZ:.-]*')),
 progress_relaunches INTEGER NOT NULL DEFAULT 0 CHECK (progress_relaunches >= 0),
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(created_at, 11, 1) = 'T' AND substr(created_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(created_at, -1) = 'Z' AND created_at NOT GLOB '*[^0-9TZ:.-]*'),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(updated_at, -1) = 'Z' AND updated_at NOT GLOB '*[^0-9TZ:.-]*'),
 PRIMARY KEY (programme_run_id),
 CHECK (owner_state <> 'active' OR claim_nonce IS NOT NULL),
 CHECK (stopped_by IS NULL OR owner_state = 'stopped')
) STRICT;

CREATE TRIGGER canonical_producer_chain_insert_open
BEFORE INSERT ON canonical_producer_chain
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

CREATE TRIGGER canonical_producer_chain_update_open
BEFORE UPDATE ON canonical_producer_chain
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

CREATE TRIGGER canonical_producer_chain_no_delete
BEFORE DELETE ON canonical_producer_chain
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_chain_delete');
END;

CREATE TRIGGER canonical_producer_chain_insert_shape
BEFORE INSERT ON canonical_producer_chain
FOR EACH ROW
WHEN NEW.owner_epoch <> 1 OR NEW.owner_state <> 'pending' OR NEW.claim_nonce IS NOT NULL OR NEW.revision <> 1
 OR NEW.handoff_count <> 0 OR NEW.takeover_count <> 0 OR NEW.rebase_count <> 0 OR NEW.relaunch_count <> 0 OR NEW.reopen_count <> 0
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_chain_insert');
END;

CREATE TRIGGER canonical_producer_chain_immutable
BEFORE UPDATE ON canonical_producer_chain
FOR EACH ROW
WHEN NEW.programme_run_id <> OLD.programme_run_id OR NEW.created_at <> OLD.created_at
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_chain_immutable');
END;

CREATE TRIGGER canonical_producer_chain_revision
BEFORE UPDATE ON canonical_producer_chain
FOR EACH ROW
WHEN NEW.revision <> OLD.revision + 1
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_chain_revision');
END;

CREATE TRIGGER canonical_producer_chain_epoch
BEFORE UPDATE ON canonical_producer_chain
FOR EACH ROW
WHEN NEW.owner_epoch < OLD.owner_epoch
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_chain_epoch');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 23,
    note = 'Schema v23: dormant canonical producer chain ownership row (empty). Follows a complete version 22.'
WHERE id = 1 AND version = 22;
