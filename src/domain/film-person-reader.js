// Storage-neutral Film and Person reader, phase 2 of AIR-42.
// Builds lifecycle views from records the caller already loaded. It does not read or write storage.
const LIFECYCLE_SIDECAR='.lifecycle.json';
const FORBIDDEN_LIFECYCLE_KEYS=Object.freeze(['epg/discovery-latest.json','programme.json','enrichment/prediction-queue.json']);

function indexRecords(records,key){const out={};for(const record of records||[])if(record&&record[key]!=null)out[String(record[key])]=record;return out;}
function listOf(value){return Array.isArray(value)?value:value&&typeof value==='object'?Object.values(value):[];}
function storedFilmId(film){
 const letterboxd=(film?.externalIds||[]).find(item=>item.scheme==='letterboxd'&&item.value);
 if(letterboxd)return String(letterboxd.value);
 const tmdb=(film?.externalIds||[]).find(item=>item.scheme==='tmdb'&&!item.conflicting);
 return tmdb?'tmdb_'+tmdb.value:film?.id||null;
}
// A Letterboxd lid. A tmdb_<n> key is the same fact's alias and does not mint a second Film. A title, year, slug or diary title is not an id.
const RETENTION_LID=/^[A-Za-z0-9_-]{1,80}$/;
function retentionLid(id){const value=String(id||'');return RETENTION_LID.test(value)&&!value.startsWith('tmdb_');}
// A cache row stored under this lid whose own id names a different film is not this film's body. The lid still stands.
function cacheFor(store,id){
 const metadata=store.metadata?.[id];
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return null;
 if(metadata.id!=null&&String(metadata.id)!==String(id))return null;
 return metadata;
}
// Films whose view-index entry carries a watchlist boolean stay in the catalog after they leave the current lists.
// The boolean is membership history. It is not a watched mark and it does not put the film back on the watchlist.
function retainedWatchlistRecords(store,seen){
 const admissions=store?.watchlistAdmissions;
 if(!admissions||typeof admissions!=='object'||Array.isArray(admissions))return [];
 const records=[];
 for(const id of Object.keys(admissions).sort()){
  if(typeof admissions[id]!=='boolean'||!retentionLid(id)||seen.has(id))continue;
  const metadata=cacheFor(store,id);
  records.push(metadata?{...metadata,id}:{id});seen.add(id);
 }
 return records;
}
// A verified TMDB movie from a confirmed rated archive. The key is tmdb_<n>. There is no watchlist boolean and the short code is not the id.
function retainedArchiveRecords(store,seen,tmdbSeen){
 const admissions=store?.archiveAdmissions;
 if(!admissions||typeof admissions!=='object'||Array.isArray(admissions))return [];
 const records=[];
 for(const id of Object.keys(admissions).sort()){
  const item=admissions[id];
  if(!item||typeof item.tmdb!=='string'||seen.has(id)||tmdbSeen.has(item.tmdb))continue;
  if(Object.prototype.hasOwnProperty.call(item,'watchlist'))continue;
  const record={id,tmdbId:item.tmdb,canonicalIdentity:'tmdb:'+item.tmdb,original:item.title||id,title:item.title||id,year:item.year??null,externalIds:[{scheme:'tmdb',value:item.tmdb,trusted:true,conflicting:false}]};
  if(item.synopsis)record.synopsis=item.synopsis;
  if(item.synopsisFetchedAt)record.synopsisFetchedAt=item.synopsisFetchedAt;
  if(item.metadataAt)record.metadataAt=item.metadataAt;
  if(item.url)record.url=item.url;
  if(Number.isInteger(item.runtime))record.runtime=item.runtime;
  if(Array.isArray(item.genres))record.genres=item.genres;
  if(Array.isArray(item.directors))record.directors=item.directors;
  if(Array.isArray(item.actors))record.actors=item.actors;
  if(item.peopleVersion)record.peopleVersion=item.peopleVersion;
  if(item.peopleNamesVersion)record.peopleNamesVersion=item.peopleNamesVersion;
  if(item.peopleLocalizedAt)record.peopleLocalizedAt=item.peopleLocalizedAt;
  if(item.titleRu){record.titleRu=item.titleRu;record.titleStatus=item.titleStatus||'provisional';}
  records.push(record);
  seen.add(id);tmdbSeen.add(item.tmdb);
 }
 return records;
}
function sourceRichness(record){
 if(!record||typeof record!=='object')return 0;
 let score=0;
 if(record.synopsis||record.synopsisFetchedAt)score+=2;
 if((record.directors&&record.directors.length)||(record.actors&&record.actors.length)||record.peopleVersion===1)score+=2;
 if(record.metadataAt||record.discoveredAt)score+=1;
 return score;
}
function archiveItemFor(store,id,tmdb){
 const admissions=store?.archiveAdmissions;
 if(!admissions||typeof admissions!=='object')return null;
 if(id&&admissions[id]&&!Object.prototype.hasOwnProperty.call(admissions[id],'watchlist'))return admissions[id];
 const key=tmdb?'tmdb_'+tmdb:null;
 return key&&admissions[key]&&!Object.prototype.hasOwnProperty.call(admissions[key],'watchlist')?admissions[key]:null;
}
// The map entry came from the rated-archive stub, not from a programme or watchlist row.
function occupantIsArchiveStub(store,prior,archive){
 if(!prior||!archive)return false;
 if(storedFilmId(prior)!=='tmdb_'+archive.tmdb)return false;
 const onList=[...(store.programme?.films||[]),...(store.watchlist?.films||[])].some(film=>film&&(String(film.id)===storedFilmId(prior)||String(film.tmdbId)===String(archive.tmdb)));
 return !onList;
}
function trustedTmdbIds(films){
 const ids=new Set();
 for(const film of films||[])if(film?.tmdbId)ids.add(String(film.tmdbId));
 return ids;
}
function primaryFilmIds(store){return new Set((store.programme?.films||store.watchlist?.films||[]).map(film=>film?.id==null?'':String(film.id)).filter(Boolean));}
function sidecarKey(key){return key.endsWith('.json')?key.slice(0,-5)+LIFECYCLE_SIDECAR:key+LIFECYCLE_SIDECAR;}
// `compatible` is the fingerprint transition verdict (ADR-0035) when the store supplies one; without it the strict rule applies.
function fingerprintFacts(file,compatible){if(!file)return {present:false};return {present:true,schemaVersion:file.fingerprintSchemaVersion,promptVersion:file.fingerprintPromptVersion??1,invalidatedAt:file.invalidatedAt||null,generatedAt:file.generatedAt||null,...(typeof compatible==='boolean'?{compatible}:{})};}
// `compatible` is the shared evaluator's verdict (ADR-0031) when the store supplies one; without it the strict rule applies.
function predictionFacts(file,failure,compatible){
 const current=file?.current;
 if(!current)return {present:false,failure};
 return {present:true,tasteProfileVersion:current.tasteProfileVersion,tasteProfileHash:current.tasteProfileHash,fingerprintHash:current.fingerprintHash,fingerprintSchemaVersion:current.fingerprintSchemaVersion,predictionPromptVersion:current.predictionPromptVersion,failure,...(typeof compatible==='boolean'?{compatible}:{})};
}
function resolutionEntries(resolution){return Object.entries(resolution||{}).filter(([key,value])=>key!=='__canonicalizedAt'&&value&&typeof value==='object');}
// Per-object indexes for the lookups the reader repeats once per Film. Each keeps the first match and the original order, so a
// lookup returns what the linear scan returned; without them one full view costs tens of seconds of CPU (AIR-275 phase 2).
const READER_INDEXES=new WeakMap();
function readerIndex(source,build){if(!source||typeof source!=='object')return build(source);let cached=READER_INDEXES.get(source);if(!cached){cached=build(source);READER_INDEXES.set(source,cached);}return cached;}
function decisionsByTmdb(resolution){return readerIndex(resolution,value=>{const index=new Map();for(const [,decision] of resolutionEntries(value)){if(decision.tmdbId==null)continue;const key=String(decision.tmdbId);if(!index.has(key))index.set(key,[]);index.get(key).push(decision);}return index;});}
function recordsById(records){return readerIndex(records,value=>{const index=new Map();for(const record of listOf(value))if(record){const key=String(record.id);if(!index.has(key))index.set(key,record);}return index;});}
function decisionForFilm(film,resolution){
 if(!String(film?.id||'').startsWith('tmdb_'))return null;
 const matches=(decisionsByTmdb(resolution).get(String(film.tmdbId))||[]).filter(decision=>!decision.filmId||decision.filmId===film.id);
 const verified=matches.find(decision=>decision.status==='verified');
 if(verified)return verified;
 const specific=matches.find(decision=>decision.filmId===film.id&&['ambiguous','no_confident_match','duration_mismatch'].includes(decision.status));
 return specific||(film.tmdbId?{status:'verified'}:null);
}
function syncFailure(sync,id){return (sync?.failures||[]).find(failure=>failure&&failure.id===id)||null;}
function predictionFailure(store,id){return store.predictionRun?.failures?.[id]||store.predictionQueue?.retries?.[id]||null;}
function peopleOn(record){return [...(record?.directors||[]),...(record?.actors||[]),...(record?.people?.directors||[]),...(record?.people?.actors||[])];}
function recordById(records,id){return records?recordsById(records).get(id)||null:null;}
function catalogRecord(store,id){return recordsById(store.discoveredFilms).get(id)||null;}
// The title the lifecycle view already took from a verified rated-archive Film. It does not admit the Film.
function archiveRecord(store,id){
 const item=store?.archiveAdmissions?.[id];
 if(!item||typeof item.tmdb!=='string'||Object.prototype.hasOwnProperty.call(item,'watchlist'))return null;
 if(String(id)!=='tmdb_'+item.tmdb)return null;
 const record={id,tmdbId:item.tmdb,original:item.title||id,title:item.title||id,year:item.year??null};
 if(item.synopsis)record.synopsis=item.synopsis;
 if(item.metadataAt)record.metadataAt=item.metadataAt;
 if(item.synopsisFetchedAt)record.synopsisFetchedAt=item.synopsisFetchedAt;
 if(item.discoveredAt)record.discoveredAt=item.discoveredAt;
 if(Array.isArray(item.directors))record.directors=item.directors;
 if(Array.isArray(item.actors))record.actors=item.actors;
 if(item.peopleVersion)record.peopleVersion=item.peopleVersion;
 if(item.titleRu){record.titleRu=item.titleRu;record.titleStatus=item.titleStatus||'provisional';}
 return record;
}
function presentTmdb(value){return value==null||value===''?null:String(value);}
// Null does not hide a later id. Programme, metadata, watchlist, then the record itself. Two different ids stay a conflict.
function identityEvidence(sources){
 const ids=[];
 for(const source of sources){const id=presentTmdb(source?.tmdbId);if(id&&!ids.includes(id))ids.push(id);}
 return ids.length>1?{tmdbId:null,conflictingTmdbIds:ids}:{tmdbId:ids[0]||null,conflictingTmdbIds:null};
}
// A reviewed titleRu wins over an earlier empty one. Metadata, then programme, watchlist, and the record.
function reviewedTranslation(sources){
 for(const source of sources)if(source?.titleStatus==='verified'&&source.titleRu)return {titleRu:source.titleRu,titleStatus:'verified'};
 for(const source of sources)if(source?.titleRu)return {titleRu:source.titleRu,titleStatus:source.titleStatus||null};
 return {titleRu:null,titleStatus:null};
}
function originalTitle(sources){for(const source of sources)if(source?.original)return source.original;return null;}
function loadedSources(store,id,record){
 const metadata=cacheFor(store,id),programme=recordById(store.programme?.films,id),watchlist=recordById(store.watchlist?.films,id);
 return {metadata,programme,watchlist,record:record||catalogRecord(store,id)||archiveRecord(store,id)};
}
function tmdbRetirementRecords(store,film){
 const lid=(film?.externalIds||[]).find(item=>item.scheme==='letterboxd'&&item.trusted&&!item.conflicting)?.value;
 if(!lid)return [];
 const loaded=loadedSources(store,String(lid));
 return [loaded.programme,loaded.watchlist,loaded.metadata].filter(Boolean);
}
function knownShows(record){return record&&Object.hasOwn(record,'shows')?record.shows:undefined;}
function observedShows(programme,body){const programmeShows=knownShows(programme);return programmeShows!==undefined?programmeShows:knownShows(body);}
function observedProgrammeRun(programme,body){if(programme&&Object.hasOwn(programme,'showsProgrammeRunId'))return programme.showsProgrammeRunId||null;if(body&&Object.hasOwn(body,'showsProgrammeRunId'))return body.showsProgrammeRunId||null;return null;}
// AIR-276: Letterboxd diary slugs by lid. A diary entry links a slug to a Film only through the lid on the same row.
// Each observation bounds when the slug was first seen: an alias stamped by the writer at its `firstObservedAt`
// exactly; an older alias only within its entry's reads, `firstObservedAt`..`observedAt`. Across observations of one
// slug the first sighting lies between the earliest lower bound and the earliest upper bound, so an exact `observedAt`
// is stated only when that window closes to one instant; otherwise `observedAt: null` and `observedBetween`. A missing
// bound stays unknown (null).
function diaryAliasWindow(alias,entry){
 if(alias.firstObservedAt)return {from:alias.firstObservedAt,to:alias.firstObservedAt};
 return {from:entry.firstObservedAt||null,to:entry.observedAt||null};
}
function diarySlugIndex(history){
 const index=new Map();
 for(const entry of Object.values(history?.entries||{})){
  const lid=entry?.identity?.type==='letterboxd_lid'?String(entry.identity.value||''):'';if(!lid)continue;
  for(const alias of entry.aliases||[]){
   if(alias?.type!=='letterboxd_slug'||!/^[a-z0-9][a-z0-9-]{0,199}$/.test(String(alias.value||'')))continue;
   const slugs=index.get(lid)||new Map(),prior=slugs.get(alias.value),window=diaryAliasWindow(alias,entry);
   if(!prior)slugs.set(alias.value,{value:alias.value,entry:entry.key||null,from:window.from,to:window.to,fromKnown:!!window.from});
   else{
    prior.fromKnown=prior.fromKnown&&!!window.from;
    if(window.from&&(!prior.from||window.from<prior.from))prior.from=window.from;
    if(window.to&&(!prior.to||window.to<prior.to)){prior.to=window.to;prior.entry=entry.key||null;}
   }
   index.set(lid,slugs);
  }
 }
 for(const slugs of index.values())for(const [value,seen] of slugs){
  const from=seen.fromKnown?seen.from:null,exact=from&&seen.to&&from===seen.to;
  slugs.set(value,{value,provenance:{source:'letterboxd_diary',status:'observed',entry:seen.entry,...(exact?{observedAt:from}:{observedAt:null,observedBetween:{from,to:seen.to}})}});
 }
 return index;
}
// The Film's own permalinks: every stored record of this lid that carries one (programme, watchlist, metadata, then the
// record itself when it is none of those). One slug across them is `current`. Different slugs (a rename seen by one
// record and not yet by another) are all kept as `ambiguous`, each naming its records: no record is proved fresher.
// Diary slugs of the same lid follow as observed aliases. A record without a lid gets none.
function letterboxdSlugs(letterboxdId,loaded,store,now){
 if(!letterboxdId)return [];
 const found=new Map();
 const sources=[['programme',loaded.programme],['watchlist',loaded.watchlist],['metadata',loaded.metadata]];
 if(loaded.record&&!sources.some(([,source])=>source===loaded.record))sources.push(['record',loaded.record]);
 for(const [name,source] of sources){
  const value=letterboxdSlugFromUrl(source?.url);if(!value)continue;
  const records=found.get(value)||[];records.push(name);found.set(value,records);
 }
 const status=found.size>1?'ambiguous':'current',slugs=[];
 for(const [value,records] of found)slugs.push({value,provenance:{source:'letterboxd_film_url',status,records,url:'https://letterboxd.com/film/'+value+'/',observedAt:stamp(now)}});
 for(const slug of store.diarySlugs?.get(letterboxdId)?.values()||[])slugs.push(slug);
 return slugs;
}
function filmFacts(record,store,resolution,now){
 const id=String(record.id),loaded=loadedSources(store,id,record),metadata=loaded.metadata,programme=loaded.programme,body=metadata||record;
 const letterboxdId=id.startsWith('tmdb_')?null:id;
 const evidence=identityEvidence([loaded.programme,metadata,loaded.watchlist,record]);
 const translation=reviewedTranslation([metadata,loaded.programme,loaded.watchlist,record]);
 const decision=decisionForFilm(record,resolution);
 return {letterboxdId,letterboxdSlugs:letterboxdSlugs(letterboxdId,loaded,store,now),tmdbId:evidence.tmdbId,conflictingTmdbIds:evidence.conflictingTmdbIds,localId:letterboxdId?'film:'+letterboxdId:null,now,decision,metadata:{present:!!(metadata||body.discoveredAt||body.metadataAt||body.synopsis),metadataAt:body.metadataAt||body.discoveredAt||null,peopleVersion:body.peopleVersion??((body.directors||body.actors)?1:null),peopleNamesVersion:body.peopleNamesVersion,synopsisPresent:!!(body.synopsis||body.synopsisFetchedAt),failure:syncFailure(store.sync,id),source:letterboxdId?'letterboxd':'tmdb'},title:{original:originalTitle([metadata,loaded.programme,loaded.watchlist,record]),titleRu:translation.titleRu,titleStatus:translation.titleStatus,dictionary:(store.filmTitleIndex||{})[id]||null,provisional:store.titles?.[id]||null,epgTitle:programme&&programme.title!==body.title?programme.title:null},fingerprint:fingerprintFacts(store.fingerprints?.[id],fingerprintVerdictOf(store,id)),prediction:predictionFacts(store.predictions?.[id],predictionFailure(store,id),typeof store.predictionCompatible==='function'?store.predictionCompatible(id):undefined),predictionHistory:store.predictions?.[id]?.history||[],profile:store.profile||null,currentFingerprintHash:store.fingerprints?.[id]?.fingerprintHash??null,shows:observedShows(programme,body),showsProgrammeRunId:observedProgrammeRun(programme,body),publishedProgrammeRunId:store.programme?.runId||null,epgLastAiring:body.epgLastAiring};
}
function projectFilm(facts){const view=filmView(facts);return view?attachAvailability(view,{shows:facts.shows,showsProgrammeRunId:facts.showsProgrammeRunId,publishedProgrammeRunId:facts.publishedProgrammeRunId,epgLastAiring:facts.epgLastAiring,now:facts.now}):null;}
function lifecycleBody(film){return {contractVersion:film.contractVersion,id:film.id,storedId:storedFilmId(film),canonicalIdentity:film.canonicalIdentity,externalIds:film.externalIds,redirects:film.redirects||[],aliases:film.aliases,identity:film.identity,metadata:film.metadata,localization:film.localization,fingerprint:film.fingerprint,prediction:film.prediction,availability:film.availability||null};}
function legacyEnrichmentIds(store){
 const seen=new Set(),ids=[];
 const add=film=>{if(!film?.id)return;const identity=film.tmdbId?'tmdb:'+String(film.tmdbId):'legacy:'+String(film.id);if(seen.has(identity))return;seen.add(identity);ids.push(String(film.id));};
 const primaryIds=primaryFilmIds(store);
 const primaryFilms=store.programme?.films||store.watchlist?.films||[];
 for(const film of primaryFilms)add(film);
 for(const film of retainedWatchlistRecords(store,primaryIds))add(film);
 for(const film of retainedArchiveRecords(store,primaryIds,trustedTmdbIds(primaryFilms)))add(film);
 for(const film of [...listOf(store.discoveredFilms)].sort((a,b)=>String(a.id).localeCompare(String(b.id),'en')))add(film);
 return ids.sort((a,b)=>a.localeCompare(b,'en'));
}
function shadowParity(legacyIds,lifecycleIds){
 const legacy=[...legacyIds].sort((a,b)=>a.localeCompare(b,'en')),lifecycle=[...lifecycleIds].sort((a,b)=>a.localeCompare(b,'en'));
 const have=new Set(lifecycle),seen=new Set(legacy);
 return {ok:legacy.length===lifecycle.length&&legacy.every((id,index)=>id===lifecycle[index]),legacy,lifecycle,missing:legacy.filter(id=>!have.has(id)),extra:lifecycle.filter(id=>!seen.has(id))};
}
function legacyLocalization(store,storedId){
 const loaded=loadedSources(store,storedId),sources=[loaded.metadata,loaded.programme,loaded.watchlist,loaded.record];
 const evidence=identityEvidence([loaded.programme,loaded.metadata,loaded.watchlist,loaded.record]);
 const dictionary=(store.filmTitleIndex||{})[storedId]||null,translation=reviewedTranslation(sources),provisional=store.titles?.[storedId]||null;
 if(dictionaryApplies(dictionary,evidence.tmdbId)&&dictionary.status==='verified')return {status:'reviewed',value:dictionary.title};
 if(translation.titleStatus==='verified'&&translation.titleRu)return {status:'reviewed',value:translation.titleRu};
 if(dictionaryApplies(dictionary,evidence.tmdbId)&&dictionary.status==='provisional')return {status:'provisional',value:dictionary.title||dictionary.name};
 if(provisionalApplies(provisional,evidence.tmdbId))return {status:'provisional',value:provisional.title};
 return {status:'missing',value:null};
}
function presentedRecord(loaded){
 if(loaded.programme)return {...(loaded.watchlist||{}),...loaded.programme};
 return loaded.watchlist||loaded.record||null;
}
// GET /api/programme shows film.title. A verified dictionary entry replaces it, as applyReviewedTitle does. A titles.json row replaces it only when that route's TMDB check passes. Original and a provisional titleRu do not.
function legacyDisplayedTitle(store,storedId){
 const loaded=loadedSources(store,storedId),film=presentedRecord(loaded);
 const tmdb=presentTmdb(film?.tmdbId)||presentTmdb(loaded.metadata?.tmdbId);
 const dictionary=(store.filmTitleIndex||{})[storedId]||null;
 if(dictionary?.status==='verified'&&dictionary.title&&(!tmdb||!dictionary.tmdbId||String(dictionary.tmdbId)===String(tmdb)))return dictionary.title;
 const cached=store.titles?.[storedId];
 if(cached?.title&&cached.tmdbId&&tmdb&&String(cached.tmdbId)===String(tmdb))return cached.title;
 if(film?.title)return film.title;
 // A Film kept only by a watchlist fact is on neither list. Its page title is the metadata title, the same string the view shows.
 if(!film)return loaded.metadata?.title||loaded.metadata?.original||null;
 return null;
}
function fingerprintVerdictOf(store,storedId){return typeof store?.fingerprintCompatible==='function'?store.fingerprintCompatible(storedId):undefined;}
function legacyFingerprintStatus(file,verdict){
 if(!file)return 'missing';
 if(typeof verdict==='boolean')return verdict&&!file.invalidatedAt?'current':'stale';
 return file.fingerprintSchemaVersion!==DOMAIN_FINGERPRINT_SCHEMA_VERSION||file.invalidatedAt?'stale':'current';
}
function legacyPredictionStatus(store,storedId){
 if(predictionFailure(store,storedId))return 'failed';
 const current=store.predictions?.[storedId]?.current;
 if(!current)return 'missing';
 const fingerprint=store.fingerprints?.[storedId],profile=store.profile;
 const verdict=typeof store.predictionCompatible==='function'?store.predictionCompatible(storedId):undefined;
 const fingerprintStatus=legacyFingerprintStatus(fingerprint,fingerprintVerdictOf(store,storedId));
 if(typeof verdict==='boolean')return fingerprintStatus==='current'&&verdict?'current':'stale';
 const aligned=fingerprintStatus==='current'&&profile&&fingerprint.fingerprintHash!=null&&current.tasteProfileVersion===profile.version&&current.tasteProfileHash===profile.profileHash&&current.fingerprintHash===fingerprint.fingerprintHash&&current.fingerprintSchemaVersion===fingerprint.fingerprintSchemaVersion&&current.predictionPromptVersion===DOMAIN_PREDICTION_PROMPT_VERSION;
 return aligned?'current':'stale';
}
function legacyDisplayReady(store,storedId){
 if(!legacyDisplayedTitle(store,storedId))return false;
 if(!String(storedId).startsWith('tmdb_'))return true;
 const decision=decisionForFilm(catalogRecord(store,storedId),store.discoveryResolution||{});
 return !decision||decision.status==='verified';
}
function legacyCatalogReady(store,storedId,now){
 if(syncFailure(store.sync,storedId))return false;
 const loaded=loadedSources(store,storedId),body=loaded.metadata||loaded.record;
 if(!body||!metadataFresh(body.metadataAt||body.discoveredAt,now)||!(body.synopsis||body.synopsisFetchedAt))return false;
 if(!String(storedId).startsWith('tmdb_'))return true;
 const decision=decisionForFilm(loaded.record,store.discoveryResolution||{});
 return !!presentTmdb(loaded.record?.tmdbId)&&(!decision||decision.status==='verified');
}
function semanticMismatches(store,films,now){
 const context={...store,filmTitleIndex:store.filmTitleIndex||indexRecords(store.filmTitles,'id')};
 const mismatches=[];
 for(const film of films||[]){
  const id=storedFilmId(film);
  if(!id)continue;
  const localization=legacyLocalization(context,id);
  const fields={
   title:[legacyDisplayedTitle(context,id),preferredTitle(film)],
   localization:[localization.status,film.localization?.status||'missing'],
   fingerprint:[legacyFingerprintStatus(context.fingerprints?.[id],fingerprintVerdictOf(context,id)),film.fingerprint?.status||'missing'],
   prediction:[legacyPredictionStatus(context,id),film.prediction?.status||'missing'],
   displayReady:[legacyDisplayReady(context,id),displayReady(film)],
   catalogReady:[legacyCatalogReady(context,id,now),catalogReady(film)],
   predictionReady:[legacyFingerprintStatus(context.fingerprints?.[id],fingerprintVerdictOf(context,id))==='current'&&legacyPredictionStatus(context,id)==='current',predictionReady(film)]
  };
  for(const [field,[legacy,lifecycle]] of Object.entries(fields))if(legacy!==lifecycle)mismatches.push({id,field,legacy,lifecycle});
 }
 return mismatches.sort((a,b)=>a.id.localeCompare(b.id,'en')||a.field.localeCompare(b.field,'en'));
}
function filmForCatalogRecord(filmList,record){
 const id=String(record.id),own=filmList.find(item=>storedFilmId(item)===id);
 if(own)return own;
 const minted=record.tmdbId!=null?'film:tmdb:'+record.tmdbId:null;
 return filmList.find(item=>(item.redirects||[]).some(redirect=>redirect.from===minted||redirect.from==='film:'+id))||null;
}
function personFacts(person,store,now){
 const roleId=person.id,dictionary=store.personOverrides?.[roleId]||store.personNameIndex?.[roleId]||null,cache=store.people?.[roleId]||null;
 return {roleId,original:person.original||cache?.original||null,dictionary,cacheName:cache?.name||null,now};
}
// AIR-402: the catalog merge asks, for each catalog record, for the first Film of the map (in map order) that carries a trusted, non-conflicting
// TMDB id equal to the record's, and for the first Film whose stored id is the record's. Scanning a copy of the map for each record made the
// merge quadratic. This index answers both from the same map in the same order: every Film gets a sequence number when its key enters the map
// (a key set again keeps its place, a key deleted and set again goes to the end, as in a Map), a bucket holds the keys that share a value, and the
// first match is the key with the lowest sequence number. It lives for one merge and never outlives the map it mirrors.
function orderedFilmIndex(films){
 let counter=0;
 const sequence=new Map(),byTmdb=new Map(),byStored=new Map();
 const add=(index,value,key,seq)=>{let bucket=index.get(value);if(!bucket){bucket=new Map();index.set(value,bucket);}bucket.set(key,seq);};
 const drop=(index,value,key)=>{const bucket=index.get(value);if(!bucket)return;bucket.delete(key);if(!bucket.size)index.delete(value);};
 const tmdbValues=film=>{const values=[];for(const item of film.externalIds||[])if(item.scheme==='tmdb'&&item.trusted&&!item.conflicting&&item.value===item.value)values.push(item.value);return values;};
 const place=(key,film,seq)=>{for(const value of tmdbValues(film))add(byTmdb,value,key,seq);add(byStored,storedFilmId(film),key,seq);};
 const remove=(key,film)=>{for(const value of tmdbValues(film))drop(byTmdb,value,key);drop(byStored,storedFilmId(film),key);};
 const first=(index,value)=>{
  const bucket=index.get(value);
  if(!bucket)return null;
  let found,lowest=Infinity;
  for(const [key,seq] of bucket)if(seq<lowest){found=key;lowest=seq;}
  return films.get(found)||null;
 };
 for(const [key,film] of films){const seq=counter++;sequence.set(key,seq);place(key,film,seq);}
 return {
  set(key,film){
   if(films.has(key)){remove(key,films.get(key));films.set(key,film);place(key,film,sequence.get(key));return;}
   films.set(key,film);const seq=counter++;sequence.set(key,seq);place(key,film,seq);
  },
  delete(key){if(!films.has(key))return;remove(key,films.get(key));sequence.delete(key);films.delete(key);},
  firstWithTmdb:value=>first(byTmdb,value),
  firstStored:value=>first(byStored,value)
 };
}
// options.entitiesOnly returns the Films and People alone, without the sidecars and the legacy parity: the D1 enrichment projector
// (AIR-275 phase 2, ADR 0056) needs nothing else, and building the rest roughly doubles the memory of one view.
function readLifecycle(store,now,options={}){
 const filmTitleIndex=store.filmTitleIndex||indexRecords(store.filmTitles,'id'),personNameIndex=store.personNameIndex||indexRecords(store.personNames,'id');
 const context={...store,filmTitleIndex,personNameIndex,diarySlugs:diarySlugIndex(store.diaryHistory)};
 const resolution=store.discoveryResolution||{};
 const films=new Map();
 const primary=store.programme?.films||store.watchlist?.films||[];
 const seenIds=primaryFilmIds(store);
 for(const record of [...primary,...retainedWatchlistRecords(store,seenIds),...retainedArchiveRecords(store,seenIds,trustedTmdbIds(primary))]){const facts=filmFacts(record,context,resolution,now),view=projectFilm(facts);if(view)films.set(storedFilmId(view),view);}
 // AIR-297 (ADR 0057): the owner-approved TMDB retirements, only when the object exists. Absent, the view is what it was.
 const retirements=store.tmdbRetirements==null?null:applyTmdbRetirements([...films.values()],store.tmdbRetirements,film=>tmdbRetirementRecords(context,film));
 if(retirements)for(const film of retirements.films)films.set(storedFilmId(film),film);
 const merged=orderedFilmIndex(films);
 for(const record of listOf(store.discoveredFilms)){
  const facts=filmFacts(record,context,resolution,now),incoming=projectFilm({...facts,letterboxdId:null,localId:null});
  if(!incoming)continue;
  const same=facts.tmdbId?merged.firstWithTmdb(facts.tmdbId):null;
  // A thin rated-archive stub uses the same stored id as a discovered film. Keep the discovered metadata and credits.
  const archive=archiveItemFor(store,String(record.id),facts.tmdbId),prior=same||(films.has(String(record.id))?merged.firstStored(String(record.id)):null);
  if(occupantIsArchiveStub(store,prior,archive)&&sourceRichness(record)>sourceRichness(archive)){merged.delete(storedFilmId(prior));merged.set(storedFilmId(incoming),incoming);continue;}
  if(films.has(String(record.id)))continue;
  if(!same){merged.set(storedFilmId(incoming),incoming);continue;}
  const linked=linkFilms(same,incoming,now);
  if(!linked.ok){merged.set(storedFilmId(incoming),incoming);continue;}
  merged.delete(storedFilmId(same));merged.set(storedFilmId(linked.survivor),linked.survivor);
 }
 const settled=retirements?settleTmdbRetirements([...films.values()],retirements):null;
 for(const film of settled?.restore||[])films.set(storedFilmId(film),film);
 const retirementReport=settled?{tmdbRetirements:settled.report}:{};
 const candidates=[],conflicts=[];
 const items=new Map((store.discoveryLatest?.items||[]).map(item=>[item.key,item]));
 const storedIds=new Set([...films.values()].map(storedFilmId)),viewIds=new Set([...films.values()].map(film=>film.id));
 for(const [key,decision] of resolutionEntries(resolution)){
  if(Array.isArray(decision.conflictingTmdbIds)&&decision.conflictingTmdbIds.length>1){
   const view=projectFilm({conflictingTmdbIds:decision.conflictingTmdbIds,now,decision,title:{original:items.get(key)?.title||null},metadata:{present:false},fingerprint:{present:false},prediction:{present:false},shows:[]});
   if(view)conflicts.push(view);
   candidates.push({key,film:view,identity:view?.identity||null,excluded:false});
   continue;
  }
  const matched=!!decision.filmId&&(storedIds.has(decision.filmId)||viewIds.has('film:'+decision.filmId));
  if(decision.status==='excluded_nonfilm'){candidates.push({key,film:null,identity:null,excluded:true});continue;}
  if(matched)continue;
  candidates.push({key,film:null,identity:identityState({now,decision,discovery:decision.discovery||null,tmdbId:decision.tmdbId?String(decision.tmdbId):null}),excluded:false,missingCatalog:decision.status==='verified'});
 }
 const people=new Map();
 const embedded=[...peopleOn(store.programme),...(store.programme?.films||[]).flatMap(peopleOn),...(store.watchlist?.films||[]).flatMap(peopleOn),...listOf(store.metadata).flatMap(peopleOn),...listOf(store.discoveredFilms).flatMap(peopleOn),...listOf(store.archiveAdmissions).flatMap(peopleOn)];
 for(const person of embedded){if(!person?.id||people.has(person.id))continue;const view=personView(personFacts(person,context,now));if(view)people.set(person.id,view);}
 const filmList=[...films.values()].sort((a,b)=>storedFilmId(a).localeCompare(storedFilmId(b),'en'));
 const aliasConflicts=markSlugCollisions(filmList);
 const sortedPeople=()=>[...people.values()].sort((a,b)=>a.roleId.localeCompare(b.roleId,'en'));
 if(options.entitiesOnly)return {contractVersion:DOMAIN_CONTRACT_VERSION,films:filmList,aliasConflicts,people:sortedPeople(),candidates,conflicts,...retirementReport};
 const legacyIds=legacyEnrichmentIds(store),lifecycleIds=filmList.map(storedFilmId),idParity=shadowParity(legacyIds,lifecycleIds);
 const shared=new Set(idParity.legacy),mismatches=semanticMismatches(context,filmList.filter(film=>shared.has(storedFilmId(film))),now);
 const sidecars={};
 const watchlistBodies=Object.fromEntries(filmList.filter(film=>!String(storedFilmId(film)).startsWith('tmdb_')).map(film=>[storedFilmId(film),lifecycleBody(film)]));
 if(store.watchlist)sidecars[sidecarKey('watchlist.json')]=watchlistBodies;
 if(store.metadata)sidecars[sidecarKey('metadata.json')]=Object.fromEntries(Object.keys(store.metadata).filter(id=>watchlistBodies[id]).map(id=>[id,watchlistBodies[id]]));
 if(store.discoveredFilms){
  const discoveredBodies={};
  for(const record of listOf(store.discoveredFilms)){
   const film=filmForCatalogRecord(filmList,record);
   if(film)discoveredBodies[String(record.id)]=lifecycleBody(film);
  }
  sidecars[sidecarKey('epg/discovered-films.json')]=discoveredBodies;
 }
 for(const id of Object.keys(store.fingerprints||{})){
  const film=filmList.find(item=>storedFilmId(item)===String(id));
  if(film)sidecars['enrichment/films/'+encodeURIComponent(String(id))+'/fingerprint'+LIFECYCLE_SIDECAR]={id:film.id,storedId:storedFilmId(film),fingerprint:film.fingerprint};
 }
 for(const key of Object.keys(sidecars))if(FORBIDDEN_LIFECYCLE_KEYS.includes(key)||key.includes('discovery-latest')||key.includes('predictions'))throw new Error('lifecycle sidecar overwrites '+key);
 return {contractVersion:DOMAIN_CONTRACT_VERSION,films:filmList,aliasConflicts,people:sortedPeople(),candidates,conflicts,...retirementReport,sidecars,parity:{...idParity,ok:idParity.ok&&mismatches.length===0,mismatches,excludedCandidates:candidates.filter(candidate=>candidate.excluded).length,candidateKeys:candidates.map(candidate=>candidate.key)}};
}
// Classifies historical rows that are no longer on the current lists. It does not write, mint a Film, or merge an ambiguous row.
function reconcileDepartedFilms({admissions={},existing=[],orphans=[]}={}){
 const films=Array.isArray(existing)?existing.filter(Boolean):[];
 const byLid=new Map();
 for(const film of films)if(film.lid)byLid.set(String(film.lid),film);
 const byTrusted=new Map();
 for(const film of films)if(film.trusted&&film.tmdbScheme!=='tmdb_tv'&&film.tmdbId){const key=String(film.tmdbId);if(!byTrusted.has(key))byTrusted.set(key,[]);byTrusted.get(key).push(film);}
 const rows=(Array.isArray(orphans)?orphans:[]).map(row=>({...row,key:String(row?.key??'')}));
 const slugOwners=new Map(),unverified=new Map();
 for(const row of rows){
  if(row.slug&&row.lid){const set=slugOwners.get(row.slug)||new Set();set.add(String(row.lid));slugOwners.set(row.slug,set);}
  if(!row.trusted&&row.tmdbId&&row.tmdbScheme!=='tmdb_tv'&&row.lid){const key=String(row.tmdbId);if(!unverified.has(key))unverified.set(key,new Set());unverified.get(key).add(String(row.lid));}
 }
 return rows.map(row=>{
  const lid=row.lid?String(row.lid):'',tmdb=row.tmdbId?String(row.tmdbId):'',tv=row.tmdbScheme==='tmdb_tv';
  if(tv&&(row.movieId||row.trusted))return {key:row.key,outcome:'conflict',reason:'tmdb_tv',filmId:null};
  if(row.slug&&(slugOwners.get(row.slug)?.size||0)>1)return {key:row.key,outcome:'conflict',reason:'slug_collision',filmId:null};
  if(lid&&!row.trusted&&tmdb&&(unverified.get(tmdb)?.size||0)>1)return {key:row.key,outcome:'ambiguous',reason:'unverified_tmdb',filmId:null};
  const joined=lid?byLid.get(lid)||null:null;
  if(joined&&row.trusted&&tmdb&&joined.trusted&&joined.tmdbId&&String(joined.tmdbId)!==tmdb)return {key:row.key,outcome:'conflict',reason:'trusted_tmdb',filmId:joined.id||null};
  if(joined)return {key:row.key,outcome:'resolved',reason:'existing_film',filmId:joined.id||null};
  if(row.trusted&&!tv&&tmdb){const matches=byTrusted.get(tmdb)||[];if(matches.length>1)return {key:row.key,outcome:'conflict',reason:'trusted_tmdb',filmId:null};if(matches.length===1)return {key:row.key,outcome:'resolved',reason:'existing_film',filmId:matches[0].id||null};}
  if(lid&&typeof admissions[lid]==='boolean')return {key:row.key,outcome:'resolved',reason:'watchlist_fact',filmId:null};
  if(lid||(row.trusted&&!tv&&tmdb))return {key:row.key,outcome:'unresolved',reason:'no_film',filmId:null};
  return {key:row.key,outcome:'unresolved',reason:'no_identity',filmId:null};
 });
}
