// AIR-553 / ADR 0194: the real Worker with the auxiliary prediction state (held stage, run sources, persisted manifest, event outbox) in D1, over a sqlite D1 stand-in and an in-memory R2.
// The marker `prediction_aux_authority` decides: `r2` (the production default) runs today's R2 code unchanged; `d1` serves the four families from D1 only; an unavailable authority fails closed and
// never reads or writes an R2 object. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const AUX_R2=k=>k.startsWith('enrichment/sources/')||k.startsWith('enrichment/batch-manifest/')||k==='enrichment/batch-stage.json'||k.startsWith('enrichment/stop-events/')||k.startsWith('enrichment/start-events/')||k==='enrichment/event-outbox.json';
const auxKeys=w=>[...w.records.keys()].filter(AUX_R2);
const count=(w,table)=>Number(sql(w.file,'SELECT count(*) AS n FROM '+table)[0].n);
const leaseDoc=w=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const journal=w=>[...w.records.keys()].filter(k=>k.startsWith('events/items/'));
const outbox=w=>sql(w.file,'SELECT event_key AS k, state, attempts, event_json AS j FROM prediction_event_outbox ORDER BY event_key');
const stepStub={do:async(name,config,fn)=>fn()};

// ---- 1. The marker at r2 (the production default): today's R2 objects, nothing in the auxiliary tables ----
{
 const w=await flowWorld({films:6,aux:'r2'});
 const {start}=await w.reconcileAndStart({manifestSize:3});
 assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 assert.ok(w.records.has('enrichment/sources/'+start.data.runId+'.json'),'the source is still an R2 object');
 assert.ok(w.records.has('enrichment/batch-manifest/'+start.data.runId+'.json'),'and so is the manifest');
 for(const table of ['prediction_batch_stage','prediction_run_source_head','prediction_run_manifest','prediction_event_outbox'])assert.equal(count(w,table),0,table+' stays empty');
 const done=await w.api('complete',{runId:start.data.runId,reason:'external_termination'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 assert.ok(w.records.has('enrichment/stop-events/'+start.data.runId+'.json'),'the stop record is an R2 object at r2');
 assert.equal(count(w,'prediction_event_outbox'),0);
}

// ---- 2. The marker at d1: sources, manifest and outbox in D1 only; no R2 object of those families ----
{
 const w=await flowWorld({films:8,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:4});
 assert.equal(start.status,200,JSON.stringify(start.data).slice(0,300));
 const runId=start.data.runId;
 assert.deepEqual(auxKeys(w),[],'no R2 object of the auxiliary families');
 assert.equal(count(w,'prediction_run_source_head'),1);assert.equal(count(w,'prediction_run_manifest'),1);
 const row=sql(w.file,"SELECT manifest_hash AS h, selected_ids AS ids FROM prediction_run_manifest WHERE run_id='"+runId+"'")[0];
 assert.equal(row.h,start.data.manifestHash,'the external manifestHash is unchanged');assert.deepEqual(JSON.parse(row.ids),start.data.films.map(f=>f.filmId));
 // bounded part readback through the real MCP tool, equal to the start answer
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 const part=async(args)=>{const r=await tool('prediction_batch_manifest',{runId,...args});assert.equal(r.isError,undefined,JSON.stringify(r).slice(0,300));return JSON.parse(r.content[0].text);};
 const envelope=await part({part:'envelope'});
 assert.equal(envelope.kind,'envelope');assert.equal(envelope.manifestHash,start.data.manifestHash);assert.equal(envelope.parts.filter(p=>p.kind==='film').length,start.data.films.length);
 assert.deepEqual((await part({part:'profile'})).profile,start.data.profile);assert.deepEqual((await part({part:'contract'})).contract,start.data.contract);
 const first=start.data.films[0];assert.deepEqual((await part({part:'film',filmId:first.filmId})).film,first);
 // submit one film, then hold the next two (the stage in D1), replay and a conflicting digest
 const paired=await w.pair(runId);assert.equal(paired.submit.status,200,JSON.stringify(paired.submit.data).slice(0,300));
 const left=start.data.films.slice(1,3).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
 const hold=await w.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:left});assert.equal(hold.status,200,JSON.stringify(hold.data).slice(0,300));
 assert.deepEqual(hold.data.filmIds.sort(),left.map(i=>i.filmId).sort());
 assert.equal(count(w,'prediction_batch_stage'),2);assert.deepEqual(auxKeys(w),[],'the stage is not an R2 object');
 const head=sql(w.file,'SELECT item_count AS n, total_bytes AS b FROM prediction_batch_stage_head')[0];assert.equal(head.n,2);assert.ok(head.b>0&&head.b<=57344);
 const replay=await w.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:left});assert.equal(replay.status,200);assert.deepEqual(replay.data.replayed.sort(),left.map(i=>i.filmId).sort());assert.equal(count(w,'prediction_batch_stage'),2);
 const conflict=await w.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:[{...left[0],prediction:{...w.prediction,predictedRating:1}}]});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'hold_conflict');
 const hp=await part({part:'hold'});assert.deepEqual(hp.filmIds.sort(),left.map(i=>i.filmId).sort(),'the live hold read comes from the stage, not from the manifest');
 // a hold with the wrong epoch writes nothing
 const wrong=await w.api('batch/hold',{runId,epoch:start.data.lease.epoch+1,items:[{filmId:start.data.films[3].filmId,prediction:w.prediction,fingerprint:w.fingerprint}]});assert.equal(wrong.status,409);assert.equal(count(w,'prediction_batch_stage'),2);
 // completion parks ONE terminal Event in D1 and delivers it to the (R2) journal
 const done=await w.api('complete',{runId,reason:'external_termination'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,300));
 const rows=outbox(w);assert.deepEqual(rows.map(r=>r.k),['stop:'+runId]);assert.equal(rows[0].state,'delivered');assert.equal(journal(w).length,1,'one journal item');
 assert.deepEqual(auxKeys(w),[],'still no R2 object of the families');
 // the held films stay for the next run to drain (transferable)
 assert.equal(count(w,'prediction_batch_stage'),2);
 // the next start drains the stage under its own lease without new model work, and the source gets a second revision for a drained film outside the manifest
 const seen=[];w.hooks.write=statements=>{seen.push(statements.map(item=>item.text));};
 const next=await w.reconcileAndStart({manifestSize:2});assert.equal(next.start.status,200,JSON.stringify(next.start.data).slice(0,300));
 w.hooks.write=null;
 const settled=seen.filter(batch=>batch.some(t=>/INSERT INTO prediction_pointer/.test(t))&&batch.some(t=>/DELETE FROM prediction_batch_stage WHERE film_id/.test(t)));
 assert.ok(settled.length>=1,'a staged row is deleted in the SAME batch as the film prediction it settles');
 assert.ok(settled.every(batch=>batch.some(t=>/prediction_aux_cas/.test(t))&&batch.some(t=>/prediction_domain_cas/.test(t))),'under the same guards');
 assert.ok(next.start.data.drained,'the held films were drained');assert.equal(count(w,'prediction_batch_stage'),0);
 const stored=sql(w.file,"SELECT drained_json AS d FROM prediction_run_manifest WHERE run_id='"+next.start.data.runId+"'")[0];assert.ok(stored.d&&JSON.parse(stored.d).committed>=1,'the drained metadata is part of the exact persisted response');
}

