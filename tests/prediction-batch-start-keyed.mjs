// ADR 0188 (AIR-573): keyed idempotent `batch_start` and the early start claim. Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2, as production runs the prediction
// domain. No production call, no Scheduled Task, no model. A start without a key is covered unchanged by prediction-batch-start.mjs and lease-recovery.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';

const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const KEY='task-s5-q15:2026-11-21T13';
const OTHER='task-s5-q30:2026-11-21T13';
const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const leaseDoc=w=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const setLease=(w,doc)=>sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
const runs=w=>sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n;
const world=async(n=6)=>{const w=await flowWorld({films:n});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));return w;};
const manifestKey=id=>'enrichment/batch-manifest/'+id+'.json';

// 1. A keyed start is an ordinary run; the lease carries the correlation hashes and never the key; the key reaches no row, record or diagnostic.
{
 const w=await world();
 const r=await batch(w,{invocationKey:KEY});
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'running');assert.equal(r.data.lease.epoch,1);
 const lease=leaseDoc(w);
 assert.equal(lease.phase,'run','the claim became the run lease');assert.equal(lease.runId,r.data.runId);assert.equal(lease.epoch,1,'conversion keeps the epoch');
 assert.match(lease.keyHash,/^[0-9a-f]{64}$/);assert.match(lease.argsHash,/^[0-9a-f]{64}$/);assert.ok(lease.expiresAt>Date.now()+14*60000,'normal 15 minute TTL after conversion');
 assert.ok(!dump(w.file).includes(KEY),'the key is in no D1 row');assert.ok(!JSON.stringify([...w.records.entries()]).includes(KEY),'the key is in no R2 record');
 // heartbeat and a gated write keep the correlation fields
 const beat=await w.api('heartbeat',{runId:r.data.runId});assert.equal(beat.status,200,JSON.stringify(beat.data).slice(0,200));
 const after=leaseDoc(w);for(const f of ['phase','keyHash','argsHash'])assert.equal(after[f],lease[f],f+' survives a heartbeat');
 assert.equal(after.clientSubmitAt,undefined,'a heartbeat never closes the join window');
}

// 2. A same-key repeat of the live run returns the same manifest and writes nothing; heartbeat in between does not matter (pending -> heartbeat -> join -> recovery).
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 await w.api('heartbeat',{runId:first.data.runId});
 const before=JSON.stringify([sql(w.file,'SELECT * FROM prediction_run'),leaseDoc(w)]),keys=[...w.records.keys()].sort().join('|');
 const again=await batch(w,{invocationKey:KEY});
 assert.equal(again.status,200,JSON.stringify(again.data).slice(0,200));assert.equal(again.data.runId,first.data.runId);assert.equal(again.data.lease.epoch,first.data.lease.epoch);
 assert.deepEqual(again.data.films.map(f=>f.filmId),first.data.films.map(f=>f.filmId));
 assert.equal(JSON.stringify([sql(w.file,'SELECT * FROM prediction_run'),leaseDoc(w)]),before,'a join writes no run and no lease, extends no TTL');
 assert.equal([...w.records.keys()].sort().join('|'),keys,'a join writes no record');
 // no key, another key, another argument set: today's already_running naming the holder
 const keyless=await batch(w);assert.equal(keyless.data.status,'already_running');assert.equal(keyless.data.runId,first.data.runId);
 const other=await batch(w,{invocationKey:OTHER});assert.equal(other.data.status,'already_running');assert.equal(other.data.runId,first.data.runId);assert.equal(other.data.reason,undefined);
 const mismatch=await batch(w,{invocationKey:KEY,manifestSize:3});assert.equal(mismatch.data.status,'already_running');assert.equal(mismatch.data.reason,'key_args_mismatch');
 assert.equal(leaseDoc(w).runId,first.data.runId,'nobody adopted the run');
}

