// AIR-374 P3-0b (ADR 0123; ADR 0119 decision 4; ADR 0117 owner decisions 5, E2 and E5 of 12 Nov 2026). The PRODUCER-SIDE receipt ADAPTER on top of the P3-0a `receiptMark`. DORMANT: nothing in the Worker imports this module,
// it is not bundled (build.mjs is unchanged), and no route, job or cron calls it. The projector stays the only canonical writer while the marker is `legacy`, `r2` or `prepared`: every entry point below reads the marker
// ONCE through `writerRoute` and, unless the route is `canonical` (marker `open`), returns `skipped` before any other statement. `held` and an unreadable marker throw and name no writer (a producer defers, it never falls back to R2).
//
// What a producer (P3a to P3d) gets from here, for the operation kind `film_facts` (one `writeFilmFacts` call: metadata, dimensions, sync clocks, membership, identity, effective localization of ONE Film):
//   - `filmFactsDigest(input)`        the digest of the PLANNED CONTENT (the facts, never a clock: `at` and `updatedAt` are dropped at every depth).
//   - `producerRequestId(...)`        the stable request id. It is derived from the SOURCE EVENT (a run id, an observation time), the TARGET and the content digest, never from the content alone: a content-only id would give an A to B to A
//                                     flip the first request id again, read `already applied`, and silently keep B. The same event and content always give the same id (a retry is the same request); a new event or a changed
//                                     content gives another one.
//   - `prePlanFilmFacts(env,...)`     the pure planner of the writer over the stored rows. A NO-OP plan is detected BEFORE any receipt exists (E5): no receipt, no batch, nothing to be atomic with.
//   - `applyFilmFacts(env,...)`       route gate, pre-plan (a no-op ends here), then `receiptedWrite` in ATOMIC mode: the canonical mutation and the applied receipt are ONE fenced batch. The residual race (identical content landed
//                                     between the pre-plan and the writer's own read) leaves the receipt `unknown` (`atomic_mark_missing`), visible in `listAttention`, settled by readback and `reconcileReceipts`; this module never opens a
//                                     second marking batch.
//   - `filmFactsOperation(...)`       the registry spec (readback, replay, revalidate, `atomic:true`) for `reconcileReceipts`. A receipt stores no payload, so a replay needs the producer to RE-PLAN the facts from its own source:
//                                     `replan(receipt)` returns the writer input or null; an input whose digest is not the receipt's is never replayed (the source moved on: the next natural run creates a new request).
//   - `reconcileOwnOrigin(env,...)`   E2: bounded INLINE reconciliation by the producer's own origin, called by the producer after its own natural run. At most INLINE_RECONCILE_LIMIT receipts per call, only the origin's own, no timer.
//                                     There is NO cron, no tick call and no global reconcile here.
// Retries are bounded by the receipts module (5 attempts, backoff 60 s to 2 h, abandoned after 7 days) and always reuse the SAME request id. A stale revision is re-validated against the current rows, never replayed blind.
// Stored: operation kind, origin, target, digests, revisions, state; no payload, title or personal data. The producer's `event` enters the request id only as a digest.
import {failed} from './film-person-authority.js';
import {writerRoute} from './canonical-producers.js';
import {RECONCILE_LIMIT_MAX,RETRY_POLICY,defineOperation,digestOf,receiptedWrite,reconcileReceipts,requestIdOf} from './canonical-receipts.js';
import {planFilmFacts,readFilmSnapshot,writeFilmFacts} from './canonical-film-writers.js';

export const FILM_FACTS_OPERATION='film_facts';
// One inline reconcile pass looks at no more receipts than this (the receipts module's own hard cap is RECONCILE_LIMIT_MAX).
export const INLINE_RECONCILE_LIMIT=10;
const IDENT=/^[a-z][a-z0-9_]{0,63}$/;
const DIGEST=/^[0-9a-f]{64}$/;
// The facts of one Film that make up its content. The id (the target), the request id, the revision and the clocks are not content.
const CONTENT_KEYS=Object.freeze(['film','evidence','dimensions','localization','metadata','sync','watchlist']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

// Drops the write-time clocks (`at`, `updatedAt`) at every depth, so the same facts observed twice digest the same. Observation times that are part of the source (`observedAt`, `metadataAt`, ...) stay: they are content.
function withoutClocks(value){
 if(Array.isArray(value))return value.map(withoutClocks);
 if(!plain(value))return value;
 const out={};
 for(const key of Object.keys(value))if(key!=='at'&&key!=='updatedAt'&&value[key]!==undefined)out[key]=withoutClocks(value[key]);
 return out;
}
export function filmFactsContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('film:'))throw failed('film_person_invalid');
 const content={};
 for(const key of CONTENT_KEYS)if(input[key]!==undefined)content[key]=withoutClocks(input[key]);
 return content;
}
export async function filmFactsDigest(input){
 return digestOf({operation:FILM_FACTS_OPERATION,id:input?.id,content:filmFactsContent(input)});
}

// The stable request id of one source event for one target with one content. `event` is whatever the producer's own domain calls the event (a run id, an observation time): it is REQUIRED, because the content alone
// must never identify a request. Only a digest of the triple enters the stored id.
export async function producerRequestId({origin,operation=FILM_FACTS_OPERATION,event,target,digest}){
 if(typeof event!=='string'||!event.trim()||event.length>300||!plain(target)||(target.kind!=='film'&&target.kind!=='person')||typeof target.id!=='string'||!target.id.startsWith(target.kind+':')||!DIGEST.test(digest||''))throw failed('film_person_invalid');
 return requestIdOf({origin,operation,source:{event,target:{kind:target.kind,id:target.id},digest}});
}

