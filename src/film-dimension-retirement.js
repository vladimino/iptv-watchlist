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
//   The module imposes no Film-count ceiling: the approved allowlist is the scope. Every entry ends in exactly one bucket (written, uncertain, moved, remaining, before the cursor).
// - PRE-IMAGE BEFORE DELETE. Per Film the immutable intent is the pre-image plus the approval and the proof it was issued under: {id, runId, requestId, digest, at, plannedRevision, postRevision,
//   approval, proof, rows:[{dimension, preImage}]}. An apply REQUIRES the full durable `checkpoint` port and fails closed: `checkpoint.record(intent)` must resolve AND `checkpoint.lookup(requestId)`
//   must return exactly that intent BEFORE the delete is permitted (a checkpoint that cannot be read back could never satisfy recovery or resume); `checkpoint.settle(intent, result)` records the outcome.
//   The caller (the operation) chooses the storage.
// - THE PROOF IS FENCED THROUGH THE DELETE. Classification reads several domains; the Film revision and the row image fence only the target Film. The intent therefore carries the read-set TOKENS the
//   proof stood on, and the ONE batch asserts every one of them again, so a change in any of them after the classification (after the checkpoint, before the commit) rolls the Film back whole:
//   the Film/Person marker generation the parity page was read under; the target's own identity read-set (its external-id claims, the retirement decisions of its tmdb ids, and that no other Film
//   claims one of its tmdb/letterboxd values); for a metadata row the six core fields of film_metadata; for a fingerprint or prediction row the prediction-domain marker generation (every prediction
//   write advances it) and the GUARDS of the coverage supplier (its own proof, as SQL conditions over rows of this database, required: without them no fingerprint or prediction is eligible).
// - FENCES. One fenced, receipted, atomic batch per Film (<= 3 rows): the pinned marker generation and the Film revision CAS in the head, no redirect, the proof tokens, the exact pre-image, the delete
//   guarded by the safe predicate again, the slot asserted empty, the revision bumped (postRevision = plannedRevision + 1: the bump of the retirement's OWN write is part of the recorded post-delete
//   revision), the receipt marked applied in the same batch. A failed assertion rolls the whole Film back.
// - RESUME AND RECOVERY. A recorded intent is never trusted on its own shape: a self-consistent intent can be computed by anyone. Recovery and resume require that the intent was durably issued
//   (`checkpoint.lookup`, equal to the supplied one), and resume also requires the approved allowlist and GO that bind it and RE-PROVES the deletion preconditions (the planned revision, the stored
//   rows, the classification, every proof token and the supplier's guards) before the same request id writes again; a moved proof is reported and never replayed.
// - RESTORE. Only an empty `(film_id, dimension)` slot, and only while the Film is still at exactly the recorded post-delete revision; any other state is reported and the newer state is retained.
//   Code revert is not data rollback: a deploy removes this module and restores no row.
// - NO INVENTED CEILINGS. The only bounds are real ones: the parity reader's own page (PARITY_PAGE_MAX Films per call), the statement cap of one fenced batch, the D1 provider limit of 1,000
//   queries per Worker invocation (every execution of the pass is counted and the limit is ENFORCED by the meter; a stop is normal continuation with explicit row-level `remaining`), and the optional
//   `maxFilms` the approved operation chooses for itself.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {canonicalJson,defineOperation,digestOf,readReceipt,receiptedWrite,requestIdOf} from './canonical-receipts.js';
import {PROTECTED_ROW_SQL,protectedReasons} from './canonical-repository.js';
import {PARITY_PAGE_DEFAULT,PARITY_PAGE_MAX,readDimensionParity} from './film-dimension-parity.js';
import {countedEnv} from './film-localization-reconciler.js';

export const RETIRE_OPERATION='film_dimension_retire';
export const RETIRE_ORIGIN='dimension_retirement';
// The only dimensions this stage may ever retire (ADR 0218 decision 7 stage 6).
export const RETIRABLE_DIMENSIONS=Object.freeze(['fingerprint','metadata','prediction']);
// D1 allows 1,000 queries per Worker invocation on Paid and counts a db.batch() as ONE query (https://developers.cloudflare.com/d1/platform/limits/, as measured in src/film-localization-reconciler.js).
// A call COUNTS every D1 execution it makes and the shared meter ENFORCES the budget: an execution beyond it is refused locally and never sent. Before a Film the pass stops when the next one would
// not fit, a counted stop against the provider limit, not a product quota. The per-Film estimate seeds the first Film (a fixture measured at most 13 queries per applied Film) and is replaced by the
// largest cost actually seen; the chunk reserve covers the parity read of a chunk. Both are PLANNING MARGINS that choose where to stop; they are not the bound, the refusal is.
export const RETIRE_D1_QUERY_LIMIT=1000;
const FILM_QUERY_ESTIMATE=16,CHUNK_READ_RESERVE=100;
export const RETIRE_INTENT_REQUIRED='retire_intent_required';
export const RETIRE_INTENT_UNRECORDED='retire_intent_unrecorded';
export const RETIRE_INTENT_UNBOUND='retire_intent_unbound';
export const RETIRE_UNBOUND='retire_restore_unbound';
export const RETIRE_RESTORE_MOVED='retire_restore_moved';
export const RETIRE_CHECKPOINT_FAILED='retire_checkpoint_failed';
export const RETIRE_ROW_CHANGED='retire_row_changed';
export const RETIRE_PROOF_MOVED='retire_proof_moved';
export const RETIRE_GO_MISMATCH='retire_go_mismatch';
export const RETIRE_PAGE_MOVED='retire_page_moved';
export const GUARDS_MAX=8;
const COLUMNS=['status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at'];
const SELECT_COLUMNS='film_id,dimension,'+COLUMNS.join(',');
const DIGEST=/^[0-9a-f]{64}$/;
const FILM=/^film:.+/;
const GO_REFERENCE=/^https:\/\/\S{1,480}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});
const sameImage=(a,b)=>canonicalJson(a??null)===canonicalJson(b??null);
const imageOf=row=>row?Object.fromEntries(COLUMNS.map(name=>[name,row[name]??null])):null;
const byDimension=(a,b)=>a.dimension<b.dimension?-1:a.dimension>b.dimension?1:0;
const idOrder=(a,b)=>a.id<b.id?-1:a.id>b.id?1:byDimension(a,b);
const isPredictionDimension=name=>name==='fingerprint'||name==='prediction';
// The one SQL rule of what a retirement may delete (the importer's protected-row predicate, negated): fingerprint, prediction and metadata rows that are not control and not unknown_legacy.
// PROTECTED_ROW_SQL is NULL (not 0) for a row with no authority whose other terms are false (three-valued OR), and `NOT NULL` is NULL: the negation must be NULL-safe, or a plain copy would never match.
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

