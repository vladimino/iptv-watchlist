// AIR-349: the monitor as the Worker runs it. Real status reads over an in-memory bucket, a fake webhook and a fake dead-man URL,
// an injected clock. The monitor writes only its own document, sends only actionable alerts once, retries a failed delivery, and a
// synthetic test message changes no domain state. Nothing here calls Cloudflare, the network or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,MIN=60000,at=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-06T22:00:00Z');
const KEY='monitor/state.json';
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 const calls=[];let webhookOk=true;
 ctx.fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null});if(String(url).startsWith('https://hooks.example/'))return new Response('',{status:webhookOk?200:500});if(String(url).startsWith('https://beat.example/'))return new Response('ok');throw new Error('unexpected network '+url);};
 ctx.RatingsOrchestration={async readModel(){return ctx.model;}};ctx.model={mode:'cloudflare',health:'healthy',failure:null};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_WEBHOOK_URL:'https://hooks.example/alert',MONITOR_HEARTBEAT_URL:'https://beat.example/ping'});
 return {clock,bucket,ctx,env,calls,M:g(ctx,'Monitor'),setWebhook:ok=>{webhookOk=ok;}};
}
// A healthy production-like record set: an EPG generation published after the Madrid due time, an idle Discovery, an empty queue.
function healthy(bucket,{publishedAt=at(T0-3*H),runId='run-a'}={}){
 bucket.set('sync.json',{runId,stage:'complete',updatedAt:publishedAt,failures:[]});
 bucket.set('epg/published-generation.json',{programmeRunId:runId,phase:'published'});
 bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:publishedAt,lastBatch:null});
}
const docs=bucket=>bucket.snapshot();
const writes=bucket=>bucket.writes().map(item=>item.key);
const posts=calls=>calls.filter(item=>item.method==='POST');

// 1. Off by default: no reads of state, no writes, no network. Dry: evaluates and logs only.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 const off=plain(await M.run({...env,MONITOR:undefined},{now:T0}));assert.equal(off.ran,false);
 assert.equal(plain(await M.run({...env,MONITOR:'garbage'},{now:T0})).ran,false,'an unknown value is off');
 // AIR-366: dry is retired. The old token is no longer a mode: the tick does not run, writes nothing, sends nothing and pings nothing.
 assert.deepEqual(plain(await M.run({...env,MONITOR:'dry'},{now:T0})),{ran:false,reason:'off'},'the retired dry token fails closed to off');
 assert.equal(plain(await M.status({...env,MONITOR:'dry'},T0)).mode,'off','status reads the retired token as off');
 assert.equal(bucket.writes().length,0);assert.equal(calls.length,0);
 const before=JSON.stringify(docs(bucket));
 assert.equal(JSON.stringify(docs(bucket)),before,'off and the retired dry leave the monitor document untouched');
 assert.equal(plain(await M.test({...env,MONITOR:undefined})).reason,'off');
}

// 2. A healthy snapshot: only the monitor's own document is written, the heartbeat is pinged, nothing is sent.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 const before=docs(bucket);
 const result=plain(await M.run(env,{now:T0}));
 assert.deepEqual([result.ran,result.overall,result.sent,result.saved],[true,'healthy',0,true]);
 assert.deepEqual(writes(bucket),[KEY],'the monitor writes only its own document');
 for(const [key,value] of Object.entries(before))assert.deepEqual(bucket.value(key),value,key+' unchanged');
 assert.deepEqual(calls.map(item=>item.method),['GET'],'one dead-man ping and no alert');
 const state=bucket.value(KEY);assert.equal(state.overall,'healthy');assert.equal(state.streams.length,4);assert.equal(state.heartbeatAt,at(T0));
 assert.doesNotMatch(JSON.stringify(state),/title|letterboxd|https?:\/\//i,'the state holds no title, Letterboxd data or URL');
}

