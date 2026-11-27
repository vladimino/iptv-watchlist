// AIR-524 / ADR 0164: the controlled Discovery Workflow rollover onto the deployed Worker version. The preflight writes nothing; an apply swaps
// the executor record by compare-and-swap only while the owner is provably asleep, creates exactly one deterministic successor of the same
// generation, carries the report, the outbox and the continuation untouched, and reads back. Concurrent operator calls, the cron reconcile, the
// old instance's own natural rollover and a woken old instance all resolve through the existing owner gate and CAS. No production binding is used.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0;const puts=[];
let putHook=null;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);
  if(putHook){const hook=putHook;const answer=hook(key);if(answer==='lost')return null;}
  return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const creates=[];let createFault=null;const liveness=new Map();
const binding={
 async create(request){
  creates.push(JSON.parse(JSON.stringify(request)));
  if(createFault){const fault=createFault;createFault=null;creates[creates.length-1].failed=true;throw fault;}
  if(creates.filter(item=>item.id===request.id&&!item.failed).length>1)throw new Error('Instance already exists');
  liveness.set(request.id,'running');return {id:request.id};
 },
 async get(id){if(liveness.get(id)==='throw')throw new Error('upstream unavailable');if(!liveness.has(id))throw new Error('instance not found');return {status:liveness.get(id)};}
};
const VERSION_OLD='0f0f0f0f-1111-4222-8333-444444444444',VERSION_NEW='1a1a1a1a-5555-4666-8777-888888888888';
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester',DISCOVERY_WORKFLOW:binding,CF_VERSION_METADATA:{id:VERSION_NEW,tag:'',timestamp:'2026-11-17T00:00:00Z'}};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,console:{log(){},error(){},warn(){}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/discovery-workflow.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
const call=code=>vm.runInContext(code,context);
const tool=async args=>JSON.parse(JSON.stringify(await call('handleDiscoveryRolloverTool')(env,args)));
const GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',OTHER='b2699929-1111-4222-8333-444444444444';
const instance=(series,run=GENERATION)=>`discovery_${run.replace(/-/g,'')}_${series}`;
const OLD=instance(0),NEXT=instance(1);
const STATE='epg/discovery-workflow.json',CONT='epg/resolver-continuation.json',LEASE='epg/resolver-lease.json',STATUS='epg/discovery-status.json';

