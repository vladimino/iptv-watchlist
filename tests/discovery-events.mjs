// AIR-410: the Discovery Workflow writes one immutable `discovery` Events Log entry per logical tick (a chain of instances of one generation, or one scheduled firing that finds the
// queue confirmed empty). Counters are sums of saved chunk summaries, delivery survives a lost event write without repeating Discovery, and a read writes nothing.
// series without the hourly gate, and fences a second writer. No production binding is read or written.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const creates=[];
const binding={
 async create(request){creates.push(request);const prior=creates.filter(item=>item.id===request.id).length;if(prior>1){const error=new Error('Instance already exists');throw error;}return {id:request.id};},
 async get(){return {status:'running'};}
};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester',DISCOVERY_WORKFLOW:binding};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,console:{log(){},error(){},warn(){}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/discovery-workflow.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
const worker=context.worker,call=code=>vm.runInContext(code,context),realAdvance=context.advanceDiscovery;
const execution={waitUntil(){}};
const origin='https://iptv.example',headers={'Content-Type':'application/json'};
const post=async(path,body,environment=env)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),environment,execution);return {status:response.status,data:await response.json()};};
const status=async(environment=env)=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),environment,execution)).json();
const now=Date.now(),iso=new Date(now).toISOString();
const GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',OTHER='b2699929-1111-4222-8333-444444444444';
const INSTANCE=`discovery_${GENERATION.replace(/-/g,'')}_0`;
const decided=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
const continuation=()=>records.get('epg/resolver-continuation.json');
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]}));
function readyDiscoveryGate(runId){
 return {ready:true,held:false,tables:true,mode:'d1',cutover:'open',version:11,generation:1,programmeRunId:runId||null,publishedProgrammeRunId:runId||null,transfer:'idle'};
}
function armDiscoveryAuthority(runId){
 context.DiscoveryAuthority={
  ownsKey:()=>false,
  readAuthority:async()=>readyDiscoveryGate(runId),
  readWorkflow:async()=>({handled:false}),
  writeWorkflow:async()=>({handled:false,saved:false}),
  routeRead:async()=>({handled:false}),
  routeWrite:async()=>({handled:false}),
  readContinuation:async()=>({handled:false}),
  writeContinuation:async()=>({handled:false}),
  readLease:async()=>({handled:false}),
  acquireLease:async()=>({lease:{id:'11111111-2222-4333-8444-555555555555',expiresAt:Date.now()+90000}}),
  renewLease:async()=>({ok:true}),
  releaseLease:async()=>({handled:false}),
 };
}
function armWorkflowAdmission(runId=GENERATION){
 armDiscoveryAuthority(runId);
 armPublishedEpg(runId);
}
function clearWorkflowAdmission(){
 delete context.DiscoveryAuthority;
 delete context.PublishedEpg;
}
function armPublishedEpg(runId){
 context.PublishedEpg={
  currentGeneration:async()=>runId?{authority:'d1',programmeRunId:runId,phase:'published',generation:1,fence:'d1:1:'+runId}:null,
  readAuthority:async()=>({ready:true,mode:'d1',cutover:'open',programmeRunId:runId||null}),
  repairMirrors:async()=>{},
  readDocumentAt:async(_env,_run,kind)=>records.get(kind==='watchlist'?'watchlist.json':'programme.json')||null,
  saveWatchlist:async()=>null,
  publishGeneration:async(_env,input)=>{
   if(input?.programmeRunId)set('epg/published-generation.json',{phase:input.phase||'published',programmeRunId:input.programmeRunId});
   return {ok:true,programmeRunId:input?.programmeRunId||null,phase:input?.phase||'published'};
  },
  writeMirrors:async()=>true,
 };
}
function elect(series=0,programmeRunId=GENERATION){
 const instanceId=`discovery_${String(programmeRunId).replace(/[^0-9A-Za-z]/g,'').slice(0,32)||'none'}_${series}`;
 set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId,series,instanceId,phase:'running',updatedAt:new Date().toISOString(),waitingUntil:null,reason:null,chunksThisInstance:0,lastProgress:null,recovery:null});
 return instanceId;
}
function seed({stage='complete',remaining=12,reason='epg_committed',count=60,programmeRunId=GENERATION,published=GENERATION,syncId='sync-1'}={}){
 records.clear();etags.clear();puts.length=0;creates.length=0;
 set('programme.json',{runId:programmeRunId,updatedAt:iso,films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 set('sync.json',{runId:syncId,stage,updatedAt:iso,events:[{id:'evt-1',type:'epg',at:iso}]});
 set('epg/discovery-latest.json',{programmeRunId,items:items(count)});
 set('epg/discovery-resolution.json',{});
 if(published)set('epg/published-generation.json',{phase:'published',programmeRunId:published});
 if(remaining!==null)set('epg/resolver-continuation.json',{stage:'paused',reason,at:iso,hopId:null,remainingChunks:remaining,nextCatchUpAt:null,retryAt:null,programmeRunId});
 if(context.DiscoveryAuthority)armDiscoveryAuthority(published||null);
 if(context.PublishedEpg)armPublishedEpg(published||null);
}
const sleeps=[];
const step={
 async do(name,fn){try{return await fn();}catch(error){step.retried++;return fn();}},
 async sleepUntil(name,date){sleeps.push(date.toISOString());if(date.getTime()-Date.now()>5000)throw new Error('long-sleep');}
};
step.retried=0;
function workflowEnv(mode){return {...env,DISCOVERY_EXECUTOR:mode};}

// ---------- AIR-410: one `discovery` event per logical tick ----------
const eventKeys=()=>[...records.keys()].filter(key=>key.startsWith('events/items/'));
const discoveryEvents=()=>eventKeys().map(key=>records.get(key)).filter(event=>event?.type==='discovery');
const workflowRecord=()=>records.get('epg/discovery-workflow.json');
const realPut=bucket.put;
let failEventPuts=false;
bucket.put=async(key,...rest)=>{if(failEventPuts&&key.startsWith('events/items/'))throw new Error('event put failed');return realPut(key,...rest);};
const resetAll=()=>{records.clear();etags.clear();puts.length=0;creates.length=0;failEventPuts=false;};
binding.create=async request=>{creates.push(request);return {id:request.id};};
Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
armWorkflowAdmission();

// A chunk stub that saves what a real chunk saves: the status file, the continuation and a summary of that one chunk.
function chunkStub(plan){
 context.chunks=0;
 context.advanceDiscovery=async()=>{
  const spec=plan[Math.min(context.chunks,plan.length-1)];context.chunks++;
  const last=context.chunks>=plan.length,at=new Date().toISOString();
  const cheap=Object.hasOwn(spec,'cheap')?spec.cheap:0;
  set('epg/discovery-status.json',{schemaVersion:2,stage:last?'complete':'partial',programmeRunId:GENERATION,remaining:spec.remaining,cheapRemaining:cheap,checked:spec.checked,error:spec.error||null,at});
  set('epg/resolver-continuation.json',last?{stage:'complete',reason:null,at,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}:{stage:'paused',reason:null,at,hopId:'hop-'+context.chunks,remainingChunks:plan.length-context.chunks,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  return {stage:last?'complete':'partial',checked:spec.checked,added:spec.added,reused:spec.reused,screenedOut:spec.screenedOut,touched:0,tmdbCalls:spec.tmdbCalls,remaining:spec.remaining,cheapRemaining:cheap,error:spec.error||null,programmeRunId:GENERATION,diagnostic:{saved:{owned:true}},discovery:{reason:null,nextCatchUpAt:null}};
 };
}
const PLAN=[
 {checked:10,added:1,reused:1,screenedOut:2,tmdbCalls:5,remaining:20},
 {checked:10,added:2,reused:1,screenedOut:2,tmdbCalls:5,remaining:10},
 {checked:10,added:3,reused:1,screenedOut:2,tmdbCalls:5,remaining:0},
];
const COUNTS={chunks:3,checked:30,added:6,reused:3,screenedOut:6,tmdbCalls:15,touched:0};

// 1. A chain of three chunks: one event, the sums of the three saved chunks, settled and delivered, nothing counted twice.
seed({count:3});elect();
chunkStub(PLAN);
const ended=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(ended.reason,'complete');assert.equal(context.chunks,3);
{
 const events=discoveryEvents();assert.equal(events.length,1,'one event for the tick');
 const [event]=events,tick=workflowRecord().tick;
 assert.equal(event.type,'discovery');assert.equal(event.kind,'run');assert.equal(event.status,'finished');assert.equal(event.reason,'complete');
 for(const [name,value] of Object.entries(COUNTS))assert.equal(event[name],value,name);
 assert.equal(event.remaining,0);assert.equal(event.queueEmpty,true);assert.equal(event.error,null);
 assert.equal(event.id,'discovery-'+tick.id);assert.equal(event.at,tick.settled.at);assert.equal(event.startedAt,tick.startedAt);
 assert.equal(tick.delivered,true,'the record says it was delivered');
 assert.ok(Date.parse(event.at)>=Date.parse(event.startedAt));
 assert.deepEqual(Object.keys(event).sort(),['added','at','checked','chunks','error','id','kind','queueEmpty','reason','remaining','reused','screenedOut','startedAt','status','tmdbCalls','touched','type'].sort(),'a compact event: counters only, no film, id or private field');
}

// 2. Delivering again changes nothing; an unmarked tick finds its event and only marks it.
{
 const [key]=eventKeys(),before=JSON.stringify(records.get(key)),before_puts=puts.filter(item=>item.startsWith('events/')).length;
 assert.equal((await call('deliverDiscoveryTick')(env)).delivered,false);
 const record=workflowRecord();record.tick.delivered=false;set('epg/discovery-workflow.json',record);
 const again=await call('deliverDiscoveryTick')(env);
 assert.equal(again.delivered,true);assert.equal(again.event,'exists');assert.equal(JSON.stringify(records.get(key)),before,'the first event is kept as it was');
 assert.equal(eventKeys().length,1);assert.equal(workflowRecord().tick.delivered,true);
 assert.equal(puts.filter(item=>item.startsWith('events/')).length,before_puts,'no second event write');
}

// 3. A lost event write after the settlement: the chain still ends, nothing runs again, and the next scheduled reconcile delivers it.
resetAll();seed({count:3});elect();chunkStub(PLAN);
failEventPuts=true;
const lost=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(lost.reason,'complete');assert.equal(discoveryEvents().length,0,'the event was not written');
assert.equal(workflowRecord().tick.settled.reason,'complete');assert.equal(workflowRecord().tick.delivered,false,'the record keeps the tick open for delivery');
failEventPuts=false;
{
 const chunksBefore=context.chunks;creates.length=0;
 const outcome=await call('reconcileDiscoveryWorkflow')(env);
 assert.equal(context.chunks,chunksBefore,'delivery repeats no Discovery chunk');assert.equal(creates.length,0,'and starts no instance');
 assert.equal(discoveryEvents().length,1);assert.equal(discoveryEvents()[0].chunks,3);assert.equal(workflowRecord().tick.delivered,true);
 assert.equal(outcome.started,false);
 assert.equal(eventKeys().length,1,'an unscheduled reconcile writes no empty tick');
}

// 4. A rollover stays inside the tick: two instances, one event, the sums of both.
resetAll();seed({count:3});elect();chunkStub(PLAN);
const first=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:1},step);
assert.equal(first.reason,'rollover');assert.equal(discoveryEvents().length,0,'no event at a rollover');
const openTick=workflowRecord().tick;
assert.equal(openTick.chunks,1);assert.equal(openTick.settled,null);assert.equal(workflowRecord().series,1,'the successor carries the same tick');
const second=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:1},step);
assert.equal(second.reason,'complete');
{
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 for(const [name,value] of Object.entries(COUNTS))assert.equal(event[name],value,'rollover '+name);
 assert.equal(event.id,'discovery-'+openTick.id,'the id is the id of the tick the first instance opened');
}

