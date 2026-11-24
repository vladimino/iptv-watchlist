// AIR-410 (ADR 0111): every scheduled hourly firing of the Discovery reconcile writes exactly one immutable `discovery` Events Log report for its UTC hour,
// with the deltas since the previous report, whatever the Workflow is doing. Chunk counters are attributed by commit time and counted once (replay-safe),
// delivery goes through a capped durable outbox with a create-only put, an unknown reading is `null` and never a 0, and a read writes nothing.
// No production binding is read or written.
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
const warnings=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,console:{log(){},error(){},warn(line){try{warnings.push(JSON.parse(line));}catch{warnings.push({unparsed:true});}}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
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
let failEventPuts=false,failFaultPuts=false;
bucket.put=async(key,...rest)=>{if(failEventPuts&&key.startsWith('events/items/'))throw new Error('event put failed');if(failFaultPuts&&key===FAULT_KEY)throw new Error('ledger put failed');return realPut(key,...rest);};
const resetAll=()=>{warnings.length=0;records.clear();etags.clear();puts.length=0;creates.length=0;failEventPuts=false;failFaultPuts=false;};
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
  // AIR-598: production shapes: the chunk's status and its continuation checkpoint name the same hop, and the status carries all four queue parts.
  set('epg/discovery-status.json',{schemaVersion:2,stage:last?'complete':'partial',programmeRunId:GENERATION,hopId:'hop-'+context.chunks,remaining:spec.remaining,cheapRemaining:cheap,deferred:0,waitingRetry:0,checked:spec.checked,error:spec.error||null,at});
  set('epg/resolver-continuation.json',last?{stage:'complete',reason:null,at,hopId:'hop-'+context.chunks,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}:{stage:'paused',reason:null,at,hopId:'hop-'+context.chunks,remainingChunks:plan.length-context.chunks,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  return {stage:last?'complete':'partial',checked:spec.checked,added:spec.added,reused:spec.reused,screenedOut:spec.screenedOut,touched:0,tmdbCalls:spec.tmdbCalls,remaining:spec.remaining,cheapRemaining:cheap,error:spec.error||null,programmeRunId:GENERATION,diagnostic:{saved:{owned:true}},discovery:{reason:null,nextCatchUpAt:null}};
 };
}
const PLAN=[
 {checked:10,added:1,reused:1,screenedOut:2,tmdbCalls:5,remaining:20},
 {checked:10,added:2,reused:1,screenedOut:2,tmdbCalls:5,remaining:10},
 {checked:10,added:3,reused:1,screenedOut:2,tmdbCalls:5,remaining:0},
];
const COUNTS={chunks:3,checked:30,added:6,reused:3,screenedOut:6,tmdbCalls:15,touched:0};

// ---------- AIR-410 v2: one `discovery` report per scheduled hourly firing ----------
const BASE=Date.UTC(2026,10,11,10),HOUR=3600000;
const cron=n=>({scheduled:true,now:BASE+n*HOUR+(n%2)*1000});
const reports=()=>discoveryEvents().filter(event=>event.kind!=='report_failed').sort((a,b)=>a.at<b.at?-1:1);
const notices=()=>discoveryEvents().filter(event=>event.kind==='report_failed').sort((a,b)=>a.at<b.at?-1:1);
const FAULT_KEY='epg/discovery-report-faults.json'.replace('epg/','events/');
const ledger=()=>records.get(FAULT_KEY)?.faults||[];
const FAULT_KEY_V2='events/discovery-report-faults-v2.json';
const ledgerV2=()=>records.get(FAULT_KEY_V2)?.faults||[];
const outbox=()=>workflowRecord()?.outbox||[];
const hourId=(generation,n)=>'discovery-hour-'+generation.replace(/-/g,'').slice(0,12)+'-'+new Date(BASE+n*HOUR).toISOString().replace(/[-:]/g,'').slice(0,11);
const ZERO={checked:0,added:0,reused:0,screenedOut:0,touched:0,tmdbCalls:0};
const sumOf=(events,name)=>events.reduce((total,event)=>total+event[name],0);
const closed=(outcome,n,environment=env)=>call('closeHourlyDiscoveryReport')(environment,outcome,cron(n));

// 1. A chain that crosses four scheduled hours with rollovers: one report per hour, deltas not totals, sums equal the committed chunks.
seed({count:3});
chunkStub(PLAN);
{
 const first=await call('reconcileDiscoveryWorkflow')(env,cron(0));
 assert.equal(first.started,true);assert.equal(creates.length,1);
 assert.equal(reports().length,1,'the hour of the start has its report');
 assert.equal(reports()[0].status,'running');assert.equal(reports()[0].chunks,0);
 for(const name of Object.keys(ZERO))assert.equal(reports()[0][name],0,'a started chain with no chunk yet reports a proven 0: '+name);
 const series0=workflowRecord().instanceId;
 const r0=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:1},step);
 assert.equal(r0.reason,'rollover');
 const h1=await call('reconcileDiscoveryWorkflow')(env,cron(1));assert.equal(h1.reason,'in_progress');
 const r1=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:1,chunkLimit:1},step);
 assert.equal(r1.reason,'rollover');
 await call('reconcileDiscoveryWorkflow')(env,cron(2));
 const r2=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:2},step);
 assert.equal(r2.reason,'complete');assert.equal(context.chunks,3);
 await call('reconcileDiscoveryWorkflow')(env,cron(3));
 const list=reports();
 assert.equal(list.length,4,'one report for each of the four scheduled hours, none for the chain itself');
 assert.deepEqual(list.map(event=>event.at),[0,1,2,3].map(n=>new Date(BASE+n*HOUR).toISOString()));
 assert.deepEqual(list.map(event=>event.added),[0,1,2,3],'hour 0 had no chunk; later hours carry only their own chunk');
 assert.deepEqual(list.map(event=>event.chunks),[0,1,1,1]);
 assert.deepEqual(list.map(event=>event.checked),[0,10,10,10]);
 assert.deepEqual(list.map(event=>event.tmdbCalls),[0,5,5,5]);
 for(const name of Object.keys(COUNTS))if(name!=='chunks')assert.equal(sumOf(list,name),COUNTS[name],'sum of deltas = committed chunks: '+name);
 assert.deepEqual(list.map(event=>event.status),['running','running','running','empty']);
 assert.equal(list[3].queueEmpty,true);assert.equal(list[3].remaining,0);assert.equal(list[2].queueEmpty,false);
 assert.deepEqual(list.map(event=>event.id),[0,1,2,3].map(n=>hourId(GENERATION,n)),'identity = generation + UTC hour');
 assert.equal(list[1].from,new Date(BASE).toISOString(),'from is the end of the previous period');
 assert.equal(list.every(event=>event.kind==='hour'&&event.type==='discovery'&&!event.incomplete),true);
 assert.deepEqual(outbox(),[],'everything delivered');
 assert.notEqual(series0,workflowRecord().instanceId);
 assert.deepEqual(Object.keys(list[1]).sort(),['added','at','checked','chunks','error','from','generation','id','incomplete','kind','queueEmpty','queueUnreadable','reason','remaining','reused','screenedOut','status','tmdbCalls','touched','type'].sort(),'a compact event: counters only, no film titles');
}

// 2. Duplicate, delayed and missed crons. A repeated hour finds its report, a late cron keeps the hour, a gap is not backfilled.
resetAll();seed({count:3});elect();chunkStub(PLAN);
{
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:BASE});
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:BASE});
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:BASE+50*60000});
 assert.equal(reports().length,1,'a duplicate or delayed cron of the same hour adds nothing');
 const stored=JSON.stringify(reports()[0]);
 await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:2},step);
 const putsBefore=puts.length;
 await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:BASE+10*60000});
 assert.equal(puts.length,putsBefore,'a repeat of a closed hour writes nothing');assert.equal(JSON.stringify(reports()[0]),stored);
 const late=await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:BASE+4*HOUR+59*60000});
 assert.equal(reports().length,2,'hours 1..3 were missed: no report is invented for them');
 const [a,b]=reports();assert.equal(b.at,new Date(BASE+4*HOUR).toISOString());assert.equal(b.from,a.at,'the late report reaches back to the previous one');
 assert.equal(b.added,3,'the chunks of the silent hours are in the next report, once');assert.equal(b.chunks,2);
 assert.ok(late);
 assert.equal(sumOf(reports(),'added'),3);
}

// 2b. A delayed or replayed firing of an OLDER hour never closes the open accumulator: a chunk committed after hour 11 appears exactly once, in hour 12.
resetAll();seed({count:3});const own2b=elect();
{
 const outcome={started:false,reason:'in_progress',programmeRunId:GENERATION};
 await closed(outcome,0);await closed(outcome,1);
 await call('settleWorkflowIfOwner')(env,own2b,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:6,added:3,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:4,cheapRemaining:0,error:null},own2b+':1',GENERATION)}));
 const before=JSON.stringify(reports()),recordBefore=JSON.stringify(workflowRecord()),putsBefore=puts.length;
 const stale=await closed(outcome,0);
 assert.equal(stale.closed,false);assert.equal(stale.reason,'stale_hour');
 assert.equal(JSON.stringify(workflowRecord().report),JSON.stringify(JSON.parse(recordBefore).report),'the open accumulator is untouched');
 assert.equal(workflowRecord().report.added,3);assert.equal(JSON.stringify(reports()),before,'no stored event changed');assert.equal(puts.length,putsBefore,'nothing was written');
 assert.equal((await closed(outcome,1)).reason,'already_closed');
 await closed(outcome,2);
 assert.equal(reports().length,3);assert.deepEqual(reports().map(event=>event.added),[0,0,3],'the chunk is in hour 12, once');
 assert.equal(sumOf(reports(),'added'),3);assert.equal(workflowRecord().report.added,0);
 // The old hour's outbox may still drain: an entry left there by a failed put is delivered by the stale firing.
 resetAll();seed({count:3});elect();
 failEventPuts=true;await closed(outcome,0);await closed(outcome,1);failEventPuts=false;
 assert.equal(outbox().length,2);
 const drained=await closed(outcome,0);assert.equal(drained.reason,'stale_hour');
 assert.deepEqual(outbox(),[],'the stale firing still delivers the outbox');assert.equal(reports().length,2);
}

// 3. An hour with no change, a close without a scheduled clock, an external executor.
resetAll();seed({count:3});elect();
{
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);
 const [a,b]=reports();assert.equal(reports().length,2);
 for(const event of [a,b]){assert.equal(event.status,'running');assert.equal(event.chunks,0);for(const name of Object.keys(ZERO))assert.equal(event[name],0);}
 const n=reports().length;
 assert.equal((await call('closeHourlyDiscoveryReport')(env,{reason:'in_progress'},{})).reason,'not_scheduled');
 assert.equal((await call('closeHourlyDiscoveryReport')(env,{reason:'in_progress'},{scheduled:true})).reason,'not_scheduled');
 assert.equal((await call('closeHourlyDiscoveryReport')(env,{reason:'in_progress'},{scheduled:true,now:NaN})).reason,'not_scheduled');
 assert.equal((await call('reconcileDiscoveryWorkflow')(env)).started,false);
 assert.equal(reports().length,n,'an unscheduled caller and an external executor write nothing');
}

