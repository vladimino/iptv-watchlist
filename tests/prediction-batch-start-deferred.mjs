// ADR 0191 (AIR-573): deferred start. A server-issued key (`prediction_batch_key`), a fast receipt from `prediction_batch_start({deferred:true})`, the heavy preparation in a Workflow instance, and
// readback through `prediction_batch_manifest`. Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2; the Workflow binding is a stand-in that only records the created instance,
// so a test runs (or never runs) the preparation itself and the receipt is shown to be independent of it. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const leaseDoc=w=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const runs=w=>sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n;
const manifestKey=id=>'enrichment/batch-manifest/'+id+'.json';
const outcomeKey=id=>'enrichment/batch-start/'+id+'.json';
const stepStub={do:async(name,config,fn)=>{assert.equal(name,'prepare');assert.equal(config.retries.limit,0,'no retry of a preparation');return fn();}};

const world=async(n=6,{workflow=true}={})=>{
 const w=await flowWorld({films:n});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 w.instances=[];
 if(workflow)w.env.PREDICTION_START_WORKFLOW={create:async({id,params})=>{w.instances.push({id,params});return {id};}};
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.key=async()=>{const res=await w.tool('prediction_batch_key',{});assert.equal(res.isError,undefined,JSON.stringify(res).slice(0,200));return JSON.parse(res.content[0].text).invocationKey;};
 w.start=(key,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5,deferred:true,invocationKey:key,...body});
 w.prepare=async(instance)=>w.ctx.runPredictionStartWorkflow(w.env,instance.params,stepStub);
 return w;
};

// 1. Bootstrap: a fresh server-issued key, nothing stored, nothing leased; a repeat only returns another unused key.
{
 const w=await world();
 const before=dump(w.file),keys=[...w.records.keys()].sort().join('|');
 const a=await w.key(),b=await w.key();
 assert.match(a,/^dk1\.[0-9a-f]{32}$/);assert.notEqual(a,b,'every call issues a different key');
 assert.equal(dump(w.file),before,'bootstrap writes no D1 row (no lease, no run)');assert.equal([...w.records.keys()].sort().join('|'),keys,'bootstrap writes no record');
 const bad=await w.tool('prediction_batch_key',{x:1});assert.equal(bad.isError,true);
 const issued=await w.tool('prediction_batch_key',{});assert.equal(JSON.parse(issued.content[0].text).sideEffects,'none');assert.equal(issued.structuredContent.status,'issued');
}

// 2. The deferred start answers a compact receipt without running the preparation; the preparation is only an instance of the Workflow.
{
 const w=await world();const key=await w.key();
 const queries=w.stats.queries+w.stats.batches;
 const r=await w.start(key);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'accepted');assert.equal(r.data.phase,'preparing');assert.equal(r.data.deferred,true);
 assert.match(r.data.runId,/^[0-9a-f-]{36}$/);assert.equal(r.data.epoch,1);assert.equal(r.data.read.tool,'prediction_batch_manifest');assert.ok(r.data.retryAfterMs>=1000);assert.equal(r.data.films,undefined,'no manifest in the receipt');
 assert.ok(JSON.stringify(r.data).length<1500,'a compact receipt');
 assert.ok(w.stats.queries+w.stats.batches-queries<60,'the receipt costs a claim, not a preparation: '+(w.stats.queries+w.stats.batches-queries)+' D1 round trips');
 assert.equal(w.instances.length,1);assert.equal(w.instances[0].id,r.data.runId);assert.equal(w.instances[0].params.epoch,1);assert.equal(w.instances[0].params.body.invocationKey,undefined,'the key is not in the instance payload');
 assert.ok(!JSON.stringify(w.instances[0].params).includes(key),'the raw key is not in the instance payload');
 const lease=leaseDoc(w);assert.equal(lease.phase,'claim');assert.equal(lease.runId,r.data.runId);assert.match(lease.keyHash,/^[0-9a-f]{64}$/);assert.ok(lease.expiresAt<Date.now()+181000,'a claim, not a 15 minute lease');
 assert.equal(runs(w),0,'nothing was prepared');assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/sources/')),'no source, no manifest');
 assert.ok(!dump(w.file).includes(key)&&!JSON.stringify([...w.records.entries()]).includes(key),'the key is stored nowhere');
 // readback before the preparation is a typed pending answer
 const pending=await w.tool('prediction_batch_manifest',{runId:r.data.runId});assert.equal(pending.isError,true);assert.match(JSON.stringify(pending),/manifest_pending/);
}

