// AIR-663 / ADR 0218 decision 3 and stage 4 (D1, Accepted). The SEPARATE, bounded reconciler of a stale effective Film localization row: a Film whose stored `localization` row is no
// longer the output of the existing resolver, with NO new source observation (a historical applied source receipt, an owner-only change in owner_review_entry, a legacy row).
// The MUTATION paths are DORMANT, like the other canonical writers: importing this module runs nothing and no Worker route, cron tick, Workflow or script calls them. AIR-683 bundles the module only
// so that the owner-only MCP tool `film_localization_diagnose` can call the READ-ONLY `diagnoseLocalizationCohort`; no MCP tool, route or Workflow reaches apply, resume, recover or restore. They
// reach the database only when an explicit caller (the production operation of AIR-664, under its own owner GO) invokes them, and only after assertWritable (marker d1/open).
// - Same resolver, same precedence: the output is projectionOf() of the projection writer (resolveLocalization unchanged: owner > reviewed > automatic, fixed source order, then the newer
//   observation, then the source name; the strong() guard and its SQL WHERE). No new source row is written except the lossless legacy candidate the projection writer already preserves.
// - Same two fences: the Film revision CAS and the owner-review token (marker generation, every consumed owner row, the redirect closure), re-proved INSIDE the batch.
// - Its own receipts: kind `film_localization_reconcile`, origin `localization_reconciler`, a FRESH request id per run and Film. It never replays, settles or reuses a historical
//   `localization_source` or `film_localization_projection` receipt (those stay terminal / settle under their own rules; equal content proves no causality).
// - Bounded: a per-run Films-examined limit (a keyset page of RAW Film ids, so the scan is bounded by the limit whatever the candidates) and a per-run write cap, one fenced batch per Film.
//   A dry run is read only: no receipt, no statement, no write.
// - INTENT (the pre-image contract). A receipt stores no payload, so the exact immutable per-Film intent is the pre-image: {id, runId, requestId, digest, at, plannedRevision, postRevision,
//   inputs, preImage, postImage}. An apply REQUIRES a durable `checkpoint` port from its caller and fails closed: `checkpoint.record(intent)` must resolve BEFORE the write is permitted (a throw
//   writes nothing), and `checkpoint.settle(intent, result)` is called after the write with the outcome (`applied`, `not_applied` or `unknown`). Every exit of a pass returns what it did
//   (written intents, uncertain intents, the failed Film, the resume cursor); nothing is lost to a later failure. The caller (AIR-664) chooses the storage; this module owns the contract.
//   An intent is immutable: the digest binds the full pre-image and post-image, the resolver inputs, the stable write time `at` and the planned revision, and the writer re-checks all of
//   them inside the batch. A reply lost after the commit is recovered from the recorded intent against the applied receipt and the revision (recoverLocalizationReconcile), never from a replan.
// - Restore applies an intent only after it is bound to its own applied receipt (same request id, digest, target and applied revision), the marker is open and the owner-review domain is
//   D1-authoritative, and only while the Film is at exactly postRevision with the row still equal to postImage; otherwise it refuses and writes nothing (`localization_restore_moved`).
//   It is not a general mutation API: a fabricated or incomplete token is refused before any receipt is reserved. The alternative is a forward correction through this same reconciler.
// Person localization is out of scope (unchanged). No table, index or column changes.
import {assertWritable,database,failed,many,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {canonicalJson,defineOperation,digestOf,readReceipt,receiptedWrite,requestIdOf} from './canonical-receipts.js';
import {PROJECTION_RESOLVER,PROJECTION_UPSERT,legacyCandidate,ownerTokenStatements,projectionInputs,projectionOf,readOwnerReviewToken} from './film-localization-projection.js';
import {LOCALIZATION_ROW,readFilmSnapshot} from './canonical-film-writers.js';

export const RECONCILE_OPERATION='film_localization_reconcile';
export const RECONCILE_ORIGIN='localization_reconciler';
// Films EXAMINED per run (each costs one snapshot read of 9 statements and the owner-review token reads) and Films WRITTEN per run (one fenced batch each). Both are hard caps.
export const RECONCILE_EXAMINE_DEFAULT=20;
export const RECONCILE_EXAMINE_MAX=50;
export const RECONCILE_WRITE_DEFAULT=10;
export const RECONCILE_WRITE_MAX=25;
export const RECONCILE_SOURCE_CHANGED='producer_source_changed';
export const RECONCILE_HELD='localization_reconcile_held';
export const RECONCILE_INTENT_REQUIRED='reconcile_intent_required';
export const RESTORE_MOVED='localization_restore_moved';
export const RESTORE_UNBOUND='localization_restore_unbound';
export const CHECKPOINT_FAILED='localization_checkpoint_failed';
const COLUMNS=['status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at'];
const DIM_PARAMS=['dimension',...COLUMNS];
const ROW=LOCALIZATION_ROW;
const DIGEST=/^[0-9a-f]{64}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
const imageOf=row=>row?Object.fromEntries(COLUMNS.map(name=>[name,row[name]??null])):null;
const imageOfParams=params=>Object.fromEntries(COLUMNS.map(name=>[name,params[DIM_PARAMS.indexOf(name)+1]??null]));
const sameImage=(a,b)=>canonicalJson(a??null)===canonicalJson(b??null);
// A complete, strictly shaped row image: every column present (null allowed), no other key. `null` itself is NOT an image here: callers say explicitly when an absent row is meant.
function completeImage(value){
 if(!plain(value))throw failed('film_person_invalid');
 const keys=Object.keys(value);
 if(keys.length!==COLUMNS.length||!COLUMNS.every(name=>own(value,name)))throw failed('film_person_invalid');
 for(const name of COLUMNS){const item=value[name];if(item!==null&&typeof item!=='string'&&!(typeof item==='number'&&Number.isFinite(item)))throw failed('film_person_invalid');}
 if(typeof value.status!=='string'||!value.status||typeof value.updated_at!=='string'||!value.updated_at)throw failed('film_person_invalid');
 return imageOf(value);
}
// A SQL boolean over film_dimension of ONE Film's localization row equal, column for column, to `image` (null-safe). `image === null` means the row is absent.
function imageCondition(image){
 if(image===null)return {sql:"NOT EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='localization')",params:id=>[id]};
 return {sql:"EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='localization' AND "+COLUMNS.map(name=>name+' IS ?').join(' AND ')+')',params:id=>[id,...COLUMNS.map(name=>image[name]??null)]};
}
const assertImage=(image,id)=>{const condition=imageCondition(image);return [fenced.assertSql(condition.sql),condition.params(id)];};

// PURE. The reconciliation decision for ONE Film from its stored rows and the owner-review token (no incoming source). `input.at` is the STABLE write time of the intent: it is the only
// clock the plan reads (the owner-projection fallback, the legacy source row), so the same inputs and `at` always give the same post-write row.
//   absent     no Film row, or a redirect: nothing to reconcile (never created, never repaired through a redirect);
//   noop       the stored row already is the resolver output (or there is nothing to project): no statement, no receipt;
//   held       the output cannot be produced under the strong() guard (conflicting owner values, a protected row of another value, an owner projection whose decision is gone and that has
//              no automatic source to replace it, a legacy candidate that cannot be recorded losslessly): nothing is written, no decision is manufactured;
//   write      the stored row is stale: statements, the pre-image and the intended post-write row.
export function planLocalizationReconcile(snapshot,token,input){
 const id=fenced.filmId(input?.id),at=fenced.text(input.at);
 if(!plain(token)||!Array.isArray(token.values))throw failed('film_person_invalid');
 if(snapshot.redirect||!snapshot.film)return {state:'absent',id,statements:[],changes:[]};
 const projection=projectionOf(snapshot,token,[],at,id);
 const preImage=imageOf(snapshot.dimensions.localization);
 const base={id,effective:projection.effective,preImage,statements:[],changes:[]};
 if(projection.kind==='match')return {...base,state:'noop'};
 if(projection.kind==='held')return {...base,state:'held',reason:projection.reason};
 const legacy=legacyCandidate(snapshot,new Set());
 if(legacy&&!legacy.lossless)return {...base,state:'held',reason:'legacy_candidate_not_preservable'};
 const statements=[],changes=[];
 if(legacy){statements.push([ROW.legacySourceInsert,[id,legacy.source,legacy.value,legacy.sourceVersion,legacy.provenance,input.requestId??'reconcile',legacy.observedAt,at]]);changes.push('source:'+legacy.source+':preserved');}
 const postImage=imageOfParams(projection.params);
 statements.push([PROJECTION_UPSERT,projection.params]);changes.push('dimension:localization');
 statements.push(assertImage(postImage,id));
 return {...base,state:'write',statements,changes,postImage,params:projection.params};
}

// The content a reconcile receipt binds: the Film, the resolver identity, the normalized resolver inputs (no incoming source), the FULL pre-image and post-write image, the stable write time
// and the planned revision. Any other input, image, time or revision is another digest and request identity: a moved state is replanned as a NEW intent, never replayed under the old one.
export function reconcileContent({id,inputs,preImage,postImage,at,plannedRevision}){
 if(typeof id!=='string'||!id.startsWith('film:')||!plain(inputs)||typeof at!=='string'||!Number.isInteger(plannedRevision))throw failed('film_person_invalid');
 return {kind:'film',action:'reconcile',resolver:PROJECTION_RESOLVER,inputs,preImage:preImage??null,postImage:postImage??null,at,plannedRevision};
}
export const reconcileDigest=input=>digestOf({operation:RECONCILE_OPERATION,id:input?.id,content:reconcileContent(input)});
// A fresh request id per run, Film, action and digest: the run id is the source event. It never equals a historical receipt's id, so a historical receipt is never replayed through this kind.
export async function reconcileRequestId({runId,action='reconcile',id,digest}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200||typeof id!=='string'||!DIGEST.test(digest||''))throw failed('film_person_invalid');
 return requestIdOf({origin:RECONCILE_ORIGIN,operation:RECONCILE_OPERATION,source:{runId,action,id,digest}});
}
// The restore receipt digest: the apply intent it undoes (by digest), the pre-image to put back, the image it removes and the exact revision it is bound to.
const restoreDigest=intent=>digestOf({operation:RECONCILE_OPERATION,id:intent.id,content:{kind:'film',action:'restore',applyRequestId:intent.requestId,applyDigest:intent.digest,preImage:intent.preImage,postImage:intent.postImage,postRevision:intent.postRevision}});

