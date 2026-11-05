// AIR-347 / ADR 0089: the Cloudflare executor of the daily ratings run. The pure policy (Madrid day key, DST, failure classes,
// budget, health); the owner's mode switch and the external writer's gate; `ensure` under duplicate firings; a whole run
// through the Workflow loop with an injected clock, random source and Workflow binding; the classified failures and the
// quarantines; the read model; and the epoch fence on a real D1 stand-in. No network and no Cloudflare.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Policy from '../src/domain/orchestration-policy.js';
import * as RatingsD1 from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPage,diaryRow,migrated,RUN,SEPARATE,H,MIN,DAY,plain,g} from './ratings-harness.mjs';

const MODE='letterboxd/ratings/executor.json',CONTROL='letterboxd/ratings/orchestration.json';
const at=ms=>new Date(ms).toISOString();
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);

// The pure module's own source is free of I/O, a clock and randomness.
assert.doesNotMatch(fs.readFileSync('src/domain/orchestration-policy.js','utf8'),/\b(fetch|BUCKET|import|require|Date\.now|new Date\(\)|Math\.random|crypto)\b/);

// 1. Policy: the Madrid day key and the 17:30 schedule on the two DST change days and either side of them.
{
 // CEST (UTC+2): 17:30 is 15:30Z. CET (UTC+1): 17:30 is 16:30Z.
 const cases=[['2026-10-24T15:29:59Z','2026-10-24',false],['2026-10-24T15:30:00Z','2026-10-24',true],['2026-10-26T15:30:00Z','2026-10-26',false],['2026-10-26T16:30:00Z','2026-10-26',true],
  ['2026-03-28T16:29:59Z','2026-03-28',false],['2026-03-28T16:30:00Z','2026-03-28',true],['2026-03-30T15:29:59Z','2026-03-30',false],['2026-03-30T15:30:00Z','2026-03-30',true]];
 for(const [time,day,due] of cases){const result=Policy.dailyDue(Date.parse(time));assert.equal(result.dayKey,day,time);assert.equal(result.due,due,time);}
 // The change days: fall back on 2026-10-25 (03:00 CEST to 02:00 CET), spring forward on 2026-03-29 (02:00 CET to 03:00 CEST).
 assert.equal(at(Policy.madridInstant('2026-10-25',17,30)),'2026-10-25T16:30:00.000Z');
 assert.equal(at(Policy.madridInstant('2026-03-29',17,30)),'2026-03-29T15:30:00.000Z');
 for(const day of ['2026-10-25','2026-03-29']){
  const dueAt=Policy.madridInstant(day,17,30);
  assert.equal(Policy.dailyDue(dueAt).dayKey,day);assert.equal(Policy.dailyDue(dueAt-1).due,false);
  assert.equal(Policy.madridDayKey(dueAt+6*H),day,'late catch-up the same local date');
  assert.notEqual(Policy.madridDayKey(dueAt+8*H),day,'the next local date is another run key');
 }
 // Late evening UTC is already the next Madrid date.
 assert.equal(Policy.madridDayKey(Date.parse('2026-07-01T22:30:00Z')),'2026-07-02');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-10-24T15:30:00Z'))),'2026-10-25T16:30:00.000Z');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-10-24T10:00:00Z'))),'2026-10-24T15:30:00.000Z');
}

