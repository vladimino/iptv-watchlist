// AIR-666 / ADR 0218 decision 7 stage 6 (Accepted). The GUARDED RETIREMENT of legacy `film_dimension` copy rows, with a pre-image. DORMANT code, like the other canonical writers: importing this
// module runs nothing, nothing in the Worker imports it, and no route, MCP tool, cron tick, Workflow or script calls it. Delivering it deletes nothing. Running it against production is the
// separate L3 operation (an exact owner GO naming the exact allowlist); the stage-5 reader switch (AIR-648) and the absence of D1 consumers of the rows are that operation's holdpoint, proved
// from live evidence before the GO, not something this module can know.
// - WHAT may go: only a row the stage-1 parity reader (src/film-dimension-parity.js) classifies `stale_copy` with proof `complete`, in exactly three dimensions: `fingerprint`, `prediction`
//   (ADR 0218 A1) and an UNLOCKED `metadata` row (B1). The SQL twin of the rule is `NOT PROTECTED_ROW_SQL` of the offline importer (src/canonical-repository.js): never a reviewed or owner row, an
//   unknown authority or status, a row with a titleSource or an unreadable provenance. identity (the titleSource carrier, C1) and localization (the effective projection, D1) are never retired
//   here; control and unknown_legacy rows are RETAINED and REPORTED, never widened into the allowlist. A redirected Film is retained.
// - EXACT ALLOWLIST. The dry run proposes `[{id, dimension, rowDigest}]`; the apply takes the allowlist and the owner GO `{reference, allowlistDigest}` whose digest must equal the allowlist's. A row
//   that is not listed is never read for deletion, and a listed row whose stored bytes (rowDigest) or classification moved since the dry run is skipped and reported (`moved`), never retried blind.
// - PRE-IMAGE BEFORE DELETE. Per Film the immutable intent is the pre-image: {id, runId, requestId, digest, at, plannedRevision, postRevision, rows:[{dimension, preImage}]}. An apply REQUIRES a durable
//   `checkpoint` port and fails closed: `checkpoint.record(intent)` must resolve BEFORE the delete is permitted; `checkpoint.settle(intent, result)` records the outcome. The caller (the operation)
//   chooses the storage; this module owns the contract.
// - FENCES. One fenced, receipted, atomic batch per Film (<= 3 rows): the marker generation and the Film revision CAS in the batch head, no redirect, the exact pre-image asserted in the batch, the
//   delete guarded by the safe predicate again, the slot asserted empty afterwards, the revision bumped (postRevision = plannedRevision + 1: the bump of the retirement's OWN write is part of the
//   recorded post-delete revision), the receipt marked applied in the same batch. A failed assertion rolls the whole Film back.
// - RESTORE. Only an empty `(film_id, dimension)` slot, and only while the Film is still at exactly the recorded post-delete revision; any other state is reported and the newer state is retained.
//   Code revert is not data rollback: a deploy removes this module and restores no row.
// - BOUNDED. A per-run Films-written cap (hard cap 25) and a per-run examined cap for the dry run; a dry run is read only (no receipt, no statement, no write).
import {assertWritable,database,failed,many,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {canonicalJson,defineOperation,digestOf,readReceipt,receiptedWrite,requestIdOf} from './canonical-receipts.js';
import {PROTECTED_ROW_SQL,protectedReasons} from './canonical-repository.js';
import {readDimensionParity} from './film-dimension-parity.js';

export const RETIRE_OPERATION='film_dimension_retire';
export const RETIRE_ORIGIN='dimension_retirement';
// The only dimensions this stage may ever retire (ADR 0218 decision 7 stage 6).
export const RETIRABLE_DIMENSIONS=Object.freeze(['fingerprint','metadata','prediction']);
// Films EXAMINED per dry-run page and Films WRITTEN per apply. Hard caps with a stated reason: the blast radius of one run is a handful of Films whose pre-images fit one checkpoint, and each Film
// costs one fenced batch and one receipt. They are provisional tuning values of the first operation, not product constraints: the owner GO of an operation names its own cap within the maximum.
export const RETIRE_EXAMINE_DEFAULT=20;
export const RETIRE_EXAMINE_MAX=50;
export const RETIRE_WRITE_DEFAULT=10;
export const RETIRE_WRITE_MAX=25;
export const RETIRE_ALLOWLIST_MAX=RETIRE_WRITE_MAX*RETIRABLE_DIMENSIONS.length;
export const RETIRE_INTENT_REQUIRED='retire_intent_required';
export const RETIRE_UNBOUND='retire_restore_unbound';
export const RETIRE_RESTORE_MOVED='retire_restore_moved';
export const RETIRE_CHECKPOINT_FAILED='retire_checkpoint_failed';
export const RETIRE_ROW_CHANGED='retire_row_changed';
export const RETIRE_GO_MISMATCH='retire_go_mismatch';
export const RETIRE_PAGE_MOVED='retire_page_moved';
const COLUMNS=['status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at'];
const SELECT_COLUMNS='film_id,dimension,'+COLUMNS.join(',');
const DIGEST=/^[0-9a-f]{64}$/;
const FILM=/^film:.+/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
const sameImage=(a,b)=>canonicalJson(a??null)===canonicalJson(b??null);
const imageOf=row=>row?Object.fromEntries(COLUMNS.map(name=>[name,row[name]??null])):null;
const byDimension=(a,b)=>a.dimension<b.dimension?-1:a.dimension>b.dimension?1:0;
// The one SQL rule of what a retirement may delete (the importer's protected-row predicate, negated): fingerprint, prediction and metadata rows that are not control and not unknown_legacy.
// PROTECTED_ROW_SQL is NULL (not 0) for a row with no authority whose other terms are all false (three-valued OR), and `NOT NULL` is NULL: the negation must be NULL-safe, or a plain copy would never match.
export const SAFE_DELETE_SQL=`(dimension IN (${RETIRABLE_DIMENSIONS.map(name=>"'"+name+"'").join(',')}) AND COALESCE(${PROTECTED_ROW_SQL},0)=0)`;
// A complete, strictly shaped row image: every column present (null allowed), no other key, and never an empty status or time.
function completeImage(value){
 if(!plain(value))throw failed('film_person_invalid');
 const keys=Object.keys(value);
 if(keys.length!==COLUMNS.length||!COLUMNS.every(name=>own(value,name)))throw failed('film_person_invalid');
 for(const name of COLUMNS){const item=value[name];if(item!==null&&typeof item!=='string'&&!(typeof item==='number'&&Number.isFinite(item)))throw failed('film_person_invalid');}
 if(typeof value.status!=='string'||!value.status||typeof value.updated_at!=='string'||!value.updated_at)throw failed('film_person_invalid');
 return imageOf(value);
}
// A SQL boolean over film_dimension of ONE row equal, column for column, to `image` (null-safe).
const imageCondition=image=>({sql:"EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension=? AND "+COLUMNS.map(name=>name+' IS ?').join(' AND ')+')',params:(id,dimension)=>[id,dimension,...COLUMNS.map(name=>image[name]??null)]});
const assertImage=(image,id,dimension)=>{const condition=imageCondition(image);return [fenced.assertSql(condition.sql),condition.params(id,dimension)];};
const slotEmpty=(id,dimension)=>[fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension=?)'),[id,dimension]];

// ---- pure: the safe-delete rule, the row digest, the allowlist ----

// PURE. Whether a classified row (an item of readDimensionParity().classified) is a retirement candidate, and otherwise why it is retained. `row` is the stored row (the JS twin of the SQL rule is
// checked again on it). Reasons are stable codes: dimension_not_retirable, class_<class>, proof_<proof>, film_redirected, protected_row.
export function retirementDecision(item,row){
 if(!item)return {eligible:false,reason:'row_absent'};
 if(!RETIRABLE_DIMENSIONS.includes(item.dimension))return {eligible:false,reason:'dimension_not_retirable'};
 if(!row)return {eligible:false,reason:'row_absent'};
 if(item.class!=='stale_copy')return {eligible:false,reason:'class_'+item.class};
 if(item.notes?.includes('film_redirected'))return {eligible:false,reason:'film_redirected'};
 if(item.proof!=='complete')return {eligible:false,reason:'proof_'+item.proof};
 if(protectedReasons(row).length)return {eligible:false,reason:'protected_row'};
 return {eligible:true,reason:null};
}
// The digest of a stored row (every column, the Film and the dimension): what an allowlist entry pins.
export const rowDigest=row=>digestOf({film_id:row.film_id,dimension:row.dimension,image:completeImage(imageOf(row))});
// The canonical, validated allowlist: unique `{id, dimension, rowDigest}` entries in id and dimension order, only retirable dimensions, at most RETIRE_ALLOWLIST_MAX.
export function checkAllowlist(value){
 if(!Array.isArray(value)||!value.length||value.length>RETIRE_ALLOWLIST_MAX)throw failed('film_person_invalid');
 const seen=new Set(),out=[];
 for(const item of value){
  if(!plain(item)||Object.keys(item).sort().join()!=='dimension,id,rowDigest'||typeof item.id!=='string'||!FILM.test(item.id)||!RETIRABLE_DIMENSIONS.includes(item.dimension)||!DIGEST.test(item.rowDigest||''))throw failed('film_person_invalid');
  const key=item.id+'\u0000'+item.dimension;
  if(seen.has(key))throw failed('film_person_invalid');
  seen.add(key);
  out.push({id:item.id,dimension:item.dimension,rowDigest:item.rowDigest});
 }
 out.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:byDimension(a,b));
 if(new Set(out.map(item=>item.id)).size>RETIRE_WRITE_MAX)throw failed('film_person_invalid');
 return out;
}
export const allowlistDigest=allowlist=>digestOf({operation:RETIRE_OPERATION,allowlist:checkAllowlist(allowlist)});
// The owner GO of an operation names the exact allowlist: {reference (an https link to the recorded GO), allowlistDigest}. A GO for another allowlist authorizes nothing.
async function checkGo(go,allowlist){
 if(!plain(go)||typeof go.reference!=='string'||!/^https:\/\/\S{1,480}$/.test(go.reference)||!DIGEST.test(go.allowlistDigest||''))throw failed('film_person_invalid');
 if(go.allowlistDigest!==await allowlistDigest(allowlist))throw failed(RETIRE_GO_MISMATCH);
 return {reference:go.reference,allowlistDigest:go.allowlistDigest};
}