// Builds the immutable intent of ONE Film from a plan read at `at`. PURE over its arguments.
async function intentOf({runId,at,revision,inputs,plan}){
 const base={id:plan.id,inputs,preImage:plan.preImage,postImage:plan.postImage,at,plannedRevision:revision};
 const digest=await reconcileDigest(base);
 const requestId=await reconcileRequestId({runId,id:plan.id,digest});
 return {version:1,id:plan.id,runId,requestId,digest,at,plannedRevision:revision,postRevision:revision+1,inputs,preImage:plan.preImage,postImage:plan.postImage};
}
// Validates an intent supplied by a caller (a checkpoint read back, a restore token): strict shape, an EXPLICIT preImage (null or a complete image), a complete postImage, and a digest and
// request id that recompute from the content. A missing field is never read as null; nothing here reads the database.
export async function checkIntent(value){
 if(!plain(value)||value.version!==1||typeof value.id!=='string'||!/^film:.+/.test(value.id)||typeof value.runId!=='string'||!value.runId.trim()||typeof value.requestId!=='string'||!DIGEST.test(value.digest||''))throw failed('film_person_invalid');
 if(typeof value.at!=='string'||!ISO.test(value.at)||!Number.isInteger(value.plannedRevision)||value.plannedRevision<0||value.postRevision!==value.plannedRevision+1||!plain(value.inputs)||!own(value,'preImage'))throw failed('film_person_invalid');
 const preImage=value.preImage===null?null:completeImage(value.preImage),postImage=completeImage(value.postImage);
 const intent={version:1,id:value.id,runId:value.runId,requestId:value.requestId,digest:value.digest,at:value.at,plannedRevision:value.plannedRevision,postRevision:value.postRevision,inputs:value.inputs,preImage,postImage};
 const digest=await reconcileDigest(intent);
 if(digest!==intent.digest||await reconcileRequestId({runId:intent.runId,id:intent.id,digest})!==intent.requestId)throw failed('film_person_invalid');
 return intent;
}

