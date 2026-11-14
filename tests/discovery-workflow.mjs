// AIR-325 / ADR 0083: the Discovery Workflow is the permanent executor; DISCOVERY_EXECUTOR is retired and ignored.
// Absent mode keeps one explicit chunk. Workflow mode does not run that chunk in the request, renews a spent
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

// The external hourly contract is unchanged: a future chunk_budget still waits.
const future=new Date(now+3600000).toISOString();
const hourly=call('continuationDecision')({stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:future,retryAt:null},now);
assert.equal(hourly.run,false);assert.equal(hourly.contract.nextAction,'wait');assert.equal(hourly.contract.reason,'chunk_budget');
assert.throws(()=>call('discoveryExecutorMode'),/not defined/,'the transitional selector is retired');

// 1. AIR-325: a missing, old `external` or invalid DISCOVERY_EXECUTOR never runs a chunk in the request. Without the Workflow binding the step fails closed.
seed();
let response=await post('/api/sync/epg',{runId:'sync-1'});
assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.delegated,true);assert.equal(response.data.discovery.reason,'delegated');
assert.equal(decided(),0);assert.equal(creates.length,0);
for(const value of ['external','nope','Workflow',undefined]){
 seed();
 response=await post('/api/sync/epg',{runId:'sync-1'},workflowEnv(value));
 assert.equal(response.status,200);assert.equal(response.data.delegated,true);assert.equal(response.data.executor,'workflow');assert.equal(decided(),0);assert.equal(creates.length,0);
}

// 2. Workflow mode does not run the chunk in the request and does not call the series complete.
seed();
armWorkflowAdmission(GENERATION);
response=await post('/api/sync/epg',{runId:'sync-1'},workflowEnv('workflow'));
assert.equal(response.status,200);assert.equal(response.data.delegated,true);assert.equal(response.data.executor,'workflow');
assert.equal(response.data.discovery.nextAction,'wait');assert.equal(response.data.discovery.reason,'delegated');
assert.equal(decided(),0);assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE);assert.equal(creates[0].params.chunkLimit,undefined);
assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);

// 3. A stale `external` value still publishes the commit intent and starts no chunk.
seed({stage:'epg',syncId:GENERATION,programmeRunId:GENERATION});
response=await post('/api/sync/epg',{runId:GENERATION},workflowEnv('external'));
assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.stage,'complete');
assert.equal(decided(),0);assert.equal(continuation().reason,'epg_committed');

// The same commit tail in workflow mode recovers the queued intent without a chunk.
seed({stage:'epg',syncId:GENERATION,programmeRunId:GENERATION});
response=await post('/api/sync/epg',{runId:GENERATION},workflowEnv('workflow'));
assert.equal(response.status,200);assert.equal(response.data.delegated,true);assert.equal(response.data.discovery.reason,'delegated');
assert.notEqual(response.data.discovery.nextAction,'stop');assert.equal(decided(),0);
assert.equal(new Set(creates.map(item=>item.id)).size,1);
clearWorkflowAdmission();

// 4. A real workflow loop saves the same decisions as direct advanceDiscovery calls.
async function drain(environment){
 let guard=0;const seen=[];
 while(guard++<8){const outcome=await call('advanceDiscovery')(environment,{});seen.push(outcome.discovery.nextAction);if(outcome.discovery.nextAction==='stop')break;}
 return seen;
}
seed({count:60});
const directEnv=workflowEnv('workflow');
await drain(directEnv);
const comparable=map=>Object.fromEntries(Object.entries(map).map(([key,value])=>[key,{status:value.status,attempts:value.attempts,terminalReason:value.terminalReason}]));
const direct=comparable(records.get('epg/discovery-resolution.json'));
assert.equal(Object.keys(direct).length,60);
seed({count:60});
Object.assign(env,workflowEnv('workflow'));
elect();
const drained=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(drained.reason,'complete');assert.deepEqual(comparable(records.get('epg/discovery-resolution.json')),direct);assert.equal(creates.length,0);

// 5. Thirteen stubbed chunks renew a spent series instead of waiting for the hour.
seed();
Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
elect();
sleeps.length=0;context.calls=0;
vm.runInContext(`advanceDiscovery=async env=>{calls++;const stored=await readContinuation(env);const n=calls;const at=new Date().toISOString();const programmeRunId=${JSON.stringify(GENERATION)};const record=n>=13?{stage:'complete',reason:null,at,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId}:n%12===0?{stage:'paused',reason:'chunk_budget',at,hopId:null,remainingChunks:0,nextCatchUpAt:new Date(Date.now()+3600000).toISOString(),retryAt:null,programmeRunId}:{stage:'paused',reason:null,at,hopId:null,remainingChunks:12-(n%12),nextCatchUpAt:null,retryAt:null,programmeRunId};if(!await replaceContinuation(env,record,stored.etag))throw new Error('stub lost the continuation');await saveJSON(env,'epg/discovery-status.json',{programmeRunId,remaining:n>=13?0:10,finishedAt:at});return {stage:record.stage,checked:1,remaining:n>=13?0:10,discovery:discoveryContract(record),diagnostic:{saved:{owned:true,write:'saved'}}};}`,context);
const thirteen=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(context.calls,13);assert.equal(thirteen.reason,'complete');assert.equal(sleeps.length,0);assert.equal(continuation().stage,'complete');

// 6. Backoff sleeps until retryAt and does not run a chunk. A live lease does the same.
vm.runInContext('advanceDiscovery=async()=>{throw new Error("chunk was not allowed");}',context);
seed();
elect();
set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:null,remainingChunks:4,nextCatchUpAt:future,retryAt:future,programmeRunId:GENERATION});
await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step),/long-sleep/);
assert.equal(sleeps.at(-1),future);assert.equal(decided(),0);
seed();
elect();
set('epg/resolver-lease.json',{id:'11111111-2222-4333-8444-555555555555',expiresAt:now+60000});
set('epg/resolver-continuation.json',{stage:'running',reason:null,at:iso,hopId:'11111111-2222-4333-8444-555555555555',remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step),/long-sleep/);
assert.equal(decided(),0);

// 7. A duplicate trigger attaches to the same instance. A failed create keeps that id for the reconciler.
vm.runInContext('advanceDiscovery=async()=>{throw new Error("chunk was not allowed");}',context);
seed();
armWorkflowAdmission();
const first=await call('ensureDiscoveryWorkflow')(env);
const second=await call('ensureDiscoveryWorkflow')(env);
assert.equal(first.started,true);assert.equal(second.attached,true);assert.equal(second.instanceId,first.instanceId);
assert.equal(new Set(creates.map(item=>item.id)).size,1);
seed();
binding.create=async request=>{creates.push(request);throw new Error('network down');};
const uncertain=await call('ensureDiscoveryWorkflow')(env);
assert.equal(uncertain.reason,'start_uncertain');assert.equal(uncertain.instanceId,INSTANCE);
assert.equal(records.get('epg/discovery-workflow.json').phase,'uncertain');
binding.create=async request=>{creates.push(request);if(creates.filter(item=>item.id===request.id).length>1)throw new Error('Instance already exists');return {id:request.id};};
const waiting=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(waiting.reason,'recovery_waiting');assert.equal(waiting.instanceId,INSTANCE);assert.equal(creates.length,1);
const waitingAgain=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(waitingAgain.reason,'recovery_waiting');assert.equal(creates.length,1);
records.get('epg/discovery-workflow.json').recovery.dueAt=new Date(Date.now()-1000).toISOString();
const recovered=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(recovered.started,true);assert.equal(recovered.instanceId,INSTANCE);
binding.get=async()=>({status:'complete'});
set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso,hopId:null,remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
const armed=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(armed.reason,'recovery_waiting');assert.equal(armed.series,0);
const duringCooldown=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(duringCooldown.reason,'recovery_waiting');assert.equal(creates.filter(item=>item.id!==INSTANCE).length,0);
records.get('epg/discovery-workflow.json').recovery.dueAt=new Date(Date.now()-1000).toISOString();
const successor=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(successor.started,true);assert.equal(successor.series,1);assert.notEqual(successor.instanceId,INSTANCE);
const successorCreates=creates.length;
const notAnother=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(notAnother.series,1);assert.notEqual(notAnother.reason,'started');assert.equal(creates.length,successorCreates);
clearWorkflowAdmission();

// 8. A stale generation does not apply, and two overlapping chunks cannot both hold the lease.
const stale=call('workflowPlan')({mode:'workflow',published:GENERATION,pinned:OTHER,record:{programmeRunId:OTHER,stage:'paused',remainingChunks:12},now,chunks:0,chunkLimit:20,uncertainWrites:0});
assert.equal(stale.action,'stop');assert.equal(stale.reason,'stale_generation');
seed();
elect(0,OTHER);
const stopped=await call('runDiscoveryWorkflow')(env,{programmeRunId:OTHER,series:0},step);
assert.equal(stopped.reason,'stale_generation');assert.equal(decided(),0);
context.advanceDiscovery=realAdvance;
seed({count:48});
Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
const pair=await Promise.all([call('runWorkflowChunk')(env),call('runWorkflowChunk')(env)]);
assert.ok(pair.every(item=>item.progress||item.busy),JSON.stringify(pair));
assert.equal(decided(),pair.filter(item=>item.progress).length*24,JSON.stringify({decided:decided(),pair,continuation:continuation()}));

// 9. A checkpoint that throws after the save is not run again inside the same step.
context.advanceDiscovery=async(env,body)=>{const outcome=await realAdvance(env,body);throw new Error('after commit');};
seed({count:48});
elect();
step.retried=0;creates.length=0;
binding.create=async request=>{creates.push(request);return {id:request.id};};
const rolled=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:1},step);
assert.equal(step.retried,0);assert.equal(decided(),24);assert.equal(rolled.reason,'rollover');assert.equal(rolled.successor.series,1);

