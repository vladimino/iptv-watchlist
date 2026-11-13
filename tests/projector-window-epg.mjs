// ADR 0103 (AIR-383), stage A: what the EPG publication and the Discovery Workflow do when a projector window holds Discovery out.
// The Worker bundle runs in a vm context over the real authority and a sqlite stand-in for D1 (every migration through 0018); nothing
// calls Cloudflare, TMDB or production. Covered: each of the three publication paths that took the Discovery lease (and threw
// `Resolver is writing the catalog`) now raises one typed busy for a window and keeps the old error for any other missing lease; the
// sync step answers a structured, non-failure `busy` to the window's absolute deadline, before the heavy EPG work and without
// persisting an error on the run; the seal step does the same with the deadline and not the lease-TTL cap; the executor's wait branch
// reads that answer; the Workflow's state write is refused softly (no step failure, no stall, no recovery budget).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const context=loadWorker();context.DiscoveryAuthority=Authority;
let fetches=0;context.fetch=async()=>{fetches++;throw new Error('the EPG source must not be fetched while a window is open');};
const call=code=>vm.runInContext(code,context);
// The Workflow module is part of the bundle and is not in the offline loader's context: load it as the bundle carries it.
vm.runInContext(fs.readFileSync('src/discovery-workflow.js','utf8'),context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-window-epg-'));
// The window protocol is this file's subject. The EPG-priority pause (0022, tests/epg-priority-gate.mjs) is a different gate and would refuse the Discovery-role acquires below by the wall clock.
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=21).sort();
const file=path.join(root,'e.sqlite');
{const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);}
const db=d1Standin(file);
db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-1', published_programme_run_id='run-1' WHERE id=1");
const bucket=new MemoryBucket();
const env={DB:db,BUCKET:bucket,discoveryLease:null};
const first=sql=>Object.values(db.sql(sql)[0]||{})[0];
const generation=()=>Number(first('SELECT generation FROM discovery_authority WHERE id=1'));
const windowRow=()=>db.sql('SELECT state, owner, expires_at AS expiresAt FROM projector_window WHERE id=1')[0];
const MARGIN=3000;

const publishCalls={
 publishD1Generation:()=>call('publishD1Generation')(env,'run-1',{},null,null,{phase:'published',programmeRunId:'run-0',fence:'f'}),
 publishEpgGeneration:()=>call('publishEpgGeneration')(env,'run-1',{}),
 stageSealedGeneration:()=>call('stageSealedGeneration')(env,{runId:'run-1',stage:'epg'},{holder:{discovery:{}},meta:{},pending:{},nextWatchlist:[],uncertain:[],publication:{phase:'published',programmeRunId:'run-0',fence:'f'}}),
};

// 1. A request is made: every publication path that takes the lease raises the typed busy with the deadline, none a generic error.
const requested=await Authority.requestProjectorWindow(env,{owner:'p1'});
assert.equal(requested.outcome,'requested');
for(const [name,run] of Object.entries(publishCalls)){
 await assert.rejects(run,error=>error.name==='ProjectorWindowBusy'&&error.busy.kind==='projector_window'&&error.busy.expiresAt===requested.expiresAt&&error.message==='projector_window',name+' raises the typed busy');
}
// The same while the window is held (the lease row is the projector's).
assert.equal((await Authority.grantProjectorWindow(env,{owner:'p1'})).outcome,'granted');
for(const [name,run] of Object.entries(publishCalls)){
 await assert.rejects(run,error=>error.name==='ProjectorWindowBusy'&&error.busy.state==='held',name+' held');
}

// 2. Any other missing lease keeps its old behaviour: the generic error, which the step records and the executor counts as before.
await Authority.releaseProjectorWindow(env,{owner:'p1'});
{
 const chunk=await Authority.acquireLease(env,{});assert.ok(chunk.lease);
 for(const [name,run] of Object.entries(publishCalls)){
  await assert.rejects(run,error=>error.name!=='ProjectorWindowBusy'&&/Resolver is writing the catalog/.test(error.message),name+' keeps the generic error for an ordinary lease');
 }
 await Authority.releaseLease({...env,discoveryLease:chunk.lease},chunk.lease);
}

