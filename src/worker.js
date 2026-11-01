const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function addGroup(left,right,displayed){const group={compared:(left?.compared||0)+(right?.compared||0),mismatched:(left?.mismatched||0)+(right?.mismatched||0)};if(displayed)group.displayed=(left?.displayed||0)+(right?.displayed||0);return group;}
function recordLifecycle(run,path,mode,count){if(!run||(mode!=='on'&&mode!=='shadow')||!count?.films)return;const prior=run.lifecycleLocalization?.[path];run.lifecycleLocalization={...(run.lifecycleLocalization||{}),[path]:{mode,films:addGroup(prior?.films,count.films,true),people:addGroup(prior?.people,count.people,true),cache:addGroup(prior?.cache,count.cache,false)}};}
const loadJSON=async(env,key)=>{
 const staged=key==='programme.json'?'programme.json':key==='epg/discovery-latest.json'?'discovery-latest.json':key==='epg/discovered-films.json'?'discovered-films.json':null;
 if(staged){
  const pinned=env.epgPin?.programmeRunId;
  if(pinned){const object=await env.BUCKET.get(epgGenerationKey(pinned,staged));if(object)return object.json();}
  else{const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if(pointer){const generation=await pointer.json();if(generation?.phase==='published'&&generation.programmeRunId){const object=await env.BUCKET.get(epgGenerationKey(generation.programmeRunId,staged));if(object)return object.json();}}}
 }
 if(typeof PredictionD1!=='undefined'){const routed=await PredictionD1.routeRead(env,key);if(routed.handled)return routed.value;}
 const o=await env.BUCKET.get(key);let value=o?await o.json():null;
 if(key==='enrichment/view-index.json'&&typeof PredictionD1!=='undefined')value=await PredictionD1.overlayIndex(env,value,canonicalMoodFacet);
 return value;
};
async function pinEpg(env){
 if(env.epgPin?.programmeRunId)return env;
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
function catalogShowStatus(show,now){return Number(show.start)>now?'future':Number(show.end)>now?'on_air':'archive';}
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
// Films the owner has watched or rated, as TMDB ids, so a catalog record is excluded whatever id it uses. A view-index entry
// counts when it is watched (`watched: true`, projected from fact records) or carries an actual rating (also the legacy index).
// The entry's own TMDB id comes from a `tmdb_<n>` key; a Letterboxd id is bridged to a TMDB id only through a stored id: the
// metadata cache, the watchlist, the programme or a verified catalog record with that id, and only while all of them agree. A
// Letterboxd id with two stored TMDB ids, or with none, is matched by its own id alone. Titles are never compared.
const CATALOG_TMDB_ID=/^tmdb_([1-9]\d*)$/;
const catalogConsumed=item=>item?.watched===true||item?.actualRating!=null;
function catalogConsumedTmdb({index,metadata,watchlist,programme,catalog}){
 const byLid=new Map(),conflicted=new Set();
 const add=(id,tmdbId)=>{
  if(id==null||tmdbId==null)return;const lid=String(id),tmdb=String(tmdbId);
  if(CATALOG_TMDB_ID.test(lid)||!/^[1-9]\d*$/.test(tmdb)||conflicted.has(lid))return;
  if(!byLid.has(lid))byLid.set(lid,tmdb);else if(byLid.get(lid)!==tmdb){byLid.delete(lid);conflicted.add(lid);}
 };
 for(const [id,record] of Object.entries(metadata||{}))add(record?.id??id,record?.tmdbId);
 for(const film of [...(watchlist?.films||[]),...(programme?.films||[])])add(film?.id,film?.tmdbId);
 for(const film of Object.values(catalog||{}))if(film?.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId))add(film.id,film.tmdbId);
 const consumed=new Set();
 for(const [id,item] of Object.entries(index||{})){if(!catalogConsumed(item))continue;const tmdb=CATALOG_TMDB_ID.exec(id)?.[1]||byLid.get(id);if(tmdb)consumed.add(tmdb);}
 return consumed;
}
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
function catalogAvailable({catalog,programme,watchlist,index,profile,metadata,programmeRunId,pinned,now,titleExclusion={state:'unavailable',keys:null},freshness=strictFreshness(profile),watchedMarkEnabled=false}){
 const from=now-CATALOG_ARCHIVE_MS,to=now+CATALOG_FUTURE_MS,excluded=new Set(),posterFor=catalogPosters(metadata),posterSource=new Map();
 for(const film of [...(programme?.films||[]),...(watchlist?.films||[])]){if(film?.id!=null)excluded.add(String(film.id));if(film?.tmdbId)excluded.add('tmdb:'+String(film.tmdbId));}
 const consumedTmdb=catalogConsumedTmdb({index,metadata,watchlist,programme,catalog});
 const hidden=titleExclusion.state==='applied'?findsTitleSuppressor({keys:titleExclusion.keys,rule:titleExclusion.rule,catalog,metadata,watchlist,programme}):null,hiddenIdentities=new Set();
 const byIdentity=new Map();
 for(const film of Object.values(catalog||{})){
  if(!film||!film.tmdbId||film.canonicalIdentity!=='tmdb:'+String(film.tmdbId))continue;
  const id=String(film.id),identity=film.canonicalIdentity;
  if(excluded.has(id)||excluded.has(identity))continue;
  const item=index?.[id];
  // Watched or rated, under this id or any id of the same TMDB film: never offered, so a prediction never stands in for a rating.
  if(catalogConsumed(item)||consumedTmdb.has(String(film.tmdbId)))continue;
  // The same freshness rule as the queue and the view, for the same profile snapshot.
  if(!profile||!freshness.indexed(item,film))continue;
  if(!Array.isArray(film.shows)||film.showsProgrammeRunId!==programmeRunId)continue;
  const shows=dedupeShows(film.shows).filter(show=>Number(show.start)>from&&Number(show.start)<to).sort((a,b)=>Number(a.start)-Number(b.start)||String(a.channelId||'').localeCompare(String(b.channelId||''),'en'));
  if(!shows.length)continue;
  // Checked last, so the count covers only films the response would otherwise offer.
  if(hidden?.(film)){hiddenIdentities.add(identity);continue;}
  const latest=Math.max(...shows.map(show=>Number(show.start))),availableUntil=latest+CATALOG_ARCHIVE_MS,future=shows.filter(show=>Number(show.start)>now);
  const prediction=item.prediction,fingerprint=item.fingerprint&&item.fingerprint.fingerprintHash===item.fingerprintHash?item.fingerprint:null,facet=canonicalMoodFacet(fingerprint,prediction);
  const artwork=posterFor(film);
  const entry={id,tmdbId:String(film.tmdbId),canonicalIdentity:identity,title:film.title||null,original:film.original||null,year:film.year??null,runtime:film.runtime??null,genres:Array.isArray(film.genres)?film.genres:[],poster:artwork.poster,url:film.url||null,
   directors:(film.directors||[]).map(catalogPerson),actors:(film.actors||[]).map(catalogPerson),
   shows:shows.map(show=>({channelId:show.channelId??null,channel:show.channel??null,start:Number(show.start),end:Number.isFinite(Number(show.end))?Number(show.end):null,status:catalogShowStatus(show,now)})),
   availableNow:shows.some(show=>Number(show.start)<=now),nextStart:future.length?Number(future[0].start):null,availableUntil:new Date(availableUntil).toISOString(),
   prediction:{predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus??null,confidence:prediction.confidence??null,matchSignals:Array.isArray(prediction.matchSignals)?prediction.matchSignals:[],mainRisk:prediction.mainRisk??null,moodIds:facet.moodIds},
   fingerprint:fingerprint?{plotMechanics:fingerprint.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(fingerprint.execution)}:null};
  posterSource.set(entry,artwork.source);
  const kept=byIdentity.get(identity);
  if(!kept||Date.parse(entry.availableUntil)>Date.parse(kept.availableUntil)||(entry.availableUntil===kept.availableUntil&&id<kept.id))byIdentity.set(identity,entry);
 }
 const films=[...byIdentity.values()].sort((a,b)=>Date.parse(a.availableUntil)-Date.parse(b.availableUntil)||a.id.localeCompare(b.id,'en'));
 const channels=new Map();
 for(const film of films)for(const channelId of new Set(film.shows.map(show=>show.channelId))){const show=film.shows.find(item=>item.channelId===channelId),entry=channels.get(channelId)||{channelId,channel:show.channel,films:0};entry.films++;channels.set(channelId,entry);}
 // Where each returned poster came from, counted over the returned films only, so a plain GET shows how many still lack an asset.
 const posterCoverage={catalog:0,metadataCache:0,missing:0};
 for(const film of films){const source=posterSource.get(film);if(source==='catalog')posterCoverage.catalog++;else if(source==='metadata_cache')posterCoverage.metadataCache++;else posterCoverage.missing++;}
 const displayExclusion={state:titleExclusion.state,excluded:[...hiddenIdentities].filter(identity=>!byIdentity.has(identity)).length};
 return {programmeRunId,pinned,watchedMarkEnabled,generatedAt:new Date(now).toISOString(),window:{from:new Date(from).toISOString(),to:new Date(to).toISOString()},profile:profile?{version:profile.version}:null,total:films.length,posterCoverage,displayExclusion,films,channels:[...channels.values()].sort((a,b)=>String(a.channelId).localeCompare(String(b.channelId),'en'))};
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
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 const runId=generation?.phase==='published'&&generation.programmeRunId?generation.programmeRunId:null;
 const object=runId?await env.BUCKET.get(epgGenerationKey(runId,'discovered-films.json')):null,catalog=object?await object.json():null;
 const film=Object.values(catalog||{}).find(item=>item&&String(item.tmdbId)===body.tmdbId&&item.canonicalIdentity==='tmdb:'+body.tmdbId);
 if(!film)return json({error:'Film is not a verified record of the published catalog',code:'film_not_in_catalog'},409);
 try{
  const result=await LetterboxdFacts.recordOwnerWatchedMark(env,body.tmdbId,body.watched,{observedAt:new Date().toISOString()});
  return json({outcome:result.outcome,watched:result.watched});
 }catch(error){
  if(error instanceof LetterboxdFacts.FactsError)return json({error:'Could not record the mark; try again',code:error.code},409);
  throw error;
 }
}
async function catalogAvailableRoute(env){
 const now=Date.now();
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 const pinnedRunId=generation?.phase==='published'&&generation.programmeRunId?generation.programmeRunId:null;
 // Strict pin: with a published pointer the generation's own copies are required, and an absent copy fails closed
 // instead of falling back to the shared public keys (the shared `loadJSON` fallback is unchanged for other routes).
 const generationCopy=async name=>{const object=await env.BUCKET.get(epgGenerationKey(pinnedRunId,name));return object?object.json():null;};
 const [programme,catalog,watchlist,index,profile,metadata,titleExclusion]=await Promise.all([pinnedRunId?generationCopy('programme.json'):loadJSON(env,'programme.json'),pinnedRunId?generationCopy('discovered-films.json'):loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'watchlist.json'),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,profileKey),loadJSON(env,'metadata.json'),loadFindsTitleExclusion(env,now)]);
 if(pinnedRunId&&(!programme||programme.runId!==pinnedRunId))return json({error:'Programme generation is not in place'},409);
 if(pinnedRunId&&!catalog)return json({error:'Catalog generation copy is not in place'},409);
 if(!programme?.runId||!Array.isArray(programme.films))return json({error:'No published programme'},503);
 // The ratings seed is applied to a copy: unlike `/api/enrichment/view`, this read never writes it back.
 const seeded=JSON.parse(JSON.stringify(index||{}));applyRatingsSeed(seeded);
 return json(catalogAvailable({catalog,programme,watchlist,index:seeded,profile,metadata,programmeRunId:pinnedRunId||programme.runId,pinned:!!pinnedRunId,now,titleExclusion,freshness:await predictionFreshness(env,profile),watchedMarkEnabled:true}));
}
function publicEpgKey(name){return name==='programme.json'?name:'epg/'+name;}
async function updatePublishedFiles(env,files){
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 if(!generation?.programmeRunId||generation.phase!=='published'){for(const [name,value] of Object.entries(files))await saveJSON(env,publicEpgKey(name),value);return null;}
 for(const [name,value] of Object.entries(files))await saveJSON(env,epgGenerationKey(generation.programmeRunId,name),value);
 const again=await env.BUCKET.get(EPG_GENERATION_KEY),current=again?await again.json():null;
 if(current?.programmeRunId!==generation.programmeRunId||pointer.etag&&again?.etag!==pointer.etag)throw new Error('EPG generation changed during publish');
 for(const [name,value] of Object.entries(files))await saveJSON(env,publicEpgKey(name),value);
 return generation.programmeRunId;
}
const saveJSON=async(env,key,value)=>{
 if(typeof PredictionD1!=='undefined'){
  const routed=await PredictionD1.saveMutable(env,key,value);
  if(routed?.handled)return {etag:'d1'};
  const text=routed?.text??JSON.stringify(value);
  let settled=false;
  try{const saved=await env.BUCKET.put(key,text,{httpMetadata:{contentType:'application/json'}});settled=true;return saved;}
  finally{if(routed?.token&&settled)await PredictionD1.completePredictionWrite(env,key,routed.token);}
 }
 return env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
};
function confirmedHalfStar(value){const rating=Number(value);return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0?rating:null;}
function removalRating(film){const rating=confirmedHalfStar(film?.rating);if(rating==null)return null;const observed=typeof film.ratingObservedAt==='string'&&Number.isFinite(Date.parse(film.ratingObservedAt))?film.ratingObservedAt:null;return observed?{rating,ratingObservedAt:observed}:{rating};}
const eventFilm=(film,titles=new Map())=>({id:String(film.id),title:(film.titleAuthority==='owner'&&(film.titleRu||film.title))||reviewedTitle(film)?.title||titles.get(String(film.id))||film.title||film.original,year:film.year});
function eventRemovedFilm(film,titles=new Map()){const rating=removalRating(film);return {...eventFilm(film,titles),...(rating||{})};}
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
async function enrichKnownRemovalEvent(env,run,ratings,observedAt){
 try{
  const index=(run?.events||[]).findIndex(item=>item?.type==='watchlist'&&item.removed?.length);if(index<0)return;
  const current=await loadJSON(env,removalEventKey(run.events[index]))||run.events[index],next=withRemovalRatings(current,ratings,observedAt);if(!next)return;
  await writeEvent(env,next);run.events[index]=next;
 }catch{}
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
function epgEvent(report,id){const cutoff=Date.parse(report.updatedAt);const archive=f=>f.shows.some(s=>s.start>=cutoff-72*3600000&&s.start<cutoff),future=f=>f.shows.some(s=>s.start>=cutoff&&s.start<cutoff+24*3600000);return {id,type:'epg',at:report.updatedAt,films:report.stats.uniqueFilms??report.films.filter(f=>f.shows?.length).length,archive:report.films.filter(archive).length,future:report.films.filter(future).length,broadcasts:report.films.reduce((n,f)=>n+f.shows.length,0)};}
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
async function eventPage(env,cursor){const page=await env.BUCKET.list({prefix:'events/items/',limit:20,...(cursor?{cursor}:{})});const events=await Promise.all(page.objects.map(o=>loadJSON(env,o.key)));for(const event of events.filter(Boolean)){if(event.film)event.film=eventFilm(event.film);if(Array.isArray(event.added))event.added=event.added.map(f=>eventFilm(f));if(Array.isArray(event.removed))event.removed=event.removed.map(f=>eventRemovedFilm(f));}return {events:events.filter(Boolean),cursor:page.truncated?page.cursor:null};}
async function bootstrapEvents(env){if(await loadJSON(env,'events/bootstrap.json'))return;const report=await loadJSON(env,'programme.json'),list=await loadJSON(env,'watchlist.json');if(report)await writeEvent(env,epgEvent(report,'baseline-epg'));if(list)await writeEvent(env,watchlistEvent(null,list,null,report,'baseline-watchlist'));let cursor;do{const page=await env.BUCKET.list({prefix:'started/',...(cursor?{cursor}:{})});for(const o of page.objects){const mark=await loadJSON(env,o.key);if(mark?.lastEvent){await writeEvent(env,mark.lastEvent);continue;}if(mark&&mark.started!==false&&mark.startedAt){const film=report?.films.find(f=>String(f.id)===mark.id)||list?.films.find(f=>String(f.id)===mark.id);if(film)await writeEvent(env,{id:'baseline-started-'+mark.id,type:'started',at:mark.startedAt,film:eventFilm(film,eventTitles(report))});}}cursor=page.truncated?page.cursor:undefined;}while(cursor);await saveJSON(env,'events/bootstrap.json',{at:new Date().toISOString()});}
async function startedFilms(env){let cursor;const ids=[];do{const page=await env.BUCKET.list({prefix:'started/',include:['customMetadata'],...(cursor?{cursor}:{})});for(const object of page.objects){const match=object.key.match(/^started\/([a-zA-Z0-9_-]+)\.json$/);if(match&&object.customMetadata?.started!=='false')ids.push(match[1]);}cursor=page.truncated?page.cursor:undefined;}while(cursor);return ids;}
async function setStarted(env,body){
 if(typeof body.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)||typeof body.started!=='boolean')return json({error:'Invalid film or state'},400);
 const key='started/'+body.id+'.json',previous=await loadJSON(env,key),wasStarted=!!previous&&previous.started!==false;
 if(wasStarted===body.started){if(previous?.lastEvent)await writeEvent(env,previous.lastEvent);return json({id:body.id,started:body.started});}
 const metadata=await loadJSON(env,'metadata.json')||{},report=await loadJSON(env,'programme.json');const film=metadata[body.id]||report?.films.find(f=>String(f.id)===body.id);if(body.started&&!film)return json({error:'Unknown film'},404);
 const at=new Date().toISOString(),event={id:crypto.randomUUID(),type:body.started?'started':'unstarted',at,film:film?eventFilm(film,eventTitles(report)):previous?.lastEvent?.film||{id:body.id,title:'Фильм',year:null}};
 await env.BUCKET.put(key,JSON.stringify({id:body.id,started:body.started,startedAt:body.started?at:null,lastEvent:event}),{httpMetadata:{contentType:'application/json'},customMetadata:{started:String(body.started)}});
 await writeEvent(env,event);return json({id:body.id,started:body.started});
}
async function beginSync(env){
 const current=await loadJSON(env,'sync.json');if(current&&['metadata','epg'].includes(current.stage)&&Date.now()-Date.parse(current.updatedAt)<15*60000)return {runId:current.runId,stage:current.stage,remaining:current.remaining};
 try{
 const sources=sourceConfig(env),watchlistObservedAt=new Date().toISOString();let url=sources.watchlist,pages=0,total=null;const films=new Map();
 while(url){const p=parseWatchlist(await getHTML(url));pages++;if(pages>100)throw new Error('Watchlist pagination limit exceeded');if(!Number.isInteger(p.total))throw new Error('Watchlist total not found');if(total===null)total=p.total;if(total!==p.total)throw new Error('Watchlist changed during synchronization; retry');if(p.films.length===0&&total>0)throw new Error('Watchlist page has no films');for(const f of p.films){if(films.has(f.id))throw new Error('Duplicate film across pages; retry');films.set(f.id,f);}if(p.next&&!new RegExp('^/'+sources.letterboxdUsername+'/watchlist/page/\\d+/$').test(p.next))throw new Error('Unexpected pagination URL');url=p.next?'https://letterboxd.com'+p.next:null;}
 if(films.size!==total)throw new Error(`Incomplete watchlist: ${films.size}/${total}`);
 const verify=parseWatchlist(await getHTML(sources.watchlist));if(verify.total!==total||verify.films.some((f,i)=>f.id!==[...films.values()][i]?.id))throw new Error('Watchlist changed during synchronization; retry');
 const working=await MetadataCache.loadMetadataWorkingSet(env);const cache=working.records;const now=Date.now();const all=[...films.values()].map(f=>MetadataCache.mergeWatchlistFilm(f,cache[f.id]));const pending=all.filter(f=>MetadataCache.metadataPending(f,now)).map(f=>f.id);
 const gate=await ratingsGate(env);
 if(gate.active&&current)await flushRemovalHandover(env,current);
 const carried=!gate.active&&current?{...(current.removalRefs?{removalRefs:current.removalRefs}:{}),...(current.removalLookups?{removalLookups:current.removalLookups}:{})}:{};
 const run={runId:crypto.randomUUID(),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),stage:pending.length?'metadata':'epg',watchlist:all,pending,...carried,cursor:0,remaining:pending.length,pages,watchlistObservedAt,failures:[],...(current?.ratingObservedAt?{ratingObservedAt:current.ratingObservedAt}:{})};await saveJSON(env,'sync.json',run);await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,failedAt:null,lastSuccessAt:run.startedAt});return {runId:run.runId,stage:run.stage,watchlistCount:total,pages,remaining:run.remaining};
 }catch(e){const previous=await loadJSON(env,'sync.json'),ingest=await loadJSON(env,'watchlist-ingest.json'),lastSuccessAt=previous?.stage==='complete'&&!previous.error?previous.updatedAt:ingest?.lastSuccessAt||null;await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,code:'watchlist_failed',failedAt:new Date().toISOString(),lastSuccessAt});throw e;}
}
async function metadataSync(env,run){
 const working=await MetadataCache.loadMetadataWorkingSet(env);const cache=working.records;const creditsChanged=new Set();const next=run.pending.slice(run.cursor,run.cursor+24);const onlyNames=next.every(id=>cache[id]?.peopleVersion===1&&Date.now()-Date.parse(cache[id].metadataAt)<30*86400000);const ids=next.slice(0,onlyNames?24:12);
 for(let i=0;i<ids.length;i+=3)await Promise.all(ids.slice(i,i+3).map(async id=>{const idx=run.watchlist.findIndex(f=>f.id===id);try{const film=run.watchlist[idx],fresh=film.peopleVersion===1&&film.metadataAt&&Date.now()-Date.parse(film.metadataAt)<30*86400000;if(fresh&&film.synopsisFetchedAt){if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const html=await getHTML(film.url);if(fresh){film.synopsis=parseSynopsis(html);film.synopsisFetchedAt=new Date().toISOString();cache[id]={...cache[id],synopsis:film.synopsis,synopsisFetchedAt:film.synopsisFetchedAt};if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const result=parseFilm(html,film);cache[id]=result;run.watchlist[idx]=result;creditsChanged.add(id);}catch(e){run.failures.push({id,error:e.message});}}));
 const titles=await loadJSON(env,'titles.json')||{};const titleBatch=run.watchlist.filter(f=>ids.includes(f.id));const localizationMode=metadataLocalizationMode(env);
 try{recordLifecycle(run,'metadata',localizationMode,await localizeFilmTitles(titleBatch,titles,localizationMode));}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 await saveJSON(env,'titles.json',titles);
 const people=await loadJSON(env,'people.json')||{};const batch=run.watchlist.filter(f=>creditsChanged.has(f.id)&&f.peopleVersion===1);
 try{if(batch.length)recordLifecycle(run,'metadata',localizationMode,await localizePeople(batch,people,localizationMode));for(const f of batch){f.peopleLocalizedAt=new Date().toISOString();f.peopleNamesVersion=2;}}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of batch)cache[f.id]=f;
 await saveJSON(env,'people.json',people);
 run.cursor+=ids.length;run.remaining=run.pending.length-run.cursor;run.stage=run.remaining?'metadata':'epg';run.updatedAt=new Date().toISOString();await MetadataCache.saveMetadataWorkingSet(env,cache,working);await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,remaining:run.remaining,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length};
}
async function finishSync(env,run,report){const list=await loadJSON(env,'watchlist.json');if(report.films?.length===report.watchlistCount&&list?.updatedAt!==report.updatedAt)await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:report.films.map(({shows,...f})=>f)});
 // A complete watchlist is one observation of every listed film (ADR-0024).
 if(report.films?.length===report.watchlistCount&&run.watchlistObservedAt)await LetterboxdFacts.applyWatchlistScan(env,{scanId:run.runId,observedAt:run.watchlistObservedAt,films:report.films.map(f=>({id:f.id,tmdbId:f.tmdbId}))});for(const event of run.events)await writeEvent(env,event);run.stage='complete';run.updatedAt=new Date().toISOString();delete run.watchlist;delete run.pending;await saveJSON(env,'sync.json',run);try{await tracedPhase(run.runId,'queue_refresh',()=>refreshPredictionQueue(env,report,'programme_updated'));}catch(e){run.enrichmentQueueError=String(e.message).slice(0,160);await saveJSON(env,'sync.json',run);}return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats};}
