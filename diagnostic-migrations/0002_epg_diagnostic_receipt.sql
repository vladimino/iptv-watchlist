-- AIR-455 / ADR 0121. The durable receipt of the EPG diagnostic canary, in the DIAGNOSTIC database only (never in the production `iptv` database, never in
-- `epg_orchestration_document`). One row per idempotency key: the key is the primary key (an atomic reservation before the Workflow is created), the config
-- fingerprint binds the key to its immutable parameters, the instance id is deterministic from the key, `slot` is 1 while the canary is active (a `stopping` canary is still active until its quiescence is confirmed) and NULL
-- afterwards, so a unique index allows at most one active canary. Not part of the production chain (`migrations/`), never applied by a deploy; the owner applies it
-- to the diagnostic database in AIR-456 after `0001_epg_diagnostic_identity.sql`.
CREATE TABLE epg_diagnostic_receipt (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 16 AND 80),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  instance_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'created', 'running', 'stopping', 'complete', 'failed', 'stopped')),
  slot INTEGER CHECK (slot IS NULL OR slot = 1),
  config_json TEXT NOT NULL,
  report_json TEXT,
  failure TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status IN ('reserved', 'created', 'running', 'stopping')) = (slot IS NOT NULL))
);
CREATE UNIQUE INDEX epg_diagnostic_one_active ON epg_diagnostic_receipt (slot);
