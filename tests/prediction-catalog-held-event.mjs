// AIR-575 (ADR 0189): a real batch v2 `batch_start` the Worker refuses with HTTP 503 `prediction_catalog_held` leaves exactly one neutral `batch_v2_skipped` Event
// (`reason: catalog_held`, `cause`), on every refusal path (global gate, preflight, revalidation under the lease). It is not a run: no run, lease, queue or film changes, no stop Event.
// Covered: both causes, one Event per request id, a replay is one journal item, two request ids are two Events, dry run / 409 / a genuine `already_running` / a successful start
// write no catalog_held Event, a journal outage never changes the 503 and the outbox recovers the Event, the answer body is unchanged. Local stand-ins only.
import vm from 'node:vm';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:8});assert.equal((await w.api('queue/reconcile',{})).status,200);
const records=w.records,env=w.env,ctx=w.ctx;ctx.env=env;
let blocked=()=>false;
{const bucket=env.BUCKET,put=bucket.put;
 bucket.put=async(key,value,options)=>{if(blocked(key,options))throw new Error('storage outage');return put.call(bucket,key,value,options);};
 bucket.delete=async key=>{records.delete(key);};
 bucket.list=async({prefix=''})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false});}
const call=code=>vm.runInContext(code,ctx);
const api=async(path,body,{requestId=null}={})=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(requestId?{'X-Request-Id':requestId}:{})},body:JSON.stringify(body)}),env);return {status:response.status,data:await response.json()};};
const STOP=call('STOP_EVENT_PREFIX'),OUTBOX=call('EVENT_OUTBOX_KEY');
const journal=()=>[...records].filter(([key])=>key.startsWith('events/items/')).map(([,value])=>value);
const skipped=()=>journal().filter(event=>event.presentation==='batch_v2_skipped');
const held=()=>skipped().filter(event=>event.reason==='catalog_held');
const start=(requestId,extra={})=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:2,...extra},{requestId});
const tables=()=>JSON.stringify(sql(w.file,'SELECT * FROM prediction_run'))+JSON.stringify(sql(w.file,'SELECT * FROM prediction_lease'))+JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));
const orphans=()=>[...records].filter(([k,v])=>k.startsWith(STOP+'skipped-')&&!v.delivered&&!(records.get(OUTBOX)?.pending||{})[k]).map(([k])=>k);
const Authority=ctx.DiscoveryAuthority;
const withGate=async(gate,work)=>{ctx.DiscoveryAuthority={...Authority,readAuthority:async()=>gate};try{return await work();}finally{ctx.DiscoveryAuthority=Authority;}};
const GATES=[[{held:true,ready:true,transfer:'idle'},'discovery_fence'],[{held:false,ready:true,transfer:'loading'},'discovery_incomplete']];

// 1. The global gate: one neutral warning Event per refused request, the 503 body is the existing one, nothing of the runner changes, no stop Event, no run.
const state0=tables();
for(const [gate,cause] of GATES){
 const id='req-held-'+cause,answer=await withGate(gate,()=>start(id));
 assert.equal(answer.status,503);assert.equal(answer.data.code,'prediction_catalog_held');assert.equal(answer.data.cause,cause);assert.equal(answer.data.reason,'catalog_held');assert.ok(!answer.data.runId&&!answer.data.films,'no run is claimed');
 const events=held().filter(e=>e.requestId===id);assert.equal(events.length,1,'one Event for '+cause);const e=events[0];
 assert.equal(e.id,'enrichment-skipped-'+id);assert.equal(e.type,'enrichment');assert.equal(e.stage,'skipped');assert.equal(e.protocol,'batch_v2');assert.equal(e.presentation,'batch_v2_skipped');
 assert.equal(e.reason,'catalog_held');assert.equal(e.cause,cause);assert.equal(e.trigger,'scheduled');assert.ok(Number.isFinite(Date.parse(e.at)));
 for(const field of ['runId','holderRunId','holderAgeMs','added','updated','failed','processed','details','queueSchemaVersion','films','filmId'])assert.ok(!(field in e),'no '+field+' on a refused attempt');
 assert.equal(records.get(STOP+'skipped-'+id+'.json').delivered,true,'the durable record is delivered');
}
assert.equal(tables(),state0,'a catalog_held start changes no run, lease or queue');
assert.equal(journal().filter(e=>e.type==='enrichment'&&e.presentation!=='batch_v2_skipped').length,0,'no run, stop or terminal Event');
assert.deepEqual(Object.keys(records.get(OUTBOX)?.pending||{}),[],'delivered Events leave nothing in the outbox');
assert.deepEqual(orphans(),[]);
{// GET /api/events returns the Events and writes nothing
 const before=records.size,read=await ctx.worker.fetch(new Request('https://site.example/api/events'),env),body=await read.json(),list=body.events||body;
 assert.equal(read.status,200);for(const cause of ['discovery_fence','discovery_incomplete'])assert.ok(list.some(x=>x.id==='enrichment-skipped-req-held-'+cause&&x.reason==='catalog_held'&&x.cause===cause));
 assert.equal(records.size,before,'the read writes nothing');}

