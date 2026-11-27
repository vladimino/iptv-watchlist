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
import {fenced} from './canonical-mutations.js';
import {RETRY_POLICY,digestOf} from './canonical-receipts.js';
import {historyGuard,reconcileOperationKey,runOperationKey} from './receipt-operation-key.js';
import {admitLidOnlyFilm,admitRatedFilm,hasLidAdmissionTable,lidOnlyFilmId,resolveAdmissionFilm,verifiedAdmission} from './film-admission.js';
import {FILM_ADMISSION_OPERATION,RATED_ADMISSION_ORIGIN,admissionDigestD1} from './canonical-rated-admission-producer.js';
import {admissionClosedError,admissionRoute,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {planIdentityEvidence,recordIdentityEvidenceKeyed} from './identity-evidence.js';

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

// The pair against D1, by the table of ADR 0207 decision 3 (read only). -> {outcome:'admit'|'present'|'other_code'|'conflict'|'held'|'redirect'|'lid_only', id?, revision?, reason?}
export async function planAdmissionD1(env,{tmdb,sourceCode}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 // AIR-672 / ADR 0217 decision 5b: a lid-only Film for this lid is never attached or duplicated by a TMDB-proved admission (natural sync never attaches). Read while migration 0047 is applied; before it there is no such row.
 if(await hasLidAdmissionTable(db)){
  const lidOnly=await one(db,'SELECT film_id FROM film_lid_admission WHERE lid=?',[sourceCode]);
  if(lidOnly)return {outcome:'lid_only',id:lidOnly.film_id,reason:'lid_only_present'};
 }
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

const NON_TERMINAL=Object.freeze({wait:true,held:true,redirect:true,failed:true,unknown:true,deferred:true,source_unavailable:true,needs_check:true});
const result=(outcome,extra={})=>({outcome,terminal:!NON_TERMINAL[outcome],...extra});

// The coordinator. input:
//   kind        'lid' (Diary, Watchlist), 'inferred_import' or 'short_code': what the digest names (the key itself comes from `admissionOperationKey`)
//   lid         the Letterboxd id (the operation key). code: the short code the admission stores (`source_code`); defaults to `lid`.
//   receipt, evidence   the verified check: receipt {tmdb, archiveSha256 (the archive digest, or the digest of the check's evidence), title, year, filmPath?}; `sourceCode` is `code`; `verifiedAt` is not an input (it
//               is the time of the admitting batch); evidence is the input of `planIdentityEvidence` for the check that produced this item, or null (a check that did not run writes no evidence row)
//   reacquire   optional `async () => {ok:true, receipt, evidence} | {ok:false, reason, ...}`: the REAL bounded source check, run only after the key's history is reconciled and only when this call still needs one
//               (ADR 0207 decision 4, 4A). With it `receipt` and `evidence` are not given. A failed check is `source_unavailable` (the caller applies its own transport / gone / definite rule to `reason`) and
//               writes nothing; no evidence is ever synthesized for a recovery that made no check.
//   intent      optional `{tmdb}`: the movie the writer's OWN durable record (its `linking` intent, its `admitting` row) named for this item before this call. An applied attempt of the key that matches it
//               settles the item WITHOUT a fetch and without fresh evidence; when the source (acquired now, or given) names ANOTHER movie the outcome is `source_changed` (terminal, owner review): no
//               admission, no link, and every earlier unresolved receipt of the key has been settled first (step 2), so the old attempt can never land and contradict it (the race of decision 4)
//   evidenceDue       optional boolean: the writer's own durable record says a genuine check of this item OWES an evidence row (set before the first effect, cleared when the evidence is proven recorded). An applied
//               attempt that matches the intent then does NOT settle the item without a fetch (the admission may be another route's, and the check that created this intent may have died before its evidence
//               was written): the source is really reacquired and its evidence recorded, unless a `pendingEvidence` obligation is kept. It is a boolean obligation, not a proof payload (ADR 0207 4A), and the
//               evidence ledger is never READ to decide it (ADR 0213 decision 8)
//   pendingEvidence   optional evidence input an earlier call could not record (`evidence_unrecorded`); a retry that settles from the intent records it before reporting success
//   finalize    `async (result, guard) => {refused?:true, ...}` for the terminal outcomes that reserve nothing (`other_code`, `conflict`, `source_changed`): the caller writes its OWN terminal state with `guard`
//               (one SQL boolean over the operation history) in the same batch and answers `{refused:true}` when it was refused; the attempt then replans from step 2. Without it the outcome is returned
//               unfenced and the caller owns that limit (a writer state that lives outside D1)
//   now, policy as for receiptedWrite
// A completion is only reported when it is PROVEN: `present` after a genuine check means the evidence row exists (written now, or already there); an evidence write that failed, is unavailable or is still
// in flight is `deferred` with reason `evidence_unrecorded` and the evidence input to keep (`pendingEvidence`).
export async function admitVerifiedFilm(env,input={}){
 const kind=input.kind||'lid';
 if(!ADMISSION_KINDS.includes(kind))throw failed('film_person_invalid');
 const lid=input.lid??null;
 const code=input.code??lid;
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='d1')throw admissionClosedError(authority.mode);
 const clock=clockOf(input.now);
 const policy=input.policy||RETRY_POLICY;
 const operationKey=admissionOperationKey({lid,kind,code});
 const db=database(env);
 const intentTmdb=input.intent&&input.intent.tmdb!==undefined&&input.intent.tmdb!==null?String(input.intent.tmdb):null;
 // The source of this call: the check it was given, or the one `reacquire` makes (once, and only after the history is reconciled).
 let src=null;
 const acquire=async()=>{
  if(src)return src;
  let got;
  if(typeof input.reacquire==='function'){
   got=await input.reacquire();
   if(!got||got.ok!==true){src={fail:got||{reason:'source_unavailable'}};return src;}
  }else got={receipt:input.receipt,evidence:input.evidence};
  const at=clock();
  const checked=verifiedAdmission('tmdb_'+String(got.receipt?.tmdb??''),{...got.receipt,sourceCode:code,verifiedAt:at});
  if(!checked.ok){const error=failed('admission_not_verified');error.reason=checked.reason;throw error;}
  const admission=checked.admission;
  const evidence=got.evidence?await planIdentityEvidence(got.evidence):null;
  src={admission,tmdb:admission.tmdb,evidenceInput:got.evidence||null,evidence,evidenceDigest:evidence?.evidenceKey??admission.archiveSha256,
   receipt:{tmdb:admission.tmdb,sourceCode:code,archiveSha256:admission.archiveSha256,title:admission.title,year:admission.year,filmPath:got.receipt?.filmPath??null,verifiedAt:at}};
  return src;
 };
 // A call that is GIVEN its check validates it up front (an invalid item is refused before any read of a Film); a call that must reacquire does so only inside the protocol. `settleOnly` makes the call a pure
 // reconcile: it needs no source, settles an applied attempt that matches the intent (`present`, `fromIntent`), waits on a live one, and otherwise answers `needs_check` with the history guard of the clear history it
 // observed, so the caller reacquires its source itself and still fences any terminal write of its own.
 if(input.settleOnly!==true&&typeof input.reacquire!=='function')await acquire();

 // Step 3 of the protocol: an applied attempt is settled only when the CURRENT admission row of the code names the work's movie on the Film that holds it now. The work's movie is the writer's own durable
 // intent when there is one and no check contradicts it (a settled attempt then needs no fetch), else the movie of the check itself.
 const validate=async(applied,{currentTarget})=>{
  const checked=src&&!src.fail?src:null;
  const want=checked?(intentTmdb!==null&&intentTmdb!==checked.tmdb?null:checked.tmdb):intentTmdb;
  if(want===null)return 'historical';
  const row=await one(db,'SELECT film_id,tmdb FROM film_rated_admission WHERE source_code=?',[code]);
  if(!(row&&row.film_id===currentTarget.id&&row.tmdb===want))return 'historical';
  // Settling from the intent alone (no check in this call) is allowed only when no evidence is owed, or the evidence to record is kept.
  if(!checked&&input.evidenceDue===true&&!input.pendingEvidence)return 'historical';
  return 'settled';
 };
 let observed=null;
 // The guard a terminal writer carries: `{sql, params}` (one SQL boolean over the key's operation history, exactly the fingerprint this attempt observed), `statement` (the same condition as ONE assertion
 // statement for a writer whose own batch is a D1 batch: a false condition fails the CHECK and rolls that batch back whole) and `holds()` (the condition evaluated NOW, for a writer whose state lives outside D1
 // and cannot carry a statement: it re-checks immediately before its own write, and the window between that check and the write is that writer's documented limit).
 const guardOf=guard=>({...guard,statement:[fenced.assertSql(guard.sql),guard.params],holds:async()=>{
  const row=await one(db,'SELECT CASE WHEN ('+guard.sql+') THEN 1 ELSE 0 END AS ok',guard.params);
  return Number(row?.ok)===1;
 }});
 const terminalOf=(terminal)=>{
  if(typeof input.finalize!=='function')return {kind:'none',result:terminal};
  return {kind:'finalize',write:async guard=>{const out=await input.finalize(terminal,guardOf(guard));return out?.refused===true?{refused:true}:{...terminal,finalized:out??null};}};
 };
 const decide=async ctx=>{
  if(input.settleOnly===true)return {kind:'none',result:result('needs_check',{guardInput:{fingerprint:ctx.fingerprint}})};
  const a=await acquire();
  // The source could not be reacquired now. History is clear (reconciled above), nothing is written; the caller classifies `reason` (transport keeps its place, a 404 costs one attempt).
  if(a.fail){
   const unavailable=result('source_unavailable',{reason:a.fail.reason??'source_unavailable',detail:a.fail,charged:a.fail.charged===true});
   // An answer that COSTS an attempt (a 404, a definite disagreement) is a terminal disposition of this attempt: it is written with the history guard like any other. A free answer (transport, not now) is not.
   return unavailable.charged?terminalOf(unavailable):{kind:'none',result:unavailable};
  }
  // The reacquired source against the writer's own durable record, BEFORE the pair is classified: the key's history is clear here (every earlier attempt settled or validated), so the answer is a function of
  // durable state and cannot depend on the timing of an attempt that was cut off.
  if(intentTmdb!==null&&intentTmdb!==a.tmdb)return terminalOf(result('source_changed',{reason:'source_changed',intended:intentTmdb,found:a.tmdb}));
  const plan=await planAdmissionD1(env,{tmdb:a.tmdb,sourceCode:code});
  observed=plan;
  if(plan.outcome==='present')return {kind:'none',result:result('present',{id:plan.id})};
  if(plan.outcome==='held'||plan.outcome==='redirect')return {kind:'none',result:result(plan.outcome,{id:plan.id,reason:plan.reason??null})};
  if(plan.outcome==='conflict'||plan.outcome==='other_code')return terminalOf(result(plan.outcome,{id:plan.id,reason:plan.reason}));
  // ADR 0217 decision 5b (the table of "Moment it is seen"): by the planner, before any link. Diary and Watchlist (kind `lid`): the lid-only Film is the answer, settle only; the rated step: needs_review; the inferred import: conflict.
  if(plan.outcome==='lid_only'){
   if(kind==='lid')return {kind:'none',result:result('present_lid_only',{id:plan.id,reason:plan.reason})};
   return terminalOf(result(kind==='short_code'?'needs_review':'conflict',{id:plan.id,reason:plan.reason}));
  }
  const digest=await admissionDigestD1({kind,tmdb:a.tmdb,sourceCode:code,evidenceDigest:a.evidenceDigest,title:a.admission.title,year:a.admission.year});
  const target={kind:'film',id:plan.id};
  return {kind:'reserve',
   request:{operation:FILM_ADMISSION_OPERATION,target,expectedRevision:plan.revision,digest,source:digest},
   write:{
    atomic:true,
    run:ctx2=>admitRatedFilm(env,{receiptKey:'tmdb_'+a.tmdb,receipt:a.receipt,filmId:plan.id,expectedRevision:ctx2.currentRevision,at:clock(),requestId:ctx2.requestId,
     receiptMark:{requestId:ctx2.requestId,attempt:ctx2.attempt,now:clock(),target:ctx2.target},evidence:a.evidence}),
    // The receipt's own readback (a reconcile of an unresolved attempt): the pair is committed when the admission row exists for it.
    readback:async()=>{const snap=await planAdmissionD1(env,{tmdb:a.tmdb,sourceCode:code});return {digest:snap.outcome==='present'?digest:null,revision:snap.revision??await revisionOf(db,plan.id)};},
    revalidate:async()=>{const snap=await planAdmissionD1(env,{tmdb:a.tmdb,sourceCode:code});return snap.outcome==='admit'?'proceed':snap.outcome==='present'?'superseded':'stale';},
   }};
 };
 let ran;
 try{ran=await runOperationKey(env,{origin:RATED_ADMISSION_ORIGIN,operationKey,now:clock,policy},{validate,decide});}
 catch(error){
  // A race inside the writer's batch: the typed refusals of the d1 writer are outcomes, not crashes. The attempt's receipt stays pending and is abandoned by the next attempt of the key.
  if(error?.code==='admission_conflict')return result(error.reason==='code_on_other_film'||error.reason==='lid_only_present'?'conflict':'other_code',{reason:error.reason??null,error:error.code});
  if(error?.code==='admission_identity_held')return result('held',{reason:error.reason??null,error:error.code});
  if(error?.code==='film_person_redirect')return result('redirect',{error:error.code});
  throw error;
 }
 const base={operationKey,replans:ran.replans??0,fingerprint:ran.fingerprint??null};
 if(ran.status==='none'&&ran.result?.outcome==='needs_check'){
  const cond=historyGuard({origin:RATED_ADMISSION_ORIGIN,operationKey,fingerprint:ran.result.guardInput.fingerprint});
  return {...ran.result,...base,guard:guardOf(cond)};
 }
 let out;
 switch(ran.status){
  case 'wait':out=result('wait',{reason:ran.reason??'in_flight',dueAt:ran.dueAt??null});break;
  case 'settled':out=result('present',{id:ran.currentTarget?.id??null,requestId:ran.receipt?.requestId??null,...(src&&!src.fail?{}:{fromIntent:true})});break;
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
 // A pair that was admitted already (by this item's earlier attempt, by another route, before the key existed) writes nothing, but a genuinely NEW check of it is evidence (ADR 0213 decision 4). The evidence-only
 // operation runs under its own key `evidence:<evidence_key>` and its completion is PROVEN before the item is reported complete. The evidence to record is the one of a check THIS call performed, or the one an
 // earlier call kept (`pendingEvidence`); a recovery that made no check records none.
 const performed=src&&!src.fail?src.evidenceInput:null;
 const toRecord=out.outcome==='present'&&out.id?(performed||input.pendingEvidence||null):null;
 if(toRecord){
  let ev;
  try{ev=await recordIdentityEvidenceKeyed(env,{evidence:toRecord,filmId:out.id,now:clock,policy},{run:runOperationKey});}
  catch(error){ev={state:'failed',written:false,errorClass:error?.code||'unclassified'};}
  out.evidence=ev;
  if(ev.state!=='present'&&ev.state!=='written')out=result('deferred',{reason:'evidence_unrecorded',admitted:true,id:out.id,pendingEvidence:toRecord,evidence:ev});
 }
 return {...out,...base};
}

// The movie ids that already have an admission, for the readers that used to read the R2 object (ADR 0207 decision 5: they read D1 at `d1`). Read only; `exceptCode` leaves out the admission of that code.
// Keyset-paged by `film_id` (5,000 rows a page), so the answer is complete however many Films are admitted: there is no business cap on the set, only a hard safety stop on the number of pages (a read past it is
// refused rather than answered with a partial set that would let a duplicate movie id through). The read is advisory: the writer batch's own keep-first constraints are the fence.
export const ADMITTED_IDS_PAGE=5000;
export const ADMITTED_IDS_MAX_PAGES=400;
export async function admittedMovieIds(env,{exceptCode=null}={}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const ids=[];let after='';
 for(let page=0;;page++){
  if(page>=ADMITTED_IDS_MAX_PAGES)throw failed('admission_read_bounded');
  const list=await many(db,'SELECT film_id,tmdb FROM film_rated_admission WHERE film_id>?'+(exceptCode===null?'':' AND source_code<>?')+' ORDER BY film_id LIMIT ?',exceptCode===null?[after,ADMITTED_IDS_PAGE]:[after,exceptCode,ADMITTED_IDS_PAGE]);
  for(const row of list)ids.push(String(row.tmdb));
  if(list.length<ADMITTED_IDS_PAGE)break;
  after=list[list.length-1].film_id;
 }
 return ids;
}

// AIR-672 / ADR 0217 (Accepted) decisions 5 and 6 (delivery step 3), DORMANT: the `lid_only` kind of the coordinator. A verified Letterboxd film page with a positively absent TMDB relation (H1, the caller's
// `reacquire` returns the proof of `lidOnlyPageProof`) is admitted as the canonical Film `film:lb:<lid>` by `admitLidOnlyFilm`, under the ONE common key `admission:lid:<lid>` (the same key as the TMDB-proved
// kind `lid`), so a lid has at most one unresolved attempt across all paths and kinds. It runs only at the marker `d1` (`closed` and `r2` refuse before the first effect, as `admitVerifiedFilm` does) and only
// when migration 0047 is applied (`admission_unavailable` otherwise, before any effect).
export const LID_ONLY_KIND='lid_only';
const OLDER_KEY_KINDS=Object.freeze(['short_code','inferred_import']);

// The lid against D1 (read only), by the cases of ADR 0217 decision 6. -> {outcome, id?, revision?, reason?}
//   present_lid_only   `film_lid_admission` names this lid (replay, lost response, crash before settlement): settle only (case 4)
//   present            a trusted, non-conflicting `letterboxd` claim of the lid sits on a TMDB Film, or a rated admission holds the code (case 4b): the existing Film, neither a conflict nor lid-only
//   redirect | held    the Film is a redirect source (case 9), or the claim is the only trusted one on a Film that is a redirect source: non-terminal
//   conflict           any other claim of the lid (untrusted, conflicting, a second row), or the id `film:lb:<lid>` taken by something that is not this admission (case 7): owner review
//   admit              nothing of the lid exists: revision of `film:lb:<lid>` (0)
export async function planLidOnlyD1(env,{lid}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const id=lidOnlyFilmId(lid);
 if(!await hasLidAdmissionTable(db))throw failed('admission_unavailable',new Error('film_lid_admission_missing'));
 const [row,claims,rated,film,redirect]=await Promise.all([
  one(db,'SELECT film_id FROM film_lid_admission WHERE lid=?',[lid]),
  many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid]),
  one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[lid]),
  one(db,'SELECT id FROM film WHERE id=?',[id]),
  one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]),
 ]);
 const followed=async from=>{let at=from;for(let hop=0;hop<8;hop++){const next=await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[at]);if(!next)return {id:at,redirected:hop>0};at=next.to_film_id;}return {id:at,redirected:true,loop:true};};
 if(row){
  const target=await followed(row.film_id);
  const owner=claims.find(claim=>claim.trusted===1&&claim.conflicting===0);
  if(claims.length!==1||!owner||owner.film_id!==row.film_id)return {outcome:'conflict',id:target.id,reason:'ownership_incomplete'};
  return {outcome:'present_lid_only',id:target.id,redirected:target.redirected};
 }
 if(claims.length){
  const owner=claims.find(claim=>claim.trusted===1&&claim.conflicting===0);
  if(claims.length===1&&owner){
   const target=await followed(owner.film_id);
   if(target.redirected)return {outcome:'redirect',id:target.id};
   return {outcome:'present',id:target.id};
  }
  return {outcome:'conflict',reason:'lid_claim_conflict'};
 }
 if(rated)return {outcome:'present',id:rated.film_id};
 if(redirect)return {outcome:'redirect',id:redirect.to_film_id};
 if(film)return {outcome:'conflict',id,reason:'film_id_taken'};
 return {outcome:'admit',id,revision:await revisionOf(db,id)};
}

