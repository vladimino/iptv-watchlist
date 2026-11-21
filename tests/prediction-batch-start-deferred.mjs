// ADR 0193 (AIR-573): deferred start. A server-issued key (`prediction_batch_key`), a fast receipt from `prediction_batch_start({deferred:true})`, the heavy preparation in a Workflow instance, and
// readback through `prediction_batch_manifest`. Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2; the Workflow binding is a stand-in that records the created instance (and can be
// told to hang, fail or lose its answer), so a test runs (or never runs) the preparation itself and the receipt is shown to be independent of it. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const leaseDoc=w=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const peek=w=>{try{return leaseDoc(w);}catch{return {};}};
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const runs=w=>sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n;
const manifestKey=id=>'enrichment/batch-manifest/'+id+'.json';
const outcomeKey=id=>'enrichment/batch-start/'+id+'.json';
const attemptKey=id=>'enrichment/batch-start/attempt/'+id+'.json';
const RUN=/^dk-[0-9a-f]{32}$/;
const foreignLease=(epoch=7)=>({owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)});
const stepStub={do:async(name,config,fn)=>{assert.equal(name,'prepare');assert.equal(config.retries.limit,0,'no retry of a preparation');return fn();}};

const world=async(n=6,{workflow=true}={})=>{
 const w=await flowWorld({films:n});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 w.instances=[];w.mode={create:'ok',get:'auto'};w.pending=null;
 if(workflow)w.env.PREDICTION_START_WORKFLOW={
  async create({id,params}){
   if(w.mode.create==='hang')return new Promise(()=>{});
   if(w.mode.create==='pending')await w.pending;
   if(w.mode.create==='throw-not-created')throw new Error('workflow unavailable');
   if(w.mode.create==='throw-created'){w.instances.push({id,params});throw new Error('response lost');}
   w.instances.push({id,params});return {id};
  },
  async get(id){if(w.mode.get==='unknown')throw new Error('rpc broke');if(w.instances.some(item=>item.id===id))return {id};throw new Error('instance.not_found');},
 };
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.key=async()=>{const res=await w.tool('prediction_batch_key',{});assert.equal(res.isError,undefined,JSON.stringify(res).slice(0,200));return JSON.parse(res.content[0].text).invocationKey;};
 w.start=(key,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5,deferred:true,invocationKey:key,...body});
 w.prepare=async(instance)=>w.ctx.runPredictionStartWorkflow(w.env,instance.params,stepStub);
 w.read=async(runId,args={})=>w.tool('prediction_batch_manifest',{runId,...args});
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

// 2. The deferred start answers a compact receipt without running the preparation; the preparation is only a Workflow instance whose id is the (key-derived) run id.
{
 const w=await world();const key=await w.key();
 const queries=w.stats.queries+w.stats.batches;
 const r=await w.start(key);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'accepted');assert.equal(r.data.phase,'preparing');assert.equal(r.data.deferred,true);assert.equal(r.data.next,'poll_manifest');
 assert.match(r.data.runId,RUN,'the run id is derived from the key hash');assert.equal(r.data.epoch,1);assert.equal(r.data.read.tool,'prediction_batch_manifest');assert.equal(r.data.retryAfterMs,5000);assert.equal(r.data.films,undefined,'no manifest in the receipt');
 assert.ok(JSON.stringify(r.data).length<1500,'a compact receipt');
 assert.ok(w.stats.queries+w.stats.batches-queries<60,'the receipt costs a claim, not a preparation: '+(w.stats.queries+w.stats.batches-queries)+' D1 round trips');
 assert.equal(w.instances.length,1);assert.equal(w.instances[0].id,r.data.runId);assert.equal(w.instances[0].params.body.invocationKey,undefined,'the key is not in the instance payload');assert.ok(!JSON.stringify(w.instances[0].params).includes(key));
 assert.ok(w.records.get(attemptKey(r.data.runId)),'the attempt marker exists once the instance is known to exist');assert.equal(w.records.get(attemptKey(r.data.runId)).argsHash.length,64);
 const lease=leaseDoc(w);assert.equal(lease.phase,'claim');assert.equal(lease.runId,r.data.runId);assert.equal(lease.deferred,true);assert.equal(lease.prep,true);assert.match(lease.keyHash,/^[0-9a-f]{64}$/);assert.ok(lease.expiresAt<Date.now()+181000,'a claim, not a 15 minute lease');
 assert.equal(runs(w),0,'nothing was prepared');assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/sources/')),'no source, no manifest');
 assert.ok(!dump(w.file).includes(key)&&!JSON.stringify([...w.records.entries()]).includes(key),'the key is stored nowhere');
 const pending=await w.read(r.data.runId);assert.equal(pending.isError,true);assert.match(JSON.stringify(pending),/manifest_pending/);
}

