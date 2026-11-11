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
// 6. Write detection fails closed: only a plain single SELECT keeps the held answer. A mutating WITH, a PRAGMA, a commented or multi-statement text, an INSERT or UPDATE
// with RETURNING run through first() or all(), and a statement the scope did not prepare all drop it.
{
 const BUMP='UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1';
 const writes=[
  ['mutating WITH through all()','WITH moved AS (SELECT generation FROM prediction_domain_authority WHERE id=1) '+BUMP+' RETURNING generation','all'],
  ['mutating WITH through first()','WITH moved AS (SELECT generation FROM prediction_domain_authority WHERE id=1) '+BUMP+' RETURNING generation','first'],
  ['UPDATE RETURNING through all()',BUMP+' RETURNING generation','all'],
  ['UPDATE RETURNING through first()',BUMP+' RETURNING generation','first'],
  ['commented UPDATE','/* read */ '+BUMP+' RETURNING generation','all'],
  ['two statements','SELECT 1 AS x; '+BUMP,'all'],
  ['lowercase update','update prediction_domain_authority set generation=generation+1 where id=1 returning generation','all'],
  ['leading spaces and newline','\n  '+BUMP+' RETURNING generation','first']
 ];
 for(const [name,text,how] of writes){
  const w=await flowWorld({films:3}),scoped=PredictionD1.scopeRequest(w.env);
  const held=await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
  await scoped.DB.prepare(text).bind()[how]();
  const seen=await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
  assert.equal(seen.generation,generation(w.file),name+': the held answer was dropped');assert.equal(seen.generation,held.generation+1,name);
 }
 // The same statements inside a batch, next to a plain read, and a PRAGMA that sets.
 for(const [name,text] of [['WITH in a batch','WITH moved AS (SELECT 1 AS x) '+BUMP+' RETURNING generation'],['PRAGMA that sets','PRAGMA user_version=7'],['PRAGMA that reads','PRAGMA user_version']]){
  const w=await flowWorld({films:3}),scoped=PredictionD1.scopeRequest(w.env);
  await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
  const before=w.stats.batches;
  await scoped.DB.batch([scoped.DB.prepare('SELECT 1 AS x').bind(),scoped.DB.prepare(text).bind()]);
  await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
  assert.equal(w.stats.batches-before,2,name+': the batch is not all reads, so the next read is a new batch');
 }
 // A statement the scope did not prepare is not known to be a read.
 const w=await flowWorld({films:3}),scoped=PredictionD1.scopeRequest(w.env);
 await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
 const before=w.stats.batches;await scoped.DB.batch([w.env.DB.prepare('SELECT 1 AS x').bind()]);await PredictionD1.readPredictionAuthority(scoped.DB,scoped);
 assert.equal(w.stats.batches-before,2,'an unknown statement drops the held answer');
 // Plain reads keep it: a SELECT with a trailing semicolon, spaces, a subquery.
 for(const text of ['SELECT 1 AS x;','  select count(*) AS n FROM prediction_pointer  ','SELECT (SELECT COUNT(*) FROM prediction_lease) AS n']){
  const v=await flowWorld({films:3}),sc=PredictionD1.scopeRequest(v.env);await PredictionD1.readPredictionAuthority(sc.DB,sc);
  const b=v.stats.batches;await sc.DB.prepare(text).bind().all();await PredictionD1.readPredictionAuthority(sc.DB,sc);assert.equal(v.stats.batches-b,0,text);
 }
}

// 7. Transitions of the authority marker and the schema under a request that holds the answer. Each is applied by SQL from outside, between the read and the request's
// write. The write of the request is the lease save of a step. Outcomes are compared with the same request in a world without the scope.
{
 const lease=()=>({owner:'run-x',runId:'run-x',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+60000});
 const attempt=async(scope,transition)=>{
  const w=await flowWorld({scope,films:3}),env=scope?PredictionD1.scopeRequest(w.env):w.env;
  await PredictionD1.readPredictionAuthority(env.DB,env);
  let blocked=null;try{transition(w.file);}catch(error){blocked=String(error.message||error).split('\n')[0];}
  let outcome;try{const saved=await PredictionD1.saveMutable(env,'enrichment/runner-lease.json',lease());outcome=saved.handled?'landed':saved.claimed?'rerouted':'declined';}catch(error){outcome='rejected:'+(error.code||'error');}
  const count=()=>{try{return sql(w.file,'SELECT COUNT(*) AS n FROM prediction_lease')[0].n;}catch{return null;}};
  return {outcome,blocked,leaseRows:count(),generation:generation(w.file)};
 };
 const same=[
  ['the writes marker held in mode d1 (no generation change)',file=>sql(file,"UPDATE prediction_domain_authority SET writes='held'"),'landed'],
  ['the schema version raised',file=>sql(file,'UPDATE schema_contract SET version=version+1 WHERE id=1'),'landed']
 ];
 for(const [name,transition,expected] of same){
  const off=await attempt(false,transition),on=await attempt(true,transition);
  assert.deepEqual(on,off,name+': the same outcome with and without the scope: '+JSON.stringify({off,on}));assert.equal(on.outcome,expected,name);
 }
 // A downgrade is refused by the database itself, so no request can ever hold a version that a later read would not reach.
 const downgrade=await attempt(true,file=>sql(file,'UPDATE schema_contract SET version=version-1 WHERE id=1'));
 assert.match(downgrade.blocked||'',/schema_contract_downgrade|downgrade/i,'schema_contract never goes down');assert.equal(downgrade.outcome,'landed');
 // The generation moved, or the mode reverted without a generation change (as the real revert statement does): the stale request writes nothing to D1.
 for(const [name,transition] of [['the generation moved',file=>sql(file,'UPDATE prediction_domain_authority SET generation=generation+1')],['the mode reverted without a generation change',file=>sql(file,"UPDATE prediction_domain_authority SET mode='r2', writes='open'")]]){
  const on=await attempt(true,transition);
  assert.equal(on.outcome,'rejected:prediction_domain_cas',name+': '+JSON.stringify(on));assert.equal(on.leaseRows,0,name+': nothing landed');
 }
 // A table of the domain that disappears is a migration the contract forbids (migrations only add). Were it to happen: a write that needs the table fails, with the
 // batch rolled back and nothing left behind; a write that does not need it still lands for the rest of that request, where a fresh read would refuse the whole domain.
 const needed=await attempt(true,file=>sql(file,'DROP TABLE prediction_lease'));
 assert.ok(needed.outcome.startsWith('rejected'),'a write whose table is gone fails: '+JSON.stringify(needed));
 const unrelatedOff=await attempt(false,file=>sql(file,'DROP TABLE prediction_lineage')),unrelatedOn=await attempt(true,file=>sql(file,'DROP TABLE prediction_lineage'));
 assert.equal(unrelatedOff.outcome,'rejected:prediction_domain_unavailable','a fresh read refuses a domain with a table missing');
 assert.equal(unrelatedOn.outcome,'landed','the held answer lets an unrelated write land for the rest of the request (documented: this transition is forbidden by the migration contract)');
}

