// AIR-298 / ADR 0062: every prediction queue writer is conditional on the etag it read. Each race below parks one writer
// between its read and its put, lets another writer commit, then releases it; the storage stub enforces R2 conditions.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';

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
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
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
async function startRun(){const start=(await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})).data;assert.equal(start.status,'running',JSON.stringify(start));const next=(await api('next',{runId:start.runId,batchSize:5})).data;assert(next.items.length>0);return {runId:start.runId,items:next.items};}
const fail=(runId,filmId)=>api('submit',{runId,items:[{filmId,failure:{kind:'parse_error'}}]});

// 1. Retry write ↔ EPG commit refresh, both orders. Before ADR 0062 the refresh put its stale `retries` over the record.
reset();await refresh(programme(),'programme_updated');
let run=await startRun(),target=run.items[0].filmId;
park(byTrigger('programme_updated'),async()=>{const answer=(await fail(run.runId,target)).data;assert.equal(answer.results[0].status,'retryable_failure');});
await refresh(programme(),'programme_updated');
assert.equal(queue().retries[target]?.attempts,1,'the EPG refresh keeps the retry written while it was parked');
assert(queue().retries[target].retryAt>Date.now()+50*60000);
assert(!(await api('next',{runId:run.runId,batchSize:5})).data.items.some(item=>item.filmId===target),'no premature model work for the deferred film');
const second=run.items[1].filmId;
park(byRetry(second),()=>refresh(programme(),'programme_updated'));
assert.equal((await fail(run.runId,second)).data.results[0].status,'retryable_failure');
assert.equal(queue().retries[second]?.attempts,1,'the retry write re-reads after the refresh and lands');
assert.equal(queue().retries[target].attempts,1);

// 2. Profile publication ↔ runner submit, both orders; the rebuilt queue carries the new profile and every retry.
reset();await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;
park(byRetry(target),()=>publishProfile(2));
await fail(run.runId,target);
assert.equal(queue().profileHash,'p2','a submit write cannot put the old profile back');
assert.equal(queue().retries[target]?.attempts,1);
reset();await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;
// The submit passed its profile check just before the publication; its retry write lands while the rebuild is parked.
park(byTrigger('profile_updated'),()=>putRetry(target,retryRecord(1,run.runId)));
await publishProfile(2);
assert.equal(queue().profileHash,'p2');assert.equal(queue().retries[target]?.attempts,1,'the profile rebuild keeps the parked retry');

// 3. Discovery checkpoint ↔ runner completion, both orders; the fence renews before every attempt.
reset(1);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
records.get(QUEUE).retries[target].lastRunId='lost';delete records.get(QUEUE).retries[target];etags.set(QUEUE,'s'+(++revision));
let fences=0;
park(byTrigger('resolver_checkpoint'),async()=>{const done=(await api('complete',{runId:run.runId,reason:'eligible_queue_empty'})).data;assert.equal(done.status,'complete',JSON.stringify(done));});
await refresh(programme(),'resolver_checkpoint',{beforeWrite:async()=>{fences++;}});
assert.equal(fences,2,'one renewal per write attempt');
assert.equal(queue().lastBatch?.runId,run.runId,'the checkpoint keeps the completion summary');
assert.equal(queue().retries[target]?.attempts,1,'the completion heals the retry the submit write lost');
const processed=queue().metrics.hotProcessedTotal;
reset(1);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
park(byTrigger('batch_complete'),()=>refresh(programme(),'resolver_checkpoint',{beforeWrite:async()=>{}}));
assert.equal((await api('complete',{runId:run.runId,reason:'eligible_queue_empty'})).data.status,'complete');
assert.equal(queue().lastBatch?.runId,run.runId,'the completion re-applies its summary to the fresh rebuild');
assert.equal(queue().trigger,'batch_complete');assert.equal(queue().retries[target].attempts,1);
assert.equal(processed,0);

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
// The start's idle check against a reconcile: the summary survives the rebuild and the rebuild survives the summary.
reset(2);await refresh(programme(),'programme_updated');
for(const id of ['tmdb_1','tmdb_2'])await putRetry(id,{...retryRecord(1,'run-z'),retryAt:Date.now()+3600000});
park(value=>value.lastBatch?.stage==='blocked',()=>refresh(programme(),'manual_reconcile'));
const idle=(await api('start',{scope:'watchlist_all'})).data;assert.equal(idle.status,'blocked');assert.equal(idle.reason,'retry_backoff');
assert.equal(queue().lastBatch?.reason,'retry_backoff');assert.equal(queue().retries.tmdb_1.attempts,1);

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

// 8. A repeated completion (a crash after the queue write, before the run record) counts and records once.
reset(1);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
const runKey='enrichment/runs/'+run.runId+'.json',saved=structuredClone(records.get(runKey)),lease=structuredClone(records.get('enrichment/runner-lease.json'));
const first=(await api('complete',{runId:run.runId,reason:'eligible_queue_empty'})).data;assert.equal(first.status,'complete');
const once=queue();
seed(runKey,saved);seed('enrichment/runner-lease.json',lease);
assert.equal((await api('complete',{runId:run.runId,reason:'eligible_queue_empty'})).data.status,'complete');
assert.equal(queue().metrics.hotProcessedTotal,once.metrics.hotProcessedTotal,'the counter moves once per run');
assert.deepEqual(queue().retries[target],once.retries[target],'the retry is recorded once per run');
// A run stopped for a systemic reason records the failures its submit could not write.
reset(1);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
delete records.get(QUEUE).retries[target];etags.set(QUEUE,'s'+(++revision));
await api('complete',{runId:run.runId,reason:'storage_error'});
assert.equal(queue().retries[target]?.attempts,1,'a stopped run heals its lost retry');

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