// 4. Every state has a report: waiting, exhausted, blocked refusals, idle, unknown reason.
for(const [label,outcome,status,reason] of [
 ['waiting',{started:false,reason:'recovery_waiting'},'waiting','recovery_waiting'],
 ['exhausted',{started:false,reason:'recovery_exhausted'},'failed','recovery_exhausted'],
 ['projector window',{started:false,reason:'projector_window'},'blocked','projector_window'],
 ['authority held',{started:false,reason:'authority_held'},'blocked','authority_held'],
 ['generation handoff',{started:false,reason:'generation_handoff'},'blocked','generation_handoff'],
 ['unnamed refusal',{started:false,reason:'something_new'},'blocked','other'],
 ['no reason',{started:false},'blocked','unknown'],
 ['started',{started:true,reason:'started'},'running',null],
]){
 resetAll();seed({count:3});elect();
 await closed({...outcome,programmeRunId:GENERATION},0);
 const [event]=reports();assert.equal(reports().length,1,label);
 assert.equal(event.status,status,label);assert.equal(event.reason,reason,label);assert.equal(event.queueEmpty,false,label);
}

// 5. Empty queue is claimed only when proven: the continuation complete for the generation and the status written by its own last chunk (same hop) with
// remaining, cheap-pass, deferred and waiting-retry all numeric zero and no error; no quarantined executor and no live Discovery writer (AIR-598: the strict
// shared proof; the EPG publication's lease does not count).
{
 const hour=BASE;
 const confirmed=(label,mutate,expectEmpty)=>async()=>{
  resetAll();seed({stage:'complete',remaining:0,reason:null,count:3});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'complete',updatedAt:iso,waitingUntil:null,recovery:null});
  set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,hopId:'hop-c',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,checked:0,error:null,at:iso});
  set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:'hop-c',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  mutate();
  await closed({started:false,reason:'stopped',programmeRunId:GENERATION},0);
  const [event]=reports();assert.equal(reports().length,1,label);
  assert.equal(event.queueEmpty,expectEmpty,label);assert.equal(event.status,expectEmpty?'empty':'idle',label);
  return event;
 };
 const empty=await confirmed('proven empty',()=>{},true)();
 assert.equal(empty.reason,'queue_empty');assert.equal(empty.remaining,0);for(const name of Object.keys(ZERO))assert.equal(empty[name],0);
 const status=patch=>()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,hopId:'hop-c',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null,at:iso,...patch});
 await confirmed('remaining unknown',status({remaining:null}),false)();
 await confirmed('remaining not zero',status({remaining:4}),false)();
 await confirmed('cheap pass pending',status({cheapRemaining:3}),false)();
 for(const [label,value] of [['cheap missing',undefined],['cheap null',null],['cheap string','0'],['cheap negative',-1],['cheap fractional',0.5]])
  await confirmed(label,()=>{const value_={schemaVersion:2,stage:'complete',programmeRunId:GENERATION,hopId:'hop-c',remaining:0,deferred:0,waitingRetry:0,error:null,at:iso};if(value!==undefined)value_.cheapRemaining=value;set('epg/discovery-status.json',value_);},false)();
 // AIR-598 review: a complete continuation is proven only by the strict reading of its own hop: deferred and waiting-retry must be numeric zero too.
 for(const [label,patch] of [['deferred left',{deferred:7}],['deferred missing',{deferred:undefined}],['waiting retry null',{waitingRetry:null}],['waiting retry missing',{waitingRetry:undefined}],['waiting retry negative',{waitingRetry:-1}],['waiting retry string',{waitingRetry:'0'}],['another hop',{hopId:'hop-other'}],['no hop',{hopId:undefined}]])
  await confirmed('complete: '+label,status(patch),false)();
 await confirmed('complete: continuation without a hop',()=>set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}),false)();
 await confirmed('complete: a live Discovery writer',()=>set('epg/resolver-lease.json',{id:'hop-live',expiresAt:Date.now()+60000}),false)();
 await confirmed('complete: a live writer of unknown kind',()=>set('epg/resolver-lease.json',{id:'hop-live',expiresAt:Date.now()+60000,holderKind:'discovery'}),false)();
 await confirmed('complete: the EPG publication holds the lease',()=>set('epg/resolver-lease.json',{id:'epg-pub',expiresAt:Date.now()+60000,holderKind:'epg'}),true)();
 await confirmed('complete: an expired lease',()=>set('epg/resolver-lease.json',{id:'hop-old',expiresAt:Date.now()-1000}),true)();
 await confirmed('complete: a quarantined executor record',()=>set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'complete',updatedAt:iso,waitingUntil:null,recovery:{attempts:5,reason:'recovery_exhausted',quarantined:true}}),false)();
 await confirmed('status error',status({error:'boom'}),false)();
 await confirmed('status of another generation',status({programmeRunId:OTHER}),false)();
 await confirmed('no status',()=>records.delete('epg/discovery-status.json'),false)();
 await confirmed('continuation of another generation',()=>set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OTHER}),false)();
 await confirmed('continuation still paused',()=>set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:null,remainingChunks:2,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}),false)();
 void hour;
}

// 5b. A last chunk without a proven cheap remainder is never an empty queue: the proof reads the status that very chunk wrote (AIR-598: the period's accumulated
// reading is shown, never a proof).
for(const [label,spec,expected] of [
 ['both proven zero',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:0},true],
 ['cheap remainder not reported',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:undefined},false],
 ['cheap remainder null',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:null},false],
 ['cheap remainder pending',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:0,cheap:2},false],
 ['remaining unknown',{checked:4,added:0,reused:0,screenedOut:0,tmdbCalls:1,remaining:null,cheap:0},false],
]){
 resetAll();seed({count:3});elect();chunkStub([spec]);
 await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
 await call('reconcileDiscoveryWorkflow')(env,cron(1));
 const [event]=reports();assert.equal(reports().length,1,label);
 assert.equal(event.queueEmpty,expected,label);assert.equal(event.checked,4,label);
}

// 6. A replayed checkpoint counts once: the same chunk key adds nothing, a memoizing step does not run the chunk again.
{
 const one={checked:5,added:2,reused:1,screenedOut:0,touched:0,tmdbCalls:3,remaining:9,cheapRemaining:0,error:null};
 const add=(r,x,k)=>call('addChunkToDiscoveryReport')(r,x,k,GENERATION);
 const a=add(null,one,'i_0:1'),b=add(a,one,'i_0:1'),c=add(b,one,'i_0:2');
 assert.equal(JSON.stringify(b),JSON.stringify(a),'the same key adds nothing');assert.equal(c.added,4);assert.equal(c.chunks,2);assert.equal(c.checked,10);
 const bad=add(null,{checked:5,added:'7',reused:-1,screenedOut:null,tmdbCalls:Infinity,remaining:null,cheapRemaining:0,error:null},'k');
 assert.equal(bad.chunks,1);assert.equal(bad.checked,5);for(const name of ['added','reused','screenedOut','tmdbCalls'])assert.equal(bad[name],0,name);
 assert.equal(bad.remaining,null,'an unknown remainder stays unknown');
 let many=null;for(let i=0;i<40;i++)many=add(many,one,'k'+i);assert.ok(many.seen.length<=16,'the key list is bounded');assert.equal(many.added,80);
}
resetAll();seed({count:3});elect();chunkStub([{checked:10,added:1,reused:1,screenedOut:2,tmdbCalls:5,remaining:10},{checked:10,added:2,reused:1,screenedOut:2,tmdbCalls:5,remaining:0}]);
{
 const cache=new Map();let hibernated=false;
 const memo={async do(name,fn){if(cache.has(name))return cache.get(name);const value=await fn();cache.set(name,value);return value;},async sleepUntil(){if(!hibernated){hibernated=true;throw new Error('hibernate');}}};
 const realStub=context.advanceDiscovery;
 context.advanceDiscovery=async(...args)=>{const outcome=await realStub(...args);if(context.chunks===1)set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:'hop-1',remainingChunks:1,nextCatchUpAt:new Date(Date.now()+1000).toISOString(),retryAt:null,programmeRunId:GENERATION});return outcome;};
 await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memo),/hibernate/);
 assert.equal(workflowRecord().report.chunks,1);
 set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:'hop-1',remainingChunks:1,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
 const done=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memo);
 assert.equal(done.reason,'complete');assert.equal(context.chunks,2,'the replayed chunk did not run again');
 assert.equal(workflowRecord().report.chunks,2);assert.equal(workflowRecord().report.added,3);assert.equal(workflowRecord().report.checked,20);
 await call('reconcileDiscoveryWorkflow')(env,cron(1));
 const [event]=reports();assert.equal(reports().length,1);assert.equal(event.chunks,2);assert.equal(event.added,3);assert.equal(event.tmdbCalls,10);
}

// 7. A checkpoint racing the close: the close loses its compare-and-swap, reads again and the chunk lands in exactly one report.
resetAll();seed({count:3});elect();
{
 const chunk={checked:7,added:4,reused:0,screenedOut:1,touched:0,tmdbCalls:2,remaining:5,cheapRemaining:0,error:null};
 const realBucketPut=bucket.put;let raced=false;
 bucket.put=async(key,value,options)=>{
  if(!raced&&key==='epg/discovery-workflow.json'){raced=true;const state=await call('readWorkflowState')(env);
   await call('settleWorkflowIfOwner')(env,state.record.instanceId,record=>({report:call('addChunkToDiscoveryReport')(record.report,chunk,state.record.instanceId+':1',GENERATION)}));}
  return realBucketPut(key,value,options);
 };
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 bucket.put=realBucketPut;
 const [event]=reports();assert.equal(reports().length,1);assert.equal(event.added,4,'the raced chunk is in this report');assert.equal(workflowRecord().report.chunks,0,'and the new period starts empty');
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);
 assert.equal(reports()[1].added,0,'not counted again in the next one');
 assert.equal(sumOf(reports(),'added'),4);
}

// 8. A lost event write is never a lost report: the outbox keeps it, the next firing delivers both, no Discovery step repeats.
resetAll();seed({count:3});elect();chunkStub(PLAN);
{
 failEventPuts=true;
 await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:2},step);
 const lostOutcome=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);
 assert.equal(lostOutcome.closed,true);assert.equal(reports().length,0,'the put failed');
 assert.equal(outbox().length,1,'the report is durable in the record');assert.equal(outbox()[0].added,3);assert.equal(outbox()[0].id,hourId(GENERATION,1));
 assert.equal(workflowRecord().report.chunks,0,'the period was closed in the same write');
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},2);
 assert.equal(outbox().length,2,'the next hour is queued behind it');
 failEventPuts=false;const chunksBefore=context.chunks;creates.length=0;
 await call('reconcileDiscoveryWorkflow')(env,cron(3));
 assert.equal(context.chunks,chunksBefore);
 assert.deepEqual(reports().map(event=>event.id),[1,2,3].map(n=>hourId(GENERATION,n)),'all three, oldest first, once each');
 assert.equal(sumOf(reports(),'added'),3);assert.deepEqual(outbox(),[]);
 const putsBefore=puts.length;await call('deliverDiscoveryOutbox')(env);assert.equal(puts.length,putsBefore,'a second delivery writes nothing');
}