// 5. A replay after a sleep counts a chunk once: a memoizing step returns the saved output and the chunk does not run again.
resetAll();seed({count:3});elect();chunkStub([{checked:10,added:1,reused:1,screenedOut:2,tmdbCalls:5,remaining:10},{checked:10,added:2,reused:1,screenedOut:2,tmdbCalls:5,remaining:0}]);
{
 const cache=new Map();let hibernated=false;
 const memo={
  async do(name,fn){if(cache.has(name))return cache.get(name);const value=await fn();cache.set(name,value);return value;},
  async sleepUntil(){if(!hibernated){hibernated=true;throw new Error('hibernate');}}
 };
 // After the first chunk the next plan waits: the backoff makes the instance sleep, and the sleep ends the invocation.
 const realStub=context.advanceDiscovery;
 context.advanceDiscovery=async(...args)=>{const outcome=await realStub(...args);if(context.chunks===1)set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:'hop-1',remainingChunks:1,nextCatchUpAt:new Date(Date.now()+1000).toISOString(),retryAt:new Date(Date.now()+1000).toISOString(),programmeRunId:GENERATION});return outcome;};
 await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memo),/hibernate/);
 assert.equal(context.chunks,1);assert.equal(workflowRecord().tick.chunks,1);
 set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:'hop-1',remainingChunks:1,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
 const done=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memo);
 assert.equal(done.reason,'complete');assert.equal(context.chunks,2,'the replayed chunk did not run again');
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 assert.equal(event.chunks,2);assert.equal(event.added,3);assert.equal(event.checked,20);assert.equal(event.tmdbCalls,10);
}