// 10. Read-only status. External mode omits the executor. Workflow mode reports it and creates nothing.
seed();
delete env.DISCOVERY_EXECUTOR;
puts.length=0;creates.length=0;
let pipeline=await status();
assert.equal(pipeline.discoveryExecutor.configured,'workflow');assert.equal(creates.length,0);assert.equal(puts.length,0);
env.DISCOVERY_EXECUTOR='nope';
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.configured,'workflow');assert.equal(pipeline.discoveryExecutor.owner,'none');
assert.equal(creates.length,0);assert.equal(puts.length,0);
seed();
env.DISCOVERY_EXECUTOR='workflow';
elect();
records.get('epg/discovery-workflow.json').updatedAt=new Date(Date.now()-16*60*1000).toISOString();
binding.get=async()=>({status:'running'});
creates.length=0;puts.length=0;
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.owner,'workflow');assert.equal(pipeline.discoveryExecutor.stalled,true);assert.equal(pipeline.discoveryExecutor.degraded,true);assert.equal(creates.length,0);
binding.get=async()=>({status:'complete'});
creates.length=0;
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.owner,'none');assert.equal(pipeline.discoveryExecutor.liveness,'complete');assert.equal(pipeline.discoveryExecutor.degraded,true);assert.equal(creates.length,0);
seed();
env.DISCOVERY_EXECUTOR='workflow';
elect();
records.get('epg/discovery-workflow.json').phase='stopped';
records.get('epg/discovery-workflow.json').reason='no_progress';
records.get('epg/discovery-workflow.json').recovery={attempts:1,reason:'no_progress',at:iso,dueAt:new Date(Date.now()+60000).toISOString(),quarantined:false};
binding.get=async()=>({status:'running'});
creates.length=0;
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.owner,'none');assert.equal(pipeline.discoveryExecutor.degraded,true);assert.ok(pipeline.discoveryExecutor.recoveryDue);assert.equal(creates.length,0);

// 12. A superseded series does not call TMDB or write Discovery after the successor owns the record.
seed();
elect(1);
const discoveryKeys=['epg/discovery-resolution.json','epg/discovery-status.json','epg/resolver-continuation.json','epg/resolver-lease.json','epg/discovery-latest.json'];
const before=new Map(discoveryKeys.map(key=>[key,JSON.stringify(records.get(key)||null)]));
let fetches=0;
const previousFetch=context.fetch;
context.fetch=async(...args)=>{fetches++;return previousFetch(...args);};
context.advanceDiscovery=realAdvance;
puts.length=0;creates.length=0;
const superseded=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(superseded.reason,'not_owner');assert.equal(fetches,0);assert.equal(puts.length,0);assert.equal(decided(),0);
for(const key of discoveryKeys)assert.equal(JSON.stringify(records.get(key)||null),before.get(key),key);
context.fetch=previousFetch;
const originalSleep=step.sleepUntil.bind(step);
step.sleepUntil=async(name,date)=>{sleeps.push(date.toISOString());elect(1);};
seed();elect();
set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:null,remainingChunks:4,nextCatchUpAt:new Date(Date.now()+1000).toISOString(),retryAt:new Date(Date.now()+1000).toISOString(),programmeRunId:GENERATION});
vm.runInContext('advanceDiscovery=async()=>{throw new Error("chunk was not allowed");}',context);
fetches=0;puts.length=0;
const woke=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(woke.reason,'not_owner');assert.equal(fetches,0);assert.equal(decided(),0);
assert.equal(puts.filter(key=>key!=='epg/discovery-workflow.json').length,0);
step.sleepUntil=originalSleep;

// 13. Recovery waits out its due time, then one eligible retry can run, and a quarantined record creates nothing.
seed();
elect();
records.get('epg/discovery-workflow.json').phase='stopped';
records.get('epg/discovery-workflow.json').reason='no_progress';
records.get('epg/discovery-workflow.json').recovery={attempts:1,reason:'no_progress',at:iso,dueAt:new Date(Date.now()+60000).toISOString(),quarantined:false};
binding.get=async()=>({status:'running'});
binding.create=async request=>{creates.push(request);if(creates.filter(item=>item.id===request.id).length>1)throw new Error('Instance already exists');return {id:request.id};};
creates.length=0;
armWorkflowAdmission();
const cooled=await call('reconcileDiscoveryWorkflow')(env);
const cooledAgain=await call('ensureDiscoveryWorkflow')(env);
assert.equal(cooled.reason,'recovery_waiting');assert.equal(cooledAgain.reason,'recovery_waiting');assert.equal(creates.length,0);
records.get('epg/discovery-workflow.json').recovery.dueAt=new Date(Date.now()-1000).toISOString();
const eligible=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(eligible.started,true);assert.equal(eligible.series,1);assert.equal(creates.length,1);
clearWorkflowAdmission();
vm.runInContext(`advanceDiscovery=async env=>{calls++;const stored=await readContinuation(env);const at=new Date().toISOString();const programmeRunId=${JSON.stringify(GENERATION)};const record={stage:'complete',reason:null,at,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId};if(!await replaceContinuation(env,record,stored.etag))throw new Error('stub lost the continuation');await saveJSON(env,'epg/discovery-status.json',{programmeRunId,remaining:0,finishedAt:at});return {stage:'complete',checked:1,remaining:0,discovery:discoveryContract(record),diagnostic:{saved:{owned:true,write:'saved'}}};}`,context);
context.calls=0;
const recoveredRun=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:1},step);
assert.equal(context.calls,1);assert.equal(recoveredRun.reason,'complete');
seed();
elect();
records.get('epg/discovery-workflow.json').phase='stopped';
records.get('epg/discovery-workflow.json').reason='recovery_exhausted';
records.get('epg/discovery-workflow.json').recovery={attempts:5,reason:'recovery_exhausted',at:iso,dueAt:new Date(Date.now()-1000).toISOString(),quarantined:true};
creates.length=0;
armWorkflowAdmission();
const quarantined=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(quarantined.reason,'recovery_exhausted');assert.equal(creates.length,0);

// 11. The production entry stays inert: no flag, no Workflow schedule, cron may reconcile but does not run a chunk.
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.main,'dist/server/workflow-entry.js');
assert.deepEqual(wrangler.triggers.crons,['0 * * * *']);
assert.equal(wrangler.vars.DISCOVERY_EXECUTOR,undefined);
assert.equal(JSON.stringify(wrangler).includes('schedules'),false);
assert.equal(wrangler.workflows[0].binding,'DISCOVERY_WORKFLOW');
assert.equal(wrangler.workflows[0].class_name,'DiscoveryWorkflow');
assert.equal(wrangler.workflows[0].schedules,undefined);
const scheduled=fs.readFileSync('src/worker.js','utf8').match(/async scheduled[\s\S]*?async fetch/)[0];
assert.match(scheduled,/reconcileDiscoveryWorkflow/);
assert.doesNotMatch(scheduled,/advanceDiscovery/);
const build=fs.readFileSync('build.mjs','utf8');
const indexWrite=build.slice(build.indexOf("fs.writeFileSync('dist/server/index.js'"),build.indexOf("fs.writeFileSync('dist/server/workflow-entry.js'"));
assert.match(indexWrite,/src\/discovery-workflow\.js/);
assert.doesNotMatch(indexWrite,/cloudflare:workers/);
assert.match(build,/import \{ WorkflowEntrypoint \} from 'cloudflare:workers'/);
assert.match(build,/export \{ runDiscoveryWorkflow, reconcileDiscoveryWorkflow(, runRatingsWorkflow)?(, runEpgWorkflow)?(, runEpgDiagnosticWorkflow)? \}/);

async function fireCron(environment=env){
 const pending=[];
 await worker.scheduled({scheduledTime:Date.now()},environment,{waitUntil(p){pending.push(p);}});
 await Promise.all(pending);
}

// 14. Cron reconcile fails closed without admission regardless of the retired flag, and self-starts once admission passes.
seed();
clearWorkflowAdmission();
delete env.DISCOVERY_EXECUTOR;
creates.length=0;puts.length=0;
await fireCron();
assert.equal(creates.length,0);
assert.equal(decided(),0);
env.DISCOVERY_EXECUTOR='workflow';
armWorkflowAdmission();
await fireCron();
assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE);assert.equal(decided(),0);

// Lost publication queue: ensure reconstructs the fenced intent from the published generation.
seed();
records.delete('epg/resolver-continuation.json');etags.delete('epg/resolver-continuation.json');
creates.length=0;
const reconstructed=await call('ensureDiscoveryWorkflow')(env);
assert.equal(reconstructed.started,true);assert.equal(reconstructed.instanceId,INSTANCE);
assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(creates.length,1);assert.equal(decided(),0);