// ---- the intent (the pre-image contract) ----

// What a retirement receipt binds: the Film, the rule, every pre-image row, the stable time and the planned revision. A moved state is a NEW intent, never a replay under the old one.
export function retireContent({id,rows,at,plannedRevision}){
 if(typeof id!=='string'||!FILM.test(id)||!Array.isArray(rows)||!rows.length||rows.length>RETIRABLE_DIMENSIONS.length||typeof at!=='string'||!Number.isInteger(plannedRevision))throw failed('film_person_invalid');
 return {kind:'film',action:'retire',rule:'adr0218_stage6_v1',rows:rows.map(row=>({dimension:row.dimension,preImage:row.preImage})),at,plannedRevision};
}
export const retireDigest=input=>digestOf({operation:RETIRE_OPERATION,id:input?.id,content:retireContent(input)});
// A fresh request id per run, Film, action and digest.
export async function retireRequestId({runId,action='retire',id,digest}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200||typeof id!=='string'||!DIGEST.test(digest||''))throw failed('film_person_invalid');
 return requestIdOf({origin:RETIRE_ORIGIN,operation:RETIRE_OPERATION,source:{runId,action,id,digest}});
}
const restoreDigest=(intent,rows)=>digestOf({operation:RETIRE_OPERATION,id:intent.id,content:{kind:'film',action:'restore',applyRequestId:intent.requestId,applyDigest:intent.digest,rows,postRevision:intent.postRevision}});
async function intentOf({runId,at,revision,rows,id}){
 const base={id,rows,at,plannedRevision:revision};
 const digest=await retireDigest(base);
 return {version:1,id,runId,requestId:await retireRequestId({runId,id,digest}),digest,at,plannedRevision:revision,postRevision:revision+1,rows};
}
// Validates an intent supplied by a caller (a checkpoint read back, a restore token): strict shape, complete pre-images of retirable dimensions in dimension order with no repeats, and a digest and
// request id that recompute from the content. Nothing here reads the database.
export async function checkIntent(value){
 if(!plain(value)||value.version!==1||typeof value.id!=='string'||!FILM.test(value.id)||typeof value.runId!=='string'||!value.runId.trim()||typeof value.requestId!=='string'||!DIGEST.test(value.digest||''))throw failed('film_person_invalid');
 if(typeof value.at!=='string'||!ISO.test(value.at)||!Number.isInteger(value.plannedRevision)||value.plannedRevision<0||value.postRevision!==value.plannedRevision+1||!Array.isArray(value.rows)||!value.rows.length||value.rows.length>RETIRABLE_DIMENSIONS.length)throw failed('film_person_invalid');
 const rows=value.rows.map(item=>{
  if(!plain(item)||Object.keys(item).sort().join()!=='dimension,preImage'||!RETIRABLE_DIMENSIONS.includes(item.dimension))throw failed('film_person_invalid');
  return {dimension:item.dimension,preImage:completeImage(item.preImage)};
 });
 if(new Set(rows.map(row=>row.dimension)).size!==rows.length||rows.some((row,index)=>index&&byDimension(rows[index-1],row)>=0))throw failed('film_person_invalid');
 const intent={version:1,id:value.id,runId:value.runId,requestId:value.requestId,digest:value.digest,at:value.at,plannedRevision:value.plannedRevision,postRevision:value.postRevision,rows};
 const digest=await retireDigest(intent);
 if(digest!==intent.digest||await retireRequestId({runId:intent.runId,id:intent.id,digest})!==intent.requestId)throw failed('film_person_invalid');
 return intent;
}