// Read only. The plan of ONE Film against D1 NOW: {plan, inputs, token, revision}. `at` is the stable time the plan (and a resulting intent) will carry.
export async function readReconcilePlan(env,id,{at=new Date().toISOString(),requestId}={}){
 const snapshot=await readFilmSnapshot(env,id);
 if(snapshot.redirect||!snapshot.film)return {plan:{state:'absent',id,statements:[],changes:[]},inputs:null,revision:snapshot.revision};
 const token=await readOwnerReviewToken(env,id);
 const plan=planLocalizationReconcile(snapshot,token,{id,at,requestId});
 return {plan,inputs:projectionInputs(snapshot,token,[]),token,snapshot,revision:snapshot.revision};
}

// Read only. The immutable intent of ONE Film against D1 NOW, or null when nothing is to be written ({plan} says why). The apply builds its intents this way.
export async function readReconcileIntent(env,id,{runId,at=new Date().toISOString()}={}){
 const {plan,inputs,revision}=await readReconcilePlan(env,id,{at});
 if(plan.state!=='write')return {intent:null,plan};
 return {intent:await intentOf({runId,at,revision,inputs,plan}),plan};
}

// The fenced reconcile write of ONE Film FROM ITS INTENT. input: {intent, receiptMark?}. It never trusts a fresh plan over the intent: the stored Film must still be at the intent's planned
// revision, its stored resolver inputs and full pre-image row must equal the intent's, and a plan at the intent's `at` must reproduce the intent's post-write row exactly, otherwise nothing is
// written (`localization_inputs_moved`, `film_person_revision_conflict`). The batch re-asserts the intent's own pre-image, the owner-review token and the revision CAS. A named refusal
// `localization_owner_moved` (the owner token was lost between plan and commit) is retryable by a NEW intent. `held` writes nothing and opens no batch.
// Returns {written, revision, postRevision, preImage, postImage}: the images of the INTENT, which the batch has just proved are the stored ones.
async function writeFilmLocalizationReconcile(env,{intent: given,receiptMark}={}){
 // PRIVATE: reachable only through the checkpointed, receipted path. A call without the receipt mark of its own pending receipt writes nothing.
 if(receiptMark===undefined||receiptMark===null)throw failed('film_person_invalid');
 const intent=await checkIntent(given);
 const id=intent.id,expected=intent.plannedRevision;
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const snapshot=await readFilmSnapshot(env,id);
 if(snapshot.redirect)throw failed('film_person_redirect');
 if(!snapshot.film)throw failed('film_person_precondition');
 if(snapshot.revision!==expected)throw failed('film_person_revision_conflict');
 const token=await readOwnerReviewToken(env,id);
 if(canonicalJson(projectionInputs(snapshot,token,[]))!==canonicalJson(intent.inputs)||!sameImage(imageOf(snapshot.dimensions.localization),intent.preImage))throw failed('localization_inputs_moved');
 const plan=planLocalizationReconcile(snapshot,token,{id,at:intent.at,requestId:intent.requestId});
 if(plan.state==='held')return {id,revision:snapshot.revision,written:false,held:true,reason:plan.reason,effective:plan.effective};
 if(plan.state!=='write'||!sameImage(plan.postImage,intent.postImage))throw failed('localization_inputs_moved');
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(...ownerTokenStatements(token));
 // The pre-image of the INTENT is asserted INSIDE the batch: the row the intent recorded is the row the write replaces.
 statements.push(assertImage(intent.preImage,id));
 statements.push(...plan.statements);
 statements.push([fenced.BUMP,['film',id,intent.at]]);
 if(statements.length>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  if(error?.code==='film_person_precondition'){
   let again=null;
   try{again=await readOwnerReviewToken(env,id);}catch{throw failed('localization_owner_moved',error);}
   if(again.digest!==token.digest)throw failed('localization_owner_moved',error);
  }
  throw error;
 }
 return {id,revision:intent.postRevision,written:true,changes:plan.changes,effective:plan.effective,preImage:intent.preImage,postImage:intent.postImage,postRevision:intent.postRevision};
}