// ---- the proof read-set, as SQL tokens ----
// Each fragment is read ONCE before the classification and asserted again INSIDE the deleting batch: the same text both times, so the token is the engine's own answer, not a re-computation.
// A token is a JSON array text (printable, escaped, unambiguous whatever the values hold), never a delimiter-joined string.
const CLAIMS_SQL="SELECT json_group_array(json(t)) FROM (SELECT json_array(scheme,value,trusted,conflicting) AS t FROM film_external_id WHERE film_id=? ORDER BY scheme,value)";
const RETIRED_SQL="SELECT json_group_array(json(t)) FROM (SELECT json_array(seq,movie_id,kind,supersedes_seq) AS t FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM film_external_id WHERE film_id=? AND scheme='tmdb') ORDER BY seq)";
const COMPETING_SQL="SELECT EXISTS (SELECT 1 FROM film_external_id o JOIN film_external_id m ON m.film_id=? AND m.scheme=o.scheme AND m.value=o.value WHERE o.film_id<>? AND o.scheme IN ('tmdb','letterboxd'))";
const METADATA_SQL='SELECT json_array(year,runtime,synopsis,poster,url,genres_json) FROM film_metadata WHERE film_id=?';
const PREDICTION_PIN_SQL="EXISTS (SELECT 1 FROM prediction_domain_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)";
const primitive=value=>value===null||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value));
// Guards of the coverage supplier: caller-supplied proof conditions (internal code only, never request input), each ONE SQL boolean over rows of this database with its bound params, asserted inside
// the batch exactly as the AIR-559 `guards` of mutateFilm. Malformed or oversized guards are no guards.
function guardsOf(value){
 if(!Array.isArray(value)||!value.length||value.length>GUARDS_MAX)return [];
 const out=[];
 for(const guard of value){
  if(!plain(guard)||typeof guard.sql!=='string'||!guard.sql.trim()||!Array.isArray(guard.params)||!guard.params.every(primitive))return [];
  out.push({sql:guard.sql,params:[...guard.params]});
 }
 return out;
}
async function readTokens(db,id,{retirementTable}){
 const row=await one(db,`SELECT (${CLAIMS_SQL}) AS claims,${retirementTable?`(${RETIRED_SQL})`:'NULL'} AS retired,(${COMPETING_SQL}) AS competing,(${METADATA_SQL}) AS metadata`,retirementTable?[id,id,id,id,id]:[id,id,id,id]);
 return {claims:row.claims,retired:retirementTable?row.retired:null,competing:Number(row.competing),metadata:row.metadata??null};
}
// The assertions of an intent's proof, appended to the deleting batch (and nowhere else).
function proofStatements(id,proof){
 const out=[[fenced.assertSql(`(${CLAIMS_SQL})=?`),[id,proof.claims]]];
 if(proof.retired!==null)out.push([fenced.assertSql(`(${RETIRED_SQL})=?`),[id,proof.retired]]);
 out.push([fenced.assertSql(`(${COMPETING_SQL})=0`),[id,id]]);
 if(proof.metadata!==null)out.push([fenced.assertSql(`(${METADATA_SQL}) IS ?`),[id,proof.metadata]]);
 if(proof.prediction!==null)out.push([fenced.assertSql(PREDICTION_PIN_SQL),[proof.prediction]]);
 for(const guard of proof.guards)out.push([fenced.assertSql(guard.sql),guard.params]);
 return out;
}

// ---- pure: the safe-delete rule, the row digest, the allowlist ----

