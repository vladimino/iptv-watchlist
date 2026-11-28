// ADR 0196 (amends ADR 0194 decision 1): the admission gate `closed` of the auxiliary prediction state, over the real migrations (a sqlite D1 stand-in) and the real Worker code with an in-memory R2.
// Local stand-ins only; no Cloudflare, no production, no Task, no model.
import assert from 'node:assert/strict';
import {migrationHead} from './migration-head.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {migrated,sql,flowWorld} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {withTaskId} from './prediction-task-id-lib.mjs';
import * as Aux from '../src/prediction-aux-d1.js';

const stamp='2026-11-22T10:00:00.000Z';
const AUX_R2=k=>k.startsWith('enrichment/sources/')||k.startsWith('enrichment/batch-manifest/')||k==='enrichment/batch-stage.json'||k.startsWith('enrichment/stop-events/')||k.startsWith('enrichment/start-events/')||k==='enrichment/event-outbox.json';
const auxKeys=w=>[...w.records.keys()].filter(AUX_R2).sort();
const count=(w,table)=>Number(sql(w.file,'SELECT count(*) AS n FROM '+table)[0].n);
const marker=file=>sql(file,'SELECT mode, generation, activated_at AS at FROM prediction_aux_authority WHERE id=1')[0];
const refuses=async(code,work)=>{try{await work();}catch(error){assert.equal(error.code??error.message,code);return error;}assert.fail('expected '+code);};
const attempt=(file,text)=>{try{sql(file,text);return 'ok';}catch(error){return String(error.message);}};

