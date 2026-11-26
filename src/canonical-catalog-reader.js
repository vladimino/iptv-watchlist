// AIR-374 P4 / ADR 0099 (Accepted), owner decisions 3 and 4 of 11 Nov 2026. The marker-gated, fail-closed D1 readers of the Film/Person catalog routes.
// This is the ONE module of the canonical read side the Worker bundles (build.mjs, scopedReplacing over film-person-authority.js): it imports only the marker
// reader, performs SELECTs only, never touches R2 and never writes. the fenced writers and the localization sources stay unbundled.
// - catalogReaderGate: legacy (the explicit local stand-in only; readAuthority refuses r2 and prepared, ADR 0162) -> mode 'existing' (today's runtime answers, byte-identical); open -> mode 'd1'; held, an unreadable or malformed
//   marker -> throws film_person_held / film_person_unavailable. It never answers "go back to R2" for held or unknown.
// - catalogTitlesFromD1 (slice 2, P4b): the provisional localized titles behind GET /api/programme and GET /api/watchlist, bounded SELECTs (chunks of one JSON id list), in the shape of
//   a titles.json row; catalogReaderStill re-checks the marker after any read, so a move between the gate and the answer (to open or held) is refused.
// - catalogCanonicalFilmFromD1 (AIR-475): the film route's canonical fallback at `open` when Discovery holds no record: the typed TMDB claim, the redirect table, the
//   tmdb_retirement_decision ledger and the Film's own metadata, localization and credits; film_rated_admission (readAdmissions) only fills a missing title or year. The marker generation is read again after the reads, so a move mid-read is refused.
import {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource} from './film-person-authority.js';

export const ADMISSION_READ_CHUNK=80;

// legacy (the explicit local stand-in only; r2 and prepared markers are refused, ADR 0162) keeps the existing runtime; open reads D1; held and every unreadable state throw.
export async function catalogReaderGate(env){
 const gate=await readAuthority(env);
 const source=readSource(gate);
 return {mode:source==='d1'?'d1':'existing',generation:gate.generation,state:gate.state};
}

// Frozen titles.json / people.json may be written only while the marker is not d1/open (or held / unreadable). Re-read at the write, not before an await.
export async function canonicalMirrorsWritable(env){
 try{if((await catalogReaderGate(env)).mode==='d1')return false;}
 catch{return false;}
 const db=database(env);
 if(!db)return false;
 try{
  const window=await one(db,'SELECT state,expires_at AS expiresAt FROM projector_window WHERE id=1');
  if(window&&window.state==='held'&&Number(window.expiresAt)>Date.now())return false;
 }catch(error){
  if(/no such table/i.test(String(error?.message||error))||/no such table/i.test(String(error?.cause?.message||'')))return true;
  return false;
 }
 return true;
}

// Read only, no gate: the stored admission and retention rows for ids (chunked by 80, two reads per chunk).
export async function loadAdmissionRows(env,ids){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const list=[...new Set(ids||[])];
 const out=new Map(list.map(id=>[id,{ratedAdmission:null,retention:null}]));
 for(let at=0;at<list.length;at+=ADMISSION_READ_CHUNK){
  const chunk=list.slice(at,at+ADMISSION_READ_CHUNK),marks=chunk.map(()=>'?').join(',');
  let admissions,retention;
  try{[admissions,retention]=await Promise.all([many(db,`SELECT film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at FROM film_rated_admission WHERE film_id IN (${marks})`,chunk),many(db,`SELECT film_id,watchlist,observed_at FROM film_retention WHERE film_id IN (${marks})`,chunk)]);}
  catch(error){throw failed('admission_unavailable',error);}
  for(const row of admissions)out.get(row.film_id).ratedAdmission={tmdb:row.tmdb,sourceCode:row.source_code,archiveSha256:row.archive_sha256,title:row.title,year:row.year,receiptKey:row.receipt_key,receiptFilmKey:row.receipt_film_key,verifiedAt:row.verified_at};
  for(const row of retention)out.get(row.film_id).retention={watchlist:row.watchlist===1,observedAt:row.observed_at};
 }
 return out;
}

// The D1 reader for the bulk read model (AIR-372): D1 is the allowed source only while the marker is open; held fails closed, never R2.
export async function readAdmissions(env,ids){
 if(readSource(await readAuthority(env))!=='d1')throw failed('admission_not_authoritative');
 return loadAdmissionRows(env,ids);
}

