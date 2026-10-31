// Owner-only Letterboxd archive preview behind the existing Cloudflare Access application (ADR 0066):
// POST /api/admin/letterboxd-archive/preview. The owner's browser sends the standard export ZIP as multipart form data;
// the Worker reads it in memory within this request (LetterboxdArchiveZip), parses the four CSV files with the offline
// parser (LetterboxdExport), matches them with the offline matcher (LetterboxdMatch) against single named R2 objects and
// computes, with the baseline import's own merge functions, what an import would do to each fact. Nothing is stored: the
// archive, its rows and the answer exist only in this request and its no-store response. The R2 reads go through a bucket
// that has nothing but `get`; no key is listed, and fact-record GETs, including a redirect hop, stay within
// PREVIEW_LIMITS.maxRecordReads. No outbound request is made and nothing is logged. This route does not write. A later
// confirmed apply lives in src/admin/letterboxd-archive-apply.js and is not started by a successful preview.
const LBA_PATH='/api/admin/letterboxd-archive/preview';
const LBA_FORM_OVERHEAD=64*1024,LBA_NAME_MAX=255,LBA_DECLARED_MAX=40;
const LBA_LID=/^[A-Za-z0-9_-]{1,80}$/,LBA_TMDB=/^[1-9]\d{0,11}$/;
// One preview at a time per isolate: a single worst-case preview needs about half of the isolate's memory (ADR 0066).
// The slot is a start time, not a flag: a request the runtime cancels never reaches `finally`, so a slot older than
// LBA_SLOT_MS is taken over.
const LBA_SLOT_MS=60000;
let LBA_ACTIVE_AT=0;
// Preview and apply share one slot: each holds the archive in memory, so they must not overlap on one isolate.
function lbaTrySlot(now){
 if(LBA_ACTIVE_AT&&now-LBA_ACTIVE_AT<LBA_SLOT_MS)return false;
 LBA_ACTIVE_AT=now;
 return true;
}
function lbaFreeSlot(token){if(LBA_ACTIVE_AT===token)LBA_ACTIVE_AT=0;}
const LBA_METADATA_KEY='metadata.json',LBA_RATINGS_POINTER_KEY='enrichment/ratings/published.json';
const lbaRatingsGenerationKey=id=>'enrichment/ratings/generations/'+encodeURIComponent(id)+'.json';
const lbaImportKey=(sha,kind)=>'letterboxd/imports/'+sha+'/chunks/0.'+kind+'.json';
// Not read, on purpose: each is several megabytes and contributes nothing to which films an import would accept.
const LBA_OMITTED={
 catalog:{key:'epg/generations/<run>/discovered-films.json',effect:'method_label_and_catalog_title_candidates'},
 viewIndex:{key:'enrichment/view-index.json',effect:'rating_evidence_only'},
};

function lbaReadOnly(env){
 const versions=new Map();
 const bucket={async get(key){
  let object;
  try{object=await env.BUCKET.get(key);}catch(error){versions.set(key,'unavailable');throw error;}
  versions.set(key,object?String(object.etag??'present'):'absent');
  return object;
 }};
 return {env:{...env,BUCKET:bucket},versions};
}
async function lbaRead(env,key){
 try{
  const object=await env.BUCKET.get(key);
  if(!object)return {evidence:'object_missing',value:null,etag:null};
  return {evidence:'observed',value:await object.json(),etag:typeof object.etag==='string'?object.etag:null};
 }catch{return {evidence:'unavailable',value:null,etag:null};}
}
// The version of a key now, without parsing it: a changed etag between the first read and this one is drift.
async function lbaVersion(env,key){
 try{
  const object=await env.BUCKET.get(key);
  if(!object)return 'absent';
  await adminDiscardBody(object);
  return typeof object.etag==='string'&&object.etag?object.etag:'present';
 }catch{return 'unavailable';}
}
async function lbaBody(request,max){
 if(!request.body)return new Uint8Array(0);
 const reader=request.body.getReader(),chunks=[];let total=0;
 for(;;){
  const {done,value}=await reader.read();
  if(done)break;
  total+=value.length;
  if(total>max){try{await reader.cancel();}catch{}return null;}
  chunks.push(value);
 }
 const out=new Uint8Array(total);let at=0;
 for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}
 return out;
}
function lbaUnprocessable(error,extra={}){return json({error,...extra},422);}
const lbaSummaryValue=summary=>summary&&typeof summary==='object'&&!Array.isArray(summary)?summary:null;