// ---- 1. The schema: r2 -> closed -> d1, closed -> r2 before an activation, nothing out of d1; every change of mode raises the generation ----
{
 const file=migrated();
 assert.deepEqual({...marker(file)},{mode:'r2',generation:0,at:null},'the inserted marker is r2, generation 0');
 assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='d1', generation=1, activated_at='"+stamp+"'"),/prediction_aux_authority_chain/,'an activation cannot skip the close: d1 only from closed');
 assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='closed'"),/prediction_aux_authority_chain/,'a change of mode must raise the generation');
 assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='nope', generation=1"),/CHECK constraint|prediction_aux_authority/,'an unknown mode is refused');
 assert.equal(attempt(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1"),'ok','r2 -> closed');
 assert.equal(attempt(file,"UPDATE prediction_aux_authority SET mode='r2', generation=2"),'ok','closed -> r2 (the reopen) raises the generation');
 assert.equal(attempt(file,"UPDATE prediction_aux_authority SET mode='closed', generation=3"),'ok');
 assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='d1', generation=3, activated_at='"+stamp+"'"),/prediction_aux_authority_chain/,'the activation raises the generation too');
 assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='d1', generation=4"),/CHECK constraint/,'d1 carries activated_at');
 assert.equal(attempt(file,"UPDATE prediction_aux_authority SET mode='d1', generation=4, activated_at='"+stamp+"'"),'ok','closed -> d1');
 for(const to of ['closed','r2'])assert.match(attempt(file,"UPDATE prediction_aux_authority SET mode='"+to+"', generation=5, activated_at=NULL"),/prediction_aux_authority_(one_way|chain)/,'d1 -> '+to+' is refused');
 assert.match(attempt(file,'DELETE FROM prediction_aux_authority'),/prediction_aux_authority_keep/);
}

// ---- 2. The authority reads closed; the gate before an R2 PUT; an unavailable marker is never r2 ----
{
 const open=(mode,generation)=>{const file=migrated();sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");if(mode!=='r2'){sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");if(mode==='d1')sql(file,"UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='"+stamp+"'");}return {file,db:d1Standin(file,{})};};
 const env={PREDICTION_DB_REQUIRED:'on'};
 const r2=open('r2'),closed=open('closed'),d1=open('d1');
 assert.deepEqual({...await Aux.readAuxAuthority(closed.db,env)},{mode:'closed',proof:'closed',installed:true,generation:1,version:migrationHead(),ready:false},'closed reads closed, not r2, not unavailable, not ready');
 assert.equal(Aux.auxClosed(await Aux.readAuxAuthority(closed.db,env)),true);assert.equal(Aux.auxClosed(await Aux.readAuxAuthority(r2.db,env)),false);assert.equal(Aux.auxClosed(await Aux.readAuxAuthority(d1.db,env)),false);
 assert.equal(await Aux.auxD1(closed.db,env),null,'closed gives no D1 branch: the R2 objects are still the data');
 assert.equal((await Aux.guardR2Write(r2.db,env)).proof,'explicit_r2','the gate lets an r2 write through');
 assert.equal((await refuses('prediction_aux_closed',()=>Aux.guardR2Write(closed.db,env))).detail,'closed','a closed marker refuses before the PUT');
 assert.equal((await refuses('prediction_aux_closed',()=>Aux.guardR2Write(d1.db,env))).detail,'d1','after d1 the Worker never writes these objects again');
 // the gate reads the marker FRESH: a request-scoped copy of an earlier read does not let it through
 const scoped=r2.db;const before=await Aux.readAuxAuthority(scoped,env);assert.equal(before.mode,'r2');
 sql(r2.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");
 await refuses('prediction_aux_closed',()=>Aux.guardR2Write(scoped,env));
 // proved not installed (schema below 0034) passes without asking for a table; an error, a partial table set and a missing row refuse and never read as r2
 assert.equal((await Aux.guardR2Write(d1Standin(migrated(33),{}),env)).proof,'not_installed');
 await refuses('prediction_aux_unavailable',()=>Aux.guardR2Write({prepare(){throw new Error('down');}},env));
 const partial=migrated();sql(partial,'DROP TRIGGER prediction_aux_authority_chain');sql(partial,'DROP TABLE prediction_event_outbox_diag');
 await refuses('prediction_aux_unavailable',()=>Aux.guardR2Write(d1Standin(partial,{}),env));
 assert.equal((await Aux.guardR2Write(null,{})).proof,'not_installed');await refuses('prediction_aux_unavailable',()=>Aux.guardR2Write(null,env));
}

// ---- 3. The Worker at closed: every entry that would write one of the families is refused before it starts; reads and heartbeats still answer; nothing is written anywhere ----
{
 const w=await flowWorld({films:8,aux:'r2'});
 // A labelled run (ADR 0195 of the Task labels): the MCP readback sends the same label, as the standing Task does.
 const {start}=await w.reconcileAndStart({manifestSize:4,trigger:'scheduled',taskId:'task00'});
 assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 const runId=start.data.runId,epoch=start.data.lease.epoch;
 const filmId=start.data.films[0].filmId;
 assert.ok(auxKeys(w).includes('enrichment/sources/'+runId+'.json'),'at r2 the families are R2 objects');
 sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");
 const r2Before=JSON.stringify([...w.records.entries()]),d1Before=JSON.stringify([count(w,'prediction_run'),count(w,'prediction_event_outbox'),count(w,'prediction_batch_stage'),sql(w.file,'SELECT document_json AS d FROM prediction_lease ORDER BY name').map(r=>r.d)]);
 const refusedAnswer=(answer)=>{assert.equal(answer.status,503,JSON.stringify(answer.data).slice(0,200));assert.equal(answer.data.code,'prediction_aux_closed');assert.equal(answer.data.reason,'prediction_aux_closed');assert.equal(answer.data.retryable,false);};
 refusedAnswer(await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},manifestSize:2}));
 refusedAnswer(await w.api('batch/hold',{runId,epoch,items:[{filmId,fingerprint:w.fingerprint,prediction:w.prediction}]}));
 refusedAnswer(await w.api('batch/submit',{runId,epoch,items:[{filmId,fingerprint:w.fingerprint,prediction:w.prediction}]}));
 refusedAnswer(await w.api('complete',{runId,reason:'external_termination'}));
 assert.equal(JSON.stringify([...w.records.entries()]),r2Before,'a refused entry changes no R2 object');
 assert.equal(JSON.stringify([count(w,'prediction_run'),count(w,'prediction_event_outbox'),count(w,'prediction_batch_stage'),sql(w.file,'SELECT document_json AS d FROM prediction_lease ORDER BY name').map(r=>r.d)]),d1Before,'and no D1 row, lease or run');
 // a dry run writes nothing and is not refused by the gate; the heartbeat only renews the lease and is not refused either
 const dry=await w.api('batch/submit',{runId,epoch,dryRun:true,items:[{filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.notEqual(dry.data?.code,'prediction_aux_closed');
 const beat=await w.api('heartbeat',{runId,epoch});assert.notEqual(beat.data?.code,'prediction_aux_closed');
 // the reads: the manifest part of the run prepared before the close is still served, from the R2 object that is still the data
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.ctx.__a={name:'prediction_batch_manifest',args:withTaskId('prediction_batch_manifest',{runId,part:'envelope'})};w.ctx.__env=w.env;
 const read=(await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;
 assert.equal(read.isError,undefined,JSON.stringify(read).slice(0,300));assert.equal(JSON.parse(read.content[0].text).manifestHash,start.data.manifestHash,'a closed marker serves the read from R2');
 // the reopen: the same marker back at r2 (a higher generation) admits the writers again with no change of data
 sql(w.file,"UPDATE prediction_aux_authority SET mode='r2', generation=2");
 const done=await w.api('complete',{runId,reason:'external_termination'});assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 assert.ok(auxKeys(w).includes('enrichment/stop-events/'+runId+'.json'),'after the reopen the stop record is an R2 object again');
}

// ---- 4. A request that read r2 at its start still refuses at its own write: the bucket it holds re-reads the marker before the PUT ----
{
 const w=await flowWorld({films:8,aux:'r2'});
 const base=await w.api('queue/reconcile',{});assert.equal(base.status,200);
 let flipped=false;
 // The marker moves to closed in the middle of the start: after the lease is taken (the first D1 write) and before the source object is put (R2; a start writes it before the run row).
 w.hooks.write=statements=>{if(!flipped&&statements.some(item=>/prediction_lease/.test(item.text))){flipped=true;sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");}};
 const answer=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},manifestSize:3});
 assert.equal(flipped,true,'the marker moved during the request');
 assert.notEqual(answer.status,200,'the start does not complete: its own write was refused');
 assert.deepEqual(auxKeys(w),[],'no R2 object of the four families was written after the close');
}

// ---- 5. The residual, stated by a test: a PUT already past the gate lands, and is DETECTABLE by the listing of the families (the cutover operator refuses the flip on any such change) ----
{
 const w=await flowWorld({films:8,aux:'r2'});
 const base=await w.api('queue/reconcile',{});assert.equal(base.status,200);
 const put=w.env.BUCKET.put;let release=null,reached=null;const waiting=new Promise(resolve=>{reached=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 w.env.BUCKET.put=async(key,...rest)=>{if(key.startsWith('enrichment/sources/')){reached();await gate;}return put(key,...rest);};
 const inFlight=w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},manifestSize:3});
 await waiting;
 const closedListing=auxKeys(w);assert.deepEqual(closedListing,[],'nothing of the families is stored while the PUT is in flight');
 sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");
 release();await inFlight;
 const after=auxKeys(w);
 assert.ok(after.some(key=>key.startsWith('enrichment/sources/')),'a PUT that passed the gate before the close does land: the gate cannot recall it');
 assert.notDeepEqual(after,closedListing,'the landing changes the listing of the families, so a listing taken at the close and again later detects it');
 // a request that starts after the close is refused at the entry, so no further object follows
 const late=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},manifestSize:2});assert.equal(late.status,503);
 assert.deepEqual(auxKeys(w),after,'after the close only the request already in flight could land');
}

