// Letterboxd user facts (ADR-0023, ADR-0024): watched, rating and watchlist per film, each a timestamped observation with
// provenance. Only a greater observation replaces a value; absence from a list is not an observation; a complete scan is
// stored once as a summary observation of every film it shows. Contract: docs/reference/integrations/letterboxd-user-facts.md.
// Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdFacts=(()=>{
 const FACTS_PREFIX='letterboxd/facts/';
 const FACTS_KEYS={links:FACTS_PREFIX+'links.json',conflicts:FACTS_PREFIX+'conflicts.json',filmsList:FACTS_PREFIX+'scans/films-list.json',watchlist:FACTS_PREFIX+'scans/watchlist.json',viewIndex:'enrichment/view-index.json'};
 const SOURCE_RANK={owner:4,letterboxd_films_list:3,letterboxd_film_page:2,letterboxd_watchlist:2,letterboxd_export:1,letterboxd_diary:1};
 const FACT_NAMES=['watched','rating','watchlist'];
 const recordKey=factKey=>FACTS_PREFIX+'films/'+factKey+'.json';
 const LID=/^[A-Za-z0-9_-]{1,80}$/,TMDB=/^[1-9]\d{0,11}$/,ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
 const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));

 class FactsError extends Error{constructor(code,message){super(message||code);this.code=code;}}

 // The record key is chosen once: tmdb-<n> when a trusted TMDB id is known, else lb-<lid>.
 function factKeyFor({letterboxd=null,tmdb=null}={}){
  if(tmdb!=null){if(!TMDB.test(String(tmdb)))throw new FactsError('invalid_identity','Invalid TMDB id');return 'tmdb-'+tmdb;}
  if(letterboxd!=null&&LID.test(String(letterboxd)))return 'lb-'+letterboxd;
  throw new FactsError('invalid_identity','Film has no trusted id');
 }
 function aliasesOf(links={}){return [...(links.letterboxd?['letterboxd:'+links.letterboxd]:[]),...(links.tmdb?['tmdb:'+links.tmdb]:[])];}
 function projectionIds(links={}){return [...(links.letterboxd?[String(links.letterboxd)]:[]),...(links.tmdb?['tmdb_'+links.tmdb]:[])];}
 function emptyRecord(factKey,links){return {schemaVersion:1,factKey,links:{letterboxd:links?.letterboxd??null,tmdb:links?.tmdb!=null?String(links.tmdb):null},redirectTo:null,migrating:null};}

 function validValue(fact,value){
  if(fact==='watched'||fact==='watchlist')return typeof value==='boolean';
  if(fact==='rating')return value===null||Number.isFinite(value)&&value>=.5&&value<=5&&value*2%1===0;
  return false;
 }
 async function sha256(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}

 // One observation of one fact. The id makes a repeated observation a no-op and breaks exact ties deterministically.
 async function observation({factKey,fact,value,observedAt,source,sourceRef=null,effectiveOn=null}){
  if(!FACT_NAMES.includes(fact)||!validValue(fact,value))throw new FactsError('invalid_observation','Invalid '+fact+' value');
  if(typeof observedAt!=='string'||!ISO.test(observedAt)||Number.isNaN(Date.parse(observedAt)))throw new FactsError('invalid_observation','observedAt must be an ISO UTC time');
  if(!Object.hasOwn(SOURCE_RANK,source))throw new FactsError('invalid_observation','Unknown source');
  const observationId=await sha256([factKey,fact,JSON.stringify(value),observedAt,source,sourceRef??''].join('|'));
  return {value,effectiveOn,observedAt,source,sourceRef,observationId};
 }
 // Total order: observedAt, source rank, then the page-read time when both observations are diary ratings of that
 // same instant, then observation id. `ingestedAt` is not part of the observation id, so a reread of the same value is
 // still the same observation. A diary rating stored before this rule has no `ingestedAt` and loses to one that has it;
 // two without it stay on the observation id. Every other source is ordered exactly as before (ADR 0023).
 function diaryReadOrder(a,b){
  if(a.source!=='letterboxd_diary'||b.source!=='letterboxd_diary')return 0;
  const ai=Date.parse(a.ingestedAt||''),bi=Date.parse(b.ingestedAt||'');
  const aOk=Number.isFinite(ai),bOk=Number.isFinite(bi);
  if(aOk&&bOk&&ai!==bi)return ai-bi;
  if(aOk!==bOk)return aOk?1:-1;
  return 0;
 }
 function compareObservations(a,b){
  const t=Date.parse(a.observedAt)-Date.parse(b.observedAt);if(t)return t;
  const r=SOURCE_RANK[a.source]-SOURCE_RANK[b.source];if(r)return r;
  const d=diaryReadOrder(a,b);if(d)return d;
  return a.observationId<b.observationId?-1:a.observationId>b.observationId?1:0;
 }
 const stripReplaced=value=>{if(!value)return null;const {replaced,...rest}=value;return rest;};
 const greater=(a,b)=>!a?b:!b?a:compareObservations(a,b)>=0?a:b;

 // Applies one observation to a record. `floor` is the scan summary's observation of the same fact (ADR-0024): the incoming
 // observation must beat the greater of the stored value and the floor. Returns the outcome; the record is changed in place.
 function applyObservation(record,fact,incoming,{floor=null}={}){
  const stored=record[fact]||null,effective=greater(stored,floor);
  if(effective&&effective.observationId===incoming.observationId)return {outcome:'unchanged',tie:false};
  const tie=!!effective&&effective.observedAt===incoming.observedAt&&JSON.stringify(effective.value)!==JSON.stringify(incoming.value);
  if(effective&&compareObservations(incoming,effective)<0)return {outcome:'older',tie};
  if(stored&&JSON.stringify(stored.value)===JSON.stringify(incoming.value)&&compareObservations(incoming,stored)<=0)return {outcome:'unchanged',tie};
  record[fact]={...incoming,replaced:stripReplaced(stored)};
  if(fact==='rating')recordRatingChange(record,incoming,effective);
  return {outcome:stored?'replaces':'new',tie};
 }
 // Rating history: an append-only list in the record, written in the same compare-and-swap as the fact, so it is never ahead
 // of or behind the current value. An entry is added only when the effective rating changes (a newer observation of the same
 // value is a confirmation, not a change) or when the film's rating is observed for the first time ('first_observed': the
 // value existed before the observation, so it says nothing about when it was given). The observation id keeps it idempotent.
 function recordRatingChange(record,incoming,effective){
  if(effective&&JSON.stringify(effective.value)===JSON.stringify(incoming.value))return;
  const history=Array.isArray(record.ratingHistory)?record.ratingHistory:[];
  const last=history.filter(entry=>entry.observationId===incoming.observationId).at(-1);
  if(last&&last.kind!=='rolled_back')return;
  record.ratingHistory=[...history,{kind:effective?'changed':'first_observed',recordedAt:new Date().toISOString(),value:incoming.value,observedAt:incoming.observedAt,source:incoming.source,sourceRef:incoming.sourceRef??null,observationId:incoming.observationId,previous:effective?{value:effective.value,observedAt:effective.observedAt,source:effective.source,observationId:effective.observationId}:null}];
 }
 // A rollback restores a before-image; the history keeps the rolled-back entry and records the reversal after it.
 function recordRatingRollback(record,observationId,at){
  const history=Array.isArray(record.ratingHistory)?record.ratingHistory:[];
  const last=history.filter(entry=>entry.observationId===observationId).at(-1);
  if(!last||last.kind==='rolled_back')return;
  const restored=record.rating||null;
  record.ratingHistory=[...history,{kind:'rolled_back',recordedAt:at,observationId,at,restored:restored?{value:restored.value,observedAt:restored.observedAt,source:restored.source,observationId:restored.observationId}:null}];
 }
 // Restores the before-image of one export's observation, only while that observation is still current.
 function rollbackFact(record,fact,observationId){
  const current=record[fact];
  if(!current||current.observationId!==observationId)return 'superseded';
  if(current.replaced)record[fact]={...current.replaced,replaced:null};else delete record[fact];
  return 'restored';
 }
 // Reads during a convergence see source and target merged by the same order (contract, "Reads during a migration").
 function overlay(source,target){
  const merged=clone(target||source);
  for(const fact of FACT_NAMES){const winner=greater(source?.[fact]||null,target?.[fact]||null);if(winner)merged[fact]=winner;else delete merged[fact];}
  const history=mergeRatingHistories(source?.ratingHistory,target?.ratingHistory);
  if(history.length)merged.ratingHistory=history;else delete merged.ratingHistory;
  return merged;
 }
 // An entry's identity within its record: the observation it is about, whether it applied or reversed it, and how many times
 // that observation was applied or reversed before (a rollback followed by a re-application is two distinct events).
 function ratingHistoryIdentities(list){
  const seen=new Map();
  return (Array.isArray(list)?list:[]).map(entry=>{const key=(entry.kind==='rolled_back'?'r':'a')+'|'+entry.observationId,n=seen.get(key)||0;seen.set(key,n+1);return {id:key+'|'+n,entry};});
 }
 // The union of two records' histories (a convergence merge, or its overlay read): every distinct event once, ordered by the
 // time the entry was written, then by identity. Idempotent: merging a list with itself or with an earlier merge changes nothing.
 function mergeRatingHistories(left,right){
  const events=new Map();
  for(const {id,entry} of [...ratingHistoryIdentities(left),...ratingHistoryIdentities(right)])if(!events.has(id))events.set(id,entry);
  const time=entry=>entry.recordedAt||entry.at||entry.observedAt||'';
  return [...events.entries()].sort(([a,x],[b,y])=>time(x)<time(y)?-1:time(x)>time(y)?1:a<b?-1:a>b?1:0).map(([,entry])=>clone(entry));
 }

 // What a scan summary says about one Letterboxd id, as observations.
 async function summaryObservations(kind,summary,lid,factKey){
  if(!summary||!lid)return {};
  const base={factKey,observedAt:summary.observedAt,sourceRef:summary.scanId};
  if(kind==='films-list'){
   if(!Object.hasOwn(summary.films||{},lid))return {};
   return {watched:await observation({...base,fact:'watched',value:true,source:'letterboxd_films_list'}),rating:await observation({...base,fact:'rating',value:summary.films[lid],source:'letterboxd_films_list'})};
  }
  if(kind==='watchlist'&&(summary.films||[]).includes(lid))return {watchlist:await observation({...base,fact:'watchlist',value:true,source:'letterboxd_watchlist'})};
  return {};
 }

 // ---- R2 storage. Every write is a compare-and-swap with bounded retries that re-reads and re-applies.
 async function readJSON(env,key){const object=await env.BUCKET.get(key);return object?{value:await object.json(),etag:object.etag}:{value:null,etag:null};}
 async function casJSON(env,key,empty,apply){
  for(let attempt=0;attempt<5;attempt++){
   const {value,etag}=await readJSON(env,key),current=value??clone(empty),next=await apply(clone(current),etag);
   if(next==null)return {value:current,changed:false};
   const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
   if(saved!==null)return {value:next,changed:true};
  }
  throw new FactsError('write_contention','Stored JSON changed during write: '+key);
 }

 // Links a film's trusted aliases to one record key; an alias already pointing elsewhere is an alias_conflict for review.
 async function linkFilm(env,links){
  // Writers always know the Letterboxd id, so no record exists without one and two records of one film can only meet as an
  // alias_conflict; joining them is the convergence migration, which is not implemented in this phase.
  if(!links?.letterboxd||!LID.test(String(links.letterboxd)))throw new FactsError('invalid_identity','A fact record needs a Letterboxd id');
  const aliases=aliasesOf(links);
  let factKey=null;
  await casJSON(env,FACTS_KEYS.links,{},index=>{
   const keys=[...new Set(aliases.map(alias=>index[alias]).filter(Boolean))];
   if(keys.length>1)throw new FactsError('alias_conflict','Aliases point at different records');
   factKey=keys[0]||factKeyFor(links);
   // A record holds one Letterboxd id and one TMDB id: another id of the same kind on it is a conflict, never a merge.
   for(const [alias,key] of Object.entries(index))if(key===factKey&&!aliases.includes(alias)&&aliases.some(mine=>mine.split(':')[0]===alias.split(':')[0]))throw new FactsError('alias_conflict','Record already has another '+alias.split(':')[0]+' id');
   let changed=false;for(const alias of aliases)if(index[alias]!==factKey){index[alias]=factKey;changed=true;}
   return changed?index:null;
  });
  return factKey;
 }
 async function resolveAlias(env,alias){return (await readJSON(env,FACTS_KEYS.links)).value?.[alias]||null;}

 // Writes observations into one record. A redirected record is followed once; a fenced one sends the write to its target.
 async function recordObservations(env,factKey,links,observations,{floors={}}={}){
  let key=factKey;
  for(let hop=0;hop<2;hop++){
   const {value}=await readJSON(env,recordKey(key));
   const next=value?.redirectTo||value?.migrating?.to;
   if(!next)break;
   if(hop===1)throw new FactsError('redirect_chain','Record redirect chain is longer than one hop');
   key=next;
  }
  const outcomes=[];
  const {value:record}=await casJSON(env,recordKey(key),emptyRecord(key,links),current=>{
   if(current.redirectTo||current.migrating)throw new FactsError('write_contention','Record started a migration during write');
   outcomes.length=0;let changed=false;
   for(const [k,v] of Object.entries(links||{}))if(v!=null&&current.links[k]==null){current.links[k]=String(v);changed=true;}
   for(const {fact,observation:incoming} of observations){const result=applyObservation(current,fact,incoming,{floor:floors[fact]||null});outcomes.push({fact,...result});if(result.outcome==='new'||result.outcome==='replaces')changed=true;}
   return changed?current:null;
  });
  return {factKey:key,record,outcomes};
 }

 // The view index is a projection of records under every id of the film; it is never the source of a fact.
 async function projectRecords(env,records){
  if(!records.length)return {changed:0};
  let changed=0;
  await casJSON(env,FACTS_KEYS.viewIndex,{},index=>{
   changed=0;
   for(const record of records)for(const id of projectionIds(record.links)){
    const item={...(index[id]||{})};
    if(record.rating)item.actualRating=record.rating.value;
    if(record.watched)item.watched=record.watched.value;
    if(record.watchlist)item.watchlist=record.watchlist.value;
    if(JSON.stringify(item)!==JSON.stringify(index[id]||{})){index[id]=item;changed++;}
   }
   return changed?index:null;
  });
  return {changed};
 }

 // Stores a complete scan summary only if it is newer than the stored one. Returns the summary it replaced.
 // A summary is published only after the facts it implies are written (staged publication). The stage keeps the summary it
 // will replace, so the films that drop out of a list keep their last observation even after a crash; a retry of the same scan
 // resumes the stage, and a newer scan first finishes an unfinished older one.
 const pendingKey=key=>key.replace(/\.json$/,'.pending.json');
 // The stage also keeps the context its scan saw (the watchlist and its trusted links), so a resumed stage is applied with its own
 // context, never with a newer scan's.
 async function stagedScan(env,key,summary,context,apply){
  const {value:open}=await readJSON(env,pendingKey(key));
  if(open&&!open.done&&open.summary.scanId!==summary.scanId)await finishStage(env,key,open,apply);
  const {value:published}=await readJSON(env,key);
  if(published&&Date.parse(published.observedAt)>=Date.parse(summary.observedAt))return {stored:false};
  let stage=null;
  await casJSON(env,pendingKey(key),null,current=>{
   if(current&&!current.done&&current.summary.scanId===summary.scanId){stage=current;return null;}
   if(current&&!current.done)throw new FactsError('write_contention','Another scan stage opened during write');
   stage={schemaVersion:1,done:false,summary,previous:published||null,context,stagedAt:new Date().toISOString()};return stage;
  });
  return finishStage(env,key,stage,apply);
 }
 async function finishStage(env,key,stage,apply){
  const result=await apply(stage.summary,stage.previous,stage.context||{});
  await casJSON(env,key,null,current=>current&&Date.parse(current.observedAt)>=Date.parse(stage.summary.observedAt)?null:stage.summary);
  await casJSON(env,pendingKey(key),null,current=>current&&!current.done&&current.summary.scanId===stage.summary.scanId?{done:true,scanId:stage.summary.scanId,finishedAt:new Date().toISOString()}:null);
  return {stored:true,...result};
 }
 const linkedLid=(index,lid)=>index['letterboxd:'+lid]||null;
 // Trusted links of current watchlist films: the Letterboxd id and the TMDB id Letterboxd's own film page gives.
 // Only the fields a resumed stage needs: the Letterboxd id and the trusted TMDB id.
 function contextFilms(films){return [...watchlistLinks(films).values()].map(links=>({id:links.letterboxd,tmdbId:links.tmdb}));}
 function watchlistLinks(films){const map=new Map();for(const film of films||[]){const lid=String(film?.id??'');if(!LID.test(lid))continue;const tmdb=film.tmdbId!=null&&TMDB.test(String(film.tmdbId))?String(film.tmdbId):null;map.set(lid,{letterboxd:lid,tmdb});}return map;}

 // Ids that would put a second id of the same kind on a record are never written; they are listed for the identity review.
 async function noteConflict(env,links,reason){
  const id=aliasesOf(links).join(' '),now=new Date().toISOString();
  await casJSON(env,FACTS_KEYS.conflicts,{},current=>{const prior=current[id];current[id]={links:{letterboxd:links?.letterboxd??null,tmdb:links?.tmdb??null},reason,firstSeenAt:prior?.firstSeenAt||now,lastSeenAt:now,count:(prior?.count||0)+1};return current;});
 }
 async function linkOrNote(env,links){
  try{return await linkFilm(env,links);}
  catch(error){if(error.code!=='alias_conflict')throw error;await noteConflict(env,links,'alias_conflict');return null;}
 }

 // A complete public films list (EPG commit or ratings refresh): only records whose value changed, for films that already have a
 // record or are on the current watchlist (ADR-0024). Every step is idempotent, so a resumed stage repeats it safely.
 async function applyFilmsListScan(env,{scanId,observedAt,films,total},{watchlistFilms=[]}={}){
  if(!scanId||!films||typeof films!=='object')throw new FactsError('invalid_scan','Scan summary is incomplete');
  const summary={schemaVersion:1,scanId,observedAt,total:total??Object.keys(films).length,films};
  return stagedScan(env,FACTS_KEYS.filmsList,summary,{watchlistFilms:contextFilms(watchlistFilms)},async(current,previous,context)=>{
   const watchlist=watchlistLinks(context.watchlistFilms);
   const [{value:links},{value:index}]=await Promise.all([readJSON(env,FACTS_KEYS.links),readJSON(env,FACTS_KEYS.viewIndex)]);
   const linkIndex=links||{},view=index||{},records=[],outcomes={};
   const count=list=>{for(const item of list)outcomes[item.outcome]=(outcomes[item.outcome]||0)+1;};
   let carried=0,written=0,conflicts=0;
   // A film the replaced summary listed and this one does not keeps the old observation in its record.
   for(const lid of Object.keys(previous?.films||{})){
    if(Object.hasOwn(current.films,lid))continue;
    const factKey=linkedLid(linkIndex,lid);if(!factKey)continue;
    const old=await summaryObservations('films-list',previous,lid,factKey);
    const result=await recordObservations(env,factKey,{letterboxd:lid},Object.entries(old).map(([fact,o])=>({fact,observation:o})));
    count(result.outcomes);records.push(result.record);if(result.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces'))carried++;
   }
   for(const [lid,rating] of Object.entries(current.films)){
    const known=linkedLid(linkIndex,lid);
    if(!known&&!watchlist.has(lid))continue;
    if(known&&view[lid]?.watched===true&&view[lid]?.actualRating===rating)continue;
    const factKey=known||await linkOrNote(env,watchlist.get(lid));
    if(!factKey){conflicts++;continue;}
    const seen=await summaryObservations('films-list',current,lid,factKey);
    const result=await recordObservations(env,factKey,watchlist.get(lid)||{letterboxd:lid},Object.entries(seen).map(([fact,o])=>({fact,observation:o})));
    count(result.outcomes);records.push(result.record);if(result.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces'))written++;
   }
   await projectRecords(env,records);
   return {written,carried,conflicts,outcomes};
  });
 }

 // A complete watchlist. Listed films become watchlist: true; a film whose projected membership is true and that the list no
 // longer shows becomes watchlist: false. Only changed records are written.
 async function applyWatchlistScan(env,{scanId,observedAt,films}){
  if(!scanId||!Array.isArray(films))throw new FactsError('invalid_scan','Watchlist summary is incomplete');
  const given=contextFilms(films.map(film=>typeof film==='object'?film:{id:film})),summary={schemaVersion:1,scanId,observedAt,films:given.map(film=>film.id)};
  return stagedScan(env,FACTS_KEYS.watchlist,summary,{watchlistFilms:given},async(current,previous,context)=>{
   const byLid=watchlistLinks(context.watchlistFilms);
   const [{value:links},{value:index}]=await Promise.all([readJSON(env,FACTS_KEYS.links),readJSON(env,FACTS_KEYS.viewIndex)]);
   const linkIndex=links||{},view=index||{},set=new Set(current.films),records=[],outcomes={};let written=0,conflicts=0;
   const write=async(lid,value)=>{
    const factKey=linkedLid(linkIndex,lid)||await linkOrNote(env,byLid.get(lid)||{letterboxd:lid});
    if(!factKey){conflicts++;return;}
    const o=await observation({factKey,fact:'watchlist',value,observedAt:current.observedAt,source:'letterboxd_watchlist',sourceRef:current.scanId});
    const result=await recordObservations(env,factKey,byLid.get(lid)||{letterboxd:lid},[{fact:'watchlist',observation:o}]);
    for(const item of result.outcomes)outcomes[item.outcome]=(outcomes[item.outcome]||0)+1;
    records.push(result.record);if(result.outcomes.some(item=>item.outcome==='new'||item.outcome==='replaces'))written++;
   };
   for(const lid of current.films)if(view[lid]?.watchlist!==true)await write(lid,true);
   for(const [id,item] of Object.entries(view))if(item?.watchlist===true&&LID.test(id)&&!set.has(id)&&linkedLid(linkIndex,id))await write(id,false);
   await projectRecords(env,records);
   return {written,conflicts,outcomes};
  });
 }

 // A single observation for one film by its Letterboxd id (per-film page lookup or owner edit). The scan summary's
 // observation is the floor, so a lookup older than the latest scan never overrides it.
 async function recordFilmFacts(env,lid,facts,{observedAt,source,sourceRef=null}){
  const factKey=await linkOrNote(env,{letterboxd:lid});
  if(!factKey)return {factKey:null,record:null,outcomes:[],conflict:true,accepted:false};
  const [{value:filmsList},{value:watchlist}]=await Promise.all([readJSON(env,FACTS_KEYS.filmsList),readJSON(env,FACTS_KEYS.watchlist)]);
  const floors={...await summaryObservations('films-list',filmsList,lid,factKey),...await summaryObservations('watchlist',watchlist,lid,factKey)};
  const observations=[];
  for(const [fact,value] of Object.entries(facts))observations.push({fact,observation:await observation({factKey,fact,value,observedAt,source,sourceRef})});
  const result=await recordObservations(env,factKey,{letterboxd:lid},observations,{floors});
  const accepted=result.outcomes.length>0&&result.outcomes.every(item=>item.outcome==='new'||item.outcome==='replaces'||item.outcome==='unchanged');
  await projectRecords(env,[result.record]);
  return {...result,conflict:false,accepted};
 }

 // AIR-287 (ADR 0054) and ADR 0067: diary evidence as facts, in one batch per diary page. Each film is linked by its
 // Letterboxd id only (one links compare-and-swap for the batch). watched: true and, when the page shows one, the rating
 // are observations at the watched date, so a newer observation from any other source (the films-list floor included)
 // still wins. The rating observation also carries `ingestedAt`, the page-read time (`readAt`, else now): a later read
 // of a different rating on that same date replaces the earlier diary observation, and a late write of an earlier read
 // does not. `ingestedAt` is not part of the observation id, so a reread of the same value is the same observation. A
 // film whose projection already shows the same watched and rating is not written. One view-index projection for the batch.
 async function applyDiaryEvidence(env,evidence){
  const items=(evidence||[]).filter(item=>LID.test(String(item?.lid||''))&&/^\d{4}-\d{2}-\d{2}$/.test(String(item.watchedDate||'')));
  const summary={films:items.length,written:0,unchanged:0,older:0,skipped:0,conflicts:0,ratings:{}};
  if(!items.length)return summary;
  const [{value:viewIndex},{value:filmsList},{value:watchlist}]=await Promise.all([readJSON(env,FACTS_KEYS.viewIndex),readJSON(env,FACTS_KEYS.filmsList),readJSON(env,FACTS_KEYS.watchlist)]);
  const view=viewIndex||{},due=items.filter(item=>!(view[item.lid]?.watched===true&&(item.rating==null||view[item.lid]?.actualRating===item.rating)));
  summary.skipped=items.length-due.length;
  const keys=new Map(),conflicted=[];
  if(due.length)await casJSON(env,FACTS_KEYS.links,{},index=>{
   keys.clear();conflicted.length=0;let changed=false;
   for(const item of due){
    const alias='letterboxd:'+item.lid,known=index[alias];
    if(known){keys.set(item.lid,known);continue;}
    const key=factKeyFor({letterboxd:item.lid});
    if(Object.entries(index).some(([other,value])=>value===key&&other!==alias)){conflicted.push(item.lid);continue;}
    index[alias]=key;keys.set(item.lid,key);changed=true;
   }
   return changed?index:null;
  });
  for(const lid of conflicted){summary.conflicts++;await noteConflict(env,{letterboxd:lid},'alias_conflict');}
  const records=[];
  for(const item of due){
   const factKey=keys.get(item.lid);if(!factKey)continue;
   const base={factKey,observedAt:item.watchedDate+'T00:00:00.000Z',source:'letterboxd_diary',sourceRef:item.sourceRef||null};
   const observations=[{fact:'watched',observation:await observation({...base,fact:'watched',value:true})}];
   if(item.rating!=null){
    const rating=await observation({...base,fact:'rating',value:item.rating});
    const ingestedAt=typeof item.readAt==='string'&&ISO.test(item.readAt)?item.readAt:new Date().toISOString();
    observations.push({fact:'rating',observation:{...rating,ingestedAt}});
   }
   const floors={...await summaryObservations('films-list',filmsList,item.lid,factKey),...await summaryObservations('watchlist',watchlist,item.lid,factKey)};
   const result=await recordObservations(env,factKey,{letterboxd:item.lid},observations,{floors});
   records.push(result.record);
   if(result.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces'))summary.written++;
   else if(result.outcomes.some(o=>o.outcome==='older'))summary.older++;else summary.unchanged++;
  }
  for(const item of items){const record=records.find(r=>r?.links?.letterboxd===item.lid);const value=record?record.rating?.value:view[item.lid]?.actualRating;if(value!=null)summary.ratings[item.lid]=value;}
  await projectRecords(env,records.filter(Boolean));
  return summary;
 }

 // The owner's watched mark on a verified catalog film (ADR-0032) is the one writer that may create a record with only a trusted
 // TMDB alias: the identity is the catalog film the owner marked, never a Letterboxd id, a slug or a title. An existing record
 // that already holds tmdb:<n> is reused; no record is ever merged here.
 async function linkTmdbOnly(env,tmdb){
  if(!TMDB.test(String(tmdb)))throw new FactsError('invalid_identity','Invalid TMDB id');
  const alias='tmdb:'+tmdb;let factKey=null;
  await casJSON(env,FACTS_KEYS.links,{},index=>{factKey=index[alias]||factKeyFor({tmdb});if(index[alias])return null;index[alias]=factKey;return index;});
  return factKey;
 }
 // Writes only the `watched` fact from the owner. A value equal to the current effective value (stored, or the films-list scan
 // summary of a linked Letterboxd id) writes nothing, so a repeated click or a retry is `unchanged`.
 async function recordOwnerWatchedMark(env,tmdb,watched,{observedAt}){
  if(typeof watched!=='boolean')throw new FactsError('invalid_observation','watched must be a boolean');
  let key=await linkTmdbOnly(env,tmdb),{value:record}=await readJSON(env,recordKey(key));
  const next=record?.redirectTo||record?.migrating?.to;
  if(next){key=next;({value:record}=await readJSON(env,recordKey(key)));}
  const lid=record?.links?.letterboxd||null,{value:filmsList}=lid?await readJSON(env,FACTS_KEYS.filmsList):{value:null};
  const floor=(await summaryObservations('films-list',filmsList,lid,key)).watched||null,effective=greater(record?.watched||null,floor);
  if(effective&&effective.value===watched)return {factKey:key,outcome:'unchanged',watched};
  const incoming=await observation({factKey:key,fact:'watched',value:watched,observedAt,source:'owner'});
  const result=await recordObservations(env,key,{tmdb:String(tmdb)},[{fact:'watched',observation:incoming}],{floors:{watched:floor}});
  await projectRecords(env,[result.record]);
  const outcome=result.outcomes[0]?.outcome,current=greater(result.record.watched||null,floor);
  return {factKey:result.factKey,outcome:outcome==='new'||outcome==='replaces'?'saved':outcome==='older'?'older':'unchanged',watched:current?current.value:null};
 }

 // ---- Baseline import (contract "Baseline import protocol"): a permanent owner-only maintenance route behind the Worker's
 // Cloudflare Access, with no switch: the former LETTERBOXD_BASELINE_IMPORT (ADR 0053) and LETTERBOXD_FACTS (ADR 0055) are
 // retired. The routine writers always record facts, so the next sync cannot clear imported ratings by absence.
 const VIEW_FIELDS={rating:'actualRating',watched:'watched',watchlist:'watchlist'};
 const HEX64=/^[0-9a-f]{64}$/,DAY=/^\d{4}-\d{2}-\d{2}$/,MAX_ITEMS=200,MAX_CHUNK=10000;
 const importKey=(sha,chunk,kind)=>FACTS_PREFIX.replace('facts/','imports/')+sha+'/chunks/'+chunk+'.'+kind+'.json';
 // Strict input: the origin binds the request to one archive; items name trusted ids and the facts the export showed.
 function validateBaselineRequest(body,{needItems=true,now=Date.now()}={}){
  const fail=message=>{throw new FactsError('invalid_request',message);};
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Expected a JSON object');
  const origin=body.origin;
  if(!origin||!HEX64.test(String(origin.archiveSha256||'')))fail('origin.archiveSha256 must be a SHA-256');
  if(typeof origin.generatedAt!=='string'||!ISO.test(origin.generatedAt)||Date.parse(origin.generatedAt)>now||Date.parse(origin.generatedAt)<Date.UTC(2011,0,1))fail('origin.generatedAt must be a past ISO UTC time');
  if(!['archive_name','owner_declared'].includes(origin.generatedAtSource))fail('origin.generatedAtSource must be archive_name or owner_declared');
  if(!Number.isInteger(body.chunk)||body.chunk<0||body.chunk>MAX_CHUNK)fail('chunk must be an integer 0..'+MAX_CHUNK);
  if(!needItems)return {origin,chunk:body.chunk,items:[]};
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>MAX_ITEMS)fail('items must hold 1..'+MAX_ITEMS+' films');
  const lids=new Set();
  const items=body.items.map(item=>{
   if(!item||!LID.test(String(item.lid||'')))fail('Invalid Letterboxd id');
   if(lids.has(item.lid))fail('A film appears twice in one chunk');lids.add(item.lid);
   if(item.tmdb!=null&&!TMDB.test(String(item.tmdb)))fail('Invalid TMDB id');
   const facts=item.facts||{},keys=Object.keys(facts);
   if(!keys.length||keys.some(key=>!FACT_NAMES.includes(key)))fail('Unknown or missing facts');
   if('watched' in facts&&facts.watched!==true)fail('An export can only show watched: true');
   if('watchlist' in facts&&facts.watchlist!==true)fail('An export can only show watchlist: true');
   if('rating' in facts&&!validValue('rating',facts.rating))fail('Invalid rating');
   if('rating' in facts&&facts.watched!==true)fail('A rating or "not rated" row is also watched');
   const effectiveOn={};for(const [fact,day] of Object.entries(item.effectiveOn||{})){if(!FACT_NAMES.includes(fact)||!DAY.test(String(day)))fail('Invalid effectiveOn');effectiveOn[fact]=day;}
   return {lid:String(item.lid),tmdb:item.tmdb!=null?String(item.tmdb):null,facts,effectiveOn};
  });
  return {origin,chunk:body.chunk,items};
 }
 const itemsHash=async items=>sha256(JSON.stringify(items));
 async function exportObservations(factKey,item,origin){
  const list=[];
  for(const fact of FACT_NAMES)if(fact in item.facts)list.push({fact,observation:await observation({factKey,fact,value:item.facts[fact],observedAt:origin.generatedAt,source:'letterboxd_export',sourceRef:origin.archiveSha256,effectiveOn:item.effectiveOn[fact]??null})});
  return list;
 }
 async function floorsFor(env,lid,factKey){
  const [{value:filmsList},{value:watchlist}]=await Promise.all([readJSON(env,FACTS_KEYS.filmsList),readJSON(env,FACTS_KEYS.watchlist)]);
  return {...await summaryObservations('films-list',filmsList,lid,factKey),...await summaryObservations('watchlist',watchlist,lid,factKey)};
 }
 // The record key the link index would give these ids, or alias_conflict, without writing.
 function plannedKey(index,links){
  const aliases=aliasesOf(links),keys=[...new Set(aliases.map(alias=>index[alias]).filter(Boolean))];
  if(keys.length>1)return null;
  const key=keys[0]||factKeyFor(links);
  for(const [alias,value] of Object.entries(index))if(value===key&&!aliases.includes(alias)&&aliases.some(mine=>mine.split(':')[0]===alias.split(':')[0]))return null;
  return key;
 }
 const tally=(counts,outcomes)=>{for(const item of outcomes)counts[item.outcome]=(counts[item.outcome]||0)+1;if(outcomes.some(item=>item.tie))counts.tie=(counts.tie||0)+outcomes.filter(item=>item.tie).length;};

 // Validate: what a commit of this chunk would do now, with no write.
 async function previewBaselineChunk(env,body){
  const {origin,chunk,items}=validateBaselineRequest(body);
  const {value:links}=await readJSON(env,FACTS_KEYS.links),index=links||{},counts={},films={conflict:0,planned:0};
  for(const item of items){
   const factKey=plannedKey(index,{letterboxd:item.lid,tmdb:item.tmdb});
   if(!factKey){films.conflict++;continue;}
   films.planned++;
   const {value:stored}=await readJSON(env,recordKey(factKey)),record=clone(stored)||emptyRecord(factKey,{letterboxd:item.lid,tmdb:item.tmdb}),floors=await floorsFor(env,item.lid,factKey);
   tally(counts,(await exportObservations(factKey,item,origin)).map(({fact,observation:o})=>({fact,...applyObservation(record,fact,o,{floor:floors[fact]||null})})));
  }
  return {chunk,films,outcomes:counts};
 }

 // Commit: intent (with the projection's before-image) before any write, idempotent fact writes, receipt after read-back.
 async function commitBaselineChunk(env,body){
  const {origin,chunk,items}=validateBaselineRequest(body),hash=await itemsHash(items),sha=origin.archiveSha256;
  const {value:receipt}=await readJSON(env,importKey(sha,chunk,'receipt'));
  if(receipt){if(receipt.itemsHash!==hash)throw new FactsError('chunk_conflict','This chunk was committed with other items');return {...receipt,replay:true};}
  const {value:view}=await readJSON(env,FACTS_KEYS.viewIndex);
  const before={};for(const item of items)for(const id of projectionIds({letterboxd:item.lid,tmdb:item.tmdb})){const entry=view?.[id]||{};before[id]=Object.fromEntries(Object.values(VIEW_FIELDS).filter(field=>Object.hasOwn(entry,field)).map(field=>[field,entry[field]]));}
  let intent=null;
  await casJSON(env,importKey(sha,chunk,'intent'),null,current=>{
   if(current){if(current.itemsHash!==hash)throw new FactsError('chunk_conflict','This chunk was opened with other items');intent=current;return null;}
   intent={schemaVersion:1,archiveSha256:sha,chunk,itemsHash:hash,origin,films:items.map(item=>item.lid),viewBefore:before,openedAt:new Date().toISOString()};return intent;
  });
  const counts={},films=[],records=[];let conflicts=0;
  for(const item of items){
   const links={letterboxd:item.lid,tmdb:item.tmdb},factKey=await linkOrNote(env,links);
   if(!factKey){conflicts++;films.push({lid:item.lid,factKey:null,conflict:true});continue;}
   const observations=await exportObservations(factKey,item,origin),result=await recordObservations(env,factKey,links,observations,{floors:await floorsFor(env,item.lid,factKey)});
   tally(counts,result.outcomes);records.push(result.record);
   films.push({lid:item.lid,factKey:result.factKey,observations:observations.map(({fact,observation:o})=>({fact,observationId:o.observationId,observation:o})),outcomes:result.outcomes});
  }
  await projectRecords(env,records);
  // Read back: every fact this import made current is still current, or a greater observation replaced it.
  for(const film of films.filter(film=>!film.conflict)){
   const {value:stored}=await readJSON(env,recordKey(film.factKey));
   for(const {fact,outcome} of film.outcomes){
    if(outcome!=='new'&&outcome!=='replaces')continue;
    const mine=film.observations.find(item=>item.fact===fact),current=stored?.[fact];
    if(!current||current.observationId!==mine.observationId&&compareObservations(current,mine.observation)<=0)throw new FactsError('readback_failed','Fact '+fact+' is not current after commit');
   }
  }
  const entries=films.map(film=>film.conflict?film:{...film,observations:film.observations.map(({fact,observationId})=>({fact,observationId}))});
  const next={schemaVersion:1,archiveSha256:sha,chunk,itemsHash:hash,origin,committedAt:new Date().toISOString(),films:films.length,conflicts,outcomes:counts,entries,viewBefore:intent.viewBefore};
  await casJSON(env,importKey(sha,chunk,'receipt'),null,current=>current?null:next);
  return {...next,replay:false};
 }

 // Rollback of one committed chunk: restore each fact's before-image only while this export's observation is current,
 // and the projection's before-image only for fields this rollback left without a fact.
 // Rollback of one committed chunk, crash-recoverable: a create-only rollback intent first fixes the plan, per fact, from the
 // receipt (the export's observation and the view fields it projected). Each step then converges to that plan and is safe to
 // repeat: a fact whose export observation is still current is restored to its before-image (or removed when the import created
 // it); one already restored by an earlier attempt counts as restored; one a later writer replaced is superseded and kept.
 // View fields of a removed fact return to the commit's before-image unless the record holds that fact again.
 async function rollbackBaselineChunk(env,body){
  const {origin,chunk}=validateBaselineRequest(body,{needItems:false}),sha=origin.archiveSha256;
  const {value:done}=await readJSON(env,importKey(sha,chunk,'rollback'));if(done)return {...done,replay:true};
  const {value:receipt}=await readJSON(env,importKey(sha,chunk,'receipt'));
  if(!receipt)throw new FactsError('not_committed','This chunk has no receipt');
  let plan=null;
  await casJSON(env,importKey(sha,chunk,'rollback-intent'),null,current=>{
   if(current){plan=current;return null;}
   plan={schemaVersion:1,archiveSha256:sha,chunk,openedAt:new Date().toISOString(),viewBefore:receipt.viewBefore||{},
    facts:receipt.entries.filter(entry=>!entry.conflict).flatMap(entry=>entry.observations.map(({fact,observationId})=>({factKey:entry.factKey,fact,observationId})))};
   return plan;
  });
  const counts={restored:0,superseded:0},records=new Map(),removed=[];
  for(const factKey of [...new Set(plan.facts.map(item=>item.factKey))]){
   const items=plan.facts.filter(item=>item.factKey===factKey),outcome=new Map();
   const {value:record}=await casJSON(env,recordKey(factKey),null,current=>{
    if(!current)return null;
    outcome.clear();let changed=false;
    for(const {fact,observationId} of items){
     const now=current[fact];
     if(now?.observationId===observationId){
      // Roll back now, and leave a marker so a repeated attempt recognizes this fact as already rolled back.
      rollbackFact(current,fact,observationId);changed=true;
      if(fact==='rating')recordRatingRollback(current,observationId,new Date().toISOString());
      if(current[fact]){current[fact].rolledBackFrom=observationId;outcome.set(fact,'restored');}
      else{current.rolledBack={...(current.rolledBack||{}),[fact]:observationId};outcome.set(fact,'removed');}
     }
     else if(now&&now.rolledBackFrom===observationId)outcome.set(fact,'restored');
     else if(!now&&current.rolledBack?.[fact]===observationId)outcome.set(fact,'removed');
     else outcome.set(fact,'superseded');
    }
    return changed?current:null;
   });
   if(!record)continue;
   records.set(factKey,record);
   for(const [fact,result] of outcome){if(result==='superseded')counts.superseded++;else{counts.restored++;if(result==='removed')removed.push({factKey,fact,links:record.links});}}
  }
  await projectRecords(env,[...records.values()]);
  if(removed.length)await casJSON(env,FACTS_KEYS.viewIndex,{},view=>{
   let changed=false;
   for(const {factKey,fact,links} of removed){
    if(records.get(factKey)?.[fact])continue;
    for(const id of projectionIds(links)){
     const field=VIEW_FIELDS[fact],prior=plan.viewBefore?.[id]||{},item={...(view[id]||{})};
     if(Object.hasOwn(prior,field))item[field]=prior[field];else delete item[field];
     if(JSON.stringify(item)!==JSON.stringify(view[id]||{})){view[id]=item;changed=true;}
    }
   }
   return changed?view:null;
  });
  const result={schemaVersion:1,archiveSha256:sha,chunk,rolledBackAt:new Date().toISOString(),facts:counts};
  await casJSON(env,importKey(sha,chunk,'rollback'),null,current=>current?null:result);
  return {...result,replay:false};
 }

 // Owner-only route (the whole Worker is behind Cloudflare Access); every production commit or rollback is a separate owner-approved operation.
 async function handleBaselineRequest(request,env,pathname){
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!/^application\/json\b/i.test(request.headers.get('Content-Type')||''))return json({error:'Expected application/json'},415);
  let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
  const action=pathname.slice('/api/letterboxd/baseline/'.length);
  try{
   if(action==='validate')return json(await previewBaselineChunk(env,body));
   if(action==='commit')return json(await commitBaselineChunk(env,body));
   if(action==='rollback')return json(await rollbackBaselineChunk(env,body));
   return json({error:'Not found'},404);
  }catch(error){
   if(error instanceof FactsError){const status={invalid_request:400,invalid_observation:400,invalid_identity:400,chunk_conflict:409,not_committed:409}[error.code]||500;return json({error:error.message,code:error.code},status);}
   throw error;
  }
 }
 return {FACTS_KEYS,applyDiaryEvidence,validateBaselineRequest,previewBaselineChunk,commitBaselineChunk,rollbackBaselineChunk,handleBaselineRequest,SOURCE_RANK,FACT_NAMES,recordKey,FactsError,factKeyFor,aliasesOf,projectionIds,emptyRecord,observation,compareObservations,applyObservation,rollbackFact,overlay,mergeRatingHistories,summaryObservations,linkFilm,resolveAlias,recordObservations,projectRecords,applyFilmsListScan,applyWatchlistScan,recordFilmFacts,linkTmdbOnly,recordOwnerWatchedMark};
})();