// PURE. Whether a classified row (an item of readDimensionParity().classified) is a retirement candidate, and otherwise why it is retained. `row` is the stored row (the JS twin of the SQL rule is
// checked again on it). Reasons are stable codes: dimension_not_retirable, class_<class>, proof_<proof>, film_redirected, protected_row, row_absent.
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
export const rowDigestOf=(id,dimension,image)=>digestOf({film_id:id,dimension,image:completeImage(image)});
export const rowDigest=row=>rowDigestOf(row.film_id,row.dimension,imageOf(row));
// The canonical, validated allowlist: unique `{id, dimension, rowDigest}` entries in id and dimension order, only retirable dimensions. No length ceiling: the approved list is the scope.
export function checkAllowlist(value){
 if(!Array.isArray(value)||!value.length)throw failed('film_person_invalid');
 const seen=new Set(),out=[];
 for(const item of value){
  if(!plain(item)||Object.keys(item).sort().join()!=='dimension,id,rowDigest'||typeof item.id!=='string'||!FILM.test(item.id)||!RETIRABLE_DIMENSIONS.includes(item.dimension)||!DIGEST.test(item.rowDigest||''))throw failed('film_person_invalid');
  const key=item.id+'\u0000'+item.dimension;
  if(seen.has(key))throw failed('film_person_invalid');
  seen.add(key);
  out.push({id:item.id,dimension:item.dimension,rowDigest:item.rowDigest});
 }
 return out.sort(idOrder);
}
export const allowlistDigest=allowlist=>digestOf({operation:RETIRE_OPERATION,allowlist:checkAllowlist(allowlist)});
// The owner GO of an operation names the exact allowlist: {reference (an https link to the recorded GO), allowlistDigest}. A GO for another allowlist authorizes nothing.
async function checkGo(go,allowlist){
 if(!plain(go)||typeof go.reference!=='string'||!GO_REFERENCE.test(go.reference)||!DIGEST.test(go.allowlistDigest||''))throw failed('film_person_invalid');
 if(go.allowlistDigest!==await allowlistDigest(allowlist))throw failed(RETIRE_GO_MISMATCH);
 return {reference:go.reference,allowlistDigest:go.allowlistDigest};
}

// ---- the intent (the pre-image contract) ----

