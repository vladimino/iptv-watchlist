// AIR-663 / ADR 0218 decision 3 and stage 4 (D1, Accepted). The SEPARATE, bounded reconciler of a stale effective Film localization row: a Film whose stored `localization` row is no
// longer the output of the existing resolver, with NO new source observation (a historical applied source receipt, an owner-only change in owner_review_entry, a legacy row).
// DORMANT, like the other canonical writers: importing this module runs nothing and NOTHING in the Worker, the cron tick, a Workflow, an MCP tool, a route or a script imports it. It reaches
// the database only when an explicit caller (the production operation of AIR-664, under its own owner GO) invokes it, and only after assertWritable (marker d1/open).
// - Same resolver, same precedence: the output is projectionOf() of the projection writer (resolveLocalization unchanged: owner > reviewed > automatic, fixed source order, then the newer
//   observation, then the source name; the strong() guard and its SQL WHERE). No new source row is written except the lossless legacy candidate the projection writer already preserves.
// - Same two fences: the Film revision CAS and the owner-review token (marker generation, every consumed owner row, the redirect closure), re-proved INSIDE the batch.
// - Its own receipts: kind `film_localization_reconcile`, origin `localization_reconciler`, a FRESH request id per run and Film. It never replays, settles or reuses a historical
//   `localization_source` or `film_localization_projection` receipt (those stay terminal / settle under their own rules; equal content proves no causality).
// - Bounded: a per-run Films-examined limit and a per-run write cap, one fenced batch per Film. A dry run is read only: no receipt, no statement, no write.
// - Pre-image: an apply returns, per written Film, a restore token {preImage, postImage, postRevision}. The token is the ONLY pre-image: a receipt stores no payload and a dry-run report is not
//   one. The caller (the AIR-664 operation) persists it in its sanitized evidence BEFORE it treats the run as done. Restore applies only while the Film is still at exactly postRevision and the
//   stored row still equals postImage; otherwise it refuses (`localization_restore_moved`) and the alternative is a forward correction through this same reconciler.
// Person localization is out of scope (unchanged). No table, index or column changes.
import {assertWritable,database,failed,many,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {canonicalJson,defineOperation,digestOf,receiptedWrite,requestIdOf} from './canonical-receipts.js';
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
export const RESTORE_MOVED='localization_restore_moved';
const COLUMNS=['status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at'];
const DIM_PARAMS=['dimension',...COLUMNS];
const ROW=LOCALIZATION_ROW;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
const imageOf=row=>row?Object.fromEntries(COLUMNS.map(name=>[name,row[name]??null])):null;
const imageOfParams=params=>Object.fromEntries(COLUMNS.map(name=>[name,params[DIM_PARAMS.indexOf(name)+1]??null]));
// A SQL boolean over film_dimension of ONE Film's localization row equal, column for column, to `image` (null-safe). `image === null` means the row is absent.
function imageCondition(image){
 if(image===null)return {sql:"NOT EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='localization')",params:id=>[id]};
 return {sql:"EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='localization' AND "+COLUMNS.map(name=>name+' IS ?').join(' AND ')+')',params:id=>[id,...COLUMNS.map(name=>image[name]??null)]};
}
const assertImage=(image,id)=>{const condition=imageCondition(image);return [fenced.assertSql(condition.sql),condition.params(id)];};

// PURE. The reconciliation decision for ONE Film from its stored rows and the owner-review token (no incoming source):
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

// The content a reconcile receipt binds: the Film, the resolver identity, the normalized resolver inputs (no incoming source), the pre-image and the intended post-write row. Another
// input, pre-image or output is another digest and request identity: a moved input is replanned, never replayed under the old identity.
export function reconcileContent({id,inputs,preImage,postImage}){
 if(typeof id!=='string'||!id.startsWith('film:')||!plain(inputs))throw failed('film_person_invalid');
 return {kind:'film',action:'reconcile',resolver:PROJECTION_RESOLVER,inputs,preImage:preImage??null,postImage:postImage??null};
}
export const reconcileDigest=input=>digestOf({operation:RECONCILE_OPERATION,id:input?.id,content:reconcileContent(input)});
// The content of a restore receipt: the Film, the recorded pre-image, the post-write image and the exact post-write revision it is bound to.
export const restoreDigest=input=>digestOf({operation:RECONCILE_OPERATION,id:input?.id,content:{kind:'film',action:'restore',preImage:input?.preImage??null,postImage:input?.postImage??null,postRevision:input?.postRevision}});
// A fresh request id per run and Film: the run id is the source event. It never equals a historical receipt's id, so a historical receipt is never replayed through this kind.
export async function reconcileRequestId({runId,action='reconcile',id,digest}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200||typeof id!=='string'||!/^[0-9a-f]{64}$/.test(digest||''))throw failed('film_person_invalid');
 return requestIdOf({origin:RECONCILE_ORIGIN,operation:RECONCILE_OPERATION,source:{runId,action,id,digest}});
}