// 3. The sync step: a structured, non-failure busy to the absolute deadline, before any heavy work, nothing persisted on the run.
{
 const run={runId:'run-1',stage:'epg',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),failures:[],remaining:0};
 await bucket.put('sync.json',JSON.stringify(run));
 const stored=(await bucket.get('sync.json')).text;
 const before=await stored();
 const asked=await Authority.requestProjectorWindow(env,{owner:'p2'});
 assert.equal(asked.outcome,'requested');
 const step={};
 const response=await call('syncStep')(env,'/api/sync/epg',{runId:'run-1'},step);
 assert.equal(response.status,200,'a busy answer, not an error status');
 const body=await response.json();
 assert.equal(body.runId,'run-1');assert.equal(body.stage,'epg');
 assert.equal(body.discovery.state,'busy');assert.equal(body.discovery.nextAction,'wait');assert.equal(body.discovery.reason,'busy');assert.equal(body.discovery.busyKind,'projector_window');
 assert.equal(Date.parse(body.discovery.nextCatchUpAt),asked.expiresAt+MARGIN,'the window deadline plus the margin');
 assert.ok(body.discovery.retryAfterSec>93,'longer than the single wait the daily Task contract allows: stated, not hidden');
 assert.equal(step.branch,'projector_window');
 assert.equal(fetches,0,'no EPG fetch, no title localization, no write before the busy answer');
 assert.equal(await (await bucket.get('sync.json')).text(),before,'no run.error, no updatedAt refresh, no stage change');
 assert.equal(JSON.parse(await (await bucket.get('sync.json')).text()).error,undefined);
 // The precheck is the same condition.
 await assert.rejects(()=>call('epgWindowPrecheck')(env),error=>error.name==='ProjectorWindowBusy');
 await Authority.releaseProjectorWindow(env,{owner:'p2'});
 assert.equal(await call('epgWindowPrecheck')(env),undefined,'no window, no busy');
}

// 4. The seal step: the deadline and its own kind, not the lease-TTL cap of a lease_held answer.
{
 const asked=await Authority.requestProjectorWindow(env,{owner:'p3'});
 const run={runId:'run-1',stage:'seal',seal:{jobId:'job-1',phase:'ledger'}};
 const out=await call('sealStep')(env,run);
 assert.equal(out.discovery.state,'busy');assert.equal(out.discovery.nextAction,'wait');assert.equal(out.discovery.busyKind,'projector_window');
 assert.equal(Date.parse(out.discovery.nextCatchUpAt),asked.expiresAt+MARGIN);
 assert.notEqual(out.discovery.busyKind,'lease_held','not the kind the Task contract waits for');
 assert.equal(out.seal.phase,'ledger','no phase moved');
 // An ordinary lease answers as before, with the TTL cap.
 await Authority.releaseProjectorWindow(env,{owner:'p3'});
 const chunk=await Authority.acquireLease(env,{});
 const held=await call('sealStep')(env,run);
 assert.equal(held.discovery.busyKind,'lease_held');
 assert.ok(Date.parse(held.discovery.nextCatchUpAt)<=Date.now()+Authority.LEASE_TTL_MS+MARGIN+1000);
 await Authority.releaseLease({...env,discoveryLease:chunk.lease},chunk.lease);
}

// 5. The executor: its wait branch reads exactly this answer, so a busy window sleeps to the deadline and charges no failure budget.
{
 const source=fs.readFileSync('src/epg-orchestration.js','utf8');
 assert.match(source,/const wait=reply\.discovery\?\.state==='busy'\|\|reply\.state==='busy';/);
 assert.match(source,/Date\.parse\(reply\.discovery\?\.nextCatchUpAt\|\|reply\.nextCatchUpAt\|\|''\)/);
 assert.match(source,/return \{\.\.\.base,wake:Number\.isFinite\(until\)\?until:now\+SLEEP_FLOOR_MS\*5,note:'busy'\}/);
 const asked=await Authority.requestProjectorWindow(env,{owner:'p4'});
 const reply=call('windowBusyResponse')({runId:'run-1',stage:'epg',remaining:0,failures:[]},{kind:'projector_window',expiresAt:asked.expiresAt});
 assert.equal(reply.discovery?.state==='busy'||reply.state==='busy',true,'the executor reads it as a wait');
 assert.equal(Date.parse(reply.discovery.nextCatchUpAt),asked.expiresAt+MARGIN);
 assert.equal(reply.state,undefined);assert.equal(reply.reason,undefined,'neither a programme_changed nor an error reading');
 await Authority.releaseProjectorWindow(env,{owner:'p4'});
}

