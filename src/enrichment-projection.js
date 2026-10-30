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
export function enrichmentStore({watchlist=null,programme=null,metadata=null,titles=null,people=null,discoveredFilms=null,discoveryResolution=null,diaryHistory=null,filmTitles=[],personNames=[],personOverrides={}}={}){
 return {watchlist,programme,metadata,titles:titles||{},people:people||{},sync:{failures:[]},discoveredFilms:discoveredFilms||{},discoveryResolution:discoveryResolution||{},discoveryLatest:{items:[]},profile:null,diaryHistory,fingerprints:{},predictions:{},persistedSidecars:{},filmTitles,personNames,personOverrides};
}

// One input per Film of the view and one per Person. A Film keeps only what the enrichment writer owns: fingerprint, prediction,
// prediction history and availability belong to other writers. Credits stay undefined when a source person id cannot be mapped,
// as the offline import leaves a Film's credits alone in that case.
// metadataSha256 names the metadata.json version a row was read from. The offline import passes the snapshot object's checksum;
// the projector and its seed pass none, so a projected film_metadata row carries content_sha256 NULL: it comes from a live read,
// not from a pinned object version, and no checksum of another Film's change ever lands on it (ADR 0056).
export function enrichmentInputs({view,store,metadataSha256=null}){
 const sources=sourceIndex(store);
 const films=view.films.map(film=>{
  const {fingerprint,prediction,predictionHistory,availability,...owned}=film;
  const roster=creditRoster(sources(film));
  const metadata=catalogMetadata(metadataRecord(store.metadata,film),'metadata.json',metadataSha256);
  return {id:film.id,film:owned,watchlist:listedOnWatchlist(store,film),credits:roster.unmatched.length?undefined:roster.credits,unmatched:roster.unmatched.length,metadata};
 });
 return {films,people:view.people.map(person=>({id:person.id,person}))};
}

// recordsFor scans every record once per Film. The projector runs it for every Film of the view, so it indexes the same records
// by id once, in the same order, and returns what recordsFor returns.
function sourceIndex(store){
 const byId=new Map();
 for(const record of [...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{})]){
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
function orderedRecords(store,byId,ids){
 const wanted=new Set();
 for(const id of ids)for(const record of byId.get(String(id))||[])wanted.add(record);
 if(wanted.size<2)return [...wanted];
 const order=[...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{})];
 return order.filter(record=>wanted.has(record));
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
