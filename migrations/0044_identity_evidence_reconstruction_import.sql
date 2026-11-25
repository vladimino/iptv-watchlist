-- Schema v44: the reconstruction import path of card ER (AIR-639; ADR 0215 Accepted, decision 7 and Tables 6 and 10; follows EC, AIR-637, migration 0042, and AIR-647's 0043). It was written as 0043 and renumbered to 0044 at merge because AIR-647's 0043 landed first.
-- One forward migration that ADDS tables, triggers and indexes and changes no existing object and no row (the ledger is untouched):
--  1. `identity_evidence_import_run`: one row per import run (family, the manifest's SHA-256, the frozen cohort time, the declared counts, the writers whose `pending` state
--     blocks it) with a small state machine enforced by triggers: staging -> sealed -> running (a lease with an attempt number) -> complete, or stopped (terminal).
--  2. The immutable STAGING of the manifest: `identity_evidence_import_chunk` (membership and declared counts), `identity_evidence_import_source` (the frozen source records and
--     their guard fields), `identity_evidence_import_row` (the rows to insert and their full semantic identity, `source_order` included, a unique `(run_id, evidence_key)`).
--     UPDATE and DELETE are refused; INSERT is refused once the run is not `staging` or a seal exists.
--  3. `identity_evidence_import_seal`: the atomic seal. It is refused unless the staged counts equal the declared counts per chunk and in total, and the run's digest is the one
--     it names; after it, every staging insert is refused, so the sealed content cannot grow.
--  4. `identity_evidence_import_receipt`: the create-only chunk receipt with the four outcome counts (`inserted`, `already_imported`, `live_covered`, `reconstructed_equivalent`),
--     whose sum must equal the chunk's staged keys. Its insert trigger is the in-database fence: the run is `running`, this attempt holds the live lease, `chunk_no` is the next
--     one, the staged key count matches, and no matching live writer is `pending`.
--  5. `identity_evidence_import_cas`: the import's own assertion table (the chunk batch rolls back whole when an assertion proves false).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy (applying it is card ERM, a separate production GO). Nothing writes these tables:
-- no run exists, no manifest is staged, nothing imports, and the ledger is not touched. The code (src/identity-evidence-import.js) is not bundled.
-- It follows a complete version 43 (0043, which follows 0042) and refuses anything else before an object is created: the first statement inserts a second schema_contract row and so aborts the
-- file. The version becomes 44 and never goes down.
-- Identifiers, digests, versions, typed evidence values and ISO-8601 UTC times only: no payload or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every time CHECK is split into short GLOB and substr() tests.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 43
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'film_redirect_by_target')
 AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('film_identity_evidence', 'identity_evidence_writer', 'identity_evidence_writer_change')) = 3
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_identity_evidence' AND sql LIKE '%source_order%')
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'trigger' AND name IN (
   'film_identity_evidence_source_order', 'film_identity_evidence_scope_arrival', 'identity_evidence_writer_change_apply', 'identity_evidence_writer_insert', 'identity_evidence_writer_update'
  )
 ) = 5
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'identity_evidence_import%')
);

-- 5. The import's own assertion table: `INSERT ... ON CONFLICT DO UPDATE SET ok = excluded.ok` with ok = 0 violates the CHECK and rolls the whole batch back.
CREATE TABLE identity_evidence_import_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok >= 1)
) STRICT;
INSERT INTO identity_evidence_import_cas (id, ok) VALUES (1, 1);

