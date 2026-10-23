// AIR-71. Local D1 repository for EPG generations, observations, decisions, and scores.
// The Worker does not import this file. The caller supplies the database. R2 stays authoritative.

export function createEpgRepository(db){
 return {
  publishGeneration:input=>publishGeneration(db,input),
  recordDecision:input=>recordDecision(db,input),
  recordScore:input=>recordScore(db,input),
  readPublished:()=>readPublished(db),
  readPublishedShows:()=>readPublishedShows(db),
  readGeneration:programmeRunId=>readGeneration(db,programmeRunId),
  readCandidate:observationKey=>readCandidate(db,observationKey),
  readDecision:observationKey=>readDecision(db,observationKey),
  readScores:observationKey=>readScores(db,observationKey),
 };
}

async function publishGeneration(db,input){
 const programmeRunId=required(input?.programmeRunId,'programmeRunId');
 if(input.phase!=='published'&&input.phase!=='withheld')throw new Error('Generation phase must be published or withheld');
 const films=input.films||[],candidates=input.candidates||[];
 for(const film of films)requiredFilm(film.filmId);
 for(const candidate of candidates)validateCandidate(candidate);
 const existing=await readGeneration(db,programmeRunId);
 if(existing){
  if(stable(storedGeneration(existing))!==stable(incomingGeneration(input)))throw new Error('Generation payload conflicts with the committed run');
  const published=await readPublished(db);
  return {programmeRunId,phase:existing.phase,pointed:published?.programmeRunId===programmeRunId,replay:true};
 }
 const observedAt=input.publishedAt||null,current=input.phase==='published';
 return db.transaction(async()=>{
  await db.run('INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES (?,?,?)',[programmeRunId,input.phase,observedAt]);
  if(current)await db.run(`INSERT INTO published_generation (id,programme_run_id) VALUES (1,?)
   ON CONFLICT(id) DO UPDATE SET programme_run_id=excluded.programme_run_id`,[programmeRunId]);
  for(const film of films){
   await db.run('INSERT INTO film_generation (programme_run_id,film_id) VALUES (?,?)',[programmeRunId,film.filmId]);
   let latest=null;
   for(const show of film.shows||[]){
    await db.run('INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason) VALUES (?,?,?,?,?,?,?,?,?)',
     [programmeRunId,film.filmId,show.channelId,show.channel??null,show.startMs,show.endMs??null,show.epgTitle??null,show.basis??null,show.matchReason??null]);
    if(latest==null||show.startMs>latest)latest=show.startMs;
   }
   if(current&&latest!=null)await db.run(`INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES (?,?,?)
    ON CONFLICT(film_id) DO UPDATE SET
     airing_ms=MAX(film_epg_last_airing.airing_ms,excluded.airing_ms),
     programme_run_id=CASE WHEN excluded.airing_ms>=film_epg_last_airing.airing_ms THEN excluded.programme_run_id ELSE film_epg_last_airing.programme_run_id END`,
    [film.filmId,latest,programmeRunId]);
  }
  for(const candidate of candidates){
   const observation=observationJson(candidate);
   if(current)await db.run(`INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,last_attempt_at,retry_at,terminal_reason,evidence_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,?)
    ON CONFLICT(observation_key) DO UPDATE SET
     title=excluded.title,normalized_title=excluded.normalized_title,year=excluded.year,raw_titles_json=excluded.raw_titles_json,durations_json=excluded.durations_json,description=excluded.description,first_airing_ms=excluded.first_airing_ms,last_airing_ms=excluded.last_airing_ms,airings=excluded.airings,confirmed_tmdb_id=excluded.confirmed_tmdb_id,observation_schema_version=excluded.observation_schema_version,observation_json=excluded.observation_json,activity=excluded.activity,last_seen_at=excluded.last_seen_at,last_seen_programme_run_id=excluded.last_seen_programme_run_id,seen_in_latest=excluded.seen_in_latest,evidence_key=excluded.evidence_key,
     terminal_reason=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.terminal_reason ELSE NULL END,
     retry_at=CASE WHEN candidate.evidence_key=excluded.evidence_key THEN candidate.retry_at ELSE NULL END`,
    candidateParams(candidate,observation));
   else await db.run(`INSERT INTO candidate (observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,evidence_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)
    ON CONFLICT(observation_key) DO NOTHING`,
    withheldParams(candidate,observation));
   await db.run('INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key) VALUES (?,?,?,?,?)',[programmeRunId,candidate.observationKey,1,observation,candidate.evidenceKey]);
   for(const show of candidate.shows||[])await db.run('INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,channel,start_ms,end_ms,epg_title) VALUES (?,?,?,?,?,?,?)',[programmeRunId,candidate.observationKey,show.channelId,show.channel??null,show.startMs,show.endMs??null,show.epgTitle??null]);
  }
  if(current){
   const keys=candidates.map(candidate=>candidate.observationKey);
   const absent=`seen_in_latest=0,activity=CASE WHEN activity='current' THEN 'historical' ELSE activity END`;
   if(keys.length)await db.run(`UPDATE candidate SET ${absent} WHERE observation_key NOT IN (${keys.map(()=>'?').join(',')})`,keys);
   else await db.run(`UPDATE candidate SET ${absent}`);
  }
  return {programmeRunId,phase:input.phase,pointed:current,replay:false};
 });
}