// 2. Policy: failure classes, the budget, cooldowns, caps, progress and health.
{
 assert.equal(Policy.failureClass('upstream_blocked'),'transient');assert.equal(Policy.failureClass('config_invalid'),'permanent');assert.equal(Policy.failureClass('epoch_mismatch'),'unsafe');
 for(const code of ['d1_unavailable','step_failed'])assert.equal(Policy.failureClass(code),'transient');
 assert.throws(()=>Policy.failureClass('whatever'),/unknown failure code/,'a code outside the contract is refused');
 const low=()=>0,mid=()=>0.5,high=()=>1;
 assert.deepEqual([1,2,3,4,9].map(n=>Policy.cooldownMs(n,mid)),[60000,300000,900000,3600000,3600000]);
 assert.equal(Policy.cooldownMs(1,low),48000);assert.equal(Policy.cooldownMs(1,high),72000);
 const now=Date.parse('2026-10-24T16:00:00Z');
 let budget=Policy.emptyBudget(),states=[];
 for(let n=1;n<=5;n++){
  const applied=Policy.applyFailure(budget,{code:'network_error'},{now,phase:'diary',checkpoint:'k',random:mid});
  budget=applied.budget;states.push([budget.consecutive,applied.cooldownUntil?at(Date.parse(applied.cooldownUntil)-now):null,applied.quarantine]);
 }
 eq(states.map(item=>item[0]),[1,2,3,4,5]);
 eq(states.slice(0,4).map(item=>item[1]),['1970-01-01T00:01:00.000Z','1970-01-01T00:05:00.000Z','1970-01-01T00:15:00.000Z','1970-01-01T01:00:00.000Z']);
 eq(states[4][2],{scope:'run',reason:'budget_exhausted'},'the fifth consecutive failure quarantines the run key');
 assert.equal(budget.fingerprint,'transient|network_error|diary|k');
 // A later Retry-After wins; an earlier one does not shorten the cooldown.
 const later=Policy.applyFailure(Policy.emptyBudget(),{code:'rate_limited'},{now,retryAfterAt:now+6*H,random:mid});
 assert.equal(Date.parse(later.cooldownUntil),now+6*H);
 assert.equal(Date.parse(Policy.applyFailure(Policy.emptyBudget(),{code:'rate_limited'},{now,retryAfterAt:now+1000,random:mid}).cooldownUntil),now+60000);
 // The total cap is separate from the consecutive cap, and progress resets only the consecutive count.
 let total={consecutive:0,total:11,fingerprint:null,lastFailureAt:null};
 eq(Policy.applyFailure(total,{code:'timeout'},{now}).quarantine,{scope:'run',reason:'budget_exhausted'});
 eq(Policy.applyProgress({consecutive:4,total:7,fingerprint:'x',lastFailureAt:'y'}),{consecutive:0,total:7,fingerprint:'x',lastFailureAt:'y'});
 // Unsafe quarantines the domain at once; permanent is not counted and quarantines nothing.
 eq(Policy.applyFailure(Policy.emptyBudget(),{code:'epoch_mismatch'},{now}).quarantine,{scope:'domain',reason:'epoch_mismatch'});
 const permanent=Policy.applyFailure(Policy.emptyBudget(),{code:'config_invalid'},{now});
 assert.equal(permanent.budget.consecutive,0);assert.equal(permanent.quarantine,null);assert.equal(permanent.cooldownUntil,null);
 // Health.
 const dueAt=now-1*H;
 const health=input=>Policy.deriveHealth({now,dueAt,done:false,quarantine:null,permanent:false,cooldownUntil:null,nextWakeAt:null,lastDurableProgressAt:null,...input});
 assert.equal(health({dueAt:now+H}),'idle');assert.equal(health({}),'healthy');assert.equal(health({done:true}),'healthy');
 assert.equal(health({dueAt:now-3*H}),'stalled');assert.equal(health({dueAt:now-3*H,lastDurableProgressAt:at(now-30*MIN)}),'healthy');
 assert.equal(health({dueAt:now-3*H,cooldownUntil:at(now+MIN)}),'cooldown');assert.equal(health({dueAt:now-3*H,nextWakeAt:at(now+MIN)}),'waiting');
 assert.equal(health({quarantine:{scope:'run'}}),'quarantined');assert.equal(health({permanent:true}),'failed_permanent');
}

// A Worker context with the executor, a stubbed ratings authority and a fake Workflow binding.
const T0=Date.parse('2026-10-24T15:31:00Z');
function fakeWorkflow(){
 const binding={instances:new Map(),creates:[],status:null,failNext:null,
  async create({id,params}){
   if(binding.failNext){const error=binding.failNext;binding.failNext=null;throw error;}
   if(binding.instances.has(id))throw Object.assign(new Error('instance already exists'),{name:'WorkflowError'});
   binding.instances.set(id,{params,status:'running'});binding.creates.push({id,params});return {id};
  },
  async get(id){
   if(binding.status==='throw')throw new Error('platform unreadable');
   if(!binding.instances.has(id))throw new Error('instance not found');
   return {id,status:async()=>({status:binding.status||binding.instances.get(id).status})};
  }};
 return binding;
}
function setup({start=T0,pages=1}={}){
 const {clock,FakeDate,crypto}=makeClock(start),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const authority={ready:true,error:false};
 ctx.RatingsD1=new Proxy({},{get:(_,key)=>key==='ratingsMutableKey'?()=>false:key==='ratingsGate'?async()=>({ready:authority.ready,generation:1,error:authority.error}):async()=>({owned:false,handled:false,changed:0})});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+fs.readFileSync('src/ratings-orchestration.js','utf8'),ctx);
 const workflow=fakeWorkflow();
 const env=baseEnv(bucket,{...SEPARATE,RATINGS_WORKFLOW:workflow});
 migrated(bucket);
 if(pages)net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-24','99001')],false));
 const step={log:[],async do(name,fn){const value=await fn();step.log.push(['do',name,plain(value)]);return JSON.parse(JSON.stringify(value));},async sleepUntil(name,date){step.log.push(['sleep',name,date.toISOString()]);clock.now=Math.max(clock.now,date.getTime());}};
 const hooks={now:()=>clock.now,clock:()=>clock.now,random:()=>0.5};
 return {clock,net,bucket,ctx,env,authority,workflow,step,hooks,RO:g(ctx,'RatingsOrchestration'),R:g(ctx,'LetterboxdRatings')};
}
async function activate(world,epoch=1){
 const {RO,env,clock}=world;
 eq((await RO.switchMode(env,{action:'close_admission',target:'cloudflare'},clock.now)).closed,true);
 const done=plain(await RO.switchMode(env,{action:'complete'},clock.now));
 assert.equal(done.completed,true);assert.equal(done.epoch,epoch);
}
const control=world=>world.bucket.value(CONTROL);
const modeDoc=world=>world.bucket.value(MODE);

