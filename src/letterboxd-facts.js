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
// value existed before the observation, so it says nothing about when it was given). Idempotency is the transition at the
// tail, not the observation id: `ingestedAt` is outside that id, so a later read can return to a value already in the list
// and that return is a new `changed`. A compare-and-swap retry of the transition just written is already the tail and adds
// nothing. Historical `rolled_back` entries (written before AIR-558) are read and merged, never written.
function recordRatingChange(record,incoming,effective){
 if(effective&&JSON.stringify(effective.value)===JSON.stringify(incoming.value))return;
 const history=Array.isArray(record.ratingHistory)?record.ratingHistory:[];
 const tail=history.at(-1),previousId=effective?.observationId??null;
 if(tail&&tail.kind!=='rolled_back'&&tail.observationId===incoming.observationId&&(tail.previous?.observationId??null)===previousId)return;
 record.ratingHistory=[...history,{kind:effective?'changed':'first_observed',recordedAt:new Date().toISOString(),value:incoming.value,observedAt:incoming.observedAt,source:incoming.source,sourceRef:incoming.sourceRef??null,observationId:incoming.observationId,previous:effective?{value:effective.value,observedAt:effective.observedAt,source:effective.source,observationId:effective.observationId}:null}];
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
 // that observation was applied or reversed before (historical rolled_back entries are distinct events).
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

 // ---- Storage. While the ratings marker is r2, every write is an R2 compare-and-swap.
 // Once it is d1 and cutover open, the same keys are D1 documents and do not fall back (ADR 0084).
 // The stored object as it is, for the compare-and-swap writers (the view index is not one of them: AIR-558).
 async function readRawJSON(env,key){
  if(typeof RatingsD1!=='undefined'&&RatingsD1.ratingsMutableKey(key)){const owned=await RatingsD1.readOwned(env,key);if(owned.owned)return {value:owned.value,etag:owned.etag};}
  const object=await env.BUCKET.get(key);let value=object?await object.json():null;
  return {value,etag:object?.etag??null};
 }
 // The reader of the scans and the Diary projection. ADR 0183 / AIR-558: the view index is the ratings_view aliases only (this path has only ever
 // applied the ratings overlay, never the prediction one) and the raw object is not read; the version is the D1 token. Writers do not use this: see casJSON.
 async function readJSON(env,key){
  if(key===FACTS_KEYS.viewIndex)return {value:await derivedViewIndex(env,{ratingsOnly:true}),etag:await viewIndexD1Version(env)};
  return readRawJSON(env,key);
 }
 async function casJSON(env,key,empty,apply,{extra=[]}={}){
  if(typeof RatingsD1!=='undefined'&&RatingsD1.ratingsMutableKey(key)){
   try{const owned=await RatingsD1.casOwned(env,key,empty,apply,{extra});if(owned.owned)return owned.result;}
   catch(error){if(error.code==='write_contention')throw new FactsError('write_contention','Stored JSON changed during write: '+key);throw error;}
  }
  // AIR-599: statements that must commit with the document exist only on the D1-owned store; the R2 stand-in has no batch, so such a write is refused whole, never half done.
  if(extra.length)throw new FactsError('atomic_unavailable','The document store cannot commit the write atomically');
  if(key===FACTS_KEYS.viewIndex)throw new FactsError('view_index_not_owned','The view index has no raw store; it is written only through the D1 ratings domain');
  for(let attempt=0;attempt<5;attempt++){
   const {value,etag}=await readRawJSON(env,key),current=value??clone(empty),next=await apply(clone(current),etag);
   if(next==null)return {value:current,changed:false};
   // AIR-602 / ADR 0207 decision 1: the one R2 object of the admission coordination is written only while the marker, read FRESH here, proves `r2` or proves the migration absent. The guard is the last
   // awaited step before the PUT; `closed`, `d1` and an unreadable marker refuse. (A PUT already past this check cannot be recalled: the activation compares the object before the flip.)
   if(key==='letterboxd/admissions/verified-films.json'&&typeof LetterboxdAdmissionAuthority!=='undefined')await LetterboxdAdmissionAuthority.guardLegacyWrite(env);
   const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
   if(saved!==null)return {value:next,changed:true};
  }
  throw new FactsError('write_contention','Stored JSON changed during write: '+key);
 }

 // Links a film's trusted aliases to one record key; an alias already pointing elsewhere is an alias_conflict for review.
 // `expectKey` (AIR-559): the record key an inferred import has already marked; a key that moved meanwhile is refused as an alias_conflict, so an inferred alias never lands on an unmarked record.
 async function linkFilm(env,links,{expectKey=null}={}){
  // Writers always know the Letterboxd id, so no record exists without one and two records of one film can only meet as an
  // alias_conflict; joining them is the convergence migration, which is not implemented in this phase.
  if(!links?.letterboxd||!LID.test(String(links.letterboxd)))throw new FactsError('invalid_identity','A fact record needs a Letterboxd id');
  const aliases=aliasesOf(links);
  let factKey=null;
  await casJSON(env,FACTS_KEYS.links,{},index=>{
   const keys=[...new Set(aliases.map(alias=>index[alias]).filter(Boolean))];
   if(keys.length>1)throw new FactsError('alias_conflict','Aliases point at different records');
   factKey=keys[0]||factKeyFor(links);
   if(expectKey&&factKey!==expectKey)throw new FactsError('alias_conflict','The record key moved since the inferred pair was marked');
   // A record holds one Letterboxd id and one TMDB id: another id of the same kind on it is a conflict, never a merge.
   for(const [alias,key] of Object.entries(index))if(key===factKey&&!aliases.includes(alias)&&aliases.some(mine=>mine.split(':')[0]===alias.split(':')[0]))throw new FactsError('alias_conflict','Record already has another '+alias.split(':')[0]+' id');
   let changed=false;for(const alias of aliases)if(index[alias]!==factKey){index[alias]=factKey;changed=true;}
   return changed?index:null;
  });
  return factKey;
 }
 async function resolveAlias(env,alias){return (await readJSON(env,FACTS_KEYS.links)).value?.[alias]||null;}
 // The effective confirmed rating for one Letterboxd id (ADR 0023, ADR 0077). The view index is not a source.
 // The winner is the greater of the stored rating and the films-list floor. Null and absence are not a rating.
 async function confirmedFilmRating(env,lid,cache){
  if(!LID.test(String(lid||'')))return null;
  const links=cache?cache.links:(await readJSON(env,FACTS_KEYS.links)).value;
  let key=links?.['letterboxd:'+lid]||null;if(!key)return null;
  let record=null;
  for(let hop=0;hop<2;hop++){
   record=(await readJSON(env,recordKey(key))).value;
   const next=record?.redirectTo||record?.migrating?.to;
   if(!next)break;
   if(hop===1)return null;
   key=next;
  }
  if(!record)return null;
  const filmsList=cache?cache.filmsList:(await readJSON(env,FACTS_KEYS.filmsList)).value;
  const floor=(await summaryObservations('films-list',filmsList,String(lid),key)).rating||null;
  const effective=greater(record.rating||null,floor),rating=Number(effective?.value);
  return Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0?rating:null;
 }

 // AIR-559: the durable provenance of inferred Letterboxd-to-TMDB pairs on a fact record, `inferredPairs`: an APPEND-ONLY list with one entry per exact pair an inferred import attempted or linked on this
 // record (never replaced, never removed, never lifted by a later verification). The claim planner refuses a pair that has an entry (a title/year match is not proof of the lid). A record holds one lid and one
 // movie, so the list stays tiny; above INFERRED_PAIRS_MAX, or when it is unreadable, a new inferred pair is refused (fail closed), never written over.
 const INFERRED_PAIRS_MAX=8;
 const inferredPair=(identity,links)=>({kind:identity.kind,basis:identity.basis,sourceRef:identity.sourceRef,letterboxd:String(links.letterboxd),tmdb:String(links.tmdb)});
 const namesPair=(entry,links)=>!!entry&&typeof entry==='object'&&entry.letterboxd===String(links.letterboxd)&&String(entry.tmdb)===String(links.tmdb);
 const statesPair=(record,links)=>record?.links?.letterboxd===String(links.letterboxd)&&record?.links?.tmdb===String(links.tmdb);
 // Adds the pair's entry to `current` (mutates); returns true when it changed. Throws when the list is unreadable or full: an inferred pair is never linked without its own entry.
 function addInferredPair(current,identity,links){
  const list=current.inferredPairs;
  if(list!==undefined&&!Array.isArray(list))throw new FactsError('alias_conflict','Unreadable inferred pair provenance');
  if((list||[]).some(entry=>namesPair(entry,links)))return false;
  if((list||[]).length>=INFERRED_PAIRS_MAX)throw new FactsError('alias_conflict','Too many inferred pairs on one record');
  current.inferredPairs=[...(list||[]),inferredPair(identity,links)];
  return true;
 }
 // Marks the record an inferred pair is about to be linked to, BEFORE the alias exists, and reads the mark back, so no reader can ever see that alias on a record without the entry for THIS pair (a crash between
 // the alias and the facts, or another writer completing the record's ids from the index, cannot launder it, and an earlier failed pair's entry never stands in for it). A record that already states exactly this
 // pair without an entry was linked independently before and is preserved unmarked. Idempotent. Returns false (refuse the link) when the entry cannot be written or read back.
 async function markInferredPair(env,key,links,identity){
  try{
   await casJSON(env,recordKey(key),emptyRecord(key,{}),current=>{
    if(current.redirectTo||current.migrating)throw new FactsError('write_contention','Record started a migration during write');
    // The list's shape is checked before it is read, so a malformed historical value is a typed refusal (alias_conflict), never a TypeError.
    if(current.inferredPairs!==undefined&&!Array.isArray(current.inferredPairs))throw new FactsError('alias_conflict','Unreadable inferred pair provenance');
    if(statesPair(current,links)&&!current.inferredPairs?.some(entry=>namesPair(entry,links)))return null;
    return addInferredPair(current,identity,links)?current:null;
   });
  }catch(error){if(error instanceof FactsError&&error.code==='alias_conflict')return false;throw error;}
  // Read back at the write boundary: the entry of THIS pair is stored (or the record states the pair independently); entries are never removed, so the alias written next cannot outrun it.
  const {value:back}=await readJSON(env,recordKey(key));
  if(!back||back.inferredPairs!==undefined&&!Array.isArray(back.inferredPairs))return false;
  return (back.inferredPairs||[]).some(entry=>namesPair(entry,links))||statesPair(back,links);
 }
 // Writes observations into one record. A redirected record is followed once; a fenced one sends the write to its target.
 async function recordObservations(env,factKey,links,observations,{floors={},identity=null}={}){
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
   // An inferred identity (AIR-388, ADR 0104) is recorded on the record that first receives the Letterboxd id: a fresh record, or an
   // existing one that had no Letterboxd id. A record that already holds facts and a Letterboxd id keeps whatever it had, so a
   // verified record is never relabelled, and a replay (the identity is already there) changes nothing.
   const untouched=!current.watched&&!current.rating&&!current.watchlist,letterboxdMissing=current.links.letterboxd==null;
   // AIR-559: the PAIR an inferred write completes (it fills the record's Letterboxd or TMDB id) gets its own `inferredPairs` entry in the same compare-and-swap, also on a record that already held facts
   // and a Letterboxd id (a Diary-first record gaining an inferred TMDB id). A record that already stated both ids gains nothing: that pair was linked independently before.
   const fillsPair=Object.entries(links||{}).some(([k,v])=>v!=null&&current.links[k]==null);
   if(identity&&fillsPair&&links?.letterboxd!=null&&links?.tmdb!=null&&addInferredPair(current,identity,links))changed=true;
   for(const [k,v] of Object.entries(links||{}))if(v!=null&&current.links[k]==null){current.links[k]=String(v);changed=true;}
   if(identity&&!current.identity&&(untouched||letterboxdMissing)){current.identity={kind:identity.kind,basis:identity.basis,sourceRef:identity.sourceRef};changed=true;}
   for(const {fact,observation:incoming} of observations){const result=applyObservation(current,fact,incoming,{floor:floors[fact]||null});outcomes.push({fact,...result});if(result.outcome==='new'||result.outcome==='replaces')changed=true;}
   return changed?current:null;
  });
  return {factKey:key,record,outcomes};
 }

 // The view index is a projection of records under every id of the film; it is never the source of a fact.
 async function projectRecords(env,records){
  if(typeof RatingsD1!=='undefined'){const projected=await RatingsD1.projectView(env,records);if(projected.owned)return {changed:projected.changed};}
  // AIR-558: the view index has no raw object any more, so a ratings domain that does not own the projection (marker not d1 and open) projects nothing. The
  // facts stay the source of truth and the callers keep their gates (a held domain is reported as blocked); the former raw projection was invisible there.
  return {changed:0};
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
 async function linkOrNote(env,links,options){
  try{return await linkFilm(env,links,options);}
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
 // AIR-393: what a Diary page is about to change, read from the view index before anything is written (a new watched fact, or a different
 // rating). The ratings run saves this plan on its record before applying the page, so a crash after the facts are written cannot lose it.
 async function planDiaryChanges(env,evidence){
  const items=(evidence||[]).filter(item=>LID.test(String(item?.lid||''))&&/^\d{4}-\d{2}-\d{2}$/.test(String(item.watchedDate||'')));
  if(!items.length)return [];
  const {value:viewIndex}=await readJSON(env,FACTS_KEYS.viewIndex),view=viewIndex||{},out=[];
  for(const item of items){
   const before=view[item.lid]||{};
   if(before.watched===true&&(item.rating==null||before.actualRating===item.rating))continue;
   const previous=typeof before.actualRating==='number'&&Number.isFinite(before.actualRating)?before.actualRating:null;
   if(before.watched!==true)out.push({lid:item.lid,kind:'added',rating:item.rating??null});
   else if(item.rating!=null&&previous!==item.rating)out.push({lid:item.lid,kind:'updated',from:previous,rating:item.rating});
  }
  return out;
 }
 // AIR-393: which planned effects the stored view really shows now. A replay of a page cannot tell its own earlier writes from none, but it can
// tell whether the effect is there: a film is watched, or carries exactly the planned rating. Another writer's different value, or a write the
// page lost as older, is not confirmed.
 async function confirmDiaryEffects(env,groups){
  const {value}=await readJSON(env,FACTS_KEYS.viewIndex),view=value||{};
  return {added:(groups?.added||[]).filter(item=>view[item.id]?.watched===true),updated:(groups?.updated||[]).filter(item=>view[item.id]?.actualRating===item.rating)};
 }
 async function applyDiaryEvidence(env,evidence){
  const items=(evidence||[]).filter(item=>LID.test(String(item?.lid||''))&&/^\d{4}-\d{2}-\d{2}$/.test(String(item.watchedDate||'')));
  const summary={films:items.length,written:0,unchanged:0,older:0,skipped:0,conflicts:0,ratings:{},changes:[]};
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
   const tmdbFromKey=/^tmdb-([1-9]\d{0,11})$/.exec(factKey)?.[1]||null;
   const base={factKey,observedAt:item.watchedDate+'T00:00:00.000Z',source:'letterboxd_diary',sourceRef:item.sourceRef||null};
   const observations=[{fact:'watched',observation:await observation({...base,fact:'watched',value:true})}];
   if(item.rating!=null){
    const rating=await observation({...base,fact:'rating',value:item.rating});
    const ingestedAt=typeof item.readAt==='string'&&ISO.test(item.readAt)?item.readAt:new Date().toISOString();
    observations.push({fact:'rating',observation:{...rating,ingestedAt}});
   }
   const floors={...await summaryObservations('films-list',filmsList,item.lid,factKey),...await summaryObservations('watchlist',watchlist,item.lid,factKey)};
   const result=await recordObservations(env,factKey,{letterboxd:item.lid,...(tmdbFromKey?{tmdb:tmdbFromKey}:{})},observations,{floors});
   records.push(result.record);
   if(result.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces')){
    summary.written++;
    // AIR-393: what this write changed for the film, from the view as it stood before the writes (a new watched fact, or a different rating).
    const before=view[item.lid]||{},previous=typeof before.actualRating==='number'&&Number.isFinite(before.actualRating)?before.actualRating:null;
    if(before.watched!==true)summary.changes.push({lid:item.lid,tmdb:result.record?.links?.tmdb||null,kind:'added',rating:item.rating??null});
    else if(item.rating!=null&&previous!==item.rating)summary.changes.push({lid:item.lid,tmdb:result.record?.links?.tmdb||null,kind:'updated',from:previous,rating:item.rating});
   }
   else if(result.outcomes.some(o=>o.outcome==='older'))summary.older++;else summary.unchanged++;
  }
  for(const item of items){const record=records.find(r=>r?.links?.letterboxd===item.lid);const value=record?record.rating?.value:view[item.lid]?.actualRating;if(value!=null)summary.ratings[item.lid]=value;}
  await projectRecords(env,records.filter(Boolean));
  return summary;
 }

 // The owner's watched mark on a verified catalog film (ADR-0032) is the one writer that may create a record with only a trusted
 // TMDB alias: the identity is the catalog film the owner marked, never a Letterboxd id, a slug or a title. An existing record
 // that already holds tmdb:<n> is reused; no record is ever merged here.
 // Movie ids already linked to a fact. A rated-archive identity check uses this so a second short code cannot claim the same movie.
 async function knownMovieIds(env){
  const {value}=await readJSON(env,FACTS_KEYS.links),ids=[];
  if(!value||typeof value!=='object')return ids;
  for(const alias of Object.keys(value)){const match=/^tmdb:([1-9]\d{0,11})$/.exec(alias);if(match)ids.push(match[1]);}
  return ids;
 }
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
   if(item.identity!==undefined&&item.identity!=='inferred')fail('Invalid identity kind');
   if(item.identity==='inferred'&&item.tmdb==null)fail('An inferred identity needs a TMDB id');
   // `admit` (ADR 0105) names the Film to create for a TMDB movie the catalog does not hold: only an inferred item may carry it.
   let admit=null;
   if(item.admit!==undefined){
    if(item.identity!=='inferred')fail('Only an inferred identity can admit a Film');
    const a=item.admit;
    if(!a||typeof a!=='object'||Array.isArray(a)||typeof a.title!=='string'||!a.title.trim()||a.title.length>300||!Number.isInteger(a.year)||a.year<1888||a.year>2100)fail('Invalid admit');
    admit={title:a.title.trim(),year:a.year};
   }
   const facts=item.facts||{},keys=Object.keys(facts);
   if(!keys.length||keys.some(key=>!FACT_NAMES.includes(key)))fail('Unknown or missing facts');
   if('watched' in facts&&facts.watched!==true)fail('An export can only show watched: true');
   if('watchlist' in facts&&facts.watchlist!==true)fail('An export can only show watchlist: true');
   if('rating' in facts&&!validValue('rating',facts.rating))fail('Invalid rating');
   if('rating' in facts&&facts.watched!==true)fail('A rating or "not rated" row is also watched');
   const effectiveOn={};for(const [fact,day] of Object.entries(item.effectiveOn||{})){if(!FACT_NAMES.includes(fact)||!DAY.test(String(day)))fail('Invalid effectiveOn');effectiveOn[fact]=day;}
   // A verified item keeps the exact shape (and chunk hash) it always had; only an inferred one carries its kind.
   return {lid:String(item.lid),tmdb:item.tmdb!=null?String(item.tmdb):null,facts,effectiveOn,...(item.identity==='inferred'?{identity:'inferred'}:{}),...(admit?{admit}:{})};
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

 const ADMISSIONS_KEY='letterboxd/admissions/verified-films.json';
 // ADR 0105: the Film behind a search-found inferred TMDB movie is admitted through the existing admissions receipt, written before the
 // facts, and the existing enrichment projector upserts the Film from it later (eventually: the receipt is queued, the Film row appears when
 // the projector runs): this is not a second Film writer. An
 // entry that already holds the movie is kept as it is; a source code already bound to another movie is a conflict and writes nothing.
 // `identity: "inferred"` marks the entry; the projector reads only the fields it knows, so the mark changes nothing for it.
 async function admitInferredFilm(env,item,origin){
  const key='tmdb_'+item.tmdb;let outcome='present';
  await casJSON(env,ADMISSIONS_KEY,{schemaVersion:1,films:{}},current=>{
   const films=current.films&&typeof current.films==='object'&&!Array.isArray(current.films)?current.films:(current.films={});
   for(const other of Object.values(films))if(other&&other.sourceCode===item.lid&&String(other.tmdb)!==item.tmdb){outcome='conflict';return null;}
   if(films[key]){outcome='present';return null;}
   films[key]={tmdb:item.tmdb,sourceCode:item.lid,archiveSha256:origin.archiveSha256,title:item.admit.title,year:item.admit.year,filmPath:null,verifiedAt:new Date().toISOString(),identity:'inferred'};
   outcome='admitted';return current;
  });
  return outcome;
 }

 // Withdraws the entry THIS commit created (same code, archive and movie, still inferred) when the link then conflicted. An entry that was
 // already there is never touched. If the projector has already created the Film from it in that short window, only the receipt entry goes:
 // a Film is never deleted by this route.
 async function withdrawInferredAdmission(env,item,origin){
  const key='tmdb_'+item.tmdb;let withdrawn=false;
  await casJSON(env,ADMISSIONS_KEY,{schemaVersion:1,films:{}},current=>{
   const entry=current.films&&current.films[key];
   if(!entry||entry.identity!=='inferred'||entry.sourceCode!==item.lid||entry.archiveSha256!==origin.archiveSha256||String(entry.tmdb)!==item.tmdb)return null;
   delete current.films[key];withdrawn=true;return current;
  });
  return withdrawn;
 }

 // AIR-602 / ADR 0207 decision 3, at the marker mode `d1`: the admission of ONE inferred item through the D1 coordinator. The evidence row is the `restricts` row of the title and year search (ADR 0213:
 // never proof). -> 'admitted' | 'present' | 'present_other_code' | 'refused_after_link'; a non-terminal answer stops the chunk before its receipt (the same chunk is re-sent).
 async function admitInferredAtD1(env,item,origin,chunk){
  const out=await LetterboxdAdmissionD1.admitVerifiedFilm(env,{kind:'inferred_import',lid:item.lid,receipt:{tmdb:String(item.tmdb),archiveSha256:origin.archiveSha256,title:item.admit.title,year:item.admit.year},
   evidence:{subject:{kind:'letterboxd_lid',value:item.lid},relation:'same_work',object:{kind:'tmdb_movie',value:String(item.tmdb)},polarity:'restricts',route:'letterboxd_export_import',method:'title_year_search',sourceRoot:origin.archiveSha256,sourceRef:'chunk:'+chunk,observedAt:new Date().toISOString()},
   now:()=>new Date().toISOString()});
  if(out.outcome==='admitted'||out.outcome==='present')return out.outcome;
  if(out.outcome==='other_code')return 'present_other_code';
  if(out.outcome==='conflict')return 'refused_after_link';
  throw new FactsError('admission_not_settled','The admission of '+item.lid+' is not settled ('+out.outcome+'): the chunk stops before its receipt');
 }
 // A replay at `d1` offers the admission again only for the items its receipt recorded as `admitted` or `present` (the answer is idempotent). A chunk committed before the activation has no such field: it gets no
 // admission on replay, only its facts and claims (its admissions were proven present at the parity pin).
 async function replayInferredAdmissionsD1(env,origin,chunk,items,entries){
  const settled=new Set((entries||[]).filter(entry=>entry&&(entry.admission==='admitted'||entry.admission==='present')).map(entry=>entry.lid));
  for(const item of items||[]){
   if(!item?.admit||!item.tmdb||!settled.has(item.lid))continue;
   const out=await admitInferredAtD1(env,item,origin,chunk);
   if(out==='refused_after_link')throw new FactsError('admission_not_settled','The recorded admission of '+item.lid+' is now refused');
  }
 }
 async function applyCanonicalInferredAdmissions(env,event,origin,items){
  if(typeof CanonicalRatedAdmission==='undefined')return;
  const {value:doc}=await readJSON(env,ADMISSIONS_KEY);
  const admissions=[];
  for(const item of items||[]){
   if(!item?.admit||!item.tmdb)continue;
   const key='tmdb_'+item.tmdb;
   const stored=doc?.films?.[key];
   if(stored&&stored.archiveSha256===origin.archiveSha256&&stored.sourceCode===item.lid)admissions.push({receiptKey:key,receipt:stored});
  }
  const cap=CanonicalRatedAdmission.UNIT_CAP||12;
  for(let at=0;at<admissions.length;at+=cap){
   const canonical=await CanonicalRatedAdmission.applyRatedAdmissionRetention(env,{event:event+':'+at,admissions:admissions.slice(at,at+cap)});
   CanonicalRatedAdmission.assertRatedAdmissionAccepted(canonical);
  }
 }

 // AIR-489 / ADR 0166 (option A). The Film bridge of a rated-only Diary id, written only after a verified source check
 // (src/letterboxd-diary-identity.js). Reuses the receipt pattern of ADR 0105 and the alias protocol of linkFilm; nothing is merged.
 const DIARY_IDENTITY_KEY=FACTS_PREFIX+'scans/diary-identity.json',DIARY_IDENTITY_CAP=200;
 // AIR-599 (sixth review of PR #1009): THE contract of the check-reservation fence of a Letterboxd identity effect, built here once and consumed unchanged by the Ratings D1 writes (ratings-d1) and the canonical D1 writes
 // (canonical-mutations) through `env.effectGuard = {sql, params}`. The SQL boolean holds only while the LOGICALLY RECONSTRUCTED check document still contains this holder's `"reservation":{"checkId":"<id>"` text. The document
 // is stored in parts cut every 60,000 bytes with no regard to JSON tokens, so a needle may span two adjacent parts: besides one part, the tail of each part joined to the head of the next is searched (the needle is far
 // shorter than a part, so it spans at most two). It asserts the TOKEN (the reservation still on the entry), not the wall clock. Same batch, no schema, no second authority.
 function reservationGuard(checkId){
  if(typeof checkId!=='string'||!/^[\w-]{8,80}$/.test(checkId))return null;
  const needle='"reservation":{"checkId":"'+checkId+'"',length=needle.length;
  return {sql:'(EXISTS (SELECT 1 FROM ratings_document WHERE key=? AND instr(body,?)>0) OR EXISTS (SELECT 1 FROM ratings_document a JOIN ratings_document b ON b.key=a.key AND b.part=a.part+1 WHERE a.key=? AND instr(substr(a.body,-?)||substr(b.body,1,?),?)>0))',params:[DIARY_IDENTITY_KEY,needle,DIARY_IDENTITY_KEY,length-1,length-1,needle]};
 }
 // The movie id each lid's record already carries, from the link index and the record (one read of the index, one per lid).
 async function diaryLinks(env,lids){
  const {value:index}=await readJSON(env,FACTS_KEYS.links),out=new Map();
  for(const lid of lids||[]){
   if(!LID.test(String(lid)))continue;
   let key=index?.['letterboxd:'+lid]||null,tmdb=null;
   if(key){const {value:record}=await readJSON(env,recordKey(key));tmdb=record?.links?.tmdb??null;}
   out.set(lid,{factKey:key,tmdb:tmdb==null?null:String(tmdb)});
  }
  return out;
 }
 // The movie id of Letterboxd ids for the read side only (no write): lid -> tmdb string.
 async function tmdbForLids(env,lids){
  const out=new Map(),links=await diaryLinks(env,[...new Set(lids||[])]);
  for(const [lid,item] of links)if(item.tmdb&&TMDB.test(item.tmdb))out.set(lid,item.tmdb);
  return out;
 }
 // Links the movie id to the record that already holds the Letterboxd id (history kept) through the alias protocol, then projects it.
 // A movie id already linked to another record is an alias_conflict: it is noted and nothing is joined.
 async function bridgeDiaryFilm(env,{lid,tmdb}){
  if(!LID.test(String(lid||''))||!TMDB.test(String(tmdb||'')))throw new FactsError('invalid_identity','Invalid Diary identity');
  let factKey;
  try{factKey=await linkFilm(env,{letterboxd:lid,tmdb:String(tmdb)});}
  catch(error){if(error.code!=='alias_conflict')throw error;await noteConflict(env,{letterboxd:lid,tmdb:String(tmdb)},'alias_conflict');return {state:'conflict'};}
  const {record}=await recordObservations(env,factKey,{letterboxd:lid,tmdb:String(tmdb)},[]);
  if(String(record?.links?.tmdb)!==String(tmdb))return {state:'conflict'};
  await projectRecords(env,[record]);
  return {state:'linked',factKey};
 }
 // Repairs the projection of an id whose alias and record link are already committed (a bridge that failed after them): reads the committed record and projects it
 // again, idempotently. It writes no alias, record fact, admission or Film. {state:'projected'|'absent'|'conflict'}.
 async function reprojectDiaryFilm(env,lid){
  const own=(await diaryLinks(env,[lid])).get(lid);
  if(!own?.factKey||!own.tmdb)return {state:'absent'};
  const {value:record}=await readJSON(env,recordKey(own.factKey));
  if(!record||String(record.links?.tmdb)!==own.tmdb||record.links?.letterboxd!==lid)return {state:'conflict'};
  await projectRecords(env,[record]);
  return {state:'projected'};
 }
 // The receipt entry of a verified Diary identity. An entry that already holds the movie is kept; a code bound to another movie is a conflict.
 async function admitDiaryFilm(env,item){
  const key='tmdb_'+item.tmdb;let outcome='present';
  await casJSON(env,ADMISSIONS_KEY,{schemaVersion:1,films:{}},current=>{
   const films=current.films&&typeof current.films==='object'&&!Array.isArray(current.films)?current.films:(current.films={});
   for(const other of Object.values(films))if(other&&other.sourceCode===item.lid&&String(other.tmdb)!==String(item.tmdb)){outcome='conflict';return null;}
   if(films[key]){outcome=films[key].sourceCode===item.lid?'present':'other_code';return null;}
   films[key]={tmdb:String(item.tmdb),sourceCode:item.lid,archiveSha256:item.evidenceSha256,title:item.title,year:item.year,filmPath:item.filmPath,verifiedAt:item.verifiedAt,identity:'diary_page'};
   outcome='admitted';return current;
  });
  return outcome;
 }
 async function readAdmissionReceipts(env){return readJSON(env,ADMISSIONS_KEY);}
 // AIR-599 / ADR 0207 decision 4b (review of PR #1009): ONE document holds the whole shared state of the Letterboxd check, so every transition is one compare-and-swap: `films` (at most 200 entries) and `backlog`
 // (at most 2,000 ids the full `films` could not take: {lid:{slug,queuedAt,attempts,requeued?}}). An id is in exactly one of the two, and an id moves between them only inside one write.
 const DIARY_BACKLOG_CAP=2000;
 const normDiary=value=>{const ok=value&&value.schemaVersion===1&&value.films&&typeof value.films==='object';return ok?{...value,backlog:value.backlog&&typeof value.backlog==='object'&&!Array.isArray(value.backlog)?value.backlog:{}}:{schemaVersion:1,films:{},backlog:{}};};
 async function readDiaryIdentity(env){const {value}=await readJSON(env,DIARY_IDENTITY_KEY);return normDiary(value);}
 // The same document with its stored version: the compare-and-swap token of the owner `requeue` and `dismiss` route.
 async function readDiaryIdentityVersioned(env){const {value,etag}=await readJSON(env,DIARY_IDENTITY_KEY);return {doc:normDiary(value),version:etag??null};}
 // The backlog as a view of the same document (the version is the document's).
 async function readDiaryBacklog(env){const read=await readDiaryIdentityVersioned(env);return {doc:{schemaVersion:1,ids:read.doc.backlog},version:read.version};}
 // Only a SETTLED entry may be evicted (`owner_dismissed`, the one settled state the document keeps: a verified id is cleared, not kept). A link intent, a pending claim, a reserved, transport-retained, not-now or
 // below-cap entry and an entry at the attempt cap are never evicted.
 const diaryEvictable=entry=>!!entry&&entry.reason==='owner_dismissed';
 const backlogRecord=(hint,at)=>({slug:typeof hint?.slug==='string'&&/^[a-z0-9-]{1,200}$/.test(hint.slug)?hint.slug:null,queuedAt:ISO.test(String(hint?.queuedAt||''))?hint.queuedAt:at,attempts:Number.isInteger(hint?.attempts)&&hint.attempts>0?Math.min(hint.attempts,6):0});
 // One write of the shared document.
 //  set: {lid: entry}, clear: [lid], backlogAdd: {lid: hint} (an id already in the backlog keeps its record), backlogRemove: [lid], checkedAt: the time of a real check that got an answer (`lastCheckAt`, for the Monitor).
 //  expect / expectBacklog: {lid: JSON text of the entry / backlog record the caller READ, or null for none}. Everything the call does for an id is installed only while BOTH still equal what the caller read; otherwise
 //  nothing is done for that id and it is returned in `conflicts`, so a stale write never overwrites an owner `requeue` / `dismiss`, another caller's check or an intake that landed in between.
 //  `extra`: [sql, params] guard statements that ride in the SAME batch (a guard that fails rolls the write back; the ledger row token of a seed). Without a D1-owned store a write with `extra` is refused whole (`atomic_unavailable`).
 //  Above the entry cap the settled entries leave first; when the cap is still exceeded the ids this call ADDED are refused (`refused`): they are not entries, they stay (or are put, from `backlogOnRefuse`) in the backlog,
 //  and an id the full backlog cannot hold is returned in `full`. An existing entry is never dropped.
 async function updateDiaryIdentity(env,{set={},clear=[],backlogAdd={},backlogRemove=[],backlogOnRefuse={},expect=null,expectBacklog=null,checkedAt=null,extra=[]}={}){
  if(!Object.keys(set).length&&!clear.length&&!Object.keys(backlogAdd).length&&!backlogRemove.length&&!checkedAt)return {changed:false,refused:[],conflicts:[],full:[]};
  let refused=[],conflicts=[],full=[];
  const out=await casJSON(env,DIARY_IDENTITY_KEY,{schemaVersion:1,films:{},backlog:{}},current=>{
   const before=current.films||{},backlogBefore=current.backlog||{},films={...before},backlog={...backlogBefore};let changed=false;refused=[];conflicts=[];full=[];
   const text=(map,lid)=>Object.hasOwn(map,lid)?JSON.stringify(map[lid]):null;
   const moved=lid=>(expect&&Object.hasOwn(expect,lid)&&text(before,lid)!==expect[lid])||(expectBacklog&&Object.hasOwn(expectBacklog,lid)&&text(backlogBefore,lid)!==expectBacklog[lid]);
   let lastCheckAt=typeof current.lastCheckAt==='string'?current.lastCheckAt:null;
   if(checkedAt&&ISO.test(checkedAt)&&(!lastCheckAt||checkedAt>lastCheckAt)){lastCheckAt=checkedAt;changed=true;}
   const skip=new Set();
   for(const lid of new Set([...Object.keys(set),...clear,...backlogRemove,...Object.keys(backlogAdd)]))if(moved(lid)){conflicts.push(lid);skip.add(lid);}
   for(const lid of clear)if(!skip.has(lid)&&films[lid]){delete films[lid];changed=true;}
   for(const [lid,item] of Object.entries(set)){if(!LID.test(lid)||skip.has(lid))continue;if(JSON.stringify(films[lid])!==JSON.stringify(item)){films[lid]=item;changed=true;}}
   for(const lid of backlogRemove)if(!skip.has(lid)&&backlog[lid]){delete backlog[lid];changed=true;}
   let ids=Object.keys(films);
   if(ids.length>DIARY_IDENTITY_CAP){
    const settled=ids.filter(id=>diaryEvictable(films[id])).sort((a,b)=>String(films[a].lastAttemptAt||'')<String(films[b].lastAttemptAt||'')?-1:1);
    for(const id of settled.slice(0,ids.length-DIARY_IDENTITY_CAP)){delete films[id];changed=true;}
    ids=Object.keys(films);
    if(ids.length>DIARY_IDENTITY_CAP){
     const added=ids.filter(id=>!before[id]);
     refused=added.slice(Math.max(0,added.length-(ids.length-DIARY_IDENTITY_CAP)));
     const nowIso=new Date().toISOString();
     for(const id of refused){
      delete films[id];
      // The refused id stays recoverable: its previous backlog record is restored, else the caller's hint is recorded.
      if(!backlog[id]){
       if(Object.hasOwn(backlogBefore,id))backlog[id]=backlogBefore[id];
       else if(backlogOnRefuse[id]&&Object.keys(backlog).length<DIARY_BACKLOG_CAP)backlog[id]=backlogRecord(backlogOnRefuse[id],nowIso);
       else full.push(id);
      }
     }
    }
   }
   for(const [lid,hint] of Object.entries(backlogAdd)){
    if(!LID.test(lid)||skip.has(lid)||backlog[lid]||films[lid])continue;
    if(Object.keys(backlog).length>=DIARY_BACKLOG_CAP){full.push(lid);continue;}
    backlog[lid]=backlogRecord(hint,new Date().toISOString());changed=true;
   }
   if(JSON.stringify(backlog)!==JSON.stringify(backlogBefore))changed=true;
   return changed?{...current,schemaVersion:1,films,backlog,...(lastCheckAt?{lastCheckAt}:{})}:null;
  },{extra});
  return {...(out||{}),refused,conflicts,full};
 }
 // The owner `requeue` and `dismiss` for ids wherever the shared check holds them: the entry, the backlog record, and (through `extra`, the ledger statements the caller planned) the Watchlist ledger row. ONE
 // compare-and-swap of the document whose stored version the owner saw, in ONE D1 batch with `extra`: all three change or none does. A moved document, or a moved ledger row (the statements carry its token), refuses the
 // whole request (`stale_revision`, nothing written). The document is written in every request, so `extra` always rides in a batch. Without a D1-owned store the write is refused whole (`atomic_unavailable`).
 // `requeue` resets `attempts` (and `streak`) to 0 on the entry and the backlog record, keeps `queuedAt` and records who, when and why; an id with a live check reservation refuses the whole action (`check_in_flight`); `dismiss` settles an entry as `owner_dismissed`
 // and removes a backlog record. `createMissing` (the report lane) gives an id found nowhere a backlog record on `requeue`.
 async function ownerAction(env,{action,lids,slugs={},createMissing=false,expectedVersion,by,why,at,extra=[]}){
  const results={};let stale=false,full=false,inFlight=[];
  try{
   await casJSON(env,DIARY_IDENTITY_KEY,{schemaVersion:1,films:{},backlog:{}},(raw,etag)=>{
    if((etag??null)!==(expectedVersion??null)){stale=true;return null;}
    // The audit of an owner action is bounded: who (100 chars), when, why (200). A backlog record keeps only who and when (the reason is kept on the entry), so the worst serialized document stays near 1 MB.
    const current=normDiary(raw),requeued={by:String(by).slice(0,100),at,why:String(why).slice(0,200)},requeuedLight={by:requeued.by,at};
    // An id with a LIVE check reservation has an effect in flight (a source check, an admission, a link): the action is refused whole, nothing is written, so it can never be reported as committed while that effect can still land.
    // The reservation expires by itself (a step that was cut off), and the owner retries then or after the step finishes.
    inFlight=lids.filter(lid=>{const reservation=current.films[lid]?.reservation;return reservation&&Date.parse(reservation.until)>Date.parse(at);});
    if(inFlight.length)return null;
    const films={...current.films},backlog={...current.backlog};full=false;
    for(const lid of lids){
     const entry=films[lid],record=backlog[lid];let done=null;
     if(entry){
      const {reservation:_dropped,...rest}=entry;
      if(action==='requeue'){
       const reason=LINK_REASONS_FACTS.has(entry.reason)||entry.reason==='claim_pending'?entry.reason:'owner_requeued';
       films[lid]={...rest,reason,class:'not_now',attempts:0,streak:0,queuedAt:entry.queuedAt||entry.lastAttemptAt||at,nextAttemptAt:at,requeued};done='requeued';
      }else{films[lid]={...rest,reason:'owner_dismissed',class:'settled',nextAttemptAt:null,lastAttemptAt:at,requeued:{...requeued,action:'dismiss'}};done='dismissed';}
     }
     if(record){
      if(action==='requeue'){backlog[lid]={...record,attempts:0,requeued:requeuedLight};done=done||'requeued';}
      else{delete backlog[lid];done=done||'dismissed';}
     }
     if(!done&&action==='requeue'&&createMissing){
      if(Object.keys(backlog).length>=DIARY_BACKLOG_CAP){full=true;results[lid]='backlog_full';continue;}
      backlog[lid]={...backlogRecord({slug:slugs[lid],queuedAt:at,attempts:0},at),requeued:requeuedLight};done='created';
     }
     results[lid]=done||'absent';
    }
    if(full)return null; // a full backlog refuses the whole request: nothing is written, the ledger rows stay as they are
    return {...current,schemaVersion:1,films,backlog,ownerActionAt:at};
   },{extra});
  }catch(error){
   // Nothing was written: the batch is atomic. Contention (the document moved, or a ledger row's token did not hold) is the owner's to re-read.
   if(error&&error.code==='write_contention')return {state:'stale_revision',results:{}};
   throw error;
  }
  if(stale)return {state:'stale_revision',results:{}};
  if(inFlight.length)return {state:'check_in_flight',results:{},ids:inFlight};
  if(full)return {state:'backlog_full',results};
  const after=await readDiaryIdentityVersioned(env);
  return {state:'applied',results,version:after.version,entries:Object.fromEntries(lids.map(lid=>[lid,after.doc.films[lid]??null])),backlog:Object.fromEntries(lids.map(lid=>[lid,after.doc.backlog[lid]??null]))};
 }
 const LINK_REASONS_FACTS=new Set(['linking','link_failed']);

 // ADR 0184: the canonical Letterboxd claim of the lids of a chunk whose Ratings link is durable AND COMMITTED (called after the chunk receipt) and whose movie id is the chunk's. Only verified entries are offered: an INFERRED link (ADR 0104) is a title/year match, not proof of the lid, so it is never offered, and the claim planner refuses a pair the import marked as inferred (`identity`, or its `inferredPairs` entry written before the alias) whichever flow offers it (since ADR 0192 no unlink can withdraw such a link; a mistaken one is repaired case by case). Never throws into the import. Inactive until the
 // claim module's activation line is turned on. A replay of a committed chunk offers it again: that is the recovery of an interrupted claim (the import is owner-driven, so a replay is its ordinary retry).
 async function ensureChunkClaims(env,items,films){
  if(typeof CanonicalLetterboxdClaim==='undefined')return;
  try{
   const ok=new Set((films||[]).filter(film=>film&&!film.conflict&&film.factKey).map(film=>film.lid));
   const pairs=(items||[]).filter(item=>item?.tmdb&&item.identity!=='inferred'&&ok.has(item.lid)).map(item=>({lid:item.lid,tmdb:String(item.tmdb)}));
   if(pairs.length)await CanonicalLetterboxdClaim.ensureLetterboxdClaims(env,{pairs});
  }catch{/* the claim is retried by the next ordinary run of the flow */}
 }
 // Commit: intent (with the projection's before-image) before any write, idempotent fact writes, receipt after read-back.
 async function commitBaselineChunk(env,body){
  const {origin,chunk,items}=validateBaselineRequest(body),hash=await itemsHash(items),sha=origin.archiveSha256;
  // AIR-602 / ADR 0207 decision 1: under `closed` a chunk with any `admit` item answers 409 `admission_closed` BEFORE its intent (and before a replay offers its admissions). The check is a fresh read of the
  // marker; an unreadable marker is `admission_unavailable` (503), never the legacy path. A chunk without an `admit` item admits nothing and is unaffected.
  let atD1=false;
  if(typeof LetterboxdAdmissionAuthority!=='undefined'&&items.some(item=>item?.admit)){
   let admission;
   try{admission=await LetterboxdAdmissionAuthority.admissionRouteNow(env);}catch{throw new FactsError('admission_unavailable','The admission authority cannot be read');}
   if(admission.route==='closed')throw new FactsError('admission_closed','Admissions are closed');
   atD1=admission.route==='d1'&&typeof LetterboxdAdmissionD1!=='undefined';
  }
  const {value:receipt}=await readJSON(env,importKey(sha,chunk,'receipt'));
  if(receipt){
   if(receipt.itemsHash!==hash)throw new FactsError('chunk_conflict','This chunk was committed with other items');
   if(atD1)await replayInferredAdmissionsD1(env,origin,chunk,items,receipt.entries);
   else await applyCanonicalInferredAdmissions(env,'inferred:'+sha+':'+chunk,origin,items);
   await ensureChunkClaims(env,items,(receipt.entries||[]).map(entry=>({lid:entry.lid,factKey:entry.factKey||null,conflict:!!entry.conflict})));
   return {...receipt,replay:true};
  }
  const {value:view}=await readJSON(env,FACTS_KEYS.viewIndex);
  const before={};for(const item of items)for(const id of projectionIds({letterboxd:item.lid,tmdb:item.tmdb})){const entry=view?.[id]||{};before[id]=Object.fromEntries(Object.values(VIEW_FIELDS).filter(field=>Object.hasOwn(entry,field)).map(field=>[field,entry[field]]));}
  let intent=null;
  await casJSON(env,importKey(sha,chunk,'intent'),null,current=>{
   if(current){if(current.itemsHash!==hash)throw new FactsError('chunk_conflict','This chunk was opened with other items');intent=current;return null;}
   intent={schemaVersion:1,archiveSha256:sha,chunk,itemsHash:hash,origin,films:items.map(item=>item.lid),viewBefore:before,openedAt:new Date().toISOString()};return intent;
  });
  const counts={},films=[],records=[];let conflicts=0;
  for(const item of items){
   const links={letterboxd:item.lid,tmdb:item.tmdb};
   let admitted=null,d1Admission=null;
   if(item.admit){
    // The authoritative link conflict is checked BEFORE the admission, so a code that already aliases another movie admits nothing.
    const {value:linkIndex}=await readJSON(env,FACTS_KEYS.links);
    if(!plannedKey(linkIndex||{},links)){await noteConflict(env,links,'alias_conflict');conflicts++;films.push({lid:item.lid,factKey:null,conflict:true});continue;}
    if(atD1){
     // AIR-602 / ADR 0207 decision 3 (table, inferred commit), at the marker mode `d1`: no R2 entry. The pair is classified against D1 BEFORE the link (read only): a code held by another Film is a conflict (no link, no
     // fact); another code on the Film is `present_other_code` (no admission, the link and the facts proceed); a held or redirected identity is non-terminal (the chunk stops before its receipt). The admission itself
     // follows the link, so nothing has to be withdrawn when the link conflicts.
     const plan=await LetterboxdAdmissionD1.planAdmissionD1(env,{tmdb:String(item.tmdb),sourceCode:item.lid});
     if(plan.outcome==='conflict'){conflicts++;films.push({lid:item.lid,factKey:null,conflict:true,admission:'conflict'});continue;}
     if(plan.outcome==='held'||plan.outcome==='redirect')throw new FactsError('admission_not_settled','The admission of '+item.lid+' is not settled ('+plan.outcome+'): the chunk stops before its receipt');
     d1Admission=plan.outcome==='other_code'?'present_other_code':'planned';
    }else{
    admitted=await admitInferredFilm(env,item,origin);
    if(admitted==='conflict'){conflicts++;films.push({lid:item.lid,factKey:null,conflict:true});continue;}
    }
   }
   // AIR-559: an inferred pair is marked on its record first, and linked only to that same record.
   const inferredIdentity=item.identity==='inferred'?{kind:'inferred',basis:'original_title_exact_year_unique',sourceRef:origin.archiveSha256}:null;
   let markedKey=null;
   if(inferredIdentity){
    const {value:linkIndex}=await readJSON(env,FACTS_KEYS.links);
    markedKey=plannedKey(linkIndex||{},links);
    if(markedKey&&!(await markInferredPair(env,markedKey,links,inferredIdentity)))markedKey=null;
   }
   const factKey=inferredIdentity&&!markedKey?(await noteConflict(env,links,'alias_conflict'),null):await linkOrNote(env,links,inferredIdentity?{expectKey:markedKey}:undefined);
   if(!factKey){
    // A writer linked the code between the check and the link: the entry this commit just created is withdrawn, never one it found.
    if(admitted==='admitted')await withdrawInferredAdmission(env,item,origin);
    conflicts++;films.push({lid:item.lid,factKey:null,conflict:true});continue;
   }
   if(d1Admission==='planned'){
    const out=await admitInferredAtD1(env,item,origin,chunk);
    if(out==='refused_after_link'){
     // The batch refused after the link (a concurrent writer admitted the code for another Film): terminal. No fact and no claim; the inferred-marked link stays (it is never a claim proof, ADR 0184); the entry
     // is an admission conflict for owner repair.
     conflicts++;films.push({lid:item.lid,factKey:null,conflict:true,admission:'refused_after_link'});continue;
    }
    d1Admission=out;
   }
   if((admitted==='admitted'||admitted==='present')&&typeof CanonicalRatedAdmission!=='undefined'){
    const key='tmdb_'+item.tmdb;
    const {value:doc}=await readJSON(env,ADMISSIONS_KEY);
    const stored=doc?.films?.[key];
    if(stored&&stored.archiveSha256===origin.archiveSha256&&stored.sourceCode===item.lid){
     const canonical=await CanonicalRatedAdmission.applyRatedAdmissionRetention(env,{event:'inferred:'+origin.archiveSha256+':'+item.lid,admissions:[{receiptKey:key,receipt:stored}]});
     CanonicalRatedAdmission.assertRatedAdmissionAccepted(canonical);
    }
   }
   const observations=await exportObservations(factKey,item,origin),result=await recordObservations(env,factKey,links,observations,{floors:await floorsFor(env,item.lid,factKey),identity:inferredIdentity});
   tally(counts,result.outcomes);records.push(result.record);
   films.push({lid:item.lid,factKey:result.factKey,...(item.identity==='inferred'?{identity:'inferred'}:{}),...(admitted?{admitted}:{}),...(d1Admission?{admission:d1Admission}:{}),observations:observations.map(({fact,observation:o})=>({fact,observationId:o.observationId,observation:o})),outcomes:result.outcomes});
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
  // After the receipt: a claim is never written for a chunk whose commit could still fail.
  await ensureChunkClaims(env,items,films);
  return {...next,replay:false};
 }

 // Owner-only route (the whole Worker is behind Cloudflare Access); every production commit is a separate owner-approved operation.
 async function handleBaselineRequest(request,env,pathname){
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!/^application\/json\b/i.test(request.headers.get('Content-Type')||''))return json({error:'Expected application/json'},415);
  let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
  const action=pathname.slice('/api/letterboxd/baseline/'.length);
  try{
   if(action==='validate')return json(await previewBaselineChunk(env,body));
   if(action==='commit')return json(await commitBaselineChunk(env,body));
   return json({error:'Not found'},404);
  }catch(error){
   if(error instanceof FactsError){const status={invalid_request:400,invalid_observation:400,invalid_identity:400,chunk_conflict:409,not_committed:409,not_inferred:409,admission_closed:409,admission_not_settled:409,admission_unavailable:503}[error.code]||500;return json({error:error.message,code:error.code},status);}
   throw error;
  }
 }
 return {FACTS_KEYS,DIARY_IDENTITY_KEY,reservationGuard,DIARY_IDENTITY_CAP,DIARY_BACKLOG_CAP,readDiaryIdentityVersioned,readDiaryBacklog,ownerAction,reprojectDiaryFilm,diaryLinks,tmdbForLids,bridgeDiaryFilm,admitDiaryFilm,readAdmissionReceipts,readDiaryIdentity,updateDiaryIdentity,applyDiaryEvidence,planDiaryChanges,confirmDiaryEffects,validateBaselineRequest,previewBaselineChunk,plannedKey,commitBaselineChunk,handleBaselineRequest,SOURCE_RANK,FACT_NAMES,recordKey,FactsError,factKeyFor,aliasesOf,projectionIds,emptyRecord,observation,compareObservations,applyObservation,overlay,mergeRatingHistories,summaryObservations,linkFilm,resolveAlias,confirmedFilmRating,recordObservations,projectRecords,applyFilmsListScan,applyWatchlistScan,recordFilmFacts,knownMovieIds,linkTmdbOnly,recordOwnerWatchedMark};
})();
