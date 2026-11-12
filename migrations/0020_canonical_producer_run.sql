-- Schema v20: the durable canonical producer run and unit result tables (AIR-374 S4-2; ADR 0128, accepted design, stage S4-2; ADR 0119 for the style).
-- It follows a COMPLETE version 19 (0013 to 0019 applied in order) and refuses anything else before a table is created: the first statement
-- inserts a second schema_contract row and so aborts the file. The version becomes 20 and never goes down.
-- A deploy does not apply this file and applying it writes no row: both tables start EMPTY, no Worker code calls them (src/canonical-producer-run.js is
-- the dormant, unbundled pure layer; the store, the driver and the wiring are S4-3 and S4-4) and nothing writes them. Applying it to production D1 is a
-- separate owner GO with its own preflight and readback (docs/runbooks/film-person-0020-apply.md); nothing in the repository applies it.
-- canonical_producer_run is one row per producer pass: origin 'epg' (run_key is the EPG event id; the published generation the plan was built from and
-- the generation a completed pass applied) or origin 'dictionary' (run_key is the version label d<seq>, with seq, prev_seq = seq - 1 and the snapshot
-- digest; a unique (origin, seq) index and the guard triggers make the mint atomic: two planners cannot both insert d<n>). It holds the plan identity
-- (pass_no, plan_version, fingerprint), the durable cursor, the strike identity and count (0 to 2: the third strike is written, and cleared, in one
-- batch), the counts and a compare-and-set revision.
-- canonical_producer_unit_result is one row per unit that did NOT simply succeed, keyed (origin, run_key, pass_no, kind, unit_id): states open,
-- refused_permanent, refused_recoverable (live; at most one live row per unit per run) and settled, superseded, abandoned (terminal, never reopened);
-- exactly one retry owner per row (unit: it carries the schedule; receipt: it carries the request id and NO schedule); a recoverable refusal is unit-owned,
-- scheduled and stamped (prereq_stamp: the digest of the prerequisite state read, separate from unit_digest); a permanent refusal has neither schedule nor stamp.
-- Both tables keep identifiers, digests, short lowercase codes and ISO-8601 UTC times only: no payload, title, name or personal data.
-- The SQL CHECKs mirror the assertions of the pure module (assertResultRow, checkRun, strikeViolation, resumeDecision) wherever SQLite can express them.
-- NOT enforced here (the pure module and the S4-3 store enforce it; docs/evidence/d1-migration/air-374-s4-2-producer-schema-20-offline-2026-11-12.md lists them):
-- the class of an error code against the row state (a code class cannot be checked without enumerating the codes, and a new code must not need a migration),
-- the kind of a unit or a cursor against the plan kinds, cursor monotonicity inside a pass, and that a unit digest is source-only.
-- Fence model, consistent with 0013 and 0019: a row may be inserted or updated ONLY while the marker is d1/open (so at r2, prepared and held both tables stay
-- empty or frozen); reads are always allowed. Rows are never deleted (trigger); pruning is a later, separately approved decision.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 19
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film_person_authority',
   'film_person_cas',
   'canonical_write_receipt',
   'canonical_receipt_baseline',
   'canonical_receipt_watermark',
   'canonical_receipt_baseline_seal'
  )
 ) = 6
);

