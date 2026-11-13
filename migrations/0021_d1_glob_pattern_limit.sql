
-- Schema v21: the D1 limit on LIKE and GLOB patterns (AIR-374 H1). D1 refuses to EVALUATE a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too
-- complex", code 7500; observed on production 13 Nov 2026: a 50-byte pattern runs, a 51-byte one fails, even in a constant SELECT). CREATE TABLE accepts such a CHECK,
-- so 0014 and 0015 created four tables whose normalized-UTC time CHECK is a 92-byte pattern: every INSERT into them fails on D1 (the H1 load of film_rated_admission
-- and film_retention was refused at its first batch, nothing written). This file rebuilds those four tables with an EXACTLY equivalent CHECK made of short patterns
-- and substr() tests (length 24, YYYY-MM-DD, T, HH:MM:SS, ., three digits, Z); every other column, key and CHECK is unchanged.
-- It follows a COMPLETE version 20 and refuses anything else before a table is dropped: the first statement inserts a second schema_contract row and so aborts the
-- file. It also refuses unless the four tables exist and are EMPTY (all four are empty on production, nothing has ever written them), so no row can be lost.
-- The version becomes 21 and never goes down. A deploy does not apply this file, applying it writes no row, and no Worker code is changed by it.
-- Applying it to production D1 is a separate owner GO (docs/runbooks/film-person-0021-apply.md); nothing in the repository applies it. 0020 is applied first.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 20
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film',
   'person',
   'film_localization_source',
   'person_localization_source',
   'film_rated_admission',
   'film_retention',
   'canonical_producer_run'
  )
 ) = 7
 AND (SELECT COUNT(*) FROM film_localization_source) = 0
 AND (SELECT COUNT(*) FROM person_localization_source) = 0
 AND (SELECT COUNT(*) FROM film_rated_admission) = 0
 AND (SELECT COUNT(*) FROM film_retention) = 0
);

DROP TABLE film_localization_source;
DROP TABLE person_localization_source;
DROP TABLE film_rated_admission;
DROP TABLE film_retention;

CREATE TABLE film_localization_source (
 film_id TEXT NOT NULL REFERENCES film(id),
 source TEXT NOT NULL CHECK (source GLOB '[a-z]*' AND source NOT IN ('owner', 'dictionary', 'reviewed') AND length(source) <= 40),
 value TEXT NOT NULL CHECK (length(value) > 0),
 source_version TEXT NOT NULL CHECK (length(source_version) > 0),
 provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
 request_id TEXT NOT NULL CHECK (length(request_id) > 0),
 observed_at TEXT NOT NULL CHECK (length(observed_at) = 24 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND substr(observed_at, 20, 1) = '.' AND substr(observed_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(observed_at, 24, 1) = 'Z'),
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
 observed_at TEXT NOT NULL CHECK (length(observed_at) = 24 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND substr(observed_at, 20, 1) = '.' AND substr(observed_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(observed_at, 24, 1) = 'Z'),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (person_id, source)
) STRICT;

CREATE TABLE film_rated_admission (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 tmdb TEXT NOT NULL CHECK (tmdb GLOB '[1-9]*' AND tmdb NOT GLOB '*[^0-9]*' AND length(tmdb) <= 12),
 source_code TEXT NOT NULL CHECK (length(source_code) > 0),
 archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
 title TEXT,
 year INTEGER,
 receipt_key TEXT NOT NULL CHECK (length(receipt_key) > 0),
 receipt_film_key TEXT NOT NULL CHECK (receipt_film_key = 'tmdb_' || tmdb),
 verified_at TEXT NOT NULL CHECK (length(verified_at) = 24 AND substr(verified_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(verified_at, 11, 1) = 'T' AND substr(verified_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND substr(verified_at, 20, 1) = '.' AND substr(verified_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(verified_at, 24, 1) = 'Z'),
 request_id TEXT NOT NULL CHECK (length(request_id) > 0),
 updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX film_rated_admission_tmdb ON film_rated_admission (tmdb);
CREATE UNIQUE INDEX film_rated_admission_source_code ON film_rated_admission (source_code);

CREATE TABLE film_retention (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 basis TEXT NOT NULL CHECK (basis IN ('watchlist_fact')),
 watchlist INTEGER NOT NULL CHECK (watchlist IN (0, 1)),
 evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
 request_id TEXT NOT NULL CHECK (length(request_id) > 0),
 observed_at TEXT NOT NULL CHECK (length(observed_at) = 24 AND substr(observed_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(observed_at, 11, 1) = 'T' AND substr(observed_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND substr(observed_at, 20, 1) = '.' AND substr(observed_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(observed_at, 24, 1) = 'Z'),
 updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 21,
    note = 'Schema v21: the four normalized-UTC time CHECKs of 0014 and 0015 rebuilt under the D1 50-byte LIKE and GLOB pattern limit. Follows a complete version 20.'
WHERE id = 1 AND version = 20;