// What an import of one accepted film would do to each fact now, by the same order, floors and observation ids as the
// baseline commit. `current` is the value the import would meet: the greater of the stored fact and the scan summary.
async function lbaOutcomes(item,record,floors,origin){
 const outcomes=[];
 for(const fact of LetterboxdFacts.FACT_NAMES){
  if(!(fact in item.facts))continue;
  const observation=await LetterboxdFacts.observation({factKey:record.factKey,fact,value:item.facts[fact],observedAt:origin.generatedAt,source:'letterboxd_export',sourceRef:origin.sha256,effectiveOn:item.effectiveOn[fact]??null});
  const stored=record[fact]||null,floor=floors[fact]||null;
  const effective=!stored?floor:!floor?stored:LetterboxdFacts.compareObservations(stored,floor)>=0?stored:floor;
  const {outcome,tie}=LetterboxdFacts.applyObservation(record,fact,observation,{floor});
  outcomes.push({fact,outcome,tie,current:effective?{value:effective.value,observedAt:effective.observedAt,source:effective.source}:null});
 }
 return outcomes;
}

async function lbaCompare(env,parsed,origin){
 const {env:readEnv,versions}=lbaReadOnly(env);
 const sources={};
 let programme=null;
 try{
  const snapshot=await adminLoadSnapshot(readEnv,false);
  if(snapshot.error)sources.programme={evidence:'unavailable',reason:snapshot.error};
  else{programme=snapshot.programme.body;sources.programme={evidence:'observed',key:epgGenerationKey(snapshot.tuple.programmeRunId,'programme.json'),programmeRunId:snapshot.tuple.programmeRunId,films:Array.isArray(programme?.films)?programme.films.length:0};}
 }catch{sources.programme={evidence:'unavailable',reason:'storage_unavailable'};}
 const [metadata,pointer,links,filmsList,watchlist,receipt,intent]=await Promise.all([LBA_METADATA_KEY,LBA_RATINGS_POINTER_KEY,LetterboxdFacts.FACTS_KEYS.links,LetterboxdFacts.FACTS_KEYS.filmsList,LetterboxdFacts.FACTS_KEYS.watchlist,lbaImportKey(origin.sha256,'receipt'),lbaImportKey(origin.sha256,'intent')].map(key=>lbaRead(readEnv,key)));
 sources.metadata={evidence:metadata.evidence,key:LBA_METADATA_KEY};
 let ratings=null;
 if(pointer.evidence==='observed'&&pointer.value?.projected===true&&typeof pointer.value.generationId==='string'){
  const key=lbaRatingsGenerationKey(pointer.value.generationId),generation=await lbaRead(readEnv,key);
  ratings=generation.value;sources.ratingsGeneration={evidence:generation.evidence,key};
 }else sources.ratingsGeneration={evidence:pointer.evidence==='unavailable'?'unavailable':'object_missing',key:LBA_RATINGS_POINTER_KEY,reason:pointer.evidence==='observed'?'not_projected':null};
 sources.links={evidence:links.evidence,key:LetterboxdFacts.FACTS_KEYS.links};
 sources.filmsListSummary={evidence:filmsList.evidence,key:LetterboxdFacts.FACTS_KEYS.filmsList,observedAt:lbaSummaryValue(filmsList.value)?.observedAt??null};
 sources.watchlistSummary={evidence:watchlist.evidence,key:LetterboxdFacts.FACTS_KEYS.watchlist,observedAt:lbaSummaryValue(watchlist.value)?.observedAt??null};
 const receiptState=receipt.evidence==='unavailable'||intent.evidence==='unavailable'?{status:'unavailable',committedAt:null}
  :receipt.evidence==='observed'?{status:'committed',committedAt:typeof receipt.value?.committedAt==='string'?receipt.value.committedAt:null}
  :intent.evidence==='observed'?{status:'opened',committedAt:null}:{status:'absent',committedAt:null};
 const index=LetterboxdMatch.buildIndex({programme,metadata:metadata.value&&typeof metadata.value==='object'?metadata.value:{},ratings});
 const matches=LetterboxdMatch.matchExport(parsed.films,index),hypothesis=LetterboxdMatch.lidHypothesis(matches,index);
 const films=new Map(parsed.films.map(film=>[film.code,film]));
 const linkIndex=lbaSummaryValue(links.value)||{},factsReadable=links.evidence!=='unavailable';
 const items=[];
 for(const match of matches){
  if(match.status!=='accepted')continue;
  const {facts,effectiveOn}=LetterboxdArchivePreview.proposedFacts(films.get(match.code));
  const lid=String(match.filmId??''),tmdb=match.tmdbId!=null?String(match.tmdbId):null;
  const item={code:match.code,lid,tmdb,facts,effectiveOn,state:'compared',outcomes:[]};
  if(!LBA_LID.test(lid)||(tmdb!==null&&!LBA_TMDB.test(tmdb))){item.state='invalid_identity';items.push(item);continue;}
  items.push(item);
 }
 items.sort((a,b)=>a.lid<b.lid?-1:a.lid>b.lid?1:0);
 // Which films have a record: a record key exists only behind a link index alias, so a film none of whose aliases is in
 // the index has no record to read and meets only the scan summaries.
 const toRead=[];
 for(const item of items){
  if(item.state!=='compared')continue;
  if(!factsReadable){item.state='unverified';item.reason='links_unavailable';continue;}
  const links_={letterboxd:item.lid,tmdb:item.tmdb},factKey=LetterboxdFacts.plannedKey(linkIndex,links_);
  if(!factKey){item.state='alias_conflict';continue;}
  item.factKey=factKey;
  if(LetterboxdFacts.aliasesOf(links_).some(alias=>linkIndex[alias]))toRead.push(item);
 }
 // One request-wide cap on fact-record GETs. A redirect hop counts. The budget is reserved synchronously before each
 // GET, six films at a time, and a film whose hop does not fit is unverified: the stub is not compared.
 const limit=LetterboxdArchivePreview.PREVIEW_LIMITS.maxRecordReads,concurrency=LetterboxdArchivePreview.PREVIEW_LIMITS.recordReadConcurrency;
 let recordReads=0;
 const stored=new Map();
 const pending=toRead.slice();
 const take=()=>{if(recordReads>=limit)return false;recordReads++;return true;};
 while(pending.length&&recordReads<limit){
  const batch=[];
  while(batch.length<concurrency&&pending.length&&take())batch.push(pending.shift());
  const first=await Promise.all(batch.map(item=>lbaRead(readEnv,LetterboxdFacts.recordKey(item.factKey))));
  const hops=[];
  for(let i=0;i<batch.length;i++){
   const item=batch[i],result=first[i];
   if(result.evidence==='unavailable'){item.state='unverified';item.reason='record_unavailable';continue;}
   if(result.value?.migrating){item.state='unverified';item.reason='record_converging';continue;}
   if(result.value?.redirectTo){
    if(!take()){item.state='unverified';item.reason='record_read_limit';continue;}
    hops.push({item,key:result.value.redirectTo});
    continue;
   }
   stored.set(item,result.value);
  }
  for(let at=0;at<hops.length;at+=concurrency){
   const slice=hops.slice(at,at+concurrency);
   const second=await Promise.all(slice.map(hop=>lbaRead(readEnv,LetterboxdFacts.recordKey(hop.key))));
   slice.forEach((hop,i)=>{
    const result=second[i];
    if(result.evidence==='unavailable'){hop.item.state='unverified';hop.item.reason='record_unavailable';return;}
    if(result.value?.migrating||result.value?.redirectTo){hop.item.state='unverified';hop.item.reason='record_converging';return;}
    stored.set(hop.item,result.value);
   });
  }
 }
 for(const item of pending){item.state='unverified';item.reason='record_read_limit';}
 const floorsSource={filmsList:lbaSummaryValue(filmsList.value),watchlist:lbaSummaryValue(watchlist.value)};
 for(const item of items){
  if(item.state==='unverified'){item.outcomes=Object.keys(item.facts).map(fact=>({fact,outcome:'unverified',tie:false,current:null}));continue;}
  if(item.state!=='compared')continue;
  const value=stored.get(item);
  const record=value?JSON.parse(JSON.stringify(value)):LetterboxdFacts.emptyRecord(item.factKey,{letterboxd:item.lid,tmdb:item.tmdb});
  record.factKey=record.factKey||item.factKey;
  const floors={...await LetterboxdFacts.summaryObservations('films-list',floorsSource.filmsList,item.lid,record.factKey),...await LetterboxdFacts.summaryObservations('watchlist',floorsSource.watchlist,item.lid,record.factKey)};
  item.outcomes=await lbaOutcomes(item,record,floors,origin);
  delete item.factKey;
 }
 for(const item of items)delete item.factKey;
 // The objects the comparison rests on, read once more: any etag that moved means the answer mixes two states.
 const fenced=[EPG_GENERATION_KEY,LBA_METADATA_KEY,LBA_RATINGS_POINTER_KEY,LetterboxdFacts.FACTS_KEYS.links,LetterboxdFacts.FACTS_KEYS.filmsList,LetterboxdFacts.FACTS_KEYS.watchlist];
 const first=new Map(fenced.map(key=>[key,versions.get(key)]));
 const again=await Promise.all(fenced.map(key=>lbaVersion(env,key)));
 const changed=fenced.filter((key,i)=>first.get(key)!==again[i]);
 return {
  sources,omitted:LBA_OMITTED,receipt:receiptState,matches,hypothesis,indexSummary:index.summary,items,
  recordReads:{limit,needed:toRead.length,done:recordReads},
  consistency:{status:changed.length?'drift':'stable',changed},
  reads:[...versions.keys()],
 };
}