// 6. Exhausted recovery is an honest failure, not a success; a recoverable stop settles nothing.
resetAll();seed({count:3});
{
 const ownId=elect(0);
 const record=workflowRecord();record.tick={...call('newDiscoveryTick')(GENERATION,Date.now()),chunks:2,checked:20,added:2,remaining:7,cheapRemaining:0};record.recovery={attempts:1,reason:'step_failure',at:iso,dueAt:null,quarantined:false};set('epg/discovery-workflow.json',record);
 const soft=await call('stopOwnedWorkflow')(env,ownId,'no_progress',GENERATION,0,2);
 assert.equal(soft.settled,true);assert.equal(workflowRecord().tick.settled,null,'a recoverable stop leaves the tick open');assert.equal(discoveryEvents().length,0);
 const hard=workflowRecord();hard.recovery={attempts:4,reason:'step_failure',at:iso,dueAt:null,quarantined:false};set('epg/discovery-workflow.json',hard);
 const exhausted=await call('stopOwnedWorkflow')(env,ownId,'no_progress',GENERATION,0,2);
 assert.equal(exhausted.reason,'recovery_exhausted');
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 assert.equal(event.status,'failed');assert.equal(event.reason,'recovery_exhausted');assert.equal(event.checked,20);assert.equal(event.remaining,7);assert.equal(event.queueEmpty,false,'unknown or non-zero is never an empty queue');
 await call('stopOwnedWorkflow')(env,ownId,'no_progress',GENERATION,0,2);
 assert.equal(discoveryEvents().length,1,'a repeated stop keeps the first settlement and writes no second event');
}

