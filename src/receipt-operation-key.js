// AIR-600 R1 (ADR 0207 decision 3, owner choice 0207-U1 = K2; an amendment of ADR 0119). The RECEIPT OPERATION KEY protocol over `canonical_write_receipt.operation_key` (schema 39,
// migrations/0039_receipt_operation_key.sql): how a retry finds every earlier attempt of the same ITEM and decides from durable state, never from timing. The shared foundation of A1 (admissions)
// and C1 (catalog enrichment). DORMANT: no Worker route, job, cron or producer calls it, and with the column absent every function here refuses before any write (`receipt_operation_key_missing`);
// receipts written without a key are untouched.
//
// The protocol (ADR 0207 decision 3, "Reconcile, then reserve"):
//   1. READ every receipt of the key in ONE statement (one snapshot) and record its HISTORY FINGERPRINT {count, applied}: the number of receipts of the key and of those `applied`. Receipts are
//      append-only, so any reservation or application under the key moves it.
//   2. SETTLE the unresolved set: a `pending` receipt inside its window is a live attempt and is never stolen (`wait`, non-terminal); any other unresolved receipt (`pending` past its window, `failed`,
//      `unknown`) is moved to `abandoned` (`superseded_by_retry`) by a fenced update matched on its request id, state, attempts and key. Its tail (matched on state `pending` and the attempt) can then
//      never land, and `abandoned` is terminal. A miss re-reads the history.
//   3. VALIDATE the applied set against CURRENT state: an applied receipt is never trusted on its own. The caller's `validate` sees each one with its target resolved through redirects and answers
//      `settled` (the admission or effect this work needs is in place: report it, do not write) or `historical` (another movie, before an identity correction: proceed). No validator, or any other
//      answer, refuses (`operation_key_validation_required`).
//   4. The caller reacquires its source (outside this module).
//   5. RESERVE or FINALIZE atomically against the observed history: a reservation is a keyed `receiptedWrite` whose insert asserts the fingerprint and that no unresolved receipt exists; a terminal
//      outcome that reserves nothing asserts the same condition inside the writer's own batch (`historyGuard`). A failed assertion makes this attempt the LOSER: it wrote nothing and replans from step 1.
// Request ids under a key carry the history ordinal (`keyedRequestIdOf`): the same source at the same durable history gives the same id, and a reservation after an abandoned attempt gets a new one
// (an abandoned id is terminal and can never be reused).
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {OPERATION_KEY_HISTORY_CAP,RETRY_POLICY,assertOperationKeyReady,errorClassOf,normalizeFingerprint,normalizeOperationKey,operationHistoryCondition,receiptedWrite,requestIdOf} from './canonical-receipts.js';

// The most receipts one key may hold (defined with the reservation in canonical-receipts.js). A reservation that would exceed it is refused before any write (`operation_key_history_exhausted`),
// so the history read below, which accepts exactly this many, can always read every accepted attempt. More than this many can only come from outside the protocol: `operation_key_history_oversized`.
export {OPERATION_KEY_HISTORY_CAP};
// Bounded replans of one call: a caller that keeps losing races stops with `wait` / `contended` instead of looping.
export const OPERATION_KEY_ROUNDS=4;
// The class an abandon of step 2 stores. It is a supersession by the protocol, not a failure that needs repair.
export const SUPERSEDED_BY_RETRY='superseded_by_retry';
const IDENT=/^[a-z][a-z0-9_]{0,63}$/;
const UNRESOLVED=new Set(['pending','failed','unknown']);
const REDIRECT_HOPS=8;
const COLUMNS='request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,applied_revision,marker_generation,state,attempts,next_attempt_at,error_class,created_at,updated_at,settled_at,operation_key';
const timeOf=iso=>{const value=Date.parse(iso);if(!Number.isFinite(value))throw failed('film_person_invalid');return value;};
const clockOf=now=>typeof now==='function'?now:()=>(now??new Date().toISOString());

function view(row){
 return {
  requestId:row.request_id,operation:row.operation,origin:row.origin,target:{kind:row.target_kind,id:row.target_id},contentDigest:row.content_digest,
  plannedRevision:Number(row.planned_revision),appliedRevision:row.applied_revision==null?null:Number(row.applied_revision),markerGeneration:Number(row.marker_generation),
  state:row.state,attempts:Number(row.attempts),nextAttemptAt:row.next_attempt_at,errorClass:row.error_class,createdAt:row.created_at,updatedAt:row.updated_at,settledAt:row.settled_at,
  operationKey:row.operation_key,
 };
}
function scopeOf({origin,operationKey}){
 if(!IDENT.test(origin||''))throw failed('film_person_invalid');
 return {origin,operationKey:normalizeOperationKey(operationKey)};
}

