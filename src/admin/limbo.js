// Owner-only limbo inventory behind the existing Cloudflare Access application: GET /api/admin/limbo. One request reads
// the same published snapshot as the other admin reads (pointer, generation programme, pointer again, titles.json,
// people.json) plus two bounded enrichment objects, the prediction queue and the view index, and the generation's
// observation index (its manifest and the shards that hold records, compared with the resolution map and the ledger by
// etag only), evaluates the pure data health model over that projection and pages the issues it yields. When that index
// is fresh or stale and holds records, the same request also reads, once, the three coordination objects the observation
// recovery route already reads and the published-programme authority marker, and asks that route's adapter whether each
// loaded record is an owner action now. An absent object is a fact. An unreadable object or an unreadable marker is not
// a completed check. Mode d1 is a completed refusal of reconsider. Nothing here lists the bucket, reads a per-film enrichment object, the body of
// the resolution ledger or of the discovery snapshot, writes, starts work or calls another service. Without a readable
// index of the published generation, unresolved observations are reported as unavailable, never as none, and the action
// queue says it was not checked.
// The contract is docs/reference/api/admin.md; the model is docs/reference/domain/data-health.md.
const LIMBO_QUEUE_KEY=ENRICHMENT_KEY+'prediction-queue.json',LIMBO_INDEX_KEY=ENRICHMENT_KEY+'view-index.json';
const LIMBO_SOURCES=['epg/published-generation.json','epg/generations/<programmeRunId>/programme.json','titles.json','people.json','admin/owner-reviews.json',LIMBO_QUEUE_KEY,LIMBO_INDEX_KEY,'epg/generations/<programmeRunId>/discovery-observations/manifest.json','epg/generations/<programmeRunId>/discovery-observations/shard-NN.json','epg/resolver-continuation.json','epg/discovery-status.json','epg/resolver-lease.json'];
let ADMIN_LIMBO_CACHE=null;

