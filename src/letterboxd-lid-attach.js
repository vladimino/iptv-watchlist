// AIR-675 / ADR 0217 (Accepted) decisions 7 and 8 (delivery step 6, choices L1 and M1), DORMANT: the owner RE-CHECK of a lid-only Film and the TMDB ATTACH. A lid-only Film `film:lb:<lid>` (AIR-672) may later be shown to have a TMDB movie.
// The owner asks for one verification, one lid per request: `POST /api/admin/letterboxd/lid-recheck {lid, requestId}` (`src/admin/lid-recheck.js`). Natural sync never attaches and nothing re-checks automatically.
// Nothing in this module runs from a live path: the route refuses before its first effect (no fetch, no write) while the admission marker is not `d1`, while migrations 0049 and 0050 are not applied, and while the identity evidence
// writer `lid_tmdb_attach` is not actually `on` (never enabled automatically). A deploy applies nothing and activates nothing.
//
// The protocol (ADR 0217 decision 8):
//   intent    `lid_recheck_intent` (migration 0049): the durable, compare-and-swap record of ONE request. The same `requestId` with another lid is `request_conflict`; a settled intent is answered by readback only, with no fetch.
//   reconcile the ONE common operation key `admission:lid:<lid>` (ADR 0207 decision 3): a live attempt is waited on, any other unresolved receipt is abandoned, an applied one is validated against current state. Only when no canonical
//             effect is settled and no attempt can still land is a bounded page and TMDB check reacquired, as a new attempt.
//   reserve   the receipt reservation and the intent compare-and-swap (`attempt_request_id`, `revision`) are ONE batch (`reserveExtra` of the keyed receipt): two requests with one `requestId` cannot both own the intent.
//   attach    ONE fenced canonical batch (`attachLidTmdb`): the trusted `tmdb` claim, `canonical_identity`, the evidence row `film_has_id` (root = the attach root, subject = the survivor Film), the receipt tail and the intent's
//             `attached` / `owed`. The Film id is unchanged. No attach before the writer is `on`; no attach without evidence.
//   link      the Ratings alias (the existing link step) is a SEPARATE, fenced handoff with the complete ownership predicates of both claims, owned by the intent; the intent settles in the SAME D1 batch as the alias (primary), or by an
//             exact lost-response reconciliation (fallback). A transient failure leaves `owed`; only a proved conflict or correction is terminal (`alias_conflict`, `link_blocked`).
// Never an automatic merge (L1): a movie held by another Film is the typed `tmdb_on_other_film` for owner review.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {RETRY_POLICY,digestOf} from './canonical-receipts.js';
import {currentTargetOf,keyedRequestIdOf,runOperationKey} from './receipt-operation-key.js';
import {hasLidAdmissionTable} from './film-admission.js';
import {FILM_ADMISSION_OPERATION,RATED_ADMISSION_ORIGIN} from './canonical-rated-admission-producer.js';
import {admissionClosedError,admissionRoute,authorityAssertion,d1BatchCondition,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {evidenceInsertStatement,ownEvidenceRowCondition,planIdentityEvidence} from './identity-evidence.js';
import {ATTACH_WRITER,attachWriterOnCondition,attachWriterSchemaReady,readWriter} from './identity-evidence-writer.js';
import {attachRoot} from './domain/letterboxd-attach-root.js';

export const ATTACH_KIND='lid_tmdb_attach';
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const REQUEST=/^[\x21-\x7e]{1,200}$/;
const TMDB=/^[1-9]\d{0,11}$/;
const clockOf=now=>typeof now==='function'?now:()=>(now||new Date().toISOString());
const stable=value=>JSON.stringify(value===undefined?null:value);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
// The terminal outcomes a non-admitting state of ADR 0217 decision 3 gives (the caller's check names the state). `tmdb_unavailable` (transport) is never one of them: it is non-terminal and counts no attempt.
export const STATE_OUTCOME=Object.freeze({tmdb_none:'still_none',tmdb_tv:'tmdb_tv',tmdb_unreadable:'tmdb_unreadable',tmdb_missing:'tmdb_missing',tmdb_disagrees:'tmdb_disagrees',tmdb_failed:'tmdb_failed',
 page_not_read:'page_not_read',page_refused:'page_refused',page_type_ineligible:'page_type_ineligible',lid_unverified:'lid_unverified'});
const NON_TERMINAL=Object.freeze({wait:true,deferred:true,failed:true,unknown:true,source_unavailable:true,link_owed:true});
const result=(outcome,extra={})=>({outcome,terminal:!NON_TERMINAL[outcome],...extra});

// ---- the intent row ----
const INTENT_COLUMNS='request_id,lid,state,outcome,revision,attempt_request_id,proof_version,tmdb,final_url,slug,canonical_path,title,year,tmdb_doc_digest,attach_root,film_id,link_state,created_at,updated_at';
function viewIntent(row){
 if(!row)return null;
 return {requestId:row.request_id,lid:row.lid,state:row.state,outcome:row.outcome??null,revision:Number(row.revision),attemptRequestId:row.attempt_request_id??null,
  proof:row.attach_root?{proofVersion:Number(row.proof_version),tmdb:row.tmdb,finalUrl:row.final_url,slug:row.slug,canonicalPath:row.canonical_path,title:row.title,year:row.year===null?null:Number(row.year),tmdbDocDigest:row.tmdb_doc_digest,attachRoot:row.attach_root}:null,
  filmId:row.film_id??null,linkState:row.link_state??null,createdAt:row.created_at,updatedAt:row.updated_at};
}
const missingTable=error=>/no such table/i.test(String(error?.message||error?.cause?.message||''));
export async function hasIntentTable(db){try{return !!(await one(db,"SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='lid_recheck_intent'"));}catch(error){throw failed('film_person_unavailable',error);}}
export async function readIntent(env,requestId){
 const db=database(env);
 try{return viewIntent(await one(db,'SELECT '+INTENT_COLUMNS+' FROM lid_recheck_intent WHERE request_id=?',[requestId]));}
 catch(error){if(missingTable(error))throw failed('admission_unavailable',error);throw error;}
}
async function openIntent(env,{requestId,lid,at}){
 const db=database(env);
 try{
  await db.prepare("INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) SELECT ?,?,'open',1,?,? WHERE NOT EXISTS (SELECT 1 FROM lid_recheck_intent WHERE request_id=?)").bind(requestId,lid,at,at,requestId).run();
 }catch(error){if(!/lid_recheck_intent_taken|UNIQUE constraint failed: lid_recheck_intent/i.test(String(error?.message||error)))throw failed('film_person_unavailable',error);}
 return readIntent(env,requestId);
}
// One guarded intent update on the intent as THIS caller read it (state `open`, the revision it read, optionally no outcome yet). The answer is the REAL result of THIS statement (`RETURNING`: one affected row, the next revision), never an
// inference from a later read, which could be another caller's write: true when it matched, false when the intent moved (a lost compare-and-swap) or a trigger refused it.
async function updateIntent(env,{requestId,revision,set,params,openOnly=true,noOutcome=false,extraWhere='',extraParams=[]}){
 const db=database(env);
 const sql='UPDATE lid_recheck_intent SET '+set+',revision=revision+1,updated_at=? WHERE request_id=? AND revision=?'+(openOnly?" AND state='open'":'')+(noOutcome?' AND outcome IS NULL':'')+extraWhere+' RETURNING revision';
 let row;
 try{row=await db.prepare(sql).bind(...params,requestId,revision,...extraParams).first();}
 catch(error){if(/lid_recheck_intent_update|CHECK constraint failed/i.test(String(error?.message||error)))return false;throw failed('film_person_unavailable',error);}
 return !!row&&Number(row.revision)===revision+1;
}
// A terminal outcome that wrote nothing canonical: the intent is settled, once, against the revision read.
const settleTerminal=(env,{requestId,revision,outcome,at,extraWhere='',extraParams=[]})=>updateIntent(env,{requestId,revision,set:"state='settled',outcome=?",params:[outcome,at],noOutcome:true,extraWhere,extraParams});

// ---- gates (read only; nothing is written or fetched before they pass) ----
// -> {authority, writer}. Typed refusals: `letterboxd_admission_closed` (the admission marker is not `d1`), `admission_unavailable` (migration 0048 or 0049 is not applied), `evidence_writer_inactive` (migration 0050 is not applied, or the
// writer `lid_tmdb_attach` is `off`, `pending` or absent; never an attach before `on`, never an automatic enablement).
export async function attachGates(env){
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='d1')throw admissionClosedError(authority.mode);
 const db=database(env);
 if(!await hasLidAdmissionTable(db)||!await hasIntentTable(db))throw failed('admission_unavailable');
 if(!await attachWriterSchemaReady(env)){const error=failed('evidence_writer_inactive');error.reason='writer_schema_missing';throw error;}
 const writer=await readWriter(env,ATTACH_WRITER);
 if(writer.state!=='on'){const error=failed('evidence_writer_inactive');error.reason='writer_'+writer.state;error.writerState=writer.state;throw error;}
 return {authority,writer};
}

