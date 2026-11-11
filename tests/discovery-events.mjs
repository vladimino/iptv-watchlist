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

// ---------- AIR-410 v2: one `discovery` report per scheduled hourly firing ----------
const BASE=Date.UTC(2026,10,11,10),HOUR=3600000;
const cron=n=>({scheduled:true,now:BASE+n*HOUR+(n%2)*1000});
const reports=()=>discoveryEvents().sort((a,b)=>a.at<b.at?-1:1);
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
 assert.deepEqual(Object.keys(list[1]).sort(),['added','at','checked','chunks','error','from','generation','id','incomplete','kind','queueEmpty','reason','remaining','reused','screenedOut','status','tmdbCalls','touched','type'].sort(),'a compact event: counters only, no film titles');
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
 assert.equal((await closed({reason:'stopped'},5,{...env,DISCOVERY_EXECUTOR:'external'})).reason,'not_workflow');
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

// 5. Empty queue is claimed only when proven: both remainders are numeric zero, no error, the continuation complete for the generation.
{
 const hour=BASE;
 const confirmed=(label,mutate,expectEmpty)=>async()=>{
  resetAll();seed({stage:'complete',remaining:0,reason:null,count:3});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'complete',updatedAt:iso,waitingUntil:null,recovery:null});
  set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:0,checked:0,error:null,at:iso});
  set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  mutate();
  await closed({started:false,reason:'stopped',programmeRunId:GENERATION},0);
  const [event]=reports();assert.equal(reports().length,1,label);
  assert.equal(event.queueEmpty,expectEmpty,label);assert.equal(event.status,expectEmpty?'empty':'idle',label);
  return event;
 };
 const empty=await confirmed('proven empty',()=>{},true)();
 assert.equal(empty.reason,'queue_empty');assert.equal(empty.remaining,0);for(const name of Object.keys(ZERO))assert.equal(empty[name],0);
 const status=patch=>()=>set('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,cheapRemaining:0,error:null,at:iso,...patch});
 await confirmed('remaining unknown',status({remaining:null}),false)();
 await confirmed('remaining not zero',status({remaining:4}),false)();
 await confirmed('cheap pass pending',status({cheapRemaining:3}),false)();
 for(const [label,value] of [['cheap missing',undefined],['cheap null',null],['cheap string','0'],['cheap negative',-1],['cheap fractional',0.5]])
  await confirmed(label,()=>{const value_={schemaVersion:2,stage:'complete',programmeRunId:GENERATION,remaining:0,error:null,at:iso};if(value!==undefined)value_.cheapRemaining=value;set('epg/discovery-status.json',value_);},false)();
 await confirmed('status error',status({error:'boom'}),false)();
 await confirmed('status of another generation',status({programmeRunId:OTHER}),false)();
 await confirmed('no status',()=>records.delete('epg/discovery-status.json'),false)();
 await confirmed('continuation of another generation',()=>set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OTHER}),false)();
 await confirmed('continuation still paused',()=>set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:null,remainingChunks:2,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}),false)();
 void hour;
}

// 5b. A period's own chunks are the freshest reading: a last chunk without a proven cheap remainder is never an empty queue.
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
 const add=call('addChunkToDiscoveryReport');
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
   await call('settleWorkflowIfOwner')(env,state.record.instanceId,record=>({report:call('addChunkToDiscoveryReport')(record.report,chunk,state.record.instanceId+':1')}));}
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
  await call('settleWorkflowIfOwner')(env,own,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:1,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:0,remaining:5,cheapRemaining:0,error:null},own+':'+hour)}));total++;
  await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},hour);
 }
 assert.equal(outbox().length,limit,'the outbox holds exactly its limit');
 assert.equal(workflowRecord().report.added,6,'the six hours that did not fit stay in the accumulator, not dropped');
 assert.equal(reports().length,0);
 failEventPuts=false;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},limit+6);
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},limit+7);
 const real=reports().filter(event=>!event.incomplete);
 assert.equal(sumOf(real,'added'),total,'every committed chunk is counted exactly once across the reports');
 assert.equal(real.length>=limit,true);assert.deepEqual(outbox(),[]);
 const saturated=reports().filter(event=>event.incomplete);
 for(const event of saturated){for(const name of Object.keys(ZERO))assert.equal(event[name],null,'an event written without a reading never shows a 0');assert.equal(event.reason,'outbox_full');}
}