// The receipt hooks bound to ONE intent (never to a replan): the readback proves nothing from content alone, the revalidation proceeds only while the Film is still exactly where the intent
// planned it (planned revision and pre-image row), and the run is the intent's own fenced write.
function intentHooks(env,intent,clock){
 const state=async()=>{const snapshot=await readFilmSnapshot(env,intent.id);return {revision:snapshot.revision,image:imageOf(snapshot.dimensions.localization)};};
 return {
  atomic:true,
  readback:async()=>{
   const now=await state();
   // The post-write state without an applied receipt of this request: equal content proves no causality (another writer may have reached it): `needs_review`, never applied.
   if(now.revision===intent.postRevision&&sameImage(now.image,intent.postImage))return {digest:intent.digest};
   if(now.revision===intent.plannedRevision&&sameImage(now.image,intent.preImage))return {digest:null,revision:now.revision};
   return {disposition:'abandon',errorClass:RECONCILE_SOURCE_CHANGED};
  },
  revalidate:async()=>{const now=await state();return now.revision===intent.plannedRevision&&sameImage(now.image,intent.preImage)?'proceed':'stale';},
  run:ctx=>writeFilmLocalizationReconcile(env,{intent,receiptMark:mark(ctx,clock)}),
 };
}
// ONE receipted, atomic, fenced write of an intent (a fresh apply or a resume of a recorded one: the same request id never double-writes, an applied receipt returns as applied).
async function writeIntent(env,intent,{clock,policy}){
 return receiptedWrite(env,{requestId:intent.requestId,operation:RECONCILE_OPERATION,origin:RECONCILE_ORIGIN,target:{kind:'film',id:intent.id},expectedRevision:intent.plannedRevision,digest:intent.digest,now:clock,policy},intentHooks(env,intent,clock));
}
const appliedOf=(outcome,intent)=>outcome?.state==='applied'&&outcome.receipt?.appliedRevision===intent.postRevision&&outcome.receipt?.contentDigest===intent.digest;

// The registry spec of the kind, for reconcileReceipts. A receipt stores no payload and the pre-image lives only in the intent, so the registry can neither re-plan nor replay: an unsettled
// receipt is abandoned (`reconcile_intent_required`; with the atomic tail a non-applied receipt has no committed effect) and the operation settles its intent through
// recoverLocalizationReconcile / resumeLocalizationReconcile.
export function filmLocalizationReconcileOperation(){
 return defineOperation({
  operation:RECONCILE_OPERATION,atomic:true,
  readback:async()=>({disposition:'abandon',errorClass:RECONCILE_INTENT_REQUIRED}),
  replay:async()=>{throw failed('producer_replan_unavailable');},
  revalidate:async()=>'stale',
 });
}

