-- Schema v15: the D1-owned control state of the Cloudflare EPG executor (ADR 0100, AIR-348).
-- Additive. A deploy does not apply this file, and applying it writes no row: the table starts empty, an empty table means
-- the executor mode `external` with epoch 0, and no Worker code creates a Workflow instance until the owner has switched the
-- mode. The code treats an absent table as "executor not available" (mode external, no fence), so deploying the code before
-- this file is applied changes nothing.
-- It follows a complete version 14 (0012 to 0014 applied in order) and refuses anything else before a table is created: the
-- first statement inserts a second schema_contract row and so aborts the file. The version becomes 15 and never goes down.
-- epg_orchestration_document holds three small JSON documents, by key: `mode` (external | switching | cloudflare, the target, the
-- epoch and the drain state; written only by the owner's mode switch) and `control` (the run key, the Workflow instance, the
-- checkpoint, the retry budget, the cooldown, the quarantine and the last durable progress; written only by the executor and
-- the owner's quarantine clear) and `lease` (the durable step lease: which step may mutate EPG state, until when; taken by
-- every external or executor step and waited for by the owner's drain). `revision` is the compare-and-set token: every write names the revision it read.
-- Every authoritative published-EPG commit made through an executor or through the external path asserts, in its own D1 batch,
-- that the `mode` document is still at the revision it had at admission (src/published-epg.js), so a commit admitted before
-- the owner closed admission cannot land after it.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 14 AND version < 15
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'published_epg_authority',
   'published_epg_cas',
   'discovery_seal',
   'film_person_authority',
   'film_localization_source'
  )
 ) = 5
);

CREATE TABLE epg_orchestration_document (
 key TEXT PRIMARY KEY CHECK (key IN ('mode', 'control', 'lease')),
 body TEXT NOT NULL CHECK (json_valid(body)),
 revision INTEGER NOT NULL CHECK (revision >= 1),
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
    note = 'Schema v15: the D1-owned control state of the Cloudflare EPG executor (mode and control documents). Follows a complete version 14.'
WHERE id = 1 AND version >= 14 AND version < 15;