// 12. A retry the queue could not take is never lost. The run keeps it marked, its stop writes it again, and the next
// start confirms it before selecting anything or starts nothing; the lease keeps naming the unsettled run meanwhile.
const runRecord=id=>records.get('enrichment/runs/'+id+'.json'),LEASE='enrichment/runner-lease.json';
const interfere=(times=Infinity)=>park(()=>times-->0,async()=>{await mutate(q=>({...q,noise:(q.noise||0)+1}),'test');},true);
const begin=()=>api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});
async function deferredAcrossNextRun(stopped,id){
 const next=await begin();assert.equal(next.data.status,'running',JSON.stringify(next.data));
 assert.equal(queue().retries[id]?.lastRunId,stopped,'the next start finds the retry in the queue');assert.equal(queue().retries[id].attempts,1);
 assert(queue().retries[id].retryAt>Date.now()+50*60000);assert.equal(runRecord(stopped).retryHeal,undefined,'the mark is cleared once settled');
 assert(!runRecord(next.data.runId).selectedIds.includes(id),'the start does not select the deferred film');
 const items=(await api('next',{runId:next.data.runId,batchSize:5})).data.items;assert(items.length>0);assert(!items.some(item=>item.filmId===id),'nor does next');
}
// Five conflicts at the submit route, and its stop's own write conflicting too: the next start fails closed until the
// queue takes the retry.
reset(4);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;
interfere();
const exhausted=await fail(run.runId,target);
assert.equal(exhausted.status,502);assert.equal(exhausted.data.error,'storage_error');assert.equal(exhausted.data.retryHeal,'pending');
assert.equal(queue().retries?.[target],undefined);assert.equal(runRecord(run.runId).status,'partial');assert.equal(runRecord(run.runId).retryHeal,'pending');
assert.equal(runRecord(run.runId).failures[target].kind,'parse_error','the run record holds the failure');
assert.equal(records.get(LEASE).runId,run.runId);assert.equal(records.get(LEASE).expiresAt,0,'the stopped run released its lease');
const gated=await begin();
assert.equal(gated.status,503);assert.equal(gated.data.status,'blocked');assert.equal(gated.data.code,'prediction_retry_heal_pending');assert.equal(gated.data.pendingRunId,run.runId);
assert.equal(records.get(LEASE).runId,run.runId,'a start that cannot settle takes no lease and selects nothing');
assert.equal(runRecord(run.runId).retryHeal,'pending');
hook=null;await deferredAcrossNextRun(run.runId,target);
// Five conflicts at the submit route only: the stop's write lands, and the next run defers the film.
reset(4);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;
interfere(5);
const healedAtStop=await fail(run.runId,target);hook=null;
assert.equal(healedAtStop.status,502);assert.equal(healedAtStop.data.retryHeal,undefined);
assert.equal(queue().retries[target]?.lastRunId,run.runId,'the stop writes the retry');
await deferredAcrossNextRun(run.runId,target);
// An explicit systemic stop whose retry write fails: the stop is recorded, the retry stays marked, the next start waits.
reset(4);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
delete records.get(QUEUE).retries[target];etags.set(QUEUE,'s'+(++revision));
interfere();
const quota=await api('complete',{runId:run.runId,reason:'quota'});
assert.equal(quota.data.status,'partial');assert.equal(quota.data.stopReason,'quota');assert.equal(quota.data.retryHeal,'pending');
assert.equal(runRecord(run.runId).retryHeal,'pending');assert.equal(queue().retries?.[target],undefined);
assert.equal((await begin()).status,503,'the next start fails closed while the queue cannot take the retry');
hook=null;await deferredAcrossNextRun(run.runId,target);
// An unknown outcome of the stop's retry write is not repeated blindly: the next write re-reads and finds it in place.
reset(4);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;await fail(run.runId,target);
delete records.get(QUEUE).retries[target];etags.set(QUEUE,'s'+(++revision));
ambiguousKey=QUEUE;puts=ops.queuePuts;
const unknown=await api('complete',{runId:run.runId,reason:'storage_error'});
assert.equal(unknown.data.status,'partial');assert.equal(ops.queuePuts-puts,1,'the write with an unknown outcome is made once');
await deferredAcrossNextRun(run.runId,target);
// A crashed runner (no stop at all) leaves its mark on the run; the start that recovers its lease settles it first.
reset(4);await refresh(programme(),'programme_updated');run=await startRun();target=run.items[0].filmId;
interfere();await fail(run.runId,target);hook=null;
seed('enrichment/runs/'+run.runId+'.json',{...runRecord(run.runId),status:'running',retryHeal:'pending'});
seed(LEASE,{...records.get(LEASE),expiresAt:Date.now()-1});
await deferredAcrossNextRun(run.runId,target);

// 11. No writer is left that puts the queue without a condition.
const source=fs.readFileSync('src/enrichment.js','utf8')+fs.readFileSync('src/discovery.js','utf8')+fs.readFileSync('src/worker.js','utf8');
assert(!/saveJSON\(env,predictionQueueKey/.test(source),'no unconditional queue write');
assert.equal((source.match(/\.put\(predictionQueueKey/g)||[]).length,1,'one conditional put');

console.log('Prediction queue CAS: retry ↔ EPG, profile ↔ submit, checkpoint ↔ completion, reconcile ↔ every writer, stale generation/profile, lost lease, crash, unknown outcome, bounded conflict, idempotent completion, monotonic retries, bounded cost passed');