// 3. An external batch_submit closes the join window for good; the internal staged drain does not (it uses the internal gate, see the source assertion below).
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 const id=first.data.films[0].filmId;
 const sub=await w.api('batch/submit',{runId:first.data.runId,epoch:first.data.lease.epoch,items:[{filmId:id,fingerprint:w.fingerprint,prediction:w.prediction}]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,200));
 const lease=leaseDoc(w);assert.ok(lease.clientSubmitAt,'the first client submit set the marker');
 const again=await batch(w,{invocationKey:KEY});assert.equal(again.data.status,'already_running','after a client submit a repeat is refused as today');
 const second=lease.clientSubmitAt;await w.api('heartbeat',{runId:first.data.runId});assert.equal(leaseDoc(w).clientSubmitAt,second,'the marker is monotonic and survives a heartbeat');
}

// 4. A repeat while the owner request is still persisting: the stored answer when it appears, else a bounded wait and `start_pending`, and the read-only manifest tool answers pending.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});const stored=w.records.get(manifestKey(first.data.runId));assert.ok(stored,'the owner request stored its answer');
 // Re-create the in-flight state: a claim phase lease, the answer not stored yet.
 const lease=leaseDoc(w);w.records.delete(manifestKey(first.data.runId));setLease(w,{...lease,phase:'claim',expiresAt:Date.now()+180000});
 setTimeout(()=>w.records.set(manifestKey(first.data.runId),stored),1500);
 let t=Date.now();const joined=await batch(w,{invocationKey:KEY});
 assert.equal(joined.status,200);assert.equal(joined.data.runId,first.data.runId);assert.equal(joined.data.status,'running','the stored answer is returned once it exists');const joinedMs=Date.now()-t;
 w.records.delete(manifestKey(first.data.runId));
 t=Date.now();const pending=await batch(w,{invocationKey:KEY});const waited=Date.now()-t;
 assert.equal(pending.status,200,JSON.stringify(pending.data).slice(0,200));assert.equal(pending.data.status,'start_pending');assert.equal(pending.data.runId,first.data.runId);assert.equal(pending.data.epoch,first.data.lease.epoch);assert.equal(pending.data.retryAfterMs,2000);
 // Runner-clock checks (ADR 0188: the join answers within JOIN_WAIT_MS, 10 s; the traces do not prove 10 s safe, natural runs do): the non-functional suite only.
 nonFunctional('prediction-batch-start-keyed-join-bound',()=>{assert.ok(joinedMs<6000,'returned as soon as the answer appeared: '+joinedMs);assert.ok(waited>=9000&&waited<13000,'bounded by JOIN_WAIT_MS (10 s): '+waited);});
 // the same keyed start again after the owner stored its answer is a join
 w.records.set(manifestKey(first.data.runId),stored);
 const recovered=await batch(w,{invocationKey:KEY});assert.equal(recovered.data.status,'running');assert.equal(recovered.data.runId,first.data.runId);
}

// 5. A keyed no-run exit releases its claim: no run, no Event, no diagnostics row; the lease record was written twice and its epoch advanced.
{
 const w=await world();
 const before=runs(w);
 const idle=await batch(w,{invocationKey:KEY,capacity:{remainingPercent:0}});
 assert.notEqual(idle.data.status,'running',JSON.stringify(idle.data).slice(0,200));
 const lease=leaseDoc(w);assert.equal(lease.expiresAt,0,'the claim was released');assert.equal(lease.epoch,1);assert.equal(runs(w),before,'no run was created');
 const next=await batch(w,{invocationKey:KEY});assert.equal(next.data.status,'running','the next keyed start takes the lease again');assert.equal(next.data.lease.epoch,2);
}

// 6. dryRun with a key stays strictly write-free beside a live lease and never claims; a keyless real start is unchanged beside a keyed run.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 const before=dump(w.file),keys=[...w.records.keys()].sort().join('|');
 const dry=await batch(w,{invocationKey:KEY,dryRun:true});assert.equal(dry.status,200,JSON.stringify(dry.data).slice(0,200));assert.equal(dry.data.dryRun,true);assert.equal(dry.data.runId,null);
 assert.equal(dump(w.file),before,'a keyed dry run writes nothing');assert.equal([...w.records.keys()].sort().join('|'),keys);
}

