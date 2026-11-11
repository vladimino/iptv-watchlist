// AIR-441. The prediction domain's authority marker is read in one D1 round trip, and inside one next or submit it is reused until that request's own
// database does something other than read. This test proves the reduction on a run in D1 mode, that the answers and the stored state are those of a run
// without the scope, that the scope never leaves its request, and that a marker that moves under a request fails its next write closed instead of
// landing it. Local sqlite and in-memory R2 stand-ins only.
import assert from 'node:assert/strict';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const generation=file=>sql(file,'SELECT generation FROM prediction_domain_authority WHERE id=1')[0].generation;

// 1. One round trip for the three facts, and the same facts the stepwise queries give.
{
 const w=await flowWorld({films:5});
 const before=w.stats.queries,beforeBatches=w.stats.batches;
 const authority=await PredictionD1.readPredictionAuthority(w.env.DB,w.env);
 assert.equal(w.stats.queries-before,0,'no statement runs on its own');assert.equal(w.stats.batches-beforeBatches,1,'the three reads are one batch');
 const batches=w.stats.batches;await PredictionD1.readPredictionAuthority(w.env.DB,w.env);assert.equal(w.stats.batches-batches,1,'one batch per read');
 const row=sql(w.file,'SELECT mode, generation, queue_generation AS q, profile_generation AS p, writes FROM prediction_domain_authority')[0];
 assert.equal(authority.mode,'d1');assert.equal(authority.ready,true);assert.equal(authority.generation,row.generation);assert.equal(authority.queueGeneration,row.q);assert.equal(authority.profileGeneration,row.p);assert.equal(authority.writes,row.writes);
 assert.equal(authority.version,sql(w.file,'SELECT version FROM schema_contract WHERE id=1')[0].version);assert.equal(authority.tables,true);
 // A binding that cannot batch is read one statement at a time, with the same answer.
 const stepwise={prepare:sql=>w.env.DB.prepare(sql)};
 const same=await PredictionD1.readPredictionAuthority(stepwise,w.env);assert.deepEqual(same,authority);
 // A refused batch (a database without the domain's tables) falls back to the stepwise reading and its classification.
 const refusing={prepare:sql=>w.env.DB.prepare(sql),batch:async()=>{throw new Error('no such table: prediction_domain_authority');}};
 assert.deepEqual(await PredictionD1.readPredictionAuthority(refusing,w.env),authority);
}

