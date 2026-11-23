-- Schema v35: the receipts, the seal and the seal triggers of the chunked auxiliary import (AIR-554; ADR 0202, Accepted; ADR 0194 and ADR 0196 unchanged otherwise).
-- ADDITIVE: it follows a complete version 34 (migration 0034, which is NOT changed) and refuses anything else before a table is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 35 and never goes down.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 and every import step are separate owner GOs.
-- Applying it writes no row of any auxiliary data table and does not touch the marker.
--
-- The import of the legacy auxiliary state does not fit one D1 batch (the first real export: 3,998 statements and 36.2 MB against 2,000 statements and 8 MiB), so it runs as ordered chunks
-- of whole runs, each ONE atomic batch that begins with a guard (marker `closed` at the exact generation, no seal, the chunk number is the next one, the plan digest is the one of the existing
-- receipts) and ends with its receipt. The primary key (generation, chunk_no) makes a chunk exactly-once even when two attempts race or a timed-out batch commits late.
-- The SEAL closes the cohort: once a seal row exists for the marker's generation and the marker is not `d1`, a trigger on EVERY auxiliary data table refuses INSERT, UPDATE and DELETE, whoever
-- the writer is. 0034 makes only the source and manifest tables insert-only; stage, stage head, source head, the outbox and its counters are mutable, so the seal is what makes a verification
-- receipt sound for them. After the flip (marker `d1`) the seal triggers do not block and the Worker writes normally; they cost one primary-key read of the marker per write.
-- The receipts and the seal are insert-only. The flip is a small batch that asserts the seal, the receipts and the totals in its own guard.
-- Identifiers, short lowercase codes, digests, bounded integers only. No LIKE or GLOB pattern (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 34
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('prediction_aux_authority', 'prediction_aux_cas', 'prediction_batch_stage', 'prediction_run_source_head', 'prediction_run_manifest', 'prediction_event_outbox')
 ) = 6
);

CREATE TABLE prediction_aux_import_chunk (
 generation INTEGER NOT NULL CHECK (generation >= 1),
 chunk_no INTEGER NOT NULL CHECK (chunk_no >= 1),
 chunk_sha256 TEXT NOT NULL CHECK (length(chunk_sha256) = 64),
 plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
 statements INTEGER NOT NULL CHECK (statements >= 1),
 bytes INTEGER NOT NULL CHECK (bytes >= 1),
 PRIMARY KEY (generation, chunk_no)
) STRICT;

CREATE TABLE prediction_aux_seal (
 generation INTEGER PRIMARY KEY CHECK (generation >= 1),
 plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
 chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
 slice_count INTEGER NOT NULL CHECK (slice_count >= 1)
) STRICT;

CREATE TABLE prediction_aux_verify_slice (
 generation INTEGER NOT NULL CHECK (generation >= 1),
 slice_no INTEGER NOT NULL CHECK (slice_no >= 1),
 slice_sha256 TEXT NOT NULL CHECK (length(slice_sha256) = 64),
 plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
 PRIMARY KEY (generation, slice_no)
) STRICT;

CREATE TRIGGER prediction_aux_import_chunk_no_update BEFORE UPDATE ON prediction_aux_import_chunk FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;
CREATE TRIGGER prediction_aux_import_chunk_no_delete BEFORE DELETE ON prediction_aux_import_chunk FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;
CREATE TRIGGER prediction_aux_seal_no_update BEFORE UPDATE ON prediction_aux_seal FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;
CREATE TRIGGER prediction_aux_seal_no_delete BEFORE DELETE ON prediction_aux_seal FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;
CREATE TRIGGER prediction_aux_verify_slice_no_update BEFORE UPDATE ON prediction_aux_verify_slice FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;
CREATE TRIGGER prediction_aux_verify_slice_no_delete BEFORE DELETE ON prediction_aux_verify_slice FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'prediction_aux_receipt_immutable'); END;

-- The seal triggers: eleven data tables, three events each. The marker is read first (one primary-key row); only a marker that is not `d1` AND a seal of the marker's own generation block.
CREATE TRIGGER prediction_aux_sealed_stage_head_insert BEFORE INSERT ON prediction_batch_stage_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_stage_head_update BEFORE UPDATE ON prediction_batch_stage_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_stage_head_delete BEFORE DELETE ON prediction_batch_stage_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_stage_insert BEFORE INSERT ON prediction_batch_stage FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_stage_update BEFORE UPDATE ON prediction_batch_stage FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_stage_delete BEFORE DELETE ON prediction_batch_stage FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_source_head_insert BEFORE INSERT ON prediction_run_source_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_head_update BEFORE UPDATE ON prediction_run_source_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_head_delete BEFORE DELETE ON prediction_run_source_head FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_source_revision_insert BEFORE INSERT ON prediction_run_source_revision FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_revision_update BEFORE UPDATE ON prediction_run_source_revision FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_revision_delete BEFORE DELETE ON prediction_run_source_revision FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_source_piece_insert BEFORE INSERT ON prediction_run_source_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_piece_update BEFORE UPDATE ON prediction_run_source_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_source_piece_delete BEFORE DELETE ON prediction_run_source_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_manifest_insert BEFORE INSERT ON prediction_run_manifest FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_manifest_update BEFORE UPDATE ON prediction_run_manifest FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_manifest_delete BEFORE DELETE ON prediction_run_manifest FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_manifest_piece_insert BEFORE INSERT ON prediction_run_manifest_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_manifest_piece_update BEFORE UPDATE ON prediction_run_manifest_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_manifest_piece_delete BEFORE DELETE ON prediction_run_manifest_piece FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_outbox_insert BEFORE INSERT ON prediction_event_outbox FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_outbox_update BEFORE UPDATE ON prediction_event_outbox FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_outbox_delete BEFORE DELETE ON prediction_event_outbox FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_counter_insert BEFORE INSERT ON prediction_event_outbox_counter FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_counter_update BEFORE UPDATE ON prediction_event_outbox_counter FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_counter_delete BEFORE DELETE ON prediction_event_outbox_counter FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_state_count_insert BEFORE INSERT ON prediction_event_outbox_state_count FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_state_count_update BEFORE UPDATE ON prediction_event_outbox_state_count FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_state_count_delete BEFORE DELETE ON prediction_event_outbox_state_count FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

CREATE TRIGGER prediction_aux_sealed_diag_insert BEFORE INSERT ON prediction_event_outbox_diag FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_diag_update BEFORE UPDATE ON prediction_event_outbox_diag FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;
CREATE TRIGGER prediction_aux_sealed_diag_delete BEFORE DELETE ON prediction_event_outbox_diag FOR EACH ROW
WHEN (SELECT mode FROM prediction_aux_authority WHERE id = 1) <> 'd1' AND EXISTS (SELECT 1 FROM prediction_aux_seal s, prediction_aux_authority a WHERE a.id = 1 AND s.generation = a.generation)
BEGIN SELECT RAISE(ABORT, 'prediction_aux_sealed'); END;

UPDATE schema_contract
SET version = 35,
    note = 'Schema v35: import receipts, seal and seal triggers of the chunked auxiliary import (ADR 0202). Version 35 follows a complete version 34.'
WHERE id = 1 AND version = 34;
