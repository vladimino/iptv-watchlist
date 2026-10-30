// Owner-only limbo inventory behind the existing Cloudflare Access application: GET /api/admin/limbo. One request reads
// the same published snapshot as the other admin reads (pointer, generation programme, pointer again, titles.json,
// people.json) plus two bounded enrichment objects, the prediction queue and the view index, evaluates the pure data
// health model over that projection and pages the film issues it yields. Nothing here lists the bucket, reads a
// per-film enrichment object, the resolution ledger, the discovery snapshot, a lease or a continuation, writes, starts
// work or calls another service. Unresolved observations have no bounded projection yet and are reported as unavailable.
// The contract is docs/reference/api/admin.md; the model is docs/reference/domain/data-health.md.
const LIMBO_QUEUE_KEY=ENRICHMENT_KEY+'prediction-queue.json',LIMBO_INDEX_KEY=ENRICHMENT_KEY+'view-index.json';
const LIMBO_SOURCES=['epg/published-generation.json','epg/generations/<programmeRunId>/programme.json','titles.json','people.json',LIMBO_QUEUE_KEY,LIMBO_INDEX_KEY];
const LIMBO_OBSERVATIONS={available:false,reason:'no_bounded_projection',detail:'Unresolved observations live in the resolution ledger, which this read does not load; a generation-scoped index written at EPG publish is required.'};
let ADMIN_LIMBO_CACHE=null;

function limboEncodePin(tuple){return ['L1',adminEncodePin(tuple),tuple.queueVersion??'',tuple.indexVersion??''].map(part=>encodeURIComponent(part)).join('|');}
function limboDecodePin(raw){
 if(typeof raw!=='string'||!raw||raw.length>ADMIN_PIN_MAX)return null;
 const parts=raw.split('|');
 if(parts.length!==4||parts[0]!=='L1')return null;
 let decoded;
 try{decoded=parts.map(part=>decodeURIComponent(part));}catch{return null;}
 const base=adminDecodePin(decoded[1]);
 if(!base)return null;
 return {...base,queueVersion:decoded[2]||null,indexVersion:decoded[3]||null};
}
function limboSameTuple(left,right){return adminSameTuple(left,right)&&left.queueVersion===right.queueVersion&&left.indexVersion===right.indexVersion;}
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
 const tuple={...base.tuple,queueVersion:queue.present?queue.version:null,indexVersion:index.present?index.version:null};
 if(cache&&limboSameTuple(cache.tuple,tuple))return cache;
 const queueBody=queue.present&&queue.body&&typeof queue.body==='object'&&!Array.isArray(queue.body)?queue.body:null;
 const indexBody=index.present&&index.body&&typeof index.body==='object'&&!Array.isArray(index.body)?index.body:null;
 const snapshot={
  tuple,base,queue:{version:queue.version,body:queue.body,present:queue.present},index:{version:index.version,body:index.body,present:index.present},
  queueBody,films:limboFilms(base,queueBody,indexBody),
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
 return DataHealth.evaluateDataHealth({
  now,
  published:{programmeRunId:run,phase:'published',publishedAt:snapshot.base.info.programmeUpdatedAt,observedAt:now},
  coverage:{films:'partial'},
  films,
  predictionQueue:queue,
 });
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
 const filter=LimboInventory.limboFilter({kind:params.has('kind')?params.get('kind'):null,subsystem:params.has('subsystem')?params.get('subsystem'):null,cause:params.has('cause')?params.get('cause'):null,minAgeDays});
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
 const all=LimboInventory.limboItems(health,{films:snapshot.films});
 const filtered=LimboInventory.filterLimboItems(all,filter);
 if(filtered.error)return adminError(filtered.error,400);
 const page=LimboInventory.pageLimboItems(filtered.items,{limit,key:filtered.key,cursor:inner});
 if(page.error)return adminError(page.error,400);
 const context=LimboInventory.limboContext(health);
 return json({
  pin:limboEncodePin(snapshot.tuple),
  snapshot:{...snapshot.info,evaluatedAt:health.now,sources:LIMBO_SOURCES,clock:health.clock},
  kind:filter.kind,subsystem:filter.subsystem,cause:filter.cause,age:filter.minAgeDays,limit,
  items:page.items,nextCursor:page.nextCursor?limboEncodeCursor(snapshot.tuple,nowMs,page.nextCursor):null,total:page.total,
  counts:LimboInventory.limboCounts(all),
  coverage:{films:health.scope.coverage.films,filmsObserved:health.scope.subjects.films.length,observations:LIMBO_OBSERVATIONS},
  context:context.issues,unread:context.unread,
  thresholds:health.thresholds,
  vocabulary:{kinds:LimboInventory.LIMBO_KINDS,subsystems:LimboInventory.LIMBO_SUBSYSTEMS,causes:LimboInventory.LIMBO_CAUSES},
 });
}
