-- Schema v7: mutable prediction state and its authority marker (ADR 0078).
-- Additive. Changes nothing of 0001-0006. A deploy does not apply this file.
-- The inserted marker is mode r2. Applying this file does not copy a queue,
-- a profile, a fingerprint, a prediction, a run or a lease, and it does not
-- set mode d1.
-- film_id is the id already used by the R2 key. It is not a foreign key and
-- it does not insert a film row. An off-watchlist id and a redirect id stay
-- as stored.
-- Immutable fingerprint bodies, prediction version objects and profile version
-- objects stay in R2. These tables hold pointers, queue chunks, leases
-- and run checkpoints. prediction_domain_cas is the batch fence, not a switch.
-- writes is open during ordinary r2 saves and held while a load or activation
-- has detained writers. prediction_domain_intent is one in-flight r2 put.
-- body_sha256 is the exact object text that put was about to write. A put
-- that throws leaves the intent. Only a settled put, or a reconcile that
-- reads those same bytes, deletes it.
-- schema_contract.version only moves forward. A later migration may already
-- have set a higher version without these tables. This file still creates
-- them and does not lower that version. A database below version 6 fails
-- the guard insert and creates nothing.
-- The schema v1 tables prediction_current, prediction_history, fingerprint_payload
-- and profile_version are the offline import. They are not this marker.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version >= 6);

CREATE TABLE prediction_domain_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL,
 queue_generation INTEGER NOT NULL,
 profile_generation INTEGER NOT NULL,
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
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
 seq INTEGER PRIMARY KEY CHECK (seq >= 0),
 chunk_text TEXT NOT NULL,
 generation INTEGER NOT NULL
) STRICT;

CREATE TABLE prediction_domain_intent (
 key TEXT PRIMARY KEY,
 token TEXT NOT NULL,
 generation INTEGER NOT NULL,
 body_sha256 TEXT NOT NULL
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

INSERT INTO prediction_domain_authority (id, mode, generation, queue_generation, profile_generation, writes) VALUES (1, 'r2', 0, 0, 0, 'open');
INSERT INTO prediction_domain_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = CASE WHEN version < 7 THEN 7 ELSE version END,
    note = 'Schema v7: prediction authority. Marker mode r2 until a separate activation. A higher contract version is left in place.'
WHERE id = 1 AND version >= 6;
