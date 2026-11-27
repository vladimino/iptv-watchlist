-- Schema v52: the identity evidence writer `lid_tmdb_attach` (AIR-675, delivery step 6 of ADR 0217, Accepted, decisions 7 and 8; ADR 0215 Accepted, decision 4). A SEPARATE forward migration: 0042 is never edited.
-- ADR 0217 decision 7: the delivered writer control admits exactly five writers, in the CHECK of `identity_evidence_writer` and of `identity_evidence_writer_change`. The attach writer cannot simply be turned on, so
-- this file extends BOTH tables' writer CHECK by one value, `lid_tmdb_attach`, and changes nothing else. SQLite cannot alter a CHECK, so both tables are rebuilt with the SAME columns, constraints, unique index and
-- triggers as 0042 (the table and trigger text below is taken from 0042 verbatim except the writer list), and every existing row is copied with its values unchanged (the control rows, and the append-only history with its
-- own `seq` values, so `AUTOINCREMENT` continues after the highest). The eight triggers are dropped before the copy and recreated after it, so the copy fires none of them and the history is never replayed or altered.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it is a separate owner approval, part of the exact pre-activation chain of the attach (ADR 0217 delivery step 7b). It
-- does NOT activate the writer: a writer with NO control row is `off` (ADR 0215 decision 4), and the attach refuses `evidence_writer_inactive` until the owner's activation (`pending`, drain evidence, then `on`).
-- No Worker version that does not contain the attach reads or writes the new value, so an older Worker is unaffected (it reads the five writers it knows; a sixth row is invisible to it, and it cannot write one).
-- It follows a complete version 51 and refuses anything else before an object is touched: the first statement inserts a row that CHECK (id = 1) forbids (id 0) and so aborts the file. The version becomes 52 and never
-- goes down. Atomicity: a file is applied as one transaction; any failure rolls the rebuild back whole and leaves the version at 51.
-- Identifiers, digests, versions, evidence links and ISO-8601 UTC times only: no title, name, payload or personal data.

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 51)
 AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('identity_evidence_writer', 'identity_evidence_writer_change', 'film_identity_evidence', 'lid_recheck_intent')) = 4
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'trigger' AND name IN (
   'identity_evidence_writer_change_no_update', 'identity_evidence_writer_change_no_delete', 'identity_evidence_writer_change_conflict', 'identity_evidence_writer_change_current',
   'identity_evidence_writer_change_apply', 'identity_evidence_writer_insert', 'identity_evidence_writer_update', 'identity_evidence_writer_no_delete'
  )
 ) = 8
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'identity_evidence_writer_change_writer')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'identity_evidence_writer%_hold')
);

-- 1. Drop the eight triggers of 0042 (their bodies name the tables being rebuilt) so the copy below fires none of them.
DROP TRIGGER identity_evidence_writer_change_no_update;
DROP TRIGGER identity_evidence_writer_change_no_delete;
DROP TRIGGER identity_evidence_writer_change_conflict;
DROP TRIGGER identity_evidence_writer_change_current;
DROP TRIGGER identity_evidence_writer_change_apply;
DROP TRIGGER identity_evidence_writer_insert;
DROP TRIGGER identity_evidence_writer_update;
DROP TRIGGER identity_evidence_writer_no_delete;

-- 2. Hold every row in plain staging tables, then drop the old tables. (No RENAME: SQLite refuses a rename while any trigger names a missing table, and the import-run triggers of 0044 name
-- `identity_evidence_writer` by design; they are not touched by this file and resolve again as soon as the rebuilt table exists. Nothing fires between the drop and the recreate: the statements are one transaction.)
CREATE TABLE identity_evidence_writer_hold AS SELECT writer, state, generation, coverage_from, updated_at FROM identity_evidence_writer;
CREATE TABLE identity_evidence_writer_change_hold AS
 SELECT seq, writer, kind, from_state, to_state, generation, reason, deployed_version, evidence_link, drain_evidence, break_from, recorded_at FROM identity_evidence_writer_change;
DROP TABLE identity_evidence_writer_change;
DROP TABLE identity_evidence_writer;

