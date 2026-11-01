// Owner-only recovery of one discovery observation behind the existing Cloudflare Access application.
//   GET  /api/admin/discovery-recovery?key=<observation key>[&pin=]   read-only assessment and action preview
//   POST /api/admin/discovery-recovery/confirm                          server-issued confirmation of one exact scope
//   POST /api/admin/discovery-recovery/reconsider                       the guarded write discovery_reconsider@1
//   GET  /api/admin/discovery-recovery/receipt?idempotencyKey=<key>     the stored reconsider record and its receipt
//   POST /api/admin/discovery-recovery/identity-confirm                 confirmation of one assign or reject
//   POST /api/admin/discovery-recovery/identity-correct                 the guarded write discovery_identity_correct@1
//   GET  /api/admin/discovery-recovery/identity-receipt?idempotencyKey= the stored identity record and its receipt
// Every read of the observation comes from the generation-scoped observation index (src/domain/discovery-observation-index.js),
// never from the discovery ledger or the body of the resolution map; the GET routes get a bucket that has nothing but `get`
// and `head`, so they cannot write, list or delete. Nothing here calls TMDB, runs a chunk, starts a series or dispatches
// work. Two writes share that lease: discovery_reconsider lifts one terminal fence, and discovery_identity_correct
// assigns or rejects one movie id on one current decision. Each compare-and-swaps the resolution map on its etag and
// the decision's own digest. Neither calls TMDB nor starts a chunk.
// Contracts: docs/reference/api/admin.md (routes), docs/reference/api/admin-actions.md (the action),
// docs/reference/domain/discovery-recovery.md (the assessment).
const DR_RESOLUTION_KEY='epg/discovery-resolution.json',DR_STATUS_KEY='epg/discovery-status.json',DR_CONTINUATION_KEY='epg/resolver-continuation.json';
const DR_ACTION_PREFIX='admin/actions/discovery_reconsider/v1/';
const DI_ACTION_PREFIX='admin/actions/discovery_identity_correct/v1/';
const DI_CATALOG_KEY='epg/discovered-films.json';
const DR_PIN=/^D1\.[0-9a-f]{32}$/,DR_IDEMPOTENCY=/^[A-Za-z0-9_-]{16,80}$/,DR_BODY_MAX=16384;
const DR_CAPABILITY=AdminActions.defineCapability({
 id:'discovery_reconsider',version:1,title:'Reconsider one terminal discovery observation',
 subjectKinds:['observation'],healthActionCode:'discovery_reconsider',
 budget:{maxRecords:1,maxWritesPerRecord:1,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'manual',guidance:'No automatic undo. The action record keeps the before-image of the decision; the next ordinary uncertain outcome on the same evidence makes the observation terminal again.'},
 confirmTtlMs:10*60000,
});
const DI_CAPABILITY=AdminActions.defineCapability({
 id:'discovery_identity_correct',version:1,title:'Correct the identity of one discovery observation',
 subjectKinds:['observation'],healthActionCode:'discovery_identity_correct',
 budget:{maxRecords:1,maxWritesPerRecord:1,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'manual',guidance:'No automatic undo. The action record keeps the before-image of the one decision. Restoring it is a separate owner-approved write. A rejection blocks only that movie id on this observation.'},
 confirmTtlMs:10*60000,
});
const DR_REGISTRY=AdminActions.createRegistry([DR_CAPABILITY,DI_CAPABILITY]);

// A bucket with `get` and `head` only. Every key it serves is recorded with the version it showed, except the resolver
// lease: the lease is judged on its own (a live writer refuses the action), and the executor's own lease must not make
// the pin it compares stale.
function drReadOnly(bucket){
 const versions=new Map();
 const note=(key,version)=>{if(key===DISCOVERY_LEASE_KEY)return;const prior=versions.get(key);versions.set(key,prior==null||prior===version?version:prior+'|'+version);};
 return {versions,bucket:{
  async get(key){let object;try{object=await bucket.get(key);}catch(error){note(key,'unavailable');throw error;}note(key,object?String(object.etag??'present'):'absent');return object;},
  async head(key){let object;try{object=await bucket.head(key);}catch(error){note(key,'unavailable');throw error;}note(key,object?String(object.etag??'present'):'absent');return object;},
 }};
}
async function drJson(bucket,key){
 try{const object=await bucket.get(key);return object?{status:'recorded',value:await object.json(),etag:object.etag??null}:{status:'not_recorded',value:null,etag:null};}
 catch{return {status:'unavailable',value:undefined,etag:null};}
}
async function drPin(versions){
 const tuple=[...versions.entries()].sort(([left],[right])=>left.localeCompare(right,'en'));
 return 'D1.'+(await adminDigest(JSON.stringify(tuple))).slice(0,32);
}