function limboEncodePin(tuple){
 const coordination=tuple.coordinationVersion??'';
 const parts=[coordination?'L3':'L2',adminEncodePin(tuple),tuple.queueVersion??'',tuple.indexVersion??'',tuple.observationsVersion??''];
 if(coordination)parts.push(coordination);
 return parts.map(part=>encodeURIComponent(part)).join('|');
}
function limboDecodePin(raw){
 if(typeof raw!=='string'||!raw||raw.length>ADMIN_PIN_MAX)return null;
 const parts=raw.split('|');
 if(!((parts.length===5&&parts[0]==='L2')||(parts.length===6&&parts[0]==='L3')))return null;
 let decoded;
 try{decoded=parts.map(part=>decodeURIComponent(part));}catch{return null;}
 const base=adminDecodePin(decoded[1]);
 if(!base)return null;
 return {...base,queueVersion:decoded[2]||null,indexVersion:decoded[3]||null,observationsVersion:decoded[4]||null,coordinationVersion:parts[0]==='L3'?(decoded[5]||null):null};
}
function limboSameTuple(left,right){return adminSameTuple(left,right)&&left.queueVersion===right.queueVersion&&left.indexVersion===right.indexVersion&&left.observationsVersion===right.observationsVersion&&(left.coordinationVersion||null)===(right.coordinationVersion||null);}
// What the inventory says about unresolved observations: unavailable without a readable index of the published
// generation; otherwise the index's own coverage (always partial: it holds only observations that already have a
// decision) and whether its sources moved since it was written.
function limboObservationCoverage(observations){
 if(!observations||!['fresh','stale'].includes(observations.state))return {available:false,reason:observations?'index_'+observations.state:'index_unavailable',state:observations?.state??'unavailable',programmeRunId:observations?.programmeRunId??null};
 const manifest=observations.manifest;
 return {available:true,state:observations.state,reasons:observations.reasons,programmeRunId:manifest.programmeRunId,writtenAt:manifest.writtenAt,writer:manifest.writer.kind,scope:manifest.coverage.scope,indexed:manifest.coverage.indexed,eligible:manifest.coverage.eligible??null,omitted:manifest.coverage.omitted??null,complete:manifest.coverage.complete,awaitingFirstLookup:manifest.counts?.awaitingFirstLookup??null};
}
// The page cursor carries the pin and the evaluation clock it was minted under in front of the inventory cursor, so a
// later page is cut from the same evaluation of the same snapshot or refused.
function limboEncodeCursor(tuple,nowMs,inner){return encodeURIComponent(limboEncodePin(tuple))+'~'+nowMs+'~'+inner;}
function limboDecodeCursor(raw,tuple){
 const first=raw.indexOf('~');if(first<=0)return null;
 const second=raw.indexOf('~',first+1);if(second<=first+1)return null;
 let pin;
 try{pin=limboDecodePin(decodeURIComponent(raw.slice(0,first)));}catch{return null;}
 if(!pin||!limboSameTuple(pin,tuple))return null;
 const nowMs=Number(raw.slice(first+1,second));
 if(!Number.isInteger(nowMs)||nowMs<=0)return null;
 const inner=raw.slice(second+1);
 return inner?{nowMs,inner}:null;
}
function limboStrings(list){return Array.isArray(list)?list.filter(id=>typeof id==='string'||typeof id==='number').map(id=>String(id)):[];}
// Film records for the health model: every programme record of the snapshot, plus a minimal record for a queued film the
// programme does not carry (a catalog film). Fingerprint and prediction state is attached only to outstanding queue films,
// from the queue's own verdict and the view index entry; a film the queue does not list keeps those fields unobserved.
function limboFilms(base,queue,index){
 const run=base.tuple.programmeRunId,byStored=new Map();
 const films=base.records.films.map(record=>{const copy={...record,programmeRunId:run,inProgramme:true};byStored.set(record.storedId,copy);return copy;});
 if(!queue)return films;
 const outstanding=[...new Set([...limboStrings(queue.hotPending),...limboStrings(queue.coldPending),...limboStrings(queue.pending)])].sort((left,right)=>left.localeCompare(right,'en'));
 const retries=queue.retries&&typeof queue.retries==='object'?queue.retries:{},work=queue.work&&typeof queue.work==='object'?queue.work:{};
 for(const storedId of outstanding){
  let record=byStored.get(storedId);
  if(!record){
   const id=canonicalFilmId(storedId);
   if(!id)continue;
   record={id,storedId,programmeRunId:typeof queue.programmeRunId==='string'?queue.programmeRunId:null,inProgramme:false};
   byStored.set(storedId,record);films.push(record);
  }
  const entry=index?.[storedId]&&typeof index[storedId]==='object'?index[storedId]:null,retry=retries[storedId]&&typeof retries[storedId]==='object'?retries[storedId]:null,plan=work[storedId]&&typeof work[storedId]==='object'?work[storedId]:null;
  const generatedAt=typeof entry?.prediction?.generatedAt==='string'?entry.prediction.generatedAt:null;
  const sourceRunId=typeof queue.programmeRunId==='string'&&queue.programmeRunId?queue.programmeRunId:null;
  record.prediction={programmeRunId:sourceRunId,status:entry?.prediction?'stale':'missing',updatedAt:generatedAt,attempts:Number.isInteger(retry?.attempts)?retry.attempts:0,failureReason:typeof retry?.kind==='string'?retry.kind:null,nextAction:plan?.requiredWork??null};
  if(plan?.requiredWork==='prediction_only')record.fingerprint={programmeRunId:sourceRunId,status:'current',updatedAt:generatedAt};
  else if(plan?.requiredWork==='fingerprint_and_prediction')record.fingerprint={programmeRunId:sourceRunId,status:entry?.fingerprintHash?'stale':'missing',updatedAt:generatedAt,nextAction:'fingerprint_and_prediction'};
 }
 return films;
}
async function adminLimboLoad(env,hasPin){
 const base=await adminLoadSnapshot(env,hasPin);
 if(base.error)return base;
 const cache=ADMIN_LIMBO_CACHE;
 const queue=await adminReadObject(env.BUCKET,LIMBO_QUEUE_KEY,cache?.queue||null);
 const index=await adminReadObject(env.BUCKET,LIMBO_INDEX_KEY,cache?.index||null);
 let observations;
 try{observations=await discoveryIndexRead(env.BUCKET,{cached:cache?.observations||null,env});}
 catch{observations={state:'unavailable',reasons:['storage_unavailable'],programmeRunId:null,manifest:null,manifestEtag:null,records:[]};}
 const readable=['fresh','stale'].includes(observations.state);
 const coordination=await limboReadCoordination(env,observations);
 const tuple={...base.tuple,queueVersion:queue.present?queue.version:null,indexVersion:index.present?index.version:null,observationsVersion:readable?observations.manifestEtag:null,coordinationVersion:coordination.version||null};
 // The index's freshness is judged on every request; only its records are reused with the rest of the snapshot.
 if(cache&&limboSameTuple(cache.tuple,tuple))return {...cache,observations,coordination,tuple};
 const queueBody=queue.present&&queue.body&&typeof queue.body==='object'&&!Array.isArray(queue.body)?queue.body:null;
 const indexBody=index.present&&index.body&&typeof index.body==='object'&&!Array.isArray(index.body)?index.body:null;
 const snapshot={
  tuple,base,queue:{version:queue.version,body:queue.body,present:queue.present},index:{version:index.version,body:index.body,present:index.present},
  queueBody,films:limboFilms(base,queueBody,indexBody),observations,coordination,
  info:{...base.info,queuePresent:queue.present,queueRefreshedAt:typeof queueBody?.refreshedAt==='string'?queueBody.refreshedAt:null,queueProgrammeRunId:typeof queueBody?.programmeRunId==='string'?queueBody.programmeRunId:null,queueLastCheckAt:typeof queueBody?.lastCheckAt==='string'?queueBody.lastCheckAt:null,queueUploadedAt:queue.uploaded,indexPresent:index.present,indexUploadedAt:index.uploaded},
 };
 ADMIN_LIMBO_CACHE=snapshot;
 return snapshot;
}
// The queue names films by their stored id; the health model compares queue membership by record id, so the lists and the
// retry map are translated with the one canonical-id rule before the evaluation.
function limboQueueForHealth(queue,now){
 if(!queue)return null;
 const ids=list=>limboStrings(list).map(id=>canonicalFilmId(id)).filter(Boolean);
 const retries={};
 for(const [storedId,retry] of Object.entries(queue.retries&&typeof queue.retries==='object'?queue.retries:{})){const id=canonicalFilmId(storedId);if(id&&retry&&typeof retry==='object')retries[id]=retry;}
 return {...queue,hotPending:ids(queue.hotPending),coldPending:ids(queue.coldPending),pending:ids(queue.pending),retries,observedAt:now};
}
function limboEvaluate(snapshot,nowMs){
 const now=new Date(nowMs).toISOString(),run=snapshot.tuple.programmeRunId;
 const films=snapshot.films.map(record=>({...record,observedAt:now}));
 const queue=snapshot.queueBody?limboQueueForHealth(snapshot.queueBody,now):snapshot.queue.present?{observedAt:now}:null;
 const index=snapshot.observations,readable=['fresh','stale'].includes(index?.state);
 return DataHealth.evaluateDataHealth({
  now,
  published:{programmeRunId:run,phase:'published',publishedAt:snapshot.base.info.programmeUpdatedAt,observedAt:now},
  coverage:readable?{films:'partial',observations:'partial'}:{films:'partial'},
  films,
  ...(readable?{observations:DiscoveryIndex.observationHealthEntries(index.records,index.manifest.writtenAt)}:{}),
  predictionQueue:queue,
 });
}
function limboReadToken(read){
 if(!read)return 'unread';
 if(read.status==='unavailable')return 'unavailable';
 if(read.status==='not_recorded')return 'absent';
 return 'e:'+String(read.etag??'present');
}
function limboCoordinationMode(publishedEpg){
 return publishedEpg?.mode==='r2'||publishedEpg?.mode==='d1'?publishedEpg.mode:'unread';
}
// Absent is a fact the gates use. Unavailable, in this order, is not a completed check. An unreadable published-EPG
// marker is the same. Mode `d1` is a known mode, so the gates run and refuse reconsider.
function limboCoordinationReason(continuation,status,lease,publishedEpg){
 if(continuation?.status==='unavailable')return 'coordination_continuation';
 if(status?.status==='unavailable')return 'coordination_status';
 if(lease?.status==='unavailable')return 'coordination_lease';
 if(limboCoordinationMode(publishedEpg)==='unread')return 'coordination_authority';
 return null;
}
// One pass over the records already loaded. The three coordination objects are the ones the observation recovery read
// opens. An unreadable one is not a completed check and does not fail the inventory. No per-record request.
async function limboReadCoordination(env,observations){
 const readable=['fresh','stale'].includes(observations?.state);
 const records=Array.isArray(observations?.records)?observations.records:[];
 if(!readable||!records.length)return {judged:readable,version:'',reason:null};
 const [continuation,status,lease]=await Promise.all([drJson(env.BUCKET,DR_CONTINUATION_KEY),drJson(env.BUCKET,DR_STATUS_KEY),drJson(env.BUCKET,DISCOVERY_LEASE_KEY)]);
 let publishedEpg;
 try{publishedEpg=await identityPublishedEpgSupport(env);}catch{publishedEpg={supported:false,mode:null};}
 const reason=limboCoordinationReason(continuation,status,lease,publishedEpg);
 return {judged:reason===null,reason,version:[limboReadToken(continuation),limboReadToken(status),limboReadToken(lease),limboCoordinationMode(publishedEpg)].join('~'),continuation,status,lease,publishedEpg};
}
function limboJudgeRecord(record,index,coordination,nowIso,nowMs){
 try{return observationOwnerAction(record,index,coordination,nowIso,nowMs);}
 catch{return {now:false,checked:true,capability:null,reason:'not_confirmed'};}
}
function limboWithActions(items,snapshot,nowMs){
 const index=snapshot.observations,coordination=snapshot.coordination,judged=coordination?.judged===true&&['fresh','stale'].includes(index?.state)&&coordination.continuation;
 const byKey=new Map();
 if(judged){
  const nowIso=new Date(nowMs).toISOString();
  for(const record of index.records)byKey.set(record.key,limboJudgeRecord(record,index,coordination,nowIso,nowMs));
 }
 const checked=coordination?.judged===true;
 return items.map(item=>{
  if(item.kind!=='observation')return {...item,ownerAction:{now:false,checked:true,capability:null,reason:'not_this_page'}};
  return {...item,ownerAction:byKey.get(item.subjectId)||{now:false,checked,capability:null,reason:checked?'not_indexed':'not_checked'}};
 });
}
function limboAttentionView(filter,snapshot,items){
 const observations=snapshot.observations,checked=snapshot.coordination?.judged===true;
 const reason=checked?null:(snapshot.coordination?.reason||(!observations||!observations.state?'index_unavailable':'index_'+observations.state));
 const now=checked?items.filter(item=>item.ownerAction?.now===true).length:null;
 const byCause=checked?Object.fromEntries(LimboInventory.LIMBO_CAUSES.map(cause=>[cause,items.filter(item=>item.cause===cause&&item.ownerAction?.now===true).length])):null;
 return {mode:filter.attention==='now'?'now':'all',checked,reason,now,byCause};
}
function limboQueryCauses(params){
 const hasCause=params.has('cause'),values=params.has('causes')?params.getAll('causes'):null;
 if(hasCause&&values)return {error:'conflicting_cause'};
 if(hasCause)return {cause:params.get('cause'),causes:null};
 if(!values)return {cause:null,causes:null};
 if(values.length===1&&values[0]==='none')return {cause:null,causes:[]};
 if(values.some(value=>value==='none'||value===''))return {error:'unknown_cause'};
 return {cause:null,causes:values};
}
async function adminLimboRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const params=url.searchParams;
 let pin=null;
 if(params.has('pin')){pin=limboDecodePin(params.get('pin'));if(!pin)return adminError('invalid_pin',400);}
 let limit=ADMIN_LIMIT_DEFAULT;
 if(params.has('limit')){const raw=params.get('limit');if(!/^(?:[1-9]|1\d|2[0-5])$/.test(raw))return adminError('invalid_limit',400);limit=Number(raw);}
 let minAgeDays=null;
 if(params.has('age')){const raw=params.get('age');if(!/^(?:0|[1-9]\d{0,2})$/.test(raw)||Number(raw)>LimboInventory.LIMBO_AGE_MAX_DAYS)return adminError('invalid_age',400);minAgeDays=Number(raw);}
 const causes=limboQueryCauses(params);
 if(causes.error)return adminError(causes.error,400);
 let attention=null;
 if(params.has('attention')){const raw=params.get('attention');if(raw!=='all'&&raw!=='now')return adminError('unknown_attention',400);attention=raw==='now'?'now':null;}
 const filter=LimboInventory.limboFilter({kind:params.has('kind')?params.get('kind'):null,subsystem:params.has('subsystem')?params.get('subsystem'):null,cause:causes.cause,causes:causes.causes,minAgeDays,attention});
 if(filter.error)return adminError(filter.error,400);
 let cursor=null;
 if(params.has('cursor')){cursor=params.get('cursor');if(!cursor||cursor.length>ADMIN_CURSOR_MAX)return adminError('stale_cursor',400);}
 let snapshot;
 try{snapshot=await adminLimboLoad(env,pin!==null);}
 catch{return adminError('storage_unavailable',503);}
 if(snapshot.error)return adminError(snapshot.error,snapshot.error==='stale_pin'?409:503);
 if(pin&&!limboSameTuple(pin,snapshot.tuple))return adminError('stale_pin',409);
 let nowMs=Date.now(),inner=null;
 if(cursor!==null){const decoded=limboDecodeCursor(cursor,snapshot.tuple);if(!decoded)return adminError('stale_cursor',400);nowMs=decoded.nowMs;inner=decoded.inner;}
 const health=limboEvaluate(snapshot,nowMs);
 if(health.error)return adminError('evaluation_failed',500);
 const all=limboWithActions(LimboInventory.limboItems(health,{films:snapshot.films,observations:['fresh','stale'].includes(snapshot.observations?.state)?snapshot.observations.records:[]}),snapshot,nowMs);
 const filtered=LimboInventory.filterLimboItems(all,filter);
 if(filtered.error)return adminError(filtered.error,400);
 const page=LimboInventory.pageLimboItems(filtered.items,{limit,key:filtered.key,cursor:inner});
 if(page.error)return adminError(page.error,400);
 const context=LimboInventory.limboContext(health);
 const attentionView=limboAttentionView(filter,snapshot,all);
 const counts=LimboInventory.limboCounts(all);
 counts.actionNow=attentionView.now;counts.actionNowByCause=attentionView.byCause;
 const filmStates={...LimboInventory.limboFilmStates(all),programmeRunId:snapshot.tuple.programmeRunId};
 return json({
  pin:limboEncodePin(snapshot.tuple),
  snapshot:{...snapshot.info,evaluatedAt:health.now,sources:LIMBO_SOURCES,clock:health.clock},
  kind:filter.kind,subsystem:filter.subsystem,cause:filter.cause,causes:filter.causes,age:filter.minAgeDays,limit,
  attention:{mode:attentionView.mode,checked:attentionView.checked,reason:attentionView.reason,now:attentionView.now},
  items:page.items,nextCursor:page.nextCursor?limboEncodeCursor(snapshot.tuple,nowMs,page.nextCursor):null,total:page.total,
  counts,filmStates,
  coverage:{films:health.scope.coverage.films,filmsObserved:health.scope.subjects.films.length,observations:limboObservationCoverage(snapshot.observations),observationsObserved:health.scope.subjects.observations.length},
  context:context.issues,unread:context.unread,
  thresholds:health.thresholds,
  vocabulary:{kinds:LimboInventory.LIMBO_KINDS,subsystems:LimboInventory.LIMBO_SUBSYSTEMS,causes:LimboInventory.LIMBO_CAUSES},
 });
}