// ---- reads ----

async function chunkRead(db,sql,ids,chunk=80){
 const out=[];
 for(let at=0;at<ids.length;at+=chunk){
  const part=ids.slice(at,at+chunk);
  try{out.push(...await many(db,sql.replace('/*ids*/',part.map(()=>'?').join(',')),part));}
  catch(error){throw failed('film_person_unavailable',error);}
 }
 return out;
}
const revisionsOf=async(db,ids)=>new Map((await chunkRead(db,"SELECT id,revision FROM canonical_revision WHERE kind='film' AND id IN (/*ids*/)",ids)).map(row=>[row.id,Number(row.revision)]));
const rowsOf=async(db,ids)=>{
 const out=new Map();
 for(const row of await chunkRead(db,`SELECT ${SELECT_COLUMNS} FROM film_dimension WHERE dimension IN (${RETIRABLE_DIMENSIONS.map(name=>"'"+name+"'").join(',')}) AND film_id IN (/*ids*/) ORDER BY film_id,dimension`,ids)){
  if(!out.has(row.film_id))out.set(row.film_id,new Map());
  out.get(row.film_id).set(row.dimension,row);
 }
 return out;
};
// ORDER MATTERS: the revisions and stored rows are read BEFORE the parity classification, and the retirement's batch asserts the revision it read here. A canonical writer that changes the Film
// between this read and the commit bumps the revision and fails the batch, so a classification never outlives the state it judged.
async function readFilms(env,ids,{coverage}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const revisions=await revisionsOf(db,ids),rows=await rowsOf(db,ids);
 let parity;
 try{parity=await readDimensionParity(env,{ids,limit:Math.max(ids.length,1),coverage});}
 catch(error){throw error?.code?error:failed('film_person_unavailable',error);}
 const wanted=new Set(ids);
 if(parity.classified.some(item=>!wanted.has(item.film_id)))throw failed(RETIRE_PAGE_MOVED);
 const classes=new Map();
 for(const item of parity.classified){if(!classes.has(item.film_id))classes.set(item.film_id,new Map());classes.get(item.film_id).set(item.dimension,item);}
 return {revisions,rows,classes,parity};
}
// One keyset page of RAW Film ids in id order (limit + 1 to learn whether more follow); bounded by `limit` whatever the candidates are.
async function filmPage(env,{after,limit}){
 try{return (await many(database(env),'SELECT id FROM film WHERE id>? ORDER BY id LIMIT ?',[after,limit+1])).map(row=>row.id);}
 catch(error){throw failed('film_person_unavailable',error);}
}
const clampCap=(value,fallback,max)=>{
 if(value===undefined||value===null)return fallback;
 if(!Number.isInteger(value)||value<1||value>max)throw failed('film_person_invalid');
 return value;
};
const cursorOf=value=>{if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||!value.startsWith('film:'))throw failed('film_person_invalid');return value;};
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};

