-- Schema v41: the Film identity evidence ledger, initial slice (ADR 0213, Accepted; AIR-601, card E1 of the ADR 0207 delivery graph). One row per typed,
-- source-aware PROPOSITION about a subject (and, for a relation, an object): who observed it (`route`), how it was established (`method`), the underlying source content
-- (`source_root`), the route's own reference (`source_ref`), the part a reader filters on (`source_scope`), and one of three polarities (`asserts`, `restricts`,
-- `refutes`). It sits BESIDE the canonical claims (`film_external_id`) and decides nothing: no reader uses it when it is introduced (ADR 0213 decision 8).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO (card M1 of ADR 0207). No
-- Worker code reads or writes the table: the writer helper (src/identity-evidence.js) is not bundled and nothing calls it until card A1. The table starts EMPTY and nothing
-- is backfilled; the historical reconstruction (ADR 0213 decision 6, cards E3a and E3b) is a separate owner decision with its own GO.
-- It follows a complete version 40 (0040, the retirement ledger movie index, after 0039, the receipt operation key) and refuses anything else before a table is created:
-- the first statement inserts a second schema_contract row and so aborts the file. The version becomes 41 and never goes down. It was written as 0040 and renumbered
-- to 0041 at merge because AIR-667's 0040 landed first.
-- APPEND-ONLY: there is no update and no delete (triggers). A wrong row is answered by a later row (a scoped `refutes`), never by an edit. `seq` orders rows causally.
-- Identifiers, digests, typed source ids and ISO-8601 UTC times only: no title, name, payload or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every time CHECK is split into short GLOB and substr() tests.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 40
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_person_authority', 'canonical_revision', 'canonical_write_receipt', 'canonical_producer_outcome')
 ) = 4
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_write_receipt' AND sql LIKE '%operation_key%')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tmdb_retirement_decision_movie')
);