// One uploaded archive, parsed in this request. `allowed` is null on the preview (only the file and an optional export
// time) or a map of extra field name to its maximum length. A refusal reads no R2 object. The bytes are dropped before
// the function returns: only the parsed films and the archive's own checksums leave this function.
async function lbaIngest(request, allowed, now, signal){
 const limits=LetterboxdArchiveZip.ARCHIVE_LIMITS,maxBody=limits.maxArchiveBytes+LBA_FORM_OVERHEAD;
 const contentType=request.headers.get('Content-Type')||'';
 const length=request.headers.get('Content-Length');
 if(length===null||!/^\d{1,12}$/.test(length))return {response:adminError('length_required',411)};
 if(Number(length)>maxBody)return {response:adminError('archive_too_large',413)};
 let body=await lbaBody(request,maxBody);
 if(!body)return {response:adminError('archive_too_large',413)};
 let form;
 try{form=await new Response(body,{headers:{'Content-Type':contentType}}).formData();}catch{return {response:adminError('invalid_form',400)};}
 body=null;
 let file=null,declared=null,fields=0;
 const extra={};
 for(const [name,value] of form){
  fields++;
  if(name==='archive'&&!file&&value&&typeof value==='object'&&typeof value.arrayBuffer==='function')file=value;
  else if(name==='generatedAt'&&declared===null&&typeof value==='string'&&value.length<=LBA_DECLARED_MAX)declared=value;
  else if(allowed&&Object.prototype.hasOwnProperty.call(allowed,name)&&extra[name]===undefined&&typeof value==='string'&&value.length<=allowed[name])extra[name]=value;
  else return {response:adminError('invalid_form',400)};
 }
 if(!file||(!allowed&&fields>2))return {response:adminError('invalid_form',400)};
 const fileName=typeof file.name==='string'?file.name:'';
 if(!fileName||fileName.length>LBA_NAME_MAX)return {response:adminError('invalid_form',400)};
 if(file.size>limits.maxArchiveBytes)return {response:adminError('archive_too_large',413)};
 const named=LetterboxdArchiveZip.archiveGeneratedAt(fileName);
 const time=LetterboxdArchivePreview.resolveGeneratedAt({named,declared,now});
 if(time.error)return {response:lbaUnprocessable(time.error)};
 let archive;
 try{archive=await LetterboxdArchiveZip.readLetterboxdArchive(new Uint8Array(await file.arrayBuffer()),{signal,now});}
 catch(error){if(error?.name==='ArchiveError')return {response:lbaUnprocessable('archive_invalid',{code:error.code,file:error.file})};throw error;}
 form=null;file=null;
 const texts={};
 for(const [kind,name] of Object.entries(LetterboxdArchivePreview.PREVIEW_FILES)){texts[kind]=archive.files[name]?.text??null;if(archive.files[name])archive.files[name].text=null;}
 if(texts.watched===null)return {response:lbaUnprocessable('missing_watched')};
 let parsed;
 try{parsed=LetterboxdExport.parseExport(texts);}
 catch(error){
  if(error?.name==='CsvError'){const file_=Object.values(LetterboxdArchivePreview.PREVIEW_FILES).find(name=>String(error.message).startsWith(name+' '))||Object.values(LetterboxdArchivePreview.PREVIEW_FILES).find(name=>String(error.message).startsWith(name+':'))||null;return {response:lbaUnprocessable('csv_invalid',{file:file_,record:Number.isInteger(error.record)?error.record:null})};}
  throw error;
 }
 const files={};
 for(const [name,entry] of Object.entries(archive.files))files[name]={sha256:entry.sha256,bytes:entry.bytes};
 for(const kind of Object.keys(texts))texts[kind]=null;
 const origin={sha256:archive.sha256,generatedAt:time.generatedAt,generatedAtSource:time.source};
 const presented={sha256:archive.sha256,bytes:archive.bytes,entries:archive.entries,ignoredEntries:archive.ignoredEntries,nameStandard:named!==null,generatedAt:time.generatedAt,generatedAtSource:time.source,files};
 return {origin,parsed,presented,extra};
}

