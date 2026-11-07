// AIR-323 / ADR 0083, AIR-324 / ADR 0093. Durable Discovery continuation. One bounded chunk per step.
// Only DISCOVERY_EXECUTOR=workflow calls create(). The existing Worker cron may call reconcileDiscoveryWorkflow;
// that path is a no-op while the mode is external. No workflows[].schedules. The executor record follows the
// discovery marker: D1 when it is d1, otherwise R2 (AIR-320).
const DISCOVERY_WORKFLOW_STATE_KEY='epg/discovery-workflow.json';
const DISCOVERY_WORKFLOW_CHUNK_LIMIT=20;
const DISCOVERY_WORKFLOW_STALL_LIMIT=3;
const DISCOVERY_WORKFLOW_WRITE_LIMIT=3;
const DISCOVERY_WORKFLOW_STEP_CAP=160;
// AIR-360. A Workflow instance runs its steps inside one Worker invocation, and every D1 statement it issues is
// counted against that invocation. On 6 November 2026 both instances failed after 19 chunks with D1 statement
// totals of 12,287 and 12,192 (D1 analytics), whatever their duration or rows read: each next step then failed
// in about 10 ms with `discovery_unavailable` and no query reached D1. The instance hands over to a successor
// (a new invocation) well before that total. The exact platform limit is not established; see ADR 0094.
const DISCOVERY_WORKFLOW_INVOCATION_BUDGET=6000;
const DISCOVERY_WORKFLOW_RECOVERY_LIMIT=4;
const DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS=[60000,300000,900000,3600000];
const DISCOVERY_WORKFLOW_FRESH_MS=15*60*1000;
const DISCOVERY_WORKFLOW_TERMINAL=new Set(['complete','backlog_empty','stale_generation','executor_not_workflow','recovery_exhausted']);
const DISCOVERY_WORKFLOW_RECOVERABLE=new Set(['no_progress','write_uncertain','step_cap','rollover_uncertain','no_continuation','step_failure']);
function discoveryWorkflowChunkLimit(){return DISCOVERY_WORKFLOW_CHUNK_LIMIT;}
// Counts the statements prepared through env.DB. Statements and batches are passed through untouched, because a
// native D1 batch only accepts native prepared statements.
function meterD1(db,meter){
 if(!db||typeof db.prepare!=='function')return db;
 return new Proxy(db,{get(target,prop){
  if(prop==='prepare')return sql=>{meter.statements++;return target.prepare(sql);};
  if(prop==='batch')return statements=>{meter.batches++;return target.batch(statements);};
  if(prop==='exec')return (...args)=>{meter.statements++;return target.exec(...args);};
  if(prop==='withSession')return (...args)=>meterD1(target.withSession(...args),meter);
  const value=Reflect.get(target,prop,target);
  return typeof value==='function'?value.bind(target):value;
 }});
}
function meteredEnv(env,meter){
 if(!env||!env.DB||typeof env.DB.prepare!=='function')return env;
 const db=meterD1(env.DB,meter);
 return new Proxy(env,{get(target,prop){return prop==='DB'?db:Reflect.get(target,prop,target);}});
}
// A step failure is logged as classes from fixed lists, never as the text of the exception: the text of a D1,
// R2 or fetch error can carry SQL, identifiers, query strings or credentials of any length and shape.
const WORKFLOW_FAILURE_CODES=new Set(['discovery_unavailable','discovery_fence','discovery_lease','discovery_conflict','discovery_bounded','discovery_not_authoritative','discovery_incomplete']);
const WORKFLOW_FAILURE_NAMES=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','TimeoutError','AbortError','BudgetExhaustedError','D1Error','DOMException']);
const WORKFLOW_FAILURE_CLASSES=[['network_connection_lost',/network connection lost/i],['timeout',/time(d)? ?out/i],['limit_exceeded',/too many|subrequest|exceed|limit/i],['overloaded',/overload|too busy|temporar/i],['d1_reset',/reset|restart|code was updated/i],['sql_error',/no such (table|column)|syntax error|constraint/i],['memory',/memory/i],['d1_error',/d1_|d1 |database/i]];
function workflowFailureClass(error){
 let text='';try{text=String(typeof error==='string'?error:error?.message??'');}catch{}
 if(WORKFLOW_FAILURE_CODES.has(text))return 'code';
 for(const [name,pattern] of WORKFLOW_FAILURE_CLASSES)if(pattern.test(text))return name;
 return text?'unclassified':'none';
}
function workflowFailureName(error){let name='';try{name=typeof error==='object'&&error?String(error.name??''):'';}catch{}return WORKFLOW_FAILURE_NAMES.has(name)?name:(name?'other':'none');}
function workflowFailureCode(error){let code='';try{code=error&&typeof error==='object'?String(error.code??''):'';}catch{}return WORKFLOW_FAILURE_CODES.has(code)?code:(code?'other':null);}
// AIR-364 (ADR 0097). A step that fails after the platform's own retries may be handled by the instance itself, but only
// when the failure is positively recognised as transient infrastructure: the `discovery_unavailable` code, or a transient
// class of the error or of its cause. Hard authority and fence codes, an unclassified or empty error and a non-error are
// never recovered here; they end the instance as before and the hourly reconcile decides.
const WORKFLOW_TRANSIENT_CLASSES=new Set(['network_connection_lost','timeout','limit_exceeded','overloaded','d1_reset']);
const WORKFLOW_HARD_CODES=new Set(['discovery_fence','discovery_incomplete','discovery_not_authoritative','discovery_conflict','discovery_lease','discovery_bounded']);
function workflowStepRecoverable(error,hint){
 const probe=value=>{
  if(!value||typeof value!=='object')return null;
  const code=workflowFailureCode(value);
  if(code&&WORKFLOW_HARD_CODES.has(code))return false;
  if(code==='discovery_unavailable')return true;
  return WORKFLOW_TRANSIENT_CLASSES.has(workflowFailureClass(value))?true:null;
 };
 try{
  const own=probe(error),cause=probe(error?.cause);
  if(own===false||cause===false)return false;
  if(own===true||cause===true)return true;
  return hint===true;
 }catch{return false;}
}
// One secret-free record of why a step failed. The platform keeps only the wrapper message of the last attempt.
function logWorkflowFailure(step,error,meter,total){
 try{console.error(JSON.stringify({event:'discovery_workflow_step_failed',step:String(step).replace(/[^a-z-]/g,'').slice(0,24),code:workflowFailureCode(error),name:workflowFailureName(error),class:workflowFailureClass(error),causeName:workflowFailureName(error?.cause),causeClass:workflowFailureClass(error?.cause),statements:meter?.statements??null,batches:meter?.batches??null,instanceStatements:Number.isFinite(total)?total:null}));}catch{}
}
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
 const {mode,published,pinned,record,lease,now,chunks,chunkLimit,last,uncertainWrites,used}=input||{};
 const spent=(used||0)>=DISCOVERY_WORKFLOW_INVOCATION_BUDGET;
 if(mode!=='workflow')return {action:'stop',reason:'executor_not_workflow'};
 if((uncertainWrites||0)>=DISCOVERY_WORKFLOW_WRITE_LIMIT)return {action:'stop',reason:'write_uncertain'};
 if(!pinned||!published||pinned!==published||(record&&record.programmeRunId!==pinned))return {action:'stop',reason:'stale_generation'};
 if(!record)return {action:'stop',reason:'no_continuation'};
 if(lease?.expiresAt>now)return {action:'wait',until:lease.expiresAt,reason:'busy'};
 const due=Date.parse(record.retryAt||record.nextCatchUpAt||0);
 const known=last&&last.programmeRunId===pinned&&Number.isInteger(last.remaining)?last.remaining:null;
 if(record.reason==='chunk_budget'&&due>now){
  if(known>0)return spent?{action:'rollover',reason:'invocation_budget'}:(chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT)?{action:'rollover',reason:'instance_limit'}:{action:'renew',reason:'chunk_budget'};
  if(known===0)return {action:'stop',reason:'backlog_empty'};
  return {action:'wait',until:due,reason:'unknown_remaining'};
 }
 const decision=continuationDecision(record,now);
 if(!decision.run){
  const waiting=decision.contract.nextAction==='wait';
  const until=Date.parse(decision.contract.retryAt||decision.contract.nextCatchUpAt||0);
  return {action:waiting?'wait':'stop',until:Number.isFinite(until)?until:now,reason:decision.contract.reason||decision.contract.state||'stop'};
 }
 if(spent)return {action:'rollover',reason:'invocation_budget'};
 if((chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT))return {action:'rollover',reason:'instance_limit'};
 return {action:'continue',reason:null};
}
async function workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites,used){
 const generation=await loadJSON(env,EPG_GENERATION_KEY);
 const published=publishedProgrammeRunId(generation);
 const stored=await readContinuation(env);
 const lease=await loadJSON(env,'epg/resolver-lease.json');
 const last=await loadJSON(env,'epg/discovery-status.json');
 return {mode:discoveryExecutorMode(env),published,pinned,record:stored.record,lease,now:Date.now(),chunks,chunkLimit,last,uncertainWrites,used};
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
async function runWorkflowChunk(env,meter){
 const before=await readContinuation(env);
 try{
  const outcome=await advanceDiscovery(env,{caller:'internal'});
  const saved=outcome?.diagnostic?.saved?.owned===true;
  const busy=outcome?.stage==='busy'||outcome?.discovery?.reason==='busy';
  return {threw:false,progress:saved,busy,until:outcome?.discovery?.nextCatchUpAt||null,summary:chunkSummary(outcome),saved};
 }catch(e){
  logWorkflowFailure('chunk',e,meter);
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
async function discoveryWorkflowAdmission(env){
 const mode=discoveryExecutorMode(env);
 if(mode==='external')return {ok:false,reason:'external'};
 if(mode!=='workflow')return {ok:false,reason:'invalid'};
 if(typeof env?.DISCOVERY_WORKFLOW?.create!=='function')return {ok:false,reason:'workflow_unavailable'};
 if(typeof DiscoveryAuthority==='undefined')return {ok:false,reason:'authority_not_ready'};
 let gate;
 try{gate=await DiscoveryAuthority.readAuthority(env);}
 catch{return {ok:false,reason:'d1_unavailable'};}
 if(gate?.held||gate?.cutover==='held')return {ok:false,reason:'authority_held'};
 if(gate?.transfer==='loading')return {ok:false,reason:'authority_loading'};
 if(gate?.ready!==true||gate.mode!=='d1'||gate.cutover!=='open')return {ok:false,reason:'authority_not_ready'};
 if(gate.transfer!=='idle'&&gate.transfer!=='committed')return {ok:false,reason:'authority_not_ready'};
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.currentGeneration!=='function')return {ok:false,reason:'generation_unpublished'};
 let live;
 try{live=await PublishedEpg.currentGeneration(env);}
 catch{return {ok:false,reason:'d1_unavailable'};}
 const published=live?.programmeRunId||null;
 if(!published)return {ok:false,reason:'generation_unpublished'};
 const discoveryPin=gate.publishedProgrammeRunId||null;
 if(!discoveryPin||discoveryPin!==published)return {ok:false,reason:'generation_handoff',programmeRunId:published};
 return {ok:true,programmeRunId:published};
}
async function ensurePublishedDiscoveryIntent(env,programmeRunId){
 const before=(await readContinuation(env)).record;
 const same=before?.programmeRunId===programmeRunId;
 // Same-generation programme_changed is the publication-copy artefact queueDiscovery replaces.
 if(same&&before.reason!=='programme_changed'){
  if(discoveryContract(before).nextAction==='stop')return {ok:false,reason:'stopped'};
  return {ok:true,reconstructed:false};
 }
 try{await queueDiscovery(env,'epg_committed',programmeRunId);}
 catch{return {ok:false,reason:'intent_uncertain'};}
 const after=(await readContinuation(env)).record;
 if(!after||after.programmeRunId!==programmeRunId)return {ok:false,reason:after?.programmeRunId?'stale_generation':'intent_unconfirmed'};
 if(after.reason==='programme_changed'||discoveryContract(after).nextAction==='stop')return {ok:false,reason:'stopped'};
 return {ok:true,reconstructed:!same||before.reason==='programme_changed'};
}
function workflowAdmissionError(error){
 const code=error?.code||error?.reason||'';
 if(code==='discovery_fence'||code==='authority_held')return 'authority_held';
 if(code==='discovery_incomplete'||code==='authority_loading')return 'authority_loading';
 return 'd1_unavailable';
}
async function ensureDiscoveryWorkflow(env){
 try{
  const admitted=await discoveryWorkflowAdmission(env);
  if(!admitted.ok)return {started:false,reason:admitted.reason};
  const programmeRunId=admitted.programmeRunId;
  const intent=await ensurePublishedDiscoveryIntent(env,programmeRunId);
  if(!intent.ok)return {started:false,reason:intent.reason,programmeRunId};
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
 }catch(error){return {started:false,reason:workflowAdmissionError(error)};}
}
async function reconcileDiscoveryWorkflow(env){
 try{
 const admitted=await discoveryWorkflowAdmission(env);
 if(!admitted.ok)return {started:false,reason:admitted.reason};
 const programmeRunId=admitted.programmeRunId;
 const intent=await ensurePublishedDiscoveryIntent(env,programmeRunId);
 if(!intent.ok)return {started:false,reason:intent.reason,programmeRunId};
 const binding=env.DISCOVERY_WORKFLOW;
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
 }catch(error){return {started:false,reason:workflowAdmissionError(error)};}
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
async function runDiscoveryWorkflow(rawEnv,payload,step){
 // `meter` counts this invocation. A replay after a sleep starts a new invocation and a new meter, so each step also
 // returns what it spent and `tally.total` re-adds those cached outputs: it is the count of the whole instance.
 // Outputs written before this change carry no count and add nothing.
 const meter={statements:0,batches:0};
 const tally={total:0};
 const failure={recoverable:false};
 const env=meteredEnv(rawEnv,meter);
 const accounted=(name,fn)=>async()=>{
  const before=meter.statements;
  try{const value=await fn();return {__counted:1,value,spent:meter.statements-before};}
  catch(error){logWorkflowFailure(name,error,meter,tally.total);failure.recoverable=workflowStepRecoverable(error,false);throw error;}
 };
 const pinned=payload?.programmeRunId||null;
 const series=Number.isInteger(payload?.series)&&payload.series>=0?payload.series:0;
 const ownId=discoveryInstanceId(pinned,series);
 const requested=payload?.chunkLimit;
 const chunkLimit=Number.isInteger(requested)&&requested>=1&&requested<=DISCOVERY_WORKFLOW_CHUNK_LIMIT?requested:DISCOVERY_WORKFLOW_CHUNK_LIMIT;
 let chunks=0,stalls=0,uncertainWrites=0,steps=0;
 const stepName=prefix=>prefix+'-'+(steps++);
 const doStep=async(prefix,fn)=>{
  const result=await step.do(stepName(prefix),accounted(prefix,fn));
  if(result&&result.__counted===1){tally.total+=Number(result.spent)||0;return result.value;}
  return result;
 };
 // AIR-364 (ADR 0097). A recoverable step failure, after the platform's retries, is armed once through the same owner CAS and
 // `workflowFailure` backoff as every other recovery, then the instance sleeps durably until `dueAt` and asks the existing
 // `ensureDiscoveryWorkflow` for the successor, which re-reads authority, generation, executor record and the recovery gate. The
 // hourly reconcile stays the fallback. A failure of the arming step itself is not caught here: the instance ends as before.
 const recoverAfterStepFailure=async()=>{
  const armed=await doStep('recover-arm',async()=>{
   const owned=await workflowOwnerGate(env,ownId,series);
   if(!owned.owned)return {armed:false,reason:'not_owner'};
   await stopOwnedWorkflow(env,ownId,'step_failure',pinned,series,chunks);
   const record=(await readWorkflowState(env)).record;
   if(record?.instanceId!==ownId||record.series!==series)return {armed:false,reason:'not_owner'};
   return {armed:true,quarantined:record.recovery?.quarantined===true||record.reason==='recovery_exhausted',dueAt:record.recovery?.dueAt||null};
  });
  if(!armed.armed)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
  if(armed.quarantined||!Number.isFinite(Date.parse(armed.dueAt||'')))return {stopped:true,reason:'recovery_exhausted',chunks,instanceId:ownId};
  for(let attempt=0;attempt<3;attempt++){
   await step.sleepUntil(stepName('recover-sleep'),new Date(armed.dueAt));
   const woke=await doStep('recover-successor',async()=>{
    const owned=await workflowOwnerGate(env,ownId,series);
    if(!owned.owned)return {done:true,started:false,reason:'not_owner'};
    // A successor is only ever opened for the generation this instance was pinned to. A newer generation is started by its own
    // commit and the reconcile, never by a stale instance.
    const admitted=await discoveryWorkflowAdmission(env);
    if(!admitted.ok)return {done:true,started:false,reason:admitted.reason};
    if(admitted.programmeRunId!==pinned)return {done:true,started:false,reason:'stale_generation'};
    const outcome=await ensureDiscoveryWorkflow(env);
    return {done:outcome.reason!=='recovery_waiting',started:outcome.started===true,reason:outcome.reason||null};
   });
   if(woke.done)return {stopped:true,reason:woke.started?'recovered':(woke.reason||'recovery_stopped'),chunks,instanceId:ownId};
  }
  return {stopped:true,reason:'recovery_waiting',chunks,instanceId:ownId};
 };
 try{
   for(;;){
    const gate=await doStep('owner',()=>workflowOwnerGate(env,ownId,series));
    if(!gate.owned)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
    if(steps>=DISCOVERY_WORKFLOW_STEP_CAP){
     return doStep('cap',()=>stopOwnedWorkflow(env,ownId,'step_cap',pinned,series,chunks));
    }
    const plan=await doStep('plan',async()=>workflowPlan(await workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites,tally.total)));
    if(plan.action==='stop')return doStep('stop',()=>stopOwnedWorkflow(env,ownId,plan.reason,pinned,series,chunks));
    if(plan.action==='wait'){
     const until=Number.isFinite(plan.until)?plan.until:Date.now()+1000;
     await doStep('wait',()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:plan.reason,waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
     await step.sleepUntil(stepName('sleep'),new Date(until));
     continue;
    }
    if(plan.action==='renew'){
     const renewed=await doStep('renew',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {renewed:false,reason:'not_owner'};return renewDiscoverySeries(env,pinned);});
     if(renewed.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
     if(renewed.renewed){uncertainWrites=0;continue;}
     if(renewed.reason==='unknown_remaining'||renewed.reason==='backlog_empty'||renewed.reason==='stale_generation')continue;
     uncertainWrites++;
     await step.sleepUntil(stepName('renew-sleep'),new Date(Date.now()+1000));
     continue;
    }
    if(plan.action==='rollover'){
     const rolled=await doStep('rollover',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {started:false,reason:'not_owner'};return rolloverDiscoveryWorkflow(env,pinned,series);});
     if(rolled.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
     if(!rolled.started)await doStep('rollover-stop',()=>stopOwnedWorkflow(env,ownId,'rollover_uncertain',pinned,series,chunks));
     return {stopped:true,reason:rolled.started?'rollover':'rollover_uncertain',chunks,instanceId:ownId,successor:rolled};
    }
    const outcome=await doStep('chunk',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {notOwner:true,progress:false,busy:false};return runWorkflowChunk(env,meter);});
    if(outcome.notOwner)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
    if(outcome.busy){
     const until=Date.parse(outcome.until||'')||Date.now()+1000;
     await doStep('busy',()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:'busy',waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
     await step.sleepUntil(stepName('busy-sleep'),new Date(until));
     continue;
    }
    if(!outcome.progress){
     stalls++;
     if(stalls>=DISCOVERY_WORKFLOW_STALL_LIMIT)return doStep('stall',()=>stopOwnedWorkflow(env,ownId,'no_progress',pinned,series,chunks));
     await step.sleepUntil(stepName('stall-sleep'),new Date(Date.now()+1000));
     continue;
    }
    stalls=0;uncertainWrites=0;chunks++;
    await doStep('progress',()=>settleWorkflowIfOwner(env,ownId,{phase:'running',reason:null,programmeRunId:pinned,series,chunksThisInstance:chunks,lastProgress:outcome.summary||null,invocation:{statements:meter.statements,batches:meter.batches},instance:{statements:tally.total},waitingUntil:null,recovery:null}));
   }
 }catch(error){
  if(!workflowStepRecoverable(error,failure.recoverable))throw error;
  return recoverAfterStepFailure();
 }
}
