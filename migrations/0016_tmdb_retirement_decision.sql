-- Schema v16: the owner-only, append-only TMDB retirement decision history for canonical Film/Person (ADR 0099, Accepted, decision 7;
-- AIR-370). It follows a complete version 14 or 15 and refuses anything else before a table is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 16 and never goes down. The number leaves room for 0015 (a
-- parallel card); if the two merge in the other order the file only needs its number and its version guard adjusted.
-- A deploy does not apply this file and applying it writes no row: the table starts empty, no Worker code calls it, and the
-- identity/tmdb-retirements.json object in R2 (ADR 0057, AIR-291) stays the input of the enrichment projector.
-- tmdb_retirement_decision is APPEND-ONLY: a decision is never updated or deleted (triggers refuse both). One row records one owner decision
-- about one Film: 'retire' (the retired TMDB movie id, the live TMDB TV entry, the evidence and the owner's confirmation) or 'restore' (the
-- explicit owner-authored inverse of the latest retire, naming it in supersedes_seq). There is no implicit un-retirement: the current state
-- of a Film is its latest decision, and only a 'restore' row moves it back. request_id is the replay key (unique); payload_json is the
-- canonical content a replay must match. Movie and TV ids are separate namespaces and are stored in separate columns, never compared
-- with each other. The ledger holds decisions, not identity rows: applying a decision to film_external_id belongs to the later producer
-- integration (AIR-371) and goes through the fenced mutation boundary of 0013.
-- film_id is deliberately not a foreign key: the history must outlive a Film row; a Film merge refuses while it has a decision.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 14 AND version < 16
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film',
   'film_external_id',
   'film_person_authority',
   'film_person_cas',
   'film_person_baseline',
   'canonical_revision'
  )
 ) = 6
);

CREATE TABLE tmdb_retirement_decision (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 200),
 film_id TEXT NOT NULL CHECK (film_id GLOB 'film:?*'),
 kind TEXT NOT NULL CHECK (kind IN ('retire', 'restore')),
 lid TEXT NOT NULL CHECK (length(lid) BETWEEN 1 AND 16 AND lid NOT GLOB '*[^A-Za-z0-9]*'),
 movie_id TEXT NOT NULL CHECK (length(movie_id) BETWEEN 1 AND 10 AND movie_id GLOB '[1-9]*' AND movie_id NOT GLOB '*[^0-9]*'),
 tv_id TEXT NOT NULL CHECK (length(tv_id) BETWEEN 1 AND 10 AND tv_id GLOB '[1-9]*' AND tv_id NOT GLOB '*[^0-9]*'),
 evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
 confirmation_json TEXT NOT NULL CHECK (
  json_valid(confirmation_json) AND json_type(confirmation_json) = 'object'
  AND json_extract(confirmation_json, '$.by') = 'owner'
  AND length(COALESCE(json_extract(confirmation_json, '$.at'), '')) > 0
  AND length(COALESCE(json_extract(confirmation_json, '$.source'), '')) > 0
 ),
 origin TEXT NOT NULL CHECK (origin IN ('owner_request', 'r2_import')),
 input_sha256 TEXT CHECK (input_sha256 IS NULL OR (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*')),
 supersedes_seq INTEGER REFERENCES tmdb_retirement_decision (seq),
 payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
 recorded_at TEXT NOT NULL CHECK (length(recorded_at) > 0),
 CHECK ((kind = 'retire' AND supersedes_seq IS NULL) OR (kind = 'restore' AND supersedes_seq IS NOT NULL)),
 CHECK (origin <> 'r2_import' OR (kind = 'retire' AND input_sha256 IS NOT NULL))
) STRICT;

CREATE INDEX tmdb_retirement_decision_film ON tmdb_retirement_decision (film_id, seq);
CREATE INDEX tmdb_retirement_decision_tv ON tmdb_retirement_decision (tv_id);

CREATE TRIGGER tmdb_retirement_decision_no_update
BEFORE UPDATE ON tmdb_retirement_decision
BEGIN
 SELECT RAISE(ABORT, 'tmdb_retirement_append_only');
END;

CREATE TRIGGER tmdb_retirement_decision_no_delete
BEFORE DELETE ON tmdb_retirement_decision
BEGIN
 SELECT RAISE(ABORT, 'tmdb_retirement_append_only');
END;

-- A retire needs the Film not to be retired already, and its TV entry not to be the active retirement of another Film.
CREATE TRIGGER tmdb_retirement_decision_retire
BEFORE INSERT ON tmdb_retirement_decision
FOR EACH ROW
WHEN NEW.kind = 'retire'
BEGIN
 SELECT RAISE(ABORT, 'tmdb_retirement_active')
 WHERE EXISTS (
  SELECT 1 FROM tmdb_retirement_decision d
  WHERE d.film_id = NEW.film_id AND d.kind = 'retire'
  AND d.seq = (SELECT MAX(seq) FROM tmdb_retirement_decision WHERE film_id = NEW.film_id)
 );
 SELECT RAISE(ABORT, 'tmdb_retirement_tv_collision')
 WHERE EXISTS (
  SELECT 1 FROM tmdb_retirement_decision d
  WHERE d.film_id <> NEW.film_id AND d.kind = 'retire' AND d.tv_id = NEW.tv_id
  AND d.seq = (SELECT MAX(seq) FROM tmdb_retirement_decision WHERE film_id = d.film_id)
 );
END;

-- A restore is the explicit inverse of the latest retire of the same Film, with the same ids, and nothing else.
CREATE TRIGGER tmdb_retirement_decision_restore
BEFORE INSERT ON tmdb_retirement_decision
FOR EACH ROW
WHEN NEW.kind = 'restore'
BEGIN
 SELECT RAISE(ABORT, 'tmdb_restore_invalid')
 WHERE NOT EXISTS (
  SELECT 1 FROM tmdb_retirement_decision d
  WHERE d.seq = NEW.supersedes_seq AND d.kind = 'retire' AND d.film_id = NEW.film_id
  AND d.movie_id = NEW.movie_id AND d.tv_id = NEW.tv_id AND d.lid = NEW.lid
  AND d.seq = (SELECT MAX(seq) FROM tmdb_retirement_decision WHERE film_id = NEW.film_id)
 );
END;

-- The current state of each Film is its latest decision; only a 'restore' row moves it back to active.
CREATE VIEW tmdb_retirement_current AS
SELECT d.film_id, d.seq, d.kind AS state, d.lid, d.movie_id, d.tv_id, d.request_id, d.recorded_at
FROM tmdb_retirement_decision d
WHERE d.seq = (SELECT MAX(seq) FROM tmdb_retirement_decision WHERE film_id = d.film_id);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 16,
    note = 'Schema v16: owner-only append-only TMDB retirement decision history for canonical Film/Person. Follows a complete version 14 or 15.'
WHERE id = 1 AND version >= 14 AND version < 16;
