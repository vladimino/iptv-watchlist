// AIR-534 scope 3 (ADR 0174): the Discovery-only fast cron. Offline only: in-memory R2 stand-in, a stub Workflow binding, stubbed authority. Nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const logs=[];
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
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,console:{log(m){logs.push(m);},error(){},warn(){}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
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

const fast=(options={})=>call('reconcileDiscoveryRecovery')(env,options);
const FAST=call('DISCOVERY_FAST_CRON');
let statusOf='running';
binding.get=async()=>({status:statusOf});
const workflowRecord=()=>records.get('epg/discovery-workflow.json');
const stopped=(extra={},series=0)=>{
 const instanceId=`discovery_${GENERATION.replace(/-/g,'')}_${series}`;
 set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId:GENERATION,series,instanceId,phase:'stopped',reason:'step_failure',updatedAt:new Date().toISOString(),waitingUntil:null,chunksThisInstance:3,lastProgress:null,recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()-180000).toISOString(),quarantined:false},...extra});
 return instanceId;
};
let reads=0,authorityReads=0,publishedReads=0;
const realGet=bucket.get;bucket.get=async key=>{reads++;return realGet.call(bucket,key);};
const fresh=()=>{seed();armWorkflowAdmission(GENERATION);statusOf='running';logs.length=0;reads=0;authorityReads=0;publishedReads=0;{const real=context.PublishedEpg.currentGeneration;context.PublishedEpg.currentGeneration=async(...a)=>{publishedReads++;return real(...a);};}const real=context.DiscoveryAuthority.readAuthority;context.DiscoveryAuthority.readAuthority=async(...a)=>{authorityReads++;return real(...a);};};
const eventKeys=()=>[...records.keys()].filter(key=>key.startsWith('events/'));

// 0. The expression, the constants and the dispatch.
assert.equal(FAST,'1-59/2 * * * *');assert.notEqual(FAST.split(' ')[0].split('-')[0],'0','never minute 0');
assert.equal(JSON.stringify(call('fastRecoveryPlan')(null,now)),JSON.stringify({action:'noop',reason:'no_record'}));

// 1. A healthy live instance: one record read, one platform status, no create, no write, no authority read, no report.
fresh();elect(0);
let out=await fast();
assert.equal(out.reason,'in_progress');assert.equal(out.started,false);assert.equal(creates.length,0);assert.equal(puts.length,0);
assert.equal(reads,1,'one read of the Workflow record');assert.equal(authorityReads,0,'no authority or ledger read at idle');assert.deepEqual(eventKeys(),[]);
for(const live of ['waiting','queued','paused']){statusOf=live;out=await fast();assert.equal(out.reason,'in_progress',live);assert.equal(creates.length,0);assert.equal(puts.length,0);}
statusOf='nonsense';out=await fast();assert.equal(out.reason,'instance_status_unknown','an unreadable platform status fails closed');assert.equal(creates.length,0);assert.equal(puts.length,0);

// 2. Stopped, recovery not yet due: nothing is read beyond the record and nothing is written.
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()+600000).toISOString(),quarantined:false}});
out=await fast();
assert.equal(out.reason,'recovery_waiting');assert.equal(out.recovery.state,'waiting');assert.equal(creates.length,0);assert.equal(puts.length,0);assert.equal(authorityReads,0);assert.equal(reads,1);

// 3. Stopped and already due (the incident shape): the fast tick starts the successor with the deterministic id and says how late it was.
fresh();let oldId=stopped();
out=await fast();
assert.equal(out.started,true,JSON.stringify(out));assert.equal(creates.length,1);assert.equal(creates[0].id,`discovery_${GENERATION.replace(/-/g,'')}_1`);assert.equal(creates[0].params.series,1);
assert.equal(out.recovery.state,'started');assert.equal(out.recovery.recoveryDelayMs>=179000&&out.recovery.recoveryDelayMs<200000,true,String(out.recovery.recoveryDelayMs));
assert.equal(workflowRecord().series,1);assert.equal(workflowRecord().phase,'running');
const tick=logs.map(item=>{try{return JSON.parse(item);}catch{return null;}}).find(item=>item?.event==='discovery_recovery_tick');
assert.equal(tick.state,'started');assert.equal(tick.recoveryDelayMs>=179000,true);assert.deepEqual(eventKeys(),[],'no hourly report from a fast tick');
void oldId;