// DRY RUN: read only. One keyset page of Films: the eligible rows (the proposed allowlist, each pinned by rowDigest and the Film revision), and the RETAINED rows counted by reason, so the report names
// what stays and why. `coverage(filmId, aliases)` is the parity reader's candidate-coverage supplier; without it no fingerprint or prediction row can be proved and none is eligible. Returns
// {examined, cursor, hasMore, eligible:[{id,dimension,rowDigest,revision}], retained:{byReason, byDimension}, allowlist (at most writeCap Films), allowlistDigest, wouldWrite, markers}.
// The report is aggregates plus ids and digests, never a stored value; keep it private anyway.
export async function dryRunDimensionRetirement(env,{after,limit,writeCap,coverage=null}={}){
 const examineCap=clampCap(limit,RETIRE_EXAMINE_DEFAULT,RETIRE_EXAMINE_MAX),writes=clampCap(writeCap,RETIRE_WRITE_DEFAULT,RETIRE_WRITE_MAX),start=cursorOf(after);
 await readAuthority(env);
 const page=await filmPage(env,{after:start,limit:examineCap}),ids=page.slice(0,examineCap);
 const out={examined:ids.length,cursor:ids.length?ids.at(-1):start,hasMore:page.length>examineCap,eligible:[],retained:{byReason:{},byDimension:{}},allowlist:[],allowlistDigest:null,wouldWrite:0,markers:null};
 if(!ids.length)return out;
 const {revisions,rows,classes,parity}=await readFilms(env,ids,{coverage});
 out.markers=parity.markers;
 const films=new Set();
 for(const id of ids){
  for(const [dimension,item] of classes.get(id)||[]){
   const row=rows.get(id)?.get(dimension)||null;
   const decision=retirementDecision(item,row);
   if(!decision.eligible){bump(out.retained.byReason,dimension+':'+decision.reason);bump(out.retained.byDimension,dimension);continue;}
   out.eligible.push({id,dimension,rowDigest:await rowDigest(row),revision:revisions.get(id)??0});
  }
 }
 for(const item of out.eligible){
  if(!films.has(item.id)&&films.size>=writes)continue;
  films.add(item.id);
  out.allowlist.push({id:item.id,dimension:item.dimension,rowDigest:item.rowDigest});
 }
 out.wouldWrite=films.size;
 if(out.allowlist.length)out.allowlistDigest=await allowlistDigest(out.allowlist);
 return out;
}

