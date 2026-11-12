// AIR-374 P3a, PLANNING AND APPLY LAYER of the EPG producer for canonical Film facts (ADR 0124; owner decisions E2 and E5 of 12 Nov 2026). DORMANT: nothing in the Worker imports this module, it is not bundled (build.mjs is unchanged),
// `epgSync` does not call it and no route, job or cron does. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: `applyEpgUnits` and `reconcileEpg` read the marker ONCE through the
// adapter's route gate and, unless it is `open`, return `skipped` before any other statement. `held` and an unreadable marker throw (the producer defers, it never falls back to R2).
// Scope (the smallest unambiguous subset of P3a): the operation kind `film_facts` only, with every input INJECTED. What this layer does NOT do: read R2, the EPG or the dictionary store, change `epgSync`, register operations in
// PRODUCER_OPERATIONS, or write Person, credit or localization-conflict kinds (those need their own adapters), so `handoffReadiness` still reports `producer_not_wired:epg_commit`, truthfully.
//   - `planEpgUnits`      PURE. One unit per Film that the run observed (its facts) and one release-only unit per departed member (watchlist false). Deterministic order (by id), duplicates refused, the run id is the source event.
//   - `applyEpgUnits`     bounded, resumable by cursor. At most `limit` units per call (injected, hard ceiling EPG_UNIT_HARD_CAP: the E6 production measurement is not done, so the ceiling is provisional). Each unit goes through
//                         `applyFilmFacts` (no-op pre-plan before any receipt, ONE atomic fenced batch with the applied receipt, uncertain race = unknown, never a silent second batch). A refusal of one unit never blocks the others;
//                         `film_person_held` / `film_person_unavailable` stop the pass and keep the cursor on that unit. A release-only unit is resolved against the stored Film row: absent is skipped (a release never creates a Film), present keeps its contract version, identity, title and updated_at.
//   - `epgReplan`         the producer's re-plan for the receipts replay: the unit of the run for a receipt target, or null; the receipt's request id is recomputed from THIS run's event, so a receipt of another run is never replayed.
//   - `reconcileEpg`      E2: the adapter's bounded inline reconcile for the origin `epg` only. No cron, no tick, no global pass.
// Request ids come from the run id (the event), the Film (the target) and the content digest of the adapter; the same run observing the same Film twice is the same request, a new run or other content is another one.
// Stored: operation kind, origin, target, digests, revisions, state; no payload, title or personal data.
import {failed} from './film-person-authority.js';
import {FILM_FACTS_OPERATION,applyFilmFacts,filmFactsOperation,producerRequestId,producerRouteOpen,reconcileOwnOrigin,resolveReleaseInput} from './canonical-producer-adapters.js';

