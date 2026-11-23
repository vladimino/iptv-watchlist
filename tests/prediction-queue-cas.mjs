// AIR-298 / ADR 0064: every prediction queue writer is conditional on the etag it read. Each race below parks one writer
// between its read and its put, lets another writer commit, then releases it; the storage stub enforces R2 conditions.
// The races of the retired v5 runner (its submit, completion and next-start retry heal in R2 mode) are gone with it (ADR 0167); batch runner v2 runs in
// D1 mode only, where the queue fence is the D1 queue generation (ADR 0078): the last section races its retry write against a concurrent queue writer there.
import {installViewIndexFixture} from './view-index-fixture.mjs';
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {sql} from './prediction-d1-flow-lib.mjs';

const QUEUE='enrichment/prediction-queue.json',PROFILE='enrichment/profile/current.json';
const records=new Map(),etags=new Map();let revision=0,failKey='',ambiguousKey='',hook=null,hookBusy=false;const ops={get:0,put:0,queuePuts:0,queueConflicts:0};
const seed=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,'s'+(++revision));};
const env={BUCKET:{
 async get(key){ops.get++;return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  ops.put++;
  if(key===QUEUE){ops.queuePuts++;if(hook&&!hookBusy&&hook.when(JSON.parse(value))){const run=hook.run;if(!hook.again)hook=null;hookBusy=true;try{await run();}finally{hookBusy=false;}}}
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition&&'etagMatches' in condition&&(!records.has(key)||condition.etagMatches!==etags.get(key))){if(key===QUEUE)ops.queueConflicts++;return null;}
  if(key===failKey){failKey='';throw new Error('Storage write interrupted');}
  records.set(key,JSON.parse(value));etags.set(key,'w'+(++revision));
  if(key===ambiguousKey){ambiguousKey='';throw new Error('Connection reset after write');}
  return {etag:etags.get(key)};
 },
 async delete(key){records.delete(key);etags.delete(key);},
 list:async()=>({objects:[],truncated:false})}};
// AIR-374: the queue writers back off 20 to 170 ms between conflicting writes (predictionQueuePause, 10*2**attempt plus jitter), 5.4 s of idle time in this file. The races below count writes, conflicts
// and outcomes and never read the clock, so the context's setTimeout runs these short pauses after 1 ms; any longer timer keeps its delay.
const quickPause=(callback,milliseconds,...rest)=>setTimeout(callback,milliseconds<=200?1:milliseconds,...rest);
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout:quickPause});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
ctx.env=env;
const refresh=(report,trigger,options)=>ctx.refreshPredictionQueue(env,report,trigger,options);
const mutate=(apply,trigger)=>ctx.mutatePredictionQueue(env,apply,trigger);
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
const queue=()=>structuredClone(records.get(QUEUE));
const park=(when,run,again=false)=>{hook={when,run,again};};
const anyPut=()=>true,byTrigger=trigger=>value=>value.trigger===trigger,byRetry=id=>value=>!!value.retries?.[id];

const now=Date.now(),film=id=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,''),genres:[],actors:[],directors:[],shows:[{start:now}]});
function reset(count=12,runId='gen-1'){
 records.clear();etags.clear();hook=null;failKey='';ambiguousKey='';
 seed(PROFILE,{version:1,profileHash:'p1',profile:{ratingScale:'Half stars'}});seed('sync.json',{runId,stage:'complete'});
 const catalog={};for(let i=1;i<=count;i++)catalog['tmdb_'+i]=film('tmdb_'+i);
 seed('programme.json',{runId,films:[]});seed('epg/discovered-films.json',catalog);
}
const programme=()=>structuredClone(records.get('programme.json'));
const publishProfile=async version=>{seed(PROFILE,{version,profileHash:'p'+version,profile:{ratingScale:'Half stars'}});await refresh(programme(),'profile_updated');};
const retryRecord=(attempts,runId,at=now)=>({kind:'parse_error',scope:'item',retryable:true,failedAt:new Date(at).toISOString(),attempts,retryAt:at+3600000*2**(attempts-1),lastRunId:runId});
const putRetry=(id,record)=>mutate(q=>{q.retries={...(q.retries||{}),[id]:record};return q;},'test_retry');

