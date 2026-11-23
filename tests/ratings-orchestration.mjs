// AIR-347 / ADR 0089: the Cloudflare executor of the daily ratings run. The pure policy (Madrid day key, DST, failure classes,
// budget, health); the owner's mode switch and the external writer's gate; a whole run
// without any Workflow (retired): the refusal to enter `cloudflare`, the drain without a binding; the
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

// 1. Policy: the Madrid day key and the 17:00 schedule on the two DST change days and either side of them.
{
 // CEST (UTC+2): 17:00 is 15:00Z. CET (UTC+1): 17:00 is 16:00Z.
 const cases=[['2026-10-24T14:59:59Z','2026-10-24',false],['2026-10-24T15:00:00Z','2026-10-24',true],['2026-10-26T15:00:00Z','2026-10-26',false],['2026-10-26T16:00:00Z','2026-10-26',true],
  ['2026-03-28T15:59:59Z','2026-03-28',false],['2026-03-28T16:00:00Z','2026-03-28',true],['2026-03-30T14:59:59Z','2026-03-30',false],['2026-03-30T15:00:00Z','2026-03-30',true]];
 for(const [time,day,due] of cases){const result=Policy.dailyDue(Date.parse(time));assert.equal(result.dayKey,day,time);assert.equal(result.due,due,time);}
 // The change days: fall back on 2026-10-25 (03:00 CEST to 02:00 CET), spring forward on 2026-03-29 (02:00 CET to 03:00 CEST).
 assert.equal(at(Policy.madridInstant('2026-10-25',17,0)),'2026-10-25T16:00:00.000Z');
 assert.equal(at(Policy.madridInstant('2026-03-29',17,0)),'2026-03-29T15:00:00.000Z');
 for(const day of ['2026-10-25','2026-03-29']){
  const dueAt=Policy.madridInstant(day,17,0);
  assert.equal(Policy.dailyDue(dueAt).dayKey,day);assert.equal(Policy.dailyDue(dueAt-1).due,false);
  assert.equal(Policy.madridDayKey(dueAt+6*H),day,'late catch-up the same local date');
  assert.notEqual(Policy.madridDayKey(dueAt+8*H),day,'the next local date is another run key');
 }
 // Late evening UTC is already the next Madrid date.
 assert.equal(Policy.madridDayKey(Date.parse('2026-07-01T22:30:00Z')),'2026-07-02');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-10-24T15:00:00Z'))),'2026-10-25T16:00:00.000Z');
 assert.equal(at(Policy.nextDailyDue(Date.parse('2026-10-24T10:00:00Z'))),'2026-10-24T15:00:00.000Z');
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

// A Worker context with the executor's mode and fence, a stubbed ratings authority and no Workflow binding (the Ratings Workflow is retired).
const T0=Date.parse('2026-10-24T15:31:00Z');
function setup({start=T0,pages=1}={}){
 const {clock,FakeDate,crypto}=makeClock(start),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const authority={ready:true,error:false};
 // An owned-document stand-in over the bucket's records: D1-only keys are served only while the authority is ready, writes
 // honour the epoch fence like the real batch, and none of it is logged as an R2 write.
 const ownedKeys=new Set([MODE,CONTROL]);
 const ownedStub={ratingsMutableKey:key=>ownedKeys.has(key),ratingsGate:async()=>({ready:authority.ready,generation:1,error:authority.error}),
  async readOwned(env,key){if(!authority.ready)throw Object.assign(new Error('held'),{code:'ratings_domain_not_authoritative'});const object=await bucket.get(key);return {owned:true,value:object?await object.json():null,etag:object?.etag??null};},
  projectView:async(env,records)=>({owned:true,changed:records.length}),// AIR-558: the facts projection is D1-owned; this stub owns it and drops it
  chain:Promise.resolve(),
  putOwned(env,key,previous,value){const run=this.chain.then(()=>this.commit(env,key,previous,value));this.chain=run.catch(()=>{});return run;},
  async commit(env,key,previous,value){
   if(!authority.ready)return {owned:false};
   if(env?.ratingsFence){const mode=await bucket.get(env.ratingsFence.key);if((mode?.etag??null)!==env.ratingsFence.etag)return {owned:true,saved:null};}
   const current=await bucket.get(key);if((current?.etag??null)!==(previous??null))return {owned:true,saved:null};
   bucket.set(key,value);return {owned:true,saved:{etag:(await bucket.get(key)).etag}};
  }};
 ctx.RatingsD1=new Proxy(ownedStub,{get:(target,name)=>name in target?target[name].bind?target[name].bind(target):target[name]:async()=>({owned:false,handled:false,changed:0})});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+fs.readFileSync('src/ratings-orchestration.js','utf8'),ctx);
 const env=baseEnv(bucket,{...SEPARATE});
 migrated(bucket);
 if(pages)net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-24','99001')],false));
 const step={log:[],async do(name,fn){const value=await fn();step.log.push(['do',name,plain(value)]);return JSON.parse(JSON.stringify(value));},async sleepUntil(name,date){step.log.push(['sleep',name,date.toISOString()]);clock.now=Math.max(clock.now,date.getTime());}};
 const hooks={now:()=>clock.now,clock:()=>clock.now,random:()=>0.5};
 return {clock,net,bucket,ctx,env,authority,step,hooks,RO:g(ctx,'RatingsOrchestration'),R:g(ctx,'LetterboxdRatings')};
}
// The Cloudflare executor is retired, so the switch refuses to enter `cloudflare`. A deployment that still holds that mode (stored data) is
// seeded directly; the fence, the drain and the reverse switch toward `external` are what is still exercised.
const CLOUDFLARE_MODE={schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified',changedAt:'2026-10-24T15:00:00.000Z',completedAt:'2026-10-24T15:00:00.000Z'};
const seedCloudflare=world=>world.bucket.set(MODE,CLOUDFLARE_MODE);
const seedCloudflareD1=async world=>{const current=await RatingsD1.readOwned(world.owner,MODE);const saved=await RatingsD1.putOwned(world.owner,MODE,current.etag??null,CLOUDFLARE_MODE);assert.ok(saved.saved);return saved;};
const control=world=>world.bucket.value(CONTROL);
const modeDoc=world=>world.bucket.value(MODE);

// 3. Inert by default: no mode document means external. Reading the status writes nothing and the external path is open.
{
 const w=setup();
 assert.equal(w.bucket.writes().length,0,'nothing is written');assert.equal(w.net.fetches.length,0);
 const status=plain(await w.R.status(w.env));
 assert.equal(status.orchestration.mode,'external');assert.equal(status.orchestration.epoch,0);assert.equal(status.sideEffects,'none');
 // The external path is open: a start is not fenced.
 assert.equal(plain(await w.R.handle(w.env,'start',{trigger:'manual'})).body.reason,'started');
 // A malformed mode document fails closed on the external path.
 const m=setup();m.bucket.set(MODE,{schemaVersion:1,mode:'banana',epoch:0});
 assert.equal(plain(await m.R.handle(m.env,'start',{trigger:'manual'})).body.reason,'evidence_unreadable');
 assert.equal(m.bucket.writes().length,0);
}

// 4. The owner's mode switch (decision 2a), now only toward `external`: close admission, verified drain, complete. And the external writer's gate (T18, T25).
// The deployment under test holds the historical `cloudflare` mode as stored data; nothing can enter it any more (section 5).
{
 const w=setup();
 await w.R.start(w.env,{trigger:'scheduled'});// a live external run record without a step in flight
 assert.equal((await w.RO.handle(w.env,{action:'nope'})).status,400);assert.equal((await w.RO.handle(w.env,{action:'close_admission'})).status,400);
 assert.equal((await w.RO.handle(w.env,{action:'close_admission',target:'x'})).status,400);assert.equal((await w.RO.handle(w.env,{action:'complete',extra:1})).status,400);
 seedCloudflare(w);
 // T18: the external writer is fenced whatever an old prompt sends while the mode says `cloudflare`; reads and the status stay open.
 const fencedStart=plain(await w.R.handle(w.env,'start',{trigger:'scheduled'}));eq(fencedStart.body,{runId:null,created:false,nextAction:'stop',reason:'external_writer_fenced'});
 const fencedStep=plain(await w.R.handle(w.env,'step',{runId:'abc'}));assert.equal(fencedStep.body.reason,'external_writer_fenced');assert.equal(fencedStep.body.runId,'abc');
 assert.equal(plain(await w.R.status(w.env)).orchestration.mode,'cloudflare');
 // The reverse protocol toward `external`: close admission (epoch 2), verified drain, then the external path is allowed again.
 const closed=plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'external'},w.clock.now));
 eq(closed,{action:'close_admission',closed:true,mode:'switching',target:'external',epoch:2});
 eq(plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'external'},w.clock.now)).refused,'switch_open');
 // Admission is closed for both writers: nothing is written, nothing is requested.
 const before=JSON.stringify(w.bucket.snapshot()),fetches=w.net.fetches.length;
 const start=plain(await w.R.handle(w.env,'start',{trigger:'scheduled'}));eq(start.body,{runId:null,created:false,nextAction:'stop',reason:'switch_in_progress'});
 const stepReply=plain(await w.R.handle(w.env,'step',{runId:'x'}));assert.equal(stepReply.body.reason,'switch_in_progress');assert.equal(stepReply.body.nextAction,'stop');
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
 // A control record in a live phase names an instance that can no longer be read (the Workflow is retired): never proven drained, fail closed.
 w.bucket.set(RUN,{...run,lease:{step:null,expiresAt:null}});
 for(const phase of ['starting','running','waiting']){
  w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-10-24',series:0,instanceId:'ratings_20261024_0',phase,budget:Policy.emptyBudget()});
  assert.equal(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).drain,'unreadable','a live-phase control record is not a drained one: '+phase);
 }
 // A closed control record has nothing in flight.
 for(const phase of ['done','stopped','idle']){
  w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-10-24',series:0,instanceId:'ratings_20261024_0',phase,budget:Policy.emptyBudget()});
 }
 const completed=plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now+10*MIN));
 eq([completed.completed,completed.mode,completed.epoch,completed.drain],[true,'external',2,'verified']);
 // After the reverse switch the external path is admitted again (the Letterboxd Sync fence is a separate gate, tested in letterboxd-sync.mjs).
 assert.notEqual(plain(await w.R.handle(w.env,'start',{trigger:'manual'})).body.reason,'external_writer_fenced');
}