// 10. Unreadable or unwritable state: an incomplete event with unknown numbers, the accumulator untouched.
resetAll();seed({count:3});const own10=elect();
{
 await call('settleWorkflowIfOwner')(env,own10,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:3,added:2,reused:0,screenedOut:0,touched:0,tmdbCalls:1,remaining:5,cheapRemaining:0,error:null},own10+':1')}));
 const realRead=context.DiscoveryAuthority.readWorkflow,realWrite=context.DiscoveryAuthority.writeWorkflow;
 context.DiscoveryAuthority.writeWorkflow=async()=>{const error=new Error('window');error.code='discovery_window';error.window={expiresAt:Date.now()+1000};throw error;};
 const held=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},0);
 assert.equal(held.closed,false);assert.equal(held.reason,'projector_window');
 const [e0]=reports();assert.equal(e0.incomplete,true);assert.equal(e0.reason,'projector_window');assert.equal(e0.status,'running');
 for(const name of ['checked','added','reused','screenedOut','touched','tmdbCalls','chunks','remaining','from'])assert.equal(e0[name],null,name+' is unknown, not 0');
 assert.equal(workflowRecord().report.added,2,'the deltas wait for the next report');
 context.DiscoveryAuthority.writeWorkflow=realWrite;
 context.DiscoveryAuthority.readWorkflow=async()=>{throw new Error('d1 down');};
 const unreadable=await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},1);
 assert.equal(unreadable.reason,'state_unreadable');assert.equal(reports()[1].incomplete,true);assert.equal(reports()[1].added,null);
 context.DiscoveryAuthority.readWorkflow=realRead;
 await closed({started:false,reason:'in_progress',programmeRunId:GENERATION},2);
 const [,,e2]=reports();assert.equal(e2.added,2,'the delayed deltas arrive once, in the next complete report');assert.equal(e2.incomplete,false);
}

// 11. DST and hour identity: UTC hours, the repeated local hour of the clock change has two reports, a new generation is a new identity.
resetAll();seed({count:3});elect();
{
 const outcome={started:false,reason:'in_progress',programmeRunId:GENERATION};
 const fall=Date.UTC(2026,9,25,0),spring=Date.UTC(2026,2,29,0);
 for(const ms of [fall,fall+HOUR,fall+2*HOUR,spring,spring+HOUR])await call('closeHourlyDiscoveryReport')(env,outcome,{scheduled:true,now:ms+120000});
 const ids=reports().map(event=>event.id);assert.equal(new Set(ids).size,5,'two Madrid 02:00 hours are two reports; no hour merges or skips');
 assert.deepEqual(reports().map(event=>event.at).sort(),[spring,spring+HOUR,fall,fall+HOUR,fall+2*HOUR].map(ms=>new Date(ms).toISOString()));
 assert.ok(ids.includes('discovery-hour-a30f67e93a11-20261025T01'));
 const next=call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:OTHER,status:'running',reason:null,report:call('newDiscoveryReport')(null),queue:{remaining:null,empty:false},incomplete:false});
 assert.notEqual(next.id,hourId(GENERATION,0));
}

// 12. A newer generation replaces the record: the open accumulator and the outbox are carried, nothing is written at the replacement.
resetAll();seed({count:3});const own12=elect(0);
{
 await call('settleWorkflowIfOwner')(env,own12,record=>({report:call('addChunkToDiscoveryReport')(record.report,{checked:8,added:5,reused:0,screenedOut:0,touched:0,tmdbCalls:2,remaining:5,cheapRemaining:0,error:null},own12+':1')}));
 const state=await call('readWorkflowState')(env);state.record.outbox=[{...call('discoveryHourEvent')({at:new Date(BASE).toISOString(),hourKey:'20261111T10',generation:GENERATION,status:'running',reason:null,report:call('newDiscoveryReport')(null),queue:{remaining:1,empty:false},incomplete:false})}];
 set('epg/discovery-workflow.json',state.record);
 const stored=await call('readWorkflowState')(env);
 const created=await call('createWorkflowInstance')(env,OTHER,0,`discovery_${OTHER.replace(/-/g,'')}_0`,stored.etag,null,stored.record);
 assert.equal(created.started,true);assert.equal(reports().length,0,'a replacement writes no event of its own');
 assert.equal(workflowRecord().programmeRunId,OTHER);assert.equal(workflowRecord().report.added,5,'the deltas of the old generation are reported by the next hourly report');
 assert.equal(workflowRecord().outbox.length,1);
 await call('closeHourlyDiscoveryReport')(env,{started:true,reason:'started',programmeRunId:OTHER},cron(1));
 assert.equal(reports().length,2);assert.equal(reports().find(event=>event.id.includes(OTHER.replace(/-/g,'').slice(0,12))).added,5);
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

// 15. The pure helpers.
{
 for(const unknown of [null,undefined,-1,0.5,'0',NaN])assert.equal(call('discoveryQueueEmpty')(0,unknown,null),false,'an unproven cheap remainder is not a zero: '+String(unknown));
 for(const unknown of [null,undefined,-1,'0'])assert.equal(call('discoveryQueueEmpty')(unknown,0,null),false);
 assert.equal(call('discoveryQueueEmpty')(0,0,null),true);assert.equal(call('discoveryQueueEmpty')(0,2,null),false);assert.equal(call('discoveryQueueEmpty')(0,0,'x'),false);
 assert.equal(call('discoveryHourStamp')(Date.UTC(2026,10,11,10,59,59)),'20261111T10');
}

bucket.put=realPut;
console.log('Discovery events: hourly reports with deltas across rollovers, duplicate/late/missed crons, every state, strict empty queue, replay-safe counts, checkpoint race, outbox recovery and cap, unknown never shown as 0, DST hours, generation handoff and legacy delivery passed');
