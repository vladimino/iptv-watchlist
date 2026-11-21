// Owner-only identity work inventory behind the existing Cloudflare Access application: GET /api/admin/identity-work (AIR-527, ADR 0170).
// Four typed lanes over the current owners (the Watchlist admission ledger is the fourth, ADR 0186): the Limbo Film and Discovery observation evaluation (read unchanged through adminLimboLoad),
// and the Letterboxd rated candidates of ONE archive per request. The only storage calls are R2 `get` and `head` of named objects, one
// delimiter `list` of letterboxd/imports/, and one bounded D1 SELECT of film_rated_admission for the page archive. It never calls identity-step,
// TMDB, Letterboxd, a continuation, a ZIP, a writer or a Task, and it never writes or repairs the derived registry.
// The contract is docs/reference/domain/identity-work-inventory.md and ADR 0170.
const IDENTITY_WORK_CURSOR_MAX=6000;
const IDENTITY_WORK_ADMISSION_CAP=5000;
const IDENTITY_WORK_SOURCES=['letterboxd/imports/registry.json','letterboxd/imports/<archiveSha256>/rated-candidates.json','letterboxd/imports/ (delimiter list)','film_rated_admission (D1)','watchlist_admission_pending (D1)'];

function identityWorkPinOf(registryToken,limboPin){
 return ['I1',encodeURIComponent(registryToken),encodeURIComponent(limboPin??'')].join('|');
}
async function identityWorkReadRegistry(env){
 const key=LetterboxdImportRegistry.REGISTRY_KEY;
 try{
  const object=await env.BUCKET.get(key);
  if(!object)return {state:'absent',registry:null,etag:null,token:'none'};
  if(typeof object.size==='number'&&object.size>LetterboxdImportRegistry.REGISTRY_MAX_BYTES){try{await object.body?.cancel?.();}catch{/* body not needed */}return {state:'oversized',registry:null,etag:object.etag??null,token:'oversized'};}
  const raw=await object.text();
  if(raw.length>LetterboxdImportRegistry.REGISTRY_MAX_BYTES)return {state:'oversized',registry:null,etag:object.etag??null,token:'oversized'};
  const registry=LetterboxdImportRegistry.parseRegistry(JSON.parse(raw));
  if(!registry)return {state:'invalid',registry:null,etag:object.etag??null,token:'invalid:'+String(object.etag??'')};
  return {state:'present',registry,etag:object.etag??null,token:'e:'+String(object.etag??'present')};
 }catch{return {state:'unreadable',registry:null,etag:null,token:'unreadable'};}
}
// One delimiter LIST, no bodies. Truncated at the cap is partial, never a complete listing.
async function identityWorkListArchives(env){
 try{
  const listed=await env.BUCKET.list({prefix:LetterboxdImportRegistry.REGISTRY_PREFIX,delimiter:'/',limit:IdentityWorkInventory.IDENTITY_LIST_MAX});
  const prefixes=[];
  for(const entry of Array.isArray(listed?.delimitedPrefixes)?listed.delimitedPrefixes:[]){
   const sha=String(entry).slice(LetterboxdImportRegistry.REGISTRY_PREFIX.length).replace(/\/$/,'');
   if(LetterboxdImportRegistry.isArchiveSha(sha))prefixes.push(sha);
  }
  return {prefixes:[...new Set(prefixes)].sort(),truncated:listed?.truncated===true};
 }catch{return null;}
}
// One candidate document of the page archive, capped. Oversized and unreadable are states, never rows.
async function identityWorkReadDocument(env,sha){
 const key=LetterboxdImportRegistry.candidateDocumentKey(sha),cap=IdentityWorkInventory.IDENTITY_DOC_MAX_BYTES;
 try{
  const head=await env.BUCKET.head(key);
  if(!head)return {state:'absent',doc:null,etag:null};
  if(typeof head.size==='number'&&head.size>cap)return {state:'oversized',doc:null,etag:head.etag??null};
  const object=await env.BUCKET.get(key);
  if(!object)return {state:'absent',doc:null,etag:null};
  if(typeof object.size==='number'&&object.size>cap){try{await object.body?.cancel?.();}catch{/* body not needed */}return {state:'oversized',doc:null,etag:object.etag??null};}
  const raw=await object.text();
  if(raw.length>cap)return {state:'oversized',doc:null,etag:object.etag??null};
  const doc=JSON.parse(raw);
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||doc.archiveSha256!==sha)return {state:'unreadable',doc:null,etag:object.etag??null};
  return {state:'read_whole',doc,etag:object.etag??null};
 }catch{return {state:'unreadable',doc:null,etag:null};}
}
// The only confirmation of a candidate's Film: D1 admission rows of this archive. null means the read did not complete.
async function identityWorkReadAdmissions(env,sha){
 try{
  const db=FilmPersonAuthority.database(env);
  if(!db)return null;
  const rows=await FilmPersonAuthority.many(db,'SELECT film_id,tmdb,source_code,archive_sha256 FROM film_rated_admission WHERE archive_sha256=? LIMIT '+(IDENTITY_WORK_ADMISSION_CAP+1),[sha]);
  return rows.length>IDENTITY_WORK_ADMISSION_CAP?null:rows;
 }catch{return null;}
}
// The Watchlist admission ledger (D1, read only, at most 1000 rows). null means the ledger could not be read; absent tables are an unavailable lane, never an empty queue.
async function identityWorkAdmissions(env){
 if(typeof WatchlistD1==='undefined')return {error:'repository_unavailable'};
 try{const read=await WatchlistD1.admissionInventory(env,{limit:1000});return read.ok?{rows:read.rows,truncated:read.truncated===true}:{error:read.reason||'unavailable'};}
 catch{return {error:'unavailable'};}
}
async function identityWorkLimbo(env,hasPin,nowMs){
 let snapshot;
 try{snapshot=await adminLimboLoad(env,hasPin);}
 catch(error){return {error:adminStorageRefusal(error)?'film_person_unavailable':'storage_unavailable'};}
 if(snapshot.error)return {error:snapshot.error};
 const health=limboEvaluate(snapshot,nowMs);
 if(health.error)return {error:'evaluation_failed'};
 const readable=limboIndexReadable(snapshot.observations);
 const items=LimboInventory.limboItems(health,{films:snapshot.films,observations:readable?snapshot.observations.records:[]});
 return {snapshot,health,items,pin:limboEncodePin(snapshot.tuple),observationCoverage:limboObservationCoverage(snapshot.observations)};
}
function identityWorkLaneCoverage(lane,limbo){
 if(!limbo||limbo.error)return {state:'unavailable',reason:limbo?.error??'not_read'};
 if(lane==='film')return {state:limbo.health.scope.coverage.films==='partial'?'partial':limbo.health.scope.coverage.films||'unknown',observed:limbo.health.scope.subjects.films.length};
 const coverage=limbo.observationCoverage;
 if(!coverage.available)return {state:'unavailable',reason:coverage.reason,index:coverage};
 return {state:'partial',observed:limbo.health.scope.subjects.observations.length,index:coverage};
}
function identityWorkOrder(registryRead,listing,selected){
 if(selected)return [selected];
 const registered=registryRead.registry?LetterboxdImportRegistry.orderedArchives(registryRead.registry).map(row=>row.sha):[];
 if(!listing)return registered;
 const listed=new Set(listing.prefixes),indexed=registered.filter(sha=>listed.has(sha)),known=new Set(registered);
 // Archives the registry does not know are paged after the registered ones, labelled unindexed, never presented as an empty queue.
 return indexed.concat(listing.prefixes.filter(sha=>!known.has(sha)));
}
async function adminIdentityWorkRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const params=url.searchParams;
 const query=IdentityWorkInventory.identityWorkQuery(params);
 if(query.error)return adminError(query.error,400);
 let pin=null,cursorRaw=null;
 if(params.has('pin')){pin=params.get('pin');if(!pin||pin.length>ADMIN_PIN_MAX+200||!pin.startsWith('I1|'))return adminError('invalid_pin',400);}
 if(params.has('cursor')){cursorRaw=params.get('cursor');if(!cursorRaw||cursorRaw.length>IDENTITY_WORK_CURSOR_MAX)return adminError('stale_cursor',400);}
 let decoded=null;
 if(cursorRaw!==null){decoded=IdentityWorkInventory.decodeCursor(cursorRaw,{key:query.key,limit:query.limit});if(decoded.error)return adminError(decoded.error,400);}
 const nowMs=decoded?decoded.nowMs:Date.now();
 const wantsMemory=IdentityWorkInventory.laneEnabled(query,'film')||IdentityWorkInventory.laneEnabled(query,'epg_observation');
 const wantsCandidates=IdentityWorkInventory.laneEnabled(query,'letterboxd_rated_candidate');
 const wantsAdmissions=IdentityWorkInventory.laneEnabled(query,'watchlist_admission');
 const admissions=wantsAdmissions?await identityWorkAdmissions(env):null;
 const limbo=wantsMemory?await identityWorkLimbo(env,pin!==null||decoded!==null,nowMs):null;
 const registryRead=wantsCandidates?await identityWorkReadRegistry(env):{state:'not_read',registry:null,etag:null,token:'not_read'};
 const currentPin=identityWorkPinOf(registryRead.token,limbo&&!limbo.error?limbo.pin:(limbo?'unavailable':''));
 if(pin!==null&&pin!==currentPin)return adminError('stale_pin',409);
 if(decoded&&decoded.pin!==currentPin)return adminError('stale_pin',409);
 const listing=wantsCandidates?await identityWorkListArchives(env):null;
 const order=wantsCandidates?identityWorkOrder(registryRead,listing,query.archive):[];
 const lanes=IdentityWorkInventory.IDENTITY_LANES.filter(lane=>IdentityWorkInventory.laneEnabled(query,lane));
 const startOf=lane=>lane==='letterboxd_rated_candidate'?{lane,sha:null,after:'',etag:null}:{lane,index:-1,total:0,id:''};
 const position=decoded?decoded.cursor:startOf(lanes[0]);
 let laneAt=lanes.indexOf(position.lane);
 if(laneAt<0)return adminError('stale_cursor',400);
 const rows=[],limit=query.limit;
 let next=null,page={archiveSha256:null,state:'not_read',reason:null,documentEtag:null,indexed:null,admissions:null};
 for(;laneAt<lanes.length;laneAt++){
  const lane=lanes[laneAt],same=lane===position.lane,after=lanes[laneAt+1]||null;
  if(lane!=='letterboxd_rated_candidate'){
   const source=lane==='watchlist_admission'?(admissions&&!admissions.error?IdentityWorkInventory.admissionRows(admissions.rows,{nowMs}):[]):limbo&&!limbo.error?(lane==='film'?IdentityWorkInventory.filmRows(limbo.items):IdentityWorkInventory.observationRows(limbo.items)):[];
   const laneRows=IdentityWorkInventory.filterRows(IdentityWorkInventory.sortLaneRows(source),query);
   if(limit-rows.length<=0){next=startOf(lane);break;}
   const served=IdentityWorkInventory.pageMemoryLane(laneRows,same?position:{index:-1},limit-rows.length);
   if(served.error)return adminError('stale_cursor',400);
   rows.push(...served.rows);
   if(!served.exhausted){next={lane,...served.last};break;}
   continue;
  }
  if(limit-rows.length<=0){next=startOf(lane);break;}
  const place=same?position:startOf(lane);
  const sha=place.sha??order[0]??null;
  if(!sha)break;
  const at=order.indexOf(sha);
  if(at<0)return adminError('stale_cursor',400);
  const read=await identityWorkReadDocument(env,sha);
  if(place.etag!==null&&place.etag!==read.etag)return adminError('stale_cursor',400);
  const row=registryRead.registry?.archives?.[sha]||null;
  const indexed=row!==null;
  let state=read.state,reason=null;
  if(state==='read_whole'&&indexed&&(row.documentEtag===null||row.documentEtag!==read.etag)){state='registry_stale';reason='document_etag_differs';}
  page={archiveSha256:sha,state,reason,documentEtag:read.etag,indexed,admissions:null};
  if(read.doc){
   const hasVerified=Object.values(read.doc.candidates&&typeof read.doc.candidates==='object'?read.doc.candidates:{}).some(item=>item&&item.state==='verified');
   const admissions=hasVerified?await identityWorkReadAdmissions(env,sha):[];
   page.admissions=hasVerified?(admissions===null?'unavailable':'read'):'not_needed';
   const all=IdentityWorkInventory.candidateRows(read.doc,sha,{nowMs,admissions,isRetryable:reasonCode=>LetterboxdIdentity.isRetryableReason(reasonCode)});
   const served=IdentityWorkInventory.pageCandidateRows(IdentityWorkInventory.filterRows(all,query),place.after,limit-rows.length);
   rows.push(...served.rows);
   if(!served.exhausted){next={lane,sha,after:served.last,etag:read.etag};break;}
  }
  if(at+1<order.length)next={lane,sha:order[at+1],after:'',etag:null};
  break;
 }
 const outRows=IdentityWorkInventory.attachHints(rows);
 const coverage={};
 if(IdentityWorkInventory.laneEnabled(query,'film'))coverage.film=identityWorkLaneCoverage('film',limbo);
 if(IdentityWorkInventory.laneEnabled(query,'epg_observation'))coverage.epg_observation=identityWorkLaneCoverage('epg_observation',limbo);
 if(wantsAdmissions)coverage.watchlist_admission=admissions&&!admissions.error?{state:admissions.truncated?'partial':'complete',observed:admissions.rows.length}:{state:'unavailable',reason:admissions?.error??'not_read'};
 if(wantsCandidates){
  const registryUsable=registryRead.state==='present'||registryRead.state==='absent';
  const enumeration=registryUsable?LetterboxdImportRegistry.enumerate(registryRead.registry,listing)
   :{state:'partial',reason:'registry_'+registryRead.state,registered:null,listed:listing?listing.prefixes.length:null,unindexed:null,unindexedArchives:[],registryOrphans:null,orphanArchives:[]};
  const counts=registryUsable?{...LetterboxdImportRegistry.estimateCounts(registryRead.registry),state:registryRead.state==='present'?'estimate':'absent'}:{basis:'registry_estimate',summarizedAt:null,state:registryRead.state,byStatus:null};
  coverage.letterboxd_rated_candidate={enumeration,counts,page,snapshot:'per_archive',selected:query.archive};
 }
 return json({
  pin:currentPin,snapshot:{sources:IDENTITY_WORK_SOURCES,evaluatedAt:new Date(nowMs).toISOString(),scope:'per_archive'},
  type:query.type,disposition:query.disposition,include:query.includeResolved?'resolved':null,archive:query.archive,q:query.q,limit,
  rows:outRows,
  nextCursor:next?IdentityWorkInventory.encodeCursor({...next,key:query.key,limit,pin:currentPin,nowMs}):null,
  coverage,
  vocabulary:{types:IdentityWorkInventory.IDENTITY_LANES,dispositions:IdentityWorkInventory.IDENTITY_DISPOSITIONS},
 });
}
