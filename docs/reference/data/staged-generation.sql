-- DESIGN PROTOTYPE. NOT A MIGRATION. NOTHING APPLIES THIS FILE TO ANY DATABASE.
-- The staged import of one programme generation, as decided in ADR 0021. tests/staged-generation.mjs executes these
-- statements on a local SQLite file on top of migrations/0001_schema_v1.sql and proves that staging in chunks and
-- committing produces exactly the rows the EPG repository's publishGeneration writes. The implementation card turns
-- the DDL into migrations/0002 and the statements into repository code; the names below are the contract.
-- Placeholders are :name tokens; the executor renders them as SQL literals.

-- name: ddl
CREATE TABLE generation_stage (
 programme_run_id TEXT PRIMARY KEY,
 baseline_sha256 TEXT NOT NULL,
 phase TEXT NOT NULL CHECK (phase IN ('published','withheld')),
 published_at TEXT,
 expected_programme_run_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('new','loading','validated','published','failed','superseded')),
 owner_token TEXT NOT NULL,
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

-- name: open_stage
-- One batch with this statement opens the stage. A stage with the same run id is never reopened; the PK refuses it.
INSERT INTO generation_stage (programme_run_id,baseline_sha256,phase,published_at,expected_programme_run_id,state,owner_token,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,created_at,updated_at)
VALUES (:run,:baseline,:phase,:published_at,:expected,'new',:owner,:chunk_count,:film_count,:film_show_count,:candidate_count,:candidate_show_count,:now,:now);

-- name: chunk_guard
-- First statement of every chunk batch. It inserts a row that violates the state CHECK, and so aborts the whole batch,
-- unless the stage exists for this owner and baseline and is still loading.
INSERT INTO generation_stage (programme_run_id,baseline_sha256,phase,owner_token,state,chunk_count,film_count,film_show_count,candidate_count,candidate_show_count,created_at,updated_at)
SELECT 'guard:'||:run,'-','published','-','refused',0,0,0,0,0,:now,:now
WHERE NOT EXISTS (SELECT 1 FROM generation_stage WHERE programme_run_id=:run AND owner_token=:owner AND baseline_sha256=:baseline AND state IN ('new','loading'));

-- name: chunk_state
UPDATE generation_stage SET state='loading',updated_at=:now WHERE programme_run_id=:run AND owner_token=:owner AND state IN ('new','loading');

-- name: chunk_receipt
-- Last statement of every chunk batch. The primary key makes it write-once: a second batch for the same chunk aborts.
INSERT INTO generation_stage_chunk (programme_run_id,chunk_index,row_count,content_sha256,received_at) VALUES (:run,:chunk,:row_count,:sha,:now);

-- name: validate
-- One statement: the stage becomes validated only when every chunk receipt is present and every staged table holds the
-- declared count. The executor then reads the staged rows back against the source projection before it commits.
UPDATE generation_stage SET state='validated',updated_at=:now
WHERE programme_run_id=:run AND owner_token=:owner AND state IN ('new','loading')
 AND (SELECT COUNT(*) FROM generation_stage_chunk WHERE programme_run_id=:run)=chunk_count
 AND (SELECT COALESCE(MIN(chunk_index),0) FROM generation_stage_chunk WHERE programme_run_id=:run)=0
 AND (SELECT COALESCE(MAX(chunk_index),-1) FROM generation_stage_chunk WHERE programme_run_id=:run)=chunk_count-1
 AND (SELECT COUNT(*) FROM stage_film_generation WHERE programme_run_id=:run)=film_count
 AND (SELECT COUNT(*) FROM stage_film_show WHERE programme_run_id=:run)=film_show_count
 AND (SELECT COUNT(*) FROM stage_candidate WHERE programme_run_id=:run)=candidate_count
 AND (SELECT COUNT(*) FROM stage_candidate_show WHERE programme_run_id=:run)=candidate_show_count;

-- name: commit_published
-- The commit point. One batch, a fixed number of set-based statements, whatever the generation size. The first statement
-- aborts the batch unless the stage is validated for this owner and the published pointer is still the expected one.
INSERT INTO programme_generation (programme_run_id,phase,published_at)
SELECT :run,'stale',NULL
WHERE NOT (
 EXISTS (SELECT 1 FROM generation_stage WHERE programme_run_id=:run AND owner_token=:owner AND state='validated' AND phase='published')
 AND ((:expected IS NULL AND NOT EXISTS (SELECT 1 FROM published_generation WHERE id=1)) OR EXISTS (SELECT 1 FROM published_generation WHERE id=1 AND programme_run_id IS :expected))
);
INSERT INTO programme_generation (programme_run_id,phase,published_at) SELECT programme_run_id,'published',published_at FROM generation_stage WHERE programme_run_id=:run;
INSERT INTO published_generation (id,programme_run_id) VALUES (1,:run) ON CONFLICT(id) DO UPDATE SET programme_run_id=excluded.programme_run_id;
INSERT INTO film_generation (programme_run_id,film_id) SELECT programme_run_id,film_id FROM stage_film_generation WHERE programme_run_id=:run;
INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason)
SELECT programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM stage_film_show WHERE programme_run_id=:run;
INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id)
SELECT film_id,MAX(start_ms),:run FROM stage_film_show WHERE programme_run_id=:run GROUP BY film_id
ON CONFLICT(film_id) DO UPDATE SET
 airing_ms=MAX(film_epg_last_airing.airing_ms,excluded.airing_ms),
 programme_run_id=CASE WHEN excluded.airing_ms>=film_epg_last_airing.airing_ms THEN excluded.programme_run_id ELSE film_epg_last_airing.programme_run_id END;
INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,last_attempt_at,retry_at,terminal_reason,evidence_key)
SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,1,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,0,NULL,NULL,NULL,evidence_key
FROM stage_candidate WHERE programme_run_id=:run
ON CONFLICT(observation_key) DO UPDATE SET
 title=excluded.title,normalized_title=excluded.normalized_title,year=excluded.year,raw_titles_json=excluded.raw_titles_json,durations_json=excluded.durations_json,description=excluded.description,first_airing_ms=excluded.first_airing_ms,last_airing_ms=excluded.last_airing_ms,airings=excluded.airings,confirmed_tmdb_id=excluded.confirmed_tmdb_id,observation_schema_version=excluded.observation_schema_version,observation_json=excluded.observation_json,activity=excluded.activity,last_seen_at=excluded.last_seen_at,last_seen_programme_run_id=excluded.last_seen_programme_run_id,seen_in_latest=excluded.seen_in_latest,evidence_key=excluded.evidence_key,
 terminal_reason=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.terminal_reason ELSE NULL END,
 retry_at=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.retry_at ELSE NULL END,
 attempts=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.attempts ELSE 0 END,
 last_attempt_at=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.last_attempt_at ELSE NULL END;
INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key)
SELECT programme_run_id,observation_key,1,observation_json,evidence_key FROM stage_candidate WHERE programme_run_id=:run;
INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title)
SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM stage_candidate_show WHERE programme_run_id=:run;
UPDATE candidate SET seen_in_latest=0,activity=CASE WHEN activity='current' THEN 'historical' ELSE activity END
WHERE NOT EXISTS (SELECT 1 FROM stage_candidate s WHERE s.programme_run_id=:run AND s.observation_key=candidate.observation_key);
UPDATE generation_stage SET state='published',updated_at=:now WHERE programme_run_id=:run;
UPDATE generation_stage SET state='superseded',updated_at=:now WHERE state='published' AND programme_run_id<>:run;

-- name: commit_withheld
-- A withheld generation is recorded but never pointed to; new candidates are inserted as not current, existing ones are untouched.
INSERT INTO programme_generation (programme_run_id,phase,published_at)
SELECT :run,'stale',NULL
WHERE NOT EXISTS (SELECT 1 FROM generation_stage WHERE programme_run_id=:run AND owner_token=:owner AND state='validated' AND phase='withheld');
INSERT INTO programme_generation (programme_run_id,phase,published_at) SELECT programme_run_id,'withheld',published_at FROM generation_stage WHERE programme_run_id=:run;
INSERT INTO film_generation (programme_run_id,film_id) SELECT programme_run_id,film_id FROM stage_film_generation WHERE programme_run_id=:run;
INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason)
SELECT programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM stage_film_show WHERE programme_run_id=:run;
INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,evidence_key)
SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,1,observation_json,CASE WHEN activity='current' THEN 'historical' ELSE activity END,last_seen_at,last_seen_programme_run_id,0,0,evidence_key
FROM stage_candidate WHERE programme_run_id=:run
ON CONFLICT(observation_key) DO NOTHING;
INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key)
SELECT programme_run_id,observation_key,1,observation_json,evidence_key FROM stage_candidate WHERE programme_run_id=:run;
INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title)
SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM stage_candidate_show WHERE programme_run_id=:run;
UPDATE generation_stage SET state='published',updated_at=:now WHERE programme_run_id=:run;

-- name: fail_stage
UPDATE generation_stage SET state='failed',failure_reason=:reason,updated_at=:now WHERE programme_run_id=:run AND owner_token=:owner AND state IN ('new','loading','validated');

-- name: discard_stage
-- Owner-approved cleanup of a failed or superseded stage. It touches staging tables only and deletes at most :limit rows
-- per table per batch, children before parents; the executor repeats the batch until nothing is left. A failed stage
-- loses its stage row too, so the same programme run can be staged again from a fresh baseline; a superseded stage keeps
-- its stage row as the record of the commit. The executor's run report keeps the chunk receipts it removed.
DELETE FROM stage_candidate_show WHERE rowid IN (SELECT rowid FROM stage_candidate_show WHERE programme_run_id=:run LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded');
DELETE FROM stage_candidate WHERE rowid IN (SELECT rowid FROM stage_candidate c WHERE programme_run_id=:run
 AND NOT EXISTS (SELECT 1 FROM stage_candidate_show s WHERE s.programme_run_id=c.programme_run_id AND s.observation_key=c.observation_key) LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded');
DELETE FROM stage_film_show WHERE rowid IN (SELECT rowid FROM stage_film_show WHERE programme_run_id=:run LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded');
DELETE FROM stage_film_generation WHERE rowid IN (SELECT rowid FROM stage_film_generation f WHERE programme_run_id=:run
 AND NOT EXISTS (SELECT 1 FROM stage_film_show s WHERE s.programme_run_id=f.programme_run_id AND s.film_id=f.film_id) LIMIT :limit)
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded');
DELETE FROM generation_stage_chunk WHERE programme_run_id=:run
 AND (SELECT state FROM generation_stage WHERE programme_run_id=:run) IN ('failed','superseded')
 AND NOT EXISTS (SELECT 1 FROM stage_film_generation WHERE programme_run_id=:run)
 AND NOT EXISTS (SELECT 1 FROM stage_candidate WHERE programme_run_id=:run);
DELETE FROM generation_stage WHERE programme_run_id=:run AND state='failed'
 AND NOT EXISTS (SELECT 1 FROM generation_stage_chunk WHERE programme_run_id=:run);