export const EPG_ORIGIN='epg';
// Provisional ceiling of units per call: ~10 D1 round trips per changed Film against the repository's 800-query run budget leaves room for fewer than 80. The real per-run size is the E6 measurement (production read, not authorized here).
export const EPG_UNIT_HARD_CAP=50;
export const EPG_UNIT_LIMIT_DEFAULT=25;
const HELD=new Set(['film_person_held','film_person_unavailable']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const eventOf=runId=>{
 if(typeof runId!=='string'||!runId.trim()||runId.length>280)throw failed('film_person_invalid');
 return 'epg:'+runId;
};

// runId: the EPG run (the source event). at: the write clock. films: [{id, facts}], `facts` being the film-facts input without id, at, requestId, expectedRevision and receiptMark (film, dimensions, localization, metadata, sync, watchlist).
// departed: [filmId] members of the previous generation that this run released. Returns {event, units:[{id, release, input}]}; a Film both observed and departed is observed (membership wins) and the duplicate is refused.
export function planEpgUnits({runId,at,films=[],departed=[]}={}){
 const event=eventOf(runId);
 if(typeof at!=='string'||!at||!Array.isArray(films)||!Array.isArray(departed))throw failed('film_person_invalid');
 const units=new Map();
 for(const item of films){
  if(!plain(item)||typeof item.id!=='string'||!item.id.startsWith('film:')||!plain(item.facts)||units.has(item.id))throw failed('film_person_invalid');
  const {id:_id,at:_at,requestId:_r,expectedRevision:_e,receiptMark:_m,...facts}=item.facts;
  units.set(item.id,{id:item.id,release:false,input:{...facts,id:item.id,at}});
 }
 for(const id of departed){
  if(typeof id!=='string'||!id.startsWith('film:'))throw failed('film_person_invalid');
  if(units.has(id))continue;
  units.set(id,{id,release:true,input:{id,at,release:true,watchlist:false}});
 }
 return {event,units:[...units.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}

// The re-plan the receipts module asks for when it replays or revalidates a receipt: the unit of THIS run for the receipt's Film, and only when the receipt belongs to this run: the request id is recomputed from this plan's event, the
// receipt's target and its content digest and must equal the receipt's own (a digest alone does not encode the event, so a receipt of run A would otherwise replay from run B that observed the same facts). null otherwise (no unit, another
// run, a malformed receipt): the receipts module then treats it as no re-plan (counted retry with backoff, abandoned by attempts or expiry; never abandoned merely because another run is planned). A release-only unit is resolved
// against the stored Film through `env`; with no `env` or no stored Film it cannot be re-planned (a release never creates a Film).
export function epgReplan(plan,env){
 const byId=new Map((plan?.units||[]).map(unit=>[unit.id,unit]));
 return async receipt=>{
  const unit=byId.get(receipt?.target?.id);
  if(!unit||typeof plan?.event!=='string')return null;
  let expected=null;
  try{expected=await producerRequestId({origin:EPG_ORIGIN,event:plan.event,target:receipt.target,digest:receipt.contentDigest});}catch{return null;}
  if(expected!==receipt.requestId)return null;
  if(!unit.release)return unit.input;
  return env?resolveReleaseInput(env,unit.input):null;
 };
}

// The units one call may visit: the injected limit raised to at least 1 and never above the hard ceiling.
export const epgUnitCap=limit=>Math.min(Math.max(Number(limit)||1,1),EPG_UNIT_HARD_CAP);
const emptyCounts=()=>({applied:0,noop:0,already:0,unknown:0,failed:0,absent:0,pending:0});

// cursor: index of the next unit (resumable; persist it in the run state). limit: units per call. Returns
//   {skipped:true, reason:'projector_is_writer'}                                      marker not open: one marker read, nothing else;
//   {skipped:false, cursor, done, counts:{...}, failures:[{id,code}], stoppedBy}       a bounded pass; `done` when every unit was visited; `stoppedBy` is the held code when the pass stopped on it.
export async function applyEpgUnits(env,{plan,cursor=0,limit=EPG_UNIT_LIMIT_DEFAULT,now,policy}={}){
 if(!plan||!Array.isArray(plan.units)||typeof plan.event!=='string'||!Number.isInteger(cursor)||cursor<0)throw failed('film_person_invalid');
 const cap=epgUnitCap(limit);
 // One marker read through the adapter's own gate: an empty pass at a non-open marker costs exactly that read.
 if(!(await producerRouteOpen(env)))return {skipped:true,reason:'projector_is_writer',cursor,done:false,counts:emptyCounts(),failures:[]};
 const counts=emptyCounts(),failures=[];
 let index=cursor,stoppedBy=null;
 for(;index<plan.units.length&&index-cursor<cap;index++){
  const unit=plan.units[index];
  try{
   let input=unit.input;
   if(unit.release){
    // A release never creates a Film and never rewrites one: it is resolved against the STORED Film row (its own contract version and updated_at, no identity or title), so only membership and the revision change. No stored row: nothing to release.
    input=await resolveReleaseInput(env,unit.input);
    if(!input){counts.absent++;continue;}
   }
   const outcome=await applyFilmFacts(env,{origin:EPG_ORIGIN,event:plan.event,input,...(now?{now}:{}),...(policy?{policy}:{})});
   if(outcome.state==='noop')counts.noop++;
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

// E2: the producer's own receipts only, at most the adapter's inline bound per call. `plan` supplies the re-plan of THIS run; a receipt of an earlier run is then abandoned `producer_source_changed` or backs off, never replayed.
export async function reconcileEpg(env,{plan,limit,now,policy}={}){
 const operations=new Map([[FILM_FACTS_OPERATION,filmFactsOperation({replan:epgReplan(plan,env),...(now?{now}:{})})]]);
 return reconcileOwnOrigin(env,{origin:EPG_ORIGIN,operations,...(limit!==undefined?{limit}:{}),...(now?{now}:{}),...(policy?{policy}:{})});
}
