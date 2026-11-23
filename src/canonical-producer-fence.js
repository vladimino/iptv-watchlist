// AIR-497 / ADR 0141. Typed producer fences: chain GATE, retry exclusion, dictionary marker-only.
// Pure. A missing or unknown kind is refused before any statement. No imports: the Worker bundle scopes this first.
export const FENCE_KINDS=Object.freeze(['chain','retry','dictionary','letterboxd']);
export const CHAIN_LEASE_MS=5*60000;
export const CHAIN_BOUNDARY_MARGIN_MS=15000;
export const CHAIN_CLAIM_WINDOW_MS=5*60000;
export const CHAIN_REBASE_CAP=8;
export const CHAIN_EPOCH_CAP=64;
export const CHAIN_REPLAY_CAP=8;
export const CHAIN_QUIET_MS=60*60000;
export const CHAIN_RECOVERY_ATTEMPT_CAP=5;
export const CHAIN_RECOVERY_WINDOW_MS=24*3600000;
export const CHAIN_PROGRESS_RELAUNCH_CAP=8;
export const CHAIN_SUBREQUEST_LIMIT=10000;
export const CHAIN_HEADROOM=0.5;
export const CHAIN_FLOOR_D1_CALLS=40;
export const CHAIN_FLOOR_D1_STATEMENTS=200;
export const CHAIN_HANDOFF_RESERVE_CALLS=4;
export const CHAIN_SLICE_SIZE=50;
export const CHAIN_MAX_SLICES=20;
export const CHAIN_SLICE_DEADLINE_MS=270000;
export const CHAIN_CREATE_ATTEMPTS=3;

const assertSql=(condition)=>'INSERT INTO film_person_cas (id,ok) VALUES (1,(SELECT CASE WHEN EXISTS (SELECT 1 FROM film_person_cas WHERE id=1) AND ('+condition+') THEN 1 ELSE 0 END)) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function missing(){const error=new Error('producer_fence_missing');error.code='producer_fence_missing';throw error;}

export function requireFence(fence,kinds=FENCE_KINDS){
 if(!plain(fence)||typeof fence.kind!=='string'||!kinds.includes(fence.kind))missing();
 if(fence.kind==='chain'){
  if(typeof fence.programmeRunId!=='string'||!fence.programmeRunId||!Number.isInteger(fence.inputGeneration)||fence.inputGeneration<0
   ||!Number.isInteger(fence.epoch)||fence.epoch<1||typeof fence.nonce!=='string'||!fence.nonce)missing();
 }
 // AIR-570 / ADR 0186: the Letterboxd Sync's own mode epoch. Every canonical commit of a Letterboxd step asserts, inside its fenced batch, that the executor mode is still `cloudflare` at this epoch.
 if(fence.kind==='letterboxd'){
  if(!Number.isInteger(fence.epoch)||fence.epoch<0)missing();
 }
 if(fence.kind==='retry'){
  if(typeof fence.programmeRunId!=='string'||!fence.programmeRunId||!Number.isInteger(fence.inputGeneration)||fence.inputGeneration<0)missing();
 }
 return fence;
}

export function producerInstanceId(programmeRunId,epoch){
 let h=2166136261>>>0;
 const s=String(programmeRunId);
 for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619)>>>0;
 return 'pw_'+h.toString(16).padStart(8,'0')+'_'+epoch;
}

export function snapshotLabel(programmeRunId,generation){
 return String(programmeRunId)+':'+String(generation);
}

export function generationOrder(earlier,later){
 const a=Number(String(earlier).includes(':')?String(earlier).slice(String(earlier).lastIndexOf(':')+1):earlier);
 const b=Number(String(later).includes(':')?String(later).slice(String(later).lastIndexOf(':')+1):later);
 if(!Number.isInteger(a)||!Number.isInteger(b)||a===b)return 0;
 return a<b?-1:1;
}

export function chainGateSql(){
 return assertSql("EXISTS (SELECT 1 FROM published_epg_authority a JOIN canonical_producer_chain c ON c.programme_run_id=a.programme_run_id WHERE a.id=1 AND a.mode='d1' AND a.cutover='open' AND a.programme_run_id=? AND a.generation=? AND c.input_generation=? AND c.owner_epoch=? AND c.claim_nonce=? AND c.owner_state='active')");
}
export function chainGateParams(fence){
 return [fence.programmeRunId,fence.inputGeneration,fence.inputGeneration,fence.epoch,fence.nonce];
}

