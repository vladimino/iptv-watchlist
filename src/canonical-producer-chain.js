// AIR-497 / ADR 0141. The CAS store of `canonical_producer_chain`. Separate from the run row.
// Dormant below marker `open`. Every mutating batch starts with the marker fence; start/stop transitions that
// (re)start work also pin (P, g_now). Ownership moves BEFORE Workflow create().
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {writerRoute} from './canonical-writer-route.js';
import {
 CHAIN_BOUNDARY_MARGIN_MS,CHAIN_CLAIM_WINDOW_MS,CHAIN_EPOCH_CAP,CHAIN_LEASE_MS,CHAIN_PROGRESS_RELAUNCH_CAP,
 CHAIN_QUIET_MS,CHAIN_REBASE_CAP,CHAIN_RECOVERY_ATTEMPT_CAP,CHAIN_RECOVERY_WINDOW_MS,
 fenceStatements,producerInstanceId,recoveryBackoffMs,recoveryClassOf,requireFence,
} from './canonical-producer-fence.js';

const {assertSql,FENCE}=fenced;
const COLUMNS='programme_run_id,input_generation,run_key,release_pin,owner_epoch,owner_instance,claim_nonce,owner_state,lease_expires_at,handoff_count,takeover_count,rebase_count,relaunch_count,reopen_count,stopped_by,recovery_class,recovery_attempts,streak_started_at,next_attempt_at,progress_relaunches,revision,created_at,updated_at';
const SKIPPED=Object.freeze({state:'skipped',reason:'film_person_route_not_open'});
const iso=ms=>new Date(ms).toISOString();
const fence=gate=>[FENCE,[gate.generation]];
const changesOne=()=>[assertSql('changes()=1'),[]];
const authorityPin=(p,g)=>[assertSql("EXISTS (SELECT 1 FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND generation=?)"),[p,g]];

async function routeOf(env){
 const route=await writerRoute(env);
 return route.writer==='canonical'?{open:true,generation:route.generation}:{open:false};
}
async function refuse(env,error){
 const message=String(error?.message||error);
 if(/no such table: canonical_producer_chain/i.test(message))return failed('producer_store_missing',error);
 if(/canonical_producer_not_open|canonical_producer_chain_/i.test(message))return failed('film_person_fence',error);
 if(/CHECK constraint failed/i.test(message)){
  let again;
  try{again=await readAuthority(env);}catch{return failed('producer_marker_unreadable',error);}
  if(again.state!=='open')return failed('film_person_fence',error);
  return failed('producer_cas_lost',error);
 }
 return failed('producer_transport',error);
}
async function commit(env,gate,statements){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('producer_transport');
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){throw await refuse(env,error);}
}

export async function readChain(env,programmeRunId){
 if(typeof programmeRunId!=='string'||!programmeRunId)throw failed('film_person_invalid');
 try{return (await one(database(env),'SELECT '+COLUMNS+' FROM canonical_producer_chain WHERE programme_run_id=?',[programmeRunId]))||null;}
 catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}
}

export async function listNonterminalChains(env){
 try{
  return await many(database(env),"SELECT "+COLUMNS+" FROM canonical_producer_chain WHERE owner_state NOT IN ('superseded')",[]);
 }catch(error){
  if(/no such table/i.test(String(error?.message)))return [];
  throw failed('producer_run_unreadable',error);
 }
}

async function nameGateFailure(env,fence){
 const chain=await readChain(env,fence.programmeRunId).catch(()=>null);
 let authority=null;
 try{authority=await one(database(env),'SELECT programme_run_id AS programmeRunId, generation FROM published_epg_authority WHERE id=1',[]);}catch{authority=null;}
 if(!authority||authority.programmeRunId!==fence.programmeRunId)return failed('producer_generation_superseded');
 if(Number(authority.generation)!==fence.inputGeneration||(chain&&Number(chain.input_generation)!==fence.inputGeneration))return failed('producer_input_superseded');
 return failed('producer_not_owner');
}

