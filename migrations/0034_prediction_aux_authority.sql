-- Schema v34: the batch_v2 auxiliary prediction state in D1 (AIR-553; ADR 0194, Accepted). Sources today: R2 `enrichment/batch-stage.json`,
-- `enrichment/sources/<run>.json`, `enrichment/batch-manifest/<run>.json`, `enrichment/start-events/*`, `stop-events/*` and `event-outbox.json`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1, the import and the
-- activation (the marker flip) are separate owner GOs (AIR-554). The inserted marker is mode `r2`, generation 0: the Worker keeps running the
-- R2 code exactly as before. Applying this file copies nothing and switches nothing. It writes no row except the marker, the fence, the stage head,
-- the outbox counters and the diagnostic row.
-- It follows a complete version 33 and refuses anything else before a table is created: the first statement inserts a second schema_contract row and
-- so aborts the file. The version becomes 34 and never goes down.
-- prediction_aux_authority is its OWN marker, not a column of prediction_domain_authority (ADR 0194 decision 1). mode d1 is one-way: a trigger refuses
-- d1 -> r2 and deleting the row, and the generation never goes down. prediction_aux_cas is the batch fence, not a switch: a guard sets ok to the count of
-- rows that prove the caller's facts, and ok <> 1 aborts the whole batch (the same pattern as prediction_domain_cas).
-- The data tables carry no marker trigger: the writers assert the marker generation inside their own batch, and the offline importer asserts mode r2.
-- Source revisions, pieces, manifests and manifest pieces are insert-only (triggers refuse update and delete): history is retained (ADR 0194 decision 8).
-- The outbox row is never deleted; settled rows are terminal; only the payload of a settled row may be compacted to NULL (identity, original `at`,
-- journal key and digest stay). The skipped-event cap (256 active pending) is a counter row maintained by triggers with CHECK <= 256.
-- Identifiers, short lowercase codes, digests, ISO-8601 UTC times, bounded JSON texts only. D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every
-- CHECK keeps its patterns short (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 33
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('prediction_domain_authority', 'letterboxd_sync_mode', 'letterboxd_sync_fence')
 ) = 3
);

CREATE TABLE prediction_aux_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 activated_at TEXT CHECK (activated_at IS NULL OR (length(activated_at) = 24 AND substr(activated_at, -1) = 'Z')),
 CHECK ((mode = 'd1') = (activated_at IS NOT NULL))
) STRICT;

CREATE TABLE prediction_aux_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

-- Held stage: one head row carries the count and the aggregate serialized byte cap (the serialized `heldItemBody` array, 56 KiB), the rows carry the items.
CREATE TABLE prediction_batch_stage_head (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 10),
 total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 0 AND 57344),
 revision INTEGER NOT NULL CHECK (revision >= 0),
 updated_at TEXT
) STRICT;

CREATE TABLE prediction_batch_stage (
 film_id TEXT PRIMARY KEY CHECK (length(film_id) BETWEEN 1 AND 100),
 position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
 item_digest TEXT NOT NULL CHECK (length(item_digest) BETWEEN 8 AND 128),
 held_by_run_id TEXT CHECK (held_by_run_id IS NULL OR length(held_by_run_id) BETWEEN 1 AND 100),
 held_at TEXT,
 body_bytes INTEGER NOT NULL CHECK (body_bytes BETWEEN 2 AND 57344),
 item_json TEXT NOT NULL CHECK (length(item_json) BETWEEN 2 AND 262144)
) STRICT;

-- Run sources: insert-only revisions, a CAS-advanced head, byte-capped pieces.
CREATE TABLE prediction_run_source_head (
 run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 100),
 current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
 source_hash TEXT NOT NULL CHECK (length(source_hash) = 64)
) STRICT;

CREATE TABLE prediction_run_source_revision (
 run_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
 bytes INTEGER NOT NULL CHECK (bytes >= 0),
 piece_count INTEGER NOT NULL CHECK (piece_count >= 1),
 created_at TEXT NOT NULL,
 PRIMARY KEY (run_id, revision)
) STRICT;

CREATE TABLE prediction_run_source_piece (
 run_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 piece_no INTEGER NOT NULL CHECK (piece_no >= 0),
 text TEXT NOT NULL,
 PRIMARY KEY (run_id, revision, piece_no)
) STRICT;

