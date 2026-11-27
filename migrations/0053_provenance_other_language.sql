-- Schema v53: verified other-language tags in the per-field provenance (AIR-693; ADR 0214 decisions 2 and 9, ADR 0224 Accepted, P1-A). ADDITIVE in effect and DORMANT. Migration 0049 let `language` hold only 'ru' or 'en', so a verified two-letter tag of another language (for example `fr` on a last-resort poster, kept in the typed observation and its digest by AIR-684) could not be stored. This file widens that ONE constraint family and changes nothing else.
--  1. `film_metadata_field.language`, `film_metadata_history.old_language` and `.new_language`: NULL, or a normalized two-letter lowercase tag (length 2, only a-z). SQLite cannot alter a CHECK, so both tables are REBUILT: created under a temporary name with the widened text, every row copied (history keeps its `id`), the old table dropped, the new one renamed.
--  2. Nothing else changes: every other column, CHECK (paired NULLs, only synopsis and poster, `assumed` only as English of a Letterboxd synopsis), the primary key, the history UNIQUE key and the absence of any other index and foreign key are the text of 0049. `explicit` stays the only basis for a tag other than the assumed English.
--  3. The triggers that live on the two rebuilt tables are dropped with them and CREATED AGAIN with their 0049 text; the nine triggers on `film_metadata` that read `film_metadata_field` are dropped before the rebuild and created again with their 0049 text, so no trigger ever names a missing table. The control table, the command table, the release table and the invalidation, lock, immutability and protection-released behaviour are unchanged.
-- No row is lost, rewritten or backfilled; a database with provenance rows keeps every one. DORMANT: the file is in the repository and is NOT applied to any database by a deploy; applying it is a separate owner L3 GO (AIR-632 names the exact file). Until it is applied the writer must not be told a tag the schema cannot hold (see the code gate in docs/reference/domain/catalog-enrichment.md).
-- It follows a complete version 52 and refuses anything else before an object is changed: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file; a second apply, or a database whose tables are not the 0049 shape, is refused the same way. The version becomes 53 and never goes down.
-- If another change takes number 53 first, this file is renumbered at merge. Identifiers only; the only pattern is the character-class GLOB of 0049 (tests/migration-pattern-limit.mjs scans this file).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 52)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata_field')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata_history')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata_provenance_control')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('film_metadata_field_invalidate_update', 'film_metadata_field_invalidate_delete', 'film_metadata_field_invalidate_move', 'film_metadata_field_invalidate_insert', 'film_metadata_owner_value_locked', 'film_metadata_owner_row_deleted', 'film_metadata_owner_row_moved', 'film_metadata_owner_row_inserted', 'film_metadata_owner_row_moved_in', 'film_metadata_field_owner_inserted', 'film_metadata_field_owner_updated', 'film_metadata_field_owner_deleted', 'film_metadata_field_protection_released', 'film_metadata_history_no_update', 'film_metadata_history_no_delete')) = 15
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata_field' AND instr(sql, 'language IN (''ru'', ''en'')') > 0)
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name IN ('film_metadata_field_v53', 'film_metadata_history_v53'))
);

-- 1. The nine triggers on film_metadata that read film_metadata_field are removed first and recreated below with their 0049 text.
DROP TRIGGER film_metadata_field_invalidate_update;
DROP TRIGGER film_metadata_field_invalidate_delete;
DROP TRIGGER film_metadata_field_invalidate_move;
DROP TRIGGER film_metadata_field_invalidate_insert;
DROP TRIGGER film_metadata_owner_value_locked;
DROP TRIGGER film_metadata_owner_row_deleted;
DROP TRIGGER film_metadata_owner_row_moved;
DROP TRIGGER film_metadata_owner_row_inserted;
DROP TRIGGER film_metadata_owner_row_moved_in;

