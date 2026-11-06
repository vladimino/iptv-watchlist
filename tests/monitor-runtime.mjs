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
 assert.equal(bucket.writes().length,0);assert.equal(calls.length,0);
 const before=JSON.stringify(docs(bucket));
 const dry=plain(await M.run({...env,MONITOR:'dry'},{now:T0}));
 assert.equal(dry.mode,'dry');assert.equal(bucket.writes().length,0,'dry writes nothing');assert.equal(calls.length,0,'dry sends nothing and pings nothing');assert.equal(JSON.stringify(docs(bucket)),before);
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
 assert.deepEqual(Object.keys(message).sort(),['at','id','key','kind','message','overall','severity','source','stream']);
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

// 6. Prediction queue: an empty queue is healthy; scheduled zero-work wake-ups are not progress; real progress is; retry backoff waits.
{
 const {bucket,env,M,calls}=setup();healthy(bucket);
 const noop=ms=>bucket.set('enrichment/prediction-queue.json',{pending:['a','b'],hotPending:['a','b'],coldPending:[],retries:{},refreshedAt:at(ms),lastCheckAt:at(ms),metrics:{hotProcessedTotal:7},
  lastBatch:{runId:null,batchSize:0,added:0,updated:0,stage:'blocked',startedAt:at(ms),finishedAt:at(ms)}});
 // Every hour a scheduled batch finds nothing to do and rewrites lastBatch and lastCheckAt; the pending queue never moves.
 let states=[];
 for(let hour=0;hour<=9;hour++){noop(T0+hour*H);await M.run(env,{now:T0+hour*H});states.push(bucket.value(KEY).streams.find(item=>item.stream==='predictions').state);}
 assert.deepEqual(states.slice(0,3),['healthy','healthy','healthy']);assert.ok(states.includes('delayed'),'zero-work batches become delayed');assert.equal(states.at(-1),'degraded','and then degraded');
 assert.equal(posts(calls).filter(item=>item.body.key==='predictions_stale').length,1,'one alert, not one per wake-up');
 // A moved processed counter is real progress and recovers the stream.
 bucket.set('enrichment/prediction-queue.json',{...bucket.value('enrichment/prediction-queue.json'),metrics:{hotProcessedTotal:9}});
 await M.run(env,{now:T0+10*H});assert.equal(bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'healthy');
 // Work that is all deferred by its own retry time is waiting by design, however long it is idle.
 const backoff=setup();healthy(backoff.bucket);
 backoff.bucket.set('enrichment/prediction-queue.json',{pending:['a'],hotPending:['a'],coldPending:[],retries:{a:{retryAt:T0+30*H}},metrics:{hotProcessedTotal:1},lastBatch:null});
 await backoff.M.run(backoff.env,{now:T0});await backoff.M.run(backoff.env,{now:T0+8*H});
 assert.equal(backoff.bucket.value(KEY).streams.find(item=>item.stream==='predictions').state,'waiting');assert.equal(posts(backoff.calls).length,0);
 const quiet=setup();healthy(quiet.bucket);quiet.bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:at(T0-30*H),lastBatch:null});
 await quiet.M.run(quiet.env,{now:T0});assert.equal(quiet.bucket.value(KEY).overall,'healthy');
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
 assert.match(fs.readFileSync('src/feature-flags.js','utf8'),/name:'MONITOR',modes:\['off','dry','on'\],default:'off'/);
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/MONITOR/,'no binding, secret or trigger is added by this change');
}
console.log('Monitor runtime: off and dry write nothing, healthy snapshot writes only its own document, one alert and one recovery, retried delivery, isolated failing source, discovery and queue, pure status and a deduplicated synthetic test passed');
