// AIR-275 phase 2 (ADR 0056). The enrichment slice of the Film/Person domain: the film, credit, metadata and person inputs
// derived from R2 records the caller already loaded and from a lifecycle view the caller already built. The offline import and
// the Worker projector both take their rows from here, so a reload and a live write derive the same rows.
// This module does not read or write storage. The Worker bundle wraps it in a scope; Node imports it as a module.

export const ENRICHMENT_PROJECTION_VERSION=1;

export function personIdFor(roleId){return typeof roleId==='string'&&/^(actor|director|role|tmdb_actor|tmdb_director)\//.test(roleId)?'person:'+roleId:null;}

export function creditRoster(records){
 const credits=[],unmatched=[];
 const seen=new Set();
 const add=(people,role)=>{
  for(const person of people||[]){
   const personId=personIdFor(person?.id);
   if(!personId){unmatched.push(String(person?.id??''));continue;}
   const key=personId+'/'+role;
   if(seen.has(key))continue;
   seen.add(key);
   credits.push({personId,role,ordinal:credits.filter(item=>item.role===role).length});
  }
 };
 for(const record of records||[]){
  add(record?.directors,'director');
  add(record?.people?.directors,'director');
  add(record?.actors,'actor');
  add(record?.people?.actors,'actor');
 }
 return {credits,unmatched};
}

export function catalogMetadata(record,key,sha){
 if(!record||typeof record!=='object')return null;
 const updatedAt=record.metadataAt||record.updatedAt||record.synopsisFetchedAt||null;
 if(!updatedAt)return null;
 return {schemaVersion:1,year:record.year??null,runtime:record.runtime??null,synopsis:record.synopsis??null,poster:record.poster??null,url:record.url??null,genres:Array.isArray(record.genres)?record.genres:[],peopleVersion:record.peopleVersion??null,payload:{},r2Key:key,contentSha256:sha,updatedAt};
}

// The metadataSync decision clocks that film_metadata does not store. catalogMetadata folds metadataAt, updatedAt and
// synopsisFetchedAt into one updatedAt, and it drops peopleNamesVersion and peopleLocalizedAt. A missing metadata.json
// entry is null (no row). An entry that is present is an object, and a missing or empty clock is null, not a default:
// null metadataAt is an unstamped record, null synopsisFetchedAt still needs the synopsis step, and only the integer 2
// in peopleNamesVersion means the name attempt finished. The 30-day window stays in the domain code.
const syncClock=value=>typeof value==='string'&&value.length?value:null;
export function filmSyncState(record){
 if(!record||typeof record!=='object'||Array.isArray(record))return null;
 return {metadataAt:syncClock(record.metadataAt),synopsisFetchedAt:syncClock(record.synopsisFetchedAt),peopleNamesVersion:Number.isInteger(record.peopleNamesVersion)?record.peopleNamesVersion:null,peopleLocalizedAt:syncClock(record.peopleLocalizedAt)};
}
// The metadata.json entry for a Film that already has a row. film:<slug> uses the slug; film:tmdb:<n> uses the catalog
// spelling tmdb_<n>. aliases are the Film's stored letterboxd external ids, so a retained cache still matches after the
// Film has left the view and the only identity left in D1 is the Film row. A key that matches no Film is not a row:
// this function does not mint one.
export function metadataForFilmId(metadata,filmId,aliases=[]){
 if(!metadata||typeof metadata!=='object'||typeof filmId!=='string'||!filmId.startsWith('film:'))return null;
 const keys=[];
 const add=key=>{if(typeof key==='string'&&key.length&&!keys.includes(key))keys.push(key);};
 add(filmId.slice(5));
 const bare=filmId.slice(5);
 if(bare.startsWith('tmdb:'))add('tmdb_'+bare.slice(5));
 for(const alias of aliases||[])add(String(alias));
 for(const key of keys){const value=metadata[key];if(value&&typeof value==='object'&&!Array.isArray(value))return value;}
 for(const [key,value] of Object.entries(metadata)){
  if(!value||typeof value!=='object'||Array.isArray(value))continue;
  const id=value.id!=null?String(value.id):key;
  if(id===filmId||keys.includes(id)||keys.includes(key))return value;
 }
 return null;
}
const SYNC_KEY_SENTINEL='#sync';
export function filmSyncChangeKey(sync){
 if(!sync)return 'absent';
 const hashed=projectionKey({metadataAt:sync.metadataAt??null,synopsisFetchedAt:sync.synopsisFetchedAt??null,peopleNamesVersion:sync.peopleNamesVersion??null,peopleLocalizedAt:sync.peopleLocalizedAt??null},SYNC_KEY_SENTINEL);
 return 'sync'+hashed.slice(hashed.indexOf(':'));
}

// The source records of one Film: its own id as written, its Letterboxd id, and the catalog spelling tmdb_<id> of each
// trusted, non-conflicting TMDB id, which is how epg/discovered-films.json keys a catalog film. Without that spelling a
// catalog film got no credits, and a watchlist film with the same verified TMDB id lost the catalog's TMDB credits.
export function recordsFor(store,film){
 const ids=new Set([film.id.replace(/^film:/,'')]);
 const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;
 if(letterboxd)ids.add(letterboxd);
 for(const item of film.externalIds||[])if(item.scheme==='tmdb'&&item.trusted===true&&!item.conflicting&&/^\d+$/.test(String(item.value)))ids.add('tmdb_'+item.value);
 return [...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{})].filter(record=>record&&ids.has(String(record.id)));
}