// 3. A stale EPG: confirmed by the second snapshot, one alert, no duplicate on repeat, one recovery.
{
 const {bucket,env,M,calls,ctx,clock}=setup();
 healthy(bucket,{publishedAt:at(T0-40*H)});bucket.set('sync.json',{runId:'run-a',stage:'complete',updatedAt:at(T0-40*H),failures:[]});
 let r=plain(await M.run(env,{now:T0}));assert.equal(r.overall,'degraded');assert.equal(posts(calls).length,0,'the first snapshot only counts');
 r=plain(await M.run(env,{now:T0+H}));assert.equal(r.sent,1);
 assert.equal(posts(calls).length,1);const message=posts(calls)[0].body;
 assert.deepEqual([message.source,message.kind,message.key,message.severity,message.stream],['iptv-monitor','alert','epg_stale','degraded','epg']);
 assert.deepEqual(Object.keys(message).sort(),['at','critical','id','key','kind','message','overall','severity','source','stream']);
 assert.equal(message.critical,false,'an ordinary degraded issue is not critical (ADR 0206)');
 await M.run(env,{now:T0+2*H});await M.run(env,{now:T0+3*H});assert.equal(posts(calls).length,1,'repeats inside the cooldown send nothing');
 assert.equal(plain(await M.status(env,T0+3*H)).openIssues[0].key,'epg_stale');
 // The generation is published: a recovery message once, then silence.
 healthy(bucket,{publishedAt:at(T0+4*H),runId:'run-b'});
 await M.run(env,{now:T0+5*H});
 assert.deepEqual(posts(calls).map(item=>item.body.kind),['alert','recovery']);
 await M.run(env,{now:T0+6*H});assert.equal(posts(calls).length,2);
 assert.deepEqual(plain(await M.status(env,T0+6*H)).openIssues,[]);
}

// 4. An owner condition alerts at the first sight; a failed delivery is not counted and is retried; a failing source is isolated.
{
 const {bucket,env,M,calls,ctx,setWebhook}=setup();healthy(bucket);
 ctx.model={mode:'cloudflare',health:'quarantined',quarantine:{reason:'budget_exhausted'}};
 setWebhook(false);
 let r=plain(await M.run(env,{now:T0}));assert.deepEqual([r.sent,r.failed],[0,1],'a 500 from the channel is a failed delivery');
 assert.equal(bucket.value(KEY).outbox.length,1,'the claimed message stays queued until it is delivered');
 setWebhook(true);
 r=plain(await M.run(env,{now:T0+H}));assert.deepEqual([r.sent,r.failed],[1,0],'the next tick retries the queued message');assert.deepEqual(bucket.value(KEY).outbox,[]);
 assert.equal(bucket.value(KEY).alerts.issues.ratings_quarantined.sendCount,1);
 // One stream unreadable does not hide the others.
 ctx.RatingsOrchestration={async readModel(){throw new Error('boom');}};ctx.model=null;
 await M.run(env,{now:T0+2*H});
 const state=bucket.value(KEY);
 assert.deepEqual(state.streams.map(item=>[item.stream,item.state]),[['epg','healthy'],['discovery','healthy'],['ratings','degraded'],['predictions','healthy']]);
}

// 5. Discovery backlog: waiting by design inside its backoff, an alert when it stalls; the executor mode is read, never changed.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 bucket.set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',remainingChunks:10,at:at(T0-30*MIN),nextCatchUpAt:at(T0+30*MIN),programmeRunId:'run-a'});
 let r=plain(await M.run(env,{now:T0}));assert.equal(bucket.value(KEY).streams.find(item=>item.stream==='discovery').state,'waiting');assert.equal(posts(calls).length,0);
 bucket.set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',remainingChunks:10,at:at(T0-6*H),nextCatchUpAt:at(T0-5*H),programmeRunId:'run-a'});
 await M.run(env,{now:T0+H});await M.run(env,{now:T0+2*H});
 assert.equal(posts(calls).filter(item=>item.body.key==='discovery_stalled').length,1);
 assert.deepEqual(writes(bucket).filter(key=>key!==KEY),[],'no domain record was written');
}

