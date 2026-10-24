// Scoring result to identity gate. Pure and storage-neutral. Discovery loads it when SCORED_RESOLUTION is shadow or on.
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
