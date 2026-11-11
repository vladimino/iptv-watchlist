// AIR-374 P2c (ADR 0119; ADR 0117 owner decision 5; parent ADR 0099). The durable CANONICAL WRITE RECEIPT protocol over the D1 table `canonical_write_receipt` (schema 19,
// migrations/0019_canonical_write_receipt.sql). DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, job or cron calls it. The migration is
// introduced in code only; applying it to production D1 is a separate owner GO.
//
// The protocol (owner decision 5: a cross-domain operation into canonical Film/Person has a durable receipt, a stable request id, bounded safe retries and a separate reconciliation):
//   0. BASELINE first (once, at activation). `recordBaseline` copies the current canonical_revision rows into canonical_receipt_baseline, in one fenced batch, before any receipt exists.
//      A revision at or below its baseline entry predates receipts: it is `pre_receipt_baseline`, never claimed to have a receipt and never reported `unreceipted`. A receipt cannot be
//      inserted before the baseline exists.
//   1. PENDING. The receipt row is inserted (state `pending`, attempt 1, the planned-content digest, the marker generation) in a batch carrying the same fence head as every canonical
//      mutation. If that insert is refused, nothing was written to canonical.
//   2. COMMIT. The writer runs its own fenced commit (src/canonical-mutations.js `fenced.commit`, unchanged).
//   3. APPLIED, ATOMICALLY (owner decision, PR #530 comment 6802553275: the ONLY mode a production adapter may use): the writer appends `appliedStatements()` to its OWN fenced batch, AFTER the revision
//      bump, so the canonical mutation and the receipt's move to `applied` commit together or not at all: a lost answer cannot leave a landed write without its receipt, and the receipt can never say
//      `applied` for a write that rolled back. `defineOperation`/`operationRegistry`/`receiptedWrite` REFUSE (`receipt_atomic_required`) anything that is not `atomic:true`, unless it carries a named
//      exception record (id, review, proof, ownerAcceptance) whose id is in APPROVED_EXCEPTIONS: that list is EMPTY, no operation has an exception, and the separate-mark path below is a legacy mechanism
//      that exists only behind it, never a default and not approved for P3. Under `atomic` this module never marks applied by a second batch: a writer that returns without the receipt applied leaves it
//      `unknown` (`atomic_mark_missing`).
//      LEGACY, exception-gated only: a second batch marks `applied` after the writer returned. If the answer or the mark is lost the receipt stays `pending`, and only OPERATION-SPECIFIC EVIDENCE can settle it
//      as applied (see 4): a content digest alone cannot, because another actor may independently reach identical final content and a later writer may overwrite it.
//      A definite rollback marks `failed` (known NOT applied), a permanent refusal `abandoned`, any other outcome `unknown`; a `pending` receipt past its window is treated like `unknown`.
//   4. RECONCILE by READBACK, never by assumption. A due non-terminal receipt is settled from what its operation's `readback` returns: {digest, revision, proof?}.
//      - `proof: 'request'` means the operation proved THIS request's own effect (request-id evidence written inside the writer's own batch, for example) at `revision`: the receipt becomes
//        `applied`, even if the content was overwritten since, and the writer does not run again.
//      - A digest equal to the planned one WITHOUT that proof is `content_unproven`: the receipt is never marked applied; it is abandoned for review (`content_match_unproven`), because
//        the identical content may be someone else's write. It is reported in `needsReview`.
//      - Anything else did not land: the SAME request id is retried, at most `maxAttempts` times on a stored backoff, but only after the retry is re-validated (see 5).
//   5. STALE REVISION. A retry reads the CURRENT canonical revision. If it equals the revision the receipt was planned against, the retry runs. If an unrelated writer advanced it, the
//      retry is never blind: the operation's `revalidate(env,receipt,{currentRevision,observed})` must answer `proceed` (the writer re-checked its preconditions and re-plans against
//      `currentRevision`); `superseded` abandons the receipt (`superseded_by_newer_revision`); no `revalidate`, or any other answer, abandons it for repair
//      (`stale_revision_needs_repair`). The writer's own revision CAS still refuses anything planned against an older revision, so newer content is never overwritten by default.
//   An observed canonical change (a `canonical_revision` row ABOVE its baseline) with no applied receipt for its revision is `unreceipted`, reported and never treated as safe.
//
// What it stores and never stores: operation kind, origin, target (kind, id), the SHA-256 digest of the planned content, revisions, the marker generation, state, attempts, due time,
// timestamps and a short lowercase error class. No payload, no title, no name, no message text, no personal data. The error class is the error CODE, never its message.
// The table is writable only while the marker is `d1`/`open` (a trigger); at `r2` and `prepared` it stays empty and nothing here reaches it (`assertWritable` refuses first).
// APPEND-ONLY during initial stabilization: nothing here deletes, prunes, expires, archives or rewrites a terminal row (a trigger refuses it too); `abandoned` stays visible (`listAttention`). The 7-day rule below
// is about the state of an operation (abandon instead of retry), not about deleting rows. Retention and lifecycle are an owner decision that returns later, after growth and cost are measured.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

