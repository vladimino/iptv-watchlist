// AIR-374 P3a, PLANNING AND APPLY LAYER of the EPG producer for Person and credit units (ADR 0126; owner decision of 12 Nov 2026, step 3, delivered separately from the Film layer of ADR 0125). DORMANT: nothing in the Worker imports this
// module, it is not bundled (build.mjs is unchanged), `epgSync` does not call it and no route, job or cron does. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: `applyEpgPersonUnits` and
// `reconcileEpgRun` read the marker ONCE and, unless it is `open`, return `skipped` before any other statement. `held` and an unreadable marker throw (the producer defers, it never falls back to R2).
// Scope: the operation kinds `person_state` and `film_credits` only, with every input INJECTED. It reads no R2, no EPG and no dictionary store, registers no operation in PRODUCER_OPERATIONS and writes nothing itself: every unit goes through the
// adapters of src/canonical-person-adapters.js, which call the existing fenced writers (`recordPersonState`, `mutateFilm`) with the receipt tail. So `handoffReadiness` still reports `producer_not_wired:epg_commit`, truthfully.
//   - `planEpgPersonUnits`   PURE. One `person_state` unit per Person the run observed, then one `film_credits` unit per Film with credits; deterministic order (Persons by id, then Films by id), duplicates refused, the run id is the event
//                            (the same `epg:<run id>` as the Film units of ADR 0125, told apart by the operation kind).
//   - `applyEpgPersonUnits`  bounded, resumable by cursor, the same ceiling and semantics as `applyEpgUnits`: at most `limit` units per call (hard ceiling EPG_UNIT_HARD_CAP, provisional until the E6 measurement). A refusal of one unit never blocks
//                            the others; `film_person_held` / `film_person_unavailable` stop the pass and keep the cursor on that unit. An absent Person or Film is skipped and counted `absent`: it is never created.
//   - `epgPersonReplan`      the producer's re-plan for the receipts replay: the unit of the run for a receipt's kind and target, or null; the receipt's request id is recomputed from THIS run's event, the kind, the target and the digest.
//   - `reconcileEpgRun`      E2: ONE bounded inline reconcile of the origin `epg` for ALL its kinds (`film_facts` of ADR 0125, `person_state`, `film_credits`), in ONE bounded pass: the adapter's inline limit is shared by all kinds, the earliest due receipts first, with NO per-kind fairness (a backlog of one kind can use the whole pass; it is drained across passes). No cron, no tick, no global pass.
// Stored: operation kind, origin, target, digests, revisions, state; no payload, title, name or personal data.
import {failed} from './film-person-authority.js';
import {EPG_ORIGIN,EPG_UNIT_HARD_CAP,EPG_UNIT_LIMIT_DEFAULT,epgEvent,epgReplan,epgUnitCap} from './canonical-epg-producer.js';
import {FILM_FACTS_OPERATION,filmFactsOperation,producerRequestId,producerRouteOpen,reconcileOwnOrigin} from './canonical-producer-adapters.js';
import {APPLY_UNIT,CREDITS_PER_UNIT_MAX,FILM_CREDITS_OPERATION,PERSON_STATE_OPERATION,filmCreditsContent,personStateContent,unitOperation} from './canonical-person-adapters.js';

