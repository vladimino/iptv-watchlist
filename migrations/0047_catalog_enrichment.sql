-- Schema v47: the Catalog Enrichment Producer's own schema (AIR-605, card C1; ADR 0211 decisions 3, 5 and 6 as amended by ADR 0219 decisions 2, 3, 7, 8 and 9; ADR 0207 decision 7). ADDITIVE: new tables, and
-- triggers on existing tables that write ONLY the bounded, coalesced inbox `enrichment_signal`. No existing table, column or row changes.
--  1. `enrichment_signal`: the inbox, the whole contract between emitters and the producer (key (kind, subject, source, part), all NOT NULL; `version` is the change token, `acked_version` the newest applied one).
--  2. `catalog_enrichment_scope`: one row per scope (rated, c3a, c3b, discovery) with the permanent `activated` flag, the current `enabled` flag, the cutoff, the bootstrap state and cursor and a `revision`.
--  3. `catalog_enrichment_member`: the retained membership of a Film in a scope (P2 = B).
--  4. `catalog_enrichment_state`: per Film, part, source and credits chunk slot; the Film row (`part = 'film'`, `source = '*'`) carries `plan_epoch`; `deferred_repair` is the quarantine with an automatic recovery.
--  5. `catalog_enrichment_unit_generation`: the durable, shared logical-unit generation of the receipt-key rollover (ADR 0219 decision 7; Catalog Enrichment Producer keys only).
--  6. `catalog_enrichment_tick`: the small outbox of one run (started / finished / stopped, counts).
--  7. `catalog_enrichment_control`: the one durable control row (inactive | active | paused, `generation`, `revision`). An ABSENT row reads as `inactive`. Every change of a scope row advances the generation.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it is card CM (AIR-606), a separate owner GO. The scope table is created EMPTY and the gated rated trigger writes nothing
-- while no scope row is activated; the producer reads "not active" without a control row. The identity triggers write only the inbox, and the producer ignores subjects that belong to no enabled scope.
-- It follows a complete version 46 and refuses anything else before an object is created: the first statement inserts a row that CHECK (id = 1) forbids and so aborts the file. The version becomes 47 and never goes down.
-- If another change takes number 47 first, this file is renumbered at merge. Identifiers only; no LIKE or GLOB pattern beyond a short name prefix in the refusal guard (D1 limits pattern length, see 0021; tests/migration-pattern-limit.mjs scans this file).

INSERT INTO schema_contract (id, version, note)
SELECT 0, 0, 'refused'
WHERE NOT (
 (SELECT COUNT(*) FROM schema_contract) = 1
 AND EXISTS (SELECT 1 FROM schema_contract WHERE id = 1 AND version = 46)
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upstream_cooldown')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upstream_coordination')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'letterboxd_admission_authority')
 AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'schema_contract_no_downgrade')
 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'catalog_enrichment_%' OR name = 'enrichment_signal')
);

-- 1. The inbox. A unique key over nullable columns would not coalesce (SQLite treats NULLs as distinct), so source and part are NOT NULL with the empty default.
CREATE TABLE enrichment_signal (
 kind TEXT NOT NULL CHECK (kind IN ('admitted', 'anchor_changed', 'source_changed', 'protection_released')),
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
 source TEXT NOT NULL DEFAULT '' CHECK (length(source) <= 40),
 part TEXT NOT NULL DEFAULT '' CHECK (length(part) <= 40),
 version INTEGER NOT NULL CHECK (version >= 1),
 acked_version INTEGER NOT NULL DEFAULT 0 CHECK (acked_version >= 0 AND acked_version <= version),
 state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'staged')),
 cause_digest TEXT CHECK (cause_digest IS NULL OR length(cause_digest) = 64),
 cause_ref TEXT CHECK (cause_ref IS NULL OR length(cause_ref) <= 200),
 armed_at TEXT NOT NULL CHECK (length(armed_at) = 24),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
 retry_at TEXT CHECK (retry_at IS NULL OR length(retry_at) = 24),
 PRIMARY KEY (kind, subject, source, part)
) STRICT;
CREATE INDEX enrichment_signal_by_state ON enrichment_signal (state, armed_at);