-- 1. The run. The manifest's SHA-256 is the digest the owner's import GO names; the run's counts are the manifest's.
CREATE TABLE identity_evidence_import_run (
 run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 150 AND run_id NOT GLOB '*[^!-~]*'),
 family TEXT NOT NULL CHECK (family IN ('a', 'b', 'c')),
 manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 cohort_at TEXT NOT NULL CHECK (length(cohort_at) BETWEEN 20 AND 32 AND substr(cohort_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(cohort_at, 11, 1) = 'T' AND substr(cohort_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(cohort_at, -1) = 'Z' AND cohort_at NOT GLOB '*[^0-9TZ:.-]*'),
 chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 100000),
 source_count INTEGER NOT NULL CHECK (source_count >= 1),
 row_count INTEGER NOT NULL CHECK (row_count >= 1),
 -- The writers (of `identity_evidence_writer`) whose `pending` state refuses the run's start and every chunk (ADR 0215 decision 7, step 7): a JSON array of writer names.
 writers_json TEXT NOT NULL CHECK (json_valid(writers_json) AND json_type(writers_json) = 'array' AND length(writers_json) <= 500),
 state TEXT NOT NULL CHECK (state IN ('staging', 'sealed', 'running', 'stopped', 'complete')),
 -- 0 until a lease is first taken; +1 on every claim, so a chunk sent under a stale lease fails its receipt fence.
 attempt INTEGER NOT NULL CHECK (attempt >= 0),
 lease_owner TEXT CHECK (lease_owner IS NULL OR (length(lease_owner) BETWEEN 1 AND 200 AND lease_owner NOT GLOB '*[^!-~]*')),
 lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR (length(lease_expires_at) BETWEEN 20 AND 32 AND substr(lease_expires_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(lease_expires_at, 11, 1) = 'T' AND substr(lease_expires_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(lease_expires_at, -1) = 'Z' AND lease_expires_at NOT GLOB '*[^0-9TZ:.-]*')),
 stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('source_moved', 'collision', 'staging_mismatch', 'digest_mismatch', 'r2_moved', 'writer_pending', 'owner')),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(created_at, 11, 1) = 'T' AND substr(created_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(created_at, -1) = 'Z' AND created_at NOT GLOB '*[^0-9TZ:.-]*'),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(updated_at, -1) = 'Z' AND updated_at NOT GLOB '*[^0-9TZ:.-]*'),
 CHECK ((state = 'stopped') = (stop_reason IS NOT NULL)),
 CHECK (state NOT IN ('staging', 'sealed') OR (attempt = 0 AND lease_owner IS NULL AND lease_expires_at IS NULL)),
 CHECK (state <> 'running' OR (attempt >= 1 AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
) STRICT;

-- 2. The staging. A chunk holds at most 50 source records and 200 rows (ADR 0215 decision 7, step 7).
CREATE TABLE identity_evidence_import_chunk (
 run_id TEXT NOT NULL REFERENCES identity_evidence_import_run (run_id),
 chunk_no INTEGER NOT NULL CHECK (chunk_no >= 1),
 source_count INTEGER NOT NULL CHECK (source_count BETWEEN 1 AND 50),
 row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 200),
 PRIMARY KEY (run_id, chunk_no)
) STRICT;

