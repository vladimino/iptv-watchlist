// EPG title resolution is independent of the usage-limited prediction runner.
const DISCOVERY_LEASE_KEY='epg/resolver-lease.json';
function filmIsHot(film,now=Date.now()){
 const from=now-72*3600000,to=now+24*3600000;
 if(Array.isArray(film.shows)&&film.shows.length)return film.shows.some(s=>s.start>=from&&s.start<to);
 // Migration fallback for the older cache, which did not retain actual timeslots.
 return Number.isFinite(film.epgLastAiring)&&film.epgLastAiring>=from&&film.epgLastAiring<to;
}
function candidateIsHot(candidate,now=Date.now()){return filmIsHot({...candidate,epgLastAiring:candidate.lastAiring},now);}
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
function touchCanonicalFilm(film,candidate){
 const shows=[...new Map([...(film.shows||[]),...(candidate.shows||[])].map(s=>[s.channelId+':'+s.start,s])).values()].filter(s=>s.start>=Date.now()-72*3600000);
 const hotEnteredAt=candidateIsHot(candidate)&&!filmIsHot(film)?new Date().toISOString():film.hotEnteredAt;
 return {...film,hotEnteredAt,canonicalIdentity:'tmdb:'+film.tmdbId,aliases:[...new Set([...(film.aliases||[]),candidate.title,...(candidate.rawTitles||[])].filter(Boolean))],shows,epgLastAiring:Math.max(film.epgLastAiring||0,candidate.lastAiring||0)};
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
 let screenedOut=0,knownAliases=0,touched=0;
 // Cheap pass updates availability for known identities even though no new lookup is needed.
 for(const candidate of source.items){const reason=nonFilmEPGReason(candidate.title),decision=decisions[candidate.key];if(reason){if(decision?.status!=='excluded_nonfilm'){decisions[candidate.key]={status:'excluded_nonfilm',reason,checkedAt:startedAt};screenedOut++;}continue;}
  if(candidate.confirmedTmdbId&&!decision){decisions[candidate.key]={status:'verified',filmId:knownTmdb.get(candidate.confirmedTmdbId)||'tmdb_'+candidate.confirmedTmdbId,tmdbId:candidate.confirmedTmdbId,identitySource:'known_epg_alias',checkedAt:startedAt};knownAliases++;}
  const verified=decisions[candidate.key];if(verified?.status==='verified'){const key='tmdb_'+verified.tmdbId,film=films[key];if(film&&candidateIsHot(candidate)){films[key]=touchCanonicalFilm(film,candidate);indexFilm(films[key]);touched++;}}
 }
 if(touched)await saveJSON(env,'epg/discovered-films.json',films);if(screenedOut||knownAliases)await saveJSON(env,'epg/discovery-resolution.json',decisions);
 const now=Date.now(),pending=source.items.filter(c=>discoveryReady(c,decisions[c.key],now)).sort((a,b)=>Number(candidateIsHot(b,now))-Number(candidateIsHot(a,now))||Number(!!b.year)-Number(!!a.year)||b.lastAiring-a.lastAiring||a.key.localeCompare(b.key));
 let checked=0,added=0,reused=0,tmdbCalls=0,error=null,retryAt=null;
 const query=async path=>{tmdbCalls++;return tmdbRequest(env,path);};
 for(const candidate of pending.slice(0,limit)){
  if(Date.now()>deadline||tmdbCalls>=16)break;
  try{
   const matches=[...(aliasIndex.get(candidate.normalizedTitle)?.values()||[])].filter(f=>(!candidate.year||Number(f.year)===Number(candidate.year))&&f.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(f.runtime-d)<=Math.max(8,f.runtime*.08)));
   if(matches.length===1){const film=matches[0],id=knownTmdb.get(String(film.tmdbId))||'tmdb_'+film.tmdbId;if(films[id]){films[id]=touchCanonicalFilm(films[id],candidate);await saveJSON(env,'epg/discovered-films.json',films);}decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(film.tmdbId),canonicalIdentity:'tmdb:'+film.tmdbId,identitySource:candidate.year?'known_alias_year_runtime':'known_alias_unique_runtime',checkedAt:new Date().toISOString()};reused++;}
   else{
    if(tmdbCalls>13)break;let search=null,exact=[];
    for(const language of /[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA']){search=await query('search/movie?'+new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})}));exact=(search.results||[]).filter(m=>[m.title,m.original_title].some(t=>norm(t)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(m.release_date?.slice(0,4))-candidate.year)<=1));if(exact.length)break;}
    let status=exact.length>1?'ambiguous':'no_confident_match';
    if(exact.length===1&&(candidate.year||search.total_pages<=1)){
     const movie=await query('movie/'+exact[0].id+'?language=ru-RU&append_to_response=credits,translations,alternative_titles'),tolerance=candidate.year?Math.max(25,movie.runtime*.2):Math.max(10,movie.runtime*.12);
     if(movie.id===exact[0].id&&movie.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(movie.runtime-d)<=tolerance)){
      status='verified';const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
      if(!knownTmdb.has(String(movie.id))){const people=(entries,prefix)=>(entries||[]).slice(0,10).map(p=>({id:prefix+'/'+p.id,name:p.name,original:p.name})),localized=(movie.translations?.translations||[]).filter(t=>['ru','uk','en'].includes(t.iso_639_1)).map(t=>t.data?.title),alternates=(movie.alternative_titles?.titles||[]).filter(t=>['RU','UA','US','GB'].includes(t.iso_3166_1)).map(t=>t.title),old=films[id];if(!old)added++;
       films[id]=touchCanonicalFilm({...old,discoveredAt:old?.discoveredAt||new Date().toISOString(),id,tmdbId:String(movie.id),url:'https://www.themoviedb.org/movie/'+movie.id,title:movie.title||candidate.title,original:movie.original_title||candidate.title,aliases:[...new Set([...(old?.aliases||[]),movie.title,movie.original_title,...localized,...alternates].filter(Boolean))],year:Number(movie.release_date?.slice(0,4))||candidate.year,genres:(movie.genres||[]).map(g=>g.name),synopsis:movie.overview||candidate.description||null,runtime:movie.runtime,poster:movie.poster_path?'https://image.tmdb.org/t/p/w342'+movie.poster_path:null,directors:people((movie.credits?.crew||[]).filter(p=>p.job==='Director'),'tmdb_director'),actors:people(movie.credits?.cast,'tmdb_actor')},candidate);indexFilm(films[id]);await saveJSON(env,'epg/discovered-films.json',films);
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
 const currentReport=await loadJSON(env,'programme.json');try{await refreshPredictionQueue(env,currentReport||report,'resolver_checkpoint');}catch(e){error=error||'prediction_queue_checkpoint: '+String(e.message).slice(0,100);}
 const ready=source.items.filter(c=>discoveryReady(c,decisions[c.key],Date.now())),summary={schemaVersion:2,stage:error?'partial':ready.length?'partial':'complete',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:ready.length,hotRemaining:ready.filter(c=>candidateIsHot(c)).length,error,retryAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
 await saveJSON(env,'epg/discovery-status.json',summary);return summary;
}
async function continueDiscovery(request,env,execution,result,body={}){
 const chunks=Number.isInteger(body.chunks)?Math.min(12,Math.max(0,body.chunks)):12;
 if(!execution?.waitUntil||chunks===0||!result.remaining||result.retryAt||result.stage==='busy')return {scheduled:false,reason:result.retryAt?'backoff':chunks===0?'chunk_budget':'idle'};
 const authorization=request.headers.get('OAI-Sites-Authorization'),cookie=request.headers.get('Cookie');
 if(!authorization&&!cookie){await saveJSON(env,'epg/resolver-continuation.json',{stage:'error',at:new Date().toISOString(),reason:'site_auth_unavailable',nextCatchUpAt:nextCatchUpAt()});return {scheduled:false,reason:'site_auth_unavailable'};}
 const headers={'Content-Type':'application/json',...(authorization?{'OAI-Sites-Authorization':authorization}:{}),...(cookie?{Cookie:cookie}:{})},url=new URL('/api/enrichment/discovery/resolve',request.url);
 await saveJSON(env,'epg/resolver-continuation.json',{stage:'scheduled',at:new Date().toISOString(),remainingChunks:chunks-1});
 execution.waitUntil((async()=>{try{const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({limit:24,chunks:chunks-1}),redirect:'manual',signal:AbortSignal.timeout(29000)});if(!response.ok)throw new Error('continuation HTTP '+response.status);}catch(e){await saveJSON(env,'epg/resolver-continuation.json',{stage:'error',at:new Date().toISOString(),reason:String(e.message).slice(0,120),nextCatchUpAt:nextCatchUpAt()});}})());
 return {scheduled:true,remainingChunks:chunks-1};
}
async function discoveryPipelineStatus(env){
 const [source,decisions,catalog,last,queue,continuation]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json'),queueStatus(env),loadJSON(env,'epg/resolver-continuation.json')]);
 const items=source?.items||[],statuses={},confirmed=new Set();for(const candidate of items){const state=decisions?.[candidate.key];if(state){statuses[state.status]=(statuses[state.status]||0)+1;if(state.status==='verified')confirmed.add(String(state.tmdbId));}}
 const filteredNonMovies=items.filter(c=>nonFilmEPGReason(c.title)||decisions?.[c.key]?.status==='excluded_nonfilm').length,unresolved=items.filter(c=>!nonFilmEPGReason(c.title)&&decisions?.[c.key]?.status!=='verified'&&decisions?.[c.key]?.status!=='excluded_nonfilm').length;
 return {schemaVersion:2,programmeRunId:source?.programmeRunId||null,updatedAt:source?.updatedAt||null,candidates:items.length,rawCandidates:items.length,latestRawCandidates:source?.rawCandidates??null,latestFilteredNonMovies:source?.filteredNonMovies??null,filteredNonMovies,checked:Object.values(statuses).reduce((a,b)=>a+b,0),pending:unresolved,unresolved,ready:items.filter(c=>discoveryReady(c,decisions?.[c.key],Date.now())).length,confirmedFilms:confirmed.size,verifiedFilms:Object.keys(catalog||{}).length,hot:queue?.hotCount??0,cold:queue?.coldCount??0,queuedForPrediction:queue?.pendingCount??0,hotQueuedForPrediction:queue?.priorityCount??0,predicted:queue?.hotPredicted??0,coldWithoutPrediction:queue?.coldWithoutPrediction??0,statuses,lastBatch:last||null,continuation:continuation||null};
}
