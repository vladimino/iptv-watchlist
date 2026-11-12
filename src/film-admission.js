// AIR-369 / ADR 0099 (Accepted), decomposition C3a; ADR 0086 and 0087. D1-owned canonical Film admission for VERIFIED rated-archive Films
// and the watchlist retention fact that keeps a Film after it leaves the current lists. Inactive: nothing in the Worker imports this module
// (it is not bundled; no route, job or cron calls it), schema 15 is a file only, and while the marker is r2 or prepared the enrichment
// projector stays the only canonical writer, so the two writers refuse before they reach the database. The R2 object
// letterboxd/admissions/verified-films.json stays the immutable evidence and receipt (never a second mutable owner after a cutover) and the
// enrichment/view-index.json `watchlist` boolean stops being the thing that decides which Films exist. The pre-Film rated-candidate queue is
// not here (AIR-343): only an entry that carries every verification fact becomes a Film.
// - verifiedAdmission validates one receipt entry; nothing else is ever admitted (no title/year match, no short code as an id, no watchlist field).
// - admitRatedFilm / retainFilm are the fenced writers (marker generation + entity revision of schema 13, replay-safe, monotonic).
// - compareAdmissions is the compare-only report of R2 inputs against D1 rows; readRatedAdmissions / readRetention need the marker open.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {archiveAdmissionsFromDocument,watchlistAdmissionsFromIndex} from './enrichment-projection.js';

export const RATED_RECEIPT_KEY='letterboxd/admissions/verified-films.json';
export {ADMISSION_READ_CHUNK} from './canonical-catalog-reader.js';
export const COMPARE_LIST_CAP=200;
const KEY=/^tmdb_([1-9]\d{0,11})$/;
const HEX64=/^[0-9a-f]{64}$/;
const SHORT=/^[A-Za-z0-9_-]{1,40}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const stable=value=>JSON.stringify(value===undefined?null:value);
const reject=(reason)=>({ok:false,reason});

// Pure. One entry of verified-films.json: ok with the normalized admission, or the reason it is not a verified Film. A candidate
// (a short code, a pending, needs_review or admitting queue entry, an entry with a watchlist field or without a verification time,
// digest or short code) is refused and so never becomes a Film.
export function verifiedAdmission(key,item){
 const match=KEY.exec(String(key??''));
 if(!match)return reject('invalid_key');
 if(!plain(item))return reject('not_verified');
 if(Object.prototype.hasOwnProperty.call(item,'watchlist'))return reject('watchlist_field');
 if(String(item.tmdb)!==match[1])return reject('tmdb_mismatch');
 if(typeof item.sourceCode!=='string'||!SHORT.test(item.sourceCode))return reject('not_verified');
 if(typeof item.archiveSha256!=='string'||!HEX64.test(item.archiveSha256))return reject('not_verified');
 const verifiedAt=instant(item.verifiedAt);
 if(!verifiedAt)return reject('not_verified');
 const year=Number.isInteger(item.year)?item.year:null;
 return {ok:true,admission:{receiptFilmKey:key,tmdb:match[1],sourceCode:item.sourceCode,archiveSha256:item.archiveSha256,title:typeof item.title==='string'&&item.title.trim()?item.title.trim():null,year,verifiedAt}};
}

