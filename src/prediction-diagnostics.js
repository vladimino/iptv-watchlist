// Read-only prediction queue diagnostics. AIR-98.
// Callers pass objects already loaded from storage. Nothing here writes, lists a
// bucket, or starts a run. Eligibility matches queueReadyIds, including its
// comparison of a numeric retryAt with the supplied clock.
const PREDICTION_DIAGNOSTIC_PAGE_MAX=20;

async function loadPredictionDiagnosticSnapshot(env,filmId){
 let pinned=env;
 try{pinned=await pinEpg(env);}catch{pinned=env;}
 const read=async key=>{
  try{const value=await loadJSON(pinned,key);return {status:value==null?'not_recorded':'recorded',value};}
  catch{return {status:'unavailable',value:null};}
 };
 const [queue,profile,index,programme,catalog,publishedGeneration]=await Promise.all([
  read(predictionQueueKey),read(profileKey),read(ENRICHMENT_KEY+'view-index.json'),read('programme.json'),read('epg/discovered-films.json'),read(EPG_GENERATION_KEY),
 ]);
 const films={};
 if(filmId){
  try{const state=await readFilmState(env,filmId);films[filmId]={status:'recorded',fingerprint:state?.fingerprint??null,predictions:state?.predictions??null};}
  catch{films[filmId]={status:'unavailable',fingerprint:null,predictions:null};}
 }
 // The same freshness rule (mode and profile snapshot) as the queue and the readers; strict unless switched.
 const freshness=await predictionFreshness(env,profile.value),catalogFilms=allEnrichmentFilms(programme.value?.films?programme.value:{films:[]},catalog.value);
 return {
  freshness,filmsById:new Map(catalogFilms.map(film=>[String(film.id),film])),registryDigest:freshness.registryDigest??null,target:freshness.target??null,
  queue:queue.value,queueStatus:queue.status,profile:profile.value,profileStatus:profile.status,index:index.value,indexStatus:index.status,
  programme:programme.value,programmeStatus:programme.status,catalog:catalog.value,catalogStatus:catalog.status,
  publishedGeneration:publishedGeneration.value,publishedGenerationStatus:publishedGeneration.status,films,
  completedOnly:pinned?.epgPin?.authority==='d1',
 };
}
function predictionDiagnosticOutstanding(queue){
 if(!Array.isArray(queue?.hotPending)||!Array.isArray(queue?.coldPending))return null;
 const seen=new Set(),ids=[];
 for(const id of [...queue.hotPending,...queue.coldPending]){if(seen.has(id))continue;seen.add(id);ids.push(id);}
 return ids;
}
function predictionDiagnosticRetryExhausted(record){
 return Number.isInteger(record?.attempts)&&record.attempts>=10;
}
function predictionDiagnosticLaneIds(queue){
 const hot=(queue.hotPending||[]).filter(id=>!predictionDiagnosticRetryExhausted(queue.retries?.[id]));
 if(hot.length)return hot;
 return (queue.coldPending||queue.pending||[]).filter(id=>!predictionDiagnosticRetryExhausted(queue.retries?.[id]));
}
function predictionDiagnosticReadyIds(queue,now){
 if(!queue)return [];
 return predictionDiagnosticLaneIds(queue).filter(id=>!(queue.retries?.[id]?.retryAt>now));
}
function predictionDiagnosticExhaustedIds(queue){
 return Object.entries(queue?.retries||{}).filter(([,record])=>predictionDiagnosticRetryExhausted(record)).map(([id])=>id);
}
function predictionDiagnosticRetryAt(value){
 const ms=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
 return Number.isFinite(ms)?new Date(ms).toISOString():null;
}
function predictionDiagnosticClassification(kind){
 if(kind==null||kind==='')return 'not_recorded';
 if(typeof kind!=='string')return 'unknown';
 if(kind==='parse_error'||kind==='validation_error'||kind==='storage_error')return kind;
 const safe=safePredictionReason(kind);
 return safe||'not_recorded';
}
// AIR-152: the stored validation summary is re-checked against the closed vocabulary before it is
// returned; a path or code outside it is dropped, so a tampered retry record cannot leak text.
const PREDICTION_VALIDATION_STAGES=['caller_reported','fingerprint_schema','fingerprint_missing','prediction_schema'];
function predictionDiagnosticValidation(validation){
 if(!validation||typeof validation!=='object')return null;
 const issues=Array.isArray(validation.issues)?validation.issues.filter(issue=>issue&&typeof issue==='object'&&typeof issue.path==='string'&&/^(fingerprint|prediction)(\.[A-Za-z0-9_]{1,40}){0,3}$/.test(issue.path)&&ISSUE_CODES.includes(issue.code)).slice(0,MAX_ISSUES).map(issue=>({path:issue.path,code:issue.code})):[];
 const out={stage:PREDICTION_VALIDATION_STAGES.includes(validation.stage)?validation.stage:'unknown',reportedBy:validation.reportedBy==='caller'||validation.reportedBy==='worker'?validation.reportedBy:null,issues};
 const claim=predictionDiagnosticClaim(validation.claimed);
 if(claim&&out.stage==='caller_reported'&&out.reportedBy==='caller')out.claimed=claim;
 return out;
}
// AIR-472: a caller-supplied failure reason and echoed preflight issues, re-checked against the closed vocabulary. It is a client claim, never Worker telemetry, and says nothing about whether a preflight ran.
const CALLER_CLAIM_REASONS=['preflight_validation_failed','insufficient_evidence','json_unparseable','request_too_large'];
function predictionDiagnosticClaim(claimed){
 if(!claimed||typeof claimed!=='object')return null;
 const reason=CALLER_CLAIM_REASONS.includes(claimed.reason)?claimed.reason:null;
 const issues=Array.isArray(claimed.preflightIssues)?claimed.preflightIssues.filter(issue=>issue&&typeof issue==='object'&&callerFailurePathAllowed(issue.path)&&ISSUE_CODES.includes(issue.code)).slice(0,MAX_ISSUES).map(issue=>({path:issue.path,code:issue.code})):null;
 if(!reason&&!issues)return null;
 return {provenance:'caller_claim',reason,preflightIssues:issues};
}
function predictionDiagnosticRetry(queue,filmId){
 const retry=queue?.retries?.[filmId];
 if(!retry||typeof retry!=='object')return {classification:'not_recorded',scope:null,attempts:null,failedAt:null,retryAt:null,lastRunId:null,validation:null};
 const failedAt=predictionDiagnosticRetryAt(retry.failedAt);
 return {
  classification:predictionDiagnosticClassification(retry.kind),
  scope:retry.scope==='item'||retry.scope==='run'?retry.scope:'unknown',
  attempts:Number.isInteger(retry.attempts)&&retry.attempts>=0?retry.attempts:null,
  failedAt,retryAt:predictionDiagnosticRetryAt(retry.retryAt),
  lastRunId:typeof retry.lastRunId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(retry.lastRunId)?retry.lastRunId:null,
  validation:predictionDiagnosticValidation(retry.validation),
 };
}
function predictionDiagnosticLane(queue,filmId){
 if(!queue)return 'unknown';
 if(!Array.isArray(queue.hotPending)||!Array.isArray(queue.coldPending))return 'unknown';
 if(queue.hotPending.includes(filmId))return 'hot';
 if(queue.coldPending.includes(filmId))return 'cold';
 if(Array.isArray(queue.pending)&&queue.pending.includes(filmId))return 'pending';
 return 'none';
}
function predictionDiagnosticEligibility(queue,filmId,now){
 if(predictionDiagnosticRetryExhausted(queue?.retries?.[filmId]))return {eligibleNow:false,cause:'prediction_retry_exhausted'};
 const lane=predictionDiagnosticLane(queue,filmId);
 if(lane==='unknown')return {eligibleNow:null,cause:'unknown'};
 if(lane==='none')return {eligibleNow:false,cause:'not_in_queue'};
 const deferred=!!(queue.retries?.[filmId]&&queue.retries[filmId].retryAt>now);
 if(deferred)return {eligibleNow:false,cause:'retry_backoff'};
 if(predictionDiagnosticReadyIds(queue,now).includes(filmId))return {eligibleNow:true,cause:'ready'};
 if(lane==='cold'&&queue.priorityCount)return {eligibleNow:false,cause:'waiting_behind_hot'};
 return {eligibleNow:false,cause:'not_ready'};
}
// A bounded reading of optional fingerprint evidence. Sources named here were declared by the writer. A declaration
// is not an independent check. A fingerprint without the key stays legacy, and a missing fingerprint stays unknown.
// Neither case invents claims.
function predictionDiagnosticEvidence(fingerprint){
 const note='declared_source_not_verified';
 if(!fingerprint||typeof fingerprint!=='object'||Array.isArray(fingerprint))return {status:'unknown',note};
 if(!Object.hasOwn(fingerprint,'evidence'))return {status:'legacy',note};
 const evidence=fingerprint.evidence;
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))return {status:'unknown',note};
 const claims=[],token=/^[a-z0-9_]{1,40}$/;
 const take=(group,dimension,value,raw)=>{
  if(!token.test(dimension)||!Array.isArray(raw)||claims.length>=32)return;
  const items=[];
  for(const item of raw){
   if(items.length>=EVIDENCE_MAX_ITEMS||!item||typeof item!=='object'||Array.isArray(item))continue;
   if(!EVIDENCE_BASIS.includes(item.basis)||!CONFIDENCE.includes(item.confidence)||!Array.isArray(item.refs))continue;
   const refs=[];
   for(const ref of item.refs){if(refs.length>=EVIDENCE_MAX_REFS||typeof ref!=='string')continue;if(ref==='model_knowledge'||METADATA_REFS.includes(ref)||evidenceUrlOk(ref))refs.push(ref);}
   if(refs.length)items.push({basis:item.basis,refs,confidence:item.confidence});
  }
  if(items.length)claims.push({group,dimension,value:typeof value==='string'&&token.test(value)?value:null,items});
 };
 const mechanics=[];
 if(Array.isArray(fingerprint.plotMechanics))for(const key of fingerprint.plotMechanics)if(typeof key==='string'&&!mechanics.includes(key))mechanics.push(key);
 const plot=evidence.plotMechanics;
 if(plot&&typeof plot==='object'&&!Array.isArray(plot))for(const key of mechanics)if(plot[key])take('mechanic',key,key,plot[key]);
 const block=evidence.execution,execution=fingerprint.execution&&typeof fingerprint.execution==='object'&&!Array.isArray(fingerprint.execution)?fingerprint.execution:{};
 if(block&&typeof block==='object'&&!Array.isArray(block))for(const key of [...GENERAL_EXECUTION,...GENRE_EXECUTION])if(block[key])take('execution',key,execution[key],block[key]);
 return {status:'recorded',note,claims};
}
// `current` is the exact schema match of today; `usable` is the verdict in force (exact, or exact or compatible under the
// transition rule) with its reason and migration class; the provenance fields come from the stored pointer.
function predictionDiagnosticFingerprint(record,freshness=null,film=null){
 const mode=freshness?.fingerprintMode??'strict';
 const unknownEvidence={status:'unknown',note:'declared_source_not_verified'};
 if(!record||record.status==='unavailable')return {presence:'unknown',schemaVersion:null,promptVersion:null,current:null,usable:null,invalidated:null,reason:null,migration:null,mode,evidence:unknownEvidence};
 if(!record.fingerprint)return {presence:'not_recorded',schemaVersion:null,promptVersion:null,current:false,usable:false,invalidated:false,reason:'fingerprint_missing',migration:'full',mode,evidence:unknownEvidence};
 const fingerprint=record.fingerprint,verdict=freshness?.fingerprintVerdict?freshness.fingerprintVerdict(fingerprint,film?.genres):null;
 return {presence:'recorded',schemaVersion:fingerprint.fingerprintSchemaVersion??null,promptVersion:fingerprint.fingerprintPromptVersion??1,produced:fingerprint.produced??'generated',previous:fingerprint.previous??null,current:fingerprintCurrent(fingerprint),usable:verdict?fingerprintCompatibilityFresh(verdict):fingerprintCurrent(fingerprint),invalidated:!!fingerprint.invalidatedAt,reason:verdict?.reason??null,migration:verdict?.migration??null,mode,evidence:predictionDiagnosticEvidence(fingerprint)};
}
function predictionDiagnosticPrediction(record,profile,freshness=strictFreshness(profile),film=null){
 if(!record||record.status==='unavailable')return {presence:'unknown',current:null,stale:'unknown',profileMatch:null,cause:'unknown'};
 const prediction=record.predictions?.current;
 if(!record.predictions||!prediction)return {presence:record.predictions?'recorded_without_current':'not_recorded',current:false,stale:'unknown',profileMatch:null,cause:'not_recorded'};
 if(!profile)return {presence:'recorded',current:false,stale:'unknown',profileMatch:null,cause:'profile_not_recorded'};
 const filmId=film?.id==null?undefined:String(film.id),current=!!freshness.state(prediction,record.fingerprint,film?.genres,filmId),genres=film?.genres;
 const profileMatch=prediction.tasteProfileVersion===profile.version&&prediction.tasteProfileHash===profile.profileHash;
 const usable=typeof freshness.fingerprintUsable==='function'?!!freshness.fingerprintUsable(record.fingerprint,genres,filmId):fingerprintCurrent(record.fingerprint);
 const verdict=typeof freshness.work==='function'?freshness.work(prediction,record.fingerprint,genres):null;
 // A prediction kept under another profile version or fingerprint version by a selective rule is 'compatible'; its record
 // keeps its own provenance. `reason` and `requiredWork` are the shared verdict's, the same the queue records.
 const cause=current?(profileMatch&&(!verdict||verdict.outcome==='current')?'current':'compatible'):!usable?'fingerprint_not_current':!profileMatch?'profile_changed':'stale';
 return {presence:'recorded',current,stale:!current,profileMatch,cause,reason:verdict?.reason??null,requiredWork:verdict?.requiredWork??null,mode:freshness.mode,fingerprintMode:freshness.fingerprintMode??'strict'};
}
function predictionDiagnosticIndex(snapshot,filmId,record){
 if(snapshot.indexStatus==='unavailable'||snapshot.profileStatus==='unavailable'||!record||record.status==='unavailable')return 'unknown';
 if(snapshot.indexStatus!=='recorded'||!snapshot.profile)return 'unknown';
 const item=snapshot.index?.[filmId];
 if(!item)return 'not_recorded';
 const freshness=snapshot.freshness||strictFreshness(snapshot.profile),film=snapshot.filmsById?.get(filmId)||null;
 const indexCurrent=!!freshness.indexed(item,film);
 const fileCurrent=!!freshness.state(record.predictions?.current,record.fingerprint,film?.genres,film?.id==null?undefined:String(film.id));
 return indexCurrent===fileCurrent?'agreed':'inconsistent';
}
function predictionDiagnosticSources(snapshot){
 const queue=snapshot.queue,programme=snapshot.programme,profile=snapshot.profile,published=snapshot.publishedGeneration;
 return {
  queue:{status:snapshot.queueStatus,refreshedAt:queue?.refreshedAt||null,programmeRunId:queue?.programmeRunId||null},
  programme:{status:snapshot.programmeStatus,programmeRunId:programme?.runId||null},
  publishedGeneration:{status:snapshot.publishedGenerationStatus,programmeRunId:published?.programmeRunId||null,phase:published?.phase||null},
  profile:{status:snapshot.profileStatus,version:profile?.version??null,updatedAt:profile?.updatedAt||null},
  viewIndex:{status:snapshot.indexStatus},
  catalog:{status:snapshot.catalogStatus},
 };
}
function predictionDiagnosticReasons(snapshot,outstanding){
 const reasons=[];
 const missing={queue:snapshot.queueStatus,programme:snapshot.programmeStatus,profile:snapshot.profileStatus,view_index:snapshot.indexStatus,catalog:snapshot.catalogStatus,published_generation:snapshot.publishedGenerationStatus};
 for(const [name,status] of Object.entries(missing)){if(status!=='recorded')reasons.push(name+'_'+status);}
 const queue=snapshot.queue,programme=snapshot.programme,profile=snapshot.profile,published=snapshot.publishedGeneration;
 if(queue&&!Array.isArray(queue.hotPending)||queue&&!Array.isArray(queue.coldPending))reasons.push('queue_shape_unknown');
 if(queue?.programmeRunId&&programme?.runId&&queue.programmeRunId!==programme.runId)reasons.push('queue_programme_differs');
 if(published?.programmeRunId&&programme?.runId&&published.programmeRunId!==programme.runId)reasons.push('published_generation_differs');
 if(published?.phase&&published.phase!=='published')reasons.push('generation_not_published');
 if(queue?.profileVersion!=null&&profile?.version!=null&&queue.profileVersion!==profile.version)reasons.push('profile_version_differs');
 if(queue?.profileHash&&profile?.profileHash&&queue.profileHash!==profile.profileHash)reasons.push('profile_hash_differs');
 // A queue built under other fingerprint schema, prompt versions or transition registry than the Worker's (a deploy since
 // its refresh) is a disagreement like a profile change.
 const target=snapshot.target;
 if(target&&queue?.fingerprintSchemaVersion!=null&&queue.fingerprintSchemaVersion!==target.fingerprintSchemaVersion)reasons.push('fingerprint_schema_differs');
 if(target&&queue?.fingerprintPromptVersion!=null&&queue.fingerprintPromptVersion!==target.fingerprintPromptVersion)reasons.push('fingerprint_prompt_differs');
 if(target&&queue?.predictionPromptVersion!=null&&queue.predictionPromptVersion!==target.predictionPromptVersion)reasons.push('prediction_prompt_differs');
 if(snapshot.registryDigest&&queue?.fingerprintCompatibility?.registryDigest&&queue.fingerprintCompatibility.registryDigest!==snapshot.registryDigest)reasons.push('fingerprint_registry_differs');
 if(Array.isArray(outstanding)&&snapshot.indexStatus==='recorded'&&snapshot.profileStatus==='recorded'&&profile&&outstanding.some(id=>(snapshot.freshness||strictFreshness(profile)).indexed(snapshot.index?.[id],snapshot.filmsById?.get(id)||null)))reasons.push('index_ahead_of_queue');
 return reasons;
}
function predictionDiagnosticCoverage(snapshot,now){
 if(snapshot.programmeStatus!=='recorded'||snapshot.profileStatus!=='recorded'||snapshot.indexStatus==='unavailable'||!snapshot.profile)return {status:'unknown',current:null,total:null,percent:null,windowCurrent:null,windowTotal:null,windowPercent:null};
 const summary=canonicalCoverageSummary(snapshot.programme,snapshot.catalogStatus==='recorded'?snapshot.catalog:null,snapshot.index||{},snapshot.profile,now,snapshot.freshness||strictFreshness(snapshot.profile),snapshot.completedOnly===true);
 const complete=snapshot.catalogStatus==='recorded'&&snapshot.indexStatus==='recorded';
 return {
  status:complete?'recorded':'partial',current:summary.currentPredictionsTotal,total:summary.confirmedFilmsTotal,
  percent:summary.confirmedFilmsTotal?coveragePercent(summary.currentPredictionsTotal,summary.confirmedFilmsTotal):null,
  windowCurrent:summary.windowCurrentPredictions,windowTotal:summary.windowFilmsTotal,
  windowPercent:summary.windowFilmsTotal?coveragePercent(summary.windowCurrentPredictions,summary.windowFilmsTotal):null,
 };
}
// The fingerprint rule in force and what the stored queue recorded for it (classes and migration counts; the per-film map stays in the queue object).
function predictionDiagnosticFingerprintSummary(snapshot){
 const freshness=snapshot.freshness||strictFreshness(snapshot.profile),block=snapshot.queue?.fingerprintCompatibility||null;
 return {mode:freshness.fingerprintMode??'strict',target:snapshot.target??null,registryDigest:snapshot.registryDigest??null,
  queue:block?{mode:block.mode??null,registryDigest:block.registryDigest??null,target:block.target??null,unindexed:block.unindexed??null,classes:block.classes??null,migration:block.migration??null,wouldKeep:block.wouldKeep??null,wouldRequeue:block.wouldRequeue??null,strictDisagreements:block.strictDisagreements??null}:null};
}
function predictionDiagnosticSnapshotId(queue){
 return {refreshedAt:queue?.refreshedAt||null,programmeRunId:queue?.programmeRunId||null};
}
function predictionQueueOverview(snapshot,now){
 const outstanding=predictionDiagnosticOutstanding(snapshot.queue);
 const reasons=predictionDiagnosticReasons(snapshot,outstanding);
 const ready=snapshot.queue?predictionDiagnosticReadyIds(snapshot.queue,now):[];
 const exhausted=snapshot.queue?predictionDiagnosticExhaustedIds(snapshot.queue):[];
 const active=Array.isArray(outstanding)?outstanding.filter(id=>!predictionDiagnosticRetryExhausted(snapshot.queue.retries?.[id])):[];
 const deferred=active.filter(id=>snapshot.queue.retries?.[id]?.retryAt>now);
 const nextMs=deferred.map(id=>snapshot.queue.retries[id].retryAt).filter(value=>typeof value==='number').sort((a,b)=>a-b)[0];
 let state='unavailable',cause='queue_not_recorded';
 if(snapshot.queueStatus==='unavailable')cause='queue_unavailable';
 else if(snapshot.queueStatus==='recorded'&&!Array.isArray(outstanding))cause='queue_shape_unknown';
 else if(snapshot.queueStatus==='recorded'&&active.length===0&&exhausted.length===0){state='drained';cause='drained';}
 else if(snapshot.queueStatus==='recorded'&&active.length===0){state='temporarily_ineligible';cause='prediction_retry_exhausted';}
 else if(snapshot.queueStatus==='recorded'&&ready.length===0){state='temporarily_ineligible';cause=deferred.length?'retry_backoff':'waiting_behind_hot';}
 else if(snapshot.queueStatus==='recorded'){state='eligible';cause='ready';}
 return {
  atomic:false,state,cause,
  snapshot:{...predictionDiagnosticSnapshotId(snapshot.queue),profileVersion:snapshot.profile?.version??snapshot.queue?.profileVersion??null,consistent:reasons.length===0,partial:reasons.length>0,reasons,sources:predictionDiagnosticSources(snapshot),fingerprint:predictionDiagnosticFingerprintSummary(snapshot)},
  pending:{total:Array.isArray(outstanding)?active.length:null,hot:Array.isArray(snapshot.queue?.hotPending)?snapshot.queue.hotPending.filter(id=>!predictionDiagnosticRetryExhausted(snapshot.queue.retries?.[id])).length:null,cold:Array.isArray(snapshot.queue?.coldPending)?snapshot.queue.coldPending.filter(id=>!predictionDiagnosticRetryExhausted(snapshot.queue.retries?.[id])).length:null,eligibleNow:snapshot.queueStatus==='recorded'&&Array.isArray(outstanding)?ready.length:null,deferredByRetry:Array.isArray(outstanding)?deferred.length:null,retryExhausted:snapshot.queueStatus==='recorded'?exhausted.length:null,nextRetryAt:Number.isFinite(nextMs)?new Date(nextMs).toISOString():null},
  coverage:predictionDiagnosticCoverage(snapshot,now),
 };
}
function predictionFilmDiagnostic(snapshot,filmId,now){
 const record=snapshot.films?.[filmId];
 const eligibility=predictionDiagnosticEligibility(snapshot.queue,filmId,now);
 const reasons=predictionDiagnosticReasons(snapshot,predictionDiagnosticOutstanding(snapshot.queue));
 return {
  atomic:false,filmId,lane:predictionDiagnosticLane(snapshot.queue,filmId),eligibleNow:eligibility.eligibleNow,cause:eligibility.cause,
  snapshot:{...predictionDiagnosticSnapshotId(snapshot.queue),consistent:reasons.length===0,partial:reasons.length>0,reasons},
  fingerprint:predictionDiagnosticFingerprint(record,snapshot.freshness||strictFreshness(snapshot.profile),snapshot.filmsById?.get(filmId)||null),prediction:predictionDiagnosticPrediction(record,snapshot.profile,snapshot.freshness||strictFreshness(snapshot.profile),snapshot.filmsById?.get(filmId)||null),
  index:predictionDiagnosticIndex(snapshot,filmId,record),retry:predictionDiagnosticRetry(snapshot.queue,filmId),
 };
}
function predictionDiagnosticDecodeCursor(cursor){
 if(typeof cursor!=='string'||!cursor.startsWith('pd1.'))return null;
 try{
  const value=JSON.parse(decodeURIComponent(cursor.slice(4)));
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  if(Object.keys(value).some(key=>key!=='offset'&&key!=='refreshedAt'&&key!=='programmeRunId'))return null;
  if(!Number.isInteger(value.offset)||value.offset<0||value.offset>100000)return null;
  if(value.refreshedAt!=null&&typeof value.refreshedAt!=='string')return null;
  if(value.programmeRunId!=null&&typeof value.programmeRunId!=='string')return null;
  return {offset:value.offset,refreshedAt:value.refreshedAt??null,programmeRunId:value.programmeRunId??null};
 }catch{return null;}
}
function predictionDiagnosticEncodeCursor(value){
 return 'pd1.'+encodeURIComponent(JSON.stringify({offset:value.offset,refreshedAt:value.refreshedAt??null,programmeRunId:value.programmeRunId??null}));
}
function predictionPendingQuery(query){
 const filter=query.filter||'all';
 if(filter!=='all'&&filter!=='eligible'&&filter!=='deferred'&&filter!=='exhausted')return {error:'"filter" must be all, eligible, deferred or exhausted.'};
 if(!Number.isInteger(query.limit)||query.limit<1||query.limit>PREDICTION_DIAGNOSTIC_PAGE_MAX)return {error:'"limit" must be an integer from 1 to 20.'};
 if(query.cursor!==undefined&&!predictionDiagnosticDecodeCursor(query.cursor))return {error:'"cursor" does not match this queue page.'};
 return {filter,limit:query.limit,cursor:query.cursor};
}
function predictionPendingPage(snapshot,query,now){
 const parsed=predictionPendingQuery(query);
 if(parsed.error)return parsed;
 if(snapshot.queueStatus!=='recorded'||!Array.isArray(predictionDiagnosticOutstanding(snapshot.queue))){
  const cause=snapshot.queueStatus==='unavailable'?'queue_unavailable':snapshot.queueStatus==='recorded'?'queue_shape_unknown':'queue_not_recorded';
  return {atomic:false,status:snapshot.queueStatus==='recorded'?'partial':'unavailable',cause,filter:parsed.filter,items:[],nextCursor:null};
 }
 const identity=predictionDiagnosticSnapshotId(snapshot.queue);
 const cursor=parsed.cursor?predictionDiagnosticDecodeCursor(parsed.cursor):{offset:0,refreshedAt:identity.refreshedAt,programmeRunId:identity.programmeRunId};
 if(cursor.refreshedAt!==identity.refreshedAt||cursor.programmeRunId!==identity.programmeRunId)return {atomic:false,status:'snapshot_changed',cause:'snapshot_changed',filter:parsed.filter,snapshot:identity,items:[],nextCursor:null};
 const ready=new Set(predictionDiagnosticReadyIds(snapshot.queue,now));
 const exhausted=new Set(predictionDiagnosticExhaustedIds(snapshot.queue));
 const sourceIds=parsed.filter==='exhausted'?[...exhausted]:predictionDiagnosticOutstanding(snapshot.queue).filter(id=>!exhausted.has(id));
 const rows=sourceIds.map(filmId=>{
  const eligibility=predictionDiagnosticEligibility(snapshot.queue,filmId,now);
  const retry=predictionDiagnosticRetry(snapshot.queue,filmId);
  return {filmId,lane:predictionDiagnosticLane(snapshot.queue,filmId),eligibleNow:eligibility.eligibleNow,cause:eligibility.cause,retryAt:retry.retryAt,classification:retry.classification,attempts:retry.attempts,lastRunId:retry.lastRunId};
 }).filter(row=>parsed.filter==='all'||parsed.filter==='exhausted'||(parsed.filter==='eligible'?ready.has(row.filmId):!ready.has(row.filmId)));
 const items=rows.slice(cursor.offset,cursor.offset+parsed.limit);
 const nextCursor=cursor.offset+items.length<rows.length?predictionDiagnosticEncodeCursor({...identity,offset:cursor.offset+items.length}):null;
 return {atomic:false,status:'recorded',filter:parsed.filter,snapshot:identity,items,nextCursor};
}