// 8b. Crash between the put and the outbox removal: the entry is already stored, so delivery only removes it and keeps the stored report.
resetAll();seed({count:3});elect();
{
 const event=call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:GENERATION,status:'running',reason:null,report:{...call('newDiscoveryReport')(null),chunks:1,added:9},queue:{remaining:3,empty:false},incomplete:false});
 await call('writeDiscoveryEvent')(env,event);
 const record=workflowRecord();record.outbox=[{...event,added:1}];set('epg/discovery-workflow.json',record);
 const before=JSON.stringify(reports()[0]);
 await call('deliverDiscoveryOutbox')(env);
 assert.equal(reports().length,1);assert.equal(JSON.stringify(reports()[0]),before,'the first stored event is kept as it was');assert.deepEqual(outbox(),[]);
}

// 9. The outbox is capped without a silent drop: at the limit a close coalesces into the open accumulator, and everything is reported once puts work again.
resetAll();seed({count:3});const own=elect();
{
 const limit=call('DISCOVERY_REPORT_OUTBOX_LIMIT');assert.equal(typeof limit,'number');
 failEventPuts=true;let total=0;
 for(let hour=0;hour<limit+6;hour++){
  await call('settleWorkflowIfOwner')(env,own,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:1,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:0,remaining:5,cheapRemaining:0,error:null},own+':'+hour,GENERATION)}));total++;
  await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},hour);
 }
 assert.equal(outbox().length,limit,'the outbox holds exactly its limit');
 assert.equal(workflowRecord().report.added,6,'the six hours that did not fit stay in the accumulator, not dropped');
 assert.equal(reports().length,0);
 failEventPuts=false;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},limit+6);
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},limit+7);
 const real=reports();
 assert.equal(real.every(event=>event.incomplete===false&&Number.isInteger(event.added)&&Number.isInteger(event.checked)),true,'every stored report has real numbers, never unknowns');
 assert.equal(sumOf(real,'added'),total,'every committed chunk is counted exactly once across the reports');
 assert.equal(real.length>=1,true);assert.deepEqual(outbox(),[]);
 const saturated=notices();
 assert.equal(saturated.length>=1,true,'each saturated hour that could not be reported has its own notice');
 for(const event of saturated){assert.equal(event.reason,'outbox_full');for(const name of Object.keys(ZERO))assert.equal(Object.hasOwn(event,name),false,'a notice carries no counter, so it can show neither a 0 nor an unknown: '+name);}
 assert.equal(new Set(saturated.map(event=>event.id)).size,saturated.length,'one stable identity per hour');
}

// 10. A close that cannot be persisted: one compact notice for the hour (no counters, no queue facts), independent of the record whose write failed; the
// accumulator is untouched, the typed reason is logged once, and the next successful report carries the deltas exactly once.
resetAll();seed({count:3});const own10=elect();
{
 const add=(n,added)=>call('settleWorkflowIfOwner')(env,own10,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:3,added,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10+':'+n,GENERATION)}));
 await add(1,2);
 const realRead=context.DiscoveryAuthority.readWorkflow,realWrite=context.DiscoveryAuthority.writeWorkflow;
 const windowBusy=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000};throw error;};
 // a held projector window
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 const held=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 assert.equal(held.closed,false);assert.equal(held.reason,'projector_window');assert.equal(held.notice,'delivered');
 assert.equal(reports().length,0);assert.equal(notices().length,1);
 const [n0]=notices();
 assert.deepEqual([n0.type,n0.kind,n0.reason,n0.status],['discovery','report_failed','projector_window',null],'a typed reason, no Discovery state is implied by a running chain');
 assert.equal(n0.id,'discovery-hour-'+GENERATION.replace(/-/g,'').slice(0,12)+'-'+new Date(BASE).toISOString().replace(/[-:]/g,'').slice(0,11),'the canonical identity of the hour: the same id as the report of that hour would have');
 for(const name of ['checked','added','reused','screenedOut','touched','tmdbCalls','chunks','remaining','queueEmpty','from','incomplete','error'])assert.equal(Object.hasOwn(n0,name),false,name+' is not in a notice: nothing is invented');
 assert.equal(workflowRecord().report.added,2,'the deltas wait for the next report');
 // a duplicate or replayed firing of the same failed hour finds the same notice
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 assert.equal(notices().length,1,'a replay keeps one notice for the hour');
 // an unreadable record, then a lost compare-and-swap, then no record: one notice each, each with its own typed reason and its own hour
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 context.DiscoveryAuthority.readWorkflow=async()=>{throw new Error('d1 down');};
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1)).reason,'state_unreadable');
 context.DiscoveryAuthority.readWorkflow=realRead;
 context.DiscoveryAuthority.writeWorkflow=async()=>({handled:true,saved:false});
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},2)).reason,'write_conflict');
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.deepEqual(notices().map(event=>event.reason),['projector_window','state_unreadable','write_conflict']);
 assert.equal(reports().length,0,'no report of unknowns');assert.equal(workflowRecord().report.added,2,'the accumulator was never reset or double counted');
 assert.equal(warnings.every(entry=>entry.event==='discovery_hour_close_failed'&&typeof entry.hourKey==='string'&&entry.hourKey.length<=12&&entry.notice==='delivered'),true,'bounded typed log lines, no payload');
 // the Discovery state is named only when the reconcile of that firing confirmed one that needs attention
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 await closed({started:false,reason:'recovery_exhausted',programmeRunId:GENERATION},3);
 await closed({started:false,reason:'recovery_waiting',programmeRunId:GENERATION},4);
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.deepEqual(notices().slice(3).map(event=>event.status),['failed','waiting'],'a confirmed Discovery state is named; a running chain is not');
 // a prolonged failure: one notice per hour, the accumulator keeps growing and nothing is lost
 await add(2,5);
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 for(let hour=5;hour<11;hour++)await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},hour);
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.equal(notices().length,11);assert.equal(new Set(notices().map(event=>event.id)).size,11,'every hour has its own stable identity');assert.equal(workflowRecord().report.added,7);
 // the later successful close reports everything once
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},11);
 const [r11]=reports();assert.equal(reports().length,1);assert.equal(r11.added,7,'the delayed deltas arrive once, in the next successful report');assert.equal(r11.checked,6);assert.equal(r11.incomplete,false);assert.equal(r11.from,null,'the first report has no earlier period');
 // a failed hour between two reports: the next report reaches back to the last closed one and counts the delta once
 await add(3,1);
 context.DiscoveryAuthority.writeWorkflow=windowBusy;await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},12);context.DiscoveryAuthority.writeWorkflow=realWrite;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},13);
 const [,r13]=reports();assert.equal(r13.from,r11.at);assert.equal(r13.added,1);
 assert.deepEqual(outbox(),[]);
}
// 10a. No record at all (no Workflow instance yet): a notice, no zero, no report.
resetAll();seed({count:3});
{
 records.delete('epg/discovery-workflow.json');
 const none=await closed({started:false,reason:'stopped',programmeRunId:GENERATION},0);
 assert.equal(none.closed,false);assert.equal(reports().length,0);assert.equal(notices().length,1);assert.equal(notices()[0].reason,'no_record');assert.equal(warnings.some(entry=>entry.reason==='no_record'),true);
}
// 10c. The journal itself refuses the notice: it waits in a separate ledger (its own compare-and-swap, not the record), every later scheduled firing drains it, a repeat or a
// duplicate delivers nothing twice, nothing is ever evicted, and a storage outage in both places is logged and never claimed as delivered.
resetAll();seed({count:3});const own10c=elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 const windowBusy=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000};throw error;};
 await call('settleWorkflowIfOwner')(env,own10c,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:4,added:3,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10c+':1',GENERATION)}));
 context.DiscoveryAuthority.writeWorkflow=windowBusy;failEventPuts=true;
 const queued=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 assert.equal(queued.notice,'queued');assert.equal(notices().length,0,'the journal refused it');assert.equal(ledger().length,1,'the ledger holds it durably');
 assert.equal(warnings.at(-1).notice,'queued','the log says it is queued, not delivered');
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);assert.equal(ledger().length,1,'the same failed hour again: one ledger entry (an idempotent identity)');
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);assert.equal(ledger().length,2);
 // the journal is back and the record is writable: the next scheduled firing drains the ledger first, then closes its own hour, and the deltas are counted once
 failEventPuts=false;context.DiscoveryAuthority.writeWorkflow=realWrite;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},2);
 assert.equal(notices().length,2,'both queued notices were delivered');assert.deepEqual(ledger(),[],'delivered entries left the ledger');
 assert.equal(reports().length,1);assert.equal(reports()[0].added,3);
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},2);await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},3);
 assert.equal(notices().length,2);assert.equal(reports().length,2,'replay and duplicate delivery change nothing');
}
// 10d. A journal outage of more than 48 hours loses nothing: every failed hour is queued, the drain is bounded per firing and oldest first, and every hour is delivered once.
resetAll();seed({count:3});elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 const windowBusy=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000};throw error;};
 const HOURS=200,drain=call('DISCOVERY_REPORT_FAULT_DRAIN');assert.equal(typeof drain,'number');
 context.DiscoveryAuthority.writeWorkflow=windowBusy;failEventPuts=true;
 for(let hour=0;hour<HOURS;hour++)await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},hour);
 assert.equal(ledger().length,HOURS,'200 failed hours, 200 ledger entries: nothing evicted');assert.equal(records.has(FAULT_KEY)&&Object.hasOwn(records.get(FAULT_KEY),'dropped'),false,'there is no dropped counter: nothing is dropped');
 assert.equal(new Set(ledger().map(entry=>entry[1])).size,HOURS,'one entry per hour');
 failEventPuts=false;
 const before=ledger().length;await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},HOURS);   // this firing fails to close as well: the window is still held
 assert.equal(notices().length,drain+1,'one firing drains at most the bound from the ledger, oldest first, plus its own notice');
 assert.deepEqual(notices().map(event=>event.at).slice(0,3),[0,1,2].map(hour=>new Date(BASE+hour*HOUR).toISOString()),'the oldest hours came first');
 for(let n=0;n<10;n++)await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},HOURS+1+n);
 assert.equal(notices().length,HOURS+11,'every failed hour, including those of the recovery firings, has exactly one notice');assert.equal(new Set(notices().map(event=>event.id)).size,notices().length);
 assert.deepEqual(ledger(),[],'the ledger is empty once everything is delivered');
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 // the bound is explicit and never evicts: at the limit the NEWEST notice is refused (and logged), the older ones stay and are delivered
 resetAll();seed({count:3});elect();
 const limit=call('DISCOVERY_REPORT_FAULT_LIMIT');assert.equal(limit,8760,'a year of hourly notices');
 const gen=GENERATION.replace(/-/g,'').slice(0,12),tuples=Array.from({length:limit},(_,n)=>{const d=new Date(Date.UTC(2025,10,11,0)+n*HOUR).toISOString();return [gen,d.replace(/[-:]/g,'').slice(0,11),3,0];});
 set(FAULT_KEY,{schemaVersion:2,faults:tuples});
 context.DiscoveryAuthority.writeWorkflow=windowBusy;failEventPuts=true;
 const refused=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 assert.equal(refused.notice,'lost');assert.equal(ledger().length,limit,'no older entry was evicted to make room');assert.equal(ledger()[0][1],tuples[0][1],'the oldest is still there');assert.equal(warnings.at(-1).notice,'lost');
 failEventPuts=false;context.DiscoveryAuthority.writeWorkflow=realWrite;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);
 assert.equal(notices().length,drain);assert.equal(ledger().length,limit-drain,'the oldest ones were delivered and left');
}
// 10e. One hour, one event: a report always replaces the notice of its hour, a notice never replaces a report, and the deltas of a report are never dropped.
resetAll();seed({count:3});const own10e=elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 const windowBusy=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000};throw error;};
 const add=(n,added)=>call('settleWorkflowIfOwner')(env,own10e,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:5,added,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10e+':'+n,GENERATION)}));
 const hourEvents=()=>discoveryEvents().filter(event=>event.at===new Date(BASE).toISOString());
 // (a) the close fails and its notice is delivered; a duplicate or concurrent firing of the SAME hour then saves the close: exactly one visible event, and it is the report
 await add(1,2);
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0)).notice,'delivered');
 assert.deepEqual(hourEvents().map(event=>event.kind),['report_failed']);
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0)).closed,true);
 assert.deepEqual(hourEvents().map(event=>event.kind),['hour'],'exactly one event for the hour, and the report replaced the notice');
 assert.deepEqual([hourEvents()[0].added,hourEvents()[0].checked],[2,5],'the deltas were delivered once, not dropped');
 assert.equal(eventKeys().length,1,'one object in the journal');
 // a later duplicate firing of that hour changes nothing
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);assert.equal(eventKeys().length,1);assert.deepEqual(hourEvents().map(event=>event.kind),['hour']);
 // (b) a notice that arrives AFTER the report (a slower concurrent firing) never replaces it
 const late=call('discoveryReportFailedEvent')({at:new Date(BASE).toISOString(),hourKey:new Date(BASE).toISOString().replace(/[-:]/g,'').slice(0,11),generation:GENERATION,reason:'write_conflict',status:null});
 assert.equal(await call('deliverDiscoveryReportFailure')(env,late),'delivered');
 assert.deepEqual(hourEvents().map(event=>event.kind),['hour'],'the report stays, the late notice finds its hour taken');assert.equal(eventKeys().length,1);
 // (c) the ledger variant: the notice is queued while the journal refuses; the report of the same hour is then delivered first and the drain finds the hour taken
 resetAll();seed({count:3});const own10e2=elect();
 await call('settleWorkflowIfOwner')(env,own10e2,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:7,added:4,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10e2+':1',GENERATION)}));
 context.DiscoveryAuthority.writeWorkflow=windowBusy;failEventPuts=true;
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0)).notice,'queued');assert.equal(ledger().length,1);
 context.DiscoveryAuthority.writeWorkflow=realWrite;failEventPuts=false;
 // the next firing of the same hour drains first (the ledger notice is written), then its close succeeds and its report replaces it
 assert.equal((await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0)).closed,true);
 assert.deepEqual(hourEvents().map(event=>event.kind),['hour']);assert.equal(hourEvents()[0].added,4);assert.deepEqual(ledger(),[]);assert.equal(eventKeys().length,1);
 // (d) the report is delivered while the notice's ledger entry is still queued: the drain later finds the hour taken by the report, keeps it and empties the ledger
 resetAll();seed({count:3});const own10e3=elect();
 await call('settleWorkflowIfOwner')(env,own10e3,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:3,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10e3+':1',GENERATION)}));
 const hourKey0=new Date(BASE).toISOString().replace(/[-:]/g,'').slice(0,11);
 set(FAULT_KEY,{schemaVersion:2,faults:[[GENERATION.replace(/-/g,'').slice(0,12),hourKey0,4,0]]});
 const state=await call('readWorkflowState')(env),report=call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:hourKey0,generation:GENERATION,status:'running',reason:null,report:{...call('newDiscoveryReport')(null),chunks:1,added:1,checked:3},queue:{remaining:5,empty:false}});
 assert.equal(await call('writeDiscoveryEvent')(env,report),'written');
 assert.equal((await call('deliverDiscoveryReportFaults')(env)).delivered,1);assert.deepEqual(ledger(),[]);assert.deepEqual(hourEvents().map(event=>event.kind),['hour']);assert.equal(eventKeys().length,1);
 // (e) the replacement is a compare-and-swap: an interleaved writer makes it fail and the report stays in the outbox to be retried, never dropped
 resetAll();
 const noticeEvent=call('discoveryReportFailedEvent')({at:new Date(BASE).toISOString(),hourKey:hourKey0,generation:GENERATION,reason:'write_conflict',status:null});
 assert.equal(await call('writeDiscoveryEvent')(env,noticeEvent),'written');assert.equal(await call('writeDiscoveryEvent')(env,noticeEvent),'exists','a repeat of the notice keeps the first');
 const realGet=bucket.get;let interleaved=false;
 bucket.get=async(key,...rest)=>{const object=await realGet(key,...rest);if(!interleaved&&key.startsWith('events/items/')&&object){interleaved=true;await realPut(key,JSON.stringify({...noticeEvent,reason:'state_unreadable'}),{});}return object;};
 assert.equal(await call('writeDiscoveryEvent')(env,report),'failed','an interleaved writer: the compare-and-swap refuses, the caller keeps the report');
 bucket.get=realGet;
 assert.equal(await call('writeDiscoveryEvent')(env,report),'written','the retry replaces the notice');assert.equal(await call('writeDiscoveryEvent')(env,report),'exists');
 assert.deepEqual(hourEvents().map(event=>event.kind),['hour']);
}