-- 2. Scopes. `activated` is set once and never reset (an emitter writes nothing before the first activation); `enabled` says whether the producer's EFFECTS run for the scope.
CREATE TABLE catalog_enrichment_scope (
 scope TEXT PRIMARY KEY CHECK (scope IN ('rated', 'c3a', 'c3b', 'discovery')),
 activated INTEGER NOT NULL CHECK (activated IN (0, 1)),
 enabled INTEGER NOT NULL CHECK (enabled IN (0, 1) AND (enabled = 0 OR activated = 1)),
 cutoff_at TEXT CHECK (cutoff_at IS NULL OR length(cutoff_at) = 24),
 bootstrap_state TEXT NOT NULL DEFAULT 'none' CHECK (bootstrap_state IN ('none', 'running', 'done')),
 bootstrap_cursor TEXT CHECK (bootstrap_cursor IS NULL OR length(bootstrap_cursor) <= 400),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
) STRICT;

-- 3. Retained membership: a Film's eligibility persists while it stops airing or being current; one row per Film and scope.
CREATE TABLE catalog_enrichment_member (
 film_id TEXT NOT NULL REFERENCES film (id),
 scope TEXT NOT NULL CHECK (scope IN ('rated', 'c3a', 'c3b', 'discovery')),
 admitted_at TEXT NOT NULL CHECK (length(admitted_at) = 24),
 signal_key TEXT NOT NULL CHECK (length(signal_key) BETWEEN 1 AND 400),
 PRIMARY KEY (film_id, scope)
) STRICT;
CREATE INDEX catalog_enrichment_member_by_scope ON catalog_enrichment_member (scope, admitted_at);

-- 4. State. `slot` is the credits chunk number (0 for every other part); a chunk holds at most 50 person ids. `cohort` feeds the indexed due selection of decision 5.
CREATE TABLE catalog_enrichment_state (
 film_id TEXT NOT NULL REFERENCES film (id),
 part TEXT NOT NULL CHECK (part IN ('film', 'core', 'credits', 'localization')),
 source TEXT NOT NULL CHECK (source IN ('*', 'letterboxd', 'tmdb', 'wikidata')),
 slot INTEGER NOT NULL DEFAULT 0 CHECK (slot >= 0 AND (slot = 0 OR part = 'credits')),
 status TEXT NOT NULL CHECK (status IN ('active', 'due', 'complete', 'complete_with_gaps', 'not_applicable', 'needs_attention', 'deferred_repair', 'identity_disagreement')),
 reason TEXT,
 cohort TEXT NOT NULL DEFAULT 'live' CHECK (cohort IN ('live', 'history')),
 -- `held` = 1 while the Film has NO enabled membership: its rows stay out of the due indexes (a disabled scope costs the due selection nothing). Maintained only by the scope and membership triggers below, never by the producer.
 held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
 anchor TEXT,
 source_version TEXT,
 refresh_epoch INTEGER NOT NULL DEFAULT 0 CHECK (refresh_epoch >= 0),
 plan_epoch INTEGER NOT NULL DEFAULT 0 CHECK (plan_epoch >= 0),
 failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
 transport_streak INTEGER NOT NULL DEFAULT 0 CHECK (transport_streak >= 0),
 failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('transport', 'repairable', 'owner_required')),
 failure_signature TEXT CHECK (failure_signature IS NULL OR length(failure_signature) <= 200),
 code_version TEXT CHECK (code_version IS NULL OR length(code_version) <= 80),
 response_digest TEXT CHECK (response_digest IS NULL OR length(response_digest) = 64),
 pending_since TEXT CHECK (pending_since IS NULL OR length(pending_since) = 24),
 retry_at TEXT CHECK (retry_at IS NULL OR length(retry_at) = 24),
 due_since TEXT NOT NULL CHECK (length(due_since) = 24),
 expected_json TEXT CHECK (expected_json IS NULL OR json_valid(expected_json)),
 gaps_json TEXT CHECK (gaps_json IS NULL OR json_valid(gaps_json)),
 conflicts_json TEXT CHECK (conflicts_json IS NULL OR json_valid(conflicts_json)),
 hints_json TEXT CHECK (hints_json IS NULL OR json_valid(hints_json)),
 film_json TEXT CHECK (film_json IS NULL OR json_valid(film_json)),
 updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
 PRIMARY KEY (film_id, part, source, slot),
 CHECK ((part = 'film') = (source = '*')),
 CHECK (part <> 'film' OR status IN ('active', 'identity_disagreement')),
 CHECK (part = 'film' OR status <> 'active')
) STRICT;
-- The indexed due selection (ADR 0219 decision 5): two PARTIAL indexes, one per kind of runnable row, ordered by the run-after time (`COALESCE(retry_at, '')`: a row with no retry is due now and sorts first) and then by how long
-- it has been due. A pick pages through ONE of them per cohort with a keyset cursor, so the rows it examines are exactly the rows it reads (bounded per page) and a blocked or repeated head never hides what is behind it.
CREATE INDEX catalog_enrichment_state_runnable ON catalog_enrichment_state (cohort, COALESCE(retry_at, ''), due_since, film_id, part, source, slot) WHERE part <> 'film' AND status IN ('due', 'deferred_repair') AND held = 0;
CREATE INDEX catalog_enrichment_state_anchor ON catalog_enrichment_state (cohort, COALESCE(retry_at, ''), due_since, film_id) WHERE part = 'film' AND status = 'active' AND reason = 'check_anchors' AND held = 0;