-- 3. The rebuilt tables, with the writer CHECK extended by `lid_tmdb_attach` (text of 0042 otherwise unchanged).
CREATE TABLE identity_evidence_writer (
 writer TEXT PRIMARY KEY CHECK (writer IN ('discovery_decision', 'discovery_owner', 'claim_alias_bridge', 'tmdb_retirement_decision', 'tmdb_retirement_application', 'lid_tmdb_attach')),
 state TEXT NOT NULL CHECK (state IN ('off', 'pending', 'on')),
 -- Compare-and-swap token: 1 on the first row, +1 on every transition. An absent row is generation 0 and `off`.
 generation INTEGER NOT NULL CHECK (generation >= 1),
 -- The time of the `pending -> on` flip: coverage starts here, not at `off -> pending` (ADR 0215 decision 4). NULL unless `on`.
 coverage_from TEXT CHECK (coverage_from IS NULL OR (length(coverage_from) BETWEEN 20 AND 32 AND substr(coverage_from, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(coverage_from, 11, 1) = 'T' AND substr(coverage_from, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(coverage_from, -1) = 'Z' AND coverage_from NOT GLOB '*[^0-9TZ:.-]*')),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(updated_at, -1) = 'Z' AND updated_at NOT GLOB '*[^0-9TZ:.-]*'),
 CHECK ((state = 'on') = (coverage_from IS NOT NULL))
) STRICT;

-- Every transition, append-only. `generation` is the control row's generation AFTER the transition. `activate` is `off -> pending`, `drain_complete` is `pending -> on` and
-- needs the drain evidence, `deactivate` is `pending -> off` or `on -> off` (the end of coverage), `break` is the operator's record of a rollback to a version without the
-- writer (`pending|on -> off`) and names the deployment that broke the interval.
CREATE TABLE identity_evidence_writer_change (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 writer TEXT NOT NULL CHECK (writer IN ('discovery_decision', 'discovery_owner', 'claim_alias_bridge', 'tmdb_retirement_decision', 'tmdb_retirement_application', 'lid_tmdb_attach')),
 kind TEXT NOT NULL CHECK (kind IN ('activate', 'drain_complete', 'deactivate', 'break')),
 from_state TEXT NOT NULL CHECK (from_state IN ('off', 'pending', 'on')),
 to_state TEXT NOT NULL CHECK (to_state IN ('off', 'pending', 'on')),
 generation INTEGER NOT NULL CHECK (generation >= 1),
 reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 -- The deployed code version (a commit or Worker version id) at the time of the operation.
 deployed_version TEXT NOT NULL CHECK (length(deployed_version) BETWEEN 1 AND 100),
 -- The operator's evidence link (a Trello comment, a PR comment or an evidence file).
 evidence_link TEXT NOT NULL CHECK (length(evidence_link) BETWEEN 1 AND 500),
 -- `drain_complete` only: the proof that only versions containing the writer can commit its step (ADR 0215 decision 4, step 2). An elapsed interval alone is not evidence.
 drain_evidence TEXT CHECK (drain_evidence IS NULL OR length(drain_evidence) BETWEEN 1 AND 1000),
 -- `break` only: the time of the deployment of the version without the writer, from which the interval is broken.
 break_from TEXT CHECK (break_from IS NULL OR (length(break_from) BETWEEN 20 AND 32 AND substr(break_from, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(break_from, 11, 1) = 'T' AND substr(break_from, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(break_from, -1) = 'Z' AND break_from NOT GLOB '*[^0-9TZ:.-]*')),
 recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 32 AND substr(recorded_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(recorded_at, 11, 1) = 'T' AND substr(recorded_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(recorded_at, -1) = 'Z' AND recorded_at NOT GLOB '*[^0-9TZ:.-]*'),
 CHECK ((kind = 'activate' AND from_state = 'off' AND to_state = 'pending')
  OR (kind = 'drain_complete' AND from_state = 'pending' AND to_state = 'on')
  OR (kind = 'deactivate' AND from_state IN ('pending', 'on') AND to_state = 'off')
  OR (kind = 'break' AND from_state IN ('pending', 'on') AND to_state = 'off')),
 CHECK ((kind = 'drain_complete') = (drain_evidence IS NOT NULL)),
 CHECK ((kind = 'break') = (break_from IS NOT NULL))
) STRICT;
-- Each writer/generation has exactly ONE transition, ever (the unique index), so history cannot fork or accumulate orphans.

-- 4. Copy every row back unchanged (control rows; the change history with its own seq), then drop the staging tables.
INSERT INTO identity_evidence_writer (writer, state, generation, coverage_from, updated_at) SELECT writer, state, generation, coverage_from, updated_at FROM identity_evidence_writer_hold;
INSERT INTO identity_evidence_writer_change (seq, writer, kind, from_state, to_state, generation, reason, deployed_version, evidence_link, drain_evidence, break_from, recorded_at)
 SELECT seq, writer, kind, from_state, to_state, generation, reason, deployed_version, evidence_link, drain_evidence, break_from, recorded_at FROM identity_evidence_writer_change_hold ORDER BY seq;
DROP TABLE identity_evidence_writer_hold;
DROP TABLE identity_evidence_writer_change_hold;

-- 5. The unique index and the eight triggers of 0042, verbatim.
CREATE UNIQUE INDEX identity_evidence_writer_change_writer ON identity_evidence_writer_change (writer, generation);

CREATE TRIGGER identity_evidence_writer_change_no_update
BEFORE UPDATE ON identity_evidence_writer_change
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_change_append_only');
END;

CREATE TRIGGER identity_evidence_writer_change_no_delete
BEFORE DELETE ON identity_evidence_writer_change
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_change_append_only');
END;

-- Append-only also against a conflict policy (the same bypass 0041 closes for the ledger): `INSERT OR REPLACE`, `REPLACE` or an upsert would delete a conflicting change row
-- without a DELETE trigger while recursive triggers are off. This guard fires BEFORE the conflict is resolved, whatever the policy and the recursive-trigger setting: a taken
-- `seq` or a taken writer/generation is refused.
CREATE TRIGGER identity_evidence_writer_change_conflict
BEFORE INSERT ON identity_evidence_writer_change
FOR EACH ROW
WHEN (NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM identity_evidence_writer_change WHERE seq = NEW.seq))
 OR EXISTS (SELECT 1 FROM identity_evidence_writer_change WHERE writer = NEW.writer AND generation = NEW.generation)
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_change_taken');
END;

-- A change row is the compare-and-swap of one transition: it must start from the writer's CURRENT state (absent is `off`, generation 0) and name the next generation.
-- Two operators racing from the same generation cannot both land: the second one's change row is refused.
CREATE TRIGGER identity_evidence_writer_change_current
BEFORE INSERT ON identity_evidence_writer_change
FOR EACH ROW
WHEN NEW.from_state <> COALESCE((SELECT state FROM identity_evidence_writer WHERE writer = NEW.writer), 'off')
 OR NEW.generation <> COALESCE((SELECT generation FROM identity_evidence_writer WHERE writer = NEW.writer), 0) + 1
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_change_stale');
END;

-- History and control are INSEPARABLE: the operator writes ONLY the change row, and this trigger applies the transition to the control row in the same statement (first
-- activation inserts it, every other transition updates it by writer and previous generation). The change row therefore never commits alone, and the control row is only ever
-- the result of exactly one recorded transition. `coverage_from` is the flip time of `drain_complete`, NULL otherwise.
CREATE TRIGGER identity_evidence_writer_change_apply
AFTER INSERT ON identity_evidence_writer_change
FOR EACH ROW
BEGIN
 INSERT INTO identity_evidence_writer (writer, state, generation, coverage_from, updated_at)
 SELECT NEW.writer, NEW.to_state, NEW.generation, NULL, NEW.recorded_at
 WHERE NEW.generation = 1;
 UPDATE identity_evidence_writer
 SET state = NEW.to_state, generation = NEW.generation,
     coverage_from = CASE WHEN NEW.to_state = 'on' THEN NEW.recorded_at ELSE NULL END,
     updated_at = NEW.recorded_at
 WHERE writer = NEW.writer AND generation = NEW.generation - 1 AND state = NEW.from_state AND NEW.generation > 1;
END;

-- The control row cannot be written directly: it appears (`pending`, generation 1) or moves (exactly generation + 1) only together with the change row that records that very
-- transition, never replaced or reset (an existing writer row refuses any insert, whatever the conflict policy), never deleted.
CREATE TRIGGER identity_evidence_writer_insert
BEFORE INSERT ON identity_evidence_writer
FOR EACH ROW
WHEN NEW.state <> 'pending' OR NEW.generation <> 1
 OR EXISTS (SELECT 1 FROM identity_evidence_writer WHERE writer = NEW.writer)
 OR NOT EXISTS (
  SELECT 1 FROM identity_evidence_writer_change AS c
  WHERE c.writer = NEW.writer AND c.generation = 1 AND c.kind = 'activate' AND c.from_state = 'off' AND c.to_state = 'pending' AND c.recorded_at = NEW.updated_at
 )
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_transition');
END;

CREATE TRIGGER identity_evidence_writer_update
BEFORE UPDATE ON identity_evidence_writer
FOR EACH ROW
WHEN NEW.writer <> OLD.writer OR NEW.generation <> OLD.generation + 1 OR NOT EXISTS (
 SELECT 1 FROM identity_evidence_writer_change AS c
 WHERE c.writer = NEW.writer AND c.generation = NEW.generation AND c.from_state = OLD.state AND c.to_state = NEW.state AND c.recorded_at = NEW.updated_at
 AND (NEW.state <> 'on' OR c.recorded_at = NEW.coverage_from)
)
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_transition');
END;

CREATE TRIGGER identity_evidence_writer_no_delete
BEFORE DELETE ON identity_evidence_writer
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_no_delete');
END;

UPDATE schema_contract
SET version = 52,
    note = 'Schema v52: the identity evidence writer control admits the sixth writer lid_tmdb_attach (AIR-675, ADR 0217 decision 7); both tables rebuilt with their rows and triggers unchanged. Inert until the owner activates the writer. Version 52 follows a complete version 51.'
WHERE id = 1 AND version = 51;