const MOVIE_ID=/^[1-9]\d{0,11}$/;
// The owner's retirement ledger (append-only): a retire of a movie id that no restore supersedes retires it, whatever Film row exists. Read by the film route and by POST /api/started.
const RETIREMENT_SQL="SELECT 1 AS hit FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq) LIMIT 1";
// AIR-475. The canonical Film behind one typed TMDB movie id, answered from D1 only: {state:'absent'|'retired'|'conflict'|'found',film?}. The film route calls it at `open`
// when Discovery holds no record: a retained Film (programme, watchlist, rated archive or none of them any more) is a Film because D1 holds it, never because Discovery or
// a rated-archive admission names it. Nothing is written or scanned: one typed id, one trusted claim, one Film, its metadata and credits. The rated-archive admission, when
// it exists, only fills the title and year the canonical rows leave empty. Called only when the marker is open; any other state throws before a statement.
export async function catalogCanonicalFilmFromD1(env,tmdbId){
 const gate=await readAuthority(env);
 if(gate.state!=='open'){readSource(gate);throw failed('canonical_read_not_authoritative');}
 if(typeof tmdbId!=='string'||!MOVIE_ID.test(tmdbId))throw failed('canonical_read_invalid');
 const db=database(env);
 let result;
 try{
  // The owner's retirement ledger (append-only): a retire of this movie id that no restore supersedes retires it, whatever Film row exists.
  const retired=await one(db,RETIREMENT_SQL,[tmdbId]);
  if(retired)result={state:'retired'};
  else{
   const rows=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[tmdbId]);
   // The rule of the admission writer: ALL claims of the typed id are read; any claim that is not the one owner's own trusted, non-conflicting row holds the identity.
   const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0,owner=rows.find(isOwn)?.film_id??null;
   if(rows.some(row=>!(isOwn(row)&&row.film_id===owner)))result={state:'conflict'};
   else if(owner===null)result={state:'absent'};
   else if(await one(db,'SELECT 1 AS hit FROM film_redirect WHERE from_id=? LIMIT 1',[owner]))result={state:'retired'};
   else result=await canonicalFilmPage(env,db,owner,tmdbId);
  }
 }catch(error){
  if(error?.code)throw error;
  throw failed('canonical_read_unavailable',error);
 }
 const again=await readAuthority(env);
 if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
 return result;
}

// AIR-656: a bounded, ordered display read. Past the cap the page is honestly partial (creditsPartial), never refused: cast size must not make a whole Film unavailable.
const CREDIT_READ_CAP=200;// per role: a large director range never hides every actor
const PAGE_FILM_SQL=`SELECT f.canonical_identity AS canonical_identity,f.original_title AS original_title,m.year AS year,m.runtime AS runtime,m.poster AS poster,m.url AS url,m.genres_json AS genres_json,(SELECT d.value FROM film_dimension d WHERE d.film_id=f.id AND d.dimension='localization' AND d.status IN ('provisional','reviewed') AND d.value IS NOT NULL AND d.value<>'' ORDER BY CASE d.status WHEN 'reviewed' THEN 0 ELSE 1 END LIMIT 1) AS title FROM film f LEFT JOIN film_metadata m ON m.film_id=f.id WHERE f.id=?`;
// The credit selection is the shared bounded one (film-person-authority.js): per-role indexed probes, no sort of the whole stored cast.
const PAGE_CREDIT_SQL=CREDIT_SELECTION_SQL;
// The full catalog entry of one owner Film (the shape of a Discovery film payload, no shows: the Worker adds shows only from the pinned EPG generation).
async function canonicalFilmPage(env,db,owner,tmdbId){
 const identity='tmdb:'+tmdbId;
 const row=await one(db,PAGE_FILM_SQL,[owner]);
 // A claim without its Film row cannot be: the foreign key forbids it. If it is read, the store is inconsistent, not absent.
 if(!row)throw failed('canonical_read_unavailable');
 // A Film that records another canonical identity than the trusted claim it was found by is a disagreement, never silently served.
 if(row.canonical_identity!=null&&row.canonical_identity!==identity)return {state:'conflict'};
 const admission=(await readAdmissions(env,[owner])).get(owner)?.ratedAdmission??null;
 if(admission&&String(admission.tmdb)!==tmdbId)throw failed('canonical_read_unavailable');
 const read=await many(db,PAGE_CREDIT_SQL,[owner,CREDIT_READ_CAP+1,owner,CREDIT_READ_CAP+1]);
 const credits=[];let creditsPartial=false;
 for(const role of ['director','actor']){
  const rows=read.filter(item=>item.role===role);
  if(rows.length>CREDIT_READ_CAP)creditsPartial=true;
  credits.push(...rows.slice(0,CREDIT_READ_CAP));
 }
 let genres=[];
 try{const parsed=JSON.parse(row.genres_json||'[]');if(Array.isArray(parsed))genres=parsed.filter(genre=>typeof genre==='string'&&genre);}catch{throw failed('canonical_read_unavailable');}
 const text=value=>typeof value==='string'&&value?value:null,integer=value=>Number.isInteger(value)?value:null;
 // A stored person without a usable name (no localized value, no same-Person name alias) is omitted and counted (creditsUnnamed), never silently; the order is the stored ordinal.
 const people=role=>credits.filter(item=>item.role===role&&text(item.name)).map(item=>({id:String(item.role_id),name:item.name}));
 const creditsUnnamed=credits.filter(item=>!text(item.name)).length;
 const original=text(row.original_title);
 return {state:'found',film:{id:'tmdb_'+tmdbId,tmdbId,canonicalIdentity:identity,title:text(row.title)??text(admission?.title)??original,original,year:integer(row.year)??integer(admission?.year),runtime:integer(row.runtime),genres,poster:text(row.poster),url:typeof row.url==='string'&&row.url.startsWith('https://')?row.url:null,directors:people('director'),actors:people('actor'),shows:[],...(creditsPartial?{creditsPartial:true}:{}),...(creditsUnnamed?{creditsUnnamed}:{})}};
}