// The Film an admission belongs to, and whether the typed movie id is held. ALL rows for the typed id (`tmdb`; `tmdb_tv` is another scheme and
// never matches) are read: the Film that holds it as a trusted, non-conflicting external id is the owner and the target (so a Letterboxd Film
// that already carries the movie id stays one Film), else the target is the new id film:tmdb:<n>. Any row for the id that is not that owner's
// own trusted row (an untrusted or conflicting claim on this or another Film, even beside a trusted owner) leaves the id `held`: it is
// ambiguous identity evidence, and a verified receipt proves the incoming observation but does not erase an earlier explicit classification.
export async function resolveAdmissionFilm(env,tmdb){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const claims=await many(db,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[String(tmdb)]);
 const owner=claims.find(row=>row.trusted===1&&row.conflicting===0)?.film_id??null;
 const held=claims.some(row=>!(row.trusted===1&&row.conflicting===0&&row.film_id===owner))?'untrusted_or_conflicting_claim':null;
 const id=owner||'film:tmdb:'+tmdb;
 const [film,revision,redirect]=await Promise.all([one(db,'SELECT id FROM film WHERE id=?',[id]),one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',['film',id]),one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id])]);
 return {id,exists:!!film,revision:Number(revision?.revision??0),redirected:!!redirect,owner,held,claims:claims.length};
}

const unavailable=error=>error?.code==='film_person_unavailable'&&/no such table/i.test(String(error.cause?.message||''));

// The fenced admission of ONE verified rated-only Film (a later card calls it; nothing does today). One atomic batch proves the marker
// generation (`open` only), the revision of the resolved Film and that the typed movie id is still unclaimed or held only by that Film's own trusted row, upserts the Film row and its
// trusted `tmdb` external id (inserted only when no row exists: a trusted row keeps its provenance, an untrusted or conflicting one is never upgraded), keeps the verified short code as a historical alias and the
// verified admission row, and bumps the revision. A replay (same content) opens no batch; a different movie id or short code for an admitted
// Film, or a short code already verified for another Film, is refused, and so is a movie id with an untrusted or conflicting claim (`admission_identity_held`; nothing is written until a separate, explicit resolution). Owner and reviewed values, credits, metadata, localization,
// watchlist membership and the rating are never touched: the rating link stays the ratings domain's, keyed by the same tmdb_<n>.
// input: {receiptKey:'tmdb_<n>', receipt:{...entry}, filmId?, expectedRevision, at, requestId}
export async function admitRatedFilm(env,input){
 const checked=verifiedAdmission(input?.receiptKey,input?.receipt);
 if(!checked.ok){const error=failed('admission_not_verified');error.reason=checked.reason;throw error;}
 const admission=checked.admission;
 const expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 let target,prior,holder;
 try{
  target=await resolveAdmissionFilm(env,admission.tmdb);
  prior=await one(db,'SELECT tmdb,source_code,archive_sha256,receipt_key FROM film_rated_admission WHERE film_id=?',[target.id]);
  holder=await one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[admission.sourceCode]);
 }catch(error){if(unavailable(error)||/no such table/i.test(String(error?.message||'')))throw failed('admission_unavailable',error);throw error;}
 if(input.filmId!==undefined&&input.filmId!==target.id)throw failed('admission_target_changed');
 if(target.redirected)throw failed('film_person_redirect');
 if(target.held){const error=failed('admission_identity_held');error.reason=target.held;throw error;}
 if(holder&&holder.film_id!==target.id)throw failed('admission_conflict');
 if(prior){
  if(prior.tmdb!==admission.tmdb||prior.source_code!==admission.sourceCode)throw failed('admission_conflict');
  if(prior.archive_sha256===admission.archiveSha256&&prior.receipt_key===RATED_RECEIPT_KEY)return {id:target.id,revision:target.revision,admitted:false,replay:true};
 }
 const id=target.id;
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id]]);
 // The identity rows are re-asserted INSIDE the batch (they can change after the read): no row for the typed id may exist except the owner's own
 // trusted one, and exactly that one must exist when an owner was found. An untrusted or conflicting claim that appears, or a row that changes, fails the batch.
 statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=? AND NOT (film_id IS ? AND trusted=1 AND conflicting=0))"),[admission.tmdb,target.owner]]);
 statements.push([fenced.assertSql("(SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=?"),[admission.tmdb,target.owner?1:0]]);
 statements.push(["INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_identity=COALESCE(film.canonical_identity,excluded.canonical_identity),original_title=COALESCE(film.original_title,excluded.original_title),updated_at=excluded.updated_at",[id,'tmdb:'+admission.tmdb,admission.title,at]]);
 statements.push(["INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,'tmdb',?,1,0,?) ON CONFLICT(film_id,scheme,value) DO NOTHING",[id,admission.tmdb,stable({source:'letterboxd_rated_admission',receiptKey:RATED_RECEIPT_KEY,archiveSha256:admission.archiveSha256})]]);
 statements.push(["INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES (?,'letterboxd_short_code',?,?) ON CONFLICT(film_id,kind,value) DO NOTHING",[id,admission.sourceCode,stable({source:'letterboxd_rated_admission',archiveSha256:admission.archiveSha256})]]);
 statements.push(["INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET archive_sha256=excluded.archive_sha256,title=COALESCE(excluded.title,film_rated_admission.title),year=COALESCE(excluded.year,film_rated_admission.year),request_id=excluded.request_id,updated_at=excluded.updated_at WHERE film_rated_admission.tmdb=excluded.tmdb AND film_rated_admission.source_code=excluded.source_code",[id,admission.tmdb,admission.sourceCode,admission.archiveSha256,admission.title,admission.year,RATED_RECEIPT_KEY,admission.receiptFilmKey,admission.verifiedAt,requestId,at]]);
 statements.push([fenced.BUMP,['film',id,at]]);
 try{await fenced.commit(env,gate,statements,entities,tail);}
 catch(error){
  const message=String(error?.cause?.message||'');
  if(error?.code==='film_person_unavailable'&&/UNIQUE constraint failed: film_rated_admission/i.test(message))throw failed('admission_conflict',error);
  throw error;
 }
 return {id,revision:expected+1,admitted:true,replay:false};
}

