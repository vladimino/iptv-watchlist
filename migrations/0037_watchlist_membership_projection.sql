-- Schema v37: the canonical Watchlist MEMBERSHIP projection by the Letterboxd Sync (ADR 0203, AIR-582; owner option C of AIR-572). The marker below decides WHO writes `watchlist_film`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1, the one-time baseline reconciliation, the marker switch to `sync` and every later step are separate
-- owner GOs. The inserted marker is mode `producer`, generation 0: after this file the Worker behaves exactly as before (three effects per version, the EPG Producer owns membership), so a deploy of the new code
-- before or after this file is safe, and so is this file before the new code.
-- It follows a complete version 36 and refuses anything else before a table is created: the first statement inserts a second schema_contract row and so aborts the file. The version becomes 37 and never goes down.
-- The number is the next free one on `main` at implementation (migration 0036 is the last on main and must be applied first) and is renumbered at merge if another migration lands first.
--
-- watchlist_membership_authority is the marker of THIS projection. mode `producer` = the EPG Producer writes `watchlist_film` (today); mode `sync` = ONLY the Letterboxd Sync `membership` effect writes it and the Producer,
-- under the Film writer itself, refuses any membership write. `generation` rises on every mode change. `baseline_version` is the Watchlist version the one-time baseline reconciliation last proved the table equal to;
-- the switch to `sync` is refused unless it equals the current Watchlist version with every earlier effect drained (src/watchlist-membership.js).
-- watchlist_film_fence is the per-film version fence: one row per Film the projection ever wrote (a TOMBSTONE after a removal, because the membership row itself is deleted), holding the newest Watchlist version applied.
-- A write for an older version is refused inside the same fenced batch, so a late effect V can never land over V+1, including add -> remove -> add.
-- watchlist_membership_handoff is the durable, bounded, non-blocking ledger of ADDED Letterboxd ids whose Film could not be resolved or written at effect time; a later bounded step reconciles them against the CURRENT snapshot.
-- watchlist_effect is rebuilt (SQLite cannot alter a CHECK) so that `membership` is a legal effect; every existing row and its trigger are carried over unchanged.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 36
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('watchlist_authority', 'watchlist_effect', 'watchlist_film', 'film_external_id')
 ) = 4
);

CREATE TABLE watchlist_membership_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('producer', 'sync')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 baseline_version INTEGER CHECK (baseline_version IS NULL OR baseline_version >= 0),
 changed_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER watchlist_membership_authority_required
BEFORE DELETE ON watchlist_membership_authority
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_membership_authority_required');
END;

-- The generation never goes down; a mode change raises it by exactly one.
CREATE TRIGGER watchlist_membership_authority_order
BEFORE UPDATE ON watchlist_membership_authority
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_membership_authority_regress')
 WHERE NEW.generation < OLD.generation
    OR (NEW.mode <> OLD.mode AND NEW.generation <> OLD.generation + 1)
    OR (NEW.mode = OLD.mode AND NEW.generation <> OLD.generation);
END;

CREATE TABLE watchlist_film_fence (
 film_id TEXT PRIMARY KEY CHECK (length(film_id) BETWEEN 1 AND 200),
 version INTEGER NOT NULL CHECK (version >= 1),
 member INTEGER NOT NULL CHECK (member IN (0, 1)),
 updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER watchlist_film_fence_monotonic
BEFORE UPDATE ON watchlist_film_fence
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_film_fence_regress')
 WHERE NEW.film_id <> OLD.film_id OR NEW.version < OLD.version;
END;

CREATE TABLE watchlist_membership_handoff (
 lid TEXT PRIMARY KEY CHECK (length(lid) BETWEEN 1 AND 100),
 first_version INTEGER NOT NULL CHECK (first_version >= 1),
 state TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'terminal')),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 next_retry_at TEXT,
 reason TEXT CHECK (reason IS NULL OR length(reason) <= 60),
 updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX watchlist_membership_handoff_due ON watchlist_membership_handoff (state, next_retry_at);

-- Rebuild of watchlist_effect with the fourth legal effect. The drop removes its trigger; it is recreated below, identical to migration 0031.
CREATE TABLE watchlist_effect_v37 (
 snapshot_id TEXT NOT NULL REFERENCES watchlist_snapshot (snapshot_id),
 effect TEXT NOT NULL CHECK (effect IN ('scan_facts', 'retention', 'removal_enqueue', 'membership')),
 status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
 receipt TEXT CHECK (receipt IS NULL OR length(receipt) <= 200),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 done_at TEXT,
 PRIMARY KEY (snapshot_id, effect),
 CHECK ((status = 'done') = (done_at IS NOT NULL))
) STRICT;

INSERT INTO watchlist_effect_v37 (snapshot_id, effect, status, receipt, attempts, done_at)
SELECT snapshot_id, effect, status, receipt, attempts, done_at FROM watchlist_effect;

DROP TABLE watchlist_effect;
ALTER TABLE watchlist_effect_v37 RENAME TO watchlist_effect;

CREATE TRIGGER watchlist_effect_monotonic
BEFORE UPDATE ON watchlist_effect
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_effect_regress')
 WHERE OLD.status = 'done'
    OR NEW.snapshot_id <> OLD.snapshot_id
    OR NEW.effect <> OLD.effect;
END;

INSERT INTO watchlist_membership_authority (id, mode, generation, baseline_version, changed_at) VALUES (1, 'producer', 0, NULL, '1970-01-01T00:00:00.000Z');

UPDATE schema_contract
SET version = 37,
    note = 'Schema v37: Watchlist membership projection. Marker mode producer until a separate activation. Version 37 follows a complete version 36.'
WHERE id = 1 AND version = 36;