let gates,authority,published,writeFault=null,swapCalls=0;
function armAuthority(){
 context.DiscoveryAuthority={
  ownsKey:()=>false,
  readAuthority:async()=>authority,
  readWorkflow:async()=>({handled:false}),
  // Routine record writes take the R2 path of the in-memory store. The rollover swap passes the generation pin and is routed like the D1 writer:
  // the pin is checked against the CURRENT authority and published pointer in the same step as the revision compare-and-swap.
  writeWorkflow:async(_env,record,etag,options)=>{
   if(writeFault){const fault=writeFault;writeFault=null;throw fault;}
   if(options?.expectedProgrammeRunId===undefined)return {handled:false,saved:false};
   swapCalls++;
   const pin=options.expectedProgrammeRunId;
   if(authority.programmeRunId!==pin||authority.publishedProgrammeRunId!==pin||published!==pin)return {handled:true,saved:false,stale:true};
   const saved=await bucket.put(STATE,JSON.stringify(record),{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
   return {handled:true,saved:saved!==null};
  },
  routeRead:async()=>({handled:false}),routeWrite:async()=>({handled:false}),
  readContinuation:async()=>({handled:false}),writeContinuation:async()=>({handled:false}),
  readLease:async()=>({handled:false}),releaseLease:async()=>({handled:false}),
  readDiscoveryGates:async()=>({...structuredClone(gates),programmeRunId:authority.programmeRunId,publishedProgrammeRunId:authority.publishedProgrammeRunId}),
 };
 context.PublishedEpg={currentGeneration:async()=>published?{authority:'d1',programmeRunId:published,phase:'published',generation:7}:null};
}
// A sleeping owner on the old version: a durable wait that ends in an hour, a saved checkpoint, no lease, idle gates.
function seed({phase='waiting',waitingUntil=new Date(Date.now()+3600000).toISOString(),versionId,stage='paused'}={}){
 records.clear();etags.clear();puts.length=0;creates.length=0;liveness.clear();createFault=null;writeFault=null;putHook=null;
 authority={ready:true,held:false,tables:true,mode:'d1',cutover:'open',version:23,generation:5,programmeRunId:GENERATION,publishedProgrammeRunId:GENERATION,transfer:'idle'};
 published=GENERATION;
 gates={window:{present:true,state:'idle',active:false,expiresAt:null},priority:{present:true,paused:false,reason:'published',nextCatchUpAt:null}};
 set(STATE,{schemaVersion:1,programmeRunId:GENERATION,series:0,instanceId:OLD,phase,updatedAt:new Date().toISOString(),waitingUntil,reason:'unknown_remaining',chunksThisInstance:4,lastProgress:null,lastUsefulProgressAt:'2026-11-17T09:30:00.000Z',usefulProgressTrackedSince:'2026-11-17T08:00:00.000Z',recovery:null,...(versionId?{versionId}:{}),report:{since:'2026-11-17T10:00:00.000Z',chunks:3,checked:30,added:2,reused:1,screenedOut:0,touched:4,tmdbCalls:9,remaining:41,cheapRemaining:0,error:null,queueGeneration:GENERATION,seen:[OLD+':3'],lastClosedHour:'20261117T09'},outbox:[{id:'discovery-hour-a30f67e93a11-20261117T09',type:'discovery',kind:'hour'}]});
 set(CONT,{stage,reason:'chunk_budget',at:new Date().toISOString(),hopId:'hop-77',remainingChunks:0,nextCatchUpAt:waitingUntil,retryAt:null,programmeRunId:GENERATION});
 set(STATUS,{programmeRunId:GENERATION,remaining:41,cheapRemaining:0,replayAfter:'slot|2026-11-17|ch-9'});
 liveness.set(OLD,'waiting');
 armAuthority();
}
const snapshot=()=>JSON.stringify([...records.entries()]);
const pins=(extra={})=>({mode:'apply',confirmGo:true,requestId:'owner-go-0001',expectedProgrammeRunId:GENERATION,expectedInstanceId:OLD,expectedSeries:0,...extra});

// 1. The preflight of an eligible sleeping owner on an older version: every fact, the decision, the pins, zero writes and zero creates.
seed();
let before=snapshot();
let reply=await tool({mode:'dry_run'});
assert.equal(reply.status,200);assert.equal(reply.body.decision,'eligible',JSON.stringify(reply.body));
assert.deepEqual(reply.body.expect,{programmeRunId:GENERATION,instanceId:OLD,series:0});
assert.equal(reply.body.writes,0);assert.equal(snapshot(),before);assert.equal(creates.length,0);assert.equal(puts.length,0);
const view=reply.body.preflight;
assert.equal(view.published.programmeRunId,GENERATION);assert.equal(view.published.authority,'d1');
assert.equal(view.owner.instanceId,OLD);assert.equal(view.owner.series,0);assert.equal(view.owner.versionId,null);assert.equal(view.owner.liveness,'waiting');
assert.equal(view.deployedVersionId,VERSION_NEW);
assert.equal(view.continuation.hopId,'hop-77');assert.equal(view.continuation.replayAfter,'slot|2026-11-17|ch-9');assert.equal(view.continuation.stage,'paused');
assert.equal(view.lease.live,false);assert.equal(view.gates.window.state,'idle');assert.equal(view.gates.priority.paused,false);
assert.deepEqual(view.report,{chunks:3,outbox:1});
assert.doesNotMatch(JSON.stringify(reply.body),/lease_id|payload_json|SELECT|tmdbId/,'the preflight carries no body, SQL or Film id');

// 2. Unsafe and unknown states: the preflight names them, and an apply with otherwise exact pins refuses with zero writes and zero creates.
const cases=[
 ['instance_active','unsafe',()=>seed({phase:'running',waitingUntil:null})],
 ['wake_imminent','unsafe',()=>seed({waitingUntil:new Date(Date.now()+30000).toISOString()})],
 ['handoff_pending','unsafe',()=>seed({phase:'starting',waitingUntil:null})],
 ['handoff_pending','unsafe',()=>seed({phase:'uncertain',waitingUntil:null})],
 ['no_active_instance','unsafe',()=>seed({phase:'stopped',waitingUntil:null})],
 ['lease_live','unsafe',()=>{seed();set(LEASE,{id:'11111111-2222-4333-8444-555555555555',expiresAt:Date.now()+60000});}],
 ['checkpoint_unsaved','unsafe',()=>seed({stage:'running'})],
 ['continuation_foreign','unsafe',()=>{seed();const c=records.get(CONT);set(CONT,{...c,programmeRunId:OTHER});}],
 ['no_continuation','unsafe',()=>{seed();records.delete(CONT);}],
 ['projector_window','unsafe',()=>{seed();gates.window={present:true,state:'held',active:true,expiresAt:Date.now()+200000};}],
 ['projector_window','unsafe',()=>{seed();gates.window={present:true,state:'requested',active:true,expiresAt:Date.now()+200000};}],
 ['epg_priority','unsafe',()=>{seed();gates.priority={present:true,paused:true,reason:'epg_priority',nextCatchUpAt:new Date(Date.now()+60000).toISOString()};}],
 ['authority_held','unsafe',()=>{seed();authority={...authority,ready:false,held:true,cutover:'held'};}],
 ['authority_loading','unsafe',()=>{seed();authority={...authority,transfer:'loading'};}],
 ['generation_handoff','unsafe',()=>{seed();authority={...authority,publishedProgrammeRunId:OTHER};}],
 ['generation_mismatch','unsafe',()=>{seed();published=OTHER;authority={...authority,publishedProgrammeRunId:OTHER};}],
 ['recovery_exhausted','unsafe',()=>{seed();const r=records.get(STATE);set(STATE,{...r,recovery:{attempts:5,quarantined:true}});}],
 ['instance_not_alive','unsafe',()=>{seed();liveness.set(OLD,'errored');}],
 ['instance_not_alive','unsafe',()=>{seed();liveness.delete(OLD);}],
 ['instance_status_unknown','unknown',()=>{seed();liveness.set(OLD,'throw');}],
 ['owner_unknown','unknown',()=>{seed();const r=records.get(STATE);set(STATE,{...r,instanceId:'discovery_forged_0'});}],
 ['deployed_version_unknown','unknown',()=>{seed();env.CF_VERSION_METADATA=undefined;}],
 ['epg_priority_unreadable','unknown',()=>{seed();gates.priority={present:true,paused:null,reason:'unknown'};}],
 ['projector_window_unreadable','unknown',()=>{seed();gates.window={present:true,state:'unknown',active:null};}],
 ['gates_unreadable','unknown',()=>{seed();delete context.DiscoveryAuthority.readDiscoveryGates;}],
 ['d1_unavailable','unknown',()=>{seed();context.DiscoveryAuthority.readAuthority=async()=>{throw new Error('D1_ERROR');};}],
];
for(const [blocker,decision,arrange] of cases){
 arrange();
 before=snapshot();
 reply=await tool({mode:'dry_run'});
 assert.equal(reply.body.decision,decision,blocker+': '+JSON.stringify(reply.body));
 assert.ok((decision==='unknown'?reply.body.unknowns:reply.body.blockers).includes(blocker),blocker+': '+JSON.stringify(reply.body));
 reply=await tool(pins());
 assert.equal(reply.status,409,blocker);assert.equal(reply.body.ok,false,blocker);assert.equal(reply.body.writes,0,blocker);
 assert.equal(snapshot(),before,blocker+' writes nothing');assert.equal(creates.length,0,blocker+' creates nothing');
 env.CF_VERSION_METADATA={id:VERSION_NEW};
}

// 3. An owner that already recorded the deployed version is current: nothing to do, nothing written.
seed({versionId:VERSION_NEW});before=snapshot();
assert.equal((await tool({mode:'dry_run'})).body.decision,'already_current');
reply=await tool(pins());assert.equal(reply.body.reason,'already_current');assert.equal(snapshot(),before);assert.equal(creates.length,0);
// A recorded OTHER version is eligible like an unrecorded one.
seed({versionId:VERSION_OLD});assert.equal((await tool({mode:'dry_run'})).body.decision,'eligible');

// 4. Argument and confirmation gates: invalid input, a missing confirmation and every stale pin refuse with zero writes.
seed();before=snapshot();
for(const args of [{mode:'go'},{mode:'apply'},pins({requestId:'short'}),pins({requestId:'bad id with spaces'}),pins({expectedInstanceId:'other'}),pins({expectedSeries:-1}),pins({expectedSeries:'0'}),pins({confirmGo:'yes'})]){
 reply=await tool(args);assert.equal(reply.status,400,JSON.stringify(args));
}
reply=await tool(pins({confirmGo:false}));assert.equal(reply.body.reason,'confirm_required');
reply=await tool({...pins(),confirmGo:undefined});assert.equal(reply.body.reason,'confirm_required');
for(const stale of [{expectedProgrammeRunId:OTHER},{expectedInstanceId:instance(1)},{expectedSeries:1}]){
 reply=await tool(pins(stale));assert.equal(reply.body.reason,'pin_mismatch',JSON.stringify(stale));assert.equal(reply.body.writes,0);
}
assert.equal(snapshot(),before);assert.equal(creates.length,0);

// 5. The apply: one swap to the deterministic successor of the same generation, one create, the report, outbox and continuation untouched,
// and a readback that proves the new owner, its liveness and the checkpoint. The version is pending until the successor records it.
seed();
const continuationBefore=structuredClone(records.get(CONT)),continuationEtag=etags.get(CONT),statusBefore=structuredClone(records.get(STATUS));
reply=await tool(pins());
assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.ok,true);assert.equal(reply.body.outcome,'handed_over_version_pending');
assert.deepEqual(creates.map(item=>item.id),[NEXT]);assert.deepEqual(creates[0].params,{programmeRunId:GENERATION,series:1});
let state=records.get(STATE);
assert.equal(state.instanceId,NEXT);assert.equal(state.series,1);assert.equal(state.programmeRunId,GENERATION);assert.equal(state.phase,'running');
assert.equal(state.versionId,null);assert.equal(state.createdVersionId,VERSION_NEW);
assert.equal(state.report.chunks,3);assert.equal(state.report.tmdbCalls,9);assert.deepEqual(state.report.seen,[OLD+':3']);assert.equal(state.outbox.length,1);
assert.equal(state.rollover.requestId,'owner-go-0001');assert.equal(state.rollover.fromInstanceId,OLD);assert.equal(state.rollover.toInstanceId,NEXT);assert.equal(state.rollover.checkpoint.hopId,'hop-77');
// AIR-687: the useful-work clock of the same generation survives the swap to the successor (it is not reset to a fresh idle clock).
assert.equal(state.lastUsefulProgressAt,'2026-11-17T09:30:00.000Z');assert.equal(state.usefulProgressTrackedSince,'2026-11-17T08:00:00.000Z');
assert.deepEqual(records.get(CONT),continuationBefore,'the continuation is untouched');assert.equal(etags.get(CONT),continuationEtag);
assert.deepEqual(records.get(STATUS),statusBefore,'replayAfter and the status are untouched');
assert.deepEqual(reply.body.receipt.from,{instanceId:OLD,series:0,versionId:null});assert.deepEqual(reply.body.receipt.to,{instanceId:NEXT,series:1});
assert.equal(reply.body.readback.owner.isSuccessor,true);assert.equal(reply.body.readback.liveness,'running');assert.equal(reply.body.readback.checkpoint.preserved,true);assert.equal(reply.body.readback.versionConfirmed,false);
assert.ok(!puts.includes(CONT)&&!puts.includes(STATUS)&&!puts.includes('programme.json'),'no continuation, status or EPG write');

// 6. The old instance wakes after the handoff: its owner gate refuses, it writes nothing and starts no chunk or successor.
const step={async do(name,fn){return fn();},async sleepUntil(){}};
let advanced=0;const realAdvance=context.advanceDiscovery;context.advanceDiscovery=async()=>{advanced++;return realAdvance;};
const puttedBefore=puts.length;
let woke=await call('runDiscoveryWorkflow')({...env,CF_VERSION_METADATA:{id:VERSION_OLD}},{programmeRunId:GENERATION,series:0},step);
assert.equal(woke.reason,'not_owner');assert.equal(advanced,0);assert.equal(puts.length,puttedBefore,'the woken old instance writes nothing');assert.equal(creates.length,1);
// Even its own checkpoint writer refuses, and its natural rollover attaches to the named successor instead of creating another.
assert.equal((await call('settleWorkflowIfOwner')(env,OLD,{phase:'running'})).reason,'other_instance');
const natural=await call('rolloverDiscoveryWorkflow')(env,GENERATION,0);
assert.equal(natural.attached,true);assert.equal(natural.instanceId,NEXT);assert.equal(creates.length,1);

// 7. The successor's first step records the version it runs on; the preflight then reads `already_current` and the readback confirms it.
const haltingStep={async do(name,fn){if(name.startsWith('owner'))throw new Error('halt');return fn();},async sleepUntil(){}};
await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:1},haltingStep),/halt/);
assert.equal(records.get(STATE).versionId,VERSION_NEW);assert.equal(records.get(STATE).instanceId,NEXT);
assert.equal((await tool({mode:'dry_run'})).body.decision,'already_current');
// The old instance on the old version cannot record its version once it lost the record.
await assert.rejects(call('runDiscoveryWorkflow')({...env,CF_VERSION_METADATA:{id:VERSION_OLD}},{programmeRunId:GENERATION,series:0},haltingStep),/halt/);
assert.equal(records.get(STATE).versionId,VERSION_NEW);