// 4. Wait, then due, then success: the same record is waiting first and is taken over by the first tick after its due time.
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()+1500).toISOString(),quarantined:false}});
out=await fast();assert.equal(out.reason,'recovery_waiting');assert.equal(creates.length,0);
await new Promise(resolve=>setTimeout(resolve,1700));
out=await fast();assert.equal(out.started,true);assert.equal(creates.length,1);

// 5. A killed, completed or errored instance behind a live-looking record is armed with a backoff first, never replaced at once.
for(const dead of ['complete','errored','terminated']){
 fresh();elect(0);statusOf=dead;
 out=await fast();
 assert.equal(out.started,false,dead);assert.equal(out.reason,'recovery_waiting',dead);assert.equal(workflowRecord().phase,'stopped',dead);assert.equal(typeof workflowRecord().recovery.dueAt,'string',dead);assert.equal(creates.length,0,dead);
}

// 6. A true stop and a quarantine are never recovered.
fresh();stopped({reason:'complete',recovery:null});
out=await fast();assert.equal(out.reason,'stopped');assert.equal(creates.length,0);assert.equal(puts.length,0);
fresh();stopped({reason:'recovery_exhausted',recovery:{attempts:9,reason:'step_failure',at:iso,dueAt:null,quarantined:true}});
out=await fast();assert.equal(out.reason,'recovery_exhausted');assert.equal(creates.length,0);assert.equal(puts.length,0);

// 7. Refusals (due recovery, nothing is created): authority held or loading, D1 unavailable, a published run mismatch, an EPG priority and a projector window. Each says why and how late.
const refused=async(label,arm,expected)=>{
 fresh();stopped();arm();
 const result=await fast();
 assert.equal(result.started,false,label);assert.equal(result.reason,expected,label+': '+JSON.stringify(result));assert.equal(creates.length,0,label);
 assert.equal(result.recovery.state,'refused',label);assert.equal(result.recovery.reason,expected,label);assert.equal(result.recovery.overdueMs>=179000,true,label);assert.equal(result.recovery.incident,false,label+': 3 minutes is not yet an incident');
 return result;
};
await refused('authority held',()=>{const gate=context.DiscoveryAuthority.readAuthority;context.DiscoveryAuthority.readAuthority=async(...a)=>({...(await gate(...a)),held:true});},'authority_held');
await refused('authority loading',()=>{const gate=context.DiscoveryAuthority.readAuthority;context.DiscoveryAuthority.readAuthority=async(...a)=>({...(await gate(...a)),transfer:'loading'});},'authority_loading');
await refused('D1 unavailable',()=>{context.DiscoveryAuthority.readAuthority=async()=>{throw new Error('d1');};},'d1_unavailable');
await refused('EPG priority',()=>{context.DiscoveryAuthority.writeWorkflow=async()=>{throw Object.assign(new Error('discovery_epg_priority'),{code:'discovery_epg_priority',window:{expiresAt:Date.now()+60000,state:'held'}});};},'epg_priority');
await refused('projector window',()=>{context.DiscoveryAuthority.writeWorkflow=async()=>{throw Object.assign(new Error('discovery_window'),{code:'discovery_window',window:{expiresAt:Date.now()+60000,state:'held'}});};},'projector_window');
// A published run that is not the Workflow's run: the series of the old run is not resumed.
fresh();stopped();armPublishedEpg(OTHER);
out=await fast();assert.equal(out.started,false);assert.equal(creates.length,0,'a published generation mismatch creates nothing: '+JSON.stringify(out));
// More than five minutes late and still refused is an operational incident.
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()-400000).toISOString(),quarantined:false}});
context.DiscoveryAuthority.readAuthority=async()=>({...readyDiscoveryGate(GENERATION),held:true});
out=await fast();assert.equal(out.recovery.state,'refused');assert.equal(out.recovery.incident,true);

// 8. Two fast ticks, a fast tick beside the hourly reconcile and a repeated tick: exactly one successor, one series bump, no second owner, no report from the fast ticks.
fresh();stopped();
const both=await Promise.all([fast(),fast(),call('reconcileDiscoveryWorkflow')(env,{scheduled:false})]);
assert.equal(new Set(creates.map(item=>item.id)).size,1,'one deterministic successor id: '+JSON.stringify(creates.map(item=>item.id)));
assert.equal(workflowRecord().series,1);assert.equal(both.filter(item=>item.started===true&&item.attached!==true).length>=1,true);
const again=await fast();assert.equal(again.reason,'in_progress');assert.equal(new Set(creates.map(item=>item.id)).size,1);
assert.deepEqual(eventKeys(),[]);