// AIR-475. The verified identity bridge behind the film history: one stored spelling of a Film (a Letterboxd lid or tmdb_<n>) -> the storage ids its predictions can lie under.
// Only D1 identity claims decide: the typed claim must be the one owner's trusted, non-conflicting row, the owner must not be a redirect source, and its own tmdb and letterboxd
// claims must be one trusted value each with no other Film claiming that value in any form. Never a title, a year or a slug. Called only when the marker is open (the
// caller reads the gate); another state throws before a statement. {state:'ok',filmId,tmdb,lid}|{state:'absent'|'conflict'|'retired'}.
const LID=/^[A-Za-z0-9_-]{1,80}$/;
export async function catalogFilmIdentityBridge(env,id){
 const gate=await readAuthority(env);
 if(gate.state!=='open'){readSource(gate);throw failed('canonical_read_not_authoritative');}
 const tmdb=typeof id==='string'?/^tmdb_([1-9]\d{0,11})$/.exec(id):null;
 if(typeof id!=='string'||!(tmdb||LID.test(id)))throw failed('canonical_read_invalid');
 const scheme=tmdb?'tmdb':'letterboxd',value=tmdb?tmdb[1]:id,db=database(env);
 let found;
 try{
  const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0;
  const claims=await many(db,'SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme=? AND value=?',[scheme,value]);
  const owner=claims.find(isOwn)?.film_id??null;
  if(claims.some(row=>!(isOwn(row)&&row.film_id===owner)))found={state:'conflict'};
  else if(owner===null)found={state:'absent'};
  else if(await one(db,'SELECT 1 AS hit FROM film_redirect WHERE from_id=? LIMIT 1',[owner]))found={state:'retired'};
  else{
   const own=await many(db,"SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=? AND scheme IN ('tmdb','letterboxd')",[owner]);
   const trusted=name=>own.filter(row=>row.scheme===name&&isOwn(row)).map(row=>String(row.value));
   const tmdbIds=trusted('tmdb'),lids=trusted('letterboxd');
   // Any claim of the Film that is not its one trusted value of the scheme (an untrusted or conflicting row, a second trusted value) holds the bridge.
   if(own.some(row=>!isOwn(row))||tmdbIds.length>1||lids.length>1)found={state:'conflict'};
   else{
    const other=lids.length||tmdbIds.length?await many(db,"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme='tmdb' AND value=?) OR (scheme='letterboxd' AND value=?)",[tmdbIds[0]??'',lids[0]??'']):[];
    if(other.some(row=>row.film_id!==owner||!isOwn(row)))found={state:'conflict'};
    else found={state:'ok',filmId:owner,tmdb:tmdbIds[0]??null,lid:lids[0]&&LID.test(lids[0])?lids[0]:null};
   }
  }
 }catch(error){
  if(error?.code)throw error;
  throw failed('canonical_read_unavailable',error);
 }
 const again=await readAuthority(env);
 if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
 return found;
}