// 6b. Zero checked with a queue that is not empty is told apart from an empty queue.
resetAll();seed({count:3});
{
 const ownId=elect(0);
 const record=workflowRecord();record.tick={...call('newDiscoveryTick')(GENERATION,Date.now()),chunks:1,checked:0,remaining:4,cheapRemaining:0};set('epg/discovery-workflow.json',record);
 await call('stopOwnedWorkflow')(env,ownId,'stale_generation',GENERATION,0,1);
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 assert.equal(event.checked,0);assert.equal(event.remaining,4);assert.equal(event.queueEmpty,false,'0 checked and 4 left is not an empty queue');assert.equal(event.status,'superseded');
}

// 7. A newer generation replaces the record: the tick of the old one is delivered as superseded, and the new chain starts its own.
resetAll();seed({count:3});
{
 elect(0);
 const record=workflowRecord();record.tick={...call('newDiscoveryTick')(GENERATION,Date.now()-60000),chunks:1,checked:10,added:1,remaining:30};set('epg/discovery-workflow.json',record);
 const oldTickId=record.tick.id;
 const stored=await call('readWorkflowState')(env);
 const created=await call('createWorkflowInstance')(env,OTHER,0,`discovery_${OTHER.replace(/-/g,'')}_0`,stored.etag,null,stored.record);
 assert.equal(created.started,true);
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 assert.equal(event.id,'discovery-'+oldTickId);assert.equal(event.status,'superseded');assert.equal(event.reason,'stale_generation');assert.equal(event.queueEmpty,false);
 const next=workflowRecord().tick;assert.equal(next.programmeRunId,OTHER);assert.notEqual(next.id,oldTickId);assert.equal(next.chunks,0);assert.equal(next.settled,null);
}