// 3. Inert by default: no mode document means external. `ensure` reads one document and creates nothing.
{
 const w=setup();
 eq(await w.RO.ensure(w.env,{now:w.clock.now}),{started:false,reason:'external'});
 assert.equal(w.workflow.creates.length,0);assert.equal(w.bucket.writes().length,0,'nothing is written');assert.equal(w.net.fetches.length,0);
 const status=plain(await w.R.status(w.env));
 assert.equal(status.orchestration.mode,'external');assert.equal(status.orchestration.epoch,0);assert.equal(status.sideEffects,'none');
 // The external path is open: a start is not fenced.
 assert.equal(plain(await w.R.handle(w.env,'start',{trigger:'manual'})).body.reason,'started');
 // A malformed mode document fails closed on both paths.
 const m=setup();m.bucket.set(MODE,{schemaVersion:1,mode:'banana',epoch:0});
 eq(await m.RO.ensure(m.env,{now:m.clock.now}),{started:false,reason:'evidence_unreadable'});
 assert.equal(plain(await m.R.handle(m.env,'start',{trigger:'manual'})).body.reason,'evidence_unreadable');
 assert.equal(m.bucket.writes().length,0);
}

// 4. The owner's mode switch (decision 2a): close admission, verified drain, complete. And the external writer's gate (T18, T25).
{
 const w=setup();
 await w.R.start(w.env,{trigger:'scheduled'});// a live external run record without a step in flight
 assert.equal((await w.RO.handle(w.env,{action:'nope'})).status,400);assert.equal((await w.RO.handle(w.env,{action:'close_admission'})).status,400);
 assert.equal((await w.RO.handle(w.env,{action:'close_admission',target:'x'})).status,400);assert.equal((await w.RO.handle(w.env,{action:'complete',extra:1})).status,400);
 const closed=plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'cloudflare'},w.clock.now));
 eq(closed,{action:'close_admission',closed:true,mode:'switching',target:'cloudflare',epoch:1});
 eq(plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'cloudflare'},w.clock.now)).refused,'switch_open');
 // Admission is closed for both writers: nothing is written, nothing is requested.
 const before=JSON.stringify(w.bucket.snapshot()),fetches=w.net.fetches.length;
 const start=plain(await w.R.handle(w.env,'start',{trigger:'scheduled'}));eq(start.body,{runId:null,created:false,nextAction:'stop',reason:'switch_in_progress'});
 const stepReply=plain(await w.R.handle(w.env,'step',{runId:'x'}));assert.equal(stepReply.body.reason,'switch_in_progress');assert.equal(stepReply.body.nextAction,'stop');
 eq(await w.RO.ensure(w.env,{now:w.clock.now}),{started:false,reason:'switch_in_progress'});
 assert.equal(JSON.stringify(w.bucket.snapshot()),before);assert.equal(w.net.fetches.length,fetches);
 assert.equal(plain(await w.R.status(w.env)).orchestration.mode,'switching','reads stay open');
 // T25: a live step lease blocks the completion; the drain state is recorded and the mode stays switching.
 const run=w.bucket.value(RUN);w.bucket.set(RUN,{...run,lease:{step:'s-live',expiresAt:at(w.clock.now+MIN)}});
 let refused=plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now));
 eq([refused.refused,refused.drain,refused.mode],['drain_not_verified','lease_live','switching']);
 assert.equal(modeDoc(w).drain,'lease_live');
 // An expired lease is not enough: the margin is the longest step wall time.
 w.bucket.set(RUN,{...run,lease:{step:'s-old',expiresAt:at(w.clock.now-MIN)}});
 assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).drain,'lease_live');
 w.bucket.set(RUN,{...run,lease:{step:'s-old',expiresAt:'not a date'}});
 assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).drain,'unreadable');
 // A live Workflow instance blocks it too.
 w.bucket.set(RUN,{...run,lease:{step:null,expiresAt:null}});
 w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-10-24',series:0,instanceId:'ratings_20261024_0',phase:'running',budget:Policy.emptyBudget()});
 w.workflow.instances.set('ratings_20261024_0',{status:'running'});
 assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).drain,'instance_live');
 w.workflow.status='throw';assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).drain,'unreadable','an unreadable instance is not a drained one');
 w.workflow.status='complete';
 const completed=plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now+10*MIN));
 eq([completed.completed,completed.mode,completed.epoch,completed.drain],[true,'cloudflare',1,'verified']);
 // T18: the external writer is fenced whatever an old prompt sends; reads and the status stay open.
 const fencedStart=plain(await w.R.handle(w.env,'start',{trigger:'scheduled'}));eq(fencedStart.body,{runId:null,created:false,nextAction:'stop',reason:'external_writer_fenced'});
 const fencedStep=plain(await w.R.handle(w.env,'step',{runId:'abc'}));assert.equal(fencedStep.body.reason,'external_writer_fenced');assert.equal(fencedStep.body.runId,'abc');
 assert.equal(plain(await w.R.status(w.env)).orchestration.mode,'cloudflare');
 // Rollback is the same protocol the other way: close admission (epoch 2), verified drain, then the external path is allowed.
 eq(plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'external'},w.clock.now)).epoch,2);
 assert.equal(plain(await w.R.handle(w.env,'start',{trigger:'manual'})).body.reason,'switch_in_progress');
 assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now+20*MIN)).mode,'external');
 assert.notEqual(plain(await w.R.handle(w.env,'start',{trigger:'manual'})).body.reason,'external_writer_fenced');
}