// Same-generation programme_changed is a replaceable publication artefact, not a terminal stop.
seed();
set('epg/resolver-continuation.json',{stage:'paused',reason:'programme_changed',at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
creates.length=0;
const recoveredChanged=await call('ensureDiscoveryWorkflow')(env);
assert.equal(recoveredChanged.started,true);assert.equal(recoveredChanged.instanceId,INSTANCE);
assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(continuation().remainingChunks,12);assert.equal(creates.length,1);
const recoveredAgain=await call('ensureDiscoveryWorkflow')(env);
assert.equal(recoveredAgain.instanceId,INSTANCE);
assert.equal(recoveredAgain.attached===true||recoveredAgain.reason==='attached'||recoveredAgain.started===true,true,JSON.stringify(recoveredAgain));
assert.equal(continuation().reason,'epg_committed');
assert.equal(new Set(creates.map(item=>item.id)).size,1);

// A terminal series is not re-queued. D1 held, loading or unavailable creates nothing.
set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
creates.length=0;
const terminal=await call('ensureDiscoveryWorkflow')(env);
assert.equal(terminal.started,false);assert.equal(terminal.reason,'stopped');assert.equal(creates.length,0);
seed();
creates.length=0;
context.DiscoveryAuthority={readAuthority:async()=>({ready:false,held:true,cutover:'held',mode:'d1',transfer:'idle'})};
const held=await call('ensureDiscoveryWorkflow')(env);
assert.equal(held.reason,'authority_held');assert.equal(creates.length,0);
context.DiscoveryAuthority={readAuthority:async()=>({ready:true,held:false,cutover:'open',mode:'d1',transfer:'loading'})};
const loading=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(loading.reason,'authority_loading');assert.equal(creates.length,0);
context.DiscoveryAuthority={readAuthority:async()=>{throw Object.assign(new Error('unavailable'),{code:'discovery_unavailable'});}};
const down=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(down.reason,'d1_unavailable');assert.equal(creates.length,0);
function snapshotDiscoveryKeys(){
 return JSON.stringify({
  continuation:records.get('epg/resolver-continuation.json')||null,
  workflow:records.get('epg/discovery-workflow.json')||null,
  resolution:records.get('epg/discovery-resolution.json')||null,
 });
}
async function assertNoWorkflowStart(name,gate,reason){
 seed();
 env.DISCOVERY_EXECUTOR='workflow';
 context.DiscoveryAuthority={readAuthority:async()=>gate};
 const before=snapshotDiscoveryKeys();
 creates.length=0;puts.length=0;
 const out=await call(name)(env);
 assert.equal(out.started,false,name+' '+reason);
 assert.equal(out.reason,reason,name+' '+JSON.stringify(out));
 assert.equal(creates.length,0,name+' create');
 assert.equal(snapshotDiscoveryKeys(),before,name+' records');
 assert.equal(puts.filter(key=>key==='epg/resolver-continuation.json'||key==='epg/discovery-workflow.json'||key==='epg/discovery-resolution.json').length,0,name+' puts');
}
const closedGate={ready:false,held:false,tables:false,mode:'r2',cutover:null,version:null,generation:0,programmeRunId:null,publishedProgrammeRunId:null,transfer:'idle'};
const schemaV10={...closedGate,version:10};
const r2Open={ready:false,held:false,tables:true,mode:'r2',cutover:'open',version:11,generation:1,programmeRunId:GENERATION,publishedProgrammeRunId:GENERATION,transfer:'idle'};
for(const name of ['ensureDiscoveryWorkflow','reconcileDiscoveryWorkflow']){
 await assertNoWorkflowStart(name,closedGate,'authority_not_ready');
 await assertNoWorkflowStart(name,schemaV10,'authority_not_ready');
 await assertNoWorkflowStart(name,r2Open,'authority_not_ready');
}
seed();
env.DISCOVERY_EXECUTOR='workflow';
creates.length=0;puts.length=0;
const matched=await call('ensureDiscoveryWorkflow')(env);
assert.equal(matched.started,true);assert.equal(matched.instanceId,INSTANCE);assert.equal(creates.length,1);
context.PublishedEpg={currentGeneration:async()=>({authority:'d1',programmeRunId:OTHER,phase:'published',generation:2,fence:'d1:2:'+OTHER})};
context.DiscoveryAuthority={...context.DiscoveryAuthority,readAuthority:async()=>readyDiscoveryGate(GENERATION)};
const beforeHandoff=snapshotDiscoveryKeys();
creates.length=0;puts.length=0;
for(const name of ['ensureDiscoveryWorkflow','reconcileDiscoveryWorkflow']){
 const lagged=await call(name)(env);
 assert.equal(lagged.started,false,name);assert.equal(lagged.reason,'generation_handoff',name);
}
// AIR-363: concurrent crons in the handoff window (published A, discovery pin B): every one answers generation_handoff, none creates or writes.
const concurrent=await Promise.all(['reconcileDiscoveryWorkflow','ensureDiscoveryWorkflow','reconcileDiscoveryWorkflow'].map(name=>call(name)(env)));
assert.deepEqual(concurrent.map(item=>[item.started,item.reason]),[[false,'generation_handoff'],[false,'generation_handoff'],[false,'generation_handoff']]);
assert.equal(creates.length,0);assert.equal(snapshotDiscoveryKeys(),beforeHandoff);
assert.equal(puts.filter(key=>key==='epg/resolver-continuation.json'||key==='epg/discovery-workflow.json').length,0);
context.PublishedEpg={currentGeneration:async()=>null};
creates.length=0;puts.length=0;
const missingPointer=await call('ensureDiscoveryWorkflow')(env);
assert.equal(missingPointer.reason,'generation_unpublished');assert.equal(creates.length,0);
context.PublishedEpg={currentGeneration:async()=>({authority:'d1',programmeRunId:GENERATION,phase:'published',generation:1,fence:'d1:1:'+GENERATION})};
context.DiscoveryAuthority={...context.DiscoveryAuthority,readAuthority:async()=>({...readyDiscoveryGate(GENERATION),publishedProgrammeRunId:null,programmeRunId:GENERATION})};
creates.length=0;puts.length=0;
const nullPin=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(nullPin.reason,'generation_handoff');assert.equal(creates.length,0);
context.DiscoveryAuthority={...context.DiscoveryAuthority,readAuthority:async()=>({...readyDiscoveryGate(OTHER),publishedProgrammeRunId:OTHER,programmeRunId:OTHER})};
creates.length=0;puts.length=0;
const mismatchedPin=await call('ensureDiscoveryWorkflow')(env);
assert.equal(mismatchedPin.reason,'generation_handoff');assert.equal(creates.length,0);
// AIR-363: once the new generation is published and the discovery pin agrees, the next reconcile opens its one successor and a repeat adds none.
context.PublishedEpg={currentGeneration:async()=>({authority:'d1',programmeRunId:OTHER,phase:'published',generation:2,fence:'d1:2:'+OTHER})};
creates.length=0;puts.length=0;
const afterHandoff=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(afterHandoff.started,true,JSON.stringify(afterHandoff));assert.equal(afterHandoff.programmeRunId,OTHER);assert.equal(creates.length,1);
const repeated=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(creates.length,1,'a repeated reconcile creates nothing more: '+JSON.stringify(repeated));
creates.length=0;
delete context.DiscoveryAuthority;
delete context.PublishedEpg;
delete env.DISCOVERY_EXECUTOR;
const rolledBack=await call('ensureDiscoveryWorkflow')(env);
assert.equal(rolledBack.reason,'authority_not_ready');assert.equal(creates.length,0);


// 11. AIR-360. A Workflow instance hands over to a successor before its D1 statement total nears the level at which
// both production instances failed (12,287 and 12,192 statements after 19 chunks). The meter counts statements and
// batches, and passes native statements to a batch untouched.
{
 class NativeStatement{}
 const fakeDb={prepare(){return new NativeStatement();},async batch(statements){if(!statements.every(item=>item instanceof NativeStatement))throw new Error('not native');return statements.map(()=>({}));},async exec(){return {};}};
 seed({count:60});
 Object.assign(env,{DISCOVERY_EXECUTOR:'workflow',DB:fakeDb});
 elect();
 context.calls=0;
 // Every chunk issues 650 statements and leaves 12 chunks of backlog, so only the statement meter can end the instance.
 vm.runInContext(`advanceDiscovery=async env=>{calls++;for(let i=0;i<650;i++)env.DB.prepare('SELECT 1');await env.DB.batch([env.DB.prepare('SELECT 2'),env.DB.prepare('SELECT 3')]);const stored=await readContinuation(env);const at=new Date().toISOString();const programmeRunId=${JSON.stringify(GENERATION)};const record={stage:'paused',reason:null,at,hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId};if(!await replaceContinuation(env,record,stored.etag))throw new Error('stub lost the continuation');await saveJSON(env,'epg/discovery-status.json',{programmeRunId,remaining:500,finishedAt:at});return {stage:'paused',checked:1,remaining:500,discovery:discoveryContract(record),diagnostic:{saved:{owned:true,write:'saved'}}};}`,context);
 step.retried=0;creates.length=0;
 binding.create=async request=>{creates.push(request);return {id:request.id};};
 const savedRecords=[],originalPut=bucket.put;bucket.put=async(key,value,options)=>{if(key==='epg/discovery-workflow.json')savedRecords.push(JSON.parse(value));return originalPut.call(bucket,key,value,options);};
 const budgeted=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
 assert.equal(budgeted.reason,'rollover');assert.equal(budgeted.successor.series,1);
 assert.equal(creates.length,1);assert.equal(creates[0].id,`discovery_${GENERATION.replace(/-/g,'')}_1`);
 // 6,000 statements are spent after ten chunks of 652; the instance stops there, far below 19 chunks.
 assert.equal(context.calls,10);assert.equal(budgeted.chunks,10);
 bucket.put=originalPut;
 const progress=savedRecords.filter(record=>record.invocation).at(-1);
 assert.ok(progress.invocation.statements>=6000&&progress.invocation.statements<8000);assert.ok(progress.invocation.batches>=10);
 assert.ok(progress.instance.statements>=6000&&progress.instance.statements<8000,'the instance total follows the step outputs');
 // The plan: a spent invocation rolls over; a fresh one does not; a stopped or waiting series is not rolled over.
 const same=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
 const plan=input=>call('workflowPlan')({mode:'workflow',published:GENERATION,pinned:GENERATION,record:{stage:'paused',reason:null,remainingChunks:5,programmeRunId:GENERATION,at:iso},lease:null,now:Date.now(),chunks:3,chunkLimit:20,last:null,uncertainWrites:0,...input});
 same(plan({used:5999}),{action:'continue',reason:null});
 same(plan({used:6000}),{action:'rollover',reason:'invocation_budget'});
 assert.equal(plan({used:6000,mode:'external'}).action,'rollover','a stale mode input is ignored');
 assert.equal(plan({used:6000,published:OTHER}).action,'stop');
 assert.equal(plan({used:6000,record:{stage:'paused',reason:'backoff',remainingChunks:4,programmeRunId:GENERATION,at:iso,retryAt:new Date(Date.now()+60000).toISOString(),nextCatchUpAt:new Date(Date.now()+60000).toISOString()}}).action,'wait');
 same(plan({used:6000,record:{stage:'paused',reason:'chunk_budget',remainingChunks:0,programmeRunId:GENERATION,at:iso,nextCatchUpAt:new Date(Date.now()+3600000).toISOString()},last:{programmeRunId:GENERATION,remaining:40}}),{action:'rollover',reason:'invocation_budget'});
 // The meter counts what the instance issues and leaves bindings usable.
 const meter={statements:0,batches:0};
 const wrapped=call('meterD1')(fakeDb,meter);
 const first=wrapped.prepare('a'),second=wrapped.prepare('b');
 await wrapped.batch([first,second]);await wrapped.exec('x');
 assert.equal(meter.statements,3);assert.equal(meter.batches,1);
 assert.equal(call('meterD1')(null,meter),null);
 const noDbEnv={BUCKET:bucket};assert.equal(call('meteredEnv')(noDbEnv,meter),noDbEnv);
 const metered=call('meteredEnv')({BUCKET:bucket,DB:fakeDb,OTHER:'kept'},meter);
 assert.equal(metered.OTHER,'kept');assert.equal(metered.BUCKET,bucket);assert.notEqual(metered.DB,fakeDb);
 assert.equal({...metered}.OTHER,'kept');
 delete env.DB;
}

// 12. AIR-360. A failing step logs classes from fixed lists, never the text of the exception, and the failure is
// rethrown unchanged.
{
 seed({count:12});
 Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
 elect();
 const secrets=['SHORTKEY','abc123','hunter2','members','34600111222','secret_col','x.example','Bearer','sk-live','AKIAABCDEFGHIJKLMNOP'];
 const hostile=new Error('D1_ERROR: Network connection lost at https://x.example/?key=SHORTKEY&token=abc123 password=hunter2 SELECT secret_col FROM members WHERE phone=\'34600111222\' Bearer sk-live AKIAABCDEFGHIJKLMNOP\n'+'y'.repeat(500));
 hostile.name='D1Error with a secret in the name sk-live';
 const cause=Object.assign(new Error('too many subrequests secret_col'),{name:'TypeError'});
 const failing=(error)=>({...context.DiscoveryAuthority,readWorkflow:async()=>{throw error;}});
 const original=context.DiscoveryAuthority;
 const capture=async error=>{
  const logged=[];const originalError=context.console.error;context.console.error=message=>logged.push(String(message));
  armDiscoveryAuthority(GENERATION);
  context.DiscoveryAuthority=failing(error);
  try{await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},{do:async(name,fn)=>fn(),sleepUntil:async()=>{}}),thrown=>thrown===error);}
  finally{context.console.error=originalError;context.DiscoveryAuthority=original;}
  return logged;
 };
 // A wrapper with a code and a cause whose text is hostile.
 const wrapper=Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable',cause:hostile});
 let logged=await capture(wrapper);
 // AIR-364: a recoverable failure also tries to arm the recovery; its own step fails on the same broken read and is logged next.
 assert.deepEqual(logged.map(line=>JSON.parse(line).step),['owner','recover-arm']);
 let entry=JSON.parse(logged[0]);
 assert.equal(entry.event,'discovery_workflow_step_failed');assert.equal(entry.step,'owner');assert.equal(entry.code,'discovery_unavailable');
 assert.equal(entry.name,'Error');assert.equal(entry.class,'code');assert.equal(entry.causeName,'other');assert.equal(entry.causeClass,'network_connection_lost');
 assert.equal(entry.statements,0);assert.equal(entry.instanceStatements,0);
 for(const secret of secrets)for(const line of logged)assert.ok(!line.includes(secret),'the log must not contain '+secret);
 assert.ok(logged[0].length<400);
 // A cause class from a fixed list, and nothing from an unknown message.
 const limited=Object.assign(new Error('x'),{cause});
 entry=JSON.parse((await capture(limited))[0]);assert.equal(entry.causeClass,'limit_exceeded');assert.equal(entry.causeName,'TypeError');assert.equal(entry.code,null);
 entry=JSON.parse((await capture(new RangeError('password=hunter2 unknown text')))[0]);assert.equal(entry.class,'unclassified');assert.equal(entry.name,'RangeError');
 // A code outside the list, a string and a hostile object that throws on every read.
 const odd=Object.assign(new Error('boom'),{code:'SECRET_CODE_hunter2'});
 logged=await capture(odd);entry=JSON.parse(logged[0]);assert.equal(entry.code,'other');assert.ok(!logged[0].includes('hunter2'));
 logged=await capture('raw secret=hunter2');entry=JSON.parse(logged[0]);assert.equal(entry.class,'unclassified');assert.equal(entry.name,'none');assert.ok(!logged[0].includes('hunter2'));
 const throwing={get message(){throw new Error('hostile getter');},get name(){throw new Error('hostile getter');},get code(){throw new Error('hostile getter');},get cause(){throw new Error('hostile getter');}};
 logged=await capture(throwing);assert.ok(logged.length<=1);
 clearWorkflowAdmission();
}

