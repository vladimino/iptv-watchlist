// AIR-367 / ADR 0099: the canonical Film/Person foundation. Migration 0013 (marker, fence, per-entity revision, baseline gate), the marker's
// state machine and fail-closed reads, and the fenced mutation API. A D1 stand-in over the sqlite3 CLI applies each batch as one transaction.
// No Worker, R2, TMDB or production access; nothing here is bundled.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import * as Authority from '../src/film-person-authority.js';
import {mutateFilm,mutatePerson,mergeFilms} from '../src/canonical-mutations.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-person-authority-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
const NEW='0013_film_person_authority';
let n=0;
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
function database(upTo=chain.length,apply=true){
 const file=path.join(root,'fp-'+(n++)+'.sqlite');
 const r=sqlite(file,chain.slice(0,upTo).map(sql).join('\n'));assert.equal(r.status,0,r.stderr);
 if(apply){const r2=sqlite(file,sql(NEW));assert.equal(r2.status,0,r2.stderr);}
 return file;
}
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern);};

// 1. The migration: it refuses anything but a complete version 12, creates nothing then, and inserts the r2 marker.
{
 for(const upTo of [11,10,9]){
  const file=database(upTo,false);
  const before=one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
  refused(file,sql(NEW));
  assert.equal(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'"),before,'a refused file creates nothing (v'+upTo+')');
 }
 const file=database();
 assert.equal(one(file,'SELECT version FROM schema_contract'),13);
 assert.deepEqual(rows(file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}]);
 assert.equal(one(file,'SELECT ok FROM film_person_cas'),1);
 assert.equal(one(file,'SELECT state FROM film_person_baseline'),'empty');
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_revision'),0);
 refused(file,sql(NEW));
 refused(file,'UPDATE schema_contract SET version=12',/schema_contract_downgrade/);
 // The migration copied nothing and moved nothing: no Film, no Person.
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),0);
}

// 2. The marker's state machine in SQL: only the allowed moves, one generation each, a verified baseline for prepared and d1.
{
 const file=database();
 const move=(mode,cutover,generation)=>`UPDATE film_person_authority SET mode='${mode}',cutover='${cutover}',generation=${generation} WHERE id=1;`;
 refused(file,move('prepared','open',1),/film_person_baseline_not_verified/);
 refused(file,move('d1','open',1),/film_person_authority_transition|film_person_baseline_not_verified/);
 refused(file,move('d1','held',1),/CHECK|film_person_authority_transition|film_person_baseline_not_verified/);
 // The baseline moves only empty -> loading -> verified; a partial (loading) baseline cannot become prepared.
 refused(file,"UPDATE film_person_baseline SET state='verified' WHERE id=1",/film_person_baseline_transition/);
 assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='run-1' WHERE id=1").status,0);
 refused(file,move('prepared','open',1),/film_person_baseline_not_verified/);
 assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='verified' WHERE id=1").status,0);
 refused(file,move('prepared','open',5),/film_person_authority_transition/);
 refused(file,move('prepared','open',0),/film_person_authority_transition/);
 assert.equal(sqlite(file,move('prepared','open',1)).status,0);
 refused(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1",/film_person_baseline_in_use/);
 refused(file,move('prepared','held',2),/CHECK|film_person_authority_transition/);
 refused(file,move('d1','held',2),/film_person_authority_transition/);
 assert.equal(sqlite(file,move('r2','open',2)).status,0,'prepared may go back to r2');
 assert.equal(sqlite(file,move('prepared','open',3)).status,0);
 assert.equal(sqlite(file,move('d1','open',4)).status,0);
 refused(file,move('r2','open',5),/film_person_authority_transition/);
 refused(file,move('prepared','open',5),/film_person_authority_transition/);
 assert.equal(sqlite(file,move('d1','held',5)).status,0);
 refused(file,move('r2','open',6),/film_person_authority_transition/);
 refused(file,move('prepared','open',6),/film_person_authority_transition/);
 assert.equal(sqlite(file,move('d1','open',6)).status,0,'held returns to open after validation');
 refused(file,'DELETE FROM film_person_authority',/film_person_authority_delete/);
 refused(file,"INSERT INTO film_person_authority (id,mode,cutover,generation) VALUES (2,'r2','open',0)");
 refused(file,"UPDATE film_person_authority SET mode='bogus' WHERE id=1");
}

// 3. Reading the marker: legacy before the feature, then r2, prepared, open and held; anything else fails closed.
{
 const v12=database(chain.length,false);
 assert.equal((await Authority.readAuthority({DB:d1Standin(v12)})).state,'legacy');
 const noDb=await Authority.readAuthority({});
 assert.equal(noDb.state,'legacy');assert.equal(noDb.r2Allowed,true);
 const file=database();
 const env={DB:d1Standin(file)};
 let gate=await Authority.readAuthority(env);
 assert.deepEqual([gate.state,gate.r2Allowed,gate.open,gate.held,gate.generation,gate.baseline],['r2',true,false,false,0,'empty']);
 assert.equal(Authority.readSource(gate),'r2');
 for(const state of ['legacy','r2','prepared'])assert.throws(()=>Authority.assertWritable({state}),error=>error.code==='film_person_not_open');
 sqlite(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 gate=await Authority.readAuthority(env);
 assert.deepEqual([gate.state,gate.r2Allowed,gate.baseline],['prepared',true,'verified']);assert.equal(Authority.readSource(gate),'r2');
 sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");
 gate=await Authority.readAuthority(env);
 assert.deepEqual([gate.state,gate.open,gate.r2Allowed],['open',true,false]);assert.equal(Authority.readSource(gate),'d1');assert.equal(Authority.assertWritable(gate).generation,2);
 sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 gate=await Authority.readAuthority(env);
 assert.deepEqual([gate.state,gate.held,gate.open,gate.r2Allowed],['held',true,false,false]);
 assert.throws(()=>Authority.readSource(gate),error=>error.code==='film_person_held','held never names R2');
 assert.throws(()=>Authority.assertWritable(gate),error=>error.code==='film_person_held');
 // Fail closed from version 13 on: a missing table, a missing row, a failed fence, a read error, a malformed row.
 const broken=async(setup,label)=>{
  const f=database();setup(f);
  await assert.rejects(()=>Authority.readAuthority({DB:d1Standin(f)}),error=>error.code==='film_person_unavailable',label);
 };
 await broken(f=>sqlite(f,'DROP TABLE canonical_revision'),'missing table');
 await broken(f=>sqlite(f,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority'),'missing marker row');
 refused(database(),'DELETE FROM film_person_cas',/film_person_cas_delete/);
 await broken(f=>sqlite(f,'DROP TRIGGER film_person_cas_no_delete;DELETE FROM film_person_cas'),'missing fence row');
 await broken(f=>sqlite(f,'DELETE FROM film_person_baseline'),'missing baseline row');
 const reads={DB:{prepare(text){return {bind(){return {first:async()=>{if(/film_person_authority/.test(text))throw new Error('D1_ERROR: network');return {version:13};},all:async()=>({results:[{name:'film_person_authority'},{name:'film_person_cas'},{name:'film_person_baseline'},{name:'canonical_revision'}]})};}};}}};
 await assert.rejects(()=>Authority.readAuthority(reads),error=>error.code==='film_person_unavailable','read error');
 const malformed={DB:{prepare(text){return {bind(){return {first:async()=>/schema_contract/.test(text)?{version:13}:/film_person_authority/.test(text)?{mode:'d1',cutover:'bogus',generation:1}:{ok:1,state:'verified'},all:async()=>({results:[{name:'film_person_authority'},{name:'film_person_cas'},{name:'film_person_baseline'},{name:'canonical_revision'}]})};}};}}};
 await assert.rejects(()=>Authority.readAuthority(malformed),error=>error.code==='film_person_unavailable','malformed row');
 assert.throws(()=>Authority.readSource({state:'unknown'}),error=>error.code==='film_person_unavailable');
}

// 4. transitionAuthority: the same machine from code, from the generation the caller read.
{
 const file=database();
 const env={DB:d1Standin(file)};
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'r2',to:'open',expectedGeneration:0}),error=>error.code==='film_person_transition');
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:0}),error=>error.code==='film_person_baseline_not_verified','a partial or missing baseline cannot become prepared');
 sqlite(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1");
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:0}),error=>error.code==='film_person_baseline_not_verified','a loading baseline');
 sqlite(file,"UPDATE film_person_baseline SET state='verified' WHERE id=1");
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:7}),error=>error.code==='film_person_fence');
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'prepared',to:'open',expectedGeneration:0}),error=>error.code==='film_person_fence','not in that state');
 assert.equal((await Authority.transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:0})).state,'prepared');
 assert.equal((await Authority.transitionAuthority(env,{from:'prepared',to:'open',expectedGeneration:1})).state,'open');
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'prepared',to:'open',expectedGeneration:1}),error=>error.code==='film_person_fence','a repeated move is refused');
 assert.equal((await Authority.transitionAuthority(env,{from:'open',to:'held',expectedGeneration:2})).state,'held');
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'held',to:'r2',expectedGeneration:3}),error=>error.code==='film_person_transition','no move out of held to r2');
 assert.equal((await Authority.transitionAuthority(env,{from:'held',to:'open',expectedGeneration:3})).generation,4);
}

