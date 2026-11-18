// AIR-477 (ADR 0165, Accepted). The owner-only scoped prediction recovery intent behind the existing Cloudflare Access application.
//  GET  /api/admin/prediction-recovery-intent/preview?films=<ids>&mode=<mode>&ttlHours=<h>  read-only preview of a frozen allowlist
//  GET  /api/admin/prediction-recovery-intent/cohort?id=<cohortId>                          read-only status of a confirmed cohort
//  POST /api/admin/prediction-recovery-intent/confirm  {films, mode, ttlHours, scopeHash, idempotencyKey}
//  POST /api/admin/prediction-recovery-intent/cancel   {cohortId}
// The GET routes read R2 through a bucket that has nothing but `get` and D1 through SELECTs only; they write nothing, not even a
// diagnostic. Confirm re-runs the same preview on the server, requires the exact previewed scope hash, and then writes ONE fenced D1
// batch of intent rows (src/prediction-recovery-intent.js). It does not touch the queue, a retry record, a lease, a pointer, the
// history or an R2 body, and it starts no run: the ordinary queue rebuild and the ordinary batch v2 runner do the work. Without
// migration 0024 the capability is dormant: preview says `schema.ready: false` and confirm refuses `recovery_schema_not_ready`.
const PRIC_ACTION='prediction_recovery_intent';
const PRIC_BODY_LIMIT=16384;

function pricRefuse(refusal,status,extra={}){return json({error:refusal,refusal,...extra},status);}
function pricOwner(request,url){
 const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
 return typeof assertion==='string'&&assertion.length>0&&assertion.length<=8192&&request.headers.get('Origin')===url.origin&&request.headers.get('X-IPTV-Admin-Action')===PRIC_ACTION;
}
async function pricBody(request){
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>PRIC_BODY_LIMIT))return {error:'body_too_large'};
 let text;try{text=await request.text();}catch{return {error:'invalid_json'};}
 if(text.length>PRIC_BODY_LIMIT)return {error:'body_too_large'};
 try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?{value}:{error:'invalid_json'};}catch{return {error:'invalid_json'};}
}
async function pricIdentity(env,filmId){
 if(typeof CanonicalCatalogReader==='undefined'||typeof CanonicalCatalogReader.catalogFilmIdentityBridge!=='function')return {error:'identity_unavailable'};
 try{return await CanonicalCatalogReader.catalogFilmIdentityBridge(env,filmId);}
 catch(error){return {error:typeof error?.code==='string'?error.code:'identity_unavailable'};}
}
function pricLane(queue,id){
 if(!queue)return 'unknown';
 if(Array.isArray(queue.hotPending)&&queue.hotPending.includes(id))return 'hot';
 if(Array.isArray(queue.coldPending)&&queue.coldPending.includes(id))return 'cold';
 return 'none';
}