// ---- the fenced write ----

// The fenced retirement of ONE Film FROM ITS INTENT. It trusts nothing but the intent: the stored Film must still be at the planned revision and hold exactly the intent's pre-images, and the batch
// re-asserts all of it. PRIVATE: reachable only through the checkpointed, receipted path.
async function writeFilmRetirement(env,{intent: given,receiptMark}={}){
 if(receiptMark===undefined||receiptMark===null)throw failed('film_person_invalid');
 const intent=await checkIntent(given);
 const id=intent.id,expected=intent.plannedRevision;
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const db=database(env);
 const revision=(await revisionsOf(db,[id])).get(id)??0;
 if(revision!==expected)throw failed('film_person_revision_conflict');
 const stored=(await rowsOf(db,[id])).get(id)||new Map();
 for(const row of intent.rows)if(!sameImage(imageOf(stored.get(row.dimension)),row.preImage))throw failed(RETIRE_ROW_CHANGED);
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 for(const row of intent.rows){
  statements.push(assertImage(row.preImage,id,row.dimension));
  statements.push([`DELETE FROM film_dimension WHERE film_id=? AND dimension=? AND ${SAFE_DELETE_SQL}`,[id,row.dimension]]);
  statements.push(slotEmpty(id,row.dimension));
 }
 statements.push([fenced.BUMP,['film',id,intent.at]]);
 if(statements.length>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  // The head proves the marker and the revision (named by commit); the remaining assertions are the row itself and the safe predicate: a row that moved or is protected NOW.
  if(error?.code==='film_person_precondition')throw failed(RETIRE_ROW_CHANGED,error);
  throw error;
 }
 return {id,revision:intent.postRevision,retired:intent.rows.map(row=>row.dimension),postRevision:intent.postRevision,rows:intent.rows};
}
function intentHooks(env,intent,clock){
 const state=async()=>{
  const db=database(env);
  const revision=(await revisionsOf(db,[intent.id])).get(intent.id)??0,stored=(await rowsOf(db,[intent.id])).get(intent.id)||new Map();
  return {revision,images:Object.fromEntries(RETIRABLE_DIMENSIONS.map(name=>[name,imageOf(stored.get(name))]))};
 };
 const pre=now=>intent.rows.every(row=>sameImage(now.images[row.dimension],row.preImage));
 const post=now=>intent.rows.every(row=>now.images[row.dimension]===null);
 return {
  atomic:true,
  readback:async()=>{
   const now=await state();
   // The post-delete state without an applied receipt of this request proves no causality (another writer may have reached it): `needs_review`, never applied.
   if(now.revision===intent.postRevision&&post(now))return {digest:intent.digest};
   if(now.revision===intent.plannedRevision&&pre(now))return {digest:null,revision:now.revision};
   return {disposition:'abandon',errorClass:RETIRE_ROW_CHANGED};
  },
  revalidate:async()=>{const now=await state();return now.revision===intent.plannedRevision&&pre(now)?'proceed':'stale';},
  run:ctx=>writeFilmRetirement(env,{intent,receiptMark:mark(ctx,clock)}),
 };
}
async function writeIntent(env,intent,{clock,policy}){
 return receiptedWrite(env,{requestId:intent.requestId,operation:RETIRE_OPERATION,origin:RETIRE_ORIGIN,target:{kind:'film',id:intent.id},expectedRevision:intent.plannedRevision,digest:intent.digest,now:clock,policy},intentHooks(env,intent,clock));
}
const appliedOf=(outcome,intent)=>outcome?.state==='applied'&&outcome.receipt?.appliedRevision===intent.postRevision&&outcome.receipt?.contentDigest===intent.digest;

