// AIR-594 / ADR 0208 (Accepted, option B). Canonical Producer outcome reports in the user Events Log (`type: canonical_producer`, «Обогащение каталога»).
// No import: the Worker bundle scopes this file as `CanonicalProducerEvents` in front of the chain, the store and the Workflow, which take from it
//   - the outcome INSERT statements that the terminal batches append LAST, after the run and chain updates and their compare-and-swap assertions, each followed by an
//     asserted `changes()=1` (a missing or conflicting row fails the whole batch, never commits the transition without its outcome);
//   - the schema probe: only a PROVEN absent schema (version below 38 and no table) means "write no outcome"; an unreadable or inconsistent schema is a storage fault;
//   - the fenced `held` row, the bounded fair drain to R2 `events/items/` (create-only, from the frozen row) and the read-only Monitor delivery fact.
// One row per outcome, kept indefinitely (no delete anywhere; the migration refuses it). Outcomes:
//   passed      a completed pass P:g (chain `complete`, the same batch as the run's `passed` claim)          id ...-g<g>-passed
//   stopped     a recorded stop of owner epoch e                                                               id ...-e<e>-stopped
//   superseded  an in-flight chain (pending, active, released) the hourly reconcile superseded               id ...-e<e>-superseded
//   held        an eligible stop whose automatic recovery the reconcile held at a fenced current revision      id ...-e<e>-held
export const PRODUCER_EVENT_TYPE='canonical_producer';
export const OUTCOME_TABLE='canonical_producer_outcome';
export const OUTCOME_SCHEMA_VERSION=38;
export const OUTCOME_DRAIN_MAX=8;
export const OUTCOME_RETRY_MS=3600000;
export const OUTCOME_PUT_TRIES=2;
export const PRODUCER_EVENT_OUTCOMES=Object.freeze(['passed','stopped','superseded','held']);
// The recovery classes `recoverChain` restarts by itself (the same set as PRODUCER_OPEN_CHAIN_PREDICATE).
export const PRODUCER_AUTOMATIC_RECOVERY=Object.freeze(['transient','receipt','authority']);
export const IN_FLIGHT_STATES=Object.freeze(['pending','active','released']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE=/^[a-z][a-z_0-9]{0,79}$/;
const isTime=value=>typeof value==='string'&&value.length>=20&&value.length<=40&&Number.isFinite(Date.parse(value));
const count=value=>{const n=Number(value);return value!==null&&value!==undefined&&value!==''&&Number.isInteger(n)&&n>=0?n:null;};
const iso=ms=>new Date(ms).toISOString();
function fnv(text){
 let h=2166136261>>>0;
 for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;
 return h.toString(16).padStart(8,'0');
}
function outcomeError(code){const error=new Error(code);error.code=code;return error;}

// ---- identity -----------------------------------------------------------------------------------------------------------------
// The programme run part of an id: a canonical UUID without its dashes (lossless), anything else a bounded slug plus a hash of the exact value.
export function programmeToken(programmeRunId){
 const raw=String(programmeRunId||'');
 const lower=raw.toLowerCase();
 if(UUID.test(lower))return lower.replace(/-/g,'');
 return (lower.replace(/[^a-z0-9]/g,'').slice(0,24)||'p')+'-'+fnv(raw);
}
// `n` is the input generation for `passed` and the owner epoch otherwise.
export function outcomeId(programmeRunId,outcome,n){
 if(!PRODUCER_EVENT_OUTCOMES.includes(outcome)||!Number.isInteger(n)||n<0)return null;
 return 'canonical_producer-'+programmeToken(programmeRunId)+(outcome==='passed'?'-g'+n+'-passed':'-e'+n+'-'+outcome);
}
export function producerEventKey(event){return 'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';}

// Eligibility for an automatic restart AT THE STOP (ADR 0208 decision 3): the class `recoverChain` restarts, within its attempt cap and its streak window as they
// stand at the stop. It is a property of the stop, never a promise: when the reconcile later holds it, a separate `held` outcome says so.
export function stopRecovery({recoveryClass,attempts=0,streakStartedAt=null,at,epoch=null,caps={}}={}){
 if(typeof recoveryClass!=='string'||!recoveryClass)return null;
 if(!PRODUCER_AUTOMATIC_RECOVERY.includes(recoveryClass))return 'owner';
 // Every restart opens the next epoch; a stop in the last epoch the cap allows can never be restarted (`restart` answers producer_chain_epoch_cap).
 if(Number.isInteger(caps.epochCap)&&Number.isInteger(epoch)&&epoch+1>caps.epochCap)return 'owner';
 if(recoveryClass==='authority')return 'eligible';
 if(Number.isInteger(caps.attempts)&&(count(attempts)??0)>=caps.attempts)return 'owner';
 const streak=isTime(streakStartedAt)?streakStartedAt:at;
 if(Number.isFinite(caps.windowMs)&&isTime(streak)&&isTime(at)&&Date.parse(at)-Date.parse(streak)>=caps.windowMs)return 'owner';
 return 'eligible';
}

// ---- the outcome INSERT (appended LAST to a terminal batch, then `changes()=1`) ---------------------------------------------------
const COLUMNS='id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,pass_no,unit_count,n_applied,n_noop,n_kept,n_failed,open_at_completion,run_created_at,stopped_by,recovery_class,recovery,prior_state,handoff_count,takeover_count,relaunch_count,reopen_count,rebase_count,recovery_attempts,state,attempts,next_attempt_at,created_at';
// The run of the chain's own (P, g), chosen as `epgRunForGeneration` chooses it (passed, passing, stopped, superseded; then the higher revision; then the run key).
// A LEFT JOIN: a stop before any run row keeps a row with NULL counters, never zeros.
const RUN_OF_CHAIN="LEFT JOIN canonical_producer_run r ON r.rowid=(SELECT x.rowid FROM canonical_producer_run x WHERE x.origin='epg' AND x.source_generation=c.programme_run_id||':'||c.input_generation ORDER BY CASE x.pass_state WHEN 'passed' THEN 3 WHEN 'passing' THEN 2 WHEN 'stopped' THEN 1 ELSE 0 END DESC,x.revision DESC,x.run_key ASC LIMIT 1)";
// `at` of a pass is the run's own completion (`completed_at` of the passed run, written by commitPassComplete); every other outcome is the batch time. The batch time
// is also the enqueue time (`created_at`) and the first delivery time (`next_attempt_at`) of every row.
const SELECT_PART="SELECT ?,c.programme_run_id,c.input_generation,?,c.owner_epoch,CASE WHEN ?='passed' THEN r.completed_at ELSE ? END,CASE WHEN r.run_key IS NULL THEN 0 ELSE 1 END,r.pass_no,r.unit_count,r.n_applied,r.n_noop,r.n_kept,r.n_failed,"
 +"CASE WHEN ?='passed' THEN r.open_at_completion ELSE NULL END,r.created_at,"
 +"CASE WHEN ? IN ('stopped','held') THEN c.stopped_by ELSE NULL END,CASE WHEN ? IN ('stopped','held') THEN c.recovery_class ELSE NULL END,?,?,"
 +"c.handoff_count,c.takeover_count,c.relaunch_count,c.reopen_count,c.rebase_count,c.recovery_attempts,'pending',0,?,? FROM canonical_producer_chain c "+RUN_OF_CHAIN;
// `where` names the chain row the outcome is read from, AFTER the batch's own update of it: its state (and, for supersede and held, its exact revision).
// `extra` is an optional SQL condition and its parameters (the held guard).
// A `passed` row also REQUIRES the passed run of that (P, g) (pass state `passed`, its applied claim equal to its source generation, a completion time): without
// it the insert selects no row and the batch's `changes()=1` fails it. The LEFT JOIN with NULL counters is for stops, never a proof of a pass.
const PASSED_RUN="r.pass_state='passed' AND r.applied_generation=r.source_generation AND r.completed_at IS NOT NULL";
export function outcomeInsert({id,outcome,at,recovery=null,priorState=null,programmeRunId,epoch,state,revision=null,extra=null}){
 if(!id||!PRODUCER_EVENT_OUTCOMES.includes(outcome)||!isTime(at))throw outcomeError('film_person_invalid');
 const where=' WHERE c.programme_run_id=? AND c.owner_epoch=? AND c.owner_state=?'+(revision===null?'':' AND c.revision=?')+(outcome==='passed'?' AND '+PASSED_RUN:'')+(extra?' AND '+extra.sql:'');
 return ['INSERT INTO canonical_producer_outcome ('+COLUMNS+') '+SELECT_PART+where,
  [id,outcome,outcome,at,outcome,outcome,outcome,recovery,priorState,at,at,programmeRunId,epoch,state,...(revision===null?[]:[revision]),...(extra?extra.params:[])]];
}

// ---- the schema probe ---------------------------------------------------------------------------------------------------------
// ONE statement. The schema contract version must be a real integer (a missing contract row, a NULL or a non-integer is never read as an old version).
// `absent`: version below 38 and no object of the outbox at all, proven. `active`: version 38 or later and the whole outbox as 0038 creates it: the STRICT table with
// every column, the pending index and the six triggers (marker fences, birth shape, no delete, immutable payload, one-way delivery). Anything else throws
// `producer_outcome_schema_invalid` (inconsistent or malformed); a failed read throws `producer_outcome_schema_unreadable`. Neither is ever read as "absent".
export const OUTCOME_TRIGGERS=Object.freeze(['canonical_producer_outcome_insert_open','canonical_producer_outcome_update_open','canonical_producer_outcome_insert_shape',
 'canonical_producer_outcome_no_delete','canonical_producer_outcome_immutable','canonical_producer_outcome_delivery']);
export const OUTCOME_COLUMNS=Object.freeze([...'id,programme_run_id,input_generation,outcome,owner_epoch,at,run_recorded,pass_no,unit_count,n_applied,n_noop,n_kept,n_failed,open_at_completion,run_created_at,stopped_by,recovery_class,recovery,prior_state,handoff_count,takeover_count,relaunch_count,reopen_count,rebase_count,recovery_attempts,state,attempts,next_attempt_at,delivered_at,created_at'.split(',')]);
const PROBE_SQL="SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT typeof(version) FROM schema_contract WHERE id=1) AS version_type,"
 +"(SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'canonical_producer_outcome%') AS objects,"
 +"(SELECT sql FROM sqlite_master WHERE type='table' AND name='canonical_producer_outcome') AS table_sql,"
 +"(SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='canonical_producer_outcome_pending' AND tbl_name='canonical_producer_outcome') AS indexes,"
 +"(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='canonical_producer_outcome' AND name IN ("+OUTCOME_TRIGGERS.map(name=>"'"+name+"'").join(',')+")) AS triggers";
export function outcomeSchemaVerdict(row){
 if(!row||typeof row!=='object')return 'invalid';
 if(row.version_type!=='integer'||!Number.isInteger(Number(row.version))||row.version===null)return 'invalid';
 const version=Number(row.version),objects=Number(row.objects);
 if(!Number.isInteger(objects))return 'invalid';
 if(version<OUTCOME_SCHEMA_VERSION)return objects===0?'absent':'invalid';
 const sql=typeof row.table_sql==='string'?row.table_sql:'';
 const whole=/\)\s*STRICT\s*$/i.test(sql)&&OUTCOME_COLUMNS.every(column=>new RegExp('(^|[\\s,(])'+column+'\\s+(TEXT|INTEGER)\\b').test(sql));
 return whole&&Number(row.indexes)===1&&Number(row.triggers)===OUTCOME_TRIGGERS.length&&objects===1+1+OUTCOME_TRIGGERS.length?'active':'invalid';
}
export async function readOutcomeSchema(env){
 let row;
 try{row=await env.DB.prepare(PROBE_SQL).first();}catch{throw outcomeError('producer_outcome_schema_unreadable');}
 const verdict=outcomeSchemaVerdict(row);
 if(verdict==='invalid')throw outcomeError('producer_outcome_schema_invalid');
 return verdict;
}

