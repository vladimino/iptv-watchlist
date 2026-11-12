// AIR-374 P3a, `person_mutation` unit (ADR 0129; S5-0 of ADR 0128, guardrail G9). The producer-side receipt adapter for the PERSON ROW: identity (role id, contract version), typed external ids and aliases. DORMANT: nothing in the Worker imports this
// module, it is not bundled (build.mjs is unchanged) and no route, job or cron calls it. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: `applyPersonMutation` reads the marker ONCE through
// `writerRoute` and, unless it is `open`, returns `skipped` before any other statement. `held` and an unreadable marker throw (a producer defers, it never falls back to R2).
// ONE source of truth for ownership: this module writes NOTHING itself. The only canonical write is the existing fenced writer `mutatePerson` (src/canonical-mutations.js) with the P3-0a `receiptMark` tail, so the mutation and its applied receipt are
// ONE fenced batch. There is no second write path and no SQL of this module that changes a canonical table.
// WHO MAY CREATE A PERSON. This unit, and only this unit: the Person row belongs to the Person writer (`mutatePerson`), `person_mutation` is its producer kind, so it is the one legitimate creator. `person_state` (src/canonical-person-adapters.js) and
// `film_credits` never create one (an absent Person is `absent` there, a missing credit Person is the recoverable refusal `film_person_reference`). Creation is explicit and in the SAME fenced batch as the receipt: a unit with `mode:'ensure'`
// (the default) creates the row when it is absent; a unit with `mode:'existing'` never does (absent is `absent`, no receipt). The writer proves in-batch what the planner read: an absent Person is still absent (`presence:'absent'`), an existing one is
// still there (`presence:'existing'`), so a Person that appears or vanishes between the pre-plan and the batch rolls the whole batch back (`film_person_precondition`, retried by the same request id) and is never silently overwritten or recreated.
// What the unit writes, and the protections (the planner passes ONLY what is still missing, so a stored value is never rewritten):
//   - the row: created with the unit's role id and contract version. An EXISTING row keeps its stored role id (a different one is refused `person_role_collision`, before any receipt) and its stored contract version (never overwritten);
//     like every mutatePerson call it sets `person.updated_at` and the revision to the write clock, and only on a real write: a no-op writes nothing and has no receipt (E5).
//   - external ids: upsert-only and insert-if-absent. A stored (scheme, value) is never touched (its trust, conflict flag and provenance are kept); nothing is removed or pruned (the exceptions registry's
//     `external_ids_not_pruned_by_the_planner` is only referenced, not edited). A trusted id whose scheme already holds a DIFFERENT trusted value for this Person, or whose trusted (scheme, value) another Person owns, is refused `identity_collision`; the write batch proves the latter again (`uniqueTrusted`).
//   - aliases: insert-if-absent (the writer's DO NOTHING); none is removed. A blank id, value, scheme or alias is refused `film_person_invalid`: a blank never overwrites and is never written.
// Per unit, as for `film_facts`: the stable request id comes from the SOURCE EVENT, the TARGET and the content digest; the pre-plan reads the stored rows and a NO-OP ends there with no receipt; one atomic receipted batch otherwise; an uncertain
// race (nothing left to write) ends `unknown`/`atomic_mark_missing`, never a second marking batch; a replay re-plans from the producer's own source and is refused when the digest moved. Reconciliation is the origin's own bounded inline pass (E2).
// Stored: operation kind, origin, target, digests, revisions, state; no payload, name or personal data.
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-producers.js';
import {RETRY_POLICY,defineOperation,digestOf,receiptedWrite} from './canonical-receipts.js';
import {mutatePerson} from './canonical-mutations.js';
import {SOURCE_CHANGED,producerRequestId} from './canonical-producer-adapters.js';
import {CONTENT_REFUSALS} from './canonical-person-adapters.js';

