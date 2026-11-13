// AIR-374 P3a, Person and credit units (ADR 0126). The producer-side receipt adapters for TWO more operation kinds, in the pattern of src/canonical-producer-adapters.js (ADR 0123). DORMANT: nothing in the Worker imports this module,
// it is not bundled (build.mjs is unchanged) and no route, job or cron calls it. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: every entry point reads the marker ONCE through
// `writerRoute` and, unless it is `open`, returns `skipped` before any other statement. `held` and an unreadable marker throw (a producer defers, it never falls back to R2).
// ONE source of truth for ownership: this module writes NOTHING itself. Every canonical mutation goes through the existing fenced writers, `recordPersonState` (src/canonical-person-state.js) and `mutateFilm` (src/canonical-mutations.js),
// each with the P3-0a `receiptMark` tail, so the mutation and its applied receipt are ONE fenced batch. There is no second write path and no SQL of this module that changes a canonical table.
//   - `person_state`   one Person's identity and effective localization state, its held-value alias and conflicts (`recordPersonState`). The stored row is never downgraded: a reviewed or owner value is kept by the writer's own guard and the
//                      incoming value becomes a conflict and an alias. A Person the store does not hold is `absent` (no receipt, never created).
//   - `film_credits`   the credit membership of ONE Film: credits that are missing are added (`mutateFilm` credits.upsert, no removal, no renumbering, so the D1-only credits survive), appended after the highest ordinal of their role in the
//                      producer's own order. The Film row keeps its stored contract version, identity and title (the writer COALESCEs them); like every mutateFilm call it sets `film.updated_at` and the revision clock to the write clock. A Film the
//                      store does not hold is `absent` (never created), a redirected Film and a credit whose Person is missing are refused BEFORE any receipt (`film_person_redirect`, `film_person_reference`).
// Per unit, as for `film_facts`: the stable request id comes from the SOURCE EVENT, the TARGET and the content digest (never the content alone, so an A to B to A flip is three requests); the pre-plan reads the stored rows and a NO-OP ends
// there with no receipt (E5); one atomic receipted batch otherwise; an uncertain race (nothing left to write) ends `unknown`/`atomic_mark_missing`, never a second marking batch; a replay re-plans from the producer's own source and is
// refused when the digest moved. Reconciliation is the origin's own bounded inline pass (E2): no cron, no tick, no global pass.
// Stored: operation kind, origin, target, digests, revisions, state; no payload, title, name or personal data.
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-writer-route.js';
import {RETRY_POLICY,defineOperation,digestOf,receiptedWrite} from './canonical-receipts.js';
import {readPersonStatePlan,recordPersonState} from './canonical-person-state.js';
import {mutateFilm} from './canonical-mutations.js';
import {SOURCE_CHANGED,producerRequestId} from './canonical-producer-adapters.js';

export const PERSON_STATE_OPERATION='person_state';
export const FILM_CREDITS_OPERATION='film_credits';
// mutateFilm is capped at 60 statements and a credit upsert costs one each, beside six fixed ones (fence, revision, redirect, existence, Film upsert, bump): a unit carries at most this many credits.
export const CREDITS_PER_UNIT_MAX=50;
const ROLES=new Set(['director','actor']);
// The typed refusals the planners throw about the CONTENT or the state of the target (not about reading it): a malformed unit, a redirected Film, a missing credit Person, an oversized list.
export const CONTENT_REFUSALS=new Set(['film_person_invalid','film_person_redirect','film_person_reference','film_person_bounded']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

// ---- content (what the digest binds) ----
// A Person's content is its state as the source observed it: the observation times it carries (`updatedAt`, a conflict's `at`) are part of what is written, so they are content; the write clock `at` of the unit is not.
export function personStateContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('person:')||!plain(input.person)||(!input.person.identity&&!input.person.localization))throw failed('film_person_invalid');
 return input.person;
}
// A Film's credit membership is an ORDERED list (a new credit is appended in the producer's order), without duplicates, of at most CREDITS_PER_UNIT_MAX.
export function filmCreditsContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('film:')||!Array.isArray(input.credits)||!input.credits.length||input.credits.length>CREDITS_PER_UNIT_MAX)throw failed('film_person_invalid');
 const seen=new Set(),out=[];
 for(const credit of input.credits){
  if(!plain(credit)||typeof credit.personId!=='string'||!credit.personId.startsWith('person:')||!ROLES.has(credit.role))throw failed('film_person_invalid');
  const key=JSON.stringify([credit.personId,credit.role]);
  if(seen.has(key))throw failed('film_person_invalid');
  seen.add(key);out.push({personId:credit.personId,role:credit.role});
 }
 return out;
}
const CONTENT={[PERSON_STATE_OPERATION]:personStateContent,[FILM_CREDITS_OPERATION]:filmCreditsContent};
export async function unitDigest(operation,input){
 const content=CONTENT[operation];
 if(!content)throw failed('film_person_invalid');
 return digestOf({operation,id:input?.id,content:content(input)});
}

