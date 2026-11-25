// AIR-602 (card A1) / ADR 0207 decisions 2, 3 and 4 and ADR 0217 (Accepted): the D1 admission COORDINATOR, the only admission path at the marker mode `d1`. DORMANT: at `r2` and `closed` (and while migration 0045
// is not applied) nothing calls it, and a call refuses (`letterboxd_admission_closed`) before its first effect. It is the part of card A1 that every admission writer shares:
// the rated-archive step, the Diary and Watchlist check and the inferred import call `admitVerifiedFilm` and map its typed outcome onto their own writer state.
//
// What it does for ONE item (a Letterboxd id and the movie its source check named), from DURABLE STATE ONLY (ADR 0207 decision 3, "Reconcile, then reserve"):
//   1. the key. ONE derivation function, `admissionOperationKey`, gives `admission:lid:<lid>` to every attempt of any path that knows the lid (ADR 0217, "single-key rule"); no caller builds the older kind keys for a
//      lid-resolved item, so a lid-resolved item can never have receipts under two keys. The legacy kinds `admission:inferred_import:<code>` and `admission:short_code:<code>` exist only for an item whose lid is not known.
//   2. `runOperationKey` (AIR-600): read the key's history and its fingerprint; a live `pending` attempt waits (never stolen); every other unresolved receipt is abandoned (`superseded_by_retry`) so its tail can
//      never land; an applied receipt is VALIDATED against current state (the admission row by code, the Film followed through redirects), never trusted on its own.
//   3. decide, once the history is clear: classify the pair against D1 with the table of decision 3, then RESERVE (a keyed receipt that asserts the observed fingerprint), run the d1 writer `admitRatedFilm` in the same
//      receipted batch (keep-first, typed conflicts, the evidence row), or finish without a write.
//   4. a lost race (a moved fingerprint) makes this attempt the loser: it wrote nothing and replans from step 2, a bounded number of times.
//   A pair that is admitted already (`present`) writes nothing; a genuinely NEW check of it (another archive, a later page check) records its evidence row through the evidence-only operation (ADR 0213 decision 4).
// The typed outcome (`outcome`) is what a caller maps onto its own state, `terminal` says whether the item may be settled for good:
//   admitted | present                      the pair is admitted (this attempt, or already); the caller's link proceeds                                          terminal
//   source_changed                          the reacquired source names another movie than the writer's durable record: no admission, no link; owner review          terminal
//   other_code                              another short code holds this Film (`other_code_on_film`): no admission; the caller's own rule applies (decision 3 table)  terminal
//   conflict                                the code is held by another Film (`code_on_other_film`): no admission, no link                                          terminal
//   wait | held | redirect | failed | unknown | deferred      non-terminal: the chunk stops before a receipt or the attempt failed; the same identity is repeated later    not terminal
//   history_exhausted                       the key holds the maximum number of receipts (owner review)                                                             terminal
// A terminal outcome that RESERVES NOTHING (`other_code`, `conflict`) can be finalized atomically against the observed history: pass `finalize(outcome, guard)`; the caller's own writer-state batch carries `guard`
// ({sql, params}) and answers `{refused:true}` when its batch was refused; the attempt then replans (ADR 0207 decision 3, step 5).
import {database,failed,many,one} from './film-person-authority.js';
import {RETRY_POLICY} from './canonical-receipts.js';
import {runOperationKey} from './receipt-operation-key.js';
import {admitRatedFilm,resolveAdmissionFilm,verifiedAdmission} from './film-admission.js';
import {FILM_ADMISSION_OPERATION,RATED_ADMISSION_ORIGIN,admissionDigestD1} from './canonical-rated-admission-producer.js';
import {admissionClosedError,admissionRoute,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {planIdentityEvidence,recordIdentityEvidence} from './identity-evidence.js';

export const ADMISSION_KINDS=Object.freeze(['lid','inferred_import','short_code']);
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const SHORT=/^[A-Za-z0-9_-]{1,40}$/;
const clockOf=now=>typeof now==='function'?now:()=>(now||new Date().toISOString());
const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);

// ADR 0217 single-key rule. `lid` is the Letterboxd id the writer holds (the Diary and Watchlist id, the rated archive's short code and the inferred import's lid are all the same boxd.it code). The
// older kinds are used only when no lid is known.
export function admissionOperationKey({lid=null,kind='lid',code=null}={}){
 if(lid!==null&&lid!==undefined){
  if(!LID.test(String(lid)))throw failed('film_person_invalid');
  return 'admission:lid:'+lid;
 }
 if((kind==='inferred_import'||kind==='short_code')&&SHORT.test(String(code??'')))return 'admission:'+kind+':'+code;
 throw failed('film_person_invalid');
}

