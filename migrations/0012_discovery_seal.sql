-- Schema v12: the resumable ledger seal job (ADR 0092).
-- Additive. A deploy does not apply this file. It refuses anything that is not a
-- complete version 11: the discovery authority, transfer, lease, observation and
-- show tables must exist. A version 10 and below are refused before any table is
-- created. The code treats an absent discovery_seal table as "resumable seal not
-- available" and keeps its previous behaviour, so deploying the code before this
-- file is applied changes nothing.
-- The single row is idle. Applying this file does not touch the marker, the
-- transfer, a ledger row, a decision, an admission or the lease, and does not
-- start a seal.
-- discovery_seal is the durable cursor of one seal job. Its cursor advances in
-- the same D1 batch as the observation rows it counts (compare-and-set on
-- cursor_items), so a request that dies leaves the cursor and the rows agreeing.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 11 AND version < 12
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'discovery_authority',
   'discovery_transfer',
   'discovery_lease',
   'discovery_observation',
   'discovery_observation_show'
  )
 ) = 5
);

CREATE TABLE discovery_seal (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 job_id TEXT,
 programme_run_id TEXT,
 source_key TEXT,
 source_etag TEXT,
 item_total INTEGER NOT NULL DEFAULT 0,
 cursor_items INTEGER NOT NULL DEFAULT 0,
 cursor_bytes INTEGER NOT NULL DEFAULT 0,
 phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'items', 'archive', 'done')),
 updated_at TEXT
) STRICT;

INSERT INTO discovery_seal (id, phase) VALUES (1, 'idle');

UPDATE schema_contract
SET version = 12,
    note = 'Schema v12: resumable discovery ledger seal job. Follows a complete version 11.'
WHERE id = 1 AND version >= 11 AND version < 12;
