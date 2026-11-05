// AIR-323 / ADR 0083: the Discovery Workflow is inert unless DISCOVERY_EXECUTOR=workflow.
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
for(const [value,mode] of [[undefined,'external'],[null,'external'],['','external'],['external','external'],['workflow','workflow'],['Workflow','invalid'],[' workflow','invalid']])assert.equal(call('discoveryExecutorMode')({DISCOVERY_EXECUTOR:value}),mode,JSON.stringify(value));

// 1. Absent flag: one explicit step still runs one chunk.
seed();
let response=await post('/api/sync/epg',{runId:'sync-1'});
assert.equal(response.status,200);assert.equal(response.data.discovery.nextAction,'continue');assert.equal(response.data.delegated,undefined);
assert.equal(decided(),24);assert.equal(creates.length,0);assert.equal(continuation().reason,null);

// 2. Workflow mode does not run the chunk in the request and does not call the series complete.
seed();
response=await post('/api/sync/epg',{runId:'sync-1'},workflowEnv('workflow'));
assert.equal(response.status,200);assert.equal(response.data.delegated,true);assert.equal(response.data.executor,'workflow');
assert.equal(response.data.discovery.nextAction,'wait');assert.equal(response.data.discovery.reason,'delegated');
assert.equal(decided(),0);assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE);assert.equal(creates[0].params.chunkLimit,undefined);
assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);

// 3. An invalid flag fails closed on a chunk and still lets the commit tail publish its intent.
seed();
response=await post('/api/sync/epg',{runId:'sync-1'},workflowEnv('nope'));
assert.equal(response.status,503);assert.equal(response.data.error,'discovery_executor_invalid');assert.equal(decided(),0);assert.equal(creates.length,0);
seed({stage:'epg',syncId:GENERATION,programmeRunId:GENERATION});
response=await post('/api/sync/epg',{runId:GENERATION},workflowEnv('nope'));
assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.stage,'complete');assert.equal(response.data.executor,'invalid');
assert.equal(decided(),0);assert.equal(creates.length,0);assert.equal(continuation().reason,'epg_committed');

// The same commit tail in workflow mode recovers the queued intent without a chunk.
seed({stage:'epg',syncId:GENERATION,programmeRunId:GENERATION});
response=await post('/api/sync/epg',{runId:GENERATION},workflowEnv('workflow'));
assert.equal(response.status,200);assert.equal(response.data.delegated,true);assert.equal(response.data.discovery.reason,'delegated');
assert.notEqual(response.data.discovery.nextAction,'stop');assert.equal(decided(),0);
assert.equal(new Set(creates.map(item=>item.id)).size,1);

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
assert.equal(Object.hasOwn(pipeline,'discoveryExecutor'),false);assert.equal(creates.length,0);assert.equal(puts.length,0);
env.DISCOVERY_EXECUTOR='workflow';
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.configured,'workflow');assert.equal(pipeline.discoveryExecutor.owner,'none');
assert.equal(creates.length,0);assert.equal(puts.length,0);
env.DISCOVERY_EXECUTOR='nope';
pipeline=await status();
assert.equal(pipeline.discoveryExecutor.configured,'invalid');assert.equal(pipeline.discoveryExecutor.degraded,true);assert.equal(creates.length,0);
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
const cooled=await call('reconcileDiscoveryWorkflow')(env);
const cooledAgain=await call('ensureDiscoveryWorkflow')(env);
assert.equal(cooled.reason,'recovery_waiting');assert.equal(cooledAgain.reason,'recovery_waiting');assert.equal(creates.length,0);
records.get('epg/discovery-workflow.json').recovery.dueAt=new Date(Date.now()-1000).toISOString();
const eligible=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(eligible.started,true);assert.equal(eligible.series,1);assert.equal(creates.length,1);
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
const quarantined=await call('reconcileDiscoveryWorkflow')(env);
assert.equal(quarantined.reason,'recovery_exhausted');assert.equal(creates.length,0);

// 11. The production entry is inert: no flag, no schedule, and cron does not start discovery.
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.main,'dist/server/workflow-entry.js');
assert.deepEqual(wrangler.triggers.crons,['37 * * * *']);
assert.equal(wrangler.vars.DISCOVERY_EXECUTOR,undefined);
assert.equal(JSON.stringify(wrangler).includes('schedules'),false);
assert.equal(wrangler.workflows[0].binding,'DISCOVERY_WORKFLOW');
assert.equal(wrangler.workflows[0].class_name,'DiscoveryWorkflow');
assert.equal(wrangler.workflows[0].schedules,undefined);
const scheduled=fs.readFileSync('src/worker.js','utf8').match(/async scheduled[\s\S]*?async fetch/)[0];
assert.doesNotMatch(scheduled,/reconcileDiscoveryWorkflow|DISCOVERY_WORKFLOW|advanceDiscovery/);
const build=fs.readFileSync('build.mjs','utf8');
const indexWrite=build.slice(build.indexOf("fs.writeFileSync('dist/server/index.js'"),build.indexOf("fs.writeFileSync('dist/server/workflow-entry.js'"));
assert.match(indexWrite,/src\/discovery-workflow\.js/);
assert.doesNotMatch(indexWrite,/cloudflare:workers/);
assert.match(build,/import \{ WorkflowEntrypoint \} from 'cloudflare:workers'/);
assert.match(build,/export \{ runDiscoveryWorkflow, reconcileDiscoveryWorkflow(, runRatingsWorkflow)? \}/);

console.log('Discovery workflow: external parity, delegated requests, invalid fail-closed, renewal past 12, backoff, fencing, recovery and an inert binding passed');