// 10f. Settled and complete, zero backlog, the projector window held (the 15:00 UTC case of 11 Nov 2026): the close waits the window out, bounded; a window that outlasts
// the firing still yields the NORMAL empty report (provisional, no record write); and nothing is guessed when anything pending or unproven stands in the way.
{
 const settle=(generation=GENERATION)=>{
  resetAll();seed({stage:'complete',remaining:0,reason:null,count:3});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'complete',updatedAt:iso,waitingUntil:null,recovery:null});
  set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:generation,hopId:'hop-c',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,checked:0,error:null,at:iso});
  set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:'hop-c',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:generation});
 };
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 const windowBusy=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000,state:'held'};throw error;};
 const stopped={started:false,reason:'stopped',programmeRunId:GENERATION};
 const closeWith=(n,wait)=>call('closeHourlyDiscoveryReport')(env,stopped,{...cron(n),wait});
 const hourAt=n=>discoveryEvents().filter(event=>event.at===new Date(BASE+n*HOUR).toISOString());
 // (a) the window passes while the close waits: the normal report, closed for real (the record moved on), not provisional, no notice
 settle();let waits=0;
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 const normal=await closeWith(0,async()=>{waits++;context.DiscoveryAuthority.writeWorkflow=realWrite;});
 assert.equal(normal.closed,true);assert.equal(waits,1,'it waited the window out once');
 assert.deepEqual(hourAt(0).map(event=>[event.kind,event.status,event.queueEmpty,event.checked,event.added,event.provisional]),[['hour','empty',true,0,0,undefined]],'the normal empty report with proven zeros');
 assert.equal(workflowRecord().report.lastClosedHour,call('discoveryHourStamp')(BASE),'the hour is closed in the record');assert.equal(warnings.length,0);
 // (b) the window outlasts every try: the same empty report, provisional, no notice, the record untouched
 settle();waits=0;context.DiscoveryAuthority.writeWorkflow=windowBusy;
 const before=JSON.stringify(workflowRecord());
 const prov=await closeWith(0,async()=>{waits++;});
 assert.equal(prov.provisional,true);assert.equal(prov.closed,false);assert.equal(waits,2,'it waited between its three tries and no longer');
 assert.deepEqual(hourAt(0).map(event=>[event.kind,event.status,event.queueEmpty,event.remaining,event.checked,event.added,event.chunks,event.provisional,event.incomplete]),[['hour','empty',true,0,0,0,0,true,false]],'the normal empty report: proven zeros, no notice');
 assert.equal(notices().length,0);assert.equal(JSON.stringify(workflowRecord()),before,'no record write: the accumulator, outbox and lastClosedHour are untouched');
 assert.equal(warnings.some(entry=>entry.event==='discovery_hour_close_provisional'&&entry.reason==='projector_window'),true);assert.equal(warnings.some(entry=>entry.event==='discovery_hour_close_failed'),false,'it is not a failure');
 // a replay or a duplicate firing of the same hour finds the same event
 await closeWith(0,async()=>{});assert.equal(hourAt(0).length,1);assert.equal(eventKeys().length,1);
 // a report of the same hour that closes later replaces it and is never dropped (the deltas that arrived after the window are in it)
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 await call('settleWorkflowIfOwner')(env,INSTANCE,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:6,added:2,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:0,cheapRemaining:0,error:null},INSTANCE+':late',GENERATION)})).catch(()=>{});
 const late=await closeWith(0,async()=>{});
 assert.equal(late.closed,true);assert.equal(hourAt(0).length,1,'one event for the hour');assert.equal(eventKeys().length,1);
 assert.equal(hourAt(0)[0].provisional,undefined,'the report replaced the provisional one');
 // (c) pending deltas stand in the way: nothing is zeroed or claimed; the notice is the truthful line and the deltas stay
 settle();context.DiscoveryAuthority.writeWorkflow=realWrite;
 await call('settleWorkflowIfOwner')(env,INSTANCE,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:4,added:3,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:0,cheapRemaining:0,error:null},INSTANCE+':pending',GENERATION)})).catch(()=>{});
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 const pendingClose=await closeWith(0,async()=>{});
 assert.equal(pendingClose.provisional,undefined);assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed']);assert.equal(workflowRecord().report.added,3,'the deltas wait for a real close');
 // (d) a competing checkpoint lands while the close waits the window: the second read sees it and the real report carries it
 settle();context.DiscoveryAuthority.writeWorkflow=windowBusy;
 const raced=await closeWith(0,async()=>{
  context.DiscoveryAuthority.writeWorkflow=realWrite;
  await call('settleWorkflowIfOwner')(env,INSTANCE,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:5,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:0,cheapRemaining:0,error:null},INSTANCE+':race',GENERATION)})).catch(()=>{});
 });
 assert.equal(raced.closed,true);assert.deepEqual(hourAt(0).map(event=>[event.kind,event.added,event.checked,event.provisional]),[['hour',1,5,undefined]],'the delta that landed is reported once, never swallowed by a zero');
 // (e) the queue is not proven for this generation (another generation's status): no empty claim; the notice
 settle(OTHER);context.DiscoveryAuthority.writeWorkflow=windowBusy;
 await closeWith(0,async()=>{});assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed'],'an empty queue of another generation is not this one\'s');
 // a continuation that is not complete is not an empty queue either
 settle();set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:'h',remainingChunks:3,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});context.DiscoveryAuthority.writeWorkflow=windowBusy;
 await closeWith(0,async()=>{});assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed']);
 // (h) the shortcut is pinned: the record holds generation A while the outcome, status and continuation prove generation B (a rollover): no provisional empty, the notice
 settle(OTHER);set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'complete',updatedAt:iso,waitingUntil:null,recovery:null});
 context.DiscoveryAuthority.writeWorkflow=windowBusy;
 await call('closeHourlyDiscoveryReport')(env,{started:false,reason:'stopped',programmeRunId:OTHER},{...cron(0),wait:async()=>{}});
 assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed'],'a record of another generation never proves this one empty');
 // (i) the shortcut needs the confirmed empty status: a running or blocked reconcile with a separately observed zero queue publishes no empty event
 for(const outcome of [{started:true,reason:'started',programmeRunId:GENERATION},{started:false,reason:'in_progress',programmeRunId:GENERATION},{started:false,reason:'lease_held',programmeRunId:GENERATION}]){
  settle();context.DiscoveryAuthority.writeWorkflow=windowBusy;
  await call('closeHourlyDiscoveryReport')(env,outcome,{...cron(0),wait:async()=>{}});
  assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed'],'only a confirmed empty status takes the shortcut: '+outcome.reason);
 }
 // (f) a real write failure (a lost compare-and-swap, an unreadable record, no record) is never read as an empty queue
 settle();context.DiscoveryAuthority.writeWorkflow=async()=>({handled:true,saved:false});
 assert.equal((await closeWith(0,async()=>{})).reason,'write_conflict');assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed']);
 settle();records.delete('epg/discovery-workflow.json');context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.equal((await closeWith(0,async()=>{})).reason,'no_record');assert.deepEqual(hourAt(0).map(event=>event.kind),['report_failed']);
 // (g) the journal itself refuses the provisional report: it falls to the notice path (ledger), nothing is claimed
 settle();context.DiscoveryAuthority.writeWorkflow=windowBusy;failEventPuts=true;
 const refused=await closeWith(0,async()=>{});assert.equal(refused.provisional,undefined);assert.equal(refused.notice,'queued');
 failEventPuts=false;context.DiscoveryAuthority.writeWorkflow=realWrite;
}

