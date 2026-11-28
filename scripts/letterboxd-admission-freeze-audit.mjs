// AIR-608 (A2), the original admission freeze gate of ADR 0207 decision 1 (the AIR-555 audit predicates P1-P5 and P7, P6 enrichment is deliberately NOT required). READ-ONLY.
// It reads `letterboxd/admissions/verified-films.json` (R2: ETag, byte size, every entry) and the D1 admission rows (`film_rated_admission`), and answers whether the two agree row by row. The object itself is never
// migrated: at the flip it is frozen as historical evidence. The pin printed here is NOT the pin of the moved import documents (`manifestSha256`): it is independent, so a late PUT to verified-films, a D1-only row or a
// changed row fails the gate whatever the coordination manifest says.
//   P1 kind    an entry's `identity` (`inferred`, `diary_page`, or absent for the rated archive)
//   P2 verifies  `verifiedAdmission(key, entry)` (src/film-admission.js) is ok
//   P3 agree   a D1 row with the same movie id, source code, archive digest, receipt film key, verification time and year; R2-only, D1-only and mismatch are NO-GO
//   P4 link    for `inferred` and `diary_page`: the facts link index maps `letterboxd:<code>` and `tmdb:<n>` to the same record
//   P5 mark    for `inferred`: that record carries `identity`, or an `inferredPairs` entry naming exactly this code and movie id
//   P7 health  the Film exists, is not redirected, and the movie id has exactly one `tmdb` row: the Film's own trusted, non-conflicting row
// Nothing here prints a code, film name, id or rating: only counts, reasons, the ETag, the size and digests.
import {createHash} from 'node:crypto';
import {RATED_RECEIPT_KEY,verifiedAdmission} from '../src/film-admission.js';

export const REGISTRY_KEY='letterboxd/imports/registry.json';
export const LINKS_KEY='letterboxd/facts/links.json';
const FACT_RECORD=key=>'letterboxd/facts/films/'+key+'.json';
const sha256=text=>createHash('sha256').update(text).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export class FreezeStop extends Error{constructor(reason,details={}){super(reason);this.reason=reason;this.details=details;}}