// 13. AIR-360. The whole chunk step is covered, not only the chunk call: a failing initial read of the continuation
// is logged under `chunk`, is rethrown (nothing was committed, so a retry is safe) and starts no chunk.
{
 seed({count:12});
 Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
 elect();
 context.calls=0;
 vm.runInContext(`advanceDiscovery=async()=>{calls++;throw new Error("a chunk must not start");}`,context);
 vm.runInContext(`globalThis.realReadContinuation=readContinuation;globalThis.readCalls=0;readContinuation=async(...args)=>{readCalls++;if(readCalls===2){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';error.cause=new Error('Network connection lost');throw error;}return realReadContinuation(...args);}`,context);
 const logged=[];const originalError=context.console.error;context.console.error=message=>logged.push(String(message));
 let ended;
 // AIR-364: the failure is recoverable, so the instance arms the recovery and waits for `dueAt` (the stand-in sleep returns at once)
 // instead of ending errored; it still starts no chunk and the failure is logged once.
 try{ended=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},{do:async(name,fn)=>fn(),sleepUntil:async()=>{}});}
 finally{context.console.error=originalError;vm.runInContext('readContinuation=realReadContinuation',context);}
 // The stand-in has no armed D1 authority here, so the wake finds admission refused and stops quietly without a successor.
 assert.equal(ended.stopped,true);assert.equal(ended.reason,'authority_not_ready');
 assert.equal(context.calls,0);assert.equal(logged.length,1);
 const entry=JSON.parse(logged[0]);assert.equal(entry.step,'chunk');assert.equal(entry.code,'discovery_unavailable');assert.equal(entry.causeClass,'network_connection_lost');
}

// 14. AIR-360. After a sleep the instance resumes in a new invocation with a new meter. Each step returns what it
// spent and the loop re-adds the cached outputs, so the budget bounds the whole instance, not one invocation.
{
 class NativeStatement{}
 const fakeDb={prepare(){return new NativeStatement();},async batch(){return [];},async exec(){return {};}};
 seed({count:60});
 Object.assign(env,{DISCOVERY_EXECUTOR:'workflow',DB:fakeDb});
 elect();
 context.calls=0;
 vm.runInContext(`advanceDiscovery=async env=>{calls++;for(let i=0;i<650;i++)env.DB.prepare('SELECT 1');await env.DB.batch([env.DB.prepare('SELECT 2'),env.DB.prepare('SELECT 3')]);const stored=await readContinuation(env);const at=new Date().toISOString();const programmeRunId=${JSON.stringify(GENERATION)};const record={stage:'paused',reason:null,at,hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId};if(calls===5)return {stage:'paused',checked:0,remaining:500,discovery:discoveryContract(stored.record),diagnostic:{saved:{owned:false,write:'none'}}};if(!await replaceContinuation(env,record,stored.etag))throw new Error('stub lost the continuation');await saveJSON(env,'epg/discovery-status.json',{programmeRunId,remaining:500,finishedAt:at});return {stage:'paused',checked:1,remaining:500,discovery:discoveryContract(record),diagnostic:{saved:{owned:true,write:'saved'}}};}`,context);
 creates.length=0;
 binding.create=async request=>{creates.push(request);return {id:request.id};};
 const cache=new Map();let hibernations=0;
 const memoStep={
  async do(name,fn){if(cache.has(name))return structuredClone(cache.get(name));const value=await fn();cache.set(name,structuredClone(value));return value;},
  async sleepUntil(name){if(!cache.has('slept:'+name)){cache.set('slept:'+name,true);hibernations++;throw new Error('hibernate');}}
 };
 // The first invocation ends in the sleep after the fifth, stalled chunk. The next one replays the cached steps.
 await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memoStep),/hibernate/);
 assert.equal(context.calls,5);assert.equal(hibernations,1);
 const callsBeforeResume=context.calls;
 const resumed=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},memoStep);
 // The replay issues no statement for the cached steps and does not run those chunks again.
 assert.equal(resumed.reason,'rollover');assert.equal(creates.length,1);
 // Without the cached counts the new meter would start at zero and allow about fifteen chunks in all.
 assert.ok(context.calls>=9&&context.calls<=10,'the instance stopped after '+context.calls+' chunks in all');
 assert.ok(context.calls>callsBeforeResume);
 // Outputs written before the count existed carry none: they add nothing and do not break the loop.
 seed({count:60});elect();creates.length=0;context.calls=0;
 vm.runInContext(`advanceDiscovery=async env=>{calls++;const stored=await readContinuation(env);const at=new Date().toISOString();const programmeRunId=${JSON.stringify(GENERATION)};const record={stage:'paused',reason:null,at,hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId};if(!await replaceContinuation(env,record,stored.etag))throw new Error('stub lost the continuation');await saveJSON(env,'epg/discovery-status.json',{programmeRunId,remaining:500,finishedAt:at});return {stage:'paused',checked:1,remaining:500,discovery:discoveryContract(record),diagnostic:{saved:{owned:true,write:'saved'}}};}`,context);
 const legacy=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0,chunkLimit:1},{do:async(name,fn)=>name.startsWith('owner')?{owned:true}:name.startsWith('plan')?{action:context.calls>=1?'rollover':'continue',reason:'instance_limit'}:(await fn()),sleepUntil:async()=>{}});
 assert.equal(legacy.reason,'rollover');
 delete env.DB;
 clearWorkflowAdmission();
}