// The pair against D1, by the table of ADR 0207 decision 3 (read only). -> {outcome:'admit'|'present'|'other_code'|'conflict'|'held'|'redirect', id?, revision?, reason?}
export async function planAdmissionD1(env,{tmdb,sourceCode}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const target=await resolveAdmissionFilm(env,tmdb);
 if(target.redirected)return {outcome:'redirect',id:target.id};
 if(target.held)return {outcome:'held',id:target.id,reason:target.held};
 const [prior,holder]=await Promise.all([
  one(db,'SELECT tmdb,source_code FROM film_rated_admission WHERE film_id=?',[target.id]),
  one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[sourceCode]),
 ]);
 if(holder&&holder.film_id!==target.id)return {outcome:'conflict',id:target.id,reason:'code_on_other_film'};
 if(prior&&(prior.tmdb!==tmdb||prior.source_code!==sourceCode))return {outcome:'other_code',id:target.id,reason:'other_code_on_film'};
 if(prior)return {outcome:'present',id:target.id,revision:target.revision};
 return {outcome:'admit',id:target.id,revision:target.revision};
}

const NON_TERMINAL=Object.freeze({wait:true,held:true,redirect:true,failed:true,unknown:true,deferred:true});
const result=(outcome,extra={})=>({outcome,terminal:!NON_TERMINAL[outcome],...extra});