// ---- pure --------------------------------------------------------------------------------------------------------------
const row3=admission=>[admission.tmdb,admission.sourceCode,admission.archiveSha256,admission.receiptFilmKey,admission.verifiedAt,admission.year];
// -> {problems:[code], counts, r2Fingerprint, d1Fingerprint}. `receipts` is the parsed verified-films document; `rows` the D1 admission rows (snake_case columns plus `film_exists`, `redirected`, `tmdb_rows`, `own_trusted`);
// `links` the parsed link index (or null); `records` a Map of fact-record key -> parsed record (or absent).
export function compareFreeze({receipts,rows,links,records}){
 const problems=[];
 const counts={entries:0,verified:0,unverified:0,d1Rows:rows.length,agree:0,r2Only:0,d1Only:0,mismatch:0,inferred:0,diaryPage:0,rated:0,unlinked:0,unmarked:0,unhealthy:0,unknownIdentity:0};
 if(!plain(receipts)||receipts.schemaVersion!==1||!plain(receipts.films))return {problems:['receipts_malformed'],counts,r2Fingerprint:null,d1Fingerprint:null};
 const verified=new Map();
 for(const [key,item] of Object.entries(receipts.films)){
  counts.entries++;
  const checked=verifiedAdmission(key,item);
  if(!checked.ok){counts.unverified++;continue;}
  counts.verified++;
  // P1: an absent identity is the rated archive; `inferred` and `diary_page` are the two known kinds. ANY other present value is refused (never silently read as rated, which would skip P4/P5).
  const raw=plain(item)?item.identity:undefined;
  const known=raw===undefined||raw===null||raw==='inferred'||raw==='diary_page';
  if(!known){counts.unknownIdentity++;counts.verified--;counts.unverified++;continue;}
  verified.set(checked.admission.tmdb,{admission:checked.admission,identity:typeof raw==='string'?raw:null});
 }
 if(counts.unknownIdentity>0)problems.push('unknown_identity');
 if(counts.unverified-counts.unknownIdentity>0)problems.push('unverified_entries');
 const stored=new Map(rows.map(row=>[String(row.tmdb),row]));
 for(const [tmdb,{admission,identity}] of verified){
  if(identity==='inferred')counts.inferred++;else if(identity==='diary_page')counts.diaryPage++;else counts.rated++;
  const row=stored.get(tmdb);
  if(!row){counts.r2Only++;continue;}
  const same=row.source_code===admission.sourceCode&&row.archive_sha256===admission.archiveSha256&&row.receipt_film_key===admission.receiptFilmKey&&row.verified_at===admission.verifiedAt&&(row.year===null?null:Number(row.year))===admission.year&&row.receipt_key===RATED_RECEIPT_KEY;
  if(same)counts.agree++;else counts.mismatch++;
  // P7: the Film exists, is not redirected, and the movie id has exactly one tmdb row, the Film's own trusted non-conflicting one
  if(Number(row.film_exists)!==1||Number(row.redirected)!==0||Number(row.tmdb_rows)!==1||Number(row.own_trusted)!==1)counts.unhealthy++;
  // P4 and P5 apply to kinds whose source code is the Letterboxd id
  if(identity==='inferred'||identity==='diary_page'){
   const code=admission.sourceCode,factKey=links?links['letterboxd:'+code]:undefined;
   if(!links||typeof factKey!=='string'||!factKey||links['tmdb:'+tmdb]!==factKey)counts.unlinked++;
   else if(identity==='inferred'){
    const record=records.get(factKey);
    const marked=plain(record)&&(record.identity!=null||(Array.isArray(record.inferredPairs)&&record.inferredPairs.some(entry=>plain(entry)&&entry.letterboxd===code&&String(entry.tmdb)===tmdb)));
    if(!marked)counts.unmarked++;
   }
  }
 }
 for(const tmdb of stored.keys())if(!verified.has(tmdb))counts.d1Only++;
 if(counts.r2Only)problems.push('r2_only');
 if(counts.d1Only)problems.push('d1_only');
 if(counts.mismatch)problems.push('mismatch');
 if(counts.unlinked)problems.push('p4_unlinked');
 if(counts.unmarked)problems.push('p5_unmarked');
 if(counts.unhealthy)problems.push('p7_unhealthy');
 const r2Fingerprint=sha256(JSON.stringify([...verified.keys()].sort().map(tmdb=>row3(verified.get(tmdb).admission))));
 const d1Fingerprint=sha256(JSON.stringify([...stored.keys()].sort().map(tmdb=>{const r=stored.get(tmdb);return [r.tmdb,r.source_code,r.archive_sha256,r.receipt_film_key,r.verified_at,r.year===null?null:Number(r.year)];})));
 return {problems,counts,r2Fingerprint,d1Fingerprint};
}
// The independent pin: the object's ETag and size, both fingerprints, the D1 row count and newest `updated_at`, and a digest of everything the flip batch fences (the exact rows, the P7 health count and the versions of the link index and fact records).
export const freezePin=snapshot=>sha256(JSON.stringify({etag:snapshot.object.etag,bytes:snapshot.object.bytes,r2:snapshot.r2Fingerprint,d1:snapshot.d1Fingerprint,rows:snapshot.d1.rows,maxUpdatedAt:snapshot.d1.maxUpdatedAt,fence:sha256(JSON.stringify([snapshot.fence.rows,snapshot.fence.healthy,snapshot.fence.documents]))}));

