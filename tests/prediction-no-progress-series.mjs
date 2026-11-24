// AIR-596 / ADR 0210: a scheduled but useless executor. Tasks keep starting prediction runs every 15 minutes, each run takes a 12-minute lease and is abandoned
// without a single commit, and there is still eligible work. The Footer (the real Worker route /api/enrichment/footer/status) and the hourly Cloudflare Monitor
// (Monitor.run with its real policy and outbox) share one verdict: «no confirmed progress» from the last durable productive commit, even while a run holds the
// lease at the tick and after the bounded run history has evicted the last success. One alert, the ordinary reminders, no false recovery, and one recovery
// that names why. Runs, leases and diagnostics are written by the Worker's own helpers (runnerLease, savePredictionRun), over an in-memory bucket with an
// injected clock; a second part runs the real batch start / submit / complete over the D1 stand-in with the auxiliary state in D1.
// Nothing here calls Cloudflare, a Task, a model or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,g} from './ratings-harness.mjs';
import {flowWorld} from './prediction-d1-flow-lib.mjs';

const MIN=60000,H=60*MIN,iso=ms=>new Date(ms).toISOString();
const QUEUE='enrichment/prediction-queue.json',LEASE='enrichment/runner-lease.json',STATE='monitor/state.json';
// The incident of 23-24 Nov 2026: the last productive batch ended 21:28:21.539 Madrid (20:28:21.539 UTC) with 5 created and 2 recalculated.
const P=Date.parse('2026-11-23T20:28:21.539Z');
const hot=Array.from({length:3171},(_,i)=>'h'+i),cold=Array.from({length:3798},(_,i)=>'c'+i);
const queueDoc=extra=>({schemaVersion:3,hotPending:hot,coldPending:cold,pending:[...hot,...cold],priorityCount:hot.length,coldRemaining:cold.length,retries:{},refreshedAt:iso(P),metrics:{hotAddedTotal:9000,hotProcessedTotal:812},
 lastBatch:{runId:'ffae2f94',trigger:'scheduled',startedAt:iso(P-9*MIN),finishedAt:iso(P),stage:'complete',batchSize:7,hotProcessed:7,coldProcessed:0,checked:7,added:5,updated:2,failed:0,remaining:hot.length+cold.length,hotRemaining:hot.length,coldRemaining:cold.length,reason:'manifest_spent'},...extra});

function world({telegram=false}={}){
 const {clock,FakeDate,crypto}=makeClock(P-20*MIN),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+scoped('src/domain/monitor-message.js','MonitorMessage')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 const posts=[];
 const texts=[];
 ctx.fetch=async(url,options={})=>{if(String(url).startsWith('https://hooks.example/')){posts.push(JSON.parse(options.body));return new Response('',{status:200});}
  if(String(url).startsWith('https://api.telegram.org/')){const text=JSON.parse(options.body).text;if(/· Прогнозы/.test(text))texts.push(text);return new Response(JSON.stringify({ok:true}),{status:200});}throw new Error('unexpected network '+url);};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_WEBHOOK_URL:'https://hooks.example/alert',...(telegram?{MONITOR_TRANSPORT:'telegram',MONITOR_TELEGRAM_BOT_TOKEN:'123456:'+'A'.repeat(35),MONITOR_TELEGRAM_CHAT_ID:'12345'}:{})});
 const M=g(ctx,'Monitor');
 const at=ms=>{clock.now=ms;};
 // A run as the Worker starts it: the lease first (the real acquire), then the run record, latest-run.json and its diagnostic checkpoint (the real savePredictionRun).
 const start=async(runId,ms)=>{at(ms);const lease=await ctx.runnerLease(env,runId,'acquire');assert.equal(lease.status,'owned',runId+' takes the free lease');
  const run={runId,status:'running',trigger:'scheduled',mode:'queued',protocol:'batch_v2',createdAt:iso(ms),leaseAcquiredAt:iso(ms),selectedIds:['h1','h2','h3','h4','h5','h6','h7'],batchSize:7,results:{},failures:{},baseline:{},selectionKind:{}};
  await ctx.savePredictionRun(env,run);return run;};
 const commit=async(run,ms,{created=0,recalculated=0,failed=0}={})=>{at(ms);const ids=run.selectedIds;let i=0;
  for(let k=0;k<created;k++)run.results[ids[i++]]='created';for(let k=0;k<recalculated;k++)run.results[ids[i++]]='recalculated';for(let k=0;k<failed;k++)run.failures[ids[i++]]={kind:'parse_error'};
  run.firstSubmitAt||=iso(ms);await ctx.savePredictionRun(env,run);return run;};
 const footer=async ms=>{at(ms);const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);assert.equal(response.status,200);
  const body=await response.json();return {source:body.integrations.sources.find(item=>item.id==='predictions'),run:body.lastRun};};
 const tick=async ms=>{at(ms);const result=await M.run(env,{now:ms});assert.equal(result.saved,true);const doc=bucket.value(STATE);return {doc,stream:doc.streams.find(item=>item.stream==='predictions')};};
 return {clock,bucket,ctx,env,M,posts,texts,at,start,commit,footer,tick};
}