// The preview of one request. Every read; no write. `request` = parsed {films, mode, ttlHours}.
async function predictionRecoveryIntentPreview(env,request){
 const nowMs=Date.now();
 const {env:readEnv}=recoveryReadOnlyEnv(env);
 const snapshot=await loadPredictionDiagnosticSnapshot(readEnv,null);
 const [authority,rows,lease,states,identities]=await Promise.all([
  typeof PredictionD1==='undefined'?Promise.resolve({mode:'r2',writes:null,generation:null,queueGeneration:null}):PredictionD1.readPredictionAuthority(env.DB,env),
  PredictionRecoveryIntent.readFilmRows(env,request.films),
  recoveryRead(readEnv,RUNNER_LEASE_KEY),
  Promise.all(request.films.map(id=>readFilmStateCurrent(readEnv,id).then(state=>({status:'recorded',prediction:state?.predictions?.current??null,fingerprint:state?.fingerprint??null}),()=>({status:'unavailable'})))),
  Promise.all(request.films.map(id=>pricIdentity(env,id))),
 ]);
 let filmPerson;try{const gate=await FilmPersonAuthority.readAuthority(env);filmPerson={state:gate.state,generation:gate.generation};}catch(error){filmPerson={state:'unavailable',code:error?.code??null};}
 const queue=snapshot.queueStatus==='recorded'?snapshot.queue:null;
 const films=request.films.map((filmId,i)=>{
  const film=snapshot.filmsById.get(filmId)||null,state=states[i],row=rows.films.get(filmId);
  // The ordinary rule (no film id: an intent never colours its own preview).
  const current=state.status==='recorded'&&!!snapshot.profile&&!!state.prediction&&!!snapshot.freshness.state(state.prediction,state.fingerprint,film?.genres);
  const outcome=PredictionRecoveryIntent.classifyRecoveryFilm({filmId,profile:!!snapshot.profile,admitted:!!film,identity:identities[i],state,current,d1:row,retryExhausted:retryBudgetExhausted(queue?.retries?.[filmId]),activeIntent:row?.activeIntent??null},request.mode,nowMs);
  const retry=queue?.retries?.[filmId];
  return {...outcome,lane:pricLane(queue,filmId),retry:retry?{attempts:retry.attempts??null,retryAt:Number.isFinite(retry.retryAt)?new Date(retry.retryAt).toISOString():null,exhausted:retryBudgetExhausted(retry)}:null,activeIntent:row?.activeIntent?{cohortId:row.activeIntent.cohortId,expiresAt:row.activeIntent.expiresAt}:null};
 });
 const counts=Object.fromEntries(PredictionRecoveryIntent.RECOVERY_OUTCOMES.map(name=>[name,films.filter(f=>f.outcome===name).length]));
 const eligible=films.filter(f=>f.outcome==='eligible');
 const leaseLive=lease.status==='recorded'&&Number(lease.value?.expiresAt)>nowMs;
 const scopeHash=await PredictionRecoveryIntent.recoveryScopeHash({mode:request.mode,ttlHours:request.ttlHours,revision:rows.revision,authority,filmPerson,films});
 const refusal=!rows.installed?'recovery_schema_not_ready':authority.mode!=='d1'?'prediction_domain_not_d1':authority.writes!=='open'?'prediction_writes_held':!eligible.length?'recovery_scope_empty':null;
 return {
  version:PredictionRecoveryIntent.RECOVERY_VERSION,evaluatedAt:new Date(nowMs).toISOString(),atomic:false,
  mode:request.mode,ttlHours:request.ttlHours,
  schema:{ready:rows.installed,revision:rows.revision},
  authority:{prediction:{mode:authority.mode,writes:authority.writes??null,generation:authority.generation??null,queueGeneration:authority.queueGeneration??null},filmPerson},
  runner:{lease:lease.status,live:leaseLive,runId:leaseLive?lease.value?.runId??null:null,expiresAt:leaseLive?new Date(Number(lease.value.expiresAt)).toISOString():null},
  queue:{status:snapshot.queueStatus,refreshedAt:queue?.refreshedAt??null,recoveryRevision:queue?.recoveryRevision??null,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null},
  films,counts,
  budget:{films:eligible.length,limit:PredictionRecoveryIntent.RECOVERY_LIMITS.maxFilms,activeLimit:PredictionRecoveryIntent.RECOVERY_LIMITS.maxActive,predictionOnly:eligible.filter(f=>f.plan==='prediction_only').length,fingerprintAndPrediction:eligible.filter(f=>f.plan==='fingerprint_and_prediction').length,modelCallsEstimate:eligible.length,manifestsEstimate:Math.ceil(eligible.length/BATCH_RUNNER.maxManifestFilms),externalCalls:0},
  expectedEffect:eligible.length?'eligible films enter the queue at its next ordinary rebuild and are scored by the ordinary batch v2 runner':'none',
  scopeHash,confirmable:refusal===null,refusal,
 };
}

