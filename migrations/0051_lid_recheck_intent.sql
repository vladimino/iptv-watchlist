-- Schema v51: the owner re-check intent `lid_recheck_intent` (AIR-675, delivery step 6 of ADR 0217, Accepted, decisions 7 and 8; choices L1 and M1 of the owner's disposition of 25 Nov 2026).
-- ONE additive STRICT table, one index and four triggers. No data migration. DORMANT and INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it is a separate, action-specific
-- owner approval (ADR 0217 delivery step 7b), in the exact schema chain and after the `film_lid_admission` apply (0048). No delivered writer reads or writes the table before the attach activation (ADR 0217
-- delivery step 11, owner L3 GO), and the owner route that would write it refuses before its first effect while the evidence writer `lid_tmdb_attach` is not `on` (migration 0052).
-- It follows a complete version 50 and refuses anything else before the table is created: the first statement inserts a row that CHECK (id = 1) forbids (id 0) and so aborts the file (a second apply, a missing
-- schema_contract row and a wrong version included). The version becomes 51 and never goes down.
--
-- One row is the durable intent of ONE owner request `POST /api/admin/letterboxd/lid-recheck {lid, requestId}` (ADR 0217 decision 8a):
--   * `request_id` (primary key) and `lid` are bound for life: the same `request_id` with another lid is refused `request_conflict` by the writer, and a trigger forbids ever changing either.
--   * `state` is `open` or `settled`; `outcome` is the terminal or last outcome (`attached` keeps the intent `open` while the Ratings link is `owed`). A settled row is frozen.
--   * `revision` is the compare-and-swap token: 1 on insert, +1 on EVERY update (a trigger enforces it). `attempt_request_id` is the receipt request id of the attempt that currently owns the intent.
--   * The observed proof inputs and the `attach_root` (ADR 0217 decision 8b; every input has its own column, so the root can be recomputed; no raw HTML is stored). They change only while no attach landed.
--   * `film_id` (the survivor Film the attach batch wrote to) and `link_state` (`owed`, `linked`, `alias_conflict`, `link_blocked`) make the Ratings handoff recoverable (decision 8c).
-- Identifiers, digests, short lowercase codes and ISO-8601 UTC times only: no title text beyond the film title the proof row already carries, no payload, no personal data.
-- D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every CHECK keeps its patterns short (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 50)
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_lid_admission', 'canonical_write_receipt', 'film_external_id', 'film_redirect', 'identity_evidence_writer', 'identity_evidence_writer_change', 'film_identity_evidence')
 ) = 7
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'lid_recheck_intent%')
);

CREATE TABLE lid_recheck_intent (
 request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 200 AND request_id NOT GLOB '*[^!-~]*'),
 lid TEXT NOT NULL CHECK (length(lid) BETWEEN 1 AND 80 AND lid NOT GLOB '*[^A-Za-z0-9_-]*'),
 state TEXT NOT NULL CHECK (state IN ('open', 'settled')),
 outcome TEXT CHECK (outcome IS NULL OR (length(outcome) BETWEEN 1 AND 60 AND outcome NOT GLOB '*[^a-z_]*')),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 attempt_request_id TEXT CHECK (attempt_request_id IS NULL OR (length(attempt_request_id) BETWEEN 1 AND 200 AND attempt_request_id NOT GLOB '*[^!-~]*')),
 -- The observed proof inputs of the attach (all or none; `year` is the page year and may be null). `tmdb_doc_digest` is the digest of the TMDB document fields the agreement check compares (id, title, year).
 proof_version INTEGER CHECK (proof_version IS NULL OR proof_version >= 1),
 tmdb TEXT CHECK (tmdb IS NULL OR (length(tmdb) BETWEEN 1 AND 12 AND tmdb NOT GLOB '*[^0-9]*' AND substr(tmdb, 1, 1) <> '0')),
 final_url TEXT CHECK (final_url IS NULL OR length(final_url) BETWEEN 1 AND 300),
 slug TEXT CHECK (slug IS NULL OR length(slug) BETWEEN 1 AND 200),
 canonical_path TEXT CHECK (canonical_path IS NULL OR length(canonical_path) BETWEEN 1 AND 300),
 title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 500),
 year INTEGER CHECK (year IS NULL OR year BETWEEN 1800 AND 2200),
 tmdb_doc_digest TEXT CHECK (tmdb_doc_digest IS NULL OR (length(tmdb_doc_digest) = 64 AND tmdb_doc_digest NOT GLOB '*[^0-9a-f]*')),
 attach_root TEXT CHECK (attach_root IS NULL OR (length(attach_root) = 64 AND attach_root NOT GLOB '*[^0-9a-f]*')),
 film_id TEXT CHECK (film_id IS NULL OR film_id LIKE 'film:%'),
 link_state TEXT CHECK (link_state IS NULL OR link_state IN ('owed', 'linked', 'alias_conflict', 'link_blocked')),
 created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32 AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z'),
 updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32 AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, -1) = 'Z'),
 -- A settled intent has an outcome.
 CHECK (state = 'open' OR outcome IS NOT NULL),
 -- The proof inputs are all present or all absent, and present as soon as there is a root.
 CHECK ((proof_version IS NULL) = (tmdb IS NULL) AND (tmdb IS NULL) = (final_url IS NULL) AND (final_url IS NULL) = (slug IS NULL) AND (slug IS NULL) = (canonical_path IS NULL)
  AND (canonical_path IS NULL) = (title IS NULL) AND (title IS NULL) = (tmdb_doc_digest IS NULL) AND (tmdb_doc_digest IS NULL) = (attach_root IS NULL)),
 -- `attached` is the one outcome with a Film and a link state, and the only one that may keep the intent open (the Ratings link is owed).
 CHECK ((outcome IS 'attached') = (link_state IS NOT NULL)),
 CHECK (outcome IS NOT 'attached' OR (attach_root IS NOT NULL AND film_id IS NOT NULL AND attempt_request_id IS NOT NULL)),
 CHECK (NOT (state = 'open' AND outcome = 'attached') OR link_state = 'owed'),
 CHECK (NOT (state = 'settled' AND outcome = 'attached') OR link_state IN ('linked', 'alias_conflict', 'link_blocked')),
 CHECK (state = 'settled' OR link_state IS NULL OR link_state = 'owed')
) STRICT;
CREATE INDEX lid_recheck_intent_lid ON lid_recheck_intent (lid);

