// AIR-348 / ADR 0100: the Cloudflare executor of the daily EPG publication. The migration; the pure schedule (17:00 Madrid, DST);
// the owner's mode switch and the external writer's gate; `ensure` under duplicate firings and uncertain creates; a whole run
// through the Workflow loop with an injected clock, a scripted pipeline and a stand-in Workflow binding; the classified failures
// and quarantines; the read model; and the epoch fence inside the published-EPG commit batch on a real D1 stand-in.
// No network, no Cloudflare and no production. The executor is inert: with the table absent or the mode external nothing runs.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Policy from '../src/domain/orchestration-policy.js';
import * as MonitorPolicyModule from '../src/domain/monitor-policy.js';
import * as PublishedEpg from '../src/published-epg.js';
import {d1Standin} from './d1-standin.mjs';

const H=3600000,MIN=60000;
const at=ms=>new Date(ms).toISOString();
const plain=value=>JSON.parse(JSON.stringify(value));
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const source=fs.readFileSync('src/epg-orchestration.js','utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-orchestration-'));
let databases=0;

// 1. Static: inert wiring. The cron is unchanged, the binding and the class exist, the module has no network and no secret.
{
 assert.equal(Policy.EPG_SCHEDULE.hour,17);assert.equal(Policy.EPG_SCHEDULE.minute,0);
 assert.deepEqual(plain(Policy.EPG_SCHEDULE),plain(MonitorPolicyModule.EPG_SCHEDULE),'one EPG due time for the executor and the monitor');
 const wrangler=fs.readFileSync('wrangler.jsonc','utf8');
 assert.match(wrangler,/"crons": \["37 \* \* \* \*"\]/,'this change does not move the cron: that is a separate owner-approved production step');
 assert.match(wrangler,/"binding": "EPG_WORKFLOW"[\s\S]*"class_name": "EpgWorkflow"/);
 const build=fs.readFileSync('build.mjs','utf8');
 assert.match(build,/src\/epg-orchestration\.js/);assert.match(build,/export class EpgWorkflow extends WorkflowEntrypoint/);assert.match(build,/runEpgWorkflow/);
 assert.doesNotMatch(source,/\bfetch\(|BUCKET|TOKEN|SECRET/,'the executor fetches no source and holds no secret');
 assert.doesNotMatch(source,/\.put\(|\.delete\(/,'the executor writes no R2 object itself');
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.match(worker,/EpgOrchestration\.ensure\(env,/);assert.match(worker,/EpgOrchestration\.externalGate\(env\)/);
}

// 2. The migration: refused below a complete version 14, applied on one, writes no row, and the version never goes down.
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal','0013_film_person_authority','0014_localization_source'];
const migration=fs.readFileSync('migrations/0015_epg_orchestration.sql','utf8');
function database(upTo=chain.length,{apply=true}={}){
 const file=path.join(root,'e-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of chain.slice(0,upTo))db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 if(apply)db.sql(migration);
 return db;
}
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
{
 const full=database();
 assert.equal(one(full,'SELECT version FROM schema_contract'),15);
 assert.equal(one(full,'SELECT COUNT(*) FROM epg_orchestration_document'),0,'applying the migration writes no row');
 assert.equal(one(full,"SELECT COUNT(*) FROM published_epg_authority WHERE mode='r2'"),1,'the marker is untouched');
 assert.throws(()=>full.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('other','{}',1,'x')"),/CHECK/,'only the two documents exist');
 assert.throws(()=>full.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','not json',1,'x')"),/CHECK/);
 assert.throws(()=>full.sql("UPDATE schema_contract SET version=14 WHERE id=1"),/schema_contract_downgrade/,'the version never goes down');
 for(const upTo of [11,12,13]){
  const early=database(upTo,{apply:false});
  assert.throws(()=>early.sql(migration),/./,'refused below a complete version 14 (chain '+upTo+')');
  assert.equal(one(early,"SELECT COUNT(*) FROM sqlite_master WHERE name='epg_orchestration_document'"),0,'no table is created by a refused file');
 }
}

// The module in a context like the Worker's: the scoped policy, the module, a scripted pipeline and a published-authority stub.
function load({sync,pipeline,authority={ready:true},workflow=null,db}){
 const state={sync:sync??null,calls:[],authority:{...authority}};
 const context=vm.createContext({console,Date,Math,JSON,Promise,Intl,URL,crypto:webcrypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
 context.loadJSON=async(env,key)=>key==='sync.json'?(state.sync?JSON.parse(JSON.stringify(state.sync)):null):null;
 context.PublishedEpg={readAuthority:async()=>{if(state.authority.throws)throw new Error('unavailable');return state.authority;}};
 context.postSync=async(env,execution,pathname,body,caller)=>{
  state.calls.push({pathname,body,caller,fence:env?.epgFence??null});
  const reply=await pipeline(pathname,body,state,env);
  return {status:reply.status??200,json:async()=>reply.body??{}};
 };
 vm.runInContext(source,context);
 const env={DB:db,EPG_WORKFLOW:workflow};
 return {context,state,env,epg:vm.runInContext('EpgOrchestration',context)};
}
// A Workflow binding stand-in that records creates and answers statuses by instance id.
function binding({createFails=null}={}){
 const instances=new Map(),creates=[];
 return {instances,creates,
  async create({id,params}){
   creates.push({id,params});
   if(createFails==='exists'&&creates.length>0){const error=new Error('instance already exists');error.name='WorkflowError';throw error;}
   if(createFails==='lost'){throw new Error('network');}
   if(instances.has(id)){const error=new Error('already exists');throw error;}
   instances.set(id,'running');
  },
  async get(id){if(!instances.has(id))throw new Error('instance not found');return {status:async()=>({status:instances.get(id)})};}};
}
const idle=()=>({body:{}});
// 3. The schedule: 17:00 Madrid on a winter day, a summer day and both change days.
{
 // CET (UTC+1): 17:00 is 16:00Z. CEST (UTC+2): 17:00 is 15:00Z.
 const cases=[['2026-11-07T15:59:59Z','2026-11-07',false],['2026-11-07T16:00:00Z','2026-11-07',true],['2026-07-01T14:59:59Z','2026-07-01',false],['2026-07-01T15:00:00Z','2026-07-01',true],
  ['2026-10-25T15:59:59Z','2026-10-25',false],['2026-10-25T16:00:00Z','2026-10-25',true],['2026-03-29T14:59:59Z','2026-03-29',false],['2026-03-29T15:00:00Z','2026-03-29',true]];
 for(const [time,day,due] of cases){const result=Policy.dailyDue(Date.parse(time),Policy.EPG_SCHEDULE);assert.equal(result.dayKey,day,time);assert.equal(result.due,due,time);}
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-11-07T16:30:00Z'),Policy.EPG_SCHEDULE)),'2026-11-08T16:00:00.000Z');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-10-24T20:00:00Z'),Policy.EPG_SCHEDULE)),'2026-10-25T16:00:00.000Z','the fall-back day: 17:00 is 16:00Z');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-03-28T20:00:00Z'),Policy.EPG_SCHEDULE)),'2026-03-29T15:00:00.000Z','the spring-forward day: 17:00 is 15:00Z');
 // The hourly cron at minute 0 reaches the logical due the same hour; at minute 37 it reaches it 37 minutes later.
 assert.equal(Policy.dailyDue(Date.parse('2026-11-07T16:00:00Z'),Policy.EPG_SCHEDULE).due,true);
 assert.equal(Policy.dailyDue(Date.parse('2026-11-07T15:37:00Z'),Policy.EPG_SCHEDULE).due,false);
}

// 4. Inert: no table, no database, mode external. `ensure` creates nothing, the gate lets the external path through with no fence.
{
 const noTable=database(chain.length,{apply:false});
 for(const db of [undefined,noTable]){
  const wf=binding();
  const {epg,env}=load({pipeline:idle,workflow:wf,db});
  eq(await epg.ensure(env,{now:Date.parse('2026-11-07T17:00:00Z')}),{started:false,reason:'external'});
  eq(await epg.externalGate(env),{reason:null,fence:null});
  assert.equal(wf.creates.length,0);
  const model=await epg.readModel(env,Date.parse('2026-11-07T17:00:00Z'));
  assert.equal(model.mode,'external');assert.equal(model.available,false);assert.equal(model.sideEffects,'none');
  eq(await epg.handle(env,{action:'close_admission',target:'cloudflare'}),{status:200,body:{action:'close_admission',refused:'not_available'}});
 }
 const external=database();
 const wf=binding();
 const {epg,env}=load({pipeline:idle,workflow:wf,db:external});
 eq(await epg.ensure(env,{now:Date.parse('2026-11-07T17:00:00Z')}),{started:false,reason:'external'},'the table applied, the mode absent: still external');
 eq(await epg.externalGate(env),{reason:null,fence:{revision:null}},'the external path carries a fence on the absent mode document');
 assert.equal(wf.creates.length,0);
 assert.equal(one(external,'SELECT COUNT(*) FROM epg_orchestration_document'),0,'reads write nothing');
}

// 5. The owner's mode switch: close admission, a verified drain, complete; an unverified drain refuses.
{
 const db=database();
 const wf=binding();
 const t0=Date.parse('2026-11-07T12:00:00Z');
 // A recent external step: the drain is not verified.
 const harness=load({pipeline:idle,workflow:wf,db,sync:{runId:'old',stage:'epg',updatedAt:at(t0-5*MIN),startedAt:at(t0-10*MIN)}});
 const {epg,env,state}=harness;
 eq(await epg.switchMode(env,{action:'complete'},t0),{action:'complete',refused:'not_switching',mode:'external',epoch:0});
 eq(await epg.switchMode(env,{action:'close_admission',target:'cloudflare'},t0),{action:'close_admission',closed:true,mode:'switching',target:'cloudflare',epoch:1});
 eq(await epg.switchMode(env,{action:'close_admission',target:'cloudflare'},t0),{action:'close_admission',refused:'switch_open',mode:'switching',target:'cloudflare',epoch:1});
 eq(await epg.externalGate(env),{reason:'switch_in_progress',fence:null});
 eq(await epg.switchMode(env,{action:'complete'},t0),{action:'complete',refused:'drain_not_verified',drain:'step_recent',mode:'switching',target:'cloudflare',epoch:1});
 // An unfinished seal is never handed over mid-way.
 state.sync={runId:'old',stage:'seal',updatedAt:at(t0-5*H),startedAt:at(t0-6*H),seal:{phase:'ledger'}};
 assert.equal((await epg.switchMode(env,{action:'complete'},t0)).drain,'seal_unfinished');
 // A stale metadata/epg run is no step in flight: verified.
 state.sync={runId:'old',stage:'epg',updatedAt:at(t0-20*MIN),startedAt:at(t0-30*MIN)};
 // A live Workflow instance of a previous series blocks it.
 const control={schemaVersion:1,runKey:'2026-11-06',series:0,instanceId:'epg_20261106_0',epoch:0,phase:'running',budget:Policy.emptyBudget()};
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('control','"+JSON.stringify(control)+"',1,'x')");
 wf.instances.set('epg_20261106_0','running');
 assert.equal((await epg.switchMode(env,{action:'complete'},t0)).drain,'instance_live');
 wf.instances.set('epg_20261106_0','complete');
 eq(await epg.switchMode(env,{action:'complete'},t0),{action:'complete',completed:true,mode:'cloudflare',epoch:1,drain:'verified'});
 eq(await epg.externalGate(env),{reason:'external_writer_fenced',fence:null});
 eq(await epg.switchMode(env,{action:'close_admission',target:'cloudflare'},t0),{action:'close_admission',refused:'already_in_mode',mode:'cloudflare',epoch:1});
 // Rollback is the same fenced protocol and raises the epoch again.
 eq(await epg.switchMode(env,{action:'close_admission',target:'external'},t0),{action:'close_admission',closed:true,mode:'switching',target:'external',epoch:2});
 eq(await epg.switchMode(env,{action:'complete'},t0),{action:'complete',completed:true,mode:'external',epoch:2,drain:'verified'});
 eq(await epg.externalGate(env),{reason:null,fence:{revision:(await epg.readMode(env)).revision}});
 // An unreadable sync.json cannot verify a drain.
 harness.context.loadJSON=async()=>{throw new Error('r2 down');};
 await epg.switchMode(env,{action:'close_admission',target:'cloudflare'},t0);
 assert.equal((await epg.switchMode(env,{action:'complete'},t0)).drain,'unreadable');
 // Request validation: nothing outside the contract reaches the switch.
 eq(await epg.handle(env,{action:'nope'}),{status:400,body:{error:'Unknown action'}});
 eq(await epg.handle(env,{action:'close_admission'}),{status:400,body:{error:'Missing target'}});
 eq(await epg.handle(env,{action:'close_admission',target:'x'}),{status:400,body:{error:'Invalid target'}});
 eq(await epg.handle(env,{action:'complete',extra:1}),{status:400,body:{error:'Unknown field'}});
}

// A database already switched to cloudflare at epoch 1, ready for ensure and the loop.
function cloudflare({sync=null,pipeline=idle,authority}={}){
 const db=database();
 const wf=binding();
 const harness=load({pipeline,workflow:wf,db,sync,authority});
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify({schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified'})+"',1,'x')");
 return {...harness,db,wf};
}
const control=async harness=>(await harness.epg.readControl(harness.env)).record;

// 6. ensure: not due, due once, duplicates, alive, ended, uncertain create, held authority, quarantine.
{
 const h=cloudflare();
 const {epg,env,wf,state}=h;
 const before=Date.parse('2026-11-07T15:59:00Z'),due=Date.parse('2026-11-07T16:00:00Z');
 eq(await epg.ensure(env,{now:before}),{started:false,reason:'not_due',dueAt:'2026-11-07T16:00:00.000Z'});
 // Two overlapping firings at the due time create exactly one instance.
 const [a,b]=await Promise.all([epg.ensure(env,{now:due}),epg.ensure(env,{now:due})]);
 const results=[a,b].sort((x,y)=>String(x.reason||'').localeCompare(String(y.reason||'')));
 assert.equal(results.filter(r=>r.started===true).length,1,'one firing starts');
 assert.equal(wf.creates.length,1);eq(wf.creates[0],{id:'epg_20261107_0',params:{runKey:'2026-11-07',series:0,epoch:1}});
 assert.equal((await control(h)).phase,'starting');
 eq(await epg.ensure(env,{now:due+MIN}),{started:false,reason:'in_progress',instanceId:'epg_20261107_0'});
 // A platform status that cannot be read is not an ended instance.
 const unreadable={...wf,get:async()=>{throw new Error('platform')}};
 env.EPG_WORKFLOW=unreadable;
 eq(await epg.ensure(env,{now:due+2*MIN}),{started:false,reason:'status_unknown',instanceId:'epg_20261107_0'});
 env.EPG_WORKFLOW=wf;
 // The instance ended with the run unfinished: a counted transient failure, a cooldown, then a successor series under the same day key.
 wf.instances.set('epg_20261107_0','errored');
 const failed=await epg.ensure(env,{now:due+3*MIN,random:()=>0.5});
 assert.equal(failed.reason,'cooldown');assert.equal(failed.recorded,'instance_errored');
 assert.equal((await control(h)).budget.consecutive,1);
 eq(await epg.ensure(env,{now:due+3*MIN+30000,random:()=>0.5}).then(r=>({started:r.started,reason:r.reason})),{started:false,reason:'cooldown'});
 const successor=await epg.ensure(env,{now:due+10*MIN,random:()=>0.5});
 assert.equal(successor.started,true);assert.equal(successor.instanceId,'epg_20261107_1');assert.equal(wf.creates.length,2);
 // A held published authority starts nothing.
 state.authority={ready:false};
 const nextDay=Date.parse('2026-11-08T16:00:00Z');
 eq(await epg.ensure(env,{now:nextDay}),{started:false,reason:'authority_held'});
 state.authority={ready:true};
 // A created instance that answers exists attaches; a lost create response reads the platform before anything else.
 wf.createFails='exists';
 const attached=await epg.ensure(env,{now:nextDay});
 assert.equal(attached.started,true);
}
{
 const h=cloudflare();
 const {epg,env,wf}=h;
 const due=Date.parse('2026-11-07T16:00:00Z');
 wf.create=async({id,params})=>{wf.creates.push({id,params});wf.instances.set(id,'running');throw new Error('lost response');};
 const lost=await epg.ensure(env,{now:due});
 assert.equal(lost.started,true);assert.equal(lost.attached,true,'the instance exists: the lost response is attached, not repeated');
 const h2=cloudflare();
 h2.wf.create=async({id,params})=>{h2.wf.creates.push({id,params});throw new Error('lost response');};
 const unknown=await h2.epg.ensure(h2.env,{now:due});
 assert.equal(unknown.started,false);assert.equal(unknown.reason,'create_uncertain');
 const record=await control(h2);assert.equal(record.stopReason,'create_uncertain');assert.equal(record.budget.consecutive,1);
 // No Workflow binding: nothing runs.
 const h3=cloudflare();h3.env.EPG_WORKFLOW=null;
 eq(await h3.epg.ensure(h3.env,{now:due}),{started:false,reason:'workflow_unavailable'});
 // A run of this Madrid date that is complete: nothing more to start.
 const h4=cloudflare();
 await h4.epg.ensure(h4.env,{now:due});
 const stored=await h4.epg.readControl(h4.env);
 await h4.db.prepare('UPDATE epg_orchestration_document SET body=?, revision=revision+1 WHERE key=?').bind(JSON.stringify({...stored.record,doneAt:at(due),phase:'done'}),'control').run();
 eq(await h4.epg.ensure(h4.env,{now:due+H}),{started:false,reason:'complete'});
 // A run quarantine stops starts for that date and ends with the date.
 await h4.db.prepare('UPDATE epg_orchestration_document SET body=?, revision=revision+1 WHERE key=?').bind(JSON.stringify({...stored.record,quarantine:{reason:'repeated_failure',scope:'run'}}),'control').run();
 eq(await h4.epg.ensure(h4.env,{now:due+H}),{started:false,reason:'quarantined',scope:'run'});
 const tomorrow=await h4.epg.ensure(h4.env,{now:Date.parse('2026-11-08T16:00:00Z')});
 assert.equal(tomorrow.started,true,'a run quarantine ends with its run key');
}

// The scripted pipeline: a fixture sync.json that moves forward the way the real steps move it.
function pipeline({metadataSteps=2,busyOnce=false,fail=null}={}){
 let busy=busyOnce,metadataLeft=metadataSteps,steps=0;
 return async(pathname,body,state)=>{
  steps++;
  if(fail&&fail.at===steps)return fail.reply;
  if(pathname==='/api/sync/start'){
   state.sync={runId:'run-'+(++state.runs||(state.runs=1)),startedAt:at(state.now()),updatedAt:at(state.now()),stage:metadataLeft?'metadata':'epg',cursor:0,remaining:metadataLeft*10};
   return {body:{runId:state.sync.runId,stage:state.sync.stage,remaining:state.sync.remaining}};
  }
  if(body.runId!==state.sync.runId)return {status:409,body:{error:'Run id mismatch'}};
  if(pathname==='/api/sync/metadata'){
   metadataLeft--;state.sync={...state.sync,cursor:state.sync.cursor+10,remaining:metadataLeft*10,updatedAt:at(state.now()),stage:metadataLeft>0?'metadata':'epg'};
   return {body:{runId:state.sync.runId,stage:state.sync.stage,remaining:state.sync.remaining}};
  }
  if(state.sync.stage==='epg'){state.sync={...state.sync,stage:'seal',seal:{phase:'ledger'},updatedAt:at(state.now())};return {body:{runId:state.sync.runId,stage:'seal',seal:{phase:'ledger'}}};}
  if(busy){busy=false;return {body:{runId:state.sync.runId,stage:'seal',discovery:{state:'busy',nextAction:'wait',reason:'busy',nextCatchUpAt:at(state.now()+3*MIN)}}};}
  const order=['ledger','catalog','publish','finalize','queue'],index=order.indexOf(state.sync.seal.phase);
  if(index<order.length-1){state.sync={...state.sync,seal:{phase:order[index+1]},updatedAt:at(state.now())};return {body:{runId:state.sync.runId,stage:'seal',seal:{phase:order[index+1]}}};}
  state.sync={...state.sync,stage:'complete',updatedAt:at(state.now())};delete state.sync.seal;
  return {body:{runId:state.sync.runId,stage:'complete',discovery:{state:'paused',reason:'epg_committed'}}};
 };
}
// A clock the Workflow loop advances: step.sleepUntil moves it to the wake time.
function runner(h,{startAt}){
 let now=startAt;h.state.now=()=>now;
 const log=[];
 const step={
  async do(name,fn){log.push(name);now+=1000;return await fn();},
  async sleepUntil(name,date){log.push(name);now=Math.max(now,date.getTime());},
 };
 return {step,log,clock:()=>now,advance:ms=>{now+=ms;}};
}

// 7. A whole run: start, metadata, EPG, a busy seal, publication, handoff. One Madrid date, one publication.
{
 const h=cloudflare({pipeline:pipeline({metadataSteps:2,busyOnce:true})});
 const {epg,env,state}=h;
 const due=Date.parse('2026-11-07T16:00:00Z');
 const r=runner(h,{startAt:due});
 const created=await epg.ensure(env,{now:due});assert.equal(created.started,true);
 const outcome=await epg.run(env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 eq(outcome,{stopped:true,reason:'complete',instanceId:'epg_20261107_0'});
 const done=await control(h);
 assert.equal(done.phase,'stopped'.length?done.phase:'');assert.ok(done.doneAt);assert.equal(done.publishedRunId,'run-1');assert.equal(done.runId,'run-1');
 assert.equal(done.failure,null);assert.ok(done.lastDurableProgressAt);
 const paths=state.calls.map(c=>c.pathname);
 assert.equal(paths.filter(p=>p==='/api/sync/start').length,1,'one run is started');
 assert.deepEqual(paths.slice(0,3),['/api/sync/start','/api/sync/metadata','/api/sync/metadata']);
 assert.ok(paths.includes('/api/sync/epg'));
 assert.ok(state.calls.every(c=>c.caller==='internal'),'every call is the in-process executor caller');
 assert.ok(state.calls.every(c=>c.fence&&c.fence.revision===1),'every call carries the mode revision it was admitted with');
 assert.ok(r.log.some(n=>n.startsWith('sleep')),'a busy seal sleeps until its own catch-up time and does not spin');
 assert.ok(r.log.filter(n=>n.startsWith('act')).length<=14);
 // A second ensure on the same date starts nothing: the date is done.
 eq(await epg.ensure(env,{now:r.clock()}),{started:false,reason:'complete'});
 const model=await epg.readModel(env,r.clock());
 assert.equal(model.health,'healthy');assert.equal(model.published,'run-1');assert.equal(model.mode,'cloudflare');assert.equal(model.sideEffects,'none');
}

// 8. Read-after-unknown: a run of this date that already completed (someone else drove it, or the control write was lost) is the
// success. The executor starts nothing and publishes nothing.
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 const h=cloudflare({sync:{runId:'earlier',stage:'complete',startedAt:at(due+5*MIN),updatedAt:at(due+9*MIN)},pipeline:()=>{throw new Error('the pipeline must not be called');}});
 await h.epg.ensure(h.env,{now:due+20*MIN});
 const r=runner(h,{startAt:due+20*MIN});h.state.now=r.clock;
 const outcome=await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 assert.equal(outcome.reason,'complete');assert.equal(h.state.calls.length,0);
 assert.equal((await control(h)).publishedRunId,'earlier');
}

// 9. Failures by class: a transient one cools down and retries, a repeated one quarantines, an unsafe one quarantines at once and a
// permanent one stops. Nothing repeats a publication blind.
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 // A transient source failure (thrown by the step): cooldown, then the run resumes by the same runId and finishes.
 let thrown=false;
 const flaky=async(pathname,body,state,env)=>{
  if(pathname==='/api/sync/epg'&&!thrown){thrown=true;throw new Error('EPG source fetch failed: network');}
  return base(pathname,body,state,env);
 };
 const base=pipeline({metadataSteps:0});
 const h=cloudflare({pipeline:(...args)=>flaky(...args)});
 const r=runner(h,{startAt:due});
 await h.epg.ensure(h.env,{now:due});
 const outcome=await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 assert.equal(outcome.reason,'complete');
 assert.equal(h.state.calls.filter(c=>c.pathname==='/api/sync/start').length,1,'the retry resumes the same run, it does not start another');
 assert.ok(r.log.some(n=>n.startsWith('sleep')));
 const rec=await control(h);assert.equal(rec.budget.consecutive,0,'progress resets the consecutive count');assert.ok(rec.budget.total>=1);
}
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 // An unsafe answer (the run id the pipeline holds is not ours): quarantine at once, the run stops, the date is blocked.
 const h=cloudflare({pipeline:pipeline({metadataSteps:0,fail:{at:2,reply:{status:409,body:{error:'Run id mismatch'}}}})});
 const r=runner(h,{startAt:due});
 await h.epg.ensure(h.env,{now:due});
 const outcome=await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 assert.notEqual(outcome.reason,'complete');
 const rec=await control(h);assert.ok(rec.quarantine,'an unsafe failure quarantines');assert.equal(rec.failure.class,'unsafe');assert.equal(rec.failure.code,'owner_conflict');
 eq(await h.epg.ensure(h.env,{now:due+H}),{started:false,reason:'quarantined',scope:'domain'});
 // The owner clears it by an explicit action that runs no step; the next ensure may start a successor.
 const calls=h.state.calls.length;
 eq(await h.epg.clearQuarantine(h.env,due+H),{action:'clear_quarantine',cleared:{control:true}});
 assert.equal(h.state.calls.length,calls);
 assert.equal((await control(h)).quarantine,null);
}
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 // A published generation that changed under the executor is a stale generation write: unsafe, never retried in the run.
 const h=cloudflare({pipeline:pipeline({metadataSteps:0,fail:{at:2,reply:{body:{runId:'run-1',stage:'seal',discovery:{state:'error',reason:'programme_changed'}}}}})});
 const r=runner(h,{startAt:due});
 await h.epg.ensure(h.env,{now:due});
 await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 const rec=await control(h);assert.equal(rec.failure.code,'stale_generation_write');assert.ok(rec.quarantine);
}
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 // A repeating transient failure reaches the cap and quarantines (the same fault at the same point).
 const h=cloudflare({pipeline:async()=>{throw new Error('Watchlist fetch: network down');}});
 const r=runner(h,{startAt:due});
 await h.epg.ensure(h.env,{now:due});
 const outcome=await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},r.step,{now:r.clock,clock:r.clock,random:()=>0.5});
 assert.notEqual(outcome.reason,'complete');
 const rec=await control(h);assert.ok(rec.quarantine,'the retry budget is bounded');assert.equal(rec.budget.consecutive,Policy.BUDGET_CAPS.consecutive);
 assert.equal(h.state.calls.length,Policy.BUDGET_CAPS.consecutive,'exactly the budget, no more');
}