// RECOVERY: settles a recorded intent against the actual applied receipt and the revision, including an unknown outcome (a lost reply). Read only. States:
//   applied      the receipt of this request id is applied at exactly postRevision with the intent's digest: the intent is the pre-image token of an effect that exists;
//   not_applied  no applied receipt and the Film is still at the planned revision with the intent's pre-image row: safe to resume the same intent;
//   unknown      anything else (a post-write row without an applied receipt, a moved Film): never guessed, never written, for review.
export async function recoverLocalizationReconcile(env,{intent: given}={}){
 const intent=await checkIntent(given);
 const receipt=await readReceipt(env,intent.requestId);
 const snapshot=await readFilmSnapshot(env,intent.id);
 const image=imageOf(snapshot.dimensions.localization);
 if(receipt&&(receipt.operation!==RECONCILE_OPERATION||receipt.origin!==RECONCILE_ORIGIN||receipt.target.kind!=='film'||receipt.target.id!==intent.id||receipt.contentDigest!==intent.digest))return {state:'unknown',reason:'receipt_mismatch',revision:snapshot.revision};
 if(receipt?.state==='applied'&&receipt.appliedRevision===intent.postRevision)return {state:'applied',revision:snapshot.revision,rowIsPostImage:snapshot.revision===intent.postRevision&&sameImage(image,intent.postImage),intent};
 if(receipt?.state!=='applied'&&snapshot.revision===intent.plannedRevision&&sameImage(image,intent.preImage))return {state:'not_applied',revision:snapshot.revision,receiptState:receipt?.state??null};
 return {state:'unknown',reason:receipt?.state==='applied'?'applied_revision_mismatch':'moved',revision:snapshot.revision};
}
// The ONE checkpointed commit of an intent, shared by the apply and the resume: the receipted, atomic, fenced write under the intent's request id, then the durable settlement of the outcome.
// Returns {state:'applied'|'not_applied'|'unknown', errorClass, settleError}. `not_applied` is a definite replan refusal (the batch rolled back whole); anything else that is not an applied
// receipt is `unknown`, never guessed. A failed durable settlement is reported (`settleError`), never swallowed: the caller stops and does not treat the Film as complete.
const REPLAN=new Set(['localization_inputs_moved','localization_owner_moved','film_person_revision_conflict']);
async function commitIntent(env,port,intent,{clock,policy}){
 let state,errorClass=null,receiptState=null;
 try{
  const outcome=await writeIntent(env,intent,{clock,policy});
  if(appliedOf(outcome,intent))state='applied';
  else{state='unknown';errorClass=outcome?.errorClass||outcome?.reason||outcome?.state||'unclassified';receiptState=outcome?.state??null;}
 }catch(error){errorClass=error?.code||'unclassified';state=REPLAN.has(errorClass)?'not_applied':'unknown';}
 let settleError=null;
 try{await port.settle(intent,{state,errorClass,receiptState,...(state==='applied'?{revision:intent.postRevision}:{})});}catch(error){settleError=error?.code||'localization_checkpoint_settle_failed';}
 return {state,errorClass,settleError};
}
const portOf=checkpoint=>{
 if(!plain(checkpoint)||typeof checkpoint.record!=='function'||typeof checkpoint.settle!=='function')throw failed('film_person_invalid');
 return checkpoint;
};
// Resumes a recorded intent that recovery found `not_applied` (or re-issues an applied one harmlessly). It needs the SAME durable checkpoint port as the apply: the exact intent is recorded
// (idempotently) BEFORE the write is permitted, a refusal writes nothing (`localization_checkpoint_failed`), and the outcome is settled afterwards. The same request id and digest mean a
// committed effect is never written twice. Returns {state, errorClass, settleError, intent}; a lost reply is `unknown` with the intent, recoverable like any other.
export async function resumeLocalizationReconcile(env,{intent: given,checkpoint,now,policy}={}){
 const port=portOf(checkpoint);
 const intent=await checkIntent(given),clock=clockOf(now);
 try{await port.record(intent);}catch(error){throw failed(CHECKPOINT_FAILED,error);}
 return {...await commitIntent(env,port,intent,{clock,policy}),intent};
}

const clampCap=(value,fallback,max)=>{
 if(value===undefined||value===null)return fallback;
 if(!Number.isInteger(value)||value<1||value>max)throw failed('film_person_invalid');
 return value;
};
const cursorOf=value=>{if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||!value.startsWith('film:'))throw failed('film_person_invalid');return value;};
// One keyset page of RAW Film ids in id order (limit + 1 to learn whether more follow). The scan is bounded by `limit` whatever the candidates are; classification (candidate or not, redirect,
// owner entries linked to a merged ancestor) is the ancestry-aware reader's job per Film, never an SQL guess here. No new index is needed (the primary key of film).
async function filmPage(env,{after,limit}){
 try{return (await many(database(env),'SELECT id FROM film WHERE id>? ORDER BY id LIMIT ?',[after,limit+1])).map(row=>row.id);}
 catch(error){throw failed('film_person_unavailable',error);}
}