-- 5. The receipt-key generation of one logical unit (a part of a Film, or a Person unit shared by several Films). Advanced only by a compare-and-swap on generation and history fingerprint; never deleted.
CREATE TABLE catalog_enrichment_unit_generation (
 unit_key TEXT PRIMARY KEY CHECK (length(unit_key) BETWEEN 1 AND 300),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 history_fingerprint TEXT CHECK (history_fingerprint IS NULL OR length(history_fingerprint) <= 100),
 updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
) STRICT;

-- 6. The outbox of one run.
CREATE TABLE catalog_enrichment_tick (
 tick_id TEXT PRIMARY KEY CHECK (length(tick_id) BETWEEN 1 AND 200),
 started_at TEXT NOT NULL CHECK (length(started_at) = 24),
 finished_at TEXT CHECK (finished_at IS NULL OR length(finished_at) = 24),
 state TEXT NOT NULL CHECK (state IN ('started', 'finished', 'stopped')),
 counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
 delivered_at TEXT CHECK (delivered_at IS NULL OR length(delivered_at) = 24),
 delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0)
) STRICT;
CREATE INDEX catalog_enrichment_tick_recent ON catalog_enrichment_tick (started_at);

-- 7. The control. Never deleted, never back to `inactive`; moves only along activate (inactive to active, owner operation C2), pause and resume, and a same-state bump when a scope row changes. Generation and revision
-- only grow, so a stale request or a stale run can never match a newer row.
CREATE TABLE catalog_enrichment_control (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 state TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'paused')),
 generation INTEGER NOT NULL CHECK (generation >= 0),
 revision INTEGER NOT NULL CHECK (revision >= 1),
 updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
 updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200)
) STRICT;
CREATE TRIGGER catalog_enrichment_control_no_delete BEFORE DELETE ON catalog_enrichment_control
BEGIN
 SELECT RAISE(ABORT, 'catalog_enrichment_control_no_delete');
END;
CREATE TRIGGER catalog_enrichment_control_transition BEFORE UPDATE ON catalog_enrichment_control
WHEN NOT (
 NEW.generation > OLD.generation AND NEW.revision > OLD.revision AND (
  (OLD.state = 'inactive' AND NEW.state = 'active')
  OR (OLD.state = 'active' AND NEW.state IN ('paused', 'active'))
  OR (OLD.state = 'paused' AND NEW.state IN ('active', 'paused'))
 )
)
BEGIN
 SELECT RAISE(ABORT, 'catalog_enrichment_control_transition');
END;

-- Scope rows: never deleted, `activated` never reset; every insert or update advances the common control generation (when a control row exists and is not `inactive`), which fences every in-flight effect.
CREATE TRIGGER catalog_enrichment_scope_no_delete BEFORE DELETE ON catalog_enrichment_scope
BEGIN
 SELECT RAISE(ABORT, 'catalog_enrichment_scope_no_delete');
END;
CREATE TRIGGER catalog_enrichment_scope_activated_once BEFORE UPDATE ON catalog_enrichment_scope
WHEN OLD.activated = 1 AND NEW.activated = 0
BEGIN
 SELECT RAISE(ABORT, 'catalog_enrichment_scope_activated_once');