// ---- read-only plans: {absent, noop, revision, ...} ----
const revisionOf=async(db,kind,id)=>Number((await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]))?.revision??0);
const keyOf=(personId,role)=>JSON.stringify([personId,role]);

// The stored rows against the wanted credits. Throws before any receipt: film_person_redirect (a retired Film), film_person_reference (a missing credit's Person must exist first: this never creates one).
async function planCredits(env,input){
 const credits=filmCreditsContent(input);
 const db=database(env);
 const revision=await revisionOf(db,'film',input.id);
 const film=await one(db,'SELECT contract_version FROM film WHERE id=?',[input.id]);
 if(!film)return {absent:true,noop:false,revision,missing:[]};
 if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[input.id]))throw failed('film_person_redirect');
 const marks=credits.map(()=>'?').join(',');
 const have=new Set((await many(db,`SELECT person_id,role FROM film_person_credit WHERE film_id=? AND person_id IN (${marks})`,[input.id,...credits.map(credit=>credit.personId)])).map(row=>keyOf(row.person_id,row.role)));
 const missing=credits.filter(credit=>!have.has(keyOf(credit.personId,credit.role)));
 if(missing.length){
  const ids=[...new Set(missing.map(credit=>credit.personId))];
  const found=new Set((await many(db,`SELECT id FROM person WHERE id IN (${ids.map(()=>'?').join(',')})`,ids)).map(row=>row.id));
  if(ids.some(id=>!found.has(id)))throw failed('film_person_reference');
 }
 return {absent:false,noop:missing.length===0,revision,missing,contractVersion:film.contract_version};
}

const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
// Per kind: the entity kind of the target, the read-only plan and the fenced write (the existing writer, with the receipt tail).
const KINDS={
 [PERSON_STATE_OPERATION]:{
  entity:'person',
  plan:(env,input)=>{personStateContent(input);return readPersonStatePlan(env,input);},
  write:(env,input,requestId,ctx,clock)=>recordPersonState(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at,requestId,person:input.person,receiptMark:mark(ctx,clock)}),
 },
 [FILM_CREDITS_OPERATION]:{
  entity:'film',
  plan:planCredits,
  // The credits still missing NOW, from a fresh read. Nothing missing means nothing to write: no batch, so no receipt mark (the receipt then ends `unknown`, E5). A Film that vanished is refused, never created: before the batch by this read, and
  // INSIDE the batch (the writer's `requireExisting` assertion) for a Film that disappears after this read, so the whole batch, receipt included, rolls back instead of the upsert recreating it.
  write:async(env,input,requestId,ctx,clock)=>{
   const snapshot=await planCredits(env,input);
   if(snapshot.absent)throw failed('film_person_reference');
   if(snapshot.noop)return {id:input.id,revision:snapshot.revision,already:true};
   return mutateFilm(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at,film:{contractVersion:snapshot.contractVersion},credits:{upsert:snapshot.missing},requireExisting:true,receiptMark:mark(ctx,clock)});
  },
 },
};

