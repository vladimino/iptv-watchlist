// AIR-374 P3c, the `film_mutation` unit of the DISCOVERY ADMISSION producer (ADR 0126 decision 2: the kind `film_mutation` belongs to the Discovery admission; ADR 0119 receipts). A verified movie id (a `tmdb_<n>` key) of a Discovery catalog
// admission becomes a canonical Film that carries the trusted `tmdb` external id (and the title when the Film has none), or lands on the Film that already holds that id. The unit never merges, never removes and never rewrites what is stored.
// ONE write path: the existing fenced writer `mutateFilm` (src/canonical-mutations.js) with `receiptMark`, so the mutation and its applied receipt are ONE fenced batch (atomic). Nothing in this module changes a canonical table by SQL.
// Route gate: the marker is read ONCE through `writerRoute` (src/canonical-writer-route.js). Unless it is `open` (writer `canonical`) the unit returns `skipped` before any other statement (the projector stays the only canonical writer at `legacy`,
// `r2` and `prepared`); `held` and an unreadable marker throw, a producer defers and never falls back to R2.
// Identity safety (typed refusals BEFORE any receipt, never a silent remap):
//   - the Film is found by the trusted, non-conflicting `tmdb` id (the unique partial index `film_external_id_one_trusted` allows one owner), else it is `film:tmdb:<n>`;
//   - the same `tmdb` value held UNTRUSTED or CONFLICTING by another Film, or trusted by more than one Film, is `identity_collision` (the admission is held for the owner, not merged);
//   - a redirect source is `film_person_redirect`; a Film whose stored trusted `tmdb` is a DIFFERENT value is `identity_collision` (two verified identities are never one Film).
// Stored title and contract version are never overwritten: the title is written only when the stored one is absent or blank. A no-op (the Film already holds the id and a title) writes nothing and has NO receipt (E5).
// Idempotency and replay: the stable request id comes from the source event (the admission generation or run id), the kind, the target and the content digest; the registry spec re-plans from the producer's own source and a digest that moved on
// is a typed terminal abandon (`producer_source_changed`). Stored in the receipt: operation kind, origin, target, digests, revisions, state; no payload, title or personal data.
import {RETRY_POLICY,defineOperation,digestOf,operationRegistry,receiptedWrite} from './canonical-receipts.js';
import {reconcileOwnOrigin} from './canonical-producer-adapters.js';
import {mutateFilm} from './canonical-mutations.js';
import {SOURCE_CHANGED,producerRequestId} from './canonical-producer-adapters.js';
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-writer-route.js';

