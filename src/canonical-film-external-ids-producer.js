// AIR-374 P3a, `film_external_ids` unit (ADR 0133; the owner-mandated FIX of the differential exception `external_ids_not_pruned_by_the_planner`, owner decision of 13 Nov 2026). The producer-side receipt adapter for the TYPED EXTERNAL IDS OF
// A FILM: it adds the ids the source now lists and REMOVES the ids the source dropped, so an outdated external id cannot keep resolving a Film. DORMANT: nothing in the Worker imports this module, it is not bundled (build.mjs is unchanged) and no
// route, job or cron calls it. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: `applyFilmExternalIds` reads the marker ONCE through `writerRoute` and, unless it is `open`, returns `skipped` before any
// other statement. `held` and an unreadable marker throw (a producer defers, it never falls back to R2).
// ONE source of truth for ownership: this module writes NOTHING itself. The only canonical write is the existing fenced writer `mutateFilm` (src/canonical-mutations.js, `removeExternalIds` then `externalIds`) with the P3-0a `receiptMark` tail and
// `requireExisting: true`, so the mutation and its applied receipt are ONE fenced batch. There is no second write path and no SQL of this module that changes a canonical table.
// WHY A NEW KIND. `film_mutation` is also the kind of the Discovery admission and ADR 0126 decision 2 keeps one registry spec per kind, so the Film external-id unit has its own closed kind, `film_external_ids`, exactly as `person_mutation` has its own.
// WHAT THE UNIT OWNS. Not the whole external-id set of a Film (other writers add ids too: the Letterboxd id of a rated admission, owner ids), but the ids of the SCHEMES THE SOURCE OWNS. The input names them (`schemes`, non-empty) and every source id
// must be in one of them. Inside those schemes the unit makes the Film's stored set equal to the source set (add what is missing, remove what the source dropped); an id of any other scheme is never touched. An empty source set with a non-empty
// `schemes` therefore removes every stored id of those schemes, which is the only way an id can leave, and it is explicit: `externalIds` must be present as an own array property, so `[]` means "the source lists none" while an omitted, undefined or null field is refused `film_person_invalid`.
// WHAT IT NEVER REMOVES OR WRITES (typed refusals BEFORE any receipt, never a silent skip):
//   - an id the Film's identity stands on: the trusted tmdb id of `film.canonical_identity` (`tmdb:<n>`) and the tmdb id of the Film's rated admission (`film_rated_admission.tmdb`). A source that drops one is refused `film_person_identity_conflict`; the owner or
//     the dictionary decides that, a producer does not. Silent loss of a primary identity is not acceptable.
//   - a trusted id owned by ANOTHER Film (the partial unique index `film_external_id_one_trusted`), or a second trusted value for one scheme of this Film: `identity_collision`.
//   - a redirected Film: `film_person_redirect`. An absent Film is `absent` and nothing is created (the Film row belongs to the facts unit).
//   - an id that is already stored keeps its stored trust, conflict flag and provenance (it is neither removed nor rewritten when the source still lists it); changing the TRUST of a stored id is not this unit's job.
// The unit does not touch aliases, credits, the Film row's identity or title, localization or membership. Its write bumps `film.updated_at` and the Film revision like every `mutateFilm` call (accepted exception `updated_at_is_write_time`), and only on a real
// write: a no-op writes nothing and has no receipt (E5).
// Per unit, as for `person_mutation`: the stable request id comes from the SOURCE EVENT, the TARGET and the content digest (source ids and owned schemes; the removals are derived from the stored rows at plan time and are not part of the digest); the
// pre-plan reads the stored rows and a NO-OP ends there with no receipt; one atomic receipted batch otherwise; an uncertain race (nothing left to write) ends `unknown`/`atomic_mark_missing`, never a second marking batch; a replay re-plans from the
// producer's own source and is refused when the digest moved. Reconciliation is the origin's own bounded inline pass (E2). Stored: operation kind, origin, target, digests, revisions, state; no payload, name or personal data.
import {RETRY_POLICY,defineOperation,digestOf,receiptedWrite} from './canonical-receipts.js';
import {mutateFilm} from './canonical-mutations.js';
import {SOURCE_CHANGED,producerRequestId} from './canonical-producer-adapters.js';
import {CONTENT_REFUSALS} from './canonical-person-adapters.js';
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-writer-route.js';