// 5. `ensure`: one run per Madrid date under duplicate and overlapping firings (T06), not before 17:30, and across DST (T17).
{
 const w=setup({start:Date.parse('2026-10-24T15:29:00Z')});
 await activate(w);
 const early=plain(await w.RO.ensure(w.env,{now:w.clock.now}));eq([early.started,early.reason],[false,'not_due']);
 assert.equal(early.dueAt,'2026-10-24T15:30:00.000Z');
 // Two overlapping firings after 17:30: one wins the compare-and-swap on the control record, one create is made.
 w.clock.now=Date.parse('2026-10-24T15:37:00Z');
 const both=plain(await Promise.all([w.RO.ensure(w.env,{now:w.clock.now}),w.RO.ensure(w.env,{now:w.clock.now})]));
 assert.equal(both.filter(item=>item.started).length,1);assert.equal(both.filter(item=>item.reason==='write_conflict').length,1);
 assert.equal(w.workflow.creates.length,1);eq(w.workflow.creates[0],{id:'ratings_20261024_0',params:{runKey:'2026-10-24',series:0,epoch:1}});
 const claimed=control(w);eq([claimed.runKey,claimed.series,claimed.instanceId,claimed.epoch,claimed.phase],['2026-10-24',0,'ratings_20261024_0',1,'starting']);
 // A later firing attaches: the instance is alive, nothing is created.
 const again=plain(await w.RO.ensure(w.env,{now:w.clock.now+H}));eq([again.started,again.reason],[false,'in_progress']);assert.equal(w.workflow.creates.length,1);
 // A lost create response whose instance exists attaches without a second id.
 const lost=setup({start:T0});await activate(lost);
 lost.workflow.failNext=new Error('timeout reading the create response');lost.workflow.instances.set('ratings_20261024_0',{status:'running'});
 const attached=plain(await lost.RO.ensure(lost.env,{now:lost.clock.now}));eq([attached.started,attached.attached],[true,true]);assert.equal(lost.workflow.creates.length,0);
 // A failed create whose instance is absent is a counted transient failure, then a cooldown.
 const uncertain=setup({start:T0});await activate(uncertain);uncertain.workflow.failNext=new Error('platform error');
 eq(plain(await uncertain.RO.ensure(uncertain.env,{now:uncertain.clock.now})).reason,'create_uncertain');
 const doc=control(uncertain);eq([doc.failure.code,doc.budget.consecutive,doc.phase],['create_uncertain',1,'stopped']);
 eq(plain(await uncertain.RO.ensure(uncertain.env,{now:uncertain.clock.now+10*1000})).reason,'cooldown');
 // The DST change days: exactly one run key per Madrid date, and the next date is a new key.
 for(const [day,dueZ] of [['2026-10-25','2026-10-25T16:30:00Z'],['2026-03-29','2026-03-29T15:30:00Z']]){
  const d=setup({start:Date.parse(dueZ)-1000});await activate(d);
  assert.equal(plain(await d.RO.ensure(d.env,{now:Date.parse(dueZ)-1000})).reason,'not_due',day);
  for(const offset of [0,2*H,5*H])await d.RO.ensure(d.env,{now:Date.parse(dueZ)+offset});
  assert.equal(d.workflow.creates.length,1,day);assert.equal(d.workflow.creates[0].params.runKey,day);
  await d.RO.ensure(d.env,{now:Date.parse(dueZ)+DAY+MIN});
  assert.equal(d.workflow.creates.length,2,'the next Madrid date starts its own run');assert.notEqual(d.workflow.creates[1].params.runKey,day);
 }
 // A platform-ended instance with an unfinished run: a counted transient failure, then a successor under the same date.
 const dead=setup({start:T0});await activate(dead);await dead.RO.ensure(dead.env,{now:dead.clock.now});
 dead.workflow.instances.get('ratings_20261024_0').status='terminated';
 const reconciled=plain(await dead.RO.ensure(dead.env,{now:dead.clock.now+MIN}));eq([reconciled.reason,reconciled.recorded],['cooldown','instance_terminated']);
 const successor=plain(await dead.RO.ensure(dead.env,{now:dead.clock.now+3*MIN}));eq([successor.started,successor.series],[true,1]);
 eq(dead.workflow.creates.map(item=>item.id),['ratings_20261024_0','ratings_20261024_1']);
 // An unreadable platform status does nothing.
 dead.workflow.status='throw';eq(plain(await dead.RO.ensure(dead.env,{now:dead.clock.now+4*MIN})).reason,'status_unknown');
 // No D1 ratings authority: nothing starts.
 const held=setup({start:T0});await activate(held);held.authority.ready=false;
 eq(plain(await held.RO.ensure(held.env,{now:held.clock.now})).reason,'authority_held');held.authority.ready=true;held.authority.error=true;
 eq(plain(await held.RO.ensure(held.env,{now:held.clock.now})).reason,'d1_unavailable');
 assert.equal(held.workflow.creates.length,0);
}

