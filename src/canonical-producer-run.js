// AIR-374 S4-1 (ADR 0128, Accepted as DESIGN). The PURE decision layer of the durable EPG canonical producer pass. DORMANT: nothing in the Worker imports this module, it is not bundled (build.mjs is unchanged), `epgSync` does not call
// it and no route, job, cron or Task does. It holds NO SQL and does NO I/O: every input (a run row, a result row, a prerequisite snapshot, a clock) is INJECTED and every output is the next value of the fields S4-2 will store and S4-3 will
// write. The only imports are the receipt module's pure helpers (`canonicalJson`, `digestOf`, `backoffMs`, `RETRY_POLICY`), so the retry policy has ONE definition.
// What is here, by ADR 0128 decision:
//   6  `classifyProducerError` and ERROR_CLASSES: every code the planners, adapters and writers can raise, classed ONCE: systemic (pass-level stop), unit-specific (strike-eligible), permanent refusal, recoverable refusal, named kept outcome; an
//      unknown code is `unclassified` and stops the pass. A test fails when a code is added in the producer path without a class.
//   7  `strikeStep` and `strikeViolation`: the strike identity state machine (monotone +1 while the identity is unchanged; reset only on success of the unit, a new identity starting at 1, the third-strike commit or a pass_no increase;
//      a systemic failure touches no strike).
//   2  `planFingerprint`, `resumeDecision`, `resumeIndex`, `compareKeys`: the plan identity (sha256 of canonical JSON of {planVersion, origin, event, ordered (kind, id, unitDigest)}) and the resume-or-replay decision. The unit digest is the
//      SOURCE-ONLY digest (`dictionaryUnitDigest` here; the Film, Person and credit digests are the existing adapter functions, asserted source-only by the S4-1 test). `prereqStamp` is the SEPARATE prerequisite digest.
//   5  `retryDecision`, `afterRetry`, `failureWrite`, `resultRow`, `canTransition`: the result-row state machine and the retry and revalidation decision (one live row per unit; terminal never reopens; a recoverable refusal is revalidated by
//      stamp and is settled only after write proof).
//   11 `canonicalFreshness`: current, lagging, partial or unknown; equality with a PASSED pass and no live `film_facts` result is the only way to `current`.
//   4  `mintDictionaryVersion`: the dictionary version decision over an injected latest row (equal digest reuses; otherwise the next seq with its prev_seq).
//   12 `ownerReviewGuard`: the three-case owner-review decision.
// Nothing here authorizes or performs a production read or write; the table, the store and the driver are S4-2, S4-3 and S4-4.
import {RETRY_POLICY,backoffMs,canonicalJson,digestOf} from './canonical-receipts.js';

export const PRODUCER_PLAN_VERSION=1;
export const STRIKE_LIMIT=3;
// The order of the kinds inside one plan: the Film facts of ADR 0125, then the Person states and the credits of ADR 0126. The cursor key is (kind rank, id).
export const KIND_RANK=Object.freeze({film_facts:1,person_mutation:2,person_state:3,film_credits:4});
export const ORIGINS=Object.freeze(['epg','dictionary']);
export const RESULT_STATES=Object.freeze(['open','refused_permanent','refused_recoverable','settled','superseded','abandoned']);
export const LIVE_STATES=Object.freeze(['open','refused_permanent','refused_recoverable']);
export const TERMINAL_STATES=Object.freeze(['settled','superseded','abandoned']);
export const CLASS=Object.freeze({SYSTEMIC:'systemic',UNIT:'unit_specific',PERMANENT:'refused_permanent',RECOVERABLE:'refused_recoverable',KEPT:'kept_outcome',UNCLASSIFIED:'unclassified'});