// ---- the durable state of a lid, from D1 only (read only) ----
const RETIRED_SQL="SELECT 1 AS hit FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq) LIMIT 1";
const RETIRED_COND="NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq))";
// `film_lid_admission.film_id` resolves, through the redirect chain (a merge), to the survivor Film (ADR 0217 decision 8b: the requested lid still uniquely belongs to that survivor).
const ADMISSION_RESOLVES="EXISTS (WITH RECURSIVE r(id,n) AS (SELECT film_id,0 FROM film_lid_admission WHERE lid=? UNION ALL SELECT f.to_film_id,r.n+1 FROM film_redirect f JOIN r ON f.from_id=r.id WHERE r.n<8) SELECT 1 FROM r WHERE id=?)";
const strongIdentity=row=>!!row&&(row.status==='reviewed'||row.authority==='owner');

// The lid's Film, as the planner sees it. -> {outcome:'attachable', id, revision}
//   | {outcome:'already_attached', id, tmdb}   the survivor already has a canonical identity (another writer or an earlier attach): nothing to do, no fetch
//   | {outcome:'conflict', reason, id?}        no lid-only Film, incomplete or conflicting ownership, a redirect loop, a missing Film, or another TMDB claim on the survivor: owner review
export async function planAttachState(env,{lid}){
 const db=database(env);
 const [row,claims]=await Promise.all([one(db,'SELECT film_id FROM film_lid_admission WHERE lid=?',[lid]),many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid])]);
 if(!row)return {outcome:'conflict',reason:claims.length?'not_lid_only':'lid_only_film_missing'};
 let target;
 try{target=await currentTargetOf(env,{kind:'film',id:row.film_id});}catch(error){if(error?.code==='film_person_redirect')return {outcome:'conflict',id:row.film_id,reason:'redirect_loop'};throw error;}
 const id=target.id;
 const owner=claims.find(claim=>claim.trusted===1&&claim.conflicting===0);
 if(claims.length!==1||!owner||owner.film_id!==id)return {outcome:'conflict',id,reason:'ownership_incomplete'};
 const [film,tmdbClaims,dimension,revision]=await Promise.all([
  one(db,'SELECT id,canonical_identity FROM film WHERE id=?',[id]),
  many(db,"SELECT value,trusted,conflicting FROM film_external_id WHERE film_id=? AND scheme='tmdb'",[id]),
  one(db,"SELECT status,authority FROM film_dimension WHERE film_id=? AND dimension='identity'",[id]),
  one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',['film',id]),
 ]);
 if(!film)return {outcome:'conflict',id,reason:'film_missing'};
 const identity=film.canonical_identity;
 if(identity!==null&&identity!==undefined){
  const match=/^tmdb:([1-9]\d{0,11})$/.exec(String(identity));
  return match?{outcome:'already_attached',id,tmdb:match[1]}:{outcome:'conflict',id,reason:'identity_not_tmdb'};
 }
 if(tmdbClaims.length)return {outcome:'conflict',id,reason:'other_tmdb_claim'};
 return {outcome:'attachable',id,revision:Number(revision?.revision??0),strong:strongIdentity(dimension)};
}
// What the movie does to the attach (read only): an owner-kept identity, a retired movie, a movie held by another Film (any trust). null when the movie is free.
export async function classifyMovie(env,{plan,tmdb}){
 const db=database(env);
 if(plan.strong)return {outcome:'owner_kept'};
 const [retired,claims]=await Promise.all([one(db,RETIRED_SQL,[tmdb]),many(db,"SELECT film_id FROM film_external_id WHERE scheme='tmdb' AND value=?",[tmdb])]);
 if(retired)return {outcome:'tmdb_retired'};
 if(claims.length)return {outcome:'tmdb_on_other_film',holder:claims[0].film_id};
 return null;
}

