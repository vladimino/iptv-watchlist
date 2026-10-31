-- Schema v5: the metadataSync freshness clocks that film_metadata does not store (ADR 0070).
-- Additive. Changes nothing of 0001-0004. Not applied to production by this file.
-- metadata.json stays authoritative. metadataSync does not read this table.
-- For a Film row that exists, a missing sync row means metadata.json has no entry for that Film.
-- A row with a NULL clock means the entry exists and that clock is absent. A metadata.json key with no
-- Film row is not stored and does not create a Film. Leaving the view does not delete the sync row.
-- people_version stays on film_metadata. The 30-day window is not stored.
-- Applying this migration to iptv is a separate owner approval. R2 bucket iptv stays authoritative.

CREATE TABLE film_sync_state (
 film_id TEXT PRIMARY KEY REFERENCES film(id),
 metadata_at TEXT,
 synopsis_fetched_at TEXT,
 people_names_version INTEGER,
 people_localized_at TEXT
) STRICT;

UPDATE schema_contract SET version=5,note='Schema v5: metadataSync freshness clocks. R2 remains authoritative.' WHERE id=1;