export function metadataRecord(body,film){
 if(!body||typeof body!=='object')return null;
 const ids=new Set([film.id.replace(/^film:/,'')]);
 const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;
 if(letterboxd)ids.add(String(letterboxd));
 for(const [key,value] of Object.entries(body))if(ids.has(key)||ids.has(String(value?.id)))return value;
 return null;
}

export function listedOnWatchlist(store,film){
 const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value||null;
 return !!letterboxd&&(store.watchlist?.films||[]).some(item=>String(item.id)===letterboxd);
}

// The store the enrichment view is built from. Fingerprints, predictions, the profile, the sync state and the discovery ledger
// change only dimensions the enrichment writer does not own, so they are left out: the view is smaller and the change keys do
// not move when a prediction does. The Worker projector and the offline seed both build their store here.
// tmdbRetirements is the optional identity/tmdb-retirements.json body (ADR 0057); null while the object is absent.
// The view index mixes facets and Letterboxd facts. Only a boolean `watchlist` on a Letterboxd lid admits a Film that has left the current lists. A mood facet, a rating, a watched flag, a title or a tmdb_<n> alias does not.
const ADMISSION_LID=/^[A-Za-z0-9_-]{1,80}$/;
export function watchlistAdmissionsFromIndex(index){
 const out={};
 if(!index||typeof index!=='object'||Array.isArray(index))return out;
 for(const [id,item] of Object.entries(index)){
  if(!ADMISSION_LID.test(id)||id.startsWith('tmdb_')||!item||typeof item.watchlist!=='boolean')continue;
  out[id]=item.watchlist;
 }
 return out;
}
// Verified rated-archive Films. A missing document admits nobody. A short boxd.it code is not a key, and watchlist is not a field.
const ARCHIVE_FILM=/^tmdb_[1-9]\d{0,11}$/;
export function archiveAdmissionsFromDocument(document){
 const out={};
 if(!document||document.schemaVersion!==1||!document.films||typeof document.films!=='object'||Array.isArray(document.films))return out;
 for(const [id,item] of Object.entries(document.films)){
  if(!ARCHIVE_FILM.test(id)||!item||typeof item!=='object'||Array.isArray(item))continue;
  if(Object.prototype.hasOwnProperty.call(item,'watchlist'))continue;
  if(String(item.tmdb)!==id.slice(5))continue;
  const film={tmdb:String(item.tmdb),sourceCode:typeof item.sourceCode==='string'?item.sourceCode:null,archiveSha256:typeof item.archiveSha256==='string'?item.archiveSha256:null,title:typeof item.title==='string'?item.title:null,year:Number.isInteger(item.year)?item.year:null};
  if(typeof item.synopsis==='string')film.synopsis=item.synopsis;
  if(typeof item.metadataAt==='string')film.metadataAt=item.metadataAt;
  if(typeof item.synopsisFetchedAt==='string')film.synopsisFetchedAt=item.synopsisFetchedAt;
  if(typeof item.url==='string')film.url=item.url;
  if(Number.isInteger(item.runtime))film.runtime=item.runtime;
  if(Array.isArray(item.genres))film.genres=item.genres;
  if(Array.isArray(item.directors))film.directors=item.directors;
  if(Array.isArray(item.actors))film.actors=item.actors;
  if(item.peopleVersion===1)film.peopleVersion=1;
  if(item.peopleNamesVersion===2)film.peopleNamesVersion=2;
  if(typeof item.peopleLocalizedAt==='string')film.peopleLocalizedAt=item.peopleLocalizedAt;
  if(typeof item.titleRu==='string'){film.titleRu=item.titleRu;film.titleStatus=item.titleStatus==='verified'?'verified':'provisional';}
  out[id]=film;
 }
 return out;
}
export function enrichmentStore({watchlist=null,programme=null,metadata=null,titles=null,people=null,discoveredFilms=null,discoveryResolution=null,diaryHistory=null,tmdbRetirements=null,watchlistAdmissions=null,archiveAdmissions=null,filmTitles=[],personNames=[],personOverrides={}}={}){
 return {watchlist,programme,metadata,titles:titles||{},people:people||{},sync:{failures:[]},discoveredFilms:discoveredFilms||{},discoveryResolution:discoveryResolution||{},discoveryLatest:{items:[]},profile:null,diaryHistory,tmdbRetirements,watchlistAdmissions,archiveAdmissions,fingerprints:{},predictions:{},persistedSidecars:{},filmTitles,personNames,personOverrides};
}

