-- Schema v45: the shared upstream cooldown and its mode row (AIR-604, card UC1; ADR 0211 decision 5, Accepted; ADR 0207 decision 7). Two ADDITIVE tables:
--  1. `upstream_cooldown(scope PRIMARY KEY, until_at, reason, retry_after_s, set_by, updated_at)`: one durable row per upstream scope (tmdb, letterboxd, wikidata). A row is
--     only ever extended (MAX of until_at), overwritten and never deleted; a row whose until_at has passed is inert.
--  2. `upstream_coordination(id = 1, mode, revision, updated_at)`: the one durable mode row, `off` | `observe` | `enforce`. An ABSENT row reads as `off`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO. Both tables are created
-- EMPTY, so every caller reads `off` and behaves exactly as today; no caller writes a cooldown while the mode is `off`. A mode change is a separate owner production
-- operation and is not part of this file.
-- It follows a complete version 44 and refuses anything else before a table is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file
-- (a second apply and a missing schema_contract row included). The version becomes 45 and never goes down. (Written as 0044 and renumbered to 0045 at merge because AIR-639's 0044, the identity evidence reconstruction import, landed first.) 0001 and every earlier migration are NOT changed.
-- Identifiers only; no LIKE pattern.

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 44)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'film_redirect_by_target')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identity_evidence_import_run')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name IN ('upstream_cooldown', 'upstream_coordination'))
);

CREATE TABLE upstream_cooldown (
 scope TEXT PRIMARY KEY CHECK (scope IN ('tmdb', 'letterboxd', 'wikidata')),
 until_at INTEGER NOT NULL CHECK (until_at >= 0),
 reason TEXT NOT NULL CHECK (reason IN ('rate_limited', 'challenge', 'forbidden')),
 retry_after_s INTEGER CHECK (retry_after_s IS NULL OR retry_after_s >= 0),
 set_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE upstream_coordination (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'enforce')),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

-- A cooldown is never shortened and never removed (ADR 0211 decision 5): the write is an upsert with MAX, and these triggers refuse any other change.
CREATE TRIGGER upstream_cooldown_monotonic BEFORE UPDATE ON upstream_cooldown
WHEN NEW.until_at < OLD.until_at
BEGIN
 SELECT RAISE(ABORT, 'upstream_cooldown_shortened');
END;

CREATE TRIGGER upstream_cooldown_no_delete BEFORE DELETE ON upstream_cooldown
BEGIN
 SELECT RAISE(ABORT, 'upstream_cooldown_no_delete');
END;

UPDATE schema_contract
SET version = 45,
    note = 'Schema v45: upstream_cooldown and upstream_coordination (dormant, mode off by absence). Version 45 follows a complete version 44.'
WHERE id = 1 AND version = 44;