// 10b. The hour closes and the deltas are real, but the queue cannot be read: the report keeps its numbers and says only that the remainder is unread.
resetAll();seed({count:3});const own10b=elect();
{
 await call('settleWorkflowIfOwner')(env,own10b,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:7,added:4,reused:1,screenedOut:2,touched:0,tmdbCalls:3,remaining:9,cheapRemaining:0,error:null},own10b+':1',OTHER)}));
 const realLoad=context.loadJSON,realCont=context.readContinuation;
 context.readContinuation=async()=>{throw new Error('continuation down');};
 const done=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 context.readContinuation=realCont;
 assert.equal(done.closed,true);
 const [event]=reports();
 assert.deepEqual([event.added,event.checked,event.reused,event.screenedOut,event.tmdbCalls,event.incomplete],[4,7,1,2,3,false],'the real deltas are kept');
 assert.deepEqual([event.remaining,event.queueEmpty,event.queueUnreadable],[null,false,true],'the unread remainder is not a zero and not an empty queue');
 assert.equal(warnings.length,0,'a persisted close is not a failure');
}

// 11. DST and hour identity: UTC hours, the repeated local hour of the clock change has two reports, a new generation is a new identity.
resetAll();seed({count:3});elect();
{
 const outcome={started:false,reason:'in_progress',programmeRunId:GENERATION};
 const fall=Date.UTC(2026,9,25,0),spring=Date.UTC(2026,2,29,0);
 for(const ms of [spring,spring+HOUR,fall,fall+HOUR,fall+2*HOUR])await call('closeHourlyDiscoveryReport')(env,outcome,{scheduled:true,now:ms+120000});
 const ids=reports().map(event=>event.id);assert.equal(new Set(ids).size,5,'two Madrid 02:00 hours are two reports; no hour merges or skips');
 assert.deepEqual(reports().map(event=>event.at).sort(),[spring,spring+HOUR,fall,fall+HOUR,fall+2*HOUR].map(ms=>new Date(ms).toISOString()));
 assert.ok(ids.includes('discovery-hour-a30f67e93a11-20261025T01'));
 const next=call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:OTHER,status:'running',reason:null,report:call('newDiscoveryReport')(null),queue:{remaining:null,empty:false},incomplete:false});
 assert.notEqual(next.id,hourId(GENERATION,0));
}

// 12. A newer generation replaces the record: the open accumulator and the outbox are carried, nothing is written at the replacement.
resetAll();seed({count:3});const own12=elect(0);
{
 await call('settleWorkflowIfOwner')(env,own12,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:8,added:5,reused:0,screenedOut:0,touched:0,tmdbCalls:2,remaining:0,cheapRemaining:0,error:null},own12+':1',GENERATION)}));
 const state=await call('readWorkflowState')(env);state.record.outbox=[{...call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:GENERATION,status:'running',reason:null,report:call('newDiscoveryReport')(null),queue:{remaining:1,empty:false},incomplete:false})}];
 set('epg/discovery-workflow.json',state.record);
 const stored=await call('readWorkflowState')(env);
 const created=await call('createWorkflowInstance')(env,OTHER,0,`discovery_${OTHER.replace(/-/g,'')}_0`,stored.etag,null,stored.record);
 assert.equal(created.started,true);assert.equal(reports().length,0,'a replacement writes no event of its own');
 assert.equal(workflowRecord().programmeRunId,OTHER);assert.equal(workflowRecord().report.added,5,'the deltas of the old generation are reported by the next hourly report');
 assert.equal(workflowRecord().outbox.length,1);
 // The deltas cross the change, the queue reading of the old generation does not: A's last chunk proved remaining 0 and cheapRemaining 0, and the
 // continuation of B says complete, yet B has no reading of its own, so B's report keeps A's counters and says its queue is unknown.
 set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:'hop-c',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OTHER});
 records.delete('epg/discovery-status.json');
 await call('closeHourlyDiscoveryReport')(env,{started:false,reason:'stopped',programmeRunId:OTHER},cron(1));
 assert.equal(reports().length,2);
 const b=reports().find(event=>event.id.includes(OTHER.replace(/-/g,'').slice(0,12)));
 assert.equal(b.added,5,'the committed deltas of the old generation are kept');assert.equal(b.checked,8);
 assert.equal(b.remaining,null,'the backlog of generation A is not generation B\'s');assert.equal(b.queueEmpty,false,'and neither is its empty state');assert.notEqual(b.status,'empty');
 // B's own chunk then speaks for B: it saves its status (the reading the proof needs, AIR-598) and its checkpoint, and adds its summary to the report.
 set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:OTHER,hopId:'hop-c',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,checked:2,error:null,at:iso});
 await call('settleWorkflowIfOwner')(env,`discovery_${OTHER.replace(/-/g,'')}_0`,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:2,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:0,remaining:0,cheapRemaining:0,error:null},'b:1',OTHER)}));
 await call('closeHourlyDiscoveryReport')(env,{started:false,reason:'stopped',programmeRunId:OTHER},cron(2));
 const c=reports().find(event=>event.at===new Date(BASE+2*HOUR).toISOString());assert.equal(c.remaining,0);assert.equal(c.queueEmpty,true);assert.equal(c.status,'empty');
 // A status file of another generation is not B's reading either.
 resetAll();seed({count:3});elect(0,OTHER);
 set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,hopId:'hop-c',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,checked:0,error:null,at:iso});
 set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:'hop-c',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OTHER});
 await call('closeHourlyDiscoveryReport')(env,{started:false,reason:'stopped',programmeRunId:OTHER},cron(1));
 assert.equal(reports()[0].queueEmpty,false);assert.equal(reports()[0].remaining,null);
}

// 13. Legacy: a settled undelivered per-chain tick is delivered once as it was, an open legacy tick is dropped, a legacy outbox entry is delivered.
resetAll();seed({count:3});elect();
{
 const tick={...{id:'t-1',programmeRunId:GENERATION,startedAt:iso,chunks:2,checked:20,added:2,reused:0,screenedOut:0,touched:0,tmdbCalls:4,remaining:7,cheapRemaining:0,error:null},settled:{at:iso,reason:'recovery_exhausted'},delivered:false};
 const record=workflowRecord();record.tick=tick;record.outbox=[{...tick,id:'t-0',settled:{at:iso,reason:'stale_generation'}}];set('epg/discovery-workflow.json',record);
 await call('deliverDiscoveryOutbox')(env);
 assert.deepEqual(reports().map(event=>event.id).sort(),['discovery-t-0','discovery-t-1']);
 assert.equal(reports().find(event=>event.id==='discovery-t-1').status,'failed');assert.equal(reports().find(event=>event.id==='discovery-t-0').status,'superseded');
 assert.equal(workflowRecord().tick,undefined);assert.deepEqual(outbox(),[]);
 const open=workflowRecord();open.tick={id:'t-2',programmeRunId:GENERATION,startedAt:iso,chunks:9,checked:90,added:9,settled:null};set('epg/discovery-workflow.json',open);
 await call('deliverDiscoveryOutbox')(env);
 assert.equal(workflowRecord().tick,undefined,'an open legacy tick is dropped');assert.equal(reports().length,2,'its lifetime totals are not a report');
}

// 14. The events API passes the new type through untouched and reading it writes nothing.
resetAll();seed({count:3});elect();
{
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 const stored=reports()[0],putsBefore=puts.length;
 const page=await call('eventPage')(env,null);
 assert.equal(JSON.stringify(page.events.filter(event=>event.type==='discovery')),JSON.stringify([stored]),'the event is returned exactly as stored');
 assert.equal(puts.length,putsBefore,'listing events writes nothing');
}

// 15. The pure helpers. The legacy per-chain predicate keeps its historical rule for the events of that model only (AIR-598: never a live proof); the strict
// zero reading of a hop needs all four parts a numeric zero.
{
 for(const unknown of [null,undefined,-1,0.5,'0',NaN])assert.equal(call('legacyTickQueueEmpty')(0,unknown,null),false,'an unproven cheap remainder is not a zero: '+String(unknown));
 for(const unknown of [null,undefined,-1,'0'])assert.equal(call('legacyTickQueueEmpty')(unknown,0,null),false);
 assert.equal(call('legacyTickQueueEmpty')(0,0,null),true);assert.equal(call('legacyTickQueueEmpty')(0,2,null),false);assert.equal(call('legacyTickQueueEmpty')(0,0,'x'),false);assert.equal(call('legacyTickQueueEmpty')(0,0,null,1),false);
 const zero=call('discoveryZeroStatus'),hop={hopId:'h'},full={programmeRunId:GENERATION,hopId:'h',remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null};
 assert.equal(zero(full,hop,GENERATION),true);
 for(const [name,value] of [['deferred',7],['deferred',undefined],['waitingRetry',null],['waitingRetry',undefined],['waitingRetry',-1],['remaining','0'],['hopId','other'],['error','x'],['programmeRunId',OTHER]])
  assert.equal(zero({...full,[name]:value},hop,GENERATION),false,name+'='+String(value));
 assert.equal(zero(full,{hopId:null},GENERATION),false,'a continuation without a hop proves nothing');
 assert.equal(call('discoveryHourStamp')(Date.UTC(2026,10,11,10,59,59)),'20261111T10');
}

// 16. AIR-534: a stopped series with a backlog and a recovery is never idle. Overdue is `stalled`, not yet due is `waiting`; a terminal stop with a backlog stays `idle`.
{
 const stoppedHour=async (n,{reason,dueAt})=>{
  resetAll();seed({stage:'paused',remaining:12,reason:'chunk_budget',count:3});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason,updatedAt:iso,waitingUntil:null,recovery:dueAt?{attempts:1,reason,at:iso,dueAt,quarantined:false}:null});
  await closed({started:false,reason:'stopped',programmeRunId:GENERATION},n);
  const [event]=reports();return event;
 };
 const overdue=await stoppedHour(20,{reason:'step_failure',dueAt:new Date(BASE+20*HOUR-60000).toISOString()});
 assert.equal(overdue.status,'stalled');assert.equal(overdue.reason,'recovery_overdue');assert.equal(overdue.queueEmpty,false);
 const waiting=await stoppedHour(21,{reason:'step_failure',dueAt:new Date(BASE+21*HOUR+3600000).toISOString()});
 assert.equal(waiting.status,'waiting');assert.equal(waiting.reason,'recovery_waiting');
 const terminal=await stoppedHour(22,{reason:'stale_generation',dueAt:new Date(BASE+22*HOUR-60000).toISOString()});
 assert.equal(terminal.status,'idle','a terminal stop is not an overdue recovery');
}