// ---- the attach batch (ADR 0217 decision 8b) ----
// input: {lid, tmdb, filmId (the survivor), expectedRevision, at, requestId, receiptMark, intent:{requestId, revision (AFTER the reserve-time compare-and-swap)}, proof, writerGeneration}
// -> {id, revision, attached:true}. Typed refusals (`error.reason`): `admission_conflict` with the outcome of the refusal in `error.outcome` (`tmdb_on_other_film`, `owner_kept`, `tmdb_retired`, `admission_conflict`), `evidence_writer_inactive`.
// Every condition is asserted INSIDE the batch as well; a condition that moved fails the whole batch and nothing is written.
export async function attachLidTmdb(env,input){
 const lid=String(input?.lid||''),tmdb=String(input?.tmdb||'');
 if(!LID.test(lid)||!TMDB.test(tmdb))throw failed('film_person_invalid');
 const id=fenced.filmId(input.filmId),expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 const mark=input.receiptMark;
 if(!mark||typeof mark!=='object'||mark.requestId!==requestId||!Number.isInteger(mark.attempt)||mark.attempt<1)throw failed('film_person_invalid');
 const proof=input.proof;
 if(!plain(proof)||!/^[0-9a-f]{64}$/.test(String(proof.attachRoot))||!/^[0-9a-f]{64}$/.test(String(proof.tmdbDocDigest))||proof.tmdb!==tmdb)throw failed('film_person_invalid');
 if(!plain(input.intent)||typeof input.intent.requestId!=='string'||!Number.isInteger(input.intent.revision)||!Number.isInteger(input.writerGeneration))throw failed('film_person_invalid');
 const gate=fenced.bindLetterboxdFence(env,assertWritable(await readAuthority(env)));
 // Fresh reads at the write: the admission marker, the writer control and the lid's state. The writer must be `on` AT the generation the caller read.
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='d1')throw admissionClosedError(authority.mode);
 const condition=d1BatchCondition(authority);
 const writer=await readWriter(env,ATTACH_WRITER);
 if(writer.state!=='on'||writer.generation!==input.writerGeneration){const error=failed('evidence_writer_inactive');error.reason='writer_'+writer.state;throw error;}
 const plan=await planAttachState(env,{lid});
 const refuse=(outcome,reason)=>{const error=failed('admission_conflict');error.reason=reason||outcome;error.outcome=outcome;return error;};
 if(plan.outcome==='already_attached')throw refuse('admission_conflict','already_attached');
 if(plan.outcome!=='attachable')throw refuse('admission_conflict',plan.reason);
 if(plan.id!==id)throw failed('admission_target_changed');
 const held=await classifyMovie(env,{plan,tmdb});
 if(held)throw refuse(held.outcome,held.outcome);
 const evidencePlan=await planIdentityEvidence({subject:{kind:'film',value:id},relation:'film_has_id',object:{kind:'tmdb_movie',value:tmdb},polarity:'asserts',route:'owner_action',method:'page_check',sourceRoot:proof.attachRoot,observedAt:at});
 const tail=fenced.receiptTail(mark,{kind:'film',id});
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push(authorityAssertion(fenced.assertSql,condition));
 // The in-batch identity fence (decision 8b). The Film/Person generation and the admission marker are above; the owned attempt on the lid key, the writer `on` at its generation, and the intent open with this attempt and revision:
 statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM canonical_write_receipt WHERE request_id=? AND origin=? AND operation_key=? AND state='pending' AND attempts=?)"),[requestId,RATED_ADMISSION_ORIGIN,'admission:lid:'+lid,mark.attempt]]);
 {const on=attachWriterOnCondition(input.writerGeneration);statements.push([fenced.assertSql(on.sql),on.params]);}
 statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM lid_recheck_intent WHERE request_id=? AND lid=? AND state='open' AND outcome IS NULL AND attempt_request_id=? AND revision=?)"),[input.intent.requestId,lid,requestId,input.intent.revision]]);
 // The target Film exists and is not a redirect source; the lid STILL uniquely belongs to it (a trusted, non-conflicting `letterboxd` claim, no other row of the lid of any trust on any Film, the proof row resolving to it).
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=? AND trusted=1 AND conflicting=0) AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=1 AND "+ADMISSION_RESOLVES),[id,lid,lid,lid,id]]);
 // No `tmdb` claim of the movie of any trust on any Film, no other `tmdb` claim on this Film, `canonical_identity` null, no live retirement of the movie, the identity dimension neither reviewed nor owner.
 statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=?) AND NOT EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb') AND (SELECT canonical_identity FROM film WHERE id=?) IS NULL"),[tmdb,id,id]]);
 statements.push([fenced.assertSql(RETIRED_COND+" AND NOT EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='identity' AND (status='reviewed' OR authority='owner'))"),[tmdb,id]]);
 // The writes.
 statements.push(["INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,'tmdb',?,1,0,?)",[id,tmdb,stable({source:'owner_action',adr:'0217',evidence:proof.attachRoot})]]);
 statements.push(["UPDATE film SET canonical_identity=?,updated_at=? WHERE id=? AND canonical_identity IS NULL",['tmdb:'+tmdb,at,id]]);
 statements.push([fenced.assertSql('changes()>=1'),[]]);
 statements.push(evidenceInsertStatement(evidencePlan,{filmId:id,requestId,at}));
 // The row with the key must be THIS batch's own (a silent no-op of the insert, a row of another request, fails the batch): evidence is never absent from an attach.
 {const own=ownEvidenceRowCondition(evidencePlan,{filmId:id,requestId});statements.push([fenced.assertSql(own.sql),own.params]);}
 // The intent in the SAME batch: `attached` / `owed`, the survivor, the proof inputs, the revision (the trigger raises it).
 statements.push(["UPDATE lid_recheck_intent SET outcome='attached',link_state='owed',film_id=?,proof_version=?,tmdb=?,final_url=?,slug=?,canonical_path=?,title=?,year=?,tmdb_doc_digest=?,attach_root=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='open' AND outcome IS NULL AND attempt_request_id=? AND revision=?",
  [id,proof.proofVersion,tmdb,proof.finalUrl,proof.slug,proof.canonicalPath,proof.title,proof.year,proof.tmdbDocDigest,proof.attachRoot,at,input.intent.requestId,requestId,input.intent.revision]]);
 statements.push([fenced.assertSql('changes()>=1'),[]]);
 statements.push([fenced.BUMP,['film',id,at]]);
 try{
  await fenced.commit(env,gate,statements,entities,tail);
 }catch(error){
  const message=String(error?.cause?.message||'');
  // The batch's own assertions refused it. Classify by reading what is there now, so a refusal is a typed outcome and not a crash; anything else (a moved revision, a fence) is rethrown unchanged.
  if(error?.code==='film_person_precondition'||error?.code==='film_person_unavailable'&&/UNIQUE constraint failed: film_external_id|film_external_id_one_trusted/i.test(message)){
   const now=await planAttachState(env,{lid}).catch(()=>null);
   if(now&&now.outcome==='already_attached')throw refuse('admission_conflict','already_attached');
   if(now&&now.outcome==='conflict')throw refuse('admission_conflict',now.reason);
   if(now&&now.outcome==='attachable'){const again=await classifyMovie(env,{plan:now,tmdb}).catch(()=>null);if(again)throw refuse(again.outcome,again.outcome);}
  }
  throw error;
 }
 return {id,revision:expected+1,attached:true,replay:false};
}