export const RECEIPT_MIN_VERSION=19;
export const RECEIPT_STATES=Object.freeze(['pending','applied','failed','unknown','abandoned']);
const NON_TERMINAL=['pending','failed','unknown'];
// SAFE INITIAL DEFAULTS (owner-reviewable, ADR 0119): attempts counts every attempt including the first; the backoff after the n-th failed attempt is backoffMs[n-1] (the last entry
// repeats); an in-flight (`pending`) attempt owns the receipt for attemptWindowMs; a receipt older than abandonAfterMs is abandoned instead of retried. The table caps attempts at 16.
export const RETRY_POLICY=Object.freeze({maxAttempts:5,backoffMs:Object.freeze([60000,300000,1800000,7200000]),attemptWindowMs:120000,abandonAfterMs:7*24*60*60*1000});
export const RECONCILE_LIMIT_MAX=50;
// The baseline copies at most this many canonical_revision rows in one statement; a larger table is refused (a bounded activation step, not a bulk job).
export const BASELINE_CAP=5000;
// ATOMIC MODE IS REQUIRED (owner decision, PR #530 comment 6802553275): a production adapter performs its canonical mutation AND the receipt transition to `applied` in the SAME fenced batch.
// The separate-mark path (a second batch after the writer returned) exists ONLY as a named exception, and an exception is accepted only when its id is in this list. NO operation has one today:
// the list is empty, and adding an entry needs an independent review, a safety proof and an owner acceptance id recorded in the exception record. It is a legacy mechanism, never a default.
export const APPROVED_EXCEPTIONS=Object.freeze([]);
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

// What a readback proves about a receipt. `applied`: the operation proved this request's own effect. `content_unproven`: the planned content is there but nothing says it is THIS request's
// (another actor may have reached it): never applied. `absent`: the planned effect is not there.
export function judgeReadback(observed,receipt){
 if(observed&&observed.proof==='request')return 'applied';
 if(observed&&observed.digest===receipt.contentDigest)return 'content_unproven';
 return 'absent';
}

