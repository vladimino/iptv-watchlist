-- Schema v10: Letterboxd ratings, viewing facts, diary cursor and history,
-- the ratings run, and the removal queue (ADR 0084).
-- The operational path is a complete version 9. Production already has that
-- contract, including the owner-review tables. The file still accepts a
-- complete version 8: the ten prediction tables, the nine published-EPG
-- tables, and both authority rows. Owner-review tables are not part of
-- the prerequisite in this file.
-- The first statement refuses anything else and creates nothing.
-- The version becomes 10 and never goes down. This file does not rewrite
-- 0009. 0009 does not install after the contract is already 10.
-- A deploy does not apply this file. The inserted marker is mode r2 and
-- cutover open. Applying it copies no fact, diary, run or queue, and it
-- does not set mode d1.
-- ratings_document stores the mutable JSON objects, split into parts.
-- ratings_view is the projection of watched, actual rating and watchlist.
-- It is not a second owner: writers replace it in the same batch as the
-- fact. actual_rating in schema v1 is not this projection.
-- ratings_domain_cas is the batch fence, not a switch.
-- Events, archive receipts, ZIP bytes and HTML snapshots stay outside these tables.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 8 AND version < 10
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'prediction_domain_authority',
   'prediction_domain_cas',
   'prediction_profile',
   'prediction_fingerprint',
   'prediction_pointer',
   'prediction_lineage',
   'prediction_queue',
   'prediction_lease',
   'prediction_run',
   'prediction_domain_intent',
   'published_epg_authority',
   'published_epg_cas',
   'published_epg_generation',
   'published_epg_document',
   'published_epg_member',
   'published_epg_show',
   'published_epg_stage',
   'published_epg_stage_chunk',
   'published_epg_stage_row'
  )
 ) = 19
 AND EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id = 1)
 AND EXISTS (SELECT 1 FROM published_epg_authority WHERE id = 1)
);

CREATE TABLE ratings_domain_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 cutover TEXT NOT NULL CHECK (cutover IN ('open', 'held')),
 generation INTEGER NOT NULL
) STRICT;

CREATE TABLE ratings_domain_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok >= 1)
) STRICT;

CREATE TABLE ratings_document (
 key TEXT NOT NULL,
 part INTEGER NOT NULL CHECK (part >= 0),
 body TEXT NOT NULL,
 etag TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (key, part)
) STRICT;

CREATE TABLE ratings_view (
 alias_id TEXT PRIMARY KEY,
 fact_key TEXT NOT NULL,
 watched INTEGER CHECK (watched IS NULL OR watched IN (0, 1)),
 actual_rating REAL,
 watchlist INTEGER CHECK (watchlist IS NULL OR watchlist IN (0, 1)),
 rating_known INTEGER NOT NULL CHECK (rating_known IN (0, 1)),
 updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO ratings_domain_authority (id, mode, cutover, generation)
VALUES (1, 'r2', 'open', 0);
INSERT INTO ratings_domain_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 10,
    note = 'Schema v10: ratings authority. Marker mode r2 until a separate activation. Version 10 follows a complete version 8 or 9. This file does not rewrite 0009.'
WHERE id = 1 AND version >= 8 AND version < 10;