// ---- 3. Skipped events from a request without the lease; a journal outage never changes the answer; the outbox recovers it ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:2});assert.equal(start.status,200);
 const real=w.env.BUCKET.put;let fail=true;
 w.env.BUCKET.put=async(key,...rest)=>{if(fail&&key.startsWith('events/items/'))throw new Error('journal outage');return real(key,...rest);};
 const rival=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100}});
 assert.equal(rival.data.status,'already_running','the refusal answer is unchanged by the outage');
 const skipped=outbox(w).filter(r=>r.k.startsWith('skipped:'));assert.equal(skipped.length,1,'one neutral record');assert.equal(skipped[0].state,'pending');assert.equal(journal(w).length,0);
 assert.equal(count(w,'prediction_run'),1,'a turned-away request touches no run');assert.equal(leaseDoc(w).runId,start.data.runId,'and no lease');
 // the outage ends; the next authorized start (after the first run is released) delivers it once
 fail=false;
 await w.api('complete',{runId:start.data.runId,reason:'external_termination'});
 const again=await w.reconcileAndStart({manifestSize:2});assert.equal(again.start.status,200,JSON.stringify(again.start.data).slice(0,200));
 const after=outbox(w);assert.ok(after.every(r=>r.state==='delivered'),JSON.stringify(after.map(r=>[r.k,r.state])));
 assert.equal(journal(w).length,2,'the stop and the skipped Event, each once');
 assert.deepEqual(auxKeys(w),[]);
}