export const PERSON_MUTATION_OPERATION='person_mutation';
// mutatePerson is capped at 60 statements and one D1 statement binds at most 100 values: six are fixed (fence, revision, presence, trusted-owner assertion, row upsert, bump), the rest is one per external id and alias, and the trusted-owner assertion binds two values per trusted id.
export const PERSON_ITEMS_PER_UNIT_MAX=40;
export const PERSON_MODES=Object.freeze(['ensure','existing']);
// The typed refusals the planner throws about the CONTENT or the state of the target: the shared ones plus a role id that disagrees with the stored row and a trusted-id clash. Anything else (a read failure) propagates.
export const PERSON_MUTATION_REFUSALS=new Set([...CONTENT_REFUSALS,'person_role_collision','identity_collision']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const filled=value=>typeof value==='string'&&value.trim()!=='';
const byKey=(a,b)=>a<b?-1:a>b?1:0;

// ---- content (what the digest binds) ----
// {mode, roleId, contractVersion, externalIds:[{scheme,value,trusted,conflicting,provenance}] (a set, sorted), aliases:[{kind,value,provenance}] (a set, sorted)}. The write clock `at` is not content.
export function personMutationContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('person:')||input.id.length<=7||!plain(input.person))throw failed('film_person_invalid');
 const person=input.person,mode=input.mode===undefined?'ensure':input.mode;
 if(!PERSON_MODES.includes(mode)||!filled(person.roleId)||!Number.isInteger(person.contractVersion)||person.contractVersion<1)throw failed('film_person_invalid');
 if((person.externalIds!==undefined&&!Array.isArray(person.externalIds))||(person.aliases!==undefined&&!Array.isArray(person.aliases)))throw failed('film_person_invalid');
 const externalIds=[],aliases=[],seenIds=new Set(),seenAliases=new Set();
 for(const item of person.externalIds||[]){
  if(!plain(item)||!filled(item.scheme)||!(typeof item.value==='string'||typeof item.value==='number')||!filled(String(item.value)))throw failed('film_person_invalid');
  const key=JSON.stringify([item.scheme,String(item.value)]);
  if(seenIds.has(key))throw failed('film_person_invalid');
  seenIds.add(key);
  const conflicting=item.conflicting?true:false;
  externalIds.push({scheme:item.scheme,value:String(item.value),trusted:item.trusted&&!conflicting?true:false,conflicting,provenance:item.provenance??null});
 }
 for(const item of person.aliases||[]){
  if(!plain(item)||!filled(item.value)||(item.kind!==undefined&&!filled(item.kind)))throw failed('film_person_invalid');
  const kind=item.kind||'name',key=JSON.stringify([kind,item.value]);
  if(seenAliases.has(key))throw failed('film_person_invalid');
  seenAliases.add(key);
  aliases.push({kind,value:item.value,provenance:item.provenance??null});
 }
 if(externalIds.length+aliases.length>PERSON_ITEMS_PER_UNIT_MAX)throw failed('film_person_bounded');
 externalIds.sort((a,b)=>byKey(JSON.stringify([a.scheme,a.value]),JSON.stringify([b.scheme,b.value])));
 aliases.sort((a,b)=>byKey(JSON.stringify([a.kind,a.value]),JSON.stringify([b.kind,b.value])));
 return {mode,roleId:person.roleId,contractVersion:person.contractVersion,externalIds,aliases};
}
export async function personMutationDigest(input){
 return digestOf({operation:PERSON_MUTATION_OPERATION,id:input?.id,content:personMutationContent(input)});
}

// ---- read-only plan: {absent, noop, action, revision, ...} ----
const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='person' AND id=?",[id]))?.revision??0);
// A trusted, non-conflicting (scheme, value) owned by ANOTHER Person is refused `identity_collision` (schema v1 has no unique index for person_external_id; the same check runs in the write batch as `uniqueTrusted`).
async function assertNoOtherOwner(db,id,items){
 for(const item of items){
  if(item.trusted&&await one(db,'SELECT 1 AS x FROM person_external_id WHERE scheme=? AND value=? AND trusted=1 AND conflicting=0 AND person_id<>?',[item.scheme,item.value,id]))throw failed('identity_collision');
 }
}
// Throws before any receipt: person_role_collision (the role id belongs to another Person, or differs from the stored row), identity_collision (a trusted id against a different stored trusted value of its scheme).
// action: 'create' (absent, mode ensure), 'update' (the row exists and something is missing) or 'none'; `absent` is true only for an absent Person of a mode `existing` unit (nothing to create).
export async function planPersonMutation(env,input){
 const content=personMutationContent(input);
 const db=database(env);
 const revision=await revisionOf(db,input.id);
 const row=await one(db,'SELECT role_id,contract_version FROM person WHERE id=?',[input.id]);
 if(!row){
  if(content.mode==='existing')return {absent:true,noop:false,action:'none',revision,externalIds:[],aliases:[]};
  if(await one(db,'SELECT 1 AS x FROM person WHERE role_id=?',[content.roleId]))throw failed('person_role_collision');
  await assertNoOtherOwner(db,input.id,content.externalIds);
  return {absent:false,noop:false,action:'create',revision,roleId:content.roleId,contractVersion:content.contractVersion,externalIds:content.externalIds,aliases:content.aliases};
 }
 if(row.role_id!==content.roleId)throw failed('person_role_collision');
 const stored=await many(db,'SELECT scheme,value,trusted,conflicting FROM person_external_id WHERE person_id=?',[input.id]);
 const haveIds=new Set(stored.map(item=>JSON.stringify([item.scheme,item.value])));
 const externalIds=content.externalIds.filter(item=>!haveIds.has(JSON.stringify([item.scheme,item.value])));
 for(const item of externalIds)if(item.trusted&&stored.some(have=>have.scheme===item.scheme&&have.trusted===1&&have.conflicting===0&&have.value!==item.value))throw failed('identity_collision');
 await assertNoOtherOwner(db,input.id,externalIds);
 const haveAliases=new Set((await many(db,'SELECT kind,value FROM person_alias WHERE person_id=?',[input.id])).map(item=>JSON.stringify([item.kind,item.value])));
 const aliases=content.aliases.filter(item=>!haveAliases.has(JSON.stringify([item.kind,item.value])));
 const noop=externalIds.length===0&&aliases.length===0;
 return {absent:false,noop,action:noop?'none':'update',revision,roleId:row.role_id,contractVersion:row.contract_version,externalIds,aliases};
}

