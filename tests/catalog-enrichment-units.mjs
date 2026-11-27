// AIR-605: the receipted units of the Catalog Enrichment Producer (src/catalog-enrichment-units.js; ADR 0211 decision 3, ADR 0219 decisions 7 and 8) on the real migrated schema through the sqlite3-CLI D1 stand-in.
// Covered: the keyed reconcile-then-reserve protocol for each unit kind, noop and settled answers, guards INSIDE the batch (a stale plan writes nothing and its receipt is abandoned by the retry), Person units and the credits
// order (Persons first), concurrent writers of one unit, a closed route, and the durable logical-unit generation when a key reaches the receipt history cap. Synthetic ids only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as U from '../src/catalog-enrichment-units.js';
import {createGateReuse} from '../src/film-person-authority.js';
import {blankFieldGuard} from '../src/catalog-enrichment-plan.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-units-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function world(stage='open'){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 assert.equal(sqlite(file,VERIFY).status,0);
 if(stage!=='r2')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'){
  assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
  assert.equal(sqlite(file,BASELINE).status,0);
 }
 // AIR-688: GATE_REUSE=1 runs this whole suite with the drain's gate scope on every env (tests/catalog-enrichment-units-scoped.mjs), so the real Person, credit, replay, lost-response and concurrent paths are exercised scoped.
 return {file,env:{DB:d1Standin(file),...(process.env.GATE_REUSE==='1'?{gateReuse:createGateReuse()}:{})}};
}
const T='2026-11-26T10:00:00.000Z';
const at=s=>new Date(Date.parse(T)+s*1000).toISOString();
const clock=()=>{let i=0;return ()=>at(i++);};
const seedFilm=(file,id='film:tmdb:1')=>assert.equal(sqlite(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',2,NULL,'Kept','${T}');INSERT INTO film_external_id VALUES ('${id}','tmdb','${id.split(':').pop()}',1,0,NULL);`).status,0);
const facts=(over={})=>({id:'film:tmdb:1',at:T,film:{contractVersion:2},metadata:{updatedAt:T,year:1999},requireExisting:true,...over});
const metaOf=(file,id='film:tmdb:1')=>rows(file,`SELECT year,runtime FROM film_metadata WHERE film_id='${id}'`)[0]||null;
const receipts=(file,key)=>rows(file,`SELECT request_id,state,error_class,operation_key,content_digest FROM canonical_write_receipt WHERE operation_key='${key}' ORDER BY created_at,request_id`);
const KEY=U.unitKeys.core('film:tmdb:1');
assert.equal(KEY,'enrich:film:tmdb:1:core');
assert.deepEqual([U.unitKeys.localization('film:a','tmdb'),U.unitKeys.credits('film:a','tmdb',2),U.unitKeys.person('person:tmdb_actor/5')],['enrich:film:a:localization:tmdb','enrich:film:a:credits:tmdb:2','enrich:person:person:tmdb_actor/5']);

// ---- a closed route writes nothing ----
{
 const held=world('prepared');seedFilm(held.file);
 await assert.rejects(()=>U.runUnit(held.env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()}),error=>/film_person_(unavailable|held)/.test(error.code),'a producer defers below open, it never falls back');
 const {file,env}=world('r2');seedFilm(file);
 const closed=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()}).catch(error=>({error:error.code}));
 assert.ok(closed.state==='skipped'||/film_person_(unavailable|held)/.test(closed.error),'below open: skipped or deferred, never written');
 assert.equal(metaOf(file),null);
}

// ---- core: apply, settle, replan under the same key, a Film that is not there ----
{
 const {file,env}=world();seedFilm(file);
 const first=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()});
 assert.equal(first.state,'applied');assert.deepEqual(metaOf(file),{year:1999,runtime:null});
 const list=receipts(file,KEY);
 assert.deepEqual(list.map(r=>r.state),['applied'],'one keyed receipt, applied');
 const second=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()});
 assert.equal(second.state,'settled','the same digest whose effect is in place is settled: nothing is written');
 assert.equal(receipts(file,KEY).length,1);
 // a replan keeps the key and changes the digest: a new reservation under the same key
 const third=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts({metadata:{updatedAt:T,year:1999,runtime:100}}),now:clock()});
 assert.equal(third.state,'applied');assert.deepEqual(metaOf(file),{year:1999,runtime:100});
 assert.deepEqual(receipts(file,KEY).map(r=>r.state),['applied','applied']);
 assert.notEqual(receipts(file,KEY)[0].content_digest,receipts(file,KEY)[1].content_digest);
 assert.equal(receipts(file,KEY)[0].request_id===receipts(file,KEY)[1].request_id,false,'a new history ordinal gives a new request id');
 // a missing Film is never created
 const absent=await U.runUnit(env,{kind:'facts',unitKey:U.unitKeys.core('film:tmdb:9'),input:facts({id:'film:tmdb:9'}),now:clock()}).catch(error=>({error:error.code}));
 assert.ok(absent.state==='absent'||absent.error==='film_person_precondition','a Film that is not in the store is refused before any receipt');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:9'")[0].n,0);
}