// ---- pure ----

export function fingerprintOf(receipts){
 const list=receipts||[];
 return {count:list.length,applied:list.filter(receipt=>receipt.state==='applied').length};
}
export function sameFingerprint(a,b){return !!a&&!!b&&a.count===b.count&&a.applied===b.applied;}
// The plan of steps 2 and 3 for one snapshot: `live` (pending inside its window: wait), `stale` (every other unresolved receipt: abandon), `applied` (validate against current state, newest first)
// and the fingerprint. It reads nothing and writes nothing.
export function planHistory({receipts,now}){
 const at=timeOf(now);
 const plan={live:[],stale:[],applied:[],abandoned:0,fingerprint:fingerprintOf(receipts)};
 for(const receipt of receipts||[]){
  if(receipt.state==='applied')plan.applied.push(receipt);
  else if(receipt.state==='abandoned')plan.abandoned++;
  else if(receipt.state==='pending'&&at<timeOf(receipt.nextAttemptAt))plan.live.push(receipt);
  else if(UNRESOLVED.has(receipt.state))plan.stale.push(receipt);
 }
 plan.applied.sort((a,b)=>String(b.settledAt||'').localeCompare(String(a.settledAt||''))||(a.requestId<b.requestId?-1:1));
 return plan;
}
// The request id of an attempt under a key: the origin, the operation, the key, the history ordinal (the fingerprint count it reserves against) and the caller's own source identity (its content
// digest, never the content). Deterministic from durable state; no clock enters it.
export async function keyedRequestIdOf({origin,operation,operationKey,ordinal,source}){
 if(!Number.isInteger(ordinal)||ordinal<0)throw failed('film_person_invalid');
 return requestIdOf({origin,operation,source:{operationKey:normalizeOperationKey(operationKey),ordinal,source}});
}
// The condition a terminal outcome asserts in its own batch: {sql, params}, ONE boolean expression (the history still has this fingerprint and nothing is unresolved under the key). Each writer wraps
// it in its own assertion statement (the canonical domain: `historyAssertion`; the Watchlist ledger and the Ratings fence take caller guards).
export function historyGuard({origin,operationKey,fingerprint}){return operationHistoryCondition({origin,operationKey,fingerprint});}
// The same condition as one statement of a fenced canonical batch (film_person_cas): a false condition fails the CHECK and rolls the whole batch back.
// AIR-672 / ADR 0217 decision 5b: the OWNED-ATTEMPT assertion of a batch that is not the canonical batch (the inferred import's Ratings link batch). One [sql, params] boolean: the receipt of this key is still `pending` with exactly
// this request id and attempt number and is not past its window at `now`. An expired or abandoned attempt (ADR 0207 step 2) is `abandoned`, so its late effect fails the batch whole. The Ratings tables and the receipts
// live in one D1 database, so this is a statement of the very same batch as the effect.
// The deadline is compared with the time the DATABASE executes the statement at (`now` omitted: SQLite's UTC clock in the receipts' own ISO convention), so a batch that was built in time but is delayed past the deadline before it
// runs still fails. A caller may pass `now` (an ISO string) to bind a fixed instant instead; that variant is for the deterministic unit tests and is not accepted by the Ratings carrier.
export function ownedAttemptCondition({origin,operationKey,requestId,attempt,now}){
 const scope=scopeOf({origin,operationKey});
 if(typeof requestId!=='string'||!requestId||!Number.isInteger(attempt)||attempt<1||(now!==undefined&&(typeof now!=='string'||!now)))throw failed('film_person_invalid');
 const head="EXISTS (SELECT 1 FROM canonical_write_receipt WHERE origin=? AND operation_key=? AND request_id=? AND state='pending' AND attempts=? AND next_attempt_at>";
 if(now===undefined)return {sql:head+"strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params:[scope.origin,scope.operationKey,requestId,attempt]};
 return {sql:head+'?)',params:[scope.origin,scope.operationKey,requestId,attempt,now]};
}
export function historyAssertion(scope){const guard=historyGuard(scope);return [fenced.assertSql(guard.sql),guard.params];}

// ---- storage ----

// Step 1: every receipt of the key, oldest first, and its fingerprint, from ONE statement (so the list and the fingerprint describe the same snapshot). Read-only.
export async function readOperationHistory(env,scope){
 const {origin,operationKey}=scopeOf(scope);
 await assertOperationKeyReady(env);
 const rows=(await many(database(env),'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE origin=? AND operation_key=? ORDER BY created_at,request_id LIMIT ?',[origin,operationKey,OPERATION_KEY_HISTORY_CAP+1])).map(view);
 if(rows.length>OPERATION_KEY_HISTORY_CAP)throw failed('operation_key_history_oversized');
 return {origin,operationKey,receipts:rows,fingerprint:fingerprintOf(rows)};
}

// Step 2, one receipt: `abandoned` (`superseded_by_retry`) in a batch fenced by the marker generation and matched on the receipt's request id, state, attempts and key. true when it moved it, false when
// the receipt was no longer in that state (another caller settled, retried or applied it: re-read). Any other refusal throws.
async function abandonStale(env,gate,receipt,now){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('film_person_unavailable');
 const statements=[...fenced.head(gate,[]),
  ["UPDATE canonical_write_receipt SET state='abandoned',error_class=?,next_attempt_at=NULL,updated_at=?,settled_at=? WHERE request_id=? AND state=? AND attempts=? AND origin=? AND operation_key=?",[SUPERSEDED_BY_RETRY,now,now,receipt.requestId,receipt.state,receipt.attempts,receipt.origin,receipt.operationKey]],
  [fenced.assertSql('changes()>=1'),[]]];
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return true;}
 catch(error){
  if(!/CHECK constraint failed/i.test(String(error?.message||error)))throw failed('film_person_unavailable',error);
  let again;
  try{again=await readAuthority(env);}catch{throw failed('film_person_unavailable',error);}
  if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_fence',error);
  return false;
 }
}