// One input per Film of the view and one per Person. A Film keeps only what the enrichment writer owns: fingerprint, prediction,
// prediction history and availability belong to other writers. Credits stay undefined when a source person id cannot be mapped,
// as the offline import leaves a Film's credits alone in that case.
// metadataSha256 names the metadata.json version a row was read from. The offline import passes the snapshot object's checksum;
// the projector and its seed pass none, so a projected film_metadata row carries content_sha256 NULL: it comes from a live read,
// not from a pinned object version, and no checksum of another Film's change ever lands on it (ADR 0056).
function letterboxdOf(film){return (film?.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value||null;}
function onCurrentList(store,lid){
 if(!lid)return false;
 const same=item=>item&&String(item.id)===String(lid);
 return (store.watchlist?.films||[]).some(same)||(store.programme?.films||[]).some(same);
}
// A cache row whose id names another film is not usable. A missing id is this key's row.
function usableMetadata(record,lid){
 if(!record||typeof record!=='object'||Array.isArray(record))return null;
 if(record.id!=null&&lid&&String(record.id)!==String(lid))return null;
 return record;
}
export function enrichmentInputs({view,store,metadataSha256=null}){
 const sources=sourceIndex(store);
 const films=view.films.map(film=>{
  const {fingerprint,prediction,predictionHistory,availability,...owned}=film;
  const lid=letterboxdOf(film);
  const body=usableMetadata(metadataRecord(store.metadata,film),lid);
  // An admitted lid with no usable cache is not a new body. The writer keeps the stored Film and only moves membership.
  const withhold=!!lid&&typeof store.watchlistAdmissions?.[lid]==='boolean'&&!onCurrentList(store,lid)&&!body;
  const roster=withhold?null:creditRoster(sources(film));
  const metadata=withhold?undefined:catalogMetadata(body,'metadata.json',metadataSha256);
  return {id:film.id,film:owned,watchlist:listedOnWatchlist(store,film),credits:withhold||roster.unmatched.length?undefined:roster.credits,unmatched:roster?roster.unmatched.length:0,metadata,sync:withhold?null:filmSyncState(body),preserveCanonical:withhold||undefined};
 });
 return {films,people:view.people.map(person=>({id:person.id,person}))};
}

// recordsFor scans every record once per Film. The projector runs it for every Film of the view, so it indexes the same records
// by id once, in the same order, and returns what recordsFor returns.
function sourceIndex(store){
 const byId=new Map();
 for(const record of [...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{}),...archiveCreditRecords(store)]){
  if(!record)continue;
  const key=String(record.id);
  if(!byId.has(key))byId.set(key,[]);
  byId.get(key).push(record);
 }
 return film=>{
  const ids=new Set([film.id.replace(/^film:/,'')]);
  const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;
  if(letterboxd)ids.add(letterboxd);
  for(const item of film.externalIds||[])if(item.scheme==='tmdb'&&item.trusted===true&&!item.conflicting&&/^\d+$/.test(String(item.value)))ids.add('tmdb_'+item.value);
  return orderedRecords(store,byId,ids);
 };
}
function archiveCreditRecords(store){
 const admissions=store?.archiveAdmissions;
 if(!admissions||typeof admissions!=='object'||Array.isArray(admissions))return [];
 return Object.entries(admissions).filter(([,item])=>item&&typeof item==='object'&&!Object.prototype.hasOwnProperty.call(item,'watchlist')).map(([id,item])=>({...item,id}));
}
function orderedRecords(store,byId,ids){
 const wanted=new Set();
 for(const id of ids)for(const record of byId.get(String(id))||[])wanted.add(record);
 if(wanted.size<2)return [...wanted];
 const order=[...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{})];
 const listed=order.filter(record=>wanted.has(record));
 for(const record of wanted)if(!listed.includes(record))listed.push(record);
 return listed;
}

// The change key of one input. Values equal to the run's own clock are replaced first: the lifecycle reader stamps a dimension
// with "now" when its source carries no time, and that stamp must not make every Film look changed on every run.
export function filmChangeKey(entry,nowIso){return projectionKey({film:entry.film,watchlist:entry.watchlist,credits:entry.credits??null,metadata:entry.metadata},nowIso);}
export function personChangeKey(entry,nowIso){return projectionKey(entry.person,nowIso);}
export function projectionKey(entry,nowIso){
 const text=JSON.stringify(entry,(key,value)=>value===nowIso?'@now':value);
 return ENRICHMENT_PROJECTION_VERSION+':'+text.length+':'+hash53(text,1)+hash53(text,2);
}
function hash53(text,seed){
 let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}
 h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}
