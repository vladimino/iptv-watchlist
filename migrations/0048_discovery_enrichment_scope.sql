-- Schema v48: the Discovery scope of the Catalog Enrichment Producer (AIR-684, card C3c-D; ADR 0219 decisions 3, 9 and 11, on the common structures of 0047). ADDITIVE and DORMANT:
--  1. `discovery_transfer.origin` and `origin_batches`: the explicit provenance of a loading transfer. `origin = 'resolver'` is declared ONLY by the resolver run that publishes the catalog (`context.admission`); every other
--     writer (an import, a restore, an operator tool, an old Worker version) leaves it NULL and is non-authoritative. `origin_batches` is the `batches` value the loading statement stamped with it, so a stale origin that an
--     old-version statement did not refresh is recognised and dropped at the next loading start. The transfer identity stays the existing `programme_run_id`.
--  2. Two gated triggers on `discovery_admission` (insert only; a row that exists can never become stream, there is no update trigger): a movie row inserted WHILE a transfer is `loading` writes a `staged` signal
--     (whether or not the scope has been activated), and a movie row inserted on the steady path after the scope has first been activated writes a `pending` `admitted` signal. A TV row is never signalled.
--  3. Settlement by the transfer's own transitions: a transfer entering `loading` clears a stale origin and deletes the staged signals of every non-resolver origin; the `loading` to `committed` transition promotes the staged
--     signals of a RESOLVER publication whose admission row is current (only when the scope is activated at that commit) and deletes every other staged signal of that commit, then clears the origin.
-- The signals are written ONLY into the existing inbox `enrichment_signal` inside the causal statement's transaction. No existing row changes; the discovery scope row is not created here (activation is C3c-A) so nothing is
-- emitted until an owner operation activates it. NOT applied by a deploy: applying it is a separate owner GO (AIR-685).
-- It follows a complete version 47 and refuses anything else before an object is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file. The version becomes 48 and never goes down.
-- If another change takes number 48 first, this file is renumbered at merge. Identifiers only; no LIKE or GLOB pattern (tests/migration-pattern-limit.mjs scans this file).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 47)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_enrichment_scope')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'enrichment_signal')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovery_transfer')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovery_admission')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM pragma_table_info('discovery_transfer') WHERE name IN ('origin', 'origin_batches'))
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name IN ('discovery_enrichment_staged', 'discovery_enrichment_admitted', 'discovery_enrichment_loading', 'discovery_enrichment_settle'))
);

ALTER TABLE discovery_transfer ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin = 'resolver');
ALTER TABLE discovery_transfer ADD COLUMN origin_batches INTEGER CHECK (origin_batches IS NULL OR origin_batches >= 0);

-- A movie admission inserted while a transfer is loading: staged, never consumable. The cause_ref carries the origin and the transfer identity (`resolver:<programme_run_id>` or `other:<programme_run_id>`). A second
-- insert of the same subject (an abandoned attempt, then another) only refreshes a STAGED row; a signal that is already pending or consumed is left exactly as it is.
CREATE TRIGGER discovery_enrichment_staged AFTER INSERT ON discovery_admission
WHEN NEW.media_kind = 'movie' AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id = 1 AND state = 'loading')
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'admitted', 'tmdb:' || NEW.tmdb_id, 'discovery', '', 1, 0, 'staged',
  substr(COALESCE(origin, 'other') || ':' || COALESCE(programme_run_id, ''), 1, 200), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 FROM discovery_transfer WHERE id = 1
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET cause_ref = excluded.cause_ref, armed_at = excluded.armed_at WHERE enrichment_signal.state = 'staged';
END;

-- The steady path: a genuinely new movie admission outside a transfer, after the scope has first been activated (the permanent `activated` flag, not `enabled`: a disabled scope keeps recording). No cutoff column is read:
-- the cutoff of the Discovery scope is its activation.
CREATE TRIGGER discovery_enrichment_admitted AFTER INSERT ON discovery_admission
WHEN NEW.media_kind = 'movie'
 AND NOT EXISTS (SELECT 1 FROM discovery_transfer WHERE id = 1 AND state = 'loading')
 AND EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope = 'discovery' AND activated = 1)
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 VALUES ('admitted', 'tmdb:' || NEW.tmdb_id, 'discovery', '', 1, 0, 'pending', 'discovery_admission', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;

-- A transfer entering `loading` (any statement that sets the state). A stale origin (not stamped by THIS statement: an old-version writer never sets it) is dropped, and the staged signals of every non-resolver origin
-- are deleted, so a failed import or restore is never promoted. Staged signals of an abandoned RESOLVER attempt are kept for a later resolver publication.
CREATE TRIGGER discovery_enrichment_loading AFTER UPDATE OF state ON discovery_transfer
WHEN NEW.state = 'loading'
BEGIN
 UPDATE discovery_transfer SET origin = NULL, origin_batches = NULL WHERE id = NEW.id AND origin IS NOT NULL AND origin_batches IS NOT NEW.batches;
 DELETE FROM enrichment_signal WHERE kind = 'admitted' AND source = 'discovery' AND part = '' AND state = 'staged' AND substr(COALESCE(cause_ref, ''), 1, 9) <> 'resolver:';
END;

-- The commit of a transfer (the batch that sets `committed`) settles the staged signals. A RESOLVER publication, with the scope activated at this commit, makes every staged resolver signal whose admission row is current
-- `pending` (a new version, so a consumed re-admission cannot be missed); every other staged signal of the commit is deleted. A non-resolver commit deletes its own staged signals and keeps those of an abandoned resolver
-- attempt. The origin is cleared, so it can never survive into another writer's commit.
CREATE TRIGGER discovery_enrichment_settle AFTER UPDATE OF state ON discovery_transfer
WHEN NEW.state = 'committed' AND OLD.state = 'loading'
BEGIN
 UPDATE enrichment_signal SET state = 'pending', version = version + 1, cause_ref = 'discovery_transfer', armed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = 0, last_error = NULL, retry_at = NULL
 WHERE kind = 'admitted' AND source = 'discovery' AND part = '' AND state = 'staged' AND substr(COALESCE(cause_ref, ''), 1, 9) = 'resolver:'
  AND NEW.origin = 'resolver' AND NEW.origin_batches IS NOT NULL
  AND EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope = 'discovery' AND activated = 1)
  AND EXISTS (SELECT 1 FROM discovery_admission a WHERE a.media_kind = 'movie' AND a.state = 'current' AND a.tmdb_id = substr(enrichment_signal.subject, 6));
 DELETE FROM enrichment_signal WHERE kind = 'admitted' AND source = 'discovery' AND part = '' AND state = 'staged'
  AND (NEW.origin IS 'resolver' OR substr(COALESCE(cause_ref, ''), 1, 9) <> 'resolver:');
 UPDATE discovery_transfer SET origin = NULL, origin_batches = NULL WHERE id = NEW.id AND origin IS NOT NULL;
END;

UPDATE schema_contract
SET version = 48,
    note = 'Schema v48: the Discovery scope of the Catalog Enrichment Producer (transfer origin, gated admission triggers, staged-signal settlement; dormant). Version 48 follows a complete version 47.'
WHERE id = 1 AND version = 47;