-- 2. The rebuilt tables: the 0049 text with the widened language constraint only.
-- 2. The per-field provenance row, bound to its value by `value_digest` (SHA-256 of the canonical JSON of the stored value). The constraint text is the reviewed shape of ADR 0214 decision 2.
CREATE TABLE film_metadata_field_v53 (
 film_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK (field IN ('year', 'runtime', 'synopsis', 'poster', 'url', 'genres')),
 tier TEXT NOT NULL CHECK (tier IN ('owner', 'automatic', 'released')),
 source TEXT NOT NULL CHECK (source IN ('letterboxd', 'tmdb', 'owner', 'unattributed')),
 origin TEXT NOT NULL CHECK (origin IN ('catalog_enrichment', 'owner_route')),
 anchor_scheme TEXT CHECK (anchor_scheme IS NULL OR anchor_scheme IN ('letterboxd', 'tmdb')),
 anchor_value TEXT CHECK (anchor_value IS NULL OR length(anchor_value) BETWEEN 1 AND 200),
 anchor_digest TEXT CHECK (anchor_digest IS NULL OR (length(anchor_digest) = 64 AND anchor_digest NOT GLOB '*[^0-9a-f]*')),
 agreement TEXT CHECK (agreement IS NULL OR agreement IN ('confirmed', 'not_required', 'unconfirmed')),
 language TEXT CHECK (language IS NULL OR (length(language) = 2 AND language NOT GLOB '*[^a-z]*')),
 language_basis TEXT CHECK (language_basis IS NULL OR language_basis IN ('explicit', 'assumed')),
 observed_at TEXT NOT NULL CHECK (length(observed_at) = 24),
 checked_at TEXT NOT NULL CHECK (length(checked_at) = 24),
 value_digest TEXT NOT NULL CHECK (length(value_digest) = 64 AND value_digest NOT GLOB '*[^0-9a-f]*'),
 write_key TEXT NOT NULL CHECK (length(write_key) BETWEEN 1 AND 200),
 written_revision INTEGER NOT NULL CHECK (written_revision >= 1),
 updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
 PRIMARY KEY (film_id, field),
 CHECK ((anchor_scheme IS NULL) = (anchor_value IS NULL)),
 CHECK ((tier = 'automatic') = (agreement IS NOT NULL)),
 CHECK (tier <> 'automatic' OR (anchor_scheme IS NOT NULL AND anchor_digest IS NOT NULL)),
 CHECK (source NOT IN ('owner', 'unattributed') OR (origin = 'owner_route' AND tier IN ('owner', 'released') AND anchor_scheme IS NULL)),
 CHECK (source <> 'owner' OR anchor_digest IS NOT NULL),
 -- ADR 0224 (language-bound provenance): the language of the selected value and the evidence for it, bound to the value like every other semantic column. Only synopsis and poster carry one; NULL is unknown or not applicable.
 -- `assumed` is the owner-approved P4-B default for a freshly observed Letterboxd synopsis (not a verified tag): it means ENGLISH, and exists for no other field, source or language.
 CHECK ((language IS NULL) = (language_basis IS NULL)),
 CHECK (language IS NULL OR field IN ('synopsis', 'poster')),
 CHECK (language_basis IS NULL OR language_basis <> 'assumed' OR (field = 'synopsis' AND source = 'letterboxd' AND language = 'en'))
) STRICT, WITHOUT ROWID;
INSERT INTO film_metadata_field_v53 (film_id, field, tier, source, origin, anchor_scheme, anchor_value, anchor_digest, agreement, language, language_basis, observed_at, checked_at, value_digest, write_key, written_revision, updated_at) SELECT film_id, field, tier, source, origin, anchor_scheme, anchor_value, anchor_digest, agreement, language, language_basis, observed_at, checked_at, value_digest, write_key, written_revision, updated_at FROM film_metadata_field;
DROP TABLE film_metadata_field;
ALTER TABLE film_metadata_field_v53 RENAME TO film_metadata_field;

