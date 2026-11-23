// The legacy Ratings executor's mode, fence and read model (ADR 0089, ADR 0090), reduced to what the Letterboxd Sync still reads.
// The Cloudflare Workflow that used to drive the daily Ratings run is retired: no code creates or runs an instance, the
// `RATINGS_WORKFLOW` binding and the `RatingsWorkflow` class are gone, and the mode `cloudflare` can no longer be entered.
// Two D1-owned documents under the ratings marker (ADR 0084) remain:
//  - letterboxd/ratings/executor.json: the mode (external | switching | cloudflare), the target, the epoch and the drain state.
//    Only the owner's mode switch writes it. Absent means external, epoch 0.
//  - letterboxd/ratings/orchestration.json: the last control record (run key, instance, checkpoint, retry budget, cooldown,
//    quarantine). Only the owner's quarantine clear writes it now.
// The Letterboxd Sync's handover proof reads `readMode`, `drainState` and `externalGate`; the monitor and `ratings_sync_status`
// read `readModel`. Contract: docs/reference/orchestration-reliability.md.
// Concatenated into the Worker like the other server modules: one global.
const RatingsOrchestration=(()=>{
 const MODE_KEY='letterboxd/ratings/executor.json',CONTROL_KEY='letterboxd/ratings/orchestration.json';
 const MODES=['external','switching','cloudflare'];
 const DRAIN_MARGIN_MS=3*60000,CONTROL_ATTEMPTS=4;
 const iso=ms=>new Date(ms).toISOString();
 const policy=()=>OrchestrationPolicy;
 // Absent module or schema means the Letterboxd Sync is inert, never a fence.
 const ratings=()=>LetterboxdRatings;
 const dayOf=ms=>policy().madridDayKey(ms);
 const emptyControl=()=>({schemaVersion:1,runKey:null,series:0,instanceId:null,epoch:null,phase:'idle',runId:null,checkpoint:null,budget:policy().emptyBudget(),cooldownUntil:null,quarantine:null,failure:null,lastDurableProgressAt:null,nextWakeAt:null,lastStep:null,doneAt:null,updatedAt:null});

 async function readMode(env){
  const {object,value}=await ratings().readDocument(env,MODE_KEY);
  if(value==null)return {record:{schemaVersion:1,mode:'external',target:null,epoch:0,drain:null},etag:object?.etag??null,stored:false,malformed:false};
  const ok=typeof value==='object'&&!Array.isArray(value)&&MODES.includes(value.mode)&&Number.isInteger(value.epoch)&&value.epoch>=0&&(value.mode!=='switching'||MODES.includes(value.target));
  return {record:ok?value:null,etag:object?.etag??null,stored:true,malformed:!ok};
 }
 async function readControl(env){
  const {object,value}=await ratings().readDocument(env,CONTROL_KEY);
  if(value==null)return {record:emptyControl(),etag:object?.etag??null,stored:false,malformed:false};
  const ok=typeof value==='object'&&!Array.isArray(value)&&value.schemaVersion===1&&value.budget&&Number.isInteger(value.budget.consecutive)&&Number.isInteger(value.budget.total);
  return {record:ok?value:null,etag:object?.etag??null,stored:true,malformed:!ok};
 }
 // AIR-571 D: the Letterboxd mode revision an admission saw (null while the Letterboxd schema is absent). An unreadable row is `undefined`: the caller refuses.
 const letterboxdAdmission=async env=>typeof LetterboxdSync==='undefined'?{fenced:false,revision:null}:LetterboxdSync.legacyAdmission(env).catch(()=>({fenced:true,reason:'evidence_unreadable',revision:null}));
 // An error thrown by a step, by class only: its message is never copied into a record.
 function classifyThrown(error){
  const code=String(error?.code||'');
  if(code==='ratings_domain_fence')return 'epoch_mismatch';
  if(code==='ratings_domain_unavailable'||code==='write_contention')return 'd1_unavailable';
  if(code==='ratings_domain_not_authoritative')return 'authority_held';
  return 'step_failed';
 }

 // ---- the owner's mode switch (decision 2a) -------------------------------------------------------------------
 // Drain: the previous owner has no step in flight. Verified, not assumed.
 async function drainState(env,now){
  let run;
  try{run=await ratings().readRun(env);}catch{return 'unreadable';}
  const lease=run?.lease;
  if(lease?.step){
   const until=Date.parse(lease.expiresAt||'');
   if(!Number.isFinite(until))return 'unreadable';
   if(until+DRAIN_MARGIN_MS>now)return 'lease_live';
  }
  let control;
  try{control=await readControl(env);}catch{return 'unreadable';}
  if(control.malformed)return 'unreadable';
  // The Workflow is retired, so an instance named by a control record in a live phase can no longer be read from the platform: it is
  // never proven drained (fail closed). A closed record (`done`, `stopped`, `idle`) has nothing in flight.
  if(control.record.instanceId&&['starting','running','waiting'].includes(control.record.phase))return 'unreadable';
  return 'verified';
 }
 async function casMode(env,etag,record){
  const saved=await ratings().writeDocument(env,MODE_KEY,etag==null?null:{etag},record);
  return saved!==null;
 }
 async function switchMode(env,{action,target}={},now=Date.now()){
  for(let attempt=0;attempt<CONTROL_ATTEMPTS;attempt++){
   const mode=await readMode(env);
   if(mode.malformed)return {action,refused:'evidence_unreadable'};
   const current=mode.record;
   if(action==='close_admission'){
    // The Cloudflare executor is retired: nothing can run it, so the mode `cloudflare` would only imitate a working rollback. Refused for every current mode.
    if(target==='cloudflare')return {action,refused:'legacy_executor_retired',mode:current.mode,epoch:current.epoch};
    if(current.mode==='switching')return {action,refused:'switch_open',mode:current.mode,target:current.target,epoch:current.epoch};
    if(current.mode===target)return {action,refused:'already_in_mode',mode:current.mode,epoch:current.epoch};
    const next={schemaVersion:1,mode:'switching',from:current.mode,target,epoch:current.epoch+1,drain:null,changedAt:iso(now)};
    if(await casMode(env,mode.etag,next))return {action,closed:true,mode:'switching',target,epoch:next.epoch};
    continue;
   }
   if(action==='complete'){
    if(current.mode!=='switching')return {action,refused:'not_switching',mode:current.mode,epoch:current.epoch};
    if(current.target==='cloudflare')return {action,refused:'legacy_executor_retired',mode:current.mode,epoch:current.epoch};
    const drain=await drainState(env,now);
    if(drain!=='verified'){
     if(current.drain!==drain)await casMode(env,mode.etag,{...current,drain,drainCheckedAt:iso(now)});
     return {action,refused:'drain_not_verified',drain,mode:'switching',target:current.target,epoch:current.epoch};
    }
    const next={schemaVersion:1,mode:current.target,from:current.from,target:null,epoch:current.epoch,drain:'verified',changedAt:current.changedAt,completedAt:iso(now)};
    if(await casMode(env,mode.etag,next))return {action,completed:true,mode:next.mode,epoch:next.epoch,drain:'verified'};
    continue;
   }
   return {action,refused:'unknown_action'};
  }
  return {action,refused:'write_contention'};
 }
 // The owner clears a quarantine: an explicit action that runs no step. A run-scope quarantine ends with its run key. The
 // domain quarantine, and the pipeline's own `isolated` mark that maps to it, are cleared here and only here.
 async function clearQuarantine(env,now=Date.now()){
  const mode=await readMode(env);
  if(mode.malformed)return {action:'clear_quarantine',refused:'evidence_unreadable'};
  if(mode.record.mode==='switching')return {action:'clear_quarantine',refused:'switch_in_progress'};
  for(let attempt=0;attempt<CONTROL_ATTEMPTS;attempt++){
   const control=await readControl(env);
   if(control.malformed)return {action:'clear_quarantine',refused:'evidence_unreadable'};
   const run=await ratings().readRun(env);
   const cleared={run:false,control:false};
   if(run?.isolation){
    const {object}=await ratings().readDocument(env,ratings().KEYS.run);
    if(await ratings().writeDocument(env,ratings().KEYS.run,object,{...run,isolation:null,isolationClearedAt:iso(now)})===null)continue;
    cleared.run=true;
   }
   if(control.record.quarantine){
    const next={...control.record,quarantine:null,failure:null,cooldownUntil:null,budget:policy().emptyBudget(),updatedAt:iso(now)};
    if(await ratings().writeDocument(env,CONTROL_KEY,control.stored?{etag:control.etag}:null,next)===null)continue;
    cleared.control=true;
   }
   return {action:'clear_quarantine',cleared};
  }
  return {action:'clear_quarantine',refused:'write_contention'};
 }
 const ACTIONS={close_admission:{target:value=>value==='cloudflare'||value==='external'},complete:{},clear_quarantine:{}};
 function validate(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return 'Invalid request';
  const fields=ACTIONS[body.action];
  if(!fields)return 'Unknown action';
  for(const key of Object.keys(body))if(key!=='action'&&!Object.hasOwn(fields,key))return 'Unknown field';
  if(body.action==='close_admission'&&body.target===undefined)return 'Missing target';
  for(const [key,check] of Object.entries(fields))if(body[key]!==undefined&&!check(body[key]))return 'Invalid '+key;
  return null;
 }
 async function handle(env,body){
  const error=validate(body);if(error)return {status:400,body:{error}};
  try{
   if(body.action==='clear_quarantine')return {status:200,body:await clearQuarantine(env)};
   return {status:200,body:await switchMode(env,body)};
  }catch(error){
   // The mode and control records are D1-only: an unavailable or held authority refuses the action and writes nothing to R2.
   return {status:200,body:{action:body.action,refused:classifyThrown(error)}};
  }
 }
 // The external path's gate for the Ratings `start` and `step` actions (no route or tool exposes them now; the handover proof still reads it): `switch_in_progress` while admission is closed,
 // `external_writer_fenced` once the switch to Cloudflare has completed, whatever an old Task prompt sends. Reads stay open.
 async function externalGate(env,action,body={}){
  const writes=action==='start'||action==='step';
  if(!writes)return {reason:null,fence:null};
  let mode;
  try{mode=await readMode(env);}catch{return {reason:'evidence_unreadable',fence:null};}
  if(mode.malformed)return {reason:'evidence_unreadable',fence:null};
  if(mode.record.mode==='switching')return {reason:'switch_in_progress',fence:null};
  if(mode.record.mode==='cloudflare')return {reason:'external_writer_fenced',fence:null};
  // AIR-570 / ADR 0186 O5: `external` is not a sufficient fence. While the Letterboxd Sync owns (or is taking over) the Diary, the legacy entry points are refused.
  // ONE read decides the fence and returns the revision the commit will pin (a second read could see a newer owner's row).
  const letterboxd=await letterboxdAdmission(env);
  if(letterboxd.fenced)return {reason:'external_writer_fenced',fence:null};
  // AIR-571 D: an admitted legacy request must not commit after the Letterboxd mode moved. The revision of THE read above is asserted, with mode `external`, in the batch of every authoritative commit (ratings-d1 epochFence).
  return {reason:null,fence:{key:MODE_KEY,etag:mode.etag??null,...(Number.isInteger(letterboxd.revision)?{letterboxdRevision:letterboxd.revision,...(letterboxd.watchlistGuard?{watchlistGuard:true}:{})}:{})}};
 }

 // ---- the read model (decision 7). Reads only; never creates or repairs. -------------------------------------------
 async function readModel(env,now=Date.now()){
  const mode=await readMode(env);
  if(mode.malformed)return {mode:null,health:'quarantined',failure:{class:'unsafe',code:'evidence_unreadable'},sideEffects:'none'};
  const control=await readControl(env);
  const m=mode.record,c=control.malformed?emptyControl():control.record;
  const {dayKey,dueAt}=policy().dailyDue(now);
  const run=await ratings().readRun(env);
  const started=run&&Number.isFinite(Date.parse(run.startedAt))?dayOf(Date.parse(run.startedAt)):null;
  const doneToday=(c.runKey===dayKey&&!!c.doneAt)||(started===dayKey&&run.state==='finished');
  const sameKey=c.runKey===dayKey;
  const lastProgress=sameKey?c.lastDurableProgressAt:(run?.lastStepAt||null);
  const health=control.malformed?'quarantined':policy().deriveHealth({now,dueAt,done:doneToday,quarantine:c.quarantine,permanent:c.failure?.class==='permanent'&&sameKey,cooldownUntil:sameKey?c.cooldownUntil:null,nextWakeAt:sameKey?c.nextWakeAt:null,lastDurableProgressAt:lastProgress});
  return {mode:m.mode,epoch:m.epoch,...(m.mode==='switching'?{target:m.target,drain:m.drain||null}:{}),runKey:c.runKey,published:null,phase:c.phase,
   owner:{kind:'workflow',instanceId:c.instanceId,liveness:null},lastDurableProgressAt:c.lastDurableProgressAt,oldestPendingAt:doneToday||!(now>=dueAt)?null:iso(dueAt),dueAt:iso(dueAt),nextWakeAt:c.nextWakeAt||(now>=dueAt?null:iso(dueAt)),
   failure:{class:c.failure?.class??null,code:c.failure?.code??null,fingerprint:c.budget?.fingerprint??null,consecutive:c.budget?.consecutive??0,total:c.budget?.total??0,caps:policy().BUDGET_CAPS},
   cooldownUntil:c.cooldownUntil,quarantine:c.quarantine,lastStep:c.lastStep,health,sideEffects:'none'};
 }
 return {MODE_KEY,CONTROL_KEY,readMode,readControl,switchMode,clearQuarantine,handle,validate,externalGate,readModel,drainState,classifyThrown};
})();