// ---- 4. An unavailable authority fails closed: no R2 fallback, no R2 write ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 sql(w.file,'DROP TABLE prediction_event_outbox_diag');
 const before=[...w.records.keys()].sort().join('|');
 const {start}=await w.reconcileAndStart({manifestSize:2});
 assert.ok(start.status>=500||start.data.status==='blocked',JSON.stringify(start.data).slice(0,300));
 assert.deepEqual(auxKeys(w),[],'an unavailable authority never writes an R2 auxiliary object');
 assert.equal(count(w,'prediction_run_manifest'),0);
 void before;
}

// ---- 5. Deferred start: manifest rows and readiness in ONE guarded batch ----
const deferred=async()=>{
 const w=await flowWorld({films:6,aux:'d1'});await w.api('queue/reconcile',{});
 w.instances=[];w.env.PREDICTION_START_WORKFLOW={async create({id,params}){w.instances.push({id,params});return {id};},async get(id){if(w.instances.some(item=>item.id===id))return {id};throw new Error('instance.not_found');}};
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 const issued=await w.tool('prediction_batch_key',{});const key=JSON.parse(issued.content[0].text).invocationKey;
 const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:3,deferred:true,invocationKey:key});
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));w.runId=r.data.runId;
 w.prepare=()=>w.ctx.runPredictionStartWorkflow(w.env,w.instances[0].params,stepStub);
 return w;
};
{
 const w=await deferred();
 const outcome=await w.prepare();
 assert.notEqual(outcome?.phase,'failed',JSON.stringify(outcome).slice(0,300));
 const lease=leaseDoc(w);assert.equal(lease.prep,undefined,'the preparation mark is gone');assert.equal(lease.submitGate,undefined);
 assert.equal(count(w,'prediction_run_manifest'),1,'the manifest is durable by the time of readiness');
 assert.deepEqual(auxKeys(w),[]);
 const read=await w.tool('prediction_batch_manifest',{runId:w.runId,part:'envelope'});assert.equal(JSON.parse(read.content[0].text).kind,'envelope');
}
{
 // a stale instance: another holder takes the gate right before the ready batch; neither the manifest nor readiness lands, and the lease is not released
 const w=await deferred();
 w.hooks.write=statements=>{
  if(!statements.some(item=>/INSERT INTO prediction_run_manifest\b/.test(item.text)))return;
  w.hooks.write=null;
  const lease=leaseDoc(w);sql(w.file,"UPDATE prediction_lease SET document_json='"+JSON.stringify({...lease,submitGate:{...lease.submitGate,token:'someone-else'}})+"' WHERE name='runner'");
 };
 await w.prepare();
 assert.equal(count(w,'prediction_run_manifest'),0,'no manifest from a stale instance');assert.equal(count(w,'prediction_run_manifest_piece'),0);
 const lease=leaseDoc(w);assert.equal(lease.submitGate?.token,'someone-else','the foreign gate is untouched');
}
{
 // a legitimate client heartbeat between the read and the batch: the batch fails closed, re-reads, and lands with the acknowledgement and its expiry preserved
 const w=await deferred();
 const ack=Date.now()+14*60000;
 w.hooks.write=statements=>{
  if(!statements.some(item=>/INSERT INTO prediction_run_manifest\b/.test(item.text)))return;
  w.hooks.write=null;
  const lease=leaseDoc(w);
  sql(w.file,"UPDATE prediction_lease SET token='hb-token', expires_at="+ack+", document_json='"+JSON.stringify({...lease,clientAckAt:new Date().toISOString(),expiresAt:ack})+"' WHERE name='runner'");
  sql(w.file,'UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1');
 };
 await w.prepare();
 const lease=leaseDoc(w);
 assert.equal(count(w,'prediction_run_manifest'),1,'the manifest landed after the re-read');assert.equal(lease.prep,undefined);assert.ok(lease.clientAckAt,'the acknowledgement is preserved');assert.equal(lease.expiresAt,ack,'and so is its expiry');
}

