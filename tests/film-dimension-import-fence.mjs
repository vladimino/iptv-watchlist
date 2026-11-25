// AIR-661 / ADR 0218 (Accepted) decisions 6 and 7, stage 2: the offline import target contract (a write gate keyed on the import session), the safe
// offline import W2 and the retirement fence W3. Real SQLite (the sqlite3 CLI); the importer that predates stage 2 is the frozen code of d3e1a4d
// (tests/fixtures/air-661-old-importer). No Worker, R2, network or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {importBatch} from '../src/offline-importer.js';
import {DIMENSION_STATUSES,OFFLINE_IMPORT_CONTRACT_VERSION,PROTECTED_ROW_SQL,REPLACEABLE_IDENTITY_SQL,PROVISIONAL_LOCALIZATION_SQL,REPLACEABLE_LOCALIZATION_SQL,fenceTriggerSql,offlineImportFenceSql,openImportSession,protectedReasons,provisionalLocalization,replaceableIdentity,replaceableLocalization,schemaTablesOf,verifyImportFence,withOfflineImportFence} from '../src/film-dimension-import-fence.js';
import {KNOWN_STATUSES} from '../src/domain/film-dimension-parity.js';
import {createCanonicalRepository as createOldCanonicalRepository} from './fixtures/air-661-old-importer/canonical-repository.baseline.js';
import {importBatch as oldImportBatch} from './fixtures/air-661-old-importer/offline-importer.baseline.js';
import {sessionSql} from './import-fence-helper.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-import-fence-'));
const V1=fs.readFileSync('migrations/0001_schema_v1.sql','utf8');
const V4=['0001_schema_v1.sql','0002_generation_stage.sql','0003_candidate_show_identity.sql','0004_projection_state.sql'].map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const AT='2026-11-20T10:00:00.000Z',LATER='2026-11-21T10:00:00.000Z';
let files=0;

// ---- helpers ------------------------------------------------------------------------------------------------------------------------------------------------
const literal=value=>value==null?'NULL':typeof value==='number'?String(value):typeof value==='boolean'?(value?'1':'0'):"'"+String(value).replaceAll("'","''")+"'";
const render=(sql,params=[])=>{let i=0;const text=sql.replace(/\?/g,()=>literal(params[i++]));assert.equal(i,params.length,'every parameter is used');return text;};
function exec(file,sql){const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr||'sqlite failed');}
function query(file,sql,params=[]){const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const t=r.stdout.trim();return t?JSON.parse(t):[];}
// The adapter shape of scripts/offline-import.mjs: single-statement reads, the writes of a transaction sent as one BEGIN..COMMIT script. `race(fn)` runs
// fn once, after the next transaction's plan read the database and right before its batch is sent. `stats.writes` counts write statements sent.
function openSqlite(file){
 const state={buffer:null,before:null},stats={writes:0};
 return {
  stats,
  race(fn){state.before=fn;},
  run(sql,params=[]){stats.writes++;const s=render(sql,params)+';';if(state.buffer)state.buffer.push(s);else exec(file,s);return Promise.resolve();},
  get(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params)[0]??null);},
  all(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params));},
  async transaction(fn){
   if(state.buffer)return fn();
   state.buffer=[];
   try{await fn();if(state.before){const hook=state.before;state.before=null;hook();}exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}
   finally{state.buffer=null;}
  },
 };
}
const target=({fence=true,schema=V1}={})=>{const file=path.join(root,'t-'+(files++)+'.sqlite');exec(file,fence?withOfflineImportFence(schema):schema);return file;};
const write=(file,sql)=>exec(file,sessionSql(sql));
const dump=file=>JSON.stringify(query(file,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({name})=>[name,query(file,`SELECT * FROM ${name} ORDER BY 1,2`)]));
const row=(file,id,dimension)=>query(file,'SELECT * FROM film_dimension WHERE film_id=? AND dimension=?',[id,dimension])[0]??null;
const dims=(file,id)=>query(file,'SELECT * FROM film_dimension WHERE film_id=? ORDER BY dimension',[id]);
const filmRow=(file,id)=>query(file,'SELECT id,canonical_identity,original_title FROM film WHERE id=?',[id])[0]??null;
const insert=(table,values)=>`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.values(values).map(literal).join(',')});`;
const STATUS={identity:'resolved',metadata:'fresh',localization:'provisional',fingerprint:'current',prediction:'current'};
const dimRow=(film_id,dimension,over={})=>insert('film_dimension',{film_id,dimension,status:STATUS[dimension],source:'legacy',source_version:'v0',provenance_json:null,value:dimension==='localization'?'Сохранённое':null,authority:null,last_error:'old error',failure_reason:'old',retry_at:AT,attempts:3,next_action:'retry',updated_at:AT,...over});
const filmInsert=(id,title='Stored Title')=>insert('film',{id,contract_version:1,canonical_identity:'tmdb:1',original_title:title,updated_at:AT});
const state=(dimension,status,extra={})=>({dimension,status,updatedAt:extra.updatedAt||LATER,source:extra.source||'letterboxd',sourceVersion:extra.sourceVersion??null,provenance:extra.provenance??null,value:extra.value??null,nextAction:'retry',attempts:2,lastError:'boom',failureReason:'fetch',retryAt:LATER});
const film=(id,title,extra={})=>({contractVersion:1,id,canonicalIdentity:extra.canonicalIdentity??null,originalTitle:title,externalIds:[{scheme:'letterboxd',value:id.slice(5),trusted:true,conflicting:false}],aliases:[],identity:state('identity','resolved',{provenance:extra.identityProvenance??null}),metadata:state('metadata','fresh'),fingerprint:state('fingerprint','current'),prediction:state('prediction','current'),localization:extra.localization??state('localization','provisional',{value:'Импорт',source:'wikidata'})});
// A Film already in the target with every legacy row: identity (control by default), a locked metadata row, fingerprint, prediction, localization.
function seed(file,id,{identity={status:'reviewed',authority:'owner',provenance_json:'{"authority":"owner","titleSource":{"source":"owner","at":"x"}}'},localization={},title='Stored Title'}={}){
 write(file,'PRAGMA defer_foreign_keys=ON;'+filmInsert(id,title)+dimRow(id,'identity',identity)+dimRow(id,'metadata',{status:'reviewed',authority:'owner',provenance_json:'{"authority":"owner"}'})+dimRow(id,'fingerprint')+dimRow(id,'prediction')+dimRow(id,'localization',localization));
}
const repoOf=file=>{const db=openSqlite(file);openImportSession(db,{now:()=>AT});return {db,repo:createCanonicalRepository(db)};};
const repositoriesOf=(db,canonical=createCanonicalRepository)=>({canonical:canonical(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)});
const unit=(id,title,sha,extra={})=>({family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:sha,targetTable:'film',targetId:id,unportable:false,input:{film:film(id,title,extra),watchlist:true}});
const personUnit=sha=>({family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:sha,targetTable:'person',targetId:'person:actor/a',unportable:false,input:{person:{contractVersion:1,id:'person:actor/a',roleId:'actor/a',externalIds:[{scheme:'letterboxd-role',value:'actor/a',trusted:true,conflicting:false}],aliases:[],identity:state('identity','resolved'),localization:state('localization','missing',{source:'letterboxd'})}}});

