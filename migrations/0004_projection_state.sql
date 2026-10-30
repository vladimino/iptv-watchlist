-- AIR-275 phase 2 schema v4: the checkpoint of the enrichment projector (ADR 0054). Additive; changes nothing of 0001-0003.
-- projection_state holds, per Film and per Person, the change key of the last input the projector wrote to D1. It is written in
-- the same batch as the rows it describes, so it never claims a write that did not commit, and a Time Travel restore or a reload
-- brings it back together with those rows. change_key 'absent' marks an entity no R2 source lists any more.
-- projection_run is the single lease and the last run summary of one projector. projection_fence is the lease check every
-- projector batch starts with: its row count must be exactly one held lease, so a batch of a run that lost its lease fails the
-- CHECK and rolls back whole, and an older run cannot overwrite a newer one. Applying this migration to iptv is a separate owner
-- approval. R2 bucket iptv stays authoritative.

CREATE TABLE projection_state (
 projection TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('film','person')),
 id TEXT NOT NULL,
 change_key TEXT NOT NULL,
 projected_at TEXT NOT NULL,
 PRIMARY KEY (projection,kind,id)
) STRICT;

CREATE TABLE projection_run (
 projection TEXT PRIMARY KEY,
 lease_id TEXT,
 lease_until TEXT,
 started_at TEXT,
 finished_at TEXT,
 outcome TEXT,
 summary_json TEXT
) STRICT;

CREATE TABLE projection_fence (
 held INTEGER NOT NULL CHECK (held=1)
) STRICT;

UPDATE schema_contract SET version=4,note='Schema v4: enrichment projection checkpoint. R2 remains authoritative.' WHERE id=1;
