// AIR-673 / ADR 0217 (Accepted) decision 9, choice M1, delivery step 4, DORMANT. The temporary prediction exclusion of a lid-only Film. ONE cohort rule, on the RESOLVED Film, serves every enforcement point (queue rebuild
// admission, manifest build, per-film `submit` guard) and the unified read's `predictions.eligibility` (the same SQL statement):
//
//   a Film is in the cohort when its survivor (the end of its redirect chain) is the Film of a `film_lid_admission` row (the row's own Film or any redirect source that ends at the survivor: a merge moves the proof, AIR-674)
//   AND the survivor holds NO current trusted `tmdb` claim (a trusted, non-conflicting claim of a movie that no non-superseded owner retirement retires).
//
// The cohort is decided by durable rows, never by the spelling of an id. An id only NOMINATES Films: a `film:` id is that Film; a bare lid, `lb-<lid>` or `film:lb:<lid>` nominates the Films of the lid (its trusted
// `letterboxd` claim and its proof row); a `tmdb_<n>` movie id nominates nothing (a Film that holds a current trusted movie claim is outside the cohort by the rule itself). After a successful attach the rule stops
// matching and the ordinary ADR 0154 gates apply. Read only; nothing here scores, calls a model or changes a prompt.
//
// While migration 0048 is not applied the table does not exist, so no lid-only Film can exist and nothing is excluded (the dormant, byte-identical legacy path). Any OTHER read failure is thrown: an unreadable
// answer is never "not excluded" (fail closed for the queue, the manifest and `submit`).
import {database,failed,many} from './film-person-authority.js';

export const LID_ONLY_DEFERRED={status:'not_eligible',reason:'lid_only_deferred'};
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const CHUNK=80;
// Only the intended absent migration (0048: no lid-only Film can exist) is an empty answer; a missing OTHER table (the redirects, the claims, the retirement ledger) is an unreadable store and fails closed.
export const MISSING_LID_ADMISSION=/no such table:\s*(?:main\.)?film_lid_admission\b/i;
const MAX_HOPS=8;

// The lid an id may stand for (a nomination only). `film:lb:<lid>` and `lb-<lid>` are the lid-only minting and fact-key spellings; a bare lid is a lid. Anything else is not a lid.
export function lidCandidate(id){
 if(typeof id!=='string')return null;
 let lid=id;
 if(lid.startsWith('film:lb:'))lid=lid.slice(8);
 else if(lid.startsWith('lb-'))lid=lid.slice(3);
 else if(lid.startsWith('tmdb_')||lid.startsWith('film:'))return null;
 return LID.test(lid)?lid:null;
}

// The Films a set of lids nominates: the trusted `letterboxd` claim holder and the proof row's Film. One statement, TWO bound parameters whatever the chunk (each is one JSON array read by `json_each`): Cloudflare D1 binds at
// most 100 parameters per statement (ADR 0078, `src/metadata-cache.js`), so a placeholder list per lid is never used.
const NOMINATE_SQL="SELECT e.value AS lid, e.film_id AS film FROM film_external_id e WHERE e.scheme='letterboxd' AND e.trusted=1 AND e.conflicting=0 AND e.value IN (SELECT value FROM json_each(?)) UNION SELECT a.lid AS lid, a.film_id AS film FROM film_lid_admission a WHERE a.lid IN (SELECT value FROM json_each(?))";

