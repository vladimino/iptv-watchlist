-- Schema v38: the Canonical Producer outcome outbox (ADR 0208, Accepted option B; AIR-594). One row per Producer OUTCOME (a completed pass P:g, a recorded stop
-- (P, owner epoch), an in-flight chain superseded by a newer publication, a stop whose automatic recovery was held), inserted by the SAME D1 batch that makes the outcome
-- and delivered afterwards, create-only, to the R2 Events Log `events/items/` by the hourly Producer reconcile.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO. Until it is applied the Worker
-- proves the table absent (schema below 38 and no table) and writes no outcome row: today's behaviour. The table starts EMPTY and nothing is backfilled.
-- It follows a complete version 37 and refuses anything else before a table is created: the first statement inserts a second schema_contract row and so aborts the file.
-- The version becomes 38 and never goes down. The number is the next free one on `main` at implementation and is renumbered at merge if another migration lands first.
-- Retention (ADR 0208 decision 6): every row is kept INDEFINITELY, pending and delivered alike. There is no delete: the trigger below refuses it. The identity and payload
-- columns never change after the insert; only the delivery columns move, and only from `pending` to `delivered`.
-- Identifiers, short lowercase codes, counters and ISO-8601 UTC times only: no title, name, film payload or personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every time CHECK is split into short GLOB and substr() tests.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 37
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_person_authority', 'canonical_producer_run', 'canonical_producer_chain', 'watchlist_membership_authority')
 ) = 4
);