function checkProof(value,rows){
 if(!plain(value)||Object.keys(value).sort().join()!=='claims,filmPerson,guards,metadata,prediction,retired')throw failed('film_person_invalid');
 if(!Number.isInteger(value.filmPerson)||value.filmPerson<0||typeof value.claims!=='string'||!(value.retired===null||typeof value.retired==='string')||!(value.metadata===null||typeof value.metadata==='string'))throw failed('film_person_invalid');
 const prediction=rows.some(row=>isPredictionDimension(row.dimension)),metadata=rows.some(row=>row.dimension==='metadata');
 if(prediction){if(!Number.isInteger(value.prediction)||value.prediction<0||!Array.isArray(value.guards)||!guardsOf(value.guards).length||guardsOf(value.guards).length!==value.guards.length)throw failed('film_person_invalid');}
 else if(value.prediction!==null||!Array.isArray(value.guards)||value.guards.length)throw failed('film_person_invalid');
 if(metadata!==(value.metadata!==null))throw failed('film_person_invalid');
 return {filmPerson:value.filmPerson,prediction:value.prediction,claims:value.claims,retired:value.retired,metadata:value.metadata,guards:guardsOf(value.guards)};
}
function checkApproval(value){
 if(!plain(value)||Object.keys(value).sort().join()!=='allowlistDigest,reference'||typeof value.reference!=='string'||!GO_REFERENCE.test(value.reference)||!DIGEST.test(value.allowlistDigest||''))throw failed('film_person_invalid');
 return {reference:value.reference,allowlistDigest:value.allowlistDigest};
}
// What a retirement receipt binds: the Film, the rule, the approval and the proof the intent was issued under, every pre-image row, the stable time and the planned revision. A moved state is a NEW
// intent, never a replay under the old one.
export function retireContent({id,rows,at,plannedRevision,approval,proof}){
 if(typeof id!=='string'||!FILM.test(id)||!Array.isArray(rows)||!rows.length||rows.length>RETIRABLE_DIMENSIONS.length||typeof at!=='string'||!Number.isInteger(plannedRevision))throw failed('film_person_invalid');
 return {kind:'film',action:'retire',rule:'adr0218_stage6_v2',rows:rows.map(row=>({dimension:row.dimension,preImage:row.preImage})),at,plannedRevision,approval,proof};
}
export const retireDigest=input=>digestOf({operation:RETIRE_OPERATION,id:input?.id,content:retireContent(input)});
// A fresh request id per run, Film, action and digest.
export async function retireRequestId({runId,action='retire',id,digest}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200||typeof id!=='string'||!DIGEST.test(digest||''))throw failed('film_person_invalid');
 return requestIdOf({origin:RETIRE_ORIGIN,operation:RETIRE_OPERATION,source:{runId,action,id,digest}});
}
const restoreDigest=(intent,rows)=>digestOf({operation:RETIRE_OPERATION,id:intent.id,content:{kind:'film',action:'restore',applyRequestId:intent.requestId,applyDigest:intent.digest,rows,postRevision:intent.postRevision}});
async function intentOf({runId,at,revision,rows,id,approval,proof}){
 const base={id,rows,at,plannedRevision:revision,approval,proof};
 const digest=await retireDigest(base);
 return {version:1,id,runId,requestId:await retireRequestId({runId,id,digest}),digest,at,plannedRevision:revision,postRevision:revision+1,approval,proof,rows};
}
// Validates an intent supplied by a caller (a checkpoint read back, a restore token): strict shape, complete pre-images of retirable dimensions in dimension order with no repeats, the approval and the
// proof in their exact shapes, and a digest and request id that recompute from the content. Nothing here reads the database, and a valid shape proves NOTHING about who issued the intent:
// recovery and resume additionally require that the checkpoint recorded it.
export async function checkIntent(value){
 if(!plain(value)||value.version!==1||typeof value.id!=='string'||!FILM.test(value.id)||typeof value.runId!=='string'||!value.runId.trim()||typeof value.requestId!=='string'||!DIGEST.test(value.digest||''))throw failed('film_person_invalid');
 if(typeof value.at!=='string'||!ISO.test(value.at)||!Number.isInteger(value.plannedRevision)||value.plannedRevision<0||value.postRevision!==value.plannedRevision+1||!Array.isArray(value.rows)||!value.rows.length||value.rows.length>RETIRABLE_DIMENSIONS.length)throw failed('film_person_invalid');
 const rows=value.rows.map(item=>{
  if(!plain(item)||Object.keys(item).sort().join()!=='dimension,preImage'||!RETIRABLE_DIMENSIONS.includes(item.dimension))throw failed('film_person_invalid');
  return {dimension:item.dimension,preImage:completeImage(item.preImage)};
 });
 if(new Set(rows.map(row=>row.dimension)).size!==rows.length||rows.some((row,index)=>index&&byDimension(rows[index-1],row)>=0))throw failed('film_person_invalid');
 const intent={version:1,id:value.id,runId:value.runId,requestId:value.requestId,digest:value.digest,at:value.at,plannedRevision:value.plannedRevision,postRevision:value.postRevision,approval:checkApproval(value.approval),proof:checkProof(value.proof,rows),rows};
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
const hasRetirementTable=async db=>!!(await one(db,"SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tmdb_retirement_decision'"));
// ORDER MATTERS: the Film revision, the stored rows and the proof tokens are read BEFORE the parity classification; the deleting batch asserts the revision, the pre-images and EVERY token it read
// here, plus the marker generations the parity page was read under (`pins`). A change in any of those domains between this read and the commit fails the batch, so a classification never outlives the
// state it judged. The coverage supplier is wrapped so that its guards (its own proof) are captured with its verdict.
async function readFilms(env,ids,{coverage}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const revisions=await revisionsOf(db,ids),rows=await rowsOf(db,ids),retirementTable=await hasRetirementTable(db);
 const tokens=new Map();
 try{for(const id of ids)tokens.set(id,await readTokens(db,id,{retirementTable}));}
 catch(error){throw error?.code?error:failed('film_person_unavailable',error);}
 const guards=new Map();
 const supplier=typeof coverage==='function'?(id,aliases)=>{const result=coverage(id,aliases);guards.set(id,guardsOf(result?.guards));return result;}:null;
 let parity;
 try{parity=await readDimensionParity(env,{ids,limit:Math.max(ids.length,1),coverage:supplier});}
 catch(error){throw error?.code?error:failed('film_person_unavailable',error);}
 const wanted=new Set(ids);
 if(parity.classified.some(item=>!wanted.has(item.film_id)))throw failed(RETIRE_PAGE_MOVED);
 const classes=new Map();
 for(const item of parity.classified){if(!classes.has(item.film_id))classes.set(item.film_id,new Map());classes.get(item.film_id).set(item.dimension,item);}
 return {revisions,rows,classes,parity,pins:parity.pins,guards,tokens,retirementTable};
}
// The ONE eligibility of a stored row, shared by the dry run, the apply and the resume: the classification, plus the proof tokens it must be fenced by.
function evaluate(read,id,dimension){
 const row=read.rows.get(id)?.get(dimension)||null,decision=retirementDecision(read.classes.get(id)?.get(dimension),row);
 if(!decision.eligible)return decision;
 if(!Number.isInteger(read.pins?.filmPerson))return {eligible:false,reason:'film_person_marker_unavailable'};
 if(read.tokens.get(id)?.competing!==0)return {eligible:false,reason:'identity_competing_claim'};
 if(isPredictionDimension(dimension)){
  if(!Number.isInteger(read.pins?.prediction))return {eligible:false,reason:'prediction_marker_unavailable'};
  if(!read.guards.get(id)?.length)return {eligible:false,reason:'coverage_unguarded'};
 }
 return {eligible:true,reason:null,row};
}
// The proof an intent over `rows` is issued under, from what was read.
function proofOfRows(read,id,rows){
 const tokens=read.tokens.get(id),prediction=rows.some(row=>isPredictionDimension(row.dimension)),metadata=rows.some(row=>row.dimension==='metadata');
 return {filmPerson:read.pins.filmPerson,prediction:prediction?read.pins.prediction:null,claims:tokens.claims,retired:read.retirementTable?tokens.retired:null,metadata:metadata?tokens.metadata:null,guards:prediction?read.guards.get(id):[]};
}
// One keyset page of RAW Film ids in id order (limit + 1 to learn whether more follow).
async function filmPage(env,{after,limit}){
 try{return (await many(database(env),'SELECT id FROM film WHERE id>? ORDER BY id LIMIT ?',[after,limit+1])).map(row=>row.id);}
 catch(error){throw failed('film_person_unavailable',error);}
}
const pageOf=(value,fallback,max)=>{
 if(value===undefined||value===null)return fallback;
 if(!Number.isInteger(value)||value<1||value>max)throw failed('film_person_invalid');
 return value;
};
const cursorOf=value=>{if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||!value.startsWith('film:'))throw failed('film_person_invalid');return value;};
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};