// The pure reconciliation plan. receipts: stored receipts as `readReceipt` shows them; observed: {[requestId]: {digest,revision,proof?}|null} for the targets already read (a missing key means NOT
// read yet, null means the target was read and holds nothing); marker: {state,generation} from readAuthority; now: ISO time. It reads nothing and writes nothing.
// Actions: `readback` (read the target first), `mark_applied` (the readback proved this request's own effect), `needs_review` (the content is there but unproven), `replay` (retry with the SAME
// request id, after the stale-revision check of the pass; `replan` is true when the marker generation moved), `abandon` (bounded: attempts exhausted or too old). Everything else is `waiting`
// with its reason, or `attention` (an abandoned receipt: a known failure that needs repair, never silently dropped).
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
  const verdict=judgeReadback(seen,receipt);
  if(verdict==='applied'){plan.actions.push({requestId:receipt.requestId,action:'mark_applied',revision:Number(seen.revision)||0});continue;}
  if(verdict==='content_unproven'){plan.actions.push({requestId:receipt.requestId,action:'needs_review',reason:'content_match_unproven'});continue;}
  if(receipt.attempts>=policy.maxAttempts){plan.actions.push({requestId:receipt.requestId,action:'abandon',reason:'attempts_exhausted'});continue;}
  if(at-timeOf(receipt.createdAt)>policy.abandonAfterMs){plan.actions.push({requestId:receipt.requestId,action:'abandon',reason:'expired'});continue;}
  plan.actions.push({requestId:receipt.requestId,action:'replay',attempt:receipt.attempts+1,replan:receipt.markerGeneration!==marker.generation});
 }
 return plan;
}

// Observed canonical changes without an applied receipt. changes: [{kind,id,revision}] (the canonical_revision rows); receipts: stored receipts; baseline: {'kind|id': revision} recorded at
// activation (absent entry: 0). A revision at or below its baseline entry is `pre_receipt_baseline`: it predates receipts, is listed apart and is NOT unreceipted. Above it, a change is covered only
// by an APPLIED receipt of the same target whose applied revision is that revision; a target with a non-terminal receipt is reported `receipt_not_applied`, one with none `no_receipt`: both are
// `unreceipted` and `safe` is false while either exists. An absent receipt is never read as "fine".
export function unreceiptedChanges({changes,receipts,baseline={}}){
 const applied=new Set(),open=new Set();
 for(const receipt of receipts||[]){
  const key=receipt.target.kind+'|'+receipt.target.id;
  if(receipt.state==='applied')applied.add(key+'|'+receipt.appliedRevision);
  else if(NON_TERMINAL.includes(receipt.state))open.add(key);
 }
 const unreceipted=[],preReceiptBaseline=[];let covered=0;
 for(const change of changes||[]){
  if(!(Number(change.revision)>=1))continue;
  const key=change.kind+'|'+change.id;
  if(applied.has(key+'|'+Number(change.revision))){covered++;continue;}
  if(Number(change.revision)<=Number(baseline[key]||0)){preReceiptBaseline.push({kind:change.kind,id:change.id,revision:Number(change.revision)});continue;}
  unreceipted.push({kind:change.kind,id:change.id,revision:Number(change.revision),reason:open.has(key)?'receipt_not_applied':'no_receipt'});
 }
 return {unreceipted,preReceiptBaseline,covered,safe:unreceipted.length===0};
}

// ---- the registration point ----