// 6. Prediction queue (AIR-556): an empty queue is healthy; a noop wake-up is not progress; real progress is; retry backoff waits.
// With no run evidence at all the clock starts at the first tick that saw eligible work (never at "now" each tick), so silence is bounded.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 const noop=ms=>bucket.set('enrichment/prediction-queue.json',{pending:['a','b'],hotPending:['a','b'],coldPending:[],retries:{},refreshedAt:at(ms),lastCheckAt:at(ms),metrics:{hotProcessedTotal:7},
  lastBatch:{runId:null,batchSize:0,added:0,updated:0,stage:'blocked',startedAt:at(ms),finishedAt:at(ms)}});
 // Every hour a scheduled batch finds nothing to do and rewrites lastBatch and lastCheckAt; the pending queue never moves.
 let states=[];
 for(let hour=0;hour<=9;hour++){noop(T0+hour*H);await M.run(env,{now:T0+hour*H});states.push(bucket.value(KEY).streams.find(item=>item.stream==='predictions').state);}
 assert.deepEqual(states.slice(0,3),['delayed','degraded','degraded'],'unknown at first sight, then no confirmed progress after the 60-minute limit');
 assert.equal(posts(calls).filter(item=>item.body.key==='predictions_no_progress'&&item.body.kind==='alert').length,1,'one alert, not one per wake-up');
 assert.equal(posts(calls).filter(item=>item.body.key==='predictions_no_progress'&&item.body.kind==='reminder').length,1,'one reminder after the 6-hour cooldown, none before');
 // A moved processed counter is real progress and recovers the stream, with one recovery message.
 bucket.set('enrichment/prediction-queue.json',{...bucket.value('enrichment/prediction-queue.json'),metrics:{hotProcessedTotal:9}});
 await M.run(env,{now:T0+10*H});assert.equal(bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'healthy');
 assert.equal(posts(calls).filter(item=>item.body.kind==='recovery'&&item.body.key==='predictions_no_progress').length,1);
 // Work that is all deferred by its own retry time is waiting by design, however long it is idle.
 const backoff=setup();healthy(backoff.bucket);
 backoff.bucket.set('enrichment/prediction-queue.json',{pending:['a'],hotPending:['a'],coldPending:[],retries:{a:{retryAt:T0+30*H}},metrics:{hotProcessedTotal:1},lastBatch:null});
 await backoff.M.run(backoff.env,{now:T0});await backoff.M.run(backoff.env,{now:T0+8*H});
 assert.equal(backoff.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'waiting');assert.equal(posts(backoff.calls).length,0);
 const quiet=setup();healthy(quiet.bucket);quiet.bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:at(T0-30*H),lastBatch:null});
 await quiet.M.run(quiet.env,{now:T0});assert.equal(quiet.bucket.value(KEY).overall,'healthy');
}