// 8. Lease expiry, parallel steps and a crash with its replay end the same way with and without the scope.
{
 const normalize=value=>JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'<time>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<uuid>').replace(/[0-9a-f]{64}/g,'<sha>'));
 const films=w=>sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
 const lost=async scope=>{
  const w=await flowWorld({scope,films:40}),{start}=await w.reconcileAndStart(),runId=start.data.runId;
  const next=await w.api('next',{runId,batchSize:1});
  sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1) WHERE name='runner'");
  const submit=await w.api('submit',{runId,items:[{filmId:next.data.items[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
  return {status:submit.status,body:normalize(submit.data.status||submit.data.error||null),films:films(w)};
 };
 const lostOff=await lost(false),lostOn=await lost(true);
 assert.deepEqual(lostOn,lostOff,'an expired runner lease: '+JSON.stringify({lostOff,lostOn}));assert.equal(lostOn.films.length,0,'nothing is predicted under an expired lease');
 const parallel=async scope=>{
  const w=await flowWorld({scope,films:40}),{start}=await w.reconcileAndStart(),runId=start.data.runId;
  const both=await Promise.all([w.api('next',{runId,batchSize:1}),w.api('next',{runId,batchSize:1})]);
  return {statuses:both.map(r=>r.status).sort(),reasons:both.map(r=>r.data.reason||null).sort()};
 };
 const parOff=await parallel(false),parOn=await parallel(true);
 assert.deepEqual(parOn,parOff,'two writers at once: '+JSON.stringify({parOff,parOn}));assert.deepEqual(parOn.statuses,[200,409]);
 const crash=async scope=>{
  const w=await flowWorld({scope,films:40}),{start}=await w.reconcileAndStart(),runId=start.data.runId;
  const next=await w.api('next',{runId,batchSize:1}),filmId=next.data.items[0].filmId;
  const payload={runId,items:[{filmId,fingerprint:w.fingerprint,prediction:w.prediction}]};
  // The process dies at the second write batch of the submit: the first has committed, the second never runs.
  const base=w.stats.writeBatches;w.hooks.write=(statements,count)=>{if(count===base+2)throw new Error('cancelled');};
  const dead=await w.api('submit',payload);w.hooks.write=null;
  const afterCrash=films(w);
  // The crash stopped the run (a stop, not a lost film): a new run picks the film up again and the replayed submit lands once.
  const second=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}}),nextAgain=await w.api('next',{runId:second.data.runId,batchSize:1});
  const sameFilm=nextAgain.data.items[0].filmId===filmId;
  const replayPayload={runId:second.data.runId,items:[{filmId,fingerprint:w.fingerprint,prediction:w.prediction}]};
  const replay=await w.api('submit',replayPayload),again=await w.api('submit',replayPayload);
  return {dead:dead.status,afterCrash,second:second.status,sameFilm,replay:[replay.status,replay.data.results?.map(r=>r.status)],again:[again.status,again.data.results?.map(r=>r.status)],films:films(w)};
 };
 const crashOff=await crash(false),crashOn=await crash(true);
 assert.deepEqual(crashOn,crashOff,'a crash and its replay: '+JSON.stringify({crashOff,crashOn}));
 assert.equal(crashOn.dead,502);assert.equal(crashOn.sameFilm,true,'the same film is offered again');assert.deepEqual(crashOn.replay[1],['created']);
 assert.equal(crashOn.films.length,1,'the film is predicted once');assert.deepEqual(crashOn.again[1],['already_current'],'the replay is idempotent');
}
console.log('prediction authority scope tests passed');