// Read-only parity of the actual hot outstanding work against the persisted hot queue (AIR-536).
// One cutoff (`now`) and one pinned published generation. The expected side is the queue builder itself, `buildPredictionQueue`, run in memory on a fresh read of the
// pinned D1 programme, catalog admissions, Prediction facts and recovery intents, with the stored queue passed as `previous` (its retry records are the one retry authority). Nothing
// is persisted, settled, refreshed or sent to a model, and the stored queue is never touched: there is no second copy of the window, freshness, retry or eligibility rules.
// A source that cannot be read, a generation or queue revision that moves during the read, or a basis the comparison cannot judge is `unknown`, never a match and never zero.
const PARITY_EXAMPLE_LIMIT=10;
const PARITY_SAFE_CODE=/^[a-z][a-z0-9_]{0,59}$/;
function parityExamples(ids){return {ids:ids.slice(0,PARITY_EXAMPLE_LIMIT),total:ids.length,truncated:ids.length>PARITY_EXAMPLE_LIMIT};}
async function predictionHotParity(env,now=Date.now()){
 const started=Date.now();
 const answer=(verdict,reasons,extra={})=>({schemaVersion:1,verdict,reasons,cutoff:new Date(now).toISOString(),atomic:false,elapsedMs:Date.now()-started,...extra});
 const unknown=(reason,error=null,extra={})=>answer('unknown',[reason],{...(error?{errorCode:PARITY_SAFE_CODE.test(error?.code||'')?error.code:'read_failed'}:{}),...extra});
 let read;
 try{read=await readQueueHead(env);}catch(error){return unknown('queue_unreadable',error);}
 const stored=read.current,revision=read.head?.queueGeneration??null;
 if(!stored)return unknown('queue_not_recorded');
 if(!queueShapeValid(stored))return unknown('queue_shape_invalid');
 // The lanes are compared as sets, so a duplicate id or an id in both lanes would be hidden by the comparison. Such a queue is malformed: reported as such, never deduplicated into a match.
 {const hotIds=new Set(stored.hotPending),coldIds=new Set(stored.coldPending);
  if(hotIds.size!==stored.hotPending.length||coldIds.size!==stored.coldPending.length||stored.hotPending.some(id=>coldIds.has(id)))return unknown('queue_shape_invalid');}
 let programme,profile;
 try{[programme,profile]=await Promise.all([loadJSON(env,'programme.json'),loadJSON(env,profileKey)]);}catch(error){return unknown('source_unreadable',error);}
 if(!profile)return unknown('profile_not_recorded');
 if(!programme||!Array.isArray(programme.films)||!programme.runId)return unknown('programme_not_recorded');
 let pinned;
 try{pinned=await queuePin(env,programme);}catch(error){return unknown('generation_unreadable',error);}
 const pin=pinned?.epgPin;
 if(pin?.authority!=='d1'||!pin.programmeRunId)return unknown('epg_authority_not_d1');
 if(pin.programmeRunId!==programme.runId)return unknown('programme_generation_mismatch');
 const generation={authority:'d1',programmeRunId:pin.programmeRunId,generation:pin.generation??null,fence:pin.fence??null,phase:pin.phase??null};
 const builtAt=Date.parse(stored.refreshedAt||''),exhausted=id=>retryBudgetExhausted(stored.retries?.[id]);
 const queueIdentity={revision,programmeRunId:stored.programmeRunId??null,priorityBasis:stored.priorityBasis??null,refreshedAt:stored.refreshedAt??null,ageSeconds:Number.isFinite(builtAt)?Math.max(0,Math.round((now-builtAt)/1000)):null,nextChangeAt:stored.priorityNextChangeAt??null};
 const storedHot=stored.hotPending.filter(id=>!exhausted(id)),storedCold=stored.coldPending.filter(id=>!exhausted(id));
 const base={generation,queue:{...queueIdentity,hotPending:storedHot.length,coldPending:storedCold.length,declaredHot:Number.isInteger(stored.priorityCount)?stored.priorityCount:null}};
 let why;
 try{why=queueAdvanceGate(stored,programme,profile,(await fingerprintRegistryDigests()).registry,(await predictionRecoveryOverlay(env)).revision);}catch(error){return unknown('source_unreadable',error,base);}
 if(why)return unknown('queue_not_comparable_'+why,null,base);
 if(stored.priorityBasis!=='completed')return unknown('queue_basis_'+String(stored.priorityBasis||'unknown').replace(/[^a-z_]/g,''),null,base);
 // A queue ranked on an earlier generation is waiting for its own natural refresh: its hot lane says nothing about this generation, so it is reported, not compared.
 // The fence re-reads the generation, the queue revision and (when a signature was read) the assigned shows after the evaluation. A change during this call is `unknown`, whichever verdict was about to be stated.
 const fence=async before=>{
  try{
   const [again,live,after]=await Promise.all([readQueueHead(env),typeof PublishedEpg!=='undefined'?PublishedEpg.currentGeneration(env):null,before?currentShowsSignature(pinned,programme):null]);
   if(!live||live.programmeRunId!==pin.programmeRunId||(live.fence??null)!==generation.fence||(live.generation??null)!==generation.generation)return {reason:'generation_changed_during_read'};
   if(revision!==null?again.head?.queueGeneration!==revision:again.current?.refreshedAt!==stored.refreshedAt)return {reason:'queue_changed_during_read'};
   if(before){if(after.unreadable)return {reason:'shows_signature_unreadable'};if(after.signature!==before.signature)return {reason:'shows_changed_during_read'};}
   return null;
  }catch(error){return {reason:'fence_unverifiable',error};}
 };
 if(stored.programmeRunId!==programme.runId){const broken=await fence(null);return broken?unknown(broken.reason,broken.error,base):answer('degraded',['generation_rollover_pending'],base);}
 const signature=await currentShowsSignature(pinned,programme);
 if(signature.applicable===false)return unknown('shows_signature_not_applicable',null,base);
 if(signature.unreadable)return unknown('shows_signature_unreadable',null,base);
 const capture={};let expected;
 try{expected=await buildPredictionQueue(pinned,programme,'parity',stored,capture,{now});}catch(error){return unknown('source_unreadable',error,base);}
 if(!expected||!Array.isArray(capture.films))return unknown('snapshot_incomplete',null,base);
 if(capture.catalog==null)return unknown('catalog_not_recorded',null,base);
 // Fence: the generation, the queue revision and the assigned shows must be what they were before the evaluation, or the two sides are not one snapshot.
 {const broken=await fence(signature);if(broken)return unknown(broken.reason,broken.error,base);}
 const storedHotSet=new Set(storedHot),expectedHot=expected.hotPending.filter(id=>!exhausted(id)),expectedHotSet=new Set(expectedHot),expectedCold=expected.coldPending.filter(id=>!exhausted(id));
 const storedKnown=new Set([...stored.hotPending,...stored.coldPending]),filmsById=new Map(capture.films.map(film=>[String(film.id),film]));
 const signatureMatches=stored.showsSignature===signature.signature;
 // A difference is clock-only when the Film, with the shows it has now, was classified at the queue's own build instant as the queue classified it: only the window moved.
 const clockOnly=id=>{const film=filmsById.get(id);return !!film&&Number.isFinite(builtAt)&&predictionPriority(film,builtAt).hot===storedHotSet.has(id);};
 const missing=expectedHot.filter(id=>!storedHotSet.has(id)).map(id=>({id,cause:!storedKnown.has(id)?'absent_from_queue':clockOnly(id)?'window_transition':signatureMatches?'reclassified_hot':'shows_signature_changed'}));
 const extra=storedHot.filter(id=>!expectedHotSet.has(id)).map(id=>({id,cause:!expected.priority?.[id]?'no_longer_outstanding':clockOnly(id)?'window_transition':'reclassified_cold'}));
 const causes={};for(const item of [...missing,...extra])causes[item.cause]=(causes[item.cause]||0)+1;
 const withinCap=Number.isFinite(builtAt)&&now-builtAt<PRIORITY_WINDOW_REEVAL_MS,onlyClock=missing.length+extra.length>0&&(causes.window_transition||0)===missing.length+extra.length;
 const verdict=!missing.length&&!extra.length?'match':onlyClock&&withinCap?'degraded':'mismatch';
 const reasons=verdict==='match'?[]:verdict==='degraded'?['window_transition_deferred']:Object.entries(causes).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([cause])=>cause);
 const hotDeferred=ids=>ids.filter(id=>stored.retries?.[id]?.retryAt>now).length;
 let staged=null;
 try{const stage=await loadJSON(env,BATCH_STAGE_KEY);staged=Array.isArray(stage?.items)?stage.items.length:0;}catch{staged=null;}
 return answer(verdict,reasons,{
  ...base,
  showsSignature:{stored:stored.showsSignature??null,current:signature.signature,matches:signatureMatches},
  rateCap:{seconds:PRIORITY_WINDOW_REEVAL_MS/1000,withinCap},
  expected:{hotOutstanding:expectedHot.length,coldOutstanding:expectedCold.length,hotDeferredByRetry:hotDeferred(expectedHot),actionableNow:queueReadyIds(expected,now).length},
  queueCounts:{hotOutstanding:storedHot.length,coldOutstanding:storedCold.length,hotDeferredByRetry:hotDeferred(storedHot),actionableNow:queueReadyIds(stored,now).length,retryExhausted:[...stored.hotPending,...stored.coldPending].filter(exhausted).length,staged},
  diff:{missingFromQueueHot:missing.length,extraInQueueHot:extra.length,causes},
  examples:{missingFromQueueHot:parityExamples(missing.map(item=>item.id)),extraInQueueHot:parityExamples(extra.map(item=>item.id))},
  evaluated:{films:capture.films.length},
 });
}
