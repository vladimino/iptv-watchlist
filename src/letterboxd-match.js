// Strict matcher of Letterboxd export rows against films stored in an R2 snapshot.
// Pure: it receives already loaded objects and returns match records; no storage, network or clock.
// Identity follows ADR-0009: only a stored Letterboxd id or a trusted TMDB identity can accept a match. Equality of the export
// code with a stored id is accepted only when the stored title and year corroborate it, because code = LID is a hypothesis this
// tool measures, not a proven contract. A title and year agreement is never accepted: no stored signal independently proves
// that the export row and the stored film are the same Letterboxd film, so it stays a candidate for manual review.
export const METHODS=Object.freeze(['lid_exact','tmdb_verified','title_year']);
export const STATUSES=Object.freeze(['accepted','provisional','candidate','ambiguous','conflict','unmatched']);
export const normTitle=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const LID=/^[A-Za-z0-9_-]{1,40}$/;
const isLid=id=>LID.test(id)&&!id.startsWith('tmdb_');
const tmdbOf=value=>/^\d+$/.test(String(value??''))?String(value):null;
const yearOf=value=>Number.isInteger(Number(value))&&Number(value)>1800?Number(value):null;
const ratingOf=value=>typeof value==='number'&&value>=0.5&&value<=5&&Number.isInteger(value*2)?value:null;
const filmsOf=value=>Array.isArray(value?.films)?value.films:[];
const sortedStrings=values=>[...values].map(String).sort();

// snapshot: {watchlist, programme, metadata, catalog, viewIndex, ratings} where ratings is a published ratings generation.
export function buildIndex(snapshot={}){
 const targets=new Map(),titles=new Map(),catalogByTmdb=new Map();
 const target=(key,init)=>{let entry=targets.get(key);if(!entry)targets.set(key,entry={key,...init,sources:new Set(),tmdbIds:new Set(),titles:new Set(),years:new Set(),ratings:new Set()});return entry;};
 const describe=(entry,film)=>{
  const tmdbId=tmdbOf(film?.tmdbId);if(tmdbId)entry.tmdbIds.add(tmdbId);
  const year=yearOf(film?.year);if(year)entry.years.add(year);
  for(const title of [film?.title,film?.original,film?.titleRu,...(Array.isArray(film?.aliases)?film.aliases:[])]){const key=normTitle(title);if(!key)continue;entry.titles.add(key);if(!titles.has(key))titles.set(key,new Set());titles.get(key).add(entry.key);}
 };
 const lidFilm=(source,film,id=film?.id)=>{const lid=String(id??'');if(!isLid(lid))return null;const entry=target('lid:'+lid,{kind:'lid',id:lid});entry.sources.add(source);if(film)describe(entry,film);return entry;};
 for(const film of filmsOf(snapshot.watchlist))lidFilm('watchlist',film);
 for(const film of filmsOf(snapshot.programme))lidFilm('programme',film);
 for(const [id,film] of Object.entries(snapshot.metadata||{}))lidFilm('metadata',film,film?.id??id);
 for(const [id,rating] of Object.entries(snapshot.ratings?.ratings||{})){const entry=lidFilm('ratings_generation',null,id);if(entry&&ratingOf(rating))entry.ratings.add(rating);}
 for(const [id,view] of Object.entries(snapshot.viewIndex||{})){
  const rating=ratingOf(view?.actualRating);
  if(isLid(id)){const entry=lidFilm('view_index',null,id);if(rating)entry.ratings.add(rating);}
 }
 // Catalog records are films only with a verified identity (canonicalIdentity tmdb:<tmdbId>).
 for(const [key,film] of Object.entries(snapshot.catalog||{})){
  const tmdbId=tmdbOf(film?.tmdbId);if(!tmdbId||film?.canonicalIdentity!=='tmdb:'+tmdbId)continue;
  const id=String(film.id??key),entry=target('catalog:'+id,{kind:'catalog',id});entry.sources.add('catalog');describe(entry,film);
  const rating=ratingOf(snapshot.viewIndex?.[id]?.actualRating);if(rating)entry.ratings.add(rating);
  if(!catalogByTmdb.has(tmdbId))catalogByTmdb.set(tmdbId,new Set());catalogByTmdb.get(tmdbId).add(id);
 }
 const lids=[...targets.values()].filter(entry=>entry.kind==='lid');
 return {targets,titles,catalogByTmdb,summary:{
  storedLids:lids.length,
  lidsBySource:Object.fromEntries(['watchlist','programme','metadata','ratings_generation','view_index'].map(source=>[source,lids.filter(entry=>entry.sources.has(source)).length])),
  lidsWithTmdbId:lids.filter(entry=>entry.tmdbIds.size===1).length,
  lidsWithTmdbConflict:lids.filter(entry=>entry.tmdbIds.size>1).length,
  verifiedCatalogRecords:[...targets.values()].filter(entry=>entry.kind==='catalog').length,
  titleKeys:titles.size,
 }};
}

// The film an index target stands for: a TMDB identity when the stored data carries exactly one, else the stored id.
const identityOf=entry=>entry.tmdbIds.size===1?'tmdb:'+[...entry.tmdbIds][0]:entry.tmdbIds.size>1?'conflict:'+entry.key:entry.key;
const nearYear=(entry,year)=>[...entry.years].some(value=>Math.abs(value-year)<=1);