// 6. A whole run through the Workflow loop: Diary page 1 only, durable progress, then the date is done and nothing repeats.
async function started(w){await activate(w);const result=plain(await w.RO.ensure(w.env,{now:w.clock.now}));assert.equal(result.started,true);return {runKey:result.runKey,series:result.series,epoch:1};}
{
 const w=setup();const payload=await started(w);
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));
 eq([outcome.stopped,outcome.reason],[true,'complete']);
 assert.equal(w.net.diaryFetches().length,1,'Diary page 1 only');
 const doc=control(w);assert.ok(doc.doneAt);eq([doc.phase,doc.budget.consecutive,doc.quarantine,doc.failure],['done',0,null,null]);
 assert.ok(doc.lastDurableProgressAt);assert.equal(plain(w.bucket.value(RUN)).state,'finished');
 // The instance does not create another run once the date is done, and ensure leaves it alone.
 eq(plain(await w.RO.ensure(w.env,{now:w.clock.now+H})),{started:false,reason:'complete'});
 const fetches=w.net.fetches.length;
 eq([plain(await w.RO.act(w.env,{...payload,id:'ratings_20261024_0',now:()=>w.clock.now,random:()=>0.5}))].map(item=>item.kind),['stop']);
 assert.equal(w.net.fetches.length,fetches);
 const model=plain(await w.RO.readModel(w.env,w.clock.now));
 eq([model.mode,model.health,model.runKey,model.failure.consecutive,model.quarantine],['cloudflare','healthy','2026-10-24',0,null]);
 assert.equal(model.oldestPendingAt,null);
 // The run was started by the executor as a scheduled run, never as a manual one.
 assert.equal(plain(w.bucket.value(RUN)).trigger,'scheduled');
}

// 7. Read-after-unknown (T02, T04): a run of this date that already finished is the success, whoever wrote the checkpoint.
{
 const w=setup();const payload=await started(w);
 const started1=plain(await w.R.start(w.env,{trigger:'scheduled'},w.clock.now));
 let guard=0;for(;guard<5;guard++){const reply=plain(await w.R.step(w.env,{runId:started1.runId},{now:w.clock.now,clock:()=>w.clock.now}));if(reply.nextAction!=='continue')break;}
 assert.equal(plain(w.bucket.value(RUN)).state,'finished');const fetches=w.net.fetches.length;
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));
 eq([outcome.reason],['complete']);assert.equal(w.net.fetches.length,fetches,'no second run, no second page');
 assert.ok(control(w).doneAt);assert.equal(plain(w.bucket.value(RUN)).runId,started1.runId);
}

// 8. Letterboxd 403 cf-mitigated (T08): no bypass and no in-run retry; the run ends, the next Madrid date retries.
{
 const w=setup();w.net.diary.set(1,403);const payload=await started(w);
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));eq(outcome.reason,'blocked_until_next_date');
 assert.equal(w.net.diaryFetches().length,1,'one request, no retry inside the run');
 const doc=control(w);eq([doc.failure,doc.budget.consecutive,doc.budget.total,doc.phase,doc.stopReason],[{class:'transient',code:'upstream_blocked'},1,1,'stopped','blocked_until_next_date']);
 assert.equal(doc.quarantine,null);assert.equal(doc.nextWakeAt,at(Policy.nextDailyDue(w.clock.now)));
 eq(plain(await w.RO.ensure(w.env,{now:w.clock.now+H})).reason,'blocked_until_next_date');assert.equal(w.workflow.creates.length,1);
 // The next Madrid date starts with a fresh budget and the diary answers again.
 w.net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-25','99002')],false));
 const nextDue=Policy.madridInstant('2026-10-25',17,30)+MIN;w.clock.now=nextDue;
 const next=plain(await w.RO.ensure(w.env,{now:nextDue}));eq([next.started,next.runKey,next.series],[true,'2026-10-25',0]);
 const second=plain(await w.RO.run(w.env,{runKey:'2026-10-25',series:0,epoch:1},w.step,w.hooks));eq(second.reason,'complete');
 eq([control(w).budget.consecutive,control(w).budget.total],[0,0]);
}