CREATE TABLE canonical_producer_run (
 origin TEXT NOT NULL CHECK (origin IN ('epg', 'dictionary')),
 run_key TEXT NOT NULL CHECK (length(run_key) BETWEEN 1 AND 160),
 seq INTEGER CHECK (seq IS NULL OR seq >= 1),
 prev_seq INTEGER CHECK (prev_seq IS NULL OR prev_seq >= 0),
 snapshot_digest TEXT CHECK (snapshot_digest IS NULL OR (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*')),
 source_generation TEXT CHECK (source_generation IS NULL OR length(source_generation) BETWEEN 1 AND 200),
 applied_generation TEXT CHECK (applied_generation IS NULL OR length(applied_generation) BETWEEN 1 AND 200),
 pass_no INTEGER NOT NULL DEFAULT 1 CHECK (pass_no BETWEEN 1 AND 10000),
 plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 unit_count INTEGER NOT NULL CHECK (unit_count >= 0),
 cursor_kind TEXT CHECK (cursor_kind IS NULL OR (length(cursor_kind) BETWEEN 1 AND 40 AND cursor_kind NOT GLOB '*[^a-z_]*')),
 cursor_id TEXT CHECK (cursor_id IS NULL OR length(cursor_id) BETWEEN 1 AND 200),
 pass_state TEXT NOT NULL CHECK (pass_state IN ('passing', 'passed', 'stopped', 'superseded')),
 stopped_by TEXT CHECK (stopped_by IS NULL OR (length(stopped_by) BETWEEN 1 AND 80 AND stopped_by GLOB '[a-z]*' AND stopped_by NOT GLOB '*[^a-z_0-9]*')),
 strike_kind TEXT CHECK (strike_kind IS NULL OR (length(strike_kind) BETWEEN 1 AND 40 AND strike_kind NOT GLOB '*[^a-z_]*')),
 strike_id TEXT CHECK (strike_id IS NULL OR length(strike_id) BETWEEN 1 AND 200),
 strike_digest TEXT CHECK (strike_digest IS NULL OR (length(strike_digest) = 64 AND strike_digest NOT GLOB '*[^0-9a-f]*')),
 strike_class TEXT CHECK (strike_class IS NULL OR (length(strike_class) BETWEEN 1 AND 80 AND strike_class GLOB '[a-z]*' AND strike_class NOT GLOB '*[^a-z_0-9]*')),
 strike_count INTEGER NOT NULL DEFAULT 0 CHECK (strike_count BETWEEN 0 AND 2),
 n_applied INTEGER NOT NULL DEFAULT 0 CHECK (n_applied >= 0),
 n_noop INTEGER NOT NULL DEFAULT 0 CHECK (n_noop >= 0),
 n_kept INTEGER NOT NULL DEFAULT 0 CHECK (n_kept >= 0),
 n_failed INTEGER NOT NULL DEFAULT 0 CHECK (n_failed >= 0),
 open_at_completion INTEGER CHECK (open_at_completion IS NULL OR open_at_completion >= 0),
 marker_generation INTEGER NOT NULL CHECK (marker_generation >= 0),
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND created_at NOT GLOB '*[^0-9TZ:.-]*'),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND updated_at NOT GLOB '*[^0-9TZ:.-]*'),
 completed_at TEXT CHECK (completed_at IS NULL OR (length(completed_at) BETWEEN 20 AND 32 AND completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND completed_at NOT GLOB '*[^0-9TZ:.-]*')),
 PRIMARY KEY (origin, run_key),
 CHECK ((cursor_kind IS NULL) = (cursor_id IS NULL)),
 CHECK ((strike_count = 0) = (strike_id IS NULL)),
 CHECK ((strike_count = 0 AND strike_kind IS NULL AND strike_digest IS NULL AND strike_class IS NULL) OR (strike_count > 0 AND strike_kind IS NOT NULL AND strike_id IS NOT NULL AND strike_digest IS NOT NULL AND strike_class IS NOT NULL)),
 CHECK (stopped_by IS NULL OR pass_state = 'stopped'),
 CHECK (applied_generation IS NULL OR (pass_state = 'passed' AND source_generation IS NOT NULL AND applied_generation = source_generation AND open_at_completion IS NOT NULL)),
 CHECK (
  (origin = 'dictionary' AND seq IS NOT NULL AND prev_seq IS NOT NULL AND prev_seq = seq - 1 AND run_key = 'd' || seq AND snapshot_digest IS NOT NULL AND source_generation IS NULL AND applied_generation IS NULL)
  OR (origin = 'epg' AND seq IS NULL AND prev_seq IS NULL AND snapshot_digest IS NULL AND source_generation IS NOT NULL)
 )
) STRICT;

CREATE UNIQUE INDEX canonical_producer_run_seq ON canonical_producer_run (origin, seq) WHERE seq IS NOT NULL;
CREATE INDEX canonical_producer_run_fresh ON canonical_producer_run (origin, source_generation, applied_generation);
CREATE INDEX canonical_producer_run_updated ON canonical_producer_run (origin, updated_at);

