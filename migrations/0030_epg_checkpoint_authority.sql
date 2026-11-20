-- Schema v30: the EPG run checkpoint and the watchlist ingest status (ADR 0185, Accepted). Source today: R2 `sync.json` and `watchlist-ingest.json`.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 and every later step
-- (hold, import, activation, retirement of the R2 arm) are separate owner GOs. The inserted marker is mode `r2`, generation 0, writes `open`:
-- the Worker keeps using the R2 objects exactly as before. Applying this file copies nothing and switches nothing.
-- It follows a complete version 29 (the Started marks tables present) and refuses anything else before a table is created: the first statement
-- inserts a second schema_contract row and so aborts the file. The version becomes 30 and never goes down.
-- epg_checkpoint_authority is the marker of THIS domain. mode r2 = the R2 objects serve; mode d1 = the rows serve and R2 is never read or
-- written for the checkpoint again. writes `held` stops every checkpoint write while an import detains writers. generation is an authority
-- epoch: only import, activation, hold, release and an explicit rollback export change it, never a runtime write.
-- epg_checkpoint_cas is the batch fence, not a switch (same pattern as started_cas): ok=0 trips CHECK (ok = 1) and aborts the whole batch.
-- epg_checkpoint_run is the one current run. The typed columns repeat the few fields that fences and readers compare; the body is authoritative
-- for everything else and a mismatch fails closed. The watchlist completeness fields tell a reader what the film rows must be
-- (watchlist_present 0 = no watchlist, which is not an empty one). epg_checkpoint_body holds the run without its watchlist as ordered chunks,
-- epg_checkpoint_film one row per watchlist entry, epg_checkpoint_receipt the write receipts that classify an unknown outcome,
-- epg_ingest_status the ingest success and failure ordered by attempt. Triggers keep the stage order, the immutable completion time and the
-- queue_attempted marker even against a writer that bypasses the repository.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 29
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('started_authority', 'started_cas', 'started_mark')
 ) = 3
);

CREATE TABLE epg_checkpoint_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'd1')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 writes TEXT NOT NULL CHECK (writes IN ('open', 'held'))
) STRICT;

CREATE TABLE epg_checkpoint_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE epg_checkpoint_run (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 100),
 run_key TEXT CHECK (run_key IS NULL OR run_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 started_at TEXT NOT NULL,
 stage TEXT NOT NULL CHECK (stage IN ('metadata', 'epg', 'seal', 'complete')),
 seal_phase TEXT CHECK (seal_phase IS NULL OR seal_phase IN ('ledger', 'catalog', 'publish', 'finalize', 'queue')),
 queue_attempted INTEGER NOT NULL CHECK (queue_attempted IN (0, 1)),
 completed_at TEXT,
 has_error INTEGER NOT NULL CHECK (has_error IN (0, 1)),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 last_write_id TEXT NOT NULL CHECK (length(last_write_id) BETWEEN 1 AND 100),
 body_chunks INTEGER NOT NULL CHECK (body_chunks >= 1),
 body_chars INTEGER NOT NULL CHECK (body_chars >= 2),
 body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
 watchlist_present INTEGER NOT NULL CHECK (watchlist_present IN (0, 1)),
 film_count INTEGER CHECK (film_count IS NULL OR film_count >= 0),
 film_list_sha256 TEXT CHECK (film_list_sha256 IS NULL OR length(film_list_sha256) = 64),
 updated_at TEXT NOT NULL,
 CHECK ((stage = 'seal') = (seal_phase IS NOT NULL)),
 CHECK ((stage = 'complete') = (completed_at IS NOT NULL)),
 CHECK ((watchlist_present = 1) = (film_count IS NOT NULL AND film_list_sha256 IS NOT NULL)),
 CHECK (queue_attempted = 0 OR stage = 'complete'),
 CHECK (stage <> 'complete' OR (watchlist_present = 0 AND queue_attempted = 1))
) STRICT;

CREATE TABLE epg_checkpoint_body (
 seq INTEGER PRIMARY KEY CHECK (seq >= 0),
 text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 90000)
) STRICT;

CREATE TABLE epg_checkpoint_film (
 run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 100),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 film_id TEXT NOT NULL CHECK (length(film_id) >= 1),
 body TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 90000 AND json_valid(body)),
 body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
 PRIMARY KEY (run_id, ordinal),
 UNIQUE (run_id, film_id)
) STRICT;

CREATE TABLE epg_checkpoint_receipt (
 write_id TEXT PRIMARY KEY CHECK (length(write_id) BETWEEN 1 AND 100),
 run_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
 applied_at TEXT NOT NULL
) STRICT;

CREATE INDEX epg_checkpoint_receipt_revision ON epg_checkpoint_receipt (revision);

CREATE TABLE epg_ingest_status (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 schema_version INTEGER NOT NULL CHECK (schema_version = 1),
 last_success_at TEXT,
 failed_at TEXT,
 code TEXT CHECK (code IS NULL OR length(code) <= 60),
 consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures BETWEEN 0 AND 1000),
 success_attempt_id TEXT,
 success_attempt_started_at TEXT,
 failure_attempt_id TEXT,
 failure_attempt_started_at TEXT,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL
) STRICT;

-- Within one run the stage only moves forward, the completion time is immutable once set, a complete run never leaves `complete`, and
-- queue_attempted changes only together with the transition into `complete`. A new run replaces the row, so the guard applies to the same run_id only.
CREATE TRIGGER epg_checkpoint_run_order
BEFORE UPDATE ON epg_checkpoint_run
FOR EACH ROW
WHEN OLD.run_id = NEW.run_id
BEGIN
 SELECT RAISE(ABORT, 'epg_checkpoint_regress')
 WHERE (CASE OLD.stage WHEN 'metadata' THEN 1 WHEN 'epg' THEN 2 WHEN 'seal' THEN 3 ELSE 4 END)
     > (CASE NEW.stage WHEN 'metadata' THEN 1 WHEN 'epg' THEN 2 WHEN 'seal' THEN 3 ELSE 4 END)
    OR (OLD.stage = 'seal' AND NEW.stage = 'seal'
        AND (CASE OLD.seal_phase WHEN 'ledger' THEN 1 WHEN 'catalog' THEN 2 WHEN 'publish' THEN 3 WHEN 'finalize' THEN 4 ELSE 5 END)
          > (CASE NEW.seal_phase WHEN 'ledger' THEN 1 WHEN 'catalog' THEN 2 WHEN 'publish' THEN 3 WHEN 'finalize' THEN 4 ELSE 5 END))
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
    OR (NEW.queue_attempted <> OLD.queue_attempted AND NOT (OLD.stage <> 'complete' AND NEW.stage = 'complete'))
    OR NEW.started_at <> OLD.started_at
    OR NEW.revision <> OLD.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO epg_checkpoint_authority (id, mode, generation, writes) VALUES (1, 'r2', 0, 'open');
INSERT INTO epg_checkpoint_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 30,
    note = 'Schema v30: EPG checkpoint authority. Marker mode r2 until a separate activation. Version 30 follows a complete version 29.'
WHERE id = 1 AND version = 29;