// 3. A repeat with the same key and arguments (a lost receipt, a transport retry) returns the same receipt; anything else is refused; no second instance, no new epoch.
{
 const w=await world();const key=await w.key();
 const first=await w.start(key);
 const again=await w.start(key);
 assert.equal(again.status,200);assert.equal(again.data.runId,first.data.runId);assert.equal(again.data.epoch,first.data.epoch);assert.equal(again.data.phase,'preparing');assert.equal(w.instances.length,1,'no second preparation');
 assert.equal(leaseDoc(w).epoch,1);
 const other=await w.start(await w.key());assert.equal(other.data.status,'already_running');assert.equal(other.data.runId,first.data.runId);
 const mismatch=await w.start(key,{manifestSize:3});assert.equal(mismatch.data.status,'already_running');assert.equal(mismatch.data.reason,'key_args_mismatch');
 const keyless=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(keyless.data.status,'already_running');
 assert.equal(w.instances.length,1);assert.equal(leaseDoc(w).runId,first.data.runId,'nobody adopted the run');
}

// 4. The preparation: manifest stored, outcome ready, a SHORT lease until the first heartbeat, then the full TTL. Readback through the existing manifest parts; the same keyed start returns phase ready.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);const outcome=await w.prepare(w.instances[0]);
 assert.equal(outcome.phase,'ready',JSON.stringify(outcome));assert.equal(w.records.get(outcomeKey(r.data.runId)).phase,'ready');
 const lease=leaseDoc(w);assert.equal(lease.phase,'run');assert.equal(lease.runId,r.data.runId);assert.equal(lease.epoch,r.data.epoch,'same epoch');assert.equal(lease.submitGate,undefined,'the persist gate is cleared');
 assert.ok(lease.expiresAt<=Date.now()+181000&&lease.expiresAt>Date.now()+60000,'a prepared run holds the short lease until its first heartbeat: '+(lease.expiresAt-Date.now()));
 const stored=w.records.get(manifestKey(r.data.runId));assert.ok(stored,'the manifest is stored');assert.equal(stored.runId,r.data.runId);assert.equal(stored.lease.epoch,r.data.epoch);assert.equal(stored.films.length,5);
 const envelope=await w.tool('prediction_batch_manifest',{runId:r.data.runId});assert.equal(envelope.isError,undefined,JSON.stringify(envelope).slice(0,300));assert.equal(JSON.parse(envelope.content[0].text).kind,'envelope');
 const replay=await w.start(key);assert.equal(replay.data.status,'accepted');assert.equal(replay.data.phase,'ready');assert.equal(replay.data.runId,r.data.runId);assert.equal(w.instances.length,1);
 const run=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+r.data.runId+"'")[0].d);assert.equal(run.status,'running');assert.equal(run.keyHash,lease.keyHash);
 // the first heartbeat renews to the full TTL and keeps the correlation fields
 const beat=await w.api('heartbeat',{runId:r.data.runId});assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,200));
 const renewed=leaseDoc(w);assert.ok(renewed.expiresAt>Date.now()+14*60000,'the heartbeat extends to the full 15 minutes');assert.equal(renewed.keyHash,lease.keyHash);assert.equal(renewed.phase,'run');
 // a repeat of the preparation (a replayed instance) finds no claim and writes nothing
 const before=dump(w.file);const second=await w.prepare(w.instances[0]);assert.equal(second.phase,'failed');assert.equal(second.code,'start_claim_lost');assert.equal(dump(w.file),before,'a replayed instance changes no run or lease');assert.equal(w.records.get(outcomeKey(r.data.runId)).phase,'ready','and never overwrites the terminal outcome');
}

