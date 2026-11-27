// AIR-605 (card C1; ADR 0211 decision 3 as amended by ADR 0219 decisions 7 and 8). The receipted UNITS of the Catalog Enrichment Producer: every canonical write is one unit with a deterministic key
// (`enrich:<film>:core`, `enrich:<film>:localization:<source>`, `enrich:<film>:credits:<source>:<slot>`, `enrich:person:<person id>`), written through the EXISTING fenced writers and the reconcile-then-reserve protocol
// of ADR 0207 decision 3 (src/receipt-operation-key.js). DORMANT: nothing in the Worker imports this module. It writes nothing itself: the canonical write is `writeFilmFacts`, the film_credits unit or `mutatePerson`.
//   - A replan keeps the key and changes the digest, so the protocol abandons any unresolved receipt of the old plan before it reserves a new one.
//   - Every unit carries the guards of its plan (anchor set, epochs, lease, control generation) INSIDE its own batch; a stale plan therefore writes nothing.
//   - ADR 0219 decision 7: a key that reaches the receipt history cap advances a durable, shared LOGICAL-UNIT generation (`catalog_enrichment_unit_generation`) by a compare-and-swap on the generation and the history
//     fingerprint, and continues under `<key>:g<k+1>`. Old receipts are retained and the protocol is otherwise unchanged. Catalog Enrichment Producer keys only.
import {database,failed,one} from './film-person-authority.js';
import {writerRoute} from './canonical-writer-route.js';
import {runOperationKey,readOperationHistory,fingerprintOf} from './receipt-operation-key.js';
import {writeFilmFacts} from './canonical-film-writers.js';
import {filmFactsDigest,filmFactsOperation,prePlanFilmFacts} from './canonical-producer-adapters.js';
import {FILM_CREDITS_OPERATION,planUnit,unitDigest,unitOperation} from './canonical-person-adapters.js';
import {PERSON_MUTATION_OPERATION,personMutationDigest,personMutationOperation,planPersonMutation} from './canonical-person-mutation-producer.js';

export const ORIGIN='catalog_enrichment';
export const KINDS=Object.freeze(['facts','credits','person']);
const FILM_FACTS='film_facts';

// The unit key of each part (ADR 0211 decision 3, ADR 0219 decision 8). A film id keeps its own colons.
export const unitKeys=Object.freeze({
 core:filmId=>'enrich:'+filmId+':core',
 localization:(filmId,source)=>'enrich:'+filmId+':localization:'+source,
 credits:(filmId,source,slot)=>'enrich:'+filmId+':credits:'+source+':'+slot,
 person:personId=>'enrich:person:'+personId,
});
const generationKey=(key,generation)=>generation>0?key+':g'+generation:key;

// The durable generation of one logical unit; an absent row (or table) is generation 0.
export async function readGeneration(env,unitKey){
 try{
  const row=await one(database(env),'SELECT generation,history_fingerprint FROM catalog_enrichment_unit_generation WHERE unit_key=?',[unitKey]);
  return row?{generation:Number(row.generation),fingerprint:row.history_fingerprint}:{generation:0,fingerprint:null};
 }catch(error){
  if(/no such table/i.test(String(error?.cause?.message||error?.message||error)))return {generation:0,fingerprint:null,tables:false};
  throw failed('film_person_unavailable',error);
 }
}
// Advances the generation by ONE atomic statement that matches the stored generation AND the stored fingerprint it read, and records the fingerprint of the history it retires. `RETURNING` says whether THIS call
// moved the row, so a concurrent writer cannot roll the unit twice or skip an unresolved receipt, and the loser learns it lost. -> the new generation, or null when another writer moved it first.
export async function rollGeneration(env,{unitKey,generation,fingerprint,at}){
 const db=database(env);
 const stored=await readGeneration(env,unitKey);
 if(stored.generation!==generation)return null;
 if(generation===0)await db.prepare("INSERT INTO catalog_enrichment_unit_generation (unit_key,generation,history_fingerprint,updated_at) VALUES (?,0,NULL,?) ON CONFLICT(unit_key) DO NOTHING").bind(unitKey,at).run();
 const row=await db.prepare("UPDATE catalog_enrichment_unit_generation SET generation=generation+1,history_fingerprint=?,updated_at=? WHERE unit_key=? AND generation=? AND history_fingerprint IS ? RETURNING generation").bind(fingerprint,at,unitKey,generation,stored.fingerprint).first();
 return row?Number(row.generation):null;
}
export const fingerprintText=fingerprint=>fingerprint.count+':'+fingerprint.applied;

