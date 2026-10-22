// Scoring result to identity gate. Pure and storage-neutral. The Worker does not load or call this file.
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
function acceptScoredIdentity(input={}){
 const score=input.score||{},observationKey=score.observationKey??input.observationKey??null;
 const pinned=input.pinnedProgrammeRunId??null,observed=input.observationProgrammeRunId??null;
 const discovery=input.discovery&&typeof input.discovery==='object'?{eligible:input.discovery.eligible===true?true:input.discovery.eligible===false?false:null,activity:input.discovery.activity??null,evidenceChanged:input.discovery.evidenceChanged===true?true:input.discovery.evidenceChanged===false?false:null}:null;
 const film=input.film||null;
 const scoring={observationKey,...scoringEvidence(score)};
 const provenance={observationKey,scorerVersion:scoring.scorerVersion,status:scoring.status,reason:scoring.reason,programmeRunId:observed,pinnedProgrammeRunId:pinned,discovery};
 const result={observationKey,scoring,provenance,outcome:null,reason:null,candidateDecision:null,transition:null,filmChange:null,linkEvidence:null};
 if(!observationKey)return {...result,outcome:'refused',reason:'missing_observation_key'};
 if(!pinned||observed!==pinned)return {...result,outcome:'refused',reason:'stale_generation'};
 const mapped=candidateStatusForScore(score);
 if(mapped)return {...result,outcome:'candidate_decision',reason:scoring.reason,candidateDecision:{status:mapped,observationKey,reason:scoring.reason,evidence:scoringEvidence(score),provenance}};
 if(score.status!=='accepted'||score.acceptedTmdbId==null||score.acceptedTmdbId==='')return {...result,outcome:'refused',reason:scoring.reason||'not_accepted'};
 const tmdbId=String(score.acceptedTmdbId);
 const existing=(film?.externalIds||[]).find(item=>item.scheme==='tmdb'&&item.trusted&&!item.conflicting);
 if((existing&&existing.value!==tmdbId)||(film?.canonicalIdentity&&film.canonicalIdentity!=='tmdb:'+tmdbId))return {...result,outcome:'refused',reason:'identity_collision'};
 const confirmation=input.confirmation;
 const confirmed=!!(confirmation&&confirmation.confirmed===true&&String(confirmation.tmdbId)===tmdbId&&confirmation.source&&confirmation.source!=='score');
 if(confirmed&&film?.canonicalIdentity==='tmdb:'+tmdbId&&(input.appliedObservationKeys||[]).includes(observationKey))return {...result,outcome:'already_applied',reason:'already_applied'};
 if(!confirmed)return {...result,outcome:'needs_verification',reason:'needs_verification'};
 return {...result,outcome:'trusted_acceptance',reason:'confirmed_identity',transition:{kind:'identity_transition',observationKey,tmdbId,programmeRunId:pinned,provenance}};
}