// ---- 1. Contract pins -------------------------------------------------------------------------------------------------------------------------------------
assert.deepEqual(JSON.parse(JSON.stringify(DIMENSION_STATUSES)),JSON.parse(JSON.stringify(KNOWN_STATUSES)),'the repository statuses are the parity classifier statuses');
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/film-dimension-import-fence|offline_import/);
assert.ok(!fs.readdirSync('migrations').some(name=>/import_fence|offline_import/.test(name)),'the contract is not part of the production migration chain');
assert.match(fs.readFileSync('scripts/offline-import.mjs','utf8'),/withOfflineImportFence/,'a file the offline import creates carries the contract');
assert.deepEqual(schemaTablesOf(V4).sort(),query(target({fence:false,schema:V4}),"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(item=>item.name),'the fence covers exactly the tables a schema script keeps');

// ---- 2. The contract read: missing, wrong version, incomplete, altered, uncovered table, open session ----------------------------------------------------
{
 const ok=target({schema:V4});
 assert.deepEqual(await verifyImportFence(openSqlite(ok)),{ok:true,version:OFFLINE_IMPORT_CONTRACT_VERSION});
 assert.deepEqual(await verifyImportFence(openSqlite(target({fence:false}))),{ok:false,reason:'import_target_unfenced'});
 assert.throws(()=>exec(ok,offlineImportFenceSql(['film'])),/UNIQUE|constraint|already exists/i,'a second install refuses');
 assert.throws(()=>exec(ok,"UPDATE offline_import_contract SET version=2"),/offline_import_contract_immutable/);
 assert.throws(()=>exec(ok,"DELETE FROM offline_import_contract"),/offline_import_contract_immutable/);
 const tamper=(sql)=>{const file=target();exec(file,'DROP TRIGGER offline_import_contract_no_update;'+sql);return openSqlite(file);};
 for(const version of [2,0])assert.deepEqual(await verifyImportFence(tamper(`UPDATE offline_import_contract SET version=${version}`)),{ok:false,reason:'import_target_contract_unsupported',version,supported:1},'version '+version);
 const dropped=await verifyImportFence((()=>{const file=target();exec(file,'DROP TRIGGER offline_import_fence_person_insert');return openSqlite(file);})());
 assert.equal(dropped.reason,'import_target_fence_invalid');assert.deepEqual(dropped.missing,['person:insert']);
 const altered=await verifyImportFence((()=>{const file=target();exec(file,"DROP TRIGGER offline_import_fence_film_delete;CREATE TRIGGER offline_import_fence_film_delete BEFORE DELETE ON film FOR EACH ROW WHEN 0 BEGIN SELECT RAISE(ABORT, 'offline_import_target_fenced'); END;");return openSqlite(file);})());
 assert.deepEqual(altered.missing,['film:delete'],'a trigger with the right name and the wrong body is not the fence');
 const uncovered=await verifyImportFence((()=>{const file=target();exec(file,'CREATE TABLE later_table (id INTEGER PRIMARY KEY) STRICT');return openSqlite(file);})());
 assert.deepEqual(uncovered.missing,['declared_coverage'],'a table added after the install makes the declared coverage inconsistent: refused');
 // Gate-table shape, a second session row, declared/actual coverage and the schema version, each on a real SQLite target.
 const mutate=(sql)=>{const file=target({schema:V4});exec(file,'DROP TRIGGER offline_import_contract_no_update;DROP TRIGGER offline_import_contract_no_delete;'+sql);return openSqlite(file);};
 const noCheck=target({fence:false,schema:V4});
 exec(noCheck,offlineImportFenceSql(schemaTablesOf(V4)).replace('CHECK (id = 1), opened_at',', opened_at'));
 assert.equal((await verifyImportFence(openSqlite(noCheck))).reason,'import_target_fence_invalid','a session table without CHECK (id = 1)');
 exec(noCheck,"INSERT INTO offline_import_session (id,opened_at) VALUES (2,'x')");
 const second=await verifyImportFence(openSqlite(noCheck));
 assert.equal(second.reason,'import_target_fence_invalid','the malformed session table is refused before its stray row is even read');
 const sessionRow2=target({schema:V4});
 assert.throws(()=>exec(sessionRow2,"INSERT INTO offline_import_session (id,opened_at) VALUES (2,'x')"),/CHECK|constraint/i,'the valid session table cannot hold a second row');
 assert.equal((await verifyImportFence(mutate("UPDATE offline_import_contract SET tables_json='[\"film\"]'"))).reason,'import_target_fence_invalid');
 assert.deepEqual((await verifyImportFence(mutate("UPDATE offline_import_contract SET tables_json='not json'"))).missing,['declared_coverage']);
 assert.throws(()=>mutate("INSERT INTO offline_import_contract (id,version,tables_json) VALUES (2,1,'[]')"),/CHECK|constraint/i,'the contract table cannot hold a second row');
 assert.equal((await verifyImportFence(mutate("DROP TABLE offline_import_session;CREATE TABLE offline_import_session (id INTEGER PRIMARY KEY, opened_at TEXT NOT NULL) STRICT"))).reason,'import_target_fence_invalid');
 // The supported schema_contract version of each CLI path.
 const v4=openSqlite(target({schema:V4}));
 assert.deepEqual(await verifyImportFence(v4,{schemaVersions:[3,4]}),{ok:true,version:1});
 assert.equal((await verifyImportFence(openSqlite(target({schema:V4})),{schemaVersions:[5]})).reason,'import_target_schema_unsupported');
 assert.deepEqual(await verifyImportFence(openSqlite(target({schema:V1})),{schemaVersions:[3,4]}),{ok:false,reason:'import_target_schema_unsupported',version:1,supported:[3,4]});
 const open=target();exec(open,"INSERT INTO offline_import_session (id,opened_at) VALUES (1,'crashed')");
 assert.equal((await verifyImportFence(openSqlite(open))).reason,'import_target_session_open');
 // Every operation on every data table is gated; the session row lets a write through only inside its own batch.
 const gated=target();
 for(const sql of [filmInsert('film:g'),"UPDATE schema_contract SET note='x' WHERE id=1","DELETE FROM schema_contract","INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('k','s','t','i','x')"])assert.throws(()=>exec(gated,sql),/offline_import_target_fenced/,sql);
 write(gated,filmInsert('film:g'));
 assert.equal(filmRow(gated,'film:g').original_title,'Stored Title');
 assert.equal(query(gated,'SELECT COUNT(*) AS n FROM offline_import_session')[0].n,0,'the session row never outlives its batch');
 assert.equal(fenceTriggerSql('film','insert').includes('offline_import_session'),true);
}

// ---- 3. The importer that predates stage 2 (frozen d3e1a4d code) cannot write a fenced target at all ----------------------------------------------------
{
 const file=target();seed(file,'film:owned');
 write(file,"INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('people.json','sha-old-p','person','person:actor/a','"+AT+"')");
 const before=dump(file);
 const db=openSqlite(file);
 const old=repositoriesOf(db,createOldCanonicalRepository);
 // A whole batch: a person first, a receipt-only resume, the protected Film and a link that retires it.
 // It records the refused units in its own ledger or throws; either way the target is unchanged.
 const oldRun=await oldImportBatch(db,old,{importedAt:LATER,units:[personUnit('sha-old-p2'),unit('film:owned','Import Title','sha-old-f')]}).catch(error=>({thrown:String(error.message)}));
 assert.ok(oldRun.thrown?/offline_import_target_fenced/.test(oldRun.thrown):oldRun.applied===0,JSON.stringify(oldRun.thrown??oldRun.stopReasons));
 assert.equal(dump(file),before,'the old batch changed nothing');
 // The enrichment-owned W2 (identity and metadata only), W2 for the offline owner and the old link/retirement, each straight on the repository.
 await assert.rejects(()=>old.canonical.projectFilm({film:film('film:owned','Enrichment Title'),metadata:null,watchlist:null}),/offline_import_target_fenced/);
 await assert.rejects(()=>old.canonical.saveFilm({film:film('film:owned','Import Title')}),/offline_import_target_fenced/);
 write(file,filmInsert('film:survivor','Survivor'));
 const withSurvivor=dump(file);
 await assert.rejects(()=>old.canonical.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:owned',to:'film:survivor',at:LATER}}),/offline_import_target_fenced/);
 assert.equal(dump(file),withSurvivor,'no old entry point changed anything');
 // The same old batch on an unfenced copy is exactly the loss the contract prevents.
 const open=target({fence:false});exec(open,'PRAGMA defer_foreign_keys=ON;'+filmInsert('film:owned')+dimRow('film:owned','identity',{status:'reviewed'})+dimRow('film:owned','metadata',{status:'reviewed'}));
 const openDb=openSqlite(open);
 await oldImportBatch(openDb,repositoriesOf(openDb,createOldCanonicalRepository),{importedAt:LATER,units:[unit('film:owned','Import Title','sha-x')]});
 assert.equal(filmRow(open,'film:owned').original_title,'Import Title');
 assert.equal(row(open,'film:owned','identity').status,'resolved','without the contract the old importer overwrote the reviewed identity and the lock');
}

// ---- 4. The current importer reads the target before any write and refuses what is not the contract -----------------------------------------------------
for(const [name,make,reason] of [['unfenced',()=>target({fence:false}),'import_target_unfenced'],['future version',()=>{const f=target();exec(f,"DROP TRIGGER offline_import_contract_no_update;UPDATE offline_import_contract SET version=9;");return f;},'import_target_contract_unsupported'],['missing trigger',()=>{const f=target();exec(f,'DROP TRIGGER offline_import_fence_film_update;');return f;},'import_target_fence_invalid'],['open session',()=>{const f=target();exec(f,"INSERT INTO offline_import_session (id,opened_at) VALUES (1,'x')");return f;},'import_target_session_open']]){
 const file=make(),before=dump(file),db=openSqlite(file);
 const result=await importBatch(db,repositoriesOf(db),{importedAt:AT,units:[personUnit('sha-p'),unit('film:new','New','sha-a')]});
 assert.equal(result.stopped,true,name);
 assert.deepEqual(result.stopReasons,[reason],name);
 assert.equal(db.stats.writes,0,name+': no write statement was sent');
 assert.equal(dump(file),before,name+': nothing changed');
}

// ---- 5. W2: metadata (locked and unlocked), fingerprint and prediction byte-identical, none inserted, no processing field -------------------------------
{
 const file=target();seed(file,'film:keep',{identity:{}});
 write(file,'PRAGMA defer_foreign_keys=ON;'+filmInsert('film:unlocked','U')+dimRow('film:unlocked','identity')+dimRow('film:unlocked','metadata')+dimRow('film:unlocked','fingerprint',{status:'stale'}));
 const {repo}=repoOf(file);
 const legacy=id=>dims(file,id).filter(item=>!['identity','localization'].includes(item.dimension));
 const before={keep:legacy('film:keep'),unlocked:legacy('film:unlocked')};
 const saved=await repo.saveFilm({film:film('film:keep','Import Title')});
 await repo.saveFilm({film:film('film:unlocked','Import U')});
 assert.deepEqual(legacy('film:keep'),before.keep,'locked metadata, fingerprint and prediction rows byte-identical');
 assert.deepEqual(legacy('film:unlocked'),before.unlocked,'unlocked metadata and a stale fingerprint byte-identical');
 await repo.saveFilm({film:film('film:fresh','Fresh')});
 assert.deepEqual(dims(file,'film:fresh').map(item=>item.dimension),['identity','localization'],'a new Film gets identity and localization only');
 const identity=row(file,'film:keep','identity');
 assert.equal(identity.updated_at,LATER,'the replaceable identity row is replaced');
 assert.deepEqual([identity.last_error,identity.failure_reason,identity.retry_at,identity.attempts,identity.next_action],[null,null,null,0,'none'],'no processing field imported');
 const fresh=row(file,'film:fresh','localization');
 assert.deepEqual([fresh.last_error,fresh.failure_reason,fresh.retry_at,fresh.attempts,fresh.next_action],[null,null,null,0,'none'],'a new localization row carries no processing field');
 assert.equal(row(file,'film:keep','localization').value,'Сохранённое','the stored provisional title is the sole record on this target, so it is kept');
 assert.equal(saved.originalTitle,'Import Title');
}

// ---- 6. W2 keeps the title and every control or unknown_legacy identity and localization row byte-identical --------------------------------------------
{
 const identityCases=[['reviewed',{status:'reviewed'}],['owner',{authority:'owner',provenance_json:'{"authority":"owner"}'}],['titleSource',{provenance_json:'{"titleSource":{"source":"tmdb","at":"x"}}'}],['unknown status',{status:'mystery'}],['malformed provenance',{provenance_json:'{not json'}],['array provenance',{provenance_json:'[1]'}],['unknown authority',{authority:'robot'}]];
 for(const [name,identity] of identityCases){
  const file=target();seed(file,'film:c',{identity,localization:{status:'reviewed',authority:'owner',value:'Владелец'}});
  const before={film:filmRow(file,'film:c'),dims:dims(file,'film:c')};
  const {repo}=repoOf(file);
  const saved=await repo.saveFilm({film:film('film:c','Import Title',{canonicalIdentity:'tmdb:2'})});
  assert.deepEqual({film:filmRow(file,'film:c'),dims:dims(file,'film:c')},before,name+': title, identity and every row kept');
  assert.equal(saved.originalTitle,'Stored Title',name);
 }
 const localizationCases=[['owner provisional',{authority:'owner'}],['dictionary provisional',{authority:'dictionary'}],['unknown status',{status:'draft'}],['malformed provenance',{provenance_json:'{bad'}],['titleSource on localization',{provenance_json:'{"titleSource":{"source":"x"}}'}],['owner reviewed',{status:'reviewed',authority:'owner'}],['unknown authority reviewed',{status:'reviewed',authority:'robot'}]];
 for(const [name,localization] of localizationCases){
  const file=target();seed(file,'film:l',{identity:{},localization});
  const before=row(file,'film:l','localization');
  const {repo}=repoOf(file);
  await repo.saveFilm({film:film('film:l','Import Title')});
  assert.deepEqual(row(file,'film:l','localization'),before,name+': localization byte-identical');
 }
 // A stored provisional title is the stage-1 control class when it is the sole record, and a schema-3/4 target has no source table to prove it
 // redundant: a different provisional title and a missing localization both leave it byte-identical, with and without a race.
 for(const [name,incoming] of [['different provisional',state('localization','provisional',{value:'Другое',source:'wikidata'})],['missing',state('localization','missing')]]){
  const sole=target();seed(sole,'film:sole',{identity:{}});
  const before=row(sole,'film:sole','localization');
  await repoOf(sole).repo.saveFilm({film:film('film:sole','Import',{localization:incoming})});
  assert.deepEqual(row(sole,'film:sole','localization'),before,'sole-record provisional title kept against '+name);
  const raced=target();seed(raced,'film:sole',{identity:{},localization:{status:'missing',value:null}});
  const handle=repoOf(raced);
  handle.db.race(()=>write(raced,"UPDATE film_dimension SET status='provisional',value='Появилось' WHERE film_id='film:sole' AND dimension='localization'"));
  await handle.repo.saveFilm({film:film('film:sole','Import',{localization:incoming})});
  assert.equal(row(raced,'film:sole','localization').value,'Появилось','a value that appears after the plan is kept against '+name);
 }
 // An EMPTY localization row is replaced by an automatic value; an authorized reviewed upgrade (dictionary/owner) replaces a provisional title.
 const empty=target();seed(empty,'film:e',{identity:{},localization:{status:'missing',value:null}});
 await repoOf(empty).repo.saveFilm({film:film('film:e','Import')});
 assert.equal(row(empty,'film:e','localization').value,'Импорт');
 const file=target();seed(file,'film:u',{identity:{}});
 const {repo}=repoOf(file);
 await repo.saveFilm({film:film('film:u','Import',{localization:state('localization','reviewed',{source:'dictionary',sourceVersion:'dictionary',value:'Словарь',provenance:{authority:'dictionary'}})})});
 const upgraded=row(file,'film:u','localization');
 assert.deepEqual([upgraded.status,upgraded.value,upgraded.authority,upgraded.attempts,upgraded.last_error],['reviewed','Словарь','dictionary',0,null]);
 // An import carrying a titleSource of its own does not bind it.
 const ts=target();const tsRepo=repoOf(ts).repo;
 await tsRepo.saveFilm({film:film('film:ts','Imported',{identityProvenance:{titleSource:{source:'owner',at:AT},note:'kept'}})});
 assert.deepEqual(JSON.parse(row(ts,'film:ts','identity').provenance_json),{note:'kept'});
 await tsRepo.saveFilm({film:film('film:ts','Imported again')});
 assert.equal(filmRow(ts,'film:ts').original_title,'Imported again','its own row stays replaceable');
}

// ---- 7. JS and SQL predicates agree on the same rows ------------------------------------------------------------------------------------------------
{
 const file=target({fence:false});
 const samples=[];
 const provenances=[null,'{}','null','{"a":1}','{"authority":"owner"}','{"titleSource":null}','{"titleSource":{"source":"tmdb"}}','{bad','[1]','"text"'];
 for(const [dimension,statuses] of Object.entries(KNOWN_STATUSES))for(const status of [...statuses,'mystery'])for(const provenance_json of provenances)for(const authority of [null,'','owner','dictionary','robot'])for(const value of [null,'','Название'])samples.push({dimension,status,provenance_json,authority,value});
 for(let at=0;at<samples.length;at+=400){
  const chunk=samples.slice(at,at+400);
  const values=chunk.map((item,i)=>`(${at+i},${literal(item.dimension)},${literal(item.status)},${literal(item.provenance_json)},${literal(item.authority)},${literal(item.value)})`).join(',');
  for(const result of query(file,`WITH s(i,dimension,status,provenance_json,authority,value) AS (VALUES ${values}) SELECT i,${REPLACEABLE_IDENTITY_SQL} AS identity,${REPLACEABLE_LOCALIZATION_SQL} AS localization,${PROVISIONAL_LOCALIZATION_SQL} AS provisional,${PROTECTED_ROW_SQL} AS protected FROM s ORDER BY i`)){
   const sample=samples[result.i];
   assert.equal(!!result.protected,protectedReasons(sample).length>0,'protected twin: '+JSON.stringify(sample));
   if(sample.dimension==='identity')assert.equal(!!result.identity,replaceableIdentity(sample),'identity twin: '+JSON.stringify(sample));
   if(sample.dimension==='localization'){assert.equal(!!result.localization,replaceableLocalization(sample),'localization twin: '+JSON.stringify(sample));assert.equal(!!result.provisional,provisionalLocalization(sample),'provisional twin: '+JSON.stringify(sample));}
  }
 }
 // The stage-1 classes W3 must keep: dictionary authority on a non-reviewed row (unknown_legacy), a provisional title that may be the sole record or an
 // unproved projection (control), and every reviewed row.
 for(const sample of [{dimension:'localization',status:'provisional',authority:'dictionary',value:'X'},{dimension:'localization',status:'provisional',authority:null,value:'Только здесь'},{dimension:'localization',status:'reviewed',authority:'dictionary',value:'Словарь'}])assert.ok(protectedReasons(sample).length,JSON.stringify(sample));
 assert.deepEqual(protectedReasons({dimension:'localization',status:'missing',authority:null,value:null,provenance_json:null}),[],'only an empty localization row is not protected');
}

// ---- 8. W3 refuses a protected Film at the plan (no write) and in the batch (race), and retires one with only replaceable rows ------------------------
{
 const protectedCases=[['metadata lock','metadata',{status:'reviewed'}],['owner identity','identity',{authority:'owner'}],['titleSource','identity',{provenance_json:'{"titleSource":{"source":"tmdb"}}'}],['unknown legacy fingerprint','fingerprint',{authority:'robot'}],['reviewed localization','localization',{status:'reviewed',authority:'dictionary'}],['dictionary provisional localization','localization',{authority:'dictionary'}],['sole-record provisional localization','localization',{}]];
 const gone=(file,dimension,over)=>write(file,'PRAGMA defer_foreign_keys=ON;'+filmInsert('film:gone','Gone')+dimRow('film:gone',dimension,over));
 for(const [name,dimension,over] of protectedCases){
  const file=target();
  const {repo}=repoOf(file);
  await repo.saveFilm({film:film('film:survivor','Survivor')});
  gone(file,dimension,over);
  const before=dump(file);
  const plan=repoOf(file);
  await assert.rejects(()=>plan.repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:gone',to:'film:survivor',at:LATER}}),error=>error.code==='film_retirement_protected_rows'&&error.rows.some(item=>item.dimension===dimension),name);
  assert.equal(plan.db.stats.writes,0,name+': refused at the plan, before any write');
  assert.equal(dump(file),before,name);
 }
 for(const [name,dimension,over,raced] of [['localization gains a value','localization',{status:'missing',value:null},"UPDATE film_dimension SET status='provisional',value='Новое' WHERE film_id='film:gone' AND dimension='localization'"],['dictionary authority appears','localization',{status:'missing',value:null},"UPDATE film_dimension SET authority='dictionary' WHERE film_id='film:gone' AND dimension='localization'"],['identity becomes owner','identity',{},"UPDATE film_dimension SET authority='owner' WHERE film_id='film:gone' AND dimension='identity'"]]){
  const file=target();
  const {repo}=repoOf(file);
  await repo.saveFilm({film:film('film:survivor','Survivor')});
  gone(file,dimension,over);
  const race=repoOf(file);
  race.db.race(()=>write(file,raced));
  await assert.rejects(()=>race.repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:gone',to:'film:survivor',at:LATER}}),/NOT NULL|constraint/i,name);
  assert.equal(filmRow(file,'film:gone').original_title,'Gone',name+': nothing retired');
  assert.equal(query(file,"SELECT COUNT(*) AS n FROM film_redirect")[0].n,0,name+': no redirect');
  assert.equal(dims(file,'film:gone').length,1,name+': the row is kept');
 }
 const file=target();const {repo}=repoOf(file);
 await repo.saveFilm({film:film('film:survivor','Survivor')});
 write(file,'PRAGMA defer_foreign_keys=ON;'+filmInsert('film:gone','Gone')+dimRow('film:gone','identity')+dimRow('film:gone','metadata')+dimRow('film:gone','fingerprint')+dimRow('film:gone','localization',{status:'missing',value:null}));
 const merged=await repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:gone',to:'film:survivor',at:LATER}});
 assert.equal(merged.id,'film:survivor');
 assert.equal(filmRow(file,'film:gone'),null);
}

// ---- 9. W2 race: an identity row that becomes control after the plan read keeps the title --------------------------------------------------------------
{
 const file=target();seed(file,'film:race',{identity:{}});
 const {db,repo}=repoOf(file);
 db.race(()=>write(file,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:race' AND dimension='identity'"));
 await repo.saveFilm({film:film('film:race','Import Title')});
 assert.equal(filmRow(file,'film:race').original_title,'Stored Title');
 assert.equal(row(file,'film:race','identity').status,'reviewed');
}

// ---- 10. importBatch end to end: replay, merge race, kept title explained, nothing lost, bounded writes --------------------------------------------------
{
 const file=target();seed(file,'film:owned');
 const db=openSqlite(file);
 const repositories=repositoriesOf(db);
 const units=[unit('film:owned','Import Title','sha-1'),...Array.from({length:5},(_,i)=>unit('film:n'+i,'Title '+i,'sha-n'+i))];
 const before=dims(file,'film:owned');
 const first=await importBatch(db,repositories,{importedAt:AT,units});
 assert.equal(first.stopped,false,JSON.stringify(first.stopReasons));
 assert.equal(first.explained,1);
 assert.equal(first.ledger.find(item=>item.targetId==='film:owned')?.reason,'identity_control_kept');
 // The retained control title is reported as such, never as a reviewed row.
 const soleFile=target();seed(soleFile,'film:sole',{identity:{}});
 const soleDb=openSqlite(soleFile);
 const soleRun=await importBatch(soleDb,repositoriesOf(soleDb),{importedAt:AT,units:[unit('film:sole','Sole','sha-sole')]});
 assert.equal(soleRun.ledger.find(item=>item.targetId==='film:sole')?.reason,'localization_control_kept');
 assert.equal(row(soleFile,'film:sole','localization').value,'Сохранённое');
 assert.equal(first.applied,5);
 assert.deepEqual(dims(file,'film:owned'),before,'the owned Film kept every row, its sole-record provisional title included');
 const perUnit=db.stats.writes/units.length;
 assert.ok(perUnit<=40,'bounded write statements per Film unit: '+perUnit);
 const snapshot=dump(file);
 const again=await importBatch(db,repositories,{importedAt:AT,units});
 assert.equal(again.applied,0);
 const data=text=>JSON.stringify(JSON.parse(text).filter(([table])=>table!=='import_receipt'));
 assert.equal(data(dump(file)),data(snapshot),'a replay changes no data (it may only checkpoint the reconciled, explained unit)');
 const settled=dump(file);
 assert.equal((await importBatch(db,repositories,{importedAt:AT,units})).applied,0);
 assert.equal(dump(file),settled,'a third run changes nothing at all');
 assert.equal(query(file,"SELECT COUNT(*) AS n FROM film_dimension WHERE dimension IN ('fingerprint','prediction','metadata') AND film_id LIKE 'film:n%'")[0].n,0,'no derived row inserted');
 assert.equal(query(file,'SELECT COUNT(*) AS n FROM offline_import_session')[0].n,0,'the session is closed after the run');
 assert.throws(()=>exec(file,"UPDATE film SET original_title='x'"),/offline_import_target_fenced/,'and the target is gated again');
}

// ---- 11. A valid closed target stays closed after a successful and after a failed batch; the typed W3 refusal reaches the ledger ----------------------
{
 const file=target();
 const db=openSqlite(file);
 const repositories=repositoriesOf(db);
 const old=()=>{const handle=openSqlite(file);return {handle,repos:repositoriesOf(handle,createOldCanonicalRepository)};};
 const refusedByContract=async label=>{
  const {handle,repos}=old();
  const before=dump(file);
  const run=await oldImportBatch(handle,repos,{importedAt:LATER,units:[personUnit('sha-old-'+label),unit('film:o'+label,'Old','sha-old-f'+label)]}).catch(error=>({thrown:String(error.message)}));
  assert.ok(run.thrown?/offline_import_target_fenced/.test(run.thrown):run.applied===0,label+': the old importer applied nothing');
  assert.equal(dump(file),before,label+': the old importer changed nothing');
  assert.equal((await verifyImportFence(openSqlite(file))).ok,true,label+': the target is still a valid closed contract');
 };
 await refusedByContract('fresh');
 const ok=await importBatch(db,repositories,{importedAt:AT,units:[unit('film:s1','Survivor','sha-s1'),unit('film:r1','Retired','sha-r1')]});
 assert.equal(ok.applied,2);
 await refusedByContract('after-success');
 // A failed batch: a link whose retired Film gains a protected row after the plan (the in-batch guard aborts the transaction).
 write(file,"UPDATE film_dimension SET status='provisional',value='Единственное' WHERE film_id='film:r1' AND dimension='localization'");
 const linkUnit=sha=>({family:'watchlist',kind:'link',sourceKey:'watchlist.json',sourceSha256:sha,targetTable:'film',targetId:'film:s1',unportable:false,input:{survivor:film('film:s1','Survivor'),redirect:{from:'film:r1',to:'film:s1',at:LATER}}});
 const planRefused=await importBatch(db,repositories,{importedAt:AT,units:[linkUnit('sha-link-plan')]});
 const planEntry=planRefused.ledger.find(item=>item.targetId==='film:s1');
 assert.deepEqual([planEntry.outcome,planEntry.reason],['conflict','film_retirement_protected_rows'],'the plan-time refusal keeps its typed reason in the ledger');
 assert.equal(filmRow(file,'film:r1').original_title,'Retired');
 write(file,"UPDATE film_dimension SET status='missing',value=NULL WHERE film_id='film:r1' AND dimension='localization'");
 db.race(()=>write(file,"UPDATE film_dimension SET status='provisional',value='Единственное' WHERE film_id='film:r1' AND dimension='localization'"));
 const batchRefused=await importBatch(db,repositories,{importedAt:AT,units:[linkUnit('sha-link-batch')]});
 const batchEntry=batchRefused.ledger.find(item=>item.targetId==='film:s1');
 assert.deepEqual([batchEntry.outcome,batchEntry.reason],['conflict','film_retirement_protected_rows'],'the in-batch refusal keeps its typed reason in the ledger');
 assert.equal(filmRow(file,'film:r1').original_title,'Retired','nothing was retired');
 assert.equal(query(file,'SELECT COUNT(*) AS n FROM film_redirect')[0].n,0);
 assert.equal(query(file,'SELECT COUNT(*) AS n FROM offline_import_session')[0].n,0,'the failed batch left no session row');
 await refusedByContract('after-failure');
}

console.log('film-dimension-import-fence: the offline import contract (write gate keyed on the import session, version, every trigger) refuses the frozen pre-stage-2 importer at its first write of any kind (batch, enrichment W2, link/retirement) with nothing changed, and the current importer refuses a missing, future, incomplete or open target before any write; W2 keeps metadata, fingerprint and prediction rows byte-identical, inserts none, imports no processing field, keeps title and every control or unknown_legacy identity and localization row; W3 keeps every reviewed, owner, titleSource, unknown and valued localization row at the plan and in the batch; JS and SQL predicates agree; replay is idempotent and bounded');
