-- Schema v9: owner-reviewed Film titles and Person names (ADR 0081).
-- Production order is 0007, then 0008, then this file. The first statement
-- refuses a contract that is not a complete version 8: the ten prediction
-- tables, the nine published-EPG tables, and both authority rows. A refusal
-- creates nothing. The version becomes 9 and never goes down.
-- 0009 before 0008, and 0007 after 0009, are not supported production paths.
-- A deploy does not apply this file. The inserted marker is mode r2.
-- Applying this file does not copy admin/owner-reviews.json and does not set mode d1.
-- source_key is the programme stored id (film) or the role-specific person id.
-- It is not a foreign key. A key with no film or person row is kept.
-- identity_link is optional and not a foreign key. identity_state held means
-- the canonical row was not proven. This file does not insert a film or a person.
-- owner_review_cas is the batch fence, not a switch.
-- writes is open during ordinary saves and held while a load has detained writers.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 8 AND version < 9
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

CREATE TABLE owner_review_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL,
 mirror_generation INTEGER NOT NULL,
 mirror_etag TEXT,
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
) STRICT;

CREATE TABLE owner_review_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE owner_review_entry (
 kind TEXT NOT NULL CHECK (kind IN ('film', 'person')),
 source_key TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 identity_link TEXT,
 identity_state TEXT NOT NULL CHECK (identity_state IN ('unlinked', 'verified', 'held')),
 generation INTEGER NOT NULL,
 PRIMARY KEY (kind, source_key)
) STRICT;

CREATE INDEX owner_review_entry_identity ON owner_review_entry(identity_link);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO owner_review_authority (id, mode, generation, mirror_generation, mirror_etag, writes)
VALUES (1, 'r2', 0, 0, NULL, 'open');
INSERT INTO owner_review_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 9,
    note = 'Schema v9: owner-review authority. Marker mode r2 until a separate activation. Version 9 follows a complete version 8 and does not by itself prove those earlier tables are still present.'
WHERE id = 1 AND version >= 8 AND version < 9;
