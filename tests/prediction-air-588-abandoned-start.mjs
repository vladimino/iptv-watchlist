// AIR-588 (P0 RCA): the Worker side of the 23 Nov 2026 Predictions stop, replayed offline on the real Worker over a sqlite D1 stand-in and an in-memory R2. No production call, no Scheduled Task, no model.
// Production chain (Cloudflare Workers Observability, 20:33-21:58 UTC): a synchronous labelled `batch_start` of 100-114 s; the ChatGPT MCP client re-initialised at +60 s and repeated the start
// (`start_pending` after the 10 s join bound), read `prediction_batch_manifest` one to three times (`manifest_pending`), then made no further call; or it made no call at all after the start.
// The first start still finished with HTTP 200 and a stored manifest, the abandoned lease turned the other Tasks away as `already_running` until it expired, and the next start opened a new run.
// What this file pins: every Worker answer in that chain is the documented one (ADR 0188/0195), nothing is lost or committed twice, and the only cost of an abandoned client is the blocked lease window.
// It does not (and cannot) reproduce why the client stopped polling: that is ChatGPT Task behaviour outside the Worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const MANIFEST_SIZE=7;
const batch=(w,taskId,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:MANIFEST_SIZE,taskId,...body});
const leaseRow=w=>sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];
const leaseDoc=w=>{const row=leaseRow(w);return row?JSON.parse(row.d):null;};
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const runDoc=(w,id)=>{const rows=sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'");return rows[0]?JSON.parse(rows[0].d):null;};
const manifestKey=id=>'enrichment/batch-manifest/'+id+'.json';
const item=(w,id)=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});
const waitFor=async(check,label,ms=20000)=>{const until=Date.now()+ms;for(;;){const v=check();if(v)return v;if(Date.now()>until)throw new Error('timeout waiting for '+label);await new Promise(r=>setTimeout(r,25));}};

const w=await flowWorld({films:20});
{const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));}
vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};

// The long first start: its manifest write is held, as the 100-155 s production starts were still preparing when the client gave up on the call.
let release;const gate=new Promise(r=>{release=r;});let held=false;
const put=w.env.BUCKET.put.bind(w.env.BUCKET);
w.env.BUCKET.put=async(key,value,options)=>{if(/^enrichment\/batch-manifest\//.test(key)&&!held){held=true;await gate;}return put(key,value,options);};
const first=batch(w,'task00');

// 1. The Task's own repeat (the client re-initialised and resent the same start): `start_pending` naming the one run and its epoch, never `already_running`, never a second run.
await waitFor(()=>held,'the first start to reach its manifest write');
const claim=leaseDoc(w);assert.equal(claim.taskId,'task00');assert.ok(Number(claim.expiresAt)>Date.now());
const repeat=await batch(w,'task00');
assert.equal(repeat.status,200,JSON.stringify(repeat.data).slice(0,300));assert.equal(repeat.data.status,'start_pending');
assert.equal(repeat.data.runId,claim.runId);assert.equal(repeat.data.epoch,claim.epoch);assert.equal(repeat.data.read.tool,'prediction_batch_manifest');assert.equal(repeat.data.read.pendingCode,'manifest_pending');
assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n<=1,true,'a repeat creates no second run');

// 2. The readback while the first start still prepares: a successful MCP result of kind pending (HTTP 409 manifest_pending underneath), not an error the prompt treats as a stop.
const pending=await tool('prediction_batch_manifest',{taskId:'task00',runId:claim.runId});
assert.equal(pending.isError,undefined,JSON.stringify(pending).slice(0,300));assert.match(JSON.stringify(pending),/manifest_pending/);assert.match(JSON.stringify(pending),/kind.{1,8}pending/);

// 3. Another Task's slot during the long start: `already_running` naming the holder; it assigns nothing.
const foreign=await batch(w,'task15');assert.equal(foreign.data.status,'already_running');assert.equal(foreign.data.runId,claim.runId);assert.equal(leaseDoc(w).taskId,'task00');

// 4. The first start completes with HTTP 200 and the full manifest, whether or not anyone still listens (production: `delivery=unconfirmed`, no serverFault).
release();
const done=await first;
assert.equal(done.status,200,JSON.stringify(done.data).slice(0,300));assert.equal(done.data.status,'running');assert.equal(done.data.runId,claim.runId);
assert.equal(done.data.films.length,MANIFEST_SIZE);assert.ok(w.records.get(manifestKey(claim.runId)),'the manifest is stored for a readback');

// 5. A client that kept polling would have recovered the same manifest (the 20:17 UTC run did exactly this).
const ready=await tool('prediction_batch_manifest',{taskId:'task00',runId:claim.runId});
assert.equal(ready.isError,undefined,JSON.stringify(ready).slice(0,300));assert.equal(JSON.parse(ready.content[0].text).manifestHash,done.data.manifestHash);
const rejoin=await batch(w,'task00');assert.equal(rejoin.data.status,'running');assert.equal(rejoin.data.manifestHash,done.data.manifestHash,'a later repeat of the same Task returns the same stored manifest');

// 6. The client stops here (no heartbeat, hold, submit or complete). Until the lease expires every other Task is turned away and nothing is committed.
for(const t of ['task30','task45']){const r=await batch(w,t);assert.equal(r.data.status,'already_running');assert.equal(r.data.runId,claim.runId);}
assert.equal(Object.keys(runDoc(w,claim.runId).results||{}).length,0,'the abandoned run committed nothing');
assert.equal(leaseDoc(w).runId,claim.runId);

// 7. Lease expiry: the next Task gets a NEW run and epoch, and is offered the same unsaved films again (no loss, no duplicate); a late call of the abandoned run cannot write.
setLease(w,{...leaseDoc(w),expiresAt:Date.now()-1});
const next=await batch(w,'task45');
assert.equal(next.status,200,JSON.stringify(next.data).slice(0,300));assert.equal(next.data.status,'running');assert.notEqual(next.data.runId,claim.runId);assert.equal(next.data.lease.epoch,claim.epoch+1);
assert.deepEqual(next.data.films.map(f=>f.filmId).sort(),done.data.films.map(f=>f.filmId).sort(),'the abandoned selection is offered again');
const late=await w.api('batch/submit',{taskId:'task00',runId:claim.runId,epoch:claim.epoch,items:[item(w,done.data.films[0].filmId)]});
assert.notEqual(late.status,200,'a late submit of the abandoned run commits nothing: '+JSON.stringify(late.data).slice(0,200));
const sub=await w.api('batch/submit',{taskId:'task45',runId:next.data.runId,epoch:next.data.lease.epoch,items:[item(w,next.data.films[0].filmId)]});
assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));assert.deepEqual(sub.data.results.map(x=>[x.filmId,x.status]),[[next.data.films[0].filmId,'created']],'the new run commits the film exactly once');
console.log('AIR-588 abandoned synchronous start replay: ok');
