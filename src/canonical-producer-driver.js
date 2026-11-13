// AIR-374 S4-4 (ADR 0128, Accepted as DESIGN). The DURABLE DRIVER of the canonical producer pass. DORMANT: nothing in the Worker imports this module, it is not bundled (build.mjs is unchanged), `epgSync` does not call it and no route, job, cron or
// Task does; it imports nothing from `worker.js`. It COMPOSES, and decides nothing itself: the plan identity, the strike machine, the classification, the result-row decisions and the retry decisions are the pure S4-1 module
// (src/canonical-producer-run.js); every durable write is the S4-3 store (src/canonical-producer-store.js, one fenced batch each); a unit is applied by the existing `apply*Units` of the producers (their own receipts, fences and kept outcomes).
// What is here, by ADR 0128 decision:
//   1  phase boundary      every exported function catches everything: a thrown error NEVER reaches the caller, it becomes a named result (`state:'error'` with a code, or a recorded stop). It touches no run stage, publication or executor budget (it has no access to them).
//   2,3 plan identity      `runEpgProducerPass` builds the ordered entries (digested units + the planner's per-unit refusals), the fingerprint, and opens or resumes the run by compare-and-set (`openEpgRun`).
//   5,7 slices and strikes the pass applies units one at a time (a ONE-unit sub-plan, so the outcome belongs to that unit), folds each outcome through `strikeStep`, and commits the durable prefix of a slice in ONE batch (`commitSlice`); a first or second
//                          strike is its own commit (`commitStrike`) and ends the step; the third strike and every named refusal are results written in the slice batch with the cursor move.
//   6  systemic stops      a systemic code, an unclassified code, a lost compare-and-set, a failed commit, a moved marker, an unresolved receipt: `commitStop` (best effort) and a `stopped` result; the cursor and the strike count stay as they were.
//   8  retry pass          `retryEpgProducerResults`: the due results of owner `unit`, revalidated by `retryDecision`, applied through the same appliers, settled only after write proof (`afterRetry`); the receipt-owned ones belong to the own-origin reconcile, called here.
//   11 completion          the pass-complete commit is the only claim of `applied_generation`; `readCanonicalFreshness` and `readerDecision` are the consumer boundary.
//   12 dictionary          `runDictionaryProducerPass` resolves each entry to a canonical Film and checks the owner review BEFORE the planner and the version mint.
// Required parameters (no default, ADR 0128 "Measurement gates"): `sliceSize`, `maxSlicesPerRun`, `sliceDeadlineMs` (and `limit` for the retry pass). The deadline must sit inside the 5 minute step lease with its margin, or the call is refused as `invalid_parameters`
// before the marker is read. Dormancy: below marker `open` a call reads the marker ONCE and returns `{state:'skipped'}`; nothing is written. Nothing here authorizes or performs a production read or write.
import {EPG_UNIT_HARD_CAP,applyEpgUnits,epgEvent,planEpgUnitsWithRefusals} from './canonical-epg-producer.js';
import {applyEpgPersonUnits,planEpgPersonUnitsWithRefusals,reconcileEpgRun} from './canonical-epg-person-producer.js';
import {applyDictionaryUnits,planDictionaryUnits} from './canonical-dictionary-producer.js';
import {digestOf,filmFactsDigest,producerRouteOpen,resolveReleaseInput} from './canonical-producer-adapters.js';
import {PERSON_MUTATION_OPERATION,personMutationDigest} from './canonical-person-mutation-producer.js';
import {unitDigest} from './canonical-person-adapters.js';
import {
 CLASS,afterRetry,keyOfRow,buildPlanEntries,canonicalFreshness,classOfCode,classifyProducerError,dictionaryUnitDigest,failureWrite,ownerReviewGuard,planFingerprint,prereqStamp,resumeIndex,retryDecision,strikeStep,
} from './canonical-producer-run.js';
import {
 DUE_LIMIT_MAX,SLICE_STATEMENT_CAP,commitPassComplete,commitResume,commitSlice,commitStop,commitStrike,dueResults,earlierLiveResults,epgRunForGeneration,liveMembershipCount,liveResult,liveRunResults,mintDictionaryRun,openEpgRun,settleResult,updateResult,
} from './canonical-producer-store.js';

// The step lease of the EPG executor (`LEASE_MS` and `BOUNDARY_MARGIN_MS` of src/epg-orchestration.js; a test pins both numbers to that file).
export const STEP_LEASE_MS=5*60000;
export const STEP_LEASE_MARGIN_MS=15000;
export const MAX_DEADLINE_MS=STEP_LEASE_MS-STEP_LEASE_MARGIN_MS;
export const MAX_SLICES_CEILING=1000;
const SLICE_BASE_STATEMENTS=4;
export const SUPERSEDE_PAGE=50;
export const SUPERSEDE_MAX_PAGES=20;
export const SAME_RUN_LIVE_LIMIT=200;
export const SAME_RUN_PAGE=100;
// The two bounds a caller may only LOWER (a test seam): a larger or invalid value is the reviewed constant.
export const supersedeBound=value=>Number.isInteger(value)&&value>=1?Math.min(value,SUPERSEDE_MAX_PAGES):SUPERSEDE_MAX_PAGES;
export const sameRunPageBound=value=>Number.isInteger(value)&&value>=1?Math.min(value,SAME_RUN_PAGE):SAME_RUN_PAGE;
export const sameRunBound=value=>Number.isInteger(value)&&value>=1?Math.min(value,SAME_RUN_LIVE_LIMIT):SAME_RUN_LIVE_LIMIT;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const codeOf=error=>classifyProducerError(error).code;
const keyOf=unit=>unit.kind+'\u0000'+unit.id;
function fail(code){const error=new Error(code);error.code=code;return error;}