// The registry spec of the kind, for reconcileReceipts. A receipt stores no payload and the pre-image lives only in the intent, so the registry can neither re-plan nor replay: an unsettled receipt is
// abandoned (`retire_intent_required`) and the operation settles its intent through recoverDimensionRetirement / resumeDimensionRetirement.
export function filmDimensionRetireOperation(){
 return defineOperation({
  operation:RETIRE_OPERATION,atomic:true,
  readback:async()=>({disposition:'abandon',errorClass:RETIRE_INTENT_REQUIRED}),
  replay:async()=>{throw failed('producer_replan_unavailable');},
  revalidate:async()=>'stale',
 });
}

// RECOVERY: settles a recorded intent against the actual applied receipt and the stored rows, including an unknown outcome (a lost reply). Read only. States:
//   applied      the receipt of this request id is applied at exactly postRevision with the intent's digest;
//   not_applied  no applied receipt and the Film is still at the planned revision with every pre-image row stored: safe to resume the same intent;
//   unknown      anything else: never guessed, never written, for review.
export async function recoverDimensionRetirement(env,{intent: given}={}){
 const intent=await checkIntent(given);
 const receipt=await readReceipt(env,intent.requestId);
 const db=database(env);
 const revision=(await revisionsOf(db,[intent.id])).get(intent.id)??0,stored=(await rowsOf(db,[intent.id])).get(intent.id)||new Map();
 if(receipt&&(receipt.operation!==RETIRE_OPERATION||receipt.origin!==RETIRE_ORIGIN||receipt.target.kind!=='film'||receipt.target.id!==intent.id||receipt.contentDigest!==intent.digest))return {state:'unknown',reason:'receipt_mismatch',revision};
 if(receipt?.state==='applied'&&receipt.appliedRevision===intent.postRevision)return {state:'applied',revision,atPostRevision:revision===intent.postRevision,intent};
 if(receipt?.state!=='applied'&&revision===intent.plannedRevision&&intent.rows.every(row=>sameImage(imageOf(stored.get(row.dimension)),row.preImage)))return {state:'not_applied',revision,receiptState:receipt?.state??null};
 return {state:'unknown',reason:receipt?.state==='applied'?'applied_revision_mismatch':'moved',revision};
}

const REPLAN=new Set([RETIRE_ROW_CHANGED,'film_person_revision_conflict']);
const portOf=checkpoint=>{
 if(!plain(checkpoint)||typeof checkpoint.record!=='function'||typeof checkpoint.settle!=='function')throw failed('film_person_invalid');
 return checkpoint;
};
// The ONE checkpointed commit of an intent, shared by the apply and the resume. Returns {state:'applied'|'not_applied'|'unknown', errorClass, settleError}. `not_applied` is a definite replan refusal
// (the batch rolled back whole); anything else that is not an applied receipt is `unknown`, never guessed. A failed durable settlement is reported, never swallowed.
async function commitIntent(env,port,intent,{clock,policy}){
 let state,errorClass=null,receiptState=null;
 try{
  const outcome=await writeIntent(env,intent,{clock,policy});
  if(appliedOf(outcome,intent))state='applied';
  else{state='unknown';errorClass=outcome?.errorClass||outcome?.reason||outcome?.state||'unclassified';receiptState=outcome?.state??null;}
 }catch(error){errorClass=error?.code||'unclassified';state=REPLAN.has(errorClass)?'not_applied':'unknown';}
 let settleError=null;
 try{await port.settle(intent,{state,errorClass,receiptState,...(state==='applied'?{revision:intent.postRevision}:{})});}catch(error){settleError=error?.code||'retire_checkpoint_settle_failed';}
 return {state,errorClass,settleError};
}
// Resumes a recorded intent that recovery found `not_applied`. The same durable checkpoint is REQUIRED: the exact intent is recorded (idempotently) BEFORE the write is permitted.
export async function resumeDimensionRetirement(env,{intent: given,checkpoint,now,policy}={}){
 const port=portOf(checkpoint);
 const intent=await checkIntent(given),clock=clockOf(now);
 try{await port.record(intent);}catch(error){throw failed(RETIRE_CHECKPOINT_FAILED,error);}
 return {...await commitIntent(env,port,intent,{clock,policy}),intent};
}