async function adminLetterboxdArchiveRoute(request,env,url){
 if(url.pathname==='/api/admin/letterboxd-archive/apply-confirm'||url.pathname==='/api/admin/letterboxd-archive/apply'||url.pathname==='/api/admin/letterboxd-archive/rollback-confirm'||url.pathname==='/api/admin/letterboxd-archive/rollback')return lbaApplyRoute(request,env,url);
 if(url.pathname!==LBA_PATH)return adminError('not_found',404);
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 const contentType=request.headers.get('Content-Type')||'';
 if(!/^multipart\/form-data;\s*boundary=/i.test(contentType))return adminError('unsupported_media_type',415);
 const limits=LetterboxdArchiveZip.ARCHIVE_LIMITS,maxBody=limits.maxArchiveBytes+LBA_FORM_OVERHEAD;
 const length=request.headers.get('Content-Length');
 if(length===null||!/^\d{1,12}$/.test(length))return adminError('length_required',411);
 if(Number(length)>maxBody)return adminError('archive_too_large',413);
 const started=Date.now(),signal=request.signal||null;
 if(!lbaTrySlot(started))return adminError('preview_busy',429);
 try{
  const opened=await lbaIngest(request,null,started,signal);
  if(opened.response)return opened.response;
  const comparison=await lbaCompare(env,opened.parsed,opened.origin);
  const preview=LetterboxdArchivePreview.buildPreview({
   archive:opened.presented,parsed:opened.parsed,comparison,now:started,archiveStaleMs:DataHealth.DATA_HEALTH_THRESHOLDS.archiveStaleMs,
  });
  await lbaAttachBatches(preview,comparison,started);
  return json({...preview,reads:comparison.reads});
 }catch{
  return adminError('preview_failed',500);
 }finally{lbaFreeSlot(started);}
}
