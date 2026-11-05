// AIR-347 / ADR 0089. The Cloudflare executor of the daily Letterboxd ratings run, inert until the owner switches the domain.
// Two D1-owned documents under the ratings marker (ADR 0084) hold everything:
//  - letterboxd/ratings/executor.json: the mode (external | switching | cloudflare), the target, the epoch and the drain state.
//    Only the owner's mode switch writes it. Absent means external, epoch 0.
//  - letterboxd/ratings/orchestration.json: the control record (run key, instance, checkpoint, retry budget, cooldown,
//    quarantine, last durable progress). Only the executor and the owner's quarantine clear write it.
// Every commit an executor step makes carries `ratingsFence` (the executor document and the etag it had at admission), so
// RatingsD1 refuses it in the same D1 batch once the owner has closed admission (decision 2a). Removal events are written in
// R2 by the existing pipeline, idempotent by event key. The cron `ensure` creates one Workflow instance per Madrid day and
// series; the instance drives the existing LetterboxdRatings start and step and never repeats a write blind.
// The binding creates nothing by itself and nothing here is scheduled: with the mode external, `ensure` reads one document and
// returns. Read model: status().orchestration. Contract: docs/reference/orchestration-reliability.md.
// Concatenated into the Worker like the other server modules: one global.
const RatingsOrchestration=(()=>{
 const MODE_KEY='letterboxd/ratings/executor.json',CONTROL_KEY='letterboxd/ratings/orchestration.json';
 const MODES=['external','switching','cloudflare'];
 const STEP_CAP=200,SLEEP_FLOOR_MS=1000,PAUSE_MS=6*3600000,DRAIN_MARGIN_MS=3*60000,CONTROL_ATTEMPTS=4,ALIVE=['running','waiting','queued','paused'],ENDED=['complete','errored','terminated','absent'];
 const iso=ms=>new Date(ms).toISOString();
 const policy=()=>OrchestrationPolicy;
 const ratings=()=>LetterboxdRatings;
 const instanceId=(runKey,series)=>'ratings_'+String(runKey).replace(/-/g,'')+'_'+series;
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
 const fencedEnv=(env,etag)=>({...env,ratingsFence:{key:MODE_KEY,etag}});
 async function authorityState(env){
  if(typeof RatingsD1==='undefined')return {ready:false,error:false};
  const gate=await RatingsD1.ratingsGate(env);
  return {ready:gate.ready===true,error:gate.error===true};
 }
 // The platform's view of one instance. `unknown` is a read that could not tell, never an ended instance.
 async function instanceStatus(binding,id){
  if(!binding||typeof binding.get!=='function')return 'unknown';
  try{
   const instance=await binding.get(id);
   const status=typeof instance?.status==='function'?await instance.status():instance?.status;
   const name=typeof status==='string'?status:status?.status;
   return typeof name==='string'?name:'unknown';
  }catch(e){return /not found|does not exist|unknown instance/i.test(String(e?.message||''))?'absent':'unknown';}
 }
 const createError=error=>/already exists|already_exists|duplicate/i.test(String(error?.name||'')+' '+String(error?.message||''))?'exists':'uncertain';
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
  if(control.record.instanceId&&['starting','running','waiting'].includes(control.record.phase)){
   const status=await instanceStatus(env.RATINGS_WORKFLOW,control.record.instanceId);
   if(status==='unknown')return 'unreadable';
   if(!ENDED.includes(status))return 'instance_live';
  }
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
    if(current.mode==='switching')return {action,refused:'switch_open',mode:current.mode,target:current.target,epoch:current.epoch};
    if(current.mode===target)return {action,refused:'already_in_mode',mode:current.mode,epoch:current.epoch};
    const next={schemaVersion:1,mode:'switching',from:current.mode,target,epoch:current.epoch+1,drain:null,changedAt:iso(now)};
    if(await casMode(env,mode.etag,next))return {action,closed:true,mode:'switching',target,epoch:next.epoch};
    continue;
   }
   if(action==='complete'){
    if(current.mode!=='switching')return {action,refused:'not_switching',mode:current.mode,epoch:current.epoch};
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
  if(body.action==='clear_quarantine')return {status:200,body:await clearQuarantine(env)};
  return {status:200,body:await switchMode(env,body)};
 }
 // The external path's gate for ratings_sync_start and ratings_sync_step: `switch_in_progress` while admission is closed,
 // `external_writer_fenced` once the switch to Cloudflare has completed, whatever an old Task prompt sends. Reads stay open.
 async function externalGate(env,action){
  if(action!=='start'&&action!=='step')return null;
  const mode=await readMode(env);
  if(mode.malformed)return 'evidence_unreadable';
  if(mode.record.mode==='switching')return 'switch_in_progress';
  if(mode.record.mode==='cloudflare')return 'external_writer_fenced';
  return null;
 }

 // ---- admission and one executor action ---------------------------------------------------------------------
 async function admit(env,{runKey,series,epoch,id}){
  const mode=await readMode(env);
  if(mode.malformed)return {ok:false,reason:'evidence_unreadable',unsafe:true};
  if(mode.record.mode==='switching')return {ok:false,reason:'switch_in_progress'};
  if(mode.record.mode!=='cloudflare')return {ok:false,reason:'not_cloudflare'};
  if(mode.record.epoch!==epoch)return {ok:false,reason:'epoch_mismatch'};
  const authority=await authorityState(env);
  if(authority.error)return {ok:false,reason:'d1_unavailable',transient:true};
  if(!authority.ready)return {ok:false,reason:'authority_held',unsafe:true};
  const control=await readControl(env);
  if(control.malformed)return {ok:false,reason:'checkpoint_malformed',unsafe:true};
  if(control.record.instanceId!==id||control.record.series!==series||control.record.runKey!==runKey)return {ok:false,reason:'not_owner'};
  return {ok:true,modeEtag:mode.etag,control:control.record,controlEtag:control.etag,controlStored:control.stored};
 }
 const checkpointKey=run=>run?[run.state,run.phase,run.checkpoint?.diaryPagesRead??0,run.checkpoint?.diaryNextPage??null,run.checkpoint?.removalChecked??0,run.checkpoint?.legacyPagesLinked??0].join('|'):null;
 // Durable progress is a counter that moved forward in the same run, never a restart or a changed run state.
 const progressCount=run=>run?(run.checkpoint?.diaryPagesRead??0)+(run.checkpoint?.removalChecked??0)+(run.checkpoint?.legacyPagesLinked??0):0;
 const advanced=(run,previous)=>!!run&&!!previous&&previous.runId===run.runId&&progressCount(run)>(previous.count??0);
 const dayOf=ms=>policy().madridDayKey(ms);

 // The ratings work of one action: a start, or one bounded step. Returns what happened, never throws a write it may have made.
 async function drive(fe,control,{now,clock}){
  const runKey=control.runKey;
  let run=await ratings().readRun(fe);
  const today=run&&Number.isFinite(Date.parse(run.startedAt))&&dayOf(Date.parse(run.startedAt))===runKey?run:null;
  // Read-after-unknown: a run of this Madrid date that already finished is the success, whoever started it.
  if(today?.state==='finished')return {finished:true,runId:today.runId,run:today};
  let runId=today?.state==='running'?today.runId:null;
  if(!runId){
   const reply=await ratings().start(fe,{trigger:'scheduled'},now);
   if(reply.reason==='not_migrated')return {failure:{code:'config_invalid'}};
   if(reply.reason==='isolated')return {failure:{code:'evidence_contradictory'}};
   if(reply.reason==='busy')return {wake:now+SLEEP_FLOOR_MS*60,note:'busy'};
   if(!reply.created)return {failure:{code:'owner_unknown'}};
   return {runId:reply.runId,started:true,run:await ratings().readRun(fe)};
  }
  const reply=await ratings().step(fe,{runId},{now,clock});
  const after=await ratings().readRun(fe);
  const base={runId,run:after,reply};
  if(reply.reason==='lease_lost')return {...base,failure:{code:'owner_unknown'}};
  if(reply.reason==='busy'){const until=Date.parse(reply.nextCatchUpAt||'');return {...base,wake:Number.isFinite(until)?until:now+SLEEP_FLOOR_MS*60,note:'busy'};}
  if(reply.reason==='unknown')return {...base,failure:{code:'owner_unknown'}};
  if(reply.reason==='not_migrated')return {...base,failure:{code:'config_invalid'}};
  if(reply.reason==='not_running')return {...base,failure:{code:'evidence_unreadable'}};
  if(reply.reason==='run_mismatch')return {...base,failure:{code:'owner_conflict'}};
  if(reply.state==='finished'||after?.state==='finished')return {...base,finished:true};
  if(after?.state==='error'){
   const cause=after.cause;
   if(cause==='blocked')return {...base,failure:{code:'upstream_blocked'},noRetryInRun:true};
   if(cause==='rate_limited'){
    const paused=Date.parse(after.removal?.pausedUntil||'');
    return {...base,failure:{code:'rate_limited',retryAfterAt:Number.isFinite(paused)&&paused>now?paused:now+PAUSE_MS}};
   }
   return {...base,failure:{code:'network_error'}};
  }
  return base;
 }

 async function writeControl(env,adm,next,attemptsLeft=CONTROL_ATTEMPTS){
  const fe=fencedEnv(env,adm.modeEtag);
  const saved=await ratings().writeDocument(fe,CONTROL_KEY,adm.controlStored?{etag:adm.controlEtag}:null,next);
  return saved!==null;
 }
 // One executor action: admit, plan, drive, commit the control record. Always returns a plain result.
 async function act(env,ctx){
  const {runKey,series,epoch,id}=ctx,now=ctx.now(),clock=ctx.clock||(()=>Date.now());
  const adm=await admit(env,{runKey,series,epoch,id});
  if(!adm.ok){
   if(adm.transient)return {kind:'sleep',until:now+policy().COOLDOWNS_MS[0],reason:adm.reason};
   return {kind:'stop',reason:adm.reason};
  }
  const control=adm.control;
  if(control.doneAt)return {kind:'stop',reason:'complete'};
  if(control.quarantine)return {kind:'stop',reason:'quarantined'};
  if(dayOf(now)!==runKey)return {kind:'stop',reason:'day_rolled'};
  const cooling=Date.parse(control.cooldownUntil||'');
  if(Number.isFinite(cooling)&&cooling>now)return {kind:'sleep',until:cooling,reason:'cooldown'};
  const fe=fencedEnv(env,adm.modeEtag);
  const began=clock();
  let outcome;
  try{outcome=await drive(fe,control,{now,clock});}
  catch(error){outcome={failure:{code:classifyThrown(error)}};}
  if(outcome.failure?.code==='epoch_mismatch')return {kind:'stop',reason:'epoch_mismatch'};
  // Commit. A thrown commit is not retried blind: the next action reads the control record first.
  const key=outcome.run?checkpointKey(outcome.run):control.checkpoint?.key??null;
  const next={...control,runId:outcome.runId??control.runId,updatedAt:iso(now),nextWakeAt:outcome.wake?iso(outcome.wake):null,lastStep:{latencyMs:Math.max(0,clock()-began),started:outcome.started===true,note:outcome.note||null}};
  let result;
  if(outcome.failure){
   const {code,retryAfterAt}=outcome.failure,applied=policy().applyFailure(control.budget,{code},{now,phase:outcome.run?.phase??control.checkpoint?.phase??null,checkpoint:key,retryAfterAt,random:ctx.random});
   next.budget=applied.budget;next.cooldownUntil=applied.cooldownUntil;next.failure={class:policy().failureClass(code),code};
   next.checkpoint={key,phase:outcome.run?.phase??null,runId:outcome.run?.runId??null,count:progressCount(outcome.run)};
   if(applied.quarantine)next.quarantine={...applied.quarantine,at:iso(now)};
   if(outcome.noRetryInRun){next.phase='stopped';next.nextWakeAt=iso(policy().nextDailyDue(now));}
   result=applied.quarantine?{kind:'stop',reason:applied.quarantine.reason}:outcome.noRetryInRun?{kind:'stop',reason:'blocked_until_next_date'}:policy().failureClass(code)==='permanent'?{kind:'stop',reason:code}:{kind:'sleep',until:Date.parse(applied.cooldownUntil),reason:'cooldown'};
  }else{
   // Starting a run, a lease or an HTTP answer is not progress; a forward checkpoint or a finished run is.
   const progressed=outcome.finished===true||(outcome.started!==true&&outcome.run?.state!=='error'&&advanced(outcome.run,control.checkpoint));
   if(progressed){next.budget=policy().applyProgress(control.budget);next.lastDurableProgressAt=iso(now);next.cooldownUntil=null;next.failure=null;}
   next.checkpoint={key,phase:outcome.run?.phase??null,runId:outcome.run?.runId??null,count:progressCount(outcome.run)};
   if(outcome.finished){next.doneAt=iso(now);next.phase='done';}else next.phase=outcome.wake?'waiting':'running';
   result=outcome.finished?{kind:'stop',reason:'complete'}:outcome.wake?{kind:'sleep',until:outcome.wake,reason:outcome.note||'wait'}:{kind:'continue',reason:null};
  }
  if(!await writeControl(env,adm,next)){
   // Lost compare-and-swap or a commit refused by the epoch fence: read the mode before anything else.
   const again=await admit(env,{runKey,series,epoch,id});
   if(!again.ok&&(again.reason==='epoch_mismatch'||again.reason==='switch_in_progress'||again.reason==='not_cloudflare'))return {kind:'stop',reason:again.reason};
   return {kind:'sleep',until:now+SLEEP_FLOOR_MS,reason:'write_conflict'};
  }
  return result;
 }

 // ---- the Workflow instance ---------------------------------------------------------------------------------
 async function run(env,payload,step,hooks={}){
  const runKey=typeof payload?.runKey==='string'?payload.runKey:null,series=Number.isInteger(payload?.series)?payload.series:0,epoch=Number.isInteger(payload?.epoch)?payload.epoch:-1;
  if(!runKey)return {stopped:true,reason:'invalid_payload'};
  const id=instanceId(runKey,series),ctx={runKey,series,epoch,id,now:hooks.now||(()=>Date.now()),clock:hooks.clock,random:hooks.random||Math.random};
  let steps=0;
  const name=prefix=>prefix+'-'+(steps++);
  for(;;){
   if(steps>=STEP_CAP){
    await step.do(name('cap'),()=>stopInstance(env,ctx,'step_cap'));
    return {stopped:true,reason:'step_cap',instanceId:id};
   }
   const result=await step.do(name('act'),()=>act(env,ctx).catch(()=>({kind:'sleep',until:ctx.now()+60000,reason:'act_failed'})));
   if(result.kind==='stop'){
    await step.do(name('stopped'),()=>stopInstance(env,ctx,result.reason));
    return {stopped:true,reason:result.reason,instanceId:id};
   }
   if(result.kind==='sleep')await step.sleepUntil(name('sleep'),new Date(Math.max(result.until,ctx.now()+SLEEP_FLOOR_MS)));
  }
 }
 // The instance records why it ended, if it is still the owner and the mode still admits it. A stale instance writes nothing.
 async function stopInstance(env,ctx,reason){
  try{
   const adm=await admit(env,ctx);
   if(!adm.ok)return {recorded:false,reason:adm.reason};
   if(adm.control.doneAt||adm.control.quarantine)return {recorded:false,reason};
   const next={...adm.control,phase:'stopped',stopReason:reason,updatedAt:iso(ctx.now())};
   return {recorded:await writeControl(env,adm,next),reason};
  }catch{return {recorded:false,reason};}
 }

 // ---- the cron `ensure` -------------------------------------------------------------------------------------
 // At most a few reads, at most one create. Safe under duplicate and overlapping firings: the control record is claimed by
 // compare-and-swap on the run key and series before the create, and a second create attaches to the same instance id.
 async function ensure(env,{now=Date.now(),random=Math.random}={}){
  let mode;
  try{mode=await readMode(env);}catch{return {started:false,reason:'mode_unreadable'};}
  if(mode.malformed)return {started:false,reason:'evidence_unreadable'};
  if(mode.record.mode==='switching')return {started:false,reason:'switch_in_progress'};
  if(mode.record.mode!=='cloudflare')return {started:false,reason:'external'};
  if(typeof env?.RATINGS_WORKFLOW?.create!=='function')return {started:false,reason:'workflow_unavailable'};
  const authority=await authorityState(env);
  if(authority.error)return {started:false,reason:'d1_unavailable'};
  if(!authority.ready)return {started:false,reason:'authority_held'};
  const {dayKey,due,dueAt}=policy().dailyDue(now);
  if(!due)return {started:false,reason:'not_due',dueAt:iso(dueAt)};
  const stored=await readControl(env);
  if(stored.malformed)return {started:false,reason:'checkpoint_malformed'};
  let control=stored.record;
  const domainQuarantine=control.quarantine?.scope==='domain'?control.quarantine:null;
  if(domainQuarantine)return {started:false,reason:'quarantined',scope:'domain'};
  let series=0,budget=policy().emptyBudget(),carry={};
  if(control.runKey===dayKey){
   if(control.doneAt)return {started:false,reason:'complete'};
   if(control.quarantine)return {started:false,reason:'quarantined',scope:'run'};
   if(control.phase==='stopped'&&control.stopReason==='blocked_until_next_date')return {started:false,reason:'blocked_until_next_date'};
   const cooling=Date.parse(control.cooldownUntil||'');
   if(control.instanceId&&['starting','running','waiting'].includes(control.phase)){
    const status=await instanceStatus(env.RATINGS_WORKFLOW,control.instanceId);
    if(ALIVE.includes(status))return {started:false,reason:'in_progress',instanceId:control.instanceId};
    if(status==='unknown')return {started:false,reason:'status_unknown',instanceId:control.instanceId};
    // The instance ended with the run unfinished: a counted transient failure, then a successor under the same day key.
    const code=status==='errored'?'instance_errored':status==='absent'?'create_uncertain':'instance_terminated';
    const applied=policy().applyFailure(control.budget,{code},{now,phase:control.checkpoint?.phase??null,checkpoint:control.checkpoint?.key??null,random});
    control={...control,budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:'transient',code},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null,phase:'stopped',stopReason:code,updatedAt:iso(now)};
    const fe=fencedEnv(env,mode.etag);
    if(await ratings().writeDocument(fe,CONTROL_KEY,stored.stored?{etag:stored.etag}:null,control)===null)return {started:false,reason:'write_conflict'};
    if(applied.quarantine)return {started:false,reason:'quarantined',scope:'run'};
    return {started:false,reason:'cooldown',until:applied.cooldownUntil,recorded:code};
   }
   if(Number.isFinite(cooling)&&cooling>now)return {started:false,reason:'cooldown',until:control.cooldownUntil};
   series=(control.series??0)+1;budget=control.budget;carry={failure:control.failure,lastDurableProgressAt:control.lastDurableProgressAt,runId:control.runId,checkpoint:control.checkpoint};
  }
  const id=instanceId(dayKey,series);
  const next={...emptyControl(),...carry,schemaVersion:1,runKey:dayKey,series,instanceId:id,epoch:mode.record.epoch,phase:'starting',budget,updatedAt:iso(now)};
  const fe=fencedEnv(env,mode.etag);
  // The receipt of the claim is the control record naming this run key, series and epoch.
  if(await ratings().writeDocument(fe,CONTROL_KEY,stored.stored?{etag:stored.etag}:null,next)===null)return {started:false,reason:'write_conflict'};
  try{
   await env.RATINGS_WORKFLOW.create({id,params:{runKey:dayKey,series,epoch:mode.record.epoch}});
   return {started:true,attached:false,instanceId:id,runKey:dayKey,series};
  }catch(error){
   if(createError(error)==='exists')return {started:true,attached:true,instanceId:id,runKey:dayKey,series};
   // A lost create response: read the platform before anything else; the instance may exist.
   const status=await instanceStatus(env.RATINGS_WORKFLOW,id);
   if(ALIVE.includes(status)||status==='complete')return {started:true,attached:true,instanceId:id,runKey:dayKey,series};
   const applied=policy().applyFailure(budget,{code:'create_uncertain'},{now,random});
   const failed={...next,phase:'stopped',stopReason:'create_uncertain',budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:'transient',code:'create_uncertain'},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null};
   const reread=await readControl(env);
   if(reread.record?.instanceId===id)await ratings().writeDocument(fe,CONTROL_KEY,{etag:reread.etag},failed);
   return {started:false,reason:'create_uncertain',instanceId:id};
  }
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
  let liveness=null;
  if(m.mode==='cloudflare'&&c.instanceId&&['starting','running','waiting'].includes(c.phase)&&typeof env?.RATINGS_WORKFLOW?.get==='function'){
   const status=await instanceStatus(env.RATINGS_WORKFLOW,c.instanceId);
   liveness=ALIVE.includes(status)?'alive':status==='complete'?'finished':status==='absent'?'absent':'unknown';
  }
  const sameKey=c.runKey===dayKey;
  const lastProgress=sameKey?c.lastDurableProgressAt:(run?.lastStepAt||null);
  const health=control.malformed?'quarantined':policy().deriveHealth({now,dueAt,done:doneToday,quarantine:c.quarantine,permanent:c.failure?.class==='permanent'&&sameKey,cooldownUntil:sameKey?c.cooldownUntil:null,nextWakeAt:sameKey?c.nextWakeAt:null,lastDurableProgressAt:lastProgress});
  return {mode:m.mode,epoch:m.epoch,...(m.mode==='switching'?{target:m.target,drain:m.drain||null}:{}),runKey:c.runKey,published:null,phase:c.phase,
   owner:{kind:'workflow',instanceId:c.instanceId,liveness},lastDurableProgressAt:c.lastDurableProgressAt,oldestPendingAt:doneToday||!(now>=dueAt)?null:iso(dueAt),dueAt:iso(dueAt),nextWakeAt:c.nextWakeAt||(now>=dueAt?null:iso(dueAt)),
   failure:{class:c.failure?.class??null,code:c.failure?.code??null,fingerprint:c.budget?.fingerprint??null,consecutive:c.budget?.consecutive??0,total:c.budget?.total??0,caps:policy().BUDGET_CAPS},
   cooldownUntil:c.cooldownUntil,quarantine:c.quarantine,lastStep:c.lastStep,health,sideEffects:'none'};
 }
 return {MODE_KEY,CONTROL_KEY,instanceId,readMode,readControl,switchMode,clearQuarantine,handle,validate,externalGate,admit,act,run,ensure,readModel,drainState,classifyThrown};
})();
async function runRatingsWorkflow(env,payload,step){return RatingsOrchestration.run(env,payload,step);}