// 3. A repeat with the same key and arguments returns the same receipt; anything else is refused; no second instance, no new epoch.
{
 const w=await world();const key=await w.key();
 const first=await w.start(key);
 const again=await w.start(key);
 assert.equal(again.status,200);assert.equal(again.data.runId,first.data.runId);assert.equal(again.data.epoch,first.data.epoch);assert.equal(again.data.phase,'preparing');assert.equal(w.instances.length,1,'no second preparation');assert.equal(leaseDoc(w).epoch,1);
 const other=await w.start(await w.key());assert.equal(other.data.status,'already_running');assert.equal(other.data.runId,first.data.runId);
 const mismatch=await w.start(key,{manifestSize:3});assert.equal(mismatch.data.status,'already_running');assert.equal(mismatch.data.reason,'key_args_mismatch');
 const keyless=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(keyless.data.status,'already_running');
 assert.equal(w.instances.length,1);assert.equal(leaseDoc(w).runId,first.data.runId,'nobody adopted the run');
}

// 4. The preparation and the readiness boundary: one owner-fenced edit ends the preparation with the short lease; a replayed instance writes nothing and never overwrites the outcome.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);
 const outcome=await w.prepare(w.instances[0]);
 assert.equal(outcome.phase,'ready',JSON.stringify(outcome));assert.equal(w.records.get(outcomeKey(r.data.runId)).phase,'ready');
 const lease=leaseDoc(w);assert.equal(lease.phase,'run');assert.equal(lease.runId,r.data.runId);assert.equal(lease.epoch,r.data.epoch,'the instance adopted the live claim: same epoch');assert.equal(lease.submitGate,undefined,'the persist gate is cleared');assert.equal(lease.prep,undefined,'the preparation mark is cleared');
 assert.ok(lease.expiresAt<=Date.now()+181000&&lease.expiresAt>Date.now()+60000,'a prepared run holds the short lease until its first heartbeat: '+(lease.expiresAt-Date.now()));
 const stored=w.records.get(manifestKey(r.data.runId));assert.ok(stored);assert.equal(stored.runId,r.data.runId);assert.equal(stored.lease.epoch,r.data.epoch);assert.equal(stored.films.length,5);
 const envelope=await w.read(r.data.runId);assert.equal(envelope.isError,undefined,JSON.stringify(envelope).slice(0,300));assert.equal(JSON.parse(envelope.content[0].text).kind,'envelope');
 const replay=await w.start(key);assert.equal(replay.data.status,'accepted');assert.equal(replay.data.phase,'ready');assert.equal(replay.data.runId,r.data.runId);assert.equal(w.instances.length,1);
 const run=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+r.data.runId+"'")[0].d);assert.equal(run.status,'running');assert.equal(run.keyHash,lease.keyHash);
 const beat=await w.api('heartbeat',{runId:r.data.runId});assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,200));
 const renewed=leaseDoc(w);assert.ok(renewed.expiresAt>Date.now()+14*60000,'the heartbeat extends to the full 15 minutes');assert.equal(renewed.keyHash,lease.keyHash);assert.equal(renewed.phase,'run');assert.ok(renewed.clientAckAt);
 const before=dump(w.file);const second=await w.prepare(w.instances[0]);assert.equal(second.phase,'failed');assert.equal(second.code,'start_claim_lost');assert.equal(dump(w.file),before,'a replayed instance changes no run or lease');assert.equal(w.records.get(outcomeKey(r.data.runId)).phase,'ready','and never overwrites the terminal outcome');
}

