// AIR-417 / AIR-424 / AIR-431 on batch runner v2 (ADR 0167; D1 prediction authority, as production runs it). A catalog that an EPG publication holds or loads
// is a wait at start, not a storage failure: the start answers 503 prediction_catalog_held, takes no lease, creates no run and writes no stop or run Event (AIR-575, ADR 0189: it leaves exactly one neutral skipped Event of the refused attempt). A run that
// already owns its manifest reads no catalog: its batch submit and its completion are untouched by a held catalog, and an identical replay is already_current.
// The stage failure lines of the retired v5 start (diagnosedStart) are gone with it. Local stand-ins only.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const w=await flowWorld({films:6});assert.equal((await w.api('queue/reconcile',{})).status,200);
const logs=[];w.ctx.console={log:()=>{},info:()=>{},warn:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.join(' '))};
const lines=()=>logs.filter(l=>l.includes('prediction_boundary_failed')).map(l=>JSON.parse(l));
const START={scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100},manifestSize:2};
const leaseRow=()=>sql(w.file,"SELECT expires_at AS e, document_json AS d FROM prediction_lease WHERE name='runner'")[0]||null;
const runCount=()=>sql(w.file,'SELECT COUNT(*) AS n FROM prediction_run')[0].n;
// A skipped attempt (AIR-575) is its own neutral Event: it is not a stop or a run Event, so the checks below exclude it and a separate check counts it.
const isSkipped=key=>key.includes('-enrichment-skipped-')||key.includes('stop-events/skipped-');
const eventKeys=()=>[...w.records.keys()].filter(key=>(key.startsWith('events/')||key.includes('stop-events/'))&&!isSkipped(key)).sort();
const skippedKeys=()=>[...w.records.keys()].filter(key=>key.includes('stop-events/skipped-')).sort();
const versionKeys=filmId=>[...w.records.keys()].filter(key=>key.includes('/'+filmId+'/predictions/versions/'));
const runRow=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);
// A held (discovery_fence) or loading (discovery_incomplete) Discovery authority, as an EPG publication sets it.
const withGate=async(gate,work)=>{w.ctx.DiscoveryAuthority={...Authority,readAuthority:async()=>gate};try{return await work();}finally{w.ctx.DiscoveryAuthority=Authority;}};
const GATES=[[{held:true,ready:true,transfer:'idle'},'discovery_fence'],[{held:false,ready:true,transfer:'loading'},'discovery_incomplete']];

// 1. The gate is checked before the lease: a held or loading authority answers the wait without a lease, a run, an Event or a queue change.
for(const [gate,cause] of GATES){
 logs.length=0;const skippedWas=skippedKeys().length,leaseWas=JSON.stringify(leaseRow()),runsWas=runCount(),eventsWas=eventKeys(),queueWas=JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));
 const held=await withGate(gate,()=>w.api('batch/start',START));
 assert.equal(held.status,503,cause);assert.equal(held.data.status,'blocked');assert.equal(held.data.reason,'catalog_held');assert.equal(held.data.code,'prediction_catalog_held');assert.equal(held.data.cause,cause);
 assert.ok(!held.data.error,'not a storage_error');
 assert.equal(JSON.stringify(leaseRow()),leaseWas,cause+': no lease was taken');assert.equal(runCount(),runsWas,cause+': no run');
 assert.deepEqual(eventKeys(),eventsWas,cause+': no stop Event');assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),queueWas,cause+': the queue is untouched');
 assert.equal(lines().length,0,cause+': a wait is not a failed boundary');
 assert.equal(skippedKeys().length,skippedWas+1,cause+': exactly one skipped Event of the refused attempt');
}

// 2. After the publication the start runs; a held catalog then reaches neither the batch submit nor its identical replay, nor the completion.
logs.length=0;
const running=(await w.api('batch/start',START)).data;assert.equal(running.status,'running');
const [first,second]=running.films.map(f=>f.filmId);
const payload={runId:running.runId,epoch:running.lease.epoch,items:[{filmId:first,fingerprint:w.fingerprint,prediction:w.prediction}]};
const beforeEvents=eventKeys();
for(const [gate,cause] of GATES){
 const held=await withGate(gate,()=>w.api('batch/submit',payload));
 assert.equal(held.status,200,cause);assert.ok(['created','already_current'].includes(held.data.results[0].status),cause);
 assert.equal(runRow(running.runId).status,'running',cause);assert.equal(runRow(running.runId).results[first],'created',cause);
 assert.equal(versionKeys(first).length,1,cause+': one version object');assert.deepEqual(eventKeys(),beforeEvents,cause);
}
const replay=await w.api('batch/submit',payload);assert.equal(replay.status,200);assert.equal(versionKeys(first).length,1,'no second version');
const held=await withGate(GATES[0][0],()=>w.api('batch/submit',{runId:running.runId,epoch:running.lease.epoch,items:[{filmId:second,fingerprint:w.fingerprint,prediction:w.prediction}]}));
assert.equal(held.status,200);assert.equal(held.data.results[0].status,'created');
const finished=await withGate(GATES[0][0],()=>w.api('complete',{runId:running.runId,reason:'manifest_spent'}));
assert.equal(finished.status,200,JSON.stringify(finished.data).slice(0,200));assert.equal(runRow(running.runId).status,'complete');
assert.equal(lines().length,0,'no failed boundary');
console.log('prediction start diagnostics (batch v2): a held or loading catalog is a lease-free 503 wait at start; an owned manifest submits, replays and completes untouched by a held catalog passed');