// ---- readers (read only) ---------------------------------------------------------------------------------------------
async function strictAll(binding,sql,params=[]){
 const result=await binding.prepare(sql).bind(...params).all();
 if(!result||!Array.isArray(result.results))throw new FreezeStop('read_malformed');
 return result.results;
}
const ADMISSION_SQL="SELECT a.film_id,a.tmdb,a.source_code,a.archive_sha256,a.year,a.receipt_key,a.receipt_film_key,a.verified_at,a.updated_at,"
 +"(SELECT COUNT(*) FROM film f WHERE f.id=a.film_id) AS film_exists,"
 +"(SELECT COUNT(*) FROM film_redirect r WHERE r.from_id=a.film_id) AS redirected,"
 +"(SELECT COUNT(*) FROM film_external_id e WHERE e.scheme='tmdb' AND e.value=a.tmdb) AS tmdb_rows,"
 +"(SELECT COUNT(*) FROM film_external_id e WHERE e.scheme='tmdb' AND e.value=a.tmdb AND e.film_id=a.film_id AND e.trusted=1 AND e.conflicting=0) AS own_trusted FROM film_rated_admission a ORDER BY a.tmdb";

// One Ratings document by key, parts in order, the stored etag checked against the digest of the text (a damaged document is a STOP, never an absence). -> {value,etag}|null when the key has no part.
export async function readRatingsDocument(binding,key){return (await readRatingsDocuments(binding,[key])).get(key)??null;}
const IN_SLICE=40; // D1 allows 100 bound variables a statement
function assemble(key,parts){
 const etag=parts[0].etag;
 if(parts.some((row,index)=>Number(row.part)!==index||row.etag!==etag))throw new FreezeStop('document_unreadable',{kind:'parts'});
 const text=parts.map(row=>row.body).join('');
 if(sha256(text)!==etag)throw new FreezeStop('document_unreadable',{kind:'digest'});
 let value;try{value=JSON.parse(text);}catch{throw new FreezeStop('document_unreadable',{kind:'json'});}
 return {value,etag};
}
// BATCHED: a slice of keys a statement (no per-record round trip). -> Map key -> {value,etag}; a key with no part is absent from the map.
export async function readRatingsDocuments(binding,keys){
 const out=new Map(),unique=[...new Set(keys)];
 for(let index=0;index<unique.length;index+=IN_SLICE){
  const slice=unique.slice(index,index+IN_SLICE);
  const found=await strictAll(binding,'SELECT key, part, body, etag FROM ratings_document WHERE key IN ('+slice.map(()=>'?').join(',')+') ORDER BY key, part',slice);
  const grouped=new Map();
  for(const row of found){if(!slice.includes(row.key))throw new FreezeStop('read_malformed');(grouped.get(row.key)||grouped.set(row.key,[]).get(row.key)).push(row);}
  for(const [key,parts] of grouped)out.set(key,assemble(key,parts));
 }
 return out;
}
// The exact text of one admission row, as the flip batch asserts it. Fields cannot contain `|` (source codes are `[A-Za-z0-9_-]`, the others are digests, ISO instants and keys).
export const rowText=row=>[row.film_id,row.tmdb,row.source_code,row.archive_sha256,row.receipt_film_key,row.verified_at,row.year===null||row.year===undefined?'':String(row.year),row.receipt_key].join('|');
export const ROW_SQL="film_id||'|'||tmdb||'|'||source_code||'|'||archive_sha256||'|'||receipt_film_key||'|'||verified_at||'|'||COALESCE(CAST(year AS TEXT),'')||'|'||receipt_key";
// The P7 predicate in SQL, over `film_rated_admission a`: the Film exists, is not redirected, and the movie id has exactly one tmdb row, the Film's own trusted non-conflicting one.
export const HEALTHY_SQL="EXISTS (SELECT 1 FROM film f WHERE f.id=a.film_id) AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=a.film_id) AND (SELECT COUNT(*) FROM film_external_id e WHERE e.scheme='tmdb' AND e.value=a.tmdb)=1 AND EXISTS (SELECT 1 FROM film_external_id e WHERE e.scheme='tmdb' AND e.value=a.tmdb AND e.film_id=a.film_id AND e.trusted=1 AND e.conflicting=0)";

