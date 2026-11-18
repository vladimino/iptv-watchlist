-- Schema v24: the owner-confirmed, scoped prediction recovery intent (AIR-477; ADR 0165, Proposed).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a
-- separate owner GO (AIR-478); nothing in the Worker applies it. While the tables are absent the capability is dormant:
-- the freshness rule sees no intent and the confirm route refuses `recovery_schema_not_ready`.
-- An intent says that ONE stored prediction version (and, in mode fingerprint_and_prediction, ONE stored fingerprint
-- version) of ONE film is not accepted as current. The ordinary queue rebuild then admits the film through the ordinary
-- freshness rule; the first new version the ordinary runner commits ends the intent's effect, because the denied tokens no
-- longer match. Nothing here touches the queue, the retry records, the leases, a pointer, the history or an R2 body.
-- Writable only while the prediction domain marker is d1 and writes are open (triggers). No row is ever deleted.
-- Identifiers, short lowercase codes, hashes and ISO-8601 UTC times only: no title, name or payload.
-- It follows a complete version 23 and refuses anything else before a table is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 24 and never goes down.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every CHECK keeps its patterns short (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 23
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'prediction_domain_authority',
   'prediction_domain_cas',
   'prediction_pointer',
   'prediction_fingerprint',
   'canonical_producer_chain'
  )
 ) = 5
);

CREATE TABLE prediction_recovery_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE prediction_recovery_cohort (
 cohort_id TEXT PRIMARY KEY CHECK (length(cohort_id) = 27 AND substr(cohort_id, 1, 3) = 'pr_' AND substr(cohort_id, 4) NOT GLOB '*[^0-9a-f]*'),
 idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 80 AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'),
 scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
 request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 mode TEXT NOT NULL CHECK (mode IN ('prediction_only', 'fingerprint_and_prediction')),
 film_count INTEGER NOT NULL CHECK (film_count BETWEEN 1 AND 50),
 state TEXT NOT NULL CHECK (state IN ('active', 'cancelled')),
 created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z'),
 expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND substr(expires_at, 11, 1) = 'T' AND substr(expires_at, -1) = 'Z'),
 cancelled_at TEXT CHECK (cancelled_at IS NULL OR (length(cancelled_at) = 24 AND substr(cancelled_at, -1) = 'Z')),
 CHECK (expires_at > created_at),
 CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
) STRICT;

CREATE TABLE prediction_recovery_intent (
 cohort_id TEXT NOT NULL,
 film_id TEXT NOT NULL CHECK (length(film_id) BETWEEN 1 AND 80 AND film_id NOT GLOB '*[^A-Za-z0-9_-]*'),
 canonical_film_id TEXT NOT NULL CHECK (length(canonical_film_id) BETWEEN 1 AND 80),
 tmdb TEXT CHECK (tmdb IS NULL OR (length(tmdb) BETWEEN 1 AND 12 AND tmdb NOT GLOB '*[^0-9]*')),
 lid TEXT CHECK (lid IS NULL OR length(lid) BETWEEN 1 AND 40),
 mode TEXT NOT NULL CHECK (mode IN ('prediction_only', 'fingerprint_and_prediction')),
 prediction_token TEXT NOT NULL CHECK (length(prediction_token) BETWEEN 3 AND 300),
 fingerprint_token TEXT CHECK (fingerprint_token IS NULL OR length(fingerprint_token) BETWEEN 2 AND 200),
 state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'cancelled')),
 created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, -1) = 'Z'),
 expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND substr(expires_at, -1) = 'Z'),
 closed_at TEXT CHECK (closed_at IS NULL OR (length(closed_at) = 24 AND substr(closed_at, -1) = 'Z')),
 PRIMARY KEY (cohort_id, film_id),
 CHECK ((state = 'active') = (closed_at IS NULL)),
 CHECK (mode = 'fingerprint_and_prediction' OR fingerprint_token IS NULL)
) STRICT;
CREATE UNIQUE INDEX prediction_recovery_intent_one_active ON prediction_recovery_intent(film_id) WHERE state = 'active';

CREATE TRIGGER prediction_recovery_cohort_insert_open
BEFORE INSERT ON prediction_recovery_cohort
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1 AND mode = 'd1' AND writes = 'open')
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_not_open');
END;

CREATE TRIGGER prediction_recovery_cohort_update_open
BEFORE UPDATE ON prediction_recovery_cohort
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1 AND mode = 'd1' AND writes = 'open')
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_not_open');
END;

CREATE TRIGGER prediction_recovery_cohort_shape
BEFORE INSERT ON prediction_recovery_cohort
FOR EACH ROW
WHEN NEW.state <> 'active' OR NEW.cancelled_at IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_cohort_insert');
END;

CREATE TRIGGER prediction_recovery_cohort_transition
BEFORE UPDATE ON prediction_recovery_cohort
FOR EACH ROW
WHEN OLD.state <> 'active' OR NEW.cohort_id <> OLD.cohort_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.scope_hash <> OLD.scope_hash OR NEW.request_digest <> OLD.request_digest
 OR NEW.mode <> OLD.mode OR NEW.film_count <> OLD.film_count OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_cohort_immutable');
END;

CREATE TRIGGER prediction_recovery_cohort_no_delete
BEFORE DELETE ON prediction_recovery_cohort
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_delete');
END;

CREATE TRIGGER prediction_recovery_intent_insert_open
BEFORE INSERT ON prediction_recovery_intent
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1 AND mode = 'd1' AND writes = 'open')
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_not_open');
END;

CREATE TRIGGER prediction_recovery_intent_update_open
BEFORE UPDATE ON prediction_recovery_intent
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1 AND mode = 'd1' AND writes = 'open')
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_not_open');
END;

CREATE TRIGGER prediction_recovery_intent_shape
BEFORE INSERT ON prediction_recovery_intent
FOR EACH ROW
WHEN NEW.state <> 'active' OR NEW.closed_at IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM prediction_recovery_cohort WHERE cohort_id = NEW.cohort_id AND state = 'active' AND mode = NEW.mode AND expires_at = NEW.expires_at)
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_intent_insert');
END;

CREATE TRIGGER prediction_recovery_intent_transition
BEFORE UPDATE ON prediction_recovery_intent
FOR EACH ROW
WHEN OLD.state <> 'active' OR NEW.cohort_id <> OLD.cohort_id OR NEW.film_id <> OLD.film_id OR NEW.canonical_film_id <> OLD.canonical_film_id
 OR NEW.tmdb IS NOT OLD.tmdb OR NEW.lid IS NOT OLD.lid OR NEW.mode <> OLD.mode OR NEW.prediction_token <> OLD.prediction_token
 OR NEW.fingerprint_token IS NOT OLD.fingerprint_token OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_intent_immutable');
END;

CREATE TRIGGER prediction_recovery_intent_no_delete
BEFORE DELETE ON prediction_recovery_intent
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_delete');
END;

CREATE TRIGGER prediction_recovery_revision_forward
BEFORE UPDATE ON prediction_recovery_revision
FOR EACH ROW
WHEN NEW.revision <> OLD.revision + 1
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_revision');
END;

CREATE TRIGGER prediction_recovery_revision_no_delete
BEFORE DELETE ON prediction_recovery_revision
BEGIN
 SELECT RAISE(ABORT, 'prediction_recovery_delete');
END;

INSERT INTO prediction_recovery_revision (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 24,
    note = 'Schema v24: dormant prediction recovery intent tables (empty). Follows a complete version 23.'
WHERE id = 1 AND version = 23;