// 15. AIR-364 / ADR 0098. A step that fails after the platform's retries is recovered by the instance itself: armed once through the
// same CAS and backoff, a durable sleep until `dueAt`, then the existing ensure opens the one successor. Nothing is created before
// `dueAt`, and every uncertain or unsafe outcome leaves the hourly reconcile as the only recovery. The clock is controlled.
{
 const realNow=Date.now;let skew=0;Date.now=()=>realNow()+skew;
 const transient=()=>Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable'});
 const record=()=>records.get('epg/discovery-workflow.json');
 const startRun=({fails=name=>name.startsWith('chunk'),error=transient(),onSleep,mode='workflow'}={})=>{
  const sleeps=[];
  const stepDouble={
   async do(name,fn){if(fails(name))throw error;return fn();},
   async sleepUntil(name,date){sleeps.push({name,at:date.getTime(),now:Date.now()});if(onSleep)await onSleep(date);},
  };
  const runEnv=workflowEnv(mode);
  return {sleeps,stepDouble,env:runEnv,run:()=>call('runDiscoveryWorkflow')(runEnv,{programmeRunId:GENERATION,series:0},stepDouble)};
 };
 const fresh=()=>{skew=0;seed({remaining:12});armWorkflowAdmission();elect();Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});};
 const advanceTo=date=>{skew=Math.max(skew,date.getTime()-realNow()+1);};
 const createTimes=[];
 binding.create=async request=>{createTimes.push(Date.now());creates.push(request);const prior=creates.filter(item=>item.id===request.id).length;if(prior>1)throw new Error('Instance already exists');return {id:request.id};};
 try{
  // Due not yet elapsed: armed once, no successor, no early create.
  fresh();let t=startRun();
  let ended=await t.run();
  assert.equal(ended.reason,'recovery_waiting');assert.equal(creates.length,0,'nothing is created before dueAt');
  assert.equal(record().phase,'stopped');assert.equal(record().reason,'step_failure');assert.equal(record().recovery.attempts,1);
  const armedAt=Date.parse(record().recovery.at),dueAt=Date.parse(record().recovery.dueAt);
  assert.equal(dueAt-armedAt,60000,'the first backoff is 60 s');
  assert.ok(t.sleeps.length>=1&&t.sleeps.every(item=>item.at===dueAt),'the sleep is until dueAt');
  // The hourly reconcile is still the fallback: once dueAt has passed it opens the successor.
  skew=dueAt-realNow()+1000;
  const cron=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(cron.started,true);assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE.replace(/_0$/,'_1'));
  assert.equal(record().recovery.attempts,1,'one failure counted once');

  // After the sleep: one successor with no second cron, never before dueAt.
  fresh();createTimes.length=0;
  t=startRun({onSleep:advanceTo});
  ended=await t.run();
  assert.equal(ended.reason,'recovered');assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE.replace(/_0$/,'_1'));
  const due2=t.sleeps[0].at;
  assert.ok(createTimes[0]>=due2,'the successor is created at or after dueAt');
  assert.equal(record().instanceId,creates[0].id);assert.equal(record().recovery.attempts,1);

  // Duplicate wakeups: the instance and the cron after dueAt open the same one deterministic successor.
  fresh();
  t=startRun({onSleep:async date=>{advanceTo(date);}});
  const both=await Promise.all([t.run(),call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'))]);
  assert.ok(creates.length>=1);assert.equal(new Set(creates.map(item=>item.id)).size,1,'one successor id');
  assert.equal(record().recovery.attempts,1,'the counter is not bumped by the race');

  // Superseded while sleeping (another instance owns the record): quiet stop, no create.
  fresh();
  t=startRun({onSleep:async date=>{advanceTo(date);elect(1);}});
  ended=await t.run();
  assert.equal(ended.reason,'not_owner');assert.equal(creates.length,0);

  // An unknown create result keeps the identity and the recovery counts it; the next attempt reuses the same id.
  fresh();
  const failingCreate=binding.create;
  binding.create=async request=>{creates.push(request);throw new Error('network connection lost');};
  t=startRun({onSleep:advanceTo});
  ended=await t.run();
  binding.create=failingCreate;
  assert.equal(ended.reason,'start_uncertain');assert.equal(creates.length,1);
  assert.equal(record().phase,'uncertain');assert.equal(record().recovery.attempts,2);
  const uncertainId=creates[0].id;
  skew=Date.parse(record().recovery.dueAt)-realNow()+1000;
  creates.length=0;
  const retry=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(retry.started,true);assert.equal(creates.length,1);assert.equal(creates[0].id,uncertainId,'the same identity is retried');

  // Progressive backoff and quarantine.
  for(const [previous,delay] of [[1,300000],[2,900000],[3,3600000]]){
   fresh();
   set('epg/discovery-workflow.json',{...record(),recovery:{attempts:previous,reason:'step_failure',at:iso,dueAt:iso,quarantined:false}});
   t=startRun();
   await t.run();
   assert.equal(record().recovery.attempts,previous+1);
   assert.equal(Date.parse(record().recovery.dueAt)-Date.parse(record().recovery.at),delay);
  }
  fresh();creates.length=0;
  set('epg/discovery-workflow.json',{...record(),recovery:{attempts:4,reason:'step_failure',at:iso,dueAt:iso,quarantined:false}});
  t=startRun({onSleep:advanceTo});
  ended=await t.run();
  assert.equal(ended.reason,'recovery_exhausted');assert.equal(creates.length,0);assert.equal(t.sleeps.length,0,'a quarantined recovery does not sleep');
  assert.equal(record().recovery.quarantined,true);

  // A new generation published while sleeping: the wake stops without a successor.
  fresh();creates.length=0;
  t=startRun({onSleep:async date=>{advanceTo(date);armWorkflowAdmission(OTHER);}});
  ended=await t.run();
  assert.equal(creates.length,0);assert.equal(ended.reason,'stale_generation','a newer generation is not opened by the stale instance');
  Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});

  // D1 failure while arming: the arming step is not caught, the instance ends as before and nothing is created.
  fresh();creates.length=0;
  t=startRun({fails:name=>name.startsWith('chunk')||name.startsWith('recover-arm')});
  await assert.rejects(t.run(),thrown=>thrown.code==='discovery_unavailable');
  assert.equal(record().phase,'running');assert.equal(creates.length,0);

  // Failures that are not positively recognised as transient are never recovered here.
  for(const error of [Object.assign(new Error('discovery_fence'),{code:'discovery_fence'}),Object.assign(new Error('discovery_incomplete'),{code:'discovery_incomplete'}),new Error('boom unknown text'),new RangeError('x'),'raw']){
   fresh();creates.length=0;
   t=startRun({error});
   await assert.rejects(t.run(),thrown=>thrown===error);
   assert.equal(record().phase,'running');assert.equal(record().recovery,null);assert.equal(t.sleeps.length,0);assert.equal(creates.length,0);
  }
  // A hard code wins over a transient cause.
  fresh();
  const hardWithCause=Object.assign(new Error('discovery_fence'),{code:'discovery_fence',cause:new Error('network connection lost')});
  t=startRun({error:hardWithCause});
  await assert.rejects(t.run(),thrown=>thrown===hardWithCause);
  assert.equal(record().recovery,null);
  // AIR-364 review: the arming write is a proven CAS. A concurrent write to the same record (same instance and series, an old
  // recovery with an old dueAt still in it) makes the stop CAS lose: the arm re-reads and recomputes, counts the failure once and
  // sleeps until the new due time, never the retained old one.
  const workflowKey='epg/discovery-workflow.json';
  const originalPut=bucket.put;
  let lose=0,losses=0;
  bucket.put=async(key,value,options)=>{
   if(key===workflowKey&&lose>0&&options?.onlyIf){
    lose--;losses++;
    await originalPut.call(bucket,key,JSON.stringify({...record(),touchedByAnotherWriter:losses}));
    return null;
   }
   return originalPut.call(bucket,key,value,options);
  };
  try{
   const oldDue=new Date(realNow()+skew-5000).toISOString();
   const withOldRecovery=()=>{fresh();set(workflowKey,{...record(),recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:oldDue,quarantined:false}});};
   withOldRecovery();creates.length=0;lose=1;losses=0;
   t=startRun({onSleep:async date=>{assert.ok(date.getTime()>Date.parse(oldDue)+200000,'not the retained old dueAt');assert.equal(record().touchedByAnotherWriter,1,'the concurrent write is kept');assert.equal(record().recovery.attempts,2,'the failure is counted once');assert.equal(Date.parse(record().recovery.dueAt),date.getTime());advanceTo(date);}});
   ended=await t.run();
   assert.equal(losses,1,'the stop CAS lost once');
   assert.equal(ended.reason,'recovered');assert.equal(creates.length,1);
   assert.equal(t.sleeps.length>=1&&t.sleeps.every(item=>item.at-Date.parse(oldDue)>=299000),true,'the new 5 min backoff, not the old due');
   // Three lost CAS in a row: no proof of arming, so no sleep and no create; the cron stays the fallback and the record is untouched.
   withOldRecovery();creates.length=0;lose=3;losses=0;
   t=startRun({onSleep:advanceTo});
   ended=await t.run();
   assert.equal(ended.reason,'recovery_write_conflict');assert.equal(t.sleeps.length,0);assert.equal(creates.length,0);
   assert.equal(record().recovery.attempts,1);assert.equal(record().recovery.dueAt,oldDue);assert.equal(record().phase,'running');
   // A retry of the arming step after its write landed counts the failure once.
   withOldRecovery();creates.length=0;lose=0;
   t=startRun();
   const baseDo=t.stepDouble.do.bind(t.stepDouble);
   t.stepDouble.do=async(name,fn)=>{if(name.startsWith('recover-arm')){await fn();return fn();}return baseDo(name,fn);};
   ended=await t.run();
   assert.equal(record().recovery.attempts,2,'one failure counted once across a step retry');
   assert.equal(ended.reason,'recovery_waiting');
   // The arming write itself failing (an error, not a lost CAS) ends the instance as before and creates nothing.
   withOldRecovery();creates.length=0;
   bucket.put=async(key,value,options)=>{if(key===workflowKey&&options?.onlyIf)throw Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable'});return originalPut.call(bucket,key,value,options);};
   t=startRun();
   await assert.rejects(t.run(),thrown=>thrown.code==='discovery_unavailable');
   assert.equal(record().recovery.attempts,1);assert.equal(creates.length,0);
  }finally{bucket.put=originalPut;}
  // The classifier itself: a hostile object whose every read throws is never recoverable; the hint of the last attempt only decides
  // an error that says nothing; a hard code wins over the hint.
  const hostile={get message(){throw new Error('x');},get name(){throw new Error('x');},get code(){throw new Error('x');},get cause(){throw new Error('x');}};
  const classify=call('workflowStepRecoverable');
  assert.equal(classify(hostile,true),false);assert.equal(classify(hostile,false),false);
  assert.equal(classify(new Error('says nothing'),true),true);assert.equal(classify(new Error('says nothing'),false),false);
  assert.equal(classify(Object.assign(new Error('x'),{code:'discovery_fence'}),true),false);
  assert.equal(classify(Object.assign(new Error('x'),{code:'discovery_unavailable'}),false),true);
  assert.equal(classify(null,false),false);assert.equal(classify('discovery_unavailable',false),false);
  // A transient cause alone (the wrapper text is lost by the platform) is recovered.
  fresh();
  t=startRun({error:Object.assign(new Error('wrapper'),{cause:new Error('Network connection lost.')})});
  ended=await t.run();
  assert.equal(ended.reason,'recovery_waiting');assert.equal(record().recovery.attempts,1);
 }finally{Date.now=realNow;delete env.DISCOVERY_EXECUTOR;clearWorkflowAdmission();}
}

