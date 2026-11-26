// AIR-499 rated_admission_retention. Receipted units for film_admission and film_retention. Reuses admitRatedFilm
// and retainFilm. DORMANT below `open`: one writerRoute read, nothing else. held / unreadable throw and never name R2.
// Rated admission may create film:tmdb:<n> from a verified receipt; retention never creates a Film. Provenance is the
// verified-films.json entry or a watchlist scan observation; clocks are never invented.
import {database,failed,many,one} from './film-person-authority.js';
import {RETRY_POLICY,defineOperation,digestOf,operationRegistry,receiptedWrite} from './canonical-receipts.js';
import {INLINE_RECONCILE_LIMIT,SOURCE_CHANGED,producerRequestId,producerRouteOpen,reconcileOwnOrigin} from './canonical-producer-adapters.js';
import {admissionClosedError,admissionRoute,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {RATED_RECEIPT_KEY,admitRatedFilm,advanceRetentionWatermark,readRetentionWatermark,retainFilm,resolveAdmissionFilm,verifiedAdmission} from './film-admission.js';

export const RATED_ADMISSION_ORIGIN='rated_admission_retention';
export const FILM_ADMISSION_OPERATION='film_admission';
export const FILM_RETENTION_OPERATION='film_retention';
export const RATED_ADMISSION_KINDS=Object.freeze([FILM_ADMISSION_OPERATION,FILM_RETENTION_OPERATION]);
export const UNIT_CAP=12;
const CLOSED=new Set(['film_person_held','film_person_unavailable','film_person_not_open','film_person_generation_moved']);
const READ_FAILURES=new Set(['film_person_unavailable','film_person_held','film_person_not_open']);
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TMDB=/^[1-9]\d{0,11}$/;
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const instant=value=>typeof value==='string'&&ISO.test(value)?value:null;
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const revisionOf=async(db,id)=>Number((await one(db,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?",[id]))?.revision??0);
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});

function typedClaim(rows,scheme,value){
 const pool=(rows||[]).filter(row=>row.scheme===scheme&&String(row.value)===String(value));
 const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0;
 const owner=pool.find(isOwn)?.film_id??null;
 if(pool.some(row=>!(isOwn(row)&&row.film_id===owner)))return {conflict:true,filmId:null};
 return {conflict:false,filmId:owner};
}

function sameFilmUntrustedTmdb(parts,tmdb,lidFilm){
 if(!lidFilm||!TMDB.test(tmdb))return false;
 const pool=(parts||[]).filter(row=>row.scheme==='tmdb'&&String(row.value)===String(tmdb));
 if(!pool.length)return false;
 if(pool.some(row=>Number(row.conflicting)===1))return false;
 if(pool.some(row=>Number(row.trusted)===1&&row.film_id!==lidFilm))return false;
 if(pool.some(row=>row.film_id!==lidFilm))return false;
 return pool.every(row=>Number(row.trusted)!==1);
}

export async function resolveExistingRetentionFilm(env,{id,lid,tmdbId}={}){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const spelled=typeof id==='string'&&id.startsWith('film:')?id:null;
 const letterboxd=spelled?null:(typeof lid==='string'&&LID.test(lid)?lid:null);
 const tmdb=String(tmdbId??'');
 // AIR-532: the typed ids of one Film are read with ONE statement (was up to three); the rows are the same, so the claims below are unchanged.
 const parts=[];
 const marks=[],params=[];
 if(TMDB.test(tmdb)){marks.push("(scheme='tmdb' AND value=?)");params.push(tmdb);}
 if(letterboxd){marks.push("(scheme='letterboxd' AND value=?)");params.push(letterboxd);}
 if(spelled){marks.push('film_id=?');params.push(spelled);}
 if(marks.length){
  const found=await many(db,'SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE '+marks.join(' OR '),params);
  parts.push(...found);
 }
 const tmdbClaim=TMDB.test(tmdb)?typedClaim(parts,'tmdb',tmdb):{conflict:false,filmId:null};
 const lidClaim=letterboxd?typedClaim(parts,'letterboxd',letterboxd):{conflict:false,filmId:null};
 if(lidClaim.conflict)throw failed('identity_collision');
 if(tmdbClaim.conflict){
  if(!sameFilmUntrustedTmdb(parts,tmdb,lidClaim.filmId))throw failed('identity_collision');
 }
 else if(tmdbClaim.filmId&&lidClaim.filmId&&tmdbClaim.filmId!==lidClaim.filmId)throw failed('identity_collision');
 let filmId=lidClaim.filmId||tmdbClaim.filmId||null;
 if(spelled){
  if(filmId&&filmId!==spelled)throw failed('identity_collision');
  if(!filmId&&await one(db,'SELECT id FROM film WHERE id=?',[spelled]))filmId=spelled;
 }
 if(!filmId)return null;
 const held=await one(db,'SELECT (SELECT 1 FROM film_redirect WHERE from_id=?) AS redirected,(SELECT id FROM film WHERE id=?) AS film',[filmId,filmId]);
 if(held?.redirected)throw failed('film_person_redirect');
 if(!held?.film)return null;
 return filmId;
}

export function admissionContent(input){
 const checked=verifiedAdmission(input?.receiptKey,input?.receipt);
 if(!checked.ok)throw failed('admission_not_verified');
 const a=checked.admission;
 return {tmdb:a.tmdb,sourceCode:a.sourceCode,archiveSha256:a.archiveSha256,title:a.title,year:a.year,verifiedAt:a.verifiedAt,receiptFilmKey:a.receiptFilmKey,receiptKey:RATED_RECEIPT_KEY};
}
export function retentionContent(input){
 if(!plain(input)||typeof input.id!=='string'||!input.id.startsWith('film:')||typeof input.watchlist!=='boolean'||!instant(input.observedAt))throw failed('retention_invalid');
 return {id:input.id,watchlist:input.watchlist,observedAt:instant(input.observedAt),evidence:plain(input.evidence)?input.evidence:{}};
}
export async function admissionDigest(input){return digestOf({operation:FILM_ADMISSION_OPERATION,content:admissionContent(input)});}
// AIR-602 / ADR 0207 decision 3: the request identity of an admission at the marker mode `d1` has NO clock and no R2 key in it: `{kind, movie id, code, evidence digest, title, year}`. The same source content
// always gives the same digest, so a retry (a lost response, a restart) names the same request, and a title edit on the page is a new digest, hence a new request.
export function admissionContentD1(input){
 return {kind:input?.kind,tmdb:String(input?.tmdb??''),sourceCode:input?.sourceCode,evidence:input?.evidenceDigest,title:typeof input?.title==='string'&&input.title.trim()?input.title.trim():null,year:Number.isInteger(input?.year)?input.year:null};
}
export async function admissionDigestD1(input){return digestOf({operation:FILM_ADMISSION_OPERATION,d1:true,content:admissionContentD1(input)});}
export async function retentionDigest(input){return digestOf({operation:FILM_RETENTION_OPERATION,id:input?.id,content:retentionContent(input)});}

async function planAdmission(env,input){
 const content=admissionContent(input);
 const target=await resolveAdmissionFilm(env,content.tmdb);
 if(target.redirected)throw failed('film_person_redirect');
 if(target.held){const error=failed('admission_identity_held');error.reason=target.held;throw error;}
 const db=database(env);
 const prior=await one(db,'SELECT tmdb,source_code,archive_sha256,receipt_key FROM film_rated_admission WHERE film_id=?',[target.id]);
 const holder=await one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[content.sourceCode]);
 if(holder&&holder.film_id!==target.id)throw failed('admission_conflict');
 if(prior&&(prior.tmdb!==content.tmdb||prior.source_code!==content.sourceCode))throw failed('admission_conflict');
 const noop=!!(prior&&prior.archive_sha256===content.archiveSha256&&prior.receipt_key===RATED_RECEIPT_KEY);
 return {id:target.id,revision:target.revision,noop,absent:false};
}
// `watermark` is `{present, observedAt}` as read once per slice (AIR-532, ADR 0173); a caller without one (a reconcile pass, a single call) lets the plan read it.
async function planRetention(env,input,{watermark}={}){
 const content=retentionContent(input);
 const db=database(env);
 // ONE statement for the redirect, the Film row, the stored retention row and the revision (was four reads), same rows and same order of checks.
 const read=await one(db,"SELECT (SELECT 1 FROM film_redirect WHERE from_id=?) AS redirected,(SELECT id FROM film WHERE id=?) AS film,(SELECT COUNT(*) FROM film_retention WHERE film_id=?) AS has_row,(SELECT watchlist FROM film_retention WHERE film_id=?) AS watchlist,(SELECT evidence_json FROM film_retention WHERE film_id=?) AS evidence_json,(SELECT observed_at FROM film_retention WHERE film_id=?) AS observed_at,(SELECT revision FROM canonical_revision WHERE kind='film' AND id=?) AS revision",[content.id,content.id,content.id,content.id,content.id,content.id,content.id]);
 if(read?.redirected)throw failed('film_person_redirect');
 if(!read?.film)return {id:content.id,revision:0,absent:true,noop:false};
 const revision=Number(read.revision??0);
 const row=Number(read.has_row)>0?{watchlist:read.watchlist,evidence_json:read.evidence_json,observed_at:read.observed_at}:null;
 if(row&&!(content.observedAt>row.observed_at))return {id:content.id,revision,absent:false,noop:true,stale:true};
 const wm=watermark??await readRetentionWatermark(env);
 // An observation older than the newest admitted scan is stale for every Film: a complete scan observes every listed Film. This is what orders a late contradictory
 // observation against a later unchanged confirmation, which `film_retention.observed_at` (the start of the state) cannot.
 if(wm.present&&wm.observedAt&&new Date(content.observedAt).toISOString()<wm.observedAt)return {id:content.id,revision,absent:false,noop:true,stale:true,watermark:true};
 const same=!!(row&&Number(row.watchlist)===(content.watchlist?1:0));
 // AIR-532 (ADR 0173, owner decision of 18 Nov 2026): with the watermark present, a scan that repeats the stored boolean writes nothing (no receipt, no batch, no revision) and
 // `observed_at` stays the start of the state. Without the watermark table (schema below 25) nothing could order a late observation, so the previous rule stays: only an
 // identical row is a no-op and every newer scan rewrites `observed_at`.
 const noop=wm.present?same:!!(same&&row.evidence_json===JSON.stringify(content.evidence??{})&&row.observed_at===content.observedAt);
 return {id:content.id,revision,absent:false,noop,...(noop&&wm.present?{unchanged:true}:{})};
}

function kindOperation(operation,{replan,now=()=>new Date().toISOString()}={}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const digestOfInput=operation===FILM_ADMISSION_OPERATION?admissionDigest:retentionDigest;
 const planOf=operation===FILM_ADMISSION_OPERATION?planAdmission:planRetention;
 const write=(env,input,requestId,ctx,clock)=>operation===FILM_ADMISSION_OPERATION
  ?admitRatedFilm(env,{receiptKey:input.receiptKey,receipt:input.receipt,filmId:input.filmId,expectedRevision:ctx.currentRevision,at:input.at||clock(),requestId,receiptMark:mark(ctx,clock)})
  :(async()=>retainFilm(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at||clock(),requestId,watchlist:input.watchlist,observedAt:input.observedAt,evidence:input.evidence,watermark:(await readRetentionWatermark(env)).present,receiptMark:mark(ctx,clock)}))();
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch(error){if(READ_FAILURES.has(error?.code))throw error;input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await digestOfInput(input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 return defineOperation({
  operation,atomic:true,
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   if(!found)return {digest:null,revision:await revisionOf(database(env),target.id)};
   const snap=await planOf(env,found.input);
   return {digest:snap?.noop?receipt.contentDigest:null,revision:snap?snap.revision:await revisionOf(database(env),target.id)};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return write(env,found.input,receipt.requestId,ctx,now);
  },
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const snap=await planOf(env,found.input);
   if(!snap)return 'stale';
   return snap.absent||snap.noop?'superseded':'proceed';
  },
 });
}

