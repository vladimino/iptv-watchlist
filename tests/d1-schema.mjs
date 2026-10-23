import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const migration=fs.readFileSync('migrations/0001_schema_v1.sql','utf8');
const fixture=fs.readFileSync('tests/fixtures/d1-schema-v1.sql','utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-'));
const database=path.join(root,'schema.sqlite');

function run(sql){
 const result=spawnSync('sqlite3',['-bail',database],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});
 return result;
}
function query(sql){
 const result=run(sql);
 assert.equal(result.status,0,result.stderr);
 return result.stdout.trim();
}
function refuse(sql){
 const result=run(sql);
 assert.notEqual(result.status,0);
 assert.equal(result.stdout.includes('Visible Title'),false);
}

const created=run(migration+'\n'+fixture);
assert.equal(created.status,0,created.stderr);
assert.equal(query('SELECT version FROM schema_contract'),'1');
assert.equal(query("SELECT to_film_id FROM film_redirect WHERE from_id='film:tmdb:9001'"),'film:zz-film');
assert.equal(query("SELECT COUNT(*) FROM film_show WHERE programme_run_id='run-published' AND film_id='film:zz-empty'"),'0');
assert.equal(query("SELECT COUNT(*) FROM film_generation WHERE programme_run_id='run-published' AND film_id='film:zz-empty'"),'1');
assert.equal(query('SELECT COUNT(*) FROM published_film_show'),'2');
assert.equal(query("SELECT DISTINCT film_id FROM published_film_show"),'film:zz-film');
assert.equal(query("SELECT basis||'|'||IFNULL(match_reason,'') FROM published_film_show ORDER BY start_ms"),'title_duration|duration_conflict\ntitle_year|');
assert.equal(query("SELECT channel||'|'||epg_title FROM candidate_show WHERE observation_key='heat|1995'"),'Channel A|Title ZZ');
assert.equal(query("SELECT COUNT(*) FROM film WHERE canonical_identity='tmdb:9001'"),'1');
assert.equal(query('SELECT COUNT(*) FROM prediction_history'),'1');
assert.equal(query("SELECT airing_ms FROM film_epg_last_airing WHERE film_id='film:zz-empty'"),'500');
assert.equal(query("SELECT source||'|'||authority||'|'||reason||'|'||provenance_json FROM localization_conflict WHERE id='conflict-1'"),'dictionary|owner|owner_kept|{"sources":["dictionary"]}');
assert.equal(query("SELECT status||'|'||film_id||'|'||tmdb_id||'|'||identity_source FROM candidate_decision WHERE observation_key='alias|1990'"),'verified|film:zz-film|9001|known_epg_alias');
assert.equal(query("SELECT status FROM candidate_decision_history WHERE observation_key='alias|1990'"),'ambiguous');
assert.equal(query("SELECT status||'|'||terminal_reason||'|'||IFNULL(film_id,'') FROM candidate_decision WHERE observation_key='remake|1991'"),'ambiguous|repeated_uncertain_match|');
assert.equal(query("SELECT COUNT(*) FROM score_result WHERE observation_key IN ('alias|1990','remake|1991')"),'0');
const priorPrediction=JSON.parse(query("SELECT payload_json FROM prediction_history WHERE film_id='film:zz-film'"));
assert.equal(priorPrediction.predictedRating,3);
assert.equal(priorPrediction.probability4Plus,0.4);
assert.equal(priorPrediction.mainRisk,'risk-a');
assert.equal(query("SELECT r2_key||'|'||content_sha256 FROM prediction_history WHERE film_id='film:zz-film'"),'enrichment/films/zz-film/predictions/2026-10-01T00:00:00.000Z.json|hash-prediction-old');
assert.equal(query("SELECT r2_key FROM prediction_current WHERE film_id='film:zz-film'").endsWith('/predictions.json'),false);
const observation=query("SELECT observation_json FROM candidate WHERE observation_key='heat|1995'");
assert.equal(JSON.parse(observation).schemaVersion,1);
assert.deepEqual(JSON.parse(observation).durations,[170]);
assert.equal(query("SELECT observation_json FROM candidate_generation WHERE programme_run_id='run-published' AND observation_key='heat|1995'"),observation);
assert.equal(query("SELECT normalized_title||'|'||year||'|'||durations_json||'|'||confirmed_tmdb_id FROM candidate WHERE observation_key='heat|1995'"),'heat|1995|[170]|9001');
assert.equal(query("SELECT person_id FROM film_person_credit WHERE film_id='film:zz-film' AND role='director' ORDER BY ordinal"),'person:director/zz-role');
assert.equal(query("SELECT person_id FROM film_person_credit WHERE film_id='film:zz-film' AND role='actor' ORDER BY ordinal"),'person:actor/zz-role\nperson:actor/zz-cast');
const filmMetadata=JSON.parse(query("SELECT payload_json FROM film_metadata WHERE film_id='film:zz-film'"));
assert.equal(filmMetadata.schemaVersion,1);
assert.equal(filmMetadata.year,1995);
assert.equal(filmMetadata.runtime,170);
assert.deepEqual(filmMetadata.genres,['Genre ZZ']);
assert.equal(filmMetadata.synopsis,'A synopsis');
assert.equal(filmMetadata.poster,'https://images.invalid/zz-film.jpg');
assert.equal(filmMetadata.url,'https://catalog.invalid/film/zz-film');
assert.equal(filmMetadata.peopleVersion,1);
assert.equal(query("SELECT year||'|'||runtime||'|'||synopsis||'|'||poster||'|'||url FROM film_metadata WHERE film_id='film:zz-film'"),'1995|170|A synopsis|https://images.invalid/zz-film.jpg|https://catalog.invalid/film/zz-film');