// 7b. A failed event put at the replacement is not a lost event: the settled tick stays durable in the outbox of the new record, and the next
// scheduled reconcile delivers exactly one superseded event.
resetAll();seed({count:3});
{
 elect(0);
 const record=workflowRecord();record.tick={...call('newDiscoveryTick')(GENERATION,Date.now()-60000),chunks:2,checked:20,added:2,remaining:30,cheapRemaining:0};set('epg/discovery-workflow.json',record);
 const oldTickId=record.tick.id;
 const stored=await call('readWorkflowState')(env);
 failEventPuts=true;
 const created=await call('createWorkflowInstance')(env,OTHER,0,`discovery_${OTHER.replace(/-/g,'')}_0`,stored.etag,null,stored.record);
 assert.equal(created.started,true,'a failed event put never blocks the new generation');
 assert.equal(discoveryEvents().length,0,'the put failed');
 const held=workflowRecord();
 assert.equal(held.outbox.length,1,'the old tick is kept in the outbox, not dropped');assert.equal(held.outbox[0].id,oldTickId);assert.equal(held.outbox[0].settled.reason,'stale_generation');assert.equal(held.tick.programmeRunId,OTHER);
 // The new record keeps the outbox through the owner's own writes.
 await call('settleWorkflowIfOwner')(env,`discovery_${OTHER.replace(/-/g,'')}_0`,{phase:'running',reason:'started'});
 assert.equal(workflowRecord().outbox.length,1,'an ordinary write of the record keeps the outbox');
 failEventPuts=false;
 await call('reconcileDiscoveryWorkflow')(env);
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1,'recovered exactly once');
 assert.equal(event.id,'discovery-'+oldTickId);assert.equal(event.status,'superseded');assert.equal(event.checked,20);
 assert.deepEqual(workflowRecord().outbox,[],'the entry leaves the outbox only after its put is confirmed');
 await call('reconcileDiscoveryWorkflow')(env);
 assert.equal(discoveryEvents().length,1,'a second reconcile writes nothing more');
 assert.equal(eventKeys().length,1);
}

// 7c. Several failed replacements accumulate in the outbox and are all delivered; the outbox is bounded.
resetAll();seed({count:3});
{
 const ids=Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
 elect(0,ids[0]);
 let record=workflowRecord();record.tick={...call('newDiscoveryTick')(ids[0],Date.now()-600000),chunks:1,checked:5,remaining:9,cheapRemaining:0};set('epg/discovery-workflow.json',record);
 failEventPuts=true;
 const firstTickIds=[];
 for(let i=1;i<ids.length;i++){
  const state=await call('readWorkflowState')(env);firstTickIds.push(state.record.tick.id);
  await call('createWorkflowInstance')(env,ids[i],0,`discovery_${ids[i].replace(/-/g,'')}_0`,state.etag,null,state.record);
 }
 assert.equal(workflowRecord().outbox.length,8,'nine replacements, a bound of eight');
 assert.deepEqual(workflowRecord().outbox.map(entry=>entry.id),firstTickIds.slice(-8),'the newest eight are kept');
 failEventPuts=false;
 const delivery=await call('deliverDiscoveryTick')(env);
 assert.equal(delivery.delivered,true);assert.equal(discoveryEvents().length,8);assert.deepEqual(workflowRecord().outbox,[]);
 assert.equal(new Set(discoveryEvents().map(event=>event.id)).size,8,'one event per tick');
}

