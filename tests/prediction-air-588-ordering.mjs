// AIR-588 (A2, ADR 0204): ordering drift of the same completed generation leaves the synchronous batch_start and is rebuilt by the named writer `reconcilePredictionOrdering`
// on the hourly tick. Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2, with a stand-in for the published-EPG signature read. No production call.
import assert from 'node:assert/strict';
import * as PredictionD1 from '../src/prediction-d1.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const now=Date.now();
const make=async({films=12}={})=>{
 const w=await flowWorld({films,extra:()=>({shows:[{start:now-10*86400000}]})});
 const state={signature:'s0',down:false,reads:0,onRead:null};
 w.ctx.PublishedEpg={
  currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),
  readDocumentAt:async(env,run,kind)=>w.records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
  assignedShowsSignature:async()=>{state.reads++;if(state.down)throw new Error('d1 down');const value=state.signature;if(state.onRead)await state.onRead(state.reads);return value;},
 };
 // Discovery assigned shows (now airing) to the first `n` films of the fixed generation p1.
 const assign=(n,signature)=>{w.records.set('programme.json',{runId:'p1',films:[],catalogFilms:Array.from({length:n},(_,i)=>({tmdbId:String(i+1),shows:[{channelId:'c',channel:'C',start:now-600000,end:now+7200000,basis:'discovery'}]}))});state.signature=signature;};
 w.records.set('sync.json',{runId:'p1',stage:'complete'});assign(0,'s0');
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const queue=async()=>(await PredictionD1.openQueue(w.env)).queue;
 const leaseRow=()=>sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];
 const lease=()=>{const row=leaseRow();return row?JSON.parse(row.d):null;};
 const setLease=doc=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
 const release=()=>{if(leaseRow())sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");};
 const body={scope:'watchlist_all',mode:'queued',trigger:'scheduled',taskId:'task00',manifestSize:3,capacity:{remainingPercent:100}};
 const start=async(extra={})=>{release();w.logs.length=0;return w.api('batch/start',{...body,...extra});};
 const line=()=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start').at(-1);
 const ordering=async(options={})=>w.ctx.reconcilePredictionOrdering(w.env,{sleep:async()=>{},...options});
 const ageQueue=async ms=>{const head=await PredictionD1.openQueue(w.env);head.queue.refreshedAt=new Date(Date.parse(head.queue.refreshedAt)-ms).toISOString();assert.ok(await PredictionD1.writeQueue(w.env,head,head.queue));};
 return {w,state,assign,queue,lease,setLease,release,start,line,ordering,ageQueue};
};
const lanes=r=>r.data.films.map(f=>f.filmId+':'+f.lane);

// 1. A Task start on a queue owing an ordering re-rank of its own generation: no rebuild, no queue_refresh stage, the stored order is delivered; the dry run still reports the cause.
{
 const t=await make();const before=await t.queue();
 t.assign(5,'s1');
 const dry=await t.w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:3,capacity:{remainingPercent:100},dryRun:true});
 assert.equal(dry.data.priorityCause,'shows_signature_changed','the dry run still names the pending re-rank');
 const r=await t.start();
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'running');
 assert.ok(lanes(r).every(x=>x.endsWith(':cold')),'the stored (cold) order is delivered, the accepted lag: '+lanes(r));
 const after=await t.queue();assert.equal(after.refreshedAt,before.refreshedAt,'no rebuild');assert.equal(after.showsSignature,'s0');
 const l=t.line();assert.equal(l.notes.orderingDeferred,1);assert.equal(l.notes.refreshRounds,0);assert.ok(!l.stages.some(s=>s.stage==='queue_refresh'),'no queue_refresh stage');
 assert.equal(l.notes.priorityLagAccepted,1,'the post-lease preflight still sees the drift and accepts the lag');
 // 2. The writer: one rebuild, hot first, then nothing to do.
 t.release();
 const o=await t.ordering();assert.equal(o.event,'prediction_ordering_reconcile');assert.equal(o.outcome,'rebuilt',JSON.stringify(o));assert.equal(o.cause,'shows_signature_changed');
 const rebuilt=await t.queue();assert.equal(rebuilt.showsSignature,'s1');assert.ok(rebuilt.hotPending.length>=4,'films that now air are hot: '+rebuilt.hotPending.length);
 assert.equal((await t.ordering()).outcome,'current');
 const next=await t.start();assert.equal(next.data.status,'running');assert.ok(lanes(next).every(x=>x.endsWith(':hot')),'the next start delivers hot first: '+lanes(next));
}

// 3. Writer boundaries: a start in progress (claim) or a gated commit holds the lease -> no rebuild (waits, then gives up); a research-phase run does not block; a claim that appears during the
// rebuild aborts its write.
{
 const t=await make();t.assign(4,'s1');
 const claim={owner:'r1',runId:'r1',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+180000,epoch:5,phase:'claim',taskId:'task15'};
 await t.start();t.setLease(claim);
 let slept=0;const o=await t.ordering({waitMs:30000,pollMs:10000,sleep:async()=>{slept++;}});
 assert.equal(o.outcome,'skipped');assert.equal(o.reason,'busy');assert.ok(slept>=1,'it waited before giving up');assert.equal((await t.queue()).showsSignature,'s0','no rebuild under a claim');
 t.setLease({...claim,phase:'run',submitGate:{token:'x',expiresAt:Date.now()+60000}});
 assert.equal((await t.ordering({waitMs:0})).reason,'busy','a live commit gate blocks it too');
 t.setLease({...claim,phase:'run'});
 const research=await t.ordering();assert.equal(research.outcome,'rebuilt','a run in its research phase does not block the writer');assert.equal((await t.queue()).showsSignature,'s1');
 // a claim that appears while the rebuild runs: the write is withheld
 t.assign(6,'s2');t.setLease({...claim,expiresAt:1});
 const base=t.state.reads;t.state.onRead=n=>{if(n>=base+2)t.setLease({...claim,expiresAt:Date.now()+180000});};
 const raced=await t.ordering();t.state.onRead=null;
 assert.equal(raced.outcome,'skipped');assert.equal(raced.reason,'busy_at_write');assert.equal((await t.queue()).showsSignature,'s1','the queue was not written under the new claim');
}

