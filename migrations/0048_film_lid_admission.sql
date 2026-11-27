-- Schema v48: the lid-only admission row `film_lid_admission` (AIR-672, delivery step 3 of ADR 0217, Accepted; choices I1, J1 and K2 of the owner's disposition of 25 Nov 2026).
-- ONE additive STRICT table and two triggers. No data migration. DORMANT and INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it is a separate,
-- action-specific owner approval, in the owner's coordinated pending-migration window (AIR-648) and the exact schema chain (ADR 0217 delivery step 7a). No delivered writer reads or writes the table before
-- the admission activation (ADR 0217 delivery step 9, owner L3 GO), so the apply changes no behaviour. The only rows it writes is the schema_contract version.
-- It was written as 0047 and renumbered to 0048 at merge because AIR-605's 0047 (the Catalog Enrichment Producer schema) landed first. It follows a complete version 47 and refuses anything else before the table is created: the first statement inserts a row that CHECK (id = 1) forbids (id 0) and so aborts the file (a second apply, a
-- missing schema_contract row and a wrong version included). The version becomes 48 and never goes down.
--
-- One row is the immutable, recomputable PAGE-CHECK PROOF of one lid-only Film (ADR 0217 decision 7, K2): the proof of a complete validated Letterboxd film page with a positively absent TMDB relation (H1).
--   * `lid` is the primary key: one Film per lid, a keep-first fact (the same invariant `film_external_id_one_trusted` gives the trusted `letterboxd` claim, now also on this row).
--   * `film_id` names the Film the batch minted (`film:lb:<lid>`). It is the ONLY column that may change, and only by a merge (`mergeFilms` moves it, as it moves `film_rated_admission`). No foreign key:
--     readers resolve `film_id` through `film_redirect`.
--   * The CAUSAL SOURCE ROOT: `proof_digest = sha256(proof_version, lid, final film URL, slug, canonical path, shortlink, type marker, id-block outcome, completeness outcome, title, year or null)`. Every input
--     has its own column, so the digest can be recomputed from the row. The proof is normalized, never archived: no HTML is stored.
--   * The ROUTE OBSERVATION METADATA, kept apart from the root: `route`, `checked_at`, `redirect_status`, `page_status`, `receipt_key` (the operation key of the admitting receipt). Two routes that check the
--     same page share one root.
--   * `year` is optional for a lid-only admission only (decision 2).
-- The id-block outcome of an admitted row is `absent` and the completeness outcome is `complete`; the CHECKs say so, because only `tmdb_none` ever admits. A state that is not an admission is never a row.
-- Identifiers, short lowercase codes and ISO-8601 UTC times only. D1 evaluates a LIKE or GLOB pattern of at most 50 bytes, so every CHECK keeps its patterns short (see 0021).

-- Accepted is exactly one schema_contract row at version 47 AND the objects this file depends on, by name (PRESENCE checks, not a claim of full schema integrity): the Film admission table the lid-only row
-- sits beside, the receipt table with the 0039 `operation_key` column, the 0046 admission authority marker, the 0047 Catalog Enrichment scope table, the Film external id table with its trusted-owner index, the redirect table, the shared no-downgrade
-- trigger, and no object of the new name.
INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 47)
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('film_rated_admission', 'canonical_write_receipt', 'letterboxd_admission_authority', 'film_external_id', 'film_redirect', 'catalog_enrichment_scope')
 ) = 6
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_write_receipt' AND sql LIKE '%operation_key%')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'film_external_id_one_trusted')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'film_lid_admission%')
);

CREATE TABLE film_lid_admission (
 lid TEXT PRIMARY KEY CHECK (length(lid) BETWEEN 1 AND 80 AND lid NOT GLOB '*[^A-Za-z0-9_-]*'),
 film_id TEXT NOT NULL CHECK (film_id LIKE 'film:%'),
 route TEXT NOT NULL CHECK (route IN ('watchlist_admission', 'ratings_diary', 'letterboxd_rated_archive')),
 admitted_at TEXT NOT NULL CHECK (length(admitted_at) BETWEEN 20 AND 32 AND substr(admitted_at, 11, 1) = 'T' AND substr(admitted_at, -1) = 'Z'),
 receipt_key TEXT NOT NULL CHECK (receipt_key = 'admission:lid:' || lid),
 proof_version INTEGER NOT NULL CHECK (proof_version >= 1),
 final_url TEXT NOT NULL CHECK (length(final_url) BETWEEN 1 AND 300),
 slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 200),
 canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 300),
 shortlink TEXT NOT NULL CHECK (shortlink = lid),
 type_marker TEXT NOT NULL CHECK (length(type_marker) BETWEEN 1 AND 40),
 id_block_outcome TEXT NOT NULL CHECK (id_block_outcome = 'absent'),
 completeness_outcome TEXT NOT NULL CHECK (completeness_outcome = 'complete'),
 title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
 year INTEGER CHECK (year IS NULL OR year BETWEEN 1800 AND 2200),
 proof_digest TEXT NOT NULL CHECK (length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*'),
 checked_at TEXT NOT NULL CHECK (length(checked_at) BETWEEN 20 AND 32 AND substr(checked_at, 11, 1) = 'T' AND substr(checked_at, -1) = 'Z'),
 redirect_status INTEGER NOT NULL CHECK (redirect_status BETWEEN 300 AND 399),
 page_status INTEGER NOT NULL CHECK (page_status = 200)
) STRICT;

-- Keep-first and immutable: every column except `film_id` is frozen, and `film_id` moves only by a merge (the one legitimate later change).
CREATE TRIGGER film_lid_admission_immutable
BEFORE UPDATE ON film_lid_admission
FOR EACH ROW
WHEN NEW.lid IS NOT OLD.lid OR NEW.route IS NOT OLD.route OR NEW.admitted_at IS NOT OLD.admitted_at OR NEW.receipt_key IS NOT OLD.receipt_key
  OR NEW.proof_version IS NOT OLD.proof_version OR NEW.final_url IS NOT OLD.final_url OR NEW.slug IS NOT OLD.slug OR NEW.canonical_path IS NOT OLD.canonical_path
  OR NEW.shortlink IS NOT OLD.shortlink OR NEW.type_marker IS NOT OLD.type_marker OR NEW.id_block_outcome IS NOT OLD.id_block_outcome
  OR NEW.completeness_outcome IS NOT OLD.completeness_outcome OR NEW.title IS NOT OLD.title OR NEW.year IS NOT OLD.year OR NEW.proof_digest IS NOT OLD.proof_digest
  OR NEW.checked_at IS NOT OLD.checked_at OR NEW.redirect_status IS NOT OLD.redirect_status OR NEW.page_status IS NOT OLD.page_status
BEGIN
 SELECT RAISE(ABORT, 'film_lid_admission_immutable');
END;

-- The row is never deleted: a wrongly admitted Film is corrected by an owner action under a later decision, never by a delete (ADR 0217, stop rule).
CREATE TRIGGER film_lid_admission_keep
BEFORE DELETE ON film_lid_admission
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'film_lid_admission_keep');
END;

UPDATE schema_contract
SET version = 48,
    note = 'Schema v48: the lid-only admission row film_lid_admission (AIR-672, ADR 0217 K2: keep-first, immutable except film_id, no delete). Empty; no data change. Version 48 follows a complete version 47.'
WHERE id = 1 AND version = 47;