// 9. 429 (T07): the six-hour pause is the cooldown; the same date retries after it, and a success clears the count (T15).
{
 const w=setup();w.net.diary.set(1,429);const payload=await started(w);
 w.hooks.now=()=>w.clock.now;
 const t429=w.clock.now;
 // Let the instance run until its first sleep, then serve the page.
 const sleeps=[];const realSleep=w.step.sleepUntil;w.step.sleepUntil=async(name,date)=>{sleeps.push(date.getTime());w.net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-24','99001')],false));return realSleep(name,date);};
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));eq(outcome.reason,'complete','the same Madrid date retries after the six-hour pause');
 assert.ok(sleeps[0]>=t429+6*H,'the cooldown is the later of the pause and the schedule');
 const doc=control(w);assert.equal(doc.failure,null);assert.equal(doc.budget.total,1);assert.equal(doc.budget.fingerprint.split('|')[1],'rate_limited');
 assert.equal(w.net.diaryFetches().length,2,'one 429, none during the pause, one after');
}

// 10. Transient failures within the date (T01, T15): the cooldown grows, a success resets the consecutive count only.
{
 const w=setup();w.net.hang=url=>url.includes('/diary/');const payload=await started(w);
 let calls=0;const realSleep=w.step.sleepUntil;
 w.step.sleepUntil=async(name,date)=>{calls++;if(calls===2)w.net.hang=null;return realSleep(name,date);};
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));eq(outcome.reason,'complete');
 const sleeps=w.step.log.filter(item=>item[0]==='sleep').map(item=>Date.parse(item[2]));
 assert.ok(sleeps[1]-sleeps[0]>=0);
 const doc=control(w);eq([doc.budget.consecutive,doc.budget.total],[0,2],'two failures, then durable progress: only the consecutive count resets');
 assert.ok(doc.doneAt);assert.equal(doc.failure,null);
 // The failed attempts left their own runs closed, never a half-written fact: one finished run for the date.
 assert.equal(plain(w.bucket.value(RUN)).state,'finished');
}

// 11. T09, T14: the same failure every time quarantines the run key at the fifth, with growing cooldowns; the next date is fresh.
{
 const w=setup();w.net.hang=url=>url.includes('/diary/');const payload=await started(w);
 const outcome=plain(await w.RO.run(w.env,payload,w.step,w.hooks));eq(outcome.reason,'budget_exhausted');
 const doc=control(w);eq([doc.budget.consecutive,doc.quarantine.scope,doc.quarantine.reason],[5,'run','budget_exhausted']);
 const waits=w.step.log.filter(item=>item[0]==='sleep').map(item=>Date.parse(item[2]));
 assert.equal(waits.length,4,'four cooldowns before the fifth failure quarantines');
 assert.match(doc.budget.fingerprint,/^transient\|network_error\|/);
 const model=plain(await w.RO.readModel(w.env,w.clock.now));eq([model.health,model.quarantine.scope],['quarantined','run']);
 eq(plain(await w.RO.ensure(w.env,{now:w.clock.now+H})),{started:false,reason:'quarantined',scope:'run'});
 w.net.hang=null;w.net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-25','99002')],false));
 const nextDay=Policy.madridInstant('2026-10-25',17,30)+MIN;w.clock.now=nextDay;
 eq(plain(await w.RO.ensure(w.env,{now:nextDay})).started,true);
 assert.equal(plain(await w.RO.run(w.env,{runKey:'2026-10-25',series:0,epoch:1},w.step,w.hooks)).reason,'complete');
}

// 12. T10, T11, unsafe states: a malformed control record, the pipeline's own isolation, a held authority and a missing migration.
{
 const w=setup();const payload=await started(w);
 w.bucket.set(CONTROL,{garbage:true});
 eq(plain(await w.RO.run(w.env,payload,w.step,w.hooks)).reason,'checkpoint_malformed');
 assert.equal(plain(await w.RO.readModel(w.env,w.clock.now)).health,'quarantined');
 eq(plain(await w.RO.ensure(w.env,{now:w.clock.now})).reason,'checkpoint_malformed');assert.equal(w.net.fetches.length,0);
 // Isolation: two interrupted runs at the same checkpoint isolate the pipeline; the executor quarantines the domain and never clears it.
 const iso=setup();const payload2=await started(iso);
 const run0=plain(await iso.R.start(iso.env,{trigger:'scheduled'},iso.clock.now));
 iso.bucket.set(RUN,{...iso.bucket.value(RUN),isolation:{since:at(iso.clock.now),phase:'diary',checkpoint:{},runIds:['a','b']},state:'error',cause:'failed'});
 const outcome=plain(await iso.RO.run(iso.env,payload2,iso.step,iso.hooks));eq(outcome.reason,'evidence_contradictory');
 eq([control(iso).quarantine.scope,control(iso).failure.class],['domain','unsafe']);
 // A new date does not clear a domain quarantine; the owner's explicit clear does, and runs no step.
 eq(plain(await iso.RO.ensure(iso.env,{now:Policy.madridInstant('2026-10-25',17,30)+MIN})),{started:false,reason:'quarantined',scope:'domain'});
 const fetches=iso.net.fetches.length;
 const cleared=plain(await iso.RO.handle(iso.env,{action:'clear_quarantine'}));eq(cleared.body.cleared,{run:true,control:true});
 assert.equal(iso.net.fetches.length,fetches,'clearing runs no step');assert.equal(iso.bucket.value(RUN).isolation,null);assert.equal(control(iso).quarantine,null);
 // Held authority after the instance started: stop, nothing written to the run.
 const held=setup();const payload3=await started(held);held.authority.ready=false;
 eq(plain(await held.RO.run(held.env,payload3,held.step,held.hooks)).reason,'authority_held');assert.equal(held.net.fetches.length,0);
 // D1 outage: a transient sleep with no write and no fetch.
 const down=setup();const payload4=await started(down);down.authority.error=true;
 const kind=plain(await down.RO.act(down.env,{...payload4,id:'ratings_20261024_0',now:()=>down.clock.now,random:()=>0.5}));eq([kind.kind,kind.reason],['sleep','d1_unavailable']);assert.equal(down.net.fetches.length,0);
 // Unmigrated storage is a permanent configuration failure: not counted, nothing started.
 const raw=setup();raw.bucket.records.delete('enrichment/removal-rating-lookups.json');const payload5=await started(raw);
 const permanent=plain(await raw.RO.run(raw.env,payload5,raw.step,raw.hooks));eq(permanent.reason,'config_invalid');
 eq([control(raw).failure,control(raw).budget.consecutive],[{class:'permanent',code:'config_invalid'},0]);assert.equal(raw.net.fetches.length,0);
}