// 5. The retired executor: nothing can enter `cloudflare`, so the mode switch cannot imitate a working rollback to a Workflow that no longer exists.
{
 const w=setup();
 const before=JSON.stringify(w.bucket.snapshot());
 // From the default (external) and from every other mode the request is refused with an explicit code and writes nothing.
 eq(plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'cloudflare'},w.clock.now)),{action:'close_admission',refused:'legacy_executor_retired',mode:'external',epoch:0});
 eq(plain(await w.RO.handle(w.env,{action:'close_admission',target:'cloudflare'})).body.refused,'legacy_executor_retired');
 assert.equal(JSON.stringify(w.bucket.snapshot()),before,'a refused switch writes nothing');assert.equal(w.bucket.writes().length,0);
 seedCloudflare(w);
 const seeded=JSON.stringify(w.bucket.snapshot());
 eq(plain(await w.RO.switchMode(w.env,{action:'close_admission',target:'cloudflare'},w.clock.now)).refused,'legacy_executor_retired');
 assert.equal(JSON.stringify(w.bucket.snapshot()),seeded);
 // A stored `switching` record that targets `cloudflare` (an old, interrupted switch) cannot be completed either.
 w.bucket.set(MODE,{schemaVersion:1,mode:'switching',from:'external',target:'cloudflare',epoch:3,drain:null});
 const interrupted=JSON.stringify(w.bucket.snapshot());
 eq(plain(await w.RO.switchMode(w.env,{action:'complete'},w.clock.now)).refused,'legacy_executor_retired');
 assert.equal(JSON.stringify(w.bucket.snapshot()),interrupted,'the interrupted switch is left as it was');
 // The module no longer carries the Workflow loop or its helpers.
 for(const name of ['admit','act','run','ensure','instanceId'])assert.equal(w.RO[name],undefined,name+' is gone');
 assert.equal(typeof w.ctx.runRatingsWorkflow,'undefined','the Workflow entry function is gone');
 // The pieces the Letterboxd Sync and the monitor still read are present.
 for(const name of ['readMode','readControl','drainState','externalGate','readModel','switchMode','clearQuarantine','handle'])assert.equal(typeof w.RO[name],'function',name);
 // The build and the configuration declare no Ratings Workflow.
 const build=fs.readFileSync('build.mjs','utf8'),config=fs.readFileSync('wrangler.jsonc','utf8');
 assert.doesNotMatch(build,/RatingsWorkflow|runRatingsWorkflow/);assert.doesNotMatch(config,/RATINGS_WORKFLOW|iptv-ratings|RatingsWorkflow/);
 assert.match(config,/LETTERBOXD_WORKFLOW/);assert.match(config,/DISCOVERY_WORKFLOW/);
}