// 5. While the preparation mark is set the manifest answers pending even when the stored answer exists (the readiness edit is the exposure boundary).
{
 const w=await world();const key=await w.key();const r=await w.start(key);
 let seen=null;const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 w.env.BUCKET.put=async(k,...a)=>{const res=await put(k,...a);if(String(k)===manifestKey(r.data.runId)&&seen===null){const read=await w.read(r.data.runId);seen=JSON.stringify(read);}return res;};
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'ready');
 assert.match(seen,/manifest_pending/,'right after the manifest was stored and before the readiness edit it is still pending: '+seen);
 const after=await w.read(r.data.runId);assert.equal(after.isError,undefined,'served after the readiness edit');
}

// 6. A caller that disappears after the receipt: the short lease expires and the next start recovers the run; nothing was reset by hand.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);await w.prepare(w.instances[0]);
 setLease(w,{...leaseDoc(w),expiresAt:Date.now()-1});
 const next=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5});
 assert.equal(next.data.status,'running',JSON.stringify(next.data).slice(0,200));assert.equal(next.data.lease.epoch,2);assert.notEqual(next.data.runId,r.data.runId);
 const old=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+r.data.runId+"'")[0].d);assert.equal(old.recoveredByRunId,next.data.runId,'the abandoned run was interrupted and attributed');
 const retry=await w.start(key);assert.equal(retry.status,409);assert.equal(retry.data.code,'start_finished');assert.equal(w.instances.length,1,'a retry of the same key is a typed terminal answer, never a new run');
}

// 7. LOST RECEIPT, preparation ends before the retry: refused, failed or finished, the same key gets the original attempt's typed result and never a second preparation, even when another run owns the lease.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key,{capacity:{remainingPercent:0}});assert.equal(r.data.status,'accepted');
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'refused',JSON.stringify(outcome));
 assert.equal(leaseDoc(w).expiresAt,0,'the claim was released');assert.equal(runs(w),0);
 for(const [label,arrange] of [['lease free',()=>{}],['foreign owner',()=>setLease(w,foreignLease())]]){
  arrange();
  const retry=await w.start(key,{capacity:{remainingPercent:0}});
  assert.equal(retry.status,409,label+JSON.stringify(retry.data).slice(0,200));assert.equal(retry.data.code,'start_refused',label);assert.equal(retry.data.runId,r.data.runId);assert.ok(retry.data.outcomeCode,label);
  assert.equal(w.instances.length,1,label+': no second preparation');
 }
 const read=await w.read(r.data.runId);assert.equal(read.isError,true);assert.match(JSON.stringify(read),/start_refused/);assert.doesNotMatch(JSON.stringify(read),/manifest_pending|unknown_run/);
}
{
 const w=await world();const key=await w.key();const r=await w.start(key);
 const foreign=foreignLease();setLease(w,foreign);
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'failed');assert.equal(outcome.code,'start_claim_lost');
 assert.deepEqual(leaseDoc(w),foreign);assert.equal(runs(w),0);assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/sources/')||k==='enrichment/latest-run.json'),'a stale preparation publishes nothing');
 const read=await w.read(r.data.runId);assert.match(JSON.stringify(read),/start_failed/);
 const retry=await w.start(key);assert.equal(retry.status,409);assert.equal(retry.data.code,'start_failed');assert.equal(retry.data.outcomeCode,'start_claim_lost');assert.equal(w.instances.length,1);assert.deepEqual(leaseDoc(w),foreign,'the foreign holder is untouched');
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