const DIGEST=/^[0-9a-f]{64}$/;
const CODE=/^[a-z][a-z_0-9]{0,79}$/;
const KIND=/^[a-z_]{1,40}$/;
const IDENTIFIER=/^[A-Za-z0-9:._/=+@-]{1,200}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fail(code){const error=new Error(code);error.code=code;return error;}
const invalid=()=>fail('film_person_invalid');

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 6: the error classification table (one row per code, fail-closed).
// ---------------------------------------------------------------------------------------------------------------------------------
const rows=(cls,codes)=>codes.map(code=>[code,cls]);
export const ERROR_CLASSES=Object.freeze(Object.fromEntries([
 // SYSTEMIC: a PASS-LEVEL STOP, never a strike, never a unit result. The cursor and the strike count stay as they are.
 ...rows(CLASS.SYSTEMIC,[
  'film_person_unavailable','film_person_held','film_person_not_open','film_person_fence','film_person_run_mismatch','film_person_not_projector','film_person_transition','film_person_baseline_not_verified',
  // The producer store (S4-3): a missing table, an unreadable run row, a lost compare-and-set, a failed slice or strike commit, the marker read, transport, timeout and storage.
  'producer_store_missing','producer_run_unreadable','producer_cas_lost','producer_slice_commit_failed','producer_strike_commit_failed','producer_marker_unreadable','producer_transport','producer_timeout','producer_storage',
  // The receipt layer and the producers module, which own their own retry: a protocol or store problem is never the unit's fault. `producer_replan_unavailable` is raised only by a receipt replay (the receipt owns that retry).
  'producer_replan_unavailable','canonical_producer_invalid','receipt_schema_missing','receipt_baseline_missing','receipt_baseline_exists','receipt_atomic_required','receipt_conflict','receipt_exists','receipt_readback_required','receipt_state_conflict','baseline_over_capacity',
  // The owner-review check itself cannot be performed (decision 12 b).
  'owner_review_check_failed',
 ]),
 // UNIT-SPECIFIC execution failures, strike-eligible. The first two are re-planned once, immediately, because the other writer may have moved.
 ...rows(CLASS.UNIT,['film_person_revision_conflict','film_person_precondition','identity_collision','person_role_collision','credit_ordinal_conflict','film_person_identity_conflict','film_person_data_conflict','film_person_redirect_conflict','film_person_retirement_history']),
 // PERMANENT input refusals: a pure function of the unit's own input, cleared only by a changed unit digest.
 ...rows(CLASS.PERMANENT,['film_person_invalid','film_person_bounded','dictionary_source_ambiguous']),
 // RECOVERABLE prerequisite refusals: they depend on canonical state another writer may legitimately change without the source digest changing.
 ...rows(CLASS.RECOVERABLE,['no_identity_row','needs_trusted_tmdb_id','film_person_reference','film_person_redirect','dictionary_identity_ambiguous','owner_review_inconsistent']),
 // NAMED KEPT OUTCOMES of the dictionary and credit layers: counted by reason, no result row, no retry (a retry cannot change them).
 ...rows(CLASS.KEPT,['owner_kept','reviewed_kept','unranked_kept','identity_mismatch','snapshot_already_applied','absent','credits_absent_from_source']),
 ...rows(CLASS.UNCLASSIFIED,['unclassified']),
]));
// A unit-specific code that is re-planned once, at once, before it counts as a strike.
export const REPLAN_FIRST=Object.freeze(new Set(['film_person_revision_conflict','film_person_precondition']));
// The planner outcomes (not thrown) that carry a refusal code under another name.
export const OUTCOME_CODES=Object.freeze({redirected:'film_person_redirect'});