// 17. AIR-595: a series that drains with the legacy alias sweep still open (23 Nov 2026 22:00 UTC): the last chunk leaves no backlog, the continuation pauses on
// `chunk_budget` (the sweep keeps it from `complete`), the executor stops for good on `backlog_empty`. The full evidence of that one chunk proves the queue empty;
// anything missing, unknown, of another hop or of another generation does not, and a real idle stays idle.
{
 const HOP='c554872a-2b18-4b45-95c1-85b4630ffc6b';
 const drained=({record={},continuation={},status={},deleteStatus=false}={})=>{
  resetAll();seed({stage:'complete',remaining:0,reason:'chunk_budget',count:3});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:27,instanceId:INSTANCE,phase:'stopped',reason:'backlog_empty',updatedAt:iso,waitingUntil:null,recovery:null,...record});
  set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',at:iso,hopId:HOP,remainingChunks:0,nextCatchUpAt:new Date(now+HOUR).toISOString(),retryAt:null,programmeRunId:GENERATION,...continuation});
  set('epg/discovery-status.json',{schemaVersion:2,stage:'partial',programmeRunId:GENERATION,hopId:HOP,checked:0,added:0,remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null,legacyPending:true,at:iso,...status});
  if(deleteStatus)records.delete('epg/discovery-status.json');
 };
 const hourOf=async(n=0)=>{await closed({started:false,reason:'stopped',programmeRunId:GENERATION},n);const list=reports();assert.equal(list.length,1);return list[0];};
 drained();
 const empty=await hourOf();
 assert.deepEqual([empty.status,empty.reason,empty.queueEmpty,empty.remaining,empty.queueUnreadable],['empty','queue_empty',true,0,false],'the drained series is the proven empty queue');
 for(const name of Object.keys(ZERO))assert.equal(empty[name],0,'real counters: '+name);
 // The 20:00 UTC case: the chunks that drained the queue are in the same period. Their counters are kept as they are and the queue is still proven empty.
 drained();
 await call('settleWorkflowIfOwner')(env,INSTANCE,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:459,added:20,reused:10,screenedOut:0,touched:7,tmdbCalls:704,remaining:0,cheapRemaining:0,error:null},INSTANCE+':50',GENERATION)}));
 const busy=await hourOf();
 assert.deepEqual([busy.status,busy.queueEmpty,busy.remaining,busy.added,busy.checked,busy.tmdbCalls,busy.chunks],['empty',true,0,20,459,704,1],'the drained period keeps its real deltas');
 const idle=(label,setup)=>async()=>{setup();const event=await hourOf();assert.equal(event.queueEmpty,false,label);assert.equal(event.status,'idle',label);return event;};
 for(const [label,patch] of [['remaining unknown',{remaining:null}],['remaining left',{remaining:3}],['cheap pass left',{cheapRemaining:2}],['cheap unknown',{cheapRemaining:null}],['deferred left',{deferred:1}],['deferred unknown',{deferred:undefined}],['waiting retry',{waitingRetry:4}],['waiting retry unknown',{waitingRetry:null}],['status error',{error:'tmdb_unavailable'}],['another hop',{hopId:'other-hop'}],['no hop',{hopId:undefined}],['another generation',{programmeRunId:OTHER}]])
  await idle('status: '+label,()=>drained({status:patch}))();
 await idle('no status',()=>drained({deleteStatus:true}))();
 for(const [label,patch] of [['a chunk is still owed',{remainingChunks:1}],['plain pause',{reason:null}],['backoff',{reason:'backoff'}],['another generation',{programmeRunId:OTHER}],['no hop',{hopId:null}]])
  await idle('continuation: '+label,()=>drained({continuation:patch}))();
 // A terminal stop for another reason is a real idle with whatever backlog it read; the executor record of another generation proves nothing for this one.
 const stale=await idle('record: stale_generation',()=>drained({record:{reason:'stale_generation'}}))();assert.equal(stale.reason,'stale_generation');
 await idle('record: another generation',()=>drained({record:{programmeRunId:OTHER}}))();
 // A non-terminal stop with a recovery due is not idle and never empty.
 drained({record:{reason:'step_failure',recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(BASE-60000).toISOString(),quarantined:false}}});
 const overdue=await hourOf();assert.equal(overdue.status,'stalled');assert.equal(overdue.queueEmpty,false);
 // Only a reconcile that confirmed the stop makes it empty: a running or refused firing keeps its own status.
 drained();await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);assert.equal(reports()[0].status,'running');
 // An unreadable status on this path is the unreadable queue, never a zero.
 drained();const realGet=bucket.get;
 bucket.get=async(key,...rest)=>{if(key==='epg/discovery-status.json')throw new Error('d1 down');return realGet(key,...rest);};
 const unread=await hourOf();bucket.get=realGet;
 assert.deepEqual([unread.queueEmpty,unread.queueUnreadable,unread.remaining],[false,true,null]);
 // The pure predicates.
 const series=call('discoveryDrainedSeries'),statusOk=call('discoveryZeroStatus');
 const cont={programmeRunId:GENERATION,stage:'paused',reason:'chunk_budget',remainingChunks:0,hopId:HOP};
 assert.equal(series({phase:'stopped',reason:'backlog_empty',programmeRunId:GENERATION},cont,GENERATION),true);
 assert.equal(series({phase:'stopped',reason:'backlog_empty',programmeRunId:GENERATION},cont,null),false,'no generation proves nothing');
 assert.equal(series({phase:'running',reason:'backlog_empty',programmeRunId:GENERATION},cont,GENERATION),false);
 assert.equal(series(null,cont,GENERATION),false);
 assert.equal(statusOk({programmeRunId:GENERATION,hopId:HOP,remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null},cont,GENERATION),true);
 for(const bad of ['0',-0.5,null,undefined,1])assert.equal(statusOk({programmeRunId:GENERATION,hopId:HOP,remaining:bad,cheapRemaining:0,deferred:0,waitingRetry:0,error:null},cont,GENERATION),false,'not a proven zero: '+String(bad));
 assert.equal(statusOk(null,cont,GENERATION),false);
}

// 18. AIR-595: the EPG-priority pause (ADR 0135) refuses the close (23 Nov 2026 16:00 UTC). It is named `epg_priority`, never `write_conflict`, it is not retried inside
// the firing, the accumulator is untouched, and a genuine lost compare-and-swap is still `write_conflict`. When the pause lifts the next report carries every delta once.
resetAll();seed({count:3});const own18=elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 let refusals=0;
 const paused=async()=>{refusals++;const error=new Error('priority');error.code='discovery_epg_priority';error.priority={kind:'epg_priority',nextCatchUpAt:new Date(Date.now()+60000).toISOString(),ownerKind:'none',owedDayKey:'2026-11-23'};throw error;};
 const add=(n,added)=>call('settleWorkflowIfOwner')(env,own18,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:4,added,reused:0,screenedOut:0,touched:0,tmdbCalls:2,remaining:9,cheapRemaining:0,error:null},own18+':'+n,GENERATION)}));
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 await add(1,3);   // an in-flight chunk that held the lease committed before the pause
 context.DiscoveryAuthority.writeWorkflow=paused;
 const stopped=await closed({started:false,reason:'stopped',programmeRunId:GENERATION},1);
 assert.equal(stopped.closed,false);assert.equal(stopped.reason,'epg_priority');assert.equal(stopped.notice,'delivered');
 assert.equal(refusals,1,'the pause is not retried as a lost compare-and-swap inside the firing');
 const [n1]=notices();
 assert.deepEqual([n1.kind,n1.reason,n1.status],['report_failed','epg_priority',null],'the pause is the reason; an idle chain names no state');
 assert.equal(n1.id,hourId(GENERATION,1),'the canonical identity of the hour');
 for(const name of ['checked','added','reused','screenedOut','touched','tmdbCalls','chunks','remaining','queueEmpty'])assert.equal(Object.hasOwn(n1,name),false,'no counter is invented: '+name);
 assert.equal(workflowRecord().report.added,3,'the deltas wait in the accumulator');
 assert.equal(warnings.some(entry=>entry.event==='discovery_hour_close_failed'&&entry.reason==='epg_priority'),true,'the log names the pause');
 // The reconcile of the same firing refused by the same pause: still no other state is named. A different confirmed state is named beside the pause.
 await closed({started:false,reason:'epg_priority',programmeRunId:GENERATION},2);
 await closed({started:false,reason:'recovery_exhausted',programmeRunId:GENERATION},3);
 await closed({started:false,reason:'authority_held',programmeRunId:GENERATION},4);
 assert.deepEqual(notices().map(event=>[event.reason,event.status]),[['epg_priority',null],['epg_priority',null],['epg_priority','failed'],['epg_priority','blocked']]);
 // A repeat of a paused hour keeps one notice.
 await closed({started:false,reason:'stopped',programmeRunId:GENERATION},4);assert.equal(notices().length,4);
 // The journal refuses the notice: it is queued in the v2 ledger (an older Worker cannot decode it), never in the old one, and delivered unchanged later.
 failEventPuts=true;assert.equal((await closed({started:false,reason:'stopped',programmeRunId:GENERATION},5)).notice,'queued');failEventPuts=false;
 assert.deepEqual(ledger(),[],'nothing an older Worker cannot decode goes to the old ledger');
 assert.deepEqual(ledgerV2()[0].slice(2),[5,0,0],'the appended reason index, no fault');
 assert.deepEqual(JSON.parse(JSON.stringify(call('decodeDiscoveryReportFault')(ledgerV2()[0]))),{id:hourId(GENERATION,5),type:'discovery',kind:'report_failed',at:new Date(BASE+5*HOUR).toISOString(),generation:GENERATION.replace(/-/g,'').slice(0,8),reason:'epg_priority',status:null});
 assert.deepEqual(call('decodeDiscoveryReportFault')([GENERATION.replace(/-/g,'').slice(0,12),'20261111T10',4,0]).reason,'write_conflict','older tuples decode unchanged');
 // The pause lifts (the publication is certified): the next firing drains the ledger, closes its hour and reports the held deltas once.
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 await add(2,2);
 const released=await closed({started:false,reason:'stopped',programmeRunId:GENERATION},6);
 assert.equal(released.closed,true);assert.deepEqual(ledgerV2(),[]);assert.equal(notices().find(event=>event.id===hourId(GENERATION,5)).reason,'epg_priority','the queued pause notice was delivered as it was');
 const after=reports().filter(event=>event.at===new Date(BASE+6*HOUR).toISOString());
 assert.equal(after.length,1);assert.equal(after[0].added,5,'held and new deltas, once');assert.equal(after[0].from,new Date(BASE).toISOString(),'the report reaches back to the last closed hour');
 assert.equal(sumOf(reports(),'added'),5,'nothing doubled or lost');assert.equal(workflowRecord().report.added,0);
 // A genuine lost compare-and-swap is still `write_conflict`, retried within the firing as before.
 let conflicts=0;context.DiscoveryAuthority.writeWorkflow=async()=>{conflicts++;return {handled:true,saved:false};};
 assert.equal((await closed({started:false,reason:'stopped',programmeRunId:GENERATION},7)).reason,'write_conflict');
 assert.equal(conflicts,call('DISCOVERY_REPORT_CLOSE_ATTEMPTS'));
 assert.deepEqual(notices().at(-1).reason,'write_conflict');
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 // A close that the gate admits during the pause, with the reconcile refused by it: a real report with proven counters, status blocked, reason epg_priority.
 await closed({started:false,reason:'epg_priority',programmeRunId:GENERATION},8);
 const blocked=reports().find(event=>event.at===new Date(BASE+8*HOUR).toISOString());
 assert.deepEqual([blocked.kind,blocked.status,blocked.reason,blocked.added],['hour','blocked','epg_priority',0]);
}