// 16. ADR 0103: a projector window refuses every Discovery state write inside its own statement. The Workflow loop treats that as a soft,
// bounded wait to the window's one expiry: nothing is charged to the stall or recovery budget, the instance never ends on a refused
// write, and the record is re-saved afterwards. Real loop interleavings, with the window opened at the exact step named.
{
 const realNow=Date.now;let skew=0;Date.now=()=>realNow()+skew;
 let windowUntil=0;
 const record=()=>records.get('epg/discovery-workflow.json');
 const open=ms=>{windowUntil=Date.now()+ms;return windowUntil;};
 const armWindow=()=>{context.DiscoveryAuthority.writeWorkflow=async()=>{if(windowUntil>Date.now())throw Object.assign(new Error('discovery_window'),{code:'discovery_window',window:{expiresAt:windowUntil,state:'held'}});return {handled:false,saved:false};};};
 const fresh=({elected=true,count=48}={})=>{
  skew=0;windowUntil=0;seed({count});armWorkflowAdmission();armWindow();if(elected)elect();
  Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});creates.length=0;
  binding.create=async request=>{creates.push(request);return {id:request.id};};
  context.advanceDiscovery=realAdvance;
 };
 const harness=({before=async()=>{},failOn=()=>false}={})=>{
  const names=[],slept=[];
  return {names,slept,step:{
   async do(name,fn){names.push(name);await before(name);if(failOn(name))throw Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable'});return fn();},
   async sleepUntil(name,date){slept.push({name,at:date.getTime()});skew=Math.max(skew,date.getTime()-realNow()+1);},
  }};
 };
 const windowSleeps=h=>h.slept.filter(item=>item.name.startsWith('window-sleep'));
 const run=(h,payload={})=>call('runDiscoveryWorkflow')(workflowEnv('workflow'),{programmeRunId:GENERATION,series:0,...payload},h.step);
 try{
  // (a) The window opens between a successful chunk and its progress checkpoint. The checkpoint is refused, the chunk stays counted,
  // the loop sleeps to the expiry (it does not loop on to the next chunk), then re-saves the count before it rolls over.
  fresh();
  let opened=0,expiry=0,stateAtRollover=null;
  let h=harness({before:async name=>{
   if(name.startsWith('progress')&&!name.includes('retry')&&!opened){opened=1;expiry=open(60000);}
   if(name.startsWith('rollover')&&stateAtRollover===null)stateAtRollover={chunks:record().chunksThisInstance,recovery:record().recovery??null,phase:record().phase};
  }});
  let ended=await run(h,{chunkLimit:1});
  assert.equal(ended.reason,'rollover');assert.equal(decided(),24,'exactly one chunk ran');
  assert.ok(h.names.some(name=>name.startsWith('progress-retry')),'the refused checkpoint is retried after the window');
  assert.equal(windowSleeps(h).length,1);assert.equal(windowSleeps(h)[0].at,expiry,'the sleep is to the window expiry');
  assert.ok(h.names.indexOf(h.names.find(name=>name.startsWith('window-sleep')))===-1,'a sleep is not a step name');
  assert.deepEqual(stateAtRollover,{chunks:1,recovery:null,phase:'running'},'the count is persisted after the window and nothing is charged');
  assert.equal(h.names.filter(name=>name.startsWith('chunk')).length,1,'no second chunk is run while the window is held');

  // (b) A wait and a busy checkpoint refused by a window sleep to the later of their own time and the expiry.
  fresh();
  const soon=new Date(Date.now()+10000).toISOString();
  set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:null,remainingChunks:4,nextCatchUpAt:soon,retryAt:soon,programmeRunId:GENERATION});
  let waitExpiry=0,count=0;
  h=harness({before:async name=>{if(name.startsWith('wait')&&!waitExpiry)waitExpiry=open(90000);if(name.startsWith('owner')&&++count>2)throw new Error('stop the loop');}});
  await assert.rejects(run(h),/stop the loop/);
  assert.equal(h.slept[0].name.startsWith('sleep'),true);assert.equal(h.slept[0].at,waitExpiry,'the wait sleeps to the later expiry');
  assert.equal(h.names.findIndex(name=>name.startsWith('chunk'))>h.names.findIndex(name=>name.startsWith('wait')),true,'no chunk runs before the wait');assert.equal(record().recovery??null,null);

  // (b2) A busy chunk carries the hourly gate in its `until`; its checkpoint is refused by a held window. The wake is the window's one expiry (capped),
  // not that hour. Without a window, with an unreadable deadline and with a window beyond the cap the other waits are unchanged.
  const busyRun=async({openMs=0,unreadable=false}={})=>{
   fresh();
   const hour=new Date(Date.now()+3600000).toISOString();
   context.advanceDiscovery=async()=>({stage:'busy',discovery:{reason:'busy',nextCatchUpAt:hour}});
   let expiry=0,owners=0;const chunkAt=[];
   if(unreadable)context.DiscoveryAuthority.writeWorkflow=async()=>{if(!expiry){expiry=-1;throw Object.assign(new Error('discovery_window'),{code:'discovery_window',window:{expiresAt:null,state:'held'}});}return {handled:false,saved:false};};
   const h=harness({before:async name=>{
    if(name.startsWith('busy')&&!expiry&&openMs)expiry=open(openMs);
    if(name.startsWith('chunk'))chunkAt.push(h.slept.length);
    if(name.startsWith('owner')&&++owners>2)throw new Error('stop the loop');
   }});
   const started=Date.now();
   await assert.rejects(run(h),/stop the loop/);
   return {h,hour:Date.parse(hour),expiry,chunkAt,started};
  };
  {
   const r=await busyRun({openMs:300000});
   assert.equal(r.h.slept[0].name.startsWith('busy-sleep'),true,JSON.stringify(r.h.slept));
   assert.equal(r.h.slept[0].at,r.expiry,'the busy checkpoint refused by a window sleeps to the window expiry, not to the hourly gate');
   assert.ok(r.h.slept[0].at<r.hour-1800000,'well before the next hour');
   assert.equal(r.chunkAt[0],0);assert.ok(r.chunkAt.length<2||r.chunkAt[1]>=1,'no second chunk starts before the first sleep: '+JSON.stringify(r.chunkAt));
   assert.equal(r.h.slept.length,2,'no busy loop: one sleep per busy round');
   assert.equal(r.h.slept[1].at,r.hour,'after the window the ordinary busy wait is the hourly gate');
   assert.equal(record().recovery??null,null,'nothing is charged to the stall or recovery budget');
  }
  {
   const r=await busyRun();
   assert.equal(r.h.slept[0].name.startsWith('busy-sleep'),true);assert.equal(r.h.slept[0].at,r.hour,'a normal busy still waits for the hourly gate');
  }
  {
   const r=await busyRun({unreadable:true});
   assert.equal(r.h.slept[0].at,r.hour,'a window refusal without a readable deadline keeps the previous wait');
  }
  {
   const r=await busyRun({openMs:1200000});
   assert.ok(r.h.slept[0].at<=r.started+330000+5000,'a window beyond the cap is capped like every window wait: '+(r.h.slept[0].at-r.started));
   assert.ok(r.h.slept[0].at<r.expiry&&r.h.slept[0].at<r.hour);
  }

  // (c) The start refused by a window: no throw, no create, no recovery state; the next reconcile after the expiry starts it.
  fresh({elected:false});
  records.delete('epg/discovery-workflow.json');etags.delete('epg/discovery-workflow.json');
  const until=open(60000);
  let result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.started,false);assert.equal(result.reason,'projector_window');assert.equal(result.windowUntil,until);
  assert.equal(creates.length,0);assert.equal(record()?.recovery??null,null);
  skew=until-realNow()+1;
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.started,true);assert.equal(creates.length,1);

  // (d) The rollover is refused by a window: the instance sleeps to the expiry and then creates its successor once.
  fresh();
  let rolloverExpiry=0;
  h=harness({before:async name=>{if(name.startsWith('rollover')&&!rolloverExpiry)rolloverExpiry=open(60000);}});
  ended=await run(h,{chunkLimit:1});
  assert.equal(ended.reason,'rollover');assert.equal(creates.length,1,'one successor, created after the window');
  assert.equal(windowSleeps(h)[0].at,rolloverExpiry);assert.ok(h.names.includes('rollover-stop')===false);

  // (e) A final stop refused by a window is retried after the expiry; the record ends stopped and the instance never ends unsaved.
  fresh();
  set('epg/discovery-workflow.json',{...record(),programmeRunId:OTHER});
  elect(0,OTHER);
  let stopExpiry=0;
  h=harness({before:async name=>{if(name.startsWith('stop')&&!name.includes('retry')&&!stopExpiry)stopExpiry=open(60000);}});
  ended=await run(h,{programmeRunId:OTHER});
  assert.equal(ended.reason,'stale_generation');assert.equal(record().phase,'stopped');assert.equal(windowSleeps(h)[0].at,stopExpiry);
  assert.ok(h.names.some(name=>name.startsWith('stop-retry')));

  // (f) Recovery: the arming write and the successor ensure are both refused by a window. The failure is counted once, only when saved.
  fresh();
  let armExpiry=0,succExpiry=0;
  h=harness({failOn:name=>name.startsWith('chunk'),before:async name=>{
   if(name.startsWith('recover-arm')&&!name.includes('retry')&&!armExpiry)armExpiry=open(60000);
   if(name.startsWith('recover-successor')&&!succExpiry){succExpiry=Math.max(windowUntil,Date.now())+1000;windowUntil=succExpiry;}
  }});
  ended=await run(h);
  assert.equal(ended.reason,'recovered');assert.equal(creates.length,1,'one successor');
  assert.equal(record().recovery.attempts,1,'a refused write charges nothing; the failure counts once');
  assert.ok(windowSleeps(h).some(item=>item.at===armExpiry),'arming waits for the expiry');
  assert.ok(windowSleeps(h).some(item=>item.at===succExpiry),'the successor waits for the expiry');

  // (g) Retries: at least three sequential window refusals and lost compare-and-swaps for progress, the final stop and recovery arming.
  // A checkpoint is done only when it is confirmed persisted; exhausted retries end in an explicit deferred state, never as a saved
  // write and never as lost ownership, and no window refusal is charged to the stall or the recovery budget.
  const chain=(prefix,times)=>{let n=0;return async name=>{if(name.startsWith(prefix)&&n<times){n++;open(60000);}};};
  let conflictBudget=0;
  const armConflicts=()=>{
   const windowed=context.DiscoveryAuthority.writeWorkflow;
   context.DiscoveryAuthority.writeWorkflow=async(...args)=>{if(conflictBudget>0){conflictBudget--;return {handled:true,saved:false};}return windowed(...args);};
  };
  const snapshot=h=>({retries:h.names.filter(name=>/^(progress|stop|recover-arm)-retry/.test(name)).length,windowSleeps:windowSleeps(h).length});

  // progress: four refusals in a row, then saved with the count intact and nothing charged.
  fresh();
  let atRollover=null;
  const progressChain=(()=>{let n=0;return async name=>{if(name.startsWith('progress')&&n<4){n++;open(60000);}if(name.startsWith('rollover')&&atRollover===null)atRollover={chunks:record().chunksThisInstance,recovery:record().recovery??null,phase:record().phase};};})();
  h=harness({before:progressChain});
  ended=await run(h,{chunkLimit:1});
  assert.equal(ended.reason,'rollover');assert.deepEqual(snapshot(h),{retries:4,windowSleeps:4});
  assert.deepEqual(atRollover,{chunks:1,recovery:null,phase:'running'},'saved after the fifth attempt, nothing charged');

  // progress: the retry limit is exhausted. The instance ends deferred, the record is untouched and still names this instance.
  fresh();
  h=harness({before:chain('progress',999)});
  ended=await run(h,{chunkLimit:1,windowRetryLimit:3});
  assert.equal(ended.deferred,true);assert.equal(ended.reason,'window_checkpoint_unsaved');assert.equal(ended.stopped,true);
  assert.deepEqual(snapshot(h),{retries:2,windowSleeps:2},'three attempts, a bounded sleep between them');
  assert.equal(record().chunksThisInstance,0,'the unsaved count is not claimed as saved');assert.equal(record().phase,'running');assert.equal(record().instanceId,INSTANCE);
  assert.equal(record().recovery??null,null,'no recovery charge');assert.equal(creates.length,0,'no successor from an unsaved checkpoint');

  // progress: three lost compare-and-swaps end deferred, two are retried and saved.
  fresh();armConflicts();
  h=harness({before:async name=>{if(name.startsWith('progress')&&conflictBudget===0&&!h.armed){h.armed=true;conflictBudget=2;}}});
  ended=await run(h,{chunkLimit:1});
  assert.equal(ended.reason,'rollover');assert.equal(record().recovery??null,null);
  fresh();armConflicts();
  h=harness({before:async name=>{if(name.startsWith('progress')&&!h.armed){h.armed=true;conflictBudget=3;}}});
  ended=await run(h,{chunkLimit:1});
  assert.equal(ended.deferred,true);assert.equal(ended.reason,'checkpoint_unsaved_write_conflict');assert.equal(record().chunksThisInstance,0);
  // progress: another instance owns the record: that is lost ownership, a quiet stop, not a retry.
  fresh();
  h=harness({before:async name=>{if(name.startsWith('progress')&&!h.armed){h.armed=true;elect(1);}}});
  ended=await run(h,{chunkLimit:1});
  assert.equal(ended.reason,'not_owner');assert.equal(ended.deferred,undefined);

  // final stop: four refusals then saved; exhaustion is deferred with the intended reason; lost compare-and-swaps likewise.
  const stopFresh=()=>{fresh();set('epg/discovery-workflow.json',{...record(),programmeRunId:OTHER});elect(0,OTHER);};
  stopFresh();
  h=harness({before:chain('stop',4)});
  ended=await run(h,{programmeRunId:OTHER});
  assert.equal(ended.reason,'stale_generation');assert.equal(ended.deferred,undefined);assert.equal(record().phase,'stopped');assert.deepEqual(snapshot(h),{retries:4,windowSleeps:4});
  stopFresh();
  h=harness({before:chain('stop',999)});
  ended=await run(h,{programmeRunId:OTHER,windowRetryLimit:2});
  assert.equal(ended.deferred,true);assert.equal(ended.reason,'window_stop_unsaved');assert.equal(ended.intended,'stale_generation');
  assert.equal(record().phase,'running','the terminal record is not written, so it is not claimed');assert.equal(record().recovery??null,null);
  stopFresh();armConflicts();
  h=harness({before:async name=>{if(name.startsWith('stop')&&!h.armed){h.armed=true;conflictBudget=3;}}});
  ended=await run(h,{programmeRunId:OTHER});
  assert.equal(ended.deferred,true);assert.equal(ended.reason,'stop_unsaved_write_conflict');assert.equal(record().phase,'running');

  // recovery arming: four refusals then armed exactly once (counted once); exhaustion is deferred, not not_owner, and arms nothing.
  fresh();
  h=harness({failOn:name=>name.startsWith('chunk'),before:chain('recover-arm',4)});
  ended=await run(h);
  assert.equal(ended.reason,'recovered');assert.equal(creates.length,1);assert.equal(record().recovery.attempts,1,'counted once');
  assert.deepEqual({retries:snapshot(h).retries,sleeps:windowSleeps(h).length>=4},{retries:4,sleeps:true});
  fresh();
  h=harness({failOn:name=>name.startsWith('chunk'),before:chain('recover-arm',999)});
  ended=await run(h,{windowRetryLimit:3});
  assert.equal(ended.deferred,true);assert.equal(ended.reason,'window_recovery_unarmed');assert.notEqual(ended.reason,'not_owner');
  assert.equal(creates.length,0);assert.equal(record().recovery??null,null,'nothing armed, nothing charged');assert.equal(record().phase,'running','the reconcile still finds this instance');
 }finally{Date.now=realNow;delete env.DISCOVERY_EXECUTOR;context.advanceDiscovery=realAdvance;clearWorkflowAdmission();}
}