// AIR-516. The canonical Film behind the id of POST /api/started (a Letterboxd lid or tmdb_<n>, the spelling the mark is stored under): {state:'found',film:{filmId,title,year,tmdb}}
// | {state:'absent'|'conflict'|'retired'}. The identity is the verified bridge above (never a title, a year or a slug), so a Film with a trusted Letterboxd id and no TMDB claim is found with
// `tmdb:null`; `tmdb` is the Film's one trusted, non-conflicting movie claim and nothing else. The title is the reviewed, then provisional localization, then the original title; the year is the
// stored metadata year; a missing value is null, never invented. Called only at `open`: held, an unreadable marker and any other state throw before a statement, and a generation that moved
// during the reads is refused. Reads only; the caller writes nothing before this answers.
const STARTED_SQL=`SELECT f.canonical_identity AS canonical_identity,f.original_title AS original_title,m.year AS year,(SELECT d.value FROM film_dimension d WHERE d.film_id=f.id AND d.dimension='localization' AND d.status IN ('provisional','reviewed') AND d.value IS NOT NULL AND d.value<>'' ORDER BY CASE d.status WHEN 'reviewed' THEN 0 ELSE 1 END LIMIT 1) AS title FROM film f LEFT JOIN film_metadata m ON m.film_id=f.id WHERE f.id=?`;
export async function catalogStartedFilm(env,id){
 const gate=await readAuthority(env),db=database(env);
 if(gate.state!=='open'){readSource(gate);throw failed('canonical_read_not_authoritative');}
 const bridge=await catalogFilmIdentityBridge(env,id);
 if(bridge.state!=='ok')return {state:bridge.state};
 let row,retired=null;
 try{
  // The owner's append-only retirement ledger (as the film route reads it): a retire of the Film's movie id that no restore supersedes retires it, whatever Film row exists.
  if(bridge.tmdb)retired=await one(db,RETIREMENT_SQL,[bridge.tmdb]);
  if(!retired)row=await one(db,STARTED_SQL,[bridge.filmId]);
 }catch(error){throw failed('canonical_read_unavailable',error);}
 if(retired){
  const again=await readAuthority(env);
  if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
  return {state:'retired'};
 }
 // A claim without its Film row cannot be (foreign key): the store is inconsistent, not absent.
 if(!row)throw failed('canonical_read_unavailable');
 // A Film that records another canonical identity than its own trusted TMDB claim is a disagreement, never silently served.
 if(bridge.tmdb&&row.canonical_identity!=null&&row.canonical_identity!=='tmdb:'+bridge.tmdb)return {state:'conflict'};
 const text=value=>typeof value==='string'&&value.trim()?value:null;
 const again=await readAuthority(env);
 if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
 return {state:'found',film:{filmId:bridge.filmId,title:text(row.title)??text(row.original_title),year:Number.isInteger(row.year)?row.year:null,tmdb:bridge.tmdb}};
}

// Slice 2 (P4b): the titles.json consumers of the programme and watchlist routes. titles.json is a former mutable canonical mirror (frozen at `open`, owner decision 4); the
// same facts live in film_dimension('localization') (materialised by the canonical writers) and film_external_id. One SELECT per request: the film ids go in as ONE JSON text
// (json_each), never one statement per film. The count of films is capped (the rows cannot exceed the ids asked for: one localization row per Film), and a request above the cap fails closed (503), never a silent partial answer.
// One statement per chunk of at most TITLE_READ_CHUNK ids (the id list is one bound JSON text, about 45 KB at the chunk size). The real catalogue (about 9.3k Films, about 6.7k in the
// programme window) takes 5 statements; the cap only stops a runaway document.
export const TITLE_READ_CHUNK=1500;
export const TITLE_READ_MAX_FILMS=20000;
const TITLE_SQL=`SELECT d.film_id AS film_id,d.value AS value,d.provenance_json AS provenance_json,(SELECT e.value FROM film_external_id e WHERE e.film_id=d.film_id AND e.scheme='tmdb' AND e.trusted=1 AND e.conflicting=0 ORDER BY e.value LIMIT 1) AS tmdb FROM film_dimension d WHERE d.dimension='localization' AND d.status='provisional' AND d.value IS NOT NULL AND d.value<>'' AND d.film_id IN (SELECT value FROM json_each(?)) ORDER BY d.film_id DESC LIMIT ?`;
// The film id the canonical writers give a stored spelling (the rule of canonicalFilmId in src/domain/film-person.js, repeated here: this module imports nothing else).
const titleFilmId=id=>{const tmdb=/^tmdb_(\d+)$/.exec(id);return tmdb?'film:tmdb:'+tmdb[1]:'film:'+id;};