// What a P2a/P2b writer (or a P3 producer adapter) registers for one operation kind:
//   readback(env,target,receipt) -> {digest,revision,proof?}|null  the content digest of what the target holds NOW (digestOf over the same canonical form as the planned digest) and, when the
//                                    operation can prove this request's own effect (request-id evidence written inside the writer's own batch), proof:'request' with the revision it landed at;
//   replay(env,receipt,ctx)      -> {revision}                    runs the writer's fenced commit again with the same request id, planned against ctx.currentRevision;
//   revalidate(env,receipt,ctx)  -> 'proceed'|'superseded'        optional: called only when the entity revision moved since planning; the writer re-checks its preconditions. Without it a moved
//                                    revision abandons the receipt for repair;
//   atomic: true                 the writer appends ctx.appliedStatements() to its own batch (the rule for every writer that can; the separate mark is the weaker path).
// An operation registers with `atomic:true` or not at all, unless it carries a named `exception` {id, review, proof, ownerAcceptance} whose id is approved (`approved` is a test seam; production
// callers never pass it, so only APPROVED_EXCEPTIONS counts). Anything else is refused with `receipt_atomic_required`.
export function exceptionOf(spec,approved=APPROVED_EXCEPTIONS){
 if(spec?.atomic===true)return null;
 const exception=spec?.exception;
 const named=exception&&typeof exception==='object'&&[exception.id,exception.review,exception.proof,exception.ownerAcceptance].every(value=>typeof value==='string'&&value.length>=3);
 if(!named||!approved.includes(exception.id))throw failed('receipt_atomic_required');
 return Object.freeze({id:exception.id,review:exception.review,proof:exception.proof,ownerAcceptance:exception.ownerAcceptance});
}
export function defineOperation(spec,{approved=APPROVED_EXCEPTIONS}={}){
 if(!OPERATION_KINDS.includes(spec?.operation)||typeof spec.readback!=='function'||typeof spec.replay!=='function'||(spec.revalidate!==undefined&&typeof spec.revalidate!=='function'))throw failed('film_person_invalid');
 const exception=exceptionOf(spec,approved);
 return Object.freeze({operation:spec.operation,readback:spec.readback,replay:spec.replay,revalidate:spec.revalidate,atomic:spec.atomic===true,exception});
}
export function operationRegistry(specs=[],{approved=APPROVED_EXCEPTIONS}={}){
 const map=new Map();
 for(const spec of specs){
  if(map.has(spec.operation))throw failed('film_person_invalid');
  if(spec.atomic!==true&&!spec.exception)throw failed('receipt_atomic_required');
  if(spec.atomic!==true)exceptionOf(spec,approved);
  map.set(spec.operation,spec);
 }
 return map;
}

// ---- storage ----

// `no_schema` (schema below 19, or the table absent), `no_baseline` (schema 19 but the activation baseline is not recorded) or `ready`.
export async function receiptsStatus(env){
 const db=database(env);
 if(!db)return 'no_schema';
 try{
  const row=await one(db,"SELECT (SELECT version FROM schema_contract WHERE id=1) AS version,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_write_receipt') AS present,(SELECT COUNT(*) FROM canonical_receipt_watermark) AS baseline");
  if(!(Number(row?.version)>=RECEIPT_MIN_VERSION&&Number(row?.present)===1))return 'no_schema';
  return Number(row?.baseline)===1?'ready':'no_baseline';
 }catch{return 'no_schema';}
}
export async function receiptsAvailable(env){return (await receiptsStatus(env))!=='no_schema';}
// A producer must refuse to write canonical while this throws: without a receipt table the absence of a record proves nothing.
export async function assertReceiptsAvailable(env){if((await receiptsStatus(env))==='no_schema')throw failed('receipt_schema_missing');}
// ... and while the activation baseline is not recorded: no receipt may exist before it, and no change could be told from a pre-receipt one.
async function assertReceiptsReady(env){
 const status=await receiptsStatus(env);
 if(status==='no_schema')throw failed('receipt_schema_missing');
 if(status==='no_baseline')throw failed('receipt_baseline_missing');
}

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

async function currentRevisionOf(env,target){
 return Number((await one(database(env),'SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0) AS revision',[target.kind,target.id]))?.revision??0);
}