// ---- the Ratings link handoff (ADR 0217 decision 8c) ----
// The complete ownership predicates of BOTH claims, as one boolean ({sql, params}): the trusted `letterboxd` claim of the lid and the trusted `tmdb` claim of the movie are on the same survivor with no other row of either value
// of any trust on any Film, the survivor is bound to its `film_lid_admission` row, it is not a redirect source, the movie is not retired, and `canonical_identity` is `tmdb:<n>`.
export function ownershipCondition({id,lid,tmdb}){
 return {sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=? AND trusted=1 AND conflicting=0) AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=1"
  +" AND EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0) AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=1"
  +" AND EXISTS (SELECT 1 FROM film WHERE id=? AND canonical_identity=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?) AND "+ADMISSION_RESOLVES+' AND '+RETIRED_COND,
  params:[id,lid,lid,id,tmdb,tmdb,id,'tmdb:'+tmdb,id,lid,id,tmdb]};
}
// The read of that state: `ok`, or the typed reason it does not hold. A violation read from durable rows is PROVED (a correction after the attach), never a transient condition.
async function readOwnership(env,intent){
 const db=database(env);
 const lid=intent.lid,tmdb=intent.proof?.tmdb;
 const row=await one(db,'SELECT film_id FROM film_lid_admission WHERE lid=?',[lid]);
 if(!row)return {ok:false,reason:'admission_missing'};
 let id;
 try{id=(await currentTargetOf(env,{kind:'film',id:row.film_id})).id;}catch(error){if(error?.code==='film_person_redirect')return {ok:false,reason:'redirect_loop'};throw error;}
 const cond=ownershipCondition({id,lid,tmdb});
 const held=await one(db,'SELECT CASE WHEN ('+cond.sql+') THEN 1 ELSE 0 END AS ok',cond.params);
 return Number(held?.ok)===1?{ok:true,id}:{ok:false,id,reason:'ownership_changed'};
}
const ratingsAssertion=(sql,params)=>["UPDATE ratings_domain_cas SET ok=CASE WHEN "+sql+" THEN 1 ELSE 0 END WHERE id=1",params];