// 4. What the writer never touches, and what the start still refreshes itself.
{
 // an unreadable signature: the writer skips; the start keeps today's behaviour (no silent cold pick)
 const t=await make();t.assign(4,'s1');t.state.down=true;
 const o=await t.ordering();assert.equal(o.outcome,'skipped');assert.equal(o.reason,'shows_signature_unreadable');assert.equal((await t.queue()).showsSignature,'s0');
 const r=await t.start();assert.notEqual(r.data.status,'running','an unreadable signature is never deferred: '+JSON.stringify(r.data).slice(0,200));
 t.state.down=false;
}
{
 // a queue that fails the advance gate (a new taste profile) is the start's to rebuild: the writer skips it
 const t=await make();t.assign(4,'s1');
 const profile={version:2,profileHash:'p2',profile:{ratingScale:'Scale 2'}};t.w.records.set('enrichment/profile/versions/2.json',profile);await PredictionD1.saveMutable(t.w.env,'enrichment/profile/current.json',profile);
 const o=await t.ordering();assert.equal(o.outcome,'skipped');assert.equal(o.reason,'not_current');
 const r=await t.start();assert.equal(r.data.status,'running');assert.ok(t.line().notes.refreshRounds>=1,'the start refreshed the stale queue itself');assert.ok(!t.line().notes.orderingDeferred);
}
{
 // a queue older than the 90-minute lag bound: the start rebuilds itself even for ordering drift
 const t=await make();t.assign(4,'s1');await t.ageQueue(91*60000);
 const r=await t.start();assert.equal(r.data.status,'running');assert.ok(!t.line().notes.orderingDeferred,'past the lag bound nothing is deferred');assert.equal(t.line().notes.refreshRounds,1);
 assert.equal((await t.queue()).showsSignature,'s1');assert.ok(lanes(r).every(x=>x.endsWith(':hot')));
}
{
 // a queue ranked while the signature was unreadable stores none: not a proven drift, the start rebuilds it and the writer leaves it alone
 const t=await make();const head=await PredictionD1.openQueue(t.w.env);head.queue.showsSignature=null;assert.ok(await PredictionD1.writeQueue(t.w.env,head,head.queue));
 t.state.signature='s1';
 assert.equal((await t.ordering()).reason,'unverified_basis');
 const r=await t.start();assert.equal(r.data.status,'running');assert.ok(!t.line().notes.orderingDeferred);assert.equal((await t.queue()).showsSignature,'s1');
}
{
 // an idle stored queue: nothing to deliver now, so the start reconciles before it can answer noop (AIR-529), as before
 const t=await make({films:2});
 const head=await PredictionD1.openQueue(t.w.env);const q=head.queue;q.pending=[];q.hotPending=[];q.coldPending=[];q.priorityCount=0;q.hotCount=0;q.coldCount=0;assert.ok(await PredictionD1.writeQueue(t.w.env,head,q));
 t.assign(2,'s1');
 const r=await t.start();assert.ok(!t.line().notes.orderingDeferred,'an idle queue is never deferred: '+JSON.stringify(t.line().notes));assert.equal(r.data.status,'running','the start reconciled instead of answering noop');assert.equal((await t.queue()).showsSignature,'s1');
}

// 5. The hourly tick runs the writer (one log line per tick) beside its other work; the fast and other cron expressions do not.
{
 const t=await make();t.assign(4,'s1');t.release();t.w.logs.length=0;t.w.ctx.clearTimeout=clearTimeout;
 const pending=[];const execution={waitUntil:p=>pending.push(p),passThroughOnException(){}};
 await t.w.ctx.worker.scheduled({cron:'0 * * * *',scheduledTime:Date.now()},t.w.env,execution);await Promise.allSettled(pending);
 const ticks=t.w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_ordering_reconcile');
 assert.equal(ticks.length,1,'one writer line per hourly tick');assert.equal(ticks[0].outcome,'rebuilt');assert.equal((await t.queue()).showsSignature,'s1');
 t.w.logs.length=0;pending.length=0;
 t.w.ctx.DISCOVERY_FAST_CRON='1-59/2 * * * *';// src/discovery-workflow.js defines it in the bundle; this world does not load that module
 await t.w.ctx.worker.scheduled({cron:'1-59/2 * * * *',scheduledTime:Date.now()},t.w.env,execution);await Promise.allSettled(pending);
 assert.ok(!t.w.logs.some(l=>/prediction_ordering_reconcile/.test(l)),'the Discovery fast cron does not run the writer');
}
console.log('AIR-588 A2: ordering drift deferred by the start, rebuilt by the hourly writer; claim and gate respected; unreadable, stale, overdue, unverified and idle queues unchanged');