// DRY RUN: read only. No receipt, no statement, no write; it never reads a state it cannot prove (a Film whose owner evidence is unavailable is `unavailable` with the code). Returns
// {examined, cursor, hasMore, stale:[{id,revision,effective,preImage,postImage,changes}], held:[{id,reason}], noop, absent, unavailable:[{id,code}], wouldWrite}. `cursor` is the last examined id: pass it as
// `after` for the next page. `wouldWrite` is capped by `writeCap`. A dry-run entry is a report, NOT a pre-image: only an apply intent is.
export async function dryRunLocalizationReconcile(env,{after,limit,writeCap,now}={}){
 const examineCap=clampCap(limit,RECONCILE_EXAMINE_DEFAULT,RECONCILE_EXAMINE_MAX),writes=clampCap(writeCap,RECONCILE_WRITE_DEFAULT,RECONCILE_WRITE_MAX);
 const clock=clockOf(now),start=cursorOf(after);
 await readAuthority(env);
 const page=await filmPage(env,{after:start,limit:examineCap});
 const ids=page.slice(0,examineCap),out={examined:0,cursor:ids.length?ids.at(-1):start,hasMore:page.length>examineCap,stale:[],held:[],noop:0,absent:0,unavailable:[],wouldWrite:0};
 for(const id of ids){
  out.examined++;
  try{
   const {plan,revision}=await readReconcilePlan(env,id,{at:clock()});
   if(plan.state==='write'){out.stale.push({id,revision,effective:plan.effective,preImage:plan.preImage,postImage:plan.postImage,changes:plan.changes});if(out.wouldWrite<writes)out.wouldWrite++;}
   else if(plan.state==='held')out.held.push({id,reason:plan.reason});
   else if(plan.state==='absent')out.absent++;
   else out.noop++;
  }catch(error){
   if(!error?.code||error.code==='film_person_unavailable'&&!error.cause)throw error;
   out.unavailable.push({id,code:error.code});
  }
 }
 return out;
}

// DIAGNOSE (AIR-683): the read-only census of the live cohort, built ON the dry run (the resolver and planner of AIR-663 stay the oracle; no SQL guess of an effective value). It walks the
// keyset pages of raw Film ids by itself until the table is exhausted or the wall-time budget of this call is spent, and returns AGGREGATES only (counts, reasons, error codes and bounded id
// lists; never a stored row, an image or a value). It records nothing, opens no receipt and writes nothing. The page size is the dry run's technical parameter, not a limit of the contract.
// `complete` is true only when the last page reported no continuation and no page failed; anything else leaves `cursor` (the last examined Film) as the resume point. A Film that moved while the
// walk ran is observed at the time its page was read: this is a census of observations, not a global snapshot. `zeroEligible` is claimed only for a complete, fully classified walk
// (no unavailable Film) whose authority pin did not move; otherwise it is false and the caller must treat the cohort as unknown.
export const DIAGNOSE_BUDGET_DEFAULT_MS=20000;
export const DIAGNOSE_BUDGET_MAX_MS=25000;
export const DIAGNOSE_IDS_MAX=200;
// The REAL per-invocation limit behind the continuation: every D1 statement of a Worker invocation is a subrequest (Workers Paid: 10,000 per invocation), and the planner needs about 12 statements per
// Film (measured on the fixtures: tests/film-localization-reconciler.mjs section 14, about 12.1 for 121 Films). 500 Films is about 6,100 statements: inside the limit with headroom for Films that
// have many owner entries or merged ancestors. It is a technical bound of ONE call, not a product limit; the caller continues from `cursor` until `complete`.
export const DIAGNOSE_FILMS_MAX=500;
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};
export async function diagnoseLocalizationCohort(env,{after,budgetMs,filmsMax,now,clock=Date.now}={}){
 if(budgetMs!==undefined&&(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>DIAGNOSE_BUDGET_MAX_MS))throw failed('film_person_invalid');
 if(filmsMax!==undefined&&(!Number.isInteger(filmsMax)||filmsMax<1||filmsMax>DIAGNOSE_FILMS_MAX))throw failed('film_person_invalid');
 const films=filmsMax??DIAGNOSE_FILMS_MAX;
 const budget=budgetMs??DIAGNOSE_BUDGET_DEFAULT_MS,started=clock(),startCursor=cursorOf(after);
 const first=await readAuthority(env);
 const out={complete:false,startedAfter:startCursor,cursor:startCursor,pages:0,examined:0,stale:0,noop:0,absent:0,held:0,heldByReason:{},unavailable:0,unavailableByCode:{},staleIds:[],unavailableIds:[],staleIdsTruncated:false,unavailableIdsTruncated:false,stopped:null,authority:{state:first.state,generation:first.generation,version:first.version,baseline:first.baseline},authorityStable:true,zeroEligible:false,elapsedMs:0};
 let cursor=startCursor;
 for(;;){
  if(out.examined>=films){out.stopped='subrequest_budget';break;}
  if(clock()-started>=budget){out.stopped='budget';break;}
  let page;
  try{page=await dryRunLocalizationReconcile(env,{after:cursor,limit:Math.min(RECONCILE_EXAMINE_MAX,films-out.examined),writeCap:1,now});}
  catch(error){out.stopped=error?.code||'film_person_unavailable';break;}
  out.pages++;out.examined+=page.examined;out.noop+=page.noop;out.absent+=page.absent;
  for(const item of page.stale){out.stale++;if(out.staleIds.length<DIAGNOSE_IDS_MAX)out.staleIds.push(item.id);else out.staleIdsTruncated=true;}
  for(const item of page.held){out.held++;bump(out.heldByReason,item.reason);}
  for(const item of page.unavailable){out.unavailable++;bump(out.unavailableByCode,item.code);if(out.unavailableIds.length<DIAGNOSE_IDS_MAX)out.unavailableIds.push(item.id);else out.unavailableIdsTruncated=true;}
  cursor=page.cursor;out.cursor=cursor;
  if(!page.hasMore){out.complete=true;break;}
 }
 try{
  const last=await readAuthority(env);
  out.authorityStable=last.state===first.state&&last.generation===first.generation&&last.version===first.version;
  out.authorityEnd={state:last.state,generation:last.generation,version:last.version};
 }catch{out.authorityStable=false;}
 out.zeroEligible=out.complete&&out.stale===0&&out.unavailable===0&&out.authorityStable;
 out.elapsedMs=clock()-started;
 return out;
}

