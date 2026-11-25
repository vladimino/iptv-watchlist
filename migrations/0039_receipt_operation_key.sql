-- Schema v39: the receipt operation key (ADR 0207 decision 3, owner choice 0207-U1 = K2; card R1, AIR-600). It amends the durable canonical write receipt of 0019 (ADR 0119).
-- One additive, nullable column `operation_key` on `canonical_write_receipt` names the ITEM an attempt works on (for an admission `admission:<kind>:<code>`, for the evidence-only
-- operation `evidence:<evidence_key>`), so a retry finds every earlier attempt of the same item whatever its request id, target or digest. With it come:
--   - a PARTIAL UNIQUE index: at most one unresolved (`pending`, `failed`, `unknown`) receipt per (origin, operation_key); the database enforces it;
--   - a partial lookup index over every keyed receipt, which serves the history read and its fingerprint (the count of receipts of the key and of those `applied`);
--   - a trigger that keeps the key of a receipt unchanged after the insert (the identity columns of 0019 never change either).
-- A receipt written without a key (every caller today) keeps the column NULL: the unique index ignores it, nothing it did changes, and no existing row is touched.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO (card M1). Until it is applied the
-- keyed protocol (src/receipt-operation-key.js) proves the column absent and refuses before any write (`receipt_operation_key_missing`); legacy receipts are unchanged.
-- It follows a complete version 38 and refuses anything else before it changes a table: the first statement inserts a second schema_contract row and so aborts the file.
-- The version becomes 39 and never goes down. The number is the next free one on `main` at implementation and is renumbered at merge if another migration lands first.
-- The key is an identifier, never a payload: a lowercase namespace, a colon, then identifier characters only (the request id alphabet), at most 200. No title, name or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes; every pattern below is shorter.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 38
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_person_authority', 'canonical_revision', 'canonical_write_receipt', 'canonical_receipt_baseline_seal', 'canonical_producer_outcome')
 ) = 5
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_write_receipt' AND sql LIKE '%operation_key%')
);

ALTER TABLE canonical_write_receipt ADD COLUMN operation_key TEXT CHECK (
 operation_key IS NULL OR (
  length(operation_key) BETWEEN 3 AND 200
  AND operation_key GLOB '[a-z]*:?*'
  AND substr(operation_key, 1, instr(operation_key, ':') - 1) NOT GLOB '*[^a-z0-9_]*'
  AND operation_key NOT GLOB '*[^A-Za-z0-9:._/=+@-]*'
 )
);

-- At most one unresolved attempt per item and origin. `applied` and `abandoned` are terminal and leave the index, so a settled key can be reserved again.
CREATE UNIQUE INDEX canonical_write_receipt_operation_unresolved ON canonical_write_receipt (origin, operation_key) WHERE operation_key IS NOT NULL AND state IN ('pending', 'failed', 'unknown');

-- Every receipt of a key, in one bounded read: the history and its fingerprint.
CREATE INDEX canonical_write_receipt_operation_history ON canonical_write_receipt (origin, operation_key, state) WHERE operation_key IS NOT NULL;

-- The key is part of what a receipt identifies: it is set by the insert and never changes, not even from NULL.
CREATE TRIGGER canonical_write_receipt_operation_key_immutable
BEFORE UPDATE ON canonical_write_receipt
FOR EACH ROW
WHEN NEW.operation_key IS NOT OLD.operation_key
BEGIN
 SELECT RAISE(ABORT, 'canonical_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 39,
    note = 'Schema v39: the receipt operation key (nullable, inert until a keyed caller writes it). Follows a complete version 38.'
WHERE id = 1 AND version = 38;