export const FILM_EXTERNAL_IDS_OPERATION='film_external_ids';
// mutateFilm is capped at 60 statements and one D1 statement binds at most 100 values: six are fixed (fence, revision, redirect and presence assertions, row upsert, bump), the rest is one per added and per removed id.
export const FILM_EXTERNAL_IDS_PER_UNIT_MAX=40;
const SCHEME=/^[a-z][a-z0-9_]{0,31}$/;
// The typed refusals the planner throws about the CONTENT or the state of the target: the shared ones plus the identity ones. Anything else (a read failure) propagates.
export const FILM_EXTERNAL_IDS_REFUSALS=new Set([...CONTENT_REFUSALS,'identity_collision','film_person_identity_conflict']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const filled=value=>typeof value==='string'&&value.trim()!=='';
const byKey=(a,b)=>a<b?-1:a>b?1:0;
const keyOf=(scheme,value)=>JSON.stringify([scheme,String(value)]);

// ---- content (what the digest binds) ----
// {schemes:[...] (a set, sorted), externalIds:[{scheme,value,trusted,conflicting,provenance}] (a set, sorted)}. The write clock `at` is not content.
export function filmExternalIdsContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('film:')||input.id.length<=5)throw failed('film_person_invalid');
 // The source set must be PRESENT and an array (an own property): `[]` is an intentional, authoritative empty set and prunes the owned schemes, but an omitted, undefined or null `externalIds` is a malformed or partial input and is refused before any
 // receipt, read-for-write or batch. A missing field is never read as "the source has no ids".
 if(!Array.isArray(input.schemes)||!input.schemes.length||!Object.hasOwn(input,'externalIds')||!Array.isArray(input.externalIds))throw failed('film_person_invalid');
 const schemes=[];
 for(const scheme of input.schemes){
  if(typeof scheme!=='string'||!SCHEME.test(scheme)||schemes.includes(scheme))throw failed('film_person_invalid');
  schemes.push(scheme);
 }
 const externalIds=[],seen=new Set();
 for(const item of input.externalIds){
  if(!plain(item)||!filled(item.scheme)||!schemes.includes(item.scheme)||!(typeof item.value==='string'||typeof item.value==='number')||!filled(String(item.value)))throw failed('film_person_invalid');
  const key=keyOf(item.scheme,item.value);
  if(seen.has(key))throw failed('film_person_invalid');
  seen.add(key);
  const conflicting=item.conflicting?true:false;
  externalIds.push({scheme:item.scheme,value:String(item.value),trusted:item.trusted&&!conflicting?true:false,conflicting,provenance:item.provenance??null});
 }
 if(externalIds.length>FILM_EXTERNAL_IDS_PER_UNIT_MAX)throw failed('film_person_bounded');
 schemes.sort();
 externalIds.sort((a,b)=>byKey(keyOf(a.scheme,a.value),keyOf(b.scheme,b.value)));
 return {schemes,externalIds};
}
export async function filmExternalIdsDigest(input){
 return digestOf({operation:FILM_EXTERNAL_IDS_OPERATION,id:input?.id,content:filmExternalIdsContent(input)});
}

// ---- read-only plan: {absent, noop, action, revision, contractVersion, add, remove} ----
const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);
// Throws before any receipt: film_person_redirect (the Film is a redirect source), film_person_identity_conflict (the source drops an id the identity stands on), identity_collision (a trusted id owned by another Film, or two trusted values of one scheme).
// action: 'update' (something to add or remove) or 'none'; `absent` is true only for a Film that is not in the store (nothing is created).
export async function planFilmExternalIds(env,input){
 const content=filmExternalIdsContent(input);
 const db=database(env);
 const revision=await revisionOf(db,input.id);
 const row=await one(db,'SELECT contract_version,canonical_identity FROM film WHERE id=?',[input.id]);
 if(!row)return {absent:true,noop:false,action:'none',revision,add:[],remove:[]};
 if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[input.id]))throw failed('film_person_redirect');
 const stored=await many(db,'SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=?',[input.id]);
 const have=new Set(stored.map(item=>keyOf(item.scheme,item.value)));
 const want=new Set(content.externalIds.map(item=>keyOf(item.scheme,item.value)));
 const add=content.externalIds.filter(item=>!have.has(keyOf(item.scheme,item.value)));
 const remove=stored.filter(item=>content.schemes.includes(item.scheme)&&!want.has(keyOf(item.scheme,item.value))).map(item=>({scheme:item.scheme,value:String(item.value)}));
 remove.sort((a,b)=>byKey(keyOf(a.scheme,a.value),keyOf(b.scheme,b.value)));
 if(add.length+remove.length>FILM_EXTERNAL_IDS_PER_UNIT_MAX)throw failed('film_person_bounded');
 if(remove.length){
  // The ids the identity stands on: the canonical identity (`tmdb:<n>`) and the rated admission of this Film.
  const protectedKeys=new Set();
  if(typeof row.canonical_identity==='string'&&row.canonical_identity.startsWith('tmdb:'))protectedKeys.add(keyOf('tmdb',row.canonical_identity.slice(5)));
  const admission=await one(db,'SELECT tmdb FROM film_rated_admission WHERE film_id=?',[input.id]);
  if(admission)protectedKeys.add(keyOf('tmdb',admission.tmdb));
  for(const item of remove)if(protectedKeys.has(keyOf(item.scheme,item.value)))throw failed('film_person_identity_conflict');
 }
 const gone=new Set(remove.map(item=>keyOf(item.scheme,item.value)));
 const trusted=new Map();
 for(const item of stored)if(item.trusted===1&&item.conflicting===0&&!gone.has(keyOf(item.scheme,item.value)))trusted.set(item.scheme,new Set([...(trusted.get(item.scheme)||[]),String(item.value)]));
 for(const item of add){
  if(!item.trusted)continue;
  if(await one(db,'SELECT 1 AS x FROM film_external_id WHERE scheme=? AND value=? AND trusted=1 AND conflicting=0 AND film_id<>?',[item.scheme,item.value,input.id]))throw failed('identity_collision');
  trusted.set(item.scheme,new Set([...(trusted.get(item.scheme)||[]),item.value]));
 }
 for(const values of trusted.values())if(values.size>1)throw failed('identity_collision');
 const noop=add.length===0&&remove.length===0;
 return {absent:false,noop,action:noop?'none':'update',revision,contractVersion:row.contract_version,add,remove};
}