async function predictionRecoveryIntentConfirm(env,body){
 const request=PredictionRecoveryIntent.parseRecoveryRequest(body);
 if(request.error)return pricRefuse(request.error,400,request.limit?{limit:request.limit}:{});
 if(!PredictionRecoveryIntent.validIdempotencyKey(body.idempotencyKey))return pricRefuse('invalid_idempotency_key',400);
 if(!PredictionRecoveryIntent.validScopeHash(body.scopeHash))return pricRefuse('invalid_scope_hash',400);
 // A key seen before is a replay of that confirmation only when both the scope hash and the normalized request (films, mode, TTL) are the
 // stored ones; anything else under that key is a conflict. Checked before any new preview: the first confirmation itself moved the
 // revision, so a fresh preview of a replay would never match.
 const requestDigest=await PredictionRecoveryIntent.recoveryRequestDigest(request);
 const replay=async()=>{
  const known=await PredictionRecoveryIntent.readCohort(env,{idempotencyKey:body.idempotencyKey});
  if(!known.installed)return pricRefuse('recovery_schema_not_ready',409);
  if(!known.cohort)return null;
  if(known.cohort.scopeHash!==body.scopeHash||known.cohort.requestDigest!==requestDigest)return pricRefuse('idempotency_conflict',409,{cohortId:known.cohort.cohortId});
  return json({status:'replayed',receipt:known.cohort});
 };
 const seen=await replay();if(seen)return seen;
 const preview=await predictionRecoveryIntentPreview(env,request);
 if(preview.scopeHash!==body.scopeHash)return pricRefuse('stale_scope',409,{scopeHash:preview.scopeHash});
 if(!preview.confirmable)return pricRefuse(preview.refusal,409);
 const eligible=preview.films.filter(f=>f.outcome==='eligible');
 const cohortId=await PredictionRecoveryIntent.cohortIdFor(body.idempotencyKey);
 let written;
 try{written=await PredictionRecoveryIntent.confirmCohort(env,{cohortId,idempotencyKey:body.idempotencyKey,scopeHash:body.scopeHash,requestDigest,mode:request.mode,ttlHours:request.ttlHours,revision:preview.schema.revision,filmPersonGeneration:preview.authority.filmPerson.generation,films:eligible});}
 catch(error){
  // A concurrent confirmation of the same key landed first: answer as its replay. Any other refusal wrote nothing.
  if(error?.code==='recovery_cas'){const again=await replay().catch(()=>null);if(again)return again;}
  const code=typeof error?.code==='string'&&error.code.startsWith('recovery_')?error.code:'recovery_unavailable';
  return pricRefuse(code,code==='recovery_unavailable'?503:409);
 }
 return json({status:'confirmed',receipt:{cohortId:written.cohortId,idempotencyKey:body.idempotencyKey,scopeHash:body.scopeHash,mode:request.mode,createdAt:written.createdAt,expiresAt:written.expiresAt,revision:written.revision,
  films:eligible.map(f=>({filmId:f.filmId,canonicalFilmId:f.canonicalFilmId,plan:f.plan})),skipped:preview.films.filter(f=>f.outcome!=='eligible').map(f=>({filmId:f.filmId,outcome:f.outcome,reason:f.reason}))},
  effect:'queued_on_next_rebuild'},201);
}

async function adminPredictionRecoveryIntentRoute(request,env,url){
 const action=url.pathname.slice('/api/admin/prediction-recovery-intent/'.length);
 if(typeof PredictionRecoveryIntent==='undefined')return adminError('not_available',404);
 try{
  if(action==='preview'){
   if(request.method!=='GET')return adminError('method_not_allowed',405);
   const params=url.searchParams;
   const parsed=PredictionRecoveryIntent.parseRecoveryRequest({films:params.get('films')??'',mode:params.get('mode')??undefined,ttlHours:params.get('ttlHours')??undefined});
   if(parsed.error)return pricRefuse(parsed.error,400,parsed.limit?{limit:parsed.limit}:{});
   return json(await predictionRecoveryIntentPreview(env,parsed));
  }
  if(action==='cohort'){
   if(request.method!=='GET')return adminError('method_not_allowed',405);
   const id=url.searchParams.get('id');
   if(!PredictionRecoveryIntent.validCohortId(id))return adminError('invalid_cohort',400);
   const read=await PredictionRecoveryIntent.readCohort(env,{cohortId:id});
   if(!read.installed)return json({schema:{ready:false},cohort:null});
   if(!read.cohort)return adminError('unknown_cohort',404);
   return json({schema:{ready:true},cohort:read.cohort});
  }
  if(action==='confirm'||action==='cancel'){
   if(request.method!=='POST')return adminError('method_not_allowed',405);
   if(!pricOwner(request,url))return pricRefuse('owner_required',403);
   const parsed=await pricBody(request);
   if(parsed.error)return pricRefuse(parsed.error,parsed.error==='body_too_large'?413:400);
   if(action==='confirm')return await predictionRecoveryIntentConfirm(env,parsed.value);
   if(!PredictionRecoveryIntent.validCohortId(parsed.value.cohortId))return pricRefuse('invalid_cohort',400);
   try{return json(await PredictionRecoveryIntent.cancelCohort(env,parsed.value.cohortId));}
   catch(error){const code=typeof error?.code==='string'&&error.code.startsWith('recovery_')?error.code:'recovery_unavailable';return pricRefuse(code,code==='recovery_cohort_unknown'?404:code==='recovery_unavailable'?503:409);}
  }
  return adminError('not_found',404);
 }catch(error){
  return adminError(typeof error?.code==='string'&&error.code.startsWith('recovery_')?error.code:'storage_unavailable',503);
 }
}