// The fenced write of the watchlist retention fact for ONE existing Film (ADR 0086: a Film stays after it leaves the lists). It never creates
// a Film and never reads or writes membership (watchlist_film). The row is a monotonic fact: a newer observation replaces the older one, an
// older or equal one is skipped, a replay with the same request id and content opens no batch.
// input: {id, expectedRevision, at, requestId, watchlist:boolean, observedAt, evidence?:object}
export async function retainFilm(env,input){
 const id=fenced.filmId(input?.id);
 const expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 const observed=instant(input.observedAt);
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 if(typeof input.watchlist!=='boolean'||!observed||(input.evidence!==undefined&&!plain(input.evidence)))throw failed('retention_invalid');
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 let film,redirect,row;
 try{
  [film,redirect,row]=await Promise.all([one(db,'SELECT id FROM film WHERE id=?',[id]),one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]),one(db,'SELECT watchlist,evidence_json,request_id,observed_at FROM film_retention WHERE film_id=?',[id])]);
 }catch(error){if(/no such table/i.test(String(error?.cause?.message||error?.message||'')))throw failed('retention_unavailable',error);throw error;}
 if(!film)throw failed('retention_unknown_film');
 if(redirect)throw failed('film_person_redirect');
 const evidence=stable(input.evidence??{});
 if(row&&row.request_id===requestId){
  if(row.watchlist!==(input.watchlist?1:0)||stable(JSON.parse(row.evidence_json))!==evidence||row.observed_at!==observed)throw failed('retention_replay_mismatch');
  return {id,revision:expected,retained:true,written:false,reason:'replay'};
 }
 if(row&&!(observed>row.observed_at))return {id,revision:expected,retained:true,written:false,reason:'stale'};
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push(["INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES (?,'watchlist_fact',?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET watchlist=excluded.watchlist,evidence_json=excluded.evidence_json,request_id=excluded.request_id,observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>film_retention.observed_at",[id,input.watchlist?1:0,evidence,requestId,observed,at]]);
 statements.push([fenced.BUMP,['film',id,at]]);
 await fenced.commit(env,gate,statements,entities,tail);
 return {id,revision:expected+1,retained:true,written:true};
}

// The two D1 readers (loadAdmissionRows, readAdmissions) live in canonical-catalog-reader.js, the one import-free read module the Worker bundles (AIR-374 P4);
// they are re-exported here so every existing caller and test keeps this path.
export {loadAdmissionRows,readAdmissions} from './canonical-catalog-reader.js';

// Compare-only (inactive): the R2 inputs (verified-films.json body, view-index body) against D1 rows keyed by the same movie id / lid. Nothing is
// written. `receipts` entries that are not verified are listed as `unverified` and are never expected in D1. Each list is capped.
// rows: {admissions:[{filmId,tmdb,sourceCode,archiveSha256}], retained:[{filmId,letterboxdIds:[...]}]}
export function compareAdmissions({receipts=null,viewIndex=null,rows={admissions:[],retained:[]}}={}){
 const capped=list=>list.length>COMPARE_LIST_CAP?list.slice(0,COMPARE_LIST_CAP):list;
 const verified=new Map(),unverified=[];
 if(plain(receipts)&&plain(receipts.films)){
  for(const [key,item] of Object.entries(receipts.films)){
   const checked=verifiedAdmission(key,item);
   if(checked.ok)verified.set(checked.admission.tmdb,checked.admission);else unverified.push({key,reason:checked.reason});
  }
 }
 const projected=archiveAdmissionsFromDocument(receipts);
 const stored=new Map((rows.admissions||[]).map(row=>[String(row.tmdb),row]));
 const missing=[],mismatch=[],extra=[];
 for(const [tmdb,admission] of verified){
  const row=stored.get(tmdb);
  if(!row)missing.push(tmdb);
  else if(row.sourceCode!==admission.sourceCode||row.archiveSha256!==admission.archiveSha256)mismatch.push(tmdb);
 }
 for(const tmdb of stored.keys())if(!verified.has(tmdb))extra.push(tmdb);
 const flags=watchlistAdmissionsFromIndex(viewIndex);
 const lids=new Set(Object.keys(flags));
 const retainedLids=new Set((rows.retained||[]).flatMap(row=>row.letterboxdIds||[]));
 const retentionMissing=[...lids].filter(lid=>!retainedLids.has(lid)),retentionExtra=[...retainedLids].filter(lid=>!lids.has(lid));
 return {
  admissions:{expected:verified.size,stored:stored.size,missing:capped(missing),mismatch:capped(mismatch),extra:capped(extra),unverified:capped(unverified),projectedByR2:Object.keys(projected).length},
  retention:{expected:lids.size,stored:retainedLids.size,missing:capped(retentionMissing),extra:capped(retentionExtra)},
  agree:!missing.length&&!mismatch.length&&!extra.length&&!retentionMissing.length&&!retentionExtra.length,
 };
}