-- Persisted manifest: create-only. manifest_hash is the unchanged semantic hash of the external contract; payload_digest is the SHA-256 of the exact serialized
-- response; each piece has its own digest so a part can be verified from the pieces that cover it.
CREATE TABLE prediction_run_manifest (
 run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 100),
 manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) BETWEEN 8 AND 128),
 payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
 selected_ids TEXT NOT NULL,
 drained_json TEXT,
 bytes INTEGER NOT NULL CHECK (bytes >= 0),
 piece_count INTEGER NOT NULL CHECK (piece_count >= 1),
 part_index TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_run_manifest_piece (
 run_id TEXT NOT NULL,
 piece_no INTEGER NOT NULL CHECK (piece_no >= 0),
 piece_digest TEXT NOT NULL CHECK (length(piece_digest) = 64),
 text TEXT NOT NULL,
 PRIMARY KEY (run_id, piece_no)
) STRICT;

-- Event outbox: one row per delivery record. The Events journal stays in R2; `journal_key` is derived from the event id and the original `at`.
CREATE TABLE prediction_event_outbox (
 event_key TEXT PRIMARY KEY CHECK (length(event_key) BETWEEN 6 AND 200),
 kind TEXT NOT NULL CHECK (kind IN ('stop', 'start', 'skipped')),
 event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
 at TEXT NOT NULL CHECK (length(at) = 24 AND substr(at, -1) = 'Z'),
 journal_key TEXT NOT NULL CHECK (length(journal_key) BETWEEN 1 AND 300),
 run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 100),
 state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'superseded', 'quarantined')),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 since TEXT NOT NULL,
 last_attempt_at TEXT,
 settled_at TEXT,
 payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
 payload_compacted INTEGER NOT NULL CHECK (payload_compacted IN (0, 1)),
 event_json TEXT CHECK (event_json IS NULL OR length(event_json) <= 65536),
 CHECK ((state IN ('delivered', 'superseded')) = (settled_at IS NOT NULL)),
 CHECK (payload_compacted = 0 OR (state IN ('delivered', 'superseded') AND event_json IS NULL)),
 CHECK (payload_compacted = 1 OR event_json IS NOT NULL)
) STRICT;

CREATE INDEX prediction_event_outbox_pending ON prediction_event_outbox (state, since, event_key);
CREATE INDEX prediction_event_outbox_settled ON prediction_event_outbox (settled_at, event_key) WHERE payload_compacted = 0 AND settled_at IS NOT NULL;
CREATE INDEX prediction_event_outbox_run ON prediction_event_outbox (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE prediction_event_outbox_counter (
 kind TEXT PRIMARY KEY CHECK (kind = 'skipped'),
 active_pending INTEGER NOT NULL CHECK (active_pending BETWEEN 0 AND 256)
) STRICT;

-- One counter per state, moved by triggers in the statement that inserts or settles a row: the status read is four rows and never walks the retained outbox history.
CREATE TABLE prediction_event_outbox_state_count (
 state TEXT PRIMARY KEY CHECK (state IN ('pending', 'delivered', 'superseded', 'quarantined')),
 n INTEGER NOT NULL CHECK (n >= 0)
) STRICT;

CREATE TABLE prediction_event_outbox_diag (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 cap_refusals INTEGER NOT NULL CHECK (cap_refusals >= 0),
 last_refusal_at TEXT
) STRICT;

CREATE TRIGGER prediction_aux_authority_one_way
BEFORE UPDATE ON prediction_aux_authority
FOR EACH ROW
WHEN (OLD.mode = 'd1' AND NEW.mode <> 'd1') OR NEW.generation < OLD.generation
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_authority_one_way');
END;

CREATE TRIGGER prediction_aux_authority_keep
BEFORE DELETE ON prediction_aux_authority
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_authority_keep');
END;

CREATE TRIGGER prediction_run_source_head_forward
BEFORE UPDATE ON prediction_run_source_head
FOR EACH ROW
WHEN NEW.run_id <> OLD.run_id OR NEW.current_revision <= OLD.current_revision
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_source_head_keep
BEFORE DELETE ON prediction_run_source_head
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_source_revision_no_update
BEFORE UPDATE ON prediction_run_source_revision
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_source_revision_no_delete
BEFORE DELETE ON prediction_run_source_revision
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_source_piece_no_update
BEFORE UPDATE ON prediction_run_source_piece
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_source_piece_no_delete
BEFORE DELETE ON prediction_run_source_piece
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_manifest_no_update
BEFORE UPDATE ON prediction_run_manifest
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_manifest_no_delete
BEFORE DELETE ON prediction_run_manifest
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_manifest_piece_no_update
BEFORE UPDATE ON prediction_run_manifest_piece
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_run_manifest_piece_no_delete
BEFORE DELETE ON prediction_run_manifest_piece
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_immutable');
END;

CREATE TRIGGER prediction_event_outbox_keep
BEFORE DELETE ON prediction_event_outbox
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_outbox_keep');
END;

CREATE TRIGGER prediction_event_outbox_identity
BEFORE UPDATE ON prediction_event_outbox
FOR EACH ROW
WHEN NEW.event_key <> OLD.event_key OR NEW.kind <> OLD.kind OR NEW.event_id <> OLD.event_id OR NEW.at <> OLD.at
 OR NEW.journal_key <> OLD.journal_key OR NEW.since <> OLD.since OR NEW.payload_digest <> OLD.payload_digest
 OR COALESCE(NEW.run_id, '') <> COALESCE(OLD.run_id, '')
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_outbox_identity');
END;

CREATE TRIGGER prediction_event_outbox_settled_terminal
BEFORE UPDATE ON prediction_event_outbox
FOR EACH ROW
WHEN (OLD.state IN ('delivered', 'superseded') AND NEW.state <> OLD.state)
 OR (OLD.payload_compacted = 1 AND NEW.payload_compacted = 0)
 OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at)