// 17. AIR-428: a halted step_cap with due elapsed opens one successor; a scheduled projector-window
// refusal waits for the expiry in the same tick; refusals are logged; D1/CAS/quarantine/empty/mismatch stay fail-closed.
{
 const logs=[];
 context.console.log=line=>{try{const row=JSON.parse(line);if(row?.event==='discovery_workflow_reconcile')logs.push(row);}catch{}};
 const past=new Date(Date.now()-60000).toISOString();
 const halt=()=>{
  seed({reason:'backoff',remaining:12});
  armWorkflowAdmission();
  Object.assign(env,{DISCOVERY_EXECUTOR:'workflow'});
  set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:iso,hopId:null,remainingChunks:12,nextCatchUpAt:past,retryAt:past,programmeRunId:GENERATION});
  set('epg/discovery-status.json',{programmeRunId:GENERATION,remaining:12,finishedAt:past});
  set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:INSTANCE,phase:'stopped',reason:'step_cap',updatedAt:past,waitingUntil:past,chunksThisInstance:19,lastProgress:null,recovery:{attempts:1,reason:'step_cap',at:past,dueAt:past,quarantined:false}});
  creates.length=0;logs.length=0;
  binding.create=async request=>{creates.push(request);return {id:request.id};};
  binding.get=async()=>({status:'complete'});
 };
 try{
  halt();
  let result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.started,true);assert.equal(result.series,1);assert.notEqual(result.instanceId,INSTANCE);
  assert.equal(creates.length,1);assert.equal(logs[0]?.reason,'started');assert.equal(logs[0]?.attempt,1);
  const again=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.notEqual(again.reason,'started');assert.equal(creates.length,1);

  let windowUntil=0;
  const holdWindow=()=>{context.DiscoveryAuthority.writeWorkflow=async()=>{if(windowUntil>Date.now())throw Object.assign(new Error('discovery_window'),{code:'discovery_window',window:{expiresAt:windowUntil,state:'held'}});return {handled:false,saved:false};};};
  halt();
  windowUntil=Date.now()+60000;holdWindow();
  const waits=[];
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'),{scheduled:true,now:Date.now(),wait:async(outcome,now)=>{waits.push({reason:outcome.reason,windowUntil:outcome.windowUntil,now});windowUntil=0;}});
  assert.equal(result.started,true);assert.equal(result.series,1);assert.equal(creates.length,1);
  assert.equal(waits.length,1);assert.equal(waits[0].reason,'projector_window');
  assert.equal(logs.length,2);assert.equal(logs[0].reason,'projector_window');assert.equal(logs[1].reason,'started');assert.equal(logs[1].scheduled,true);

  halt();
  windowUntil=Date.now()+60000;holdWindow();
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.started,false);assert.equal(result.reason,'projector_window');assert.equal(creates.length,0);assert.equal(logs.length,1);

  halt();
  windowUntil=Date.now()+60000;holdWindow();
  const stubborn=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'),{scheduled:true,now:Date.now(),wait:async()=>{}});
  assert.equal(stubborn.reason,'projector_window');assert.equal(creates.length,0);assert.equal(logs.length,3);

  halt();
  const scheduledTime=Date.now()-400000,holdMs=60000;
  windowUntil=Date.now()+holdMs;holdWindow();
  const delayed=[];
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'),{scheduled:true,now:scheduledTime,wait:async(outcome,now)=>{delayed.push({now,windowUntil:outcome.windowUntil,waitMs:outcome.windowUntil-now});windowUntil=0;}});
  assert.equal(result.started,true);assert.equal(creates.length,1);
  assert.equal(delayed.length,1);
  assert.ok(delayed[0].now-scheduledTime>350000,'wait clock is Date.now, not the stale scheduledTime');
  assert.ok(delayed[0].waitMs>10000&&delayed[0].waitMs<120000,'remaining window from wall clock, not the 330s cap from scheduledTime: '+delayed[0].waitMs);

  halt();
  context.DiscoveryAuthority.readAuthority=async()=>{throw Object.assign(new Error('d1'),{code:'d1_unavailable'});};
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.reason,'d1_unavailable');assert.equal(creates.length,0);assert.equal(logs[0].reason,'d1_unavailable');

  halt();
  const write=context.DiscoveryAuthority.writeWorkflow;
  context.DiscoveryAuthority.writeWorkflow=async()=>({handled:true,saved:false});
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.reason,'write_conflict');assert.equal(creates.length,0);
  context.DiscoveryAuthority.writeWorkflow=write;

  halt();
  set('epg/discovery-workflow.json',{...records.get('epg/discovery-workflow.json'),reason:'recovery_exhausted',recovery:{attempts:5,reason:'recovery_exhausted',at:past,dueAt:null,quarantined:true}});
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.reason,'recovery_exhausted');assert.equal(creates.length,0);

  halt();
  set('epg/resolver-continuation.json',{stage:'complete',reason:null,at:iso,hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.reason,'stopped');assert.equal(creates.length,0);

  halt();
  armPublishedEpg(GENERATION);
  context.DiscoveryAuthority.readAuthority=async()=>({...readyDiscoveryGate(OTHER),publishedProgrammeRunId:OTHER});
  result=await call('reconcileDiscoveryWorkflow')(workflowEnv('workflow'));
  assert.equal(result.reason,'generation_handoff');assert.equal(creates.length,0);
 }finally{
  context.console.log=()=>{};
  delete env.DISCOVERY_EXECUTOR;
  clearWorkflowAdmission();
  context.advanceDiscovery=realAdvance;
 }
}