-- 3. The history. Append-only; nothing cascades into it, so it outlives a deleted row or Film. `old_value_text` is the canonical JSON text of one scalar or array (a value, not a provenance store).
CREATE TABLE film_metadata_history_v53 (
 id INTEGER PRIMARY KEY,
 film_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK (field IN ('year', 'runtime', 'synopsis', 'poster', 'url', 'genres')),
 reason TEXT NOT NULL CHECK (reason IN ('replaced', 'cleared', 'merge_discarded', 'owner_set', 'owner_lock', 'owner_release', 'owner_revert')),
 old_value_text TEXT,
 old_tier TEXT CHECK (old_tier IS NULL OR old_tier IN ('owner', 'automatic', 'released')),
 old_source TEXT CHECK (old_source IS NULL OR old_source IN ('letterboxd', 'tmdb', 'owner', 'unattributed')),
 old_anchor_scheme TEXT CHECK (old_anchor_scheme IS NULL OR old_anchor_scheme IN ('letterboxd', 'tmdb')),
 old_anchor_value TEXT,
 old_anchor_digest TEXT CHECK (old_anchor_digest IS NULL OR (length(old_anchor_digest) = 64 AND old_anchor_digest NOT GLOB '*[^0-9a-f]*')),
 old_agreement TEXT CHECK (old_agreement IS NULL OR old_agreement IN ('confirmed', 'not_required', 'unconfirmed')),
 old_language TEXT CHECK (old_language IS NULL OR (length(old_language) = 2 AND old_language NOT GLOB '*[^a-z]*')),
 old_language_basis TEXT CHECK (old_language_basis IS NULL OR old_language_basis IN ('explicit', 'assumed')),
 old_observed_at TEXT,
 new_value_digest TEXT CHECK (new_value_digest IS NULL OR (length(new_value_digest) = 64 AND new_value_digest NOT GLOB '*[^0-9a-f]*')),
 new_tier TEXT CHECK (new_tier IS NULL OR new_tier IN ('owner', 'automatic', 'released')),
 new_source TEXT CHECK (new_source IS NULL OR new_source IN ('letterboxd', 'tmdb', 'owner', 'unattributed')),
 new_language TEXT CHECK (new_language IS NULL OR (length(new_language) = 2 AND new_language NOT GLOB '*[^a-z]*')),
 new_language_basis TEXT CHECK (new_language_basis IS NULL OR new_language_basis IN ('explicit', 'assumed')),
 new_anchor_digest TEXT CHECK (new_anchor_digest IS NULL OR (length(new_anchor_digest) = 64 AND new_anchor_digest NOT GLOB '*[^0-9a-f]*')),
 write_key TEXT NOT NULL CHECK (length(write_key) BETWEEN 1 AND 200),
 at TEXT NOT NULL CHECK (length(at) = 24),
 merged_from TEXT,
 CHECK (reason <> 'merge_discarded' OR merged_from IS NOT NULL),
 -- the language columns obey the field-row invariants on both sides: paired NULLs, only synopsis and poster, and `assumed` only as English of a Letterboxd synopsis
 CHECK ((old_language IS NULL) = (old_language_basis IS NULL)),
 CHECK ((new_language IS NULL) = (new_language_basis IS NULL)),
 CHECK ((old_language IS NULL AND new_language IS NULL) OR field IN ('synopsis', 'poster')),
 CHECK (old_language_basis IS NULL OR old_language_basis <> 'assumed' OR (field = 'synopsis' AND old_source IS 'letterboxd' AND old_language IS 'en')),
 CHECK (new_language_basis IS NULL OR new_language_basis <> 'assumed' OR (field = 'synopsis' AND new_source IS 'letterboxd' AND new_language IS 'en')),
 UNIQUE (film_id, field, write_key)
) STRICT;
INSERT INTO film_metadata_history_v53 (id, film_id, field, reason, old_value_text, old_tier, old_source, old_anchor_scheme, old_anchor_value, old_anchor_digest, old_agreement, old_language, old_language_basis, old_observed_at, new_value_digest, new_tier, new_source, new_language, new_language_basis, new_anchor_digest, write_key, at, merged_from) SELECT id, film_id, field, reason, old_value_text, old_tier, old_source, old_anchor_scheme, old_anchor_value, old_anchor_digest, old_agreement, old_language, old_language_basis, old_observed_at, new_value_digest, new_tier, new_source, new_language, new_language_basis, new_anchor_digest, write_key, at, merged_from FROM film_metadata_history;
DROP TABLE film_metadata_history;
ALTER TABLE film_metadata_history_v53 RENAME TO film_metadata_history;
CREATE TRIGGER film_metadata_history_no_update BEFORE UPDATE ON film_metadata_history
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_history_append_only');
END;
CREATE TRIGGER film_metadata_history_no_delete BEFORE DELETE ON film_metadata_history
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_history_append_only');
END;

