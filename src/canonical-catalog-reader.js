// AIR-374 P4 / ADR 0099 (Accepted), owner decisions 3 and 4 of 11 Nov 2026. The marker-gated, fail-closed D1 readers of the Film/Person catalog routes.
// This is the ONE module of the canonical read side the Worker bundles (build.mjs, scopedReplacing over film-person-authority.js): it imports only the marker
// reader, performs SELECTs only, never touches R2 and never writes. the fenced writers and the localization sources stay unbundled.
// - catalogReaderGate: legacy/r2/prepared -> mode 'existing' (today's runtime answers, byte-identical); open -> mode 'd1'; held, an unreadable or malformed
//   marker -> throws film_person_held / film_person_unavailable. It never answers "go back to R2" for held or unknown.
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