// AIR-212: opens the discovery series for the generation this run has just published, before the commit's
// memory-heavy tail (finishSync, the prediction queue, ratings). queueDiscovery is idempotent and fenced: it
// refuses a generation that is no longer the published one, keeps a live writer and keeps the progress of a
// series already open for this generation. A failure here is not fatal: syncStep queues again once the commit
// completes, and the AIR-159 handoff covers a run that never gets there.
async function queueCommittedDiscovery(env,run){
 try{await queueDiscovery(env,'epg_committed',run.runId);}catch(e){run.discoveryError=String(e.message).slice(0,160);}
}
async function copyEpgGeneration(env,runId){
 for(const name of ['discovery-latest.json','discovered-films.json','programme.json']){const staged=await env.BUCKET.get(epgGenerationKey(runId,name));if(staged)await saveJSON(env,name==='programme.json'?name:'epg/'+name,await staged.json());}
}
// AIR-220 / ADR 0034: the discovery ledger of a commit in `bounded` or `frozen` mode. Runs under the discovery lease that
// publishEpgGeneration holds, before the generation's files are written. It reads the predecessor's active ledger (the
// published generation P whose pointer etag is `fence.pointerEtag`), looks up re-entering keys in the archive one segment at
// a time, writes the departures as new write-once segment versions and a manifest, and swaps the archive pointer only while
// the published pointer, the lease and the commit's run are unchanged. Any fence loss throws before anything is published.
async function writeLedgerSegment(env,key,value,fence){
 await fence();const text=JSON.stringify(value);
 const saved=await env.BUCKET.put(key,text,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
 if(saved===null)throw new Error('Discovery archive version already exists');
 return {sha256:await textSha256(text),bytes:new TextEncoder().encode(text).length};
}
async function readLedgerManifest(env,manifestId){return manifestId?loadJSON(env,ledgerArchiveManifestKey(manifestId)):null;}
async function readLedgerSegment(env,manifest,segment){const entry=manifest?.segments?.[segment];return entry?.object?(await loadJSON(env,entry.object))?.items||{}:{};}
async function planDiscoveryLedger(env,{runId,latest,mode,lease,pointerEtag,publishedRunId,kind='commit'}){
 const previous=await loadJSON(env,'epg/discovery-latest.json');
 const archivePointer=await env.BUCKET.get(LEDGER_ARCHIVE_POINTER),archiveEtag=archivePointer?.etag??null,startId=archivePointer?(await archivePointer.json())?.manifestId||null:null;
 // Without an archive, `frozen` (and `full`) is the single growing ledger. Once an archive exists, `full` acts as `frozen`:
 // the full ledger is never rebuilt inside the Worker (ADR 0034, rollback R1).
 const effective=mode==='bounded'?'bounded':startId?'frozen':'full';
 if(effective==='full')return {items:mergeDiscoveryCandidates(previous?.items,latest,{replaceShows:true,programmeRunId:runId}),ledger:{}};
 const fence=async()=>{
  if(!await renewDiscoveryLease(env,lease))throw new Error('Discovery archive fence lost: lease');
  const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if((pointer?.etag??null)!==pointerEtag)throw new Error('Discovery archive fence lost: published generation changed');
  if(kind==='commit'){const run=await loadJSON(env,'sync.json');if(run?.runId!==runId||run.stage!=='epg')throw new Error('Discovery archive fence lost: sync run changed');}
 };
 const prevItems=previous?.items||[],prevKeys=new Set(prevItems.map(item=>item.key));
 const start=await readLedgerManifest(env,startId);
 if(startId&&!start)throw new Error('Discovery archive manifest missing');
 // Re-entry: keys of the new scan that are not in P's active ledger, read from the segments the starting manifest names.
 const latestKeys=new Set((latest||[]).map(raw=>canonicalDiscoveryCandidate(raw).key)),reentry=[],found=new Set(),wanted=new Map();
 for(const key of latestKeys)if(!prevKeys.has(key)){const segment=ledgerArchiveSegment(key,start?.segmentCount||LEDGER_ARCHIVE_SEGMENTS);if(!wanted.has(segment))wanted.set(segment,[]);wanted.get(segment).push(key);}
 if(start)for(const [segment,keys] of wanted){const items=await readLedgerSegment(env,start,segment);for(const key of keys)if(items[key]){reentry.push(items[key].payload);found.add(key);}}
 const merged=mergeDiscoveryCandidates([...prevItems,...reentry],latest,{replaceShows:true,programmeRunId:runId});
 const items=effective==='bounded'?merged.filter(item=>latestKeys.has(item.key)):merged;
 const departures=effective==='bounded'?merged.filter(item=>!latestKeys.has(item.key)):[];
 // alsoArchived: P's list is exact only for the manifest P names. Keys that writers after it archived while they were still
 // in P's active ledger (a writer that swapped the archive pointer and died before publishing) are added from the manifests'
 // upsertedKeys, walking back from the starting manifest; a long or broken chain is recounted one segment at a time.
 const also=new Set(previous?.archive?.alsoArchived||[]),named=previous?.archive?.manifestId||null;
 if(start&&startId!==named){
  let current=start,steps=0;
  while(current&&current.manifestId!==named&&steps<LEDGER_ARCHIVE_CHAIN_LIMIT){for(const key of current.upsertedKeys||[])if(prevKeys.has(key))also.add(key);current=current.parentManifestId?await readLedgerManifest(env,current.parentManifestId):null;steps++;}
  const reached=current?current.manifestId===named:named===null&&steps<=LEDGER_ARCHIVE_CHAIN_LIMIT;
  if(!reached){also.clear();for(let segment=0;segment<start.segmentCount;segment++){const segmentItems=await readLedgerSegment(env,start,segment);for(const key of Object.keys(segmentItems))if(prevKeys.has(key))also.add(key);}}
 }
 for(const key of found)also.add(key);
 const activeKeys=new Set(items.map(item=>item.key));for(const key of [...also])if(!activeKeys.has(key))also.delete(key);
 let manifestId=startId,manifest=start;
 if(departures.length){
  const writeId=crypto.randomUUID(),at=new Date().toISOString(),count=start?.segmentCount||LEDGER_ARCHIVE_SEGMENTS,bySegment=new Map();
  for(const record of departures){const segment=ledgerArchiveSegment(record.key,count);if(!bySegment.has(segment))bySegment.set(segment,[]);bySegment.get(segment).push(record);}
  const segments=Array.from({length:count},(_,segment)=>start?.segments?.[segment]||{segment,object:null,sha256:null,items:0,bytes:0});
  for(const [segment,records] of [...bySegment].sort((a,b)=>a[0]-b[0])){
   const segmentItems=await readLedgerSegment(env,start,segment);
   for(const payload of records)if(archivedPayloadNewer(payload,segmentItems[payload.key]?.payload))segmentItems[payload.key]={payload,envelope:{archivedAt:at,archivedFromProgrammeRunId:publishedRunId,archiveWriteId:writeId}};
   const object=ledgerArchiveSegmentKey(segment,writeId),written=await writeLedgerSegment(env,object,{schemaVersion:1,segment,writeId,items:segmentItems},fence);
   segments[segment]={segment,object,sha256:written.sha256,items:Object.keys(segmentItems).length,bytes:written.bytes};
  }
  manifestId=crypto.randomUUID();
  manifest={schemaVersion:1,manifestId,parentManifestId:startId,segmentCount:count,hash:'fnv1a32-utf8',segments,totals:{items:segments.reduce((n,entry)=>n+entry.items,0),bytes:segments.reduce((n,entry)=>n+entry.bytes,0)},upsertedKeys:departures.map(record=>record.key).sort(),writer:{runId,kind,basedOnProgrammeRunId:publishedRunId,basedOnPointerEtag:pointerEtag,leaseId:lease.id,writtenAt:at}};
  await writeLedgerSegment(env,ledgerArchiveManifestKey(manifestId),manifest,fence);
  // The archive's commit point: the pointer moves only while every fence still holds.
  await fence();
  const swapped=await env.BUCKET.put(LEDGER_ARCHIVE_POINTER,JSON.stringify({manifestId}),{onlyIf:archiveEtag?{etagMatches:archiveEtag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(swapped===null)throw new Error('Discovery archive fence lost: archive pointer changed');
 }
 const alsoArchived=[...also].sort(),archive=manifest?{version:'v1',manifestId,segments:manifest.segmentCount,items:manifest.totals.items,bytes:manifest.totals.bytes,alsoArchived,uniqueArchivedItems:manifest.totals.items-alsoArchived.length}:null;
 return {items,ledger:{ledgerMode:effective,archive}};
}
// `ledger` (AIR-220): `{latest, meta, mode}` lets the generation's discovery ledger be planned under this lease, fenced on the
// published pointer read here; without it `files` already carry the ledger (full mode, unchanged).
async function publishEpgGeneration(env,runId,files,ledger=null){
 const lease=await acquireDiscoveryLease(env);if(!lease)throw new Error('Resolver is writing the catalog');
 try{
  const next={...files};
  let fencedEtag;
  if(ledger){
   const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),published=pointer?await pointer.json():null;fencedEtag=pointer?.etag??null;
   const planned=await planDiscoveryLedger(env,{runId,latest:ledger.latest,mode:ledger.mode,lease,pointerEtag:fencedEtag,publishedRunId:published?.phase==='published'?published.programmeRunId||null:null});
   next['discovery-latest.json']={...ledger.meta,items:planned.items,...planned.ledger};
  }
  if(next['discovered-films.json']){const pinned=await pinEpg(env);next['discovered-films.json']=mergeCatalogIdentity(next['discovered-films.json'],await loadJSON(pinned,'epg/discovered-films.json'),runId);}
  for(const [name,value] of Object.entries(next))await saveJSON(env,epgGenerationKey(runId,name),value);
  const current=await env.BUCKET.get(EPG_GENERATION_KEY),previous=current?await current.json():null;
  if(ledger&&!(previous?.programmeRunId===runId&&previous.phase==='published')&&(current?.etag??null)!==fencedEtag)throw new Error('EPG generation changed during publish');
  if(!(previous?.programmeRunId===runId&&previous.phase==='published')){
   const saved=await env.BUCKET.put(EPG_GENERATION_KEY,JSON.stringify({programmeRunId:runId,phase:'published'}),{onlyIf:current?.etag?{etagMatches:current.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(saved===null){const winner=await env.BUCKET.get(EPG_GENERATION_KEY);const body=winner?await winner.json():null;if(body?.programmeRunId!==runId)throw new Error('EPG generation changed during publish');}
  }
  await copyEpgGeneration(env,runId);
 }finally{await releaseDiscoveryLease(env,lease);}
}
// The commit's publication with its discovery ledger. In `full` mode without an archive this is the unchanged single growing
// ledger; otherwise (AIR-220, ADR 0034) the ledger is planned under the publish lease.
async function publishGenerationWithLedger(env,runId,discovery,meta,files){
 const mode=discoveryLedgerMode(env),old=mode==='full'&&!await env.BUCKET.get(LEDGER_ARCHIVE_POINTER)?await loadJSON(env,'epg/discovery-latest.json'):null;
 if(old)return publishEpgGeneration(env,runId,{...files,'discovery-latest.json':{...meta,items:mergeDiscoveryCandidates(old.items,discovery,{replaceShows:true,programmeRunId:runId})}});
 return publishEpgGeneration(env,runId,files,{latest:discovery,meta,mode});
}
// ADR 0074: the ratings pipeline is permanently separate. It acts once ratings_storage_migrate has migrated the
// queue and the Diary cursor. The EPG commit then hands the films its watchlist diff removed to the queue as
// references to the removal event, durably and before it publishes, and does no ratings work: no Diary read, no fact
// write, no lookup. The RATINGS_PIPELINE binding is ignored. While migration is none, partial or regressed the commit
// still publishes and fails closed: it does not read Diary, look up films, enqueue or run the migration. It does record
// `removalRefs` for the removal event it writes. A later blocked commit keeps every earlier reference and appends its
// own, so watchlist advancement cannot drop them. Once migration is complete, the next step on the run and the next
// sync start flush that list before sync.json is replaced. A version 1 `removalLookups` hand-over is flushed the same way.
async function ratingsGate(env){
 if(typeof LetterboxdRatings==='undefined')return {active:false,migration:'none'};
 const state=await LetterboxdRatings.migrationState(env);
 return {active:state.migration==='complete',migration:state.migration};
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
 for(const item of items)await enqueueRemovalRefs(env,item.films,item.ref);
 delete run.removalRefs;delete run.removalLookups;return true;
}
// AIR-270: the post-commit ratings work carries a durable attempt marker in sync.json. Each phase is saved (and logged)
// before it starts, so a request killed for memory or time leaves `state: started` with the phase it died in. The next
// step on the completed run closes such an attempt as `unknown` once it is stale; it never repeats the diary read.
const RATINGS_ATTEMPT_STALE_MS=5*60000;
// AIR-263: compact phase markers for the EPG commit and its post-commit tail, so a memory-limit end of the request can be
// placed between two lines in Workers Observability. One line per edge: run id, phase, enter, exit or error, elapsed
// time, and counts or byte sizes the code already holds. Never titles, film ids, HTML or payloads.
// Best effort: a marker that cannot be logged never changes the step.
function epgPhase(runId,phase,edge,fields={}){try{console.log(JSON.stringify({event:'epg_phase',runId:runId||null,phase,edge,at:new Date().toISOString(),...fields}));}catch{}}
async function tracedPhase(runId,phase,work,summary=null){
 const started=Date.now();epgPhase(runId,phase,'enter');
 let result;try{result=await work();}catch(e){epgPhase(runId,phase,'error',{elapsedMs:Date.now()-started});throw e;}
 let fields={};try{fields=summary?summary(result)||{}:{};}catch{}
 epgPhase(runId,phase,'exit',{elapsedMs:Date.now()-started,...fields});return result;
}
async function ratingsPhase(env,run,phase,save=true){
 const at=new Date().toISOString();run.ratingAttempt={...run.ratingAttempt,phase,at};
 console.log(JSON.stringify({event:'epg_ratings_phase',runId:run.runId,attemptId:run.ratingAttempt.id,phase,at}));
 if(save)await saveJSON(env,'sync.json',run);
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
// ADR 0074: the EPG commit never reads Diary and never looks up films. Migrated storage enqueues removal references.
// Any other migration state publishes the programme, keeps the removal references on the sync run and does not enqueue.
async function completeWithRatings(env,run,report){
 const gate=await ratingsGate(env);
 if(gate.active){
  await flushRemovalHandover(env,run);delete run.ratingPending;run.ratingsPipeline='separate';
  const result=await tracedPhase(run.runId,'finish_sync',()=>finishSync(env,run,report),()=>({films:report.films?.length??0}));
  return {...result,ratingsPipeline:'separate'};
 }
 delete run.ratingPending;run.ratingsPipeline='blocked';run.ratingsMigration=gate.migration;
 const result=await tracedPhase(run.runId,'finish_sync',()=>finishSync(env,run,report),()=>({films:report.films?.length??0}));
 return {...result,ratingsPipeline:'blocked',ratingsMigration:gate.migration};
}
async function syncStatus(env){
 const run=await loadJSON(env,'sync.json');
 return run?{runId:run.runId,stage:run.stage,updatedAt:run.updatedAt,remaining:run.remaining,failures:run.failures?.length,error:run.error,ratingError:run.ratingError,ratingRepair:run.ratingRepair,ratingsPending:!!run.ratingPending?.length,...(run.ratingAttempt?{ratingAttempt:run.ratingAttempt}:{}),...(run.removalRatingLookup?{removalRatingLookup:run.removalRatingLookup}:{}),...(run.diaryHistory?{diaryHistory:run.diaryHistory}:{}),enrichmentQueueError:run.enrichmentQueueError||null,...(run.lifecycleLocalization?{lifecycleLocalization:run.lifecycleLocalization}:{})}:{stage:'not_started'};
}
// Shared by POST /api/sync/* and the MCP sync tools. One call is one existing step. `caller` names the
// boundary (http, mcp) for the AIR-151 step diagnostics; it changes nothing about the step.
async function postSync(env,execution,pathname,body,caller='http'){
 if(pathname==='/api/sync/start')return json(await beginSync(env));
 const started=Date.now(),step=continuationStep(caller,pathname,body?.runId),persisted=()=>pathname==='/api/sync/epg'||step.branch==='run_mismatch';
 await openContinuationStep(env,step,persisted());
 let response;
 try{response=await syncStep(env,pathname,body,step);}
 catch(e){await closeContinuationStep(env,step,started,null,e,persisted());throw e;}
 await closeContinuationStep(env,step,started,response,null,persisted());
 return response;
}
async function syncStep(env,pathname,body,step){
 const run=await loadJSON(env,'sync.json');step.runStage=diagnosticCode(DIAGNOSTIC_VOCABULARY.runStage,run?.stage??null);
 if(!run||body.runId!==run.runId){step.branch='run_mismatch';return json({error:'Run id mismatch'},409);}
 if(pathname==='/api/sync/metadata'){if(run.stage!=='metadata'){step.branch='stage_mismatch';return json({runId:run.runId,stage:run.stage,remaining:run.remaining});}step.branch='metadata';return json(await metadataSync(env,run));}
 if(pathname!=='/api/sync/epg'){step.branch='not_found';return json({error:'Not found'},404);}
 if(run.stage==='complete'){step.branch='continuation';if((run.removalRefs||run.removalLookups)&&(await ratingsGate(env)).active&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);if(run.ratingPending?.length)await closeInterruptedRatings(env,run);const outcome=await advanceDiscovery(env,{caller:step.caller,trace:step.diagnostic,onCheckpoint:committed=>markContinuationCheckpoint(env,step,true,committed)});step.discovery=discoverySummary(outcome.discovery);return json({runId:run.runId,stage:run.stage,ratingsPending:!!run.ratingPending?.length,discovery:outcome.discovery,diagnostic:outcome.diagnostic});}
 if(run.stage!=='epg'){step.branch='stage_mismatch';return json({error:'Metadata stage is not complete'},409);}
 step.branch='epg_commit';
 try{const result=await epgSync(env,run);if(result.stage!=='complete')return json(result);const discovery=await queueDiscovery(env,'epg_committed',run.runId);step.discovery=discoverySummary(discovery);return json({...result,discovery});}catch(e){run.error=e.message;run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}
}
async function epgSync(env,run){
 if(run.events){const committed=await loadJSON(env,'programme.json');if(committed?.runId===run.runId){await tracedPhase(run.runId,'generation_copy',()=>copyEpgGeneration(env,run.runId));await queueCommittedDiscovery(env,run);return completeWithRatings(env,run,committed);}}
 const titles=await loadJSON(env,'titles.json')||{};
 try{await localizeFilmTitles(run.watchlist,titles,'on');await saveJSON(env,'titles.json',titles);}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 const people=await loadJSON(env,'people.json')||{};
 try{await localizeByLetterboxd(run.watchlist,people);await saveJSON(env,'people.json',people);}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 applyEpgLocalization(run.watchlist,people);
 // AIR-263: the source fetch and the scan are one traced phase; an error logs `error` and rethrows unchanged.
 const sources=sourceConfig(env);
 const {now,cache,result}=await tracedPhase(run.runId,'epg_input_scan',async()=>{const now=Date.now(),r=await fetch(sources.epg,{signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error('EPG HTTP '+r.status);const cache=await loadJSON(env,'epg/discovered-films.json')||{},watchlistTmdb=new Set(run.watchlist.map(f=>String(f.tmdbId)));const result=await scanEPG(r.body,[...run.watchlist,...Object.values(cache).filter(f=>!watchlistTmdb.has(String(f.tmdbId))).map(f=>({...f,catalogOnly:true}))],now);return {now,cache,result};},value=>({films:value.result.films.length,discovery:value.result.discovery?.length??0,catalog:Object.keys(value.cache).length}));if(result.stats.epgEnd<now-72*3600000)throw new Error('EPG does not cover the current window');
 const previous=await loadJSON(env,'programme.json');assertEPGContinuity(result,previous,run.watchlist.length,now);const fresh=new Map(result.films.map(f=>[f.id,{...f,shows:dedupeShows(f.shows)}]));
 const matched=[...fresh.values()].map(f=>({...f,shows:f.shows.sort((a,b)=>a.start-b.start)}));const currentById=new Map(matched.map(f=>[String(f.id),f]));const films=run.watchlist.map(f=>withAvailability({...f,...currentById.get(String(f.id)),shows:currentById.get(String(f.id))?.shows||[]}));const countShows=matched.reduce((n,f)=>n+f.shows.length,0);
 const report={runId:run.runId,updatedAt:new Date(now).toISOString(),watchlistUpdatedAt:run.startedAt,cutoff:now,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:run.watchlist.length,watchlistPages:run.pages,films,people:peopleCatalog(run.watchlist),stats:{...result.stats,broadcasts:countShows,uniqueFilms:matched.length,metadataMissing:run.watchlist.filter(f=>!f.metadataAt).length,titleMissing:run.watchlist.filter(f=>!f.titleRu).length,titleProvisional:run.watchlist.filter(f=>f.titleStatus==='provisional').length,titleLocalizationErrors:run.titleLocalizationErrors||0,synopsisAvailable:run.watchlist.filter(f=>!!f.synopsis).length,synopsisMissing:run.watchlist.filter(f=>!f.synopsis).length,peopleMissing:run.watchlist.filter(f=>f.peopleVersion!==1).length,peopleFilms:run.watchlist.filter(f=>f.peopleVersion===1).length,channels:result.coverage.length,futureFullChannels:result.coverage.filter(c=>c.max>=now+24*3600000).length},sources:{epg:sources.epg,watchlist:sources.watchlist},archiveVerified:false};
 const nextWatchlist={updatedAt:report.updatedAt,films:run.watchlist};
 const gate=await ratingsGate(env);
 if(!run.events){const before=await loadJSON(env,'watchlist.json');run.events=[watchlistEvent(before,nextWatchlist,previous,report,run.runId+'-watchlist'),epgEvent(report,run.runId+'-epg')];const removedFilms=()=>{const removed=new Set(run.events[0].removed.map(film=>String(film.id)));return (before?.films||[]).filter(film=>removed.has(String(film.id))).map(removalLookupFilm).filter(Boolean);};const films=removedFilms(),ref=films.length?removalHandoverRef(run):null;const prior=removalRefItems(run.removalRefs).filter(item=>!ref||item.ref.eventKey!==ref.eventKey);const next=ref?[...prior,{ref,films}]:prior;if(next.length)run.removalRefs=storedRemovalRefs(next);else delete run.removalRefs;await saveJSON(env,'sync.json',run);}
 if(gate.active&&await flushRemovalHandover(env,run))await saveJSON(env,'sync.json',run);
 try{await tracedPhase(run.runId,'generation_publish',()=>publishGenerationWithLedger(env,run.runId,result.discovery,{programmeRunId:run.runId,updatedAt:report.updatedAt,rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies},{'discovered-films.json':replaceCatalogAvailability(cache,result.discovery,run.runId).catalog,'programme.json':report}));}catch(e){run.discoveryError=String(e.message).slice(0,160);throw e;}
 await queueCommittedDiscovery(env,run);
 await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:run.watchlist});await saveJSON(env,'uncertain.json',{updatedAt:report.updatedAt,items:result.uncertain});return completeWithRatings(env,run,report);
}
export default {
// AIR-275 phase 2 (ADR 0056): the cron trigger runs only the D1 enrichment projector; with D1_ENRICHMENT_WRITE off it returns at once.
async scheduled(controller,env,execution){execution.waitUntil(runD1EnrichmentProjection(env,{now:controller.scheduledTime||Date.now(),trigger:'cron'}));},
async fetch(request,env,execution){
 const url=new URL(request.url);
 try{
 if(url.pathname==='/mcp')return await mcpRoute(request,env,execution);
 if(url.pathname.startsWith('/api/')){
  if(!env.BUCKET)return json({error:'Storage unavailable'},503);
  if(url.pathname.startsWith('/api/migration-export/'))return await migrationExportRoute(request,env,url);
  if(['POST','PUT'].includes(request.method)&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
  if(url.pathname.startsWith('/api/enrichment/'))return await enrichmentRoute(request,env,url,execution);
  if(url.pathname.startsWith('/api/d1/'))return await catalogD1Route(request,env,url);
  if(url.pathname==='/api/admin/health')return await adminHealthRoute(request,env,url);
  if(url.pathname==='/api/admin/limbo')return await adminLimboRoute(request,env,url);
  if(url.pathname==='/api/admin/posters')return await adminPostersRoute(request,env,url);
  if(url.pathname==='/api/admin/prediction-recovery')return await adminPredictionRecoveryRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/letterboxd-archive/'))return await adminLetterboxdArchiveRoute(request,env,url);
  if(url.pathname==='/api/admin/discovery-recovery')return await adminDiscoveryRecoveryRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/discovery-recovery/'))return await adminDiscoveryReconsiderRoute(request,env,url);
  if(request.method==='POST'&&url.pathname.startsWith('/api/admin/films/')&&url.pathname.endsWith('/title-review'))return await filmTitleReviewRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/people/')&&url.pathname.endsWith('/name-review'))return await adminPersonNameRoute(request,env,url);
  if(url.pathname.startsWith('/api/admin/'))return await adminReadRoute(request,env,url);
  if(url.pathname.startsWith('/api/letterboxd/baseline/'))return await LetterboxdFacts.handleBaselineRequest(request,env,url.pathname);
  if(url.pathname==='/api/letterboxd/diary'&&request.method==='GET'){const filmId=url.searchParams.get('filmId');if(filmId!=null&&!/^[A-Za-z0-9_-]{1,80}$/.test(filmId))return json({error:'Invalid filmId'},400);return json(await LetterboxdDiary.readHistory(env,{filmId}));}
  if(url.pathname==='/api/letterboxd/ratings/status'&&request.method==='GET')return json(await LetterboxdRatings.status(env));
  if(['/api/letterboxd/ratings/start','/api/letterboxd/ratings/step','/api/letterboxd/ratings/migrate'].includes(url.pathname)&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}const reply=await LetterboxdRatings.handle(env,url.pathname.slice('/api/letterboxd/ratings/'.length),body);return json(reply.body,reply.status);}
  if(url.pathname==='/api/events'&&request.method==='GET'){await recoverStopEvents(env);const cursor=url.searchParams.get('cursor');if(cursor&&cursor.length>4000)return json({error:'Invalid cursor'},400);return json(await eventPage(env,cursor));}
  if(url.pathname==='/api/events/bootstrap'&&request.method==='POST'){await bootstrapEvents(env);return json({ok:true});}
  if(url.pathname==='/api/started'&&request.method==='GET')return json({ids:await startedFilms(env)});
  if(url.pathname==='/api/started'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!body||typeof body!=='object')return json({error:'Invalid request'},400);return await setStarted(env,body);}
  if(url.pathname==='/api/programme'&&request.method==='GET'){const data=await loadJSON(env,'programme.json');if(!data)return json({error:'Первое обновление ещё выполняется'},503);const watchlist=await loadJSON(env,'watchlist.json');const titles=await loadJSON(env,'titles.json')||{};const reviews=await loadJSON(env,'admin/owner-reviews.json');return json(presentLocalized(programmeWithWatchlist(data,watchlist),titles,reviews));}
  if(url.pathname==='/api/watchlist'&&request.method==='GET'){let data=await loadJSON(env,'watchlist.json');const report=await loadJSON(env,'programme.json');if(report?.films?.length===report.watchlistCount&&data?.updatedAt!==report.updatedAt)data={updatedAt:report.updatedAt,films:report.films};if(!data)return json({films:[]});const titles=await loadJSON(env,'titles.json')||{};const reviews=await loadJSON(env,'admin/owner-reviews.json');return json(presentLocalized(data,titles,reviews));}
  if(url.pathname==='/api/catalog/available'&&request.method==='GET')return await catalogAvailableRoute(env);
  if(url.pathname==='/api/catalog/watched')return await catalogWatchedRoute(request,env,url);
  if(url.pathname==='/api/status'&&request.method==='GET')return json(await syncStatus(env));
  if(url.pathname==='/api/integrations/tmdb/status'&&request.method==='GET'){
   if(!env.TMDB_API_READ_ACCESS_TOKEN)return json({connected:false,stage:'missing_secret'},503);
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
 const page=url.pathname==='/events'?'/':/^\/film\/[A-Za-z0-9_-]{1,80}$/.test(url.pathname)?'/':url.pathname,asset=ASSETS[page];if(asset&&request.method==='GET')return new Response(asset.body,{headers:{'Content-Type':asset.type+'; charset=utf-8','Cache-Control':'no-cache'}});
 return json({error:'Not found'},404);
 }catch(e){return json({error:e.message},502);}
}};
