-- Schema v31: EPG Channel authority (AIR-561). Channel, provider category and per-category policy as their own D1 entity.
-- INERT: this file is in the repository and is NOT applied to any database by a deploy. Applying it to production D1 and every later
-- step (import, activation, reading the policy in a scan) are separate owner GOs. Nothing in the Worker reads these tables, so
-- applying this file changes no EPG, Discovery or scan behavior. There is deliberately NO mode marker: the tables are a contract
-- that stays unused until a later, separately approved change reads one policy snapshot.
-- It follows a complete version 30 (the EPG checkpoint tables present) and refuses anything else before a table is created: the first
-- statement inserts a second schema_contract row and so aborts the file. The version becomes 31 and never goes down.
--
-- Three things are kept apart and never merged into one column:
--  - provider category: epg_channel.category_key, the M3U group the channel was classified into (NULL = not classified);
--  - policy: epg_channel_category.policy per category, and epg_channel.override_policy for an owner override. The EFFECTIVE policy
--    is never stored; it is derived as  override_policy > category.policy > 'known_only'  (src/epg-channel-d1.js);
--  - provenance: epg_channel_revision.source_sha256 (the import the rows came from) and override_at / override_note per override.
-- epg_channel_revision is the one revision of the whole snapshot (the marker is NOT an authority switch): every committed write adds
-- one, a write names the revision it read (compare-and-swap), and category_count / channel_count let a reader prove it read every row.
-- import_revision is the revision of the latest import and plan_sha256 the digest of that import's whole normalized plan (categories,
-- policies, channels); source_sha256 is only the provenance of the provider files. A channel with last_seen_revision < import_revision
-- is absent from the latest import: it is KEPT (never deleted for being missing), unclassified, and so known_only unless it has an override.
-- epg_channel_cas is the batch fence, not a switch (same pattern as filter_preset_cas and started_cas).
-- channel_id is the XMLTV id as published_epg_show.channel_id and discovery_observation_show.channel_id carry it (ch001, ch1259).
-- source_id is the provider id as the M3U spells it (tvg_1, tvg_1259). There is NO foreign key to the historical show tables:
-- shows keep their own keys and are never rewritten or required to have a channel row.

INSERT INTO schema_contract (id, version, note)
SELECT 1, 0, 'refused'
WHERE NOT EXISTS (
 SELECT 1 FROM schema_contract
 WHERE id = 1 AND version = 30
 AND (
  SELECT COUNT(*) FROM sqlite_master
  WHERE type = 'table' AND name IN ('epg_checkpoint_authority', 'epg_checkpoint_cas', 'epg_checkpoint_run')
 ) = 3
);

CREATE TABLE epg_channel_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 revision INTEGER NOT NULL CHECK (revision >= 0),
 source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
 plan_sha256 TEXT CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
 import_revision INTEGER NOT NULL CHECK (import_revision >= 0 AND import_revision <= revision),
 category_count INTEGER NOT NULL CHECK (category_count >= 0),
 channel_count INTEGER NOT NULL CHECK (channel_count >= 0),
 updated_at TEXT
) STRICT;

CREATE TABLE epg_channel_cas (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE epg_channel_category (
 category_key TEXT PRIMARY KEY CHECK (length(category_key) > 0),
 name TEXT NOT NULL CHECK (length(name) > 0),
 policy TEXT NOT NULL CHECK (policy IN ('deny_all', 'discover', 'known_only')),
 position INTEGER NOT NULL CHECK (position >= 0),
 revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;

CREATE TABLE epg_channel (
 channel_id TEXT PRIMARY KEY CHECK (length(channel_id) > 0),
 source_id TEXT NOT NULL CHECK (length(source_id) > 0),
 name TEXT,
 category_key TEXT REFERENCES epg_channel_category(category_key),
 override_policy TEXT CHECK (override_policy IS NULL OR override_policy IN ('deny_all', 'discover', 'known_only')),
 override_note TEXT,
 override_at TEXT,
 revision INTEGER NOT NULL CHECK (revision >= 1),
 last_seen_revision INTEGER NOT NULL CHECK (last_seen_revision >= 1),
 UNIQUE (source_id),
 CHECK (
  (override_policy IS NULL AND override_note IS NULL AND override_at IS NULL)
  OR (override_policy IS NOT NULL AND override_at IS NOT NULL)
 )
) STRICT;

CREATE INDEX epg_channel_by_category ON epg_channel(category_key);

CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade
BEFORE UPDATE OF version ON schema_contract
FOR EACH ROW
WHEN NEW.id = 1 AND NEW.version < OLD.version
BEGIN
 SELECT RAISE(ABORT, 'schema_contract_downgrade');
END;

INSERT INTO epg_channel_revision (id, revision, source_sha256, plan_sha256, import_revision, category_count, channel_count, updated_at) VALUES (1, 0, NULL, NULL, 0, 0, 0, NULL);
INSERT INTO epg_channel_cas (id, ok) VALUES (1, 1);

UPDATE schema_contract
SET version = 31,
    note = 'Schema v31: EPG Channel authority tables, no marker and no reader. Version 31 follows a complete version 30.'
WHERE id = 1 AND version = 30;