// 2. Identity is the request: a replay is one journal item with the same time, another request id (even within the same hour) is another Event.
{const at=held().find(e=>e.requestId==='req-held-discovery_fence').at,keys=()=>[...records.keys()].filter(k=>k.startsWith('events/items/')&&k.endsWith('-enrichment-skipped-req-held-discovery_fence.json'));
 const before=keys();assert.equal(before.length,1);await new Promise(r=>setTimeout(r,25));
 const replay=await withGate(GATES[0][0],()=>start('req-held-discovery_fence'));assert.equal(replay.status,503);
 assert.deepEqual(keys(),before,'a replayed request id writes no second journal item');assert.equal(held().find(e=>e.requestId==='req-held-discovery_fence').at,at,'same time');
 const count=held().length;
 const other=await withGate(GATES[0][0],()=>start('req-held-other',{trigger:'manual'}));assert.equal(other.status,503);
 assert.equal(held().length,count+1,'a different request id is not merged');assert.equal(held().find(e=>e.requestId==='req-held-other').trigger,'manual');
 const unkeyed=await withGate(GATES[1][0],()=>api('batch/start',{scope:'watchlist_all',mode:'queued',manifestSize:2}));assert.equal(unkeyed.status,503);
 assert.equal(held().length,count+2,'a request without X-Request-Id still leaves one Event (Worker-generated id)');
 const generated=held().find(e=>!['req-held-discovery_fence','req-held-discovery_incomplete','req-held-other'].includes(e.requestId));assert.ok(generated&&!('trigger' in generated),'no trigger is guessed when the request states none');}

// 3. Not a catalog_held refusal: a dry run, a rejected body, a successful start and the global gate cleared write none; the gate does not change a lease refusal.
{const count=held().length;
 const dry=await withGate(GATES[0][0],()=>start('req-held-dry',{dryRun:true}));assert.equal(dry.status,200,'a dry run answers before the catalog gate and is not refused');assert.equal(dry.data.dryRun,true);
 const bad=await withGate(GATES[0][0],()=>api('batch/start',{scope:'watchlist_all',mode:'queued',manifestSize:-1},{requestId:'req-held-bad'}));assert.ok(bad.status>=400&&bad.status!==503);
 assert.equal(held().length,count,'a dry run and a rejected body write no Event');
 const ok=await start('req-held-ok');assert.equal(ok.status,200);assert.equal(ok.data.status,'running');const runId=ok.data.runId;
 assert.equal(held().length,count,'a successful start writes no catalog_held Event');
 // a genuine already_running beside a held gate keeps its own reason: the lease check comes first
 const overlap=await withGate(GATES[0][0],()=>start('req-held-overlap'));assert.equal(overlap.data.status,'already_running');
 assert.equal(held().length,count);assert.equal(skipped().find(e=>e.requestId==='req-held-overlap').reason,'already_running','the lease refusal is not reclassified');
 assert.equal((await api('complete',{runId,reason:'quota'})).status,200);
 assert.equal(journal().filter(e=>e.id==='enrichment-'+runId).length,1,'the successful run keeps its single terminal Event');}