// 6a. AIR-556 regression: last productive batch 04:54, 3740 eligible, no Task reached the Worker. The hourly tick after the 60-minute limit alerts once.
{
 const base=Date.parse('2026-11-20T04:54:00Z'),ids=Array.from({length:3740},(_,index)=>'f'+index);
 const run=(extra={})=>({runId:'run-0454',status:'complete',createdAt:at(base-8*MIN),completedAt:at(base),counts:{created:3,recalculated:0},...extra});
 const queue=(extra={})=>({pending:ids,hotPending:ids,coldPending:[],retries:{},metrics:{hotProcessedTotal:100},lastBatch:{runId:'run-0454',stage:'complete',startedAt:at(base-8*MIN),finishedAt:at(base)},...extra});
 const prediction=bucket=>bucket.value(KEY).streams.find(item=>item.stream==='predictions');
 const {bucket,env,M,calls}=setup();healthy(bucket);
 bucket.set('enrichment/latest-run.json',run());bucket.set('enrichment/prediction-queue.json',queue());
 const sent=()=>posts(calls).filter(item=>item.body.key==='predictions_no_progress');
 await M.run(env,{now:Date.parse('2026-11-20T05:00:00Z')});assert.equal(prediction(bucket).state,'healthy','6 minutes after progress');
 await M.run(env,{now:Date.parse('2026-11-20T05:53:00Z')});assert.equal(prediction(bucket).state,'healthy','59 minutes after progress');
 assert.equal(sent().length,0);
 await M.run(env,{now:Date.parse('2026-11-20T06:00:00Z')});
 assert.equal(prediction(bucket).state,'degraded','66 minutes after progress: past the limit');assert.equal(sent().length,1,'the first hourly tick after the limit alerts');
 assert.match(sent()[0].body.message,/3740 predictions are eligible/);assert.doesNotMatch(sent()[0].body.message,/api_error|auth|missed|expired/i);
 for(const hour of [7,8,9,10])await M.run(env,{now:Date.parse('2026-11-20T'+String(hour).padStart(2,'0')+':00:00Z')});
 assert.equal(sent().length,1,'no alert per Task slot: the cooldown holds until the 6-hour reminder');
 assert.equal(bucket.value(KEY).alerts.issues.predictions_no_progress.sendCount,1);
 // The worst case: the limit is crossed one minute after a tick, so the alert comes at the next tick, about two hours after the last progress.
 const late=setup();healthy(late.bucket);late.bucket.set('enrichment/latest-run.json',run({completedAt:at(Date.parse('2026-11-20T05:01:00Z'))}));late.bucket.set('enrichment/prediction-queue.json',queue());
 await late.M.run(late.env,{now:Date.parse('2026-11-20T06:00:00Z')});assert.equal(posts(late.calls).length,0,'59 minutes after progress');
 await late.M.run(late.env,{now:Date.parse('2026-11-20T07:00:00Z')});assert.equal(posts(late.calls).filter(item=>item.body.key==='predictions_no_progress').length,1,'alert 119 minutes after progress');
 // Progress resumes: one recovery in the same channel.
 bucket.set('enrichment/latest-run.json',run({runId:'run-1100',completedAt:at(Date.parse('2026-11-20T10:50:00Z')),createdAt:at(Date.parse('2026-11-20T10:42:00Z'))}));
 await M.run(env,{now:Date.parse('2026-11-20T11:00:00Z')});assert.equal(prediction(bucket).state,'healthy');
 assert.equal(posts(calls).filter(item=>item.body.kind==='recovery'&&item.body.key==='predictions_no_progress').length,1);
 // A lost monitor document does not make the silence fresh: the next tick still measures from the stored run evidence.
 const lost=setup();healthy(lost.bucket);lost.bucket.set('enrichment/latest-run.json',run());lost.bucket.set('enrichment/prediction-queue.json',queue());
 await lost.M.run(lost.env,{now:Date.parse('2026-11-20T09:00:00Z')});
 assert.equal(lost.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'degraded','4 h after progress on the first tick with no monitor state');
 // A noop `already_running` start after the last progress is not progress; a live run younger than the limit is running, an older lease is not a pass.
 const noopRuns=setup();healthy(noopRuns.bucket);noopRuns.bucket.set('enrichment/latest-run.json',{runId:'run-noop',status:'partial',reason:'already_running',createdAt:at(Date.parse('2026-11-20T08:50:00Z')),counts:{created:0,recalculated:0}});
 noopRuns.bucket.set('enrichment/prediction-queue.json',queue());
 await noopRuns.M.run(noopRuns.env,{now:Date.parse('2026-11-20T09:00:00Z')});
 assert.equal(noopRuns.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'delayed','no evidence at all is unknown, not healthy');
 const active=setup();healthy(active.bucket);active.bucket.set('enrichment/latest-run.json',{runId:'run-live',status:'running',createdAt:at(Date.parse('2026-11-20T08:40:00Z')),counts:{created:0,recalculated:0}});
 active.bucket.set('enrichment/runner-lease.json',{runId:'run-live',expiresAt:Date.parse('2026-11-20T09:30:00Z'),heartbeatAt:at(Date.parse('2026-11-20T08:59:00Z'))});active.bucket.set('enrichment/prediction-queue.json',queue());
 await active.M.run(active.env,{now:Date.parse('2026-11-20T09:00:00Z')});
 assert.equal(active.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'healthy','a 20-minute live run is running');
 // Cold-only work counts as eligible (the Footer and the batch runner read the same lane rule); retry-exhausted work alone is not a stall.
 const cold=setup();healthy(cold.bucket);cold.bucket.set('enrichment/latest-run.json',run());cold.bucket.set('enrichment/prediction-queue.json',queue({hotPending:[],coldPending:ids.slice(0,10),pending:ids.slice(0,10)}));
 await cold.M.run(cold.env,{now:Date.parse('2026-11-20T09:00:00Z')});assert.equal(cold.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'degraded');
 const exhausted=setup();healthy(exhausted.bucket);exhausted.bucket.set('enrichment/latest-run.json',run());
 exhausted.bucket.set('enrichment/prediction-queue.json',queue({pending:['x'],hotPending:['x'],retries:{x:{attempts:10}}}));
 await exhausted.M.run(exhausted.env,{now:Date.parse('2026-11-20T09:00:00Z')});assert.equal(exhausted.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'healthy');
}

