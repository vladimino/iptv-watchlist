// AIR-543 / ADR 0179. The `catalog_posters` stream of the production Monitor, over the real Monitor and the real poster module: the first-run
// grace is a write-once baseline of the Monitor's own document, a first valid checkpoint fixes `seenAt`, a later loss is `lost` (never a new grace),
// a degraded or needs_owner state is an issue that alerts through the existing policy, and a healthy week raises nothing.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,at=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-17T10:00:00Z'),KEY='monitor/state.json',CP='epg/catalog-poster-weekly.json';
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+scoped('src/catalog-poster-weekly.js','CatalogPosterWeekly')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 ctx.fetch=async()=>new Response('',{status:200});
 ctx.RatingsOrchestration={async readModel(){return {mode:'cloudflare',health:'healthy',failure:null};}};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_WEBHOOK_URL:'https://hooks.example/alert'});
 return {bucket,ctx,env,M:g(ctx,'Monitor')};
}
function healthy(bucket){
 bucket.set('sync.json',{runId:'run-a',stage:'complete',updatedAt:at(T0-3*H),failures:[]});
 bucket.set('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:at(T0-3*H),lastBatch:null});
}
const checkpoint=(over={})=>({schemaVersion:1,runId:'catalog_posters-2026-11-15',weekStart:'2026-11-15T00:00:00.000Z',status:'completed',lastScheduledAt:'2026-11-15T03:24:00.000Z',lastAttemptAt:'2026-11-15T03:24:00.000Z',lastCompletedAt:'2026-11-15T03:24:00.000Z',cursor:null,nextRetryAt:null,retryAttempts:0,rateLimitStreak:0,deferredReported:false,summary:{hydrated:0},outbox:[],...over});
const stream=async(M,env,now)=>plain(await M.status(env,now)).streams.find(item=>item.stream==='catalog_posters');
const state=bucket=>bucket.snapshot()[KEY];

// 1. Before any checkpoint: the Monitor records the baseline ONCE in its own document, the stream is grace/healthy and raises nothing.
{
 const {bucket,env,M}=setup();healthy(bucket);
 const result=plain(await M.run(env,{now:T0}));assert.equal(result.ran,true);
 assert.equal(state(bucket).catalogPostersBaselineAt,at(T0),'first evaluation writes the baseline');
 const first=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(first.state,'healthy');assert.equal(first.facts.state,'grace');assert.deepEqual(first.issues,[]);
 await M.run(env,{now:T0+6*H});assert.equal(state(bucket).catalogPostersBaselineAt,at(T0),'the baseline is write-once: it is never moved by a later tick');
 // no checkpoint is ever created: absence cannot grant indefinite grace
 await M.run(env,{now:Date.parse('2026-11-19T06:00:00Z')});
 let s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.facts.state,'overdue');assert.equal(s.state,'delayed');assert.deepEqual(s.issues,[],'delayed never alerts');
 await M.run(env,{now:Date.parse('2026-11-19T09:00:00Z')});
 s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.state,'degraded');assert.equal(s.issues[0].key,'catalog_posters_overdue');
 assert.ok(bucket.writes().map(item=>item.key).every(key=>key===KEY),'the Monitor writes only its own document, never the poster checkpoint');
}

// 2. A first valid checkpoint fixes `seenAt`; a healthy week is healthy with no issue; deleting the checkpoint later is `lost` (degraded), never a new grace.
{
 const {bucket,env,M}=setup();healthy(bucket);
 await M.run(env,{now:T0});
 bucket.set(CP,checkpoint());
 await M.run(env,{now:T0+H});
 assert.equal(state(bucket).catalogPostersSeenAt,at(T0+H));assert.equal(state(bucket).catalogPostersBaselineAt,at(T0),'the baseline is kept, not cleared');
 let s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.facts.state,'healthy_idle');assert.equal(s.state,'healthy');assert.deepEqual(s.issues,[]);
 bucket.delete?bucket.delete(CP):bucket.set(CP,undefined);
 await M.run(env,{now:T0+2*H});
 s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.facts.state,'lost');assert.equal(s.state,'degraded');assert.equal(s.issues[0].key,'catalog_posters_lost');
 // repeated loss: the baseline is not re-armed
 await M.run(env,{now:T0+5*H});assert.equal(state(bucket).catalogPostersBaselineAt,at(T0));
 s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.facts.state,'lost','still lost, never a second grace');
 // recovery
 bucket.set(CP,checkpoint());await M.run(env,{now:T0+6*H});
 s=state(bucket).streams.find(item=>item.stream==='catalog_posters');assert.equal(s.state,'healthy');
}

// 3. Corrupt, failed, stalled and a full outbox are issues; waiting is not.
{
 const {bucket,env,M}=setup();healthy(bucket);
 const keyOf=async(cp,now=T0)=>{bucket.set(CP,cp);await M.run(env,{now});const s=state(bucket).streams.find(item=>item.stream==='catalog_posters');return [s.facts.state,s.state,s.issues.map(item=>item.key)];};
 assert.deepEqual(await keyOf({schemaVersion:1,status:'pending'}),['unknown','degraded',['catalog_posters_unknown']]);
 assert.deepEqual(await keyOf(checkpoint({status:'failed'}),T0+H),['failed','needs_owner',['catalog_posters_failed']]);
 const full=Array.from({length:8},(_,i)=>({id:'e'+i,at:at(T0-H),payload:{type:'catalog_posters'},deliveredAt:null}));
 assert.deepEqual(await keyOf(checkpoint({outbox:full}),T0+2*H),['stalled','degraded',['catalog_posters_stalled']]);
 assert.deepEqual(await keyOf(checkpoint({status:'pending',nextRetryAt:at(T0+20*H),lastAttemptAt:at(T0-H)}),T0+3*H),['waiting','waiting',[]],'a legitimate backoff is not an issue');
}

// 4. Isolation: an unreadable checkpoint read never hides the other streams.
{
 const {bucket,env,M}=setup();healthy(bucket);
 const realGet=env.BUCKET.get.bind(env.BUCKET);env.BUCKET.get=async key=>{if(key===CP)throw new Error('r2');return realGet(key);};
 await M.run(env,{now:T0});
 const doc=state(bucket);const names=doc.streams.map(item=>item.stream);
 assert.deepEqual(names,['epg','discovery','ratings','predictions','catalog_posters']);
 assert.equal(doc.streams.find(item=>item.stream==='catalog_posters').state,'degraded');assert.equal(doc.streams.find(item=>item.stream==='epg').state,'healthy');
}
console.log('catalog-poster-monitor: write-once baseline and seenAt in the Monitor document, grace never indefinite, lost after seen is degraded and never a new grace, corrupt/failed/stalled/full-outbox issues, waiting is no issue, isolation from the other streams');
