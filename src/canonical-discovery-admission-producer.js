// AIR-374 P3c, the `film_mutation` unit of the DISCOVERY ADMISSION producer (ADR 0126 decision 2: the kind `film_mutation` belongs to the Discovery admission; ADR 0119 receipts). A verified movie id (a `tmdb_<n>` key) of a Discovery catalog
// admission becomes a canonical Film that carries the trusted `tmdb` external id (and the title when the Film has none), or lands on the Film that already holds that id. The unit never merges, never removes and never rewrites what is stored.
// ONE write path: the existing fenced writer `mutateFilm` (src/canonical-mutations.js) with `receiptMark`, so the mutation and its applied receipt are ONE fenced batch (atomic). Nothing in this module changes a canonical table by SQL.
// Route gate: the marker is read ONCE through the receipts-free route of the adapters. Unless it is `open` (writer `canonical`) the unit returns `skipped` before any other statement (the projector stays the only canonical writer at `legacy`,
// `r2` and `prepared`); `held` and an unreadable marker throw, a producer defers and never falls back to R2.
// Identity safety (typed refusals BEFORE any receipt, never a silent remap):
//   - the Film is found by the trusted, non-conflicting `tmdb` id (the unique partial index `film_external_id_one_trusted` allows one owner), else it is `film:tmdb:<n>`;
//   - the same `tmdb` value held UNTRUSTED or CONFLICTING by another Film, or trusted by more than one Film, is `identity_collision` (the admission is held for the owner, not merged);
//   - a redirect source is `film_person_redirect`; a Film whose stored trusted `tmdb` is a DIFFERENT value is `identity_collision` (two verified identities are never one Film).
// Stored title and contract version are never overwritten: the title is written only when the stored one is absent or blank. A no-op (the Film already holds the id and a title) writes nothing and has NO receipt (E5).
// Idempotency and replay: the stable request id comes from the source event (the admission generation or run id), the kind, the target and the content digest; the registry spec re-plans from the producer's own source and a digest that moved on
// is a typed terminal abandon (`producer_source_changed`). Stored in the receipt: operation kind, origin, target, digests, revisions, state; no payload, title or personal data.
import {RETRY_POLICY,defineOperation,digestOf,receiptedWrite} from './canonical-receipts.js';
import {mutateFilm} from './canonical-mutations.js';
import {SOURCE_CHANGED,producerRequestId} from './canonical-producer-adapters.js';
import {CONTENT_REFUSALS} from './canonical-person-adapters.js';
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-producers.js';

export const DISCOVERY_ADMISSION_OPERATION='film_mutation';
export const DISCOVERY_ORIGIN='discovery';
export const DISCOVERY_ADMISSION_REFUSALS=new Set([...CONTENT_REFUSALS,'identity_collision']);
const TMDB=/^[1-9]\d{0,11}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

// content: {tmdbId, title|null}. The write clock `at` is not content. The title is trimmed; blank is none.
export function discoveryAdmissionContent(input){
 if(!plain(input)||!TMDB.test(String(input.tmdbId??'')))throw failed('film_person_invalid');
 const title=typeof input.title==='string'&&input.title.trim()?input.title.trim():null;
 return {tmdbId:String(input.tmdbId),title};
}
export async function discoveryAdmissionDigest(input){
 return digestOf({operation:DISCOVERY_ADMISSION_OPERATION,target:'film:tmdb:'+discoveryAdmissionContent(input).tmdbId,content:discoveryAdmissionContent(input)});
}