// Read only. The plan of ONE Film against D1 NOW: {plan, inputs, token, revision}.
export async function readReconcilePlan(env,id,{at=new Date().toISOString(),requestId}={}){
 const snapshot=await readFilmSnapshot(env,id);
 if(snapshot.redirect||!snapshot.film)return {plan:{state:'absent',id,statements:[],changes:[]},inputs:null,revision:snapshot.revision};
 const token=await readOwnerReviewToken(env,id);
 const plan=planLocalizationReconcile(snapshot,token,{id,at,requestId});
 return {plan,inputs:projectionInputs(snapshot,token,[]),token,snapshot,revision:snapshot.revision};
}

// The fenced reconcile write of ONE Film. input: {id, expectedRevision, at, requestId, inputs, receiptMark?}. Refuses before the database unless the Film/Person marker is open and the
// owner-review domain is D1-authoritative; a moved resolver input is `localization_inputs_moved` (replan), a lost owner token `localization_owner_moved`, a lost revision
// `film_person_revision_conflict`. `noop` and `held` write nothing and open no batch. Returns {written, revision, preImage, postImage, postRevision}.
export async function writeFilmLocalizationReconcile(env,input){
 const id=fenced.filmId(input?.id),expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at);
 fenced.text(input.requestId);
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const snapshot=await readFilmSnapshot(env,id);
 if(snapshot.redirect)throw failed('film_person_redirect');
 if(!snapshot.film)throw failed('film_person_precondition');
 const token=await readOwnerReviewToken(env,id);
 if(!plain(input.inputs)||canonicalJson(projectionInputs(snapshot,token,[]))!==canonicalJson(input.inputs))throw failed('localization_inputs_moved');
 const plan=planLocalizationReconcile(snapshot,token,input);
 if(plan.state==='held')return {id,revision:snapshot.revision,written:false,held:true,reason:plan.reason,effective:plan.effective};
 if(plan.state!=='write')return {id,revision:snapshot.revision,written:false,reason:'unchanged',effective:plan.effective};
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(...ownerTokenStatements(token));
 // The pre-image is asserted INSIDE the batch: the row the plan read is the row the write replaces.
 statements.push(assertImage(plan.preImage,id));
 statements.push(...plan.statements);
 statements.push([fenced.BUMP,['film',id,at]]);
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
 return {id,revision:expected+1,written:true,changes:plan.changes,effective:plan.effective,preImage:plan.preImage,postImage:plan.postImage,postRevision:expected+1};
}

