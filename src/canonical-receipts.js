// AIR-374 P2c (ADR 0119; ADR 0117 owner decision 5; parent ADR 0099). The durable CANONICAL WRITE RECEIPT protocol over the D1 table `canonical_write_receipt` (schema 19,
// migrations/0019_canonical_write_receipt.sql). DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, job or cron calls it. The migration is
// introduced in code only; applying it to production D1 is a separate owner GO.
//
// The protocol (owner decision 5: a cross-domain operation into canonical Film/Person has a durable receipt, a stable request id, bounded safe retries and a separate reconciliation):
//   1. PENDING first. The receipt row is inserted (state `pending`, attempt 1, the planned-content digest, the marker generation) in a batch fenced on the marker (`d1`/`open` at
//      that generation, the same fence head as every canonical mutation). If that insert is refused, nothing was written to canonical.
//   2. COMMIT. The writer runs its own fenced commit (src/canonical-mutations.js `fenced.commit`, unchanged). A writer that adopts the receipt may append `appliedStatements` to its OWN
//      batch, so `applied` is atomic with the content; a writer that does not is marked applied by a second batch right after (a crash between them leaves `pending`, which is safe).
//   3. APPLIED. A definite failure marks `failed` (the batch rolled back whole: known NOT applied) or `abandoned` (a permanent input or data refusal); an unknown outcome (the transport
//      or the database answered nothing usable) marks `unknown`. A receipt left `pending` past its attempt window is treated exactly like `unknown`.
//   4. RECONCILE by READBACK, never by assumption: a non-terminal receipt that is DUE is settled by reading the target and comparing its content digest with the planned one. Equal means
//      applied (the write landed and only the receipt was lost); different means it did not land and the SAME request id is replayed, at most `maxAttempts` times, on a stored backoff
//      schedule. Nothing here is a timer: the due time is stored in `next_attempt_at` and whoever reconciles compares it with a clock they pass in.
//   An observed canonical change (a `canonical_revision` row) with no applied receipt for its revision is `unreceipted`, reported and never treated as safe.
//
// What it stores and never stores: operation kind, origin, target (kind, id), the SHA-256 digest of the planned content, revisions, the marker generation, state, attempts, due time,
// timestamps and a short lowercase error class. No payload, no title, no name, no message text, no personal data. The error class is the error CODE, never its message.
// The table is writable only while the marker is `d1`/`open` (a trigger); at `r2` and `prepared` it stays empty and nothing here reaches it (`assertWritable` refuses first).
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

export const RECEIPT_MIN_VERSION=19;
export const RECEIPT_STATES=Object.freeze(['pending','applied','failed','unknown','abandoned']);
const NON_TERMINAL=['pending','failed','unknown'];
// The bounded retry policy. attempts counts every attempt including the first; the backoff after the n-th failed attempt is backoffMs[n-1] (the last entry repeats); an in-flight
// (`pending`) attempt owns the receipt for attemptWindowMs; a receipt older than abandonAfterMs is abandoned instead of retried. The table caps attempts at 16 in SQL.
export const RETRY_POLICY=Object.freeze({maxAttempts:5,backoffMs:Object.freeze([60000,300000,1800000,7200000]),attemptWindowMs:120000,abandonAfterMs:7*24*60*60*1000});
export const RECONCILE_LIMIT_MAX=50;
// The closed set of operation kinds the P2a/P2b writers and the P3 producers register under. The SQL column accepts any lowercase identifier; this list is the code-reviewed set.
export const OPERATION_KINDS=Object.freeze(['film_mutation','film_merge','film_metadata','film_dimension','film_sync_state','film_membership','person_mutation','person_state','localization_conflict','localization_source','film_admission','film_retention','tmdb_retirement']);
const IDENT=/^[a-z][a-z0-9_]{0,63}$/;
const REQUEST_ID=/^[A-Za-z0-9:._/=+@-]{1,200}$/;
const DIGEST=/^[0-9a-f]{64}$/;
// Definite refusals that retrying the same content cannot fix: the receipt is abandoned at once (it needs a person or a repair, and says so).
const PERMANENT=new Set(['film_person_invalid','film_person_redirect','identity_collision','person_role_collision','credit_ordinal_conflict','film_person_reference','film_person_bounded']);
// Definite not-applied refusals that a re-read and a replay can fix (the batch rolled back whole).
const RETRYABLE=new Set(['film_person_fence','film_person_revision_conflict','film_person_precondition','film_person_held','film_person_not_open']);