// 9. The Workflow binding: missing is a definite refusal with no claim; a `create` error is reconciled against the platform by the run id (not found releases the claim and the SAME key may start;
// an existing instance keeps the claim and is accepted; an unknown state keeps the claim and says so, bounded by the claim).
{
 const w=await world(6,{workflow:false});const r=await w.start(await w.key());assert.equal(r.status,503);assert.equal(r.data.code,'deferred_start_unavailable');assert.equal(peek(w).phase,undefined,'no claim was taken');assert.equal(runs(w),0);
}
{
 const w=await world();const key=await w.key();
 w.mode.create='throw-not-created';
 const r=await w.start(key);assert.equal(r.status,503,JSON.stringify(r.data));assert.equal(r.data.code,'deferred_start_unavailable');assert.equal(leaseDoc(w).expiresAt,0,'definitely not created: the claim was released');
 assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-start/')),'no attempt marker and no outcome: the invocation may start again');
 w.mode.create='ok';const retry=await w.start(key);assert.equal(retry.data.status,'accepted','the same key may start once the platform accepts');assert.equal(w.instances.length,1);
}
{
 const w=await world();const key=await w.key();
 w.mode.create='throw-created';
 const r=await w.start(key);assert.equal(r.status,200,'the instance exists although create threw: accepted '+JSON.stringify(r.data));assert.equal(r.data.phase,'preparing');assert.equal(w.instances.length,1);
 assert.equal(leaseDoc(w).phase,'claim','an ambiguous create never releases an active preparation');
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'ready',JSON.stringify(outcome));
}
{
 const w=await world();const key=await w.key();
 w.mode.create='throw-not-created';w.mode.get='unknown';
 const r=await w.start(key);assert.equal(r.status,503);assert.equal(r.data.code,'deferred_start_ambiguous');assert.match(r.data.runId,RUN);
 assert.equal(leaseDoc(w).phase,'claim','an unknown state keeps the claim');assert.ok(w.records.get(attemptKey(r.data.runId)),'and records that an attempt was made');
 const again=await w.start(key);assert.equal(again.status,200);assert.equal(again.data.runId,r.data.runId);assert.equal(again.data.phase,'preparing');assert.equal(w.instances.length,0);
 setLease(w,{...leaseDoc(w),expiresAt:Date.now()-1});
 const ended=await w.start(key);assert.equal(ended.status,409);assert.equal(ended.data.code,'start_failed');assert.equal(ended.data.outcomeCode,'start_claim_lost');assert.equal(w.instances.length,0,'no second dispatch for the same invocation');
 const read=await w.read(r.data.runId);assert.match(JSON.stringify(read),/start_failed/);
}

// 10. Interleavings of the first request: a repeat while `create` is pending is `accepting` (repeat the start, do not poll); a request that dies between the claim and the dispatch leaves a claim that
// expires, and the same key then dispatches once; a takeover between the repeat's reads is refused.
{
 const w=await world();const key=await w.key();
 w.mode.create='pending';let release;w.pending=new Promise(resolve=>{release=resolve;});
 const firstRequest=w.start(key);
 await new Promise(resolve=>setTimeout(resolve,50));
 const second=await w.start(key);assert.equal(second.status,200,JSON.stringify(second.data).slice(0,200));assert.equal(second.data.phase,'accepting');assert.equal(second.data.next,'repeat_start');assert.equal(second.data.retryAfterMs,1000);
 release();const first=await firstRequest;assert.equal(first.data.phase,'preparing');
 const third=await w.start(key);assert.equal(third.data.phase,'preparing');assert.equal(third.data.next,'poll_manifest');assert.equal(w.instances.length,1);
}
{
 const w=await world();const key=await w.key();
 w.mode.create='hang';void w.start(key);
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(leaseDoc(w).phase,'claim');assert.equal(w.instances.length,0,'the first request never reached the platform');
 setLease(w,{...leaseDoc(w),expiresAt:Date.now()-1});w.mode.create='ok';
 const retry=await w.start(key);assert.equal(retry.status,200,JSON.stringify(retry.data).slice(0,200));assert.equal(retry.data.phase,'preparing');assert.equal(w.instances.length,1,'dispatched once');assert.equal(retry.data.epoch,2,'a new claim of the same attempt');
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'ready',JSON.stringify(outcome));assert.equal(leaseDoc(w).epoch,2);
}
{
 const w=await world();const key=await w.key();const r=await w.start(key);
 let done=false;const get=w.env.BUCKET.get.bind(w.env.BUCKET);
 w.env.BUCKET.get=async(k,...a)=>{if(!done&&String(k)===attemptKey(r.data.runId)){done=true;setLease(w,foreignLease());}return get(k,...a);};
 const raced=await w.start(key);assert.ok(done);assert.equal(raced.data.status,'already_running','a takeover between the reads is refused, not answered with a receipt');
}