// 6c. AIR-556 review counterexamples (PR 810).
{
 const base=Date.parse('2026-11-20T04:54:00Z'),ids=Array.from({length:3740},(_,index)=>'f'+index);
 const queue=(extra={})=>({pending:ids,hotPending:ids,coldPending:[],retries:{},metrics:{hotProcessedTotal:100},lastBatch:null,...extra});
 const state=bucket=>bucket.value(KEY).streams.find(item=>item.stream==='predictions').state;
 const T=value=>Date.parse('2026-11-20T'+value+':00Z');
 const diag=(bucket,runId,startedAt,endedAt,fields)=>bucket.set('enrichment/run-diagnostics/'+String(9999999999999-Date.parse(startedAt)).padStart(13,'0')+'-'+runId+'.json',{runId,trigger:'scheduled',startedAt,endedAt,state:'completed',stopReason:'manifest_spent',added:0,failed:0,...fields});
 // 1. A manifest_spent batch that settled only `already_current` films after the last real progress does not hide the backlog.
 {const {bucket,env,M,calls}=setup();healthy(bucket);
  bucket.set('enrichment/latest-run.json',{runId:'run-0454',status:'complete',createdAt:at(base-8*MIN),completedAt:at(base),counts:{created:3,recalculated:0}});
  diag(bucket,'run-0454',at(base-8*MIN),at(base),{stopReason:'eligible_queue_empty',added:3});
  diag(bucket,'run-spent','2026-11-20T05:40:00Z','2026-11-20T05:50:00Z',{});
  bucket.set('enrichment/prediction-queue.json',queue());
  await M.run(env,{now:T('06:00')});
  assert.equal(state(bucket),'degraded','manifest_spent with zero productivity at 05:50 does not count as progress at 06:00');
  assert.equal(posts(calls).filter(item=>item.body.key==='predictions_no_progress').length,1);}
 // 2. Recalculated work: a checkpoint without `updated` and a latest run with recalculations.
 {const {bucket,env,M}=setup();healthy(bucket);
  bucket.set('enrichment/latest-run.json',{runId:'run-recalc',status:'complete',createdAt:'2026-11-20T08:40:00Z',completedAt:'2026-11-20T08:50:00Z',stopReason:'eligible_queue_empty',results:{a:'recalculated',b:'recalculated',c:'recalculated',d:'recalculated'},failures:{e:{}},counts:{created:0,recalculated:4,failed:1}});
  diag(bucket,'run-recalc','2026-11-20T08:40:00Z','2026-11-20T08:50:00Z',{stopReason:'eligible_queue_empty',failed:1});
  bucket.set('enrichment/prediction-queue.json',queue());
  await M.run(env,{now:T('09:00')});assert.equal(state(bucket),'healthy','four recalculated films 10 minutes ago are progress');}
 // 3. The unknown-age clock starts only when eligible work is first observed: drained then eligible, and retry-deferred then eligible, are measured from that tick.
 for(const quiet of ['drained','deferred']){
  const {bucket,env,M,calls}=setup();healthy(bucket);
  const idle=quiet==='drained'?{pending:[],hotPending:[],coldPending:[],retries:{},metrics:{hotProcessedTotal:100},lastBatch:null}:queue({pending:['a'],hotPending:['a'],retries:{a:{retryAt:T0+10*H}}});
  for(let hour=0;hour<3;hour++){bucket.set('enrichment/prediction-queue.json',idle);await M.run(env,{now:T0+hour*H});}
  bucket.set('enrichment/prediction-queue.json',queue());
  await M.run(env,{now:T0+3*H});
  assert.equal(state(bucket),'delayed',quiet+': newly eligible work observed for zero minutes is unknown, not a stall');assert.equal(posts(calls).length,0,'no false alert');
  assert.equal(bucket.value(KEY).predictions.unknownSince,at(T0+3*H));
  await M.run(env,{now:T0+4*H});assert.equal(state(bucket),'degraded','60 minutes after it was first observed');assert.equal(posts(calls).filter(item=>item.body.key==='predictions_no_progress').length,1);}
 // 4. A live lease for a run whose record is missing or another run has no provable start: the 60-minute cap cannot be bypassed.
 for(const latest of [null,{runId:'run-other',status:'complete',createdAt:'2026-11-20T08:00:00Z',completedAt:'2026-11-20T08:05:00Z',counts:{created:0,recalculated:0}}]){
  const {bucket,env,M}=setup();healthy(bucket);
  bucket.set('enrichment/latest-run.json',latest||{runId:'run-0454',status:'complete',createdAt:at(base-8*MIN),completedAt:at(base),counts:{created:3,recalculated:0}});
  diag(bucket,'run-0454',at(base-8*MIN),at(base),{stopReason:'eligible_queue_empty',added:3});
  bucket.set('enrichment/runner-lease.json',{runId:'run-live',expiresAt:T('09:30'),heartbeatAt:'2026-11-20T08:59:00Z'});
  bucket.set('enrichment/prediction-queue.json',queue());
  await M.run(env,{now:T('09:00')});
  assert.equal(state(bucket),'degraded','a lease without a provable start does not make the run "running"');}
}

