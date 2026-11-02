// AIR-323 / ADR 0082. Durable Discovery continuation. One bounded chunk per step.
// The binding creates nothing by itself: only DISCOVERY_EXECUTOR=workflow calls create(), and nothing in this
// file is scheduled. R2 holds the executor record for now; that key is not a permanent authority (AIR-320).
const DISCOVERY_WORKFLOW_STATE_KEY='epg/discovery-workflow.json';
const DISCOVERY_WORKFLOW_CHUNK_LIMIT=20;
const DISCOVERY_WORKFLOW_STALL_LIMIT=3;
const DISCOVERY_WORKFLOW_WRITE_LIMIT=3;
const DISCOVERY_WORKFLOW_STEP_CAP=160;
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
 const object=await env.BUCKET.get(DISCOVERY_WORKFLOW_STATE_KEY);
 return {record:object?await object.json():null,etag:object?(object.etag||undefined):null};
}
async function writeWorkflowState(env,record,etag){
 const saved=await env.BUCKET.put(DISCOVERY_WORKFLOW_STATE_KEY,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},...(etag===undefined?{}:{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});
 return saved!==null;
}
function publishedProgrammeRunId(generation){return generation?.phase==='published'?generation.programmeRunId||null:null;}
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
  await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'started',programmeRunId,series,recovery});
  return {started:true,attached:false,reason:'started',programmeRunId,instanceId,series};
 }catch(error){
  if(workflowCreateError(error)==='exists'){
   await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'attached',programmeRunId,series,recovery});
   return {started:true,attached:true,reason:'attached',programmeRunId,instanceId,series};
  }
  const attempts=(recovery?.attempts||0)+1;
  await settleWorkflowIfOwner(env,instanceId,{phase:'uncertain',reason:'start_uncertain',programmeRunId,series,recovery:{attempts,reason:'start_uncertain',at:new Date().toISOString()}});
  return {started:false,uncertain:true,reason:'start_uncertain',programmeRunId,instanceId,series};
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
 if(same&&current.instanceId&&['starting','running','waiting','uncertain'].includes(current.phase))return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
 if(same&&current.phase==='stopped'&&!['complete','backlog_empty','stale_generation'].includes(current.reason)){
  const series=(current.series||0)+1;
  return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,{attempts:(current.recovery?.attempts||0)+1,reason:'successor',at:new Date().toISOString()},current);
 }
 if(same&&current?.phase==='stopped')return {started:false,reason:'stopped',programmeRunId,instanceId:current.instanceId,series:current.series??0};
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
   const series=(current.series||0)+1;
   return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,{attempts:(current.recovery?.attempts||0)+1,reason:'successor',at:new Date().toISOString()},current);
  }
  return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,{attempts:(current.recovery?.attempts||0)+1,reason:current.reason||'retry',at:new Date().toISOString()},current);
 }
 return ensureDiscoveryWorkflow(env);
}
async function rolloverDiscoveryWorkflow(env,pinned,ownSeries){
 const state=await readWorkflowState(env);
 if(state.record?.programmeRunId&&state.record.programmeRunId!==pinned)return {started:false,reason:'stale_generation'};
 if(state.record?.instanceId&&state.record.instanceId!==discoveryInstanceId(pinned,ownSeries))return {started:true,attached:true,reason:'attached',programmeRunId:pinned,instanceId:state.record.instanceId,series:state.record.series};
 const series=(ownSeries||0)+1,instanceId=discoveryInstanceId(pinned,series);
 return createWorkflowInstance(env,pinned,series,instanceId,state.etag,{attempts:(state.record?.recovery?.attempts||0)+1,reason:'rollover',at:new Date().toISOString()},state.record);
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
  if(steps>=DISCOVERY_WORKFLOW_STEP_CAP){
   await step.do(stepName('cap'),()=>settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:'step_cap',programmeRunId:pinned,series,chunksThisInstance:chunks}));
   return {stopped:true,reason:'step_cap',chunks,instanceId:ownId};
  }
  const plan=await step.do(stepName('plan'),async()=>workflowPlan(await workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites)));
  if(plan.action==='stop'){
   await step.do(stepName('stop'),()=>settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:plan.reason,programmeRunId:pinned,series,chunksThisInstance:chunks,waitingUntil:null}));
   return {stopped:true,reason:plan.reason,chunks,instanceId:ownId};
  }
  if(plan.action==='wait'){
   const until=Number.isFinite(plan.until)?plan.until:Date.now()+1000;
   await step.do(stepName('wait'),()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:plan.reason,waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
   await step.sleepUntil(stepName('sleep'),new Date(until));
   continue;
  }
  if(plan.action==='renew'){
   const renewed=await step.do(stepName('renew'),()=>renewDiscoverySeries(env,pinned));
   if(renewed.renewed){uncertainWrites=0;continue;}
   if(renewed.reason==='unknown_remaining'||renewed.reason==='backlog_empty'||renewed.reason==='stale_generation')continue;
   uncertainWrites++;
   await step.sleepUntil(stepName('renew-sleep'),new Date(Date.now()+1000));
   continue;
  }
  if(plan.action==='rollover'){
   const rolled=await step.do(stepName('rollover'),()=>rolloverDiscoveryWorkflow(env,pinned,series));
   if(!rolled.started)await step.do(stepName('rollover-stop'),()=>settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:'rollover_uncertain',programmeRunId:pinned,series,chunksThisInstance:chunks}));
   return {stopped:true,reason:rolled.started?'rollover':'rollover_uncertain',chunks,instanceId:ownId,successor:rolled};
  }
  const outcome=await step.do(stepName('chunk'),()=>runWorkflowChunk(env));
  if(outcome.busy){
   const until=Date.parse(outcome.until||'')||Date.now()+1000;
   await step.do(stepName('busy'),()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:'busy',waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
   await step.sleepUntil(stepName('busy-sleep'),new Date(until));
   continue;
  }
  if(!outcome.progress){
   stalls++;
   if(stalls>=DISCOVERY_WORKFLOW_STALL_LIMIT){
    await step.do(stepName('stall'),()=>settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:'no_progress',programmeRunId:pinned,series,chunksThisInstance:chunks}));
    return {stopped:true,reason:'no_progress',chunks,instanceId:ownId};
   }
   await step.sleepUntil(stepName('stall-sleep'),new Date(Date.now()+1000));
   continue;
  }
  stalls=0;uncertainWrites=0;chunks++;
  await step.do(stepName('progress'),()=>settleWorkflowIfOwner(env,ownId,{phase:'running',reason:null,programmeRunId:pinned,series,chunksThisInstance:chunks,lastProgress:outcome.summary||null,waitingUntil:null}));
 }
}