// Read-only. The writer's own pure planner over the stored rows of the Film; `noop` means the writer would open no batch. It throws what the planner throws (an invalid input, a redirect, an identity conflict): a refusal that
// exists before a receipt does, so no receipt is created for it. `requestId` is the id the writer will use.
export async function prePlanFilmFacts(env,{input,requestId}){
 const snapshot=await readFilmSnapshot(env,input?.id);
 const plan=planFilmFacts(snapshot,{...input,requestId});
 return {noop:plan.noop,expectedRevision:snapshot.revision,changes:plan.changes,skipped:plan.skipped,redirect:snapshot.redirect};
}

// The digest binds the target id (and the content), so equality with the receipt's digest is the whole check.
const matches=(input,receipt,digest)=>plain(input)&&digest===receipt.contentDigest;

// The registry spec of `film_facts`. replan(receipt) -> the writer input of the receipt's target (without requestId, expectedRevision and receiptMark), or null when the producer cannot re-plan it now.
export function filmFactsOperation({replan,now=()=>new Date().toISOString()}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  const input=await replan(receipt);
  if(!input)return null;
  return {input,ok:matches(input,receipt,await filmFactsDigest(input))};
 };
 return defineOperation({
  operation:FILM_FACTS_OPERATION,
  atomic:true,
  // Does the Film already hold every row of the planned facts? Content alone is never proof (the receipts module turns it into `needs_review`); an absent effect means the same request id may be retried.
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)throw failed('producer_replan_unavailable');
   const snapshot=await readFilmSnapshot(env,target.id);
   const present=!snapshot.redirect&&planFilmFacts(snapshot,{...found.input,requestId:receipt.requestId}).noop;
   return {digest:present?receipt.contentDigest:null,revision:snapshot.revision};
  },
  // The same request id, re-planned against the CURRENT revision the receipts module hands over, inside the same atomic batch. A source that moved on is never replayed: permanent refusal, the receipt is abandoned and the
  // next natural run makes a new request. No re-plan available: an unknown outcome that backs off (bounded by the attempts).
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return writeFilmFacts(env,{...found.input,requestId:receipt.requestId,expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:now(),target:ctx.target}});
  },
  // Called only when the revision moved since planning: proceed when the facts would still change something, superseded when they would not (or the Film was redirected); no re-plan: repair.
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const snapshot=await readFilmSnapshot(env,receipt.target.id);
   if(snapshot.redirect)return 'superseded';
   return planFilmFacts(snapshot,{...found.input,requestId:receipt.requestId}).noop?'superseded':'proceed';
  },
 });
}

// ONE Film's facts, once per source event. input: the writer input of `writeFilmFacts` without requestId, expectedRevision and receiptMark (id, at, film, dimensions, localization, metadata, sync, watchlist, ...).
// opts: {origin, event, input, replan?, now?, policy?}. Returns:
//   {state:'skipped', reason:'projector_is_writer', receipt:false}  the marker is not `open`: one marker read, nothing else;
//   {state:'noop', receipt:false}                                    the facts are already stored: no receipt, no batch;
//   {state:'applied'|'unknown'|..., requestId, ...}                  the receiptedWrite outcome (`already:true` when the same request was applied before).
// A refusal of the writer is thrown after the receipt is marked (`film_person_fence` and `film_person_revision_conflict` leave it `failed`, retried by the SAME request id on a later call or inline reconcile).
export async function applyFilmFacts(env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};
 const digest=await filmFactsDigest(input);
 const target={kind:'film',id:input.id};
 const requestId=await producerRequestId({origin,event,target,digest});
 const clock=typeof now==='function'?now:()=>now||new Date().toISOString();
 const plan=await prePlanFilmFacts(env,{input,requestId});
 if(plan.noop)return {state:'noop',receipt:false,requestId,skipped:plan.skipped};
 const spec=filmFactsOperation({replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:FILM_FACTS_OPERATION,origin,target,expectedRevision:plan.expectedRevision,digest,now:clock,policy},{
  atomic:true,
  readback:spec.readback,
  revalidate:spec.revalidate,
  run:ctx=>writeFilmFacts(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}}),
 });
 return {...outcome,requestId};
}

// E2: BOUNDED INLINE reconciliation of the producer's OWN receipts, called by the producer after its natural run (P3e). Dormant unless the marker is `open`. `origin` is required and every pass is limited to it and to at most
// INLINE_RECONCILE_LIMIT (never more than RECONCILE_LIMIT_MAX) due receipts. No timer, no cron, no hourly tick, no other origin's rows.
export async function reconcileOwnOrigin(env,{origin,operations,limit=INLINE_RECONCILE_LIMIT,now,policy=RETRY_POLICY}={}){
 if(!IDENT.test(origin||'')||!operations||typeof operations.get!=='function')throw failed('film_person_invalid');
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {skipped:true,reason:'projector_is_writer',origin,considered:0};
 const cap=Math.min(Math.max(Number(limit)||1,1),INLINE_RECONCILE_LIMIT,RECONCILE_LIMIT_MAX);
 return reconcileReceipts(env,{operations,origin,limit:cap,policy,...(now?{now}:{})});
}