// 10. Stale instances and the fence: an instance of an old epoch, another series or a rolled day writes nothing; the owner closing
// admission mid-run stops the instance at its next action; a commit under an old mode revision is refused with the data.
{
 const due=Date.parse('2026-11-07T16:00:00Z');
 const h=cloudflare({pipeline:pipeline({metadataSteps:3})});
 const r=runner(h,{startAt:due});
 await h.epg.ensure(h.env,{now:due});
 // Another series is not this instance.
 eq(await h.epg.run(h.env,{runKey:'2026-11-07',series:5,epoch:1},r.step,{now:r.clock,clock:r.clock}),{stopped:true,reason:'not_owner',instanceId:'epg_20261107_5'});
 // An old epoch.
 eq(await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:0},r.step,{now:r.clock,clock:r.clock}),{stopped:true,reason:'epoch_mismatch',instanceId:'epg_20261107_0'});
 assert.equal(h.state.calls.length,0,'a stale instance calls nothing');
 // A bad payload.
 eq(await h.epg.run(h.env,{},r.step,{now:r.clock}),{stopped:true,reason:'invalid_payload'});
 // The date rolls: stop, record nothing blind.
 const late=runner(h,{startAt:Date.parse('2026-11-08T08:00:00Z')});
 eq(await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},late.step,{now:late.clock,clock:late.clock}),{stopped:true,reason:'day_rolled',instanceId:'epg_20261107_0'});
 // The owner closes admission after the first action: the instance stops at the next admission and the mode record is unchanged by it.
 let actions=0;
 const mid=runner(h,{startAt:due});
 const step={do:async(name,fn)=>{mid.log.push(name);if(name.startsWith('act-')&&++actions===2)await h.epg.switchMode(h.env,{action:'close_admission',target:'external'},mid.clock());return fn();},sleepUntil:mid.step.sleepUntil};
 const outcome=await h.epg.run(h.env,{runKey:'2026-11-07',series:0,epoch:1},step,{now:mid.clock,clock:mid.clock,random:()=>0.5});
 assert.equal(outcome.reason,'switch_in_progress');
 assert.equal((await h.epg.readMode(h.env)).record.mode,'switching');
 const callsAtStop=h.state.calls.length;
 assert.ok(callsAtStop<=2,'no pipeline call after the switch');
}