// APPLY: one bounded pass. input: {runId, checkpoint:{record(intent), settle(intent,result)}, after?, limit?, writeCap?, now?, policy?}. The checkpoint is REQUIRED (fail closed before anything is read
// for writing). For each examined Film: a noop, held or absent Film opens no receipt; a stale one becomes an immutable intent (the plan read once, at ONE stable `at`), `checkpoint.record(intent)`
// must resolve before the write is permitted (a throw stops the pass with nothing written for that Film), the write is ONE receipted, atomic, fenced batch under the intent's request id, and
// `checkpoint.settle(intent, {state:'applied'|'not_applied'|'unknown', ...})` records the outcome. The pass stops writing at `writeCap`; a replan refusal (`localization_inputs_moved`,
// `localization_owner_moved`, `film_person_revision_conflict`: definite not-applied) leaves the Film `moved` for the next run; any other error stops the pass.
// EVERY exit returns what it did and never throws after the first Film is touched: {examined, cursor (the last Film FULLY settled, the resume point), written:[intent], uncertain:[intent], moved, held,
// noop, absent, stopped, error?:{id,code}, failedId?}. A Film whose write may have committed is in `uncertain` with its intent (recover it with recoverLocalizationReconcile).
export async function applyLocalizationReconcile(env,{runId,checkpoint,after,limit,writeCap,now,policy}={}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const port=portOf(checkpoint);
 const examineCap=clampCap(limit,RECONCILE_EXAMINE_DEFAULT,RECONCILE_EXAMINE_MAX),writes=clampCap(writeCap,RECONCILE_WRITE_DEFAULT,RECONCILE_WRITE_MAX);
 const clock=clockOf(now),start=cursorOf(after);
 assertWritable(await readAuthority(env));
 const page=await filmPage(env,{after:start,limit:examineCap});
 const ids=page.slice(0,examineCap);
 const out={examined:0,cursor:start,hasMore:page.length>examineCap,written:[],uncertain:[],moved:[],held:[],noop:0,absent:0,stopped:null};
 // Any stop leaves the failed Film (and the Films after it) unprocessed, so a stopped page ALWAYS reports a continuation; `cursor` stays at the last Film fully settled.
 const stop=(id,code,extra={})=>{out.stopped=code;out.failedId=id;out.error={id,code,...extra};out.hasMore=true;};
 for(const id of ids){
  if(out.written.length>=writes){out.stopped='write_cap';out.hasMore=true;break;}
  out.examined++;
  let intent=null;
  try{
   const at=clock();
   const {plan,inputs,revision}=await readReconcilePlan(env,id,{at});
   if(plan.state==='held'){out.held.push({id,reason:plan.reason});out.cursor=id;continue;}
   if(plan.state==='absent'){out.absent++;out.cursor=id;continue;}
   if(plan.state!=='write'){out.noop++;out.cursor=id;continue;}
   intent=await intentOf({runId,at,revision,inputs,plan});
  }catch(error){stop(id,error?.code||'unclassified');break;}
  // Fail closed: nothing is written for this Film unless its intent is durably recorded. The Film was read, so it stays counted as examined.
  try{await port.record(intent);}catch(error){stop(id,CHECKPOINT_FAILED,{cause:error?.code||null});break;}
  const result=await commitIntent(env,port,intent,{clock,policy});
  if(result.state==='applied')out.written.push(intent);
  else if(result.state==='not_applied')out.moved.push({id,code:result.errorClass});
  else out.uncertain.push(intent);
  // A failed durable settlement is never completion: the pass stops and the Film is not passed over.
  if(result.settleError){stop(id,'localization_checkpoint_settle_failed',{cause:result.settleError});break;}
  if(result.state==='unknown'){stop(id,result.errorClass||'unclassified');break;}
  out.cursor=id;
 }
 return out;
}

