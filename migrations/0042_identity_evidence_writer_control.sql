-- Schema v42: the identity evidence writer control and the ledger extensions of card EC (AIR-637; ADR 0215 Accepted, decisions 1, 4 and 6; follows E1, AIR-601, migration 0041).
-- One forward migration, in four parts, none of which changes an E1 row (the ledger is empty and stays so):
--  1. `identity_evidence_writer` (one durable control row per writer) and the append-only `identity_evidence_writer_change` (every transition with its reason, the deployed
--     version and the operator's evidence link). A writer with NO control row is `off` (ADR 0215 decision 4).
--  2. `film_identity_evidence.source_order`, the nullable causal position of an owner row in its own source (ADR 0215 decision 6).
--  3. The `known_alias` method value (ADR 0215 choice 0215-3 = B). The method set lives in the shape trigger, not in a column CHECK, so the trigger is replaced.
--  4. The domain path (ADR 0215 decision 1): a Discovery row names no Film and no canonical receipt. The Film/Person marker trigger now fences only Film-bound rows, and an
--     unbound row is admitted only as a `candidate_for(discovery_observation, tmdb_*)` row of the Discovery routes. Fencing of a domain row belongs to the writer's own batch.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy (applying it is card ECM, a separate production GO). Nothing writes the control
-- tables, so every writer reads as `off`; nothing writes a domain-path row; nothing reads the ledger. Activation of a writer is a separate owner-approved operation.
-- It follows a complete version 41 (0041) and refuses anything else before an object is created: the first statement inserts a second schema_contract row and so aborts the
-- file. The version becomes 42 and never goes down.
-- It needs no empty ledger: the new column is nullable and every trigger applies to later inserts only.
-- Identifiers, digests, versions, evidence links and ISO-8601 UTC times only: no title, name, payload or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every time CHECK is split into short GLOB and substr() tests.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 41
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_identity_evidence')
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'trigger' AND name IN (
   'film_identity_evidence_insert_open', 'film_identity_evidence_film_bound', 'film_identity_evidence_insert_shape', 'film_identity_evidence_insert_conflict',
   'film_identity_evidence_no_update', 'film_identity_evidence_no_delete'
  )
 ) = 6
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name IN ('identity_evidence_writer', 'identity_evidence_writer_change'))

);