// 18b. AIR-595 review P1: an independent queue read failure in the same close is never hidden behind the planned pause. The notice keeps the pause AND the read
// fault (`fault: 'queue_unreadable'`), through the v2 ledger and its replay, with no counter; the clean pause stays as it was; after the release the deltas come once.
resetAll();seed({count:3});const own18b=elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow,realCont=context.readContinuation;
 const paused=async()=>{const error=new Error('priority');error.code='discovery_epg_priority';error.priority={kind:'epg_priority',nextCatchUpAt:new Date(Date.now()+60000).toISOString(),ownerKind:'none',owedDayKey:'2026-11-23'};throw error;};
 const add=(n,added)=>call('settleWorkflowIfOwner')(env,own18b,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:5,added,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:7,cheapRemaining:0,error:null},own18b+':'+n,GENERATION)}));
 await add(1,4);
 context.DiscoveryAuthority.writeWorkflow=paused;
 // the clean pause, for comparison
 await closed({started:false,reason:'stopped',programmeRunId:GENERATION},0);
 assert.equal(Object.hasOwn(notices()[0],'fault'),false,'a clean pause carries no fault');
 // the continuation read throws in the same close: the pause and the read failure are both stated
 context.readContinuation=async()=>{throw new Error('continuation down');};
 const both=await closed({started:false,reason:'stopped',programmeRunId:GENERATION},1);
 assert.equal(both.reason,'epg_priority');
 const [,n1]=notices();
 assert.deepEqual([n1.kind,n1.reason,n1.status,n1.fault],['report_failed','epg_priority',null,'queue_unreadable']);
 for(const name of ['checked','added','remaining','queueEmpty','queueUnreadable'])assert.equal(Object.hasOwn(n1,name),false,'no counter or queue number: '+name);
 assert.equal(warnings.filter(entry=>entry.event==='discovery_hour_close_failed').at(-1).fault,'queue_unreadable','the log names the read failure too');
 // the journal refuses: the combined notice waits in the v2 ledger with its fault index, and a replay rebuilds exactly the same notice
 failEventPuts=true;
 assert.equal((await closed({started:false,reason:'stopped',programmeRunId:GENERATION},3)).notice,'queued');
 failEventPuts=false;
 assert.deepEqual(ledger(),[]);assert.deepEqual(ledgerV2()[0].slice(2),[5,0,1]);
 const rebuilt=JSON.parse(JSON.stringify(call('decodeDiscoveryReportFault')(ledgerV2()[0])));
 assert.deepEqual([rebuilt.reason,rebuilt.status,rebuilt.fault],['epg_priority',null,'queue_unreadable'],'the fault survives the ledger');
 // a clean pause queued beside it keeps no fault
 failEventPuts=true;context.readContinuation=realCont;await closed({started:false,reason:'stopped',programmeRunId:GENERATION},4);failEventPuts=false;
 assert.deepEqual(ledgerV2().map(tuple=>tuple[4]),[1,0]);
 assert.equal(workflowRecord().report.added,4,'the accumulator is untouched through every refusal');
 // release: the next firing drains both, replays the notices unchanged and reports the held deltas once
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 await add(2,1);
 const released=await closed({started:false,reason:'stopped',programmeRunId:GENERATION},5);
 assert.equal(released.closed,true);assert.deepEqual(ledgerV2(),[]);
 const replayed=notices().filter(event=>[3,4].some(n=>event.id===hourId(GENERATION,n)));
 assert.deepEqual(replayed.map(event=>event.fault??null),['queue_unreadable',null],'a replay keeps a combined fault distinct from a clean pause');
 const report=reports().find(event=>event.at===new Date(BASE+5*HOUR).toISOString());
 assert.equal(report.added,5);assert.equal(sumOf(reports(),'added'),5,'exactly once');
 // a fault index or tuple shape the reader does not know is refused, never guessed
 assert.equal(call('decodeDiscoveryReportFault')([GENERATION.replace(/-/g,'').slice(0,12),'20261111T10',5,0,2]),null);
 assert.equal(call('decodeDiscoveryReportFault')([GENERATION.replace(/-/g,'').slice(0,12),'20261111T10',5,0]),null,'a four-element tuple never carries a reason an older Worker cannot decode');
}

// 18b'. The status read (the path without chunks in the period) that throws beside the pause is the same independent fault.
resetAll();seed({count:3});elect();
{
 const realWrite=context.DiscoveryAuthority.writeWorkflow,realGet=bucket.get;
 context.DiscoveryAuthority.writeWorkflow=async()=>{const error=new Error('priority');error.code='discovery_epg_priority';error.priority={nextCatchUpAt:new Date(Date.now()+60000).toISOString()};throw error;};
 bucket.get=async(key,...rest)=>{if(key==='epg/discovery-status.json')throw new Error('status down');return realGet(key,...rest);};
 await closed({started:false,reason:'stopped',programmeRunId:GENERATION},0);
 bucket.get=realGet;context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.deepEqual([notices()[0].reason,notices()[0].fault],['epg_priority','queue_unreadable']);
}

// 18c. AIR-595 review: rollback. The ledger reader of the Worker before AIR-595, verbatim (its five reasons, five statuses, four-element tuples). It drops any tuple it
// cannot decode when it writes the ledger back, so the old ledger must only ever hold tuples it decodes; the v2 ledger is a key it never reads or writes.
{
 const OLD_REASONS=['no_record','state_unreadable','outbox_full','projector_window','write_conflict'],OLD_STATUSES=[null,'failed','waiting','blocked','stalled'];
 const oldDecode=tuple=>{
  if(!Array.isArray(tuple)||tuple.length!==4)return null;
  const [generation,hourKey,reason,status]=tuple;
  if(typeof generation!=='string'||!/^[0-9A-Za-z]{1,12}$/.test(generation)||typeof hourKey!=='string'||!/^\d{8}T\d{2}$/.test(hourKey))return null;
  if(!Number.isInteger(reason)||reason<0||reason>=OLD_REASONS.length||!Number.isInteger(status)||status<0||status>=OLD_STATUSES.length)return null;
  return {reason:OLD_REASONS[reason],status:OLD_STATUSES[status]};
 };
 resetAll();seed({count:3});elect();
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 const paused=async()=>{const error=new Error('priority');error.code='discovery_epg_priority';error.priority={nextCatchUpAt:new Date(Date.now()+60000).toISOString()};throw error;};
 failEventPuts=true;
 context.DiscoveryAuthority.writeWorkflow=async()=>({handled:true,saved:false});await closed({started:false,reason:'recovery_exhausted',programmeRunId:GENERATION},0);
 context.DiscoveryAuthority.writeWorkflow=paused;await closed({started:false,reason:'stopped',programmeRunId:GENERATION},1);
 context.DiscoveryAuthority.writeWorkflow=paused;await closed({started:false,reason:'recovery_exhausted',programmeRunId:GENERATION},2);
 failEventPuts=false;context.DiscoveryAuthority.writeWorkflow=realWrite;
 assert.equal(ledger().length,1);assert.equal(ledgerV2().length,2);
 assert.equal(ledger().every(tuple=>oldDecode(tuple)!==null),true,'every tuple of the old ledger is readable by the older Worker');
 assert.deepEqual(oldDecode(ledger()[0]),{reason:'write_conflict',status:'failed'});
 assert.equal(ledgerV2().every(tuple=>oldDecode(tuple)===null),true,'the v2 tuples are exactly the ones it could not read, so they are kept out of its ledger');
 // The older Worker runs (rollback): it rewrites its own ledger with what it decodes and adds a notice; the v2 object is never touched.
 const v2Before=JSON.stringify(records.get(FAULT_KEY_V2));
 const oldFaults=ledger().filter(tuple=>oldDecode(tuple)!==null);
 set(FAULT_KEY,{schemaVersion:2,faults:[...oldFaults,[GENERATION.replace(/-/g,'').slice(0,12),'20261111T13',3,0]]});
 assert.equal(JSON.stringify(records.get(FAULT_KEY_V2)),v2Before,'nothing pending in v2 is evicted by the older Worker');
 // Roll forward: the next firing delivers all of them, each once.
 await closed({started:false,reason:'stopped',programmeRunId:GENERATION},4);
 assert.deepEqual(ledger(),[]);assert.deepEqual(ledgerV2(),[]);
 assert.deepEqual(notices().map(event=>[event.at.slice(11,13),event.reason]),[['10','write_conflict'],['11','epg_priority'],['12','epg_priority'],['13','projector_window']]);
 assert.equal(notices().find(event=>event.at.slice(11,13)==='12').status,'failed');
}