// 4. Reconcile ↔ every writer. Each refresh trigger and each direct mutation, parked against a reconcile and the reverse.
const TRIGGERS=['profile_updated','programme_updated','epg_scan','resolver_checkpoint','manual_reconcile','scheduled','manual','next_priority','batch_progress','completion_check','batch_complete'];
for(const trigger of TRIGGERS){
 reset();await refresh(programme(),'programme_updated');await putRetry('tmdb_3',retryRecord(2,'run-a'));
 park(byTrigger(trigger),()=>putRetry('tmdb_4',retryRecord(1,'run-b')));
 await refresh(programme(),trigger);
 assert.equal(queue().trigger,trigger);assert.equal(queue().retries.tmdb_3.attempts,2,trigger);assert.equal(queue().retries.tmdb_4?.attempts,1,trigger+' keeps a retry written during it');
 park(byRetry('tmdb_5'),()=>refresh(programme(),'manual_reconcile'));
 await putRetry('tmdb_5',retryRecord(1,'run-c'));
 assert.equal(queue().retries.tmdb_5?.attempts,1,'a retry write parked behind a reconcile lands');
 park(byTrigger('manual_reconcile'),()=>refresh(programme(),trigger));
 assert.equal((await api('queue/reconcile',{})).status,200);
 for(const id of ['tmdb_3','tmdb_4','tmdb_5'])assert(queue().retries[id],trigger+' / reconcile keeps '+id);
}
// 5. A stale generation or profile never overwrites a newer one.
reset();await refresh(programme(),'programme_updated');
const oldReport=programme();seed('programme.json',{runId:'gen-2',films:[]});seed('sync.json',{runId:'gen-2',stage:'complete'});
await refresh(programme(),'programme_updated');assert.equal(queue().programmeRunId,'gen-2');
await refresh(oldReport,'next_priority');assert.equal(queue().programmeRunId,'gen-2','a caller holding the old programme rebuilds from the published one');
reset();await refresh(programme(),'programme_updated');
const staleReport=programme();
park(byTrigger('next_priority'),async()=>{seed('programme.json',{runId:'gen-3',films:[]});await refresh(programme(),'programme_updated');});
await refresh(staleReport,'next_priority');assert.equal(queue().programmeRunId,'gen-3','a conflict with a newer generation rebuilds from it');
reset();await refresh(programme(),'programme_updated');
park(byTrigger('manual_reconcile'),()=>publishProfile(3));
await refresh(programme(),'manual_reconcile');assert.equal(queue().profileVersion,3,'a conflict with a newer profile rebuilds from it');

// 6. A lost lease, a crashed put and an unknown outcome write nothing more and repeat nothing blindly.
reset();await refresh(programme(),'programme_updated');await putRetry('tmdb_2',retryRecord(1,'run-a'));
let before={value:queue(),etag:etags.get(QUEUE)},puts=ops.queuePuts;
const lost=Object.assign(new Error('Lease lost'),{name:'LeaseLostError'});
await assert.rejects(refresh(programme(),'resolver_checkpoint',{beforeWrite:async()=>{throw lost;}}),error=>error===lost);
assert.equal(ops.queuePuts,puts,'no put after a lost lease');assert.equal(etags.get(QUEUE),before.etag);
failKey=QUEUE;puts=ops.queuePuts;
await assert.rejects(refresh(programme(),'manual_reconcile'),/Storage write interrupted/);
assert.equal(ops.queuePuts,puts+1,'a put that throws is not repeated');assert.deepEqual(queue(),before.value);
ambiguousKey=QUEUE;puts=ops.queuePuts;
await assert.rejects(refresh(programme(),'manual_reconcile'),/Connection reset/);
assert.equal(ops.queuePuts,puts+1,'an unknown outcome is not repeated');
assert.equal(queue().retries.tmdb_2.attempts,1,'the written state is whole either way');
await refresh(programme(),'manual_reconcile');assert.equal(queue().trigger,'manual_reconcile','the next writer continues from the stored state');

// 7. Retry exhaustion is an explicit, bounded conflict that writes nothing of its own.
reset();await refresh(programme(),'programme_updated');
let interference=0;park(anyPut,async()=>{interference++;await mutate(q=>({...q,interference}),'test');},true);
puts=ops.queuePuts;
await assert.rejects(refresh(programme(),'manual_reconcile'),error=>error.name==='PredictionQueueConflictError'&&error.code==='prediction_queue_conflict'&&error.trigger==='manual_reconcile');
hook=null;
assert.equal(interference,5);assert.equal(queue().interference,5,'the competing writes all stand');assert.notEqual(queue().trigger,'manual_reconcile');
assert.equal(ops.queuePuts-puts,10,'five own attempts, five competing writes');
park(anyPut,async()=>{await mutate(q=>({...q,interference:++interference}),'test');},true);
const busy=await api('queue/reconcile',{});hook=null;
assert.equal(busy.status,409);assert.equal(busy.data.code,'prediction_queue_conflict');
park(anyPut,async()=>{await refresh(programme(),'programme_updated');},true);
await assert.rejects(mutate(q=>({...q,mark:true}),'test_mutation'),error=>error.name==='PredictionQueueConflictError');hook=null;
assert.equal(queue().mark,undefined);

