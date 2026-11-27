// AIR-572. The `canonical_producer` stream of the production Monitor, over the real Monitor and the real MonitorPolicy with stub D1 readers (no Worker,
// no Cloudflare, no network). It proves: DURABLE progress is the only clock (a publication, takeover, lease renewal or heartbeat never extends it), 113
// consecutive Workflow failures alert although the EPG is healthy, the delivery hold is visible and never healthy, a late but moving pass is not stalled,
// a rollover of the published generation cannot postpone the verdict, stops alert at once, dedup/recovery use the existing outbox, and the read cost is bounded.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,MIN=60000,at=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-23T10:00:00Z');
function setup({hold=false}={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 const calls=[];let webhookOk=true;
 ctx.fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null});return new Response('',{status:String(url).startsWith('https://hooks.example/')&&!webhookOk?503:200});};
 ctx.RatingsOrchestration={async readModel(){return {mode:'cloudflare',health:'healthy',failure:null};}};
 // The stub D1 readers answer from `world`; every read is counted and none writes.
 const world={P:'run-p',generation:10,publishedAt:at(T0),chain:null,run:null,reads:0,unreadable:false};
 const read=value=>{world.reads++;if(world.unreadable)throw new Error('d1 down');return value;};
 ctx.CanonicalProducerWorkflow={PRODUCER_DELIVERY_HOLD:hold,async readProducerMonitorFacts(){
  return read({ready:true,programmeRunId:world.P,generation:world.generation,label:world.P+':'+world.generation,publishedAt:world.publishedAt,chain:world.chain,run:world.run});}};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_WEBHOOK_URL:'https://hooks.example/alert',DB:{}});
 return {clock,bucket,ctx,env,calls,world,M:g(ctx,'Monitor'),setWebhook:ok=>{webhookOk=ok;}};
}
function epgHealthy(bucket,{runId='run-p',publishedAt=at(T0-3*H)}={}){
 bucket.set('sync.json',{runId,stage:'complete',updatedAt:publishedAt,failures:[]});
 bucket.set('epg/published-generation.json',{programmeRunId:runId,phase:'published'});
 bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:publishedAt,lastBatch:null});
 // AIR-598: a finished Discovery series of that generation, proven empty by its own last chunk (the Monitor judges Discovery from the shared classification).
 bucket.set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:publishedAt,hopId:'hop-a',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:runId});
 bucket.set('epg/discovery-status.json',{stage:'complete',programmeRunId:runId,hopId:'hop-a',finishedAt:publishedAt,remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null});
}
const posts=calls=>calls.filter(item=>item.method==='POST');
const producer=async(M,env,now)=>plain((await M.status(env,now)).streams).find(stream=>stream.stream==='canonical_producer');
const run=(over={})=>({run_key:'epg:run-p:10',pass_state:'passing',source_generation:'run-p:10',applied_generation:null,stopped_by:null,cursor_id:'film:tmdb:1',n_applied:0,n_noop:0,n_kept:0,n_failed:0,pass_no:1,updated_at:at(T0),...over});
const chain=(over={})=>({owner_state:'active',stopped_by:null,recovery_class:null,...over});

// 1. Delivery hold (re-imposed in code; lifted by default since AIR-572): visible, never healthy, no alert, and not a single D1 read.
{
 const {bucket,env,M,calls,world}=setup({hold:true});epgHealthy(bucket);
 const r=plain(await M.run(env,{now:T0}));
 assert.equal(r.ran,true);assert.equal(world.reads,0,'a held Producer is not read');
 const s=await producer(M,env,T0);
 assert.equal(s.facts.status,'held_by_delivery');assert.equal(s.state,'delayed');
 assert.notEqual(plain(await M.status(env,T0)).overall,'healthy','a held Producer cannot make the monitor healthy');
 assert.equal(posts(calls).length,0,'a deliberate hold is not an alert');
}