async function recordDecision(db,input){
 const observationKey=validateObservationKey(input?.observationKey);
 const evidenceKey=required(input.evidenceKey,'evidenceKey');
 const checkedAt=required(input.checkedAt,'checkedAt');
 const programmeRunId=required(input.programmeRunId,'programmeRunId');
 const published=await readPublished(db);
 if(!published||published.phase!=='published'||published.programmeRunId!==programmeRunId)throw new Error('Decision generation is not published');
 const candidate=await readCandidate(db,observationKey);
 if(!candidate)throw new Error('Decision candidate is missing');
 if(candidate.evidenceKey!==evidenceKey)throw new Error('Decision evidence is not current');
 const provenance=input.provenance==null?null:JSON.stringify(input.provenance);
 await db.transaction(async()=>{
  await db.run(`INSERT INTO candidate_decision_history (observation_key,checked_at,status,reason,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,evidence_key,attempts,last_attempt_at,retry_at,terminal_reason,provenance_json,replaced_at)
   SELECT observation_key,checked_at,status,reason,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,evidence_key,attempts,last_attempt_at,retry_at,terminal_reason,provenance_json,?
   FROM candidate_decision
   WHERE observation_key=?
    AND NOT (terminal_reason IS NOT NULL AND evidence_key=?)
    AND (evidence_key IS NOT ? OR status IS NOT ? OR IFNULL(catalog_film_id,'') IS NOT IFNULL(?,'') OR IFNULL(film_id,'') IS NOT IFNULL(?,'') OR IFNULL(tmdb_id,'') IS NOT IFNULL(?,'') OR IFNULL(canonical_identity,'') IS NOT IFNULL(?,'') OR IFNULL(identity_source,'') IS NOT IFNULL(?,'') OR IFNULL(reason,'') IS NOT IFNULL(?,'') OR IFNULL(terminal_reason,'') IS NOT IFNULL(?,'') OR IFNULL(provenance_json,'') IS NOT IFNULL(?,''))`,
   [checkedAt,observationKey,evidenceKey,evidenceKey,input.status,input.catalogFilmId??null,input.filmId??null,input.tmdbId??null,input.canonicalIdentity??null,input.identitySource??null,input.reason??null,input.terminalReason??null,provenance]);
  await db.run(`INSERT INTO candidate_decision (observation_key,status,reason,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,checked_at,evidence_key,attempts,last_attempt_at,retry_at,terminal_reason,provenance_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(observation_key) DO UPDATE SET
    status=excluded.status,reason=excluded.reason,catalog_film_id=excluded.catalog_film_id,film_id=excluded.film_id,tmdb_id=excluded.tmdb_id,canonical_identity=excluded.canonical_identity,identity_source=excluded.identity_source,checked_at=excluded.checked_at,evidence_key=excluded.evidence_key,attempts=excluded.attempts,last_attempt_at=excluded.last_attempt_at,retry_at=excluded.retry_at,terminal_reason=excluded.terminal_reason,provenance_json=excluded.provenance_json
   WHERE NOT (candidate_decision.terminal_reason IS NOT NULL AND candidate_decision.evidence_key=excluded.evidence_key)`,
   [observationKey,input.status,input.reason??null,input.catalogFilmId??null,input.filmId??null,input.tmdbId??null,input.canonicalIdentity??null,input.identitySource??null,checkedAt,evidenceKey,input.attempts??0,input.lastAttemptAt??null,input.retryAt??null,input.terminalReason??null,provenance]);
  await db.run(`UPDATE candidate SET attempts=?,last_attempt_at=?,retry_at=?,terminal_reason=?
   WHERE observation_key=? AND evidence_key=?
   AND EXISTS (SELECT 1 FROM candidate_decision WHERE observation_key=? AND status=? AND evidence_key=? AND checked_at=? AND IFNULL(terminal_reason,'')=IFNULL(?,''))`,
   [input.attempts??0,input.lastAttemptAt??null,input.retryAt??null,input.terminalReason??null,observationKey,evidenceKey,observationKey,input.status,evidenceKey,checkedAt,input.terminalReason??null]);
 });
 const decision=await readDecision(db,observationKey);
 const current=decision?.current;
 const applied=!!current&&current.status===input.status&&current.evidenceKey===evidenceKey&&current.checkedAt===checkedAt&&(current.terminalReason??null)===(input.terminalReason??null);
 return {applied,reason:applied?null:'terminal_evidence_unchanged',decision};
}