// The link step of ONE open intent whose attach landed (`link_state = owed`). It never re-attaches and never fetches. `ports.link({lid, tmdb, extra, statementsFor, blocked})` is the EXISTING Ratings alias protocol over the document
// compare-and-swap (`LetterboxdFacts.linkAttachedPair`: the exact part count and `etag` it read, the Ratings authority and its fences). EVERY outcome, including an alias already present, a proved conflict and a proved correction, commits as a
// guarded write of THAT document in ONE D1 batch with: the Film/Person marker and admission marker generations, the ownership predicates (their negation for a blocked correction), and the intent settlement matched on `owed` and the
// revision read (its `changes()` asserted). There is no second, unfenced settlement: a document that moved, a marker that moved, a store that cannot batch (it refuses whole, `atomic_unavailable`) or a lost intent revision leaves the intent
// `owed` and the same requestId retries. The lid keeps its OWN fact key (`lb-<lid>`, or the key it already has): it gains the movie alias, nothing is renamed.
// -> {outcome:'linked'|'alias_conflict'|'link_blocked'} (the intent is settled by that very batch) | {outcome:'link_owed', reason} (nothing settled).
export async function linkAttachedIntent(env,{intent,ports,now}={}){
 const clock=clockOf(now);
 if(!intent||intent.state!=='open'||intent.outcome!=='attached'||intent.linkState!=='owed'||!intent.proof)throw failed('film_person_invalid');
 if(!ports||typeof ports.link!=='function')throw failed('film_person_invalid');
 const owed=reason=>result('link_owed',{reason,intentRequestId:intent.requestId});
 // Fail closed outside Film/Person `d1`/`open` and the admission marker `d1`: nothing is written, the intent stays `owed`.
 let authority,filmGate;
 try{authority=await readAdmissionAuthority(env);if(admissionRoute(authority)!=='d1')return owed('admission_not_d1');filmGate=assertWritable(await readAuthority(env));}
 catch(error){if(error?.code==='film_person_unavailable'||error?.code==='letterboxd_admission_closed'||error?.code==='film_person_fence'||error?.code==='film_person_held')return owed(error.code);throw error;}
 const owner=await readOwnership(env,intent);
 const cond=owner.ok?ownershipCondition({id:owner.id,lid:intent.lid,tmdb:intent.proof.tmdb}):null;
 const markers=d1BatchCondition(authority);
 const at=clock();
 const markerStatement=ratingsAssertion("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?) AND ("+markers.sql+')',[filmGate.generation,...markers.params]);
 // The statements of the outcome the document step decided, in the SAME batch as the (unchanged or extended) document write.
 const statementsFor=state=>{
  const settle=[["UPDATE lid_recheck_intent SET state='settled',link_state=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='open' AND outcome='attached' AND link_state='owed' AND revision=?",[state,at,intent.requestId,intent.revision]],ratingsAssertion('changes()>=1',[])];
  if(state==='link_blocked'){
   // A PROVED correction is asserted AGAIN in the batch: the ownership still does not hold at the write (a conflict cleared in between refuses the batch and the next call re-reads).
   const held=ownershipCondition({id:owner.id??intent.filmId,lid:intent.lid,tmdb:intent.proof.tmdb});
   return [ratingsAssertion('NOT ('+held.sql+')',held.params),...settle];
  }
  return [ratingsAssertion(cond.sql,cond.params),...settle];
 };
 let out;
 try{out=await ports.link({lid:intent.lid,tmdb:intent.proof.tmdb,extra:[markerStatement],statementsFor,blocked:!owner.ok});}
 catch(error){
  // Transient: a moved epoch or `etag`, contention, a held or not-d1 Ratings domain, a store that cannot batch. Never terminal; the same requestId retries.
  if(typeof error?.code==='string')return owed(error.code);
  throw error;
 }
 const after=await readIntent(env,intent.requestId);
 if(after&&after.state==='settled'&&after.outcome==='attached'&&after.linkState===out?.state){
  const projection=out.state==='linked'?await completeProjection(ports,{lid:intent.lid,tmdb:intent.proof.tmdb}):null;
  return result(out.state,{intentRequestId:intent.requestId,...(out.factKey?{factKey:out.factKey}:{}),...(owner.ok?{}:{reason:owner.reason}),...(projection?{projection}:{})});
 }
 return owed('intent_not_settled');
}
// The second half of a Diary-first link (the fact record of the lid's key gains the movie id and projects both aliases): idempotent, run after the atomic settlement and again on a repeat of a settled `linked` intent whose record does not
// carry the movie yet. Its failure never un-settles the intent: it is reported as `projection: 'pending'` and the same requestId repeats it.
async function completeProjection(ports,{lid,tmdb,pendingOnly=false}){
 if(!ports||typeof ports.complete!=='function')return null;
 try{const done=await ports.complete({lid,tmdb,pendingOnly});return done?.state==='conflict'?'conflict':done?.state==='absent'?'pending':'done';}
 catch{return 'pending';}
}