-- 1. The writer control. The writer is the key, not the route, because one route (`owner_action`) has several writers.
CREATE TABLE identity_evidence_writer (
 writer TEXT PRIMARY KEY CHECK (writer IN ('discovery_decision', 'discovery_owner', 'claim_alias_bridge', 'tmdb_retirement_decision', 'tmdb_retirement_application')),
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
 writer TEXT NOT NULL CHECK (writer IN ('discovery_decision', 'discovery_owner', 'claim_alias_bridge', 'tmdb_retirement_decision', 'tmdb_retirement_application')),
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
CREATE INDEX identity_evidence_writer_change_writer ON identity_evidence_writer_change (writer, seq);

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

-- A change row is the compare-and-swap of one transition: it must start from the writer's CURRENT state (absent is `off`, generation 0) and name the next generation.
-- Two operators racing from the same generation cannot both land: the second one's change row is refused and its whole batch rolls back.
CREATE TRIGGER identity_evidence_writer_change_current
BEFORE INSERT ON identity_evidence_writer_change
FOR EACH ROW
WHEN NEW.from_state <> COALESCE((SELECT state FROM identity_evidence_writer WHERE writer = NEW.writer), 'off')
 OR NEW.generation <> COALESCE((SELECT generation FROM identity_evidence_writer WHERE writer = NEW.writer), 0) + 1
BEGIN
 SELECT RAISE(ABORT, 'identity_evidence_writer_change_stale');
END;

-- The control row moves only together with its change row (inserted first, in the same batch): never directly, never backwards, never deleted.
CREATE TRIGGER identity_evidence_writer_insert
BEFORE INSERT ON identity_evidence_writer
FOR EACH ROW
WHEN NEW.state <> 'pending' OR NEW.generation <> 1 OR NOT EXISTS (
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

-- 2. The causal position of an owner row within its own source (ADR 0215 decision 6): the observation's history revision, or the retirement decision's own `seq`. It is
-- comparable only within one causal scope and never decides anything by itself; `seq` orders insertion only. NOT part of the evidence key. Only an owner row carries one.
ALTER TABLE film_identity_evidence ADD COLUMN source_order INTEGER CHECK (source_order IS NULL OR source_order >= 1);

CREATE TRIGGER film_identity_evidence_source_order
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.source_order IS NOT NULL AND NEW.route <> 'owner_action'
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_source_order');
END;

-- 3. The shape trigger of 0041 with one method value added: `known_alias` (a Discovery decision that rested on a known alias title; never proof, ranked by the reader from
-- its `source_scope`, ADR 0215 Q1-a). Everything else is unchanged.
DROP TRIGGER film_identity_evidence_insert_shape;
CREATE TRIGGER film_identity_evidence_insert_shape
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.subject_kind NOT IN ('letterboxd_lid', 'letterboxd_short_code', 'tmdb_movie', 'tmdb_tv', 'discovery_observation', 'film')
 OR (NEW.object_kind IS NOT NULL AND NEW.object_kind NOT IN ('letterboxd_lid', 'letterboxd_short_code', 'tmdb_movie', 'tmdb_tv'))
 OR NEW.relation NOT IN ('same_work', 'film_has_id', 'candidate_for', 'exists')
 OR NEW.route NOT IN ('epg_programme', 'discovery_scan', 'letterboxd_export_import', 'letterboxd_rated_archive', 'ratings_diary', 'watchlist_admission', 'ratings_alias_bridge', 'owner_action', 'unknown')
 OR NEW.method NOT IN ('title_only', 'title_year', 'title_year_search', 'tmdb_detail_check', 'page_check', 'alias_bridge', 'owner_statement', 'known_alias')
 OR (NEW.relation = 'same_work' AND (NEW.subject_kind NOT IN ('letterboxd_lid', 'letterboxd_short_code', 'tmdb_movie', 'tmdb_tv') OR NEW.subject_kind || ':' || NEW.subject_value >= NEW.object_kind || ':' || NEW.object_value))
 OR (NEW.relation = 'film_has_id' AND NEW.subject_kind <> 'film')
 OR (NEW.relation <> 'film_has_id' AND NEW.subject_kind = 'film')
 OR (NEW.relation = 'candidate_for' AND (NEW.subject_kind <> 'discovery_observation' OR NEW.object_kind NOT IN ('tmdb_movie', 'tmdb_tv')))
 OR (NEW.subject_kind = 'film' AND (length(NEW.subject_value) < 6 OR substr(NEW.subject_value, 1, 5) <> 'film:'))
 OR (NEW.subject_kind IN ('tmdb_movie', 'tmdb_tv') AND (NEW.subject_value GLOB '*[^0-9]*' OR substr(NEW.subject_value, 1, 1) = '0'))
 OR (NEW.object_kind IN ('tmdb_movie', 'tmdb_tv') AND (NEW.object_value GLOB '*[^0-9]*' OR substr(NEW.object_value, 1, 1) = '0'))
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_shape');
END;

-- 4. The domain path. 0041 required the Film/Person marker (d1/open) for every insert and refused every unbound row. A Discovery row is about an observation, not a Film
-- mutation: it carries no Film target and no canonical receipt, and its fence is the domain's own (marker, lease, evidence-key assertion), carried by the writer's batch.
-- - A Film-bound row (the canonical path, unchanged) still needs the Film/Person marker d1/open.
-- - An unbound row is admitted only as `candidate_for(discovery_observation, tmdb_movie|tmdb_tv)` of the Discovery routes (`discovery_scan` for the decision writer,
--   `owner_action` for the owner writer). Every other unbound shape (a Watchlist lid, a short code, an `exists` sighting) stays refused until its own card brings its target and fence.
DROP TRIGGER film_identity_evidence_insert_open;
CREATE TRIGGER film_identity_evidence_insert_open
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.film_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_not_open');
END;

DROP TRIGGER film_identity_evidence_film_bound;
CREATE TRIGGER film_identity_evidence_film_bound
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.film_id IS NULL AND NOT (NEW.relation = 'candidate_for' AND NEW.subject_kind = 'discovery_observation' AND NEW.route IN ('discovery_scan', 'owner_action'))
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_unbound');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 42,
    note = 'Schema v42: the identity evidence writer control (absent = off), the ledger source_order and known_alias, and the domain-path trigger relaxation (inert until a writer is activated). Follows a complete version 41.'
WHERE id = 1 AND version = 41;
