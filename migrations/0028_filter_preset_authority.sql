-- Schema v28: Filter presets user state (AIR-549 stage 1). Source today: R2 `ui/filter-presets.json`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 and
-- every later step (hold, import, activation) are separate owner GOs. The inserted marker is mode `r2`, generation 0, writes
-- `open`: the Worker keeps serving the R2 object exactly as before. Applying this file copies nothing and switches nothing.
-- It follows a complete version 27 and refuses anything else before a table is created: the first statement inserts a second
-- schema_contract row and so aborts the file. The version becomes 28 and never goes down.
-- filter_preset_authority is the per-domain marker. mode r2 = the R2 object serves; mode d1 = the rows serve and R2 is never
-- read or written for presets again. writes `held` stops every preset write (both modes) while an import detains writers.
-- generation is the document revision: every committed write adds one, and the HTTP ETag of a D1 document is `"d1:<generation>"`
-- (`"none"` while generation is 0). filter_preset_cas is the batch fence, not a switch (same pattern as owner_review_cas).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 27
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('owner_review_authority', 'discovery_intent', 'film_retention_scan')
 ) = 3
);

CREATE TABLE filter_preset_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
) STRICT;

CREATE TABLE filter_preset_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE filter_preset (
 id TEXT PRIMARY KEY,
 position INTEGER NOT NULL CHECK (position >= 0 AND position < 30),
 name TEXT NOT NULL,
 query TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK (generation >= 1),
 UNIQUE (position)
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO filter_preset_authority (id, mode, generation, writes) VALUES (1, 'r2', 0, 'open');
INSERT INTO filter_preset_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 28,
    note = 'Schema v28: Filter presets authority. Marker mode r2 until a separate activation. Version 28 follows a complete version 27.'
WHERE id = 1 AND version = 27;