-- A frozen source record and its guard fields. `d1_row`: a row of an allowlisted D1 table, `source_key` the canonical JSON of its key columns and `guard_json` of the fields a
-- chunk asserts at commit by equality (the SQL is built by the operator from a closed allowlist, never from this text). `r2_object`: a frozen R2 object, `source_key` its key,
-- `record_ref` the logical record inside it, `etag` the ETag the dry run pinned (the PHYSICAL object guard, one per chunk that uses the object; D1 cannot assert it, so the operator re-reads it before every submission). `source_token` is the `reconstructed_from` of every row it yields.
CREATE TABLE identity_evidence_import_source (
 run_id TEXT NOT NULL,
 chunk_no INTEGER NOT NULL,
 ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
 kind TEXT NOT NULL CHECK (kind IN ('d1_row', 'r2_object')),
 source_table TEXT CHECK (source_table IS NULL OR (length(source_table) BETWEEN 1 AND 100 AND source_table NOT GLOB '*[^a-z0-9_]*')),
 source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 1000),
 -- `r2_object` only: the durable LOGICAL record inside the physical object (one object holds many source records, for example the frozen legacy admissions); NULL for `d1_row`.
 record_ref TEXT CHECK (record_ref IS NULL OR (length(record_ref) BETWEEN 1 AND 300 AND record_ref NOT GLOB '*[^!-~]*')),
 guard_json TEXT CHECK (guard_json IS NULL OR (json_valid(guard_json) AND json_type(guard_json) = 'object' AND length(guard_json) <= 4000)),
 etag TEXT CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 200),
 source_token TEXT NOT NULL CHECK (length(source_token) BETWEEN 1 AND 300 AND source_token NOT GLOB '*[^!-~]*'),
 PRIMARY KEY (run_id, chunk_no, ordinal),
 FOREIGN KEY (run_id, chunk_no) REFERENCES identity_evidence_import_chunk (run_id, chunk_no),
 CHECK ((kind = 'd1_row' AND source_table IS NOT NULL AND guard_json IS NOT NULL AND etag IS NULL AND record_ref IS NULL) OR (kind = 'r2_object' AND source_table IS NULL AND guard_json IS NULL AND etag IS NOT NULL AND record_ref IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX identity_evidence_import_source_token ON identity_evidence_import_source (run_id, source_token);

-- The rows to insert, with their full semantic identity. One row per `evidence_key` in the whole run (the unique index): the manifest lists a key once.
CREATE TABLE identity_evidence_import_row (
 run_id TEXT NOT NULL,
 chunk_no INTEGER NOT NULL,
 ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 200),
 source_ordinal INTEGER NOT NULL CHECK (source_ordinal BETWEEN 1 AND 50),
 evidence_key TEXT NOT NULL CHECK (length(evidence_key) = 64 AND evidence_key NOT GLOB '*[^0-9a-f]*'),
 film_id TEXT CHECK (film_id IS NULL OR (length(film_id) BETWEEN 6 AND 300 AND substr(film_id, 1, 5) = 'film:')),
 subject_kind TEXT NOT NULL,
 subject_value TEXT NOT NULL CHECK (length(subject_value) BETWEEN 1 AND 300),
 relation TEXT NOT NULL,
 object_kind TEXT,
 object_value TEXT CHECK (object_value IS NULL OR length(object_value) BETWEEN 1 AND 300),
 polarity TEXT NOT NULL CHECK (polarity IN ('asserts', 'restricts', 'refutes')),
 route TEXT NOT NULL,
 method TEXT NOT NULL,
 source_root TEXT CHECK (source_root IS NULL OR length(source_root) BETWEEN 1 AND 300),
 source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 300),
 source_scope TEXT CHECK (source_scope IS NULL OR length(source_scope) BETWEEN 1 AND 300),
 scope_evidence_key TEXT CHECK (scope_evidence_key IS NULL OR (length(scope_evidence_key) = 64 AND scope_evidence_key NOT GLOB '*[^0-9a-f]*')),
 supersedes_key TEXT CHECK (supersedes_key IS NULL OR (length(supersedes_key) = 64 AND supersedes_key NOT GLOB '*[^0-9a-f]*')),
 observed_at TEXT CHECK (observed_at IS NULL OR (length(observed_at) BETWEEN 20 AND 32 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(observed_at, -1) = 'Z' AND observed_at NOT GLOB '*[^0-9TZ:.-]*')),
 reconstructed_from TEXT NOT NULL CHECK (length(reconstructed_from) BETWEEN 1 AND 300),
 source_order INTEGER CHECK (source_order IS NULL OR source_order >= 1),
 PRIMARY KEY (run_id, chunk_no, ordinal),
 FOREIGN KEY (run_id, chunk_no, source_ordinal) REFERENCES identity_evidence_import_source (run_id, chunk_no, ordinal),
 CHECK ((object_kind IS NULL) = (object_value IS NULL)),
 CHECK (source_order IS NULL OR route = 'owner_action')
) STRICT;
CREATE UNIQUE INDEX identity_evidence_import_row_key ON identity_evidence_import_row (run_id, evidence_key);

