// AIR-574. A real `batch_start` (keyless and keyed ADR 0188, five films as the S5 Task asks) over the REAL Discovery D1 rows, never a stubbed gate: a loading ledger seal does not refuse a start whose
// films were read from a consistent queue, while a catalog replacement, an ABA through `loading`, a programme change and a held cutover still fail closed. Offline: the real Worker over a sqlite D1
// stand-in and an in-memory R2. No production call, Scheduled Task or model.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

Error.stackTraceLimit=200;// the interleaving hook names the calling phase from the (async) stack
const KEY='task-s5-q15:2026-11-21T13';
const START={scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100},manifestSize:5};
const VARIANTS=[['keyless',{}],['keyed',{invocationKey:KEY}]];
const world=async()=>{const w=await flowWorld({films:6});assert.equal((await w.api('queue/reconcile',{})).status,200);return w;};
const start=(w,extra={})=>w.api('batch/start',{...START,...extra});
const queueRows=w=>JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));
const runCount=w=>sql(w.file,'SELECT COUNT(*) AS n FROM prediction_run')[0].n;
const leaseLive=w=>{const rows=sql(w.file,"SELECT expires_at AS e FROM prediction_lease WHERE name='runner'");return rows.length>0&&rows[0].e>Date.now();};
const manifestKeys=w=>[...w.records.keys()].filter(key=>key.includes('batch-manifest/'));
// AIR-575 (ADR 0190): a real start refused with the 503 `prediction_catalog_held` leaves exactly one neutral skipped Event (two objects: the parked record and the journal item). It is not a run, a stop or a terminal Event,
// so the run/stop/terminal check below ignores it and a separate count checks it. The 502 `discovery_unavailable` and a dry run write no Event at all.
const isSkipped=key=>key.includes('-enrichment-skipped-')||key.includes('stop-events/skipped-');
const eventKeys=w=>[...w.records.keys()].filter(key=>(key.startsWith('events/')||key.includes('stop-events/'))&&!isSkipped(key));
const skippedRecords=w=>[...w.records.keys()].filter(key=>key.includes('stop-events/skipped-'));
const seal=w=>sql(w.file,"UPDATE discovery_transfer SET state='loading', programme_run_id='seal-run' WHERE id=1");
const pendingAdmission=w=>sql(w.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_9001','9001','movie','tmdb:9001','tmdb_9001','seal-run',1,'pending','"+JSON.stringify({id:'tmdb_9001',title:'t',tmdbId:'9001',canonicalIdentity:'tmdb:9001',shows:[]})+"')");
// The first five films a start would deliver (a dry run reads and writes nothing).
const selected=async w=>(await start(w,{dryRun:true})).data.films.map(f=>f.filmId);
// A refusal answers without any side effect: no run, no live lease (a keyed claim is released), no manifest, no run/stop/terminal Event, the queue untouched. `skipped` is the number of neutral skipped Events (AIR-575) it leaves: one for the 503, none for the 502.
const assertNoEffect=(w,was,label,skipped=0)=>{assert.equal(skippedRecords(w).length-was.skipped,skipped,label+': skipped Events');assert.equal(runCount(w),was.runs,label+': no run');assert.equal(leaseLive(w),false,label+': no live lease (a keyed claim is released)');assert.deepEqual(manifestKeys(w),was.manifests,label+': no manifest');assert.deepEqual(eventKeys(w),was.events,label+': no Event');assert.equal(queueRows(w),was.queue,label+': the queue is untouched');};
const effects=w=>({runs:runCount(w),manifests:manifestKeys(w),events:eventKeys(w),skipped:skippedRecords(w).length,queue:queueRows(w)});

for(const [name,extra] of VARIANTS){
 // 1. The RCA: the films are selected, a ledger seal is loading. The start runs and the run submits, replays and completes under the seal.
 {
  const w=await world();seal(w);
  const r=await start(w,extra);
  assert.equal(r.status,200,name+': '+JSON.stringify(r.data).slice(0,240));assert.equal(r.data.status,'running');assert.equal(r.data.films.length,5,name+': five films');assert.equal(skippedRecords(w).length,0,name+': an ordinary ledger seal is not a refusal, so no skipped Event (AIR-575)');
  const items=r.data.films.map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
  const payload={runId:r.data.runId,epoch:r.data.lease.epoch,items};
  const submitted=await w.api('batch/submit',payload);assert.equal(submitted.status,200,JSON.stringify(submitted.data).slice(0,200));
  assert.ok(submitted.data.results.every(item=>item.status==='created'),name+': every film created');
  const replay=await w.api('batch/submit',payload);assert.equal(replay.status,200);assert.ok(replay.data.results.every(item=>item.replayed===true),name+': an identical replay is answered as a replay, no second write '+JSON.stringify(replay.data.results));
  const done=await w.api('complete',{runId:r.data.runId,reason:'manifest_spent'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 }
 // 2. Fail closed, typed and recoverable, with no side effect. A catalog replacement (a pending admission under `loading`), and a `loading` transfer that is no ledger seal (no pending admission).
 for(const [label,arrange] of [['pending admission',w=>{seal(w);pendingAdmission(w);}],['loading that is no seal',w=>sql(w.file,"UPDATE discovery_transfer SET state='loading', programme_run_id=NULL WHERE id=1")]]){
  const w=await world(),was=effects(w);arrange(w);
  const r=await start(w,extra);
  assert.equal(r.status,503,name+' '+label);assert.equal(r.data.code,'prediction_catalog_held');assert.equal(r.data.cause,'discovery_incomplete');assert.ok(!r.data.error,'not a storage_error');
  assertNoEffect(w,was,name+' '+label,1);
 }
 // 3. A held cutover is the real ADR 0162 refusal: `readAuthority` itself answers `discovery_unavailable` (502), it never reaches the `prediction_catalog_held` gate. Typed, fail-closed, no side effect.
 {
  const w=await world(),was=effects(w);sql(w.file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
  const r=await start(w,extra);
  assert.equal(r.status,502,name+' held: '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.error,'discovery_unavailable');assert.notEqual(r.data.status,'running');
  assertNoEffect(w,was,name+' held');
 }
 // 4. A genuinely revoked admission under a valid seal is a real absence: it is skipped and leaves the queue, the other four films are delivered.
 {
  const w=await world(),gone=(await selected(w))[0];seal(w);
  sql(w.file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='"+gone+"'");
  const r=await start(w,extra);
  assert.equal(r.status,200,name+': '+JSON.stringify(r.data).slice(0,240));assert.ok(!r.data.films.some(f=>f.filmId===gone),name+': the revoked film is not delivered');
  assert.equal(r.data.queueRefreshed,true,name+': the queue was refreshed');assert.ok(r.data.queueSettled>=1,name+': the genuinely absent film was settled out of the queue');assert.equal(r.data.films.length,5,name+': filled from the rest of the queue');
 }
 // 5. P1 interleaving, deterministic: the by-id admission read is torn by a catalog replacement, an ABA through `loading` (the transfer epoch moves), a programme change or a seal turning into a
 // replacement between its statements. Every admission then reads absent; the start must refuse typed and must not settle a film out of the persisted queue (the lease-time preflight cannot undo it).
 const TEAR={
  replacement:w=>{sql(w.file,"UPDATE discovery_admission SET state='superseded' WHERE state='current'");sql(w.file,'UPDATE discovery_transfer SET batches=batches+1 WHERE id=1');},
  aba:w=>{sql(w.file,"UPDATE discovery_admission SET state='superseded' WHERE state='current'");sql(w.file,"UPDATE discovery_transfer SET state='committed', batches=batches+2 WHERE id=1");},
  programme:w=>{sql(w.file,"UPDATE discovery_admission SET state='superseded' WHERE state='current'");sql(w.file,"UPDATE discovery_authority SET programme_run_id='moved' WHERE id=1");}
 };
 for(const base of ['committed','seal']){
  for(const [tear,mutate] of Object.entries(TEAR)){
   for(const phase of ['batchPreflight','batchRefreshQueue']){
    const w=await world();
    // The refresh path needs a start that already found a missing admission (an unrelated revoked film), so that a settlement is on the table.
    if(phase==='batchRefreshQueue')sql(w.file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='"+(await selected(w))[0]+"'");
    if(base==='seal')seal(w);
    const was=effects(w);let fired=0;
    w.hooks.query=text=>{if(!fired&&/FROM discovery_admission WHERE state='current' AND film_id IN/.test(text)&&new Error().stack.includes(phase)){fired++;mutate(w);}};
    const r=await start(w,extra);w.hooks.query=null;
    const label=[name,base,tear,phase].join(' ');
    assert.equal(fired,1,label+': the tear was injected in the by-id read');
    assert.equal(r.status,503,label+': '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'prediction_catalog_held',label);assert.equal(r.data.cause,'discovery_fence',label);
    assertNoEffect(w,was,label,1);
   }
  }
 }
 // 6. Generation-only progress between the statements (a continuation, status or Workflow write; seal batches) is no fence: the start stays open.
 for(const base of ['committed','seal']){
  const w=await world();if(base==='seal')seal(w);let fired=0;
  w.hooks.query=text=>{if(!fired&&/FROM discovery_admission WHERE state='current' AND film_id IN/.test(text)){fired++;sql(w.file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}};
  const r=await start(w,extra);w.hooks.query=null;
  assert.equal(fired>=1,true);assert.equal(r.status,200,name+' '+base+': generation-only progress keeps the read open: '+JSON.stringify(r.data).slice(0,200));assert.equal(r.data.films.length,5);
 }
}
console.log('prediction start under a ledger seal: keyless and keyed starts run with five trusted films; replacement, ABA, programme change and held cutover fail closed with no side effect; generation-only progress stays open passed');