// Verifies the activation baseline READ-ONLY: recomputes, from the baseline rows, the per-kind count, highest revision and digest and compares them with what the watermark proved at the boundary,
// checks the entries total, that the boundary generation is not ahead of the marker, and that no entity regressed below its baseline revision. {ok, reasons:[...]}; never throws for a bad baseline.
export async function verifyBaseline(env){
 const db=database(env);
 const reasons=[];
 const mark=await one(db,'SELECT marker_generation,entries,film_count,film_max_revision,film_digest,person_count,person_max_revision,person_digest FROM canonical_receipt_watermark WHERE id=1');
 if(!mark)return {ok:false,reasons:['watermark_missing']};
 const rows=await many(db,'SELECT kind,id,revision FROM canonical_receipt_baseline ORDER BY kind,id LIMIT ?',[BASELINE_CAP+1]);
 if(rows.length>BASELINE_CAP)reasons.push('baseline_oversized');
 else{
  const proof=await proofOf(rows);
  if(Number(mark.entries)!==rows.length)reasons.push('entries_mismatch');
  for(const kind of ['film','person']){
   if(Number(mark[kind+'_count'])!==proof[kind].count)reasons.push('count_mismatch:'+kind);
   if(Number(mark[kind+'_max_revision'])!==proof[kind].max)reasons.push('max_mismatch:'+kind);
   if(mark[kind+'_digest']!==proof[kind].digest)reasons.push('digest_mismatch:'+kind);
  }
 }
 let live=null;
 try{live=await readAuthority(env);}catch{reasons.push('marker_unreadable');}
 if(live&&Number(mark.marker_generation)>live.generation)reasons.push('generation_ahead');
 const regressed=await one(db,'SELECT COUNT(*) AS n FROM canonical_receipt_baseline b WHERE NOT EXISTS (SELECT 1 FROM canonical_revision r WHERE r.kind=b.kind AND r.id=b.id AND r.revision>=b.revision)');
 if(Number(regressed?.n??0)>0)reasons.push('revision_regressed');
 return {ok:reasons.length===0,reasons};
}

// Observed canonical changes ABOVE their activation baseline with no applied receipt for their current revision, bounded, and the count of revisions that predate receipts. The baseline is verified
// first: a baseline that does not verify makes the answer non-clean (`safe` false, `baseline.ok` false) whatever else it says. A revision above the baseline without an applied receipt is
// `unreceipted`: a post-boundary mutation cannot read clean without a genuine receipt, and no receipt is ever fabricated for history.
export async function readUnreceipted(env,{limit=100}={}){
 await assertReceiptsReady(env);
 const db=database(env);
 const cap=Math.min(Math.max(Number(limit)||1,1),500);
 const baseline=await verifyBaseline(env);
 const rows=await many(db,"SELECT r.kind AS kind,r.id AS id,r.revision AS revision,EXISTS (SELECT 1 FROM canonical_write_receipt o WHERE o.target_kind=r.kind AND o.target_id=r.id AND o.state IN ('pending','failed','unknown')) AS has_open FROM canonical_revision r LEFT JOIN canonical_receipt_baseline b ON b.kind=r.kind AND b.id=r.id WHERE r.revision>COALESCE(b.revision,0) AND NOT EXISTS (SELECT 1 FROM canonical_write_receipt w WHERE w.target_kind=r.kind AND w.target_id=r.id AND w.applied_revision=r.revision) ORDER BY r.kind,r.id LIMIT ?",[cap]);
 const pseudo=rows.filter(row=>Number(row.has_open)===1).map(row=>({target:{kind:row.kind,id:row.id},state:'pending',appliedRevision:null}));
 const below=await one(db,'SELECT COUNT(*) AS n FROM canonical_revision r JOIN canonical_receipt_baseline b ON b.kind=r.kind AND b.id=r.id WHERE r.revision<=b.revision');
 const changes=unreceiptedChanges({changes:rows,receipts:pseudo});
 return {...changes,preReceiptBaselineCount:Number(below?.n??0),baseline,safe:changes.safe&&baseline.ok};
}

// Receipts that need a person: every `abandoned` receipt (never silently discarded), every `unknown` one, with the reason class. `needs_review` marks the classes that say a human must look
// (content match without proof, an atomic writer that did not apply its receipt, a stale revision, a superseded one). Read-only and bounded; there is no cleanup of any kind.
const REVIEW_CLASSES=new Set(['content_match_unproven','atomic_mark_missing','stale_revision_needs_repair','superseded_by_newer_revision']);
export async function listAttention(env,{limit=100}={}){
 await assertReceiptsAvailable(env);
 const cap=Math.min(Math.max(Number(limit)||1,1),500);
 const rows=(await many(database(env),"SELECT "+COLUMNS+" FROM canonical_write_receipt WHERE state IN ('abandoned','unknown') ORDER BY updated_at DESC,request_id LIMIT ?",[cap])).map(view);
 return rows.map(row=>({...row,needsReview:REVIEW_CLASSES.has(row.errorClass)}));
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
  if(/UNIQUE constraint failed: canonical_receipt_watermark/i.test(message))throw failed('receipt_baseline_exists',error);
  if(/UNIQUE constraint failed: canonical_write_receipt/i.test(message))throw failed('receipt_exists',error);
  const trigger=/canonical_receipt_([a-z_]+)/.exec(message);
  if(trigger)throw failed('canonical_receipt_'+trigger[1],error);
  if(/CHECK constraint failed/i.test(message)){
   let again;
   try{again=await readAuthority(env);}catch{throw failed('film_person_unavailable',error);}
   if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_fence',error);
   throw failed('receipt_state_conflict',error);
  }
  throw failed('film_person_unavailable',error);
 }
}

