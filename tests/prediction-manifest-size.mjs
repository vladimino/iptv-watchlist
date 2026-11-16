// AIR-463 / ADR 0136: client-configurable manifestSize on prediction_batch_start, and normal prediction_complete
// with reason manifest_spent when every selected manifest film is settled while the global queue still has ready films.
// Offline: sqlite D1 stand-in and in-memory R2. No Cloudflare, model, TMDB, Scheduled Task or production call.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const sha=async text=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
function counted(w){const counts={put:0,delete:0},put=w.env.BUCKET.put.bind(w.env.BUCKET),del=w.env.BUCKET.delete.bind(w.env.BUCKET);w.env.BUCKET.put=async(...a)=>{counts.put++;return put(...a);};w.env.BUCKET.delete=async(...a)=>{counts.delete++;return del(...a);};return counts;}
const state=async w=>({d1:await sha(dump(w.file)),keys:[...w.records.keys()].sort().join('|')+'#'+await sha(JSON.stringify([...w.records.entries()].sort()))});
const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const ready=async(films,opts={})=>{const w=await flowWorld({films,...opts});return w;};
const reconcile=async w=>{const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));return r;};
const submitAll=async(w,manifest)=>{
 let epoch=manifest.lease.epoch;
 for(let i=0;i<manifest.films.length;i+=10){
  const items=manifest.films.slice(i,i+10).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}));
  const r=await w.api('batch/submit',{runId:manifest.runId,epoch,items});
  assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
  epoch=r.data.epoch||epoch;
 }
 return epoch;
};

// 1. Invalid manifestSize: 400, zero writes. Omitted / 1 / 5 / 10 / 100 select that many (or fewer when eligible is short).
{
 const w=await ready(40);await reconcile(w);
 const before=await state(w),counts=counted(w),puts=counts.put;
 for(const bad of [0,-1,101,1.5,'5',null,true,{}]){
  const r=await batch(w,{manifestSize:bad});
  assert.equal(r.status,400,String(bad));assert.match(JSON.stringify(r.data),/manifestSize/i);
 }
 assert.deepEqual(await state(w),before);assert.equal(counts.put,puts);
}
for(const [size,films,expected] of [[undefined,40,40],[1,40,1],[5,40,5],[10,40,10],[100,40,40],[5,3,3],[100,130,100]]){
 const w=await ready(films);await reconcile(w);
 const body=size===undefined?{}:{manifestSize:size};
 const r=await batch(w,body);
 assert.equal(r.status,200,size+': '+JSON.stringify(r.data).slice(0,200));
 assert.equal(r.data.films.length,expected);
 assert.equal(r.data.manifestSize,size===undefined?100:size,'requested size echoed');
 assert.equal(r.data.filmsSelected,expected,'actual selected count');
 assert.equal(r.data.limits.maxManifestFilms,100,'server ceiling unchanged');
 assert.equal(r.data.films.length,r.data.filmsSelected);
}

// 2. Same five films → same manifestHash whether requested as 5 or as a pin of those five; next start after a short run takes the next five, not the old five.
{
 const w=await ready(20);await reconcile(w);
 const first=await batch(w,{manifestSize:5});assert.equal(first.status,200);assert.equal(first.data.films.length,5);
 const ids=first.data.films.map(f=>f.filmId);
 const dry=await batch(w,{dryRun:true,manifestSize:5,pin:{filmIds:ids}});
 assert.equal(dry.status,200);assert.equal(dry.data.manifestHash,first.data.manifestHash,'hash depends on the actual films, not how the size was asked');
 await submitAll(w,first.data);
 const done=await w.api('complete',{runId:first.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200,JSON.stringify(done.data).slice(0,300));
 assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'manifest_spent');
 assert.ok((done.data.hotRemaining||0)+(done.data.coldRemaining||0)>0,'global queue still has outstanding films');
 const second=await batch(w,{manifestSize:5});assert.equal(second.status,200);assert.equal(second.data.films.length,5);
 assert.ok(second.data.films.every(f=>!ids.includes(f.filmId)),'the next short run selects the next five, not the spent five');
 assert.notEqual(second.data.manifestHash,first.data.manifestHash);
}