// 13. Stale instances write nothing (T05, T19): another epoch, another owner, another date.
{
 const w=setup();const payload=await started(w);
 const ctxOf=extra=>({...payload,id:'ratings_20261024_0',now:()=>w.clock.now,random:()=>0.5,...extra});
 const before=JSON.stringify(w.bucket.snapshot());
 eq(plain(await w.RO.act(w.env,ctxOf({epoch:0}))).reason,'epoch_mismatch');
 eq(plain(await w.RO.act(w.env,ctxOf({id:'ratings_20261024_9',series:9}))).reason,'not_owner');
 eq(plain(await w.RO.act(w.env,ctxOf({runKey:'2026-10-23'}))).reason,'not_owner');
 assert.equal(JSON.stringify(w.bucket.snapshot()),before);assert.equal(w.net.fetches.length,0);
 // The date rolled over under a running instance: it stops and the next date is another run key.
 eq(plain(await w.RO.act(w.env,ctxOf({now:()=>w.clock.now+DAY}))).reason,'day_rolled');
 // An owner who closes admission stops the instance at its next ownership check, and an old payload epoch is refused after a switch back.
 await w.RO.switchMode(w.env,{action:'close_admission',target:'external'},w.clock.now);
 eq(plain(await w.RO.act(w.env,ctxOf({}))).reason,'switch_in_progress');
 assert.equal(w.net.fetches.length,0);
}

// 14. The read model: reads only, health by state (T21).
{
 const w=setup({start:Date.parse('2026-10-24T14:00:00Z')});
 const writes=()=>w.bucket.writes().length,base=writes();
 let model=plain(await w.RO.readModel(w.env,w.clock.now));eq([model.mode,model.health,model.oldestPendingAt],['external','idle',null]);
 // External mode after 17:30 with no finished run: healthy for two hours, then stalled; the monitor reads this.
 model=plain(await w.RO.readModel(w.env,Date.parse('2026-10-24T16:30:00Z')));eq([model.health,model.oldestPendingAt],['healthy','2026-10-24T15:30:00.000Z']);
 model=plain(await w.RO.readModel(w.env,Date.parse('2026-10-24T17:40:00Z')));assert.equal(model.health,'stalled');
 await w.R.start(w.env,{trigger:'scheduled'},w.clock.now);const afterStart=writes();
 model=plain(await w.RO.readModel(w.env,Date.parse('2026-10-24T17:40:00Z')));assert.equal(writes(),afterStart,'the read model writes nothing');
 assert.equal(base+0,base);assert.equal(model.sideEffects,'none');
 // The status route keeps its fields and adds `orchestration`.
 const status=plain(await w.R.status(w.env));assert.ok(status.orchestration);assert.equal(status.contractVersion,1);assert.equal(status.switch,'separate');
 // A failing read does not break the status.
 w.bucket.hooks.beforeGet=async key=>{if(key===MODE)throw new Error('read failed');};
 const broken=plain(await w.R.status(w.env));eq([broken.orchestration.health,broken.orchestration.failure.code],['unknown','evidence_unreadable']);assert.ok(broken.pipeline);
}

