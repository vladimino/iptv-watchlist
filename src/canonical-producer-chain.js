// AIR-497 / ADR 0141. The CAS store of `canonical_producer_chain`. Separate from the run row.
// Dormant below marker `open`. Every mutating batch starts with the marker fence; start/stop transitions that
// (re)start work also pin (P, g_now). Ownership moves BEFORE Workflow create().
import {database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {writerRoute} from './canonical-writer-route.js';
import {IN_FLIGHT_STATES,outcomeId,outcomeInsert,stopRecovery} from './canonical-producer-events.js';
import {
 CHAIN_BOUNDARY_MARGIN_MS,CHAIN_CLAIM_WINDOW_MS,CHAIN_EPOCH_CAP,CHAIN_LEASE_MS,CHAIN_PROGRESS_RELAUNCH_CAP,
 CHAIN_QUIET_MS,CHAIN_REBASE_CAP,CHAIN_RECOVERY_ATTEMPT_CAP,CHAIN_RECOVERY_WINDOW_MS,
 fenceStatements,producerInstanceId,recoveryBackoffMs,recoveryClassOf,requireFence,
} from './canonical-producer-fence.js';

const {assertSql,FENCE}=fenced;
const RECOVERY_CAPS=Object.freeze({attempts:CHAIN_RECOVERY_ATTEMPT_CAP,windowMs:CHAIN_RECOVERY_WINDOW_MS});
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
 await commit(env,gate,[fence(gate),...fenceStatements(f),...completeChainStatements(f,at,revision),...passedOutcomeStatements(f,at)]);
 const chain=await readChain(env,f.programmeRunId);
 if(Number.isInteger(Number(chain?.revision)))f.revision=Number(chain.revision);
 return {state:'complete',chain};
}

export function completeChainStatements(fence,at,revision){
 requireFence(fence,['chain']);
 return [["UPDATE canonical_producer_chain SET owner_state='complete',revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=? AND revision=?",
  [at,fence.programmeRunId,fence.epoch,fence.nonce,fence.inputGeneration,revision]],changesOne()];
}

// ADR 0208 (AIR-594): the outcome row of a terminal chain transition, appended LAST to the transition's own batch and asserted (`changes()=1`), only when the
// Workflow's schema probe proved the outcome table active (`fence.outcomes === true`). The probe of an absent schema leaves the flag false: no row, today's batch.
export function passedOutcomeStatements(fence,at){
 if(fence?.outcomes!==true)return [];
 const id=outcomeId(fence.programmeRunId,'passed',fence.inputGeneration);
 return [outcomeInsert({id,outcome:'passed',at,programmeRunId:fence.programmeRunId,epoch:fence.epoch,state:'complete'}),changesOne()];
}
export function stoppedOutcomeStatements(fence,at,recovery){
 if(fence?.outcomes!==true)return [];
 const id=outcomeId(fence.programmeRunId,'stopped',fence.epoch);
 return [outcomeInsert({id,outcome:'stopped',at,recovery,programmeRunId:fence.programmeRunId,epoch:fence.epoch,state:'stopped'}),changesOne()];
}

export function leaseRenewStatements(fence,at,nowMs,revision){
 requireFence(fence,['chain']);
 const lease=iso((nowMs??Date.parse(at))+CHAIN_LEASE_MS);
 return [["UPDATE canonical_producer_chain SET lease_expires_at=?,revision=revision+1,updated_at=? WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND revision=?",
  [lease,at,fence.programmeRunId,fence.epoch,fence.nonce,revision]],changesOne()];
}

// AIR-572 replay marker: the FIRST write of every `work` step renews the owner's lease (revision + 1) under the full owner fence. A re-entry of the same epoch (a step retry or an
// instance replayed with the cached claim) then finds the chain revision moved past the claim's and never runs the expensive work again (see runProducerWorkflow).
export async function markWorkEntered(env,{fence:f,at,nowMs}={}){
 requireFence(f,['chain']);
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 await commit(env,gate,[fence(gate),...fenceStatements(f,{ownerOnly:true}),...leaseRenewStatements(f,at,nowMs,f.revision)]);
 f.revision+=1;
 return {state:'entered'};
}

export async function stopChain(env,{fence:f,revision,at,stoppedBy,recoveryClass,nowMs,caps=RECOVERY_CAPS}={}){
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
   [stoppedBy,klass,at,next,at,f.programmeRunId,f.epoch,f.nonce,f.inputGeneration,revision]],changesOne(),
  ...stoppedOutcomeStatements(f,at,stopRecovery({recoveryClass:klass,attempts:stored?.recovery_attempts||0,streakStartedAt:stored?.streak_started_at||null,at,caps}))]);
 return {state:'stopped',chain:await readChain(env,f.programmeRunId)};
}