// 3. pin longer than an explicit manifestSize is refused (no silent truncate); default 100 still accepts a 100-film pin.
{
 const w=await ready(12);await reconcile(w);
 const before=await state(w);
 const bad=await batch(w,{dryRun:true,manifestSize:5,pin:{filmIds:['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5','tmdb_6']}});
 assert.equal(bad.status,400);assert.deepEqual(await state(w),before);
 const ok=await batch(w,{dryRun:true,manifestSize:5,pin:{filmIds:['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5']}});
 assert.equal(ok.status,200);assert.equal(ok.data.films.length,5);assert.equal(ok.data.manifestSize,5);
 const big=await ready(100);await reconcile(big);
 const pin100=await batch(big,{dryRun:true,pin:{filmIds:Array.from({length:100},(_,i)=>'tmdb_'+(i+1))}});
 assert.equal(pin100.status,200);assert.equal(pin100.data.films.length,100);assert.equal(pin100.data.manifestSize,100);
}

// 4. Complete after five committed with remaining>0: complete, lease released, durable Event once; replay does not duplicate.
{
 const w=await ready(30);await reconcile(w);
 const start=await batch(w,{manifestSize:5});assert.equal(start.data.films.length,5);
 await submitAll(w,start.data);
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'manifest_spent');
 assert.equal(done.data.stage,'complete');assert.ok(done.data.title!=='Прогнозы приостановлены');
 assert.equal(done.data.selectedCount,5);assert.equal(done.data.manifestSize,5);assert.equal(done.data.protocol,'batch_v2');
 assert.equal(done.data.added+done.data.updated,5);assert.equal(done.data.failed,0);
 assert.ok((done.data.hotRemaining||0)+(done.data.coldRemaining||0)>0,'truthful global outstanding');
 const eventKeys=()=>[...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId);
 assert.equal(eventKeys().length,1,'exactly one persisted completion Event');
 const event=eventKeys()[0][1];
 assert.equal(event.stopReason,'manifest_spent');assert.equal(event.stage,'complete');
 assert.equal(event.selectedCount,5);assert.equal(event.added+event.updated,5);assert.equal(event.failed,0);
 assert.ok((event.hotRemaining||0)+(event.coldRemaining||0)>0);
 // Lease is released (expiresAt 0): the next short start must succeed.
 const next=await batch(w,{manifestSize:5});assert.equal(next.status,200,JSON.stringify(next.data).slice(0,200));assert.equal(next.data.status,'running');
 const again=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(again.status,200);assert.equal(again.data.status,'complete');assert.equal(again.data.stopReason,'manifest_spent');
 assert.equal(again.data.selectedCount,5);assert.equal(again.data.added+again.data.updated,5);
 assert.equal(eventKeys().length,1,'replay does not create a second Event key');
 assert.equal(eventKeys()[0][1].stopReason,'manifest_spent');
 assert.deepEqual({stopReason:eventKeys()[0][1].stopReason,stage:eventKeys()[0][1].stage,selectedCount:eventKeys()[0][1].selectedCount,added:eventKeys()[0][1].added,updated:eventKeys()[0][1].updated,failed:eventKeys()[0][1].failed},{stopReason:event.stopReason,stage:event.stage,selectedCount:event.selectedCount,added:event.added,updated:event.updated,failed:event.failed});
 const stopRec=w.records.get('enrichment/stop-events/'+start.data.runId+'.json');
 assert.ok(!stopRec||stopRec.event?.stage!=='partial','no false paused stop Event');
}

// 4b. Profile or contract drift after the last submit fences manifest_spent (not a false normal complete).
{
 const w=await ready(12);await reconcile(w);
 const start=await batch(w,{manifestSize:3});await submitAll(w,start.data);
 const next={version:2,profileHash:'p2',profile:{ratingScale:'Whole stars'}};
 w.records.set('enrichment/profile/versions/2.json',next);
 await (await import('../src/prediction-d1.js')).saveMutable(w.env,'enrichment/profile/current.json',next);
 const drift=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(drift.status,409);assert.match(String(drift.data.error||''),/Profile changed/);
 assert.ok(![...w.records.entries()].some(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId&&v?.stopReason==='manifest_spent'),'no spent Event after profile drift');
 const systemic=await w.api('complete',{runId:start.data.runId,reason:'profile_changed'});
 assert.equal(systemic.status,200);assert.equal(systemic.data.status,'partial');assert.equal(systemic.data.stopReason,'profile_changed');
}
{
 const w=await ready(8);await reconcile(w);
 const start=await batch(w,{manifestSize:2});await submitAll(w,start.data);
 // Mutate the run's recorded contract binding so complete sees a drift without changing live constants.
 const doc=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+start.data.runId+"'")[0].d);
 doc.predictionPromptVersion=99;
 sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+start.data.runId+"'");
 const drift=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(drift.status,409);assert.equal(drift.data.code,'contract_changed');
 assert.ok(![...w.records.entries()].some(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId&&v?.stopReason==='manifest_spent'),'no spent Event after contract drift');
 const systemic=await w.api('complete',{runId:start.data.runId,reason:'runner_aborted'});
 assert.equal(systemic.status,200);assert.equal(systemic.data.status,'partial');assert.equal(systemic.data.stopReason,'runner_aborted');
}