// 5b. drainState without a binding: a closed control record is drained, a live-phase one is not provable and a malformed one is unreadable. The binding is never read.
{
 const w=setup();
 w.env.RATINGS_WORKFLOW={get:async()=>{throw new Error('the retired binding must not be read');},create:async()=>{throw new Error('must not create');}};
 assert.equal(await w.RO.drainState(w.env,w.clock.now),'verified','no control record at all');
 w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-11-22',series:0,instanceId:'ratings_20261122_0',phase:'done',doneAt:'2026-11-22T16:00:36.918Z',budget:Policy.emptyBudget()});
 assert.equal(await w.RO.drainState(w.env,w.clock.now),'verified','the production control record: phase done');
 w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-11-22',series:0,instanceId:'ratings_20261122_0',phase:'running',budget:Policy.emptyBudget()});
 assert.equal(await w.RO.drainState(w.env,w.clock.now),'unreadable','a live phase cannot be verified without the platform');
 w.bucket.set(CONTROL,{garbage:true});
 assert.equal(await w.RO.drainState(w.env,w.clock.now),'unreadable','a malformed control record');
 // The read model reports no liveness and does not read the binding either.
 w.bucket.set(CONTROL,{schemaVersion:1,runKey:'2026-11-22',series:0,instanceId:'ratings_20261122_0',phase:'running',budget:Policy.emptyBudget()});
 eq(plain(await w.RO.readModel(w.env,w.clock.now)).owner,{kind:'workflow',instanceId:'ratings_20261122_0',liveness:null});
}

