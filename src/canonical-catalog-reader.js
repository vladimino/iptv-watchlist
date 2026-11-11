// AIR-374 P4 / ADR 0099 (Accepted), owner decisions 3 and 4 of 11 Nov 2026. The marker-gated, fail-closed D1 readers of the Film/Person catalog routes.
// This is the ONE module of the canonical read side the Worker bundles (build.mjs, scopedReplacing over film-person-authority.js): it imports only the marker
// reader, performs SELECTs only, never touches R2 and never writes. the fenced writers and the localization sources stay unbundled.
// - catalogReaderGate: legacy/r2/prepared -> mode 'existing' (today's runtime answers, byte-identical); open -> mode 'd1'; held, an unreadable or malformed
//   marker -> throws film_person_held / film_person_unavailable. It never answers "go back to R2" for held or unknown.
// - catalogTitlesFromD1 (slice 2, P4b): the provisional localized titles behind GET /api/programme and GET /api/watchlist, bounded SELECTs (chunks of one JSON id list), in the shape of
//   a titles.json row; catalogReaderStill re-checks the marker after any read, so a move between the gate and the answer (prepared -> open, held) is refused.
// - catalogAdmittedFilmFromD1: the film route's rated-archive fallback at `open`, from film_rated_admission (readAdmissions), the D1 identity claims, the redirect
//   table and the tmdb_retirement_decision ledger. The marker generation is read again after the reads, so a move mid-read is refused.
import {database,failed,many,one,readAuthority,readSource} from './film-person-authority.js';

export const ADMISSION_READ_CHUNK=80;

// legacy, r2 and prepared keep the existing runtime; open reads D1; held and every unreadable state throw.
export async function catalogReaderGate(env){
 const gate=await readAuthority(env);
 const source=readSource(gate);
 return {mode:source==='d1'?'d1':'existing',generation:gate.generation,state:gate.state};
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
// The Film a verified rated-archive admission made, answered from D1 only: {state:'absent'|'retired'|'conflict'|'found',film?}. Nothing is written or scanned:
// one typed id, one Film. The reduced page (title and year, the facts the admission row stores; no people, genres or runtime) is the contract until the
// canonical film view reads them from D1 (follow-up). Called only when the marker is open; any other state throws before a statement.
export async function catalogAdmittedFilmFromD1(env,tmdbId){
 const gate=await readAuthority(env);
 if(gate.state!=='open'){readSource(gate);throw failed('canonical_read_not_authoritative');}
 if(typeof tmdbId!=='string'||!MOVIE_ID.test(tmdbId))throw failed('canonical_read_invalid');
 const db=database(env);
 let result;
 try{
  // The owner's retirement ledger (append-only): a retire of this movie id that no restore supersedes retires it, whatever Film row exists.
  const retired=await one(db,"SELECT 1 AS hit FROM tmdb_retirement_decision r WHERE r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq) LIMIT 1",[tmdbId]);
  if(retired)result={state:'retired'};
  else{
   const rows=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[tmdbId]);
   // The rule of the admission writer: ALL claims of the typed id are read; any claim that is not the one owner's own trusted, non-conflicting row holds the identity.
   const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0,owner=rows.find(isOwn)?.film_id??null;
   if(rows.some(row=>!(isOwn(row)&&row.film_id===owner)))result={state:'conflict'};
   else if(owner===null)result={state:'absent'};
   else if(await one(db,'SELECT 1 AS hit FROM film_redirect WHERE from_id=? LIMIT 1',[owner]))result={state:'retired'};
   else{
    const admission=(await readAdmissions(env,[owner])).get(owner)?.ratedAdmission??null;
    if(!admission)result={state:'absent'};
    else if(String(admission.tmdb)!==tmdbId)throw failed('canonical_read_unavailable');
    else result={state:'found',film:{id:'tmdb_'+tmdbId,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:typeof admission.title==='string'&&admission.title?admission.title:null,original:null,year:Number.isInteger(admission.year)?admission.year:null,runtime:null,genres:[],url:null,directors:[],actors:[],shows:[]}};
   }
  }
 }catch(error){
  if(error?.code)throw error;
  throw failed('canonical_read_unavailable',error);
 }
 const again=await readAuthority(env);
 if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');
 return result;
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

// After the reads: the marker is read again. The answer stands only if it is the state and the generation the gate saw (r2 -> prepared -> open and held all refuse).
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

// The remaining-readers registry (AIR-374 P4): every reader or writer of a former mutable canonical R2 mirror (titles.json, people.json, metadata.json) and every named exception
// (owner decision 4: what stays R2 after `open`). `class` is 'freeze' (the mirror is frozen at open and the reader must read D1: moved:false is still open work) or 'exception'
// (stays as it is: an independent mirror, an input artifact, an immutable source or receipt, view-index prediction retention). Plain data, no imports: the computed handoff readiness
// (P6) consumes it. `moved:true` means the reader is marker-gated and reads D1 at open (proved by tests/canonical-catalog-titles.mjs or tests/catalog-film.mjs).
export const CANONICAL_READER_REGISTRY=[
 {name:'catalog film route rated-archive fallback (retirements, receipt)',file:'src/worker.js',class:'freeze',moved:true},
 {name:'/api/d1/* catalog routes',file:'src/catalog-d1.js',class:'freeze',moved:true},
 {name:'GET /api/programme titles.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'GET /api/watchlist titles.json',file:'src/worker.js',class:'freeze',moved:true},
 {name:'catalog film route optional metadata.json',file:'src/worker.js',class:'freeze',moved:false},
 {name:'catalog available route metadata.json',file:'src/worker.js',class:'freeze',moved:false},
 {name:'ratingsFilmLabels metadata.json and titles.json',file:'src/worker.js',class:'freeze',moved:false},
 {name:'metadataSync titles.json, people.json and metadata.json working set (writer)',file:'src/worker.js',class:'freeze',moved:false},
 {name:'epgSync title and people localization (writer of titles.json, people.json)',file:'src/worker.js',class:'freeze',moved:false},
 {name:'admin read titles.json and people.json',file:'src/admin/read.js',class:'freeze',moved:false},
 {name:'admin limbo titles.json and people.json',file:'src/admin/limbo.js',class:'freeze',moved:false},
 {name:'admin health source list titles.json and people.json',file:'src/admin/health.js',class:'freeze',moved:false},
 {name:'admin Letterboxd archive metadata.json',file:'src/admin/letterboxd-archive.js',class:'freeze',moved:false},
 {name:'footer metadata.json',file:'src/enrichment.js',class:'freeze',moved:false},
 {name:'migration export of the mirrors (group global)',file:'src/enrichment.js',class:'freeze',moved:false},
 {name:'metadata cache mirror object of the D1 metadata cache',file:'src/metadata-cache.js',class:'exception',moved:false},
 {name:'enrichment projector reads the mirror objects as its source until the producers are wired',file:'src/d1-enrichment.js',class:'exception',moved:false},
 {name:'programme.json and watchlist.json (independent EPG mirrors)',file:'src/worker.js',class:'exception',moved:false},
 {name:'view-index.json prediction retention',file:'src/enrichment.js',class:'exception',moved:false},
 {name:'immutable sources, receipts and input artifacts',file:'src/worker.js',class:'exception',moved:false},
];