// The published-EPG authority, when a D1 binding exists. No binding keeps today's R2 fence. Schema older than the
// published-EPG tables, or mode `r2`, also keeps it. Mode `d1`, a version that requires those tables and does not have
// them, or a marker that cannot be read, is unsupported: the caller writes nothing and does not trust a lagging R2 mirror.
const DI_PUBLISHED_EPG_TABLES=['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'];
async function identityPublishedEpgSupport(env){
 const db=env?.DB;
 if(!db||typeof db.prepare!=='function')return {supported:true,mode:'r2'};
 const one=async sql=>{const row=await db.prepare(sql).bind().first();return row??null;};
 let version;
 try{version=(await one('SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return {supported:true,mode:'r2'};
  return {supported:false,mode:null};
 }
 let names;
 try{
  const listed=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'published_epg%'").bind().all();
  const rows=Array.isArray(listed)?listed:listed?.results;
  names=Array.isArray(rows)?rows.map(row=>row?.name).filter(name=>typeof name==='string'):[];
 }catch{return {supported:false,mode:null};}
 const tables=DI_PUBLISHED_EPG_TABLES.every(name=>names.includes(name));
 if(!tables)return Number(version)>=8?{supported:false,mode:null}:{supported:true,mode:'r2'};
 if(!(Number(version)>=6))return {supported:true,mode:'r2'};
 let row;
 try{row=await one('SELECT mode, programme_run_id AS programmeRunId, mirror_programme_run_id AS mirrorProgrammeRunId FROM published_epg_authority WHERE id=1');}
 catch{return {supported:false,mode:null};}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1'))return {supported:false,mode:null};
 if(row.mode==='d1')return {supported:false,mode:'d1',programmeRunId:row.programmeRunId??null,mirrorProgrammeRunId:row.mirrorProgrammeRunId??null};
 return {supported:true,mode:'r2'};
}

// One generation-scoped observation index as a reader sees it now. With `key`, only the shard that can hold that key
// is read; without it, every shard that has records. The resolution map and the generation ledger are compared by `head`.
async function readScopedObservationIndex(bucket,run,generation,scope,manifestKey,shardKey,options={}){
 const base={programmeRunId:run,manifest:null,manifestEtag:null,records:[],reasons:[],generation,indexScope:scope};
 const object=await bucket.get(manifestKey(run));
 const manifestEtag=object?String(object.etag??''):null;
 const cached=options.key===undefined&&options.cached&&options.cached.indexScope===scope&&options.cached.manifestEtag&&options.cached.manifestEtag===manifestEtag&&options.cached.manifest?.programmeRunId===run?options.cached:null;
 let manifest,records;
 if(cached){await adminDiscardBody(object);manifest=cached.manifest;records=cached.records;}
 else{
  const read=DiscoveryIndex.readObservationIndexManifest(object?await object.json():null,run,scope);
  if(!read.ok)return {...base,manifestEtag,state:read.state};
  manifest=read.manifest;
  records=[];
  const wanted=options.key!==undefined?[DiscoveryIndex.observationShard(options.key)]:manifest.shards.map((shard,index)=>shard.items>0?index:null).filter(index=>index!==null);
  for(const index of wanted){
   const shardObject=await bucket.get(shardKey(run,index));
   const shard=DiscoveryIndex.readObservationIndexShard(shardObject?await shardObject.json():null,manifest,index);
   if(!shard.ok)return {...base,manifest,manifestEtag,state:shard.state};
   records.push(...shard.items);
  }
 }
 const [resolution,ledger]=await Promise.all([bucket.head(DR_RESOLUTION_KEY),bucket.head(epgGenerationKey(run,'discovery-latest.json'))]);
 const freshness=DiscoveryIndex.observationIndexFreshness(manifest,{programmeRunId:run,resolutionEtag:resolution?.etag??null,ledgerEtag:ledger?.etag??null});
 return {...base,manifest,manifestEtag,records,state:freshness.state,reasons:freshness.reasons,resolutionEtag:resolution?.etag??null};
}
// The unresolved index, and, for one key that is not in it, the verified index of the same generation. A list read
// does not open the verified index. A keyed read never parses the ledger or the resolution map.
async function discoveryIndexRead(bucket,options={}){
 const pointer=await bucket.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 const run=generation?.phase==='published'&&typeof generation.programmeRunId==='string'&&generation.programmeRunId?generation.programmeRunId:null;
 const base={programmeRunId:run,manifest:null,manifestEtag:null,records:[],reasons:[],generation:generation&&typeof generation==='object'?generation:null,indexScope:DiscoveryIndex.OBSERVATION_INDEX_SCOPE};
 if(!run)return {...base,state:'unavailable',reasons:['no_published_generation']};
 const unresolved=await readScopedObservationIndex(bucket,run,generation&&typeof generation==='object'?generation:null,DiscoveryIndex.OBSERVATION_INDEX_SCOPE,DiscoveryIndex.observationIndexManifestKey,DiscoveryIndex.observationIndexShardKey,options);
 if(options.key===undefined||unresolved.records.some(item=>item.key===options.key)||!['fresh','stale','missing'].includes(unresolved.state))return unresolved;
 const verified=await readScopedObservationIndex(bucket,run,generation&&typeof generation==='object'?generation:null,DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE,DiscoveryIndex.observationVerifiedManifestKey,DiscoveryIndex.observationVerifiedShardKey,{key:options.key});
 if(verified.state==='missing')return unresolved;
 if(verified.records.some(item=>item.key===options.key))return verified;
 if(verified.state==='fresh'&&verified.manifest?.coverage?.complete===true)return unresolved;
 return {...verified,records:[]};
}
function drIndexView(index){
 const manifest=index.manifest;
 return {state:index.state,reasons:index.reasons,programmeRunId:index.programmeRunId,writtenAt:manifest?.writtenAt??null,writer:manifest?.writer?.kind??null,coverage:manifest?.coverage??null,counts:manifest?.counts??null};
}

// One observation judged now, from the index and the small coordination objects. `ownLeaseId` is the lease the executor
// holds: it is not another writer.
async function drObserve(bucket,versions,key,nowMs,ownLeaseId=null,env=null){
 const index=await discoveryIndexRead(bucket,{key});
 const record=index.records.find(item=>item.key===key)||null;
 const [continuation,status,lease]=await Promise.all([drJson(bucket,DR_CONTINUATION_KEY),drJson(bucket,DR_STATUS_KEY),drJson(bucket,DISCOVERY_LEASE_KEY)]);
 const leaseValue=lease.status==='unavailable'?undefined:ownLeaseId&&lease.value?.id===ownLeaseId?null:lease.value;
 const run=index.programmeRunId,now=new Date(nowMs).toISOString();
 let assessment=null;
 if(record){
  const health=continuation.status==='recorded'&&leaseValue!==undefined?healthSummary(continuationHealth(continuation.value,leaseValue,status.value,nowMs,run)):null;
  assessment=DiscoveryRecovery.assessObservationRecovery({
   now,target:{key},published:{programmeRunId:run},
   observation:DiscoveryIndex.observationAssessmentInput(record,screenedNonfilmReason(record,record.decision)),
   decision:record.decision,
   series:{record:continuation.status==='unavailable'?undefined:continuation.value,health,lease:leaseValue},
   index:{state:index.state},throttle:{retryAt:typeof status.value?.retryAt==='string'?status.value.retryAt:null},
  });
 }
 const pin=await drPin(versions);
 const issues=assessment&&!assessment.error?[DiscoveryRecovery.reconsiderIssue(assessment)]:[];
 const preview=AdminActions.previewAction(DR_REGISTRY,{capability:DR_CAPABILITY.id,version:DR_CAPABILITY.version,subject:{kind:'observation',id:key},pin,ids:[key]},{pin,now,records:record?[{id:key,version:record.decisionHash}]:[],issues});
 const publishedEpg=await identityPublishedEpgSupport(env);
 const identity=DiscoveryIdentity.identityOffer({record,index:{state:index.state,complete:index.manifest?.coverage?.complete===true,scope:index.indexScope||index.manifest?.coverage?.scope||null},generation:index.generation,series:assessment&&!assessment.error?assessment.series:null,publishedEpg});
 return {pin,now,index,record,assessment,preview,identity,lease,continuation,status};
}
function drObservationView(record){
 if(!record)return null;
 return {key:record.key,title:record.title,normalizedTitle:record.normalizedTitle,year:record.year,durations:record.durations,shows:record.shows,seenInLatestSnapshot:record.seenInLatestSnapshot,lastSeenAt:record.lastSeenAt,lastAiring:record.lastAiring,confirmedTmdbId:record.confirmedTmdbId,decision:record.decision,decisionHash:record.decisionHash};
}
function drPreviewView(preview,assessment){
 return {
  capability:DR_CAPABILITY.id,version:DR_CAPABILITY.version,status:preview.status,reason:preview.reason,
  gate:assessment?.execute??null,scopeFingerprint:preview.scopeFingerprint??null,
  affected:preview.affected||[],excluded:preview.excluded||[],budget:preview.budget??null,
  confirmTtlMs:preview.confirmTtlMs??DR_CAPABILITY.confirmTtlMs,compensation:DR_CAPABILITY.compensation,atomic:false,
  cost:{tmdbCalls:0,chunksStarted:0,writes:{resolutionMap:1,actionRecord:3,observationIndex:2}},
 };
}
function drKey(value){return typeof value==='string'&&DiscoveryIndex.observationKeyValid(value)?value:null;}

async function adminDiscoveryRecoveryRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const key=drKey(url.searchParams.get('key'));
 if(!key)return adminError('invalid_key',400);
 let pin=null;
 if(url.searchParams.has('pin')){pin=url.searchParams.get('pin');if(!DR_PIN.test(pin))return adminError('invalid_pin',400);}
 const {bucket,versions}=drReadOnly(env.BUCKET);
 let observed;
 try{observed=await drObserve(bucket,versions,key,Date.now(),null,env);}
 catch{return adminError('storage_unavailable',503);}
 if(pin&&pin!==observed.pin)return json({error:'stale_pin',pin:observed.pin},409);
 return json({
  pin:observed.pin,evaluatedAt:observed.now,atomic:false,target:{key},
  index:drIndexView(observed.index),indexed:!!observed.record,
  observation:drObservationView(observed.record),
  assessment:observed.assessment,
  identity:observed.identity,
  action:drPreviewView(observed.preview,observed.assessment),
  coordination:{lease:observed.lease.status,continuation:observed.continuation.status,status:observed.status.status},
  sources:[...versions.keys()].sort((left,right)=>left.localeCompare(right,'en')),
 });
}

// The write routes accept only a same-origin JSON request that passed the Worker's Cloudflare Access application (the
// edge adds the Access assertion to every request it lets through) and names the action in a custom header, which no
// cross-site form can send. The Worker does not verify the assertion's signature here: the Access application in front
// of the whole Worker is the authority, as for every other owner route.
function drPrincipal(request,url){
 const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
 const type=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 return {owner:typeof assertion==='string'&&assertion.length>0&&assertion.length<=8192&&request.headers.get('Origin')===url.origin&&request.headers.get('X-IPTV-Admin-Action')==='discovery_reconsider'&&type==='application/json'};
}
async function drBody(request){
 let text;
 try{text=await request.text();}catch{return null;}
 if(!text||text.length>DR_BODY_MAX)return null;
 try{const body=JSON.parse(text);return body&&typeof body==='object'&&!Array.isArray(body)?body:null;}catch{return null;}
}
function drActionKey(idempotencyKey){return DR_ACTION_PREFIX+idempotencyKey+'.json';}
async function drActionRead(env,idempotencyKey){
 const object=await env.BUCKET.get(drActionKey(idempotencyKey));
 return object?{record:await object.json(),etag:object.etag}:{record:null,etag:null};
}
async function drActionWrite(env,idempotencyKey,record,etag){
 return await env.BUCKET.put(drActionKey(idempotencyKey),JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
}
// A lease the resolver itself would have written. Anything else is not taken over: who holds the resolver is unknown.
function drLeaseReadable(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.id==='string'&&value.id.length>0&&typeof value.expiresAt==='number'&&Number.isFinite(value.expiresAt)&&value.expiresAt>=0;
}
function drRefused(refusal,status,extra={}){return json({error:refusal,refusal,...extra},status);}

async function drConfirm(request,env,url){
 const principal=drPrincipal(request,url);
 if(!principal.owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 if(!body)return drRefused('invalid_request',400);
 const key=drKey(body.key);
 if(!key||typeof body.pin!=='string'||!DR_PIN.test(body.pin)||typeof body.idempotencyKey!=='string'||!DR_IDEMPOTENCY.test(body.idempotencyKey))return drRefused('invalid_request',400);
 if(body.accepted!==true)return drRefused('confirmation_missing',400);
 const {bucket,versions}=drReadOnly(env.BUCKET);
 const observed=await drObserve(bucket,versions,key,Date.now(),null,env);
 if(observed.pin!==body.pin)return drRefused('stale_pin',409,{pin:observed.pin});
 if(observed.preview.status!=='eligible')return drRefused('not_eligible',409,{pin:observed.pin,reason:observed.assessment?.execute?.reason??observed.preview.reason});
 const issued=AdminActions.confirmAction(observed.preview,{now:observed.now,idempotencyKey:body.idempotencyKey,accepted:true});
 if(issued.error)return drRefused(issued.error,409);
 const record={schemaVersion:1,kind:'discovery_reconsider_action',idempotencyKey:body.idempotencyKey,state:'approved',issued,createdAt:observed.now,startedAt:null,finishedAt:null,
  provenance:{actor:'owner',authority:'cloudflare_access',programmeRunId:observed.index.programmeRunId,manifestEtag:observed.index.manifestEtag,observationKey:key},
  beforeImage:null,afterImage:null,receipt:null,index:null};
 const saved=await drActionWrite(env,body.idempotencyKey,record,null);
 if(saved===null)return drRefused('idempotency_conflict',409);
 return json({confirmation:issued,preview:drPreviewView(observed.preview,observed.assessment)});
}

// Refreshes the one index record the action changed, then the manifest, each behind the fence and each a compare-and-swap.
// Best effort: when it does not land, the manifest still names the old resolution etag and every reader sees a stale index
// until the next chunk rewrites it.
async function drRefreshIndex(env,run,key,decision,decisionHash,resolutionEtag,fence,idempotencyKey){
 const manifestObject=await env.BUCKET.get(DiscoveryIndex.observationIndexManifestKey(run));
 const read=DiscoveryIndex.readObservationIndexManifest(manifestObject?await manifestObject.json():null,run);
 if(!read.ok)return {refreshed:false,reason:read.state};
 const shard=DiscoveryIndex.observationShard(key),shardObject=await env.BUCKET.get(DiscoveryIndex.observationIndexShardKey(run,shard));
 const current=DiscoveryIndex.readObservationIndexShard(shardObject?await shardObject.json():null,read.manifest,shard);
 if(!current.ok)return {refreshed:false,reason:current.state};
 if(!shardObject||!current.items.some(item=>item.key===key))return {refreshed:false,reason:'record_absent'};
 const items=current.items.map(item=>item.key===key?{...item,decision:DiscoveryIndex.observationDecisionView(decision),decisionHash}:item);
 const revision=await discoveryDigest(DiscoveryIndex.canonicalJson(items));
 if(!await fence())return {refreshed:false,reason:'fence_lost'};
 const savedShard=await observationShardPut(env,run,shard,items,revision,{onlyIf:{etagMatches:shardObject.etag}});
 if(savedShard===null)return {refreshed:false,reason:'shard_changed'};
 const ledger=await env.BUCKET.head(epgGenerationKey(run,'discovery-latest.json'));
 if(!ledger?.etag)return {refreshed:false,reason:'source_unread'};
 const manifest=read.manifest;
 const next=DiscoveryIndex.observationIndexManifest({programmeRunId:run,writtenAt:new Date().toISOString(),writer:{kind:'discovery_reconsider',idempotencyKey},sources:{resolutionEtag,ledgerEtag:ledger.etag},shards:manifest.shards.map((entry,index)=>index===shard?{items:items.length,revision}:{items:entry.items,revision:entry.revision}),coverage:manifest.coverage,counts:manifest.counts});
 if(!await fence())return {refreshed:false,reason:'fence_lost'};
 const savedManifest=await env.BUCKET.put(DiscoveryIndex.observationIndexManifestKey(run),JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:manifestObject.etag}});
 return savedManifest===null?{refreshed:false,reason:'manifest_changed'}:{refreshed:true,reason:null};
}

// The execution, in this order: replay of a stored receipt; the resolver lease; a fresh read under it checked against the
// issued confirmation (pin, record digest, eligibility, expiry, access); the full decision read with the map's etag and
// compared by digest; the intent (`running`, with the before-image) stored by compare-and-swap; the fence; the map written
// by compare-and-swap on the etag it was read at; a read-back of the decision; the index refresh; the final receipt. A
// lost lease, a lost compare-and-swap or a write whose outcome cannot be read back never claims success: the receipt is
// `aborted`, `failed` or `unknown`. A stored `running` intent without a receipt is reported as unknown and never redone.
async function drExecute(request,env,url){
 const principal=drPrincipal(request,url);
 if(!principal.owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 const confirmation=body?.confirmation;
 const submitted=AdminActions.validateConfirmation(confirmation);
 if(!submitted)return drRefused('invalid_request',400);
 if(!DR_REGISTRY.get(submitted.capability,submitted.version))return drRefused('unsupported_capability',400);
 const stored=await drActionRead(env,submitted.idempotencyKey);
 if(!stored.record)return drRefused('confirmation_missing',409);
 if(stored.record.receipt)return json({replayed:true,receipt:stored.record.receipt,state:stored.record.state});
 if(stored.record.state==='running')return drRefused('in_progress',409,{state:'unknown',note:'An earlier submission with this key started and left no receipt. Its outcome is unknown: read the observation again; nothing is retried.'});
 const held=await drJson(env.BUCKET,DISCOVERY_LEASE_KEY);
 if(held.status==='unavailable')return drRefused('storage_unavailable',503);
 if(held.status==='recorded'&&!drLeaseReadable(held.value))return drRefused('lease_unknown',409);
 const lease=await acquireDiscoveryLease(env);
 if(!lease)return drRefused('lease_held',409);
 const startedAt=new Date().toISOString(),key=submitted.subject.id;
 let action=stored;
 const finish=async(fields,outcomes,options={})=>{
  const receipt=AdminActions.receiptOf({confirmation,capability:DR_CAPABILITY,startedAt,finishedAt:new Date().toISOString(),outcomes,aborted:options.aborted===true,refusal:options.refusal||null});
  const record={...action.record,...fields,state:receipt.state,finishedAt:receipt.finishedAt,receipt};
  let durable=false;
  try{durable=await drActionWrite(env,submitted.idempotencyKey,record,action.etag)!==null;}catch{durable=false;}
  return json({replayed:false,receipt,durable,state:receipt.state,index:record.index??null,...(receipt.refusal?{refusal:receipt.refusal}:{})},receipt.state==='refused'?409:200);
 };
 try{
  const {bucket,versions}=drReadOnly(env.BUCKET);
  const observed=await drObserve(bucket,versions,key,Date.now(),lease.id);
  const fresh={pin:observed.pin,now:observed.now,records:observed.record?[{id:key,version:observed.record.decisionHash}]:[],issues:observed.assessment&&!observed.assessment.error?[DiscoveryRecovery.reconsiderIssue(observed.assessment)]:[]};
  const check=AdminActions.checkSubmission(DR_REGISTRY,confirmation,fresh,{principal,issued:stored.record.issued});
  if(!check.ok)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:check.refusal});
  const mapObject=await env.BUCKET.get(DR_RESOLUTION_KEY);
  if(!mapObject||mapObject.etag!==observed.index.resolutionEtag)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:'record_changed'});
  const decisions=await mapObject.json(),previous=decisions?.[key];
  if(!previous||typeof previous!=='object'||await discoveryDigest(DiscoveryIndex.canonicalJson(previous))!==observed.record.decisionHash)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:'record_changed'});
  const next=DiscoveryRecovery.reconsideredDecision(previous,{at:startedAt,idempotencyKey:submitted.idempotencyKey});
  const nextHash=await discoveryDigest(DiscoveryIndex.canonicalJson(next));
  const beforeImage={resolutionEtag:mapObject.etag,decisionHash:observed.record.decisionHash,decision:previous};
  const intent={...action.record,state:'running',startedAt,beforeImage,afterImage:{resolutionEtag:null,decisionHash:nextHash,decision:next}};
  const opened=await drActionWrite(env,submitted.idempotencyKey,intent,action.etag);
  if(opened===null)return drRefused('in_progress',409,{state:'unknown'});
  action={record:intent,etag:opened.etag};
  if(!await renewDiscoveryLease(env,lease))return await finish({},[{id:key,outcome:'not_attempted',error:'fence_lost'}],{aborted:true});
  let written;
  try{written=await env.BUCKET.put(DR_RESOLUTION_KEY,JSON.stringify({...decisions,[key]:next}),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:mapObject.etag}});}
  catch{return await finish({},[{id:key,outcome:'unknown',error:'storage_error'}]);}
  if(written===null)return await finish({},[{id:key,outcome:'skipped_changed',error:'conflict'}]);
  let landed=false;
  try{const again=await env.BUCKET.get(DR_RESOLUTION_KEY),value=again?await again.json():null;landed=!!value?.[key]&&await discoveryDigest(DiscoveryIndex.canonicalJson(value[key]))===nextHash;}
  catch{landed=false;}
  if(!landed)return await finish({},[{id:key,outcome:'unknown',error:'storage_error'}]);
  const resolutionEtag=written.etag??null;
  let index={refreshed:false,reason:'source_unread'};
  if(resolutionEtag){try{index=await drRefreshIndex(env,observed.index.programmeRunId,key,next,nextHash,resolutionEtag,()=>renewDiscoveryLease(env,lease),submitted.idempotencyKey);}catch{index={refreshed:false,reason:'error'};}}
  return await finish({afterImage:{resolutionEtag,decisionHash:nextHash,decision:next},index},[{id:key,outcome:'written'}]);
 }finally{await releaseDiscoveryLease(env,lease);}
}