-- 3. The seal: one row per run, written once, atomically with the check of the counts. It names the digest, which is the run's own.
CREATE TABLE identity_evidence_import_seal (
 run_id TEXT PRIMARY KEY REFERENCES identity_evidence_import_run (run_id),
 manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
 source_count INTEGER NOT NULL CHECK (source_count >= 1),
 row_count INTEGER NOT NULL CHECK (row_count >= 1),
 sealed_at TEXT NOT NULL CHECK (length(sealed_at) BETWEEN 20 AND 32 AND substr(sealed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(sealed_at, 11, 1) = 'T' AND substr(sealed_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(sealed_at, -1) = 'Z' AND sealed_at NOT GLOB '*[^0-9TZ:.-]*')
) STRICT;

-- 4. The chunk receipt, create-only. The four counts are computed by the chunk's own batch from what the ledger actually holds after the insert; they must add up to the
-- staged keys. `attempt` is the lease attempt that wrote it.
CREATE TABLE identity_evidence_import_receipt (
 run_id TEXT NOT NULL REFERENCES identity_evidence_import_run (run_id),
 chunk_no INTEGER NOT NULL CHECK (chunk_no >= 1),
 attempt INTEGER NOT NULL CHECK (attempt >= 1),
 staged_keys INTEGER NOT NULL CHECK (staged_keys >= 1),
 inserted INTEGER NOT NULL CHECK (inserted >= 0),
 already_imported INTEGER NOT NULL CHECK (already_imported >= 0),
 live_covered INTEGER NOT NULL CHECK (live_covered >= 0),
 reconstructed_equivalent INTEGER NOT NULL CHECK (reconstructed_equivalent >= 0),
 recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 32 AND substr(recorded_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(recorded_at, 11, 1) = 'T' AND substr(recorded_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(recorded_at, -1) = 'Z' AND recorded_at NOT GLOB '*[^0-9TZ:.-]*'),
 PRIMARY KEY (run_id, chunk_no),
 CHECK (inserted + already_imported + live_covered + reconstructed_equivalent = staged_keys)
) STRICT;

-- ===== Staging: insert-only, bounded, closed by the seal =====
CREATE TRIGGER identity_evidence_import_chunk_open BEFORE INSERT ON identity_evidence_import_chunk FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM identity_evidence_import_run WHERE run_id = NEW.run_id AND state = 'staging')
 OR EXISTS (SELECT 1 FROM identity_evidence_import_seal WHERE run_id = NEW.run_id)
 OR EXISTS (SELECT 1 FROM identity_evidence_import_chunk WHERE run_id = NEW.run_id AND chunk_no = NEW.chunk_no)
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_sealed'); END;

CREATE TRIGGER identity_evidence_import_source_open BEFORE INSERT ON identity_evidence_import_source FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM identity_evidence_import_run WHERE run_id = NEW.run_id AND state = 'staging')
 OR EXISTS (SELECT 1 FROM identity_evidence_import_seal WHERE run_id = NEW.run_id)
 OR EXISTS (SELECT 1 FROM identity_evidence_import_source WHERE run_id = NEW.run_id AND (source_token = NEW.source_token OR (chunk_no = NEW.chunk_no AND ordinal = NEW.ordinal)))
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_sealed'); END;

-- A row names its staged source record and carries that record's token as its `reconstructed_from`.
CREATE TRIGGER identity_evidence_import_row_open BEFORE INSERT ON identity_evidence_import_row FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM identity_evidence_import_run WHERE run_id = NEW.run_id AND state = 'staging')
 OR EXISTS (SELECT 1 FROM identity_evidence_import_seal WHERE run_id = NEW.run_id)
 OR EXISTS (SELECT 1 FROM identity_evidence_import_row WHERE run_id = NEW.run_id AND (evidence_key = NEW.evidence_key OR (chunk_no = NEW.chunk_no AND ordinal = NEW.ordinal)))
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_sealed'); END;

CREATE TRIGGER identity_evidence_import_row_source BEFORE INSERT ON identity_evidence_import_row FOR EACH ROW
WHEN NOT EXISTS (
 SELECT 1 FROM identity_evidence_import_source s
 WHERE s.run_id = NEW.run_id AND s.chunk_no = NEW.chunk_no AND s.ordinal = NEW.source_ordinal AND s.source_token = NEW.reconstructed_from
)
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_row_source'); END;

CREATE TRIGGER identity_evidence_import_run_taken BEFORE INSERT ON identity_evidence_import_run FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM identity_evidence_import_run WHERE run_id = NEW.run_id) OR NEW.state <> 'staging'
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_run_taken'); END;

CREATE TRIGGER identity_evidence_import_seal_taken BEFORE INSERT ON identity_evidence_import_seal FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM identity_evidence_import_seal WHERE run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_sealed'); END;

CREATE TRIGGER identity_evidence_import_receipt_taken BEFORE INSERT ON identity_evidence_import_receipt FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM identity_evidence_import_receipt WHERE run_id = NEW.run_id AND chunk_no = NEW.chunk_no)
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_receipt_taken'); END;

CREATE TRIGGER identity_evidence_import_chunk_no_update BEFORE UPDATE ON identity_evidence_import_chunk BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_chunk_no_delete BEFORE DELETE ON identity_evidence_import_chunk BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_source_no_update BEFORE UPDATE ON identity_evidence_import_source BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_source_no_delete BEFORE DELETE ON identity_evidence_import_source BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_row_no_update BEFORE UPDATE ON identity_evidence_import_row BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_row_no_delete BEFORE DELETE ON identity_evidence_import_row BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_seal_no_update BEFORE UPDATE ON identity_evidence_import_seal BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_seal_no_delete BEFORE DELETE ON identity_evidence_import_seal BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_receipt_no_update BEFORE UPDATE ON identity_evidence_import_receipt BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_receipt_no_delete BEFORE DELETE ON identity_evidence_import_receipt BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;
CREATE TRIGGER identity_evidence_import_run_no_delete BEFORE DELETE ON identity_evidence_import_run BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_immutable'); END;

