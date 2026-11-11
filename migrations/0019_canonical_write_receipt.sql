-- Schema v19: the durable canonical write receipt (AIR-374 P2c; ADR 0119; ADR 0117 owner decision 5, parent ADR 0099).
-- It follows a COMPLETE version 18 (0013 to 0018 applied in order) and refuses anything else before a table is created: the first
-- statement inserts a second schema_contract row and so aborts the file. The version becomes 19 and never goes down.
-- A deploy does not apply this file and applying it writes no row: the table starts EMPTY, no Worker code calls it (the protocol module
-- src/canonical-receipts.js is dormant and unbundled) and no producer writes it. Applying it to production D1 is a separate owner GO with its
-- own preflight and readback; nothing in the repository applies it.
-- canonical_write_receipt is one row per cross-domain canonical operation (EPG, Discovery, metadata, ratings, admission, retention into
-- canonical Film/Person), keyed by the STABLE request id the caller derives from the source event. The row is written BEFORE the canonical
-- commit as `pending`, and settled to `applied` after it, or to `failed` (known not applied), `unknown` (outcome not known) or `abandoned`
-- (terminal, needs repair). An absent row never proves that a canonical change is safe: a change without a receipt is `unreceipted`.
-- The row keeps NO payload and no personal data: the content is represented by its SHA-256 digest only, the failure by a short lowercase
-- error class. Retry bookkeeping is stored, never timed: attempts, and next_attempt_at (the deadline of the in-flight attempt while
-- `pending`, the earliest retry or readback while `failed` or `unknown`) are read by whoever reconciles; there is no timer, cron or task.
-- Fence model, consistent with 0013: a receipt may be inserted or updated ONLY while the marker is d1/open (so at r2, prepared and held the
-- table stays empty or frozen, and a producer cannot write it); reads are always allowed. An insert must carry the live marker generation.
-- Rows are never deleted (trigger); pruning terminal rows is a later, separately approved decision (not decided: rows are kept indefinitely).
-- The activation baseline tables (canonical_receipt_watermark, canonical_receipt_baseline) scope what `unreceipted` means; both start EMPTY and are filled by a later, separately authorized step.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 18
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film_person_authority',
   'film_person_cas',
   'film_person_baseline',
   'canonical_revision',
   'film_rated_admission',
   'tmdb_retirement_decision',
   'epg_orchestration_document',
   'projector_window'
  )
 ) = 8
);

CREATE TABLE canonical_write_receipt (
 request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 200 AND request_id NOT GLOB '*[^A-Za-z0-9:._/=+@-]*'),
 operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64 AND operation GLOB '[a-z]*' AND operation NOT GLOB '*[^a-z0-9_]*'),
 origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 64 AND origin GLOB '[a-z]*' AND origin NOT GLOB '*[^a-z0-9_]*'),
 target_kind TEXT NOT NULL CHECK (target_kind IN ('film', 'person')),
 target_id TEXT NOT NULL CHECK (length(target_id) <= 300 AND ((target_kind = 'film' AND target_id GLOB 'film:?*') OR (target_kind = 'person' AND target_id GLOB 'person:?*'))),
 content_digest TEXT NOT NULL CHECK (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
 planned_revision INTEGER NOT NULL CHECK (planned_revision >= 0),
 applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 0),
 marker_generation INTEGER NOT NULL CHECK (marker_generation >= 0),
 state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'failed', 'unknown', 'abandoned')),
 attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 16),
 next_attempt_at TEXT CHECK (next_attempt_at IS NULL OR length(next_attempt_at) BETWEEN 20 AND 32),
 error_class TEXT CHECK (error_class IS NULL OR (length(error_class) BETWEEN 1 AND 64 AND error_class GLOB '[a-z]*' AND error_class NOT GLOB '*[^a-z0-9_]*')),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32),
 settled_at TEXT CHECK (settled_at IS NULL OR length(settled_at) BETWEEN 20 AND 32),
 CHECK ((state IN ('pending', 'failed', 'unknown') AND next_attempt_at IS NOT NULL) OR (state IN ('applied', 'abandoned') AND next_attempt_at IS NULL)),
 CHECK ((state IN ('applied', 'abandoned')) = (settled_at IS NOT NULL)),
 CHECK (state <> 'applied' OR (applied_revision IS NOT NULL AND error_class IS NULL)),
 CHECK (state = 'applied' OR applied_revision IS NULL),
 CHECK (state NOT IN ('failed', 'unknown', 'abandoned') OR error_class IS NOT NULL)
) STRICT;

CREATE INDEX canonical_write_receipt_due ON canonical_write_receipt (state, next_attempt_at);
CREATE INDEX canonical_write_receipt_target ON canonical_write_receipt (target_kind, target_id, applied_revision);

-- Writes only while the marker allows canonical writes (d1/open). Reads are not touched.
CREATE TRIGGER canonical_write_receipt_insert_open
BEFORE INSERT ON canonical_write_receipt
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_not_open');
END;

CREATE TRIGGER canonical_write_receipt_update_open
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_not_open');
END;

-- A new receipt is the first attempt, pending, and carries the live marker generation (a plan made under an older one is refused).
CREATE TRIGGER canonical_write_receipt_insert_shape
BEFORE INSERT ON canonical_write_receipt
FOR EACH ROW
WHEN NEW.state <> 'pending' OR NEW.attempts <> 1 OR NEW.applied_revision IS NOT NULL OR NEW.settled_at IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_insert');
END;

CREATE TRIGGER canonical_write_receipt_insert_generation
BEFORE INSERT ON canonical_write_receipt
FOR EACH ROW
WHEN NEW.marker_generation <> COALESCE((SELECT generation FROM film_person_authority WHERE id = 1), -1)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_stale_generation');
END;