export const DISCOVERY_ADMISSION_OPERATION='film_mutation';
export const DISCOVERY_ORIGIN='discovery';
export const DISCOVERY_ADMISSION_REFUSALS=new Set(['film_person_invalid','film_person_redirect','film_person_reference','film_person_bounded','identity_collision']);
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
export async function planAdmissionFilm(env,input){
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
 const plan=await planAdmissionFilm(env,input);
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
 const planOf=async(env,input)=>{try{return await planAdmissionFilm(env,input);}catch(error){if(DISCOVERY_ADMISSION_REFUSALS.has(error?.code))return null;throw error;}};
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
export async function applyDiscoveryAdmission(env,options={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 return applyRouted(env,options);
}
async function applyRouted(env,{event,input,replan,now,policy=RETRY_POLICY}={}){
 const digest=await discoveryAdmissionDigest(input);
 const plan=await planAdmissionFilm(env,input);
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

// ---- the call site (the Discovery admission commit): bounded, never throws, never delays discovery beyond its own deadline ----
export const ADMIT_PER_CALL=10;
export const SWEEP_PER_CALL=5;
const ADMISSION_EVENT='discovery:admission';
const SWEEP_EVENT='discovery:sweep';
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const titleOf=payload=>{try{const value=JSON.parse(payload)?.title;return typeof value==='string'?value:null;}catch{return null;}};
// The unit input of a Discovery film key and entry: a verified movie only. An admission entry is verified when its canonicalIdentity is `tmdb:<tmdbId>` (the writer validates it); a `tmdb_tv*` key, a TV entry, a key whose id is not the entry's tmdbId or
// an entry without that identity is never admitted.
export function admissionInput(key,entry,at){
 const match=/^tmdb_([1-9]\d{0,11})$/.exec(String(key??''));
 if(!match||!plain(entry)||String(entry.tmdbId??'')!==match[1]||entry.canonicalIdentity!=='tmdb:'+match[1]||entry.mediaType==='tv'||entry.kind==='tv')return null;
 return {tmdbId:match[1],title:typeof entry.title==='string'?entry.title:null,at};
}
// The environment-bound registry for the origin's own reconcile: the receipt stores no payload, so the re-plan reads the producer's own source, the CURRENT admission row of the Film's tmdb id.
export function discoveryAdmissionRegistry(env,now){
 const replan=async receipt=>{
  const db=database(env);
  let tmdbId=/^film:tmdb:([1-9]\d{0,11})$/.exec(receipt.target.id)?.[1]||null;
  if(!tmdbId)tmdbId=(await one(db,"SELECT value FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND trusted=1 AND conflicting=0",[receipt.target.id]))?.value||null;
  if(!tmdbId)return null;
  const row=await one(db,"SELECT payload_json FROM discovery_admission WHERE media_kind='movie' AND tmdb_id=? AND state='current'",[String(tmdbId)]);
  if(!row)return null;
  return {tmdbId:String(tmdbId),title:titleOf(row.payload_json),at:clockOf(now)()};
 };
 return operationRegistry([discoveryAdmissionOperation({replan,now:clockOf(now)})]);
}
// After one committed admission batch: `films` is the {key: entry} map handed to the writer and `written` its written keys. ONE marker read; below `open` it returns `skipped` and nothing else (the projector stays the only writer).
// At `open` it admits at most ADMIT_PER_CALL of the written films (the rest, and any admission missed because the deadline passed or a write failed, is picked up by the sweep below on this or a later call), settles the origin's own
// due receipts (bounded) and sweeps at most SWEEP_PER_CALL current movie admissions that have no trusted canonical Film. It NEVER throws: discovery keeps its own outcome; a typed refusal is counted, a failed unit keeps its pending
// receipt for the reconcile. `deadline` (epoch ms) stops the work between units.
// A `projector` route (the marker below `open`) is remembered for ROUTE_SKIP_MS per database binding, so the long `prepared` wait costs no marker read per admission batch. Only the SKIP is cached, and it can only delay canonical admission:
// every canonical write re-reads and fences the marker inside its own batch (`mutateFilm` asserts the generation), and the sweep admits what was missed once the marker is `open`. `routeSkipMs: 0` reads every time.
export const ROUTE_SKIP_MS=60000;
const skipUntil=new WeakMap();
export async function admitDiscoveryFilms(env,{films={},written=[],deadline=null,now,sweepLimit=SWEEP_PER_CALL,admitLimit=ADMIT_PER_CALL,routeSkipMs=ROUTE_SKIP_MS}={}){
 const out={state:'done',applied:0,noop:0,refused:0,failed:0,deferred:0,swept:0,reconciled:0};
 const binding=env?.DB&&typeof env.DB==='object'?env.DB:null;
 if(binding&&routeSkipMs>0&&(skipUntil.get(binding)||0)>Date.now())return {state:'skipped',reason:'projector_is_writer',cached:true};
 let route;
 try{route=await writerRoute(env);}
 catch(error){return {state:'unavailable',code:String(error?.code||'error')};}
 if(route.writer!=='canonical'){
  if(binding&&routeSkipMs>0)skipUntil.set(binding,Date.now()+routeSkipMs);
  return {state:'skipped',reason:'projector_is_writer'};
 }
 if(binding)skipUntil.delete(binding);
 const clock=clockOf(now);
 const late=()=>Number.isFinite(deadline)&&Date.now()>=deadline;
 const unit=async(input,event)=>{
  try{
   const result=await applyRouted(env,{event,input,now:clock});
   if(result.state==='noop')out.noop++;else out.applied++;
  }catch(error){
   if(DISCOVERY_ADMISSION_REFUSALS.has(error?.code))out.refused++;else out.failed++;
  }
 };
 const keys=[...new Set(written)];
 for(const key of keys){
  if(late()||out.applied+out.noop+out.refused+out.failed>=admitLimit){out.deferred++;continue;}
  const input=admissionInput(key,films[key],clock());
  if(input)await unit(input,ADMISSION_EVENT);
 }
 try{
  if(!late()){const settled=await reconcileOwnOrigin(env,{origin:DISCOVERY_ORIGIN,operations:discoveryAdmissionRegistry(env,now),now:clock});out.reconciled=Number(settled?.considered??settled?.results?.length??0);}
 }catch{out.failed++;}
 try{
  if(!late()&&sweepLimit>0){
   const rows=await many(database(env),"SELECT a.tmdb_id AS tmdb_id,a.payload_json AS payload_json FROM discovery_admission a WHERE a.state='current' AND a.media_kind='movie' AND NOT EXISTS (SELECT 1 FROM film_external_id e WHERE e.scheme='tmdb' AND e.value=a.tmdb_id AND e.trusted=1 AND e.conflicting=0) ORDER BY random() LIMIT ?",[sweepLimit]);
   for(const row of rows){
    if(late())break;
    out.swept++;
    let entry=null;
    try{entry=JSON.parse(row.payload_json);}catch{entry=null;}
    const input=admissionInput('tmdb_'+row.tmdb_id,entry,clock());
    if(input)await unit(input,SWEEP_EVENT);
   }
  }
 }catch{out.failed++;}
 return out;
}
