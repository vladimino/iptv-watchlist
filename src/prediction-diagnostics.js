// Read-only prediction queue diagnostics. AIR-98.
// Callers pass objects already loaded from storage. Nothing here writes, lists a
// bucket, or starts a run. Eligibility matches queueReadyIds, including its
// comparison of a numeric retryAt with the supplied clock.
const PREDICTION_DIAGNOSTIC_PAGE_MAX=20;

async function loadPredictionDiagnosticSnapshot(env,filmId){
 const read=async key=>{
  try{const value=await loadJSON(env,key);return {status:value==null?'not_recorded':'recorded',value};}
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
  freshness,filmsById:new Map(catalogFilms.map(film=>[String(film.id),film])),
  queue:queue.value,queueStatus:queue.status,profile:profile.value,profileStatus:profile.status,index:index.value,indexStatus:index.status,
  programme:programme.value,programmeStatus:programme.status,catalog:catalog.value,catalogStatus:catalog.status,
  publishedGeneration:publishedGeneration.value,publishedGenerationStatus:publishedGeneration.status,films,
 };
}
function predictionDiagnosticOutstanding(queue){
 if(!Array.isArray(queue?.hotPending)||!Array.isArray(queue?.coldPending))return null;
 const seen=new Set(),ids=[];
 for(const id of [...queue.hotPending,...queue.coldPending]){if(seen.has(id))continue;seen.add(id);ids.push(id);}
 return ids;
}
function predictionDiagnosticReadyIds(queue,now){
 if(!queue)return [];
 const ids=queue.priorityCount?queue.hotPending:queue.coldPending;
 return (ids||queue.pending||[]).filter(id=>!(queue.retries?.[id]?.retryAt>now));
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
 const issues=Array.isArray(validation.issues)?validation.issues.filter(issue=>issue&&typeof issue==='object'&&typeof issue.path==='string'&&/^(fingerprint|prediction)(\.[A-Za-z0-9_]{1,40}){0,2}$/.test(issue.path)&&ISSUE_CODES.includes(issue.code)).slice(0,MAX_ISSUES).map(issue=>({path:issue.path,code:issue.code})):[];
 return {stage:PREDICTION_VALIDATION_STAGES.includes(validation.stage)?validation.stage:'unknown',reportedBy:validation.reportedBy==='caller'||validation.reportedBy==='worker'?validation.reportedBy:null,issues};
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
 const lane=predictionDiagnosticLane(queue,filmId);
 if(lane==='unknown')return {eligibleNow:null,cause:'unknown'};
 if(lane==='none')return {eligibleNow:false,cause:'not_in_queue'};
 const deferred=!!(queue.retries?.[filmId]&&queue.retries[filmId].retryAt>now);
 if(deferred)return {eligibleNow:false,cause:'retry_backoff'};
 if(predictionDiagnosticReadyIds(queue,now).includes(filmId))return {eligibleNow:true,cause:'ready'};
 if(lane==='cold'&&queue.priorityCount)return {eligibleNow:false,cause:'waiting_behind_hot'};
 return {eligibleNow:false,cause:'not_ready'};
}
function predictionDiagnosticFingerprint(record){
 if(!record||record.status==='unavailable')return {presence:'unknown',schemaVersion:null,current:null,invalidated:null};
 if(!record.fingerprint)return {presence:'not_recorded',schemaVersion:null,current:false,invalidated:false};
 const fingerprint=record.fingerprint;
 return {presence:'recorded',schemaVersion:fingerprint.fingerprintSchemaVersion??null,current:fingerprintCurrent(fingerprint),invalidated:!!fingerprint.invalidatedAt};
}
function predictionDiagnosticPrediction(record,profile,freshness=strictFreshness(profile),film=null){
 if(!record||record.status==='unavailable')return {presence:'unknown',current:null,stale:'unknown',profileMatch:null,cause:'unknown'};
 const prediction=record.predictions?.current;
 if(!record.predictions||!prediction)return {presence:record.predictions?'recorded_without_current':'not_recorded',current:false,stale:'unknown',profileMatch:null,cause:'not_recorded'};
 if(!profile)return {presence:'recorded',current:false,stale:'unknown',profileMatch:null,cause:'profile_not_recorded'};
 const current=!!freshness.state(prediction,record.fingerprint,film?.genres);
 const profileMatch=prediction.tasteProfileVersion===profile.version&&prediction.tasteProfileHash===profile.profileHash;
 // A prediction kept under another profile version by the selective rule is 'compatible'; its record keeps its own version.
 const cause=current?(profileMatch?'current':'compatible'):!fingerprintCurrent(record.fingerprint)?'fingerprint_not_current':!profileMatch?'profile_changed':'stale';
 return {presence:'recorded',current,stale:!current,profileMatch,cause,mode:freshness.mode};
}
function predictionDiagnosticIndex(snapshot,filmId,record){
 if(snapshot.indexStatus==='unavailable'||snapshot.profileStatus==='unavailable'||!record||record.status==='unavailable')return 'unknown';
 if(snapshot.indexStatus!=='recorded'||!snapshot.profile)return 'unknown';
 const item=snapshot.index?.[filmId];
 if(!item)return 'not_recorded';
 const freshness=snapshot.freshness||strictFreshness(snapshot.profile),film=snapshot.filmsById?.get(filmId)||null;
 const indexCurrent=!!freshness.indexed(item,film);
 const fileCurrent=!!freshness.state(record.predictions?.current,record.fingerprint,film?.genres);
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
 if(Array.isArray(outstanding)&&snapshot.indexStatus==='recorded'&&snapshot.profileStatus==='recorded'&&profile&&outstanding.some(id=>(snapshot.freshness||strictFreshness(profile)).indexed(snapshot.index?.[id],snapshot.filmsById?.get(id)||null)))reasons.push('index_ahead_of_queue');
 return reasons;
}
function predictionDiagnosticCoverage(snapshot,now){
 if(snapshot.programmeStatus!=='recorded'||snapshot.profileStatus!=='recorded'||snapshot.indexStatus==='unavailable'||!snapshot.profile)return {status:'unknown',current:null,total:null,percent:null,windowCurrent:null,windowTotal:null,windowPercent:null};
 const summary=canonicalCoverageSummary(snapshot.programme,snapshot.catalogStatus==='recorded'?snapshot.catalog:null,snapshot.index||{},snapshot.profile,now,snapshot.freshness||strictFreshness(snapshot.profile));
 const complete=snapshot.catalogStatus==='recorded'&&snapshot.indexStatus==='recorded';
 return {
  status:complete?'recorded':'partial',current:summary.currentPredictionsTotal,total:summary.confirmedFilmsTotal,
  percent:summary.confirmedFilmsTotal?coveragePercent(summary.currentPredictionsTotal,summary.confirmedFilmsTotal):null,
  windowCurrent:summary.windowCurrentPredictions,windowTotal:summary.windowFilmsTotal,
  windowPercent:summary.windowFilmsTotal?coveragePercent(summary.windowCurrentPredictions,summary.windowFilmsTotal):null,
 };
}
function predictionDiagnosticSnapshotId(queue){
 return {refreshedAt:queue?.refreshedAt||null,programmeRunId:queue?.programmeRunId||null};
}
function predictionQueueOverview(snapshot,now){
 const outstanding=predictionDiagnosticOutstanding(snapshot.queue);
 const reasons=predictionDiagnosticReasons(snapshot,outstanding);
 const ready=snapshot.queue?predictionDiagnosticReadyIds(snapshot.queue,now):[];
 const deferred=Array.isArray(outstanding)?outstanding.filter(id=>snapshot.queue.retries?.[id]?.retryAt>now):[];
 const nextMs=deferred.map(id=>snapshot.queue.retries[id].retryAt).filter(value=>typeof value==='number').sort((a,b)=>a-b)[0];
 let state='unavailable',cause='queue_not_recorded';
 if(snapshot.queueStatus==='unavailable')cause='queue_unavailable';
 else if(snapshot.queueStatus==='recorded'&&!Array.isArray(outstanding))cause='queue_shape_unknown';
 else if(snapshot.queueStatus==='recorded'&&outstanding.length===0){state='drained';cause='drained';}
 else if(snapshot.queueStatus==='recorded'&&ready.length===0){state='temporarily_ineligible';cause=deferred.length?'retry_backoff':'waiting_behind_hot';}
 else if(snapshot.queueStatus==='recorded'){state='eligible';cause='ready';}
 return {
  atomic:false,state,cause,
  snapshot:{...predictionDiagnosticSnapshotId(snapshot.queue),profileVersion:snapshot.profile?.version??snapshot.queue?.profileVersion??null,consistent:reasons.length===0,partial:reasons.length>0,reasons,sources:predictionDiagnosticSources(snapshot)},
  pending:{total:Array.isArray(outstanding)?outstanding.length:null,hot:Array.isArray(snapshot.queue?.hotPending)?snapshot.queue.hotPending.length:null,cold:Array.isArray(snapshot.queue?.coldPending)?snapshot.queue.coldPending.length:null,eligibleNow:snapshot.queueStatus==='recorded'&&Array.isArray(outstanding)?ready.length:null,deferredByRetry:Array.isArray(outstanding)?deferred.length:null,nextRetryAt:Number.isFinite(nextMs)?new Date(nextMs).toISOString():null},
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
  fingerprint:predictionDiagnosticFingerprint(record),prediction:predictionDiagnosticPrediction(record,snapshot.profile,snapshot.freshness||strictFreshness(snapshot.profile),snapshot.filmsById?.get(filmId)||null),
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
 if(filter!=='all'&&filter!=='eligible'&&filter!=='deferred')return {error:'"filter" must be all, eligible or deferred.'};
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
 const rows=predictionDiagnosticOutstanding(snapshot.queue).map(filmId=>{
  const eligibility=predictionDiagnosticEligibility(snapshot.queue,filmId,now);
  const retry=predictionDiagnosticRetry(snapshot.queue,filmId);
  return {filmId,lane:predictionDiagnosticLane(snapshot.queue,filmId),eligibleNow:eligibility.eligibleNow,cause:eligibility.cause,retryAt:retry.retryAt,classification:retry.classification};
 }).filter(row=>parsed.filter==='all'||(parsed.filter==='eligible'?ready.has(row.filmId):!ready.has(row.filmId)));
 const items=rows.slice(cursor.offset,cursor.offset+parsed.limit);
 const nextCursor=cursor.offset+items.length<rows.length?predictionDiagnosticEncodeCursor({...identity,offset:cursor.offset+items.length}):null;
 return {atomic:false,status:'recorded',filter:parsed.filter,snapshot:identity,items,nextCursor};
}