// 11. The fence inside the published-EPG commit batch, on a real D1 stand-in: a commit under the mode revision it was admitted
// with lands; under an old revision, or with the mode document created in between, it is refused with the data.
{
 const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority'];
 const open=()=>{
  const db=d1Standin(path.join(root,'fence-'+(databases++)+'.sqlite'));
  for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
  db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
  db.sql(migration.match(/CREATE TABLE epg_orchestration_document \([\s\S]*?\) STRICT;/)[0]);
  return db;
 };
 const film=id=>({id,title:id,shows:[]});
 const input=(run,expected)=>({programmeRunId:run,phase:'published',expectedProgrammeRunId:expected,programme:{runId:run,updatedAt:'2026-11-07T16:00:00.000Z',watchlistCount:1,films:[film('film:a')]},watchlist:{updatedAt:'2026-11-07T16:00:00.000Z',films:[film('film:a')]}});
 const setMode=(db,revision)=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"epoch\":1}',"+revision+",'x')");
 const pointer=db=>one(db,'SELECT programme_run_id FROM published_epg_authority WHERE id=1');
 {
  const db=open();setMode(db,1);
  const done=await PublishedEpg.publishGeneration({DB:db},input('run-a',null),{now:0,epgFence:{revision:1}});
  assert.equal(done.pointed,true);assert.equal(pointer(db),'run-a','a commit under the admitted revision lands');
 }
 {
  const db=open();setMode(db,2);
  await assert.rejects(PublishedEpg.publishGeneration({DB:db},input('run-a',null),{now:0,epgFence:{revision:1}}),/published_epg_fence/,'a commit under an old revision is refused');
  assert.equal(pointer(db),null,'and nothing of it was written');
  assert.equal(one(db,'SELECT COUNT(*) FROM published_epg_generation'),0);
 }
 {
  // The fence rides on the env, as the executor and the external path pass it.
  const db=open();setMode(db,3);
  await assert.rejects(PublishedEpg.publishGeneration({DB:db,epgFence:{revision:2}},input('run-a',null),{now:0}),/published_epg_fence/);
  const ok=await PublishedEpg.publishGeneration({DB:db,epgFence:{revision:3}},input('run-a',null),{now:0});
  assert.equal(ok.pointed,true);
 }
 {
  // `revision: null` asserts that the mode document does not exist: the default external mode. Created in between, it refuses.
  const db=open();
  const ok=await PublishedEpg.publishGeneration({DB:db},input('run-a',null),{now:0,epgFence:{revision:null}});
  assert.equal(ok.pointed,true,'no mode document: the external path commits');
  const db2=open();setMode(db2,1);
  await assert.rejects(PublishedEpg.publishGeneration({DB:db2},input('run-a',null),{now:0,epgFence:{revision:null}}),/published_epg_fence/,'a switch that closed admission in between refuses it');
  assert.equal(pointer(db2),null);
 }
 {
  // No fence passed: the pre-AIR-348 behaviour is unchanged (and works without the table).
  const db=d1Standin(path.join(root,'plain-'+(databases++)+'.sqlite'));
  for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
  db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
  const ok=await PublishedEpg.publishGeneration({DB:db},input('run-a',null),{now:0});
  assert.equal(ok.pointed,true);
 }
 {
  // A malformed fence is refused before anything is written.
  const db=open();setMode(db,1);
  await assert.rejects(PublishedEpg.publishGeneration({DB:db},input('run-a',null),{now:0,epgFence:{revision:'x'}}),/published_epg_fence/);
  assert.equal(pointer(db),null);
 }
}