// 2. 113 consecutive Workflow failures: instances error, no run row, the chain keeps being taken over; the EPG is healthy; the monitor alerts about 2-3 h after publication.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'pending'});world.run=null;
 let fired=null;
 for(let hour=0;hour<=4;hour++){
  const now=T0+hour*H;
  world.chain=chain({owner_state:hour%2?'active':'pending',takeover_count:hour*28,updated_at:at(now)});   // takeovers/heartbeats move the chain row, never the clock
  await M.run(env,{now});
  if(!fired&&posts(calls).length)fired=hour;
 }
 assert.ok(fired>=2&&fired<=3,'actionable alert within 2-3 hourly ticks, got '+fired);
 const s=await producer(M,env,T0+4*H);
 assert.equal(s.facts.status,'stalled');assert.equal(s.state,'degraded');
 const all=plain(await M.status(env,T0+4*H));
 assert.equal(all.overall,'degraded','EPG healthy does not make the whole healthy');
 assert.ok(all.openIssues.some(item=>item.key==='canonical_producer_no_progress'));
 const sent=posts(calls).filter(item=>item.body.key==='canonical_producer_no_progress');
 assert.equal(sent.length,1,'one alert, deduplicated by the outbox across the later ticks');
 assert.equal(sent[0].body.stream,'canonical_producer');
}

// 3. A late but MOVING pass is not stalled; the same pass that stops moving is stalled 2 h after its last counter change.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.publishedAt=at(T0-5*H);world.chain=chain();
 for(let tick=0;tick<6;tick++){
  world.run=run({n_applied:tick*10,cursor_id:'film:tmdb:'+tick,updated_at:at(T0+tick*H)});
  await M.run(env,{now:T0+tick*H});
 }
 const moving=await producer(M,env,T0+5*H);
 assert.equal(moving.facts.status,'lagging');assert.equal(moving.state,'waiting');
 assert.equal(posts(calls).length,0,'a moving pass raises nothing');
 for(let tick=6;tick<=9;tick++)await M.run(env,{now:T0+tick*H});   // counters frozen from tick 5
 assert.equal((await producer(M,env,T0+9*H)).facts.status,'stalled');
 assert.equal(posts(calls).filter(item=>item.body.key==='canonical_producer_no_progress').length,1);
}

// 4. A rollover of the published generation without progress cannot postpone the verdict.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'pending'});
 for(let hour=0;hour<=3;hour++){
  world.generation=10+hour;world.publishedAt=at(T0+hour*H);
  await M.run(env,{now:T0+hour*H});
 }
 assert.equal(posts(calls).filter(item=>item.body.key==='canonical_producer_no_progress').length,1,'four rollovers in four hours did not reset the streak');
}

// 4b. Review P1: churn is not progress. Non-null run rows whose pass number, pass state, run key or generation change while ZERO units finish never reset the
// clock; a falling counter (a replay) and a growing failure count are not progress either; only finished units or a moved cursor of the SAME pass are.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain();
 for(let hour=0;hour<=4;hour++){
  world.generation=10+hour;world.publishedAt=at(T0+hour*H);
  world.run=run({run_key:'epg:run-p:'+world.generation,source_generation:'run-p:'+world.generation,pass_no:hour+1,pass_state:hour%2?'stopped':'passing',stopped_by:hour%2?'producer_transport':null,cursor_id:null,n_failed:hour,updated_at:at(T0+hour*H)});
  await M.run(env,{now:T0+hour*H});
 }
 const s=await producer(M,env,T0+4*H);
 assert.equal(s.facts.status,'stalled','restarts, rollovers and failures with zero finished units cannot postpone the verdict');
 assert.ok(posts(calls).some(item=>item.body.key==='canonical_producer_no_progress'));
}
{
 // The first sighting of a pass that already finished units starts the window at the first live tick; a replay that restarts LOWER is not progress; only the
 // growth of the same pass, or a moved cursor of it, is.
 const {bucket,env,M,world}=setup();epgHealthy(bucket);
 world.chain=chain();world.publishedAt=at(T0-5*H);
 world.run=run({n_applied:50,updated_at:at(T0-4*H)});
 await M.run(env,{now:T0});
 assert.equal((await producer(M,env,T0)).facts.status,'lagging','the window starts at the first live tick');
 world.run=run({n_applied:0,pass_no:2,cursor_id:null,updated_at:at(T0+H)});     // a restart (new pass) that has finished nothing yet
 await M.run(env,{now:T0+H});
 world.run=run({n_applied:0,pass_no:3,cursor_id:null,updated_at:at(T0+2*H)});   // and another one
 await M.run(env,{now:T0+3*H});
 assert.equal((await producer(M,env,T0+3*H)).facts.status,'stalled','restarts with zero finished units did not reset the clock');
 world.run=run({n_applied:9,pass_no:3,updated_at:at(T0+4*H)});   // the pass then finished units (first sighting with units: evidence at its own update time)
 await M.run(env,{now:T0+4*H});
 assert.equal((await producer(M,env,T0+4*H)).facts.status,'lagging','a pass that finished units is progress');
 world.run=run({n_applied:9,pass_no:3,updated_at:at(T0+4*H)});
 await M.run(env,{now:T0+6*H+MIN});
 assert.equal((await producer(M,env,T0+6*H+MIN)).facts.status,'stalled');
 world.run=run({n_applied:9,pass_no:3,cursor_id:'film:tmdb:900',updated_at:at(T0+7*H)});   // cursor-only move
 await M.run(env,{now:T0+7*H});
 assert.equal((await producer(M,env,T0+7*H)).facts.status,'lagging','a moved cursor of the same pass is progress');
}

