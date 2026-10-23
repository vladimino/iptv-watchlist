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
assert.equal(query('SELECT COUNT(*) FROM published_film_show'),'1');
assert.equal(query("SELECT film_id FROM published_film_show"),'film:zz-film');
assert.equal(query("SELECT COUNT(*) FROM film WHERE canonical_identity='tmdb:9001'"),'1');
assert.equal(query('SELECT COUNT(*) FROM prediction_history'),'1');
assert.equal(query("SELECT airing_ms FROM film_epg_last_airing WHERE film_id='film:zz-empty'"),'500');

refuse("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:zz-empty','tmdb','9001',1,0)");
refuse("INSERT INTO candidate (observation_key,seen_in_latest) VALUES ('film:zz-film',1)");
refuse("INSERT INTO film (id,contract_version,updated_at) VALUES ('heat|1995',1,'2026-10-19T01:00:00.000Z')");
refuse("INSERT INTO film_show (programme_run_id,film_id,channel_id,start_ms) VALUES ('run-withheld','film:zz-empty','channel-b',9000)");
refuse("INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('programme.json','sha-programme','film_generation','run-published/film:zz-film','2026-10-19T02:00:00.000Z')");

assert.equal(query('SELECT COUNT(*) FROM film'),'2');
assert.equal(query("SELECT gate_outcome FROM score_result WHERE accepted_tmdb_id='9001'"),'needs_verification');
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/d1_databases/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/0001_schema_v1|schema_contract|d1_databases/,file);
fs.rmSync(root,{recursive:true});
console.log('D1 schema v1 passed.');
