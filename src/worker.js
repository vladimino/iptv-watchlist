const json=(data,status=200,extra=null)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(extra&&typeof extra==='object'?extra:{})}});
const DISCOVERY_USER_READ_CODES=['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative','discovery_bounded'];
function discoveryUserReadRefusal(error){
 if(!DISCOVERY_USER_READ_CODES.includes(error?.code))return null;
 return json({error:'The catalog is not readable right now',code:error.code},503,{'Retry-After':'1'});
}
function addGroup(left,right,displayed){const group={compared:(left?.compared||0)+(right?.compared||0),mismatched:(left?.mismatched||0)+(right?.mismatched||0)};if(displayed)group.displayed=(left?.displayed||0)+(right?.displayed||0);return group;}
function recordLifecycle(run,path,mode,count){if(!run||(mode!=='on'&&mode!=='shadow')||!count?.films)return;const prior=run.lifecycleLocalization?.[path];run.lifecycleLocalization={...(run.lifecycleLocalization||{}),[path]:{mode,films:addGroup(prior?.films,count.films,true),people:addGroup(prior?.people,count.people,true),cache:addGroup(prior?.cache,count.cache,false)}};}
// `options.item`, for a discovery ledger stored in R2, parses the `items` array one element at a time and keeps what
// `item` returns for each (AIR-342): the document is never held whole as text and tree. Any other key, a D1-routed
// read, or an object without a readable body is parsed as before.
// ADR 0183, selector retired in AIR-558: the view index is always derived from D1 (prediction_pointer, prediction_fingerprint,
// ratings_view, then the compiled seed where the reader applies it). The raw R2 object `enrichment/view-index.json` is neither read nor written by the Worker.
const VIEW_INDEX_KEY='enrichment/view-index.json';
function viewIndexRefusal(code){const error=new Error(code);error.code=code;return error;}
// The D1 view index. `ratingsOnly` is the Letterboxd facts reader, which has only ever applied the ratings overlay. Fail closed: a prediction domain that
// is not d1 or a ratings domain that is not d1 and open refuses with the existing domain codes (the routes answer 503); there is no raw fallback.
async function derivedViewIndex(env,{ratingsOnly=false,moodFacet=canonicalMoodFacet}={}){
 if(typeof RatingsD1==='undefined'||(!ratingsOnly&&typeof PredictionD1==='undefined'))throw viewIndexRefusal('view_index_d1_unavailable');
 if(!(await RatingsD1.ratingsReady(env)))throw viewIndexRefusal('ratings_domain_not_authoritative');
 const base=ratingsOnly?{}:await PredictionD1.derivedIndex(env,moodFacet);
 return RatingsD1.overlayView(env,base);
}
// A version token for the D1 view index, in place of the raw object's ETag in pins and displayed versions: it changes whenever either domain commits.
async function viewIndexD1Version(env){
 const [prediction,ratings]=await Promise.all([PredictionD1.readPredictionAuthority(env?.DB??null,env),RatingsD1.readRatingsAuthority(env?.DB??null,env)]);
 return 'd1:p'+prediction.generation+'.q'+prediction.queueGeneration+'.r'+ratings.generation;
}
const loadJSON=async(env,key,options=null)=>{
 if(EPG_CHECKPOINT_KEYS.has(key)){
  const gate=await epgCheckpointState(env);
  if(gate.state==='closed')throw checkpointError('unavailable');
  if(gate.state==='d1'){
   if(key==='sync.json')return loadCheckpointRun(env);
   const ingest=await EpgCheckpointD1.readIngest(env);
   if(!ingest.ok)throw checkpointError('unavailable');
   return ingest.status;
  }
 }
 if(typeof DiscoveryAuthority!=='undefined'&&DiscoveryAuthority.ownsKey(key)){
  const routed=await DiscoveryAuthority.routeRead(env,key,options);
  if(routed.handled)return routed.value;
 }
 const publishedKey=key===EPG_GENERATION_KEY||key==='programme.json'||key==='watchlist.json'||key==='epg/discovery-latest.json'||key==='epg/discovered-films.json';
 if(publishedKey&&typeof PublishedEpg!=='undefined'){
  const live=await PublishedEpg.currentGeneration(env);
  if(live){
   if(key===EPG_GENERATION_KEY)return live.programmeRunId?{programmeRunId:live.programmeRunId,phase:'published'}:null;
   const run=env.epgPin?.authority==='d1'&&env.epgPin.programmeRunId?env.epgPin.programmeRunId:live.programmeRunId;
   if(key==='programme.json'||key==='watchlist.json'){
    if(!run)return null;
    const generation=env.epgPin?.authority==='d1'?env.epgPin.generation:live.generation;
    const document=await PublishedEpg.readDocumentAt(env,run,key==='watchlist.json'?'watchlist':'programme',generation);
    if(key==='programme.json'&&!document){const error=new Error('published_epg_unavailable');error.code='published_epg_unavailable';throw error;}
    return document;
   }
   const stagedName=key==='epg/discovery-latest.json'?'discovery-latest.json':key==='epg/discovered-films.json'?'discovered-films.json':null;
   if(stagedName){
    if(!run)return null;
    const copy=await env.BUCKET.get(epgGenerationKey(run,stagedName));
    if(copy)return storedJSON(copy,key,options);
    if(run!==live.programmeRunId)return null;
    const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),body=pointer?await pointer.json():null;
    if(body?.phase!=='published'||body.programmeRunId!==run)return null;
    const shared=await env.BUCKET.get(key);
    return shared?storedJSON(shared,key,options):null;
   }
  }
 }
 const staged=key==='programme.json'?'programme.json':key==='epg/discovery-latest.json'?'discovery-latest.json':key==='epg/discovered-films.json'?'discovered-films.json':null;
 if(staged){
  const pinned=env.epgPin?.programmeRunId;
  if(pinned){const object=await env.BUCKET.get(epgGenerationKey(pinned,staged));if(object)return storedJSON(object,key,options);}
  else{const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if(pointer){const generation=await pointer.json();if(generation?.phase==='published'&&generation.programmeRunId){const object=await env.BUCKET.get(epgGenerationKey(generation.programmeRunId,staged));if(object)return storedJSON(object,key,options);}}}
 }
 if(typeof PredictionD1!=='undefined'){const routed=await PredictionD1.routeRead(env,key,options);if(routed.handled)return routed.value;}
 if(typeof PredictionAux!=='undefined'){const routed=await auxRouteRead(env,key);if(routed.handled)return routed.value;}
 if(typeof RatingsD1!=='undefined'){const routed=await RatingsD1.routeRead(env,key);if(routed.handled)return routed.value;}
 if(key===VIEW_INDEX_KEY)return derivedViewIndex(env);
 const o=await env.BUCKET.get(key);
 return o?storedJSON(o,key,options):null;
};
async function publishedOwnerReviews(env){
 if(typeof OwnerReview==='undefined'||typeof OwnerReview.loadForRead!=='function')return {ok:true,body:await loadJSON(env,'admin/owner-reviews.json')};
 return OwnerReview.loadForRead(env);
}
// AIR-374 P4b (owner decision 4): the titles.json dictionary behind GET /api/programme and GET /api/watchlist. The marker is read FIRST on every GET: legacy (the explicit local stand-in only; r2 and prepared markers are refused, ADR 0162) reads the
// R2 mirror exactly as before; at `open` the mirror is frozen and the same rows come from D1 (one bounded SELECT); held and an unreadable marker throw before any read and never reach R2.
// The marker is read again after the reads, so a move to open (or held) mid-request is a 503, never a stale R2 answer. The bundle always defines CanonicalCatalogReader (the guard
// serves only the vm-scoped tests that load the Worker without it; tests/canonical-catalog-titles.mjs asserts the bundle).
const TITLE_READ_REFUSALS=['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'];
const titleReadGate=env=>typeof CanonicalCatalogReader==='undefined'?null:CanonicalCatalogReader.catalogReaderGate(env);
// Frozen titles.json / people.json stay R2 only while the Film/Person marker is not open. At open (and held / unreadable) the
// Producer Workflow is the writer; these sync steps must not refresh the frozen mirrors. The lock is re-read at the write, after any
// localization await, so a flip to open mid-step (historically prepared→open) cannot land a canonical R2 put.
async function frozenCanonicalMirrorsLocked(env){
 if(typeof CanonicalCatalogReader==='undefined')return false;
 try{
  if(typeof CanonicalCatalogReader.canonicalMirrorsWritable==='function')return !(await CanonicalCatalogReader.canonicalMirrorsWritable(env));
  const gate=await CanonicalCatalogReader.catalogReaderGate(env);
  return gate.mode==='d1';
 }catch{return true;}
}
async function saveCanonicalMirror(env,key,value){
 if(await frozenCanonicalMirrorsLocked(env))return false;
 const saved=await saveJSON(env,key,value);
 return saved?.skipped!=='canonical_mirror_frozen';
}
async function localizedTitleStore(env,pinned,gate,films){
 if(!gate)return (await loadJSON(pinned,'titles.json'))||{};
 if(gate.mode==='d1')return CanonicalCatalogReader.catalogTitlesFromD1(env,films,gate);
 return (await loadJSON(pinned,'titles.json'))||{};
}
// The LAST async boundary: after every awaited read of the route (titles, owner reviews, sync.json, documents) and right before a successful answer, the marker is read again
// and must still have the state AND generation the first read saw, on the open path and on the legacy (local stand-in) path alike. A 200 shape that carries no title (the empty
// watchlist) is fenced the same way. Error answers are not fenced: they carry no stored facts.
async function titleReadFinish(env,gate,response){
 if(gate)await CanonicalCatalogReader.catalogReaderStill(env,gate);
 return response;
}
const titleReadRefusal=error=>TITLE_READ_REFUSALS.includes(error?.code)?json({error:'storage_unavailable',reason:error.code},503):null;
// AIR-541 (ADR 0177): the degraded, read-only answer from the R2 compatibility mirrors. Reached only from the read handlers below, after a TYPED TEMPORARY authoritative failure
// (`MirrorRead.isTemporaryReadFault`); a healthy D1, a structural refusal, a fence (409 retry) and a confirmed absence/retirement/conflict never come here. The healthy response shape is
// unchanged: a body without `source` is authoritative. Nothing in this block writes (R2, D1 or anywhere else); the write routes do not call these functions.
// The bundle always defines MirrorRead; the guard serves only the vm-scoped tests that load the Worker without it (no degraded answer is then possible).
const isTemporaryReadFault=error=>typeof MirrorRead==='undefined'?false:MirrorRead.isTemporaryReadFault(error);
const DEGRADED_EVENT_WINDOW_MS=60000,DEGRADED_RUN_ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const degradedSeen=new Map();let degradedLastAt=0;
function degradedEvent(event,fields){
 try{
  const key=event+':'+(fields.route||'')+':'+(fields.reason||''),now=Date.now();
  if(now-(degradedSeen.get(key)||0)<DEGRADED_EVENT_WINDOW_MS)return;
  if(degradedSeen.size>64)degradedSeen.clear();
  degradedSeen.set(key,now);
  console.log(JSON.stringify({event,at:new Date(now).toISOString(),...fields}));
 }catch{}
}
// An authoritative read that succeeds after a degraded one: one `mirror_fallback_recovered` event (per window), no personal data.
function degradedRecovered(route){
 if(!degradedLastAt)return;
 const afterMs=Date.now()-degradedLastAt;degradedLastAt=0;
 degradedEvent('mirror_fallback_recovered',{route,afterMs});
}
function degradedReason(error){return typeof error?.code==='string'?error.code.slice(0,64):'temporary_read_fault';}
function degradedResponse(body,snapshot,error,route){
 const meta=MirrorRead.mirrorMeta(snapshot,degradedReason(error));
 degradedLastAt=Date.now();
 const age=meta.asOf?Math.max(0,Math.round((Date.now()-Date.parse(meta.asOf))/1000)):null;
 degradedEvent('mirror_fallback_activated',{route,reason:meta.reason,runId:meta.runId,asOf:meta.asOf,ageSeconds:age,joined:meta.joined});
 return json({...body,...meta,availability:'unverified'},200,{'X-Data-Origin':'mirror'});
}
async function degradedSnapshot(env,error,route){
 let snapshot=null;
 try{snapshot=await MirrorRead.readMirrorSnapshot(env);}catch{snapshot=null;}
 if(!snapshot||(!snapshot.programme&&!snapshot.watchlist)){
  degradedEvent('mirror_fallback_unusable',{route,reason:degradedReason(error),rejected:(snapshot?.rejected||[]).map(item=>item.reason).slice(0,8)});
  return null;
 }
 for(const item of snapshot.rejected)if(item.reason!=='absent')degradedEvent('mirror_validation_failed',{route,reason:item.reason,key:item.key});
 return snapshot;
}
// ADR 0186: the answer of a read route to a Watchlist authority fault. A move is a retryable 409; a temporary fault (a D1 storage error) continues to the degraded path, which accepts only a validated
// standalone Watchlist mirror; every other fault (held, closed, absent, malformed) is a typed 503 and never degrades into another source.
function watchlistRouteFault(error){
 if(!error?.watchlistAuthority)return null;
 if(error.code==='watchlist_authority_moved')return json({error:'watchlist_authority_moved',retry:true},409);
 if(error.temporary===true)return null;
 return json({error:'storage_unavailable',reason:error.code},503);
}
// GET /api/programme from the mirrors. D1-owned overlays (localized titles, owner reviews) are not applied: they are not read here.
async function degradedProgrammeResponse(env,error){
 const snapshot=await degradedSnapshot(env,error,'programme');
 if(!snapshot)return null;
 let body;
 if(snapshot.programme){
  // ADR 0186 decision 8.6: with a Watchlist authority fault the root watchlist is never joined to the programme as a same-run pair; the programme answers alone.
  const watchlist=snapshot.joined==='best_effort'&&!error?.watchlistAuthority?snapshot.watchlist.doc:null;
  body={...programmeWithWatchlist(JSON.parse(JSON.stringify(snapshot.programme.doc)),watchlist&&JSON.parse(JSON.stringify(watchlist))),publishedAt:snapshot.programme.asOf};
 }else{
  // A watchlist alone has no schedule: `shows` are unknown (not empty) and the page labels them so. Not for a Watchlist authority fault: membership is never rebuilt from a mirror here.
  if(error?.watchlistAuthority){degradedEvent('mirror_fallback_unusable',{route:'programme',reason:'watchlist_authority_fault'});return null;}
  const stamp=snapshot.watchlist.doc.updatedAt??snapshot.watchlist.asOf;
  if(!stamp){degradedEvent('mirror_fallback_unusable',{route:'programme',reason:'no_snapshot_time'});return null;}
  const films=snapshot.watchlist.doc.films.map(film=>({...film,shows:Array.isArray(film.shows)?film.shows:[]}));
  body={runId:null,updatedAt:stamp,publishedAt:snapshot.watchlist.asOf,films,watchlistCount:films.length,scheduleUnavailable:true};
 }
 return degradedResponse(body,error?.watchlistAuthority?{...snapshot,joined:'none'}:snapshot,error,'programme');
}
async function degradedWatchlistResponse(env,error){
 const snapshot=await degradedSnapshot(env,error,'watchlist');
 if(!snapshot)return null;
 let body;
 if(error?.watchlistAuthority){
  // ADR 0186 decision 8.6: only a validated STANDALONE current Watchlist mirror (labelled with its snapshot version and success time) may answer; membership is never built from a programme or an EPG copy.
  const doc=snapshot.watchlist?.doc;
  if(!(doc&&doc.source==='watchlist_authority'&&Number.isInteger(doc.snapshotVersion)&&typeof doc.lastSuccessAt==='string')){degradedEvent('mirror_fallback_unusable',{route:'watchlist',reason:'no_standalone_watchlist_mirror'});return null;}
  body={...doc};
 }else body=snapshot.watchlist?{...snapshot.watchlist.doc}:{updatedAt:snapshot.programme.doc.updatedAt??null,films:snapshot.programme.doc.films};
 return degradedResponse(body,snapshot,error,'watchlist');
}
// The film page of a verified TMDB movie from the mirrors (C1). Never a 404/410/409: an identity the mirrors cannot prove is `null` here and the caller keeps its typed 503.
async function degradedFilmResponse(env,tmdbId,error){
 const snapshot=await degradedSnapshot(env,error,'catalog_film');
 if(!snapshot)return null;
 const identity=await MirrorRead.findMirrorFilm(env,snapshot,tmdbId);
 if(identity.state!=='found'){degradedEvent('mirror_fallback_unusable',{route:'catalog_film',reason:identity.reason});return null;}
 const meta=MirrorRead.mirrorMeta(identity.pair||snapshot,degradedReason(error));
 degradedLastAt=Date.now();
 degradedEvent('mirror_fallback_activated',{route:'catalog_film',reason:meta.reason,runId:identity.provenance.runId,asOf:identity.provenance.asOf});
 return json({status:'found',programmeRunId:identity.provenance.runId,generatedAt:identity.provenance.asOf,...meta,runId:identity.provenance.runId,asOf:identity.provenance.asOf,availability:'unverified',provenance:identity.provenance,...(identity.disputed?{disputedAttributes:['title','year']}:{}),degraded:['predictions','metadata','facts','shows_unverified'],film:identity.film},200,{'X-Data-Origin':'mirror'});
}
// The server-side write fence (ADR 0177 decision 7). A client that rendered from a mirror labels every mutating request `X-Data-Origin: mirror`: it is refused even when D1 has recovered, so a
// stale degraded page cannot write before it has completed an authoritative refresh. Film-dependent writes may also send `X-Expected-Run`: a different current run is a 409, an unreadable one a 503.
// Requests without these headers are not touched. This runs before any handler, so no route can be skipped.
const DEGRADED_WRITE_RUN_ROUTES=['/api/started','/api/catalog/watched'];
async function degradedWriteFence(request,env,url){
 if(['GET','HEAD','OPTIONS'].includes(request.method))return null;
 const origin=request.headers.get('X-Data-Origin');
 if(origin!==null&&origin!=='authoritative'){
  degradedEvent('degraded_write_refused',{route:'write',reason:origin==='mirror'?'degraded_origin':'invalid_origin_header'});
  return json({error:'Writes are refused for data read from a saved copy; refresh first',code:'degraded_origin_write_refused'},409);
 }
 const expected=request.headers.get('X-Expected-Run');
 if(expected!==null&&DEGRADED_WRITE_RUN_ROUTES.includes(url.pathname)){
  if(!DEGRADED_RUN_ID.test(expected))return json({error:'Invalid X-Expected-Run',code:'invalid_expected_run'},400);
  let current;
  try{current=await epgPublicationReadOnly(env);}
  catch{return json({error:'The published generation is not readable right now',code:'published_epg_unavailable'},503);}
  if(current?.programmeRunId!==expected){
   degradedEvent('degraded_write_refused',{route:'write',reason:'published_generation_changed'});
   return json({error:'The published generation changed; refresh and try again',code:'published_generation_changed'},409);
  }
 }
 return null;
}
function catalogBridgeIds({catalog,programme,watchlist,index,film}){
 const ids=[];
 if(film?.id!=null)ids.push(String(film.id));
 for(const record of Object.values(catalog||{}))if(record?.id!=null)ids.push(String(record.id));
 for(const item of [...(programme?.films||[]),...(watchlist?.films||[])])if(item?.id!=null)ids.push(String(item.id));
 for(const id of Object.keys(index||{}))ids.push(String(id));
 return ids;
}
async function catalogMetadataRead(env,ids){
 if(typeof CanonicalCatalogReader==='undefined')return {gate:null,records:(await loadJSON(env,'metadata.json'))||{}};
 const gate=await CanonicalCatalogReader.catalogReaderGate(env);
 if(gate.mode!=='d1')return {gate,records:(await loadJSON(env,'metadata.json'))||{}};
 return {gate,records:await CanonicalCatalogReader.catalogMetadataFromD1(env,ids,gate)};
}
async function catalogMetadataFinish(env,gate){
 if(gate)await CanonicalCatalogReader.catalogReaderStill(env,gate);
}
async function epgPublication(env){
 return epgPublicationReadOnly(env);
}
// The publication as `epgPublication` reports it (authority, run, phase, fence, generation), SELECTs only. Compatibility mirrors
// are reconciled by the EPG writer (`EpgOrchestration.ensure` on the hourly tick and the publication/revert tails), never here.
// The generation fence is kept: the caller reads its documents at this exact generation (`readDocumentAt` re-checks it before and after).
async function epgPublicationReadOnly(env){
 if(typeof PublishedEpg!=='undefined'){
  const live=await PublishedEpg.currentGeneration(env);
  if(live)return {authority:'d1',programmeRunId:live.programmeRunId,phase:live.phase,etag:live.fence,fence:live.fence,generation:live.generation};
 }
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 return {authority:'r2',programmeRunId:generation?.programmeRunId??null,phase:generation?.phase??null,etag:pointer?.etag??null,fence:pointer?.etag??null};
}
async function pinEpg(env){
 if(env.epgPin?.programmeRunId||env.epgPin?.authority==='d1')return env;
 if(typeof PublishedEpg!=='undefined'){
  const live=await PublishedEpg.currentGeneration(env);
  if(live)return {...env,epgPin:{authority:'d1',programmeRunId:live.programmeRunId,phase:live.phase,fence:live.fence,generation:live.generation}};
 }
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if(!pointer)return env;
 const generation=await pointer.json();
 return generation?.phase==='published'&&generation.programmeRunId?{...env,epgPin:{programmeRunId:generation.programmeRunId}}:env;
}
async function loadEpgSnapshot(env){
 const pinned=await pinEpg(env);
 const [programme,discovery,catalog]=await Promise.all([loadJSON(pinned,'programme.json'),loadJSON(pinned,'epg/discovery-latest.json'),loadJSON(pinned,'epg/discovered-films.json')]);
 return {programmeRunId:pinned.epgPin?.programmeRunId||null,programme,discovery,catalog};
}
// Read-only catalog of verified films outside the watchlist that are available now, in the 72-hour
// catch-up or within the next 24 hours of the published generation, with their stored current prediction.
// Everything is derived in memory from the pinned generation, the watchlist, the view index and the current
// profile: no R2 write, no model call, no TMDB call, no sync. The catalogue shape of `/api/programme` is not
// changed. Films whose shows belong to another generation, whose prediction is not current for the profile,
// whose identity is unverified, or that are watched, rated or on the watchlist are not returned.
const CATALOG_ARCHIVE_MS=72*3600000,CATALOG_FUTURE_MS=24*3600000;
// AIR-433 (ADR 0114, owner decisions of 2026-11-11): one lifecycle for every catalog entry. The film `availability`, `availableNow`, `availableUntil` and the
// per-show `status` all come from the shared helper, so they cannot contradict each other. The effective end of a show is its EPG end, else start + the film
// runtime (minutes), else unknown. `shows[].end` stays the EPG end only when it is valid (a time after the start); an absent, null or malformed end is `null`, never 0. Show status: future | on_air | archive | expired | unknown. `availableNow` is `availability.state === 'available'` (a ready
// recording exists; a show on air is not one). `availableUntil` is the end of the archive window of the latest ready show, null when nothing is ready.
function catalogLifecycle(shows,runtime,now){
 const options={runtimeMinutes:runtime},list=shows.map(show=>({start:Number(show.start),end:show.end}));
 const availability=FilmAvailability.filmAvailability(list,now,options);
 const {state,label,appearsAt,appearsAtKnown,appearsAtEstimated,archiveUntil,onAir}=availability;
 return {
  shows:shows.map(show=>{const phase=FilmAvailability.showPhase({start:Number(show.start),end:show.end},now,options);
   return {channelId:show.channelId??null,channel:show.channel??null,start:Number(show.start),end:phase.endSource==='epg'?phase.end:null,effectiveEnd:phase.end,status:phase.phase==='invalid'?'unknown':phase.phase};}),
  availableNow:state==='available',
  availableUntil:archiveUntil===null?null:new Date(archiveUntil).toISOString(),
  availability:{state,label,appearsAt,appearsAtKnown,appearsAtEstimated,archiveUntil,onAir}};
}
function catalogPerson(person){return {id:String(person.id),name:person.name||person.original||null};}
// Poster fallback from the stored Letterboxd metadata cache (`metadata.json`). Nothing is fetched or invented. A cached poster is
// reused for the same stored id (cached TMDB id equal or absent) or for the same TMDB id, and only while every cached record for that
// key agrees: once two records disagree the key is conflicted for good, whatever records follow and in whatever order. A conflicted
// TMDB identity also blocks the stored-id path, so a disagreement anywhere for the film's identity yields no poster.
function storedPoster(value){return typeof value==='string'&&value.startsWith('https://')?value:null;}
function catalogPosters(metadata){
 const byId=new Map(),byTmdb=new Map(),conflictedIds=new Set(),conflictedTmdb=new Set();
 const agree=(map,conflicted,key,value,same)=>{if(conflicted.has(key))return;if(!map.has(key)){map.set(key,value);return;}if(!same(map.get(key),value)){map.delete(key);conflicted.add(key);}};
 for(const [id,record] of Object.entries(metadata||{})){
  const poster=storedPoster(record?.poster);if(!poster)continue;
  const tmdbId=record.tmdbId==null||record.tmdbId===''?null:String(record.tmdbId);
  agree(byId,conflictedIds,String(record.id??id),{poster,tmdbId},(a,b)=>a.poster===b.poster&&a.tmdbId===b.tmdbId);
  if(tmdbId)agree(byTmdb,conflictedTmdb,tmdbId,poster,(a,b)=>a===b);
 }
 return film=>{
  const own=storedPoster(film.poster);if(own)return {poster:own,source:'catalog'};
  const tmdbId=String(film.tmdbId);
  if(conflictedTmdb.has(tmdbId))return {poster:null,source:null};
  const same=byId.get(String(film.id));
  if(same&&(same.tmdbId===null||same.tmdbId===tmdbId))return {poster:same.poster,source:'metadata_cache'};
  const shared=byTmdb.get(tmdbId);
  return shared?{poster:shared,source:'metadata_cache'}:{poster:null,source:null};
 };
}
// AIR-382. A catalog film has no Letterboxd page of its own: `url` is its TMDB page. A Letterboxd link is exposed only when stored records
// prove it: a record (metadata cache, watchlist, programme) with a Letterboxd id, that TMDB id and a canonical `https://letterboxd.com/film/<slug>/`
// URL, while the Letterboxd id bridges to that one TMDB id in every stored record and every record of the TMDB id gives the same URL. Anything
// else (no record, two ids, two URLs, a malformed URL) yields no link. Titles and slugs are never compared or guessed, and nothing is fetched.
const CATALOG_LETTERBOXD_URL=/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/;
function catalogLetterboxdUrls({metadata,watchlist,programme,catalog}){
 const byLid=catalogLidTmdb({metadata,watchlist,programme,catalog}),byTmdb=new Map(),conflicted=new Set();
 const add=(id,tmdbId,url)=>{
  if(id==null||tmdbId==null||tmdbId===''||typeof url!=='string'||!CATALOG_LETTERBOXD_URL.test(url))return;
  const lid=String(id),tmdb=String(tmdbId);
  if(CATALOG_TMDB_ID.test(lid)||byLid.get(lid)!==tmdb||conflicted.has(tmdb))return;
  if(!byTmdb.has(tmdb))byTmdb.set(tmdb,url);else if(byTmdb.get(tmdb)!==url){byTmdb.delete(tmdb);conflicted.add(tmdb);}
 };
 for(const [id,record] of Object.entries(metadata||{}))add(record?.id??id,record?.tmdbId,record?.url);
 for(const film of [...(watchlist?.films||[]),...(programme?.films||[])])add(film?.id,film?.tmdbId,film?.url);
 return film=>byTmdb.get(String(film.tmdbId))||null;
}
// Films the owner has watched or rated, as TMDB ids, so a catalog record is excluded whatever id it uses. A view-index entry
// counts when it is watched (`watched: true`, projected from fact records) or carries an actual rating (also the legacy index).
// The entry's own TMDB id comes from a `tmdb_<n>` key; a Letterboxd id is bridged to a TMDB id only through a stored id: the
// metadata cache, the watchlist, the programme or a verified catalog record with that id, and only while all of them agree. A
// Letterboxd id with two stored TMDB ids, or with none, is matched by its own id alone. Titles are never compared.
const CATALOG_TMDB_ID=/^tmdb_([1-9]\d*)$/;
const catalogConsumed=item=>item?.watched===true||item?.actualRating!=null;
// A watchlist fact, either value, is membership. It is not a first-watch offer. Missing the field leaves the other rules alone.
const catalogWatchlistFact=item=>item?.watchlist===true||item?.watchlist===false;
// Letterboxd lid to one TMDB id, only while every stored id agrees. Two ids, or none, leave the lid unbridged. Titles are never read.
function catalogLidTmdb({metadata,watchlist,programme,catalog}){
 const byLid=new Map(),conflicted=new Set();
 const add=(id,tmdbId)=>{
  if(id==null||tmdbId==null)return;const lid=String(id),tmdb=String(tmdbId);
  if(CATALOG_TMDB_ID.test(lid)||!/^[1-9]\d*$/.test(tmdb)||conflicted.has(lid))return;
  if(!byLid.has(lid))byLid.set(lid,tmdb);else if(byLid.get(lid)!==tmdb){byLid.delete(lid);conflicted.add(lid);}
 };
 for(const [id,record] of Object.entries(metadata||{})){
  const lid=String(record?.id??id);
  // D1 identityBlocked is the negative canonical verdict (conflicting/untrusted TMDB or Letterboxd claims).
  // A null tmdbId alone is absence, not a veto; watchlist/programme must not restore a blocked lid.
  if(record?.identityBlocked===true){
   conflicted.add(lid);byLid.delete(lid);
   if(record.id!=null){const own=String(record.id);conflicted.add(own);byLid.delete(own);}
   continue;
  }
  add(record?.id??id,record?.tmdbId);
 }
 for(const film of [...(watchlist?.films||[]),...(programme?.films||[])])add(film?.id,film?.tmdbId);
 for(const film of Object.values(catalog||{}))if(film?.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId))add(film.id,film.tmdbId);
 return byLid;
}
function catalogMatchedTmdb(index,byLid,accept){
 const matched=new Set();
 for(const [id,item] of Object.entries(index||{})){if(!accept(item))continue;const tmdb=CATALOG_TMDB_ID.exec(id)?.[1]||byLid.get(id);if(tmdb)matched.add(tmdb);}
 return matched;
}
function catalogConsumedTmdb(input){return catalogMatchedTmdb(input.index,catalogLidTmdb(input),catalogConsumed);}
function catalogWatchlistTmdb(input){return catalogMatchedTmdb(input.index,catalogLidTmdb(input),catalogWatchlistFact);}
// Display-only exclusion of watched export films without a proven identity (ADR-0028). It reads one private list of normalized
// export names and years on every request, and removes a catalog film from this response only. No variable selects it: the
// former FINDS_TITLE_EXCLUSION switch is retired (ADR 0041) and a stale binding is inert. The rule
// writes nothing and is never identity, a fact or a rating. A missing, oversized or invalid list hides nothing, and the
// response says only `state` and a count, never a title, an id or a hash of the list.
const FINDS_TITLE_EXCLUSION_KEY='letterboxd/display-exclusion.json',FINDS_TITLE_EXCLUSION_MAX_BYTES=2*1024*1024,FINDS_TITLE_EXCLUSION_MAX_ENTRIES=20000;
// The rule tag selects the catalog guard: the legacy tag keeps the ADR-0028 guard exactly, the v2 tag the ADR-0033 one; any
// other tag makes the list unavailable. A deploy therefore changes nothing until a list with the v2 tag is placed.
const FINDS_TITLE_RULES=new Set(['strict_original_exact_year','strict_original_exact_year_v2']);
// normTitle_v1: must stay identical to normTitle in src/letterboxd-match.js, which the offline builder uses; a test compares them.
const findsTitleKey=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const FINDS_HEX64=/^[0-9a-f]{64}$/,FINDS_ISO=/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z)?$/;
const findsPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const findsExactKeys=(value,keys)=>findsPlain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const findsTime=value=>typeof value==='string'&&FINDS_ISO.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
// The matching keys and rule tag of a valid list, or null. Entries are canonical (already normalized, strictly ascending by title then year,
// so a duplicate is invalid) and their JSON must hash to contentSha256.
async function findsTitleExclusionKeys(list,now){
 if(!findsExactKeys(list,['schemaVersion','kind','rule','normalization','source','builtAt','counts','entries','contentSha256']))return null;
 if(list.schemaVersion!==1||list.kind!=='letterboxd_display_exclusion'||!FINDS_TITLE_RULES.has(list.rule)||list.normalization!=='normTitle_v1')return null;
 const source=list.source;
 if(!findsExactKeys(source,['type','archiveSha256','exportedAt','baselinePlanSha256'])||source.type!=='letterboxd_export'||!FINDS_HEX64.test(source.archiveSha256)||!FINDS_HEX64.test(source.baselinePlanSha256))return null;
 const exportedAt=findsTime(source.exportedAt),builtAt=findsTime(list.builtAt);
 // A list built before its export or in the future has dates nobody can vouch for.
 if(exportedAt===null||builtAt===null||exportedAt>builtAt||builtAt>now+5*60*1000)return null;
 const entries=list.entries;
 if(!Array.isArray(entries)||entries.length>FINDS_TITLE_EXCLUSION_MAX_ENTRIES)return null;
 if(!findsPlain(list.counts)||!Object.values(list.counts).every(value=>Number.isInteger(value)&&value>=0)||list.counts.entries!==entries.length)return null;
 const keys=new Set();let previous=null;
 for(const entry of entries){
  if(!findsExactKeys(entry,['title','year'])||typeof entry.title!=='string'||!entry.title||entry.title.length>300||findsTitleKey(entry.title)!==entry.title)return null;
  if(!Number.isInteger(entry.year)||entry.year<1870||entry.year>2100)return null;
  if(previous&&!(previous.title<entry.title||previous.title===entry.title&&previous.year<entry.year))return null;
  keys.add(entry.title+'\u0000'+entry.year);previous=entry;
 }
 if(typeof list.contentSha256!=='string'||!FINDS_HEX64.test(list.contentSha256))return null;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(entries)));
 if([...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')!==list.contentSha256)return null;
 return {keys,rule:list.rule};
}
// The size check uses the R2 object size before the body is read or parsed.
async function loadFindsTitleExclusion(env,now){
 const unavailable={state:'unavailable',keys:null};
 try{
  const object=await env.BUCKET.get(FINDS_TITLE_EXCLUSION_KEY);
  if(!object)return unavailable;
  if(!Number.isInteger(object.size)||object.size>FINDS_TITLE_EXCLUSION_MAX_BYTES){await object.body?.cancel?.();return unavailable;}
  const text=await object.text();
  if(new TextEncoder().encode(text).length>FINDS_TITLE_EXCLUSION_MAX_BYTES)return unavailable;
  const valid=await findsTitleExclusionKeys(JSON.parse(text),now);
  return valid?{state:'applied',...valid}:unavailable;
 }catch{return unavailable;}
}
// Whether a verified catalog record is hidden. Original title only, exact year; a TMDB film with a stored Letterboxd id is left
// to identity (metadata cache, watchlist, programme, a verified catalog record keyed by a Letterboxd id); and catalog uniqueness:
// - legacy tag: no other verified TMDB film of this catalog carries the key as its original title, localized title or alias,
//   in any year;
// - v2 tag: no other TMDB film carries it as its original or localized title, in any year, and every other TMDB film that
//   carries it only as an alias has an integer year at least two years from the record's on every verified record.
function findsTitleSuppressor({keys,rule,catalog,metadata,watchlist,programme}){
 const verified=Object.values(catalog||{}).filter(film=>film&&film.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId));
 const relaxed=rule==='strict_original_exact_year_v2',namesakes=new Map(),aliasOnly=new Map(),years=new Map(),linked=new Set();
 const add=(map,key,tmdbId)=>{if(!key)return;if(!map.has(key))map.set(key,new Set());map.get(key).add(tmdbId);};
 for(const film of verified){
  const tmdbId=String(film.tmdbId),aliases=(Array.isArray(film.aliases)?film.aliases:[]).map(findsTitleKey);
  if(!years.has(tmdbId))years.set(tmdbId,[]);years.get(tmdbId).push(film.year);
  for(const key of [findsTitleKey(film.original),findsTitleKey(film.title)])add(namesakes,key,tmdbId);
  for(const key of aliases)add(relaxed?aliasOnly:namesakes,key,tmdbId);
 }
 // An alias-only namesake within a year of the record, or without a year, may be the very film the export entry names.
 const aliasFar=(key,tmdbId,year)=>[...(aliasOnly.get(key)||[])].every(other=>other===tmdbId||namesakes.get(key)?.has(other)||years.get(other).every(value=>Number.isInteger(value)&&Math.abs(value-year)>=2));
 const link=(id,tmdbId)=>{if(id==null||tmdbId==null||tmdbId==='')return;if(!CATALOG_TMDB_ID.test(String(id)))linked.add(String(tmdbId));};
 for(const [id,record] of Object.entries(metadata||{}))link(record?.id??id,record?.tmdbId);
 for(const film of [...(watchlist?.films||[]),...(programme?.films||[]),...verified])link(film?.id,film?.tmdbId);
 return film=>{
  if(!Number.isInteger(film.year))return false;
  const key=findsTitleKey(film.original),tmdbId=String(film.tmdbId);
  if(!key||!keys.has(key+'\u0000'+film.year))return false;
  const owners=namesakes.get(key);
  return owners?.size===1&&owners.has(tmdbId)&&!linked.has(tmdbId)&&(!relaxed||aliasFar(key,tmdbId,film.year));
 };
}
// ADR 0142 decisions 11 and 13: under an authoritative D1 published run, Finds and the film page take the showings of a Film EXCLUSIVELY from the completed programme read (member
// `films` and non-member `catalogFilms`, matched by TMDB id). An absent Film is zero showings; the shows of the admission payload are never a second source, even for the pinned
// run. Outside D1 (R2 authority) the record's own shows stay as before.
function completedShowsByTmdb(programme){
 const out=new Map();
 for(const entry of [...(programme?.films||[]),...(programme?.catalogFilms||[])]){
  if(entry?.tmdbId==null||!Array.isArray(entry.shows))continue;
  const key=String(entry.tmdbId);out.set(key,[...(out.get(key)||[]),...entry.shows]);
 }
 return out;
}
function withCompletedShows(film,completed,programmeRunId,completedOnly){
 if(!completedOnly||!film||typeof film!=='object')return film;
 const shows=film.tmdbId==null?[]:dedupeShows(completed?.get(String(film.tmdbId))||[]);
 return {...film,shows,showsProgrammeRunId:programmeRunId};
}
function catalogAvailable({catalog,programme,watchlist,index,profile,metadata,programmeRunId,pinned,completedOnly=false,now,titleExclusion={state:'unavailable',keys:null},freshness=strictFreshness(profile),watchedMarkEnabled=false}){
 const from=now-CATALOG_ARCHIVE_MS,to=now+CATALOG_FUTURE_MS,excluded=new Set(),posterFor=catalogPosters(metadata),posterSource=new Map(),orderOf=new Map();
 for(const film of [...(programme?.films||[]),...(watchlist?.films||[])]){if(film?.id!=null)excluded.add(String(film.id));if(film?.tmdbId)excluded.add('tmdb:'+String(film.tmdbId));}
 const bridge={index,metadata,watchlist,programme,catalog},consumedTmdb=catalogConsumedTmdb(bridge),watchlistTmdb=catalogWatchlistTmdb(bridge);
 const letterboxdFor=catalogLetterboxdUrls({metadata,watchlist,programme,catalog}),hidden=titleExclusion.state==='applied'?findsTitleSuppressor({keys:titleExclusion.keys,rule:titleExclusion.rule,catalog,metadata,watchlist,programme}):null,hiddenIdentities=new Set();
 const byIdentity=new Map();
 const completed=completedOnly&&programme?.runId===programmeRunId?completedShowsByTmdb(programme):new Map();
 for(const record of Object.values(catalog||{})){
  const film=withCompletedShows(record,completed,programmeRunId,completedOnly);
  if(!film||!film.tmdbId||film.canonicalIdentity!=='tmdb:'+String(film.tmdbId))continue;
  if(typeof policyExcludedPresentedFilm==='function'&&policyExcludedPresentedFilm(film))continue;
  const id=String(film.id),identity=film.canonicalIdentity;
  if(excluded.has(id)||excluded.has(identity))continue;
  const item=index?.[id];
  // Watched or rated, under this id or any id of the same TMDB film: never offered, so a prediction never stands in for a rating.
  if(catalogConsumed(item)||catalogWatchlistFact(item)||consumedTmdb.has(String(film.tmdbId))||watchlistTmdb.has(String(film.tmdbId)))continue;
  // The same freshness rule as the queue and the view, for the same profile snapshot.
  if(!profile||!freshness.indexed(item,film))continue;
  if(!Array.isArray(film.shows)||film.showsProgrammeRunId!==programmeRunId)continue;
  const shows=dedupeShows(film.shows).filter(show=>Number(show.start)>from&&Number(show.start)<to).sort((a,b)=>Number(a.start)-Number(b.start)||String(a.channelId||'').localeCompare(String(b.channelId||''),'en'));
  if(!shows.length)continue;
  // Checked last, so the count covers only films the response would otherwise offer.
  if(hidden?.(film)){hiddenIdentities.add(identity);continue;}
  // `order` is only the list order and the choice between two ids of one identity (the latest start + 72 h, as before); it is not a field of the entry.
  const latest=Math.max(...shows.map(show=>Number(show.start))),order=latest+CATALOG_ARCHIVE_MS,future=shows.filter(show=>Number(show.start)>now),lifecycle=catalogLifecycle(shows,film.runtime,now);
  const prediction=item.prediction,fingerprint=item.fingerprint&&item.fingerprint.fingerprintHash===item.fingerprintHash?item.fingerprint:null,facet=canonicalMoodFacet(fingerprint,prediction);
  const artwork=posterFor(film),letterboxdUrl=letterboxdFor(film);
  const entry={id,tmdbId:String(film.tmdbId),canonicalIdentity:identity,title:film.title||null,original:film.original||null,year:film.year??null,runtime:film.runtime??null,genres:Array.isArray(film.genres)?film.genres:[],poster:artwork.poster,url:film.url||null,...(letterboxdUrl?{letterboxdUrl}:{}),
   directors:(film.directors||[]).map(catalogPerson),actors:(film.actors||[]).map(catalogPerson),
   ...lifecycle,nextStart:future.length?Number(future[0].start):null,
   prediction:{predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus??null,confidence:prediction.confidence??null,...(Object.hasOwn(prediction,'confidenceAssessment')?{confidenceAssessment:prediction.confidenceAssessment,fingerprintHash:prediction.fingerprintHash??null}:{}),matchSignals:Array.isArray(prediction.matchSignals)?prediction.matchSignals:[],mainRisk:prediction.mainRisk??null,moodIds:facet.moodIds},
   fingerprint:fingerprint?{plotMechanics:fingerprint.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(fingerprint.execution)}:null};
  posterSource.set(entry,artwork.source);orderOf.set(entry,order);
  const kept=byIdentity.get(identity);
  if(!kept||order>orderOf.get(kept)||(order===orderOf.get(kept)&&id<kept.id))byIdentity.set(identity,entry);
 }
 const films=[...byIdentity.values()].sort((a,b)=>orderOf.get(a)-orderOf.get(b)||a.id.localeCompare(b.id,'en'));
 const channels=new Map();
 for(const film of films)for(const channelId of new Set(film.shows.map(show=>show.channelId))){const show=film.shows.find(item=>item.channelId===channelId),entry=channels.get(channelId)||{channelId,channel:show.channel,films:0};entry.films++;channels.set(channelId,entry);}
 // Where each returned poster came from, counted over the returned films only, so a plain GET shows how many still lack an asset.
 const posterCoverage={catalog:0,metadataCache:0,missing:0};
 for(const film of films){const source=posterSource.get(film);if(source==='catalog')posterCoverage.catalog++;else if(source==='metadata_cache')posterCoverage.metadataCache++;else posterCoverage.missing++;}
 const displayExclusion={state:titleExclusion.state,excluded:[...hiddenIdentities].filter(identity=>!byIdentity.has(identity)).length};
 return {programmeRunId,pinned,watchedMarkEnabled,generatedAt:new Date(now).toISOString(),window:{from:new Date(from).toISOString(),to:new Date(to).toISOString()},profile:profile?{version:profile.version}:null,total:films.length,posterCoverage,displayExclusion,films,channels:[...channels.values()].sort((a,b)=>String(a.channelId).localeCompare(String(b.channelId),'en'))};
}
// AIR-387. The permanent film page of one verified catalog film, whatever its shows, its prediction or the watchlist say. It is the same
// catalog entry shape as `catalogAvailable` (so the client's similar-films ranking reads it unchanged), but without any eligibility rule: no
// window, no consumed/watchlist exclusion, no title exclusion. What it never does is invent: a prediction only when the stored one is current
// for the current profile and fingerprint, shows only when the record's shows were written by the pinned generation (zero shows is a valid
// answer), a Letterboxd link only when stored records prove it. No write, no fetch.
const CATALOG_FILM_TMDB=/^[1-9]\d{0,11}$/;
// AIR-475 (production acceptance): the owner's facts and the stored forecast of a retained Film live under its Letterboxd lid in the view index, while the permanent page is asked by `tmdb_<n>`.
// `alias` is the index entry of the lid the D1 identity bridge verified (never a title, year or slug match); the two entries are merged field by field: the entry that holds a prediction supplies
// it with its fingerprint, a rating known on both and different is unknown, a watched mark on either counts. Nothing is invented: no entry, no field.
const catalogKnownRating=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
function catalogMergedItem(primary,alias){
 const a=primary&&typeof primary==='object'?primary:null,b=alias&&typeof alias==='object'?alias:null;
 if(!a||!b)return a||b||undefined;
 const holder=a.prediction?a:b.prediction?b:a,item={...b,...a,...(holder.prediction?{prediction:holder.prediction,fingerprint:holder.fingerprint,fingerprintHash:holder.fingerprintHash,impactFeatures:holder.impactFeatures}:{})};
 const ra=catalogKnownRating(a.actualRating),rb=catalogKnownRating(b.actualRating);
 if(ra!==null&&rb!==null&&ra!==rb)delete item.actualRating;else if(ra===null&&rb!==null)item.actualRating=rb;else if(ra!==null)item.actualRating=ra;
 item.watched=a.watched===true||b.watched===true;
 return item;
}
function catalogFilmPage({film:stored,programmeRunId,completedOnly=false,index,alias=null,profile,metadata,watchlist,programme,freshness,now}){
 const film=withCompletedShows(stored,completedOnly&&programme?.runId===programmeRunId?completedShowsByTmdb(programme):new Map(),programmeRunId,completedOnly);
 const id=String(film.id),tmdbId=String(film.tmdbId),item=catalogMergedItem(index?.[id],alias?index?.[alias]:null),artwork=catalogPosters(metadata)(film);
 const letterboxdUrl=catalogLetterboxdUrls({metadata,watchlist,programme,catalog:{[id]:film}})(film);
 // The compatibility evaluator decides (ADR 0031: `current` and `compatible` are both a usable forecast, only a real `stale` verdict is not): never a comparison of version numbers. A stale forecast
 // is still shown, marked with the evaluator's own reason; the stored fingerprint is shown whatever the forecast's freshness, because it is the film's own stored facts.
 const stored_=profile&&item?.prediction?item.prediction:null,verdict=stored_?freshness.verdictOf?.(item,film)??null:null;
 const current=!!(profile&&item?.prediction&&freshness.indexed(item,film));
 const prediction=stored_?{...stored_,...(current?{}:{stale:true,staleReason:verdict?.reason||'stale'}),...(verdict?.outcome==='compatible'||verdict?.outcome==='current'?{compatibility:verdict.outcome}:{})}:null;
 const fingerprint=item?.fingerprint&&typeof item.fingerprint==='object'&&item.fingerprint.fingerprintHash===item.fingerprintHash?item.fingerprint:null,facet=fingerprint||prediction?canonicalMoodFacet(fingerprint,prediction):null,rating=catalogKnownRating(item?.actualRating);
 const shows=programmeRunId&&film.showsProgrammeRunId===programmeRunId&&Array.isArray(film.shows)?dedupeShows(film.shows).sort((a,b)=>Number(a.start)-Number(b.start)||String(a.channelId||'').localeCompare(String(b.channelId||''),'en')):[];
 const future=shows.filter(show=>Number(show.start)>now);
 return {id,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:film.title||null,original:film.original||null,year:film.year??null,runtime:film.runtime??null,genres:Array.isArray(film.genres)?film.genres:[],poster:artwork.poster,url:film.url||null,...(letterboxdUrl?{letterboxdUrl}:{}),
  directors:(film.directors||[]).map(catalogPerson),actors:(film.actors||[]).map(catalogPerson),
  // AIR-656: the canonical fallback's honest completeness: truncated by the read bound, and credits omitted for lack of a usable name. Absent on a complete, fully named cast.
  ...(film.creditsPartial===true?{creditsPartial:true}:{}),...(Number.isInteger(film.creditsUnnamed)&&film.creditsUnnamed>0?{creditsUnnamed:film.creditsUnnamed}:{}),
  ...catalogLifecycle(shows,film.runtime,now),nextStart:future.length?Number(future[0].start):null,
  // The owner's own facts (ratings domain): the known Letterboxd rating and the watched mark, shown for any retained Film whether or not it is on the watchlist; a watched film without a rating has none.
  actualRating:rating,watched:item?.watched===true,
  prediction:prediction?{predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus??null,confidence:prediction.confidence??null,...(Object.hasOwn(prediction,'confidenceAssessment')?{confidenceAssessment:prediction.confidenceAssessment,fingerprintHash:prediction.fingerprintHash??null}:{}),matchSignals:Array.isArray(prediction.matchSignals)?prediction.matchSignals:[],mainRisk:prediction.mainRisk??null,moodIds:facet.moodIds,tasteProfileVersion:Number.isInteger(prediction.tasteProfileVersion)?prediction.tasteProfileVersion:null,...(prediction.compatibility?{compatibility:prediction.compatibility}:{}),...(prediction.stale?{stale:true,staleReason:prediction.staleReason}:{})}:null,
  fingerprint:fingerprint?{plotMechanics:fingerprint.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(fingerprint.execution)}:null};
}
// The state of one TMDB movie identity among the catalog records read for it. Only a record whose identity is exactly `tmdb:<n>` is a film here;
// a record of that number with another identity is a conflict, and a superseded one is retired, never silently replaced by another record.
function catalogFilmState(records,tmdbId){
 const identity='tmdb:'+tmdbId;
 const same=records.filter(record=>String(record.tmdbId)===tmdbId);
 if(!same.length)return {state:'absent'};
 const verified=same.filter(record=>record.canonicalIdentity===identity&&record.film?.canonicalIdentity===identity&&String(record.film?.tmdbId)===tmdbId&&String(record.film?.id)===record.filmId);
 const current=verified.filter(record=>record.state==='current');
 if(current.length===1)return {state:'found',film:current[0].film};
 if(current.length>1)return {state:'conflict'};
 if(same.some(record=>record.state==='pending'))return {state:'unavailable'};
 if(verified.length&&verified.every(record=>record.state==='superseded'))return {state:'retired'};
 return {state:'conflict'};
}
// AIR-409: a canonical Film admitted by a verified rated archive (letterboxd/admissions/verified-films.json) that Discovery never admitted. At `open` (AIR-475) the fallback is
// the D1 canonical Film itself (catalogCanonicalFilmFromD1), whatever admissions it has; the R2 receipt below is only the pre-open reader.
// Read only, only when Discovery says "absent" and only while the Film/Person authority names R2 (legacy, the explicit local stand-in only; ADR 0099, ADR 0162): `held`, `open` and an
// unreadable marker fail closed and never fall back to R2. The receipt is the R2 identity decision, so it is bounded by the owner's R2 retirements
// object and by D1 contradictions (a conflicting or second trusted TMDB id, a redirected Film); a Film whose projection is still pending is found. The entry must verify exactly as the rated-archive admission rules require (key tmdb_<n>, tmdb equal to the key,
// short code, sha256 digest, verification time, no watchlist field); anything else is not a Film here. Nothing is scanned: one key of one object.
const CATALOG_ADMISSION_KEY='letterboxd/admissions/verified-films.json';
const CATALOG_ADMISSION_SHORT=/^[A-Za-z0-9_-]{1,40}$/,CATALOG_ADMISSION_HEX=/^[0-9a-f]{64}$/;
function catalogAdmittedFilm(document,tmdbId){
 if(!document||typeof document!=='object'||Array.isArray(document)||document.schemaVersion!==1||!document.films||typeof document.films!=='object'||Array.isArray(document.films)){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';throw error;}
 const key='tmdb_'+tmdbId;
 if(!Object.prototype.hasOwnProperty.call(document.films,key))return null;
 const item=document.films[key];
 if(!item||typeof item!=='object'||Array.isArray(item)||Object.prototype.hasOwnProperty.call(item,'watchlist'))return null;
 if(String(item.tmdb)!==tmdbId||typeof item.sourceCode!=='string'||!CATALOG_ADMISSION_SHORT.test(item.sourceCode)||typeof item.archiveSha256!=='string'||!CATALOG_ADMISSION_HEX.test(item.archiveSha256)||typeof item.verifiedAt!=='string'||!Number.isFinite(Date.parse(item.verifiedAt)))return null;
 const person=value=>Array.isArray(value)?value.filter(entry=>entry&&typeof entry==='object'&&entry.id!=null&&(entry.name||entry.original)):[];
 return {id:key,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:typeof item.title==='string'&&item.title?item.title:null,original:null,year:Number.isInteger(item.year)?item.year:null,runtime:Number.isInteger(item.runtime)?item.runtime:null,genres:Array.isArray(item.genres)?item.genres.filter(g=>typeof g==='string'):[],url:typeof item.url==='string'&&item.url.startsWith('https://')?item.url:null,directors:person(item.directors),actors:person(item.actors),shows:[]};
}
async function catalogArchiveFallback(env,tmdbId){
 const gate=await FilmPersonAuthority.readAuthority(env);
 // AIR-374 P4 (owner decision 4): at `open` the R2 receipt and the R2 retirements object are frozen compatibility copies and are never read; the verified admission,
 // the identity claims and the retirement ledger come from D1. held and an unreadable marker fail closed (503) and never reach R2.
 if(gate.state==='open')return CanonicalCatalogReader.catalogCanonicalFilmFromD1(env,tmdbId);
 if(!gate.r2Allowed){const error=new Error(gate.state==='held'?'film_person_held':'film_person_not_open_read');error.code=error.message;throw error;}
 // Only the explicit local stand-in (a domain that is not installed) reaches the R2 receipt (ADR 0162); a marker that cannot move cannot be re-read.
 return catalogArchiveFallbackR2(env,tmdbId);
}
async function catalogArchiveFallbackR2(env,tmdbId){
 const retirements=await loadJSON(env,'identity/tmdb-retirements.json');
 if(retirements!=null){
  const set=tmdbRetirementSet(retirements);
  if(!set.ok){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';throw error;}
  if(set.retirements.some(item=>String(item.movieId)===tmdbId))return {state:'retired'};
 }
 const archive=await loadJSON(env,CATALOG_ADMISSION_KEY);
 if(archive==null)return {state:'absent'};
 const film=catalogAdmittedFilm(archive,tmdbId);
 if(!film)return {state:'absent'};
 return {state:'found',film};
}
// AIR-475 review: Discovery is an independent domain. These are the ways its reader can refuse; while the Film/Person marker is open a refusal never hides a canonical Film.
const CATALOG_DISCOVERY_FAULTS=['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative'];
// AIR-531: HTTP status of the HTML document `/film/<id>`, in the SPA's own order (`resolveFilm`): (1) a film of the pinned published generation by its own id (programme or
// watchlist member, one indexed point read) is 200 whatever the catalog says; (2) a `tmdb_<n>` id then looks at the published films that own that TMDB id through their trusted
// link (`memberTmdbOwners`, keyed and fenced by the publication generation): one owner is 200, several are 409, BEFORE the catalog is asked, as the page does; (3) the bounded
// catalog identity decision (no enrichment, no write, no outbound request) gives 404 absent, 410 retired, 409 conflict. An id of another shape that is no member is 404. Only a definite
// answer sets a non-200 status: when the generation, a member read, the owner map or the catalog cannot answer, nothing is proven absent and the shell is 200 (the page decides).
// A catalog answer is a definite absence only when the published side was read completely. No published generation at all (no D1 binding or no pointer) has no members.
async function filmDocumentStatus(env,id){
 const tmdb=/^tmdb_(.+)$/.exec(id);
 if(tmdb&&!CATALOG_FILM_TMDB.test(tmdb[1]))return 404;
 let live=null,unknown=false;
 if(typeof PublishedEpg!=='undefined'&&PublishedEpg.hasDatabase(env)){
  try{
   const generation=await PublishedEpg.currentGeneration(env);
   if(generation&&generation.programmeRunId)live=generation;
   if(live&&await PublishedEpg.isMember(env,live.programmeRunId,id))return 200;
  }catch{unknown=true;}
 }
 if(!tmdb)return live&&!unknown?404:200;
 if(live&&!unknown){
  try{
   const owners=(await PublishedEpg.memberTmdbOwners(env,live.programmeRunId,live.generation)).get(tmdb[1]);
   if(owners)return owners.size===1?200:409;
  }catch{unknown=true;}
 }
 const identity=await catalogFilmIdentity(env,tmdb[1]);
 if(identity.fault)return 200;
 const status={absent:404,retired:410,conflict:409}[identity.found.state]||200;
 return unknown?200:status;
}
// AIR-531: the identity decision of `/api/catalog/film/<tmdbId>` and nothing else: found, absent, retired, conflict or unavailable, or a typed fault. No programme, watchlist,
// metadata, prediction or ratings read happens here, so the HTML document status can use it without the enrichment of the full answer.
async function catalogFilmIdentity(env,tmdbId){
 let found,discoveryFault=null;
 try{
  try{
   const admission=typeof DiscoveryAuthority!=='undefined'?await DiscoveryAuthority.readFilmAdmission(env,tmdbId):{handled:false};
   if(admission.handled)found=catalogFilmState(admission.records,tmdbId);
   else{
    // Discovery still on R2: the one shared catalog object, filtered by identity (no D1 here, nothing is superseded).
    const shared=await loadJSON(env,'epg/discovered-films.json');
    // A missing or malformed catalog object is a source that cannot be read, not proof that the film was never admitted.
    if(!shared||typeof shared!=='object'||Array.isArray(shared)){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';throw error;}
    found=catalogFilmState(Object.entries(shared||{}).filter(([,film])=>film&&String(film.tmdbId)===tmdbId).map(([filmId,film])=>({filmId,state:'current',canonicalIdentity:film.canonicalIdentity,tmdbId:String(film.tmdbId),film})),tmdbId);
   }
  }catch(error){
   if(!CATALOG_DISCOVERY_FAULTS.includes(error?.code))throw error;
   discoveryFault=error;
  }
  if(discoveryFault){
   // Discovery cannot answer (held, loading, unreadable). Only an open Film/Person marker lets the canonical Film answer for it; anything else keeps the Discovery refusal.
   if((await FilmPersonAuthority.readAuthority(env)).state!=='open')throw discoveryFault;
   found=await catalogArchiveFallback(env,tmdbId);
   // A canonical absence says nothing about a catalog that could not be read: the Discovery refusal stands.
   if(found.state==='absent')throw discoveryFault;
  }
  else if(found.state==='absent')found=await catalogArchiveFallback(env,tmdbId);
 }catch(error){
  const code=error?.code||'';
  if(['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative','film_person_held','film_person_unavailable','film_person_not_open_read','film_person_generation_moved','canonical_read_unavailable','admission_unavailable','canonical_read_not_authoritative'].includes(code))return {fault:'unavailable',reason:code,temporary:isTemporaryReadFault(error)};
  return {fault:'error'};
 }
 return {found};
}
async function catalogFilmRoute(env,tmdbId){
 if(!CATALOG_FILM_TMDB.test(tmdbId))return json({status:'invalid',error:'A TMDB movie id is a positive integer'},400);
 const now=Date.now();
 const identity=await catalogFilmIdentity(env,tmdbId);
 if(identity.fault==='unavailable'){
  // AIR-541 (ADR 0177): only a typed TEMPORARY fault may be answered from the mirrors; a structural refusal keeps its 503.
  if(identity.temporary){const degraded=await degradedFilmResponse(env,tmdbId,{code:identity.reason,temporary:true});if(degraded)return degraded;}
  return json({status:'unavailable',error:'The catalog is not readable right now',reason:identity.reason},503);
 }
 if(identity.fault)return json({status:'error',error:'The catalog lookup failed'},500);
 const found=identity.found;
 if(found.state==='absent')return json({status:'absent'},404);
 if(found.state==='retired')return json({status:'retired'},410);
 if(found.state==='conflict')return json({status:'conflict'},409);
 if(found.state==='unavailable')return json({status:'unavailable',error:'The catalog is being updated',reason:'discovery_pending'},503);
 // The optional context degrades to "nothing known": a film with no shows, no prediction and no Letterboxd link is still a film.
 const degraded=[],optional=async(name,load)=>{try{return await load();}catch{degraded.push(name);return null;}};
 const publication=await optional('publication',()=>epgPublicationReadOnly(env));
 const pinnedRunId=publication?.phase==='published'&&publication.programmeRunId?publication.programmeRunId:null;
 const [programme,watchlist,index,profile]=await Promise.all([
  pinnedRunId?optional('programme',()=>catalogGenerationCopy(env,publication,pinnedRunId,'programme.json')):null,
  optional('watchlist',async()=>composeWatchlistRead(env,await(publication?.authority==='d1'&&pinnedRunId?PublishedEpg.readDocumentAt(env,pinnedRunId,'watchlist',publication.generation):loadJSON(env,'watchlist.json')),null)),
  optional('index',()=>loadJSON(env,ENRICHMENT_KEY+'view-index.json')),
  optional('profile',()=>loadJSON(env,profileKey)),
 ]);
 let metadata=null,metaGate=null;
 try{
  const read=await catalogMetadataRead(env,catalogBridgeIds({film:found.film,watchlist,programme,index}));
  metadata=read.records;metaGate=read.gate;
 }
 catch(error){
  const refused=isTemporaryReadFault(error)?null:titleReadRefusal(error);
  if(refused)return refused;
  degraded.push('metadata');
 }
 const runId=programme?.runId&&programme.runId===pinnedRunId?pinnedRunId:null;
 if(pinnedRunId&&!runId&&!degraded.includes('programme'))degraded.push('programme');
 const freshness=profile?await optional('freshness',()=>predictionFreshness(env,profile)):null;
 // The Letterboxd lid the D1 identity bridge verified for this TMDB id (open marker only): the owner's facts and the stored forecast are indexed under it. A contested or unreadable identity is degraded, never guessed.
 const alias=await optional('identity',async()=>{
  if((await CanonicalCatalogReader.catalogReaderGate(env)).mode!=='d1')return null;
  const bridge=await CanonicalCatalogReader.catalogFilmIdentityBridge(env,'tmdb_'+tmdbId);
  if(bridge.state==='conflict'||bridge.state==='retired')degraded.push('identity');
  return bridge.state==='ok'&&bridge.lid?bridge.lid:null;
 });
 // The forecast, the fingerprint and the owner's facts of exactly the two verified spellings come from the D1 domains that own them while those are d1 and open, whether or not the R2 view index holds the
 // keys (the index is only the seed and the fallback of a domain that is not d1). Two bounded reads per domain, nothing written; an unreadable domain is a 503, never a stale mirror.
 let facts;
 try{
  const keys=[...new Set(['tmdb_'+tmdbId,alias].filter(Boolean))];
  facts=Object.fromEntries(keys.map(key=>[key,index?.[key]||{}]));
  if(typeof PredictionD1!=='undefined')facts=await PredictionD1.projectItems(env,keys,facts,canonicalMoodFacet);
  if(typeof RatingsD1!=='undefined')facts=await RatingsD1.viewItems(env,keys,facts);
 }catch(error){
  const code=String(error?.code||'');
  if(code.startsWith('prediction_')||code.startsWith('ratings_'))return json({status:'unavailable',error:'The catalog is not readable right now',reason:code},503);
  throw error;
 }
 const page=catalogFilmPage({film:found.film,alias,programmeRunId:runId,completedOnly:publication?.authority==='d1'&&!!pinnedRunId,index:facts,profile:freshness?profile:null,metadata,watchlist,programme,freshness:freshness||{indexed:()=>false},now});
 try{await catalogMetadataFinish(env,metaGate);}
 catch(error){if(isTemporaryReadFault(error))degraded.push('metadata');else{const refused=titleReadRefusal(error);if(refused)return refused;throw error;}}
 return json({status:'found',programmeRunId:runId,generatedAt:new Date(now).toISOString(),...(degraded.length?{degraded}:{}),film:page});
}
// The owner's watched mark on a Finds card (ADR-0032): one verified film of the published catalog copy, named by its TMDB id only.
// It writes the owner's `watched` fact through the fact records and nothing else. It has no switch: the former
// FINDS_WATCHED_MARK (ADR 0042) and LETTERBOXD_FACTS (ADR 0055) are retired, and a stale binding of either is inert. The request guard is
// stricter than the shared one: a same-origin Origin is required, the body must be JSON and hold exactly `tmdbId` and `watched`;
// a title, year or Letterboxd id is never read.
const FINDS_WATCHED_TMDB=/^[1-9]\d{0,11}$/;
async function catalogWatchedRoute(request,env,url){
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
 if(!/^application\/json(\s*;|$)/i.test(request.headers.get('Content-Type')||''))return json({error:'Expected application/json'},415);
 const text=await request.text();
 if(text.length>512)return json({error:'Request too large'},400);
 let body;try{body=JSON.parse(text);}catch{return json({error:'Invalid JSON'},400);}
 const keys=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort():[];
 if(keys.join()!=='tmdbId,watched'||typeof body.tmdbId!=='string'||!FINDS_WATCHED_TMDB.test(body.tmdbId)||typeof body.watched!=='boolean')return json({error:'Expected exactly tmdbId (digits) and watched (boolean)',code:'invalid_request'},400);
 // The same pinned, authority-aware read as GET /api/catalog/available (`catalogGenerationCopy`): with Discovery on D1 the generation
 // catalog is D1-owned and there is no R2 copy. Anything that stops the catalog from being read is unavailability (503, its own
 // code), never `film_not_in_catalog`; only a catalog that was read and does not hold the verified film is that 409.
 const unavailable=(code,error='The catalog is not readable right now')=>json({error,code},503);
 const publication=await epgPublication(env);
 const runId=publication.phase==='published'&&publication.programmeRunId?publication.programmeRunId:null;
 if(!runId)return unavailable('catalog_not_published','No published catalog generation');
 // The Discovery authority the verdict is read under, captured before the read: mode, cutover, generation, programme run and transfer.
 const discoveryState=gate=>gate?[gate.mode,gate.cutover,gate.generation,gate.programmeRunId,gate.transfer,gate.ready].join('|'):'none';
 let catalog,opened=null;
 try{
  if(typeof DiscoveryAuthority!=='undefined'){
   opened=await DiscoveryAuthority.readAuthority(env);
   if(opened.ready&&opened.transfer==='loading'){const error=new Error('discovery_incomplete');error.code='discovery_incomplete';throw error;}
  }
  catalog=await catalogGenerationCopy(env,publication,runId,'discovered-films.json');
 }
 catch(error){return unavailable(['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative'].includes(error?.code)?error.code:'catalog_read_failed');}
 if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return unavailable('catalog_generation_unavailable','The catalog copy of the published generation is not in place');
 const film=Object.values(catalog).find(item=>item&&String(item.tmdbId)===body.tmdbId&&item.canonicalIdentity==='tmdb:'+body.tmdbId);
 if(!film)return json({error:'Film is not a verified record of the published catalog',code:'film_not_in_catalog'},409);
 // Fence: the verdict above holds only while the publication and the Discovery authority are still the ones it was read under.
 try{
  const again=await epgPublicationReadOnly(env);
  if(again.programmeRunId!==runId||again.phase!==publication.phase||again.fence!==publication.fence||again.authority!==publication.authority)return unavailable('catalog_generation_changed','The published generation changed; try again');
  if(typeof DiscoveryAuthority!=='undefined'){
   // Immediately before the write the authority must still be the one the catalog was read under: same mode and cutover (a D1 to R2
   // switch is a change), same generation, same published run, not held and not loading. The R2-owned path (not ready: the explicit local stand-in only, ADR 0162) stays R2.
   const gate=await DiscoveryAuthority.readAuthority(env);
   if(gate.ready&&gate.transfer==='loading')return unavailable('discovery_incomplete');
   if(discoveryState(gate)!==discoveryState(opened)||gate.ready&&gate.programmeRunId!==runId)return unavailable('catalog_generation_changed','The published generation changed; try again');
  }
 }catch{return unavailable('catalog_read_failed');}
 try{
  const result=await LetterboxdFacts.recordOwnerWatchedMark(env,body.tmdbId,body.watched,{observedAt:new Date().toISOString()});
  return json({outcome:result.outcome,watched:result.watched});
 }catch(error){
  if(error instanceof LetterboxdFacts.FactsError)return json({error:'Could not record the mark; try again',code:error.code},409);
  throw error;
 }
}
// The generation's own copy of a published document, strictly pinned: with a published pointer an absent copy fails closed instead of
// falling back to the shared public keys (the shared `loadJSON` fallback is unchanged for other routes). Shared by the catalog routes.
// `options.project` (catalog only, AIR-586) is the DiscoveryAuthority projection: applied row by row to a D1 catalog, and to the parsed object of an
// R2 copy (the explicit local stand-in), so both paths answer the same projected catalog.
async function catalogGenerationCopy(env,publication,pinnedRunId,name,options=null){
  if(name==='discovered-films.json'&&typeof DiscoveryAuthority!=='undefined'){
   const gate=await DiscoveryAuthority.readAuthority(env);
   if(gate.ready){
    if(!pinnedRunId||gate.programmeRunId!==pinnedRunId)return null;
    const routed=await DiscoveryAuthority.routeRead(env,epgGenerationKey(pinnedRunId,'discovered-films.json'),options);
    if(!routed.handled){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';throw error;}
    return routed.value;
   }
  }
  if(publication.authority==='d1'&&name==='programme.json')return pinnedRunId?PublishedEpg.readDocumentAt(env,pinnedRunId,'programme',publication.generation):null;
  const object=await env.BUCKET.get(epgGenerationKey(pinnedRunId,name));
  const value=object?await object.json():null;
  return name==='discovered-films.json'?projectCatalogObject(value,options):value;
}
// The same projection over a catalog that is already a whole object (an R2 copy): each film mapped, `undefined` left out, anything else unchanged.
function projectCatalogObject(catalog,options){
 const project=typeof options?.project==='function'?options.project:null;
 if(!project||!catalog||typeof catalog!=='object'||Array.isArray(catalog))return catalog;
 const out={};
 for(const [id,film] of Object.entries(catalog)){const value=project(film);if(value!==undefined)out[id]=value;}
 return out;
}
// AIR-586. GET /api/programme presents only its own `catalogFilms` entries (`presentCatalogFilms` looks each one up by TMDB id), so it keeps only the
// catalog films of those TMDB ids instead of every admitted film. The kept records are the stored ones, unchanged: the presentation is the same.
function programmeCatalogProjection(entries){
 const wanted=new Set();
 for(const entry of entries||[])if(entry?.tmdbId!=null)wanted.add(String(entry.tmdbId));
 return {project:film=>film&&typeof film==='object'&&film.tmdbId!=null&&wanted.has(String(film.tmdbId))?film:undefined};
}
async function catalogAvailableRoute(env){
 const now=Date.now();
 const publication=await epgPublication(env);
 const pinnedRunId=publication.phase==='published'&&publication.programmeRunId?publication.programmeRunId:null;
 const generationCopy=name=>catalogGenerationCopy(env,publication,pinnedRunId,name);
 const wbox={};
 const watchlistLoad=Promise.resolve(publication.authority==='d1'&&pinnedRunId?PublishedEpg.readDocumentAt(env,pinnedRunId,'watchlist',publication.generation):loadJSON(env,'watchlist.json')).then(document=>composeWatchlistRead(env,document,null,wbox));
 let programme,catalog,watchlist,index,profile,metadata,titleExclusion,metaGate=null;
 try{
  // AIR-586: the programme is read first, so the catalog can keep whole only the films that air in it (`availableCatalogProjection`).
  const programmeRead=pinnedRunId?generationCopy('programme.json'):loadJSON(env,'programme.json');
  const others=Promise.all([watchlistLoad,loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,profileKey),loadFindsTitleExclusion(env,now)]);
  others.catch(()=>{});
  programme=await programmeRead;
  const projection=availableCatalogProjection(programme,pinnedRunId||programme?.runId||null,publication.authority==='d1'&&!!pinnedRunId);
  [catalog,[watchlist,index,profile,titleExclusion]]=await Promise.all([pinnedRunId?catalogGenerationCopy(env,publication,pinnedRunId,'discovered-films.json',projection):loadJSON(env,'epg/discovered-films.json').then(value=>projectCatalogObject(value,projection)),others]);
  const read=await catalogMetadataRead(env,catalogBridgeIds({catalog,programme,watchlist,index}));
  metadata=read.records;metaGate=read.gate;
 }catch(error){
  const refused=discoveryUserReadRefusal(error)||titleReadRefusal(error);
  if(refused)return refused;
  // ADR 0186: a Watchlist authority fault keeps its typed answer (409 moved, 503 otherwise); there is no mirror for this route.
  const faulted=watchlistRouteFault(error)||(error?.watchlistAuthority?json({error:'storage_unavailable',reason:error.code},503):null);
  if(faulted)return faulted;
  throw error;
 }
 if(pinnedRunId&&(!programme||programme.runId!==pinnedRunId))return json({error:'Programme generation is not in place'},409);
 if(pinnedRunId&&!catalog)return json({error:'Catalog generation copy is not in place'},409);
 if(!programme?.runId||!Array.isArray(programme.films))return json({error:'No published programme'},503);
 // The ratings seed is applied to an in-memory copy. GET /api/enrichment/view uses the same overlay and neither persists it.
 const seeded=overlayRatingsSeed(index);
 const freshness=await predictionFreshness(env,profile);
 try{await catalogMetadataFinish(env,metaGate);await watchlistStill(env,wbox);}
 catch(error){const refused=titleReadRefusal(error)||watchlistRouteFault(error);if(refused)return refused;throw error;}
 return json(catalogAvailable({catalog,programme,watchlist,index:seeded,profile,metadata,programmeRunId:pinnedRunId||programme.runId,pinned:!!pinnedRunId,completedOnly:publication.authority==='d1'&&!!pinnedRunId,now,titleExclusion,freshness,watchedMarkEnabled:true}));
}
// AIR-586. `catalogAvailable` offers a catalog film only when it has a show in the window: with a D1 published run the shows come from the completed
// programme (`completedShowsByTmdb`), otherwise from the record's own `shows`. Every other film is only looked at by the identity bridge
// (`catalogLidTmdb`, `catalogBridgeIds`) and the display title exclusion (`findsTitleSuppressor`), which read the fields of the skeleton below, and is
// then skipped by the loop before anything else of it is read. Such a film is therefore kept as that skeleton instead of its whole payload. The test
// here is a superset of the window (any show at all), so a film the response can offer is always kept whole and the response is unchanged.
const AVAILABLE_SKELETON_FIELDS=['id','tmdbId','canonicalIdentity','title','original','aliases','year'];
function availableCatalogProjection(programme,programmeRunId,completedOnly){
 const completed=completedOnly?(programme?.runId===programmeRunId?completedShowsByTmdb(programme):new Map()):null;
 return {project:film=>{
  if(!film||typeof film!=='object')return film;
  const airs=completed?film.tmdbId!=null&&(completed.get(String(film.tmdbId))||[]).length>0:Array.isArray(film.shows)&&film.shows.length>0;
  if(airs)return film;
  const skeleton={};
  for(const field of AVAILABLE_SKELETON_FIELDS)if(Object.hasOwn(film,field))skeleton[field]=film[field];
  return skeleton;
 }};
}
function publicEpgKey(name){return name==='programme.json'?name:'epg/'+name;}
async function updatePublishedFiles(env,files){
 const publication=await epgPublication(env);
 if(!publication.programmeRunId||publication.phase!=='published'){for(const [name,value] of Object.entries(files))await saveJSON(env,publicEpgKey(name),value);return null;}
 for(const [name,value] of Object.entries(files))await saveJSON(env,epgGenerationKey(publication.programmeRunId,name),value);
 const again=await epgPublication(env);
 if(again.programmeRunId!==publication.programmeRunId||publication.etag&&again.etag!==publication.etag)throw new Error('EPG generation changed during publish');
 for(const [name,value] of Object.entries(files))await saveJSON(env,publicEpgKey(name),value);
 return publication.programmeRunId;
}
// AIR-348 / ADR 0100: a mutation boundary of an EPG step. A step that no longer holds its lease under the mode revision it was admitted
// with (the owner closed admission, or the lease ran out) stops here and the write does not happen. A no-op outside such a step.
async function epgStepGuard(env){if(env?.epgStep&&typeof EpgOrchestration!=='undefined')await EpgOrchestration.assertStep(env);}
async function putStoredJson(env,key,text){
 if((key==='titles.json'||key==='people.json')&&await frozenCanonicalMirrorsLocked(env))return {skipped:'canonical_mirror_frozen'};
 return env.BUCKET.put(key,text,{httpMetadata:{contentType:'application/json'}});
}
// ADR 0185. The EPG run checkpoint and the ingest status are a D1 authority only while the checkpoint marker says `d1`. With the tables absent (schema below 30) or the
// marker `r2` the R2 objects serve exactly as before; `closed` (an unreadable or contradicting state) refuses, never R2. The marker is read at most once per two seconds per
// database binding: every write in d1 mode is also fenced by the authority generation inside its batch, and the cutover procedure drains the writers before it switches.
const EPG_CHECKPOINT_KEYS=new Set(['sync.json','watchlist-ingest.json']);
const checkpointMarks=new WeakMap();
async function epgCheckpointState(env){
 if(typeof EpgCheckpointD1==='undefined')return {state:'r2',writes:'open'};
 const binding=EpgCheckpointD1.bindingOf(env),db=binding&&typeof binding==='object'?binding:null,now=Date.now(),cached=db?checkpointMarks.get(db):null;
 if(cached&&now-cached.at<2000)return cached.value;
 const gate=await EpgCheckpointD1.readAuthority(env);
 const value=gate.state==='d1'?{state:'d1',writes:gate.writes}:gate.state==='r2'?{state:'r2',writes:gate.writes}:gate.state==='legacy'?{state:'r2',writes:'open'}:{state:'closed'};
 if(db)checkpointMarks.set(db,{at:now,value});
 return value;
}
function checkpointError(reason){const error=new Error('epg_checkpoint_'+reason);error.code='epg_checkpoint_'+reason;return error;}
async function loadCheckpointRun(env){
 const out=await EpgCheckpointD1.loadRun(env);
 if(!out.ok)throw checkpointError(out.reason==='malformed'?'malformed':'unavailable');
 return out.run;
}
// The fence of one checkpoint write: the step the Workflow or the external path holds, never a fence-less fallback.
function checkpointStep(env){
 if(!env?.epgStep||env.epgFence==null)throw checkpointError('unfenced');
 const now=Date.now(),margin=typeof EpgOrchestration!=='undefined'?EpgOrchestration.BOUNDARY_MARGIN_MS:0;
 return {step:env.epgStep,fence:env.epgFence,leaseBound:new Date(now+margin).toISOString(),now};
}
// AIR-571 (C3): the root `watchlist.json` mirror is written by ONE guarded function (PublishedEpg.putWatchlistRoot: read the object, check the Watchlist marker AFTER the read, conditional put by etag).
// null = there is no object-store binding to guard (the local stand-in): the caller keeps its own storage path.
async function saveWatchlistRoot(env,value){
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.putWatchlistRoot!=='function'||!PublishedEpg.hasBucket(env))return null;
 const out=await PublishedEpg.putWatchlistRoot(env,value);
 return out.blocked?{skipped:'watchlist_root_not_writable'}:{etag:out.etag};
}
const saveJSON=async(env,key,value)=>{
 await epgStepGuard(env);
 if(EPG_CHECKPOINT_KEYS.has(key)){
  const gate=await epgCheckpointState(env);
  if(gate.state==='closed')throw checkpointError('unavailable');
  if(gate.state==='r2'&&gate.writes==='held')throw checkpointError('writes_held');
  if(gate.state==='d1'){
   // The ingest status is written only by run creation and by the failure recorder; a run reaches `complete` only through completeCheckpointRun.
   if(key!=='sync.json')throw checkpointError('route');
   const out=await EpgCheckpointD1.saveRun(env,value,checkpointStep(env));
   if(!out.ok)throw checkpointError(out.reason);
   return {etag:'d1'};
  }
 }
 if(key==='watchlist.json'){
  // AIR-571 (C3): the root watchlist mirror has ONE guarded writer. Every fallback tail reaches it through here.
  const routed=await saveWatchlistRoot(env,value);
  if(routed)return routed;
 }
 if(typeof DiscoveryAuthority!=='undefined'&&DiscoveryAuthority.ownsKey(key)){
  const routed=await DiscoveryAuthority.routeWrite(env,key,value);
  if(routed.handled)return;
 }
 if(typeof PredictionD1!=='undefined'){
  const routed=await PredictionD1.saveMutable(env,key,value);
  if(routed?.handled)return {etag:'d1'};
 }
 if(typeof PredictionAux!=='undefined'){const routed=await auxRouteWrite(env,key,value);if(routed.handled)return {etag:'d1'};}
 const saved=await putStoredJson(env,key,JSON.stringify(value));
 if(saved?.skipped==='canonical_mirror_frozen')return saved;
 return saved;
};
function confirmedHalfStar(value){const rating=Number(value);return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0?rating:null;}
function removalRating(film){const rating=confirmedHalfStar(film?.rating);if(rating==null)return null;const observed=typeof film.ratingObservedAt==='string'&&Number.isFinite(Date.parse(film.ratingObservedAt))?film.ratingObservedAt:null;return observed?{rating,ratingObservedAt:observed}:{rating};}
function trustedMovieTmdbId(film){
 const id=film?.tmdbId==null?'':String(film.tmdbId),link=film?.tmdbLink;
 if(!/^[1-9]\d{0,11}$/.test(id)||link?.status!=='resolved'||link.link?.type!=='movie'||String(link.link.id)!==id)return null;
 return id;
}
function eventTmdb(film){
 if(film?.tmdbId!=null||film?.tmdbLink)return trustedMovieTmdbId(film);
 return film?.tmdb!=null&&/^[1-9]\d{0,11}$/.test(String(film.tmdb))?String(film.tmdb):null;
}
const eventFilm=(film,titles=new Map())=>{const tmdb=eventTmdb(film);return {id:String(film.id),title:(film.titleAuthority==='owner'&&(film.titleRu||film.title))||reviewedTitle(film)?.title||titles.get(String(film.id))||film.title||film.original,year:film.year,...(tmdb?{tmdb}:{})};};
function eventRemovedFilm(film,titles=new Map()){const rating=removalRating(film);return {...eventFilm(film,titles),...(rating||{})};}
// AIR-393: titles of the films a Ratings run changed, from what is already stored (the metadata cache and the title dictionary): no
// external lookup. An id the stores do not know has no label. A TMDB link is given only where every stored id agrees (`catalogLidTmdb`).
async function ratingsFilmLabels(env,ids){
 const wanted=[...new Set((ids||[]).map(String).filter(Boolean))],out=new Map();
 if(!wanted.length)return out;
 const {gate,records:meta}=await catalogMetadataRead(env,wanted);
 let names={};
 try{
  if(gate)names=gate.mode==='d1'?await CanonicalCatalogReader.catalogTitlesFromD1(env,wanted.map(id=>({id,tmdbId:meta[id]?.tmdbId})),gate):(await loadJSON(env,'titles.json').catch(()=>null))||{};
  else names=(await loadJSON(env,'titles.json').catch(()=>null))||{};
 }catch(error){if(TITLE_READ_REFUSALS.includes(error?.code))throw error;names={};}
 const namesObj=names&&typeof names==='object'&&!Array.isArray(names)?names:{};
 const byLid=(!gate||gate.mode!=='d1')?catalogLidTmdb({metadata:meta}):null;
 for(const id of wanted){
  const film=meta[id],cached=namesObj[id];
  const named=film&&typeof film==='object'?eventFilm({...film,id}):null;
  const title=(named&&typeof named.title==='string'&&named.title.trim())||(cached&&typeof cached.title==='string'&&cached.title.trim())||null;
  const bridged=byLid?byLid.get(id):null;
  const direct=film&&film.tmdbId!=null&&/^[1-9]\d*$/.test(String(film.tmdbId))?String(film.tmdbId):null;
  const tmdb=byLid?bridged||null:direct;
  out.set(id,{title,year:named&&Number.isInteger(named.year)?named.year:null,tmdb});
 }
 await catalogMetadataFinish(env,gate);
 return out;
}
const eventTitles=report=>new Map((report?.films||[]).map(f=>[String(f.id),f.title]));
function removalEventKey(event){return 'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';}
function mergeRemovalEvent(stored,incoming){
 if(stored?.type!=='watchlist'||stored.id!==incoming.id||!Array.isArray(incoming.removed))return incoming;
 const previous=new Map((stored.removed||[]).map(film=>[String(film.id),film]));
 return {...incoming,added:(incoming.added||[]).map(film=>eventFilm(film)),removed:incoming.removed.map(film=>{const kept=removalRating(previous.get(String(film.id))),next=removalRating(film);return eventRemovedFilm(kept&&(!next||kept.rating!==next.rating||kept.ratingObservedAt)?{...film,...kept}:film);})};
}
function withRemovalRatings(event,ratings,observedAt){
 if(event?.type!=='watchlist'||!Array.isArray(event.removed))return null;
 const source=ratings instanceof Map?Object.fromEntries(ratings):ratings||{};
 let changed=false;
 const removed=event.removed.map(film=>{if(removalRating(film))return eventRemovedFilm(film);const rating=confirmedHalfStar(source[String(film.id)]);if(rating==null)return eventRemovedFilm(film);changed=true;const stamp=typeof observedAt==='string'&&Number.isFinite(Date.parse(observedAt))?observedAt:null;return eventRemovedFilm({...film,rating,...(stamp?{ratingObservedAt:stamp}:{})});});
 return changed?{...event,added:(event.added||[]).map(film=>eventFilm(film)),removed}:null;
}
async function enrichRecentRemovalRatings(env,ratings,observedAt){
 try{
  if(typeof env.BUCKET.list!=='function')return;
  const source=ratings instanceof Map?Object.fromEntries(ratings):ratings||{};
  if(!Object.values(source).some(value=>confirmedHalfStar(value)!=null))return;
  let cursor,seen=0;
  do{
   const page=await env.BUCKET.list({prefix:'events/items/',limit:20,...(cursor?{cursor}:{})});
   for(const object of page.objects||[]){if(++seen>100)return;const next=withRemovalRatings(await loadJSON(env,object.key),source,observedAt);if(next)await writeEvent(env,next);}
   cursor=page.truncated?page.cursor:undefined;
  }while(cursor);
 }catch{}
}
// AIR-565 (ADR 0198, supersedes the flag of ADR 0191): the Channel policy mode of one EPG scan is unconditional; no Worker variable selects it and an unfiltered `legacy` scan cannot be started.
// ONE snapshot read, materialized into an in-memory map: `filtered` when it is available, non-empty and consistent; `degraded` otherwise (every channel known_only, a warning, no applied revision or digest). A Channel
// authority failure never blocks the EPG and never publishes a silent discover; other mandatory failures keep their earlier behaviour.
async function loadEpgChannelPolicy(env){
 let policy;
 try{policy=await EpgChannelD1.materializePolicies(env);}catch{policy={ok:false,reason:'unavailable'};}
 return policy.ok?{mode:'filtered',revision:policy.revision,digest:policy.digest,map:policy.map}:{mode:'degraded',reason:policy.reason};
}
// The declared XMLTV channels the pinned snapshot lacks are registered by one bounded, idempotent, best-effort batch at the declaration boundary of the single scan pass (origin xmltv, no
// category, known_only). It is not tied to the publication: rows written stay even if the EPG later fails. A failure never fails the scan and never changes the pinned policy; the
// outcome (detected vs registered) is kept for the event and the next natural scan retries.
function epgDeclarationRegistrar(env,holder){
 return async ({channels})=>{
  if(!channels.length){holder.value={ok:true,detected:0,registered:0};return;}
  let outcome;
  try{outcome=await EpgChannelD1.registerXmltvChannels(env,{channels,now:new Date().toISOString()});}catch{outcome={ok:false,reason:'unavailable'};}
  holder.value=outcome.ok?{ok:true,detected:channels.length,registered:outcome.registered,invalid:outcome.invalid}:{ok:false,detected:channels.length,registered:0,reason:outcome.reason};
 };
}
function epgPolicyEventFields(report){
 const policy=report.stats?.policy;
 if(!policy?.applied)return {};
 const degraded=policy.mode==='degraded',registration=policy.registration||null;
 const fields={channels:{...policy.channels,...(degraded?{}:{registered:registration?.registered??0})},programmes:{unclassified:policy.unclassified,filteredDenyAll:policy.filteredDenyAll,skippedKnownOnly:policy.skippedKnownOnly,discoveryEligible:policy.discoveryEligible,raw:report.stats.scanned},policy:{mode:policy.mode,...(degraded?{reason:policy.reason??null}:{revision:policy.revision??null,digest:policy.digest??null}),href:'/admin/channels'}};
 if(degraded)fields.warning={code:'channel_policy_degraded',reason:policy.reason??null};
 else if(registration&&!registration.ok)fields.warning={code:'channel_registration_failed',reason:registration.reason??null};
 return fields;
}
function epgEvent(report,id){const cutoff=Date.parse(report.updatedAt);const archive=f=>f.shows.some(s=>s.start>=cutoff-72*3600000&&s.start<cutoff),future=f=>f.shows.some(s=>s.start>=cutoff&&s.start<cutoff+24*3600000);return {id,type:'epg',at:report.updatedAt,films:report.stats.uniqueFilms??report.films.filter(f=>f.shows?.length).length,archive:report.films.filter(archive).length,future:report.films.filter(future).length,broadcasts:report.films.reduce((n,f)=>n+f.shows.length,0),...epgPolicyEventFields(report)};}
function watchlistEvent(before,after,oldReport,report,id){const oldIds=new Set((before?.films||[]).map(f=>String(f.id))),newIds=new Set(after.films.map(f=>String(f.id)));return {id,type:'watchlist',at:after.updatedAt,total:after.films.length,baseline:!before,added:before?after.films.filter(f=>!oldIds.has(String(f.id))).map(f=>eventFilm(f,eventTitles(report))):[],removed:before?before.films.filter(f=>!newIds.has(String(f.id))).map(f=>eventRemovedFilm(f,eventTitles(oldReport))):[]};}
async function writeEvent(env,event){
 const key=removalEventKey(event);
 if(event?.type!=='watchlist'){await saveJSON(env,key,event);return;}
 for(let attempt=0;attempt<5;attempt++){
  const object=await env.BUCKET.get(key),stored=object?await object.json():null,next=stored?mergeRemovalEvent(stored,event):event;
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved!==null)return next;
 }
 throw new Error('Watchlist event changed during write');
}
// AIR-361: a `ratings` event is immutable and its id is the runId: a second put of the same run finds the key and keeps the first.
async function writeRatingsEvent(env,event){const saved=await env.BUCKET.put(removalEventKey(event),JSON.stringify(event),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});return saved!==null?'written':'exists';}
// AIR-410: a `discovery` event is immutable and its id is the tick id: a second put of the same tick finds the key and keeps the first.
// One Discovery event per generation and hour (ADR 0118): the put is create-only, so a repeat keeps the first. The only replacements allowed are of a REPORT (`kind` `hour`)
// over the `report_failed` notice, or over the `provisional` empty report published without the record write (a window held), of the same hour, by a compare-and-swap on the notice's etag: a report always wins over its hour's notice, a notice never replaces
// anything, so the Events Log cannot hold two events for one hourly firing and the deltas of a report are never dropped because a notice got there first.
async function writeDiscoveryEvent(env,event){
 const key=removalEventKey(event),httpMetadata={contentType:'application/json'};
 const saved=await env.BUCKET.put(key,JSON.stringify(event),{httpMetadata,onlyIf:{etagDoesNotMatch:'*'}});
 if(saved!==null)return 'written';
 if(event?.kind!=='hour')return 'exists';
 const current=await env.BUCKET.get(key);
 if(!current)return 'failed';
 let stored=null;try{stored=await current.json();}catch{stored=null;}
 if(stored?.kind!=='report_failed'&&!(stored?.provisional===true&&event.provisional!==true))return 'exists';
 const replaced=await env.BUCKET.put(key,JSON.stringify(event),{httpMetadata,onlyIf:{etagMatches:current.etag}});
 return replaced!==null?'written':'failed';
}
// AIR-489 / ADR 0166: read-side presentation only. A stored ratings event whose film has no title is shown with the label of the TMDB movie its Letterboxd id has
// been bridged to since (a verified source check), from the facts link and the catalog / rated admission. The stored event is never rewritten; an unbridged id stays unlabelled.
async function presentRatingsEvents(env,events){
 try{
  if(typeof LetterboxdFacts==='undefined'||typeof LetterboxdFacts.tmdbForLids!=='function')return;
  const films=[];
  for(const event of events||[]){if(event?.type!=='ratings'||!event.details)continue;for(const group of ['added','updated','rated'])for(const film of Array.isArray(event.details[group])?event.details[group]:[])if(film&&!film.title&&typeof film.id==='string'&&!film.id.startsWith('tmdb_'))films.push(film);}
  const capped=films.slice(0,50);
  if(!capped.length)return;
  const tmdbs=await LetterboxdFacts.tmdbForLids(env,capped.map(film=>film.id));
  if(!tmdbs.size)return;
  const ids=[...new Set([...tmdbs.values()].map(tmdb=>'tmdb_'+tmdb))],labels=await ratingsFilmLabels(env,ids);
  let admitted=new Map();
  if(ids.some(id=>!labels.get(id)?.title)&&typeof CanonicalCatalogReader!=='undefined')try{admitted=await CanonicalCatalogReader.readAdmissions(env,ids.map(id=>'film:tmdb:'+id.slice(5)));}catch{admitted=new Map();}
  for(const film of capped){
   const tmdb=tmdbs.get(film.id);if(!tmdb)continue;
   const label=labels.get('tmdb_'+tmdb),receipt=admitted.get?.('film:tmdb:'+tmdb)?.ratedAdmission||null,title=(label&&label.title)||(receipt&&receipt.title)||null;
   if(!film.tmdb)film.tmdb=tmdb;
   if(title){film.title=title;if(!Number.isInteger(film.year))film.year=(label&&Number.isInteger(label.year)?label.year:null)??(receipt&&Number.isInteger(receipt.year)?receipt.year:null);}
  }
 }catch{}
}
async function eventPage(env,cursor){const page=await env.BUCKET.list({prefix:'events/items/',limit:20,...(cursor?{cursor}:{})});const events=await Promise.all(page.objects.map(o=>loadJSON(env,o.key)));for(const event of events.filter(Boolean)){if(event.film)event.film=eventFilm(event.film);if(Array.isArray(event.added))event.added=event.added.map(f=>eventFilm(f));if(Array.isArray(event.removed))event.removed=event.removed.map(f=>eventRemovedFilm(f));}await presentRatingsEvents(env,events);return {events:events.filter(Boolean),cursor:page.truncated?page.cursor:null};}
async function bootstrapEvents(env){if(await loadJSON(env,'events/bootstrap.json'))return;
 // Started marks come from the one authority of the request; an unreadable D1 marker or row set stops the bootstrap before any event is written.
 const authority=await startedAuthority(env);let marks=[];
 if(authority.state==='closed')throw new StartedStorageError();
 if(authority.state==='d1'){const read=await StartedD1.listMarks(env);if(!read.ok)throw new StartedStorageError();marks=read.marks;}
 const report=await loadJSON(env,'programme.json'),list=await loadJSON(env,'watchlist.json');if(report)await writeEvent(env,epgEvent(report,'baseline-epg'));if(list)await writeEvent(env,watchlistEvent(null,list,null,report,'baseline-watchlist'));const bootstrapMark=async mark=>{if(mark?.lastEvent){await writeEvent(env,mark.lastEvent);return;}if(mark&&mark.started!==false&&mark.startedAt){const film=report?.films.find(f=>String(f.id)===mark.id)||list?.films.find(f=>String(f.id)===mark.id);if(film)await writeEvent(env,{id:'baseline-started-'+mark.id,type:'started',at:mark.startedAt,film:eventFilm(film,eventTitles(report))});}};
 if(authority.state==='d1'){for(const mark of marks)await bootstrapMark(mark);}
 else{let cursor;do{const page=await env.BUCKET.list({prefix:'started/',...(cursor?{cursor}:{})});for(const o of page.objects)await bootstrapMark(await loadJSON(env,o.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);}
 await saveJSON(env,'events/bootstrap.json',{at:new Date().toISOString()});}
// AIR-549 stage 2: one store per request, chosen by the D1 marker of Started marks. `legacy` (no binding, or schema 29 absent) and `r2` serve the R2 `started/` objects as before;
// `d1` serves the rows and never touches R2 `started/`; a marker that cannot be read answers 503 and never falls back to R2. A held marker refuses every mark write.
async function startedAuthority(env){
 if(typeof StartedD1==='undefined')return {state:'legacy'};
 return StartedD1.readAuthority(env);
}
const STARTED_UNAVAILABLE='Started marks storage unavailable',STARTED_READ_ONLY='Started marks are temporarily read-only';
class StartedStorageError extends Error{constructor(){super(STARTED_UNAVAILABLE);this.name='StartedStorageError';}}
async function startedFilms(env){
 const authority=await startedAuthority(env);
 if(authority.state==='closed')throw new StartedStorageError();
 if(authority.state==='d1'){const read=await StartedD1.listStartedIds(env);if(!read.ok)throw new StartedStorageError();return read.ids;}
 return r2StartedFilms(env);
}
async function r2StartedFilms(env){let cursor;const ids=[];do{const page=await env.BUCKET.list({prefix:'started/',include:['customMetadata'],...(cursor?{cursor}:{})});for(const object of page.objects){const match=object.key.match(/^started\/([a-zA-Z0-9_-]+)\.json$/);if(match&&object.customMetadata?.started!=='false')ids.push(match[1]);}cursor=page.truncated?page.cursor:undefined;}while(cursor);return ids;}
async function setStarted(env,body){
 if(typeof body.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)||typeof body.started!=='boolean')return json({error:'Invalid film or state'},400);
 // AIR-549 stage 2: the store is chosen by the Started marker of this request. A marker that cannot be read, or a held one, refuses the write before any read of a Film or any write; there is no R2 fallback after `d1`.
 const authority=await startedAuthority(env);
 if(authority.state==='closed')return json({error:STARTED_UNAVAILABLE},503);
 if(authority.writes==='held')return json({error:STARTED_READ_ONLY},503);
 const d1=authority.state==='d1',key='started/'+body.id+'.json';
 const readPrevious=async()=>d1?StartedD1.readMark(env,body.id):{ok:true,mark:await loadJSON(env,key)};
 const first=await readPrevious();
 if(!first.ok)return json({error:STARTED_UNAVAILABLE},503);
 let previous=first.mark;
 // AIR-516: the Film is the canonical D1 Film (verified identity bridge, title, year, trusted TMDB claim), never the frozen metadata.json or the programme: a Film outside the EPG and the
 // watchlist is a Film. There is no R2 fallback. The D1 read comes FIRST, for a replay too: a held, not-open or unreadable Film/Person marker answers 503 before any mark write,
 // whether the request is a new mark, an `unstarted` or the idempotent re-delivery of the stored event.
 let lookup;
 try{
  if(typeof CanonicalCatalogReader==='undefined'){const error=new Error('canonical_read_not_authoritative');error.code='canonical_read_not_authoritative';throw error;}
  lookup=await CanonicalCatalogReader.catalogStartedFilm(env,body.id);
 }catch(error){const refused=titleReadRefusal(error);if(refused)return refused;throw error;}
 for(let attempt=0;;attempt++){
  const wasStarted=!!previous&&previous.started!==false;
  // Same state: the stored last event is delivered again under its own key; the mark is not rewritten and the identity is not judged.
  if(wasStarted===body.started){if(previous?.lastEvent)await writeEvent(env,previous.lastEvent);return json({id:body.id,started:body.started});}
  // Only a new mark needs a resolvable identity. Removing an existing mark (`unstarted`) never creates or switches an identity.
  if(body.started&&lookup.state==='conflict')return json({error:'Conflicting film identity'},409);
  if(body.started&&lookup.state==='retired')return json({error:'Film retired'},410);
  if(body.started&&lookup.state!=='found')return json({error:'Unknown film'},404);
  const found=lookup.state==='found'?lookup.film:null,last=previous?.lastEvent?.film;
  // `unstarted` keeps the film of the mark's own last event when the identity no longer resolves, or now resolves to another verified TMDB movie than the one the mark was made for
  // (an identity reassigned since): cancelling a mark never records it for a different movie. Nothing is matched by title or year. A new `started` takes only D1 values; a missing title or
  // year is the neutral placeholder or null, never a value of an earlier R2 event.
  const reassigned=!body.started&&found&&last&&last.id===body.id&&last.tmdb!=null&&String(last.tmdb)!==String(found.tmdb);
  const named=found&&!reassigned?{id:body.id,title:found.title||'Фильм',year:found.year,...(found.tmdb?{tmdb:found.tmdb}:{})}:null;
  const at=new Date().toISOString(),event={id:crypto.randomUUID(),type:body.started?'started':'unstarted',at,film:named?eventFilm(named):last||{id:body.id,title:'Фильм',year:null}};
  if(!d1){
   // An R2 object write has no compare-and-swap: the marker is read once more right before it, so a request admitted before an import hold or the activation answers 503 instead of writing.
   const again=await startedAuthority(env);
   if(again.state==='closed'||again.state==='d1')return json({error:STARTED_UNAVAILABLE},503);
   if(again.writes==='held')return json({error:STARTED_READ_ONLY},503);
   await env.BUCKET.put(key,JSON.stringify({id:body.id,started:body.started,startedAt:body.started?at:null,lastEvent:event}),{httpMetadata:{contentType:'application/json'},customMetadata:{started:String(body.started)}});
   await writeEvent(env,event);return json({id:body.id,started:body.started});
  }
  // A transition must never overwrite an event that may not have reached the journal: the stored event is delivered first (an idempotent write under its own key). If that write fails
  // the request fails and nothing is committed, so the earlier transition stays recoverable and is never replaced unwritten.
  if(previous?.lastEvent)await writeEvent(env,previous.lastEvent);
  const committed=await StartedD1.commitMark(env,{expectedRev:previous?previous.rev:0,mark:{id:body.id,started:body.started,startedAt:body.started?at:null,lastEvent:event}});
  // The event is written after the mark commit, as before; a request that dies in between is repaired by the same-state repeat above, which delivers the stored event under its own id.
  if(committed.ok){await writeEvent(env,event);return json({id:body.id,started:body.started});}
  if(committed.reason==='conflict'&&attempt<2){
   // Another request committed this id first: decide again on the state it left. A same-state winner turns this request into the idempotent repeat of the winner's event.
   const fresh=await StartedD1.readMark(env,body.id);
   if(!fresh.ok)return json({error:STARTED_UNAVAILABLE},503);
   previous=fresh.mark;continue;
  }
  return json({error:committed.reason==='writes_held'?STARTED_READ_ONLY:STARTED_UNAVAILABLE},503);
 }
}
// A failure of the ingest never masks the error that caused it: a superseded failure (an older attempt) and a storage error are logged and dropped.
async function recordCheckpointIngestFailure(env,attempt,lastSuccessAt){
 try{
  const out=await EpgCheckpointD1.recordIngestFailure(env,{attempt,code:'watchlist_failed',failedAt:new Date().toISOString(),lastSuccessAt});
  if(!out.ok||!out.applied){try{console.log(JSON.stringify({event:'epg_ingest_failure_dropped',reason:out.ok?'superseded_failure':out.reason}));}catch{}}
 }catch{try{console.log(JSON.stringify({event:'epg_ingest_failure_dropped',reason:'unavailable'}));}catch{}}
}
// ADR 0186 (AIR-569), DORMANT. The Watchlist is a D1 authority only while the watchlist marker says `d1` (open). With the tables absent (schema below 31), the marker `epg` or no D1 binding, the published
// EPG generation serves the membership and the EPG run fetches Letterboxd exactly as before. A `held` marker, a contradicting state and an unreadable snapshot are refused and never fall back to the EPG
// generation. The marker is read FRESH at every request boundary (no cache), the snapshot read is fenced on the generation it saw, and the route re-reads the marker after its last async step
// (`watchlistStill`), so a switch or a hold between the first read and the answer is never served as the old state.
function watchlistError(code,{temporary=false}={}){const error=new Error(code);error.code=code;error.status=503;error.watchlistAuthority=true;if(temporary)error.temporary=true;return error;}
// A storage error of the marker read is a retryable fault; every other refusal is structural.
function watchlistClosed(gate){return watchlistError(gate.reason==='unavailable'?'watchlist_unavailable':'watchlist_authority_closed',{temporary:gate.reason==='unavailable'});}
async function watchlistAuthorityState(env){
 if(typeof WatchlistD1==='undefined')return {state:'legacy'};
 const db=WatchlistD1.bindingOf(env);
 if(!db&&env?.WATCHLIST_DB_OPTIONAL!=='standin'&&!env?.DB)return {state:'legacy'};
 const gate=await WatchlistD1.readAuthority(env);
 if(gate.state==='legacy')return {state:'legacy'};
 if(gate.state==='d1'||gate.state==='epg')return {state:gate.state,writes:gate.writes,generation:gate.generation};
 return {state:'closed',reason:gate.reason};
}
const watchlistSameGate=(a,b)=>a.state===b.state&&a.writes===b.writes&&a.generation===b.generation;
// The last async boundary of a read route: the marker must still be what the composition saw. A move is a retryable 409, never an answer in the old state.
async function watchlistStill(env,box){
 if(!box?.gate)return;
 const now=await watchlistAuthorityState(env);
 if(!watchlistSameGate(box.gate,now))throw watchlistError('watchlist_authority_moved');
}
// The one read of the EPG run start: the ordered list and the pin of the last COMPLETE snapshot. No wait, no Letterboxd call, no TTL; fail-closed only when no snapshot exists or it is unreadable.
// -> null (legacy: fetch Letterboxd as before) | {films,run,observedAt}
async function epgSnapshotPin(env){
 const gate=await watchlistAuthorityState(env);
 if(gate.state==='epg'||gate.state==='legacy')return null;
 if(gate.state!=='d1')throw watchlistClosed(gate);
 if(gate.writes!=='open')throw watchlistError('watchlist_writes_held');
 const out=await WatchlistD1.pinForEpg(env,{generation:gate.generation});
 if(!out.ok)throw watchlistError(out.reason);
 return {films:out.films,observedAt:out.pin.watchlistObservedAt,run:{version:out.pin.watchlistVersion,snapshotId:out.pin.watchlistSnapshotId,lastSuccessAt:out.pin.watchlistLastSuccessAt,listSha256:out.pin.watchlistListSha256,...(out.warning?{warning:out.warning}:{})}};
}
// The reader seam (ADR 0186 decision 6): membership and order from the CURRENT snapshot, stored shows from the pinned generation. `legacy` is the document the caller loaded as before and is returned
// unchanged unless the marker is `d1`. A read-time composition: it writes nothing and never changes the programme generation (ADR 0107). `box` receives the marker state the answer rests on, for the
// final fence of the route (`watchlistStill`). A lid with no stored record is identified only through a VERIFIED canonical identity: the Film/Person reader must be in `d1` mode, the record must not
// be `identityBlocked` (a conflicting Letterboxd claim) and the reader's own fence must still hold. Anything else leaves the film with no shows (unknown), never a false empty-availability fact.
async function composeWatchlistRead(env,legacy,programme=null,box=null){
 const gate=await watchlistAuthorityState(env);
 if(box)box.gate=gate;
 if(gate.state==='epg'||gate.state==='legacy')return legacy;
 if(gate.state!=='d1')throw watchlistClosed(gate);
 if(gate.writes!=='open')throw watchlistError('watchlist_writes_held');
 const out=await WatchlistD1.readCurrent(env,{generation:gate.generation});
 if(!out.ok){
  if(out.reason==='absent')throw watchlistError('watchlist_snapshot_absent');
  if(out.reason==='held')throw watchlistError('watchlist_writes_held');
  if(out.reason==='moved')throw watchlistError('watchlist_authority_moved');
  if(out.reason==='closed')throw watchlistError('watchlist_authority_closed');
  throw watchlistError('watchlist_unavailable',{temporary:out.reason==='unavailable'});
 }
 const stored=new Set((legacy?.films||[]).map(film=>String(film.id)));
 const added=out.snapshot.films.filter(film=>!stored.has(film.lid)).map(film=>film.lid);
 const identity=new Map();
 if(added.length){
  try{
   const read=await catalogMetadataRead(env,added);
   if(read.gate?.mode==='d1'){
    for(const lid of added){const record=read.records?.[lid];if(record?.tmdbId!=null&&record.identityBlocked!==true)identity.set(lid,record.tmdbId);}
    await catalogMetadataFinish(env,read.gate);
   }
  }catch{identity.clear();}
 }
 const doc=WatchlistComposition.composeWatchlist({snapshot:out.snapshot,generation:{watchlist:legacy,programme},identityByLid:identity}).doc;
 await watchlistStill(env,{gate});
 return doc;
}
// ADR 0186: the prediction queue's membership (priority and hot/cold classification) is the CURRENT Watchlist snapshot when the marker is `d1`; programme and show facts stay with the pinned generation.
// null = the marker is not `d1`: the caller keeps the generation's membership. The same refusals as every reader (held, closed, absent, malformed); read-only, it starts no Discovery or EPG writer.
// ADR 0186 (review 2): every EPG fallback write of the root `watchlist.json` asks the CURRENT authority, never the run's start-time pin: an EPG run started with the marker `epg` and still in flight after
// `epg -> d1` must not write its historical list over the Watchlist's own root mirror. A pinned run never writes it; an unreadable marker fails closed (no write).
async function epgMayWriteWatchlistRoot(env,run){
 if(run?.watchlistSnapshot)return false;
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.watchlistRootOwned!=='function')return true;
 return !(await PublishedEpg.watchlistRootOwned(env));
}
async function watchlistQueueMembership(env,source){
 const legacy={updatedAt:source?.updatedAt??null,films:Array.isArray(source?.films)?source.films:[]};
 const doc=await composeWatchlistRead(env,legacy,source,null);
 return doc===legacy?null:{films:doc.films};
}
async function beginSync(env){
 // ADR 0185: every attempt has an id and a start time taken before the fetch; the ingest status is ordered by them, not by when an attempt finishes.
 const attempt={id:crypto.randomUUID(),startedAt:new Date().toISOString()};
 const checkpointD1=(await epgCheckpointState(env)).state==='d1';
 const current=await loadJSON(env,'sync.json');
 // ADR 0092: an unfinished ledger seal is durable state, not a freshness question. Its run is returned whatever its age, so a cancelled step is resumed by the same runId and never replaced by a new run.
 if(current?.stage==='seal')return {runId:current.runId,stage:current.stage,remaining:current.remaining,seal:current.seal?.phase||null};
 if(current&&['metadata','epg'].includes(current.stage)&&Date.now()-Date.parse(current.updatedAt)<15*60000)return {runId:current.runId,stage:current.stage,remaining:current.remaining};
 if(current?.stage==='epg'){const published=await loadJSON(env,'programme.json');if(published?.runId===current.runId)return {runId:current.runId,stage:current.stage,remaining:current.remaining};}
 if(current?.stage==='complete'&&(current.epgEventPending||await watchlistEventOwed(env,current)))return {runId:current.runId,stage:current.stage,remaining:current.remaining};
 // A job in D1 that sync.json does not name cannot be continued by a new run and is never reset silently.
 if(await sealedPublishAvailable(env)){const durable=await DiscoveryAuthority.sealState(env);if(durable.supported&&['items','archive'].includes(durable.phase))throw Object.assign(new Error('discovery_seal_unfinished'),{status:409,code:'discovery_seal_unfinished'});}
 // ADR 0135: a run created while the pause table exists carries its frozen `runKey`. Unreadable presence is not absence: no new run is started on it (an unfinished run was returned above).
 const pausePresent=await requirePausePresence(env);
 // ADR 0186: a `d1` Watchlist marker replaces the Letterboxd fetch by one read of the last complete snapshot, and the run records it (`watchlistSnapshot`). A refusal is a D1 fault, not a Letterboxd one: it is not an ingest failure.
 const snapshotPin=await epgSnapshotPin(env);
 try{
 let watchlistObservedAt=new Date().toISOString(),pages=0,total=null;const films=new Map();
 if(snapshotPin){for(const film of snapshotPin.films)films.set(film.id,film);total=films.size;watchlistObservedAt=snapshotPin.observedAt;}else{
 const sources=sourceConfig(env);let url=sources.watchlist;const letterboxdScope=upstreamCoordinator(env,'watchlist-sync');
 while(url){const p=parseWatchlist(await getHTML(url,letterboxdScope));pages++;if(pages>100)throw new Error('Watchlist pagination limit exceeded');if(!Number.isInteger(p.total))throw new Error('Watchlist total not found');if(total===null)total=p.total;if(total!==p.total)throw new Error('Watchlist changed during synchronization; retry');if(p.films.length===0&&total>0)throw new Error('Watchlist page has no films');for(const f of p.films){if(films.has(f.id))throw new Error('Duplicate film across pages; retry');films.set(f.id,f);}if(p.next&&!new RegExp('^/'+sources.letterboxdUsername+'/watchlist/page/\\d+/$').test(p.next))throw new Error('Unexpected pagination URL');url=p.next?'https://letterboxd.com'+p.next:null;}
 if(films.size!==total)throw new Error(`Incomplete watchlist: ${films.size}/${total}`);
 const verify=parseWatchlist(await getHTML(sources.watchlist,letterboxdScope));if(verify.total!==total||verify.films.some((f,i)=>f.id!==[...films.values()][i]?.id))throw new Error('Watchlist changed during synchronization; retry');
 }
 const working=await MetadataCache.loadMetadataWorkingSet(env);const cache=working.records;const now=Date.now();const all=[...films.values()].map(f=>MetadataCache.mergeWatchlistFilm(f,cache[f.id]));// ADR 0186: the metadata stage fetches every not-fresh member's Letterboxd page. A run pinned to a Watchlist snapshot never does: it starts at `epg`, and the canonical metadata and admission path belongs to the Letterboxd Sync (AIR-570).
 const pending=snapshotPin?[]:all.filter(f=>MetadataCache.metadataPending(f,now)).map(f=>f.id);
 const gate=await ratingsGate(env);
 if(gate.active&&current)await flushRemovalHandover(env,current);
 const carried=!gate.active&&current?{...(current.removalRefs?{removalRefs:current.removalRefs}:{}),...(current.removalLookups?{removalLookups:current.removalLookups}:{})}:{};
 const lastEpgPublishedAt=typeof epgCarriedPublishedAt==='function'?epgCarriedPublishedAt(current):null;
 const startedNow=new Date();const run={runId:crypto.randomUUID(),startedAt:startedNow.toISOString(),...(typeof OrchestrationPolicy!=='undefined'&&pausePresent?{runKey:OrchestrationPolicy.madridDayKey(startedNow.getTime())}:{}),updatedAt:new Date().toISOString(),stage:pending.length?'metadata':'epg',watchlist:all,pending,...carried,cursor:0,remaining:pending.length,pages,watchlistObservedAt,...(snapshotPin?{watchlistSnapshot:snapshotPin.run}:{}),failures:[],...(current?.ratingObservedAt?{ratingObservedAt:current.ratingObservedAt}:{}),...(lastEpgPublishedAt?{lastEpgPublishedAt}:{})};if(checkpointD1){const created=await EpgCheckpointD1.createRun(env,run,{...checkpointStep(env),attempt});if(!created.ok)throw checkpointError(created.reason);}else{await saveJSON(env,'sync.json',run);if(!snapshotPin)await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,failedAt:null,lastSuccessAt:run.startedAt});}return {runId:run.runId,stage:run.stage,watchlistCount:total,pages,remaining:run.remaining};
 }catch(e){const previous=await loadJSON(env,'sync.json'),ingest=await loadJSON(env,'watchlist-ingest.json'),lastSuccessAt=previous?.stage==='complete'&&!previous.error?previous.updatedAt:ingest?.lastSuccessAt||null;if(snapshotPin){/* not a Letterboxd failure */}else if(checkpointD1)await recordCheckpointIngestFailure(env,attempt,lastSuccessAt);else await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,code:'watchlist_failed',failedAt:new Date().toISOString(),lastSuccessAt});throw e;}
}
// AIR-533: one sanitized `metadata_sync_breakdown` per step on EVERY outcome (`ok`, `incomplete` for an unsettled canonical step, `handled_error`, `thrown`):
// milliseconds and counts only, no Film id. It observes the step and changes none of its results, retries or exceptions.
async function metadataSync(env,run){
 const marks={startedAt:Date.now()};let outcome='thrown',films=0;const errorsBefore=run.canonicalMetadataErrors||0;
 try{
  const result=await metadataSyncStep(env,run,marks);
  films=marks.films||0;
  outcome=run.canonicalMetadataErrors>errorsBefore?'handled_error':result&&result.canonicalMetadataIncomplete?'incomplete':'ok';
  return result;
 }finally{
  try{
   let previous=marks.startedAt;const part=name=>{if(!marks[name])return 0;const value=marks[name]-previous;previous=marks[name];return value;};
   const loadMs=part('loaded'),fetchMs=part('fetched'),localizeMs=part('localized'),canonicalMs=part('canonical');
   epgPhase(run.runId,'metadata_sync_breakdown','exit',{outcome,films:films||marks.films||0,loadMs,fetchMs,localizeMs,canonicalMs,tailMs:Date.now()-previous,totalMs:Date.now()-marks.startedAt});
  }catch{}
 }
}
async function metadataSyncStep(env,run,marks){
 const mark=name=>{marks[name]=Date.now();};
 const working=await MetadataCache.loadMetadataWorkingSet(env);mark('loaded');const cache=working.records;const creditsChanged=new Set();const next=run.pending.slice(run.cursor,run.cursor+24);const onlyNames=next.every(id=>cache[id]?.peopleVersion===1&&Date.now()-Date.parse(cache[id].metadataAt)<30*86400000);const ids=next.slice(0,onlyNames?24:12);marks.films=ids.length;
 // AIR-604: the metadata film pages go through the shared Letterboxd cooldown; a skip is counted in `run.upstreamCooldown`, is not a failure of the film and is not retried in this step.
 const filmPages=upstreamCoordinator(env,'metadata-sync');
 for(let i=0;i<ids.length;i+=3)await Promise.all(ids.slice(i,i+3).map(async id=>{const idx=run.watchlist.findIndex(f=>f.id===id);try{const film=run.watchlist[idx],fresh=film.peopleVersion===1&&film.metadataAt&&Date.now()-Date.parse(film.metadataAt)<30*86400000;if(fresh&&film.synopsisFetchedAt){if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const html=await getHTML(film.url,filmPages);if(fresh){film.synopsis=parseSynopsis(html);film.synopsisFetchedAt=new Date().toISOString();cache[id]={...cache[id],synopsis:film.synopsis,synopsisFetchedAt:film.synopsisFetchedAt};if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const result=parseFilm(html,film);cache[id]=result;run.watchlist[idx]=result;creditsChanged.add(id);}catch(e){if(e?.code==='upstream_cooldown')return;run.failures.push({id,error:e.message});}}));
 mark('fetched');
 const freeze=await frozenCanonicalMirrorsLocked(env);
 const titles=freeze?{}:await loadJSON(env,'titles.json')||{};const titleBatch=run.watchlist.filter(f=>ids.includes(f.id));const localizationMode=metadataLocalizationMode(env);
 // AIR-604: one Wikidata coordinator for the step; a cooldown skip stops the step's Wikidata requests, is not an error, and is recorded.
 const wikidata=upstreamCoordinator(env,'metadata-sync');
 try{recordLifecycle(run,'metadata',localizationMode,await localizeFilmTitles(titleBatch,titles,localizationMode,wikidata));}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 await saveCanonicalMirror(env,'titles.json',titles);
 const people=freeze?{}:await loadJSON(env,'people.json')||{};const batch=run.watchlist.filter(f=>creditsChanged.has(f.id)&&f.peopleVersion===1);
 // AIR-604: a people localization that skipped its Wikidata request is INCOMPLETE: the films are not marked localized (`peopleNamesVersion`), so the next metadata step picks them up again.
 const skippedBeforePeople=wikidata?.stats.skipped||0;
 try{if(batch.length)recordLifecycle(run,'metadata',localizationMode,await localizePeople(batch,people,localizationMode,wikidata));if((wikidata?.stats.skipped||0)===skippedBeforePeople)for(const f of batch){f.peopleLocalizedAt=new Date().toISOString();f.peopleNamesVersion=2;}}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 recordUpstreamEvidence(run,filmPages,wikidata);
 for(const f of batch)cache[f.id]=f;
 await saveCanonicalMirror(env,'people.json',people);
 mark('localized');
 if(typeof CanonicalMetadataSync!=='undefined'){
  try{
   const canonical=await CanonicalMetadataSync.applyMetadataSync(env,{
    event:'metadata:'+String(run.runId||''),
    films:run.watchlist.filter(film=>ids.includes(film.id)),
    titles,people,failedIds:(run.failures||[]).map(item=>item.id),
    intent:run.metadataSyncIntent||[],
   });
   mark('canonical');
   run.canonicalMetadata=CanonicalMetadataSync.metadataSyncRecord(canonical);
   const carried=CanonicalMetadataSync.carryMetadataSyncIntent(canonical);
   if(carried.length)run.metadataSyncIntent=carried;
   else delete run.metadataSyncIntent;
   if(!CanonicalMetadataSync.metadataSyncSettled(canonical)){
    run.updatedAt=new Date().toISOString();
    await MetadataCache.saveMetadataWorkingSet(env,cache,working);await saveJSON(env,'sync.json',run);
    return {runId:run.runId,stage:'metadata',remaining:run.pending.length-run.cursor,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length,canonicalMetadataIncomplete:true};
   }
  }catch(error){
   mark('canonical');
   const code=error&&error.code;
   if(code==='film_person_held'||code==='film_person_unavailable'||code==='film_person_not_open'||code==='film_person_generation_moved')throw error;
   run.canonicalMetadataErrors=(run.canonicalMetadataErrors||0)+1;
   run.updatedAt=new Date().toISOString();
   await MetadataCache.saveMetadataWorkingSet(env,cache,working);await saveJSON(env,'sync.json',run);
   return {runId:run.runId,stage:'metadata',remaining:run.pending.length-run.cursor,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length,canonicalMetadataIncomplete:true};
  }
 }
 run.cursor+=ids.length;run.remaining=run.pending.length-run.cursor;run.stage=run.remaining?'metadata':'epg';run.updatedAt=new Date().toISOString();await MetadataCache.saveMetadataWorkingSet(env,cache,working);await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,remaining:run.remaining,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length};
}
// AIR-353: the first half of the commit tail (the watchlist, the scan observation and the events) is its own function, so
// the staged publication can run it as a separate bounded step. It leaves the run's stage alone and is idempotent.
async function persistWatchlist(env,run,report){
 // ADR 0142 decision 14: one EPG sync, one generation increment. The publish commit already stored the watchlist.
 // saveWatchlist would bump generation a second time; under a live D1 pin the tail writes nothing.
 if(typeof PublishedEpg!=='undefined'&&await PublishedEpg.currentGeneration(env))return;
 const list=await loadJSON(env,'watchlist.json');
 if(report.films?.length===report.watchlistCount&&list?.updatedAt!==report.updatedAt){
  const next={updatedAt:report.updatedAt,films:report.films.map(({shows,...f})=>f)};
  const saved=typeof PublishedEpg==='undefined'?null:await PublishedEpg.saveWatchlist(env,next);
  if(saved===false)throw new Error('published_epg_fence');
  if(!saved)await saveJSON(env,'watchlist.json',next);
 }
}
async function persistScan(env,run,report){
 // ADR 0186: a run pinned to a Watchlist snapshot observed nothing on Letterboxd. The scan, the retention transitions and the removal hand-over belong to the Letterboxd Sync (AIR-570) and are not EPG steps.
 if(run.watchlistSnapshot){run.scanOutcome='skipped_snapshot_pinned';return 'ok';}
 // A complete watchlist is one observation of every listed film (ADR-0024).
 // ADR 0175 decision 2: what the scan did is recorded next to the completion, so a skipped scan is visible and is not read as an applied one.
 if(!(report.films?.length===report.watchlistCount&&run.watchlistObservedAt)){
  run.scanOutcome=report.films?.length===report.watchlistCount?'skipped_no_observation':'skipped_incomplete_watchlist';
  return 'ok';
 }
 const scanId=String(run.runId||'');
 const films=report.films.map(f=>({id:f.id,tmdbId:f.tmdbId}));
 let writerOpen=false;
 if(typeof CanonicalRatedAdmission!=='undefined')writerOpen=!!(await CanonicalRatedAdmission.ratedAdmissionWriterOpen(env));
 if(!writerOpen){
  delete run.ratedAdmissionScan;
  delete run.ratedAdmissionIntent;
  await LetterboxdFacts.applyWatchlistScan(env,{scanId,observedAt:run.watchlistObservedAt,films});
  run.scanOutcome='facts_only';
  return 'ok';
 }
 if(!run.ratedAdmissionScan||run.ratedAdmissionScan.scanId!==scanId){
  const view=await loadJSON(env,'enrichment/view-index.json')||{};
  const listedIds=(report.films||[]).map(f=>String(f.id));
  run.ratedAdmissionScan={scanId,observedAt:run.watchlistObservedAt,departed:CanonicalRatedAdmission.departedWatchlistLids(view,listedIds),cursor:0,factsApplied:false};
  await saveJSON(env,'sync.json',run);
 }
 if(!run.ratedAdmissionScan.factsApplied){
  await LetterboxdFacts.applyWatchlistScan(env,{scanId,observedAt:run.watchlistObservedAt,films});
  run.ratedAdmissionScan={...run.ratedAdmissionScan,factsApplied:true};
  await saveJSON(env,'sync.json',run);
 }
 const scan=run.ratedAdmissionScan;
 const listed=(report.films||[]).map(f=>({lid:String(f.id),tmdbId:f.tmdbId}));
 const queue=CanonicalRatedAdmission.watchlistRetentionWork({listed,departed:scan.departed,observedAt:scan.observedAt,scanId});
 const cap=CanonicalRatedAdmission.UNIT_CAP;
 const retry=run.ratedAdmissionIntent||[];
 const room=Math.max(0,cap-retry.length);
 const cursor=Number(scan.cursor||0);
 const slice=queue.slice(cursor,cursor+room);
 const canonical=await CanonicalRatedAdmission.applyRatedAdmissionRetention(env,{
  event:'watchlist:'+scanId+':'+cursor,
  retentions:slice,
  intent:retry,
  limit:cap,
 });
 run.canonicalRatedAdmission=CanonicalRatedAdmission.ratedAdmissionRecord(canonical);
 const carried=CanonicalRatedAdmission.carryRatedAdmissionIntent(canonical);
 if(carried.length)run.ratedAdmissionIntent=carried;
 else delete run.ratedAdmissionIntent;
 const sliceOk=CanonicalRatedAdmission.ratedAdmissionSliceSettled(canonical);
 if(sliceOk)run.ratedAdmissionScan={...scan,factsApplied:true,cursor:cursor+slice.length};
 await saveJSON(env,'sync.json',run);
 if(!sliceOk){
  const error=new Error('rated_admission_incomplete');
  error.code='rated_admission_incomplete';
  throw error;
 }
 if(run.ratedAdmissionScan.cursor<queue.length)return 'continue';
 run.scanOutcome='applied';
 delete run.ratedAdmissionScan;
 delete run.ratedAdmissionIntent;
 await saveJSON(env,'sync.json',run);
 return 'ok';
}
// AIR-390: the journal written with the watchlist and the scan is every event except the `epg` one. The `epg` event is written
// by flushEpgEvent once the run is complete, so its `at` is the completion time that sync.json also carries.
// AIR-379. Before a watchlist event that reports removals is written, the confirmed ratings that the fact store ALREADY holds are put on its
// removed films, so a film rated before the publication is shown with its rating at the first display. It reads stored facts only (the same
// `LetterboxdFacts.confirmedFilmRating` the removal queue uses, ADR 0077): no Diary, no Letterboxd request, no wait, no lookup, and the EPG
// publication never depends on it. At most REMOVAL_PUBLICATION_PROBES films are probed (one record read each, after one read of the link
// index and the films-list floor); a film not probed or without a confirmed rating stays unrated, and a failed read leaves the event exactly as
// it was. A null or absent rating is never read as "watched". A later rating still arrives through `settleRemovalRefs` on the same key.
const REMOVAL_PUBLICATION_PROBES=25;
async function storedRemovalRatings(env,event){
 if(event?.type!=='watchlist'||!Array.isArray(event.removed)||typeof LetterboxdFacts==='undefined')return {event,probed:0,rated:0};
 const ids=[...new Set(event.removed.filter(film=>film&&!removalRating(film)).map(film=>String(film.id??'')).filter(Boolean))].slice(0,REMOVAL_PUBLICATION_PROBES);
 if(!ids.length)return {event,probed:0,rated:0};
 try{
  const cache={links:(await loadJSON(env,LetterboxdFacts.FACTS_KEYS.links))||{},filmsList:await loadJSON(env,LetterboxdFacts.FACTS_KEYS.filmsList)};
  const found={};
  for(const id of ids){const rating=await LetterboxdFacts.confirmedFilmRating(env,id,cache);if(rating!=null)found[id]=rating;}
  return {event:withRemovalRatings(event,found,null)||event,probed:ids.length,rated:Object.keys(found).length};
 }catch{return {event,probed:ids.length,rated:0,failed:true};}
}
async function persistEvents(env,run,report){
 for(let index=0;index<run.events.length;index++){
  const event=run.events[index];
  if(event?.type==='epg'||event?.type==='watchlist'&&!run.watchlistEventFixed)continue;
  const started=Date.now(),probe=await storedRemovalRatings(env,event),ms=Date.now()-started;
  await writeEvent(env,probe.event);
  if(probe.event!==event)run.events[index]=probe.event;
  // `ms` is the wall time of the stored-fact reads alone, so the cost inside the publication can be read from sync.json after a natural run.
  if(probe.probed)run.removalPublication={probed:probe.probed,rated:probe.rated,ms,...(probe.failed?{failed:true}:{})};
 }
}
// One `epg` event per run, written only after the run is durably `complete`. `prepareEpgCompletion` fixes `run.completedAt` and
// parks the finished event in `run.epgEventPending`; the caller saves the complete run record (with `updatedAt = completedAt`) and
// only then `flushEpgEvent` puts the event and clears the mark. A failed save of the complete record therefore exposes no event, and a
// failed put or clear leaves the mark on the persisted complete run: the next step on it (the continuation branch) writes the same key
// again and clears it. Counts are those of the published report (an event of a superseded scan is rebuilt from it). A run that already
// has its event under the scan time (written by code before AIR-390, in a seal that spans a deploy) keeps it and gets no second one.
async function prepareEpgCompletion(env,run,report){
 const base=(run.events||[]).find(item=>item?.type==='epg');
 const legacyEpg=!!base&&!!await loadJSON(env,removalEventKey({at:report.updatedAt,id:base.id}));
 if(!run.completedAt&&!legacyEpg){
  run.completedAt=new Date().toISOString();
  if(base)run.epgEventPending={...(base.at===report.updatedAt?base:epgEvent(report,base.id)),at:run.completedAt};
 }
 await stampWatchlistCompletion(env,run);
}
// AIR-513: the watchlist event's user-facing `at` is the run's successful completion, the same clock as the `epg` event.
// The scan time stays on `run.watchlistObservedAt`. The journal object and the removal-reference key are fixed together here,
// before either is written, and a retry keeps that timestamp. A key that is already referenced or already stored is left as it is.
async function stampWatchlistCompletion(env,run){
 const event=(run?.events||[]).find(item=>item?.type==='watchlist');
 if(!event||!run.completedAt||run.watchlistEventFixed)return;
 const currentKey=Number.isFinite(Date.parse(event.at))?removalEventKey(event):null;
 const anchored=!!currentKey&&removalRefItems(run.removalRefs).some(item=>item.ref?.eventKey===currentKey);
 if(anchored||currentKey&&await loadJSON(env,currentKey)){run.watchlistEventFixed=true;return;}
 event.at=run.completedAt;
 const films=Array.isArray(run.watchlistRemovalFilms)?run.watchlistRemovalFilms.filter(film=>film&&film.id):[];
 if(films.length){
  const ref=removalHandoverRef(run);
  if(ref){
   const prior=removalRefItems(run.removalRefs).filter(item=>item.ref?.eventKey!==ref.eventKey);
   run.removalRefs=storedRemovalRefs([...prior,{ref,films}]);
  }
 }
 delete run.watchlistRemovalFilms;
 run.watchlistEventFixed=true;
}
async function watchlistEventStored(env,run){
 const event=(run?.events||[]).find(item=>item?.type==='watchlist');
 if(!event||!Number.isFinite(Date.parse(event.at)))return true;
 return !!(await loadJSON(env,removalEventKey(event)));
}
async function watchlistEventOwed(env,run){
 if(run?.watchlistEventPending)return true;
 if(Array.isArray(run?.watchlistRemovalFilms)&&run.watchlistRemovalFilms.length)return true;
 if(!run?.watchlistEventFixed)return false;
 return !(await watchlistEventStored(env,run));
}
async function flushWatchlistEvent(env,run){
 if(!run?.watchlistEventFixed)return false;
 const index=(run.events||[]).findIndex(item=>item?.type==='watchlist');
 if(index<0||!Number.isFinite(Date.parse(run.events[index].at)))return false;
 try{
  const event=run.events[index],key=removalEventKey(event),existing=await loadJSON(env,key);
  const started=Date.now(),probe=await storedRemovalRatings(env,event),ms=Date.now()-started;
  if(!(existing&&probe.event===event)){
   await writeEvent(env,probe.event);
   if(probe.event!==event)run.events[index]=probe.event;
   if(probe.probed)run.removalPublication={probed:probe.probed,rated:probe.rated,ms,...(probe.failed?{failed:true}:{})};
  }
  delete run.watchlistEventPending;
  await saveJSON(env,'sync.json',run);
  return true;
 }catch(e){
  run.watchlistEventPending=true;
  try{await saveJSON(env,'sync.json',run);}catch{}
  console.error(JSON.stringify({event:'watchlist_event_pending',runId:String(run.runId||'').slice(0,64)}));
  return false;
 }
}
async function flushEpgEvent(env,run){
 if(!run.epgEventPending)return;
 try{
  await writeEvent(env,run.epgEventPending);
  const pending=run.epgEventPending;delete run.epgEventPending;
  try{await saveJSON(env,'sync.json',run);}catch(e){run.epgEventPending=pending;throw e;}
 }catch(e){console.error(JSON.stringify({event:'epg_event_pending',runId:String(run.runId||'').slice(0,64)}));}
}
async function finishSyncPersist(env,run,report){
 await persistWatchlist(env,run,report);
 let scan='ok';
 do{scan=await persistScan(env,run,report);}while(scan==='continue');
 await persistEvents(env,run,report);
}
async function finishSync(env,run,report){
 // ADR 0185: in d1 mode this route attempts the queue refresh BEFORE completion, like the seal route, so the one completion operation can certify. Its error stays best-effort.
 if((await epgCheckpointState(env)).state==='d1'){
  await finishSyncPersist(env,run,report);await prepareEpgCompletion(env,run,report);
  try{await tracedPhase(run.runId,'queue_refresh',()=>refreshPredictionQueue(env,report,'programme_updated'));}catch(e){run.enrichmentQueueError=(String(e.message)+(e?.guard?':'+String(e.guard):'')).slice(0,160);}
  run.stage='complete';run.updatedAt=run.completedAt||new Date().toISOString();delete run.watchlist;delete run.pending;
  const certificate=await completeCheckpointRun(env,run);
  await flushEpgEvent(env,run);await flushWatchlistEvent(env,run);
  return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats,...(certificate?{certificate}:{})};
 }
 await finishSyncPersist(env,run,report);await prepareEpgCompletion(env,run,report);run.stage='complete';run.updatedAt=run.completedAt||new Date().toISOString();delete run.watchlist;delete run.pending;await saveJSON(env,'sync.json',run);await flushEpgEvent(env,run);await flushWatchlistEvent(env,run);try{await tracedPhase(run.runId,'queue_refresh',()=>refreshPredictionQueue(env,report,'programme_updated'));}catch(e){run.enrichmentQueueError=(String(e.message)+(e?.guard?':'+String(e.guard):'')).slice(0,160);await saveJSON(env,'sync.json',run);}return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats};}
