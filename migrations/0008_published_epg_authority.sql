-- Schema v8: the published EPG generation, its pointer, programme shows and
-- watchlist membership (ADR 0079). Additive. It does not alter 0001-0006 and
-- does not create Film, candidate or prediction rows. 0007 is the open
-- prediction migration; this file does not add those tables and does not
-- lower schema_contract.version. A deploy does not apply this file.
-- The inserted marker is mode r2. Applying this file does not publish a
-- generation and does not set mode d1.
-- film_id is the id carried by the published document. It is not a foreign
-- key: a membership does not mint a Film and does not require one.
-- published_epg_cas is the batch fence, not a switch.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version >= 6);

CREATE TABLE published_epg_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 programme_run_id TEXT,
 generation INTEGER NOT NULL,
 mirror_programme_run_id TEXT,
 mirror_etag TEXT,
 watchlist_generation INTEGER NOT NULL,
 mirror_watchlist_etag TEXT
) STRICT;

CREATE TABLE published_epg_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE published_epg_generation (
 programme_run_id TEXT PRIMARY KEY,
 phase TEXT NOT NULL CHECK (phase IN ('published', 'withheld')),
 published_at TEXT,
 payload_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;

CREATE TABLE published_epg_document (
 programme_run_id TEXT NOT NULL REFERENCES published_epg_generation(programme_run_id),
 kind TEXT NOT NULL CHECK (kind IN ('programme', 'watchlist')),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 payload_json TEXT NOT NULL,
 PRIMARY KEY (programme_run_id, kind, ordinal)
) STRICT;

CREATE TABLE published_epg_member (
 programme_run_id TEXT NOT NULL REFERENCES published_epg_generation(programme_run_id),
 kind TEXT NOT NULL CHECK (kind IN ('programme', 'watchlist')),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 film_id TEXT NOT NULL,
 PRIMARY KEY (programme_run_id, kind, ordinal)
) STRICT;

CREATE UNIQUE INDEX published_epg_member_film ON published_epg_member(programme_run_id, kind, film_id);

CREATE TABLE published_epg_show (
 programme_run_id TEXT NOT NULL,
 film_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 channel TEXT,
 epg_title TEXT,
 basis TEXT,
 match_reason TEXT,
 PRIMARY KEY (programme_run_id, film_id, channel_id, start_ms)
) STRICT;

CREATE INDEX published_epg_show_by_generation ON published_epg_show(programme_run_id, start_ms);

CREATE TABLE published_epg_stage (
 programme_run_id TEXT PRIMARY KEY,
 target_programme_run_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK (phase IN ('published', 'withheld')),
 payload_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('loading', 'validated', 'published')),
 owner_token TEXT NOT NULL,
 claim_nonce TEXT,
 claim_generation INTEGER NOT NULL,
 claim_expires_at INTEGER,
 chunk_count INTEGER NOT NULL,
 member_count INTEGER NOT NULL,
 show_count INTEGER NOT NULL,
 document_count INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE published_epg_stage_chunk (
 programme_run_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 content_sha256 TEXT NOT NULL,
 PRIMARY KEY (programme_run_id, chunk_index)
) STRICT;

CREATE TABLE published_epg_stage_row (
 programme_run_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 ordinal INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('member', 'show', 'document')),
 doc_kind TEXT CHECK (doc_kind IN ('programme', 'watchlist') OR doc_kind IS NULL),
 item_ordinal INTEGER NOT NULL,
 film_id TEXT,
 channel_id TEXT,
 channel TEXT,
 start_ms INTEGER,
 end_ms INTEGER,
 epg_title TEXT,
 basis TEXT,
 match_reason TEXT,
 payload_json TEXT,
 PRIMARY KEY (programme_run_id, chunk_index, ordinal)
) STRICT;

INSERT INTO published_epg_authority (id, mode, programme_run_id, generation, mirror_programme_run_id, mirror_etag, watchlist_generation, mirror_watchlist_etag)
VALUES (1, 'r2', NULL, 0, NULL, NULL, 0, NULL);
INSERT INTO published_epg_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = CASE WHEN version < 8 THEN 8 ELSE version END,
    note = 'Schema v8: published EPG authority. Marker mode r2 until a separate activation.'
WHERE id = 1 AND version >= 6;