// 5. Fail closed: unsubmitted slots refuse manifest_spent; reasonless complete still refuses while ready films remain; time_budget stays the old partial path.
{
 const w=await ready(20);await reconcile(w);
 const start=await batch(w,{manifestSize:5});
 const partial=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:start.data.films.slice(0,2).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}))});
 assert.equal(partial.status,200);
 const refused=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(refused.status,409);assert.equal(refused.data.code,'manifest_not_spent');assert.ok(refused.data.unspent.length>=3);
 const reasonless=await w.api('complete',{runId:start.data.runId});
 assert.equal(reasonless.status,409);assert.match(String(reasonless.data.error||''),/Queue not empty/);
 // Finish the remaining three, then time_budget is still the old partial systemic path (clients should use manifest_spent instead).
 let epoch=partial.data.epoch||start.data.lease.epoch;
 const rest=start.data.films.slice(2).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}));
 const fin=await w.api('batch/submit',{runId:start.data.runId,epoch,items:rest});assert.equal(fin.status,200);
 const stop=await w.api('complete',{runId:start.data.runId,reason:'time_budget'});
 assert.equal(stop.status,200);assert.equal(stop.data.status,'partial');assert.equal(stop.data.stopReason,'time_budget');assert.equal(stop.data.title,'Пакет прогнозов прерван');assert.equal(stop.data.presentation,'batch_v2_terminal');
}
{
 // manifest_spent on a v5 run is refused.
 const w=await ready(3);await reconcile(w);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.status,200);
 const pair=await w.pair(v5.data.runId);assert.equal(pair.submit.status,200);
 const bad=await w.api('complete',{runId:v5.data.runId,reason:'manifest_spent'});
 assert.equal(bad.status,400);assert.match(JSON.stringify(bad.data),/batch_v2/);
}

// 6. MCP parity: schema accepts manifestSize; pin over size fails at the tool; complete with manifest_spent works through MCP.
{
 const w=await ready(25);await reconcile(w);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.isError?res.content[0].text:JSON.parse(res.content[0].text)};};
 const badSize=await w.call('prediction_batch_start',{trigger:'scheduled',manifestSize:0});assert.equal(badSize.isError,true);
 const badPin=await w.call('prediction_batch_start',{trigger:'manual',dryRun:true,manifestSize:2,pin:{filmIds:['tmdb_1','tmdb_2','tmdb_3']}});assert.equal(badPin.isError,true);
 const start=await w.call('prediction_batch_start',{trigger:'scheduled',manifestSize:5});assert.ok(!start.isError,JSON.stringify(start.data).slice(0,200));
 assert.equal(start.data.films.length,5);assert.equal(start.data.manifestSize,5);assert.equal(start.data.filmsSelected,5);
 let epoch=start.data.lease.epoch;
 for(let i=0;i<5;i+=5){
  const items=start.data.films.slice(i,i+5).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}));
  const sub=await w.call('prediction_batch_submit',{runId:start.data.runId,epoch,items});assert.ok(!sub.isError);epoch=sub.data.epoch||epoch;
 }
 const done=await w.call('prediction_complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.ok(!done.isError,JSON.stringify(done.data).slice(0,300));
 assert.equal(done.data.status,'complete');assert.equal(done.data.stopReason,'manifest_spent');
}

