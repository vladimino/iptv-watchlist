-- Schema v49: per-field provenance of film_metadata (AIR-631, card PV1; ADR 0214 decisions 2, 9 and 11, Accepted). ADDITIVE and DORMANT. Five new STRICT tables and the triggers below; no existing table, column or row changes, and nothing is backfilled.
--  1. `film_metadata_provenance_control`: the one durable control row (id = 1), inserted at mode `off`. The mode moves only off -> enforce, enforce -> hold and hold -> enforce, each raising `revision`; it never returns to `off`.
--  2. `film_metadata_field`: one typed provenance row per Film and field (year, runtime, synopsis, poster, url, genres), bound to the stored value by `value_digest`. No JSON, no foreign key, the primary key is the only index.
--  3. `film_metadata_history`: append-only; one row per replaced, cleared or discarded value and per owner action.
--  4. `film_metadata_owner_command`: the immutable record of a committed owner command (the owner route, card PV3, writes it; this file only creates the table).
--  5. `film_metadata_owner_release`: normally EMPTY. A transient authorization row that an owner-authority batch (or a merge with pins) inserts first and deletes last, so the lock triggers below let that batch through.
-- Triggers (ADR 0214 decisions 2 and 11):
--  - INVALIDATION (always, they only ever delete non-owner field rows): a raw change, delete, move or insert of a `film_metadata` row removes the field rows it makes stale, whatever code issues it. A pin (`tier = 'owner'`) is never deleted by them.
--  - LOCKS (gated by the control mode, so they do nothing at `off`): once the mode is `enforce` or `hold`, a changed pinned column, a delete or a move of a pinned Film's row, and an update or delete of an owner field row abort with `film_metadata_owner_locked`
--    unless the release row of that Film exists. The metadata dimension lock (status `reviewed` or authority `owner`) protects every field the same way. A statement that changes none of the six value columns is never refused by the value lock.
--  - IMMUTABILITY: history and command rows refuse UPDATE and DELETE; the control row refuses DELETE, a return to `off`, an illegal transition and an update that does not raise `revision`.
--  - PROTECTION RELEASED (guarded, inbox only): an owner pin that becomes unprotected (and is not still protected by the metadata dimension lock) writes the coalesced `protection_released` signal of part `core` into `enrichment_signal` (ADR 0219 decision 8). The release row is a transient
--    authorization, not a protection state, so it signals nothing; a pin that is only moved or kept signals nothing; C1 never writes a pin, so C1 never wakes itself.
-- DORMANT: the file is in the repository and is NOT applied to any database by a deploy. Applying it is card PVM, a separate production GO. At mode `off` the writer writes no provenance, the lock triggers do nothing, and the invalidation triggers delete nothing (no row exists).
-- It follows a complete version 48 (which follows the Catalog Enrichment schema of 47, whose inbox the signal triggers write; written as 0048 and renumbered to 0049 at merge because AIR-672's 0048 landed first) and refuses anything else before an object is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file.
-- If another change takes number 49 first, this file is renumbered at merge. Identifiers only; no LIKE or GLOB pattern beyond the 64-hex digest checks and a short name prefix in the refusal guard (D1 limits pattern length, see 0021; tests/migration-pattern-limit.mjs scans this file).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 48)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_lid_admission')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'enrichment_signal')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_enrichment_control')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_metadata')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'film_dimension')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'film_metadata_field%' OR name LIKE 'film_metadata_history%' OR name LIKE 'film_metadata_owner_%' OR name LIKE 'film_metadata_provenance_%')
);

-- 1. The control row. Created at `off`; an ABSENT row (table present, row missing) fails the metadata write closed (ADR 0214 decision 11).
CREATE TABLE film_metadata_provenance_control (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('off', 'enforce', 'hold')),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
 updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 80)
) STRICT;
INSERT INTO film_metadata_provenance_control (id, mode, revision, updated_at, updated_by)
VALUES (1, 'off', 1, '2026-11-27T00:00:00.000Z', 'migration:0049');
CREATE TRIGGER film_metadata_provenance_no_delete BEFORE DELETE ON film_metadata_provenance_control
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_provenance_no_delete');
END;
-- Once the mode leaves `off` it never returns (the old merge never comes back under this code).
CREATE TRIGGER film_metadata_provenance_one_way BEFORE UPDATE ON film_metadata_provenance_control
WHEN OLD.mode <> 'off' AND NEW.mode = 'off'
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_provenance_one_way');
END;
-- Only off -> enforce, enforce -> hold and hold -> enforce; every update raises `revision` by exactly one.
CREATE TRIGGER film_metadata_provenance_transition BEFORE UPDATE ON film_metadata_provenance_control
WHEN NEW.id <> OLD.id
 OR NEW.revision <> OLD.revision + 1
 OR (NEW.mode <> OLD.mode AND NOT ((OLD.mode = 'off' AND NEW.mode = 'enforce') OR (OLD.mode = 'enforce' AND NEW.mode = 'hold') OR (OLD.mode = 'hold' AND NEW.mode = 'enforce')))
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_provenance_transition');
END;