// ---- the coordinator (ADR 0217 decision 8a) ----
// input: {lid, requestId, reacquire, ports:{link}, now?, policy?}
//   reacquire  `async () => {ok:true, state:'tmdb_movie', proof:{slug, path, finalUrl, tmdb, title, year, detail}} | {ok:true, state:<a non-admitting state of decision 3>} | {ok:false, reason, transient?}`: the REAL bounded page and TMDB check
//              (`verifyPage` and `movieDetailAgrees`, no new proof semantics), called only after every gate passed and the key's history is reconciled, and only when this call still needs a check.
// -> {outcome, terminal, ...}: attached (with `link`), linked..., or one of the terminal outcomes of decision 8a (`still_none`, `tmdb_on_other_film`, `owner_kept`, `tmdb_retired`, `admission_conflict`, `evidence_writer_inactive`,
//    `source_changed`, a non-admitting state), or a non-terminal `wait` | `source_unavailable` | `deferred` | `failed` | `unknown` | `link_owed`. `request_conflict` when the same requestId names another lid.
export async function lidRecheck(env,input={}){
 const lid=input.lid,requestId=input.requestId;
 if(typeof lid!=='string'||!LID.test(lid)||typeof requestId!=='string'||!REQUEST.test(requestId))throw failed('film_person_invalid');
 const clock=clockOf(input.now),policy=input.policy||RETRY_POLICY;
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 if(!await hasIntentTable(db))throw failed('admission_unavailable');
 let intent=await readIntent(env,requestId);
 if(intent&&intent.lid!==lid)return result('request_conflict',{requestId});
 // A settled intent is answered by readback only: no gate, no fetch, no canonical or intent write. The one possible effect is the idempotent completion of the Diary-first record when a settled `linked` intent finds it still without the movie.
 if(intent&&intent.state==='settled')return readbackWithProjection(intent,input);
 // The Ratings link is owed after an attach: the link step has its own fences (markers, ownership, ratings domain), and turning the writer off later must not strand it.
 if(intent&&intent.outcome==='attached')return resumeLink(env,{intent,input});
 await attachGates(env);
 if(!intent)intent=await openIntent(env,{requestId,lid,at:clock()});
 if(!intent)throw failed('film_person_unavailable');
 if(intent.lid!==lid)return result('request_conflict',{requestId});
 if(intent.state==='settled')return readbackResult(intent,{replay:true});
 // The attach landed (this call or an earlier one) and the Ratings link is owed: resume the link step only. Never a second attach and never a fetch.
 if(intent.outcome==='attached')return resumeLink(env,{intent,input});
 const operationKey='admission:lid:'+lid;
 let source=null;
 const acquire=async()=>{
  if(source)return source;
  if(typeof input.reacquire!=='function')throw failed('film_person_invalid');
  const got=await input.reacquire();
  source=got&&typeof got==='object'?got:{ok:false,reason:'source_unavailable'};
  return source;
 };
 const settle=async(outcome,extra={})=>{
  const fresh=await readIntent(env,requestId);
  if(fresh&&fresh.state==='open'&&fresh.outcome===null&&await settleTerminal(env,{requestId,revision:fresh.revision,outcome,at:clock()}))return result(outcome,{requestId,...extra});
  const now=await readIntent(env,requestId);
  return now&&now.state==='settled'?readbackResult(now,{replay:true}):result('deferred',{reason:'intent_moved',requestId});
 };
 // The finalize of the key protocol: a terminal outcome that reserves nothing is written with the observed history asserted in ITS OWN statement.
 const finalizeOutcome=(outcome,extra={})=>({kind:'finalize',write:async guard=>{
  const fresh=await readIntent(env,requestId);
  if(!fresh||fresh.state!=='open'||fresh.outcome!==null)return {refused:true};
  const done=await settleTerminal(env,{requestId,revision:fresh.revision,outcome,at:clock(),extraWhere:' AND ('+guard.sql+')',extraParams:guard.params});
  return done?result(outcome,{requestId,...extra}):{refused:true};
 }});
 const validate=async()=>'historical';
 const decide=async ctx=>{
  intent=await readIntent(env,requestId);
  if(!intent)throw failed('film_person_unavailable');
  if(intent.state==='settled')return {kind:'none',result:readbackResult(intent,{replay:true})};
  if(intent.outcome==='attached')return {kind:'none',result:result('attached',{requestId,resume:true})};
  const plan=await planAttachState(env,{lid});
  if(plan.outcome==='already_attached'){
   // The Film already has a canonical identity. An earlier observation of THIS intent that named another movie is `source_changed` (owner review); otherwise there is nothing to do.
   const earlier=intent.proof?.tmdb;
   return finalizeOutcome(earlier&&earlier!==plan.tmdb?'source_changed':'already_attached',{id:plan.id,tmdb:plan.tmdb});
  }
  if(plan.outcome==='conflict')return finalizeOutcome('admission_conflict',{id:plan.id??null,reason:plan.reason});
  const got=await acquire();
  if(got.ok!==true)return {kind:'none',result:result('source_unavailable',{reason:got.reason??'source_unavailable',requestId})};
  if(got.state!=='tmdb_movie'){
   if(got.state==='tmdb_unavailable'||got.transient===true)return {kind:'none',result:result('source_unavailable',{reason:got.reason??got.state,requestId})};
   const outcome=STATE_OUTCOME[got.state];
   if(!outcome)throw failed('film_person_invalid');
   return finalizeOutcome(outcome,{state:got.state});
  }
  const proof=got.proof;
  const rooted=await attachRoot({lid,slug:proof?.slug,path:proof?.path,tmdb:String(proof?.tmdb??''),title:proof?.title,year:proof?.year,finalUrl:proof?.finalUrl,detail:proof?.detail});
  if(!rooted)return finalizeOutcome('tmdb_unreadable',{state:'tmdb_unreadable',reason:'attach_root_invalid'});
  const tmdb=String(proof.tmdb);
  const held=await classifyMovie(env,{plan,tmdb});
  if(held)return finalizeOutcome(held.outcome,{id:plan.id,tmdb,holder:held.holder??null});
  const control=await readWriter(env,ATTACH_WRITER);
  if(control.state!=='on')return finalizeOutcome('evidence_writer_inactive',{reason:'writer_'+control.state});
  const observed={proofVersion:rooted.proofVersion,tmdb,finalUrl:rooted.source,slug:proof.slug,canonicalPath:proof.path,title:proof.title,year:proof.year,tmdbDocDigest:rooted.tmdbDocDigest,attachRoot:rooted.root};
  // The observation is recorded on the intent (a changed page or root of an attempt that did not land simply replaces it: the earlier receipt was abandoned by the reconcile above).
  if(!intent.proof||intent.proof.attachRoot!==observed.attachRoot){
   const recorded=await updateIntent(env,{requestId,revision:intent.revision,set:'proof_version=?,tmdb=?,final_url=?,slug=?,canonical_path=?,title=?,year=?,tmdb_doc_digest=?,attach_root=?',
    params:[observed.proofVersion,observed.tmdb,observed.finalUrl,observed.slug,observed.canonicalPath,observed.title,observed.year,observed.tmdbDocDigest,observed.attachRoot,clock()],noOutcome:true});
   if(!recorded)return {kind:'none',result:result('deferred',{reason:'intent_moved',requestId})};
   intent=await readIntent(env,requestId);
  }
  const digest=await digestOf({operation:FILM_ADMISSION_OPERATION,d1:true,content:{kind:ATTACH_KIND,lid,tmdb,attachRoot:observed.attachRoot}});
  const reservationId=await keyedRequestIdOf({origin:RATED_ADMISSION_ORIGIN,operation:FILM_ADMISSION_OPERATION,operationKey,ordinal:ctx.ordinal,source:digest});
  const at=clock();
  return {kind:'reserve',
   request:{operation:FILM_ADMISSION_OPERATION,target:{kind:'film',id:plan.id},expectedRevision:plan.revision,digest,source:digest,requestId:reservationId,
    reserveExtra:[["UPDATE lid_recheck_intent SET attempt_request_id=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='open' AND revision=?",[reservationId,at,requestId,intent.revision]]]},
   write:{
    atomic:true,
    run:ctx2=>attachLidTmdb(env,{lid,tmdb,filmId:plan.id,expectedRevision:ctx2.currentRevision,at:clock(),requestId:ctx2.requestId,
     receiptMark:{requestId:ctx2.requestId,attempt:ctx2.attempt,now:clock(),target:ctx2.target},intent:{requestId,revision:intent.revision+1},proof:observed,writerGeneration:control.generation}),
    readback:async()=>{const snap=await readIntent(env,requestId);return {digest:snap?.outcome==='attached'&&snap.proof?.attachRoot===observed.attachRoot?digest:null,revision:Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[plan.id]))?.revision??0)};},
    revalidate:async()=>{const snap=await planAttachState(env,{lid});return snap.outcome==='attachable'?'proceed':snap.outcome==='already_attached'?'superseded':'stale';},
   }};
 };
 let ran;
 try{ran=await runOperationKey(env,{origin:RATED_ADMISSION_ORIGIN,operationKey,now:clock,policy},{validate,decide});}
 catch(error){
  // A refusal of the attach writer: the intent is settled with its typed outcome (nothing canonical was written), for owner review.
  if(error?.code==='admission_conflict')return settle(error.outcome||'admission_conflict',{reason:error.reason??null});
  if(error?.code==='evidence_writer_inactive')return settle('evidence_writer_inactive',{reason:error.reason??null});
  if(error?.code==='film_person_redirect')return result('deferred',{reason:'redirect',requestId});
  throw error;
 }
 const base={requestId,operationKey,replans:ran.replans??0};
 switch(ran.status){
  case 'wait':return result('wait',{...base,reason:ran.reason??'in_flight',dueAt:ran.dueAt??null});
  case 'none':return {...ran.result,...base};
  case 'finalized':return {...ran.result,...base};
  case 'refused':return result('deferred',{...base,reason:'finalize_refused'});
  case 'exhausted':return result('history_exhausted',{...base,terminal:true});
  case 'settled':return result('deferred',{...base,reason:'settled_unexpected'});
  case 'reserved':{
   const o=ran.outcome||{};
   if(o.state==='applied'||o.state==='already'){
    const fresh=await readIntent(env,requestId);
    if(fresh&&fresh.outcome==='attached')return resumeLink(env,{intent:fresh,input,attached:{id:fresh.filmId,attachRoot:fresh.proof?.attachRoot??null}});
    return result('deferred',{...base,reason:'attach_not_recorded'});
   }
   if(o.state==='unknown')return result('unknown',{...base,errorClass:o.errorClass??null});
   if(o.state==='failed'||o.state==='abandoned')return result('failed',{...base,errorClass:o.errorClass??o.receipt?.errorClass??null});
   return result('deferred',{...base,reason:o.reason??o.state??null});
  }
  default:return result('deferred',{...base,reason:'contended'});
 }
}