// 7. AIR-491: batch_v2 emits one terminal Event, never a start or progress Event; idle/already_running write none.
{
 const journal=w=>[...w.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
 const starts=w=>journal(w).filter(e=>String(e.id||'').startsWith('prediction-start-'));
 const progress=w=>journal(w).filter(e=>/-progress-/.test(String(e.id||'')));
 const terminals=w=>journal(w).filter(e=>String(e.id||'').startsWith('enrichment-')&&!/-progress-/.test(e.id));
 const w=await ready(30);await reconcile(w);
 const start=await batch(w,{manifestSize:5});assert.equal(start.status,200);
 assert.equal(starts(w).length,0,'no prediction-start Event for a new batch_v2 run');
 assert.equal(progress(w).length,0);
 assert.equal(w.records.has('enrichment/start-events/'+start.data.runId+'.json'),false);
 const overlapping=await batch(w,{manifestSize:5});assert.equal(overlapping.data.status,'already_running');
 assert.equal(journal(w).length,0,'already_running before a terminal commit writes no Event');
 await submitAll(w,start.data);
 assert.equal(progress(w).length,0,'batch_submit does not write a progress Event');
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);assert.equal(done.data.presentation,'batch_v2_terminal');
 assert.equal(done.data.title,'Пакет прогнозов обработан');
 assert.equal(starts(w).length,0);assert.equal(progress(w).length,0);assert.equal(terminals(w).length,1);
 const event=terminals(w)[0];
 assert.equal(event.presentation,'batch_v2_terminal');assert.equal(event.protocol,'batch_v2');
 assert.equal(event.id,'enrichment-'+start.data.runId);assert.equal(event.stage,'complete');
 assert.equal(event.stopReason,'manifest_spent');assert.equal(event.failed,0);assert.equal(event.selectedCount,5);
 assert.equal(event.details.processed,5);assert.equal(event.details.success.length,5);assert.equal(event.details.failure.length,0);
 assert.equal(event.details.success[0].rating,w.prediction.predictedRating);
 const parked=w.records.get('enrichment/stop-events/'+start.data.runId+'.json');
 assert.equal(parked?.delivered,true);assert.equal(parked.event.presentation,'batch_v2_terminal');
 const again=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(again.status,200);assert.equal(terminals(w).length,1,'replay of complete does not duplicate the journal item');
}

{
 const w=await ready(8);await reconcile(w);
 const start=await batch(w,{manifestSize:5});
 const ok=start.data.films.slice(0,2).map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}));
 const bad=start.data.films.slice(2).map(f=>({filmId:f.filmId,failure:{kind:'parse_error',reason:'json_unparseable'}}));
 const sub=await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[...ok,...bad]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);assert.equal(done.data.status,'complete');assert.equal(done.data.failed,3);assert.equal(done.data.added+done.data.updated,2);
 assert.equal(done.data.title,'Пакет прогнозов обработан с ошибками');
 assert.equal(done.data.presentation,'batch_v2_terminal');
 const event=[...w.records.values()].find(v=>v?.id==='enrichment-'+start.data.runId);
 assert.equal(event.failed,3);assert.equal(event.stage,'complete');assert.notEqual(event.title,'Пакет прогнозов прерван');
}

{
 const w=await ready(6);await reconcile(w);
 const start=await batch(w,{manifestSize:3});
 const item=start.data.films[0];
 await w.api('batch/submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:item.filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});
 const stop=await w.api('complete',{runId:start.data.runId,reason:'quota'});
 assert.equal(stop.status,200);assert.equal(stop.data.status,'partial');
 assert.equal(stop.data.presentation,'batch_v2_terminal');assert.equal(stop.data.title,'Пакет прогнозов прерван');
 assert.equal(stop.data.stopReason,'quota');
 const events=[...w.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
 assert.equal(events.filter(e=>String(e.id||'').startsWith('prediction-start-')).length,0);
 assert.equal(events.filter(e=>e.id==='enrichment-'+start.data.runId).length,1);
}

{
 const w=await ready(8);await reconcile(w);
 const idle=await batch(w,{manifestSize:5,capacity:{remainingPercent:0}});
 assert.equal(idle.data.status,'blocked',JSON.stringify(idle.data).slice(0,200));
 assert.equal([...w.records.keys()].filter(k=>k.startsWith('events/items/')).length,0,'quota idle without a run writes no Event');
}

{
 const w=await ready(12);await reconcile(w);
 const start=await batch(w,{manifestSize:3});await submitAll(w,start.data);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 let failJournal=true;
 w.env.BUCKET.put=async(key,value,options)=>{if(failJournal&&String(key).startsWith('events/items/'))throw new Error('journal outage');return put(key,value,options);};
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 assert.equal([...w.records.keys()].filter(k=>k.startsWith('events/items/')&&w.records.get(k)?.id==='enrichment-'+start.data.runId).length,0);
 const parked=w.records.get('enrichment/stop-events/'+start.data.runId+'.json');
 assert.equal(parked?.delivered,undefined);assert.equal(parked?.event?.presentation,'batch_v2_terminal');
 assert.ok(w.records.get('enrichment/event-outbox.json')?.pending?.['enrichment/stop-events/'+start.data.runId+'.json']);
 failJournal=false;
 const next=await batch(w,{manifestSize:3});
 assert.equal(next.status,200,JSON.stringify(next.data).slice(0,200));
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,1,'the next start delivers the parked terminal Event');
 assert.equal(w.records.get('enrichment/stop-events/'+start.data.runId+'.json').delivered,true);
}

{
 const w=await ready(12);await reconcile(w);
 const start=await batch(w,{manifestSize:3});await submitAll(w,start.data);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 let failStop=true;
 w.env.BUCKET.put=async(key,value,options)=>{if(failStop&&String(key).startsWith('enrichment/stop-events/'))throw new Error('stop record outage');return put(key,value,options);};
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));
 assert.equal(done.data.status,'complete');assert.ok(done.data.event||done.data.presentation==='batch_v2_terminal');
 assert.equal(w.records.has('enrichment/stop-events/'+start.data.runId+'.json'),false,'the stop record was not created');
 assert.ok([...w.records.keys()].every(k=>!(k.startsWith('events/items/')&&w.records.get(k)?.id==='enrichment-'+start.data.runId)));
 const latest=w.records.get('enrichment/latest-run.json');assert.equal(latest.runId,start.data.runId);assert.equal(latest.status,'complete');assert.equal(latest.event?.presentation,'batch_v2_terminal');
 failStop=false;
 const next=await batch(w,{manifestSize:3});
 assert.equal(next.status,200,JSON.stringify(next.data).slice(0,200));
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,1,'the next start reconstructs the missing stop record and delivers one Event');
 assert.equal(w.records.get('enrichment/stop-events/'+start.data.runId+'.json').delivered,true);
}

