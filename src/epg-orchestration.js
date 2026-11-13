// AIR-348 / ADR 0100 (on the contract of ADR 0089). The Cloudflare executor of the daily EPG publication, inert until the owner
// switches the mode. Three D1-owned documents (table epg_orchestration_document, migration 0017) hold everything:
//  - `mode`: external | switching | cloudflare, the target, the epoch and the drain state. Only the owner's mode switch writes it.
//    Absent (or the table not applied) means external, epoch 0.
//  - `control`: the control record (run key, instance, checkpoint, retry budget, cooldown, quarantine, last durable progress).
//    Only the executor and the owner's quarantine clear write it, and only under the mode revision it was admitted with.
// A durable step lease (the `lease` row) makes an in-flight step provable: every external or executor step takes it, renews it at
// each mutation boundary, and the owner's drain waits for it. Every mutation boundary (saveJSON, the seal units, the staging and
// the generation copy) asserts that the step still holds the lease under the mode revision it was admitted with, so a step admitted
// before `close_admission` fails at its next boundary and cannot persist R2 state against the Cloudflare driver.
// Every authoritative published-EPG commit carries `epgFence` (the mode document's revision at admission), asserted in the same
// D1 batch by src/published-epg.js, so a commit admitted before the owner closed admission cannot land after it.
// The executor reuses the existing pipeline: one action is one `/api/sync/start` or one `/api/sync/metadata|epg` step, called
// in-process through postSync with the caller `internal`. It never fetches a source itself and never repeats a publication
// blind: after an unknown outcome the next action reads sync.json and the D1 pointer first. The cron `ensure` reconciles the
// R2 compatibility mirrors of the published D1 generation (idempotent, generation-fenced) and, separately, creates at most one
// Workflow instance per Madrid day and series; it does not download, step or publish. GET never repairs those mirrors.
// Discovery gets its intent from the existing commit-time handoff (queueDiscovery inside the completing step). Read model:
// readModel(). Contract: docs/reference/orchestration-reliability.md.
// Concatenated into the Worker like the other server modules: one global.
const EpgOrchestration=(()=>{
 const TABLE='epg_orchestration_document';
 const MODES=['external','switching','cloudflare'];
 const STEP_CAP=400,SLEEP_FLOOR_MS=1000,EXTERNAL_FRESH_MS=15*60000,LEASE_MS=5*60000,BOUNDARY_MARGIN_MS=15000,PAUSE_MS=6*3600000,CONTROL_ATTEMPTS=4,ALIVE=['running','waiting','queued','paused'],ENDED=['complete','errored','terminated','absent'];
 const STAGE_RANK={metadata:1,epg:2,seal:3,complete:4},SEAL_RANK={ledger:1,catalog:2,publish:3,finalize:4,queue:5};
 const iso=ms=>new Date(ms).toISOString();
 const policy=()=>OrchestrationPolicy;
 const schedule=()=>policy().EPG_SCHEDULE;
 const dayOf=ms=>policy().madridDayKey(ms);
 const instanceId=(runKey,series)=>'epg_'+String(runKey).replace(/-/g,'')+'_'+series;
 const emptyControl=()=>({schemaVersion:1,runKey:null,series:0,instanceId:null,epoch:null,phase:'idle',runId:null,checkpoint:null,budget:policy().emptyBudget(),cooldownUntil:null,quarantine:null,failure:null,lastDurableProgressAt:null,nextWakeAt:null,lastStep:null,publishedRunId:null,doneAt:null,updatedAt:null});
 const defaultMode=()=>({schemaVersion:1,mode:'external',target:null,epoch:0,drain:null});

 // ---- the two D1 documents ------------------------------------------------------------------------------------
 const noTable=error=>/no such table/i.test(String(error?.message||error));
 async function readDoc(env,key){
  if(typeof env?.DB?.prepare!=='function')return {schema:false,value:null,revision:null,stored:false,malformed:false};
  let row;
  try{row=await env.DB.prepare('SELECT body, revision FROM '+TABLE+' WHERE key=?').bind(key).first();}
  catch(error){if(noTable(error))return {schema:false,value:null,revision:null,stored:false,malformed:false};throw error;}
  if(!row)return {schema:true,value:null,revision:null,stored:false,malformed:false};
  try{return {schema:true,value:JSON.parse(row.body),revision:Number(row.revision),stored:true,malformed:false};}
  catch{return {schema:true,value:null,revision:Number(row.revision),stored:true,malformed:true};}
 }
 // One compare-and-set. `revision` null creates (refused if the key exists); a number replaces that revision only. `modeRevision`
 // (undefined: no condition) additionally requires the mode document to still be at that revision, null meaning absent.
 async function casDoc(env,key,revision,value,modeRevision){
  // Every write carries its own id, so the read-back below can tell this writer's document from an identical one of a competitor.
  const body=JSON.stringify({...value,writeId:crypto.randomUUID()}),now=iso(Date.now());
  const cond=modeRevision===undefined?['',[]]:modeRevision===null?[' AND NOT EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='mode')",[]]:[' AND EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='mode' AND revision=?)",[modeRevision]];
  const statement=revision===null
   ?env.DB.prepare('INSERT INTO '+TABLE+' (key, body, revision, updated_at) SELECT ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM '+TABLE+' WHERE key=?)'+cond[0]).bind(key,body,now,key,...cond[1])
   :env.DB.prepare('UPDATE '+TABLE+' SET body=?, revision=revision+1, updated_at=? WHERE key=? AND revision=?'+cond[0]).bind(body,now,key,revision,...cond[1]);
  await statement.run();
  // The write is judged by reading it back, one path for D1 and for the stand-in: the document is ours only if it now holds our
  // body at the next revision. A lost compare-and-set leaves the other writer's revision and body, and reports false.
  const row=await env.DB.prepare('SELECT body, revision FROM '+TABLE+' WHERE key=?').bind(key).first();
  return !!row&&row.body===body&&Number(row.revision)===(revision===null?1:revision+1);
 }
 async function readMode(env){
  const doc=await readDoc(env,'mode');
  if(!doc.schema)return {record:defaultMode(),revision:null,stored:false,schema:false,malformed:false};
  if(doc.value==null&&!doc.malformed)return {record:defaultMode(),revision:null,stored:false,schema:true,malformed:false};
  const v=doc.value;
  const ok=!doc.malformed&&v&&typeof v==='object'&&!Array.isArray(v)&&MODES.includes(v.mode)&&Number.isInteger(v.epoch)&&v.epoch>=0&&(v.mode!=='switching'||MODES.includes(v.target));
  return {record:ok?v:null,revision:doc.revision,stored:true,schema:true,malformed:!ok};
 }
 async function readControl(env){
  const doc=await readDoc(env,'control');
  if(doc.value==null&&!doc.malformed)return {record:emptyControl(),revision:doc.revision,stored:doc.stored,malformed:false};
  const v=doc.value;
  const ok=!doc.malformed&&v&&typeof v==='object'&&!Array.isArray(v)&&v.schemaVersion===1&&v.budget&&Number.isInteger(v.budget.consecutive)&&Number.isInteger(v.budget.total);
  return {record:ok?v:null,revision:doc.revision,stored:true,malformed:!ok};
 }
 const fencedEnv=(env,revision,step=null,trace=null)=>({...env,epgFence:{revision},...(step?{epgStep:step}:{}),...(trace?{epgTrace:trace}:{})});
 async function authorityState(env){
  if(typeof PublishedEpg==='undefined')return {ready:false,error:false};
  try{const a=await PublishedEpg.readAuthority(env);return {ready:a.ready===true,error:false};}
  catch{return {ready:false,error:true};}
 }
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
  const code=String(error?.code||''),message=String(error?.message||'');
  // AIR-444: a step lease that ran out is stopped exactly like any fence (unsafe, no retry) but under its own name; only a moved mode revision, a lost or
  // released lease or a published-generation fence is an epoch mismatch.
  if(code==='epg_step_fenced'&&error?.detail==='lease_expired')return 'step_lease_expired';
  if(code==='published_epg_fence'||code==='epg_step_fenced')return 'epoch_mismatch';
  if(code==='epg_step_unreadable')return 'd1_unavailable';
  if(code==='discovery_seal_unfinished')return 'evidence_contradictory';
  if(code==='published_epg_unavailable'||code==='write_contention')return 'd1_unavailable';
  if(code==='published_epg_not_authoritative')return 'authority_held';
  if(/abort|timed? ?out|timeout/i.test(String(error?.name||'')+' '+message))return 'timeout';
  if(/\b429\b|rate limit/i.test(message))return 'rate_limited';
  if(/\b5\d\d\b/.test(message)&&/(http|status|fetch|upstream)/i.test(message))return 'upstream_5xx';
  if(/exceeded (cpu|memory)/i.test(message))return /memory/i.test(message)?'exceeded_memory':'exceeded_cpu';
  if(/watchlist|letterboxd|epg source|fetch|network/i.test(message))return 'network_error';
  return 'step_failed';
 }


 // ---- the durable step lease ----------------------------------------------------------------------------------
 // One row, `lease`: {holder, kind, modeRevision, acquiredAt, expiresAt, released}. A step takes it before its first mutation, renews
 // it at each boundary while it is still the holder under the same mode revision, and releases it when it ends. The drain of the mode
 // switch refuses while it is live (or within the margin after its expiry), and an unreadable lease fails the drain closed.
 const leaseLive=(lease,now)=>!!lease&&lease.released!==true&&Number.isFinite(Date.parse(lease.expiresAt||''))&&Date.parse(lease.expiresAt)+BOUNDARY_MARGIN_MS>now;
 async function readLease(env){
  const doc=await readDoc(env,'lease');
  const v=doc.value;
  const ok=doc.value==null&&!doc.malformed?true:!doc.malformed&&v&&typeof v==='object'&&typeof v.holder==='string'&&Number.isFinite(Date.parse(v.expiresAt||''));
  return {record:doc.value==null?null:ok?v:null,revision:doc.revision,stored:doc.stored,malformed:!ok};
 }
 // The step takes the lease under the mode revision it was admitted with. Busy while another holder is live; a lost race is busy too.
 async function acquireStep(env,{kind,modeRevision,now=Date.now()}){
  const held=await readLease(env);
  if(held.malformed)return {busy:false,reason:'evidence_unreadable'};
  if(leaseLive(held.record,now))return {busy:true,until:Date.parse(held.record.expiresAt)+BOUNDARY_MARGIN_MS};
  const holder=crypto.randomUUID();
  const record={schemaVersion:1,holder,kind,modeRevision,acquiredAt:iso(now),expiresAt:iso(now+LEASE_MS),released:false};
  if(!await casDoc(env,'lease',held.stored?held.revision:null,record,modeRevision))return {busy:true,until:now+SLEEP_FLOOR_MS*5};
  return {step:{holder,kind,modeRevision}};
 }
 async function endStep(env,step){
  if(!step)return false;
  const held=await readLease(env);
  if(held.malformed||held.record?.holder!==step.holder)return false;
  return casDoc(env,'lease',held.revision,{...held.record,released:true,releasedAt:iso(Date.now())});
 }
 // The mutation boundary. A step that is not the holder, whose lease has run out, or whose mode revision has moved (the owner closed
 // admission) throws and the write does not happen. A live holder renews its lease when half of it is spent.
 async function assertStep(env,now=Date.now()){
  const step=env?.epgStep;
  if(!step)return;
  // `detail` says which check refused, so a lease that simply ran out is told apart from a real change of the mode revision (AIR-444).
  const fenced=(detail='mode')=>Object.assign(new Error('epg_step_fenced'),{code:'epg_step_fenced',detail});
  // A read that failed says nothing about the fence: the mutation is refused all the same (fail closed), but the executor classes it as a
  // transient D1 failure (cooldown and retry inside the instance), never as an epoch change that stops the instance for good.
  const unreadable=()=>Object.assign(new Error('epg_step_unreadable'),{code:'epg_step_unreadable'});
  // One read of the mode revision and the lease, judged completely: the mode revision, the holder, the release flag and the expiry
  // with its margin. Used for the first look and, if a renewal loses its compare-and-set, again for the second: never a partial check.
  async function look(){
   let row;
   try{row=await env.DB.prepare('SELECT (SELECT revision FROM '+TABLE+" WHERE key='mode') AS mode_revision, (SELECT body FROM "+TABLE+" WHERE key='lease') AS lease, (SELECT revision FROM "+TABLE+" WHERE key='lease') AS lease_revision").bind().first();}
   catch{throw unreadable();}
   let lease=null;try{lease=row?.lease?JSON.parse(row.lease):null;}catch{throw fenced();}
   const modeRevision=row?.mode_revision==null?null:Number(row.mode_revision);
   if(modeRevision!==(step.modeRevision??null))throw fenced();
   if(!lease||lease.holder!==step.holder||lease.released===true)throw fenced('lease_lost');
   const expires=Date.parse(lease.expiresAt||'');
   if(!Number.isFinite(expires)||now>=expires-BOUNDARY_MARGIN_MS)throw fenced('lease_expired');
   return {lease,expires,leaseRevision:Number(row.lease_revision)};
  }
  const seen=await look();
  // AIR-455: a diagnostic step carries a deadline (`epgDeadline`, ms since the epoch) that the guard enforces at every mutation boundary; production steps carry none.
  if(Number.isFinite(env.epgDeadline)&&now>=env.epgDeadline)throw Object.assign(new Error('epg_step_budget'),{code:'epg_step_budget'});
  if(seen.expires-now<LEASE_MS/2){
   // The renewal is conditioned on the mode revision in the same statement. If it does not land (the owner closed admission, another
   // writer touched the lease, a D1 error), the step re-judges everything from a fresh read and proceeds only if all of it still holds.
   const renewed=await casDoc(env,'lease',seen.leaseRevision,{...seen.lease,expiresAt:iso(now+LEASE_MS)},step.modeRevision??null).catch(()=>false);
   if(!renewed)await look();
  }
 }
 // The external path's admission: the gate and, when it passes, the lease. Returns the env the step must run with.
 async function beginExternalStep(env,now=Date.now()){
  const gate=await externalGate(env);
  if(gate.reason)return {reason:gate.reason};
  if(!gate.fence)return {env};
  const taken=await acquireStep(env,{kind:'external',modeRevision:gate.fence.revision,now});
  if(taken.reason)return {reason:taken.reason};
  if(taken.busy)return {reason:'step_in_progress',nextCatchUpAt:iso(taken.until)};
  return {env:{...env,epgFence:gate.fence,epgStep:taken.step},step:taken.step};
 }

 // ---- the owner's mode switch (ADR 0100 decision 3) ----------------------------------------------------------
 // Drain: the previous owner has no step in flight and no unfinished seal. Verified, not assumed.
 async function drainState(env,now){
  let run;
  try{run=await loadJSON(env,'sync.json');}catch{return 'unreadable';}
  if(run?.stage==='seal')return 'seal_unfinished';
  // The durable lease is the proof of an in-flight step; the age of sync.json is not (an unknown-outcome request can outlive it).
  let lease;
  try{lease=await readLease(env);}catch{return 'unreadable';}
  if(lease.malformed)return 'unreadable';
  if(leaseLive(lease.record,now))return 'step_lease_live';
  let control;
  try{control=await readControl(env);}catch{return 'unreadable';}
  if(control.malformed)return 'unreadable';
  if(control.record.instanceId&&['starting','running','waiting'].includes(control.record.phase)){
   const status=await instanceStatus(env.EPG_WORKFLOW,control.record.instanceId);
   if(status==='unknown')return 'unreadable';
   if(!ENDED.includes(status))return 'instance_live';
  }
  return 'verified';
 }
 async function switchMode(env,{action,target}={},now=Date.now()){
  for(let attempt=0;attempt<CONTROL_ATTEMPTS;attempt++){
   const mode=await readMode(env);
   if(!mode.schema)return {action,refused:'not_available'};
   if(mode.malformed)return {action,refused:'evidence_unreadable'};
   const current=mode.record;
   const write=record=>casDoc(env,'mode',mode.revision,record);
   if(action==='close_admission'){
    if(current.mode==='switching')return {action,refused:'switch_open',mode:current.mode,target:current.target,epoch:current.epoch};
    if(current.mode===target)return {action,refused:'already_in_mode',mode:current.mode,epoch:current.epoch};
    const next={schemaVersion:1,mode:'switching',from:current.mode,target,epoch:current.epoch+1,drain:null,changedAt:iso(now)};
    if(await write(next))return {action,closed:true,mode:'switching',target,epoch:next.epoch};
    continue;
   }
   if(action==='complete'){
    if(current.mode!=='switching')return {action,refused:'not_switching',mode:current.mode,epoch:current.epoch};
    const drain=await drainState(env,now);
    if(drain!=='verified'){
     if(current.drain!==drain)await write({...current,drain,drainCheckedAt:iso(now)});
     return {action,refused:'drain_not_verified',drain,mode:'switching',target:current.target,epoch:current.epoch};
    }
    const next={schemaVersion:1,mode:current.target,from:current.from,target:null,epoch:current.epoch,drain:'verified',changedAt:current.changedAt,completedAt:iso(now)};
    if(await write(next))return {action,completed:true,mode:next.mode,epoch:next.epoch,drain:'verified'};
    continue;
   }
   return {action,refused:'unknown_action'};
  }
  return {action,refused:'write_contention'};
 }
 async function clearQuarantine(env,now=Date.now()){
  const mode=await readMode(env);
  if(!mode.schema)return {action:'clear_quarantine',refused:'not_available'};
  if(mode.malformed)return {action:'clear_quarantine',refused:'evidence_unreadable'};
  if(mode.record.mode==='switching')return {action:'clear_quarantine',refused:'switch_in_progress'};
  for(let attempt=0;attempt<CONTROL_ATTEMPTS;attempt++){
   const control=await readControl(env);
   if(control.malformed)return {action:'clear_quarantine',refused:'evidence_unreadable'};
   if(!control.record.quarantine)return {action:'clear_quarantine',cleared:{control:false}};
   const next={...control.record,quarantine:null,failure:null,cooldownUntil:null,budget:policy().emptyBudget(),updatedAt:iso(now)};
   if(await casDoc(env,'control',control.stored?control.revision:null,next,mode.revision))return {action:'clear_quarantine',cleared:{control:true}};
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
  }catch(error){return {status:200,body:{action:body.action,refused:classifyThrown(error)==='step_failed'?'d1_unavailable':classifyThrown(error)}};}
 }
 // The external path's gate for /api/sync/start|metadata|epg and the MCP tools epg_sync_start and epg_sync_step: `switch_in_progress`
 // while admission is closed, `external_writer_fenced` once the switch to Cloudflare has completed, whatever an old Task prompt
 // sends. The table not applied means the executor does not exist: the external path is unchanged and carries no fence.
 async function externalGate(env){
  let mode;
  try{mode=await readMode(env);}catch{return {reason:'evidence_unreadable',fence:null};}
  if(!mode.schema)return {reason:null,fence:null};
  if(mode.malformed)return {reason:'evidence_unreadable',fence:null};
  if(mode.record.mode==='switching')return {reason:'switch_in_progress',fence:null};
  if(mode.record.mode==='cloudflare')return {reason:'external_writer_fenced',fence:null};
  return {reason:null,fence:{revision:mode.revision}};
 }

 // ---- admission and one executor action -----------------------------------------------------------------------
 async function admit(env,{runKey,series,epoch,id}){
  let mode;
  try{mode=await readMode(env);}catch(error){const code=classifyThrown(error);return {ok:false,reason:code==='step_failed'?'d1_unavailable':code,transient:true};}
  if(!mode.schema)return {ok:false,reason:'not_cloudflare'};
  if(mode.malformed)return {ok:false,reason:'evidence_unreadable',unsafe:true};
  if(mode.record.mode==='switching')return {ok:false,reason:'switch_in_progress'};
  if(mode.record.mode!=='cloudflare')return {ok:false,reason:'not_cloudflare'};
  if(mode.record.epoch!==epoch)return {ok:false,reason:'epoch_mismatch'};
  const authority=await authorityState(env);
  if(authority.error)return {ok:false,reason:'d1_unavailable',transient:true};
  if(!authority.ready)return {ok:false,reason:'authority_held',unsafe:true};
  let control;
  try{control=await readControl(env);}catch{return {ok:false,reason:'d1_unavailable',transient:true};}
  if(control.malformed)return {ok:false,reason:'checkpoint_malformed',unsafe:true};
  if(control.record.instanceId!==id||control.record.series!==series||control.record.runKey!==runKey)return {ok:false,reason:'not_owner'};
  return {ok:true,modeRevision:mode.revision,control:control.record,controlRevision:control.revision,controlStored:control.stored};
 }
 // The checkpoint of a sync run, as one comparable number: the stage, the metadata cursor and the seal phase only move forward.
 const checkpointKey=run=>run?[run.runId,run.stage,run.cursor??0,run.remaining??0,run.seal?.phase??''].join('|'):null;
 // AIR-420: inside the `ledger` phase the seal's own cursor counts too (as a share of the item total, below the next phase's
 // rank), so a seal that writes observations is durable progress and one that does not is not.
 const ledgerShare=seal=>{const total=Number(seal?.itemTotal),cursor=Number(seal?.cursor);return seal?.phase==='ledger'&&total>0&&cursor>0?Math.min(998,Math.floor(cursor/total*998)):0;};
 const progressCount=run=>run?(STAGE_RANK[run.stage]??0)*1000000+(run.stage==='metadata'?(run.cursor??0):0)+(run.stage==='seal'?(SEAL_RANK[run.seal?.phase]??0)*1000+ledgerShare(run.seal):0):0;
 const advanced=(run,previous)=>!!run&&!!previous&&previous.runId===run.runId&&progressCount(run)>(previous.count??0);
// AIR-464: the Madrid day a sync run was frozen for. `sync.json.runKey` (when the run carries one) and the frozen `startedAt` must both be
// well formed and agree; a missing legacy key falls back to `startedAt`, a malformed or contradicting key has no day (null, fail closed).
const DAY_KEY=/^\d{4}-\d{2}-\d{2}$/;
function frozenDay(run){
 if(!run||typeof run!=='object')return null;
 const at=Date.parse(run.startedAt),fromStart=Number.isFinite(at)?dayOf(at):null;
 if(fromStart===null)return null;
 if(run.runKey===undefined||run.runKey===null)return fromStart;
 if(typeof run.runKey!=='string'||!DAY_KEY.test(run.runKey)||fromStart!==run.runKey)return null;
 return run.runKey;
}
 async function body(response){try{return await response.json();}catch{return {};}}

 // The EPG work of one action: a start, or one existing step. Returns what happened and never swallows a write it may have made.
 async function drive(fe,control,{now}){
  const runKey=control.runKey;
  let run=await loadJSON(fe,'sync.json');
  const started=frozenDay(run);
  // Read-after-unknown: a run of this Madrid date that already completed is the success, whoever drove it.
  if(run?.stage==='complete'&&started===runKey&&!run.error)return {finished:true,runId:run.runId,run,published:run.runId};
  if(run&&run.stage==='seal'&&started===null)return {failure:{code:'evidence_contradictory'}};
  const usable=run&&(run.stage==='seal'||(['metadata','epg'].includes(run.stage)&&Number.isFinite(Date.parse(run.updatedAt||''))&&now-Date.parse(run.updatedAt)<EXTERNAL_FRESH_MS));
  if(!usable){
   const reply=await body(await postSync(fe,null,'/api/sync/start',{},'internal'));
   if(!reply.runId)return {failure:{code:'evidence_contradictory'}};
   return {runId:reply.runId,started:true,run:await loadJSON(fe,'sync.json')};
  }
  const path=run.stage==='metadata'?'/api/sync/metadata':'/api/sync/epg';
  const response=await postSync(fe,null,path,{runId:run.runId},'internal');
  const reply=await body(response);
  const after=await loadJSON(fe,'sync.json');
  const base={runId:run.runId,run:after,reply};
  if(response.status===409)return {...base,failure:{code:'owner_conflict'}};
  if(response.status>=400)return {...base,failure:{code:response.status===429?'rate_limited':response.status>=500?'upstream_5xx':'step_failed'}};
  const wait=reply.discovery?.state==='busy'||reply.state==='busy';
  if(wait){
   const until=Date.parse(reply.discovery?.nextCatchUpAt||reply.nextCatchUpAt||'');
   return {...base,wake:Number.isFinite(until)?until:now+SLEEP_FLOOR_MS*5,note:'busy'};
  }
  if(reply.reason==='programme_changed'||reply.discovery?.reason==='programme_changed')return {...base,failure:{code:'stale_generation_write'}};
  if(reply.state==='error'||reply.discovery?.state==='error')return {...base,failure:{code:'step_failed'}};
  if(reply.stage==='complete'||after?.stage==='complete'){
   // AIR-464: a run adopted from another Madrid day (ADR 0092 resume) publishes that day, not this control's day. Its completion never
   // certifies this control; the next action finds a complete run of another day, which is not usable, and starts this day's run.
   if(started!==runKey)return {...base,note:'foreign_run_sealed'};
   return {...base,finished:true,published:after?.runId||run.runId};
  }
  return base;
 }
 async function writeControl(env,adm,next){
  return casDoc(env,'control',adm.controlStored?adm.controlRevision:null,next,adm.modeRevision);
 }
 // One executor action: admit, plan, drive, commit the control record. Always returns a plain result.
 async function act(env,ctx){
  const {runKey,series,epoch,id}=ctx,now=ctx.now();
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
  const clock=ctx.clock||(()=>Date.now()),began=clock();
  // The action takes the step lease first: a step of another holder that is still live (a previous instance, an external step admitted
  // before the switch) is waited for, never raced.
  const taken=await acquireStep(env,{kind:'executor',modeRevision:adm.modeRevision,now}).catch(()=>({busy:true,until:now+policy().COOLDOWNS_MS[0]}));
  if(taken.reason)return {kind:'stop',reason:taken.reason};
  if(taken.busy)return {kind:'sleep',until:Math.max(taken.until,now+SLEEP_FLOOR_MS),reason:'step_lease_held'};
  const fe=fencedEnv(env,adm.modeRevision,taken.step,ctx.trace||null);
  let outcome;
  try{outcome=await drive(fe,control,{now});}
  catch(error){outcome={failure:{code:classifyThrown(error)}};}
  finally{await endStep(env,taken.step).catch(()=>false);}
  if(outcome.failure?.code==='epoch_mismatch'||outcome.failure?.code==='step_lease_expired')return {kind:'stop',reason:outcome.failure.code};
  // Commit. A thrown commit is not retried blind: the next action reads the control record and sync.json first.
  const key=outcome.run?checkpointKey(outcome.run):control.checkpoint?.key??null;
  const next={...control,runId:outcome.runId??control.runId,updatedAt:iso(now),nextWakeAt:outcome.wake?iso(outcome.wake):null,lastStep:{latencyMs:Math.max(0,clock()-began),started:outcome.started===true,note:outcome.note||null}};
  let result;
  if(outcome.failure){
   const {code,retryAfterAt}=outcome.failure,applied=policy().applyFailure(control.budget,{code},{now,phase:outcome.run?.stage??control.checkpoint?.phase??null,checkpoint:key,retryAfterAt:code==='rate_limited'?(retryAfterAt??now+PAUSE_MS):retryAfterAt,random:ctx.random});
   next.budget=applied.budget;next.cooldownUntil=applied.cooldownUntil;next.failure={class:policy().failureClass(code),code};
   next.checkpoint={key,phase:outcome.run?.stage??null,runId:outcome.run?.runId??null,count:progressCount(outcome.run)};
   if(applied.quarantine)next.quarantine={...applied.quarantine,at:iso(now)};
   result=applied.quarantine?{kind:'stop',reason:applied.quarantine.reason}:policy().failureClass(code)==='permanent'?{kind:'stop',reason:code}:{kind:'sleep',until:Date.parse(applied.cooldownUntil),reason:'cooldown'};
  }else{
   // Starting a run, an HTTP answer or a lease is not progress; a forward checkpoint or a completed run is.
   const progressed=outcome.finished===true||(outcome.started!==true&&advanced(outcome.run,control.checkpoint));
   if(progressed){next.budget=policy().applyProgress(control.budget);next.lastDurableProgressAt=iso(now);next.cooldownUntil=null;next.failure=null;}
   next.checkpoint={key,phase:outcome.run?.stage??null,runId:outcome.run?.runId??null,count:progressCount(outcome.run)};
   if(outcome.finished){next.doneAt=iso(now);next.phase='done';next.publishedRunId=outcome.published??null;}else next.phase=outcome.wake?'waiting':'running';
   result=outcome.finished?{kind:'stop',reason:'complete'}:outcome.wake?{kind:'sleep',until:outcome.wake,reason:outcome.note||'wait'}:{kind:'continue',reason:null};
  }
  let committed;
  try{committed=await writeControl(env,adm,next);}
  catch(error){return {kind:'sleep',until:now+policy().cooldownMs(1,ctx.random),reason:'d1_unavailable'};}
  if(!committed){
   const again=await admit(env,{runKey,series,epoch,id});
   if(!again.ok&&['epoch_mismatch','switch_in_progress','not_cloudflare'].includes(again.reason))return {kind:'stop',reason:again.reason};
   return {kind:'sleep',until:now+SLEEP_FLOOR_MS,reason:'write_conflict'};
  }
  return result;
 }

 // ---- the Workflow instance -----------------------------------------------------------------------------------
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
   const actStep=name('act');
   const result=await step.do(actStep,()=>tracedAct(env,ctx,actStep,hooks));
   if(result.kind==='stop'){
    await step.do(name('stopped'),()=>stopInstance(env,ctx,result.reason));
    return {stopped:true,reason:result.reason,instanceId:id};
   }
   if(result.kind==='sleep')await step.sleepUntil(name('sleep'),new Date(Math.max(result.until,ctx.now()+SLEEP_FLOOR_MS)));
  }
 }
 // AIR-462: one line when an `act-N` callback starts, one when it returns or throws. A callback killed by the platform leaves the enter line alone.
 // Every execution of the callback, a retry included, mints its own `attemptTraceId`; the id is a local correlator, not Cloudflare's attempt id.
 async function tracedAct(env,ctx,actStep,hooks={}){
  const trace={instanceId:ctx.id,actStep,attemptTraceId:hooks.traceId?hooks.traceId():crypto.randomUUID()};
  const log=(edge,fields={})=>{try{console.log(JSON.stringify({event:'epg_act',edge,at:new Date().toISOString(),runKey:/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.runKey))?ctx.runKey:null,...trace,...fields}));}catch{}};
  const began=Date.now();
  log('enter');
  try{
   let rejected=false;
   const result=await act(env,{...ctx,trace}).catch(()=>{rejected=true;return {kind:'sleep',until:ctx.now()+60000,reason:'act_failed'};});
   // A rejected action logs `error` and no `exit`; the recovery result below is unchanged.
   if(rejected)log('error',{elapsedMs:Date.now()-began});
   else log('exit',{elapsedMs:Date.now()-began,kind:['continue','sleep','stop'].includes(result?.kind)?result.kind:null});
   return result;
  }catch(error){log('error',{elapsedMs:Date.now()-began});throw error;}
 }
 async function stopInstance(env,ctx,reason){
  try{
   const adm=await admit(env,ctx);
   if(!adm.ok)return {recorded:false,reason:adm.reason};
   if(adm.control.doneAt||adm.control.quarantine)return {recorded:false,reason};
   const next={...adm.control,phase:'stopped',stopReason:reason,updatedAt:iso(ctx.now())};
   return {recorded:await writeControl(env,adm,next),reason};
  }catch{return {recorded:false,reason};}
 }

 // ---- published-generation compatibility mirrors (hourly, not GET) --------------------------------------------
 // R2 first, D1 marker last, under the published-EPG generation fence (`PublishedEpg.repairMirrors`). Aligned mirrors write
 // nothing. A live EPG step lease, a switching mode, an unreadable lease or a held cutover write nothing. Failures are
 // returned, not thrown, so the rest of the hourly tick (projector, Ratings, Discovery, Monitor) still runs.
 async function reconcileMirrors(env,{now=Date.now()}={}){
  if(typeof PublishedEpg?.repairMirrors!=='function')return {ran:false,reason:'unavailable'};
  try{
   const mode=await readMode(env);
   if(mode.schema&&mode.record?.mode==='switching')return {ran:false,reason:'switch_in_progress'};
  }catch{return {ran:false,reason:'mode_unreadable'};}
  try{
   const held=await readLease(env);
   if(held.malformed)return {ran:false,reason:'lease_unreadable'};
   if(leaseLive(held.record,now))return {ran:false,reason:'step_lease_live'};
  }catch{return {ran:false,reason:'lease_unreadable'};}
  try{
   const result=await PublishedEpg.repairMirrors(env);
   return {ran:true,mirrored:!!result?.mirrored,aligned:!!result?.aligned,wrote:!!result?.wrote,reason:result?.reason??(result?.aligned?'aligned':result?.mirrored?'written':'not_mirrored')};
  }catch(error){
   return {ran:true,mirrored:false,aligned:false,wrote:false,reason:error?.code||'error'};
  }
 }

 // ---- the cron `ensure` ---------------------------------------------------------------------------------------
 // Mirror reconcile on every hourly tick (even when the daily publication is not due), then at most a few reads and at
 // most one Workflow create. Safe under duplicate and overlapping firings: the control record is claimed by
 // compare-and-swap on the run key and series before the create, and a second create attaches to the same instance id.
 async function ensure(env,{now=Date.now(),random=Math.random}={}){
  const mirrors=await reconcileMirrors(env,{now});
  const result=await ensureWorkflow(env,{now,random});
  return {...result,mirrors};
 }
 async function ensureWorkflow(env,{now=Date.now(),random=Math.random}={}){
  let mode;
  try{mode=await readMode(env);}catch{return {started:false,reason:'mode_unreadable'};}
  if(!mode.schema)return {started:false,reason:'external'};
  if(mode.malformed)return {started:false,reason:'evidence_unreadable'};
  if(mode.record.mode==='switching')return {started:false,reason:'switch_in_progress'};
  if(mode.record.mode!=='cloudflare')return {started:false,reason:'external'};
  if(typeof env?.EPG_WORKFLOW?.create!=='function')return {started:false,reason:'workflow_unavailable'};
  const authority=await authorityState(env);
  if(authority.error)return {started:false,reason:'d1_unavailable'};
  if(!authority.ready)return {started:false,reason:'authority_held'};
  const {dayKey,due,dueAt}=policy().dailyDue(now,schedule());
  if(!due)return {started:false,reason:'not_due',dueAt:iso(dueAt)};
  let stored;
  try{stored=await readControl(env);}catch{return {started:false,reason:'d1_unavailable'};}
  if(stored.malformed)return {started:false,reason:'checkpoint_malformed'};
  let control=stored.record;
  if(control.quarantine?.scope==='domain')return {started:false,reason:'quarantined',scope:'domain'};
  let series=0,budget=policy().emptyBudget(),carry={};
  const write=(record)=>casDoc(env,'control',stored.stored?stored.revision:null,record,mode.revision);
  if(control.runKey===dayKey){
   if(control.doneAt)return {started:false,reason:'complete'};
   if(control.quarantine)return {started:false,reason:'quarantined',scope:'run'};
   const cooling=Date.parse(control.cooldownUntil||'');
   if(control.instanceId&&['starting','running','waiting'].includes(control.phase)){
    const status=await instanceStatus(env.EPG_WORKFLOW,control.instanceId);
    if(ALIVE.includes(status))return {started:false,reason:'in_progress',instanceId:control.instanceId};
    if(status==='unknown')return {started:false,reason:'status_unknown',instanceId:control.instanceId};
    const code=status==='errored'?'instance_errored':status==='absent'?'create_uncertain':'instance_terminated';
    const applied=policy().applyFailure(control.budget,{code},{now,phase:control.checkpoint?.phase??null,checkpoint:control.checkpoint?.key??null,random});
    control={...control,budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:'transient',code},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null,phase:'stopped',stopReason:code,updatedAt:iso(now)};
    if(!await write(control))return {started:false,reason:'write_conflict'};
    if(applied.quarantine)return {started:false,reason:'quarantined',scope:'run'};
    return {started:false,reason:'cooldown',until:applied.cooldownUntil,recorded:code};
   }
   if(Number.isFinite(cooling)&&cooling>now)return {started:false,reason:'cooldown',until:control.cooldownUntil};
   series=(control.series??0)+1;budget=control.budget;carry={failure:control.failure,lastDurableProgressAt:control.lastDurableProgressAt,runId:control.runId,checkpoint:control.checkpoint};
  }
  const id=instanceId(dayKey,series);
  const next={...emptyControl(),...carry,schemaVersion:1,runKey:dayKey,series,instanceId:id,epoch:mode.record.epoch,phase:'starting',budget,updatedAt:iso(now)};
  if(!await write(next))return {started:false,reason:'write_conflict'};
  try{
   await env.EPG_WORKFLOW.create({id,params:{runKey:dayKey,series,epoch:mode.record.epoch}});
   return {started:true,attached:false,instanceId:id,runKey:dayKey,series};
  }catch(error){
   if(createError(error)==='exists')return {started:true,attached:true,instanceId:id,runKey:dayKey,series};
   const status=await instanceStatus(env.EPG_WORKFLOW,id);
   if(ALIVE.includes(status)||status==='complete')return {started:true,attached:true,instanceId:id,runKey:dayKey,series};
   const applied=policy().applyFailure(budget,{code:'create_uncertain'},{now,random});
   const failed={...next,phase:'stopped',stopReason:'create_uncertain',budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:'transient',code:'create_uncertain'},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null};
   const reread=await readControl(env);
   if(reread.record?.instanceId===id)await casDoc(env,'control',reread.revision,failed,mode.revision);
   return {started:false,reason:'create_uncertain',instanceId:id};
  }
 }

 // ---- the read model. Reads only; never creates or repairs. ----------------------------------------------------
 async function readModel(env,now=Date.now()){
  const mode=await readMode(env);
  if(!mode.schema)return {mode:'external',available:false,epoch:0,runKey:null,published:null,phase:'idle',health:'external',sideEffects:'none'};
  if(mode.malformed)return {mode:null,available:true,health:'quarantined',failure:{class:'unsafe',code:'evidence_unreadable'},sideEffects:'none'};
  const control=await readControl(env);
  const m=mode.record,c=control.malformed?emptyControl():control.record;
  const {dayKey,dueAt}=policy().dailyDue(now,schedule());
  let run=null;
  try{run=await loadJSON(env,'sync.json');}catch{run=null;}
  const started=frozenDay(run);
  const doneToday=(c.runKey===dayKey&&!!c.doneAt)||(started===dayKey&&run?.stage==='complete'&&!run.error);
  let liveness=null;
  if(m.mode==='cloudflare'&&c.instanceId&&['starting','running','waiting'].includes(c.phase)&&typeof env?.EPG_WORKFLOW?.get==='function'){
   const status=await instanceStatus(env.EPG_WORKFLOW,c.instanceId);
   liveness=ALIVE.includes(status)?'alive':status==='complete'?'finished':status==='absent'?'absent':'unknown';
  }
  const sameKey=c.runKey===dayKey;
  const lastProgress=sameKey?c.lastDurableProgressAt:(run?.updatedAt||null);
  const health=control.malformed?'quarantined':policy().deriveHealth({now,dueAt,done:doneToday,quarantine:c.quarantine,permanent:c.failure?.class==='permanent'&&sameKey,cooldownUntil:sameKey?c.cooldownUntil:null,nextWakeAt:sameKey?c.nextWakeAt:null,lastDurableProgressAt:lastProgress,lateMs:m.mode==='cloudflare'?policy().EPG_LATE_MS:null});
  // AIR-420. The seal's real progress and the publication latency, from the run document and the control record only (no id of a
  // Film or an observation): the ledger cursor is what the last finished step wrote, so a long `seal/ledger` reads as a number that moves.
  const num=value=>Number.isFinite(Number(value))&&value!==null&&value!==undefined?Number(value):null;
  const seal=run?.stage==='seal'&&run.seal?{phase:run.seal.phase??null,ledgerPhase:run.seal.ledgerPhase??null,cursorItems:num(run.seal.cursor),itemTotal:num(run.seal.itemTotal),stagedAt:run.seal.stagedAt??null,updatedAt:run.updatedAt??null}:null;
  const doneAt=sameKey&&c.doneAt?Date.parse(c.doneAt):NaN;
  const publication=Number.isFinite(dueAt)?{dueAt:iso(dueAt),publishedAt:Number.isFinite(doneAt)?iso(doneAt):null,latencyMs:Number.isFinite(doneAt)?Math.max(0,doneAt-dueAt):null,overdueMs:!doneToday&&now>=dueAt?now-dueAt:null,targetMs:policy().EPG_LATE_MS}:null;
  return {mode:m.mode,available:true,epoch:m.epoch,...(m.mode==='switching'?{target:m.target,drain:m.drain||null}:{}),runKey:c.runKey,published:c.publishedRunId??null,phase:c.phase,
   owner:{kind:'workflow',instanceId:c.instanceId,liveness},lastDurableProgressAt:c.lastDurableProgressAt,dueAt:iso(dueAt),nextWakeAt:c.nextWakeAt||(now>=dueAt?null:iso(dueAt)),
   syncRun:run?{runId:run.runId,stage:run.stage,remaining:run.remaining??null,sealPhase:run.seal?.phase??null,updatedAt:run.updatedAt??null}:null,seal,publication,
   failure:{class:c.failure?.class??null,code:c.failure?.code??null,fingerprint:c.budget?.fingerprint??null,consecutive:c.budget?.consecutive??0,total:c.budget?.total??0,caps:policy().BUDGET_CAPS},
   cooldownUntil:c.cooldownUntil,quarantine:c.quarantine,lastStep:c.lastStep,health,sideEffects:'none'};
 }
 return {TABLE,LEASE_MS,BOUNDARY_MARGIN_MS,readLease,acquireStep,endStep,assertStep,beginExternalStep,instanceId,readMode,readControl,switchMode,clearQuarantine,handle,validate,externalGate,admit,act,run,ensure,reconcileMirrors,readModel,drainState,classifyThrown,checkpointKey,progressCount};
})();
async function runEpgWorkflow(env,payload,step){return EpgOrchestration.run(env,payload,step);}