async function recordScore(db,input){
 const observationKey=validateObservationKey(input?.observationKey);
 const programmeRunId=required(input.programmeRunId,'programmeRunId');
 const id=required(input.id,'id');
 const incoming=scorePayload(input);
 const stored=await readScoreRecord(db,id);
 const triple=await db.get('SELECT id FROM score_result WHERE observation_key=? AND programme_run_id=? AND scorer_version=?',[observationKey,programmeRunId,input.scorerVersion]);
 if(stored||triple){
  if(stored&&stable(scorePayload(stored))===stable(incoming)&&(!triple||triple.id===id))return readScores(db,observationKey);
  throw new Error('Score record conflicts with the stored score');
 }
 const provenance=input.provenance==null?null:JSON.stringify(input.provenance);
 await db.transaction(async()=>{
  await db.run('INSERT INTO score_result (id,observation_key,programme_run_id,scorer_version,status,reason,confidence,score,accepted_tmdb_id,gate_outcome,gate_reason,provenance_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
   [id,observationKey,programmeRunId,input.scorerVersion,input.status,input.reason??null,input.confidence??null,input.score??null,input.acceptedTmdbId??null,input.gateOutcome??null,input.gateReason??null,provenance,input.createdAt]);
  for(const row of input.considered||[])await db.run('INSERT INTO score_considered (score_id,ordinal,tmdb_id,trusted,year,runtime) VALUES (?,?,?,?,?,?)',[id,row.ordinal,row.tmdbId,row.trusted?1:0,row.year??null,row.runtime??null]);
  if(input.detail)await db.run('INSERT INTO score_detail (score_id,movie_id,runtime,release_year,matched_title,fetched_at,r2_key,content_sha256) VALUES (?,?,?,?,?,?,?,?)',[id,input.detail.movieId,input.detail.runtime??null,input.detail.releaseYear??null,input.detail.matchedTitle??null,input.detail.fetchedAt,input.detail.r2Key??null,input.detail.contentSha256??null]);
 });
 return readScores(db,observationKey);
}

async function readPublished(db){
 const row=await db.get('SELECT programme_run_id,phase FROM programme_generation WHERE programme_run_id=(SELECT programme_run_id FROM published_generation WHERE id=1)');
 return row?{programmeRunId:row.programme_run_id,phase:row.phase}:null;
}

async function readPublishedShows(db){
 const rows=await db.all('SELECT programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM published_film_show ORDER BY start_ms,channel_id');
 return rows.map(showRow);
}