// The coordinator. input:
//   kind        'lid' (Diary, Watchlist), 'inferred_import' or 'short_code': what the digest names (the key itself comes from `admissionOperationKey`)
//   lid         the Letterboxd id (the operation key). code: the short code the admission stores (`source_code`); defaults to `lid`.
//   receipt     {tmdb, archiveSha256 (the archive digest, or the digest of the check's evidence), title, year, filmPath?}; `sourceCode` is `code`; `verifiedAt` is not an input (it is the time of the admitting batch)
//   evidence    the input of `planIdentityEvidence` for the check that produced this item, or null for none (a check that did not run writes no evidence row)
//   intent      optional `{tmdb}`: the movie the writer's OWN durable record (its `linking` intent, its `admitting` row) named for this item before this reacquisition (ADR 0207 decision 4, 4A). When the source
//               now names ANOTHER movie, the outcome is `source_changed` (terminal, owner review): no admission, no link, and every earlier unresolved receipt of the key has been settled first (step 2), so the old
//               attempt can never land and contradict it (the race of decision 4)
//   finalize    optional `async (result, guard) => {refused?:true, ...}` for the terminal outcomes that reserve nothing
//   now, policy as for receiptedWrite
export async function admitVerifiedFilm(env,input={}){
 const kind=input.kind||'lid';
 if(!ADMISSION_KINDS.includes(kind))throw failed('film_person_invalid');
 const lid=input.lid??null;
 const code=input.code??lid;
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='d1')throw admissionClosedError(authority.mode);
 const clock=clockOf(input.now);
 const operationKey=admissionOperationKey({lid,kind,code});
 const at=clock();
 const checked=verifiedAdmission('tmdb_'+String(input.receipt?.tmdb??''),{...input.receipt,sourceCode:code,verifiedAt:at});
 if(!checked.ok){const error=failed('admission_not_verified');error.reason=checked.reason;throw error;}
 const admission=checked.admission;
 const tmdb=admission.tmdb;
 const evidence=input.evidence?await planIdentityEvidence(input.evidence):null;
 const evidenceDigest=evidence?.evidenceKey??admission.archiveSha256;
 const db=database(env);
 const receipt={tmdb,sourceCode:code,archiveSha256:admission.archiveSha256,title:admission.title,year:admission.year,filmPath:input.receipt?.filmPath??null,verifiedAt:at};

 // Step 3 of the protocol: an applied attempt is settled only when the CURRENT admission row of the code names this work's movie on the Film that holds it now.
 const validate=async(applied,{currentTarget})=>{
  const row=await one(db,'SELECT film_id,tmdb FROM film_rated_admission WHERE source_code=?',[code]);
  return row&&row.film_id===currentTarget.id&&row.tmdb===tmdb?'settled':'historical';
 };
 let observed=null;
 const decide=async ctx=>{
  // The reacquired source against the writer's own durable record, BEFORE the pair is classified: the key's history is clear here (every earlier attempt settled or validated), so the answer is a function of
  // durable state and cannot depend on the timing of an attempt that was cut off.
  if(input.intent&&input.intent.tmdb!==undefined&&input.intent.tmdb!==null&&String(input.intent.tmdb)!==tmdb){
   const changed=result('source_changed',{reason:'source_changed',intended:String(input.intent.tmdb),found:tmdb});
   if(typeof input.finalize!=='function')return {kind:'none',result:changed};
   return {kind:'finalize',write:async guard=>{const out=await input.finalize(changed,guard);return out?.refused===true?{refused:true}:{...changed,finalized:out??null};}};
  }
  const plan=await planAdmissionD1(env,{tmdb,sourceCode:code});
  observed=plan;
  if(plan.outcome==='present')return {kind:'none',result:result('present',{id:plan.id})};
  if(plan.outcome==='held'||plan.outcome==='redirect')return {kind:'none',result:result(plan.outcome,{id:plan.id,reason:plan.reason??null})};
  if(plan.outcome==='conflict'||plan.outcome==='other_code'){
   const terminal=result(plan.outcome,{id:plan.id,reason:plan.reason});
   if(typeof input.finalize!=='function')return {kind:'none',result:terminal};
   return {kind:'finalize',write:async guard=>{const out=await input.finalize(terminal,guard);return out?.refused===true?{refused:true}:{...terminal,finalized:out??null};}};
  }
  const content={kind,tmdb,sourceCode:code,evidenceDigest,title:admission.title,year:admission.year};
  const digest=await admissionDigestD1(content);
  const target={kind:'film',id:plan.id};
  return {kind:'reserve',
   request:{operation:FILM_ADMISSION_OPERATION,target,expectedRevision:plan.revision,digest,source:digest},
   write:{
    atomic:true,
    run:ctx2=>admitRatedFilm(env,{receiptKey:'tmdb_'+tmdb,receipt,filmId:plan.id,expectedRevision:ctx2.currentRevision,at:clock(),requestId:ctx2.requestId,
     receiptMark:{requestId:ctx2.requestId,attempt:ctx2.attempt,now:clock(),target:ctx2.target},evidence}),
    // The receipt's own readback (a reconcile of an unresolved attempt): the pair is committed when the admission row exists for it.
    readback:async()=>{const snap=await planAdmissionD1(env,{tmdb,sourceCode:code});return {digest:snap.outcome==='present'?digest:null,revision:snap.revision??await revisionOf(db,plan.id)};},
    revalidate:async()=>{const snap=await planAdmissionD1(env,{tmdb,sourceCode:code});return snap.outcome==='admit'?'proceed':snap.outcome==='present'?'superseded':'stale';},
   }};
 };
 let ran;
 try{ran=await runOperationKey(env,{origin:RATED_ADMISSION_ORIGIN,operationKey,now:clock,policy:input.policy||RETRY_POLICY},{validate,decide});}
 catch(error){
  // A race inside the writer's batch: the typed refusals of the d1 writer are outcomes, not crashes. The attempt's receipt stays pending and is abandoned by the next attempt of the key.
  if(error?.code==='admission_conflict')return result(error.reason==='code_on_other_film'?'conflict':'other_code',{reason:error.reason??null,error:error.code});
  if(error?.code==='admission_identity_held')return result('held',{reason:error.reason??null,error:error.code});
  if(error?.code==='film_person_redirect')return result('redirect',{error:error.code});
  throw error;
 }
 const base={operationKey,replans:ran.replans??0,fingerprint:ran.fingerprint??null};
 let out;
 switch(ran.status){
  case 'wait':out=result('wait',{reason:ran.reason??'in_flight',dueAt:ran.dueAt??null});break;
  case 'settled':out=result('present',{id:ran.currentTarget?.id??null,requestId:ran.receipt?.requestId??null});break;
  case 'none':out=ran.result;break;
  case 'finalized':out=ran.result;break;
  case 'refused':out=result('deferred',{reason:'finalize_refused'});break;
  case 'exhausted':out=result('history_exhausted',{});break;
  case 'reserved':{
   const o=ran.outcome||{};
   if(o.state==='applied'||o.state==='already')out=result(o.already?'present':'admitted',{id:observed?.id??null,requestId:ran.requestId});
   else if(o.state==='unknown')out=result('unknown',{requestId:ran.requestId,errorClass:o.errorClass??null});
   else if(o.state==='failed'||o.state==='abandoned')out=result('failed',{requestId:ran.requestId,errorClass:o.errorClass??o.receipt?.errorClass??null});
   else out=result('deferred',{requestId:ran.requestId,reason:o.reason??o.state??null});
   break;
  }
  default:out=result('deferred',{reason:'contended'});
 }
 // A pair that was admitted already (by this item's earlier attempt, by another route, before the key existed) writes nothing, but a genuinely NEW check of it is evidence (ADR 0213 decision 4).
 if(evidence&&out.outcome==='present'&&out.id){
  try{out.evidence=await recordIdentityEvidence(env,{evidence:input.evidence,filmId:out.id,now:clock,policy:input.policy||RETRY_POLICY});}
  catch(error){out.evidence={state:'failed',errorClass:error?.code||'unclassified'};}
 }
 return {...out,...base};
}

// The movie ids that already have an admission, for the readers that used to read the R2 object (ADR 0207 decision 5: they read D1 at `d1`). Read only; `exceptCode` leaves out the admission of that code.
// Bounded: the table holds one row per admitted Film, and a read past the bound is refused rather than answered with a partial set that would let a duplicate movie id through.
export const ADMITTED_IDS_CAP=50000;
export async function admittedMovieIds(env,{exceptCode=null}={}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const list=await many(db,'SELECT tmdb FROM film_rated_admission'+(exceptCode===null?'':' WHERE source_code<>?')+' LIMIT ?',exceptCode===null?[ADMITTED_IDS_CAP+1]:[exceptCode,ADMITTED_IDS_CAP+1]);
 if(list.length>ADMITTED_IDS_CAP)throw failed('admission_read_bounded');
 return list.map(row=>String(row.tmdb));
}