// 6. The Workflow: a held window refuses its state write softly. The refusal is a typed result, not an exception: no step failure, no
// stall, no recovery attempt, nothing written; the loop carries on to its sleep until the lease (the window) expires.
{
 const instance='discovery_run1_0';
 const saved=await call('settleWorkflowIfOwner')(env,instance,{phase:'running',reason:'started',programmeRunId:'run-1',series:0});
 assert.equal(saved.saved,true,'idle: written as before');
 await Authority.requestProjectorWindow(env,{owner:'p5'});
 assert.equal((await call('settleWorkflowIfOwner')(env,instance,{phase:'waiting',reason:'busy',programmeRunId:'run-1',series:0})).saved,true,'requested lets an in-flight state write through');
 assert.equal((await Authority.grantProjectorWindow(env,{owner:'p5'})).outcome,'granted');
 const revision=first('SELECT revision FROM discovery_workflow WHERE id=1'),before=generation();
 for(let i=0;i<10;i++){
  const out=await call('settleWorkflowIfOwner')(env,instance,{phase:'waiting',reason:'busy',programmeRunId:'run-1',series:0});
  assert.equal(out.saved,false);assert.equal(out.reason,'projector_window');assert.ok(Number.isFinite(out.window.expiresAt));
 }
 assert.equal(first('SELECT revision FROM discovery_workflow WHERE id=1'),revision,'nothing was written');
 assert.equal(generation(),before,'and the generation did not move');
 const record=JSON.parse(first('SELECT payload_json FROM discovery_workflow WHERE id=1'));
 assert.equal(record.recovery??null,null,'no recovery attempt was charged');
 // The reconcile and the ensure paths turn a refusal into a plain not-started answer with its own reason.
 assert.equal(call('workflowAdmissionError')({code:'discovery_window'}),'projector_window');
 // A chunk asking for a lease is told why, with the deadline, so its series waits for the window and not for the hourly gate.
 const taken=await call('takeDiscoveryLease')(env);
 assert.equal(taken.lease,null);assert.equal(taken.busy.kind,'projector_window');assert.ok(Number.isFinite(taken.busy.expiresAt));
 const wrapper=await call('acquireDiscoveryLease')(env);
 assert.equal(wrapper,null,'the old shape for every caller that treats a missing lease as busy');
 await Authority.releaseProjectorWindow(env,{owner:'p5'});
 assert.ok((await call('takeDiscoveryLease')(env)).lease,'admission is open after the window');
}

// 7. A chunk series that finds the window open waits for its deadline (not the hourly gate), through the ordinary busy outcome.
{
 db.sql('UPDATE discovery_lease SET expires_at=0 WHERE id=1');   // the chunk lease taken at the end of section 6 is finished
 await bucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:'run-1'}));
 const record={stage:'paused',reason:'chunk_budget',remainingChunks:12,programmeRunId:'run-1',at:new Date(Date.now()-7200000).toISOString(),nextCatchUpAt:new Date(Date.now()-3600000).toISOString(),retryAt:null,hopId:null};
 assert.equal((await Authority.writeContinuation(env,record,undefined)).saved,true);
 const asked=await Authority.requestProjectorWindow(env,{owner:'p6'});
 const out=await call('advanceDiscovery')({...env,TMDB_API_READ_ACCESS_TOKEN:'x'},{});
 assert.equal(out.stage,'busy');assert.equal(out.diagnostic.branch,'projector_window');
 assert.equal(out.discovery.state,'busy');assert.equal(out.discovery.nextAction,'wait');
 assert.equal(Date.parse(out.discovery.nextCatchUpAt),asked.expiresAt,'the window deadline');
 await Authority.releaseProjectorWindow(env,{owner:'p6'});
}

