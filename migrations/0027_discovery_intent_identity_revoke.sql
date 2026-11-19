-- Schema v27: discovery_intent.kind accepts `identity_revoke` (AIR-132; ADR 0178, Accepted).
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a
-- separate owner GO; nothing in the Worker applies it. While the old CHECK is in force the revoke writer cannot insert its
-- intent and the revoke routes refuse `revoke_schema_not_ready`.
-- discovery_intent holds only owner actions. The table is rebuilt because SQLite cannot alter a CHECK: the same columns,
-- the same primary key, every existing row copied unchanged, and nothing else depends on the table (no index, trigger or
-- foreign key). No row is deleted or rewritten. No discovery_decision, discovery_decision_history or admission row is touched.
-- It follows a complete version 26 and refuses anything else before a table is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 27 and never goes down.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 26
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('discovery_intent', 'discovery_decision', 'discovery_decision_history', 'film_retention_scan')
 ) = 4
);

CREATE TABLE discovery_intent_v27 (
 idempotency_key TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('reconsider', 'identity_assign', 'identity_reject', 'identity_revoke')),
 state TEXT NOT NULL CHECK (state IN ('approved', 'running', 'receipt')),
 observation_key TEXT NOT NULL,
 before_json TEXT,
 receipt_json TEXT,
 issued_json TEXT,
 command_json TEXT,
 expected_hash TEXT,
 expires_at INTEGER,
 generation INTEGER
) STRICT;

INSERT INTO discovery_intent_v27 (idempotency_key, kind, state, observation_key, before_json, receipt_json, issued_json, command_json, expected_hash, expires_at, generation)
SELECT idempotency_key, kind, state, observation_key, before_json, receipt_json, issued_json, command_json, expected_hash, expires_at, generation
FROM discovery_intent;

DROP TABLE discovery_intent;
ALTER TABLE discovery_intent_v27 RENAME TO discovery_intent;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 27,
    note = 'Schema v27: discovery_intent.kind accepts identity_revoke (ADR 0178). Follows a complete version 26.'
WHERE id = 1 AND version = 26;