// 11. The readiness boundary under failure: a crash after the run was saved and before the manifest; between the manifest and the readiness edit; the first heartbeat racing readiness; an outcome write that fails.
{
 const w=await world();const key=await w.key();const r=await w.start(key);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);w.env.BUCKET.put=async(k,...a)=>{if(String(k)===manifestKey(r.data.runId))throw new Error('r2 unavailable');return put(k,...a);};
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'failed');assert.equal(outcome.code,'storage_error');
 assert.equal(runs(w),1,'a partial run row exists');assert.equal(leaseDoc(w).expiresAt,0,'the lease was released, not left on a long TTL');
 const read=await w.read(r.data.runId);assert.equal(read.isError,true);assert.match(JSON.stringify(read),/start_failed/);assert.doesNotMatch(JSON.stringify(read),/manifest_pending|lease_lost|unknown_run/,'the typed outcome wins over the partial run row');
}
{
 const w=await world();const key=await w.key();const r=await w.start(key);
 let expiryAtFailure=null,fired=0;
 w.hooks.write=statements=>{
  if(!statements.some(item=>/UPDATE prediction_lease/i.test(item.text)))return;
  const doc=peek(w);if(fired||!doc.submitGate||!w.records.has(manifestKey(r.data.runId)))return;fired++;expiryAtFailure=doc.expiresAt;throw new Error('d1 unavailable');
 };
 const outcome=await w.prepare(w.instances[0]);w.hooks.write=null;
 assert.ok(fired,'the readiness edit was hit');assert.equal(outcome.phase,'failed');
 assert.ok(expiryAtFailure<=Date.now()+181000,'the lease stayed on the short TTL throughout the persist gate: '+(expiryAtFailure-Date.now()));
 assert.equal(leaseDoc(w).expiresAt,0,'released');
 const read=await w.read(r.data.runId);assert.equal(read.isError,true);assert.match(JSON.stringify(read),/start_failed/);
}
{
 // (c) the first client heartbeat versus the readiness edit. A real heartbeat during the persist is serialized by the prediction writer (answered busy, retried after readiness); and even an acknowledged
 // renewal that is already on the lease when the readiness edit runs is never shortened.
 const w=await world();const key=await w.key();const r=await w.start(key);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);let beat=null,acked=null;
 w.env.BUCKET.put=async(k,...a)=>{const res=await put(k,...a);if(String(k)===manifestKey(r.data.runId)&&beat===null){
  beat=await w.api('heartbeat',{runId:r.data.runId});
  const doc=peek(w);acked=Date.now()+15*60000;setLease(w,{...doc,clientAckAt:new Date().toISOString(),expiresAt:acked});
 }return res;};
 const outcome=await w.prepare(w.instances[0]);assert.equal(outcome.phase,'ready',JSON.stringify(outcome));
 assert.equal(beat.status,409,JSON.stringify(beat.data).slice(0,200));assert.equal(beat.data.reason,'prediction_writer_busy','a heartbeat during the persist is serialized by the writer, not lost');
 const lease=leaseDoc(w);assert.equal(lease.expiresAt,acked,'an acknowledged renewal was not shortened by readiness: '+(lease.expiresAt-Date.now()));assert.equal(lease.prep,undefined);assert.equal(lease.submitGate,undefined);
 const later=await w.api('heartbeat',{runId:r.data.runId});assert.equal(later.status,200,'the heartbeat succeeds right after readiness');
}
{
 const w=await world();const key=await w.key();const r=await w.start(key,{capacity:{remainingPercent:0}});
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);w.env.BUCKET.put=async(k,...a)=>{if(String(k)===outcomeKey(r.data.runId))throw new Error('r2 unavailable');return put(k,...a);};
 await w.prepare(w.instances[0]);
 assert.ok(!w.records.has(outcomeKey(r.data.runId)));
 const read=await w.read(r.data.runId);assert.equal(read.isError,true);assert.match(JSON.stringify(read),/start_failed/);assert.match(JSON.stringify(read),/start_lost/);assert.doesNotMatch(JSON.stringify(read),/unknown_run/,'no run, no live claim and no outcome is a typed loss');
}