// AIR-325 integration acceptance through the real entrypoints. A killed hop leaves a `running` record with an expired lease.
// The real HTTP step must not mutate it or run a chunk; the Workflow settles it, and a repeated interruption fails closed in the Workflow.
{
 const ORPHAN='4b9bc7c5-c429-460b-87a5-e4adf2d4fbe8';
 context.advanceDiscovery=realAdvance;
 const orphan=(patch={})=>{
  seed();elect();
  set('epg/resolver-continuation.json',{stage:'running',reason:null,at:iso,hopId:ORPHAN,remainingChunks:5,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION,...patch});
  set('epg/resolver-lease.json',{id:ORPHAN,expiresAt:now-1000});
  creates.length=0;puts.length=0;
 };
 orphan();
 const stored=JSON.stringify(continuation()),leaseBefore=JSON.stringify(records.get('epg/resolver-lease.json'));
 for(const [path,body] of [['/api/sync/epg',{runId:'sync-1'}],['/api/enrichment/discovery/resolve',{}],['/api/enrichment/discovery/resolve',{recovery:'interrupted'}]]){
  const answered=await post(path,body);
  assert.equal(answered.status,200,path);assert.equal(decided(),0,path+' ran no chunk');
  assert.equal(JSON.stringify(continuation()),stored,path+' did not touch the orphan record');
  assert.equal(JSON.stringify(records.get('epg/resolver-lease.json')),leaseBefore,path+' did not take the lease');
 }
 orphan();
 const settled=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
 assert.ok(decided()>0,'the Workflow ran the chunk: '+JSON.stringify(settled));
 assert.notEqual(continuation().hopId,ORPHAN,'the orphan was settled by the Workflow engine');
 orphan({interruptions:1});
 const failedClosed=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
 assert.equal(decided(),0,'a repeated interruption runs no chunk in the Workflow: '+JSON.stringify(failedClosed));
 assert.equal(continuation().reason,'interrupted');assert.equal(continuation().interruptions,2);
}

// AIR-483: a typed refusal of the intent write is a wait, never an untyped intent_uncertain.
{
 const realQueue=context.queueDiscovery;
 const refuse=(code,extra)=>vm.runInContext('queueDiscovery=async()=>{const e=new Error("x");e.code='+JSON.stringify(code)+';'+extra+'throw e;}',context);
 const probe=async()=>{seed();records.delete('epg/resolver-continuation.json');records.delete('epg/resolver-continuation');env.DISCOVERY_EXECUTOR='workflow';armWorkflowAdmission();creates.length=0;return call('reconcileDiscoveryWorkflow')(env);};
 refuse('discovery_window','e.window={expiresAt:123,state:"held"};');
 const win=await probe();
 assert.equal(win.reason,'projector_window');assert.equal(win.windowUntil,123);assert.equal(creates.length,0);
 refuse('discovery_epg_priority','e.priority={nextCatchUpAt:Date.now()+60000};');
 assert.equal((await probe()).reason,'epg_priority');
 refuse('discovery_fence','');
 assert.equal((await probe()).reason,'authority_held');
 refuse('boom','');
 assert.equal((await probe()).reason,'intent_uncertain');
 context.queueDiscovery=realQueue;
}

console.log('Discovery workflow: retired selector ignored, delegated requests, fail-closed without Workflow admission, renewal past 12, backoff, fencing, recovery, cron reconcile and an inert binding passed');