// APPLY: one bounded pass over the Films of the exact allowlist. input: {runId, allowlist, go:{reference,allowlistDigest}, checkpoint:{record,settle}, coverage?, writeCap?, now?, policy?}. Everything
// is validated before anything is read for writing: the allowlist, the GO digest binding the exact allowlist, the checkpoint port, the marker. For each Film (id order, at most writeCap) the stored
// rows, the revision and the stage-1 classification are read in that order; a listed row whose bytes or classification moved is skipped as `moved` (a NEW dry run and GO replan it), the rest becomes
// ONE immutable intent: `checkpoint.record(intent)` must resolve before the delete is permitted, then ONE receipted atomic fenced batch, then `checkpoint.settle`.
// EVERY exit returns what it did: {examined, written:[intent], uncertain:[intent], moved:[{id,dimension?,code}], skipped, stopped, error?}. A Film whose delete may have committed is in `uncertain` with its
// intent (recover it with recoverDimensionRetirement); there is no blind retry.
export async function applyDimensionRetirement(env,{runId,allowlist: given,go,checkpoint,coverage=null,writeCap,now,policy}={}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const allowlist=checkAllowlist(given),port=portOf(checkpoint),approval=await checkGo(go,allowlist);
 const writes=clampCap(writeCap,RETIRE_WRITE_DEFAULT,RETIRE_WRITE_MAX),clock=clockOf(now);
 assertWritable(await readAuthority(env));
 const listed=new Map();
 for(const item of allowlist){if(!listed.has(item.id))listed.set(item.id,new Map());listed.get(item.id).set(item.dimension,item.rowDigest);}
 const ids=[...listed.keys()].sort();
 const out={examined:0,written:[],uncertain:[],moved:[],skipped:[],stopped:null,approval};
 const stop=(id,code,extra={})=>{out.stopped=code;out.failedId=id;out.error={id,code,...extra};};
 let read;
 try{read=await readFilms(env,ids,{coverage});}catch(error){stop(null,error?.code||'unclassified');return out;}
 for(const id of ids){
  if(out.written.length>=writes){out.stopped='write_cap';out.skipped.push(...[...listed.get(id).keys()].map(dimension=>({id,dimension,code:'write_cap'})));continue;}
  out.examined++;
  const revision=read.revisions.get(id)??0,rows=[];
  for(const [dimension,pinned] of [...listed.get(id)].sort((a,b)=>a[0]<b[0]?-1:1)){
   const row=read.rows.get(id)?.get(dimension)||null,decision=retirementDecision(read.classes.get(id)?.get(dimension),row);
   if(!decision.eligible){out.moved.push({id,dimension,code:RETIRE_ROW_CHANGED,reason:decision.reason});continue;}
   if(await rowDigest(row)!==pinned){out.moved.push({id,dimension,code:RETIRE_ROW_CHANGED,reason:'row_digest'});continue;}
   rows.push({dimension,preImage:completeImage(imageOf(row))});
  }
  if(!rows.length)continue;
  let intent;
  try{intent=await intentOf({runId,at:clock(),revision,rows,id});}catch(error){stop(id,error?.code||'unclassified');break;}
  // Fail closed: nothing is deleted for this Film unless its pre-image is durably recorded.
  try{await port.record(intent);}catch(error){stop(id,RETIRE_CHECKPOINT_FAILED,{cause:error?.code||null});break;}
  const result=await commitIntent(env,port,intent,{clock,policy});
  if(result.state==='applied')out.written.push(intent);
  else if(result.state==='not_applied')out.moved.push(...intent.rows.map(row=>({id,dimension:row.dimension,code:result.errorClass})));
  else out.uncertain.push(intent);
  if(result.settleError){stop(id,'retire_checkpoint_settle_failed',{cause:result.settleError});break;}
  if(result.state==='unknown'){stop(id,result.errorClass||'unclassified');break;}
 }
 return out;
}