// 6. The read model: reads only, health by state (T21).
{
 const w=setup({start:Date.parse('2026-10-24T14:00:00Z')});
 const writes=()=>w.bucket.writes().length,base=writes();
 let model=plain(await w.RO.readModel(w.env,w.clock.now));eq([model.mode,model.health,model.oldestPendingAt],['external','idle',null]);
 // External mode after 17:00 with no finished run: healthy for two hours, then stalled; the monitor reads this.
 model=plain(await w.RO.readModel(w.env,Date.parse('2026-10-24T16:30:00Z')));eq([model.health,model.oldestPendingAt],['healthy','2026-10-24T15:00:00.000Z']);
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
 // 16. The review blockers (AIR-347 PR #375). A real D1 stand-in, the real RatingsD1, the real ratings pipeline.
 const d1World=async()=>{
  const db=load(),{clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
  const ctx=loadContext({net,clock,FakeDate,crypto,extra:{}});
  ctx.RatingsD1=RatingsD1;
  vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+fs.readFileSync('src/ratings-orchestration.js','utf8'),ctx);
  const RO=g(ctx,'RatingsOrchestration'),R=g(ctx,'LetterboxdRatings');
  const env=baseEnv(bucket,{...SEPARATE,DB:db,RATINGS_DB_REQUIRED:'on'});
  migrated(bucket);
  // The migrated queue and cursor are D1 documents once the ratings authority is d1.
  for(const [key,value] of Object.entries(bucket.snapshot()))if(RatingsD1.ratingsMutableKey(key)){assert.ok((await RatingsD1.putOwned({DB:db},key,null,value)).saved,key);}
  net.diary.set(1,diaryPage([diaryRow('diary-only',8,'2026-10-24','99001')],false));
  const hook={onBatch:null},origBatch=db.batch.bind(db);
  db.batch=async statements=>{if(hook.onBatch&&!hook.running){hook.running=true;try{await hook.onBatch(statements);}finally{hook.running=false;}}return origBatch(statements);};
  const mode=async()=>(await RatingsD1.readOwned({DB:db},MODE)).value;
  return {db,clock,net,bucket,RO,R,env,hook,mode,owner:{DB:db}};
 };
 const touchesRun=statements=>statements.some(item=>JSON.stringify(item).includes(RUN));
 // 16a. Blocker 1: an external start admitted before close_admission cannot commit after the verified drain.
 {
  const w=await d1World();
  w.hook.onBatch=async statements=>{
   if(!touchesRun(statements))return;w.hook.onBatch=null;
   await seedCloudflareD1(w);// the historical switch: the mode document changes after the external start was admitted
  };
  const attempt=await w.R.handle(w.env,'start',{trigger:'scheduled'}).then(reply=>({reply}),error=>({error}));
  assert.ok(attempt.error||attempt.reply.body.created!==true,'the delayed start did not create a run');
  assert.equal((await RatingsD1.readOwned(w.owner,RUN)).value,null,'the old start wrote no run record after the drain');
  assert.equal(w.bucket.writes().length,0,'and nothing went to R2');
  eq([(await w.mode()).mode,(await w.mode()).epoch],['cloudflare',1]);
  // The same holds for a step admitted before the switch: it commits nothing once the epoch moved.
  const w2=await d1World();
  const first=plain(await w2.R.handle(w2.env,'start',{trigger:'scheduled'}));assert.equal(first.body.created,true);
  const runBefore=(await RatingsD1.readOwned(w2.owner,RUN)).value;
  w2.hook.onBatch=async statements=>{
   if(!touchesRun(statements))return;w2.hook.onBatch=null;
   await seedCloudflareD1(w2);
  };
  const stepped=await w2.R.handle(w2.env,'step',{runId:first.body.runId}).then(reply=>({reply}),error=>({error}));
  assert.ok(stepped.error||stepped.reply.status===200,'the stale step ended without throwing out of the route contract');
  eq((await RatingsD1.readOwned(w2.owner,RUN)).value.lease,runBefore.lease,'a stale external step leaves the run record as it was');
  // Reverse switch: from the stored `cloudflare` mode, close admission toward `external` and complete after the verified drain; the external path is admitted again.
  const w3=await d1World();
  await seedCloudflareD1(w3);
  eq((await w3.RO.switchMode(w3.owner,{action:'close_admission',target:'external'},w3.clock.now)).closed,true);
  eq((await w3.RO.switchMode(w3.owner,{action:'complete'},w3.clock.now+20*MIN)).completed,true);
  eq((await w3.mode()).mode,'external');
  assert.equal(plain(await w3.R.handle(w3.env,'start',{trigger:'manual'})).body.created,true,'after the reverse switch the external path writes again');
 }
 // 16b. Blocker 2: a held or lost D1 authority is never permission to write R2. The owner's switch with a held or non-d1 marker is refused and writes nothing.
 {
  const h=await d1World();await seedCloudflareD1(h);h.db.sql("UPDATE ratings_domain_authority SET mode='r2'");
  const refused=plain(await h.RO.handle(h.env,{action:'close_admission',target:'external'}));
  assert.ok(refused.body.refused,'the switch is refused');assert.equal(h.bucket.writes().length,0);assert.equal(h.bucket.value(MODE),null);
  const held=await d1World();await seedCloudflareD1(held);held.db.sql("UPDATE ratings_domain_authority SET cutover='held'");
  assert.ok(plain(await held.RO.handle(held.env,{action:'close_admission',target:'external'})).body.refused);assert.equal(held.bucket.writes().length,0);assert.equal(held.bucket.value(MODE),null);
 }
 // 16b2. An unreadable owner is never an external writer: D1 says `cloudflare`, the authority is held or r2, stale R2 fixtures say otherwise.
 for(const [label,sql] of [['held',"UPDATE ratings_domain_authority SET cutover='held'"],['r2',"UPDATE ratings_domain_authority SET mode='r2'"]]){
  const w=await d1World();
  await seedCloudflareD1(w);
  // Stale legacy fixtures in R2: an old external mode record, a run and an old queue; all of them must be ignored.
  w.bucket.set(MODE,{schemaVersion:1,mode:'external',epoch:0,target:null,drain:null});
  w.bucket.set(RUN,{schemaVersion:1,runId:'stale-r2-run',state:'finished',phase:'done',lease:{step:null,expiresAt:null}});
  const before=JSON.stringify(w.bucket.snapshot());w.db.sql(sql);
  for(const [action,body] of [['start',{trigger:'scheduled'}],['step',{runId:'stale-r2-run'}]]){
   const attempt=await w.R.handle(w.env,action,body).then(reply=>({reply:plain(reply)}),error=>({error}));
   assert.ok(!attempt.error,label+' '+action+': refused with a reply, not thrown');
   eq([attempt.reply.body.nextAction,attempt.reply.body.reason??attempt.reply.body.refused],['stop','evidence_unreadable'],label+' '+action);
  }
  assert.equal(w.bucket.writes().length,0,label+': zero R2 writes');assert.equal(JSON.stringify(w.bucket.snapshot()),before,label+': R2 untouched');
  // The status does not claim external while ownership is unreadable.
  const status=plain(await w.R.status(w.env));assert.notEqual(status.orchestration?.mode,'external',label);assert.equal(status.orchestration.health,'unknown');
 }
 // 16c. The retired migrate action has no entry path (ADR 0161). The dispatchers route start and step through `handle` only, and
 // `handle` answers 400 for any other action, fenced or not, without a write.
 {
  const w=setup();
  seedCloudflare(w);
  const before=JSON.stringify(w.bucket.snapshot());
  eq(plain(await w.R.handle(w.env,'migrate',{mode:'apply'})),{status:400,body:{error:'Unknown action'}});
  assert.equal(JSON.stringify(w.bucket.snapshot()),before,'a retired action writes nothing');
  const worker=fs.readFileSync('src/worker.js','utf8'),mcp=fs.readFileSync('src/mcp.js','utf8');
  // The legacy writer entry points are gone: no HTTP route and no MCP tool reaches the Ratings `handle` adapter any more.
  assert.doesNotMatch(worker,/letterboxd\/ratings\/(start|step)/);assert.doesNotMatch(worker+mcp,/LetterboxdRatings\.handle\(/);
  assert.doesNotMatch(mcp,/ratings_sync_start|ratings_sync_step/);
  assert.doesNotMatch(worker+mcp,/ratings\/migrate|ratings_storage_migrate|LetterboxdRatings\.migrate\(/,'no entry path reaches a conversion');
 }
}

console.log('Ratings orchestration: Madrid day key and DST, failure classes and budget, mode switch and external fence, the retired Workflow executor refused and absent, the drain without a binding, the read model and the D1 epoch fence passed');