// After the reads: the marker is read again. The answer stands only if it is the state and the generation the gate saw (a move to open or held refuses).
export async function catalogReaderStill(env,gate){
 const again=await readAuthority(env);
 if(again.state!==gate.state||again.generation!==gate.generation)throw failed('film_person_generation_moved');
}

// films: the documents' film objects ({id,tmdbId}). Returns {[id]:{title,tmdbId,status:'provisional',sources}}: exactly the rows the R2 titles.json dictionary would hold for
// them (a row is used by presentLocalized only when its tmdbId equals the film's, so the tmdb id is the Film's trusted, non-conflicting TMDB claim, typed like the document's).
// Called only for a gate of mode d1; every other state throws before a statement.
export async function catalogTitlesFromD1(env,films,gate){
 if(gate?.mode!=='d1')throw failed('canonical_read_not_authoritative');
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const byId=new Map();
 for(const film of Array.isArray(films)?films:[]){if(film&&film.id!=null&&!byId.has(String(film.id)))byId.set(String(film.id),film);}
 if(byId.size>TITLE_READ_MAX_FILMS)throw failed('canonical_read_unavailable');
 const out={};
 if(byId.size){
  const wanted=new Map();
  for(const id of byId.keys()){const own='film:'+id,tmdb=titleFilmId(id);wanted.set(own,id);if(tmdb!==own&&!wanted.has(tmdb))wanted.set(tmdb,id);}
  const keys=[...wanted.keys()],rows=[];
  for(let at=0;at<keys.length;at+=TITLE_READ_CHUNK){
   const chunk=keys.slice(at,at+TITLE_READ_CHUNK);
   try{rows.push(...await many(db,TITLE_SQL,[JSON.stringify(chunk),chunk.length]));}
   catch(error){throw failed('canonical_read_unavailable',error);}
  }
  for(const row of rows){
   const id=wanted.get(row.film_id);
   // The id's own spelling wins over its tmdb spelling when both Films exist (the rows come own spelling first: ORDER BY film_id DESC).
   if(id===undefined||(out[id]&&row.film_id!=='film:'+id))continue;
   let sources=null;
   try{const provenance=row.provenance_json==null?null:JSON.parse(row.provenance_json);sources=provenance&&Object.prototype.hasOwnProperty.call(provenance,'sources')?provenance.sources:null;}catch{throw failed('canonical_read_unavailable');}
   const tmdb=row.tmdb==null?undefined:typeof byId.get(id).tmdbId==='number'?Number(row.tmdb):String(row.tmdb);
   out[id]={title:row.value,tmdbId:tmdb,status:'provisional',sources};
  }
 }
 await catalogReaderStill(env,gate);
 return out;
}