// ---- 6. Fault matrix of the outbox: acknowledgement failure, concurrent identity, bounded drain to quarantine, recovery supersedes ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:2});assert.equal(start.status,200);
 // the journal answers but the acknowledgement (the settle batch) is lost: the row stays pending, a replay rewrites the same journal item and then settles it; nothing duplicates
 let failSettle=true;const seenSettle=[];
 w.hooks.write=statements=>{if(failSettle&&statements.some(item=>/UPDATE prediction_event_outbox SET state=/.test(item.text))){seenSettle.push(1);throw new Error('D1 unavailable for the acknowledgement');}};
 const done=await w.api('complete',{runId:start.data.runId,reason:'external_termination'});
 assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));assert.equal(done.data.eventPending,true,'the caller learns the event is pending');
 assert.equal(outbox(w)[0].state,'pending');assert.equal(journal(w).length,1,'the journal item exists although the acknowledgement was lost');
 failSettle=false;w.hooks.write=null;
 const again=await w.reconcileAndStart({manifestSize:2});assert.equal(again.start.status,200);
 assert.equal(outbox(w).find(r=>r.k==='stop:'+start.data.runId).state,'delivered');assert.equal(journal(w).length,1,'a replay never duplicates the journal item');
}
{
 // the same request identity admitted twice at once is ONE row (the loser owns no lease); a distinct identity is another row
 const w=await flowWorld({films:4,aux:'d1'});
 const Aux=await import('../src/prediction-aux-d1.js');
 const event=id=>({id:'enrichment-skipped-'+id,type:'enrichment',at:'2026-11-22T10:00:00.000Z',stage:'skipped'});
 const admit=id=>Aux.admitOutbox(w.db,{mode:'d1',generation:1},{kind:'skipped',identity:id,event:event(id),journalKey:'events/items/'+id+'.json'});
 const [a,b,c]=await Promise.all([admit('same'),admit('same'),admit('other')]);
 assert.equal(Number(sql(w.file,"SELECT count(*) AS n FROM prediction_event_outbox WHERE event_key='skipped:same'")[0].n),1,'two identical requests resolve to ONE row in the database');assert.equal(count(w,'prediction_event_outbox'),2);
 assert.equal(a.row.at,b.row.at,'both see the first `at`');assert.equal(a.row.journalKey,b.row.journalKey);assert.ok(c.row);
}
{
 // a delivery that keeps failing is counted per start, quarantined at the 8th attempt, visible in status, and never starves a later event
 const w=await flowWorld({films:6,aux:'d1'});
 const Aux=await import('../src/prediction-aux-d1.js');
 const real=w.env.BUCKET.put;let down=true;
 w.env.BUCKET.put=async(key,...rest)=>{if(down&&key.startsWith('events/items/'))throw new Error('journal outage');return real(key,...rest);};
 const first=await w.reconcileAndStart({manifestSize:1});assert.equal(first.start.status,200);
 await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100}});
 assert.equal(outbox(w).filter(r=>r.k.startsWith('skipped:')).length,1);
 await w.api('complete',{runId:first.start.data.runId,reason:'external_termination'});
 for(let i=0;i<9;i++){const s=await w.reconcileAndStart({manifestSize:1});if(s.start.status===200)await w.api('complete',{runId:s.start.data.runId,reason:'external_termination'});}
 const states=Object.fromEntries(outbox(w).map(r=>[r.k,r]));
 const quarantined=Object.values(states).filter(r=>r.state==='quarantined');assert.ok(quarantined.length>=1,'a record that failed eight drains is quarantined: '+JSON.stringify(Object.values(states).map(r=>[r.k,r.state,r.attempts])));
 assert.ok(quarantined.every(r=>r.attempts>=8));
 const status=await Aux.outboxStatus(w.db);assert.ok(status.states.quarantined>=1,'quarantine is visible');
 down=false;
 const later=await w.reconcileAndStart({manifestSize:1});assert.equal(later.start.status,200);
 await w.api('complete',{runId:later.start.data.runId,reason:'external_termination'});
 const last=outbox(w).find(r=>r.k==='stop:'+later.start.data.runId);assert.equal(last.state,'delivered','quarantined rows never take a slot: a later event is delivered');
 assert.ok(outbox(w).filter(r=>r.state==='quarantined').every(r=>r.j),'quarantined rows keep their payload');
}
{
 // an expired predecessor is recovered under the current writer; its pending stop is superseded, never delivered twice
 const w=await flowWorld({films:6,aux:'d1'});
 const first=await w.reconcileAndStart({manifestSize:2});assert.equal(first.start.status,200);
 sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1) WHERE name='runner'");
 const second=await w.reconcileAndStart({manifestSize:2});assert.equal(second.start.status,200,JSON.stringify(second.start.data).slice(0,200));
 assert.notEqual(second.start.data.runId,first.start.data.runId);
 const rows=outbox(w).filter(r=>r.k==='stop:'+first.start.data.runId);assert.ok(rows.length<=1);
 assert.ok(rows.every(r=>r.state==='superseded'||r.state==='delivered'),'the predecessor has no live pending stop: '+JSON.stringify(rows.map(r=>r.state)));
 assert.deepEqual(auxKeys(w),[]);
}
// ---- 7. A stale holder cannot write the stage: an expired lease at the hold fails closed ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:3});assert.equal(start.status,200);
 const item=start.data.films[0];
 sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1) WHERE name='runner'");
 const hold=await w.api('batch/hold',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:item.filmId,...(item.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}]});
 assert.ok(hold.status>=400,'a hold under an expired lease is refused: '+hold.status);assert.equal(count(w,'prediction_batch_stage'),0);
}
// ---- 8. Reads are pure: the manifest part, the hold part and the status write nothing ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:3});assert.equal(start.status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 const snapshot=JSON.stringify(tables_(w)),keys=[...w.records.keys()].sort().join('|');
 for(const part of ['envelope','profile','contract','hold'])await tool('prediction_batch_manifest',{runId:start.data.runId,part});
 await tool('prediction_batch_manifest',{runId:start.data.runId,part:'film',filmId:start.data.films[0].filmId});
 assert.equal(JSON.stringify(tables_(w)),snapshot,'a read writes no aux row');assert.equal([...w.records.keys()].sort().join('|'),keys,'and no R2 object');
}
function tables_(w){return ['prediction_batch_stage','prediction_batch_stage_head','prediction_run_source_head','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox','prediction_event_outbox_counter','prediction_event_outbox_diag','prediction_aux_authority'].map(t=>sql(w.file,'SELECT * FROM '+t));}
console.log('prediction aux worker: ok');