const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);
// Read-only plan: {id, exists, noop, action:'create'|'update'|'none', revision, contractVersion, add, title}. Throws before any receipt: identity_collision, film_person_redirect.
export async function planDiscoveryAdmission(env,input){
 const {tmdbId,title}=discoveryAdmissionContent(input);
 const db=database(env);
 const holders=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[tmdbId]);
 const trusted=holders.filter(row=>row.trusted===1&&row.conflicting===0);
 if(trusted.length>1||holders.some(row=>!(row.trusted===1&&row.conflicting===0)&&!trusted.some(other=>other.film_id===row.film_id)))throw failed('identity_collision');
 const id=trusted[0]?.film_id||'film:tmdb:'+tmdbId;
 if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');
 const revision=await revisionOf(db,id);
 const row=await one(db,'SELECT contract_version,original_title FROM film WHERE id=?',[id]);
 if(row){
  // A Film that holds a DIFFERENT trusted tmdb value is another identity.
  if(await one(db,"SELECT 1 AS x FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value<>? AND trusted=1 AND conflicting=0",[id,tmdbId]))throw failed('identity_collision');
 }
 const hasId=trusted.length===1;
 const needsTitle=!!title&&!(typeof row?.original_title==='string'&&row.original_title.trim());
 const noop=!!row&&hasId&&!needsTitle;
 return {id,exists:!!row,noop,action:noop?'none':row?'update':'create',revision,contractVersion:row?row.contract_version:1,add:hasId?[]:[{scheme:'tmdb',value:tmdbId,trusted:true,conflicting:false,provenance:{source:'discovery',verified:true}}],title:needsTitle||!row?title:null};
}

const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
// The fenced write: what is still missing NOW, from a fresh read. Nothing to write means no batch, so no receipt mark (the receipt then ends `unknown`, E5).
async function writeUnit(env,input,requestId,ctx,clock){
 const plan=await planDiscoveryAdmission(env,input);
 if(plan.noop)return {id:plan.id,revision:plan.revision,already:true};
 return mutateFilm(env,{id:plan.id,expectedRevision:ctx.currentRevision,at:input.at,
  film:{contractVersion:plan.contractVersion,...(plan.title?{originalTitle:plan.title}:{}),externalIds:plan.add},receiptMark:mark(ctx,clock)});
}

// The registry spec for `reconcileReceipts`. replan(receipt) -> the unit input ({tmdbId,title,at}) of the receipt's target, or null (the caller's re-plan reads the producer's own source: the current `discovery_admission` row).
export function discoveryAdmissionOperation({replan,now=()=>new Date().toISOString()}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch{input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await discoveryAdmissionDigest(input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 const planOf=async(env,input)=>{try{return await planDiscoveryAdmission(env,input);}catch(error){if(DISCOVERY_ADMISSION_REFUSALS.has(error?.code))return null;throw error;}};
 return defineOperation({
  operation:DISCOVERY_ADMISSION_OPERATION,
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
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const plan=await planOf(env,found.input);
   if(!plan)return 'stale';
   return plan.noop?'superseded':'proceed';
  },
 });
}

// ONE admitted Film per source event. opts: {event, input:{tmdbId, title?, at}, replan?, now?, policy?}. Returns:
//   {state:'skipped', reason:'projector_is_writer', receipt:false}   the marker is not `open`: one marker read, nothing else;
//   {state:'noop', receipt:false}                                    the Film already holds the id (and a title): no receipt, no batch;
//   {state:'applied'|'unknown'|..., requestId, ...}                  the receiptedWrite outcome.
export async function applyDiscoveryAdmission(env,{event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 const digest=await discoveryAdmissionDigest(input);
 const plan=await planDiscoveryAdmission(env,input);
 const target={kind:'film',id:plan.id};
 const requestId=await producerRequestId({origin:DISCOVERY_ORIGIN,operation:DISCOVERY_ADMISSION_OPERATION,event,target,digest});
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const hooks=discoveryAdmissionOperation({replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:DISCOVERY_ADMISSION_OPERATION,origin:DISCOVERY_ORIGIN,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,
  readback:hooks.readback,
  revalidate:hooks.revalidate,
  run:ctx=>writeUnit(env,input,requestId,ctx,clock),
 });
 return {...outcome,requestId};
}