// 12. The external path in the Worker: a step through postSync is refused with the reason and writes nothing once admission is closed.
{
 const db=database();
 const wf=binding();
 const h=load({pipeline:idle,workflow:wf,db});
 const gateFor=async()=>h.epg.externalGate(h.env);
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify({schemaVersion:1,mode:'switching',from:'external',target:'cloudflare',epoch:1,drain:null})+"',1,'x')");
 eq(await gateFor(),{reason:'switch_in_progress',fence:null});
 db.sql("UPDATE epg_orchestration_document SET body='"+JSON.stringify({schemaVersion:1,mode:'cloudflare',epoch:1,drain:'verified'})+"', revision=2 WHERE key='mode'");
 eq(await gateFor(),{reason:'external_writer_fenced',fence:null});
 db.sql("UPDATE epg_orchestration_document SET body='"+JSON.stringify({mode:'bogus',epoch:1})+"' WHERE key='mode'");
 assert.equal((await gateFor()).reason,'evidence_unreadable','an unreadable mode document fails closed');
 const worker=fs.readFileSync('src/worker.js','utf8');
 const guard=worker.slice(worker.indexOf("async function postSync("),worker.indexOf("async function syncStep("));
 assert.match(guard,/caller!=='internal'&&typeof EpgOrchestration!=='undefined'/);
 assert.match(guard,/if\(gate\.reason\)return json\(\{[^}]*nextAction:'stop'[^}]*\},409\)/);
 assert.ok(guard.indexOf('externalGate')<guard.indexOf("beginSync(env)"),'the gate runs before the first write of a start');
 assert.ok(guard.indexOf('externalGate')<guard.indexOf('openContinuationStep'),'and before a step records anything');
}

// 13. Cron coexistence: the executor's ensure, the projector, Ratings and the monitor are independent calls in one scheduled
// handler; a failing or slow one blocks none of the others, and `ensure` takes no long operation.
{
 const worker=fs.readFileSync('src/worker.js','utf8');
 const handler=worker.slice(worker.indexOf('async scheduled('),worker.indexOf('async fetch('));
 assert.match(handler,/Promise\.allSettled\(\[/);
 for(const name of ['runD1EnrichmentProjection','RatingsOrchestration.ensure','EpgOrchestration.ensure','reconcileDiscoveryWorkflow','Monitor.run'])assert.ok(handler.includes(name),name+' is in the tick');
 const h=cloudflare();
 h.env.EPG_WORKFLOW.create=async()=>{throw new Error('platform down');};
 const settled=await Promise.allSettled([h.epg.ensure(h.env,{now:Date.parse('2026-11-07T16:00:00Z')}),Promise.resolve('projector'),Promise.resolve('monitor')]);
 assert.equal(settled[0].status,'fulfilled','a failing create is reported by value, never thrown into the tick');
 assert.equal(settled[1].value,'projector');assert.equal(settled[2].value,'monitor');
}
console.log('epg-orchestration: ok');