async function drReceipt(env,url){
 const idempotencyKey=url.searchParams.get('idempotencyKey');
 if(!idempotencyKey||!DR_IDEMPOTENCY.test(idempotencyKey))return adminError('invalid_request',400);
 const {bucket}=drReadOnly(env.BUCKET);
 let object;
 try{object=await bucket.get(drActionKey(idempotencyKey));}catch{return adminError('storage_unavailable',503);}
 if(!object)return adminError('not_found',404);
 const record=await object.json();
 const state=record?.receipt?record.state:record?.state==='running'?'unknown':record?.state??'unknown';
 return json({idempotencyKey,state,record});
}

function diPrincipal(request,url){
 const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
 const type=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 return {owner:typeof assertion==='string'&&assertion.length>0&&assertion.length<=8192&&request.headers.get('Origin')===url.origin&&request.headers.get('X-IPTV-Admin-Action')==='discovery_identity_correct'&&type==='application/json'};
}
function diActionKey(idempotencyKey){return DI_ACTION_PREFIX+idempotencyKey+'.json';}
async function diCatalogFilm(env,tmdbId){
 try{
  const object=await env.BUCKET.get(DI_CATALOG_KEY);
  if(!object)return {status:'absent',film:null};
  const catalog=await object.json();
  const film=catalog&&typeof catalog==='object'&&!Array.isArray(catalog)?catalog['tmdb_'+tmdbId]??null:null;
  return {status:'recorded',film:film&&typeof film==='object'&&!Array.isArray(film)?film:null};
 }catch{return {status:'unavailable',film:undefined};}
}
function diPlan(record,command){
 const decision=record?.decision||{};
 const before={status:decision.status??null,tmdbId:decision.tmdbId??null,rejectedTmdbIds:decision.rejectedTmdbIds||[]};
 const after=command.effect==='assign'
  ?{status:'verified',tmdbId:command.tmdbId,filmId:'tmdb_'+command.tmdbId,rejectedTmdbIds:(decision.rejectedTmdbIds||[]).filter(id=>id!==command.tmdbId)}
  :{status:decision.status==='verified'?'needs_verification':decision.status??'needs_verification',tmdbId:decision.tmdbId===command.tmdbId?null:decision.tmdbId??null,rejectedTmdbIds:[...new Set([...(decision.rejectedTmdbIds||[]),command.tmdbId])]};
 return {before,after};
}
function diIndexLayout(scope){
 const verified=scope===DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE;
 return {scope:verified?DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE:DiscoveryIndex.OBSERVATION_INDEX_SCOPE,manifestKey:verified?DiscoveryIndex.observationVerifiedManifestKey:DiscoveryIndex.observationIndexManifestKey,shardKey:verified?DiscoveryIndex.observationVerifiedShardKey:DiscoveryIndex.observationIndexShardKey};
}
function diCoverageShift(coverage,delta){
 if(!coverage||typeof coverage!=='object')return coverage;
 const next={...coverage};
 if(Number.isInteger(next.indexed))next.indexed=Math.max(0,next.indexed+delta);
 if(Number.isInteger(next.eligible))next.eligible=Math.max(0,next.eligible+delta);
 if(Number.isInteger(next.indexed)&&Number.isInteger(next.eligible))next.complete=next.indexed===next.eligible;
 return next;
}
async function diLoadScoped(env,run,layout){
 const manifestObject=await env.BUCKET.get(layout.manifestKey(run));
 const read=DiscoveryIndex.readObservationIndexManifest(manifestObject?await manifestObject.json():null,run,layout.scope);
 if(!read.ok)return {ok:false,reason:read.state};
 return {ok:true,manifest:read.manifest,manifestObject};
}
async function diCommitShard(env,run,layout,loaded,shard,items,resolutionEtag,fence,idempotencyKey,coverage,shardObject){
 const revision=await discoveryDigest(DiscoveryIndex.canonicalJson(items));
 if(!await fence())return {refreshed:false,reason:'fence_lost'};
 const savedShard=await observationShardPut(env,run,shard,items,revision,{shardKey:layout.shardKey(run,shard),onlyIf:shardObject?{etagMatches:shardObject.etag}:{etagDoesNotMatch:'*'}});
 if(savedShard===null)return {refreshed:false,reason:'shard_changed'};
 const ledger=await env.BUCKET.head(epgGenerationKey(run,'discovery-latest.json'));
 if(!ledger?.etag)return {refreshed:false,reason:'source_unread'};
 const next=DiscoveryIndex.observationIndexManifest({programmeRunId:run,writtenAt:new Date().toISOString(),writer:{kind:'discovery_identity_correct',idempotencyKey},sources:{resolutionEtag,ledgerEtag:ledger.etag},shards:loaded.manifest.shards.map((entry,index)=>index===shard?{items:items.length,revision}:{items:entry.items,revision:entry.revision}),coverage,counts:loaded.manifest.counts});
 if(!await fence())return {refreshed:false,reason:'fence_lost'};
 const savedManifest=await env.BUCKET.put(layout.manifestKey(run),JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:loaded.manifestObject.etag}});
 return savedManifest===null?{refreshed:false,reason:'manifest_changed'}:{refreshed:true,reason:null};
}
// Names the new resolution etag on an index whose row did not move, so that index is not left stale by this write.
async function diRetarget(env,run,layout,resolutionEtag,fence,idempotencyKey){
 const loaded=await diLoadScoped(env,run,layout);
 if(!loaded.ok)return {refreshed:false,reason:loaded.reason};
 if(loaded.manifest.sources?.resolutionEtag===resolutionEtag)return {refreshed:true,reason:null};
 const ledger=await env.BUCKET.head(epgGenerationKey(run,'discovery-latest.json'));
 if(!ledger?.etag)return {refreshed:false,reason:'source_unread'};
 const next=DiscoveryIndex.observationIndexManifest({programmeRunId:run,writtenAt:new Date().toISOString(),writer:{kind:'discovery_identity_correct',idempotencyKey},sources:{resolutionEtag,ledgerEtag:ledger.etag},shards:loaded.manifest.shards.map(entry=>({items:entry.items,revision:entry.revision})),coverage:loaded.manifest.coverage,counts:loaded.manifest.counts});
 if(!await fence())return {refreshed:false,reason:'fence_lost'};
 const saved=await env.BUCKET.put(layout.manifestKey(run),JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:loaded.manifestObject.etag}});
 return saved===null?{refreshed:false,reason:'manifest_changed'}:{refreshed:true,reason:null};
}
async function diInsertRecord(env,run,layout,key,record,resolutionEtag,fence,idempotencyKey){
 const loaded=await diLoadScoped(env,run,layout);
 if(!loaded.ok)return {refreshed:false,reason:loaded.reason};
 if(loaded.manifest.coverage?.complete!==true)return diRetarget(env,run,layout,resolutionEtag,fence,idempotencyKey);
 const shard=DiscoveryIndex.observationShard(key);
 const shardObject=await env.BUCKET.get(layout.shardKey(run,shard));
 const current=DiscoveryIndex.readObservationIndexShard(shardObject?await shardObject.json():null,loaded.manifest,shard);
 if(!current.ok)return {refreshed:false,reason:current.state};
 if(current.items.some(item=>item.key===key))return diCommitShard(env,run,layout,loaded,shard,current.items.map(item=>item.key===key?record:item),resolutionEtag,fence,idempotencyKey,loaded.manifest.coverage,shardObject);
 const items=[...current.items,record].sort((left,right)=>String(left.key).localeCompare(String(right.key),'en'));
 return diCommitShard(env,run,layout,loaded,shard,items,resolutionEtag,fence,idempotencyKey,diCoverageShift(loaded.manifest.coverage,1),shardObject);
}
// Moves the one key between the unresolved and verified indexes, or updates it in place. A verified decision leaves
// the unresolved shard and is inserted into the verified shard when that index is complete. A rejection of a verified
// decision does the reverse. Coverage counts move together so the manifest sum still matches. The other index, when
// it exists, is retargeted at the new resolution etag. Best effort: a failed refresh leaves that index stale.
async function diRefreshIndex(env,run,key,sourceRecord,sourceScope,decision,decisionHash,resolutionEtag,fence,idempotencyKey){
 const source=diIndexLayout(sourceScope);
 const loaded=await diLoadScoped(env,run,source);
 if(!loaded.ok)return {refreshed:false,reason:loaded.reason};
 const shard=DiscoveryIndex.observationShard(key);
 const shardObject=await env.BUCKET.get(source.shardKey(run,shard));
 const current=DiscoveryIndex.readObservationIndexShard(shardObject?await shardObject.json():null,loaded.manifest,shard);
 if(!current.ok)return {refreshed:false,reason:current.state};
 if(!current.items.some(item=>item.key===key))return {refreshed:false,reason:'record_absent'};
 const leaving=source.scope===DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE?decision?.status!=='verified':decision?.status==='verified';
 const view=DiscoveryIndex.observationDecisionView(decision);
 const items=leaving?current.items.filter(item=>item.key!==key):current.items.map(item=>item.key===key?{...item,decision:view,decisionHash}:item);
 const edited=await diCommitShard(env,run,source,loaded,shard,items,resolutionEtag,fence,idempotencyKey,leaving?diCoverageShift(loaded.manifest.coverage,-1):loaded.manifest.coverage,shardObject);
 if(!edited.refreshed)return edited;
 const other=diIndexLayout(source.scope===DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE?DiscoveryIndex.OBSERVATION_INDEX_SCOPE:DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE);
 let companion={refreshed:false};
 try{
  if(leaving){
   const nextRecord={...sourceRecord,programmeRunId:run,decision:view,decisionHash};
   delete nextRecord.indexScope;
   companion=await diInsertRecord(env,run,other,key,nextRecord,resolutionEtag,fence,idempotencyKey);
  }else companion=await diRetarget(env,run,other,resolutionEtag,fence,idempotencyKey);
 }catch{companion={refreshed:false,reason:'error'};}
 return {refreshed:true,reason:null,removed:leaving,companion:companion.refreshed===true};
}
async function diConfirm(request,env,url){
 if(!diPrincipal(request,url).owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 if(!body)return drRefused('invalid_request',400);
 const key=drKey(body.key);
 if(!key||typeof body.pin!=='string'||!DR_PIN.test(body.pin)||typeof body.idempotencyKey!=='string'||!DR_IDEMPOTENCY.test(body.idempotencyKey))return drRefused('invalid_request',400);
 if(body.accepted!==true)return drRefused('confirmation_missing',400);
 const {bucket,versions}=drReadOnly(env.BUCKET);
 const observed=await drObserve(bucket,versions,key,Date.now(),null,env);
 if(observed.pin!==body.pin)return drRefused('stale_pin',409,{pin:observed.pin,reason:'stale_pin'});
 const offer=observed.identity;
 if(!offer?.available)return drRefused('not_eligible',409,{pin:observed.pin,reason:offer?.reason||'not_eligible'});
 const film=body.effect==='assign'?await diCatalogFilm(env,typeof body.tmdbId==='string'?body.tmdbId:String(body.tmdbId??'')):{status:'recorded',film:null};
 if(film.status==='unavailable')return drRefused('not_eligible',409,{pin:observed.pin,reason:'catalogue_unread'});
 const command=DiscoveryIdentity.identityCommand(observed.record,body,film.film);
 if(!command.ok)return drRefused('not_eligible',409,{pin:observed.pin,reason:command.reason});
 const version=DiscoveryIdentity.identityVersion(observed.record.decisionHash,command.effect,command.tmdbId);
 const issue=DiscoveryIdentity.identityIssue(key,offer,command);
 const preview=AdminActions.previewAction(DR_REGISTRY,{capability:DI_CAPABILITY.id,version:DI_CAPABILITY.version,subject:{kind:'observation',id:key},pin:observed.pin,ids:[key]},{pin:observed.pin,now:observed.now,records:[{id:key,version}],issues:[issue]});
 const issued=AdminActions.confirmAction(preview,{now:observed.now,idempotencyKey:body.idempotencyKey,accepted:true});
 if(issued.error)return drRefused(issued.error,409,{pin:observed.pin,reason:command.reason});
 const application=DiscoveryIdentity.identityApplication(command.effect,offer,command);
 const plan=diPlan(observed.record,command);
 const record={schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:body.idempotencyKey,state:'approved',issued,command:{effect:command.effect,tmdbId:command.tmdbId,basis:command.basis},application,plan,createdAt:observed.now,startedAt:null,finishedAt:null,
  provenance:{actor:'owner',authority:'cloudflare_access',programmeRunId:observed.index.programmeRunId,manifestEtag:observed.index.manifestEtag,observationKey:key},
  beforeImage:null,afterImage:null,receipt:null,index:null};
 const saved=await env.BUCKET.put(diActionKey(body.idempotencyKey),JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});
 if(saved===null)return drRefused('idempotency_conflict',409);
 return json({confirmation:issued,command:{effect:command.effect,tmdbId:command.tmdbId,basis:command.basis},plan,application,scope:{key,programmeRunId:observed.index.programmeRunId,decisionHash:observed.record.decisionHash}});
}
function diReceiptBody(record,extra){
 return {replayed:extra.replayed===true,reconciled:extra.reconciled===true,receipt:record.receipt,durable:true,state:record.state,application:record.application??null,index:record.index??null};
}
async function diReadAction(env,idempotencyKey){
 try{const object=await env.BUCKET.get(diActionKey(idempotencyKey));return object?{record:await object.json(),etag:object.etag}:{record:null,etag:null};}
 catch{return {record:null,etag:null,error:true};}
}
function diUnstoredBody(record){
 return json({replayed:false,durable:false,state:'unknown',receipt:null,decisionReadBack:true,application:record?.application??null,index:record?.index??null,error:'receipt_unstored',refusal:'in_progress',note:'The decision read back, but the owner receipt was not stored. Retrying this confirmation records the receipt only and does not write the decision again.'},409);
}
async function diUnstoredReceipt(env,submitted,confirmation,record){
 const again=await diReadAction(env,submitted.idempotencyKey);
 if(again.record?.receipt&&again.record.issued?.scopeKey===confirmation.scopeKey)return json(diReceiptBody(again.record,{replayed:true}));
 return diUnstoredBody(record);
}
// The decision already matches the stored after-image. Persist the receipt only. A second map put is not attempted.
async function diReconcileRunning(env,stored,confirmation,submitted){
 const key=submitted.subject.id;
 const afterHash=typeof stored.record.afterImage?.decisionHash==='string'?stored.record.afterImage.decisionHash:null;
 if(!afterHash)return drRefused('in_progress',409,{state:'unknown',note:'An earlier submission with this key started and left no receipt. Its outcome is unknown: read the observation again; nothing is retried.'});
 let map;
 try{map=await env.BUCKET.get(DR_RESOLUTION_KEY);}catch{return drRefused('storage_unavailable',503);}
 const decisions=map?await map.json():null;
 const current=decisions&&typeof decisions==='object'&&!Array.isArray(decisions)?decisions[key]:null;
 const digest=current&&typeof current==='object'&&!Array.isArray(current)?await discoveryDigest(DiscoveryIndex.canonicalJson(current)):null;
 if(digest!==afterHash)return drRefused('in_progress',409,{state:'unknown',note:'An earlier submission started and the decision did not read back as that submission. Nothing is written again.'});
 const receipt=AdminActions.receiptOf({confirmation,capability:DI_CAPABILITY,startedAt:stored.record.startedAt||new Date().toISOString(),finishedAt:new Date().toISOString(),outcomes:[{id:key,outcome:'written'}]});
 const record={...stored.record,state:receipt.state,finishedAt:receipt.finishedAt,receipt};
 let saved=null;
 try{saved=await env.BUCKET.put(diActionKey(submitted.idempotencyKey),JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:stored.etag?{etagMatches:stored.etag}:{etagDoesNotMatch:'*'}});}catch{saved=null;}
 if(saved!==null)return json({replayed:false,reconciled:true,receipt,durable:true,state:receipt.state,application:record.application??null,index:record.index??null});
 return diUnstoredReceipt(env,submitted,confirmation,stored.record);
}
async function diExecute(request,env,url){
 if(!diPrincipal(request,url).owner)return drRefused('access_denied',403);
 const body=await drBody(request);
 const confirmation=body?.confirmation;
 const submitted=AdminActions.validateConfirmation(confirmation);
 if(!submitted||submitted.capability!==DI_CAPABILITY.id)return drRefused(submitted? 'unsupported_capability':'invalid_request',400);
 const parsed=DiscoveryIdentity.parseIdentityVersion(submitted.records[0]?.version);
 if(!parsed)return drRefused('invalid_request',400);
 const object=await env.BUCKET.get(diActionKey(submitted.idempotencyKey));
 const stored=object?{record:await object.json(),etag:object.etag}:{record:null,etag:null};
 if(!stored.record)return drRefused('confirmation_missing',409);
 if(stored.record.receipt){
  if(stored.record.issued?.scopeKey!==confirmation.scopeKey)return drRefused('idempotency_conflict',409);
  return json({replayed:true,receipt:stored.record.receipt,state:stored.record.state,application:stored.record.application??null,index:stored.record.index??null});
 }
 if(stored.record.state==='running')return await diReconcileRunning(env,stored,confirmation,submitted);
 const command=stored.record.command;
 if(!command||command.effect!==parsed.effect||command.tmdbId!==parsed.tmdbId)return drRefused('confirmation_mismatch',409);
 const held=await drJson(env.BUCKET,DISCOVERY_LEASE_KEY);
 if(held.status==='unavailable')return drRefused('storage_unavailable',503);
 if(held.status==='recorded'&&!drLeaseReadable(held.value))return drRefused('lease_unknown',409);
 const lease=await acquireDiscoveryLease(env);
 if(!lease)return drRefused('lease_held',409);
 const startedAt=new Date().toISOString(),key=submitted.subject.id;
 let action=stored;
 const finish=async(fields,outcomes,options={})=>{
  const receipt=AdminActions.receiptOf({confirmation,capability:DI_CAPABILITY,startedAt,finishedAt:new Date().toISOString(),outcomes,aborted:options.aborted===true,refusal:options.refusal||null});
  const record={...action.record,...fields,state:receipt.state,finishedAt:receipt.finishedAt,receipt};
  let saved=null;
  try{saved=await env.BUCKET.put(diActionKey(submitted.idempotencyKey),JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:action.etag?{etagMatches:action.etag}:{etagDoesNotMatch:'*'}});}catch{saved=null;}
  if(saved===null&&receipt.state==='succeeded')return await diUnstoredReceipt(env,submitted,confirmation,record);
  return json({replayed:false,receipt,durable:saved!==null,state:receipt.state,application:record.application??null,index:record.index??null,reason:options.reason||null,...(receipt.refusal?{refusal:receipt.refusal}:{})},receipt.state==='refused'?409:200);
 };
 try{
  const {bucket,versions}=drReadOnly(env.BUCKET);
  const observed=await drObserve(bucket,versions,key,Date.now(),lease.id,env);
  const film=command.effect==='assign'?await diCatalogFilm(env,command.tmdbId):{status:'recorded',film:null};
  const decided=film.status==='unavailable'?{ok:false,reason:'catalogue_unread'}:DiscoveryIdentity.identityCommand(observed.record,command,film.film);
  const offer=observed.identity;
  const version=observed.record?DiscoveryIdentity.identityVersion(observed.record.decisionHash,command.effect,command.tmdbId):null;
  const issue=DiscoveryIdentity.identityIssue(key,offer,decided.ok&&version===submitted.records[0].version?decided:{ok:false,reason:decided.reason||'record_changed'});
  const fresh={pin:observed.pin,now:observed.now,records:version?[{id:key,version}]:[],issues:[issue]};
  const check=AdminActions.checkSubmission(DR_REGISTRY,confirmation,fresh,{principal:{owner:true},issued:stored.record.issued});
  if(!check.ok)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:check.refusal,reason:decided.reason||check.refusal});
  if(!decided.ok)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:'not_eligible',reason:decided.reason});
  const mapObject=await env.BUCKET.get(DR_RESOLUTION_KEY);
  if(!mapObject||mapObject.etag!==observed.index.resolutionEtag)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:'record_changed',reason:'record_changed'});
  const decisions=await mapObject.json(),previous=decisions?.[key];
  if(!previous||typeof previous!=='object'||await discoveryDigest(DiscoveryIndex.canonicalJson(previous))!==observed.record.decisionHash||parsed.decisionHash!==observed.record.decisionHash)return await finish({startedAt},[{id:key,outcome:'not_attempted'}],{refusal:'record_changed',reason:'record_changed'});
  const next=DiscoveryIdentity.appliedIdentityDecision(previous,decided,{at:startedAt,requestId:submitted.idempotencyKey,programmeRunId:observed.index.programmeRunId});
  const nextHash=await discoveryDigest(DiscoveryIndex.canonicalJson(next));
  const application=DiscoveryIdentity.identityApplication(decided.effect,offer,decided);
  const beforeImage={resolutionEtag:mapObject.etag,decisionHash:observed.record.decisionHash,decision:previous};
  const intent={...action.record,state:'running',startedAt,application,beforeImage,afterImage:{resolutionEtag:null,decisionHash:nextHash,decision:next}};
  const opened=await env.BUCKET.put(diActionKey(submitted.idempotencyKey),JSON.stringify(intent),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:action.etag}});
  if(opened===null)return drRefused('in_progress',409,{state:'unknown'});
  action={record:intent,etag:opened.etag};
  if(!await renewDiscoveryLease(env,lease))return await finish({},[{id:key,outcome:'not_attempted',error:'fence_lost'}],{aborted:true});
  let written;
  try{written=await env.BUCKET.put(DR_RESOLUTION_KEY,JSON.stringify({...decisions,[key]:next}),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:mapObject.etag}});}
  catch{return await finish({},[{id:key,outcome:'unknown',error:'storage_error'}]);}
  if(written===null)return await finish({},[{id:key,outcome:'skipped_changed',error:'conflict'}]);
  let landed=false;
  try{const again=await env.BUCKET.get(DR_RESOLUTION_KEY),value=again?await again.json():null;landed=!!value?.[key]&&await discoveryDigest(DiscoveryIndex.canonicalJson(value[key]))===nextHash;}
  catch{landed=false;}
  if(!landed)return await finish({},[{id:key,outcome:'unknown',error:'storage_error'}]);
  const resolutionEtag=written.etag??null;
  let index={refreshed:false,reason:'source_unread'};
  if(resolutionEtag){try{index=await diRefreshIndex(env,observed.index.programmeRunId,key,observed.record,observed.index.indexScope,next,nextHash,resolutionEtag,()=>renewDiscoveryLease(env,lease),submitted.idempotencyKey);}catch{index={refreshed:false,reason:'error'};}}
  return await finish({afterImage:{resolutionEtag,decisionHash:nextHash,decision:next},application,index},[{id:key,outcome:'written'}]);
 }finally{await releaseDiscoveryLease(env,lease);}
}
async function diReceipt(env,url){
 const idempotencyKey=url.searchParams.get('idempotencyKey');
 if(!idempotencyKey||!DR_IDEMPOTENCY.test(idempotencyKey))return adminError('invalid_request',400);
 const {bucket}=drReadOnly(env.BUCKET);
 let object;
 try{object=await bucket.get(diActionKey(idempotencyKey));}catch{return adminError('storage_unavailable',503);}
 if(!object)return adminError('not_found',404);
 const record=await object.json();
 const state=record?.receipt?record.state:record?.state==='running'?'unknown':record?.state??'unknown';
 return json({idempotencyKey,state,record});
}

async function adminDiscoveryReconsiderRoute(request,env,url){
 const action=url.pathname.slice('/api/admin/discovery-recovery/'.length);
 if(action==='receipt')return request.method==='GET'?await drReceipt(env,url):adminError('method_not_allowed',405);
 if(action==='identity-receipt')return request.method==='GET'?await diReceipt(env,url):adminError('method_not_allowed',405);
 if(action==='identity-confirm'||action==='identity-correct'){
  if(request.method!=='POST')return adminError('method_not_allowed',405);
  try{return action==='identity-confirm'?await diConfirm(request,env,url):await diExecute(request,env,url);}
  catch{return drRefused('storage_unavailable',503);}
 }
 if(action!=='confirm'&&action!=='reconsider')return adminError('not_found',404);
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 try{return action==='confirm'?await drConfirm(request,env,url):await drExecute(request,env,url);}
 catch{return drRefused('storage_unavailable',503);}
}
