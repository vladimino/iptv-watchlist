-- Schema v18: the exclusive projector window (ADR 0103, AIR-383).
-- Additive. A deploy does not apply this file. The code treats an absent table as "no window": every Discovery path and the
-- projector behave exactly as before, so deploying the code before this file is applied changes nothing. Applying it also changes
-- nothing by itself: the one row it seeds is `idle`, and the projector requests a window only while the feature flag
-- D1_ENRICHMENT_WINDOW is `on`, which a deploy never sets.
-- It follows a complete version 17 (0012 to 0017 applied in order) and refuses anything else before a table is created: the first
-- statement inserts a second schema_contract row and so aborts the file. The version becomes 18 and never goes down.
-- projector_window is a mutual-exclusion flag with an expiry, not a version: nothing compares it to data. `state` is `idle`,
-- `requested` (Discovery admission is closed, in-flight chunks finish) or `held` (the projector owns the existing discovery_lease
-- row). `owner` is the projector's lease id. `expires_at` (epoch milliseconds) is ONE absolute deadline set at the request and
-- shared by `requested` and `held`; it is never extended, at most 300000 ms after `requested_at` (a CHECK, repeated by the coordination API), and an expired row is treated as idle by every reader and writer.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 17 AND version < 18
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'discovery_authority',
   'discovery_lease',
   'discovery_seal',
   'projection_run',
   'projection_fence',
   'epg_orchestration_document'
  )
 ) = 6
);

CREATE TABLE projector_window (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('idle', 'requested', 'held')),
 owner TEXT,
 requested_at INTEGER,
 expires_at INTEGER NOT NULL DEFAULT 0 CHECK (expires_at >= 0),
 CHECK ((state = 'idle' AND owner IS NULL) OR (state <> 'idle' AND owner IS NOT NULL AND requested_at IS NOT NULL AND expires_at > 0 AND expires_at - requested_at <= 300000))
) STRICT;

INSERT INTO projector_window (id, state, owner, requested_at, expires_at) VALUES (1, 'idle', NULL, NULL, 0);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 18,
    note = 'Schema v18: the exclusive projector window, one row, idle when seeded (ADR 0103). Follows a complete version 17.'
WHERE id = 1 AND version >= 17 AND version < 18;