// 6b. Delivery is claimed before it is sent: concurrent ticks send once, a failed delivered-mark may repeat with the same id, a lost claim sends nothing.
{
 const stale=()=>{const t=setup();healthy(t.bucket,{publishedAt:at(T0-40*H)});t.bucket.set('sync.json',{runId:'run-a',stage:'complete',updatedAt:at(T0-40*H),failures:[]});return t;};
 const t=stale();await t.M.run(t.env,{now:T0});
 const both=await Promise.all([t.M.run(t.env,{now:T0+H}),t.M.run(t.env,{now:T0+H})]);
 assert.equal(posts(t.calls).length,1,'two ticks that read the same snapshot send the message once');
 assert.equal(plain(both).filter(item=>item.saved===false).length,1,'the loser reports that its claim was lost');
 assert.deepEqual(t.bucket.value(KEY).outbox,[],'a delivered message leaves the outbox');
 // Delivery failure: the claimed message stays queued and is retried with the same id.
 const f=stale();await f.M.run(f.env,{now:T0});f.setWebhook(false);await f.M.run(f.env,{now:T0+H});
 const queued=f.bucket.value(KEY).outbox;assert.equal(queued.length,1);f.setWebhook(true);
 await f.M.run(f.env,{now:T0+2*H});const sentBodies=posts(f.calls).filter(item=>item.body.key==='epg_stale');
 assert.equal(sentBodies.at(-1).body.id,queued[0].id,'the retry keeps the stable idempotency id');assert.deepEqual(f.bucket.value(KEY).outbox,[]);
 // A webhook outage longer than a day: the alert is never dropped, does not spend the cooldown or the daily quota, and is delivered on recovery.
 const o=stale();await o.M.run(o.env,{now:T0});o.setWebhook(false);
 for(let hour=1;hour<=27;hour++)await o.M.run(o.env,{now:T0+hour*H});
 let doc=o.bucket.value(KEY);assert.equal(doc.outbox.length,1,'one pending alert after 27 hours of outage');assert.equal(doc.outbox[0].kind,'alert');
 assert.deepEqual([doc.alerts.issues.epg_stale.sendCount,doc.alerts.issues.epg_stale.lastSentAt],[0,null],'failed sends are not counted');
 o.setWebhook(true);await o.M.run(o.env,{now:T0+28*H});doc=o.bucket.value(KEY);
 assert.deepEqual(doc.outbox,[]);assert.equal(doc.alerts.issues.epg_stale.sendCount,1);assert.equal(doc.alerts.issues.epg_stale.lastSentAt,at(T0+28*H),'accounting moves on delivery');
 assert.equal(posts(o.calls).filter(item=>item.body.key==='epg_stale').at(-1).body.kind,'alert');
 // More than twenty pending notifications are all kept and delivered after the provider recovers.
 const many=setup();healthy(many.bucket);await many.M.run(many.env,{now:T0});
 const seeded=many.bucket.value(KEY);seeded.outbox=Array.from({length:30},(_,index)=>({id:'seed_'+index+'|recovery|x',kind:'recovery',severity:'healthy',stream:'epg',key:'seed_'+index,message:'Recovered',queuedAt:at(T0-30*H)}));many.bucket.set(KEY,seeded);
 many.setWebhook(false);const before=posts(many.calls).length;const down=plain(await many.M.run(many.env,{now:T0+H}));
 assert.equal(many.bucket.value(KEY).outbox.length,30,'nothing is evicted during the outage');
 assert.equal(posts(many.calls).length-before,2,'an outage costs two attempts per tick, not thirty timeouts');assert.equal(down.ran,true);
 many.setWebhook(true);let hour=2;
 for(;many.bucket.value(KEY).outbox.length&&hour<20;hour++)await many.M.run(many.env,{now:T0+hour*H});
 assert.deepEqual(many.bucket.value(KEY).outbox,[]);assert.equal(hour,2+6,'drained at five per tick over six ticks');
 assert.equal(new Set(posts(many.calls).filter(item=>item.body.kind==='recovery'&&item.body.key.startsWith('seed_')).map(item=>item.body.id)).size,30,'all thirty ids were delivered');
 // A failing head does not starve the rest: failed messages move to the tail.
 const rot=setup();healthy(rot.bucket);await rot.M.run(rot.env,{now:T0});
 const doc2=rot.bucket.value(KEY);doc2.outbox=Array.from({length:8},(_,index)=>({id:'r'+index+'|recovery|x',kind:'recovery',severity:'healthy',stream:'epg',key:'r'+index,message:'Recovered',queuedAt:at(T0)}));rot.bucket.set(KEY,doc2);
 rot.setWebhook(false);await rot.M.run(rot.env,{now:T0+H});assert.deepEqual(rot.bucket.value(KEY).outbox.slice(0,6).map(item=>item.id.slice(0,2)),['r2','r3','r4','r5','r6','r7'],'the two failed heads moved behind the untried messages');
 // A recovery that could not be delivered is superseded when the issue is active again; the obsolete "Recovered" is never sent.
 const sup=stale();await sup.M.run(sup.env,{now:T0});await sup.M.run(sup.env,{now:T0+H});assert.equal(sup.bucket.value(KEY).alerts.issues.epg_stale.sendCount,1);
 sup.setWebhook(false);healthy(sup.bucket,{publishedAt:at(T0+2*H),runId:'run-b'});await sup.M.run(sup.env,{now:T0+3*H});
 assert.deepEqual(sup.bucket.value(KEY).outbox.map(item=>item.kind),['recovery'],'the recovery is queued while the webhook is down');
 sup.bucket.set('sync.json',{runId:'run-b',stage:'complete',updatedAt:at(T0-40*H),failures:[]});sup.bucket.set('epg/published-generation.json',{programmeRunId:'run-b',phase:'published'});
 await sup.M.run(sup.env,{now:T0+4*H});
 assert.deepEqual(sup.bucket.value(KEY).outbox.map(item=>item.kind),[],'the pending recovery is superseded when the issue is active again');
 // The issue clears before its first alert was ever delivered: the alert is cancelled and counted, and no recovery is sent for it.
 const r=stale();await r.M.run(r.env,{now:T0});r.setWebhook(false);await r.M.run(r.env,{now:T0+H});assert.equal(r.bucket.value(KEY).outbox.length,1);
 healthy(r.bucket,{publishedAt:at(T0+2*H),runId:'run-b'});await r.M.run(r.env,{now:T0+3*H});
 doc=r.bucket.value(KEY);assert.deepEqual(doc.outbox,[]);assert.equal(doc.cancelledUndelivered,1,'the cancelled alert is visible');
 assert.equal(posts(r.calls).filter(item=>item.body.kind==='recovery').length,0,'no recovery for an alert the owner never received');
 assert.equal(plain(await r.M.status(r.env,T0+3*H)).cancelledUndelivered,1);
 // Concurrent synthetic tests: one message.
 const c=setup();healthy(c.bucket);await c.M.run(c.env,{now:T0});
 const tests=plain(await Promise.all([c.M.test(c.env,T0+MIN),c.M.test(c.env,T0+MIN)]));
 assert.equal(tests.filter(item=>item.sent).length,1);assert.equal(posts(c.calls).length,1);assert.ok(tests.some(item=>item.reason==='concurrent'||item.reason==='recent'));
}