// 8. A repeat of the same request (a timeout after the swap, a retried call) never swaps twice: it reads back and confirms the version.
const createsAfter=creates.length;state=structuredClone(records.get(STATE));
reply=await tool(pins());
assert.equal(reply.body.replay,true);assert.equal(reply.body.outcome,'handed_over');assert.equal(reply.body.readback.versionConfirmed,true);assert.equal(reply.body.writes,0);
assert.equal(creates.length,createsAfter);assert.deepEqual(records.get(STATE),state);
// The same requestId with other pins is refused; a new request with the old pins is stale.
assert.equal((await tool(pins({expectedSeries:1,expectedInstanceId:NEXT}))).body.reason,'request_id_reused');
assert.equal((await tool(pins({requestId:'owner-go-0002'}))).body.reason,'pin_mismatch');
assert.deepEqual(records.get(STATE),state);
// Still recognised after a later natural successor replaced the record (the receipt is carried).
await call('createWorkflowInstance')(env,GENERATION,2,instance(2),etags.get(STATE),null,records.get(STATE));
reply=await tool(pins());assert.equal(reply.body.outcome,'superseded');assert.equal(reply.body.ok,true);assert.equal(records.get(STATE).instanceId,instance(2));

// 9. Two operator requests at once: exactly one swap and one create; the other is refused without a write of its own.
seed();
const [first,second]=await Promise.all([tool(pins({requestId:'owner-go-race-a'})),tool(pins({requestId:'owner-go-race-b'}))]);
const winners=[first,second].filter(item=>item.body.ok===true);
assert.equal(winners.length,1,JSON.stringify([first.body,second.body]));
const loser=[first,second].find(item=>item.body.ok!==true);
assert.ok(['write_conflict','pin_mismatch','unsafe'].includes(loser.body.reason),JSON.stringify(loser.body));assert.equal(loser.body.writes,0);
assert.deepEqual(creates.map(item=>item.id),[NEXT]);assert.equal(records.get(STATE).series,1);
assert.equal(records.get(STATE).rollover.requestId,winners[0].body.receipt.requestId);

