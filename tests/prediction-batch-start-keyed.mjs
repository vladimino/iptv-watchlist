// ADR 0188 (AIR-573): keyed idempotent `batch_start` and the early start claim. Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2, as production runs the prediction
// domain. No production call, no Scheduled Task, no model. A start without a key is covered unchanged by prediction-batch-start.mjs and lease-recovery.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';
import {withTaskId,labelledApi} from './prediction-task-id-lib.mjs';

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

// 10. Takeover at every persist boundary (ADR 0188): the lease is replaced by a foreign holder right after an operation completed and before the next ownership check. The superseded handler
// answers `start_claim_lost`, writes no stop Event, step or manifest, leaves the new holder untouched, and D1 commits are fenced by the commit guard.
{
 const foreign=epoch=>({owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)});
 const boundary=async(name,match,expect)=>{
  const w=await world();const other=foreign(9);let done=false,seen=0;const put=w.env.BUCKET.put.bind(w.env.BUCKET);
  w.env.BUCKET.put=async(key,...a)=>{const result=await put(key,...a);if(!done&&match(w,String(key),++seen)){done=true;setLease(w,other);}return result;};
  const r=await batch(w,{invocationKey:KEY});
  assert.ok(done,name+': the takeover was injected');
  assert.equal(r.status,409,name+' '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_claim_lost',name);
  assert.deepEqual(leaseDoc(w),other,name+': the new holder\'s lease is untouched (not released, not converted, no gate)');
  const keys=[...w.records.keys()];
  assert.ok(!keys.some(k=>k.startsWith('enrichment/stop-events/')),name+': no stop Event');
  assert.ok(!keys.some(k=>k.startsWith('enrichment/batch-manifest/')),name+': the manifest was never published');
  expect(w,keys);
 };
 const gateLive=w=>{const d=leaseDoc(w);return d.phase==='run'&&!!d.submitGate;};
 // B0: right after the persist gate is set, before anything else of the persist: nothing is written at all.
 await boundary('B0 gate set',(w,key)=>key==='enrichment/runner-lease.json'&&gateLive(w),(w,keys)=>{
  assert.equal(runs(w),0);assert.ok(!keys.some(k=>k.startsWith('enrichment/run-diagnostics/')||k.startsWith('enrichment/sources/')||k==='enrichment/latest-run.json'),'B0: no diagnostics row, no source, no latest-run');
 });
 // B1: right after the prediction writer lease was taken, before the sources: no source, no run, no latest-run.
 await boundary('B1 writer lease',(w,key,n)=>key==='enrichment/writer-lease.json',(w,keys)=>{
  assert.equal(runs(w),0);assert.ok(!keys.some(k=>k.startsWith('enrichment/sources/')||k==='enrichment/latest-run.json'),'B1: no source, no latest-run');
 });
 // B2: right after the sources, before the run save: the guarded run commit rolls back (no run row, no latest-run).
 await boundary('B2 run save',(w,key)=>key.startsWith('enrichment/sources/'),(w,keys)=>{
  assert.equal(runs(w),0,'B2: the guarded run save committed nothing');assert.ok(!keys.includes('enrichment/latest-run.json'),'B2: no latest-run overwrite');
 });
 // B3: right after the run was saved and started (while it still owned the lease), before the drain and the manifest: no manifest, and no stop Event for the run.
 await boundary('B3 drain and manifest',(w,key,n)=>key==='enrichment/latest-run.json'&&sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n>=1&&(w.__latest=(w.__latest||0)+1)>=2,(w,keys)=>{
  assert.ok(keys.includes('enrichment/latest-run.json'),'B3: the run committed while the handler still owned the lease');
 });
 // B4: a staged row is drained (here dropped as stale) under the start's own gate; the takeover comes right after the drain wrote, before the manifest write: still no manifest.
 {
  const w=await world();w.records.set('enrichment/batch-stage.json',{items:[{filmId:'stale-film-1'}]});
  const other=foreign(11);let done=false;const put=w.env.BUCKET.put.bind(w.env.BUCKET);
  w.env.BUCKET.put=async(key,...a)=>{const result=await put(key,...a);if(!done&&String(key)==='enrichment/batch-stage.json'){done=true;setLease(w,other);}return result;};
  const r=await batch(w,{invocationKey:KEY});
  assert.ok(done,'B4: the staged row was drained and the takeover injected');assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_claim_lost');
  assert.deepEqual(leaseDoc(w),other,'B4: the new holder is untouched');assert.ok(![...w.records.keys()].some(k=>k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/stop-events/')),'B4: no manifest, no stop Event');
 }
}

// 10a. Exceptional exits of a claimed start never reach the unfenced stop recorder (ADR 0188). A normal Error is injected into a persist R2 write; with a foreign takeover at the same moment the
// handler answers `start_claim_lost`, and as the real owner it releases its own lease and answers a bounded recoverable `start_storage_error`. Either way: no stop Event, no stop record, no
// `latest-run` overwrite, no manifest. Both with the run record not existing yet (sources) and existing (manifest).
{
 const foreign=()=>({owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:13,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)});
 const faulty=async(name,match,takeover,expect)=>{
  const w=await world();const other=foreign();let hit=false;const put=w.env.BUCKET.put.bind(w.env.BUCKET);
  w.env.BUCKET.put=async(key,...a)=>{if(!hit&&match(String(key))){hit=true;if(takeover)setLease(w,other);throw new Error('r2 unavailable');}return put(key,...a);};
  const r=await batch(w,{invocationKey:KEY});
  assert.ok(hit,name+': the fault was injected');
  const keys=[...w.records.keys()];
  assert.ok(!keys.some(k=>k.startsWith('enrichment/stop-events/')),name+': no stop Event or stop record');assert.ok(!keys.some(k=>k.startsWith('enrichment/batch-manifest/')),name+': no manifest');
  expect(w,r,other);
 };
 const latest=w=>{const row=sql(w.file,'SELECT document_json AS d FROM prediction_run WHERE latest=1')[0];return row?JSON.parse(row.d):null;};
 // run record does not exist yet (the sources write fails)
 await faulty('F1 takeover, no run record',k=>k.startsWith('enrichment/sources/'),true,(w,r,other)=>{
  assert.equal(r.status,409);assert.equal(r.data.code,'start_claim_lost');assert.deepEqual(leaseDoc(w),other);assert.equal(runs(w),0);assert.equal(latest(w),null,'no latest-run');
 });
 await faulty('F2 real owner, no run record',k=>k.startsWith('enrichment/sources/'),false,(w,r)=>{
  assert.equal(r.status,502);assert.equal(r.data.code,'start_storage_error');assert.equal(r.data.recoverable,true);assert.equal(leaseDoc(w).expiresAt,0,'the owner released its own lease');assert.equal(runs(w),0);assert.equal(latest(w),null);
 });
 // run record exists (the manifest write fails): it stays exactly as committed while owned, never marked stopped
 await faulty('F3 takeover, run exists',k=>k.startsWith('enrichment/batch-manifest/'),true,(w,r,other)=>{
  assert.equal(r.status,409);assert.equal(r.data.code,'start_claim_lost');assert.deepEqual(leaseDoc(w),other);assert.equal(runs(w),1);assert.equal(latest(w).status,'running','the run record was not rewritten as stopped');
 });
 await faulty('F4 real owner, run exists',k=>k.startsWith('enrichment/batch-manifest/'),false,(w,r)=>{
  assert.equal(r.status,502);assert.equal(r.data.code,'start_storage_error');assert.equal(leaseDoc(w).expiresAt,0);assert.equal(latest(w).status,'running');
 });
}

// 10e. Failures AFTER the claim became the 15 minute run lease but BEFORE observedPrediction owns the cleanup (ADR 0188): the persist gate cannot be set (a thrown error, bounded CAS contention) and
// the very first fence/renew throws. A still-owned failure releases its own lease and answers a bounded recoverable `start_storage_error`; a superseded handler leaves the foreign holder untouched
// and answers `start_claim_lost`. Neither writes a run, diagnostics row, stop Event, manifest or `latest-run`.
{
 const foreign=()=>({owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:21,phase:'run',keyHash:'f'.repeat(64),argsHash:'e'.repeat(64)});
 const leaseWrite=statements=>statements.some(item=>/UPDATE prediction_lease/i.test(item.text));
 const nothing=(w,name)=>{
  const keys=[...w.records.keys()];
  assert.equal(runs(w),0,name+': no run');assert.ok(!keys.some(k=>k.startsWith('enrichment/run-diagnostics/')||k.startsWith('enrichment/stop-events/')||k.startsWith('enrichment/batch-manifest/')||k.startsWith('enrichment/sources/')||k==='enrichment/latest-run.json'),name+': no diagnostics, stop Event, manifest, source or latest-run');
 };
 // `when(doc)` says which lease write to hit; `how` is 'throw' or 'contend'; `takeover` replaces the lease with a foreign holder at the same moment.
 const scenario=async(name,when,how,takeover)=>{
  const w=await world();const other=foreign();let fired=0;
  const peek=()=>{try{return leaseDoc(w);}catch{return {};}}; // the lease row does not exist before the first claim
  // 'contend': the lease write of the targeted step loses its compare-and-swap three times (RUNNER_LEASE_ATTEMPTS) while the lease is still this run's (a CHECK failure is a CAS loss to the D1 adapter).
  // 'throw': the write fails with an ordinary storage error.
  // 'readthrow': the first READ of the lease after the gate was set fails (a check of the gate is a read while the gate is young).
  if(how==='readthrow')w.hooks.query=text=>{
   if(fired>=1||!/^\s*SELECT .*FROM prediction_lease WHERE name='runner'/is.test(text))return;const doc=peek();if(!when(doc))return;fired++;
   if(takeover)setLease(w,other);
   throw new Error('d1 unavailable');
  };
  else w.hooks.write=statements=>{
   if(!leaseWrite(statements))return;const doc=peek();if(!when(doc)||fired>=(how==='contend'?3:1))return;fired++;
   if(how==='contend')throw new Error('CHECK constraint failed: prediction_domain_cas');
   if(takeover)setLease(w,other);
   throw new Error('d1 unavailable');
  };
  const r=await batch(w,{invocationKey:KEY});w.hooks.write=null;w.hooks.query=null;
  assert.ok(fired>=1,name+': the failure was injected');
  nothing(w,name);
  if(takeover){assert.equal(r.status,409,name+' '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_claim_lost',name);assert.deepEqual(leaseDoc(w),other,name+': the foreign holder is untouched');}
  else{assert.equal(r.status,502,name+' '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'start_storage_error',name);assert.equal(r.data.recoverable,true);assert.equal(leaseDoc(w).expiresAt,0,name+': the converted lease was released, not stranded for 15 minutes');}
 };
 const gateSetting=doc=>doc.phase==='run'&&!doc.submitGate;
 const firstRenew=doc=>doc.phase==='run'&&!!doc.submitGate;
 await scenario('G1 gate set throws',gateSetting,'throw',false);
 await scenario('G2 gate set throws, takeover',gateSetting,'throw',true);
 await scenario('G3 gate set CAS contention',gateSetting,'contend',false);
 await scenario('G4 first fence check throws',firstRenew,'readthrow',false);
 await scenario('G5 first fence check throws, takeover',firstRenew,'readthrow',true);
}

// 10d. The R2 `latest-run.json` is a non-authoritative mirror written after the D1 commit: a reader in D1 mode never sees a stale or out-of-order mirror object.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 w.records.set('enrichment/latest-run.json',{runId:'stale-mirror-run',status:'running',createdAt:'2020-01-01T00:00:00.000Z',selectedIds:[],results:{},failures:{}});
 const res=await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/status'),w.env);const text=await res.text();
 assert.equal(res.status,200);assert.ok(!text.includes('stale-mirror-run'),'status reads the D1 run, not the R2 mirror object');assert.ok(text.includes(first.data.runId),'status names the D1 latest run');
}

// 10b. The frozen answer, the stored copy and a joined answer all carry the converted 15 minute expiry, consistent with the lease in D1.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 const lease=leaseDoc(w),stored=w.records.get(manifestKey(first.data.runId)),joined=await batch(w,{invocationKey:KEY});
 assert.ok(first.data.lease.expiresAt>Date.now()+14*60000,'the original answer carries the run expiry, not the 180 s claim expiry');
 assert.equal(stored.lease.expiresAt,first.data.lease.expiresAt,'the stored answer is the one the owner returned');assert.equal(joined.data.lease.expiresAt,first.data.lease.expiresAt,'a joined answer carries the same expiry');
 assert.ok(Math.abs(lease.expiresAt-first.data.lease.expiresAt)<60000,'consistent with the authoritative lease in D1 (later gate and heartbeat renewals only extend it)');
 assert.equal(first.data.lease.ttlMs,15*60000);
 const run=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+first.data.runId+"'")[0].d);
 assert.equal(run.keyHash,lease.keyHash,'the run carries the key hash (ADR 0188)');assert.equal(run.argsHash,lease.argsHash,'the run carries the argument hash');
 assert.equal(lease.submitGate,undefined,'the persist gate was cleared');
}