// 7d. A partly failing delivery keeps exactly the entries whose put failed.
resetAll();seed({count:3});
{
 elect(0);
 const mk=(n)=>({...call('newDiscoveryTick')(GENERATION,Date.now()-n*60000),chunks:1,checked:n,remaining:1,cheapRemaining:0,settled:{at:new Date(Date.now()-n*30000).toISOString(),reason:'stale_generation'},delivered:false});
 const a=mk(5),b=mk(7);
 const record=workflowRecord();record.outbox=[a,b];set('epg/discovery-workflow.json',record);
 const realWrite=context.writeDiscoveryEvent;
 context.writeDiscoveryEvent=async(environment,event)=>{if(event.id==='discovery-'+a.id)throw new Error('put failed');return realWrite(environment,event);};
 const first=await call('deliverDiscoveryTick')(env);
 assert.equal(first.delivered,true);assert.equal(discoveryEvents().length,1);assert.equal(discoveryEvents()[0].id,'discovery-'+b.id);
 assert.deepEqual(workflowRecord().outbox.map(entry=>entry.id),[a.id],'the failed entry stays');
 context.writeDiscoveryEvent=realWrite;
 await call('deliverDiscoveryTick')(env);
 assert.equal(discoveryEvents().length,2);assert.deepEqual(workflowRecord().outbox,[]);
}

// 8. Empty queue: a scheduled firing that starts no chain and finds a confirmed zero writes one event per hour.
resetAll();seed({stage:'complete',remaining:0,reason:null,count:3});
set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:0,checked:0,error:null,at:iso});
set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
{
 const hour=Math.floor(Date.now()/3600000)*3600000,clock=hour+17*60000;
 const advanceWasCalled=context.advanceDiscovery;context.advanceDiscovery=async()=>{throw new Error('Discovery must not run for an empty tick');};
 await call('reconcileDiscoveryWorkflow')(env);
 assert.equal(discoveryEvents().length,0,'an unscheduled reconcile claims nothing');
 const scheduled=await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:clock});
 assert.equal(scheduled.started,false);assert.equal(creates.length,0,'no chain is started');
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1);
 assert.equal(event.kind,'empty');assert.equal(event.status,'finished');assert.equal(event.reason,'queue_empty');assert.equal(event.queueEmpty,true);assert.equal(event.remaining,0);
 for(const name of ['chunks','checked','added','reused','screenedOut','touched','tmdbCalls'])assert.equal(event[name],0,name);
 assert.equal(event.at,new Date(hour).toISOString(),'the tick of the hour');
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:clock+600000});
 assert.equal(discoveryEvents().length,1,'a second reconcile in the same hour finds the same event');
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:hour+3600000+5*60000});
 assert.equal(discoveryEvents().length,2,'the next hour is the next tick');
 assert.notEqual(discoveryEvents()[0].id,discoveryEvents()[1].id);

 // Not confirmed, not claimed: unknown, non-zero or cheap remaining, an error, a paused or unstarted pipeline, another generation, a held authority.
 const claim=async(label,mutate)=>{
  resetAll();seed({stage:'complete',remaining:0,reason:null,count:3});
  set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:0,checked:0,error:null,at:iso});
  set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  mutate();
  await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:clock});
  assert.equal(discoveryEvents().length,0,label);
 };
 await claim('remaining unknown',()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:null,cheapRemaining:0,error:null,at:iso}));
 await claim('remaining not zero',()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:4,cheapRemaining:0,error:null,at:iso}));
 await claim('cheap pass pending',()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:3,error:null,at:iso}));
 for(const [label,value] of [['cheap remainder missing',undefined],['cheap remainder null',null],['cheap remainder a string','0'],['cheap remainder negative',-1],['cheap remainder fractional',0.5]])
  await claim(label,()=>{const status={schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,error:null,at:iso};if(value!==undefined)status.cheapRemaining=value;set('epg/discovery-status.json',status);});
 await claim('status carries an error',()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:0,error:'boom',at:iso}));
 await claim('status of another generation',()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:OTHER,remaining:0,cheapRemaining:0,error:null,at:iso}));
 await claim('no status at all',()=>records.delete('epg/discovery-status.json'));
 await claim('continuation of another generation',()=>set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OTHER}));
 await claim('authority held',()=>{context.DiscoveryAuthority.readAuthority=async()=>({...readyDiscoveryGate(GENERATION),held:true,cutover:'held'});});
 armWorkflowAdmission();
 await claim('executor external',()=>{env.DISCOVERY_EXECUTOR='external';});
 env.DISCOVERY_EXECUTOR='workflow';
 context.advanceDiscovery=advanceWasCalled;
}