// 12. The actual caller path of a Task, end to end: key -> receipt -> envelope -> heartbeat -> profile, contract, film -> a valid submit and its replay -> complete, with the persisted versions.
{
 const w=await world(3);const key=await w.key();
 const r=await w.start(key,{manifestSize:1});assert.equal(r.data.status,'accepted');
 await w.prepare(w.instances[0]);
 const envelope=JSON.parse((await w.read(r.data.runId)).content[0].text);assert.equal(envelope.kind,'envelope');
 const beat=await w.api('heartbeat',{runId:r.data.runId});assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,200));
 const profile=JSON.parse((await w.read(r.data.runId,{part:'profile'})).content[0].text);const contract=JSON.parse((await w.read(r.data.runId,{part:'contract'})).content[0].text);
 const filmParts=envelope.parts.filter(part=>part.kind==='film');assert.equal(filmParts.length,1);
 const film=JSON.parse((await w.read(r.data.runId,{part:'film',filmId:filmParts[0].filmId})).content[0].text);
 assert.ok(profile&&contract&&film);
 const item={filmId:filmParts[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction};
 const sub=await w.api('batch/submit',{runId:r.data.runId,epoch:r.data.epoch,items:[item]});assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 assert.equal(sub.data.results[0].status,'created',JSON.stringify(sub.data.results[0]));
 const replay=await w.api('batch/submit',{runId:r.data.runId,epoch:r.data.epoch,items:[item]});assert.equal(replay.status,200);assert.equal(replay.data.results[0].replayed,true,'an identical replay is idempotent');
 const done=await w.api('complete',{runId:r.data.runId,reason:'manifest_spent'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,300));
 const run=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+r.data.runId+"'")[0].d);
 assert.equal(run.status,'complete');assert.ok(run.tasteProfileVersion!==undefined&&run.fingerprintSchemaVersion!==undefined&&run.predictionPromptVersion!==undefined,'the persisted run carries the profile, schema and prompt versions');assert.equal(run.keyHash.length,64);
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_pointer')[0].n,1,'one prediction is current (the persisted pointer)');
 assert.equal(leaseDoc(w).expiresAt,0,'the lease is released at completion');
 const retry=await w.start(key,{manifestSize:1});assert.equal(retry.status,409);assert.equal(retry.data.code,'start_finished');assert.equal(w.instances.length,1,'the finished invocation is never started again');
}

// 13. A preparation refused with `prediction_catalog_held` still leaves the neutral AIR-575 skipped Event (the Workflow does not pass the route exit that records it), once, and no run.
{
 const w=await world();const key=await w.key();
 const r=await w.start(key);assert.equal(r.data.status,'accepted');
 const Authority=w.ctx.DiscoveryAuthority;w.ctx.DiscoveryAuthority={...Authority,readAuthority:async()=>({held:false,ready:true,transfer:'loading'})};
 let outcome;try{outcome=await w.prepare(w.instances[0]);}finally{w.ctx.DiscoveryAuthority=Authority;}
 assert.equal(outcome.phase,'refused',JSON.stringify(outcome));assert.equal(outcome.code,'prediction_catalog_held');
 const held=[...w.records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v).filter(e=>e.presentation==='batch_v2_skipped'&&e.reason==='catalog_held');
 assert.equal(held.length,1,'one neutral skipped Event');assert.equal(held[0].cause,'discovery_incomplete');assert.ok(!JSON.stringify(held[0]).includes(key),'the key never reaches the Event');
 assert.equal(runs(w),0);assert.equal(leaseDoc(w).expiresAt,0,'the claim was released');
 const read=await w.read(r.data.runId);assert.match(JSON.stringify(read),/start_refused/);
}

// 14. Argument rules: a deferred start needs the issued key shape, is never a dry run or a pin; the synchronous keyed start and a keyless start are unchanged.
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