END;
CREATE TRIGGER catalog_enrichment_scope_fence_insert AFTER INSERT ON catalog_enrichment_scope
BEGIN
 UPDATE catalog_enrichment_control SET generation = generation + 1, revision = revision + 1, updated_at = NEW.updated_at WHERE id = 1 AND state <> 'inactive';
END;
-- A bootstrap advancing its own cursor and state is NOT a configuration change: only a change of the flags, the cutoff or the revision fences the control generation (otherwise every bootstrap page would stop the drainer).
CREATE TRIGGER catalog_enrichment_scope_fence_update AFTER UPDATE ON catalog_enrichment_scope
WHEN OLD.enabled IS NOT NEW.enabled OR OLD.activated IS NOT NEW.activated OR OLD.cutoff_at IS NOT NEW.cutoff_at OR OLD.revision IS NOT NEW.revision
BEGIN
 UPDATE catalog_enrichment_control SET generation = generation + 1, revision = revision + 1, updated_at = NEW.updated_at WHERE id = 1 AND state <> 'inactive';
END;

-- Eligibility lives in the index, not in a scan: a scope toggle (rare, owner-driven) moves the `held` flag of the affected Films' rows, so a disabled scope's members are not in the due indexes at all. A Film with at least one enabled
-- membership is never held. The producer never writes the flag; a membership of an enabled scope releases the Film's rows.
CREATE TRIGGER catalog_enrichment_scope_disabled AFTER UPDATE OF enabled ON catalog_enrichment_scope
WHEN OLD.enabled = 1 AND NEW.enabled = 0
BEGIN
 UPDATE catalog_enrichment_state SET held = 1
 WHERE held = 0 AND film_id IN (SELECT film_id FROM catalog_enrichment_member WHERE scope = NEW.scope)
 AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope = m.scope AND c.enabled = 1 WHERE m.film_id = catalog_enrichment_state.film_id);
END;
CREATE TRIGGER catalog_enrichment_scope_enabled AFTER UPDATE OF enabled ON catalog_enrichment_scope
WHEN OLD.enabled = 0 AND NEW.enabled = 1
BEGIN
 UPDATE catalog_enrichment_state SET held = 0 WHERE held = 1 AND film_id IN (SELECT film_id FROM catalog_enrichment_member WHERE scope = NEW.scope);
END;
CREATE TRIGGER catalog_enrichment_scope_inserted_enabled AFTER INSERT ON catalog_enrichment_scope
WHEN NEW.enabled = 1
BEGIN
 UPDATE catalog_enrichment_state SET held = 0 WHERE held = 1 AND film_id IN (SELECT film_id FROM catalog_enrichment_member WHERE scope = NEW.scope);
END;
CREATE TRIGGER catalog_enrichment_member_released AFTER INSERT ON catalog_enrichment_member
WHEN EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope = NEW.scope AND enabled = 1)
BEGIN
 UPDATE catalog_enrichment_state SET held = 0 WHERE held = 1 AND film_id = NEW.film_id;
END;

-- The emitters. Each statement upserts one inbox row: a new row has version 1, an existing row has its version raised and becomes pending again (a semantic re-arm). They write ONLY enrichment_signal,
-- inside the causal statement's transaction, so the signal and the change commit or roll back together. None is on film_metadata, film_person_credit, person or film_localization_source: the producer's own writes emit nothing.
-- Identity: a trusted-anchor scheme (tmdb, letterboxd) row of a Film changed. The Film, the old and the new owner and every other Film holding the old or the new (scheme, value) are signalled.
CREATE TRIGGER catalog_enrichment_anchor_insert AFTER INSERT ON film_external_id
WHEN NEW.scheme IN ('tmdb', 'letterboxd')
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'anchor_changed', film_id, '', '', 1, 0, 'pending', 'film_external_id', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 FROM film_external_id WHERE scheme = NEW.scheme AND value = NEW.value
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
CREATE TRIGGER catalog_enrichment_anchor_update AFTER UPDATE ON film_external_id
WHEN (OLD.scheme IN ('tmdb', 'letterboxd') OR NEW.scheme IN ('tmdb', 'letterboxd'))
 AND (OLD.film_id IS NOT NEW.film_id OR OLD.scheme IS NOT NEW.scheme OR OLD.value IS NOT NEW.value OR OLD.trusted IS NOT NEW.trusted OR OLD.conflicting IS NOT NEW.conflicting)
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'anchor_changed', film_id, '', '', 1, 0, 'pending', 'film_external_id', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 FROM film_external_id WHERE (scheme = OLD.scheme AND value = OLD.value) OR (scheme = NEW.scheme AND value = NEW.value)
 UNION SELECT 'anchor_changed', OLD.film_id, '', '', 1, 0, 'pending', 'film_external_id', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
