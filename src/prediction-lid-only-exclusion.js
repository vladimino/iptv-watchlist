// AIR-673 / ADR 0217 (Accepted) decision 9, choice M1, delivery step 4, DORMANT. The temporary prediction exclusion of a lid-only Film: a Film with NO trusted `tmdb` claim and a
// `film_lid_admission` row is not admitted to the prediction queue. ONE predicate serves the three enforcement points (queue rebuild admission, manifest build, per-film `submit` guard), so a
// stale queue cannot submit such a Film. No model is invoked for it, and nothing here scores, calls a model or changes a prompt.
//
// Cohort boundary: the exclusion applies only while the Film has no trusted `tmdb` claim. After a successful attach it ENDS and the ordinary ADR 0154 gates apply. The decision reads the CLAIM rows,
// never the spelling of an id: `film:lb:<lid>` is a minting id (I1), and a Film minted `film:lb:<lid>` that later holds a trusted movie claim is not excluded.
//
// Read only. While migration 0048 is not applied the table does not exist, so no lid-only Film can exist and nothing is excluded (the dormant, byte-identical legacy path). Any OTHER read failure
// is thrown: an unreadable answer is never "not excluded" (fail closed for the queue, the manifest and `submit`).
import {database,failed,many} from './film-person-authority.js';

export const LID_ONLY_DEFERRED={status:'not_eligible',reason:'lid_only_deferred'};
const LID=/^[A-Za-z0-9_-]{1,80}$/;
const CHUNK=80;
const MISSING_TABLE=/no such table/i;

// The lid a prediction id may stand for: a bare lid, the stored fact key `lb-<lid>`, or the minting id `film:lb:<lid>`. A `tmdb_<n>` id, a catalog key of another shape or anything that is not a lid is not
// a lid-only candidate (null). The spelling only NOMINATES a lid to look up; whether the Film is lid-only is decided by the durable rows below.
export function lidCandidate(id){
 if(typeof id!=='string')return null;
 let lid=id;
 if(lid.startsWith('film:lb:'))lid=lid.slice(8);
 else if(lid.startsWith('lb-'))lid=lid.slice(3);
 else if(lid.startsWith('tmdb_')||lid.startsWith('film:'))return null;
 return LID.test(lid)?lid:null;
}

// A lid-only Film with no trusted `tmdb` claim, per lid, resolved through the merge redirect. One statement per chunk of 80 lids.
const SQL=(n)=>'SELECT a.lid AS lid FROM film_lid_admission a WHERE a.lid IN ('+Array(n).fill('?').join(',')+') AND NOT EXISTS ('
 +"SELECT 1 FROM film_external_id e WHERE e.scheme='tmdb' AND e.trusted=1 AND e.conflicting=0 AND e.film_id=COALESCE((SELECT r.to_film_id FROM film_redirect r WHERE r.from_id=a.film_id),a.film_id))";

// -> Set of the ids (as given) that are excluded under M1. Throws `lid_only_exclusion_unreadable` when the answer cannot be read; never turns an unreadable answer into absence.
export async function readLidOnlyDeferred(env,ids){
 const wanted=[...new Set((Array.isArray(ids)?ids:[]).map(String))];
 const byLid=new Map();
 for(const id of wanted){const lid=lidCandidate(id);if(lid){if(!byLid.has(lid))byLid.set(lid,[]);byLid.get(lid).push(id);}}
 const excluded=new Set();
 if(!byLid.size)return excluded;
 const db=database(env);
 // No D1 binding at all is the legacy R2-only world: `film_lid_admission` cannot exist there.
 if(!db)return excluded;
 const lids=[...byLid.keys()];
 for(let at=0;at<lids.length;at+=CHUNK){
  const slice=lids.slice(at,at+CHUNK);
  let rows;
  try{rows=await many(db,SQL(slice.length),slice);}
  catch(error){
   // The table is applied by its own owner-approved step: while it is absent no lid-only Film exists.
   if(MISSING_TABLE.test(String(error?.message||error?.cause?.message||'')))return excluded;
   throw failed('lid_only_exclusion_unreadable',error);
  }
  for(const row of rows)for(const id of byLid.get(String(row.lid))||[])excluded.add(id);
 }
 return excluded;
}

// The separate `predictions.eligibility` field of the aggregate (decision 9). It never touches a historical value, a conflict or the coverage: it is only the verdict "not eligible now".
// `claims` is the resolver's claim list ({scheme,value,trusted,conflicting}); `lidAdmitted` is whether `film_lid_admission` names one of the survivor's lids. null = no statement (the ordinary gates decide).
export function predictionEligibility({claims,lidAdmitted}){
 if(lidAdmitted!==true||!Array.isArray(claims))return null;
 const trustedTmdb=claims.some(c=>c&&c.scheme==='tmdb'&&c.trusted===true&&c.conflicting!==true&&c.retired!==true);
 return trustedTmdb?null:{...LID_ONLY_DEFERRED};
}