// DRY RUN: read only. One keyset page of Films (the parity reader's own page: default PARITY_PAGE_DEFAULT, at most PARITY_PAGE_MAX): the eligible rows (the proposed allowlist, each pinned by
// rowDigest and the Film revision), and the RETAINED rows counted by reason, so the report names what stays and why. The page IS the scope: the approved operation chooses how many pages and which
// rows form its allowlist. `coverage(filmId, aliases)` is the parity reader's candidate-coverage supplier and must return `{status, reason?, guards}`: its guards (its proof as SQL conditions) are what
// the deleting batch asserts again; a fingerprint or prediction row without them is retained (`coverage_unguarded`), and without a supplier none is ever eligible. Returns
// {examined, cursor, hasMore, eligible:[{id,dimension,rowDigest,revision}], retained:{byReason, byDimension}, allowlist, allowlistDigest, films, markers}.
export async function dryRunDimensionRetirement(env,{after,limit,coverage=null}={}){
 const examineCap=pageOf(limit,PARITY_PAGE_DEFAULT,PARITY_PAGE_MAX),start=cursorOf(after);
 await readAuthority(env);
 const page=await filmPage(env,{after:start,limit:examineCap}),ids=page.slice(0,examineCap);
 const out={examined:ids.length,cursor:ids.length?ids.at(-1):start,hasMore:page.length>examineCap,eligible:[],retained:{byReason:{},byDimension:{}},allowlist:[],allowlistDigest:null,films:0,markers:null};
 if(!ids.length)return out;
 const read=await readFilms(env,ids,{coverage});
 out.markers=read.parity.markers;
 const films=new Set();
 for(const id of ids){
  for(const [dimension] of read.classes.get(id)||[]){
   const decision=evaluate(read,id,dimension);
   if(!decision.eligible){bump(out.retained.byReason,dimension+':'+decision.reason);bump(out.retained.byDimension,dimension);continue;}
   out.eligible.push({id,dimension,rowDigest:await rowDigest(decision.row),revision:read.revisions.get(id)??0});
   films.add(id);
  }
 }
 out.allowlist=out.eligible.map(item=>({id:item.id,dimension:item.dimension,rowDigest:item.rowDigest}));
 out.films=films.size;
 if(out.allowlist.length)out.allowlistDigest=await allowlistDigest(out.allowlist);
 return out;
}

// ---- the fenced write ----