const PEOPLE_SQL=`SELECT p.role_id AS role_id,d.value AS value,d.status AS status,d.authority AS authority FROM person_dimension d INNER JOIN person p ON p.id=d.person_id WHERE d.dimension='localization' AND d.status IN ('provisional','reviewed') AND d.value IS NOT NULL AND d.value<>'' AND p.id IN (SELECT value FROM json_each(?)) ORDER BY p.role_id, CASE d.status WHEN 'reviewed' THEN 0 ELSE 1 END LIMIT ?`;
// Slice 4 (AIR-499): people.json consumers of the admin snapshot. Bounded SELECTs of the requested role ids (chunks of
// TITLE_READ_CHUNK). The R2 cache is keyed by roleId; D1 stores person.id as person:<roleId>. Missing optional names are
// omitted, not a read error.
export async function catalogPeopleFromD1(env,ids,gate){
 if(gate?.mode!=='d1')throw failed('canonical_read_not_authoritative');
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const wanted=[...new Set((ids||[]).map(String).filter(Boolean))];
 if(wanted.length>TITLE_READ_MAX_FILMS)throw failed('canonical_read_unavailable');
 const out={};
 if(wanted.length){
  const keys=[...new Set(wanted.map(id=>id.startsWith('person:')?id:'person:'+id))];
  const rows=[];
  for(let at=0;at<keys.length;at+=TITLE_READ_CHUNK){
   const chunk=keys.slice(at,at+TITLE_READ_CHUNK);
   try{rows.push(...await many(db,PEOPLE_SQL,[JSON.stringify(chunk),chunk.length]));}
   catch(error){throw failed('canonical_read_unavailable',error);}
  }
  const accept=new Set(wanted);
  for(const row of rows){
   const role=row.role_id;
   if(!accept.has(role)&&!accept.has('person:'+role))continue;
   if(out[role])continue;
   const status=row.status==='reviewed'?'reviewed':'provisional';
   out[role]={name:row.value,status,...(row.authority?{authority:row.authority}:{})};
  }
 }
 await catalogReaderStill(env,gate);
 return out;
}

const META_SQL=`SELECT f.id AS film_id,f.original_title AS original_title,m.year AS year,m.poster AS poster,m.url AS url,(SELECT d.value FROM film_dimension d WHERE d.film_id=f.id AND d.dimension='localization' AND d.status IN ('provisional','reviewed') AND d.value IS NOT NULL AND d.value<>'' ORDER BY CASE d.status WHEN 'reviewed' THEN 0 ELSE 1 END LIMIT 1) AS title FROM film f LEFT JOIN film_metadata m ON m.film_id=f.id WHERE f.id IN (SELECT value FROM json_each(?)) LIMIT ?`;
// AIR-519: the same Film membership as META_SQL (a row per existing film of the chunk) without the localized title, the metadata join or their text,
// for a reader that needs only the identity verdict (the footer's Letterboxd-to-TMDB bridge).
const IDENTITY_SQL=`SELECT f.id AS film_id FROM film f WHERE f.id IN (SELECT value FROM json_each(?)) LIMIT ?`;
const EXT_FILM_SQL=`SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND film_id IN (SELECT value FROM json_each(?))`;
const EXT_VALUE_SQL=`SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND value IN (SELECT value FROM json_each(?))`;
// Same rule as catalogCanonicalFilmFromD1: ALL claims of the scheme (and of the typed value when given) are
// assessed; any claim that is not the one owner's trusted, non-conflicting row is a conflict. Untrusted or
// conflicting rows are not ignored.
function identityClaim(rows,scheme,value){
 const pool=(rows||[]).filter(row=>row.scheme===scheme&&(value==null||String(row.value)===String(value)));
 const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0;
 if(value!=null){
  const owner=pool.find(isOwn)?.film_id??null;
  if(pool.some(row=>!(isOwn(row)&&row.film_id===owner)))return {value:null,conflict:true,filmId:null};
  if(owner==null)return {value:null,conflict:false,filmId:null};
  return {value:String(value),conflict:false,filmId:owner};
 }
 const owner=pool.find(isOwn);
 const ownerVal=owner?.value??null,ownerFilm=owner?.film_id??null;
 if(pool.some(row=>!(isOwn(row)&&String(row.value)===String(ownerVal)&&row.film_id===ownerFilm)))return {value:null,conflict:true,filmId:null};
 if(ownerVal==null)return {value:null,conflict:false,filmId:null};
 return {value:String(ownerVal),conflict:false,filmId:ownerFilm};
}