// 5. A caller that disappears after the receipt: the prepared run expires with its short lease (minutes, not 15) and the next start recovers it; nothing was reset by hand.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);await w.prepare(w.instances[0]);
 setLease(w,{...leaseDoc(w),expiresAt:Date.now()-1});
 const next=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5});
 assert.equal(next.data.status,'running',JSON.stringify(next.data).slice(0,200));assert.equal(next.data.lease.epoch,2);assert.notEqual(next.data.runId,r.data.runId);
 const old=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+r.data.runId+"'")[0].d);assert.equal(old.recoveredByRunId,next.data.runId,'the abandoned run was interrupted and attributed');
}

// 6. A refused preparation (no capacity) leaves a typed final outcome and releases the claim; the readback says so, it never stays pending.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key,{capacity:{remainingPercent:0}});assert.equal(r.data.status,'accepted');
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'refused',JSON.stringify(outcome));
 assert.equal(leaseDoc(w).expiresAt,0,'the claim was released');assert.equal(runs(w),0);
 const read=await w.tool('prediction_batch_manifest',{runId:r.data.runId});assert.equal(read.isError,true);assert.match(JSON.stringify(read),/start_refused/);assert.doesNotMatch(JSON.stringify(read),/manifest_pending|unknown_run/);
}

// 7. A stale preparation (its claim was taken over) writes nothing and leaves the new holder untouched.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);
 const foreign={owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:7,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)};
 setLease(w,foreign);
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'failed');assert.equal(outcome.code,'start_claim_lost');
 assert.deepEqual(leaseDoc(w),foreign);assert.equal(runs(w),0);assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/sources/')||k==='enrichment/latest-run.json'),'a stale preparation publishes nothing');
 const read=await w.tool('prediction_batch_manifest',{runId:r.data.runId});assert.match(JSON.stringify(read),/start_failed/);
}

// 8. Four competing Tasks: one is accepted, the others lose the slot (never adopt); after the first run completes the lease is free again.
{
 const w=await world();
 const keys=[await w.key(),await w.key(),await w.key(),await w.key()];
 const answers=[];for(const key of keys)answers.push(await w.start(key));
 assert.equal(answers[0].data.status,'accepted');for(const a of answers.slice(1)){assert.equal(a.data.status,'already_running');assert.equal(a.data.runId,answers[0].data.runId);}
 assert.equal(w.instances.length,1,'one preparation for four Tasks');
 await w.prepare(w.instances[0]);
 const done=await w.api('complete',{runId:answers[0].data.runId,reason:'external_termination'});assert.ok(done.status<500,JSON.stringify(done.data).slice(0,200));
 const next=await w.start(await w.key());assert.equal(next.data.status,'accepted');assert.equal(next.data.epoch,2);
}

// 9. The Workflow binding is missing or refuses: nothing is accepted, nothing is left leased.
{
 for(const mode of ['missing','throws']){
  const w=await world(6,{workflow:mode==='throws'});if(mode==='throws')w.env.PREDICTION_START_WORKFLOW={create:async()=>{throw new Error('workflow unavailable');}};
  const r=await w.start(await w.key());assert.equal(r.status,503,mode+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'deferred_start_unavailable');
  assert.equal(leaseDoc(w).expiresAt,0,mode+': the claim was released');assert.equal(runs(w),0);
 }
}

// 10. Argument rules: a deferred start needs the issued key shape, is never a dry run or a pin; the synchronous keyed start and keyless start are unchanged.
{
 const w=await world();const before=dump(w.file);
 for(const [body,code] of [[{invocationKey:'task-s5-q15:2026-11-21T13'},'invalid_deferred_key'],[{invocationKey:'dk1.'+'0'.repeat(31)},'invalid_deferred_key'],[{dryRun:true,invocationKey:await w.key()},'deferred_not_dry_run']]){
  const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',deferred:true,...body});assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(r.data.code,code);
 }
 assert.equal(dump(w.file),before);assert.equal(w.instances.length,0);
 const sync=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5,invocationKey:'task-s5-q15:2026-11-21T13'});assert.equal(sync.data.status,'running','the synchronous keyed start still works');
 const bad=await w.tool('prediction_batch_start',{trigger:'scheduled',deferred:true,invocationKey:'short'});assert.equal(bad.isError,true);assert.match(JSON.stringify(bad),/prediction_batch_key/);
}
console.log('prediction-batch-start-deferred: ok');
