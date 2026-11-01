// Owner-only recovery of one discovery observation behind the existing Cloudflare Access application.
//   GET  /api/admin/discovery-recovery?key=<observation key>[&pin=]   read-only assessment and action preview
//   POST /api/admin/discovery-recovery/confirm                          server-issued confirmation of one exact scope
//   POST /api/admin/discovery-recovery/reconsider                       the guarded write discovery_reconsider@1
//   GET  /api/admin/discovery-recovery/receipt?idempotencyKey=<key>     the stored action record and its receipt
// Every read of the observation comes from the generation-scoped observation index (src/domain/discovery-observation-index.js),
// never from the discovery ledger or the body of the resolution map; the GET routes get a bucket that has nothing but `get`
// and `head`, so they cannot write, list or delete. Nothing here calls TMDB, runs a chunk, starts a series or dispatches
// work. The one write lifts the terminal fence of one decision in the resolution map under the resolver lease, an etag
// compare-and-swap and the decision's own digest; the next ordinary resolver chunk then decides what happens to it.
// Contracts: docs/reference/api/admin.md (routes), docs/reference/api/admin-actions.md (the action),
// docs/reference/domain/discovery-recovery.md (the assessment).
const DR_RESOLUTION_KEY='epg/discovery-resolution.json',DR_STATUS_KEY='epg/discovery-status.json',DR_CONTINUATION_KEY='epg/resolver-continuation.json';
const DR_ACTION_PREFIX='admin/actions/discovery_reconsider/v1/';
const DR_PIN=/^D1\.[0-9a-f]{32}$/,DR_IDEMPOTENCY=/^[A-Za-z0-9_-]{16,80}$/,DR_BODY_MAX=16384;
const DR_CAPABILITY=AdminActions.defineCapability({
 id:'discovery_reconsider',version:1,title:'Reconsider one terminal discovery observation',
 subjectKinds:['observation'],healthActionCode:'discovery_reconsider',
 budget:{maxRecords:1,maxWritesPerRecord:1,externalCallsPerRecord:0},retry:{maxAttempts:1,backoffMs:0},
 compensation:{kind:'manual',guidance:'No automatic undo. The action record keeps the before-image of the decision; the next ordinary uncertain outcome on the same evidence makes the observation terminal again.'},
 confirmTtlMs:10*60000,
});
const DR_REGISTRY=AdminActions.createRegistry([DR_CAPABILITY]);

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

// The observation index of the published generation as one reader sees it now. With `key`, only the shard that can hold
// that key is read; without it, every shard that has records. `cached` (an earlier result of this function) is reused,
// and the manifest body cancelled, when the manifest etag has not changed. The resolution map and the generation ledger
// are compared by `head` only.
async function discoveryIndexRead(bucket,options={}){
 let run=null,authoritative=false;
 if(options.env&&typeof PublishedEpg!=='undefined'&&typeof PublishedEpg.currentGeneration==='function'){
  const live=await PublishedEpg.currentGeneration(options.env);
  if(live){authoritative=true;run=live.phase==='published'&&typeof live.programmeRunId==='string'&&live.programmeRunId?live.programmeRunId:null;}
 }
 if(!authoritative){
  const pointer=await bucket.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
  run=generation?.phase==='published'&&typeof generation.programmeRunId==='string'&&generation.programmeRunId?generation.programmeRunId:null;
 }
 const base={programmeRunId:run,manifest:null,manifestEtag:null,records:[],reasons:[]};
 if(!run)return {...base,state:'unavailable',reasons:['no_published_generation']};
 const object=await bucket.get(DiscoveryIndex.observationIndexManifestKey(run));
 const manifestEtag=object?String(object.etag??''):null;
 const cached=options.key===undefined&&options.cached&&options.cached.manifestEtag&&options.cached.manifestEtag===manifestEtag&&options.cached.manifest?.programmeRunId===run?options.cached:null;
 let manifest,records;
 if(cached){await adminDiscardBody(object);manifest=cached.manifest;records=cached.records;}
 else{
  const read=DiscoveryIndex.readObservationIndexManifest(object?await object.json():null,run);
  if(!read.ok)return {...base,manifestEtag,state:read.state};
  manifest=read.manifest;
  records=[];
  const wanted=options.key!==undefined?[DiscoveryIndex.observationShard(options.key)]:manifest.shards.map((shard,index)=>shard.items>0?index:null).filter(index=>index!==null);
  for(const index of wanted){
   const shardObject=await bucket.get(DiscoveryIndex.observationIndexShardKey(run,index));
   const shard=DiscoveryIndex.readObservationIndexShard(shardObject?await shardObject.json():null,manifest,index);
   if(!shard.ok)return {...base,manifest,manifestEtag,state:shard.state};
   records.push(...shard.items);
  }
 }
 const [resolution,ledger]=await Promise.all([bucket.head(DR_RESOLUTION_KEY),bucket.head(epgGenerationKey(run,'discovery-latest.json'))]);
 const freshness=DiscoveryIndex.observationIndexFreshness(manifest,{programmeRunId:run,resolutionEtag:resolution?.etag??null,ledgerEtag:ledger?.etag??null});
 return {...base,manifest,manifestEtag,records,state:freshness.state,reasons:freshness.reasons,resolutionEtag:resolution?.etag??null};
}
function drIndexView(index){
 const manifest=index.manifest;
 return {state:index.state,reasons:index.reasons,programmeRunId:index.programmeRunId,writtenAt:manifest?.writtenAt??null,writer:manifest?.writer?.kind??null,coverage:manifest?.coverage??null,counts:manifest?.counts??null};
}

// One observation judged now, from the index and the small coordination objects. `ownLeaseId` is the lease the executor
// holds: it is not another writer.
async function drObserve(bucket,versions,key,nowMs,ownLeaseId=null,env=null){
 const index=await discoveryIndexRead(bucket,{key,env});
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
 return {pin,now,index,record,assessment,preview,lease,continuation,status};
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
  const observed=await drObserve(bucket,versions,key,Date.now(),lease.id,env);
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

async function adminDiscoveryReconsiderRoute(request,env,url){
 const action=url.pathname.slice('/api/admin/discovery-recovery/'.length);
 if(action==='receipt')return request.method==='GET'?await drReceipt(env,url):adminError('method_not_allowed',405);
 if(action!=='confirm'&&action!=='reconsider')return adminError('not_found',404);
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 try{return action==='confirm'?await drConfirm(request,env,url):await drExecute(request,env,url);}
 catch{return drRefused('storage_unavailable',503);}
}