// ---- the event of one row (frozen: built only from the immutable columns) ------------------------------------------------------
export function outcomeEvent(row){
 if(!row||typeof row!=='object'||!PRODUCER_EVENT_OUTCOMES.includes(row.outcome)||typeof row.id!=='string'||!isTime(row.at))return null;
 const recorded=Number(row.run_recorded)===1;
 const applied=recorded?count(row.n_applied):null,noop=recorded?count(row.n_noop):null,kept=recorded?count(row.n_kept):null,failed=recorded?count(row.n_failed):null;
 const parts=[applied,noop,kept,failed];
 const processed=parts.every(value=>value!==null)?parts.reduce((a,b)=>a+b,0):null;
 const unitCount=recorded?count(row.unit_count):null,passNo=recorded?count(row.pass_no):null;
 // All units have a durable outcome only when the pass claimed its generation; otherwise the remainder is known only in pass 1, whose counters advance with the
 // cursor exactly (a replayed pass restarts the cursor and keeps the counters).
 let remaining=null;
 if(row.outcome==='passed'&&recorded)remaining=0;
 else if(recorded&&passNo===1&&unitCount!==null&&processed!==null&&processed<=unitCount)remaining=unitCount-processed;
 const startedAt=recorded&&isTime(row.run_created_at)?iso(Date.parse(row.run_created_at)):null;
 const at=iso(Date.parse(row.at));
 const durationMs=startedAt&&Date.parse(at)>=Date.parse(startedAt)?Date.parse(at)-Date.parse(startedAt):null;
 const stopCode=CODE.test(String(row.stopped_by||''))?row.stopped_by:null;
 return {
  id:row.id,type:PRODUCER_EVENT_TYPE,at,outcome:row.outcome,
  programme:programmeToken(row.programme_run_id).slice(0,8),inputGeneration:count(row.input_generation),
  runRecorded:recorded,passNo,unitCount,processed,applied,noop,kept,failed,remaining,openResults:row.outcome==='passed'&&recorded?count(row.open_at_completion):null,startedAt,durationMs,
  reason:row.outcome==='superseded'?'newer_publication':stopCode,
  recoveryClass:CODE.test(String(row.recovery_class||''))?row.recovery_class:null,
  recovery:['eligible','owner','none'].includes(row.recovery)?row.recovery:null,
  ...(row.outcome==='superseded'&&IN_FLIGHT_STATES.includes(row.prior_state)?{priorState:row.prior_state}:{}),
  chain:{epoch:count(row.owner_epoch),handoffs:count(row.handoff_count),takeovers:count(row.takeover_count),relaunches:count(row.relaunch_count),
   reopens:count(row.reopen_count),rebases:count(row.rebase_count),recoveryAttempts:count(row.recovery_attempts)},
 };
}