export async function launchChain(env,{programmeRunId,generation,at,nowMs}={}){
 if(typeof programmeRunId!=='string'||!Number.isInteger(generation)||typeof at!=='string')throw failed('film_person_invalid');
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const id=producerInstanceId(programmeRunId,1);
 const lease=iso((nowMs??Date.parse(at))+CHAIN_CLAIM_WINDOW_MS);
 try{
  await commit(env,gate,[fence(gate),authorityPin(programmeRunId,generation),
   ['INSERT INTO canonical_producer_chain (programme_run_id,input_generation,owner_epoch,owner_instance,owner_state,lease_expires_at,revision,created_at,updated_at) VALUES (?,?,1,?,'+"'pending'"+',?,1,?,?)',[programmeRunId,generation,id,lease,at,at]],
   changesOne()]);
 }catch(error){
  if(error?.code==='producer_cas_lost'||/UNIQUE/i.test(String(error?.message||error)))return {state:'exists',chain:await readChain(env,programmeRunId)};
  throw error;
 }
 return {state:'launched',chain:await readChain(env,programmeRunId),instanceId:id,epoch:1};
}

export async function claimChain(env,{programmeRunId,epoch,instanceId,nonce,generation,revision,at,nowMs}={}){
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const lease=iso((nowMs??Date.parse(at))+CHAIN_LEASE_MS);
 try{
  await commit(env,gate,[fence(gate),authorityPin(programmeRunId,generation),
   ["UPDATE canonical_producer_chain SET owner_state='active',claim_nonce=?,input_generation=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND owner_instance=? AND owner_state='pending' AND revision=?",
    [nonce,generation,lease,at,programmeRunId,epoch,instanceId,revision]],changesOne()]);
 }catch(error){
  const stored=await readChain(env,programmeRunId);
  if(stored&&stored.owner_state==='active'&&stored.owner_epoch===epoch&&stored.owner_instance===instanceId&&stored.claim_nonce===nonce)return {state:'owned',chain:stored};
  return {state:'not_owner',chain:stored};
 }
 return {state:'owned',chain:await readChain(env,programmeRunId)};
}

function ownerWhere(fence,revision){
 return {sql:'programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state=\'active\' AND revision=?',params:[fence.programmeRunId,fence.epoch,fence.nonce,revision]};
}

export async function handoffChain(env,{fence:f,revision,at,nowMs}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const nextEpoch=f.epoch+1;
 if(nextEpoch>CHAIN_EPOCH_CAP)return {state:'stopped',code:'producer_chain_epoch_cap'};
 const nextId=producerInstanceId(f.programmeRunId,nextEpoch);
 const lease=iso((nowMs??Date.parse(at))+CHAIN_CLAIM_WINDOW_MS);
 try{
  await commit(env,gate,[fence(gate),...fenceStatements(f),
   ["UPDATE canonical_producer_chain SET owner_epoch=?,owner_instance=?,owner_state='pending',claim_nonce=NULL,lease_expires_at=?,handoff_count=handoff_count+1,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND revision=?",
    [nextEpoch,nextId,lease,at,f.programmeRunId,f.epoch,f.nonce,revision]],changesOne()]);
 }catch(error){
  const stored=await readChain(env,f.programmeRunId);
  if(stored&&stored.owner_epoch===nextEpoch&&stored.owner_instance===nextId&&(stored.owner_state==='pending'||stored.owner_state==='active'))return {state:'handed_off',chain:stored,epoch:nextEpoch,instanceId:nextId};
  throw error;
 }
 return {state:'handed_off',chain:await readChain(env,f.programmeRunId),epoch:nextEpoch,instanceId:nextId};
}

async function restart(env,{programmeRunId,generation,revision,epoch,at,nowMs,fromStates,setSql,setParams,countField}){
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const nextEpoch=epoch+1;
 if(nextEpoch>CHAIN_EPOCH_CAP)return {state:'stopped',code:'producer_chain_epoch_cap'};
 const nextId=producerInstanceId(programmeRunId,nextEpoch);
 const lease=iso((nowMs??Date.parse(at))+CHAIN_CLAIM_WINDOW_MS);
 const states=fromStates.map(()=>'?').join(',');
 await commit(env,gate,[fence(gate),authorityPin(programmeRunId,generation),
  ['UPDATE canonical_producer_chain SET owner_epoch=?,owner_instance=?,owner_state=\'pending\',claim_nonce=NULL,input_generation=?,lease_expires_at=?,release_pin=CASE WHEN input_generation=? THEN release_pin ELSE NULL END,'+countField+'='+countField+'+1,'+setSql+'revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND revision=? AND owner_state IN ('+states+')',
   [nextEpoch,nextId,generation,lease,generation,...setParams,at,programmeRunId,epoch,revision,...fromStates]],changesOne()]);
 return {state:'pending',chain:await readChain(env,programmeRunId),epoch:nextEpoch,instanceId:nextId};
}

