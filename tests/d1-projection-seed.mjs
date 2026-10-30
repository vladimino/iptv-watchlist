// AIR-275 phase 2 / ADR 0056: seeding production D1 with a snapshot's change keys through the D1 HTTP API. A fake fetch serves
// the real backfill adapter from a sqlite3 file. Covered: the plan writes nothing; apply writes in bounded idempotent chunks and
// verifies exactly; a rerun writes nothing; an interrupted run is finished by the next; D1-only people get no key and stay; and
// every fence (identity, partial schema, baseline, live projector lease, missing entity, conflicting or foreign keys) stops
// before any key is written; the seed holds the projector's lease and fences every chunk with it.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';
import {seedProjectionD1} from '../scripts/d1-projection-seed.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-projection-seed-'));
const UUID='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',BASELINE='a'.repeat(64),T='2026-10-29T19:58:26.568Z';
const target={accountId:'0'.repeat(32),apiToken:'test',databaseId:UUID,databaseName:'iptv',endpoint:'https://d1.test/client/v4',maxBatchStatements:1000,maxBatchBytes:1<<20};
const sqlite=(file,sql,json=false)=>{const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return json?(result.stdout.trim()?JSON.parse(result.stdout):[]):result.stdout;};
let files=0;
function database({migrations=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state']}={}){
 const file=path.join(root,'d1-'+(files++)+'.sqlite');
 for(const name of migrations)sqlite(file,fs.readFileSync('migrations/'+name+'.sql','utf8'));
 sqlite(file,`INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('manifest.json','${BASELINE}','database','sqlite:build','${T}');
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',1,NULL,'A','${T}'),('film:b',1,NULL,'B','${T}');
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/x','actor/x',1,'${T}'),('person:tmdb_actor/9','tmdb_actor/9',1,'${T}');
INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:a','${T}');
INSERT INTO film_person_credit VALUES ('film:a','person:actor/x','actor',0),('film:a','person:tmdb_actor/9','actor',1);`);
 return file;
}
// The fake Cloudflare API: GET describes the database, POST /query runs one statement.
// A write request may carry several statements; it runs as one transaction, as the AIR-74 atomicity probe proved for D1.
// onWrite runs before a write is applied, to let another actor act in between.
function api(file,{name='iptv',uuid=UUID,failWrite=0,onWrite=null}={}){
 const calls={writes:0,reads:0};
 const fetchImpl=async(url,init)=>{
  if(init.method==='GET')return Response.json({success:true,result:{uuid,name}});
  const sql=JSON.parse(init.body).sql,write=/^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
  if(write){calls.writes++;if(failWrite&&calls.writes===failWrite)throw new TypeError('connection reset');if(onWrite)await onWrite(calls.writes,sql);}else calls.reads++;
  try{return Response.json({success:true,result:[{success:true,results:write?(sqlite(file,'BEGIN;\n'+sql+'\nCOMMIT;'),[]):sqlite(file,sql,true)}]});}
  catch(error){return Response.json({success:false,errors:[{message:String(error.message)}]},{status:400});}
 };
 return {calls,adapter:createD1Adapter({target,databaseId:UUID,fetchImpl,retries:0,sleep:async()=>{}})};
}
const plan={at:T,aggregateSha256:BASELINE,keys:[{kind:'person',id:'person:actor/x',key:'kx'},{kind:'film',id:'film:a',key:'ka'},{kind:'film',id:'film:b',key:"kb'quote"}]};
const state=file=>sqlite(file,"SELECT name FROM sqlite_master WHERE name='projection_state'",true).length?sqlite(file,"SELECT kind||':'||id||'='||change_key AS row FROM projection_state ORDER BY kind,id",true).map(row=>row.row):[];
const credits=file=>sqlite(file,"SELECT COUNT(*) AS n FROM film_person_credit",true)[0].n;

// 1. The plan reads only and reports the D1-only person that gets no key.
const file=database();
{
 const {adapter,calls}=api(file);
 const report=await seedProjectionD1(adapter,target,plan);
 assert.deepEqual([report.outcome,report.planned,report.pending,report.dOnlyPeople,report.apply],['plan',3,3,1,false]);
 assert.equal(calls.writes,0);assert.deepEqual(state(file),[]);
}

// 2. Apply in chunks of two: the lease, two fenced chunk batches, the release, then an exact read-back. A rerun writes nothing.
{
 const {adapter,calls}=api(file);
 const report=await seedProjectionD1(adapter,target,plan,{apply:true,chunkRows:2});
 assert.deepEqual([report.outcome,report.written,report.requests,report.stored],['verified',3,2,3]);
 assert.equal(calls.writes,4);
 assert.deepEqual(sqlite(file,"SELECT lease_id,lease_until,outcome FROM projection_run",true),[{lease_id:null,lease_until:null,outcome:'seeded'}],'the lease is released');
 assert.equal(sqlite(file,'SELECT COUNT(*) AS n FROM projection_fence',true)[0].n,0);
 assert.deepEqual(state(file),["film:film:a=ka","film:film:b=kb'quote","person:person:actor/x=kx"]);
 assert.equal(credits(file),2,'the AIR-286 style D1-only credit stays');
 const again=await seedProjectionD1(api(file).adapter,target,plan,{apply:true,chunkRows:2});
 assert.deepEqual([again.outcome,again.pending,again.written,again.alreadyStored],['verified',0,0,3]);
}

// 3. An interrupted run: the failed write is not retried and the run stops; the next run finishes it. Write 1 is the lease,
// write 2 the first chunk and write 3 the second, which fails in transit.
{
 const interrupted=database();
 const {adapter}=api(interrupted,{failWrite:3});
 await assert.rejects(seedProjectionD1(adapter,target,plan,{apply:true,chunkRows:2}),error=>error.kind==='write_uncertain');
 assert.equal(state(interrupted).length,2);
 const done=await seedProjectionD1(api(interrupted).adapter,target,plan,{apply:true,chunkRows:2});
 assert.deepEqual([done.outcome,done.pending,done.stored],['verified',1,3]);
}

// 4. Every fence stops before any write.
// A fence that fails after the lease was taken writes only the lease and its release, never a key.
const stops=async(file,options,reason,planned=plan)=>{
 const {adapter,calls}=api(file,options);
 const before=state(file);
 await assert.rejects(seedProjectionD1(adapter,target,planned,{apply:true}),error=>error.reason===reason,reason);
 assert.ok(calls.writes<=2,reason);assert.deepEqual(state(file),before,reason);
 if(sqlite(file,"SELECT name FROM sqlite_master WHERE name='projection_run'",true).length&&reason!=='lease_held')assert.deepEqual(sqlite(file,"SELECT lease_id FROM projection_run WHERE lease_id LIKE 'seed:%'",true),[],reason+': lease released');
};
await stops(database(),{name:'iptv-scratch'},'target_identity_mismatch');
await stops(database(),{uuid:'00000000-0000-0000-0000-000000000000'},'target_identity_mismatch');
await stops(database({migrations:['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity']}),{},'schema_not_v4');
{const partial=database();sqlite(partial,'DROP TABLE projection_fence');await stops(partial,{},'schema_not_v4');}
{const partial=database();sqlite(partial,'UPDATE schema_contract SET version=3');await stops(partial,{},'schema_not_v4');}
await stops(database(),{},'baseline_mismatch',{...plan,aggregateSha256:'b'.repeat(64)});
{const running=database();sqlite(running,`INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('enrichment','x','${new Date(Date.now()+60000).toISOString()}')`);await stops(running,{},'lease_held');
 await assert.rejects(seedProjectionD1(api(running).adapter,target,plan),error=>error.reason==='lease_held','the plan reports a live lease too');}
await stops(database(),{},'entity_missing',{...plan,keys:[...plan.keys,{kind:'film',id:'film:nowhere',key:'kn'}]});
{const conflict=database();sqlite(conflict,`INSERT INTO projection_state VALUES ('enrichment','film','film:a','other','${T}')`);await stops(conflict,{},'state_conflict');}
{const foreign=database();sqlite(foreign,`INSERT INTO projection_state VALUES ('enrichment','person','person:tmdb_actor/9','k9','${T}')`);await stops(foreign,{},'state_conflict');}
// An expired lease does not hold the seed.
{const expired=database();sqlite(expired,`INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('enrichment',NULL,'2026-01-01T00:00:00.000Z')`);assert.equal((await seedProjectionD1(api(expired).adapter,target,plan,{apply:true})).outcome,'verified');}

// 5. Mutual exclusion with the projector and a second seed.
{
 const {projectorContext}=await import('./d1-enrichment-context.mjs');
 const {d1Standin}=await import('./d1-standin.mjs');
 const {MemoryBucket}=await import('./memory-bucket.mjs');
 const projector=projectorContext();
 // The projector starts while the seed writes its chunks: its lease acquisition refuses, and it reads and writes nothing.
 const shared=database();const attempts=[];
 const {adapter}=api(shared,{onWrite:async count=>{if(count===2){attempts.push(await projector.runD1EnrichmentProjection({DB:d1Standin(shared),BUCKET:new MemoryBucket(),D1_ENRICHMENT_WRITE:'on'}));attempts.push(await seedProjectionD1(api(shared).adapter,target,plan,{apply:true}).catch(error=>error.reason));}}});
 const seeded=await seedProjectionD1(adapter,target,plan,{apply:true,chunkRows:2});
 assert.equal(seeded.outcome,'verified');
 assert.equal(attempts[0].skipped,'lease_held','the projector does not start under the seed lease');
 assert.equal(attempts[1],'lease_held','a second seed does not start either');
 assert.deepEqual(state(shared),["film:film:a=ka","film:film:b=kb'quote","person:person:actor/x=kx"]);
 // A seed whose lease is taken away mid-run: the next chunk's batch fails whole and the seed stops; no later key, no release
 // of the new holder's lease.
 const stolen=database();
 const {adapter:robbed}=api(stolen,{onWrite:async count=>{if(count===3)sqlite(stolen,`UPDATE projection_run SET lease_id='projector',lease_until='${new Date(Date.now()+60000).toISOString()}'`);}});
 await assert.rejects(seedProjectionD1(robbed,target,plan,{apply:true,chunkRows:2}),error=>error.reason==='lease_lost'&&error.details.written===2);
 assert.deepEqual(state(stolen),["film:film:a=ka","person:person:actor/x=kx"],'only the chunk written under the lease');
 assert.equal(sqlite(stolen,'SELECT lease_id FROM projection_run',true)[0].lease_id,'projector');
 assert.equal(sqlite(stolen,'SELECT COUNT(*) AS n FROM projection_fence',true)[0].n,0);
 // A seed process that died keeps its lease until it expires; then the next seed takes over and finishes.
 const dead=database();
 sqlite(dead,`INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('enrichment','seed:dead','${new Date(Date.now()+60000).toISOString()}')`);
 await assert.rejects(seedProjectionD1(api(dead).adapter,target,plan,{apply:true}),error=>error.reason==='lease_held');
 sqlite(dead,`UPDATE projection_run SET lease_until='${new Date(Date.now()-1000).toISOString()}'`);
 assert.equal((await seedProjectionD1(api(dead).adapter,target,plan,{apply:true})).outcome,'verified');
}

console.log('Projection seed to D1 (ADR 0056): plan is read-only and leaves D1-only people without keys, apply writes bounded idempotent chunks and verifies exactly, rerun writes nothing, an interrupted run is finished by the next, identity/partial schema/baseline/live lease/missing entity/conflicting or foreign key fences stop before any key is written, the seed holds the projector lease so neither the projector nor a second seed starts, a stolen lease fails the next chunk whole, a dead seed lease expires and is taken over passed');