// 10. The cron reconcile right after a swap: it attaches to the same successor or finds it in progress, never a second id.
seed();
await tool(pins());
let reconciled=await call('reconcileDiscoveryWorkflow')(env,{});
assert.equal(reconciled.reason,'in_progress');assert.equal(reconciled.instanceId,NEXT);assert.deepEqual(creates.map(item=>item.id),[NEXT]);

// 11. A create that cannot be confirmed: the record names the successor `uncertain` with the existing recovery due time, the receipt says so
// (not accepted), the reconcile waits until it is due and then recreates the SAME id. Exactly one successor.
seed();
createFault=new Error('network connection lost');
reply=await tool(pins());
assert.equal(reply.status,202);assert.equal(reply.body.ok,false);assert.equal(reply.body.outcome,'successor_uncertain');
state=records.get(STATE);assert.equal(state.instanceId,NEXT);assert.equal(state.phase,'uncertain');assert.ok(Date.parse(state.recovery.dueAt)>Date.now());
reconciled=await call('reconcileDiscoveryWorkflow')(env,{});assert.equal(reconciled.reason,'recovery_waiting');assert.equal(creates.length,1);
set(STATE,{...records.get(STATE),recovery:{...records.get(STATE).recovery,dueAt:new Date(Date.now()-1000).toISOString()}});
reconciled=await call('reconcileDiscoveryWorkflow')(env,{});
assert.equal(reconciled.started,true,JSON.stringify(reconciled));assert.equal(reconciled.instanceId,NEXT);
assert.deepEqual(creates.map(item=>item.id),[NEXT,NEXT]);assert.equal(records.get(STATE).phase,'running');
// The repeat of that request now reads back an accepted handoff without a third create.
reply=await tool(pins());assert.equal(reply.body.replay,true);assert.equal(reply.body.ok,true,JSON.stringify(reply.body));assert.equal(creates.length,2);