refuse("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:zz-empty','tmdb','9001',1,0)");
refuse("INSERT INTO candidate (observation_key,seen_in_latest) VALUES ('film:zz-film',1)");
refuse("INSERT INTO film (id,contract_version,updated_at) VALUES ('heat|1995',1,'2026-10-19T01:00:00.000Z')");
refuse("INSERT INTO film_show (programme_run_id,film_id,channel_id,start_ms) VALUES ('run-withheld','film:zz-empty','channel-b',9000)");
refuse("INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('programme.json','sha-programme','film_generation','run-published/film:zz-film','2026-10-19T02:00:00.000Z')");

assert.equal(query('SELECT COUNT(*) FROM film'),'2');
assert.equal(query("SELECT gate_outcome FROM score_result WHERE accepted_tmdb_id='9001'"),'needs_verification');
refuse("INSERT INTO published_generation (id,programme_run_id) VALUES (2,'run-published')");
refuse("INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:zz-film','person:director/zz-role','actor',0)");
const laterObservation='{"schemaVersion":1,"title":"Title ZZ Late","normalizedTitle":"heat","year":1995,"rawTitles":["Title ZZ","Title ZZ Late"],"durations":[180],"description":"A description","firstAiring":1000,"lastAiring":8000,"airings":3,"confirmedTmdbId":null}';
const moved=run(`
INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES ('run-next','published','2026-10-20T01:00:00.000Z');
INSERT INTO film_generation (programme_run_id,film_id) VALUES ('run-next','film:zz-film'),('run-next','film:zz-empty');
INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason) VALUES ('run-next','film:zz-film','channel-b','Channel B',8000,9000,'Visible Title','title_unique',NULL);
UPDATE candidate SET title='Title ZZ Late',raw_titles_json='["Title ZZ","Title ZZ Late"]',durations_json='[180]',last_airing_ms=8000,airings=3,confirmed_tmdb_id=NULL,evidence_key='evidence-b',observation_json='${laterObservation}' WHERE observation_key='heat|1995';
INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key) VALUES ('run-next','heat|1995',1,'${laterObservation}','evidence-b');
INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title) VALUES ('run-next','heat|1995','channel-b','Channel B',8000,9000,'Title ZZ Late');
UPDATE published_generation SET programme_run_id='run-next' WHERE id=1;
`);
assert.equal(moved.status,0,moved.stderr);
assert.equal(query("SELECT programme_run_id FROM published_generation"),'run-next');
assert.equal(query("SELECT DISTINCT programme_run_id FROM published_film_show"),'run-next');
assert.equal(query("SELECT COUNT(*) FROM film_show WHERE programme_run_id='run-published'"),'2');
assert.equal(query("SELECT phase FROM programme_generation WHERE programme_run_id='run-published'"),'published');
assert.equal(query("SELECT COUNT(*) FROM film_generation WHERE programme_run_id='run-next' AND film_id='film:zz-empty'"),'1');
assert.equal(query("SELECT COUNT(*) FROM published_film_show WHERE film_id='film:zz-empty'"),'0');
assert.equal(query("SELECT observation_json FROM candidate WHERE observation_key='heat|1995'"),laterObservation);
assert.equal(query("SELECT observation_json FROM candidate_generation WHERE programme_run_id='run-published' AND observation_key='heat|1995'"),observation);
assert.equal(query("SELECT observation_json FROM candidate_generation WHERE programme_run_id='run-next' AND observation_key='heat|1995'"),laterObservation);
assert.deepEqual(JSON.parse(observation).durations,[170]);
assert.deepEqual(JSON.parse(observation).rawTitles,['Title ZZ']);
assert.equal(JSON.parse(observation).confirmedTmdbId,'9001');
assert.deepEqual(JSON.parse(laterObservation).durations,[180]);
assert.deepEqual(JSON.parse(laterObservation).rawTitles,['Title ZZ','Title ZZ Late']);
assert.equal(JSON.parse(laterObservation).confirmedTmdbId,null);
assert.equal(query("SELECT evidence_key FROM candidate_generation WHERE programme_run_id='run-published' AND observation_key='heat|1995'"),'evidence-a');
assert.equal(query("SELECT evidence_key FROM candidate_generation WHERE programme_run_id='run-next' AND observation_key='heat|1995'"),'evidence-b');
assert.equal(query("SELECT programme_run_id FROM score_result WHERE observation_key='heat|1995'"),'run-published');
assert.equal(query("SELECT epg_title FROM candidate_show WHERE observation_key='heat|1995' AND programme_run_id='run-published'"),'Title ZZ');
assert.equal(query("SELECT epg_title FROM candidate_show WHERE observation_key='heat|1995' AND programme_run_id='run-next'"),'Title ZZ Late');
assert.equal(query('SELECT COUNT(*) FROM film'),'2');
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/d1_databases/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/0001_schema_v1|schema_contract|d1_databases/,file);
fs.rmSync(root,{recursive:true});
console.log('D1 schema v1 passed.');
