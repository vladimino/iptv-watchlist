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
 // The Worker version this code runs as (version metadata binding); null when absent or malformed. Inside a Workflow step it is the version
 // of the instance, which the controlled rollover compares with the deployed one. Never trusted beyond a short id.
 const workerVersion=env=>{try{const id=env?.CF_VERSION_METADATA?.id;return typeof id==='string'&&/^[0-9A-Za-z-]{1,64}$/.test(id)?id:null;}catch{return null;}};
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
 // `leaseRevision` (undefined: no condition) additionally requires the lease row to still be at that revision, null meaning absent: a step
 // that took or released the lease since the read moves that revision, so the write is refused (the controlled rollover uses it).
 async function casDoc(env,key,revision,value,modeRevision,leaseRevision){
  // Every write carries its own id, so the read-back below can tell this writer's document from an identical one of a competitor.
  const body=JSON.stringify({...value,writeId:crypto.randomUUID()}),now=iso(Date.now());
  const modeCond=modeRevision===undefined?['',[]]:modeRevision===null?[' AND NOT EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='mode')",[]]:[' AND EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='mode' AND revision=?)",[modeRevision]];
  const leaseCond=leaseRevision===undefined?['',[]]:leaseRevision===null?[' AND NOT EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='lease')",[]]:[' AND EXISTS (SELECT 1 FROM '+TABLE+" WHERE key='lease' AND revision=?)",[leaseRevision]];
  const cond=[modeCond[0]+leaseCond[0],[...modeCond[1],...leaseCond[1]]];
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
  // AIR-484: a control phase of `done` or `stopped` does not prove the Workflow ended (its last step may still run), so the status is read for any recorded instance.
  if(control.record.instanceId){
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
 function watchlistEventKey(event){
  if(!event||!Number.isFinite(Date.parse(event.at)))return null;
  return 'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';
 }
 async function journalOwed(fe,run){
  if(run?.epgEventPending||run?.watchlistEventPending)return true;
  if(Array.isArray(run?.watchlistRemovalFilms)&&run.watchlistRemovalFilms.length)return true;
  if(!run?.watchlistEventFixed)return false;
  const event=(run.events||[]).find(item=>item?.type==='watchlist');
  const key=watchlistEventKey(event);
  if(!key)return false;
  return !(await loadJSON(fe,key));
 }
 // AIR-525: a Ratings hand-over still owed by a complete run (removal references or lookups not yet handed to the ratings queue, or a
 // ratings attempt still open). The `/api/sync/epg` continuation of the same run hands them over (idempotently, under the current
 // Ratings gate); drive asks for one such step and then judges completion by the journal alone, so a gate that keeps them stays bounded.
 function handoverOwed(run){
  if(run?.stage!=='complete')return false;
  const refs=Array.isArray(run.removalRefs)?run.removalRefs:run.removalRefs?[run.removalRefs]:[];
  if(refs.some(item=>Array.isArray(item?.films)&&item.films.length&&item.ref))return true;
  if(Array.isArray(run.removalLookups)&&run.removalLookups.length)return true;
  return Array.isArray(run.ratingPending)&&run.ratingPending.length>0&&(!run.ratingAttempt||run.ratingAttempt.state==='started');
 }
 // AIR-525: a complete sync run is a success only on a proof, never on its stage alone: a completion receipt and the D1 published
 // pointer naming this very runId. The receipt is the AIR-518 one: `completedAt` when the record has the field (it must parse), else,
 // for a legacy record without the field, `updatedAt` only when no `error` is on the run. `run.error` on a complete run is the history of
 // an earlier attempt of the same runId (a seal unit that threw and a retry that completed) or of a tail that threw after the complete
 // record was saved; it never decides the outcome by itself. Results: `proven`; `unproven` (no valid receipt, another or no published
 // runId, authority not ready); `unreadable` (the authority read threw). Neither of the last two is a reason to start a second run.
 async function completion(env,run){
  if(run?.stage!=='complete')return {state:'none'};
  if(typeof run.runId!=='string'||!run.runId)return {state:'unproven'};
  const receipt=Object.prototype.hasOwnProperty.call(run,'completedAt')?run.completedAt:(run.error?null:run.updatedAt);
  if(typeof receipt!=='string'||!Number.isFinite(Date.parse(receipt)))return {state:'unproven'};
  if(typeof PublishedEpg==='undefined')return {state:'unreadable'};
  let authority;
  try{authority=await PublishedEpg.readAuthority(env);}catch{return {state:'unreadable'};}
  if(authority?.ready!==true||authority.programmeRunId!==run.runId)return {state:'unproven'};
  return {state:'proven',recovered:!!run.error};
 }
 const proofFailure=done=>done.state==='unreadable'?{code:'d1_unavailable'}:{code:'evidence_contradictory'};
 async function publishedEpgRun(fe,run){
  if(run?.stage!=='epg')return false;
  try{const published=await loadJSON(fe,'programme.json');return published?.runId===run.runId;}catch{return false;}
 }

 // The EPG work of one action: a start, or one existing step. Returns what happened and never swallows a write it may have made.
 async function drive(fe,control,{now}){
  const runKey=control.runKey;
  let run=await loadJSON(fe,'sync.json');
  const started=frozenDay(run);
  const owed=await journalOwed(fe,run);
  // AIR-464 / AIR-525: a sealed or complete run whose frozen day is malformed or contradicting has no day: fail closed, never start.
  if(run&&(run.stage==='seal'||run.stage==='complete')&&started===null)return {runId:run.runId??null,run,failure:{code:'evidence_contradictory'}};
  // AIR-525: a complete run of this Madrid date is judged by its completion proof (receipt and D1 pointer), never by its stage alone and
  // never by a prior attempt's `run.error`. A run of another day keeps the AIR-464 rule: it is never this control's success.
  const done=run?.stage==='complete'&&started===runKey?await completion(fe,run):{state:'none'};
  if(done.state==='unreadable'||done.state==='unproven')return {runId:run.runId,run,failure:proofFailure(done)};
  const handover=done.state==='proven'&&handoverOwed(run);
  // Read-after-unknown: a proven run of this Madrid date is the success, whoever drove it — unless an event or Ratings hand-over is still owed.
  if(done.state==='proven'&&!owed&&!handover)return {finished:true,runId:run.runId,run,published:run.runId,note:done.recovered?'recovered_complete':null};
  const fresh=run&&['metadata','epg'].includes(run.stage)&&Number.isFinite(Date.parse(run.updatedAt||''))&&now-Date.parse(run.updatedAt)<EXTERNAL_FRESH_MS;
  const usable=run&&(run.stage==='seal'||fresh||await publishedEpgRun(fe,run)||(done.state==='proven'&&(owed||handover))||(run.stage==='complete'&&started!==runKey&&!run.error&&owed));
  if(!usable){
   const reply=await body(await postSync(fe,null,'/api/sync/start',{},'internal'));
   if(!reply.runId)return {failure:{code:'evidence_contradictory'}};
   return {runId:reply.runId,started:true,run:await loadJSON(fe,'sync.json')};
  }
  // AIR-484: a durable `stage: seal` at its first phase that no control claim covers (the claim CAS or the reply was lost) is handed over
  // on restart; the producer never runs a seal unit. A run already past `ledger` is a legacy or claimed run and continues where it is.
  if(run.stage==='seal'&&run.seal?.phase==='ledger'&&started===runKey&&control.handoff?.sealRunId!==run.runId)return {runId:run.runId,run,sealed:true};
  const path=run.stage==='metadata'?'/api/sync/metadata':'/api/sync/epg';
  const response=await postSync(fe,null,path,{runId:run.runId},'internal');
  const reply=await body(response);
  const after=await loadJSON(fe,'sync.json');
  // AIR-484 / ADR 0144: this very action moved the run from the EPG stage into the seal. Only that observed transition hands the seal over.
  const base={runId:run.runId,run:after,reply,sealed:run.stage!=='seal'&&after?.stage==='seal'&&after.seal?.phase==='ledger'};
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
   if(await journalOwed(fe,after||run))return {...base,wake:now+policy().COOLDOWNS_MS[0],note:'journal_pending'};
   // AIR-525: the step that reached `complete` (or drained a complete run) certifies the control only on the completion proof.
   const proof=await completion(fe,after);
   if(proof.state!=='proven')return {...base,failure:proofFailure(proof)};
   return {...base,finished:true,published:after?.runId||run.runId,note:proof.recovered?'recovered_complete':null};
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
   // AIR-520: a replayed `act-N` of the old series finds the claim it committed itself (the platform lost the step result after the D1 CAS).
   if(adm.reason==='not_owner'){const orphan=await recoverOrphanClaim(env,{runKey,series,epoch,now,random:ctx.random});if(orphan)return orphan;}
   return {kind:'stop',reason:adm.reason};
  }
  const control=adm.control;
  if(control.doneAt)return {kind:'stop',reason:'complete'};
  if(control.quarantine)return {kind:'stop',reason:'quarantined'};
  // AIR-484: a successor that holds the claim of an unfinished seal finishes it after midnight; any other instance of a rolled day stops.
  if(dayOf(now)!==runKey&&!(await sealClaimPending(env,control)).pending)return {kind:'stop',reason:'day_rolled'};
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
  const next={...control,runId:outcome.runId??control.runId,updatedAt:iso(now),...(workerVersion(env)?{versionId:workerVersion(env)}:{}),nextWakeAt:outcome.wake?iso(outcome.wake):null,lastStep:{latencyMs:Math.max(0,clock()-began),started:outcome.started===true,note:outcome.note||null}};
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
   // AIR-484 / ADR 0144 part A: the durable `stage: seal` was read back by `drive`. The claim names the next series and is written before
   // the successor is created; a normal hand-off is progress, never a failure, and this instance takes no further step lease.
   if(outcome.sealed&&!outcome.finished&&!outcome.wake&&outcome.runId){
    const toSeries=series+1;
    next.handoff={sealRunId:outcome.runId,fromSeries:series,toSeries,at:iso(now)};
    next.series=toSeries;next.instanceId=instanceId(runKey,toSeries);next.phase='starting';next.nextWakeAt=null;
    result={kind:'handoff',runKey,series:toSeries,epoch};
   }
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
   const result=await step.do(actStep,callback=>tracedAct(env,ctx,actStep,hooks,callback?.attempt));
   // AIR-522: the callback's own `exit` line proves only that it returned. This line is written outside `step.do`, after it resolved to this
   // Workflow execution. A present line proves that much and nothing more; it can repeat when the engine replays the Workflow, and an absent line
   // is inconclusive on its own (log delivery can be lost). Conclude nothing about persistence without the attempt history and a read of durable state.
   storedLog(ctx,actStep,result);
   if(result.kind==='stop'){
    await step.do(name('stopped'),()=>stopInstance(env,ctx,result.reason));
    return {stopped:true,reason:result.reason,instanceId:id};
   }
   if(result.kind==='handoff'){
    const created=await step.do(name('handoff'),async()=>{
     const made=await createSuccessor(env,result);
     // AIR-520: an unproven create is recorded (budget, cooldown, visible failure), never left looking like progress.
     if(made.uncertain)await noteCreateUncertain(env,{...result,status:made.status,now:ctx.now(),random:ctx.random}).catch(()=>false);
     return made;
    });
    return {stopped:true,reason:'seal_handoff',instanceId:id,successor:created?.id??null};
   }
   if(result.kind==='sleep')await step.sleepUntil(name('sleep'),new Date(Math.max(result.until,ctx.now()+SLEEP_FLOOR_MS)));
  }
 }
// AIR-484 / ADR 0144: is a seal claimed by this control record still unfinished? A claim is pending while `sync.json` holds the
 // claimed run at `stage: seal`. An unreadable run document is reported, never read as "no claim".
 async function sealClaimPending(env,control){
  const claimed=control?.handoff?.sealRunId;
  if(typeof claimed!=='string'||!claimed||control.doneAt)return {pending:false};
  let run;
  try{run=await loadJSON(env,'sync.json');}catch{return {pending:false,unreadable:true};}
  return {pending:run?.runId===claimed&&run.stage==='seal',run};
 }
 // The successor of a hand-off. An id that already exists is an attach; an unknown outcome is read back before anything is concluded and,
 // when it stays unproven, left to the hourly `ensure`, which recovers by the observed status. A terminal id is never created again.
 async function createSuccessor(env,{runKey,series,epoch}){
  const id=instanceId(runKey,series);
  try{await env.EPG_WORKFLOW.create({id,params:{runKey,series,epoch}});return {created:true,id};}
  catch(error){
   if(createError(error)==='exists')return {attached:true,id};
   const status=await instanceStatus(env.EPG_WORKFLOW,id);
   if(ALIVE.includes(status)||status==='complete')return {attached:true,id};
   return {uncertain:true,id,status};
  }
 }
 // AIR-520: the claim CAS of a hand-off committed (`series+1`, `phase=starting`, `handoff.fromSeries=series`) but the result of `act-N` never
 // became durable, so the retry of the old series reads `not_owner` and would stop without a successor (17 Nov 2026). The old instance may
 // create exactly the successor its own committed claim names, and only when every predicate below holds against a fresh read; any other
 // reading changes nothing and keeps the former `not_owner` stop. It runs once per replay (no loop) and writes nothing unless the create is unproven.
 async function recoverOrphanClaim(env,{runKey,series,epoch,now,random}){
  let stored;
  try{stored=await readControl(env);}catch{return null;}
  if(stored.malformed)return null;
  const c=stored.record,h=c.handoff,next=series+1;
  if(!h||c.runKey!==runKey||c.series!==next||h.fromSeries!==series||h.toSeries!==next||c.instanceId!==instanceId(runKey,next))return null;
  if(c.phase!=='starting'||c.doneAt||c.quarantine)return null;
  const cooling=Date.parse(c.cooldownUntil||'');
  if(Number.isFinite(cooling)&&cooling>now)return null;
  const claim=await sealClaimPending(env,c);
  if(!claim.pending)return null;
  const status=await instanceStatus(env.EPG_WORKFLOW,c.instanceId);
  if(status==='unknown'){await noteCreateUncertain(env,{runKey,series:next,epoch,now,random,status}).catch(()=>false);return null;}
  if(status!=='absent')return null;
  // Same id, same params as the claim; an existing id attaches. The `handoff` step of the caller performs the idempotent create.
  return {kind:'handoff',runKey,series:next,epoch,recovered:true};
 }
 // A claimed successor whose create or status stays unproven: counted under the budget with a cooldown, phase kept `starting`, so the
 // read model and the hourly `ensure` see a failure and not a silent wait. `stopReason` follows what `ensureWorkflow` guards: `status_unknown`
 // (unreadable status, honoured before the status read) or `create_uncertain` (absent child, honoured by the absent guard), so a repeated ensure inside
 // the cooldown spends no further budget. A moved control record writes nothing.
 async function noteCreateUncertain(env,{runKey,series,epoch,now,random,status}){
  const mode=await readMode(env);
  if(!mode.schema||mode.malformed||mode.record.mode!=='cloudflare'||mode.record.epoch!==epoch)return false;
  const stored=await readControl(env);
  if(stored.malformed)return false;
  const c=stored.record;
  if(c.runKey!==runKey||c.series!==series||c.phase!=='starting'||c.doneAt||c.quarantine||!c.handoff)return false;
  const applied=policy().applyFailure(c.budget,{code:'create_uncertain'},{now,phase:c.checkpoint?.phase??null,checkpoint:c.checkpoint?.key??null,random});
  const record={...c,budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:policy().failureClass('create_uncertain'),code:'create_uncertain'},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null,stopReason:status==='unknown'?'status_unknown':'create_uncertain',updatedAt:iso(now)};
  return casDoc(env,'control',stored.stored?stored.revision:null,record,mode.revision);
 }
 // AIR-462: one line when an `act-N` callback starts, one when it returns or throws. A callback killed by the platform leaves the enter line alone.
 // Every execution of the callback, a retry included, mints its own `attemptTraceId`; the id is a local correlator, not Cloudflare's attempt id.
 async function tracedAct(env,ctx,actStep,hooks={},attempt=undefined){
  // AIR-522: `attempt` is the platform's own 1-based attempt number of this step (the callback context), logged only when it is a small integer.
  const trace={instanceId:ctx.id,actStep,attemptTraceId:hooks.traceId?hooks.traceId():crypto.randomUUID()};
  const log=(edge,fields={})=>{try{console.log(JSON.stringify({event:'epg_act',edge,at:new Date().toISOString(),runKey:/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.runKey))?ctx.runKey:null,...trace,...(Number.isSafeInteger(attempt)&&attempt>=1&&attempt<=99?{attempt}:{}),...fields}));}catch{}};
  const began=Date.now();
  log('enter');
  try{
   let rejected=false;
   const result=await act(env,{...ctx,trace}).catch(()=>{rejected=true;return {kind:'sleep',until:ctx.now()+60000,reason:'act_failed'};});
   // A rejected action logs `error` and no `exit`; the recovery result below is unchanged.
   if(rejected)log('error',{elapsedMs:Date.now()-began});
   else log('exit',{elapsedMs:Date.now()-began,kind:['continue','sleep','stop','handoff'].includes(result?.kind)?result.kind:null});
   return result;
  }catch(error){log('error',{elapsedMs:Date.now()-began});throw error;}
 }
 // AIR-522: a best-effort marker written outside `step.do` after it resolved; it may repeat on replay and is not a receipt. A closed set of fields; never throws.
 function storedLog(ctx,actStep,result){
  try{console.log(JSON.stringify({event:'epg_act_stored',at:new Date().toISOString(),runKey:/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.runKey))?ctx.runKey:null,instanceId:ctx.id,actStep,kind:['continue','sleep','stop','handoff'].includes(result?.kind)?result.kind:null}));}catch{}
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

 // ---- the completion certificate repair (ADR 0175 decision 5) -------------------------------------------------
 // A separate certify-only unit, called from the hourly `ensure`. It is NOT routed through ensureWorkflow, act or drive, whose gates (`not_due`, `control.doneAt`,
 // `day_rolled`) decide whether to schedule or drive a RUN and correctly refuse a finished or rolled one. It never creates a Workflow instance, runs a seal, a sync or a
 // publication, and never writes `control`, `sync.json`, the completion receipt or R2. Its only D1 write is the one fenced certify batch (step lease, mode revision, CAS on the
 // pointer's programme run and Madrid day, atomic pause clear), followed by a readback. Anything stale, contradicting or unreadable does nothing.
 async function owedCertificate(env){
  let run;
  try{run=await loadJSON(env,'sync.json');}catch{return {owed:false,reason:'sync_unreadable'};}
  if(!run||run.stage!=='complete'||typeof run.runId!=='string'||!run.runId)return {owed:false,reason:'not_owed'};
  const day=frozenDay(run);
  if(day===null)return {owed:false,reason:'day_unproven'};
  const proof=await completion(env,run);
  if(proof.state==='unreadable')return {owed:false,reason:'d1_unavailable'};
  if(proof.state!=='proven')return {owed:false,reason:'not_owed'};
  let certificate;
  try{certificate=await PublishedEpg.readCertificate(env);}catch{return {owed:false,reason:'d1_unavailable'};}
  if(certificate.column!=='present')return {owed:false,reason:'column_absent'};
  if(certificate.programmeRunId!==run.runId||certificate.madridRunKey!==day)return {owed:false,reason:'not_owed'};
  if(certificate.finalizedRunId===run.runId)return {owed:false,reason:'certified'};
  return {owed:true,runId:run.runId,day};
 }
 async function certifyComplete(env,{now=Date.now()}={}){
  if(typeof PublishedEpg?.certifyRun!=='function'||typeof PublishedEpg?.readCertificate!=='function')return {ran:false,reason:'unavailable'};
  let mode;
  try{mode=await readMode(env);}catch{return {ran:false,reason:'mode_unreadable'};}
  if(!mode.schema||mode.malformed||mode.record?.mode!=='cloudflare')return {ran:false,reason:'not_owed'};
  // The cheap, lease-free check first: a run that needs nothing never takes the step lease.
  const first=await owedCertificate(env);
  if(!first.owed)return {ran:false,reason:first.reason};
  let taken;
  try{taken=await acquireStep(env,{kind:'certify',modeRevision:mode.revision,now});}catch{return {ran:false,reason:'lease_unreadable'};}
  if(taken.reason)return {ran:false,reason:taken.reason};
  if(taken.busy)return {ran:false,reason:'step_lease_held',until:iso(taken.until)};
  const fe=fencedEnv(env,mode.revision,taken.step);
  try{
   // The world may have changed between the cheap check and the lease: the same check again, now holding it.
   const second=await owedCertificate(fe);
   if(!second.owed)return {ran:false,reason:second.reason};
   const stamp=Date.now();
   const out=await PublishedEpg.certifyRun(fe,{programmeRunId:second.runId,madridRunKey:second.day,step:taken.step,epgFence:fe.epgFence,leaseBound:iso(stamp+BOUNDARY_MARGIN_MS),now:stamp});
   return {ran:true,certified:out.certified===true,reason:out.certified?'certified':'readback_mismatch',runId:second.runId};
  }catch(error){
   return {ran:true,certified:false,reason:error?.code||'error'};
  }finally{await endStep(env,taken.step).catch(()=>false);}
 }

 // ---- the cron `ensure` ---------------------------------------------------------------------------------------
 // Mirror reconcile on every hourly tick (even when the daily publication is not due), then at most a few reads and at
 // most one Workflow create. Safe under duplicate and overlapping firings: the control record is claimed by
 // compare-and-swap on the run key and series before the create, and a second create attaches to the same instance id.
 async function ensure(env,{now=Date.now(),random=Math.random}={}){
  const mirrors=await reconcileMirrors(env,{now});
  const result=await ensureWorkflow(env,{now,random});
  // ADR 0175: the certificate repair, after the Workflow reconcile. Reported only when it ran or waited for a live step lease: an idle tick keeps the result unchanged.
  let certificate=null;
  try{certificate=await certifyComplete(env,{now});}catch(error){certificate={ran:false,reason:error?.code||'error'};}
  let producer={ran:false,reason:'unavailable'};
  try{
   if(typeof CanonicalProducerWorkflow!=='undefined'&&typeof CanonicalProducerWorkflow.reconcileProducerChain==='function'){
    producer=await CanonicalProducerWorkflow.reconcileProducerChain(env,{now});
   }
  }catch(error){producer={ran:false,reason:error?.code||'error'};}
  return {...result,mirrors,...(certificate&&(certificate.ran===true||certificate.reason==='step_lease_held')?{certificate}:{}),producer};
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
  let stored;
  // AIR-484: before today's start is even considered, a claimed seal that is still unfinished (of any Madrid day) is recovered first.
  // The control record is read before the due check only to look for a claim; without one the not-due answer is unchanged.
  try{stored=await readControl(env);}catch{return due?{started:false,reason:'d1_unavailable'}:{started:false,reason:'not_due',dueAt:iso(dueAt)};}
  if(stored.malformed)return due?{started:false,reason:'checkpoint_malformed'}:{started:false,reason:'not_due',dueAt:iso(dueAt)};
  let control=stored.record;
  const claimState=control.handoff?await sealClaimPending(env,control):{pending:false};
  if(claimState.unreadable)return {started:false,reason:'evidence_unreadable'};
  const claim=claimState.pending?control.runKey:null;
  if(!due&&!claim)return {started:false,reason:'not_due',dueAt:iso(dueAt)};
  if(control.quarantine?.scope==='domain')return {started:false,reason:'quarantined',scope:'domain'};
  const runKey=claim??dayKey;
  let series=0,budget=policy().emptyBudget(),carry={};
  const write=(record)=>casDoc(env,'control',stored.stored?stored.revision:null,record,mode.revision);
  if(claim||control.runKey===dayKey){
   if(control.doneAt)return {started:false,reason:'complete'};
   if(control.quarantine)return {started:false,reason:'quarantined',scope:'run'};
   const cooling=Date.parse(control.cooldownUntil||'');
   if(control.instanceId&&['starting','running','waiting'].includes(control.phase)){
    if(claim&&control.stopReason==='status_unknown'&&Number.isFinite(cooling)&&cooling>now)return {started:false,reason:'cooldown',until:control.cooldownUntil};
    const status=await instanceStatus(env.EPG_WORKFLOW,control.instanceId);
    if(ALIVE.includes(status))return {started:false,reason:'in_progress',instanceId:control.instanceId};
    if(status==='unknown'){
     if(!claim)return {started:false,reason:'status_unknown',instanceId:control.instanceId};
     // A claimed seal must not stay silently unobserved: persistent uncertainty is counted under the budget and fails closed at quarantine.
     const applied=policy().applyFailure(control.budget,{code:'create_uncertain'},{now,phase:control.checkpoint?.phase??null,checkpoint:control.checkpoint?.key??null,random});
     control={...control,budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:policy().failureClass('create_uncertain'),code:'create_uncertain'},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null,stopReason:'status_unknown',updatedAt:iso(now)};
     if(!await write(control))return {started:false,reason:'write_conflict'};
     if(applied.quarantine)return {started:false,reason:'quarantined',scope:'run'};
     return {started:false,reason:'status_unknown',instanceId:control.instanceId,until:applied.cooldownUntil};
    }
    // A controlled rollover swapped the control record to its successor but the create never landed: the same id is created (idempotent) or
    // attached. It is not a failure of the run, so it spends no budget.
    if(status==='absent'&&control.phase==='starting'&&control.rollover?.toInstanceId===control.instanceId&&control.epoch===mode.record.epoch){
     const created=await createSuccessor(env,{runKey:control.runKey,series:control.series,epoch:mode.record.epoch});
     if(created.uncertain)return {started:false,reason:'create_uncertain',instanceId:control.instanceId};
     return {started:true,attached:!created.created,instanceId:control.instanceId,runKey:control.runKey,series:control.series,recovered:'rollover'};
    }
    // A claimed seal whose successor reports `complete` while sync.json still says `seal` is contradictory evidence: fail closed.
    const code=claim&&status==='complete'?'evidence_contradictory':status==='errored'?'instance_errored':status==='absent'?'create_uncertain':'instance_terminated';
    if(claim&&status==='absent'&&Number.isFinite(cooling)&&cooling>now)return {started:false,reason:'cooldown',until:control.cooldownUntil};
    const applied=policy().applyFailure(control.budget,{code},{now,phase:control.checkpoint?.phase??null,checkpoint:control.checkpoint?.key??null,random});
    const keepStarting=claim&&status==='absent';
    control={...control,budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:policy().failureClass(code),code},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null,phase:keepStarting?'starting':'stopped',stopReason:code,updatedAt:iso(now)};
    if(!await write(control))return {started:false,reason:'write_conflict'};
    if(code==='evidence_contradictory')return {started:false,reason:'evidence_contradictory',instanceId:control.instanceId};
    if(applied.quarantine)return {started:false,reason:'quarantined',scope:'run'};
    if(keepStarting){
     // The claim names this id already: the same id is created (idempotent) or attached, never a new one for a create that never landed.
     const created=await createSuccessor(env,{runKey,series:control.series,epoch:mode.record.epoch});
     if(created.uncertain)return {started:false,reason:'create_uncertain',instanceId:control.instanceId};
     return {started:true,attached:!created.created,instanceId:control.instanceId,runKey,series:control.series};
    }
    return {started:false,reason:'cooldown',until:applied.cooldownUntil,recorded:code};
   }
   if(Number.isFinite(cooling)&&cooling>now)return {started:false,reason:'cooldown',until:control.cooldownUntil};
   series=(control.series??0)+1;budget=control.budget;carry={failure:control.failure,lastDurableProgressAt:control.lastDurableProgressAt,runId:control.runId,checkpoint:control.checkpoint,...(claim?{handoff:{...control.handoff,toSeries:series}}:{})};
  }
  const id=instanceId(runKey,series);
  const next={...emptyControl(),...carry,schemaVersion:1,runKey,series,instanceId:id,epoch:mode.record.epoch,phase:'starting',budget,updatedAt:iso(now)};
  if(!await write(next))return {started:false,reason:'write_conflict'};
  try{
   await env.EPG_WORKFLOW.create({id,params:{runKey,series,epoch:mode.record.epoch}});
   return {started:true,attached:false,instanceId:id,runKey,series};
  }catch(error){
   if(createError(error)==='exists')return {started:true,attached:true,instanceId:id,runKey,series};
   const status=await instanceStatus(env.EPG_WORKFLOW,id);
   if(ALIVE.includes(status)||status==='complete')return {started:true,attached:true,instanceId:id,runKey,series};
   const applied=policy().applyFailure(budget,{code:'create_uncertain'},{now,random});
   const failed={...next,phase:'stopped',stopReason:'create_uncertain',budget:applied.budget,cooldownUntil:applied.cooldownUntil,failure:{class:'transient',code:'create_uncertain'},quarantine:applied.quarantine?{...applied.quarantine,at:iso(now)}:null};
   const reread=await readControl(env);
   if(reread.record?.instanceId===id)await casDoc(env,'control',reread.revision,failed,mode.revision);
   return {started:false,reason:'create_uncertain',instanceId:id};
  }
 }

 // ---- the controlled rollover onto the deployed Worker version (owner-only MCP tool `epg_workflow_rollover`) ------
 // A running Workflow instance keeps the version it was created on. The rollover hands the control record to the deterministic successor
 // (`series + 1`) of the SAME run key, epoch and run, by one compare-and-set of the control document, conditioned on the mode revision and on
 // the step lease row being unchanged since the read. It is admitted only for an owner that is provably asleep outside a step. The old
 // instance finds `not_owner` on its next wake and stops without a write (its orphan-claim recovery needs a claim naming itself, which a
 // rollover never writes). Nothing here resets a lease, a budget, a cooldown or a quarantine, publishes, or terminates a platform instance.
 const ROLLOVER_WAKE_MARGIN_MS=120000,ROLLOVER_REQUEST_ID=/^[A-Za-z0-9_-]{8,64}$/;
 const ROLLOVER_PINS=[['expectedRunKey','runKey'],['expectedEpoch','epoch'],['expectedSeries','series'],['expectedInstanceId','instanceId'],['expectedRunId','runId'],['expectedControlRevision','controlRevision']];
 // Reads only. Every unreadable or ambiguous fact is an `unknown`, every unsafe one a `blocker`; only a clean read of both lists empty is `eligible`.
 async function rolloverPreflight(env,now=Date.now()){
  const unknowns=[],blockers=[],facts={now:iso(now)};
  const deployed=workerVersion(env);facts.deployedVersionId=deployed;
  if(!deployed)unknowns.push('deployed_version_unavailable');
  if(typeof env?.EPG_WORKFLOW?.get!=='function')unknowns.push('workflow_binding_unavailable');
  let mode=null,control=null,lease=null,run,authority=null,status='unknown';
  try{mode=await readMode(env);}catch{unknowns.push('mode_unreadable');}
  try{control=await readControl(env);}catch{unknowns.push('control_unreadable');}
  try{lease=await readLease(env);}catch{unknowns.push('lease_unreadable');}
  try{run=await loadJSON(env,'sync.json');}catch{unknowns.push('sync_unreadable');run=undefined;}
  authority=await authorityState(env);if(authority.error)unknowns.push('authority_unreadable');
  if(mode){
   if(!mode.schema)blockers.push('not_cloudflare');
   else if(mode.malformed)unknowns.push('mode_malformed');
   else if(mode.record.mode==='switching')blockers.push('switch_in_progress');
   else if(mode.record.mode!=='cloudflare')blockers.push('not_cloudflare');
  }
  if(control?.malformed)unknowns.push('control_malformed');
  if(lease?.malformed)unknowns.push('lease_unreadable');
  const c=control&&!control.malformed?control.record:null;
  facts.control=c?{runKey:c.runKey,series:c.series,instanceId:c.instanceId,epoch:c.epoch,phase:c.phase,runId:c.runId,revision:control.revision,stored:control.stored,versionId:c.versionId??null,nextWakeAt:c.nextWakeAt,cooldownUntil:c.cooldownUntil,consecutive:c.budget?.consecutive??null,total:c.budget?.total??null}:null;
  if(c){
   if(!control.stored||!c.instanceId||!c.runKey)blockers.push('no_owner');
   if(c.doneAt)blockers.push('complete');
   if(c.quarantine)blockers.push('quarantined');
   if(mode&&mode.record&&c.epoch!==mode.record.epoch&&c.instanceId)blockers.push('epoch_mismatch');
   if(c.phase==='starting')blockers.push('successor_not_started');
   if(c.instanceId&&env?.EPG_WORKFLOW?.get)status=await instanceStatus(env.EPG_WORKFLOW,c.instanceId);
   facts.platformStatus=status;
   if(status==='unknown')unknowns.push('instance_status_unknown');
   else if(c.instanceId&&!['running','waiting'].includes(status))blockers.push('owner_not_alive');
   // The proof of a sleep outside a step: a durable wake time well in the future. `waiting` carries it in nextWakeAt, a cooldown in cooldownUntil;
   // a `running` record with neither is an owner that continues at once.
   const wake=Math.max(Date.parse(c.nextWakeAt||'')||0,Date.parse(c.cooldownUntil||'')||0);
   const sleeping=(c.phase==='waiting'||c.phase==='running')&&wake>0;
   facts.sleepsUntil=wake>0?iso(wake):null;
   if(c.phase!=='starting'){
    if(!sleeping||wake<=now)blockers.push('owner_not_sleeping');
    else if(wake-now<ROLLOVER_WAKE_MARGIN_MS)blockers.push('wake_too_soon');
   }
   const ownerDay=policy().madridDayKey(now);
   const claim=c.handoff?await sealClaimPending(env,c):{pending:false};
   if(claim.unreadable)unknowns.push('sync_unreadable');
   if(c.runKey&&ownerDay!==c.runKey&&!claim.pending)blockers.push('day_rolled');
   if(run!==undefined){
    facts.syncRun=run?{runId:run.runId??null,stage:run.stage??null,sealPhase:run.seal?.phase??null,key:checkpointKey(run)}:null;
    if(run&&run.stage==='seal'&&c.handoff?.sealRunId!==run.runId)blockers.push('seal_unclaimed');
    if(run&&c.runId&&run.runId!==c.runId&&run.stage!=='complete')blockers.push('run_mismatch');
   }
  }
  if(lease&&!lease.malformed){
   facts.lease={live:leaseLive(lease.record,now),revision:lease.stored?lease.revision:null};
   if(facts.lease.live)blockers.push('lease_live');
  }
  if(!authority.error&&!authority.ready)blockers.push('authority_held');
  facts.modeRevision=mode&&!mode.malformed&&mode.schema?mode.revision:null;
  const alive=c&&c.instanceId&&['running','waiting','queued'].includes(status);
  const current=!!deployed&&!!c&&c.versionId===deployed;
  let decision;
  if(unknowns.length)decision='unknown';
  else if(alive&&current&&!blockers.some(b=>['not_cloudflare','switch_in_progress','no_owner','complete','quarantined'].includes(b)))decision='already_current';
  else decision=blockers.length?'unsafe':'eligible';
  const expect=c&&c.instanceId?{runKey:c.runKey,epoch:c.epoch,series:c.series,instanceId:c.instanceId,runId:c.runId??null,controlRevision:control.revision}:null;
  return {decision,blockers:[...new Set(blockers)],unknowns:[...new Set(unknowns)],expect,facts,raw:{mode,control,lease,c,status,run,authority}};
 }
 const rolloverView=pre=>{const {raw,...view}=pre;return view;};
 const rolloverLog=(outcome,fields={})=>{try{console.log(JSON.stringify({event:'epg_workflow_rollover',outcome,at:new Date().toISOString(),...fields}));}catch{}};
 // What a read of the control record says after an apply: the record names the successor and only it, the platform reports it alive, the run and
 // its checkpoint are the ones before the swap, the budget is unchanged. The version is confirmed only once the successor has recorded its own.
 async function rolloverReadback(env,receipt,before){
  let control=null,status='unknown',run=null;
  try{control=await readControl(env);}catch{return {accepted:false,reason:'control_unreadable'};}
  const c=control.malformed?null:control.record;
  if(!c)return {accepted:false,reason:'control_unreadable'};
  if(env?.EPG_WORKFLOW?.get)status=await instanceStatus(env.EPG_WORKFLOW,receipt.toInstanceId);
  try{run=await loadJSON(env,'sync.json');}catch{run=undefined;}
  const named=c.instanceId===receipt.toInstanceId&&c.series===receipt.toSeries&&c.runKey===receipt.runKey&&c.rollover?.requestId===receipt.requestId;
  const superseded=!named&&c.runKey===receipt.runKey&&Number.isInteger(c.series)&&c.series>receipt.toSeries;
  const alive=['running','waiting','queued'].includes(status);
  // The run document must be readable and be the very run pinned before the swap (or absent exactly when it was absent); only within that run is the
  // checkpoint compared, and it may only have moved forward. An unreadable, missing or different run is unproven, never a success.
  const syncReadable=run!==undefined;
  const sameSync=syncReadable&&((run?.runId??null)===(before.syncRunId??null))&&(!run||progressCount(run)>=(before.syncCount??0));
  const sameRun=c.runId===before.runId&&sameSync;
  const budgetKept=named?c.budget?.consecutive>=before.consecutive&&c.budget?.total>=before.total:true;
  const accepted=named&&alive&&sameRun&&budgetKept;
  return {accepted,superseded,named,successorStatus:status,syncReadable,sameRun,budgetKept,versionConfirmed:named&&!!receipt.deployedVersionId&&c.versionId===receipt.deployedVersionId,controlRevision:control.revision,phase:c.phase,series:c.series,instanceId:c.instanceId};
 }
 const rolloverReceipt=r=>({requestId:r.requestId,runKey:r.runKey,fromInstanceId:r.fromInstanceId,fromSeries:r.fromSeries,toInstanceId:r.toInstanceId,toSeries:r.toSeries,deployedVersionId:r.deployedVersionId,fromVersionId:r.fromVersionId??null,fromControlRevision:r.fromControlRevision,at:r.at});
 async function epgWorkflowRollover(env,args={}){
  const startedAt=Date.now();
  let pre;
  try{pre=await rolloverPreflight(env,startedAt);}catch{return {status:200,body:{ok:false,mode:args.mode,decision:'unknown',unknowns:['preflight_failed'],blockers:[],writes:0}};}
  if(args.mode==='dry_run')return {status:200,body:{ok:true,mode:'dry_run',writes:0,...rolloverView(pre)}};
  const c=pre.raw.c,refuse=(reason,extra={})=>({status:409,body:{ok:false,mode:'apply',reason,writes:0,decision:pre.decision,blockers:pre.blockers,unknowns:pre.unknowns,expect:pre.expect,...extra}});
  if(args.confirmGo!==true)return {status:400,body:{ok:false,mode:'apply',reason:'confirm_required',writes:0}};
  // A repeat of the same request id never swaps again: it resumes a swap whose create is owed, or reads back.
  if(c?.rollover?.requestId===args.requestId){
   const r=c.rollover;
   // All six pins of the original request must match the stored receipt before anything else, an owed create included.
   const sixth=[['expectedRunKey',r.runKey],['expectedEpoch',r.epoch],['expectedSeries',r.fromSeries],['expectedInstanceId',r.fromInstanceId],['expectedRunId',r.runId??null],['expectedControlRevision',r.fromControlRevision]];
   if(sixth.some(([arg,value])=>args[arg]!==value))return refuse('request_id_reused');
   // A readback is always allowed. An owed create is gated by the CURRENT facts: every fact readable, no blocker but the two a swapped record
   // shows by itself (successor not started, successor not yet alive), the control epoch equal to the mode epoch, authority ready, and the
   // platform reporting the successor absent. Otherwise nothing is created and the answer is a readback only.
   const stillOwed=c.instanceId===r.toInstanceId&&c.phase==='starting'&&pre.raw.status==='absent';
   const gated=pre.unknowns.length===0&&pre.blockers.every(b=>b==='successor_not_started'||b==='owner_not_alive')&&pre.raw.mode?.record?.mode==='cloudflare'&&pre.raw.mode.record.epoch===c.epoch;
   let created=null,writes=0;
   if(stillOwed&&gated){created=await createSuccessor(env,{runKey:r.runKey,series:r.toSeries,epoch:c.epoch});writes=created.created?1:0;}
   const readback=await rolloverReadback(env,r,{runId:r.runId??null,syncRunId:r.syncRunId??null,syncCount:r.syncCount??0,consecutive:r.consecutive??0,total:r.total??0});
   const blocked=stillOwed&&!gated;
   const outcome=readback.superseded?'superseded':blocked?'create_blocked':created?.uncertain?'successor_uncertain':readback.accepted?(readback.versionConfirmed?'handed_over':'handed_over_version_pending'):'readback_unproven';
   rolloverLog(outcome,{requestId:String(args.requestId).slice(0,64),replay:true,to:r.toInstanceId});
   return {status:(readback.accepted||readback.superseded)&&!blocked?200:202,body:{ok:(readback.accepted||readback.superseded)&&!blocked,mode:'apply',outcome,replay:true,writes,...(blocked?{blockers:pre.blockers,unknowns:pre.unknowns}:{}),receipt:rolloverReceipt(r),readback}};
  }
  if(!pre.expect)return refuse('no_owner');
  const stale=ROLLOVER_PINS.filter(([arg,key])=>args[arg]!==pre.expect[key]).map(([arg])=>arg);
  if(stale.length)return refuse('stale_pin',{stale});
  if(pre.decision==='already_current')return refuse('already_current');
  if(pre.decision!=='eligible')return refuse(pre.decision);
  const raw=pre.raw,wake=Date.parse(pre.facts.sleepsUntil||'');
  // The reads must have left at least half of the wake margin.
  if(!Number.isFinite(wake)||wake-Date.now()<ROLLOVER_WAKE_MARGIN_MS/2)return refuse('preflight_too_slow');
  const runKey=c.runKey,toSeries=c.series+1,toInstanceId=instanceId(runKey,toSeries),at=iso(Date.now());
  const receipt={requestId:args.requestId,runKey,runId:c.runId??null,fromInstanceId:c.instanceId,fromSeries:c.series,toInstanceId,toSeries,deployedVersionId:pre.facts.deployedVersionId,fromVersionId:c.versionId??null,fromControlRevision:raw.control.revision,epoch:c.epoch,syncRunId:pre.facts.syncRun?.runId??null,syncCount:progressCount(raw.run),consecutive:c.budget?.consecutive??0,total:c.budget?.total??0,at};
  const next={...c,series:toSeries,instanceId:toInstanceId,phase:'starting',nextWakeAt:null,versionId:null,createdVersionId:pre.facts.deployedVersionId,rollover:receipt,updatedAt:at};
  let swapped=false;
  try{swapped=await casDoc(env,'control',raw.control.stored?raw.control.revision:null,next,raw.mode.revision,raw.lease.stored?raw.lease.revision:null);}
  catch{rolloverLog('swap_unknown',{requestId:String(args.requestId).slice(0,64)});return {status:202,body:{ok:false,mode:'apply',outcome:'swap_unknown',writes:0,hint:'repeat the same requestId and the same pins'}};}
  if(!swapped){rolloverLog('swap_refused',{requestId:String(args.requestId).slice(0,64)});return refuse('cas_lost');}
  let created;
  try{created=await createSuccessor(env,{runKey,series:toSeries,epoch:raw.mode.record.epoch});}catch{created={uncertain:true,id:toInstanceId,status:'unknown'};}
  const before={runId:c.runId??null,syncRunId:receipt.syncRunId,syncCount:receipt.syncCount,consecutive:receipt.consecutive,total:receipt.total};
  const readback=await rolloverReadback(env,receipt,before);
  const outcome=created.uncertain?'successor_uncertain':readback.accepted?(readback.versionConfirmed?'handed_over':'handed_over_version_pending'):'readback_unproven';
  rolloverLog(outcome,{requestId:String(args.requestId).slice(0,64),from:receipt.fromInstanceId,to:toInstanceId,deployedVersionId:receipt.deployedVersionId});
  return {status:readback.accepted?200:202,body:{ok:readback.accepted,mode:'apply',outcome,replay:false,writes:1+(created.created?1:0),receipt:rolloverReceipt(receipt),readback}};
 }
 // The MCP entry. Validates the arguments exactly; dry_run never writes.
 async function handleRolloverTool(env,args={}){
  const bad=reason=>({status:400,body:{ok:false,reason}});
  if(!args||typeof args!=='object'||Array.isArray(args))return bad('invalid');
  if(args.mode!=='dry_run'&&args.mode!=='apply')return bad('invalid_mode');
  if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return bad('invalid_confirm');
  if(args.mode==='apply'){
   if(typeof args.requestId!=='string'||!ROLLOVER_REQUEST_ID.test(args.requestId))return bad('invalid_request_id');
   if(typeof args.expectedRunKey!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(args.expectedRunKey))return bad('invalid_expected_run_key');
   if(!Number.isInteger(args.expectedEpoch)||args.expectedEpoch<0)return bad('invalid_expected_epoch');
   if(!Number.isInteger(args.expectedSeries)||args.expectedSeries<0)return bad('invalid_expected_series');
   if(typeof args.expectedInstanceId!=='string'||!/^epg_\d{8}_\d{1,6}$/.test(args.expectedInstanceId))return bad('invalid_expected_instance_id');
   if(args.expectedRunId!==null&&(typeof args.expectedRunId!=='string'||!args.expectedRunId||args.expectedRunId.length>100))return bad('invalid_expected_run_id');
   if(!Number.isInteger(args.expectedControlRevision)||args.expectedControlRevision<1)return bad('invalid_expected_control_revision');
  }
  return epgWorkflowRollover(env,args);
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
  // AIR-525: without a control `doneAt`, a complete run of today is done on its completion proof; a prior attempt's `run.error` alone
  // does not make it undone, and an unproven or unreadable one is not done.
  const doneToday=(c.runKey===dayKey&&!!c.doneAt)||(started===dayKey&&(await completion(env,run)).state==='proven');
  const priorAttemptError=run?.stage==='complete'&&!!run.error;
  let liveness=null;
  if(m.mode==='cloudflare'&&c.instanceId&&typeof env?.EPG_WORKFLOW?.get==='function'){
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
   syncRun:run?{runId:run.runId,stage:run.stage,remaining:run.remaining??null,sealPhase:run.seal?.phase??null,updatedAt:run.updatedAt??null,priorAttemptError}:null,seal,publication,
   failure:{class:c.failure?.class??null,code:c.failure?.code??null,fingerprint:c.budget?.fingerprint??null,consecutive:c.budget?.consecutive??0,total:c.budget?.total??0,caps:policy().BUDGET_CAPS},
   cooldownUntil:c.cooldownUntil,quarantine:c.quarantine,lastStep:c.lastStep,...(c.handoff?{handoff:{fromSeries:c.handoff.fromSeries??null,toSeries:c.handoff.toSeries??null,at:c.handoff.at??null,successorPending:c.phase==='starting'&&!c.doneAt&&liveness==='absent'}}:{}),health,sideEffects:'none'};
 }
 return {TABLE,LEASE_MS,BOUNDARY_MARGIN_MS,readLease,acquireStep,endStep,assertStep,beginExternalStep,instanceId,readMode,readControl,switchMode,clearQuarantine,handle,validate,externalGate,admit,act,run,ensure,certifyComplete,reconcileMirrors,readModel,drainState,rolloverPreflight,epgWorkflowRollover,handleRolloverTool,workerVersion,classifyThrown,checkpointKey,progressCount,sealClaimPending,createSuccessor};
})();
async function handleEpgRolloverTool(env,args){return EpgOrchestration.handleRolloverTool(env,args);}
async function runEpgWorkflow(env,payload,step){return EpgOrchestration.run(env,payload,step);}
