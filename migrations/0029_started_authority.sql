-- Schema v29: Started marks user state (AIR-549 stage 2). Source today: R2 `started/<exact-id>.json` with `customMetadata.started`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 and every
-- later step (hold, import, activation) are separate owner GOs. The inserted marker is mode `r2`, generation 0, writes `open`:
-- the Worker keeps serving the R2 objects exactly as before. Applying this file copies nothing and switches nothing.
-- It follows a complete version 28 (the Filter presets tables present) and refuses anything else before a table is created: the
-- first statement inserts a second schema_contract row and so aborts the file. The version becomes 29 and never goes down.
-- started_authority is the per-domain marker of THIS domain (it does not reuse filter_preset_authority). mode r2 = the R2 objects
-- serve; mode d1 = the rows serve and R2 `started/` is never read or written again. writes `held` stops every mark write while an
-- import detains writers. generation moves only with the import and the activation; each mark carries its own revision `rev`, so
-- two requests for one id cannot both win (a compare-and-swap per row) and two ids never contend.
-- started_cas is the batch fence, not a switch (same pattern as filter_preset_cas and owner_review_cas).
-- started_mark keeps the whole R2 object: `started` (false is a kept tombstone), `started_at` (null for an unstarted mark or a legacy
-- object without it) and `last_event_json`, the event stored with the mark (NULL for a legacy mark that has none). The event journal
-- `events/items/` stays R2-authoritative and is not part of this schema.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 28
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('filter_preset_authority', 'filter_preset_cas', 'filter_preset')
 ) = 3
);

CREATE TABLE started_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
) STRICT;

CREATE TABLE started_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE started_mark (
 id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
 started INTEGER NOT NULL CHECK (started IN (0, 1)),
 started_at TEXT,
 last_event_json TEXT CHECK (last_event_json IS NULL OR json_valid(last_event_json)),
 rev INTEGER NOT NULL CHECK (rev >= 1)
) STRICT;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO started_authority (id, mode, generation, writes) VALUES (1, 'r2', 0, 'open');
INSERT INTO started_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 29,
    note = 'Schema v29: Started marks authority. Marker mode r2 until a separate activation. Version 29 follows a complete version 28.'
WHERE id = 1 AND version = 28;