// ---- 5a. (review of #893, P2) The identity that is compared at a boundary is (key, ETag, size), not the key set: a late PUT that REWRITES an existing object keeps every key name ----
{
 const w=await flowWorld({films:8,aux:'r2'});
 const {start}=await w.reconcileAndStart({manifestSize:4});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 const runId=start.data.runId,epoch=start.data.lease.epoch;
 const items=n=>start.data.films.slice(n,n+1).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
 assert.equal((await w.api('batch/hold',{runId,epoch,items:items(0)})).status,200,'a first hold creates the stage object');
 // an existing outbox index object (a pending skipped record), so there is a second pre-existing family object besides the stage
 await w.env.BUCKET.put('enrichment/event-outbox.json',JSON.stringify({pending:{'enrichment/stop-events/skipped-aaaaaaaa.json':{since:'2026-11-22T10:00:00.000Z',attempts:0,lastAttemptAt:null,quarantined:false}}}));
 const inventory=async()=>{const out=[];for(const key of auxKeys(w)){const object=await w.env.BUCKET.get(key);out.push({key,etag:object.etag,size:object.size});}return out;};
 const names=list=>list.map(item=>item.key).sort();
 const atClose=await inventory();
 assert.ok(atClose.some(i=>i.key==='enrichment/batch-stage.json')&&atClose.some(i=>i.key==='enrichment/event-outbox.json'),'both rewritten-in-place families exist before the close');
 assert.equal(Aux.auxFlipRefusal(atClose,await inventory()),null,'an unchanged inventory does not refuse the flip');
 sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");
 // (1) a PUT already past the gate rewrites the stage: the second hold is paused at its stage PUT, the marker closes, the PUT lands
 const put=w.env.BUCKET.put;let release=null,reached=null;const waiting=new Promise(resolve=>{reached=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 w.env.BUCKET.put=async(key,...rest)=>{if(key==='enrichment/batch-stage.json'&&release){reached();await gate;}return put(key,...rest);};
 sql(w.file,"UPDATE prediction_aux_authority SET mode='r2', generation=2");   // the second hold is admitted at r2 (before the close) ...
 const held=w.api('batch/hold',{runId,epoch,items:items(1)});
 await waiting;
 sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=3");   // ... and the marker closes while its stage PUT is in flight
 const closedInventory=await inventory();
 release();assert.equal((await held).status,200,'the in-flight hold completes: the gate cannot recall a PUT past its read');
 w.env.BUCKET.put=put;
 const afterLanding=await inventory();
 assert.deepEqual(names(afterLanding),names(closedInventory),'the key NAMES are unchanged: a key-set comparison would call this stable');
 const refusal=Aux.auxFlipRefusal(closedInventory,afterLanding);
 assert.ok(refusal,'the identity comparison sees the rewrite');assert.equal(refusal.code,'prediction_aux_listing_changed');assert.deepEqual(refusal.changed,['enrichment/batch-stage.json']);assert.deepEqual(refusal.added,[]);
 // (2) the same SIZE, different bytes, in an existing object: the ETag still differs
 const outbox=JSON.stringify(w.records.get('enrichment/event-outbox.json')),flipped=outbox.replace('"attempts":0','"attempts":1');assert.equal(flipped.length,outbox.length);assert.notEqual(flipped,outbox);
 const before=await inventory();
 await put('enrichment/event-outbox.json',flipped);
 const after=await inventory();
 assert.equal(after.find(i=>i.key==='enrichment/event-outbox.json').size,before.find(i=>i.key==='enrichment/event-outbox.json').size,'same size');
 assert.deepEqual(Aux.auxFlipRefusal(before,after).changed,['enrichment/event-outbox.json'],'a same-size rewrite is still a different object (ETag)');
 // (3) a removed object and an object added are refused too; a malformed or duplicated listing is never read as unchanged
 assert.deepEqual(Aux.auxFlipRefusal(before,before.slice(1)).removed,[before[0].key]);
 assert.equal(Aux.auxFlipRefusal(before,[...before,{key:'enrichment/sources/new.json',etag:'e9',size:3}]).added[0],'enrichment/sources/new.json');
 assert.throws(()=>Aux.auxFlipRefusal(before,[{key:'k',etag:'e'}]),error=>error.code==='prediction_aux_listing_invalid');
 assert.throws(()=>Aux.auxFlipRefusal(before,[...before,before[0]]),error=>error.code==='prediction_aux_listing_invalid');
 assert.throws(()=>Aux.auxFlipRefusal(before,null),error=>error.code==='prediction_aux_listing_invalid');
}

// ---- 5b. (review of #893, P1) A request that read SCHEMA 33 must not carry that negative proof to its PUT: migration 0034 is installed and the marker closed while the request is still running ----
{
 const w=await flowWorld({films:8,aux:'r2',schema:33});
 const {start}=await w.reconcileAndStart({manifestSize:3});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 const before=auxKeys(w).map(key=>key+'|'+JSON.stringify(w.records.get(key)).length).sort();
 assert.ok(before.length>0,'at schema 33 the legacy start wrote its R2 objects');
 assert.equal(sql(w.file,"SELECT count(*) AS n FROM sqlite_master WHERE name='prediction_aux_authority'")[0].n,0,'the aux tables are not installed yet');
 // A lease-free path with no D1 write before its R2 write (a skipped start refused by the live lease): the schema is read as 33 at the entry; 0034 is installed and the marker closed
 // exactly when the request reads its (absent) skipped record, i.e. just before its first PUT. Nothing in between writes D1, so the request scope is never invalidated.
 let installed=false;
 const get=w.env.BUCKET.get;
 w.env.BUCKET.get=async(key,...rest)=>{
  if(!installed&&key.startsWith('enrichment/stop-events/skipped-')){installed=true;sql(w.file,fs.readFileSync('migrations/0034_prediction_aux_authority.sql','utf8'));sql(w.file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");sql(w.file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");}
  return get(key,...rest);
 };
 const rival=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',taskId:'task15',capacity:{remainingPercent:100}});
 assert.equal(installed,true,'0034 was installed and the marker closed during the request');
 assert.equal(rival.data.status,'already_running','the refusal answer of the request is unchanged (a failed park never changes it)');
 assert.deepEqual(auxKeys(w).map(key=>key+'|'+JSON.stringify(w.records.get(key)).length).sort(),before,'no R2 object of the families was written or rewritten after the close');
 assert.equal(auxKeys(w).some(key=>key.startsWith('enrichment/stop-events/skipped-')),false,'the skipped record was refused at its PUT');
}

// ---- 6. At d1 nothing of the families is written to R2 even by a caller that still holds an r2 branch (defence in depth) ----
{
 const w=await flowWorld({films:6,aux:'d1'});
 const {start}=await w.reconcileAndStart({manifestSize:3});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
 assert.deepEqual(auxKeys(w),[],'at d1 the whole start wrote no R2 object of the families');
}
console.log('prediction aux closed: ok');