// 5. Current means exactly one thing: the run of the published generation passed with the same applied generation. Zero eligible units is a pass.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'complete'});
 world.run=run({pass_state:'passed',applied_generation:'run-p:10',n_applied:0,n_noop:0,n_kept:0});
 await M.run(env,{now:T0+6*H});
 const s=await producer(M,env,T0+6*H);
 assert.equal(s.facts.status,'current');assert.equal(s.state,'healthy');assert.equal(posts(calls).length,0);
 // A pass of ANOTHER generation, or one with a different applied generation, is not current.
 world.run=run({pass_state:'passed',source_generation:'run-p:9',applied_generation:'run-p:9'});
 await M.run(env,{now:T0+7*H});
 assert.notEqual((await producer(M,env,T0+7*H)).facts.status,'current');
 // Missing chain and missing run: waiting inside the window, then stalled.
 world.run=null;world.chain=null;world.publishedAt=at(T0+7*H);
 await M.run(env,{now:T0+8*H});assert.equal((await producer(M,env,T0+8*H)).facts.status,'waiting');
}

// 6. A stop alerts at once: an identity or terminal stop is critical (ADR 0206), a recoverable stop is an ordinary degraded issue; both on the first snapshot.
{
 const a=setup();epgHealthy(a.bucket);
 a.world.chain=chain({owner_state:'stopped',stopped_by:'producer_identity_unresolved',recovery_class:'fail_closed'});
 await a.M.run(a.env,{now:T0});
 const hard=(await producer(a.M,a.env,T0));
 assert.equal(hard.facts.status,'blocked');assert.equal(hard.state,'degraded');
 assert.equal(posts(a.calls).filter(item=>item.body.key==='canonical_producer_failed'&&item.body.severity==='degraded'&&item.body.critical===true).length,1);
 const b=setup();epgHealthy(b.bucket);
 b.world.chain=chain({owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient'});
 await b.M.run(b.env,{now:T0});
 assert.equal((await producer(b.M,b.env,T0)).facts.status,'failed');
 assert.equal(posts(b.calls).filter(item=>item.body.key==='canonical_producer_failed'&&item.body.severity==='degraded'&&item.body.critical===false).length,1,'alert on the first snapshot');
}

// 7. Alert/recovery dedup through the existing outbox, and recovery once the exact generation passes.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'pending'});
 for(let hour=0;hour<=5;hour++)await M.run(env,{now:T0+hour*H});
 assert.equal(posts(calls).filter(item=>item.body.kind==='alert'&&item.body.key==='canonical_producer_no_progress').length,1);
 world.chain=chain({owner_state:'complete'});world.run=run({pass_state:'passed',applied_generation:'run-p:10'});
 await M.run(env,{now:T0+6*H});
 assert.equal(posts(calls).filter(item=>item.body.kind==='recovery'&&item.body.key==='canonical_producer_no_progress').length,1);
 assert.equal(plain(await M.status(env,T0+6*H)).openIssues.length,0);
}

// 8. An unreadable D1 is unreadable (never a pass), the streak survives it, and a failing transport keeps the message in the outbox for a retry.
{
 const {bucket,env,M,calls,world,setWebhook}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'pending'});
 await M.run(env,{now:T0});
 world.unreadable=true;
 await M.run(env,{now:T0+1*H});
 const s=await producer(M,env,T0+1*H);
 assert.equal(s.state,'degraded');assert.deepEqual(s.issues.map(item=>item.key),['canonical_producer_unreadable']);
 world.unreadable=false;setWebhook(false);
 await M.run(env,{now:T0+3*H});    // the streak began at T0: 3 h of silence -> alert queued, delivery fails
 const failed=plain(await M.status(env,T0+3*H));
 assert.ok(failed.outbox>=1,'the undelivered alert stays queued');
 setWebhook(true);
 await M.run(env,{now:T0+4*H});
 assert.ok(posts(calls).some(item=>item.body.key==='canonical_producer_no_progress'&&item.body.kind==='alert'),'the alert is delivered once the transport recovers');
}