export async function takeoverChain(env,{chain,generation,at,nowMs}={}){
 const expired=Date.parse(chain.lease_expires_at)+CHAIN_BOUNDARY_MARGIN_MS<(nowMs??Date.parse(at));
 if(!expired||(chain.owner_state!=='pending'&&chain.owner_state!=='active'))return {state:'live',chain};
 return restart(env,{programmeRunId:chain.programme_run_id,generation,revision:chain.revision,epoch:chain.owner_epoch,at,nowMs,fromStates:['pending','active'],setSql:'',setParams:[],countField:'takeover_count'});
}

export async function rebaseChain(env,{fence:f,revision,generation,at}={}){
 requireFence(f,['chain']);
 if(generation<=f.inputGeneration)throw failed('producer_input_superseded');
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const stored=await readChain(env,f.programmeRunId);
 if(!stored)throw failed('producer_store_missing');
 if(stored.rebase_count>=CHAIN_REBASE_CAP){
  return stopChain(env,{fence:f,revision,at,stoppedBy:'producer_input_unstable',recoveryClass:'fail_closed'});
 }
 try{
  await commit(env,gate,[fence(gate),authorityPin(f.programmeRunId,generation),
   ["UPDATE canonical_producer_chain SET input_generation=?,release_pin=NULL,rebase_count=rebase_count+1,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=? AND revision=?",
    [generation,at,f.programmeRunId,f.epoch,f.nonce,f.inputGeneration,revision]],changesOne()]);
 }catch(error){throw error;}
 return {state:'rebased',chain:await readChain(env,f.programmeRunId),fence:{...f,inputGeneration:generation,revision:(revision||0)+1}};
}

export async function relaunchChain(env,{chain,generation,at,nowMs}={}){
 if(chain.owner_state!=='released')return {state:'skip',chain};
 return restart(env,{programmeRunId:chain.programme_run_id,generation,revision:chain.revision,epoch:chain.owner_epoch,at,nowMs,fromStates:['released'],setSql:'',setParams:[],countField:'relaunch_count'});
}

export async function reopenChain(env,{chain,generation,at,nowMs,quiet=false}={}){
 const moved=generation>Number(chain.input_generation);
 const progress=chain.owner_state==='stopped'&&chain.stopped_by==='producer_input_unstable'&&generation===Number(chain.input_generation)&&quiet;
 if(!(chain.owner_state==='complete'||chain.owner_state==='stopped')||!(moved||progress))return {state:'skip',chain};
 if(chain.recovery_class==='exhausted'||chain.recovery_class==='terminal'||chain.recovery_class==='fail_closed')return {state:'held',chain};
 if(progress&&chain.progress_relaunches>=CHAIN_PROGRESS_RELAUNCH_CAP)return {state:'held',chain};
 const extra=progress?'progress_relaunches=progress_relaunches+1,stopped_by=NULL,recovery_class=NULL,':'stopped_by=NULL,recovery_class=NULL,';
 return restart(env,{programmeRunId:chain.programme_run_id,generation,revision:chain.revision,epoch:chain.owner_epoch,at,nowMs,fromStates:[chain.owner_state],setSql:extra,setParams:[],countField:'reopen_count'});
}

export async function recoverChain(env,{chain,generation,at,nowMs}={}){
 if(chain.owner_state!=='stopped')return {state:'skip',chain};
 const now=nowMs??Date.parse(at);
 if(chain.recovery_class==='authority'){
  return restart(env,{programmeRunId:chain.programme_run_id,generation,revision:chain.revision,epoch:chain.owner_epoch,at,nowMs,fromStates:['stopped'],setSql:'stopped_by=NULL,',setParams:[],countField:'reopen_count'});
 }
 if(chain.recovery_class!=='transient'&&chain.recovery_class!=='receipt')return {state:'skip',chain};
 if(chain.recovery_attempts>=CHAIN_RECOVERY_ATTEMPT_CAP)return {state:'held',chain};
 if(chain.streak_started_at&&now-Date.parse(chain.streak_started_at)>=CHAIN_RECOVERY_WINDOW_MS)return {state:'held',chain};
 if(chain.next_attempt_at&&now<Date.parse(chain.next_attempt_at))return {state:'wait',chain};
 return restart(env,{programmeRunId:chain.programme_run_id,generation,revision:chain.revision,epoch:chain.owner_epoch,at,nowMs,fromStates:['stopped'],setSql:'recovery_attempts=recovery_attempts+1,stopped_by=NULL,',setParams:[],countField:'reopen_count'});
}