// 18d. AIR-595 re-review: the two ledger objects are ONE logical ledger under ADR 0118. Oldest hour first across both, at most 64 journal puts a firing in total even
// when the cleanup of one object throws (a thrown put, or a thrown read after a refused compare-and-swap), the 8,760 bound counts both, one entry per hour across both,
// and an uncertain cleanup recovers idempotently.
{
 const gen=GENERATION.replace(/-/g,'').slice(0,12),drain=call('DISCOVERY_REPORT_FAULT_DRAIN'),limit=call('DISCOVERY_REPORT_FAULT_LIMIT');
 const hourKey=n=>new Date(Date.UTC(2026,9,1,0)+n*HOUR).toISOString().replace(/[-:]/g,'').slice(0,11);
 const v1=n=>[gen,hourKey(n),4,0],v2=n=>[gen,hourKey(n),5,0,0];
 const realBucketPut=bucket.put,realBucketGet=bucket.get;
 let eventAttempts=0;
 const counting=async(key,...rest)=>{if(key.startsWith('events/items/'))eventAttempts++;return realBucketPut(key,...rest);};
 const deliver=()=>call('deliverDiscoveryReportFaults')(env);
 // (a) oldest first across the objects: v2 holds the older hours (a rollback, then a newer outage of the older reasons)
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:[v1(10),v1(11)]});set(FAULT_KEY_V2,{schemaVersion:2,faults:[v2(1),v2(2),v2(12)]});
 const ordered=[];bucket.put=async(key,value,...rest)=>{if(key.startsWith('events/items/'))ordered.push(JSON.parse(value).at.slice(5,13));return realBucketPut(key,value,...rest);};
 assert.deepEqual(JSON.parse(JSON.stringify(await deliver())),{delivered:5,pending:0,attempted:5});
 bucket.put=realBucketPut;
 assert.deepEqual(ordered,[1,2,10,11,12].map(n=>new Date(Date.UTC(2026,9,1,0)+n*HOUR).toISOString().slice(5,13)),'one oldest-first order across both objects');
 // (b) both objects full beyond one drain: one firing makes exactly the drain bound of journal puts, the oldest across both
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v1(2*i+1))});set(FAULT_KEY_V2,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v2(2*i))});
 eventAttempts=0;bucket.put=counting;
 const both=await deliver();
 assert.equal(eventAttempts,drain,'one firing, one bound');assert.equal(both.attempted,drain);assert.equal(both.pending,drain);
 assert.equal(ledger().length,drain/2);assert.equal(ledgerV2().length,drain/2,'the oldest half of each was delivered');
 // (c) the cleanup put of the old object throws after the journal puts: the bound is not refunded to the other object, the answer is uncertain
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v1(i))});set(FAULT_KEY_V2,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v2(drain+i))});
 eventAttempts=0;
 bucket.put=async(key,...rest)=>{if(key===FAULT_KEY)throw new Error('ledger put failed');return counting(key,...rest);};
 const thrown=await deliver();
 assert.equal(eventAttempts,drain,'a thrown cleanup put does not let the other object spend another bound');
 assert.equal(thrown.pending,null,'uncertain');assert.equal(ledger().length,drain,'the old object kept its entries');assert.equal(ledgerV2().length,drain,'the v2 entries were not attempted');
 // recovery: the next firing finds the delivered hours `exists`, removes them and spends no more than the bound
 bucket.put=counting;eventAttempts=0;
 const recovered=await deliver();
 assert.equal(eventAttempts,drain);assert.equal(recovered.pending,drain);assert.deepEqual(ledger(),[]);assert.equal(ledgerV2().length,drain);
 await deliver();assert.deepEqual(ledgerV2(),[]);
 assert.equal(notices().length,2*drain,'every hour delivered exactly once');assert.equal(new Set(notices().map(event=>event.id)).size,2*drain);
 // (d) a refused compare-and-swap followed by a thrown read: the same bound, uncertain, then idempotent recovery
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v1(i))});set(FAULT_KEY_V2,{schemaVersion:2,faults:Array.from({length:drain},(_,i)=>v2(drain+i))});
 eventAttempts=0;let refusedOnce=false,reads=0;
 bucket.put=async(key,...rest)=>{if(key===FAULT_KEY&&!refusedOnce){refusedOnce=true;return null;}return counting(key,...rest);};
 bucket.get=async(key,...rest)=>{if(key===FAULT_KEY&&refusedOnce&&reads++>=0)throw new Error('ledger read failed');return realBucketGet(key,...rest);};
 const reread=await deliver();
 bucket.get=realBucketGet;
 assert.equal(eventAttempts,drain);assert.equal(reread.pending,null);assert.equal(ledgerV2().length,drain);
 bucket.put=counting;eventAttempts=0;
 await deliver();await deliver();
 assert.deepEqual(ledger(),[]);assert.deepEqual(ledgerV2(),[]);assert.equal(new Set(notices().map(event=>event.id)).size,2*drain);
 bucket.put=realBucketPut;
 // (e) the 8,760 bound counts both objects
 const fill=(oldCount,newCount)=>{resetAll();seed({count:3});elect();
  set(FAULT_KEY,{schemaVersion:2,faults:Array.from({length:oldCount},(_,i)=>v1(i))});set(FAULT_KEY_V2,{schemaVersion:2,faults:Array.from({length:newCount},(_,i)=>v2(oldCount+i))});};
 const pausedWrite=async()=>{const error=new Error('priority');error.code='discovery_epg_priority';error.priority={nextCatchUpAt:new Date(Date.now()+60000).toISOString()};throw error;};
 const realWrite=context.DiscoveryAuthority.writeWorkflow;
 for(const [label,writer] of [['a pause notice (v2)',pausedWrite],['an older reason (old object)',async()=>({handled:true,saved:false})]]){
  fill(limit-1,1);context.DiscoveryAuthority.writeWorkflow=writer;failEventPuts=true;
  const full=await call('deliverDiscoveryReportFailure')(env,call('discoveryReportFailedEvent')({at:'2028-11-11T10:00:00.000Z',hourKey:'20281111T10',generation:GENERATION,reason:writer===pausedWrite?'epg_priority':'write_conflict',status:null}));
  assert.equal(full,'lost',label+': at the logical bound the newest is refused');assert.equal(ledger().length+ledgerV2().length,limit,'nothing evicted');
  fill(limit-2,1);context.DiscoveryAuthority.writeWorkflow=writer;failEventPuts=true;
  const room=await call('deliverDiscoveryReportFailure')(env,call('discoveryReportFailedEvent')({at:'2028-11-11T10:00:00.000Z',hourKey:'20281111T10',generation:GENERATION,reason:writer===pausedWrite?'epg_priority':'write_conflict',status:null}));
  assert.equal(room,'queued',label+': below the logical bound it is queued');assert.equal(ledger().length+ledgerV2().length,limit);
  failEventPuts=false;
 }
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 // (f) one entry per hour across both objects: a pause notice of an hour already queued with an older reason is not queued twice
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:[[gen,'20261111T10',4,0]]});failEventPuts=true;
 assert.equal(await call('deliverDiscoveryReportFailure')(env,call('discoveryReportFailedEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:GENERATION,reason:'epg_priority',status:null})),'queued');
 failEventPuts=false;assert.equal(ledger().length,1);assert.deepEqual(ledgerV2(),[],'no second entry for the hour');
}

// 18e. AIR-595 re-review: what two SIMULTANEOUS admissions to DIFFERENT objects can do (deterministic interleaving). Each object has its own compare-and-swap, so
// the combined check is best effort: two writers that read the same 8,759 can each add one entry (8,761). The next admission sees the bound and is refused, nothing is
// evicted, the drain stays at 64 a firing. A concurrent repeat of one hour with two reason classes can queue two tuples, and the journal still shows one event.
{
 const gen=GENERATION.replace(/-/g,'').slice(0,12),limit=call('DISCOVERY_REPORT_FAULT_LIMIT'),drain=call('DISCOVERY_REPORT_FAULT_DRAIN');
 const hourKey=n=>new Date(Date.UTC(2026,9,1,0)+n*HOUR).toISOString().replace(/[-:]/g,'').slice(0,11);
 const realBucketGet=bucket.get;
 const notice=(reason,hour='20281111T10',at='2028-11-11T10:00:00.000Z')=>call('discoveryReportFailedEvent')({at,hourKey:hour,generation:GENERATION,reason,status:null});
 // The first writer has read both objects; the second runs completely in between; the first then writes from its stale view.
 const interleave=async(first,second)=>{
  let armed=true,inner=null;
  bucket.get=async(key,...rest)=>{
   const object=await realBucketGet(key,...rest);
   if(armed&&key===FAULT_KEY_V2){armed=false;inner=await call('deliverDiscoveryReportFailure')(env,second);}
   return object;
  };
  try{return [await call('deliverDiscoveryReportFailure')(env,first),inner];}finally{bucket.get=realBucketGet;}
 };
 resetAll();
 set(FAULT_KEY,{schemaVersion:2,faults:Array.from({length:limit-1},(_,i)=>[gen,hourKey(i),4,0])});
 failEventPuts=true;
 const [a,b]=await interleave(notice('write_conflict'),notice('epg_priority','20281111T11','2028-11-11T11:00:00.000Z'));
 assert.deepEqual([a,b],['queued','queued'],'two simultaneous writers on different objects both pass the combined check');
 assert.equal(ledger().length+ledgerV2().length,limit+1,'the bound can be exceeded by the simultaneous writers, one entry each');
 assert.equal(await call('deliverDiscoveryReportFailure')(env,notice('write_conflict','20281111T12','2028-11-11T12:00:00.000Z')),'lost','the next admission sees the bound and is refused');
 assert.equal(ledger().length+ledgerV2().length,limit+1,'nothing evicted');
 failEventPuts=false;
 let puts=0;const realBucketPut=bucket.put;bucket.put=async(key,...rest)=>{if(key.startsWith('events/items/'))puts++;return realBucketPut(key,...rest);};
 await call('deliverDiscoveryReportFaults')(env);bucket.put=realBucketPut;
 assert.equal(puts,drain,'the drain bound holds');
 // the same hour, two reason classes, simultaneously: two tuples, one visible event
 resetAll();failEventPuts=true;
 const [c,d]=await interleave(notice('write_conflict'),notice('epg_priority'));
 assert.deepEqual([c,d],['queued','queued']);assert.equal(ledger().length,1);assert.equal(ledgerV2().length,1);
 failEventPuts=false;
 await call('deliverDiscoveryReportFaults')(env);
 assert.deepEqual(ledger(),[]);assert.deepEqual(ledgerV2(),[]);
 assert.equal(notices().length,1,'one hour, one visible event');
}

// 19. AIR-595: a new generation started by the reconcile carries the accumulator, the outbox and the last closed hour of the previous record (the 17:00 UTC report
// of 23 Nov 2026 had `from: null` because they were dropped). Nothing is lost or reported twice across the change.
resetAll();
{
 seed({count:3,programmeRunId:OTHER,published:OTHER,remaining:12,reason:'epg_committed'});
 armWorkflowAdmission(OTHER);
 const pending=call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:GENERATION,status:'idle',reason:null,report:call('newDiscoveryReport')(null),queue:{remaining:0,empty:false}});
 const report={...call('addChunkToDiscoveryReport')(call('newDiscoveryReport')(new Date(BASE).toISOString()),{checked:6,added:2,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:0,cheapRemaining:0,error:null},INSTANCE+':9',GENERATION),lastClosedHour:'20261111T10'};
 set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:27,instanceId:INSTANCE,phase:'stopped',reason:'backlog_empty',updatedAt:iso,waitingUntil:null,recovery:null,report,outbox:[pending],rollover:{requestId:'r-1'}});
 const started=await call('ensureDiscoveryWorkflow')(env);
 assert.equal(started.started,true);assert.equal(started.series,0);
 const record=workflowRecord();
 assert.equal(record.programmeRunId,OTHER);
 assert.equal(record.report.added,2,'the open deltas are carried');assert.equal(record.report.lastClosedHour,'20261111T10','the last closed hour is carried');assert.equal(record.report.since,new Date(BASE).toISOString());
 assert.equal(record.outbox.length,1,'the undelivered report is carried');assert.deepEqual(JSON.parse(JSON.stringify(record.rollover)),{requestId:'r-1'});
 assert.equal(record.recovery,null,'the recovery of the old series is not carried');
 await closed({started:true,reason:'started',programmeRunId:OTHER},1);
 const next=reports().find(event=>event.at===new Date(BASE+HOUR).toISOString());
 assert.equal(next.added,2);assert.equal(next.from,new Date(BASE).toISOString(),'the period reaches back to the last closed hour, not null');
 assert.equal(reports().length,2,'the carried report and the new hour, once each');
 armWorkflowAdmission();
}

bucket.put=realPut;
console.log('Discovery events: hourly reports with deltas across rollovers, duplicate/late/missed crons, every state, strict empty queue, replay-safe counts, checkpoint race, outbox recovery and cap, unknown never shown as 0, DST hours, generation handoff and legacy delivery passed');
