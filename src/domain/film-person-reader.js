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
function decisionForFilm(film,resolution){
 if(!String(film?.id||'').startsWith('tmdb_'))return null;
 const matches=resolutionEntries(resolution).map(([,decision])=>decision).filter(decision=>decision.tmdbId!=null&&String(decision.tmdbId)===String(film.tmdbId)&&(!decision.filmId||decision.filmId===film.id));
 const verified=matches.find(decision=>decision.status==='verified');
 if(verified)return verified;
 const specific=matches.find(decision=>decision.filmId===film.id&&['ambiguous','no_confident_match','duration_mismatch'].includes(decision.status));
 return specific||(film.tmdbId?{status:'verified'}:null);
}
function syncFailure(sync,id){return (sync?.failures||[]).find(failure=>failure&&failure.id===id)||null;}
function predictionFailure(store,id){return store.predictionRun?.failures?.[id]||store.predictionQueue?.retries?.[id]||null;}
function peopleOn(record){return [...(record?.directors||[]),...(record?.actors||[]),...(record?.people?.directors||[]),...(record?.people?.actors||[])];}
function recordById(records,id){return (records||[]).find(record=>record&&String(record.id)===id)||null;}
function catalogRecord(store,id){return listOf(store.discoveredFilms).find(record=>record&&String(record.id)===id)||null;}
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
 const metadata=store.metadata?.[id]||null,programme=recordById(store.programme?.films,id),watchlist=recordById(store.watchlist?.films,id);
 return {metadata,programme,watchlist,record:record||catalogRecord(store,id)};
}
function knownShows(record){return record&&Object.hasOwn(record,'shows')?record.shows:undefined;}
function observedShows(programme,body){const programmeShows=knownShows(programme);return programmeShows!==undefined?programmeShows:knownShows(body);}
function observedProgrammeRun(programme,body){if(programme&&Object.hasOwn(programme,'showsProgrammeRunId'))return programme.showsProgrammeRunId||null;if(body&&Object.hasOwn(body,'showsProgrammeRunId'))return body.showsProgrammeRunId||null;return null;}
function filmFacts(record,store,resolution,now){
 const id=String(record.id),loaded=loadedSources(store,id,record),metadata=loaded.metadata,programme=loaded.programme,body=metadata||record;
 const letterboxdId=id.startsWith('tmdb_')?null:id;
 const evidence=identityEvidence([loaded.programme,metadata,loaded.watchlist,record]);
 const translation=reviewedTranslation([metadata,loaded.programme,loaded.watchlist,record]);
 const decision=decisionForFilm(record,resolution);
 return {letterboxdId,tmdbId:evidence.tmdbId,conflictingTmdbIds:evidence.conflictingTmdbIds,localId:letterboxdId?'film:'+letterboxdId:null,now,decision,metadata:{present:!!(metadata||body.discoveredAt||body.metadataAt||body.synopsis),metadataAt:body.metadataAt||body.discoveredAt||null,peopleVersion:body.peopleVersion??((body.directors||body.actors)?1:null),peopleNamesVersion:body.peopleNamesVersion,synopsisPresent:!!(body.synopsis||body.synopsisFetchedAt),failure:syncFailure(store.sync,id),source:letterboxdId?'letterboxd':'tmdb'},title:{original:originalTitle([metadata,loaded.programme,loaded.watchlist,record]),titleRu:translation.titleRu,titleStatus:translation.titleStatus,dictionary:(store.filmTitleIndex||{})[id]||null,provisional:store.titles?.[id]||null,epgTitle:programme&&programme.title!==body.title?programme.title:null},fingerprint:fingerprintFacts(store.fingerprints?.[id],fingerprintVerdictOf(store,id)),prediction:predictionFacts(store.predictions?.[id],predictionFailure(store,id),typeof store.predictionCompatible==='function'?store.predictionCompatible(id):undefined),predictionHistory:store.predictions?.[id]?.history||[],profile:store.profile||null,currentFingerprintHash:store.fingerprints?.[id]?.fingerprintHash??null,shows:observedShows(programme,body),showsProgrammeRunId:observedProgrammeRun(programme,body),publishedProgrammeRunId:store.programme?.runId||null,epgLastAiring:body.epgLastAiring};
}
function projectFilm(facts){const view=filmView(facts);return view?attachAvailability(view,{shows:facts.shows,showsProgrammeRunId:facts.showsProgrammeRunId,publishedProgrammeRunId:facts.publishedProgrammeRunId,epgLastAiring:facts.epgLastAiring,now:facts.now}):null;}
function lifecycleBody(film){return {contractVersion:film.contractVersion,id:film.id,storedId:storedFilmId(film),canonicalIdentity:film.canonicalIdentity,externalIds:film.externalIds,redirects:film.redirects||[],aliases:film.aliases,identity:film.identity,metadata:film.metadata,localization:film.localization,fingerprint:film.fingerprint,prediction:film.prediction,availability:film.availability||null};}
function legacyEnrichmentIds(store){
 const seen=new Set(),ids=[];
 const add=film=>{if(!film?.id)return;const identity=film.tmdbId?'tmdb:'+String(film.tmdbId):'legacy:'+String(film.id);if(seen.has(identity))return;seen.add(identity);ids.push(String(film.id));};
 for(const film of store.programme?.films||store.watchlist?.films||[])add(film);
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
 return film?.title||null;
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
function readLifecycle(store,now){
 const filmTitleIndex=store.filmTitleIndex||indexRecords(store.filmTitles,'id'),personNameIndex=store.personNameIndex||indexRecords(store.personNames,'id');
 const context={...store,filmTitleIndex,personNameIndex};
 const resolution=store.discoveryResolution||{};
 const films=new Map();
 for(const record of store.programme?.films||store.watchlist?.films||[]){const facts=filmFacts(record,context,resolution,now),view=projectFilm(facts);if(view)films.set(storedFilmId(view),view);}
 for(const record of listOf(store.discoveredFilms)){
  if(films.has(String(record.id)))continue;
  const facts=filmFacts(record,context,resolution,now),incoming=projectFilm({...facts,letterboxdId:null,localId:null});
  if(!incoming)continue;
  const same=facts.tmdbId?[...films.values()].find(film=>(film.externalIds||[]).some(item=>item.scheme==='tmdb'&&item.trusted&&!item.conflicting&&item.value===facts.tmdbId)):null;
  if(!same){films.set(storedFilmId(incoming),incoming);continue;}
  const linked=linkFilms(same,incoming,now);
  if(!linked.ok){films.set(storedFilmId(incoming),incoming);continue;}
  films.delete(storedFilmId(same));films.set(storedFilmId(linked.survivor),linked.survivor);
 }
 const candidates=[],conflicts=[];
 const items=new Map((store.discoveryLatest?.items||[]).map(item=>[item.key,item]));
 for(const [key,decision] of resolutionEntries(resolution)){
  if(Array.isArray(decision.conflictingTmdbIds)&&decision.conflictingTmdbIds.length>1){
   const view=projectFilm({conflictingTmdbIds:decision.conflictingTmdbIds,now,decision,title:{original:items.get(key)?.title||null},metadata:{present:false},fingerprint:{present:false},prediction:{present:false},shows:[]});
   if(view)conflicts.push(view);
   candidates.push({key,film:view,identity:view?.identity||null,excluded:false});
   continue;
  }
  const matched=[...films.values()].some(film=>decision.filmId&&(storedFilmId(film)===decision.filmId||film.id==='film:'+decision.filmId));
  if(decision.status==='excluded_nonfilm'){candidates.push({key,film:null,identity:null,excluded:true});continue;}
  if(matched)continue;
  candidates.push({key,film:null,identity:identityState({now,decision,discovery:decision.discovery||null,tmdbId:decision.tmdbId?String(decision.tmdbId):null}),excluded:false,missingCatalog:decision.status==='verified'});
 }
 const people=new Map();
 const embedded=[...peopleOn(store.programme),...(store.programme?.films||[]).flatMap(peopleOn),...(store.watchlist?.films||[]).flatMap(peopleOn),...listOf(store.metadata).flatMap(peopleOn),...listOf(store.discoveredFilms).flatMap(peopleOn)];
 for(const person of embedded){if(!person?.id||people.has(person.id))continue;const view=personView(personFacts(person,context,now));if(view)people.set(person.id,view);}
 const filmList=[...films.values()].sort((a,b)=>storedFilmId(a).localeCompare(storedFilmId(b),'en'));
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
 return {contractVersion:DOMAIN_CONTRACT_VERSION,films:filmList,people:[...people.values()].sort((a,b)=>a.roleId.localeCompare(b.roleId,'en')),candidates,conflicts,sidecars,parity:{...idParity,ok:idParity.ok&&mismatches.length===0,mismatches,excludedCandidates:candidates.filter(candidate=>candidate.excluded).length,candidateKeys:candidates.map(candidate=>candidate.key)}};
}
