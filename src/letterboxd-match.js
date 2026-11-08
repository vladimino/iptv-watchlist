// Strict matcher of Letterboxd export rows against films stored in an R2 snapshot.
// Pure: it receives already loaded objects and returns match records; no storage, network or clock.
// Identity follows ADR-0009: only a stored Letterboxd id or a trusted TMDB identity can accept a match. Equality of the export
// code with a stored id is accepted only when the stored title and year corroborate it, because code = LID is a hypothesis this
// tool measures, not a proven contract. A title and year agreement is never `accepted`: no stored signal independently proves
// that the export row and the stored film are the same Letterboxd film, so it stays a candidate for manual review.
// AIR-388 (ADR 0104) adds one owner-approved exception that never changes `accepted`: with {inferred:true}, one normalized ORIGINAL
// title plus the same year that leads to exactly one stored TMDB movie, with no competing or contradicting link, is `inferred`
// (a pragmatic identity, recorded as such, never reported as verified). Everything else stays a candidate with a review reason.
export const METHODS=Object.freeze(['lid_exact','tmdb_verified','title_year']);
export const STATUSES=Object.freeze(['accepted','provisional','candidate','ambiguous','conflict','unmatched']);
// Kept apart from the two lists above so that every report built from them keeps its exact keys until the policy is asked for.
export const INFERRED_STATUS='inferred',INFERRED_METHOD='title_year_unique';
// Candidate reasons that only the inferred policy produces; each one is a compact owner-review bucket.
export const REVIEW_REASONS=Object.freeze(['year_drift','alias_title_only','no_tmdb_id','tmdb_linked_elsewhere','tmdb_duplicate_in_export','tmdb_already_accepted']);
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
 const target=(key,init)=>{let entry=targets.get(key);if(!entry)targets.set(key,entry={key,...init,sources:new Set(),tmdbIds:new Set(),titles:new Set(),originals:new Set(),years:new Set(),ratings:new Set()});return entry;};
 const describe=(entry,film)=>{
  const tmdbId=tmdbOf(film?.tmdbId);if(tmdbId)entry.tmdbIds.add(tmdbId);
  const year=yearOf(film?.year);if(year)entry.years.add(year);
  const original=normTitle(film?.original);if(original)entry.originals.add(original);
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
 // Stored Letterboxd-to-TMDB links (letterboxd/facts/links.json: alias -> record key). Optional; when absent the inferred policy
 // cannot see a contradicting link, and the commit-time alias conflict check stays the authority.
 const linkedLids=new Map(),linkedTmdb=new Map();
 if(snapshot.factLinks&&typeof snapshot.factLinks==='object'&&!Array.isArray(snapshot.factLinks)){
  const byRecord=new Map();
  for(const [alias,record] of Object.entries(snapshot.factLinks)){const [kind,id]=alias.split(':');if(!id||(kind!=='letterboxd'&&kind!=='tmdb'))continue;if(!byRecord.has(record))byRecord.set(record,{lids:new Set(),tmdb:new Set()});byRecord.get(record)[kind==='tmdb'?'tmdb':'lids'].add(id);}
  for(const {lids,tmdb} of byRecord.values())for(const t of tmdb){if(!linkedLids.has(t))linkedLids.set(t,new Set());for(const l of lids){linkedLids.get(t).add(l);if(!linkedTmdb.has(l))linkedTmdb.set(l,new Set());linkedTmdb.get(l).add(t);}}
 }
 const lids=[...targets.values()].filter(entry=>entry.kind==='lid');
 return {targets,titles,catalogByTmdb,linkedLids,linkedTmdb,summary:{
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

function byTitle(film,index,options={}){
 const keys=index.titles.get(normTitle(film.name));
 const none={filmId:null,tmdbId:null,catalogIds:[],candidates:[],evidence:{}};
 if(!keys)return {...none,status:'unmatched',method:null,reason:'no_stored_title'};
 const all=[...keys].map(key=>index.targets.get(key));
 // The inferred policy asks for the same year and the original title, so a namesake one year away (a remake, a later film with the
 // same name) must not turn an exact match into an ambiguity. When that exact set exists the choice is made inside it; when it
 // does not, the legacy +/-1 window below applies and the row is reviewed. Without the policy nothing here changes.
 const name=normTitle(film.name),exact=options.inferred&&film.year?all.filter(entry=>entry.years.has(film.year)&&entry.originals.has(name)):[];
 const near=exact.length?exact:film.year?all.filter(entry=>nearYear(entry,film.year)):all;
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
 if(!options.inferred)return {...result,status:'candidate',reason:'identity_unverified'};
 return inferredOrReview(film,entries,result,index);
}

// The AIR-388 policy for one title match. Inferred needs: a typed TMDB movie id, the same year, the normalized ORIGINAL title (an
// alias alone is review), no stored link of that TMDB id to another Letterboxd id and none of this code to another TMDB id.
// Duplicates across the export are judged afterwards, over all rows. Every other case is a candidate with one review reason.
function inferredOrReview(film,entries,result,index){
 const review=reason=>({...result,status:'candidate',reason});
 if(!result.tmdbId)return review('no_tmdb_id');
 if(result.evidence.yearDelta!==0)return review('year_drift');
 const name=normTitle(film.name);
 if(!entries.some(entry=>entry.originals.has(name)))return review('alias_title_only');
 const lids=index.linkedLids?.get(result.tmdbId);
 if(lids&&[...lids].some(lid=>lid!==film.code))return review('tmdb_linked_elsewhere');
 const tmdbs=index.linkedTmdb?.get(film.code);
 if(tmdbs&&[...tmdbs].some(tmdb=>tmdb!==result.tmdbId))return review('tmdb_linked_elsewhere');
 return {...result,status:INFERRED_STATUS,method:INFERRED_METHOD,reason:null,evidence:{...result.evidence,identity:'inferred',basis:'original_title_exact_year_unique'}};
}

// films: parseExport().films. Returns one record per film, ordered by export code. options.inferred turns on the AIR-388 policy;
// without it the result is exactly what it was before (no `inferred` row, title matches stay `identity_unverified` candidates).
export function matchExport(films,index,options={}){
 const rows=[...films].sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0).map(film=>{const code=byCode(film,index);return code?{code:film.code,basis:'code',...code}:{code:film.code,basis:'title',...byTitle(film,index,options)};});
 if(!options.inferred)return rows;
 // One TMDB movie claimed by two export codes, or by a code that is already accepted, is never inferred: all claimants go to review.
 const claims=new Map();
 for(const row of rows)if(row.tmdbId&&(row.status==='inferred'||row.status==='accepted')){if(!claims.has(row.tmdbId))claims.set(row.tmdbId,[]);claims.get(row.tmdbId).push(row);}
 for(const group of claims.values()){
  if(group.length<2)continue;
  const reason=group.some(row=>row.status==='accepted')?'tmdb_already_accepted':'tmdb_duplicate_in_export';
  for(const row of group)if(row.status==='inferred'){row.status='candidate';row.method='title_year';row.reason=reason;delete row.evidence.identity;delete row.evidence.basis;}
 }
 return rows;
}

// Whether the export code equals the stored Letterboxd id, judged from the matches only.
export function lidHypothesis(matches,index){
 const byCodeRows=matches.filter(row=>row.basis==='code');
 const titleYear={agree:0,title_differs:0,year_only:0,unknown:0,disagree:0},rating={agree:0,disagree:0,unknown:0};
 for(const row of byCodeRows){titleYear[row.evidence.titleYear]++;rating[row.evidence.rating]++;}
 // A title match to a stored id that another export code already equals is a second film with a similar title (a remake,
 // a namesake), not a sign that codes differ from ids; it is counted apart and does not weaken the verdict.
 const claimed=new Set(byCodeRows.map(row=>row.filmId).filter(Boolean));
 const titleRows=matches.filter(row=>row.method==='title_year'&&row.filmId);
 const titleOnly=titleRows.filter(row=>!claimed.has(row.filmId)).length,titleOnClaimed=titleRows.length-titleOnly;
 let verdict='inconclusive';
 if(index.summary.storedLids>0){
  if(!byCodeRows.length)verdict=titleOnly?'refuted':'inconclusive';
  else if(titleYear.disagree===0&&rating.disagree===0&&titleYear.agree+titleYear.year_only+rating.agree>0)verdict=titleOnly?'mixed':'supported';
  else verdict='mixed';
 }
 return {storedLids:index.summary.storedLids,codesEqualToStoredLid:byCodeRows.length,titleYearOnStoredLid:titleOnly,titleYearOnCodeMatchedLid:titleOnClaimed,titleYear,rating,verdict};
}