// 7. The status is a pure read and exposes the heartbeat age for an external dead-man check; the limitation is stated by the fields.
{
 const {bucket,env,M}=setup();healthy(bucket);
 const before=plain(await M.status(env,T0));assert.deepEqual([before.stored,before.heartbeatAt,before.sideEffects],[false,null,'none']);
 await M.run(env,{now:T0});const writesBefore=bucket.writes().length;
 const status=plain(await M.status(env,T0+90*MIN));
 assert.equal(bucket.writes().length,writesBefore,'status writes nothing');assert.equal(status.heartbeatAgeMs,90*MIN);assert.deepEqual([status.alerting,status.deadman,status.mode],[true,true,'on']);
 assert.doesNotMatch(JSON.stringify(status),/hooks\.example|beat\.example/,'the channel URLs never leave the Worker');
}

// 8. The synthetic test message: through the real channel, only the monitor's own document changes, and it is deduplicated.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 await M.run(env,{now:T0});const before=docs(bucket);
 const sent=plain(await M.test(env,T0+MIN));assert.equal(sent.sent,true);
 assert.deepEqual(posts(calls).map(item=>[item.body.kind,item.body.key]),[['test','monitor_test']]);
 const after=docs(bucket);for(const key of Object.keys(before))if(key!==KEY)assert.deepEqual(after[key],before[key],key+' unchanged');
 assert.equal(bucket.value(KEY).lastTestAt,at(T0+MIN));assert.deepEqual(bucket.value(KEY).alerts,{issues:{}},'a test raises no incident');
 assert.equal(plain(await M.test(env,T0+2*MIN)).reason,'recent','a second test inside ten minutes is not sent');assert.equal(posts(calls).length,1);
 const none=setup();assert.equal(plain(await none.M.test({...none.env,MONITOR_WEBHOOK_URL:undefined})).reason,'no_channel');
 assert.equal(plain(await none.M.test({...none.env,MONITOR_WEBHOOK_URL:'http://insecure.example/'})).reason,'no_channel','only HTTPS channels are used');
}

// 9. Wiring: the cron handler runs the monitor next to the other inert ticks, the routes are read-only or test-only, MONITOR is a registered flag.
{
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.match(worker,/typeof Monitor==='undefined'\?Promise\.resolve\(\):Monitor\.run\(env,\{now:controller\.scheduledTime\|\|Date\.now\(\)\}\)/);
 assert.match(worker,/\/api\/monitor\/status'&&request\.method==='GET'\)return json\(await Monitor\.status\(env\)\)/);
 assert.match(worker,/\/api\/monitor\/test'&&request\.method==='POST'\)return json\(await Monitor\.test\(env\)\)/);
 assert.match(fs.readFileSync('src/feature-flags.js','utf8'),/name:'MONITOR',modes:\['off','on'\],default:'off'/);
 assert.doesNotMatch(fs.readFileSync('src/monitor.js','utf8'),/dry/,'no dry code path or comment remains in the monitor');
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/MONITOR/,'no binding, secret or trigger is added by this change');
}
console.log('Monitor runtime: off and the retired dry token write nothing, healthy snapshot writes only its own document, one alert and one recovery, retried delivery, isolated failing source, discovery and queue, pure status and a deduplicated synthetic test passed');