// THE cohort statement (also run by the aggregate for one Film). `?` = a JSON array of Film ids. -> one row per input Film id that is in the cohort (`origin`). Bounded: redirect chains stop at MAX_HOPS, the reverse walk
// uses `film_redirect_by_target` (0043). The retirement test is the aggregate's: a retired movie claim is historical evidence, not a current claim.
export const COHORT_SQL="WITH RECURSIVE chain(origin,cur,hops) AS (SELECT value,value,0 FROM json_each(?) UNION ALL SELECT c.origin,r.to_film_id,c.hops+1 FROM chain c JOIN film_redirect r ON r.from_id=c.cur WHERE c.hops<"+MAX_HOPS+"),"
 +'surv(origin,film) AS (SELECT origin,cur FROM chain WHERE NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=chain.cur)),'
 +'srcs(film,src,hops) AS (SELECT film,film,0 FROM surv UNION ALL SELECT s.film,r.from_id,s.hops+1 FROM srcs s JOIN film_redirect r ON r.to_film_id=s.src WHERE s.hops<'+MAX_HOPS+') '
 +'SELECT DISTINCT surv.origin AS origin FROM surv WHERE EXISTS (SELECT 1 FROM srcs WHERE srcs.film=surv.film AND EXISTS (SELECT 1 FROM film_lid_admission a WHERE a.film_id=srcs.src)) '
 +"AND NOT EXISTS (SELECT 1 FROM film_external_id e WHERE e.film_id=surv.film AND e.scheme='tmdb' AND e.trusted=1 AND e.conflicting=0 "
 +"AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision d WHERE d.movie_id=e.value AND d.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s2 WHERE s2.supersedes_seq=d.seq)))";

const missingTable=error=>MISSING_LID_ADMISSION.test(String(error?.message||error?.cause?.message||''));

// -> the Film ids (of the given list) that are in the cohort. `db` is a D1 binding or a counted binding. Throws `lid_only_exclusion_unreadable`; a missing `film_lid_admission` table is an empty answer.
export async function cohortFilms(db,filmIds){
 const ids=[...new Set((filmIds||[]).map(String))];
 const out=new Set();
 for(let at=0;at<ids.length;at+=CHUNK){
  const slice=ids.slice(at,at+CHUNK);
  let rows;
  try{rows=await many(db,COHORT_SQL,[JSON.stringify(slice)]);}
  catch(error){if(missingTable(error))return out;throw failed('lid_only_exclusion_unreadable',error);}
  for(const row of rows)out.add(String(row.origin));
 }
 return out;
}

// -> Set of the ids (as given) that are excluded under M1. Throws `lid_only_exclusion_unreadable` when the answer cannot be read; never turns an unreadable answer into absence.
export async function readLidOnlyDeferred(env,ids){
 const wanted=[...new Set((Array.isArray(ids)?ids:[]).map(String))];
 const excluded=new Set();
 const byFilm=new Map(),byLid=new Map();
 const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
 for(const id of wanted){
  if(id.startsWith('film:')&&!id.startsWith('film:lb:'))add(byFilm,id,id);
  const lid=lidCandidate(id);
  if(lid)add(byLid,lid,id);
 }
 if(!byFilm.size&&!byLid.size)return excluded;
 const db=database(env);
 // No D1 binding at all is the legacy R2-only world: `film_lid_admission` cannot exist there.
 if(!db)return excluded;
 // 1. Nominate the Films of the lids (a `film:lb:<lid>` id is a lid nomination and also itself a Film id).
 const nominated=new Map(byFilm);
 for(const id of wanted)if(id.startsWith('film:lb:'))add(nominated,id,id);
 const lids=[...byLid.keys()];
 for(let at=0;at<lids.length;at+=CHUNK){
  const slice=lids.slice(at,at+CHUNK);
  let rows;
  try{const list=JSON.stringify(slice);rows=await many(db,NOMINATE_SQL,[list,list]);}
  catch(error){if(missingTable(error))return excluded;throw failed('lid_only_exclusion_unreadable',error);}
  for(const row of rows)for(const id of byLid.get(String(row.lid))||[])add(nominated,String(row.film),id);
 }
 // 2. The cohort rule on the resolved Film of every nominated Film.
 const inCohort=await cohortFilms(db,[...nominated.keys()]);
 for(const [film,names] of nominated)if(inCohort.has(film))for(const id of names)excluded.add(id);
 return excluded;
}

// The separate `predictions.eligibility` field of the aggregate (decision 9): a verdict about eligibility only; it never touches a historical value, a conflict or the coverage. `inCohort` is the answer of the SAME
// cohort statement for the survivor Film. null = no statement (the ordinary gates decide).
export function predictionEligibility({inCohort}){
 return inCohort===true?{...LID_ONLY_DEFERRED}:null;
}
