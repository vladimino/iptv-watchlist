// Owner-only data health read: GET /api/admin/health. One request builds the health snapshot the pure evaluator
// (DataHealth, src/domain/data-health.js) expects from bounded single-object reads and returns the evaluation,
// aggregated into groups the health page can list. It reads the pinned admin snapshot (pointer, generation
// programme, dictionaries), the view index, the taste profile, the prediction queue, the resolver continuation
// record and the generation copy of the catalog. It never lists the bucket, never reads a lease or the resolution
// ledger, never writes, never starts work and never calls another service; a source it cannot read in a bounded
// way is passed as "not supplied" so the evaluator reports it as unknown instead of healthy.
const ADMIN_HEALTH_SAMPLE=10;
const ADMIN_HEALTH_UNBOUNDED={
 observations:'The unresolved observations live in the resolution ledger, which this read does not open; the limbo inventory is their bounded view.',
 letterboxd:'The baseline import leaves per-chunk receipts under letterboxd/imports/<sha256>/ and no summary object; finding the latest one would list the bucket.',
};

function adminHealthIso(ms){return new Date(ms).toISOString();}
function adminHealthPresent(object){return object.present&&object.body&&typeof object.body==='object'?object.body:null;}
// The fingerprint and prediction envelopes of one programme film, derived from the view index with the same
// freshness rule every other reader uses. Without the index or the profile nothing is derived.
function adminHealthDimensions(storedId,film,index,freshness){
 const item=index[storedId];
 const fingerprintRecord=indexedFingerprintRecord(item);
 const fingerprint=!item?.fingerprintHash?{status:'missing',updatedAt:null}
  :fingerprintRecord&&freshness.fingerprintUsable(fingerprintRecord,film.genres)?{status:'current',updatedAt:null}
  :{status:'stale',updatedAt:null,failureReason:fingerprintRecord?.invalidatedAt?'invalidated':null};
 const generatedAt=typeof item?.prediction?.generatedAt==='string'?item.prediction.generatedAt:null;
 const prediction=!item?.prediction?{status:'missing',updatedAt:null}
  :freshness.indexed(item,film)?{status:'current',updatedAt:generatedAt}
  :{status:'stale',updatedAt:generatedAt};
 return {fingerprint,prediction};
}
// The prediction queue keyed by the record ids of the programme films, so the evaluator's membership test meets the
// same identifiers as the Film records. Catalog-only ids stay as stored.
function adminHealthQueue(raw,recordIdOf,observedAt){
 if(!raw||typeof raw!=='object')return raw===null?null:undefined;
 const map=list=>Array.isArray(list)?list.map(id=>recordIdOf(String(id))):[];
 const retries={};
 for(const [id,entry] of Object.entries(raw.retries&&typeof raw.retries==='object'?raw.retries:{}))retries[recordIdOf(String(id))]=entry;
 return {programmeRunId:typeof raw.programmeRunId==='string'?raw.programmeRunId:null,hotPending:map(raw.hotPending),coldPending:map(raw.coldPending),pending:map(raw.pending),retries,lastCheckAt:raw.lastCheckAt??null,lastBatch:raw.lastBatch??null,refreshedAt:raw.refreshedAt??null,observedAt};
}
function adminHealthDiscovery(raw,observedAt){
 if(!raw||typeof raw!=='object')return raw===null?null:undefined;
 return {stage:raw.stage??null,reason:raw.reason??null,at:raw.at??null,retryAt:raw.retryAt??null,nextCatchUpAt:raw.nextCatchUpAt??null,remainingChunks:raw.remainingChunks??null,programmeRunId:raw.programmeRunId??null,hopId:raw.hopId??null,observedAt};
}
function adminHealthPosters(catalog,run,observedAt){
 if(!catalog||typeof catalog!=='object')return catalog===null?null:undefined;
 const counts=catalogPosterMissing([{key:'catalog',etag:null,films:catalog}]);
 return {programmeRunId:run,catalogRecords:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length,unverifiedMissing:counts.unverified.length,sample:counts.verified.slice(0,ADMIN_HEALTH_SAMPLE).map(row=>row.id),observedAt};
}
function adminHealthBounds(current,value){
 if(!value)return current;
 const ms=Date.parse(value);
 if(!Number.isFinite(ms))return current;
 return {earliest:current.earliest===null||ms<current.earliest?ms:current.earliest,latest:current.latest===null||ms>current.latest?ms:current.latest};
}
function adminHealthBoundsIso(bounds){return {earliest:bounds.earliest===null?null:adminHealthIso(bounds.earliest),latest:bounds.latest===null?null:adminHealthIso(bounds.latest)};}
// Issues with one subsystem, category, reason, severity and action describe one kind of problem; the page lists the
// kinds with their counts and a bounded sample of subjects. The sorted issue order is kept, so the groups are ranked.
function adminHealthGroups(issues){
 const groups=new Map();
 for(const item of issues){
  const key=[item.subsystem,item.category,item.reason,item.severity,item.subject.kind,item.action.suggested,item.action.code,String(item.action.eligible),item.action.reason].join('|');
  let group=groups.get(key);
  if(!group){
   group={key,subsystem:item.subsystem,category:item.category,reason:item.reason,severity:item.severity,subjectKind:item.subject.kind,action:{...item.action},threshold:item.threshold??null,issues:0,affected:0,sample:[],evidence:{complete:0,partial:0,missing:0},missing:{},anomalies:{},freshness:{},progress:{},observedAt:{earliest:null,latest:null},lastProgressAt:{earliest:null,latest:null},retryAt:{earliest:null,latest:null},rules:{},ids:[]};
   groups.set(key,group);
  }
  group.issues++;
  group.affected+=item.affected?.count??0;
  if(group.sample.length<ADMIN_HEALTH_SAMPLE)group.sample.push(item.subject.id);
  if(group.ids.length<ADMIN_HEALTH_SAMPLE)group.ids.push(item.id);
  group.evidence[item.evidence.completeness]++;
  for(const name of item.evidence.missing||[])group.missing[name]=(group.missing[name]||0)+1;
  for(const name of item.evidence.anomalies||[])group.anomalies[name]=(group.anomalies[name]||0)+1;
  group.freshness[item.freshness.status]=(group.freshness[item.freshness.status]||0)+1;
  group.progress[item.progress.status]=(group.progress[item.progress.status]||0)+1;
  group.observedAt=adminHealthBounds(group.observedAt,item.observedAt);
  group.lastProgressAt=adminHealthBounds(group.lastProgressAt,item.lastProgressAt);
  group.retryAt=adminHealthBounds(group.retryAt,item.progress.retryAt);
  group.rules[item.provenance?.rule||'unknown']=(group.rules[item.provenance?.rule||'unknown']||0)+1;
 }
 return [...groups.values()].map(group=>({...group,observedAt:adminHealthBoundsIso(group.observedAt),lastProgressAt:adminHealthBoundsIso(group.lastProgressAt),retryAt:adminHealthBoundsIso(group.retryAt)}));
}
async function adminHealthRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 let pin=null;
 if(url.searchParams.has('pin')){pin=adminDecodePin(url.searchParams.get('pin'));if(!pin)return adminError('invalid_pin',400);}
 let snapshot;
 try{snapshot=await adminLoadSnapshot(env,pin!==null);}
 catch{return adminError('storage_unavailable',503);}
 if(snapshot.error)return adminError(snapshot.error,snapshot.error==='stale_pin'?409:503);
 if(pin&&!adminSameTuple(pin,snapshot.tuple))return adminError('stale_pin',409);
 const run=snapshot.tuple.programmeRunId,bucket=env.BUCKET,reads=[];
 const read=async key=>{reads.push(key);return adminReadObject(bucket,key,null);};
 // Every read settles before the answer, so a failed read never leaves another one half-open in the background.
 const settled=await Promise.allSettled([read(ENRICHMENT_KEY+'view-index.json'),read(profileKey),read(predictionQueueKey),read(CONTINUATION_KEY),read(epgGenerationKey(run,'discovered-films.json'))]);
 if(settled.some(item=>item.status==='rejected'))return adminError('storage_unavailable',503);
 const [viewIndex,profile,queue,continuation,catalog]=settled.map(item=>item.value);
 const nowMs=Date.now(),now=adminHealthIso(nowMs);
 const programme=snapshot.programme.body,pointer=snapshot.pointer?.body||null;
 const index=adminHealthPresent(viewIndex),profileBody=adminHealthPresent(profile);
 let freshness=null;
 if(index&&profileBody){try{freshness=await predictionFreshness(env,profileBody);}catch{freshness=null;}}
 const byStored=new Map();
 for(const film of Array.isArray(programme?.films)?programme.films:[])if(film&&film.id!=null&&!byStored.has(String(film.id)))byStored.set(String(film.id),film);
 const recordIdByStored=new Map(snapshot.records.films.map(record=>[record.storedId,record.id]));
 const recordIdOf=id=>recordIdByStored.get(id)??id;
 const films=snapshot.records.films.map(record=>{
  const film=byStored.get(record.storedId)||{};
  const dimensions=freshness?adminHealthDimensions(record.storedId,film,index,freshness):{};
  return {...record,programmeRunId:run,observedAt:now,...(Object.hasOwn(film,'poster')?{poster:typeof film.poster==='string'&&film.poster?film.poster:null}:{}),...dimensions};
 });
 const d1=snapshot.pointer?.authority==='d1';
 const published={programmeRunId:run,phase:'published',publishedAt:typeof pointer?.publishedAt==='string'?pointer.publishedAt:(typeof programme?.updatedAt==='string'?programme.updatedAt:null),observedAt:now};
 const input={
  now,pin:{programmeRunId:run},coverage:{films:'complete'},published,films,
  predictionQueue:adminHealthQueue(queue.present?queue.body:null,recordIdOf,now),
  discovery:adminHealthDiscovery(continuation.present?continuation.body:null,now),
  posters:adminHealthPosters(catalog.present?catalog.body:null,run,now),
 };
 const result=DataHealth.evaluateDataHealth(input);
 if(result.error)return adminError('health_unavailable',503);
 const subsystems={...result.subsystems};
 // The fingerprint and prediction dimensions are derived from the view index and the profile. Without either the
 // films carry no such envelope, so the subsystems are unknown, not clear.
 if(!freshness)for(const name of ['fingerprint','prediction'])subsystems[name]={...subsystems[name],evidence:index===null||profileBody===null?'object_missing':'not_supplied',status:'unknown',derived:'view_index'};
 const groups=adminHealthGroups(result.issues);
 const whole=result.issues.filter(item=>item.subject.kind!=='film'&&item.subject.kind!=='observation');
 return json({
  pin:adminEncodePin(snapshot.tuple),snapshot:snapshot.info,
  health:{schemaVersion:result.schemaVersion,now:result.now,clock:result.clock,published:result.published,scope:{programmeRunId:result.scope.programmeRunId,coverage:result.scope.coverage,sources:result.scope.sources,subjects:{films:result.scope.subjects.films.length,observations:result.scope.subjects.observations.length}},subsystems,counts:result.counts,thresholds:result.thresholds,groups,issues:whole},
  sources:{
   published:{key:d1?'published_epg_authority':EPG_GENERATION_KEY,evidence:'observed',observedAt:now},
   films:{key:d1?'published_epg_document':epgGenerationKey(run,'programme.json'),evidence:'observed',count:films.length,coverage:'complete',observedAt:now},
   viewIndex:{key:ENRICHMENT_KEY+'view-index.json',evidence:index?'observed':'object_missing',present:!!index,entries:index?Object.keys(index).length:0,version:viewIndex.version,observedAt:now},
   profile:{key:profileKey,evidence:profileBody?'observed':'object_missing',present:!!profileBody,version:profileBody?.version??null,observedAt:now},
   predictionQueue:{key:predictionQueueKey,evidence:queue.present?'observed':'object_missing',present:queue.present,refreshedAt:queue.present?queue.body?.refreshedAt??null:null,observedAt:now},
   discovery:{key:CONTINUATION_KEY,evidence:continuation.present?'observed':'object_missing',present:continuation.present,observedAt:now},
   posters:{key:epgGenerationKey(run,'discovered-films.json'),evidence:catalog.present?'observed':'object_missing',present:catalog.present,catalogRecords:input.posters?.catalogRecords??null,observedAt:now},
   observations:{evidence:'not_supplied',reason:ADMIN_HEALTH_UNBOUNDED.observations},
   letterboxd:{evidence:'not_supplied',reason:ADMIN_HEALTH_UNBOUNDED.letterboxd},
  },
  reads:[...(d1?['published_epg_authority','published_epg_document']: [EPG_GENERATION_KEY,epgGenerationKey(run,'programme.json'),EPG_GENERATION_KEY]),'titles.json','people.json','admin/owner-reviews.json',...reads],
 });
}