// The fenced restore of ONE written Film to its recorded pre-image. input: {id, preImage, postImage, postRevision, at, requestId, receiptMark?}. It applies ONLY while the Film is at exactly
// postRevision (the revision this reconciler's own write produced) AND the stored row still equals postImage: any other writer since then moved the revision, so a restore would erase
// its work and is refused (`localization_restore_moved`, nothing written). A pre-image of null deletes the row the reconciler created. It bumps the revision, so a second restore of the same
// token is refused. The legacy source row the reconciler preserved is NOT removed (a source row is a durable resolver input, never destroyed by a restore).
export async function restoreFilmLocalization(env,input){
 const id=fenced.filmId(input?.id),at=fenced.text(input.at);
 fenced.text(input.requestId);
 const postRevision=fenced.revisionOf(input.postRevision);
 const pre=input.preImage===null?null:imageOf(input.preImage),post=imageOf(input.postImage);
 if(!post||(pre!==null&&!COLUMNS.every(name=>name in input.preImage)))throw failed('film_person_invalid');
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const entities=[{kind:'film',id,expected:postRevision}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(assertImage(post,id));
 if(pre===null)statements.push(["DELETE FROM film_dimension WHERE film_id=? AND dimension='localization'",[id]]);
 else statements.push(["UPDATE film_dimension SET "+COLUMNS.map(name=>name+'=?').join(',')+" WHERE film_id=? AND dimension='localization'",[...COLUMNS.map(name=>pre[name]),id]]);
 statements.push(assertImage(pre,id));
 statements.push([fenced.BUMP,['film',id,at]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  if(error?.code==='film_person_revision_conflict'||error?.code==='film_person_precondition')throw failed(RESTORE_MOVED,error);
  throw error;
 }
 return {id,revision:postRevision+1,restored:true,preImage:pre};
}

// The registry spec of the kind, for reconcileReceipts. A receipt stores no payload: a replay re-plans from D1 and only an input whose digest is the receipt's is ever replayed; a moved
// input abandons the receipt (the next run plans afresh). A restore receipt cannot be re-planned from D1 (its pre-image lives only in the token): it is never replayed by the registry,
// and the operator re-issues the restore from the token.
export function filmLocalizationReconcileOperation({now=()=>new Date().toISOString()}={}){
 const planned=async(env,receipt)=>{
  const {plan,inputs,revision}=await readReconcilePlan(env,receipt.target.id,{at:now(),requestId:receipt.requestId});
  if(plan.state==='absent')return null;
  const digest=await reconcileDigest({id:receipt.target.id,inputs,preImage:plan.preImage,postImage:plan.postImage??plan.preImage});
  return {plan,inputs,revision,ok:digest===receipt.contentDigest};
 };
 return defineOperation({
  operation:RECONCILE_OPERATION,atomic:true,
  readback:async(env,target,receipt)=>{
   const found=await planned(env,receipt);
   if(!found)return {digest:null};
   if(found.plan.state==='write'){if(!found.ok)return {disposition:'abandon',errorClass:RECONCILE_SOURCE_CHANGED};return {digest:null,revision:found.revision};}
   if(found.plan.state==='held')return {disposition:'abandon',errorClass:RECONCILE_HELD};
   // noop: the row already is the output. Equal content proves no causality (another writer may have reached it): never applied from content, the evidence-less digest is `needs_review`.
   return {digest:receipt.contentDigest};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(env,receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return writeFilmLocalizationReconcile(env,{id:receipt.target.id,inputs:found.inputs,at:now(),requestId:receipt.requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,now)});
  },
  revalidate:async(env,receipt)=>{
   const found=await planned(env,receipt);
   return found&&found.ok&&found.plan.state==='write'?'proceed':'stale';
  },
 });
}

const clampCap=(value,fallback,max)=>{
 if(value===undefined||value===null)return fallback;
 if(!Number.isInteger(value)||value<1||value>max)throw failed('film_person_invalid');
 return value;
};
const cursorOf=value=>{if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||!value.startsWith('film:'))throw failed('film_person_invalid');return value;};
// One page of Film ids in id order: the Films that could carry a localization projection (a localization row, a source row, or a verified owner row linked to the Film). Redirected Films
// are excluded. Read only, bounded by `limit`.
async function candidatePage(env,{after,limit}){
 const db=database(env);
 try{
  return (await many(db,`SELECT f.id AS id FROM film f WHERE f.id>? AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=f.id) AND (EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id=f.id AND d.dimension='localization') OR EXISTS (SELECT 1 FROM film_localization_source s WHERE s.film_id=f.id) OR EXISTS (SELECT 1 FROM owner_review_entry o WHERE o.kind='film' AND o.identity_state='verified' AND o.identity_link=f.id)) ORDER BY f.id LIMIT ?`,[after,limit+1])).map(row=>row.id);
 }catch(error){throw failed('film_person_unavailable',error);}
}

// DRY RUN: read only. No receipt, no statement, no write; it never reads a state it cannot prove (a Film whose owner evidence is unavailable is `unavailable` with the code). Returns
// {examined, cursor, hasMore, stale:[{id,revision,effective,preImage,postImage,changes}], held:[{id,reason}], noop, unavailable:[{id,code}], wouldWrite}. `cursor` is the last examined id: pass it as
// `after` for the next page. `wouldWrite` is capped by `writeCap` (the stale list beyond it is reported but a run would not write it).
export async function dryRunLocalizationReconcile(env,{after,limit,writeCap,now}={}){
 const examineCap=clampCap(limit,RECONCILE_EXAMINE_DEFAULT,RECONCILE_EXAMINE_MAX),writes=clampCap(writeCap,RECONCILE_WRITE_DEFAULT,RECONCILE_WRITE_MAX);
 const clock=clockOf(now),start=cursorOf(after);
 await readAuthority(env);
 const page=await candidatePage(env,{after:start,limit:examineCap});
 const ids=page.slice(0,examineCap),out={examined:0,cursor:ids.length?ids.at(-1):start,hasMore:page.length>examineCap,stale:[],held:[],noop:0,unavailable:[],wouldWrite:0};
 for(const id of ids){
  out.examined++;
  try{
   const {plan,revision}=await readReconcilePlan(env,id,{at:clock()});
   if(plan.state==='write'){out.stale.push({id,revision,effective:plan.effective,preImage:plan.preImage,postImage:plan.postImage,changes:plan.changes});if(out.wouldWrite<writes)out.wouldWrite++;}
   else if(plan.state==='held')out.held.push({id,reason:plan.reason});
   else out.noop++;
  }catch(error){
   if(!error?.code||error.code==='film_person_unavailable'&&!error.cause)throw error;
   out.unavailable.push({id,code:error.code});
  }
 }
 return out;
}

// APPLY: one bounded pass. input: {runId, after?, limit?, writeCap?, now?, dryRun?:{...}} (a `runId` is the fresh source event of every request id of the run). For each examined Film: a noop or held
// Film opens no receipt; a stale one is written by ONE receipted, atomic, fenced batch under a fresh request id. The pass stops writing at `writeCap` and stops at the first error that is not a
// replan (`localization_inputs_moved`, `localization_owner_moved`, `film_person_revision_conflict`: the Film is reported `moved` and left for the next run), so an unknown outcome or a
// closed marker never silently continues. Returns the restore tokens: {written:[{id,requestId,preImage,postImage,postRevision}], moved, held, noop, stopped}.
export async function applyLocalizationReconcile(env,{runId,after,limit,writeCap,now,policy}={}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const examineCap=clampCap(limit,RECONCILE_EXAMINE_DEFAULT,RECONCILE_EXAMINE_MAX),writes=clampCap(writeCap,RECONCILE_WRITE_DEFAULT,RECONCILE_WRITE_MAX);
 const clock=clockOf(now),start=cursorOf(after);
 assertWritable(await readAuthority(env));
 const page=await candidatePage(env,{after:start,limit:examineCap});
 const ids=page.slice(0,examineCap);
 const out={examined:0,cursor:start,hasMore:page.length>examineCap,written:[],moved:[],held:[],noop:0,stopped:null};
 const retry=new Set(['localization_inputs_moved','localization_owner_moved','film_person_revision_conflict']);
 for(const id of ids){
  if(out.written.length>=writes){out.stopped='write_cap';out.hasMore=true;break;}
  out.examined++;out.cursor=id;
  const at=clock();
  const {plan,inputs,revision}=await readReconcilePlan(env,id,{at});
  if(plan.state==='held'){out.held.push({id,reason:plan.reason});continue;}
  if(plan.state!=='write'){out.noop++;continue;}
  const digest=await reconcileDigest({id,inputs,preImage:plan.preImage,postImage:plan.postImage});
  const requestId=await reconcileRequestId({runId,id,digest});
  let outcome;
  try{
   outcome=await receiptedWrite(env,{requestId,operation:RECONCILE_OPERATION,origin:RECONCILE_ORIGIN,target:{kind:'film',id},expectedRevision:revision,digest,now:clock,policy},{
    atomic:true,
    readback:filmLocalizationReconcileOperation({now:clock}).readback,
    revalidate:filmLocalizationReconcileOperation({now:clock}).revalidate,
    run:ctx=>writeFilmLocalizationReconcile(env,{id,inputs,at:clock(),requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)}),
   });
  }catch(error){
   if(retry.has(error?.code)){out.moved.push({id,code:error.code});continue;}
   out.stopped=error?.code||'unclassified';out.error={id,code:out.stopped};break;
  }
  if(outcome.state==='applied'&&outcome.result?.written)out.written.push({id,requestId,preImage:plan.preImage,postImage:plan.postImage,postRevision:outcome.result.postRevision});
  else if(outcome.state==='applied')out.noop++;
  else{out.stopped=outcome.errorClass||outcome.reason||outcome.state;out.error={id,state:outcome.state};break;}
 }
 return out;
}

// RESTORE: one receipted, atomic, fenced restore of ONE Film from its restore token {id, preImage, postImage, postRevision} (see the file header). `runId` makes the request id fresh.
export async function restoreLocalizationReconcile(env,{runId,token,now,policy}={}){
 const clock=clockOf(now);
 if(!plain(token)||typeof runId!=='string'||!runId.trim())throw failed('film_person_invalid');
 const digest=await restoreDigest(token);
 const requestId=await reconcileRequestId({runId,action:'restore',id:token.id,digest});
 const outcome=await receiptedWrite(env,{requestId,operation:RECONCILE_OPERATION,origin:RECONCILE_ORIGIN,target:{kind:'film',id:token.id},expectedRevision:fenced.revisionOf(token.postRevision),digest,now:clock,policy},{
  atomic:true,
  // A restore is fenced on the recorded revision, so a replay can never overwrite another writer: the readback proves nothing and the replay is the fenced write itself.
  readback:async()=>({digest:null}),
  revalidate:async()=>'proceed',
  run:ctx=>restoreFilmLocalization(env,{...token,at:clock(),requestId,receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId};
}