async function readGeneration(db,programmeRunId){
 const generation=await db.get('SELECT programme_run_id,phase,published_at FROM programme_generation WHERE programme_run_id=?',[programmeRunId]);
 if(!generation)return null;
 const membership=await db.all('SELECT film_id FROM film_generation WHERE programme_run_id=? ORDER BY film_id',[programmeRunId]);
 const filmShows=await db.all('SELECT film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason FROM film_show WHERE programme_run_id=? ORDER BY film_id,start_ms',[programmeRunId]);
 const observations=await db.all('SELECT observation_key,observation_schema_version,observation_json,evidence_key FROM candidate_generation WHERE programme_run_id=? ORDER BY observation_key',[programmeRunId]);
 const candidateShows=await db.all('SELECT observation_key,channel_id,channel,start_ms,end_ms,epg_title FROM candidate_show WHERE programme_run_id=? ORDER BY observation_key,start_ms',[programmeRunId]);
 return {
  programmeRunId:generation.programme_run_id,
  phase:generation.phase,
  publishedAt:generation.published_at,
  films:membership.map(row=>({filmId:row.film_id,shows:filmShows.filter(show=>show.film_id===row.film_id).map(showRow)})),
  candidates:observations.map(row=>({observationKey:row.observation_key,schemaVersion:row.observation_schema_version,evidenceKey:row.evidence_key,observation:JSON.parse(row.observation_json),shows:candidateShows.filter(show=>show.observation_key===row.observation_key).map(candidateShowRow)})),
 };
}

async function readCandidate(db,observationKey){
 const row=await db.get('SELECT observation_key,title,normalized_title,year,raw_titles_json,durations_json,description,first_airing_ms,last_airing_ms,airings,confirmed_tmdb_id,observation_schema_version,observation_json,activity,last_seen_at,last_seen_programme_run_id,seen_in_latest,attempts,retry_at,terminal_reason,evidence_key FROM candidate WHERE observation_key=?',[observationKey]);
 if(!row)return null;
 return {observationKey:row.observation_key,title:row.title,normalizedTitle:row.normalized_title,year:row.year,rawTitles:JSON.parse(row.raw_titles_json),durations:JSON.parse(row.durations_json),description:row.description,firstAiringMs:row.first_airing_ms,lastAiringMs:row.last_airing_ms,airings:row.airings,confirmedTmdbId:row.confirmed_tmdb_id,schemaVersion:row.observation_schema_version,observation:JSON.parse(row.observation_json),activity:row.activity,lastSeenAt:row.last_seen_at,lastSeenProgrammeRunId:row.last_seen_programme_run_id,seenInLatest:row.seen_in_latest===1,attempts:row.attempts,retryAt:row.retry_at,terminalReason:row.terminal_reason,evidenceKey:row.evidence_key};
}

async function readDecision(db,observationKey){
 const current=await db.get('SELECT observation_key,status,reason,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,checked_at,evidence_key,attempts,last_attempt_at,retry_at,terminal_reason,provenance_json FROM candidate_decision WHERE observation_key=?',[observationKey]);
 if(!current)return null;
 const history=await db.all('SELECT observation_key,status,reason,catalog_film_id,film_id,tmdb_id,canonical_identity,identity_source,checked_at,evidence_key,attempts,retry_at,terminal_reason,provenance_json,replaced_at FROM candidate_decision_history WHERE observation_key=? ORDER BY replaced_at,checked_at',[observationKey]);
 return {current:decisionRow(current),history:history.map(decisionRow)};
}

async function readScores(db,observationKey){
 const scores=await db.all('SELECT id,observation_key,programme_run_id,scorer_version,status,reason,confidence,score,accepted_tmdb_id,gate_outcome,gate_reason,provenance_json,created_at FROM score_result WHERE observation_key=? ORDER BY created_at,id',[observationKey]);
 const result=[];
 for(const score of scores){
  const considered=await db.all('SELECT ordinal,tmdb_id,trusted,year,runtime FROM score_considered WHERE score_id=? ORDER BY ordinal',[score.id]);
  const detail=await db.get('SELECT movie_id,runtime,release_year,matched_title,fetched_at,r2_key,content_sha256 FROM score_detail WHERE score_id=?',[score.id]);
  result.push({id:score.id,observationKey:score.observation_key,programmeRunId:score.programme_run_id,scorerVersion:score.scorer_version,status:score.status,reason:score.reason,confidence:score.confidence,score:score.score,acceptedTmdbId:score.accepted_tmdb_id,gateOutcome:score.gate_outcome,gateReason:score.gate_reason,provenance:score.provenance_json?JSON.parse(score.provenance_json):null,createdAt:score.created_at,considered:considered.map(row=>({ordinal:row.ordinal,tmdbId:row.tmdb_id,trusted:row.trusted===1,year:row.year,runtime:row.runtime})),detail:detail?{movieId:detail.movie_id,runtime:detail.runtime,releaseYear:detail.release_year,matchedTitle:detail.matched_title,fetchedAt:detail.fetched_at,r2Key:detail.r2_key,contentSha256:detail.content_sha256}:null});
 }
 return result;
}