// 9. An uncertain start: due is retried through the existing path, not due waits, quarantined stays.
fresh();stopped({phase:'uncertain',reason:'start_uncertain',recovery:{attempts:1,reason:'start_uncertain',at:iso,dueAt:new Date(Date.now()+600000).toISOString(),quarantined:false}});
out=await fast();assert.equal(out.reason,'recovery_waiting');assert.equal(creates.length,0);assert.equal(puts.length,0);

// 10. Isolation: the fast cron entry runs the reconcile only. No EPG, Ratings or Monitor code and no hourly report; the hourly entry still runs EPG and Monitor and never the legacy Ratings executor (AIR-580).
const called={epg:0,ratings:0,monitor:0};
context.EpgOrchestration={ensure:async()=>{called.epg++;}};context.RatingsOrchestration={ensure:async()=>{called.ratings++;}};context.Monitor={run:async()=>{called.monitor++;}};
const waits=[];const exec={waitUntil(p){waits.push(p);}};
fresh();stopped();
await worker.scheduled({cron:FAST,scheduledTime:Date.now()},env,exec);await Promise.all(waits);
assert.deepEqual(called,{epg:0,ratings:0,monitor:0},'the fast tick touches nothing but Discovery');assert.equal(creates.length,1);assert.deepEqual(eventKeys(),[]);
waits.length=0;fresh();elect(0);
await worker.scheduled({cron:'0 * * * *',scheduledTime:Date.now()},env,exec);await Promise.all(waits);
assert.deepEqual(called,{epg:1,ratings:0,monitor:1},'the hourly entry runs EPG and Monitor and not the legacy Ratings executor');
waits.length=0;
await worker.scheduled({scheduledTime:Date.now()},env,exec);await Promise.all(waits);
assert.deepEqual(called,{epg:2,ratings:0,monitor:2},'an entry without a cron string keeps the hourly behaviour');

// 11. The status readout: waiting, overdue and the five-minute incident threshold.
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()+600000).toISOString(),quarantined:false}});
set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',at:iso,hopId:null,remainingChunks:5,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
statusOf='complete';
let readout=await call('discoveryExecutorReadout')(env,continuation());
assert.equal(readout.recoveryState,'waiting');assert.equal(readout.recoveryOverdue,false);assert.equal(readout.recoveryIncident,false);
workflowRecord().recovery.dueAt=new Date(Date.now()-120000).toISOString();
readout=await call('discoveryExecutorReadout')(env,continuation());
assert.equal(readout.recoveryState,'overdue');assert.equal(readout.recoveryOverdue,true);assert.equal(readout.degraded,true);assert.equal(readout.recoveryIncident,false);
workflowRecord().recovery.dueAt=new Date(Date.now()-400000).toISOString();
readout=await call('discoveryExecutorReadout')(env,continuation());
assert.equal(readout.recoveryIncident,true,'more than five minutes overdue is an incident');assert.equal(readout.recoveryOverdueMs>=400000,true);