// The per-kind pieces: the operation name, the digest, the target, the read-only pre-plan ({absent, noop, revision}) and the spec whose readback and revalidate the receipts module calls.
function kindOf(env,kind,input,{now}){
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const replan=async()=>input;
 if(kind==='facts')return {
  operation:FILM_FACTS,target:{kind:'film',id:input.id},digest:()=>filmFactsDigest(input),
  plan:async requestId=>{const plan=await prePlanFilmFacts(env,{input,requestId:requestId||'preplan'});return {absent:false,noop:plan.noop,revision:plan.expectedRevision,counts:plan.counts};},
  spec:filmFactsOperation({replan,now:clock}),
  run:(env,ctx,requestId)=>writeFilmFacts(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}}),
 };
 if(kind==='credits')return {
  operation:FILM_CREDITS_OPERATION,target:{kind:'film',id:input.id},digest:()=>unitDigest(FILM_CREDITS_OPERATION,input),
  plan:async()=>planUnit(FILM_CREDITS_OPERATION,env,input),
  spec:unitOperation(FILM_CREDITS_OPERATION,{replan,now:clock}),
  run:(env,ctx,requestId,digest)=>unitOperation(FILM_CREDITS_OPERATION,{replan,now:clock}).replay(env,{requestId,contentDigest:digest,target:ctx.target},ctx),
 };
 if(kind==='person')return {
  operation:PERSON_MUTATION_OPERATION,target:{kind:'person',id:input.id},digest:()=>personMutationDigest(input),
  plan:async()=>planPersonMutation(env,input),
  spec:personMutationOperation({replan,now:clock}),
  run:(env,ctx,requestId,digest)=>personMutationOperation({replan,now:clock}).replay(env,{requestId,contentDigest:digest,target:ctx.target},ctx),
 };
 throw failed('film_person_invalid');
}

// ONE unit. spec: {kind: 'facts'|'credits'|'person', unitKey, input (the writer input of that kind, with `guards` where the writer takes them), now?, policy?}. -> one of
//   {state:'skipped', reason}   the Film/Person marker is not open (one marker read, nothing else);
//   {state:'absent'}            the target is not in the store (a unit never creates a Film);
//   {state:'noop'}              the planned facts are already stored: no receipt, no batch;
//   {state:'settled'}           an applied receipt of the same digest whose effect is in place;
//   {state:'applied'|'unknown'|..., requestId}  the keyed reservation and write;
//   {state:'wait', reason}      another attempt is live or the history is contended: nothing to do now;
//   {state:'exhausted'}         only when the generation could not roll (an unresolved receipt, or lost the race).
export async function runUnit(env,{kind,unitKey,input,now,policy}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'film_person_route_not_open'};
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const pieces=kindOf(env,kind,input,{now:clock});
 const digest=await pieces.digest();
 for(let round=0;round<2;round++){
  const stored=await readGeneration(env,unitKey);
  const key=generationKey(unitKey,stored.generation);
  let outcome;
  outcome=await runOperationKey(env,{origin:ORIGIN,operationKey:key,now:clock,...(policy?{policy}:{})},{
   // An applied receipt is never trusted on its own: it settles this work only with the same digest AND its effect still in place; another digest is history (a replan or an identity correction).
   validate:async receipt=>receipt.contentDigest===digest&&(await pieces.plan(receipt.requestId)).noop?'settled':'historical',
   decide:async()=>{
    const plan=await pieces.plan(null);
    if(plan.absent)return {kind:'none',result:{state:'absent'}};
    if(plan.noop)return {kind:'none',result:{state:'noop',...(plan.counts?{provenance:plan.counts}:{})}};
    return {kind:'reserve',request:{operation:pieces.operation,target:pieces.target,expectedRevision:plan.revision,digest,source:digest},
     write:{atomic:true,readback:pieces.spec.readback,revalidate:pieces.spec.revalidate,run:ctx=>pieces.run(env,ctx,ctx.requestId,digest)}};
   },
  });
  if(outcome.status==='exhausted'){
   // The receipt history cap is a safety limit, not a lifetime stop (ADR 0219 decision 7): roll the logical unit's generation, then continue once under the new key. The protocol already settled every unresolved receipt
   // (`exhausted` is only reported from a clear history), and the roll matches the fingerprint of the history it read.
   const history=await readOperationHistory(env,{origin:ORIGIN,operationKey:key});
   if(history.receipts.some(receipt=>['pending','failed','unknown'].includes(receipt.state)))return {state:'exhausted',reason:'unresolved_receipt'};
   const next=await rollGeneration(env,{unitKey,generation:stored.generation,fingerprint:fingerprintText(fingerprintOf(history.receipts)),at:clock()});
   if(next===null&&(await readGeneration(env,unitKey)).generation===stored.generation)return {state:'exhausted',reason:'generation_lost'};
   continue;
  }
  if(outcome.status==='wait')return {state:'wait',reason:outcome.reason,requestId:outcome.requestId};
  if(outcome.status==='settled')return {state:'settled',requestId:outcome.receipt?.requestId};
  if(outcome.status==='none')return outcome.result;
  if(outcome.status==='reserved')return {...outcome.outcome,state:outcome.outcome?.state||'applied',requestId:outcome.requestId,key};
  return {state:outcome.status};
 }
 return {state:'exhausted',reason:'generation_lost'};
}