// 10c. The join re-reads the holder immediately before it returns: a client submit (or a takeover) between the first lease read and the manifest read closes the window.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});assert.equal(first.data.status,'running');
 let done=false;const get=w.env.BUCKET.get.bind(w.env.BUCKET);
 w.env.BUCKET.get=async(key,...a)=>{if(!done&&String(key)===manifestKey(first.data.runId)){done=true;setLease(w,{...leaseDoc(w),clientSubmitAt:new Date().toISOString()});}return get(key,...a);};
 const raced=await batch(w,{invocationKey:KEY});
 assert.ok(done,'the submit was injected between the lease read and the manifest read');assert.equal(raced.data.status,'already_running','the closed window is refused even though the manifest was stored');
 w.env.BUCKET.get=get;
 // a takeover between the same two reads
 const w2=await world();const f2=await batch(w2,{invocationKey:KEY});let done2=false;const get2=w2.env.BUCKET.get.bind(w2.env.BUCKET);
 w2.env.BUCKET.get=async(key,...a)=>{if(!done2&&String(key)===manifestKey(f2.data.runId)){done2=true;setLease(w2,{owner:'foreign-run',runId:'foreign-run',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+15*60000,epoch:5});}return get2(key,...a);};
 const raced2=await batch(w2,{invocationKey:KEY});assert.ok(done2);assert.notEqual(raced2.data.status,'running','a join never returns a manifest of a run whose lease changed hands');
}