// 2. The scope: reuse until the request's database writes, share in-flight reads, never across scopes, never memoize a failure.
{
 const w=await flowWorld({films:5});
 const scoped=PredictionD1.scopeRequest(w.env);assert.notEqual(scoped.DB,w.env.DB);assert.equal(scoped.BUCKET,w.env.BUCKET);
 const count=async work=>{const b=w.stats.batches;await work();return w.stats.batches-b;};
 assert.equal(await count(async()=>{await PredictionD1.readPredictionAuthority(scoped.DB,scoped);await PredictionD1.readPredictionAuthority(scoped.DB,scoped);}),1,'two sequential reads, one batch');
 assert.equal(await count(async()=>{await Promise.all(Array.from({length:10},()=>PredictionD1.readPredictionAuthority(scoped.DB,scoped)));}),0,'reads while the answer is held are free');
 // A read-only batch does not forget; a statement that runs does.
 assert.equal(await count(async()=>{await scoped.DB.batch([scoped.DB.prepare('SELECT 1 AS x').bind()]);await PredictionD1.readPredictionAuthority(scoped.DB,scoped);}),1,'only the batch of reads itself');
 const g0=generation(w.file);
 await scoped.DB.prepare('UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1').bind().run();
 const after=await PredictionD1.readPredictionAuthority(scoped.DB,scoped);assert.equal(after.generation,g0+1,'a write of the request drops the answer; the next read sees it');
 // A non-read batch forgets, a read through first() does not.
 await scoped.DB.batch([scoped.DB.prepare('UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1').bind()]);
 assert.equal((await PredictionD1.readPredictionAuthority(scoped.DB,scoped)).generation,g0+2);
 await scoped.DB.prepare('SELECT 1 AS x').bind().first();assert.equal(await count(()=>PredictionD1.readPredictionAuthority(scoped.DB,scoped)),0);
 // A write that happens while a read is in flight keeps that read from being shared afterwards.
 const race=PredictionD1.scopeRequest(w.env);
 const first=PredictionD1.readPredictionAuthority(race.DB,race);
 await race.DB.prepare('UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1').bind().run();
 await first;const later=await PredictionD1.readPredictionAuthority(race.DB,race);assert.equal(later.generation,generation(w.file),'the answer read before the write is not shared after it');
 // Scopes are independent and an unscoped database is read every time.
 const other=PredictionD1.scopeRequest(w.env);await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
 assert.equal(await count(()=>PredictionD1.readPredictionAuthority(other.DB,other)),1,'another request reads it afresh');
 assert.equal(await count(async()=>{await PredictionD1.readPredictionAuthority(w.env.DB,w.env);await PredictionD1.readPredictionAuthority(w.env.DB,w.env);}),2,'no scope, no reuse');
 // A failing read is not remembered.
 let armed=true;const flaky={prepare:s=>w.env.DB.prepare(s),batch:async list=>{if(armed){armed=false;throw new Error('D1 down');}return w.env.DB.batch(list);}};
 const failing=PredictionD1.scopeRequest({...w.env,DB:flaky});
 const attempt=await PredictionD1.readPredictionAuthority(failing.DB,failing).catch(error=>error);
 assert.equal(attempt instanceof Error,false,'the refused batch falls back to the stepwise reading and answers');
 // sessions share the scope; exec forgets
 const sessions={prepare:s=>w.env.DB.prepare(s),batch:l=>w.env.DB.batch(l),exec:async()=>({}),withSession(){return {prepare:s=>w.env.DB.prepare(s),batch:l=>w.env.DB.batch(l)};}};
 const sc=PredictionD1.scopeRequest({...w.env,DB:sessions});await PredictionD1.readPredictionAuthority(sc.DB,sc);
 const session=sc.DB.withSession('first-primary');await session.prepare('UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1').bind().run();
 assert.equal((await PredictionD1.readPredictionAuthority(sc.DB,sc)).generation,generation(w.file),'a write through a session forgets the answer');
 await PredictionD1.readPredictionAuthority(sc.DB,sc);await sc.DB.exec('SELECT 1');
 assert.equal(await count(()=>PredictionD1.readPredictionAuthority(sc.DB,sc)),1,'exec forgets');
}

// 3. A marker that moves under a request fails that request's next write closed, and the failed write drops the stale answer so a retry succeeds.
{
 const w=await flowWorld({films:5});
 const scoped=PredictionD1.scopeRequest(w.env);
 const held=await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
 const lease={owner:'run-x',runId:'run-x',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+60000};
 sql(w.file,'UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1');
 await assert.rejects(()=>PredictionD1.saveMutable(scoped,'enrichment/runner-lease.json',lease),error=>error.code==='prediction_domain_cas','a write on a moved generation fails closed');
 assert.equal(sql(w.file,"SELECT COUNT(*) AS n FROM prediction_lease")[0].n,0,'and writes nothing');
 const retry=await PredictionD1.saveMutable(scoped,'enrichment/runner-lease.json',lease);assert.equal(retry.handled,true,'the retry reads the marker afresh and lands');
 assert.equal(sql(w.file,"SELECT COUNT(*) AS n FROM prediction_lease")[0].n,1);
 assert.ok(generation(w.file)>held.generation);
 // The mode itself moved (a reverted cutover): the writes of a request that still holds mode d1 fail closed, and nothing reaches D1.
 const request=PredictionD1.scopeRequest(w.env);await PredictionD1.readPredictionAuthority(request.DB,request);
 sql(w.file,"UPDATE prediction_domain_authority SET mode='r2', writes='held'");
 const rows=sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n;
 await assert.rejects(()=>PredictionD1.saveMutable(request,'enrichment/runner-lease.json',{...lease,heartbeatAt:new Date().toISOString()}),error=>/prediction_domain/.test(error.code||''),'a write after the mode moved fails closed');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,rows);
 const fresh=PredictionD1.scopeRequest(w.env);assert.equal((await PredictionD1.readPredictionAuthority(fresh.DB,fresh)).mode,'r2','a new request sees the new mode at once: nothing is kept between requests');
}