-- Append-only against a conflict policy too (the same bypass 0041 and 0042 close): `INSERT OR REPLACE` or `REPLACE` would delete an existing row WITHOUT a DELETE trigger while recursive triggers are off. This guard fires
-- BEFORE the conflict is resolved, whatever the policy: a taken request id is refused.
CREATE TRIGGER lid_recheck_intent_conflict
BEFORE INSERT ON lid_recheck_intent
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM lid_recheck_intent WHERE request_id = NEW.request_id)
BEGIN
 SELECT RAISE(ABORT, 'lid_recheck_intent_taken');
END;

-- A new intent starts open at revision 1, with no outcome, no owner and no proof.
CREATE TRIGGER lid_recheck_intent_insert
BEFORE INSERT ON lid_recheck_intent
FOR EACH ROW
WHEN NEW.state <> 'open' OR NEW.revision <> 1 OR NEW.outcome IS NOT NULL OR NEW.attempt_request_id IS NOT NULL OR NEW.link_state IS NOT NULL OR NEW.attach_root IS NOT NULL OR NEW.film_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'lid_recheck_intent_insert');
END;

-- The compare-and-swap discipline (ADR 0217 decision 8a): every update raises the revision by exactly one; a settled row is frozen; the request id, the lid and the creation time never change; the proof inputs
-- change only while no attach landed (an earlier attempt that did not land may be replaced by a new observation); the attach columns are written once and only by the transition to `attached`; the link state moves only
-- `owed -> linked | alias_conflict | link_blocked`.
CREATE TRIGGER lid_recheck_intent_update
BEFORE UPDATE ON lid_recheck_intent
FOR EACH ROW
WHEN OLD.state = 'settled'
 OR NEW.revision <> OLD.revision + 1
 OR NEW.request_id IS NOT OLD.request_id OR NEW.lid IS NOT OLD.lid OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.outcome = 'attached' AND (NEW.outcome IS NOT 'attached' OR NEW.attach_root IS NOT OLD.attach_root OR NEW.film_id IS NOT OLD.film_id OR NEW.tmdb IS NOT OLD.tmdb OR NEW.proof_version IS NOT OLD.proof_version
  OR NEW.final_url IS NOT OLD.final_url OR NEW.slug IS NOT OLD.slug OR NEW.canonical_path IS NOT OLD.canonical_path OR NEW.title IS NOT OLD.title OR NEW.year IS NOT OLD.year OR NEW.tmdb_doc_digest IS NOT OLD.tmdb_doc_digest
  OR NEW.attempt_request_id IS NOT OLD.attempt_request_id))
 OR (OLD.link_state IS NULL AND NEW.link_state IS NOT NULL AND NOT (NEW.link_state = 'owed' AND NEW.outcome = 'attached'))
 OR (OLD.link_state = 'owed' AND NEW.link_state NOT IN ('owed', 'linked', 'alias_conflict', 'link_blocked'))
 OR (OLD.link_state IS NOT NULL AND OLD.link_state <> 'owed' AND NEW.link_state IS NOT OLD.link_state)
BEGIN
 SELECT RAISE(ABORT, 'lid_recheck_intent_update');
END;

-- The row is never deleted: the intent is the durable record that makes a lost response and a late Ratings link recoverable and auditable.
CREATE TRIGGER lid_recheck_intent_keep
BEFORE DELETE ON lid_recheck_intent
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'lid_recheck_intent_keep');
END;

UPDATE schema_contract
SET version = 51,
    note = 'Schema v51: the owner re-check intent lid_recheck_intent (AIR-675, ADR 0217 decision 8a: revision compare-and-swap, no delete). Empty; no data change. Version 51 follows a complete version 50.'
WHERE id = 1 AND version = 50;