// ---- guards inside the batch: a stale plan writes nothing, its receipt is abandoned by the retry ----
{
 const {file,env}=world();seedFilm(file);
 const stale={sql:'EXISTS (SELECT 1 FROM film WHERE id=?)',params:['film:tmdb:404']};
 await assert.rejects(()=>U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts({guards:[stale]}),now:clock()}));
 assert.equal(metaOf(file),null,'the failing guard rolled the whole batch back');
 assert.deepEqual(receipts(file,KEY).map(r=>r.state),['failed'],'the receipt of the refused attempt is failed, never applied');
 const retry=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts({guards:[blankFieldGuard('film:tmdb:1','year')]}),now:clock()});
 assert.equal(retry.state,'applied');
 assert.deepEqual(receipts(file,KEY).map(r=>[r.state,r.error_class]),[['abandoned','superseded_by_retry'],['applied',null]],'the protocol abandons the unresolved receipt of the old plan before it reserves a new one');
 assert.deepEqual(metaOf(file),{year:1999,runtime:null});
 // the fill-only guard: a value that appeared after the plan makes the batch fail
 const filled=world();seedFilm(filled.file);
 assert.equal(sqlite(filled.file,`INSERT INTO film_metadata (film_id,schema_version,year,genres_json,payload_json,updated_at) VALUES ('film:tmdb:1',1,2005,'[]','{}','${T}');`).status,0);
 await assert.rejects(()=>U.runUnit(filled.env,{kind:'facts',unitKey:KEY,input:facts({guards:[blankFieldGuard('film:tmdb:1','year')]}),now:clock()}));
 assert.deepEqual(metaOf(filled.file),{year:2005,runtime:null},'fill-only: the stored value was not overwritten');
}

// ---- persons first, then credits; the same Person from two Films ----
{
 const {file,env}=world();seedFilm(file);seedFilm(file,'film:tmdb:2');
 const person=id=>({id,at:T,person:{roleId:id.slice('person:'.length),contractVersion:2,externalIds:[{scheme:'tmdb_person',value:id.split('/')[1],trusted:true,conflicting:false}]}});
 const credits=(film,ids)=>({id:film,at:T,credits:ids.map(personId=>({personId,role:'actor'}))});
 // a credit whose Person is missing is refused by the database order, no receipt content is applied
 await assert.rejects(()=>U.runUnit(env,{kind:'credits',unitKey:U.unitKeys.credits('film:tmdb:1','tmdb',0),input:credits('film:tmdb:1',['person:tmdb_actor/1']),now:clock()}),error=>error.code==='film_person_reference');
 const p1=await U.runUnit(env,{kind:'person',unitKey:U.unitKeys.person('person:tmdb_actor/1'),input:person('person:tmdb_actor/1'),now:clock()});
 assert.equal(p1.state,'applied');
 const c1=await U.runUnit(env,{kind:'credits',unitKey:U.unitKeys.credits('film:tmdb:1','tmdb',0),input:credits('film:tmdb:1',['person:tmdb_actor/1']),now:clock()});
 assert.equal(c1.state,'applied');
 assert.deepEqual(rows(file,"SELECT film_id,person_id,role,ordinal FROM film_person_credit"),[{film_id:'film:tmdb:1',person_id:'person:tmdb_actor/1',role:'actor',ordinal:0}]);
 // the second Film needs the same Person: it exists, so the unit is a no-op with no receipt
 const again=await U.runUnit(env,{kind:'person',unitKey:U.unitKeys.person('person:tmdb_actor/1'),input:person('person:tmdb_actor/1'),now:clock()});
 assert.ok(['noop','settled'].includes(again.state),'a Person that exists is not written again, however many Films need it');
 const c2=await U.runUnit(env,{kind:'credits',unitKey:U.unitKeys.credits('film:tmdb:2','tmdb',0),input:credits('film:tmdb:2',['person:tmdb_actor/1']),now:clock()});
 assert.equal(c2.state,'applied');assert.equal(rows(file,'SELECT COUNT(*) AS n FROM person')[0].n,1,'one Person, two Films');
 // add-only: a second chunk appends after the highest ordinal and removes nothing
 await U.runUnit(env,{kind:'person',unitKey:U.unitKeys.person('person:tmdb_actor/2'),input:person('person:tmdb_actor/2'),now:clock()});
 await U.runUnit(env,{kind:'credits',unitKey:U.unitKeys.credits('film:tmdb:1','tmdb',1),input:credits('film:tmdb:1',['person:tmdb_actor/2']),now:clock()});
 assert.deepEqual(rows(file,"SELECT person_id,ordinal FROM film_person_credit WHERE film_id='film:tmdb:1' ORDER BY ordinal"),[{person_id:'person:tmdb_actor/1',ordinal:0},{person_id:'person:tmdb_actor/2',ordinal:1}]);
 // a stale Person unit is refused by its guard and writes nothing
 const stalePerson=person('person:tmdb_actor/3');stalePerson.guards=[{sql:'EXISTS (SELECT 1 FROM film WHERE id=?)',params:['film:none']}];
 await assert.rejects(()=>U.runUnit(env,{kind:'person',unitKey:U.unitKeys.person('person:tmdb_actor/3'),input:stalePerson,now:clock()}));
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM person WHERE id='person:tmdb_actor/3'")[0].n,0,'no Person is written for an invalidated plan');
}

