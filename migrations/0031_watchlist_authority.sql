-- Schema v31: the Watchlist as its own D1 authority (ADR 0186, Accepted; AIR-569). Source today: the published EPG generation (`published_epg_document`, `published_epg_member`) and the R2 mirror `watchlist.json`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1, the bootstrap import (snapshot version 1), the marker switch to `d1` and every later step are separate
-- owner L3 GOs (AIR-571). The inserted marker is mode `epg`, generation 0, writes `open`, and the pointer row is version 0 with no snapshot: the Worker keeps reading the EPG generation exactly as before.
-- Applying this file copies nothing and switches nothing. It follows a complete version 30 (the EPG checkpoint tables present) and refuses anything else before a table is created: the first statement inserts a second
-- schema_contract row and so aborts the file. The version becomes 31 and never goes down. The number is the next free one on `main` at implementation and is renumbered at merge if another migration lands first (ADR 0186 decision 1).
--
-- Boundary with AIR-570: this file owns the membership authority and its atomic neighbours (the change rows, the causal effects journal and the admission ledger are written by the same promotion batch). The slot Event outbox
-- (`letterboxd_slot_event`) and the Workflow control and mode documents belong to AIR-570 and are NOT created here.
--
-- watchlist_authority is the marker of THIS domain, independent of every other. mode epg = the EPG generation serves the membership (today); mode d1 = the snapshot serves it and R2 is never read as authority.
-- writes `held` stops every repository write while an import detains writers. generation is an authority epoch changed only by import, activation, hold, release and an explicit rollback export.
-- watchlist_cas is the batch fence (same pattern as epg_checkpoint_cas): every guard is an upsert of the singleton row and ok=0 trips CHECK (ok = 1), which aborts the whole batch.
-- watchlist_current is the pointer: `version` changes only when the ORDERED membership changes (assigned by the switch batch, expected + 1), `revision` is the per-row compare-and-swap, `last_success_at` is the end of the latest COMPLETE
-- scan whether or not it changed anything. watchlist_staging holds one row per scan attempt and names no version. watchlist_snapshot is a promoted attempt. watchlist_member is the ordered list (no TMDB id: identity is a Film fact).
-- watchlist_change is the durable added/removed diff, written in the promotion batch. watchlist_effect is the per-snapshot causal effects journal (scan_facts, retention, removal_enqueue only). watchlist_admission_pending is the
-- bounded, deduplicated ledger of Letterboxd ids that still need a Film. Triggers keep the pointer monotonic, the snapshots immutable and a done effect done, even against a writer that bypasses the repository.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 30
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('epg_checkpoint_authority', 'epg_checkpoint_cas', 'epg_checkpoint_run')
 ) = 3
);

CREATE TABLE watchlist_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('epg', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
) STRICT;

CREATE TABLE watchlist_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

-- The singleton fence row must exist: every guard is an upsert of it, the marker read answers `closed` without it, and this trigger refuses a delete.
CREATE TRIGGER watchlist_cas_required
BEFORE DELETE ON watchlist_cas
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_cas_required');
END;

CREATE TABLE watchlist_current (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 version INTEGER NOT NULL CHECK (version >= 0),
 snapshot_id TEXT CHECK (snapshot_id IS NULL OR length(snapshot_id) BETWEEN 1 AND 100),
 list_sha256 TEXT CHECK (list_sha256 IS NULL OR length(list_sha256) = 64),
 film_count INTEGER CHECK (film_count IS NULL OR film_count >= 0),
 last_success_at TEXT,
 last_success_run TEXT,
 last_success_slot TEXT,
 last_attempt_at TEXT,
 last_attempt_outcome TEXT CHECK (last_attempt_outcome IS NULL OR length(last_attempt_outcome) <= 60),
 effects_drained_version INTEGER NOT NULL CHECK (effects_drained_version >= 0),
 mirror_delivered_snapshot_id TEXT,
 mirror_attempts INTEGER NOT NULL CHECK (mirror_attempts >= 0),
 mirror_next_retry_at TEXT,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL,
 CHECK ((version = 0) = (snapshot_id IS NULL)),
 CHECK ((snapshot_id IS NULL) = (list_sha256 IS NULL AND film_count IS NULL)),
 CHECK (effects_drained_version <= version)
) STRICT;

CREATE TABLE watchlist_staging (
 snapshot_id TEXT PRIMARY KEY CHECK (length(snapshot_id) BETWEEN 1 AND 100),
 attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 100),
 run_id TEXT,
 slot_key TEXT,
 expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
 expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
 started_at TEXT NOT NULL
) STRICT;

CREATE TABLE watchlist_snapshot (
 snapshot_id TEXT PRIMARY KEY REFERENCES watchlist_staging (snapshot_id),
 version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
 scan_id TEXT NOT NULL CHECK (length(scan_id) BETWEEN 1 AND 100),
 observed_at TEXT NOT NULL,
 committed_at TEXT NOT NULL,
 film_count INTEGER NOT NULL CHECK (film_count >= 0),
 list_sha256 TEXT NOT NULL CHECK (length(list_sha256) = 64),
 prev_version INTEGER NOT NULL CHECK (prev_version >= 0 AND prev_version < version),
 slot_key TEXT,
 run_id TEXT
) STRICT;