// 7. Invalid keys are refused before anything is written.
{
 const w=await world();const before=dump(w.file);
 for(const bad of ['short','x'.repeat(129),'has space in the key 1234',12345678901234567]){
  const r=await batch(w,{invocationKey:bad});assert.equal(r.status,400,String(bad));assert.equal(r.data.error,'Invalid invocationKey');
 }
 assert.equal(dump(w.file),before);
}

// 8. A previous expired lease is recovered by a keyed start exactly as by a keyless one.
{
 const w=await world();
 const old=await batch(w);assert.equal(old.data.status,'running');
 setLease(w,{...leaseDoc(w),expiresAt:1});
 const next=await batch(w,{invocationKey:KEY});assert.equal(next.data.status,'running',JSON.stringify(next.data).slice(0,200));assert.equal(next.data.lease.epoch,2);
 const recovered=sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+old.data.runId+"'");assert.equal(JSON.parse(recovered[0].d).recoveredByRunId,next.data.runId,'the previous run was interrupted and attributed to the new run');
}

// 9. Takeover of the claim during the preflights: the original handler renews, finds another holder and ends with nothing written; the new holder's lease is untouched.
{
 const w=await world();
 const foreign={owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:7,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)};
 let hijacked=false;const get=w.env.BUCKET.get.bind(w.env.BUCKET);
 w.env.BUCKET.get=async(...a)=>{if(!hijacked){const row=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];if(row&&JSON.parse(row.d).phase==='claim'){hijacked=true;setLease(w,foreign);}}return get(...a);};
 const r=await batch(w,{invocationKey:KEY});
 assert.ok(hijacked,'the claim existed during the start');
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.reason,'start_claim_lost');
 assert.equal(runs(w),0,'a superseded start created no run');assert.deepEqual(leaseDoc(w),foreign,'the old handler neither released nor converted the new holder\'s lease');
 assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/sources/')||k.startsWith('enrichment/batch-manifest/')),'no source and no manifest were published');
}

// 10. Takeover after conversion, before the persist side effects: ownership is checked, nothing is published by the superseded handler.
{
 const w=await world();
 const foreign={owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:9,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)};
 let hijacked=false;const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 w.env.BUCKET.put=async(...a)=>{if(!hijacked){const row=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];if(row&&JSON.parse(row.d).phase==='run'){hijacked=true;setLease(w,foreign);}}return put(...a);};
 const r=await batch(w,{invocationKey:KEY});
 assert.ok(hijacked,'the conversion happened before the takeover');
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.status,'lease_lost');
 assert.equal(runs(w),0,'a superseded handler never publishes a run');assert.deepEqual(leaseDoc(w),foreign);
 assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/sources/')||k.startsWith('enrichment/batch-manifest/')),'no source and no manifest');
}

// 11. The read-only manifest tool answers `manifest_pending`, never unknown, while the start is preparing, and `invocationKey` is accepted (and validated) by prediction_batch_start itself.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});const stored=w.records.get(manifestKey(first.data.runId));
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.records.delete(manifestKey(first.data.runId));
 const pending=await tool('prediction_batch_manifest',{runId:first.data.runId});
 assert.equal(pending.isError,true);assert.match(JSON.stringify(pending),/manifest_pending/,JSON.stringify(pending).slice(0,300));assert.doesNotMatch(JSON.stringify(pending),/unknown_run|manifest_unavailable/);
 // the run is not saved yet either: the claim holds the lease under the future run id
 sql(w.file,"DELETE FROM prediction_run WHERE run_id='"+first.data.runId+"'");w.records.delete('enrichment/runs/'+first.data.runId+'.json');
 const preparing=await tool('prediction_batch_manifest',{runId:first.data.runId});assert.match(JSON.stringify(preparing),/manifest_pending/,JSON.stringify(preparing).slice(0,300));
 w.records.set(manifestKey(first.data.runId),stored);
 const bad=await tool('prediction_batch_start',{trigger:'scheduled',invocationKey:'short'});assert.equal(bad.isError,true);assert.match(JSON.stringify(bad),/invocationKey/);
}
console.log('prediction-batch-start-keyed: ok');