// The current identity of a target: a Film follows `film_redirect` (a merge) to the Film that holds it now, at most a few hops; a Person is itself. A redirect that does not resolve refuses.
export async function currentTargetOf(env,target){
 if(target?.kind!=='film')return {kind:target?.kind,id:target?.id};
 const db=database(env);
 let id=target.id;
 for(let hop=0;hop<=REDIRECT_HOPS;hop++){
  const row=await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]);
  if(!row)return {kind:'film',id,redirected:id!==target.id};
  id=row.to_film_id;
 }
 throw failed('film_person_redirect');
}

// Steps 1 to 3. -> {status:'wait', reason:'in_flight'|'contended', ...} (non-terminal: nothing to do now)
//                | {status:'settled', receipt, currentTarget, fingerprint} (an applied attempt that the caller validated against current state: report it, write nothing)
//                | {status:'clear', fingerprint, ordinal, historical, abandoned} (nothing unresolved, nothing settled: reacquire, then reserve or finalize against `fingerprint`).
// `validate(receipt, {currentTarget, history})` -> 'settled' | 'historical' is the caller's current-state check of an applied receipt; it is required whenever the key has an applied receipt.
export async function reconcileOperationKey(env,{origin,operationKey,now,rounds=OPERATION_KEY_ROUNDS}={},{validate}={}){
 const scope=scopeOf({origin,operationKey});
 const clock=clockOf(now);
 const abandoned=[];
 for(let round=0;round<rounds;round++){
  const history=await readOperationHistory(env,scope);
  const plan=planHistory({receipts:history.receipts,now:clock()});
  if(plan.live.length){
   const first=[...plan.live].sort((a,b)=>String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))[0];
   return {status:'wait',reason:'in_flight',requestId:first.requestId,dueAt:first.nextAttemptAt,fingerprint:history.fingerprint,abandoned};
  }
  if(plan.stale.length){
   // Abandon every stale attempt, then read again: a miss means another caller moved that receipt, and the next snapshot shows how.
   const gate=assertWritable(await readAuthority(env));
   for(const receipt of plan.stale)if(await abandonStale(env,gate,receipt,clock()))abandoned.push(receipt.requestId);
   continue;
  }
  const historical=[];
  for(const receipt of plan.applied){
   if(typeof validate!=='function')throw failed('operation_key_validation_required');
   const currentTarget=await currentTargetOf(env,receipt.target);
   const verdict=await validate(receipt,{currentTarget,history});
   if(verdict==='settled')return {status:'settled',receipt,currentTarget,fingerprint:history.fingerprint,abandoned};
   if(verdict!=='historical')throw failed('operation_key_validation_required');
   historical.push({receipt,currentTarget});
  }
  return {status:'clear',fingerprint:history.fingerprint,ordinal:history.fingerprint.count,historical,abandoned};
 }
 return {status:'wait',reason:'contended',abandoned};
}

// Step 5, reservation: a keyed receipted write against the observed fingerprint. -> what `receiptedWrite` returns. Throws `operation_key_moved` / `operation_key_in_flight` when this attempt lost.
export async function reserveOperationKey(env,{operationKey,fingerprint,...input},hooks){
 return receiptedWrite(env,{...input,operationKey,history:normalizeFingerprint(fingerprint)},hooks);
}