export function letterboxdEpochSql(){
 return assertSql("EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id=1 AND mode='cloudflare' AND epoch=?)");
}

export function retryGateSql(){
 return assertSql("EXISTS (SELECT 1 FROM published_epg_authority a WHERE a.id=1 AND a.mode='d1' AND a.cutover='open' AND a.programme_run_id=? AND a.generation=?) AND NOT EXISTS (SELECT 1 FROM canonical_producer_chain WHERE programme_run_id=? AND owner_state IN ('pending','active'))");
}
export function retryGateParams(fence){
 return [fence.programmeRunId,fence.inputGeneration,fence.programmeRunId];
}

export function ownerAssertSql(){
 return assertSql("EXISTS (SELECT 1 FROM canonical_producer_chain WHERE programme_run_id=? AND owner_epoch=? AND claim_nonce=? AND owner_state='active' AND input_generation=?)");
}
export function ownerAssertParams(fence){
 return [fence.programmeRunId,fence.epoch,fence.nonce,fence.inputGeneration];
}

export function fenceStatements(fence,{ownerOnly=false}={}){
 requireFence(fence);
 if(fence.kind==='dictionary')return [];
 if(fence.kind==='letterboxd')return [[letterboxdEpochSql(),[fence.epoch]]];
 if(fence.kind==='retry')return [[retryGateSql(),retryGateParams(fence)]];
 if(ownerOnly)return [[ownerAssertSql(),ownerAssertParams(fence)]];
 return [[chainGateSql(),chainGateParams(fence)]];
}

export function bindProducerFence(env,gate){
 if(env&&env.producerFence)gate.producerFence=env.producerFence;
 return gate;
}

export function recoveryClassOf(code){
 const transient=new Set(['film_person_unavailable','producer_transport','producer_timeout','producer_storage','producer_marker_unreadable','producer_run_unreadable','producer_slice_commit_failed','producer_strike_commit_failed','producer_cas_lost']);
 const authority=new Set(['film_person_held','film_person_not_open','film_person_not_projector','film_person_transition','film_person_baseline_not_verified','film_person_fence']);
 const terminal=new Set(['producer_store_missing','producer_source_generation_mismatch','canonical_producer_invalid','receipt_schema_missing','receipt_baseline_missing','receipt_baseline_exists','receipt_atomic_required','receipt_conflict','receipt_exists','receipt_readback_required','baseline_over_capacity','film_person_run_mismatch','producer_replan_unavailable']);
 if(code==='receipt_state_conflict')return 'receipt';
 if(transient.has(code))return 'transient';
 if(authority.has(code))return 'authority';
 if(terminal.has(code))return 'terminal';
 return 'fail_closed';
}

export function recoveryBackoffMs(attempts){
 const ticks=[1,2,4,8,8];
 const n=Math.min(Math.max(Number(attempts)||0,0),ticks.length-1);
 return ticks[n]*3600000;
}

export function successorDecision({spentCalls=0,spentStatements=0,estimateCalls,estimateStatements,limitCalls=CHAIN_SUBREQUEST_LIMIT,headroom=CHAIN_HEADROOM,floorCalls=CHAIN_FLOOR_D1_CALLS,floorStatements=CHAIN_FLOOR_D1_STATEMENTS,reserveCalls=CHAIN_HANDOFF_RESERVE_CALLS}={}){
 const eCalls=Math.max(Number(estimateCalls)||0,floorCalls);
 const eStmt=Math.max(Number(estimateStatements)||0,floorStatements);
 if(!Number.isFinite(spentCalls)||!Number.isFinite(spentStatements))return {continue:false,reason:'unmeasured'};
 const capCalls=headroom*limitCalls;
 if(eCalls+reserveCalls>capCalls||eStmt+reserveCalls>capCalls)return {continue:false,reason:'producer_budget_infeasible'};
 if(spentCalls+eCalls+reserveCalls<=capCalls&&spentStatements+eStmt+reserveCalls<=capCalls)return {continue:true};
 return {continue:false,reason:'handoff'};
}
