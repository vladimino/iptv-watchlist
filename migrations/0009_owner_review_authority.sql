-- Schema v9: owner-reviewed Film titles and Person names (ADR 0080).
-- Additive. It does not alter 0001-0006 and it does not create prediction or
-- published-EPG tables. 0007 is on main and is not applied. 0008 is an open
-- change. This file does not add those tables and it does not treat version 9
-- as proof they exist.
-- schema_contract.version only moves forward. A later migration may already
-- have set a higher version. This file does not lower it. A database below
-- version 6 fails the guard and creates nothing.
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
WHERE NOT EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version >= 6);

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
SET version = CASE WHEN version < 9 THEN 9 ELSE version END,
    note = CASE WHEN version < 9 THEN 'Schema v9: owner-review authority. Marker mode r2 until a separate activation. A higher contract version is left in place. Version 9 does not imply prediction or published-EPG tables.' ELSE note END
WHERE id = 1 AND version >= 6;
