// ADR 0195 (AIR-573): the standing Task label `taskId` (task00, task15, task30, task45) as the logical owner of a prediction run, beside runId and epoch. Offline: the real Worker over a sqlite D1
// stand-in and an in-memory R2, as production runs the prediction domain. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {nonFunctional} from './suite-gate.mjs';

const batch=(w,taskId,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...(taskId?{taskId}:{}),...body});
const leaseDoc=w=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const runRows=w=>sql(w.file,'SELECT * FROM prediction_run');
const world=async(n=6)=>{const w=await flowWorld({films:n});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));return w;};
const manifestKey=id=>'enrichment/batch-manifest/'+id+'.json';
const item=(w,id)=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});
const same=d=>{const {requestId,delivery,...rest}=d;void requestId;void delivery;return rest;};
const snapshot=w=>JSON.stringify([runRows(w),sql(w.file,'SELECT * FROM prediction_lease'),[...w.records.keys()].sort()]);
const submit=(w,taskId,run,items,extra={})=>w.api('batch/submit',{...(taskId?{taskId}:{}),runId:run.runId,epoch:run.lease.epoch,items,...extra});

// 1. A Task start is an ordinary run: the label is stored on the lease and the run next to the existing fencing fields; a heartbeat keeps it.
{
 const w=await world();
 const r=await batch(w,'task00');
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'running');assert.equal(r.data.lease.epoch,1);
 const lease=leaseDoc(w);assert.equal(lease.taskId,'task00');assert.equal(lease.runId,r.data.runId);assert.equal(lease.phase,'run');
 assert.equal(JSON.parse(runRows(w)[0].document_json).taskId,'task00','the run carries the label');
 const beat=await w.api('heartbeat',{taskId:'task00',runId:r.data.runId});assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,200));
 assert.equal(leaseDoc(w).taskId,'task00','the label survives a heartbeat');assert.equal(leaseDoc(w).epoch,1);
}

// 2. (a)(b)(c) The same Task repeats its start: the SAME stored manifest while the lease lives, before and after the first client submit; nothing is written; a repeated submit commits once.
{
 const w=await world();
 const first=await batch(w,'task00');assert.equal(first.data.status,'running');
 const before=snapshot(w);
 const again=await batch(w,'task00');
 assert.equal(again.status,200,JSON.stringify(again.data).slice(0,200));assert.deepEqual(same(again.data),same(first.data),'the same full manifest: run id, epoch, hash, films, profile and contract');
 assert.equal(snapshot(w),before,'a repeat writes no run, no lease and no record');
 const id=first.data.films[0].filmId;
 const sub=await submit(w,'task00',first.data,[item(w,id)]);assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,200));
 const afterSubmit=await batch(w,'task00');
 assert.equal(afterSubmit.status,200,JSON.stringify(afterSubmit.data).slice(0,200));assert.equal(afterSubmit.data.runId,first.data.runId,'the repeat after the first submit still returns the own run');assert.equal(afterSubmit.data.manifestHash??afterSubmit.data.hash,first.data.manifestHash??first.data.hash);
 assert.deepEqual(afterSubmit.data.films.map(f=>f.filmId),first.data.films.map(f=>f.filmId));
 const filmsBefore=sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n;
 const replay=await submit(w,'task00',first.data,[item(w,id)]);
 assert.equal(replay.status,200,JSON.stringify(replay.data).slice(0,200));
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n,filmsBefore,'a repeated submit creates no new run');
 assert.equal(leaseDoc(w).runId,first.data.runId);assert.equal(leaseDoc(w).epoch,1,'no epoch change from the repeats');
 const doc=JSON.parse(runRows(w)[0].document_json);assert.equal(Object.keys(doc.results||{}).length,1,'the film is recorded exactly once');
}