// 12. A crash between the swap and the create: the record is `starting` for the successor. The repeat of the request creates it once; the
// cron reconcile alone would do the same (an absent instance of an active record is recreated under the same id).
seed();
context.__realStart=call('startRolloverSuccessor');
call('startRolloverSuccessor=async()=>{throw new Error("worker timeout")}');
await assert.rejects(tool(pins()),/worker timeout/);
call('startRolloverSuccessor=globalThis.__realStart');
assert.equal(records.get(STATE).phase,'starting');assert.equal(records.get(STATE).instanceId,NEXT);assert.equal(creates.length,0);
reply=await tool(pins());assert.equal(reply.body.replay,true);assert.equal(reply.body.ok,true,JSON.stringify(reply.body));assert.deepEqual(creates.map(item=>item.id),[NEXT]);
seed();
call('startRolloverSuccessor=async()=>{throw new Error("worker timeout")}');
await assert.rejects(tool(pins()),/worker timeout/);
call('startRolloverSuccessor=globalThis.__realStart');
reconciled=await call('reconcileDiscoveryWorkflow')(env,{});
assert.equal(reconciled.started,true,JSON.stringify(reconciled));assert.deepEqual(creates.map(item=>item.id),[NEXT]);

// A crash after the swap, then a new generation published before the repeat: the repeat does not create a stale successor, the reconcile decides.
seed();
call('startRolloverSuccessor=async()=>{throw new Error("worker timeout")}');
await assert.rejects(tool(pins()),/worker timeout/);
call('startRolloverSuccessor=globalThis.__realStart');
published=OTHER;authority={...authority,publishedProgrammeRunId:OTHER};
reply=await tool(pins());assert.equal(reply.body.reason,'replay_stale',JSON.stringify(reply.body));assert.equal(creates.length,0);