export async function yieldChain(env,{fence:f,revision,at}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),...fenceStatements(f,{ownerOnly:true}),
  ["UPDATE canonical_producer_chain SET owner_state='released',revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=? AND revision=?",
   [at,f.programmeRunId,f.epoch,f.nonce,f.inputGeneration,revision]],changesOne()]);
 return {state:'released',chain:await readChain(env,f.programmeRunId)};
}

export async function completeChain(env,{fence:f,revision,at}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),...fenceStatements(f),...completeChainStatements(f,at,revision)]);
 const chain=await readChain(env,f.programmeRunId);
 if(Number.isInteger(Number(chain?.revision)))f.revision=Number(chain.revision);
 return {state:'complete',chain};
}

export function completeChainStatements(fence,at,revision){
 requireFence(fence,['chain']);
 return [["UPDATE canonical_producer_chain SET owner_state='complete',revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=? AND revision=?",
  [at,fence.programmeRunId,fence.epoch,fence.nonce,fence.inputGeneration,revision]],changesOne()];
}

export function leaseRenewStatements(fence,at,nowMs,revision){
 requireFence(fence,['chain']);
 const lease=iso((nowMs??Date.parse(at))+CHAIN_LEASE_MS);
 return [["UPDATE canonical_producer_chain SET lease_expires_at=?,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND revision=?",
  [lease,at,fence.programmeRunId,fence.epoch,fence.nonce,revision]],changesOne()];
}

export async function stopChain(env,{fence:f,revision,at,stoppedBy,recoveryClass,nowMs}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const klass=recoveryClass||recoveryClassOf(stoppedBy);
 const now=nowMs??Date.parse(at);
 const stored=await readChain(env,f.programmeRunId);
 const attempts=(stored?.recovery_attempts||0);
 const streak=stored?.streak_started_at||at;
 const next=klass==='transient'||klass==='receipt'?iso(now+recoveryBackoffMs(attempts)):null;
 await commit(env,gate,[fence(gate),...fenceStatements(f,{ownerOnly:true}),
  ["UPDATE canonical_producer_chain SET owner_state='stopped',stopped_by=?,recovery_class=?,streak_started_at=COALESCE(streak_started_at,?),next_attempt_at=?,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=? AND revision=?",
   [stoppedBy,klass,at,next,at,f.programmeRunId,f.epoch,f.nonce,f.inputGeneration,revision]],changesOne()]);
 return {state:'stopped',chain:await readChain(env,f.programmeRunId)};
}

export async function supersedeChain(env,{chain,at}={}){
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),
  ["UPDATE canonical_producer_chain SET owner_state='superseded',revision=revision+1,updated_at=? WHERE programme_run_id=? AND revision=? AND owner_state NOT IN ('superseded')",[at,chain.programme_run_id,chain.revision]],changesOne()]);
 return {state:'superseded',chain:await readChain(env,chain.programme_run_id)};
}

export function parseReleasePin(value){
 if(typeof value!=='string'||!value||value==='empty')return [];
 return value.split(',').filter(id=>id.startsWith('film:'));
}
export function formatReleasePin(ids){
 const unique=[...new Set((ids||[]).filter(id=>typeof id==='string'&&id.startsWith('film:')))].sort();
 const pin=unique.join(',')||'empty';
 if(pin.length>4000){const error=new Error('film_person_bounded');error.code='film_person_bounded';throw error;}
 return pin;
}
export async function pinChainReleases(env,{fence:f,revision,departed,at}={}){
 requireFence(f,['chain']);
 const pin=formatReleasePin(departed);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),...fenceStatements(f),
  ["UPDATE canonical_producer_chain SET release_pin=COALESCE(release_pin,?),revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND revision=?",
   [pin,at,f.programmeRunId,f.epoch,f.nonce,revision]],changesOne()]);
 const chain=await readChain(env,f.programmeRunId);
 if(Number.isInteger(Number(chain?.revision)))f.revision=Number(chain.revision);
 return {state:'pinned',chain};
}

export async function setChainRunKey(env,{fence:f,revision,runKey,at}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),...fenceStatements(f),
  ['UPDATE canonical_producer_chain SET run_key=?,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state=\'active\' AND revision=?',
   [runKey,at,f.programmeRunId,f.epoch,f.nonce,revision]],changesOne()]);
 return {state:'linked',chain:await readChain(env,f.programmeRunId)};
}

export {nameGateFailure,CHAIN_LEASE_MS,CHAIN_CLAIM_WINDOW_MS,CHAIN_BOUNDARY_MARGIN_MS};