// ---- pure helpers ----

// Canonical JSON: object keys sorted, undefined dropped. The planned-content digest and the readback digest must be computed through this ONE function.
export function canonicalJson(value){
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
}
export async function digestOf(value){
 const bytes=new TextEncoder().encode(canonicalJson(value));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
// The stable request id: the same source event gives the same id on every attempt. `source` is whatever identifies the event in its own domain (a key, a run id and a position);
// only its digest enters the id, so the stored id carries no source text.
export async function requestIdOf({origin,operation,source}){
 if(!IDENT.test(origin||'')||!OPERATION_KINDS.includes(operation)||source===undefined||source===null||source==='')throw failed('film_person_invalid');
 return origin+':'+operation+':'+(await digestOf(source));
}
export function backoffMs(attempts,policy=RETRY_POLICY){
 if(!Number.isInteger(attempts)||attempts<1)throw failed('film_person_invalid');
 return policy.backoffMs[Math.min(attempts-1,policy.backoffMs.length-1)];
}
const plus=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();
const timeOf=iso=>{const value=Date.parse(iso);if(!Number.isFinite(value))throw failed('film_person_invalid');return value;};
// The stored short class of an error: its code when it is a lowercase identifier, otherwise `unclassified`. A message is never stored.
export function errorClassOf(error){const code=String(error?.code||'');return IDENT.test(code)?code:'unclassified';}
// How a failed attempt settles: `abandoned` (permanent), `failed` (definitely not applied, retryable) or `unknown` (anything else: the outcome is not known).
export function classify(error){
 const errorClass=errorClassOf(error);
 return {errorClass,outcome:PERMANENT.has(errorClass)?'abandoned':RETRYABLE.has(errorClass)?'failed':'unknown'};
}
export function normalizeRequest(input){
 const target=input?.target;
 const request={
  requestId:input?.requestId,operation:input?.operation,origin:input?.origin,
  target:{kind:target?.kind,id:target?.id},expectedRevision:input?.expectedRevision,digest:input?.digest,
 };
 if(!REQUEST_ID.test(request.requestId||'')||!IDENT.test(request.operation||'')||!OPERATION_KINDS.includes(request.operation)||!IDENT.test(request.origin||''))throw failed('film_person_invalid');
 if(request.target.kind==='film'?!/^film:.+/.test(request.target.id||''):request.target.kind==='person'?!/^person:.+/.test(request.target.id||''):true)throw failed('film_person_invalid');
 if(request.target.id.length>300||!Number.isInteger(request.expectedRevision)||request.expectedRevision<0||!DIGEST.test(request.digest||''))throw failed('film_person_invalid');
 return request;
}
function view(row){
 return row&&{
  requestId:row.request_id,operation:row.operation,origin:row.origin,target:{kind:row.target_kind,id:row.target_id},contentDigest:row.content_digest,
  plannedRevision:Number(row.planned_revision),appliedRevision:row.applied_revision==null?null:Number(row.applied_revision),markerGeneration:Number(row.marker_generation),
  state:row.state,attempts:Number(row.attempts),nextAttemptAt:row.next_attempt_at,errorClass:row.error_class,createdAt:row.created_at,updatedAt:row.updated_at,settledAt:row.settled_at,
 };
}
const COLUMNS='request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,applied_revision,marker_generation,state,attempts,next_attempt_at,error_class,created_at,updated_at,settled_at';
// Same request id, same operation, origin, target and content: the replay is the same request. Anything else under that id is a conflict.
function sameRequest(row,request){
 return row.operation===request.operation&&row.origin===request.origin&&row.target.kind===request.target.kind&&row.target.id===request.target.id&&row.contentDigest===request.digest;
}

// The pure reconciliation plan. receipts: stored receipts as `readReceipt` shows them; observed: {[requestId]: {digest,revision}|null} for the targets already read (a missing key means NOT read yet,
// null means the target was read and holds nothing); marker: {state,generation} from readAuthority; now: ISO time. It reads nothing and writes nothing.
// Actions: `readback` (read the target first), `mark_applied` (the target already holds the planned content: only the receipt was lost), `replay` (re-plan against the current revision and
// run again with the SAME request id; `replan` is true when the marker generation moved), `abandon` (bounded: attempts exhausted or too old). Everything else is `waiting` with its reason,
// or `attention` (an abandoned receipt: a known failure that needs repair, never silently dropped).
export function reconcilePlan({receipts,observed={},marker,now,policy=RETRY_POLICY}){
 const plan={actions:[],waiting:[],attention:[],counts:{applied:0,abandoned:0,pending:0,failed:0,unknown:0}};
 const at=timeOf(now);
 const ordered=[...(receipts||[])].sort((a,b)=>String(a.nextAttemptAt||'').localeCompare(String(b.nextAttemptAt||''))||(a.requestId<b.requestId?-1:1));
 for(const receipt of ordered){
  plan.counts[receipt.state]=(plan.counts[receipt.state]||0)+1;
  if(receipt.state==='applied')continue;
  if(receipt.state==='abandoned'){plan.attention.push({requestId:receipt.requestId,reason:receipt.errorClass||'abandoned'});continue;}
  if(!NON_TERMINAL.includes(receipt.state))continue;
  if(at<timeOf(receipt.nextAttemptAt)){plan.waiting.push({requestId:receipt.requestId,reason:receipt.state==='pending'?'in_flight':'backoff',dueAt:receipt.nextAttemptAt});continue;}
  if(marker?.state!=='open'){plan.waiting.push({requestId:receipt.requestId,reason:'marker_not_open',dueAt:receipt.nextAttemptAt});continue;}
  const seen=observed[receipt.requestId];
  if(seen===undefined){plan.actions.push({requestId:receipt.requestId,action:'readback'});continue;}
  if(seen&&seen.digest===receipt.contentDigest){plan.actions.push({requestId:receipt.requestId,action:'mark_applied',revision:Number(seen.revision)||0});continue;}
  if(receipt.attempts>=policy.maxAttempts){plan.actions.push({requestId:receipt.requestId,action:'abandon',reason:'attempts_exhausted'});continue;}
  if(at-timeOf(receipt.createdAt)>policy.abandonAfterMs){plan.actions.push({requestId:receipt.requestId,action:'abandon',reason:'expired'});continue;}
  plan.actions.push({requestId:receipt.requestId,action:'replay',attempt:receipt.attempts+1,replan:receipt.markerGeneration!==marker.generation});
 }
 return plan;
}

// Observed canonical changes without an applied receipt. changes: [{kind,id,revision}] (the canonical_revision rows); receipts: stored receipts. A change is covered only by an APPLIED receipt of the
// same target whose applied revision is that revision. A target with a non-terminal receipt is reported with reason `receipt_not_applied`, one with none with `no_receipt`: both are `unreceipted` and
// `safe` is false while either exists. An absent receipt is never read as "fine".
export function unreceiptedChanges({changes,receipts}){
 const applied=new Set(),open=new Set();
 for(const receipt of receipts||[]){
  const key=receipt.target.kind+'|'+receipt.target.id;
  if(receipt.state==='applied')applied.add(key+'|'+receipt.appliedRevision);
  else if(NON_TERMINAL.includes(receipt.state))open.add(key);
 }
 const unreceipted=[];let covered=0;
 for(const change of changes||[]){
  if(!(Number(change.revision)>=1))continue;
  const key=change.kind+'|'+change.id;
  if(applied.has(key+'|'+Number(change.revision)))covered++;
  else unreceipted.push({kind:change.kind,id:change.id,revision:Number(change.revision),reason:open.has(key)?'receipt_not_applied':'no_receipt'});
 }
 return {unreceipted,covered,safe:unreceipted.length===0};
}

// ---- the registration point ----

// What a P2a/P2b writer (or a P3 producer adapter) registers for one operation kind:
//   readback(env,target,receipt) -> {digest,revision}|null  the content digest of what the target holds NOW, computed through digestOf over the same canonical form as the planned digest;
//   replay(env,receipt,ctx)      -> {revision}              re-plans against the CURRENT revision (ctx.currentRevision) and runs the writer's fenced commit again with the same request id.
// A writer that wants `applied` atomic with its content appends ctx.appliedStatements() to its own batch before the commit. Both functions are the adopter's; this module owns the protocol.
export function defineOperation(spec){
 if(!OPERATION_KINDS.includes(spec?.operation)||typeof spec.readback!=='function'||typeof spec.replay!=='function')throw failed('film_person_invalid');
 return Object.freeze({operation:spec.operation,readback:spec.readback,replay:spec.replay});
}
export function operationRegistry(specs=[]){
 const map=new Map();
 for(const spec of specs){if(map.has(spec.operation))throw failed('film_person_invalid');map.set(spec.operation,spec);}
 return map;
}

// ---- storage ----

export async function receiptsAvailable(env){
 const db=database(env);
 if(!db)return false;
 try{
  const row=await one(db,"SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_write_receipt') AS present");
  return Number(row?.version)>=RECEIPT_MIN_VERSION&&Number(row?.present)===1;
 }catch{return false;}
}
// A producer must refuse to write canonical while this throws: without a receipt table the absence of a record proves nothing.
export async function assertReceiptsAvailable(env){if(!(await receiptsAvailable(env)))throw failed('receipt_schema_missing');}

export async function readReceipt(env,requestId){
 const db=database(env);
 return view(await one(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE request_id=?',[requestId]));
}
export async function listReceipts(env,{states=NON_TERMINAL,dueBefore=null,limit=RECONCILE_LIMIT_MAX}={}){
 const db=database(env);
 const cap=Math.min(Math.max(Number(limit)||1,1),RECONCILE_LIMIT_MAX);
 const list=states.filter(state=>RECEIPT_STATES.includes(state));
 if(!list.length)return [];
 const where='state IN ('+list.map(()=>'?').join(',')+')'+(dueBefore?' AND next_attempt_at<=?':'');
 return (await many(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE '+where+' ORDER BY next_attempt_at,request_id LIMIT ?',[...list,...(dueBefore?[dueBefore]:[]),cap])).map(view);
}
// Observed canonical changes with no applied receipt for their current revision, bounded; the result is the pure `unreceiptedChanges` answer over exactly those rows.
export async function readUnreceipted(env,{limit=100}={}){
 await assertReceiptsAvailable(env);
 const db=database(env);
 const cap=Math.min(Math.max(Number(limit)||1,1),500);
 const rows=await many(db,"SELECT r.kind AS kind,r.id AS id,r.revision AS revision,EXISTS (SELECT 1 FROM canonical_write_receipt o WHERE o.target_kind=r.kind AND o.target_id=r.id AND o.state IN ('pending','failed','unknown')) AS has_open FROM canonical_revision r WHERE r.revision>=1 AND NOT EXISTS (SELECT 1 FROM canonical_write_receipt w WHERE w.target_kind=r.kind AND w.target_id=r.id AND w.state='applied' AND w.applied_revision=r.revision) ORDER BY r.kind,r.id LIMIT ?",[cap]);
 const pseudo=rows.filter(row=>Number(row.has_open)===1).map(row=>({target:{kind:row.kind,id:row.id},state:'pending',appliedRevision:null}));
 return unreceiptedChanges({changes:rows,receipts:pseudo});
}

const INSERT='INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)';
const CHANGED=fenced.assertSql('changes()>=1');
const FROM='WHERE request_id=? AND state=? AND attempts=?';

// The statements that mark this attempt's receipt applied INSIDE a writer's own fenced batch: they read the entity revision AFTER the writer's BUMP, so they must come after it. If the receipt is no
// longer this attempt's pending row the assertion fails and the writer's whole batch rolls back (the content never commits without its receipt being the current attempt).
export function appliedStatements({requestId,attempt,target,now}){
 return [
  ["UPDATE canonical_write_receipt SET state='applied',applied_revision=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0),error_class=NULL,next_attempt_at=NULL,updated_at=?,settled_at=? "+FROM,[target.kind,target.id,now,now,requestId,'pending',attempt]],
  [CHANGED,[]],
 ];
}

async function writeBatch(env,gate,statements){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('film_person_unavailable');
 const all=[...fenced.head(gate,[]),...statements];
 try{await db.batch(all.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  const message=String(error?.message||error);
  const trigger=/canonical_receipt_([a-z_]+)/.exec(message);
  if(trigger)throw failed('canonical_receipt_'+trigger[1],error);
  if(/UNIQUE constraint failed: canonical_write_receipt/i.test(message))throw failed('receipt_exists',error);
  if(/CHECK constraint failed/i.test(message)){
   let again;
   try{again=await readAuthority(env);}catch{throw failed('film_person_unavailable',error);}
   if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_fence',error);
   throw failed('receipt_state_conflict',error);
  }
  throw failed('film_person_unavailable',error);
 }
}

async function transition(env,gate,row,change,now){
 const where=[row.requestId,row.state,row.attempts];
 const statements={
  applied:()=>[["UPDATE canonical_write_receipt SET state='applied',applied_revision=?,error_class=NULL,next_attempt_at=NULL,updated_at=?,settled_at=? "+FROM,[change.revision,now,now,...where]]],
  failed:()=>[["UPDATE canonical_write_receipt SET state=?,error_class=?,next_attempt_at=?,updated_at=? "+FROM,[change.state,change.errorClass,change.nextAttemptAt,now,...where]]],
  abandoned:()=>[["UPDATE canonical_write_receipt SET state='abandoned',error_class=?,next_attempt_at=NULL,updated_at=?,settled_at=? "+FROM,[change.errorClass,now,now,...where]]],
  retry:()=>[["UPDATE canonical_write_receipt SET state='pending',planned_revision=?,marker_generation=?,attempts=attempts+1,next_attempt_at=?,updated_at=? "+FROM,[change.plannedRevision,gate.generation,change.nextAttemptAt,now,...where]]],
 }[change.kind]();
 await writeBatch(env,gate,[...statements,[CHANGED,[]]]);
}

// Runs one attempt whose receipt is already `pending` at `attempt`, then settles it. A run error never escapes as a throw from here: it is returned, after the receipt is marked (a failed
// mark leaves the receipt `pending`, which reconciliation treats as unknown).
async function finishAttempt(env,{gate,row,attempt,run,clock,policy}){
 let result;
 try{
  result=await run({gate,requestId:row.requestId,attempt,target:row.target,appliedStatements:()=>appliedStatements({requestId:row.requestId,attempt,target:row.target,now:clock()})});
 }catch(error){
  const {errorClass,outcome}=classify(error);
  const now=clock();
  const current={...row,state:'pending',attempts:attempt};
  try{
   if(outcome==='abandoned')await transition(env,gate,current,{kind:'abandoned',errorClass},now);
   else await transition(env,gate,current,{kind:'failed',state:outcome,errorClass,nextAttemptAt:plus(now,backoffMs(attempt,policy))},now);
  }catch{/* the marker moved or the database refused: the receipt stays pending and is settled by readback */}
  return {ran:true,state:'pending',error,errorClass,outcome};
 }
 let after=null;
 try{after=await readReceipt(env,row.requestId);}catch{/* settled below */}
 if(after?.state==='applied')return {ran:true,state:'applied',result,receipt:after};
 let revision=Number.isInteger(result?.revision)&&result.revision>=0?result.revision:null;
 try{
  if(revision===null)revision=Number((await one(database(env),'SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0) AS revision',[row.target.kind,row.target.id]))?.revision??0);
  await transition(env,gate,{...row,state:'pending',attempts:attempt},{kind:'applied',revision},clock());
 }catch{return {ran:true,state:'pending',result,markFailed:true};}
 return {ran:true,state:'applied',result};
}

// ONE cross-domain write with its durable receipt. input: {requestId,operation,origin,target:{kind,id},expectedRevision,digest,now?,policy?}. hooks: {run,readback}.
//   run({gate,requestId,attempt,target,appliedStatements}) -> {revision?}  the writer's fenced commit (it may append appliedStatements() to its own batch);
//   readback(env,target,receipt) -> {digest,revision}|null               the same readback an operation registers for reconciliation.
// A new request id records `pending` first and then runs. An existing id never runs while its attempt is in flight or backing off; once due it is first settled by readback (the write may have
// landed), and only if the target does not hold the planned content is it retried (bounded) with the same id. A different operation, target or content under an id is `receipt_conflict`.
// A run error is rethrown after the receipt is marked.
export async function receiptedWrite(env,input,hooks){
 const request=normalizeRequest(input);
 const policy=input.policy||RETRY_POLICY,clock=input.now||(()=>new Date().toISOString());
 await assertReceiptsAvailable(env);
 const gate=assertWritable(await readAuthority(env));
 let row=await readReceipt(env,request.requestId),created=false;
 if(!row){
  const now=clock();
  try{
   await writeBatch(env,gate,[[INSERT,[request.requestId,request.operation,request.origin,request.target.kind,request.target.id,request.digest,request.expectedRevision,gate.generation,'pending',plus(now,policy.attemptWindowMs),now,now]]]);
   created=true;
   row={requestId:request.requestId,operation:request.operation,origin:request.origin,target:request.target,contentDigest:request.digest,plannedRevision:request.expectedRevision,appliedRevision:null,markerGeneration:gate.generation,state:'pending',attempts:1,nextAttemptAt:plus(now,policy.attemptWindowMs),errorClass:null,createdAt:now,updatedAt:now,settledAt:null};
  }catch(error){
   if(error.code!=='receipt_exists')throw error;
   row=await readReceipt(env,request.requestId);
   if(!row)throw failed('film_person_unavailable');
  }
 }
 if(!sameRequest(row,request))throw failed('receipt_conflict');
 if(row.state==='applied')return {ran:false,state:'applied',already:true,receipt:row};
 if(row.state==='abandoned')return {ran:false,state:'abandoned',receipt:row};
 let attempt=row.attempts;
 if(!created){
  const now=clock();
  if(timeOf(now)<timeOf(row.nextAttemptAt))return {ran:false,state:row.state,reason:row.state==='pending'?'in_flight':'backoff',nextAttemptAt:row.nextAttemptAt,receipt:row};
  if(typeof hooks?.readback!=='function')throw failed('receipt_readback_required');
  const observed=await hooks.readback(env,row.target,row);
  if(observed&&observed.digest===row.contentDigest){
   await transition(env,gate,row,{kind:'applied',revision:Number(observed.revision)||0},now);
   return {ran:false,state:'applied',settled:'readback'};
  }
  const exhausted=row.attempts>=policy.maxAttempts?'attempts_exhausted':timeOf(now)-timeOf(row.createdAt)>policy.abandonAfterMs?'expired':null;
  if(exhausted){await transition(env,gate,row,{kind:'abandoned',errorClass:exhausted},now);return {ran:false,state:'abandoned',reason:exhausted};}
  await transition(env,gate,row,{kind:'retry',plannedRevision:request.expectedRevision,nextAttemptAt:plus(now,policy.attemptWindowMs)},now);
  attempt=row.attempts+1;
 }
 const outcome=await finishAttempt(env,{gate,row,attempt,run:hooks.run,clock,policy});
 if(outcome.error)throw outcome.error;
 return {...outcome,attempt};
}

// The reconciler's one pass (a later P3 reconciler calls this; nothing calls it today and nothing schedules it): reads at most `limit` DUE non-terminal receipts, reads each target through its
// registered operation, applies the pure plan (mark applied, abandon, replay with the same request id) and returns what it did. `now` is passed in; there is no timer.
export async function reconcileReceipts(env,{operations,now=()=>new Date().toISOString(),limit=20,policy=RETRY_POLICY}={}){
 await assertReceiptsAvailable(env);
 const clock=typeof now==='function'?now:()=>now;
 const at=clock();
 const gate=await readAuthority(env);
 const due=await listReceipts(env,{dueBefore:at,limit});
 const result={marker:gate.state,considered:due.length,applied:[],replayed:[],abandoned:[],waiting:[],failed:[]};
 if(gate.state!=='open'){result.waiting=due.map(row=>({requestId:row.requestId,reason:'marker_not_open'}));return result;}
 const observed={},missing=new Set();
 for(const row of due){
  const operation=operations?.get?.(row.operation);
  if(!operation){missing.add(row.requestId);result.waiting.push({requestId:row.requestId,reason:'operation_unregistered'});continue;}
  try{observed[row.requestId]=(await operation.readback(env,row.target,row))??null;}catch{missing.add(row.requestId);result.waiting.push({requestId:row.requestId,reason:'readback_failed'});}
 }
 const byId=new Map(due.map(row=>[row.requestId,row]));
 const plan=reconcilePlan({receipts:due.filter(row=>!missing.has(row.requestId)),observed,marker:gate,now:at,policy});
 for(const action of plan.actions){
  const row=byId.get(action.requestId);
  try{
   if(action.action==='mark_applied'){await transition(env,gate,row,{kind:'applied',revision:action.revision},clock());result.applied.push(row.requestId);}
   else if(action.action==='abandon'){await transition(env,gate,row,{kind:'abandoned',errorClass:action.reason},clock());result.abandoned.push({requestId:row.requestId,reason:action.reason});}
   else if(action.action==='replay'){
    const operation=operations.get(row.operation);
    const t=clock();
    const currentRevision=Number((await one(database(env),'SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0) AS revision',[row.target.kind,row.target.id]))?.revision??0);
    await transition(env,gate,row,{kind:'retry',plannedRevision:currentRevision,nextAttemptAt:plus(t,policy.attemptWindowMs)},t);
    const run=ctx=>operation.replay(env,row,{...ctx,currentRevision});
    const outcome=await finishAttempt(env,{gate,row,attempt:row.attempts+1,run,clock,policy});
    (outcome.state==='applied'?result.replayed:result.failed).push(outcome.state==='applied'?row.requestId:{requestId:row.requestId,outcome:outcome.outcome||'pending',errorClass:outcome.errorClass||null});
   }
  }catch(error){result.failed.push({requestId:row.requestId,outcome:'unsettled',errorClass:errorClassOf(error)});}
 }
 result.waiting.push(...plan.waiting);
 result.attention=plan.attention;
 return result;
}