-- ===== The seal: counts per chunk and in total equal the declared ones, the digest is the run's, every R2 object pins ONE ETag across the whole manifest, and the run flips to `sealed` in the same statement =====
CREATE TRIGGER identity_evidence_import_seal_check BEFORE INSERT ON identity_evidence_import_seal FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM identity_evidence_import_run r
  WHERE r.run_id = NEW.run_id AND r.state = 'staging' AND r.manifest_sha256 = NEW.manifest_sha256
  AND r.chunk_count = NEW.chunk_count AND r.source_count = NEW.source_count AND r.row_count = NEW.row_count
 )
 OR (SELECT COUNT(*) FROM identity_evidence_import_chunk WHERE run_id = NEW.run_id) <> NEW.chunk_count
 OR COALESCE((SELECT MAX(chunk_no) FROM identity_evidence_import_chunk WHERE run_id = NEW.run_id), 0) <> NEW.chunk_count
 OR (SELECT COUNT(*) FROM identity_evidence_import_source WHERE run_id = NEW.run_id) <> NEW.source_count
 OR (SELECT COUNT(*) FROM identity_evidence_import_row WHERE run_id = NEW.run_id) <> NEW.row_count
 OR EXISTS (
  SELECT 1 FROM identity_evidence_import_chunk c
  WHERE c.run_id = NEW.run_id
  AND (c.source_count <> (SELECT COUNT(*) FROM identity_evidence_import_source s WHERE s.run_id = c.run_id AND s.chunk_no = c.chunk_no)
   OR c.row_count <> (SELECT COUNT(*) FROM identity_evidence_import_row w WHERE w.run_id = c.run_id AND w.chunk_no = c.chunk_no))
 )
 OR EXISTS (
  SELECT 1 FROM identity_evidence_import_source s
  WHERE s.run_id = NEW.run_id AND s.kind = 'r2_object'
  AND EXISTS (SELECT 1 FROM identity_evidence_import_source o WHERE o.run_id = s.run_id AND o.kind = 'r2_object' AND o.source_key = s.source_key AND o.etag <> s.etag)
 )
 OR EXISTS (
  SELECT 1 FROM identity_evidence_import_source s
  WHERE s.run_id = NEW.run_id
  AND NOT EXISTS (SELECT 1 FROM identity_evidence_import_row w WHERE w.run_id = s.run_id AND w.chunk_no = s.chunk_no AND w.source_ordinal = s.ordinal)
 )
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_seal_mismatch'); END;

CREATE TRIGGER identity_evidence_import_seal_apply AFTER INSERT ON identity_evidence_import_seal FOR EACH ROW
BEGIN
 UPDATE identity_evidence_import_run SET state = 'sealed', updated_at = NEW.sealed_at WHERE run_id = NEW.run_id AND state = 'staging';
END;

