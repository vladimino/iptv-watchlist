// Letterboxd user facts (ADR-0023, ADR-0024): watched, rating and watchlist per film, each a timestamped observation with
// provenance. Only a greater observation replaces a value; absence from a list is not an observation; a complete scan is
// stored once as a summary observation of every film it shows. Contract: docs/reference/integrations/letterboxd-user-facts.md.
// Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdFacts=(()=>{
 const FACTS_PREFIX='letterboxd/facts/';
 const FACTS_KEYS={links:FACTS_PREFIX+'links.json',filmsList:FACTS_PREFIX+'scans/films-list.json',watchlist:FACTS_PREFIX+'scans/watchlist.json',viewIndex:'enrichment/view-index.json'};
 const SOURCE_RANK={owner:4,letterboxd_films_list:3,letterboxd_film_page:2,letterboxd_watchlist:2,letterboxd_export:1};
 const FACT_NAMES=['watched','rating','watchlist'];
 const factsEnabled=env=>env?.LETTERBOXD_FACTS==='on';
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
 // Total order (observedAt, source rank, observation id).
 function compareObservations(a,b){
  const t=Date.parse(a.observedAt)-Date.parse(b.observedAt);if(t)return t;
  const r=SOURCE_RANK[a.source]-SOURCE_RANK[b.source];if(r)return r;
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
  return {outcome:stored?'replaces':'new',tie};
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
  return merged;
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
  const aliases=aliasesOf(links);if(!aliases.length)throw new FactsError('invalid_identity','Film has no trusted id');
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
 async function storeSummary(env,key,summary){
  let previous=null,stored=false;
  await casJSON(env,key,null,current=>{
   previous=current;stored=false;
   if(current&&Date.parse(current.observedAt)>=Date.parse(summary.observedAt))return null;
   stored=true;return summary;
  });
  return {stored,previous};
 }
 const linkedLid=(index,lid)=>index['letterboxd:'+lid]||null;
 // Trusted links of current watchlist films: the Letterboxd id and the TMDB id Letterboxd's own film page gives.
 function watchlistLinks(films){const map=new Map();for(const film of films||[]){const lid=String(film?.id??'');if(!LID.test(lid))continue;const tmdb=film.tmdbId!=null&&TMDB.test(String(film.tmdbId))?String(film.tmdbId):null;map.set(lid,{letterboxd:lid,tmdb});}return map;}

 // A complete public films list (EPG commit or ratings refresh). Writes the summary, then only records whose value changed,
 // for films that already have a record or are on the current watchlist (ADR-0024).
 async function applyFilmsListScan(env,{scanId,observedAt,films,total},{watchlistFilms=[]}={}){
  if(!scanId||!films||typeof films!=='object')throw new FactsError('invalid_scan','Scan summary is incomplete');
  const summary={schemaVersion:1,scanId,observedAt,total:total??Object.keys(films).length,films};
  const {stored,previous}=await storeSummary(env,FACTS_KEYS.filmsList,summary);
  if(!stored)return {stored:false,written:0,carried:0,outcomes:{}};
  const [{value:links},{value:index}]=await Promise.all([readJSON(env,FACTS_KEYS.links),readJSON(env,FACTS_KEYS.viewIndex)]);
  const linkIndex=links||{},view=index||{},watchlist=watchlistLinks(watchlistFilms),records=[],outcomes={};
  const count=list=>{for(const item of list)outcomes[item.outcome]=(outcomes[item.outcome]||0)+1;};
  let carried=0,written=0,conflicts=0;
  // A film the old summary listed and the new one does not keeps the old observation in its record.
  for(const lid of Object.keys(previous?.films||{})){
   if(Object.hasOwn(films,lid))continue;
   const factKey=linkedLid(linkIndex,lid);if(!factKey)continue;
   const old=await summaryObservations('films-list',previous,lid,factKey);
   const result=await recordObservations(env,factKey,{letterboxd:lid},Object.entries(old).map(([fact,o])=>({fact,observation:o})));
   count(result.outcomes);if(result.outcomes.some(o=>o.outcome!=='older'&&o.outcome!=='unchanged')){carried++;records.push(result.record);}
  }
  for(const [lid,rating] of Object.entries(films)){
   const known=linkedLid(linkIndex,lid);
   if(!known&&!watchlist.has(lid))continue;
   if(known&&view[lid]?.watched===true&&view[lid]?.actualRating===rating)continue;
   let factKey=known;
   if(!factKey){try{factKey=await linkFilm(env,watchlist.get(lid));}catch(error){if(error.code!=='alias_conflict')throw error;conflicts++;continue;}}
   const seen=await summaryObservations('films-list',summary,lid,factKey);
   const result=await recordObservations(env,factKey,watchlist.get(lid)||{letterboxd:lid},Object.entries(seen).map(([fact,o])=>({fact,observation:o})));
   count(result.outcomes);if(result.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces')){written++;records.push(result.record);}
  }
  await projectRecords(env,records);
  return {stored:true,written,carried,conflicts,outcomes};
 }

 // A complete watchlist. Listed films become watchlist: true; a film whose projected membership is true and that the list no
 // longer shows becomes watchlist: false. Only changed records are written.
 async function applyWatchlistScan(env,{scanId,observedAt,films}){
  if(!scanId||!Array.isArray(films))throw new FactsError('invalid_scan','Watchlist summary is incomplete');
  const byLid=watchlistLinks(films.map(film=>typeof film==='object'?film:{id:film})),listed=[...byLid.keys()],summary={schemaVersion:1,scanId,observedAt,films:listed};
  const {stored}=await storeSummary(env,FACTS_KEYS.watchlist,summary);
  if(!stored)return {stored:false,written:0,outcomes:{}};
  const [{value:links},{value:index}]=await Promise.all([readJSON(env,FACTS_KEYS.links),readJSON(env,FACTS_KEYS.viewIndex)]);
  const linkIndex=links||{},view=index||{},set=new Set(listed),records=[],outcomes={};let written=0,conflicts=0;
  const write=async(lid,value)=>{
   let factKey=linkedLid(linkIndex,lid);
   if(!factKey){try{factKey=await linkFilm(env,byLid.get(lid)||{letterboxd:lid});}catch(error){if(error.code!=='alias_conflict')throw error;conflicts++;return;}}
   const o=await observation({factKey,fact:'watchlist',value,observedAt,source:'letterboxd_watchlist',sourceRef:scanId});
   const result=await recordObservations(env,factKey,byLid.get(lid)||{letterboxd:lid},[{fact:'watchlist',observation:o}]);
   for(const item of result.outcomes)outcomes[item.outcome]=(outcomes[item.outcome]||0)+1;
   if(result.outcomes.some(item=>item.outcome==='new'||item.outcome==='replaces')){written++;records.push(result.record);}
  };
  for(const lid of listed)if(view[lid]?.watchlist!==true)await write(lid,true);
  for(const [id,item] of Object.entries(view))if(item?.watchlist===true&&LID.test(id)&&!set.has(id)&&linkedLid(linkIndex,id))await write(id,false);
  await projectRecords(env,records);
  return {stored:true,written,conflicts,outcomes};
 }

 // A single observation for one film by its Letterboxd id (per-film page lookup or owner edit). The scan summary's
 // observation is the floor, so a lookup older than the latest scan never overrides it.
 async function recordFilmFacts(env,lid,facts,{observedAt,source,sourceRef=null}){
  const factKey=await linkFilm(env,{letterboxd:lid});
  const [{value:filmsList},{value:watchlist}]=await Promise.all([readJSON(env,FACTS_KEYS.filmsList),readJSON(env,FACTS_KEYS.watchlist)]);
  const floors={...await summaryObservations('films-list',filmsList,lid,factKey),...await summaryObservations('watchlist',watchlist,lid,factKey)};
  const observations=[];
  for(const [fact,value] of Object.entries(facts))observations.push({fact,observation:await observation({factKey,fact,value,observedAt,source,sourceRef})});
  const result=await recordObservations(env,factKey,{letterboxd:lid},observations,{floors});
  if(result.outcomes.some(item=>item.outcome==='new'||item.outcome==='replaces'))await projectRecords(env,[result.record]);
  return result;
 }
 return {FACTS_KEYS,SOURCE_RANK,FACT_NAMES,factsEnabled,recordKey,FactsError,factKeyFor,aliasesOf,projectionIds,emptyRecord,observation,compareObservations,applyObservation,rollbackFact,overlay,summaryObservations,linkFilm,resolveAlias,recordObservations,projectRecords,applyFilmsListScan,applyWatchlistScan,recordFilmFacts};
})();