// 15. The epoch fence on a real D1 stand-in (T22, T24): a commit from a stale mode is refused in its own batch.
{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-ratings-orch-'));
 const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority'];
 const load=()=>{const db=d1Standin(path.join(root,'db-'+Math.random().toString(36).slice(2)+'.sqlite'));for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open'");return db;};
 const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
 // 15a. RatingsD1: a fenced put lands while the mode document is unchanged and is refused, with its data, once it changed.
 {
  const db=load(),env={DB:db};
  const first=await RatingsD1.putOwned(env,MODE,null,{schemaVersion:1,mode:'cloudflare',epoch:1,target:null,drain:null});assert.ok(first.saved);
  const etag=first.saved.etag,fenced={DB:db,ratingsFence:{key:MODE,etag}};
  const ok=await RatingsD1.putOwned(fenced,CONTROL,null,{schemaVersion:1,n:1});assert.ok(ok.saved,'admitted commit lands');
  const moved=await RatingsD1.putOwned(env,MODE,etag,{schemaVersion:1,mode:'switching',target:'external',epoch:2,drain:null});assert.ok(moved.saved);
  const stale=await RatingsD1.putOwned(fenced,CONTROL,ok.saved.etag,{schemaVersion:1,n:2});
  assert.equal(stale.saved,null,'the stale commit is refused');
  assert.equal((await RatingsD1.readOwned(env,CONTROL)).value.n,1,'nothing of it is written');
  const generation=Number(one(db,'SELECT generation FROM ratings_domain_authority'));
  await RatingsD1.putOwned(fenced,CONTROL,ok.saved.etag,{schemaVersion:1,n:3});
  assert.equal(Number(one(db,'SELECT generation FROM ratings_domain_authority')),generation,'a refused batch does not bump the generation');
  // The view projection is fenced the same way, and an unfenced env is unaffected.
  await assert.rejects(RatingsD1.projectView(fenced,[{factKey:'f',links:{letterboxd:'abc'},watched:{value:true}}]),error=>error.code==='ratings_domain_fence');
  assert.equal(Number(one(db,"SELECT COUNT(*) FROM ratings_view")),0);
  assert.equal((await RatingsD1.projectView(env,[{factKey:'f',links:{letterboxd:'abc'},watched:{value:true}}])).changed,1);
  // A fence with no etag is a refusal, not an unfenced write.
  assert.equal((await RatingsD1.putOwned({DB:db,ratingsFence:{key:MODE,etag:''}},'letterboxd/ratings/orchestration.json',(await RatingsD1.readOwned(env,CONTROL)).etag,{x:1})).saved,null);
  assert.equal((await RatingsD1.readOwned(env,CONTROL)).value.x,undefined);
 }
 // 15b. The executor: its first commit is a control write; the owner closes admission just before it, so it is refused and the instance stops.
 {
  const db=load(),{clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
  const ctx=loadContext({net,clock,FakeDate,crypto,extra:{}});
  ctx.RatingsD1=RatingsD1;
  vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+fs.readFileSync('src/ratings-orchestration.js','utf8'),ctx);
  const RO=g(ctx,'RatingsOrchestration'),workflow=fakeWorkflow();
  const env=baseEnv(bucket,{...SEPARATE,RATINGS_WORKFLOW:workflow,DB:db,RATINGS_DB_REQUIRED:'on'});
  migrated(bucket);
  const modeSaved=await RatingsD1.putOwned({DB:db},MODE,null,{schemaVersion:1,mode:'cloudflare',epoch:1,target:null,drain:null});assert.ok(modeSaved.saved);
  const claimed=plain(await RO.ensure(env,{now:clock.now}));assert.equal(claimed.started,true);assert.equal(workflow.creates.length,1);
  const owner={DB:db};
  db.__onBatch=null;
  const id=claimed.instanceId,payload={runKey:claimed.runKey,series:claimed.series,epoch:1,id,now:()=>clock.now,random:()=>0.5};
  // The migration that the stand-in would apply is absent here: the run is not migrated on D1, so the action ends in a commit of its failure.
  const origBatch=db.batch.bind(db);let flipped=false;
  db.batch=async statements=>{
   if(!flipped&&statements.some(item=>String(item.text).includes("'"+CONTROL+"'"))){flipped=true;const current=(await RatingsD1.readOwned(owner,MODE));await RatingsD1.putOwned(owner,MODE,current.etag,{schemaVersion:1,mode:'switching',from:'cloudflare',target:'external',epoch:2,drain:null});}
   return origBatch(statements);
  };
  const before=(await RatingsD1.readOwned(owner,CONTROL)).value;
  const result=plain(await RO.act(env,payload));
  assert.equal(flipped,true,'admission was closed between the admission check and the commit');
  eq([result.kind,result.reason],['stop','switch_in_progress'],'the refused commit ends the stale instance');
  eq((await RatingsD1.readOwned(owner,CONTROL)).value,before,'the stale instance wrote nothing');
  assert.equal(net.fetches.length,0);
  // The old instance cannot write after the switch completes either: a later action is refused at admission.
  eq(plain(await RO.act(env,payload)).reason,'switch_in_progress');
 }
}

console.log('Ratings orchestration: Madrid day key and DST, failure classes and budget, mode switch and external fence, one run per date, whole run through the Workflow loop, 403/429/transient/unsafe handling, read model and the D1 epoch fence passed');