{
 const w=await ready(12);await reconcile(w);
 const start=await batch(w,{manifestSize:3});await submitAll(w,start.data);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 let failJournal=true,journalPuts=0;
 w.env.BUCKET.put=async(key,value,options)=>{if(String(key).startsWith('events/items/')){journalPuts++;if(failJournal)throw new Error('journal outage');}return put(key,value,options);};
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);
 const key='enrichment/stop-events/'+start.data.runId+'.json';
 assert.equal(w.records.get(key)?.delivered,undefined);
 w.ctx.env=w.env;w.ctx.__env=w.env;
 journalPuts=0;
 await vm.runInContext('deliverPendingEvents(env)',w.ctx);
 assert.equal(journalPuts,3,'one authorized sweep retries the journal three times, not twice that from a second flush');
 assert.equal(w.records.get('enrichment/event-outbox.json')?.pending?.[key]?.attempts,1);
 const MAX=8;
 for(let n=2;n<=MAX;n++)await vm.runInContext('deliverPendingEvents(env)',w.ctx);
 failJournal=false;
 const pending=w.records.get('enrichment/event-outbox.json')?.pending||{};
 assert.equal(pending[key]?.quarantined,true,'after the attempt budget the undelivered terminal Event is quarantined');
 assert.equal(pending[key]?.attempts,MAX);
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,0,'quarantine does not publish');
 assert.equal(w.records.get(key).event.presentation,'batch_v2_terminal','the parked record is kept');
 journalPuts=0;
 const after=await vm.runInContext('deliverPendingEvents(env)',w.ctx);
 assert.equal(journalPuts,0,'a quarantined latest Event is not written again after the journal returns');
 assert.equal(JSON.parse(JSON.stringify(after)).delivered,0);
 assert.equal(w.records.get('enrichment/event-outbox.json').pending[key].quarantined,true);
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,0);
}

{
 const w=await ready(12);await reconcile(w);
 const start=await batch(w,{manifestSize:3});await submitAll(w,start.data);
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);
 let failStop=true;
 w.env.BUCKET.put=async(key,value,options)=>{if(failStop&&String(key).startsWith('enrichment/stop-events/'))throw new Error('stop record outage');return put(key,value,options);};
 const done=await w.api('complete',{runId:start.data.runId,reason:'manifest_spent'});
 assert.equal(done.status,200);
 failStop=false;
 w.ctx.env=w.env;
 await vm.runInContext('deliverPendingEvents(env)',w.ctx);
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,1,'a missing stop record is reconstructed and delivered once');
 const again=await vm.runInContext('deliverPendingEvents(env)',w.ctx);
 assert.equal(JSON.parse(JSON.stringify(again)).delivered,0,'a second sweep does not publish another journal item');
 assert.equal([...w.records.entries()].filter(([k,v])=>k.startsWith('events/items/')&&v?.id==='enrichment-'+start.data.runId).length,1);
}

console.log('prediction-manifest-size ok');