// ---------------------------------------------------------------------------------------------------------------------------------
// Parameters.
// ---------------------------------------------------------------------------------------------------------------------------------
const intIn=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
// Returns null when valid, otherwise the NAME of the first invalid parameter. Nothing has a default.
export function parameterProblem(params,{retry=false}={}){
 if(!plain(params))return 'params';
 if(!intIn(params.sliceDeadlineMs,1,MAX_DEADLINE_MS))return 'sliceDeadlineMs';
 if(typeof params.prerequisites!=='function')return 'prerequisites';
 if(retry)return intIn(params.limit,1,DUE_LIMIT_MAX)?null:'limit';
 if(!intIn(params.sliceSize,1,EPG_UNIT_HARD_CAP))return 'sliceSize';
 if(!intIn(params.maxSlicesPerRun,1,MAX_SLICES_CEILING))return 'maxSlicesPerRun';
 return null;
}
const clockOf=params=>typeof params.clock==='function'?params.clock:()=>Date.now();
const nowOf=params=>typeof params.now==='function'?params.now:()=>new Date().toISOString();
const applierOf=params=>({film:applyEpgUnits,person:applyEpgPersonUnits,dictionary:applyDictionaryUnits,...(plain(params.appliers)?params.appliers:{})});
const applyOptionsOf=params=>({...(plain(params.applyOptions)?params.applyOptions:{})});

// The result of an isolated call that failed outside any unit: a code, never a message.
const errorResult=(error,extra={})=>({state:'error',code:codeOf(error),...extra});