// A preflight slow enough to eat into the wake margin is refused before the swap.
seed({waitingUntil:new Date(Date.now()+150000).toISOString()});
context.__realFacts=call('discoveryRolloverFacts');const realNow=Date.now;
call('discoveryRolloverFacts=async(env)=>{const facts=await globalThis.__realFacts(env);globalThis.__slow();return facts;}');
context.__slow=()=>{Date.now=()=>realNow()+100000;};
before=snapshot();
try{reply=await tool(pins());}finally{Date.now=realNow;call('discoveryRolloverFacts=globalThis.__realFacts');}
assert.equal(reply.body.ok,false);assert.deepEqual(reply.body.blockers,['wake_imminent']);assert.equal(snapshot(),before);assert.equal(creates.length,0);

// The version step has a fixed name outside the numbered sequence: the first owner gate is still `owner-0`.
seed();
const names=[];
await assert.rejects(call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},{async do(name,fn){names.push(name);if(name.startsWith('owner'))throw new Error('halt');return fn();},async sleepUntil(){}}),/halt/);
assert.deepEqual(names,['version','owner-0']);

// AIR-524 review P1: a publication between the preflight and the swap. The executor record and its revision are untouched, so the revision CAS alone
// would pass; the generation pin inside the same write refuses it. No swap, no create, report and continuation unchanged.
for(const move of [
 ()=>{published=OTHER;authority={...authority,programmeRunId:OTHER,publishedProgrammeRunId:OTHER};},
 ()=>{published=OTHER;},
 ()=>{authority={...authority,publishedProgrammeRunId:OTHER};},
]){
 seed();
 const recordBefore=snapshot(),stateEtag=etags.get(STATE);
 call('discoveryRolloverFacts=async(env)=>{const facts=await globalThis.__realFacts(env);globalThis.__publish();return facts;}');
 context.__publish=move;
 try{reply=await tool(pins());}finally{call('discoveryRolloverFacts=globalThis.__realFacts');}
 assert.equal(reply.body.ok,false);assert.equal(reply.body.reason,'stale_generation',JSON.stringify(reply.body));assert.equal(reply.body.writes,0);
 assert.equal(snapshot(),recordBefore,'no ownership swap, report or continuation change');assert.equal(etags.get(STATE),stateEtag);assert.equal(creates.length,0);
 // After that publication the ordinary reconcile resolves to the current generation: a new series-0 instance of the new run, never the old run's successor.
 published=OTHER;authority={...authority,programmeRunId:OTHER,publishedProgrammeRunId:OTHER};
 reconciled=await call('reconcileDiscoveryWorkflow')(env,{});
 assert.ok(!creates.some(item=>item.id===NEXT),'no successor of the old run');
 assert.deepEqual(creates.map(item=>item.id),[instance(0,OTHER)],JSON.stringify(reconciled));assert.equal(records.get(STATE).programmeRunId,OTHER);
}
// The swap never falls back to the R2 executor object: an authority that stops routing it refuses.
seed();before=snapshot();
context.DiscoveryAuthority.writeWorkflow=async()=>({handled:false,saved:false});
reply=await tool(pins());assert.equal(reply.body.reason,'authority_not_ready');assert.equal(snapshot(),before);assert.equal(creates.length,0);
// A Discovery programme that differs from the published pin is a handoff in progress: unsafe in the preflight.
seed();authority={...authority,programmeRunId:OTHER};
reply=await tool({mode:'dry_run'});assert.equal(reply.body.decision,'unsafe');assert.ok(reply.body.blockers.includes('generation_handoff'));

