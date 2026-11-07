-- Schema v15: D1-owned canonical Film admission for verified rated-archive Films and the watchlist retention fact
-- (ADR 0099, Accepted; ADR 0086 and 0087; AIR-369).
-- It follows a complete version 14 and refuses anything else before a table is created: the first statement inserts a second
-- schema_contract row and so aborts the file. The version becomes 15 and never goes down.
-- A deploy does not apply this file, and applying it writes no row: both tables start empty and no Worker code calls them.
-- film_rated_admission is the D1 form of one verified entry of letterboxd/admissions/verified-films.json (key tmdb_<n>). That R2
-- object stays the immutable evidence and receipt (receipt_key / receipt_film_key name it); after a cutover it is not a second
-- mutable owner. A row exists only for a verified admission: a tmdb id, the Letterboxd short code that was verified, the archive
-- digest and the verification time. The short code is a historical alias of the Film and is never a Letterboxd lid.
-- film_retention is the watchlist fact that keeps a Film after it leaves the current lists (ADR 0086), replacing the boolean
-- `watchlist` flag of enrichment/view-index.json as the thing that decides which Films exist. Membership itself stays in
-- watchlist_film; a retention row exists whether or not the Film is a member now.
-- observed_at is normalized UTC (CHECK), so text order is chronological order for the monotonic guards of the writer and of a merge.
-- The pre-Film rated-candidate queue is not here (AIR-343): a candidate that is not verified is not a Film and has no row.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 14 AND version < 15
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film',
   'film_external_id',
   'film_alias',
   'watchlist_film',
   'film_person_authority',
   'canonical_revision',
   'film_localization_source'
  )
 ) = 7
);

CREATE TABLE film_rated_admission (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 tmdb TEXT NOT NULL CHECK (tmdb GLOB '[1-9]*' AND tmdb NOT GLOB '*[^0-9]*' AND length(tmdb) <= 12),
 source_code TEXT NOT NULL CHECK (length(source_code) > 0),
 archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
 title TEXT,
 year INTEGER,
 receipt_key TEXT NOT NULL CHECK (length(receipt_key) > 0),
 receipt_film_key TEXT NOT NULL CHECK (receipt_film_key = 'tmdb_' || tmdb),
 verified_at TEXT NOT NULL CHECK (verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
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
 observed_at TEXT NOT NULL CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
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
SET version = 15,
    note = 'Schema v15: D1-owned verified rated-archive admission and watchlist retention fact for canonical Film. Follows a complete version 14.'
WHERE id = 1 AND version >= 14 AND version < 15;