// 8. Resume: the same EPG run continues after the window, from each place the window can catch it. Busy changes nothing on the run
// (no failure, no phase move, no refreshed clock); once the window is released each path takes the lease again and goes on.
{
 db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
 // (a) Every publication path takes the lease only through `leaseOrWindowBusy`, which is the one point the window answers.
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.equal((worker.match(/leaseOrWindowBusy\(env\)/g)||[]).length>=3,true,'three publication call sites');
 assert.equal(/acquireDiscoveryLease\(env\)[^\n]{0,80}Resolver is writing the catalog/.test(worker),false,'no site keeps the bare lease-or-throw');
 for(const phase of ['requested','held']){
  const asked=await Authority.requestProjectorWindow(env,{owner:'r1'});
  if(phase==='held')assert.equal((await Authority.grantProjectorWindow(env,{owner:'r1'})).outcome,'granted');
  for(const [name,run] of Object.entries(publishCalls))await assert.rejects(run,error=>error.name==='ProjectorWindowBusy'&&error.busy.expiresAt===asked.expiresAt,name+' '+phase);
  await Authority.releaseProjectorWindow(env,{owner:'r1'});
  // Released: the path takes the lease (no busy) and the lease is free again afterwards.
  for(const name of Object.keys(publishCalls)){
   const lease=await call('leaseOrWindowBusy')(env);
   assert.ok(lease&&lease.id,name+' resumes: the lease is taken after '+phase);
   await Authority.releaseLease({...env,discoveryLease:lease},lease);
  }
 }
 // (b) The seal, a window that opens between two calls of the same run: busy while requested and held with the phase untouched,
 // the next call after the release is not a window answer.
 const sealRun={runId:'run-1',stage:'seal',seal:{jobId:'job-1',phase:'ledger'}};
 const asked=await Authority.requestProjectorWindow(env,{owner:'r2'});
 for(const phase of ['requested','held']){
  if(phase==='held')await Authority.grantProjectorWindow(env,{owner:'r2'});
  const out=await call('sealStep')(env,sealRun);
  assert.equal(out.discovery.busyKind,'projector_window',phase);assert.equal(out.seal.phase,'ledger');assert.equal(out.error,undefined,'no failure on the run');
  assert.equal(Date.parse(out.discovery.nextCatchUpAt),asked.expiresAt+MARGIN);
 }
 await Authority.releaseProjectorWindow(env,{owner:'r2'});
 let resumed=null,thrown=null;
 try{resumed=await call('sealStep')(env,sealRun);}catch(error){thrown=error;}
 assert.equal(thrown?.name==='ProjectorWindowBusy',false,'not a window answer once the window is released');
 assert.notEqual(resumed?.discovery?.busyKind,'projector_window');
 // (c) The sync step: after the release it goes past the precheck to the real work for the same run (the EPG source is fetched).
 const before=fetches;
 const step={};
 await Authority.requestProjectorWindow(env,{owner:'r3'});
 const busy=await (await call('syncStep')(env,'/api/sync/epg',{runId:'run-1'},step)).json();
 assert.equal(busy.discovery.busyKind,'projector_window');assert.equal(fetches,before,'no fetch while the window is open');
 await Authority.releaseProjectorWindow(env,{owner:'r3'});
 // Past the precheck the step runs the real EPG work; this harness has no programme data, so that work ends in its own error. What the
 // test proves is where it ends: inside the EPG work, not at the window answer, and the run record is untouched by the busy before it.
 let reachedWork=false,answer=null;
 try{answer=await (await call('syncStep')(env,'/api/sync/epg',{runId:'run-1'},{})).json();reachedWork=answer?.discovery?.busyKind!=='projector_window';}
 catch(error){reachedWork=error.name!=='ProjectorWindowBusy'&&error.message!=='projector_window';}
 assert.equal(reachedWork,true,'the same run goes on to the EPG work after the window');
 assert.equal(JSON.parse(await (await bucket.get('sync.json')).text()).runId,'run-1','the same run id');
}

// 3. ADR 0135 (AIR-459), table PRESENT (0022 applied to a throwaway file): a live Discovery lease is a collision, not a fault of the publication, so the publication paths answer it as the
// structured, non-failure `ResolverBusy` (kind `lease_held`, with the holder's expiry). With the table absent (every case above) the generic error is unchanged: that is the inert boundary.
{
 const all=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const file22=path.join(root,'e22.sqlite');
 const made=sqliteSync(['-bail',file22],{input:'PRAGMA foreign_keys=ON;\n'+all.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(made.status!==0)throw new Error(made.stderr||'migration failed');
 const db22=d1Standin(file22);
 db22.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-1', published_programme_run_id='run-1' WHERE id=1");
 const holderUntil=Date.now()+60000;
 db22.sql("UPDATE discovery_lease SET lease_id='other-chunk', expires_at="+holderUntil+", programme_run_id='run-1', holder_kind='discovery' WHERE id=1");
 const env22={DB:db22,BUCKET:new MemoryBucket(),discoveryLease:null};
 assert.equal((await Authority.readAuthority(env22)).priorityTable,true);
 const calls22={
  publishD1Generation:()=>call('publishD1Generation')(env22,'run-1',{},null,null,{phase:'published',programmeRunId:'run-0',fence:'f'}),
  publishEpgGeneration:()=>call('publishEpgGeneration')(env22,'run-1',{}),
 };
 for(const [name,run] of Object.entries(calls22)){
  await assert.rejects(run,error=>error.name==='ResolverBusy'&&error.busy.kind==='lease_held'&&error.busy.expiresAt===holderUntil&&!/Resolver is writing the catalog/.test(error.message),name+' answers a live lease as a structured busy when the table exists');
 }
 // The externally visible sync step answer is a structured wait, never a counted failure.
 const answer=await call('windowBusyResponse')({runId:'run-1',stage:'epg',remaining:0,failures:[]},{kind:'lease_held',expiresAt:holderUntil});
 assert.equal(answer.discovery.nextAction,'wait');assert.equal(answer.discovery.busyKind,'lease_held');assert.equal(answer.failures,0);
 assert.ok(Date.parse(answer.discovery.nextCatchUpAt)<=Date.now()+Authority.LEASE_TTL_MS+5000);
}

console.log('Projector window, EPG and Workflow (ADR 0103): the three publication paths raise one typed busy for a window and keep the generic error for any other missing lease; the sync step answers a structured non-failure busy to the absolute deadline before any heavy work and without persisting an error; the seal step does the same with its own kind and no TTL cap; the executor reads the answer as a wait; the Workflow state write is refused softly with no stall or recovery charge');