// ---- 1. 13 hours of 15-minute starts with a 12-minute lease and zero commits; a run holds the lease at every hourly tick ----
{
 const w=world(),{bucket,posts}=w;
 // The last productive batch, completed as the Worker completes it (run record, diagnostic, lease released, the queue's lastBatch in the same write as its settlement).
 const p0=await w.start('ffae2f94',P-9*MIN);await w.commit(p0,P-6*MIN,{created:5,recalculated:2});
 Object.assign(p0,{status:'complete',completedAt:iso(P),stopReason:'manifest_spent',counts:{created:5,recalculated:2,failed:0,pending:0}});w.at(P);await w.ctx.savePredictionRun(w.env,p0);
 assert.equal((await w.ctx.runnerLease(w.env,'ffae2f94','release')).status,'owned');
 bucket.set(QUEUE,queueDoc());
 // The series: Tasks at :00/:15/:30/:45 from 21:45 Madrid. A second Task arriving while a run is live is turned away (`already_running`) and records no diagnostic.
 const slots=[];for(let ms=Date.parse('2026-11-23T20:45:00.000Z');ms<=Date.parse('2026-11-24T10:45:00.000Z');ms+=15*MIN)slots.push(ms);
 const ticks=[];for(let ms=Date.parse('2026-11-23T21:00:23.490Z');ms<=Date.parse('2026-11-24T10:00:23.490Z');ms+=H)ticks.push(ms);
 const events=[...slots.map(ms=>({ms,kind:'start'})),...ticks.map(ms=>({ms,kind:'tick'}))].sort((a,b)=>a.ms-b.ms);
 const seen=[];let n=0;
 for(const event of events){
  if(event.kind==='start'){
   await w.start('orphan-'+(++n),event.ms);
   if(n%4===0){w.at(event.ms+5*MIN);assert.equal((await w.ctx.runnerLease(w.env,'turned-away-'+n,'acquire')).status,'already_running','an overlapping Task is turned away');}
   continue;
  }
  const lease=bucket.value(LEASE);assert.ok(lease.expiresAt>event.ms&&lease.runId.startsWith('orphan-'),'a run holds the lease at the tick '+iso(event.ms));
  // AIR-588 shape: a recount of the queue between ticks (rebuild, moved counters, new refresh time) carries the last batch unchanged and is not progress.
  if(event.ms===ticks[5]){const q=bucket.value(QUEUE);bucket.set(QUEUE,{...q,refreshedAt:iso(event.ms-2*MIN),advancedAt:iso(event.ms-2*MIN),trigger:'batch_start_settle',metrics:{...q.metrics,hotProcessedTotal:q.metrics.hotProcessedTotal+3}});}
  const {doc,stream}=await w.tick(event.ms);
  const view=await w.footer(event.ms+30000);
  seen.push({at:iso(event.ms),monitor:stream.state,reason:stream.facts.stallReason,progressAt:doc.predictions.progressAt,footer:view.source.state,code:view.source.code,success:view.source.lastSuccessAt,run:view.run?.status});
 }
 // 21:00:23 UTC: 32 minutes after the last batch, one abandoned run and one live run: nothing is proven yet, the live run is running.
 assert.deepEqual([seen[0].monitor,seen[0].footer],['healthy','running'],JSON.stringify(seen[0]));
 // From 22:00:23 UTC on, every tick and every Footer read is the no-progress verdict, while a young run holds the lease each time.
 for(const row of seen.slice(1)){
  assert.equal(row.monitor,'degraded',JSON.stringify(row));assert.equal(row.footer,'degraded',JSON.stringify(row));assert.equal(row.code,'prediction_no_recent_progress',JSON.stringify(row));
  assert.equal(row.success,iso(P),'the Footer keeps the last confirmed success: '+JSON.stringify(row));
  assert.equal(row.progressAt,iso(P),'the Monitor clock is the commit time, never a tick or a start: '+JSON.stringify(row));
  assert.equal(row.run,'running','the operational run line still says «выполняется»: '+JSON.stringify(row));
 }
 assert.ok(seen.slice(1).some(row=>row.reason==='repeated_orphan_starts'),'the orphan chain names itself');
 // The bounded histories have long evicted the success: the Footer reads 8 diagnostics, the Monitor 20, and 56 runs started after it.
 const history=(await w.ctx.diagnosticHistory(w.env,20)).runs;assert.ok(!history.some(row=>row.runId==='ffae2f94'),'the last success is out of the 20-run history');
 // One alert at the first tick past the limit, the ordinary 6-hour reminders, no recovery, no alert per start or per overlap.
 const alerts=posts.filter(item=>item.key==='predictions_no_progress');
 assert.deepEqual(alerts.map(item=>[item.kind,item.at]),[['alert','2026-11-23T22:00:23.490Z'],['reminder','2026-11-24T04:00:23.490Z'],['reminder','2026-11-24T10:00:23.490Z']]);
 assert.equal(posts.filter(item=>item.kind==='recovery').length,0,'no false recovery');
 assert.match(alerts[0].message,/predictions are eligible and there is no confirmed progress for 1\.5 hours/);
 assert.match(alerts[0].message,/last confirmed progress 2026-11-23T20:28:21\.539Z/);
 assert.match(alerts[1].message,/ownerless starts/,'the reminder counts the confirmed orphan attempts');
 assert.match(alerts[1].message,/a run holds the lease now, which is not progress/);
 assert.doesNotMatch(alerts.map(item=>item.message).join(' '),/api_error|auth|expired authorization|missed Task/i,'no invented ChatGPT-side cause');
 const issue=bucket.value(STATE).alerts.issues.predictions_no_progress;assert.equal(issue.firstSeenAt,'2026-11-23T22:00:23.490Z','the incident keeps its first-seen time');assert.equal(issue.sendCount,3);

 // The queue's last batch is lost (an older queue document imported without it): the Monitor's stored clock and the Footer's read of it keep the commit time.
 const q=bucket.value(QUEUE);delete q.lastBatch;bucket.set(QUEUE,q);
 await w.start('orphan-late',Date.parse('2026-11-24T11:00:00.000Z'));
 let {stream,doc}=await w.tick(Date.parse('2026-11-24T11:00:23.490Z'));
 assert.equal(stream.state,'degraded');assert.equal(doc.predictions.progressAt,iso(P));
 let view=await w.footer(Date.parse('2026-11-24T11:01:00.000Z'));assert.equal(view.source.code,'prediction_no_recent_progress');assert.equal(view.source.lastSuccessAt,iso(P),'the Footer reads the Monitor clock when its own history and the queue no longer hold the success');

 // An unreadable queue split in the middle of the incident: unknown, not an outage and not a recovery; the incident stays open.
 bucket.set(QUEUE,{...q,hotPending:undefined,coldPending:undefined,pending:undefined});
 ({stream}=await w.tick(Date.parse('2026-11-24T12:00:23.490Z')));
 assert.equal(stream.state,'degraded');assert.equal(stream.facts.stall,'unknown');
 assert.match(JSON.stringify(bucket.value(STATE).streams.find(item=>item.stream==='predictions')),/predictions_no_progress/);
 assert.equal(posts.filter(item=>item.kind==='recovery').length,0,'an unreadable tick is not a recovery');
 bucket.set(QUEUE,q);

 // Genuine recovery: a run commits films (a mixed batch: 2 created, 1 failed) and is still working at the next tick. One recovery that names confirmed progress.
 const good=await w.start('productive',Date.parse('2026-11-24T12:15:00.000Z'));await w.commit(good,Date.parse('2026-11-24T12:24:00.000Z'),{created:2,failed:1});
 ({stream,doc}=await w.tick(Date.parse('2026-11-24T13:00:23.490Z')));
 assert.equal(stream.state,'healthy',JSON.stringify(stream));assert.equal(doc.predictions.progressAt,'2026-11-24T12:24:00.000Z','progress is dated by the first committed film of the working run');
 const recoveries=posts.filter(item=>item.kind==='recovery');assert.equal(recoveries.length,1);assert.equal(recoveries[0].key,'predictions_no_progress');
 assert.match(recoveries[0].message,/progress is confirmed again \(last confirmed progress 2026-11-24T12:24:00\.000Z\)/);
 // The productive run's lease expired at 12:27 without a completion: its progress is still dated by its commit (12:24), never by the expiry.
 view=await w.footer(Date.parse('2026-11-24T13:01:00.000Z'));assert.equal(view.source.state,'healthy',JSON.stringify(view.source));assert.equal(view.source.lastSuccessAt,'2026-11-24T12:24:00.000Z');
}

