INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:zz-film',1,'tmdb:9001','Original Title','2026-10-19T01:00:00.000Z'),
 ('film:zz-empty',1,NULL,'Empty Title','2026-10-19T01:00:00.000Z');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:zz-film','letterboxd','zz-film',1,0,NULL),
 ('film:zz-film','tmdb','9001',1,0,NULL);
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES
 ('person:actor/zz-role','actor/zz-role',1,'2026-10-19T01:00:00.000Z');
INSERT INTO film_redirect (from_id,to_film_id,at) VALUES
 ('film:tmdb:9001','film:zz-film','2026-10-19T01:00:00.000Z');
INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES
 ('film:zz-film','title','Visible Title','{"source":"epg"}');
INSERT INTO film_dimension (film_id,dimension,status,value,authority,next_action,updated_at) VALUES
 ('film:zz-film','localization','reviewed','Reviewed Title','owner','keep_reviewed','2026-10-19T01:00:00.000Z');
INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:zz-film','2026-10-19T01:00:00.000Z');

INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES
 ('run-published','published','2026-10-19T01:00:00.000Z'),
 ('run-withheld','withheld',NULL);
INSERT INTO film_generation (programme_run_id,film_id) VALUES
 ('run-published','film:zz-film'),
 ('run-published','film:zz-empty'),
 ('run-withheld','film:zz-film');
INSERT INTO film_show (programme_run_id,film_id,channel_id,start_ms,end_ms) VALUES
 ('run-published','film:zz-film','channel-a',1000,2000),
 ('run-withheld','film:zz-film','channel-a',3000,4000);
INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES
 ('film:zz-empty',500,'run-published');

INSERT INTO candidate (observation_key,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,retry_at,terminal_reason,evidence_key) VALUES
 ('heat|1995','current','2026-10-19T01:00:00.000Z','run-published',1,2,'2026-10-20T01:00:00.000Z',NULL,'evidence-a');
INSERT INTO candidate_generation (programme_run_id,observation_key) VALUES ('run-published','heat|1995');

INSERT INTO score_result (id,observation_key,programme_run_id,scorer_version,status,reason,confidence,score,accepted_tmdb_id,gate_outcome,gate_reason,created_at) VALUES
 ('score-1','heat|1995','run-published','1','accepted','accepted',0.9,0.9,'9001','needs_verification','needs_verification','2026-10-19T01:00:00.000Z');
INSERT INTO score_considered (score_id,ordinal,tmdb_id,trusted,year,runtime) VALUES
 ('score-1',1,'9001',0,1995,100);
INSERT INTO score_detail (score_id,movie_id,runtime,release_year,matched_title,fetched_at,r2_key,content_sha256) VALUES
 ('score-1','9001',100,1995,'Original Title','2026-10-19T01:00:00.000Z','archive/tmdb/9001','abc123');

INSERT INTO fingerprint_payload (film_id,schema_version,fingerprint_hash,generated_at,r2_key,content_sha256) VALUES
 ('film:zz-film',1,'print-a','2026-10-19T01:00:00.000Z','enrichment/films/zz-film/fingerprint.json','hash-print');
INSERT INTO profile_version (version,profile_hash,created_at,r2_key,content_sha256) VALUES
 (1,'profile-a','2026-10-19T01:00:00.000Z','enrichment/profile/current.json','hash-profile');
INSERT INTO prediction_current (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at) VALUES
 ('film:zz-film',1,'profile-a','print-a',1,1,4,'enrichment/films/zz-film/predictions.json','hash-prediction','2026-10-19T01:00:00.000Z');
INSERT INTO prediction_history (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash) VALUES
 ('film:zz-film','2026-10-01T00:00:00.000Z',3,1,'print-old');
INSERT INTO actual_rating (film_id,rating,source,recorded_at) VALUES
 ('film:zz-film',4.5,'letterboxd','2026-10-19T01:00:00.000Z');

INSERT INTO identity_rule_version (rule_id,version,confidence,predicates_json,created_at) VALUES
 ('rule-1',1,'trusted','[]','2026-10-19T01:00:00.000Z');
INSERT INTO identity_assertion (id,observation_key,programme_run_id,film_id,tmdb_id,authority,created_at) VALUES
 ('assertion-1','heat|1995','run-published','film:zz-film','9001','owner','2026-10-19T01:00:00.000Z');
INSERT INTO identity_application (id,observation_key,programme_run_id,assertion_id,rule_id,rule_version,created_at) VALUES
 ('application-1','heat|1995','run-published','assertion-1','rule-1',1,'2026-10-19T01:00:00.000Z');
INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES
 ('programme.json','sha-programme','film_generation','run-published/film:zz-film','2026-10-19T01:00:00.000Z');