CREATE TRIGGER catalog_enrichment_anchor_delete AFTER DELETE ON film_external_id
WHEN OLD.scheme IN ('tmdb', 'letterboxd')
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'anchor_changed', film_id, '', '', 1, 0, 'pending', 'film_external_id', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 FROM film_external_id WHERE scheme = OLD.scheme AND value = OLD.value
 UNION SELECT 'anchor_changed', OLD.film_id, '', '', 1, 0, 'pending', 'film_external_id', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
-- A retirement or restore decision: the decided Film and every Film holding that TMDB movie id.
CREATE TRIGGER catalog_enrichment_retirement_insert AFTER INSERT ON tmdb_retirement_decision
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'anchor_changed', film_id, '', '', 1, 0, 'pending', 'tmdb_retirement_decision', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 FROM film_external_id WHERE scheme = 'tmdb' AND value = NEW.movie_id
 UNION SELECT 'anchor_changed', NEW.film_id, '', '', 1, 0, 'pending', 'tmdb_retirement_decision', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
-- A redirect or merge: the source and the survivor.
CREATE TRIGGER catalog_enrichment_redirect_insert AFTER INSERT ON film_redirect
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 SELECT 'anchor_changed', NEW.from_id, '', '', 1, 0, 'pending', 'film_redirect', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 UNION SELECT 'anchor_changed', NEW.to_film_id, '', '', 1, 0, 'pending', 'film_redirect', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
-- A protection released: only a change from protected (reviewed, or owner authority) to unprotected, or the delete of a protected row, on the metadata or localization dimension.
CREATE TRIGGER catalog_enrichment_protection_update AFTER UPDATE ON film_dimension
WHEN OLD.dimension IN ('metadata', 'localization')
 AND (OLD.status = 'reviewed' OR COALESCE(OLD.authority, '') = 'owner')
 AND NEW.status <> 'reviewed' AND COALESCE(NEW.authority, '') <> 'owner'
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 VALUES ('protection_released', NEW.film_id, '', OLD.dimension, 1, 0, 'pending', 'film_dimension', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
CREATE TRIGGER catalog_enrichment_protection_delete AFTER DELETE ON film_dimension
WHEN OLD.dimension IN ('metadata', 'localization') AND (OLD.status = 'reviewed' OR COALESCE(OLD.authority, '') = 'owner')
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 VALUES ('protection_released', OLD.film_id, '', OLD.dimension, 1, 0, 'pending', 'film_dimension', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;
-- The rated admission: gated by the rated scope's permanent `activated` flag AND by the approved cohort predicate (`verified_at >= cutoff_at`, the same predicate the bootstrap applies), so it writes nothing until AIR-607 activates the scope
-- and never admits a delayed or backdated row from before the cutoff. A scope with no cutoff admits nothing live. Subject `tmdb:<n>`, source `rated`.
CREATE TRIGGER catalog_enrichment_rated_admitted AFTER INSERT ON film_rated_admission
WHEN EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope = 'rated' AND activated = 1 AND cutoff_at IS NOT NULL AND NEW.verified_at >= cutoff_at)
BEGIN
 INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts)
 VALUES ('admitted', 'tmdb:' || NEW.tmdb, 'rated', '', 1, 0, 'pending', 'film_rated_admission', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0)
 ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL;
END;

UPDATE schema_contract
SET version = 47,
    note = 'Schema v47: the Catalog Enrichment Producer schema (inbox, scope, member, state, unit generation, outbox, control) and its inbox-only emitters (dormant). Version 47 follows a complete version 46.'
WHERE id = 1 AND version = 46;
