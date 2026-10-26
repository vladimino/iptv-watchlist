-- AIR-168 schema v2: staging tables for the staged import of a large programme generation (ADR-0021).
-- Additive only: no table, view or row of 0001 changes, and no read path reads these tables.
-- Not bound to Worker iptv and not applied to any database by this repository; applying it to the scratch or the target
-- database is a separate owner approval. R2 bucket iptv stays authoritative.
-- Every access is by programme_run_id, the leading column of each primary key, so no further index is needed.
-- Stage foreign keys make chunks load in order: a child row whose parent chunk is missing aborts its whole chunk.
-- One execution at a time holds a stage: claim_nonce is that execution's random nonce and claim_generation a fencing counter
-- raised by every claim. Each stage write names both, so a replaced claimant can no longer write; claim_expires_at only decides
-- when another execution may take an abandoned claim over.

CREATE TABLE generation_stage (
 programme_run_id TEXT PRIMARY KEY,
 baseline_sha256 TEXT NOT NULL,
 phase TEXT NOT NULL CHECK (phase IN ('published','withheld')),
 published_at TEXT,
 expected_programme_run_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('new','loading','validated','published','failed','superseded')),
 owner_token TEXT NOT NULL,
 claim_nonce TEXT,
 claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation>=0),
 claim_expires_at TEXT,
 chunk_count INTEGER NOT NULL CHECK (chunk_count>=0),
 film_count INTEGER NOT NULL,
 film_show_count INTEGER NOT NULL,
 candidate_count INTEGER NOT NULL,
 candidate_show_count INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 failure_reason TEXT
) STRICT;
CREATE TABLE generation_stage_chunk (
 programme_run_id TEXT NOT NULL REFERENCES generation_stage(programme_run_id),
 chunk_index INTEGER NOT NULL CHECK (chunk_index>=0),
 row_count INTEGER NOT NULL,
 content_sha256 TEXT NOT NULL,
 received_at TEXT NOT NULL,
 PRIMARY KEY (programme_run_id,chunk_index)
) STRICT;
CREATE TABLE stage_film_generation (
 programme_run_id TEXT NOT NULL REFERENCES generation_stage(programme_run_id),
 film_id TEXT NOT NULL REFERENCES film(id),
 chunk_index INTEGER NOT NULL,
 PRIMARY KEY (programme_run_id,film_id)
) STRICT;
CREATE TABLE stage_film_show (
 programme_run_id TEXT NOT NULL,
 film_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 basis TEXT,
 match_reason TEXT,
 chunk_index INTEGER NOT NULL,
 PRIMARY KEY (programme_run_id,film_id,channel_id,start_ms),
 FOREIGN KEY (programme_run_id,film_id) REFERENCES stage_film_generation(programme_run_id,film_id)
) STRICT;
CREATE TABLE stage_candidate (
 programme_run_id TEXT NOT NULL REFERENCES generation_stage(programme_run_id),
 observation_key TEXT NOT NULL CHECK (observation_key NOT LIKE 'film:%' AND observation_key NOT LIKE 'person:%'),
 title TEXT NOT NULL,
 normalized_title TEXT NOT NULL,
 year INTEGER,
 raw_titles_json TEXT NOT NULL,
 durations_json TEXT NOT NULL,
 description TEXT,
 first_airing_ms INTEGER,
 last_airing_ms INTEGER,
 airings INTEGER,
 confirmed_tmdb_id TEXT,
 observation_json TEXT NOT NULL,
 activity TEXT,
 last_seen_at TEXT,
 last_seen_programme_run_id TEXT,
 seen_in_latest INTEGER NOT NULL CHECK (seen_in_latest IN (0,1)),
 evidence_key TEXT NOT NULL,
 chunk_index INTEGER NOT NULL,
 PRIMARY KEY (programme_run_id,observation_key)
) STRICT;
CREATE TABLE stage_candidate_show (
 programme_run_id TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 chunk_index INTEGER NOT NULL,
 PRIMARY KEY (programme_run_id,observation_key,channel_id,start_ms),
 FOREIGN KEY (programme_run_id,observation_key) REFERENCES stage_candidate(programme_run_id,observation_key)
) STRICT;

UPDATE schema_contract SET version=2,note='Schema v2: staging tables for staged generation import. Not applied to production. R2 remains authoritative.' WHERE id=1 AND version=1;