CREATE TABLE canonical_producer_unit_result (
 origin TEXT NOT NULL CHECK (origin IN ('epg', 'dictionary')),
 run_key TEXT NOT NULL CHECK (length(run_key) BETWEEN 1 AND 160),
 pass_no INTEGER NOT NULL CHECK (pass_no BETWEEN 1 AND 10000),
 kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40 AND kind NOT GLOB '*[^a-z_]*'),
 unit_id TEXT NOT NULL CHECK (length(unit_id) BETWEEN 1 AND 200),
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 unit_digest TEXT NOT NULL CHECK (length(unit_digest) = 64 AND unit_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK (state IN ('open', 'refused_permanent', 'refused_recoverable', 'settled', 'superseded', 'abandoned')),
 retry_owner TEXT NOT NULL CHECK (retry_owner IN ('unit', 'receipt')),
 request_id TEXT CHECK (request_id IS NULL OR (length(request_id) BETWEEN 1 AND 200 AND request_id NOT GLOB '*[^A-Za-z0-9:._/=+@-]*')),
 code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 80 AND code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_0-9]*'),
 attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 16),
 prereq_stamp TEXT CHECK (prereq_stamp IS NULL OR (length(prereq_stamp) = 64 AND prereq_stamp NOT GLOB '*[^0-9a-f]*')),
 next_attempt_at TEXT CHECK (next_attempt_at IS NULL OR (length(next_attempt_at) BETWEEN 20 AND 32 AND next_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND next_attempt_at NOT GLOB '*[^0-9TZ:.-]*')),
 settled_by TEXT CHECK (settled_by IS NULL OR (length(settled_by) BETWEEN 1 AND 64 AND settled_by GLOB '[a-z]*' AND settled_by NOT GLOB '*[^a-z_0-9]*')),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND created_at NOT GLOB '*[^0-9TZ:.-]*'),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND updated_at NOT GLOB '*[^0-9TZ:.-]*'),
 settled_at TEXT CHECK (settled_at IS NULL OR (length(settled_at) BETWEEN 20 AND 32 AND settled_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z' AND settled_at NOT GLOB '*[^0-9TZ:.-]*')),
 PRIMARY KEY (origin, run_key, pass_no, kind, unit_id),
 FOREIGN KEY (origin, run_key) REFERENCES canonical_producer_run (origin, run_key),
 CHECK ((retry_owner = 'receipt') = (request_id IS NOT NULL)),
 CHECK (retry_owner = 'unit' OR next_attempt_at IS NULL),
 CHECK (state <> 'open' OR retry_owner = 'receipt' OR next_attempt_at IS NOT NULL),
 CHECK (state <> 'refused_permanent' OR (next_attempt_at IS NULL AND prereq_stamp IS NULL)),
 CHECK (state <> 'refused_recoverable' OR (retry_owner = 'unit' AND next_attempt_at IS NOT NULL AND prereq_stamp IS NOT NULL)),
 CHECK (state NOT IN ('settled', 'superseded', 'abandoned') OR next_attempt_at IS NULL),
 CHECK ((state IN ('settled', 'superseded', 'abandoned')) = (settled_at IS NOT NULL)),
 CHECK ((state IN ('settled', 'superseded', 'abandoned')) = (settled_by IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX canonical_producer_unit_result_live ON canonical_producer_unit_result (origin, run_key, kind, unit_id) WHERE state IN ('open', 'refused_permanent', 'refused_recoverable');
CREATE INDEX canonical_producer_unit_result_due ON canonical_producer_unit_result (next_attempt_at) WHERE state IN ('open', 'refused_recoverable') AND retry_owner = 'unit';
CREATE INDEX canonical_producer_unit_result_unit ON canonical_producer_unit_result (origin, kind, unit_id, state);
CREATE INDEX canonical_producer_unit_result_state ON canonical_producer_unit_result (state, code);

-- Writes only while the marker allows canonical writes (d1/open); reads are never touched. At r2, prepared and held both tables stay empty or frozen.
CREATE TRIGGER canonical_producer_run_insert_open
BEFORE INSERT ON canonical_producer_run
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

CREATE TRIGGER canonical_producer_run_update_open
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

-- A new run is pass 1, passing, with no cursor, no strike, no counts and no completion: a pass cannot be born finished.
CREATE TRIGGER canonical_producer_run_insert_shape
BEFORE INSERT ON canonical_producer_run
FOR EACH ROW
WHEN NEW.pass_no <> 1 OR NEW.pass_state <> 'passing' OR NEW.cursor_kind IS NOT NULL OR NEW.cursor_id IS NOT NULL OR NEW.strike_count <> 0 OR NEW.stopped_by IS NOT NULL OR NEW.applied_generation IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.open_at_completion IS NOT NULL OR NEW.revision <> 1 OR NEW.n_applied <> 0 OR NEW.n_noop <> 0 OR NEW.n_kept <> 0 OR NEW.n_failed <> 0
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_run_insert');
END;

-- A run carries the live marker generation (a plan made under an older one is refused).
CREATE TRIGGER canonical_producer_run_insert_generation
BEFORE INSERT ON canonical_producer_run
FOR EACH ROW
WHEN NEW.marker_generation <> COALESCE((SELECT generation FROM film_person_authority WHERE id = 1), -1)
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_stale_generation');
END;

-- Dictionary version minting (ADR 0128 decision 4): d<n> (n > 1) needs the previous row d<n-1> to exist with a DIFFERENT snapshot digest (an equal one is reused, never minted). d1 needs no guard: the primary key (origin, run_key) with run_key = d<seq> makes a second d1 impossible, and no row exists without its predecessor (no delete), so the version line has no gap; the unique (origin, seq) index states the same for seq.
CREATE TRIGGER canonical_producer_run_insert_dictionary_prev
BEFORE INSERT ON canonical_producer_run
FOR EACH ROW
WHEN NEW.origin = 'dictionary' AND NEW.prev_seq > 0 AND NOT EXISTS (SELECT 1 FROM canonical_producer_run WHERE origin = 'dictionary' AND seq = NEW.prev_seq AND snapshot_digest <> NEW.snapshot_digest)
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_dictionary_prev');
END;

-- What identifies a run never changes.
CREATE TRIGGER canonical_producer_run_immutable
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NEW.origin <> OLD.origin OR NEW.run_key <> OLD.run_key OR NEW.seq IS NOT OLD.seq OR NEW.prev_seq IS NOT OLD.prev_seq OR NEW.snapshot_digest IS NOT OLD.snapshot_digest OR NEW.source_generation IS NOT OLD.source_generation OR NEW.created_at <> OLD.created_at
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_run_immutable');
END;

-- The recorded marker generation never goes down.
CREATE TRIGGER canonical_producer_run_generation
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NEW.marker_generation < OLD.marker_generation
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_stale_generation');
END;

-- The compare-and-set token moves by exactly one with every update (an update that forgets it is refused).
CREATE TRIGGER canonical_producer_run_revision
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NEW.revision <> OLD.revision + 1
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_run_revision');
END;

-- applied_generation moves only from NULL (the pass-complete commit); a passed run keeps its claim.
CREATE TRIGGER canonical_producer_run_applied_once
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN OLD.applied_generation IS NOT NULL AND NEW.applied_generation IS NOT OLD.applied_generation
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_run_applied');
END;

-- A plan change is one move (ADR 0128 decision 3): pass_no + 1, a new fingerprint, the cursor reset, the strike cleared, passing; and a pass_no that stays means the plan did not change.
CREATE TRIGGER canonical_producer_run_replay
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN (NEW.pass_no <> OLD.pass_no AND NOT (NEW.pass_no = OLD.pass_no + 1 AND NEW.fingerprint <> OLD.fingerprint AND NEW.cursor_kind IS NULL AND NEW.cursor_id IS NULL AND NEW.strike_count = 0 AND NEW.pass_state = 'passing' AND NEW.stopped_by IS NULL)) OR (NEW.pass_no = OLD.pass_no AND (NEW.fingerprint <> OLD.fingerprint OR NEW.plan_version <> OLD.plan_version OR NEW.unit_count <> OLD.unit_count))
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_run_replay');
END;

-- A systemic stop never adds or clears a strike (ADR 0128 decision 7).
CREATE TRIGGER canonical_producer_run_stop_strike
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NEW.pass_state = 'stopped' AND NOT (NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class AND NEW.strike_count = OLD.strike_count)
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_strike_stop');
END;

-- A strike resets to zero only with the cursor move of the unit outcome (success, the third strike) or a pass_no increase.
CREATE TRIGGER canonical_producer_run_strike_reset
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NOT (NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class AND NEW.strike_count = OLD.strike_count) AND NEW.strike_count = 0 AND NOT ((NEW.cursor_kind IS NOT OLD.cursor_kind OR NEW.cursor_id IS NOT OLD.cursor_id) OR NEW.pass_no > OLD.pass_no)
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_strike_reset');
END;

-- A strike write touches only the strike columns: the cursor does not move with it.
CREATE TRIGGER canonical_producer_run_strike_cursor
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NOT (NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class AND NEW.strike_count = OLD.strike_count) AND NEW.strike_count > 0 AND ((NEW.cursor_kind IS NOT OLD.cursor_kind OR NEW.cursor_id IS NOT OLD.cursor_id) OR NEW.pass_no <> OLD.pass_no)
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_strike_cursor');
END;

-- The count is monotone only while the strike identity (kind, id, digest, class) stays active, one at a time; a new identity starts at 1; a decrement is illegal.
CREATE TRIGGER canonical_producer_run_strike_step
BEFORE UPDATE ON canonical_producer_run
FOR EACH ROW
WHEN NOT (NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class AND NEW.strike_count = OLD.strike_count) AND NEW.strike_count > 0 AND ((OLD.strike_count > 0 AND NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class AND NEW.strike_count <> OLD.strike_count + 1) OR (NOT (OLD.strike_count > 0 AND NEW.strike_kind IS OLD.strike_kind AND NEW.strike_id IS OLD.strike_id AND NEW.strike_digest IS OLD.strike_digest AND NEW.strike_class IS OLD.strike_class) AND NEW.strike_count <> 1))
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_strike_step');
END;

-- Rows are never deleted (stabilization stance of the receipt table).
CREATE TRIGGER canonical_producer_run_no_delete
BEFORE DELETE ON canonical_producer_run
FOR EACH ROW
WHEN 1
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_immutable');
END;

CREATE TRIGGER canonical_producer_unit_result_insert_open
BEFORE INSERT ON canonical_producer_unit_result
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

CREATE TRIGGER canonical_producer_unit_result_update_open
BEFORE UPDATE ON canonical_producer_unit_result
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

-- A new result is live (open, refused_permanent or refused_recoverable): a terminal row is only ever reached by a move.
CREATE TRIGGER canonical_producer_unit_result_insert_shape
BEFORE INSERT ON canonical_producer_unit_result
FOR EACH ROW
WHEN NEW.state NOT IN ('open', 'refused_permanent', 'refused_recoverable')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_result_insert');
END;

-- What a result identifies, and its one retry owner, never change.
CREATE TRIGGER canonical_producer_unit_result_immutable
BEFORE UPDATE ON canonical_producer_unit_result
FOR EACH ROW
WHEN NEW.origin <> OLD.origin OR NEW.run_key <> OLD.run_key OR NEW.pass_no <> OLD.pass_no OR NEW.kind <> OLD.kind OR NEW.unit_id <> OLD.unit_id OR NEW.fingerprint <> OLD.fingerprint OR NEW.unit_digest <> OLD.unit_digest OR NEW.retry_owner <> OLD.retry_owner OR NEW.request_id IS NOT OLD.request_id OR NEW.created_at <> OLD.created_at
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_result_immutable');
END;

-- settled, superseded and abandoned are terminal: no update leaves them, not even one that changes nothing. The three live states move to each other and to any terminal state.
CREATE TRIGGER canonical_producer_unit_result_transition
BEFORE UPDATE ON canonical_producer_unit_result
FOR EACH ROW
WHEN OLD.state IN ('settled', 'superseded', 'abandoned')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_result_terminal');
END;

-- attempts only increase, by at most one per update.
CREATE TRIGGER canonical_producer_unit_result_attempts
BEFORE UPDATE ON canonical_producer_unit_result
FOR EACH ROW
WHEN NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_result_attempts');
END;

CREATE TRIGGER canonical_producer_unit_result_no_delete
BEFORE DELETE ON canonical_producer_unit_result
FOR EACH ROW
WHEN 1
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_immutable');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 20,
    note = 'Schema v20: durable canonical producer run and unit result tables (empty). Follows a complete version 19.'
WHERE id = 1 AND version = 19;