// `guards` (optional, default none) are extra [sql, params] assertions placed after the marker fence in the SAME batch; the hourly reconcile passes none, so its batch is unchanged.
// `outcome` (ADR 0208, the hourly reconcile only, when its schema probe proved the outcome table active): a chain read in flight (pending, active, released) gets its
// `superseded` row LAST in the same batch, read from the row the update just wrote at exactly the guarded revision + 1, with the pre-state of the caller's guarded read.
// A complete or stopped chain adds no row. The owner path (`producer_chain_operator`) never passes it.
export async function supersedeChain(env,{chain,at,guards=[],outcome=false}={}){
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const inFlight=outcome===true&&IN_FLIGHT_STATES.includes(chain.owner_state);
 await commit(env,gate,[fence(gate),...guards,
  ["UPDATE canonical_producer_chain SET owner_state='superseded',revision=revision+1,updated_at=? WHERE programme_run_id=? AND revision=? AND owner_state NOT IN ('superseded')",[at,chain.programme_run_id,chain.revision]],changesOne(),
  ...(inFlight?[outcomeInsert({id:outcomeId(chain.programme_run_id,'superseded',Number(chain.owner_epoch)),outcome:'superseded',at,recovery:'none',priorState:chain.owner_state,
   programmeRunId:chain.programme_run_id,epoch:Number(chain.owner_epoch),state:'superseded',revision:Number(chain.revision)+1}),changesOne()]:[])]);
 return {state:'superseded',chain:await readChain(env,chain.programme_run_id)};
}

// ADR 0208 decision 3 (AIR-594): the `held` outcome, written by the hourly reconcile only, in the tick where `recoverChain` or `reopenChain` answered `held` for this
// stopped chain. One batch: the marker fence, then the insert guarded by the chain's CURRENT epoch, state `stopped` and revision, and by the `stopped` row of the same
// (P, epoch) saying `eligible`; then `changes()=1`. The caller reads both rows first: an existing `held` row (a repeated tick) or a stop row that is absent (an outcome
// of before activation) or not eligible means no write. Returns {state:'recorded'|'exists'|'not_eligible'|'skipped'}.
export async function recordHeldOutcome(env,{chain,at}={}){
 if(!chain||chain.owner_state!=='stopped')return {state:'not_eligible'};
 const gate=await routeOf(env);
 if(!gate.open)return SKIPPED;
 const epoch=Number(chain.owner_epoch),P=chain.programme_run_id;
 const heldId=outcomeId(P,'held',epoch),stopId=outcomeId(P,'stopped',epoch);
 const rows=await many(database(env),'SELECT id,recovery FROM canonical_producer_outcome WHERE id IN (?,?)',[heldId,stopId]);
 if(rows.some(row=>row.id===heldId))return {state:'exists'};
 if(!rows.some(row=>row.id===stopId&&row.recovery==='eligible'))return {state:'not_eligible'};
 await commit(env,gate,[fence(gate),outcomeInsert({id:heldId,outcome:'held',at,recovery:'owner',programmeRunId:P,epoch,state:'stopped',revision:Number(chain.revision),
  extra:{sql:"EXISTS (SELECT 1 FROM canonical_producer_outcome s WHERE s.id=? AND s.recovery='eligible')",params:[stopId]}}),changesOne()]);
 return {state:'recorded'};
}