// ---- concurrent writers of one unit: one reservation, the other waits or finds nothing to do ----
{
 const {file,env}=world();seedFilm(file);
 const [a,b]=await Promise.all([0,1].map(i=>U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()}).catch(error=>({state:'error',code:error.code}))));
 assert.equal([a,b].filter(r=>r.state==='applied').length,1,'exactly one applies');
 assert.deepEqual(metaOf(file),{year:1999,runtime:null});
 assert.equal(receipts(file,KEY).filter(r=>r.state==='applied').length,1);
}

// ---- the durable unit generation: a key at the history cap rolls, never stops for good ----
{
 const {file,env}=world();seedFilm(file);
 const old=i=>`INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,applied_revision,marker_generation,state,attempts,next_attempt_at,error_class,created_at,updated_at,settled_at,operation_key) VALUES ('old-${i}','film_facts','catalog_enrichment','film','film:tmdb:1','${String(i).padStart(64,'0')}',0,NULL,2,'pending',1,'2099-01-01T00:00:00.000Z',NULL,'2026-11-01T00:00:00.${String(i).padStart(3,'0')}Z','${T}',NULL,'${KEY}');UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,settled_at='${T}' WHERE request_id='old-${i}';`;
 const insert=Array.from({length:100},(_,i)=>old(i)).join('');
 {const r=sqlite(file,insert);assert.equal(r.status,0,String(r.stderr).slice(0,300));}
 assert.deepEqual(await U.readGeneration(env,KEY),{generation:0,fingerprint:null});
 const result=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()});
 assert.equal(result.state,'applied','the unit continues under the next generation');
 assert.equal(result.key,KEY+':g1');
 assert.equal((await U.readGeneration(env,KEY)).generation,1);
 assert.equal(receipts(file,KEY).length,100,'the old history is retained');
 assert.equal(receipts(file,KEY+':g1').length,1,'the new key starts with an empty history');
 const replay=await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()});
 assert.equal(replay.state,'settled','a replay reuses the recorded generation and never recomputes it');
 assert.equal((await U.readGeneration(env,KEY)).generation,1);
 // an unresolved receipt is reconciled first and the history never bypassed: the cap is reached with one pending receipt
 const other=world();seedFilm(other.file);
 assert.equal(sqlite(other.file,insert.replace("'abandoned',1,NULL,'superseded_by_retry'","'abandoned',1,NULL,'superseded_by_retry'")).status,0);
 // the generation CAS: a lost race rolls nothing twice
 const first=await U.rollGeneration(other.env,{unitKey:KEY,generation:0,fingerprint:'100:0',at:T});
 const second=await U.rollGeneration(other.env,{unitKey:KEY,generation:0,fingerprint:'100:0',at:T});
 assert.equal(first,1);assert.equal(second,null,'a concurrent writer cannot roll the unit twice');
}

// ---- AIR-688 review P1: a warmed gate scope never authorizes a unit that executes no fenced batch ----
// The scope is warmed by a real applied unit, the marker moves to held, and the next unit is one whose effect is already in place (a settled replay, a fresh noop). The routing read is fresh, so nothing is settled, no
// receipt or state moves, and after the reopen (a new generation) the same unit settles normally.
{
 const {file,env}=world();seedFilm(file);
 env.gateReuse=createGateReuse({ttlMs:60000});
 assert.equal((await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()})).state,'applied');
 assert.ok(env.gateReuse.gate,'the applied unit warmed the scope');
 const before=JSON.stringify([receipts(file,KEY),metaOf(file)]);
 assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 await assert.rejects(()=>U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()}),error=>error.code==='film_person_held','settled replay on a held marker');
 await assert.rejects(()=>U.runUnit(env,{kind:'facts',unitKey:U.unitKeys.core('film:tmdb:1'),input:facts({metadata:{updatedAt:T,year:1999}}),now:clock()}),error=>error.code==='film_person_held','fresh noop on a held marker');
 assert.equal(JSON.stringify([receipts(file,KEY),metaOf(file)]),before,'nothing settled or written while held');
 assert.equal(env.gateReuse.gate,null,'a non-open routing read clears the scope');
 assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1").status,0);
 assert.equal((await U.runUnit(env,{kind:'facts',unitKey:KEY,input:facts(),now:clock()})).state,'settled','normal recovery after the reopen');
 assert.equal(env.gateReuse.gate.generation,4,'the routing read refreshed the scope to the new generation');
}
console.log('catalog enrichment units: ok');