// Slice 3 (AIR-499): metadata.json consumers of the film page, Finds and ratings labels. Bounded SELECTs of the requested ids
// (chunks of TITLE_READ_CHUNK); missing optional poster/title/year is an empty field, not a read error. TMDB is the Film's
// identity claim (every stored tmdb / letterboxd row for that value is assessed; any non-owner claim is a conflict) — never
// inferred from a title. A conflict sets identityBlocked:true with tmdbId null so catalogLidTmdb cannot restore the lid
// from watchlist/programme; a missing TMDB claim is tmdbId null without that flag.
// `options.identityOnly` (AIR-519): every record keeps only id, tmdbId and identityBlocked, with the same verdicts; films are selected with IDENTITY_SQL.
export async function catalogMetadataFromD1(env,ids,gate,options={}){
 if(gate?.mode!=='d1')throw failed('canonical_read_not_authoritative');
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const wanted=[...new Set((ids||[]).map(String).filter(Boolean))];
 if(wanted.length>TITLE_READ_MAX_FILMS)throw failed('canonical_read_unavailable');
 const out={};
 if(!wanted.length){await catalogReaderStill(env,gate);return out;}
 const keys=[];
 for(const id of wanted){
  keys.push('film:'+id);
  const tmdb=/^tmdb_(\d+)$/.exec(id);
  if(tmdb)keys.push('film:tmdb:'+tmdb[1]);
 }
 const unique=[...new Set(keys)];
 const films=[],externals=[],identityOnly=options?.identityOnly===true,FILM_SQL=identityOnly?IDENTITY_SQL:META_SQL;
 try{
  for(let at=0;at<unique.length;at+=TITLE_READ_CHUNK){
   const chunk=unique.slice(at,at+TITLE_READ_CHUNK);
   films.push(...await many(db,FILM_SQL,[JSON.stringify(chunk),chunk.length]));
   externals.push(...await many(db,EXT_FILM_SQL,[JSON.stringify(chunk)]));
  }
  const extra=[];
  const values=[...wanted];
  for(const id of wanted){const tmdb=/^tmdb_(\d+)$/.exec(id);if(tmdb)values.push(tmdb[1]);}
  for(const row of externals)if(row.value!=null)values.push(String(row.value));
  const valueKeys=[...new Set(values)];
  for(let at=0;at<valueKeys.length;at+=TITLE_READ_CHUNK){
   const chunk=valueKeys.slice(at,at+TITLE_READ_CHUNK);
   extra.push(...await many(db,EXT_VALUE_SQL,[JSON.stringify(chunk)]));
  }
  const asked=new Set(unique),missing=[...new Set(extra.map(row=>row.film_id).filter(id=>!asked.has(id)))];
  externals.push(...extra);
  for(let at=0;at<missing.length;at+=TITLE_READ_CHUNK){
   const chunk=missing.slice(at,at+TITLE_READ_CHUNK);
   films.push(...await many(db,FILM_SQL,[JSON.stringify(chunk),chunk.length]));
   externals.push(...await many(db,EXT_FILM_SQL,[JSON.stringify(chunk)]));
  }
 }catch(error){throw failed('canonical_read_unavailable',error);}
 const byFilm=new Map();
 for(const row of films)byFilm.set(row.film_id,row);
 const extByFilm=new Map();
 for(const row of externals){if(!extByFilm.has(row.film_id))extByFilm.set(row.film_id,[]);extByFilm.get(row.film_id).push(row);}
 // AIR-519: the claims of one typed value, in the order the rows were read. identityClaim keeps only the rows of its scheme and value, so handing it
 // that group gives the same verdict as the whole list. Scanning every external row once per requested id was quadratic: tens of seconds of CPU on
 // the real catalogue, which kept the footer's large objects alive long enough for overlapping requests to exceed the Worker memory limit.
 const byValue=new Map();
 for(const row of externals){const key=row.scheme+'\u0000'+String(row.value);if(!byValue.has(key))byValue.set(key,[]);byValue.get(key).push(row);}
 const claimOf=(scheme,value)=>identityClaim(byValue.get(scheme+'\u0000'+String(value))||[],scheme,value);
 for(const id of wanted){
  const own='film:'+id,tmdb=/^tmdb_(\d+)$/.exec(id),spelled=tmdb?'film:tmdb:'+tmdb[1]:null;
  let filmId=byFilm.has(own)?own:(spelled&&byFilm.has(spelled)?spelled:null);
  if(!filmId){
   const lid=claimOf('letterboxd',id);
   if(lid.conflict){
    out[id]=identityOnly?{id,tmdbId:null,identityBlocked:true}:{id,tmdbId:null,identityBlocked:true,poster:null,year:null,url:null,title:null,original:null};
    continue;
   }
   if(lid.filmId&&byFilm.has(lid.filmId))filmId=lid.filmId;
   else if(tmdb){
    const claim=claimOf('tmdb',tmdb[1]);
    if(claim.conflict){
     out[id]=identityOnly?{id,tmdbId:null,identityBlocked:true}:{id,tmdbId:null,identityBlocked:true,poster:null,year:null,url:null,title:null,original:null};
     continue;
    }
    if(claim.filmId&&byFilm.has(claim.filmId))filmId=claim.filmId;
   }
  }
  if(!filmId)continue;
  const row=byFilm.get(filmId),ext=extByFilm.get(filmId)||[];
  const tmdbLocal=identityClaim(ext,'tmdb');
  const tmdbClaim=tmdbLocal.conflict||tmdbLocal.value==null?tmdbLocal:claimOf('tmdb',tmdbLocal.value);
  const lidLocal=identityClaim(ext,'letterboxd');
  const lidClaim=lidLocal.conflict||lidLocal.value==null?lidLocal:claimOf('letterboxd',lidLocal.value);
  const tmdbId=tmdbClaim.conflict||tmdbClaim.value==null?null:tmdbClaim.value;
  let record;
  if(identityOnly)record={id,tmdbId};
  else{
   const original=typeof row.original_title==='string'&&row.original_title?row.original_title:null;
   const title=typeof row.title==='string'&&row.title?row.title:original;
   record={id,tmdbId,poster:row.poster??null,year:row.year??null,url:row.url??null,title,original};
  }
  if(tmdbClaim.conflict||lidClaim.conflict)record.identityBlocked=true;
  out[id]=record;
  if(lidClaim.value&&lidClaim.value!==id)out[lidClaim.value]={...record,id:lidClaim.value};
 }
 await catalogReaderStill(env,gate);
 return out;
}