-- What the receipt identifies never changes: a replay with the same request id and another operation, target or content is refused.
CREATE TRIGGER canonical_write_receipt_immutable
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN NEW.request_id <> OLD.request_id OR NEW.operation <> OLD.operation OR NEW.origin <> OLD.origin
 OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id OR NEW.content_digest <> OLD.content_digest
 OR NEW.created_at <> OLD.created_at
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_immutable');
END;

-- Moves: applied and abandoned are terminal (no move leaves them, not even an update that changes nothing).
CREATE TRIGGER canonical_write_receipt_transition
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN NOT (
 (OLD.state = 'pending' AND NEW.state IN ('pending', 'applied', 'failed', 'unknown', 'abandoned'))
 OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'applied', 'abandoned'))
 OR (OLD.state = 'unknown' AND NEW.state IN ('pending', 'applied', 'failed', 'abandoned'))
)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_transition');
END;

-- The attempt counter moves only with a new attempt (a move to pending), by exactly one; it is the stored retry bound.
CREATE TRIGGER canonical_write_receipt_attempts
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN NEW.attempts <> OLD.attempts + (NEW.state = 'pending')
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_attempts');
END;

-- A new attempt carries the live marker generation; every other move leaves the planned generation alone.
CREATE TRIGGER canonical_write_receipt_generation
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN (NEW.state = 'pending' AND NEW.marker_generation <> COALESCE((SELECT generation FROM film_person_authority WHERE id = 1), -1))
 OR (NEW.state <> 'pending' AND NEW.marker_generation <> OLD.marker_generation)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_stale_generation');
END;

CREATE TRIGGER canonical_write_receipt_no_delete
BEFORE DELETE ON canonical_write_receipt
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_delete');
END;

-- The activation baseline (ADR 0119): a canonical_revision that predates receipts must not be called "unreceipted", and must not be retrospectively given a receipt. canonical_receipt_watermark
-- is one row, taken once, and PROVES the boundary: per kind, the count, the highest revision and the SHA-256 digest of the (id, revision) pairs it copied, plus the marker generation it was
-- taken under (the code verifies them read-only against the copied rows: `verifyBaseline`); canonical_receipt_baseline holds one row per canonical_revision entity as it stood then (kind, id, revision). A revision at or below its baseline entry is
-- `pre_receipt_baseline`; unreceipted applies only above it. Both tables are insert-only, and may be filled only while the marker is d1/open (the watermark under the live generation) and BEFORE the first
-- receipt exists (a receipt needs the watermark, and the watermark is one row, so it can only precede them); a receipt cannot be inserted until the watermark exists. Taking it is a later, separately authorized activation step (src/canonical-receipts.js `recordBaseline`).
CREATE TABLE canonical_receipt_watermark (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 marker_generation INTEGER NOT NULL CHECK (marker_generation >= 0),
 entries INTEGER NOT NULL CHECK (entries >= 0),
 film_count INTEGER NOT NULL CHECK (film_count >= 0),
 film_max_revision INTEGER NOT NULL CHECK (film_max_revision >= 0),
 film_digest TEXT NOT NULL CHECK (length(film_digest) = 64 AND film_digest NOT GLOB '*[^0-9a-f]*'),
 person_count INTEGER NOT NULL CHECK (person_count >= 0),
 person_max_revision INTEGER NOT NULL CHECK (person_max_revision >= 0),
 person_digest TEXT NOT NULL CHECK (length(person_digest) = 64 AND person_digest NOT GLOB '*[^0-9a-f]*'),
 taken_at TEXT NOT NULL CHECK (length(taken_at) BETWEEN 20 AND 32),
 CHECK (entries = film_count + person_count)
) STRICT;

CREATE TABLE canonical_receipt_baseline (
 kind TEXT NOT NULL CHECK (kind IN ('film', 'person')),
 id TEXT NOT NULL CHECK ((kind = 'film' AND id GLOB 'film:?*') OR (kind = 'person' AND id GLOB 'person:?*')),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 PRIMARY KEY (kind, id)
) STRICT;

CREATE TRIGGER canonical_receipt_watermark_insert
BEFORE INSERT ON canonical_receipt_watermark
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open' AND generation = NEW.marker_generation)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_refused');
END;

CREATE TRIGGER canonical_receipt_baseline_insert
BEFORE INSERT ON canonical_receipt_baseline
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
 OR NOT EXISTS (SELECT 1 FROM canonical_receipt_watermark WHERE id = 1)
 OR EXISTS (SELECT 1 FROM canonical_write_receipt)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_refused');
END;

CREATE TRIGGER canonical_receipt_watermark_no_update
BEFORE UPDATE ON canonical_receipt_watermark
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');
END;

CREATE TRIGGER canonical_receipt_watermark_no_delete
BEFORE DELETE ON canonical_receipt_watermark
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');
END;

CREATE TRIGGER canonical_receipt_baseline_no_update
BEFORE UPDATE ON canonical_receipt_baseline
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');
END;

CREATE TRIGGER canonical_receipt_baseline_no_delete
BEFORE DELETE ON canonical_receipt_baseline
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_immutable');
END;

CREATE TRIGGER canonical_write_receipt_insert_baseline
BEFORE INSERT ON canonical_write_receipt
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM canonical_receipt_watermark WHERE id = 1)
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_baseline_missing');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 19,
    note = 'Schema v19: durable canonical write receipt and activation baseline (empty). Follows a complete version 18.'
WHERE id = 1 AND version = 18;
