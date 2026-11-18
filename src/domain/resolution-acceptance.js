// Scoring result to identity gate. Pure and storage-neutral. Discovery loads it for every resolver chunk; the scored gate is the only resolver.
function scoringEvidence(score){
 return {scorerVersion:score.scorerVersion??null,status:score.status??null,reason:score.reason??null,confidence:score.confidence??null,score:score.score??null,acceptedTmdbId:score.acceptedTmdbId??null,considered:score.considered||[]};
}
function candidateStatusForScore(score){
 if(score.status==='contradicted'&&score.reason==='contradicted_runtime')return 'duration_mismatch';
 if(score.status==='contradicted'&&score.reason==='contradicted_year')return 'no_confident_match';
 if(score.status==='ambiguous')return 'ambiguous';
 if(score.status==='no_confident_match')return 'no_confident_match';
 return null;
}
function suppliedDiscoveryFacts(raw){
 if(!raw||typeof raw!=='object')return null;
 const activity=raw.activity==='current'||raw.activity==='historical'||raw.activity==='expired'?raw.activity:null;
 return {eligible:raw.eligible===true?true:raw.eligible===false?false:null,activity,evidenceChanged:raw.evidenceChanged===true?true:raw.evidenceChanged===false?false:null,terminal:raw.terminal===true?true:raw.terminal===false?false:null};
}
function discoveryAuthorizes(discovery){
 if(!discovery||discovery.eligible!==true||discovery.activity!=='current')return false;
 if(discovery.terminal===true&&discovery.evidenceChanged!==true)return false;
 return true;
}
function tmdbClaims(film){
 return (film?.externalIds||[]).filter(item=>item?.scheme==='tmdb'&&item.value!=null&&item.value!=='').map(item=>({value:String(item.value),conflicting:!!item.conflicting}));
}
function identityCollision(film,tmdbId){
 const claims=tmdbClaims(film),values=[...new Set(claims.map(item=>item.value))];
 if(claims.some(item=>item.conflicting)||values.length>1||values.some(value=>value!==tmdbId))return true;
 if(film?.tmdbId!=null&&film.tmdbId!==''&&String(film.tmdbId)!==tmdbId)return true;
 if(Array.isArray(film?.conflictingTmdbIds)&&film.conflictingTmdbIds.length)return true;
 return !!(film?.canonicalIdentity&&film.canonicalIdentity!=='tmdb:'+tmdbId);
}
function trustedConfirmation(confirmation,tmdbId){
 if(!confirmation||typeof confirmation!=='object'||String(confirmation.tmdbId)!==tmdbId)return false;
 const evidence=confirmation.evidence;
 if(!evidence||typeof evidence!=='object')return false;
 if(confirmation.authority==='verified_decision'){const decision=evidence.decision;return !!decision&&decision.status==='verified'&&String(decision.tmdbId)===tmdbId;}
 if(confirmation.authority==='owner')return evidence.authority==='owner'&&evidence.reviewed===true&&String(evidence.tmdbId)===tmdbId;
 return false;
}
function detailNorm(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function detailNumber(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
function detailTitles(movie){return [movie?.title,movie?.original,...(movie?.aliases||[])].filter(Boolean);}
function detailYearCompatible(observationYear,candidateYear){return observationYear==null||candidateYear==null||Math.abs(observationYear-candidateYear)<=1;}
function genreToken(value){return detailNorm(typeof value==='string'?value:(value&&value.name)||'');}
function genreId(value){const id=typeof value==='number'?value:value&&typeof value==='object'?detailNumber(value.id):null;return id!=null&&id>0?id:null;}
const TMDB_GENRE_MUSIC=10402,TMDB_GENRE_DOCUMENTARY=99,TMDB_GENRE_TV_MOVIE=10770;
const MUSIC_GENRE_NAMES=new Set(['music','музыка','музыкальный','музика']);
const DOCUMENTARY_GENRE_NAMES=new Set(['documentary','документальный','документальний']);
const TV_MOVIE_GENRE_NAMES=new Set(['tv movie','телефильм','телефільм']);
const NON_FEATURE_GENRE_NAMES=new Set([...MUSIC_GENRE_NAMES,...DOCUMENTARY_GENRE_NAMES,...TV_MOVIE_GENRE_NAMES]);
const FILM_EPG_CATEGORY=new Set(['фильм','фільм','кино','кіно','телефильм','телефільм','movie','film','cinema']);
const CONCERT_EPG_CATEGORY=new Set(['концерт','concert','concerts','live','музыка','музика','music']);
const PERFORMANCE_PHRASES=['live at','live in','live from','in concert','concert film','concert recording','filmed live','live performance','recorded live','performing live','запись концерта','запись выступления','живой концерт'];
const OVERVIEW_PHRASES=PERFORMANCE_PHRASES.filter(phrase=>phrase!=='live in');
const WEAK_CONCERT_TOKENS=new Set(['live','concert','концерт']);
function genreFacts(movie){
 const ids=new Set(),unnamed=[];
 for(const value of [...(movie?.genres||[]),...(movie?.genreIds||[])]){
  if(typeof value==='number'){if(value>0)ids.add(value);continue;}
  const id=genreId(value);
  if(id!=null)ids.add(id);
  else{const name=genreToken(value);if(name)unnamed.push(name);}
 }
 return {ids,unnamed};
}
function listedGenre(facts,id,names){return facts.ids.has(id)||facts.unnamed.some(name=>names.has(name));}
function featureGenre(facts){
 for(const id of facts.ids)if(id!==TMDB_GENRE_MUSIC&&id!==TMDB_GENRE_TV_MOVIE&&id!==TMDB_GENRE_DOCUMENTARY)return true;
 return facts.unnamed.some(name=>!NON_FEATURE_GENRE_NAMES.has(name));
}
function concertBroadcastCategory(categories){
 const tokens=[...(categories||[])].map(detailNorm).filter(Boolean);
 if(!tokens.length)return false;
 const parts=tokens.flatMap(token=>token.split(' ').filter(Boolean));
 if(parts.some(part=>FILM_EPG_CATEGORY.has(part)))return false;
 return parts.some(part=>CONCERT_EPG_CATEGORY.has(part));
}
function titlePerformanceText(movie,observation){
 return detailNorm([observation?.normalizedTitle,observation?.title,movie?.title,movie?.original,...(movie?.aliases||[])].filter(Boolean).join(' '));
}
function overviewPerformanceText(movie){return detailNorm(movie?.overview||'');}
function phraseHit(text,phrases){
 if(!text)return false;
 const padded=' '+text+' ';
 return phrases.some(phrase=>padded.includes(' '+phrase+' '));
}
function recordingPhrase(text,phrases){return phraseHit(text,phrases)||!!text&&text.includes('концертн');}
function independentlyRecorded(titles,overview){
 return recordingPhrase(titles,PERFORMANCE_PHRASES)&&recordingPhrase(overview,OVERVIEW_PHRASES);
}
function genreListPresent(movie){return Array.isArray(movie?.genres)||Array.isArray(movie?.genreIds);}
function overviewConcertToken(text){return !!text&&text.split(' ').some(token=>token==='concert'||token.startsWith('концерт'));}
function admissionPolicy(movie,observation){
 const facts=genreFacts(movie);
 if(listedGenre(facts,TMDB_GENRE_DOCUMENTARY,DOCUMENTARY_GENRE_NAMES))return 'documentary';
 if(featureGenre(facts))return null;
 const titles=titlePerformanceText(movie,observation),overview=overviewPerformanceText(movie);
 const strong=recordingPhrase(titles,PERFORMANCE_PHRASES)||recordingPhrase(overview,OVERVIEW_PHRASES);
 const proven=independentlyRecorded(titles,overview);
 const category=concertBroadcastCategory(observation?.categories);
 if(listedGenre(facts,TMDB_GENRE_MUSIC,MUSIC_GENRE_NAMES)){
  if(category||strong)return 'concert';
  if(titles.split(' ').some(token=>WEAK_CONCERT_TOKENS.has(token))||overviewConcertToken(overview))return 'ambiguous';
  return null;
 }
 if(listedGenre(facts,TMDB_GENRE_TV_MOVIE,TV_MOVIE_GENRE_NAMES)){
  if(proven||(category&&strong))return 'concert';
  return null;
 }
 if(proven)return 'concert';
 // TMDB listed no genre at all: nothing separates a Documentary or a concert recording from a feature, so title, year and runtime alone never verify it.
 if(!facts.ids.size&&!facts.unnamed.length&&genreListPresent(movie))return 'unclassified';
 return null;
}
// AIR-501 (ADR 0169): writer-only classification for `catalog_policy_exclude@1`. The detail gate and the programme overlay keep using admissionPolicy.
// A card with no feature genre (Music alone, TV Movie alone, or no genre at all) is retired by the owner writer when its stored title or synopsis names a
// performance or a documentary in plain words. A card with no such words, or with an empty synopsis, stays out of reach of the writer.
const CLEANUP_CONCERT_TERMS=/концерт|koncert|concert|выступлен|выступил|выступа|performance|performed|filmed live|live (at|in|from)|турне|\btour\b|festival|фестивал/;
const CLEANUP_DOCUMENTARY_TERMS=/документальн|documentary/;
function catalogCleanupPolicy(movie,observation){
 const base=admissionPolicy(movie,observation);
 if(base==='documentary'||base==='concert'||base==='ambiguous')return base;
 const facts=genreFacts(movie);
 if(featureGenre(facts))return base;
 const noGenre=!facts.ids.size&&!facts.unnamed.length;
 if(!noGenre&&!listedGenre(facts,TMDB_GENRE_MUSIC,MUSIC_GENRE_NAMES)&&!listedGenre(facts,TMDB_GENRE_TV_MOVIE,TV_MOVIE_GENRE_NAMES))return base;
 const text=detailNorm([titlePerformanceText(movie,observation),overviewPerformanceText(movie)].join(' '));
 if(CLEANUP_DOCUMENTARY_TERMS.test(text))return 'documentary';
 if(CLEANUP_CONCERT_TERMS.test(text))return 'concert';
 return base;
}
function verifyTmdbDetail(detail,tmdbId,observation,competitors,structural){
 const movie=detail?.evidence?.movie;
 if(detail?.authority!=='tmdb_detail'||!movie||typeof movie!=='object')return {ok:false,hold:'needs',reason:'detail_incomplete'};
 if(String(movie.id)!==tmdbId)return {ok:false,hold:'needs',reason:'detail_id_mismatch'};
 const normalized=detailNorm(observation?.normalizedTitle),form=structural?reversibleStructuralForm(observation?.normalizedTitle||observation?.title,structural.form):null;
 if(structural&&(!form||form.reason!==structural.reason||form.form!==detailNorm(structural.form)))return {ok:false,hold:'candidate',status:'no_confident_match',reason:'detail_title_mismatch'};
 const expected=form?form.form:normalized,matched=detailTitles(movie).find(title=>detailNorm(title)===expected);
 if(!matched)return {ok:false,hold:'candidate',status:'no_confident_match',reason:'detail_title_mismatch'};
 const observationYear=detailNumber(observation?.year),releaseYear=detailNumber(movie.year),runtime=detailNumber(movie.runtime);
 if(observationYear!=null&&(releaseYear==null||Math.abs(observationYear-releaseYear)>1))return {ok:false,hold:'candidate',status:'no_confident_match',reason:'detail_year_mismatch'};
 const durations=[...(observation?.durations||[])].map(detailNumber).filter(value=>value!=null);
 const tolerance=observationYear==null?Math.max(10,runtime*0.12):Math.max(25,runtime*0.2);
 if(runtime==null||runtime<=0||!durations.some(duration=>Math.abs(runtime-duration)<=tolerance))return {ok:false,hold:'candidate',status:'duration_mismatch',reason:'detail_runtime_mismatch'};
 const rival=(competitors||[]).find(film=>String(film?.tmdbId)!==tmdbId&&detailTitles(film).some(title=>detailNorm(title)===expected)&&detailYearCompatible(observationYear,detailNumber(film?.year)));
 if(rival)return {ok:false,hold:'candidate',status:'ambiguous',reason:'detail_competing_version'};
 return {ok:true,runtime,releaseYear,matchedTitle:detailNorm(matched),structural:form};
}
function acceptScoredIdentity(input={}){
 const score=input.score||{},observationKey=input.observationKey??null,scoredKey=score.observationKey??null;
 const pinned=input.pinnedProgrammeRunId??null,observed=input.observationProgrammeRunId??null;
 const discovery=suppliedDiscoveryFacts(input.discovery);
 const film=input.film||null;
 const scoring={observationKey:scoredKey,...scoringEvidence(score)};
 const provenance={observationKey,scoredObservationKey:scoredKey,scorerVersion:scoring.scorerVersion,status:scoring.status,reason:scoring.reason,programmeRunId:observed,pinnedProgrammeRunId:pinned,discovery};
 const result={observationKey,scoring,provenance,outcome:null,reason:null,candidateDecision:null,transition:null,filmChange:null,linkEvidence:null};
 if(!observationKey)return {...result,outcome:'refused',reason:'missing_observation_key'};
 if(scoredKey!==observationKey)return {...result,outcome:'refused',reason:'observation_key_mismatch'};
 if(!pinned||observed!==pinned)return {...result,outcome:'refused',reason:'stale_generation'};
 const mapped=candidateStatusForScore(score);
 if(mapped){
  if(!discoveryAuthorizes(discovery))return {...result,outcome:'refused',reason:'not_actionable'};
  return {...result,outcome:'candidate_decision',reason:scoring.reason,candidateDecision:{status:mapped,observationKey,reason:scoring.reason,evidence:scoringEvidence(score),provenance}};
 }
 if(score.status!=='accepted'||score.acceptedTmdbId==null||score.acceptedTmdbId==='')return {...result,outcome:'refused',reason:scoring.reason||'not_accepted'};
 const tmdbId=String(score.acceptedTmdbId);
 if(identityCollision(film,tmdbId))return {...result,outcome:'refused',reason:'identity_collision'};
 const confirmed=trustedConfirmation(input.confirmation,tmdbId);
 if(confirmed&&film?.canonicalIdentity==='tmdb:'+tmdbId&&(input.appliedObservationKeys||[]).includes(observationKey))return {...result,outcome:'already_applied',reason:'already_applied'};
 if(!discoveryAuthorizes(discovery))return {...result,outcome:'refused',reason:'not_actionable'};
 if(input.tmdbDetail){
  const detail=verifyTmdbDetail(input.tmdbDetail,tmdbId,input.observation,input.competitors,input.score?.titleBasis?.structural||null);
  if(!detail.ok&&detail.hold==='candidate')return {...result,outcome:'candidate_decision',reason:detail.reason,candidateDecision:{status:detail.status,observationKey,reason:detail.reason,evidence:scoringEvidence(score),provenance:{...provenance,authority:'tmdb_detail'}}};
  if(!detail.ok)return {...result,outcome:'needs_verification',reason:detail.reason};
  const policy=admissionPolicy(input.tmdbDetail?.evidence?.movie,input.observation);
  if(policy==='documentary'||policy==='concert'){
   const reason=policy==='documentary'?'documentary_excluded':'concert_recording';
   return {...result,outcome:'candidate_decision',reason,candidateDecision:{status:'no_confident_match',observationKey,reason,evidence:scoringEvidence(score),provenance:{...provenance,authority:'tmdb_detail'}}};
  }
  if(policy==='ambiguous'&&!confirmed)return {...result,outcome:'needs_verification',reason:'concert_recording_ambiguous'};
  if(policy==='unclassified'&&!confirmed)return {...result,outcome:'needs_verification',reason:'genre_evidence_missing'};
  const observationYear=detailNumber(input.observation?.year),yearGap=observationYear==null||detail.releaseYear==null?null:Math.abs(observationYear-detail.releaseYear);
  if(!confirmed&&yearGap===1&&shortTitle(input.observation?.normalizedTitle||input.observation?.title)){
   const competingEditions=(input.competitors||[]).filter(film=>String(film?.tmdbId)!==tmdbId&&detailTitles(film).some(title=>detailNorm(title)===detail.matchedTitle)).map(film=>({tmdbId:String(film.tmdbId),year:detailNumber(film.year)}));
   return {...result,outcome:'needs_verification',reason:'short_title_adjacent_year',...(competingEditions.length?{competingEditions}:{})};
  }
  return {...result,outcome:'detail_verified',reason:'tmdb_detail',transition:{kind:'identity_transition',observationKey,tmdbId,programmeRunId:pinned,provenance,authority:'tmdb_detail',detail:{movieId:tmdbId,runtime:detail.runtime,releaseYear:detail.releaseYear,matchedTitle:detail.matchedTitle}}};
 }
 if(!confirmed)return {...result,outcome:'needs_verification',reason:'needs_verification'};
 return {...result,outcome:'trusted_acceptance',reason:'confirmed_identity',transition:{kind:'identity_transition',observationKey,tmdbId,programmeRunId:pinned,provenance,authority:input.confirmation.authority}};
}
function filmAdmissionInput(film){
 if(!film||typeof film!=='object')return {movie:null,observation:null};
 const overview=typeof film.overview==='string'&&film.overview?film.overview:(typeof film.synopsis==='string'?film.synopsis:'');
 const movie={title:film.title,original:film.original,aliases:film.aliases,genres:film.genres,genreIds:film.genreIds,overview};
 const observation={title:film.title,normalizedTitle:film.normalizedTitle||film.title,categories:Array.isArray(film.categories)?film.categories:[]};
 return {movie,observation};
}
function policyExcludedPresentedFilm(film){
 const {movie,observation}=filmAdmissionInput(film);
 if(!movie)return false;
 const policy=admissionPolicy(movie,observation);
 return policy==='documentary'||policy==='concert';
}