// 4. Other refusal paths. The preflight answers the same body; the revalidation under the lease (a hold that begins after the lease) releases the lease and answers it too.
{const original=ctx.batchPreflight,count=held().length;
 ctx.batchPreflight=async()=>({response:call('catalogHeldResponse')('discovery_fence')});
 try{const early=await start('req-held-preflight');assert.equal(early.status,503);assert.equal(early.data.cause,'discovery_fence');}finally{ctx.batchPreflight=original;}
 assert.equal(held().length,count+1);assert.equal(held().find(e=>e.requestId==='req-held-preflight').cause,'discovery_fence');
 const lease=ctx.runnerLease;let leased=false;
 ctx.runnerLease=async(e,id,operation)=>{const r=await lease(e,id,operation);if(operation==='acquire'&&r.status==='owned')leased=true;if(operation==='release')leased=false;return r;};
 ctx.batchPreflight=async(...args)=>{if(leased)throw Object.assign(new Error('held'),{code:'discovery_incomplete',stage:'queue_refresh'});return original(...args);};
 const runs=()=>JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),runsBefore=runs();let late;try{late=await start('req-held-lease');}finally{ctx.batchPreflight=original;ctx.runnerLease=lease;}
 assert.equal(late.status,503,JSON.stringify(late.data).slice(0,160));assert.equal(late.data.code,'prediction_catalog_held');
 assert.equal(held().filter(e=>e.requestId==='req-held-lease').length,1,'the refusal under the lease is recorded once');assert.equal(held().find(e=>e.requestId==='req-held-lease').cause,'discovery_incomplete');
 assert.equal(runs(),runsBefore,'no run was created');
 const next=await start('req-held-after');assert.equal(next.data.status,'running','the released lease lets the next start run');assert.equal((await api('complete',{runId:next.data.runId,reason:'quota'})).status,200);}

// 5. The journal is down: the 503 is unchanged, the record is parked and noted, a later start delivers it once; the index and the journal both down lose only this one Event.
{blocked=key=>key.startsWith('events/items/');
 const out=await withGate(GATES[1][0],()=>start('req-held-outage'));assert.equal(out.status,503);assert.equal(out.data.code,'prediction_catalog_held','a journal outage never changes the answer');
 blocked=()=>false;assert.equal(held().some(e=>e.requestId==='req-held-outage'),false,'not in the journal yet');
 const record=records.get(STOP+'skipped-req-held-outage.json');assert.ok(record&&record.event.reason==='catalog_held'&&record.delivered===undefined,'parked, undelivered');
 assert.ok(records.get(OUTBOX)?.pending?.[STOP+'skipped-req-held-outage.json'],'noted in the outbox');assert.deepEqual(orphans(),[]);
 const next=await start('req-held-recover');assert.equal(next.data.status,'running');
 const recovered=held().filter(e=>e.requestId==='req-held-outage');assert.equal(recovered.length,1,'recovered through the outbox');assert.equal(recovered[0].at,record.event.at);assert.equal(recovered[0].cause,'discovery_incomplete');
 assert.equal(records.get(OUTBOX)?.pending?.[STOP+'skipped-req-held-outage.json'],undefined,'it left the outbox');
 assert.equal((await api('complete',{runId:next.data.runId,reason:'quota'})).status,200);
 blocked=key=>key.startsWith('events/items/')||key===OUTBOX;const dual=await withGate(GATES[0][0],()=>start('req-held-dual'));blocked=()=>false;
 assert.equal(dual.status,503);assert.equal(held().some(e=>e.requestId==='req-held-dual'),false,'the stated limitation: both down loses this one Event, never the answer');assert.deepEqual(orphans(),[]);}

console.log('Catalog-held start (AIR-575): one neutral Event per refused request on the gate, preflight and lease paths, replay is one item, another request id is another, dry run / 409 / already_running / success write none, journal outage recovered by the outbox, no run, lease or queue change');