const LOST=new Set(['operation_key_moved','operation_key_in_flight']);
const EXHAUSTED='operation_key_history_exhausted';
// The whole protocol with bounded replans. spec: {origin, operationKey, now?, policy?, rounds?}. hooks:
//   validate(receipt, ctx)  -> 'settled' | 'historical'          step 3 (see reconcileOperationKey);
//   decide(ctx)             -> one decision, after the history is clear (ctx: {fingerprint, ordinal, historical, abandoned}); this is where the caller reacquires its source:
//     {kind:'reserve', request:{operation, target, expectedRevision, digest, source?, requestId?, policy?}, write:{run, readback, revalidate?, atomic:true}}
//        reserve under the key (the request id defaults to keyedRequestIdOf over `source`, or the digest) and run the writer through receiptedWrite;
//     {kind:'finalize', write:async guard=>result}
//        a terminal outcome that reserves nothing: the caller's write carries `guard` ({sql, params}) inside its own batch and answers {refused:true} when its batch was refused;
//     {kind:'none', result}
//        nothing to write.
// -> {status:'wait'|'settled'|'reserved'|'finalized'|'refused'|'exhausted'|'none', ...}. `exhausted`: the key holds OPERATION_KEY_HISTORY_CAP receipts, so no new attempt is reserved (for a person). `refused` is a finalize refused with the history unchanged (another guard of the caller's batch failed). A lost race
// (the reservation's or the finalize's assertion) replans from step 1, at most `rounds` times; then `wait` / `contended`. Other errors propagate after nothing was reported.
export async function runOperationKey(env,{origin,operationKey,now,policy=RETRY_POLICY,rounds=OPERATION_KEY_ROUNDS}={},hooks={}){
 const scope=scopeOf({origin,operationKey});
 if(typeof hooks.decide!=='function')throw failed('film_person_invalid');
 const clock=clockOf(now);
 let replans=0;
 for(let round=0;round<rounds;round++){
  const state=await reconcileOperationKey(env,{...scope,now:clock,rounds},{validate:hooks.validate});
  if(state.status!=='clear')return {...state,replans};
  // `exhausted`: the key is at its history cap, so a reservation would be refused; a terminal outcome that reserves nothing is still possible.
  const ctx={fingerprint:state.fingerprint,ordinal:state.ordinal,historical:state.historical,abandoned:state.abandoned,exhausted:state.fingerprint.count>=OPERATION_KEY_HISTORY_CAP};
  const decision=await hooks.decide(ctx);
  if(decision?.kind==='none')return {status:'none',result:decision.result,fingerprint:state.fingerprint,replans};
  if(decision?.kind==='reserve'){
   const request=decision.request||{};
   const requestId=request.requestId??await keyedRequestIdOf({origin:scope.origin,operation:request.operation,operationKey:scope.operationKey,ordinal:state.ordinal,source:request.source??request.digest});
   try{
    const outcome=await reserveOperationKey(env,{requestId,operation:request.operation,origin:scope.origin,target:request.target,expectedRevision:request.expectedRevision,digest:request.digest,
     operationKey:scope.operationKey,fingerprint:state.fingerprint,now:clock,policy:request.policy||policy,...(request.reserveExtra?{reserveExtra:request.reserveExtra}:{})},decision.write);
    return {status:'reserved',requestId,outcome,fingerprint:state.fingerprint,replans};
   }catch(error){
    if(LOST.has(errorClassOf(error))){replans++;continue;}
    // At the cap: a typed, fail-closed answer; no receipt was written and the writer never ran.
    if(errorClassOf(error)===EXHAUSTED)return {status:'exhausted',fingerprint:state.fingerprint,replans};
    throw error;
   }
  }
  if(decision?.kind==='finalize'&&typeof decision.write==='function'){
   const guard=historyGuard({...scope,fingerprint:state.fingerprint});
   const result=await decision.write(guard);
   if(result?.refused!==true)return {status:'finalized',result,fingerprint:state.fingerprint,replans};
   // Refused: lost the race only if the history moved; otherwise another guard of the caller's batch refused it, and that is the caller's answer.
   const after=await readOperationHistory(env,scope);
   if(sameFingerprint(after.fingerprint,state.fingerprint)&&!after.receipts.some(receipt=>UNRESOLVED.has(receipt.state)))return {status:'refused',result,fingerprint:state.fingerprint,replans};
   replans++;
   continue;
  }
  throw failed('film_person_invalid');
 }
 return {status:'wait',reason:'contended',replans};
}