// 4. The same run with and without the scope: same answers, same stored state, fewer D1 round trips.
{
 const normalize=value=>JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'<time>').replace(/[0-9a-f]{64}/g,'<sha>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<uuid>').replace(/\b\d{13}-/g,'<ts>-').replace(/"([A-Za-z]*(?:Ms|At|Id))":(\d{10,}|"[^"]*")/g,'"$1":0'));
 const runOne=async scope=>{
  const w=await flowWorld({scope,films:40});
  const {start}=await w.reconcileAndStart();assert.equal(start.status,200);
  const steps=[];for(let i=0;i<3;i++)steps.push(await w.pair(start.data.runId));
  const state={pointers:sql(w.file,'SELECT film_id, fingerprint_hash FROM prediction_pointer ORDER BY film_id'),fingerprints:sql(w.file,'SELECT film_id, schema_version, prompt_version FROM prediction_fingerprint ORDER BY film_id'),lineage:sql(w.file,'SELECT COUNT(*) AS n FROM prediction_lineage'),authority:sql(w.file,'SELECT mode, queue_generation, writes FROM prediction_domain_authority'),generations:generation(w.file)};
  return {steps,state,answers:normalize(steps.map(s=>[s.next.status,s.next.data.items.map(i=>i.requiredWork),s.submit.status,s.submit.data.results.map(r=>r.status)])),logs:w.logs.filter(l=>l.includes('prediction_boundary_failed'))};
 };
 const off=await runOne(false),on=await runOne(true);
 assert.deepEqual(on.logs,[]);assert.deepEqual(off.logs,[]);
 assert.deepEqual(on.answers,off.answers,'the same answers');
 assert.deepEqual(on.state,off.state,'the same stored state, down to the authority generation');
 const nextOn=Math.max(...on.steps.map(s=>s.nextQueries)),nextOff=Math.min(...off.steps.map(s=>s.nextQueries)),submitOn=Math.max(...on.steps.map(s=>s.submitQueries)),submitOff=Math.min(...off.steps.map(s=>s.submitQueries));
 assert.ok(nextOn<nextOff*0.7,'next: '+nextOff+' -> '+nextOn);assert.ok(submitOn<submitOff*0.8,'submit: '+submitOff+' -> '+submitOn);
 console.log(JSON.stringify({d1_round_trips_per_step_without_scope:{next:nextOff,submit:submitOff},with_scope:{next:nextOn,submit:submitOn}}));
}
// 5. A concurrent writer moves the marker under a running step: with the scope and without it the step ends the same way, and the run goes on to complete a film.
{
 const outcome=async scope=>{
  const w=await flowWorld({scope,films:40});
  const {start}=await w.reconcileAndStart();const runId=start.data.runId;
  let fired=0;
  // The other writer lands just before the first write of the step commits, once, as a second runner's checkpoint would.
  const afterSetup=w.stats.writeBatches;
  w.hooks.write=(statements,count)=>{if(count===afterSetup+1&&!fired){fired++;sql(w.file,'UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1');}};
  const raced=await w.api('next',{runId,batchSize:1});
  w.hooks.write=null;
  const next=raced.status===200&&raced.data.items?.length?raced:await w.api('next',{runId,batchSize:1});
  const submit=await w.api('submit',{runId,items:[{filmId:next.data.items[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
  return {fired,racedStatus:raced.status,submitStatus:submit.status,created:submit.data.results?.map(r=>r.status),films:sql(w.file,'SELECT COUNT(*) AS n FROM prediction_pointer')[0].n,failures:w.logs.filter(l=>l.includes('prediction_boundary_failed')).length};
 };
 const off=await outcome(false),on=await outcome(true);
 assert.equal(off.fired,1);assert.equal(on.fired,1);
 assert.deepEqual(on,off,'the interleaved writer changes nothing about how the step ends: '+JSON.stringify({off,on}));
 assert.deepEqual(on.created,['created']);assert.equal(on.films,1);
}
console.log('prediction authority scope tests passed');