export function ratedAdmissionOperations({replan=async()=>null,now}={}){
 return [
  kindOperation(FILM_ADMISSION_OPERATION,{replan,now}),
  kindOperation(FILM_RETENTION_OPERATION,{replan,now}),
 ];
}

// AIR-602 / ADR 0207 decision 1: the LEGACY admission unit (R2 receipt entry -> receipted `film_admission`) runs only while the admission marker proves `r2` or proves the migration absent. Under `closed` it
// refuses before its first effect (no plan, no receipt), at `d1` the new coordinator is the only admission path, and an unreadable marker is `letterboxd_admission_unavailable`. Retention units are not
// fenced by this marker and keep running.
async function requireLegacyAdmission(env){
 const authority=await readAdmissionAuthority(env);
 if(admissionRoute(authority)!=='legacy')throw admissionClosedError(authority.mode);
}

async function applyAdmission(env,{origin,event,input,replan,now,policy=RETRY_POLICY,routeOpen=false}={}){
 // AIR-532: a slice reads the marker ONCE (applyRatedAdmissionRetention) and passes `routeOpen`; a single call still reads it itself.
 const route=routeOpen===true||await producerRouteOpen(env);
 if(!route)return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 await requireLegacyAdmission(env);
 const plan=await planAdmission(env,input);
 if(plan.noop)return {state:'noop',receipt:false,requestId:null,id:plan.id};
 const digest=await admissionDigest(input);
 const target={kind:'film',id:plan.id};
 const requestId=await producerRequestId({origin,operation:FILM_ADMISSION_OPERATION,event,target,digest});
 const clock=clockOf(now);
 const spec=kindOperation(FILM_ADMISSION_OPERATION,{replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:FILM_ADMISSION_OPERATION,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,readback:spec.readback,revalidate:spec.revalidate,
  run:ctx=>admitRatedFilm(env,{receiptKey:input.receiptKey,receipt:input.receipt,filmId:plan.id,expectedRevision:ctx.currentRevision,at:input.at||clock(),requestId,receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId,id:plan.id};
}

async function applyRetention(env,{origin,event,input,replan,now,policy=RETRY_POLICY,routeOpen=false,watermark}={}){
 // AIR-532: a slice reads the marker ONCE (applyRatedAdmissionRetention) and passes `routeOpen`; a single call still reads it itself.
 const route=routeOpen===true||await producerRouteOpen(env);
 if(!route)return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 const wm=watermark??await readRetentionWatermark(env);
 const plan=await planRetention(env,input,{watermark:wm});
 if(plan.absent)return {state:'absent',receipt:false,requestId:null,id:plan.id};
 if(plan.noop)return {state:'noop',receipt:false,requestId:null,id:plan.id};
 const digest=await retentionDigest(input);
 const target={kind:'film',id:input.id};
 const requestId=await producerRequestId({origin,operation:FILM_RETENTION_OPERATION,event,target,digest});
 const clock=clockOf(now);
 const spec=kindOperation(FILM_RETENTION_OPERATION,{replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation:FILM_RETENTION_OPERATION,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,readback:spec.readback,revalidate:spec.revalidate,
  run:ctx=>retainFilm(env,{id:input.id,expectedRevision:ctx.currentRevision,at:input.at||clock(),requestId,watchlist:input.watchlist,observedAt:input.observedAt,evidence:input.evidence,watermark:wm.present,receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId,id:input.id};
}

export const applyFilmAdmission=(env,options)=>applyAdmission(env,options);
export const applyFilmRetention=(env,options)=>applyRetention(env,options);
export const ratedAdmissionWriterOpen=env=>producerRouteOpen(env);

export function mergeRatedAdmissionIntent(previous=[],next=[]){
 const map=new Map();
 for(const unit of previous||[])if(unit?.requestId)map.set(unit.requestId,unit);
 for(const unit of next||[])if(unit?.requestId)map.set(unit.requestId,unit);
 return [...map.values()];
}
export function ratedAdmissionSliceSettled(out){
 if(!out||out.state==='skipped')return true;
 return !(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.deferred||0));
}
export function ratedAdmissionSettled(out){
 if(!out||out.state==='skipped')return true;
 if(!ratedAdmissionSliceSettled(out))return false;
 return !(Number(out.refused||0));
}
export function assertRatedAdmissionAccepted(out){
 if(out?.state==='skipped')return out;
 if(ratedAdmissionSettled(out))return out;
 const error=failed('rated_admission_incomplete');
 error.detail=ratedAdmissionRecord(out);
 throw error;
}
export function departedWatchlistLids(view,listedIds){
 const set=new Set((listedIds||[]).map(id=>String(id)));
 const out=[];
 for(const [id,item] of Object.entries(view||{})){
  if(!item||item.watchlist!==true)continue;
  if(!LID.test(id)||id.startsWith('tmdb_'))continue;
  if(!set.has(id))out.push(id);
 }
 return out;
}
export function watchlistRetentionWork({listed=[],departed=[],observedAt,scanId}={}){
 const at=instant(observedAt);
 if(!at)return [];
 const evidence={scanId:scanId||null,source:'letterboxd_watchlist'};
 return [
  ...(listed||[]).map(item=>({lid:String(item.lid||item.id||''),tmdbId:item.tmdbId,watchlist:true,observedAt:at,evidence})),
  ...(departed||[]).map(lid=>({lid:String(lid),watchlist:false,observedAt:at,evidence:{...evidence,left:true}})),
 ];
}
export function ratedAdmissionRecord(out){
 if(!out)return null;
 const units=(out.units||[]).map(unit=>({kind:unit.kind,id:unit.id,state:unit.state,requestId:unit.requestId,receipted:!!unit.receipted,...(unit.errorClass?{errorClass:unit.errorClass}:{})}));
 return {state:out.state,applied:out.applied,noop:out.noop,skipped:out.skipped,failed:out.failed,absent:out.absent,unknown:out.unknown,preflightFailed:out.preflightFailed,refused:out.refused,units,reconciled:out.reconciled,refusedDetail:out.refusedDetail};
}
export function carryRatedAdmissionIntent(out){
 if(!out||ratedAdmissionSliceSettled(out))return [];
 return Array.isArray(out.intent)?out.intent:[];
}
export function ratedAdmissionRegistry(env,{intent=[],now}={}){
 const nowFn=clockOf(now);
 const byRequest=new Map((intent||[]).filter(unit=>unit?.requestId).map(unit=>[unit.requestId,unit]));
 const replan=async receipt=>byRequest.get(receipt.requestId)?.input??null;
 return operationRegistry(ratedAdmissionOperations({replan,now:nowFn}));
}

export async function planRatedAdmissionIntent(env,{event,admissions=[],retentions=[],now}={}){
 const nowFn=clockOf(now);
 const origin=RATED_ADMISSION_ORIGIN;
 const units=[],refused=[],absent=[];
 for(const item of admissions){
  const checked=verifiedAdmission(item?.receiptKey,item?.receipt);
  if(!checked.ok){refused.push({receiptKey:item?.receiptKey,errorClass:checked.reason||'admission_not_verified',preflight:true});continue;}
  let plan;
  try{plan=await planAdmission(env,{receiptKey:item.receiptKey,receipt:item.receipt});}
  catch(error){
   if(CLOSED.has(error?.code))throw error;
   refused.push({receiptKey:item.receiptKey,errorClass:error?.code||'unclassified',preflight:true});
   continue;
  }
  const input={receiptKey:item.receiptKey,receipt:item.receipt,filmId:plan.id,at:checked.admission.verifiedAt||nowFn()};
  const digest=await admissionDigest(input);
  const target={kind:'film',id:plan.id};
  const ev=String(event||'')+':admission:'+item.receiptKey;
  const requestId=await producerRequestId({origin,operation:FILM_ADMISSION_OPERATION,event:ev,target,digest});
  units.push({requestId,operation:FILM_ADMISSION_OPERATION,origin,event:ev,target,input});
 }
 for(const item of retentions){
  if(typeof item?.watchlist!=='boolean'||!instant(item?.observedAt)){refused.push({lid:item?.lid||item?.id,errorClass:'retention_invalid',preflight:true});continue;}
  let id=null;
  try{id=await resolveExistingRetentionFilm(env,item);}
  catch(error){
   if(CLOSED.has(error?.code))throw error;
   refused.push({lid:item?.lid||item?.id,errorClass:error?.code||'unclassified',preflight:true});
   continue;
  }
  if(!id){absent.push(item?.lid||item?.id||null);continue;}
  const input={id,watchlist:item.watchlist,observedAt:instant(item.observedAt),evidence:plain(item.evidence)?item.evidence:{scanId:item.scanId||null},at:nowFn()};
  const digest=await retentionDigest(input);
  const target={kind:'film',id};
  const ev=String(event||'')+':retention:'+id;
  const requestId=await producerRequestId({origin,operation:FILM_RETENTION_OPERATION,event:ev,target,digest});
  units.push({requestId,operation:FILM_RETENTION_OPERATION,origin,event:ev,target,input});
 }
 return {units,refused,absent};
}

export async function applyRatedAdmissionRetention(env,{event,admissions=[],retentions=[],intent:previousIntent=[],now,policy=RETRY_POLICY,limit=UNIT_CAP}={}){
 if(!(await producerRouteOpen(env)))return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 // A slice with admissions (new or carried) is refused as a whole BEFORE its plan under `closed` and `d1` (ADR 0207 decision 1); a retention-only slice is not fenced.
 if((admissions||[]).length||(previousIntent||[]).some(unit=>unit?.operation===FILM_ADMISSION_OPERATION))await requireLegacyAdmission(env);
 const nowFn=clockOf(now);
 const origin=RATED_ADMISSION_ORIGIN;
 const cap=Math.min(Math.max(Number(limit)||UNIT_CAP,1),UNIT_CAP);
 const retry=mergeRatedAdmissionIntent(previousIntent,[]).slice(0,cap);
 const room=Math.max(0,cap-retry.length);
 // AIR-532 (ADR 0173): the scan watermark is read ONCE per slice. The first slice of a scan moves it forward to the scan's observation time (one fenced write per scan, not per Film);
 // later slices find it already there and write nothing. A slice whose observations are older than the watermark (a late or replayed one) never moves it back, and its units end stale.
 let wm=await readRetentionWatermark(env);
 const scanTimes=(retentions||[]).map(item=>instant(item?.observedAt)).filter(Boolean).map(value=>new Date(value).toISOString());
 const scanAt=scanTimes.length?scanTimes.reduce((a,b)=>a>b?a:b):null;
 if(wm.present&&scanAt&&(!wm.observedAt||scanAt>wm.observedAt))wm=await advanceRetentionWatermark(env,{observedAt:scanAt,at:nowFn()});
 const planned=await planRatedAdmissionIntent(env,{event,admissions:(admissions||[]).slice(0,room),retentions:(retentions||[]).slice(0,room),now:nowFn});
 const intent=mergeRatedAdmissionIntent(retry,planned.units).slice(0,cap);
 const deferred=[];
 const counts={applied:0,noop:0,skipped:0,failed:0,absent:planned.absent.length,unknown:0,preflightFailed:planned.refused.filter(item=>item.preflight).length,refused:planned.refused.length};
 const outcomes=[];
 const applyOf={
  [FILM_ADMISSION_OPERATION]:(input,ev)=>applyAdmission(env,{origin,event:ev,input,replan:async()=>input,now:nowFn,policy,routeOpen:true}),
  [FILM_RETENTION_OPERATION]:(input,ev)=>applyRetention(env,{origin,event:ev,input,replan:async()=>input,now:nowFn,policy,routeOpen:true,watermark:wm}),
 };
 for(const unit of intent){
  try{
   const out=await applyOf[unit.operation](unit.input,unit.event);
   const receipted=out.receipt!==false&&out.requestId;
   outcomes.push({kind:unit.operation,id:unit.target.id,state:out.state,requestId:out.requestId||unit.requestId,receipted:!!receipted});
   if(out.state==='applied'||out.state==='already')counts.applied++;
   else if(out.state==='noop')counts.noop++;
   else if(out.state==='absent')counts.absent++;
   else if(out.state==='skipped')counts.skipped++;
   else if(out.state==='unknown')counts.unknown++;
   else counts.failed++;
  }catch(error){
   if(CLOSED.has(error?.code))throw error;
   counts.failed++;
   outcomes.push({kind:unit.operation,id:unit.target.id,state:'failed',errorClass:error?.code||'unclassified',requestId:unit.requestId,receipted:false,preflight:true});
   counts.preflightFailed++;
  }
 }
 const failedReq=new Set(outcomes.filter(item=>item.state==='failed'||item.state==='unknown').map(item=>item.requestId));
 const carry=mergeRatedAdmissionIntent(intent.filter(unit=>failedReq.has(unit.requestId)),deferred);
 const operations=ratedAdmissionRegistry(env,{intent:mergeRatedAdmissionIntent(intent,deferred),now:nowFn});
 let reconciled={considered:0};
 try{reconciled=await reconcileOwnOrigin(env,{origin,operations,now:nowFn,policy,limit:INLINE_RECONCILE_LIMIT});}catch(error){if(CLOSED.has(error?.code))throw error;counts.failed++;}
 const incomplete=counts.failed>0||counts.unknown>0||counts.preflightFailed>0||counts.refused>0||deferred.length>0;
 return {state:incomplete?'incomplete':'complete',...counts,units:outcomes,intent:incomplete?carry:[],reconciled,refusedDetail:planned.refused,deferred:deferred.length};
}
void INLINE_RECONCILE_LIMIT;
