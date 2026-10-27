const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function addGroup(left,right,displayed){const group={compared:(left?.compared||0)+(right?.compared||0),mismatched:(left?.mismatched||0)+(right?.mismatched||0)};if(displayed)group.displayed=(left?.displayed||0)+(right?.displayed||0);return group;}
function recordLifecycle(run,path,mode,count){if(!run||(mode!=='on'&&mode!=='shadow')||!count?.films)return;const prior=run.lifecycleLocalization?.[path];run.lifecycleLocalization={...(run.lifecycleLocalization||{}),[path]:{mode,films:addGroup(prior?.films,count.films,true),people:addGroup(prior?.people,count.people,true),cache:addGroup(prior?.cache,count.cache,false)}};}
function localizationResponse(data,mode,count,path){if(mode!=='on'&&mode!=='shadow')return json(data);const films=count.films||{compared:0,mismatched:0,displayed:0},people=count.people||{compared:0,mismatched:0,displayed:0},cache=count.cache||{compared:0,mismatched:0};const header=path+';'+mode+';films='+films.compared+'/'+films.mismatched+'/'+films.displayed+';people='+people.compared+'/'+people.mismatched+'/'+people.displayed+';cache='+cache.compared+'/'+cache.mismatched;return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Lifecycle-Localization':header}});}
const loadJSON=async(env,key)=>{
 const staged=key==='programme.json'?'programme.json':key==='epg/discovery-latest.json'?'discovery-latest.json':key==='epg/discovered-films.json'?'discovered-films.json':null;
 if(staged){
  const pinned=env.epgPin?.programmeRunId;
  if(pinned){const object=await env.BUCKET.get(epgGenerationKey(pinned,staged));if(object)return object.json();}
  else{const pointer=await env.BUCKET.get(EPG_GENERATION_KEY);if(pointer){const generation=await pointer.json();if(generation?.phase==='published'&&generation.programmeRunId){const object=await env.BUCKET.get(epgGenerationKey(generation.programmeRunId,staged));if(object)return object.json();}}}
 }
 const o=await env.BUCKET.get(key);return o?o.json():null;
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
// export names and years, only while FINDS_TITLE_EXCLUSION is exactly `on`, and removes a catalog film from this response only:
// it writes nothing and is never identity, a fact or a rating. A missing, oversized or invalid list hides nothing, and the
// response says only `state` and a count, never a title, an id or a hash of the list.
const FINDS_TITLE_EXCLUSION_KEY='letterboxd/display-exclusion.json',FINDS_TITLE_EXCLUSION_MAX_BYTES=2*1024*1024,FINDS_TITLE_EXCLUSION_MAX_ENTRIES=20000;
const findsTitleExclusionEnabled=env=>env?.FINDS_TITLE_EXCLUSION==='on';
// normTitle_v1: must stay identical to normTitle in src/letterboxd-match.js, which the offline builder uses; a test compares them.
const findsTitleKey=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const FINDS_HEX64=/^[0-9a-f]{64}$/,FINDS_ISO=/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z)?$/;
const findsPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const findsExactKeys=(value,keys)=>findsPlain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const findsTime=value=>typeof value==='string'&&FINDS_ISO.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
// The matching keys of a valid list, or null. Entries are canonical (already normalized, strictly ascending by title then year,
// so a duplicate is invalid) and their JSON must hash to contentSha256.
async function findsTitleExclusionKeys(list,now){
 if(!findsExactKeys(list,['schemaVersion','kind','rule','normalization','source','builtAt','counts','entries','contentSha256']))return null;
 if(list.schemaVersion!==1||list.kind!=='letterboxd_display_exclusion'||list.rule!=='strict_original_exact_year'||list.normalization!=='normTitle_v1')return null;
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
 return keys;
}
// With the switch off the object is not read. The size check uses the R2 object size before the body is read or parsed.
async function loadFindsTitleExclusion(env,now){
 if(!findsTitleExclusionEnabled(env))return {state:'off',keys:null};
 const unavailable={state:'unavailable',keys:null};
 try{
  const object=await env.BUCKET.get(FINDS_TITLE_EXCLUSION_KEY);
  if(!object)return unavailable;
  if(!Number.isInteger(object.size)||object.size>FINDS_TITLE_EXCLUSION_MAX_BYTES){await object.body?.cancel?.();return unavailable;}
  const text=await object.text();
  if(new TextEncoder().encode(text).length>FINDS_TITLE_EXCLUSION_MAX_BYTES)return unavailable;
  const keys=await findsTitleExclusionKeys(JSON.parse(text),now);
  return keys?{state:'applied',keys}:unavailable;
 }catch{return unavailable;}
}
// Whether a verified catalog record is hidden. Original title only, exact year; no other verified TMDB film of this catalog
// carries the key as its original title, localized title or alias in any year; and a TMDB film with a stored Letterboxd id is
// left to identity (metadata cache, watchlist, programme, a verified catalog record keyed by a Letterboxd id).
function findsTitleSuppressor({keys,catalog,metadata,watchlist,programme}){
 const verified=Object.values(catalog||{}).filter(film=>film&&film.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId));
 const namesakes=new Map(),linked=new Set();
 for(const film of verified)for(const title of [film.original,film.title,...(Array.isArray(film.aliases)?film.aliases:[])]){const key=findsTitleKey(title);if(!key)continue;if(!namesakes.has(key))namesakes.set(key,new Set());namesakes.get(key).add(String(film.tmdbId));}
 const link=(id,tmdbId)=>{if(id==null||tmdbId==null||tmdbId==='')return;if(!CATALOG_TMDB_ID.test(String(id)))linked.add(String(tmdbId));};
 for(const [id,record] of Object.entries(metadata||{}))link(record?.id??id,record?.tmdbId);
 for(const film of [...(watchlist?.films||[]),...(programme?.films||[]),...verified])link(film?.id,film?.tmdbId);
 return film=>{
  if(!Number.isInteger(film.year))return false;
  const key=findsTitleKey(film.original),tmdbId=String(film.tmdbId);
  if(!key||!keys.has(key+'\u0000'+film.year))return false;
  const owners=namesakes.get(key);
  return owners?.size===1&&owners.has(tmdbId)&&!linked.has(tmdbId);
 };
}
function catalogAvailable({catalog,programme,watchlist,index,profile,metadata,programmeRunId,pinned,now,titleExclusion={state:'off',keys:null}}){
 const from=now-CATALOG_ARCHIVE_MS,to=now+CATALOG_FUTURE_MS,excluded=new Set(),posterFor=catalogPosters(metadata),posterSource=new Map();
 for(const film of [...(programme?.films||[]),...(watchlist?.films||[])]){if(film?.id!=null)excluded.add(String(film.id));if(film?.tmdbId)excluded.add('tmdb:'+String(film.tmdbId));}
 const consumedTmdb=catalogConsumedTmdb({index,metadata,watchlist,programme,catalog});
 const hidden=titleExclusion.state==='applied'?findsTitleSuppressor({keys:titleExclusion.keys,catalog,metadata,watchlist,programme}):null,hiddenIdentities=new Set();
 const byIdentity=new Map();
 for(const film of Object.values(catalog||{})){
  if(!film||!film.tmdbId||film.canonicalIdentity!=='tmdb:'+String(film.tmdbId))continue;
  const id=String(film.id),identity=film.canonicalIdentity;
  if(excluded.has(id)||excluded.has(identity))continue;
  const item=index?.[id];
  // Watched or rated, under this id or any id of the same TMDB film: never offered, so a prediction never stands in for a rating.
  if(catalogConsumed(item)||consumedTmdb.has(String(film.tmdbId)))continue;
  if(!profile||!indexedPredictionCurrent(item,profile))continue;
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
 return {programmeRunId,pinned,generatedAt:new Date(now).toISOString(),window:{from:new Date(from).toISOString(),to:new Date(to).toISOString()},profile:profile?{version:profile.version}:null,total:films.length,posterCoverage,displayExclusion,films,channels:[...channels.values()].sort((a,b)=>String(a.channelId).localeCompare(String(b.channelId),'en'))};
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
 return json(catalogAvailable({catalog,programme,watchlist,index:seeded,profile,metadata,programmeRunId:pinnedRunId||programme.runId,pinned:!!pinnedRunId,now,titleExclusion}));
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
const saveJSON=(env,key,value)=>env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
function confirmedHalfStar(value){const rating=Number(value);return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0?rating:null;}
function removalRating(film){const rating=confirmedHalfStar(film?.rating);if(rating==null)return null;const observed=typeof film.ratingObservedAt==='string'&&Number.isFinite(Date.parse(film.ratingObservedAt))?film.ratingObservedAt:null;return observed?{rating,ratingObservedAt:observed}:{rating};}
const eventFilm=(film,titles=new Map())=>({id:String(film.id),title:reviewedTitle(film)?.title||titles.get(String(film.id))||film.title||film.original,year:film.year});
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
function removalFilmIds(run){const event=(run?.events||[]).find(item=>item?.type==='watchlist');return [...new Set((event?.removed||[]).map(film=>String(film.id)).filter(id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id)))];}
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
  if(saved!==null)return;
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
 const cache=await loadJSON(env,'metadata.json')||{};const all=[...films.values()].map(f=>cache[f.id]?{...cache[f.id],...f,aliases:cache[f.id].aliases}:f);const pending=all.filter(f=>!f.metadataAt||f.peopleVersion!==1||f.peopleNamesVersion!==2||!f.synopsisFetchedAt||Date.now()-Date.parse(f.metadataAt)>30*86400000).map(f=>f.id);
 const ratingPending=['public-films-list'];
 const run={runId:crypto.randomUUID(),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),stage:pending.length?'metadata':'epg',watchlist:all,pending,ratingPending,cursor:0,remaining:pending.length,pages,watchlistObservedAt,failures:[],...(current?.ratingObservedAt?{ratingObservedAt:current.ratingObservedAt}:{})};await saveJSON(env,'sync.json',run);await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,failedAt:null,lastSuccessAt:run.startedAt});return {runId:run.runId,stage:run.stage,watchlistCount:total,pages,remaining:run.remaining};
 }catch(e){const previous=await loadJSON(env,'sync.json'),ingest=await loadJSON(env,'watchlist-ingest.json'),lastSuccessAt=previous?.stage==='complete'&&!previous.error?previous.updatedAt:ingest?.lastSuccessAt||null;await saveJSON(env,'watchlist-ingest.json',{schemaVersion:1,code:'watchlist_failed',failedAt:new Date().toISOString(),lastSuccessAt});throw e;}
}
async function metadataSync(env,run){
 const cache=await loadJSON(env,'metadata.json')||{};const creditsChanged=new Set();const next=run.pending.slice(run.cursor,run.cursor+24);const onlyNames=next.every(id=>cache[id]?.peopleVersion===1&&Date.now()-Date.parse(cache[id].metadataAt)<30*86400000);const ids=next.slice(0,onlyNames?24:12);
 for(let i=0;i<ids.length;i+=3)await Promise.all(ids.slice(i,i+3).map(async id=>{const idx=run.watchlist.findIndex(f=>f.id===id);try{const film=run.watchlist[idx],fresh=film.peopleVersion===1&&film.metadataAt&&Date.now()-Date.parse(film.metadataAt)<30*86400000;if(fresh&&film.synopsisFetchedAt){if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const html=await getHTML(film.url);if(fresh){film.synopsis=parseSynopsis(html);film.synopsisFetchedAt=new Date().toISOString();cache[id]={...cache[id],synopsis:film.synopsis,synopsisFetchedAt:film.synopsisFetchedAt};if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const result=parseFilm(html,film);cache[id]=result;run.watchlist[idx]=result;creditsChanged.add(id);}catch(e){run.failures.push({id,error:e.message});}}));
 const titles=await loadJSON(env,'titles.json')||{};const titleBatch=run.watchlist.filter(f=>ids.includes(f.id));const localizationMode=lifecycleMode(env,'metadata');
 try{recordLifecycle(run,'metadata',localizationMode,await localizeFilmTitles(titleBatch,titles,localizationMode));}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 await saveJSON(env,'titles.json',titles);
 const people=await loadJSON(env,'people.json')||{};const batch=run.watchlist.filter(f=>creditsChanged.has(f.id)&&f.peopleVersion===1);
 try{if(batch.length)recordLifecycle(run,'metadata',localizationMode,await localizePeople(batch,people,localizationMode));for(const f of batch){f.peopleLocalizedAt=new Date().toISOString();f.peopleNamesVersion=2;}}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of batch)cache[f.id]=f;
 await saveJSON(env,'people.json',people);
 run.cursor+=ids.length;run.remaining=run.pending.length-run.cursor;run.stage=run.remaining?'metadata':'epg';run.updatedAt=new Date().toISOString();await saveJSON(env,'metadata.json',cache);await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,remaining:run.remaining,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length};
}
async function finishSync(env,run,report){const list=await loadJSON(env,'watchlist.json');if(report.films?.length===report.watchlistCount&&list?.updatedAt!==report.updatedAt)await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:report.films.map(({shows,...f})=>f)});
 // A complete watchlist is one observation of every listed film (ADR-0024); gated by LETTERBOXD_FACTS.
 if(env.LETTERBOXD_FACTS==='on'&&report.films?.length===report.watchlistCount&&run.watchlistObservedAt)await LetterboxdFacts.applyWatchlistScan(env,{scanId:run.runId,observedAt:run.watchlistObservedAt,films:report.films.map(f=>({id:f.id,tmdbId:f.tmdbId}))});for(const event of run.events)await writeEvent(env,event);run.stage='complete';run.updatedAt=new Date().toISOString();delete run.watchlist;delete run.pending;await saveJSON(env,'sync.json',run);try{await refreshPredictionQueue(env,report,'programme_updated');}catch(e){run.enrichmentQueueError=String(e.message).slice(0,160);await saveJSON(env,'sync.json',run);}return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats};}