// RESTORE: one receipted, atomic, fenced restore of ONE Film from its apply intent (the restore token). The token is validated and bound BEFORE any receipt is reserved: a complete, self-consistent
// intent whose own apply receipt exists, is `applied` with the same request id, digest, target and revision, and an open marker. It then restores ONLY what the ADR allows: a row whose
// `(film_id, dimension)` slot is empty, and only while the Film is still at EXACTLY postRevision. Any other state is REPORTED and the newer state retained, writing nothing:
//   {state:'refused', reason:'film_moved', ...}  the Film is past postRevision (or before it): every row is reported `retained_newer_state`;
//   per row `slot_occupied`                      the slot holds a row now: it is left as it is;
//   {state:'nothing_to_restore'}                 no slot is restorable.
// A race between this plan and the batch (the revision or a slot moved) refuses the batch whole (`retire_restore_moved`). A restore bumps the revision, so a second restore of the same token is refused.
export async function restoreDimensionRetirement(env,{runId,token,now,policy}={}){
 const clock=clockOf(now);
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const intent=await checkIntent(token);
 assertWritable(await readAuthority(env));
 const original=await readReceipt(env,intent.requestId);
 if(!original||original.operation!==RETIRE_OPERATION||original.origin!==RETIRE_ORIGIN||original.target.kind!=='film'||original.target.id!==intent.id||original.state!=='applied'||original.appliedRevision!==intent.postRevision||original.contentDigest!==intent.digest)throw failed(RETIRE_UNBOUND);
 const db=database(env);
 const revision=(await revisionsOf(db,[intent.id])).get(intent.id)??0,stored=(await rowsOf(db,[intent.id])).get(intent.id)||new Map();
 if(revision!==intent.postRevision)return {state:'refused',reason:'film_moved',revision,postRevision:intent.postRevision,rows:intent.rows.map(row=>({dimension:row.dimension,status:'retained_newer_state'}))};
 const report=[],restorable=[];
 for(const row of intent.rows){
  if(stored.has(row.dimension))report.push({dimension:row.dimension,status:'slot_occupied'});
  else{restorable.push(row);report.push({dimension:row.dimension,status:'restorable'});}
 }
 if(!restorable.length)return {state:'nothing_to_restore',revision,rows:report};
 const digest=await restoreDigest(intent,restorable);
 const requestId=await retireRequestId({runId,action:'restore',id:intent.id,digest});
 const outcome=await receiptedWrite(env,{requestId,operation:RETIRE_OPERATION,origin:RETIRE_ORIGIN,target:{kind:'film',id:intent.id},expectedRevision:intent.postRevision,digest,now:clock,policy},{
  atomic:true,
  // A restore is fenced on the recorded revision and on every slot, so a replay can never overwrite another writer: the readback proves nothing and the replay is the fenced write itself.
  readback:async()=>({digest:null}),
  revalidate:async()=>'proceed',
  run:ctx=>restoreFilmRows(env,{intent,rows:restorable,at:clock(),receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId,rows:report};
}
async function restoreFilmRows(env,{intent: given,rows,at,receiptMark}={}){
 if(receiptMark===undefined||receiptMark===null)throw failed('film_person_invalid');
 const intent=await checkIntent(given),id=intent.id;
 fenced.text(at);
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 const entities=[{kind:'film',id,expected:intent.postRevision}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 for(const row of rows){
  statements.push(slotEmpty(id,row.dimension));
  statements.push([`INSERT INTO film_dimension (film_id,dimension,${COLUMNS.join(',')}) VALUES (?,?,${COLUMNS.map(()=>'?').join(',')})`,[id,row.dimension,...COLUMNS.map(name=>row.preImage[name])]]);
  statements.push(assertImage(row.preImage,id,row.dimension));
 }
 statements.push([fenced.BUMP,['film',id,at]]);
 if(statements.length>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  if(error?.code==='film_person_revision_conflict'||error?.code==='film_person_precondition')throw failed(RETIRE_RESTORE_MOVED,error);
  throw error;
 }
 return {id,revision:intent.postRevision+1,restored:rows.map(row=>row.dimension)};
}
