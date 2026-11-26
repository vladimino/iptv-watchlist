// ADR 0222 (owner option B on PR #1018). The mutable Letterboxd import coordination documents (rated candidates, inferred chunk intent / receipt, archive-apply candidates result) are D1 Ratings documents
// ONLY while marker `letterboxd_admission_authority` is `d1`. This module is the one seam: both owners (`letterboxd-rated-candidates.js`, `letterboxd-facts.js`) ask it first and keep their own R2 path
// unchanged otherwise. At `r2` or with the migration absent it routes nothing (the R2 path runs exactly as before). At `closed` or with an unreadable marker it refuses (nothing may be written under `closed`).
// At `d1` there is no R2 read, no R2 write and no fallback: a document absent from D1 is ABSENT only once the import manifest exists; a missing manifest fails closed (an absent or partial import never reads as empty).
// A write is one Ratings batch: the document's etag compare-and-swap, the `d1` marker assertion at the generation read, the manifest assertion, and the caller's own `extra` statements (a terminal write passes the
// operation-history assertion here, so the disposition and the history assertion commit together or not at all). This module does not import. The Worker bundle wraps it.

export const MANIFEST_KEY='letterboxd/imports/documents-manifest.json';
export const MANIFEST_SCHEMA=1;

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
const ratingsAssert=sql=>'UPDATE ratings_domain_cas SET ok=CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE id=1';
const MANIFEST_PRESENT="EXISTS (SELECT 1 FROM ratings_document WHERE key=? AND part=0)";

// Is this one of the moved document keys (the manifest included)? Pure.
export function isAdmissionDocumentKey(key){return RatingsD1.admissionDocumentKey(key);}

// The route of one operation on a moved document: {d1:false} runs the caller's R2 path; {d1:true,authority} runs through D1. Throws `letterboxd_admission_closed` or `letterboxd_admission_unavailable`.
export async function documentRoute(env,key){
 if(!RatingsD1.admissionDocumentKey(key))return {d1:false};
 const {route,authority}=await LetterboxdAdmissionAuthority.admissionRouteNow(env);
 if(route==='closed')throw LetterboxdAdmissionAuthority.admissionClosedError(authority.mode);
 if(route!=='d1')return {d1:false};
 return {d1:true,authority};
}

// The route of a READ of a moved document: like `documentRoute`, except that under `closed` the R2 objects are quiescent and still the record, so a read stays on R2 (only a WRITE refuses under `closed`).
// An unreadable marker still throws, never the legacy path.
export async function readRoute(env,key){
 if(!RatingsD1.admissionDocumentKey(key))return {d1:false};
 try{return await documentRoute(env,key);}
 catch(error){if(error&&error.code==='letterboxd_admission_closed')return {d1:false};throw error;}
}

async function sha256Hex(text){
 const bytes=new TextEncoder().encode(text);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// The complete-import manifest, validated for consistency: a known schema, `complete`, a key list that is unique, made only of moved document keys (never the manifest itself), whose count and digest agree with the
// manifest's own fields. Returns the set of keys the import listed: such a key must exist in D1 (a missing one is a damaged import, never new).
async function requireManifest(env){
 const manifest=await RatingsD1.readOwned(env,MANIFEST_KEY,{admission:true});
 if(!manifest.owned)throw failed('admission_documents_unavailable');
 const value=manifest.value;
 if(!value||value.schemaVersion!==MANIFEST_SCHEMA||value.complete!==true)throw failed('admission_documents_not_imported');
 const keys=Array.isArray(value.keys)?value.keys:null;
 if(keys===null||!Number.isInteger(value.count)||value.count!==keys.length)throw failed('admission_documents_inconsistent');
 const listed=new Set();
 for(const entry of keys){
  if(!entry||typeof entry.key!=='string'||entry.key===MANIFEST_KEY||!RatingsD1.admissionDocumentKey(entry.key)||listed.has(entry.key))throw failed('admission_documents_inconsistent');
  listed.add(entry.key);
 }
 if(typeof value.inventorySha256!=='string'||await sha256Hex(JSON.stringify(keys))!==value.inventorySha256)throw failed('admission_documents_inconsistent');
 return {manifest,listed};
}

// -> {value,etag}; `value` is null for a document that is absent after a complete import. Never reads R2.
export async function readDocument(env,key){
 const {listed}=await requireManifest(env);
 const owned=await RatingsD1.readOwned(env,key,{admission:true});
 if(!owned.owned)throw failed('admission_documents_unavailable');
 // A key the import listed that is missing now is a damaged import, never an ordinary absence (and never recreated as new).
 if((owned.value===null||owned.value===undefined)&&listed.has(key))throw failed('admission_document_missing');
 return {value:owned.value??null,etag:owned.etag??null};
}

// -> {value,changed} when committed or unchanged, or {refused:true} when a caller assertion (`extra`: the history guard of a terminal disposition) or the marker did not hold while the document itself was unchanged:
// nothing was written and the caller replans from reconciled state (ADR 0207 decision 3). A competing write of the same document (a moved etag) is retried against the new revision, bounded.
// `apply(draft)` returns the next document or null for no change. `extra` are caller [sql,params] statements committed in the same batch.
export async function casDocument(env,key,empty,apply,{extra=[],authority}={}){
 const {listed}=await requireManifest(env);
 for(let attempt=0;attempt<5;attempt++){
  const fresh=authority||(await LetterboxdAdmissionAuthority.admissionRouteNow(env)).authority;
  const condition=LetterboxdAdmissionAuthority.d1BatchCondition(fresh);
  const guards=[LetterboxdAdmissionAuthority.authorityAssertion(ratingsAssert,condition),[ratingsAssert(MANIFEST_PRESENT),[MANIFEST_KEY]]];
  const current=await RatingsD1.readOwned(env,key,{admission:true});
  if(!current.owned)throw failed('admission_documents_unavailable');
  if((current.value===null||current.value===undefined)&&listed.has(key))throw failed('admission_document_missing');
  const base=current.value??JSON.parse(JSON.stringify(empty??null));
  const next=await apply(base==null?base:JSON.parse(JSON.stringify(base)),current.etag??null);
  if(next==null)return {value:base,changed:false};
  const saved=await RatingsD1.putOwned(env,key,current.etag??null,next,{extra:[...guards,...extra],admission:true});
  if(!saved.owned)throw failed('admission_documents_unavailable');
  if(saved.saved)return {value:next,changed:true};
  if(saved.committed)throw failed('write_contention');
  const after=await RatingsD1.readOwned(env,key,{admission:true});
  if((after.etag??null)===(current.etag??null))return {refused:true};
 }
 throw failed('write_contention');
}

// The archives with a candidate document at marker `d1`, bounded (the identity-work inventory lists archives from D1; there is no R2 listing and no registry projection after the cutover).
export async function listCandidateArchives(env,limit){
 await requireManifest(env);
 return RatingsD1.listAdmissionArchives(env,limit);
}