// 3. (a) A repeat while the first start still prepares the manifest (claim phase, answer not stored): `start_pending` with the real run id and epoch, never `already_running`; the readback is pending.
{
 const w=await world();
 const first=await batch(w,'task15');const stored=w.records.get(manifestKey(first.data.runId));assert.ok(stored);
 w.records.delete(manifestKey(first.data.runId));setLease(w,{...leaseDoc(w),phase:'claim',expiresAt:Date.now()+180000});
 const t=Date.now();const pending=await batch(w,'task15');const waited=Date.now()-t;
 assert.equal(pending.status,200,JSON.stringify(pending.data).slice(0,200));assert.equal(pending.data.status,'start_pending');assert.equal(pending.data.runId,first.data.runId);assert.equal(pending.data.epoch,first.data.lease.epoch);
 assert.equal(pending.data.taskId,'task15');assert.equal(pending.data.read.tool,'prediction_batch_manifest');assert.ok(pending.data.retryAfterMs>0);
 assert.notEqual(pending.data.status,'already_running');
 nonFunctional('prediction-task-id-join-bound',()=>{assert.ok(waited>=9000&&waited<13000,'bounded by JOIN_WAIT_MS: '+waited);});
 w.records.set(manifestKey(first.data.runId),stored);
 const recovered=await batch(w,'task15');assert.equal(recovered.data.status,'running');assert.equal(recovered.data.runId,first.data.runId,'the lost first answer is recovered by the repeat');
}

// 4. (d) A foreign Task: start refused as already_running, nothing assigned; every run-scoped call is wrong_owner with no write and no payload.
{
 const w=await world();
 const first=await batch(w,'task00');const id=first.data.films[0].filmId;
 const foreign=await batch(w,'task15');assert.equal(foreign.data.status,'already_running');assert.equal(foreign.data.runId,first.data.runId);
 const legacy=await batch(w,null);assert.equal(legacy.data.status,'already_running','a start without a label is turned away too');
 assert.equal(leaseDoc(w).taskId,'task00','a refused start assigns nothing');
 // (the refused starts leave only the existing neutral skipped Events; the run-scoped calls below write nothing at all)
 const before=snapshot(w);
 for(const [name,call] of [
  ['heartbeat',()=>w.api('heartbeat',{taskId:'task15',runId:first.data.runId})],
  ['hold',()=>w.api('batch/hold',{taskId:'task15',runId:first.data.runId,epoch:first.data.lease.epoch,items:[item(w,id)]})],
  ['submit',()=>submit(w,'task15',first.data,[item(w,id)])],
  ['submit useHeld',()=>w.api('batch/submit',{taskId:'task15',runId:first.data.runId,epoch:first.data.lease.epoch,useHeld:true})],
  ['complete',()=>w.api('complete',{taskId:'task15',runId:first.data.runId})],
  ['heartbeat without label',()=>w.rawApi('heartbeat',{runId:first.data.runId})],
  ['submit without label',()=>w.rawApi('batch/submit',{runId:first.data.runId,epoch:first.data.lease.epoch,items:[item(w,id)]})],
  ['complete without label',()=>w.rawApi('complete',{runId:first.data.runId})],
 ]){
  const r=await call();assert.equal(r.status,409,name+' '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'wrong_owner',name+' '+JSON.stringify(r.data).slice(0,300));
  assert.ok(!JSON.stringify(r.data).includes('films'),name+' discloses no payload');
 }
 assert.equal(snapshot(w),before,'foreign calls wrote nothing: no run, lease or record changed');
 assert.equal(leaseDoc(w).taskId,'task00');
 const read=await w.manifest?.(first.data.runId,'task15');if(read)assert.equal(read.status,409);
}

// 5. (e) Expiry, a new epoch and a late handler: after the lease expires the same Task gets a NEW run (not the old one); the old run's calls are lease_lost / epoch errors and cannot write.
{
 const w=await world();
 const first=await batch(w,'task00');const id=first.data.films[0].filmId;
 setLease(w,{...leaseDoc(w),expiresAt:1});
 const next=await batch(w,'task00');
 assert.equal(next.status,200,JSON.stringify(next.data).slice(0,200));assert.equal(next.data.status,'running');assert.notEqual(next.data.runId,first.data.runId,'an expired lease starts a new run');assert.equal(next.data.lease.epoch,2);
 const late=await submit(w,'task00',first.data,[item(w,id)]);
 assert.notEqual(late.status,200,'a late handler of the expired run commits nothing');assert.ok(['lease_lost','epoch_mismatch','wrong_owner'].includes(late.data.code||late.data.status)||late.data.error,JSON.stringify(late.data).slice(0,200));
 assert.equal(leaseDoc(w).runId,next.data.runId);assert.equal(leaseDoc(w).epoch,2);
 // task15 cannot adopt task00's new run, and a released lease frees the label for a new hour
 const foreign=await submit(w,'task15',next.data,[item(w,id)]);assert.equal(foreign.data.code,'wrong_owner');
 setLease(w,{...leaseDoc(w),expiresAt:0});
 const hour=await batch(w,'task00');assert.equal(hour.data.status,'running');assert.equal(hour.data.lease.epoch,3);assert.notEqual(hour.data.runId,next.data.runId);
}