-- ===== The run's state machine. Identity, digest, counts and writers never change. =====
-- staging -> sealed (only with a seal row), staging|sealed|running -> stopped (a recorded reason: the safe direction, any time), sealed -> running (the first lease),
-- running -> running (a renewal by the owner of a live lease, or a takeover of an EXPIRED lease by a new attempt), running -> complete (every chunk has a receipt, the lease is live).
-- A claim or takeover refuses while a writer named by the run is `pending`, and a family `b` run needs BOTH Discovery writers `on` (ADR 0215 decision 7: family (b) imports after E2a and E2c are `on`), whatever the run's own list says.
-- EVERY lease comparison uses the database's own clock (the transaction time), never a caller-supplied timestamp: a batch prepared before the lease expired cannot commit after it. `stopped` and `complete` are terminal.
CREATE TRIGGER identity_evidence_import_run_update BEFORE UPDATE ON identity_evidence_import_run FOR EACH ROW
WHEN NEW.run_id <> OLD.run_id OR NEW.family <> OLD.family OR NEW.manifest_sha256 <> OLD.manifest_sha256 OR NEW.cohort_at <> OLD.cohort_at
 OR NEW.chunk_count <> OLD.chunk_count OR NEW.source_count <> OLD.source_count OR NEW.row_count <> OLD.row_count OR NEW.writers_json <> OLD.writers_json OR NEW.created_at <> OLD.created_at
 OR NOT (
  (OLD.state = 'staging' AND NEW.state = 'sealed' AND NEW.attempt = OLD.attempt
   AND EXISTS (SELECT 1 FROM identity_evidence_import_seal WHERE run_id = OLD.run_id AND manifest_sha256 = OLD.manifest_sha256 AND sealed_at = NEW.updated_at))
  OR (OLD.state IN ('staging', 'sealed', 'running') AND NEW.state = 'stopped' AND NEW.attempt = OLD.attempt AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_expires_at IS OLD.lease_expires_at)
  OR (OLD.state = 'sealed' AND NEW.state = 'running' AND NEW.attempt = 1 AND NEW.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND NOT EXISTS (SELECT 1 FROM identity_evidence_writer w WHERE w.state = 'pending' AND w.writer IN (SELECT value FROM json_each(OLD.writers_json)))
   AND NOT (OLD.family = 'b' AND (SELECT COUNT(*) FROM identity_evidence_writer w WHERE w.state = 'on' AND w.writer IN ('discovery_decision', 'discovery_owner')) < 2))
  OR (OLD.state = 'running' AND NEW.state = 'running' AND NEW.attempt = OLD.attempt + 1 AND OLD.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND NEW.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND NOT EXISTS (SELECT 1 FROM identity_evidence_writer w WHERE w.state = 'pending' AND w.writer IN (SELECT value FROM json_each(OLD.writers_json)))
   AND NOT (OLD.family = 'b' AND (SELECT COUNT(*) FROM identity_evidence_writer w WHERE w.state = 'on' AND w.writer IN ('discovery_decision', 'discovery_owner')) < 2))
  OR (OLD.state = 'running' AND NEW.state = 'running' AND NEW.attempt = OLD.attempt AND NEW.lease_owner = OLD.lease_owner AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND NEW.lease_expires_at > OLD.lease_expires_at)
  OR (OLD.state = 'running' AND NEW.state = 'complete' AND NEW.attempt = OLD.attempt AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_expires_at IS OLD.lease_expires_at AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND (SELECT COUNT(*) FROM identity_evidence_import_receipt WHERE run_id = OLD.run_id) = OLD.chunk_count)
 )
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_run_transition'); END;

-- ===== The receipt fence, in the database =====
-- The receipt is the last statement of the chunk's batch, so a refusal here rolls the whole chunk back. It requires: the run `running`; THIS attempt holding the live lease
-- at the receipt's own time; `chunk_no` the next one; the staged key count equal to the receipt's; no matching live writer `pending`; and, for family `b`, both Discovery writers `on`.
CREATE TRIGGER identity_evidence_import_receipt_fence BEFORE INSERT ON identity_evidence_import_receipt FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM identity_evidence_import_run r
  WHERE r.run_id = NEW.run_id AND r.state = 'running' AND r.attempt = NEW.attempt AND r.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND NOT EXISTS (SELECT 1 FROM identity_evidence_writer w WHERE w.state = 'pending' AND w.writer IN (SELECT value FROM json_each(r.writers_json)))
  AND NOT (r.family = 'b' AND (SELECT COUNT(*) FROM identity_evidence_writer w WHERE w.state = 'on' AND w.writer IN ('discovery_decision', 'discovery_owner')) < 2)
 )
 OR NEW.chunk_no <> (SELECT COUNT(*) FROM identity_evidence_import_receipt WHERE run_id = NEW.run_id) + 1
 OR NEW.staged_keys <> (SELECT row_count FROM identity_evidence_import_chunk WHERE run_id = NEW.run_id AND chunk_no = NEW.chunk_no)
 OR NEW.staged_keys <> (SELECT COUNT(*) FROM identity_evidence_import_row WHERE run_id = NEW.run_id AND chunk_no = NEW.chunk_no)
BEGIN SELECT RAISE(ABORT, 'identity_evidence_import_receipt_fence'); END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 44,
    note = 'Schema v44: the reconstruction import path (run, immutable manifest staging with seal, chunk receipts; inert until a run is staged). Follows a complete version 43.'
WHERE id = 1 AND version = 43;