// Title/year consistency of an exact id match: disagree when the stored year is more than one year away; agree when the export
// name is a stored title, original title or alias and the year does not disagree.
function consistency(film,entry){
 const year=film.year&&entry.years.size?nearYear(entry,film.year):null,title=entry.titles.size?entry.titles.has(normTitle(film.name)):null;
 if(year===false)return 'disagree';
 if(title===true)return 'agree';
 if(title===false)return 'title_differs';
 return year===true?'year_only':'unknown';
}
// A different rating is recorded, never decisive: the owner may have re-rated the film since the stored value.
function ratingCheck(film,entries){
 const stored=new Set(entries.flatMap(entry=>[...entry.ratings]));
 if(film.rating===undefined||!stored.size)return 'unknown';
 return stored.size===1&&stored.has(film.rating)?'agree':'disagree';
}

function byCode(film,index){
 const entry=index.targets.get('lid:'+film.code);
 if(!entry)return null;
 const evidence={sources:sortedStrings(entry.sources),titleYear:consistency(film,entry),rating:ratingCheck(film,[entry])};
 const base={filmId:entry.id,tmdbId:null,catalogIds:[],candidates:[],evidence};
 if(entry.tmdbIds.size>1)return {...base,status:'conflict',method:null,reason:'stored_tmdb_conflict'};
 if(evidence.titleYear==='disagree')return {...base,status:'conflict',method:'lid_exact',reason:'stored_year_disagrees'};
 if(evidence.titleYear==='title_differs')return {...base,status:'conflict',method:'lid_exact',reason:'stored_title_differs'};
 const tmdbId=[...entry.tmdbIds][0]||null,catalogIds=tmdbId?sortedStrings(index.catalogByTmdb.get(tmdbId)||[]):[];
 const method=catalogIds.length?'tmdb_verified':'lid_exact';
 // The stored id carries no title, or only a year: the code equality alone is not corroborated.
 if(evidence.titleYear!=='agree')return {...base,tmdbId,catalogIds,status:'provisional',method,reason:'code_uncorroborated'};
 return {...base,tmdbId,catalogIds,status:'accepted',method,reason:null};
}

function byTitle(film,index){
 const keys=index.titles.get(normTitle(film.name));
 const none={filmId:null,tmdbId:null,catalogIds:[],candidates:[],evidence:{}};
 if(!keys)return {...none,status:'unmatched',method:null,reason:'no_stored_title'};
 const all=[...keys].map(key=>index.targets.get(key)),near=film.year?all.filter(entry=>nearYear(entry,film.year)):all;
 if(!near.length)return {...none,status:'unmatched',method:null,reason:'title_without_year_match'};
 const identities=new Map();for(const entry of near){const id=identityOf(entry);if(!identities.has(id))identities.set(id,[]);identities.get(id).push(entry);}
 const candidates=sortedStrings(near.map(entry=>entry.key));
 if(identities.size>1)return {...none,candidates,status:'ambiguous',method:null,reason:film.year?'multiple_targets':'missing_year_multiple_targets'};
 const [identity,entries]=[...identities][0];
 const lid=entries.find(entry=>entry.kind==='lid'),tmdbId=identity.startsWith('tmdb:')?identity.slice(5):null;
 const catalogIds=sortedStrings(new Set([...entries.filter(entry=>entry.kind==='catalog').map(entry=>entry.id),...(tmdbId?index.catalogByTmdb.get(tmdbId)||[]:[])]));
 const yearDelta=film.year?Math.min(...entries.flatMap(entry=>[...entry.years].map(year=>Math.abs(year-film.year)))):null;
 const rating=ratingCheck(film,entries),signals=[];
 // Recorded for the manual review only: neither proves that the stored film is the same Letterboxd film.
 if(rating==='agree')signals.push('rating_agrees');
 if(film.inWatchlist&&entries.some(entry=>entry.sources.has('watchlist')))signals.push('watchlist_member');
 const evidence={titleMatch:'exact_normalized',yearDelta,rating,signals,sources:sortedStrings(new Set(entries.flatMap(entry=>[...entry.sources])))};
 const result={filmId:lid?.id||null,tmdbId,catalogIds,candidates,evidence,method:'title_year'};
 if(identity.startsWith('conflict:'))return {...result,method:null,status:'conflict',reason:'stored_tmdb_conflict'};
 if(!film.year)return {...result,status:'candidate',reason:'missing_year'};
 return {...result,status:'candidate',reason:'identity_unverified'};
}

// films: parseExport().films. Returns one record per film, ordered by export code.
export function matchExport(films,index){
 return [...films].sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0).map(film=>{const code=byCode(film,index);return code?{code:film.code,basis:'code',...code}:{code:film.code,basis:'title',...byTitle(film,index)};});
}

// Whether the export code equals the stored Letterboxd id, judged from the matches only.
export function lidHypothesis(matches,index){
 const byCodeRows=matches.filter(row=>row.basis==='code');
 const titleYear={agree:0,title_differs:0,year_only:0,unknown:0,disagree:0},rating={agree:0,disagree:0,unknown:0};
 for(const row of byCodeRows){titleYear[row.evidence.titleYear]++;rating[row.evidence.rating]++;}
 const titleOnly=matches.filter(row=>row.method==='title_year'&&row.filmId).length;
 let verdict='inconclusive';
 if(index.summary.storedLids>0){
  if(!byCodeRows.length)verdict=titleOnly?'refuted':'inconclusive';
  else if(titleYear.disagree===0&&rating.disagree===0&&titleYear.agree+titleYear.year_only+rating.agree>0)verdict=titleOnly?'mixed':'supported';
  else verdict='mixed';
 }
 return {storedLids:index.summary.storedLids,codesEqualToStoredLid:byCodeRows.length,titleYearOnStoredLid:titleOnly,titleYear,rating,verdict};
}