// ---------------------------------------------------------------------------------------------------------------------------------
// The ordered plan: entries (digested units and planner refusals), the units to apply, the fingerprint.
// ---------------------------------------------------------------------------------------------------------------------------------
// Builds {event, entries, byKey, absent} for one EPG run from the source inputs. A release unit with no stored Film has nothing to release and is left out of the plan (counted `absent`). A unit whose digest cannot be built because its input is refused
// becomes a refused entry (the planner's own rule); any other failure refuses the whole build (a named result, nothing written).
export async function buildEpgPlan(env,{runId,at,films=[],departed=[],persons=[],credits=[],personRows=[]}={}){
 const filmPlan=planEpgUnitsWithRefusals({runId,at,films,departed});
 const personPlan=planEpgPersonUnitsWithRefusals({runId,at,persons,credits,personRows});
 if(filmPlan.event!==personPlan.event)throw fail('film_person_run_mismatch');
 const units=[...filmPlan.units.map(unit=>({kind:'film_facts',id:unit.id,release:unit.release===true,input:unit.input})),...personPlan.units.map(unit=>({kind:unit.kind,id:unit.id,release:false,input:unit.input}))];
 const refused=[...filmPlan.refused,...personPlan.refused];
 const entries=[],byKey=new Map();
 let absent=0;
 for(const unit of units){
  try{
   let digestInput=unit.input;
   if(unit.kind==='film_facts'&&unit.release){
    digestInput=await resolveReleaseInput(env,unit.input);
    if(!digestInput){absent++;continue;}
   }
   const digest=unit.kind==='film_facts'?await filmFactsDigest(digestInput):unit.kind===PERSON_MUTATION_OPERATION?await personMutationDigest(unit.input):await unitDigest(unit.kind,unit.input);
   entries.push({kind:unit.kind,id:unit.id,unitDigest:digest});
   byKey.set(keyOf(unit),{...unit,digest});
  }catch(error){
   const cls=classOfCode(error?.code);
   if(cls!==CLASS.PERMANENT&&cls!==CLASS.RECOVERABLE)throw error;
   refused.push({kind:unit.kind,id:unit.id,code:error.code,source:unit.input});
  }
 }
 const ordered=await buildPlanEntries({units:entries,refused});
 return {event:filmPlan.event,entries:ordered,byKey,absent,filmPlan,personPlan};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One unit: apply it through the existing layer and read the outcome that belongs to it.
// ---------------------------------------------------------------------------------------------------------------------------------
// result: the return of an `apply*Units` call over a ONE-unit plan. Returns {type:'done', outcome} | {type:'failed', error} | {type:'stop', code}. The reply is EVIDENCE and is validated before it is believed: it must be the exact shape of one unit that was
// visited (`skipped:false`, `cursor:1`, `done:true`, `counts` a plain object of non-negative integers with exactly ONE outcome counted once, `failures` an array that agrees with the count). A `skipped` answer (the marker moved) and a held code are stops; anything
// malformed, empty, contradictory or unknown is the systemic `canonical_producer_invalid` (fail closed: the cursor does not pass it and nothing is claimed). Only an EXPLICIT outcome is accepted: applied or already applied, a no-op, or a named kept outcome
// (`absent`, `kept`, `identity_mismatch`); a redirected Film is a refusal; `unknown`, `pending` or a receipt `failed` is an unresolved receipt (a stop, the receipt owns it); a thrown unit error is a failure of the unit (`failed` with one failure).
const MALFORMED=Object.freeze({type:'stop',code:'canonical_producer_invalid'});
const KEPT_COUNTS=Object.freeze(['absent','kept','identity_mismatch']);
export function interpretApply(result){
 if(!plain(result))return MALFORMED;
 if(result.skipped===true)return {type:'stop',code:'film_person_not_open'};
 if(result.skipped!==false)return MALFORMED;
 if(result.stoppedBy!==null&&result.stoppedBy!==undefined)return typeof result.stoppedBy==='string'&&result.stoppedBy?{type:'stop',code:codeOf(result.stoppedBy)}:MALFORMED;
 if(!plain(result.counts)||!Array.isArray(result.failures)||result.cursor!==1||result.done!==true)return MALFORMED;
 const entries=Object.entries(result.counts);
 if(entries.some(([,value])=>!Number.isInteger(value)||value<0))return MALFORMED;
 const named=entries.filter(([,value])=>value>0);
 if(named.length!==1||named[0][1]!==1)return MALFORMED;
 const failures=result.failures;
 if(failures.length>1||failures.some(item=>!plain(item)||typeof item.code!=='string'||!item.code))return MALFORMED;
 const key=named[0][0];
 if(key==='failed')return failures.length===1?{type:'failed',error:{code:failures[0].code}}:{type:'stop',code:'receipt_state_conflict'};
 if(failures.length)return MALFORMED;
 if(key==='applied'||key==='already')return {type:'done',outcome:'applied'};
 if(key==='noop')return {type:'done',outcome:'noop'};
 if(KEPT_COUNTS.includes(key))return {type:'done',outcome:'kept'};
 if(key==='redirected')return {type:'failed',error:{code:'film_person_redirect'}};
 if(key==='unknown'||key==='pending')return {type:'stop',code:'receipt_state_conflict'};
 return MALFORMED;
}
async function applyOne(env,ctx,entry){
 const unit=ctx.byKey.get(keyOf(entry));
 if(!unit)return {type:'failed',error:{code:'film_person_invalid'}};
 let result;
 try{
  if(ctx.origin==='dictionary')result=await ctx.appliers.dictionary(env,{plan:{event:ctx.event,snapshot:ctx.snapshot,at:ctx.at,units:[unit.unit]},cursor:0,limit:1,...ctx.applyOptions});
  else if(entry.kind==='film_facts')result=await ctx.appliers.film(env,{plan:{event:ctx.event,units:[{id:unit.id,release:unit.release===true,input:unit.input}]},cursor:0,limit:1,...ctx.applyOptions});
  else result=await ctx.appliers.person(env,{plan:{event:ctx.event,units:[{kind:unit.kind,id:unit.id,input:unit.input}]},cursor:0,limit:1,...ctx.applyOptions});
 }catch(error){return {type:'failed',error};}
 return interpretApply(result);
}
// A unit's verdict for the slice: a planner-refused entry is a refusal at first observation (it is never applied); the first two codes of REPLAN_FIRST are applied once more at once, because the other writer may have moved.
async function evaluate(env,ctx,entry){
 if(entry.refusal!==undefined)return {type:'failed',error:{code:entry.refusal}};
 let verdict=await applyOne(env,ctx,entry);
 if(verdict.type==='failed'&&classifyProducerError(verdict.error).replanFirst)verdict=await applyOne(env,ctx,entry);
 return verdict;
}
async function stampFor(env,ctx,entry,code){
 const snapshot=await ctx.prerequisites({env,origin:ctx.origin,code,kind:entry.kind,id:entry.id});
 return prereqStamp(code,snapshot);
}

// Cross-run supersession (ADR 0128: results covered by a newer run's plan become `superseded` / `newer_run`) and the owner-approved left-plan cleanup (option C, PR #601 decision record): once the COMPLETE, COMMITTED, SEALED candidate input of THIS generation
// (`provenance`, see `inputProvenanceOk`) shows that a unit with an older live result is absent from the current full plan, that result is superseded `left_plan`, history kept. Without that provenance nothing is settled for an absent unit (fail closed).
// Only a run PROVEN earlier is touched: `order(earlierGeneration, laterGeneration)` is the caller's authoritative ordering of published generations (-1 earlier, 1 later); a row of a later run (a delayed older pass) is left alone, and a COVERED row whose order
// cannot be proven (no ordering, a throw, an equal or unordered answer) fails the sweep closed (no claim); an uncovered one is simply not settled. One keyset page at a time, one terminal settle per row (compare-and-set on state and attempts), at most `maxPages`
// pages, and the remaining deadline is checked before EVERY read and EVERY write. The same-run left-plan cleanup (the live rows an earlier pass of THIS run left for a unit the new plan no longer holds) runs last, once provenance holds.
async function supersedeEarlierResults(env,{run,entries,now,maxPages,order,expired,provenance,ownPage}){
 const covered=new Set(entries.map(keyOf));
 let after=null,superseded=0,leftPlan=0,unproven=false,finished=false;
 const settle=async(row,settledBy)=>{
  const answer=await settleResult(env,{row,state:'superseded',settledBy,at:now()});
  if(answer.state==='skipped')throw fail('film_person_not_open');
 };
 for(let page=0;page<maxPages&&!finished;page++){
  if(expired())return {complete:false,superseded,leftPlan,reason:'deadline'};
  const rows=await earlierLiveResults(env,{runKey:run.run_key,after,limit:SUPERSEDE_PAGE});
  for(const row of rows){
   const isCovered=covered.has(keyOf({kind:row.kind,id:row.unit_id}));
   if(!isCovered&&!provenance)continue;
   let verdict=null;
   try{verdict=typeof order==='function'?await order(row.run_source_generation,run.source_generation):null;}catch{verdict=null;}
   if(verdict===1)continue;
   if(verdict!==-1){if(isCovered)unproven=true;continue;}
   if(expired())return {complete:false,superseded,leftPlan,reason:'deadline'};
   await settle(row,isCovered?'newer_run':'left_plan');
   if(isCovered)superseded++;else leftPlan++;
  }
  if(rows.length<SUPERSEDE_PAGE)finished=true;
  else{const last=rows[rows.length-1];after={run_key:last.run_key,pass_no:last.pass_no,kind:last.kind,unit_id:last.unit_id};}
 }
 if(!finished)return {complete:false,superseded,leftPlan,reason:'max_pages'};
 if(unproven)return {complete:false,superseded,leftPlan,reason:'order_unproven'};
 if(provenance){
  if(expired())return {complete:false,superseded,leftPlan,reason:'deadline'};
  // One keyset page at a time over ALL the live rows of this run, receipt-owned and still-covered rows included (they are paged past, never settled, and cannot starve the rest). A page budget that runs out is NOT completion: the call ends
  // `max_pages`, no claim, and the next call resumes (the settled rows are no longer live, so it makes progress as long as the unsettleable rows fit in one call's budget).
  let afterOwn=null;
  for(let page=0;;page++){
   if(page>=maxPages)return {complete:false,superseded,leftPlan,reason:'max_pages'};
   if(expired())return {complete:false,superseded,leftPlan,reason:'deadline'};
   const own=await liveRunResults(env,{origin:'epg',runKey:run.run_key,after:afterOwn,limit:ownPage});
   for(const row of own){
    if(row.retry_owner!=='unit'||covered.has(keyOf({kind:row.kind,id:row.unit_id})))continue;
    if(expired())return {complete:false,superseded,leftPlan,reason:'deadline'};
    await settle(row,'left_plan');
    leftPlan++;
   }
   if(own.length<ownPage)break;
   const last=own[own.length-1];
   afterOwn={pass_no:last.pass_no,kind:last.kind,unit_id:last.unit_id};
  }
 }
 return {complete:true,superseded,leftPlan};
}
// The provenance of the candidate input: the caller states, strictly, that the input this plan was built from is COMPLETE, COMMITTED and SEALED for the published generation of this run (a chunk, a partial or unsealed scan, a failed build, a pending
// generation is none of that). Anything but exactly `true` on each field and the same generation is no provenance.
export const inputProvenanceOk=(provenance,sourceGeneration)=>plain(provenance)&&provenance.complete===true&&provenance.committed===true&&provenance.sealed===true&&typeof sourceGeneration==='string'&&provenance.publishedGeneration===sourceGeneration;

// The obsolete live result of the SAME run (an earlier pass of it) for a unit that has now succeeded (applied, a verified no-op, a named kept outcome): the settle that goes in the same batch as the cursor move. A receipt-owned row is never settled here (an unresolved
// receipt belongs to its owner), a changed digest is `superseded` / `source_changed`, the same digest is `settled` after the unit's own proof. Returns the `supersede` write of `commitSlice` or null.
function obsoleteWrite(row,entry,outcome,at){
 if(!row||row.retry_owner!=='unit')return null;
 const same=row.unit_digest===entry.unitDigest;
 const state=same?'settled':'superseded';
 const settledBy=!same?'source_changed':outcome==='kept'?'kept_outcome':row.state==='refused_recoverable'?'prerequisite_resolved':'applied';
 return {supersede:{key:keyOfRow(row),patch:{state,settled_by:settledBy,settled_at:at,updated_at:at}}};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The slice loop, shared by the EPG and the dictionary pass.
// ---------------------------------------------------------------------------------------------------------------------------------
const runFields=run=>({cursor_kind:run.cursor_kind??null,cursor_id:run.cursor_id??null,strike_kind:run.strike_kind??null,strike_id:run.strike_id??null,strike_digest:run.strike_digest??null,strike_class:run.strike_class??null,strike_count:run.strike_count??0,pass_no:run.pass_no});
const strikeColumns=folded=>({strike_kind:folded.strike_kind,strike_id:folded.strike_id,strike_digest:folded.strike_digest,strike_class:folded.strike_class,strike_count:folded.strike_count});
const writeCost=write=>(write.supersede?2:0)+(write.insert?1:0)+(write.update?2:0);
const emptyCounts=()=>({applied:0,noop:0,kept:0,failed:0});

async function runSlices(env,ctx){
 const {params,entries}=ctx,clock=clockOf(params),now=nowOf(params);
 const t0=clock();
 const expired=()=>clock()-t0>=params.sliceDeadlineMs;
 let run=ctx.run,index=ctx.startIndex,slices=0,deadlineHit=false,commitFailed=false;
 let folded=runFields(run);
 const total=emptyCounts();
 let pending={writes:[],cost:SLICE_BASE_STATEMENTS,counts:emptyCounts(),last:null};
 const reset=()=>{pending={writes:[],cost:SLICE_BASE_STATEMENTS,counts:emptyCounts(),last:null};};
 const base=()=>({state:'',origin:ctx.origin,runKey:run.run_key,passNo:run.pass_no,slices,counts:{...total},cursor:folded.cursor_id===null?null:{kind:folded.cursor_kind,id:folded.cursor_id}});
 // Commits the durable prefix of the slice in ONE batch. A `skipped` answer means the marker left `open` between two writes: a stop, the batch was not written.
 const flush=async()=>{
  if(!pending.last)return;
  let answer;
  try{answer=await commitSlice(env,{run,next:{cursor_kind:pending.last.kind,cursor_id:pending.last.id,...strikeColumns(folded)},writes:pending.writes,counts:pending.counts,at:now()});}
  catch(error){commitFailed=true;throw error;}
  if(answer.state==='skipped'){commitFailed=true;throw fail('film_person_not_open');}
  run=answer.run;
  for(const key of Object.keys(total))total[key]+=pending.counts[key];
  reset();
 };
 const stop=async code=>{
  let recorded=false;
  // A stop never retries a slice commit that just failed: nothing from that slice was acknowledged, the cursor stays and the units are revisited. (The callers that stop on a unit commit its durable prefix first.)
  try{const answer=await commitStop(env,{run,stoppedBy:code,at:now()});recorded=answer.state==='committed';}catch{recorded=false;}
  return {...base(),state:'stopped',code,recorded};
 };
 try{
  // A run an earlier step stopped is taken over: it is `passing` again before any slice or strike is written (the cursor and the strike columns are not touched by that move).
  if(run.pass_state==='stopped'){
   const answer=await commitResume(env,{run,at:now()});
   if(answer.state==='skipped')throw fail('film_person_not_open');
   run=answer.run;
  }
  // The live results this run already holds (an earlier pass of it): a unit that now succeeds settles its obsolete row in the slice batch. At most SAME_RUN_LIVE_LIMIT are read once; more than that and every success is looked up exactly.
  const cap=sameRunBound(params.sameRunLiveLimit);
  const held=await liveRunResults(env,{origin:ctx.origin,runKey:run.run_key,limit:cap+1});
  const overflow=held.length>cap;
  const heldRows=new Map(held.slice(0,cap).map(row=>[keyOf({kind:row.kind,id:row.unit_id}),row]));
  const obsolete=async(unit,entry,outcome)=>{
   if(!overflow&&heldRows.size===0)return null;
   const row=overflow?await liveResult(env,{origin:ctx.origin,runKey:run.run_key,kind:unit.kind,unitId:unit.id}):heldRows.get(keyOf(unit))||null;
   return obsoleteWrite(row,entry,outcome,now());
  };
  const attach=async write=>{
   const cost=writeCost(write);
   if(pending.cost+cost>SLICE_STATEMENT_CAP)await flush();
   pending.writes.push(write);pending.cost+=cost;
  };
  while(index<entries.length&&slices<params.maxSlicesPerRun&&!deadlineHit){
   let inSlice=0;
   while(index<entries.length&&inSlice<params.sliceSize){
    if(expired()){deadlineHit=true;break;}
    const entry=entries[index];
    const unit={kind:entry.kind,id:entry.id};
    const verdict=await evaluate(env,ctx,entry);
    if(verdict.type==='stop'){await flush();return await stop(verdict.code);}
    if(verdict.type==='done'){
     folded={...folded,...strikeStep(folded,{type:'unit_done',unit}).run};
     const settle=await obsolete(unit,entry,verdict.outcome);
     if(settle)await attach(settle);
     pending.counts[verdict.outcome==='applied'?'applied':verdict.outcome==='noop'?'noop':'kept']++;
     pending.last=unit;index++;inSlice++;continue;
    }
    const step=strikeStep(folded,{type:'unit_failed',unit:{...unit,digest:entry.unitDigest},error:verdict.error});
    if(step.action==='stop'){await flush();return await stop(step.run.stopped_by);}
    if(step.action==='unit_done'){folded={...folded,...step.run};const settle=await obsolete(unit,entry,'kept');if(settle)await attach(settle);pending.counts.kept++;pending.last=unit;index++;inSlice++;continue;}
    if(step.action==='strike'){
     // The count rises in its own commit (the cursor does not move with it); the step ends and the next one re-attempts the unit.
     await flush();
     const answer=await commitStrike(env,{run,next:step.run,at:now()});
     if(answer.state==='skipped')throw fail('film_person_not_open');
     run=answer.run;folded={...folded,...runFields(run)};
     return {...base(),state:'struck',code:step.run.strike_class,unit,strikes:step.run.strike_count};
    }
    // A durable result: a named refusal at first observation or the third proven failure.
    const result=step.result;
    const stamp=result.state==='refused_recoverable'?await stampFor(env,ctx,entry,result.code):null;
    const live=await liveResult(env,{origin:ctx.origin,runKey:run.run_key,kind:unit.kind,unitId:unit.id});
    const write=failureWrite(live,{origin:ctx.origin,runKey:run.run_key,passNo:run.pass_no,fingerprint:run.fingerprint,unit:{...unit,digest:entry.unitDigest},state:result.state,code:result.code,attempts:result.attempts,prereqStamp:stamp,at:now()});
    const cost=writeCost(write);
    if(pending.cost+cost>SLICE_STATEMENT_CAP)await flush();
    pending.writes.push(write);pending.cost+=cost;pending.counts.failed++;
    folded={...folded,...step.run};pending.last=unit;index++;inSlice++;
   }
   await flush();
   slices++;
  }
  await flush();
  if(index<entries.length)return {...base(),state:'partial',reason:deadlineHit?'deadline':'max_slices'};
  if(ctx.origin==='epg'){
   // Every unit of THIS plan now has a durable outcome. The live results that an EARLIER run left for a unit this plan covers are superseded `newer_run` (the history stays; this run owns the unit now), BEFORE the claim counts what is still open. An earlier live
   // result of a unit this plan does not cover stays live: it keeps blocking `current` and is never discarded silently (bounded: a sweep that cannot finish does not claim).
   // The remaining deadline holds through the whole sweep and before the claim: no write and no claim after it; the next step resumes (the cursor is already past the last unit).
   if(expired())return {...base(),state:'partial',reason:'deadline'};
   const sweep=await supersedeEarlierResults(env,{run,entries,now,order:params.generationOrder,expired,provenance:inputProvenanceOk(params.inputProvenance,ctx.sourceGeneration),ownPage:sameRunPageBound(params.sameRunPage),maxPages:supersedeBound(params.supersedeMaxPages)});
   if(!sweep.complete)return {...base(),state:'partial',reason:'supersession_pending',detail:sweep.reason,supersededEarlier:sweep.superseded,leftPlan:sweep.leftPlan};
   if(expired())return {...base(),state:'partial',reason:'deadline',supersededEarlier:sweep.superseded};
   const open=await liveMembershipCount(env);
   const answer=await commitPassComplete(env,{run,openAtCompletion:open,at:now()});
   if(answer.state==='skipped')throw fail('film_person_not_open');
   run=answer.run;
   return {...base(),state:'complete',openAtCompletion:open,appliedGeneration:run.applied_generation,supersededEarlier:sweep.superseded,leftPlan:sweep.leftPlan};
  }
  return {...base(),state:'complete'};
 }catch(error){
  // A failure of a unit step (a prerequisite read, a malformed answer) keeps the durable prefix of the slice; a failed slice commit is never retried here (nothing from it was acknowledged).
  if(!commitFailed)await flush().catch(()=>{});
  return await stop(codeOf(error));
 }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The EPG pass.
// ---------------------------------------------------------------------------------------------------------------------------------
// params: {runId, sourceGeneration, at (the plan clock), films, departed, persons, credits, personRows, sliceSize, maxSlicesPerRun, sliceDeadlineMs, prerequisites({env,origin,code,kind,id}) -> the snapshot of `prereqStamp`, now?, clock?, applyOptions?, appliers?}.
// Returns {state:'skipped'} (marker below `open`, one read) | {state:'invalid_parameters', field} | {state:'already_complete'} | {state:'complete'|'partial'|'stopped'|'struck', ...} | {state:'error', code}. Never throws.
export async function runEpgProducerPass(env,params={}){
 try{
  const problem=parameterProblem(params);
  if(problem)return {state:'invalid_parameters',field:problem};
  if(typeof params.runId!=='string'||!params.runId||typeof params.sourceGeneration!=='string'||!params.sourceGeneration||typeof params.at!=='string'||!params.at)return {state:'invalid_parameters',field:'run'};
  if(!(await producerRouteOpen(env)))return {state:'skipped',reason:'projector_is_writer'};
  const plan=await buildEpgPlan(env,params);
  const event=epgEvent(params.runId);
  const fingerprint=await planFingerprint({origin:'epg',event,units:plan.entries});
  const opened=await openEpgRun(env,{runKey:event,sourceGeneration:params.sourceGeneration,fingerprint,units:plan.entries,at:nowOf(params)()});
  if(opened.state==='skipped')return {state:'skipped',reason:'projector_is_writer'};
  if(opened.run.pass_state==='passed'&&opened.run.applied_generation!==null)return {state:'already_complete',passNo:opened.run.pass_no,appliedGeneration:opened.run.applied_generation};
  return await runSlices(env,{params,origin:'epg',sourceGeneration:params.sourceGeneration,event,at:params.at,entries:plan.entries,byKey:plan.byKey,run:opened.run,startIndex:opened.startIndex,absent:plan.absent,
   prerequisites:params.prerequisites,appliers:applierOf(params),applyOptions:applyOptionsOf(params)});
 }catch(error){return errorResult(error);}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The dictionary pass: the resolver and the owner-review check run BEFORE the planner and the version mint.
// ---------------------------------------------------------------------------------------------------------------------------------
// params: {version, entries (as `planDictionaryUnits`, `filmId` NOT required), at, resolveFilm(entry) -> {filmId} | {refusal, source?}, readOwnerReview(filmId) -> the input of `ownerReviewGuard`, prerequisites, sliceSize, maxSlicesPerRun, sliceDeadlineMs, ...}.
// `resolveFilm` maps a dictionary entry to ONE canonical Film (a trusted, non-conflicting identity) or refuses: `dictionary_source_ambiguous` (permanent: the ambiguity is inside the snapshot) or `dictionary_identity_ambiguous` (recoverable: it comes from mutable
// identity or claim rows). An owner entry present but not materialised (or unreadable) is the recoverable `owner_review_inconsistent`; a check that cannot be performed STOPS the pass before anything is minted; no owner entry is never a refusal.
export async function runDictionaryProducerPass(env,params={}){
 try{
  const problem=parameterProblem(params);
  if(problem)return {state:'invalid_parameters',field:problem};
  if(typeof params.version!=='string'||!Array.isArray(params.entries)||typeof params.at!=='string'||!params.at||typeof params.resolveFilm!=='function'||typeof params.readOwnerReview!=='function')return {state:'invalid_parameters',field:'dictionary'};
  if(!(await producerRouteOpen(env)))return {state:'skipped',reason:'projector_is_writer'};
  const resolved=[],refused=[];
  for(const entry of params.entries){
   const label=plain(entry)&&typeof entry.id==='string'?entry.id:null;
   if(label===null)throw fail('film_person_invalid');
   const found=await params.resolveFilm(entry);
   if(plain(found)&&typeof found.refusal==='string'){
    if(![CLASS.PERMANENT,CLASS.RECOVERABLE].includes(classOfCode(found.refusal)))throw fail('film_person_invalid');
    refused.push({kind:'film_facts',id:typeof found.filmId==='string'&&found.filmId?found.filmId:label,code:found.refusal,source:found.source===undefined?entry:found.source});
    continue;
   }
   if(!plain(found)||typeof found.filmId!=='string'||!found.filmId.startsWith('film:'))throw fail('film_person_invalid');
   let owner;
   try{owner=await params.readOwnerReview(found.filmId);}catch{owner={read:'failed'};}
   const guard=ownerReviewGuard(owner);
   if(guard.decision==='stop')return {state:'stopped',code:guard.code,recorded:false,minted:false};
   if(guard.decision==='refuse'){refused.push({kind:'film_facts',id:found.filmId,code:guard.code,source:entry});continue;}
   resolved.push({...entry,filmId:found.filmId});
  }
  const plan=await planDictionaryUnits({version:params.version,entries:resolved,at:params.at});
  const byKey=new Map(),units=[];
  for(const unit of plan.units){
   const digest=await dictionaryUnitDigest(unit);
   units.push({kind:'film_facts',id:unit.id,unitDigest:digest});
   byKey.set(keyOf({kind:'film_facts',id:unit.id}),{kind:'film_facts',id:unit.id,unit,digest});
  }
  const entries=await buildPlanEntries({units,refused});
  const fingerprint=await planFingerprint({origin:'dictionary',event:plan.event,units:entries});
  const snapshotDigest=refused.length?await digestOf({snapshot:plan.snapshot.digest,refused:entries.filter(entry=>entry.refusal!==undefined).map(entry=>({id:entry.id,code:entry.refusal,digest:entry.unitDigest}))}):plan.snapshot.digest;
  const minted=await mintDictionaryRun(env,{snapshotDigest,fingerprint,unitCount:entries.length,at:nowOf(params)()});
  if(minted.state==='skipped')return {state:'skipped',reason:'projector_is_writer'};
  // A reused version carries the fingerprint it was minted with; a different one means the plan of this snapshot moved (a plan version change): it needs a new version, never a guessed resume.
  if(minted.run.fingerprint!==fingerprint)return {state:'stopped',code:'producer_cas_lost',recorded:false,minted:false};
  return await runSlices(env,{params,origin:'dictionary',event:plan.event,at:params.at,snapshot:plan.snapshot,entries,byKey,run:minted.run,startIndex:resumeIndex(entries,minted.run.cursor_kind===null?null:{kind:minted.run.cursor_kind,id:minted.run.cursor_id}),
   prerequisites:params.prerequisites,appliers:applierOf(params),applyOptions:applyOptionsOf(params)});
 }catch(error){return errorResult(error);}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The retry pass (decision 8): bounded, one owner per result, no scheduler.
// ---------------------------------------------------------------------------------------------------------------------------------
// params: the inputs of the CURRENT plan (as `runEpgProducerPass`: runId, at, films, departed, persons, credits, personRows), limit (rows, 1..DUE_LIMIT_MAX), sliceDeadlineMs, prerequisites, now?, clock?, applyOptions?, appliers?, reconcile? (default true).
// Takes the due live results of origin `epg` owned by the unit, decides each with `retryDecision` against the current plan, applies through the same appliers and settles only after write proof. The receipt-owned results are left to the own-origin reconcile,
// which this call runs once at the end within the same limit. Returns {state:'skipped'} | {state:'invalid_parameters'} | {state:'done'|'stopped', counts, reconcile} | {state:'error', code}. Never throws.
export async function retryEpgProducerResults(env,params={}){
 try{
  const problem=parameterProblem(params,{retry:true});
  if(problem)return {state:'invalid_parameters',field:problem};
  if(typeof params.runId!=='string'||!params.runId||typeof params.at!=='string'||!params.at)return {state:'invalid_parameters',field:'run'};
  if(!(await producerRouteOpen(env)))return {state:'skipped',reason:'projector_is_writer'};
  const clock=clockOf(params),now=nowOf(params),t0=clock();
  const rows=await dueResults(env,{now:now(),limit:params.limit,origin:'epg'});
  const counts={taken:0,settled:0,superseded:0,abandoned:0,deferred:0,updated:0,unchanged:0,other_origin:0,not_proven:0};
  let plan=null,stopCode=null;
  const ctx={origin:'epg',prerequisites:params.prerequisites,appliers:applierOf(params),applyOptions:applyOptionsOf(params),at:params.at};
  for(const row of rows){
   if(clock()-t0>=params.sliceDeadlineMs)break;
   if(row.origin!=='epg'){counts.other_origin++;continue;}
   if(plan===null)plan=await buildEpgPlan(env,params);
   counts.taken++;
   const entry=plan.entries.find(item=>item.kind===row.kind&&item.id===row.unit_id)||null;
   const nowMs=Date.parse(now());
   const stamp=row.state==='refused_recoverable'&&entry!==null&&entry.unitDigest===row.unit_digest?await stampFor(env,ctx,{kind:row.kind,id:row.unit_id},row.code):undefined;
   const decision=retryDecision(row,{nowMs,currentUnitDigest:entry===null?null:entry.unitDigest,...(stamp?{currentStamp:stamp}:{}),trigger:'due'});
   if(decision.action==='none'){counts.unchanged++;continue;}
   if(decision.action==='supersede'||decision.action==='abandon'){
    await settleResult(env,{row,state:decision.patch.state,settledBy:decision.patch.settled_by,at:now()});
    counts[decision.action==='supersede'?'superseded':'abandoned']++;continue;
   }
   if(decision.action==='defer'){await updateResult(env,{row,patch:decision.patch,at:now()});counts.deferred++;continue;}
   // retry_apply | plan_and_apply: the unit of the CURRENT plan, under the result's own event, through the existing writers.
   if(entry.refusal!==undefined){counts.unchanged++;continue;}
   const verdict=await applyOne(env,{...ctx,event:row.run_key,byKey:plan.byKey},entry);
   if(verdict.type==='stop'){stopCode=verdict.code;break;}
   let outcome;
   if(verdict.type==='done')outcome=verdict.outcome==='applied'?{kind:'proof',proof:'applied_receipt'}:verdict.outcome==='noop'?{kind:'proof',proof:'verified_noop'}:{kind:'not_proven'};
   else if(classifyProducerError(verdict.error).action==='refuse_recoverable')outcome={kind:'refused',error:verdict.error,stamp:await stampFor(env,ctx,{kind:row.kind,id:row.unit_id},codeOf(verdict.error))};
   else outcome={kind:'failed',error:verdict.error};
   const next=afterRetry(row,outcome,{nowMs:Date.parse(now())});
   if(next.action==='stop'){stopCode=next.code;break;}
   if(next.action==='settle'){await settleResult(env,{row,state:next.patch.state,settledBy:next.patch.settled_by,at:now()});counts.settled++;}
   else if(next.action==='update'){await updateResult(env,{row,patch:next.patch,at:now()});counts.updated++;}
   else counts.not_proven++;
  }
  let reconcile={state:'not_run'};
  if(stopCode===null&&params.reconcile!==false){
   try{
    plan=plan||await buildEpgPlan(env,params);
    const summary=await reconcileEpgRun(env,{plan:plan.personPlan,filmPlan:plan.filmPlan,limit:Math.max(1,params.limit-counts.taken),...applyOptionsOf(params)});
    reconcile={state:'done',...(plain(summary)&&plain(summary.counts)?{counts:summary.counts}:{})};
   }catch(error){reconcile={state:'failed',code:codeOf(error)};}
  }
  return {state:stopCode?'stopped':'done',...(stopCode?{code:stopCode}:{}),counts,reconcile};
 }catch(error){return errorResult(error);}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The consumer boundary (decision 11).
// ---------------------------------------------------------------------------------------------------------------------------------
// The one read of freshness: the latest epg run, the live membership results and the published generation, through `canonicalFreshness`. A store that is absent or unreadable is `unknown`; this function never throws.
export async function readCanonicalFreshness(env,{publishedGeneration}={}){
 try{
  const run=typeof publishedGeneration==='string'&&publishedGeneration?await epgRunForGeneration(env,{sourceGeneration:publishedGeneration}):undefined;
  const live=await liveMembershipCount(env);
  return {freshness:canonicalFreshness({publishedGeneration,run,liveFilmFactsResults:live}),publishedGeneration:publishedGeneration??null,appliedGeneration:run?.applied_generation??null,passState:run?.pass_state??null};
 }catch(error){return {freshness:'unknown',publishedGeneration:publishedGeneration??null,appliedGeneration:null,passState:null,code:codeOf(error)};}
}
// A reader that depends on canonical EPG membership FAILS CLOSED on anything but `current`; a display reader serves the data with the explicit state beside it.
export function readerDecision(state,mode){
 if(!plain(state)||typeof state.freshness!=='string')return {ok:false,code:'canonical_not_current',freshness:'unknown'};
 if(mode==='display')return {ok:true,freshness:state.freshness,publishedGeneration:state.publishedGeneration,appliedGeneration:state.appliedGeneration};
 if(mode!=='membership')throw fail('film_person_invalid');
 return state.freshness==='current'?{ok:true,freshness:'current'}:{ok:false,code:'canonical_not_current',freshness:state.freshness};
}
