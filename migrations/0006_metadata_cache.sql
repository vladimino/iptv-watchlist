-- Schema v6: the metadata.json working set and its authority marker (ADR 0073).
-- Additive. Changes nothing of 0001-0005. A deploy does not apply this file.
-- The inserted marker is mode r2. Applying this file does not insert cache rows,
-- does not set mode d1, and does not change the cron. Once this schema is
-- present, an r2-mode metadata save advances cache_generation before its put.
-- That fence is not cache-row authority.
-- cache_key is the metadata.json key as stored. It is not a film id and has no
-- foreign key: a key with no Film row is kept and does not create a Film.
-- payload_json is the whole cache record. The typed columns repeat the clocks
-- the sync decision reads. metadata_cache_cas is the batch fence, not a switch.

CREATE TABLE metadata_cache (
 cache_key TEXT PRIMARY KEY,
 payload_json TEXT NOT NULL,
 metadata_at TEXT,
 synopsis_fetched_at TEXT,
 people_names_version INTEGER,
 people_localized_at TEXT,
 people_version INTEGER,
 generation INTEGER NOT NULL
) STRICT;

CREATE TABLE metadata_cache_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 cache_generation INTEGER NOT NULL,
 mirror_generation INTEGER NOT NULL,
 mirror_etag TEXT
) STRICT;

CREATE TABLE metadata_cache_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO metadata_cache_authority (id, mode, cache_generation, mirror_generation, mirror_etag) VALUES (1, 'r2', 0, 0, NULL);
INSERT INTO metadata_cache_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract SET version=6, note='Schema v6: metadata cache. Marker mode r2 until a separate activation.' WHERE id=1;