function decisionRow(row){
 return {observationKey:row.observation_key,status:row.status,reason:row.reason,catalogFilmId:row.catalog_film_id,filmId:row.film_id,tmdbId:row.tmdb_id,canonicalIdentity:row.canonical_identity,identitySource:row.identity_source,checkedAt:row.checked_at,evidenceKey:row.evidence_key,attempts:row.attempts,retryAt:row.retry_at,terminalReason:row.terminal_reason,provenance:row.provenance_json?JSON.parse(row.provenance_json):null,replacedAt:row.replaced_at??null};
}

function showRow(row){
 return {programmeRunId:row.programme_run_id??null,filmId:row.film_id,channelId:row.channel_id,channel:row.channel,startMs:row.start_ms,endMs:row.end_ms,epgTitle:row.epg_title,basis:row.basis,matchReason:row.match_reason};
}

function candidateShowRow(row){
 return {channelId:row.channel_id,channel:row.channel,startMs:row.start_ms,endMs:row.end_ms,epgTitle:row.epg_title};
}

function observationJson(candidate){
 return JSON.stringify({schemaVersion:1,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,rawTitles:candidate.rawTitles||[],durations:candidate.durations||[],description:candidate.description??null,firstAiring:candidate.firstAiringMs??null,lastAiring:candidate.lastAiringMs??null,airings:candidate.airings??null,confirmedTmdbId:candidate.confirmedTmdbId??null});
}

function candidateParams(candidate,observation){
 return [candidate.observationKey,candidate.title,candidate.normalizedTitle,candidate.year??null,JSON.stringify(candidate.rawTitles||[]),JSON.stringify(candidate.durations||[]),candidate.description??null,candidate.firstAiringMs??null,candidate.lastAiringMs??null,candidate.airings??null,candidate.confirmedTmdbId??null,1,observation,candidate.activity??null,candidate.lastSeenAt??null,candidate.lastSeenProgrammeRunId??null,candidate.seenInLatest?1:0,candidate.evidenceKey];
}

function withheldParams(candidate,observation){
 const activity=candidate.activity==='current'?'historical':candidate.activity??null;
 return [candidate.observationKey,candidate.title,candidate.normalizedTitle,candidate.year??null,JSON.stringify(candidate.rawTitles||[]),JSON.stringify(candidate.durations||[]),candidate.description??null,candidate.firstAiringMs??null,candidate.lastAiringMs??null,candidate.airings??null,candidate.confirmedTmdbId??null,1,observation,activity,candidate.lastSeenAt??null,candidate.lastSeenProgrammeRunId??null,candidate.evidenceKey];
}

function incomingGeneration(input){
 return {phase:input.phase,publishedAt:input.publishedAt||null,films:[...(input.films||[])].map(film=>({filmId:film.filmId,shows:[...(film.shows||[])].map(filmShowPayload).sort(byShow)})).sort(byFilm),candidates:[...(input.candidates||[])].map(candidate=>({observationKey:candidate.observationKey,evidenceKey:candidate.evidenceKey,observation:JSON.parse(observationJson(candidate)),shows:[...(candidate.shows||[])].map(candidateShowPayload).sort(byShow)})).sort(byObservation)};
}

function storedGeneration(generation){
 return {phase:generation.phase,publishedAt:generation.publishedAt||null,films:generation.films.map(film=>({filmId:film.filmId,shows:film.shows.map(filmShowPayload).sort(byShow)})).sort(byFilm),candidates:generation.candidates.map(candidate=>({observationKey:candidate.observationKey,evidenceKey:candidate.evidenceKey,observation:candidate.observation,shows:candidate.shows.map(candidateShowPayload).sort(byShow)})).sort(byObservation)};
}