// The remaining-readers registry (AIR-374 P4): every reader or writer of a former mutable canonical R2 mirror (titles.json, people.json, metadata.json) and every named exception
// (owner decision 4: what stays R2 after `open`). `class` is 'freeze' (the mirror is frozen at open and the reader must read D1: moved:false is still open work) or 'exception'
// (stays as it is: an independent mirror, an input artifact, an immutable source or receipt, view-index prediction retention). Plain data, no imports: the computed handoff readiness
// (P6) consumes it. `moved:true` means the reader is marker-gated and reads D1 at open (proved by tests/canonical-catalog-titles.mjs, tests/canonical-catalog-metadata.mjs, tests/canonical-admin-dictionaries.mjs, tests/canonical-footer-export.mjs or tests/catalog-film.mjs).
export const CANONICAL_READER_REGISTRY=[
 {name:'catalog film route canonical fallback (identity claim, retirements, metadata, credits)',file:'src/worker.js',class:'freeze',moved:true},
 {name:'/api/d1/* catalog routes',file:'src/catalog-d1.js',class:'freeze',moved:true},
 {name:'GET /api/programme titles.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'GET /api/watchlist titles.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'catalog film route optional metadata.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'POST /api/started film identity (was metadata.json and programme.json)',file:'src/worker.js',class:'freeze',moved:true},
 {name:'catalog available route metadata.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'ratingsFilmLabels metadata.json and titles.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'metadataSync titles.json, people.json and metadata.json working set (writer)',file:'src/worker.js',class:'freeze',moved:true},
 {name:'epgSync title and people localization (writer of titles.json, people.json)',file:'src/worker.js',class:'freeze',moved:true},
 {name:'admin read titles.json and people.json',file:'src/admin/read.js',class:'freeze',moved:true},
 {name:'admin limbo titles.json and people.json',file:'src/admin/limbo.js',class:'freeze',moved:true},
 {name:'admin health source list titles.json and people.json',file:'src/admin/health.js',class:'freeze',moved:true},
 {name:'admin Letterboxd archive metadata.json',file:'src/admin/letterboxd-archive.js',class:'freeze',moved:true},
 {name:'footer metadata.json',file:'src/enrichment.js',class:'freeze',moved:true},
 {name:'migration export of the mirrors (group global)',file:'src/enrichment.js',class:'freeze',moved:true},
 {name:'metadata cache mirror object of the D1 metadata cache',file:'src/metadata-cache.js',class:'exception',moved:false},
 {name:'enrichment projector reads the mirror objects as its source until the producers are wired',file:'src/d1-enrichment.js',class:'exception',moved:false},
 {name:'programme.json and watchlist.json (independent EPG mirrors)',file:'src/worker.js',class:'exception',moved:false},
 {name:'view-index.json prediction retention',file:'src/enrichment.js',class:'exception',moved:false},
 {name:'immutable sources, receipts and input artifacts',file:'src/worker.js',class:'exception',moved:false},
];