// 6. (e) Two concurrent starts with the same label: one run; the other is that run's join, never a second run. Different labels: one run, the others already_running.
{
 const w=await world();
 const [a,b]=await Promise.all([batch(w,'task00'),batch(w,'task00')]);
 const ok=[a,b].filter(x=>x.data.status==='running'),pend=[a,b].filter(x=>x.data.status==='start_pending');
 assert.ok(ok.length>=1&&ok.length+pend.length===2,JSON.stringify([a.data.status,b.data.status]));
 assert.equal(runRows(w).length,1,'one run for two concurrent starts of one label');
 for(const r of [a,b])assert.equal(r.data.runId,ok[0].data.runId,'both answers name the one run');
}
{
 const w=await world();
 const all=await Promise.all(['task00','task15','task30','task45'].map(t=>batch(w,t)));
 assert.equal(all.filter(x=>x.data.status==='running').length,1);assert.equal(all.filter(x=>x.data.status==='already_running').length,3);assert.equal(runRows(w).length,1);
}

// 7. (f) Wrong, missing and incompatible labels or arguments.
{
 const w=await world();const before=snapshot(w);
 for(const bad of ['task99','TASK00','',' task00','task00 ',null,0,{},['task00']]){
  const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',taskId:bad});assert.equal(r.status,400,JSON.stringify(bad));
 }
 assert.equal((await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',taskId:'task00'})).data.code,'task_id_requires_scheduled');
 assert.equal((await w.api('heartbeat',{taskId:'task99',runId:'x'})).status,400,'an unknown label is refused before anything else');
 assert.equal(snapshot(w),before,'refusals write nothing');
 const first=await batch(w,'task30');assert.equal(first.data.status,'running');
 const bad=await w.api('heartbeat',{taskId:'task99',runId:first.data.runId});assert.equal(bad.status,400);assert.equal(bad.data.code,'invalid_task_id');
 const mismatch=await batch(w,'task30',{manifestSize:3});assert.equal(mismatch.status,409);assert.equal(mismatch.data.code,'task_args_mismatch');assert.notEqual(mismatch.data.status,'already_running');assert.equal(mismatch.data.runId,first.data.runId);
 assert.equal(leaseDoc(w).runId,first.data.runId,'nobody adopted anything');
}

// 8. (g) dryRun, manual, keyless and keyed starts are unchanged; a dry run with a label writes nothing and never claims.
{
 const w=await world();
 const dry=await batch(w,'task00',{dryRun:true});assert.equal(dry.status,200,JSON.stringify(dry.data).slice(0,200));assert.equal(dry.data.dryRun,true);assert.equal(runRows(w).length,0);
 assert.equal(sql(w.file,"SELECT count(*) AS n FROM prediction_lease WHERE name='runner'")[0].n,0,'a dry run never claims the lease');
 const manual=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual'});assert.equal(manual.data.status,'running');assert.equal(leaseDoc(w).taskId,undefined,'a manual run has no label');
 const beat=await w.rawApi('heartbeat',{runId:manual.data.runId});assert.equal(beat.status,200,'a run without a label is operated by a caller without one');
 // A Task can neither operate nor read a label-free run, whatever run id and epoch it knows: refused, and nothing is written.
 const id=manual.data.films[0].filmId,before=snapshot(w),vmRead=null;void vmRead;
 for(const [name,call] of [
  ['heartbeat',()=>w.rawApi('heartbeat',{taskId:'task00',runId:manual.data.runId})],
  ['hold',()=>w.rawApi('batch/hold',{taskId:'task00',runId:manual.data.runId,epoch:manual.data.lease.epoch,items:[item(w,id)]})],
  ['submit',()=>w.rawApi('batch/submit',{taskId:'task15',runId:manual.data.runId,epoch:manual.data.lease.epoch,items:[item(w,id)]})],
  ['submit useHeld',()=>w.rawApi('batch/submit',{taskId:'task15',runId:manual.data.runId,epoch:manual.data.lease.epoch,useHeld:true})],
  ['complete',()=>w.rawApi('complete',{taskId:'task45',runId:manual.data.runId})],
 ]){const r=await call();assert.equal(r.status,409,name);assert.equal(r.data.code,'wrong_owner',name+' '+JSON.stringify(r.data).slice(0,200));}
 assert.equal(snapshot(w),before,'label-vs-unlabelled refusals wrote nothing');
 assert.equal((await batch(w,'task00')).data.status,'already_running','a labelled start never joins an unlabelled run');
}
{
 const w=await world();
 const keyed=await batch(w,null,{invocationKey:'task-s5-q15:2026-11-21T13'});assert.equal(keyed.data.status,'running');assert.equal(leaseDoc(w).taskId,undefined);
 const same=await batch(w,null,{invocationKey:'task-s5-q15:2026-11-21T13'});assert.equal(same.data.runId,keyed.data.runId,'the keyed join of ADR 0188 is unchanged');
 assert.equal((await batch(w,'task00')).data.status,'already_running');
}

// 9. (h) The readback through the MCP tool: a start that is still preparing is `manifest_pending` for its own Task (a successful tool result of kind pending) and `wrong_owner` for another; a ready run is read
// by its own Task only, with the same hash as the start; a truncated first answer is recovered from the stored manifest by the repeat, never by a second run.
{
 const w=await world();
 const first=await batch(w,'task45');const stored=w.records.get(manifestKey(first.data.runId));assert.ok(stored);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 const ready=await tool('prediction_batch_manifest',{taskId:'task45',runId:first.data.runId});
 assert.equal(ready.isError,undefined,JSON.stringify(ready).slice(0,300));assert.equal(JSON.parse(ready.content[0].text).manifestHash,first.data.manifestHash,'the readback is the same manifest');
 const foreignRead=await tool('prediction_batch_manifest',{taskId:'task15',runId:first.data.runId});
 assert.equal(foreignRead.isError,true);assert.match(JSON.stringify(foreignRead),/wrong_owner/);assert.ok(!JSON.stringify(foreignRead).includes(first.data.manifestHash),'no payload of the run is disclosed');
 // the first start is still preparing: claim phase, no run row yet in the readback's view, answer not stored
 w.records.delete(manifestKey(first.data.runId));setLease(w,{...leaseDoc(w),phase:'claim',expiresAt:Date.now()+180000});
 sql(w.file,"DELETE FROM prediction_run");
 const pending=await tool('prediction_batch_manifest',{taskId:'task45',runId:first.data.runId});
 assert.equal(pending.isError,undefined,JSON.stringify(pending).slice(0,300));assert.match(JSON.stringify(pending),/manifest_pending/);assert.match(JSON.stringify(pending),/kind.{1,8}pending/);
 const foreignPending=await tool('prediction_batch_manifest',{taskId:'task00',runId:first.data.runId});
 assert.equal(foreignPending.isError,true);assert.match(JSON.stringify(foreignPending),/wrong_owner/);
 // the MCP start of another Task is turned away while the claim lives, and the claim keeps its owner
 const turned=await tool('prediction_batch_start',{trigger:'scheduled',taskId:'task00'});assert.match(JSON.stringify(turned),/already_running/);
 assert.equal(leaseDoc(w).taskId,'task45');
}

// 10. A label on a keyed start is only a correlation: the key still decides the join, and the run is then operated by that label only; a keyed start without a label stays label-free and is read and
// operated without one (a Task's label is refused on it, also through the MCP readback).
{
 const w=await world();
 const keyed=await batch(w,'task00',{invocationKey:'task-s5-q15:2026-11-22T10'});assert.equal(keyed.data.status,'running',JSON.stringify(keyed.data).slice(0,200));
 assert.equal(leaseDoc(w).taskId,'task00');assert.equal(JSON.parse(runRows(w)[0].document_json).taskId,'task00');
 assert.equal((await w.rawApi('heartbeat',{runId:keyed.data.runId})).data.code,'wrong_owner');
}
{
 const w=await world();
 const keyless=await batch(w,null,{invocationKey:'task-s5-q15:2026-11-22T10'});assert.equal(keyless.data.status,'running');assert.equal(leaseDoc(w).taskId,undefined);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 const before=snapshot(w);
 for(const [name,args] of [['prediction_batch_manifest',{taskId:'task00',runId:keyless.data.runId}],['prediction_heartbeat',{taskId:'task00',runId:keyless.data.runId}],['prediction_complete',{taskId:'task00',runId:keyless.data.runId}]]){
  const r=await tool(name,args);assert.equal(r.isError,true,name);assert.match(JSON.stringify(r),/wrong_owner/,name);
 }
 assert.equal(snapshot(w),before,'a Task label on a label-free run reads and writes nothing');
}
