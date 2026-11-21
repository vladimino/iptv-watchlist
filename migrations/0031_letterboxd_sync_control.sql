-- Schema v31: the Letterboxd Sync Workflow control plane (ADR 0186, Accepted; AIR-570). Owner of these tables: the Letterboxd Sync executor only.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO (AIR-571).
-- Applying it writes no row: the mode table starts EMPTY, and an absent mode row means `external`, epoch 0, so `LetterboxdOrchestration.ensure` creates nothing.
-- It follows a complete version 30 and refuses anything else before a table is created: the first statement inserts a second schema_contract row and aborts the file.
-- The number is the next free one on `main` when written; the Watchlist authority tables of AIR-569 (watchlist_*) are NOT here and are renumbered at merge.
-- letterboxd_sync_mode: the executor mode (external | switching | cloudflare) and its epoch fence, plus the domain quarantine. Only the owner's mode switch writes it.
-- letterboxd_sync_fence: the batch fence, not a switch. A guard upserts it with ok = 0 when the mode row no longer admits the caller's epoch, which trips CHECK (ok = 1) and aborts the whole batch.
-- letterboxd_slot: one row per Madrid slot (04:30, 10:30, 16:30, 22:30): the control record (series, instance, epoch, phase, retry budget, quarantine) and the three independent outcomes.
-- letterboxd_slot_event: the slot-owned Event outbox. Two rows per slot (ratings, watchlist), inserted in the SAME batch that closes the slot, with a frozen `at` and payload.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 30);

CREATE TABLE letterboxd_sync_mode (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('external', 'switching', 'cloudflare')),
 target TEXT CHECK (target IS NULL OR target IN ('external', 'cloudflare')),
 from_mode TEXT CHECK (from_mode IS NULL OR from_mode IN ('external', 'switching', 'cloudflare')),
 epoch INTEGER NOT NULL CHECK (epoch >= 0),
 drain TEXT CHECK (drain IS NULL OR length(drain) <= 40),
 quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 60),
 quarantined_at TEXT,
 changed_at TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 write_id TEXT NOT NULL CHECK (length(write_id) BETWEEN 1 AND 100),
 CHECK ((mode = 'switching') = (target IS NOT NULL))
) STRICT;

CREATE TABLE letterboxd_sync_fence (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE letterboxd_slot (
 slot_key TEXT PRIMARY KEY CHECK (slot_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]'),
 due_at TEXT NOT NULL,
 series INTEGER NOT NULL CHECK (series >= 0),
 instance_id TEXT CHECK (instance_id IS NULL OR length(instance_id) <= 100),
 epoch INTEGER NOT NULL CHECK (epoch >= 0),
 status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'finished', 'error', 'interrupted', 'skipped_missed')),
 phase TEXT NOT NULL CHECK (phase IN ('starting', 'ratings', 'watchlist', 'reconciliation', 'closing', 'done', 'stopped')),
 run_id TEXT CHECK (run_id IS NULL OR length(run_id) <= 100),
 budget_consecutive INTEGER NOT NULL CHECK (budget_consecutive >= 0),
 budget_total INTEGER NOT NULL CHECK (budget_total >= 0),
 cooldown_until TEXT,
 failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 60),
 quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 60),
 ratings_outcome TEXT CHECK (ratings_outcome IS NULL OR ratings_outcome IN ('finished', 'rate_limited', 'blocked', 'error', 'interrupted', 'skipped_missed', 'noop')),
 ratings_at TEXT,
 watchlist_outcome TEXT CHECK (watchlist_outcome IS NULL OR watchlist_outcome IN ('committed', 'no_change', 'incomplete', 'unavailable', 'rate_limited', 'error', 'interrupted', 'skipped_missed', 'disabled')),
 watchlist_at TEXT,
 watchlist_summary TEXT CHECK (watchlist_summary IS NULL OR (length(watchlist_summary) <= 4000 AND json_valid(watchlist_summary))),
 reconciliation_outcome TEXT CHECK (reconciliation_outcome IS NULL OR reconciliation_outcome IN ('done', 'deferred', 'error', 'skipped')),
 started_at TEXT,
 closed_at TEXT,
 updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 write_id TEXT NOT NULL CHECK (length(write_id) BETWEEN 1 AND 100),
 CHECK ((status IN ('finished', 'error', 'interrupted', 'skipped_missed')) = (closed_at IS NOT NULL))
) STRICT;

CREATE INDEX letterboxd_slot_due ON letterboxd_slot (due_at);

CREATE TABLE letterboxd_slot_event (
 slot_key TEXT NOT NULL REFERENCES letterboxd_slot (slot_key),
 type TEXT NOT NULL CHECK (type IN ('ratings', 'watchlist')),
 event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 100),
 at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 20000 AND json_valid(payload_json)),
 status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 next_retry_at TEXT,
 delivered_at TEXT,
 PRIMARY KEY (slot_key, type),
 CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
) STRICT;

CREATE INDEX letterboxd_slot_event_pending ON letterboxd_slot_event (status, slot_key);

-- A closed slot is immutable except for its outbox delivery (that lives in letterboxd_slot_event) and the late-rating patch of a still pending Event.
CREATE TRIGGER letterboxd_slot_closed_immutable
BEFORE UPDATE ON letterboxd_slot
FOR EACH ROW
WHEN OLD.closed_at IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'letterboxd_slot_closed');
END;

CREATE TRIGGER letterboxd_slot_event_frozen
BEFORE UPDATE OF slot_key, type, event_key, at ON letterboxd_slot_event
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'letterboxd_slot_event_frozen');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract SET version = 31, note = 'letterboxd sync control plane (ADR 0186, inert)' WHERE id = 1 AND version = 30;