CREATE TABLE canonical_producer_outcome (
 id TEXT NOT NULL CHECK (length(id) BETWEEN 24 AND 160 AND id GLOB 'canonical_producer-*' AND id NOT GLOB '*[^a-z0-9_-]*'),
 programme_run_id TEXT NOT NULL CHECK (length(programme_run_id) BETWEEN 1 AND 160),
 input_generation INTEGER NOT NULL CHECK (input_generation >= 0),
 outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'stopped', 'superseded', 'held')),
 owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
 at TEXT NOT NULL CHECK (length(at) BETWEEN 20 AND 32 AND substr(at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(at, 11, 1) = 'T' AND substr(at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(at, -1) = 'Z' AND at NOT GLOB '*[^0-9TZ:.-]*'),
 run_recorded INTEGER NOT NULL CHECK (run_recorded IN (0, 1)),
 pass_no INTEGER CHECK (pass_no IS NULL OR pass_no >= 0),
 unit_count INTEGER CHECK (unit_count IS NULL OR unit_count >= 0),
 n_applied INTEGER CHECK (n_applied IS NULL OR n_applied >= 0),
 n_noop INTEGER CHECK (n_noop IS NULL OR n_noop >= 0),
 n_kept INTEGER CHECK (n_kept IS NULL OR n_kept >= 0),
 n_failed INTEGER CHECK (n_failed IS NULL OR n_failed >= 0),
 open_at_completion INTEGER CHECK (open_at_completion IS NULL OR open_at_completion >= 0),
 run_created_at TEXT CHECK (run_created_at IS NULL OR (length(run_created_at) BETWEEN 20 AND 32 AND substr(run_created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(run_created_at, 11, 1) = 'T' AND substr(run_created_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(run_created_at, -1) = 'Z' AND run_created_at NOT GLOB '*[^0-9TZ:.-]*')),
 stopped_by TEXT CHECK (stopped_by IS NULL OR (length(stopped_by) BETWEEN 1 AND 80 AND stopped_by GLOB '[a-z]*' AND stopped_by NOT GLOB '*[^a-z_0-9]*')),
 recovery_class TEXT CHECK (recovery_class IS NULL OR recovery_class IN ('transient', 'authority', 'terminal', 'receipt', 'fail_closed', 'exhausted')),
 recovery TEXT CHECK (recovery IS NULL OR recovery IN ('eligible', 'owner', 'none')),
 prior_state TEXT CHECK (prior_state IS NULL OR prior_state IN ('pending', 'active', 'released')),
 handoff_count INTEGER CHECK (handoff_count IS NULL OR handoff_count >= 0),
 takeover_count INTEGER CHECK (takeover_count IS NULL OR takeover_count >= 0),
 relaunch_count INTEGER CHECK (relaunch_count IS NULL OR relaunch_count >= 0),
 reopen_count INTEGER CHECK (reopen_count IS NULL OR reopen_count >= 0),
 rebase_count INTEGER CHECK (rebase_count IS NULL OR rebase_count >= 0),
 recovery_attempts INTEGER CHECK (recovery_attempts IS NULL OR recovery_attempts >= 0),
 state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
 attempts INTEGER NOT NULL CHECK (attempts >= 0),
 next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) BETWEEN 20 AND 32 AND substr(next_attempt_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(next_attempt_at, 11, 1) = 'T' AND substr(next_attempt_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(next_attempt_at, -1) = 'Z' AND next_attempt_at NOT GLOB '*[^0-9TZ:.-]*'),
 delivered_at TEXT CHECK (delivered_at IS NULL OR (length(delivered_at) BETWEEN 20 AND 32 AND substr(delivered_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(delivered_at, 11, 1) = 'T' AND substr(delivered_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(delivered_at, -1) = 'Z' AND delivered_at NOT GLOB '*[^0-9TZ:.-]*')),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND substr(created_at, 11, 1) = 'T' AND substr(created_at, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(created_at, -1) = 'Z' AND created_at NOT GLOB '*[^0-9TZ:.-]*'),
 PRIMARY KEY (id),
 CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
 CHECK (outcome <> 'superseded' OR prior_state IS NOT NULL),
 CHECK (outcome = 'superseded' OR prior_state IS NULL),
 CHECK (run_recorded = 1 OR (pass_no IS NULL AND unit_count IS NULL AND n_applied IS NULL AND n_noop IS NULL AND n_kept IS NULL AND n_failed IS NULL AND open_at_completion IS NULL AND run_created_at IS NULL))
) STRICT;

-- The pending drain of the hourly reconcile: the due rows, oldest retry first. Delivered history never enters it.
CREATE INDEX canonical_producer_outcome_pending ON canonical_producer_outcome (next_attempt_at, at, id) WHERE state = 'pending';

-- Writes only while the Film/Person marker allows canonical writes (d1/open), as for the chain and run tables. Reads are never touched.
CREATE TRIGGER canonical_producer_outcome_insert_open
BEFORE INSERT ON canonical_producer_outcome
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

CREATE TRIGGER canonical_producer_outcome_update_open
BEFORE UPDATE ON canonical_producer_outcome
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode = 'd1' AND cutover = 'open')
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_not_open');
END;

-- Birth shape: pending, never attempted, not delivered.
CREATE TRIGGER canonical_producer_outcome_insert_shape
BEFORE INSERT ON canonical_producer_outcome
FOR EACH ROW
WHEN NEW.state <> 'pending' OR NEW.attempts <> 0 OR NEW.delivered_at IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_outcome_insert');
END;

-- Indefinite retention (ADR 0208 decision 6): no row is ever deleted.
CREATE TRIGGER canonical_producer_outcome_no_delete
BEFORE DELETE ON canonical_producer_outcome
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_outcome_delete');
END;

-- The identity and the frozen payload never change after the insert.
CREATE TRIGGER canonical_producer_outcome_immutable
BEFORE UPDATE ON canonical_producer_outcome
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.programme_run_id IS NOT OLD.programme_run_id OR NEW.input_generation IS NOT OLD.input_generation OR NEW.outcome IS NOT OLD.outcome OR NEW.owner_epoch IS NOT OLD.owner_epoch OR NEW.at IS NOT OLD.at OR NEW.run_recorded IS NOT OLD.run_recorded OR NEW.pass_no IS NOT OLD.pass_no OR NEW.unit_count IS NOT OLD.unit_count OR NEW.n_applied IS NOT OLD.n_applied OR NEW.n_noop IS NOT OLD.n_noop OR NEW.n_kept IS NOT OLD.n_kept OR NEW.n_failed IS NOT OLD.n_failed OR NEW.open_at_completion IS NOT OLD.open_at_completion OR NEW.run_created_at IS NOT OLD.run_created_at OR NEW.stopped_by IS NOT OLD.stopped_by OR NEW.recovery_class IS NOT OLD.recovery_class OR NEW.recovery IS NOT OLD.recovery OR NEW.prior_state IS NOT OLD.prior_state OR NEW.handoff_count IS NOT OLD.handoff_count OR NEW.takeover_count IS NOT OLD.takeover_count OR NEW.relaunch_count IS NOT OLD.relaunch_count OR NEW.reopen_count IS NOT OLD.reopen_count OR NEW.rebase_count IS NOT OLD.rebase_count OR NEW.recovery_attempts IS NOT OLD.recovery_attempts OR NEW.created_at IS NOT OLD.created_at
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_outcome_immutable');
END;

-- Delivery moves one way: a delivered row stays delivered with its delivery time, and the attempt count never falls.
CREATE TRIGGER canonical_producer_outcome_delivery
BEFORE UPDATE ON canonical_producer_outcome
FOR EACH ROW
WHEN (OLD.state = 'delivered' AND (NEW.state <> 'delivered' OR NEW.delivered_at IS NOT OLD.delivered_at)) OR NEW.attempts < OLD.attempts
BEGIN
 SELECT RAISE(ABORT, 'canonical_producer_outcome_delivery');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

UPDATE schema_contract
SET version = 38,
    note = 'Schema v38: the Canonical Producer outcome outbox (empty, inert until written by the Producer). Follows a complete version 37.'
WHERE id = 1 AND version = 37;