// 9. Retry records only grow while outstanding; the same run writes once; a film that left the queue drops its record.
const merge=(existing,failure,runId)=>ctx.mergeRetryRecord(existing,failure,runId);
const older=retryRecord(3,'run-0',now),fresh={kind:'parse_error',scope:'item',retryable:true,failedAt:new Date(now).toISOString(),attempts:1,retryAt:now+3600000};
const grown=merge(older,fresh,'run-1');
assert.equal(grown.attempts,4);assert(grown.retryAt>=older.retryAt);assert.equal(grown.retryAt,now+6*3600000);assert.equal(grown.lastRunId,'run-1');
assert.equal(merge(grown,fresh,'run-1'),grown,'the same run does not write twice');
assert.equal(merge(null,fresh,'run-1').attempts,1);
assert(merge({...older,retryAt:now+48*3600000},fresh,'run-2').retryAt>=now+48*3600000,'a later retryAt never goes back');
reset(3);await refresh(programme(),'programme_updated');await putRetry('tmdb_2',retryRecord(2,'run-a'));
for(const trigger of TRIGGERS)await refresh(programme(),trigger);
assert.deepEqual(queue().retries.tmdb_2,retryRecord(2,'run-a'),'independent rebuilds never lower or drop an outstanding retry');
delete records.get('epg/discovered-films.json').tmdb_2;etags.set('epg/discovered-films.json','s'+(++revision));
await refresh(programme(),'manual_reconcile');assert.equal(queue().retries.tmdb_2,undefined,'a film no longer outstanding drops its record');

// 10. Storage work per rebuild does not grow with the queue; a conflict costs one more rebuild.
async function cost(count,conflict){reset(count);await refresh(programme(),'programme_updated');if(conflict)park(byTrigger('manual_reconcile'),()=>putRetry('tmdb_1',retryRecord(1,'run-a')));const start={...ops};await refresh(programme(),'manual_reconcile');return {get:ops.get-start.get,put:ops.queuePuts-start.queuePuts};}
const small=await cost(10,false),large=await cost(3000,false),contended=await cost(3000,true);
assert.deepEqual(large,small,'gets and puts are independent of the queue size');
assert.equal(large.put,1);assert.equal(contended.put,3,'own attempt, the competing write, own retry');
assert(contended.get<=2*large.get+2,'a conflict at most doubles the reads');

// 13. Batch runner v2 (D1 mode, ADR 0078 fence): a retry written by a batch submit and a queue write that lands between the submit's read and its
// write both survive. The concurrent writer commits first; the submit's guarded write conflicts on the queue generation, re-reads and applies again.
{
 const {flowWorld}=await import('./prediction-d1-flow-lib.mjs');
 const w=await flowWorld({films:6});const {start}=await w.reconcileAndStart();assert.equal(start.status,200);
 const m=start.data,[target,other]=m.films.map(f=>f.filmId);
 const original=w.env.DB.batch.bind(w.env.DB);let fired=0;
 w.env.DB.batch=async statements=>{
  if(!fired&&statements.some(item=>/prediction_queue/i.test(item.text)&&!/^\s*SELECT/i.test(item.text))){
   fired++;w.env.DB.batch=original;
   await w.ctx.mutatePredictionQueue(w.env,q=>{q.retries={...(q.retries||{}),[other]:retryRecord(2,'run-concurrent')};return q;},'test_retry');
  }
  return original(statements);
 };
 const answer=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{filmId:target,failure:{kind:'parse_error',reason:'json_unparseable'}}]});
 w.env.DB.batch=original;
 assert.equal(answer.status,200,JSON.stringify(answer.data).slice(0,300));assert.equal(answer.data.results[0].status,'validation_failure');assert.equal(fired,1,'the concurrent writer ran between the read and the write');
 const stored=JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
 assert.equal(stored.retries[target]?.attempts,1,'the submit retry landed after the conflict');assert.equal(stored.retries[other]?.attempts,2,'and the concurrent write was not overwritten');
}

// 11. No writer is left that puts the queue without a condition.
const source=fs.readFileSync('src/enrichment.js','utf8')+fs.readFileSync('src/discovery.js','utf8')+fs.readFileSync('src/worker.js','utf8');
assert(!/saveJSON\(env,predictionQueueKey/.test(source),'no unconditional queue write');
assert.equal((source.match(/\.put\(predictionQueueKey/g)||[]).length,1,'one conditional put');

console.log('Prediction queue CAS: reconcile ↔ every writer, stale generation/profile, lost lease, crash, unknown outcome, bounded conflict, monotonic retries, bounded cost and the batch v2 retry write ↔ concurrent queue writer in D1 passed');