// The per-kind proof of a set of (kind, id, revision) rows: count, highest revision, and the SHA-256 of the ordered (id, revision) pairs (the same function records and verifies it).
async function proofOf(rows){
 const out={film:{count:0,max:0,sum:0,digest:null},person:{count:0,max:0,sum:0,digest:null}};
 for(const kind of ['film','person']){
  const list=rows.filter(row=>row.kind===kind).sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0).map(row=>[row.id,Number(row.revision)]);
  out[kind]={count:list.length,max:list.reduce((m,[,r])=>Math.max(m,r),0),sum:list.reduce((t,[,r])=>t+r,0),digest:await digestOf(list)};
 }
 return out;
}
// The activation baseline: ONE fenced batch that records the watermark row (the boundary proof: marker generation, and per kind the count, highest revision and digest) and copies every canonical_revision
// row. WHO RECORDS IT: the activation operation of the owner-authorized `open` flip, under the same lease and window, once. HOW IT IS PROVEN: the rows are read, their proof is computed here, and the batch
// starts by asserting in SQL that canonical_revision still has exactly that count, highest revision and revision sum per kind (and the marker the generation read), so a revision written in between fails
// the whole batch; `verifyBaseline` later recomputes the proof read-only. It is insert-only, refused once a baseline exists, while the marker is not `open`, and above BASELINE_CAP rows. It never creates a
// receipt: the revisions it covers are `pre_receipt_baseline`, not retrospectively receipted.
export async function recordBaseline(env,{now=()=>new Date().toISOString(),cap=BASELINE_CAP}={}){
 await assertReceiptsAvailable(env);
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 const rows=await many(db,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id LIMIT ?',[cap+1]);
 if(rows.length>cap)throw failed('film_person_bounded');
 const proof=await proofOf(rows);
 const at=typeof now==='function'?now():now;
 const same=kind=>"(SELECT COUNT(*) FROM canonical_revision WHERE kind='"+kind+"')=? AND COALESCE((SELECT MAX(revision) FROM canonical_revision WHERE kind='"+kind+"'),0)=? AND COALESCE((SELECT SUM(revision) FROM canonical_revision WHERE kind='"+kind+"'),0)=?";
 await writeBatch(env,gate,[
  [fenced.assertSql(same('film')+' AND '+same('person')),[proof.film.count,proof.film.max,proof.film.sum,proof.person.count,proof.person.max,proof.person.sum]],
  ['INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,film_digest,person_count,person_max_revision,person_digest,taken_at) VALUES (1,?,?,?,?,?,?,?,?,?)',[gate.generation,rows.length,proof.film.count,proof.film.max,proof.film.digest,proof.person.count,proof.person.max,proof.person.digest,at]],
  ['INSERT INTO canonical_receipt_baseline (kind,id,revision) SELECT kind,id,revision FROM canonical_revision',[]],
 ]);
 return {entries:rows.length,generation:gate.generation,takenAt:at,film:{count:proof.film.count,max:proof.film.max,digest:proof.film.digest},person:{count:proof.person.count,max:proof.person.max,digest:proof.person.digest}};
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
// mark leaves the receipt `pending`, which reconciliation treats as unknown). With `atomic`, the writer must have applied the receipt in its own batch: this function never marks it applied.
async function finishAttempt(env,{gate,row,attempt,run,clock,policy,atomic=false,currentRevision}){
 let result;
 try{
  result=await run({gate,requestId:row.requestId,attempt,target:row.target,currentRevision,appliedStatements:()=>appliedStatements({requestId:row.requestId,attempt,target:row.target,now:clock()})});
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
 if(atomic){
  try{const now=clock();await transition(env,gate,{...row,state:'pending',attempts:attempt},{kind:'failed',state:'unknown',errorClass:'atomic_mark_missing',nextAttemptAt:plus(now,backoffMs(attempt,policy))},now);}catch{/* stays pending */}
  return {ran:true,state:'unknown',result,needsReview:true,errorClass:'atomic_mark_missing'};
 }
 let revision=Number.isInteger(result?.revision)&&result.revision>=0?result.revision:null;
 try{
  if(revision===null)revision=await currentRevisionOf(env,row.target);
  await transition(env,gate,{...row,state:'pending',attempts:attempt},{kind:'applied',revision},clock());
 }catch{return {ran:true,state:'pending',result,markFailed:true};}
 return {ran:true,state:'applied',result};
}

// Applies one planned action to a due receipt. A `replay` first reads the CURRENT revision: unchanged since planning, the retry proceeds; moved by an unrelated writer, it proceeds only when the
// operation's `revalidate` says so (the writer re-checked its preconditions), otherwise the receipt is abandoned for repair or as superseded. Returns {state,...} or {retry:{currentRevision}}.
async function applyAction(env,gate,row,action,{revalidate,observed,clock,policy}){
 const now=clock();
 if(action.action==='mark_applied'){await transition(env,gate,row,{kind:'applied',revision:action.revision},now);return {state:'applied',settled:'readback'};}
 if(action.action==='needs_review'){await transition(env,gate,row,{kind:'abandoned',errorClass:action.reason},now);return {state:'abandoned',reason:action.reason,needsReview:true};}
 if(action.action==='abandon'){await transition(env,gate,row,{kind:'abandoned',errorClass:action.reason},now);return {state:'abandoned',reason:action.reason};}
 const currentRevision=await currentRevisionOf(env,row.target);
 if(currentRevision!==row.plannedRevision){
  const verdict=typeof revalidate==='function'?await revalidate(env,row,{currentRevision,observed}):'stale';
  if(verdict!=='proceed'){
   const reason=verdict==='superseded'?'superseded_by_newer_revision':'stale_revision_needs_repair';
   await transition(env,gate,row,{kind:'abandoned',errorClass:reason},now);
   return {state:'abandoned',reason};
  }
 }
 await transition(env,gate,row,{kind:'retry',plannedRevision:currentRevision,nextAttemptAt:plus(now,policy.attemptWindowMs)},now);
 return {retry:{currentRevision}};
}

// ONE cross-domain write with its durable receipt. input: {requestId,operation,origin,target:{kind,id},expectedRevision,digest,now?,policy?}. hooks: {run,readback,revalidate?,atomic?}.
//   run({gate,requestId,attempt,target,currentRevision,appliedStatements}) -> {revision?}  the writer's fenced commit (with `atomic`, it appends appliedStatements() to its own batch);
//   readback(env,target,receipt) -> {digest,revision,proof?}|null                         the same readback an operation registers for reconciliation;
//   revalidate(env,receipt,{currentRevision,observed}) -> 'proceed'|'superseded'          needed to retry after another writer advanced the entity revision.
// A new request id records `pending` first and then runs. An existing id never runs while its attempt is in flight or backing off; once due it is first settled from the readback (applied only on
// proof of this request, content alone is `needs_review`), and only if the planned effect is absent is it retried (bounded, revalidated against the current revision) with the same id. A different
// operation, target or content under an id is `receipt_conflict`. A run error is rethrown after the receipt is marked. Needs the schema AND the activation baseline.
export async function receiptedWrite(env,input,hooks){
 const request=normalizeRequest(input);
 // Atomic mode is the only mode unless the hooks carry an approved named exception (see APPROVED_EXCEPTIONS); this is checked before anything is read or written.
 const atomic=hooks?.atomic===true;
 if(!atomic)exceptionOf({exception:hooks?.exception},hooks?.approvedExceptions||APPROVED_EXCEPTIONS);
 const policy=input.policy||RETRY_POLICY,clock=input.now||(()=>new Date().toISOString());
 const status=await receiptsStatus(env);
 if(status==='no_schema')throw failed('receipt_schema_missing');
 const gate=assertWritable(await readAuthority(env));
 if(status==='no_baseline')throw failed('receipt_baseline_missing');
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
 let attempt=row.attempts,currentRevision=request.expectedRevision;
 if(!created){
  const now=clock();
  const due=reconcilePlan({receipts:[row],observed:{},marker:gate,now,policy});
  if(due.waiting.length)return {ran:false,state:row.state,reason:due.waiting[0].reason,nextAttemptAt:row.nextAttemptAt,receipt:row};
  if(typeof hooks?.readback!=='function')throw failed('receipt_readback_required');
  const observed=(await hooks.readback(env,row.target,row))??null;
  const action=reconcilePlan({receipts:[row],observed:{[row.requestId]:observed},marker:gate,now,policy}).actions[0];
  const outcome=await applyAction(env,gate,row,action,{revalidate:hooks.revalidate,observed,clock,policy});
  if(!outcome.retry)return {ran:false,...outcome};
  attempt=row.attempts+1;currentRevision=outcome.retry.currentRevision;
 }
 const outcome=await finishAttempt(env,{gate,row,attempt,run:hooks.run,clock,policy,atomic,currentRevision});
 if(outcome.error)throw outcome.error;
 return {...outcome,attempt};
}

// The reconciler's one pass (a later P3 reconciler calls this; nothing calls it today and nothing schedules it): reads at most `limit` DUE non-terminal receipts, reads each target through its
// registered operation, applies the pure plan (mark applied on proof, needs review, abandon, replay with the same request id after the stale-revision check) and returns what it did. `now` is
// passed in; there is no timer.
export async function reconcileReceipts(env,{operations,now=()=>new Date().toISOString(),limit=20,policy=RETRY_POLICY}={}){
 await assertReceiptsAvailable(env);
 const clock=typeof now==='function'?now:()=>now;
 const at=clock();
 const gate=await readAuthority(env);
 const due=await listReceipts(env,{dueBefore:at,limit});
 const result={marker:gate.state,considered:due.length,applied:[],replayed:[],abandoned:[],needsReview:[],waiting:[],failed:[]};
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
  const operation=operations.get(row.operation);
  try{
   const outcome=await applyAction(env,gate,row,action,{revalidate:operation.revalidate,observed:observed[row.requestId],clock,policy});
   if(outcome.retry){
    const run=ctx=>operation.replay(env,row,ctx);
    const finished=await finishAttempt(env,{gate,row,attempt:row.attempts+1,run,clock,policy,atomic:operation.atomic,currentRevision:outcome.retry.currentRevision});
    if(finished.state==='applied')result.replayed.push(row.requestId);
    else result.failed.push({requestId:row.requestId,outcome:finished.outcome||finished.state,errorClass:finished.errorClass||null});
   }else if(outcome.needsReview)result.needsReview.push(row.requestId);
   else if(outcome.state==='applied')result.applied.push(row.requestId);
   else result.abandoned.push({requestId:row.requestId,reason:outcome.reason});
  }catch(error){result.failed.push({requestId:row.requestId,outcome:'unsettled',errorClass:errorClassOf(error)});}
 }
 result.waiting.push(...plan.waiting);
 result.attention=plan.attention;
 return result;
}