// The fenced retirement of ONE Film FROM ITS INTENT. It trusts nothing but the intent: the marker generation, the stored revision, the pre-images and every proof token are asserted INSIDE the batch.
// PRIVATE: reachable only through the checkpointed, receipted path.
async function writeFilmRetirement(env,{intent: given,receiptMark}={}){
 if(receiptMark===undefined||receiptMark===null)throw failed('film_person_invalid');
 const intent=await checkIntent(given);
 const id=intent.id,expected=intent.plannedRevision;
 const tail=fenced.receiptTail(receiptMark,{kind:'film',id});
 const gate=fenced.bindProducerFence(env,assertWritable(await readAuthority(env)));
 // The proof was read under ONE Film/Person generation: a marker that moved since is a different authority epoch, and the batch (which carries the generation it was built with) must not run under it.
 if(gate.generation!==intent.proof.filmPerson)throw failed('film_person_fence');
 const db=database(env);
 const revision=(await revisionsOf(db,[id])).get(id)??0;
 if(revision!==expected)throw failed('film_person_revision_conflict');
 const stored=(await rowsOf(db,[id])).get(id)||new Map();
 for(const row of intent.rows)if(!sameImage(imageOf(stored.get(row.dimension)),row.preImage))throw failed(RETIRE_ROW_CHANGED);
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(...proofStatements(id,intent.proof));
 for(const row of intent.rows){
  statements.push(assertImage(row.preImage,id,row.dimension));
  statements.push([`DELETE FROM film_dimension WHERE film_id=? AND dimension=? AND ${SAFE_DELETE_SQL}`,[id,row.dimension]]);
  statements.push(slotEmpty(id,row.dimension));
 }
 statements.push([fenced.BUMP,['film',id,intent.at]]);
 if(statements.length>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  // The head proves the marker and the revision (named by commit); the remaining assertions are the proof tokens, the row itself and the safe predicate: something moved or is protected NOW.
  if(error?.code==='film_person_precondition')throw failed(RETIRE_PROOF_MOVED,error);
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

// ---- the checkpoint port ----

// {record(intent), settle(intent, result), lookup(requestId)}: the operation's durable store. An apply needs record and settle; recovery needs lookup; resume needs lookup and settle (it never records:
// a resume does not create a checkpoint, it continues one that already exists).
function portOf(checkpoint,need){
 if(!plain(checkpoint)||need.some(name=>typeof checkpoint[name]!=='function'))throw failed('film_person_invalid');
 return checkpoint;
}
// The intent is the one the checkpoint durably issued: the lookup of its request id returns an intent equal, byte for byte after validation, to the one supplied.
async function recordedIntent(port,intent){
 let found;
 try{found=await port.lookup(intent.requestId);}catch(error){throw failed(RETIRE_CHECKPOINT_FAILED,error);}
 if(found===null||found===undefined)throw failed(RETIRE_INTENT_UNRECORDED);
 let checked;
 try{checked=await checkIntent(found);}catch{throw failed(RETIRE_INTENT_UNRECORDED);}
 if(canonicalJson(checked)!==canonicalJson(intent))throw failed(RETIRE_INTENT_UNRECORDED);
 return checked;
}
// What the stored receipt and rows say about a recorded intent. Read only.
async function settleState(env,intent){
 const receipt=await readReceipt(env,intent.requestId);
 const db=database(env);
 const revision=(await revisionsOf(db,[intent.id])).get(intent.id)??0,stored=(await rowsOf(db,[intent.id])).get(intent.id)||new Map();
 if(receipt&&(receipt.operation!==RETIRE_OPERATION||receipt.origin!==RETIRE_ORIGIN||receipt.target.kind!=='film'||receipt.target.id!==intent.id||receipt.contentDigest!==intent.digest))return {state:'unknown',reason:'receipt_mismatch',revision};
 if(receipt?.state==='applied'&&receipt.appliedRevision===intent.postRevision)return {state:'applied',revision,atPostRevision:revision===intent.postRevision,intent};
 if(receipt?.state!=='applied'&&revision===intent.plannedRevision&&intent.rows.every(row=>sameImage(imageOf(stored.get(row.dimension)),row.preImage)))return {state:'not_applied',revision,receiptState:receipt?.state??null};
 return {state:'unknown',reason:receipt?.state==='applied'?'applied_revision_mismatch':'moved',revision};
}
// RECOVERY: settles a RECORDED intent against the actual applied receipt and the stored rows, including an unknown outcome (a lost reply). Read only. An intent the checkpoint did not issue is refused
// (`retire_intent_unrecorded`): a valid shape proves nothing about who built it. States:
//   applied      the receipt of this request id is applied at exactly postRevision with the intent's digest;
//   not_applied  no applied receipt and the Film is still at the planned revision with every pre-image row stored (resumable under the same request id, after a re-proof);
//   unknown      anything else: never guessed, never written, for review.
export async function recoverDimensionRetirement(env,{intent: given,checkpoint}={}){
 const port=portOf(checkpoint,['lookup']);
 const intent=await checkIntent(given);
 await recordedIntent(port,intent);
 return settleState(env,intent);
}

const REPLAN=new Set([RETIRE_ROW_CHANGED,RETIRE_PROOF_MOVED,'film_person_revision_conflict','film_person_fence']);
// The ONE checkpointed commit of an intent, shared by the apply and the resume. Returns {state:'applied'|'not_applied'|'unknown', errorClass, settleError}. `not_applied` is a definite replan refusal
// (the batch rolled back whole); anything else that is not an applied receipt is `unknown`, never guessed. A failed durable settlement is reported, never swallowed.
async function commitIntent(env,port,intent,{clock,policy}){
 let state,errorClass=null,receiptState=null;
 try{
  const outcome=await writeIntent(env,intent,{clock,policy});
  if(appliedOf(outcome,intent))state='applied';
  else{state='unknown';errorClass=outcome?.errorClass||outcome?.reason||outcome?.state||'unclassified';receiptState=outcome?.state??null;}
 }catch(error){errorClass=budgetRefused(error)?'d1_query_budget':error?.code||'unclassified';state=REPLAN.has(errorClass)?'not_applied':'unknown';}
 let settleError=null;
 try{await port.settle(intent,{state,errorClass,receiptState,...(state==='applied'?{revision:intent.postRevision}:{})});}catch(error){settleError=error?.code||'retire_checkpoint_settle_failed';}
 return {state,errorClass,settleError};
}
// The deletion preconditions of a RECORDED intent, proved again against the present state: the planned revision, every stored row, the classification (stale copy, proof complete), every token and
// pin of the intent's proof, and the guards the coverage supplier produces NOW. Returns null when they all hold, otherwise the reason.
async function reprove(env,intent,{coverage}){
 const read=await readFilms(env,[intent.id],{coverage});
 if((read.revisions.get(intent.id)??0)!==intent.plannedRevision)return 'film_person_revision_conflict';
 for(const row of intent.rows){
  if(!sameImage(imageOf(read.rows.get(intent.id)?.get(row.dimension)),row.preImage))return RETIRE_ROW_CHANGED;
  const decision=evaluate(read,intent.id,row.dimension);
  if(!decision.eligible)return decision.reason;
 }
 if(canonicalJson(proofOfRows(read,intent.id,intent.rows))!==canonicalJson(intent.proof))return RETIRE_PROOF_MOVED;
 return null;
}
// Resumes a RECORDED intent that recovery found `not_applied`. input: {intent, allowlist, go, checkpoint:{lookup,settle}, coverage?, now?, policy?}. It never records an intent: it requires that the
// checkpoint issued exactly this one (`retire_intent_unrecorded`), that the approved allowlist and GO bind it (`retire_intent_unbound`: the approval of the intent, its Film, dimensions and the row
// digest of every pre-image), that recovery says `not_applied` (an applied intent returns `applied`, a moved or unreadable one `unknown`, neither is written), and that the deletion preconditions
// still hold; otherwise it reports `moved` with the reason, settles the checkpoint as `not_applied`, and writes nothing. Only then the SAME request id and digest write under the same fences.
export async function resumeDimensionRetirement(env,{intent: given,allowlist: list,go,checkpoint,coverage=null,now,policy}={}){
 const port=portOf(checkpoint,['lookup','settle']);
 const intent=await checkIntent(given),clock=clockOf(now);
 const allowlist=checkAllowlist(list),approval=await checkGo(go,allowlist);
 if(intent.approval.reference!==approval.reference||intent.approval.allowlistDigest!==approval.allowlistDigest)throw failed(RETIRE_INTENT_UNBOUND);
 for(const row of intent.rows){
  const listed=allowlist.find(item=>item.id===intent.id&&item.dimension===row.dimension);
  if(!listed||listed.rowDigest!==await rowDigestOf(intent.id,row.dimension,row.preImage))throw failed(RETIRE_INTENT_UNBOUND);
 }
 await recordedIntent(port,intent);
 assertWritable(await readAuthority(env));
 const found=await settleState(env,intent);
 if(found.state!=='not_applied')return {...found,intent};
 let reason;
 try{reason=await reprove(env,intent,{coverage});}catch(error){throw error?.code?error:failed('film_person_unavailable',error);}
 if(reason!==null){
  let settleError=null;
  try{await port.settle(intent,{state:'not_applied',errorClass:RETIRE_PROOF_MOVED,receiptState:found.receiptState});}catch(error){settleError=error?.code||'retire_checkpoint_settle_failed';}
  return {state:'moved',reason,settleError,intent};
 }
 return {...await commitIntent(env,port,intent,{clock,policy}),intent};
}

// The refusal of an execution beyond the budget reaches the pass wrapped by whichever reader or writer was running; it is recognised anywhere in the cause chain.
const budgetRefused=error=>{for(let item=error,depth=0;item&&depth<8;item=item.cause,depth++)if(item.code==='d1_query_budget')return true;return false;};
const budgetOf=value=>{
 if(value===undefined||value===null)return RETIRE_D1_QUERY_LIMIT;
 if(!Number.isInteger(value)||value<1||value>RETIRE_D1_QUERY_LIMIT)throw failed('film_person_invalid');
 return value;
};
// APPLY: one pass over the Films of the exact allowlist. input: {runId, allowlist, go:{reference,allowlistDigest}, checkpoint:{record,settle,lookup}, coverage?, after?, maxFilms?, queryBudget?, now?, policy?}.
// Everything is validated before anything is read: the allowlist, the GO digest binding the exact allowlist, the FULL checkpoint port (a port that cannot return what it recorded could never satisfy
// recovery or resume, so it is refused at entry, before any delete), the budget. Films are processed in id order after `after` (the cursor of a previous pass); for each, the stored rows, the revision
// and the proof tokens are read BEFORE the stage-1 classification. A listed row whose bytes, classification or proof moved is skipped as `moved` (a NEW dry run and GO replan it); the rest becomes ONE
// immutable intent carrying the approval and the proof it stands on: `checkpoint.record(intent)` must resolve AND `checkpoint.lookup` must return exactly that intent before the delete is permitted
// (nothing is deleted on a checkpoint that cannot be read back), then ONE receipted atomic fenced batch that asserts the proof again, then `checkpoint.settle`.
// BUDGET. The pass meters EVERY D1 execution it makes (the authority read, the parity read, the proof reads, the receipts and the batches) through the shared counter, and that counter ENFORCES the
// budget: an execution beyond `queryBudget` (at most the provider's 1,000 per invocation) is refused locally and never sent. The estimates (16 per Film, 100 per chunk read) are only planning margins
// for stopping BEFORE a Film that would not fit; the refusal is the bound. A pass that cannot start, or whose chunk read is refused, ends with `stopped: 'd1_query_budget'` and everything in `remaining`.
// ACCOUNTING IS BY ROW. Every allowlist entry is in exactly ONE of `written`, `uncertain`, `moved`, `remaining` or `beforeCursor`, whatever happens to its Film: a row already reported `moved` stays
// `moved` when another row of the same Film then fails to be issued, and only the rows without a disposition are `remaining`. `cursor` is the last Film fully processed, so a stopped Film is after it.
// CONTINUATION. Pass `cursor` as `after` with the same allowlist and GO. A Film that stopped with mixed results is processed again as a whole: its rows that were `moved` are evaluated again against the
// present state and are deleted only if they are now exactly the rows the allowlist digest names; its `remaining` rows are processed. A Film in `uncertain` (a delete that may have committed, or an
// outcome that could not be settled) is NEVER replayed by apply: recover it first (recoverDimensionRetirement, then resumeDimensionRetirement for a `not_applied` one); a continuation then finds its rows
// absent (reported `moved` with `row_absent`) or still present, and acts only on a fresh intent under the same fences. No blind retry.
export async function applyDimensionRetirement(env,{runId,allowlist: given,go,checkpoint,coverage=null,after,maxFilms,queryBudget,now,policy}={}){
 if(typeof runId!=='string'||!runId.trim()||runId.length>200)throw failed('film_person_invalid');
 const allowlist=checkAllowlist(given),port=portOf(checkpoint,['record','settle','lookup']),approval=await checkGo(go,allowlist);
 if(maxFilms!==undefined&&(!Number.isInteger(maxFilms)||maxFilms<1))throw failed('film_person_invalid');
 const limit=budgetOf(queryBudget),start=cursorOf(after),clock=clockOf(now);
 const listed=new Map();
 for(const item of allowlist){if(!listed.has(item.id))listed.set(item.id,new Map());listed.get(item.id).set(item.dimension,item.rowDigest);}
 const ids=[...listed.keys()].sort(),pending=ids.filter(id=>id>start);
 const out={examined:0,written:[],uncertain:[],moved:[],remaining:[],beforeCursor:allowlist.filter(item=>item.id<=start).map(item=>({id:item.id,dimension:item.dimension})),cursor:start,stopped:null,approval,d1Queries:0,d1QueryLimit:limit,maxQueriesPerFilm:0};
 const disposed=new Set(),keyOf=(id,dimension)=>id+'\u0000'+dimension;
 const moved=(id,dimension,code,reason)=>{disposed.add(keyOf(id,dimension));out.moved.push({id,dimension,code,...(reason?{reason}:{})});};
 const issued=(list,bucket)=>{for(const row of list.rows)disposed.add(keyOf(list.id,row.dimension));bucket.push(list);};
 const stop=(id,code,extra={})=>{out.stopped=code;if(id!==null&&code!=='d1_query_budget'){out.failedId=id;out.error={id,code,...extra};}};
 const finish=counter=>{
  // Explicit accounting by row: whatever has no disposition is named, never silently dropped, and never named twice.
  for(const id of pending)for(const dimension of listed.get(id).keys())if(!disposed.has(keyOf(id,dimension)))out.remaining.push({id,dimension});
  out.d1Queries=counter.n;
  return out;
 };
 const {env:counted,counter}=countedEnv(env,{limit});
 // The authority read is a D1 execution of this pass like any other: it is counted, and refused when the budget cannot cover it.
 try{assertWritable(await readAuthority(counted));}
 catch(error){if(budgetRefused(error)){stop(null,'d1_query_budget');return finish(counter);}throw error;}
 const done=new Set();
 const perFilm=()=>Math.max(out.maxQueriesPerFilm,FILM_QUERY_ESTIMATE);
 chunks:for(let queue=[...pending];queue.length&&!out.stopped;){
  if(maxFilms!==undefined&&done.size>=maxFilms){stop(null,'films_limit');break;}
  // The chunk is as large as the planning margins say the budget allows; the enforced counter is what actually bounds it.
  const room=limit-counter.n-CHUNK_READ_RESERVE,take=Math.min(PARITY_PAGE_MAX,Math.floor(room/perFilm()),queue.length,maxFilms===undefined?Infinity:maxFilms-done.size);
  if(take<1){stop(null,'d1_query_budget');break;}
  const chunk=queue.splice(0,take);
  let read;
  try{read=await readFilms(counted,chunk,{coverage});}catch(error){stop(null,budgetRefused(error)?'d1_query_budget':error?.code||'unclassified');break;}
  for(const id of chunk){
   if(counter.n+perFilm()>limit){stop(null,'d1_query_budget');break chunks;}
   const before=counter.n;
   out.examined++;
   const revision=read.revisions.get(id)??0,rows=[];
   for(const [dimension,pinned] of [...listed.get(id)].sort((a,b)=>a[0]<b[0]?-1:1)){
    const decision=evaluate(read,id,dimension);
    if(!decision.eligible){moved(id,dimension,RETIRE_ROW_CHANGED,decision.reason);continue;}
    if(await rowDigest(decision.row)!==pinned){moved(id,dimension,RETIRE_ROW_CHANGED,'row_digest');continue;}
    rows.push({dimension,preImage:completeImage(imageOf(decision.row))});
   }
   if(!rows.length){done.add(id);out.cursor=id;continue;}
   let intent;
   try{intent=await intentOf({runId,at:clock(),revision,rows,id,approval,proof:proofOfRows(read,id,rows)});}catch(error){stop(id,error?.code||'unclassified');break chunks;}
   // Fail closed: nothing is deleted for this Film unless its pre-image is durably recorded AND the checkpoint returns exactly that intent. A checkpoint that cannot be read back could never
   // satisfy recovery or resume, so the delete is not permitted on it. The rows of this Film that were not moved stay `remaining`.
   try{await port.record(intent);}catch(error){stop(id,RETIRE_CHECKPOINT_FAILED,{cause:error?.code||null});break chunks;}
   try{await recordedIntent(port,intent);}catch(error){stop(id,error?.code||RETIRE_CHECKPOINT_FAILED);break chunks;}
   const result=await commitIntent(counted,port,intent,{clock,policy});
   out.maxQueriesPerFilm=Math.max(out.maxQueriesPerFilm,counter.n-before);
   if(result.state==='applied')issued(intent,out.written);
   else if(result.state==='not_applied')for(const row of intent.rows)moved(id,row.dimension,result.errorClass);
   else issued(intent,out.uncertain);
   done.add(id);
   if(result.settleError){stop(id,'retire_checkpoint_settle_failed',{cause:result.settleError});break chunks;}
   if(result.state==='unknown'){stop(id,result.errorClass||'unclassified');break chunks;}
   out.cursor=id;
  }
 }
 return finish(counter);
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