CREATE TABLE film_identity_evidence (
 -- Causal order of the ledger: monotonic, never reused (AUTOINCREMENT; rows are never deleted).
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 -- sha256 of the normalized proposition, polarity, route, method, source_root (or, only when it is unknown, reconstructed_from), source_scope, scope_evidence_key and
 -- supersedes_key (src/identity-evidence.js `evidenceKeyOf`). UNIQUE: an insert of an existing key is a no-op for the writer (ON CONFLICT DO NOTHING).
 evidence_key TEXT NOT NULL UNIQUE CHECK (length(evidence_key) = 64 AND evidence_key NOT GLOB '*[^0-9a-f]*'),
 -- The Film the row is bound to: the receipted target of the batch that wrote it (the admitted or existing Film). No foreign key, like the Discovery and prediction
 -- Film ids: a merged Film's rows keep the id they were written for and readers resolve it through film_redirect. The column is nullable for the unbound observations
 -- that card EP plans; the initial slice refuses NULL with its own trigger below, which a later forward migration may drop without a table change.
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
 -- A refutation scoped to ONE earlier row (ADR 0213 decision 3); NULL: about the proposition as a whole.
 scope_evidence_key TEXT CHECK (scope_evidence_key IS NULL OR (length(scope_evidence_key) = 64 AND scope_evidence_key NOT GLOB '*[^0-9a-f]*')),
 -- The row this one supersedes (ADR 0213 decision 5). Part of this row's key; a unique index lets each row be superseded at most once.
 supersedes_key TEXT CHECK (supersedes_key IS NULL OR (length(supersedes_key) = 64 AND supersedes_key NOT GLOB '*[^0-9a-f]*')),
 -- When the method was performed. NULL only on a reconstructed row whose source does not record it.
 observed_at TEXT CHECK (observed_at IS NULL OR (length(observed_at) BETWEEN 20 AND 32 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(observed_at, -1) = 'Z' AND observed_at NOT GLOB '*[^0-9TZ:.-]*')),
 -- Reconstruction provenance (ADR 0213 decision 6), present from this schema so no later table change is needed: `live` rows carry neither run nor source record.
 origin TEXT NOT NULL CHECK (origin IN ('live', 'reconstruction')),
 reconstruction_run TEXT CHECK (reconstruction_run IS NULL OR length(reconstruction_run) BETWEEN 1 AND 200),
 reconstructed_from TEXT CHECK (reconstructed_from IS NULL OR length(reconstructed_from) BETWEEN 1 AND 300),
 -- The canonical receipt request id of the batch that wrote the row (an admission batch or an `identity_evidence` operation).
 request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
 recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 32 AND substr(recorded_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(recorded_at, 11, 1) = 'T' AND substr(recorded_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(recorded_at, -1) = 'Z' AND recorded_at NOT GLOB '*[^0-9TZ:.-]*'),
 CHECK ((object_kind IS NULL) = (object_value IS NULL)),
 -- `exists` has no object; every other relation has one.
 CHECK ((relation = 'exists') = (object_kind IS NULL)),
 CHECK (origin = 'reconstruction' OR (reconstruction_run IS NULL AND reconstructed_from IS NULL)),
 CHECK (origin = 'live' OR (reconstruction_run IS NOT NULL AND reconstructed_from IS NOT NULL)),
 -- Unknowns stay explicit and are allowed ONLY on a reconstructed row: route `unknown`, a NULL root, a NULL observation time.
 CHECK (origin = 'reconstruction' OR (route <> 'unknown' AND source_root IS NOT NULL AND observed_at IS NOT NULL)),
 -- `title_year_search` is never proof: it appears only in `restricts` rows (ADR 0213 decision 3).
 CHECK (method <> 'title_year_search' OR polarity = 'restricts'),
 -- Only an owner statement and a verified contradiction (a page check) refute.
 CHECK (polarity <> 'refutes' OR method IN ('owner_statement', 'page_check')),
 -- Only a refutation is scoped to an earlier row; no row scopes or supersedes itself.
 CHECK (scope_evidence_key IS NULL OR (polarity = 'refutes' AND scope_evidence_key <> evidence_key)),
 CHECK (supersedes_key IS NULL OR supersedes_key <> evidence_key)
) STRICT;

-- ADR 0213 Consequences: indexes on the evidence key (the UNIQUE constraint above), the subject, the object and the source scope.
CREATE INDEX film_identity_evidence_subject ON film_identity_evidence (subject_kind, subject_value);
CREATE INDEX film_identity_evidence_object ON film_identity_evidence (object_kind, object_value) WHERE object_kind IS NOT NULL;
CREATE INDEX film_identity_evidence_scope ON film_identity_evidence (source_scope) WHERE source_scope IS NOT NULL;
-- Each row is superseded at most once, so a chain of supersessions is linear (ADR 0213 decision 5).
CREATE UNIQUE INDEX film_identity_evidence_superseded_once ON film_identity_evidence (supersedes_key) WHERE supersedes_key IS NOT NULL;

-- Writes only while the Film/Person marker allows canonical writes (d1/open), as for the receipt and producer tables. Reads are never touched.
CREATE TRIGGER film_identity_evidence_insert_open
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_not_open');
END;

-- Append-only also against a conflict policy. `INSERT OR REPLACE` (or `REPLACE`, or an upsert's REPLACE) deletes the conflicting row without firing a DELETE trigger
-- while recursive triggers are off, the SQLite default, so the no-delete trigger alone cannot stop it. This trigger fires BEFORE the conflict is resolved, whatever the
-- policy and the recursive-trigger setting: an existing evidence key is an exact replay and inserts nothing (RAISE(IGNORE): the row, its seq and payload are kept, as
-- the writer's ON CONFLICT DO NOTHING intends); an explicit seq already used, or a second supersession of the same row, is refused.
CREATE TRIGGER film_identity_evidence_insert_conflict
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
BEGIN
 SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM film_identity_evidence WHERE evidence_key = NEW.evidence_key);
 SELECT RAISE(ABORT, 'film_identity_evidence_seq_taken') WHERE NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM film_identity_evidence WHERE seq = NEW.seq);
 SELECT RAISE(ABORT, 'film_identity_evidence_superseded_once')
 WHERE NEW.supersedes_key IS NOT NULL AND EXISTS (SELECT 1 FROM film_identity_evidence WHERE supersedes_key = NEW.supersedes_key);
END;

-- Append-only (ADR 0213 decision 5): no row is ever changed or deleted.
CREATE TRIGGER film_identity_evidence_no_update
BEFORE UPDATE ON film_identity_evidence
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_append_only');
END;

CREATE TRIGGER film_identity_evidence_no_delete
BEFORE DELETE ON film_identity_evidence
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_append_only');
END;

-- The model of ADR 0213 decisions 1 and 2: the closed sets of subject kinds, relations, routes and methods, and which kinds each relation joins. A trigger rather than
-- column CHECKs so a later decision (card EP) can widen a set with a forward migration instead of a table rebuild.
-- - same_work: two source entities, stored in canonical order (subject `kind:value` sorts before object `kind:value`), so A-B and B-A are one proposition;
-- - film_has_id: a canonical Film holds a source id;
-- - candidate_for: a Discovery observation is a candidate for a TMDB movie or TV id;
-- - exists: a source entity or a Discovery observation was observed (no object).
-- A TMDB value is digits only and a Film value is a `film:` id.
CREATE TRIGGER film_identity_evidence_insert_shape
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.subject_kind NOT IN ('letterboxd_lid', 'letterboxd_short_code', 'tmdb_movie', 'tmdb_tv', 'discovery_observation', 'film')
 OR (NEW.object_kind IS NOT NULL AND NEW.object_kind NOT IN ('letterboxd_lid', 'letterboxd_short_code', 'tmdb_movie', 'tmdb_tv'))
 OR NEW.relation NOT IN ('same_work', 'film_has_id', 'candidate_for', 'exists')
 OR NEW.route NOT IN ('epg_programme', 'discovery_scan', 'letterboxd_export_import', 'letterboxd_rated_archive', 'ratings_diary', 'watchlist_admission', 'ratings_alias_bridge', 'owner_action', 'unknown')
 OR NEW.method NOT IN ('title_only', 'title_year', 'title_year_search', 'tmdb_detail_check', 'page_check', 'alias_bridge', 'owner_statement')
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

-- Initial slice (ADR 0213 decision 7): every row is Film-bound. Unbound observations (a Watchlist lid, a short code in an archive, a Discovery observation before a
-- Film exists) are planned by card EP with their own target and fence; until then they stay in their own domains and this trigger refuses them.
CREATE TRIGGER film_identity_evidence_film_bound
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.film_id IS NULL
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_unbound');
END;

-- A scoped refutation names an existing row of the same proposition.
CREATE TRIGGER film_identity_evidence_scope_target
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.scope_evidence_key IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM film_identity_evidence AS p
 WHERE p.evidence_key = NEW.scope_evidence_key
 AND p.subject_kind = NEW.subject_kind AND p.subject_value = NEW.subject_value AND p.relation = NEW.relation
 AND p.object_kind IS NEW.object_kind AND p.object_value IS NEW.object_value
)
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_scope');
END;

-- Supersession is explicit (ADR 0213 decision 5): only an existing row with the same normalized proposition, route and source_scope.
CREATE TRIGGER film_identity_evidence_supersedes_target
BEFORE INSERT ON film_identity_evidence
FOR EACH ROW
WHEN NEW.supersedes_key IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM film_identity_evidence AS p
 WHERE p.evidence_key = NEW.supersedes_key
 AND p.subject_kind = NEW.subject_kind AND p.subject_value = NEW.subject_value AND p.relation = NEW.relation
 AND p.object_kind IS NEW.object_kind AND p.object_value IS NEW.object_value
 AND p.route = NEW.route AND p.source_scope IS NEW.source_scope
)
BEGIN
 SELECT RAISE(ABORT, 'film_identity_evidence_supersedes');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 41,
    note = 'Schema v41: the Film identity evidence ledger (empty, append-only, inert until written by the admission routes). Follows a complete version 40.'
WHERE id = 1 AND version = 40;
