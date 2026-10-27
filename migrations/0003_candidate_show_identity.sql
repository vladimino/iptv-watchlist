-- AIR-177 schema v3: a candidate show is identified by the whole EPG entry (ADR-0025).
-- The EPG can list two entries for one channel slot with different titles; schema v1 and v2 keyed a candidate show by channel
-- and start only and refused the second one, which stopped the whole generation unit. The final and the staging table are
-- rebuilt with the same columns, no narrow primary key, and a unique identity over channel, start, end and EPG title.
-- In the identity a missing end becomes -1 ms and a missing title the NUL character, values no real entry has, so an entry
-- without one is still unique and an exact repeat is still refused. Writers deduplicate exact repeats before they insert.
-- No other table references either table. Not bound to Worker iptv and not applied to any database by this repository;
-- applying it is a separate owner approval. R2 bucket iptv stays authoritative.

CREATE TABLE candidate_show_v3 (
 programme_run_id TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 FOREIGN KEY (programme_run_id,observation_key) REFERENCES candidate_generation(programme_run_id,observation_key)
) STRICT;
INSERT INTO candidate_show_v3 (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title)
 SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM candidate_show;
DROP TABLE candidate_show;
ALTER TABLE candidate_show_v3 RENAME TO candidate_show;
CREATE UNIQUE INDEX candidate_show_identity ON candidate_show (programme_run_id,observation_key,channel_id,start_ms,IFNULL(end_ms,-1),IFNULL(epg_title,char(0)));

CREATE TABLE stage_candidate_show_v3 (
 programme_run_id TEXT NOT NULL,
 observation_key TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 channel TEXT,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER,
 epg_title TEXT,
 chunk_index INTEGER NOT NULL,
 FOREIGN KEY (programme_run_id,observation_key) REFERENCES stage_candidate(programme_run_id,observation_key)
) STRICT;
INSERT INTO stage_candidate_show_v3 (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title,chunk_index)
 SELECT programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title,chunk_index FROM stage_candidate_show;
DROP TABLE stage_candidate_show;
ALTER TABLE stage_candidate_show_v3 RENAME TO stage_candidate_show;
CREATE UNIQUE INDEX stage_candidate_show_identity ON stage_candidate_show (programme_run_id,observation_key,channel_id,start_ms,IFNULL(end_ms,-1),IFNULL(epg_title,char(0)));

UPDATE schema_contract SET version=3,note='Schema v3: candidate shows identified by channel, start, end and EPG title. Not applied to production. R2 remains authoritative.' WHERE id=1 AND version=2;