-- 3. The triggers, with the text of 0049.
-- INVALIDATION. Always on. They delete only non-owner field rows, in the statement that makes them stale; the writer orders its batch so the value changes first and the new field row follows.
-- (SQLite fires the UPDATE triggers, not the INSERT trigger, for an upsert that takes DO UPDATE; an equal value raises no deletion, so an adoption updates the row in place. tests/film-metadata-provenance.mjs proves it on real SQLite.)
CREATE TRIGGER film_metadata_field_invalidate_update AFTER UPDATE OF year, runtime, synopsis, poster, url, genres_json ON film_metadata
BEGIN
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'year' AND tier <> 'owner' AND NEW.year IS NOT OLD.year;
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'runtime' AND tier <> 'owner' AND NEW.runtime IS NOT OLD.runtime;
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'synopsis' AND tier <> 'owner' AND NEW.synopsis IS NOT OLD.synopsis;
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'poster' AND tier <> 'owner' AND NEW.poster IS NOT OLD.poster;
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'url' AND tier <> 'owner' AND NEW.url IS NOT OLD.url;
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND field = 'genres' AND tier <> 'owner' AND NEW.genres_json IS NOT OLD.genres_json;
END;
CREATE TRIGGER film_metadata_field_invalidate_delete AFTER DELETE ON film_metadata
BEGIN
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND tier <> 'owner';
END;
CREATE TRIGGER film_metadata_field_invalidate_move AFTER UPDATE OF film_id ON film_metadata
WHEN NEW.film_id IS NOT OLD.film_id
BEGIN
 DELETE FROM film_metadata_field WHERE film_id = OLD.film_id AND tier <> 'owner';
END;
CREATE TRIGGER film_metadata_field_invalidate_insert AFTER INSERT ON film_metadata
BEGIN
 DELETE FROM film_metadata_field WHERE film_id = NEW.film_id AND tier <> 'owner';
END;