// ---- 2. Recovery names its reason, and only a proven reason recovers ----
async function openIncident(telegram=false){
 const w=world({telegram});bucket(w).set(QUEUE,queueDoc());
 for(let k=0;k<6;k++)await w.start('o'+k,P+(15+15*k)*MIN);
 await w.tick(P+2*H);assert.equal(telegram?w.texts.length:w.posts.filter(item=>item.kind==='alert').length,1,'the incident is open');
 return w;
}
function bucket(w){return w.bucket;}
{
 // All remaining work waits for its retry time: proven absence of eligible work, worded as such, never as progress.
 const w=await openIncident(),q=w.bucket.value(QUEUE),retries=Object.fromEntries(q.pending.map(id=>[id,{attempts:1,retryAt:P+9*H,retryable:true,scope:'item',kind:'parse_error'}]));
 w.bucket.set(QUEUE,{...q,retries});
 const {stream}=await w.tick(P+3*H);assert.equal(stream.state,'waiting');
 const recovery=w.posts.filter(item=>item.kind==='recovery');assert.equal(recovery.length,1);assert.match(recovery[0].message,/waits for its retry time; this is not confirmed progress/);
}
{
 // A drained queue: no eligible work at all.
 const w=await openIncident();w.bucket.set(QUEUE,{...queueDoc(),hotPending:[],coldPending:[],pending:[],priorityCount:0,coldRemaining:0});
 const {stream}=await w.tick(P+3*H);assert.equal(stream.state,'healthy');
 assert.match(w.posts.find(item=>item.kind==='recovery').message,/no prediction is eligible now .*this is not confirmed progress/);
}
{
 // The queue document is absent for a tick: the incident stays open (no recovery), and recovers on the next proven progress only.
 const w=await openIncident();const q=w.bucket.value(QUEUE);await w.bucket.delete(QUEUE);
 let {stream}=await w.tick(P+3*H);assert.equal(stream.state,'degraded');assert.equal(w.posts.filter(item=>item.kind==='recovery').length,0);
 // A new start, a manifest read, a heartbeat: not progress.
 w.bucket.set(QUEUE,q);const run=await w.start('fresh',P+4*H-10*MIN);w.at(P+4*H-5*MIN);assert.equal((await w.ctx.runnerLease(w.env,'fresh','renew')).status,'owned','a heartbeat renews the lease');
 ({stream}=await w.tick(P+4*H));assert.equal(stream.state,'degraded');assert.equal(w.posts.filter(item=>item.kind==='recovery').length,0);
 // A failed-only batch is not progress either; the queue's last batch with nothing saved changes nothing.
 await w.commit(run,P+4*H+5*MIN,{failed:3});w.bucket.set(QUEUE,{...q,lastBatch:{...q.lastBatch,runId:'fresh',added:0,updated:0,failed:3,finishedAt:iso(P+4*H+6*MIN),reason:null}});
 ({stream}=await w.tick(P+5*H));assert.equal(stream.state,'degraded');assert.equal(w.posts.filter(item=>item.kind==='recovery').length,0);
 // One recalculated film is progress.
 const next=await w.start('one',P+5*H+10*MIN);await w.commit(next,P+5*H+14*MIN,{recalculated:1});
 ({stream}=await w.tick(P+6*H));assert.equal(stream.state,'healthy');assert.equal(w.posts.filter(item=>item.kind==='recovery').length,1);
}
{
 // A young run with the last progress 25 minutes ago and two ordinary overlaps is running, not an incident (Footer and Monitor alike).
 const w=world();w.bucket.set(QUEUE,queueDoc());
 await w.start('a',P+15*MIN);w.at(P+20*MIN);assert.equal((await w.ctx.runnerLease(w.env,'b','acquire')).status,'already_running');
 const {stream}=await w.tick(P+25*MIN);assert.equal(stream.state,'healthy');assert.equal(stream.facts.stall,'running');
 assert.equal((await w.footer(P+25*MIN)).source.state,'running');assert.equal(w.posts.length,0);
 // The run is not given more than the limit: 70 minutes after the last progress the same young run is degraded with its lease.
 await w.start('c',P+60*MIN);const later=await w.tick(P+70*MIN);assert.equal(later.stream.state,'degraded');assert.equal((await w.footer(P+70*MIN)).source.code,'prediction_no_recent_progress');
}
{
 // A drained check (noop, nothing pending) in the queue's last batch is a confirmed empty queue: work that becomes eligible later is measured from it.
 const w=world();const q=queueDoc({lastBatch:{runId:null,trigger:'scheduled',startedAt:iso(P),finishedAt:iso(P),stage:'noop',batchSize:0,added:0,updated:0,failed:0,remaining:0,reason:null}});
 w.bucket.set(QUEUE,q);const {doc}=await w.tick(P+30*MIN);assert.equal(doc.predictions.progressAt,iso(P));
 // A retry-backoff wake-up (`runId: null`, stage blocked) is not.
 const v=world();v.bucket.set(QUEUE,queueDoc({lastBatch:{...q.lastBatch,stage:'blocked',reason:'retry_backoff',remaining:5}}));const blocked=await v.tick(P+30*MIN);assert.equal(blocked.doc.predictions.progressAt,null);
}