// -> {object:{etag,bytes}, registry:{etag|null}, d1:{rows,maxUpdatedAt}, fence:{rows:[text],healthy,documents:[{key,etag|null}]}, r2Fingerprint, d1Fingerprint, counts, problems, pin}. `store` has head(key) and get(key) -> {etag,text()}; a `size` on head/get (the S3 content length) is checked against the bytes read.
// The reads run in this order: initial HEAD, GET, D1 rows, the link index, the fact records (batched), and the FINAL HEAD of the admissions object and the registry LAST, so a late change during the audit is seen.
export async function readFreeze({binding,store}){
 const first=await store.head(RATED_RECEIPT_KEY);
 if(!first)throw new FreezeStop('admissions_object_missing');
 const body=await store.get(RATED_RECEIPT_KEY);
 if(!body)throw new FreezeStop('admissions_object_missing');
 const text=await body.text();
 const bytes=new TextEncoder().encode(text).length;
 for(const supplied of [first.size,body.size])if(supplied!==undefined&&supplied!==null&&Number.isFinite(Number(supplied))&&Number(supplied)!==bytes)throw new FreezeStop('admissions_object_size_mismatch',{bytes});
 if(first.etag!==body.etag)throw new FreezeStop('admissions_object_moved');
 let receipts;try{receipts=JSON.parse(text);}catch{throw new FreezeStop('admissions_object_unreadable');}
 const rows=await strictAll(binding,ADMISSION_SQL);
 const stats=(await strictAll(binding,'SELECT COUNT(*) AS n, MAX(updated_at) AS newest FROM film_rated_admission'))[0];
 if(!stats||Number(stats.n)!==rows.length)throw new FreezeStop('admission_rows_moved');
 const linksDoc=await readRatingsDocument(binding,LINKS_KEY);
 const links=linksDoc&&plain(linksDoc.value)?linksDoc.value:null;
 const needed=new Set();
 if(plain(receipts)&&plain(receipts.films)&&links){
  for(const [key,item] of Object.entries(receipts.films)){
   const checked=verifiedAdmission(key,item);
   if(checked.ok&&plain(item)&&item.identity==='inferred'){const factKey=links['letterboxd:'+checked.admission.sourceCode];if(typeof factKey==='string'&&factKey&&links['tmdb:'+checked.admission.tmdb]===factKey)needed.add(factKey);}
  }
 }
 const recordDocs=await readRatingsDocuments(binding,[...needed].map(FACT_RECORD));
 const records=new Map();
 for(const factKey of needed){const doc=recordDocs.get(FACT_RECORD(factKey));if(doc&&plain(doc.value))records.set(factKey,doc.value);}
 const audit=compareFreeze({receipts,rows,links,records});
 const healthy=Number((await strictAll(binding,'SELECT COUNT(*) AS n FROM film_rated_admission a WHERE '+HEALTHY_SQL))[0]?.n);
 // the FINAL re-pin of the object and the registry, after every other read
 const last=await store.head(RATED_RECEIPT_KEY);
 if(!last||last.etag!==body.etag)throw new FreezeStop('admissions_object_moved');
 if(last.size!==undefined&&last.size!==null&&Number.isFinite(Number(last.size))&&Number(last.size)!==bytes)throw new FreezeStop('admissions_object_size_mismatch',{bytes});
 const registry=await store.head(REGISTRY_KEY);
 const documents=[{key:LINKS_KEY,etag:linksDoc?linksDoc.etag:null},...[...needed].map(factKey=>({key:FACT_RECORD(factKey),etag:recordDocs.get(FACT_RECORD(factKey))?.etag??null}))];
 const snapshot={object:{etag:body.etag,bytes},registry:{etag:registry?registry.etag:null},d1:{rows:rows.length,maxUpdatedAt:stats.newest??null},fence:{rows:rows.map(rowText),healthy,documents},...audit};
 return {...snapshot,pin:freezePin(snapshot)};
}