// The registry spec of one kind, for `reconcileReceipts`. replan(receipt) -> the unit input of the receipt's target, or null. A re-plan whose digest is not the receipt's is a SOURCE THAT MOVED ON (typed terminal abandon).
export function unitOperation(operation,{replan,now=()=>new Date().toISOString()}={}){
 const spec=KINDS[operation];
 if(!spec||typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch{input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await unitDigest(operation,input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 // Only a genuine content or precondition refusal of the planner (CONTENT_REFUSALS) means 'no plan'. A read failure (film_person_unavailable, a D1 transport or SQL exception) PROPAGATES: the reconciler then records an unsettled
 // observation or a waiting readback and leaves the receipt due, instead of abandoning it as stale on a transient error.
 const planOf=async(env,input)=>{try{return await spec.plan(env,input);}catch(error){if(CONTENT_REFUSALS.has(error?.code))return null;throw error;}};
 return defineOperation({
  operation,
  atomic:true,
  // Does the store already hold every planned fact? Content alone is never proof (the receipts module turns it into `needs_review`); an absent effect lets the same request id be retried.
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   if(!found)return {digest:null,revision:await revisionOf(database(env),spec.entity,target.id)};
   const plan=await planOf(env,found.input);
   const revision=plan?plan.revision:await revisionOf(database(env),spec.entity,target.id);
   return {digest:plan?.noop?receipt.contentDigest:null,revision};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return spec.write(env,found.input,receipt.requestId,ctx,now);
  },
  // Called only when the revision moved since planning: proceed when the facts would still change something; superseded when they would not or the entity is absent (never created); no re-plan or a refusal: repair.
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const plan=await planOf(env,found.input);
   if(!plan)return 'stale';
   return plan.absent||plan.noop?'superseded':'proceed';
  },
 });
}

// ONE unit, once per source event. opts: {origin, event, input, replan?, now?, policy?}. Returns:
//   {state:'skipped', reason:'projector_is_writer', receipt:false}   the marker is not `open`: one marker read, nothing else;
//   {state:'absent', receipt:false}                                  the Person or Film is not in the store: nothing is created;
//   {state:'noop', receipt:false}                                    the facts are already stored: no receipt, no batch;
//   {state:'applied'|'unknown'|..., requestId, ...}                  the receiptedWrite outcome (`already:true` when the same request was applied before).
async function applyUnit(operation,env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const spec=KINDS[operation];
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 const digest=await unitDigest(operation,input);
 const target={kind:spec.entity,id:input.id};
 const requestId=await producerRequestId({origin,operation,event,target,digest});
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await spec.plan(env,input);
 if(plan.absent)return {state:'absent',receipt:false,requestId};
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const hooks=unitOperation(operation,{replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,
  readback:hooks.readback,
  revalidate:hooks.revalidate,
  run:ctx=>spec.write(env,input,requestId,ctx,clock),
 });
 return {...outcome,requestId};
}
// input: {id:'person:...', at, person:{identity?, localization?, localizationConflicts?}} (the recordPersonState input without expectedRevision, requestId and receiptMark).
export const applyPersonState=(env,options)=>applyUnit(PERSON_STATE_OPERATION,env,options);
// input: {id:'film:...', at, credits:[{personId, role}]}.
export const applyFilmCredits=(env,options)=>applyUnit(FILM_CREDITS_OPERATION,env,options);
// AIR-374 M2: the READ-ONLY plan of one unit ({absent, noop, revision, ...}), for the offline dry-run harness (scripts/epg-producer-dry-run.mjs). It reads the stored rows and writes nothing; it throws what the planner throws.
export async function planUnit(operation,env,input){
 const spec=KINDS[operation];
 if(!spec)throw failed('film_person_invalid');
 return spec.plan(env,input);
}
export const APPLY_UNIT={[PERSON_STATE_OPERATION]:applyPersonState,[FILM_CREDITS_OPERATION]:applyFilmCredits};