-- LOCKS. Gated by the control mode: nothing here fires at `off` or while the control row is absent. Code that predates this file never writes a pin, so these only ever stop a raw statement.
CREATE TRIGGER film_metadata_owner_value_locked BEFORE UPDATE OF year, runtime, synopsis, poster, url, genres_json ON film_metadata
WHEN EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id = 1 AND mode IN ('enforce', 'hold'))
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = OLD.film_id)
 AND (NEW.year IS NOT OLD.year OR NEW.runtime IS NOT OLD.runtime OR NEW.synopsis IS NOT OLD.synopsis OR NEW.poster IS NOT OLD.poster OR NEW.url IS NOT OLD.url OR NEW.genres_json IS NOT OLD.genres_json)
 AND (
  EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = OLD.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
  OR EXISTS (
   SELECT 1 FROM film_metadata_field f WHERE f.film_id = OLD.film_id AND f.tier = 'owner' AND (
    (f.field = 'year' AND NEW.year IS NOT OLD.year) OR (f.field = 'runtime' AND NEW.runtime IS NOT OLD.runtime) OR (f.field = 'synopsis' AND NEW.synopsis IS NOT OLD.synopsis)
    OR (f.field = 'poster' AND NEW.poster IS NOT OLD.poster) OR (f.field = 'url' AND NEW.url IS NOT OLD.url) OR (f.field = 'genres' AND NEW.genres_json IS NOT OLD.genres_json)
   )
  )
 )
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
CREATE TRIGGER film_metadata_owner_row_deleted BEFORE DELETE ON film_metadata
WHEN EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id = 1 AND mode IN ('enforce', 'hold'))
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = OLD.film_id)
 AND (
  EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = OLD.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
  OR EXISTS (SELECT 1 FROM film_metadata_field f WHERE f.film_id = OLD.film_id AND f.tier = 'owner')
 )
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
CREATE TRIGGER film_metadata_owner_row_moved BEFORE UPDATE OF film_id ON film_metadata
WHEN NEW.film_id IS NOT OLD.film_id
 AND EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id = 1 AND mode IN ('enforce', 'hold'))
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = OLD.film_id)
 AND (
  EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = OLD.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
  OR EXISTS (SELECT 1 FROM film_metadata_field f WHERE f.film_id = OLD.film_id AND f.tier = 'owner')
 )
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
-- The DESTINATION is protected like the origin (review of 8c0cb0a5): a raw insert of a NEW row (an upsert that takes DO UPDATE is an update, which the value trigger judges) into a Film whose metadata dimension is locked, or that still holds an owner field row, and a move of a row INTO such a Film, abort unless the destination has its release row.
-- A locked Film with no metadata row is protected by the approved rule, so these cover the empty destination too.
CREATE TRIGGER film_metadata_owner_row_inserted BEFORE INSERT ON film_metadata
WHEN EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id = 1 AND mode IN ('enforce', 'hold'))
 AND NOT EXISTS (SELECT 1 FROM film_metadata m WHERE m.film_id = NEW.film_id)
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = NEW.film_id)
 AND (
  EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = NEW.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
  OR EXISTS (SELECT 1 FROM film_metadata_field f WHERE f.film_id = NEW.film_id AND f.tier = 'owner')
 )
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
CREATE TRIGGER film_metadata_owner_row_moved_in BEFORE UPDATE OF film_id ON film_metadata
WHEN NEW.film_id IS NOT OLD.film_id
 AND EXISTS (SELECT 1 FROM film_metadata_provenance_control WHERE id = 1 AND mode IN ('enforce', 'hold'))
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = NEW.film_id)
 AND (
  EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = NEW.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
  OR EXISTS (SELECT 1 FROM film_metadata_field f WHERE f.film_id = NEW.film_id AND f.tier = 'owner')
 )
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
-- An insert (also INSERT OR REPLACE, which would remove the row without firing the delete trigger) over an existing owner field row aborts unless the Film has its release row.
CREATE TRIGGER film_metadata_field_owner_inserted BEFORE INSERT ON film_metadata_field
WHEN EXISTS (SELECT 1 FROM film_metadata_field f WHERE f.film_id = NEW.film_id AND f.field = NEW.field AND f.tier = 'owner')
 AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = NEW.film_id)
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
-- A pin cannot be overwritten, deleted or moved away. Not gated: an owner field row exists only after activation.
CREATE TRIGGER film_metadata_field_owner_updated BEFORE UPDATE ON film_metadata_field
WHEN OLD.tier = 'owner' AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = OLD.film_id)
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;
CREATE TRIGGER film_metadata_field_owner_deleted BEFORE DELETE ON film_metadata_field
WHEN OLD.tier = 'owner' AND NOT EXISTS (SELECT 1 FROM film_metadata_owner_release WHERE film_id = OLD.film_id)
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_locked');
END;

-- PROTECTION RELEASED (ADR 0219 decision 8): only an ACTUAL release wakes the `core` part: an owner pin that becomes unprotected while the Film's metadata dimension lock does not still protect it. Inbox only; the same coalescing upsert as the identity emitters of 0047.
-- A pin that is merely moved or rewritten under a release row stays a pin and signals nothing; an owner-authority clear signals through its own statement (the writer), because a delete under the release row cannot tell a release from a move.
CREATE TRIGGER film_metadata_field_protection_released AFTER UPDATE ON film_metadata_field
WHEN OLD.tier = 'owner' AND NEW.tier <> 'owner'
 AND NOT EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id = NEW.film_id AND d.dimension = 'metadata' AND (d.status = 'reviewed' OR COALESCE(d.authority, '') = 'owner'))
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 VALUES ('protection_released', NEW.film_id, '', 'core', 1, 0, 'pending', 'film_metadata_field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;

UPDATE schema_contract
SET version = 53,
    note = 'Schema v53: verified two-letter other-language tags in the per-field provenance (film_metadata_field and film_metadata_history rebuilt with the widened language CHECK, triggers recreated, every row kept) (dormant). Version 53 follows a complete version 52.'
WHERE id = 1 AND version = 52;