// ---- The mutation API ----
const AT='2026-11-07T12:00:00.000Z';
function open(){
 const file=database();
 sqlite(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");
 return file;
}
const people=file=>sqlite(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/d1','director/d1',1,'x'),('person:actor/a1','actor/a1',1,'x'),('person:actor/a2','actor/a2',1,'x'),('person:actor/a3','actor/a3',1,'x'),('person:tmdb_actor/t1','tmdb_actor/t1',1,'x')");
const revision=(file,kind,id)=>Number(one(file,`SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='${kind}' AND id='${id}'),0)`));
const filmInput=(id,expectedRevision,extra={})=>({id,expectedRevision,at:AT,film:{contractVersion:1,canonicalIdentity:'tmdb:603',originalTitle:'The Matrix',externalIds:[{scheme:'tmdb',value:603,trusted:true,provenance:{source:'tmdb'}},{scheme:'letterboxd',value:'1abc',trusted:true}],aliases:[{kind:'title',value:'Матрица'}],...extra.film},credits:extra.credits});

// 5. Not open: legacy, r2, prepared and held reach no statement at all.
{
 for(const [label,setup] of [
  ['r2',()=>database()],
  ['prepared',()=>{const f=database();sqlite(f,"UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");return f;}],
  ['held',()=>{const f=open();sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");return f;}],
 ]){
  const file=setup(),db=d1Standin(file),env={DB:db};
  for(const run of [()=>mutateFilm(env,filmInput('film:tmdb:603',0)),()=>mutatePerson(env,{id:'person:actor/a1',expectedRevision:0,at:AT,person:{roleId:'actor/a1',contractVersion:1}}),()=>mergeFilms(env,{from:'film:a',to:'film:b',expected:{from:0,to:0},at:AT})]){
   await assert.rejects(run,error=>['film_person_not_open','film_person_held'].includes(error.code),label);
  }
  assert.equal(db.calls.batches,0,label+': no batch');
  assert.equal(one(file,'SELECT COUNT(*) FROM film'),0,label+': nothing written');
 }
 const legacyDb=d1Standin(database(chain.length,false));
 await assert.rejects(()=>mutateFilm({DB:legacyDb},filmInput('film:tmdb:603',0)),error=>error.code==='film_person_not_open');
 await assert.rejects(()=>mutateFilm({DB:{prepare:()=>{throw new Error('D1 down');}}},filmInput('film:tmdb:603',0)),error=>error.code==='film_person_unavailable','an unreadable marker fails closed');
}

// 6. A Film in an open authority: identity, typed ids, aliases and credits; the revision moves by one; the stale caller is refused whole.
{
 const file=open();people(file);
 sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:603','localization','reviewed','owner','1','{}','Матрица (владелец)','owner',0,'x')");
 // The row above needs the Film first, so create it through the API, then add the owner localization.
 sqlite(file,'DELETE FROM film_dimension');
 const db=d1Standin(file),env={DB:db};
 const created=await mutateFilm(env,filmInput('film:tmdb:603',0,{credits:{upsert:[{personId:'person:director/d1',role:'director'},{personId:'person:actor/a1',role:'actor'},{personId:'person:actor/a2',role:'actor'}]}}));
 assert.deepEqual(created,{id:'film:tmdb:603',revision:1});
 assert.equal(db.calls.batches,1,'one atomic batch');
 assert.equal(revision(file,'film','film:tmdb:603'),1);
 assert.deepEqual(rows(file,'SELECT scheme,value,trusted FROM film_external_id ORDER BY scheme'),[{scheme:'letterboxd',value:'1abc',trusted:1},{scheme:'tmdb',value:'603',trusted:1}]);
 assert.deepEqual(rows(file,"SELECT person_id,role,ordinal FROM film_person_credit ORDER BY role,ordinal"),[{person_id:'person:actor/a1',role:'actor',ordinal:0},{person_id:'person:actor/a2',role:'actor',ordinal:1},{person_id:'person:director/d1',role:'director',ordinal:0}]);
 // An owner localization is never touched (the API writes no dimension and no localization).
 sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:603','localization','reviewed','owner','1','{}','Матрица (владелец)','owner',0,'x')");
 // D1-only TMDB credit (AIR-286) at the end of its role.
 sqlite(file,"INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:603','person:tmdb_actor/t1','actor',2)");
 // A stale expected revision: refused, and the batch left nothing behind.
 const before=rows(file,'SELECT * FROM film_alias');
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',0,{film:{aliases:[{kind:'title',value:'Stale alias'}]}})),error=>error.code==='film_person_revision_conflict');
 assert.deepEqual(rows(file,'SELECT * FROM film_alias'),before);assert.equal(revision(file,'film','film:tmdb:603'),1);
 // The roster write: an existing credit keeps its ordinal, a new one is appended after the D1-only credit, nothing is renumbered or deleted.
 await mutateFilm(env,filmInput('film:tmdb:603',1,{credits:{upsert:[{personId:'person:actor/a2',role:'actor'},{personId:'person:actor/a3',role:'actor'}]}}));
 assert.deepEqual(rows(file,"SELECT person_id,ordinal FROM film_person_credit WHERE role='actor' ORDER BY ordinal"),[{person_id:'person:actor/a1',ordinal:0},{person_id:'person:actor/a2',ordinal:1},{person_id:'person:tmdb_actor/t1',ordinal:2},{person_id:'person:actor/a3',ordinal:3}]);
 assert.equal(one(file,"SELECT value FROM film_dimension WHERE film_id='film:tmdb:603' AND dimension='localization'"),'Матрица (владелец)','the owner localization survives');
 assert.equal(revision(file,'film','film:tmdb:603'),2);
 // An explicit free ordinal is taken, a taken one refuses the whole batch, an unknown person refuses it, a removal is explicit.
 await mutateFilm(env,filmInput('film:tmdb:603',2,{credits:{upsert:[{personId:'person:director/d1',role:'director',ordinal:0}]}}));
 const snapshot=rows(file,'SELECT * FROM film_person_credit ORDER BY film_id,role,ordinal');
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',3,{film:{aliases:[{kind:'title',value:'Must not persist'}]},credits:{upsert:[{personId:'person:actor/a3',role:'director',ordinal:0}]}})),error=>error.code==='credit_ordinal_conflict');
 assert.deepEqual(rows(file,'SELECT * FROM film_person_credit ORDER BY film_id,role,ordinal'),snapshot);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_alias WHERE value='Must not persist'"),0,'all or nothing');assert.equal(revision(file,'film','film:tmdb:603'),3);
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',3,{credits:{upsert:[{personId:'person:actor/nobody',role:'actor'}]}})),error=>error.code==='film_person_reference');
 await mutateFilm(env,filmInput('film:tmdb:603',3,{credits:{remove:[{personId:'person:actor/a3',role:'actor'}]}}));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit WHERE person_id='person:actor/a3'"),0);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit WHERE person_id='person:tmdb_actor/t1'"),1,'the D1-only credit is only removed by naming it');
 // Idempotent replay of the same content at the new revision keeps the data and moves the revision once.
 const content=rows(file,'SELECT * FROM film_alias ORDER BY value');
 await mutateFilm(env,filmInput('film:tmdb:603',4));
 assert.deepEqual(rows(file,'SELECT * FROM film_alias ORDER BY value'),content);assert.equal(revision(file,'film','film:tmdb:603'),5);
 // Bounded work: the number of reads does not grow with the roster.
 const queries=db.calls.queries;
 await mutateFilm(env,filmInput('film:tmdb:603',5));
 const small=db.calls.queries-queries;
 const many=Array.from({length:30},(_,index)=>({personId:'person:actor/a1',role:'actor'}));
 const q2=db.calls.queries;
 await mutateFilm(env,filmInput('film:tmdb:603',6,{credits:{upsert:many}}));
 assert.equal(db.calls.queries-q2,small,'reads are constant, not per credit');
}

// 7. Typed ids: tmdb and tmdb_tv are different schemes; a second owner of a trusted id refuses the whole batch.
{
 const file=open();const db=d1Standin(file),env={DB:db};
 await mutateFilm(env,filmInput('film:tmdb:603',0));
 await mutateFilm(env,filmInput('film:tvshow',0,{film:{canonicalIdentity:'tmdb_tv:603',externalIds:[{scheme:'tmdb_tv',value:603,trusted:true}],aliases:[]}}));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_external_id WHERE value='603'"),2,'tmdb 603 and tmdb_tv 603 coexist');
 await assert.rejects(()=>mutateFilm(env,filmInput('film:other',0,{film:{aliases:[{kind:'title',value:'Collision alias'}]}})),error=>error.code==='identity_collision');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:other'"),0);assert.equal(one(file,"SELECT COUNT(*) FROM film_alias WHERE value='Collision alias'"),0);assert.equal(revision(file,'film','film:other'),0);
 // A conflicting (untrusted) holder of the same id is allowed; a conflicting flag never makes an id trusted.
 await mutateFilm(env,filmInput('film:other',0,{film:{canonicalIdentity:null,externalIds:[{scheme:'tmdb',value:603,trusted:true,conflicting:true}],aliases:[]}}));
 assert.equal(one(file,"SELECT trusted FROM film_external_id WHERE film_id='film:other'"),0);
}

// 8. Races: the marker or the entity moves between the read and the write. The batch refuses; nothing persists.
{
 const file=open();
 let hook=null;
 const db=d1Standin(file,{onBatch:async()=>{if(hook){const run=hook;hook=null;run();}}}),env={DB:db};
 await mutateFilm(env,filmInput('film:tmdb:603',0));
 hook=()=>sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',1,{film:{aliases:[{kind:'title',value:'Raced alias'}]}})),error=>error.code==='film_person_fence');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_alias WHERE value='Raced alias'"),0);
 sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");
 // The generation moved while the caller held an older read: refused as a fence, never written.
 hook=()=>sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=5 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=6 WHERE id=1");
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',1)),error=>error.code==='film_person_fence');
 // Another writer bumped the entity between the read and the write.
 hook=()=>sqlite(file,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='film:tmdb:603'");
 await assert.rejects(()=>mutateFilm(env,filmInput('film:tmdb:603',1,{film:{aliases:[{kind:'title',value:'Late alias'}]}})),error=>error.code==='film_person_revision_conflict');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_alias WHERE value='Late alias'"),0);
 assert.equal(revision(file,'film','film:tmdb:603'),2);
 // A crash or an unknown outcome is not retried blindly: the caller reads the revision and decides. The same call at the right revision works.
 await mutateFilm(env,filmInput('film:tmdb:603',2));
 assert.equal(revision(file,'film','film:tmdb:603'),3);
 // The projector never writes the revision: its rows leave canonical_revision as they are.
 assert.equal(one(file,"SELECT COUNT(*) FROM canonical_revision WHERE kind='person'"),0);
}

// 9. A Person: row, ids and aliases; a stale revision refuses; the role id stays unique.
{
 const file=open();const db=d1Standin(file),env={DB:db};
 const input=(id,expectedRevision,roleId,extra={})=>({id,expectedRevision,at:AT,person:{roleId,contractVersion:1,externalIds:[{scheme:'tmdb',value:'6384',trusted:true}],aliases:[{kind:'name',value:'Keanu Reeves'}],...extra}});
 assert.deepEqual(await mutatePerson(env,input('person:actor/a1',0,'actor/a1')),{id:'person:actor/a1',revision:1});
 await assert.rejects(()=>mutatePerson(env,input('person:actor/a1',0,'actor/a1')),error=>error.code==='film_person_revision_conflict');
 await assert.rejects(()=>mutatePerson(env,input('person:actor/a2',0,'actor/a1',{aliases:[{kind:'name',value:'Collision'}]})),error=>error.code==='person_role_collision');
 assert.equal(one(file,"SELECT COUNT(*) FROM person_alias WHERE value='Collision'"),0);
 await mutatePerson(env,input('person:actor/a1',1,'actor/a1',{removeExternalIds:[{scheme:'tmdb',value:'6384'}],externalIds:[]}));
 assert.equal(one(file,'SELECT COUNT(*) FROM person_external_id'),0);assert.equal(revision(file,'person','person:actor/a1'),2);
}

// 10. A merge: two entities, all or nothing; the survivor is not a redirect, no chain or cycle grows; both revisions move.
{
 const file=open();people(file);const db=d1Standin(file),env={DB:db};
 const makeFilm=async(id,identity,ids,credits=[])=>mutateFilm(env,filmInput(id,0,{film:{canonicalIdentity:identity,externalIds:ids,aliases:[{kind:'title',value:'Alias of '+id}]},credits:{upsert:credits}}));
 await makeFilm('film:from','tmdb:1',[{scheme:'tmdb',value:1,trusted:true}],[{personId:'person:actor/a1',role:'actor'},{personId:'person:actor/a2',role:'actor'}]);
 await makeFilm('film:to','tmdb:1b',[{scheme:'letterboxd',value:'lid1',trusted:true}],[{personId:'person:actor/a3',role:'actor'}]);
 sqlite(file,"INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:from','x')");
 const merged=await mergeFilms(env,{from:'film:from',to:'film:to',expected:{from:1,to:1},at:AT,evidence:{verified:true}});
 assert.deepEqual(merged,{merged:true,from:'film:from',to:'film:to',revisions:{from:2,to:2},discarded:[]});
 assert.equal(one(file,"SELECT to_film_id FROM film_redirect WHERE from_id='film:from'"),'film:to');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:from'"),0);
 assert.deepEqual(rows(file,"SELECT person_id,ordinal FROM film_person_credit WHERE film_id='film:to' AND role='actor' ORDER BY ordinal"),[{person_id:'person:actor/a3',ordinal:0},{person_id:'person:actor/a1',ordinal:1},{person_id:'person:actor/a2',ordinal:2}]);
 assert.deepEqual(rows(file,"SELECT scheme,value,trusted FROM film_external_id WHERE film_id='film:to' ORDER BY scheme"),[{scheme:'letterboxd',value:'lid1',trusted:1},{scheme:'tmdb',value:'1',trusted:1}]);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_alias WHERE film_id='film:to'"),2);
 assert.equal(one(file,"SELECT COUNT(*) FROM watchlist_film WHERE film_id='film:to'"),1);
 assert.equal(revision(file,'film','film:to'),2);assert.equal(revision(file,'film','film:from'),2);
 // A repeated merge is a no-op; a different target conflicts; a writer on the retired id is refused (a redirect is not a Film).
 assert.deepEqual(await mergeFilms(env,{from:'film:from',to:'film:to',expected:{from:2,to:2},at:AT}),{merged:false,already:true,from:'film:from',to:'film:to'});
 await makeFilm('film:other','tmdb:9',[{scheme:'tmdb',value:9,trusted:true}]);
 await assert.rejects(()=>mergeFilms(env,{from:'film:from',to:'film:other',expected:{from:2,to:1},at:AT}),error=>error.code==='film_person_redirect_conflict');
 await assert.rejects(()=>mutateFilm(env,filmInput('film:from',2)),error=>error.code==='film_person_redirect');
 // Chains and cycles: the survivor may not be a redirect; a merge into a redirect source or a self merge is refused.
 await assert.rejects(()=>mergeFilms(env,{from:'film:other',to:'film:from',expected:{from:1,to:2},at:AT}),error=>error.code==='film_person_redirect');
 await assert.rejects(()=>mergeFilms(env,{from:'film:other',to:'film:other',expected:{from:1,to:1},at:AT}),error=>error.code==='film_person_invalid');
 // A later merge repoints the existing redirects to the new survivor: no chain longer than one hop.
 await makeFilm('film:last','tmdb:10',[{scheme:'tmdb',value:10,trusted:true}]);
 await mergeFilms(env,{from:'film:to',to:'film:last',expected:{from:2,to:1},at:AT,evidence:{verified:true}});
 assert.deepEqual(rows(file,'SELECT from_id,to_film_id FROM film_redirect ORDER BY from_id'),[{from_id:'film:from',to_film_id:'film:last'},{from_id:'film:to',to_film_id:'film:last'}]);
 // Races inside the merge: a redirect appears on the survivor, or on the retired Film, between the read and the write. The batch re-proves both.
 {
  let hook=null;
  const raced=d1Standin(file,{onBatch:async()=>{if(hook){const run=hook;hook=null;run();}}}),renv={DB:raced};
  await makeFilm('film:x1','tmdb:40',[{scheme:'tmdb',value:40,trusted:true}]);await makeFilm('film:x2','tmdb:41',[{scheme:'tmdb',value:41,trusted:true}]);await makeFilm('film:x3','tmdb:42',[{scheme:'tmdb',value:42,trusted:true}]);
  const state=()=>({redirects:rows(file,'SELECT * FROM film_redirect ORDER BY from_id'),credits:rows(file,'SELECT * FROM film_person_credit ORDER BY film_id,person_id,role'),films:rows(file,'SELECT id FROM film ORDER BY id'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id')});
  hook=()=>sqlite(file,"PRAGMA foreign_keys=OFF;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:x2','film:x3','x')");
  const before=state();
  await assert.rejects(()=>mergeFilms(renv,{from:'film:x1',to:'film:x2',expected:{from:1,to:1},at:AT,evidence:{verified:true}}),error=>error.code==='film_person_precondition','the survivor became a redirect');
  assert.deepEqual(state().films,before.films);assert.deepEqual(state().revisions,before.revisions);
  sqlite(file,"DELETE FROM film_redirect WHERE from_id='film:x2'");
  hook=()=>sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:x1','film:x3','x')");
  await assert.rejects(()=>mergeFilms(renv,{from:'film:x1',to:'film:x2',expected:{from:1,to:1},at:AT,evidence:{verified:true}}),error=>error.code==='film_person_precondition','the retired Film became a redirect');
  sqlite(file,"DELETE FROM film_redirect WHERE from_id='film:x1'");
  assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:x1'"),1);
 }
 // Typed ids: different trusted values of one scheme need verified evidence; tmdb and tmdb_tv are different schemes.
 await makeFilm('film:p','tmdb:20',[{scheme:'tmdb',value:20,trusted:true}]);
 await makeFilm('film:q','tmdb:21',[{scheme:'tmdb',value:21,trusted:true}]);
 await assert.rejects(()=>mergeFilms(env,{from:'film:p',to:'film:q',expected:{from:1,to:1},at:AT}),error=>error.code==='film_person_identity_conflict');
 await makeFilm('film:tv','tmdb_tv:20',[{scheme:'tmdb_tv',value:20,trusted:true}]);
 await mergeFilms(env,{from:'film:p',to:'film:tv',expected:{from:1,to:1},at:AT});
 assert.equal(one(file,"SELECT COUNT(*) FROM film_external_id WHERE film_id='film:tv' AND trusted=1"),2,'tmdb and tmdb_tv both trusted on the survivor');
 // Stale revisions refuse and write nothing.
 await makeFilm('film:r','tmdb:30',[{scheme:'tmdb',value:30,trusted:true}]);await makeFilm('film:s','tmdb:31',[{scheme:'tmdb',value:31,trusted:true}]);
 await assert.rejects(()=>mergeFilms(env,{from:'film:r',to:'film:s',expected:{from:0,to:1},at:AT,evidence:{verified:true}}),error=>error.code==='film_person_revision_conflict');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:r'"),1);
 // A retired Film that belongs to a generation is refused (as the repository does).
 sqlite(file,"INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES ('film:r',1,NULL)");
 await assert.rejects(()=>mergeFilms(env,{from:'film:r',to:'film:s',expected:{from:1,to:1},at:AT,evidence:{verified:true}}),error=>error.code==='film_person_precondition');
 sqlite(file,"DELETE FROM film_epg_last_airing");
 // All or nothing: a late statement refuses (a row elsewhere still references the retired Film), and nothing of the merge persists.
 assert.equal(sqlite(file,"INSERT INTO candidate (observation_key,title,normalized_title,raw_titles_json,durations_json,observation_schema_version,observation_json,seen_in_latest) VALUES ('obs-1','T','t','[]','[]',1,'{}',1);INSERT INTO candidate_decision (observation_key,status,film_id,checked_at) VALUES ('obs-1','accepted','film:r','x')").status,0);
 const snapshot={credits:rows(file,'SELECT * FROM film_person_credit ORDER BY film_id,person_id,role'),ids:rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),aliases:rows(file,'SELECT * FROM film_alias ORDER BY film_id,value'),redirects:rows(file,'SELECT * FROM film_redirect ORDER BY from_id'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id')};
 await assert.rejects(()=>mergeFilms(env,{from:'film:r',to:'film:s',expected:{from:1,to:1},at:AT,evidence:{verified:true}}),error=>error.code==='film_person_reference');
 assert.deepEqual({credits:rows(file,'SELECT * FROM film_person_credit ORDER BY film_id,person_id,role'),ids:rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),aliases:rows(file,'SELECT * FROM film_alias ORDER BY film_id,value'),redirects:rows(file,'SELECT * FROM film_redirect ORDER BY from_id'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id')},snapshot,'a failed merge changes nothing');
}

// 10b. The merge never drops the retired Film's metadata, dimensions or sync clock silently: moved, identical, refused, or an explicit choice.
{
 const file=open();const db=d1Standin(file),env={DB:db};
 const make=async(id,identity,value)=>mutateFilm(env,filmInput(id,0,{film:{canonicalIdentity:identity,externalIds:[{scheme:'tmdb',value,trusted:true}],aliases:[]}}));
 const meta=(film,payload)=>`INSERT INTO film_metadata (film_id,schema_version,genres_json,payload_json,content_sha256,updated_at) VALUES ('${film}',1,'[]','${payload}','sha-${payload}','x')`;
 const dim=(film,dimension,status,value,authority='dictionary')=>`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,updated_at) VALUES ('${film}','${dimension}','${status}','src','1','{}',${value===null?'NULL':"'"+value+"'"},'${authority}',0,'x')`;
 const merge=(from,to,extra={})=>mergeFilms(env,{from,to,expected:{from:1,to:1},at:AT,evidence:{verified:true},...extra});
 const snap=()=>({meta:rows(file,'SELECT film_id,payload_json FROM film_metadata ORDER BY film_id'),dims:rows(file,'SELECT film_id,dimension,status,value,authority FROM film_dimension ORDER BY film_id,dimension'),sync:rows(file,'SELECT film_id FROM film_sync_state ORDER BY film_id'),films:rows(file,'SELECT id FROM film ORDER BY id'),conflicts:rows(file,'SELECT id FROM localization_conflict ORDER BY id'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id')});
 // Retired-only data moves to the survivor.
 await make('film:a1','tmdb:101',101);await make('film:a2','tmdb:102',102);
 sqlite(file,[meta('film:a1','body-a1'),dim('film:a1','localization','reviewed','Название','owner'),dim('film:a1','fingerprint','present','fp-1'),dim('film:a1','prediction','present','p-1'),dim('film:a1','identity','resolved',null),"INSERT INTO film_sync_state (film_id,metadata_at) VALUES ('film:a1','2026-11-01')"].join(';'));
 const first=await merge('film:a1','film:a2');
 assert.deepEqual(first.discarded,[]);
 assert.deepEqual(rows(file,"SELECT film_id,payload_json FROM film_metadata"),[{film_id:'film:a2',payload_json:'body-a1'}]);
 assert.deepEqual(rows(file,"SELECT dimension,value,authority FROM film_dimension WHERE film_id='film:a2' ORDER BY dimension"),[{dimension:'fingerprint',value:'fp-1',authority:'dictionary'},{dimension:'identity',value:null,authority:'dictionary'},{dimension:'localization',value:'Название',authority:'owner'},{dimension:'prediction',value:'p-1',authority:'dictionary'}]);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_dimension WHERE film_id='film:a1'"),0);
 assert.equal(one(file,"SELECT film_id FROM film_sync_state"),'film:a2','the sync clock moves');
 // Identical data on both sides is dropped without a trace; the survivor's identity and sync clock stay.
 await make('film:b1','tmdb:111',111);await make('film:b2','tmdb:112',112);
 sqlite(file,[meta('film:b1','same'),meta('film:b2','same'),dim('film:b1','localization','reviewed','Одно','owner'),dim('film:b2','localization','reviewed','Одно','owner'),dim('film:b1','identity','resolved','same-identity'),dim('film:b2','identity','resolved','same-identity'),"INSERT INTO film_sync_state (film_id,metadata_at) VALUES ('film:b1','2026-10-01T00:00:00.000Z'),('film:b2','2026-11-01T00:00:00.000Z')"].join(';'));
 assert.deepEqual((await merge('film:b1','film:b2')).discarded,[]);
 assert.equal(one(file,"SELECT value FROM film_dimension WHERE film_id='film:b2' AND dimension='identity'"),'same-identity');
 assert.equal(one(file,"SELECT metadata_at FROM film_sync_state WHERE film_id='film:b2'"),'2026-11-01T00:00:00.000Z','an older retired clock is covered by the survivor');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_sync_state WHERE film_id='film:b1'"),0);
 // Different metadata: refused whole without a choice, nothing persisted.
 await make('film:c1','tmdb:121',121);await make('film:c2','tmdb:122',122);
 sqlite(file,[meta('film:c1','retired-body'),meta('film:c2','survivor-body')].join(';'));
 let before=snap();
 await assert.rejects(()=>merge('film:c1','film:c2'),error=>error.code==='film_person_data_conflict');
 assert.deepEqual(snap(),before,'a refused merge changes nothing');
 await assert.rejects(()=>merge('film:c1','film:c2',{resolve:{metadata:'both'}}),error=>error.code==='film_person_invalid');
 const kept=await merge('film:c1','film:c2',{resolve:{metadata:'survivor'}});
 assert.deepEqual(kept.discarded,['metadata:retired']);assert.equal(one(file,"SELECT payload_json FROM film_metadata WHERE film_id='film:c2'"),'survivor-body');
 await make('film:d1','tmdb:131',131);await make('film:d2','tmdb:132',132);
 sqlite(file,[meta('film:d1','retired-body'),meta('film:d2','survivor-body')].join(';'));
 const swapped=await merge('film:d1','film:d2',{resolve:{metadata:'retired'}});
 assert.deepEqual(swapped.discarded,['metadata:survivor']);assert.equal(one(file,"SELECT payload_json FROM film_metadata WHERE film_id='film:d2'"),'retired-body');
 // Localization: an automatic retired value loses to the survivor and is recorded; a reviewed or owner retired value is refused unless chosen.
 await make('film:e1','tmdb:141',141);await make('film:e2','tmdb:142',142);
 sqlite(file,[dim('film:e1','localization','provisional','Авто','automatic'),dim('film:e2','localization','reviewed','Владелец','owner')].join(';'));
 await merge('film:e1','film:e2');
 assert.equal(one(file,"SELECT value FROM film_dimension WHERE film_id='film:e2' AND dimension='localization'"),'Владелец');
 assert.deepEqual(rows(file,"SELECT reason,value,entity_id FROM localization_conflict WHERE entity_id='film:e2'"),[{reason:'merge_kept_survivor',value:'Авто',entity_id:'film:e2'}]);
 await make('film:f1','tmdb:151',151);await make('film:f2','tmdb:152',152);
 sqlite(file,[dim('film:f1','localization','reviewed','Владелец ушедший','owner'),dim('film:f2','localization','provisional','Авто','automatic')].join(';'));
 before=snap();
 await assert.rejects(()=>merge('film:f1','film:f2'),error=>error.code==='film_person_data_conflict','an owner value the survivor would not keep');
 assert.deepEqual(snap(),before);
 const owner=await merge('film:f1','film:f2',{resolve:{localization:'retired'}});
 assert.deepEqual(owner.discarded,['localization:survivor']);
 assert.deepEqual(rows(file,"SELECT value,authority FROM film_dimension WHERE film_id='film:f2' AND dimension='localization'"),[{value:'Владелец ушедший',authority:'owner'}]);
 assert.equal(one(file,"SELECT COUNT(*) FROM localization_conflict WHERE reason='merge_kept_retired'"),1);
 await make('film:g1','tmdb:161',161);await make('film:g2','tmdb:162',162);
 sqlite(file,[dim('film:g1','localization','reviewed','Один','owner'),dim('film:g2','localization','reviewed','Другой','owner')].join(';'));
 await assert.rejects(()=>merge('film:g1','film:g2'),error=>error.code==='film_person_data_conflict','two different owner values');
 const both=await merge('film:g1','film:g2',{resolve:{localization:'survivor'}});
 assert.deepEqual(both.discarded,['localization:retired']);
 // Fingerprint and prediction rows: refused when different unless chosen.
 await make('film:h1','tmdb:171',171);await make('film:h2','tmdb:172',172);
 sqlite(file,[dim('film:h1','prediction','present','p-retired'),dim('film:h2','prediction','present','p-survivor')].join(';'));
 await assert.rejects(()=>merge('film:h1','film:h2'),error=>error.code==='film_person_data_conflict');
 assert.deepEqual((await merge('film:h1','film:h2',{resolve:{prediction:'survivor'}})).discarded,['prediction:retired']);

 // Identity and metadata lifecycle rows carry source versions and provenance: different ones are refused until a side is named.
 await make('film:i1','tmdb:181',181);await make('film:i2','tmdb:182',182);
 sqlite(file,[dim('film:i1','identity','resolved','retired-identity'),dim('film:i2','identity','resolved','survivor-identity'),dim('film:i1','metadata','present','retired-state'),dim('film:i2','metadata','present','survivor-state')].join(';'));
 before=snap();
 await assert.rejects(()=>merge('film:i1','film:i2'),error=>error.code==='film_person_data_conflict','different identity provenance');
 await assert.rejects(()=>merge('film:i1','film:i2',{resolve:{identity:'survivor'}}),error=>error.code==='film_person_data_conflict','the metadata lifecycle row still differs');
 assert.deepEqual(snap(),before);
 const lifecycle=await merge('film:i1','film:i2',{resolve:{identity:'survivor',metadataState:'retired'}});
 assert.deepEqual(lifecycle.discarded,['identity:retired','metadata:survivor']);
 assert.deepEqual(rows(file,"SELECT dimension,value FROM film_dimension WHERE film_id='film:i2' AND dimension IN ('identity','metadata') ORDER BY dimension"),[{dimension:'identity',value:'survivor-identity'},{dimension:'metadata',value:'retired-state'}]);
 // Sync clocks: only a retired row that adds nothing is dropped. A newer, complementary or non-null retired clock against a null one is refused.
 const clocks=(film,fields)=>`INSERT INTO film_sync_state (film_id,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at) VALUES ('${film}',${fields.map(value=>value===null?'NULL':typeof value==='number'?value:"'"+value+"'").join(',')})`;
 const T1='2026-10-01T00:00:00.000Z',T2='2026-11-01T00:00:00.000Z';
 const syncCase=async(label,retired,survivor,{resolve,expect})=>{
  await make('film:'+label+'1','tmdb:'+label+'1',label+'1');await make('film:'+label+'2','tmdb:'+label+'2',label+'2');
  sqlite(file,[clocks('film:'+label+'1',retired),clocks('film:'+label+'2',survivor)].join(';'));
  const state=()=>rows(file,"SELECT film_id,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state WHERE film_id LIKE 'film:"+label+"%' ORDER BY film_id");
  const before=state();
  if(expect==='refuse'&&!resolve){
   await assert.rejects(()=>merge('film:'+label+'1','film:'+label+'2'),error=>error.code==='film_person_data_conflict',label);
   assert.deepEqual(state(),before,label+': nothing persisted');
   return null;
  }
  return merge('film:'+label+'1','film:'+label+'2',resolve?{resolve:{sync:resolve}}:{});
 };
 // Covered: the survivor is newer, the retired row is all null, equal values.
 assert.deepEqual((await syncCase('s1',[T1,T1,1,T1],[T2,T2,2,T2],{expect:'drop'})).discarded,[]);
 assert.deepEqual((await syncCase('s2',[null,null,null,null],[T2,null,2,null],{expect:'drop'})).discarded,[]);
 assert.equal(one(file,"SELECT metadata_at FROM film_sync_state WHERE film_id='film:s22'"),T2);
 // Refused: the retired clock is newer, complementary, or the survivor's row holds only nulls (a missing row and null clocks differ, ADR 0070).
 await syncCase('s3',[T2,T2,2,T2],[T1,T1,1,T1],{expect:'refuse'});
 await syncCase('s4',[null,T2,null,null],[T1,null,null,null],{expect:'refuse'});
 await syncCase('s5',[T1,null,null,null],[null,null,null,null],{expect:'refuse'});
 assert.deepEqual((await syncCase('s6',[T2,T2,2,T2],[T1,T1,1,T1],{resolve:'survivor'})).discarded,['sync:retired']);
 assert.equal(one(file,"SELECT metadata_at FROM film_sync_state WHERE film_id='film:s62'"),T1);
 assert.deepEqual((await syncCase('s7',[T2,T2,2,T2],[T1,T1,1,T1],{resolve:'retired'})).discarded,['sync:survivor']);
 assert.equal(one(file,"SELECT metadata_at FROM film_sync_state WHERE film_id='film:s72'"),T2);
 assert.deepEqual((await syncCase('s8',[null,T2,null,null],[T1,null,3,null],{resolve:'newest'})).discarded,['sync:merged']);
 assert.deepEqual(rows(file,"SELECT metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state WHERE film_id='film:s82'"),[{metadata_at:T1,synopsis_fetched_at:T2,people_names_version:3,people_localized_at:null}]);
 await assert.rejects(()=>merge('film:s91','film:s92',{resolve:{sync:'both'}}),error=>['film_person_invalid','film_person_reference'].includes(error.code));
 // A body that comes from the retired Film cannot keep the survivor's clocks silently: both clock rows differ, so a side must be named.
 await make('film:m1','tmdb:191',191);await make('film:m2','tmdb:192',192);
 sqlite(file,[meta('film:m1','moved-body'),clocks('film:m1',[T1,T1,1,T1]),clocks('film:m2',[T2,T2,2,T2])].join(';'));
 before=snap();
 await assert.rejects(()=>merge('film:m1','film:m2'),error=>error.code==='film_person_data_conflict','a retired body with different clocks');
 assert.deepEqual(snap(),before);
 assert.deepEqual((await merge('film:m1','film:m2',{resolve:{sync:'retired'}})).discarded,['sync:survivor']);
 assert.equal(one(file,"SELECT payload_json FROM film_metadata WHERE film_id='film:m2'"),'moved-body');
}

// 10c. The fence row cannot be bypassed: if it (or the marker) vanishes between the read and the write, every assertion fails inside the batch.
{
 const attempt=async(label,prepare,run)=>{
  const file=open();people(file);
  let armed=false;
  const db=d1Standin(file,{onBatch:async()=>{if(armed){armed=false;sqlite(file,prepare);}}}),env={DB:db};
  await mutateFilm(env,filmInput('film:tmdb:603',0));
  await mutateFilm(env,filmInput('film:tmdb:700',0,{film:{canonicalIdentity:'tmdb:700',externalIds:[{scheme:'tmdb',value:700,trusted:true}],aliases:[]}}));
  const before={films:rows(file,'SELECT id FROM film ORDER BY id'),aliases:rows(file,'SELECT * FROM film_alias ORDER BY film_id,value'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id'),redirects:rows(file,'SELECT * FROM film_redirect')};
  armed=true;
  await assert.rejects(()=>run(env),error=>['film_person_fence','film_person_unavailable','film_person_precondition'].includes(error.code),label);
  assert.deepEqual({films:rows(file,'SELECT id FROM film ORDER BY id'),aliases:rows(file,'SELECT * FROM film_alias ORDER BY film_id,value'),revisions:rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id'),redirects:rows(file,'SELECT * FROM film_redirect')},before,label+': nothing persisted');
 };
 const drop='DROP TRIGGER film_person_cas_no_delete;DELETE FROM film_person_cas';
 await attempt('fence row deleted before a film mutation',drop,env=>mutateFilm(env,filmInput('film:tmdb:603',1,{film:{aliases:[{kind:'title',value:'Late alias'}]}})));
 await attempt('fence row deleted before a person mutation',drop,env=>mutatePerson(env,{id:'person:actor/a1',expectedRevision:0,at:AT,person:{roleId:'actor/a1',contractVersion:1,aliases:[{kind:'name',value:'Late'}]}}));
 await attempt('fence row deleted before a merge',drop,env=>mergeFilms(env,{from:'film:tmdb:603',to:'film:tmdb:700',expected:{from:1,to:1},at:AT,evidence:{verified:true}}));
 await attempt('marker row deleted before a film mutation','DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority',env=>mutateFilm(env,filmInput('film:tmdb:603',1,{film:{aliases:[{kind:'title',value:'Late alias'}]}})));
 // The marker move has the same property.
 const file=database();sqlite(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1");
 let armed=true;
 const env={DB:d1Standin(file,{onBatch:async()=>{if(armed){armed=false;sqlite(file,drop);}}})};
 await assert.rejects(()=>Authority.transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:0}),error=>['film_person_fence','film_person_unavailable'].includes(error.code));
 assert.deepEqual(rows(file,'SELECT mode,generation FROM film_person_authority'),[{mode:'r2',generation:0}],'the marker did not move without a fence');
 // And a generation that moved under the caller refuses the move, with the fence row intact.
 const file2=database();sqlite(file2,"UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1");
 let moved=true;
 const env2={DB:d1Standin(file2,{onBatch:async()=>{if(moved){moved=false;sqlite(file2,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");}}})};
 await assert.rejects(()=>Authority.transitionAuthority(env2,{from:'r2',to:'prepared',expectedGeneration:0}),error=>error.code==='film_person_fence');
 assert.equal(one(file2,'SELECT generation FROM film_person_authority'),1);
}

// 11. The foundation stays inactive: it is not bundled, not imported by the Worker, and writes nothing it does not own.
{
 const mutations=fs.readFileSync('src/canonical-mutations.js','utf8'),authority=fs.readFileSync('src/film-person-authority.js','utf8');
 // AIR-409: only the marker READER is bundled (the catalog film route gates its R2 receipt fallback on it); no mutation module is.
 // AIR-374 P3c: the Discovery admission unit needs the fenced writer, so build.mjs carries it in ONE named scope and nowhere else.
 { const build=fs.readFileSync('build.mjs','utf8'); assert.equal(build.split('src/canonical-mutations.js').length-1,1); assert.ok(build.includes("scopedImports('src/canonical-mutations.js','CanonicalMutations'")); }
 for(const file of ['src/worker.js','src/d1-enrichment.js','src/canonical-repository.js','src/catalog-d1.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/canonical-mutations/,file);
 for(const file of ['src/d1-enrichment.js','src/canonical-repository.js','src/catalog-d1.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-person-authority/,file);
 assert.match(fs.readFileSync('src/worker.js','utf8'),/FilmPersonAuthority\.readAuthority/);
 assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/FilmPersonAuthority\.(assertWritable|transitionAuthority)/,'the Worker reads the marker, it never writes or moves it');
 assert.doesNotMatch(mutations+authority,/\bBUCKET\b|\bfetch\b|wrangler/);
 const roster=mutations.slice(0,mutations.indexOf('export async function mergeFilms'));
 assert.doesNotMatch(roster,/INSERT INTO film_dimension|UPDATE film_dimension|INSERT INTO person_dimension|INSERT INTO film_metadata|UPDATE film_metadata|UPDATE watchlist_film/,'a film or person write touches no localization, dimension, metadata or prediction');
 assert.doesNotMatch(mutations,/INSERT INTO film_dimension|INSERT INTO person_dimension|INSERT INTO film_metadata/,'nothing is created: a merge only moves what exists');
 assert.doesNotMatch(mutations,/DELETE FROM film_person_credit WHERE film_id=\?'\s*,\s*\[id\]/,'no roster delete-and-reinsert');
 assert.match(fs.readFileSync('migrations/README.md','utf8'),/0013_film_person_authority/);
}
console.log('film-person-authority: migration 0013 refuses below v12 and seeds r2; the state machine and the baseline gate hold in SQL and code; reads fail closed from v13 and never name R2 for held; mutations refuse unless open at the read generation, prove the entity revisions, are all or nothing, never renumber credits, keep D1-only credits and owner values, and merges leave no chain; the foundation is not bundled');
