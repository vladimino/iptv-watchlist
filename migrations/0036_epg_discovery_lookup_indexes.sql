-- Schema v36: two ADDITIVE, non-unique lookup indexes for the open hotspots of the AIR-579 D1 load RCA (docs/evidence/d1-migration/air-579-d1-overload-rca-2026-11-22.md,
-- docs/evidence/d1-migration/air-579-index-candidates-offline-2026-11-23.md). The owner approved variant D1 for OFFLINE preparation on 23 Nov 2026; that is a choice of implementation, not a production GO.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 is a separate owner GO (runbook: docs/runbooks/d1-lookup-indexes-0036-apply.md).
-- It follows a complete version 35 (migration 0035, which is NOT changed, after 0034 which is NOT changed) and refuses anything else before an index is created: the first statement inserts a
-- second schema_contract row and so aborts the file. The version becomes 36 and never goes down.
--
-- Nothing is written to any table: no row of any table changes, no marker, no authority, no lease, no fence, no CAS row, no trigger and no table is touched. The only new objects are two indexes; the only
-- row that changes is the single schema_contract row. No query text of the Worker changes: the planner starts using the indexes for the statements below, which return the same rows.
--
--  1. published_epg_show_discovery_by_match ON published_epg_show (programme_run_id, match_reason) WHERE basis = 'discovery'
--     serves ASSIGNED_ROWS_DELETE (src/discovery-authority.js): DELETE ... WHERE programme_run_id = (SELECT programme_run_id FROM published_epg_authority WHERE id = 1) AND basis = 'discovery' AND match_reason = ?.
--     Until now the only index besides the primary key was (programme_run_id, start_ms), so each execution walked every row of the run (about 20 k). A PARTIAL index: only Discovery-assigned rows are indexed
--     (every index entry is a D1 rows_written), and the planner uses it only for a statement whose WHERE implies basis = 'discovery', which the delete states literally.
--  2. film_external_id_by_scheme_value ON film_external_id (scheme, value)
--     serves the three lookups by (scheme, value) that read EVERY trust state (the existing unique index film_external_id_one_trusted is partial on trusted = 1 AND conflicting = 0 and cannot serve them).
--     The lookup by film_id already rides the primary key (film_id, scheme, value) and is unchanged.
-- Both are plain CREATE INDEX: a query that returns rows returns the same rows with or without them.
-- Identifiers and bounded integers only. No LIKE or GLOB pattern (see 0021).

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 35
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'prediction_aux_authority', 'prediction_aux_import_chunk', 'prediction_aux_seal', 'prediction_aux_verify_slice',
   'published_epg_authority', 'published_epg_show', 'film_external_id'
  )
 ) = 7
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'index' AND name IN ('published_epg_show_by_generation', 'film_external_id_one_trusted')
 ) = 2
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'index' AND name IN ('published_epg_show_discovery_by_match', 'film_external_id_by_scheme_value')
 ) = 0
);

CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show (programme_run_id, match_reason) WHERE basis = 'discovery';
CREATE INDEX film_external_id_by_scheme_value ON film_external_id (scheme, value);

UPDATE schema_contract
SET version = 36,
    note = 'Schema v36: lookup indexes published_epg_show_discovery_by_match (partial, basis = discovery) and film_external_id_by_scheme_value, no data change. Version 36 follows a complete version 35.'
WHERE id = 1 AND version = 35;