{
 // The Telegram text (ADR 0206 renderer): the alert counts the ownerless starts, the recovery says why it recovered.
 const w=await openIncident(true);
 assert.match(w.texts[0],/Запусков без фильма с последнего прогресса \(за последние 2 ч\): \d+/,w.texts[0]);
 assert.ok(w.bucket.value(STATE).alerts.issues.predictions_no_progress.metrics.orphanStarts>0);
 w.bucket.set(QUEUE,{...queueDoc(),hotPending:[],coldPending:[],pending:[],priorityCount:0,coldRemaining:0});await w.tick(P+3*H);
 assert.match(w.texts[1],/Причина: сейчас нечего прогнозировать .*это не подтверждённый прогресс/,w.texts[1]);
 const v=await openIncident(true);const run=await v.start('good',P+2*H+5*MIN);await v.commit(run,P+2*H+9*MIN,{created:1});await v.tick(P+3*H);
 assert.match(v.texts[1],/Причина: прогресс снова подтверждён \(последний подтверждённый прогресс/,v.texts[1]);
}

// ---- 2b. AIR-596 review: an unreadable split is unknown on both surfaces, never healthy or running; proven zero work stays healthy ----
{
 const broken=q=>({...q,hotPending:undefined,coldPending:undefined});
 // No prior incident, a fresh success and a young live run: Footer unknown (the run line still runs), Monitor delayed, no alert.
 const w=world();w.bucket.set(QUEUE,broken(queueDoc()));
 await w.start('young',P+10*MIN);
 const {stream}=await w.tick(P+15*MIN);assert.equal(stream.state,'delayed',JSON.stringify(stream));assert.equal(w.posts.filter(item=>item.key==='predictions_no_progress').length,0);
 let view=await w.footer(P+16*MIN);assert.deepEqual([view.source.state,view.source.code,view.source.lastSuccessAt,view.run.status],['unknown','no_data',iso(P),'running'],JSON.stringify(view));
 // An old success and no live run: still unknown, not «нет подтверждённого прогресса» (nothing is proven) and not healthy.
 view=await w.footer(P+5*H);assert.deepEqual([view.source.state,view.source.code],['unknown','no_data']);
 // No history at all.
 const empty=world();empty.bucket.set(QUEUE,broken(queueDoc({lastBatch:null})));view=await empty.footer(P);assert.deepEqual([view.source.state,view.source.code],['unknown','no_data']);
 // Genuinely zero eligible work: an empty pending list without lanes is proven, healthy on both surfaces.
 const zero=world();zero.bucket.set(QUEUE,{...broken(queueDoc()),pending:[]});
 const z=await zero.tick(P+5*H);assert.equal(z.stream.state,'healthy',JSON.stringify(z.stream));view=await zero.footer(P+20*MIN);assert.equal(view.source.state,'healthy');
}
{
 // One observation basis: with no progress time anywhere, the Footer reads the Monitor's persisted unknownSince (70 minutes) before its own oldest attempt (42 minutes).
 const w=world();w.bucket.set(QUEUE,queueDoc({lastBatch:null}));
 w.bucket.set(STATE,{schemaVersion:1,streams:[],alerts:{issues:{}},outbox:[],predictions:{pendingCount:6969,processedTotal:0,progressAt:null,progressBasis:'evidence',unknownSince:iso(P+2*H-70*MIN)}});
 await w.start('lonely',P+2*H-42*MIN);
 let view=await w.footer(P+2*H);assert.deepEqual([view.source.state,view.source.code],['degraded','prediction_no_recent_progress'],JSON.stringify(view.source));
 const {stream}=await w.tick(P+2*H+MIN);assert.equal(stream.state,'degraded','the Monitor measures from the same unknownSince');
 const alone=world();alone.bucket.set(QUEUE,queueDoc({lastBatch:null}));await alone.start('lonely',P+2*H-42*MIN);
 view=await alone.footer(P+2*H);assert.equal(view.source.state,'unknown','without the Monitor clock the Footer falls back to its oldest attempt (42 minutes: nothing proven)');
}
{
 // Progress-time provenance. An old productive run that expired without firstSubmitAt is dated by its start (70 min), never by the expiry the projection fills in (58 min).
 const w=world();w.bucket.set(QUEUE,queueDoc({lastBatch:null}));const t=P+3*H;
 w.bucket.set('enrichment/run-diagnostics/'+String(9999999999999-(t-70*MIN)).padStart(13,'0')+'-legacy.json',{runId:'legacy',trigger:'scheduled',startedAt:iso(t-70*MIN),endedAt:null,state:'running',startResult:'running',leaseAcquiredAt:iso(t-70*MIN),leaseExpiredAt:iso(t-58*MIN),added:2,updated:0,failed:0});
 const view=await w.footer(t);assert.deepEqual([view.source.state,view.source.lastSuccessAt],['degraded',iso(t-70*MIN)],JSON.stringify(view.source));
 const {doc}=await w.tick(t);assert.equal(doc.predictions.progressAt,iso(t-70*MIN));
 // The run order (by end) differs from the progress order: the latest progress time wins, not the first progress row.
 const now=P+5*H,rows=[{runId:'A',status:'complete',stopReason:'manifest_spent',added:3,updated:0,failed:0,startedAt:iso(now-60*MIN),endedAt:iso(now-50*MIN)},
  {runId:'B',status:'interrupted',stopReason:'lease_expired',added:1,updated:0,failed:0,startedAt:iso(now-58*MIN),firstSubmitAt:iso(now-55*MIN),endedAt:iso(now-40*MIN)}];
 assert.equal(w.ctx.predictionRunEvidence({run:null,recentRuns:rows,now}).lastProgressAt,iso(now-50*MIN));
 // A future time is not progress.
 assert.equal(w.ctx.predictionRunEvidence({run:null,recentRuns:[{...rows[0],endedAt:iso(now+H)}],now}).lastProgressAt,null);
}
{
 // Recovery needs a new progress observation: the same (or an older) time the open incident already knew holds it.
 const policy=await import('../src/domain/monitor-policy.js'),now=P+6*H;
 const open={noProgressOpenSince:iso(P+2*H),progressAt:iso(P),openMetrics:{eligible:9,idleMs:2*H,lastProgressAt:iso(P)},openMetricsAt:iso(P+2*H)};
 const facts=last=>({present:true,pendingCount:9,eligibleNow:9,lastProgressAt:iso(last),stall:{state:'ok',idleMs:now-last,sinceKnown:true}});
 const stale=policy.evaluatePredictions(facts(P),open,now);assert.equal(stale.state,'degraded');assert.equal(stale.facts.held,'progress_unconfirmed');assert.equal(stale.issues[0].metricsAt,iso(P+2*H));
 const fresh=policy.evaluatePredictions(facts(now-10*MIN),open,now);assert.deepEqual([fresh.state,fresh.facts.recovery,fresh.issues.length],['healthy','progress',0]);
 // The baseline is the incident's own measurement, not the memo clock a held tick moved: progressAt already equal to the new commit still recovers.
 const moved=policy.evaluatePredictions(facts(now-10*MIN),{...open,progressAt:iso(now-10*MIN)},now);assert.deepEqual([moved.state,moved.facts.recovery],['healthy','progress']);
 // An entry without typed metrics (before ADR 0206) falls back to the previous tick's clock: equal holds, newer recovers.
 const legacy={noProgressOpenSince:iso(P+2*H),progressAt:iso(now-10*MIN)};
 assert.equal(policy.evaluatePredictions(facts(now-10*MIN),legacy,now).facts.held,'progress_unconfirmed');
 assert.equal(policy.evaluatePredictions(facts(now-5*MIN),legacy,now).facts.recovery,'progress');
 // Chained through the planner: a legacy entry (no metrics) held on an unreadable split gets `{held}` only; it is not a measurement, so the legacy fallback
 // to the previous clock survives any number of held ticks.
 const plan=(issues,state,at)=>policy.planAlerts(issues,state,at).state;
 let alerts={issues:{predictions_no_progress:{severity:'degraded',firstSeenAt:iso(P+2*H),seen:3,lastSentAt:iso(P+2*H),sendCount:1,sendDay:iso(P+2*H).slice(0,10),sendsToday:1}}};
 const memo=iso(now-10*MIN),prev=()=>({progressAt:memo,noProgressOpenSince:alerts.issues.predictions_no_progress.firstSeenAt,openMetrics:alerts.issues.predictions_no_progress.metrics||null,openMetricsAt:alerts.issues.predictions_no_progress.metricsAt||null});
 for(const at of [now-2*H,now-H]){const out=policy.evaluatePredictions({present:true,pendingCount:9,eligibleNow:null,lastProgressAt:memo,stall:{state:'unknown',reason:'queue_unreadable'}},prev(),at);assert.equal(out.facts.held,'split_unknown');alerts=plan(out.issues,alerts,at);}
 assert.deepEqual(alerts.issues.predictions_no_progress.metrics,{held:'split_unknown'},'held-only, nothing measured');
 assert.equal(policy.evaluatePredictions(facts(now-10*MIN),prev(),now).facts.held,'progress_unconfirmed','equal progress still holds after held ticks');
 assert.equal(policy.evaluatePredictions(facts(now-5*MIN),prev(),now).facts.recovery,'progress','newer evidence recovers');
 assert.equal(policy.evaluatePredictions({present:true,pendingCount:0,eligibleNow:0,lastProgressAt:memo,stall:{state:'idle',reason:'no_eligible_work'}},prev(),now).facts.recovery,'no_eligible_work','proven zero recovers');
 // A measured stall whose progress time was unknown keeps its own null baseline: any valid progress recovers.
 assert.equal(policy.evaluatePredictions(facts(now-10*MIN),{...prev(),openMetrics:{eligible:9,idleMs:2*H,held:'split_unknown'}},now).facts.recovery,'progress');
}
{
 // A reminder that falls due while the verdict cannot be read, then a genuine recovery: the original measurement time, the incident history, the current
 // uncertainty and the recovery reason all reach the Telegram text.
 const w=await openIncident(true),alertAt=iso(P+2*H);
 assert.equal(w.bucket.value(STATE).alerts.issues.predictions_no_progress.metricsAt,alertAt);
 const q=w.bucket.value(QUEUE);w.bucket.set(QUEUE,{...q,hotPending:undefined,coldPending:undefined});
 for(let h=3;h<=8;h++){const {stream}=await w.tick(P+h*H);assert.equal(stream.state,'degraded');}
 const entry=w.bucket.value(STATE).alerts.issues.predictions_no_progress;
 assert.deepEqual([entry.firstSeenAt,entry.metricsAt,entry.metrics.held,entry.sendCount],[alertAt,alertAt,'split_unknown',2],JSON.stringify(entry));
 assert.equal(w.texts.length,2);const reminder=w.texts[1];
 assert.match(reminder,/Напоминание/);assert.match(reminder,/Сейчас: нельзя прочитать, сколько фильмов доступно к прогнозу; инцидент остаётся открытым/);
 assert.match(reminder,/было не меньше 2 ч \(на последнем наблюдении 23\.11 23:28\)/,reminder);assert.doesNotMatch(reminder,/Доступно к прогнозу сейчас/,'no stale count shown as current');
 w.bucket.set(QUEUE,q);const run=await w.start('back',P+9*H-20*MIN);await w.commit(run,P+9*H-15*MIN,{created:2});
 await w.tick(P+9*H);assert.equal(w.texts.length,3);const recovery=w.texts[2];
 assert.match(recovery,/Проблема снята/);assert.match(recovery,/Причина: прогресс снова подтверждён/);assert.match(recovery,/на последнем наблюдении 23\.11 23:28/,recovery);
 assert.match(recovery,/Длительность инцидента по наблюдениям монитора: 7 ч/,recovery);
}

{
 // AIR-596 re-review: a commit lands while the lanes cannot be read; the held tick already reads the new progress from the history. The next readable tick,
 // under 60 minutes after that commit and with no second commit, recovers exactly once (Footer healthy too); history and cooldown are untouched.
 const w=await openIncident(),q=w.bucket.value(QUEUE);
 const run=await w.start('during',P+3*H-10*MIN);await w.commit(run,P+3*H-5000,{created:1});
 w.bucket.set(QUEUE,{...q,hotPending:undefined,coldPending:undefined});
 let r=await w.tick(P+3*H);assert.equal(r.stream.state,'degraded');assert.equal(r.doc.alerts.issues.predictions_no_progress.metrics.held,'split_unknown');
 assert.equal(r.doc.predictions.progressAt,iso(P+3*H-5000),'the held tick advanced the memo clock');
 assert.equal(r.doc.alerts.issues.predictions_no_progress.metrics.lastProgressAt,iso(P),'the incident baseline is unchanged');
 w.bucket.set(QUEUE,q);
 r=await w.tick(P+3*H+59*MIN);assert.equal(r.stream.state,'healthy',JSON.stringify(r.stream));
 const recoveries=w.posts.filter(item=>item.kind==='recovery'&&item.key==='predictions_no_progress');assert.equal(recoveries.length,1);
 assert.match(recoveries[0].message,/progress is confirmed again \(last confirmed progress /);
 assert.equal(w.posts.filter(item=>item.key==='predictions_no_progress'&&item.kind!=='recovery').length,1,'one alert, no extra reminder');
 assert.equal((await w.footer(P+3*H+59*MIN)).source.state,'healthy');
}

// ---- 3. Rollout over the persisted production state of 24 Nov 2026 11:00 Madrid: alert history and the open incident are kept, nothing is resent ----
{
 const w=world();w.bucket.set(QUEUE,queueDoc());
 // The state an earlier build wrote: progressAt stamped at the 22:00:23 Madrid tick by the moved counter, the incident open since 08:00:23 Madrid, one alert sent.
 w.bucket.set(STATE,{schemaVersion:1,updatedAt:'2026-11-24T10:00:23.490Z',heartbeatAt:'2026-11-24T10:00:23.490Z',mode:'on',overall:'degraded',streams:[],outbox:[],holdUntil:null,lastDeliveryFailure:null,epgSeen:null,
  alerts:{issues:{predictions_no_progress:{severity:'degraded',firstSeenAt:'2026-11-24T07:00:23.490Z',seen:4,lastSentAt:'2026-11-24T07:00:23.490Z',sendCount:1,sendDay:'2026-11-24',sendsToday:1}}},
  predictions:{pendingCount:6969,processedTotal:815,progressAt:'2026-11-23T21:00:23.490Z',progressBasis:'evidence',unknownSince:null}});
 const live=await w.start('o-1015',Date.parse('2026-11-24T10:00:00.000Z'));assert.ok(live);
 const {doc,stream}=await w.tick(Date.parse('2026-11-24T11:00:23.490Z'));
 assert.equal(stream.state,'degraded','the young run at the tick no longer hides the incident');
 assert.deepEqual([doc.alerts.issues.predictions_no_progress.firstSeenAt,doc.alerts.issues.predictions_no_progress.sendCount],['2026-11-24T07:00:23.490Z',1],'alert history kept');
 assert.equal(w.posts.length,0,'inside the cooldown: no new alert, no recovery');
 assert.equal(doc.predictions.progressAt,'2026-11-23T21:00:23.490Z','a stored evidence clock is carried as written (at most one tick late), never moved forward');
}

// ---- 4. The real batch start / submit / complete over D1, with the auxiliary state in D1 (AIR-554): the durable clock is the completion, a new live run is not progress ----
{
 const w=await flowWorld({films:12,aux:'d1'});
 const {clock,FakeDate}=makeClock(Date.now());w.ctx.Date=FakeDate;
 const {start}=await w.reconcileAndStart({manifestSize:3});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 for(let i=0;i<3;i++){clock.now+=MIN;const p=await w.pair(start.data.runId);assert.equal(p.submit.status,200,JSON.stringify(p.submit.data).slice(0,200));}
 clock.now+=MIN;const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 const completedAt=done.data.at||vm.runInContext('null',w.ctx);
 const read=key=>w.ctx.__read(key);vm.runInContext('__read=key=>loadJSON(__env,key)',w.ctx);w.ctx.__env=w.env;
 let queue=await read('enrichment/prediction-queue.json');
 assert.equal(queue.lastBatch.runId,start.data.runId);assert.ok(queue.lastBatch.added+queue.lastBatch.updated>0,JSON.stringify(queue.lastBatch));
 assert.equal(w.ctx.predictionLastBatchProgressAt(queue,clock.now),queue.lastBatch.finishedAt);assert.equal(queue.lastBatch.finishedAt,completedAt);
 // 90 minutes later a Task starts a run that holds the lease and never submits.
 clock.now+=90*MIN;const second=await w.reconcileAndStart({manifestSize:3});assert.equal(second.start.status,200,JSON.stringify(second.start.data).slice(0,200));
 const writes=w.stats.writeBatches;
 queue=await read('enrichment/prediction-queue.json');const run=await read('enrichment/latest-run.json'),lease=await read('enrichment/runner-lease.json'),now=clock.now;
 const live=run.status==='running'&&lease.runId===run.runId&&lease.expiresAt>now;assert.equal(live,true,'the new run holds the lease');
 const footer=w.ctx.predictionCapabilityHealth({run,live,now,recentRuns:[],queue});
 assert.deepEqual([footer.state,footer.code,footer.lastSuccessAt],['degraded','prediction_no_recent_progress',completedAt],JSON.stringify(footer));
 const facts=w.ctx.predictionProgressFacts({queue,runs:[],latestRun:run,lease,now});assert.equal(facts.lastProgressAt,completedAt);assert.equal(facts.activeRun,true);
 const verdict=w.ctx.predictionStallAssessment({now,sinceMs:Date.parse(facts.lastProgressAt),eligibleNow:facts.slices.eligibleNow,activeRun:true,activeStartedAtMs:facts.activeStartedAtMs,orphanStarts:facts.orphanStarts});
 assert.equal(verdict.state,'no_progress',JSON.stringify(verdict));assert.equal(w.stats.writeBatches,writes,'the health reads write nothing');
}
console.log('prediction-no-progress-series: ok');