// ---- delivery (the hourly reconcile only) --------------------------------------------------------------------------------------
// At most OUTCOME_DRAIN_MAX due pending rows a tick, oldest retry first (indexed). Each is put create-only under the key of its frozen id and `at` (a put that finds
// the key counts as delivered), then marked `delivered` by a compare-and-swap on `attempts`. A failed put moves the row one hour back (attempts + 1), so a row that
// keeps failing cannot starve the others. A pending row is never evicted; no row is ever deleted. R2 never blocks the Producer: nothing here is on a Producer path.
async function putEvent(env,event){
 for(let attempt=0;attempt<OUTCOME_PUT_TRIES;attempt++){
  try{
   await env.BUCKET.put(producerEventKey(event),JSON.stringify(event),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});
   return true;
  }catch{/* one more try, then the next tick */}
 }
 return false;
}
export async function drainOutcomes(env,{nowMs=Date.now(),limit=OUTCOME_DRAIN_MAX}={}){
 const stats={taken:0,delivered:0,failed:0,conflicts:0};
 if(typeof env?.BUCKET?.put!=='function')return {...stats,skipped:'bucket_unavailable'};
 const now=iso(nowMs),cap=Math.max(1,Math.min(OUTCOME_DRAIN_MAX,Number(limit)||OUTCOME_DRAIN_MAX));
 const due=(await env.DB.prepare("SELECT * FROM canonical_producer_outcome WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,at,id LIMIT ?").bind(now,cap).all())?.results||[];
 for(const row of due){
  stats.taken++;
  const event=outcomeEvent(row);
  const ok=event?await putEvent(env,event):false;
  const update=ok
   ?["UPDATE canonical_producer_outcome SET state='delivered',delivered_at=?,attempts=attempts+1 WHERE id=? AND state='pending' AND attempts=? RETURNING id",[now,row.id,row.attempts]]
   :["UPDATE canonical_producer_outcome SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND state='pending' AND attempts=? RETURNING id",[iso(nowMs+OUTCOME_RETRY_MS),row.id,row.attempts]];
  // The compare-and-swap on `attempts`: the row it moved comes back (RETURNING); none back means another tick moved it first (or the marker is not open).
  let changed=0;
  try{changed=(await env.DB.prepare(update[0]).bind(...update[1]).first())?1:0;}catch{changed=0;}
  if(ok)stats.delivered++;else stats.failed++;
  if(changed!==1)stats.conflicts++;
 }
 return stats;
}

// ---- the read-only Monitor fact (ADR 0208 decision 7: visibility only, no health input, no alert) -------------------------------
export async function readOutcomeDelivery(env){
 let schema;
 try{schema=await readOutcomeSchema(env);}catch(error){return {active:null,readable:false,reason:error?.code||'producer_outcome_schema_unreadable'};}
 if(schema==='absent')return {active:false,readable:true,pending:null,oldestPendingAt:null};
 try{
  const row=await env.DB.prepare("SELECT COUNT(*) AS pending,MIN(at) AS oldest FROM canonical_producer_outcome WHERE state='pending'").first();
  return {active:true,readable:true,pending:count(row?.pending)??0,oldestPendingAt:isTime(row?.oldest)?iso(Date.parse(row.oldest)):null};
 }catch{return {active:true,readable:false,reason:'producer_outcome_unreadable'};}
}
