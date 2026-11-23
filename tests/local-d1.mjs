// AIR-576: the local D1 of `npm run dev` (scripts/local-d1.mjs) on the real migration chain over the sqlite3-CLI D1 stand-in. The real Miniflare D1 and R2 of a booted
// dev server are covered end to end by tests/local-dev-smoke.mjs; this file covers the statement splitter against sqlite3's own reading of every migration, the
// guarded marker transitions, the synthetic rows, the readiness check that decides whether a store is reused, and the operator input of a snapshot store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {loadLocalCatalog} from '../scripts/local-fixtures.mjs';
import {importFixtures} from '../scripts/local-store.mjs';
import {applyMigrations,fixtureRows,installLocalD1,LocalD1Error,migrationFiles,migrationsIdentity,operatorRowsIdentity,readLocalD1Ready,readOperatorRows,splitStatements,startedRowsFromBucket} from '../scripts/local-d1.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-local-d1-'));
const sqlite=(file,text,json=false)=>{const result=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<26});if(result.status!==0)throw new Error(result.stderr);return result.stdout;};
const rows=(file,text)=>{const out=sqlite(file,text,true).trim();return out?JSON.parse(out):[];};
let counter=0;
const fresh=()=>path.join(root,'d1-'+(counter++)+'.sqlite');
try{
 const files=await migrationFiles();

 // 1. The splitter: unit cases, then parity with sqlite3 reading each file whole.
 assert.deepEqual(splitStatements('-- a comment;\nCREATE TABLE a (x INTEGER);\n\nINSERT INTO a VALUES (1); -- trailing\n'),['CREATE TABLE a (x INTEGER)','INSERT INTO a VALUES (1)']);
 assert.deepEqual(splitStatements("CREATE TABLE a (x TEXT);\nCREATE TRIGGER t BEFORE INSERT ON a\nFOR EACH ROW\nBEGIN\n SELECT CASE WHEN NEW.x = 'END;' THEN RAISE(ABORT, 'no') END;\n SELECT 1;\nEND;\nCREATE TABLE b (y TEXT);\n").length,3,'a trigger body keeps its semicolons, CASE ... END included');
 assert.deepEqual(splitStatements("CREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT RAISE(ABORT, 'x'); END;\nCREATE TABLE b (y TEXT);").length,2,'a one-line trigger');
 assert.throws(()=>splitStatements('CREATE TABLE a (x'),/ends inside a statement/);
 const whole=fresh(),split=fresh();
 for(const file of files)sqlite(whole,file.sql);
 for(const file of files)sqlite(split,splitStatements(file.sql).join(';\n')+';\n');
 const schema=file=>rows(file,'SELECT type, name, sql FROM sqlite_master ORDER BY type, name');
 assert.deepEqual(schema(split),schema(whole),'the split chain builds the same schema as sqlite3 reading the files whole');
 assert.deepEqual(rows(split,'SELECT * FROM schema_contract'),rows(whole,'SELECT * FROM schema_contract'));
 assert.deepEqual(rows(split,'SELECT * FROM ratings_domain_authority'),rows(whole,'SELECT * FROM ratings_domain_authority'));
 const head=Number(files.at(-1).name.slice(0,4));
 assert.equal(rows(split,'SELECT version FROM schema_contract')[0].version,head);

 // 2. The identity of the chain moves with a migration: an older store is imported again.
 const identity=await migrationsIdentity();
 assert.match(identity,/^[0-9a-f]{64}$/);
 const copy=fs.mkdtempSync(path.join(root,'mig-'));
 for(const file of files)fs.writeFileSync(path.join(copy,file.name),file.sql);
 assert.equal(await migrationsIdentity(copy),identity);
 fs.appendFileSync(path.join(copy,files.at(-1).name),'\n-- changed\n');
 assert.notEqual(await migrationsIdentity(copy),identity);
 await assert.rejects(()=>migrationFiles(fs.mkdtempSync(path.join(root,'empty-'))),/No migration files/);

 // 3. Install: schema at the head, every marker moved by the guarded transitions, synthetic rows, a published generation.
 const catalog=await loadLocalCatalog();
 const file=fresh();
 const db=d1Standin(file);
 const bucket=new MemoryBucket();
 await importFixtures(bucket,catalog);
 const env={BUCKET:bucket,DB:db};
 assert.equal(await readLocalD1Ready(env),false,'an empty database is not a ready store');
 const installed=await installLocalD1(env,{catalog});
 assert.equal(installed.schemaVersion,head);
 assert.equal(installed.migrations,files.length);
 assert.equal(installed.programmeRunId,'local-fixture');
 assert.equal(await readLocalD1Ready(env),true);
 const marker=table=>rows(file,`SELECT * FROM ${table}`)[0];
 assert.deepEqual([marker('film_person_authority').mode,marker('film_person_authority').generation,marker('film_person_baseline').state],['d1',2,'verified']);
 assert.equal(marker('prediction_domain_authority').mode,'d1');
 assert.deepEqual([marker('ratings_domain_authority').mode,marker('ratings_domain_authority').cutover],['d1','open']);
 assert.deepEqual([marker('published_epg_authority').mode,marker('published_epg_authority').programme_run_id],['d1','local-fixture']);
 assert.deepEqual([marker('discovery_authority').mode,marker('discovery_authority').programme_run_id,marker('discovery_authority').published_programme_run_id],['d1','local-fixture','local-fixture']);
 for(const table of ['owner_review_authority','metadata_cache_authority','filter_preset_authority','started_authority','epg_checkpoint_authority'])assert.equal(marker(table).mode,'d1',table);
 assert.equal(marker('watchlist_authority').mode,'epg','the watchlist authority stays as migrated');
 assert.equal(marker('prediction_aux_authority').mode,'r2','the prediction auxiliary documents stay in the local bucket');
 assert.deepEqual(rows(file,'SELECT alias_id, watched, actual_rating, rating_known FROM ratings_view'),[{alias_id:'movie-1',watched:1,actual_rating:4.5,rating_known:1}]);
 assert.deepEqual(rows(file,'SELECT film_id, predicted_rating FROM prediction_pointer'),[{film_id:'movie-2',predicted_rating:4}]);
 assert.deepEqual(rows(file,'SELECT film_id FROM prediction_fingerprint ORDER BY film_id').map(row=>row.film_id),['movie-1','movie-2']);
 assert.deepEqual(rows(file,'SELECT id, started FROM started_mark'),[{id:'movie-1',started:1}]);
 assert.deepEqual(rows(file,'SELECT programme_run_id, phase FROM published_epg_generation'),[{programme_run_id:'local-fixture',phase:'published'}]);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM published_epg_show')[0].n,3,'the three broadcasts of the dummy programme are published rows');
 // Every prediction row names an immutable R2 body whose SHA-256 the Worker verifies; the body must exist in the local bucket.
 const {fingerprintContentHash}=await import('../src/prediction-d1.js');
 for(const row of [...rows(file,'SELECT r2_key, content_sha256 FROM prediction_pointer'),...rows(file,'SELECT r2_key, content_sha256 FROM prediction_fingerprint'),...rows(file,'SELECT r2_key, content_sha256 FROM prediction_profile')]){
  const object=await bucket.get(row.r2_key);
  assert.ok(object,'bucket holds '+row.r2_key);
  assert.equal(await fingerprintContentHash(await object.json()),row.content_sha256,row.r2_key);
 }
 // A second install on a database that already holds a schema is refused: a store is deleted and imported again, never migrated in place.
 await assert.rejects(()=>installLocalD1(env,{catalog}),error=>error instanceof LocalD1Error&&/not empty/.test(error.message));
 await assert.rejects(()=>applyMigrations(db),/not empty/);
 await assert.rejects(()=>installLocalD1({BUCKET:bucket},{catalog}),/no D1 binding/);

 // 4. Readiness refuses every incomplete state instead of serving it.
 assert.equal(await readLocalD1Ready({BUCKET:bucket}),false,'no D1 binding');
 const behind=fresh();
 for(const item of files.slice(0,20))sqlite(behind,splitStatements(item.sql).join(';\n')+';\n');
 assert.equal(await readLocalD1Ready({BUCKET:bucket,DB:d1Standin(behind)}),false,'a schema behind the head of the chain');
 for(const [label,update] of [
  ['ratings authority back on r2',"DROP TRIGGER IF EXISTS ratings_domain_authority_transition;UPDATE ratings_domain_authority SET mode='r2'"],
  ['started authority back on r2',"DROP TRIGGER IF EXISTS started_authority_transition;UPDATE started_authority SET mode='r2'"],
  ['no published generation',"DELETE FROM published_epg_generation"],
  ['discovery pointer cleared',"UPDATE discovery_authority SET programme_run_id=NULL"],
 ]){
  const broken=fresh();
  fs.copyFileSync(file,broken);
  try{sqlite(broken,'PRAGMA foreign_keys=OFF;'+update);}catch(error){assert.fail(label+': '+error.message);}
  assert.equal(await readLocalD1Ready({BUCKET:bucket,DB:d1Standin(broken)}),false,label);
 }

 // 5. The fixture rows are built from the catalog alone: no film without data gets a row.
 const built=await fixtureRows({films:[{id:'only-a-title',title:'X'}]},{at:'2026-01-01T00:00:00.000Z'});
 assert.deepEqual(built.statements.map(item=>item.sql.match(/INTO (\w+)/)[1]),['prediction_profile']);

 // 6. The D1 input of a snapshot store: only INSERT into the tables a snapshot cannot supply, required tables present, absolute path.
 const input=name=>path.join(root,name);
 const good=input('good.sql');
 fs.writeFileSync(good,"-- operator rows\nINSERT INTO prediction_profile (version, profile_hash, active, created_at, r2_key, content_sha256) VALUES (1,'h; with semicolon',1,'2026-01-01T00:00:00.000Z','k','s');\nINSERT INTO \"ratings_view\" (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES ('a','f',1,4,NULL,1,'2026-01-01T00:00:00.000Z');\n");
 const parsed=await readOperatorRows(good);
 assert.equal(parsed.statements.length,2);
 assert.ok(parsed.statements[0].includes("'h; with semicolon'"),'a semicolon inside a string literal does not split');
 await assert.rejects(()=>readOperatorRows(''),/No D1 input/);
 await assert.rejects(()=>readOperatorRows('relative.sql'),/absolute path/);
 await assert.rejects(()=>readOperatorRows(input('missing.sql')),/cannot be read/);
 const refused=async(name,text,pattern)=>{fs.writeFileSync(input(name),text);await assert.rejects(()=>readOperatorRows(input(name)),pattern,name);};
 await refused('ddl.sql',"CREATE TABLE x (a TEXT);",/may only INSERT/);
 await refused('marker.sql',"UPDATE ratings_domain_authority SET mode='r2';",/may only INSERT/);
 await refused('other-table.sql',"INSERT INTO started_mark (id, started, rev) VALUES ('a',1,1);",/may only INSERT/);
 await refused('no-ratings.sql',"INSERT INTO prediction_profile (version, profile_hash, active, created_at, r2_key, content_sha256) VALUES (1,'h',1,'t','k','s');",/no rows for ratings_view/);
 await refused('no-profile.sql',"INSERT INTO ratings_view (alias_id, fact_key, rating_known, updated_at) VALUES ('a','f',0,'t');",/no rows for prediction_profile/);
 await refused('open-string.sql',"INSERT INTO ratings_view (alias_id) VALUES ('a);",/ends inside a string/);
 assert.equal(await operatorRowsIdentity(''),null);
 const before=await operatorRowsIdentity(good);
 fs.appendFileSync(good,'-- touched\n');
 assert.notEqual(await operatorRowsIdentity(good),before,'a changed input file imports the snapshot store again');

 // 7. Started marks of a snapshot store come from its own started/ objects, tombstones included.
 const startedBucket=new MemoryBucket();
 await startedBucket.put('started/a.json',JSON.stringify({id:'a',started:true,startedAt:'2026-02-02T00:00:00.000Z'}));
 await startedBucket.put('started/b.json',JSON.stringify({id:'b',started:false}));
 await startedBucket.put('events/x.json','{}');
 const marks=await startedRowsFromBucket(startedBucket);
 assert.deepEqual(marks.map(item=>item.params),[['a',1,'2026-02-02T00:00:00.000Z'],['b',0,null]]);
}finally{
 fs.rmSync(root,{recursive:true,force:true});
}
console.log('Local D1: splitter parity with sqlite3, guarded marker activation, synthetic rows with verified bodies, readiness refusals and operator input passed');