CREATE TABLE watchlist_member (
 snapshot_id TEXT NOT NULL REFERENCES watchlist_staging (snapshot_id),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 lid TEXT NOT NULL CHECK (length(lid) BETWEEN 1 AND 100),
 title TEXT NOT NULL CHECK (length(title) <= 500),
 year INTEGER CHECK (year IS NULL OR year BETWEEN 1800 AND 2200),
 url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 500),
 PRIMARY KEY (snapshot_id, ordinal),
 UNIQUE (snapshot_id, lid)
) STRICT;

CREATE TABLE watchlist_change (
 snapshot_id TEXT NOT NULL REFERENCES watchlist_snapshot (snapshot_id),
 kind TEXT NOT NULL CHECK (kind IN ('added', 'removed')),
 lid TEXT NOT NULL CHECK (length(lid) BETWEEN 1 AND 100),
 ordinal INTEGER CHECK (ordinal IS NULL OR ordinal >= 0),
 prev_ordinal INTEGER CHECK (prev_ordinal IS NULL OR prev_ordinal >= 0),
 PRIMARY KEY (snapshot_id, kind, lid),
 CHECK ((kind = 'added' AND ordinal IS NOT NULL AND prev_ordinal IS NULL) OR (kind = 'removed' AND ordinal IS NULL AND prev_ordinal IS NOT NULL))
) STRICT;

CREATE TABLE watchlist_effect (
 snapshot_id TEXT NOT NULL REFERENCES watchlist_snapshot (snapshot_id),
 effect TEXT NOT NULL CHECK (effect IN ('scan_facts', 'retention', 'removal_enqueue')),
 status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
 receipt TEXT CHECK (receipt IS NULL OR length(receipt) <= 200),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 done_at TEXT,
 PRIMARY KEY (snapshot_id, effect),
 CHECK ((status = 'done') = (done_at IS NOT NULL))
) STRICT;

CREATE TABLE watchlist_admission_pending (
 lid TEXT PRIMARY KEY CHECK (length(lid) BETWEEN 1 AND 100),
 first_seen_snapshot_id TEXT NOT NULL,
 first_seen_version INTEGER NOT NULL CHECK (first_seen_version >= 1),
 state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'superseded', 'terminal')),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 next_retry_at TEXT,
 last_reason TEXT CHECK (last_reason IS NULL OR length(last_reason) <= 60),
 resolved_by TEXT CHECK (resolved_by IS NULL OR length(resolved_by) <= 200),
 updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX watchlist_admission_due ON watchlist_admission_pending (state, next_retry_at);

-- The pointer moves forward only: the version rises by exactly one together with a new snapshot id (never otherwise), the revision rises by exactly one on every write,
-- the success time and the drained version are never lowered, and a no-op scan (same snapshot) cannot move the version.
CREATE TRIGGER watchlist_current_order
BEFORE UPDATE ON watchlist_current
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_current_regress')
 WHERE NEW.revision <> OLD.revision + 1
    OR NEW.version < OLD.version
    OR NEW.version > OLD.version + 1
    OR (NEW.version = OLD.version AND NEW.snapshot_id IS NOT OLD.snapshot_id)
    OR (NEW.version = OLD.version + 1 AND (NEW.snapshot_id IS NULL OR NEW.snapshot_id IS OLD.snapshot_id))
    OR (OLD.last_success_at IS NOT NULL AND (NEW.last_success_at IS NULL OR NEW.last_success_at < OLD.last_success_at))
    OR NEW.effects_drained_version < OLD.effects_drained_version;
END;

CREATE TRIGGER watchlist_snapshot_immutable
BEFORE UPDATE ON watchlist_snapshot
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_snapshot_immutable');
END;

CREATE TRIGGER watchlist_member_immutable
BEFORE UPDATE ON watchlist_member
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_member_immutable');
END;

CREATE TRIGGER watchlist_change_immutable
BEFORE UPDATE ON watchlist_change
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_change_immutable');
END;

-- A done effect stays done and keeps its receipt; an effect row is never re-pointed.
CREATE TRIGGER watchlist_effect_monotonic
BEFORE UPDATE ON watchlist_effect
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'watchlist_effect_regress')
 WHERE OLD.status = 'done'
    OR NEW.snapshot_id <> OLD.snapshot_id
    OR NEW.effect <> OLD.effect;
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO watchlist_authority (id, mode, generation, writes) VALUES (1, 'epg', 0, 'open');
INSERT INTO watchlist_cas (id, ok) VALUES (1, 1);
INSERT INTO watchlist_current (id, version, snapshot_id, list_sha256, film_count, last_success_at, last_success_run, last_success_slot, last_attempt_at, last_attempt_outcome, effects_drained_version, mirror_delivered_snapshot_id, mirror_attempts, mirror_next_retry_at, revision, updated_at)
VALUES (1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, NULL, 1, '1970-01-01T00:00:00.000Z');

UPDATE schema_contract
SET version = 31,
    note = 'Schema v31: Watchlist authority. Marker mode epg until a separate activation. Version 31 follows a complete version 30.'
WHERE id = 1 AND version = 30;