BEGIN
 SELECT RAISE(ABORT, 'prediction_aux_outbox_settled');
END;

CREATE TRIGGER prediction_event_outbox_count_in
AFTER INSERT ON prediction_event_outbox
FOR EACH ROW
BEGIN
 UPDATE prediction_event_outbox_state_count SET n = n + 1 WHERE state = NEW.state;
END;

CREATE TRIGGER prediction_event_outbox_count_move
AFTER UPDATE OF state ON prediction_event_outbox
FOR EACH ROW
WHEN OLD.state <> NEW.state
BEGIN
 UPDATE prediction_event_outbox_state_count SET n = n - 1 WHERE state = OLD.state;
 UPDATE prediction_event_outbox_state_count SET n = n + 1 WHERE state = NEW.state;
END;

CREATE TRIGGER prediction_event_outbox_skipped_in
AFTER INSERT ON prediction_event_outbox
FOR EACH ROW
WHEN NEW.kind = 'skipped' AND NEW.state = 'pending'
BEGIN
 UPDATE prediction_event_outbox_counter SET active_pending = active_pending + 1 WHERE kind = 'skipped';
END;

CREATE TRIGGER prediction_event_outbox_skipped_out
AFTER UPDATE OF state ON prediction_event_outbox
FOR EACH ROW
WHEN OLD.kind = 'skipped' AND OLD.state = 'pending' AND NEW.state <> 'pending'
BEGIN
 UPDATE prediction_event_outbox_counter SET active_pending = active_pending - 1 WHERE kind = 'skipped';
END;

CREATE TRIGGER prediction_event_outbox_skipped_back
AFTER UPDATE OF state ON prediction_event_outbox
FOR EACH ROW
WHEN OLD.kind = 'skipped' AND OLD.state <> 'pending' AND NEW.state = 'pending'
BEGIN
 UPDATE prediction_event_outbox_counter SET active_pending = active_pending + 1 WHERE kind = 'skipped';
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO prediction_aux_authority (id, mode, generation, activated_at) VALUES (1, 'r2', 0, NULL);
INSERT INTO prediction_aux_cas (id, ok) VALUES (1, 1);
INSERT INTO prediction_batch_stage_head (id, item_count, total_bytes, revision, updated_at) VALUES (1, 0, 0, 0, NULL);
INSERT INTO prediction_event_outbox_counter (kind, active_pending) VALUES ('skipped', 0);
INSERT INTO prediction_event_outbox_state_count (state, n) VALUES ('pending', 0), ('delivered', 0), ('superseded', 0), ('quarantined', 0);
INSERT INTO prediction_event_outbox_diag (id, cap_refusals, last_refusal_at) VALUES (1, 0, NULL);

UPDATE schema_contract
SET version = 34,
    note = 'Schema v34: batch_v2 auxiliary prediction state (ADR 0194). Marker mode r2 until a separate activation. Version 34 follows a complete version 33.'
WHERE id = 1 AND version = 33;