function filmShowPayload(show){
 return {channelId:show.channelId,channel:show.channel??null,startMs:show.startMs,endMs:show.endMs??null,epgTitle:show.epgTitle??null,basis:show.basis??null,matchReason:show.matchReason??null};
}

function candidateShowPayload(show){
 return {channelId:show.channelId,channel:show.channel??null,startMs:show.startMs,endMs:show.endMs??null,epgTitle:show.epgTitle??null};
}

function byShow(a,b){return a.channelId<b.channelId?-1:a.channelId>b.channelId?1:a.startMs-b.startMs;}
function byFilm(a,b){return a.filmId<b.filmId?-1:a.filmId>b.filmId?1:0;}
function byObservation(a,b){return a.observationKey<b.observationKey?-1:a.observationKey>b.observationKey?1:0;}

function stable(value){
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
 return JSON.stringify(value??null);
}

async function readScoreRecord(db,id){
 const score=await db.get('SELECT id,observation_key,programme_run_id,scorer_version,status,reason,confidence,score,accepted_tmdb_id,gate_outcome,gate_reason,provenance_json,created_at FROM score_result WHERE id=?',[id]);
 if(!score)return null;
 const considered=await db.all('SELECT ordinal,tmdb_id,trusted,year,runtime FROM score_considered WHERE score_id=? ORDER BY ordinal',[id]);
 const detail=await db.get('SELECT movie_id,runtime,release_year,matched_title,fetched_at,r2_key,content_sha256 FROM score_detail WHERE score_id=?',[id]);
 return {id:score.id,observationKey:score.observation_key,programmeRunId:score.programme_run_id,scorerVersion:score.scorer_version,status:score.status,reason:score.reason,confidence:score.confidence,score:score.score,acceptedTmdbId:score.accepted_tmdb_id,gateOutcome:score.gate_outcome,gateReason:score.gate_reason,provenance:score.provenance_json?JSON.parse(score.provenance_json):null,createdAt:score.created_at,considered:considered.map(row=>({ordinal:row.ordinal,tmdbId:row.tmdb_id,trusted:row.trusted===1,year:row.year,runtime:row.runtime})),detail:detail?{movieId:detail.movie_id,runtime:detail.runtime,releaseYear:detail.release_year,matchedTitle:detail.matched_title,fetchedAt:detail.fetched_at,r2Key:detail.r2_key,contentSha256:detail.content_sha256}:null};
}

function scorePayload(score){
 return {id:score.id,observationKey:score.observationKey,programmeRunId:score.programmeRunId,scorerVersion:score.scorerVersion,status:score.status,reason:score.reason??null,confidence:score.confidence??null,score:score.score??null,acceptedTmdbId:score.acceptedTmdbId??null,gateOutcome:score.gateOutcome??null,gateReason:score.gateReason??null,provenance:score.provenance??null,createdAt:score.createdAt,considered:[...(score.considered||[])].map(row=>({ordinal:row.ordinal,tmdbId:row.tmdbId,trusted:!!row.trusted,year:row.year??null,runtime:row.runtime??null})).sort((a,b)=>a.ordinal-b.ordinal),detail:score.detail?{movieId:score.detail.movieId,runtime:score.detail.runtime??null,releaseYear:score.detail.releaseYear??null,matchedTitle:score.detail.matchedTitle??null,fetchedAt:score.detail.fetchedAt,r2Key:score.detail.r2Key??null,contentSha256:score.detail.contentSha256??null}:null};
}

function validateCandidate(candidate){
 validateObservationKey(candidate?.observationKey);
 required(candidate.evidenceKey,'evidenceKey');
 required(candidate.title,'title');
 required(candidate.normalizedTitle,'normalizedTitle');
}

function validateObservationKey(value){
 const key=required(value,'observationKey');
 if(key.startsWith('film:')||key.startsWith('person:'))throw new Error('Observation key is not a film or person id');
 return key;
}

function requiredFilm(value){
 const id=required(value,'filmId');
 if(!id.startsWith('film:'))throw new Error('Film id must start with film:');
 return id;
}

function required(value,name){
 if(value==null||value==='')throw new Error(name+' is required');
 return value;
}