const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
// The fenced write: what is still to add or remove NOW, from a fresh read, through `mutateFilm` with the receipt tail and `requireExisting`. Nothing to write means no batch, so no receipt mark (the receipt then ends `unknown`, E5). A Film that vanished is
// refused; what the fresh read saw is proven again INSIDE the batch (the Film row must exist, the revision is the one read).
async function writeUnit(env,input,requestId,ctx,clock){
 const plan=await planFilmExternalIds(env,input);
 if(plan.absent)throw failed('film_person_reference');
 if(plan.noop)return {id:input.id,revision:plan.revision,already:true};
 return mutateFilm(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at,requireExisting:true,
  film:{contractVersion:plan.contractVersion,
   removeExternalIds:plan.remove.map(({scheme,value})=>({scheme,value})),
   externalIds:plan.add.map(({scheme,value,trusted,conflicting,provenance})=>({scheme,value,trusted,conflicting,provenance}))},
  receiptMark:mark(ctx,clock)});
}

// The registry spec for `reconcileReceipts`. replan(receipt) -> the unit input of the receipt's target, or null (a receipt of another run is never replayed: the caller's re-plan checks the run). A re-plan whose digest is not the receipt's is a SOURCE
// THAT MOVED ON (typed terminal abandon).
export function filmExternalIdsOperation({replan,now=()=>new Date().toISOString()}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch{input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await filmExternalIdsDigest(input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 // Only a genuine content or precondition refusal means 'no plan'; a read failure (film_person_unavailable, a D1 transport or SQL exception) PROPAGATES so the receipt stays due instead of being abandoned as stale.
 const planOf=async(env,input)=>{try{return await planFilmExternalIds(env,input);}catch(error){if(FILM_EXTERNAL_IDS_REFUSALS.has(error?.code))return null;throw error;}};
 return defineOperation({
  operation:FILM_EXTERNAL_IDS_OPERATION,
  atomic:true,
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   if(!found)return {digest:null,revision:await revisionOf(database(env),target.id)};
   const plan=await planOf(env,found.input);
   return {digest:plan?.noop?receipt.contentDigest:null,revision:plan?plan.revision:await revisionOf(database(env),target.id)};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return writeUnit(env,found.input,receipt.requestId,ctx,now);
  },
  // Called only when the revision moved since planning: proceed when the source would still change something; superseded when it would not or the Film is absent; no re-plan or a refusal: repair.
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const plan=await planOf(env,found.input);
   if(!plan)return 'stale';
   return plan.absent||plan.noop?'superseded':'proceed';
  },
 });
}

// ONE unit, once per source event. opts: {origin, event, input, replan?, now?, policy?}; input: {id:'film:...', at, schemes:[...], externalIds?:[{scheme,value,trusted?,conflicting?,provenance?}]}. Returns:
//   {state:'skipped', reason:'projector_is_writer', receipt:false}   the marker is not `open`: one marker read, nothing else;
//   {state:'absent', receipt:false}                                  the Film is not in the store: nothing is created;
//   {state:'noop', receipt:false}                                    the stored ids already equal the source in the owned schemes: no receipt, no batch;
//   {state:'applied'|'unknown'|..., requestId, ...}                  the receiptedWrite outcome (`already:true` when the same request was applied before).
export async function applyFilmExternalIds(env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 const digest=await filmExternalIdsDigest(input);
 const target={kind:'film',id:input.id};
 const requestId=await producerRequestId({origin,operation:FILM_EXTERNAL_IDS_OPERATION,event,target,digest});
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await planFilmExternalIds(env,input);
 if(plan.absent)return {state:'absent',receipt:false,requestId};
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const hooks=filmExternalIdsOperation({replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:FILM_EXTERNAL_IDS_OPERATION,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,
  readback:hooks.readback,
  revalidate:hooks.revalidate,
  run:ctx=>writeUnit(env,input,requestId,ctx,clock),
 });
 return {...outcome,requestId};
}