-- 2. The per-field provenance row, bound to its value by `value_digest` (SHA-256 of the canonical JSON of the stored value). The constraint text is the reviewed shape of ADR 0214 decision 2.
CREATE TABLE film_metadata_field (
 film_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK (field IN ('year', 'runtime', 'synopsis', 'poster', 'url', 'genres')),
 tier TEXT NOT NULL CHECK (tier IN ('owner', 'automatic', 'released')),
 source TEXT NOT NULL CHECK (source IN ('letterboxd', 'tmdb', 'owner', 'unattributed')),
 origin TEXT NOT NULL CHECK (origin IN ('catalog_enrichment', 'owner_route')),
 anchor_scheme TEXT CHECK (anchor_scheme IS NULL OR anchor_scheme IN ('letterboxd', 'tmdb')),
 anchor_value TEXT CHECK (anchor_value IS NULL OR length(anchor_value) BETWEEN 1 AND 200),
 anchor_digest TEXT CHECK (anchor_digest IS NULL OR (length(anchor_digest) = 64 AND anchor_digest NOT GLOB '*[^0-9a-f]*')),
 agreement TEXT CHECK (agreement IS NULL OR agreement IN ('confirmed', 'not_required', 'unconfirmed')),
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
 CHECK (source <> 'owner' OR anchor_digest IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- 3. The history. Append-only; nothing cascades into it, so it outlives a deleted row or Film. `old_value_text` is the canonical JSON text of one scalar or array (a value, not a provenance store).
CREATE TABLE film_metadata_history (
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
 old_observed_at TEXT,
 new_value_digest TEXT CHECK (new_value_digest IS NULL OR (length(new_value_digest) = 64 AND new_value_digest NOT GLOB '*[^0-9a-f]*')),
 new_tier TEXT CHECK (new_tier IS NULL OR new_tier IN ('owner', 'automatic', 'released')),
 new_source TEXT CHECK (new_source IS NULL OR new_source IN ('letterboxd', 'tmdb', 'owner', 'unattributed')),
 new_anchor_digest TEXT CHECK (new_anchor_digest IS NULL OR (length(new_anchor_digest) = 64 AND new_anchor_digest NOT GLOB '*[^0-9a-f]*')),
 write_key TEXT NOT NULL CHECK (length(write_key) BETWEEN 1 AND 200),
 at TEXT NOT NULL CHECK (length(at) = 24),
 merged_from TEXT,
 CHECK (reason <> 'merge_discarded' OR merged_from IS NOT NULL),
 UNIQUE (film_id, field, write_key)
) STRICT;
CREATE TRIGGER film_metadata_history_no_update BEFORE UPDATE ON film_metadata_history
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_history_append_only');
END;
CREATE TRIGGER film_metadata_history_no_delete BEFORE DELETE ON film_metadata_history
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_history_append_only');
END;

-- 4. The owner command record: one immutable row per committed owner command (`outcome` applied or noop). PV3 writes it in the same batch as the effect.
CREATE TABLE film_metadata_owner_command (
 request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 200),
 film_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('set', 'lock', 'release', 'revert', 'refresh')),
 command_digest TEXT NOT NULL CHECK (length(command_digest) = 64 AND command_digest NOT GLOB '*[^0-9a-f]*'),
 outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'noop')),
 applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 1),
 at TEXT NOT NULL CHECK (length(at) = 24),
 CHECK (action = 'refresh' OR applied_revision IS NOT NULL)
) STRICT;
CREATE TRIGGER film_metadata_owner_command_no_update BEFORE UPDATE ON film_metadata_owner_command
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_command_immutable');
END;
CREATE TRIGGER film_metadata_owner_command_no_delete BEFORE DELETE ON film_metadata_owner_command
BEGIN
 SELECT RAISE(ABORT, 'film_metadata_owner_command_immutable');
END;

-- 5. The release row: normally empty. Only an owner-authority batch, or a merge with pins, inserts it as its FIRST statement and deletes it as its LAST; an abort rolls the whole batch back, so it never stays.
CREATE TABLE film_metadata_owner_release (
 film_id TEXT PRIMARY KEY
) STRICT, WITHOUT ROWID;

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
SET version = 49,
    note = 'Schema v49: per-field provenance of film_metadata (control row at off, field, history, owner command and release tables, invalidation, lock and immutability triggers) (dormant). Version 49 follows a complete version 48.'
WHERE id = 1 AND version = 48;