// 13. A swap whose answer is lost but which was stored is this request's own swap (an uncertain write): it proceeds to the one create.
seed();
putHook=key=>{if(key===STATE){putHook=null;return 'lost';}};
reply=await tool(pins());assert.equal(reply.body.ok,true,JSON.stringify(reply.body));assert.deepEqual(creates.map(item=>item.id),[NEXT]);

// 14. A projector window or EPG-priority pause that opens between the preflight and the swap refuses the swap inside its own statement: zero writes.
for(const fault of [Object.assign(new Error('discovery_window'),{code:'discovery_window',window:{expiresAt:Date.now()+100000,state:'held'}}),Object.assign(new Error('discovery_epg_priority'),{code:'discovery_epg_priority',priority:{nextCatchUpAt:new Date(Date.now()+60000).toISOString()}})]){
 seed();before=snapshot();writeFault=fault;
 reply=await tool(pins());assert.equal(reply.body.ok,false);assert.equal(reply.body.reason,fault.code==='discovery_window'?'projector_window':'epg_priority');
 assert.equal(reply.body.writes,0);assert.equal(snapshot(),before);assert.equal(creates.length,0);
}

// 15. Another writer that changes the record between the preflight and the swap (the old instance's own checkpoint, a reconcile) wins: the
// stale swap is refused and nothing is created.
seed();
context.__realRead=call('readWorkflowState');
call(`readWorkflowState=async(env)=>{const state=await globalThis.__realRead(env);if(++globalThis.__reads===1){const r=state.record;await env.BUCKET.put('${STATE}',JSON.stringify({...r,updatedAt:new Date().toISOString()}));}return state;}`);
context.__reads=0;
reply=await tool(pins());
call('readWorkflowState=globalThis.__realRead');
assert.equal(reply.body.reason,'write_conflict',JSON.stringify(reply.body));assert.equal(creates.length,0);assert.equal(records.get(STATE).instanceId,OLD);

// 16. The natural rollover is unchanged and carries the receipt and the report; a natural successor starts without a recorded version.
seed();
const plain=structuredClone(records.get(STATE));set(STATE,{...plain,phase:'running',rollover:{requestId:'owner-go-old',fromInstanceId:'x',toInstanceId:'y'}});
const rolled=await call('rolloverDiscoveryWorkflow')(env,GENERATION,0);
assert.equal(rolled.started,true);assert.equal(rolled.instanceId,NEXT);
state=records.get(STATE);assert.equal(state.rollover.requestId,'owner-go-old');assert.equal(state.report.chunks,3);assert.equal(state.versionId,null);assert.equal(state.createdVersionId,VERSION_NEW);

assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"version_metadata":\s*\{\s*"binding":\s*"CF_VERSION_METADATA"/);
context.advanceDiscovery=realAdvance;
console.log('Discovery Workflow rollover: zero-write preflight and unsafe/unknown refusals, pins and confirmation, one CAS swap and one create, carried report/outbox/continuation, woken old instance fenced, version readback, idempotent repeat, concurrent operators, reconcile, uncertain create and crash recovery, window/priority at the swap, natural rollover unchanged.');