// RESTORE: one receipted, atomic, fenced restore of ONE Film from its apply intent (the restore token). The token is validated and bound BEFORE any receipt is reserved: it must be a complete,
// self-consistent intent (explicit pre-image, complete post-image, digest and request id that recompute), its own apply receipt must exist and be `applied` with the same request id, digest,
// target and applied revision, the marker must be open and the owner-review domain D1-authoritative. A refusal writes nothing and reserves nothing.
export async function restoreLocalizationReconcile(env,{runId,token,now,policy}={}){
 const clock=clockOf(now);
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const intent=await checkIntent(token);
 assertWritable(await readAuthority(env));
 await readOwnerReviewToken(env,intent.id);
 const original=await readReceipt(env,intent.requestId);
 if(!original||original.operation!==RECONCILE_OPERATION||original.origin!==RECONCILE_ORIGIN||original.target.kind!=='film'||original.target.id!==intent.id||original.state!=='applied'||original.appliedRevision!==intent.postRevision||original.contentDigest!==intent.digest)throw failed(RESTORE_UNBOUND);
 const digest=await restoreDigest(intent);
 const requestId=await reconcileRequestId({runId,action:'restore',id:intent.id,digest});
 const outcome=await receiptedWrite(env,{requestId,operation:RECONCILE_OPERATION,origin:RECONCILE_ORIGIN,target:{kind:'film',id:intent.id},expectedRevision:intent.postRevision,digest,now:clock,policy},{
  atomic:true,
  // A restore is fenced on the recorded revision and row, so a replay can never overwrite another writer: the readback proves nothing and the replay is the fenced write itself.
  readback:async()=>({digest:null}),
  revalidate:async()=>'proceed',
  run:ctx=>restoreFilmLocalization(env,{intent,at:clock(),receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId};
}

// The fenced restore write. It applies ONLY while the Film is at exactly postRevision AND the stored row still equals postImage: any other writer since then moved the revision, so a restore
// would erase its work and is refused (`localization_restore_moved`, nothing written). A pre-image of null deletes the row the reconciler created. It bumps the revision, so a second restore of
// the same token is refused. The legacy source row the reconciler preserved is NOT removed (a source row is a durable resolver input, never destroyed by a restore).
async function restoreFilmLocalization(env,{intent: given,at,receiptMark}={}){
 // PRIVATE: reachable only through restoreLocalizationReconcile, which binds the intent to its applied receipt and the owner gate before a receipt is reserved.
 if(receiptMark===undefined||receiptMark===null)throw failed('film_person_invalid');
 const intent=await checkIntent(given);
 const id=intent.id,pre=intent.preImage,post=intent.postImage;
 fenced.text(at);
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 // The owner-review domain is re-proved AT the mutation boundary with the CURRENT token (the existing two-fence gate; it need not equal the apply-time token): an owner move between the
 // wrapper's read and this batch refuses the restore (`localization_owner_moved`), which the independent Film CAS would not catch.
 const token=await readOwnerReviewToken(env,id);
 const entities=[{kind:'film',id,expected:intent.postRevision}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(...ownerTokenStatements(token));
 statements.push(assertImage(post,id));
 if(pre===null)statements.push(["DELETE FROM film_dimension WHERE film_id=? AND dimension='localization'",[id]]);
 else statements.push(["UPDATE film_dimension SET "+COLUMNS.map(name=>name+'=?').join(',')+" WHERE film_id=? AND dimension='localization'",[...COLUMNS.map(name=>pre[name]),id]]);
 statements.push(assertImage(pre,id));
 statements.push([fenced.BUMP,['film',id,at]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  if(error?.code==='film_person_precondition'){
   let again=null;
   try{again=await readOwnerReviewToken(env,id);}catch{throw failed('localization_owner_moved',error);}
   if(again.digest!==token.digest)throw failed('localization_owner_moved',error);
  }
  if(error?.code==='film_person_revision_conflict'||error?.code==='film_person_precondition')throw failed(RESTORE_MOVED,error);
  throw error;
 }
 return {id,revision:intent.postRevision+1,restored:true,preImage:pre};
}