// The content digest of a lid-only receipt: the kind, the lid and the proof's own digest (the causal root). The route and the check time are not in it, so two routes that check the same page agree.
export const lidOnlyReceiptDigest=({lid,proofDigest})=>digestOf({operation:FILM_ADMISSION_OPERATION,d1:true,content:{kind:LID_ONLY_KIND,lid,proofDigest}});

// The coordinator for ONE lid. input:
//   lid, route   the Letterboxd id and the entry point that checked it (`watchlist_admission`, `ratings_diary`, `letterboxd_rated_archive`)
//   reacquire    `async () => {ok:true, proof, links?:{fence:{key,parts,etag}, tmdbAlias?:string|null}} | {ok:false, reason, ...}`: the REAL bounded page check (H1), run only after the key's history and the
//                older keys' history are reconciled. `proof` is `lidOnlyPageProof`'s `tmdb_none` proof. A failed check is `source_unavailable` and writes nothing. A page whose TMDB state is not `tmdb_none` never reaches
//                here: the caller maps its typed state (decision 3) and does not call the coordinator.
//   links        the Ratings link document as the caller read it, when `reacquire` does not return it
//   olderKeysKnown   `false` when the older keys of the code this lid resolves from cannot be named (an unresolved short code, an alias without a reverse entry): the attempt is HELD (`older_key_unknown`), never
//                admitted on an assumed absence. Default true (the lid is the code).
//   finalize, now, policy   as for `admitVerifiedFilm`
// -> {outcome, terminal, ...}: admitted_lid_only | present_lid_only | present | conflict | lid_unverified | ratings_tmdb_link (held) | wait | held | redirect | deferred | failed | unknown | source_unavailable | history_exhausted.
export async function admitVerifiedLidOnly(env,input={}){
 const lid=input.lid??null;
 if(typeof lid!=='string'||!LID.test(lid))return result('lid_unverified',{reason:'lid_unverified'});
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='d1')throw admissionClosedError(authority.mode);
 const clock=clockOf(input.now);
 const policy=input.policy||RETRY_POLICY;
 const db=database(env);
 if(!await hasLidAdmissionTable(db))throw failed('admission_unavailable',new Error('film_lid_admission_missing'));
 if(input.olderKeysKnown===false)return result('deferred',{reason:'older_key_unknown'});
 // Read-only reconciliation of the OLDER keys of this code (ADR 0217 decision 5a): a live attempt waits (non-terminal), any other unresolved receipt is abandoned (ADR 0207 step 2), an applied one is validated
 // against current state by the planner below. Only then is the lid key reserved; the older key is never reserved again for this lid.
 for(const kind of OLDER_KEY_KINDS){
  const older=await reconcileOperationKey(env,{origin:RATED_ADMISSION_ORIGIN,operationKey:admissionOperationKey({kind,code:lid}),now:clock},{validate:async()=>'historical'});
  if(older.status==='wait')return result('wait',{reason:'older_key_'+(older.reason||'in_flight'),olderKey:kind,dueAt:older.dueAt??null});
 }
 const operationKey=admissionOperationKey({lid});
 let src=null;
 const acquire=async()=>{
  if(src)return src;
  let got;
  if(typeof input.reacquire==='function'){
   got=await input.reacquire();
   if(!got||got.ok!==true){src={fail:got||{reason:'source_unavailable'}};return src;}
  }else got={proof:input.proof,links:input.links};
  src={proof:got.proof,links:got.links??input.links??null,intent:null};
  return src;
 };
 if(typeof input.reacquire!=='function'&&input.settleOnly!==true)await acquire();
 // An applied attempt is settled only while the CURRENT durable rows still show a complete lid-only admission of the lid (decision 5b, "complete, non-conflicting ownership").
 const validate=async(applied,{currentTarget})=>{
  const plan=await planLidOnlyD1(env,{lid});
  return plan.outcome==='present_lid_only'&&plan.id===currentTarget.id?'settled':'historical';
 };
 let observed=null;
 const guardOf=guard=>({...guard,statement:[fenced.assertSql(guard.sql),guard.params],holds:async()=>{
  const row=await one(db,'SELECT CASE WHEN ('+guard.sql+') THEN 1 ELSE 0 END AS ok',guard.params);
  return Number(row?.ok)===1;
 }});
 const terminalOf=terminal=>{
  if(typeof input.finalize!=='function')return {kind:'none',result:terminal};
  return {kind:'finalize',write:async guard=>{const out=await input.finalize(terminal,guardOf(guard));return out?.refused===true?{refused:true}:{...terminal,finalized:out??null};}};
 };
 const decide=async ctx=>{
  if(input.settleOnly===true)return {kind:'none',result:result('needs_check',{guardInput:{fingerprint:ctx.fingerprint}})};
  // The durable state first: a replay, a lost response and the TMDB-held lid settle WITHOUT a fetch (case 4, "replay never fetches").
  const plan=await planLidOnlyD1(env,{lid});
  observed=plan;
  if(plan.outcome==='present_lid_only')return {kind:'none',result:result('present_lid_only',{id:plan.id})};
  if(plan.outcome==='present')return {kind:'none',result:result('present',{id:plan.id})};
  if(plan.outcome==='held'||plan.outcome==='redirect')return {kind:'none',result:result(plan.outcome,{id:plan.id??null,reason:plan.reason??null})};
  if(plan.outcome==='conflict')return terminalOf(result('conflict',{id:plan.id??null,reason:plan.reason}));
  const a=await acquire();
  if(a.fail){
   const unavailable=result('source_unavailable',{reason:a.fail.reason??'source_unavailable',detail:a.fail,charged:a.fail.charged===true});
   return unavailable.charged?terminalOf(unavailable):{kind:'none',result:unavailable};
  }
  // The Ratings link of the lid's fact key carries a TMDB alias: the page said no TMDB but the Ratings says otherwise. Stop at the pending state, never admit (decision 5b).
  if(a.links?.tmdbAlias)return {kind:'none',result:result('held',{reason:'ratings_tmdb_link'})};
  const proofDigest=a.proof?.proofDigest;
  if(typeof proofDigest!=='string')throw failed('admission_not_verified');
  const digest=await lidOnlyReceiptDigest({lid,proofDigest});
  const target={kind:'film',id:plan.id};
  return {kind:'reserve',
   request:{operation:FILM_ADMISSION_OPERATION,target,expectedRevision:plan.revision,digest,source:digest},
   write:{
    atomic:true,
    run:ctx2=>admitLidOnlyFilm(env,{lid,route:input.route,proof:a.proof,filmId:plan.id,expectedRevision:ctx2.currentRevision,at:clock(),requestId:ctx2.requestId,
     receiptMark:{requestId:ctx2.requestId,attempt:ctx2.attempt,now:clock(),target:ctx2.target},linksFence:a.links?.fence??null}),
    readback:async()=>{const snap=await planLidOnlyD1(env,{lid});return {digest:snap.outcome==='present_lid_only'?digest:null,revision:await revisionOf(db,plan.id)};},
    revalidate:async()=>{const snap=await planLidOnlyD1(env,{lid});return snap.outcome==='admit'?'proceed':snap.outcome==='present_lid_only'?'superseded':'stale';},
   }};
 };
 let ran;
 try{ran=await runOperationKey(env,{origin:RATED_ADMISSION_ORIGIN,operationKey,now:clock,policy},{validate,decide});}
 catch(error){
  if(error?.code==='admission_conflict')return result('conflict',{reason:error.reason??null,error:error.code});
  if(error?.code==='film_person_redirect')return result('redirect',{error:error.code});
  throw error;
 }
 const base={operationKey,replans:ran.replans??0,fingerprint:ran.fingerprint??null};
 if(ran.status==='none'&&ran.result?.outcome==='needs_check'){
  const cond=historyGuard({origin:RATED_ADMISSION_ORIGIN,operationKey,fingerprint:ran.result.guardInput.fingerprint});
  return {...ran.result,...base,guard:guardOf(cond)};
 }
 let out;
 switch(ran.status){
  case 'wait':out=result('wait',{reason:ran.reason??'in_flight',dueAt:ran.dueAt??null});break;
  case 'settled':out=result('present_lid_only',{id:ran.currentTarget?.id??null,requestId:ran.receipt?.requestId??null,fromReceipt:true});break;
  case 'none':out=ran.result;break;
  case 'finalized':out=ran.result;break;
  case 'refused':out=result('deferred',{reason:'finalize_refused'});break;
  case 'exhausted':out=result('history_exhausted',{});break;
  case 'reserved':{
   const o=ran.outcome||{};
   if(o.state==='applied'||o.state==='already')out=result(o.already?'present_lid_only':'admitted_lid_only',{id:observed?.id??null,requestId:ran.requestId});
   else if(o.state==='unknown')out=result('unknown',{requestId:ran.requestId,errorClass:o.errorClass??null});
   else if(o.state==='failed'||o.state==='abandoned')out=result('failed',{requestId:ran.requestId,errorClass:o.errorClass??o.receipt?.errorClass??null});
   else out=result('deferred',{requestId:ran.requestId,reason:o.reason??o.state??null});
   break;
  }
  default:out=result('deferred',{reason:'contended'});
 }
 return {...out,...base};
}
