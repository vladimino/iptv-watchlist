// EPG title resolution is independent of the usage-limited prediction runner.
const DISCOVERY_LEASE_KEY='epg/resolver-lease.json';
const DISCOVERY_CONTINUATION_URL='https://iptv.internal/discovery/continue';
function filmIsHot(film,now=Date.now()){
 const from=now-72*3600000,to=now+24*3600000;
 if(Array.isArray(film.shows))return film.shows.some(show=>Number(show.start)>=from&&Number(show.start)<to);
 // A cache written before shows were stored can still use its last observed airing.
 return Number.isFinite(film.epgLastAiring)&&film.epgLastAiring>=from&&film.epgLastAiring<to;
}
function candidateIsHot(candidate,now=Date.now()){return Array.isArray(candidate.shows)?filmIsHot({shows:candidate.shows},now):filmIsHot({epgLastAiring:candidate.lastAiring},now);}
function discoveryReady(candidate,decision,now){return !decision||!['verified','excluded_nonfilm'].includes(decision.status)&&(!decision.retryAt||Date.parse(decision.retryAt)<=now);}
async function acquireDiscoveryLease(env){
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY),old=object?await object.json():null;
 if(old?.expiresAt>Date.now())return null;
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 return saved===null?null:lease;
}
async function releaseDiscoveryLease(env,lease){const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY);if(!object)return;const current=await object.json();if(current.id===lease.id)await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:object.etag}});}
async function tmdbRequest(env,path){
 if(env.TMDB_REQUEST_INTERVAL_MS!==0)await new Promise(resolve=>setTimeout(resolve,200));
 const response=await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+env.TMDB_API_READ_ACCESS_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
 if(!response.ok){const error=new Error('TMDB HTTP '+response.status);if(response.status===429){error.retryAt=new Date(Date.now()+Math.max(30,Math.min(3600,Number(response.headers.get('Retry-After'))||60))*1000).toISOString();}throw error;}return response.json();
}
function touchCanonicalFilm(film,candidate,programmeRunId){
 const explicit=Array.isArray(candidate.shows),incoming=explicit?dedupeShows(candidate.shows):null,same=!!programmeRunId&&film.showsProgrammeRunId===programmeRunId;
 const shows=incoming===null?film.shows||[]:same?dedupeShows([...(film.shows||[]),...incoming]):incoming;
 const hotEnteredAt=candidateIsHot(candidate)&&!filmIsHot(film)?new Date().toISOString():film.hotEnteredAt;
 return {...film,hotEnteredAt,canonicalIdentity:'tmdb:'+film.tmdbId,aliases:[...new Set([...(film.aliases||[]),candidate.title,...(candidate.rawTitles||[])].filter(Boolean))],shows,showsProgrammeRunId:explicit&&programmeRunId?programmeRunId:film.showsProgrammeRunId||null,epgLastAiring:Math.max(film.epgLastAiring||0,candidate.lastAiring||0)};
}
async function saveDiscoveredFilms(env,films,seenRunId){
 if(typeof env.beforeCatalogWrite==='function'){const hook=env.beforeCatalogWrite;env.beforeCatalogWrite=null;await hook();}
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 if(generation?.phase==='published'&&seenRunId&&generation.programmeRunId!==seenRunId)return false;
 if(generation?.phase==='published'&&generation.programmeRunId===seenRunId)await saveJSON(env,epgGenerationKey(seenRunId,'discovered-films.json'),films);
 await saveJSON(env,'epg/discovered-films.json',films);return true;
}
async function resolveDiscoveryBatch(env,report,limit=24){
 if(!env.TMDB_API_READ_ACCESS_TOKEN)return {stage:'missing_secret',checked:0,remaining:null};
 const lease=await acquireDiscoveryLease(env);if(!lease)return {stage:'busy',checked:0,remaining:null};
 try{return await resolveDiscoveryChunk(env,report,limit);}finally{await releaseDiscoveryLease(env,lease);}
}
async function resolveDiscoveryChunk(env,report,limit){
 const startedAt=new Date().toISOString(),deadline=Date.now()+22000;
 const [source,resolution,catalog,last]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json')]);
 if(!source?.items)return {stage:'awaiting_epg_discovery',checked:0,remaining:null};
 if(last?.retryAt&&Date.parse(last.retryAt)>Date.now())return {...last,stage:'backoff',checked:0};
 const decisions=resolution||{},films=catalog||{},watchlist=(report.films||[]),knownTmdb=new Map(watchlist.filter(f=>f.tmdbId).map(f=>[String(f.tmdbId),String(f.id)])),aliasIndex=new Map();
 const indexFilm=film=>{if(!film?.tmdbId)return;for(const alias of new Set([film.title,film.original,...(film.aliases||[])])){const key=epgTitleParts(alias).normalizedTitle;if(!key)continue;const entries=aliasIndex.get(key)||new Map();entries.set(String(film.tmdbId),film);aliasIndex.set(key,entries);}};
 for(const film of [...Object.values(films),...watchlist])indexFilm(film);
 let screenedOut=0,knownAliases=0,touched=0,migrated=0;for(const film of Object.values(films))if(film.tmdbId&&film.canonicalIdentity!=='tmdb:'+film.tmdbId){film.canonicalIdentity='tmdb:'+film.tmdbId;migrated++;}
 // Cheap pass updates availability for known identities even though no new lookup is needed.
 for(const candidate of source.items){const reason=nonFilmEPGReason(candidate.title),decision=decisions[candidate.key];if(reason){if(decision?.status!=='excluded_nonfilm'){decisions[candidate.key]={status:'excluded_nonfilm',reason,checkedAt:startedAt};screenedOut++;}continue;}
  if(candidate.confirmedTmdbId&&!decision){decisions[candidate.key]={status:'verified',filmId:knownTmdb.get(candidate.confirmedTmdbId)||'tmdb_'+candidate.confirmedTmdbId,tmdbId:candidate.confirmedTmdbId,identitySource:'known_epg_alias',checkedAt:startedAt};knownAliases++;}
  const verified=decisions[candidate.key];if(verified?.status==='verified'){const key='tmdb_'+verified.tmdbId,film=films[key];if(film&&candidateIsHot(candidate)){films[key]=touchCanonicalFilm(film,candidate,source.programmeRunId);indexFilm(films[key]);touched++;}}
 }
 if(touched||migrated){if(!await saveDiscoveredFilms(env,films,source.programmeRunId))return {schemaVersion:2,stage:'programme_changed',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,currentProgrammeRunId:null};}if(screenedOut||knownAliases)await saveJSON(env,'epg/discovery-resolution.json',decisions);
 await saveJSON(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId||null,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,checkpoint:'cheap_pass'});
 const now=Date.now(),pending=source.items.filter(c=>discoveryReady(c,decisions[c.key],now)),hotRank=new Map(pending.map(c=>[c,candidateIsHot(c,now)?1:0]));
 pending.sort((a,b)=>hotRank.get(b)-hotRank.get(a)||Number(!!b.year)-Number(!!a.year)||b.lastAiring-a.lastAiring||a.key.localeCompare(b.key));
 let checked=0,added=0,reused=0,tmdbCalls=0,error=null,retryAt=null;
 const query=async path=>{tmdbCalls++;return tmdbRequest(env,path);};
 for(const candidate of pending.slice(0,limit)){
  if(Date.now()>deadline||tmdbCalls>=16)break;
  try{
   const matches=[...(aliasIndex.get(candidate.normalizedTitle)?.values()||[])].filter(f=>(!candidate.year||Number(f.year)===Number(candidate.year))&&f.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(f.runtime-d)<=Math.max(8,f.runtime*.08)));
   if(matches.length===1){const film=matches[0],id=knownTmdb.get(String(film.tmdbId))||'tmdb_'+film.tmdbId;if(films[id]){films[id]=touchCanonicalFilm(films[id],candidate,source.programmeRunId);if(!await saveDiscoveredFilms(env,films,source.programmeRunId))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};}decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(film.tmdbId),canonicalIdentity:'tmdb:'+film.tmdbId,identitySource:candidate.year?'known_alias_year_runtime':'known_alias_unique_runtime',checkedAt:new Date().toISOString()};reused++;}
   else{
    if(tmdbCalls>13)break;let search=null,exact=[];
    for(const language of /[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA']){search=await query('search/movie?'+new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})}));exact=(search.results||[]).filter(m=>[m.title,m.original_title].some(t=>norm(t)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(m.release_date?.slice(0,4))-candidate.year)<=1));if(exact.length)break;}
    let status=exact.length>1?'ambiguous':'no_confident_match';
    if(exact.length===1&&(candidate.year||search.total_pages<=1)){
     const movie=await query('movie/'+exact[0].id+'?language=ru-RU&append_to_response=credits,translations,alternative_titles'),tolerance=candidate.year?Math.max(25,movie.runtime*.2):Math.max(10,movie.runtime*.12);
     if(movie.id===exact[0].id&&movie.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(movie.runtime-d)<=tolerance)){
      status='verified';const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
      if(!knownTmdb.has(String(movie.id))){const people=(entries,prefix)=>(entries||[]).slice(0,10).map(p=>({id:prefix+'/'+p.id,name:p.name,original:p.name})),localized=(movie.translations?.translations||[]).filter(t=>['ru','uk','en'].includes(t.iso_639_1)).map(t=>t.data?.title),alternates=(movie.alternative_titles?.titles||[]).filter(t=>['RU','UA','US','GB'].includes(t.iso_3166_1)).map(t=>t.title),old=films[id];if(!old)added++;
       films[id]=touchCanonicalFilm({...old,discoveredAt:old?.discoveredAt||new Date().toISOString(),id,tmdbId:String(movie.id),url:'https://www.themoviedb.org/movie/'+movie.id,title:movie.title||candidate.title,original:movie.original_title||candidate.title,aliases:[...new Set([...(old?.aliases||[]),movie.title,movie.original_title,...localized,...alternates].filter(Boolean))],year:Number(movie.release_date?.slice(0,4))||candidate.year,genres:(movie.genres||[]).map(g=>g.name),synopsis:movie.overview||candidate.description||null,runtime:movie.runtime,poster:movie.poster_path?'https://image.tmdb.org/t/p/w342'+movie.poster_path:null,directors:people((movie.credits?.crew||[]).filter(p=>p.job==='Director'),'tmdb_director'),actors:people(movie.credits?.cast,'tmdb_actor')},candidate,source.programmeRunId);indexFilm(films[id]);if(!await saveDiscoveredFilms(env,films,source.programmeRunId))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
      }
      decisions[candidate.key]={status,filmId:id,tmdbId:String(movie.id),canonicalIdentity:'tmdb:'+movie.id,checkedAt:new Date().toISOString()};
     }else status='duration_mismatch';
    }
    if(status!=='verified'){const attempts=(decisions[candidate.key]?.attempts||0)+1;decisions[candidate.key]={status,attempts,checkedAt:new Date().toISOString(),retryAt:new Date(Date.now()+Math.min(7,2**(attempts-1))*86400000).toISOString()};}
   }
   // A film is committed before its decision. A crash between writes is repaired by alias reuse.
   await saveJSON(env,'epg/discovery-resolution.json',decisions);checked++;
  }catch(e){error=String(e.message).slice(0,120);retryAt=e.retryAt||new Date(Date.now()+60000).toISOString();break;}
 }
 const currentReport=await loadJSON(env,'programme.json');
 if(source.programmeRunId&&currentReport?.runId&&currentReport.runId!==source.programmeRunId){
  const changed={schemaVersion:2,stage:'partial',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:source.items.filter(c=>!nonFilmEPGReason(c.title)&&discoveryReady(c,decisions[c.key],Date.now())).length,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId,programmeChanged:true};
  await saveJSON(env,'epg/discovery-status.json',changed);return {...changed,stage:'programme_changed',currentProgrammeRunId:currentReport.runId};
 }
 try{await refreshPredictionQueue(env,currentReport||report,'resolver_checkpoint');}catch(e){error=error||'prediction_queue_checkpoint: '+String(e.message).slice(0,100);}
 const persistedDecisions=error?await loadJSON(env,'epg/discovery-resolution.json')||{}:decisions,ready=source.items.filter(c=>!nonFilmEPGReason(c.title)&&discoveryReady(c,persistedDecisions[c.key],Date.now())),summary={schemaVersion:2,stage:error?'partial':ready.length?'partial':'complete',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:ready.length,hotRemaining:ready.filter(c=>candidateIsHot(c)).length,error,retryAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
 await saveJSON(env,'epg/discovery-status.json',summary);return summary;
}
// One request runs one chunk. A later HTTP request is not a new isolate; confirm the memory hypothesis in production after deploy. Do not schedule the next chunk with waitUntil.
const DISCOVERY_CHUNK_BUDGET=12;
const CONTINUATION_KEY='epg/resolver-continuation.json';
function discoveryContract(record,override={}){
 const state=override.state||record?.stage||'idle';
 const reason=override.reason!==undefined?override.reason:record?.reason??null;
 const remainingChunks=override.remainingChunks!==undefined?override.remainingChunks:record?.remainingChunks??0;
 const retryAt=override.retryAt!==undefined?override.retryAt:record?.retryAt??null;
 const catchUpAt=override.nextCatchUpAt!==undefined?override.nextCatchUpAt:record?.nextCatchUpAt??null;
 let nextAction=override.nextAction;
 if(!nextAction){
  if(state==='busy'||reason==='chunk_budget'||reason==='backoff'||state==='error')nextAction='wait';
  else if(state==='complete'||['programme_changed','missing_secret','idle'].includes(reason)||remainingChunks<=0)nextAction='stop';
  else nextAction='continue';
 }
 return {state,remainingChunks,nextAction,reason:reason||null,at:override.at||record?.at||null,nextCatchUpAt:nextAction==='wait'?(catchUpAt||nextCatchUpAt()):catchUpAt,retryAt:retryAt||null,programmeRunId:override.programmeRunId!==undefined?override.programmeRunId:record?.programmeRunId??null};
}
function continuationDecision(current,now){
 if(!current)return {run:true,budget:DISCOVERY_CHUNK_BUDGET};
 const due=Date.parse(current.retryAt||current.nextCatchUpAt||0),chunks=Number.isInteger(current.remainingChunks)?current.remainingChunks:0;
 if(current.stage==='complete'||['programme_changed','missing_secret','idle'].includes(current.reason))return {run:false,contract:discoveryContract(current,{nextAction:'stop'})};
 if(current.reason==='chunk_budget'||current.reason==='backoff'||current.stage==='error'||current.retryAt){
  if(due>now)return {run:false,contract:discoveryContract(current,{nextAction:'wait',reason:current.reason||(current.stage==='error'?'error':'backoff')})};
  return {run:true,budget:current.reason==='chunk_budget'?DISCOVERY_CHUNK_BUDGET:Math.max(chunks,1)};
 }
 if(current.stage==='scheduled'||current.stage==='running')return {run:true,budget:Math.min(DISCOVERY_CHUNK_BUDGET,(Number.isInteger(current.remainingChunks)?current.remainingChunks:DISCOVERY_CHUNK_BUDGET-1)+1)};
 if(current.stage==='paused'&&chunks>0)return {run:true,budget:chunks};
 return {run:false,contract:discoveryContract(current,{nextAction:'stop'})};
}
async function saveOwnedContinuation(env,hopId,record){
 const current=await loadJSON(env,CONTINUATION_KEY);
 if(current&&current.hopId!==hopId)return current;
 await saveJSON(env,CONTINUATION_KEY,record);return record;
}
async function queueDiscovery(env,reason){
 const record={stage:'paused',reason,at:new Date().toISOString(),hopId:null,remainingChunks:DISCOVERY_CHUNK_BUDGET,nextCatchUpAt:null,retryAt:null,programmeRunId:null};
 await saveJSON(env,CONTINUATION_KEY,record);return discoveryContract(record,{nextAction:'continue'});
}
async function advanceDiscovery(env,body={}){
 const now=Date.now(),current=await loadJSON(env,CONTINUATION_KEY);
 if(body.chunks===0)return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:discoveryContract(current)};
 const leaseObject=await env.BUCKET.get(DISCOVERY_LEASE_KEY),lease=leaseObject?await leaseObject.json():null;
 if(lease?.expiresAt>now)return {stage:'busy',checked:0,remaining:null,discovery:discoveryContract(current,{state:'busy',nextAction:'wait',reason:'busy',nextCatchUpAt:nextCatchUpAt()})};
 const decision=continuationDecision(current,now);
 const hardWait=current&&(['chunk_budget','backoff'].includes(current.reason)||current.stage==='error'||current.retryAt)&&Date.parse(current.retryAt||current.nextCatchUpAt||0)>now;
 if(!decision.run&&(!body.force||hardWait))return {stage:decision.contract.state,checked:0,remaining:null,discovery:decision.contract};
 if(!env.TMDB_API_READ_ACCESS_TOKEN){
  const record={stage:'error',reason:'missing_secret',at:new Date().toISOString(),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:current?.programmeRunId??null};
  await saveJSON(env,CONTINUATION_KEY,record);return {stage:'missing_secret',checked:0,remaining:null,discovery:discoveryContract(record,{nextAction:'stop'})};
 }
 const acquired=await acquireDiscoveryLease(env);
 if(!acquired)return {stage:'busy',checked:0,remaining:null,discovery:discoveryContract(current,{state:'busy',nextAction:'wait',reason:'busy',nextCatchUpAt:nextCatchUpAt()})};
 const hopId=acquired.id,budget=decision.run?decision.budget:DISCOVERY_CHUNK_BUDGET;
 await saveJSON(env,CONTINUATION_KEY,{stage:'running',reason:null,at:new Date().toISOString(),hopId,remainingChunks:budget,nextCatchUpAt:null,retryAt:null,programmeRunId:current?.programmeRunId??null});
 let result;
 try{
  const report=await loadJSON(env,'programme.json');
  result=report?.films?await resolveDiscoveryChunk(env,report,body.limit||24):{stage:'awaiting_epg_discovery',checked:0,remaining:null};
 }catch(e){result={stage:'error',error:String(e.message).slice(0,120),checked:0,remaining:null};}
 finally{await releaseDiscoveryLease(env,acquired);}
 const at=new Date().toISOString();
 let record;
 if(result.stage==='programme_changed')record={stage:'paused',reason:'programme_changed',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId||null};
 else if(result.stage==='awaiting_epg_discovery')record={stage:'paused',reason:'idle',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:null};
 else if(result.stage==='error')record={stage:'error',reason:result.error||'discovery_failed',at,hopId,remainingChunks:budget,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:current?.programmeRunId??null};
 else if(result.stage==='backoff'||result.retryAt&&!result.checked)record={stage:'paused',reason:'backoff',at,hopId,remainingChunks:budget,nextCatchUpAt:result.retryAt||nextCatchUpAt(),retryAt:result.retryAt||null,programmeRunId:result.programmeRunId??current?.programmeRunId??null};
 else if(result.retryAt)record={stage:'paused',reason:'backoff',at,hopId,remainingChunks:Math.max(0,budget-1),nextCatchUpAt:result.retryAt,retryAt:result.retryAt,programmeRunId:result.programmeRunId??null};
 else if(!result.remaining)record={stage:'complete',reason:null,at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
 else if(budget<=1)record={stage:'paused',reason:'chunk_budget',at,hopId,remainingChunks:0,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:result.programmeRunId??null};
 else record={stage:'paused',reason:null,at,hopId,remainingChunks:budget-1,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
 const saved=await saveOwnedContinuation(env,hopId,record);
 return {...result,discovery:discoveryContract(saved&&saved.hopId===hopId?record:saved)};
}
async function resolveDiscoveryRequest(env,execution,body){
 if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>24))return json({error:'Invalid limit'},400);
 const report=await loadJSON(env,'programme.json');if(!report?.films)return json({error:'No programme'},409);
 return json(await advanceDiscovery(env,{...body,force:body.chunks!==0}));
}
async function discoveryPipelineStatus(env){
 const [source,decisions,catalog,last,queue,continuation,persistedQueue]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json'),queueStatus(env),loadJSON(env,'epg/resolver-continuation.json'),loadJSON(env,predictionQueueKey)]);
 const items=source?.items||[],statuses={},confirmed=new Set();for(const candidate of items){const state=decisions?.[candidate.key];if(state){statuses[state.status]=(statuses[state.status]||0)+1;if(state.status==='verified')confirmed.add(String(state.tmdbId));}}
 const filteredNonMovies=items.filter(c=>nonFilmEPGReason(c.title)||decisions?.[c.key]?.status==='excluded_nonfilm').length,unresolved=items.filter(c=>!nonFilmEPGReason(c.title)&&decisions?.[c.key]?.status!=='verified'&&decisions?.[c.key]?.status!=='excluded_nonfilm').length;
 return {schemaVersion:2,programmeRunId:source?.programmeRunId||null,updatedAt:source?.updatedAt||null,candidates:items.length,rawCandidates:items.length,latestRawCandidates:source?.rawCandidates??null,latestFilteredNonMovies:source?.filteredNonMovies??null,filteredNonMovies,checked:Object.values(statuses).reduce((a,b)=>a+b,0),pending:unresolved,unresolved,ready:items.filter(c=>!nonFilmEPGReason(c.title)&&discoveryReady(c,decisions?.[c.key],Date.now())).length,confirmedFilms:confirmed.size,verifiedFilms:Object.keys(catalog||{}).length,hot:queue?.hotCount??0,cold:queue?.coldCount??0,queuedForPrediction:queue?.pendingCount??0,hotQueuedForPrediction:queue?.priorityCount??0,predicted:queue?.hotPredicted??0,coldWithoutPrediction:queue?.coldWithoutPrediction??0,nextHotPredictions:(persistedQueue?.pending||[]).slice(0,persistedQueue?.priorityCount||0).slice(0,5).map(id=>{const f=Object.values(catalog||{}).find(f=>String(f.id)===id);return {filmId:id,title:f?.title||null,tmdbId:f?.tmdbId||null,hot:f?filmIsHot(f):null,discoveredAt:f?.discoveredAt||null};}),statuses,lastBatch:last||null,continuation:continuation||null};
}
