// AIR-323 / ADR 0083. Durable Discovery continuation. One bounded chunk per step.
// The binding creates nothing by itself: only DISCOVERY_EXECUTOR=workflow calls create(), and nothing in this
// file is scheduled. The executor record follows the discovery marker: D1 when it is d1, otherwise R2 (AIR-320).
const DISCOVERY_WORKFLOW_STATE_KEY='epg/discovery-workflow.json';
const DISCOVERY_WORKFLOW_CHUNK_LIMIT=20;
const DISCOVERY_WORKFLOW_STALL_LIMIT=3;
const DISCOVERY_WORKFLOW_WRITE_LIMIT=3;
const DISCOVERY_WORKFLOW_STEP_CAP=160;
const DISCOVERY_WORKFLOW_RECOVERY_LIMIT=4;
const DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS=[60000,300000,900000,3600000];
const DISCOVERY_WORKFLOW_FRESH_MS=15*60*1000;
const DISCOVERY_WORKFLOW_TERMINAL=new Set(['complete','backlog_empty','stale_generation','executor_not_workflow','recovery_exhausted']);
const DISCOVERY_WORKFLOW_RECOVERABLE=new Set(['no_progress','write_uncertain','step_cap','rollover_uncertain','no_continuation']);
function discoveryWorkflowChunkLimit(){return DISCOVERY_WORKFLOW_CHUNK_LIMIT;}
function discoveryInstanceId(programmeRunId,series){
 const compact=String(programmeRunId||'').replace(/[^0-9A-Za-z]/g,'').slice(0,32)||'none';
 const n=Number.isInteger(series)&&series>=0?series:0;
 return `discovery_${compact}_${n}`;
}
function workflowCreateError(error){
 const text=String(error?.name||'')+' '+String(error?.message||'');
 return /already exists|already_exists|duplicate/i.test(text)?'exists':'uncertain';
}
async function readWorkflowState(env){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.readWorkflow(env);if(routed.handled)return {record:routed.record,etag:routed.etag};}
 const object=await env.BUCKET.get(DISCOVERY_WORKFLOW_STATE_KEY);
 return {record:object?await object.json():null,etag:object?(object.etag||undefined):null};
}
async function writeWorkflowState(env,record,etag){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.writeWorkflow(env,record,etag);if(routed.handled)return routed.saved===true;}
 const saved=await env.BUCKET.put(DISCOVERY_WORKFLOW_STATE_KEY,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},...(etag===undefined?{}:{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});
 return saved!==null;
}
function publishedProgrammeRunId(generation){return generation?.phase==='published'?generation.programmeRunId||null:null;}
function workflowFailure(previous,reason,now){
 const attempts=(previous?.attempts||0)+1;
 const at=new Date(now).toISOString();
 if(attempts>DISCOVERY_WORKFLOW_RECOVERY_LIMIT)return {attempts,reason:'recovery_exhausted',at,dueAt:null,quarantined:true};
 const delay=DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS[Math.min(attempts,DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS.length)-1];
 return {attempts,reason,at,dueAt:new Date(now+delay).toISOString(),quarantined:false};
}
function runningRecovery(recovery){
 if(!recovery||recovery.quarantined)return null;
 return {attempts:recovery.attempts||0,reason:recovery.reason||null,at:recovery.at||null,dueAt:null,quarantined:false};
}
function workflowRecoveryGate(record,now){
 if(record?.recovery?.quarantined||record?.reason==='recovery_exhausted')return {action:'exhausted'};
 if(record?.phase==='stopped'&&DISCOVERY_WORKFLOW_TERMINAL.has(record.reason))return {action:'stopped'};
 if(record?.phase!=='stopped')return {action:'active'};
 const due=Date.parse(record.recovery?.dueAt||'');
 if(!Number.isFinite(due))return {action:'arm'};
 if(due>now)return {action:'waiting',dueAt:record.recovery.dueAt};
 return {action:'successor'};
}
async function workflowOwnerGate(env,ownId,series){
 const record=(await readWorkflowState(env)).record;
 if(record?.instanceId===ownId&&record.series===series)return {owned:true};
 return {owned:false,reason:'not_owner'};
}
function workflowReadoutFacts(stored,liveness,now){
 const updated=Date.parse(stored?.updatedAt||'');
 const waiting=Date.parse(stored?.waitingUntil||'');
 const active=!!stored&&['starting','running','waiting','uncertain'].includes(stored.phase);
 const sleeping=stored?.phase==='waiting'&&Number.isFinite(waiting)&&waiting>now;
 const stalled=active&&!sleeping&&(!Number.isFinite(updated)||now-updated>DISCOVERY_WORKFLOW_FRESH_MS);
 const alive=liveness==='running'||liveness==='waiting'||liveness==='queued'||liveness==='paused';
 const dead=liveness==='complete'||liveness==='errored'||liveness==='terminated'||liveness==='absent';
 const recoveryDue=stored?.recovery?.dueAt||null;
 const recoveryDueMs=Date.parse(recoveryDue||'');
 return {active,stalled,alive,dead,recoveryDue,recoveryWaiting:Number.isFinite(recoveryDueMs)&&recoveryDueMs>now,quarantined:stored?.recovery?.quarantined===true||stored?.reason==='recovery_exhausted',updatedAt:stored?.updatedAt||null};
}
// Pure. The external hourly contract stays in continuationDecision; a future chunk_budget is renewed here only
// when the saved status proves this generation still has work.
function workflowPlan(input){
 const {mode,published,pinned,record,lease,now,chunks,chunkLimit,last,uncertainWrites}=input||{};
 if(mode!=='workflow')return {action:'stop',reason:'executor_not_workflow'};
 if((uncertainWrites||0)>=DISCOVERY_WORKFLOW_WRITE_LIMIT)return {action:'stop',reason:'write_uncertain'};
 if(!pinned||!published||pinned!==published||(record&&record.programmeRunId!==pinned))return {action:'stop',reason:'stale_generation'};
 if(!record)return {action:'stop',reason:'no_continuation'};
 if(lease?.expiresAt>now)return {action:'wait',until:lease.expiresAt,reason:'busy'};
 const due=Date.parse(record.retryAt||record.nextCatchUpAt||0);
 const known=last&&last.programmeRunId===pinned&&Number.isInteger(last.remaining)?last.remaining:null;
 if(record.reason==='chunk_budget'&&due>now){
  if(known>0)return (chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT)?{action:'rollover',reason:'instance_limit'}:{action:'renew',reason:'chunk_budget'};
  if(known===0)return {action:'stop',reason:'backlog_empty'};
  return {action:'wait',until:due,reason:'unknown_remaining'};
 }
 const decision=continuationDecision(record,now);
 if(!decision.run){
  const waiting=decision.contract.nextAction==='wait';
  const until=Date.parse(decision.contract.retryAt||decision.contract.nextCatchUpAt||0);
  return {action:waiting?'wait':'stop',until:Number.isFinite(until)?until:now,reason:decision.contract.reason||decision.contract.state||'stop'};
 }
 if((chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT))return {action:'rollover',reason:'instance_limit'};
 return {action:'continue',reason:null};
}
async function workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites){
 const generation=await loadJSON(env,EPG_GENERATION_KEY);
 const published=publishedProgrammeRunId(generation);
 const stored=await readContinuation(env);
 const lease=await loadJSON(env,'epg/resolver-lease.json');
 const last=await loadJSON(env,'epg/discovery-status.json');
 return {mode:discoveryExecutorMode(env),published,pinned,record:stored.record,lease,now:Date.now(),chunks,chunkLimit,last,uncertainWrites};
}
async function settleWorkflowIfOwner(env,ownId,patch){
 let state=await readWorkflowState(env);
 if(state.record?.instanceId&&state.record.instanceId!==ownId)return {saved:false,reason:'other_instance',record:state.record};
 const next={schemaVersion:1,...(state.record||{}),...patch,instanceId:ownId,updatedAt:new Date().toISOString()};
 if(await writeWorkflowState(env,next,state.etag))return {saved:true,reason:null,record:next};
 state=await readWorkflowState(env);
 if(state.record?.instanceId&&state.record.instanceId!==ownId)return {saved:false,reason:'other_instance',record:state.record};
 return {saved:false,reason:'write_conflict',record:state.record};
}
async function renewDiscoverySeries(env,pinned){
 const stored=await readContinuation(env),current=stored.record;
 if(!current||current.programmeRunId!==pinned)return {renewed:false,reason:'stale_generation'};
 if(current.reason!=='chunk_budget')return current.stage==='paused'&&current.remainingChunks>0?{renewed:true,reason:'already'}:{renewed:false,reason:'not_budget'};
 const last=await loadJSON(env,'epg/discovery-status.json');
 const known=last&&last.programmeRunId===pinned&&Number.isInteger(last.remaining)?last.remaining:null;
 if(!(known>0))return {renewed:false,reason:known===0?'backlog_empty':'unknown_remaining'};
 const record={...current,stage:'paused',reason:null,remainingChunks:discoveryChunkBudget(),nextCatchUpAt:null,retryAt:null,at:new Date().toISOString()};
 if(await replaceContinuation(env,record,stored.etag))return {renewed:true,reason:'renewed'};
 const after=await readContinuation(env);
 if(after.record?.programmeRunId===pinned&&after.record.reason!=='chunk_budget'&&after.record.remainingChunks>0)return {renewed:true,reason:'already'};
 return {renewed:false,reason:'write_uncertain',uncertain:true};
}
// A thrown step is retried by the platform, so this must not throw after a chunk may have committed.
async function runWorkflowChunk(env){
 const before=await readContinuation(env);
 try{
  const outcome=await advanceDiscovery(env,{caller:'internal'});
  const saved=outcome?.diagnostic?.saved?.owned===true;
  const busy=outcome?.stage==='busy'||outcome?.discovery?.reason==='busy';
  return {threw:false,progress:saved,busy,until:outcome?.discovery?.nextCatchUpAt||null,summary:chunkSummary(outcome),saved};
 }catch(e){
  let after=null;
  try{after=await readContinuation(env);}catch{}
  // An unsaved checkpoint stays `running` or keeps the etag we read. Another writer's commit is not this step's progress.
  const saved=!!(after&&after.etag!==before.etag&&after.record?.hopId&&after.record.hopId!==before.record?.hopId&&after.record.stage!=='running');
  return {threw:true,progress:saved,busy:false,error:diagnosticErrorCode(e),saved};
 }
}
async function workflowInstanceStatus(binding,id){
 if(!binding||typeof binding.get!=='function')return 'unknown';
 try{
  const instance=await binding.get(id);
  const status=typeof instance?.status==='function'?await instance.status():instance?.status;
  const name=typeof status==='string'?status:status?.status;
  return typeof name==='string'?name:'unknown';
 }catch(e){
  return /not found|does not exist|unknown instance/i.test(String(e?.message||''))?'absent':'unknown';
 }
}
async function createWorkflowInstance(env,programmeRunId,series,instanceId,etag,recovery,previous){
 const binding=env.DISCOVERY_WORKFLOW;
 const same=previous?.instanceId===instanceId;
 const next={schemaVersion:1,...(same?previous:{}),programmeRunId,series,instanceId,phase:'starting',updatedAt:new Date().toISOString(),waitingUntil:null,reason:null,chunksThisInstance:same?previous.chunksThisInstance||0:0,lastProgress:same?previous.lastProgress||null:null,recovery:recovery||null};
 let wrote=await writeWorkflowState(env,next,etag);
 if(!wrote){
  const state=await readWorkflowState(env);
  if(!(state.record?.programmeRunId===programmeRunId&&state.record.instanceId===instanceId))return {started:false,reason:'write_conflict',programmeRunId,instanceId:state.record?.instanceId||instanceId,series:state.record?.series??series};
 }
 try{
  await binding.create({id:instanceId,params:{programmeRunId,series}});
  await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'started',programmeRunId,series,recovery:runningRecovery(recovery),waitingUntil:null});
  return {started:true,attached:false,reason:'started',programmeRunId,instanceId,series};
 }catch(error){
  if(workflowCreateError(error)==='exists'){
   await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'attached',programmeRunId,series,recovery:runningRecovery(recovery),waitingUntil:null});
   return {started:true,attached:true,reason:'attached',programmeRunId,instanceId,series};
  }
  const failure=workflowFailure(recovery,'start_uncertain',Date.now());
  await settleWorkflowIfOwner(env,instanceId,{phase:failure.quarantined?'stopped':'uncertain',reason:failure.quarantined?'recovery_exhausted':'start_uncertain',programmeRunId,series,recovery:failure,waitingUntil:failure.dueAt});
  return {started:false,uncertain:!failure.quarantined,reason:failure.quarantined?'recovery_exhausted':'start_uncertain',programmeRunId,instanceId,series,dueAt:failure.dueAt};
 }
}
async function ensureDiscoveryWorkflow(env){
 const mode=discoveryExecutorMode(env);
 if(mode==='external')return {started:false,reason:'external'};
 if(mode!=='workflow')return {started:false,reason:'invalid'};
 if(typeof env?.DISCOVERY_WORKFLOW?.create!=='function')return {started:false,reason:'workflow_unavailable'};
 const programmeRunId=publishedProgrammeRunId(await loadJSON(env,EPG_GENERATION_KEY));
 if(!programmeRunId)return {started:false,reason:'generation_unpublished'};
 const continuation=(await readContinuation(env)).record;
 if(continuation?.programmeRunId&&continuation.programmeRunId!==programmeRunId)return {started:false,reason:'stale_generation',programmeRunId};
 if(continuation&&discoveryContract(continuation).nextAction==='stop')return {started:false,reason:'stopped',programmeRunId};
 const state=await readWorkflowState(env),current=state.record;
 const same=current?.programmeRunId===programmeRunId;
 if(same&&current.instanceId&&['starting','running','waiting'].includes(current.phase))return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
 if(same&&current.instanceId&&current.phase==='uncertain'){
  const due=Date.parse(current.recovery?.dueAt||'');
  if(current.recovery?.quarantined)return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
  if(Number.isFinite(due)&&due>Date.now())return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:current.recovery.dueAt};
  return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
 }
 if(same&&current?.phase==='stopped'){
  const gate=workflowRecoveryGate(current,Date.now());
  if(gate.action==='exhausted')return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
  if(gate.action==='stopped')return {started:false,reason:'stopped',programmeRunId,instanceId:current.instanceId,series:current.series??0};
  if(gate.action==='waiting')return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:gate.dueAt};
  if(gate.action==='arm'){
   const failure=workflowFailure(current.recovery,current.reason||'stopped',Date.now());
   const next={...current,reason:failure.quarantined?'recovery_exhausted':current.reason,recovery:failure,updatedAt:new Date().toISOString(),waitingUntil:failure.dueAt};
   if(!await writeWorkflowState(env,next,state.etag))return {started:false,reason:'write_conflict',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   return {started:false,reason:failure.quarantined?'recovery_exhausted':'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:failure.dueAt};
  }
  const series=(current.series||0)+1;
  return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,current.recovery||null,current);
 }
 const series=0;
 return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,null);
}
async function reconcileDiscoveryWorkflow(env){
 const mode=discoveryExecutorMode(env);
 if(mode!=='workflow')return {started:false,reason:mode==='invalid'?'invalid':'external'};
 const binding=env?.DISCOVERY_WORKFLOW;
 if(typeof binding?.create!=='function')return {started:false,reason:'workflow_unavailable'};
 const programmeRunId=publishedProgrammeRunId(await loadJSON(env,EPG_GENERATION_KEY));
 if(!programmeRunId)return {started:false,reason:'generation_unpublished'};
 const continuation=(await readContinuation(env)).record;
 if(!continuation||continuation.programmeRunId!==programmeRunId)return {started:false,reason:'stale_generation',programmeRunId};
 if(discoveryContract(continuation).nextAction==='stop')return {started:false,reason:'stopped',programmeRunId};
 const state=await readWorkflowState(env),current=state.record;
 const same=current?.programmeRunId===programmeRunId&&current.instanceId;
 const active=same&&['starting','running','waiting','uncertain'].includes(current.phase);
 if(active){
  const status=await workflowInstanceStatus(binding,current.instanceId);
  if(status==='complete'||status==='errored'||status==='terminated'){
   const failure=workflowFailure(current.recovery,'instance_'+status,Date.now());
   const next={...current,phase:'stopped',reason:failure.quarantined?'recovery_exhausted':failure.reason,recovery:failure,updatedAt:new Date().toISOString(),waitingUntil:failure.dueAt};
   if(!await writeWorkflowState(env,next,state.etag))return {started:false,reason:'write_conflict',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   return {started:false,reason:failure.quarantined?'recovery_exhausted':'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:failure.dueAt};
  }
  if(current.phase==='uncertain'||status==='absent'){
   const due=Date.parse(current.recovery?.dueAt||'');
   if(current.recovery?.quarantined)return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   if(Number.isFinite(due)&&due>Date.now())return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:current.recovery.dueAt};
   return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
  }
  return {started:false,reason:'in_progress',programmeRunId,instanceId:current.instanceId,series:current.series??0};
 }
 return ensureDiscoveryWorkflow(env);
}
async function rolloverDiscoveryWorkflow(env,pinned,ownSeries){
 const state=await readWorkflowState(env);
 if(state.record?.programmeRunId&&state.record.programmeRunId!==pinned)return {started:false,reason:'stale_generation'};
 if(state.record?.instanceId&&state.record.instanceId!==discoveryInstanceId(pinned,ownSeries))return {started:true,attached:true,reason:'attached',programmeRunId:pinned,instanceId:state.record.instanceId,series:state.record.series};
 const series=(ownSeries||0)+1,instanceId=discoveryInstanceId(pinned,series);
 return createWorkflowInstance(env,pinned,series,instanceId,state.etag,null,state.record);
}
async function stopOwnedWorkflow(env,ownId,reason,pinned,series,chunks){
 const state=await readWorkflowState(env);
 const owned=state.record?.instanceId===ownId&&state.record.series===series;
 let recovery=null,finalReason=reason;
 if(owned&&DISCOVERY_WORKFLOW_RECOVERABLE.has(reason)){
  recovery=workflowFailure(state.record.recovery,reason,Date.now());
  if(recovery.quarantined)finalReason='recovery_exhausted';
 }
 await settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:finalReason,programmeRunId:pinned,series,chunksThisInstance:chunks,waitingUntil:recovery?.dueAt||null,recovery});
 return {stopped:true,reason:finalReason,chunks,instanceId:ownId};
}
async function runDiscoveryWorkflow(env,payload,step){
 const pinned=payload?.programmeRunId||null;
 const series=Number.isInteger(payload?.series)&&payload.series>=0?payload.series:0;
 const ownId=discoveryInstanceId(pinned,series);
 const requested=payload?.chunkLimit;
 const chunkLimit=Number.isInteger(requested)&&requested>=1&&requested<=DISCOVERY_WORKFLOW_CHUNK_LIMIT?requested:DISCOVERY_WORKFLOW_CHUNK_LIMIT;
 let chunks=0,stalls=0,uncertainWrites=0,steps=0;
 const stepName=prefix=>prefix+'-'+(steps++);
 for(;;){
  const gate=await step.do(stepName('owner'),()=>workflowOwnerGate(env,ownId,series));
  if(!gate.owned)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
  if(steps>=DISCOVERY_WORKFLOW_STEP_CAP){
   return step.do(stepName('cap'),()=>stopOwnedWorkflow(env,ownId,'step_cap',pinned,series,chunks));
  }
  const plan=await step.do(stepName('plan'),async()=>workflowPlan(await workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites)));
  if(plan.action==='stop')return step.do(stepName('stop'),()=>stopOwnedWorkflow(env,ownId,plan.reason,pinned,series,chunks));
  if(plan.action==='wait'){
   const until=Number.isFinite(plan.until)?plan.until:Date.now()+1000;
   await step.do(stepName('wait'),()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:plan.reason,waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
   await step.sleepUntil(stepName('sleep'),new Date(until));
   continue;
  }
  if(plan.action==='renew'){
   const renewed=await step.do(stepName('renew'),async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {renewed:false,reason:'not_owner'};return renewDiscoverySeries(env,pinned);});
   if(renewed.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
   if(renewed.renewed){uncertainWrites=0;continue;}
   if(renewed.reason==='unknown_remaining'||renewed.reason==='backlog_empty'||renewed.reason==='stale_generation')continue;
   uncertainWrites++;
   await step.sleepUntil(stepName('renew-sleep'),new Date(Date.now()+1000));
   continue;
  }
  if(plan.action==='rollover'){
   const rolled=await step.do(stepName('rollover'),async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {started:false,reason:'not_owner'};return rolloverDiscoveryWorkflow(env,pinned,series);});
   if(rolled.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
   if(!rolled.started)await step.do(stepName('rollover-stop'),()=>stopOwnedWorkflow(env,ownId,'rollover_uncertain',pinned,series,chunks));
   return {stopped:true,reason:rolled.started?'rollover':'rollover_uncertain',chunks,instanceId:ownId,successor:rolled};
  }
  const outcome=await step.do(stepName('chunk'),async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {notOwner:true,progress:false,busy:false};return runWorkflowChunk(env);});
  if(outcome.notOwner)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
  if(outcome.busy){
   const until=Date.parse(outcome.until||'')||Date.now()+1000;
   await step.do(stepName('busy'),()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:'busy',waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
   await step.sleepUntil(stepName('busy-sleep'),new Date(until));
   continue;
  }
  if(!outcome.progress){
   stalls++;
   if(stalls>=DISCOVERY_WORKFLOW_STALL_LIMIT)return step.do(stepName('stall'),()=>stopOwnedWorkflow(env,ownId,'no_progress',pinned,series,chunks));
   await step.sleepUntil(stepName('stall-sleep'),new Date(Date.now()+1000));
   continue;
  }
  stalls=0;uncertainWrites=0;chunks++;
  await step.do(stepName('progress'),()=>settleWorkflowIfOwner(env,ownId,{phase:'running',reason:null,programmeRunId:pinned,series,chunksThisInstance:chunks,lastProgress:outcome.summary||null,waitingUntil:null,recovery:null}));
 }
}
