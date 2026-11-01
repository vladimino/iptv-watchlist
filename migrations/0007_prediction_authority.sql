-- Schema v7: mutable prediction state and its authority marker (ADR 0076).
-- Additive. Changes nothing of 0001-0006. A deploy does not apply this file.
-- The inserted marker is mode r2. Applying this file does not copy a queue,
-- a profile, a fingerprint, a prediction, a run or a lease, and it does not
-- set mode d1.
-- film_id is the id already used by the R2 key. It is not a foreign key and
-- it does not insert a film row. An off-watchlist id and a redirect id stay
-- as stored.
-- Immutable fingerprint bodies, prediction version objects and profile version
-- objects stay in R2. These tables hold pointers, the queue document, leases
-- and run checkpoints. prediction_domain_cas is the batch fence, not a switch.
-- The schema v1 tables prediction_current, prediction_history, fingerprint_payload
-- and profile_version are the offline import. They are not this marker.

CREATE TABLE prediction_domain_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL,
 queue_generation INTEGER NOT NULL,
 profile_generation INTEGER NOT NULL
) STRICT;

CREATE TABLE prediction_domain_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE prediction_profile (
 version INTEGER PRIMARY KEY,
 profile_hash TEXT NOT NULL,
 active INTEGER NOT NULL CHECK (active IN (0, 1)),
 created_at TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 lineage_json TEXT
) STRICT;
CREATE UNIQUE INDEX prediction_profile_active ON prediction_profile(active) WHERE active = 1;

CREATE TABLE prediction_fingerprint (
 film_id TEXT PRIMARY KEY,
 fingerprint_hash TEXT NOT NULL,
 schema_version INTEGER NOT NULL,
 prompt_version INTEGER NOT NULL,
 generated_at TEXT,
 invalidated_at TEXT,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 features_json TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_pointer (
 film_id TEXT PRIMARY KEY,
 taste_profile_version INTEGER,
 taste_profile_hash TEXT,
 fingerprint_hash TEXT,
 fingerprint_schema_version INTEGER,
 prediction_prompt_version INTEGER,
 predicted_rating REAL,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 display_json TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_lineage (
 film_id TEXT NOT NULL,
 replaced_at TEXT NOT NULL,
 predicted_rating REAL,
 taste_profile_version INTEGER,
 fingerprint_hash TEXT,
 r2_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 display_json TEXT NOT NULL,
 PRIMARY KEY (film_id, replaced_at)
) STRICT;

CREATE TABLE prediction_queue (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 document_json TEXT NOT NULL,
 generation INTEGER NOT NULL
) STRICT;

CREATE TABLE prediction_lease (
 name TEXT PRIMARY KEY CHECK (name IN ('runner', 'writer')),
 token TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 document_json TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_run (
 run_id TEXT PRIMARY KEY,
 latest INTEGER NOT NULL CHECK (latest IN (0, 1)),
 updated_at TEXT NOT NULL,
 document_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX prediction_run_latest ON prediction_run(latest) WHERE latest = 1;

INSERT INTO prediction_domain_authority (id, mode, generation, queue_generation, profile_generation) VALUES (1, 'r2', 0, 0, 0);
INSERT INTO prediction_domain_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract SET version = 7, note = 'Schema v7: prediction authority. Marker mode r2 until a separate activation.' WHERE id = 1;