export {EPG_UNIT_HARD_CAP,EPG_UNIT_LIMIT_DEFAULT};
const HELD=new Set(['film_person_held','film_person_unavailable']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const emptyCounts=()=>({applied:0,noop:0,already:0,unknown:0,failed:0,absent:0,pending:0});
const byId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;

// runId: the EPG run (the source event). at: the write clock. persons: [{id, state}] with `state` = {identity?, localization?, localizationConflicts?} as the source observed it (its own observation times, e.g. `updatedAt`, are content: pass the
// source's, not the run clock, or an unchanged Person is rewritten every run). credits: [{filmId, credits:[{personId, role}]}] in the source's billing order (at most CREDITS_PER_UNIT_MAX per Film; a longer list is refused with
// film_person_bounded: splitting it is a later decision). Returns {event, units:[{kind, id, input}]}.
export function planEpgPersonUnits({runId,at,persons=[],credits=[]}={}){
 const event=epgEvent(runId);
 if(typeof at!=='string'||!at||!Array.isArray(persons)||!Array.isArray(credits))throw failed('film_person_invalid');
 const people=new Map(),films=new Map();
 for(const item of persons){
  if(!plain(item)||typeof item.id!=='string'||!item.id.startsWith('person:')||people.has(item.id))throw failed('film_person_invalid');
  const input={id:item.id,at,person:item.state};
  personStateContent(input);
  people.set(item.id,{kind:PERSON_STATE_OPERATION,id:item.id,input});
 }
 for(const item of credits){
  if(!plain(item)||typeof item.filmId!=='string'||!item.filmId.startsWith('film:')||!Array.isArray(item.credits)||!item.credits.length||films.has(item.filmId))throw failed('film_person_invalid');
  if(item.credits.length>CREDITS_PER_UNIT_MAX)throw failed('film_person_bounded');
  // The unit carries the validated, normalized credits (a malformed or duplicated credit refuses the whole plan before anything is read).
  films.set(item.filmId,{kind:FILM_CREDITS_OPERATION,id:item.filmId,input:{id:item.filmId,at,credits:filmCreditsContent({id:item.filmId,credits:item.credits})}});
 }
 const units=[...[...people.values()].sort(byId),...[...films.values()].sort(byId)];
 return {event,units};
}

// The re-plan the receipts module asks for when it replays or revalidates a receipt: the unit of THIS run for the receipt's kind and target, and only when the receipt belongs to this run: the request id is recomputed from this plan's event,
// the kind, the target and the receipt's digest and must equal the receipt's own. null otherwise (no unit, another run, another kind, a malformed receipt): the receipts module then takes its conservative path.
export function epgPersonReplan(plan){
 const units=new Map((plan?.units||[]).map(unit=>[unit.kind+'\u0000'+unit.id,unit]));
 return async receipt=>{
  const unit=units.get(receipt?.operation+'\u0000'+receipt?.target?.id);
  if(!unit||typeof plan?.event!=='string')return null;
  let expected=null;
  try{expected=await producerRequestId({origin:EPG_ORIGIN,operation:unit.kind,event:plan.event,target:receipt.target,digest:receipt.contentDigest});}catch{return null;}
  if(expected!==receipt.requestId)return null;
  return unit.input;
 };
}

// cursor: index of the next unit (resumable; persist it in the run state). limit: units per call. Returns
//   {skipped:true, reason:'projector_is_writer', ...}                                 marker not open: one marker read, nothing else;
//   {skipped:false, cursor, done, counts:{...}, failures:[{id,code}], stoppedBy}       a bounded pass; `done` when every unit was visited; `stoppedBy` is the held code when the pass stopped on it.
export async function applyEpgPersonUnits(env,{plan,cursor=0,limit=EPG_UNIT_LIMIT_DEFAULT,now,policy}={}){
 if(!plan||!Array.isArray(plan.units)||typeof plan.event!=='string'||!Number.isInteger(cursor)||cursor<0)throw failed('film_person_invalid');
 const cap=epgUnitCap(limit);
 if(!(await producerRouteOpen(env)))return {skipped:true,reason:'projector_is_writer',cursor,done:false,counts:emptyCounts(),failures:[]};
 const counts=emptyCounts(),failures=[];
 let index=cursor,stoppedBy=null;
 for(;index<plan.units.length&&index-cursor<cap;index++){
  const unit=plan.units[index];
  try{
   const apply=APPLY_UNIT[unit.kind];
   if(!apply)throw failed('film_person_invalid');
   const outcome=await apply(env,{origin:EPG_ORIGIN,event:plan.event,input:unit.input,...(now?{now}:{}),...(policy?{policy}:{})});
   if(outcome.state==='absent')counts.absent++;
   else if(outcome.state==='noop')counts.noop++;
   else if(outcome.already===true)counts.already++;
   else if(outcome.state==='applied')counts.applied++;
   else if(outcome.state==='unknown')counts.unknown++;
   else if(outcome.state==='failed')counts.failed++;
   else counts.pending++;
  }catch(error){
   const code=typeof error?.code==='string'?error.code:'film_person_unavailable';
   if(HELD.has(code)){stoppedBy=code;break;}
   counts.failed++;failures.push({id:unit.id,code});
  }
 }
 return {skipped:false,cursor:index,done:index>=plan.units.length,counts,failures,stoppedBy};
}

// E2: the origin's own receipts only, ALL its kinds in one bounded pass (the adapter's inline limit). `plan` supplies the re-plan of THIS run's Person and credit units, `filmPlan` (optional) that of the Film units of ADR 0125; a receipt of
// an earlier run, or of a kind with no plan, is abandoned `producer_source_changed`, backs off or waits: never replayed.
export async function reconcileEpgRun(env,{plan,filmPlan,limit,now,policy}={}){
 // ONE run: the Person/credit plan and the Film plan, when both are supplied, must carry the same source event. Malformed plan metadata or two different runs are refused BEFORE any operation is built or any receipt is read, so an old run's
 // `film_facts` receipt can never be replayed beside another run's Person units.
 const eventOfPlan=value=>{
  if(value===undefined||value===null)return null;
  if(!plain(value)||typeof value.event!=='string'||!value.event)throw failed('film_person_invalid');
  return value.event;
 };
 const personEvent=eventOfPlan(plan),filmEvent=eventOfPlan(filmPlan);
 if(personEvent!==null&&filmEvent!==null&&personEvent!==filmEvent)throw failed('film_person_run_mismatch');
 const clock=now?{now}:{};
 const personReplan=epgPersonReplan(plan);
 const operations=new Map([
  [FILM_FACTS_OPERATION,filmFactsOperation({replan:epgReplan(filmPlan,env),...clock})],
  [PERSON_STATE_OPERATION,unitOperation(PERSON_STATE_OPERATION,{replan:personReplan,...clock})],
  [FILM_CREDITS_OPERATION,unitOperation(FILM_CREDITS_OPERATION,{replan:personReplan,...clock})],
 ]);
 return reconcileOwnOrigin(env,{origin:EPG_ORIGIN,operations,...(limit!==undefined?{limit}:{}),...clock,...(policy?{policy}:{})});
}

// ADR 0128 decision 9 (S4-1): the same plan with PER-UNIT refusals instead of a whole-plan refusal. `planEpgPersonUnits` is unchanged (an accepted, tested whole-plan behaviour). A Person or a Film whose id is usable but whose content is refused
// (`film_person_invalid`: a malformed state, an empty or malformed credit list, a duplicated credit; `film_person_bounded`: more than CREDITS_PER_UNIT_MAX credits) is reported in `refused:[{kind,id,code,source}]` (`source` is the incoming value, never truncated; the
// run module digests it) and the rest of the plan survives. An id that is already used by ANY other entry, refused or not, in either order, is a malformed input and refuses the whole plan; so does an item with no usable id (it has no key to record a result under).
export function planEpgPersonUnitsWithRefusals({runId,at,persons=[],credits=[]}={}){
 if(!Array.isArray(persons)||!Array.isArray(credits))throw failed('film_person_invalid');
 const keepPersons=[],keepCredits=[],refused=[],seen=new Set();
 const source=value=>value===undefined?null:value;
 for(const item of persons){
  if(plain(item)&&typeof item.id==='string'&&item.id.startsWith('person:')){
   if(seen.has(item.id))throw failed('film_person_invalid');
   seen.add(item.id);
   let ok=true;
   try{personStateContent({id:item.id,at,person:item.state});}catch(error){if(error?.code!=='film_person_invalid')throw error;ok=false;}
   if(!ok){refused.push({kind:PERSON_STATE_OPERATION,id:item.id,code:'film_person_invalid',source:source(item.state)});continue;}
  }
  keepPersons.push(item);
 }
 const refusedFilms=[];
 for(const item of credits){
  if(plain(item)&&typeof item.filmId==='string'&&item.filmId.startsWith('film:')){
   if(seen.has(item.filmId))throw failed('film_person_invalid');
   seen.add(item.filmId);
   const over=Array.isArray(item.credits)&&item.credits.length>CREDITS_PER_UNIT_MAX;
   let ok=!over;
   if(ok)try{filmCreditsContent({id:item.filmId,credits:item.credits});}catch(error){if(error?.code!=='film_person_invalid')throw error;ok=false;}
   if(!ok){refusedFilms.push({kind:FILM_CREDITS_OPERATION,id:item.filmId,code:over?'film_person_bounded':'film_person_invalid',source:source(item.credits)});continue;}
  }
  keepCredits.push(item);
 }
 const plan=planEpgPersonUnits({runId,at,persons:keepPersons,credits:keepCredits});
 return {...plan,refused:[...refused.sort(byId),...refusedFilms.sort(byId)]};
}