// 12. AIR-534 review P1: the fast tick also covers a missed EPG handoff. No Workflow record, or a record of an older generation than the published one (also with a live old
// instance), is handed to the existing reconcile, which reconstructs the intent and creates the new generation's series 0 under admission, CAS and the deterministic id.
const ticks=()=>logs.map(item=>{try{return JSON.parse(item);}catch{return null;}}).filter(item=>item?.event==='discovery_recovery_tick');
fresh();
assert.equal(workflowRecord(),undefined,'the EPG commit queued Discovery but its start was lost: no record');
out=await fast();
assert.equal(out.started,true,JSON.stringify(out));assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE);assert.equal(out.recovery.kind,'handoff');assert.equal(out.recovery.state,'started');assert.equal(out.recovery.incident,false);
assert.equal(ticks()[0].kind,'handoff');assert.deepEqual(eventKeys(),[]);
// Refused admission on a missing record is typed, creates nothing and is logged.
fresh();{const gate=context.DiscoveryAuthority.readAuthority;context.DiscoveryAuthority.readAuthority=async(...a)=>({...(await gate(...a)),held:true});}
out=await fast();assert.equal(out.started,false);assert.equal(out.reason,'authority_held');assert.equal(creates.length,0);assert.equal(out.recovery.kind,'handoff');assert.equal(out.recovery.state,'refused');
// An older generation's instance is still alive after the publication and the EPG fast start was missed.
fresh();elect(0,OTHER);statusOf='running';
out=await fast();
assert.equal(out.started,true,JSON.stringify(out));assert.equal(creates.length,1);assert.equal(creates[0].id,INSTANCE,'the new generation starts at series 0');assert.equal(out.recovery.kind,'handoff');assert.equal(workflowRecord().programmeRunId,GENERATION);
// An older generation's terminal stop and its undue recovery do not hide the published generation either.
fresh();{const id=stopped({reason:'complete',recovery:null});set('epg/discovery-workflow.json',{...workflowRecord(),programmeRunId:OTHER,instanceId:id.replace(GENERATION.replace(/-/g,''),OTHER.replace(/-/g,''))});}
out=await fast();assert.equal(out.started,true,JSON.stringify(out));assert.equal(creates[0].id,INSTANCE);
fresh();{const id=stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()+600000).toISOString(),quarantined:false}});set('epg/discovery-workflow.json',{...workflowRecord(),programmeRunId:OTHER});void id;}
out=await fast();assert.equal(out.started,true,JSON.stringify(out));assert.equal(creates[0].id,INSTANCE);
// Two fast ticks beside the hourly reconcile on the missed handoff: one creation of the one deterministic id, no report from the fast ticks.
fresh();elect(0,OTHER);
await Promise.all([fast(),fast(),call('reconcileDiscoveryWorkflow')(env,{scheduled:false})]);
assert.equal(new Set(creates.map(item=>item.id)).size,1);assert.equal(creates[0].id,INSTANCE);assert.equal(workflowRecord().programmeRunId,GENERATION);assert.deepEqual(eventKeys(),[]);
// Healthy idle cost with the probe: record read + published read (+ one status call), no write, no authority read, nothing created.
fresh();elect(0);
out=await fast();assert.equal(out.reason,'in_progress');assert.equal(reads,1);assert.equal(publishedReads,1,'one published-generation read');assert.equal(authorityReads,0);assert.equal(creates.length,0);assert.equal(puts.length,0);assert.equal(ticks().length,0,'a healthy tick logs nothing');
// An unreadable published pointer fails closed with a typed, logged failure.
fresh();elect(0);context.PublishedEpg.currentGeneration=async()=>{throw new Error('d1');};
out=await fast();assert.equal(out.reason,'published_unreadable');assert.equal(creates.length,0);assert.equal(puts.length,0);assert.equal(out.recovery.state,'failed');assert.equal(ticks()[0].reason,'published_unreadable');

// 13. AIR-534 review P2: a late success is an incident; typed failures are logged and never claim success.
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()-400000).toISOString(),quarantined:false}});
out=await fast();assert.equal(out.started,true);assert.equal(out.recovery.incident,true,'more than five minutes late and started');assert.equal(out.recovery.recoveryDelayMs>=400000,true);assert.equal(ticks()[0].incident,true);
fresh();stopped({recovery:{attempts:1,reason:'step_failure',at:iso,dueAt:new Date(Date.now()-240000).toISOString(),quarantined:false}});
out=await fast();assert.equal(out.started,true);assert.equal(out.recovery.incident,false,'four minutes late is not an incident');assert.equal(ticks()[0].incident,false);
fresh();elect(0);statusOf='nonsense';
out=await fast();assert.equal(out.reason,'instance_status_unknown');assert.equal(out.recovery.state,'failed');assert.equal(out.started,false);assert.equal(ticks()[0].state,'failed');
fresh();elect(0);{const real=bucket.get;bucket.get=async()=>{throw new Error('r2');};out=await fast();bucket.get=real;}
assert.equal(out.reason,'fast_tick_error');assert.equal(out.started,false);assert.equal(out.recovery.state,'failed');assert.equal(ticks()[0].reason,'fast_tick_error');
fresh();{const real=binding.create;binding.create=undefined;out=await fast();binding.create=real;}
assert.equal(out.reason,'workflow_unavailable');assert.equal(out.recovery.state,'failed');