// 8b. An aggregated run is claimed empty only when its last saved chunk proved BOTH remainders to be zero.
for(const [label,spec,expected] of [
 ['both proven zero',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:0},true],
 ['cheap remainder not reported',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:undefined},false],
 ['cheap remainder null',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:null},false],
 ['cheap remainder pending',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:2},false],
 ['remaining unknown',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:null,cheap:0},false],
]){
 resetAll();seed({count:3});elect();chunkStub([spec]);
 await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
 const [event]=discoveryEvents();assert.equal(discoveryEvents().length,1,label);
 assert.equal(event.queueEmpty,expected,label);
}

// 9. A firing that starts a chain, or finds one running, is not an empty tick.
resetAll();seed({count:3});chunkStub(PLAN);
{
 const clock=Date.now();
 const started=await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:clock});
 assert.equal(started.started,true);assert.equal(creates.length,1);assert.equal(discoveryEvents().length,0,'starting a chain writes no event');
 assert.equal(workflowRecord().tick.programmeRunId,GENERATION);assert.equal(workflowRecord().tick.chunks,0);assert.equal(workflowRecord().tick.settled,null);
 const again=await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:clock+3600000});
 assert.equal(again.reason,'in_progress');assert.equal(discoveryEvents().length,0,'a running chain is not an empty queue');
}

// 10. The events API passes the new type through untouched and reading it writes nothing.
resetAll();seed({count:3});elect();chunkStub(PLAN);
await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
{
 const stored=discoveryEvents()[0],putsBefore=puts.length;
 const page=await call('eventPage')(env,null);
 assert.equal(JSON.stringify(page.events.filter(event=>event.type==='discovery')),JSON.stringify([stored]),'the event is returned exactly as stored');
 assert.equal(puts.length,putsBefore,'listing events writes nothing');
}

// 11. The pure helpers: only finite counts are added, an unknown part is not a zero.
{
 const base=call('newDiscoveryTick')(GENERATION,1000);
 const added=call('addChunkToDiscoveryTick')(base,{checked:5,added:'7',reused:-1,screenedOut:null,tmdbCalls:Infinity,remaining:null,cheapRemaining:0,error:null});
 assert.equal(added.chunks,1);assert.equal(added.checked,5);assert.equal(added.added,0);assert.equal(added.reused,0);assert.equal(added.screenedOut,0);assert.equal(added.tmdbCalls,0);
 assert.equal(call('discoveryQueueEmpty')(added.remaining,added.cheapRemaining,added.error),false,'unknown remaining is not empty');
 assert.equal(call('discoveryQueueEmpty')(0,0,null),true);
 for(const unknown of [null,undefined,-1,0.5,'0',NaN])assert.equal(call('discoveryQueueEmpty')(0,unknown,null),false,'an unproven cheap remainder is not a zero: '+String(unknown));
 for(const unknown of [null,undefined,-1,'0'])assert.equal(call('discoveryQueueEmpty')(unknown,0,null),false,'an unproven remaining is not a zero: '+String(unknown));
 assert.equal(call('discoveryQueueEmpty')(0,2,null),false);assert.equal(call('discoveryQueueEmpty')(0,0,'x'),false);assert.equal(call('discoveryQueueEmpty')(3,0,null),false);
 assert.equal(base.id.length>10&&base.id.includes('-'),true);
}

bucket.put=realPut;
console.log('Discovery events: tick sums, replay-safe counts, rollover inside the tick, lost write recovered without a repeated chunk, failed and superseded ticks, hourly empty tick only when confirmed, and nothing written by a read passed');
