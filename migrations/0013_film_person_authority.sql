-- Schema v13: the canonical Film/Person authority marker, its generation fence, the per-entity revision and the
-- baseline gate (ADR 0099, Accepted; AIR-367).
-- It follows a complete version 12 and refuses anything else before a table is created: the first statement
-- inserts a second schema_contract row and so aborts the file. The version becomes 13 and never goes down.
-- A deploy does not apply this file. The inserted marker is mode r2, cutover open, generation 0: R2 stays the
-- authority and the enrichment projector stays the only writer of Film and Person. Applying this file copies no
-- row, writes no Film or Person, and does not move the marker.
-- film_person_authority states, with cutover open unless stated:
--   r2        R2 sources are authoritative and the projector is the only writer (the initial state).
--   prepared  a complete fenced baseline and delta has passed parity (film_person_baseline.state = 'verified');
--             R2 is still authoritative and the projector is still the only writer.
--   d1        D1 is authoritative; only the fenced canonical mutations write.
--   d1/held   a freeze after activation: writers refuse and readers fail closed (never back to R2).
-- Allowed moves, each by one generation: r2 -> prepared, prepared -> r2, prepared -> d1, d1 -> d1/held and
-- d1/held -> d1. A move out of r2 needs a verified baseline, and a verified baseline cannot be reopened while the marker is prepared or d1, so prepared and d1 always stand on a verified one. There is deliberately no move out of d1 or
-- d1/held to r2: a recovery after activation is a separately approved reverse reconciliation, not a flag flip.
-- film_person_cas is the batch fence (a statement that sets ok to 0 fails the CHECK and rolls the batch back).
-- canonical_revision is the per-entity revision: an entity without a row has revision 0 and every fenced mutation
-- moves it by exactly one. The projector does not write it.
-- film_person_baseline is the gate a partial load cannot pass: the state is empty, loading or verified.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version >= 12 AND version < 13
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN (
   'film',
   'person',
   'film_external_id',
   'person_external_id',
   'film_alias',
   'person_alias',
   'film_redirect',
   'film_person_credit',
   'film_generation',
   'film_epg_last_airing',
   'discovery_authority',
   'discovery_seal'
  )
 ) = 12
);

CREATE TABLE film_person_authority (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 mode TEXT NOT NULL CHECK (mode IN ('r2', 'prepared', 'd1')),
 cutover TEXT NOT NULL CHECK (cutover IN ('open', 'held')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 CHECK (mode = 'd1' OR cutover = 'open')
) STRICT;

CREATE TABLE film_person_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok >= 1)
) STRICT;

CREATE TABLE film_person_baseline (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('empty', 'loading', 'verified')),
 reference TEXT,
 updated_at TEXT
) STRICT;

CREATE TABLE canonical_revision (
 kind TEXT NOT NULL CHECK (kind IN ('film', 'person')),
 id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (kind, id),
 CHECK ((kind = 'film' AND id LIKE 'film:%') OR (kind = 'person' AND id LIKE 'person:%'))
) STRICT;

CREATE TRIGGER film_person_authority_transition
BEFORE UPDATE ON film_person_authority
FOR EACH ROW
WHEN NOT (
 NEW.id = OLD.id
 AND NEW.generation = OLD.generation + 1
 AND (
  (OLD.mode = 'r2' AND OLD.cutover = 'open' AND NEW.mode = 'prepared' AND NEW.cutover = 'open')
  OR (OLD.mode = 'prepared' AND OLD.cutover = 'open' AND NEW.mode = 'r2' AND NEW.cutover = 'open')
  OR (OLD.mode = 'prepared' AND OLD.cutover = 'open' AND NEW.mode = 'd1' AND NEW.cutover = 'open')
  OR (OLD.mode = 'd1' AND OLD.cutover = 'open' AND NEW.mode = 'd1' AND NEW.cutover = 'held')
  OR (OLD.mode = 'd1' AND OLD.cutover = 'held' AND NEW.mode = 'd1' AND NEW.cutover = 'open')
 )
)
BEGIN
 SELECT RAISE(ABORT, 'film_person_authority_transition');
END;

CREATE TRIGGER film_person_authority_needs_baseline
BEFORE UPDATE ON film_person_authority
FOR EACH ROW
WHEN NEW.mode IN ('prepared', 'd1') AND OLD.mode = 'r2'
 AND NOT EXISTS (SELECT 1 FROM film_person_baseline WHERE id = 1 AND state = 'verified')
BEGIN
 SELECT RAISE(ABORT, 'film_person_baseline_not_verified');
END;

CREATE TRIGGER film_person_authority_no_delete
BEFORE DELETE ON film_person_authority
FOR EACH ROW
BEGIN
 SELECT RAISE(ABORT, 'film_person_authority_delete');
END;

CREATE TRIGGER film_person_baseline_transition
BEFORE UPDATE ON film_person_baseline
FOR EACH ROW
WHEN NOT (
 NEW.id = OLD.id
 AND (
  (OLD.state = 'empty' AND NEW.state = 'loading')
  OR (OLD.state = 'loading' AND NEW.state IN ('loading', 'verified'))
  OR (OLD.state = 'verified' AND NEW.state = 'loading')
 )
)
BEGIN
 SELECT RAISE(ABORT, 'film_person_baseline_transition');
END;

CREATE TRIGGER film_person_baseline_reopen_needs_r2
BEFORE UPDATE ON film_person_baseline
FOR EACH ROW
WHEN OLD.state = 'verified' AND NEW.state = 'loading'
 AND EXISTS (SELECT 1 FROM film_person_authority WHERE id = 1 AND mode IN ('prepared', 'd1'))
BEGIN
 SELECT RAISE(ABORT, 'film_person_baseline_in_use');
END;

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO film_person_authority (id, mode, cutover, generation) VALUES (1, 'r2', 'open', 0);
INSERT INTO film_person_cas (id, ok) VALUES (1, 1);
INSERT INTO film_person_baseline (id, state, reference, updated_at) VALUES (1, 'empty', NULL, NULL);

UPDATE schema_contract
SET version = 13,
    note = 'Schema v13: canonical Film/Person authority marker, fence, per-entity revision and baseline gate. Marker mode r2 until a separate activation. Follows a complete version 12.'
WHERE id = 1 AND version >= 12 AND version < 13;