// 14. AIR-534 review P2: the three-way interleaving the handoff requires. The OLD owner (armed recovery, durable sleep) wakes at the due time at the same moment as two fast ticks and
// the REAL scheduled hourly reconcile, which also closes the hourly report (outbox, D1 generation CAS). Exactly one deterministic successor and one series bump, the counters of the
// committed chunk are reported exactly once (no lost checkpoint, no duplicate report), the fast ticks write no report, and the displaced owner writes nothing when it wakes again.
{
 fresh();elect(0);
 const hourMs=Math.floor(Date.now()/3600000)*3600000;
 {const rec=workflowRecord();const base=call('newDiscoveryReport')(new Date(hourMs-1800000).toISOString(),[]);rec.report=call('addChunkToDiscoveryReport')(base,{checked:5,added:1,reused:0,screenedOut:0,touched:0,tmdbCalls:2,remaining:7,cheapRemaining:0,error:null},'k-1',GENERATION);set('epg/discovery-workflow.json',rec);}
 const transient=()=>Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable'});
 let group=null,sleepCalls=0;
 const owner={
  async do(name,fn){if(name.startsWith('chunk'))throw transient();return fn();},
  async sleepUntil(){
   sleepCalls++;
   if(sleepCalls>1)return;
   // The due time has come: age the armed recovery, then fire the other writers while this instance wakes.
   const rec=workflowRecord();rec.recovery.dueAt=new Date(Date.now()-1000).toISOString();set('epg/discovery-workflow.json',rec);
   group=Promise.all([fast(),fast(),call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:hourMs+1000})]);
  },
 };
 const ended=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},owner);
 const [fastA,fastB,hourlyOut]=await group;
 const successorId=INSTANCE.replace(/_0$/,'_1');
 assert.equal(new Set(creates.map(item=>item.id)).size,1,'one deterministic successor id: '+JSON.stringify(creates.map(item=>item.id)));
 assert.equal(creates[0].id,successorId);
 assert.equal(workflowRecord().instanceId,successorId);assert.equal(workflowRecord().series,1,'one series bump');assert.equal(workflowRecord().programmeRunId,GENERATION);
 assert.equal(workflowRecord().recovery?.attempts??1,1,'the failure is counted once');
 assert.equal(['recovered','not_owner','recovery_waiting'].includes(ended.reason)||ended.stopped===true,true,'the woken owner ended cleanly: '+JSON.stringify(ended));
 // The hourly reconcile really ran as a scheduled firing: its report is closed and delivered once, with the committed chunk's counters.
 const stamp=new Date(hourMs).toISOString().replace(/[-:]/g,'').slice(0,11);
 const hourEvents=eventKeys().map(key=>records.get(key)).filter(event=>event?.kind==='hour');
 assert.equal(hourEvents.length,1,'exactly one hourly report: '+JSON.stringify(eventKeys()));
 assert.equal(hourEvents[0].id.endsWith('-'+stamp),true,hourEvents[0].id);
 assert.equal(hourEvents[0].checked,5);assert.equal(hourEvents[0].added,1);assert.equal(hourEvents[0].chunks,1);
 const left=workflowRecord().report;
 assert.equal(hourEvents[0].checked+(left?.checked||0),5,'no counter is lost or doubled across the successor');assert.equal(left.lastClosedHour,stamp);
 assert.equal((workflowRecord().outbox||[]).length,0,'the outbox was delivered');
 // A repeated firing of the same hour and further fast ticks add no report and no creation.
 const repeat=await call('reconcileDiscoveryWorkflow')(env,{scheduled:true,now:hourMs+2000});
 await fast();
 assert.equal(eventKeys().map(key=>records.get(key)).filter(event=>event?.kind==='hour').length,1,'no duplicate report: '+JSON.stringify(repeat));
 assert.equal(new Set(creates.map(item=>item.id)).size,1);
 // The displaced owner wakes again: not owner, nothing written, nothing fetched.
 const putsBefore=puts.length;
 const displaced=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},{async do(name,fn){return fn();},async sleepUntil(){}});
 assert.equal(displaced.reason,'not_owner',JSON.stringify(displaced));assert.equal(puts.length,putsBefore,'the displaced owner wrote nothing');
 void fastA;void fastB;void hourlyOut;
}

console.log('Discovery fast recovery cron: idle cost, due and undue, kill detection, true stop and quarantine, every refusal, duplicate ticks, isolation from EPG/Ratings/Monitor and the readout passed');
