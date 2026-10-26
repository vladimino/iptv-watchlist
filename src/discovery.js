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
const DISCOVERY_ATTEMPT_LIMIT=5;
function candidateEvidence(candidate){const shows=[...(candidate.shows||[])].map(show=>`${show.channelId||''}:${show.start}`).sort(),durations=[...(candidate.durations||[])].filter(Number.isFinite).sort((a,b)=>a-b);return [candidate.normalizedTitle||'',candidate.year||'',durations.join(','),shows.join(',')].join('|');}
function candidateActivity(candidate,now=Date.now()){
 const from=now-72*3600000,to=now+24*3600000,shows=Array.isArray(candidate.shows)?candidate.shows:null,inWindow=!!shows?.some(show=>Number(show.start)>=from&&Number(show.start)<to);
 if(candidate.seenInLatestSnapshot===true)return inWindow?'current':'historical';
 if(candidate.seenInLatestSnapshot==null&&inWindow)return 'current';
 const last=Number(candidate.lastSeenAt??candidate.lastAiring);
 return Number.isFinite(last)&&last<from?'expired':'historical';
}
function resolutionActionability(candidate,decision,now=Date.now()){
 if(candidateActivity(candidate,now)!=='current'||nonFilmEPGReason(candidate.title))return false;
 if(!decision||!['verified','excluded_nonfilm'].includes(decision.status)){
  if(!decision)return true;
  const same=!decision.evidenceKey||decision.evidenceKey===candidateEvidence(candidate);
  if(decision.terminalReason&&same)return false;
  if(decision.retryAt&&Date.parse(decision.retryAt)>now&&same)return false;
  return true;
 }
 return false;
}
function discoveryReady(candidate,decision,now){return resolutionActionability(candidate,decision,now);}
function recordUncertain(decisions,candidate,status,now=Date.now()){
 const evidenceKey=candidateEvidence(candidate),previous=decisions[candidate.key],same=previous?.evidenceKey===evidenceKey,attempts=same?(previous.attempts||0)+1:1,terminal=attempts>=DISCOVERY_ATTEMPT_LIMIT;
 decisions[candidate.key]={status,attempts,evidenceKey,lastAttemptAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),retryAt:terminal?null:new Date(now+Math.min(7,2**(attempts-1))*86400000).toISOString(),terminalReason:terminal?'repeated_uncertain_match':null};
}
function discoveryCounts(items,decisions,now=Date.now()){
 const counts={ledgerTotal:items.length,currentUnresolved:0,readyNow:0,retryBackoff:0,historicalUnresolved:0,ambiguous:0,terminalNoMatch:0,rejectedNonfilm:0,expiredInactive:0};
 for(const candidate of items){
  const decision=decisions?.[candidate.key],activity=candidateActivity(candidate,now);
  if(nonFilmEPGReason(candidate.title)||decision?.status==='excluded_nonfilm'){counts.rejectedNonfilm++;continue;}
  if(decision?.status==='verified')continue;
  if(activity==='expired'){counts.expiredInactive++;continue;}
  if(activity!=='current'){counts.historicalUnresolved++;continue;}
  if(decision?.terminalReason&&(!decision.evidenceKey||decision.evidenceKey===candidateEvidence(candidate))){counts.terminalNoMatch++;continue;}
  counts.currentUnresolved++;
  if(decision?.status==='ambiguous')counts.ambiguous++;
  else if(decision?.retryAt&&Date.parse(decision.retryAt)>now)counts.retryBackoff++;
  else counts.readyNow++;
 }
 return counts;
}
function scoredResolutionMode(env){const value=typeof env?.SCORED_RESOLUTION==='string'?env.SCORED_RESOLUTION.trim():'';return value==='shadow'||value==='on'?value:'off';}
function candidateDiscoveryMode(env){const value=typeof env?.CANDIDATE_DISCOVERY==='string'?env.CANDIDATE_DISCOVERY.trim():'';return value==='shadow'||value==='on'?value:'off';}
function candidateReleaseYear(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
const CANDIDATE_VARIANT_CAP=4,CANDIDATE_VARIANT_CHUNK_CAP=8;
const CANDIDATE_NUMBER_WORDS={1:'один',2:'два',3:'три',4:'четыре',5:'пять',6:'шесть',7:'семь',8:'восемь',9:'девять',10:'десять',11:'одиннадцать',12:'двенадцать'};
function candidateSpellToken(text){
 const token=String(text||'').trim();
 if(!token||/[\s-]/u.test(token)||[...token].length>8)return null;
 if(/э/i.test(token))return token.replace(/э/g,'е').replace(/Э/g,'Е');
 if(/е/i.test(token))return token.replace(/е/g,'э').replace(/Е/g,'Э');
 return null;
}
function candidateSearchVariants(candidate){
 const title=String(candidate?.title||'').trim(),year=candidateReleaseYear(candidate?.year),out=[],seen=new Set();
 const push=(query,yearValue,reason)=>{const text=String(query||'').replace(/\s+/g,' ').trim();if(norm(text).length<3)return;const key=norm(text)+'|'+(yearValue??'');if(seen.has(key))return;seen.add(key);out.push({query:text,year:yearValue,reason});};
 const stem=title.match(/^(.*\p{L}.*)\s+([12])$/u),stemText=stem&&norm(stem[1]).length>=3?stem[1].trim():null;
 if(stemText)push(stemText,year,'part_suffix');
 const spelled=candidateSpellToken(title);if(spelled)push(spelled,year,'spelling_e');
 const stemSpelled=stemText?candidateSpellToken(stemText):null;if(stemSpelled)push(stemSpelled,year,'spelling_e');
 const lead=title.match(/^(\d{1,2})\s+(\p{L}.*)$/u);
 if(lead&&/\p{Script=Cyrillic}/u.test(lead[2])&&CANDIDATE_NUMBER_WORDS[Number(lead[1])])push(CANDIDATE_NUMBER_WORDS[Number(lead[1])]+' '+lead[2],year,'numeral');
 if(year!=null){push(title,year-1,'year_before');push(title,year+1,'year_after');}
 return out;
}
function variantHit(candidate,movie,variant){
 const release=Number(String(movie?.release_date||'').slice(0,4));
 if(candidate?.year&&release&&Math.abs(release-Number(candidate.year))>1)return false;
 const titles=[movie?.title,movie?.original_title].map(norm).filter(Boolean),wanted=[norm(variant?.query),candidate?.normalizedTitle].filter(Boolean);
 if(titles.some(title=>wanted.includes(title)))return true;
 const observed=candidate?.normalizedTitle||'';
 return !!observed&&titles.some(title=>title.startsWith(observed+' ')||observed.startsWith(title+' '));
}
function variantAliasRank(candidate,movies){
 const observed=new Set(norm(candidate?.normalizedTitle||candidate?.title||'').split(' ').filter(Boolean)),durations=[...(candidate?.durations||[]),candidate?.duration].filter(value=>Number.isFinite(value)),year=candidateReleaseYear(candidate?.year);
 return movies.filter(movie=>movie?.id!=null).map(movie=>{
  const release=candidateReleaseYear(String(movie.release_date||'').slice(0,4));
  if(year!=null&&release!=null&&Math.abs(release-year)>1)return null;
  const runtime=Number(movie.runtime),runtimeDistance=Number.isFinite(runtime)&&durations.length?Math.min(...durations.map(value=>Math.abs(runtime-value))):1000;
  const shared=norm((movie.title||'')+' '+(movie.original_title||'')).split(' ').filter(Boolean).filter(token=>observed.has(token)).length;
  return {movie,yearDistance:year!=null&&release!=null?Math.abs(release-year):1,runtimeDistance,shared};
 }).filter(Boolean).sort((a,b)=>a.yearDistance-b.yearDistance||a.runtimeDistance-b.runtimeDistance||b.shared-a.shared||String(a.movie.id).localeCompare(String(b.movie.id)));
}
function emptyVariantStats(){return {calls:0,errors:0,throttled:0,skipped:0,deferred:0,halted:false};}
function variantDiagnostic(stats){return {variantCalls:stats.calls,variantErrors:stats.errors,variantThrottled:stats.throttled,variantSkipped:stats.skipped,variantDeferred:stats.deferred};}
const VARIANT_PENDING_KEY='epg/discovery-variant-pending.json';
function noteVariantFailure(stats,error){stats.calls++;if(error?.retryAt||String(error?.message||'').includes('429')){stats.throttled++;stats.halted=true;return;}stats.errors++;}
function variantBlocked(stats,deadline){return stats.halted||stats.calls>=CANDIDATE_VARIANT_CHUNK_CAP||Date.now()+12000>deadline;}
async function collectVariantProposals(env,candidate,deadline,stats,resumeFrom){
 const proposed=[],hits=[],pool=new Map(),planned=candidateSearchVariants(candidate).slice(0,CANDIDATE_VARIANT_CAP),language=/[іїєґ]/i.test(candidate.title)?'uk-UA':'ru-RU';
 const start=Math.max(0,Math.min(planned.length,Number(resumeFrom?.offset)||0)),savedAliases=[...(resumeFrom?.pendingAliasIds||[])].map(String).filter(Boolean).slice(0,3);
 let resume=null;
 const unfinished=from=>Math.max(0,planned.length-from);
 if(stats.halted){stats.skipped+=unfinished(start)+savedAliases.length;return {proposed,hits,resume:null};}
 const takeAlias=async ids=>{
  const pending=[];
  for(const id of ids){
   if(proposed.some(item=>item.tmdbId===id))continue;
   if(stats.halted)return null;
   if(variantBlocked(stats,deadline)){stats.skipped++;pending.push(id);continue;}
   let movie=null;try{movie=await tmdbRequest(env,'movie/'+id+'?language=ru-RU&append_to_response=translations,alternative_titles');}catch(e){noteVariantFailure(stats,e);if(stats.halted)return null;continue;}
   stats.calls++;
   const aliases=[...(movie?.alternative_titles?.titles||[]).map(item=>item?.title),...(movie?.translations?.translations||[]).map(item=>item?.data?.title)].filter(Boolean),matched=aliases.find(title=>norm(title)===candidate.normalizedTitle);
   if(matched)proposed.push({tmdbId:String(movie.id),query:candidate.title,year:candidateReleaseYear(candidate.year),reason:'tmdb_alias',matchedTitle:matched});
  }
  return stats.halted?null:pending.length?{offset:planned.length,pendingAliasIds:pending}:null;
 };
 if(savedAliases.length){const alias=await takeAlias(savedAliases);if(stats.halted||alias)return {proposed,hits,resume:alias};}
 for(let index=start;index<planned.length;index++){
  if(stats.halted){resume=null;break;}
  if(variantBlocked(stats,deadline)){stats.skipped+=unfinished(index);resume={offset:index,pendingAliasIds:variantAliasRank(candidate,[...pool.values()]).slice(0,3).map(row=>String(row.movie.id)).filter(id=>!proposed.some(item=>item.tmdbId===id))};break;}
  const variant=planned[index];
  let search=null;try{search=await tmdbRequest(env,'search/movie?'+new URLSearchParams({query:variant.query,language,include_adult:'false',...(variant.year!=null?{year:String(variant.year)}:{})}));}catch(e){noteVariantFailure(stats,e);if(stats.halted){stats.skipped+=unfinished(index+1);resume=null;break;}continue;}
  stats.calls++;
  for(const movie of search?.results||[]){
   if(!variantHit(candidate,movie,variant)){if(movie?.id!=null&&!pool.has(String(movie.id)))pool.set(String(movie.id),movie);continue;}
   const exact=['part_suffix','spelling_e','numeral'].includes(variant.reason)?[movie.title,movie.original_title].find(title=>title&&norm(title)===norm(variant.query)):null;
   const claim=exact?{reason:variant.reason,query:variant.query,matched:exact}:null,id=String(movie.id),prior=hits.find(hit=>hit.tmdbId===id);
   if(prior){if(claim){const claims=prior.structuralClaims||[];if(!claims.some(item=>item.reason===claim.reason&&norm(item.matched)===norm(claim.matched)))prior.structuralClaims=[...claims,claim];}for(const title of [movie.title,movie.original_title])if(title&&title!==prior.title&&title!==prior.original&&!(prior.extraTitles||[]).includes(title))prior.extraTitles=[...(prior.extraTitles||[]),title];continue;}
   proposed.push({tmdbId:id,query:variant.query,year:variant.year,reason:variant.reason,matchedTitle:movie.title||movie.original_title||''});
   const hit=searchHitCandidate(movie);if(claim)hit.structuralClaims=[claim];hits.push(hit);
  }
  if(hits.some(hit=>norm(hit.title)===candidate.normalizedTitle||norm(hit.original)===candidate.normalizedTitle))break;
 }
 if(!resume&&!stats.halted){const ranked=variantAliasRank(candidate,[...pool.values()]).slice(0,3).map(row=>String(row.movie.id)).filter(id=>!proposed.some(item=>item.tmdbId===id));resume=await takeAlias(ranked);}
 return {proposed,hits,resume:stats.halted?null:resume};
}
const DISCOVERY_SCORE_PREVIEW_KEY='epg/discovery-score-preview.json';
function filmScorerCandidate(film){return {tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null,runtime:film.runtime??null,trusted:film.canonicalIdentity==='tmdb:'+film.tmdbId};}
function knownScorerCandidates(aliasIndex,candidate){return [...(aliasIndex.get(candidate.normalizedTitle)?.values()||[])].filter(film=>film?.tmdbId).map(filmScorerCandidate);}
function verifiedConfirmation(decision,tmdbId){const id=String(tmdbId);return decision?.status==='verified'&&String(decision.tmdbId)===id?{authority:'verified_decision',tmdbId:id,evidence:{decision:{status:'verified',tmdbId:id,observationKey:decision.observationKey??null}}}:null;}
function discoveryGateFacts(candidate,decision,now){const evidenceKey=candidateEvidence(candidate),same=!decision?.evidenceKey||decision.evidenceKey===evidenceKey;return {eligible:resolutionActionability(candidate,decision,now),activity:candidateActivity(candidate,now),evidenceChanged:!!decision&&!same,terminal:!!(decision?.terminalReason&&same)};}
function detailCompetitors(aliasIndex,candidate,tmdbId,forms=[]){
 const keys=[],seen=new Set();
 const add=value=>{const key=norm(value||'');if(!key||seen.has(key))return;seen.add(key);keys.push(key);};
 add(candidate?.normalizedTitle);for(const form of forms)add(form);
 const films=new Map();
 for(const key of keys)for(const film of aliasIndex.get(key)?.values()||[]){
  if(!film?.tmdbId||String(film.tmdbId)===String(tmdbId)||films.has(String(film.tmdbId)))continue;
  films.set(String(film.tmdbId),{tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null});
 }
 return [...films.values()];
}
function structuralCompetitorForms(score){const form=score?.titleBasis?.structural?.form;return form?[form]:[];}
function tmdbDetailFromMovie(movie){
 const aliases=[...(movie?.alternative_titles?.titles||[]).map(item=>item?.title),...(movie?.translations?.translations||[]).map(item=>item?.data?.title)].filter(Boolean);
 return {authority:'tmdb_detail',tmdbId:movie?.id==null?null:String(movie.id),evidence:{movie:{id:movie?.id??null,title:movie?.title||'',original:movie?.original_title||'',aliases,year:Number(String(movie?.release_date||'').slice(0,4))||null,runtime:movie?.runtime??null}}};
}
function gateScoredCandidate(env,source,candidate,score,decisions,films,now,extra={}){
 const tmdbId=score.acceptedTmdbId==null?null:String(score.acceptedTmdbId),film=tmdbId?films['tmdb_'+tmdbId]||null:null,decision=decisions[candidate.key];
 const durations=[...(candidate.durations||[]),candidate.duration].filter(value=>Number.isFinite(value));
 return acceptScoredIdentity({score,observationKey:candidate.key,pinnedProgrammeRunId:env.epgPin?.programmeRunId||source.programmeRunId||null,observationProgrammeRunId:source.programmeRunId||null,discovery:discoveryGateFacts(candidate,decision,now),film,observation:{normalizedTitle:candidate.normalizedTitle||'',year:candidate.year??null,durations},competitors:extra.competitors||[],tmdbDetail:extra.tmdbDetail||null,confirmation:tmdbId?verifiedConfirmation(decision,tmdbId):null,appliedObservationKeys:decision?.status==='verified'&&String(decision.tmdbId)===tmdbId?[candidate.key]:[]});
}
function recordNeedsVerification(decisions,candidate,score,now=Date.now()){
 const evidenceKey=candidateEvidence(candidate),previous=decisions[candidate.key],same=previous?.status==='needs_verification'&&previous.evidenceKey===evidenceKey,attempts=same?(previous.attempts||0)+1:1,terminal=attempts>=DISCOVERY_ATTEMPT_LIMIT;
 decisions[candidate.key]={status:'needs_verification',attempts,evidenceKey,lastAttemptAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),retryAt:terminal?null:new Date(now+Math.min(7,2**(attempts-1))*86400000).toISOString(),terminalReason:terminal?'awaiting_confirmation':null,scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null}};
}
function scorePreview(candidate,score,gate,legacyStatus,comparison,knownBefore,proposed){const row={observationKey:candidate.key,outcome:gate.outcome,reason:gate.reason,legacyStatus:legacyStatus??null,scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,confidence:score.confidence,score:score.score,acceptedTmdbId:score.acceptedTmdbId}};if(comparison)row.comparison=comparison;if(knownBefore!=null)row.knownBefore=knownBefore;if(proposed?.length)row.proposedCandidates=proposed;if(gate.competingEditions?.length)row.competingEditions=gate.competingEditions;return row;}
function searchHitCandidate(movie){return {tmdbId:String(movie.id),title:movie.title,original:movie.original_title,year:Number(movie.release_date?.slice(0,4))||null,runtime:movie.runtime??null,trusted:false};}
function storedStructuralClaims(row){
 const raw=[...(row?.structuralClaims||[]),...(row?.structural?[row.structural]:[])],out=[],seen=new Set();
 for(const claim of raw){
  if(!claim||!['part_suffix','spelling_e','numeral'].includes(claim.reason)||!claim.query||!claim.matched)continue;
  const key=claim.reason+'|'+norm(claim.matched);
  if(seen.has(key))continue;
  seen.add(key);out.push({reason:claim.reason,query:claim.query,matched:claim.matched});
 }
 return out;
}
function variantScoreHit(row,id){const claims=storedStructuralClaims(row);return {tmdbId:id,title:row.title||'',original:row.original||'',year:row.year??null,runtime:row.runtime??null,trusted:false,...(claims.length?{structuralClaims:claims}:{}),...(row.extraTitles?.length?{extraTitles:[...row.extraTitles]}:{})};}
function shadowComparison({legacyStatus,gate,detailChecked,differentId}){
 if(differentId)return 'different_id';
 const scored=['detail_verified','trusted_acceptance','already_applied'].includes(gate.outcome),legacy=legacyStatus==='verified';
 if(!detailChecked&&gate.scoring?.status==='accepted'&&!scored)return 'detail_not_compared';
 if(legacy&&scored)return 'agree_verified';
 if(legacy&&!scored)return 'legacy_only';
 if(!legacy&&scored)return 'scored_only';
 return 'agree_unresolved';
}
async function scoredSearchCandidates(query,candidate){
 const found=[];
 for(const language of /[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA']){
  const search=await query('search/movie?'+new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})}));
  const exact=(search.results||[]).filter(movie=>[movie.title,movie.original_title].some(title=>norm(title)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(movie.release_date?.slice(0,4))-candidate.year)<=1));
  for(const movie of exact)found.push(searchHitCandidate(movie));
  if(exact.length)break;
 }
 return found;
}
function scorePreviewSummary(preview,cutover,currentProgrammeRunId){
 const previewRun=preview?.programmeRunId??null,current=currentProgrammeRunId??null,stale=!!preview&&previewRun!==current;
 const items=!stale&&preview?.items&&typeof preview.items==='object'?Object.values(preview.items):[];
 const outcomes={needs_verification:0,candidate_decision:0,trusted_acceptance:0,already_applied:0,detail_verified:0,refused:0,other:0},reasons={},comparison={agree_verified:0,legacy_only:0,scored_only:0,agree_unresolved:0,detail_not_compared:0,different_id:0};
 for(const item of items){const outcome=item?.outcome;if(Object.prototype.hasOwnProperty.call(outcomes,outcome))outcomes[outcome]++;else outcomes.other++;if(item?.reason)reasons[item.reason]=(reasons[item.reason]||0)+1;if(Object.prototype.hasOwnProperty.call(comparison,item?.comparison))comparison[item.comparison]++;}
 const mode=cutover==='shadow'||cutover==='on'?cutover:'off';
 return {mode:preview?.mode||null,programmeRunId:previewRun,currentProgrammeRunId:current,stale,rows:items.length,outcomes,reasons,comparison,needsConfirmation:outcomes.needs_verification,cutover:mode};
}
async function saveScorePreview(env,mode,source,preview,fence=null){if(mode==='off')return;if(fence)await fence();await saveJSON(env,DISCOVERY_SCORE_PREVIEW_KEY,{schemaVersion:1,mode,programmeRunId:source.programmeRunId||null,items:preview});}
async function acquireDiscoveryLease(env){
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY),old=object?await object.json():null;
 if(old?.expiresAt>Date.now())return null;
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 return saved===null?null:lease;
}
// AIR-154: a chunk renews its lease immediately before every durable write. Renewal fails as soon as
// another hop holds the lease, so a hop that stalled past the lease TTL cannot write over its successor;
// expiry therefore means the hop has been silent for a whole TTL, which is the quiescence a resume needs.
// The fence is passed into every helper that writes, so each independent write (both catalog copies, the programme
// showing, the prediction-queue checkpoint, the score preview) renews first; the residual window is one storage write
// of the old hop that is already in flight and itself lasts longer than the TTL.
async function renewDiscoveryLease(env,lease){
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY);if(!object)return false;
 const current=await object.json();if(current?.id!==lease.id)return false;
 const next={...current,expiresAt:Date.now()+90000},saved=await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify(next),{onlyIf:{etagMatches:object.etag}});
 if(saved===null)return false;lease.expiresAt=next.expiresAt;return true;
}
const leaseLostError=()=>Object.assign(new Error('resolver lease lost'),{name:'LeaseLostError'});
async function releaseDiscoveryLease(env,lease){const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY);if(!object)return;const current=await object.json();if(current.id===lease.id)await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:object.etag}});}
async function tmdbRequest(env,path){
 if(env.TMDB_REQUEST_INTERVAL_MS!==0)await new Promise(resolve=>setTimeout(resolve,200));
 const response=await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+env.TMDB_API_READ_ACCESS_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
 if(!response.ok){const error=new Error('TMDB HTTP '+response.status);if(response.status===429){error.retryAt=new Date(Date.now()+Math.max(30,Math.min(3600,Number(response.headers.get('Retry-After'))||60))*1000).toISOString();}throw error;}return response.json();
}
function catalogFilmFromDetail(movie,candidate,old,programmeRunId,id){
 const people=(entries,prefix)=>(entries||[]).slice(0,10).map(person=>({id:prefix+'/'+person.id,name:person.name,original:person.name}));
 const localized=(movie.translations?.translations||[]).filter(item=>['ru','uk','en'].includes(item.iso_639_1)).map(item=>item.data?.title);
 const alternates=(movie.alternative_titles?.titles||[]).filter(item=>['RU','UA','US','GB'].includes(item.iso_3166_1)).map(item=>item.title);
 return touchCanonicalFilm({...(old||{}),discoveredAt:old?.discoveredAt||new Date().toISOString(),id,tmdbId:String(movie.id),url:'https://www.themoviedb.org/movie/'+movie.id,title:movie.title||candidate.title,original:movie.original_title||candidate.title,aliases:[...new Set([...(old?.aliases||[]),movie.title,movie.original_title,...localized,...alternates].filter(Boolean))],year:Number(movie.release_date?.slice(0,4))||candidate.year,genres:(movie.genres||[]).map(genre=>genre.name),synopsis:movie.overview||candidate.description||null,runtime:movie.runtime,poster:movie.poster_path?'https://image.tmdb.org/t/p/w342'+movie.poster_path:null,directors:people((movie.credits?.crew||[]).filter(person=>person.job==='Director'),'tmdb_director'),actors:people(movie.credits?.cast,'tmdb_actor')},candidate,programmeRunId);
}
function touchCanonicalFilm(film,candidate,programmeRunId){
 const explicit=Array.isArray(candidate.shows),incoming=explicit?dedupeShows(candidate.shows):null,same=!!programmeRunId&&film.showsProgrammeRunId===programmeRunId;
 const shows=incoming===null?film.shows||[]:same?dedupeShows([...(film.shows||[]),...incoming]):incoming;
 const hotEnteredAt=candidateIsHot(candidate)&&!filmIsHot(film)?new Date().toISOString():film.hotEnteredAt;
 return {...film,hotEnteredAt,canonicalIdentity:'tmdb:'+film.tmdbId,aliases:[...new Set([...(film.aliases||[]),candidate.title,...(candidate.rawTitles||[])].filter(Boolean))],shows,showsProgrammeRunId:explicit&&programmeRunId?programmeRunId:film.showsProgrammeRunId||null,epgLastAiring:Math.max(film.epgLastAiring||0,candidate.lastAiring||0)};
}
async function publishedGenerationMatches(env,seenRunId){
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 return !(generation?.phase==='published'&&seenRunId&&generation.programmeRunId!==seenRunId);
}
async function saveDiscoveredFilms(env,films,seenRunId,fence=null){
 if(typeof env.beforeCatalogWrite==='function'){const hook=env.beforeCatalogWrite;env.beforeCatalogWrite=null;await hook();}
 if(!await publishedGenerationMatches(env,seenRunId))return false;
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 if(generation?.phase==='published'&&generation.programmeRunId===seenRunId){if(fence)await fence();await saveJSON(env,epgGenerationKey(seenRunId,'discovered-films.json'),films);}
 if(fence)await fence();await saveJSON(env,'epg/discovered-films.json',films);return true;
}
async function attachWatchlistShowing(env,seenRunId,filmId,candidate,fence=null){
 if(!await publishedGenerationMatches(env,seenRunId))return false;
 const pinned=await pinEpg(env);
 if(pinned.epgPin?.programmeRunId&&seenRunId&&pinned.epgPin.programmeRunId!==seenRunId)return false;
 const report=await loadJSON(pinned,'programme.json');
 if(!report?.films||(report.runId&&seenRunId&&report.runId!==seenRunId))return false;
 const index=report.films.findIndex(film=>String(film.id)===String(filmId));
 if(index<0)return false;
 const current=report.films[index],next=touchCanonicalFilm(current,candidate,seenRunId);
 next.title=current.title;
 if(!Object.hasOwn(current,'canonicalIdentity'))delete next.canonicalIdentity;
 report.films[index]=next;
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 if(generation?.phase==='published'&&seenRunId&&generation.programmeRunId!==seenRunId)return false;
 if(generation?.phase==='published'&&generation.programmeRunId===seenRunId){
  if(fence)await fence();await saveJSON(env,epgGenerationKey(seenRunId,'programme.json'),report);
  const again=await env.BUCKET.get(EPG_GENERATION_KEY),current=again?await again.json():null;
  if(current?.programmeRunId!==seenRunId||pointer?.etag&&again?.etag!==pointer.etag)return false;
  return true;
 }
 if(fence)await fence();await saveJSON(env,'programme.json',report);return true;
}
async function resolveDiscoveryBatch(env,report,limit=24){
 if(!env.TMDB_API_READ_ACCESS_TOKEN)return {stage:'missing_secret',checked:0,remaining:null};
 const lease=await acquireDiscoveryLease(env);if(!lease)return {stage:'busy',checked:0,remaining:null};
 try{return await resolveDiscoveryChunk(env,report,limit,lease);}finally{await releaseDiscoveryLease(env,lease);}
}
async function resolveDiscoveryChunk(env,report,limit,lease=null){
 const startedAt=new Date().toISOString(),deadline=Date.now()+22000,pinned=await pinEpg(env),hopId=lease?.id??null;
 // Every durable write below, including those inside helpers, is preceded by a lease renewal; a lost lease aborts the chunk before the write.
 const fence=async()=>{if(lease&&!await renewDiscoveryLease(env,lease))throw leaseLostError();};
 const [source,resolution,catalog,last]=await Promise.all([loadJSON(pinned,'epg/discovery-latest.json'),loadJSON(pinned,'epg/discovery-resolution.json'),loadJSON(pinned,'epg/discovered-films.json'),loadJSON(pinned,'epg/discovery-status.json')]);
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
 if(touched||migrated){if(!await saveDiscoveredFilms(env,films,source.programmeRunId,fence))return {schemaVersion:2,stage:'programme_changed',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,currentProgrammeRunId:null};}if(screenedOut||knownAliases){await fence();await saveJSON(env,'epg/discovery-resolution.json',decisions);}
 await fence();await saveJSON(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId||null,hopId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,checkpoint:'cheap_pass'});
 const mode=scoredResolutionMode(env),preview={},shadowDetails=[],now=Date.now(),pending=source.items.filter(c=>resolutionActionability(c,decisions[c.key],now)),hotRank=new Map(pending.map(c=>[c,candidateIsHot(c,now)?1:0]));
 pending.sort((a,b)=>hotRank.get(b)-hotRank.get(a)||Number(!!b.year)-Number(!!a.year)||b.lastAiring-a.lastAiring||a.key.localeCompare(b.key));
 let checked=0,added=0,reused=0,tmdbCalls=0,error=null,retryAt=null,variantMeter=emptyVariantStats();
 const query=async path=>{tmdbCalls++;return tmdbRequest(env,path);};
 const shadowPlans=mode==='shadow'&&candidateDiscoveryMode(env)==='shadow',deferred=[];
 const boundVariantRows=(rows,map,limit=4)=>{const seen=new Set(),out=[];for(const row of rows||[]){const id=row?.tmdbId==null?'':String(row.tmdbId);if(!id||seen.has(id))continue;seen.add(id);out.push(map(row,id));if(out.length>=limit)break;}return out;};
 const mergeVariantHit=(prior,next)=>{
  const claims=[...(prior.structuralClaims||[]),...(next.structuralClaims||[])],seenClaims=new Set();
  prior.structuralClaims=claims.filter(claim=>{const key=claim.reason+'|'+norm(claim.matched);if(seenClaims.has(key))return false;seenClaims.add(key);return true;});
  if(!prior.structuralClaims.length)delete prior.structuralClaims;
  const extras=new Set(prior.extraTitles||[]);
  for(const title of [next.title,next.original,...(next.extraTitles||[])])if(title&&title!==prior.title&&title!==prior.original)extras.add(title);
  if(extras.size)prior.extraTitles=[...extras];
 };
 const boundVariantHits=(rows,limit=4)=>{const byId=new Map(),out=[];for(const row of rows||[]){const id=row?.tmdbId==null?'':String(row.tmdbId);if(!id)continue;const mapped=variantScoreHit(row,id),prior=byId.get(id);if(prior){mergeVariantHit(prior,mapped);continue;}if(out.length>=limit)continue;byId.set(id,mapped);out.push(mapped);}return out;};
 // Shadow keeps the plan, including hits already found and the decision from before the legacy write. retryAt stays put.
 const rememberVariant=(candidate,extra,countSkip)=>{
  if(!shadowPlans||!candidate?.key)return;
  const offset=extra?.offset||0,pendingAliasIds=[...(extra?.pendingAliasIds||[])].map(String).filter(Boolean).slice(0,3);
  const proposals=boundVariantRows(extra?.proposals,(row,id)=>({tmdbId:id,query:row.query||'',year:row.year??null,reason:row.reason||'',matchedTitle:row.matchedTitle||''}));
  const hits=boundVariantHits(extra?.hits);
  const row={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:[...(candidate.durations||[])],evidenceKey:extra?.evidenceKey||candidateEvidence(candidate),priorDecision:extra?.hadPriorDecision?extra.priorDecision??null:null,hadPriorDecision:extra?.hadPriorDecision===true,legacyStatus:extra?.legacyStatus??null,offset,pendingAliasIds,proposals,hits};
  const at=deferred.findIndex(item=>item.key===row.key);
  if(at<0){deferred.push(row);variantMeter.deferred++;}else deferred[at]=row;
  if(countSkip)variantMeter.skipped+=Math.max(0,Math.min(CANDIDATE_VARIANT_CAP,candidateSearchVariants(candidate).length)-offset)+pendingAliasIds.length;
 };
 const settleVariant=async job=>{
  if(!shadowPlans||variantMeter.halted||!job?.candidate)return;
  if(!await publishedGenerationMatches(env,source.programmeRunId)){deferred.length=0;return;}
  const candidate=job.candidate,evidence=candidateEvidence(candidate),live=decisions[candidate.key];
  if((job.evidenceKey&&job.evidenceKey!==evidence)||candidateActivity(candidate)!=='current'||live?.terminalReason&&(!live.evidenceKey||live.evidenceKey===evidence))return;
  if(variantMeter.calls>=CANDIDATE_VARIANT_CHUNK_CAP||Date.now()+12000>deadline){rememberVariant(candidate,job,true);return;}
  const found=await collectVariantProposals(env,candidate,deadline,variantMeter,{offset:job.offset||0,pendingAliasIds:job.pendingAliasIds||[]});
  if(variantMeter.halted)return;
  const proposals=boundVariantRows([...(job.proposals||[]),...(found.proposed||[])],(row,id)=>({tmdbId:id,query:row.query||'',year:row.year??null,reason:row.reason||'',matchedTitle:row.matchedTitle||''}));
  const hits=boundVariantHits([...(job.hits||[]),...(found.hits||[])]);
  if(!proposals.length&&!found.resume)return;
  if(!proposals.length){rememberVariant(candidate,{...job,offset:found.resume.offset,pendingAliasIds:found.resume.pendingAliasIds||[],proposals,hits},false);return;}
  const observation={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:candidate.durations};
  const score=scoreFilmResolution({observation,candidates:[...job.priorCandidates,...hits]});
  let gate=gateScoredCandidate(pinned,source,candidate,score,job.shadowDecisions,job.filmsBefore,now),detailChecked=false,detailAttempted=false;
  if(resolutionActionability(candidate,job.shadowDecisions[candidate.key],now)&&score.status==='accepted'&&score.acceptedTmdbId&&!variantBlocked(variantMeter,deadline)&&await publishedGenerationMatches(env,source.programmeRunId)){
   detailAttempted=true;let movie=null;try{movie=await tmdbRequest(env,'movie/'+score.acceptedTmdbId+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');}catch(e){noteVariantFailure(variantMeter,e);movie=null;if(!variantMeter.halted)detailAttempted=false;}
   if(movie&&!variantMeter.halted){variantMeter.calls++;if(String(movie.id)===String(score.acceptedTmdbId)){gate=gateScoredCandidate(pinned,source,candidate,score,job.shadowDecisions,job.filmsBefore,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:detailCompetitors(aliasIndex,candidate,score.acceptedTmdbId,structuralCompetitorForms(score))});detailChecked=true;}}
  }
  if(variantMeter.halted)return;
  if(found.resume||!detailChecked&&!detailAttempted&&score.status==='accepted'&&score.acceptedTmdbId)rememberVariant(candidate,{...job,offset:found.resume?found.resume.offset:Math.min(CANDIDATE_VARIANT_CAP,candidateSearchVariants(candidate).length),pendingAliasIds:found.resume?.pendingAliasIds||[],proposals,hits},false);
  const knownBefore=!!score.acceptedTmdbId&&job.priorCandidates.some(row=>String(row.tmdbId)===String(score.acceptedTmdbId));
  preview[candidate.key]=scorePreview(candidate,score,gate,job.legacyStatus,shadowComparison({legacyStatus:job.legacyStatus,gate,detailChecked,differentId:false}),knownBefore,proposals);
 };
 try{
 if(shadowPlans){
  const stored=await loadJSON(env,VARIANT_PENDING_KEY);
  if(stored?.programmeRunId===source.programmeRunId&&Array.isArray(stored.jobs)){
   for(const row of stored.jobs){
    if(variantMeter.halted)break;
    const candidate=source.items.find(item=>item.key===row.key);if(!candidate)continue;
    const evidence=candidateEvidence(candidate),live=decisions[candidate.key];
    if((row.evidenceKey&&row.evidenceKey!==evidence)||candidateActivity(candidate)!=='current'||live?.terminalReason&&(!live.evidenceKey||live.evidenceKey===evidence))continue;
    const shadowDecisions={...decisions};if(row.hadPriorDecision)shadowDecisions[candidate.key]=row.priorDecision;else delete shadowDecisions[candidate.key];
    await settleVariant({candidate,priorCandidates:knownScorerCandidates(aliasIndex,candidate),shadowDecisions,filmsBefore:{...films},competitors:detailCompetitors(aliasIndex,candidate,''),legacyStatus:live?.status??row.legacyStatus??null,priorDecision:row.priorDecision??null,hadPriorDecision:row.hadPriorDecision===true,evidenceKey:row.evidenceKey||evidence,offset:row.offset||0,pendingAliasIds:row.pendingAliasIds||[],proposals:row.proposals||[],hits:row.hits||[]});
   }
  }
 }
 for(const candidate of pending.slice(0,limit)){
  if(Date.now()>deadline||tmdbCalls>=16)break;
  let variantJob=null;
  try{
   if(mode==='on'){
    let candidates=knownScorerCandidates(aliasIndex,candidate);
    const observation={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:candidate.durations};
    let score=scoreFilmResolution({observation,candidates});
    let searched=!score.considered.some(row=>row.title.quality===1);
    if(searched)candidates=[...candidates,...await scoredSearchCandidates(query,candidate)],score=scoreFilmResolution({observation,candidates});
    let proposed=[],variantHeld=false;
    if(candidateDiscoveryMode(env)==='on'&&!score.considered.some(row=>row.title.quality===1)){
     if(!variantMeter.halted&&(variantMeter.calls>=CANDIDATE_VARIANT_CHUNK_CAP||Date.now()+12000>deadline)){variantMeter.skipped+=Math.min(CANDIDATE_VARIANT_CAP,candidateSearchVariants(candidate).length);variantHeld=true;}
     else if(!variantMeter.halted){
      const found=await collectVariantProposals(env,candidate,deadline,variantMeter);
      if(!variantMeter.halted&&found.resume)variantHeld=true;
      else if(!variantMeter.halted){proposed=found.proposed;if(found.hits.length)candidates=[...candidates,...found.hits],score=scoreFilmResolution({observation,candidates}),searched=true;}
     }
    }
    let gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now);
    let movie=null;
    if(gate.outcome==='needs_verification'&&score.status==='accepted'&&score.acceptedTmdbId){
     movie=await query('movie/'+score.acceptedTmdbId+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');
     gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:detailCompetitors(aliasIndex,candidate,score.acceptedTmdbId,structuralCompetitorForms(score))});
    }
    preview[candidate.key]=scorePreview(candidate,score,gate,null,null,null,proposed);
    if(variantHeld){/* The optional search did not finish, so this observation stays on the normal queue. */}
    else if(gate.outcome==='candidate_decision')recordUncertain(decisions,candidate,gate.candidateDecision.status,now);
    else if(gate.outcome==='needs_verification')recordNeedsVerification(decisions,candidate,score,now);
    else if(gate.outcome==='detail_verified'){
     const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
     let saved=true;
     if(knownTmdb.has(String(movie.id)))saved=await attachWatchlistShowing(env,source.programmeRunId,id,candidate,fence);
     else{const old=films[id];if(!old)added++;films[id]=catalogFilmFromDetail(movie,candidate,old,source.programmeRunId,id);indexFilm(films[id]);saved=await saveDiscoveredFilms(env,films,source.programmeRunId,fence);}
     if(!saved||!await publishedGenerationMatches(env,source.programmeRunId))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
     decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(movie.id),canonicalIdentity:'tmdb:'+movie.id,identitySource:'tmdb_detail',checkedAt:new Date().toISOString(),evidenceKey:candidateEvidence(candidate),provenance:{authority:'tmdb_detail',searchHit:searched,priorAlias:false,ownerReviewed:false,movieId:String(movie.id),runtime:movie.runtime??null,releaseYear:Number(String(movie.release_date||'').slice(0,4))||null,matchedTitle:candidate.normalizedTitle,programmeRunId:source.programmeRunId||null},scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null}};
    }
   }else{
   const beforeDecision=decisions[candidate.key],priorCandidates=knownScorerCandidates(aliasIndex,candidate),priorFilms={...films},priorCompetitors=detailCompetitors(aliasIndex,candidate,'');
   let searchHits=[],detailMovie=null;
   const matches=[...(aliasIndex.get(candidate.normalizedTitle)?.values()||[])].filter(f=>(!candidate.year||Number(f.year)===Number(candidate.year))&&f.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(f.runtime-d)<=Math.max(8,f.runtime*.08)));
   if(matches.length===1){const film=matches[0],id=knownTmdb.get(String(film.tmdbId))||'tmdb_'+film.tmdbId;if(films[id]){films[id]=touchCanonicalFilm(films[id],candidate,source.programmeRunId);if(!await saveDiscoveredFilms(env,films,source.programmeRunId,fence))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};}decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(film.tmdbId),canonicalIdentity:'tmdb:'+film.tmdbId,identitySource:candidate.year?'known_alias_year_runtime':'known_alias_unique_runtime',checkedAt:new Date().toISOString()};reused++;}
   else{
    if(tmdbCalls>13)break;let search=null,exact=[];
    for(const language of /[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA']){search=await query('search/movie?'+new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})}));exact=(search.results||[]).filter(m=>[m.title,m.original_title].some(t=>norm(t)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(m.release_date?.slice(0,4))-candidate.year)<=1));if(exact.length)break;}
    searchHits=exact.map(searchHitCandidate);
    let status=exact.length>1?'ambiguous':'no_confident_match';
    if(exact.length===1&&(candidate.year||search.total_pages<=1)){
     const movie=await query('movie/'+exact[0].id+'?language=ru-RU&append_to_response=credits,translations,alternative_titles'),tolerance=candidate.year?Math.max(25,movie.runtime*.2):Math.max(10,movie.runtime*.12);detailMovie=movie;
     if(movie.id===exact[0].id&&movie.runtime&&(candidate.durations||[candidate.duration]).some(d=>Math.abs(movie.runtime-d)<=tolerance)){
      status='verified';const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
      if(!knownTmdb.has(String(movie.id))){const old=films[id];if(!old)added++;films[id]=catalogFilmFromDetail(movie,candidate,old,source.programmeRunId,id);indexFilm(films[id]);if(!await saveDiscoveredFilms(env,films,source.programmeRunId,fence))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
      }
      decisions[candidate.key]={status,filmId:id,tmdbId:String(movie.id),canonicalIdentity:'tmdb:'+movie.id,checkedAt:new Date().toISOString()};
     }else status='duration_mismatch';
    }
    if(status!=='verified')recordUncertain(decisions,candidate,status);
   }
   if(mode==='shadow'){
    const observation={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:candidate.durations};
    const shadowDecisions={...decisions};if(beforeDecision===undefined)delete shadowDecisions[candidate.key];else shadowDecisions[candidate.key]=beforeDecision;
    let score=scoreFilmResolution({observation,candidates:[...priorCandidates,...searchHits]});
    const knownBefore=!!score.acceptedTmdbId&&priorCandidates.some(row=>String(row.tmdbId)===String(score.acceptedTmdbId));
    let gate=gateScoredCandidate(pinned,source,candidate,score,shadowDecisions,priorFilms,now),detailChecked=false,differentId=false,needsDetail=false;
    if(score.status==='accepted'&&score.acceptedTmdbId){
     const movie=detailMovie&&String(detailMovie.id)===String(score.acceptedTmdbId)?detailMovie:null;
     if(detailMovie&&!movie)differentId=true;
     if(movie){gate=gateScoredCandidate(pinned,source,candidate,score,shadowDecisions,priorFilms,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:priorCompetitors.filter(row=>String(row.tmdbId)!==String(score.acceptedTmdbId))});detailChecked=true;}
     else needsDetail=true;
    }
    preview[candidate.key]=scorePreview(candidate,score,gate,decisions[candidate.key]?.status||null,needsDetail&&!differentId?'detail_not_compared':shadowComparison({legacyStatus:decisions[candidate.key]?.status||null,gate,detailChecked,differentId}),knownBefore);
    if(needsDetail)shadowDetails.push({key:candidate.key,candidate,score,shadowDecisions,filmsBefore:priorFilms,competitors:priorCompetitors,legacyStatus:decisions[candidate.key]?.status||null,differentId,knownBefore});
    if(candidateDiscoveryMode(env)==='shadow'&&!score.considered.some(row=>row.title.quality===1))variantJob={candidate,priorCandidates,shadowDecisions,filmsBefore:priorFilms,competitors:priorCompetitors,legacyStatus:decisions[candidate.key]?.status||null,priorDecision:beforeDecision===undefined?null:beforeDecision,hadPriorDecision:beforeDecision!==undefined,evidenceKey:candidateEvidence(candidate),offset:0,pendingAliasIds:[]};
   }
   }
   // A film is committed before its decision. A crash between writes is repaired by alias reuse.
   await fence();await saveJSON(env,'epg/discovery-resolution.json',decisions);checked++;
   if(variantJob)await settleVariant(variantJob);
  }catch(e){if(e?.name==='LeaseLostError')throw e;error=String(e.message).slice(0,120);retryAt=e.retryAt||new Date(Date.now()+60000).toISOString();break;}
 }
 for(const job of shadowDetails){
  if(Date.now()+12000>deadline)continue;
  let movie=null;try{movie=await tmdbRequest(env,'movie/'+job.score.acceptedTmdbId+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');}catch(e){continue;}
  if(!movie||String(movie.id)!==String(job.score.acceptedTmdbId))continue;
  const gate=gateScoredCandidate(pinned,source,job.candidate,job.score,job.shadowDecisions,job.filmsBefore,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:detailCompetitors(aliasIndex,job.candidate,job.score.acceptedTmdbId,structuralCompetitorForms(job.score))});
  preview[job.key]=scorePreview(job.candidate,job.score,gate,job.legacyStatus,shadowComparison({legacyStatus:job.legacyStatus,gate,detailChecked:true,differentId:job.differentId}),job.knownBefore);
 }
 const currentReport=await loadJSON(env,'programme.json');
 if(source.programmeRunId&&currentReport?.runId&&currentReport.runId!==source.programmeRunId){
  const changed={schemaVersion:2,stage:'partial',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:source.items.filter(c=>!nonFilmEPGReason(c.title)&&discoveryReady(c,decisions[c.key],Date.now())).length,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,programmeChanged:true,...variantDiagnostic(variantMeter)};
  await fence();await saveJSON(env,'epg/discovery-status.json',changed);await saveScorePreview(env,mode,source,preview,fence);return {...changed,stage:'programme_changed',currentProgrammeRunId:currentReport.runId};
 }
 try{await refreshPredictionQueue(env,currentReport||report,'resolver_checkpoint',fence);}catch(e){if(e?.name==='LeaseLostError')throw e;error=error||'prediction_queue_checkpoint: '+String(e.message).slice(0,100);}
 const persistedDecisions=error?await loadJSON(env,'epg/discovery-resolution.json')||{}:decisions,ready=source.items.filter(c=>resolutionActionability(c,persistedDecisions[c.key],Date.now())),variantPending=deferred.length,summary={schemaVersion:2,stage:error?'partial':ready.length||variantPending?'partial':'complete',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:reused+knownAliases,touched,tmdbCalls,added,remaining:ready.length,variantPending,hotRemaining:ready.filter(c=>candidateIsHot(c)).length,error,retryAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,...variantDiagnostic(variantMeter)};
 await fence();await saveJSON(env,'epg/discovery-status.json',summary);await saveScorePreview(env,mode,source,preview,fence);return summary;
 }finally{if(shadowPlans){await fence();await saveJSON(env,VARIANT_PENDING_KEY,{schemaVersion:1,programmeRunId:source.programmeRunId||null,jobs:deferred});}}
}
// One request runs one chunk. A later HTTP request is not a new isolate; confirm the memory hypothesis in production after deploy. Do not schedule the next chunk with waitUntil.
const DISCOVERY_CHUNK_BUDGET=12;
const CONTINUATION_KEY='epg/resolver-continuation.json';
// AIR-151: read-only diagnostics of the continuation boundary. Every POST /api/sync/epg step and
// every discovery resolve request leaves one bounded entry (codes, counts, timestamps; no tokens,
// titles or payloads) so that "the call never arrived" and "the call arrived but saved no chunk"
// can be told apart from pipeline status. The same entry goes to the Worker log. Nothing here
// retries, dispatches or changes the resolver.
const CONTINUATION_DIAGNOSTICS_KEY='epg/resolver-continuation-diagnostics.json';
const CONTINUATION_DIAGNOSTICS_LIMIT=20;
// Closed vocabularies. A value outside its list is recorded as `other`; free text never enters an entry
// or a log line. Ids must be server-generated UUIDs, times must parse, counts must be finite numbers.
const DIAGNOSTIC_VOCABULARY={
 caller:['http','mcp','internal'],
 route:['/api/sync/metadata','/api/sync/epg','/api/enrichment/discovery/resolve'],
 runStage:['metadata','epg','complete'],
 stage:['idle','paused','running','complete','error','busy','partial','programme_changed','awaiting_epg_discovery','backoff','missing_secret'],
 nextAction:['continue','wait','stop'],
 reason:['epg_committed','scan_committed','busy','chunk_budget','backoff','programme_changed','idle','missing_secret','error','discovery_failed','orphaned'],
 errorName:['Error','TypeError','RangeError','SyntaxError','ReferenceError','AbortError','TimeoutError'],
};
function diagnosticCode(list,value,fallback='other'){return value==null?null:list.includes(value)?value:fallback;}
function diagnosticId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;}
function diagnosticTime(value){return typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value))?value:null;}
function diagnosticCount(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
// Classifies a thrown error into one of seven codes. The message is matched, never copied.
function diagnosticErrorCode(error){
 const name=String(error?.name||''),message=String(error?.message||'');
 if(name==='AbortError'||name==='TimeoutError'||/timed? ?out/i.test(message))return 'timeout';
 if(/generation changed/i.test(message))return 'publish_conflict';
 if(/resolver is writing|lease lost/i.test(message))return 'resolver_busy';
 if(/\br2\b|bucket|storage|etag/i.test(message))return 'storage';
 if(/tmdb|fetch|http\s?\d{3}|upstream|network|socket|dns/i.test(message))return 'upstream';
 if(name==='SyntaxError'||/invalid|not found|required|unexpected/i.test(message))return 'invalid_input';
 return 'unknown';
}
function diagnosticError(error){return {code:diagnosticErrorCode(error),name:diagnosticCode(DIAGNOSTIC_VOCABULARY.errorName,String(error?.name||'Error'),'Error')};}
// A continuation `reason` outside the vocabulary is the thrown message an error record kept; it is
// classified like an error, not copied.
function diagnosticReason(value){return value==null?null:DIAGNOSTIC_VOCABULARY.reason.includes(value)?value:diagnosticErrorCode({message:String(value)});}
function continuationSummary(record){return record&&typeof record==='object'?{stage:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,record.stage),reason:diagnosticReason(record.reason),remainingChunks:diagnosticCount(record.remainingChunks),programmeRunId:diagnosticId(record.programmeRunId),at:diagnosticTime(record.at),nextCatchUpAt:diagnosticTime(record.nextCatchUpAt),retryAt:diagnosticTime(record.retryAt),hopId:diagnosticId(record.hopId)}:null;}
function discoverySummary(contract){return contract&&typeof contract==='object'?{state:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,contract.state),nextAction:diagnosticCode(DIAGNOSTIC_VOCABULARY.nextAction,contract.nextAction),reason:diagnosticReason(contract.reason),remainingChunks:diagnosticCount(contract.remainingChunks),programmeRunId:diagnosticId(contract.programmeRunId),nextCatchUpAt:diagnosticTime(contract.nextCatchUpAt),retryAt:diagnosticTime(contract.retryAt)}:null;}
function chunkSummary(result){return {stage:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,result.stage),checked:diagnosticCount(result.checked),remaining:diagnosticCount(result.remaining),added:diagnosticCount(result.added),variantPending:typeof result.variantPending==='boolean'?result.variantPending:diagnosticCount(result.variantPending),retryAt:diagnosticTime(result.retryAt),programmeRunId:diagnosticId(result.programmeRunId),error:result.error?diagnosticErrorCode({message:String(result.error)}):null};}
// One structured line per phase for Workers Logs; never throws.
function observeContinuation(step){try{console.log(JSON.stringify({event:'epg_continuation',...step}));}catch{}}
// A step entry. `runId` is kept only when it has the server-generated UUID shape; `runIdShape` says
// what the caller sent. `recorded` holds the result of each best-effort ring write: the stored entry
// can only carry `entered`, the final log line carries both.
function continuationStep(caller,route,runId){
 const id=diagnosticId(runId);
 return {id:crypto.randomUUID(),at:new Date().toISOString(),phase:'entered',caller:diagnosticCode(DIAGNOSTIC_VOCABULARY.caller,caller||'http','http'),route:diagnosticCode(DIAGNOSTIC_VOCABULARY.route,route),runId:id,runIdShape:runId==null?null:id?'uuid':'invalid',runStage:null,branch:null,httpStatus:null,discovery:null,diagnostic:{},error:null,durationMs:null,recorded:{entered:null,outcome:null}};
}
// Upserts the entry by id into a bounded ring (newest first). Best effort: a failed write never fails the step.
async function recordContinuationDiagnostic(env,entry){
 for(let attempt=0;attempt<2;attempt++){
  try{
   const object=await env.BUCKET.get(CONTINUATION_DIAGNOSTICS_KEY),current=object?await object.json():null;
   const recent=[entry,...(Array.isArray(current?.recent)?current.recent:[]).filter(item=>item?.id!==entry.id)].slice(0,CONTINUATION_DIAGNOSTICS_LIMIT);
   const saved=await env.BUCKET.put(CONTINUATION_DIAGNOSTICS_KEY,JSON.stringify({schemaVersion:1,updatedAt:entry.at,recent}),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
   if(saved!==null)return true;
  }catch{return false;}
 }
 return false;
}
// The `entered` log line is the arrival evidence and goes out before any storage access; the ring write
// that follows is best effort and its result is kept in `recorded.entered`.
async function openContinuationStep(env,step,persist){observeContinuation(step);if(persist)step.recorded.entered=await recordContinuationDiagnostic(env,step);return step;}
// Outcome fields, then the outcome write, then the final log line carrying both write results.
async function closeContinuationStep(env,step,started,response,error,persist){
 step.durationMs=Date.now()-started;
 if(error){step.phase='failed';step.error=diagnosticError(error);step.httpStatus=step.httpStatus??502;}
 else{step.phase='completed';step.httpStatus=response?.status??step.httpStatus??null;}
 if(persist)step.recorded.outcome=await recordContinuationDiagnostic(env,step);
 observeContinuation(step);
}
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
 // AIR-154: a running record is resumed with the budget its hop still had. continuationHealth has already
 // settled the record when that hop's chunk finished, so a completed chunk is never counted twice.
 if(current.stage==='running')return {run:true,budget:Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,chunks))};
 if(current.stage==='scheduled')return {run:true,budget:Math.min(DISCOVERY_CHUNK_BUDGET,(Number.isInteger(current.remainingChunks)?current.remainingChunks:DISCOVERY_CHUNK_BUDGET-1)+1)};
 if(current.stage==='paused'&&chunks>0)return {run:true,budget:chunks};
 return {run:false,contract:discoveryContract(current,{nextAction:'stop'})};
}
// AIR-154: continuation reads carry the object etag so that every write below is a compare-and-swap.
// A hop that lost the record (another hop replaced it, or the record moved while this call waited for
// the lease) never overwrites the newer checkpoint.
// `etag` is the precondition for the next write: the object's etag, `null` for a missing object (the write
// then requires absence), or `undefined` when the store returned an object without an etag (no
// precondition is possible, so the write is plain; R2 always supplies one).
async function readContinuation(env){const object=await env.BUCKET.get(CONTINUATION_KEY);return {record:object?await object.json():null,etag:object?(object.etag||undefined):null};}
async function replaceContinuation(env,record,etag){const saved=await env.BUCKET.put(CONTINUATION_KEY,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},...(etag===undefined?{}:{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});return saved!==null;}
// Writes the hop's checkpoint only while the record still names that hop. The result says whether the
// write happened: `saved: false` with `reason: other_hop` when another hop owns the record, or
// `reason: write_conflict` when both conditional writes were rejected; the caller must not report
// an unsaved checkpoint as stored.
async function saveOwnedContinuation(env,hopId,record){
 let current=await readContinuation(env);
 for(let attempt=0;attempt<2;attempt++){
  if(current.record&&current.record.hopId!==hopId)return {saved:false,reason:'other_hop',record:current.record};
  if(await replaceContinuation(env,record,current.etag))return {saved:true,reason:null,record};
  current=await readContinuation(env);
 }
 if(current.record&&current.record.hopId!==hopId)return {saved:false,reason:'other_hop',record:current.record};
 return {saved:false,reason:'write_conflict',record:current.record};
}
// A `running` record is a live writer only while the resolver lease it named is unexpired. Afterwards it
// is an orphan: its hop did not reach its checkpoint. The most likely cause is an interrupted invocation
// (a thrown handler normally leaves an `error` record), but a failure in the lease release, in the
// checkpoint write itself or in the best-effort diagnostics write leaves the same picture, so the cause
// of any one orphan is an inference, not a proven fact. Whether the hop's chunk finished is read from
// the persisted discovery status, and only when that status names the same hop (`hopId`), the same
// programme generation and a start after the record was opened: the status object is shared, so a
// newer status from another hop or an unmarked status must not be attributed to this hop. In that case
// the chunk is simply run again with the budget the hop had; its decisions are idempotent.
const CONTINUATION_HEALTH=['idle','settled','live','orphaned'];
function continuationHealth(record,lease,last,now,published){
 const hopId=diagnosticId(record?.hopId);
 if(!record||record.stage!=='running')return {status:record?'settled':'idle',hopId,lease:null,leaseHop:null,leaseExpiresAt:null,chunkCompleted:null,resumeBudget:null,generationConflict:null};
 const live=!!lease&&lease.expiresAt>now,leaseHop=lease?(lease.id===record.hopId?'same':'other'):null;
 const leaseExpiresAt=Number.isFinite(lease?.expiresAt)&&lease.expiresAt>0?new Date(lease.expiresAt).toISOString():null;
 const generationConflict=!!(published&&record.programmeRunId&&published!==record.programmeRunId);
 if(live)return {status:'live',hopId,lease:'live',leaseHop,leaseExpiresAt,chunkCompleted:null,resumeBudget:null,generationConflict};
 const openedAt=Date.parse(record.at||''),startedAt=Date.parse(last?.startedAt||'');
 const chunkCompleted=typeof last?.finishedAt==='string'&&!!record.hopId&&last.hopId===record.hopId&&!!record.programmeRunId&&last.programmeRunId===record.programmeRunId&&(!published||published===record.programmeRunId)&&Number.isFinite(openedAt)&&Number.isFinite(startedAt)&&startedAt>=openedAt;
 const budget=Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,Number.isInteger(record.remainingChunks)?record.remainingChunks:1));
 return {status:'orphaned',hopId,lease:lease?'expired':'none',leaseHop,leaseExpiresAt,chunkCompleted,resumeBudget:chunkCompleted?budget-1:budget,generationConflict};
}
function healthSummary(health){return {status:diagnosticCode(CONTINUATION_HEALTH,health.status),hopId:health.hopId,lease:diagnosticCode(['live','expired','none'],health.lease),leaseHop:diagnosticCode(['same','other'],health.leaseHop),leaseExpiresAt:diagnosticTime(health.leaseExpiresAt),chunkCompleted:typeof health.chunkCompleted==='boolean'?health.chunkCompleted:null,resumeBudget:diagnosticCount(health.resumeBudget),generationConflict:typeof health.generationConflict==='boolean'?health.generationConflict:null};}
// What the discovery contract says about a running record: wait for a live writer until its lease expires,
// continue (one explicit call settles or resumes it) when the writer is gone.
function runningOverride(health){
 if(health.status==='live')return {state:'running',reason:'busy',nextAction:'wait',nextCatchUpAt:health.leaseExpiresAt||nextCatchUpAt()};
 if(health.status==='orphaned')return {state:'running',reason:'orphaned',nextAction:'continue',remainingChunks:health.resumeBudget,nextCatchUpAt:null};
 return {};
}
// The checkpoint a hop writes after its chunk, from the chunk result and the budget the hop had.
function continuationAfterChunk(result,budget,hopId,at,programmeRunId){
 if(result.stage==='programme_changed')return {stage:'paused',reason:'programme_changed',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId||null};
 if(result.stage==='awaiting_epg_discovery')return {stage:'paused',reason:'idle',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:programmeRunId??null};
 if(result.stage==='error')return {stage:'error',reason:result.error||'discovery_failed',at,hopId,remainingChunks:budget,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:programmeRunId??null};
 if(result.stage==='backoff'||result.retryAt&&!result.checked)return {stage:'paused',reason:'backoff',at,hopId,remainingChunks:budget,nextCatchUpAt:result.retryAt||nextCatchUpAt(),retryAt:result.retryAt||null,programmeRunId:result.programmeRunId??programmeRunId??null};
 if(result.retryAt)return {stage:'paused',reason:'backoff',at,hopId,remainingChunks:Math.max(0,budget-1),nextCatchUpAt:result.retryAt,retryAt:result.retryAt,programmeRunId:result.programmeRunId??null};
 if(result.variantPending)return budget<=1?{stage:'paused',reason:'chunk_budget',at,hopId,remainingChunks:0,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:result.programmeRunId??null}:{stage:'paused',reason:null,at,hopId,remainingChunks:budget-1,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
 if(!result.remaining)return {stage:'complete',reason:null,at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
 if(budget<=1)return {stage:'paused',reason:'chunk_budget',at,hopId,remainingChunks:0,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:result.programmeRunId??null};
 return {stage:'paused',reason:null,at,hopId,remainingChunks:budget-1,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
}
const busyOutcome=(record,trace,nextCatchUp)=>({stage:'busy',checked:0,remaining:null,discovery:discoveryContract(record,{state:'busy',nextAction:'wait',reason:'busy',nextCatchUpAt:nextCatchUp||nextCatchUpAt()}),diagnostic:trace});
// Opens the discovery series for a committed generation. The record names that generation so that a later
// call can tell a checkpoint of the published generation from one left behind by an earlier generation.
// The write is fenced three ways: a request for a generation that is no longer the published one is
// refused (a commit that paused after its programme write and resumed after a newer publication must
// not roll the newer series back); a stored series of the same generation is kept with its progress (a
// re-entered commit is idempotent, only its `programme_changed` artefact is replaced); a live writer keeps
// its `running` record (its own checkpoint pins the generation it read). The write itself is a
// compare-and-swap against the record read here; a concurrent writer wins. The returned contract is
// always that of the record left in place.
async function queueDiscovery(env,reason,programmeRunId=null){
 const now=Date.now(),record={stage:'paused',reason,at:new Date(now).toISOString(),hopId:null,remainingChunks:DISCOVERY_CHUNK_BUDGET,nextCatchUpAt:null,retryAt:null,programmeRunId:programmeRunId||null};
 const [stored,lease,generation]=await Promise.all([readContinuation(env),loadJSON(env,DISCOVERY_LEASE_KEY),loadJSON(env,EPG_GENERATION_KEY)]);
 const published=generation?.phase==='published'?generation.programmeRunId||null:null,current=stored.record;
 const kept=()=>current?discoveryContract(current,current.stage==='running'?runningOverride(continuationHealth(current,lease,null,now,published)):{}):discoveryContract(record,{nextAction:'continue'});
 if(programmeRunId&&published&&programmeRunId!==published)return kept();
 if(current?.stage==='running'&&lease?.expiresAt>now)return kept();
 if(programmeRunId&&current?.programmeRunId===programmeRunId&&current.reason!=='programme_changed')return kept();
 if(await replaceContinuation(env,record,stored.etag))return discoveryContract(record,{nextAction:'continue'});
 const after=(await readContinuation(env)).record;return after?discoveryContract(after):discoveryContract(record,{nextAction:'continue'});
}
// Whether the stored checkpoint belongs to the published generation. A record pinned to another generation
// (an orphan, a finished or paused series, a programme-changed stop) or a `programme_changed` record of the
// published generation itself (written while the publication was still copying) is superseded by a new
// series for the published generation once that generation is in place: the pointer names it and the shared
// programme already carries it (`recover`). Until the copy has landed nothing is replaced (`pending`). A live
// writer is never superseded, and a record without a generation pin cannot be judged and is left alone.
function generationHandoff(record,health,published,report){
 if(!published||!record||health.status==='live')return null;
 const other=!!record.programmeRunId&&record.programmeRunId!==published,contradictory=record.reason==='programme_changed'&&record.programmeRunId===published;
 if(!other&&!contradictory)return null;
 return report?.runId===published?'recover':'pending';
}
// `body.trace`, when a caller passes an object, is filled with the branch taken and every intermediate
// outcome (AIR-151). The same object is returned as `diagnostic`. It changes no decision.
async function advanceDiscovery(env,body={}){
 const now=Date.now(),trace=body.trace&&typeof body.trace==='object'?body.trace:{};
 trace.branch=null;trace.entry=null;trace.lease=null;trace.health=null;trace.recovery=null;trace.decision=null;trace.hopId=null;trace.budget=null;trace.chunk=null;trace.saved=null;
 let stored=await readContinuation(env),current=stored.record;
 trace.entry=continuationSummary(current);
 const leaseObject=await env.BUCKET.get(DISCOVERY_LEASE_KEY),lease=leaseObject?await leaseObject.json():null;
 trace.lease=lease?.expiresAt>now?'live':lease?'expired':'none';
 const running=current?.stage==='running';
 const [last,generation,report]=await Promise.all([running?loadJSON(env,'epg/discovery-status.json'):null,loadJSON(env,EPG_GENERATION_KEY),loadJSON(env,'programme.json')]);
 const published=generation?.phase==='published'?generation.programmeRunId||null:null;
 let health=continuationHealth(current,lease,last,now,published);
 trace.health=healthSummary(health);
 if(body.chunks===0){trace.branch='report_only';return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:discoveryContract(current,runningOverride(health)),diagnostic:trace};}
 if(lease?.expiresAt>now){trace.branch='lease_live';return busyOutcome(current,trace,health.leaseExpiresAt);}
 // Generation handoff: a checkpoint that does not belong to the published generation is superseded by a new
 // series for that generation (the checkpoint the commit would have queued), atomically against the record
 // read above. The superseded record's hop is never resumed and its decisions and statuses stay as written.
 const handoff=generationHandoff(current,health,published,report);
 if(handoff==='pending'){
  trace.branch='generation_pending';
  trace.recovery={orphanHopId:health.hopId,action:'generation_pending',chunkCompleted:health.chunkCompleted,budget:0,settled:false,superseded:diagnosticId(current.programmeRunId)};
  return {stage:current.stage,checked:0,remaining:null,discovery:discoveryContract(current,{state:current.stage==='running'?'running':current.stage,nextAction:'wait',nextCatchUpAt:nextCatchUpAt()}),diagnostic:trace};
 }
 if(handoff==='recover'){
  trace.branch='generation_handoff';
  const record={stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:DISCOVERY_CHUNK_BUDGET,nextCatchUpAt:null,retryAt:null,programmeRunId:published};
  const replaced=await replaceContinuation(env,record,stored.etag);
  trace.recovery={orphanHopId:health.hopId,action:'generation_recovered',chunkCompleted:health.chunkCompleted,budget:DISCOVERY_CHUNK_BUDGET,settled:replaced,superseded:diagnosticId(current.programmeRunId)};
  if(!replaced){trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
  trace.saved={...continuationSummary(record),owned:true,write:'saved'};
  stored=await readContinuation(env);current=stored.record;health=continuationHealth(current,lease,null,now,published);
 }
 if(health.status==='orphaned'){
  // AIR-154: settle the orphan atomically against the record we read; a concurrent writer wins and we wait.
  const at=new Date().toISOString(),budget=Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,Number.isInteger(current.remainingChunks)?current.remainingChunks:1));
  if(health.chunkCompleted){
   const record=continuationAfterChunk(last.programmeChanged?{...last,stage:'programme_changed'}:last,budget,current.hopId,at,current.programmeRunId);
   const settled=await replaceContinuation(env,record,stored.etag);
   trace.recovery={orphanHopId:health.hopId,action:'settled',chunkCompleted:true,budget:health.resumeBudget,settled};
   if(!settled){trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
   trace.saved={...continuationSummary(record),owned:true,write:'saved'};
   stored=await readContinuation(env);current=stored.record;
  }
  else trace.recovery={orphanHopId:health.hopId,action:'resumed',chunkCompleted:false,budget:health.resumeBudget,settled:false};
 }
 const decision=continuationDecision(current,now);
 const hardWait=current&&(['chunk_budget','backoff'].includes(current.reason)||current.stage==='error'||current.retryAt)&&Date.parse(current.retryAt||current.nextCatchUpAt||0)>now;
 trace.decision={run:decision.run,budget:decision.run?decision.budget:null,force:!!body.force,hardWait:!!hardWait,nextAction:decision.run?null:decision.contract.nextAction};
 if(!decision.run&&(!body.force||hardWait)){trace.branch=trace.recovery?.settled&&trace.recovery.action==='settled'?'orphan_settled':'contract';return {stage:decision.contract.state,checked:0,remaining:null,discovery:decision.contract,diagnostic:trace};}
 if(!env.TMDB_API_READ_ACCESS_TOKEN){
  trace.branch='missing_secret';
  const record={stage:'error',reason:'missing_secret',at:new Date().toISOString(),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:current?.programmeRunId??null};
  await saveJSON(env,CONTINUATION_KEY,record);trace.saved={...continuationSummary(record),owned:true};return {stage:'missing_secret',checked:0,remaining:null,discovery:discoveryContract(record,{nextAction:'stop'}),diagnostic:trace};
 }
 const acquired=await acquireDiscoveryLease(env);
 if(!acquired){trace.branch='lease_lost';return busyOutcome(current,trace);}
 // AIR-154 fence: the decision was made on the record read before the lease; another hop may have moved
 // it meanwhile. A changed record is not ours to continue from, so the lease is released and we wait.
 const fresh=await readContinuation(env);
 if(fresh.etag!==stored.etag){await releaseDiscoveryLease(env,acquired);trace.branch='record_changed';trace.saved={...continuationSummary(fresh.record),owned:false,write:'other_hop'};return busyOutcome(fresh.record,trace);}
 const hopId=acquired.id,budget=decision.run?decision.budget:DISCOVERY_CHUNK_BUDGET;
 trace.branch='chunk';trace.hopId=hopId;trace.budget=budget;
 // The running record names the generation the chunk will pin to, so a later orphan check can match it.
 const programmeRunId=current?.programmeRunId??published??null;
 const opened=await replaceContinuation(env,{stage:'running',reason:null,at:new Date().toISOString(),hopId,remainingChunks:budget,nextCatchUpAt:null,retryAt:null,programmeRunId},fresh.etag);
 if(!opened){await releaseDiscoveryLease(env,acquired);trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
 let result;
 try{
  result=report?.films?await resolveDiscoveryChunk(env,report,body.limit||24,acquired):{stage:'awaiting_epg_discovery',checked:0,remaining:null};
 }catch(e){result={stage:'error',error:String(e.message).slice(0,120),checked:0,remaining:null};}
 finally{await releaseDiscoveryLease(env,acquired);}
 trace.chunk=chunkSummary(result);
 const record=continuationAfterChunk(result,budget,hopId,new Date().toISOString(),programmeRunId);
 const outcome=await saveOwnedContinuation(env,hopId,record);
 const kept=outcome.saved?record:outcome.record;
 trace.saved={...continuationSummary(kept),owned:outcome.saved,write:outcome.saved?'saved':outcome.reason};
 // An unsaved checkpoint of a record that still names this hop is an orphan the next call settles from the
 // hop-marked status; the contract says so instead of claiming the checkpoint was stored.
 const contract=outcome.saved?discoveryContract(record):kept?.stage==='running'&&kept.hopId===hopId?discoveryContract(kept,{state:'running',reason:'orphaned',nextAction:'continue',remainingChunks:Math.max(0,budget-1),nextCatchUpAt:null}):discoveryContract(kept);
 return {...result,discovery:contract,diagnostic:trace};
}
async function resolveDiscoveryRequest(env,execution,body,caller='http'){
 const started=Date.now(),step=continuationStep(caller,'/api/enrichment/discovery/resolve',null);
 await openContinuationStep(env,step,true);
 let response;
 try{
  if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>24)){step.branch='invalid_limit';response=json({error:'Invalid limit'},400);}
  else{
   const report=await loadJSON(env,'programme.json');
   if(!report?.films){step.branch='no_programme';response=json({error:'No programme'},409);}
   else{step.branch='resolve';const outcome=await advanceDiscovery(env,{...body,force:body.chunks!==0,trace:step.diagnostic});step.discovery=discoverySummary(outcome.discovery);response=json(outcome);}
  }
 }catch(e){await closeContinuationStep(env,step,started,null,e,true);throw e;}
 await closeContinuationStep(env,step,started,response,null,true);
 return response;
}
async function discoveryPipelineStatus(env){
 const pinned=await pinEpg(env);
 const [source,decisions,catalog,last,queue,continuation,persistedQueue,scorePreview,continuationDiagnostics,lease]=await Promise.all([loadJSON(pinned,'epg/discovery-latest.json'),loadJSON(pinned,'epg/discovery-resolution.json'),loadJSON(pinned,'epg/discovered-films.json'),loadJSON(pinned,'epg/discovery-status.json'),queueStatus(env),loadJSON(pinned,'epg/resolver-continuation.json'),loadJSON(pinned,predictionQueueKey),loadJSON(env,DISCOVERY_SCORE_PREVIEW_KEY),loadJSON(env,CONTINUATION_DIAGNOSTICS_KEY),loadJSON(env,DISCOVERY_LEASE_KEY)]);
 // AIR-154: the raw record cannot tell a live writer from an orphan; the derived health can.
 const continuationHealthReport=healthSummary(continuationHealth(continuation,lease,last,Date.now(),pinned.epgPin?.programmeRunId||null));
 const items=source?.items||[],decisionsMap=decisions||{},counts=discoveryCounts(items,decisionsMap,Date.now()),statuses={},confirmed=new Set();for(const candidate of items){const state=decisionsMap[candidate.key];if(state){statuses[state.status]=(statuses[state.status]||0)+1;if(state.status==='verified')confirmed.add(String(state.tmdbId));}}
 return {schemaVersion:2,programmeRunId:source?.programmeRunId||null,updatedAt:source?.updatedAt||null,candidates:counts.ledgerTotal,rawCandidates:counts.ledgerTotal,latestRawCandidates:source?.rawCandidates??null,latestFilteredNonMovies:source?.filteredNonMovies??null,filteredNonMovies:counts.rejectedNonfilm,checked:Object.values(statuses).reduce((a,b)=>a+b,0),pending:counts.currentUnresolved,unresolved:counts.currentUnresolved,ready:counts.readyNow,...counts,confirmedFilms:confirmed.size,verifiedFilms:Object.keys(catalog||{}).length,hot:queue?.hotCount??0,cold:queue?.coldCount??0,queuedForPrediction:queue?.pendingCount??0,hotQueuedForPrediction:queue?.priorityCount??0,predicted:queue?.hotPredicted??0,coldWithoutPrediction:queue?.coldWithoutPrediction??0,nextHotPredictions:(persistedQueue?.pending||[]).slice(0,persistedQueue?.priorityCount||0).slice(0,5).map(id=>{const f=Object.values(catalog||{}).find(f=>String(f.id)===id);return {filmId:id,title:f?.title||null,tmdbId:f?.tmdbId||null,hot:f?filmIsHot(f):null,discoveredAt:f?.discoveredAt||null};}),statuses,scoringPreview:scorePreviewSummary(scorePreview,scoredResolutionMode(env),pinned.epgPin?.programmeRunId||source?.programmeRunId||null),lastBatch:last||null,continuation:continuation||null,continuationHealth:continuationHealthReport,continuationDiagnostics:continuationDiagnostics||null};
}