async function copyEpgGeneration(env,runId){
 for(const name of ['discovery-latest.json','discovered-films.json','programme.json']){const staged=await env.BUCKET.get(epgGenerationKey(runId,name));if(staged)await saveJSON(env,name==='programme.json'?name:'epg/'+name,await staged.json());}
}
async function publishEpgGeneration(env,runId,files){
 const lease=await acquireDiscoveryLease(env);if(!lease)throw new Error('Resolver is writing the catalog');
 try{
  const next={...files};
  if(next['discovered-films.json']){const pinned=await pinEpg(env);next['discovered-films.json']=mergeCatalogIdentity(next['discovered-films.json'],await loadJSON(pinned,'epg/discovered-films.json'),runId);}
  for(const [name,value] of Object.entries(next))await saveJSON(env,epgGenerationKey(runId,name),value);
  const current=await env.BUCKET.get(EPG_GENERATION_KEY),previous=current?await current.json():null;
  if(!(previous?.programmeRunId===runId&&previous.phase==='published')){
   const saved=await env.BUCKET.put(EPG_GENERATION_KEY,JSON.stringify({programmeRunId:runId,phase:'published'}),{onlyIf:current?.etag?{etagMatches:current.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(saved===null){const winner=await env.BUCKET.get(EPG_GENERATION_KEY);const body=winner?await winner.json():null;if(body?.programmeRunId!==runId)throw new Error('EPG generation changed during publish');}
  }
  await copyEpgGeneration(env,runId);
 }finally{await releaseDiscoveryLease(env,lease);}
}
async function completeWithRatings(env,run,report){
 const result=await finishSync(env,run,report);if(!run.ratingPending?.length)return result;
 try{const ratings=await refreshRatingsFromFilms(env,report,removalFilmIds(run));await enrichKnownRemovalEvent(env,run,ratings.removedRatings,ratings.observedAt);delete run.ratingPending;delete run.ratingError;run.ratingObservedAt=ratings.observedAt||new Date().toISOString();await saveJSON(env,'sync.json',run);return {...result,personalRatings:ratings};}
 catch(e){let removed,diary;try{removed=await repairRemovedBaselineRatings(env,report);}catch(repairError){removed={attempted:0,saved:0,errors:[{error:String(repairError.message).slice(0,160)}]};}
  try{diary=await repairRecentDiaryRatings(env,report);}catch(repairError){diary={attempted:0,saved:0,errors:[{error:String(repairError.message).slice(0,160)}]};}
  const repair={removed,diary};run.ratingError=String(e.message).slice(0,200);run.ratingRepair=repair;await saveJSON(env,'sync.json',run);return {...result,personalRatingError:run.ratingError,personalRatingRepair:repair};}
}
async function syncStatus(env){
 const run=await loadJSON(env,'sync.json');
 return run?{runId:run.runId,stage:run.stage,updatedAt:run.updatedAt,remaining:run.remaining,failures:run.failures?.length,error:run.error,ratingError:run.ratingError,ratingRepair:run.ratingRepair,ratingsPending:!!run.ratingPending?.length,enrichmentQueueError:run.enrichmentQueueError||null,...(run.lifecycleLocalization?{lifecycleLocalization:run.lifecycleLocalization}:{})}:{stage:'not_started'};
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
 if(run.stage==='complete'){step.branch='continuation';const outcome=await advanceDiscovery(env,{caller:step.caller,trace:step.diagnostic});step.discovery=discoverySummary(outcome.discovery);return json({runId:run.runId,stage:run.stage,ratingsPending:!!run.ratingPending?.length,discovery:outcome.discovery,diagnostic:outcome.diagnostic});}
 if(run.stage!=='epg'){step.branch='stage_mismatch';return json({error:'Metadata stage is not complete'},409);}
 step.branch='epg_commit';
 try{const result=await epgSync(env,run);if(result.stage!=='complete')return json(result);const discovery=await queueDiscovery(env,'epg_committed',run.runId);step.discovery=discoverySummary(discovery);return json({...result,discovery});}catch(e){run.error=e.message;run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}
}
async function epgSync(env,run){
 if(run.events){const committed=await loadJSON(env,'programme.json');if(committed?.runId===run.runId){await copyEpgGeneration(env,run.runId);return completeWithRatings(env,run,committed);}}
 const titles=await loadJSON(env,'titles.json')||{};const localizationMode=lifecycleMode(env,'epg');
 try{recordLifecycle(run,'epg',localizationMode,await localizeFilmTitles(run.watchlist,titles,localizationMode));await saveJSON(env,'titles.json',titles);}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 const people=await loadJSON(env,'people.json')||{};
 try{await localizeByLetterboxd(run.watchlist,people);await saveJSON(env,'people.json',people);}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 recordLifecycle(run,'epg',localizationMode,applyEpgLocalization(run.watchlist,people,localizationMode));
 const sources=sourceConfig(env),now=Date.now(),r=await fetch(sources.epg,{signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error('EPG HTTP '+r.status);const cache=await loadJSON(env,'epg/discovered-films.json')||{},watchlistTmdb=new Set(run.watchlist.map(f=>String(f.tmdbId)));const result=await scanEPG(r.body,[...run.watchlist,...Object.values(cache).filter(f=>!watchlistTmdb.has(String(f.tmdbId))).map(f=>({...f,catalogOnly:true}))],now);if(result.stats.epgEnd<now-72*3600000)throw new Error('EPG does not cover the current window');
 const previous=await loadJSON(env,'programme.json');assertEPGContinuity(result,previous,run.watchlist.length,now);const fresh=new Map(result.films.map(f=>[f.id,{...f,shows:dedupeShows(f.shows)}]));
 const matched=[...fresh.values()].map(f=>({...f,shows:f.shows.sort((a,b)=>a.start-b.start)}));const currentById=new Map(matched.map(f=>[String(f.id),f]));const films=run.watchlist.map(f=>withAvailability({...f,...currentById.get(String(f.id)),shows:currentById.get(String(f.id))?.shows||[]}));const countShows=matched.reduce((n,f)=>n+f.shows.length,0);
 const report={runId:run.runId,updatedAt:new Date(now).toISOString(),watchlistUpdatedAt:run.startedAt,cutoff:now,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:run.watchlist.length,watchlistPages:run.pages,films,people:peopleCatalog(run.watchlist),stats:{...result.stats,broadcasts:countShows,uniqueFilms:matched.length,metadataMissing:run.watchlist.filter(f=>!f.metadataAt).length,titleMissing:run.watchlist.filter(f=>!f.titleRu).length,titleProvisional:run.watchlist.filter(f=>f.titleStatus==='provisional').length,titleLocalizationErrors:run.titleLocalizationErrors||0,synopsisAvailable:run.watchlist.filter(f=>!!f.synopsis).length,synopsisMissing:run.watchlist.filter(f=>!f.synopsis).length,peopleMissing:run.watchlist.filter(f=>f.peopleVersion!==1).length,peopleFilms:run.watchlist.filter(f=>f.peopleVersion===1).length,channels:result.coverage.length,futureFullChannels:result.coverage.filter(c=>c.max>=now+24*3600000).length},sources:{epg:sources.epg,watchlist:sources.watchlist},archiveVerified:false};
 const nextWatchlist={updatedAt:report.updatedAt,films:run.watchlist};
 if(!run.events){const before=await loadJSON(env,'watchlist.json');run.events=[watchlistEvent(before,nextWatchlist,previous,report,run.runId+'-watchlist'),epgEvent(report,run.runId+'-epg')];await saveJSON(env,'sync.json',run);}
 try{const old=await loadJSON(env,'epg/discovery-latest.json');const replaced=replaceCatalogAvailability(cache,result.discovery,run.runId);await publishEpgGeneration(env,run.runId,{'discovery-latest.json':{programmeRunId:run.runId,updatedAt:report.updatedAt,rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies,items:mergeDiscoveryCandidates(old?.items,result.discovery,{replaceShows:true,programmeRunId:run.runId})},'discovered-films.json':replaced.catalog,'programme.json':report});}catch(e){run.discoveryError=String(e.message).slice(0,160);throw e;}
 await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:run.watchlist});await saveJSON(env,'uncertain.json',{updatedAt:report.updatedAt,items:result.uncertain});return completeWithRatings(env,run,report);
}
export default {async fetch(request,env,execution){
 const url=new URL(request.url);
 try{
 if(url.pathname==='/mcp')return await mcpRoute(request,env,execution);
 if(url.pathname.startsWith('/api/')){
  if(!env.BUCKET)return json({error:'Storage unavailable'},503);
  if(url.pathname.startsWith('/api/migration-export/'))return await migrationExportRoute(request,env,url);
  if(['POST','PUT'].includes(request.method)&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
  if(url.pathname.startsWith('/api/enrichment/'))return await enrichmentRoute(request,env,url,execution);
  if(url.pathname.startsWith('/api/letterboxd/baseline/'))return await LetterboxdFacts.handleBaselineRequest(request,env,url.pathname);
  if(url.pathname==='/api/events'&&request.method==='GET'){await recoverStopEvents(env);const cursor=url.searchParams.get('cursor');if(cursor&&cursor.length>4000)return json({error:'Invalid cursor'},400);return json(await eventPage(env,cursor));}
  if(url.pathname==='/api/events/bootstrap'&&request.method==='POST'){await bootstrapEvents(env);return json({ok:true});}
  if(url.pathname==='/api/started'&&request.method==='GET')return json({ids:await startedFilms(env)});
  if(url.pathname==='/api/started'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!body||typeof body!=='object')return json({error:'Invalid request'},400);return await setStarted(env,body);}
  if(url.pathname==='/api/programme'&&request.method==='GET'){const data=await loadJSON(env,'programme.json');if(!data)return json({error:'Первое обновление ещё выполняется'},503);const watchlist=await loadJSON(env,'watchlist.json');const titles=await loadJSON(env,'titles.json')||{};const mode=lifecycleMode(env,'programme');const presented=presentLocalized(programmeWithWatchlist(data,watchlist),titles,mode);return localizationResponse(presented.data,mode,presented,'programme');}
  if(url.pathname==='/api/watchlist'&&request.method==='GET'){let data=await loadJSON(env,'watchlist.json');const report=await loadJSON(env,'programme.json');if(report?.films?.length===report.watchlistCount&&data?.updatedAt!==report.updatedAt)data={updatedAt:report.updatedAt,films:report.films};if(!data)return json({films:[]});const titles=await loadJSON(env,'titles.json')||{};const mode=lifecycleMode(env,'watchlist');const presented=presentLocalized(data,titles,mode);return localizationResponse(presented.data,mode,presented,'watchlist');}
  if(url.pathname==='/api/catalog/available'&&request.method==='GET')return await catalogAvailableRoute(env);
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
