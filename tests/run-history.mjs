// Run diagnostic history of batch runner v2 runs (ADR 0167; D1 prediction authority, as production runs it): normal, already_running and quota outcomes, a run
// that died before and after its first saved result, immutable counters, stale-lease recovery, the separate active run, newest-first order and more than twenty
// persistent records. Reads write nothing. Local stand-ins only.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:8});const records=w.records,ctx=w.ctx,env=w.env;
const writes=[];
{const bucket=env.BUCKET,put=bucket.put;bucket.put=async(key,value,options)=>{const saved=await put.call(bucket,key,value,options);if(saved)writes.push(key);return saved;};
 bucket.list=async({prefix='',limit=1000}={})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false});}
const d1Writes=()=>w.stats.writeBatches;
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
let clockTime=Date.now();class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}ctx.Date=Clock;
assert.equal((await api('queue/reconcile',{})).status,200);
const runRow=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);
const history=async(limit=100)=>(await api('runs?limit='+limit,undefined,'GET')).data.runs,find=async id=>(await history()).find(r=>r.runId===id);
const startRun=async(body={})=>{clockTime+=1000;return (await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:3,...body})).data;};
const submit=(run,ids)=>api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:ids.map(filmId=>({filmId,fingerprint:w.fingerprint,prediction:w.prediction}))});

let a=await startRun();assert.equal(a.status,'running');assert.equal((await find(a.runId)).startResult,'running');assert.equal((await find(a.runId)).leaseAcquiredAt,new Clock().toISOString());
const beforeEvents=[...records.keys()].filter(k=>k.startsWith('events/items/')).length;await startRun();let rows=await history();const concurrent=rows[0];assert.equal(concurrent.startResult,'already_running');assert.notEqual(concurrent.runId,a.runId);assert.equal(concurrent.leaseAcquiredAt,null);assert.equal([...records.keys()].filter(k=>k.startsWith('events/items/')).length,beforeEvents);assert.equal((await api('status',undefined,'GET')).data.currentRun.runId,a.runId);
// Death with a lease before any saved result, observed by reads before the following trigger, which write nothing.
clockTime+=16*60000;writes.length=0;let d1=d1Writes();let prior=await find(a.runId);assert.equal(prior.state,'interrupted');assert.equal(prior.stopReason,'lease_expired');assert.equal(prior.firstSubmitAt,null);assert.equal(writes.length,0);assert.equal(d1Writes(),d1);assert.equal(runRow(a.runId).status,'running');
assert.equal((await api('status',undefined,'GET')).data.live.state,'blocked');assert.equal(writes.length,0);assert.equal(d1Writes(),d1);
let b=await startRun();assert.equal(b.status,'running');assert.equal((await find(b.runId)).startResult,'recovered_stale_lease');assert.equal(runRow(a.runId).status,'interrupted');assert.equal(runRow(a.runId).stopReason,'lease_expired');
// Several saved results followed by death retain the actual counters and the first successful-submit time.
clockTime+=1000;assert.equal((await submit(b,b.films.map(f=>f.filmId))).status,200);prior=await find(b.runId);assert.equal(prior.added,3);assert(prior.firstSubmitAt);
clockTime+=16*60000;let c=await startRun();assert.equal(c.status,'running');prior=await find(b.runId);assert.equal(prior.state,'interrupted');assert.equal(prior.stopReason,'lease_expired');assert.equal(prior.added,3);assert(prior.firstSubmitAt);
clockTime+=1000;await api('complete',{runId:c.runId,reason:'quota'});prior=await find(c.runId);assert.equal(prior.state,'blocked');assert.equal(prior.stopReason,'quota');assert(prior.endedAt);
// Normal completion, separated from the active run and the interrupted history.
let e=await startRun({manifestSize:10});clockTime+=1000;assert.equal(e.films.length,5);await submit(e,e.films.map(f=>f.filmId));await api('complete',{runId:e.runId});
prior=await find(e.runId);assert.equal(prior.state,'completed');assert.equal(prior.startResult,'running');assert.equal(prior.stopReason,'queue_empty');assert.equal(prior.added,5);assert.equal((await api('status',undefined,'GET')).data.currentRun,null);
const example={runs:await history(3)};fs.mkdirSync('outputs',{recursive:true});fs.writeFileSync('outputs/run-history-example.json',JSON.stringify(example,null,2)+'\n');
for(let i=0;i<22;i++)await startRun();rows=await history(30);assert(rows.length>=20);for(let i=1;i<rows.length;i++)assert(rows[i-1].startedAt>=rows[i].startedAt);assert(rows.some(r=>r.runId===c.runId));assert.equal((await api('runs?limit=0',undefined,'GET')).status,400);assert(!/hash|Bearer|token|prompt|raw|stack/i.test(JSON.stringify(rows)));
console.log('Diagnostic history (batch v2): normal/already_running/quota, death before and after saved results, immutable counters, stale recovery, separate active run, newest-first and 20+ persistent records passed');
console.log(JSON.stringify(example,null,2));
