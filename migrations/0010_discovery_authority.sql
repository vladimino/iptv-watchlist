-- Schema v10: discovery observations, decisions and catalog admission (ADR 0084).
-- Additive. A deploy does not apply this file. Production order is 0007, then
-- 0008, then 0009, then this file. 0009 is a different domain; it occupies
-- version 9, so this file refuses anything that is not a complete version 9.
-- The inserted marker is mode r2 and cutover open. Applying this file does
-- not copy a ledger, a decision or a catalog film, and it does not set mode d1.
-- No statement inserts film, person, credit or owner-review rows.
-- discovery_cas is the batch fence, not a switch. cutover held is not a
-- visible d1. observation_key and film_id are not foreign keys to film.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 9 AND version < 10
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'prediction_domain_authority',
   'prediction_domain_cas',
   'prediction_profile',
   'prediction_fingerprint',
   'prediction_pointer',
   'prediction_lineage',
   'prediction_queue',
   'prediction_lease',
   'prediction_run',
   'prediction_domain_intent',
   'published_epg_authority',
   'published_epg_cas',
   'published_epg_generation',
   'published_epg_document',
   'published_epg_member',
   'published_epg_show',
   'published_epg_stage',
   'published_epg_stage_chunk',
   'published_epg_stage_row',
   'owner_review_authority',
   'owner_review_cas',
   'owner_review_entry'
  )
 ) = 22
 AND EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1)
 AND EXISTS (SELECT 1 FROM published_epg_authority WHERE id = 1)
 AND EXISTS (SELECT 1 FROM owner_review_authority WHERE id = 1)
);

CREATE TABLE discovery_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 cutover TEXT NOT NULL CHECK (cutover IN ('open', 'held')),
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 published_programme_run_id TEXT
) STRICT;

CREATE TABLE discovery_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE discovery_transfer (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('idle', 'loading', 'committed')),
 programme_run_id TEXT,
 batches INTEGER NOT NULL
) STRICT;

CREATE TABLE discovery_lease (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 lease_id TEXT,
 expires_at INTEGER NOT NULL,
 programme_run_id TEXT
) STRICT;

CREATE TABLE discovery_continuation (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 revision INTEGER NOT NULL,
 programme_run_id TEXT,
 payload_json TEXT
) STRICT;

CREATE TABLE discovery_status (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 retry_at TEXT,
 payload_json TEXT
) STRICT;

CREATE TABLE discovery_checkpoint (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 hop_id TEXT,
 payload_json TEXT
) STRICT;

CREATE TABLE discovery_workflow (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 revision INTEGER NOT NULL,
 instance_id TEXT,
 programme_run_id TEXT,
 series INTEGER,
 payload_json TEXT
) STRICT;

CREATE TABLE discovery_observation (
 source_key TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 residence TEXT NOT NULL CHECK (residence IN ('active', 'archive', 'unreferenced', 'retiring')),
 programme_run_id TEXT NOT NULL,
 normalized_title TEXT,
 title TEXT,
 year INTEGER,
 evidence_key TEXT,
 seen_in_latest INTEGER,
 last_seen_at TEXT,
 last_airing INTEGER,
 confirmed_tmdb_id TEXT,
 payload_json TEXT NOT NULL,
 PRIMARY KEY (source_key, observation_key)
) STRICT;

CREATE INDEX discovery_observation_residence ON discovery_observation(residence, observation_key);

CREATE TABLE discovery_observation_show (
 source_key TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 channel_id TEXT,
 channel TEXT,
 start_ms INTEGER,
 end_ms INTEGER,
 PRIMARY KEY (source_key, observation_key, ordinal)
) STRICT;

CREATE TABLE discovery_decision (
 observation_key TEXT PRIMARY KEY,
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 status TEXT,
 attempts INTEGER,
 evidence_key TEXT,
 terminal_reason TEXT,
 retry_at TEXT,
 tmdb_id TEXT,
 media_kind TEXT CHECK (media_kind IN ('movie', 'tv') OR media_kind IS NULL),
 film_id TEXT,
 decision_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL
) STRICT;

CREATE TABLE discovery_decision_history (
 observation_key TEXT NOT NULL,
 revision INTEGER NOT NULL,
 generation INTEGER NOT NULL,
 written_at TEXT NOT NULL,
 writer TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 PRIMARY KEY (observation_key, revision)
) STRICT;

CREATE TABLE discovery_admission (
 film_id TEXT PRIMARY KEY,
 tmdb_id TEXT NOT NULL,
 media_kind TEXT NOT NULL CHECK (media_kind IN ('movie', 'tv')),
 canonical_identity TEXT NOT NULL,
 observation_key TEXT,
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'pending')),
 payload_json TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX discovery_admission_identity ON discovery_admission(media_kind, tmdb_id);

CREATE TABLE discovery_segment (
 source_key TEXT PRIMARY KEY,
 programme_run_id TEXT NOT NULL,
 residence TEXT NOT NULL CHECK (residence IN ('archive', 'unreferenced')),
 r2_key TEXT,
 content_sha256 TEXT NOT NULL,
 item_count INTEGER NOT NULL
) STRICT;

CREATE TABLE discovery_score (
 observation_key TEXT PRIMARY KEY,
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 outcome TEXT,
 reason TEXT,
 payload_json TEXT NOT NULL
) STRICT;

CREATE TABLE discovery_intent (
 idempotency_key TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('reconsider', 'identity_assign', 'identity_reject')),
 state TEXT NOT NULL CHECK (state IN ('approved', 'running', 'receipt')),
 observation_key TEXT NOT NULL,
 before_json TEXT,
 receipt_json TEXT,
 issued_json TEXT,
 command_json TEXT,
 expected_hash TEXT,
 expires_at INTEGER,
 generation INTEGER
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO discovery_authority (id, mode, cutover, programme_run_id, generation, published_programme_run_id)
VALUES (1, 'r2', 'open', NULL, 0, NULL);
INSERT INTO discovery_cas (id, ok) VALUES (1, 1);
INSERT INTO discovery_transfer (id, state, programme_run_id, batches) VALUES (1, 'idle', NULL, 0);
INSERT INTO discovery_lease (id, lease_id, expires_at, programme_run_id) VALUES (1, NULL, 0, NULL);
INSERT INTO discovery_continuation (id, revision, programme_run_id, payload_json) VALUES (1, 0, NULL, NULL);
INSERT INTO discovery_status (id, programme_run_id, generation, retry_at, payload_json) VALUES (1, NULL, 0, NULL, NULL);
INSERT INTO discovery_checkpoint (id, programme_run_id, generation, hop_id, payload_json) VALUES (1, NULL, 0, NULL, NULL);
INSERT INTO discovery_workflow (id, revision, instance_id, programme_run_id, series, payload_json) VALUES (1, 0, NULL, NULL, NULL, NULL);

UPDATE schema_contract
SET version = 10,
    note = 'Schema v10: discovery authority. Marker mode r2 until a separate activation. Version 10 follows a complete version 9.'
WHERE id = 1 AND version >= 9 AND version < 10;