const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
// The fenced write: what is still missing NOW, from a fresh read, through `mutatePerson` with the receipt tail. Nothing to write means no batch, so no receipt mark (the receipt then ends `unknown`, E5). A Person that vanished from a mode
// `existing` unit is refused; what the fresh read saw (absent or existing) is proven again INSIDE the batch.
async function writeUnit(env,input,requestId,ctx,clock){
 const plan=await planPersonMutation(env,input);
 if(plan.absent)throw failed('film_person_reference');
 if(plan.noop)return {id:input.id,revision:plan.revision,already:true};
 return mutatePerson(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at,presence:plan.action==='create'?'absent':'existing',uniqueTrusted:true,
  person:{roleId:plan.roleId,contractVersion:plan.contractVersion,externalIds:plan.externalIds.map(({scheme,value,trusted,conflicting,provenance})=>({scheme,value,trusted,conflicting,provenance})),aliases:plan.aliases},receiptMark:mark(ctx,clock)});
}

// The registry spec for `reconcileReceipts`. replan(receipt) -> the unit input of the receipt's target, or null (a receipt of another run is never replayed: the caller's re-plan checks the run, see epgPersonReplan). A re-plan whose digest is not the
// receipt's is a SOURCE THAT MOVED ON (typed terminal abandon).
export function personMutationOperation({replan,now=()=>new Date().toISOString()}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch{input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await personMutationDigest(input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 // Only a genuine content or precondition refusal means 'no plan'; a read failure (film_person_unavailable, a D1 transport or SQL exception) PROPAGATES so the receipt stays due instead of being abandoned as stale.
 const planOf=async(env,input)=>{try{return await planPersonMutation(env,input);}catch(error){if(PERSON_MUTATION_REFUSALS.has(error?.code))return null;throw error;}};
 return defineOperation({
  operation:PERSON_MUTATION_OPERATION,
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
  // Called only when the revision moved since planning: proceed when the facts would still change something; superseded when they would not or a mode `existing` Person is absent; no re-plan or a refusal: repair.
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const plan=await planOf(env,found.input);
   if(!plan)return 'stale';
   return plan.absent||plan.noop?'superseded':'proceed';
  },
 });
}

// ONE unit, once per source event. opts: {origin, event, input, replan?, now?, policy?}; input: {id:'person:...', at, mode?, person:{roleId, contractVersion, externalIds?, aliases?}}. Returns:
//   {state:'skipped', reason:'projector_is_writer', receipt:false}   the marker is not `open`: one marker read, nothing else;
//   {state:'absent', receipt:false}                                  mode `existing` and the Person is not in the store: nothing is created;
//   {state:'noop', receipt:false}                                    the facts are already stored: no receipt, no batch;
//   {state:'applied'|'unknown'|..., requestId, ...}                  the receiptedWrite outcome (`already:true` when the same request was applied before).
export async function applyPersonMutation(env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 const digest=await personMutationDigest(input);
 const target={kind:'person',id:input.id};
 const requestId=await producerRequestId({origin,operation:PERSON_MUTATION_OPERATION,event,target,digest});
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await planPersonMutation(env,input);
 if(plan.absent)return {state:'absent',receipt:false,requestId};
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const hooks=personMutationOperation({replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:PERSON_MUTATION_OPERATION,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,
  readback:hooks.readback,
  revalidate:hooks.revalidate,
  run:ctx=>writeUnit(env,input,requestId,ctx,clock),
 });
 return {...outcome,requestId};
}