// The class of a code. An unknown code, or anything that is not a lowercase identifier, is `unclassified`.
export function classOfCode(code){
 return typeof code==='string'&&Object.hasOwn(ERROR_CLASSES,code)?ERROR_CLASSES[code]:CLASS.UNCLASSIFIED;
}
// `error` is a thrown value or a code. An error with NO string code is a transport or storage failure of the existing drivers (`film_person_unavailable`, systemic). Returns
// {code, class, action, replanFirst}. `action`: stop (systemic and unclassified), strike, refuse_permanent, refuse_recoverable, keep.
export function classifyProducerError(error){
 const raw=typeof error==='string'?error:error&&typeof error==='object'?error.code:undefined;
 const code=typeof raw==='string'&&CODE.test(raw)?raw:typeof raw==='string'?'unclassified':'film_person_unavailable';
 const cls=classOfCode(code);
 const action={[CLASS.SYSTEMIC]:'stop',[CLASS.UNCLASSIFIED]:'stop',[CLASS.UNIT]:'strike',[CLASS.PERMANENT]:'refuse_permanent',[CLASS.RECOVERABLE]:'refuse_recoverable',[CLASS.KEPT]:'keep'}[cls];
 return {code:cls===CLASS.UNCLASSIFIED?'unclassified':code,class:cls,action,replanFirst:REPLAN_FIRST.has(code)};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cursor keys and plan identity (decisions 2, 3 and 5).
// ---------------------------------------------------------------------------------------------------------------------------------
const rankOf=kind=>{const rank=KIND_RANK[kind];if(!rank)throw invalid();return rank;};
const checkUnit=unit=>{
 if(!plain(unit)||typeof unit.kind!=='string'||!KIND.test(unit.kind)||typeof unit.id!=='string'||!unit.id||unit.id.length>200)throw invalid();
 rankOf(unit.kind);
};
// The cursor key order: (kind rank, id by code unit, as the planners sort).
export function compareKeys(a,b){
 checkUnit(a);checkUnit(b);
 const ra=rankOf(a.kind),rb=rankOf(b.kind);
 return ra!==rb?(ra<rb?-1:1):a.id<b.id?-1:a.id>b.id?1:0;
}
// Units must come in STRICT key order (a duplicate or an unordered plan is refused, never sorted away).
export function assertOrdered(units){
 if(!Array.isArray(units))throw invalid();
 for(let i=0;i<units.length;i++){checkUnit(units[i]);if(i>0&&compareKeys(units[i-1],units[i])>=0)throw invalid();}
 return units;
}
// The first unit STRICTLY AFTER the cursor ({kind,id} or null/undefined for the start), in the recomputed ordered plan.
export function resumeIndex(units,cursor){
 assertOrdered(units);
 if(cursor===null||cursor===undefined)return 0;
 checkUnit(cursor);
 let index=0;
 while(index<units.length&&compareKeys(units[index],cursor)<=0)index++;
 return index;
}
// THE ORDERED PLAN: one list of ENTRIES in (kind rank, id) order covering the units to apply AND the units the planner refused. An entry is {kind, id, unitDigest} and, for a refused unit, `refusal`: the code of the planner's refusal (a permanent or a recoverable
// code of the table). A refused unit is visited by the pass like any other (its durable result is written at first observation and the cursor then passes it), so the cursor never passes an unrecorded unit, a change of its source moves the fingerprint (and supersedes its
// live result), and a replay is reproducible. For a plan with no refusal the entries carry no `refusal` key and the fingerprint is exactly the ADR 0128 formula.
// sha256(canonicalJson({planVersion, origin, event, entries:[{kind,id,unitDigest[,refusal]}]})) under the key `units`. The ceiling, the slice size, the retry caps and the marker generation are NOT part of it.
export async function planFingerprint({planVersion=PRODUCER_PLAN_VERSION,origin,event,units}={}){
 if(!Number.isInteger(planVersion)||planVersion<1||!ORIGINS.includes(origin)||typeof event!=='string'||!event||event.length>300)throw invalid();
 assertOrdered(units);
 const list=units.map(unit=>{
  if(!DIGEST.test(unit.unitDigest||''))throw invalid();
  if(unit.refusal!==undefined&&![CLASS.PERMANENT,CLASS.RECOVERABLE].includes(classOfCode(unit.refusal)))throw invalid();
  return {kind:unit.kind,id:unit.id,unitDigest:unit.unitDigest,...(unit.refusal!==undefined?{refusal:unit.refusal}:{})};
 });
 return digestOf({planVersion,origin,event,units:list});
}
// Builds the ordered entries from the units to apply ([{kind,id,unitDigest}], already digested by the adapters) and the planner's `refused` list ([{kind,id,code,source}]): the refused units get their source digest and a `refusal` code, the two lists are merged in
// (kind rank, id) order, and a key present in both (or twice) refuses the plan. Nothing is dropped: the result has exactly units + refused entries.
export async function buildPlanEntries({units=[],refused=[]}={}){
 if(!Array.isArray(units)||!Array.isArray(refused))throw invalid();
 const entries=units.map(unit=>{checkUnit(unit);if(unit.refusal!==undefined)throw invalid();return {kind:unit.kind,id:unit.id,unitDigest:unit.unitDigest};});
 for(const item of refused){
  checkUnit(item);
  if(![CLASS.PERMANENT,CLASS.RECOVERABLE].includes(classOfCode(item.code)))throw invalid();
  entries.push({kind:item.kind,id:item.id,unitDigest:await refusedUnitDigest(item),refusal:item.code});
 }
 entries.sort(compareKeys);
 return assertOrdered(entries);
}
// The SOURCE-ONLY digest of a dictionary unit: the normalised curated entry (aliases and sources included) and nothing read from the canonical store. The writer input of the dictionary layer depends on the stored Film (contract version,
// kept outcomes), so its adapter digest cannot be the unit digest; the S4-1 test shows it moves with stored state while this one does not.
export async function dictionaryUnitDigest(unit){
 if(!plain(unit)||typeof unit.id!=='string'||!unit.id.startsWith('film:')||!plain(unit.entry))throw invalid();
 return digestOf({operation:'dictionary_unit',id:unit.id,entry:unit.entry});
}
// The digest of a refused unit's incoming source (decision 12 d: "the digest of the incoming list"), for a planner that reports `refused:[{kind,id,code,source}]`.
export async function refusedUnitDigest({kind,id,source}){
 checkUnit({kind,id});
 let digest;
 try{digest=await digestOf({operation:'refused_unit',kind,id,source:source===undefined?null:source});}
 catch{digest=await digestOf({operation:'refused_unit',kind,id,unserialisable:true});}
 return digest;
}
// Same stored fingerprint: resume after the stored cursor. Anything else: replay from the start in ONE compare-and-set (pass_no + 1, the new fingerprint, cursor reset, strikes cleared); open results are revalidated lazily, never rewritten here.
export function resumeDecision({stored,fingerprint,units}={}){
 if(!plain(stored)||!DIGEST.test(stored.fingerprint||'')||!DIGEST.test(fingerprint||'')||!Number.isInteger(stored.pass_no)||stored.pass_no<1)throw invalid();
 const cursor=stored.cursor_kind===null||stored.cursor_kind===undefined?null:{kind:stored.cursor_kind,id:stored.cursor_id};
 if(stored.fingerprint===fingerprint)return {action:'resume',pass_no:stored.pass_no,startIndex:resumeIndex(units,cursor)};
 if(stored.pass_no>=10000)throw fail('producer_cas_lost');
 return {action:'replay',pass_no:stored.pass_no+1,fingerprint,startIndex:0,cursor_kind:null,cursor_id:null,strike:{...NO_STRIKE},pass_state:'passing',stopped_by:null};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 7: the strike identity state machine.
// ---------------------------------------------------------------------------------------------------------------------------------
export const NO_STRIKE=Object.freeze({strike_kind:null,strike_id:null,strike_digest:null,strike_class:null,strike_count:0});
const strikeOf=run=>({strike_kind:run.strike_kind??null,strike_id:run.strike_id??null,strike_digest:run.strike_digest??null,strike_class:run.strike_class??null,strike_count:run.strike_count??0});
const sameIdentity=(a,b)=>a.strike_kind===b.strike_kind&&a.strike_id===b.strike_id&&a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class;
const sameUnit=(s,unit)=>s.strike_count>0&&s.strike_kind===unit.kind&&s.strike_id===unit.id;
function checkRun(run){
 if(!plain(run))throw invalid();
 const s=strikeOf(run);
 if(!Number.isInteger(s.strike_count)||s.strike_count<0||s.strike_count>=STRIKE_LIMIT)throw invalid();
 if((s.strike_count===0)!==(s.strike_id===null)||(s.strike_count===0&&(s.strike_kind!==null||s.strike_digest!==null||s.strike_class!==null)))throw invalid();
 return s;
}
const keyFields=unit=>({cursor_kind:unit.kind,cursor_id:unit.id});
// run: the stored run row fields (cursor_kind, cursor_id, pass_no, pass_state, stopped_by, strike_*). event:
//   {type:'unit_failed', unit:{kind,id,digest}, error}   the unit's step raised `error` (a thrown value or a code), classified here;
//   {type:'unit_done', unit:{kind,id}}                   the unit's outcome is DURABLE (applied, no-op, kept, or its refusal result written): the cursor passes it;
//   {type:'systemic', error}                             a failure of the pass itself (the slice commit, the strike commit, the marker): a stop;
//   {type:'plan_changed'}                                the fingerprint moved: pass_no + 1, the cursor reset, strikes cleared.
// Returns {action, run, result?} where `run` is the next value of the run-row fields this step touches. 'stop' touches NO strike field; 'strike' touches ONLY the strike fields.
export function strikeStep(run,event){
 const strike=checkRun(run);
 if(!plain(event))throw invalid();
 if(event.type==='plan_changed'){
  return {action:'replay',run:{...run,...NO_STRIKE,cursor_kind:null,cursor_id:null,pass_no:run.pass_no+1,pass_state:'passing',stopped_by:null}};
 }
 if(event.type==='systemic'||event.type==='unit_failed'){
  const verdict=classifyProducerError(event.error);
  if(event.type==='systemic'&&verdict.action!=='stop')return stop(run,'unclassified');
  if(verdict.action==='stop')return stop(run,verdict.code);
  const unit=event.unit;checkUnit(unit);
  if(verdict.action==='keep')return done(run,strike,unit);
  if(verdict.action==='refuse_permanent'||verdict.action==='refuse_recoverable'){
   // A named refusal is proven at first observation: its result row and the cursor move go in one slice commit, no strike. A strike of THIS unit is cleared by that same move; another unit's strike is untouched.
   const next=done(run,strike,unit);
   return {...next,action:verdict.action,result:{state:verdict.class,code:verdict.code,attempts:1}};
  }
  if(!DIGEST.test(unit.digest||''))throw invalid();
  const identity={strike_kind:unit.kind,strike_id:unit.id,strike_digest:unit.digest,strike_class:verdict.code};
  const count=sameIdentity(strike,identity)&&strike.strike_count>0?strike.strike_count+1:1;
  if(count>=STRIKE_LIMIT){
   // The third proven failure of the same identity: ONE batch writes the result row, advances the cursor past the unit and clears the strike.
   return {action:'third_strike',run:{...run,...NO_STRIKE,...keyFields(unit)},result:{state:'open',code:verdict.code,attempts:STRIKE_LIMIT}};
  }
  return {action:'strike',run:{...run,...identity,strike_count:count}};
 }
 if(event.type==='unit_done'){checkUnit(event.unit);return done(run,strike,event.unit);}
 throw invalid();
}
function stop(run,code){
 // A systemic stop records where it stopped and touches NO strike column, the cursor included.
 return {action:'stop',run:{...run,pass_state:'stopped',stopped_by:code}};
}
function done(run,strike,unit){
 if(run.cursor_kind!==null&&run.cursor_kind!==undefined&&compareKeys({kind:run.cursor_kind,id:run.cursor_id},unit)>=0)throw invalid();
 const clears=sameUnit(strike,unit);
 return {action:'unit_done',run:{...run,...(clears?NO_STRIKE:{}),...keyFields(unit)}};
}
// The invariant the SQL trigger of S4-2 must enforce, written independently of the transition function so a test can check any pair of rows. cause: 'failure' (the strike columns are written by a strike-eligible failure),
// 'unit_done' / 'third_strike' / 'plan_changed' (the allowed resets), 'systemic' (a stop), 'cursor' (the cursor moved for another unit). Returns null when the step is legal, otherwise a reason.
export function strikeViolation(prev,next,cause){
 const a=strikeOf(prev),b=strikeOf(next);
 const same=a.strike_kind===b.strike_kind&&a.strike_id===b.strike_id&&a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class&&a.strike_count===b.strike_count;
 if(cause==='systemic')return same?null:'a systemic stop touched a strike column';
 if((b.strike_count===0)!==(b.strike_id===null))return 'strike columns disagree with the count';
 if(cause==='cursor')return same?null:'a cursor move for another unit touched a strike column';
 if(same)return null;
 if(b.strike_count===0){
  return cause==='unit_done'||cause==='third_strike'||cause==='plan_changed'?null:'a reset outside the three allowed causes';
 }
 if(cause!=='failure')return 'a strike was written by a cause that is not a failure';
 if(a.strike_count>0&&sameIdentity(a,b)){
  if(b.strike_count===a.strike_count+1)return b.strike_count>=STRIKE_LIMIT?'a strike count at the limit is never stored':null;
  return b.strike_count<a.strike_count?'a decrement of an active strike':'a skip of a strike count';
 }
 return b.strike_count===1?null:'a new strike identity must start at 1';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 5 and 8: the result row, its state machine and the retry and revalidation decisions.
// ---------------------------------------------------------------------------------------------------------------------------------
export const canTransition=(from,to)=>LIVE_STATES.includes(from)&&RESULT_STATES.includes(to);
const iso=ms=>new Date(ms).toISOString();
const timeOf=value=>{const ms=Date.parse(value);if(!Number.isFinite(ms))throw invalid();return ms;};
export const nextAttemptAt=(nowMs,attempts)=>iso(nowMs+backoffMs(attempts));
// The longest backoff of the receipt policy: where an UNCHANGED recoverable refusal is moved to.
export const lastBackoffMs=()=>RETRY_POLICY.backoffMs[RETRY_POLICY.backoffMs.length-1];

// The schema CHECKs of canonical_producer_unit_result (ADR sketch) as one function: a row the SQL would refuse cannot be produced here.
export function assertResultRow(row){
 if(!plain(row)||!ORIGINS.includes(row.origin)||typeof row.run_key!=='string'||!row.run_key||row.run_key.length>160)throw invalid();
 if(!Number.isInteger(row.pass_no)||row.pass_no<1||row.pass_no>10000||!KIND.test(row.kind||'')||typeof row.unit_id!=='string'||!row.unit_id||row.unit_id.length>200)throw invalid();
 if(!DIGEST.test(row.fingerprint||'')||!DIGEST.test(row.unit_digest||'')||!RESULT_STATES.includes(row.state)||!['unit','receipt'].includes(row.retry_owner)||!CODE.test(row.code||''))throw invalid();
 if(!Number.isInteger(row.attempts)||row.attempts<1||row.attempts>16)throw invalid();
 const has=value=>value!==null&&value!==undefined;
 if(has(row.prereq_stamp)&&!DIGEST.test(row.prereq_stamp))throw invalid();
 // The code's CLASS must fit the state: a systemic, kept or unknown code never makes a unit row (it stops the pass or is only counted); an execution failure (`open`) carries a unit-specific code (a receipt-owned row may also carry a receipt error
 // class the table does not know); a permanent refusal a permanent code; a recoverable refusal a recoverable one. A terminal row keeps the code it was settled with.
 const cls=classOfCode(row.code);
 if(row.state==='open'&&!(cls===CLASS.UNIT||(row.retry_owner==='receipt'&&cls===CLASS.UNCLASSIFIED&&row.code!=='unclassified')))throw invalid();
 if(row.state==='refused_permanent'&&cls!==CLASS.PERMANENT)throw invalid();
 if(row.state==='refused_recoverable'&&cls!==CLASS.RECOVERABLE)throw invalid();
 if((row.retry_owner==='receipt')!==has(row.request_id))throw invalid();
 if(row.retry_owner!=='unit'&&has(row.next_attempt_at))throw invalid();
 if(row.state==='open'&&row.retry_owner!=='receipt'&&!has(row.next_attempt_at))throw invalid();
 if(row.state==='refused_permanent'&&(has(row.next_attempt_at)||has(row.prereq_stamp)))throw invalid();
 if(row.state==='refused_recoverable'&&(row.retry_owner!=='unit'||!has(row.next_attempt_at)||!has(row.prereq_stamp)))throw invalid();
 if(TERMINAL_STATES.includes(row.state)!==has(row.settled_at))throw invalid();
 return row;
}
// A NEW result row from a durable outcome. `at` is the write clock. Third-strike and receipt rows take their schedule from the receipt policy; a permanent refusal has none and no stamp; a recoverable one has one owner (`unit`), a schedule and a stamp.
export function resultRow({origin,runKey,passNo,fingerprint,unit,state,code,retryOwner='unit',requestId=null,attempts=1,prereqStamp=null,at}={}){
 checkUnit(unit);
 const now=timeOf(at);
 const schedule=retryOwner==='unit'&&(state==='open'||state==='refused_recoverable')?nextAttemptAt(now,attempts):null;
 return assertResultRow({
  origin,run_key:runKey,pass_no:passNo,kind:unit.kind,unit_id:unit.id,fingerprint,unit_digest:unit.digest,state,retry_owner:retryOwner,request_id:requestId,code,attempts,
  prereq_stamp:state==='refused_recoverable'?prereqStamp:null,next_attempt_at:schedule,settled_by:null,created_at:at,updated_at:at,settled_at:null,
 });
}
const supersede=(row,reason,at)=>({action:'supersede',patch:{state:'superseded',settled_by:reason,settled_at:at,updated_at:at,next_attempt_at:null}});
// What a failure write does to the LIVE row of the same unit (decision 5): the row of another digest is superseded first (`source_changed`) and the new row inserted; the live row of the SAME digest keeps its key and takes the new
// classification (attempts incremented only for an execution failure). `live` is the row or null; `incoming` the argument of `resultRow`. Returns {supersede?, insert?|update?}: statements for one slice batch, in order.
export function failureWrite(live,incoming){
 const row=resultRow(incoming);
 if(live===null||live===undefined)return {insert:row};
 assertResultRow(live);
 if(!LIVE_STATES.includes(live.state)||live.kind!==row.kind||live.unit_id!==row.unit_id||live.origin!==row.origin||live.run_key!==row.run_key)throw invalid();
 if(live.unit_digest!==row.unit_digest)return {supersede:{key:keyOfRow(live),...supersede(live,'source_changed',row.created_at)},insert:row};
 // The SAME digest: the live row keeps its key and its ONE retry owner. A receipt-owned row is never reclassified here (the receipt owns its schedule and its settlement: this write is refused until the receipt owner settles it), and the owner of a row never changes.
 if(live.retry_owner==='receipt')return {none:'receipt_owned'};
 if(row.retry_owner!==live.retry_owner)throw invalid();
 const bump=row.state==='open'?live.attempts+1:live.attempts;
 const schedule=row.state==='open'?nextAttemptAt(timeOf(row.created_at),Math.min(bump,16)):row.state==='refused_recoverable'?row.next_attempt_at:null;
 const patch={state:row.state,code:row.code,attempts:Math.min(bump,16),prereq_stamp:row.prereq_stamp,next_attempt_at:schedule,updated_at:row.created_at};
 assertResultRow({...live,...patch});
 return {update:{key:keyOfRow(live),patch}};
}
export const keyOfRow=row=>({origin:row.origin,run_key:row.run_key,pass_no:row.pass_no,kind:row.kind,unit_id:row.unit_id});

// The retry-pass decision for ONE due or re-observed row. ctx: {nowMs, currentUnitDigest (string | null = the unit left the plan), currentStamp (64 hex, for a recoverable row), trigger: 'due' | 'reobserved'}.
// Returns {action, ...}: none, supersede, abandon, defer, retry_apply (an execution failure), plan_and_apply (a recoverable row whose stamp changed).
export function retryDecision(row,ctx){
 assertResultRow(row);
 if(!plain(ctx)||!Number.isFinite(ctx.nowMs)||(ctx.currentUnitDigest!==null&&!DIGEST.test(ctx.currentUnitDigest||''))||!['due','reobserved'].includes(ctx.trigger))throw invalid();
 if(TERMINAL_STATES.includes(row.state))return {action:'none',reason:'terminal'};
 const at=iso(ctx.nowMs);
 if(ctx.currentUnitDigest===null)return supersede(row,'left_plan',at);
 if(ctx.currentUnitDigest!==row.unit_digest)return supersede(row,'source_changed',at);
 if(row.state==='refused_permanent')return {action:'none',reason:'permanent_never_retried'};
 if(row.retry_owner==='receipt')return {action:'none',reason:'receipt_owned'};
 const due=ctx.nowMs>=timeOf(row.next_attempt_at);
 if(row.state==='refused_recoverable'){
  // Never abandoned by attempts or age. Unchanged stamp: no apply, no attempt, only the schedule moves by the policy's last step. Changed: plan and apply through the existing writers.
  if(ctx.trigger==='due'&&!due)return {action:'none',reason:'not_due'};
  if(!DIGEST.test(ctx.currentStamp||''))throw invalid();
  if(ctx.currentStamp===row.prereq_stamp)return {action:'defer',patch:{next_attempt_at:iso(ctx.nowMs+lastBackoffMs()),updated_at:at}};
  return {action:'plan_and_apply',stamp:ctx.currentStamp};
 }
 // open, owner unit: an execution failure. Abandoned when the attempts or the age of the receipt policy are used up.
 if(row.attempts>=RETRY_POLICY.maxAttempts||ctx.nowMs-timeOf(row.created_at)>=RETRY_POLICY.abandonAfterMs)return {action:'abandon',patch:{state:'abandoned',settled_by:'retry_exhausted',settled_at:at,updated_at:at,next_attempt_at:null}};
 if(ctx.trigger==='due'&&!due)return {action:'none',reason:'not_due'};
 return {action:'retry_apply'};
}
// What the retry (or a re-observation) concluded after it planned and applied the unit. outcome:
//   {kind:'proof', proof:'applied_receipt'|'verified_noop'}   the write's own proof: only THEN is the row settled;
//   {kind:'not_proven'}                                       unknown, pending or failed receipt: nothing is settled;
//   {kind:'refused', error, stamp?}                           the planner refused (stamp: the new prerequisite stamp for a recoverable refusal);
//   {kind:'failed', error}                                    the step raised an error.
// Returns {action:'settle'|'update'|'stop'|'none', patch?}. Reclassification (state, code, stamp, schedule) is ONE patch, meant for one compare-and-set.
export function afterRetry(row,outcome,context){
 // Every patch is checked as the row it produces: a state, a code class, an owner, a schedule and a stamp that the schema CHECKs would refuse cannot leave this function.
 const result=settleOutcome(row,outcome,context);
 if(result.patch)assertResultRow({...row,...result.patch});
 return result;
}
function settleOutcome(row,outcome,{nowMs}={}){
 assertResultRow(row);
 if(!plain(outcome)||!Number.isFinite(nowMs)||!LIVE_STATES.includes(row.state)||row.retry_owner!=='unit')throw invalid();
 const at=iso(nowMs);
 if(outcome.kind==='proof'){
  if(outcome.proof!=='applied_receipt'&&outcome.proof!=='verified_noop')throw invalid();
  return {action:'settle',patch:{state:'settled',settled_by:row.state==='refused_recoverable'?'prerequisite_resolved':'applied',settled_at:at,updated_at:at,next_attempt_at:null}};
 }
 if(outcome.kind==='not_proven')return {action:'none',reason:'no_write_proof'};
 if(outcome.kind!=='refused'&&outcome.kind!=='failed')throw invalid();
 const verdict=classifyProducerError(outcome.error);
 if(verdict.action==='stop')return {action:'stop',code:verdict.code};
 if(verdict.action==='keep')return {action:'settle',patch:{state:'settled',settled_by:'kept_outcome',settled_at:at,updated_at:at,next_attempt_at:null}};
 if(verdict.action==='refuse_permanent')return {action:'update',patch:{state:'refused_permanent',code:verdict.code,prereq_stamp:null,next_attempt_at:null,updated_at:at}};
 if(verdict.action==='refuse_recoverable'){
  if(!DIGEST.test(outcome.stamp||''))throw invalid();
  return {action:'update',patch:{state:'refused_recoverable',code:verdict.code,prereq_stamp:outcome.stamp,next_attempt_at:nextAttemptAt(nowMs,1),updated_at:at}};
 }
 // an execution failure: attempts + 1 and the next step of the receipt policy
 const attempts=Math.min(row.attempts+1,16);
 return {action:'update',patch:{state:'open',code:verdict.code,attempts,prereq_stamp:null,next_attempt_at:nextAttemptAt(nowMs,attempts),updated_at:at}};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 8: the prerequisite stamp. Identifiers and revisions, or the explicit absence; NEVER content. Not part of the unit digest, the fingerprint or any superseding.
// ---------------------------------------------------------------------------------------------------------------------------------
// Per refusal code, the fields of the injected snapshot that make up the stamp. `one`: {id, revision} or null (absent). `many`: an array of {id, revision|null} (revision null = absent), compared as a set.
export const PREREQ_FIELDS=Object.freeze({
 no_identity_row:{one:['film','identity'],many:[]},
 needs_trusted_tmdb_id:{one:['film'],many:['claims']},
 film_person_reference:{one:['film'],many:['persons']},
 film_person_redirect:{one:['film','redirect'],many:[]},
 dictionary_identity_ambiguous:{one:['film'],many:['claims','identities']},
 owner_review_inconsistent:{one:['film','entry'],many:['materialised']},
});
function item(value){
 if(value===null)return null;
 if(!plain(value)||Object.keys(value).sort().join(',')!=='id,revision'||typeof value.id!=='string'||!IDENTIFIER.test(value.id)||!(value.revision===null||(Number.isInteger(value.revision)&&value.revision>=0)))throw invalid();
 return {id:value.id,revision:value.revision};
}
export async function prereqStamp(code,snapshot){
 const spec=PREREQ_FIELDS[code];
 if(!spec||!plain(snapshot))throw invalid();
 const allowed=new Set([...spec.one,...spec.many]);
 if(Object.keys(snapshot).some(key=>!allowed.has(key))||[...allowed].some(key=>!Object.hasOwn(snapshot,key)))throw invalid();
 const fields={};
 for(const key of spec.one){fields[key]=item(snapshot[key]);if(key==='film'&&fields[key]===null)throw invalid();}
 for(const key of spec.many){
  if(!Array.isArray(snapshot[key]))throw invalid();
  const list=snapshot[key].map(item);
  if(list.some(entry=>entry===null))throw invalid();
  list.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(list.some((entry,i)=>i>0&&list[i-1].id===entry.id))throw invalid();
  fields[key]=list;
 }
 return digestOf({v:1,code,fields});
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 12 (b) / G10: the owner-review guard, in three cases.
// ---------------------------------------------------------------------------------------------------------------------------------
// input: {read:'ok'|'failed', entry:'absent'|'present'|'unreadable', materialised:'yes'|'no'}. Anything else fails closed as a stop. The absence of an owner record is NEVER a refusal.
export function ownerReviewGuard(input){
 if(!plain(input)||input.read!=='ok')return {decision:'stop',class:CLASS.SYSTEMIC,code:'owner_review_check_failed'};
 if(input.entry==='absent')return {decision:'proceed',case:'no_entry'};
 if(input.entry==='present'&&input.materialised==='yes')return {decision:'proceed',case:'materialised'};
 if((input.entry==='present'&&input.materialised==='no')||input.entry==='unreadable')return {decision:'refuse',class:CLASS.RECOVERABLE,code:'owner_review_inconsistent'};
 return {decision:'stop',class:CLASS.SYSTEMIC,code:'owner_review_check_failed'};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 11: generation-aware freshness.
// ---------------------------------------------------------------------------------------------------------------------------------
// publishedGeneration: the live published EPG generation (a non-empty string). run: the latest epg run row {source_generation, applied_generation, pass_state}; `null` = the store is readable and holds no run; `undefined` = the store
// is absent or unreadable. liveFilmFactsResults: the number of live `film_facts` results (membership-affecting), `undefined`/null when unreadable. Returns 'current' | 'lagging' | 'partial' | 'unknown'.
// `current` ONLY when the pass PASSED, the applied generation EQUALS the published one (and the generation the plan was built from) and no live film_facts result exists. Any other generation, a backwards one included, is `lagging`.
export function canonicalFreshness({publishedGeneration,run,liveFilmFactsResults}={}){
 if(typeof publishedGeneration!=='string'||!publishedGeneration||run===undefined)return 'unknown';
 if(!Number.isInteger(liveFilmFactsResults)||liveFilmFactsResults<0)return 'unknown';
 if(run===null)return 'lagging';
 if(!plain(run)||!['passing','passed','stopped','superseded'].includes(run.pass_state)||typeof run.source_generation!=='string')return 'unknown';
 const applied=run.applied_generation;
 if(applied!==null&&applied!==undefined&&(run.pass_state!=='passed'||applied!==run.source_generation))return 'unknown';
 if(applied!==publishedGeneration)return 'lagging';
 return liveFilmFactsResults>0?'partial':'current';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 5: the cursor never passes a unit without a durable outcome.
// ---------------------------------------------------------------------------------------------------------------------------------
// outcomes: [{kind,id,outcome}] for the visited units of one slice, in plan order. DURABLE outcomes: applied, noop, kept, absent, result_written (a refusal or third-strike result in the slice commit). A first or second strike, a
// systemic stop and an unvisited unit are NOT durable. Returns the cursor key of the last unit of the longest durable prefix after `cursor`, or the cursor unchanged.
export const DURABLE_OUTCOMES=Object.freeze(['applied','noop','kept','absent','result_written']);
export function sliceCursor(units,cursor,outcomes){
 assertOrdered(units);
 if(!Array.isArray(outcomes))throw invalid();
 let index=resumeIndex(units,cursor),last=cursor===undefined?null:cursor;
 for(const item of outcomes){
  const unit=units[index];
  if(!unit||unit.kind!==item.kind||unit.id!==item.id||!DURABLE_OUTCOMES.includes(item.outcome))break;
  last={kind:unit.kind,id:unit.id};index++;
 }
 return last;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decision 4: the dictionary version minting decision, over an INJECTED latest row. NO SQL: S4-2/S4-3 implement the guarded INSERT.
// ---------------------------------------------------------------------------------------------------------------------------------
// latest: null (no dictionary row) or {seq, run_key, snapshot_digest}. Equal digest: REUSE that row and version (resume, retry and an identical replay never mint). Otherwise MINT seq = latest.seq + 1 with prev_seq = latest.seq
// (0 when there is none) and the guard the single INSERT must carry (the previous row exists and its digest differs, or no row exists), and mark the previous run superseded. The caller re-reads and calls this again after a lost race.
export function mintDictionaryVersion({latest,snapshotDigest}={}){
 if(!DIGEST.test(snapshotDigest||''))throw invalid();
 if(latest===null||latest===undefined)return {action:'mint',seq:1,prev_seq:0,run_key:'d1',snapshot_digest:snapshotDigest,guard:{prev_seq:0,previous_exists:false},supersedes:null};
 if(!plain(latest)||!Number.isInteger(latest.seq)||latest.seq<1||latest.run_key!=='d'+latest.seq||!DIGEST.test(latest.snapshot_digest||''))throw invalid();
 if(latest.snapshot_digest===snapshotDigest)return {action:'reuse',seq:latest.seq,run_key:latest.run_key};
 const seq=latest.seq+1;
 return {action:'mint',seq,prev_seq:latest.seq,run_key:'d'+seq,snapshot_digest:snapshotDigest,guard:{prev_seq:latest.seq,previous_exists:true,previous_digest_differs:true},supersedes:latest.run_key};
}