// 11. The read-only manifest tool answers `manifest_pending`, never unknown, while the start is preparing, and `invocationKey` is accepted (and validated) by prediction_batch_start itself.
{
 const w=await world();
 const first=await batch(w,{invocationKey:KEY});const stored=w.records.get(manifestKey(first.data.runId));
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args:withTaskId(name,args)};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.records.delete(manifestKey(first.data.runId));
 const pending=await tool('prediction_batch_manifest',{runId:first.data.runId});
 // the synchronous keyed variant: the same normal wait (a successful tool result of kind pending), never unknown_run and never an error
 assert.equal(pending.isError,undefined,JSON.stringify(pending).slice(0,300));assert.match(JSON.stringify(pending),/manifest_pending/,JSON.stringify(pending).slice(0,300));assert.match(JSON.stringify(pending),/kind.{1,8}pending/);assert.doesNotMatch(JSON.stringify(pending),/unknown_run|manifest_unavailable/);
 // the run is not saved yet either: the claim holds the lease under the future run id
 sql(w.file,"DELETE FROM prediction_run WHERE run_id='"+first.data.runId+"'");w.records.delete('enrichment/runs/'+first.data.runId+'.json');
 const preparing=await tool('prediction_batch_manifest',{runId:first.data.runId});assert.match(JSON.stringify(preparing),/manifest_pending/,JSON.stringify(preparing).slice(0,300));
 w.records.set(manifestKey(first.data.runId),stored);
 const bad=await tool('prediction_batch_start',{trigger:'scheduled',invocationKey:'short'});assert.equal(bad.isError,true);assert.match(JSON.stringify(bad),/invocationKey/);
}
console.log('prediction-batch-start-keyed: ok');