// 9. Bounded and read-only: at most four reads per tick, no write outside the Monitor's own document, and the status read evaluates nothing.
{
 const {bucket,env,M,world}=setup();epgHealthy(bucket);
 world.chain=chain();world.run=run();
 await M.run(env,{now:T0});
 assert.equal(world.reads,1,'one reader call per tick (its three SQL statements are counted against the real database in canonical-producer-chain.mjs)');
 const before=world.reads;
 await M.status(env,T0+MIN);
 assert.equal(world.reads,before,'GET /api/monitor/status reads only the stored document');
 assert.deepEqual([...new Set(bucket.writes().map(item=>item.key))].filter(key=>key!=='monitor/state.json'),[]);
}
// 10. AIR-692: the normal idle after a proven pass is not "no progress". Facts of 25-26.11: generation passed (also with ZERO units), 22 h of idle, a new EPG
// publication, the hourly tick sees the new generation before its chain exists, then the normal start and pass: no alert and no recovery, on several daily cycles.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 let now=T0;
 for(let day=0;day<4;day++){
  const gen=10+day,label='run-p:'+gen,zero=day===2;
  world.generation=gen;world.publishedAt=at(now);world.chain=null;world.run=null;
  await M.run(env,{now:now+58*MIN});                       // tick 18:00: published, chain and run still absent
  world.chain=chain({owner_state:'complete'});
  world.run=run({run_key:'epg:run-p:'+gen,pass_state:'passed',source_generation:label,applied_generation:label,n_applied:zero?0:3,n_noop:zero?4004:0,updated_at:at(now+90*MIN)});
  await M.run(env,{now:now+2*H});                          // finished between ticks, seen by the next one
  now+=24*H;
  await M.run(env,{now:now-2*H+MIN});
  const s=await producer(M,env,now-2*H+MIN);
  assert.equal(s.facts.status,'current','day '+day);
 }
 assert.deepEqual(posts(calls).filter(item=>item.body.stream==='canonical_producer').map(item=>item.body.key+':'+item.body.kind),[],'no false alert and no recovery across the daily cycles');
}
// 10b. A new generation after a proven pass that never starts still alerts after the existing 2 h window, and an unfinished one keeps its old streak.
{
 const {bucket,env,M,calls,world}=setup();epgHealthy(bucket);
 world.chain=chain({owner_state:'complete'});world.run=run({pass_state:'passed',source_generation:'run-p:10',applied_generation:'run-p:10'});
 await M.run(env,{now:T0});
 world.generation=11;world.publishedAt=at(T0+20*H);world.chain=null;world.run=null;
 for(const h of [20,21,22,23])await M.run(env,{now:T0+h*H+MIN});
 assert.equal((await producer(M,env,T0+23*H+MIN)).facts.status,'stalled');
 assert.equal(posts(calls).filter(item=>item.body.key==='canonical_producer_no_progress'&&item.body.kind==='alert').length,1);
}
console.log('monitor canonical_producer stream: ok');