async function readbackWithProjection(intent,input){
 const out=readbackResult(intent,{replay:true});
 if(intent.outcome==='attached'&&intent.linkState==='linked'&&intent.proof){
  const projection=await completeProjection(input.ports,{lid:intent.lid,tmdb:intent.proof.tmdb,pendingOnly:true});
  if(projection&&projection!=='done')out.projection=projection;
 }
 return out;
}
function readbackResult(intent,extra={}){
 const base={requestId:intent.requestId,lid:intent.lid,id:intent.filmId,attachRoot:intent.proof?.attachRoot??null,tmdb:intent.proof?.tmdb??null,intentState:intent.state,linkState:intent.linkState,...extra};
 if(intent.outcome==='attached'){
  if(intent.linkState==='owed')return result('link_owed',{...base,attached:true});
  return result(intent.linkState,{...base,attached:true,terminal:true});
 }
 return result(intent.outcome||'deferred',{...base});
}
async function resumeLink(env,{intent,input,attached=null}){
 if(intent.linkState!=='owed')return readbackResult(intent,{resume:true});
 const link=await linkAttachedIntent(env,{intent,ports:input.ports,now:input.now});
 return {...link,attached:true,id:intent.filmId,attachRoot:intent.proof?.attachRoot??null,tmdb:intent.proof?.tmdb??null,requestId:intent.requestId,...(attached?{admittedNow:true}:{})};
}
