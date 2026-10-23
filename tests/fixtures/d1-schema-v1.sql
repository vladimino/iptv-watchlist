INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:zz-film',1,'tmdb:9001','Original Title','2026-10-19T01:00:00.000Z'),
 ('film:zz-empty',1,NULL,'Empty Title','2026-10-19T01:00:00.000Z');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:zz-film','letterboxd','zz-film',1,0,NULL),
 ('film:zz-film','tmdb','9001',1,0,NULL);
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES
 ('person:actor/zz-role','actor/zz-role',1,'2026-10-19T01:00:00.000Z'),
 ('person:actor/zz-cast','actor/zz-cast',1,'2026-10-19T01:00:00.000Z'),
 ('person:director/zz-role','director/zz-role',1,'2026-10-19T01:00:00.000Z');
INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,updated_at) VALUES
 ('film:zz-film',1,1995,170,'A synopsis','https://images.invalid/zz-film.jpg','https://catalog.invalid/film/zz-film','["Genre ZZ"]',1,'{"schemaVersion":1,"year":1995,"runtime":170,"genres":["Genre ZZ"],"synopsis":"A synopsis","poster":"https://images.invalid/zz-film.jpg","url":"https://catalog.invalid/film/zz-film","peopleVersion":1}','2026-10-19T01:00:00.000Z');
INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES
 ('film:zz-film','person:director/zz-role','director',0),
 ('film:zz-film','person:actor/zz-role','actor',0),
 ('film:zz-film','person:actor/zz-cast','actor',1);
INSERT INTO film_redirect (from_id,to_film_id,at) VALUES
 ('film:tmdb:9001','film:zz-film','2026-10-19T01:00:00.000Z');
INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES
 ('film:zz-film','title','Visible Title','{"source":"epg"}');
INSERT INTO film_dimension (film_id,dimension,status,value,authority,next_action,updated_at) VALUES
 ('film:zz-film','localization','reviewed','Reviewed Title','owner','keep_reviewed','2026-10-19T01:00:00.000Z');
INSERT INTO localization_conflict (id,entity_kind,entity_id,value,source,provenance_json,authority,reason,at) VALUES
 ('conflict-1','film','film:zz-film','Dictionary Title','dictionary','{"sources":["dictionary"]}','owner','owner_kept','2026-10-19T01:00:00.000Z');
INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:zz-film','2026-10-19T01:00:00.000Z');

INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES
 ('run-published','published','2026-10-19T01:00:00.000Z'),
 ('run-withheld','withheld',NULL);
INSERT INTO published_generation (id,programme_run_id) VALUES (1,'run-published');
INSERT INTO film_generation (programme_run_id,film_id) VALUES
 ('run-published','film:zz-film'),
 ('run-published','film:zz-empty'),
 ('run-withheld','film:zz-film');
INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason) VALUES
 ('run-published','film:zz-film','channel-a','Channel A',1000,2000,'Visible Title','title_duration','duration_conflict'),
 ('run-published','film:zz-film','channel-a','Channel A',1500,2500,'Visible Title','title_year',NULL),
 ('run-withheld','film:zz-film','channel-a','Channel A',3000,4000,'Visible Title','title_duration','duration_conflict');
INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES
 ('film:zz-empty',500,'run-published');

INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,retry_at,terminal_reason,evidence_key) VALUES
 ('heat|1995','Title ZZ','heat',1995,'["Title ZZ"]','[170]','A description',1000,2000,2,'9001',1,'{"schemaVersion":1,"title":"Title ZZ","normalizedTitle":"heat","year":1995,"rawTitles":["Title ZZ"],"durations":[170],"description":"A description","firstAiring":1000,"lastAiring":2000,"airings":2,"confirmedTmdbId":"9001"}','current','2026-10-19T01:00:00.000Z','run-published',1,2,'2026-10-20T01:00:00.000Z',NULL,'evidence-a'),
 ('alias|1990','Alias ZZ','alias',1990,'["Alias ZZ"]','[100]',NULL,1000,1000,1,NULL,1,'{"schemaVersion":1,"title":"Alias ZZ","normalizedTitle":"alias","year":1990,"rawTitles":["Alias ZZ"],"durations":[100],"description":null,"firstAiring":1000,"lastAiring":1000,"airings":1,"confirmedTmdbId":null}','current','2026-10-19T01:00:00.000Z','run-published',1,1,NULL,NULL,'evidence-alias'),
 ('remake|1991','Remake ZZ','remake',1991,'["Remake ZZ"]','[90]',NULL,1000,1000,1,NULL,1,'{"schemaVersion":1,"title":"Remake ZZ","normalizedTitle":"remake","year":1991,"rawTitles":["Remake ZZ"],"durations":[90],"description":null,"firstAiring":1000,"lastAiring":1000,"airings":1,"confirmedTmdbId":null}','historical','2026-10-19T01:00:00.000Z','run-published',0,5,NULL,'repeated_uncertain_match','evidence-remake');
INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key) VALUES
 ('run-published','heat|1995',1,'{"schemaVersion":1,"title":"Title ZZ","normalizedTitle":"heat","year":1995,"rawTitles":["Title ZZ"],"durations":[170],"description":"A description","firstAiring":1000,"lastAiring":2000,"airings":2,"confirmedTmdbId":"9001"}','evidence-a'),
 ('run-published','alias|1990',1,'{"schemaVersion":1,"title":"Alias ZZ","normalizedTitle":"alias","year":1990,"rawTitles":["Alias ZZ"],"durations":[100],"description":null,"firstAiring":1000,"lastAiring":1000,"airings":1,"confirmedTmdbId":null}','evidence-alias'),
 ('run-published','remake|1991',1,'{"schemaVersion":1,"title":"Remake ZZ","normalizedTitle":"remake","year":1991,"rawTitles":["Remake ZZ"],"durations":[90],"description":null,"firstAiring":1000,"lastAiring":1000,"airings":1,"confirmedTmdbId":null}','evidence-remake');
INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title) VALUES
 ('run-published','heat|1995','channel-a','Channel A',1000,2000,'Title ZZ');
INSERT INTO candidate_decision (observation_key,status,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,checked_at,evidence_key,attempts,provenance_json) VALUES
 ('alias|1990','verified','tmdb_9001','film:zz-film','9001','tmdb:9001','known_epg_alias','2026-10-19T02:00:00.000Z','evidence-alias',1,'{"authority":"known_epg_alias"}');
INSERT INTO candidate_decision_history (observation_key,checked_at,status,evidence_key,attempts,provenance_json,replaced_at) VALUES
 ('alias|1990','2026-10-18T01:00:00.000Z','ambiguous','evidence-alias',1,'{"reason":"ambiguous"}','2026-10-19T02:00:00.000Z');
INSERT INTO candidate_decision (observation_key,status,reason,checked_at,evidence_key,attempts,terminal_reason,provenance_json) VALUES
 ('remake|1991','ambiguous','ambiguous','2026-10-19T01:00:00.000Z','evidence-remake',5,'repeated_uncertain_match','{"reason":"ambiguous"}');

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
 ('film:zz-film',1,'profile-a','print-a',1,1,4,'enrichment/films/zz-film/predictions/2026-10-19T01:00:00.000Z.json','hash-prediction','2026-10-19T01:00:00.000Z');
INSERT INTO prediction_history (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,payload_json,r2_key,content_sha256,source) VALUES
 ('film:zz-film','2026-10-01T00:00:00.000Z',3,1,'print-old','{"filmId":"zz-film","predictedRating":3,"probability4Plus":0.4,"confidence":0.5,"matchSignals":["signal-a"],"mainRisk":"risk-a","moodLabels":["label-a"],"generatedAt":"2026-09-01T00:00:00.000Z","tasteProfileVersion":1,"tasteProfileHash":"profile-a","fingerprintHash":"print-old","fingerprintSchemaVersion":1,"predictionPromptVersion":1,"replacedAt":"2026-10-01T00:00:00.000Z"}','enrichment/films/zz-film/predictions/2026-10-01T00:00:00.000Z.json','hash-prediction-old','prediction');
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