// ---- AIR-572: the owner-only terminalization of a STALE Producer chain (MCP tool producer_chain_operator) ------------------------------------------------------------
// While the static delivery hold is on, `reconcileProducerChain` returns before it supersedes anything, so a chain of an older published run that was still open when the hold
// shipped stays non-terminal forever and the membership writer switch refuses `producer_chain_open`. This handler lets the owner make exactly the transition the hourly
// reconcile would make for that chain, through the SAME `supersedeChain` (Film/Person marker fence at the open generation, revision CAS, `changes()=1`). It adds no SQL write and no
// writer, creates no Workflow instance, touches no lease, epoch, run, receipt, Film, Person or Watchlist row, and never lifts the hold. Inert without a call.
//   status     (default) read-only: the Film/Person route, the published (P, g), the hold, and at most PRODUCER_CHAIN_OPERATOR_LIMIT open chains, each with its eligibility and expect pins
//              (`runLinked` says whether the chain ever linked a pass run: its own `run_key`).
//   supersede  confirmGo, expectedProgrammeRunId, expectedRevision (from status): one chain, only while the hold is on, only when its run is not the published one, it is open (the same
//              predicate as the switch gate) and no owner lease is live; every fact is re-read right before the write.
// A chain is OPEN while it can still write: pending, active, released, or stopped with an automatically recoverable class (the switch gate `PRODUCER_OPEN_CHAINS_SQL` of
// watchlist-membership.js uses the same predicate; tests/producer-chain-operator.mjs checks they agree).
export const PRODUCER_CHAIN_OPERATOR_MODES=Object.freeze(['status','supersede']);
export const PRODUCER_CHAIN_OPERATOR_LIMIT=10;
export const PRODUCER_OPEN_CHAIN_PREDICATE="(owner_state IN ('pending','active','released') OR (owner_state='stopped' AND recovery_class IN ('transient','receipt','authority')))";
const PROGRAMME_RUN_ID=/^[A-Za-z0-9_.:-]{1,160}$/;
const isOpenChain=chain=>['pending','active','released'].includes(chain?.owner_state)||(chain?.owner_state==='stopped'&&['transient','receipt','authority'].includes(chain?.recovery_class));
// Why one chain may not be superseded now, or null. `published` is the {programmeRunId} of the published EPG authority.
function chainBlocker(chain,published,nowMs){
 if(!isOpenChain(chain))return chain?.owner_state==='superseded'?'already_superseded':'chain_not_open';
 if(chain.programme_run_id===published.programmeRunId)return 'current_published_run';
 if((chain.owner_state==='pending'||chain.owner_state==='active')&&!(Date.parse(chain.lease_expires_at)+CHAIN_BOUNDARY_MARGIN_MS<nowMs))return 'lease_live';
 return null;
}
// deps: held() -> the Producer's static delivery hold (true while held), now() -> ms, supersede (the chain transition; `supersedeChain` unless a test injects one).
export function producerChainOperator({held,now=()=>Date.now(),supersede=supersedeChain}={}){
 const reply=(status,body)=>({status,body});
 async function snapshot(env){
  const db=database(env);
  const [route,published,chains]=await Promise.all([
   routeOf(env).catch(error=>error?.code==='film_person_held'||error?.code==='film_person_unavailable'?{open:false}:null),
   one(db,'SELECT mode,cutover,programme_run_id AS programmeRunId,generation FROM published_epg_authority WHERE id=1',[]).catch(()=>undefined),
   many(db,'SELECT '+COLUMNS+' FROM canonical_producer_chain WHERE '+PRODUCER_OPEN_CHAIN_PREDICATE+' ORDER BY created_at,programme_run_id LIMIT ?',[PRODUCER_CHAIN_OPERATOR_LIMIT+1]).catch(()=>null)]);
  return {route,published:published&&published.mode==='d1'&&published.cutover==='open'&&published.programmeRunId?{programmeRunId:published.programmeRunId,generation:Number(published.generation)}:null,
   publishedReadable:published!==undefined,chains,held:typeof held==='function'&&held()===true,nowMs:now()};
 }
 function refusal(s){
  if(!s.route)return 'film_person_unreadable';
  if(!s.route.open)return 'film_person_not_open';
  if(!s.publishedReadable)return 'published_unreadable';
  if(!s.published)return 'published_not_open';
  if(!s.chains)return 'chains_unreadable';
  if(!s.held)return 'producer_not_held';
  return null;
 }
 const item=(chain,s)=>{
  const reason=s.published?chainBlocker(chain,s.published,s.nowMs):'published_not_open';
  return {programmeRunId:chain.programme_run_id,inputGeneration:Number(chain.input_generation),ownerState:chain.owner_state,ownerEpoch:Number(chain.owner_epoch),claimed:chain.claim_nonce!=null,
   leaseExpiresAt:chain.lease_expires_at,recoveryClass:chain.recovery_class??null,revision:Number(chain.revision),runLinked:chain.run_key!=null,eligible:!reason,...(reason?{reason}:{expect:{expectedProgrammeRunId:chain.programme_run_id,expectedRevision:Number(chain.revision)}})};
 };
 const openCount=async env=>Number((await one(database(env),'SELECT COUNT(*) AS n FROM canonical_producer_chain WHERE '+PRODUCER_OPEN_CHAIN_PREDICATE,[]))?.n??0);
 return async function handle(env,args={}){
  if(!args||typeof args!=='object'||Array.isArray(args))return reply(400,{ok:false,reason:'invalid'});
  const mode=args.mode===undefined?'status':args.mode;
  if(!PRODUCER_CHAIN_OPERATOR_MODES.includes(mode))return reply(400,{ok:false,reason:'invalid_mode'});
  if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return reply(400,{ok:false,reason:'invalid_confirm'});
  if(mode==='status'){
   const s=await snapshot(env);
   const items=s.chains?s.chains.slice(0,PRODUCER_CHAIN_OPERATOR_LIMIT).map(chain=>item(chain,s)):null;
   return reply(200,{ok:true,mode,sideEffects:'none',filmPerson:s.route?{open:s.route.open,...(s.route.open?{generation:s.route.generation}:{})}:null,published:s.published,held:s.held,
    blocked:refusal(s),chains:items?{items,truncated:s.chains.length>PRODUCER_CHAIN_OPERATOR_LIMIT}:null});
  }
  if(args.confirmGo!==true)return reply(400,{ok:false,mode,reason:'confirm_required',writes:0});
  if(typeof args.expectedProgrammeRunId!=='string'||!PROGRAMME_RUN_ID.test(args.expectedProgrammeRunId))return reply(400,{ok:false,mode,reason:'invalid_expected_programme_run_id',writes:0});
  if(!Number.isInteger(args.expectedRevision)||args.expectedRevision<1)return reply(400,{ok:false,mode,reason:'invalid_expected_revision',writes:0});
  const s=await snapshot(env);
  const refused=refusal(s);
  if(refused)return reply(409,{ok:false,mode,reason:refused,writes:0});
  let chain;
  try{chain=await readChain(env,args.expectedProgrammeRunId);}catch{return reply(409,{ok:false,mode,reason:'chains_unreadable',writes:0});}
  if(!chain)return reply(409,{ok:false,mode,reason:'chain_not_found',writes:0});
  if(Number(chain.revision)!==args.expectedRevision&&chain.owner_state!=='superseded')return reply(409,{ok:false,mode,reason:'revision_moved',writes:0,revision:Number(chain.revision)});
  const blocked=chainBlocker(chain,s.published,s.nowMs);
  if(blocked)return reply(409,{ok:false,mode,reason:blocked,writes:0});
  const pins={expectedProgrammeRunId:args.expectedProgrammeRunId,expectedRevision:args.expectedRevision};
  const P=s.published.programmeRunId,g=s.published.generation;
  let out;
  try{out=await supersede(env,{chain,at:new Date(s.nowMs).toISOString(),guards:publishedGuards(P,g,chain.programme_run_id)});}
  catch(error){
   const code=error?.code||'producer_transport';
   // Refused before the batch, or a statement of the batch failed and D1 rolled it back: proven zero writes. Name a publication that moved under the read.
   if(PROVEN_NO_WRITE.has(code)){
    if(code==='producer_cas_lost'){
     const now=await one(database(env),'SELECT programme_run_id AS programmeRunId,generation FROM published_epg_authority WHERE id=1',[]).catch(()=>null);
     if(!now||now.programmeRunId!==P||Number(now.generation)!==g)return reply(409,{ok:false,mode,reason:'published_moved',writes:0});
    }
    return reply(409,{ok:false,mode,reason:code,writes:0});
   }
   // Anything else (a lost response, a failed readback after the batch) may have committed: never claim zero writes, never retry. One read-only reconciliation of the target row.
   return reconcileAfter(env,chain,pins,code==='producer_run_unreadable'?'readback_unproven':'write_uncertain');
  }
  if(out?.state!=='superseded')return reply(409,{ok:false,mode,reason:out?.reason||'film_person_not_open',writes:0});
  return confirmed(env,out.chain,false);
 };
 async function confirmed(env,after,reconciled){
  return reply(200,{ok:true,mode:'supersede',superseded:true,writes:1,...(reconciled?{reconciled:true}:{}),chain:after?{programmeRunId:after.programme_run_id,ownerState:after.owner_state,revision:Number(after.revision)}:null,
   nonTerminalChains:await openCount(env).catch(()=>null)});
 }
 // The outcome of a batch whose result is unknown: proven only when the target row reads `superseded` at exactly the pinned revision + 1 (nothing else supersedes while the hold is on).
 // Otherwise HTTP 202 with `writes: null` (not proven either way), the observed row and the original pins. A repeat with fresh pins from `status` is safe: the revision CAS admits at most one transition.
 async function reconcileAfter(env,chain,pins,reason){
  let row;
  try{row=await readChain(env,chain.programme_run_id);}catch{row=undefined;}
  if(row&&row.owner_state==='superseded'&&Number(row.revision)===Number(chain.revision)+1)return confirmed(env,row,true);
  return reply(202,{ok:false,mode:'supersede',reason:row===undefined?'readback_unproven':reason,writes:null,expect:pins,
   observed:row?{ownerState:row.owner_state,revision:Number(row.revision)}:(row===null?{missing:true}:null)});
 }
}
// The failures that prove nothing was written: the route refused before any batch (film_person_held / film_person_unavailable from `writerRoute`), or a statement of the batch failed
// (the marker fence, the revision CAS or a guard, a missing table), so D1 rolled the whole batch back.
const PROVEN_NO_WRITE=new Set(['film_person_held','film_person_unavailable','producer_cas_lost','film_person_fence','producer_store_missing','producer_marker_unreadable']);
// The write-time published-authority fence of the owner path: the published (P, g) the operator read is still the published one, and it is not the target chain's run.
function publishedGuards(P,g,target){
 return [authorityPin(P,g),[assertSql("NOT EXISTS (SELECT 1 FROM published_epg_authority WHERE id=1 AND programme_run_id=?)"),[target]]];
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
