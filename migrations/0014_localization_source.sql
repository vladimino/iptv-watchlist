-- Schema v14: automatic localization SOURCE values for canonical Film/Person (ADR 0099, Accepted; AIR-368).
-- It follows a complete version 13 (the canonical Film/Person authority tables of 0013) and refuses anything else before a table
-- is created: the first statement inserts a second schema_contract row and so aborts the file. The version becomes 14 and never
-- goes down.
-- A deploy does not apply this file, and applying it writes no row: both tables start empty and no Worker code calls them.
-- film_dimension / person_dimension keep ONE effective value per entity (status, authority, provenance) and stay as they are.
-- These tables hold the AUTOMATIC candidates only, one row per (entity, source), with the source version and provenance, apart
-- from that effective value. They never hold an owner or a reviewed value: owner_review_entry stays the authority of the owner
-- domain, a reviewed dictionary value lives in the dimension. The effective value is resolved at read as
-- owner > reviewed dictionary > automatic (src/localization-sources.js). Rows are written only by the fenced
-- recordLocalizationSources call, whose batch also proves the marker generation and the entity revision of 0013.
-- observed_at is always normalized UTC (YYYY-MM-DDTHH:MM:SS.mmmZ, enforced by a CHECK), so text order is chronological order and the SQL
-- monotonic guards of the writer and of a Film merge agree with the instants the code compares.
-- request_id is the replay key of the writer: the same request id with the same content is a no-op, the same id with other content is refused.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 13 AND version < 14
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film',
   'person',
   'film_person_authority',
   'film_person_cas',
   'film_person_baseline',
   'canonical_revision'
  )
 ) = 6
);

CREATE TABLE film_localization_source (
 film_id TEXT NOT NULL REFERENCES film(id),
 source TEXT NOT NULL CHECK (source GLOB '[a-z]*' AND source NOT IN ('owner', 'dictionary', 'reviewed') AND length(source) <= 40),
 value TEXT NOT NULL CHECK (length(value) > 0),
 source_version TEXT NOT NULL CHECK (length(source_version) > 0),
 provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
 request_id TEXT NOT NULL CHECK (length(request_id) > 0),
 observed_at TEXT NOT NULL CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (film_id, source)
) STRICT;

CREATE TABLE person_localization_source (
 person_id TEXT NOT NULL REFERENCES person(id),
 source TEXT NOT NULL CHECK (source GLOB '[a-z]*' AND source NOT IN ('owner', 'dictionary', 'reviewed') AND length(source) <= 40),
 value TEXT NOT NULL CHECK (length(value) > 0),
 source_version TEXT NOT NULL CHECK (length(source_version) > 0),
 provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
 request_id TEXT NOT NULL CHECK (length(request_id) > 0),
 observed_at TEXT NOT NULL CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (person_id, source)
) STRICT;


CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 14,
    note = 'Schema v14: automatic localization source values for canonical Film/Person, apart from the effective dimension. Follows a complete version 13.'
WHERE id = 1 AND version >= 13 AND version < 14;