// AIR-212: opens the discovery series for the generation this run has just published, before the commit's
// memory-heavy tail (finishSync, the prediction queue, ratings). queueDiscovery is idempotent and fenced: it
// refuses a generation that is no longer the published one, keeps a live writer and keeps the progress of a
// series already open for this generation. A failure here is not fatal: syncStep queues again once the commit
// completes, and the AIR-159 handoff covers a run that never gets there.
async function queueCommittedDiscovery(env,run){
 try{await queueDiscovery(env,'epg_committed',run.runId);}catch(e){run.discoveryError=String(e.message).slice(0,160);}
 try{await noteDiscoveryWorkflow(env);}catch(e){run.discoveryError=String(e.message).slice(0,160);}
}
async function copyEpgGeneration(env,runId){
 await epgStepGuard(env);
 for(const name of ['discovery-latest.json','discovered-films.json','programme.json']){
  const staged=await env.BUCKET.get(epgGenerationKey(runId,name));if(!staged)continue;
  const dest=name==='programme.json'?name:'epg/'+name,meta={httpMetadata:{contentType:'application/json'}};
  // Copy the stored bytes. Parsing the ledger back into objects is the commit's memory peak.
  if(staged.body&&typeof staged.body.getReader==='function'){
   const size=staged.size;
   if(!Number.isSafeInteger(size)||size<0)throw new Error('R2 object length is not a safe integer');
   await putKnownLength(env.BUCKET,dest,size,staged.body,meta);
   continue;
  }
  if(typeof staged.text==='function'){await env.BUCKET.put(dest,await staged.text(),meta);continue;}
  await saveJSON(env,dest,await staged.json());
 }
}
// AIR-220 / ADR 0034: the discovery ledger of a commit in `bounded` or `frozen` mode. Runs under the discovery lease that
// publishEpgGeneration holds, before the generation's files are written. It reads the predecessor's active ledger (the
// published generation P whose pointer etag is `fence.pointerEtag`), looks up re-entering keys in the archive one segment at
// a time, writes the departures as new write-once segment versions and a manifest, and swaps the archive pointer only while
// the published pointer, the lease and the commit's run are unchanged. Any fence loss throws before anything is published.
// `timing`, when given, receives the milliseconds of the bucket put alone (AIR-444): the fence and the serialization are not in it.
async function writeLedgerSegment(env,key,value,fence,timing=null){
 await fence();const text=JSON.stringify(value);
 const putAt=Date.now();
 const saved=await env.BUCKET.put(key,text,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
 if(timing)timing.putMs+=Date.now()-putAt;
 if(saved===null)throw new Error('Discovery archive version already exists');
 return {sha256:await textSha256(text),bytes:new TextEncoder().encode(text).length};
}
async function readLedgerManifest(env,manifestId){return manifestId?loadJSON(env,ledgerArchiveManifestKey(manifestId)):null;}
async function readLedgerSegment(env,manifest,segment){const entry=manifest?.segments?.[segment];return entry?.object?(await loadJSON(env,entry.object))?.items||{}:{};}
function discoveryHolder(value){
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.prototype.hasOwnProperty.call(value,'discovery'))return value;
 return {discovery:value||[]};
}
async function storedJSON(object,key,options){
 if(typeof options?.item!=='function'||key!=='epg/discovery-latest.json'||!ledgerStreamable(object))return object.json();
 const items=[];
 const wrapper=await forEachJsonArrayItems(ledgerChunks(object),'items',item=>{items.push(options.item(item));});
 return {...wrapper,items};
}
function ledgerStreamable(object){return !!(object&&(object.body&&typeof object.body.getReader==='function'||typeof object.text==='function'));}
async function* ledgerChunks(object){
 if(object?.body&&typeof object.body.getReader==='function'){
  const reader=object.body.getReader(),decoder=new TextDecoder();
  try{while(true){const {done,value}=await reader.read();if(done){const tail=decoder.decode();if(tail)yield tail;return;}const chunk=decoder.decode(value,{stream:true});if(chunk)yield chunk;}}
  finally{try{reader.releaseLock();}catch{}}
  return;
 }
 if(typeof object.text==='function')yield await object.text();
}
// The same object loadJSON would parse for epg/discovery-latest.json, without parsing it.
// A published programme run must resolve to that run's ledger. Null is only the first programme, before any run is published.
async function locateDiscoveryLedger(env){
 const shared='epg/discovery-latest.json',stagedName='discovery-latest.json';
 const mismatch=()=>{throw new Error('Discovery ledger does not match the published generation');};
 if(typeof PublishedEpg!=='undefined'){
  const live=await PublishedEpg.currentGeneration(env);
  if(live){
   const run=env.epgPin?.authority==='d1'&&env.epgPin.programmeRunId?env.epgPin.programmeRunId:live.programmeRunId;
   if(!run)return null;
   const copyKey=epgGenerationKey(run,stagedName);
   if(await env.BUCKET.get(copyKey))return {key:copyKey,expectRun:run};
   if(run!==live.programmeRunId)mismatch();
   const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),body=pointer?await pointer.json():null;
   if(body?.phase!=='published'||body.programmeRunId!==run)mismatch();
   return {key:shared,expectRun:run};
  }
 }
 const pinned=env.epgPin?.programmeRunId;
 if(pinned){const copyKey=epgGenerationKey(pinned,stagedName);if(await env.BUCKET.get(copyKey))return {key:copyKey,expectRun:pinned};}
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);
 if(pointer){
  const generation=await pointer.json();
  if(generation?.phase==='published'&&generation.programmeRunId){
   const copyKey=epgGenerationKey(generation.programmeRunId,stagedName);
   if(await env.BUCKET.get(copyKey))return {key:copyKey,expectRun:generation.programmeRunId};
  }
 }
 // No published D1 programme, or an R2 pointer whose ledger file is not there yet: an absent object is an empty predecessor.
 return {key:shared,expectRun:null};
}
async function readLedgerView(env){
 const located=await locateDiscoveryLedger(env);
 if(!located)return {kind:'missing',items:[],archive:null,prevKeys:new Set(),backlog:new Set(),duplicates:new Set()};
 const object=await env.BUCKET.get(located.key);
 if(!object){
  if(located.expectRun)throw new Error('Discovery ledger is missing for the published generation');
  return {kind:'missing',items:[],archive:null,prevKeys:new Set(),backlog:new Set(),duplicates:new Set()};
 }
 const requireRun=wrapper=>{if(located.expectRun&&wrapper?.programmeRunId!==located.expectRun)throw new Error('Discovery ledger does not match the published generation');};
 if(!ledgerStreamable(object)){
  const value=typeof object.json==='function'?await object.json():null;
  requireRun(value);
  if(!Array.isArray(value?.items))throw new Error('Discovery ledger JSON is incomplete');
  const items=value.items;
  return {kind:'materialized',items,archive:value?.archive||null,prevKeys:new Set(items.map(item=>item?.key)),backlog:new Set(items.filter(item=>item?.seenInLatestSnapshot!==true).map(item=>item?.key)),duplicates:new Set()};
 }
 const prevKeys=new Set(),backlog=new Set(),duplicates=new Set(),seen=new Set();
 const wrapper=await forEachJsonArrayItems(ledgerChunks(object),'items',item=>{prevKeys.add(item?.key);if(item?.seenInLatestSnapshot!==true)backlog.add(item?.key);const key=discoveryCandidateKey(item);if(seen.has(key))duplicates.add(key);else seen.add(key);});
 requireRun(wrapper);
 return {kind:'stream',key:located.key,archive:wrapper.archive||null,prevKeys,backlog,duplicates};
}
// Prefix, comma and suffix are the bytes the generation document actually writes. The length is their size
// plus the candidate bytes counted on the decision walk. workerd accepts a ReadableStream only when that
// length is known: the readable side of FixedLengthStream. A content-length header is not that contract.
function discoveryDocumentFraming(meta,ledger){
 const encoder=new TextEncoder(),head=JSON.stringify(meta||{}),tail=JSON.stringify(ledger||{});
 return {prefix:encoder.encode(head.slice(0,-1)+',"items":['),suffix:encoder.encode(tail==='{}'?']}':'],'+tail.slice(1)),comma:new Uint8Array([44])};
}
function discoveryDocumentLength(framing,itemBytes,itemCount){
 return framing.prefix.byteLength+framing.suffix.byteLength+itemBytes+(itemCount>0?itemCount-1:0);
}
// One chunk per pull. The consumer reads the prefix, then one encoded candidate, then the suffix.
// A repeated comma chunk is shared and never mutated. Nothing is enqueued until a pull asks for it.
function discoveryDocumentStream(framing,items){
 const {prefix,suffix,comma}=framing;
 const iterator=items[Symbol.asyncIterator]();
 let stage='prefix',started=false,held=null;
 return new ReadableStream({async pull(controller){
  try{
   if(stage==='prefix'){controller.enqueue(prefix);stage='item';return;}
   if(stage==='held'){controller.enqueue(held);held=null;stage='item';return;}
   if(stage!=='item')return;
   const step=await iterator.next();
   if(step.done){controller.enqueue(suffix);controller.close();stage='done';return;}
   if(started){held=step.value;controller.enqueue(comma);stage='held';return;}
   started=true;controller.enqueue(step.value);
  }catch(error){try{await iterator.return?.();}catch{}throw error;}
 }},{highWaterMark:1});
}
// Node has no FixedLengthStream. This stand-in pulls one chunk at a time and rejects a short or long body.
// It is not a substitute for the workerd class: a plain ReadableStream is still refused by R2 there.
function lengthLimitedStream(source,length){
 let seen=0;const reader=source.getReader();
 return new ReadableStream({async pull(controller){
  const step=await reader.read();
  if(step.done){if(seen!==length)throw new Error('Readable stream length does not match');controller.close();return;}
  const bytes=step.value instanceof Uint8Array?step.value:new Uint8Array(step.value);
  seen+=bytes.byteLength;
  if(seen>length)throw new Error('Readable stream length does not match');
  controller.enqueue(bytes);
 },cancel(reason){return reader.cancel(reason);}},{highWaterMark:1});
}
async function putKnownLength(bucket,key,length,source,options){
 if(!Number.isSafeInteger(length)||length<0)throw new Error('R2 object length is not a safe integer');
 if(typeof FixedLengthStream!=='function'){await bucket.put(key,lengthLimitedStream(source,length),options);return;}
 const pair=new FixedLengthStream(length);
 const writing=source.pipeTo(pair.writable);
 let stored;
 try{stored=await bucket.put(key,pair.readable,options);}
 catch(error){try{pair.writable.abort(error);}catch{}await writing.catch(()=>{});throw error;}
 await writing;
 return stored;
}
async function discoveryLedgerAuthoritative(env){
 if(typeof DiscoveryAuthority==='undefined')return false;
 const gate=await DiscoveryAuthority.readAuthority(env);
 return gate.ready===true;
}
async function storePlannedDiscovery(env,runId,meta,planned,next,lease){
 const authoritative=await discoveryLedgerAuthoritative(env);
 if(!planned.emit){
  const document={...meta,items:planned.items,...planned.ledger};
  if(!document.programmeRunId)document.programmeRunId=runId;
  if(authoritative){
   await DiscoveryAuthority.routeWrite(env,epgGenerationKey(runId,'discovery-latest.json'),document,{handoff:true,lease});
   await env.BUCKET.put(epgGenerationKey(runId,'discovery-latest.json'),JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
   return;
  }
  next['discovery-latest.json']=document;
  return;
 }
 try{
  if(!Number.isSafeInteger(planned.itemBytes)||!Number.isSafeInteger(planned.itemCount)||planned.itemBytes<0||planned.itemCount<0)throw new Error('Discovery document length is unknown');
  const framing=discoveryDocumentFraming(meta,planned.ledger);
  const source=planned.emit();
  let wrapped=source;
  let ingestDone=null;
  if(authoritative){
   const decoder=new TextDecoder(),pending=[];
   let wake=null,done=false,failure=null;
   const kick=()=>{const fn=wake;wake=null;if(fn)fn();};
   ingestDone=DiscoveryAuthority.ingestLedger(env,{programmeRunId:runId,handoff:true,lease,items:(async function*(){
    for(;;){
     while(!pending.length&&!done&&!failure)await new Promise(resolve=>{wake=resolve;});
     if(failure)throw failure;
     if(!pending.length)return;
     yield pending.shift();
    }
   })()}).catch(error=>{failure=error;throw error;});
   wrapped=(async function*(){
    try{
     for await(const bytes of source){
      if(failure)throw failure;
      pending.push(JSON.parse(decoder.decode(bytes)));
      kick();
      while(pending.length&&!failure)await new Promise(resolve=>setTimeout(resolve,0));
      if(failure)throw failure;
      yield bytes;
     }
    }catch(error){failure=failure||error;done=true;kick();throw error;}
    done=true;kick();
   })();
  }
  await putKnownLength(env.BUCKET,epgGenerationKey(runId,'discovery-latest.json'),discoveryDocumentLength(framing,planned.itemBytes,planned.itemCount),discoveryDocumentStream(framing,wrapped),{httpMetadata:{contentType:'application/json'}});
  if(ingestDone)await ingestDone;
 }finally{if(planned.holder)planned.holder.discovery=null;}
}
// Departures (bounded mode) stay objects only for the archive write that follows; frozen mode keeps none.
// The scan list stays reachable until the generation put has pulled the document. Encoding happens then, one row at a time.
// AIR-429: a departure waits for the archive write as its key and its JSON text, not as an object: the objects of a first bounded commit were most
// of its peak. It is parsed again when the segment that holds it is written.
function departureRecord(item){return {key:item.key,json:JSON.stringify(item)};}
async function collectLedgerDecisions(env,view,holder,reentry,options,active){
 const merge=openDiscoveryMerge(holder?.discovery||[],reentry,options,view.duplicates);
 const object=await env.BUCKET.get(view.key);
 if(!object)throw new Error('Discovery ledger is missing for the published generation');
 const departures=[],activeKeys=new Set();
 const place=item=>{if(!item)return;if(active(item))activeKeys.add(item.key);else departures.push(departureRecord(item));};
 const encoder=new TextEncoder(),bytesOf=item=>encoder.encode(JSON.stringify(item)).byteLength;
 let itemBytes=0,itemCount=0,holeOpen=false;const parked=[],holes=new Map();
 const add=n=>{itemBytes+=n;itemCount++;};
 await forEachJsonArrayItems(ledgerChunks(object),'items',raw=>{
  const item=merge.push(raw);
  if(item){place(item);if(active(item)){const n=bytesOf(item);if(holeOpen)parked.push(n);else add(n);}return;}
  const key=discoveryCandidateKey(raw);
  if(!holes.has(key)){holes.set(key,parked.length);parked.push(null);holeOpen=true;}
 });
 const tail=merge.end();
 for(const {key,item} of tail.deferred){place(item);const at=holes.get(key);parked[at]=item&&active(item)?bytesOf(item):null;}
 for(const n of parked)if(typeof n==='number')add(n);
 for(const item of tail.appended){place(item);if(active(item))add(bytesOf(item));}
 return {departures,activeKeys,itemBytes,itemCount};
}
// Yields one UTF-8 candidate at a time and waits until that chunk is taken. A repeated canonical key is the exception:
// rows after its first copy stay buffered until the merged row can be placed there. Production ledgers are unique.
async function* iterateLedgerItems(env,view,holder,reentry,options,active){
 const queue=[];
 let wake=null,gate=null,stopped=false,failure=null;
 const kick=()=>{const fn=wake;wake=null;if(fn)fn();};
 const release=()=>{const fn=gate;gate=null;if(fn)fn();};
 const task=(async()=>{
  try{
   const merge=openDiscoveryMerge(holder?.discovery||[],reentry,options,view.duplicates);
   const object=await env.BUCKET.get(view.key);
   if(!object)throw new Error('Discovery ledger is missing for the published generation');
   const encoder=new TextEncoder(),encode=item=>encoder.encode(JSON.stringify(item));
   const send=async bytes=>{if(stopped)return;queue.push(bytes);kick();while(queue.length>0&&!stopped)await new Promise(resolve=>{gate=resolve;});};
   let holeOpen=false;const parked=[],holes=new Map();
   await forEachJsonArrayItems(ledgerChunks(object),'items',async raw=>{
    const item=merge.push(raw);
    if(item){if(active(item)){const bytes=encode(item);if(holeOpen)parked.push(bytes);else await send(bytes);}return;}
    const key=discoveryCandidateKey(raw);
    if(!holes.has(key)){holes.set(key,parked.length);parked.push(null);holeOpen=true;}
   });
   const tail=merge.end();
   for(const {key,item} of tail.deferred){const at=holes.get(key);parked[at]=item&&active(item)?encode(item):null;}
   for(const bytes of parked)if(bytes)await send(bytes);
   for(const item of tail.appended)if(active(item))await send(encode(item));
  }catch(error){if(!stopped)failure=error;}
  finally{stopped=true;kick();}
 })();
 try{
  while(true){
   while(!queue.length&&!stopped)await new Promise(resolve=>{wake=resolve;});
   if(failure)throw failure;
   if(!queue.length)break;
   const bytes=queue.shift();release();yield bytes;
  }
 }finally{stopped=true;release();kick();try{await task;}catch{}}
}
// AIR-444: the segment writes of one archive commit take the full fence at most this many writes or milliseconds apart (see planDiscoveryLedger).
const ARCHIVE_SEGMENT_FENCE_EVERY=8,ARCHIVE_SEGMENT_FENCE_MS=20000,ARCHIVE_SEGMENT_CONCURRENCY=2;
// Sanitized counters of the archive loop, for its exit and its error marker. The four times do not overlap: `fenceMs` is every full fence of the
// commit (segments, manifest and pointer), `readMs` the reads of the existing segments, `putMs` the bucket puts of the segments alone; what is left of
// `elapsedMs` is serialization, hashing and the manifest and pointer puts.
function archiveCounters(tally,startedAt){return {elapsedMs:Date.now()-startedAt,segments:tally.segments,fences:tally.fences,fencesSkipped:tally.skipped,fenceMs:tally.fenceMs,readMs:tally.readMs,putMs:tally.putMs,bytes:tally.bytes};}
// A closed vocabulary for the error marker; never the message of the error.
function archiveStopReason(error){
 if(error?.code==='epg_step_fenced')return error.detail==='lease_expired'?'step_lease_expired':'step_fenced';
 const message=String(error?.message||'');
 if(/fence lost: lease/i.test(message))return 'discovery_lease';
 if(/fence lost/i.test(message))return 'fence_lost';
 if(/version already exists/i.test(message))return 'version_exists';
 return 'other';
}
async function planDiscoveryLedger(env,{runId,latest,mode,lease,pointerEtag,publishedRunId,kind='commit',holder=null}){
 const sourceHolder=holder||discoveryHolder(latest);
 // AIR-533: `planClock` starts at the entry of the plan; `totalMs` of the plan log is measured from it. `elapsedMs` keeps its historical scope (from `planStarted`, after the
 // active-ledger read and the archive pointer read) so it stays comparable with 16-18 November; the parts reconcile with `totalMs`, not with `elapsedMs`.
 const planClock={startedAt:Date.now()};const planMark=name=>{planClock[name]=Date.now();};
 const view=await readLedgerView(env);planMark('view');
 const archivePointer=await env.BUCKET.get(LEDGER_ARCHIVE_POINTER),archiveEtag=archivePointer?.etag??null,startId=archivePointer?(await archivePointer.json())?.manifestId||null:null;
 // Without an archive, `frozen` (and `full`) is the single growing ledger. Once an archive exists, `full` acts as `frozen`:
 // the full ledger is never rebuilt inside the Worker (ADR 0034, rollback R1).
 const effective=mode==='bounded'?'bounded':startId?'frozen':'full';
 const options={replaceShows:true,programmeRunId:runId};
 let latestList=sourceHolder.discovery||[];
 const latestKeys=new Set(latestList.map(raw=>discoveryCandidateKey(raw)));
 if(effective==='full'){
  if(view.kind!=='stream'){const items=mergeDiscoveryCandidates(view.items,latestList,options);latestList=null;if(sourceHolder)sourceHolder.discovery=null;return {items,ledger:{}};}
  latestList=null;
  const counted=await collectLedgerDecisions(env,view,sourceHolder,[],options,()=>true);
  return {emit:()=>iterateLedgerItems(env,view,sourceHolder,[],options,()=>true),holder:sourceHolder,ledger:{},itemBytes:counted.itemBytes,itemCount:counted.itemCount};
 }
 // AIR-444: every archive fence is also a mutation boundary of the EPG step, so a step that keeps working keeps its step lease (assertStep renews it
 // once half of it is spent) and one that lost it stops here, before the next write, as `epg_step_fenced`.
 const planStarted=Date.now(),tally={fences:0,skipped:0,fenceMs:0,readMs:0,segments:0,putMs:0,bytes:0};
 const fenceChecks=async()=>{
  await epgStepGuard(env);
  if(!await renewDiscoveryLease(env,lease))throw new Error('Discovery archive fence lost: lease');
  if(typeof PublishedEpg!=='undefined'){const live=await PublishedEpg.currentGeneration(env);if(live){if(live.fence!==pointerEtag)throw new Error('Discovery archive fence lost: published generation changed');if(kind==='commit'){const run=await loadJSON(env,'sync.json');if(run?.runId!==runId||run.stage!=='epg')throw new Error('Discovery archive fence lost: sync run changed');}return;}}
  const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if((pointer?.etag??null)!==pointerEtag)throw new Error('Discovery archive fence lost: published generation changed');
  if(kind==='commit'){const run=await loadJSON(env,'sync.json');if(run?.runId!==runId||run.stage!=='epg')throw new Error('Discovery archive fence lost: sync run changed');}
 };
 const fence=async()=>{const at=Date.now();try{await fenceChecks();}finally{tally.fences++;tally.fenceMs+=Date.now()-at;lastFenceAt=Date.now();sinceFence=0;}};
 // AIR-444: a segment is a create-only object under its own write id that nothing reads until the archive pointer moves, and the pointer moves only
 // after a full fence and a compare-and-swap. The 64 segment writes therefore take the full fence every ARCHIVE_SEGMENT_FENCE_EVERY writes or
 // ARCHIVE_SEGMENT_FENCE_MS, whichever comes first (the Discovery lease lives 90 s), instead of every write: on 11 Nov 2026 each full fence cost about
 // 4 s and the 64 of them were 273 s of a 348 s step. The manifest write and the pointer swap keep the full fence.
 let lastFenceAt=0,sinceFence=Infinity;
 const segmentFence=async(writes=1)=>{if(sinceFence+writes<=ARCHIVE_SEGMENT_FENCE_EVERY&&Date.now()-lastFenceAt<ARCHIVE_SEGMENT_FENCE_MS){sinceFence+=writes;tally.skipped+=writes;return;}await fence();tally.skipped+=writes-1;sinceFence=writes;};
 const prevKeys=view.prevKeys;
 const start=await readLedgerManifest(env,startId);
 if(startId&&!start)throw new Error('Discovery archive manifest missing');
 planMark('manifest');
 // Re-entry: keys of the new scan that are not in P's active ledger, read from the segments the starting manifest names.
 const reentry=[],found=new Set(),wanted=new Map();
 for(const key of latestKeys)if(!prevKeys.has(key)){const segment=ledgerArchiveSegment(key,start?.segmentCount||LEDGER_ARCHIVE_SEGMENTS);if(!wanted.has(segment))wanted.set(segment,[]);wanted.get(segment).push(key);}
 if(start)for(const [segment,keys] of wanted){const items=await readLedgerSegment(env,start,segment);for(const key of keys)if(items[key]){reentry.push(items[key].payload);found.add(key);}}
 planMark('reentry');
 // AIR-429: a bounded active ledger is the scan plus the part of the backlog that this commit does not archive yet (see planLedgerDrain).
 const drain=effective==='bounded'?planLedgerDrain(view.backlog,latestKeys,ledgerDrainCap()):null;
 const keep=item=>effective!=='bounded'||latestKeys.has(item.key)||drain.held(item.key);
 let items=null,emit=null,departures,activeKeys,collected=null;
 if(view.kind==='stream'){
  latestList=null;
  collected=await collectLedgerDecisions(env,view,sourceHolder,reentry,options,keep);planMark('collect');
  departures=collected.departures;activeKeys=collected.activeKeys;
  emit=()=>iterateLedgerItems(env,view,sourceHolder,reentry,options,keep);
 }else{
  const merged=mergeDiscoveryCandidates([...(view.items||[]),...reentry],latestList,options);
  items=effective==='bounded'?merged.filter(keep):merged;
  departures=effective==='bounded'?merged.filter(item=>!keep(item)).map(departureRecord):[];
  activeKeys=new Set(items.map(item=>item.key));
  if(sourceHolder)sourceHolder.discovery=null;
 }
 // alsoArchived: P's list is exact only for the manifest P names. Keys that writers after it archived while they were still
 // in P's active ledger (a writer that swapped the archive pointer and died before publishing) are added from the manifests'
 // upsertedKeys, walking back from the starting manifest; a long or broken chain is recounted one segment at a time.
 const also=new Set(view.archive?.alsoArchived||[]),named=view.archive?.manifestId||null;
 if(start&&startId!==named){
  let current=start,steps=0;
  while(current&&current.manifestId!==named&&steps<LEDGER_ARCHIVE_CHAIN_LIMIT){for(const key of current.upsertedKeys||[])if(prevKeys.has(key))also.add(key);current=current.parentManifestId?await readLedgerManifest(env,current.parentManifestId):null;steps++;}
  const reached=current?current.manifestId===named:named===null&&steps<=LEDGER_ARCHIVE_CHAIN_LIMIT;
  if(!reached){also.clear();for(let segment=0;segment<start.segmentCount;segment++){const segmentItems=await readLedgerSegment(env,start,segment);for(const key of Object.keys(segmentItems))if(prevKeys.has(key))also.add(key);}}
 }
 planMark('merge');
 for(const key of found)also.add(key);
 for(const key of [...also])if(!activeKeys.has(key))also.delete(key);
 let manifestId=startId,manifest=start;
 const archiveStarted=Date.now();
 {
  // AIR-533: the parts of the plan, in order: the predecessor's active ledger (`view`), the archive pointer and manifest, the re-entry segment reads, the streamed read, parse
  // and classify of the active ledger against the scan (`collect`), and the alsoArchived chain. Milliseconds only; a part that did not run is 0.
  let previous=planClock.startedAt;const part=name=>{if(!planClock[name])return 0;const value=planClock[name]-previous;previous=planClock[name];return value;};
  const parts={viewMs:part('view'),manifestMs:part('manifest'),reentryMs:part('reentry'),collectMs:part('collect'),alsoMs:part('merge')};
  const totalMs=archiveStarted-planClock.startedAt;parts.restMs=totalMs-Object.values(parts).reduce((n,value)=>n+value,0);
  epgPhase(runId,'seal_stage_plan','exit',{elapsedMs:archiveStarted-planStarted,totalMs,...parts,reentrySegments:wanted.size,departures:departures.length,backlog:drain?drain.backlog:0});
 }
 if(departures.length){
  try{
  epgBoundary(runId,'seal_stage_archive_begin','enter',{items:departures.length});
  const writeId=crypto.randomUUID(),at=new Date().toISOString(),count=start?.segmentCount||LEDGER_ARCHIVE_SEGMENTS,bySegment=new Map();
  for(const record of departures){const segment=ledgerArchiveSegment(record.key,count);if(!bySegment.has(segment))bySegment.set(segment,[]);bySegment.get(segment).push(record);}
  const segments=Array.from({length:count},(_,segment)=>start?.segments?.[segment]||{segment,object:null,sha256:null,items:0,bytes:0});
  // AIR-533: the segment read, merge, serialization and create-only put of up to ARCHIVE_SEGMENT_CONCURRENCY segments overlap (on 18 Nov 2026 the 64
  // sequential puts were 86 s and the reads 19 s of a 147 s archive). Every segment of a window is fenced together before the window starts (the
  // fence count of a window is its size, so the fence cadence of AIR-444 is unchanged), each is a create-only object under the write id that nothing
  // reads before the pointer moves, and the manifest still names the segments in order, so a failed window leaves only unreferenced objects.
  const ordered=[...bySegment].sort((a,b)=>a[0]-b[0]);
  // The window is joined before any error leaves it (the caller releases the Discovery lease in its `finally`), and every put re-checks, immediately before it
  // starts, that no sibling has failed and that the last full fence is younger than ARCHIVE_SEGMENT_FENCE_MS (one shared refresh for the whole window).
  let windowFailed=null,refreshing=null,windowSize=0;
  const putGuard=async()=>{
   if(windowFailed)throw new Error('Discovery archive fence lost: window aborted');
   if(Date.now()-lastFenceAt>=ARCHIVE_SEGMENT_FENCE_MS){// `fence()` restarts the count of writes since the last full fence; the window being written counts against the refreshed fence once (conservatively, as if all of its puts came after it), so no more than ARCHIVE_SEGMENT_FENCE_EVERY puts begin between two full fences.
    refreshing=refreshing||fence().then(()=>{sinceFence=Math.max(sinceFence,windowSize);}).finally(()=>{refreshing=null;});await refreshing;if(windowFailed)throw new Error('Discovery archive fence lost: window aborted');}
  };
  const archiveSegment=async([segment,records])=>{
   const readAt=Date.now(),segmentItems=await readLedgerSegment(env,start,segment);tally.readMs+=Date.now()-readAt;
   for(const record of records){const payload=JSON.parse(record.json);if(archivedPayloadNewer(payload,segmentItems[payload.key]?.payload))segmentItems[payload.key]={payload,envelope:{archivedAt:at,archivedFromProgrammeRunId:publishedRunId,archiveWriteId:writeId}};}
   const object=ledgerArchiveSegmentKey(segment,writeId),written=await writeLedgerSegment(env,object,{schemaVersion:1,segment,writeId,items:segmentItems},putGuard,tally);
   tally.segments++;if(tally.segments%16===0)epgBoundary(runId,'seal_stage_archive_segments','exit',{segments:tally.segments,count:bySegment.size,elapsedMs:Date.now()-archiveStarted});tally.bytes+=written.bytes;
   segments[segment]={segment,object,sha256:written.sha256,items:Object.keys(segmentItems).length,bytes:written.bytes};
  };
  const archiveGuarded=async entry=>{try{await archiveSegment(entry);}catch(error){windowFailed=windowFailed||error;throw error;}};
  // A window never crosses a fence boundary (2, 2, 2, 2 writes per fence of 8), so the cadence of AIR-444 is exactly the sequential one.
  for(let from=0;from<ordered.length;){
   const due=sinceFence>=ARCHIVE_SEGMENT_FENCE_EVERY||Date.now()-lastFenceAt>=ARCHIVE_SEGMENT_FENCE_MS;
   const size=Math.min(ARCHIVE_SEGMENT_CONCURRENCY,ordered.length-from,due?ARCHIVE_SEGMENT_CONCURRENCY:ARCHIVE_SEGMENT_FENCE_EVERY-sinceFence);
   const windowEntries=ordered.slice(from,from+size);from+=size;windowSize=windowEntries.length;
   await segmentFence(windowEntries.length);
   const settled=await Promise.allSettled(windowEntries.map(archiveGuarded));
   const failed=settled.find(result=>result.status==='rejected');
   if(failed)throw failed.reason;
  }
  manifestId=crypto.randomUUID();
  manifest={schemaVersion:1,manifestId,parentManifestId:startId,segmentCount:count,hash:'fnv1a32-utf8',segments,totals:{items:segments.reduce((n,entry)=>n+entry.items,0),bytes:segments.reduce((n,entry)=>n+entry.bytes,0)},upsertedKeys:departures.map(record=>record.key).sort(),writer:{runId,kind,basedOnProgrammeRunId:publishedRunId,basedOnPointerEtag:pointerEtag,leaseId:lease.id,writtenAt:at}};
  await writeLedgerSegment(env,ledgerArchiveManifestKey(manifestId),manifest,fence);
  // The archive's commit point: the pointer moves only while every fence still holds.
  await fence();
  const swapped=await env.BUCKET.put(LEDGER_ARCHIVE_POINTER,JSON.stringify({manifestId}),{onlyIf:archiveEtag?{etagMatches:archiveEtag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(swapped===null)throw new Error('Discovery archive fence lost: archive pointer changed');
  }catch(error){epgPhase(runId,'seal_stage_archive','error',{...archiveCounters(tally,archiveStarted),reason:archiveStopReason(error)});throw error;}
 }
 if(departures.length)epgPhase(runId,'seal_stage_archive','exit',archiveCounters(tally,archiveStarted));
 const alsoArchived=[...also].sort(),archive=manifest?{version:'v1',manifestId,segments:manifest.segmentCount,items:manifest.totals.items,bytes:manifest.totals.bytes,alsoArchived,uniqueArchivedItems:manifest.totals.items-alsoArchived.length}:null;
 const ledgerOut={ledgerMode:effective,...(drain&&drain.backlog>0?{drain:{backlog:drain.backlog,cap:drain.cap}}:{}),archive};
 if(emit)return {emit,holder:sourceHolder,ledger:ledgerOut,itemBytes:collected.itemBytes,itemCount:collected.itemCount};
 return {items,ledger:ledgerOut};
}
// ADR 0135 (AIR-459): the Madrid day stamped on the pointer is the sync run's own frozen `runKey` (written once by `beginSync`), never the adopting Workflow's
// day, `published_at` or a mutable control key. No frozen key, or no pause module in this scope, stamps nothing: the pointer still publishes and the pause stays closed.
async function publicationRunKey(env,run,runId){
 if(typeof EpgPriorityPause==='undefined'||!await requirePausePresence(env))return null;
 const source=run??await loadJSON(env,'sync.json');
 const day=EpgPriorityPause.publicationDay({syncRunKey:source?.runId===runId?source.runKey:null});
 return day.ok?day.dayKey:null;
}
// `ledger` (AIR-220): `{latest, meta, mode}` lets the generation's discovery ledger be planned under this lease, fenced on the
// published pointer read here; without it `files` already carry the ledger (full mode, unchanged).
async function publishD1Generation(env,runId,files,ledger,watchlist,publication){
 const lease=await leaseOrWindowBusy(env);
 try{
  const next={...files};
  if(ledger){
   const planned=await planDiscoveryLedger(env,{runId,latest:ledger.holder?.discovery??ledger.latest,mode:ledger.mode,lease,pointerEtag:publication.fence,publishedRunId:publication.phase==='published'?publication.programmeRunId||null:null,holder:ledger.holder||null});
   await storePlannedDiscovery(env,runId,ledger.meta,planned,next,lease);
  }
  if(next['discovered-films.json']){const pinned=await pinEpg(env);next['discovered-films.json']=mergeCatalogIdentity(next['discovered-films.json'],await loadJSON(pinned,'epg/discovered-films.json'),runId,{writeAvailability:false});}
  for(const [name,value] of Object.entries(next)){if(value==null)continue;await saveJSON(env,epgGenerationKey(runId,name),value);next[name]=null;if(name!=='programme.json')files[name]=null;}
  const live=await PublishedEpg.currentGeneration(env);
  if(!live||live.fence!==publication.fence)throw new Error('EPG generation changed during publish');
  const programme=files['programme.json'];
  const list=watchlist||{updatedAt:programme?.updatedAt||null,films:[]};
  const result=await PublishedEpg.publishGeneration(env,{programmeRunId:runId,phase:'published',publishedAt:programme?.updatedAt||null,expectedProgrammeRunId:publication.programmeRunId,madridRunKey:await publicationRunKey(env,null,runId),programme,watchlist:list});
  let mirrored=false;
  try{mirrored=await PublishedEpg.writeMirrors(env,{programmeRunId:runId,programme,watchlist:list,phase:'published'});}catch{mirrored=false;}
  try{await copyEpgGeneration(env,runId);}catch{}
  return {...result,authoritative:true,mirrored};
 }finally{await releaseDiscoveryLease(env,lease);}
}
async function publishEpgGeneration(env,runId,files,ledger=null,watchlist=null){
 if(typeof PublishedEpg!=='undefined'){const publication=await PublishedEpg.currentGeneration(env);if(publication)return publishD1Generation(env,runId,files,ledger,watchlist,publication);}
 const lease=await leaseOrWindowBusy(env);
 try{
  const next={...files};
  let fencedEtag;
  if(ledger){
   const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),published=pointer?await pointer.json():null;fencedEtag=pointer?.etag??null;
   const planned=await planDiscoveryLedger(env,{runId,latest:ledger.holder?.discovery??ledger.latest,mode:ledger.mode,lease,pointerEtag:fencedEtag,publishedRunId:published?.phase==='published'?published.programmeRunId||null:null,holder:ledger.holder||null});
   await storePlannedDiscovery(env,runId,ledger.meta,planned,next,lease);
  }
  if(next['discovered-films.json']){const pinned=await pinEpg(env);next['discovered-films.json']=mergeCatalogIdentity(next['discovered-films.json'],await loadJSON(pinned,'epg/discovered-films.json'),runId);}
  for(const [name,value] of Object.entries(next)){if(value==null)continue;await saveJSON(env,epgGenerationKey(runId,name),value);next[name]=null;if(name!=='programme.json')files[name]=null;}
  const current=await env.BUCKET.get(EPG_GENERATION_KEY),previous=current?await current.json():null;
  if(ledger&&!(previous?.programmeRunId===runId&&previous.phase==='published')&&(current?.etag??null)!==fencedEtag)throw new Error('EPG generation changed during publish');
  if(!(previous?.programmeRunId===runId&&previous.phase==='published')){
   const saved=await env.BUCKET.put(EPG_GENERATION_KEY,JSON.stringify({programmeRunId:runId,phase:'published'}),{onlyIf:current?.etag?{etagMatches:current.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(saved===null){const winner=await env.BUCKET.get(EPG_GENERATION_KEY);const body=winner?await winner.json():null;if(body?.programmeRunId!==runId)throw new Error('EPG generation changed during publish');}
  }
  await copyEpgGeneration(env,runId);
 }finally{await releaseDiscoveryLease(env,lease);}
}
// The commit's publication with its discovery ledger. The active ledger is folded under the publish lease.
// A bucket object that exposes `text` or `body` is read one candidate at a time; a `json`-only object keeps
// the single in-memory merge. The stored ledger, the archive and the published generation are unchanged.
async function publishGenerationWithLedger(env,runId,discovery,meta,files,watchlist=null){
 const holder=discoveryHolder(discovery);
 const mode=discoveryLedgerMode(env);
 return publishEpgGeneration(env,runId,files,{latest:holder.discovery,meta,mode,holder},watchlist);
}
// ADR 0092. With D1-authoritative discovery the EPG commit no longer writes the active ledger into D1 inside its own
// request: that takes tens of minutes and every client cancels at about two minutes. The commit stores everything the
// publication needs (the immutable generation ledger in R2, a staging payload) and moves the run to stage `seal`. Bounded
// steps then seal the ledger (`ledger`), bring the catalog up to date (`catalog`) and publish (`publish`); the published
// pointer moves only after the ledger is sealed and committed.
// AIR-353: the budget is counted from the request's entry, not from the start of the step, and no unit of work starts
// after it. The shortest MCP client waits about 60 s; the units in flight at the deadline are the margin.
const SEAL_REQUEST_BUDGET_MS=32000;
// The publication's units are large (the pointer, the mirrors, the queue refresh run for seconds each), so its phases use a
// shorter budget: the worst case of a step is this budget plus the longest unit that started before it.
const SEAL_PUBLICATION_BUDGET_MS=20000;
// AIR-420: a flush hands sealWrite more than one batch can hold, so every batch is as full as its statement cap allows.
const SEAL_FLUSH_ITEMS=400;
// AIR-422: the catalog step hands upsertAdmissions this many films at a time; it stops at the step deadline between batches.
const SEAL_CATALOG_FLUSH=2000;
// AIR-362: a seal step that finds the lease held answers `wait` with the holder's real expiry plus this margin, never more
// than one lease TTL from now. A cancelled step keeps its lease until it expires; the caller waits for that, once.
// ADR 0103 (AIR-383). A projector window is not a failure of the EPG publication. The three publication paths that take the Discovery
// lease throw this typed error instead of the generic `Resolver is writing the catalog`, and `syncStep` turns it into a structured,
// non-failure `busy` answer whose `nextCatchUpAt` is the window's absolute deadline. Nothing is persisted on the run for it: no
// `run.error`, no retry budget, no stage change. Any other missing lease keeps the old error.
class ProjectorWindowBusy extends Error{constructor(busy){super('projector_window');this.name='ProjectorWindowBusy';this.busy=busy;}}
// ADR 0135 (AIR-459): a live Discovery lease, or a lost race for it, is a collision with another writer and not a fault of the publication. The
// publication paths answer it as a structured, non-failure busy as well; only a missing busy answer keeps the old generic error.
class ResolverBusy extends Error{constructor(busy){super(busy.kind);this.name='ResolverBusy';this.busy=busy;}}
// Inert until `discovery_epg_priority` exists (migration 0022, not applied). Three answers, never two: `true` (the table is there), `false` (verified absent, or the Discovery
// authority is not on D1 at all: today's behaviour) and `null` (the read failed: UNKNOWN, which is not absence). A run-creating or stamping path must fail closed on `null`.
async function epgPausePresence(env){
 if(typeof DiscoveryAuthority==='undefined')return false;
 try{return (await DiscoveryAuthority.readAuthority(env)).priorityTable===true;}catch{return null;}
}
async function requirePausePresence(env){
 const present=await epgPausePresence(env);
 if(present===null)throw Object.assign(new Error('epg_priority_presence_unreadable'),{status:503,code:'epg_priority_presence_unreadable'});
 return present;
}
async function leaseOrWindowBusy(env){
 // The publication is the EPG side: `role: 'epg'` is exempt from the Discovery pause.
 const taken=await takeDiscoveryLease(env,'epg');
 if(taken.lease)return taken.lease;
 if(taken.busy?.kind==='projector_window'&&Number.isFinite(taken.busy.expiresAt))throw new ProjectorWindowBusy(taken.busy);
 if((taken.busy?.kind==='lease_held'||taken.busy?.kind==='lost_race')&&await epgPausePresence(env)===true)throw new ResolverBusy(taken.busy);
 throw new Error('Resolver is writing the catalog');
}
// A window that is already requested or held is known before the heavy EPG work starts, so the step answers busy without it.
async function epgWindowPrecheck(env){
 if(typeof DiscoveryAuthority==='undefined'||typeof DiscoveryAuthority.readProjectorWindow!=='function')return;
 const gate=await DiscoveryAuthority.readAuthority(env);
 if(!gate.ready||!gate.windowTable)return;
 const window=await DiscoveryAuthority.readProjectorWindow(env);
 if(window.active)throw new ProjectorWindowBusy({kind:'projector_window',expiresAt:window.expiresAt,state:window.state});
}
function windowBusyResponse(run,busy,now=Date.now()){
 // `projector_window`: the window's own absolute deadline. `lease_held`: the holder's expiry, never more than one lease TTL away. `lost_race`: a short fixed wait.
 const raw=Number(busy.expiresAt),finite=Number.isFinite(raw)&&raw>0;
 const kind=busy.kind==='lease_held'?(finite?'lease_held':'lost_race'):busy.kind==='lost_race'?'lost_race':'projector_window';
 const bounded=kind==='projector_window'?raw+SEAL_BUSY_MARGIN_MS:kind==='lease_held'?Math.min(raw,now+DiscoveryAuthority.LEASE_TTL_MS)+SEAL_BUSY_MARGIN_MS:now+SEAL_BUSY_LOST_RACE_MS;
 const until=Math.max(bounded,now+1000);
 return {runId:run.runId,stage:run.stage,remaining:run.remaining??0,failures:run.failures?.length??0,discovery:{state:'busy',remainingChunks:null,nextAction:'wait',reason:'busy',busyKind:kind,at:new Date(now).toISOString(),nextCatchUpAt:new Date(until).toISOString(),nextScheduledRunAt:null,retryAt:null,retryAfterSec:Math.ceil((until-now)/1000),programmeRunId:run.runId}};
}
const SEAL_BUSY_MARGIN_MS=3000;
const SEAL_BUSY_LOST_RACE_MS=5000;
function sealBusyResponse(run,taken,now=Date.now()){
 const kind=taken?.busy?.kind||'lease_held';
 // A different programme is a hard conflict, not contention: stop, and promise no retry time.
 if(kind==='generation_mismatch')return sealResponse(run,{state:'error',nextAction:'stop',reason:'programme_changed',busyKind:kind,nextCatchUpAt:null,retryAfterSec:null});
 // Only a finite, positive expiry is evidence for a lease-based wait; anything else is treated as a lost race.
 const raw=taken?.busy?.expiresAt;
 const expiresAt=typeof raw==='number'&&Number.isFinite(raw)&&raw>0?raw:null;
 if(kind==='projector_window'&&expiresAt!==null){
  // ADR 0103: the window's own absolute deadline, not the lease TTL cap, and its own busy kind. It is a wait for the executor; the
  // external Task contract waits only for `lease_held` within about 93 s, so for it this is a stop that it reports, never a failure.
  const until=Math.max(expiresAt+SEAL_BUSY_MARGIN_MS,now+1000);
  return sealResponse(run,{state:'busy',nextAction:'wait',reason:'busy',busyKind:'projector_window',nextCatchUpAt:new Date(until).toISOString(),retryAfterSec:Math.ceil((until-now)/1000),...sealBusyTelemetry(run,taken,'projector_window',expiresAt,until,now)});
 }
 const held=kind==='lease_held'&&expiresAt!==null;
 const bounded=held?Math.min(expiresAt,now+DiscoveryAuthority.LEASE_TTL_MS)+SEAL_BUSY_MARGIN_MS:now+SEAL_BUSY_LOST_RACE_MS;
 const until=Math.max(bounded,now+1000);
 return sealResponse(run,{state:'busy',nextAction:'wait',reason:'busy',busyKind:held?'lease_held':'lost_race',nextCatchUpAt:new Date(until).toISOString(),retryAfterSec:Math.ceil((until-now)/1000),...sealBusyTelemetry(run,taken,held?'lease_held':'lost_race',expiresAt,until,now)});
}
// ADR 0175 decision 8. Who held the lease, until when, the scheduled retry delay and in which seal phase: kinds and times only, no Film, id list, SQL or payload.
// `holderKind` tells an EPG-held lease from a Discovery-held one; a soft wait is not a failure and does not count against the budget.
function sealBusyTelemetry(run,taken,busyKind,expiresAt,until,now){
 const holderKind=taken?.busy?.holderKind??taken?.busy?.ownerKind??null;
 // `scheduledWaitMs` is the PLANNED retry delay (`nextCatchUpAt` minus now), not the measured time spent blocked: it must not be read as observed contention latency.
 const fields={holderKind,holdExpiry:expiresAt?new Date(expiresAt).toISOString():null,scheduledWaitMs:Math.max(0,until-now),sealPhase:run.seal?.phase??null};
 try{epgPhase(run.runId,'seal_busy','exit',{busyKind,...fields});}catch{}
 return fields;
}
async function sealedPublishAvailable(env){
 if(typeof DiscoveryAuthority==='undefined'||typeof PublishedEpg==='undefined')return false;
 if(!await discoveryLedgerAuthoritative(env))return false;
 return DiscoveryAuthority.sealSupported(env);
}
function sealPayloadKey(runId){return 'epg/seal/'+runId+'/payload.json';}
function sealPublicationKey(runId){return 'epg/seal/'+runId+'/publication.json';}
function sealLayout(run){return Number(run?.seal?.layout)===2?2:1;}
function sealResponse(run,discovery,extra={}){
 return {runId:run.runId,stage:'seal',remaining:0,failures:run.failures?.length??0,seal:{phase:run.seal?.phase??null,...(extra.seal||{})},discovery:{state:'paused',remainingChunks:null,nextAction:'continue',reason:'ledger_seal',at:new Date().toISOString(),nextCatchUpAt:null,nextScheduledRunAt:null,retryAt:null,programmeRunId:run.runId,...discovery}};
}
// Stores the generation ledger (R2 only, streamed with a known length) and the staging payload, then moves the run to
// `seal`. It writes nothing to the D1 ledger and does not touch the lease row beyond holding it for the duration.
async function stageSealedGeneration(env,run,{holder,meta,pending,nextWatchlist,uncertain,publication}){
 await epgStepGuard(env);
 const lease=await leaseOrWindowBusy(env);
 let planned=null;
 try{
  planned=await planDiscoveryLedger(env,{runId:run.runId,latest:holder.discovery,mode:discoveryLedgerMode(env),lease,pointerEtag:publication.fence,publishedRunId:publication.phase==='published'?publication.programmeRunId||null:null,holder});
  const encoder=new TextEncoder();
  const framing=discoveryDocumentFraming(meta,planned.ledger);
  let source,itemBytes,itemCount;
  if(planned.emit){source=planned.emit();itemBytes=planned.itemBytes;itemCount=planned.itemCount;}
  else{const encoded=(planned.items||[]).map(item=>encoder.encode(JSON.stringify(item)));itemBytes=encoded.reduce((n,bytes)=>n+bytes.byteLength,0);itemCount=encoded.length;source=(async function*(){for(const bytes of encoded)yield bytes;})();}
  if(!Number.isSafeInteger(itemBytes)||!Number.isSafeInteger(itemCount)||itemBytes<0||itemCount<0)throw new Error('Discovery document length is unknown');
  const key=epgGenerationKey(run.runId,'discovery-latest.json'),emitStarted=Date.now();
  epgBoundary(run.runId,'seal_stage_emit_begin','enter',{items:itemCount,bytes:itemBytes});
  await putKnownLength(env.BUCKET,key,discoveryDocumentLength(framing,itemBytes,itemCount),discoveryDocumentStream(framing,source),{httpMetadata:{contentType:'application/json'}});
  const stored=await env.BUCKET.head(key);if(!stored?.etag)throw new Error('Generation ledger was not stored');
  epgPhase(run.runId,'seal_stage_emit','exit',{elapsedMs:Date.now()-emitStarted,items:itemCount,bytes:itemBytes});
  const publicationKey=sealPublicationKey(run.runId);
  const payloadText=JSON.stringify({runId:run.runId,report:pending['programme.json'],watchlist:nextWatchlist,uncertain,fence:publication.fence,expectedProgrammeRunId:publication.programmeRunId??null});
  epgBoundary(run.runId,'seal_stage_payload_put','enter',{bytes:payloadText.length});
  const storedPublication=await env.BUCKET.put(publicationKey,payloadText,{httpMetadata:{contentType:'application/json'}});
  epgBoundary(run.runId,'seal_stage_payload_put','exit');
  if(!storedPublication?.etag)throw new Error('Seal publication was not stored');
  run.seal={jobId:crypto.randomUUID(),phase:'ledger',sourceKey:key,etag:stored.etag,layout:2,publicationKey,publicationEtag:storedPublication.etag,itemTotal:itemCount,prefixBytes:framing.prefix.byteLength,stagedAt:new Date().toISOString()};
  run.stage='seal';run.updatedAt=new Date().toISOString();delete run.error;
  await saveJSON(env,'sync.json',run);
  return sealResponse(run,{},{seal:{itemTotal:itemCount}});
 }finally{if(planned?.holder)planned.holder.discovery=null;await releaseDiscoveryLease(env,lease);}
}
// Reads the generation ledger from `offset` and hands its items to `visit` in order. `visit` may stop the read by
// returning false. The bytes of each item are the bytes it took in the document (its JSON text and the comma that
// follows it), which is how the cursor moves.
async function readSealedItems(env,job,offset,visit){
 const object=await env.BUCKET.get(job.sourceKey,{range:{offset}});
 if(!object)throw new Error('Generation ledger is missing');
 if(object.etag&&job.etag&&object.etag!==job.etag)throw new Error('Generation ledger changed during the seal');
 const encoder=new TextEncoder(),stop=new Error('seal_read_stop');
 async function* chunks(){yield '{"items":[';for await(const chunk of ledgerChunks(object))yield chunk;}
 try{
  await forEachJsonArrayItems(chunks(),'items',async item=>{if(await visit(item,encoder.encode(JSON.stringify(item)).byteLength+1)===false)throw stop;});
 }catch(error){if(error!==stop)throw error;try{await object.body?.cancel?.();}catch{}}
}
async function sealLedgerStep(env,run,lease,deadline){
 const job=run.seal;
 // Sanitized step counters for the phase log: how many batches, how long they waited for D1, how many observations and archive rounds.
 const stats={batches:0,writeMs:0,items:0,archives:0,archiveMs:0,statements:0,bytes:0};
 await DiscoveryAuthority.sealBegin(env,{programmeRunId:run.runId,jobId:job.jobId,sourceKey:job.sourceKey,sourceEtag:job.etag,itemTotal:job.itemTotal,startBytes:job.prefixBytes,lease});
 let state=await DiscoveryAuthority.sealState(env);
 epgBoundary(run.runId,'seal_ledger_begin','exit',{cursor:state.cursorItems,total:state.itemTotal});
 if(state.phase==='items'&&state.cursorItems<state.itemTotal){
  let batch=[],cursor=state.cursorItems,carried=null;
  // AIR-420: after the first batch of a step the next ones carry the fence values instead of reading them again (one D1 round trip a batch).
  const flush=async()=>{while(batch.length){const at=Date.now();const result=await DiscoveryAuthority.sealWrite(env,{jobId:job.jobId,expectedCursor:cursor,items:batch,lease,carried});stats.batches++;stats.writeMs+=Date.now()-at;stats.statements+=result.statements||0;stats.bytes+=batch.slice(0,result.written).reduce((n,entry)=>n+entry.bytes,0);if(stats.batches%25===0)epgBoundary(run.runId,'seal_ledger_batches','exit',{batches:stats.batches,items:stats.items+result.written,cursor:result.cursorItems,total:state.itemTotal});stats.items+=result.written;carried=result.carried||null;cursor=result.cursorItems;batch=batch.slice(result.written);if(Date.now()>=deadline&&batch.length)return false;}return true;};
  epgBoundary(run.runId,'seal_ledger_read','enter',{cursor:state.cursorItems,total:state.itemTotal});
  await readSealedItems(env,job,state.cursorBytes,async(item,bytes)=>{
   batch.push({item,bytes});
   if(batch.length>=SEAL_FLUSH_ITEMS){if(!await flush())return false;if(Date.now()>=deadline)return false;}
   return true;
  });
  // The read ended or was stopped: write what is held. A step always writes at least one batch; what the spent time
  // leaves unwritten is read again next step from the cursor.
  epgBoundary(run.runId,'seal_ledger_read','exit',{cursor,items:stats.items,batches:stats.batches});
  if(batch.length)await flush();
  state=await DiscoveryAuthority.sealState(env);
 }
 if(state.phase==='items'&&state.cursorItems<state.itemTotal)return {done:false,state,stats};
 // At least one archive batch per step, so a step with its time already spent still moves.
 for(;;){
  const at=Date.now();
  epgBoundary(run.runId,'seal_ledger_archive','enter',{count:stats.archives});
  const result=await DiscoveryAuthority.sealArchive(env,{jobId:job.jobId,lease,limit:500});
  stats.archives++;stats.archiveMs+=Date.now()-at;
  epgBoundary(run.runId,'seal_ledger_archive','exit',{elapsedMs:Date.now()-at,count:stats.archives});
  if(result.committed)return {done:true,state:await DiscoveryAuthority.sealState(env),stats};
  if(Date.now()>=deadline)return {done:false,state:await DiscoveryAuthority.sealState(env),stats,retiring:result.retiring};
 }
}
// The catalog is brought up to date by the difference to what D1 holds, a bounded part per step: a step writes what
// differs and the next step finds what is left, so no cursor is needed.
async function sealCatalogStep(env,run,lease,deadline){
 // ADR 0145: after M5 a layout-2 run stages no catalog and this phase has no work. A leftover `catalog` phase of an
 // in-flight layout-2 run is skipped into `publish` without reading or writing admissions. A leftover layout-1 run still
 // finishes from `payload.json`; under a live D1 pin it writes no availability.
 if(sealLayout(run)===2||await discoveryLedgerAuthoritative(env))return {done:true,remaining:0,stale:0,written:0,items:0,batches:0,reads:0,writeMs:0};
 const payload=await sealPayload(env,run,{keepCatalog:true});
 const pinned=await pinEpg(env);
 const mergeStarted=Date.now();
 const next=mergeCatalogIdentity(payload.catalog||{},await loadJSON(pinned,'epg/discovered-films.json'),run.runId,{writeAvailability:true});
 const current=await loadJSON(env,'epg/discovered-films.json')||{};
 const changed=Object.keys(next).filter(id=>JSON.stringify(next[id])!==JSON.stringify(current[id])).sort();
 const stale=Object.keys(current).filter(id=>!Object.hasOwn(next,id));
 let written=0,batches=0,reads=0,writeMs=0,carried=null;
 for(let at=0;at<changed.length;){
  const slice=changed.slice(at,at+SEAL_CATALOG_FLUSH),started=Date.now();
  const result=await DiscoveryAuthority.upsertAdmissions(env,Object.fromEntries(slice.map(id=>[id,next[id]])),{lease,carried,deadline});
  writeMs+=Date.now()-started;written+=result.written.length;batches+=result.batches||0;reads+=result.reads||0;carried=result.carried||null;
  if(result.refused.length)throw new Error('admission_identity_conflict');
  at+=slice.length-(result.remaining||0);
  if(Date.now()>=deadline)break;
 }
 const left=changed.length-written;
 if(!changed.length&&stale.length)await DiscoveryAuthority.supersedeAdmissions(env,stale,{lease});
 return {done:!changed.length,remaining:left,stale:stale.length,written,items:written,batches,reads,writeMs};
}
// AIR-353: the publication is three bounded steps. On 6 November 2026 one combined step took 83.7 s of wall time
// (2.4 s entry, 31.4 s pointer, mirrors, copy and discovery intent, 44.0 s commit tail of which the prediction queue
// refresh was 26.8 s, 6.8 s reply), longer than the 60 s the shortest MCP client waits. Each step below does one of
// those parts and answers `nextAction: continue`; each is idempotent, so a cancelled or repeated step is safe.
// AIR-460: the staged payload holds the whole catalog, which only `seal_catalog` reads. The publish, finalize and queue steps drop it
// the moment it is parsed, so its parsed objects are not held through the pointer, mirrors, copy and intent units.
async function sealPayload(env,run,{keepCatalog=false}={}){
 const id=run.runId;
 const layout=sealLayout(run);
 const key=layout===2?(run.seal.publicationKey||sealPublicationKey(id)):sealPayloadKey(id);
 const expected=layout===2?run.seal.publicationEtag:null;
 if(layout===2&&!expected)throw new Error('Seal publication etag is missing');
 epgBoundary(id,'seal_payload_get','enter');
 const object=await env.BUCKET.get(key);
 epgBoundary(id,'seal_payload_get','exit',{bytes:object?.size});
 if(!object)throw new Error(layout===2?'Seal publication is missing':'Seal payload is missing');
 if(layout===2&&object.etag!==expected)throw new Error('Seal publication changed during the seal');
 epgBoundary(id,'seal_payload_text','enter');
 const text=await object.text();
 epgBoundary(id,'seal_payload_text','exit',{bytes:text.length});
 epgBoundary(id,'seal_payload_parse','enter',{bytes:text.length});
 const payload=JSON.parse(text);
 epgBoundary(id,'seal_payload_parse','exit');
 if(!keepCatalog)delete payload.catalog;
 return payload;
}
// A step is a list of units. The first unit that is not finished always runs, so every call makes progress; no later unit
// starts once the request's budget has passed, and the step then saves what is finished in `run.seal.units` and answers
// `continue` in the same phase. A unit answers 'ok', 'continue' (progress, unit not done, not a failure) or 'failed'
// (a thrown error is fatal and keeps the phase). A failed unit is not recorded as done: the next call tries it again, up to
// SEAL_UNIT_ATTEMPTS times, and then it is recorded as 'gave_up' and named in `run.sealDegraded` and in the answer, never as done.
const SEAL_UNIT_ATTEMPTS=3;
async function sealUnits(env,run,deadline,list){
 const units=run.seal.units||(run.seal.units={}),attempts=run.seal.attempts||(run.seal.attempts={});
 let ran=0;
 for(const unit of list){
  if(units[unit.name])continue;
  if(ran>0&&Date.now()>=deadline)return {done:false};
  await epgStepGuard(env);
  const outcome=await tracedPhase(run.runId,'seal_'+unit.phase,unit.work);
  ran++;
  if(outcome==='continue')return {done:false};
  if(outcome==='failed'){
   attempts[unit.name]=(attempts[unit.name]||0)+1;
   if(attempts[unit.name]<SEAL_UNIT_ATTEMPTS)return {done:false,retry:unit.name};
   units[unit.name]='gave_up';
   run.sealDegraded=[...new Set([...(run.sealDegraded||[]),unit.name])].slice(0,8);
  }else units[unit.name]='ok';
 }
 return {done:true};
}
async function sealCheckpoint(env,run,out){
 run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);
 const units=run.seal.units||{};
 return sealResponse(run,{},{seal:{units:Object.keys(units).filter(key=>units[key]),...(out?.retry?{retry:out.retry,attempts:run.seal.attempts?.[out.retry]||0}:{}),...(run.sealDegraded?.length?{degraded:run.sealDegraded}:{})}});
}
function sealAdvance(run,phase){delete run.seal.units;delete run.seal.attempts;run.seal.phase=phase;run.updatedAt=new Date().toISOString();}
// `publish`: the published pointer, the mirrors, the generation copy and the discovery intent, as four units. The pointer is
// the one atomic unit. Before it the previous generation stays published and its fence is checked (a changed fence
// refuses the step); a repeat after it finds the generation published and skips it, so the pointer moves exactly once
// whatever is cancelled. A failed mirror write or copy is retried and then reported as degraded; the mirrors are also
// repaired by the EPG writer's hourly `ensure` (`PublishedEpg.repairMirrors`), and the watchlist fallback below is written when they failed.
async function sealPublishStep(env,run,lease,deadline=Infinity){
 const payload=await sealPayload(env,run);
 const report=payload.report;
 const out=await sealUnits(env,run,deadline,[
  {name:'pointer',phase:'publish_pointer',work:async()=>{
   const live=await PublishedEpg.currentGeneration(env);
   const already=live?.programmeRunId===run.runId&&live.phase==='published';
   if(!already){
    if(!live||live.fence!==payload.fence)throw new Error('EPG generation changed during publish');
    await saveJSON(env,epgGenerationKey(run.runId,'programme.json'),report);
    await PublishedEpg.publishGeneration(env,{programmeRunId:run.runId,phase:'published',publishedAt:report?.updatedAt||null,expectedProgrammeRunId:payload.expectedProgrammeRunId,madridRunKey:await publicationRunKey(env,run,run.runId),programme:report,watchlist:payload.watchlist});
   }
   return 'ok';
  }},
  {name:'mirrors',phase:'publish_mirrors',work:async()=>{try{return (await PublishedEpg.writeMirrors(env,{programmeRunId:run.runId,programme:report,watchlist:payload.watchlist,phase:'published'}))?'ok':'failed';}catch{return 'failed';}}},
  {name:'copy',phase:'publish_copy',work:async()=>{try{await copyEpgGeneration(env,run.runId);return 'ok';}catch{return 'failed';}}},
  {name:'intent',phase:'publish_intent',work:async()=>{
   await queueCommittedDiscovery(env,run);
   if(run.seal.units.mirrors!=='ok'&&await epgMayWriteWatchlistRoot(env,run))await saveJSON(env,'watchlist.json',{updatedAt:report?.updatedAt,films:payload.watchlist?.films||run.watchlist});
   await saveJSON(env,'uncertain.json',{updatedAt:report?.updatedAt,items:payload.uncertain});
   return 'ok';
  }},
 ]);
 if(!out.done)return await sealCheckpoint(env,run,out);
 sealAdvance(run,'finalize');await saveJSON(env,'sync.json',run);
 return sealResponse(run,{},{seal:{published:true,...(run.sealDegraded?.length?{degraded:run.sealDegraded}:{})}});
}
// `finalize`: the ratings hand-over, the watchlist, the scan observation and the events, as four idempotent units.
async function sealFinalizeStep(env,run,deadline=Infinity){
 const payload=await sealPayload(env,run);
 const report=payload.report;
 const out=await sealUnits(env,run,deadline,[
  {name:'handover',phase:'finalize_handover',work:async()=>{
   const gate=await ratingsGate(env);
   if(gate.active){await flushRemovalHandover(env,run);delete run.ratingPending;run.ratingsPipeline='separate';}
   else{delete run.ratingPending;run.ratingsPipeline='blocked';run.ratingsStorage=gate.storage;}
   return 'ok';
  }},
  {name:'watchlist',phase:'finalize_watchlist',work:async()=>{await persistWatchlist(env,run,report);return 'ok';}},
  {name:'scan',phase:'finalize_scan',work:async()=>{const outcome=await persistScan(env,run,report);return outcome==='continue'?'continue':'ok';}},
  {name:'events',phase:'finalize_events',work:async()=>{await persistEvents(env,run,report);return 'ok';}},
 ]);
 if(!out.done)return await sealCheckpoint(env,run,out);
 sealAdvance(run,'queue');await saveJSON(env,'sync.json',run);
 return sealResponse(run,{},{seal:{persisted:true}});
}
// `queue`: the prediction queue refresh, then the run is complete. A failed refresh is recorded and does not hold the run.
// ADR 0175 decision 4. One fenced D1 batch writes the run's completion certificate and clears the EPG-priority pause. It runs under the step lease the seal step holds
// (`env.epgStep`, `env.epgFence`); with no lease it writes nothing. The Madrid day is the run's frozen day (`publicationRunKey`), as for the pointer. An absent
// certificate column certifies nothing (today's behaviour). Never throws: the outcome is `certified`, `absent`, `skipped` (no lease, no pause table or no day) or `owed`.
async function certifyCompletedRun(env,run){
 try{
  if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.certifyRun!=='function')return 'skipped';
  if(!env.epgStep||env.epgFence==null)return 'skipped';
  const day=await publicationRunKey(env,run,run.runId);
  if(!day)return 'skipped';
  await epgStepGuard(env);
  const now=Date.now();
  const margin=typeof EpgOrchestration!=='undefined'?EpgOrchestration.BOUNDARY_MARGIN_MS:0;
  const out=await PublishedEpg.certifyRun(env,{programmeRunId:run.runId,madridRunKey:day,step:env.epgStep,epgFence:env.epgFence,leaseBound:new Date(now+margin).toISOString(),now});
  const outcome=out.column==='absent'?'absent':out.certified?'certified':'owed';
  try{epgPhase(run.runId,'seal_certify','exit',{outcome});}catch{}
  return outcome;
 }catch(error){
  try{epgPhase(run.runId,'seal_certify','error',{code:String(error?.code||error?.message||'error').slice(0,60)});}catch{}
  return 'owed';
 }
}
// ADR 0185 decision 4. In `d1` mode this is the ONLY way a run reaches `complete`, for both routes (sealQueueStep and finishSync), and both call it after the
// queue refresh was attempted. One D1 batch completes the checkpoint, removes the film rows and, when the certificate column and the pause table exist, certifies
// the run and clears the pause (a conditional update: a non-matching certificate still lets the run complete). Never throws for the certificate: the outcome is
// `certified`, `absent` (no certificate column), `skipped` (no pause table or no frozen day) or `owed`. A refused or failed completion throws, as a failed save does.
async function completeCheckpointRun(env,run){
 const step=checkpointStep(env);
 let certify=[],outcome='skipped';
 try{
  if(typeof PublishedEpg!=='undefined'&&typeof PublishedEpg.certifyUpdateStatements==='function'){
   const day=await publicationRunKey(env,run,run.runId);
   if(day){
    if(!await PublishedEpg.certificateColumnPresent(env))outcome='absent';
    else{certify=PublishedEpg.certifyUpdateStatements({programmeRunId:run.runId,madridRunKey:day,now:step.now,pause:await PublishedEpg.pauseTablePresent(env)});outcome='owed';}
   }
  }
 }catch{certify=[];outcome='owed';}
 const out=await EpgCheckpointD1.completeRun(env,run,{...step,queueAttempted:true,certify});
 if(!out.ok)throw checkpointError(out.reason);
 if(outcome==='owed'){
  try{const read=await PublishedEpg.readCertificate(env);outcome=read.column==='present'&&read.finalizedRunId===run.runId?'certified':'owed';}catch{outcome='owed';}
 }
 try{epgPhase(run.runId,'seal_certify','exit',{outcome});}catch{}
 return outcome;
}
async function sealQueueStep(env,run,deadline=Infinity){
 const payload=await sealPayload(env,run);
 const report=payload.report;
 const out=await sealUnits(env,run,deadline,[
  {name:'refresh',phase:'queue',work:async()=>{try{await refreshPredictionQueue(env,report,'programme_updated');}catch(e){run.enrichmentQueueError=(String(e.message)+(e?.guard?':'+String(e.guard):'')).slice(0,160);}return 'ok';}},
 ]);
 if(!out.done)return await sealCheckpoint(env,run,out);
 await prepareEpgCompletion(env,run,report);
 run.stage='complete';run.updatedAt=run.completedAt||new Date().toISOString();delete run.watchlist;delete run.pending;delete run.seal;
 // ADR 0175 decision 4: the certificate comes after the durable `complete` save and before the event flushes below. A failure never stops the flushes; the
 // run stays certificate-owed and `EpgOrchestration.certifyComplete` repairs it from the hourly `ensure`. ADR 0185: with the checkpoint in D1 the complete save and
 // the certificate are ONE batch (completeCheckpointRun) and the separate certify call is not made.
 let certificate;
 if((await epgCheckpointState(env)).state==='d1')certificate=await completeCheckpointRun(env,run);
 else{await saveJSON(env,'sync.json',run);certificate=await certifyCompletedRun(env,run);}
 await flushEpgEvent(env,run);
 await flushWatchlistEvent(env,run);
 if(run.ratingsPipeline==='separate'&&run.removalRefs&&await watchlistEventStored(env,run)&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);
 try{await env.BUCKET.delete(sealPayloadKey(run.runId));}catch{}
 try{await env.BUCKET.delete(sealPublicationKey(run.runId));}catch{}
 return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats,...(certificate?{certificate}:{}),...(run.scanOutcome?{scanOutcome:run.scanOutcome}:{}),ratingsPipeline:run.ratingsPipeline||'separate',...(run.ratingsPipeline==='blocked'?{ratingsStorage:run.ratingsStorage}:{}),...(run.sealDegraded?.length?{degraded:run.sealDegraded}:{})};
}
// One bounded step of the staged publication. It starts no unit of work after SEAL_REQUEST_BUDGET_MS from the request's entry and answers
// `nextAction: continue` until the run is complete.
async function sealStep(env,run,entryAt=Date.now()){
 await epgStepGuard(env);
 const deadline=entryAt+SEAL_REQUEST_BUDGET_MS;
 if(!run.seal?.jobId)throw new Error('seal_job_missing');
 // The lease is taken without the published pointer's programme: once the ledger is committed the discovery authority
 // is on the new run while the pointer still names the old one until the publish step, and the job's own fence (its id and
 // cursor, checked in every batch) is what protects these steps.
 const taken=await DiscoveryAuthority.acquireLease(env,{programmeRunId:null,role:'epg'});
 const lease=taken?.lease||null;
 if(lease)env.discoveryLease=lease;
 if(!lease)return sealBusyResponse(run,taken);
 try{
  if(run.seal.phase==='ledger'){
   const result=await tracedPhase(run.runId,'seal_ledger',()=>sealLedgerStep(env,run,lease,deadline),value=>({cursor:value.state.cursorItems,total:value.state.itemTotal,phase:value.state.phase,done:value.done,...(value.stats||{})}));
   // AIR-420: the cursor the step reached is kept on the run, so the read model and the executor's progress count see the seal move.
   run.seal.cursor=result.state.cursorItems;run.seal.ledgerPhase=result.state.phase;
   if(result.done){run.seal.phase=sealLayout(run)===2?'publish':'catalog';}
   run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);
   return sealResponse(run,{},{seal:{cursor:result.state.cursorItems,itemTotal:result.state.itemTotal,ledgerPhase:result.state.phase}});
  }
  if(run.seal.phase==='catalog'){
   const result=await tracedPhase(run.runId,'seal_catalog',()=>sealCatalogStep(env,run,lease,deadline),value=>({remaining:value.remaining,stale:value.stale,written:value.written,items:value.items,batches:value.batches,reads:value.reads,writeMs:value.writeMs}));
   if(result.done)run.seal.phase='publish';
   run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);
   return sealResponse(run,{},{seal:{catalogRemaining:result.remaining}});
  }
  const publicationDeadline=entryAt+SEAL_PUBLICATION_BUDGET_MS;
  if(run.seal.phase==='publish')return await tracedPhase(run.runId,'seal_publish',()=>sealPublishStep(env,run,lease,publicationDeadline));
  if(run.seal.phase==='finalize')return await tracedPhase(run.runId,'seal_finalize',()=>sealFinalizeStep(env,run,publicationDeadline));
  if(run.seal.phase==='queue')return await tracedPhase(run.runId,'seal_queue',()=>sealQueueStep(env,run,publicationDeadline));
  throw new Error('seal_phase_unknown');
 }finally{await releaseDiscoveryLease(env,lease);}
}
// ADR 0074, ADR 0161: the ratings pipeline is permanently separate. It works only on version 2 storage, the removal queue at
// schema version 2 and the Diary cursor in its merge form. The EPG commit then hands the films its watchlist diff removed to the
// queue as references to the removal event, durably and before it publishes, and does no ratings work: no Diary read, no fact
// write, no lookup. The RATINGS_PIPELINE binding is ignored. On any other stored state the commit still publishes and fails
// closed: it does not read Diary, look up films, enqueue or convert anything. It does record `removalRefs` for the removal event it
// writes. A later blocked commit keeps every earlier reference and appends its own, so watchlist advancement cannot drop them.
// Once the storage is supported, the next step on the run and the next sync start flush that list before sync.json is replaced.
// A version 1 `removalLookups` hand-over is flushed the same way.
async function ratingsGate(env){
 if(typeof LetterboxdRatings==='undefined')return {active:false,storage:'unsupported'};
 const state=await LetterboxdRatings.storageState(env);
 return {active:state.supported,storage:state.supported?'supported':state.authority&&state.authority!=='open'?'authority_'+state.authority:'unsupported'};
}
function removalHandoverRef(run){const event=(run?.events||[]).find(item=>item?.type==='watchlist');return event?.id&&Number.isFinite(Date.parse(event.at))?{eventKey:removalEventKey(event),sourceRunId:run.runId,at:event.at}:null;}
// One saved hand-over is `{ref, films}`. Consecutive blocked commits store a list of those, one entry per removal event.
function removalRefItems(value){
 if(Array.isArray(value))return value.filter(item=>Array.isArray(item?.films)&&item.films.length&&item.ref);
 if(Array.isArray(value?.films)&&value.films.length&&value.ref)return [value];
 return [];
}
function storedRemovalRefs(items){const list=items.filter(item=>item?.films?.length&&item.ref);return list.length===1?list[0]:list.length?list:undefined;}
async function flushRemovalHandover(env,run){
 const items=[...removalRefItems(run.removalRefs),...(typeof LetterboxdRatings==='undefined'?[]:LetterboxdRatings.syncHandover(run))];
 if(!items.length)return false;
 const ready=[],kept=[];
 for(const item of items){
  if(item.ref?.eventKey&&await loadJSON(env,item.ref.eventKey))ready.push(item);
  else kept.push(item);
 }
 for(const item of ready)await enqueueRemovalRefs(env,item.films,item.ref);
 if(kept.length)run.removalRefs=storedRemovalRefs(kept);else delete run.removalRefs;
 delete run.removalLookups;return ready.length>0;
}
// AIR-270: the post-commit ratings work carries a durable attempt marker in sync.json. Each phase is saved (and logged)
// before it starts, so a request killed for memory or time leaves `state: started` with the phase it died in. The next
// step on the completed run closes such an attempt as `unknown` once it is stale; it never repeats the diary read.
const RATINGS_ATTEMPT_STALE_MS=5*60000;
// AIR-263: compact phase markers for the EPG commit and its post-commit tail, so a memory-limit end of the request can be
// placed between two lines in Workers Observability. One line per edge: run id, phase, enter, exit or error, elapsed
// time, and counts or byte sizes the code already holds. Never titles, film ids, HTML or payloads.
// Best effort: a marker that cannot be logged never changes the step.
// AIR-455: the EPG diagnostic canary collects the phase markers of its own run (a unique run id) through this registry; a production run id is never registered.
const EPG_PHASE_SINKS=new Map();
// AIR-462: the correlation of one executor action (`instanceId`, `actStep`, `attemptTraceId`), bound to the run for the duration of the step the
// action drives. A run has one step at a time (the step lease), so the key is the run, never a shared slot. `attemptTraceId` is a local
// correlator minted per execution of the `act-N` callback, not a Cloudflare attempt id. Nothing here is persisted.
const EPG_TRACE=new Map();
async function withEpgTrace(env,body,work){
 const runId=env?.epgTrace&&typeof body?.runId==='string'?body.runId:null;
 if(runId)EPG_TRACE.set(runId,env.epgTrace);
 try{return await work();}
 finally{if(runId&&EPG_TRACE.get(runId)===env.epgTrace)EPG_TRACE.delete(runId);}
}
// A closed set of boundaries around the large allocations of the staged publication and the only numeric fields they may carry. The counts
// are allocation proxies (bytes the code already knows), not heap measurements: workerd offers no heap figure to read.
const EPG_BOUNDARIES=new Set(['seal_stage_archive_begin','seal_stage_archive_segments','seal_stage_emit_begin','seal_stage_payload_put','seal_ledger_begin','seal_ledger_read','seal_ledger_batches','seal_ledger_archive','seal_payload_get','seal_payload_text','seal_payload_parse']);
const EPG_BOUNDARY_FIELDS=['elapsedMs','bytes','items','batches','cursor','total','count','segments'];
function epgBoundary(runId,boundary,edge,fields={}){
 try{
  if(!EPG_BOUNDARIES.has(boundary)||(edge!=='enter'&&edge!=='exit'))return;
  const event={event:'epg_memory_boundary',runId:runId||null,boundary,edge,at:new Date().toISOString(),...(EPG_TRACE.get(runId)||{})};
  for(const key of EPG_BOUNDARY_FIELDS){const value=fields[key];if(Number.isSafeInteger(value)&&value>=0)event[key]=value;}
  console.log(JSON.stringify(event));
 }catch{}
}
function epgPhase(runId,phase,edge,fields={}){try{const event={event:'epg_phase',runId:runId||null,phase,edge,at:new Date().toISOString(),...(EPG_TRACE.get(runId)||{}),...fields};console.log(JSON.stringify(event));const sink=EPG_PHASE_SINKS.get(runId);if(sink)sink(event);}catch{}}
async function tracedPhase(runId,phase,work,summary=null){
 const started=Date.now();epgPhase(runId,phase,'enter');
 let result;try{result=await work();}catch(e){epgPhase(runId,phase,'error',{elapsedMs:Date.now()-started});throw e;}
 let fields={};try{fields=summary?summary(result)||{}:{};}catch{}
 epgPhase(runId,phase,'exit',{elapsedMs:Date.now()-started,...fields});return result;
}
async function closeInterruptedRatings(env,run,now=Date.now()){
 if(run.stage!=='complete'||!run.ratingPending?.length)return null;
 const attempt=run.ratingAttempt,since=Date.parse(attempt?.at||run.updatedAt);
 if(attempt&&attempt.state!=='started'||!(now-since>RATINGS_ATTEMPT_STALE_MS))return null;
 const at=new Date(now).toISOString(),phase=attempt?.phase||'not_recorded';
 run.ratingAttempt={...(attempt||{id:null,startedAt:null}),state:'unknown',cause:'interrupted',interruptedPhase:phase,closedAt:at};
 run.ratingError=`Ratings step interrupted during ${phase}; no outcome recorded`;run.ratingError=run.ratingError.slice(0,300);delete run.ratingPending;
 await saveJSON(env,'sync.json',run);return run.ratingAttempt;
}
// ADR 0074, ADR 0161: the EPG commit never reads Diary and never looks up films. Supported storage enqueues removal references.
// Any other stored state publishes the programme, keeps the removal references on the sync run and does not enqueue.
async function completeWithRatings(env,run,report){
 const gate=await ratingsGate(env);
 if(gate.active){
  delete run.ratingPending;run.ratingsPipeline='separate';
  const result=await tracedPhase(run.runId,'finish_sync',()=>finishSync(env,run,report),()=>({films:report.films?.length??0}));
  if(run.removalRefs&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);
  return {...result,ratingsPipeline:'separate'};
 }
 delete run.ratingPending;run.ratingsPipeline='blocked';run.ratingsStorage=gate.storage;
 const result=await tracedPhase(run.runId,'finish_sync',()=>finishSync(env,run,report),()=>({films:report.films?.length??0}));
 return {...result,ratingsPipeline:'blocked',ratingsStorage:gate.storage};
}
async function epgOrchestrationOf(env){
 // AIR-348: the executor's read model. A pure read; an unreadable record is reported, never repaired.
 if(typeof EpgOrchestration==='undefined')return null;
 try{return await EpgOrchestration.readModel(env,Date.now());}catch{return {mode:null,health:'unknown',failure:{class:null,code:'evidence_unreadable'},sideEffects:'none'};}
}
async function syncStatus(env){
 const run=await loadJSON(env,'sync.json');
 const orchestration=await epgOrchestrationOf(env);
 return run?{orchestration,runId:run.runId,stage:run.stage,updatedAt:run.updatedAt,remaining:run.remaining,failures:run.failures?.length,error:run.error,priorAttemptError:run.stage==='complete'&&!!run.error,ratingError:run.ratingError,ratingRepair:run.ratingRepair,ratingsPending:!!run.ratingPending?.length,...(run.ratingAttempt?{ratingAttempt:run.ratingAttempt}:{}),...(run.removalRatingLookup?{removalRatingLookup:run.removalRatingLookup}:{}),...(run.diaryHistory?{diaryHistory:run.diaryHistory}:{}),enrichmentQueueError:run.enrichmentQueueError||null,...(run.lifecycleLocalization?{lifecycleLocalization:run.lifecycleLocalization}:{})}:{stage:'not_started',orchestration};
}
// Shared by POST /api/sync/* and the MCP sync tools. One call is one existing step. `caller` names the
// boundary (http, mcp) for the AIR-151 step diagnostics; it changes nothing about the step.
async function postSync(env,execution,pathname,body,caller='http'){
 // AIR-348 / ADR 0100: the external writer path (HTTP, the MCP tools, an old Task prompt) is fenced once the owner has closed
 // admission or switched the EPG executor to Cloudflare, and a step it is admitted for holds the durable step lease until it ends,
 // so the owner's drain can prove no step is in flight. The executor's own calls (caller `internal`) hold their lease already.
 let lease=null;
 if(caller!=='internal'&&typeof EpgOrchestration!=='undefined'){
  const gate=await EpgOrchestration.beginExternalStep(env);
  if(gate.reason)return json({runId:body?.runId??null,stage:null,nextAction:gate.nextCatchUpAt?'wait':'stop',reason:gate.reason,error:gate.reason,nextCatchUpAt:gate.nextCatchUpAt??null},409);
  env=gate.env;lease=gate.step||null;
 }
 try{return await withEpgTrace(env,body,()=>postSyncRun(env,execution,pathname,body,caller));}
 finally{if(lease)await EpgOrchestration.endStep(env,lease).catch(()=>false);}
}
async function postSyncRun(env,execution,pathname,body,caller){
 if(pathname==='/api/sync/start')return json(await beginSync(env));
 const started=Date.now(),step=continuationStep(caller,pathname,body?.runId),persisted=()=>pathname==='/api/sync/epg'||step.branch==='run_mismatch';
 await openContinuationStep(env,step,persisted());
 let response;
 try{response=await syncStep(env,pathname,body,step,started);}
 catch(e){await closeContinuationStep(env,step,started,null,e,persisted());throw e;}
 await closeContinuationStep(env,step,started,response,null,persisted());
 return response;
}
async function syncStep(env,pathname,body,step,entryAt=Date.now()){
 const run=await loadJSON(env,'sync.json');step.runStage=diagnosticCode(DIAGNOSTIC_VOCABULARY.runStage,run?.stage??null);
 if(!run||body.runId!==run.runId){step.branch='run_mismatch';return json({error:'Run id mismatch'},409);}
 if(pathname==='/api/sync/metadata'){if(run.stage!=='metadata'){step.branch='stage_mismatch';return json({runId:run.runId,stage:run.stage,remaining:run.remaining});}step.branch='metadata';return json(await metadataSync(env,run));}
 if(pathname!=='/api/sync/epg'){step.branch='not_found';return json({error:'Not found'},404);}
 if(run.stage==='complete'){step.branch='continuation';await flushEpgEvent(env,run);await flushWatchlistEvent(env,run);if((run.removalRefs||run.removalLookups)&&(await ratingsGate(env)).active&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);if(run.ratingPending?.length)await closeInterruptedRatings(env,run);step.branch='delegated';const presented=await presentContinuationDiscovery(env);step.discovery=discoverySummary(presented.discovery);return json({runId:run.runId,stage:run.stage,ratingsPending:!!run.ratingPending?.length,...presented,diagnostic:step.diagnostic});}
 if(run.stage==='seal'){step.branch='seal';try{const result=await sealStep(env,run,entryAt);if(result.stage!=='complete'){step.discovery=discoverySummary(result.discovery);return json(result);}const presented=await presentQueuedDiscovery(env,await queueDiscovery(env,'epg_committed',run.runId));step.discovery=discoverySummary(presented.discovery);return json({...result,...presented});}catch(e){run.error=String(e.message).slice(0,200);run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}}
 if(run.stage!=='epg'){step.branch='stage_mismatch';return json({error:'Metadata stage is not complete'},409);}
 step.branch='epg_commit';
 try{const result=await epgSync(env,run);if(result.stage!=='complete')return json(result);const presented=await presentQueuedDiscovery(env,await queueDiscovery(env,'epg_committed',run.runId));step.discovery=discoverySummary(presented.discovery);return json({...result,...presented});}catch(e){if(e instanceof ProjectorWindowBusy||e instanceof ResolverBusy){step.branch=e instanceof ResolverBusy?'resolver_busy':'projector_window';step.discovery=discoverySummary(windowBusyResponse(run,e.busy).discovery);return json(windowBusyResponse(run,e.busy));}run.error=e.message;run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}
}
async function epgSync(env,run){
 await epgStepGuard(env);
 if(run.events){const committed=await loadJSON(env,'programme.json');if(committed?.runId===run.runId){await tracedPhase(run.runId,'generation_copy',()=>copyEpgGeneration(env,run.runId));await queueCommittedDiscovery(env,run);return completeWithRatings(env,run,committed);}}
 await epgWindowPrecheck(env);
 const freeze=await frozenCanonicalMirrorsLocked(env);
 const titles=freeze?{}:await loadJSON(env,'titles.json')||{};
 const wikidata=upstreamCoordinator(env,'epg-localization');
 try{await localizeFilmTitles(run.watchlist,titles,'on',wikidata);await saveCanonicalMirror(env,'titles.json',titles);}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 const people=freeze?{}:await loadJSON(env,'people.json')||{};
 try{await localizeByLetterboxd(run.watchlist,people,wikidata);await saveCanonicalMirror(env,'people.json',people);}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 recordUpstreamEvidence(run,wikidata);
 applyEpgLocalization(run.watchlist,people);
 // AIR-263: the source fetch and the scan are one traced phase; an error logs `error` and rethrows unchanged.
 const sources=sourceConfig(env);
 const channelPolicy=await loadEpgChannelPolicy(env),registration={value:null};
 const scanned=await tracedPhase(run.runId,'epg_input_scan',async()=>{const now=Date.now(),r=await fetch(sources.epg,{signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error('EPG HTTP '+r.status);const cache=await loadJSON(env,'epg/discovered-films.json')||{},watchlistTmdb=new Set(run.watchlist.map(f=>String(f.tmdbId)));const result=await scanEPG(r.body,[...run.watchlist,...Object.values(cache).filter(f=>!watchlistTmdb.has(String(f.tmdbId))).map(f=>({...f,catalogOnly:true}))],now,{policies:channelPolicy.map||null,degraded:channelPolicy.mode==='degraded',onDeclarations:epgDeclarationRegistrar(env,registration)});return {now,cache,result};},value=>({policyMode:value.result.stats.policyMode,policyRevision:channelPolicy.revision,films:value.result.films.length,discovery:value.result.discovery?.length??0,catalog:Object.keys(value.cache).length}));
 const now=scanned.now,result=scanned.result;let cache=scanned.cache;if(result.stats.epgEnd<now-72*3600000)throw new Error('EPG does not cover the current window');
 if(result.stats.policy){if(channelPolicy.mode==='filtered')result.stats.policy={...result.stats.policy,revision:channelPolicy.revision,digest:channelPolicy.digest,registration:registration.value};else if(channelPolicy.mode==='degraded')result.stats.policy={...result.stats.policy,reason:channelPolicy.reason};}
 let previous=await loadJSON(env,'programme.json');assertEPGContinuity(result,previous,run.watchlist.length,now);
 const byId=new Map();for(const film of result.films){film.shows=dedupeShows(film.shows).sort((a,b)=>a.start-b.start);byId.set(String(film.id),film);}
 const films=run.watchlist.map(f=>withAvailability({...f,...byId.get(String(f.id)),shows:byId.get(String(f.id))?.shows||[]}));
 const countShows=[...byId.values()].reduce((n,f)=>n+f.shows.length,0),channels=result.coverage.length,futureFullChannels=result.coverage.filter(c=>c.max>=now+24*3600000).length;const weekChannels=result.coverage.filter(c=>c.max>=now+EPG_RETAIN_FUTURE_MS-24*3600000).length;
 const discoveryHolder={discovery:result.discovery};result.films=null;result.coverage=null;result.discovery=null;
 const report={runId:run.runId,updatedAt:new Date(now).toISOString(),watchlistUpdatedAt:run.startedAt,cutoff:now,window:{from:now-72*3600000,to:now+EPG_RETAIN_FUTURE_MS,hotTo:now+EPG_HOT_FUTURE_MS},coverage:{retainHours:EPG_RETAIN_FUTURE_MS/3600000,hotHours:EPG_HOT_FUTURE_MS/3600000,feedEndsAt:Number.isFinite(result.stats.epgEnd)?new Date(result.stats.epgEnd).toISOString():null,futureKnownUntil:Number.isFinite(result.stats.epgEnd)?new Date(Math.min(result.stats.epgEnd,now+EPG_RETAIN_FUTURE_MS)).toISOString():null,weekChannels},watchlistCount:run.watchlist.length,watchlistPages:run.pages,films,people:peopleCatalog(run.watchlist),stats:{...result.stats,broadcasts:countShows,uniqueFilms:byId.size,metadataMissing:run.watchlist.filter(f=>!f.metadataAt).length,titleMissing:run.watchlist.filter(f=>!f.titleRu).length,titleProvisional:run.watchlist.filter(f=>f.titleStatus==='provisional').length,titleLocalizationErrors:run.titleLocalizationErrors||0,synopsisAvailable:run.watchlist.filter(f=>!!f.synopsis).length,synopsisMissing:run.watchlist.filter(f=>!f.synopsis).length,peopleMissing:run.watchlist.filter(f=>f.peopleVersion!==1).length,peopleFilms:run.watchlist.filter(f=>f.peopleVersion===1).length,channels,futureFullChannels},sources:{epg:sources.epg,watchlist:sources.watchlist},archiveVerified:false};
 byId.clear();
 const nextWatchlist={updatedAt:report.updatedAt,films:run.watchlist};
 const gate=await ratingsGate(env);
 // AIR-359: the events describe the scan that is about to be published. A rescan inside the same run (an earlier attempt failed
 // before the pointer moved) rebuilds them. A watchlist event that reports removals keeps its key: the removal hand-over (pending
 // on the run, or already in the removal queue) references it, and a rescan yields the same delta. Nothing is written to the journal here; finishSync writes the events after the publication.
 const supersededEpg=run.events?.find(item=>item?.type==='epg');
 if(run.watchlistSnapshot&&(!run.events||supersededEpg?.at!==report.updatedAt)){run.events=[epgEvent(report,run.runId+'-epg')];delete run.watchlistRemovalFilms;delete run.removalRefs;await saveJSON(env,'sync.json',run);}else if(!run.events||supersededEpg?.at!==report.updatedAt){const priorWatch=run.events?.find(item=>item?.type==='watchlist'),priorKey=priorWatch&&Number.isFinite(Date.parse(priorWatch.at))?removalEventKey(priorWatch):null,anchored=!!priorKey&&removalRefItems(run.removalRefs).some(item=>item.ref?.eventKey===priorKey);const before=await loadJSON(env,'watchlist.json');const fresh=watchlistEvent(before,nextWatchlist,previous,report,run.runId+'-watchlist');run.events=[anchored?priorWatch:fresh,epgEvent(report,run.runId+'-epg')];if(!anchored){const removed=new Set((fresh.removed||[]).map(film=>String(film.id)));const films=(before?.films||[]).filter(film=>removed.has(String(film.id))).map(removalLookupFilm).filter(Boolean);if(films.length)run.watchlistRemovalFilms=films;else delete run.watchlistRemovalFilms;const own='-'+run.runId+'-watchlist.json';const prior=removalRefItems(run.removalRefs).filter(item=>!String(item.ref?.eventKey||'').endsWith(own));if(prior.length)run.removalRefs=storedRemovalRefs(prior);else delete run.removalRefs;delete run.watchlistEventFixed;}await saveJSON(env,'sync.json',run);}
 if(gate.active&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);
 previous=null;
 const liveCatalog=typeof PublishedEpg!=='undefined'?await PublishedEpg.currentGeneration(env):null;
 const pending={'discovered-films.json':replaceCatalogAvailability(cache,discoveryHolder.discovery,run.runId,{writeAvailability:!liveCatalog}).catalog,'programme.json':report};
 cache=null;
 if(await sealedPublishAvailable(env)){const publication=await PublishedEpg.currentGeneration(env);if(publication)return await tracedPhase(run.runId,'seal_stage',()=>stageSealedGeneration(env,run,{holder:discoveryHolder,meta:{programmeRunId:run.runId,updatedAt:report.updatedAt,rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies},pending,nextWatchlist,uncertain:result.uncertain,publication}));}
 let published;try{published=await tracedPhase(run.runId,'generation_publish',()=>publishGenerationWithLedger(env,run.runId,discoveryHolder,{programmeRunId:run.runId,updatedAt:report.updatedAt,rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies},pending,nextWatchlist));}catch(e){run.discoveryError=String(e.message).slice(0,160);throw e;}
 await queueCommittedDiscovery(env,run);
 if((!published?.authoritative||!published.mirrored)&&await epgMayWriteWatchlistRoot(env,run))await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:run.watchlist});await saveJSON(env,'uncertain.json',{updatedAt:report.updatedAt,items:result.uncertain});return completeWithRatings(env,run,report);
}
// AIR-570 (ADR 0186): the phase ports of the dormant Letterboxd Sync Workflow, assembled from the modules already in this scope. Nothing here runs unless the Letterboxd mode row says `cloudflare`
// (the owner's switch refuses that without a proven handover). A port a deployment cannot supply stays absent and fails closed.
async function letterboxdTmdbOf(env,lids){
 const working=await MetadataCache.loadMetadataWorkingSet(env),records=working?.records||{},map=new Map();
 for(const lid of lids){const id=records[lid]?.tmdbId;map.set(lid,id==null?null:String(id));}
 return map;
}
// The EVIDENCE the owner's mode switch needs before the Letterboxd writer is admitted (O5): read from the live state, never asserted. Ratings is closed (its own mode is neither `cloudflare` nor
// `switching`) and drained (no step lease live, no instance live), the legacy Ratings start/step gate (`externalGate`) answers `external_writer_fenced` (that happens while the Letterboxd mode is
// `switching`, which `complete` requires), the Watchlist authority is an open `d1` and the three phase ports exist. Any unreadable piece is false.
// AIR-571 D. The facts a handover proof rests on, read as ONE unit: the Watchlist marker (state, writes, generation), the Ratings domain authority (mode, cutover, generation: every authoritative Ratings commit bumps it)
// and the stored etags (absence included) of the Ratings mode, control and run documents. null = any of them could not be read.
async function letterboxdHandoverFacts(env){
 try{
  const db=WatchlistD1.bindingOf(env);
  if(!db||typeof db.prepare!=='function')return null;
  const authority=await WatchlistD1.readAuthority(env);
  if(!authority||!Number.isInteger(authority.generation))return null;
  const keys=[RatingsOrchestration.MODE_KEY,RatingsOrchestration.CONTROL_KEY,LetterboxdRatings.KEYS.run];
  const read=await db.prepare('SELECT key, etag FROM ratings_document WHERE part=0 AND key IN (?,?,?)').bind(...keys).all();
  const etags=new Map((read.results||[]).map(row=>[row.key,row.etag]));
  const ratings=await db.prepare('SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1').first();
  if(!ratings||!Number.isInteger(ratings.generation))return null;
  return {watchlist:{state:authority.state,writes:authority.writes,generation:authority.generation},ratings:{mode:ratings.mode,cutover:ratings.cutover,generation:ratings.generation},keys,etags:keys.map(key=>etags.get(key)??'')};
 }catch{return null;}
}
const sameFacts=(a,b)=>!!a&&!!b&&JSON.stringify(a)===JSON.stringify(b);
// The EVIDENCE the owner's mode switch needs before the Letterboxd writer is admitted (O5): read from the live state, never asserted. Ratings is closed (its own mode is neither `cloudflare` nor
// `switching`) and drained (no step lease live, no instance live), the legacy Ratings start/step gate (`externalGate`) answers `external_writer_fenced` (that happens while the Letterboxd mode is
// `switching`, which `complete` requires), the Watchlist authority is an open `d1` and the three phase ports exist. Any unreadable piece is false. The facts are read BEFORE and AFTER the proof and must be identical: a
// fact that moved while the proof was read makes the whole proof false, and the identical facts are returned as `evidence`, the only thing the commit guards are built from.
async function letterboxdHandover(env,now=Date.now()){
 const proof={ratingsClosed:false,ratingsDrained:false,legacyFenced:false,watchlistRepository:false,ratingsPhase:false};
 const before=await letterboxdHandoverFacts(env);
 try{
  const mode=await RatingsOrchestration.readMode(env);
  proof.ratingsClosed=!mode.malformed&&mode.record?.mode==='external';
  proof.ratingsDrained=(await RatingsOrchestration.drainState(env,now))==='verified';
  const gates=await Promise.all(['start','step'].map(action=>RatingsOrchestration.externalGate(env,action)));
  proof.legacyFenced=gates.every(gate=>gate.reason==='external_writer_fenced');
 }catch{/* an unreadable piece stays false */}
 try{const authority=await WatchlistD1.readAuthority(env);proof.watchlistRepository=authority?.state==='d1'&&authority.writes==='open';}catch{/* false */}
 try{const ports=letterboxdPorts(env);proof.ratingsPhase=!!(ports.ratings&&ports.reconcile&&ports.watchlist);}catch{/* false */}
 const after=await letterboxdHandoverFacts(env);
 if(!sameFacts(before,after)||before.ratings.mode!=='d1'||before.ratings.cutover!=='open'){for(const name of Object.keys(proof))proof[name]=false;return proof;}
 Object.defineProperty(proof,'evidence',{value:before,enumerable:false});
 return proof;
}
// AIR-571 D. The pins of the proof, built from the evidence the proof itself captured (never from a new read): the Watchlist authority is `d1`/`open` at the generation read, the Ratings domain authority is `d1`/`open`
// at the generation read (so a Ratings commit after the proof aborts the completion) and the Ratings mode, control and run documents have the stored etags that were read. They are asserted in the SAME batch that
// writes the mode row. null = no evidence: the proof stays unprotected and the handover is refused.
async function letterboxdHandoverGuards(env,handover){
 const facts=handover?.evidence;
 if(!facts||facts.watchlist.state!=='d1'||facts.watchlist.writes!=='open')return null;
 const expression="(SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)=1 AND (SELECT COUNT(*) FROM ratings_domain_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)=1"+facts.keys.map(()=>" AND COALESCE((SELECT etag FROM ratings_document WHERE key=? AND part=0),'')=?").join('');
 const params=[facts.watchlist.generation,facts.ratings.generation,...facts.keys.flatMap((key,index)=>[key,facts.etags[index]])];
 return [["INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN "+expression+" THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok",params]];
}
// AIR-571 D. The durable causal effects of the current snapshot (facts, retention, removal queue): done before a running writer is closed. Mirror delivery, Events and pending admission are not part of it.
// `guard` re-asserts exactly what was read, at the version read, in the batch that closes the epoch: a promotion committed after the read (a new version or a new undone effect) aborts the close.
async function letterboxdEffectsState(env){
 const db=WatchlistD1.bindingOf(env);
 if(!db||typeof db.prepare!=='function')return {unproven:true};
 const row=await db.prepare("SELECT version, effects_drained_version AS drainedVersion, (SELECT COUNT(*) FROM watchlist_effect WHERE status<>'done') AS pending FROM watchlist_current WHERE id=1").first();
 if(!row)return {unproven:true};
 const version=Number(row.version),drainedVersion=Number(row.drainedVersion),pending=Number(row.pending);
 const drained=drainedVersion===version&&pending===0;
 return {drained,pending,version,drainedVersion,guard:["INSERT INTO letterboxd_sync_fence (id, ok) SELECT 1, CASE WHEN (SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=? AND effects_drained_version=version)=1 AND (SELECT COUNT(*) FROM watchlist_effect WHERE status<>'done')=0 THEN 1 ELSE 0 END WHERE true ON CONFLICT (id) DO UPDATE SET ok = excluded.ok",[version]]};
}
function letterboxdPorts(env){
 const sources=sourceConfig(env);
 const effects=LetterboxdSyncEffects.effectWriters({
  repository:WatchlistD1,
  facts:LetterboxdFacts,
  retention:{UNIT_CAP:CanonicalRatedAdmission.UNIT_CAP,writerOpen:e=>CanonicalRatedAdmission.ratedAdmissionWriterOpen(e),work:a=>CanonicalRatedAdmission.watchlistRetentionWork(a),apply:(e,a)=>CanonicalRatedAdmission.applyRatedAdmissionRetention(e,a),carry:o=>CanonicalRatedAdmission.carryRatedAdmissionIntent(o),settled:o=>CanonicalRatedAdmission.ratedAdmissionSliceSettled(o)},
  removal:{enqueue:(e,films,ref)=>enqueueRemovalRefs(e,films,ref)},
  tmdbOf:letterboxdTmdbOf,
  removalRef:(e,snapshot)=>LetterboxdSync.slotEventRef(e,snapshot.slotKey,snapshot.runId),
  epochGuard:epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]],
  fenceEnv:(e,epoch)=>LetterboxdSync.fencedEnv(e,epoch),
 });
 // ADR 0203 (AIR-582): the fourth effect and the handoff reconcile. Both are inert until the membership marker (schema 37) says `sync`: the effect exists only for a snapshot promoted under it, and the reconcile returns at once otherwise.
 const membershipDeps={repository:WatchlistD1,resolve:(e,lids)=>CanonicalProducerWorkflow.resolveSourceIdentitiesEach(e,lids),setMembership:(e,input)=>CanonicalFilmWriters.setFilmMembership(e,input),epochGuard:epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]],fenceEnv:(e,epoch)=>LetterboxdSync.fencedEnv(e,epoch)};
 effects.membership=WatchlistMembership.membershipEffect(membershipDeps);
 const reconcileMembership=WatchlistMembership.membershipReconcile(membershipDeps);
 const admitNew=LetterboxdSyncAdmission.admissionStep({repository:WatchlistD1,epochGuard:epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]],fenceEnv:(e,epoch)=>LetterboxdSync.fencedEnv(e,epoch),identity:{MAX_ATTEMPTS:LetterboxdDiaryIdentity.MAX_ATTEMPTS,resolve:(e,items,opts)=>LetterboxdDiaryIdentity.resolve(e,items,opts),readIdentity:e=>LetterboxdFacts.readDiaryIdentity(e),diaryLinks:(e,lids)=>LetterboxdFacts.diaryLinks(e,lids)}});
 const repository=LetterboxdSyncRepository.watchlistRepository(WatchlistD1,{epochGuard:epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]],scanGuard:epoch=>[LetterboxdSync.SCAN_GUARD_SQL,[epoch]],effectWriters:effects,admitNew,reconcileMembership});
 const fenceGuard=epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]];
 const describeFilms=async(e,{added,removed})=>{
  const working=await MetadataCache.loadMetadataWorkingSet(e).catch(()=>null),records=working?.records||{};
  const known=film=>({...film,...(records[film.id]||{}),id:film.id,title:film.title||records[film.id]?.title,year:film.year??records[film.id]?.year});
  const rated=await storedRemovalRatings(e,{type:'watchlist',removed:removed.map(film=>eventRemovedFilm(known(film)))}).catch(()=>null);
  return {added:added.map(film=>eventFilm(known(film))),removed:rated?.event?.removed||removed.map(film=>eventRemovedFilm(known(film)))};
 };
 return {mirror:{reconcile:(e,arg)=>WatchlistMirror.reconcileMirror(e||env,{...arg,deps:{WatchlistD1,PublishedEpg}})},handover:e=>letterboxdHandover(e||env),handoverGuards:(e,handover)=>letterboxdHandoverGuards(e||env,handover),effects:e=>letterboxdEffectsState(e||env),ratings:LetterboxdSyncRatings.ratingsSlotPhase({ratings:LetterboxdRatings,fenceGuard,phase:'diary'}),reconcile:LetterboxdSyncRatings.ratingsSlotPhase({ratings:LetterboxdRatings,fenceGuard,phase:'removal'}),watchlist:LetterboxdSyncWatchlist.watchlistPhase({repository,scanOpen:e=>LetterboxdSync.scanOpen(e),fetchPage:(coordination=>url=>getHTML(url,coordination))(upstreamCoordinator(env,'letterboxd-watchlist-scan')),parse:parseWatchlist,firstUrl:sources.watchlist,username:sources.letterboxdUsername,describe:describeFilms})};
}
// AIR-572 / ADR 0203: the owner-only operator of the membership baseline and the writer switch (MCP tool watchlist_membership_operator). The same ports as the `membership` effect (identity resolver, version-fenced
// Film writer, Letterboxd Sync epoch fence), plus bounded reads of the Sync epoch and of the Producer's non-terminal chains. Nothing calls it but the owner's tool call.
async function handleWatchlistMembershipOperatorTool(env,args){
 const reads=WatchlistMembership.operatorReads({held:()=>CanonicalProducerWorkflow.PRODUCER_DELIVERY_HOLD});
 return WatchlistMembership.membershipOperator({repository:WatchlistD1,resolve:(e,lids)=>CanonicalProducerWorkflow.resolveSourceIdentitiesEach(e,lids),setMembership:(e,input)=>CanonicalFilmWriters.setFilmMembership(e,input),
  epochGuard:epoch=>[LetterboxdSync.FENCE_GUARD_SQL,[epoch]],fenceEnv:(e,epoch)=>LetterboxdSync.fencedEnv(e,epoch),...reads})(env,args);
}
// AIR-572: the owner-only terminalization of a stale Producer chain (MCP tool producer_chain_operator): the existing `supersedeChain`, only while the static delivery hold is on. Nothing calls it but the owner's tool call.
async function handleProducerChainOperatorTool(env,args){
 return CanonicalProducerChain.producerChainOperator({held:()=>CanonicalProducerWorkflow.PRODUCER_DELIVERY_HOLD})(env,args);
}
const SCHEDULED_RECONCILE_HEAD_MS=45000;
// AIR-605: the body of one Catalog Enrichment drainer instance. Dormant: with no control row in `active` it returns before any request or write.
async function runCatalogEnrichmentWorkflow(env,payload,step){return CatalogEnrichmentRunner.run(env,payload,step,{tools:typeof letterboxdPageTools==='function'?letterboxdPageTools():undefined,fetchImpl:(url,init)=>fetch(url,init),coordinator:()=>UpstreamCooldown.createCoordinator(env,{caller:'catalog_enrichment'})});}
export default {
// AIR-308 (ADR 0155): the cron trigger does not call the D1 enrichment projector. D1_ENRICHMENT_WRITE is ignored.
// AIR-580: the firing no longer calls the legacy Ratings executor's `ensure` (the Letterboxd Sync owns the Ratings phase, cron `:30`); the Workflow body and its binding stay until the owner-approved L3 slice.
// AIR-324 (ADR 0093): the same firing also calls reconcileDiscoveryWorkflow; it creates instances only while the admission gate passes.
// AIR-588 (ADR 0204): the hourly tick also runs the Prediction ordering writer, which rebuilds the queue only for ordering drift of its own generation and only while no start or commit holds the runner lease.
async scheduled(controller,env,execution){const at=controller.scheduledTime||Date.now();
// AIR-605: the Catalog Enrichment reconcile cron (dormant: the expression is not in wrangler.jsonc; the activation change delivers it, never a deploy). It wakes the drainer only while the control is active and work is runnable.
if(typeof CatalogEnrichmentRunner!=='undefined'&&controller.cron===CatalogEnrichmentRunner.CRON){execution.waitUntil(Promise.resolve().then(()=>CatalogEnrichmentRunner.reconcile(env,{})).catch(()=>{}));return;}
// AIR-534 (ADR 0174): the Discovery-only fast cron reconciles the Workflow and nothing else: no hourly report, no EPG, Ratings or Monitor.
if(typeof CatalogPosterWeekly!=='undefined'&&controller.cron===CatalogPosterWeekly.CRON){execution.waitUntil(Promise.resolve().then(()=>CatalogPosterWeekly.run(env,{now:at})).catch(()=>{}));return;}
// AIR-571 E: the Letterboxd Sync cron (dormant: the trigger is added by the activation step, never by a deploy). It runs `ensure` only: nothing of the hourly EPG, Ratings, Discovery or Monitor work.
if(typeof LetterboxdSync!=='undefined'&&controller.cron===LetterboxdSync.CRON){execution.waitUntil(Promise.resolve().then(()=>LetterboxdSync.ensure(env,{now:at,ports:letterboxdPorts(env)})).catch(()=>{}));return;}
if(typeof DISCOVERY_FAST_CRON==='string'&&controller.cron===DISCOVERY_FAST_CRON){execution.waitUntil(Promise.resolve().then(()=>typeof reconcileDiscoveryRecovery==='function'?reconcileDiscoveryRecovery(env,{now:at}):undefined).catch(()=>{}));return;}
const reconcile=Promise.resolve().then(()=>typeof reconcileDiscoveryWorkflow==='function'?reconcileDiscoveryWorkflow(env,{scheduled:true,now:at}):undefined);const settled=reconcile.then(()=>{},()=>{});const head=new Promise(resolve=>{const timer=setTimeout(resolve,SCHEDULED_RECONCILE_HEAD_MS);settled.then(()=>{clearTimeout(timer);resolve();});});execution.waitUntil((async()=>{await head;await Promise.allSettled([reconcile,typeof EpgOrchestration==='undefined'?Promise.resolve():EpgOrchestration.ensure(env,{now:Date.now()}),typeof Monitor==='undefined'?Promise.resolve():Monitor.run(env,{now:controller.scheduledTime||Date.now()}),typeof reconcilePredictionOrdering==='function'?reconcilePredictionOrdering(env,{now:Date.now()}):Promise.resolve()]);})());},
async fetch(request,env,execution){return observeUserRead(request,await routeRequest(request,env,execution));}
};
// AIR-586. A 503 the Worker answers itself on one of the four user reads of the page (Workers Logs show it with outcome `ok`, unlike an isolate that ran
// out of memory) writes one line naming its refusal: the path and the codes of its JSON body, each only when it has the shape of an internal code (lower-case
// letters, digits and underscores), so never a film id, a title, a payload or a message text. Nothing else is logged and the answer is returned unchanged.
const USER_READ_PATHS=new Set(['/api/programme','/api/enrichment/view','/api/catalog/available','/api/enrichment/footer/status']);
async function observeUserRead(request,response){
 try{
  if(response?.status!==503||request.method!=='GET')return response;
  const path=new URL(request.url).pathname;
  if(!USER_READ_PATHS.has(path))return response;
  let body=null;try{body=await response.clone().json();}catch{body=null;}
  const code=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{1,63}$/.test(value)?value:null;
  console.log(JSON.stringify({event:'user_read_refused',path,status:503,code:code(body?.code),reason:code(body?.reason),error:code(body?.error),notReady:body?.error==='Первое обновление ещё выполняется',retryAfter:response.headers.get('Retry-After')!==null}));
 }catch{/* a log line is never part of the answer */}
 return response;
}
async function routeRequest(request,env,execution){
 const url=new URL(request.url);
 try{
 if(url.pathname==='/mcp')return await mcpRoute(request,env,execution);
 if(url.pathname.startsWith('/api/')){
  if(!env.BUCKET)return json({error:'Storage unavailable'},503);
  if(['POST','PUT'].includes(request.method)&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
  // AIR-541 (ADR 0177): the degraded-origin / expected-run write fence runs before any handler, so no mutating route can skip it.
  {const fenced=await degradedWriteFence(request,env,url);if(fenced)return fenced;}
  if(url.pathname.startsWith('/api/enrichment/'))return await enrichmentRoute(request,env,url,execution);
  if(url.pathname.startsWith('/api/d1/'))return await catalogD1Route(request,env,url);
  if(url.pathname==='/api/admin/health')return await adminHealthRoute(request,env,url);
  if(url.pathname==='/api/admin/channels'||url.pathname.startsWith('/api/admin/channels/'))return await adminChannelsRoute(request,env,url);
  if(url.pathname==='/api/admin/limbo')return await adminLimboRoute(request,env,url);
  if(url.pathname==='/api/admin/identity-work')return await adminIdentityWorkRoute(request,env,url);
  if(url.pathname==='/api/admin/identity-work/owner-action')return await adminIdentityOwnerActionRoute(request,env,url); // AIR-599: owner requeue/dismiss of the shared Letterboxd check
  if(url.pathname==='/api/admin/settings')return await adminSettingsRoute(request,env,url); // AIR-605: the effective state of the Catalog Enrichment Producer (a pure read)
  if(url.pathname==='/api/admin/settings/catalog-enrichment')return await adminSettingsRoute(request,env,url); // AIR-605: its owner control (pause, resume, retry), POST only
  if(url.pathname==='/api/admin/posters')return await adminPostersRoute(request,env,url);
  if(url.pathname==='/api/admin/prediction-recovery')return await adminPredictionRecoveryRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/prediction-recovery-intent/'))return await adminPredictionRecoveryIntentRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/letterboxd-archive/'))return await adminLetterboxdArchiveRoute(request,env,url);
  if(url.pathname==='/api/admin/discovery-recovery')return await adminDiscoveryRecoveryRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/discovery-recovery/'))return await adminDiscoveryReconsiderRoute(request,env,url);
  if(request.method==='POST'&&url.pathname.startsWith('/api/admin/films/')&&url.pathname.endsWith('/title-review'))return await filmTitleReviewRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/people/')&&url.pathname.endsWith('/name-review'))return await adminPersonNameRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/'))return await adminReadRoute(request,env,url);
  if(url.pathname.startsWith('/api/letterboxd/baseline/'))return await LetterboxdFacts.handleBaselineRequest(request,env,url.pathname);
  if(url.pathname==='/api/letterboxd/diary'&&request.method==='GET'){const filmId=url.searchParams.get('filmId');if(filmId!=null&&!/^[A-Za-z0-9_-]{1,80}$/.test(filmId))return json({error:'Invalid filmId'},400);return json(await LetterboxdDiary.readHistory(env,{filmId}));}
  if(url.pathname==='/api/letterboxd/ratings/status'&&request.method==='GET')return json(await LetterboxdRatings.status(env));
  // AIR-349: the monitor's stored result is a pure read; the synthetic test message changes only the monitor's own document.
  if(url.pathname==='/api/monitor/status'&&request.method==='GET')return json(await Monitor.status(env));
  if(url.pathname==='/api/monitor/test'&&request.method==='POST')return json(await Monitor.test(env));
  if(url.pathname==='/api/epg/executor'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}const reply=await EpgOrchestration.handle(env,body);return json(reply.body,reply.status);}
  // AIR-571 D: the owner's Letterboxd Sync mode control, the same pattern and the same Access protection as the Ratings executor route. GET is read-only; POST takes one command with its confirmation and pins.
  if(typeof LetterboxdSync!=='undefined'&&url.pathname==='/api/letterboxd/sync/mode'&&request.method==='GET')return json(await LetterboxdSync.modeStatus(env,letterboxdPorts(env)));
  if(typeof LetterboxdSync!=='undefined'&&url.pathname==='/api/letterboxd/sync/mode'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}const reply=await LetterboxdSync.handle(env,body,letterboxdPorts(env));return json(reply.body,reply.status);}
  if(url.pathname==='/api/letterboxd/ratings/executor'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}const reply=await RatingsOrchestration.handle(env,body);return json(reply.body,reply.status);}
  if(url.pathname==='/api/events'&&request.method==='GET'){const cursor=url.searchParams.get('cursor');if(cursor&&cursor.length>4000)return json({error:'Invalid cursor'},400);return json(await eventPage(env,cursor));}
  if(url.pathname==='/api/events/bootstrap'&&request.method==='POST'){try{await bootstrapEvents(env);}catch(error){if(error instanceof StartedStorageError)return json({error:STARTED_UNAVAILABLE},503);throw error;}return json({ok:true});}
  if(url.pathname==='/api/started'&&request.method==='GET'){try{return json({ids:await startedFilms(env)});}catch(error){if(error instanceof StartedStorageError)return json({error:STARTED_UNAVAILABLE},503);throw error;}}
  if(url.pathname==='/api/started'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!body||typeof body!=='object')return json({error:'Invalid request'},400);return await setStarted(env,body);}
  if(url.pathname==='/api/programme'&&request.method==='GET'){
   try{
    const gate=await titleReadGate(env);
    const pinned=await pinEpg(env);
    const data=await loadJSON(pinned,'programme.json');
    if(!data)return json({error:'Первое обновление ещё выполняется'},503);
    const wbox={},watchlist=await composeWatchlistRead(env,await loadJSON(pinned,'watchlist.json'),data,wbox);
    const titles=await localizedTitleStore(env,pinned,gate,[...(data?.films||[]),...(watchlist?.films||[])]);
    const reviews=await publishedOwnerReviews(pinned);
    if(!reviews.ok){if(reviews.temporary){const degraded=await degradedProgrammeResponse(env,{code:'owner_review_unavailable',temporary:true});if(degraded)return degraded;}return json({error:'storage_unavailable',reason:'owner_review_unavailable'},503);}
    const merged=programmeWithWatchlist(data,watchlist);
    let catalog=null;
    if(Array.isArray(merged.catalogFilms)&&merged.catalogFilms.length){
     try{const publication=await epgPublication(env);catalog=await catalogGenerationCopy(env,publication,data.runId||null,'discovered-films.json',programmeCatalogProjection(merged.catalogFilms));}
     catch{catalog=null;}
    }
    const presented=presentLocalized(presentCatalogFilms(merged,catalog),titles,reviews.body);
    const sync=await loadJSON(env,'sync.json');
    const publishedAt=typeof epgUxPublishedAt==='function'?epgUxPublishedAt(sync,data):null;
    if(publishedAt)presented.publishedAt=publishedAt;else delete presented.publishedAt;
    degradedRecovered('programme');
    await watchlistStill(env,wbox);
    return await titleReadFinish(env,gate,json(presented));
   }catch(error){if(error?.code==='published_epg_fence')return json({error:'published_epg_fence',retry:true},409);{const faulted=watchlistRouteFault(error);if(faulted)return faulted;}if(isTemporaryReadFault(error)){const degraded=await degradedProgrammeResponse(env,error);if(degraded)return degraded;if(error?.watchlistAuthority)return json({error:'storage_unavailable',reason:error.code},503);}const refused=titleReadRefusal(error);if(refused)return refused;throw error;}
  }
  if(url.pathname==='/api/watchlist'&&request.method==='GET'){
   try{
    const gate=await titleReadGate(env);
    const pinned=await pinEpg(env);
    let data=await loadJSON(pinned,'watchlist.json');
    const report=await loadJSON(pinned,'programme.json');
    if(pinned.epgPin?.authority!=='d1'&&report?.films?.length===report.watchlistCount&&data?.updatedAt!==report.updatedAt)data={updatedAt:report.updatedAt,films:report.films};
    const wbox={};data=await composeWatchlistRead(env,data,report,wbox);
    if(!data)return await titleReadFinish(env,gate,json({films:[]}));
    const titles=await localizedTitleStore(env,pinned,gate,data?.films||[]);
    const reviews=await publishedOwnerReviews(pinned);
    if(!reviews.ok){if(reviews.temporary){const degraded=await degradedWatchlistResponse(env,{code:'owner_review_unavailable',temporary:true});if(degraded)return degraded;}return json({error:'storage_unavailable',reason:'owner_review_unavailable'},503);}
    degradedRecovered('watchlist');
    await watchlistStill(env,wbox);
    return await titleReadFinish(env,gate,json(presentLocalized(data,titles,reviews.body)));
   }catch(error){if(error?.code==='published_epg_fence')return json({error:'published_epg_fence',retry:true},409);{const faulted=watchlistRouteFault(error);if(faulted)return faulted;}if(isTemporaryReadFault(error)){const degraded=await degradedWatchlistResponse(env,error);if(degraded)return degraded;if(error?.watchlistAuthority)return json({error:'storage_unavailable',reason:error.code},503);}const refused=titleReadRefusal(error);if(refused)return refused;throw error;}
  }
  if(url.pathname==='/api/catalog/available'&&request.method==='GET')return await catalogAvailableRoute(env);
  {const permanent=/^\/api\/catalog\/film\/([^/]+)$/.exec(url.pathname);if(permanent&&request.method==='GET'){let id;try{id=decodeURIComponent(permanent[1]);}catch{id='';}return await catalogFilmRoute(env,id);}}
  if(url.pathname==='/api/catalog/watched')return await catalogWatchedRoute(request,env,url);
  if(url.pathname==='/api/status'&&request.method==='GET')return json(await syncStatus(env));
  if(url.pathname==='/api/integrations/tmdb/status'&&request.method==='GET'){
   if(!env.TMDB_API_READ_ACCESS_TOKEN)return json({connected:false,stage:'missing_secret'},503);
   // AIR-604 (ADR 0211 decision 5): a READ-ONLY caller of the shared TMDB cooldown. `peek` never writes: with an enforced active cooldown the probe answers from it without a request;
   // otherwise it requests as today, and a 429 is reported as before without writing the cooldown (this route is a GET; ADR 0107).
   {const gate=await upstreamCoordinator(env,'tmdb-status-probe')?.peek('tmdb');if(gate?.skip)return json({connected:false,stage:'upstream_cooldown',reason:gate.reason,until:new Date(gate.until).toISOString()},503);}
   const response=await fetch('https://api.themoviedb.org/3/movie/11?language=en-US',{headers:{Authorization:'Bearer '+env.TMDB_API_READ_ACCESS_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
   if(!response.ok)return json({connected:false,stage:'tmdb_http',status:response.status},502);
   const movie=await response.json();return json({connected:movie.id===11,stage:movie.id===11?'ready':'unexpected_response'});
  }
  if(url.pathname==='/api/ui/filter-presets'&&request.method==='GET')return await filterPresetsRoute(request,env,url);
  if(url.pathname==='/api/ui/filter-presets'&&request.method==='POST')return await filterPresetsRoute(request,env,url);
  if(url.pathname.startsWith('/api/ui/filter-presets/')&&(request.method==='PATCH'||request.method==='DELETE'))return await filterPresetsRoute(request,env,url);
  if(url.pathname==='/api/sync/start'&&request.method==='POST')return await postSync(env,execution,'/api/sync/start',{});
  if(['/api/sync/metadata','/api/sync/epg'].includes(url.pathname)&&request.method==='POST'){const body=await request.json();return await postSync(env,execution,url.pathname,body);}
  return json({error:'Not found'},404);
 }
 if((request.method==='GET'||request.method==='HEAD')&&url.pathname==='/admin/limbo'){const target=new URL(request.url);target.pathname='/admin/limb';return new Response(null,{status:302,headers:{Location:target.pathname+target.search,'Cache-Control':'no-store'}});}
 const filmDocument=/^\/film\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
 const page=url.pathname==='/events'?'/':filmDocument?'/':url.pathname,asset=ASSETS[page];
 if(asset&&(request.method==='GET'||request.method==='HEAD')){
  // AIR-531: the HTTP status of a film permalink document follows what the page will say (404 absent, 410 retired, 409 conflict, 503/500 unavailable); the shell is the same.
  const status=filmDocument?await filmDocumentStatus(env,filmDocument[1]):200;
  return new Response(request.method==='HEAD'?null:asset.body,{status,headers:{'Content-Type':asset.type+'; charset=utf-8','Cache-Control':status===200?'no-cache':'no-store'}});
 }
 return json({error:'Not found'},404);
 }catch(e){
  // The only trace of an unhandled route error, so a 502 can be read from the logs. Only values shaped like an internal code are logged (lower-case letters,
  // digits and underscores, at most 64): an error text from D1, a provider or a library can carry a film id, a SQL statement, a path or a secret, and is dropped.
  const internalCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{1,63}$/.test(value)?value:null;
  console.error(JSON.stringify({event:'route_error',method:request.method,path:url.pathname,code:internalCode(e?.code),message:internalCode(e?.message),name:typeof e?.name==='string'&&/^[A-Za-z]{1,40}$/.test(e.name)?e.name:null}));
  return json({error:e.message},502);
 }
}
